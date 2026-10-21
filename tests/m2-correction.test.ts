import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { migrate } from "../src/server/db/migrator.ts";
import { RecordService } from "../src/server/records/service.ts";
import { countRows, makeSandbox, openSandboxDb, type Sandbox } from "./helpers/sandbox.ts";
import type { Database } from "../src/server/db/adapter.ts";

/**
 * M2 修正层 Schema 契约测试（Schema 审查稿 §3.18 / §7.4 的 migration 集成面层）。
 * 覆盖 D2 必过断言：
 *   · T-15 —— ovo_ / ucp_ 前缀 CHECK。
 *   · §3.18 —— object_table / container_table / collection / op 四个封闭集；field_name 白名单 CASE CHECK；
 *              value_json 的 json_valid；两张表各自的 UNIQUE 键。
 *   · T-30（DB 面）—— override 指向不存在的目标、或指向 candidate run 下的行被触发器拒；
 *              四张目标表 + 两张容器表的 AFTER DELETE 触发器逐一不留孤儿。
 *   · T-32（复核）—— source-less 直插仍被 0003 拒（本层未削弱既有约束）。
 *   · §3.18 增补〔用户裁定 2026-10-13〕（M2-2b / 迁移 0005）—— 取值门：三个枚举型字段的 value_json
 *              锁在 enums.json 的封闭枚举内（含 JSON null / 数字 / 对象 / 数组 全拒的 NULL 安全面）、
 *              五个自由文本字段不受门约束；entity 分支白名单增 entity_type（7 值内选、不得新增）；
 *              整表重建后既有行原样保留、六个 ovo_ 触发器在册且生效；override 是投影、不回写基表。
 *
 * 与 m2-schema-contract 同法：全部绕过服务层直接写库，写入都在显式事务里、探完即回滚，夹具现场不被污染。
 * 服务层的 add 拒绝（T-30）、采纳时的 object_id 迁移（§3.19/§7.4）归 M2-5，不在本 DB 面断言。
 */

const NOW = "2026-10-13T06:30:00.000Z";
const HEX64 = "0123456789abcdef".repeat(4);

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

/** §3.18 白名单的「每个 object_table 一个合法字段」，供正向写入复用。 */
const VALID_FIELD: Record<string, string> = {
  episode: "summary",
  thought_item: "text",
  concept: "canonical_name",
  entity: "canonical_name",
};

/** insertOverride 的夹具默认 value_json —— 只有自由文本字段可以沿用，枚举型字段必须自带合法取值。 */
const PROBE_VALUE = '"探针覆盖"';

/**
 * M2-2b 同步点（E-05）：取值门的字面量清单只允许存在于 0005 与 enums.json 两处，
 * 测试读它们做对账（T-16 手法），不硬编码第二份清单。
 */
const MIGRATION_0005 = "src/server/db/migrations/0005_override_value_gate.sql";
const ENUMS_FILE = "src/shared/constants/enums.json";

/** 静态扫描用去注释文本：头注里引用被守形态的字面量不参与断言。 */
function stripComments(source: string): string {
  return source
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
}

const sql0005 = stripComments(readFileSync(MIGRATION_0005, "utf8"));
const enums = JSON.parse(readFileSync(ENUMS_FILE, "utf8")) as {
  entity_types: string[];
  event_time_precision: string[];
  event_time_certainty: string[];
};

/**
 * 抽取 0005 取值门里某字段 `WHEN '<field>' THEN … IN ( … )` 的字面量清单（含顺序）。
 * 形态即契约增补规定的 NULL 安全形态，抽不到就是形态跑偏——抛出来，不让 undefined 溜进断言。
 */
function gateList(field: string): string[] {
  const pattern = new RegExp(
    `WHEN '${field}' THEN json_type\\(value_json\\) = 'text' AND json_extract\\(value_json, '\\$'\\) IN \\(([\\s\\S]*?)\\)`,
  );
  const match = pattern.exec(sql0005);
  if (match === null) throw new Error(`0005 取值门中未找到 ${field} 的 IN (...) 清单`);
  return [...match[1]!.matchAll(/'([^']*)'/g)].map((m) => m[1]!);
}

let sandbox: Sandbox;
let db: Database;
let revisionId: string;
let revision2: string;

