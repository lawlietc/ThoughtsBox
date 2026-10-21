import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { migrate } from "../src/server/db/migrator.ts";
import { RecordService } from "../src/server/records/service.ts";
import { seedVocabulary } from "../src/server/db/seed.ts";
import { loadVocab } from "../src/shared/contracts/load.ts";
import { countRows, makeSandbox, openSandboxDb, type Sandbox } from "./helpers/sandbox.ts";
import type { Database } from "../src/server/db/adapter.ts";

/**
 * M2 派生层 Schema 契约测试（Schema 审查稿 §10 的 migration 集成面层）。
 * 覆盖：T-01 / T-02 / T-05 / T-15 / T-16 / T-21 / T-22 / T-23 / T-25 / T-26 / T-32（DB 面）
 * 以及 K-17（授权复用键）、K-19（强度只来自用户）、B4（念头永不无来源）。
 *
 * 这一层只回答一个问题：**数据库自己守不守得住**。服务层（M2-5）再怎么错，
 * 非法行都不许落库。因此这里全部绕过服务直接写入，且写入都在显式事务里、探完即回滚，
 * 夹具现场不被污染。行为面断言在 m2-idempotency / m2-ingest-service / m2-correction 各自成测。
 */

const MIGRATION_FILE = "src/server/db/migrations/0003_derived_layer.sql";
const ENUMS_FILE = "src/shared/constants/enums.json";

const NOW = "2026-10-13T06:30:00.000Z";
const HEX64 = "0123456789abcdef".repeat(4);

/** 夹具概念名刻意避开词表用词：播种测试要让「用户先占用词表名」这条路能被单独构造。 */
const FIXTURE_EMOTION = "探针情绪";
const FIXTURE_TOPIC = "探针主题";

const MANIFEST = JSON.stringify({
  prompt: "m2-prompt-v1",
  schema: "m2-output-v1",
  model: "qwen2.5:7b",
  provider: "openai_compatible",
  params: { temperature: 0 },
  redaction: "rules-v1",
  redactionMap: {},
  resolver: "resolver-v1",
  validation: "validation-v1",
});

interface RelationType {
  readonly type: string;
  readonly carrier: string;
  readonly directed: boolean;
}

/** 状态机的字面量键名：写错的键在编译期就拒绝，而不是运行时静默拿到 undefined。 */
type StateMachineName =
  | "Entity.lifecycle_status"
  | "Concept.lifecycle_status"
  | "Episode.lifecycle_status"
  | "ThoughtItem.lifecycle_status"
  | "Mention.status"
  | "GraphEdge.lifecycle_status"
  | "Suggestion.status"
  | "ParseRun.execution_status"
  | "ParseRun.result_state";

interface Enums {
  entity_types: string[];
  origin_types: string[];
  /** 只声明本测试用到的三个子集；enums 里的 note 是说明文字，不参与逐表 diff。 */
  origin_type_subsets: {
    concept: string[];
    episode_thought_item_entity: string[];
    mention: string[];
  };
  basis_values: string[];
  suggestion_kinds: string[];
  event_time_precision: string[];
  event_time_certainty: string[];
  privacy_levels: string[];
  relation_types: RelationType[];
  relation_type_rules: { not_stored_in_graph_edge: string[]; ai_may_never_create: string[] };
  lifecycle_states: Record<StateMachineName, { values: string[] }>;
}

let sandbox: Sandbox;
let db: Database;
let service: RecordService;
let revisionId: string;
/** 同一记录上的第二个版本：双态测试需要两个互不干扰的宿主 Revision。 */
let revision2: string;

beforeEach(() => {
  sandbox = makeSandbox("tb-m2-contract-");
  db = openSandboxDb(sandbox.layout);
  migrate(db);
  service = new RecordService(db, { timezoneId: "Asia/Shanghai", now: () => new Date(NOW) });
  const created = service.createRecord("今天和老周聊了很久，我感到焦虑，也可能有点兴奋。");
  revisionId = created.revision.id;
  revision2 = service.editRecord(created.record.id, "同一条记录的第二个版本，用于双态夹具。").revision.id;
  insertConcept("concept_fixture_emotion", "emotion", FIXTURE_EMOTION);
  insertConcept("concept_fixture_topic", "topic", FIXTURE_TOPIC);
  insertEntity("entity_fixture_1", "person", "老周");
  insertRun("run_fixture_1", {});
});

afterEach(() => {
  db.close();
  sandbox.cleanup();
});

const sql = readFileSync(MIGRATION_FILE, "utf8");
/** 静态扫描用去注释文本：头注里引用被禁形态的字面量不参与守门断言。 */
function stripComments(source: string): string {
  return source
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
}
const sqlCode = stripComments(sql);
/** 前缀 CHECK 的守门面覆盖全部已应用的迁移，不只 0003：新表漏写约束是跨里程碑的风险。 */
const sqlAllCode = [
  "0001_bootstrap.sql",
  "0002_records_and_search.sql",
  "0003_derived_layer.sql",
  "0004_correction_layer.sql",
  "0005_override_value_gate.sql",
  "0006_entity_types_v2.sql",
  "0007_schema_backfill_m2_debt.sql",
]
  .map((name) => stripComments(readFileSync(`src/server/db/migrations/${name}`, "utf8")))
  .join("\n");
const enums = JSON.parse(readFileSync(ENUMS_FILE, "utf8")) as Enums;

/** 状态机入口态 = 取值清单首项；空集合属于契约断裂，抛出来，不让 undefined 溜进断言。 */
function entryState(name: StateMachineName): string {
  const first = enums.lifecycle_states[name].values[0];
  if (first === undefined) throw new Error(`enums.lifecycle_states.${name} 的取值集合为空`);
  return first;
}

/**
 * 抽取某列**定义处**的 `column IN ( … )` 字面量序列。
 * 列定义 CHECK 总在表中其它 CHECK 之前出现，所以取第一处即可；顺序也纳入断言（与 enums 同序）。
 */
function definitionList(column: string): string[] {
  const match = new RegExp(`${column} TEXT[^C]*CHECK \\(\\s*${column} IN \\(([\\s\\S]*?)\\)`).exec(sql);
  if (match === null) throw new Error(`迁移 SQL 中未找到 ${column} 的 IN (...) 定义 CHECK`);
  return [...match[1]!.matchAll(/'([^']*)'/g)].map((m) => m[1]!);
}

/**
 * 按建表语句切块。同名列（origin_type、lifecycle_status、status）在多张表上重复出现，
 * 逐表核对必须先看块，否则只能靠「文件里第几次出现」来猜是哪张表——顺序一变就误报。
 */
function tableBlock(blockSql: string, table: string): string {
  const match = new RegExp(`CREATE TABLE ${table} \\([\\s\\S]*?\\n\\) STRICT;`).exec(blockSql);
  if (match === null) throw new Error(`迁移 SQL 中未找到 ${table} 的建表语句`);
  return match[0];
}

/** 某表某列定义处的 IN 字面量清单（含顺序）。 */
function tableList(table: string, column: string): string[] {
  const match = new RegExp(
    `${column} TEXT[^C]*CHECK \\(\\s*${column} IN \\(([\\s\\S]*?)\\)`,
  ).exec(tableBlock(sqlCode, table));
  if (match === null) throw new Error(`${table} 的 ${column} 没有定义处的 IN (...) CHECK`);
  return [...match[1]!.matchAll(/'([^']*)'/g)].map((m) => m[1]!);
}

/** 某表某列的 DEFAULT 字面量；没有 DEFAULT 时为 null。 */
function defaultOf(table: string, column: string): string | null {
  const match = new RegExp(`${column} TEXT[^,\\n]*DEFAULT '([^']*)'`).exec(
    tableBlock(sqlCode, table),
  );
  return match === null ? null : match[1]!;
}

function attemptRollback(statement: () => void): void {
  db.exec("begin immediate");
  try {
    statement();
  } finally {
    db.exec("rollback");
  }
}

/** 期望被拒：把真实错误信息带进断言，失败时可读；无论成败都回滚，现场不留。 */
function expectRejected(statement: () => void, pattern: RegExp): void {
  let thrown: Error | undefined;
  db.exec("begin immediate");
  try {
    statement();
  } catch (cause) {
    thrown = cause as Error;
  } finally {
    db.exec("rollback");
  }
  if (thrown === undefined) {
    throw new Error(`期望被 ${pattern} 拒绝，但写入成功了`);
  }
  expect(thrown.message).toMatch(pattern);
}

function expectAccepted(statement: () => void): void {
  attemptRollback(statement);
}

// ── 夹具写入器（绕过服务层，直接检验数据库的守门能力）──────────────────

function insertConcept(id: string, type: "emotion" | "topic", name: string): void {
  db.prepare(
    `insert into concept (id, concept_type, canonical_name, origin_type, lifecycle_status, created_at_utc)
     values (?, ?, ?, 'user_created', 'active', ?)`,
  ).run(id, type, name, NOW);
}

function insertEntity(id: string, entityType: string, name: string, overrides = {}): void {
  run(
    "entity",
    {
      id,
      entity_type: entityType,
      canonical_name: name,
      display_name: name,
      lifecycle_status: "active",
      privacy_level: "normal",
      origin_type: "user_created",
      created_at_utc: NOW,
      ...overrides,
    },
  );
}

function insertRun(id: string, overrides: Record<string, unknown> = {}): void {
  run("parse_run", {
    id,
    source_revision_id: revisionId,
    pipeline_manifest: MANIFEST,
    pipeline_fingerprint: HEX64,
    idempotency_key: `k-${id}`,
    execution_status: "succeeded",
    result_state: "candidate",
    error_kind: null,
    started_at_utc: NOW,
    finished_at_utc: NOW,
    ...overrides,
  });
}

