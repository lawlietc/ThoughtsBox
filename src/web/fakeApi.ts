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
 *    web-redesign 第二步加了一个**默认关**的样张开关（`setFakeRichResult`，见 §样张），
 *    打开它唯一的路径是 dev 入口读到 `?rich=1`；关着时这一条纪律与从前逐字相同。
 */

import { makeSeedRecords, RAW } from "../../fixtures/data.ts";
import type { RecordItem, Revision } from "../../fixtures/types.ts";
import {
  axesForProcessingMode,
  deriveProcessingMode,
  isEgress,
  isLegalCombination,
  PROCESSING_MODE_VALUES,
  REDACTION_MODE_VALUES,
  type ProcessingModeValue,
  type RedactionMode,
  type ThreeAxes,
} from "../shared/contracts/enums.ts";
import type { BackupListData } from "./apiClient.ts";
import type {
  DataCheckReport,
  DeletePhaseResult,
  EffectiveEvidenceDto,
  EffectiveResultDto,
  GrantDto,
  ImportResult,
  IngestResultDto,
  IngestRunDto,
  JobListDto,
  JobViewDto,
  LocalLlmTestResultDto,
  ModelConnectionTestResultDto,
  ModelPrivacyConfigDto,
  PendingRecordDto,
  PendingRecordsResponse,
  ProcessingDefaultsDto,
  RecordRow,
  RestoreResult,
  ReviewQueueEntryDto,
  ReviewQueueResponse,
  RevisionRow,
  SendPreviewDto,
  TestModelConnectionRequestDto,
  UpdateModelConfigDto,
  UpdateProcessingDefaultsDto,
  VocabularyEntityDto,
  VocabularyResponseDto,
} from "../shared/dto.ts";
import { localLlmFailureHeadline } from "./localLlmSettings.ts";
import {
  DEFAULT_API_KEY_ENV,
  type LocalLlmUnusableReason,
} from "../shared/constants/model.ts";

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

/** 取值是否在册：封闭清单取 `contracts/enums.ts`（与 enums.json 装载时对账），这里不另抄一份。 */
function isKnownMode(mode: string): boolean {
  return (PROCESSING_MODE_VALUES as readonly string[]).includes(mode);
}

/**
 * 假后端的判定源与真服务端同源（草案 §四 旧值映射 + §五 派生）：记录上的三轴由那一行的
 * `processing_mode` 现派生，不另抄一份取值表。取值不在册即抛——「宁可白屏一次」与
 * `ui/labels.ts` 的装载期双向核对是同一条纪律；静默兜底会让 demo 带着过期的取值世界跑。
 */
function fakeAxesOf(mode: string): ThreeAxes {
  if (!isKnownMode(mode)) {
    throw new Error(`fakeApi：processing_mode 取值不在册（${mode}）`);
  }
  return axesForProcessingMode(mode as ProcessingModeValue);
}

function buildRecord(seed: RecordItem): FakeRecord {
  const revisions = seed.revisions.map((revision) => revisionRow(seed.id, revision, seed.timezoneId));
  const current =
    revisions.find((revision) => revision.id === seed.currentRevisionId) ?? revisions[revisions.length - 1]!;
  const axes = fakeAxesOf(seed.processingMode);
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
    analysis_provider: axes.analysisProvider,
    redaction_mode: axes.redactionMode,
    send_content_mode: axes.sendContentMode,
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
    // 判定读三轴（与 ingestRoutes.ts op1 同口径）：`analysis_provider=none` 就是派生的 manual_only。
    if (rec.row.analysis_provider === "none") continue;
    const preview = (RAW_BY_ID[rec.row.id] ?? rec.current.raw_text).slice(0, 80);
    records.push({
      recordId: rec.row.id,
      currentRevisionId: rec.current.id,
      processingStatus: rec.row.processing_status,
      processingMode: rec.row.processing_mode,
      axes: {
        analysisProvider: rec.row.analysis_provider,
        redactionMode: rec.row.redaction_mode,
        sendContentMode: rec.row.send_content_mode,
      },
      privacyLevel: rec.row.privacy_level,
      createdLocalDate: rec.row.created_local_date,
      preview,
    });
  }
  const response: PendingRecordsResponse = { records: records.slice(0, limit), total: records.length };
  return { status: 200, body: response };
}

/**
 * 假侧的「这一版本机算过没有」登记（M10-2 队列 `hasPayload` 的对应物）。
 *
 * 真服务端问的是 `app_meta` 里那两枚载荷缓存键在不在；假后端没有 app_meta，于是记一件等价的事：
 * 这一版有没有被预览过（预览正是真侧写下载荷的那一刻）。**不预置**：演示数据一打开队列，
 * 看到的就该是「还没算出来」顶在上面，而不是假装全本机都跑过了。
 */
const FAKE_PREVIEWED = new Set<string>();

/** 队列秩：没检查成 → 没载荷 → 没授权 → 都已就绪（与 `ingestRoutes.ts` 的 `reviewQueueRank` 同一口径）。 */
function reviewQueueRankOf(entry: ReviewQueueEntryDto): number {
  if (entry.llm.failureKind !== null) return 0;
  if (entry.hasPayload !== true) return 1;
  if (entry.hasGrant !== true) return 2;
  return 3;
}