beforeEach(() => {
  sandbox = makeSandbox("tb-m2-correction-");
  db = openSandboxDb(sandbox.layout);
  migrate(db);
  const service = new RecordService(db, { timezoneId: "Asia/Shanghai", now: () => new Date(NOW) });
  const created = service.createRecord("今天和老周聊了很久，我感到焦虑。");
  revisionId = created.revision.id;
  revision2 = service.editRecord(created.record.id, "同一条记录的第二个版本。").revision.id;

  // 目标对象夹具：一条 current run、一条 candidate run，覆盖「可修正 / 不可修正」两条路。
  insertConcept("concept_fixture_emotion", "emotion", "焦虑");
  insertEntity("entity_fixture_1", "person", "老周");
  insertRun("run_current", { source_revision_id: revision2, result_state: "current", pipeline_fingerprint: HEX64 });
  insertRun("run_cand", { source_revision_id: revision2, result_state: "candidate", pipeline_fingerprint: "b".repeat(64) });
  // episode / thought_item 三种目标：user_created（无 run）、current run 下、candidate run 下。
  insertEpisode("ep_user", {});
  insertEpisode("ep_cur", aiEpisode("run_current"));
  insertEpisode("ep_cand", aiEpisode("run_cand"));
  insertThought("thought_user", { source_record_revision_id: revisionId });
  insertThought("thought_cur", aiThought("run_current"));
  insertThought("thought_cand", aiThought("run_cand"));
});

afterEach(() => {
  db.close();
  sandbox.cleanup();
});

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

// ── 派生层夹具写入器（沿用 m2-schema-contract 的字面量形态）────────────

function insertConcept(id: string, type: "emotion" | "topic", name: string): void {
  db.prepare(
    `insert into concept (id, concept_type, canonical_name, origin_type, lifecycle_status, created_at_utc)
     values (?, ?, ?, 'user_created', 'active', ?)`,
  ).run(id, type, name, NOW);
}

function insertEntity(id: string, entityType: string, name: string): void {
  run("entity", {
    id,
    entity_type: entityType,
    canonical_name: name,
    display_name: name,
    lifecycle_status: "active",
    privacy_level: "normal",
    origin_type: "user_created",
    created_at_utc: NOW,
  });
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
    event_time_precision: "unknown",
    event_time_certainty: "unknown",
    event_time_start: null,
    event_time_end: null,
    created_at_utc: NOW,
    ...overrides,
  });
}

