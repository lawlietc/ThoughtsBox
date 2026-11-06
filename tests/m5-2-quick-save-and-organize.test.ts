import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { ApiError } from "../src/web/apiClient.ts";
import { quickSecondActionFor, runQuickSave, type QuickSaveDeps } from "../src/web/quickSave.ts";
import { processingModeChoices } from "../src/web/projectionPort.ts";

/**
 * M5-2 →「整理方式改动」：QuickPanel 第二动作 = 「保存并整理」= 排进后台队列。
 *
 * 时序与文案的钉法分两面：
 * - **动态面**：`runQuickSave` 是与 React 无关的驱动函数，测试注入记账假件，
 *   能真正执行「createRecord 成功 → onCreated（清空输入）→ onSaved → enqueueJob → onQueued」
 *   这条链，并证伪「创建失败还去入队」「入队失败却仍然离开这一页」「快速页擅自 parse/preview/confirm-send」。
 * - **静态面**：按钮渲染条件与颜色、忙碌文案、`setText("")` 绑在 onCreated 而非 outcome 之后、
 *   App 的 `notify` + 来路页接线，沿用本仓 UI 测试既有的源码断言（vitest 是 node 环境，没有 DOM）。
 */

const WEB = join(process.cwd(), "src", "web");

function source(name: string): string {
  return readFileSync(join(WEB, name), "utf8");
}

/* ── 记账假件 ───────────────────────────────────────────────────── */

interface Harness {
  readonly calls: string[];
  readonly deps: QuickSaveDeps;
}

function harness(options: {
  create?: (text: string, mode: string) => Promise<{ record: { id: string } }>;
  enqueue?: (recordId: string) => Promise<unknown>;
} = {}): Harness {
  const calls: string[] = [];
  const deps: QuickSaveDeps = {
    createRecord: options.create ?? (async (text, mode) => {
      calls.push(`createRecord:${mode}`);
      return { record: { id: `rec_new_${calls.length}` } };
    }),
    enqueueJob: options.enqueue ?? (async (recordId) => {
      calls.push(`enqueueJob:${recordId}`);
      return { id: "job_test_1" };
    }),
    onCreated: (recordId) => {
      calls.push(`onCreated:${recordId}`);
    },
    onSaved: () => {
      calls.push("onSaved");
    },
    onQueued: (recordId) => {
      calls.push(`onQueued:${recordId}`);
    },
  };
  return { calls, deps };
}

/* ── A. 四档的第二动作（纯函数） ────────────────────────────────── */

describe("整理方式 · 四档的第二动作", () => {
  it("manual_only 没有第二按钮；另三档同一颗「保存并整理」，kind 一律是入队", () => {
    expect(quickSecondActionFor("manual_only")).toBeNull();
    for (const mode of ["local_model", "cloud_redacted", "cloud_raw"]) {
      expect(quickSecondActionFor(mode)?.label, mode).toBe("保存并整理");
      expect(quickSecondActionFor(mode)?.kind, mode).toBe("enqueue");
    }
    // 从前云端两档那句「保存，去确认发送」不再存在：那一档现在也只负责排进队列。
    expect(quickSecondActionFor("cloud_redacted")?.label).not.toBe("保存，去确认发送");
  });

  it("选择器恰好覆盖 enums 四档，档位外取值不给按钮（不摆能点却不该做的事）", () => {
    expect(processingModeChoices().map((choice) => choice.key)).toEqual([
      "manual_only",
      "local_model",
      "cloud_redacted",
      "cloud_raw",
    ]);
    for (const choice of processingModeChoices()) {
      const action = quickSecondActionFor(choice.key);
      expect(choice.key === "manual_only", choice.key).toBe(action === null);
    }
    expect(quickSecondActionFor("cloud_direct")).toBeNull();
    expect(quickSecondActionFor("")).toBeNull();
  });
});

/* ── B. 三档入队时序：成功 / 创建失败 / 入队失败 ─────────────────── */

