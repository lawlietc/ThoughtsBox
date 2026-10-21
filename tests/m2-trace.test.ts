import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { loadEnums } from "../src/shared/contracts/load.ts";
import {
  BUSINESS_RULES,
  BusinessValidationError,
  errorKindOf,
  parseStructuredOutput,
  validateBusiness,
  type StructuredOutput,
} from "../src/server/ingest/contract.ts";
import {
  ERROR_RETRYABILITY,
  PARSE_ERROR_KINDS,
  PROVIDER_CALL_PATHS,
  ProviderError,
  invokeExtraction,
  type ExtractionRequest,
  type ModelAdapter,
  type ParseErrorKind,
  type ProviderCallPath,
  type ProviderTransport,
  type TransportRequest,
  type TransportResponse,
} from "../src/server/ingest/provider.ts";
import {
  DebugExportConfirmationRequired,
  TRACE_ENTRY_FIELDS,
  TRACE_PHASES,
  TracePrivacyViolation,
  TraceSession,
  isTracePhase,
  serializeTrace,
  type BusinessValidationRecord,
  type DebugRawRecord,
  type PhaseTiming,
  type PrivacyGuards,
  type TraceEntry,
} from "../src/server/ingest/trace.ts";
import { redact, type KnownEntity } from "../src/server/privacy/redaction.ts";

/**
 * M2-4 Trace 面契约测试（D14）：字段面封闭、隐私纪律、调试原文模式的显式开关。
 *
 * 契约取值：指令 §11.1（Trace 要能定位什么）、§11.2（隐私纪律）、§11.3（错误处理）；
 * Spec §5.5（失败不丢原文、调试模式默认关闭且重启失效、导出需额外确认）、§11-隐私
 * （脱敏映射不进 Trace）；ADR-006 Consequences（降级路径要能记录错误类型、所走路径、
 * 最终是否通过校验）。
 *
 * 本任务的隐私门是**哨兵原文**：`SENTINEL-RAW-TEXT-9f3a` 灌进整条链路
 * （原文 → 发送载荷 → 模型回稿 → 业务校验失败 → Trace），断言它在
 * ① 调试开关关闭时、② 默认路径的序列化结果里都不出现。
 * 全部离线：模型调用由注入的假传输驱动，不发网络请求。
 */

const TRACE_SOURCE = "src/server/ingest/trace.ts";
const PROVIDER_SOURCE = "src/server/ingest/provider.ts";

const SENTINEL = "SENTINEL-RAW-TEXT-9f3a";
const API_KEY = "sk-live-should-never-reach-a-trace";
const NONCE = "a1b2c3";

/** 原文里就带哨兵；模型回稿的摘要也带哨兵——Trace 必须两面都接不住它。 */
const RAW_WITH_SENTINEL = `我和自己说：${SENTINEL}，那一刻很焦虑`;

/** 结构合法、业务合法的派生文本（summary 夹带哨兵，用于证明「没地方可填」）。 */
const MODEL_OUTPUT: StructuredOutput = {
  title: "一次自我对话",
  summary: `记录了一次自我对话，当事人写下：${SENTINEL}`,
  episodes: [],
  thoughts: [{ text: "先写下来再说", evidence: "那一刻很焦虑" }],
  emotions: [{ labelSaid: "焦虑", candidateConceptId: null, basis: "explicit", evidence: "那一刻很焦虑" }],
  topics: [],
  entities: [],
};

/** 结构合法、业务非法：依据是编造的，落败原因本身也不得进 Trace。 */
const MODEL_OUTPUT_BAD_EVIDENCE: StructuredOutput = {
  ...MODEL_OUTPUT,
  thoughts: [{ text: "编造的依据", evidence: `模型虚构的句子：${SENTINEL}` }],
};

const CLOUD_ENTITIES: readonly KnownEntity[] = [
  { entityId: "entity_zhang", entityType: "person", terms: ["张三"] },
];

const ADAPTER: ModelAdapter = {
  provider: "ollama",
  model: "qwen2.5:7b",
  baseUrl: "http://127.0.0.1:11434/v1",
  callPath: "ollama_openai_compatible",
  supportsStructuredOutput: false,
  requestTimeoutMs: 2000,
};

function makeRequest(payloadText: string, signal?: AbortSignal): ExtractionRequest {
  return {
    recordRevisionId: "rev_trace_fixture",
    processingMode: "local_model",
    payloadText,
    systemPrompt: "你是提取器，只输出 JSON。",
    promptVersion: "m2-prompt-v1",
    outputSchemaVersion: "m2-output-v1",
    contractsFingerprint: "0123456789abcdef".repeat(4),
    resolverVersion: "resolver-v1",
    validationVersion: "validation-v1",
    ...(signal === undefined ? {} : { signal }),
  };
}

function transportReturning(output: unknown): ProviderTransport {
  return {
    send: async () => ({
      status: 200,
      body: JSON.stringify({ choices: [{ message: { content: JSON.stringify(output) } }] }),
    }),
  };
}

const neverSettles: ProviderTransport = {
  send: (request: TransportRequest) =>
    new Promise<TransportResponse>((_resolve, reject) => {
      if (request.signal.aborted) reject(new Error("already aborted"));
      else request.signal.addEventListener("abort", () => reject(new Error("aborted")));
    }),
};

function capture(builder: () => unknown): Error | undefined {
  try {
    builder();
  } catch (cause) {
    return cause as Error;
  }
  return undefined;
}

function symmetricDiff(a: readonly string[], b: readonly string[]): string[] {
  const setB = new Set(b);
  const setA = new Set(a);
  return [...a.filter((x) => !setB.has(x)), ...b.filter((x) => !setA.has(x))];
}

