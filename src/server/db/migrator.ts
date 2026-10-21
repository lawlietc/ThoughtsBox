import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import type { Database } from "./adapter.ts";

export const MIGRATIONS_DIR = join(import.meta.dirname, "migrations");

const FILE_PATTERN = /^(\d{4})_([a-z0-9_]+)\.sql$/;

export interface MigrationFile {
  readonly version: number;
  readonly name: string;
  readonly path: string;
  readonly sql: string;
  readonly sha256: string;
}

export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrationError";
  }
}

export function listMigrationFiles(dir = MIGRATIONS_DIR): MigrationFile[] {
  const entries = readdirSync(dir)
    .filter((file) => FILE_PATTERN.test(file))
    .sort();
  const seen = new Map<number, string>();
  const files: MigrationFile[] = [];
  for (const entry of entries) {
    const match = FILE_PATTERN.exec(entry)!;
    const version = Number(match[1]);
    const previous = seen.get(version);
    if (previous !== undefined) {
      throw new MigrationError(`迁移版本号冲突：${entry} 与 ${previous}`);
    }
    seen.set(version, entry);
    const sql = readFileSync(join(dir, entry), "utf8");
    files.push({
      version,
      name: match[2]!,
      path: join(dir, entry),
      sql,
      sha256: createHash("sha256").update(sql.normalize("NFC")).digest("hex"),
    });
  }
  if (files.length === 0) {
    throw new MigrationError(`迁移目录为空：${dir}`);
  }
  if (files[0]!.version !== 1) {
    throw new MigrationError(`迁移必须从 0001 开始，实际首个版本为 ${files[0]!.version}`);
  }
  return files;
}

export function tableExists(db: Database, name: string): boolean {
  const row = db
    .prepare("select count(*) as n from sqlite_master where type = 'table' and name = ?")
    .get(name) as { n: number };
  return row.n > 0;
}

export function currentSchemaVersion(db: Database): number {
  if (!tableExists(db, "schema_migrations")) return 0;
  const row = db.prepare("select coalesce(max(version), 0) as v from schema_migrations").get() as {
    v: number;
  };
  return row.v;
}

interface AppliedRow {
  version: number;
  name: string;
  sha256: string;
}

function readApplied(db: Database): Map<number, AppliedRow> {
  if (!tableExists(db, "schema_migrations")) return new Map();
  const rows = db
    .prepare("select version, name, sha256 from schema_migrations order by version")
    .all() as unknown as AppliedRow[];
  return new Map(rows.map((row) => [row.version, row]));
}

export interface MigrationResult {
  readonly applied: MigrationFile[];
  readonly schemaVersion: number;
}

/**
 * 迁移机制（M0 交付物 4）：逐份在事务中执行，失败回滚并抛出——绝不留下半迁移的库。
 * 已应用的版本还会做 sha256 漂移检查：改了历史迁移文件不等于改了现状，必须报错而非假装一致。
 */
export function migrate(db: Database, dir = MIGRATIONS_DIR): MigrationResult {
  const files = listMigrationFiles(dir);
  const appliedRows = readApplied(db);

  for (const file of files) {
    const recorded = appliedRows.get(file.version);
    if (recorded === undefined) continue;
    if (recorded.sha256 !== file.sha256) {
      throw new MigrationError(
        `已应用的迁移 ${file.version}_${recorded.name} 内容与记录不一致。\n  期望 sha256：${recorded.sha256}\n  实际 sha256：${file.sha256}\n  历史迁移不可改写，请新增一份迁移。`,
      );
    }
  }

  const applied: MigrationFile[] = [];
  for (const file of files) {
    if (appliedRows.has(file.version)) continue;
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(file.sql);
      db.prepare(
        "insert into schema_migrations (version, name, sha256, applied_at) values (?, ?, ?, ?)",
      ).run(file.version, file.name, file.sha256, new Date().toISOString());
      db.exec("COMMIT");
    } catch (cause) {
      db.exec("ROLLBACK");
      throw new MigrationError(
        `迁移 ${file.version}_${file.name} 失败，已回滚：${(cause as Error).message}`,
      );
    }
    applied.push(file);
  }

  db.exec("PRAGMA foreign_key_check");
  return { applied, schemaVersion: currentSchemaVersion(db) };
}

export function setMeta(db: Database, key: string, value: string): void {
  db.prepare(
    `insert into app_meta (key, value, updated_at) values (?, ?, ?)
     on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value, new Date().toISOString());
}

export function getMeta(db: Database, key: string): string | undefined {
  if (!tableExists(db, "app_meta")) return undefined;
  const row = db.prepare("select value from app_meta where key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

/** 删除一个 app_meta 键（不存在即空操作）。用于记录硬删除时清掉其预览缓存残行（K-09 不留痕）。 */
export function deleteMeta(db: Database, key: string): void {
  if (!tableExists(db, "app_meta")) return;
  db.prepare("delete from app_meta where key = ?").run(key);
}
