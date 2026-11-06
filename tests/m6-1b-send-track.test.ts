import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  AXES_BY_PROCESSING_MODE,
  axesForProcessingMode,
  isProcessingModeValue,
  type ProcessingModeValue,
  type ThreeAxes,
} from "../src/shared/contracts/enums.ts";
import {
  RAW_TRACK_REVIEW_NOTE,
  SCOPE_ONLY_THIS_RECORD,
  SEND_TRACK_LABEL,
  SEND_TRACK_MODE,
  SEND_TRACK_RAW_COPY,
  SEND_TRACK_REDACTED_COPY,
  SEND_TRACKS,
  modeForTrack,
  trackOfAxes,
  trackOfMode,
  trackSwitchedNotice,
  type SendTrack,
} from "../src/web/sendTrack.ts";
import { tierSwitchedNotice } from "../src/web/redactionTier.ts";
import { INGEST_STAGE_ACTION, ingestStageOf, stagePrimaryEnabled } from "../src/web/ingestStage.ts";

/**
 * M6-1B「发送面板的两轨（脱敏 / 原文）前端」专项验收。
 *
 * 契约（阶段 1 准则 §二 Q1 裁定 + §四 M6-1B 的七条必过断言）：
 *   1. 默认态跟随设置里的 `record_default_mode`；
 *   2. 切到原文之后，「查看实际待发送文本 → 确认本次发送内容 → 二次点击」这条链一个字不少；
 *   3. 未确认就点发送 ⇒ 零请求（K-17：模式 ≠ 授权 ≠ 已解析）；
 *   4. 两轨风险文案不同，各自说清「这一次发出去的是什么」，且字面量只住在导出常量里；
 *   5. 作用范围：换轨只写记录轴，不动全局默认；
 *   6. （S6 起）写入页不再让用户顺带改默认值：作用范围固定为「仅这一条」；
 *   7. 编辑不重置：档位取记录轴，不取 `processingDefaults`；入口常驻。
 *
 * 〔web-redesign 第三步 / S5–S8 有意变动〕两轨单选与脱敏方式从操作框内联搬到
 * `ui/SendMethodDialog.tsx`（整层弹窗），确认链收进 `ConfirmDialog`；操作框里只剩
 * 「阶段名 → 发什么 → 怎么发 → 一个动作」四行。判据没有放宽：换轨仍只写记录轴、
 * 确认仍需真预览真授权、默认值仍不被单条操作改动——只是宿主换了，断言跟着落到新宿主上。
 *
 * vitest 是 node 环境（没有 DOM），沿用本仓 UI 测试的三条路子：
 * - 判据与文案：直接 import `sendTrack.ts`（那正是它不依赖 React 的理由）；
 * - 渲染位置、二次确认链、入口常驻：源码结构断言（与 `m5-3`、`m6-1c` 同法）；
 * - 换轨 / 换档 / 确认：把 `IngestPanel.tsx` 里那几个回调**抠出来真跑**，接到一份按
 *   `axesForProcessingMode` 派生的假后端上（与 `fakeApi.ts` 同一套派生口径）。
 *   编译给 `new Function` 的只有本仓自己这份源码里的片段（正则取不到就当场断言失败），
 *   不含任何外部输入——这一层是「同一份判据真跑一遍」的手段，不是第二份实现。
 */

const WEB = join(process.cwd(), "src", "web");

function source(rel: string): string {
  return readFileSync(join(WEB, rel), "utf8");
}

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** 把折叠段（DisclosureNote / TechnicalDetails）换成占位符：剩下的才是主可见区。 */
function withoutFold(text: string): string {
  let out = text;
  const segments = [
    ...[...out.matchAll(/<DisclosureNote[\s\S]*?<\/DisclosureNote>/g)].map((m) => m[0]),
    ...[...out.matchAll(/<TechnicalDetails[\s\S]*?\/>/g)].map((m) => m[0]),
  ];
  for (const segment of segments) out = out.replace(segment, "«折叠»");
  return out;
}

/** 主界面直接可见的那一份源码（注释与折叠段都剥掉）——与 m5-3 的 visibleCopy 同一口径。 */
function visibleWithoutFold(rel: string): string {
  return withoutFold(stripComments(source(rel)));
}

const RAW_AXES: ThreeAxes = AXES_BY_PROCESSING_MODE.cloud_raw;
const REDACTED_AXES: ThreeAxes = AXES_BY_PROCESSING_MODE.cloud_redacted;

/* ══════════════════════════════════════════════════════════════════
 * A. 判据（sendTrack.ts 纯函数）
 * ══════════════════════════════════════════════════════════════════ */

describe("M6-1B · 轨道判据：一轨一档，取自记录轴", () => {
  it("两档都在册，顺序是「脱敏 在前、原文 在后」，标签各一个", () => {
    expect([...SEND_TRACKS]).toEqual(["redacted", "raw"]);
    expect(SEND_TRACK_LABEL.redacted).toBe("脱敏");
    expect(SEND_TRACK_LABEL.raw).toBe("原文");
    expect(SEND_TRACK_LABEL.redacted).not.toBe(SEND_TRACK_LABEL.raw);
  });

  it("轨道 ↔ 档位一一对应，且轴取值全部来自 enums 的派生表（这里不另抄一份）", () => {
    for (const track of SEND_TRACKS) {
      const mode = modeForTrack(track) as ProcessingModeValue;
      expect(isProcessingModeValue(mode), `档位 ${mode} 不在册`).toBe(true);
      expect(trackOfMode(mode)).toBe(track);
      expect(trackOfAxes(axesForProcessingMode(mode))).toBe(track);
    }
    expect(modeForTrack("redacted")).toBe(SEND_TRACK_MODE.redacted);
    expect(modeForTrack("raw")).toBe(SEND_TRACK_MODE.raw);
  });

  it("读的是 send_content_mode：redacted/raw 两条轴各自命中，不靠 processing_mode 字面量", () => {
    expect(trackOfAxes(REDACTED_AXES)).toBe("redacted");
    expect(trackOfAxes(RAW_AXES)).toBe("raw");
    expect(trackOfAxes(REDACTED_AXES)).not.toBe(trackOfAxes(RAW_AXES));
  });

  it("非外发轴（send_content_mode=none）按脱敏处理，并在源码里写明理由", () => {
    expect(trackOfAxes(AXES_BY_PROCESSING_MODE.manual_only)).toBe("redacted");
    expect(trackOfAxes(AXES_BY_PROCESSING_MODE.local_model)).toBe("redacted");
    expect(source("sendTrack.ts")).toContain("虚报");
  });

  it("不在册的档位字符串 ⇒ 同一条保守取向（判成脱敏，不对着一个不发送的载荷宣布原文风险）", () => {
    for (const mode of ["", "cloud", "CLOUD_RAW", "who_knows"]) {
      expect(trackOfMode(mode), `档位「${mode}」`).toBe("redacted");
    }
  });
});