function reviewQueueBody(): FakeReply {
  const entries: ReviewQueueEntryDto[] = [];
  for (const rec of RECORD_LIST) {
    const axes = {
      analysisProvider: rec.row.analysis_provider,
      redactionMode: rec.row.redaction_mode,
      sendContentMode: rec.row.send_content_mode,
    };
    // 与真侧同一条排除（断言 C6）：`send_content_mode=none` 没有要发的东西，复核它没有意义。
    if (!isEgress(axes)) continue;
    const isRawTrack = axes.sendContentMode === "raw";
    // 四腿取假侧预览/确认共用的那一套取值，队列不另发明判据。
    const hasGrant = findApplicableGrant(previewFields(rec)) !== null;
    const hasPayload = isRawTrack || FAKE_PREVIEWED.has(rec.current.id);
    // 与真侧 `reviewQueueNextAction` 同一优先级（假侧没有预跑队列，checking 恒为 false）。
    const nextAction: ReviewQueueEntryDto["nextAction"] = !hasGrant
      ? "confirm"
      : PENDING_STATUSES.includes(rec.row.processing_status)
        ? "organize"
        : null;
    const entry: ReviewQueueEntryDto = {
      recordId: rec.row.id,
      currentRevisionId: rec.current.id,
      revisionNumber: rec.current.revision_number,
      axes,
      processingStatus: rec.row.processing_status,
      processingMode: deriveProcessingMode(axes),
      privacyLevel: rec.row.privacy_level,
      needsAction: nextAction !== null,
      nextAction,
      // 原文轨的载荷就是该版本自己（永远取得到），所以它恒为「已算好」——与真侧同一说法。
      hasPayload,
      hasGrant,
      // 演示数据不做脱敏，也就没有本档的区间缓存（与 `previewFields` 里 `llmLayer.used:false` 同源）。
      llm: { used: false, failureKind: null, spanCount: 0 },
      createdAtUtc: rec.row.created_at_utc,
      // 假后端没有预跑队列这一层（它不真的算东西），读数恒为「不在册」。
      // 这与真侧「缺席的 0」同一口径：说的是这个夹具没接队列，不是本机跑完了。
      checkingSinceUtc: null,
    };
    entries.push(entry);
  }
  entries.sort((a, b) => {
    const rank = reviewQueueRankOf(a) - reviewQueueRankOf(b);
    if (rank !== 0) return rank;
    if (a.createdAtUtc !== b.createdAtUtc) return a.createdAtUtc < b.createdAtUtc ? 1 : -1;
    return a.recordId < b.recordId ? -1 : a.recordId > b.recordId ? 1 : 0;
  });
  const response: ReviewQueueResponse = { entries, total: entries.length, prewarm: { pending: 0 } };
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
      apiKeyEnv: DEFAULT_API_KEY_ENV,
      apiKeyConfigured: false,
      apiKeySource: "none",
      ready: false,
    },
    // 与真实例的默认样子一致：配置文件里没有 `model.local_llm` 这一档（M9-1 之后才有的字段）。
    localLlm: null,
    cloudModel: {
      enabled: false,
      provider: "openai_compatible",
      model: null,
      baseUrl: "https://provider.example/v1",
      callPath: "http_json_lenient",
      supportsStructuredOutput: false,
      requestTimeoutMs: 60000,
      apiKeyEnv: DEFAULT_API_KEY_ENV,
      apiKeyConfigured: false,
      apiKeySource: "none",
      ready: false,
    },
    processingDefaults: {
      recordDefaultMode: "local_model",
      sleepDefaultMode: "local_model",
      rememberLastMode: false,
    },
    processingAvailability: {
      manual_only: true,
      local_model: false,
      cloud_redacted: false,
      cloud_raw: false,
    },
    restartRequired: false,
  };
}

let FAKE_CONFIG = defaultConfig();

/**
 * 样张开关：假侧的「本机模型可用」，默认关——与真实例没装配时同一副样子。
 *
 * M6-1C 要演的是「没有本机模型时提示一次 / 有就不提示」这一对，同一条假路由必须能给出
 * 两种可用性，否则对照的那一屏只能靠真后端凑。开关只翻派生的那一个布尔，
 * `ModelPrivacyConfigDto` 的形状一个字都不动（纪律 2）。
 */
let FAKE_LOCAL_MODEL_AVAILABLE = false;

export function setFakeLocalModelAvailable(available: boolean): void {
  FAKE_LOCAL_MODEL_AVAILABLE = available;
}

/** 与真服务端同口径：档位可用 = 该档已启用且当前实例已装配（假侧默认未装配）。 */
function fakeAvailability(config: ModelPrivacyConfigDto) {
  return {
    manual_only: true as const,
    local_model: FAKE_LOCAL_MODEL_AVAILABLE || (config.localModel.enabled && config.localModel.ready),
    cloud_redacted: config.cloudModel.enabled && config.cloudModel.ready,
    // 第 4 档与 cloud_redacted 共用同一家云端端点（草案 §六），假侧同样「两个键、同一来源」：
    // 少这一个键，`isModeAvailable("cloud_raw", …)` 永远 false，demo 里就复现不出这个档位。
    cloud_raw: config.cloudModel.enabled && config.cloudModel.ready,
  };
}

function configBody(): ModelPrivacyConfigDto {
  return {
    ...structuredClone(FAKE_CONFIG),
    // 样张开关（§样张）：只有 `?rich=1` 打开时这一栏才画得出来。`defaultConfig()` 里那句
    // `ingestReady: false` 逐字未动——它是默认读数，也是红线③钉住的那一份诚实。
    ingestReady: FAKE_RICH_RESULT || FAKE_CONFIG.ingestReady,
    processingAvailability: fakeAvailability(FAKE_CONFIG)
  };
}

/** M5-6：入口页与设置页共写同一组默认值；部分更新只动给出的字段。 */
function saveProcessingBody(body: unknown): FakeReply {
  if (typeof body !== "string") {
    return { status: 400, body: { error: "invalid_request", detail: "整理方式请求体缺失。" } };
  }
  let parsed: UpdateProcessingDefaultsDto;
  try {
    parsed = JSON.parse(body) as UpdateProcessingDefaultsDto;
  } catch {
    return { status: 400, body: { error: "invalid_json" } };
  }
  const modes = PROCESSING_MODE_VALUES as readonly string[];
  const bad = [parsed.recordDefaultMode, parsed.sleepDefaultMode].some(
    (mode) => mode !== undefined && !modes.includes(mode),
  );
  if (bad) {
    return { status: 400, body: { error: "invalid_request", detail: "processing_mode 取值非法", issues: ["processing"] } };
  }
  if (
    parsed.recordDefaultMode === undefined &&
    parsed.sleepDefaultMode === undefined &&
    parsed.rememberLastMode === undefined
  ) {
    return { status: 400, body: { error: "invalid_request", detail: "至少提供一个整理方式字段。" } };
  }
  const current = FAKE_CONFIG.processingDefaults;
  const next: ProcessingDefaultsDto = {
    recordDefaultMode: parsed.recordDefaultMode ?? current.recordDefaultMode,
    sleepDefaultMode: parsed.sleepDefaultMode ?? current.sleepDefaultMode,
    rememberLastMode: parsed.rememberLastMode ?? current.rememberLastMode,
  };
  FAKE_CONFIG = {
    ...FAKE_CONFIG,
    defaultMode: next.recordDefaultMode,
    processingDefaults: next,
  };
  return { status: 200, body: next };
}

/**
 * 假侧那一档的状态读数（M9-4d-1）。
 *
 * 判据与顺序逐字照服务端 `localLlmStatus`：未配置 → 已关闭 → 非回环 → 缺模型 ID。
 * 这里的回环清单是 `src/server/ingest/provider.ts` 的 `LOOPBACK_HOSTS` 的一份**演示用副本**——
 * 假路由没有服务端可问。真后端那条路上 UI 一个字节都不自己判（`ModelPrivacyConfigDto.localLlm`
 * 里的 `loopback`/`usable`/`reason` 就是服务端原话），所以这份副本只可能骗到看样张的人，
 * 不可能放宽真实产品的隐私判定。
 */
