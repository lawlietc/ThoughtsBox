import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { migrate } from "../src/server/db/migrator.ts";
import { RecordService } from "../src/server/records/service.ts";
import { makeSandbox, openSandboxDb, type Sandbox } from "./helpers/sandbox.ts";
import type { Database } from "../src/server/db/adapter.ts";

/**
 * 迁移层/契约测试（Schema 审查稿 §10：T-12/T-15/T-16/T-21(时间 CHECK 部分)/T-23/T-24/T-29/T-31 静态面）。
 * 这里只验证数据库自身的守门能力与「迁移 SQL ↔ enums.json 单一事实源」的一致性；
 * 行为面（空 diff、删除事务）在 m1a-records-service / m1a-deletion-two-phase 中已各自成测。
 */

const MIGRATION_FILE = "src/server/db/migrations/0002_records_and_search.sql";
const ENUMS_FILE = "src/shared/constants/enums.json";

let sandbox: Sandbox;
let db: Database;
let service: RecordService;

beforeEach(() => {
  sandbox = makeSandbox("tb-m1a-contract-");
  db = openSandboxDb(sandbox.layout);
  migrate(db);
  service = new RecordService(db, {
    timezoneId: "Asia/Shanghai",
    now: () => new Date("2026-10-12T06:30:00Z"),
  });
});

afterEach(() => {
  db.close();
  sandbox.cleanup();
});

const sql = readFileSync(MIGRATION_FILE, "utf8");
/** 静态扫描用去注释文本：头注与行注里引用被禁形态的字面量不参与守门断言。 */
const sqlCode = sql
  .split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join("\n");
const enums = JSON.parse(readFileSync(ENUMS_FILE, "utf8")) as Record<string, unknown>;

/** 抽取 `column IN ( 'a', 'b', … )` 的字面量序列（与迁移书写顺序无关的比较交给集合断言）。 */
function inList(column: string): string[] {
  const match = new RegExp(`${column} IN \\(([\\s\\S]*?)\\)`).exec(sql);
  if (match === null) throw new Error(`迁移 SQL 中未找到 ${column} IN (...) CHECK`);
  return [...match[1]!.matchAll(/'([^']*)'/g)].map((m) => m[1]!);
}

function defaultOf(column: string): string {
  const match = new RegExp(`${column} TEXT NOT NULL DEFAULT '([^']+)'`).exec(sql);
  if (match === null) throw new Error(`迁移 SQL 中未找到 ${column} 的 DEFAULT`);
  return match[1]!;
}

/** 在显式事务内执行一次写入并回滚：只为触发 CHECK（CHECK 是语句级即时错误）。 */
function attemptRollback(statement: () => void): void {
  db.exec("begin immediate");
  try {
    statement();
  } finally {
    db.exec("rollback");
  }
}

function recordInsert(overrides: Partial<Record<string, string>> = {}): void {
  const values = {
    id: "rec_probe_1",
    created_at_utc: "2026-10-12T06:30:00.000Z",
    created_at_local: "2026-10-12T14:30:00.000+08:00",
    timezone_id: "Asia/Shanghai",
    created_local_date: "2026-10-12",
    current_revision_id: "rev_probe_1",
    ...overrides,
  };
  db
    .prepare(
      `insert into capture_record (id, created_at_utc, created_at_local, timezone_id, created_local_date, current_revision_id)
       values (@id, @created_at_utc, @created_at_local, @timezone_id, @created_local_date, @current_revision_id)`,
    )
    .run(values);
}

function revisionInsert(overrides: Partial<Record<string, string | number>> = {}): void {
  const values = {
    id: "rev_probe_1",
    record_id: "rec_probe_1",
    revision_number: 1,
    raw_text: "探针原文",
    content_sha256: "a".repeat(64),
    tokens: "探针",
    created_at_utc: "2026-10-12T06:30:00.000Z",
    created_at_local: "2026-10-12T14:30:00.000+08:00",
    timezone_id: "Asia/Shanghai",
    ...overrides,
  };
  db
    .prepare(
      `insert into record_revision (id, record_id, revision_number, raw_text, content_sha256, tokens,
                                    created_at_utc, created_at_local, timezone_id)
       values (@id, @record_id, @revision_number, @raw_text, @content_sha256, @tokens,
               @created_at_utc, @created_at_local, @timezone_id)`,
    )
    .run(values);
}

