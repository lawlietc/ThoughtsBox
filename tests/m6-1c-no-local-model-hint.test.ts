import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  NO_LOCAL_MODEL_HINT_ACTION_EGRESS,
  NO_LOCAL_MODEL_HINT_ACTION_LOCAL,
  NO_LOCAL_MODEL_HINT_CLOUD_MISSING,
  NO_LOCAL_MODEL_HINT_KEY,
  NO_LOCAL_MODEL_HINT_TEXT,
  cloudSendAvailable,
  hintEntryFor,
  markHintDismissed,
  readHintDismissed,
  shouldShowNoLocalModelHint,
} from "../src/web/noLocalModelHint.ts";
import type { HintStorage } from "../src/web/noLocalModelHint.ts";
import type { ProcessingModeAvailabilityDto } from "../src/shared/dto.ts";

/**
 * M6-1C「没有本地模型时的首次保存引导」专项验收。
 *
 * 契约（方案 §八 阶段 1 第 1 条 + 阶段 1 准则 M6-1C 的三条必过断言）：
 *   1. 没有本地模型 ⇒ 首次保存后出现提示一次；
 *   2. 已有本地模型 ⇒ 不出现；
 *   3. 提示不阻塞编辑器（可继续输入）。
 * 外加本任务判据的两条硬约束：拿不到配置时**不**提示（不知情就不开口），
 * 文案必须把「手动标记不需要模型」与「发送原文不脱敏、完整离开本机」同时说清。
 * F 段是 1C-R 的追加契约：提示里要带一个能按的下一步，且它不改变「知道了」的语义。
 * G 段是 1C-R2 的追加契约：那个下一步按「保存当刻的档位」分流，云端没配置时不画它。
 *
 * vitest 是 node 环境（没有 DOM），沿用本仓 UI 测试的两条路子：
 * 判据与文案走 `noLocalModelHint.ts` 的直接 import（那正是它不带 React 依赖的理由），
 * 渲染位置与「不许打断编辑」走源码文本断言（与 `web-ui-shell.test.ts`、`m5-2` 同法）。
 */

const WEB = join(process.cwd(), "src", "web");

function source(rel: string): string {
  return readFileSync(join(WEB, rel), "utf8");
}

/**
 * 去掉注释后的源码。
 *
 * 「这一句文案只能住在一处」这类断言要的是**会被渲染的字符串**，注释里引述那句文案
 * 不算另抄一份——所以断言跑在这份裁剪过的源码上，比跑在整份文件上更贴合意图。
 */
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

const NO_LOCAL: ProcessingModeAvailabilityDto = {
  manual_only: true,
  local_model: false,
  cloud_redacted: false,
  cloud_raw: false,
};
const HAS_LOCAL: ProcessingModeAvailabilityDto = {
  manual_only: true,
  local_model: true,
  cloud_redacted: false,
  cloud_raw: false,
};
/** 只有脱敏外发这一档可用（云端已配置的最常见形态）。 */
const CLOUD_REDACTED_ONLY: ProcessingModeAvailabilityDto = {
  manual_only: true,
  local_model: false,
  cloud_redacted: true,
  cloud_raw: false,
};
/** 只有原文外发这一档可用：可用性与「哪一档在册」是两件事，入口只问「云端走不走得通」。 */
const CLOUD_RAW_ONLY: ProcessingModeAvailabilityDto = {
  manual_only: true,
  local_model: false,
  cloud_redacted: false,
  cloud_raw: true,
};

/* ── A. 判据：只在「确实没有本机模型」时开口 ───────────────────── */