const FAKE_LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

function fakeLoopbackHost(baseUrl: string): boolean {
  try {
    return FAKE_LOOPBACK_HOSTS.has(new URL(baseUrl).hostname);
  } catch {
    return false;
  }
}

function fakeLocalLlmTier(
  current: ModelPrivacyConfigDto["localLlm"],
  next: UpdateModelConfigDto["localLlm"],
): ModelPrivacyConfigDto["localLlm"] {
  if (next === undefined) return current;
  const model = next.model.trim() === "" ? null : next.model.trim();
  const baseUrl = next.baseUrl.trim();
  const enabled = next.enabled;
  const loopback = fakeLoopbackHost(baseUrl);
  // 判定顺序与服务端 `localLlmStatus` 逐字相同，第一个命中的原因胜出。
  const reason: LocalLlmUnusableReason | null = !enabled
    ? "disabled"
    : !loopback
      ? "not_loopback"
      : model === null || model.trim() === ""
        ? "no_model"
        : null;
  return {
    enabled,
    provider: next.provider.trim(),
    model,
    baseUrl,
    requestTimeoutMs: next.requestTimeoutMs,
    supportsStructuredOutput: next.supportsStructuredOutput ?? current?.supportsStructuredOutput ?? false,
    callPath: next.callPath ?? current?.callPath ?? null,
    // 界面不再编辑变量名（M9-4d-1b）：草稿里根本没有这个字段，逐字沿用既有那一个。
    apiKeyEnv: current?.apiKeyEnv ?? null,
    loopback,
    usable: reason === null,
    reason,
  };
}

/**
 * 本地脱敏档的连接测试：不可用 ⇒ 零「请求」+ 回枚举；可用 ⇒ 假服务一次就通。
 * `message` 复用设置页那一句按枚举分支的文案，不在假侧另抄一套人话。
 */
function localLlmTestBody(): FakeReply {
  const reason = FAKE_CONFIG.localLlm?.reason ?? "not_configured";
  if (FAKE_CONFIG.localLlm === null || !FAKE_CONFIG.localLlm.usable) {
    const result: LocalLlmTestResultDto = {
      usable: false,
      reason,
      message: localLlmFailureHeadline(reason),
      structuredOutput: null,
      latencyMs: 0,
    };
    return { status: 200, body: result };
  }
  const result: LocalLlmTestResultDto = {
    usable: true,
    structuredOutput: FAKE_CONFIG.localLlm.supportsStructuredOutput,
    latencyMs: 15,
  };
  return { status: 200, body: result };
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
  ): ModelPrivacyConfigDto["localModel"] => {
    const { apiKey, clearApiKey, ...editable } = next;
    const typed = apiKey?.trim();
    const source =
      clearApiKey === true
        ? current.apiKeySource === "environment"
          ? "environment"
          : "none"
        : typed !== undefined && typed !== ""
          ? "saved"
          : current.apiKeySource;
    return {
      ...current,
      ...editable,
      apiKeyEnv: DEFAULT_API_KEY_ENV,
      model: next.model.trim() === "" ? null : next.model.trim(),
      apiKeyConfigured: source !== "none",
      apiKeySource: source,
      ready: false,
    };
  };
  const localModel = merge(FAKE_CONFIG.localModel, parsed.localModel);
  const cloudModel = merge(FAKE_CONFIG.cloudModel, parsed.cloudModel);
  if (cloudModel.enabled && cloudModel.apiKeySource === "none") {
    return {
      status: 400,
      body: {
        error: "invalid_request",
        detail: "云端整理已开启，但保存后没有可用密钥。请先输入密钥。",
      },
    };
  }
  const primary = cloudModel.enabled ? cloudModel : localModel;
  FAKE_CONFIG = {
    ...FAKE_CONFIG,
    modelEnabled: localModel.enabled || cloudModel.enabled,
    cloudRedactedEnabled: cloudModel.enabled,
    requestTimeoutMs: primary.requestTimeoutMs,
    apiKeyConfigured: cloudModel.apiKeyConfigured,
    localModel,
    cloudModel,
    // 请求省缺 `localLlm` ⇒ 这一档逐字不动（与真服务端同一条 M9-D-2 语义）。
    localLlm: fakeLocalLlmTier(FAKE_CONFIG.localLlm, parsed.localLlm),
    restartRequired: true,
  };
  return { status: 200, body: configBody() };
}

function testConnectionBody(body: unknown): FakeReply {
  if (typeof body !== "string") {
    return { status: 400, body: { error: "invalid_request", detail: "连接测试请求体缺失。" } };
  }
  let parsed: TestModelConnectionRequestDto;
  try {
    parsed = JSON.parse(body) as TestModelConnectionRequestDto;
  } catch {
    return { status: 400, body: { error: "invalid_json" } };
  }
  if (typeof parsed.model !== "string" || parsed.model.trim() === "") {
    const result: ModelConnectionTestResultDto = {
      ok: false,
      latencyMs: 0,
      code: "invalid_config",
      message: "请先填写模型 ID。",
    };
    return { status: 200, body: result };
  }
  const result: ModelConnectionTestResultDto = {
    ok: true,
    latencyMs: 12,
    provider: parsed.provider,
    model: parsed.model,
    callPath: parsed.callPath,
    checkedAtUtc: new Date().toISOString(),
  };
  return { status: 200, body: result };
}

