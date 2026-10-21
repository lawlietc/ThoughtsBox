import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { ApiError } from "../src/web/apiClient.ts";
import type { IngestResultDto } from "../src/shared/dto.ts";
import { quickOrganizeBusyLabel, quickSecondActionFor, runQuickSave, type QuickSaveDeps } from "../src/web/quickSave.ts";
import { processingModeChoices } from "../src/web/projectionPort.ts";

/**
 * M5-2：QuickPanel「保存并整理」——按处理模式分派的保存动作。
 *
 * 时序与文案的钉法分两面：
 * - **动态面**：`runQuickSave` 是与 React 无关的驱动函数，测试注入记账假件，
 *   能真正执行「createRecord 成功 → onCreated（清空输入）→ onSaved → ingestParse → onSaved」
 *   这条链，并证伪「创建失败还去 parse」「onCreated 晚于 ingestParse（整理数十秒才清空）」「云端擅自 parse/preview/confirm-send」。
 * - **静态面**：按钮渲染条件、忙碌文案、`setText("")` 绑在 onCreated 而非 outcome 之后、
 *   App 的 `onOpenPending` 接线，沿用本仓 UI 测试既有的源码断言（vitest 是 node 环境，没有 DOM）。
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
  parse?: (body: { recordId: string }) => Promise<IngestResultDto>;
} = {}): Harness {
  const calls: string[] = [];
  const deps: QuickSaveDeps = {
    createRecord: options.create ?? (async (text, mode) => {
      calls.push(`createRecord:${mode}`);
      return { record: { id: `rec_new_${calls.length}` } };
    }),
    ingestParse: options.parse ?? (async ({ recordId }) => {
      calls.push(`ingestParse:${recordId}`);
      return parseResult({ succeeded: true });
    }),
    onCreated: (recordId) => {
      calls.push(`onCreated:${recordId}`);
    },
    onSaved: () => {
      calls.push("onSaved");
    },
    onOpenPending: (recordId) => {
      calls.push(`onOpenPending:${recordId}`);
    },
  };
  return { calls, deps };
}

function parseResult(overrides: Partial<IngestResultDto>): IngestResultDto {
  return {
    runId: "run_test_1",
    idempotencyKey: "key_test",
    pipelineFingerprint: "fp_test",
    processingMode: "local_model",
    succeeded: true,
    replayed: false,
    recovered: false,
    provider: "测试",
    model: "测试",
    callPath: "local",
    attemptedPaths: [],
    degraded: false,
    errorKind: null,
    writes: {
      episodes: 0,
      thoughts: 0,
      mentions: 0,
      rejectedMentions: 0,
      suggestions: 0,
      evidenceRepairs: 0,
      deduplicated: 0,
      unrouted: 0,
      unresolvedEntities: 0,
    },
    title: "测试标题",
    summary: "测试摘要",
    failure: null,
    ...overrides,
  };
}

/* ── A. 三模式的第二动作选择（纯函数） ──────────────────────────── */

describe("M5-2 · 三模式动作选择", () => {
  it("manual_only 没有第二按钮；local/cloud 各有一个，标签逐字来自任务书", () => {
    expect(quickSecondActionFor("manual_only")).toBeNull();
    expect(quickSecondActionFor("local_model")?.label).toBe("保存并整理");
    expect(quickSecondActionFor("cloud_redacted")?.label).toBe("保存，去确认发送");
    expect(quickSecondActionFor("local_model")?.kind).toBe("organize-local");
    expect(quickSecondActionFor("cloud_redacted")?.kind).toBe("go-pending");
  });

  it("选择器恰好覆盖 enums 三档，档位外取值不给按钮（不摆能点却不该做的事）", () => {
    expect(processingModeChoices().map((choice) => choice.key)).toEqual([
      "manual_only",
      "local_model",
      "cloud_redacted",
    ]);
    for (const choice of processingModeChoices()) {
      const action = quickSecondActionFor(choice.key);
      expect(choice.key === "manual_only", choice.key).toBe(action === null);
    }
    expect(quickSecondActionFor("cloud_direct")).toBeNull();
    expect(quickSecondActionFor("")).toBeNull();
  });

  it("忙碌文案按模式区分：local 整理=「整理中…」，cloud 只是导航不得谎称整理", () => {
    expect(quickOrganizeBusyLabel("local_model")).toBe("整理中…");
    expect(quickOrganizeBusyLabel("cloud_redacted")).not.toBe("整理中…");
    expect(quickOrganizeBusyLabel("cloud_redacted")).toBe("正在打开…");
  });
});

/* ── B. local_model：保存并整理的时序 ───────────────────────────── */