describe("M6-1C · 判据", () => {
  it("local_model=false ⇒ 提示", () => {
    expect(shouldShowNoLocalModelHint(NO_LOCAL)).toBe(true);
  });

  it("local_model=true ⇒ 不提示（这台机器本来就能用本机模型，没什么要补的）", () => {
    expect(shouldShowNoLocalModelHint(HAS_LOCAL)).toBe(false);
  });

  it("availability=null ⇒ 不提示：配置没读到的那一刻我们并不知情，静默比谎报好", () => {
    expect(shouldShowNoLocalModelHint(null)).toBe(false);
  });

  it("判据只看 local_model 这一格：云端两档不可用不构成提示理由", () => {
    expect(
      shouldShowNoLocalModelHint({
        manual_only: true,
        local_model: true,
        cloud_redacted: false,
        cloud_raw: false,
      }),
    ).toBe(false);
  });

  it("localStorage 键沿用 tb- 前缀，且不与主题 / 盒子视图那两把既有键相撞", () => {
    expect(NO_LOCAL_MODEL_HINT_KEY).toMatch(/^tb-/);
    expect(NO_LOCAL_MODEL_HINT_KEY).not.toBe("tb-theme");
    expect(NO_LOCAL_MODEL_HINT_KEY).not.toBe("tb-box-view");
  });
});

/* ── B. storage：注入 + 抛错降级 ───────────────────────────────── */

/** 一份记得出写了什么的内存假件（真 `window.localStorage` 结构上满足 HintStorage）。 */
function memoryStorage(): HintStorage & { readonly written: Map<string, string> } {
  const written = new Map<string, string>();
  return {
    written,
    getItem: (key: string) => written.get(key) ?? null,
    setItem: (key: string, value: string) => {
      written.set(key, value);
    },
  };
}

/** 隐私模式下 `localStorage` 就是直接抛——这份假件把那一幕搬进 node。 */
const throwingStorage: HintStorage = {
  getItem: () => {
    throw new Error("SecurityError：隐私模式不允许读 localStorage");
  },
  setItem: () => {
    throw new Error("SecurityError：隐私模式不允许写 localStorage");
  },
};

describe("M6-1C · 关闭标记的读写与降级", () => {
  it("没写过 ⇒ 视为未关闭（第一次保存后该提示）", () => {
    expect(readHintDismissed(memoryStorage())).toBe(false);
  });

  it("写过 ⇒ 视为已关闭，此后不再提示", () => {
    const storage = memoryStorage();
    expect(readHintDismissed(storage)).toBe(false);
    markHintDismissed(storage);
    expect(readHintDismissed(storage)).toBe(true);
  });

  it("写的是 NO_LOCAL_MODEL_HINT_KEY 这一格（不偷偷另开一处持久化设置）", () => {
    const storage = memoryStorage();
    markHintDismissed(storage);
    expect([...storage.written.keys()]).toEqual([NO_LOCAL_MODEL_HINT_KEY]);
  });

  it("读抛错 ⇒ 当作未关闭（宁可多说一句，也不静默替用户决定）", () => {
    expect(readHintDismissed(throwingStorage)).toBe(false);
  });

  it("写抛错 ⇒ 静默不抛（刚保存成功的那一次不能因为存不下就变成一次失败）", () => {
    expect(() => markHintDismissed(throwingStorage)).not.toThrow();
  });

  it("格子里是别的东西 ⇒ 仍算未关闭", () => {
    const storage = memoryStorage();
    storage.setItem(NO_LOCAL_MODEL_HINT_KEY, "dismissed-but-not-really");
    expect(readHintDismissed(storage)).toBe(false);
  });
});

/* ── C. 文案：本任务的核心断言 ─────────────────────────────────── */

