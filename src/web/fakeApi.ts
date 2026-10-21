/**
 * dev 假数据那一侧的取数层：把顶层那份假数据摊成 `/api/*` 的 `Response`，
 * 让**一行没改过**的产品面板在没有后端时也能渲染（门 2：无后端、`VITE_USE_MOCK=1`）。
 *
 * 为什么是假 `fetch` 而不是假 `api`：面板一律经 `apiClient.ts` 的 `request()` 走 `fetch`，
 * 只要在这层之前把 `globalThis.fetch` 换成这份路由，今天 / 全部记录 / 待整理 / 搜索 / 快速 / 睡前
 * 全部页都自动吃上假数据 —— 不必给每个面板开一个数据源分支，那份分支迟早漂移成第二个真相。
 *
 * 三条纪律：
 * 1. **只在动态 import 进来的入口里被调用**（`fakeDataEntry.tsx`）。生产静态图不含这一层，
 *    也不含 `fixtures/`（`tests/web-ui5-fixtures.test.ts` 钉死，构建产物扫描再钉一遍）。
 * 2. **形状逐字对齐 `src/shared/dto.ts`**：每个返回值都 `satisfies` 那个 DTO，
 *    字段一漂移就编译不过。假数据不许偷偷用一套和产品不同的形状。
 * 3. **派生内容只从盒子那条口出**（`fixturePort.ts` 的 `DataPort`）；记录详情这一侧把
 *    `ingestReady` 报成 `false`，于是它走「解析能力未就绪」那条既有诚实路径，
 *    不拿假的 `EffectiveResultDto` 去冒充真投影（那才是真正会骗人的地方）。
 */

import { makeSeedRecords, RAW } from "../../fixtures/data.ts";
import type { RecordItem, Revision } from "../../fixtures/types.ts";
import type { BackupListData } from "./apiClient.ts";
import type {
  DataCheckReport,
  DeletePhaseResult,
  EffectiveResultDto,
  GrantDto,
  ImportResult,
  IngestResultDto,
  IngestRunDto,
  ModelPrivacyConfigDto,
  PendingRecordDto,
  PendingRecordsResponse,
  RecordRow,
  RestoreResult,
  RevisionRow,
  SendPreviewDto,
  UpdateModelConfigDto,
} from "../shared/dto.ts";

/* ── 假 id / 假摘要：确定性生成，够界面切前 12 位看，不代表任何真实主键 ────────── */

/** 把任意字符串摊成 64 个十六进制字符的确定性假摘要（不是密码学哈希，只是形状占位）。 */
function fakeSha256(text: string): string {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  let out = "";
  for (let block = 0; block < 8; block += 1) {
    h = Math.imul(h ^ (block + 1), 2654435761) >>> 0;
    out += h.toString(16).padStart(8, "0");
  }
  return out;
}

function toIsoUtc(localWithOffset: string): string {
  const parsed = new Date(localWithOffset);
  return Number.isNaN(parsed.getTime()) ? `${localWithOffset.slice(0, 19)}Z` : parsed.toISOString();
}

/* ── 假记录的来源：fixture 那一份 RecordItem，按 id 摊平一次 ──────────────────── */

const SEEDS: readonly RecordItem[] = makeSeedRecords();
const SEED_BY_ID: Readonly<Record<string, RecordItem>> = Object.fromEntries(SEEDS.map((s) => [s.id, s]));

interface FakeRecord {
  row: RecordRow;
  revisions: RevisionRow[];
  current: RevisionRow;
}

function revisionRow(SeedId: string, revision: Revision, timezoneId: string): RevisionRow {
  return {
    id: revision.id,
    record_id: SeedId,
    revision_number: revision.number,
    raw_text: revision.rawText,
    content_sha256: fakeSha256(revision.rawText),
    created_at_utc: toIsoUtc(revision.createdAtLocal),
    created_at_local: revision.createdAtLocal,
    timezone_id: timezoneId,
  };
}