/** 一份覆盖全字段面的正常 Trace，供序列化/读回类断言复用。 */
function fullEntry(over: Partial<TraceEntry> = {}): TraceEntry {
  const base: TraceEntry = {
    recordId: "rec_trace_fixture",
    recordRevisionId: "rev_trace_fixture",
    parseRunId: "run_trace_fixture",
    idempotencyKey: "k-trace-fixture",
    pipelineFingerprint: "0123456789abcdef".repeat(4),
    processingMode: "local_model",
    provider: "ollama",
    model: "qwen2.5:7b",
    callPath: "ollama_openai_compatible",
    attemptedPaths: ["ollama_openai_compatible"],
    degraded: false,
    structuredParseSucceeded: true,
    businessValidation: { passed: true, rules: [...BUSINESS_RULES] },
    derivedWriteCommitted: false,
    diagnostics: { http_status: 200, thought_count: 1 },
    phases: [{ phase: "provider_call", startedAtUtc: "2026-10-13T08:00:00.000Z", finishedAtUtc: "2026-10-13T08:00:01.000Z" }],
  };
  return { ...base, ...over };
}

/** 一次完整运行的 Trace：调用 → 结构门 → 业务门 → 记录，全部走真实实现。 */
async function runAndTrace(session: TraceSession, output: StructuredOutput, rawText: string): Promise<void> {
  const request = makeRequest(rawText);
  session.captureDebugRaw("preprocess", { recordRevisionId: request.recordRevisionId, rawText });
  const extracted = await invokeExtraction(ADAPTER, request, transportReturning(output));
  session.record({
    recordRevisionId: request.recordRevisionId,
    processingMode: "local_model",
    provider: extracted.provider,
    model: extracted.model,
    callPath: extracted.callPath,
    attemptedPaths: extracted.attemptedPaths,
    degraded: extracted.degraded,
    structuredParseSucceeded: true,
    phases: [{ phase: "provider_call", startedAtUtc: "2026-10-13T08:00:00.000Z", finishedAtUtc: "2026-10-13T08:00:01.000Z" }],
  });
  let errorKind: ParseErrorKind | undefined;
  try {
    validateBusiness(parseStructuredOutput(extracted.json), { sentText: rawText, rawText });
  } catch (cause) {
    errorKind = errorKindOf(cause) ?? undefined;
  }
  session.record({
    recordRevisionId: request.recordRevisionId,
    structuredParseSucceeded: true,
    businessValidation: { passed: errorKind === undefined, rules: [...BUSINESS_RULES] },
    derivedWriteCommitted: false,
    ...(errorKind === undefined ? {} : { errorKind, retryable: ERROR_RETRYABILITY[errorKind] }),
  });
  session.captureDebugRaw("business_validation", { recordRevisionId: request.recordRevisionId, rawText: output.summary });
}

// ── §11.1 字段面封闭 ────────────────────────────────────────────────