describe("整理方式 · 保存并整理 = createRecord 必先于入队", () => {
  for (const mode of ["local_model", "cloud_redacted", "cloud_raw"]) {
    it(`${mode}：createRecord → onCreated → onSaved → enqueueJob(recordId) → onQueued，且回执说「已保存并进入整理队列」`, async () => {
      const h = harness();
      const outcome = await runQuickSave(h.deps, "周末想去爬山", mode, true);
      expect(h.calls, mode).toEqual([
        `createRecord:${mode}`,
        "onCreated:rec_new_1",
        "onSaved",
        "enqueueJob:rec_new_1",
        "onQueued:rec_new_1",
      ]);
      expect(outcome.kind, mode).toBe("saved-queued");
    });

    it(`${mode}：「只保存」那颗键绝不入队`, async () => {
      const h = harness();
      const outcome = await runQuickSave(h.deps, "只想存下来", mode, false);
      expect(h.calls, mode).toEqual([`createRecord:${mode}`, "onCreated:rec_new_1", "onSaved"]);
      expect(outcome.kind, mode).toBe("saved");
    });
  }

  it("createRecord 抛 ApiError：绝不入队、不刷徽章，detail 逐字如实呈现", async () => {
    const h = harness({
      create: async () => {
        h.calls.push("createRecord:fail");
        throw new ApiError(400, "invalid_request", "text 不能为空或仅空白", ["text"]);
      },
    });
    const outcome = await runQuickSave(h.deps, "   ", "local_model", true);
    expect(h.calls).toEqual(["createRecord:fail"]);
    // 创建失败绝不触发即时清空回调——用户的原文必须留在输入框里。
    expect(h.calls.filter((c) => c.startsWith("onCreated"))).toHaveLength(0);
    expect(outcome.kind).toBe("create-failed");
    expect(outcome.kind === "create-failed" && outcome.detail).toBe("text 不能为空或仅空白");
  });

  it("入队抛 503 ingest_unavailable：留在本页报错，原文已保存先讲，技术详情不丢", async () => {
    const h = harness({
      enqueue: async (recordId) => {
        h.calls.push(`enqueueJob:${recordId}`);
        throw new ApiError(503, "ingest_unavailable", "解析能力未就绪：Provider 面未装配。", []);
      },
    });
    const outcome = await runQuickSave(h.deps, "试试整理", "local_model", true);
    expect(outcome.kind).toBe("saved-organize-failed");
    const warn = outcome.kind === "saved-organize-failed" ? outcome.warn : "";
    const technical = outcome.kind === "saved-organize-failed" ? outcome.technical : null;
    expect(warn).toContain("原文已保存");
    expect(warn).not.toContain("保存失败");
    expect(technical).toContain("HTTP 503");
    expect(technical).toContain("ingest_unavailable");
    // 队列没收下这一行 ⇒ 那句「已保存并进入整理队列」与跳转都不许发生。
    expect(h.calls).not.toContain("onQueued:rec_new_1");
  });

  it("入队抛非 ApiError：仍算「原文已保存 + 入队没成」，不冒泡成未处理异常", async () => {
    const h = harness({
      enqueue: async () => {
        throw new Error("前端网络层断了");
      },
    });
    const outcome = await runQuickSave(h.deps, "离线时点整理", "cloud_raw", true);
    expect(outcome.kind).toBe("saved-organize-failed");
    const technical = outcome.kind === "saved-organize-failed" ? outcome.technical : null;
    expect(technical).toContain("前端网络层断了");
  });
});

/* ── C. manual_only：绝不调用模型，也绝不入队 ───────────────────── */

describe("整理方式 · manual_only：存完就停", () => {
  it("无论 organize 与否都不入队、不提示入队", async () => {
    for (const organize of [false, true]) {
      const h = harness();
      const outcome = await runQuickSave(h.deps, "写点私事", "manual_only", organize);
      expect(h.calls, String(organize)).toEqual(["createRecord:manual_only", "onCreated:rec_new_1", "onSaved"]);
      expect(outcome.kind, String(organize)).toBe("saved");
    }
  });
});

/* ── D. 界面契约（静态源码面） ───────────────────────────────────── */

