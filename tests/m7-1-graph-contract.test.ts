import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { HEAD_SCHEMA_VERSION, countRows, makeSandbox, openSandboxDb, type Sandbox } from "./helpers/sandbox.ts";
import { listMigrationFiles, MIGRATIONS_DIR, migrate } from "../src/server/db/migrator.ts";
import { RecordService } from "../src/server/records/service.ts";
import {
  GRAPH_EDGE_CREATORS,
  GraphEdgeEndpointError,
  GraphEdgeInputError,
  GraphStore,
} from "../src/server/graph/store.ts";
import { graphEdgeRelationTypes } from "../src/shared/contracts/enums.ts";
import { loadEnums } from "../src/shared/contracts/load.ts";
import { hasPrefix } from "../src/shared/contracts/ids.ts";
import type { Database } from "../src/server/db/adapter.ts";

/**
 * M7-1 关系契约与存储层（`graph_edge` 放行 AI 边与六类稳定社会关系）的验收。
 *
 * 契约正文：`docs/dev-specs/2026-10-27-M7关系分析阶段任务拆分与执行准则.md`
 * §二 裁决 R1/R2/R3/R5/R6、§三.1 关系类型表、§三.2 迁移 0011、§四 M7-1 断言清单。
 * 迁移：`src/server/db/migrations/0011_graph_edge_ai_relations.sql`
 * 服务层：`src/server/graph/store.ts`（**无 HTTP 路由、无 UI**——§五-4）。
 *
 * 分工边界，避免与既有测试重复或留缝：
 *  - `m2-schema-contract` T-16/T-26 钉「库自己守不守得住」；0011 之后它的 relation_type 与方向豁免
 *    清单改从**活库 schema** 取，本文件「活库形状」一节用同一判据再对账一次，两处不会各说各话。
 *  - 本文件钉 M7-1 新增的那部分：**六类新关系真能落库**、**AI 边真能落库**、**store 层那三条库里
 *    守不住的校验**（端点 active、无向归一、K-18 `ai_may_never_create`），以及**迁移在空库与
 *    含旧 3 类边数据的库上都跑通且幂等**。
 *  - 抽取（M7-2）与收敛/回填校验（M7-3）尚未实现：本文件不碰 `contract.ts` / prompt v2 / `commitDerived`。
 *
 * 一律用真库真 migrator（`migrate`），不手搓 SQL 近似——0011 是整表重建，
 * 「约束与触发器有没有在重建中丢掉」只有把表建起来再问 `sqlite_master` 才算数。
 */

const NOW = "2026-10-27T09:00:00.000Z";
const HEX64 = "0123456789abcdef".repeat(4);
const OTHER64 = "fedcba9876543210".repeat(4);

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

/** 六类新关系（§三.1 表）：逐类走一遍，不抽样。 */
const NEW_RELATION_TYPES = [
  "colleague_of",
  "friend_of",
  "family_of",
  "partner_of",
  "classmate_of",
  "reports_to",
] as const;

/** 字典序两端：`entity_m7_aaa < entity_m7_bbb`，无向归一的判据依赖这个顺序。 */
const ENT_A = "entity_m7_aaa";
const ENT_B = "entity_m7_bbb";
const ENT_PROVISIONAL = "entity_m7_prov";
const ENT_ARCHIVED = "entity_m7_arch";

/** 每类新关系用哪种来源落库：三种合法来源在这一节里全都真的写过（R1）。 */
const CREATOR_BY_RELATION: Record<(typeof NEW_RELATION_TYPES)[number], string> = {
  colleague_of: "ai_generated",
  friend_of: "user_confirmed_suggestion",
  family_of: "user",
  partner_of: "ai_generated",
  classmate_of: "user_confirmed_suggestion",
  reports_to: "ai_generated",
};

const enums = loadEnums();

let sandbox: Sandbox;
let db: Database;
let store: GraphStore;
let revisionId: string;

beforeEach(() => {
  sandbox = makeSandbox("tb-m7-1-");
  db = openSandboxDb(sandbox.layout);
  migrate(db);
  const records = new RecordService(db, { timezoneId: "Asia/Shanghai", now: () => new Date(NOW) });
  revisionId = records.createRecord("和老周吵了一架，后来他帮我改了简历。", "cloud_redacted").revision.id;
  insertEntity(db, ENT_A, "active", "老周");
  insertEntity(db, ENT_B, "active", "小林");
  insertEntity(db, ENT_PROVISIONAL, "provisional", "某个陌生人");
  insertEntity(db, ENT_ARCHIVED, "archived", "已经不管了的人");
  insertRun(db, "run_m7_1", revisionId);
  store = new GraphStore(db, { now: () => new Date(NOW) });
});

afterEach(() => {
  db.close();
  sandbox.cleanup();
});

// ── 夹具 ────────────────────────────────────────────────────────────

function insertEntity(target: Database, id: string, lifecycle: string, name: string): void {
  target
    .prepare(
      `insert into entity (id, entity_type, canonical_name, display_name, lifecycle_status, privacy_level, origin_type, created_at_utc)
       values (?, 'person', ?, ?, ?, 'normal', 'user_created', ?)`,
    )
    .run(id, name, name, lifecycle, NOW);
}

function insertRun(target: Database, id: string, revision: string, fingerprint = HEX64): void {
  target
    .prepare(
      `insert into parse_run (id, source_revision_id, pipeline_manifest, pipeline_fingerprint, idempotency_key,
                              execution_status, result_state, error_kind, started_at_utc, finished_at_utc)
       values (?, ?, ?, ?, ?, 'succeeded', 'candidate', null, ?, ?)`,
    )
    .run(id, revision, MANIFEST, fingerprint, `k-${id}`, NOW, NOW);
}

/** 手工创建的 episode：库里那一支 CHECK 要求它同时不带 revision 与 run（§3.2 B4 的另一半）。 */
function insertEpisode(target: Database, id: string): void {
  target
    .prepare(
      `insert into episode (id, source_record_revision_id, parse_run_id, origin_type, lifecycle_status, summary,
                            evidence_text, evidence_start, evidence_end, event_time_precision, event_time_certainty, created_at_utc)
       values (?, NULL, NULL, 'user_created', 'active', ?, '', NULL, NULL, 'unknown', 'unknown', ?)`,
    )
    .run(id, "一次长谈", NOW);
}

function insertConcept(target: Database, id: string, name: string): void {
  target
    .prepare(
      `insert into concept (id, concept_type, canonical_name, origin_type, lifecycle_status, created_at_utc)
       values (?, 'emotion', ?, 'user_created', 'active', ?)`,
    )
    .run(id, name, NOW);
}

interface RawEdge {
  readonly id: string;
  readonly relation_type: string;
  readonly src_kind: string;
  readonly dst_kind: string;
  readonly src_id: string;
  readonly dst_id: string;
  readonly created_by?: string;
  readonly lifecycle_status?: string;
  readonly origin_parse_run_id?: string | null;
  readonly evidence_reason?: string | null;
}