describe("M6-1B · 默认态跟随设置（断言 1）", () => {
  /** 新记录的初值来自设置里的 record_default_mode：那一档派生出哪条轴，就落在哪一轨。 */
  function trackOfNewRecord(recordDefaultMode: string): SendTrack {
    return trackOfAxes(axesForProcessingMode(recordDefaultMode as ProcessingModeValue));
  }

  it("record_default_mode=cloud_redacted ⇒ 新记录初值是脱敏轨", () => {
    expect(trackOfNewRecord("cloud_redacted")).toBe("redacted");
  });

  it("record_default_mode=cloud_raw ⇒ 新记录初值是原文轨", () => {
    expect(trackOfNewRecord("cloud_raw")).toBe("raw");
  });

  it("非外发的默认档 ⇒ 落脱敏轨（发送面板那一刻根本不渲染，保守的一侧）", () => {
    for (const mode of ["manual_only", "local_model"]) {
      expect(trackOfNewRecord(mode), `默认 ${mode}`).toBe("redacted");
    }
  });

  it("单条覆盖永不自动改全局：换轨只写记录轴，不动 record_default_mode", async () => {
    const backend = makeBackend({ mode: "cloud_redacted", recordDefaultMode: "cloud_redacted" });
    await runMethodHandler("onSetTrack", "raw", backend.ctx);
    expect(backend.defaults.recordDefaultMode).toBe("cloud_redacted");
    expect(backend.record.axes.sendContentMode).toBe("raw");
    expect(backend.calls.filter((call) => call.startsWith("updateProcessingDefaults"))).toEqual([]);
    // 下一条新记录仍然按设置起飞，而不是跟着刚被改成原文的那一条走。
    expect(trackOfAxes(axesForProcessingMode(backend.defaults.recordDefaultMode as ProcessingModeValue))).toBe(
      "redacted",
    );
  });
});

/* ══════════════════════════════════════════════════════════════════
 * B. 作用范围（仅这一条）
 * ══════════════════════════════════════════════════════════════════ */

describe("M6-1B · 作用范围固定为「仅这一条」（断言 5、6）", () => {
  it("切换处固定声明「仅这一条」，并说清这条记录以后都按它发送", () => {
    expect(SCOPE_ONLY_THIS_RECORD).toContain("仅这一条");
    expect(SCOPE_ONLY_THIS_RECORD).toContain("这条记录以后都按它发送");
    expect(source("ui/SendMethodDialog.tsx")).toContain("{SCOPE_ONLY_THIS_RECORD}");
  });

  it("S6 起不再有「以后新建的记录也用这一档」的顺带勾选：写在选择旁会变成第二个决定", () => {
    // 这一条留成反证：旧复选框的回滚逻辑没有在别处留下半截实现。
    const dialog = source("ui/SendMethodDialog.tsx");
    expect(dialog).not.toContain('type="checkbox"');
    expect(dialog).not.toContain("以后新建的记录也用");
    const track = source("sendTrack.ts");
    for (const dead of ["defaultCheckboxLabel", "scopeCheckboxVisible", "DEFAULT_APPLIED_NOTICE"]) {
      expect(track, `${dead} 已随复选框一起退场`).not.toContain(dead);
    }
  });
});

/* ══════════════════════════════════════════════════════════════════
 * C. 两轨风险文案（断言 4）
 * ══════════════════════════════════════════════════════════════════ */

describe("M6-1B · 两轨风险文案各自说清这一次发出去的是什么", () => {
  it("两句不同，且各含本轨的那一半事实", () => {
    expect(SEND_TRACK_RAW_COPY).not.toBe(SEND_TRACK_REDACTED_COPY);
    expect(SEND_TRACK_RAW_COPY).toContain("原文");
    expect(SEND_TRACK_RAW_COPY).toContain("不做任何脱敏");
    expect(SEND_TRACK_RAW_COPY).toContain("完整离开本机");
    expect(SEND_TRACK_REDACTED_COPY).toContain("脱敏后的文本");
    expect(SEND_TRACK_REDACTED_COPY).toContain("只留在本机");
  });

  it("都以「这一次发出去的是」开头：说的是这一次，不是全局策略", () => {
    for (const copy of [SEND_TRACK_RAW_COPY, SEND_TRACK_REDACTED_COPY]) {
      expect(copy.startsWith("这一次发出去的是")).toBe(true);
    }
  });

  it("原文那句不谎称遮过，脱敏那句不谎称发的是原文", () => {
    expect(SEND_TRACK_RAW_COPY).not.toMatch(/遮|占位符|脱敏后的/);
    expect(SEND_TRACK_REDACTED_COPY).not.toMatch(/完整离开本机|不做任何脱敏/);
    // 原文轨在遮蔽清单里的声明同样不能暗示有对照表。
    expect(RAW_TRACK_REVIEW_NOTE).not.toMatch(/占位符|对照表/);
    expect(RAW_TRACK_REVIEW_NOTE).toContain("原文");
  });

  it("措辞克制：不恐吓，也不淡化", () => {
    for (const copy of [SEND_TRACK_RAW_COPY, SEND_TRACK_REDACTED_COPY, RAW_TRACK_REVIEW_NOTE]) {
      for (const banned of ["请放心", "绝对安全", "不会离开本机", "匿名化"]) {
        expect(copy, `出现了「${banned}」`).not.toContain(banned);
      }
    }
  });

  it('换轨提示说清「重新预览并逐次确认」，且不出现「已切换」这种不带后续的句子', () => {
    for (const track of SEND_TRACKS) {
      const notice = trackSwitchedNotice(track);
      expect(notice).toContain("重新预览");
      expect(notice).toContain("逐次确认");
      expect(notice).not.toContain("已切换");
      expect(notice).toContain(SEND_TRACK_LABEL[track]);
    }
  });

  it("文案只住在 sendTrack.ts：弹窗引常量，页面里不出现这几句字面量", () => {
    const dialog = visibleWithoutFold("ui/SendMethodDialog.tsx");
    const imports = /import \{[\s\S]*?\} from "\.\.\/sendTrack\.ts";/.exec(source("ui/SendMethodDialog.tsx"))?.[0] ?? "";
    expect(imports, "sendTrack 的 import 段要被断言到").not.toBe("");
    const body = dialog.replace(imports, "");
    for (const copy of [SEND_TRACK_RAW_COPY, SEND_TRACK_REDACTED_COPY, SCOPE_ONLY_THIS_RECORD]) {
      expect(body, `弹窗里另抄了一份「${copy}」`).not.toContain(copy);
    }
    expect(body).toContain("SEND_TRACK_RAW_COPY");
    expect(body).toContain("SEND_TRACK_REDACTED_COPY");
    // 一份文案在模块里只能出现一次（两处措辞不许漂移成两个真相）；注释里引述那句不算第二处。
    const mod = stripComments(source("sendTrack.ts"));
    expect([...mod.matchAll(/这一次发出去的是原文/g)]).toHaveLength(1);
    expect([...mod.matchAll(/这一次发出去的是脱敏后的文本/g)]).toHaveLength(1);
  });
});