function buildRecord(seed: RecordItem): FakeRecord {
  const revisions = seed.revisions.map((revision) => revisionRow(seed.id, revision, seed.timezoneId));
  const current =
    revisions.find((revision) => revision.id === seed.currentRevisionId) ?? revisions[revisions.length - 1]!;
  const row: RecordRow = {
    id: seed.id,
    created_at_utc: toIsoUtc(seed.createdAtLocal),
    created_at_local: seed.createdAtLocal,
    timezone_id: seed.timezoneId,
    created_local_date: seed.createdAtLocal.slice(0, 10),
    current_revision_id: current.id,
    processing_status: seed.processingStatus,
    processing_mode: seed.processingMode,
    privacy_level: seed.privacyLevel,
  };
  return { row, revisions, current };
}

/** 服务端 §4.8 的待整理口径：PENDING_STATUSES 再排除 manual_only。 */
const PENDING_STATUSES: readonly string[] = [
  "captured",
  "awaiting_privacy_review",
  "needs_reparse",
  "failed",
  "not_processed",
];

const RECORD_LIST: FakeRecord[] = SEEDS.map(buildRecord).sort((a, b) =>
  a.row.created_at_utc < b.row.created_at_utc ? 1 : -1,
);

const RECORD_INDEX: Record<string, FakeRecord> = Object.fromEntries(RECORD_LIST.map((rec) => [rec.row.id, rec]));

/** 摘要文本（列表标题用）：原文取 `RAW`，新建/编辑之后取当前版本。 */
const RAW_BY_ID: Record<string, string> = Object.fromEntries(
  SEEDS.map((seed) => [seed.id, RAW[seed.id] ?? ""]),
);

/* ── 路由：返回 { status, body }，由 installFakeFetch 包成 Response ────────────── */

interface FakeReply {
  readonly status: number;
  readonly body: unknown;
}

const NOT_FOUND: FakeReply = { status: 404, body: { error: "not_found", detail: "假路由里没有这个端点。" } };

function listRecords(url: URL): FakeReply {
  const limit = Number(url.searchParams.get("limit") ?? "100");
  const offset = Number(url.searchParams.get("offset") ?? "0");
  const records = RECORD_LIST.slice(offset, offset + limit).map((rec) => rec.row);
  return { status: 200, body: { records, total: RECORD_LIST.length } };
}

function detailBody(rec: FakeRecord): unknown {
  return { record: rec.row, current: rec.current, revisions: rec.revisions };
}

function pendingBody(url: URL): FakeReply {
  const limit = Number(url.searchParams.get("limit") ?? "200");
  const records: PendingRecordDto[] = [];
  for (const rec of RECORD_LIST) {
    if (!PENDING_STATUSES.includes(rec.row.processing_status)) continue;
    if (rec.row.processing_mode === "manual_only") continue;
    const preview = (RAW_BY_ID[rec.row.id] ?? rec.current.raw_text).slice(0, 80);
    records.push({
      recordId: rec.row.id,
      currentRevisionId: rec.current.id,
      processingStatus: rec.row.processing_status,
      processingMode: rec.row.processing_mode,
      privacyLevel: rec.row.privacy_level,
      createdLocalDate: rec.row.created_local_date,
      preview,
    });
  }
  const response: PendingRecordsResponse = { records: records.slice(0, limit), total: records.length };
  return { status: 200, body: response };
}

function defaultConfig(): ModelPrivacyConfigDto {
  return {
    defaultMode: "local_model",
    modelEnabled: false,
    provider: null,
    model: null,
    callPath: null,
    cloudRedactedEnabled: false,
    requestTimeoutMs: 60000,
    apiKeyConfigured: false,
    ingestReady: false,
    localModel: {
      enabled: false,
      provider: "ollama",
      model: null,
      baseUrl: "http://127.0.0.1:11434/v1",
      callPath: "ollama_openai_compatible",
      supportsStructuredOutput: false,
      requestTimeoutMs: 60000,
      apiKeyEnv: "TB_LOCAL_MODEL_API_KEY",
      apiKeyConfigured: false,
      ready: false,
    },
    cloudModel: {
      enabled: false,
      provider: "openai_compatible",
      model: null,
      baseUrl: "https://provider.example/v1",
      callPath: "http_json_lenient",
      supportsStructuredOutput: false,
      requestTimeoutMs: 60000,
      apiKeyEnv: "TB_MODEL_API_KEY",
      apiKeyConfigured: false,
      ready: false,
    },
    restartRequired: false,
  };
}

let FAKE_CONFIG = defaultConfig();