function aiEpisode(runId: string): Record<string, unknown> {
  return {
    origin_type: "ai_generated",
    source_record_revision_id: revisionId,
    parse_run_id: runId,
    evidence_text: "焦虑",
    evidence_start: 12,
    evidence_end: 14,
  };
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

function aiThought(runId: string): Record<string, unknown> {
  return {
    origin_type: "ai_generated",
    source_record_revision_id: revisionId,
    source_episode_id: null,
    parse_run_id: runId,
    evidence_text: "焦虑",
    evidence_start: 12,
    evidence_end: 14,
  };
}

// ── 修正层夹具写入器（本任务的主角）────────────────────────────────────

function insertOverride(
  id: string,
  objectTable: string,
  objectId: string,
  fieldName: string,
  overrides: Record<string, unknown> = {},
): void {
  run("user_scalar_override", {
    id,
    object_table: objectTable,
    object_id: objectId,
    field_name: fieldName,
    value_json: PROBE_VALUE,
    updated_at_utc: NOW,
    ...overrides,
  });
}

function insertPatch(
  id: string,
  containerTable: string,
  containerId: string,
  overrides: Record<string, unknown> = {},
): void {
  run("user_collection_patch", {
    id,
    container_table: containerTable,
    container_id: containerId,
    collection: "emotions",
    member_id: "concept_fixture_emotion",
    op: "remove",
    created_at_utc: NOW,
    ...overrides,
  });
}

/** 具名列写入：STRICT 表不做类型强转，值形态必须由调用方给对。 */
function run(table: string, values: Record<string, unknown>): void {
  const cols = Object.keys(values);
  db.prepare(
    `insert into ${table} (${cols.join(", ")}) values (${cols.map((c) => `@${c}`).join(", ")})`,
  ).run(values as Record<string, string | number | bigint | null | Uint8Array>);
}

function countWhere(table: string, predicate: string, param: string): number {
  const row = db
    .prepare(`select count(*) as n from ${table} where ${predicate}`)
    .get(param) as { n: number };
  return row.n;
}

// ── T-15：ovo_ / ucp_ 前缀 CHECK ──────────────────────────────────────

describe("T-15：修正层两张表的 id 前缀 CHECK", () => {
  it("user_scalar_override 拒绝错误前缀与空前缀，接受 ovo_ 前缀", () => {
    // 目标全部用可修正的 ep_user，保证 BEFORE INSERT 存在性触发器先放行、前缀 CHECK 是第一道被触发的约束。
    expectRejected(
      () => insertOverride("zzz_wrong_1", "episode", "ep_user", VALID_FIELD.episode!),
      /CHECK constraint failed/,
    );
    expectRejected(
      () => insertOverride("", "episode", "ep_user", VALID_FIELD.episode!),
      /CHECK constraint failed/,
    );
    expectAccepted(() => insertOverride("ovo_ok_1", "episode", "ep_user", VALID_FIELD.episode!));
  });

  it("user_collection_patch 拒绝错误前缀与空前缀，接受 ucp_ 前缀", () => {
    expectRejected(() => insertPatch("zzz_wrong_1", "episode", "ep_user"), /CHECK constraint failed/);
    expectRejected(() => insertPatch("", "episode", "ep_user"), /CHECK constraint failed/);
    expectAccepted(() => insertPatch("ucp_ok_1", "episode", "ep_user"));
  });

  it("两张表都带前缀 CHECK（静态守门，与派生层同法）", () => {
    const sql = ["0004_correction_layer.sql"]
      .map((name) =>
        readFileSync(`src/server/db/migrations/${name}`, "utf8")
          .split("\n")
          .filter((line) => !line.trim().startsWith("--"))
          .join("\n"),
      )
      .join("\n");
    expect(sql).toMatch(/CHECK \(id GLOB 'ovo_\*'\)/);
    expect(sql).toMatch(/CHECK \(id GLOB 'ucp_\*'\)/);
  });
});

// ── §3.18 封闭集：object_table / container_table / collection / op ────

describe("§3.18 修正层四个封闭集合", () => {
  it("override.object_table 只收 episode/thought_item/concept/entity，编造表名被拒", () => {
    for (const t of ["episode", "thought_item", "concept", "entity"]) {
      const target = t === "episode" ? "ep_user" : t === "thought_item" ? "thought_user" : t === "concept" ? "concept_fixture_emotion" : "entity_fixture_1";
      expectAccepted(() => insertOverride(`ovo_t_${t}`, t, target, VALID_FIELD[t]!));
    }
    expectRejected(
      () => insertOverride("ovo_t_bad", "capture_record", "rec_ghost", "summary"),
      /CHECK constraint failed/,
    );
  });

  it("patch.container_table 只收 episode/thought_item；revision 不是容器", () => {
    expectAccepted(() => insertPatch("ucp_ct_ep", "episode", "ep_user"));
    expectAccepted(() => insertPatch("ucp_ct_th", "thought_item", "thought_user"));
    expectRejected(
      () => insertPatch("ucp_ct_bad", "record_revision", revisionId, {}),
      /CHECK constraint failed/,
    );
  });

  it("patch.collection 只收 emotions/topics/entities（单数或其它被拒）", () => {
    for (const c of ["emotions", "topics", "entities"]) {
      expectAccepted(() => insertPatch(`ucp_col_${c}`, "episode", "ep_user", { collection: c }));
    }
    for (const bad of ["emotion", "topic", "entity", "about"]) {
      expectRejected(
        () => insertPatch(`ucp_col_bad_${bad}`, "episode", "ep_user", { collection: bad }),
        /CHECK constraint failed/,
      );
    }
  });

  it("patch.op 收 add|remove（§3.18 冻结原文；add 的服务层禁止归 M2-5）", () => {
    expectAccepted(() => insertPatch("ucp_op_add", "episode", "ep_user", { op: "add", member_id: "concept_fixture_emotion" }));
    expectAccepted(() => insertPatch("ucp_op_rm", "episode", "ep_user", { op: "remove" }));
    expectRejected(
      () => insertPatch("ucp_op_bad", "episode", "ep_user", { op: "delete" }),
      /CHECK constraint failed/,
    );
  });
});

// ── §3.18 field_name 白名单 CASE CHECK ────────────────────────────────

describe("§3.18 field_name 白名单按 object_table 分支", () => {
  it("episode 只可 summary/event_time_raw/event_time_precision/event_time_certainty", () => {
    // 【M2-2b 显式声明的既有测试修改】取值门（§3.18 增补）落地后，两个枚举型字段不再接受
    // 夹具默认值 "探针覆盖"——这是**收紧**（原「任意字符串均可写」→ 新「仅枚举内可写」），
    // 不是削弱。两字段改用合法枚举值；两个自由文本字段维持夹具默认，证明门是定点的。
    const episodeFields = [
      { field: "summary", valueJson: PROBE_VALUE },
      { field: "event_time_raw", valueJson: PROBE_VALUE },
      { field: "event_time_precision", valueJson: '"day"' },
      { field: "event_time_certainty", valueJson: '"approximate"' },
    ];
    for (const f of episodeFields) {
      expectAccepted(() =>
        insertOverride(`ovo_ep_${f.field}`, "episode", "ep_user", f.field, { value_json: f.valueJson }),
      );
    }
    // text/canonical_name 是别的表的字段，挂到 episode 上被拒。
    for (const f of ["text", "canonical_name", "evidence_text"]) {
      expectRejected(
        () => insertOverride(`ovo_ep_bad_${f}`, "episode", "ep_user", f),
        /CHECK constraint failed/,
      );
    }
  });

  it("thought_item 只可 text", () => {
    expectAccepted(() => insertOverride("ovo_th_text", "thought_item", "thought_user", "text"));
    expectRejected(
      () => insertOverride("ovo_th_bad", "thought_item", "thought_user", "summary"),
      /CHECK constraint failed/,
    );
  });

  it("concept 只可 canonical_name；display_name 是 entity 专属", () => {
    expectAccepted(() => insertOverride("ovo_co_name", "concept", "concept_fixture_emotion", "canonical_name"));
    expectRejected(
      () => insertOverride("ovo_co_bad", "concept", "concept_fixture_emotion", "display_name"),
      /CHECK constraint failed/,
    );
  });

  it("entity 可 display_name 与 canonical_name 两者", () => {
    expectAccepted(() => insertOverride("ovo_en_disp", "entity", "entity_fixture_1", "display_name"));
    expectAccepted(() => insertOverride("ovo_en_canon", "entity", "entity_fixture_1", "canonical_name"));
    expectRejected(
      () => insertOverride("ovo_en_bad", "entity", "entity_fixture_1", "text"),
      /CHECK constraint failed/,
    );
  });

  it("evidence 类数值/区间字段不可 override（K-23：改证据=改来源，走 detach）", () => {
    expectRejected(
      () => insertOverride("ovo_ev_ep", "episode", "ep_user", "evidence_start"),
      /CHECK constraint failed/,
    );
  });
});

// ── §3.18 value_json 的 json_valid 守门 ───────────────────────────────

describe("§3.18 value_json 必须是合法 JSON", () => {
  it("非法 JSON 文本被拒；合法标量/对象/数组/null 都被接受", () => {
    expectRejected(
      () => insertOverride("ovo_j_bad", "episode", "ep_user", "summary", { value_json: "不是 JSON" }),
      /CHECK constraint failed/,
    );
    for (const [i, good] of ['"焦虑"', '{"a":1}', "[1,2]", "null", "42"].entries()) {
      expectAccepted(() => insertOverride(`ovo_j_${i}`, "episode", "ep_user", "summary", { value_json: good }));
    }
  });
});

// ── §3.18 UNIQUE 键 ───────────────────────────────────────────────────

describe("§3.18 两张表的 UNIQUE 键", () => {
  it("override：UNIQUE(object_table, object_id, field_name) 成员级唯一", () => {
    expectRejected(
      () => {
        insertOverride("ovo_u_1", "episode", "ep_user", "summary");
        insertOverride("ovo_u_2", "episode", "ep_user", "summary");
      },
      /UNIQUE constraint failed: user_scalar_override.object_table, user_scalar_override.object_id, user_scalar_override.field_name/,
    );
    // 同一目标的不同字段可以各自覆盖。
    expectAccepted(() => {
      insertOverride("ovo_u_f1", "episode", "ep_user", "summary");
      insertOverride("ovo_u_f2", "episode", "ep_user", "event_time_raw");
    });
    // 跨表同 id 不冲突（object_table 是键的一部分）。
    expectAccepted(() => {
      insertOverride("ovo_u_x1", "concept", "concept_fixture_emotion", "canonical_name");
      insertOverride("ovo_u_x2", "entity", "entity_fixture_1", "canonical_name");
    });
  });

  it("patch：UNIQUE(container_table, container_id, collection, member_id) 成员级唯一", () => {
    expectRejected(
      () => {
        insertPatch("ucp_u_1", "episode", "ep_user");
        insertPatch("ucp_u_2", "episode", "ep_user");
      },
      /UNIQUE constraint failed: user_collection_patch.container_table, user_collection_patch.container_id, user_collection_patch.collection, user_collection_patch.member_id/,
    );
    // 不同成员 / 不同集合可各自成补丁。
    expectAccepted(() => {
      insertPatch("ucp_u_a", "episode", "ep_user", { member_id: "concept_fixture_emotion" });
      insertPatch("ucp_u_b", "episode", "ep_user", { member_id: "concept_fixture_other" });
      insertPatch("ucp_u_c", "episode", "ep_user", { collection: "topics", member_id: "concept_fixture_emotion" });
    });
  });
});

// ── T-30（DB 面）：目标存在性 + candidate 拒绝 ────────────────────────

describe("T-30：override 存在性触发器 + 候选行不可被修正", () => {
  it("指向不存在的目标被 BEFORE INSERT 触发器拒（四张表逐一）", () => {
    expectRejected(
      () => insertOverride("ovo_g_ep", "episode", "ep_不存在", "summary"),
      /不存在的 episode/,
    );
    expectRejected(
      () => insertOverride("ovo_g_th", "thought_item", "thought_不存在", "text"),
      /不存在的 thought_item/,
    );
    expectRejected(
      () => insertOverride("ovo_g_co", "concept", "concept_不存在", "canonical_name"),
      /不存在的 concept/,
    );
    expectRejected(
      () => insertOverride("ovo_g_en", "entity", "entity_不存在", "canonical_name"),
      /不存在的 entity/,
    );
  });

  it("episode/thought_item 挂在 current run 下、或 user_created 无 run：都可修正", () => {
    expectAccepted(() => insertOverride("ovo_ok_user_ep", "episode", "ep_user", "summary"));
    expectAccepted(() => insertOverride("ovo_ok_cur_ep", "episode", "ep_cur", "summary"));
    expectAccepted(() => insertOverride("ovo_ok_user_th", "thought_item", "thought_user", "text"));
    expectAccepted(() => insertOverride("ovo_ok_cur_th", "thought_item", "thought_cur", "text"));
  });

  it("指向 candidate run 下的 episode/thought_item：被触发器拒（杜绝悬空修正）", () => {
    expectRejected(
      () => insertOverride("ovo_cand_ep", "episode", "ep_cand", "summary"),
      /不存在的 episode.*candidate|run 非 current|不可被修正/,
    );
    expectRejected(
      () => insertOverride("ovo_cand_th", "thought_item", "thought_cand", "text"),
      /不存在的 thought_item.*candidate|run 非 current|不可被修正/,
    );
  });

  it("BEFORE UPDATE 同样守门：把合法 override 改指向幽灵/candidate 被拒", () => {
    // 先把合法 override 落进库（beforeEach 的 fresh sandbox 是本次测试的作用域，结束即随 sandbox 清理）。
    // expectRejected 内部自带 begin/rollback，所以外层不再包事务，避免嵌套。
    insertOverride("ovo_upd", "episode", "ep_user", "summary");
    expectRejected(
      () => db.prepare("update user_scalar_override set object_id = 'ep_不存在' where id = 'ovo_upd'").run(),
      /不存在的 episode/,
    );
    expectRejected(
      () => db.prepare("update user_scalar_override set object_id = 'ep_cand' where id = 'ovo_upd'").run(),
      /run 非 current|不可被修正/,
    );
    db.prepare("delete from user_scalar_override where id = 'ovo_upd'").run();
  });

  it("patch 容器存在性：指向不存在的 episode/thought_item 被拒；UPDATE 同样守门", () => {
    expectRejected(
      () => insertPatch("ucp_g_ep", "episode", "ep_不存在"),
      /不存在的 episode/,
    );
    expectRejected(
      () => insertPatch("ucp_g_th", "thought_item", "thought_不存在"),
      /不存在的 thought_item/,
    );
    insertPatch("ucp_upd", "episode", "ep_user");
    expectRejected(
      () => db.prepare("update user_collection_patch set container_id = 'ep_不存在' where id = 'ucp_upd'").run(),
      /不存在的 episode/,
    );
    db.prepare("delete from user_collection_patch where id = 'ucp_upd'").run();
  });
});

// ── T-30：目标/容器删除后不留孤儿（AFTER DELETE 触发器逐一）──────────

describe("T-30：删除清理触发器——目标消失 ⇒ override/patch 一并清除", () => {
  it("override 四张目标表各挂 AFTER DELETE：删目标不留孤儿", () => {
    const probes: ReadonlyArray<{
      readonly objectTable: string;
      readonly objectId: string;
      readonly field: string;
      readonly targetTable: string;
    }> = [
      { objectTable: "episode", objectId: "ep_user", field: "summary", targetTable: "episode" },
      { objectTable: "thought_item", objectId: "thought_user", field: "text", targetTable: "thought_item" },
      { objectTable: "concept", objectId: "concept_fixture_emotion", field: "canonical_name", targetTable: "concept" },
      { objectTable: "entity", objectId: "entity_fixture_1", field: "canonical_name", targetTable: "entity" },
    ];
    for (const p of probes) {
      attemptRollback(() => {
        insertOverride(`ovo_del_${p.objectTable}`, p.objectTable, p.objectId, p.field);
        expect(countWhere("user_scalar_override", "object_id = ?", p.objectId)).toBe(1);
        db.prepare(`delete from ${p.targetTable} where id = ?`).run(p.objectId);
        expect(countWhere("user_scalar_override", "object_id = ?", p.objectId)).toBe(0);
      });
    }
  });

  it("patch 两张容器表各挂 AFTER DELETE：删容器不留孤儿", () => {
    attemptRollback(() => {
      insertPatch("ucp_del_ep", "episode", "ep_user");
      expect(countWhere("user_collection_patch", "container_id = ?", "ep_user")).toBe(1);
      db.prepare("delete from episode where id = 'ep_user'").run();
      expect(countWhere("user_collection_patch", "container_id = ?", "ep_user")).toBe(0);
    });
    attemptRollback(() => {
      insertPatch("ucp_del_th", "thought_item", "thought_user");
      expect(countWhere("user_collection_patch", "container_id = ?", "thought_user")).toBe(1);
      db.prepare("delete from thought_item where id = 'thought_user'").run();
      expect(countWhere("user_collection_patch", "container_id = ?", "thought_user")).toBe(0);
    });
  });

  it("member 概念保留时补丁随容器消失，不因概念未删而复活（§3.18 尾段）", () => {
    attemptRollback(() => {
      insertPatch("ucp_member_keep", "episode", "ep_user", { member_id: "concept_fixture_emotion" });
      db.prepare("delete from episode where id = 'ep_user'").run();
      expect(countRows(db, "user_collection_patch")).toBe(0);
      // 概念仍在（补丁只跟容器走，不反向删概念）。
      expect(countWhere("concept", "id = ?", "concept_fixture_emotion")).toBe(1);
    });
  });

  it("结构守门：六个 AFTER DELETE 触发器都注册在案", () => {
    const triggers = (
      db
        .prepare("select name from sqlite_master where type='trigger' and (name like 'ovo_%_ad' or name like 'ucp_%_ad')")
        .all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(new Set(triggers)).toEqual(
      new Set([
        "ovo_episode_ad",
        "ovo_thought_ad",
        "ovo_concept_ad",
        "ovo_entity_ad",
        "ucp_episode_ad",
        "ucp_thought_ad",
      ]),
    );
  });
});

// ── T-32（复核）：0003 的 source-less 守门未被 0004 削弱 ──────────────

describe("T-32 复核：source-less 直插仍被 0003 拒（本层不削弱既有约束）", () => {
  it("thought_item 两个来源列全空被拒（0003 交付约束保持生效）", () => {
    expectRejected(
      () =>
        run("thought_item", {
          id: "thought_no_source",
          text: "无来源念头",
          source_record_revision_id: null,
          source_episode_id: null,
          origin_type: "user_created",
          lifecycle_status: "active",
          evidence_text: "",
          created_at_utc: NOW,
        }),
      /CHECK constraint failed/,
    );
  });
});

// ── §3.18 增补〔用户裁定 2026-10-13〕之一：取值门（NULL 安全） ────────

describe("M2-2b 取值门：枚举型字段的 value_json 锁在所属封闭枚举内", () => {
  const gated: ReadonlyArray<{
    readonly field: string;
    readonly values: readonly string[];
    readonly table: string;
    readonly target: string;
    readonly bogus: string;
  }> = [
    {
      field: "event_time_precision",
      values: enums.event_time_precision,
      table: "episode",
      target: "ep_user",
      bogus: "瞎编的精度",
    },
    {
      field: "event_time_certainty",
      values: enums.event_time_certainty,
      table: "episode",
      target: "ep_user",
      bogus: "瞎编的确信度",
    },
    {
      field: "entity_type",
      values: enums.entity_types,
      table: "entity",
      target: "entity_fixture_1",
      bogus: "宠物",
    },
  ];

  for (const g of gated) {
    it(`${g.field}：enums.json 的每个取值都收；枚举外取值拒（用户不得自己新增）`, () => {
      for (const [i, value] of g.values.entries()) {
        expectAccepted(() =>
          insertOverride(`ovo_gate_${g.field}_${i}`, g.table, g.target, g.field, {
            value_json: JSON.stringify(value),
          }),
        );
      }
      for (const bogus of [g.bogus, "PERSON", ""]) {
        expectRejected(
          () =>
            insertOverride(`ovo_gate_${g.field}_bad`, g.table, g.target, g.field, {
              value_json: JSON.stringify(bogus),
            }),
          /CHECK constraint failed/,
        );
      }
    });

    // NULL 安全是本次增补的强制形态：JSON null 只靠 json_extract IN (...) 判定时求值为 SQL NULL，
    // 而 SQLite 的 CHECK 对 NULL 判为通过——会从三值逻辑的缝里漏过去。数字/对象/数组同法逐一钉死。
    it(`${g.field}：JSON null / 数字 / 对象 / 数组 一律拒`, () => {
      for (const [i, bad] of ["null", "42", '{"a":1}', "[1,2]"].entries()) {
        expectRejected(
          () => insertOverride(`ovo_gate_${g.field}_t${i}`, g.table, g.target, g.field, { value_json: bad }),
          /CHECK constraint failed/,
        );
      }
    });
  }

  it("summary 仍接受任意合法 JSON —— 取值门是定点的，未误伤自由文本", () => {
    for (const [i, good] of ['"任意文本"', '{"a":1}', "[1,2]", "null", "42"].entries()) {
      expectAccepted(() =>
        insertOverride(`ovo_free_sum_${i}`, "episode", "ep_user", "summary", { value_json: good }),
      );
    }
  });

  it("其余四个自由文本字段同样不受门约束", () => {
    expectAccepted(() =>
      insertOverride("ovo_free_raw", "episode", "ep_user", "event_time_raw", { value_json: "null" }),
    );
    expectAccepted(() =>
      insertOverride("ovo_free_text", "thought_item", "thought_user", "text", { value_json: "42" }),
    );
    expectAccepted(() =>
      insertOverride("ovo_free_cname", "concept", "concept_fixture_emotion", "canonical_name", {
        value_json: "[1,2]",
      }),
    );
    expectAccepted(() =>
      insertOverride("ovo_free_dname", "entity", "entity_fixture_1", "display_name", {
        value_json: '{"a":1}',
      }),
    );
  });
});

// ── §3.18 增补〔用户裁定 2026-10-13〕之二：entity_type 可修正 ─────────

describe("M2-2b 白名单扩展：entity 分支增 entity_type，其余三分支不动", () => {
  it('entity_type 收 "person"、拒 "宠物"——「不能自己新增取值」的 DB 面', () => {
    expectAccepted(() =>
      insertOverride("ovo_et_person", "entity", "entity_fixture_1", "entity_type", { value_json: '"person"' }),
    );
    expectRejected(
      () => insertOverride("ovo_et_pet", "entity", "entity_fixture_1", "entity_type", { value_json: '"宠物"' }),
      /CHECK constraint failed/,
    );
    // entity_type 只属于 entity 分支：concept / thought_item 借用被白名单拒。
    expectRejected(
      () =>
        insertOverride("ovo_et_concept", "concept", "concept_fixture_emotion", "entity_type", {
          value_json: '"person"',
        }),
      /CHECK constraint failed/,
    );
    expectRejected(
      () =>
        insertOverride("ovo_et_thought", "thought_item", "thought_user", "entity_type", { value_json: '"person"' }),
      /CHECK constraint failed/,
    );
  });

  it("静态守门：白名单三分支逐字未动，取值门只覆盖三个枚举字段", () => {
    expect(sql0005).toMatch(
      /WHEN 'episode' THEN field_name IN \(\s*'summary',\s*'event_time_raw',\s*'event_time_precision',\s*'event_time_certainty'\s*\)/,
    );
    expect(sql0005).toMatch(/WHEN 'thought_item' THEN field_name IN \('text'\)/);
    expect(sql0005).toMatch(/WHEN 'concept' THEN field_name IN \('canonical_name'\)/);
    expect(sql0005).toMatch(
      /WHEN 'entity' THEN field_name IN \('display_name', 'canonical_name', 'entity_type'\)/,
    );
    for (const free of ["summary", "event_time_raw", "text", "canonical_name", "display_name"]) {
      expect(sql0005).not.toMatch(new RegExp(`WHEN '${free}' THEN json_type`));
    }
  });

  it("对账（T-16 手法）：0005 的三处枚举字面量 == enums.json 对应数组，逐项相等、顺序一致", () => {
    expect(gateList("event_time_precision")).toEqual(enums.event_time_precision);
    expect(gateList("event_time_certainty")).toEqual(enums.event_time_certainty);
    // 改向〔M3-DB-1，用户裁定 Q3〕：本行原本钉 `gateList("entity_type") == enums.entity_types`。
    // 0005 逐字冻结（sha256 守护），它的 entity_type 门就此成为**旧 7 值契约的字面档案**；
    // 现行值与迁移的比对已移到 0006 —— 见 tests/m3-db-1-entity8.test.ts 的同名对账。
    // 不是削弱：钉的是「0005 保持它当时的清单」，收紧的是它不许被悄悄改写。
    expect(gateList("entity_type")).toEqual([
      "person",
      "organization",
      "place",
      "work",
      "product",
      "game",
      "other",
    ]);
  });
});

// ── 整表重建的形态守门：现网表来自 0005，既有行与触发器都不丢 ────────

function readCell(table: string, column: string, id: string): unknown {
  return (db.prepare(`select ${column} as v from ${table} where id = ?`).get(id) as { v: unknown }).v;
}

describe("M2-2b 整表重建：0005 的落地形态", () => {
  it("现网 user_scalar_override 的表定义已含取值门（改名生效，不是 0004 的旧壳）", () => {
    const row = db
      .prepare("select sql from sqlite_master where type='table' and name='user_scalar_override'")
      .get() as { sql: string };
    expect(row.sql).toContain("json_type(value_json) = 'text'");
    expect(row.sql).toContain("'entity_type'");
  });

  it("结构守门：六个 ovo_ 触发器在册，且挂在正确的表上", () => {
    const rows = (
      db
        .prepare(
          "select name, tbl_name from sqlite_master where type='trigger' and name like 'ovo_%' order by name",
        )
        .all() as Array<{ name: string; tbl_name: string }>
    ).map((r) => [r.name, r.tbl_name] as const);
    expect(Object.fromEntries(rows)).toEqual({
      ovo_concept_ad: "concept",
      ovo_entity_ad: "entity",
      ovo_episode_ad: "episode",
      ovo_target_bi: "user_scalar_override",
      ovo_target_bu: "user_scalar_override",
      ovo_thought_ad: "thought_item",
    });
  });

  it("在既有行上重跑重建序列：行原样拷贝，触发器仍在册且仍生效", () => {
    const raw = readFileSync(MIGRATION_0005, "utf8");
    insertOverride("ovo_rb_prec", "episode", "ep_user", "event_time_precision", { value_json: '"month"' });
    insertOverride("ovo_rb_sum", "episode", "ep_user", "summary", { value_json: '"旧覆盖"' });
    insertOverride("ovo_rb_et", "entity", "entity_fixture_1", "entity_type", { value_json: '"organization"' });
    db.exec("begin immediate");
    try {
      db.exec(raw);
      expect(
        db
          .prepare(
            "select id, field_name, value_json from user_scalar_override where id like 'ovo_rb_%' order by id",
          )
          .all(),
      ).toEqual([
        { id: "ovo_rb_et", field_name: "entity_type", value_json: '"organization"' },
        { id: "ovo_rb_prec", field_name: "event_time_precision", value_json: '"month"' },
        { id: "ovo_rb_sum", field_name: "summary", value_json: '"旧覆盖"' },
      ]);
      // 重建后 ovo_entity_ad 仍指向新表：删目标 ⇒ 覆盖行一并清除，不留孤儿。
      db.prepare("delete from entity where id = 'entity_fixture_1'").run();
      expect(countWhere("user_scalar_override", "object_id = ?", "entity_fixture_1")).toBe(0);
    } finally {
      db.exec("rollback");
    }
  });

  it("可逆性：override 是投影，写入与删除都不回写基表", () => {
    attemptRollback(() => {
      expect(readCell("entity", "entity_type", "entity_fixture_1")).toBe("person");
      insertOverride("ovo_rev_et", "entity", "entity_fixture_1", "entity_type", { value_json: '"organization"' });
      expect(readCell("entity", "entity_type", "entity_fixture_1")).toBe("person");
      db.prepare("delete from user_scalar_override where id = 'ovo_rev_et'").run();
      expect(readCell("entity", "entity_type", "entity_fixture_1")).toBe("person");
    });
    attemptRollback(() => {
      expect(readCell("episode", "event_time_precision", "ep_user")).toBe("unknown");
      insertOverride("ovo_rev_ep", "episode", "ep_user", "event_time_precision", { value_json: '"day"' });
      expect(readCell("episode", "event_time_precision", "ep_user")).toBe("unknown");
      db.prepare("delete from user_scalar_override where id = 'ovo_rev_ep'").run();
      expect(readCell("episode", "event_time_precision", "ep_user")).toBe("unknown");
    });
  });
});