/** 0011 之后的 13 列具名写入：绕过 store，直接问库自己守不守得住。 */
function rawInsertEdge(target: Database, edge: RawEdge): void {
  target
    .prepare(
      `insert into graph_edge (id, relation_type, src_kind, dst_kind, src_id, dst_id, lifecycle_status, created_by,
                               origin_suggestion_id, origin_parse_run_id, evidence_reason, created_at_utc, updated_at_utc)
       values (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
    )
    .run(
      edge.id,
      edge.relation_type,
      edge.src_kind,
      edge.dst_kind,
      edge.src_id,
      edge.dst_id,
      edge.lifecycle_status ?? "active",
      edge.created_by ?? "user",
      edge.origin_parse_run_id ?? null,
      edge.evidence_reason ?? null,
      NOW,
      NOW,
    );
}

/** 0003/0010 时代的 12 列形状：给「含旧数据的库」造升级现场。 */
function rawInsertLegacyEdge(target: Database, edge: RawEdge): void {
  target
    .prepare(
      `insert into graph_edge (id, relation_type, src_kind, dst_kind, src_id, dst_id, lifecycle_status, created_by,
                               origin_suggestion_id, evidence_reason, created_at_utc, updated_at_utc)
       values (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
    )
    .run(
      edge.id,
      edge.relation_type,
      edge.src_kind,
      edge.dst_kind,
      edge.src_id,
      edge.dst_id,
      edge.lifecycle_status ?? "active",
      edge.created_by ?? "user",
      edge.evidence_reason ?? null,
      NOW,
      NOW,
    );
}

function edgeRowById(target: Database, id: string): Record<string, unknown> | undefined {
  return target.prepare("select * from graph_edge where id = ?").get(id) as Record<string, unknown> | undefined;
}

function allEdges(target: Database): Array<Record<string, unknown>> {
  return target.prepare("select * from graph_edge order by id").all() as Array<Record<string, unknown>>;
}

/** 探完即回滚的拒绝断言：夹具现场不被污染（手法与 m6-0d-raw-grant / m2-schema-contract 一致）。 */
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
  if (thrown === undefined) throw new Error(`期望被 ${pattern} 拒绝，但写入成功了`);
  expect(thrown.message).toMatch(pattern);
}

/** 成功但不留行：库面「写得进」的证明都走这一条，免得污染后续断言的行数。 */
function expectAccepted(statement: () => void): void {
  db.exec("begin immediate");
  try {
    statement();
  } finally {
    db.exec("rollback");
  }
}

/**
 * 活库 schema：`select sql from sqlite_master`。SQLite 原样保留建表语句里的行注释，
 * 而注释里出现的字面量不参与对账（0011 的头注正好在讲这些字面量），所以先按整行注释剥掉。
 */
function liveTableSql(target: Database, table: string): string {
  const row = target
    .prepare("select sql from sqlite_master where type = 'table' and name = ?")
    .get(table) as { sql: string };
  return row.sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
}

/** 活库某列定义处的 `column IN ( … )` 字面量清单（含顺序）。 */
function liveInList(target: Database, table: string, column: string): string[] {
  const match = new RegExp(`${column} TEXT[^C]*CHECK \\(\\s*${column} IN \\(([\\s\\S]*?)\\)`).exec(
    liveTableSql(target, table),
  );
  if (match === null) throw new Error(`活库 schema 里没有 ${table}.${column} 的定义处 IN (...) CHECK`);
  return [...match[1]!.matchAll(/'([^']*)'/g)].map((m) => m[1]!);
}

/** 活库里被豁免字典序归一的关系类型清单（`CHECK (relation_type IN (…) OR src_id <= dst_id)`）。 */
function liveDirectedExemptions(target: Database): string[] {
  const match = /CHECK \(relation_type IN \(([^)]*)\) OR src_id <= dst_id\)/.exec(liveTableSql(target, "graph_edge"));
  if (match === null) throw new Error("活库 schema 里找不到无向归一 CHECK 的豁免清单");
  return [...match[1]!.matchAll(/'([^']*)'/g)].map((m) => m[1]!);
}

function liveTriggerNames(target: Database): string[] {
  return (
    target
      .prepare("select name from sqlite_master where type = 'trigger' and name glob 'graph_edge_*' order by name")
      .all() as Array<{ name: string }>
  ).map((r) => r.name);
}

/** 活库 `graph_edge` 的索引名清单（现查 `pragma_index_list`，含 sqlite 自建的 autoindex）。 */
function liveIndexNames(target: Database): string[] {
  return (
    target.prepare(`select name from pragma_index_list('graph_edge')`).all() as Array<{ name: string }>
  ).map((r) => r.name);
}

function indexColumns(target: Database, indexName: string): string[] {
  // 索引名来自 sqlite_master 本身，不是外部输入；pragma 的表值函数不接受绑定参数，只能内插。
  return (
    target.prepare(`select name from pragma_index_info('${indexName}')`).all() as Array<{ name: string }>
  ).map((r) => r.name);
}

/** 索引面清单：`名字[来源]=覆盖列`，用于「升级后的库与全新安装的库同一」这类比对。 */
function edgeIndexReport(target: Database): string[] {
  return (
    target
      .prepare("select name, origin from pragma_index_list('graph_edge')")
      .all() as Array<{ name: string; origin: string }>
  )
    .map((row) => `${row.name}[${row.origin}]=${indexColumns(target, row.name).join(",")}`)
    .sort();
}

// ── A. 活库形状与迁移落地面（§四：迁移在空库与含旧数据的库上都跑通且幂等）──

