import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import { loadContracts } from "../src/shared/contracts/load.ts";
import { ID_PREFIXES, seedConceptId } from "../src/shared/contracts/ids.ts";
import {
  REDACTION_POLICY_VERSION,
  redact,
  redactionMapJsonValue,
  type KnownEntity,
} from "../src/server/privacy/redaction.ts";
import {
  PIPELINE_MANIFEST_FIELDS,
  buildPipelineManifest,
  canonicalJson,
  pipelineFingerprint,
  pipelineManifestLocalJson,
  type JsonObject,
  type JsonValue,
} from "../src/server/privacy/manifest.ts";
import {
  BUSINESS_RULES,
  ContractSchemaError,
  BusinessValidationError,
  errorKindOf,
  eventTimeViolations,
  parseStructuredOutput,
  seedConceptIndex,
  validateBusiness,
  type BusinessRule,
  type BusinessValidationContext,
  type ConceptIndex,
  type StructuredOutput,
} from "../src/server/ingest/contract.ts";
import { InvalidJsonError, canExtractJson, extractJson } from "../src/server/ingest/extractJson.ts";
import {
  ERROR_RETRYABILITY,
  PARSE_ERROR_KINDS,
  PROVIDER_CALL_PATHS,
  ProviderError,
  ProcessingModeError,
  assertCloudGranted,
  assertSendable,
  buildRunManifest,
  invokeExtraction,
  isLoopbackUrl,
  type ExtractionRequest,
  type ModelAdapter,
  type ParseErrorKind,
  type ProcessingMode,
  type ProviderCallPath,
  type ProviderTransport,
  type TransportRequest,
  type TransportResponse,
} from "../src/server/ingest/provider.ts";

/**
 * M2-4 Provider 面契约测试（D5 + D6）：结构化输出双轨校验、统一 Provider Adapter、
 * 运行 manifest 的字段封闭性（T-33 的 manifest 侧）。
 *
 * 契约取值：Spec §5.3/§5.4/§9.4/§9.5、ADR-006、ADR-014、指令 §6.1–§6.3/§7.5/§8.1/§十一、
 * `enums.json` 封闭集、`0003_derived_layer.sql` 的 `parse_run.error_kind` CHECK。
 *
 * **全程离线**：模型调用一律由注入的 `ProviderTransport` 假实现驱动，
 * 不发任何网络请求、不依赖 Ollama 或任何本地模型服务；超时/取消用可注入的
 * `requestTimeoutMs` 与 `signal`，本文件最慢一条 40ms。
 *
 * 分工边界：数据库面（error_kind 的 CHECK 落地、九项非空的 SQL 地板）已由
 * `m2-schema-contract` 与 `m2-privacy` 钉住；本文件钉的是**服务面**——
 * 两道门的独立性、路径与闸门的组合、错误分类与可重试性、manifest 产物的字段集合。
 * Trace 面与原文哨兵在 `m2-trace.test.ts`。
 */

const MIGRATION_0003 = "src/server/db/migrations/0003_derived_layer.sql";
const EXTRACT_SOURCE = "src/server/ingest/extractJson.ts";
const PROVIDER_SOURCE = "src/server/ingest/provider.ts";
const CONTRACT_SOURCE = "src/server/ingest/contract.ts";

const NONCE = "a1b2c3";
const HEX64 = "0123456789abcdef".repeat(4);
const API_KEY_ENV = "TB_M2_PROVIDER_TEST_KEY";
const ENV_API_KEY = "sk-live-fixture-key-should-never-be-logged";

const CONTRACTS = loadContracts();

// ── 夹具文本 ────────────────────────────────────────────────────────

/** 本地路径：发送文本 == 原文，没有脱敏映射（Spec §5.1 第 4 步的脱敏只对云端成立）。 */
const LOCAL_RAW = "今天和项目组的同事讨论了发布计划，我感到焦虑";

/** 云端路径：原文里有两处可脱敏内容，映射由 `redact` 现场产出（与被测路径同源）。 */
const CLOUD_RAW = "周末和张三去了蓝山咖啡馆，聊了三个小时";
const CLOUD_ENTITIES: readonly KnownEntity[] = [
  { entityId: "entity_zhang", entityType: "person", terms: ["张三"] },
  { entityId: "entity_store", entityType: "organization", terms: ["蓝山咖啡馆"] },
];
const CLOUD = redact(CLOUD_RAW, CLOUD_ENTITIES, { nonce: NONCE });
const PH_PERSON = CLOUD.map.spans[0]!.placeholder; // [person_1_a1b2c3]
const PH_ORG = CLOUD.map.spans[1]!.placeholder; // [organization_1_a1b2c3]

interface ContextOverrides {
  readonly knownConcepts?: ConceptIndex;
  readonly knownEntityIds?: ReadonlySet<string>;
}

function localContext(overrides: ContextOverrides = {}): BusinessValidationContext {
  return {
    sentText: LOCAL_RAW,
    rawText: LOCAL_RAW,
    ...(overrides.knownConcepts === undefined ? {} : { knownConcepts: overrides.knownConcepts }),
    ...(overrides.knownEntityIds === undefined ? {} : { knownEntityIds: overrides.knownEntityIds }),
  };
}

function cloudContext(overrides: ContextOverrides = {}): BusinessValidationContext {
  return {
    sentText: CLOUD.redactedText,
    rawText: CLOUD_RAW,
    redactionMap: CLOUD.map,
    ...(overrides.knownConcepts === undefined ? {} : { knownConcepts: overrides.knownConcepts }),
    ...(overrides.knownEntityIds === undefined ? {} : { knownEntityIds: overrides.knownEntityIds }),
  };
}

/** 结构合法、业务合法的回稿基线——每条负例都由它**单点**变异而来。 */
function validOutput(): StructuredOutput {
  return {
    title: "关于发布计划的讨论",
    summary: "记录了一次发布计划讨论，当事人表达了焦虑",
    episodes: [
      {
        summary: "和项目组的同事讨论发布计划",
        evidence: "讨论了发布计划",
        eventTime: { raw: "今天", precision: "day", certainty: "explicit", start: "2026-10-13", end: "2026-10-13" },
      },
    ],
    thoughts: [{ text: "发布计划需要提前定稿", evidence: "讨论了发布计划" }],
    emotions: [{ labelSaid: "焦虑", candidateConceptId: seedConceptId("焦虑"), basis: "explicit", evidence: "我感到焦虑" }],
    topics: [{ labelSaid: "工作", candidateConceptId: seedConceptId("工作与职场"), basis: "explicit", evidence: "讨论了发布计划" }],
    entities: [{ labelSaid: "项目组", candidateConceptId: null, basis: "explicit", evidence: "和项目组的同事" }],
  };
}

/** 云端合法回稿：证据引用占位符本体，映射后落回原文坐标与真实词面。 */
function validCloudOutput(): StructuredOutput {
  return {
    title: "周末的一次见面",
    summary: `记录了与 ${PH_PERSON} 在 ${PH_ORG} 的一次见面`,
    episodes: [],
    thoughts: [{ text: "见面比线上沟通更有效", evidence: `和${PH_PERSON}去了` }],
    emotions: [{ labelSaid: "开心", candidateConceptId: seedConceptId("开心"), basis: "explicit", evidence: "聊了三个小时" }],
    topics: [{ labelSaid: "社交", candidateConceptId: seedConceptId("朋友与社交"), basis: "explicit", evidence: `和${PH_PERSON}去了` }],
    entities: [{ labelSaid: "张三", candidateConceptId: null, basis: "explicit", evidence: `和${PH_PERSON}` }],
  };
}

/** 单点删键：用于「空信息也必须显式给空数组」这一类结构负例。 */
function omitFields(output: StructuredOutput, ...keys: (keyof StructuredOutput)[]): unknown {
  const copy: Record<string, unknown> = { ...output };
  for (const key of keys) delete copy[key];
  return copy;
}

/** 在词表种子上加一项：用户自建概念/别名由 M2-5 从库里现读后注入，默认索引只覆盖种子。 */
function conceptsPlus(id: string, domain: "emotion" | "topic"): ConceptIndex {
  const index = new Map<string, "emotion" | "topic">(seedConceptIndex());
  index.set(id, domain);
  return index;
}

// ── 测试辅助 ────────────────────────────────────────────────────────

function symmetricDiff(a: readonly string[], b: readonly string[]): string[] {
  const setB = new Set(b);
  const setA = new Set(a);
  return [...a.filter((x) => !setB.has(x)), ...b.filter((x) => !setA.has(x))];
}

/** 捕获而不是 toThrow：门的归属由实例类型判定，不靠读消息文本。 */
function capture(builder: () => unknown): Error | undefined {
  try {
    builder();
  } catch (cause) {
    return cause as Error;
  }
  return undefined;
}