function configBody(): ModelPrivacyConfigDto {
  return structuredClone(FAKE_CONFIG);
}

function saveConfigBody(body: unknown): FakeReply {
  if (typeof body !== "string") {
    return { status: 400, body: { error: "invalid_request", detail: "模型配置请求体缺失。" } };
  }
  let parsed: UpdateModelConfigDto;
  try {
    parsed = JSON.parse(body) as UpdateModelConfigDto;
  } catch {
    return { status: 400, body: { error: "invalid_json" } };
  }
  if (typeof parsed.localModel !== "object" || typeof parsed.cloudModel !== "object") {
    return { status: 400, body: { error: "invalid_request", detail: "需要本地与云端两档配置。" } };
  }

  const merge = (
    current: ModelPrivacyConfigDto["localModel"],
    next: UpdateModelConfigDto["localModel"],
  ): ModelPrivacyConfigDto["localModel"] => ({
    ...current,
    ...next,
    model: next.model.trim() === "" ? null : next.model.trim(),
    ready: false,
  });
  const localModel = merge(FAKE_CONFIG.localModel, parsed.localModel);
  const cloudModel = merge(FAKE_CONFIG.cloudModel, parsed.cloudModel);
  const primary = cloudModel.enabled ? cloudModel : localModel;
  FAKE_CONFIG = {
    ...FAKE_CONFIG,
    modelEnabled: localModel.enabled || cloudModel.enabled,
    cloudRedactedEnabled: cloudModel.enabled,
    requestTimeoutMs: primary.requestTimeoutMs,
    apiKeyConfigured: cloudModel.apiKeyConfigured,
    localModel,
    cloudModel,
    restartRequired: true,
  };
  return { status: 200, body: configBody() };
}

/**
 * 假侧那份 `effective`。
 *
 * `satisfies` 是前后端**单轨**的证据（M3-PROJ-1 红线③）：这份返回必须能通过扩集后的
 * `EffectiveResultDto` 形状检查。新增字段全部**可选**，所以这里一个都不填——
 * 「没有」与「空」在响应里可区分，假侧不冒充可读投影（`currentRunId = null` ⇒ 面板落到
 * 「这条还没有整理结果」那一格，而不是编一套 id 去填计数；盒子那五页才是假数据派生内容的家）。
 * dev 入口 `ingestReady: false` 走「解析未就绪」那条路，本轮**维持不变**。
 */
function effectiveBody(revisionId: string): EffectiveResultDto {
  return {
    revisionId,
    currentRunId: null,
    episodes: [],
    thoughts: [],
    emotions: [],
    topics: [],
    entities: [],
    candidates: [],
    overrides: [],
  } satisfies EffectiveResultDto;
}

function searchBody(url: URL): FakeReply {
  const query = (url.searchParams.get("q") ?? "").trim();
  const hits =
    query === ""
      ? []
      : RECORD_LIST.filter((rec) => (RAW_BY_ID[rec.row.id] ?? "").includes(query)).map((rec) => ({
          ...rec.current,
          record_created_local_date: rec.row.created_local_date,
        }));
  return { status: 200, body: { hits } };
}

/** 创建一条假记录（quick / sleep 的「保存」走这条）：写进内存表，切页就能看到。
 *  M5-1：可选 processing_mode 与服务端口径一致——缺省 manual_only；显式 cloud 落 awaiting_privacy_review。 */
let syntheticCounter = 0;

function createRecord(text: string, mode = "manual_only"): FakeReply {
  syntheticCounter += 1;
  const id = `rec_demo_new_${syntheticCounter}`;
  const now = new Date();
  const local = `${now.toISOString().slice(0, 19)}+08:00`;
  const revisionId = `rev_${id}_1`;
  const revision: RevisionRow = {
    id: revisionId,
    record_id: id,
    revision_number: 1,
    raw_text: text,
    content_sha256: fakeSha256(text),
    created_at_utc: now.toISOString(),
    created_at_local: local,
    timezone_id: "Asia/Shanghai",
  };
  const row: RecordRow = {
    id,
    created_at_utc: now.toISOString(),
    created_at_local: local,
    timezone_id: "Asia/Shanghai",
    created_local_date: local.slice(0, 10),
    current_revision_id: revisionId,
    processing_status: mode === "cloud_redacted" ? "awaiting_privacy_review" : "captured",
    processing_mode: mode,
    privacy_level: "normal",
  };
  RAW_BY_ID[id] = text;
  RECORD_INDEX[id] = { row, revisions: [revision], current: revision };
  RECORD_LIST.unshift({ row, revisions: [revision], current: revision });
  return { status: 201, body: { record: row, revision } };
}