function insertEpisode(id: string, overrides: Record<string, unknown> = {}): void {
  run("episode", {
    id,
    source_record_revision_id: null,
    parse_run_id: null,
    origin_type: "user_created",
    lifecycle_status: "active",
    summary: "和老周的一次长谈",
    evidence_text: "",
    evidence_start: null,
    evidence_end: null,
    event_time_raw: null,
    event_time_precision: "unknown",
    event_time_certainty: "unknown",
    event_time_start: null,
    event_time_end: null,
    created_at_utc: NOW,
    ...overrides,
  });
}

function insertThought(id: string, overrides: Record<string, unknown> = {}): void {
  run("thought_item", {
    id,
    text: "我是不是把选择权交出去了",
    source_record_revision_id: revisionId,
    source_episode_id: null,
    parse_run_id: null,
    origin_type: "user_created",
    lifecycle_status: "active",
    evidence_text: "",
    evidence_start: null,
    evidence_end: null,
    created_at_utc: NOW,
    ...overrides,
  });
}

interface MentionTable {
  readonly table: string;
  readonly prefix: string;
  readonly targetColumn: string;
  readonly targetId: string;
}

const MENTION_TABLES: MentionTable[] = [
  {
    table: "emotion_mention",
    prefix: "em",
    targetColumn: "concept_id",
    targetId: "concept_fixture_emotion",
  },
  {
    table: "topic_mention",
    prefix: "tm",
    targetColumn: "concept_id",
    targetId: "concept_fixture_topic",
  },
  {
    table: "entity_mention",
    prefix: "enm",
    targetColumn: "entity_id",
    targetId: "entity_fixture_1",
  },
];

function insertMention(st: MentionTable, overrides: Record<string, unknown> = {}): void {
  run(st.table, {
    id: `${st.prefix}_fixture_1`,
    [st.targetColumn]: st.targetId,
    source_record_revision_id: revisionId,
    source_episode_id: null,
    source_thought_id: null,
    label_said: FIXTURE_EMOTION,
    evidence_text: "我感到焦虑",
    evidence_start: 11,
    evidence_end: 15,
    origin_type: "user_created",
    basis: "explicit",
    status: "active",
    parse_run_id: null,
    created_at_utc: NOW,
    ...overrides,
  });
}

function insertSuggestion(overrides: Record<string, unknown> = {}): void {
  run("suggestion", {
    id: "sug_fixture_1",
    kind: "emotion_candidate",
    relation_type: "",
    endpoint_a: "concept_fixture_emotion",
    endpoint_b: "",
    subject_term: "有点慌",
    status: "pending",
    reason_code: "",
    evidence: null,
    display_note: null,
    parse_run_id: "run_fixture_1",
    result_id: null,
    created_at_utc: NOW,
    updated_at_utc: NOW,
    ...overrides,
  });
}

function insertEdge(overrides: Record<string, unknown> = {}): void {
  run("graph_edge", {
    id: "edge_fixture_1",
    relation_type: "possibly_related",
    src_kind: "episode",
    dst_kind: "episode",
    src_id: "ep_fixture_a",
    dst_id: "ep_fixture_b",
    lifecycle_status: "active",
    created_by: "user",
    origin_suggestion_id: null,
    evidence_reason: null,
    created_at_utc: NOW,
    updated_at_utc: NOW,
    ...overrides,
  });
}

/** 具名列写入：STRICT 表不做类型强转，值形态必须由调用方给对。 */
function run(table: string, values: Record<string, unknown>): void {
  const cols = Object.keys(values);
  db.prepare(
    `insert into ${table} (${cols.join(", ")}) values (${cols.map((c) => `@${c}`).join(", ")})`,
    // 夹具值全部来自上面的写入器，形态由各自签名兜住；这里只对齐 node:sqlite 的入参类型。
  ).run(values as Record<string, string | number | bigint | null | Uint8Array>);
}

// ── T-16：枚举字面量与 enums.json 逐项 diff 为空 ─────────────────────