/**
 * 假侧那份 `effective`。
 *
 * `satisfies` 是前后端**单轨**的证据（M3-PROJ-1 红线③）：这份返回必须能通过扩集后的
 * `EffectiveResultDto` 形状检查。新增字段全部**可选**，所以这里一个都不填——
 * 「没有」与「空」在响应里可区分，假侧不冒充可读投影（`currentRunId = null` ⇒ 面板落到
 * 「这条还没有整理结果」那一格，而不是编一套 id 去填计数；盒子那五页才是假数据派生内容的家）。
 * dev 入口照旧：`ingestReady: false` 走「解析未就绪」那条路。要演「整理结果」那一栏，
 * 看下面 §样张 那个**默认关**的开关。
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

/* ── §样张：把详情页那栏「整理结果」画出来（web-redesign 第二步） ────────────────
   默认关。关着的时候这一屏与从前逐字相同：`ingestReady: false` ⇒ 「解析未就绪」那条
   既有诚实路径（红线③，`m3-proj-1` §F 钉着）。打开它只有一条路：dev 入口
   `fakeDataEntry.tsx` 读到 `?rich=1` 才调 `setFakeRichResult(true)`——产品面板一行没读它，
   生产构建压根不含这一层（纪律 1）。

   打开后得到的也不是「这条被真的整理过」，而是**一份手写的投影**：顶部那条横幅本来就写着
   「整理结果是手写的，不是模型跑出来的」（`FAKE_DATA_BANNER_TEXT`），样张只是把那句话兑现到
   详情这一栏，并且横幅会多念一句说明。所有文字都从**这一条自己的原文**里截出来，
   坐标按 `indexOf` 现算，所以「点证据跳回原文」在样张里同样是通的；没有一处假装有模型参与。

   取值一律取在册的（`contracts/enums.json`）：lifecycle/status = `active`、origin =
   `ai_generated`、basis = `explicit`（`inferred` 只可配 `user_confirmed_suggestion`，
   见 `basis_origin_matrix`）、来源容器 = `record_revision`、概念按 emotion / topic 分域、
   实体类型 = `person`。DTO 形状一个字没动（纪律 2）。 */

let FAKE_RICH_RESULT = false;

/** 样张开关，与 `setFakeLocalModelAvailable` 同一族：只翻画不画，不扩形状。 */
export function setFakeRichResult(on: boolean): void {
  FAKE_RICH_RESULT = on;
}

/**
 * 候选那一支的样张开关（`?cand=1`，〔web-redesign 第二步 · 批 6〕）。
 *
 * 为什么单独一个开关而不是并进 `?rich=1`：候选块会改掉样张的默认长相（多一块「等你表态」），
 * 而批 5 刚量过的那些数是按**没有候选**的样张取的基线。分开之后两边各自可复现。
 * 这条分支以前只能靠浏览器侧改写 `/api` 回包来照（`scratch/detail-shot.mjs --rich`），
 * 现在它和整理结果一样，由 mock 自己给 —— 那份补丁因此可以退役（试点日志 §八-3 的第一条路）。
 */
let FAKE_CANDIDATE_SAMPLE = false;

export function setFakeCandidateSample(on: boolean): void {
  FAKE_CANDIDATE_SAMPLE = on;
}

/**
 * 待整理样张（`?pending=1`，〔web-redesign 第三步〕）：把一条记录翻成「云端 + 待确认发送」，
 * 于是待整理页的列表与右侧那一框都有得看。
 *
 * 为什么必须造：这套假数据里**没有一条**待整理记录（`fixtures/data.ts` 的种子全是已落定的），
 * 于是整个「发送闸门」在 mock 里从来没被画出来过 —— 改那一框就只能靠凭空想象对账。
 * 只翻一条，且只翻状态与三轴，原文字一个不动。
 */
let FAKE_PENDING_SAMPLE = false;

export function setFakePendingSample(on: boolean): void {
  if (!on) return;
  FAKE_PENDING_SAMPLE = true;
  const target =
    RECORD_LIST.find((item) => allPresent(item.current.raw_text, DEMO_PERSON_WORDS).length > 0) ??
    RECORD_LIST[0];
  if (target === undefined) return;
  const row = target.row as unknown as {
    processing_status: string;
    processing_mode: string;
    analysis_provider: string;
    redaction_mode: string;
    send_content_mode: string;
  };
  row.processing_status = "awaiting_privacy_review";
  row.processing_mode = "cloud_redacted";
  const axes = axesForProcessingMode("cloud_redacted");
  row.analysis_provider = axes.analysisProvider;
  row.redaction_mode = axes.redactionMode;
  row.send_content_mode = axes.sendContentMode;
}

/**
 * 已经表过态的候选（采纳 / 放弃都算）。样张由此把那一份从「等你表态」里拿掉，
 * 于是点完按钮画面真的会变 —— 但**不演**服务端的换轨语义：当前结果还是原来那份。
 */
const RESOLVED_CANDIDATES = new Set<string>();

function candidateRunIdFromBody(body: unknown): string | null {
  if (typeof body !== "string") return null;
  try {
    const parsed = JSON.parse(body) as { candidateRunId?: unknown };
    return typeof parsed.candidateRunId === "string" ? parsed.candidateRunId : null;
  } catch {
    return null;
  }
}

/** 样张 run 的 id 里嵌着版本号：`/api/ingest/runs/:id` 那一侧只给得出 id。 */
const DEMO_RUN_PREFIX = "demo_run_";

function recordByRevisionId(revisionId: string): FakeRecord | null {
  for (const rec of Object.values(RECORD_INDEX)) {
    if (rec.revisions.some((revision) => revision.id === revisionId)) return rec;
  }
  return null;
}

/** 原文按标点切句——样张只要两三句的料，不追求分句学。 */
function demoSentences(text: string): string[] {
  const out: string[] = [];
  let buffer = "";
  for (const char of text) {
    buffer += char;
    if ("。！？!?；;\n".includes(char)) {
      if (buffer.trim() !== "") out.push(buffer);
      buffer = "";
    }
  }
  if (buffer.trim() !== "") out.push(buffer);
  return out.length === 0 ? [text] : out;
}

/** 去掉句末标点与空白再截断：样张上每一个词都是原文里截出来的字面。 */
function clip(text: string, maxLength: number): string {
  const bare = text.replace(/[。！？!?；;，,、\s]+$/u, "");
  return (bare === "" ? text : bare).slice(0, maxLength);
}

/** 第一个小句（按逗号级标点切开）——样张那句「标题」取它，截出来的才像标题而不像断句。 */
function firstClause(text: string): string {
  const parts = text.split(/[，,、；;：:\s]/u).filter((part) => part.trim() !== "");
  return clip(parts[0] ?? text, 16);
}

/** 样张证据：取原文里确实存在的一段字，坐标现算 ⇒ `anchored` 必真，点它跳得回去。 */
function demoEvidence(rawText: string, sentence: string, maxLength: number): EffectiveEvidenceDto {
  const text = clip(sentence, maxLength);
  const start = Math.max(0, rawText.indexOf(text));
  return { text, start, end: start + text.length, anchored: rawText.includes(text) };
}

/**
 * 样张承认哪些词：只列在这套假数据的原文里**真出现过**的（`fixtures/data.ts`）。
 * 命不中就整条提及都不报——`basis = explicit` 与 `ai_generated` 是唯一合法搭配
 * （`basis_origin_matrix` 禁 inferred × ai_generated），所以样张不能替一条没有情绪词的句子
 * 硬造一个「 inferred 出来的情绪」。
 */
