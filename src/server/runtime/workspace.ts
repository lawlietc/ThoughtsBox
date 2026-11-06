import type { DataLayout } from "../config/paths.ts";
import type { LocalLlmStatus } from "../config/config.ts";
import type { Database } from "../db/adapter.ts";
import { BackupService } from "../backup/backupService.ts";
import { RecordService } from "../records/service.ts";
import { CorrectionService } from "../correction/service.ts";
import { GrantService } from "../privacy/grantService.ts";
import { IngestService } from "../ingest/ingestService.ts";
import type { ModelAdapter, ProcessingMode, ProviderTransport } from "../ingest/provider.ts";

/**
 * 把 Provider 面注入 IngestService 所需的最小装配。
 * 存在（非 undefined）才代表解析能力就绪：本阶段没有生产 ProviderTransport，
 * boot 默认不装配（`ingestReady` 为 false，parse 面显式拒绝而非假装能发）；
 * 测试经 `boot({ ingestProvider })` 注入桩适配器与假 transport，走真实的 IngestService 全链路。
 * 版本串与 contracts 一律交给 IngestService 的默认值——不在此重抄一份真相。
 */
export interface IngestProviderBundle {
  readonly adapter: ModelAdapter;
  /**
   * 按处理模式登记的适配器表（M6-0C 起是四个模式值：`manual_only` 用不到适配器，
   * `cloud_raw` 缺席时复用 `cloud_redacted`，见 `adapterFor`）。缺席时回落到 `adapter`
   * （测试与旧注入保持兼容）。
   */
  readonly adapters?: Readonly<Partial<Record<ProcessingMode, ModelAdapter>>>;
  readonly transport: ProviderTransport;
  readonly systemPrompt: string;
  readonly now?: () => Date;
}

/**
 * M10-1：装配层注入给记录服务的保存后通知。Workspace 不判断它是什么、也不判断该不该跑，
 * 只把这一份依赖原样交给 `RecordService`（并在 `swap()` 重建时再交一次）。
 * 缺席 ⇒ `RecordService` 的保存路径与改动前逐字相同（断言 B11）。
 */
export interface WorkspaceOptions {
  readonly onRevisionSaved?: (revisionId: string) => void;
}

/**
 * 运行期活动对象集（M1b §六 R-5：恢复 = 整库原位替换）。
 *
 * 恢复成功的瞬间必须整体换血：数据库句柄、记录服务、备份服务、schema 版本
 * 都绑定在旧文件上，逐个更新会留下「新句柄 + 旧服务」的组合窗口。
 * swap 只在恢复的最后一步同步调用——外部任何时刻读到的都是全旧或全新。
 *
 * M2-6：修正层（CorrectionService）与授权层（GrantService）同样绑定 db，随 swap 重建；
 * IngestService 不在这里常驻——它按每次解析请求现造（要绑本次授权闸门与请求 signal），
 * 故这里只存 Provider 装配，用 makeIngestService 现取现用。
 */
export class Workspace {
  readonly layout: DataLayout;
  db: Database;
  schemaVersion: number;
  records: RecordService;
  backups: BackupService;
  corrections: CorrectionService;
  grants: GrantService;
  /** Provider 装配；缺席即解析能力未就绪。 */
  readonly ingestProvider: IngestProviderBundle | null;
  /** 交给每一代 `RecordService` 的那份保存后依赖（M10-1，见 `WorkspaceOptions`）。 */
  private readonly recordOptions: WorkspaceOptions;

  constructor(
    layout: DataLayout,
    db: Database,
    schemaVersion: number,
    ingestProvider: IngestProviderBundle | null = null,
    options: WorkspaceOptions = {},
  ) {
    this.layout = layout;
    this.db = db;
    this.schemaVersion = schemaVersion;
    this.recordOptions = options;
    this.records = new RecordService(db, options);
    this.backups = new BackupService(db, layout);
    this.corrections = new CorrectionService(db);
    this.grants = new GrantService(db);
    this.ingestProvider = ingestProvider;
  }

