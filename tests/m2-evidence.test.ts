import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { migrate } from "../src/server/db/migrator.ts";
import { seedVocabulary } from "../src/server/db/seed.ts";
import {
  EVIDENCE_REPAIR_KIND,
  EVIDENCE_RULES,
  anchorEvidence,
  planEvidence,
  writeEvidenceRepairSuggestion,
  type EvidenceAnchorContext,
  type EvidenceFailure,
} from "../src/server/ingest/evidence.ts";
import { BUSINESS_RULES } from "../src/server/ingest/contract.ts";
import type { StructuredOutput } from "../src/server/ingest/contract.ts";
import { IngestService, type IngestServiceOptions } from "../src/server/ingest/ingestService.ts";
import { TraceSession } from "../src/server/ingest/trace.ts";
import { redact, resolveEvidenceToOriginal } from "../src/server/privacy/redaction.ts";
import { loadContracts } from "../src/shared/contracts/load.ts";
import { countRows, makeSandbox, openSandboxDb, type Sandbox } from "./helpers/sandbox.ts";
import {
  CLOUD,
  CLOUD_ENTITIES,
  CLOUD_NONCE,
  CLOUD_RAW,
  FIXTURE_NOW,
  LOCAL_RAW,
  OK_ENVELOPE,
  PH_ORG,
  PH_PERSON,
  SYSTEM_PROMPT,
  createRecord,
  makeAdapter,
  stubTransport,
  validCloudOutput,
  validOutput,
} from "./helpers/ingestFixtures.ts";
import type { Database } from "../src/server/db/adapter.ts";

/**
 * M2-5 证据回锚面（D11 + T-27）。
 *
 * 契约取值：Schema §7.6〔冻结·B9〕五步、§3.14〔K-23 偏移单位与坐标归属〕、
 * §3.17〔U-3 已批准的 `evidence_repair` 端点矩阵〕、指令 §7.4/§9.1/§9.4；
 * T-27「构造越界/核验失败输出 ⇒ 零 active/candidate mention、产生 evidence_repair 建议」。
 *
 * 三条不许含糊的边界：
 * 1. **建议不是提及**：修复完成并经用户确认前不得成为 Mention（§7.6.4 用户裁决、U-3），
 *    所以负例的度量是「那张表零行」，不是「没有 active 行」。
 * 2. **入库坐标永远是原文坐标**（K-23）：脱敏文本里的偏移永不得写入，占位符永不得落库。
 * 3. 全批失败与部分失败**分流**（§7.6.4）：前者 run `failed(evidence_unmapped)`、
 *    后者 run 仍 `succeeded`，两种情形修复建议都照写——run 的成败不是建议的前提。
 *
 * 全程离线：回稿由注入的假 Transport 提供。
 */

const CONTRACT_SOURCE = "src/server/ingest/contract.ts";
const MIGRATION_0003 = "src/server/db/migrations/0003_derived_layer.sql";
const CLOUD_BASE_URL = "https://cloud.example.com/v1";
/** 逐字不在两份夹具文本里出现的词面——负例由它单点注入。 */
const OFF_TEXT = "这段文字根本不在原文里";
const ENUMS = loadContracts().enums;

let sandbox: Sandbox;
let db: Database;
let revisionId: string;
let recordId: string;

beforeEach(() => {
  sandbox = makeSandbox("tb-m2-5-ev-");
  db = openSandboxDb(sandbox.layout);
  migrate(db);
  seedVocabulary(db);
  const created = createRecord(db, LOCAL_RAW, "local_model");
  recordId = created.recordId;
  revisionId = created.revisionId;
});

afterEach(() => {
  db.close();
  sandbox.cleanup();
});

type ServiceOverrides = Partial<Omit<IngestServiceOptions, "db">>;

function makeService(overrides: ServiceOverrides = {}): IngestService {
  const options: IngestServiceOptions = {
    db,
    adapter: makeAdapter(),
    transport: stubTransport(OK_ENVELOPE(validOutput())).transport,
    systemPrompt: SYSTEM_PROMPT,
    now: () => new Date(FIXTURE_NOW),
    ...overrides,
  };
  return new IngestService(options);
}