/** §4.8 已登记边的假镜像（与 records/service.ts setProcessingMode 同规则）。 */
function setMode(rec: FakeRecord, mode: string): FakeReply {
  if (!["manual_only", "local_model", "cloud_redacted"].includes(mode)) {
    return { status: 400, body: { error: "invalid_request", detail: "processing_mode 取值非法", issues: ["processing_mode"] } };
  }
  if (rec.row.processing_mode === mode) {
    return { status: 200, body: { record: rec.row, changed: false } };
  }
  const from = rec.row.processing_status;
  if (from === "preprocessing" || from === "processing") {
    return { status: 409, body: { error: "state_conflict", detail: `记录正在 ${from}，拒绝改模式` } };
  }
  let to = from;
  if (from === "captured" && mode === "cloud_redacted") to = "awaiting_privacy_review";
  else if (from === "awaiting_privacy_review" && mode !== "cloud_redacted") to = "not_processed";
  rec.row = { ...rec.row, processing_mode: mode, processing_status: to };
  return { status: 200, body: { record: rec.row, changed: true } };
}

function deleteBody(rec: FakeRecord): DeletePhaseResult {
  const result: DeletePhaseResult = {
    phaseA: { committed: true, revisionsRemoved: rec.revisions.length },
    phaseB: { status: "ok" },
  };
  delete RECORD_INDEX[rec.row.id];
  const at = RECORD_LIST.findIndex((entry) => entry.row.id === rec.row.id);
  if (at >= 0) RECORD_LIST.splice(at, 1);
  return result;
}

function editRecord(id: string, text: string): FakeReply {
  const rec = RECORD_INDEX[id];
  if (rec === undefined) return NOT_FOUND;
  const changed = text !== rec.current.raw_text;
  if (!changed) return { status: 200, body: { record: rec.row, revision: rec.current, changed: false } };
  const revision: RevisionRow = {
    id: `${rec.current.id}_v${rec.revisions.length + 1}`,
    record_id: id,
    revision_number: rec.revisions.length + 1,
    raw_text: text,
    content_sha256: fakeSha256(text),
    created_at_utc: toIsoUtc(rec.current.created_at_local),
    created_at_local: rec.current.created_at_local,
    timezone_id: rec.current.timezone_id,
  };
  rec.revisions = [...rec.revisions, revision];
  rec.current = revision;
  rec.row = { ...rec.row, current_revision_id: revision.id };
  RAW_BY_ID[id] = text;
  return { status: 200, body: { record: rec.row, revision, changed: true } };
}

function emptyIngestResult(recordId: string): IngestResultDto {
  return {
    runId: `run_${recordId}_fake`,
    idempotencyKey: `key_${recordId}`,
    pipelineFingerprint: fakeSha256(recordId).slice(0, 16),
    processingMode: "local_model",
    succeeded: false,
    replayed: false,
    recovered: false,
    provider: "（未装配）",
    model: "（未配置）",
    callPath: "（未配置）",
    attemptedPaths: [],
    degraded: false,
    errorKind: "provider_unavailable",
    writes: {
      episodes: 0,
      thoughts: 0,
      mentions: 0,
      rejectedMentions: 0,
      suggestions: 0,
      evidenceRepairs: 0,
      deduplicated: 0,
      unrouted: 0,
      unresolvedEntities: 0,
    },
    title: "假数据里不发起真整理",
    summary: "这一屏是假数据：解析能力按未就绪报，发起整理只会得到这一句。",
    failure: {
      errorKind: "provider_unavailable",
      retryable: false,
      message: "假数据侧没有装配 Provider，也没有真的整理过任何一条。",
      issues: [],
    },
  };
}