describe("T-16：0003 的枚举 CHECK 与 enums.json 单一事实源逐项一致", () => {
  it("entity_type / suggestion kind / basis / 事件时间两套 / privacy_level 与枚举源完全一致（含顺序）", () => {
    // 改向〔M3-DB-1，用户裁定 Q3〕：本行原本钉 `definitionList("entity_type") == enums.entity_types`。
    // 0003 逐字冻结（sha256 守护），它这里的 7 值就此成为**旧契约的字面档案**；
    // 现行 8 值与迁移的比对已移到 0006 —— 见 tests/m3-db-1-entity8.test.ts 的同名对账。
    expect(definitionList("entity_type")).toEqual([
      "person",
      "organization",
      "place",
      "work",
      "product",
      "game",
      "other",
    ]);
    expect(definitionList("kind")).toEqual(enums.suggestion_kinds);
    expect(definitionList("basis")).toEqual(enums.basis_values);
    expect(definitionList("event_time_precision")).toEqual(enums.event_time_precision);
    expect(definitionList("event_time_certainty")).toEqual(enums.event_time_certainty);
    expect(definitionList("privacy_level")).toEqual(enums.privacy_levels);
  });

  it("origin_type 各表适用子集与 enums.origin_type_subsets 逐表一致", () => {
    const subsets = enums.origin_type_subsets;
    expect(tableList("concept", "origin_type")).toEqual(subsets.concept);
    for (const table of ["episode", "thought_item", "entity"]) {
      expect(tableList(table, "origin_type")).toEqual(subsets.episode_thought_item_entity);
    }
    for (const table of ["emotion_mention", "topic_mention", "entity_mention"]) {
      expect(tableList(table, "origin_type")).toEqual(subsets.mention);
    }
    // system_seed 只归 Concept 播种：任何其他表出现即越界。
    for (const table of ["episode", "thought_item", "entity", ...MENTION_TABLES.map((m) => m.table)]) {
      expect(tableList(table, "origin_type")).not.toContain("system_seed");
    }
    // 裁决 I2 作废的旧命名不得在任何处复活。
    expect(sqlCode).not.toContain("ai_extraction");
    expect(enums.origin_types).not.toContain("ai_extraction");
  });

  it("状态字面量与 enums.lifecycle_states 逐项一致，缺省值都是各自的起始态", () => {
    const states = enums.lifecycle_states;
    expect(tableList("concept", "lifecycle_status")).toEqual(states["Concept.lifecycle_status"].values);
    expect(tableList("episode", "lifecycle_status")).toEqual(states["Episode.lifecycle_status"].values);
    expect(tableList("thought_item", "lifecycle_status")).toEqual(
      states["ThoughtItem.lifecycle_status"].values,
    );
    expect(tableList("entity", "lifecycle_status")).toEqual(states["Entity.lifecycle_status"].values);
    expect(tableList("graph_edge", "lifecycle_status")).toEqual(
      states["GraphEdge.lifecycle_status"].values,
    );
    for (const table of ["emotion_mention", "topic_mention", "entity_mention"]) {
      expect(tableList(table, "status")).toEqual(states["Mention.status"].values);
    }
    expect(tableList("suggestion", "status")).toEqual(states["Suggestion.status"].values);
    expect(tableList("parse_run", "execution_status")).toEqual(
      states["ParseRun.execution_status"].values,
    );
    expect(tableList("parse_run", "result_state")).toEqual(states["ParseRun.result_state"].values);
    expect(definitionList("relation_type")).toEqual(
      enums.relation_types.filter((r) => r.carrier === "GraphEdge").map((r) => r.type),
    );
    // 缺省值必须是各自状态机的入口态——逐表核对，不靠字面量清单里的顺序。
    expect(defaultOf("concept", "lifecycle_status")).toBe(entryState("Concept.lifecycle_status"));
    expect(defaultOf("episode", "lifecycle_status")).toBe(entryState("Episode.lifecycle_status"));
    expect(defaultOf("thought_item", "lifecycle_status")).toBe(entryState("ThoughtItem.lifecycle_status"));
    expect(defaultOf("entity", "lifecycle_status")).toBe(entryState("Entity.lifecycle_status"));
    expect(defaultOf("graph_edge", "lifecycle_status")).toBe(entryState("GraphEdge.lifecycle_status"));
    expect(defaultOf("emotion_mention", "status")).toBe(entryState("Mention.status"));
    expect(defaultOf("suggestion", "status")).toBe(entryState("Suggestion.status"));
    expect(defaultOf("parse_run", "execution_status")).toBe(entryState("ParseRun.execution_status"));
    expect(defaultOf("parse_run", "result_state")).toBe(entryState("ParseRun.result_state"));
  });

  it("graph_edge 方向字面量与 relation_types[].directed 一致：只有有向类型被豁免字典序归一", () => {
    const exempt = /CHECK \(relation_type = '([a-z_]+)' OR src_id <= dst_id\)/.exec(sqlCode);
    expect(exempt).not.toBeNull();
    const exemptType = exempt![1]!;
    const graphEdges = enums.relation_types.filter((r) => r.carrier === "GraphEdge");
    expect(graphEdges.find((r) => r.type === exemptType)!.directed).toBe(true);
    for (const rel of graphEdges.filter((r) => r.type !== exemptType)) {
      expect(rel.directed).toBe(false);
    }
  });

  it("投影关系与非 GraphEdge 载体的关系类型，绝不作为 GraphEdge 取值出现", () => {
    const edgeList = definitionList("relation_type");
    for (const forbidden of enums.relation_type_rules.not_stored_in_graph_edge) {
      expect(edgeList).not.toContain(forbidden);
    }
    for (const projection of ["has_emotion", "on_topic", "triggered_by"]) {
      expect(sqlCode).not.toContain(projection);
    }
  });

  it("AI 永不创建的关系，其写入者取值集合里没有 ai_generated（K-18）", () => {
    expect(definitionList("created_by")).toEqual(["user", "user_confirmed_suggestion"]);
    for (const never of enums.relation_type_rules.ai_may_never_create) {
      expect(enums.relation_types.find((r) => r.type === never)!.carrier).not.toBe("derived_from_mention");
    }
  });

  it("三张 Mention 表结构对称，各自独有的列只有 intensity*/role（B2/I5 差异）", () => {
    const columns = (table: string): string[] =>
      (db.prepare(`pragma table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
    const emotion = columns("emotion_mention");
    const topic = columns("topic_mention");
    const entity = columns("entity_mention");
    expect(emotion.filter((c) => !topic.includes(c)).sort()).toEqual(["intensity", "intensity_source"]);
    expect(entity.filter((c) => !topic.includes(c)).sort()).toEqual(["entity_id", "role"]);
    expect(topic.filter((c) => !emotion.includes(c))).toEqual([]);
  });
});

// ── T-15：id 前缀 CHECK ──────────────────────────────────────────────

describe("T-15：每张派生表的 id 前缀 CHECK", () => {
  const probes: ReadonlyArray<{ readonly table: string; readonly prefix: string; run: (id: string) => void }> = [
    { table: "parse_run", prefix: "run", run: (id) => insertRun(id, { source_revision_id: revision2 }) },
    { table: "episode", prefix: "ep", run: (id) => insertEpisode(id) },
    { table: "thought_item", prefix: "thought", run: (id) => insertThought(id) },
    {
      table: "concept",
      prefix: "concept",
      run: (id) => insertConcept(id, "emotion", `前缀探针-${id}`),
    },
    { table: "entity", prefix: "entity", run: (id) => insertEntity(id, "person", "前缀探针") },
    {
      table: "concept_alias",
      prefix: "ca",
      run: (id) =>
        db
          .prepare(
            `insert into concept_alias (id, alias, concept_id, domain, mode, source, confirmed_at_utc)
             values (@id, @alias, 'concept_fixture_emotion', 'emotion', 'suggest', 'user_confirmed', NULL)`,
          )
          .run({ id, alias: `别名-${id}` }),
    },
    { table: "emotion_mention", prefix: "em", run: (id) => insertMention(MENTION_TABLES[0]!, { id }) },
    { table: "topic_mention", prefix: "tm", run: (id) => insertMention(MENTION_TABLES[1]!, { id }) },
    { table: "entity_mention", prefix: "enm", run: (id) => insertMention(MENTION_TABLES[2]!, { id }) },
    { table: "suggestion", prefix: "sug", run: (id) => insertSuggestion({ id }) },
    {
      table: "graph_edge",
      prefix: "edge",
      run: (id) => {
        // 夹具边引用 ep_fixture_a/b：先把它俩建出来，前缀 CHECK 才是第一道被触发的约束
        // （BEFORE INSERT 存在性触发器排在 CHECK 之前，端点缺失时会抢先报错、掩盖真正要探的约束）。
        insertEpisode("ep_fixture_a");
        insertEpisode("ep_fixture_b");
        insertEdge({ id });
      },
    },
    {
      table: "cloud_send_grant",
      prefix: "csg",
      run: (id) =>
        db
          .prepare(
            `insert into cloud_send_grant (id, record_revision_id, redacted_sha256, payload_sha256, policy_version, confirmed_at_utc)
             values (@id, @rev, @h1, @h2, 'rules-v1', @now)`,
          )
          .run({ id, rev: revisionId, h1: HEX64, h2: "a".repeat(64), now: NOW }),
    },
  ];

  for (const probe of probes) {
    it(`${probe.table} 拒绝错误前缀与空前缀，接受 ${probe.prefix}_ 前缀`, () => {
      expectRejected(() => probe.run("zzz_wrong_1"), /CHECK constraint failed/);
      expectRejected(() => probe.run(""), /CHECK constraint failed/);
      expectAccepted(() => probe.run(`${probe.prefix}_ok_1`));
    });
  }

  it("派生层每张表都有前缀 CHECK（静态守门：不允许出现无 CHECK 的新表）", () => {
    const tables = (
      db.prepare(
        "select name from sqlite_master where type='table' and name not like 'sqlite_%' and name not like 'record_fts%'",
      ).all() as Array<{ name: string }>
    ).map((r) => r.name);
    const business = tables.filter(
      (t) => !["schema_migrations", "app_meta", "vocab_seed_watermark"].includes(t),
    );
    expect(business.length).toBeGreaterThanOrEqual(16);
    const hasId = (table: string): boolean =>
      (db.prepare(`pragma table_info(${table})`).all() as Array<{ name: string }>).some((c) => c.name === "id");
    const gated = business.filter(hasId);
    // entity_alias 是 (entity_id, alias) 复合主键，没有 id 列，前缀 CHECK 对它无意义。
    expect(gated).toContain("episode");
    expect(gated).not.toContain("entity_alias");
    for (const table of gated) {
      expect(tableBlock(sqlAllCode, table)).toMatch(/CHECK \(id GLOB '[a-z_]+\_\*'\)/);
    }
  });

  it("种子概念重复播种：Concept / ConceptAlias 行数不变，别名全部挂在真实概念下", () => {
    const before = { concepts: countRows(db, "concept"), aliases: countRows(db, "concept_alias") };
    const first = seedVocabulary(db);
    expect(before.concepts).toBe(2); // 只有两条夹具概念，词表尚未播种
    expect(first.tables.conceptsInserted).toBe(54);
    expect(first.tables.conceptsExisting).toBe(0);
    expect(first.tables.aliasesInserted).toBe(countRows(db, "concept_alias") - before.aliases);
    expect(first.tables.skippedForUserRows).toBe(0);

    const after = { concepts: countRows(db, "concept"), aliases: countRows(db, "concept_alias") };
    const second = seedVocabulary(db);
    const third = seedVocabulary(db);
    expect(second.tables).toEqual({
      conceptsInserted: 0,
      conceptsExisting: 54,
      aliasesInserted: 0,
      aliasesExisting: after.aliases - before.aliases,
      skippedForUserRows: 0,
    });
    expect(third.tables.conceptsInserted).toBe(0);
    expect(countRows(db, "concept")).toBe(after.concepts);
    expect(countRows(db, "concept_alias")).toBe(after.aliases);

    const orphans = db
      .prepare(
        `select count(*) as n from concept_alias a left join concept c on c.id = a.concept_id where c.id is null`,
      )
      .get() as { n: number };
    expect(orphans.n).toBe(0);
  });

  it("播种器只用 system_seed 认领标准名；用户已占用的名字让位且不覆盖，别名改挂用户行", () => {
    // 词表名从契约文件取，不从水位表取：水位表本身要等播种才有内容，先读它会拿到空行。
    const vocabName = loadVocab("emotion").concepts.find((c) => c.aliases.length > 0)!.canonical_name;
    insertConcept("concept_user_claimed", "emotion", vocabName);
    const summary = seedVocabulary(db);
    expect(summary.tables.skippedForUserRows).toBe(1);
    const rows = db
      .prepare("select id, origin_type from concept where canonical_name = ?")
      .all(vocabName) as Array<{ id: string; origin_type: string }>;
    expect(rows).toEqual([{ id: "concept_user_claimed", origin_type: "user_created" }]);
    // 该词表名下的别名必须落到真实存在的那一行——不是指向未落位的种子 id。
    const misplaced = db
      .prepare(
        `select count(*) as n from concept_alias a
         join concept c on c.id = a.concept_id
         where c.canonical_name = ? and a.concept_id <> 'concept_user_claimed'`,
      )
      .get(vocabName) as { n: number };
    expect(misplaced.n).toBe(0);
    const aliases = db
      .prepare("select count(*) as n from concept_alias where concept_id = 'concept_user_claimed'")
      .get() as { n: number };
    expect(aliases.n).toBeGreaterThan(0);
    // 其余词表名照常以 system_seed 落位。
    const seeded = db
      .prepare("select count(*) as n from concept where origin_type = 'system_seed'")
      .get() as { n: number };
    expect(seeded.n).toBe(53);
  });

  it("mode='auto' 只由播种器写入：词表里的 auto 别名全部 source='seed'", () => {
    seedVocabulary(db);
    const bad = db
      .prepare(
        "select count(*) as n from concept_alias where mode='auto' and source <> 'seed'",
      )
      .get() as { n: number };
    expect(bad.n).toBe(0);
    const auto = db.prepare("select count(*) as n from concept_alias where mode='auto'").get() as {
      n: number;
    };
    const suggest = db
      .prepare("select count(*) as n from concept_alias where mode='suggest'")
      .get() as { n: number };
    expect(auto.n + suggest.n).toBe(countRows(db, "concept_alias"));
    expect(auto.n).toBeGreaterThan(0);
    expect(suggest.n).toBeGreaterThan(0);
  });
});

// ── T-01：Mention 来源 exactly-one ───────────────────────────────────

describe("T-01 / K-04：每条 Mention 恰好指向一种来源", () => {
  for (const st of MENTION_TABLES) {
    it(`${st.table}：三个来源列全空被拒`, () => {
      expectRejected(
        () => insertMention(st, { id: `${st.prefix}_zero`, source_record_revision_id: null }),
        /CHECK constraint failed/,
      );
    });

    it(`${st.table}：同时两个及以上来源被拒（三列的 2/3 非空组合逐个）`, () => {
      insertEpisode("ep_mention_host");
      insertThought("thought_mention_host", {
        source_record_revision_id: null,
        source_episode_id: "ep_mention_host",
      });
      expectRejected(
        () => insertMention(st, { id: `${st.prefix}_two_1`, source_episode_id: "ep_mention_host" }),
        /CHECK constraint failed/,
      );
      expectRejected(
        () =>
          insertMention(st, {
            id: `${st.prefix}_two_2`,
            source_thought_id: "thought_mention_host",
          }),
        /CHECK constraint failed/,
      );
      expectRejected(
        () =>
          insertMention(st, {
            id: `${st.prefix}_three`,
            source_record_revision_id: null,
            source_episode_id: "ep_mention_host",
            source_thought_id: "thought_mention_host",
          }),
        /CHECK constraint failed/,
      );
    });

    it(`${st.table}：单一来源（revision / episode / thought）三种都合法`, () => {
      insertEpisode("ep_ok_1");
      insertThought("thought_ok_1", {
        source_record_revision_id: null,
        source_episode_id: "ep_ok_1",
      });
      expectAccepted(() => insertMention(st, { id: `${st.prefix}_src_rev` }));
      expectAccepted(() =>
        insertMention(st, {
          id: `${st.prefix}_src_ep`,
          source_record_revision_id: null,
          source_episode_id: "ep_ok_1",
        }),
      );
      expectAccepted(() =>
        insertMention(st, {
          id: `${st.prefix}_src_th`,
          source_record_revision_id: null,
          source_thought_id: "thought_ok_1",
        }),
      );
    });
  }

  it("source_container_id 是生成列：等于唯一来源列，且不接受手工赋值", () => {
    expectRejected(
      () =>
        db
          .prepare(
            `insert into emotion_mention (id, concept_id, source_record_revision_id, label_said, origin_type, basis, created_at_utc, source_container_id)
             values ('em_gen_1', 'concept_fixture_emotion', @rev, '标签', 'user_created', 'explicit', @now, 'x')`,
          )
          .run({ rev: revisionId, now: NOW }),
      /cannot modify|generated column/i,
    );
    insertMention(MENTION_TABLES[0]!, { id: "em_read_1" });
    const row = db
      .prepare("select source_container_id from emotion_mention where id = 'em_read_1'")
      .get() as { source_container_id: string };
    expect(row.source_container_id).toBe(revisionId);
    db.prepare("delete from emotion_mention where id = 'em_read_1'").run();
  });
});

// ── T-02：basis ⊥ origin 非法组合 ────────────────────────────────────

describe("T-02 / K-05+I2：inferred 只可配 user_confirmed_suggestion", () => {
  for (const st of MENTION_TABLES) {
    it(`${st.table}：两种非法组合被拒`, () => {
      expectRejected(
        () =>
          insertMention(st, {
            id: `${st.prefix}_il_ai`,
            basis: "inferred",
            origin_type: "ai_generated",
            parse_run_id: "run_fixture_1",
          }),
        /CHECK constraint failed/,
      );
      expectRejected(
        () => insertMention(st, { id: `${st.prefix}_il_uc`, basis: "inferred" }),
        /CHECK constraint failed/,
      );
    });

    it(`${st.table}：explicit×三种 origin 与 inferred×user_confirmed_suggestion 合法`, () => {
      for (const origin of enums.origin_type_subsets.mention) {
        expectAccepted(() =>
          insertMention(st, {
            id: `${st.prefix}_legal_${origin}`,
            basis: "explicit",
            origin_type: origin,
            parse_run_id: origin === "ai_generated" ? "run_fixture_1" : null,
          }),
        );
      }
      expectAccepted(() =>
        insertMention(st, {
          id: `${st.prefix}_inf_ucs`,
          basis: "inferred",
          origin_type: "user_confirmed_suggestion",
        }),
      );
    });

    it(`${st.table}：ai_generated 必挂 run 且必有证据锚点；非 ai 行永不挂 run`, () => {
      expectRejected(
        () => insertMention(st, { id: `${st.prefix}_ai_norun`, origin_type: "ai_generated" }),
        /CHECK constraint failed/,
      );
      expectRejected(
        () =>
          insertMention(st, {
            id: `${st.prefix}_ai_noev`,
            origin_type: "ai_generated",
            parse_run_id: "run_fixture_1",
            evidence_start: null,
          }),
        /CHECK constraint failed/,
      );
      expectRejected(
        () => insertMention(st, { id: `${st.prefix}_uc_withrun`, parse_run_id: "run_fixture_1" }),
        /CHECK constraint failed/,
      );
      expectRejected(
        () =>
          insertMention(st, {
            id: `${st.prefix}_ucs_withrun`,
            origin_type: "user_confirmed_suggestion",
            parse_run_id: "run_fixture_1",
          }),
        /CHECK constraint failed/,
      );
    });
  }
});

// ── T-05：ParseRun 双态组合 + 两个部分唯一索引 ───────────────────────

describe("T-05 / B3：执行态与结果态分离（双态模型的组合不变式）", () => {
  it("queued/running 只能配 candidate；current 只能配 succeeded；failed 不得为 current", () => {
    expectRejected(
      () =>
        insertRun("run_bad_1", {
          source_revision_id: revision2,
          execution_status: "queued",
          result_state: "current",
        }),
      /CHECK constraint failed/,
    );
    expectRejected(
      () =>
        insertRun("run_bad_2", {
          source_revision_id: revision2,
          execution_status: "queued",
          result_state: "superseded",
        }),
      /CHECK constraint failed/,
    );
    expectRejected(
      () =>
        insertRun("run_bad_3", {
          source_revision_id: revision2,
          execution_status: "running",
          result_state: "current",
        }),
      /CHECK constraint failed/,
    );
    expectRejected(
      () =>
        insertRun("run_bad_4", {
          source_revision_id: revision2,
          execution_status: "failed",
          result_state: "current",
        }),
      /CHECK constraint failed/,
    );
    // 偏差 (a)：审查稿 §3.7 表格单元的双向写法会禁掉 succeeded+candidate，采纳制将无法成立。
    expectAccepted(() =>
      insertRun("run_ok_1", {
        source_revision_id: revision2,
        execution_status: "succeeded",
        result_state: "candidate",
      }),
    );
    expectAccepted(() =>
      insertRun("run_ok_2", {
        source_revision_id: revision2,
        execution_status: "failed",
        result_state: "superseded",
      }),
    );
    expectAccepted(() =>
      insertRun("run_ok_3", {
        source_revision_id: revision2,
        execution_status: "queued",
        result_state: "candidate",
      }),
    );
  });

  it("同一 revision 同时至多一个 current（ux_run_current），candidate 不受此限", () => {
    expectRejected(
      () => {
        insertRun("run_cur_a", { source_revision_id: revision2, result_state: "current" });
        insertRun("run_cur_b", { source_revision_id: revision2, result_state: "current" });
      },
      /UNIQUE constraint failed: parse_run.source_revision_id/,
    );
    expectAccepted(() => {
      insertRun("run_cand_a", { source_revision_id: revision2, pipeline_fingerprint: "a".repeat(64) });
      insertRun("run_cand_b", { source_revision_id: revision2, pipeline_fingerprint: "b".repeat(64) });
    });
  });

  it("采纳切换是原子的：旧 current 让位与新 current 上位在同一事务里成立", () => {
    attemptRollback(() => {
      db.prepare("delete from parse_run where id = 'run_fixture_1'").run();
      insertRun("run_adopt_old", { source_revision_id: revision2, result_state: "current" });
      db.prepare("update parse_run set result_state = 'superseded' where id = 'run_adopt_old'").run();
      insertRun("run_adopt_new", {
        source_revision_id: revision2,
        result_state: "current",
        pipeline_fingerprint: "b".repeat(64),
      });
    });
    // 反例：只插新 current 而不动旧行 ⇒ 被索引拒绝，采纳不可能出现两个当前结论。
    expectRejected(
      () => {
        db.prepare("delete from parse_run where id = 'run_fixture_1'").run();
        insertRun("run_adopt_keep", { source_revision_id: revision2, result_state: "current" });
        insertRun("run_adopt_clash", {
          source_revision_id: revision2,
          result_state: "current",
          pipeline_fingerprint: "c".repeat(64),
        });
      },
      /UNIQUE constraint failed: parse_run.source_revision_id/,
    );
  });

  it("同一 (revision, 指纹) 至多一个未定案/现行 run（ux_run_live）：重试复用、重跑需新指纹或先弃旧候选", () => {
    expectRejected(
      () => {
        insertRun("run_live_1", { source_revision_id: revision2 });
        insertRun("run_live_2", { source_revision_id: revision2 });
      },
      /UNIQUE constraint failed: parse_run.source_revision_id, parse_run.pipeline_fingerprint/,
    );
    expectAccepted(() =>
      insertRun("run_live_newfp", { source_revision_id: revision2, pipeline_fingerprint: "b".repeat(64) }),
    );
    // 旧候选定案（superseded）后，同指纹可以再开一次。
    expectAccepted(() => {
      db.prepare("update parse_run set result_state = 'superseded' where id = 'run_fixture_1'").run();
      insertRun("run_live_after", {});
    });
  });

  it("idempotency_key 全局唯一且非空（K-03：幂等键与指纹是两个概念）", () => {
    // 两条 run 刻意同指纹不同宿主以外全部错开？不：这里固定幂等键、放开指纹，
    // 唯一约束必须落在 idempotency_key 上，才证明它与 pipeline_fingerprint 是两个独立概念。
    expectRejected(
      () => {
        insertRun("run_key_1", {
          source_revision_id: revision2,
          idempotency_key: "k-reused",
          pipeline_fingerprint: "a".repeat(64),
        });
        insertRun("run_key_2", {
          source_revision_id: revision2,
          idempotency_key: "k-reused",
          pipeline_fingerprint: "b".repeat(64),
        });
      },
      /UNIQUE constraint failed: parse_run.idempotency_key/,
    );
    expectRejected(
      () => insertRun("run_key_empty", { source_revision_id: revision2, idempotency_key: "" }),
      /CHECK constraint failed/,
    );
    expectRejected(
      () =>
        insertRun("run_key_null", {
          source_revision_id: revision2,
          pipeline_fingerprint: "c".repeat(64),
          idempotency_key: null,
        }),
      /NOT NULL constraint failed: parse_run.idempotency_key/,
    );
  });

  it("error_kind 是封闭集合：七个取值合法、编造值被拒、NULL 合法", () => {
    const legal = [
      "network",
      "timeout",
      "invalid_json",
      "business_validation",
      "provider_schema",
      "cancelled",
      "evidence_unmapped",
    ];
    for (const kind of legal) {
      expectAccepted(() =>
        insertRun(`run_err_${kind}`, {
          source_revision_id: revision2,
          execution_status: "failed",
          error_kind: kind,
        }),
      );
    }
    expectRejected(
      () =>
        insertRun("run_err_bad", {
          source_revision_id: revision2,
          execution_status: "failed",
          error_kind: "model_said_no",
        }),
      /CHECK constraint failed/,
    );
    expectAccepted(() =>
      insertRun("run_err_null", { source_revision_id: revision2, execution_status: "failed", error_kind: null }),
    );
  });

  it("pipeline_manifest 九字段齐备才被接受（T-33 的 DB 面：缺任一项被拒）", () => {
    const keys = [
      "prompt",
      "schema",
      "model",
      "provider",
      "params",
      "redaction",
      "redactionMap",
      "resolver",
      "validation",
    ];
    for (const drop of keys) {
      const manifest = JSON.parse(MANIFEST) as Record<string, unknown>;
      delete manifest[drop];
      expectRejected(
        () =>
          insertRun(`run_manifest_${drop}`, {
            source_revision_id: revision2,
            pipeline_manifest: JSON.stringify(manifest),
          }),
        /CHECK constraint failed/,
      );
    }
    expectRejected(
      () =>
        insertRun("run_manifest_bad", { source_revision_id: revision2, pipeline_manifest: "不是 JSON" }),
      /CHECK constraint failed/,
    );
    expectRejected(
      () => insertRun("run_manifest_null", { source_revision_id: revision2, pipeline_manifest: null }),
      /NOT NULL constraint failed/,
    );
  });

  it("指纹必须是 64 位小写十六进制（哈希形态守门，T-23 同源）", () => {
    for (const bad of ["f".repeat(63), "F".repeat(64), `${"f".repeat(63)}z`]) {
      expectRejected(
        () => insertRun(`run_fp_${bad.length}`, { source_revision_id: revision2, pipeline_fingerprint: bad }),
        /CHECK constraint failed/,
      );
    }
  });
});

// ── T-21 / B8：事件时间五元组相容 ────────────────────────────────────

describe("T-21：事件时间 precision / certainty / 起止区间互相相容（P14 用例照搬）", () => {
  it("unknown ⇒ 起止皆空且 certainty=unknown（一个正例、三个反例）", () => {
    expectAccepted(() => insertEpisode("ep_t_unknown_ok"));
    for (const certainty of ["explicit", "approximate"]) {
      expectRejected(
        () => insertEpisode(`ep_t_unknown_${certainty}`, { event_time_certainty: certainty }),
        /CHECK constraint failed/,
      );
    }
    expectRejected(
      () =>
        insertEpisode("ep_t_unknown_dates", {
          event_time_start: "2026-03-01",
          event_time_end: "2026-03-31",
        }),
      /CHECK constraint failed/,
    );
  });

  it("year ⇒ 必须覆盖完整年度（一个正例、两个反例）", () => {
    const year = {
      event_time_precision: "year",
      event_time_certainty: "explicit",
      event_time_raw: "2026 年",
    };
    expectAccepted(() =>
      insertEpisode("ep_t_year_ok", { ...year, event_time_start: "2026-01-01", event_time_end: "2026-12-31" }),
    );
    expectRejected(
      () =>
        insertEpisode("ep_t_year_short", {
          ...year,
          event_time_start: "2026-01-01",
          event_time_end: "2026-12-30",
        }),
      /CHECK constraint failed/,
    );
    expectRejected(
      () =>
        insertEpisode("ep_t_year_shift", {
          ...year,
          event_time_start: "2025-12-31",
          event_time_end: "2026-12-30",
        }),
      /CHECK constraint failed/,
    );
  });

  it("month ⇒ 必须覆盖完整自然月（含二月平年与闰年）", () => {
    const month = { event_time_precision: "month", event_time_certainty: "explicit", event_time_raw: "某月" };
    const accepted: readonly (readonly [string, string, string])[] = [
      ["ep_t_month_31", "2026-03-01", "2026-03-31"],
      ["ep_t_month_feb26", "2026-02-01", "2026-02-28"],
      ["ep_t_month_feb28", "2028-02-01", "2028-02-29"],
      ["ep_t_month_30", "2026-04-01", "2026-04-30"],
    ];
    for (const [id, start, end] of accepted) {
      expectAccepted(() =>
        insertEpisode(id, { ...month, event_time_start: start, event_time_end: end }),
      );
    }
    const rejected: readonly (readonly [string, string, string])[] = [
      ["ep_t_month_short", "2026-03-01", "2026-03-30"],
      ["ep_t_month_rollback", "2026-02-01", "2026-03-01"],
      ["ep_t_month_feb_leap", "2028-02-01", "2028-02-28"],
      ["ep_t_month_head", "2026-03-02", "2026-03-31"],
    ];
    for (const [id, start, end] of rejected) {
      expectRejected(
        () => insertEpisode(id, { ...month, event_time_start: start, event_time_end: end }),
        /CHECK constraint failed/,
      );
    }
  });

  it("day ⇒ 起止必须同一天；区间、倒置、缺 raw、certainty=unknown 一律被拒", () => {
    const day = { event_time_precision: "day", event_time_certainty: "explicit", event_time_raw: "10 月 12 日" };
    expectAccepted(() =>
      insertEpisode("ep_t_day_ok", { ...day, event_time_start: "2026-10-12", event_time_end: "2026-10-12" }),
    );
    expectRejected(
      () =>
        insertEpisode("ep_t_day_span", { ...day, event_time_start: "2026-10-12", event_time_end: "2026-10-13" }),
      /CHECK constraint failed/,
    );
    expectRejected(
      () =>
        insertEpisode("ep_t_day_rev", { ...day, event_time_start: "2026-10-13", event_time_end: "2026-10-12" }),
      /CHECK constraint failed/,
    );
    expectRejected(
      () => insertEpisode("ep_t_day_noraw", { ...day, event_time_raw: null }),
      /CHECK constraint failed/,
    );
    expectRejected(
      () =>
        insertEpisode("ep_t_day_uncert", {
          ...day,
          event_time_certainty: "unknown",
          event_time_start: "2026-10-12",
          event_time_end: "2026-10-12",
        }),
      /CHECK constraint failed/,
    );
  });

  it("非 unknown 精度但起止为空被拒；近似时间也允许（approximate 合法）", () => {
    expectRejected(
      () =>
        insertEpisode("ep_t_no_dates", {
          event_time_precision: "year",
          event_time_certainty: "explicit",
          event_time_raw: "2026",
        }),
      /CHECK constraint failed/,
    );
    expectAccepted(() =>
      insertEpisode("ep_t_approx", {
        event_time_precision: "month",
        event_time_certainty: "approximate",
        event_time_raw: "大概三月",
        event_time_start: "2026-03-01",
        event_time_end: "2026-03-31",
      }),
    );
  });

  it("AI 派生 Episode 同样受时间五元组约束（不因来源不同而放宽）", () => {
    expectRejected(
      () =>
        insertEpisode("ep_time_ai_bad", {
          origin_type: "ai_generated",
          source_record_revision_id: revisionId,
          parse_run_id: "run_fixture_1",
          evidence_text: "焦虑",
          evidence_start: 18,
          evidence_end: 20,
          event_time_precision: "month",
          event_time_certainty: "explicit",
          event_time_raw: "十月",
          event_time_start: "2026-10-01",
          event_time_end: "2026-10-30",
        }),
      /CHECK constraint failed/,
    );
  });
});

// ── T-22 / B5：别名唯一性的定义域 ────────────────────────────────────

describe("T-22 / B5+P15：别名唯一性的定义域", () => {
  function alias(id: string, aliasName: string, conceptId: string, domain: string, mode = "auto"): void {
    db.prepare(
      `insert into concept_alias (id, alias, concept_id, domain, mode, source, confirmed_at_utc)
       values (?, ?, ?, ?, ?, 'seed', NULL)`,
    ).run(id, aliasName, conceptId, domain, mode);
  }

  it("跨域同名允许；同域同词二次指向被唯一索引拒绝", () => {
    expectAccepted(() => {
      alias("ca_x_em", "压力", "concept_fixture_emotion", "emotion");
      alias("ca_x_tp", "压力", "concept_fixture_topic", "topic");
    });
    expectRejected(
      () => {
        alias("ca_d_1", "内耗", "concept_fixture_emotion", "emotion");
        alias("ca_d_2", "内耗", "concept_fixture_emotion", "emotion");
      },
      /UNIQUE constraint failed: concept_alias.domain, concept_alias.alias/,
    );
  });

  it("domain 与所属概念的 concept_type 错配被触发器拒绝（插入与更新两条路）", () => {
    expectRejected(
      () => alias("ca_mismatch", "错域", "concept_fixture_emotion", "topic"),
      /concept_alias\.domain 必须等于所属概念的 concept_type/,
    );
    db.prepare(
      `insert into concept_alias (id, alias, concept_id, domain, mode, source, confirmed_at_utc)
       values ('ca_updatable', '可改', 'concept_fixture_emotion', 'emotion', 'suggest', 'user_confirmed', NULL)`,
    ).run();
    expectRejected(
      () => db.prepare("update concept_alias set domain = 'topic' where id = 'ca_updatable'").run(),
      /concept_alias\.domain 必须等于所属概念的 concept_type/,
    );
    expectRejected(
      () =>
        db
          .prepare("update concept_alias set concept_id = 'concept_fixture_topic' where id = 'ca_updatable'")
          .run(),
      /concept_alias\.domain 必须等于所属概念的 concept_type/,
    );
    db.prepare("delete from concept_alias where id = 'ca_updatable'").run();
  });

  it("别名指向不存在的概念被同一触发器拒绝（FK 不是唯一防线）", () => {
    expectRejected(
      () => alias("ca_ghost", "幽灵", "concept_不存在", "emotion"),
      /concept_alias\.domain 必须等于所属概念的 concept_type/,
    );
  });

  it("entity_alias：跨实体同名容许，同一实体内重名被复合主键拒绝", () => {
    insertEntity("entity_alias_a", "person", "甲");
    insertEntity("entity_alias_b", "person", "乙");
    const write = (entityId: string, aliasName: string): void => {
      db.prepare("insert into entity_alias (entity_id, alias, created_at_utc) values (?, ?, ?)").run(
        entityId,
        aliasName,
        NOW,
      );
    };
    expectAccepted(() => {
      write("entity_alias_a", "老张");
      write("entity_alias_b", "老张");
    });
    expectRejected(
      () => {
        write("entity_alias_a", "老张");
        write("entity_alias_a", "老张");
      },
      /UNIQUE constraint failed: entity_alias.entity_id, entity_alias.alias/,
    );
  });

  it("实体不设名称唯一：同名不同人是常态（B5）", () => {
    expectAccepted(() => {
      insertEntity("entity_same_1", "person", "张伟");
      insertEntity("entity_same_2", "person", "张伟");
    });
  });

  it("概念同名双行被 UNIQUE(concept_type, canonical_name) 拒绝，跨类型同名容许", () => {
    expectRejected(
      () => {
        insertConcept("concept_dup_1", "emotion", "重复名");
        insertConcept("concept_dup_2", "emotion", "重复名");
      },
      /UNIQUE constraint failed: concept.concept_type, concept.canonical_name/,
    );
    expectAccepted(() => {
      insertConcept("concept_cross_1", "emotion", "跨界词");
      insertConcept("concept_cross_2", "topic", "跨界词");
    });
  });
});

// ── T-23 / 四.5 + K-17：授权哈希与复用键 ─────────────────────────────

describe("T-23 / K-17：云端发送授权的哈希形态与逐版本复用规则", () => {
  function grant(id: string, payload: string, redacted: string, policy = "rules-v1"): void {
    db.prepare(
      `insert into cloud_send_grant (id, record_revision_id, redacted_sha256, payload_sha256, policy_version, confirmed_at_utc)
       values (?, ?, ?, ?, ?, ?)`,
    ).run(id, revisionId, redacted, payload, policy, NOW);
  }

  it("63 位、大写、非 hex 三类被拒，64 位小写通过（两个哈希列同法）", () => {
    expectRejected(() => grant("csg_short", "a".repeat(63), HEX64), /CHECK constraint failed/);
    expectRejected(() => grant("csg_upper", "A".repeat(64), HEX64), /CHECK constraint failed/);
    expectRejected(() => grant("csg_hex", `${"a".repeat(63)}g`, HEX64), /CHECK constraint failed/);
    expectRejected(() => grant("csg_redacted", HEX64, "z".repeat(64)), /CHECK constraint failed/);
    expectAccepted(() => grant("csg_ok", HEX64, "b".repeat(64)));
  });

  it("同一 revision + 同一载荷 + 同一策略不存在第二条；内容或策略一变即另算（K-17）", () => {
    expectRejected(
      () => {
        grant("csg_dup_1", HEX64, "b".repeat(64));
        grant("csg_dup_2", HEX64, "b".repeat(64));
      },
      /UNIQUE constraint failed: cloud_send_grant.record_revision_id, cloud_send_grant.payload_sha256, cloud_send_grant.policy_version/,
    );
    expectAccepted(() => {
      grant("csg_policy_1", HEX64, "b".repeat(64), "rules-v1");
      grant("csg_policy_2", "b".repeat(64), "c".repeat(64), "rules-v2");
    });
    expectAccepted(() => {
      grant("csg_content_1", HEX64, "b".repeat(64));
      grant("csg_content_2", "e".repeat(64), "d".repeat(64));
    });
  });

  it("逐版本授权：另一版本的载荷互不通用（不同 revision 各自成键）", () => {
    db.prepare(
      `insert into cloud_send_grant (id, record_revision_id, redacted_sha256, payload_sha256, policy_version, confirmed_at_utc)
       values ('csg_v1', ?, ?, ?, 'rules-v1', ?)`,
    ).run(revisionId, HEX64, "b".repeat(64), NOW);
    expectAccepted(() =>
      db
        .prepare(
          `insert into cloud_send_grant (id, record_revision_id, redacted_sha256, payload_sha256, policy_version, confirmed_at_utc)
           values ('csg_v2', ?, ?, ?, 'rules-v1', ?)`,
        )
        .run(revision2, HEX64, "b".repeat(64), NOW),
    );
  });

  it("授权表不存待发送文本本体：列集合只有身份与哈希（隐私面静态断言）", () => {
    const cols = db.prepare("pragma table_info(cloud_send_grant)").all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name).sort()).toEqual(
      [
        "confirmed_at_utc",
        "id",
        "payload_sha256",
        "policy_version",
        "redacted_sha256",
        "record_revision_id",
      ].sort(),
    );
    expect(sqlCode).not.toMatch(/CREATE TABLE cloud_send_grant[\s\S]*?(raw_text|tokens|redacted_text)/);
  });

  it("processing_* 与授权彼此独立：capture_record 里没有指向授权的列（K：不得互相推断）", () => {
    const cols = db.prepare("pragma table_info(capture_record)").all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).toContain("processing_mode");
    expect(cols.map((c) => c.name)).not.toContain("cloud_send_grant_id");
    expect(cols.map((c) => c.name)).not.toContain("sleep_session_id");
  });

  it("FK CASCADE：版本删除时其授权随之消失，不留悬空许可", () => {
    db.prepare(
      `insert into cloud_send_grant (id, record_revision_id, redacted_sha256, payload_sha256, policy_version, confirmed_at_utc)
       values ('csg_cascade', ?, ?, ?, 'rules-v1', ?)`,
    ).run(revisionId, HEX64, "b".repeat(64), NOW);
    db.exec("begin immediate");
    db.prepare("delete from record_revision where id = ?").run(revisionId);
    expect(countRows(db, "cloud_send_grant")).toBe(0);
    db.exec("rollback");
    expect(countRows(db, "cloud_send_grant")).toBe(1);
  });
});

// ── T-25 / 四.3：Suggestion 空串哨兵唯一键 ───────────────────────────

describe("T-25 / P18：建议的哨兵列与唯一键", () => {
  it("键列一律 NOT NULL DEFAULT ''（可空键列不参与去重，故禁用）", () => {
    const cols = db.prepare("pragma table_info(suggestion)").all() as Array<{
      name: string;
      notnull: number;
      dflt_value: string | null;
    }>;
    for (const name of ["relation_type", "endpoint_a", "endpoint_b", "subject_term", "reason_code", "status"]) {
      const col = cols.find((c) => c.name === name)!;
      expect(col.notnull, name).toBe(1);
    }
    for (const name of ["relation_type", "endpoint_a", "endpoint_b", "subject_term", "reason_code"]) {
      expect((cols.find((c) => c.name === name)!).dflt_value, name).toBe("''");
    }
  });

  it("同一 (kind, relation_type, endpoint_a, endpoint_b) 重复插入被拒——词面不同也不放宽", () => {
    expectRejected(
      () => {
        insertSuggestion({ id: "sug_dup_1" });
        insertSuggestion({ id: "sug_dup_2", subject_term: "另一个词面" });
      },
      /UNIQUE constraint failed: suggestion.kind, suggestion.relation_type, suggestion.endpoint_a, suggestion.endpoint_b/,
    );
  });

  it("不同 kind 可以指向同一目标（候选彼此独立）", () => {
    expectAccepted(() => {
      insertSuggestion({ id: "sug_k1", kind: "emotion_candidate", endpoint_a: "concept_fixture_emotion" });
      insertSuggestion({
        id: "sug_k2",
        kind: "new_concept",
        endpoint_a: "concept_fixture_emotion",
        subject_term: FIXTURE_EMOTION,
      });
      insertSuggestion({
        id: "sug_k3",
        kind: "alias",
        endpoint_a: "concept_fixture_emotion",
        subject_term: "有点慌",
      });
    });
  });

  it("ux_sug_term：成对建议的同一左端点+同一词面只可能有一条", () => {
    expectRejected(
      () => {
        insertSuggestion({
          id: "sug_term_1",
          kind: "possibly_related",
          relation_type: "possibly_related",
          endpoint_a: "ep_a",
          endpoint_b: "ep_b",
          subject_term: "同一词面",
        });
        insertSuggestion({
          id: "sug_term_2",
          kind: "possibly_related",
          relation_type: "possibly_related",
          endpoint_a: "ep_a",
          endpoint_b: "ep_c",
          subject_term: "同一词面",
        });
      },
      /UNIQUE constraint failed/,
    );
    expectAccepted(() => {
      insertSuggestion({
        id: "sug_term_3",
        kind: "possibly_related",
        relation_type: "possibly_related",
        endpoint_a: "ep_d",
        endpoint_b: "ep_e",
        subject_term: "词面甲",
      });
      insertSuggestion({
        id: "sug_term_4",
        kind: "possibly_related",
        relation_type: "possibly_related",
        endpoint_a: "ep_d",
        endpoint_b: "ep_f",
        subject_term: "词面乙",
      });
    });
  });

  it("端点矩阵：非成对 kind 的 endpoint_b 必须为空串；成对 kind 两端齐全且字典序归一", () => {
    expectRejected(
      () => insertSuggestion({ id: "sug_pair_leak", kind: "alias", endpoint_b: "concept_fixture_topic" }),
      /CHECK constraint failed/,
    );
    expectRejected(
      () =>
        insertSuggestion({
          id: "sug_pair_order",
          kind: "possibly_related",
          relation_type: "possibly_related",
          endpoint_a: "ep_z",
          endpoint_b: "ep_a",
        }),
      /CHECK constraint failed/,
    );
    expectRejected(
      () =>
        insertSuggestion({
          id: "sug_pair_half",
          kind: "possibly_same_as",
          relation_type: "possibly_same_as",
          endpoint_a: "entity_fixture_1",
          endpoint_b: "",
        }),
      /CHECK constraint failed/,
    );
    expectAccepted(() =>
      insertSuggestion({
        id: "sug_pair_ok",
        kind: "possibly_same_as",
        relation_type: "possibly_same_as",
        endpoint_a: "entity_a",
        endpoint_b: "entity_b",
        subject_term: "",
      }),
    );
  });

  it("kind 与 relation_type 绑定：无关系类候选的关系类型只能是空串", () => {
    expectRejected(
      () => insertSuggestion({ id: "sug_rt_bad", relation_type: "same_as" }),
      /CHECK constraint failed/,
    );
    expectRejected(
      () => insertSuggestion({ id: "sug_rt_missing", kind: "possibly_same_as", relation_type: "" }),
      /CHECK constraint failed/,
    );
  });

  it("reason_code 是封闭代码集，自由文本被拒（B6：审计面不留敏感原文的形态前提）", () => {
    for (const code of ["", "basis_lost", "superseded_by_user", "user_ignored"]) {
      expectAccepted(() => insertSuggestion({ id: `sug_rc_${code || "empty"}` , reason_code: code }));
    }
    expectRejected(
      () => insertSuggestion({ id: "sug_rc_bad", reason_code: "用户说这段原文太私密了" }),
      /CHECK constraint failed/,
    );
  });

  it("evidence_repair 是封闭 kind 之一（T-27 的落点由服务层构造，这里先钉住库能收）", () => {
    expect(enums.suggestion_kinds).toContain("evidence_repair");
    expectAccepted(() =>
      insertSuggestion({
        id: "sug_repair_1",
        kind: "evidence_repair",
        endpoint_a: "em_repair_target",
        subject_term: "",
      }),
    );
  });

  it("Suggestion.status 取值与 enums 一致，缺省 pending", () => {
    const pendingDefault = /status TEXT NOT NULL DEFAULT 'pending' CHECK \(\s*status IN \(([\s\S]*?)\)/.exec(sql);
    expect(pendingDefault).not.toBeNull();
    expect([...pendingDefault![1]!.matchAll(/'([^']*)'/g)].map((m) => m[1]!)).toEqual(
      enums.lifecycle_states["Suggestion.status"].values,
    );
    expectRejected(() => insertSuggestion({ id: "sug_st_bad", status: "maybe" }), /CHECK constraint failed/);
  });

  it("建议随来源 run 级联消失（候选不是永久债务，依据没了就撤）", () => {
    insertSuggestion({ id: "sug_cascade_1" });
    db.exec("begin immediate");
    db.prepare("delete from parse_run where id = 'run_fixture_1'").run();
    expect(countRows(db, "suggestion")).toBe(0);
    db.exec("rollback");
    expect(countRows(db, "suggestion")).toBe(1);
  });
});

// ── T-26 / 四.2：GraphEdge 方向与端点 ────────────────────────────────

describe("T-26 / P19：GraphEdge 无 directed 列，方向由关系类型与字典序约束承载", () => {
  beforeEach(() => {
    insertEpisode("ep_fixture_a");
    insertEpisode("ep_fixture_b");
  });

  it("不存在名为 directed 的列（pragma 与静态扫描双重断言）", () => {
    const cols = db.prepare("pragma table_info(graph_edge)").all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).not.toContain("directed");
    expect(sqlCode).not.toMatch(/\bdirected\b/);
  });

  it("无向类型只存一个方向：镜像插入被拒；有向 merged_into 两向容许", () => {
    expectRejected(
      () => insertEdge({ id: "edge_mirror", src_id: "ep_fixture_b", dst_id: "ep_fixture_a" }),
      /CHECK constraint failed/,
    );
    expectAccepted(() =>
      insertEdge({
        id: "edge_dir_1",
        relation_type: "merged_into",
        src_kind: "concept",
        dst_kind: "concept",
        src_id: "concept_fixture_emotion",
        dst_id: "concept_fixture_topic",
      }),
    );
    expectAccepted(() =>
      insertEdge({
        id: "edge_dir_2",
        relation_type: "merged_into",
        src_kind: "concept",
        dst_kind: "concept",
        src_id: "concept_fixture_topic",
        dst_id: "concept_fixture_emotion",
      }),
    );
  });

  it("关系类型与端点种类绑定：三种组合各自成立，错位被拒", () => {
    // episode×episode ↔ possibly_related、entity×entity ↔ same_as、concept×concept ↔ merged_into。
    expectAccepted(() => insertEdge({ id: "edge_k_ep" }));
    expectRejected(
      () => insertEdge({ id: "edge_k_1", relation_type: "same_as" }),
      /CHECK constraint failed/,
    );
    insertEntity("entity_edge_a", "person", "甲");
    insertEntity("entity_edge_b", "person", "乙");
    expectAccepted(() =>
      insertEdge({
        id: "edge_k_2",
        relation_type: "same_as",
        src_kind: "entity",
        dst_kind: "entity",
        src_id: "entity_edge_a",
        dst_id: "entity_edge_b",
      }),
    );
    expectAccepted(() =>
      insertEdge({
        id: "edge_k_concept",
        relation_type: "merged_into",
        src_kind: "concept",
        dst_kind: "concept",
        src_id: "concept_fixture_emotion",
        dst_id: "concept_fixture_topic",
      }),
    );
    // 端点真实存在、只有「类型⊥种类」错位：存在性触发器放行，绑定 CHECK 必须接住。
    expectRejected(
      () =>
        insertEdge({
          id: "edge_k_3",
          src_kind: "concept",
          dst_kind: "concept",
          src_id: "concept_fixture_emotion",
          dst_id: "concept_fixture_topic",
        }),
      /CHECK constraint failed/,
    );
  });

  it("端点不存在被存在性触发器拒绝（多态引用没有 FK，触发器是唯一等价物）", () => {
    expectRejected(
      () => insertEdge({ id: "edge_ghost_1", src_id: "ep_不存在", dst_id: "ep_fixture_b" }),
      /graph_edge\.src_id 指向不存在的 episode/,
    );
    expectRejected(
      () => insertEdge({ id: "edge_ghost_2", src_id: "ep_fixture_a", dst_id: "ep_不存在" }),
      /CHECK constraint failed|graph_edge\.dst_id 指向不存在的 episode/,
    );
    expectRejected(
      () =>
        insertEdge({
          id: "edge_ghost_concept",
          relation_type: "merged_into",
          src_kind: "concept",
          dst_kind: "concept",
          src_id: "concept_a",
          dst_id: "concept_z",
        }),
      /graph_edge\.src_id 指向不存在的 concept/,
    );
    insertEdge({ id: "edge_alive" });
    expectRejected(
      () => db.prepare("update graph_edge set dst_id = 'zz_不存在' where id = 'edge_alive'").run(),
      /graph_edge\.dst_id 指向不存在的 episode/,
    );
    db.prepare("delete from graph_edge where id = 'edge_alive'").run();
  });

  it("端点消失 ⇒ 引用它的边一并清除（AFTER DELETE 触发器 = 删除矩阵里的级联 D）", () => {
    insertEdge({ id: "edge_ad_1" });
    insertEdge({
      id: "edge_ad_2",
      relation_type: "merged_into",
      src_kind: "concept",
      dst_kind: "concept",
      src_id: "concept_fixture_emotion",
      dst_id: "concept_fixture_topic",
    });
    expect(countRows(db, "graph_edge")).toBe(2);
    db.exec("begin immediate");
    db.prepare("delete from episode where id = 'ep_fixture_b'").run();
    expect(
      db
        .prepare("select count(*) as n from graph_edge where src_id='ep_fixture_b' or dst_id='ep_fixture_b'")
        .get(),
    ).toEqual({ n: 0 });
    db.exec("rollback");
    db.exec("begin immediate");
    db.prepare("delete from concept where id = 'concept_fixture_topic'").run();
    expect(
      db
        .prepare(
          "select count(*) as n from graph_edge where src_id='concept_fixture_topic' or dst_id='concept_fixture_topic'",
        )
        .get(),
    ).toEqual({ n: 0 });
    db.exec("rollback");
    expect(countRows(db, "graph_edge")).toBe(2);
  });

  it("created_by 只有用户来源：AI 直接建边在这张表里没有落点", () => {
    expectRejected(() => insertEdge({ id: "edge_ai_1", created_by: "ai_generated" }), /CHECK constraint failed/);
    expectRejected(() => insertEdge({ id: "edge_ai_2", created_by: "system_seed" }), /CHECK constraint failed/);
    expectAccepted(() => insertEdge({ id: "edge_user_confirmed", created_by: "user_confirmed_suggestion" }));
  });
});

// ── T-32 / B4+K-22：来源与运行绑定 ───────────────────────────────────

describe("T-32 / B4+K-22：来源缺失的行在库里不可能存在", () => {
  it("thought_item 两个来源列全空被拒（手工创建必须先有记录与版本）", () => {
    expectRejected(
      () => insertThought("thought_orphan", { source_record_revision_id: null }),
      /CHECK constraint failed/,
    );
  });

  it("thought_item 同时挂 revision 与 episode 被拒（exactly-one）", () => {
    insertEpisode("ep_th_host");
    expectRejected(
      () => insertThought("thought_two", { source_episode_id: "ep_th_host" }),
      /CHECK constraint failed/,
    );
  });

  it("AI 派生的 episode/thought 必同时锚定 revision 与 run；手工行两者皆空", () => {
    expectRejected(
      () =>
        insertEpisode("ep_ai_norun", {
          origin_type: "ai_generated",
          source_record_revision_id: revisionId,
          evidence_text: "焦虑",
          evidence_start: 18,
          evidence_end: 20,
        }),
      /CHECK constraint failed/,
    );
    expectRejected(
      () =>
        insertEpisode("ep_ai_norev", {
          origin_type: "ai_generated",
          parse_run_id: "run_fixture_1",
          evidence_text: "焦虑",
          evidence_start: 18,
          evidence_end: 20,
        }),
      /CHECK constraint failed/,
    );
    expectRejected(
      () => insertEpisode("ep_uc_withrun", { parse_run_id: "run_fixture_1" }),
      /CHECK constraint failed/,
    );
    expectRejected(
      () => insertThought("thought_ai_runless", { parse_run_id: "run_fixture_1" }),
      /CHECK constraint failed/,
    );
    expectAccepted(() =>
      insertEpisode("ep_ai_ok", {
        origin_type: "ai_generated",
        source_record_revision_id: revisionId,
        parse_run_id: "run_fixture_1",
        evidence_text: "焦虑",
        evidence_start: 18,
        evidence_end: 20,
      }),
    );
    expectAccepted(() =>
      insertThought("thought_ai_ok", {
        origin_type: "ai_generated",
        parse_run_id: "run_fixture_1",
        evidence_text: "焦虑",
        evidence_start: 18,
        evidence_end: 20,
      }),
    );
  });

  it("AI 行必须有证据文本：无原文可回溯的结论不许落库", () => {
    expectRejected(
      () =>
        insertEpisode("ep_ai_noevidence", {
          origin_type: "ai_generated",
          source_record_revision_id: revisionId,
          parse_run_id: "run_fixture_1",
          evidence_text: "",
          evidence_start: 0,
          evidence_end: 1,
        }),
      /CHECK constraint failed/,
    );
  });

  it("空 summary / 空 text / 空名称被拒：派生层不接受无内容的壳", () => {
    expectRejected(() => insertEpisode("ep_empty", { summary: "" }), /CHECK constraint failed/);
    expectRejected(() => insertThought("thought_empty", { text: "" }), /CHECK constraint failed/);
    expectRejected(() => insertConcept("concept_empty", "emotion", ""), /CHECK constraint failed/);
    expectRejected(
      () => insertEntity("entity_empty_display", "person", "甲", { display_name: "" }),
      /CHECK constraint failed/,
    );
  });

  it("证据偏移单调性：end<start、负数、只有 start 一律被拒", () => {
    const bad: Array<Record<string, unknown>> = [
      { evidence_start: 5, evidence_end: 3 },
      { evidence_start: -1, evidence_end: 2 },
      { evidence_start: 0, evidence_end: null },
    ];
    for (const [i, v] of bad.entries()) {
      expectRejected(
        () =>
          insertEpisode(`ep_ev_${i}`, {
            origin_type: "ai_generated",
            source_record_revision_id: revisionId,
            parse_run_id: "run_fixture_1",
            evidence_text: "焦虑",
            ...v,
          }),
        /CHECK constraint failed/,
      );
    }
  });

  it("概念/实体被引用时不得被删除（RESTRICT），派生行随来源/运行级联消失（CASCADE）", () => {
    expectRejected(
      () => {
        insertMention(MENTION_TABLES[0]!, { id: "em_restrict_1" });
        db.prepare("delete from concept where id = 'concept_fixture_emotion'").run();
      },
      /FOREIGN KEY constraint failed/,
    );
    expectRejected(
      () => {
        insertMention(MENTION_TABLES[2]!, { id: "enm_restrict_1" });
        db.prepare("delete from entity where id = 'entity_fixture_1'").run();
      },
      /FOREIGN KEY constraint failed/,
    );
    db.exec("begin immediate");
    insertMention(MENTION_TABLES[0]!, {
      id: "em_cascade_1",
      origin_type: "ai_generated",
      parse_run_id: "run_fixture_1",
    });
    db.prepare("delete from parse_run where id = 'run_fixture_1'").run();
    expect(
      db.prepare("select count(*) as n from emotion_mention where id = 'em_cascade_1'").get(),
    ).toEqual({ n: 0 });
    db.exec("rollback");
    db.exec("begin immediate");
    insertMention(MENTION_TABLES[0]!, { id: "em_cascade_rev", parse_run_id: null });
    db.prepare("delete from record_revision where id = ?").run(revisionId);
    expect(
      db.prepare("select count(*) as n from emotion_mention where id = 'em_cascade_rev'").get(),
    ).toEqual({ n: 0 });
    db.exec("rollback");
  });

  it("实体提升是状态变化不新建 ID：lifecycle_status 封闭集合，provisional 缺省", () => {
    expect(defaultOf("entity", "lifecycle_status")).toBe("provisional");
    expectRejected(
      () => insertEntity("entity_ls_bad", "person", "甲", { lifecycle_status: "merged" }),
      /CHECK constraint failed/,
    );
    expectAccepted(() => insertEntity("entity_ls_prov", "person", "乙", { lifecycle_status: "provisional" }));
  });

  it("实体 privacy_level 与概念 origin_type 各自的封闭集合", () => {
    expectRejected(
      () => insertEntity("entity_pv_bad", "person", "甲", { privacy_level: "secret" }),
      /CHECK constraint failed/,
    );
    expectRejected(
      () =>
        db
          .prepare(
            `insert into concept (id, concept_type, canonical_name, origin_type, lifecycle_status, created_at_utc)
             values ('concept_ai', 'emotion', 'AI 造概念', 'ai_generated', 'active', ?)`,
          )
          .run(NOW),
      /CHECK constraint failed/,
    );
    expectRejected(
      () =>
        db
          .prepare(
            `insert into concept (id, concept_type, canonical_name, origin_type, lifecycle_status, created_at_utc)
             values ('concept_type_bad', 'relation', '错类型', 'user_created', 'active', ?)`,
          )
          .run(NOW),
      /CHECK constraint failed/,
    );
  });
});

// ── K-19：强度只有用户能填；时间戳形态 ──────────────────────────────

describe("K-19 与时间形态：派生层的用户专属字段与时刻格式", () => {
  const emotion = MENTION_TABLES[0]!;

  it("intensity 有值而 intensity_source 缺失被拒；越界值被拒；来源只能写 user", () => {
    expectRejected(() => insertMention(emotion, { id: "em_i_nosrc", intensity: 3 }), /CHECK constraint failed/);
    for (const value of [-1, 0, 6]) {
      expectRejected(
        () => insertMention(emotion, { id: `em_i_${value}`, intensity: value, intensity_source: "user" }),
        /CHECK constraint failed/,
      );
    }
    expectRejected(
      () => insertMention(emotion, { id: "em_i_model", intensity_source: "model" }),
      /CHECK constraint failed/,
    );
  });

  it("1–5 配 intensity_source='user' 合法，NULL 强度也合法", () => {
    for (const value of [1, 2, 3, 4, 5]) {
      expectAccepted(() =>
        insertMention(emotion, { id: `em_i_ok${value}`, intensity: value, intensity_source: "user" }),
      );
    }
    expectAccepted(() => insertMention(emotion, { id: "em_i_null" }));
  });

  it("只有 emotion_mention 承载强度；role 只在 entity_mention", () => {
    const columns = (table: string): string[] =>
      (db.prepare(`pragma table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
    expect(columns("topic_mention")).not.toContain("intensity");
    expect(columns("entity_mention")).not.toContain("intensity");
    expect(columns("topic_mention")).not.toContain("role");
    expect(columns("entity_mention")).toContain("role");
  });

  it("role 是可空自由文本（B2/I5）：只守形态，不建封闭枚举", () => {
    expectAccepted(() => insertMention(MENTION_TABLES[2]!, { id: "enm_role_1", role: "同事" }));
    expectAccepted(() => insertMention(MENTION_TABLES[2]!, { id: "enm_role_2", role: "任何非枚举说法" }));
    expectRejected(
      () => insertMention(MENTION_TABLES[2]!, { id: "enm_role_pad", role: "带尾空格 " }),
      /CHECK constraint failed/,
    );
    expectRejected(
      () => insertMention(MENTION_TABLES[2]!, { id: "enm_role_blank", role: "   " }),
      /CHECK constraint failed/,
    );
    expectRejected(
      () => insertMention(MENTION_TABLES[2]!, { id: "enm_role_long", role: "长".repeat(201) }),
      /CHECK constraint failed/,
    );
  });

  it("所有时刻列必须是 UTC 且 Z 结尾：本地偏移与裸时间被拒（与 M1 同一形态约定）", () => {
    for (const bad of ["2026-10-13T06:30:00", "2026-10-13T14:30:00.000+08:00", "不是时间"]) {
      expectRejected(
        () => insertEpisode("ep_time_fmt", { created_at_utc: bad }),
        /CHECK constraint failed/,
      );
      expectRejected(
        () => insertRun("run_time_fmt", { source_revision_id: revision2, started_at_utc: bad }),
        /CHECK constraint failed/,
      );
      expectRejected(
        () => insertSuggestion({ id: "sug_time_fmt", created_at_utc: bad }),
        /CHECK constraint failed/,
      );
    }
    expectAccepted(() => insertRun("run_finished_null", { source_revision_id: revision2, finished_at_utc: null }));
    expectRejected(
      () => insertRun("run_finished_bad", { source_revision_id: revision2, finished_at_utc: "2026-10-13T06:30:00" }),
      /CHECK constraint failed/,
    );
  });

  it("confirmed_at_utc 只在用户确认时存在，形态同样受约（授权时刻与状态分离）", () => {
    db.prepare(
      `insert into concept_alias (id, alias, concept_id, domain, mode, source, confirmed_at_utc)
       values ('ca_time_1', '时间探针', 'concept_fixture_emotion', 'emotion', 'suggest', 'user_confirmed', NULL)`,
    ).run();
    expectRejected(
      () =>
        db
          .prepare("update concept_alias set confirmed_at_utc = '2026-10-13T06:30:00' where id = 'ca_time_1'")
          .run(),
      /CHECK constraint failed/,
    );
    expectAccepted(() =>
      db
        .prepare("update concept_alias set confirmed_at_utc = ? where id = 'ca_time_1'")
        .run(NOW),
    );
    db.prepare("delete from concept_alias where id = 'ca_time_1'").run();
  });
});