describe("M5-2 · local：createRecord 必先于 ingestParse", () => {
  it("成功路径：createRecord → onCreated → onSaved → ingestParse(recordId) → onSaved，onCreated 严格早于 parse", async () => {
    const h = harness();
    const outcome = await runQuickSave(h.deps, "周末想去爬山", "local_model", true);
    expect(h.calls).toEqual([
      "createRecord:local_model",
      "onCreated:rec_new_1",
      "onSaved",
      "ingestParse:rec_new_1",
      "onSaved",
    ]);
    expect(outcome.kind).toBe("saved");
    expect(outcome.kind === "saved" && outcome.flash).toContain("原文已保存");
  });

  it("输入清空早于整理返回：parse 挂起数十秒时 onCreated 已在 createRecord 成功当刻触发", async () => {
    const h = harness();
    let releaseParse: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseParse = () => resolve();
    });
    h.deps.ingestParse = async ({ recordId }) => {
      h.calls.push(`ingestParse:start:${recordId}`);
      await gate; // 模拟本机模型整理持续数十秒
      h.calls.push("ingestParse:resolved");
      return parseResult({ succeeded: true });
    };
    const pending = runQuickSave(h.deps, "慢慢整理", "local_model", true);
    // 冲刷 createRecord→onCreated→onSaved→ingestParse:start 这条微任务链（parse 仍卡在 gate 上）。
    await new Promise((resolve) => setTimeout(resolve, 0));
    // 关键：此刻 parse 尚未返回，但清空输入的 onCreated 已经发生——「保存成功即清空」不靠整理结束。
    expect(h.calls).toEqual(["createRecord:local_model", "onCreated:rec_new_1", "onSaved", "ingestParse:start:rec_new_1"]);
    expect(h.calls).not.toContain("ingestParse:resolved");
    releaseParse();
    await pending;
    expect(h.calls).toContain("ingestParse:resolved");
  });

  it("createRecord 抛 ApiError：绝不 parse、不刷徽章，detail 逐字如实呈现", async () => {
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

  it("parse 返回 succeeded:false：文案先说「原文已保存」，再带真实 failure.message 与 errorKind", async () => {
    const h = harness({
      parse: async ({ recordId }) => {
        h.calls.push(`ingestParse:${recordId}`);
        return parseResult({
          succeeded: false,
          errorKind: "provider_unavailable",
          failure: {
            errorKind: "provider_unavailable",
            retryable: false,
            message: "本机模型没在运行",
            issues: [],
          },
        });
      },
    });
    const outcome = await runQuickSave(h.deps, "试试本机整理", "local_model", true);
    expect(outcome.kind).toBe("saved-organize-failed");
    const warn = outcome.kind === "saved-organize-failed" ? outcome.warn : "";
    expect(warn).toContain("原文已保存");
    expect(warn).toContain("本机模型没在运行");
    expect(warn).toContain("provider_unavailable");
    // 徽章刷新：创建成功一次、parse 结束（失败也是结束）再一次。
    expect(h.calls.filter((c) => c === "onSaved")).toHaveLength(2);
  });

  it("parse 抛 ApiError：仍是「原文已保存 + 真实 detail」，保存不被说成失败", async () => {
    const h = harness({
      parse: async ({ recordId }) => {
        h.calls.push(`ingestParse:${recordId}`);
        throw new ApiError(503, "service_unavailable", "本地模型服务不可达", []);
      },
    });
    const outcome = await runQuickSave(h.deps, "云端在时本机挂了", "local_model", true);
    expect(outcome.kind).toBe("saved-organize-failed");
    const warn = outcome.kind === "saved-organize-failed" ? outcome.warn : "";
    expect(warn).toContain("原文已保存");
    expect(warn).toContain("本地模型服务不可达");
    expect(warn).not.toContain("保存失败");
    expect(h.calls.filter((c) => c === "onSaved")).toHaveLength(2);
  });

  it("「只保存」按钮即使在 local 档位也不碰 parse", async () => {
    const h = harness();
    await runQuickSave(h.deps, "只想存下来", "local_model", false);
    expect(h.calls).toEqual(["createRecord:local_model", "onCreated:rec_new_1", "onSaved"]);
  });
});

/* ── C. cloud_redacted：只保存、只导航，绝不越权 ─────────────────── */