describe("M6-1C · 提示正文", () => {
  it('两条路都在：「手动标记」与「原文」同时出现', () => {
    expect(NO_LOCAL_MODEL_HINT_TEXT).toContain("手动标记");
    expect(NO_LOCAL_MODEL_HINT_TEXT).toContain("原文");
  });

  it("手动标记那一条说不需要任何模型", () => {
    expect(NO_LOCAL_MODEL_HINT_TEXT).toMatch(/不调用任何模型|不需要任何模型|不需要模型/);
  });

  it("原文那一条把风险说实：不做任何脱敏 + 会完整离开本机", () => {
    expect(NO_LOCAL_MODEL_HINT_TEXT).toContain("不做任何脱敏");
    expect(NO_LOCAL_MODEL_HINT_TEXT).toContain("完整离开本机");
  });

  it("不许出现「不会离开本机」——那与同一句里「发送原文会离开本机」自相矛盾", () => {
    expect(NO_LOCAL_MODEL_HINT_TEXT).not.toMatch(/不会离开本机/);
  });

  it("开头先说清前提（这台电脑没有可用的本机模型），不是凭空冒出来的一句话", () => {
    expect(NO_LOCAL_MODEL_HINT_TEXT).toMatch(/没有可用的本机模型/);
  });

  it("措辞克制：没有恐吓式用语，也没有「放心/安全」这类淡化风险的词", () => {
    for (const banned of ["警告", "危险", "泄露", "隐私泄露", "请放心", "绝对安全"]) {
      expect(NO_LOCAL_MODEL_HINT_TEXT, `正文出现了「${banned}」`).not.toContain(banned);
    }
  });

  it("是一段顺带的信息，不是一句需要应答的问话", () => {
    expect(NO_LOCAL_MODEL_HINT_TEXT).not.toMatch(/[？?]$/);
  });
});

/* ── D. QuickPanel 接线：位置、时机、以及「不许打断编辑」 ──────── */