describe("A. 迁移 0011 落地：活库 schema 就是那份契约", () => {
  it("空库一次升到 HEAD：13 列就位，relation_type 9 值、created_by 3 值与契约逐字同序", () => {
    expect((db.prepare("pragma table_info(graph_edge)").all() as Array<{ name: string }>).map((c) => c.name)).toEqual([
      "id",
      "relation_type",
      "src_kind",
      "dst_kind",
      "src_id",
      "dst_id",
      "lifecycle_status",
      "created_by",
      "origin_suggestion_id",
      "origin_parse_run_id",
      "evidence_reason",
      "created_at_utc",
      "updated_at_utc",
    ]);
    // §四 第一条：`graphEdgeRelationTypes(enums)` 产出 9 值，且迁移 CHECK 与之逐字同序。
    const declared = graphEdgeRelationTypes(enums);
    expect(declared).toHaveLength(9);
    expect(declared).toEqual(["possibly_related", "same_as", "merged_into", ...NEW_RELATION_TYPES]);
    expect(liveInList(db, "graph_edge", "relation_type")).toEqual(declared);
    expect(liveInList(db, "graph_edge", "created_by")).toEqual([...GRAPH_EDGE_CREATORS]);
    expect([...GRAPH_EDGE_CREATORS]).toEqual(["user", "user_confirmed_suggestion", "ai_generated"]);
    const edgeLifecycleStates = enums.lifecycle_states["GraphEdge.lifecycle_status"]?.values;
    expect(edgeLifecycleStates).toBeDefined();
    expect(liveInList(db, "graph_edge", "lifecycle_status")).toEqual(edgeLifecycleStates);
    expect(liveInList(db, "graph_edge", "src_kind")).toEqual(["episode", "entity", "concept"]);
    // 方向豁免面（R6）：库里被豁免的两个值，恰是 enums 里 directed 为真的那两个。
    expect(liveDirectedExemptions(db).sort()).toEqual(["merged_into", "reports_to"]);
    // 重建没把索引与触发器落下（三条 `_ad` 是隐私清理路径，缺一条就是库里破一个口径）。
    expect(edgeIndexReport(db)).toEqual([
      "ix_graph_edge_dst[c]=dst_kind,dst_id",
      "ix_graph_edge_origin_run[c]=origin_parse_run_id",
      "ix_graph_edge_src[c]=src_kind,src_id",
      // UNIQUE(relation_type, src_id, dst_id) —— R5 的物理基础，0011 重建后必须还在。
      "sqlite_autoindex_graph_edge_2[u]=relation_type,src_id,dst_id",
      // 主键 id。
      "sqlite_autoindex_graph_edge_1[pk]=id",
    ].sort());
    expect(liveTriggerNames(db)).toEqual([
      "graph_edge_concept_ad",
      "graph_edge_endpoints_bi",
      "graph_edge_endpoints_bu",
      "graph_edge_entity_ad",
      "graph_edge_episode_ad",
    ]);
  });

  it("含旧 3 类边数据的库从 0010 升到 HEAD：存量行逐列不变，只多一个 NULL 的新列", () => {
    const staging = makeSandbox("tb-m7-1-legacy-");
    const dir = mkdtempSync(join(tmpdir(), "tb-m7-1-mig-"));
    const legacy = openSandboxDb(staging.layout);
    try {
      const pre0011 = [
        "0001_bootstrap",
        "0002_records_and_search",
        "0003_derived_layer",
        "0004_correction_layer",
        "0005_override_value_gate",
        "0006_entity_types_v2",
        "0007_schema_backfill_m2_debt",
        "0008_three_axis_contract",
        "0009_send_content_mode",
        "0010_privacy_job",
      ];
      for (const base of pre0011) copyFileSync(join(MIGRATIONS_DIR, `${base}.sql`), join(dir, `${base}.sql`));
      expect(migrate(legacy, dir).schemaVersion).toBe(10);
      expect(
        (legacy.prepare("pragma table_info(graph_edge)").all() as Array<{ name: string }>).map((c) => c.name),
      ).not.toContain("origin_parse_run_id");

      const legacyRecords = new RecordService(legacy, { timezoneId: "Asia/Shanghai", now: () => new Date(NOW) });
      const legacyRevision = legacyRecords.createRecord("旧库里的记录", "cloud_redacted").revision.id;
      insertEpisode(legacy, "ep_m7_a");
      insertEpisode(legacy, "ep_m7_b");
      insertConcept(legacy, "concept_m7_emotion", "焦虑");
      insertConcept(legacy, "concept_m7_topic", "工作");
      insertEntity(legacy, ENT_A, "active", "老周");
      insertEntity(legacy, ENT_B, "active", "小林");
      // 旧 3 类边各一行，外加各端点：这就是 0011 必须原样搬走的数据。
      rawInsertLegacyEdge(legacy, {
        id: "edge_m7_legacy_related",
        relation_type: "possibly_related",
        src_kind: "episode",
        dst_kind: "episode",
        src_id: "ep_m7_a",
        dst_id: "ep_m7_b",
        created_by: "user_confirmed_suggestion",
        evidence_reason: "suggestion:sug_m7_legacy",
      });
      rawInsertLegacyEdge(legacy, {
        id: "edge_m7_legacy_same_as",
        relation_type: "same_as",
        src_kind: "entity",
        dst_kind: "entity",
        src_id: ENT_A,
        dst_id: ENT_B,
        created_by: "user",
      });
      rawInsertLegacyEdge(legacy, {
        id: "edge_m7_legacy_merged",
        relation_type: "merged_into",
        src_kind: "concept",
        dst_kind: "concept",
        src_id: "concept_m7_emotion",
        dst_id: "concept_m7_topic",
        created_by: "user",
      });
      const before = allEdges(legacy);
      expect(before).toHaveLength(3);

      const advanced = migrate(legacy, MIGRATIONS_DIR);
      expect(advanced.schemaVersion).toBe(HEAD_SCHEMA_VERSION);
      // 判据是 HEAD，不是写死的文件名清单（与 m3-db-2 同一惯例）：停在 0010 的现场一次追上 HEAD，
      // 应当应用「0010 之上、HEAD 之下」的每一份迁移，一份不漏、不多、顺序不乱。现从 migrator
      // 自己的目录取，于是每落一份新迁移这条都仍然说同一件事，而不是等着被人「顺手补一个名字」。
      expect(advanced.applied.map((f) => f.name)).toEqual(
        listMigrationFiles()
          .filter((f) => f.version > 10)
          .map((f) => f.name),
      );

      const after = allEdges(legacy);
      expect(after).toHaveLength(3);
      // 除新列外逐列相等：搬运不得改写存量行的任何一个字节（禁区「不删除、不改写既有边」）。
      const stripNewColumn = (rows: Array<Record<string, unknown>>) =>
        rows.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => k !== "origin_parse_run_id")));
      expect(stripNewColumn(after)).toEqual(before);
      // 新列一律 NULL = 「本轮之前写入，来源未知」，不猜成「用户手工创建」。
      expect(after.map((r) => r["origin_parse_run_id"])).toEqual([null, null, null]);

      // 升级后的库与全新安装的库形状同一（活库建表语句逐字相等，比「列集合相等」强）。
      expect(liveTableSql(legacy, "graph_edge")).toBe(liveTableSql(db, "graph_edge"));
      expect(liveInList(legacy, "graph_edge", "relation_type")).toEqual(graphEdgeRelationTypes(enums));
      expect(liveDirectedExemptions(legacy).sort()).toEqual(["merged_into", "reports_to"]);
      expect(liveTriggerNames(legacy)).toEqual(liveTriggerNames(db));
      expect(liveIndexNames(legacy).sort()).toEqual(liveIndexNames(db).sort());
      // 上一行说「两个库一样」，这一行说「一样的是哪三份」：整表重建不能把两条既有索引或
      // 0011 新增的来源指针索引落在原地。
      expect(liveIndexNames(legacy)).toEqual(
        expect.arrayContaining(["ix_graph_edge_src", "ix_graph_edge_dst", "ix_graph_edge_origin_run"]),
      );
      // 重建没有把 FK 面弄丢：整库 pragma_foreign_key_check 干净。
      expect(legacy.prepare("select * from pragma_foreign_key_check").all()).toEqual([]);

      // 存量边在新读面上仍然可达（端点触发器与索引都在位的行为证据）。
      const legacyStore = new GraphStore(legacy, { now: () => new Date(NOW) });
      expect(legacyStore.edgesOfEntity(ENT_A).map((r) => r.relation_type)).toEqual(["same_as"]);
      expect(legacyStore.edgesOfEntity(ENT_B).map((r) => r.relation_type)).toEqual(["same_as"]);
      expect(legacyStore.edgesOfRun("run_m7_1")).toEqual([]);

      // 幂等：升级后再跑一次 migrator，零应用、零改写。
      expect(migrate(legacy, MIGRATIONS_DIR).applied).toEqual([]);
      expect(allEdges(legacy)).toEqual(after);
    } finally {
      legacy.close();
      rmSync(dir, { recursive: true, force: true });
      staging.cleanup();
    }
  });

  it("幂等可回放：HEAD 上重复跑 migrator 不动 schema，也不动数据", () => {
    rawInsertEdge(db, {
      id: "edge_m7_idem",
      relation_type: "friend_of",
      src_kind: "entity",
      dst_kind: "entity",
      src_id: ENT_A,
      dst_id: ENT_B,
      created_by: "ai_generated",
      origin_parse_run_id: "run_m7_1",
    });
    const before = allEdges(db);
    for (const _round of [1, 2]) {
      const result = migrate(db);
      expect(result.applied).toEqual([]);
      expect(result.schemaVersion).toBe(HEAD_SCHEMA_VERSION);
    }
    expect(allEdges(db)).toEqual(before);
    expect(liveTableSql(db, "graph_edge")).toContain("'reports_to'");
  });
});