/* ══════════════════════════════════════════════════════════════════
 * D. 假后端 + 抠出来真跑的回调（断言 2、3、5、7 的执行面）
 * ══════════════════════════════════════════════════════════════════ */

const INGEST = source("IngestPanel.tsx");

interface BackendOptions {
  readonly mode: string;
  readonly recordDefaultMode: string;
  readonly sleepDefaultMode?: string;
}

interface Backend {
  readonly record: { recordId: string; processingMode: string; axes: ThreeAxes; currentRevisionId: string };
  readonly defaults: { recordDefaultMode: string; sleepDefaultMode: string; rememberLastMode: boolean };
  readonly calls: string[];
  readonly state: {
    preview: Record<string, unknown> | null;
    grant: unknown;
    confirmOpen: boolean;
    /** 〔M11-B D-4〕脱敏核对弹窗的开合：确认并整理成功后必须一起收起。 */
    reviewOpen: boolean;
    outcome: string | null;
    /** 〔M11-B D-9〕本次停留期间「刚整理成功」的集合。 */
    completed: Map<string, { title: string; message: string }>;
  };
  /** 喂给抠出来的回调的环境：键与回调体里的自由变量一一对应，少一个当场抛。 */
  readonly ctx: Record<string, unknown>;
  /** 同一份假后端，按方法直接调（给上面那些「先摆现场」的步骤用）。 */
  readonly api: {
    ingestPreview: (body: { recordId: string }) => Promise<Record<string, unknown>>;
    ingestConfirmSend: (body: { recordId: string }) => Promise<Record<string, unknown>>;
  };
  /** 待整理列表里这一条的读数：轴直接取记录在册的那一份（与 fakeApi / op1 同口径）。 */
  pendingAxes(): ThreeAxes;
  /** 编辑产生新版本：只换 current_revision_id，档位与轴一个字都不动（fakeApi.editRecord 同形）。 */
  editNewRevision(text: string): void;
}

/**
 * 一份按 `axesForProcessingMode` 派生的假后端：写轴 ⇒ 三轴跟着换、旧授权不再命中。
 * 逻辑与 `fakeApi.ts` 的 setMode / setRecordRedactionMode 同源，DTO 形状一字不增。
 */