function emptyRun(recordId: string): IngestRunDto {
  return {
    runId: `run_${recordId}_fake`,
    sourceRevisionId: recordId,
    executionStatus: "failed",
    resultState: "candidate",
    errorKind: "provider_unavailable",
    idempotencyKey: `key_${recordId}`,
    pipelineFingerprint: fakeSha256(recordId).slice(0, 16),
    startedAtUtc: new Date().toISOString(),
    finishedAtUtc: new Date().toISOString(),
  };
}

function previewBody(rec: FakeRecord): SendPreviewDto {
  const text = RAW_BY_ID[rec.row.id] ?? rec.current.raw_text;
  return {
    recordId: rec.row.id,
    recordRevisionId: rec.current.id,
    revisionNumber: rec.current.revision_number,
    policyVersion: "demo-1",
    redactedText: text,
    payloadText: text,
    payloadSha256: fakeSha256(text),
    hasApplicableGrant: SEED_BY_ID[rec.row.id]?.grant !== null && SEED_BY_ID[rec.row.id] !== undefined,
  };
}

function grantBody(rec: FakeRecord): GrantDto {
  return {
    grantId: `grant_${rec.current.id}`,
    recordRevisionId: rec.current.id,
    payloadSha256: fakeSha256(RAW_BY_ID[rec.row.id] ?? rec.current.raw_text),
    policyVersion: "demo-1",
    confirmedAtUtc: new Date().toISOString(),
  };
}

function backupsBody(): BackupListData {
  return {
    backups: [],
    totalBytes: 0,
    lastBackupUtc: null,
    lastSuccessUtc: null,
    disk: { available: false, reason: "假数据侧不读真实磁盘" },
  };
}

function dataCheckBody(): DataCheckReport & { ok: boolean } {
  return {
    ok: true,
    schemaVersion: 5,
    passedSteps: ["假数据侧不跑真核验"],
    searchIndexRebuilt: false,
    desyncBeforeRebuild: null,
  };
}

function route(input: string | URL, init?: { readonly method?: string; readonly body?: unknown }): FakeReply {
  const url = typeof input === "string" ? new URL(input, "http://fake.local") : new URL(input.href);
  const method = (init?.method ?? "GET").toUpperCase();
  const path = url.pathname;

  if (path === "/api/health") return { status: 200, body: healthBody() };

  if (path === "/api/records") {
    if (method === "POST") return createRecord(readTextField(init?.body), readModeField(init?.body) ?? "manual_only");
    return listRecords(url);
  }

  const modeMatch = /^\/api\/records\/([^/]+)\/mode$/.exec(path);
  if (modeMatch?.[1] !== undefined) {
    const id = decodeURIComponent(modeMatch[1]);
    const rec = RECORD_INDEX[id];
    if (rec === undefined) return NOT_FOUND;
    if (method === "PATCH") return setMode(rec, readModeField(init?.body) ?? "");
  }

  const recordMatch = /^\/api\/records\/([^/]+)$/.exec(path);
  if (recordMatch?.[1] !== undefined) {
    const id = decodeURIComponent(recordMatch[1]);
    const rec = RECORD_INDEX[id];
    if (rec === undefined) return NOT_FOUND;
    if (method === "DELETE") return { status: 200, body: deleteBody(rec) };
    if (method === "PUT") return editRecord(id, readTextField(init?.body));
    return { status: 200, body: detailBody(rec) };
  }

  if (path === "/api/search") return searchBody(url);
  if (path === "/api/storage-maintenance") return { status: 200, body: { pending: [] } };
  if (path === "/api/storage-maintenance/retry") return { status: 200, body: { ok: true, resolvedTasks: 0 } };
  if (path === "/api/backups") return { status: 200, body: backupsBody() };
  if (/^\/api\/backups\/.+\/verify$/.test(path)) return NOT_FOUND;
  if (/^\/api\/backups\/.+/.test(path) && method === "DELETE") return { status: 200, body: { deleted: "" } };
  if (path === "/api/import/jsonl") {
    const imported: ImportResult = { records: 0, revisions: 0 };
    return { status: 200, body: imported };
  }
  if (path === "/api/restore") {
    const restored: RestoreResult = {
      restoredFrom: "",
      safetyBackupName: "",
      fromSchemaVersion: 5,
      schemaVersion: 5,
      records: RECORD_LIST.length,
      revisions: RECORD_LIST.length,
      searchIndexRebuilt: false,
      maintenanceTasksFound: 0,
      maintenanceResolved: 0,
      maintenanceOk: true,
      maintenanceDetail: null,
    };
    return { status: 200, body: restored };
  }
  if (path === "/api/data-check") return { status: 200, body: dataCheckBody() };

  if (path === "/api/ingest/pending") return pendingBody(url);
  if (path === "/api/ingest/config") {
    return method === "PUT" ? saveConfigBody(init?.body) : { status: 200, body: configBody() };
  }
  if (path === "/api/ingest/preview") {
    const rec = recordFromBody(init?.body);
    return rec === null ? NOT_FOUND : { status: 200, body: previewBody(rec) };
  }
  if (path === "/api/ingest/confirm-send") {
    const rec = recordFromBody(init?.body);
    return rec === null ? NOT_FOUND : { status: 200, body: grantBody(rec) };
  }
  if (path === "/api/ingest/parse") {
    return { status: 200, body: emptyIngestResult(recordIdFromBody(init?.body) ?? "") };
  }
  const reparseMatch = /^\/api\/ingest\/records\/([^/]+)\/reparse$/.exec(path);
  if (reparseMatch?.[1] !== undefined) {
    return { status: 200, body: emptyIngestResult(decodeURIComponent(reparseMatch[1])) };
  }
  const retryMatch = /^\/api\/ingest\/runs\/([^/]+)\/retry$/.exec(path);
  if (retryMatch?.[1] !== undefined) {
    return { status: 200, body: emptyIngestResult(decodeURIComponent(retryMatch[1])) };
  }
  const runMatch = /^\/api\/ingest\/runs\/([^/]+)$/.exec(path);
  if (runMatch?.[1] !== undefined) {
    return { status: 200, body: emptyRun(decodeURIComponent(runMatch[1])) };
  }
  const effectiveMatch = /^\/api\/ingest\/effective\/([^/]+)$/.exec(path);
  if (effectiveMatch?.[1] !== undefined) {
    return { status: 200, body: effectiveBody(decodeURIComponent(effectiveMatch[1])) };
  }
  if (path === "/api/export/jsonl") return { status: 200, body: { error: "fake_export_unsupported" } };

  return NOT_FOUND;
}

