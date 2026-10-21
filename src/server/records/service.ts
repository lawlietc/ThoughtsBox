import { createHash } from "node:crypto";

import { newId } from "../../shared/contracts/ids.ts";
import { loadEnums } from "../../shared/contracts/load.ts";
import type {
  DeletePhaseResult,
  RecordRow,
  RevisionRow,
  StorageMaintenanceTask,
} from "../../shared/dto.ts";
import { serializeTokens, tokenize } from "../../shared/search/tokenizer.ts";
import { checkpointAndTruncate, type Database } from "../db/adapter.ts";
import { getMeta, setMeta } from "../db/migrator.ts";
import { isStateTransitionAllowed } from "../ingest/ingestService.ts";
import { purgePreviewCache } from "../privacy/grantService.ts";

// M1b：行形状上收为前后端共用契约（src/shared/dto.ts）；此处 re-export 保持既有导入路径可用。
export type { DeletePhaseResult, RecordRow, RevisionRow, StorageMaintenanceTask } from "../../shared/dto.ts";

export class RecordValidationError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "RecordValidationError";
  }
}

export class RecordNotFoundError extends Error {
  constructor(id: string) {
    super(`记录不存在：${id}`);
    this.name = "RecordNotFoundError";
  }
}

/**
 * M5-1：processing_mode 的单一事实源是 enums.json `processing_modes`。
 * 模块级缓存一次，避免每次写请求都重读磁盘；取值缺失即抛，不静默放行。
 */
let cachedProcessingModes: readonly string[] | undefined;
function processingModes(): readonly string[] {
  cachedProcessingModes ??= loadEnums().processing_modes;
  return cachedProcessingModes;
}

/** 非法 mode：400 且 issues 只点名字段，不回显任何无关内容。 */
export class InvalidProcessingModeError extends RecordValidationError {
  readonly issues: readonly string[];
  constructor() {
    super(`processing_mode 只接受已登记取值：${processingModes().join(" / ")}`);
    this.name = "InvalidProcessingModeError";
    this.issues = ["processing_mode"];
  }
}

/** 在途状态（preprocessing / processing）拒绝改模式：409 state_conflict。 */
export class RecordStateConflictError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "RecordStateConflictError";
  }
}

export interface RecordTimestamps {
  readonly utc: string;
  readonly local: string;
  readonly timezoneId: string;
  readonly localDate: string;
}