  /** 解析能力是否就绪（供 op8 配置面如实上报，以及路由的前置门）。 */
  get ingestReady(): boolean {
    if (this.ingestProvider === null) return false;
    if (this.ingestProvider.adapters === undefined) return true;
    return Object.values(this.ingestProvider.adapters).some((adapter) => adapter !== undefined);
  }

  ingestReadyFor(mode: ProcessingMode): boolean {
    return this.adapterFor(mode) !== null;
  }

  /**
   * 这一档实际会用到哪个适配器（`cloud_raw` 复用 `cloud_redacted` 那一家，见下面的回落）。
   * M6-1D 起对装配层开放：手动入队要把「模型标识」写进幂等键，而键里那一格必须说得出**将来真的
   * 会跑的那一个**模型——自己按 `adapters[mode]` 猜一遍，就会在 `cloud_raw` 上猜出与执行体不同的键。
   */
  adapterFor(mode: ProcessingMode): ModelAdapter | null {
    if (this.ingestProvider === null) return null;
    if (this.ingestProvider.adapters === undefined) return this.ingestProvider.adapter;
    const direct = this.ingestProvider.adapters[mode];
    if (direct !== undefined) return direct;
    // `cloud_raw` 与 `cloud_redacted` 是**同一家云端端点**，差别只在发出去的是原文还是脱敏文本
    // （草案 §六 对 `workspace.ts:92-94` 的处置）。装配只登记 cloud_redacted 时 cloud_raw 复用它——
    // 否则新增一个模式值就等于让一个真实存在的档位永远「未装配」，而用户看到的是「不可用」。
    // 反方向不成立：脱敏路径不得回落到原文路径，那是把隐私承诺往宽松的方向漂。
    if (mode === "cloud_raw") return this.ingestProvider.adapters.cloud_redacted ?? null;
    return null;
  }

  /**
   * 按请求现造 IngestService：绑定当前活动句柄 + Provider 装配，
   * 并注入本次授权闸门（外发的逐版本授权检查，闭包捕获具体 revision/payload/policy）。
   * 装配缺席即返回 null——调用方据此拒绝解析，而不是拿半套配置硬发。
   *
   * `localLlm`（M9-4b）是 `redaction_mode=local_llm` 那一档的状态读数：Workspace 不持配置，
   * 由持有 `facts.config` 的调用点（路由 / 执行体）算好递下来，一路到发送前的那道门。
   */
  makeIngestService(mode?: ProcessingMode, grantCheck?: () => void, localLlm?: LocalLlmStatus): IngestService | null {
    if (this.ingestProvider === null) return null;
    const adapter =
      mode === undefined
        ? this.ingestProvider.adapters === undefined
          ? this.ingestProvider.adapter
          : (this.ingestProvider.adapters.cloud_redacted ??
            this.ingestProvider.adapters.cloud_raw ??
            this.ingestProvider.adapters.local_model ??
            null)
        : this.adapterFor(mode);
    if (adapter === null) return null;
    return new IngestService({
      db: this.db,
      adapter,
      transport: this.ingestProvider.transport,
      systemPrompt: this.ingestProvider.systemPrompt,
      ...(this.ingestProvider.now === undefined ? {} : { now: this.ingestProvider.now }),
      ...(grantCheck === undefined ? {} : { grantCheck }),
      ...(localLlm === undefined ? {} : { localLlm }),
    });
  }

  swap(next: { db: Database; schemaVersion: number }): void {
    this.db = next.db;
    this.schemaVersion = next.schemaVersion;
    // 回调要跟着换库一起递下去：漏掉它，恢复后的那一代记录服务就不再预跑（M10-1）。
    // `getGrants` / `isWanted` 那一侧本来就现读 `workspace.grants` / `workspace.records`，
    // 所以这里换掉的正是队列下一拍读到的那一份。
    this.records = new RecordService(next.db, this.recordOptions);
    this.backups = new BackupService(next.db, this.layout);
    this.corrections = new CorrectionService(next.db);
    this.grants = new GrantService(next.db);
  }
}