// ── B. 六类新关系在库里成立，取值面仍然封闭 ───────────────────────────

describe("B. 六类稳定社会关系：库里立得住，越界的立不住", () => {
  it("六类各插入一行成功，三种来源（ai_generated / user_confirmed_suggestion / user）都真落得下去", () => {
    for (const relationType of NEW_RELATION_TYPES) {
      rawInsertEdge(db, {
        id: `edge_m7_b_${relationType}`,
        relation_type: relationType,
        src_kind: "entity",
        dst_kind: "entity",
        src_id: ENT_A,
        dst_id: ENT_B,
        created_by: CREATOR_BY_RELATION[relationType],
        origin_parse_run_id: "run_m7_1",
        evidence_reason: `parse_run:run_m7_1 rev:${revisionId} span:0-4`,
      });
    }
    expect(countRows(db, "graph_edge")).toBe(6);
    const rows = allEdges(db);
    expect(rows.map((r) => r["relation_type"]).sort()).toEqual([...NEW_RELATION_TYPES].sort());
    for (const row of rows) {
      expect(row["created_by"]).toBe(CREATOR_BY_RELATION[row["relation_type"] as (typeof NEW_RELATION_TYPES)[number]]);
      expect(row["src_kind"]).toBe("entity");
      expect(row["dst_kind"]).toBe("entity");
      expect(row["lifecycle_status"]).toBe("active");
      expect(row["origin_parse_run_id"]).toBe("run_m7_1");
    }
    expect(new Set(rows.map((r) => r["created_by"]))).toEqual(new Set([...GRAPH_EDGE_CREATORS]));
  });

  it("清单外的 relation_type 一律被 CHECK 拒：新造的类型、投影类、建议类、空串、大小写变体都不给落点", () => {
    const rejected = [
      "neighbor_of", // 准则 §五-6：类型表不得顺手扩张
      "possibly_same_as", // 载体是 Suggestion，不入图
      "triggered_by", // 载体是 TriggerAssertion，不入图
      "has_emotion", // Mention 投影
      "on_topic",
      "",
      "SAME_AS",
      "same_as ",
    ];
    rejected.forEach((bad, index) => {
      expectRejected(
        () =>
          rawInsertEdge(db, {
            id: `edge_m7_bad_${index}`,
            relation_type: bad,
            src_kind: "entity",
            dst_kind: "entity",
            src_id: ENT_A,
            dst_id: ENT_B,
          }),
        /CHECK constraint failed/,
      );
    });
    expect(countRows(db, "graph_edge")).toBe(0);
  });

  it("新类型的端点种类绑定：只认 entity/entity，concept/concept 与 episode/episode 都被拒", () => {
    insertConcept(db, "concept_m7_emotion", "焦虑");
    insertConcept(db, "concept_m7_topic", "工作");
    insertEpisode(db, "ep_m7_a");
    insertEpisode(db, "ep_m7_b");
    for (const relationType of NEW_RELATION_TYPES) {
      expectRejected(
        () =>
          rawInsertEdge(db, {
            id: `edge_m7_kind_c_${relationType}`,
            relation_type: relationType,
            src_kind: "concept",
            dst_kind: "concept",
            src_id: "concept_m7_emotion",
            dst_id: "concept_m7_topic",
          }),
        /CHECK constraint failed/,
      );
      expectRejected(
        () =>
          rawInsertEdge(db, {
            id: `edge_m7_kind_e_${relationType}`,
            relation_type: relationType,
            src_kind: "episode",
            dst_kind: "episode",
            src_id: "ep_m7_a",
            dst_id: "ep_m7_b",
          }),
        /CHECK constraint failed/,
      );
    }
    expect(countRows(db, "graph_edge")).toBe(0);
  });

  it("无向归一的库面：新类型反着写被 CHECK 拒；reports_to 两个方向都写得进", () => {
    for (const relationType of NEW_RELATION_TYPES.filter((t) => t !== "reports_to")) {
      expectAccepted(() =>
        rawInsertEdge(db, {
          id: `edge_m7_fwd_${relationType}`,
          relation_type: relationType,
          src_kind: "entity",
          dst_kind: "entity",
          src_id: ENT_A,
          dst_id: ENT_B,
          created_by: "ai_generated",
        }),
      );
      expectRejected(
        () =>
          rawInsertEdge(db, {
            id: `edge_m7_rev_${relationType}`,
            relation_type: relationType,
            src_kind: "entity",
            dst_kind: "entity",
            src_id: ENT_B,
            dst_id: ENT_A,
            created_by: "ai_generated",
          }),
        /CHECK constraint failed/,
      );
    }
    // 有向的那一类：方向本身就是信息（下属 → 上级），两个方向两行都容得下。
    expectAccepted(() =>
      rawInsertEdge(db, {
        id: "edge_m7_rt_a2b",
        relation_type: "reports_to",
        src_kind: "entity",
        dst_kind: "entity",
        src_id: ENT_A,
        dst_id: ENT_B,
        created_by: "ai_generated",
      }),
    );
    expectAccepted(() =>
      rawInsertEdge(db, {
        id: "edge_m7_rt_b2a",
        relation_type: "reports_to",
        src_kind: "entity",
        dst_kind: "entity",
        src_id: ENT_B,
        dst_id: ENT_A,
        created_by: "ai_generated",
      }),
    );
    expect(countRows(db, "graph_edge")).toBe(0);
  });
});

// ── C. created_by 取值面（R1）─────────────────────────────────────────

