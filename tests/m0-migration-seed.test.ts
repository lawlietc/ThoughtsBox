import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  currentSchemaVersion,
  listMigrationFiles,
  MigrationError,
  migrate,
  tableExists,
} from "../src/server/db/migrator.ts";
import { countSeedWatermark, seedVocabulary } from "../src/server/db/seed.ts";
import { makeSandbox, openSandboxDb, countRows, type Sandbox } from "./helpers/sandbox.ts";

let sandbox: Sandbox;

beforeEach(() => {
  sandbox = makeSandbox("tb-migration-");
});

afterEach(() => {
  sandbox.cleanup();
});

function bootstrapSql(): string {
  return readFileSync(listMigrationFiles()[0]!.path, "utf8");
}

/**
 * 这三份清单是**刻意的硬编码**：新增一个迁移文件必须同时改这里，
 * 否则「迁移到底改成了什么形状」就退化成自证。E-05 授权的同步点就是这个动作。
 */
const MIGRATION_NAMES = [
  "bootstrap",
  "records_and_search",
  "derived_layer",
  "correction_layer",
  "override_value_gate",
  "entity_types_v2",
  "schema_backfill_m2_debt",
] as const;
const CURRENT_SCHEMA_VERSION = MIGRATION_NAMES.length;
const EXPECTED_TABLES = [
  "app_meta",
  "capture_record",
  "cloud_send_grant",
  "concept",
  "concept_alias",
  "deletion_audit",
  "emotion_mention",
  "entity",
  "entity_alias",
  "entity_mention",
  "episode",
  "graph_edge",
  "parse_run",
  "record_fts",
  "record_fts_config",
  "record_fts_data",
  "record_fts_docsize",
  "record_fts_idx",
  "record_revision",
  "schema_migrations",
  "suggestion",
  "thought_item",
  "topic_mention",
  "trigger_assertion",
  "user_collection_patch",
  "user_scalar_override",
  "vocab_seed_watermark",
] as const;

