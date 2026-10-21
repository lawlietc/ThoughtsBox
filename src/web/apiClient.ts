import type {
  AdoptRunResultDto,
  BackupEntry,
  BackupVerification,
  ConfirmCandidatesResultDto,
  DataCheckReport,
  DeletePhaseResult,
  DiscardRunResultDto,
  DiskCapacity,
  EffectiveResultDto,
  GrantDto,
  ImportResult,
  IngestResultDto,
  IngestRunDto,
  ModelPrivacyConfigDto,
  PendingRecordsResponse,
  RecordRow,
  RestoreResult,
  RevisionRow,
  SendPreviewDto,
  StorageMaintenanceTask,
  UpdateModelConfigDto,
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
  ingestConfig: () => request<ModelPrivacyConfigDto>("/api/ingest/config"),
  updateModelConfig: (body: UpdateModelConfigDto) =>
    jsonCall<ModelPrivacyConfigDto>("PUT", "/api/ingest/config", body),
  ingestParse: (body: { recordId: string; processingMode?: string; payloadText?: string }) =>
    jsonCall<IngestResultDto>("POST", "/api/ingest/parse", body),
  ingestReparse: (recordId: string) =>
    jsonCall<IngestResultDto>("POST", `/api/ingest/records/${encodeURIComponent(recordId)}/reparse`, {}),
  ingestRun: (runId: string) => request<IngestRunDto>(`/api/ingest/runs/${encodeURIComponent(runId)}`),
  ingestRetryRun: (runId: string) =>
    jsonCall<IngestResultDto>("POST", `/api/ingest/runs/${encodeURIComponent(runId)}/retry`, {}),
  ingestPreview: (body: { recordId: string; payloadText?: string }) =>
    jsonCall<SendPreviewDto>("POST", "/api/ingest/preview", body),
  ingestConfirmSend: (body: { recordId: string; payloadText?: string }) =>
    jsonCall<GrantDto>("POST", "/api/ingest/confirm-send", body),
  ingestConfirmCandidates: (body: { recordId: string; adopted: { term: string; kind: string }[] }) =>
    jsonCall<ConfirmCandidatesResultDto>("POST", "/api/ingest/confirm-candidates", body),
  ingestEffective: (revisionId: string) =>
    request<EffectiveResultDto>(`/api/ingest/effective/${encodeURIComponent(revisionId)}`),
  /** op7' 采纳候选 run（§四-8 收账：服务面 adoptCurrent 早有，对外这一格本轮补上）。 */
  ingestAdopt: (candidateRunId: string) =>
    jsonCall<AdoptRunResultDto>("POST", "/api/ingest/adopt", { candidateRunId }),
  /** op7'' 放弃候选 run（服务面 discardCandidate：candidate→superseded，不是删除）。 */
  ingestDiscard: (candidateRunId: string) =>
    jsonCall<DiscardRunResultDto>("POST", "/api/ingest/discard", { candidateRunId }),
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