describe("整理方式 · QuickPanel/App 的界面接线", () => {
  const quick = source("QuickPanel.tsx");
  const app = source("App.tsx");

  it("第二按钮按模式条件渲染，标签取自 `quickSave`（旧的两句话在两处都不再出现）", () => {
    expect(quick).toContain("quickSecondActionFor(mode)");
    expect(quick).toMatch(/second !== null && \(/);
    expect(quick).toContain("second.label");
    const driver = source("quickSave.ts");
    expect(driver).toContain("保存并整理");
    // 注释里留着「从前那句是什么」是给后来人看的；这里要钉的是它不再是**文案**。
    expect(driver.replace(/\/\*[\s\S]*?\*\//g, "")).not.toContain("保存，去确认发送");
    expect(quick).not.toContain("quickOrganizeBusyLabel");
  });

  it("颜色互换：manual_only 的「只保存」才是绿色；有第二动作时「只保存」是白色、「保存并整理」绿色", () => {
    expect(quick).toMatch(/className=\{second === null \? "btn primary" : "btn"\}/);
    // 第二颗键无条件 primary（`manual_only` 时它压根不渲染）。
    expect(quick).toMatch(/second !== null && \(\s*<button\s+className="btn primary"/);
  });

  it("忙碌态：入队用「排队中…」（不谎称已在整理），保存用「保存中…」，两按钮互斥禁用防重复提交", () => {
    expect(quick).toMatch(/busy === "organize" \? "排队中…"/);
    expect(quick).not.toMatch(/busy === "organize" \? "整理中…"/);
    expect(quick).not.toContain("正在打开…");
    expect(quick).toContain('busy === "save" ? "保存中…"');
    expect(quick).toContain("if (busy !== null) return;");
    const disabledCount = [...quick.matchAll(/disabled=\{busy !== null/g)].length;
    expect(disabledCount, "两个按钮都要在忙碌期禁用").toBeGreaterThanOrEqual(2);
  });

  it("保存成功即清空：setText(\"\") 绑在 createRecord 当刻的 onCreated，而非 runQuickSave 返回之后", () => {
    expect(quick).toMatch(/onCreated:\s*\(recordId\)\s*=>\s*\{[^}]*setText\(""\)[^}]*\}/);
    // 旧偏差＝整段 runQuickSave 返回后才 setText("")，违反「保存成功即清空」——必须已消失。
    expect(quick).not.toMatch(/return;\s*\}\s*setText\(""\)/);
    expect(quick.indexOf("onCreated")).toBeLessThan(quick.indexOf("await runQuickSave"));
    // 创建失败：如实报错并 return，既不进入 flash，也从不触发清空（原文留给用户）。
    expect(quick).toMatch(/if \(outcome\.kind === "create-failed"\) \{\s*setError\(outcome\.detail\);\s*return;\s*\}/);
  });

  it("入队当刻的回执走全局提示位并离开本页：notify({tone:\"ok\"}) + onReturnToPrevious 都在 onQueued 里", () => {
    expect(quick).toMatch(
      /onQueued:[^=]*=>\s*\{\s*props\.notify\(\{ tone: "ok", message: "已保存并进入整理队列。" \}\);\s*props\.onReturnToPrevious\(\);/,
    );
    expect(quick).toMatch(/notify:\s*\(input: NoticeInput\) => void/);
    expect(quick).toMatch(/onReturnToPrevious:\s*\(\) => void/);
  });

  it("Props 仍留 onOpenPending（那是「没有本机模型」那句引导的入口），App 接到 setSelectedId + 切 ingest 页", () => {
    expect(quick).toMatch(/onOpenPending:\s*\(recordId: string\) => void/);
    const branch = /<QuickPanel[\s\S]*?\/>/.exec(app)?.[0] ?? "";
    expect(branch, "App 的 QuickPanel 分支要被断言到").not.toBe("");
    expect(branch).toContain("onOpenPending");
    expect(branch).toMatch(/setSelectedId\(recordId\)/);
    expect(branch).toMatch(/setView\("ingest"\)/);
    expect(branch).toContain("onSaved={refreshBadges}");
  });

  it("来路由 App 记（不是固定回「今天」）：记上一个非 quick 页 + 走 leaveWithoutGuard", () => {
    expect(app).toMatch(/const \[quickReturn, setQuickReturn\] = useState<ViewKey>\("today"\);/);
    expect(app).toMatch(/if \(view !== "quick"\) setQuickReturn\(view\);/);
    expect(app).toMatch(/returnFromQuick[\s\S]{0,120}leaveWithoutGuard\(quickReturn\)/);
    const branch = /<QuickPanel[\s\S]*?\/>/.exec(app)?.[0] ?? "";
    expect(branch).toContain("notify={push}");
    expect(branch).toContain("onReturnToPrevious={returnFromQuick}");
  });

  it("快速页一个越权动作都不发：不 parse、不 preview、不 confirm-send、不 reparse", () => {
    // 从前 local_model 走同步 `api.ingestParse`；改成入队后这一页对模型的调用点应为零。
    expect(quick).not.toMatch(/\bapi\.ingestParse\b/);
    expect(quick).not.toMatch(/\bapi\.ingest(Reparse|Preview|ConfirmSend)\b/);
    expect(quick).toMatch(/\bapi\.enqueueJob\b/);
  });

  it("短标签说明模式去向，长解释不占主界面；行为边界仍由 quickSave 时序测试钉死", () => {
    const picker = source("ui/ProcessingModePicker.tsx");
    expect(quick).toContain("<ProcessingModePicker");
    expect(picker).toContain("整理方式：");
    expect(picker).toContain("先保存，需要时在本机整理");
    expect(picker).toContain("本地模型处理脱敏，发送云端模型整理");
    expect(quick).not.toContain("MODE_ACTION_NOTE");
  });
});