describe("迁移机制（M0 交付物 4）", () => {
  it("空库执行迁移到当前 schema，引导层三表全部建立", () => {
    const db = openSandboxDb(sandbox.layout);
    try {
      const result = migrate(db);
      expect(result.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
      expect(result.applied.map((file) => file.name)).toEqual([...MIGRATION_NAMES]);
      expect(tableExists(db, "schema_migrations")).toBe(true);
      expect(tableExists(db, "app_meta")).toBe(true);
      expect(tableExists(db, "vocab_seed_watermark")).toBe(true);
    } finally {
      db.close();
    }
  });

  // E-05：表集合断言随每个里程碑同步（M1=0002，M2=0003）——唯一允许的「测试随 schema 演进」点。
  // record_fts_* 四张是 external-content FTS5 虚表的影子表，列集合由 T-29 契约测试单独守。
  it("表集合恰好等于当前里程碑预期，不提前写入未来里程碑的业务表", () => {
    const db = openSandboxDb(sandbox.layout);
    try {
      migrate(db);
      const tables = (
        db.prepare("select name from sqlite_master where type='table' order by name").all() as unknown as {
          name: string;
        }[]
      ).map((row) => row.name);
      expect([...tables].sort()).toEqual([...EXPECTED_TABLES].sort());
    } finally {
      db.close();
    }
  });

  it("重复执行不重复迁移，也不重复初始化", () => {
    const db = openSandboxDb(sandbox.layout);
    try {
      const first = migrate(db);
      const second = migrate(db);
      expect(first.applied).toHaveLength(CURRENT_SCHEMA_VERSION);
      expect(second.applied).toHaveLength(0);
      expect(countRows(db, "schema_migrations")).toBe(CURRENT_SCHEMA_VERSION);
      expect(currentSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
    } finally {
      db.close();
    }
  });

  it("迁移失败回滚：库里不留半迁移状态，版本号也不前进", () => {
    const dir = mkdtempSync(join(tmpdir(), "tb-migrations-bad-"));
    try {
      writeFileSync(join(dir, "0001_bootstrap.sql"), bootstrapSql(), "utf8");
      writeFileSync(
        join(dir, "0002_broken.sql"),
        "create table good(x text); insert into good values ('a'); this is not sql;",
        "utf8",
      );
      const db = openSandboxDb(sandbox.layout);
      try {
        expect(() => migrate(db, dir)).toThrow(MigrationError);
        expect(tableExists(db, "good")).toBe(false);
        expect(currentSchemaVersion(db)).toBe(1);
      } finally {
        db.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("改写历史迁移文件被识别为漂移，而不是假装一致", () => {
    const dir = mkdtempSync(join(tmpdir(), "tb-migrations-drift-"));
    try {
      writeFileSync(join(dir, "0001_bootstrap.sql"), bootstrapSql(), "utf8");
      const db = openSandboxDb(sandbox.layout);
      try {
        migrate(db, dir);
        writeFileSync(join(dir, "0001_bootstrap.sql"), `${bootstrapSql()}\n-- 悄悄改一行`, "utf8");
        expect(() => migrate(db, dir)).toThrow(/内容与记录不一致/);
      } finally {
        db.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("版本号冲突直接拒绝，不靠排序猜顺序", () => {
    const dir = mkdtempSync(join(tmpdir(), "tb-migrations-dup-"));
    try {
      writeFileSync(join(dir, "0001_a.sql"), "create table x1(a);", "utf8");
      writeFileSync(join(dir, "0001_b.sql"), "create table x2(a);", "utf8");
      expect(() => listMigrationFiles(dir)).toThrow(/版本号冲突/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("词表播种器（幂等）", () => {
  it("重复运行 3 次，行数不变", () => {
    const db = openSandboxDb(sandbox.layout);
    try {
      migrate(db);
      const first = seedVocabulary(db);
      expect(first.inserted).toBe(first.concepts + first.aliases);
      const second = seedVocabulary(db);
      const third = seedVocabulary(db);
      expect(second.inserted).toBe(0);
      expect(second.changed).toBe(0);
      expect(third.inserted).toBe(0);
      expect(countSeedWatermark(db)).toBe(first.concepts + first.aliases);
      expect(countRows(db, "vocab_seed_watermark")).toBe(first.concepts + first.aliases);
    } finally {
      db.close();
    }
  });

  it("播种的是 36 情绪 + 18 主题，别名模式取值合法", () => {
    const db = openSandboxDb(sandbox.layout);
    try {
      migrate(db);
      seedVocabulary(db);
      const byKind = db
        .prepare(
          "select kind, count(*) as n from vocab_seed_watermark where entry_kind='concept' group by kind",
        )
        .all() as unknown as { kind: string; n: number }[];
      expect(Object.fromEntries(byKind.map((row) => [row.kind, row.n]))).toEqual({
        emotion: 36,
        topic: 18,
      });
      const modes = db
        .prepare("select distinct alias_mode from vocab_seed_watermark where alias_mode is not null")
        .all() as unknown as { alias_mode: string }[];
      expect(modes.map((row) => row.alias_mode).sort()).toEqual(["auto", "suggest"]);
    } finally {
      db.close();
    }
  });

  it("确定性 ID：一个标准名只对应一个 concept_id，前缀为 concept_seed_", () => {
    const db = openSandboxDb(sandbox.layout);
    try {
      migrate(db);
      const summary = seedVocabulary(db);
      const distinct = db
        .prepare("select count(distinct concept_id) as n from vocab_seed_watermark")
        .get() as { n: number };
      expect(distinct.n).toBe(summary.concepts);
      const bad = db
        .prepare("select count(*) as n from vocab_seed_watermark where concept_id not like 'concept_seed_%'")
        .get() as { n: number };
      expect(bad.n).toBe(0);
    } finally {
      db.close();
    }
  });

  it("契约指纹写入 app_meta，供管线身份核对", () => {
    const db = openSandboxDb(sandbox.layout);
    try {
      migrate(db);
      const summary = seedVocabulary(db);
      const row = db
        .prepare("select value from app_meta where key='contracts_fingerprint'")
        .get() as { value: string };
      expect(row.value).toBe(summary.fingerprint);
    } finally {
      db.close();
    }
  });
});