/** 用一份回稿跑一次本地解析。 */
async function ingestLocal(output: StructuredOutput, overrides: ServiceOverrides = {}) {
  const stub = stubTransport(OK_ENVELOPE(output));
  const service = makeService({ ...overrides, transport: stub.transport });
  const result = await service.ingest({ recordRevisionId: revisionId });
  return { service, stub, result };
}

/**
 * 云端一次解析：载荷与映射同源（`redact` 现产），授权闸门为空实现。
 * 记录另起一条（原文是 `CLOUD_RAW`），夹具的本地记录不受牵连。
 */
async function ingestCloud(output: StructuredOutput) {
  const created = createRecord(db, CLOUD_RAW, "cloud_redacted");
  const payload = redact(CLOUD_RAW, CLOUD_ENTITIES, { nonce: CLOUD_NONCE });
  const stub = stubTransport(OK_ENVELOPE(output));
  const service = makeService({
    adapter: makeAdapter({ baseUrl: CLOUD_BASE_URL }),
    transport: stub.transport,
    grantCheck: () => {},
  });
  const result = await service.ingest({
    recordRevisionId: created.revisionId,
    payloadText: payload.redactedText,
    redactionMap: payload.map,
  });
  return { service, stub, result, revisionId: created.revisionId, payload };
}

function localContext(): EvidenceAnchorContext {
  return { sentText: LOCAL_RAW, rawText: LOCAL_RAW };
}

function cloudContext(): EvidenceAnchorContext {
  return { sentText: CLOUD.redactedText, rawText: CLOUD_RAW, redactionMap: CLOUD.map };
}

interface RepairRow {
  readonly kind: string;
  readonly endpoint_a: string;
  readonly subject_term: string;
  readonly status: string;
  readonly display_note: string | null;
  readonly created_at_utc: string;
  readonly updated_at_utc: string;
}

function repairs(): RepairRow[] {
  return db
    .prepare(
      `select kind, endpoint_a, subject_term, status, display_note, created_at_utc, updated_at_utc
         from suggestion where kind = ? order by created_at_utc, id`,
    )
    .all(EVIDENCE_REPAIR_KIND) as unknown as RepairRow[];
}

function recordStatus(id = recordId): string {
  return (db.prepare("select processing_status as s from capture_record where id = ?").get(id) as { s: string }).s;
}

/**
 * 把选定集合的证据换成不在输入文本里的词面（单点变异，其余照旧）。
 * 实体那一支额外带上候选词面：否则这一变异会同时踩中
 * `entity_basis_sufficient`，「全批失败」就不再是**只有证据坏**（§7.6.4 的
 * 分流判据要求证据类独占）。
 */
function breakEvidence(
  output: StructuredOutput,
  ...collections: ("all" | "episodes" | "thoughts" | "emotions" | "topics" | "entities")[]
): StructuredOutput {
  const target = new Set(
    collections.includes("all") ? ["episodes", "thoughts", "emotions", "topics", "entities"] : collections,
  );
  return {
    ...output,
    episodes: output.episodes.map((item) => (target.has("episodes") ? { ...item, evidence: OFF_TEXT } : item)),
    thoughts: output.thoughts.map((item) => (target.has("thoughts") ? { ...item, evidence: OFF_TEXT } : item)),
    emotions: output.emotions.map((item) => (target.has("emotions") ? { ...item, evidence: OFF_TEXT } : item)),
    topics: output.topics.map((item) => (target.has("topics") ? { ...item, evidence: OFF_TEXT } : item)),
    entities: output.entities.map((item) =>
      target.has("entities") ? { ...item, evidence: `${OFF_TEXT}${item.labelSaid}` } : item,
    ),
  };
}

/** 0003 的 `pipeline_manifest` CHECK 要求九项俱在——`'{}'` 会被库直接拒。 */
const MANIFEST = JSON.stringify({
  prompt: "m2-prompt-v1",
  schema: "m2-output-v1",
  model: "qwen2.5:7b",
  provider: "ollama",
  params: {},
  redaction: "rules-v1",
  redactionMap: null,
  resolver: "resolver-v1",
  validation: "validation-v1",
});

