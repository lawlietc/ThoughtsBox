import { createHash } from "node:crypto";

import { newId } from "../../shared/contracts/ids.ts";
import { loadEnums } from "../../shared/contracts/load.ts";
import {
  assertThreeAxes,
  axesForProcessingMode,
  coerceAxes,
  deriveProcessingMode,
  isEgress,
  isProcessingModeValue,
  type ProcessingModeValue,
  type ThreeAxes,
} from "../../shared/contracts/enums.ts";
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

/**
 * 新建记录 / 改档时的**产品默认**三轴（2026-11-04，Phase A-0）。
 *
 * `cloud_redacted` 默认走 `local_llm`：云端脱敏的语义层只有本机模型，规则层只遮格式类。
 * 本机模型不可用时，预览/解析会被 `assertRedactionPlanRunnable` 以 409 挡住（PD-2），
 * 不会静默退回 `manual`——这正是「阻断」的含义。
 *
 * 为什么不动 `enums.json` 的 `legacy_axis_mapping`：那份映射是「手里只有 processing_mode」
 * 的导入兼容入口（JSONL 备份、旧测试夹具），继续按原值工作；新记录才走这个默认。
 */
function axesForNewRecord(mode: ProcessingModeValue): ThreeAxes {
  if (mode === "cloud_redacted") {
    return { analysisProvider: "cloud", redactionMode: "local_llm", sendContentMode: "redacted" };
  }
  return axesForProcessingMode(mode);
}

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
  /**
   * M10-1（裁决 M10-D-1）：保存之后的通知——`createRecord` / `editRecord` 各产生一个新版本，
   * 在**写事务提交之后**带着那个新版本 id 调一次。装配层用它把本机预跑排进队列。
   *
   * 依赖方向是硬的：`records/service.ts` 不许 import 模型层，所以这里只有一个 id 的回调，
   * 没有任何「要不要预跑」的判断（判据住在被注入的那一侧，读的就是这条记录的三轴）。
   * 缺省不注入 ⇒ 保存路径与今天逐字相同。回调**抛异常不许冒泡**：预跑失败不能把一次保存搞失败。
   */
  readonly onRevisionSaved?: (revisionId: string) => void;
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
  private readonly onRevisionSaved: ((revisionId: string) => void) | undefined;

  constructor(db: Database, options: RecordServiceOptions = {}) {
    this.db = db;
    this.now = options.now ?? (() => new Date());
    this.timezoneId =
      options.timezoneId ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";
    this.maintainStorage = options.storageMaintenance ?? ((handle) => checkpointAndTruncate(handle));
    this.onRevisionSaved = options.onRevisionSaved;
  }

  /**
   * 提交后的通知（M10-1）：缺席即什么都不做；异常一律就地吞掉——保存已经成功了，
   * 不能被一个下游的预跑排程搞成失败。正文不进日志（N-6），这里连日志都不记。
   */
  private notifyRevisionSaved(revisionId: string): void {
    if (this.onRevisionSaved === undefined) return;
    try {
      this.onRevisionSaved(revisionId);
    } catch {
      /* 预跑排程失败 ≠ 保存失败 */
    }
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

  /**
   * mode 取值一律回到 enums.json 单一事实源校验，不接受第二份字面量表。
   * 返回类型收成 `ProcessingModeValue`：调用方要据此派生三轴（草案 §五），
   * `string` 返回值等于把「已核对过」这个事实又丢回给运行时。
   */
  static validateMode(mode: unknown): ProcessingModeValue {
    if (typeof mode !== "string" || !processingModes().includes(mode)) {
      throw new InvalidProcessingModeError();
    }
    if (!isProcessingModeValue(mode)) {
      // enums.json 有、`contracts/enums.ts` 的常量没有（或反之）——装载时的 T-16 对账本该拦住这件事，
      // 真走到这里说明对账失效。不猜类型、不静默放行（禁区「不放宽既有取值门」的同一取向）。
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
    // 三轴是事实源，`processing_mode` 是它的派生读数（草案 §五）。旧值映射（§四）在这里逐字保留：
    // manual_only→(none,manual,none) / local_model→(local,manual,none) / cloud_redacted→(cloud,manual,redacted)，
    // 新增的 cloud_raw→(cloud,none,raw)。派生与合法性由 0008 的两条表级 CHECK 在库里再钉一遍。
    const axes = axesForNewRecord(chosen);
    // §4.8：外发档建记录即进 awaiting_privacy_review（captured→awaiting 是登记边）；
    // 其余沿用 DDL 缺省 captured。判定读三轴，不写 `=== "cloud_redacted"` 字面量——
    // 但对既有三档而言结果逐字不变（`cloud_raw` 是唯一新增的外发档）。缺省路径与扩参前同值。
    const initialStatus = isEgress(axes) ? "awaiting_privacy_review" : "captured";
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
                                       current_revision_id, processing_mode, processing_status,
                                       analysis_provider, redaction_mode, send_content_mode)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          recordId,
          ts.utc,
          ts.local,
          ts.timezoneId,
          ts.localDate,
          revisionId,
          chosen,
          initialStatus,
          axes.analysisProvider,
          axes.redactionMode,
          axes.sendContentMode,
        );
      this.insertRevision(revisionId, recordId, 1, body, sha, tokens, ts);
    });
    // 先提交、后通知：回调那一侧要读库，读到的必须已经是刚写进去的这一版（B12）。
    this.notifyRevisionSaved(revisionId);
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
    // 只有真的建了版才通知：空 diff 那一次没有新版本，重排预跑等于给同一版再做一次
    // 「模型没跑成 ⇒ 再问一遍」，而那正是 M10-D-7 明令不做的自动重试。
    if (changed) this.notifyRevisionSaved(record.current_revision_id);
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
      // 外发判定读三轴（草案 §五）：`cloud_raw` 与 `cloud_redacted` 同样需要「先确认再发」，
      // 既有三档的流转结果逐字不变。
      const egress = isEgress(axesForNewRecord(chosen));
      if (from === "captured" && egress) {
        to = "awaiting_privacy_review";
      } else if (from === "awaiting_privacy_review" && !egress) {
        to = "not_processed";
      }
      if (to !== from && !isStateTransitionAllowed("processing_status", from, to)) {
        throw new RecordStateConflictError(`§4.8 未登记 ${from} → ${to}，改模式不得自创转换`);
      }
      const axes = axesForNewRecord(chosen);
      this.db
        .prepare(
          `update capture_record
              set processing_mode = ?, processing_status = ?,
                  analysis_provider = ?, redaction_mode = ?, send_content_mode = ?
            where id = ?`,
        )
        .run(chosen, to, axes.analysisProvider, axes.redactionMode, axes.sendContentMode, recordId);
      changed = true;
    });
    return { record: this.getRecordRow(recordId), changed };
  }

  /**
   * M9-4d-2（裁决 M9-D-15）：**单独**改这一条记录的脱敏档。
   *
   * 存在的理由：`processing_mode` 是四值封闭集且由三轴派生，`(cloud, local_llm, redacted)` 与
   * `(cloud, manual, redacted)` 派生后同为 `cloud_redacted`，界面因此表达不出「这次用本地模型脱敏」。
   * 再加一个 mode 值等于改 0008 的 CHECK（禁区），于是「谁来做脱敏」从「在哪分析」里拆出来，
   * 落在这一条只动 `redaction_mode` 一列的窄入口上。
   *
   * 三条边界：
   * - **只改一轴**：`analysis_provider` / `send_content_mode` 逐字取在册值不动，派生的
   *   `processing_mode` 按改后的三轴重算（与 `setProcessingMode` 同一手法）；
   * - **判据是既有的那两道门**：`coerceAxes` 收窄取值（不在册即拒，不静默兜底成保守组合），
   *   `assertThreeAxes` 核对组合（草案 §三 矩阵）。不成立时一个字节都不写——校验在任何写语句之前；
   * - **无副作用**：`redaction_mode` 不参与外发判定（`isEgress` 只看 `send_content_mode`），
   *   所以 `processing_status` 必然不动；这里不调 Provider、不写 grant、不清预览缓存。
   *   预览缓存留给上一档那份载荷：新档的载荷哈希不同，既有四腿核对自然让旧授权失效。
   */
  setRedactionMode(recordId: string, mode: unknown): { record: RecordRow; changed: boolean } {
    if (typeof mode !== "string") {
      throw new RecordValidationError("redaction_mode 必须是字符串");
    }
    let changed = false;
    this.inTransaction(() => {
      const record = this.getRecordRow(recordId);
      // 同值 ⇒ 幂等，不写库（`changed:false`，与 `setProcessingMode` 的口径一致）。
      if (record.redaction_mode === mode) return;
      const axes = coerceAxes(record.analysis_provider, mode, record.send_content_mode);
      assertThreeAxes(axes);
      const processingMode = deriveProcessingMode(axes);
      this.db
        .prepare(`update capture_record set redaction_mode = ?, processing_mode = ? where id = ?`)
        .run(axes.redactionMode, processingMode, recordId);
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
   * 一次取齐这批记录**当前版本**的修订号（M10-2 复核队列：一行要说清「看的是第几版」）。
   *
   * 与 `currentRawTexts` 同一个手法、同两张事实表：列表要 N 行时不逐条 `getRecord`
   * （那会把每条记录的全部历史版本都读一遍只为拿当前那一版）。只读，不动任何状态。
   */
  currentRevisionNumbers(recordIds: readonly string[]): Map<string, number> {
    const found = new Map<string, number>();
    if (recordIds.length === 0) return found;
    const rows = this.db
      .prepare(
        `select cr.id as record_id, rr.revision_number as revision_number
           from capture_record as cr
           join record_revision as rr on rr.id = cr.current_revision_id
          where cr.id in (${recordIds.map(() => "?").join(", ")})`,
      )
      .all(...recordIds) as unknown as Array<{ record_id: string; revision_number: number }>;
    for (const row of rows) found.set(row.record_id, row.revision_number);
    return found;
  }

  /**
   * 这一版**所属记录**的三轴（M10-1：预跑队列判定「这一条现在还要不要算」的唯一数据来源）。
   *
   * 只读：join `record_revision` → `capture_record` 两张事实表，不碰派生层，不写任何状态。
   * 为什么这个读法住在记录服务而不是队列里：列名与取值门是记录面的契约，队列自己写 SQL 等于
   * 在模型层再抄一份「怎么从库里读轴」——两处抄本漂移时没有任何测试会拦住。
   *
   * `null` = 这一版不在册（记录已被硬删除）。**不抛**：被删是「意图变了」，不是错误，
   * 调用方据此静默跳过（断言 B8）。在册但取值不在封闭集内 ⇒ 由 `coerceAxes` 抛，
   * 与路由侧 `axesOfRecord` 读侧那道门同取向——不静默兜底成保守组合。
   */
  axesOfRevision(recordRevisionId: string): ThreeAxes | null {
    const row = this.db
      .prepare(
        `select cr.analysis_provider, cr.redaction_mode, cr.send_content_mode
           from record_revision as rr
           join capture_record as cr on cr.id = rr.record_id
          where rr.id = ?`,
      )
      .get(recordRevisionId) as
      | { analysis_provider: string; redaction_mode: string; send_content_mode: string }
      | undefined;
    if (row === undefined) return null;
    return coerceAxes(row.analysis_provider, row.redaction_mode, row.send_content_mode);
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