function expectThrown(builder: () => unknown, pattern: RegExp): unknown {
  const thrown = capture(builder);
  if (thrown === undefined) throw new Error(`期望抛出 ${pattern}，但没有抛出`);
  expect(thrown.message).toMatch(pattern);
  return thrown;
}

async function expectRejected(builder: () => Promise<unknown>, pattern: RegExp): Promise<unknown> {
  let thrown: unknown;
  try {
    await builder();
  } catch (cause) {
    thrown = cause;
  }
  if (thrown === undefined) throw new Error(`期望抛出 ${pattern}，但没有抛出`);
  expect((thrown as Error).message).toMatch(pattern);
  return thrown;
}

/** 某条业务错误里实际触发了哪些规则（`rule：target — detail` 的前段）。 */
function trippedRules(error: BusinessValidationError): string[] {
  return [...new Set(error.issues.map((line) => line.split("：")[0]!))];
}

function makeAdapter(over: {
  readonly provider?: string;
  readonly model?: string;
  readonly baseUrl?: string;
  readonly callPath?: ProviderCallPath;
  readonly supportsStructuredOutput?: boolean;
  readonly requestTimeoutMs?: number;
  readonly apiKeyEnv?: string;
  readonly params?: JsonObject;
} = {}): ModelAdapter {
  return {
    provider: over.provider ?? "ollama",
    model: over.model ?? "qwen2.5:7b",
    baseUrl: over.baseUrl ?? "http://127.0.0.1:11434/v1",
    callPath: over.callPath ?? "ollama_openai_compatible",
    supportsStructuredOutput: over.supportsStructuredOutput ?? false,
    requestTimeoutMs: over.requestTimeoutMs ?? 2000,
    ...(over.apiKeyEnv === undefined ? {} : { apiKeyEnv: over.apiKeyEnv }),
    ...(over.params === undefined ? {} : { params: over.params }),
  };
}

function makeRequest(over: {
  readonly processingMode?: ProcessingMode;
  readonly payloadText?: string;
  readonly recordRevisionId?: string;
  readonly redactionMap?: JsonValue;
  readonly signal?: AbortSignal;
} = {}): ExtractionRequest {
  return {
    recordRevisionId: over.recordRevisionId ?? "rev_fixture_1",
    processingMode: over.processingMode ?? "local_model",
    payloadText: over.payloadText ?? LOCAL_RAW,
    systemPrompt: "你是提取器，只输出 JSON。",
    promptVersion: "m2-prompt-v1",
    outputSchemaVersion: "m2-output-v1",
    contractsFingerprint: HEX64,
    resolverVersion: "resolver-v1",
    validationVersion: "validation-v1",
    ...(over.redactionMap === undefined ? {} : { redactionMap: over.redactionMap }),
    ...(over.signal === undefined ? {} : { signal: over.signal }),
  };
}

type Responder = (attempt: number, request: TransportRequest) => TransportResponse | Error | Promise<TransportResponse | Error>;

interface FakeTransport {
  readonly transport: ProviderTransport;
  readonly requests: TransportRequest[];
  calls(): number;
  reset(): void;
}

/** 唯一的传输替身：不碰网络，只把每一次「本来要发出去的东西」留在内存里供断言。 */
function fakeTransport(respond: Responder): FakeTransport {
  const requests: TransportRequest[] = [];
  const transport: ProviderTransport = {
    send: async (request) => {
      requests.push(request);
      const verdict = await respond(requests.length, request);
      if (verdict instanceof Error) throw verdict;
      return verdict;
    },
  };
  return { transport, requests, calls: () => requests.length, reset: () => (requests.length = 0) };
}

function envelope(content: string): TransportResponse {
  return { status: 200, body: JSON.stringify({ choices: [{ message: { content } }] }) };
}

function jsonEnvelope(output: unknown): TransportResponse {
  return envelope(JSON.stringify(output));
}

function fencedJsonEnvelope(output: unknown): TransportResponse {
  return envelope("```json\n" + JSON.stringify(output, null, 2) + "\n```");
}

/** 永不 settle 的传输：只在中止时拒绝，让超时/取消可在无网络条件下确定性地发生。 */
const neverSettles = (_attempt: number, request: TransportRequest): Promise<TransportResponse> =>
  new Promise<TransportResponse>((resolve, reject) => {
    if (request.signal.aborted) {
      reject(new Error("already aborted"));
      return;
    }
    request.signal.addEventListener("abort", () => reject(new Error("aborted by signal")));
  });

afterEach(() => {
  delete process.env[API_KEY_ENV];
});

// ── §9.5 容错 JSON 提取 ────────────────────────────────────────────

describe("§9.5 移植的 extractJson：签名返回已解析对象，不是字符串", () => {
  it("返回对象本体（上游 src/qa/synthesize.ts 的同名实现返回 string，误取即把结构降级）", () => {
    const parsed = extractJson('{"title":"标题","thoughts":[]}');
    expect(typeof parsed).toBe("object");
    expect(Array.isArray(parsed)).toBe(false);
    expect(parsed).not.toBeTypeOf("string");
    expect(parsed["title"]).toBe("标题");
    expect(canExtractJson('{"a":1}')).toBe(true);
  });

  it("剥整段围栏、取首个 { 到末个 } —— 前后夹带的解释文本被丢掉", () => {
    expect(extractJson("```json\n{\"a\":1}\n```")).toEqual({ a: 1 });
    expect(extractJson("```\n{\"a\":1}\n```")).toEqual({ a: 1 });
    expect(extractJson("好的，结果如下：\n{\"a\":1}\n希望有帮助")).toEqual({ a: 1 });
    expect(extractJson("{\"a\":{\"b\":2},\"c\":[3,4]}")).toEqual({ a: { b: 2 }, c: [3, 4] });
  });

  it("不可解析一律 InvalidJsonError：kind 落在封闭错误集内且不可重试", () => {
    const unparseable = ["整段都是散文，没有花括号", "前缀 { 后面没有闭合的括号", "{\"a\": ", "{\"a\": }", "[]", "null"];
    for (const text of unparseable) {
      const thrown = capture(() => extractJson(text));
      expect(thrown, `输入「${text}」应判为不可解析`).toBeInstanceOf(InvalidJsonError);
      const err = thrown as InvalidJsonError;
      expect(err.kind).toBe("invalid_json");
      expect((PARSE_ERROR_KINDS as readonly string[]).includes(err.kind)).toBe(true);
      expect(err.retryable).toBe(false);
      expect(canExtractJson(text)).toBe(false);
    }
    // 「取首个 { 到末个 }」的语义边界：尾部残文里若还有右括号，截出的片段就不是合法 JSON
    expect(extractJson("{\"a\":1} 后面又跟一个 {\"b\":2")).toEqual({ a: 1 });
    expect(capture(() => extractJson("{\"a\":1 后面又跟一个 {\"b\":2}"))).toBeInstanceOf(InvalidJsonError);
  });

  it("移植出处与源文件版本记在文件头（Spec §9.5：防「移植了哪一个版本」不可考）", () => {
    const source = readFileSync(EXTRACT_SOURCE, "utf8");
    expect(source).toMatch(/sha256[：:]\s*[0-9a-f]{64}/);
    const originLine = source.split("\n").find((line) => line.includes("移植来源")) ?? "";
    expect(originLine, `移植来源行应指向 src/ingest/extract.ts，实际为「${originLine}」`).toMatch(/llm-wiki-agent\/src\/ingest\/extract\.ts/);
    expect(originLine).not.toMatch(/synthesize\.ts/);
  });
});

// ── ADR-006 第一道门：形状 ─────────────────────────────────────────