const DEMO_EMOTION_WORDS = [
  "烦躁",
  "焦虑",
  "委屈",
  "别扭",
  "紧张",
  "绷着",
  "高兴",
  "安静",
  "期待",
  "累",
  "紧",
  "松",
] as const;
const DEMO_TOPIC_WORDS = ["复盘", "考试", "规矩", "工作", "消息", "手机", "地铁", "梦", "课", "时间"] as const;
const DEMO_PERSON_WORDS = ["老周", "小林"] as const;

/**
 * 原文里出现的**全部**在册词（〔web-redesign 第二步 · 批 5 · R7 裁定〕）。
 *
 * 原来每一维只取第一个，于是 mock 最多长 3 个 chip ——
 * 任何 ≥4 的截断阈值在浏览器里永远走不到，chip 行与折叠分支等于没自测。
 * 仍然是 roster-driven（只认这套假数据原文里真出现过的词），也仍然只产出
 * `basis = explicit`：`basis_origin_matrix` 禁 `inferred × ai_generated`，
 * 样张不替一条没有该词的句子硬造「模型推断出来的提及」。
 */
function allPresent(text: string, words: readonly string[]): readonly string[] {
  return words.filter((word) => text.includes(word));
}

function richEffectiveBody(rec: FakeRecord): EffectiveResultDto {
  const revisionId = rec.current.id;
  const rawText = rec.current.raw_text;
  const sentences = demoSentences(rawText);
  const first = sentences[0] ?? rawText;
  const second = sentences[1] ?? first;
  const source = { kind: "record_revision", containerId: revisionId };
  const episodeName = clip(first, 24);
  const thoughtName = clip(second, 30);
  const emotionWords = allPresent(rawText, DEMO_EMOTION_WORDS);
  const topicWords = allPresent(rawText, DEMO_TOPIC_WORDS);
  const personWords = allPresent(rawText, DEMO_PERSON_WORDS);
  const conceptIdOf = (kind: string, index: number): string => `demo_cnpt_${kind}_${revisionId}_${index}`;
  const entityIdOf = (index: number): string => `demo_entity_${revisionId}_${index}`;
  const runId = `${DEMO_RUN_PREFIX}${revisionId}`;
  const candidateRunId = `${DEMO_RUN_PREFIX}cand_${revisionId}`;
  const startedAtUtc = rec.current.created_at_utc;
  // 标题取第一个小句、摘要取前两句——都还是这一条自己的字，不假装有模型参与措辞。
  const demoTitle = firstClause(first);
  const demoSummary = second === first ? clip(first, 34) : `${clip(first, 34)} ${clip(second, 34)}`;
  return {
    revisionId,
    currentRunId: runId,
    episodes: [episodeName],
    thoughts: [thoughtName],
    emotions: [...emotionWords],
    topics: [...topicWords],
    entities: [...personWords],
    candidates:
      FAKE_CANDIDATE_SAMPLE && !RESOLVED_CANDIDATES.has(candidateRunId)
        ? [{ runId: candidateRunId, fingerprint: fakeSha256(candidateRunId).slice(0, 16) }]
        : [],
    overrides: [],
    episodeItems: [
      {
        id: `demo_ep_${revisionId}`,
        summary: episodeName,
        lifecycleStatus: "active",
        originType: "ai_generated",
        evidence: demoEvidence(rawText, first, 24),
        eventTimeRaw: null,
        eventTimePrecision: "unknown",
        eventTimeCertainty: "unknown",
      },
    ],
    thoughtItemItems: [
      {
        id: `demo_th_${revisionId}`,
        text: thoughtName,
        lifecycleStatus: "active",
        originType: "ai_generated",
        evidence: demoEvidence(rawText, second, 30),
      },
    ],
    ...(emotionWords.length === 0
      ? {}
      : {
          emotionItems: emotionWords.map((word, index) => ({
            id: `demo_em_${revisionId}_${index}`,
            conceptId: conceptIdOf("e", index),
            labelSaid: word,
            basis: "explicit",
            status: "active",
            source,
            evidence: demoEvidence(rawText, word, 8),
            intensity: 2,
            intensityModifiedByUser: false,
          })),
        }),
    ...(topicWords.length === 0
      ? {}
      : {
          topicItems: topicWords.map((word, index) => ({
            id: `demo_tp_${revisionId}_${index}`,
            conceptId: conceptIdOf("t", index),
            labelSaid: word,
            basis: "explicit",
            status: "active",
            source,
            evidence: demoEvidence(rawText, word, 8),
          })),
        }),
    ...(personWords.length === 0
      ? {}
      : {
          entityItems: personWords.map((word, index) => ({
            id: `demo_en_${revisionId}_${index}`,
            entityId: entityIdOf(index),
            labelSaid: word,
            basis: "explicit",
            status: "active",
            source,
            evidence: demoEvidence(rawText, word, 8),
            role: null,
          })),
        }),
    conceptTargets: [
      ...emotionWords.map((word, index) => ({
        id: conceptIdOf("e", index),
        canonicalName: word,
        conceptType: "emotion",
        lifecycleStatus: "active",
      })),
      ...topicWords.map((word, index) => ({
        id: conceptIdOf("t", index),
        canonicalName: word,
        conceptType: "topic",
        lifecycleStatus: "active",
      })),
    ],
    ...(personWords.length === 0
      ? {}
      : {
          entityTargets: personWords.map((word, index) => ({
            id: entityIdOf(index),
            canonicalName: word,
            displayName: word,
            entityType: "person",
            // 模型新抽出来的实体先落在 `provisional`（§3.11 提升的唯一前置态），样张里因此也给得出「转正」。
            lifecycleStatus: "provisional",
          })),
        }),
    suggestionItems: [],
    aiTitle: demoTitle,
    aiSummary: demoSummary,
    runHistory: [
      {
        runId,
        resultState: "current",
        executionStatus: "succeeded",
        errorKind: null,
        aiTitle: demoTitle,
        aiSummary: demoSummary,
        startedAtUtc,
        finishedAtUtc: startedAtUtc,
      },
      // 候选那一份：只有 `?cand=1` 才在。它跑成功过、结果态是 candidate —— 不采纳就进不了
      // 盒子那几页，正是「等你表态」那一块要演的东西（§3.7 三腿口径）。
      ...(FAKE_CANDIDATE_SAMPLE
        ? [
            {
              runId: candidateRunId,
              resultState: "candidate",
              executionStatus: "succeeded",
              errorKind: null,
              aiTitle: `重跑一版：${demoTitle}`,
              aiSummary: demoSummary,
              startedAtUtc,
              finishedAtUtc: startedAtUtc,
            },
          ]
        : []),
    ],
  } satisfies EffectiveResultDto;
}