function makeBackend(options: BackendOptions): Backend {
  const record = {
    recordId: "rec_demo_1",
    processingMode: options.mode,
    axes: axesForProcessingMode(options.mode as ProcessingModeValue),
    currentRevisionId: "rev_1",
  };
  const defaults = {
    recordDefaultMode: options.recordDefaultMode,
    sleepDefaultMode: options.sleepDefaultMode ?? "local_model",
    rememberLastMode: false,
  };
  const calls: string[] = [];
  const state: Backend["state"] = {
    preview: null,
    grant: null,
    confirmOpen: false,
    reviewOpen: false,
    outcome: null,
    completed: new Map(),
  };
  let grantSendContentMode: string | null = null;
  let revisionCounter = 1;

  const api = {
    setRecordMode: async (id: string, mode: string): Promise<unknown> => {
      calls.push(`setRecordMode:${id}:${mode}`);
      if (!isProcessingModeValue(mode)) throw new Error(`假后端：档位不在册（${mode}）`);
      record.processingMode = mode;
      record.axes = axesForProcessingMode(mode);
      return { record, changed: true };
    },
    setRecordRedactionMode: async (id: string, mode: string): Promise<unknown> => {
      calls.push(`setRecordRedactionMode:${id}:${mode}`);
      record.processingMode = "cloud_redacted";
      record.axes = { ...axesForProcessingMode("cloud_redacted"), redactionMode: mode as ThreeAxes["redactionMode"] };
      return { record, changed: true };
    },
    updateProcessingDefaults: async (body: Record<string, unknown>): Promise<unknown> => {
      calls.push(`updateProcessingDefaults:${JSON.stringify(body)}`);
      Object.assign(defaults, body);
      return defaults;
    },
    ingestPreview: async (body: { recordId: string }): Promise<unknown> => {
      calls.push(`ingestPreview:${body.recordId}`);
      const raw = record.axes.sendContentMode === "raw";
      return {
        recordId: record.recordId,
        recordRevisionId: record.currentRevisionId,
        revisionNumber: revisionCounter,
        policyVersion: raw ? "raw-v1" : "rules-v1",
        sendContentMode: record.axes.sendContentMode,
        redactedText: "…",
        payloadText: raw ? "原文载荷" : "⟦占位符⟧ 载荷",
        payloadSha256: `${record.currentRevisionId}-${record.axes.sendContentMode}`,
        // 授权四元组绑 send_content_mode：换轨之后这一格必然回到 false（0D §四）。
        hasApplicableGrant: grantSendContentMode === record.axes.sendContentMode,
        candidates: [],
      };
    },
    ingestConfirmSend: async (body: { recordId: string }): Promise<unknown> => {
      calls.push(`ingestConfirmSend:${body.recordId}`);
      const preview = state.preview as { payloadSha256: string; recordRevisionId: string } | null;
      if (preview === null) throw new Error("假后端：没有预览就不该签发授权（K-17）");
      grantSendContentMode = record.axes.sendContentMode;
      return {
        grantId: `grant_${preview.payloadSha256}`,
        recordRevisionId: preview.recordRevisionId,
        payloadSha256: preview.payloadSha256,
        policyVersion: record.axes.sendContentMode === "raw" ? "raw-v1" : "rules-v1",
        confirmedAtUtc: "2026-10-27T00:00:00Z",
      };
    },
    ingestParse: async (body: { recordId: string }): Promise<unknown> => {
      calls.push(`ingestParse:${body.recordId}`);
      return {
        succeeded: true,
        replayed: false,
        autoAdopted: false,
        writes: { episodes: 1, thoughts: 0, mentions: 1, rejectedMentions: 0 },
        failure: null,
      };
    },
  };

  const reload = async (): Promise<void> => {
    calls.push("reload");
  };
  const props = { onBadgesChanged: () => calls.push("onBadgesChanged"), onSelect: () => undefined };

  return {
    record,
    defaults,
    calls,
    state,
    api: {
      ingestPreview: (body) => api.ingestPreview(body) as Promise<Record<string, unknown>>,
      ingestConfirmSend: (body) => api.ingestConfirmSend(body) as Promise<Record<string, unknown>>,
    },
    ctx: {
      api,
      props,
      reload,
      selected: record,
      modeForTrack,
      trackSwitchedNotice,
      tierSwitchedNotice,
      confirmSendGrant: (recordId: string): Promise<unknown> => api.ingestConfirmSend({ recordId }),
      setPreview: (value: unknown) => {
        state.preview =
          typeof value === "function"
            ? (value as (prev: Record<string, unknown> | null) => Record<string, unknown> | null)(state.preview)
            : (value as Record<string, unknown> | null);
      },
      setGrant: (value: unknown) => {
        state.grant = value;
      },
      setConfirmOpen: (value: boolean) => {
        state.confirmOpen = value;
      },
      setReviewOpen: (value: boolean) => {
        state.reviewOpen = value;
      },
      setOutcome: (value: string | null) => {
        state.outcome = value;
      },
      // markCompleted 读的是收件箱行（取标题）与那份本地完成集合（D-9）。
      inboxRows: [{ recordId: record.recordId, title: "演示记录" }],
      setCompleted: (value: unknown) => {
        state.completed = (value as (prev: Map<string, { title: string; message: string }>) => Map<string, { title: string; message: string }>)(
          state.completed,
        );
      },
    },
    pendingAxes: () => ({ ...record.axes }),
    editNewRevision: (text: string) => {
      revisionCounter += 1;
      record.currentRevisionId = `rev_${revisionCounter}_${text.length}`;
    },
  };
}

/** 取 `<SendMethodDialog … />` 那次调用（换轨 / 换档回调都写在这里）。 */
function methodCallSite(): string {
  const block = /<SendMethodDialog\b[\s\S]*?\n\s*\/>/.exec(INGEST)?.[0] ?? "";
  expect(block, "<SendMethodDialog 调用点要被断言到").not.toBe("");
  return block;
}

/** 取 `<ConfirmDialog …>…</ConfirmDialog>` 那次调用（确认 + 整理合并的那一处）。 */
function confirmCallSite(): string {
  const block = /<ConfirmDialog\b[\s\S]*?<\/ConfirmDialog>/.exec(INGEST)?.[0] ?? "";
  expect(block, "<ConfirmDialog 调用点要被断言到").not.toBe("");
  return block;
}

/**
 * 把面板交给弹窗的回调抠出来真跑：`onX={(arg) => void action(async () => { … })}`
 * 取的是 `action` 里那一段——它与页面上执行的是同一段源码，不是一份重写。
 */
function runMethodHandler(name: string, arg: unknown, ctx: Record<string, unknown>): Promise<void> {
  const re = new RegExp(
    `${name}=\\{\\s*\\(\\s*(\\w*)\\s*\\)\\s*=>\\s*void action\\(async \\(\\) => \\{([\\s\\S]*?)\\n\\s*\\}\\)\\s*\\n?\\s*\\}`,
  );
  const match = re.exec(methodCallSite());
  expect(match, `${name} 回调要被断言到`).not.toBeNull();
  const paramName = match?.[1] ?? "";
  const body = match?.[2] ?? "";
  const names = [
    "api",
    "props",
    "reload",
    "selected",
    "modeForTrack",
    "trackSwitchedNotice",
    "tierSwitchedNotice",
    "setPreview",
    "setGrant",
    "setConfirmOpen",
    "setOutcome",
  ];
  for (const local of names) {
    expect(Object.hasOwn(ctx, local), `假后端缺少 ${local}`).toBe(true);
  }
  const built = new Function(...names, `return async (${paramName}) => {${body}};`);
  return built(...names.map((local) => ctx[local]))(arg) as Promise<void>;
}

/**
 * 取 `IngestPanel` 函数体里那一层（两格缩进）的具名函数源码，含声明与闭合。
 *
 * 只重写第一行：`new Function` 认 JS，不认 TS 的参数标注与返回类型，所以把
 * `function f(a: string, b: number): Promise<void> {` 收成 `function f(a, b) {`。
 * 函数体一个字都不动——真在里面留下了编译不了的标注，`new Function` 会当场抛，
 * 而不是静默跳过一个没在跑的分支。
 */