describe("ADR-006 结构门：形状不合只由它拒，错误类型固定 provider_schema", () => {
  const base = validOutput();

  const SHAPE_BROKEN: ReadonlyArray<{ readonly name: string; readonly input: unknown; readonly needle?: string }> = [
    { name: "缺 title", input: omitFields(base, "title"), needle: "title" },
    { name: "缺 thoughts 键（空信息也必须显式给空数组）", input: omitFields(base, "thoughts"), needle: "thoughts" },
    { name: "summary 类型错（给了数字）", input: { ...base, summary: 42 } },
    { name: "episodes 不是数组", input: { ...base, episodes: {} } },
    { name: "evidence 空串", input: { ...base, thoughts: [{ text: "念头", evidence: "" }] } },
    { name: "顶层多给 intensity（模型无权提议强度）", input: { ...base, intensity: 4 }, needle: "intensity" },
    { name: "顶层多给 triggered_by（触发认定不属本层）", input: { ...base, triggered_by: ["ep_fixture"] }, needle: "triggered_by" },
    { name: "顶层多给关系类型（不得任意新增）", input: { ...base, relation_types: ["about"] }, needle: "relation_types" },
    { name: "标签对象里多给 intensity", input: { ...base, emotions: [{ ...base.emotions[0]!, intensity: 5 }] }, needle: "intensity" },
    { name: "basis 取值不在 enums 封闭集", input: { ...base, emotions: [{ ...base.emotions[0]!, basis: "guessed" }] } },
    { name: "precision 取值不在 enums 封闭集", input: { ...base, episodes: [{ summary: "经历", evidence: "讨论了发布计划", eventTime: { raw: "上午", precision: "hour", certainty: "explicit", start: "2026-10-13", end: "2026-10-13" } }] } },
    { name: "eventTime 多给 from 别名键", input: { ...base, episodes: [{ summary: "经历", evidence: "讨论了发布计划", eventTime: { raw: "今天", precision: "day", certainty: "explicit", start: "2026-10-13", end: "2026-10-13", from: "2026-10-13" } }] }, needle: "from" },
    { name: "start 不是 YYYY-MM-DD 形态", input: { ...base, episodes: [{ summary: "经历", evidence: "讨论了发布计划", eventTime: { raw: "今天", precision: "day", certainty: "explicit", start: "20261013", end: "20261013" } }] } },
    { name: "labelSaid 缺失", input: { ...base, topics: [{ candidateConceptId: null, basis: "explicit", evidence: "讨论了发布计划" }] } },
  ];

  for (const probe of SHAPE_BROKEN) {
    it(`结构非法：${probe.name}`, () => {
      const thrown = capture(() => parseStructuredOutput(probe.input));
      expect(thrown, `期望形状门拒掉「${probe.name}」`).toBeInstanceOf(ContractSchemaError);
      expect(thrown).not.toBeInstanceOf(BusinessValidationError);
      const err = thrown as ContractSchemaError;
      expect(err.kind).toBe("provider_schema");
      expect(err.retryable).toBe(false);
      expect(errorKindOf(err)).toBe("provider_schema");
      expect(err.issues.length).toBeGreaterThan(0);
      if (probe.needle !== undefined) {
        expect(err.issues.join("\n"), `应点名契约外/不合型的键 ${probe.needle}`).toContain(probe.needle);
      }
      // 形状门只说形状的事：issues 里不出现任何业务规则标识（两道门不互相吞并）
      for (const rule of BUSINESS_RULES) expect(err.issues.join("\n")).not.toContain(rule);
    });
  }

  it("空信息返回空数组：六个数组键齐备且为空，两道门都放行", () => {
    const empty: StructuredOutput = {
      title: "没有可提取的内容",
      summary: "这条记录里没有经历、念头或标签",
      episodes: [],
      thoughts: [],
      emotions: [],
      topics: [],
      entities: [],
    };
    const result = validateBusiness(parseStructuredOutput(empty), localContext());
    expect([result.episodes, result.thoughts, result.emotions, result.topics, result.entities].map((list) => list.length)).toEqual([0, 0, 0, 0, 0]);
    expect(result.checkedRules).toEqual([...BUSINESS_RULES]);
    // 缺键是结构问题而不是「当成空数组」：用 .default([]) 等于替模型把 Schema 填满
    expect(capture(() => parseStructuredOutput(omitFields(empty, "entities")))).toBeInstanceOf(ContractSchemaError);
  });

  it("封闭取值来自 enums.json：集内值全过形状门，集外值由形状门而非业务门拒", () => {
    expect([...CONTRACTS.enums.event_time_precision]).toEqual(["year", "month", "day", "unknown"]);
    expect([...CONTRACTS.enums.event_time_certainty]).toEqual(["explicit", "approximate", "unknown"]);
    expect([...CONTRACTS.enums.basis_values]).toEqual(["explicit", "inferred"]);
    for (const basis of CONTRACTS.enums.basis_values) {
      const output = { ...validOutput(), emotions: [{ ...validOutput().emotions[0]!, basis }] };
      expect(() => parseStructuredOutput(output)).not.toThrow();
    }
    const outside = { ...validOutput(), emotions: [{ ...validOutput().emotions[0]!, basis: "certain" }] };
    expect(capture(() => parseStructuredOutput(outside))).toBeInstanceOf(ContractSchemaError);
    // 绕过形状门直接喂业务门，它也不复述结构的活：两道门各守一面，谁都不吞并谁
    expect(capture(() => validateBusiness(outside as unknown as StructuredOutput, localContext()))).toBeUndefined();
  });
});

// ── ADR-006 第二道门：事实 ─────────────────────────────────────────

interface BusinessProbe {
  readonly name: string;
  readonly rule: BusinessRule;
  readonly kind: ParseErrorKind;
  readonly output: () => unknown;
  readonly context: () => BusinessValidationContext;
  readonly needle: string;
}

/** 每条都是单点变异：恰好只坏一条规则，据此证明六条规则各自可定位。 */
const BUSINESS_BROKEN: readonly BusinessProbe[] = [
  {
    name: "证据无法在发送文本中逐字回溯",
    rule: "evidence_traceable",
    kind: "evidence_unmapped",
    output: () => ({ ...validOutput(), thoughts: [{ text: "念头", evidence: "这句话根本不在输入里" }] }),
    context: () => localContext(),
    needle: "evidence_traceable",
  },
  {
    name: "证据切坏了占位符（云端映射不出原文坐标）",
    rule: "evidence_mappable_to_original",
    kind: "evidence_unmapped",
    output: () => ({ ...validCloudOutput(), thoughts: [{ text: "念头", evidence: "1_a1b2c3]去了" }] }),
    context: () => cloudContext(),
    needle: "evidence_mappable_to_original",
  },
  {
    name: "摘要里出现输入文本中没有的占位符标识",
    rule: "placeholder_untouched",
    kind: "business_validation",
    output: () => ({ ...validOutput(), title: "与 [person_9_deadbeef] 的讨论" }),
    context: () => localContext(),
    needle: "placeholder_untouched",
  },
  {
    name: "候选概念 ID 不在本地词表（模型无权新建概念，K-14）",
    rule: "candidate_id_valid",
    kind: "business_validation",
    output: () => ({ ...validOutput(), emotions: [{ ...validOutput().emotions[0]!, candidateConceptId: `${ID_PREFIXES.concept}_${"f".repeat(20)}` }] }),
    context: () => localContext(),
    needle: "不在本地词表",
  },
  {
    name: "候选概念域不匹配：情绪槽位拿到主题概念",
    rule: "candidate_id_valid",
    kind: "business_validation",
    output: () => ({ ...validOutput(), emotions: [{ ...validOutput().emotions[0]!, candidateConceptId: seedConceptId("工作与职场") }] }),
    context: () => localContext(),
    needle: "域不匹配",
  },
  {
    name: "实体候选用错前缀（概念 ID 冒充实体 ID）",
    rule: "candidate_id_valid",
    kind: "business_validation",
    output: () => ({ ...validOutput(), entities: [{ labelSaid: "项目组", candidateConceptId: seedConceptId("焦虑"), basis: "explicit", evidence: "和项目组的同事" }] }),
    context: () => localContext(),
    needle: `${ID_PREFIXES.entity}_`,
  },
  {
    name: "实体候选不在已知实体集内（匹配依据不足）",
    rule: "candidate_id_valid",
    kind: "business_validation",
    output: () => ({ ...validCloudOutput(), entities: [{ labelSaid: "张三", candidateConceptId: `${ID_PREFIXES.entity}_zhang`, basis: "explicit", evidence: `和${PH_PERSON}` }] }),
    context: () => cloudContext(),
    needle: "不在已知实体集内",
  },
  {
    name: "实体候选在所引证据里没有逐字依据",
    rule: "entity_basis_sufficient",
    kind: "business_validation",
    output: () => ({ ...validOutput(), entities: [{ labelSaid: "王总", candidateConceptId: null, basis: "explicit", evidence: "和项目组的同事" }] }),
    context: () => localContext(),
    needle: "entity_basis_sufficient",
  },
  {
    name: "时间五元组不相容：precision=day 却跨了两天",
    rule: "event_time_compatible",
    kind: "business_validation",
    output: () => ({
      ...validOutput(),
      episodes: [
        {
          summary: "讨论发布计划",
          evidence: "讨论了发布计划",
          eventTime: { raw: "最近", precision: "day", certainty: "explicit", start: "2026-10-13", end: "2026-10-14" },
        },
      ],
    }),
    context: () => localContext(),
    needle: "day 的起止必须是同一天",
  },
];