describe("C. created_by 放行 ai_generated，但只有那三值", () => {
  it("三值都写得进；system_seed、空串、大小写与尾空格变体仍被 CHECK 拒", () => {
    GRAPH_EDGE_CREATORS.forEach((creator, index) => {
      expectAccepted(() =>
        rawInsertEdge(db, {
          id: `edge_m7_c_${index}`,
          relation_type: "friend_of",
          src_kind: "entity",
          dst_kind: "entity",
          src_id: ENT_A,
          dst_id: ENT_B,
          created_by: creator,
        }),
      );
    });
    const badCreators = [
      "system_seed",
      "",
      "AI_GENERATED",
      "Ai_generated",
      "ai_generated ",
      " ai_generated",
      "user_confirmed",
      "ai",
    ];
    badCreators.forEach((bad, index) => {
      expectRejected(
        () =>
          rawInsertEdge(db, {
            id: `edge_m7_c_bad_${index}`,
            relation_type: "friend_of",
            src_kind: "entity",
            dst_kind: "entity",
            src_id: ENT_A,
            dst_id: ENT_B,
            created_by: bad,
          }),
        /CHECK constraint failed/,
      );
    });
    expect(countRows(db, "graph_edge")).toBe(0);
  });

  it("store 导出的常量与活库 CHECK 取值面同源（store.ts 里那份「静态对账由本文件钉住」的承诺）", () => {
    expect(liveInList(db, "graph_edge", "created_by")).toEqual([...GRAPH_EDGE_CREATORS]);
  });
});

// ── D. store 守库里守不住的那一层（R3：端点生命周期）─────────────────

describe("D. 端点必须是在册 active 实体：R3 只有存储层能守", () => {
  it("provisional 端点：抛 GraphEdgeEndpointError(reason=not_active)，实体没被转正，库里一条边都没写", () => {
    let thrown: unknown;
    try {
      store.insertEdgeIfAbsent({
        relationType: "colleague_of",
        srcEntityId: ENT_A,
        dstEntityId: ENT_PROVISIONAL,
        createdBy: "ai_generated",
      });
    } catch (cause) {
      thrown = cause;
    }
    expect(thrown).toBeInstanceOf(GraphEdgeEndpointError);
    expect((thrown as GraphEdgeEndpointError).reason).toBe("not_active");
    expect((thrown as GraphEdgeEndpointError).entityId).toBe(ENT_PROVISIONAL);
    // 「绝不顺手把实体转正」：生命周期一个字没动。
    expect(db.prepare("select lifecycle_status from entity where id = ?").get(ENT_PROVISIONAL)).toEqual({
      lifecycle_status: "provisional",
    });
    expect(countRows(db, "graph_edge")).toBe(0);
    // 存在性触发器管不到生命周期：库里物理上写得进这一行，所以只有 store 这一层能守（守门不冗余的证明）。
    expectAccepted(() =>
      rawInsertEdge(db, {
        id: "edge_m7_prov_slip",
        relation_type: "colleague_of",
        src_kind: "entity",
        dst_kind: "entity",
        src_id: ENT_A,
        dst_id: ENT_PROVISIONAL,
        created_by: "ai_generated",
      }),
    );
  });

  it("archived 端点同样按 not_active 拒：active 是唯一放行态，两个方向都守", () => {
    const pairs: Array<[string, string]> = [
      [ENT_A, ENT_ARCHIVED],
      [ENT_ARCHIVED, ENT_A],
    ];
    for (const [src, dst] of pairs) {
      let thrown: unknown;
      try {
        store.insertEdgeIfAbsent({ relationType: "friend_of", srcEntityId: src, dstEntityId: dst, createdBy: "ai_generated" });
      } catch (cause) {
        thrown = cause;
      }
      expect(thrown).toBeInstanceOf(GraphEdgeEndpointError);
      expect((thrown as GraphEdgeEndpointError).reason).toBe("not_active");
      expect((thrown as GraphEdgeEndpointError).entityId).toBe(ENT_ARCHIVED);
    }
    expect(countRows(db, "graph_edge")).toBe(0);
  });

  it("端点实体不存在：reason=missing，与 not_active 分档（M7-2 要按 §3.5 分开计数）", () => {
    let thrown: unknown;
    try {
      store.insertEdgeIfAbsent({
        relationType: "family_of",
        srcEntityId: ENT_A,
        dstEntityId: "entity_m7_ghost",
        createdBy: "ai_generated",
      });
    } catch (cause) {
      thrown = cause;
    }
    expect(thrown).toBeInstanceOf(GraphEdgeEndpointError);
    expect((thrown as GraphEdgeEndpointError).reason).toBe("missing");
    expect((thrown as GraphEdgeEndpointError).entityId).toBe("entity_m7_ghost");
    expect(countRows(db, "graph_edge")).toBe(0);
  });

  it("入参面：未知类型、非实体边、自己连自己、空 id、非法 created_by 一律 GraphEdgeInputError", () => {
    const badCalls: Array<() => unknown> = [
      () => store.insertEdgeIfAbsent({ relationType: "neighbor_of", srcEntityId: ENT_A, dstEntityId: ENT_B, createdBy: "user" }),
      () => store.insertEdgeIfAbsent({ relationType: "", srcEntityId: ENT_A, dstEntityId: ENT_B, createdBy: "user" }),
      // possibly_related 的端点是 episode×episode，本层不写（§三.5 的写入面限于实体↔实体）。
      () => store.insertEdgeIfAbsent({ relationType: "possibly_related", srcEntityId: ENT_A, dstEntityId: ENT_B, createdBy: "user" }),
      () => store.insertEdgeIfAbsent({ relationType: "merged_into", srcEntityId: ENT_A, dstEntityId: ENT_B, createdBy: "user" }),
      () => store.insertEdgeIfAbsent({ relationType: "triggered_by", srcEntityId: ENT_A, dstEntityId: ENT_B, createdBy: "user" }),
      () => store.insertEdgeIfAbsent({ relationType: "friend_of", srcEntityId: ENT_A, dstEntityId: ENT_A, createdBy: "user" }),
      () => store.insertEdgeIfAbsent({ relationType: "friend_of", srcEntityId: "", dstEntityId: ENT_B, createdBy: "user" }),
      () => store.insertEdgeIfAbsent({ relationType: "friend_of", srcEntityId: ENT_A, dstEntityId: ENT_B, createdBy: "system_seed" as never }),
    ];
    for (const call of badCalls) expect(call).toThrow(GraphEdgeInputError);
    expect(countRows(db, "graph_edge")).toBe(0);
  });
});

// ── E. R5：重复插入与重跑 ────────────────────────────────────────────