describe("T-16：迁移 SQL 枚举字面量与 enums.json 逐项 diff 为空", () => {
  it("processing_status / processing_mode / privacy_level 三组 IN 集合与枚举源完全一致", () => {
    expect(new Set(inList("processing_status"))).toEqual(new Set(enums.processing_statuses as string[]));
    expect(inList("processing_status")).toEqual(enums.processing_statuses as string[]);
    expect(inList("processing_mode")).toEqual(enums.processing_modes as string[]);
    expect(inList("privacy_level")).toEqual(enums.privacy_levels as string[]);
  });

  it("三列 DEFAULT 值都是合法枚举成员，且与规格缺省一致", () => {
    expect(defaultOf("processing_status")).toBe("captured");
    expect(defaultOf("processing_mode")).toBe("manual_only");
    expect(defaultOf("privacy_level")).toBe("normal");
    expect(enums.processing_statuses).toContain(defaultOf("processing_status"));
    expect(enums.processing_modes).toContain(defaultOf("processing_mode"));
    expect(enums.privacy_levels).toContain(defaultOf("privacy_level"));
  });

  it("deletion_audit.object_type 封闭集为 17 个业务对象表名，不含修正层/虚表/审计自身", () => {
    const list = inList("object_type");
    expect(list).toHaveLength(17);
    expect(list).toContain("capture_record");
    expect(list).toContain("record_revision");
    for (const forbidden of [
      "user_scalar_override",
      "user_collection_patch",
      "record_fts",
      "deletion_audit",
      "app_meta",
    ]) {
      expect(list).not.toContain(forbidden);
    }
  });
});

describe("T-15：id 前缀 CHECK", () => {
  it("capture_record 拒绝非 rec_ 前缀", () => {
    expect(() => attemptRollback(() => recordInsert({ id: "cat_probe_1" }))).toThrow(/CHECK/);
    expect(() => attemptRollback(() => recordInsert({ id: "record_probe" }))).toThrow(/CHECK/);
  });

  it("record_revision 拒绝非 rev_ 前缀", () => {
    expect(() => attemptRollback(() => revisionInsert({ id: "rr_probe_1" }))).toThrow(/CHECK/);
  });

  it("deletion_audit 拒绝非 del_ 前缀", () => {
    expect(() =>
      attemptRollback(() =>
        db
          .prepare(
            `insert into deletion_audit (id, object_type, object_id, deleted_at_utc, executor, affected)
             values ('aud_x', 'capture_record', 'rec_ghost', '2026-10-12T06:30:00.000Z', 'user', '{}')`,
          )
          .run(),
      ),
    ).toThrow(/CHECK/);
  });

  it("B12 静态面：capture_record 不含 sleep_session_id 列", () => {
    const cols = db.prepare("pragma table_info(capture_record)").all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).not.toContain("sleep_session_id");
  });
});

