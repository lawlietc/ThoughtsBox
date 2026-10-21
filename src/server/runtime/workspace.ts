import type { DataLayout } from "../config/paths.ts";
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
  /** 双模型配置：按处理模式选适配器；缺席时回落到 `adapter`（测试与旧注入保持兼容）。 */
  readonly adapters?: Readonly<Partial<Record<ProcessingMode, ModelAdapter>>>;
  readonly transport: ProviderTransport;
  readonly systemPrompt: string;
  readonly now?: () => Date;
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

  constructor(
    layout: DataLayout,
    db: Database,
    schemaVersion: number,
    ingestProvider: IngestProviderBundle | null = null,
  ) {
    this.layout = layout;
    this.db = db;
    this.schemaVersion = schemaVersion;
    this.records = new RecordService(db);
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

  private adapterFor(mode: ProcessingMode): ModelAdapter | null {
    if (this.ingestProvider === null) return null;
    if (this.ingestProvider.adapters === undefined) return this.ingestProvider.adapter;
    return this.ingestProvider.adapters[mode] ?? null;
  }

  /**
   * 按请求现造 IngestService：绑定当前活动句柄 + Provider 装配，
   * 并注入本次授权闸门（cloud_redacted 的逐版本授权检查，闭包捕获具体 revision/payload/policy）。
   * 装配缺席即返回 null——调用方据此拒绝解析，而不是拿半套配置硬发。
   */
  makeIngestService(mode?: ProcessingMode, grantCheck?: () => void): IngestService | null {
    if (this.ingestProvider === null) return null;
    const adapter =
      mode === undefined
        ? this.ingestProvider.adapters === undefined
          ? this.ingestProvider.adapter
          : (this.ingestProvider.adapters.cloud_redacted ??
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
    });
  }

  swap(next: { db: Database; schemaVersion: number }): void {
    this.db = next.db;
    this.schemaVersion = next.schemaVersion;
    this.records = new RecordService(next.db);
    this.backups = new BackupService(next.db, this.layout);
    this.corrections = new CorrectionService(next.db);
    this.grants = new GrantService(next.db);
  }
}