describe("E. 同三元组已有边 ⇒ 不新建、不改写（R5）", () => {
  it("UNIQUE 三元组是 R5 的物理基础：库面同三元组第二行直接被拒", () => {
    rawInsertEdge(db, {
      id: "edge_m7_u1",
      relation_type: "colleague_of",
      src_kind: "entity",
      dst_kind: "entity",
      src_id: ENT_A,
      dst_id: ENT_B,
      created_by: "ai_generated",
    });
    expectRejected(
      () =>
        rawInsertEdge(db, {
          id: "edge_m7_u2",
          relation_type: "colleague_of",
          src_kind: "entity",
          dst_kind: "entity",
          src_id: ENT_A,
          dst_id: ENT_B,
          created_by: "user",
        }),
      /UNIQUE constraint failed: graph_edge\.relation_type, graph_edge\.src_id, graph_edge\.dst_id/,
    );
    expect(countRows(db, "graph_edge")).toBe(1);
  });

  it("第二次调用返回既有行，created=false，整行逐列与第一次完全一致", () => {
    const first = store.insertEdgeIfAbsent({
      relationType: "colleague_of",
      srcEntityId: ENT_A,
      dstEntityId: ENT_B,
      createdBy: "ai_generated",
      originParseRunId: "run_m7_1",
      evidenceReason: `parse_run:run_m7_1 rev:${revisionId} span:10-24`,
    });
    expect(first.created).toBe(true);
    const snapshot = edgeRowById(db, first.row.id);
    expect(snapshot).toBeDefined();

    // 第二次换来源、换证据、换时刻：命中既有行就一个字都不改。
    const again = store.insertEdgeIfAbsent({
      relationType: "colleague_of",
      srcEntityId: ENT_B,
      dstEntityId: ENT_A,
      createdBy: "user",
      originParseRunId: null,
      evidenceReason: "完全不同的证据",
      now: new Date("2027-01-01T00:00:00.000Z"),
    });
    expect(again.created).toBe(false);
    expect(again.row.id).toBe(first.row.id);
    expect(edgeRowById(db, first.row.id)).toEqual(snapshot);
    expect(countRows(db, "graph_edge")).toBe(1);
  });

  it("用户边尤其：AI 重跑不得改写用户已确认的行（created_by 与 lifecycle_status 都不动）", () => {
    const userEdge = store.insertEdgeIfAbsent({
      relationType: "friend_of",
      srcEntityId: ENT_A,
      dstEntityId: ENT_B,
      createdBy: "user",
      evidenceReason: "用户手写",
    });
    expect(userEdge.row.created_by).toBe("user");
    const before = edgeRowById(db, userEdge.row.id);

    const hit = store.insertEdgeIfAbsent({
      relationType: "friend_of",
      srcEntityId: ENT_A,
      dstEntityId: ENT_B,
      createdBy: "ai_generated",
      originParseRunId: "run_m7_1",
      evidenceReason: "parse_run:run_m7_1",
    });
    expect(hit.created).toBe(false);
    expect(edgeRowById(db, userEdge.row.id)).toEqual(before);
  });

  it("重跑不删除任何边：两次重复调用之间行集合只增不减", () => {
    store.insertEdgeIfAbsent({ relationType: "family_of", srcEntityId: ENT_A, dstEntityId: ENT_B, createdBy: "ai_generated" });
    const before = allEdges(db);
    store.insertEdgeIfAbsent({ relationType: "family_of", srcEntityId: ENT_B, dstEntityId: ENT_A, createdBy: "ai_generated" });
    expect(allEdges(db)).toEqual(before);
    store.insertEdgeIfAbsent({ relationType: "classmate_of", srcEntityId: ENT_A, dstEntityId: ENT_B, createdBy: "ai_generated" });
    expect(allEdges(db)).toHaveLength(before.length + 1);
  });
});

// ── F. R6：方向归一 ──────────────────────────────────────────────────

describe("F. 无向归一在写入之前发生（store 层），有向类型保留方向", () => {
  it("无向类型正反两次插入落同一行，且库里那一行 src_id <= dst_id", () => {
    const forward = store.insertEdgeIfAbsent({
      relationType: "partner_of",
      srcEntityId: ENT_A,
      dstEntityId: ENT_B,
      createdBy: "ai_generated",
    });
    // 反着给：库里的 CHECK 会拒这一方向，归一必须发生在写入之前。
    const reversed = store.insertEdgeIfAbsent({
      relationType: "partner_of",
      srcEntityId: ENT_B,
      dstEntityId: ENT_A,
      createdBy: "ai_generated",
    });
    expect(forward.created).toBe(true);
    expect(reversed.created).toBe(false);
    expect(reversed.row.id).toBe(forward.row.id);
    expect([forward.row.src_id, forward.row.dst_id]).toEqual([ENT_A, ENT_B]);
    expect(forward.row.src_id <= forward.row.dst_id).toBe(true);
    expect(countRows(db, "graph_edge")).toBe(1);
  });

  it("reports_to 正反两向是两行，方向逐字保留（src=下属，dst=上级）", () => {
    const downToUp = store.insertEdgeIfAbsent({
      relationType: "reports_to",
      srcEntityId: ENT_A,
      dstEntityId: ENT_B,
      createdBy: "ai_generated",
    });
    const upToDown = store.insertEdgeIfAbsent({
      relationType: "reports_to",
      srcEntityId: ENT_B,
      dstEntityId: ENT_A,
      createdBy: "ai_generated",
    });
    expect(downToUp.created).toBe(true);
    expect(upToDown.created).toBe(true);
    expect(downToUp.row.id).not.toBe(upToDown.row.id);
    expect([downToUp.row.src_id, downToUp.row.dst_id]).toEqual([ENT_A, ENT_B]);
    expect([upToDown.row.src_id, upToDown.row.dst_id]).toEqual([ENT_B, ENT_A]);
    expect(countRows(db, "graph_edge")).toBe(2);
  });

  it("生成的 id 带 edge_ 前缀，store 返回的行形状与迁移列名逐字一致", () => {
    const inserted = store.insertEdgeIfAbsent({
      relationType: "classmate_of",
      srcEntityId: ENT_A,
      dstEntityId: ENT_B,
      createdBy: "ai_generated",
      originParseRunId: "run_m7_1",
      evidenceReason: `parse_run:run_m7_1 rev:${revisionId} span:0-9`,
    });
    expect(hasPrefix(inserted.row.id, "graphEdge")).toBe(true);
    expect(Object.keys(inserted.row).sort()).toEqual(
      [
        "id",
        "relation_type",
        "src_kind",
        "dst_kind",
        "src_id",
        "dst_id",
        "lifecycle_status",
        "created_by",
        "origin_suggestion_id",
        "origin_parse_run_id",
        "evidence_reason",
        "created_at_utc",
        "updated_at_utc",
      ].sort(),
    );
    expect(inserted.row.src_kind).toBe("entity");
    expect(inserted.row.dst_kind).toBe("entity");
    expect(inserted.row.lifecycle_status).toBe("active");
    expect(inserted.row.origin_suggestion_id).toBeNull();
    expect(inserted.row.origin_parse_run_id).toBe("run_m7_1");
    expect(inserted.row.created_at_utc).toBe(NOW);
    expect(inserted.row.updated_at_utc).toBe(NOW);
  });
});

// ── G. 端点硬删除 ⇒ 边被清理（0006 那条 `_ad` 触发器重建成功）─────────