describe("ADR-006 业务门：结构合法但事实不可采信，一律由业务门单独拒", () => {
  for (const probe of BUSINESS_BROKEN) {
    it(`业务非法：${probe.name} —— 规则可定位、错误类别为 ${probe.kind}`, () => {
      const output = probe.output();
      // 先证明形状门放行，再证明业务门拒绝：两句合起来才是「两条独立的拒绝路径」
      const parsed = parseStructuredOutput(output);
      const thrown = capture(() => validateBusiness(parsed, probe.context()));
      expect(thrown, `期望业务门拒掉「${probe.name}」`).toBeInstanceOf(BusinessValidationError);
      expect(thrown).not.toBeInstanceOf(ContractSchemaError);
      const err = thrown as BusinessValidationError;
      expect(err.rule).toBe(probe.rule);
      expect(err.kind).toBe(probe.kind);
      expect(err.retryable).toBe(false);
      expect(errorKindOf(err)).toBe(probe.kind);
      expect(err.issues.join("\n"), `应点名「${probe.needle}」`).toContain(probe.needle);
      // 单点变异：除这一条规则外不该混进别的原因，否则 kind 被混类改写、断言失去定位能力
      expect(trippedRules(err)).toEqual([probe.rule]);
    });
  }

  it("六条业务规则每条都真的可拒（BUSINESS_RULES 里没有名不副实的规则）", () => {
    const covered = BUSINESS_BROKEN.map((probe) => probe.rule);
    expect(symmetricDiff(covered, [...BUSINESS_RULES]), `未覆盖或多余：${symmetricDiff(covered, [...BUSINESS_RULES]).join(",")}`).toEqual([]);
  });

  it("错误类别分流：纯证据类坏 ⇒ evidence_unmapped；混入其它 ⇒ business_validation", () => {
    const evidenceOnly = { ...validOutput(), emotions: [{ ...validOutput().emotions[0]!, evidence: "不存在的情绪依据" }] };
    const pure = capture(() => validateBusiness(parseStructuredOutput(evidenceOnly), localContext())) as BusinessValidationError;
    expect(pure).toBeInstanceOf(BusinessValidationError);
    expect(pure.kind).toBe("evidence_unmapped");
    expect(trippedRules(pure)).toEqual(["evidence_traceable"]);

    const mixed = {
      ...validOutput(),
      emotions: [{ ...validOutput().emotions[0]!, evidence: "不存在的情绪依据" }],
      topics: [{ ...validOutput().topics[0]!, candidateConceptId: `${ID_PREFIXES.concept}_${"e".repeat(20)}` }],
    };
    const both = capture(() => validateBusiness(parseStructuredOutput(mixed), localContext())) as BusinessValidationError;
    expect(both.kind).toBe("business_validation");
    expect(both.rule).toBe("evidence_traceable");
    expect(trippedRules(both).sort()).toEqual(["candidate_id_valid", "evidence_traceable"]);
  });

  it("一次调用收集全部失败而不是首错即停（M2-5 要整批生成 evidence_repair 建议）", () => {
    const broken = {
      ...validOutput(),
      thoughts: [
        { text: "念头一", evidence: "根本不在输入里的第一句" },
        { text: "念头二", evidence: "也不在输入里的第二句" },
        { text: "念头三", evidence: "讨论了发布计划" },
      ],
    };
    const err = capture(() => validateBusiness(parseStructuredOutput(broken), localContext())) as BusinessValidationError;
    expect(err.issues.length).toBe(2);
    expect(err.issues.map((line) => line.split(" — ")[0])).toEqual([
      "evidence_traceable：thoughts[0]",
      "evidence_traceable：thoughts[1]",
    ]);
  });

  it("未知/非法占位符不得映射到真实实体：擅自改动占位标识的回稿既回溯失败也不产生证据", () => {
    const tampered = { ...validCloudOutput(), emotions: [{ ...validCloudOutput().emotions[0]!, evidence: "和 [person_1_zzzz99] 去了" }] };
    const err = capture(() => validateBusiness(parseStructuredOutput(tampered), cloudContext())) as BusinessValidationError;
    expect(err).toBeInstanceOf(BusinessValidationError);
    expect(trippedRules(err).sort()).toEqual(["evidence_traceable", "placeholder_untouched"]);
    expect(err.kind).toBe("business_validation");
    // 反向对照：同一位置逐字沿用合法标识时，两道门都不说话
    expect(capture(() => validateBusiness(parseStructuredOutput(validCloudOutput()), cloudContext()))).toBeUndefined();
  });

  it("词表种子之外的概念须由调用方注入（本模块不查库，否则两道门无法脱离数据验证）", () => {
    const proposed = `${ID_PREFIXES.concept}_mine0001`;
    const output = { ...validOutput(), emotions: [{ ...validOutput().emotions[0]!, candidateConceptId: proposed }] };
    expect(capture(() => validateBusiness(output, localContext()))).toBeInstanceOf(BusinessValidationError);
    expect(capture(() => validateBusiness(output, localContext({ knownConcepts: conceptsPlus(proposed, "emotion") })))).toBeUndefined();
    expect(seedConceptIndex().get(seedConceptId("焦虑"))).toBe("emotion");
    expect(seedConceptIndex().get(seedConceptId("工作与职场"))).toBe("topic");
  });

  it("实体候选：在已知实体集内且证据里有逐字依据才放行", () => {
    const output = { ...validCloudOutput(), entities: [{ labelSaid: "张三", candidateConceptId: `${ID_PREFIXES.entity}_zhang`, basis: "explicit", evidence: `和${PH_PERSON}` }] };
    const known: ReadonlySet<string> = new Set([`${ID_PREFIXES.entity}_zhang`]);
    const result = validateBusiness(parseStructuredOutput(output), cloudContext({ knownEntityIds: known }));
    expect(result.entities[0]!.evidenceText).toBe("和张三");
    expect(result.entities[0]!.candidateConceptId).toBe(`${ID_PREFIXES.entity}_zhang`);
    // 同一回稿，实体清单没注入就被拒——依据不足不由模型自己声明
    expect(capture(() => validateBusiness(parseStructuredOutput(output), cloudContext()))).toBeInstanceOf(BusinessValidationError);
  });
});

// ── K-23：入库证据锚原文坐标 ────────────────────────────────────────

describe("K-23/B9：证据切片锚回 raw_text（云端经映射，本地两份文本同一份）", () => {
  it("云端：evidence 引用占位符本体时，入库的是原文切片与原文坐标", () => {
    const result = validateBusiness(parseStructuredOutput(validCloudOutput()), cloudContext());
    const thought = result.thoughts[0]!;
    expect(CLOUD_RAW.slice(thought.evidenceStart, thought.evidenceEnd)).toBe(thought.evidenceText);
    expect(thought.evidenceText).toBe("和张三去了");
    expect(thought.sentSlice).toBe(`和${PH_PERSON}去了`);
    expect(thought.sentSlice).not.toContain("张三");
    expect(result.emotions[0]!.evidenceText).toBe("聊了三个小时");
    expect(result.entities[0]!.evidenceText).toBe("和张三");
    expect(result.entities[0]!.labelSaid).toBe("张三");
  });

  it("本地：没有映射，发送文本就是原文，两侧坐标同一", () => {
    const result = validateBusiness(parseStructuredOutput(validOutput()), localContext());
    const all = [...result.episodes, ...result.thoughts, ...result.emotions, ...result.topics, ...result.entities];
    expect(all.length).toBe(5);
    for (const item of all) {
      expect(LOCAL_RAW.slice(item.evidenceStart, item.evidenceEnd)).toBe(item.evidenceText);
      expect(item.sentSlice).toBe(item.evidenceText);
    }
  });

  it("映射存在时切坏占位符的证据映射不出坐标——宁缺不伪，绝不静默写入伪证据", () => {
    const person = CLOUD.map.spans[0]!;
    const half = CLOUD.redactedText.slice(person.redactedStart + 2, person.redactedEnd);
    const output = { ...validCloudOutput(), thoughts: [{ text: "念头", evidence: half }] };
    const err = capture(() => validateBusiness(parseStructuredOutput(output), cloudContext())) as BusinessValidationError;
    expect(err.rule).toBe("evidence_mappable_to_original");
    expect(err.kind).toBe("evidence_unmapped");
  });
});

// ── §3.2.2 + ADR-014：写入分层 ─────────────────────────────────────

describe("§3.2.2/ADR-014：过了业务门不等于落 Mention——推断项只能进待确认队列", () => {
  function withBasis(basis: string): StructuredOutput {
    const base = validOutput();
    return {
      ...base,
      emotions: [{ ...base.emotions[0]!, basis }],
      topics: [{ ...base.topics[0]!, basis }],
      entities: [{ ...base.entities[0]!, basis }],
    };
  }

  it("basis=explicit 三类都落 mention；inferred 的情绪落 emotion_candidate 建议", () => {
    const explicit = validateBusiness(parseStructuredOutput(withBasis("explicit")), localContext());
    for (const item of [explicit.emotions[0]!, explicit.topics[0]!, explicit.entities[0]!]) {
      expect(item.route).toBe("mention");
      expect(item.suggestionKind).toBeNull();
    }
    const inferred = validateBusiness(parseStructuredOutput(withBasis("inferred")), localContext());
    expect(inferred.emotions[0]!.route).toBe("suggestion");
    expect(inferred.emotions[0]!.suggestionKind).toBe("emotion_candidate");
  });

  it("inferred 的主题/实体不发明 suggestion kind：unrouted 交 M2-5/§3.4 裁决", () => {
    const inferred = validateBusiness(parseStructuredOutput(withBasis("inferred")), localContext());
    for (const item of [inferred.topics[0]!, inferred.entities[0]!]) {
      expect(item.route).toBe("unrouted");
      expect(item.suggestionKind).toBeNull();
    }
  });

  it("candidateConceptId 逐字保留、无写入权限（归一化由解析器决定，K-14）", () => {
    const proposed = `${ID_PREFIXES.concept}_${"a".repeat(8)}`;
    const output = { ...validOutput(), emotions: [{ ...validOutput().emotions[0]!, candidateConceptId: proposed }] };
    const result = validateBusiness(parseStructuredOutput(output), localContext({ knownConcepts: conceptsPlus(proposed, "emotion") }));
    expect(result.emotions[0]!.candidateConceptId).toBe(proposed);
    expect(result.emotions[0]!.labelSaid).toBe("焦虑");
    expect(result.emotions[0]!.basis).toBe("explicit");
    expect(result.title).toBe("关于发布计划的讨论");
  });
});