/** 库里直插一条 running/candidate 的 run：直接调用写入器的两条建议要有 FK 依据。
 * `pipeline_fingerprint` 的 CHECK 要求 64 位小写十六进制，不是任意字符串。 */
function insertDirectRun(id: string, key: string, fingerprint = "0123456789abcdef".repeat(4)): void {
  db.prepare(
    `insert into parse_run
       (id, source_revision_id, pipeline_manifest, pipeline_fingerprint, idempotency_key,
        execution_status, result_state, started_at_utc)
     values (?, ?, ?, ?, ?, 'running', 'candidate', ?)`,
  ).run(id, revisionId, MANIFEST, fingerprint, key, FIXTURE_NOW);
}

/** 切进占位符内部的证据：能在脱敏文本里逐字定位，但映射不出原文坐标。 */
function slicedPlaceholder(): string {
  return `和${PH_PERSON.slice(0, PH_PERSON.length - 3)}`;
}

// ── 单条回锚（§7.6.1–§7.6.3）─────────────────────────────────────────

describe("§7.6 单条回锚：定位 → 映射 → 逐字核验", () => {
  it("本地路径：证据在原文里逐字定位，入库坐标即原文偏移", () => {
    const anchored = anchorEvidence("讨论了发布计划", localContext());
    if (!anchored.ok) throw new Error(`应通过回锚：${anchored.rule} — ${anchored.detail}`);
    const start = LOCAL_RAW.indexOf("讨论了发布计划");
    expect(anchored.anchor.evidenceStart).toBe(start);
    expect(anchored.anchor.evidenceEnd).toBe(start + "讨论了发布计划".length);
    expect(anchored.anchor.evidenceText).toBe(LOCAL_RAW.slice(start, start + "讨论了发布计划".length));
    expect(anchored.anchor.sentSlice).toBe("讨论了发布计划");
  });

  it("无法逐字回溯 ⇒ `evidence_traceable`，不产出锚点", () => {
    const missed = anchorEvidence(OFF_TEXT, localContext());
    expect(missed.ok).toBe(false);
    if (!missed.ok) expect(missed.rule).toBe("evidence_traceable");
    // 模型回稿里的证据必须是原文的连续子串，同音改字同样不算回溯成功。
    const reworded = anchorEvidence("讨论了排期计划", localContext());
    expect(reworded.ok).toBe(false);
  });

  it("云端：占位符证据映射回原文坐标，切片逐字核验通过", () => {
    const anchored = anchorEvidence(`和${PH_PERSON}去了`, cloudContext());
    if (!anchored.ok) throw new Error(`应通过回锚：${anchored.rule} — ${anchored.detail}`);
    const original = "和张三去了";
    expect(anchored.anchor.evidenceText).toBe(original);
    expect(anchored.anchor.evidenceStart).toBe(CLOUD_RAW.indexOf(original));
    expect(anchored.anchor.evidenceEnd).toBe(CLOUD_RAW.indexOf(original) + original.length);
    expect(anchored.anchor.sentSlice).toBe(`和${PH_PERSON}去了`);
    // 映射后的文本里不得残留占位符（K-23：偏移与文本都属于原文）。
    expect(anchored.anchor.evidenceText).not.toContain("[");
  });

  it("边界切进占位符内部 ⇒ 映射不出 ⇒ `evidence_mappable_to_original`", () => {
    const half = slicedPlaceholder();
    expect(CLOUD.redactedText.includes(half)).toBe(true);
    const anchored = anchorEvidence(half, cloudContext());
    expect(anchored.ok).toBe(false);
    if (!anchored.ok) expect(anchored.rule).toBe("evidence_mappable_to_original");
  });

  it("越界：映射出的原文区间超出 raw_text ⇒ null，绝不静默写入", () => {
    // 手工造一份与原文长度不符的映射：脱敏坐标合法、原文坐标越界。
    const redactedStart = CLOUD.redactedText.indexOf(PH_PERSON);
    const lyingMap = {
      policyVersion: CLOUD.map.policyVersion,
      nonce: CLOUD_NONCE,
      spans: [
        {
          kind: "person",
          placeholder: PH_PERSON,
          originalStart: 0,
          originalEnd: CLOUD_RAW.length + 40,
          redactedStart,
          redactedEnd: redactedStart + PH_PERSON.length,
        },
      ],
    };
    expect(resolveEvidenceToOriginal(lyingMap, CLOUD_RAW, CLOUD.redactedText, redactedStart, redactedStart + PH_PERSON.length)).toBeNull();
    // 区间本身越出发送文本也是同一道门（end > sentText.length）。
    expect(resolveEvidenceToOriginal(CLOUD.map, CLOUD_RAW, CLOUD.redactedText, 0, CLOUD.redactedText.length + 5)).toBeNull();
    // 倒置区间同样被拒——null 不是「偏移为 0」。
    expect(resolveEvidenceToOriginal(CLOUD.map, CLOUD_RAW, CLOUD.redactedText, 8, 3)).toBeNull();
  });

  it("逐条分流：好的进写入集，坏的进修复集，互不牵连（§7.6.3/§7.6.4）", () => {
    const plan = planEvidence(breakEvidence(validOutput(), "emotions", "topics"), localContext());
    expect(plan.failures.map((failure) => `${failure.collection}[${failure.index}]`)).toEqual(["emotions[0]", "topics[0]"]);
    expect(plan.episodes).toHaveLength(1);
    expect(plan.thoughts).toHaveLength(1);
    expect(plan.labels.map((label) => label.labelSaid)).toEqual(["项目组"]);
    expect(plan.whollyFailed).toBe(false);
    expect(plan.failures[0]).toEqual({
      collection: "emotions",
      index: 0,
      subjectTerm: "焦虑",
      rule: "evidence_traceable",
      detail: "证据无法在实际发送的输入文本中逐字回溯",
    });
  });

  it("全批判据：有条目且一条都不过 ⇒ whollyFailed；本来就没有条目 ⇒ 不算全批失败", () => {
    expect(planEvidence(breakEvidence(validOutput(), "all"), localContext()).whollyFailed).toBe(true);
    const empty: StructuredOutput = { ...validOutput(), episodes: [], thoughts: [], emotions: [], topics: [], entities: [] };
    const none = planEvidence(empty, localContext());
    expect(none.whollyFailed).toBe(false);
    expect(none.failures).toHaveLength(0);
  });

  it("无词面类（Episode/Thought）的 subject_term 取空串哨兵，标签类取候选词面（§3.17）", () => {
    const plan = planEvidence(breakEvidence(validOutput(), "all"), localContext());
    const byCollection = new Map(plan.failures.map((failure) => [failure.collection, failure.subjectTerm]));
    expect(byCollection.get("episodes")).toBe("");
    expect(byCollection.get("thoughts")).toBe("");
    expect(byCollection.get("emotions")).toBe("焦虑");
    expect(byCollection.get("topics")).toBe("工作");
    expect(byCollection.get("entities")).toBe("项目组");
  });
});

