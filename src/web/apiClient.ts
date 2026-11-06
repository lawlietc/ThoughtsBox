import type {
  AdoptRunResultDto,
  BackupEntry,
  BackupVerification,
  DataCheckReport,
  DeletePhaseResult,
  DiscardRunResultDto,
  DiskCapacity,
  EffectiveResultDto,
  EntityPromoteResultDto,
  GrantDto,
  ImportResult,
  IngestResultDto,
  IngestRunDto,
  JobListDto,
  JobViewDto,
  LocalLlmTestResultDto,
  ModelConnectionTestResultDto,
  ModelPrivacyConfigDto,
  PendingRecordsResponse,
  ProcessingDefaultsDto,
  RecordRow,
  RestoreResult,
  ReviewQueueResponse,
  RevisionRow,
  SendPreviewDto,
  StorageMaintenanceTask,
  TestLocalLlmRequestDto,
  UpdateModelConfigDto,
  UpdateProcessingDefaultsDto,
  TestModelConnectionRequestDto,
  VocabularyEntityDto,
  VocabularyResponseDto,
} from "../shared/dto.ts";

/**
 * 本地后端 API 客户端（§4.2：所有页面数据来自真实 API，无静态 mock）。
 * 错误统一成 ApiError：带状态码与服务端策展过的 detail/逐行问题清单，
 * UI 展示服务端原文，不自行推测业务状态。
 */

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly detail: string;
  readonly issues: string[];
  /** data-check 失败时服务端会点名失败步骤（M1b §8.2：哪一步、为什么）。 */
  readonly step: string | null;

  constructor(status: number, code: string, detail: string, issues: string[] = [], step: string | null = null) {
    super(detail);
    this.status = status;
    this.code = code;
    this.detail = detail;
    this.issues = issues;
    this.step = step;
  }
}

export interface Health {
  app: string;
  status: string;
  schemaVersion: number;
  sqliteVersion: string;
  dataDir: string;
  boundTo: string;
}

export interface RecordDetailData {
  record: RecordRow;
  current: RevisionRow;
  revisions: RevisionRow[];
}

export interface SearchHit extends RevisionRow {
  record_created_local_date: string;
}

export interface BackupListData {
  backups: BackupEntry[];
  totalBytes: number;
  lastBackupUtc: string | null;
  lastSuccessUtc: string | null;
  disk: DiskCapacity;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, init);
  } catch {
    throw new ApiError(0, "network_error", "无法连接本地后端：请确认服务器已启动（npm run start:server）。");
  }
  const text = await response.text();
  let body: unknown = null;
  if (text !== "") {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }
  if (!response.ok) {
    const parsed = (body ?? {}) as { error?: string; detail?: string; issues?: string[]; step?: string };
    throw new ApiError(
      response.status,
      parsed.error ?? `http_${response.status}`,
      parsed.detail ?? `请求失败（HTTP ${response.status}）`,
      parsed.issues ?? [],
      parsed.step ?? null,
    );
  }
  return body as T;
}

function jsonCall<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers = { "content-type": "application/json" };
  return request<T>(path, body === undefined ? { method, headers } : { method, headers, body: JSON.stringify(body) });
}