// ── §3.8/B8/P14：时间五元组 ────────────────────────────────────────

describe("§3.8/B8/P14：eventTime 相容性判定（业务门提前拒，不等库里 CHECK）", () => {
  function probe(time: { readonly [key: string]: string | null }): string[] {
    return eventTimeViolations({
      raw: "今天",
      precision: "day",
      certainty: "explicit",
      start: "2026-10-13",
      end: "2026-10-13",
      ...time,
    });
  }

  it("unknown ⇒ 起止皆空且 certainty=unknown；否则不相容", () => {
    expect(probe({ precision: "unknown", certainty: "unknown", start: null, end: null })).toEqual([]);
    expect(probe({ precision: "unknown", certainty: "unknown", raw: null, start: null, end: null })).toEqual([]);
    for (const bad of [
      { certainty: "explicit", start: null, end: null },
      { certainty: "unknown", start: "2026-10-13", end: "2026-10-13" },
      { certainty: "unknown", start: null, end: "2026-10-13" },
    ]) {
      expect(probe({ precision: "unknown", ...bad }).length).toBeGreaterThan(0);
    }
  });

  it("year/month/day 各自要求完整覆盖、raw 非空、起止齐全且 start<=end", () => {
    expect(probe({ precision: "year", start: "2026-01-01", end: "2026-12-31" })).toEqual([]);
    expect(probe({ precision: "year", start: "2026-01-02", end: "2026-12-31" }).length).toBe(1);
    expect(probe({ precision: "month", start: "2026-03-01", end: "2026-03-31" })).toEqual([]);
    expect(probe({ precision: "month", start: "2026-02-01", end: "2026-02-28" })).toEqual([]);
    expect(probe({ precision: "month", start: "2028-02-01", end: "2028-02-29" }), "闰年 2 月覆盖到 29 才算精确").toEqual([]);
    expect(probe({ precision: "month", start: "2028-02-01", end: "2028-02-28" }).length).toBe(1);
    expect(probe({ precision: "month", start: "2026-03-01", end: "2026-04-30" }).length).toBe(1);
    expect(probe({ raw: null, precision: "day" })).not.toEqual([]);
    expect(probe({ precision: "day", certainty: "unknown" }).length).toBe(1);
    expect(probe({ precision: "day", start: null, end: null }).length).toBe(1);
    expect(probe({ precision: "day", start: "2026-10-14", end: "2026-10-13" }).length).toBe(1);
  });

  it("每条 enums 精度 × 确定性组合都给出可判定的结论（不抛、不静默放行未知组合）", () => {
    for (const precision of CONTRACTS.enums.event_time_precision) {
      for (const certainty of CONTRACTS.enums.event_time_certainty) {
        const violations = probe({ precision, certainty });
        expect(Array.isArray(violations)).toBe(true);
        const full = probe({ precision, certainty, start: "2026-01-01", end: "2026-12-31" });
        if (precision === "unknown" || certainty === "unknown") expect(full.length).toBeGreaterThan(0);
      }
    }
  });
});

// ── 封闭错误分类（对账 0003）───────────────────────────────────────