describe("M6-1C · QuickPanel 接线（源码结构面）", () => {
  const quick = source("QuickPanel.tsx");
  const flashAt = quick.indexOf('<p className="flash">{flash}</p>');
  const hintAt = quick.indexOf("{hintVisible && (");
  const textareaAt = quick.indexOf("<textarea");

  it("提示渲染在 flash 之后/旁侧，且 flash 那条一个字没被替换掉", () => {
    expect(flashAt, "flash 那行必须还在原位").toBeGreaterThan(-1);
    expect(hintAt, "提示的渲染点要被断言到").toBeGreaterThan(flashAt);
    expect(quick).toContain('{flash !== null && <p className="flash">{flash}</p>}');
  });

  it("提示画在输入区之前，不挡编辑：textarea 仍是紧接其后的输入区", () => {
    expect(hintAt).toBeLessThan(textareaAt);
  });

  it("只在保存成功且没有排队（outcome.kind === \"saved\"）那条路径上提示", () => {
    // saved 分支里提示；`saved-organize-failed` 分支只报错——那条路上说的是入队没成功，
    // 不是模型可用性。`saved-queued` 分支既不提示也不报错：回执走全局提示位、页面随即离开，
    // 在一颗即将卸载的页面上补一句引导等于对着一扇关上的门说话。三个分支的分工由这一条正则钉住。
    expect(quick).toMatch(
      /if \(outcome\.kind === "saved"\) \{[\s\S]*?shouldShowNoLocalModelHint\(availability\)[\s\S]*?setHintVisible\(true\);[\s\S]*?\} else if \(outcome\.kind === "saved-organize-failed"\) \{\s*setError\(outcome\.warn\);/,
    );
    expect([...quick.matchAll(/setHintVisible\(true\)/g)]).toHaveLength(1);
  });

  it("不打断编辑：不抢焦点、不滚动定位、不弹模态", () => {
    expect(quick).not.toMatch(/autoFocus/);
    expect(quick).not.toMatch(/\.focus\(\)/);
    expect(quick).not.toMatch(/scrollIntoView/);
    expect(quick).not.toMatch(/showModal|<dialog/);
    expect(quick).not.toMatch(/role="alertdialog"/);
  });

  it("输入区没有被新加的禁用条件（按钮那两处忙碌态禁用是既有纪律，不算）", () => {
    const textareaBlock = /<textarea[\s\S]*?\/>/.exec(quick)?.[0] ?? "";
    expect(textareaBlock, "textarea 块要被断言到").not.toBe("");
    expect(textareaBlock).not.toContain("disabled");
    expect(quick).not.toMatch(/setDisabled|disabled=\{\s*hint/);
  });

  it("「知道了」写标记并收起本次，不碰其它状态", () => {
    const dismiss = /function dismissHint\(\): void \{[\s\S]*?\n  \}/.exec(quick)?.[0] ?? "";
    expect(dismiss, "dismissHint 要被断言到").not.toBe("");
    expect(dismiss).toContain("markHintDismissed(window.localStorage)");
    expect(dismiss).toContain("setHintDismissed(true)");
    expect(dismiss).toContain("setHintVisible(false)");
    expect(quick).toContain("onClick={dismissHint}");
    expect(quick).toContain(">知道了</button>");
  });

  it("关闭标记只在进入本页时读一次（不是每次渲染都去摸 localStorage）", () => {
    expect(quick).toContain("useState(() => readHintDismissed(window.localStorage))");
  });

  it("不新增配置请求：availability 复用既有那一次 ingestConfig 的 state", () => {
    // 调用点在源码里是链式换行写法（`api` ↦ `.ingestConfig()`），所以匹配方法名那一节。
    const configCalls = [...quick.matchAll(/ingestConfig\(\)/g)].length;
    expect(configCalls, "QuickPanel 只该有一次 ingestConfig 调用点").toBe(1);
    expect(quick).toContain("setAvailability(cfg.processingAvailability)");
    expect(quick).toContain("shouldShowNoLocalModelHint(availability)");
  });

  it("快速页的既有纪律没被削弱：不 preview、不 confirm-send、不 reparse、也不 parse", () => {
    // 〔整理方式改动〕第二动作改进入队之后，这一页连 `api.ingestParse` 都不发了——比从前更严。
    expect(quick).toMatch(/\bapi\.enqueueJob\b/);
    expect(quick).not.toMatch(/\bapi\.ingest(Parse|Reparse|Preview|ConfirmSend)\b/);
  });

  it("提示文案来自导出的常量，不在页面里另抄一份（两处措辞不许漂移成两个真相）", () => {
    expect(quick).toContain("NO_LOCAL_MODEL_HINT_TEXT");
    expect(quick).not.toContain("手动标记敏感词");
  });
});

/* ── E. fakeApi：可控开关，DTO 形状不动 ───────────────────────── */

describe("M6-1C · fakeApi 的本地模型可用性开关", () => {
  const fake = source("fakeApi.ts");

  it("开关导出了，且默认关（假侧维持「未装配」那副样子）", () => {
    expect(fake).toContain("export function setFakeLocalModelAvailable(available: boolean): void");
    expect(fake).toContain("let FAKE_LOCAL_MODEL_AVAILABLE = false;");
  });

  it("开关只翻派生出的 local_model 那一格，其余三档的来源不变", () => {
    expect(fake).toContain(
      "local_model: FAKE_LOCAL_MODEL_AVAILABLE || (config.localModel.enabled && config.localModel.ready),",
    );
    expect(fake).toContain("cloud_redacted: config.cloudModel.enabled && config.cloudModel.ready,");
    expect(fake).toContain("cloud_raw: config.cloudModel.enabled && config.cloudModel.ready,");
    expect(fake).toContain("manual_only: true as const,");
  });

  it("假 DTO 形状没被扩：可用性仍只有四档，配置体只多这一个派生值", () => {
    const availabilityBlock = /function fakeAvailability[\s\S]*?\n}/.exec(fake)?.[0] ?? "";
    expect(availabilityBlock, "fakeAvailability 要被断言到").not.toBe("");
    expect([...availabilityBlock.matchAll(/^\s{4}\w+:/gm)]).toHaveLength(4);
  });

  it("不新增任何 HTTP 端点：路由表里没多一条 /api/*", () => {
    const paths = [...fake.matchAll(/"\/api\/[^"]+"/g)].map((match) => match[0]);
    expect(paths.length, "假路由表要被断言到").toBeGreaterThan(0);
    expect(paths.filter((path) => path.includes("hint"))).toHaveLength(0);
  });
});

/* ── F. 1C-R：提示条里的「下一步」入口 ─────────────────────────── */

/**
 * 〔主 Agent 裁决 2026-10-27〕：提示说完「有两条路」之后要给一个能按的下一步。
 * 这里的断言只锁四件事：文案只有一个真相；入口指向保存时记下的那一条；走入口不等于
 * 关掉提示；「知道了」的行为一字未动。不发 HTTP、不改 DTO——复用既有 `onOpenPending`
 * 与 SleepPanel 那条 `setSelectedId + setView("records")` 的接线。
 */
describe("M6-1C-R · 提示里的下一步入口", () => {
  const quick = source("QuickPanel.tsx");
  /** 提示块本体：从 `{hintVisible && (` 到它那对结束标签。 */
  const hintBlock = /\{hintVisible && \(\s*<div className="banner" role="status">[\s\S]*?<\/div>\s*\)/.exec(
    quick,
  )?.[0] ?? "";
  /** 入口按钮本体（连它的双重非空判据）。 */
  const entryButton = /\{entry !== null && pendingRecordId !== null && \(\s*<button[\s\S]*?<\/button>\s*\)\}/.exec(
    quick,
  )?.[0] ?? "";

  it("两个动作文案常量都存在且非空——这一句只能住在 noLocalModelHint.ts 里", () => {
    for (const label of [NO_LOCAL_MODEL_HINT_ACTION_EGRESS, NO_LOCAL_MODEL_HINT_ACTION_LOCAL]) {
      expect(typeof label).toBe("string");
      expect(label.trim().length).toBeGreaterThan(0);
    }
  });

  it("文案的唯一真相在 noLocalModelHint.ts：QuickPanel 引判据/常量，页面里不出现这两句字面量", () => {
    const body = codeOnly(quick.replace(/import \{[\s\S]*?\} from "\.\/noLocalModelHint\.ts";/, ""));
    for (const label of [NO_LOCAL_MODEL_HINT_ACTION_EGRESS, NO_LOCAL_MODEL_HINT_ACTION_LOCAL]) {
      expect(body, `页面里不该再出现这段文案本身「${label}」`).not.toContain(label);
    }
    // 渲染的是判据给出的那一个 label，而不是硬编码的某一句。
    expect(body, "按钮文案要来自 hintEntryFor 的结果").toContain("{entry.label}");
    const hint = source("noLocalModelHint.ts");
    expect([...hint.matchAll(/"去选择发送方式"/g)]).toHaveLength(1);
    expect([...hint.matchAll(/"去设置整理方式"/g)]).toHaveLength(1);
  });

  it("动作文案说的是「去选择 / 去设置」：既不是问话，也不谎称已经发出去了", () => {
    for (const label of [NO_LOCAL_MODEL_HINT_ACTION_EGRESS, NO_LOCAL_MODEL_HINT_ACTION_LOCAL]) {
      expect(label).not.toMatch(/[？?]$/);
      expect(label).not.toMatch(/已发送|自动发送|立即发送/);
    }
  });

  it("入口就在提示块里，两个落点都走既有回调，参数是保存时记下的那条 recordId", () => {
    expect(hintBlock, "提示块要被断言到").not.toBe("");
    expect(hintBlock).toContain("{entry.label}");
    expect(hintBlock).toContain("props.onOpenPending(pendingRecordId)");
    expect(hintBlock).toContain("props.onOpenRecord(pendingRecordId)");
    expect(quick).toContain("const pendingRecordId = savedRecordId.current;");
  });

  it("recordId 在 createRecord 成功当刻记下，且写在清空输入之前", () => {
    const created = /onCreated: \(recordId\) => \{[\s\S]*?\n    \}/.exec(quick)?.[0] ?? "";
    expect(created, "onCreated 回调体要被断言到").not.toBe("");
    expect(created).toContain("savedRecordId.current = recordId;");
    expect(created).toContain('setText("");');
    expect(created.indexOf("savedRecordId.current = recordId;")).toBeLessThan(created.indexOf('setText("");'));
  });

  it("边界按登记的取舍：没有 recordId 就不渲染这个按钮（而不是一个永远点不亮的灰按钮）", () => {
    expect(entryButton, "入口按钮的渲染判据要被断言到").not.toBe("");
    expect(entryButton).toContain("pendingRecordId !== null && (");
    expect(entryButton, "这个按钮不靠 disabled 表达空态").not.toContain("disabled");
  });

  it("点入口不等于关掉提示：不调 markHintDismissed，也不动 hintDismissed/hintVisible", () => {
    expect(entryButton).not.toContain("markHintDismissed");
    expect(entryButton).not.toContain("dismissHint");
    expect(entryButton).not.toMatch(/setHint(Visible|Dismissed)/);
  });

  it("「知道了」仍是原样：markHintDismissed + 收起，整段 dismissHint 里没有两个入口回调", () => {
    const dismiss = /function dismissHint\(\): void \{[\s\S]*?\n  \}/.exec(quick)?.[0] ?? "";
    expect(dismiss, "dismissHint 要被断言到").not.toBe("");
    expect(dismiss).toContain("markHintDismissed(window.localStorage)");
    expect(dismiss).toContain("setHintDismissed(true)");
    expect(dismiss).toContain("setHintVisible(false)");
    expect(dismiss).not.toContain("onOpenPending");
    expect(dismiss).not.toContain("onOpenRecord");
    expect(dismiss).not.toContain("savedRecordId");
    expect(hintBlock).toContain("onClick={dismissHint}>知道了</button>");
  });

  it("不新增样式：提示块里只出现既有的 banner / btn 两个类名", () => {
    const classes = [...hintBlock.matchAll(/className="([^"]+)"/g)].map((match) => match[1]);
    expect(classes.length, "提示块里该有类名可查").toBeGreaterThan(0);
    for (const cls of classes) expect(["banner", "btn"], `出现了新类名「${cls}」`).toContain(cls);
  });

  it("入口不抢焦点、不滚动定位，也没把提示升级成模态", () => {
    expect(quick).not.toMatch(/autoFocus/);
    expect(quick).not.toMatch(/\.focus\(\)/);
    expect(quick).not.toMatch(/scrollIntoView/);
    expect(quick).not.toMatch(/showModal|<dialog|role="alertdialog"/);
  });

  it("没有为此新增任何取数调用：QuickPanel 摸到的还是既有那几个 api 方法", () => {
    // `ingestConfig` 在源码里是链式换行写法（`api` ↦ `.ingestConfig()`），不进这个集合。
    // 〔S6 有意变动〕写入页不再顺带写默认值，`updateProcessingDefaults` 随之退场。
    // 〔2026-11-06 裁定回摆：三处共用同一个默认值〕写入页恢复四档，改档必须回写
    // `recordDefaultMode`，那一条写通道因此回来了——它写的是偏好，不是这条提示的取数。
    // 判据没有变宽：提示入口本身仍一条通道都不多开（下面那条 not.toMatch 原样留着）。
    const calls = [...new Set([...quick.matchAll(/\bapi\.(\w+)/g)].map((match) => match[1]))].sort();
    // 〔整理方式改动〕`ingestParse` 退场、`enqueueJob` 进场：提示入口本身仍一条通道都不多开
    // （下面那条 not.toMatch 原样留着）。
    expect(calls).toEqual(["createRecord", "enqueueJob", "updateProcessingDefaults"]);
    expect(quick).not.toMatch(/\bapi\.ingest(Reparse|Preview|ConfirmSend)\b/);
    // 那一条写通道只有一个用途：改档当刻回写 `recordDefaultMode`，一次调用、一个键。
    expect([...quick.matchAll(/\bapi\.updateProcessingDefaults\(/g)]).toHaveLength(1);
    expect(quick).toContain('processingPatchForScope("record", next)');
  });
});

/* ── G. 1C-R2：入口按档位分流 + 云端未配置时收起 ──────────────── */

/**
 * 〔主 Agent 裁决 2026-10-27〕1C-R 那一版的入口一律落「待整理」，实测缺陷：
 * manual_only / local_model 的记录不进那份列表，`pending.find(id) ?? pending[0]`
 * 于是选中了列表第一条别人的记录。本段钉住修正后的判据与渲染。
 */
describe("M6-1C-R2 · cloudSendAvailable", () => {
  it("云端两档都不可用 ⇒ false（那两条路此刻都走不通）", () => {
    expect(cloudSendAvailable(NO_LOCAL)).toBe(false);
  });

  it("任一档可用 ⇒ true：脱敏档、原文档各自都算走得通", () => {
    expect(cloudSendAvailable(CLOUD_REDACTED_ONLY)).toBe(true);
    expect(cloudSendAvailable(CLOUD_RAW_ONLY)).toBe(true);
    expect(cloudSendAvailable({ manual_only: true, local_model: false, cloud_redacted: true, cloud_raw: true })).toBe(
      true,
    );
  });

  it("availability=null ⇒ false：配置没读到时不谎称走得通（与不提示同一条取向）", () => {
    expect(cloudSendAvailable(null)).toBe(false);
  });

  it("判据不看 local_model：本机模型在不在与云端通不通是两件事", () => {
    expect(cloudSendAvailable({ manual_only: true, local_model: true, cloud_redacted: true, cloud_raw: false })).toBe(
      true,
    );
    expect(cloudSendAvailable(HAS_LOCAL)).toBe(false);
  });
});

describe("M6-1C-R2 · hintEntryFor（入口的落点与文案）", () => {
  it("保存档位是外发档 ⇒ 落「待整理」并选中这条，文案说「去选择发送方式」", () => {
    expect(hintEntryFor("cloud_redacted", CLOUD_REDACTED_ONLY)).toEqual({
      kind: "pending",
      label: NO_LOCAL_MODEL_HINT_ACTION_EGRESS,
    });
    // cloud_raw 在册即自动获得同一路径（判三轴，不抄字面量分支）。
    expect(hintEntryFor("cloud_raw", CLOUD_RAW_ONLY)).toEqual({
      kind: "pending",
      label: NO_LOCAL_MODEL_HINT_ACTION_EGRESS,
    });
  });

  it("保存档位是 manual_only / local_model ⇒ 落「全部记录」的这条详情，文案说「去设置整理方式」", () => {
    for (const mode of ["manual_only", "local_model"]) {
      expect(hintEntryFor(mode, CLOUD_REDACTED_ONLY), `档位 ${mode}`).toEqual({
        kind: "record",
        label: NO_LOCAL_MODEL_HINT_ACTION_LOCAL,
      });
    }
  });

  it("云端两档都不可用 ⇒ null：没路可指就不指，不画一个走不通的入口", () => {
    for (const mode of ["cloud_redacted", "cloud_raw", "manual_only", "local_model"]) {
      expect(hintEntryFor(mode, NO_LOCAL), `档位 ${mode}`).toBeNull();
    }
  });

  it("availability=null ⇒ null：此刻我们并不知情，既不加文案也不画入口", () => {
    expect(hintEntryFor("cloud_redacted", null)).toBeNull();
    expect(hintEntryFor("manual_only", null)).toBeNull();
  });

  it("不在册的 mode 字符串 ⇒ 按非外发处理（保守的一侧：落到能看见四档的地方）", () => {
    for (const mode of ["", "cloud", "CLOUD_RAW", "who_knows"]) {
      expect(hintEntryFor(mode, CLOUD_REDACTED_ONLY), `档位「${mode}」`).toEqual({
        kind: "record",
        label: NO_LOCAL_MODEL_HINT_ACTION_LOCAL,
      });
    }
  });

  it("外发判定复用三轴那道闸门，不另抄字面量分支", () => {
    const hint = source("noLocalModelHint.ts");
    expect(hint).toContain("isEgress(axesForProcessingMode(");
    expect(hint).toMatch(/isProcessingModeValue\(/);
  });
});

describe("M6-1C-R2 · QuickPanel 与 App 的接线（源码结构面）", () => {
  const quick = source("QuickPanel.tsx");
  const app = source("App.tsx");
  const hintBlock = /\{hintVisible && \(\s*<div className="banner" role="status">[\s\S]*?<\/div>\s*\)/.exec(
    quick,
  )?.[0] ?? "";

  it("正文始终渲染，入口按 hintEntryFor 的结果分流", () => {
    expect(hintBlock).toContain("{NO_LOCAL_MODEL_HINT_TEXT}");
    expect(quick).toContain("hintEntryFor(savedMode.current, availability)");
    expect(hintBlock).toContain('entry.kind === "pending"');
  });

  it("档位取的是保存当刻记下的那一份，不是之后可能被改的 state", () => {
    expect(quick).toMatch(/const savedMode = useRef\("manual_only"\);/);
    // 〔2026-11-06 四档恢复〕写入页重新有了「当前所选档位」这一格 state，`mode` 因此同时是
    // 那次点击的闭包值与之后可能被改的 state。判据没变宽，反而更吃紧：saved 分支必须在 flash
    // 之前把点击当刻的那一份抄进 `savedMode`，入口落点只读 `savedMode.current`（下面那条
    // not.toMatch 钉住「不许直接读会漂移的 state」）。
    const saved = /if \(outcome\.kind === "saved"\) \{[\s\S]*?savedMode\.current = mode;[\s\S]*?setFlash\(outcome\.flash\);/.exec(
      quick,
    );
    expect(saved, "saved 分支里要在 flash 之前记下保存当刻的档位").not.toBeNull();
    expect(quick).not.toMatch(/hintEntryFor\(mode,/);
  });

  it("云端不可用：提示块补那一句，并且不画入口", () => {
    expect(hintBlock).toContain("NO_LOCAL_MODEL_HINT_CLOUD_MISSING");
    expect(hintBlock).toContain("!cloudSendAvailable(availability)");
    // 追加的那句只在「知情且不通」时出现：availability 为 null 时两者都不渲染。
    expect(hintBlock).toContain("availability !== null");
    const cloudMissingAt = hintBlock.indexOf("NO_LOCAL_MODEL_HINT_CLOUD_MISSING");
    const entryAt = hintBlock.indexOf("entry !== null");
    expect(cloudMissingAt).toBeLessThan(entryAt);
    expect(source("noLocalModelHint.ts")).toContain(`"${NO_LOCAL_MODEL_HINT_CLOUD_MISSING}"`);
    expect(codeOnly(quick), "页面里不该另抄一份那句文案").not.toContain("云端通道还没配置");
  });

  it("Props 增 onOpenRecord(recordId)，App 接到 setSelectedId + 切 records 页", () => {
    expect(quick).toMatch(/onOpenRecord:\s*\(recordId: string\) => void/);
    const branch = /<QuickPanel[\s\S]*?\/>/.exec(app)?.[0] ?? "";
    expect(branch, "App 的 QuickPanel 分支要被断言到").not.toBe("");
    expect(branch).toContain("onOpenRecord");
    expect(branch).toMatch(/setSelectedId\(recordId\)/);
    expect(branch).toMatch(/setView\("records"\)/);
    expect(branch).toContain('setView("ingest")');
    expect(branch).toContain("onSaved={refreshBadges}");
  });
});