describe("M5-2 · cloud：保存后去「待整理」，不自动 parse / preview / confirm-send", () => {
  it("时序：createRecord → onCreated（清空）→ onSaved → onOpenPending(recordId)；parse 一次都不被调用", async () => {
    const h = harness({
      create: async (_text, mode) => {
        h.calls.push(`createRecord:${mode}`);
        return { record: { id: "rec_cloud_1" } };
      },
      parse: async ({ recordId }) => {
        h.calls.push(`ingestParse:BANNED:${recordId}`);
        return parseResult({ succeeded: true });
      },
    });
    const outcome = await runQuickSave(h.deps, "这条想送云端但先要确认", "cloud_redacted", true);
    expect(h.calls).toEqual([
      "createRecord:cloud_redacted",
      "onCreated:rec_cloud_1",
      "onSaved",
      "onOpenPending:rec_cloud_1",
    ]);
    expect(outcome.kind).toBe("saved");
    const flash = outcome.kind === "saved" ? outcome.flash : "";
    expect(flash).toContain("原文已保存");
    expect(flash).toContain("待整理");
    expect(flash).toContain("逐次确认");
  });

  it("源码层再钉一遍：QuickPanel 不存在 preview / confirm-send / reparse 的调用点", () => {
    const text = source("QuickPanel.tsx");
    expect(text).toMatch(/\bapi\.ingestParse\b/);
    expect(text).not.toMatch(/\bapi\.ingest(Reparse|Preview|ConfirmSend)\b/);
  });
});

/* ── D. manual_only：绝不调用模型 ───────────────────────────────── */

describe("M5-2 · manual_only：存完就停", () => {
  it("无论 organize 与否都不 parse、不导航", async () => {
    for (const organize of [false, true]) {
      const h = harness();
      const outcome = await runQuickSave(h.deps, "写点私事", "manual_only", organize);
      expect(h.calls, String(organize)).toEqual(["createRecord:manual_only", "onCreated:rec_new_1", "onSaved"]);
      expect(outcome.kind, String(organize)).toBe("saved");
    }
  });
});

/* ── E. 界面契约（静态源码面） ───────────────────────────────────── */

describe("M5-2 · QuickPanel/App 的界面接线", () => {
  const quick = source("QuickPanel.tsx");
  const app = source("App.tsx");

  it("第二按钮按模式条件渲染，标签逐字来自选择器", () => {
    expect(quick).toContain("quickSecondActionFor(mode)");
    expect(quick).toMatch(/second !== null && \(/);
    expect(quick).toContain("保存并整理");
    expect(quick).toContain("保存，去确认发送");
  });

  it("忙碌态：local 整理经 quickOrganizeBusyLabel(mode)，保存显示「保存中…」，两按钮互斥禁用防重复提交", () => {
    expect(quick).toContain("quickOrganizeBusyLabel(mode)");
    // 旧偏差：organize 一律硬映射成「整理中…」——云端只是导航，那不是整理，撒谎。现在不得再出现。
    expect(quick).not.toMatch(/busy === "organize" \? "整理中…"/);
    expect(quick).toContain('busy === "save" ? "保存中…"');
    expect(quick).toContain("if (busy !== null) return;");
    const disabledCount = [...quick.matchAll(/disabled=\{busy !== null/g)].length;
    expect(disabledCount, "两个按钮都要在忙碌期禁用").toBeGreaterThanOrEqual(2);
  });

  it("保存成功即清空：setText(\"\") 绑在 createRecord 当刻的 onCreated，而非 runQuickSave 返回之后", () => {
    // 即时清空挂在 onCreated 上（createRecord 成功当刻触发）。
    expect(quick).toMatch(/onCreated:\s*\(\)\s*=>\s*setText\(""\)/);
    // 旧偏差＝整段 runQuickSave 返回后才 setText("")（local 整理可达数十秒），违反 §一.2——必须已消失。
    expect(quick).not.toMatch(/return;\s*\}\s*setText\(""\)/);
    expect(quick.indexOf("onCreated")).toBeLessThan(quick.indexOf("await runQuickSave"));
    // 创建失败：如实报错并 return，既不进入 flash，也从不触发清空（原文留给用户）。
    expect(quick).toMatch(/if \(outcome\.kind === "create-failed"\) \{\s*setError\(outcome\.detail\);\s*return;\s*\}/);
  });

  it("Props 增 onOpenPending(recordId)，且 App 接到 setSelectedId + 切 ingest 页", () => {
    expect(quick).toMatch(/onOpenPending:\s*\(recordId: string\) => void/);
    const branch = /<QuickPanel[\s\S]*?\/>/.exec(app)?.[0] ?? "";
    expect(branch, "App 的 QuickPanel 分支要被断言到").not.toBe("");
    expect(branch).toContain("onOpenPending");
    expect(branch).toMatch(/setSelectedId\(recordId\)/);
    expect(branch).toMatch(/setView\("ingest"\)/);
    expect(branch).toContain("onSaved={refreshBadges}");
  });

  it("短标签说明模式去向，长解释不占主界面；行为边界仍由 quickSave 时序测试钉死", () => {
    const picker = source("ui/ProcessingModePicker.tsx");
    expect(quick).toContain("<ProcessingModePicker");
    expect(picker).toContain("整理方式：");
    expect(picker).toContain("先保存，需要时在本机整理");
    expect(picker).toContain("保存后去确认发送");
    expect(quick).not.toContain("MODE_ACTION_NOTE");
  });
});