function richRunBody(rec: FakeRecord): IngestRunDto {
  const startedAtUtc = rec.current.created_at_utc;
  return {
    runId: `${DEMO_RUN_PREFIX}${rec.current.id}`,
    sourceRevisionId: rec.current.id,
    executionStatus: "succeeded",
    resultState: "current",
    errorKind: null,
    idempotencyKey: `demo_key_${rec.current.id}`,
    pipelineFingerprint: fakeSha256(rec.current.id).slice(0, 16),
    startedAtUtc,
    finishedAtUtc: startedAtUtc,
  } satisfies IngestRunDto;
}

/** 创建一条假记录（quick / sleep 的「保存」走这条）：写进内存表，切页就能看到。
 *  M5-1：可选 processing_mode 与服务端口径一致——缺省 manual_only；显式 cloud 落 awaiting_privacy_review。 */
let syntheticCounter = 0;

function createRecord(text: string, mode = "manual_only"): FakeReply {
  if (!isKnownMode(mode)) {
    return { status: 400, body: { error: "invalid_request", detail: "processing_mode 取值非法", issues: ["processing_mode"] } };
  }
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
  const axes = fakeAxesOf(mode);
  const row: RecordRow = {
    id,
    created_at_utc: now.toISOString(),
    created_at_local: local,
    timezone_id: "Asia/Shanghai",
    created_local_date: local.slice(0, 10),
    current_revision_id: revisionId,
    // 外发判定读三轴（与 records/service.ts 同口径）：既有三档结果不变，`cloud_raw` 同样先待确认。
    processing_status: isEgress(axes) ? "awaiting_privacy_review" : "captured",
    processing_mode: mode,
    privacy_level: "normal",
    analysis_provider: axes.analysisProvider,
    redaction_mode: axes.redactionMode,
    send_content_mode: axes.sendContentMode,
  };
  RAW_BY_ID[id] = text;
  RECORD_INDEX[id] = { row, revisions: [revision], current: revision };
  RECORD_LIST.unshift({ row, revisions: [revision], current: revision });
  return { status: 201, body: { record: row, revision } };
}

/** §4.8 已登记边的假镜像（与 records/service.ts setProcessingMode 同规则：三轴派生 + 按外发判定流转）。 */
function setMode(rec: FakeRecord, mode: string): FakeReply {
  if (!isKnownMode(mode)) {
    return { status: 400, body: { error: "invalid_request", detail: "processing_mode 取值非法", issues: ["processing_mode"] } };
  }
  if (rec.row.processing_mode === mode) {
    return { status: 200, body: { record: rec.row, changed: false } };
  }
  const from = rec.row.processing_status;
  if (from === "preprocessing" || from === "processing") {
    return { status: 409, body: { error: "state_conflict", detail: `记录正在 ${from}，拒绝改模式` } };
  }
  const axes = fakeAxesOf(mode);
  const egress = isEgress(axes);
  let to = from;
  if (from === "captured" && egress) to = "awaiting_privacy_review";
  else if (from === "awaiting_privacy_review" && !egress) to = "not_processed";
  rec.row = {
    ...rec.row,
    processing_mode: mode,
    processing_status: to,
    analysis_provider: axes.analysisProvider,
    redaction_mode: axes.redactionMode,
    send_content_mode: axes.sendContentMode,
  };
  return { status: 200, body: { record: rec.row, changed: true } };
}

/**
 * M9-4d-2 的假镜像：只改 `redaction_mode` 一列，另两轴逐字不动，派生列按改后的三轴重算。
 * 判据与 `records/service.ts` 同一对（`isLegalCombination` + `deriveProcessingMode`），
 * 演示侧不许有第二套三轴规则——那是最容易和产品漂移的地方。
 */
