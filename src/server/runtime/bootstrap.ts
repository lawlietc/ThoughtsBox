import { existsSync } from "node:fs";
import type { Server } from "node:http";

import { loadConfig, loadConfigFromPath, configSourcePath, localLlmStatus, type LoadedConfig } from "../config/config.ts";
import { defaultCredentialStore } from "../config/credentials.ts";
import { ensureDataDirs, resolveDataLayout, type DataLayout } from "../config/paths.ts";
import { applyPragmas, openDatabase, type Database } from "../db/adapter.ts";
import { currentSchemaVersion, migrate } from "../db/migrator.ts";
import { seedVocabulary, type SeedSummary } from "../db/seed.ts";
import { createApiServer, listen } from "../api/httpServer.ts";
import { adapterForLocalLlm } from "../ingest/provider.ts";
import { isLocalLlmRedactedTrack } from "../privacy/egressPreview.ts";
import { PrewarmQueue } from "../privacy/prewarmQueue.ts";
import { RecordService } from "../records/service.ts";
import { JobStore } from "../jobs/jobStore.ts";
import { JobLease } from "../jobs/jobLease.ts";
import { makeEgressGrantRunnable, makeIngestExecutor } from "../jobs/ingestExecutor.ts";
import { DEFAULT_POLL_INTERVAL_MS, JobWorker } from "../jobs/jobWorker.ts";
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
  /**
   * 后台队列的调度循环（M6-1D 接线）。**构造了但不一定在跑**：`startJobsWorker: false` 时
   * `start()` 没被调用，`stop()` 仍然安全（清一个没排的定时器、等一个没在跑的这一拍）。
   * 暴露出来只为 `shutdown` 能按顺序等它收尾。
   */
  readonly jobs: JobWorker;
  /**
   * 本机预跑的串行队列（M10-1）。暴露出来只为三件事：测试可以 `drain()` 而不必真等防抖窗口，
   * 观测面只有 `size()` / `snapshot()` / 三档计数（N-6：没有原文、没有词面、没有自由文本），
   * 以及 M10-4 起复核队列端点要在这里现读「此刻哪几条在册、各自等了多久」。
   */
  readonly prewarm: PrewarmQueue;
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
  /**
   * 后台队列是否在 boot 里真的跑起来（M6-1D）。**默认 true**：真实使用就是「启动即处理排队的任务」。
   * 关掉它的唯一用途是测试——既有那批路由用例直接往 `privacy_job` 写行、再把行读回来核对状态，
   * 一个真的在轮询的 worker 会在它们读之前把任务取走。「不启动」保住的是它们的前提（行留在原状），
   * 不是削弱任何断言；队列自身的启动行为由 `tests/m6-1d-job-wiring.test.ts` 按默认路径覆盖。
   */
  readonly startJobsWorker?: boolean;
  /** 队列轮询间隔（ms），注入只为测试可控；缺席即 `DEFAULT_POLL_INTERVAL_MS`。 */
  readonly jobsPollIntervalMs?: number;
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
  const credentials = defaultCredentialStore(env);

  const layout = resolveDataLayout(env);
  log(`数据目录：${layout.dataDir}${layout.envOverride ? "（TB_DATA_DIR 覆盖）" : ""}`);

  const preflight = loadConfigFromPath(configSourcePath(layout), env, credentials);
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
    const loaded = loadConfig(layout, env, credentials);
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
    // —— M10-1 本机预跑（裁决 M10-D-1 / D-2 / D-5 / D-6 / D-7）——
    // 保存之后就在本机把脱敏结果先算好，用户点预览时命中缓存、秒出。它只把「算」挪到前面，
    // 不改变发哪一份：授权、载荷哈希、policy_version、三轴、processing_status 都不在它手里。
    // 没有总开关（M10-D-2）：唯一的判据是那条记录自己的三轴，由 `isWanted` 在跑之前现读。
    let prewarm: PrewarmQueue | undefined;
    const workspace = new Workspace(
      layout,
      db,
      schemaVersion,
      options.ingestProvider ?? buildProductionProvider(loaded.config, env, credentials),
      { onRevisionSaved: (revisionId) => prewarm?.enqueue(revisionId) },
    );
    // 队列现读 workspace 的服务面、workspace 的保存回调写进队列：这个先后依赖用 `let` +
    // 延迟读取解开（第一次保存只可能发生在 HTTP 面 listen 之后，那时下面这行早已执行）。
    // 三处依赖都写成闭包而不是值，是因为 R-5 换库会重建 `records` / `grants`——队列下一拍
    // 读到的必须是**当前**那一份。
    prewarm = new PrewarmQueue({
      getGrants: () => workspace.grants,
      // 与后台执行体同一个读数手法（M9-D-13）：档位门用 `status`，咨询用同一份 `profile` 派的适配器。
      // 配置改动本来就要重启，`loaded.config` 就是当前快照。
      resolveAdapter: () => adapterForLocalLlm(localLlmStatus(loaded.config).profile, env),
      // 判据只有档位：三轴是 `(cloud, local_llm, redacted)` 才值得问本机模型。
      // `manual` / `none` 档与 `raw` 轨一律跳过（断言 B4）。轴的读法在记录服务那一侧，队列不写 SQL。
      isWanted: (revisionId) => {
        const axes = workspace.records.axesOfRevision(revisionId);
        return axes !== null && isLocalLlmRedactedTrack(axes);
      },
      // 不注入 fetchImpl ⇒ 走真回环端点（生产路径）。
    });
    log(
      localLlmStatus(loaded.config).usable
        ? "本机预跑已就绪：保存后在该档的防抖窗口之后先算好脱敏结果"
        : "本机预跑在册但本地模型档未配置好：保存后逐条静默跳过，不发请求",
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
      env,
      credentials,
      selfCheck,
      workspace,
      runtime: { configDirty: false },
      // M10-4（裁决 M10-D-10）：复核队列端点在这份在册状态上现读「还在检查几条」。
      prewarm,
    });
    await listen(server, loaded.config.server.host, loaded.config.server.port);
    log(`服务已启动：http://${loaded.config.server.host}:${loaded.config.server.port}/api/health（${Date.now() - started}ms）`);

    // —— 后台队列（M6-1D 接线）——在 listen 之后、也就是对外面已经可用之后才起。
    // 顺序的理由：入队点是 HTTP 面，队列是它的消费者；先开门再排消费者，最坏是一行留在 queued，
    // 反过来（先起 worker）会让 worker 在服务还没起来时就往库里写状态。
    // 已知限制（R-5）：`workspace.swap()` 换库后，这里冻住的 `leases`/`store` 与 worker 手里的句柄
    // 仍指向旧 db 句柄，换库后的数据目录对队列是看不见的。本轮不处理，写明在交付记录里。
    const leases = new JobLease(db);
    const jobs = new JobWorker({
      db,
      store: new JobStore(db, { leases }),
      // 与路由侧同源的一次现读：档位门用 `status`，发送前那次咨询用同一个读数里的 `adapter`
      // （M9-D-13）。分成两个 reader 会读到配置改到一半的两次结果。
      executor: makeIngestExecutor(workspace, () => {
        const status = localLlmStatus(loaded.config);
        return { status, adapter: adapterForLocalLlm(status.profile, env) };
      }),
      providerReady: () => workspace.ingestReady,
      // 认领侧那道授权门（整理方式改动 S-4）：外发轨没有本次授权 ⇒ 这一行留在 `queued` 等用户确认，
      // 不占位、不消耗 attempts、不发字节。入队口因此不再拒绝「还没预览过」的记录。
      // 现读 `workspace.grants`（R-5 换库后必须是当前那一份），所以递的是闭包而不是判据结果。
      runnable: makeEgressGrantRunnable(workspace),
      leases,
      ...(options.jobsPollIntervalMs === undefined ? {} : { pollIntervalMs: options.jobsPollIntervalMs }),
      onFailure: (event) => log(`后台队列 ${event.stage} 失败：${event.message}`),
    });
    if (options.startJobsWorker !== false) {
      jobs.start();
      log(`后台队列已启动：轮询 ${options.jobsPollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS}ms`);
    } else {
      log("后台队列未启动（startJobsWorker=false）：任务只入队，不自动处理");
    }

    return {
      layout,
      loaded,
      selfCheck,
      held,
      server,
      seed,
      workspace,
      jobs,
      prewarm,
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
  // 顺序（M6-1D）：**先停队列，再关服务面，最后关库**。
  //  `jobs.stop()` 只清定时器并**等在跑的那一拍写完终态**（`jobWorker.stop()` 的语义），不掐执行体；
  //  反过来先 `db.close()` 的话，那一拍剩下的写入会打在已关闭的句柄上——用户看到的是关窗之后一条
  //  「数据库报错」，而实际发生的只是我们没等它写完。
  //  先停队列后关 HTTP 会留一个极短的窗口（worker 已停、请求还能入队）：那一行只会留在 queued，
  //  下次启动由 worker 的 `recover()` + 轮询接手，不存在半成品——入队本身不执行任何东西。
  await result.jobs.stop();
  await new Promise<void>((resolve, reject) => {
    result.server.close((error) => (error ? reject(error) : resolve()));
  });
  result.db.close();
  result.held.release();
  return { released: !existsSync(result.layout.lockFile) };
}