function healthBody(): unknown {
  return {
    app: "思绪盒子",
    status: "ok",
    schemaVersion: 5,
    sqliteVersion: "3.x（假数据，未连库）",
    dataDir: "fixtures/（这一屏一条真实数据都没读）",
    boundTo: "127.0.0.1:8737（假）",
  };
}

function readTextField(body: unknown): string {
  if (typeof body !== "string") return "";
  try {
    const parsed = JSON.parse(body) as { text?: unknown };
    return typeof parsed.text === "string" ? parsed.text : "";
  } catch {
    return body;
  }
}

function readModeField(body: unknown): string | null {
  if (typeof body !== "string") return null;
  try {
    const parsed = JSON.parse(body) as { processing_mode?: unknown };
    return typeof parsed.processing_mode === "string" ? parsed.processing_mode : null;
  } catch {
    return null;
  }
}

function recordIdFromBody(body: unknown): string | null {
  if (typeof body !== "string") return null;
  try {
    const parsed = JSON.parse(body) as { recordId?: unknown };
    return typeof parsed.recordId === "string" ? parsed.recordId : null;
  } catch {
    return null;
  }
}

function recordFromBody(body: unknown): FakeRecord | null {
  const id = recordIdFromBody(body);
  return id === null ? null : (RECORD_INDEX[id] ?? null);
}

/** 把 `globalThis.fetch` 换成这份假路由；返回还原函数。只在 dev 入口里调用。 */
export function installFakeFetch(): () => void {
  const previous = globalThis.fetch;
  const fake: typeof globalThis.fetch = (input, init) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    let isApi = false;
    try {
      isApi = new URL(raw, window.location.origin).pathname.startsWith("/api/");
    } catch {
      isApi = raw.startsWith("/api/");
    }
    if (!isApi) return previous.call(globalThis, input, init);
    const reply = route(raw, init);
    return Promise.resolve(
      new Response(JSON.stringify(reply.body), {
        status: reply.status,
        headers: { "content-type": "application/json" },
      }),
    );
  };
  globalThis.fetch = fake;
  return () => {
    globalThis.fetch = previous;
  };
}
