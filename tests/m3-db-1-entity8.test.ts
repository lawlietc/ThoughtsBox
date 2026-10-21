import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MIGRATIONS_DIR, migrate } from "../src/server/db/migrator.ts";
import { openSandboxDb, makeSandbox, type Sandbox } from "./helpers/sandbox.ts";
import type { Database } from "../src/server/db/adapter.ts";

/**
 * M3-DB-1 · 实体大类 8 类落地〔用户裁定 Q3，2026-10-14〕。
 *
 * 本文件承接上一轮三处断言改向里指向的「现行 8 值与迁移的对账」，并把 0006 整表重建的
 * 行为面钉死。三件事，各自独立：
 *   1. 静态对账（T-16 手法，见 m2-schema-contract / m2-correction 先例）：0006 的
 *      `entity` 表定义与 `user_scalar_override` 取值门里 `entity_type` 的字面量清单，
 *      逐项等于 `enums.json` 的 `entity_types`，且顺序一致。迁移里不许各说各话。
 *   2. 行为面：走应用自带 migrator 跑 0001→0006（沙箱临时目录），断言 8 值全部可写入、
 *      第 9 个值（含被并入的 'game'）被 CHECK 拒、重建后 PRAGMA foreign_key_check 为空。
 *   3. 存量归一：先在 0005 的 7 值态下写入一条 'game' 实体与一条 'game' override，再让
 *      真 migrator 应用 0006 —— 两者都归一为 'work'。这是 Q3 裁定「game 并入 work」的 DB 面证据。
 *
 * 只回答一个问题：**数据库自己守不守得住**。服务层再怎么错，8 值之外的 entity_type
 * 都不许落库；存量 game 不许在新 CHECK 下把整份迁移顶翻（那会现网升不上去）。
 */

const ENUMS_FILE = "src/shared/constants/enums.json";
const MIGRATION_0006 = join(MIGRATIONS_DIR, "0006_entity_types_v2.sql");

const NOW = "2026-10-13T06:30:00.000Z";

const enums = JSON.parse(readFileSync(ENUMS_FILE, "utf8")) as { entity_types: string[] };

/** 静态扫描用去注释文本：头注里引用旧 7 值 / game 的字面量不参与对账断言。 */
function stripComments(source: string): string {
  return source
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
}

const sql0006 = stripComments(readFileSync(MIGRATION_0006, "utf8"));

/**
 * 抽 `entity` 表定义处的 `entity_type … CHECK ( entity_type IN ( … ) )` 字面量清单（含顺序）。
 * 与 m2-schema-contract 的 definitionList 同一形态；`[^C]*` 卡在列定义与其 CHECK 之间
 * （NOT NULL 里没有大写 C），只命中 entity 表这一处，不碰 override 的取值门。
 */