describe("封闭错误分类：PARSE_ERROR_KINDS == 0003 的 error_kind CHECK，每项有可重试性条目", () => {
  /** 从迁移 SQL 提出 error_kind 的取值清单——不硬编码第二份清单（T-16 手法）。 */
  function errorKindsFromMigration(): string[] {
    const sql = readFileSync(MIGRATION_0003, "utf8");
    const block = /error_kind TEXT CHECK \(\s*error_kind IS NULL\s*OR error_kind IN \(([\s\S]*?)\)\s*\)/.exec(sql);
    if (block === null) throw new Error("未能在 0003 里定位 parse_run.error_kind 的 CHECK");
    return [...block[1]!.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
  }

  it("服务侧清单与迁移 CHECK 逐项相等且同序", () => {
    expect([...PARSE_ERROR_KINDS]).toEqual(errorKindsFromMigration());
    expect(PARSE_ERROR_KINDS.length).toBe(7);
  });

  it("ERROR_RETRYABILITY 的定义域恰好等于封闭错误集：多一个少一个都要红", () => {
    const keys = Object.keys(ERROR_RETRYABILITY);
    expect(symmetricDiff(keys, [...PARSE_ERROR_KINDS]), `差集：${symmetricDiff(keys, [...PARSE_ERROR_KINDS]).join(",")}`).toEqual([]);
    expect(keys.length).toBe(PARSE_ERROR_KINDS.length);
    for (const kind of PARSE_ERROR_KINDS) expect(typeof ERROR_RETRYABILITY[kind]).toBe("boolean");
  });

  it("可重试性只给瞬时故障；取消是用户动作不是故障，结构/业务/解析类一律不自动重试", () => {
    expect({ network: ERROR_RETRYABILITY.network, timeout: ERROR_RETRYABILITY.timeout }).toEqual({ network: true, timeout: true });
    for (const kind of ["invalid_json", "business_validation", "provider_schema", "cancelled", "evidence_unmapped"] as const) {
      expect(ERROR_RETRYABILITY[kind], `kind=${kind} 应不可自动重试`).toBe(false);
    }
  });

  it("两道门与降级路径抛出的 kind 都落在封闭集内（errorKindOf 是唯一收敛点）", () => {
    const schemaErr = capture(() => parseStructuredOutput({ nope: 1 })) as ContractSchemaError;
    const businessErr = capture(() =>
      validateBusiness({ ...validOutput(), thoughts: [{ text: "x", evidence: "不在输入里" }] }, localContext()),
    ) as BusinessValidationError;
    for (const err of [schemaErr, businessErr]) {
      const kind = (err as { kind: ParseErrorKind }).kind;
      expect((PARSE_ERROR_KINDS as readonly string[]).includes(kind)).toBe(true);
      expect(errorKindOf(err)).toBe(kind);
      expect((err as { retryable: boolean }).retryable).toBe(ERROR_RETRYABILITY[kind]);
    }
    // InvalidJsonError 属容错提取层：它不进 Trace，由 Provider 收敛成 ProviderError("invalid_json")
    const jsonErr = capture(() => extractJson("纯散文")) as InvalidJsonError;
    expect((PARSE_ERROR_KINDS as readonly string[]).includes(jsonErr.kind)).toBe(true);
    expect(jsonErr.retryable).toBe(ERROR_RETRYABILITY[jsonErr.kind]);
    expect(errorKindOf(jsonErr)).toBeNull();
    expect(errorKindOf(new Error("契约外的异常"))).toBeNull();
  });

  it("ProviderError 的 kind 受封闭集约束，diagnostics 只放安全诊断", () => {
    const err = new ProviderError("timeout", "超时了", { timeout_ms: 2000 });
    expect(err.kind).toBe("timeout");
    expect(err.retryable).toBe(true);
    expect(new ProviderError("network", "n", {}, false).retryable).toBe(false);
    expect(err.diagnostics["timeout_ms"]).toBe(2000);
    expect(err.name).toBe("ProviderError");
  });

  it("三条调用路径是封闭集，取值逐字取指令 §6.2", () => {
    expect([...PROVIDER_CALL_PATHS]).toEqual(["sdk_structured", "http_json_lenient", "ollama_openai_compatible"]);
  });
});

// ── 处理模式闸门 ────────────────────────────────────────────────────

describe("§5.2/§11-隐私：处理模式闸门——「不该发」在物理上就是零次调用", () => {
  for (const callPath of PROVIDER_CALL_PATHS) {
    it(`manual_only 不调用任何模型（路径 ${callPath}）`, async () => {
      const t = fakeTransport(() => envelope("{}"));
      const err = await expectRejected(
        () => invokeExtraction(makeAdapter({ callPath }), makeRequest({ processingMode: "manual_only" }), t.transport),
        /manual_only 不调用任何模型/,
      );
      expect(err).toBeInstanceOf(ProcessingModeError);
      expect((err as ProcessingModeError).reason).toBe("manual_only");
      expect((err as ProcessingModeError).recordRevisionId).toBe("rev_fixture_1");
      expect(t.calls()).toBe(0);
    });
  }

  it("local_model 只允许回环端点：非回环在发送前就拒，且拒绝消息不回显载荷", async () => {
    const t = fakeTransport(() => envelope("{}"));
    const err = await expectRejected(
      () => invokeExtraction(makeAdapter({ baseUrl: "https://api.example.com/v1" }), makeRequest({ processingMode: "local_model" }), t.transport),
      /不是回环地址/,
    );
    expect(err).toBeInstanceOf(ProcessingModeError);
    expect((err as ProcessingModeError).reason).toBe("local_model_egress");
    expect(t.calls()).toBe(0);
    expect((err as Error).message).not.toContain(LOCAL_RAW);
  });

  it("isLoopbackUrl 正反例：按 hostname 精确比对，不做前缀匹配，缺 scheme 不算回环", () => {
    for (const url of [
      "http://127.0.0.1:11434/v1",
      "http://localhost:11434",
      "http://[::1]:11434/v1",
      "http://127.0.0.1",
      "http://localhost:8080/v1/chat/completions",
    ]) {
      expect(isLoopbackUrl(url), `期望回环：${url}`).toBe(true);
    }
    for (const url of [
      "https://api.openai.com/v1",
      "http://192.168.1.5:11434",
      "http://127.0.0.1.evil.example/v1",
      "http://attacker.example/?target=http://127.0.0.1",
      "127.0.0.1:11434",
      "not a url",
      "",
    ]) {
      expect(isLoopbackUrl(url), `期望非回环：${url}`).toBe(false);
    }
  });

  it("cloud_redacted 缺本次授权不得发出请求（闸门由调用方注入，本模块不查库）", async () => {
    const t = fakeTransport(() => jsonEnvelope(validOutput()));
    const withoutGate = await expectRejected(
      () => invokeExtraction(makeAdapter(), makeRequest({ processingMode: "cloud_redacted" }), t.transport),
      /必须提供本次授权闸门/,
    );
    expect(withoutGate).toBeInstanceOf(ProcessingModeError);
    expect((withoutGate as ProcessingModeError).reason).toBe("cloud_grant_missing");

    const denied = await expectRejected(
      () =>
        invokeExtraction(makeAdapter(), makeRequest({ processingMode: "cloud_redacted" }), t.transport, {
          requireGrant: () => {
            throw new Error("没有适用授权");
          },
        }),
      /缺本次发送授权/,
    );
    expect(denied).toBeInstanceOf(ProcessingModeError);
    expect((denied as ProcessingModeError).reason).toBe("cloud_grant_missing");
    expect((denied as Error).message).toContain("没有适用授权");
    expect((denied as Error).message).not.toContain(LOCAL_RAW);
    expect(t.calls()).toBe(0);
  });

  it("授权闸门排在传输之前：有授权才发出一次请求，顺序可证", async () => {
    const order: string[] = [];
    const t = fakeTransport(() => jsonEnvelope(validOutput()));
    const outcome = await invokeExtraction(makeAdapter(), makeRequest({ processingMode: "cloud_redacted" }), t.transport, {
      requireGrant: () => {
        order.push("grant");
      },
    });
    order.push("send");
    expect(order).toEqual(["grant", "send"]);
    expect(t.calls()).toBe(1);
    expect(outcome.attemptedPaths).toEqual(["ollama_openai_compatible"]);
  });

  it("assertCloudGranted 只管云端；assertSendable 只管本地/手工，二者不互相顶班", () => {
    expect(() =>
      assertCloudGranted(makeRequest({ processingMode: "local_model" }), () => {
        throw new Error("不该被调用");
      }),
    ).not.toThrow();
    expect(() =>
      assertCloudGranted(makeRequest({ processingMode: "cloud_redacted" }), () => {
        throw new Error("没有适用授权");
      }),
    ).toThrow(/缺本次发送授权/);
    expect(() => assertSendable(makeRequest({ processingMode: "cloud_redacted" }), makeAdapter({ baseUrl: "https://cloud.example.com/v1" }))).not.toThrow();
    expect(() => assertSendable(makeRequest({ processingMode: "manual_only" }), makeAdapter())).toThrow(/manual_only 不调用任何模型/);
  });
});

// ── 三调用路径 ──────────────────────────────────────────────────────

describe("§6.2/§9.4：三条调用路径的请求形态与结果收敛（结构化能力是声明出来的）", () => {
  it("sdk_structured：声明支持结构化输出才带 json_schema 响应格式", async () => {
    const t = fakeTransport(() => jsonEnvelope(validOutput()));
    const outcome = await invokeExtraction(
      makeAdapter({ callPath: "sdk_structured", supportsStructuredOutput: true, baseUrl: "https://cloud.example.com/v1" }),
      makeRequest({ processingMode: "cloud_redacted" }),
      t.transport,
      { requireGrant: () => undefined },
    );
    expect(outcome.callPath).toBe("sdk_structured");
    expect(outcome.attemptedPaths).toEqual(["sdk_structured"]);
    expect(outcome.degraded).toBe(false);
    expect(outcome.json).toEqual(validOutput() as unknown as JsonObject);
    const body = t.requests[0]!.body;
    expect(body["response_format"]).toEqual({ type: "json_schema", name: "m2-output-v1" });
    expect(body["model"]).toBe("qwen2.5:7b");
    expect(body["stream"]).toBe(false);
    expect(t.requests[0]!.callPath).toBe("sdk_structured");
  });

  it("http_json_lenient：只要求 json_object，回稿带围栏也解析成对象", async () => {
    const t = fakeTransport(() => fencedJsonEnvelope(validOutput()));
    const outcome = await invokeExtraction(
      makeAdapter({ callPath: "http_json_lenient", baseUrl: "https://cloud.example.com/v1" }),
      makeRequest({ processingMode: "cloud_redacted" }),
      t.transport,
      { requireGrant: () => undefined },
    );
    expect(t.requests[0]!.body["response_format"]).toEqual({ type: "json_object" });
    expect(outcome.attemptedPaths).toEqual(["http_json_lenient"]);
    expect(outcome.degraded).toBe(false);
    expect(outcome.json["title"]).toBe("关于发布计划的讨论");
    expect(outcome.json).not.toBeTypeOf("string");
  });

  it("ollama_openai_compatible：本地端点归一到 chat/completions（/v1 结尾与不带结尾同一路径）", async () => {
    const t = fakeTransport(() => jsonEnvelope(validOutput()));
    for (const [baseUrl, expected] of [
      ["http://127.0.0.1:11434/v1", "http://127.0.0.1:11434/v1/chat/completions"],
      ["http://127.0.0.1:11434/v1/", "http://127.0.0.1:11434/v1/chat/completions"],
      ["http://localhost:11434", "http://localhost:11434/chat/completions"],
      ["http://127.0.0.1:11434/v1/chat/completions", "http://127.0.0.1:11434/v1/chat/completions"],
    ] as const) {
      t.reset();
      const outcome = await invokeExtraction(makeAdapter({ baseUrl }), makeRequest(), t.transport);
      expect(t.requests[0]!.url, `baseUrl=${baseUrl}`).toBe(expected);
      expect(outcome.attemptedPaths).toEqual(["ollama_openai_compatible"]);
    }
  });

  it("请求体只带 system + 待发送文本与声明的参数；映射永不下发", async () => {
    const t = fakeTransport(() => jsonEnvelope(validOutput()));
    await invokeExtraction(
      makeAdapter({ params: { temperature: 0, num_ctx: 4096 } }),
      makeRequest({ payloadText: CLOUD.redactedText, processingMode: "cloud_redacted", redactionMap: redactionMapJsonValue(CLOUD.map) }),
      t.transport,
      { requireGrant: () => undefined },
    );
    const body = t.requests[0]!.body as unknown as { messages: Array<{ role: string; content: string }> };
    expect(body.messages).toEqual([
      { role: "system", content: "你是提取器，只输出 JSON。" },
      { role: "user", content: CLOUD.redactedText },
    ]);
    expect(t.requests[0]!.body["num_ctx"]).toBe(4096);
    const serialized = JSON.stringify(t.requests[0]!.body);
    expect(serialized).not.toContain("redactionMap");
    expect(serialized).not.toContain("originalStart");
    expect(serialized).not.toContain("spans");
    expect(serialized).not.toContain("policyVersion");
    expect(serialized).not.toContain(CLOUD_RAW);
    // 真实词面只能靠映射换回：请求体里出现占位符是设计（§7.2），出现词面就是泄露
    expect(serialized).not.toContain("张三");
    expect(serialized).not.toContain("蓝山咖啡馆");
  });

  it("密钥只在发送那一刻从环境变量名取值；未设置时不带 authorization 头", async () => {
    const t = fakeTransport(() => jsonEnvelope(validOutput()));
    await invokeExtraction(makeAdapter({ apiKeyEnv: API_KEY_ENV }), makeRequest(), t.transport);
    expect(t.requests[0]!.headers["authorization"]).toBeUndefined();
    expect(t.requests[0]!.headers["content-type"]).toBe("application/json");

    process.env[API_KEY_ENV] = ENV_API_KEY;
    const withKey = fakeTransport(() => jsonEnvelope(validOutput()));
    await invokeExtraction(makeAdapter({ apiKeyEnv: API_KEY_ENV }), makeRequest(), withKey.transport);
    expect(withKey.requests[0]!.headers["authorization"]).toBe(`Bearer ${ENV_API_KEY}`);
  });

  it("声明支持结构化输出但走本地/容错路径：不启用 json_schema，也不产生降级", async () => {
    const t = fakeTransport(() => jsonEnvelope(validOutput()));
    const outcome = await invokeExtraction(makeAdapter({ callPath: "ollama_openai_compatible", supportsStructuredOutput: true }), makeRequest(), t.transport);
    expect(t.requests[0]!.body["response_format"]).toEqual({ type: "json_object" });
    expect(outcome.attemptedPaths).toEqual(["ollama_openai_compatible"]);
    expect(outcome.degraded).toBe(false);
  });

  it("Provider/模型标识随结果返回，供 Trace 记录（指令 §11.1）", async () => {
    const t = fakeTransport(() => jsonEnvelope(validOutput()));
    const outcome = await invokeExtraction(makeAdapter({ provider: "openai_compatible", model: "gpt-fixture" }), makeRequest(), t.transport);
    expect({ provider: outcome.provider, model: outcome.model }).toEqual({ provider: "openai_compatible", model: "gpt-fixture" });
  });
});

// ── 降级路径（ADR-006 Consequences）───────────────────────────────

describe("ADR-006：结构化输出未生效时降级到容错提取，所走路径与原因可记录", () => {
  it("拿不回可用信封 ⇒ 改走容错路径再试一次，attemptedPaths 按顺序留痕", async () => {
    const t = fakeTransport((attempt) => (attempt === 1 ? { status: 200, body: JSON.stringify({ result: "没有 choices" }) } : fencedJsonEnvelope(validOutput())));
    const outcome = await invokeExtraction(
      makeAdapter({ callPath: "sdk_structured", supportsStructuredOutput: true, baseUrl: "https://cloud.example.com/v1" }),
      makeRequest({ processingMode: "cloud_redacted" }),
      t.transport,
      { requireGrant: () => undefined },
    );
    expect(outcome.attemptedPaths).toEqual(["sdk_structured", "http_json_lenient"]);
    expect(outcome.degraded).toBe(true);
    expect(outcome.degradationReason).toMatch(/provider_schema/);
    expect(t.requests[1]!.body["response_format"]).toEqual({ type: "json_object" });
    expect(t.calls()).toBe(2);
    expect(outcome.json).toEqual(validOutput() as unknown as JsonObject);
  });

  it("信封本身不合结构也是 provider_schema（与「内容不是 JSON」的 invalid_json 区分开）", async () => {
    for (const body of ["不是 JSON", JSON.stringify({ choices: [] }), JSON.stringify({ choices: [{ message: { content: "   " } }] })]) {
      const t = fakeTransport(() => ({ status: 200, body }));
      const err = await expectRejected(() => invokeExtraction(makeAdapter({ callPath: "http_json_lenient" }), makeRequest(), t.transport), /Provider 响应|回稿字段/);
      expect(err).toBeInstanceOf(ProviderError);
      expect((err as ProviderError).kind).toBe("provider_schema");
      expect((err as ProviderError).retryable).toBe(false);
      expect(t.calls()).toBe(1);
    }
  });

  it("传输类失败不降级：只有「拿得到响应但结构不合」才值得再试一次", async () => {
    const t = fakeTransport(() => new Error("socket hang up"));
    const err = await expectRejected(
      () =>
        invokeExtraction(
          makeAdapter({ callPath: "sdk_structured", supportsStructuredOutput: true, baseUrl: "https://cloud.example.com/v1" }),
          makeRequest({ processingMode: "cloud_redacted" }),
          t.transport,
          { requireGrant: () => undefined },
        ),
      /模型调用未能完成/,
    );
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).kind).toBe("network");
    expect((err as ProviderError).retryable).toBe(true);
    expect(t.calls()).toBe(1);
  });

  it("两条路径的结果走同一对门：Provider 不做业务校验，也不绕过它", async () => {
    const bogus = { ...validOutput(), thoughts: [{ text: "念头", evidence: "这句话根本不在输入里" }] };
    const t = fakeTransport(() => fencedJsonEnvelope(bogus));
    const outcome = await invokeExtraction(makeAdapter({ callPath: "http_json_lenient" }), makeRequest(), t.transport);
    expect(outcome.json).toEqual(bogus as unknown as JsonObject);
    const err = capture(() => validateBusiness(parseStructuredOutput(outcome.json), localContext())) as BusinessValidationError;
    expect(err).toBeInstanceOf(BusinessValidationError);
    expect(err.kind).toBe("evidence_unmapped");
    // 换一条路径结论不变：门与路径无关
    const t2 = fakeTransport(() => jsonEnvelope(bogus));
    const viaOllama = await invokeExtraction(makeAdapter({ callPath: "ollama_openai_compatible" }), makeRequest(), t2.transport);
    const err2 = capture(() => validateBusiness(parseStructuredOutput(viaOllama.json), localContext())) as BusinessValidationError;
    expect(err2.kind).toBe("evidence_unmapped");
  });

  it("HTTP 状态归并进封闭分类 network，原因留在 diagnostics；429/5xx 可重试、其余 4xx 不可", async () => {
    for (const [status, retryable] of [
      [400, false],
      [401, false],
      [404, false],
      [429, true],
      [500, true],
      [503, true],
    ] as const) {
      const t = fakeTransport(() => ({ status, body: "网关错误" }));
      const err = await expectRejected(() => invokeExtraction(makeAdapter(), makeRequest(), t.transport), /非成功状态/);
      expect(err).toBeInstanceOf(ProviderError);
      const providerErr = err as ProviderError;
      expect(providerErr.kind).toBe("network");
      expect(providerErr.retryable, `status=${status}`).toBe(retryable);
      expect(providerErr.diagnostics["status"]).toBe(status);
      expect(t.calls()).toBe(1);
    }
  });

  it("回稿不是 JSON 对象 ⇒ invalid_json，诊断记所走路径而不回显模型原文", async () => {
    const modelText = "抱歉，我无法理解这段内容：" + LOCAL_RAW;
    const t = fakeTransport(() => envelope(modelText));
    const err = await expectRejected(() => invokeExtraction(makeAdapter(), makeRequest(), t.transport), /无法解析为 JSON 对象/);
    expect(err).toBeInstanceOf(ProviderError);
    const providerErr = err as ProviderError;
    expect(providerErr.kind).toBe("invalid_json");
    expect(providerErr.retryable).toBe(false);
    expect(providerErr.diagnostics["attempted_paths"]).toBe("ollama_openai_compatible");
    expect(providerErr.diagnostics["degraded"]).toBe(false);
    expect(providerErr.message).not.toContain(LOCAL_RAW);
    expect(JSON.stringify(providerErr.diagnostics)).not.toContain(modelText);
  });

  it("降级后仍拿不到对象：路径串包含两步、degraded 为真", async () => {
    const t = fakeTransport((attempt) => (attempt === 1 ? { status: 200, body: "{}" } : envelope("纯散文，没有 JSON")));
    const err = await expectRejected(
      () =>
        invokeExtraction(
          makeAdapter({ callPath: "sdk_structured", supportsStructuredOutput: true, baseUrl: "https://cloud.example.com/v1" }),
          makeRequest({ processingMode: "cloud_redacted" }),
          t.transport,
          { requireGrant: () => undefined },
        ),
      /无法解析为 JSON 对象/,
    );
    expect((err as ProviderError).diagnostics["attempted_paths"]).toBe("sdk_structured>http_json_lenient");
    expect((err as ProviderError).diagnostics["degraded"]).toBe(true);
    expect(t.calls()).toBe(2);
  });
});

