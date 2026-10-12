import * as sqlite from "node:sqlite";

/**
 * SQLite 适配层（ADR-013）。
 *
 * 本机基线 Node v24.18.0 只导出 `DatabaseSync`，不含 `Database`；Node 26 一线同时提供两者。
 * 业务层因此一律不引用 Node 内置类名，只依赖本文件导出的类型与工厂函数。
 */
type DatabaseHandle = sqlite.DatabaseSync;
type DatabaseCtor = new (path: string) => DatabaseHandle;

function resolveDatabaseCtor(): { ctor: DatabaseCtor; name: string } {
  const candidates = ["Database", "DatabaseSync"] as const;
  for (const name of candidates) {
    const candidate = (sqlite as unknown as Record<string, unknown>)[name];
    if (typeof candidate === "function") {
      return { ctor: candidate as unknown as DatabaseCtor, name };
    }
  }
  throw new Error(
    "node:sqlite 未暴露可用的数据库构造器（尝试过 Database、DatabaseSync）。不降级、不自实现——请核对 Node 版本基线 >=24.18.0 <27。",
  );
}

export interface Database {
  readonly handle: DatabaseHandle;
  readonly ctorName: string;
  exec(sql: string): void;
  prepare(sql: string): sqlite.StatementSync;
  close(): void;
}

export function openDatabase(path: string): Database {
  const { ctor, name } = resolveDatabaseCtor();
  const handle = new ctor(path);
  return {
    handle,
    ctorName: name,
    exec: (sql) => handle.exec(sql),
    prepare: (sql) => handle.prepare(sql),
    close: () => handle.close(),
  };
}

/**
 * 每个连接都要应用的 pragma。顺序有意义：先 WAL，再 secure_delete，
 * 否则前面写入的页不会被后面的策略覆盖。
 */
export function applyPragmas(db: Database): void {
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = FULL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  // 硬删除的物理边界（ADR-009、ADR-004）：普通表删除后不留字节痕迹。
  db.exec("PRAGMA secure_delete = ON");
  db.exec("PRAGMA foreign_key_check");
}

/**
 * WAL 有一个已知缺口：`secure_delete` 不覆盖 WAL 文件中的历史页。
 * 删除操作之后必须 checkpoint 并截断，才能兑现"库文件中查不到被删原文"。
 */
export function checkpointAndTruncate(db: Database): void {
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
}

export function sqliteVersion(db: Database): string {
  const row = db.prepare("select sqlite_version() as v").get() as { v: string };
  return row.v;
}