describe("G. 实体硬删除带走它的边（隐私清理路径没在整表重建中丢）", () => {
  it("delete from entity ⇒ 引用它的 AI 边一并清除；事务回滚则一行不少", () => {
    store.insertEdgeIfAbsent({ relationType: "colleague_of", srcEntityId: ENT_A, dstEntityId: ENT_B, createdBy: "ai_generated" });
    store.insertEdgeIfAbsent({ relationType: "reports_to", srcEntityId: ENT_B, dstEntityId: ENT_A, createdBy: "ai_generated" });
    expect(countRows(db, "graph_edge")).toBe(2);

    db.exec("begin immediate");
    db.prepare("delete from entity where id = ?").run(ENT_B);
    expect(db.prepare("select count(*) as n from graph_edge where src_id = ? or dst_id = ?").get(ENT_B, ENT_B)).toEqual({ n: 0 });
    // 两条边各有一端是 ENT_B，于是都被清走——不留「端点已消失的关系」。
    expect(countRows(db, "graph_edge")).toBe(0);
    db.exec("rollback");
    expect(countRows(db, "graph_edge")).toBe(2);
  });

  it("概念与 episode 端点的清理触发器同样在位（三条 `_ad` 一条都不能少）", () => {
    insertEpisode(db, "ep_m7_a");
    insertEpisode(db, "ep_m7_b");
    insertConcept(db, "concept_m7_emotion", "焦虑");
    insertConcept(db, "concept_m7_topic", "工作");
    rawInsertEdge(db, {
      id: "edge_m7_ep",
      relation_type: "possibly_related",
      src_kind: "episode",
      dst_kind: "episode",
      src_id: "ep_m7_a",
      dst_id: "ep_m7_b",
    });
    rawInsertEdge(db, {
      id: "edge_m7_concept",
      relation_type: "merged_into",
      src_kind: "concept",
      dst_kind: "concept",
      src_id: "concept_m7_emotion",
      dst_id: "concept_m7_topic",
    });
    expect(countRows(db, "graph_edge")).toBe(2);
    db.exec("begin immediate");
    db.prepare("delete from episode where id = 'ep_m7_b'").run();
    db.prepare("delete from concept where id = 'concept_m7_topic'").run();
    expect(countRows(db, "graph_edge")).toBe(0);
    db.exec("rollback");
    expect(countRows(db, "graph_edge")).toBe(2);
  });

  it("端点不存在 / 被改到不存在：存在性触发器（_bi / _bu）在重建后照旧接住", () => {
    expectRejected(
      () =>
        rawInsertEdge(db, {
          id: "edge_m7_ghost",
          relation_type: "colleague_of",
          src_kind: "entity",
          dst_kind: "entity",
          src_id: ENT_A,
          dst_id: "entity_m7_ghost",
        }),
      /graph_edge\.dst_id 指向不存在的 entity/,
    );
    const live = store.insertEdgeIfAbsent({
      relationType: "colleague_of",
      srcEntityId: ENT_A,
      dstEntityId: ENT_B,
      createdBy: "ai_generated",
    });
    expectRejected(
      () => db.prepare("update graph_edge set dst_id = 'entity_m7_ghost' where id = ?").run(live.row.id),
      /graph_edge\.dst_id 指向不存在的 entity/,
    );
    expect(edgeRowById(db, live.row.id)!["dst_id"]).toBe(ENT_B);
  });
});

// ── H. 读面（M7-3「不重跑模型、直接读库出图」的物理基础）──────────────

describe("H. edgesOfEntity 与 edgesOfRun：两个读面各守一件事", () => {
  it("edgesOfEntity 两个方向都读得到（无向归一后实体可能在 src 也可能在 dst）", () => {
    store.insertEdgeIfAbsent({ relationType: "colleague_of", srcEntityId: ENT_A, dstEntityId: ENT_B, createdBy: "ai_generated" });
    store.insertEdgeIfAbsent({ relationType: "reports_to", srcEntityId: ENT_B, dstEntityId: ENT_A, createdBy: "user" });
    store.insertEdgeIfAbsent({ relationType: "family_of", srcEntityId: ENT_A, dstEntityId: ENT_B, createdBy: "user" });

    const ofA = store.edgesOfEntity(ENT_A);
    const ofB = store.edgesOfEntity(ENT_B);
    expect(ofA.map((r) => r.relation_type).sort()).toEqual(["colleague_of", "family_of", "reports_to"]);
    expect(ofB.map((r) => r.relation_type).sort()).toEqual(["colleague_of", "family_of", "reports_to"]);
    // reports_to 在两个方向上都可达，且读面不改写方向。
    const reports = ofA.find((r) => r.relation_type === "reports_to")!;
    expect([reports.src_id, reports.dst_id]).toEqual([ENT_B, ENT_A]);
    expect(ofA.every((r) => r.src_kind === "entity" && r.dst_kind === "entity")).toBe(true);
  });

  it("edgesOfEntity 不读别的实体，也不因为一次删除而漏读；非实体边不进这一面", () => {
    insertEpisode(db, "ep_m7_a");
    insertEpisode(db, "ep_m7_b");
    store.insertEdgeIfAbsent({ relationType: "friend_of", srcEntityId: ENT_A, dstEntityId: ENT_B, createdBy: "user" });
    rawInsertEdge(db, {
      id: "edge_m7_h_ep",
      relation_type: "possibly_related",
      src_kind: "episode",
      dst_kind: "episode",
      src_id: "ep_m7_a",
      dst_id: "ep_m7_b",
    });
    expect(store.edgesOfEntity("entity_m7_nobody")).toEqual([]);
    const ofA = store.edgesOfEntity(ENT_A);
    expect(ofA.map((r) => r.relation_type)).toEqual(["friend_of"]);
    expect(store.edgesOfEntity(ENT_B).map((r) => r.relation_type)).toEqual(["friend_of"]);
    // episode 端点的边由 episode 的清理触发器负责，不混进实体读面。
    expect(ofA.some((r) => r.src_kind === "episode" || r.dst_kind === "episode")).toBe(false);
  });

  it("edgesOfRun 只按来源指针命中；存量 NULL 边与别的 run 的边都不在内", () => {
    const fromRun = store.insertEdgeIfAbsent({
      relationType: "friend_of",
      srcEntityId: ENT_A,
      dstEntityId: ENT_B,
      createdBy: "ai_generated",
      originParseRunId: "run_m7_1",
    });
    const handWritten = store.insertEdgeIfAbsent({
      relationType: "colleague_of",
      srcEntityId: ENT_A,
      dstEntityId: ENT_B,
      createdBy: "user",
    });
    insertRun(db, "run_m7_2", revisionId, OTHER64);
    store.insertEdgeIfAbsent({
      relationType: "classmate_of",
      srcEntityId: ENT_A,
      dstEntityId: ENT_B,
      createdBy: "ai_generated",
      originParseRunId: "run_m7_2",
    });

    expect(store.edgesOfRun("run_m7_1").map((r) => r.id)).toEqual([fromRun.row.id]);
    expect(store.edgesOfRun("run_m7_2").map((r) => r.relation_type)).toEqual(["classmate_of"]);
    expect(store.edgesOfRun("run_does_not_exist")).toEqual([]);
    expect(handWritten.row.origin_parse_run_id).toBeNull();

    // 来源指针失效（run 被清理）不连带抹掉一条已独立成立的关系：SET NULL，不是 CASCADE。
    db.exec("begin immediate");
    db.prepare("delete from parse_run where id = 'run_m7_1'").run();
    const after = edgeRowById(db, fromRun.row.id);
    expect(after).toBeDefined();
    expect(after!["origin_parse_run_id"]).toBeNull();
    db.exec("rollback");
    expect(store.edgesOfRun("run_m7_1").map((r) => r.id)).toEqual([fromRun.row.id]);
  });

  it("来源指针指向不存在的 parse_run：FK 接住（SET NULL 的语义不是随便挂）", () => {
    expectRejected(
      () =>
        rawInsertEdge(db, {
          id: "edge_m7_bad_run",
          relation_type: "friend_of",
          src_kind: "entity",
          dst_kind: "entity",
          src_id: ENT_A,
          dst_id: ENT_B,
          created_by: "ai_generated",
          origin_parse_run_id: "run_ghost",
        }),
      /FOREIGN KEY constraint failed/,
    );
  });
});