// ── 超时与取消 ──────────────────────────────────────────────────────

describe("§5.5/§6.4：超时与取消是两条独立路径，均可注入、都不依赖真实网络", () => {
  it("超时：到点中止、只尝试一次、类别 timeout 且可重试", async () => {
    const t = fakeTransport(neverSettles);
    const started = Date.now();
    const err = await expectRejected(() => invokeExtraction(makeAdapter({ requestTimeoutMs: 20 }), makeRequest(), t.transport), /模型调用超时/);
    const providerErr = err as ProviderError;
    expect(providerErr.kind).toBe("timeout");
    expect(providerErr.retryable).toBe(ERROR_RETRYABILITY.timeout);
    expect(providerErr.diagnostics["timeout_ms"]).toBe(20);
    expect(t.calls()).toBe(1);
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it("取消（发出前）：调用方已 abort ⇒ 零次传输调用、类别 cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const t = fakeTransport(neverSettles);
    const err = await expectRejected(() => invokeExtraction(makeAdapter(), makeRequest({ signal: controller.signal }), t.transport), /在发出请求前已取消/);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).kind).toBe("cancelled");
    expect((err as ProviderError).retryable).toBe(ERROR_RETRYABILITY.cancelled);
    expect(t.calls()).toBe(0);
  });

  it("取消（发出后）：in-flight abort ⇒ cancelled，与超时区分开（超时计时器留得更长）", async () => {
    const controller = new AbortController();
    const t = fakeTransport(neverSettles);
    const pending = invokeExtraction(makeAdapter({ requestTimeoutMs: 2000 }), makeRequest({ signal: controller.signal }), t.transport);
    setTimeout(() => controller.abort(), 10);
    const err = await expectRejected(() => pending, /调用方取消了本次模型请求/);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).kind).toBe("cancelled");
    expect((err as ProviderError).retryable).toBe(false);
    expect(t.calls()).toBe(1);
  });

  it("取消与超时都不自动重发：一次调用最多两条路径（结构化 + 容错），没有第三次", async () => {
    const controller = new AbortController();
    const t = fakeTransport(neverSettles);
    const pending = invokeExtraction(
      makeAdapter({ callPath: "sdk_structured", supportsStructuredOutput: true, baseUrl: "https://cloud.example.com/v1", requestTimeoutMs: 2000 }),
      makeRequest({ processingMode: "cloud_redacted", signal: controller.signal }),
      t.transport,
      { requireGrant: () => undefined },
    );
    setTimeout(() => controller.abort(), 10);
    await expectRejected(() => pending, /取消/);
    expect(t.calls()).toBe(1);
  });

  it("超时/取消都以错误上抛：不吞异常、不丢原文（夹具文本原样在场）", async () => {
    const t = fakeTransport(neverSettles);
    await expectRejected(() => invokeExtraction(makeAdapter({ requestTimeoutMs: 15 }), makeRequest({ payloadText: LOCAL_RAW }), t.transport), /超时/);
    expect(t.requests[0]!.body).toBeTruthy();
    expect(LOCAL_RAW).toBe("今天和项目组的同事讨论了发布计划，我感到焦虑");
  });
});