function entityDefinitionList(): string[] {
  const match = /entity_type TEXT[^C]*CHECK \(\s*entity_type IN \(([\s\S]*?)\)/.exec(sql0006);
  if (match === null) throw new Error("0006 中未找到 entity 表的 entity_type IN (...) 定义 CHECK");
  return [...match[1]!.matchAll(/'([^']*)'/g)].map((m) => m[1]!);
}

/**
 * 抽 `user_scalar_override` 取值门里 `WHEN 'entity_type' THEN … IN ( … )` 的清单（含顺序）。
 * 与 m2-correction 的 gateList 同一 NULL 安全形态：先 json_type='text' 再比字面量。
 */
function overrideGateList(): string[] {
  const pattern =
    /WHEN 'entity_type' THEN json_type\(value_json\) = 'text' AND json_extract\(value_json, '\$'\) IN \(([\s\S]*?)\)/;
  const match = pattern.exec(sql0006);
  if (match === null) throw new Error("0006 取值门中未找到 entity_type 的 IN (...) 清单");
  return [...match[1]!.matchAll(/'([^']*)'/g)].map((m) => m[1]!);
}

/** 具名列写入：STRICT 表不做类型强转，值形态必须由调用方给对（沿用既有夹具手法）。 */
function run(db: Database, table: string, values: Record<string, unknown>): void {
  const cols = Object.keys(values);
  db.prepare(
    `insert into ${table} (${cols.join(", ")}) values (${cols.map((c) => `@${c}`).join(", ")})`,
  ).run(values as Record<string, string | number | bigint | null | Uint8Array>);
}

function insertEntity(db: Database, id: string, entityType: string, name: string): void {
  run(db, "entity", {
    id,
    entity_type: entityType,
    canonical_name: name,
    display_name: name,
    lifecycle_status: "provisional",
    privacy_level: "normal",
    origin_type: "ai_generated",
    created_at_utc: NOW,
  });
}

function insertEntityTypeOverride(db: Database, id: string, entityId: string, valueJson: string): void {
  run(db, "user_scalar_override", {
    id,
    object_table: "entity",
    object_id: entityId,
    field_name: "entity_type",
    value_json: valueJson,
    updated_at_utc: NOW,
  });
}

function readEntityColumn(db: Database, id: string): string {
  const row = db.prepare(`select entity_type as v from entity where id = ?`).get(id) as { v: string };
  return row.v;
}

function readOverrideValue(db: Database, id: string): string {
  const row = db.prepare(`select value_json as v from user_scalar_override where id = ?`).get(id) as { v: string };
  return row.v;
}

/** 探一条写入是否被拒：无论成败都回滚，现场不留（与 m2-correction 同法）。 */
function expectRejected(db: Database, statement: () => void, pattern: RegExp): void {
  let thrown: Error | undefined;
  db.exec("BEGIN IMMEDIATE");
  try {
    statement();
  } catch (cause) {
    thrown = cause as Error;
  } finally {
    db.exec("ROLLBACK");
  }
  if (thrown === undefined) throw new Error(`期望被 ${pattern} 拒绝，但写入成功了`);
  expect(thrown.message).toMatch(pattern);
}

/* ── 1. 静态对账：0006 == enums.json（逐项、同序） ───────────────────── */

describe("M3-DB-1 静态对账（T-16 手法）：0006 的两处 entity_type 清单 == enums.json 同序", () => {
  it("entity 表定义 CHECK 的 8 值逐项等于 enums.entity_types、顺序一致", () => {
    expect(entityDefinitionList()).toEqual(enums.entity_types);
  });

  it("user_scalar_override 取值门的 entity_type 8 值逐项等于 enums.entity_types、顺序一致", () => {
    expect(overrideGateList()).toEqual(enums.entity_types);
  });

  it("对账基线本身成立：8 值、不含 game、含 activity / event", () => {
    expect(enums.entity_types).toEqual([
      "person",
      "organization",
      "place",
      "work",
      "product",
      "activity",
      "event",
      "other",
    ]);
    expect(enums.entity_types).not.toContain("game");
    expect(entityDefinitionList()).not.toContain("game");
    expect(overrideGateList()).not.toContain("game");
  });
});

/* ── 2. 行为面：0001→0006 落地后的 CHECK 与 FK 面 ───────────────────── */

describe("M3-DB-1 行为面：0006 落地后的取值门", () => {
  let sandbox: Sandbox;
  let db: Database;

  beforeEach(() => {
    sandbox = makeSandbox("tb-m3-db1-");
    db = openSandboxDb(sandbox.layout);
    migrate(db);
  });

  afterEach(() => {
    db.close();
    sandbox.cleanup();
  });

  it("8 值全部可写入 entity", () => {
    for (const [index, type] of enums.entity_types.entries()) {
      expect(() => insertEntity(db, `entity_t_${index}_${type}`, type, `实体 ${type}`)).not.toThrow();
    }
    for (const [index, type] of enums.entity_types.entries()) {
      expect(readEntityColumn(db, `entity_t_${index}_${type}`)).toBe(type);
    }
  });

  it("8 值全部可作为 entity_type 修正写入取值门", () => {
    // override 按 (object_table, object_id, field_name) 唯一，故每个取值各配一个目标实体。
    for (const type of enums.entity_types) {
      const target = `entity_gate_${type}`;
      insertEntity(db, target, "person", `闸门目标 ${type}`);
      expect(() => insertEntityTypeOverride(db, `ovo_gate_${type}`, target, `"${type}"`)).not.toThrow();
      expect(readOverrideValue(db, `ovo_gate_${type}`)).toBe(`"${type}"`);
    }
  });

  it("第 9 个值（含被并入的 'game' 与编造值）被 entity CHECK 拒绝", () => {
    for (const bad of ["game", "宠物", "person "]) {
      expectRejected(
        db,
        () => insertEntity(db, `entity_bad_${bad}`, bad, "非法实体"),
        /CHECK constraint failed/,
      );
    }
  });

  it("取值门同样拒绝 entity_type = game", () => {
    insertEntity(db, "entity_gate_bad_target", "person", "闸门目标");
    expectRejected(
      db,
      () => insertEntityTypeOverride(db, "ovo_bad_game", "entity_gate_bad_target", '"game"'),
      /CHECK constraint failed/,
    );
  });

  it("重建后 PRAGMA foreign_key_check 为空", () => {
    const row = db.prepare("select count(*) as n from pragma_foreign_key_check").get() as { n: number };
    expect(row.n).toBe(0);
  });
});

/* ── 3. 存量归一：0005 的 game 行经真 migrator 应用 0006 → work ─────── */

describe("M3-DB-1 存量归一：走应用自带 migrator 跑 0001→0006，game 并入 work", () => {
  // 0001–0005 的文件名（不含 0006）：阶段一只应用这些，落 7 值态。
  const PARTIAL = [
    "0001_bootstrap.sql",
    "0002_records_and_search.sql",
    "0003_derived_layer.sql",
    "0004_correction_layer.sql",
    "0005_override_value_gate.sql",
  ];

  it("存量 entity_type='game' 的实体行与 override 都被归一为 'work'", () => {
    const sandbox = makeSandbox("tb-m3-db1-stage-");
    const staging = mkdtempSync(join(tmpdir(), "tb-m3-db1-mig-"));
    const db = openSandboxDb(sandbox.layout);
    try {
      // 阶段一：只放 0001–0005 的逐字节副本进临时迁移目录，用真 migrator 跑到 7 值态。
      for (const file of PARTIAL) copyFileSync(join(MIGRATIONS_DIR, file), join(staging, file));
      migrate(db, staging);
      expect(migrate(db, staging).schemaVersion).toBe(5); // 幂等：无待应用项

      // 在 7 值态下写入一条 game 实体 + 一条 game override（此时都合法）。
      insertEntity(db, "entity_legacy_game", "game", "某款游戏");
      insertEntityTypeOverride(db, "ovo_legacy_game", "entity_legacy_game", '"game"');
      expect(readEntityColumn(db, "entity_legacy_game")).toBe("game");

      // 阶段二：把 0006 也放进同一临时目录，让它经应用自带 migrator（BEGIN IMMEDIATE + FK 守卫）落地。
      // 〔DB-2 适配·非改向〕此处原为 `migrate(db, MIGRATIONS_DIR)`；真实目录在 DB-2 后含 0007，
      // 「恰好落到 schema v6」必然不再成立。本条钉的是 **0006 单独落地时归一 game**，故把阶段二
      // 逐字补到 0006 为止——两条断言（toBe(6) / toEqual(["entity_types_v2"])）一字未动，不是削弱。
      // 0006→0007 的组合面由 `m3-db-2-schema-backfill.test.ts` 的两段式测试负责。
      copyFileSync(join(MIGRATIONS_DIR, "0006_entity_types_v2.sql"), join(staging, "0006_entity_types_v2.sql"));
      const result = migrate(db, staging);
      expect(result.schemaVersion).toBe(6);
      expect(result.applied.map((f) => f.name)).toEqual(["entity_types_v2"]);

      // 归一证据：实体行与 override 都从 game 落成 work，不残留 game。
      expect(readEntityColumn(db, "entity_legacy_game")).toBe("work");
      expect(readOverrideValue(db, "ovo_legacy_game")).toBe('"work"');

      // 迁移后 game 不可再写入（新 CHECK 生效）。
      expectRejected(
        db,
        () => insertEntity(db, "entity_after_game", "game", "再来一个游戏"),
        /CHECK constraint failed/,
      );
      // 重建未破坏外键面。
      const fk = db.prepare("select count(*) as n from pragma_foreign_key_check").get() as { n: number };
      expect(fk.n).toBe(0);
    } finally {
      db.close();
      rmSync(staging, { recursive: true, force: true });
      sandbox.cleanup();
    }
  });
});