export const api = {
  health: () => request<Health>("/api/health"),
  listRecords: (limit = 100, offset = 0) =>
    request<{ records: RecordRow[]; total: number }>(`/api/records?limit=${limit}&offset=${offset}`),
  createRecord: (text: string, mode?: string) =>
    jsonCall<{ record: RecordRow; revision: RevisionRow }>("POST", "/api/records", {
      text,
      processing_mode: mode,
    }),
  getRecord: (id: string) =>
    request<RecordDetailData>(`/api/records/${encodeURIComponent(id)}`),
  setRecordMode: (id: string, mode: string) =>
    jsonCall<{ record: RecordRow; changed: boolean }>(
      "PATCH",
      `/api/records/${encodeURIComponent(id)}/mode`,
      { processing_mode: mode },
    ),
  /**
   * M9-4d-2（裁决 M9-D-15）：只改这一条记录的**脱敏档**（`redaction_mode`）。
   * 与 `setRecordMode` 是两件事：那一头改「在哪分析、发什么」，这一头改「谁来做脱敏」，
   * 服务端因此拒绝请求体里出现别的轴字段。
   */
  setRecordRedactionMode: (id: string, redactionMode: string) =>
    jsonCall<{ record: RecordRow; changed: boolean }>(
      "PATCH",
      `/api/records/${encodeURIComponent(id)}/redaction-mode`,
      { redaction_mode: redactionMode },
    ),
  editRecord: (id: string, text: string) =>
    jsonCall<{ record: RecordRow; revision: RevisionRow; changed: boolean }>(
      "PUT",
      `/api/records/${encodeURIComponent(id)}`,
      { text },
    ),
  deleteRecord: (id: string) =>
    request<DeletePhaseResult>(`/api/records/${encodeURIComponent(id)}`, { method: "DELETE" }),
  search: (q: string) =>
    request<{ hits: SearchHit[] }>(`/api/search?q=${encodeURIComponent(q)}`),
  maintenance: () => request<{ pending: StorageMaintenanceTask[] }>("/api/storage-maintenance"),
  retryMaintenance: () =>
    request<{ ok: boolean; resolvedTasks: number; detail?: string }>(
      "/api/storage-maintenance/retry",
      { method: "POST" },
    ),
  listBackups: () => request<BackupListData>("/api/backups"),
  createBackup: () => jsonCall<{ backup: BackupEntry }>("POST", "/api/backups"),
  verifyBackup: (name: string) =>
    jsonCall<{ name: string; verification: BackupVerification }>(
      "POST",
      `/api/backups/${encodeURIComponent(name)}/verify`,
    ),
  deleteBackup: (name: string) =>
    request<{ deleted: string }>(`/api/backups/${encodeURIComponent(name)}`, { method: "DELETE" }),
  importJsonl: (text: string) =>
    request<ImportResult>("/api/import/jsonl", {
      method: "POST",
      headers: { "content-type": "text/plain; charset=utf-8" },
      body: text,
    }),
  restore: (file: string) =>
    jsonCall<RestoreResult>("POST", "/api/restore", { file, confirm: true }),
  dataCheck: () => request<DataCheckReport & { ok: boolean }>("/api/data-check"),

  // ── M2-6 Ingest / 隐私 / 修正 面（§十二）：类型全部来自 shared/dto.ts，不双轨 ──
  ingestPending: (limit = 200) =>
    request<PendingRecordsResponse>(`/api/ingest/pending?limit=${limit}`),
  /**
   * M10-2 复核队列（只读派生）：外发轨记录的「本机算好了 / 用户点头了 / 本机模型跑成了没有」。
   * 服务端这一侧一个字节都不写、一个模型都不问——它是观测面，不是动作入口。
   */
  reviewQueue: () => request<ReviewQueueResponse>("/api/ingest/review-queue"),
  ingestConfig: () => request<ModelPrivacyConfigDto>("/api/ingest/config"),
  updateModelConfig: (body: UpdateModelConfigDto) =>
    jsonCall<ModelPrivacyConfigDto>("PUT", "/api/ingest/config", body),
  updateProcessingDefaults: (body: UpdateProcessingDefaultsDto) =>
    jsonCall<ProcessingDefaultsDto>("PATCH", "/api/ingest/config/processing", body),
  testModelConnection: (body: TestModelConnectionRequestDto) =>
    jsonCall<ModelConnectionTestResultDto>("POST", "/api/ingest/config/test", body),
  /**
   * M9-4d-1b：本地脱敏档的连接测试。带 `profile` ⇒ 服务端测**草稿**（不写盘）；
   * 省缺（空 body）⇒ 读已保存的那一档。两种情况服务端都只发一条固定占位消息，绝不含原文。
   */
  testLocalLlm: (body: TestLocalLlmRequestDto = {}) =>
    jsonCall<LocalLlmTestResultDto>("POST", "/api/ingest/local-llm/test", body),
  ingestParse: (body: { recordId: string; processingMode?: string; payloadText?: string }) =>
    jsonCall<IngestResultDto>("POST", "/api/ingest/parse", body),
  ingestReparse: (recordId: string) =>
    jsonCall<IngestResultDto>("POST", `/api/ingest/records/${encodeURIComponent(recordId)}/reparse`, {}),
  /**
   * M8-2 重新分析。服务端不读请求体，所以这里一个字节都不发（`{}` 是 op5 的历史写法，不是惯例）。
   * 它与 op5 是两件事：reparse 撞同一个幂等键（重放），reanalyze 换尝试序号**再开一单**，
   * 产出仍是 candidate。该版本有 run 在途 ⇒ 409 `state_conflict`，理由在服务端 detail 里。
   */
  ingestReanalyze: (recordId: string) =>
    request<IngestResultDto>(`/api/ingest/records/${encodeURIComponent(recordId)}/reanalyze`, {
      method: "POST",
    }),
  ingestRun: (runId: string) => request<IngestRunDto>(`/api/ingest/runs/${encodeURIComponent(runId)}`),
  ingestRetryRun: (runId: string) =>
    jsonCall<IngestResultDto>("POST", `/api/ingest/runs/${encodeURIComponent(runId)}/retry`, {}),
  ingestPreview: (body: { recordId: string; payloadText?: string; force?: boolean }) =>
    jsonCall<SendPreviewDto>("POST", "/api/ingest/preview", body),
  ingestConfirmSend: (body: { recordId: string; payloadText?: string }) =>
    jsonCall<GrantDto>("POST", "/api/ingest/confirm-send", body),
  ingestEffective: (revisionId: string) =>
    request<EffectiveResultDto>(`/api/ingest/effective/${encodeURIComponent(revisionId)}`),
  /** op7' 采纳候选 run（§四-8 收账：服务面 adoptCurrent 早有，对外这一格本轮补上）。 */
  ingestAdopt: (candidateRunId: string) =>
    jsonCall<AdoptRunResultDto>("POST", "/api/ingest/adopt", { candidateRunId }),
  ingestUndoAdopt: (runId: string) =>
    jsonCall<{ undoneRunId: string }>("POST", "/api/ingest/undo-adopt", { runId }),
  /** op7'' 放弃候选 run（服务面 discardCandidate：candidate→superseded，不是删除）。 */
  ingestDiscard: (candidateRunId: string) =>
    jsonCall<DiscardRunResultDto>("POST", "/api/ingest/discard", { candidateRunId }),

  // ── M8-1 实体转正面：唯一的 provisional → active 写入路径，用户手动那一下 ──
  /**
   * 转正一个待转正实体。幂等：已转正的回 `promoted: false`（200，不是冲突）；
   * 已归档 ⇒ 409，实体不在册 ⇒ 404，两者都由 `ApiError` 带着服务端原话上屏。
   */
  entityPromote: (entityId: string) =>
    jsonCall<EntityPromoteResultDto>("POST", "/api/entities/promote", { entityId }),

  // ── Phase D / S10 词表管理：只列 person / place / organization，关闭只影响 L1 ──
  entityVocabulary: () => request<VocabularyResponseDto>("/api/entities/vocabulary"),
  entitySetMask: (entityId: string, maskEnabled: boolean) =>
    jsonCall<VocabularyEntityDto>(
      "PATCH",
      `/api/entities/${encodeURIComponent(entityId)}/mask`,
      { maskEnabled },
    ),

  // ── M6-1D 后台队列面（0E §六/§七）：手动入队 + 轮询观测，形状全部来自 shared/dto.ts ──
  /**
   * `POST /api/jobs`：把这一条记录排到后台处理（用户显式动作，保存后不自动入队）。
   * 新建 ⇒ 201，同 revision 已在册 ⇒ 200 同一行（幂等键那份语义在服务端），两者都回 `JobViewDto`。
   */
  enqueueJob: (recordId: string) => jsonCall<JobViewDto>("POST", "/api/jobs", { recordId }),
  /** `GET /api/jobs?recordId=`：该记录的任务，时间序从旧到新；观测走轮询，不建 SSE。 */
  listJobs: (recordId: string) =>
    request<JobListDto>(`/api/jobs?recordId=${encodeURIComponent(recordId)}`),
};

export const EXPORT_JSONL_PATH = "/api/export/jsonl";

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

export function apiMessage(cause: unknown): string {
  return cause instanceof ApiError ? cause.detail : "未预期的前端错误，请重试。";
}