// ── T-33（manifest 侧）：产物字段集合封闭 ───────────────────────────

describe("T-33（manifest 侧）：buildRunManifest 产物的字段集合恰好等于契约九项", () => {
  const input = {
    promptVersion: "m2-prompt-v1",
    outputSchemaVersion: "m2-output-v1",
    provider: "ollama",
    model: "qwen2.5:7b",
    params: { temperature: 0 },
    contractsFingerprint: HEX64,
    resolverVersion: "resolver-v1",
    validationVersion: "validation-v1",
    redactionMap: redactionMapJsonValue(CLOUD.map),
  };

  it("产物键集合 == PIPELINE_MANIFEST_FIELDS；少一项被构造门拒，多一项也被拒", () => {
    const manifest = buildRunManifest(input);
    const produced = Object.keys(manifest);
    expect(produced.length).toBe(9);
    expect(symmetricDiff(produced, [...PIPELINE_MANIFEST_FIELDS])).toEqual([]);

    const stripped: JsonObject = { ...manifest };
    delete stripped["prompt"];
    expectThrown(() => buildPipelineManifest(stripped), /缺字段：prompt/);
    expectThrown(() => buildPipelineManifest(stripped), /字段集合不封闭/);
    expectThrown(() => buildPipelineManifest({ ...manifest, tenth: "自作主张" }), /契约外字段：tenth/);
    for (const field of PIPELINE_MANIFEST_FIELDS) {
      const missing: JsonObject = { ...manifest };
      delete missing[field];
      expectThrown(() => buildPipelineManifest(missing), new RegExp(`缺字段：${field}`));
    }
  });

  it("入参混进契约外字段也不会长成第十项：产物键集合仍是九项", () => {
    const sneaky = { ...input, rawText: LOCAL_RAW, intensity: 5, tenth: 1 } as unknown as typeof input;
    const manifest = buildRunManifest(sneaky);
    expect(symmetricDiff(Object.keys(manifest), [...PIPELINE_MANIFEST_FIELDS])).toEqual([]);
    const serialized = JSON.stringify(manifest);
    expect(serialized).not.toContain(LOCAL_RAW);
    expect(serialized).not.toContain("tenth");
    expect(serialized).not.toContain("intensity");
  });

  it("契约指纹落在 validation 之内，不是第十个键（九项封闭，它只能是某一项的值）", () => {
    const manifest = buildRunManifest(input);
    expect(manifest.validation).toEqual({ version: "validation-v1", contracts_fingerprint: HEX64 });
    for (const invented of ["contracts_fingerprint", "fingerprint", "rawText", "trace"]) {
      expect((PIPELINE_MANIFEST_FIELDS as readonly string[]).includes(invented), `不该有第十项：${invented}`).toBe(false);
    }
  });

  it("逐项对应：prompt/schema/resolver 以 version 承载，redaction 取策略版本，映射原样进第九项", () => {
    const manifest = buildRunManifest(input);
    expect(manifest.prompt).toEqual({ version: "m2-prompt-v1" });
    expect(manifest.schema).toEqual({ version: "m2-output-v1" });
    expect(manifest.resolver).toEqual({ version: "resolver-v1" });
    expect(manifest.provider).toBe("ollama");
    expect(manifest.model).toBe("qwen2.5:7b");
    expect(manifest.params).toEqual({ temperature: 0 });
    expect(manifest.redaction).toBe(REDACTION_POLICY_VERSION);
    expect(canonicalJson(manifest.redactionMap as JsonValue)).toBe(canonicalJson(redactionMapJsonValue(CLOUD.map) as JsonValue));
    for (const field of PIPELINE_MANIFEST_FIELDS) {
      expect(manifest[field], `九项皆非空：${field}`).not.toBeUndefined();
      expect(manifest[field]).not.toBeNull();
    }
  });

  it("本地路径没有映射也必须显式给第九项，而不是让字段缺席", () => {
    const local = buildRunManifest({ ...input, redactionMap: {} });
    expect(symmetricDiff(Object.keys(local), [...PIPELINE_MANIFEST_FIELDS])).toEqual([]);
    expect(local.redactionMap).toEqual({});
    const withoutMap: JsonObject = { ...local };
    delete withoutMap["redactionMap"];
    expectThrown(() => buildPipelineManifest(withoutMap), /缺字段：redactionMap/);
  });

  it("同一组入参 ⇒ 同一指纹；只换一次性随机量 ⇒ 指纹不变（映射不参与哈希）", () => {
    const once = pipelineFingerprint(buildRunManifest(input));
    expect(pipelineFingerprint(buildRunManifest(input))).toBe(once);
    const otherNonce = redact(CLOUD_RAW, CLOUD_ENTITIES, { nonce: "ff00ff" });
    const remapped = buildRunManifest({ ...input, redactionMap: redactionMapJsonValue(otherNonce.map) });
    expect(pipelineFingerprint(remapped)).toBe(once);
    expect(pipelineManifestLocalJson(remapped)).not.toBe(pipelineManifestLocalJson(buildRunManifest(input)));
    expect(pipelineManifestLocalJson(buildRunManifest(input))).toContain("redactionMap");
  });
});

// ── 离线与不写日志纪律 ─────────────────────────────────────────────

describe("Provider/契约模块自身：不发请求、不写日志、不碰库", () => {
  it("源码里没有网络客户端，也没有日志出口（传输靠注入）", () => {
    for (const file of [PROVIDER_SOURCE, CONTRACT_SOURCE, EXTRACT_SOURCE]) {
      const source = readFileSync(file, "utf8");
      expect(source, `${file} 不应出现网络出口`).not.toMatch(/fetch\(|node:https?|node:net|XMLHttpRequest|undici/);
      expect(source, `${file} 不应写日志`).not.toMatch(/console\.|process\.stdout|process\.stderr/);
      expect(source, `${file} 不应直接读写库`).not.toMatch(/\.\.\/db\/|node:sqlite|prepare\(|\.run\(/);
    }
  });

  it("provider 不 import 业务校验：门在 contract.ts，由调用方（M2-5）串起来", () => {
    const source = readFileSync(PROVIDER_SOURCE, "utf8");
    expect(source).not.toMatch(/from "\.\/contract\.ts"/);
    expect(source).toMatch(/from "\.\/extractJson\.ts"/);
  });
});