function panelFunctionSource(name: string): string {
  const lines = INGEST.split("\n");
  const start = lines.findIndex((line) => new RegExp(`^  (?:async )?function ${name}\\(`).test(line));
  expect(start, `源码里要能找到 ${name}()`).toBeGreaterThanOrEqual(0);
  let end = start + 1;
  while (end < lines.length && lines[end] !== "  }") end += 1;
  expect(end, `${name}() 的函数体没有被闭合`).toBeLessThan(lines.length);
  const declaration = lines[start] ?? "";
  const isAsync = /^\s*async\s/.test(declaration);
  const params = (/\(([^)]*)\)/.exec(declaration)?.[1] ?? "")
    .split(",")
    .map((param) => (param.trim().split(":")[0] ?? "").trim())
    .filter((param) => param !== "")
    .join(", ");
  const head = `  ${isAsync ? "async " : ""}function ${name}(${params}) {`;
  return [head, ...lines.slice(start + 1, end + 1)].join("\n");
}

/**
 * 把确认链抠出来真跑：签发授权 → 立即整理（S4 合并后的唯一确认通道）。
 *
 * 〔M11-B D-6〕这一对动作从 `onConfirm` 的内联体抽成了唯一的 `confirmAndOrganize(recordId)`
 * （框外的确认框与脱敏核对弹窗里那颗「确认整理」共用它）。harness 因此改成两段都钉：
 * 调用点逐字接那一处函数，函数体连同它依赖的 `organizeMessage` / `markCompleted` 一起从源码编译
 * 真跑——跑的还是页面上执行的那几行，不是一份重写。找不到就抛，不静默跳过。
 */
function runConfirmHandler(ctx: Record<string, unknown>): Promise<void> {
  const site = confirmCallSite();
  expect(site).toMatch(
    /onConfirm=\{\(\)\s*=>\s*void action\(\(\) => confirmAndOrganize\(selected\.recordId\)\)\}/,
  );
  const body = ["organizeMessage", "markCompleted", "confirmAndOrganize"].map(panelFunctionSource).join("\n");
  const names = [
    "api",
    "props",
    "reload",
    "selected",
    "confirmSendGrant",
    "setPreview",
    "setGrant",
    "setConfirmOpen",
    "setReviewOpen",
    "setOutcome",
    "inboxRows",
    "setCompleted",
  ];
  for (const local of names) {
    expect(Object.hasOwn(ctx, local), `假后端缺少 ${local}`).toBe(true);
  }
  const built = new Function(...names, `${body}\nreturn confirmAndOrganize;`);
  const run = built(...names.map((local) => ctx[local])) as (recordId: string) => Promise<void>;
  return run((ctx.selected as { recordId: string }).recordId);
}

describe("M6-1B · 换轨真跑：作废旧预览与旧授权，只写记录轴（断言 2、5、7）", () => {
  it("切到原文：写的是 cloud_raw，preview/grant/confirmOpen 全部作废，提示要求重新预览逐次确认", async () => {
    const backend = makeBackend({ mode: "cloud_redacted", recordDefaultMode: "cloud_redacted" });
    // 先摆一份「已确认」的现场：换轨必须把它整个作废。
    backend.state.preview = await backend.api.ingestPreview({ recordId: backend.record.recordId });
    backend.state.grant = { grantId: "grant_old" };
    backend.state.confirmOpen = true;
    backend.calls.length = 0;

    await runMethodHandler("onSetTrack", "raw", backend.ctx);

    expect(backend.calls).toEqual(["setRecordMode:rec_demo_1:cloud_raw", "reload", "onBadgesChanged"]);
    expect(backend.state.preview).toBeNull();
    expect(backend.state.grant).toBeNull();
    expect(backend.state.confirmOpen).toBe(false);
    expect(backend.state.outcome).toBe(trackSwitchedNotice("raw"));
    expect(backend.pendingAxes()).toEqual(RAW_AXES);
  });

  it("换轨之后重取预览：那份预览属于原文轨，hasApplicableGrant 回到 false（旧授权不跨轨命中）", async () => {
    const backend = makeBackend({ mode: "cloud_redacted", recordDefaultMode: "cloud_redacted" });
    const api = backend.api;
    backend.state.preview = await api.ingestPreview({ recordId: backend.record.recordId });
    await api.ingestConfirmSend({ recordId: backend.record.recordId });

    await runMethodHandler("onSetTrack", "raw", backend.ctx);
    const previewAfter = (await api.ingestPreview({ recordId: backend.record.recordId })) as {
      hasApplicableGrant: boolean;
      sendContentMode: string;
      policyVersion: string;
    };
    expect(previewAfter.sendContentMode).toBe("raw");
    expect(previewAfter.policyVersion).toBe("raw-v1");
    expect(previewAfter.hasApplicableGrant).toBe(false);
  });

  it("换脱敏档同样只写记录那一列，并作废本次预览与授权（另一个字段，另一条通道）", async () => {
    const backend = makeBackend({ mode: "cloud_redacted", recordDefaultMode: "cloud_redacted" });
    backend.state.preview = { payloadSha256: "old" };
    backend.state.grant = { grantId: "grant_old" };
    backend.state.confirmOpen = true;
    backend.calls.length = 0;

    await runMethodHandler("onSetRedactionTier", "local_llm", backend.ctx);

    expect(backend.calls).toEqual([
      "setRecordRedactionMode:rec_demo_1:local_llm",
      "reload",
      "onBadgesChanged",
    ]);
    expect(backend.state.preview).toBeNull();
    expect(backend.state.grant).toBeNull();
    expect(backend.state.confirmOpen).toBe(false);
    expect(backend.state.outcome).toBe(tierSwitchedNotice("local_llm"));
    expect(backend.calls.filter((call) => call.startsWith("updateProcessingDefaults"))).toEqual([]);
  });

  it("编辑产生新版本 ⇒ 档位不重置：轨道读的是记录轴，与 revision 无关（断言 7）", async () => {
    const backend = makeBackend({ mode: "cloud_redacted", recordDefaultMode: "cloud_redacted" });
    await runMethodHandler("onSetTrack", "raw", backend.ctx);
    const revisionBefore = backend.record.currentRevisionId;
    backend.editNewRevision("改了个错别字");
    expect(backend.record.currentRevisionId).not.toBe(revisionBefore);
    expect(backend.pendingAxes()).toEqual(RAW_AXES);
    expect(trackOfAxes(backend.pendingAxes())).toBe("raw");
    expect(trackOfAxes(backend.pendingAxes())).not.toBe(
      trackOfAxes(axesForProcessingMode(backend.defaults.recordDefaultMode as ProcessingModeValue)),
    );
  });
});