describe("T-21（时间格式面）与 T-23（哈希面）：CHECK 三类拒绝", () => {
  it("utc 时间必须是 Z 结尾的可解析时刻", () => {
    expect(() => attemptRollback(() => recordInsert({ created_at_utc: "2026-10-12T06:30:00.000+08:00" }))).toThrow(/CHECK/);
    expect(() => attemptRollback(() => recordInsert({ created_at_utc: "不是时间" }))).toThrow(/CHECK/);
  });

  it("local 时间必须带 Z 或 ±HH:MM 偏移", () => {
    expect(() => attemptRollback(() => recordInsert({ created_at_local: "2026-10-12T06:30:00" }))).toThrow(/CHECK/);
    // 负偏移合法：事务内执行成功再回滚（无 CHECK 抛错即通过）。
    expect(() => attemptRollback(() => recordInsert({ created_at_local: "2026-10-12T01:30:00.000-05:00" }))).not.toThrow();
  });

  it("created_local_date 必须形如 YYYY-MM-DD 且可被 strftime 解析", () => {
    expect(() => attemptRollback(() => recordInsert({ created_local_date: "2026-10-12" }))).not.toThrow();
    expect(() => attemptRollback(() => recordInsert({ created_local_date: "20261012" }))).toThrow(/CHECK/);
    expect(() => attemptRollback(() => recordInsert({ created_local_date: "2026-13-01" }))).toThrow(/CHECK/);
  });

  it("content_sha256：63 位、大写、非 hex 三类被拒，64 位小写 hex 通过", () => {
    expect(() => attemptRollback(() => revisionInsert({ content_sha256: "a".repeat(63) }))).toThrow(/CHECK/);
    expect(() => attemptRollback(() => revisionInsert({ content_sha256: "A".repeat(64) }))).toThrow(/CHECK/);
    expect(() => attemptRollback(() => revisionInsert({ content_sha256: `${"a".repeat(63)}g` }))).toThrow(/CHECK/);
    // 正例需要真实父记录（record_id 是即时效验 FK），哈希列本身无 CHECK 抛错即通过。
    const host = service.createRecord("哈希正例宿主").record;
    expect(() =>
      attemptRollback(() =>
        revisionInsert({
          record_id: host.id,
          revision_number: 2,
          content_sha256: "0123456789abcdef".repeat(4),
        }),
      ),
    ).not.toThrow();
  });

  it("revision_number 必须为正整数；空原文被拒", () => {
    expect(() => attemptRollback(() => revisionInsert({ revision_number: 0 }))).toThrow(/CHECK/);
    expect(() => attemptRollback(() => revisionInsert({ raw_text: "" }))).toThrow(/CHECK/);
  });

  it("executor 只允许 'user'；affected 必须是合法 JSON", () => {
    const audit = (executor: string, affected: string): void => {
      db
        .prepare(
          `insert into deletion_audit (id, object_type, object_id, deleted_at_utc, executor, affected)
           values ('del_probe', 'capture_record', 'rec_ghost', '2026-10-12T06:30:00.000Z', @e, @a)`,
        )
        .run({ e: executor, a: affected });
    };
    expect(() => attemptRollback(() => audit("system", "{}"))).toThrow(/CHECK/);
    expect(() => attemptRollback(() => audit("user", "不是JSON"))).toThrow(/CHECK/);
    expect(() => attemptRollback(() => audit("user", "{\"revisions\":1}"))).not.toThrow();
  });
});

describe("T-12：版本只增不改写；current 指向他人 revision 被复合 FK 拒绝（P2b）", () => {
  it("编辑只增 revision，旧行逐字段字节不变", () => {
    const { record } = service.createRecord("第一段原文");
    service.editRecord(record.id, "第二段原文");
    const before = JSON.stringify(
      db.prepare("select rowid, * from record_revision order by rowid").all(),
    );
    service.editRecord(record.id, "第三段原文");
    const after = JSON.parse(
      JSON.stringify(db.prepare("select rowid, * from record_revision order by rowid").all()),
    ) as Array<Record<string, unknown>>;
    const beforeRows = JSON.parse(before) as Array<Record<string, unknown>>;
    expect(after).toHaveLength(3);
    expect(JSON.stringify(after.slice(0, 2))).toBe(JSON.stringify(beforeRows));
    // 旧行未被 UPDATE 触碰的独立证据：record_au 触发器一次都没因编辑执行过——
    // 索引行数 == revision 行数（若有改写会先删后插，但内容行字节必须原样）。
    expect(after[0]!.raw_text).toBe("第一段原文");
    expect(after[1]!.raw_text).toBe("第二段原文");
  });

  it("current_revision_id 指向另一记录的 revision：commit 时被 deferred 复合 FK 拒绝", () => {
    const mine = service.createRecord("我的记录");
    const other = service.createRecord("别的记录");
    db.exec("begin immediate");
    db
      .prepare("update capture_record set current_revision_id = ? where id = ?")
      .run(other.revision.id, mine.record.id);
    expect(() => db.exec("commit")).toThrow(/FOREIGN KEY/);
    db.exec("rollback");
    // 回滚后现场不变。
    expect(service.getRecord(mine.record.id).current.id).toBe(mine.revision.id);
  });

  it("同一记录内 revision_number 唯一，重复建版被拒", () => {
    const { record, revision } = service.createRecord("唯一性探针");
    expect(() =>
      attemptRollback(() =>
        revisionInsert({
          id: "rev_dup",
          record_id: record.id,
          revision_number: revision.revision_number,
        }),
      ),
    ).toThrow(/UNIQUE/);
  });
});