describe("§11.1 Trace 字段面：每项都对应一个定位能力，多一项就长成第二份数据库", () => {
  /** 指令 §11.1 逐条列举的定位能力 → 承载它的字段。 */
  const TRACEABILITY: ReadonlyArray<{ readonly requirement: string; readonly fields: readonly string[] }> = [
    { requirement: "输入记录及对应版本的内部 ID", fields: ["recordId", "recordRevisionId"] },
    { requirement: "ParseRun 和幂等键", fields: ["parseRunId", "idempotencyKey"] },
    { requirement: "pipeline fingerprint", fields: ["pipelineFingerprint"] },
    { requirement: "阶段名称及开始、结束时间", fields: ["phases"] },
    { requirement: "Provider 和模型标识", fields: ["provider", "model"] },
    { requirement: "结构化解析是否成功", fields: ["structuredParseSucceeded"] },
    { requirement: "业务校验结果", fields: ["businessValidation"] },
    { requirement: "派生数据写入是否提交", fields: ["derivedWriteCommitted"] },
    { requirement: "错误类别、可重试性及相关安全诊断信息", fields: ["errorKind", "retryable", "diagnostics"] },
  ];

  for (const probe of TRACEABILITY) {
    it(`定位能力「${probe.requirement}」有承载字段：${probe.fields.join(" / ")}`, () => {
      for (const field of probe.fields) {
        expect((TRACE_ENTRY_FIELDS as readonly string[]).includes(field), `字段面里应有 ${field}`).toBe(true);
      }
    });
  }

  it("字段面恰好等于「§11.1 要求」∪「§5.2 处理模式 + ADR-006 路径记录」，不留无来由的键", () => {
    const justified = [...TRACEABILITY.flatMap((probe) => probe.fields), "processingMode", "callPath", "attemptedPaths", "degraded"];
    expect(symmetricDiff(justified, [...TRACE_ENTRY_FIELDS]), `差集：${symmetricDiff(justified, [...TRACE_ENTRY_FIELDS]).join(",")}`).toEqual([]);
    expect(TRACE_ENTRY_FIELDS.length).toBe(18);
  });

  it("序列化后逐键读回：键集合仍在封闭集内，取值原样可定位", () => {
    const json = serializeTrace([fullEntry()]);
    const [readBack] = JSON.parse(json) as Array<Record<string, unknown>>;
    const keys = Object.keys(readBack!);
    // 守门的契约是「多一个键即拒」，省略的可选键不补形——所以这里断言子集而非相等
    const outside = keys.filter((key) => !(TRACE_ENTRY_FIELDS as readonly string[]).includes(key));
    expect(outside, `序列化后出现契约外键：${outside.join(", ")}`).toEqual([]);
    expect(keys.includes("errorKind"), "正常条目不该凭空长出失败侧字段").toBe(false);
    expect(readBack!["recordRevisionId"]).toBe("rev_trace_fixture");
    expect(readBack!["parseRunId"]).toBe("run_trace_fixture");
    expect(readBack!["idempotencyKey"]).toBe("k-trace-fixture");
    expect(readBack!["pipelineFingerprint"]).toBe("0123456789abcdef".repeat(4));
    expect(readBack!["attemptedPaths"]).toEqual(["ollama_openai_compatible"]);
    expect(readBack!["degraded"]).toBe(false);
    expect((readBack!["businessValidation"] as BusinessValidationRecord).passed).toBe(true);
    expect((readBack!["phases"] as PhaseTiming[])[0]!.phase).toBe("provider_call");
  });

  it("省略的可选字段不产生形状漂移：同一运行的两次序列化文本可比（指纹对账要求稳定文本）", () => {
    const sparse: TraceEntry = { recordRevisionId: "rev_stable" };
    const dense = { recordRevisionId: "rev_stable", provider: undefined, errorKind: undefined } as unknown as TraceEntry;
    expect(serializeTrace([dense])).toBe(serializeTrace([sparse]));
    expect(serializeTrace([sparse])).toBe('[{"recordRevisionId":"rev_stable"}]');
  });

  it("阶段名是封闭集：不在册的阶段名不接受（指令 §11.1 末段）", () => {
    expect([...TRACE_PHASES]).toEqual(["preprocess", "provider_call", "schema_validation", "business_validation", "derived_write"]);
    for (const phase of TRACE_PHASES) expect(isTracePhase(phase)).toBe(true);
    for (const unknownName of ["raw_capture", "provider", "deserialize", "", "PROVIDER_CALL", "sleep_session"]) {
      expect(isTracePhase(unknownName), `不应接受阶段名：${unknownName}`).toBe(false);
    }
    expect(isTracePhase(undefined)).toBe(false);
    expect(isTracePhase(42)).toBe(false);
    expect(isTracePhase({ phase: "preprocess" })).toBe(false);
  });

  it("契约外的顶层字段名一律拒（无论值是什么），包括原文/载荷/映射/密钥类字段", () => {
    const forbidden = [
      "raw_text",
      "rawText",
      "payload",
      "payload_text",
      "prompt",
      "system_prompt",
      "completion",
      "response_body",
      "api_key",
      "apiKey",
      "redaction_map",
      "redactionMap",
      "spans",
      "nonce",
      "originalStart",
      "title",
      "summary",
      "evidence",
    ];
    for (const key of forbidden) {
      const entry = { recordRevisionId: "rev_x", [key]: "任何值" } as TraceEntry;
      const thrown = capture(() => serializeTrace([entry]));
      expect(thrown, `字段 ${key} 应被拒`).toBeInstanceOf(TracePrivacyViolation);
      expect((thrown as Error).message).toMatch(/契约外字段/);
      expect((thrown as Error).message).toContain(key);
    }
  });

  it("嵌套结构同样封闭：phases / businessValidation 里的契约外键被拒", () => {
    expectThrownLike(
      {
        recordRevisionId: "rev_x",
        phases: [{ phase: "provider_call", startedAtUtc: "a", finishedAtUtc: "b", durationMs: 1 }],
      } as unknown as TraceEntry,
      /durationMs/,
    );
    expectThrownLike(
      {
        recordRevisionId: "rev_x",
        businessValidation: { passed: true, rules: [], detail: "顺手记一下" },
      } as unknown as TraceEntry,
      /detail/,
    );
    // 反向对照：在册的嵌套键放行
    expect(() =>
      serializeTrace([
        {
          recordRevisionId: "rev_x",
          businessValidation: { passed: false, rules: ["evidence_traceable"] },
          phases: [{ phase: "business_validation", startedAtUtc: "a", finishedAtUtc: "b" }],
        },
      ]),
    ).not.toThrow();
  });

  it("diagnostics 是唯一允许自由键的位置，但敏感字段名在里面同样被拒", () => {
    expect(() => serializeTrace([{ recordRevisionId: "rev_x", diagnostics: { http_status: 500, retry_count: 2, attempted: "sdk>lenient" } }])).not.toThrow();
    for (const key of ["raw_text", "payload_text", "redaction_map", "api_key", "originalStart", "originalEnd", "nonce", "completion"]) {
      const entry: TraceEntry = { recordRevisionId: "rev_x", diagnostics: { [key]: "值" } };
      const thrown = capture(() => serializeTrace([entry]));
      expect(thrown, `diagnostics.${key} 应被拒`).toBeInstanceOf(TracePrivacyViolation);
    }
    // 深一层也照样拦：守门不是只看第一层
    expectThrownLike({ recordRevisionId: "rev_x", diagnostics: { request: { payload_text: "完整请求载荷" } } }, /payload_text/);
  });

  it("provider/model 是在册字段，不能因为「像敏感信息」被误伤（指令 §11.1 明确要求记录）", () => {
    expect(() => serializeTrace([{ recordRevisionId: "rev_x", provider: "openai_compatible", model: "qwen2.5:7b" }])).not.toThrow();
  });
});

function expectThrownLike(entry: TraceEntry, pattern: RegExp): void {
  const thrown = capture(() => serializeTrace([entry]));
  expect(thrown, `期望拒掉 ${pattern}`).toBeInstanceOf(TracePrivacyViolation);
  expect((thrown as Error).message).toMatch(pattern);
}

// ── §11.2 隐私纪律：默认路径没有原文 ──────────────────────────────