function setRedactionMode(rec: FakeRecord, mode: string): FakeReply {
  if (!(REDACTION_MODE_VALUES as readonly string[]).includes(mode)) {
    return {
      status: 400,
      body: { error: "invalid_request", detail: "redaction_mode 取值非法", issues: ["redaction_mode"] },
    };
  }
  if (rec.row.redaction_mode === mode) {
    return { status: 200, body: { record: rec.row, changed: false } };
  }
  const axes: ThreeAxes = {
    analysisProvider: rec.row.analysis_provider,
    redactionMode: mode as RedactionMode,
    sendContentMode: rec.row.send_content_mode,
  };
  if (!isLegalCombination(axes)) {
    return { status: 400, body: { error: "invalid_request", detail: "三轴组合不合法，脱敏档没被改动" } };
  }
  rec.row = { ...rec.row, redaction_mode: axes.redactionMode, processing_mode: deriveProcessingMode(axes) };
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
  const axes = fakeAxesOf("local_model");
  return {
    runId: `run_${recordId}_fake`,
    idempotencyKey: `key_${recordId}`,
    pipelineFingerprint: fakeSha256(recordId).slice(0, 16),
    processingMode: "local_model",
    axes,
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

/**
 * 预览与确认发送**共用**的取值函数（两处不许各算一遍）：载荷文本、假摘要、策略版本、
 * 所属轨道全部从记录在册的那一行现算。`hasApplicableGrant` 不在这里——那是登记表的事。
 */
/**
 * 待整理样张里造**一处真实的脱敏**：把原文里的邮箱换成占位符，并给出对应的 span。
 *
 * 为什么必须造：这套假数据原本一律 `spans: []`（演示数据不做脱敏），于是
 * 「脱敏了 N 处」那张清单在浏览器里永远是空的 —— 而它正是这次重设计要验的东西
 * （原文 → 占位符 → 谁遮的）。造的是规则那一层（`source: "rule"`），
 * 与人名候选（待审、尚未遮）互不重叠，两种情形态都在同一屏能看到。
 */
function demoRedaction(text: string): {
  readonly payloadText: string;
  readonly spans: readonly {
    readonly kind: string;
    readonly placeholder: string;
    readonly source: string;
    readonly originalStart: number;
    readonly originalEnd: number;
    readonly entityId: string | null;
  }[];
} {
  const spans: {
    kind: string;
    placeholder: string;
    source: string;
    originalStart: number;
    originalEnd: number;
    entityId: string | null;
  }[] = [];
  let out = "";
  let cursor = 0;
  let index = 0;
  for (const hit of text.matchAll(/[\w.+-]+@[\w-]+\.[\w.]+/g)) {
    const start = hit.index ?? 0;
    const end = start + hit[0].length;
    index += 1;
    const placeholder = `[email_${index}_demo]`;
    out += text.slice(cursor, start) + placeholder;
    spans.push({
      kind: "email",
      placeholder,
      source: "rule",
      originalStart: start,
      originalEnd: end,
      entityId: null,
    });
    cursor = end;
  }
  return { payloadText: out + text.slice(cursor), spans };
}

function previewFields(rec: FakeRecord): Omit<SendPreviewDto, "hasApplicableGrant"> {
  const text = RAW_BY_ID[rec.row.id] ?? rec.current.raw_text;
  // 待整理样张里演一次真的脱敏；其余样张维持「什么都没遮」的既有形状。
  const redaction = FAKE_PENDING_SAMPLE ? demoRedaction(text) : null;
  const payloadText = redaction?.payloadText ?? text;
  return {
    recordId: rec.row.id,
    recordRevisionId: rec.current.id,
    revisionNumber: rec.current.revision_number,
    policyVersion: "demo-1",
    // 这份预览属于哪条外发轨道：取记录在册的轴值，不写死（草案 §八之二-1）。
    sendContentMode: rec.row.send_content_mode,
    redactedText: payloadText,
    payloadText,
    payloadSha256: fakeSha256(payloadText),
    // M9-4c 起这两列在服务端一律给全，假侧同形：默认演示数据不做脱敏 ⇒ 空 spans + 「没跑过」；
    // 待整理样张例外，那里有一处真遮蔽（见 `demoRedaction`）。
    spans: redaction?.spans ?? [],
    llmLayer: { used: false, candidates: 0, dropped: 0 },
  };
}

/**
 * 确认发送在假侧留下的那张条子（模拟 `cloud_send_grant` 的那一行）。
 * 真实形状见 `grantService.CloudSendGrantRow`；这里只留界面判据摸得到的那几腿。
 */
interface FakeGrantRow {
  readonly grantId: string;
  readonly recordRevisionId: string;
  readonly payloadSha256: string;
  readonly policyVersion: string;
  readonly sendContentMode: SendPreviewDto["sendContentMode"];
  readonly confirmedAtUtc: string;
}

/** 授权的四腿（`recordRevisionId` + `payloadSha256` + `policyVersion` + `sendContentMode`）。 */
type GrantLegs = Pick<SendPreviewDto, "recordRevisionId" | "payloadSha256" | "policyVersion" | "sendContentMode">;

/**
 * 运行期授权登记表：假后端此前**从不记账**（确认动作等于没发生），于是同一屏能同时出现
 * 「已确认」与「还没有确认」。键取 `(revision, 轨道)`，匹配时四腿全等。
 */
const FAKE_GRANTS = new Map<string, FakeGrantRow>();

function grantKey(recordRevisionId: string, sendContentMode: SendPreviewDto["sendContentMode"]): string {
  return `${recordRevisionId}|${sendContentMode}`;
}

/** 四腿全等才算命中：与 `grantService.findApplicableGrant` 同一判据，没有第五条腿。 */
function findApplicableGrant(fields: GrantLegs): FakeGrantRow | null {
  const row = FAKE_GRANTS.get(grantKey(fields.recordRevisionId, fields.sendContentMode));
  if (row === undefined) return null;
  if (row.payloadSha256 !== fields.payloadSha256) return null;
  if (row.policyVersion !== fields.policyVersion) return null;
  return row;
}

/**
 * 记账：同一 revision + 同一轨道的重复确认覆盖同一张条子（与 `issueGrant` 的
 * 「已存在即返回既有行」同形）。失效不在这里写：改写原文 ⇒ 新 revision 的键不同，
 * 换轨 ⇒ 键的另一半不同，两条路都由四腿匹配自然落空（切回原轨仍能命中）。
 */
function issueFakeGrant(fields: GrantLegs): FakeGrantRow {
  const existing = findApplicableGrant(fields);
  if (existing !== null) return existing;
  const row: FakeGrantRow = {
    grantId: `grant_${fields.recordRevisionId}_${fields.sendContentMode}`,
    recordRevisionId: fields.recordRevisionId,
    payloadSha256: fields.payloadSha256,
    policyVersion: fields.policyVersion,
    sendContentMode: fields.sendContentMode,
    confirmedAtUtc: new Date().toISOString(),
  };
  FAKE_GRANTS.set(grantKey(fields.recordRevisionId, fields.sendContentMode), row);
  return row;
}

function previewBody(rec: FakeRecord): SendPreviewDto {
  const fields = previewFields(rec);
  // 预览过 ⇒ 这一版在本机算出过一份待发送载荷（真侧对应 `preview_payload:` 落盘那一刻）。
  FAKE_PREVIEWED.add(rec.current.id);
  return { ...fields, hasApplicableGrant: findApplicableGrant(fields) !== null };
}

/** `POST /api/ingest/confirm-send` 的回包：先记账，再把那张条子投影成 `GrantDto`。 */
function grantBody(rec: FakeRecord): GrantDto {
  const row = issueFakeGrant(previewFields(rec));
  // 真侧签发时那份载荷必然已落进缓存（确认走的就是复现路径），假侧记账同步这一事实：
  // 否则队列会出现「有授权却没载荷」这种真系统里不存在的一行。
  FAKE_PREVIEWED.add(rec.current.id);
  return {
    grantId: row.grantId,
    recordRevisionId: row.recordRevisionId,
    payloadSha256: row.payloadSha256,
    policyVersion: row.policyVersion,
    confirmedAtUtc: row.confirmedAtUtc,
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

/**
 * Phase D / S10 样张词表：设置页要能看见「会被自动遮的名字」长什么样、开关点得动。
 * 真侧只列 person / place / organization 三类，这里同口径；关掉只改这个词的 `maskEnabled`。
 */
const FAKE_VOCABULARY: VocabularyEntityDto[] = [
  {
    entityId: "demo_entity_laozhou",
    entityType: "person",
    canonicalName: "老周",
    displayName: "老周",
    lifecycleStatus: "active",
    originType: "user_created",
    maskEnabled: true,
    terms: ["老周"],
  },
  {
    entityId: "demo_entity_xiaolin",
    entityType: "person",
    canonicalName: "小林",
    displayName: "小林",
    lifecycleStatus: "provisional",
    originType: "ai_generated",
    maskEnabled: true,
    terms: ["小林"],
  },
  {
    entityId: "demo_entity_hangzhou",
    entityType: "place",
    canonicalName: "杭州",
    displayName: "杭州",
    lifecycleStatus: "active",
    originType: "user_created",
    maskEnabled: true,
    terms: ["杭州", "杭城"],
  },
];

function dataCheckBody(): DataCheckReport & { ok: boolean } {
  return {
    ok: true,
    schemaVersion: 5,
    passedSteps: ["假数据侧不跑真核验"],
    searchIndexRebuilt: false,
    desyncBeforeRebuild: null,
  };
}

/* ── 后台队列（M6-1D 手动入队）：一张内存表，形状逐字取 `JobViewDto` ─────────────
 *
 * 这一份 mock 只支撑两件事：「排到后台」这个按钮点下去有真回应，轮询读得到那张卡的状态。
 * **它不会自己往前走** —— 假数据侧没有 worker，任务永远停在 `queued`，界面上那句
 * 「已排到后台，等待处理」因此是真的（确实只是在排队）。要看在途到终态的推进，去连真后端。
 * 幂等语义与真服务端同形：同一条记录的未终态任务只有一行，重复入队回同一行（200）。
 */

const FAKE_JOBS: JobViewDto[] = [];

function stillRunning(job: JobViewDto): boolean {
  return job.status === "queued" || job.status === "redacting" || job.status === "analyzing";
}

function enqueueFakeJob(rec: FakeRecord): FakeReply {
  const existing = FAKE_JOBS.find((job) => job.recordId === rec.row.id && stillRunning(job));
  if (existing !== undefined) return { status: 200, body: existing };
  const now = new Date().toISOString();
  const created: JobViewDto = {
    id: `job_${rec.current.id}`,
    recordId: rec.row.id,
    recordRevisionId: rec.current.id,
    status: "queued",
    attempts: 0,
    errorKind: null,
    cancelRequested: false,
    sendContentMode: rec.row.send_content_mode,
    createdAtUtc: now,
    updatedAtUtc: now,
    startedAtUtc: null,
    finishedAtUtc: null,
  };
  FAKE_JOBS.push(created);
  return { status: 201, body: created };
}

function fakeJobsBody(url: URL): FakeReply {
  const recordId = url.searchParams.get("recordId") ?? "";
  const response: JobListDto = { jobs: FAKE_JOBS.filter((job) => job.recordId === recordId) };
  return { status: 200, body: response };
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

  const redactionModeMatch = /^\/api\/records\/([^/]+)\/redaction-mode$/.exec(path);
  if (redactionModeMatch?.[1] !== undefined) {
    const id = decodeURIComponent(redactionModeMatch[1]);
    const rec = RECORD_INDEX[id];
    if (rec === undefined) return NOT_FOUND;
    if (method === "PATCH") return setRedactionMode(rec, readRedactionModeField(init?.body));
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

  if (path === "/api/entities/vocabulary" && method === "GET") {
    const body: VocabularyResponseDto = { entities: [...FAKE_VOCABULARY] };
    return { status: 200, body };
  }
  const entityMaskMatch = /^\/api\/entities\/([^/]+)\/mask$/.exec(path);
  if (entityMaskMatch?.[1] !== undefined && method === "PATCH") {
    const entityId = decodeURIComponent(entityMaskMatch[1]);
    const index = FAKE_VOCABULARY.findIndex((row) => row.entityId === entityId);
    if (index < 0) return NOT_FOUND;
    let maskEnabled: unknown;
    try {
      maskEnabled = (JSON.parse(typeof init?.body === "string" ? init.body : "{}") as {
        maskEnabled?: unknown;
      }).maskEnabled;
    } catch {
      return { status: 400, body: { error: "invalid_json" } };
    }
    if (typeof maskEnabled !== "boolean") {
      return { status: 400, body: { error: "invalid_request", detail: "maskEnabled 必须是布尔值" } };
    }
    const next: VocabularyEntityDto = { ...FAKE_VOCABULARY[index]!, maskEnabled };
    FAKE_VOCABULARY[index] = next;
    return { status: 200, body: next };
  }

  if (path === "/api/jobs") {
    if (method === "POST") {
      const rec = recordFromBody(init?.body);
      return rec === null ? NOT_FOUND : enqueueFakeJob(rec);
    }
    if (method === "GET") return fakeJobsBody(url);
  }

  if (path === "/api/ingest/pending") return pendingBody(url);
  if (path === "/api/ingest/review-queue") return reviewQueueBody();
  if (path === "/api/ingest/config/processing") {
    return method === "PATCH" ? saveProcessingBody(init?.body) : NOT_FOUND;
  }
  if (path === "/api/ingest/config/test") {
    return method === "POST" ? testConnectionBody(init?.body) : NOT_FOUND;
  }
  if (path === "/api/ingest/local-llm/test") {
    return method === "POST" ? localLlmTestBody() : NOT_FOUND;
  }
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
  // 〔批 6 · 候选样张〕表态这两个端点：样张只演「这一份不再等你表态」，
  // 不演服务端把 current 换掉的那套语义（横幅已经写明整理结果是手写的投影）。
  const decisionMatch = /^\/api\/ingest\/(adopt|discard)$/.exec(path);
  if (decisionMatch?.[1] !== undefined && method === "POST") {
    const candidateRunId = candidateRunIdFromBody(init?.body);
    if (candidateRunId === null) {
      return { status: 400, body: { error: "invalid_body", detail: "没点名是哪一份候选。" } };
    }
    RESOLVED_CANDIDATES.add(candidateRunId);
    return decisionMatch[1] === "adopt"
      ? { status: 200, body: { adoptedRunId: candidateRunId, supersededRunId: null } }
      : { status: 200, body: { discardedRunId: candidateRunId } };
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
    const runId = decodeURIComponent(runMatch[1]);
    const demoRevision = runId.startsWith(DEMO_RUN_PREFIX) ? runId.slice(DEMO_RUN_PREFIX.length) : null;
    const demoRecord = demoRevision === null ? null : recordByRevisionId(demoRevision);
    return { status: 200, body: demoRecord === null ? emptyRun(runId) : richRunBody(demoRecord) };
  }
  const effectiveMatch = /^\/api\/ingest\/effective\/([^/]+)$/.exec(path);
  if (effectiveMatch?.[1] !== undefined) {
    const revisionId = decodeURIComponent(effectiveMatch[1]);
    const demoRecord = FAKE_RICH_RESULT ? recordByRevisionId(revisionId) : null;
    return { status: 200, body: demoRecord === null ? effectiveBody(revisionId) : richEffectiveBody(demoRecord) };
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

/** M9-4d-2：脱敏档的请求体读法（与 `readModeField` 同一形状，字段名不同）。 */
function readRedactionModeField(body: unknown): string {
  if (typeof body !== "string") return "";
  try {
    const parsed = JSON.parse(body) as { redaction_mode?: unknown };
    return typeof parsed.redaction_mode === "string" ? parsed.redaction_mode : "";
  } catch {
    return "";
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