/* ── 确认链：签发授权 → 立即整理（S4），失败即止 ─────────────────── */

describe("M6-1B · 确认链：先签发授权，再整理；签发失败不整理", () => {
  it("确认一次 = 一次 confirm-send + 一次 ingestParse，授权写回并把弹窗关掉", async () => {
    const backend = makeBackend({ mode: "cloud_redacted", recordDefaultMode: "cloud_redacted" });
    const api = backend.api;
    backend.state.preview = (await api.ingestPreview({ recordId: backend.record.recordId })) as Record<string, unknown>;
    backend.state.confirmOpen = true;
    backend.calls.length = 0;

    await runConfirmHandler(backend.ctx);

    expect(backend.calls).toEqual([
      "ingestConfirmSend:rec_demo_1",
      "ingestParse:rec_demo_1",
      "onBadgesChanged",
      "reload",
    ]);
    expect(backend.state.grant).not.toBeNull();
    expect(backend.state.preview?.hasApplicableGrant).toBe(true);
    expect(backend.state.confirmOpen).toBe(false);
    expect(backend.state.reviewOpen).toBe(false);
    // 〔M11-B D-6〕结果句统一出自 `organizeMessage`：弹窗那颗键与框外确认框说同一句话。
    expect(backend.state.outcome).toBe("已整理：写入 经历 1 · 念头 0 · 提及 1（被拒 0）；结果作为候选，等你采纳。");
    // 〔M11-B D-9〕整理成功当场记入本地「已完成」集合，停留本页时列表顶部与右侧完成卡都读它。
    expect(backend.state.completed.get("rec_demo_1")?.title).toBe("演示记录");
  });

  it("模式 ≠ 授权：没有预览就没有可签发的授权——假后端拒签，整理一次都没发生", async () => {
    const backend = makeBackend({ mode: "cloud_raw", recordDefaultMode: "cloud_redacted" });
    await expect(runConfirmHandler(backend.ctx)).rejects.toThrow("K-17");
    expect(backend.state.grant).toBeNull();
    expect(backend.calls.filter((call) => call.startsWith("ingestParse"))).toEqual([]);
  });

  it("确认框的两个键与标题按轨道分开：原文轨说的是「原文完整离开本机」", () => {
    const site = confirmCallSite();
    expect(site).toContain('title={track === "raw" ? "确认发送原文" : "确认本次发送内容"}');
    expect(site).toContain('confirmLabel={track === "raw" ? "确认原文并整理" : "确认并整理"}');
    expect(site).toContain('cancelLabel="再想想"');
    expect(site).toContain("原文完整离开本机");
    expect(site).toContain("不做任何脱敏");
  });
});

/* ══════════════════════════════════════════════════════════════════
 * E. K-17：未确认就点发送 ⇒ 零请求（阶段判据真跑）
 * ══════════════════════════════════════════════════════════════════ */

const PRIMARY_DISABLED_EXPR = /<button\s+className="btn primary"\s+disabled=\{([^}]+)\}/.exec(INGEST)?.[1];

function disabledOf(stage: ReturnType<typeof ingestStageOf>, busy = false): boolean {
  return busy || !stagePrimaryEnabled(stage);
}

describe("M6-1B · K-17：未确认就点发送 ⇒ 零请求", () => {
  it("外发轨 + 没有预览 ⇒ loading ⇒ 主按键按不动（那一格没有可点的动作）", () => {
    const stage = ingestStageOf({
      parseReady: true,
      cloud: true,
      hasPreview: false,
      hasGrant: false,
      jobActive: false,
      lastFailed: false,
    });
    expect(stage).toBe("loading");
    expect(disabledOf(stage)).toBe(true);
    expect(INGEST_STAGE_ACTION.loading).toBe("发起整理");
    expect(PRIMARY_DISABLED_EXPR?.trim()).toBe("busy || !stagePrimaryEnabled(stage)");
  });

  it("预览有但没授权 ⇒ needs-grant：按键可点，但它只开确认框，不发任何请求", () => {
    const stage = ingestStageOf({
      parseReady: true,
      cloud: true,
      hasPreview: true,
      hasGrant: false,
      jobActive: false,
      lastFailed: false,
    });
    expect(stage).toBe("needs-grant");
    expect(disabledOf(stage)).toBe(false);
    // runPrimary 在 needs-grant 这一支只 setConfirmOpen(true) 然后 return——没有 api 调用。
    const branch =
      /if \(stage === "needs-grant"\) \{\s*\n\s*setConfirmOpen\(true\);\s*\n\s*return;\s*\n\s*\}/.exec(INGEST)?.[0] ?? "";
    expect(branch, "needs-grant 分支要被断言到").not.toBe("");
    expect(branch).not.toMatch(/\bapi\./);
  });

  it("授权就位 ⇒ ready：同一判据放行，整理走唯一那一条 ingestParse", () => {
    const stage = ingestStageOf({
      parseReady: true,
      cloud: true,
      hasPreview: true,
      hasGrant: true,
      jobActive: false,
      lastFailed: false,
    });
    expect(stage).toBe("ready");
    expect(disabledOf(stage)).toBe(false);
    expect(INGEST).toMatch(/async function organizeNow\(\)[\s\S]*?api\.ingestParse\(\{ recordId: current\.recordId \}\)/);
  });

  it("非外发记录不受这道门约束：没有预览也是 ready", () => {
    const stage = ingestStageOf({
      parseReady: true,
      cloud: false,
      hasPreview: false,
      hasGrant: false,
      jobActive: false,
      lastFailed: false,
    });
    expect(stage).toBe("ready");
    expect(disabledOf(stage)).toBe(false);
  });
});

