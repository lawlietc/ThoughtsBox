import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { applyPragmas, openDatabase, type Database } from "../../src/server/db/adapter.ts";
import { listMigrationFiles } from "../../src/server/db/migrator.ts";
import { resolveDataLayout, type DataLayout } from "../../src/server/config/paths.ts";

/**
 * 迁移目录里的最高版本号 = 应用当前应有的 schema 版本。
 * 断言「启动后库已升到最新」的测试用它，避免每加一个迁移就回头改一遍与语义无关的字面量；
 * 真正钉住迁移文件清单的是 m0-migration-seed 里的硬编码列表。
 */
export const HEAD_SCHEMA_VERSION = listMigrationFiles().at(-1)!.version;

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

const KNOWN_TABLES = new Set([
  "schema_migrations",
  "app_meta",
  "vocab_seed_watermark",
  // M1（0002）业务表——E-05 授权的「测试随 schema 演进」同步点。
  "capture_record",
  "record_revision",
  "deletion_audit",
  // M2（0003）派生层。
  "cloud_send_grant",
  "parse_run",
  "episode",
  "thought_item",
  "concept",
  "concept_alias",
  "entity",
  "entity_alias",
  "emotion_mention",
  "topic_mention",
  "entity_mention",
  "suggestion",
  "graph_edge",
  // M2（0004）修正层。
  "user_scalar_override",
  "user_collection_patch",
  // M3（0007）§3.16 触发认定表。
  "trigger_assertion",
]);

export function countRows(db: Database, table: string): number {
  if (!KNOWN_TABLES.has(table)) {
    throw new Error(`测试辅助函数只认识 M0 引导层表，收到 ${table}`);
  }
  const row = db.prepare(`select count(*) as n from ${table}`).get() as { n: number };
  return row.n;
}
