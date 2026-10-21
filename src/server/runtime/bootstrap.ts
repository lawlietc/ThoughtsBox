import { existsSync } from "node:fs";
import type { Server } from "node:http";

import { loadConfig, loadConfigFromPath, configSourcePath, type LoadedConfig } from "../config/config.ts";
import { ensureDataDirs, resolveDataLayout, type DataLayout } from "../config/paths.ts";
import { applyPragmas, openDatabase, type Database } from "../db/adapter.ts";
import { currentSchemaVersion, migrate } from "../db/migrator.ts";
import { seedVocabulary, type SeedSummary } from "../db/seed.ts";
import { createApiServer, listen } from "../api/httpServer.ts";
import { RecordService } from "../records/service.ts";
import { runDataCheck } from "./dataCheck.ts";
import { runSelfCheck, type SelfCheckReport } from "./selfCheck.ts";
import { acquireInstanceLock, type HeldLock } from "./singleInstance.ts";
import { buildProductionProvider } from "./productionProvider.ts";
import { Workspace, type IngestProviderBundle } from "./workspace.ts";

export interface BootResult {
  readonly layout: DataLayout;
  readonly loaded: LoadedConfig;
  readonly selfCheck: SelfCheckReport;
  readonly held: HeldLock;
  readonly server: Server;
  readonly seed: SeedSummary;
  readonly workspace: Workspace;
  /** 恢复（R-5）会原位换库，这些访问器永远指向当前活动实例，不是启动时的快照。 */
  db: Database;
  schemaVersion: number;
  records: RecordService;
}

export interface BootOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly log?: (line: string) => void;
  /**
   * Provider 装配注入（M2-6）：显式注入即测试路径（m2-boot/m2-api），走真实的 IngestService 全链路。
   * **省略时不再是「未装配」**——M4-TR-1 起，省略即由 `buildProductionProvider` 按 `config.model`
   * 自动装配生产 Provider 面（`enabled=false` 才回落为 null、解析能力未就绪）。
   * 只影响 Workspace 的装配，不改变任何启动时序——仍在锁与自检之后消费。
   */
  readonly ingestProvider?: IngestProviderBundle;
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
    // 数据面自检（M1b §八）：在迁移与播种之后、对外服务之前。失败即启动失败——
    // M0 的 fail-fast 契约不因数据面扩展而放宽：不静默降级、不带着坏索引开门。
    const dataCheck = runDataCheck(db);
    log(
      `数据面自检通过：schema v${dataCheck.schemaVersion}，检查 ${dataCheck.passedSteps.length} 项` +
        (dataCheck.searchIndexRebuilt
          ? `（搜索索引已自动重建：重建前 幽灵 ${dataCheck.desyncBeforeRebuild?.phantom ?? 0}、缺失 ${dataCheck.desyncBeforeRebuild?.missing ?? 0}）`
          : ""),
    );
    const workspace = new Workspace(
      layout,
      db,
      schemaVersion,
      options.ingestProvider ?? buildProductionProvider(loaded.config, env),
    );
    log(
      workspace.ingestReady
        ? "解析能力就绪：Provider 装配已注入"
        : "解析能力未就绪：未注入 Provider 装配（parse 面将显式拒绝，不假装可发送）",
    );
    // 约束二 ⑤：重启后恢复检测待清理任务；与删除服务共用同一幂等重试路径（T-28）。
    const pendingTasks = workspace.records.getMaintenanceTasks();
    if (pendingTasks.length > 0) {
      log(`检测到 ${pendingTasks.length} 项待清理存储维护任务，尝试幂等重试`);
      const retry = workspace.records.retryStorageMaintenance();
      log(
        retry.ok
          ? `重试完成，清理 ${retry.resolvedTasks} 项待处理任务`
          : `重试仍失败（${retry.detail}），可在 /api/storage-maintenance/retry 再次触发`,
      );
    }
    const server = createApiServer({
      layout,
      config: loaded.config,
      selfCheck,
      workspace,
      runtime: { configDirty: false },
    });
    await listen(server, loaded.config.server.host, loaded.config.server.port);
    log(`服务已启动：http://${loaded.config.server.host}:${loaded.config.server.port}/api/health（${Date.now() - started}ms）`);

    return {
      layout,
      loaded,
      selfCheck,
      held,
      server,
      seed,
      workspace,
      get db() {
        return workspace.db;
      },
      get schemaVersion() {
        return workspace.schemaVersion;
      },
      get records() {
        return workspace.records;
      },
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