/* ══════════════════════════════════════════════════════════════════
 * F. 渲染位置（源码结构面，断言 2）
 * ══════════════════════════════════════════════════════════════════ */

describe("M6-1B · 两轨切换的渲染位置（源码结构面）", () => {
  const gate = /function CloudGate[\s\S]*?\n}/.exec(INGEST)?.[0] ?? "";
  const method = source("ui/SendMethodDialog.tsx");

  it("操作框里不再摆控件：CloudGate 只画「发什么 / 怎么发」两行入口", () => {
    expect(gate, "CloudGate 本体要被断言到").not.toBe("");
    expect(gate).not.toContain('type="radio"');
    expect(gate).not.toContain('type="checkbox"');
    expect(gate).not.toContain("onSetTrack");
    expect(gate).toContain("props.onOpenReview");
    expect(gate).toContain("props.onOpenMethod");
  });

  it("两档单选在「发送方式」弹窗里：一个模板 × SEND_TRACKS，选中态来自记录轴派生的那一轨", () => {
    expect([...method.matchAll(/type="radio"/g)]).toHaveLength(2);
    expect(method).toContain("SEND_TRACKS.map");
    expect(method).toContain("checked={props.track === option}");
    expect(method).toContain("props.onSetTrack(option)");
    expect(method).toContain('name="send-track"');
    expect(method).toContain("{SEND_TRACK_LABEL[option]}");
    // radio 只按忙碌态禁用——可用性永远不是折叠这两档的理由（2026-10-25 已拍）。
    expect(method).toContain("disabled={props.busy}");
  });

  it("弹窗只在「有预览、用户点了发送方式」时出现：没有预览就不画一份旧指纹", () => {
    expect(INGEST).toMatch(/\{methodOpen && preview !== null && \(\s*<SendMethodDialog/);
    expect(method).toMatch(/\{props\.preview !== null && \(\s*<TechnicalDetails/);
  });

  it("风险文案按轨道二选一，且住在主可见区（不在任何折叠段里）", () => {
    const visible = withoutFold(stripComments(method));
    const warnAt = visible.indexOf('{props.track === "raw" ? SEND_TRACK_RAW_COPY : SEND_TRACK_REDACTED_COPY}');
    expect(warnAt, "两轨风险文案的渲染点要被断言到").toBeGreaterThan(-1);
    const foldAt = visible.indexOf("«折叠»");
    expect(foldAt, "弹窗里那处技术详情在风险文案之后").toBeGreaterThan(warnAt);
  });

  it("作用范围声明紧跟切换处：复选框已退场，只剩「仅这一条」这一句", () => {
    const scopeAt = method.indexOf("SCOPE_ONLY_THIS_RECORD");
    const copyAt = method.indexOf("SEND_TRACK_RAW_COPY");
    expect(scopeAt).toBeGreaterThan(-1);
    expect(copyAt).toBeGreaterThan(scopeAt);
  });

  it("档位取记录轴，不取 processingDefaults（断言 7 的源码面）", () => {
    // 面板先把「这一条的轴」派生成 track，再原样交给两处弹窗；不读 config 里的默认值。
    expect(INGEST).toContain('const track = selected === null ? ("redacted" as SendTrack) : trackOfAxes(selected.axes);');
    expect(INGEST).toContain("track={track}");
    expect(INGEST).toContain("recordRedactionMode={selected.axes.redactionMode}");
    expect(INGEST).not.toMatch(/trackOfAxes\(config|trackOfAxes\(recordDefaultMode/);
    expect(INGEST).not.toMatch(/trackOfMode\(recordDefaultMode/);
    // 三轴映射只有一处：面板里对 send_content_mode 只有「拼预览键时原样读一格」，
    // 没有任何第二个**分支**（轨道判据只经 `trackOfAxes`）。
    const modeReads = [...stripComments(INGEST).matchAll(/sendContentMode/g)];
    expect(modeReads).toHaveLength(1);
    expect(stripComments(INGEST)).toContain("selected.axes.sendContentMode");
    expect([...stripComments(INGEST).matchAll(/"cloud_raw"|"cloud_redacted"/g)]).toHaveLength(0);
  });

  it("CloudGate 只在三轴外发时渲染，发送方式入口随之常驻（不额外加条件）", () => {
    expect(INGEST).toMatch(/\{egressSelected && \(\s*<CloudGate/);
    expect(INGEST).toMatch(/const egressSelected = selected !== null && isEgress\(selected\.axes\);/);
  });

  it("操作框四行：阶段名 → 实际发送文本 → 发送方式 → 一个动作；确认在独立弹窗", () => {
    // 头两行与动作行在框里（CloudGate 是两者之间那一块），所以按调用点排；
    // 「发什么」与「怎么发」在 CloudGate 内部，按它自己的返回顺序排。
    const headAt = INGEST.indexOf('className="ingest-stage"');
    const gateAt = INGEST.indexOf("<CloudGate");
    const actionsAt = INGEST.indexOf('className="actions ingest-actions"');
    expect(headAt).toBeGreaterThan(-1);
    expect(gateAt).toBeGreaterThan(headAt);
    expect(actionsAt).toBeGreaterThan(gateAt);

    const gate = /function CloudGate[\s\S]*?\n}/.exec(INGEST)?.[0] ?? "";
    expect(gate, "CloudGate 本体要被断言到").not.toBe("");
    const payloadAt = gate.indexOf("实际发送文本");
    const methodAt = gate.indexOf('className="ingest-method-link"');
    expect(payloadAt).toBeGreaterThan(-1);
    expect(methodAt).toBeGreaterThan(payloadAt);

    // 二次点击仍是一次显式确认：`confirmOpen` 只有 runPrimary 的 needs-grant 分支打开。
    expect([...INGEST.matchAll(/setConfirmOpen\(true\)/g)]).toHaveLength(1);
  });
});

/* ══════════════════════════════════════════════════════════════════
 * G. 既有通道与假后端（不新增接口 / DTO 字段）
 * ══════════════════════════════════════════════════════════════════ */

describe("M6-1B · 只经既有 api 通道，不新增 HTTP 接口", () => {
  const panel = stripComments(INGEST);

  it("IngestPanel 摸到的 api 方法集合封闭：换轨 / 换脱敏档 / 复核队列 / 词表各走既有那一条", () => {
    const used = [...new Set([...panel.matchAll(/\bapi\.(\w+)/g)].map((m) => m[1]!))].sort();
    expect(used).toEqual([
      "enqueueJob",
      // Phase D（S10）：预览里「这个词不脱敏」= 把实体移出词表，另一条 `.strict()` 路由。
      "entitySetMask",
      // 〔web-redesign 第三步〕确认弹窗要把「[person_1_ab12]」还原成原文那一段：
      // DTO 只给坐标（`originalStart/End`），原文得自己取。只读、本机读。
      "getRecord",
      "ingestConfig",
      "ingestConfirmSend",
      "ingestParse",
      "ingestPending",
      "ingestPreview",
      "listJobs",
      // M10-2（裁决 M10-D-3 的派生视图）：复核队列是**只读**投影，取数仍走面板那一层的 `api.`。
      "reviewQueue",
      // M9-4d-2（裁决 M9-D-15）：换脱敏档是**另一条**通道，不是 setRecordMode 的第二用法——
      // 「在哪分析、发什么」与「谁来做脱敏」是两个字段，服务端两条路由各自 `.strict()`。
      // 清单仍然封闭：再加一条 api 方法，这条断言就会红，逼着这里留一笔。
      "setRecordMode",
      "setRecordRedactionMode",
    ]);
    // S6 之后面板不再写全局默认：那条通道留给设置页。
    expect(panel).not.toContain("updateProcessingDefaults");
  });

  it("换轨走既有的 setRecordMode，参数形状不变", () => {
    expect(panel).toMatch(/api\.setRecordMode\(selected\.recordId, modeForTrack\(next\)\)/);
    expect(panel).toMatch(/api\.setRecordRedactionMode\(selected\.recordId, next\)/);
  });

  it("apiClient 与假后端都没有为这两轨新增端点：路径表里找不到 track 字样", () => {
    for (const rel of ["apiClient.ts", "fakeApi.ts"]) {
      const text = source(rel);
      expect(text, `${rel} 新增了 track 端点`).not.toMatch(/\/api\/[a-z/-]*track/i);
    }
  });

  it("fakeApi 已支持换轨后读到新轴：三轴由 processing_mode 现派生，列表与详情都读同一行", () => {
    const fake = source("fakeApi.ts");
    const setMode = /function setMode\(rec: FakeRecord, mode: string\): FakeReply \{[\s\S]*?\n}/.exec(fake)?.[0] ?? "";
    expect(setMode, "fakeApi 的 setMode 要被断言到").not.toBe("");
    expect(setMode).toContain("const axes = fakeAxesOf(mode);");
    for (const column of [
      "analysis_provider: axes.analysisProvider",
      "redaction_mode: axes.redactionMode",
      "send_content_mode: axes.sendContentMode",
    ]) {
      expect(setMode, `setMode 少写一列 ${column}`).toContain(column);
    }
    const pending = /function pendingBody\(url: URL\): FakeReply \{[\s\S]*?\n}/.exec(fake)?.[0] ?? "";
    expect(pending).toContain("sendContentMode: rec.row.send_content_mode");
    const detail = /function detailBody\(rec: FakeRecord\): unknown \{[\s\S]*?\n}/.exec(fake)?.[0] ?? "";
    expect(detail, "详情读的是 rec.row（同一行三轴）").toContain("record: rec.row");
    const edit = /function editRecord\(id: string, text: string\): FakeReply \{[\s\S]*?\n}/.exec(fake)?.[0] ?? "";
    expect(edit).toContain("rec.row = { ...rec.row, current_revision_id: revision.id };");
    expect(edit).not.toMatch(/processing_mode:|send_content_mode:/);
  });

  it("DTO 形状一字未动：PendingRecordDto 没多出轨道字段", async () => {
    const dto = readFileSync(join(process.cwd(), "src", "shared", "dto.ts"), "utf8");
    const pending = /export interface PendingRecordDto \{[\s\S]*?\n}/.exec(dto)?.[0] ?? "";
    expect(pending, "PendingRecordDto 要被断言到").not.toBe("");
    expect([...pending.matchAll(/^\s{2}readonly (\w+):/gm)].map((m) => m[1]!)).toEqual([
      "recordId",
      "currentRevisionId",
      "processingStatus",
      "processingMode",
      "axes",
      "privacyLevel",
      "createdLocalDate",
      "preview",
    ]);
    expect(pending).not.toMatch(/track/i);
    // 轨道这个概念只住前端展示层，不渗进契约。
    expect(dto).not.toMatch(/SendTrack|sendTrack/);
  });
});

describe("M6-1B-R · G-3：换轨之后「整理方式」行跟着刷新", () => {
  it("RecordDetail 的 key 同时含 recordId 与 processingMode ⇒ 档位一变就重挂", () => {
    const call = /<RecordDetail\b[\s\S]*?\/>/.exec(INGEST)?.[0] ?? "";
    expect(call, "RecordDetail 调用点要被断言到").not.toBe("");
    const key = /key=\{`([^`]*)`\}/.exec(call);
    // 只挂 id 的话换轨不重挂，那一行就停在旧档上——正是实测到的缺陷。
    expect(key, "RecordDetail 要挂上模板 key").not.toBeNull();
    const parts = [...(key?.[1] ?? "").matchAll(/\$\{([^}]*)\}/g)].map((m) => m[1]);
    expect(parts).toEqual(["selected.recordId", "selected.processingMode"]);
    expect(call).toContain("id={selected.recordId}");
  });

  it("重挂的代价（编辑中丢草稿）写在注释里：切轨是显式动作，重挂优先于保留草稿", () => {
    const comment = /\{\/\*([\s\S]*?)\*\/\}\s*<RecordDetail/.exec(INGEST);
    expect(comment, "RecordDetail 上方要有一段说明重挂取舍的注释").not.toBeNull();
    expect(comment?.[1]).toContain("草稿");
    expect(comment?.[1]).toContain("processingMode");
  });
});