describe("T-24：审计表无 FK（幽灵 object_id 可写）+ 静态无业务外键", () => {
  it("object_id 指向不存在对象仍可写入（删除事实先于对象存在性）", () => {
    db
      .prepare(
        `insert into deletion_audit (id, object_type, object_id, deleted_at_utc, executor, affected)
         values ('del_ghost_1', 'episode', 'epo_并不存在', '2026-10-12T06:30:00.000Z', 'user', '{}')`,
      )
      .run();
    const row = db
      .prepare("select object_id from deletion_audit where id = 'del_ghost_1'")
      .get() as { object_id: string };
    expect(row.object_id).toBe("epo_并不存在");
  });

  it("迁移 SQL 的 deletion_audit 定义不含任何 FOREIGN KEY 子句", () => {
    const start = sqlCode.indexOf("CREATE TABLE deletion_audit");
    expect(start).toBeGreaterThanOrEqual(0);
    const body = sqlCode.slice(start);
    expect(body).not.toMatch(/FOREIGN KEY/);
  });
});

describe("T-29：FTS 列集合契约 + 迁移 SQL 禁止引号形态 fts5 选项", () => {
  it("record_fts 的列集合恰为 {tokens}（垃圾列守门）", () => {
    const cols = db.prepare("pragma table_info(record_fts)").all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).toEqual(["tokens"]);
  });

  it("fts5(...) 子句只含 external-content 两项配置，且无任何选项关键字", () => {
    const start = sqlCode.indexOf("USING fts5(");
    expect(start).toBeGreaterThanOrEqual(0);
    const clause = sqlCode.slice(start + "USING fts5(".length, sqlCode.indexOf(")", start));
    expect(clause).toContain("content='record_revision'");
    expect(clause).toContain("content_rowid='rowid'");
    expect(clause).not.toMatch(
      /\b(tokenize|unindexed|prefix|porter|remove_diacritics|collate|secure_delete)\b/i,
    );
  });

  it("三触发器齐备且使用 'delete' 命令形态（external-content 清理协议）", () => {
    const triggers = (
      db.prepare("select name, sql from sqlite_master where type = 'trigger'").all() as Array<{
        name: string;
        sql: string;
      }>
    ).filter((t) => t.name.startsWith("record_"));
    expect(triggers.map((t) => t.name).sort()).toEqual(["record_ad", "record_ai", "record_au"]);
    for (const name of ["record_ad", "record_au"]) {
      const t = triggers.find((x) => x.name === name)!;
      expect(t.sql).toMatch(/values\s*\(\s*'delete'/i);
    }
  });
});

describe("T-31/B13 静态面：DB 不设 UNIQUE(record_id, content_sha256)", () => {
  it("迁移 SQL 与运行时索引集合中都不存在该唯一约束", () => {
    expect(sqlCode).not.toMatch(/UNIQUE\s*\(\s*record_id\s*,\s*content_sha256\s*\)/i);
    const indexes = db
      .prepare("select name, sql from sqlite_master where type = 'index' and tbl_name = 'record_revision'")
      .all() as Array<{ name: string; sql: string | null }>;
    for (const idx of indexes) {
      expect(idx.sql ?? "").not.toMatch(/content_sha256/);
    }
    // 同文重复版本在 DB 层必须容许（应用层空 diff 拒绝是服务职责，已另行成测）。
    const { record } = service.createRecord("重复文本探针");
    expect(() =>
      attemptRollback(() =>
        revisionInsert({
          id: "rev_same_text",
          record_id: record.id,
          revision_number: 2,
          raw_text: "重复文本探针",
          content_sha256: "b".repeat(64),
        }),
      ),
    ).not.toThrow();
  });
});
