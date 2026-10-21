import { RecordService } from "../../src/server/records/service.ts";
import { seedConceptId } from "../../src/shared/contracts/ids.ts";
import { redact, type KnownEntity } from "../../src/server/privacy/redaction.ts";
import type { Database } from "../../src/server/db/adapter.ts";
import type { StructuredOutput } from "../../src/server/ingest/contract.ts";
import type { ModelAdapter, ProviderCallPath, ProviderTransport, TransportRequest, TransportResponse } from "../../src/server/ingest/provider.ts";

/**
 * M2-5 Ingest 服务面测试的共用夹具。
 *
 * 存在的前提是 **崩溃夹具与测试父进程必须算出同一个幂等键**（§7.1）：键由
 * `f(revision, pipeline_fingerprint)` 决定，而指纹来自九项 manifest——两份适配器配置
 * 只要有一个字节不同，「同键重放」就变成「新任务」。所以适配器、版本串、回稿文本
 * 在这里只写一遍，被测双方各自 import，不各抄一份。
 *
 * 全程离线：模型调用一律由注入的 `ProviderTransport` 假实现驱动。
 */

export const FIXTURE_NOW = "2026-10-14T02:00:00.000Z";
export const FIXTURE_TIMEZONE = "Asia/Shanghai";

/** 本地路径：发送文本 == 原文，没有脱敏映射（Spec §5.1 第 4 步的脱敏只对云端成立）。 */
export const LOCAL_RAW = "今天和项目组的同事讨论了发布计划，我感到焦虑";
/** 云端路径：原文含两处可脱敏内容（人名、店名）。 */
export const CLOUD_RAW = "周末和张三去了蓝山咖啡馆，聊了三个小时";

export const ANXIETY_CONCEPT = seedConceptId("焦虑");
export const WORK_CONCEPT = seedConceptId("工作与职场");

/** 云端夹具的已知实体清单与一次性 nonce：映射与回稿必须同源，否则占位符对不上。 */
export const CLOUD_NONCE = "a1b2c3";
export const CLOUD_ENTITIES: readonly KnownEntity[] = [
  { entityId: "entity_zhang", entityType: "person", terms: ["张三"] },
  { entityId: "entity_store", entityType: "organization", terms: ["蓝山咖啡馆"] },
];
export const CLOUD = redact(CLOUD_RAW, CLOUD_ENTITIES, { nonce: CLOUD_NONCE });
export const PH_PERSON = CLOUD.map.spans[0]!.placeholder; // [person_1_a1b2c3]
export const PH_ORG = CLOUD.map.spans[1]!.placeholder; // [organization_1_a1b2c3]

/** 结构合法、业务合法的回稿基线——每条负例都由它**单点**变异而来。 */
export function validOutput(): StructuredOutput {
  return {
    title: "关于发布计划的讨论",
    summary: "记录了一次发布计划讨论，当事人表达了焦虑",
    episodes: [
      {
        summary: "和项目组的同事讨论发布计划",
        evidence: "讨论了发布计划",
        eventTime: { raw: "今天", precision: "day", certainty: "explicit", start: "2026-10-14", end: "2026-10-14" },
      },
    ],
    thoughts: [{ text: "发布计划需要提前定稿", evidence: "讨论了发布计划" }],
    emotions: [{ labelSaid: "焦虑", candidateConceptId: ANXIETY_CONCEPT, basis: "explicit", evidence: "我感到焦虑" }],
    topics: [{ labelSaid: "工作", candidateConceptId: WORK_CONCEPT, basis: "explicit", evidence: "讨论了发布计划" }],
    entities: [{ labelSaid: "项目组", candidateConceptId: null, basis: "explicit", evidence: "和项目组的同事" }],
  };
}

/**
 * 云端合法回稿：证据引用**占位符本体**（边界不得切进占位符内部），
 * 映射后才落回原文坐标。词面/摘要里出现的仍是占位符——脱敏文本才是模型的输入。
 */
export function validCloudOutput(): StructuredOutput {
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

/** OpenAI-compatible 信封：`completionText` 只认 `choices[0].message.content`。 */
export function envelope(content: string): string {
  return JSON.stringify({ choices: [{ message: { content } }] });
}

export function envelopeOf(output: StructuredOutput): string {
  return envelope(JSON.stringify(output));
}

export interface StubTransport {
  readonly transport: ProviderTransport;
  readonly requests: TransportRequest[];
  /** 已发起的调用次数——「一次请求都不该发出」类断言的度量。 */
  callCount(): number;
  /** 逐次调用抛错/降级的剧本之外的最后一份回稿。 */
  lastBody(): string;
}

/** 每次调用返回同一份响应；需要分岔的测试自己造 `ProviderTransport`。 */
export function stubTransport(response: TransportResponse): StubTransport {
  const requests: TransportRequest[] = [];
  const transport: ProviderTransport = {
    send: async (request) => {
      requests.push(request);
      return response;
    },
  };
  return {
    transport,
    requests,
    callCount: () => requests.length,
    lastBody: () => JSON.stringify(requests.at(-1)?.body ?? {}),
  };
}

export const OK_ENVELOPE = (output: StructuredOutput): TransportResponse => ({
  status: 200,
  body: envelopeOf(output),
});

/** 非 2xx：Provider 层归入 `network`（契约封闭集里没有「服务端错误」这一类）。 */
export const HTTP_ERROR = (status = 503): TransportResponse => ({
  status,
  body: JSON.stringify({ error: { message: "upstream busy" } }),
});

export interface AdapterOverrides {
  readonly provider?: string;
  readonly model?: string;
  readonly baseUrl?: string;
  readonly callPath?: ProviderCallPath;
  readonly supportsStructuredOutput?: boolean;
  readonly requestTimeoutMs?: number;
  readonly params?: Readonly<Record<string, string | number | boolean | null>>;
}

export function makeAdapter(overrides: AdapterOverrides = {}): ModelAdapter {
  return {
    provider: overrides.provider ?? "ollama",
    model: overrides.model ?? "qwen2.5:7b",
    baseUrl: overrides.baseUrl ?? "http://127.0.0.1:11434/v1",
    callPath: overrides.callPath ?? "ollama_openai_compatible",
    supportsStructuredOutput: overrides.supportsStructuredOutput ?? false,
    requestTimeoutMs: overrides.requestTimeoutMs ?? 2000,
    ...(overrides.params === undefined ? {} : { params: { ...overrides.params } }),
  };
}

export const SYSTEM_PROMPT = "你是结构化抽取器。只输出 JSON。";

export interface FixtureRecord {
  readonly recordId: string;
  readonly revisionId: string;
}

/**
 * 建一条记录并按需改 mode。
 * mode 是用户在记录上的既定设置（§4.8），`capture_record.processing_mode` 的默认值是
 * `manual_only`；契约里没有服务层的 mode setter，所以夹具只能按用户动作的方式落库。
 */
export function createRecord(db: Database, text: string, processingMode?: string): FixtureRecord {
  const service = new RecordService(db, { timezoneId: FIXTURE_TIMEZONE, now: () => new Date(FIXTURE_NOW) });
  const created = service.createRecord(text);
  if (processingMode !== undefined) {
    db.prepare("update capture_record set processing_mode = ? where id = ?").run(processingMode, created.record.id);
  }
  return { recordId: created.record.id, revisionId: created.revision.id };
}
