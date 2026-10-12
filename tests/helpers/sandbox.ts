import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { applyPragmas, openDatabase, type Database } from "../../src/server/db/adapter.ts";
import { resolveDataLayout, type DataLayout } from "../../src/server/config/paths.ts";

export interface Sandbox {
  readonly root: string;
  readonly layout: DataLayout;
  cleanup(): void;
}

/**
 * 所有测试都用隔离数据目录（M0 高风险不变量 3）：
 * 一律经 TB_DATA_DIR 指到 mkdtemp，绝不落到 %LOCALAPPDATA%\ThoughtsBox。
 */
/**
 * Windows 上刚终止的子进程可能还压着目录句柄，删除会短暂 EPERM；重试到删掉为止，
 * 但绝不静默吞掉失败——清理不掉就是测试环境的问题，要让它响。
 */
function removeTree(dir: string): void {
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      if (Date.now() > deadline) throw error;
      const until = Date.now() + 200;
      while (Date.now() < until) {
        /* 自旋等待句柄释放 */
      }
    }
  }
}

export function makeSandbox(prefix = "tb-test-"): Sandbox {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const layout = resolveDataLayout({ TB_DATA_DIR: root });
  return {
    root,
    layout,
    cleanup: () => removeTree(root),
  };
}

export function openSandboxDb(layout: DataLayout): Database {
  const db = openDatabase(layout.dbFile);
  applyPragmas(db);
  return db;
}

const KNOWN_TABLES = new Set(["schema_migrations", "app_meta", "vocab_seed_watermark"]);

export function countRows(db: Database, table: string): number {
  if (!KNOWN_TABLES.has(table)) {
    throw new Error(`测试辅助函数只认识 M0 引导层表，收到 ${table}`);
  }
  const row = db.prepare(`select count(*) as n from ${table}`).get() as { n: number };
  return row.n;
}