describe("§11.2 隐私纪律：普通 Trace 里没有原文可填，命中即抛", () => {
  it("调试开关关闭时：采集调用被静默丢弃，序列化结果不含哨兵原文", () => {
    const session = new TraceSession();
    expect(session.debugRawTextEnabled).toBe(false);
    session.record(fullEntry({ recordRevisionId: "rev_off", parseRunId: "run_off" }));
    session.captureDebugRaw("preprocess", { recordRevisionId: "rev_off", rawText: SENTINEL });
    expect(session.debugRecordCount).toBe(0);

    const json = session.serialize({ rawText: SENTINEL });
    expect(json, "默认 Trace 不得含原文").not.toContain(SENTINEL);
    expect(json).not.toContain("raw_text");
    // 条目本身照常留下可定位标识——被丢掉的是原文，不是整条 Trace
    expect(json).toContain("rev_off");
    expect(json).toContain("run_off");
  });

  it("默认路径产出的日志/序列化结果都不含哨兵：连调试容器打开时也不例外", () => {
    const off = new TraceSession();
    const on = new TraceSession({ debugRawText: true });
    for (const session of [off, on]) {
      session.record(fullEntry({ recordRevisionId: "rev_both", errorKind: "evidence_unmapped", retryable: false }));
      session.captureDebugRaw("preprocess", { recordRevisionId: "rev_both", rawText: RAW_WITH_SENTINEL });
    }
    expect(off.debugRecordCount).toBe(0);
    expect(on.debugRecordCount).toBe(1);
    // 调试原文与普通 Trace 是两个容器：开了调试，serialize() 也看不见它
    expect(on.serialize({ rawText: RAW_WITH_SENTINEL })).not.toContain(SENTINEL);
    expect(off.serialize({ rawText: RAW_WITH_SENTINEL })).not.toContain(SENTINEL);
    // 会话对象整体被结构化序列化时也不吐出原文（私有字段的物理保证）
    expect(JSON.stringify(on)).not.toContain(SENTINEL);
    expect(JSON.stringify(on)).not.toContain("debugRecords");
  });

  it("调用方把原文塞进 diagnostics 也会被守门拦下——隐私性质在边界上成立，不只是在约定上成立", () => {
    const entry: TraceEntry = { recordRevisionId: "rev_leak", diagnostics: { snippet: SENTINEL } };
    const thrown = capture(() => serializeTrace([entry], { rawText: SENTINEL }));
    expect(thrown).toBeInstanceOf(TracePrivacyViolation);
    // 错误消息不回显字面量本体，否则守门函数自己成了泄露点
    expect((thrown as Error).message).not.toContain(SENTINEL);
    expect((thrown as Error).message).toContain(`长度 ${SENTINEL.length}`);
    expect((thrown as Error).message).toContain("普通 Trace 不得含原文");
  });

  it("占位符与密钥同样是守门字面量：命中即抛，未命中不误伤", () => {
    const { map } = redact("张三打了 13800138000", CLOUD_ENTITIES, { nonce: NONCE });
    const placeholder = map.spans[0]!.placeholder;
    const guards: PrivacyGuards = { redactionMap: map, apiKey: API_KEY };
    expect(() => serializeTrace([fullEntry()], guards)).not.toThrow();
    const leaked: TraceEntry = { recordRevisionId: "rev_ph", diagnostics: { cited: placeholder } };
    const thrown = capture(() => serializeTrace([leaked], guards));
    expect(thrown).toBeInstanceOf(TracePrivacyViolation);
    expect((thrown as Error).message).not.toContain(placeholder);
    const keyed: TraceEntry = { recordRevisionId: "rev_key", diagnostics: { auth: API_KEY } };
    expect(capture(() => serializeTrace([keyed], guards))).toBeInstanceOf(TracePrivacyViolation);
  });

  it("整条默认链路（调用→两道门→Trace）不出现哨兵，即使派生文本里全是它", async () => {
    const session = new TraceSession();
    await runAndTrace(session, MODEL_OUTPUT_BAD_EVIDENCE, RAW_WITH_SENTINEL);
    const json = session.serialize({ rawText: RAW_WITH_SENTINEL });
    expect(json).not.toContain(SENTINEL);
    expect(json).not.toContain(RAW_WITH_SENTINEL);
    expect(json).not.toContain("一次自我对话");
    expect(json).not.toContain("模型虚构的句子");
    // 能定位的是 ID、阶段、类别——不是内容
    expect(json).toContain("rev_trace_fixture");
    expect(json).toContain("evidence_unmapped");
    const entries = JSON.parse(json) as Array<Record<string, unknown>>;
    expect(entries.length).toBe(2);
    expect(entries[1]!["businessValidation"]).toEqual({ passed: false, rules: [...BUSINESS_RULES] });
  });

  it("成功路径同样不带原文：派生文本（标题/摘要/证据）在 Trace 里没有承载字段", async () => {
    const session = new TraceSession();
    await runAndTrace(session, MODEL_OUTPUT, RAW_WITH_SENTINEL);
    const json = session.serialize({ rawText: RAW_WITH_SENTINEL });
    expect(json).not.toContain(SENTINEL);
    expect(json).not.toContain("焦虑");
    for (const entry of JSON.parse(json) as Array<Record<string, unknown>>) {
      const outside = Object.keys(entry).filter((key) => !(TRACE_ENTRY_FIELDS as readonly string[]).includes(key));
      expect(outside, `默认链路产出的条目带出契约外键：${outside.join(", ")}`).toEqual([]);
    }
  });

  it("脱敏映射不进 Trace：映射本体既没有承载字段，也不能藏在 diagnostics 里", () => {
    const { map } = redact(RAW_WITH_SENTINEL, CLOUD_ENTITIES, { nonce: NONCE });
    expectThrownLike({ recordRevisionId: "rev_map", redactionMap: map } as unknown as TraceEntry, /契约外字段/);
    expectThrownLike({ recordRevisionId: "rev_map", diagnostics: { map } } as unknown as TraceEntry, /契约外字段/);
    expectThrownLike({ recordRevisionId: "rev_map", diagnostics: { spans: map.spans } } as unknown as TraceEntry, /spans/);
  });

  it("Trace 模块自身不写日志、不落盘、不碰库：调试原文只能是内存态（Spec §5.5）", () => {
    const source = readFileSync(TRACE_SOURCE, "utf8");
    expect(source).not.toMatch(/console\.|process\.stdout|process\.stderr/);
    expect(source).not.toMatch(/node:fs|writeFileSync|appendFile|createWriteStream|mkdirSync/);
    expect(source).not.toMatch(/node:sqlite|\.\.\/db\/|prepare\(|\.run\(|transaction\(/);
    expect(source).not.toMatch(/fetch\(|node:https?/);
    expect(readFileSync(PROVIDER_SOURCE, "utf8")).not.toMatch(/console\.|process\.stdout|process\.stderr/);
  });
});

// ── §5.5 调试原文模式 ──────────────────────────────────────────────

describe("§5.5 调试原文模式：默认关闭、会话范围、内存态、导出需额外确认", () => {
  it("默认关闭：构造时不传开关就是关，采集静默丢弃而不是抛（采集面不该中断正常解析）", () => {
    expect(new TraceSession().debugRawTextEnabled).toBe(false);
    expect(new TraceSession({}).debugRawTextEnabled).toBe(false);
    expect(new TraceSession({ debugRawText: false }).debugRawTextEnabled).toBe(false);
    const session = new TraceSession();
    expect(() => session.captureDebugRaw("preprocess", { recordRevisionId: "rev_a", rawText: SENTINEL })).not.toThrow();
    expect(session.debugRecordCount).toBe(0);
    // 开关没开时，确认后也拿不到东西
    expect(capture(() => session.exportDebugRaw(true))).toBeInstanceOf(DebugExportConfirmationRequired);
  });

  it("显式打开：构造参数或 enableDebugRawText 都算显式动作，采集才落内存", () => {
    const byOption = new TraceSession({ debugRawText: true });
    expect(byOption.debugRawTextEnabled).toBe(true);
    byOption.captureDebugRaw("preprocess", { recordRevisionId: "rev_on", rawText: SENTINEL, parseRunId: "run_on" });
    expect(byOption.debugRecordCount).toBe(1);

    const byCall = new TraceSession();
    byCall.captureDebugRaw("preprocess", { recordRevisionId: "rev_late", rawText: "丢弃" });
    expect(byCall.debugRecordCount).toBe(0);
    byCall.enableDebugRawText();
    byCall.captureDebugRaw("provider_call", { recordRevisionId: "rev_late", rawText: "记录" });
    expect(byCall.debugRecordCount).toBe(1);
    expect(byCall.debugRawTextEnabled).toBe(true);
  });

  it("关闭即销毁内存记录，之后再确认导出也不再产出原文", () => {
    const session = new TraceSession({ debugRawText: true });
    session.captureDebugRaw("preprocess", { recordRevisionId: "rev_off", rawText: SENTINEL });
    expect(session.debugRecordCount).toBe(1);
    session.disableDebugRawText();
    expect(session.debugRawTextEnabled).toBe(false);
    expect(session.debugRecordCount).toBe(0);
    expect(capture(() => session.exportDebugRaw(true))).toBeInstanceOf(DebugExportConfirmationRequired);
  });

  it("重启失效：restart() 出来的新会话开关只会是默认值，旧记录取不到", () => {
    const before = new TraceSession({ debugRawText: true });
    before.record(fullEntry({ recordRevisionId: "rev_before" }));
    before.captureDebugRaw("preprocess", { recordRevisionId: "rev_before", rawText: SENTINEL });
    const after = before.restart();
    expect(after.debugRawTextEnabled).toBe(false);
    expect(after.entryCount).toBe(0);
    expect(after.debugRecordCount).toBe(0);
    expect(capture(() => after.exportDebugRaw(true))).toBeInstanceOf(DebugExportConfirmationRequired);
    // 原会话不被复用：两代会话互不可见
    expect(after.serialize()).not.toContain("rev_before");
    expect(before.serialize()).toContain("rev_before");
  });

  it("会话范围：两个并行会话的调试记录与 Trace 互不串台", () => {
    const a = new TraceSession({ debugRawText: true });
    const b = new TraceSession({ debugRawText: true });
    a.captureDebugRaw("preprocess", { recordRevisionId: "rev_a", rawText: "A 的原文" });
    b.record(fullEntry({ recordRevisionId: "rev_b" }));
    expect(a.debugRecordCount).toBe(1);
    expect(b.debugRecordCount).toBe(0);
    expect(a.entryCount).toBe(0);
    expect(b.entryCount).toBe(1);
    expect(a.serialize()).not.toContain("rev_b");
    expect(b.serialize()).not.toContain("A 的原文");
  });

  it("导出需确认：未确认一律抛，且不产出任何字符串（不是返回空数组糊弄）", () => {
    const session = new TraceSession({ debugRawText: true });
    session.captureDebugRaw("preprocess", { recordRevisionId: "rev_confirm", rawText: SENTINEL });
    for (const confirmed of [false, undefined as unknown as boolean]) {
      const thrown = capture(() => session.exportDebugRaw(confirmed));
      expect(thrown).toBeInstanceOf(DebugExportConfirmationRequired);
      expect((thrown as Error).message).toContain("未确认不产出任何原文");
    }
    expect(capture(() => session.exportDebugRaw(true))).toBeUndefined();
  });

  it("确认后返回的正是内存里的记录本体：原文只从这一个出口出来", () => {
    const session = new TraceSession({ debugRawText: true });
    session.captureDebugRaw("preprocess", { recordRevisionId: "rev_export", rawText: RAW_WITH_SENTINEL, parseRunId: "run_export" });
    session.captureDebugRaw("business_validation", { recordRevisionId: "rev_export", rawText: MODEL_OUTPUT.summary });
    const exported = session.exportDebugRaw(true) as readonly DebugRawRecord[];
    expect(exported.length).toBe(2);
    expect(exported[0]!.stage).toBe("preprocess");
    expect(exported[0]!.rawText).toBe(RAW_WITH_SENTINEL);
    expect(exported[0]!.parseRunId).toBe("run_export");
    expect(exported[1]!.stage).toBe("business_validation");
    expect(exported[1]!.rawText).toContain(SENTINEL);
    for (const record of exported) expect(typeof record.capturedAtUtc).toBe("string");
    // 导出不改变普通 Trace：两个容器仍然分开
    expect(session.serialize()).not.toContain(SENTINEL);
    // 返回的是副本，改不动内部容器
    (exported as unknown as DebugRawRecord[]).push(exported[0]!);
    expect(session.exportDebugRaw(true).length).toBe(2);
  });

  it("调试原文按阶段归属：采集用哪个 TracePhase 就记哪个（指令 §11.1 的阶段面）", () => {
    const session = new TraceSession({ debugRawText: true });
    for (const phase of TRACE_PHASES) {
      session.captureDebugRaw(phase, { recordRevisionId: `rev_${phase}`, rawText: `${phase} 的原文` });
    }
    const exported = session.exportDebugRaw(true);
    expect(exported.map((record) => record.stage)).toEqual([...TRACE_PHASES]);
    expect(exported.map((record) => record.recordRevisionId)).toEqual([
      "rev_preprocess",
      "rev_provider_call",
      "rev_schema_validation",
      "rev_business_validation",
      "rev_derived_write",
    ]);
  });

  it("阶段计时成对写入开始/结束时刻，且值原样透传（指令 §11.1）", () => {
    let tick = 0;
    const clock = () => new Date(Date.parse("2026-10-13T08:00:00.000Z") + 1000 * tick++);
    const session = new TraceSession({ now: clock });
    const { value, timing } = session.timed<string>("schema_validation", () => "跑完了");
    expect(value).toBe("跑完了");
    expect(timing.phase).toBe("schema_validation");
    expect(timing.startedAtUtc).toBe("2026-10-13T08:00:00.000Z");
    expect(timing.finishedAtUtc).toBe("2026-10-13T08:00:01.000Z");
    expect(timing.startedAtUtc).not.toBe(timing.finishedAtUtc);
    // 同一个时钟也驱动调试记录的 capturedAtUtc
    const stamped = new TraceSession({ now: () => new Date("2026-10-13T09:30:00.000Z"), debugRawText: true });
    stamped.captureDebugRaw("provider_call", { recordRevisionId: "rev_clock", rawText: SENTINEL });
    expect(stamped.exportDebugRaw(true)[0]!.capturedAtUtc).toBe("2026-10-13T09:30:00.000Z");
  });

  it("注入的运行链：record() 返回写入的条目本身，entryCount 如实递增", async () => {
    const session = new TraceSession();
    expect(session.entryCount).toBe(0);
    await runAndTrace(session, MODEL_OUTPUT, RAW_WITH_SENTINEL);
    expect(session.entryCount).toBe(2);
    const recorded = session.record({ recordRevisionId: "rev_returned" });
    expect(recorded.recordRevisionId).toBe("rev_returned");
    expect(session.entryCount).toBe(3);
  });
});

// ── 错误类别、降级路径与可重试性可记录 ─────────────────────────────

describe("§11.3/ADR-006：错误类别、降级路径与可重试性都能进 Trace，异常不被吞", () => {
  it("七类错误每一类都能被 Trace 区分记录（与 ERROR_RETRYABILITY 一致）", () => {
    for (const kind of PARSE_ERROR_KINDS) {
      const entry: TraceEntry = {
        recordRevisionId: `rev_${kind}`,
        errorKind: kind,
        retryable: ERROR_RETRYABILITY[kind],
        diagnostics: { stage_index: 2 },
      };
      const [readBack] = JSON.parse(serializeTrace([entry])) as Array<Record<string, unknown>>;
      expect(readBack!["errorKind"]).toBe(kind);
      expect(readBack!["retryable"]).toBe(ERROR_RETRYABILITY[kind]);
    }
    expect(PARSE_ERROR_KINDS.length).toBe(7);
  });

  it("降级路径的 Trace 面记所走路径、是否降级、最终是否通过校验（ADR-006 Consequences）", async () => {
    const attempted: ProviderCallPath[] = ["sdk_structured", "http_json_lenient"];
    const entry: TraceEntry = {
      recordRevisionId: "rev_degraded",
      callPath: "sdk_structured",
      attemptedPaths: attempted,
      degraded: true,
      structuredParseSucceeded: true,
      businessValidation: { passed: false, rules: [...BUSINESS_RULES] },
      errorKind: "evidence_unmapped",
      retryable: ERROR_RETRYABILITY.evidence_unmapped,
      diagnostics: { degradation_reason_kind: "provider_schema" },
    };
    const json = serializeTrace([entry]);
    const [readBack] = JSON.parse(json) as Array<Record<string, unknown>>;
    expect(readBack!["attemptedPaths"]).toEqual(["sdk_structured", "http_json_lenient"]);
    expect(readBack!["degraded"]).toBe(true);
    expect((readBack!["businessValidation"] as BusinessValidationRecord).passed).toBe(false);
    // 路径取值仍受封闭集约束
    for (const path of attempted) expect((PROVIDER_CALL_PATHS as readonly string[]).includes(path)).toBe(true);
  });

  it("超时以可重试的类别上抛，Trace 只有计时数字，没有载荷文本", async () => {
    const session = new TraceSession();
    let thrown: unknown;
    try {
      await invokeExtraction({ ...ADAPTER, requestTimeoutMs: 15 }, makeRequest(RAW_WITH_SENTINEL), neverSettles);
    } catch (cause) {
      thrown = cause;
    }
    if (thrown === undefined) throw new Error("期望超时抛出，但没有抛出");
    expect(thrown, "超时收敛为 ProviderError").toBeInstanceOf(ProviderError);
    const err = thrown as ProviderError;
    expect(err.kind).toBe("timeout");
    session.record({
      recordRevisionId: "rev_timeout",
      errorKind: err.kind,
      retryable: err.retryable,
      diagnostics: { timeout_ms: err.diagnostics["timeout_ms"] ?? null },
    });
    session.captureDebugRaw("provider_call", { recordRevisionId: "rev_timeout", rawText: RAW_WITH_SENTINEL });
    const json = session.serialize({ rawText: RAW_WITH_SENTINEL });
    expect(json).not.toContain(SENTINEL);
    expect(json).toContain("timeout");
    expect(json).toContain("15");
  });

  it("业务校验失败与结构失败在 Trace 里是两个可区分的类别（互不吞并）", () => {
    const schemaErr = capture(() => parseStructuredOutput({ nope: 1 })) as Error & { kind: ParseErrorKind };
    const businessErr = capture(() =>
      validateBusiness({ ...MODEL_OUTPUT, thoughts: [{ text: "x", evidence: "不在输入里" }] }, { sentText: RAW_WITH_SENTINEL, rawText: RAW_WITH_SENTINEL }),
    ) as BusinessValidationError;
    expect(schemaErr.kind).toBe("provider_schema");
    expect(businessErr.kind).toBe("evidence_unmapped");
    const json = serializeTrace([
      { recordRevisionId: "rev_schema", errorKind: schemaErr.kind, retryable: ERROR_RETRYABILITY[schemaErr.kind] },
      { recordRevisionId: "rev_business", errorKind: businessErr.kind, retryable: ERROR_RETRYABILITY[businessErr.kind] },
    ]);
    expect(json).toContain("provider_schema");
    expect(json).toContain("evidence_unmapped");
    expect(json).not.toContain(SENTINEL);
    expect(json).not.toContain("不在输入里");
  });
});

// ── M2-4b 取值门：键名在册不够，取值也得在册 ────────────────────────

/**
 * M2-4 复审裁决 1 的补丁：`serializeTrace` 原来只校验**键名**，运行时把 `phases[0].phase`
 * 塞成未在册值照样通过；`isTracePhase()` 存在却没有任何生产调用点。与 M2-2b (d1)
 * 「白名单里的枚举字段补取值门」同类，本段钉住四件事：
 * ① 四个封闭集字段的**取值**在册才放行；② 嵌套 `phases[].phase` 同样受门；
 * ③ 门的判定与各字段的事实源逐值一致（`processing_modes` 取自 enums.json，不抄第二份）；
 * ④ 反向对照——覆盖全字段面的合法条目不得被误伤（防一票否决）。
 * 编译期收紧的类型挡不住运行时注入，所以下面一律用 `as unknown as TraceEntry` 灌非法值。
 */

/** 运行时注入的未在册取值：每个都必须在真实序列化路径上被拦下。 */
const UNREGISTERED_INJECTIONS: ReadonlyArray<{
  readonly field: keyof TraceEntry;
  readonly injected: unknown;
  readonly pathPattern: RegExp;
}> = [
  { field: "processingMode", injected: "not_a_mode", pathPattern: /entry\[0\]\.processingMode/ },
  { field: "callPath", injected: "grpc_stream", pathPattern: /entry\[0\]\.callPath/ },
  { field: "errorKind", injected: "not_an_error_kind", pathPattern: /entry\[0\]\.errorKind/ },
  { field: "attemptedPaths", injected: ["sdk_structured", "grpc_stream"], pathPattern: /entry\[0\]\.attemptedPaths\[1\]/ },
];

const ENUMS = loadEnums();

type InjectionProbe = {
  readonly name: string;
  /** 该字段事实源的判定函数——门必须与它同判，否则门就是另立一套。 */
  readonly sourceOfTruth: (value: unknown) => boolean;
  readonly candidates: readonly unknown[];
  readonly build: (value: unknown) => TraceEntry;
};

/** 逐值对照：在册 ⇒ 放行，未在册 ⇒ 拦下，两边都断言。 */
const AGREEMENT_PROBES: readonly InjectionProbe[] = [
  {
    name: "phase（TRACE_PHASES）",
    sourceOfTruth: (value: unknown) => isTracePhase(value),
    candidates: [...TRACE_PHASES, "not_a_phase", "PROVIDER_CALL", "sleep_session", "", "preprocess "],
    build: (value: unknown) =>
      ({ ...fullEntry(), phases: [{ phase: value, startedAtUtc: "a", finishedAtUtc: "b" }] }) as unknown as TraceEntry,
  },
  {
    name: "callPath（PROVIDER_CALL_PATHS）",
    sourceOfTruth: (value: unknown) => typeof value === "string" && (PROVIDER_CALL_PATHS as readonly string[]).includes(value),
    candidates: [...PROVIDER_CALL_PATHS, "grpc_stream", "SDK_STRUCTURED", ""],
    build: (value: unknown) => ({ ...fullEntry(), callPath: value }) as unknown as TraceEntry,
  },
  {
    name: "errorKind（PARSE_ERROR_KINDS）",
    sourceOfTruth: (value: unknown) => typeof value === "string" && (PARSE_ERROR_KINDS as readonly string[]).includes(value),
    candidates: [...PARSE_ERROR_KINDS, "not_an_error_kind", "network ", ""],
    build: (value: unknown) => ({ ...fullEntry(), errorKind: value }) as unknown as TraceEntry,
  },
  {
    name: "processingMode（enums.json processing_modes）",
    sourceOfTruth: (value: unknown) => typeof value === "string" && (ENUMS.processing_modes as readonly string[]).includes(value),
    candidates: [...ENUMS.processing_modes, "manual", "CLOUD_REDACTED", "cloud_full_auto", ""],
    build: (value: unknown) => ({ ...fullEntry(), processingMode: value }) as unknown as TraceEntry,
  },
];

describe("M2-4b 取值门：封闭集字段的取值不在册即拒，报错落在具体路径上", () => {
  for (const probe of UNREGISTERED_INJECTIONS) {
    it(`运行时注入未在册的 ${probe.field} ⇒ serializeTrace 抛（沿用既有错误类型，不新增语义重复的错误类）`, () => {
      const entry = { ...fullEntry(), [probe.field]: probe.injected } as unknown as TraceEntry;
      const thrown = capture(() => serializeTrace([entry]));
      expect(thrown, `${probe.field} 的未在册取值应被拒`).toBeInstanceOf(TracePrivacyViolation);
      expect((thrown as Error).message).toMatch(probe.pathPattern);
      expect((thrown as Error).message, "应说明是取值门拦的，而非契约外键名").toMatch(/封闭集/);
      expect((thrown as Error).message).not.toMatch(/契约外字段/);
    });
  }

  it("嵌套的 phases[].phase 同样受门：首个非法阶段落在 phases[0].phase 上", () => {
    expectThrownLike(
      fullEntry({
        phases: [
          { phase: "not_a_phase", startedAtUtc: "a", finishedAtUtc: "b" },
          { phase: "preprocess", startedAtUtc: "c", finishedAtUtc: "d" },
        ] as unknown as PhaseTiming[],
      }),
      /phases\[0\]\.phase/,
    );
  });

  it("合法阶段在前、非法阶段在后：门按位置报出 phases[1].phase（不是撞到第一个元素就糊弄）", () => {
    expectThrownLike(
      fullEntry({
        phases: [
          { phase: "preprocess", startedAtUtc: "a", finishedAtUtc: "b" },
          { phase: "provider", startedAtUtc: "c", finishedAtUtc: "d" },
        ] as unknown as PhaseTiming[],
      }),
      /phases\[1\]\.phase/,
    );
  });

  it("门在 TraceSession.serialize() 这条真实路径上同样生效：record() 只收，序列化面才拦", () => {
    const session = new TraceSession();
    session.record(
      fullEntry({ phases: [{ phase: "not_a_phase", startedAtUtc: "a", finishedAtUtc: "b" }] as unknown as PhaseTiming[] }),
    );
    expect(session.entryCount).toBe(1);
    const thrown = capture(() => session.serialize());
    expect(thrown).toBeInstanceOf(TracePrivacyViolation);
    expect((thrown as Error).message).toMatch(/phases\[0\]\.phase/);
  });

  for (const probe of AGREEMENT_PROBES) {
    it(`门与 ${probe.name} 的事实源逐值同判（在册放行 / 未在册拦下）`, () => {
      for (const candidate of probe.candidates) {
        const accepted = capture(() => serializeTrace([probe.build(candidate)])) === undefined;
        expect(accepted, `取值 ${JSON.stringify(candidate)} 应与事实源同判`).toBe(probe.sourceOfTruth(candidate));
      }
    });
  }

  it("processingMode 的门确实取自 enums.json：trace.ts 里没有第二份处理模式清单", () => {
    const source = readFileSync(TRACE_SOURCE, "utf8");
    expect(ENUMS.processing_modes).toEqual(["manual_only", "local_model", "cloud_redacted"]);
    // 取的是 enums 的字段名与运行时读取入口，而不是把三个值抄进 trace.ts
    expect(source).toMatch(/processing_modes/);
    expect(source).toMatch(/contracts\/load\.ts/);
    for (const literal of ["manual_only", "local_model", "cloud_redacted"]) {
      expect(source, `trace.ts 不该出现第二份清单字面量：${literal}`).not.toContain(literal);
    }
  });

  it("五个在册阶段可以在同一条目里逐个计时并整体放行（ADR-006 全链路正例）", () => {
    const session = new TraceSession({ now: () => new Date("2026-10-13T08:00:00.000Z") });
    const phases = TRACE_PHASES.map((phase) => session.timed(phase, () => undefined).timing);
    session.record(fullEntry({ phases }));
    const json = session.serialize();
    const [readBack] = JSON.parse(json) as Array<Record<string, unknown>>;
    expect((readBack!["phases"] as PhaseTiming[]).map((timing) => timing.phase)).toEqual([...TRACE_PHASES]);
  });

  it("反向对照：省略的可选封闭集字段不误伤（undefined 不是「取值不在册」）", () => {
    // 显式 undefined 是调用方常见的「这一项没走到」写法：exactOptionalPropertyTypes 下
    // 它进不了类型，但运行时照样可能出现（外部门传入、JSON 反序列化），门必须放行。
    const sparse = {
      recordRevisionId: "rev_undef",
      processingMode: undefined,
      callPath: undefined,
      errorKind: undefined,
      attemptedPaths: undefined,
      phases: undefined,
    } as unknown as TraceEntry;
    expect(() => serializeTrace([sparse])).not.toThrow();
    expect(serializeTrace([sparse])).toBe('[{"recordRevisionId":"rev_undef"}]');
  });

  it("反向对照：diagnostics 是自由容器，里面的同名键不受取值门约束（敏感键名门照旧生效）", () => {
    expect(() =>
      serializeTrace([{ recordRevisionId: "rev_diag", diagnostics: { phase: "手写的阶段标签", errorKind: "自定义分类", processingMode: 42 } }]),
    ).not.toThrow();
    expectThrownLike({ recordRevisionId: "rev_diag", diagnostics: { raw_text: "手写的值" } }, /raw_text/);
  });

  it("取值门不回显未在册的取值本身：把原文塞进 phase 也不会进错误消息（§11.2）", () => {
    const entry = fullEntry({ phases: [{ phase: SENTINEL, startedAtUtc: "a", finishedAtUtc: "b" }] as unknown as PhaseTiming[] });
    const thrown = capture(() => serializeTrace([entry], { rawText: SENTINEL }));
    expect(thrown).toBeInstanceOf(TracePrivacyViolation);
    expect((thrown as Error).message).not.toContain(SENTINEL);
    expect((thrown as Error).message).toMatch(/phases\[0\]\.phase/);
  });
});