// ── T-27 服务面 ────────────────────────────────────────────────────

describe("T-27 服务面：核验失败 ⇒ 零提及（含 candidate）+ evidence_repair 建议", () => {
  it("单条情绪证据回溯失败：该条零 Mention，修复建议照写，其余条目照常入库，run 仍成功", async () => {
    const { service, result } = await ingestLocal(breakEvidence(validOutput(), "emotions"));
    expect(result.succeeded).toBe(true);
    expect(result.errorKind).toBeNull();
    expect(result.writes.evidenceRepairs).toBe(1);
    // topics 落成提及；emotions 因证据失败零行；entities 无既存实体可归，走 unresolved。
    expect(result.writes.mentions).toBe(1);
    expect(result.writes.unresolvedEntities).toBe(1);
    expect(countRows(db, "emotion_mention")).toBe(0);
    expect(service.currentView(revisionId).emotions).toEqual([]);
    expect(result.writes.episodes).toBe(1);
    expect(result.writes.thoughts).toBe(1);
    expect(countRows(db, "topic_mention")).toBe(1);

    const rows = repairs();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "evidence_repair",
      endpoint_a: revisionId,
      subject_term: "焦虑",
      status: "pending",
      display_note: "evidence_traceable:emotions[0]",
    });
    // 建议行里不得有原文或证据文本（指令 §11.2、§3.4 B6）。
    const serialized = JSON.stringify(rows[0]);
    expect(serialized).not.toContain(LOCAL_RAW);
    expect(serialized).not.toContain(OFF_TEXT);
  });

  it("云端切坏占位符 + 载荷外的证据：两条都零提及，run 不因证据失败而失败", async () => {
    const output: StructuredOutput = {
      ...validCloudOutput(),
      thoughts: [{ text: "见面比线上沟通更有效", evidence: OFF_TEXT }],
      emotions: [{ ...validCloudOutput().emotions[0]!, evidence: slicedPlaceholder() }],
    };
    const { result, revisionId: cloudRevision } = await ingestCloud(output);
    expect(result.succeeded).toBe(true);
    expect(countRows(db, "thought_item")).toBe(0);
    expect(countRows(db, "emotion_mention")).toBe(0);

    // 0003 的表级 UNIQUE(kind, relation_type, endpoint_a, endpoint_b) 比 §3.17 的词面唯一更粗：
    // 同一 revision 只能有一行 evidence_repair。第一条（无词面哨兵）占住槽位，第二条被挤掉并
    // 如实上报为 collision——这是冻结 schema 的粒度损失，本层既不放宽也不假装它不存在。
    expect(result.collisions).toEqual([
      { kind: "evidence_repair", endpointA: cloudRevision, heldTerm: "", droppedTerm: "开心" },
    ]);
    const rows = repairs();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.endpoint_a).toBe(cloudRevision);
    expect(rows[0]?.display_note).toBe("evidence_traceable:thoughts[0]");
    // 被挤掉的那条也没被静默写成提及。
    expect(JSON.stringify(rows)).not.toContain("开心");
  });

  it("全批失败：run 落 failed(evidence_unmapped)、记录态 failed、派生行零，修复建议照写", async () => {
    const trace = new TraceSession();
    const { service, result } = await ingestLocal(breakEvidence(validOutput(), "all"), { trace });
    expect(result.succeeded).toBe(false);
    expect(result.errorKind).toBe("evidence_unmapped");
    expect(service.readRun(result.runId)).toMatchObject({
      execution_status: "failed",
      result_state: "candidate",
      error_kind: "evidence_unmapped",
    });
    expect(recordStatus()).toBe("failed");
    for (const table of ["episode", "thought_item", "emotion_mention", "topic_mention", "entity_mention"]) {
      expect(countRows(db, table), `${table} 应零行`).toBe(0);
    }

    // 全批失败不取消修复路径：§7.6.4 的建议写入不以 run 成功为前提。
    // episode 与 thought 同为无词面类 ⇒ 并成一轮（同槽位刷新），标签类三条被槽位门挤掉。
    expect(result.writes.evidenceRepairs).toBe(2);
    expect(result.collisions).toHaveLength(3);
    const rows = repairs();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "evidence_repair", endpoint_a: revisionId, subject_term: "", status: "pending" });

    const entries = JSON.parse(trace.serialize({ rawText: LOCAL_RAW })) as Array<Record<string, unknown>>;
    expect(entries).toHaveLength(1);
    expect(entries[0]?.["errorKind"]).toBe("evidence_unmapped");
    expect(entries[0]?.["derivedWriteCommitted"]).toBe(true);
    expect((entries[0]?.["diagnostics"] as { evidence_repairs: number }).evidence_repairs).toBe(2);
  });

  it("非证据类的业务失败不落 evidence_repair（分流只认证据规则）", async () => {
    const output = validOutput();
    output.emotions = [{ labelSaid: "焦虑", candidateConceptId: "concept_not_in_index", basis: "explicit", evidence: "我感到焦虑" }];
    const { result } = await ingestLocal(output);
    expect(result.succeeded).toBe(false);
    expect(result.errorKind).toBe("business_validation");
    expect(result.writes.evidenceRepairs).toBe(0);
    expect(repairs()).toHaveLength(0);
    expect(countRows(db, "emotion_mention")).toBe(0);
  });

  it("证据坏与其它规则坏混在一起 ⇒ 整批不采信，也不产出逐条修复建议", async () => {
    const output = breakEvidence(validOutput(), "emotions");
    output.topics = [{ labelSaid: "工作", candidateConceptId: "concept_not_in_index", basis: "explicit", evidence: OFF_TEXT }];
    const { result } = await ingestLocal(output);
    expect(result.errorKind).toBe("business_validation");
    expect(result.writes.evidenceRepairs).toBe(0);
    expect(countRows(db, "emotion_mention")).toBe(0);
    expect(countRows(db, "topic_mention")).toBe(0);
  });

  it("入库的三列证据永远是原文坐标，脱敏偏移与占位符都不落库（K-23/I8）", async () => {
    const { result, revisionId: cloudRevision, payload } = await ingestCloud(validCloudOutput());
    expect(result.succeeded).toBe(true);
    const row = db
      .prepare("select evidence_text, evidence_start, evidence_end from thought_item where source_record_revision_id = ?")
      .get(cloudRevision) as { evidence_text: string; evidence_start: number; evidence_end: number };
    expect(row.evidence_text).toBe("和张三去了");
    expect(row.evidence_start).toBe(CLOUD_RAW.indexOf("和张三去了"));
    expect(row.evidence_end).toBe(CLOUD_RAW.indexOf("和张三去了") + "和张三去了".length);
    expect(CLOUD_RAW.slice(row.evidence_start, row.evidence_end)).toBe(row.evidence_text);
    // 原文坐标 ≠ 脱敏坐标（映射确实被用上了）：拿同一组偏移去切载荷，切出来是别的字。
    expect(payload.redactedText.slice(row.evidence_start, row.evidence_end)).not.toBe(row.evidence_text);
    const stored = JSON.stringify(
      db
        .prepare("select evidence_text from thought_item union all select evidence_text from emotion_mention union all select summary from episode")
        .all(),
    );
    expect(stored).not.toContain(PH_PERSON);
    expect(stored).not.toContain(PH_ORG);
  });

  it("同一词面的失败重跑不重复提出：仍一条建议行，只刷新 updated_at_utc", async () => {
    const first = await ingestLocal(breakEvidence(validOutput(), "emotions"));
    expect(first.result.writes.evidenceRepairs).toBe(1);
    const created = repairs()[0]!;

    // 换指纹 ⇒ 新 run（同 (revision, 指纹) 会被认成重放，走不到派生写入）。
    const later = "2026-10-14T05:00:00.000Z";
    const second = await ingestLocal(breakEvidence(validOutput(), "emotions"), {
      promptVersion: "m2-prompt-v7",
      now: () => new Date(later),
    });
    expect(second.result.runId).not.toBe(first.result.runId);
    expect(countRows(db, "parse_run")).toBe(2);
    expect(second.result.writes.evidenceRepairs).toBe(1);
    expect(repairs()).toHaveLength(1);
    expect(repairs()[0]).toMatchObject({ created_at_utc: created.created_at_utc, updated_at_utc: later });
    expect(countRows(db, "emotion_mention")).toBe(0);
  });

  it("直接调用写入器：同 (kind, 端点, 词面) 第二次不新增行；修复建议不是提及", () => {
    insertDirectRun("run_ev_direct", "key_ev_direct");
    const failure = {
      collection: "emotions",
      index: 0,
      subjectTerm: "焦虑",
      rule: "evidence_traceable",
      detail: "证据无法在实际发送的输入文本中逐字回溯",
    } as EvidenceFailure;
    const first = writeEvidenceRepairSuggestion(db, {
      parseRunId: "run_ev_direct",
      sourceRevisionId: revisionId,
      failure,
      now: "2026-10-14T02:00:00.000Z",
    });
    const second = writeEvidenceRepairSuggestion(db, {
      parseRunId: "run_ev_direct",
      sourceRevisionId: revisionId,
      failure,
      now: "2026-10-14T03:00:00.000Z",
    });
    expect(second).toBe(first);
    expect(countRows(db, "suggestion")).toBe(1);
    const row = db.prepare("select created_at_utc as c, updated_at_utc as u from suggestion where id = ?").get(first) as {
      c: string;
      u: string;
    };
    expect(row.c).toBe("2026-10-14T02:00:00.000Z");
    expect(row.u).toBe("2026-10-14T03:00:00.000Z");
    // 「修复完成并经用户确认前不得成为有效提及」：本层连一条 Mention 都不该留下。
    expect(countRows(db, "emotion_mention")).toBe(0);
  });
});