// ── I. 跨层守门：K-18 从列 CHECK 移到 store ───────────────────────────

describe("I. 跨层守门：AI 永不创建 same_as / merged_into（K-18）", () => {
  it("契约面：九值里只有六类新关系声明 ai_generated，ai_may_never_create ∩ GraphEdge = {same_as, merged_into}", () => {
    const never = enums.relation_type_rules.ai_may_never_create;
    expect(never).toEqual(["triggered_by", "same_as", "merged_into"]);
    // `relation_type_rules` 是混合取值表（说明文字 / 清单 / 布尔标记），对账前先收窄成清单；
    // 收窄不成就当契约断裂处理，不留 `undefined.filter` 那种「运行时才发现」的洞。
    if (!Array.isArray(never)) throw new Error("enums.relation_type_rules.ai_may_never_create 不是清单");
    const neverOnGraphEdge = never.filter((t) => enums.relation_types.find((r) => r.type === t)?.carrier === "GraphEdge");
    expect([...neverOnGraphEdge].sort()).toEqual(["merged_into", "same_as"]);

    const aiMayCreate = enums.relation_types
      .filter((r) => r.carrier === "GraphEdge" && r.creators.includes("ai_generated"))
      .map((r) => r.type)
      .sort();
    expect(aiMayCreate).toEqual([...NEW_RELATION_TYPES].sort());
  });

  it("store 层一律被拒：same_as 以 ai_generated 调 store 抛在 K-18 那一支，merged_into 同样进不了这张表", () => {
    let sameAsThrown: unknown;
    try {
      store.insertEdgeIfAbsent({
        relationType: "same_as",
        srcEntityId: ENT_A,
        dstEntityId: ENT_B,
        createdBy: "ai_generated",
        originParseRunId: "run_m7_1",
      });
    } catch (cause) {
      sameAsThrown = cause;
    }
    expect(sameAsThrown).toBeInstanceOf(GraphEdgeInputError);
    // 报错理由必须是 K-18 本身，而不是「端点种类不对」这种顺路挡下的别的分支。
    expect((sameAsThrown as Error).message).toMatch(/AI 永不创建/);

    // merged_into 的端点是 concept×concept，本层的实体写入面先把它挡下（同一种错、同样在落库之前）。
    // 记在这儿是因为它是真话：全仓唯一的 graph_edge 写面就是本 store（grep：insert into graph_edge 只此一处），
    // 所以 K-18 这一层的两个值都到不了库；将来若概念合并改走本层，这条判据仍然接得住。
    expect(() =>
      store.insertEdgeIfAbsent({
        relationType: "merged_into",
        srcEntityId: ENT_A,
        dstEntityId: ENT_B,
        createdBy: "ai_generated",
        originParseRunId: "run_m7_1",
      }),
    ).toThrow(GraphEdgeInputError);
    expect(countRows(db, "graph_edge")).toBe(0);
  });

  it("列 CHECK 确实松了：库里物理上写得进 same_as / merged_into + ai_generated", () => {
    insertConcept(db, "concept_m7_emotion", "焦虑");
    insertConcept(db, "concept_m7_topic", "工作");
    // 这条断言的意义不是「库里能写」本身，而是证明上面那条 store 守门不是冗余装饰：
    // 0011 之前 `created_by` 只有用户来源两值，K-18 由那一列整体兜住；放行 ai_generated 之后
    // 列约束再也表达不了「哪几类关系 AI 永不创建」，接手点必须落在 store。
    expectAccepted(() =>
      rawInsertEdge(db, {
        id: "edge_m7_k18_same_as",
        relation_type: "same_as",
        src_kind: "entity",
        dst_kind: "entity",
        src_id: ENT_A,
        dst_id: ENT_B,
        created_by: "ai_generated",
        origin_parse_run_id: "run_m7_1",
      }),
    );
    expectAccepted(() =>
      rawInsertEdge(db, {
        id: "edge_m7_k18_merged",
        relation_type: "merged_into",
        src_kind: "concept",
        dst_kind: "concept",
        src_id: "concept_m7_emotion",
        dst_id: "concept_m7_topic",
        created_by: "ai_generated",
      }),
    );
    expect(countRows(db, "graph_edge")).toBe(0);
  });

  it("守门只砍 ai_generated：同一类的用户来源与用户确认来源仍然放行", () => {
    const byUser = store.insertEdgeIfAbsent({
      relationType: "same_as",
      srcEntityId: ENT_A,
      dstEntityId: ENT_B,
      createdBy: "user",
    });
    expect(byUser.created).toBe(true);
    expect(byUser.row.created_by).toBe("user");
    // 同三元组已存在：user_confirmed_suggestion 不新建、也不改写既有行的 created_by。
    const byConfirm = store.insertEdgeIfAbsent({
      relationType: "same_as",
      srcEntityId: ENT_A,
      dstEntityId: ENT_B,
      createdBy: "user_confirmed_suggestion",
    });
    expect(byConfirm.created).toBe(false);
    expect(byConfirm.row.id).toBe(byUser.row.id);
    expect(edgeRowById(db, byUser.row.id)!["created_by"]).toBe("user");
    expect(countRows(db, "graph_edge")).toBe(1);
  });

  it("九值全表过一遍 store：AI 能不能建，判据只有 enums 的 creators 声明这一份", () => {
    for (const rel of enums.relation_types.filter((r) => r.carrier === "GraphEdge")) {
      const aiMayCreate = rel.creators.includes("ai_generated");
      const entityEndpoints =
        rel.source.toLowerCase().startsWith("entity") && rel.target.toLowerCase().startsWith("entity");
      if (!entityEndpoints) continue; // 非实体端点由入参面整条拒收（§三.5 写入面），那是另一件事
      if (aiMayCreate) {
        expectAccepted(() => {
          const result = store.insertEdgeIfAbsent({
            relationType: rel.type,
            srcEntityId: ENT_A,
            dstEntityId: ENT_B,
            createdBy: "ai_generated",
          });
          expect(result.created).toBe(true);
          expect(result.row.created_by).toBe("ai_generated");
        });
      } else {
        expect(() =>
          store.insertEdgeIfAbsent({
            relationType: rel.type,
            srcEntityId: ENT_A,
            dstEntityId: ENT_B,
            createdBy: "ai_generated",
          }),
        ).toThrow(GraphEdgeInputError);
      }
    }
    expect(countRows(db, "graph_edge")).toBe(0);
  });
});