/** K-16 时间四件套：UTC、含偏移本地 ISO、IANA 时区名、本地日期。 */
export function buildTimestamps(date: Date, timezoneId: string): RecordTimestamps {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezoneId,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  const wallMs = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour) % 24,
    Number(parts.minute),
    Number(parts.second),
  );
  const offsetMin = Math.round((wallMs - Math.floor(date.getTime() / 1000) * 1000) / 60000);
  const sign = offsetMin < 0 ? "-" : "+";
  const abs = Math.abs(offsetMin);
  const offset = `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
  const ms = String(date.getMilliseconds()).padStart(3, "0");
  const utc = date.toISOString();
  const local = `${parts.year}-${parts.month}-${parts.day}T${pad(parts.hour)}:${parts.minute}:${parts.second}.${ms}${offset}`;
  return { utc, local, timezoneId, localDate: `${parts.year}-${parts.month}-${parts.day}` };
}

function pad(v: string | undefined): string {
  return (v ?? "00").padStart(2, "0");
}

export interface RecordServiceOptions {
  readonly now?: () => Date;
  readonly timezoneId?: string;
  /** Phase B 注入点：测试据此验证「清理失败 ≠ 回滚」，生产默认走 adapter 的 checkpoint。 */
  readonly storageMaintenance?: (db: Database) => void;
}

const STORAGE_MAINTENANCE_KEY = "storage_maintenance_pending";
export { STORAGE_MAINTENANCE_KEY };

/**
 * 记录服务（M1a 数据闭环）：捕捉 → 版本 → 搜索 → 硬删除 + 审计。
 * 一切多语句写操作都在显式事务内（Schema 审查稿 §3 冻结：deferred FK 只在 commit 兜底）。
 */
export class RecordService {
  private readonly db: Database;
  private readonly now: () => Date;
  private readonly timezoneId: string;
  private readonly maintainStorage: (db: Database) => void;

  constructor(db: Database, options: RecordServiceOptions = {}) {
    this.db = db;
    this.now = options.now ?? (() => new Date());
    this.timezoneId =
      options.timezoneId ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";
    this.maintainStorage = options.storageMaintenance ?? ((handle) => checkpointAndTruncate(handle));
  }

  private timestamps(): RecordTimestamps {
    return buildTimestamps(this.now(), this.timezoneId);
  }

  /** 原文只被逐字保存；哈希是派生量（NFC 归一，仅用于 diff 与审计比对）。 */
  private static hash(text: string): string {
    return createHash("sha256").update(text.normalize("NFC")).digest("hex");
  }

  static validateText(text: unknown): string {
    if (typeof text !== "string") {
      throw new RecordValidationError("text 必须是字符串");
    }
    if (text.length === 0 || text.trim() === "") {
      throw new RecordValidationError("text 不能为空或仅空白");
    }
    return text;
  }

  /** mode 取值一律回到 enums.json 单一事实源校验，不接受第二份字面量表。 */
  static validateMode(mode: unknown): string {
    if (typeof mode !== "string" || !processingModes().includes(mode)) {
      throw new InvalidProcessingModeError();
    }
    return mode;
  }

  createRecord(
    text: string,
    mode?: string,
  ): { record: RecordRow; revision: RevisionRow } {
    const body = RecordService.validateText(text);
    const chosen = mode === undefined ? "manual_only" : RecordService.validateMode(mode);
    // §4.8：cloud 建记录即进 awaiting_privacy_review（captured→awaiting 是登记边）；
    // 其余两档沿用 DDL 缺省 captured。缺省路径与扩参前逐字同值。
    const initialStatus = chosen === "cloud_redacted" ? "awaiting_privacy_review" : "captured";
    if (initialStatus !== "captured" && !isStateTransitionAllowed("processing_status", "captured", initialStatus)) {
      throw new RecordStateConflictError(`§4.8 未登记 captured → ${initialStatus}，建记录不得自创状态边`);
    }
    const ts = this.timestamps();
    const recordId = newId("captureRecord");
    const revisionId = newId("recordRevision");
    const sha = RecordService.hash(body);
    const tokens = serializeTokens(tokenize(body));
    this.inTransaction(() => {
      this.db
        .prepare(
          `insert into capture_record (id, created_at_utc, created_at_local, timezone_id, created_local_date,
                                       current_revision_id, processing_mode, processing_status)
           values (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(recordId, ts.utc, ts.local, ts.timezoneId, ts.localDate, revisionId, chosen, initialStatus);
      this.insertRevision(revisionId, recordId, 1, body, sha, tokens, ts);
    });
    return {
      record: this.getRecordRow(recordId),
      revision: this.getRevisionRow(revisionId),
    };
  }

  /** B13：空 diff 不建版；文本变化才追加版本，历史原文永不改写（K-01）。 */
  editRecord(
    recordId: string,
    text: string,
  ): { record: RecordRow; revision: RevisionRow; changed: boolean } {
    const body = RecordService.validateText(text);
    const ts = this.timestamps();
    let changed = false;
    this.inTransaction(() => {
      const record = this.getRecordRow(recordId);
      const current = this.getRevisionRow(record.current_revision_id);
      if (current.raw_text === body) {
        return;
      }
      changed = true;
      const nextNumber = this.maxRevisionNumber(recordId) + 1;
      const revisionId = newId("recordRevision");
      this.insertRevision(
        revisionId,
        recordId,
        nextNumber,
        body,
        RecordService.hash(body),
        serializeTokens(tokenize(body)),
        ts,
      );
      // §4.8（I3）：编辑产生新 revision ⇒ parsed→needs_reparse；其余状态不动。
      const status = record.processing_status === "parsed" ? "needs_reparse" : record.processing_status;
      this.db
        .prepare("update capture_record set current_revision_id = ?, processing_status = ? where id = ?")
        .run(revisionId, status, recordId);
    });
    const record = this.getRecordRow(recordId);
    return { record, revision: this.getRevisionRow(record.current_revision_id), changed };
  }

  /**
   * M5-1：改单条记录的处理模式。状态流转只允许 §4.8 已登记的边（裁决 2026-10-18）：
   * `captured + cloud_redacted → awaiting_privacy_review`；
   * `awaiting_privacy_review + 离开 cloud → not_processed`；
   * `captured + local_model/manual_only` 保持 captured；
   * `not_processed / parsed / failed / needs_reparse` 只改 mode 不动状态；
   * `preprocessing / processing` 在途拒绝（409）；同 mode 重复设置返回 `changed:false`。
   */
  setProcessingMode(recordId: string, mode: unknown): { record: RecordRow; changed: boolean } {
    const chosen = RecordService.validateMode(mode);
    let changed = false;
    this.inTransaction(() => {
      const record = this.getRecordRow(recordId);
      if (record.processing_mode === chosen) return;
      const from = record.processing_status;
      if (from === "preprocessing" || from === "processing") {
        throw new RecordStateConflictError(
          `记录正在 ${from}，拒绝改模式：在途处理的处理承诺不可修改，请等这一次跑完`,
        );
      }
      let to = from;
      if (from === "captured" && chosen === "cloud_redacted") {
        to = "awaiting_privacy_review";
      } else if (from === "awaiting_privacy_review" && chosen !== "cloud_redacted") {
        to = "not_processed";
      }
      if (to !== from && !isStateTransitionAllowed("processing_status", from, to)) {
        throw new RecordStateConflictError(`§4.8 未登记 ${from} → ${to}，改模式不得自创转换`);
      }
      this.db
        .prepare("update capture_record set processing_mode = ?, processing_status = ? where id = ?")
        .run(chosen, to, recordId);
      changed = true;
    });
    return { record: this.getRecordRow(recordId), changed };
  }

  getRecord(recordId: string): { record: RecordRow; current: RevisionRow; revisions: RevisionRow[] } {
    const record = this.getRecordRow(recordId);
    const rows = this.db
      .prepare("select * from record_revision where record_id = ? order by revision_number")
      .all(recordId) as unknown as Array<RevisionRow & { tokens: string }>;
    const revisions = rows.map(({ tokens: _tokens, ...revision }) => revision);
    return { record, current: this.getRevisionRow(record.current_revision_id), revisions };
  }

  listRecords(limit: number, offset: number): { records: RecordRow[]; total: number } {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new RecordValidationError("limit 必须是 1–500 的整数");
    }
    if (!Number.isInteger(offset) || offset < 0) {
      throw new RecordValidationError("offset 必须是非负整数");
    }
    const total = (this.db.prepare("select count(*) as n from capture_record").get() as { n: number }).n;
    const records = this.db
      .prepare("select * from capture_record order by created_at_utc desc, id limit ? offset ?")
      .all(limit, offset) as unknown as RecordRow[];
    return { records, total };
  }

  /**
   * 一次取齐这批记录**当前版本**的原文（M3-PROJ-1：op1 待整理列表的截断摘要由此而来）。
   *
   * 存在的理由是把「每行再调一次 `getRecord`」的 N+1 收敛成一条 join：列表要 100 行时，
   * 旧写法要 101 次查询、且每次都顺带把该记录的全部历史版本读了一遍。
   * 只读 `capture_record` 与 `record_revision` 两张事实表，不碰派生层。
   */
  currentRawTexts(recordIds: readonly string[]): Map<string, string> {
    const found = new Map<string, string>();
    if (recordIds.length === 0) return found;
    const rows = this.db
      .prepare(
        `select cr.id as record_id, rr.raw_text as raw_text
           from capture_record as cr
           join record_revision as rr on rr.id = cr.current_revision_id
          where cr.id in (${recordIds.map(() => "?").join(", ")})`,
      )
      .all(...recordIds) as unknown as Array<{ record_id: string; raw_text: string }>;
    for (const row of rows) found.set(row.record_id, row.raw_text);
    return found;
  }

  /**
   * 两阶段硬删除（§5.3）。阶段 A：一个事务内删叶子（CASCADE 清版本与 FTS 触发器）
   * 并写审计；任何失败整体回滚，不留半删状态。阶段 B：提交后的存储清理，
   * 失败 ⇒ 持久化待清理任务，绝不报告为回滚（约束二 ①②③）。
   */
  deleteRecord(recordId: string): DeletePhaseResult {
    const ts = this.timestamps();
    let removed = 0;
    this.inTransaction(() => {
      const record = this.getRecordRow(recordId);
      removed = this.maxRevisionNumber(record.id);
      // 先按 revision 精确清掉预览缓存两键，再删记录本体（K-09：硬删除不留敏感载荷残行）。
      const revisionIds = (
        this.db
          .prepare("select id from record_revision where record_id = ?")
          .all(record.id) as unknown as Array<{ id: string }>
      ).map((row) => row.id);
      purgePreviewCache(this.db, revisionIds);
      this.db.prepare("delete from capture_record where id = ?").run(record.id);
      this.db
        .prepare(
          `insert into deletion_audit (id, object_type, object_id, deleted_at_utc, executor, affected)
           values (?, 'capture_record', ?, ?, 'user', ?)`,
        )
        .run(newId("deletionAudit"), record.id, ts.utc, JSON.stringify({ revisions: removed }));
    });
    const phaseA = { committed: true as const, revisionsRemoved: removed };
    try {
      this.maintainStorage(this.db);
      return { phaseA, phaseB: { status: "ok" } };
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      const task: StorageMaintenanceTask = {
        operation: "delete",
        object_id: recordId,
        failed_step: "wal_checkpoint_truncate",
        ts: ts.utc,
      };
      try {
        this.addMaintenanceTask(task);
        return { phaseA, phaseB: { status: "pending", detail } };
      } catch {
        return { phaseA, phaseB: { status: "failed_unpersisted", detail } };
      }
    }
  }

  getMaintenanceTasks(): StorageMaintenanceTask[] {
    const raw = getMeta(this.db, STORAGE_MAINTENANCE_KEY);
    if (raw === undefined || raw === "") return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as StorageMaintenanceTask[]) : [];
  }

  /**
   * 幂等重试（约束二 ④）：清理动作本身可重复执行；成功即清空任务集合，
   * 无任务时执行同样安全。启动自检与删除服务共用此路径（T-28），重启后可恢复（⑤）。
   */
  retryStorageMaintenance(): { ok: boolean; resolvedTasks: number; detail?: string } {
    const tasks = this.getMaintenanceTasks();
    try {
      this.maintainStorage(this.db);
    } catch (cause) {
      return { ok: false, resolvedTasks: 0, detail: cause instanceof Error ? cause.message : String(cause) };
    }
    if (tasks.length > 0) {
      this.clearMaintenanceTasks();
    }
    return { ok: true, resolvedTasks: tasks.length };
  }

  /**
   * 查询侧与索引侧共用同一 tokenizer（Spec §7.2）。检索语义：命中**当前版本**——
   * 历史版本全部保留但经详情可达，不作为搜索结果出现（记录级搜索的产品语义）。
   * 命中返回的是主表行——索引只是派生入口，永不作为事实源被读取（高风险不变量 1）。
   */
  searchRecords(query: string): { hits: Array<RevisionRow & { record_created_local_date: string }> } {
    if (typeof query !== "string") {
      throw new RecordValidationError("q 必须是字符串");
    }
    const terms = tokenize(query);
    if (terms.length === 0) {
      return { hits: [] };
    }
    // token 字符集封闭（字母数字/CJK/'_.-），双引号短语形态无注入面。
    const match = terms.map((t) => `"${t}"`).join(" AND ");
    const hits = this.db
      .prepare(
        `select rr.id, rr.record_id, rr.revision_number, rr.raw_text, rr.content_sha256,
                rr.created_at_utc, rr.created_at_local, rr.timezone_id,
                cr.created_local_date as record_created_local_date
           from record_fts
           join record_revision rr on rr.rowid = record_fts.rowid
           join capture_record cr on cr.id = rr.record_id and cr.current_revision_id = rr.id
          where record_fts match ?
          order by bm25(record_fts)
          limit 100`,
      )
      .all(match) as unknown as (RevisionRow & { record_created_local_date: string })[];
    return { hits };
  }

  /** 全量重建（T 类验收：重建前后结果一致）+ FTS5 external-content 完整性核验（不匹配即抛错）。 */
  rebuildSearchIndex(): void {
    this.inTransaction(() => {
      this.db.exec("insert into record_fts(record_fts) values('rebuild')");
      this.db.exec("insert into record_fts(record_fts) values('integrity-check')");
    });
  }

  /**
   * 双向脱锚检测：phantom=索引有而内容表无，missing=内容表有而索引无。
   * 本机实测（scratch/fts-docsize-probe.mjs, 2026-10-12）：integrity-check 检不出 phantom，
   * docsize 影子表对照可以——因此一致性检查走这条路径，不依赖 integrity-check 兜底。
   */
  detectIndexDesync(): { phantom: number; missing: number } {
    return this.db
      .prepare(
        `select
           (select count(*) from record_fts_docsize d
             where d.rowid not in (select rowid from record_revision)) as phantom,
           (select count(*) from record_revision m
             where m.rowid not in (select rowid from record_fts_docsize)) as missing`,
      )
      .get() as unknown as { phantom: number; missing: number };
  }

  private addMaintenanceTask(task: StorageMaintenanceTask): void {
    const tasks = this.getMaintenanceTasks();
    const next = [...tasks.filter((t) => t.object_id !== task.object_id || t.ts !== task.ts), task];
    setMeta(this.db, STORAGE_MAINTENANCE_KEY, JSON.stringify(next));
  }

  private clearMaintenanceTasks(): void {
    setMeta(this.db, STORAGE_MAINTENANCE_KEY, JSON.stringify([]));
  }

  private inTransaction(body: () => void): void {
    this.db.exec("begin immediate");
    try {
      body();
    } catch (cause) {
      this.db.exec("rollback");
      throw cause;
    }
    this.db.exec("commit");
  }

  private insertRevision(
    id: string,
    recordId: string,
    revisionNumber: number,
    rawText: string,
    sha: string,
    tokens: string,
    ts: RecordTimestamps,
  ): void {
    this.db
      .prepare(
        `insert into record_revision (id, record_id, revision_number, raw_text, content_sha256, tokens,
                                      created_at_utc, created_at_local, timezone_id)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, recordId, revisionNumber, rawText, sha, tokens, ts.utc, ts.local, ts.timezoneId);
  }

  private maxRevisionNumber(recordId: string): number {
    const row = this.db
      .prepare("select coalesce(max(revision_number), 0) as n from record_revision where record_id = ?")
      .get(recordId) as { n: number };
    return row.n;
  }

  private getRecordRow(id: string): RecordRow {
    const row = this.db.prepare("select * from capture_record where id = ?").get(id) as
      | RecordRow
      | undefined;
    if (row === undefined) throw new RecordNotFoundError(id);
    return row;
  }

  private getRevisionRow(id: string): RevisionRow {
    const row = this.db.prepare("select * from record_revision where id = ?").get(id) as
      | (RevisionRow & { tokens: string })
      | undefined;
    if (row === undefined) throw new RecordNotFoundError(id);
    const { tokens: _tokens, ...revision } = row;
    return revision;
  }
}