// ── 与 contract.ts / 冻结迁移的对账 ────────────────────────────────

describe("证据规则标识与契约同源（不得两处各抄一份）", () => {
  it("EVIDENCE_RULES 恰是 BUSINESS_RULES 的证据类子集", () => {
    expect(EVIDENCE_RULES).toEqual(BUSINESS_RULES.filter((rule) => rule.startsWith("evidence_")));
    expect([...EVIDENCE_RULES]).toEqual(["evidence_traceable", "evidence_mappable_to_original"]);
  });

  it("contract.ts 内部那份私有清单与导出的 EVIDENCE_RULES 逐值相等（静态源码对账）", () => {
    const source = readFileSync(CONTRACT_SOURCE, "utf8");
    const literal = /const EVIDENCE_RULES: readonly BusinessRule\[\] = \[([^\]]*)\]/.exec(source);
    expect(literal, "contract.ts 应保留那份私有证据规则清单").not.toBeNull();
    const declared = [...literal![1]!.matchAll(/"([^"]+)"/g)].map((match) => match[1]!);
    expect(declared).toEqual([...EVIDENCE_RULES]);
  });

  it("evidence_repair 同时在册于 enums 封闭集、0003 的 CHECK 与实际写入", () => {
    expect(ENUMS.suggestion_kinds).toContain(EVIDENCE_REPAIR_KIND);
    expect(readFileSync(MIGRATION_0003, "utf8")).toContain(`'${EVIDENCE_REPAIR_KIND}'`);
    // 写入面：库里真接受这个 kind（CHECK 不是注释）。
    insertDirectRun("run_ev_kind", "key_ev_kind");
    writeEvidenceRepairSuggestion(db, {
      parseRunId: "run_ev_kind",
      sourceRevisionId: revisionId,
      failure: { collection: "thoughts", index: 0, subjectTerm: "", rule: "evidence_mappable_to_original", detail: "越界" } as EvidenceFailure,
      now: FIXTURE_NOW,
    });
    expect(countRows(db, "suggestion")).toBe(1);
    expect(repairs()[0]?.display_note).toBe("evidence_mappable_to_original:thoughts[0]");
  });

  it("端点矩阵：evidence_repair 的 endpoint_a 是来源 revision，endpoint_b 为空串哨兵（§3.17）", () => {
    insertDirectRun("run_ev_matrix", "key_ev_matrix");
    const id = writeEvidenceRepairSuggestion(db, {
      parseRunId: "run_ev_matrix",
      sourceRevisionId: revisionId,
      failure: { collection: "entities", index: 0, subjectTerm: "项目组", rule: "evidence_traceable", detail: "x" } as EvidenceFailure,
      now: FIXTURE_NOW,
    });
    const row = db
      .prepare("select kind, endpoint_a, endpoint_b, relation_type, parse_run_id from suggestion where id = ?")
      .get(id) as { kind: string; endpoint_a: string; endpoint_b: string; relation_type: string; parse_run_id: string };
    expect(row).toEqual({
      kind: "evidence_repair",
      endpoint_a: revisionId,
      endpoint_b: "",
      relation_type: "",
      parse_run_id: "run_ev_matrix",
    });
  });
});
