import { existsSync } from "node:fs";
import type { Server } from "node:http";

import { loadConfig, loadConfigFromPath, configSourcePath, type LoadedConfig } from "../config/config.ts";
import { ensureDataDirs, resolveDataLayout, type DataLayout } from "../config/paths.ts";
import { applyPragmas, openDatabase, type Database } from "../db/adapter.ts";
import { currentSchemaVersion, migrate } from "../db/migrator.ts";
import { seedVocabulary, type SeedSummary } from "../db/seed.ts";
import { createApiServer, listen } from "../api/httpServer.ts";
import { runSelfCheck, type SelfCheckReport } from "./selfCheck.ts";
import { acquireInstanceLock, type HeldLock } from "./singleInstance.ts";

export interface BootResult {
  readonly layout: DataLayout;
  readonly loaded: LoadedConfig;
  readonly selfCheck: SelfCheckReport;
  readonly held: HeldLock;
  readonly db: Database;
  readonly server: Server;
  readonly schemaVersion: number;
  readonly seed: SeedSummary;
}

export interface BootOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly log?: (line: string) => void;
}

/**
 * 启动顺序是硬约束（M0 高风险不变量 1、ADR-015）：
 * 解析数据目录 → 预读配置（不写盘）→ 自检（仅临时目录）→ **获取运行锁** →
 * 才允许创建目录/写配置/开库/迁移/播种 → 绑定固定端口。
 * 任何一步失败都不降级：自检失败不猜测能力，端口冲突不换端口。
 */
export async function boot(options: BootOptions = {}): Promise<BootResult> {
  const env = options.env ?? process.env;
  const log = options.log ?? ((line: string) => console.log(line));
  const started = Date.now();

  const layout = resolveDataLayout(env);
  log(`数据目录：${layout.dataDir}${layout.envOverride ? "（TB_DATA_DIR 覆盖）" : ""}`);

  const preflight = loadConfigFromPath(configSourcePath(layout), env);
  const { host, port } = preflight.config.server;
  log(`将绑定 ${host}:${port}（固定端口，不自动切换）`);

  const selfCheck = runSelfCheck();
  log(
    `自检通过：SQLite ${selfCheck.sqliteVersion}，能力 ${selfCheck.passed.length} 项，契约 ${selfCheck.contractsFingerprint.slice(0, 12)}`,
  );

  const held = await acquireInstanceLock(layout, { host, port });
  if (held.tookOver !== null) {
    log(`接管残留运行锁（原持有者 PID ${held.tookOver.pid}，启动于 ${held.tookOver.startedAt}）`);
  }

  let db: Database | null = null;
  try {
    // —— 以下才允许写盘 ——
    ensureDataDirs(layout);
    const loaded = loadConfig(layout, env);
    db = openDatabase(layout.dbFile);
    applyPragmas(db);
    log(`数据库就绪：${layout.dbFile}（构造器 ${db.ctorName}）`);

    const migration = migrate(db);
    if (migration.applied.length > 0) {
      log(`执行迁移 ${migration.applied.length} 份 → schema v${migration.schemaVersion}`);
    } else {
      log(`迁移无需执行，schema 仍为 v${currentSchemaVersion(db)}`);
    }

    const seed = seedVocabulary(db);
    log(
      `词表水位：新增 ${seed.inserted}、已存在 ${seed.unchanged}、内容变化 ${seed.changed}（概念 ${seed.concepts}、别名 ${seed.aliases}）`,
    );

    const schemaVersion = currentSchemaVersion(db);
    const server = createApiServer({
      layout,
      config: loaded.config,
      selfCheck,
      schemaVersion,
      sqliteCtorName: db.ctorName,
    });
    await listen(server, loaded.config.server.host, loaded.config.server.port);
    log(`服务已启动：http://${loaded.config.server.host}:${loaded.config.server.port}/api/health（${Date.now() - started}ms）`);

    return {
      layout,
      loaded,
      selfCheck,
      held,
      db,
      server,
      schemaVersion,
      seed,
    };
  } catch (cause) {
    // 锁是本进程拿到的，任何后续失败都要立即释放，否则崩溃残留只能靠接管规则回收。
    if (db !== null) {
      // 已开库后才失败的话，句柄不关就会把数据目录一直压住（Windows 上连临时目录都删不掉）。
      try {
        db.close();
      } catch {
        /* 关闭失败不覆盖原始失败原因 */
      }
    }
    held.release();
    throw cause;
  }
}

export interface ShutdownResult {
  readonly released: boolean;
}

export async function shutdown(result: BootResult): Promise<ShutdownResult> {
  await new Promise<void>((resolve, reject) => {
    result.server.close((error) => (error ? reject(error) : resolve()));
  });
  result.db.close();
  result.held.release();
  return { released: !existsSync(result.layout.lockFile) };
}
