/**
 * 前后端共用的数据传输契约（M1b）。
 * 类型形状与服务端各模块逐字对应；服务端仍从原模块 re-export，接口不变。
 * 本文件必须保持纯类型：不得引用任何 node 内置模块（web 端 tsconfig 会消费它）。
 */

import type {
  AnalysisProvider,
  RedactionMode,
  SendContentMode,
} from "./contracts/enums.ts";
import type {
  ConnectionTestFailureCode,
  LocalLlmTestReason,
  LocalLlmUnusableReason,
} from "./constants/model.ts";

/**
 * 记录级三轴（M6-0C / 草案 §二）：唯一判定源。
 * 字段名与 0008 的 `analysis_provider` / `redaction_mode` / `send_content_mode` 三列同源，
 * 取值域是 `enums.json` 的三份封闭清单（`contracts/enums.ts` 装载时逐值对账）。
 */
export interface ThreeAxesDto {
  readonly analysisProvider: AnalysisProvider;
  readonly redactionMode: RedactionMode;
  readonly sendContentMode: SendContentMode;
}

/** 三轴在库里的列形状（`RecordRow` 直接带出，故是 snake_case）。 */
export interface RecordAxisColumns {
  readonly analysis_provider: AnalysisProvider;
  readonly redaction_mode: RedactionMode;
  readonly send_content_mode: SendContentMode;
}

export interface StorageMaintenanceTask {
  readonly operation: "delete";
  readonly object_id: string;
  readonly failed_step: string;
  readonly ts: string;
}

export interface DeletePhaseResult {
  /** 阶段 A：数据库事实删除的事务结果（五项断言之①可独立判定）。 */
  readonly phaseA: { readonly committed: true; readonly revisionsRemoved: number };
  /** 阶段 B：存储清理结果（断言之②），失败绝不表述为回滚。 */
  readonly phaseB:
    | { readonly status: "ok" }
    | { readonly status: "pending"; readonly detail: string }
    | { readonly status: "failed_unpersisted"; readonly detail: string };
}

export interface RevisionRow {
  readonly id: string;
  readonly record_id: string;
  readonly revision_number: number;
  readonly raw_text: string;
  readonly content_sha256: string;
  readonly created_at_utc: string;
  readonly created_at_local: string;
  readonly timezone_id: string;
}

export interface RecordRow extends RecordAxisColumns {
  readonly id: string;
  readonly created_at_utc: string;
  readonly created_at_local: string;
  readonly timezone_id: string;
  readonly created_local_date: string;
  readonly current_revision_id: string;
  readonly processing_status: string;
  /**
   * **派生只读兼容字段**（M6-0C / 草案 §五）：写入方由 `analysis_provider` /
   * `redaction_mode` / `send_content_mode` 派生，读取方（UI、导出、trace 兼容面）继续可用。
   * 任何**判定**都不许分支它：0008 的表级 CHECK 保证它与三轴一致，所以它不可能说谎，
   * 但「不分支它」仍然是纪律（代码评审时禁止新增 processing_mode 分支）。
   */
  readonly processing_mode: string;
  readonly privacy_level: string;
}

export type VerifyStatus = "ok" | "ok_with_warning" | "failed";

export interface BackupVerification {
  readonly status: VerifyStatus;
  readonly checkedAtUtc: string;
  readonly schemaVersion: number | null;
  readonly detail: string;
  readonly desync?: { phantom: number; missing: number };
}

export interface BackupEntry {
  readonly name: string;
  readonly kind: "snapshot" | "prerestore";
  readonly sizeBytes: number;
  readonly createdAtUtc: string;
  readonly modifiedAtUtc: string;
  readonly verification: BackupVerification | null;
}

export interface DiskCapacity {
  readonly available: boolean;
  readonly totalBytes?: number;
  readonly freeBytes?: number;
  readonly reason?: string;
}

export interface RestoreResult {
  readonly restoredFrom: string;
  readonly safetyBackupName: string;
  readonly fromSchemaVersion: number;
  readonly schemaVersion: number;
  readonly records: number;
  readonly revisions: number;
  readonly searchIndexRebuilt: boolean;
  readonly maintenanceTasksFound: number;
  readonly maintenanceResolved: number;
  readonly maintenanceOk: boolean;
  readonly maintenanceDetail: string | null;
}

export interface ImportResult {
  readonly records: number;
  readonly revisions: number;
}

export interface DataCheckReport {
  readonly schemaVersion: number;
  readonly passedSteps: string[];
  readonly searchIndexRebuilt: boolean;
  readonly desyncBeforeRebuild: { phantom: number; missing: number } | null;
}

// ════════════════════════════════════════════════════════════════════
// M2-6 §十二 API 面（ingest / 隐私 / 修正）——前后端单一轨道契约。
// 本段仍为纯类型：web 端与 ingestRoutes.ts 共用同一份形状，不得双轨。
// 投影原则：只暴露 UI 需要的字段；`redactionMap`（本地凭据）、
// run 行的 pipeline_manifest 原文、以及 collisions 的词面一律不进对外面。
// ════════════════════════════════════════════════════════════════════

// ── 请求体（服务端以 zod 校验，形状与此对齐） ──────────────────────

/** op2 发起解析 / op5 主动重跑：以 recordId 定位当前版本。 */
export interface ParseRequestDto {
  readonly recordId: string;
  /**
   * 派生只读兼容字段：省略则取记录在册的 `processing_mode`；显式传入必须与之一致。
   * M6-0C 起判定源是三轴，这一项只是旧客户端的兼容面（草案 §五）。
   */
  readonly processingMode?: string;
  /**
   * 三轴（草案 §六「ingest 请求暴露三轴」）。语义与 `processingMode` 同一条纪律：记录上的
   * 隐私承诺是用户既定的设置，不是解析调用的参数——显式传入只允许**核对**在册值，
   * 与库里不一致或组合不合法（草案 §三 矩阵）即拒，绝不据此改写记录。
   */
  readonly axes?: ThreeAxesDto;
  /** 外发（`send_content_mode ≠ none`）必填：用户在预览里确认后的实际待发送文本。 */
  readonly payloadText?: string;
}

/** op6 展示实际准备发送的文本 / op7 保存明确确认。 */
export interface PreviewRequestDto {
  readonly recordId: string;
  /** 用户在预览里手工替换后的待发送文本（§7.2 第 5 步）。 */
  readonly payloadText?: string;
}

export type ConfirmSendRequestDto = PreviewRequestDto;

// ── op1 待处理记录及状态 ───────────────────────────────────────────

export interface PendingRecordDto {
  readonly recordId: string;
  readonly currentRevisionId: string;
  readonly processingStatus: string;
  /** 派生只读兼容字段（草案 §五）；界面据此挑标签，判定请读 `axes`。 */
  readonly processingMode: string;
  /** 三轴事实源（草案 §二）：`cloud_raw` 与 `cloud_redacted` 在这里可区分（§七 断言 7）。 */
  readonly axes: ThreeAxesDto;
  readonly privacyLevel: string;
  readonly createdLocalDate: string;
  /** 列表展示用的截断摘要（本机 UI，非云发内容）。 */
  readonly preview: string;
}

export interface PendingRecordsResponse {
  readonly records: PendingRecordDto[];
  readonly total: number;
}

// ── M10-2 复核队列（只读派生，无 op 编号） ──────────────────────────

/**
 * 本地模型层在**这一版**上留下的事实（全部来自 `app_meta` 的三枚既有 `preview_llm_*` 键）。
 *
 * 只有 `redaction_mode = local_llm` 的脱敏轨才会有非默认值：手动档没有区间缓存那份东西，
 * 于是 `used=false`、`spanCount=0`。界面据此说「规则 + 词表」，不假装数得出几处。
 */
export interface ReviewQueueLlmDto {
  /** 这一版有没有采信区间缓存（只有 local_llm 档会有）。 */
  readonly used: boolean;
  /** `preview_llm_failed:<rev>` 的封闭取值；没有就是 null。 */
  readonly failureKind: string | null;
  /** 采信区间条数；没有缓存就是 0。是数，不是内容。 */
  readonly spanCount: number;
}

/**
 * 一条待复核的发送：外发轨记录 + 当前版本，加上「本机算好了没有 / 用户点头了没有」。
 *
 * 没有任何文本：不含原文、不含 `surface`、不含载荷文本、也不含 op1 那种前 80 字摘要。
 * 版本号在场是为了让界面能说清「看的是第几版」而不必再取一次详情。
 */
/**
 * 收件箱一行此刻唯一该做的事（S5）：确认发送 / 重新问本机模型 / 发起整理 / 等本机。
 * 完成态与在途态没有这一格（`null`），它们不再留在列表里。
 */
export type InboxNextAction = "confirm" | "retry" | "organize" | "wait";

export interface ReviewQueueEntryDto {
  readonly recordId: string;
  readonly currentRevisionId: string;
  readonly revisionNumber: number;
  readonly axes: ThreeAxesDto;
  readonly processingStatus: string;
  /** 派生只读兼容字段；界面只用它取标签与重挂详情，判定仍读 `axes`。 */
  readonly processingMode: string;
  readonly privacyLevel: string;
  /**
   * 这条记录此刻**是否需要用户动作**（S5）。已完成与在途的分析不再留在收件箱里。
   * `nextAction` 与它同源：`needsAction === false` 时必为 `null`。
   */
  readonly needsAction: boolean;
  readonly nextAction: InboxNextAction | null;
  /** 本档的载荷是否已在册（脱敏轨看 `preview_payload:` / `preview_llm_payload:`；原文轨恒为真）。 */
  readonly hasPayload: boolean;
  /** 四腿授权命中（`findApplicableGrant` 那一条）。 */
  readonly hasGrant: boolean;
  readonly llm: ReviewQueueLlmDto;
  readonly createdAtUtc: string;
  /**
   * 这一版**此刻**在预跑队列里登记到的入队时刻（ISO）；`null` = 不在册。
   *
   * 它是「还在检查」的唯一来源（M10-D-9）：`hasPayload === false` 本身分不清排队中、被静默跳过、
   * 还是进程重启前那条没跑完，从它反推「正在检查」就是在屏幕上说没发生的事。
   */
  readonly checkingSinceUtc: string | null;
}

/** 预跑队列的整体读数（M10-4）。只有数，没有内容（N-6）。 */
export interface ReviewQueuePrewarmDto {
  /** 此刻在预跑队列里的条数：防抖中的 + 已排队的 + 正在跑的那一条。 */
  readonly pending: number;
}

export interface ReviewQueueResponse {
  readonly entries: ReviewQueueEntryDto[];
  readonly total: number;
  /**
   * 与 `entries` 出自**同一次** `snapshot()`（M10-D-10）：读数并进同一个响应，
   * 因为两个端点就是两个「说的不是同一刻」的窗口，而这一屏的全部意义是「此刻是什么样」。
   */
  readonly prewarm: ReviewQueuePrewarmDto;
}

// ── op8 当前模型与隐私模式 ─────────────────────────────────────────

export type ApiKeySource = "saved" | "environment" | "none";

export interface ModelProfileDto {
  readonly enabled: boolean;
  readonly provider: string;
  readonly model: string | null;
  readonly baseUrl: string;
  readonly callPath: string | null;
  readonly supportsStructuredOutput: boolean;
  readonly requestTimeoutMs: number;
  /** 内部兼容字段：服务端统一返回系统默认后备变量名，设置页不展示。 */
  readonly apiKeyEnv: string;
  readonly apiKeyConfigured: boolean;
  /** 当前实际会使用的密钥来源；响应永远不包含密钥值。 */
  readonly apiKeySource: ApiKeySource;
  /** 当前运行实例是否真的为这一档装配了 Provider。 */
  readonly ready: boolean;
}

export interface UpdateModelProfileDto {
  readonly enabled: boolean;
  readonly provider: string;
  readonly model: string;
  readonly baseUrl: string;
  readonly callPath: string;
  readonly supportsStructuredOutput: boolean;
  readonly requestTimeoutMs: number;
  /** 旧客户端兼容字段；新客户端不发送，服务端始终使用默认变量名。 */
  readonly apiKeyEnv?: string;
  /** 仅用于本次保存；空 / 缺省表示不修改已保存密钥。 */
  readonly apiKey?: string;
  /** 显式删除这一档的已保存密钥；与 apiKey 不能同时出现。 */
  readonly clearApiKey?: boolean;
}

/**
 * M9-4d-1：设置页编辑「本地模型辅助脱敏」那一档的请求段。
 *
 * **整个段可省缺** ⇒ 服务端逐字保留既有 `local_llm`（M9-D-2：`PUT /api/ingest/config` 重建整份
 * `model`，省缺不等于清空）。它与 `UpdateModelProfileDto` 不是同一个形状，差别是两条裁决而不图省事：
 *  - 没有 `apiKey` / `clearApiKey`：这一档本阶段不提供界面存密钥，只从环境变量读（准则 §三）；
 *  - **没有 `apiKeyEnv`**（M9-4d-1b）：界面上填环境变量名越了本阶段的界（规划 §三「不提供界面存 key」），
 *    所以前端类型里根本没有这个字段。服务端 body 仍**可选**接受它，为的是手写配置文件的那部分用户——
 *    提交体省缺该键 ⇒ 服务端沿用配置文件里已有的 `api_key_env`（与 `callPath` 同一条 M9-D-2 回落）。
 *  - 变量名不做 `TB_MODEL_API_KEY` 归一化（M9-D-3，不一致是有意的）。
 */
export interface UpdateLocalLlmProfileDto {
  readonly enabled: boolean;
  readonly provider: string;
  /** 空串 ⇒ 服务端不落 `model`（`localLlmStatus` 据此报 `no_model`）。 */
  readonly model: string;
  readonly baseUrl: string;
  readonly requestTimeoutMs: number;
  readonly supportsStructuredOutput?: boolean;
  /** 省缺 ⇒ 沿用既有 `call_path`（这一档默认只走 OpenAI 兼容的 `/chat/completions`）。 */
  readonly callPath?: string;
}

/**
 * M9-4d-1b：连接测试的可选请求体。
 *
 * 带 `profile` ⇒ 测的是**草稿**（表单里刚输入、还没保存的那一份），服务端据此临时装配适配器去探测，
 * **不写盘、不改 `facts.config`、不置 `configDirty`**。省缺 `profile`（或空 body）⇒ 现行行为：
 * 读已保存的那一档。两种情况共用同一套形状校验（`localLlmProfileBody`）与同一条
 * 「不可用就一次请求都不发」的纪律。`apiKeyEnv` 只在手写配置的路径上存在，界面草稿不带它。
 */
export interface TestLocalLlmRequestDto {
  readonly profile?: UpdateLocalLlmProfileDto & { readonly apiKeyEnv?: string };
}

export interface UpdateModelConfigDto {
  readonly localModel: UpdateModelProfileDto;
  readonly cloudModel: UpdateModelProfileDto;
  readonly localLlm?: UpdateLocalLlmProfileDto;
}

/**
 * 本地脱敏档的读数（M9-4d-1，设置页那一栏的唯一事实来源）。
 *
 * 不带 `ready` / `apiKeySource` / `apiKeyConfigured`：凭证面（`CredentialProfile`）只有本地与云端两档，
 * 这一档不在凭证体系里（准则 §三「不扩展 `CredentialProfile`」）。`loopback` / `usable` / `reason`
 * 逐字来自 `localLlmStatus`——UI 不自带第二套「能不能用」的判断，回环与否也不在浏览器里重算。
 */
export interface LocalLlmTierDto {
  readonly enabled: boolean;
  readonly provider: string;
  readonly model: string | null;
  readonly baseUrl: string;
  readonly requestTimeoutMs: number;
  readonly supportsStructuredOutput: boolean;
  readonly callPath: string | null;
  /** 用户写的变量名原样带出（M9-D-3）；没写则 null。**绝不**带出该变量的取值。 */
  readonly apiKeyEnv: string | null;
  readonly loopback: boolean;
  readonly usable: boolean;
  readonly reason: LocalLlmUnusableReason | null;
}

/** M5-6：普通记录 / 睡前记录分别拥有默认整理方式，「记住上次」只是覆盖开关，不是第二层配置。 */
export interface ProcessingDefaultsDto {
  readonly recordDefaultMode: string;
  readonly sleepDefaultMode: string;
  readonly rememberLastMode: boolean;
}

/**
 * 各档在当前实例里能否被选中；`manual_only` 恒为 true。
 *
 * M6-0C 补 `cloud_raw`：可用性表少一个档位，前端就把一个真实存在的外发模式永远显示成不可用
 * （假后端则直接 400）。键集合必须与 `processing_modes` 的 4 值逐一对应。
 */
export interface ProcessingModeAvailabilityDto {
  readonly manual_only: true;
  readonly local_model: boolean;
  readonly cloud_redacted: boolean;
  readonly cloud_raw: boolean;
}

/** PATCH /api/ingest/config/processing 请求体：允许部分更新，但至少提供一个字段。 */
export interface UpdateProcessingDefaultsDto {
  readonly recordDefaultMode?: string;
  readonly sleepDefaultMode?: string;
  readonly rememberLastMode?: boolean;
}

export interface ModelPrivacyConfigDto {
  /** processing.default_mode（兼容镜像，等于 record_default_mode）。 */
  readonly defaultMode: string;
  readonly modelEnabled: boolean;
  readonly provider: string | null;
  readonly model: string | null;
  readonly callPath: string | null;
  readonly cloudRedactedEnabled: boolean;
  readonly requestTimeoutMs: number;
  /** 只报「密钥变量是否已配置」，绝不报变量名取值或密钥本身。 */
  readonly apiKeyConfigured: boolean;
  /** 解析能力是否就绪（Provider 面是否装配）。 */
  readonly ingestReady: boolean;
  /** 设置页可直接编辑的两档模型配置。 */
  readonly localModel: ModelProfileDto;
  readonly cloudModel: ModelProfileDto;
  /** 本地模型辅助脱敏那一档；`null` = 配置文件里没有 `model.local_llm`（不是「坏了」）。 */
  readonly localLlm: LocalLlmTierDto | null;
  /** M5-6：普通 / 睡前两个默认方式与「记住上次」开关（读取期已归一化，必有值）。 */
  readonly processingDefaults: ProcessingDefaultsDto;
  /** 入口页据此禁用不可用档位。 */
  readonly processingAvailability: ProcessingModeAvailabilityDto;
  /** 配置已写盘，但当前进程仍在使用旧装配；重启本地后端后生效。 */
  readonly restartRequired: boolean;
}

export interface TestModelConnectionRequestDto {
  readonly profile: "local" | "cloud";
  readonly provider: string;
  readonly model: string;
  readonly baseUrl: string;
  readonly callPath: string;
  readonly supportsStructuredOutput: boolean;
  readonly requestTimeoutMs: number;
  /** 仅用于这一次探测；不会写入 CredentialStore。 */
  readonly apiKey?: string;
}

export interface ModelConnectionTestDto {
  readonly ok: true;
  readonly latencyMs: number;
  readonly provider: string;
  readonly model: string;
  readonly callPath: string;
  readonly checkedAtUtc: string;
}

export interface ModelConnectionTestFailureDto {
  readonly ok: false;
  readonly latencyMs: number;
  /** 取值域住在 `constants/model.ts` 的 `CONNECTION_TEST_FAILURE_CODES`（与本地脱敏档同一份）。 */
  readonly code: ConnectionTestFailureCode;
  readonly message: string;
  readonly httpStatus?: number;
}

export type ModelConnectionTestResultDto =
  | ModelConnectionTestDto
  | ModelConnectionTestFailureDto;

/**
 * M9-1：本地脱敏模型（`model.local_llm`）连接测试的响应。
 *
 * 与 `ModelConnectionTestResultDto` 是两个形状，不强行并一：那一档报「连上了没有 + 封闭错误码」，
 * 这一档还要报**探测出的结构化输出能力**（规划 D8）。
 *
 * M9-D-4 把原先混在一个 `reason` 里的两种东西拆开了：`reason` 只放封闭枚举（UI 分支的唯一依据），
 * `message` 只放给人看的文案。合并形状时那个字段既当判别式又当文案，前端要么 `===` 比一句中文
 * （改一个字就断），要么解析句子（更脆），两条都不是可维护的分支方式。
 */
export interface LocalLlmTestResultDto {
  readonly usable: boolean;
  /**
   * 封闭枚举：配置层不可用的四个原因（`not_configured`/`disabled`/`not_loopback`/`no_model`）
   * 或探测失败类别。取值域见 `constants/model.ts` 的 `LOCAL_LLM_TEST_REASONS`（唯一定义处）。
   */
  readonly reason?: LocalLlmTestReason;
  /** 人话，UI 直接展示；不得含原文、词面、端点响应体或 URL 的凭据部分。 */
  readonly message?: string;
  /** 实际走通的那条路：`true`=结构化被接受，`false`=纯提示词，`null`=没探（不可用）。 */
  readonly structuredOutput: boolean | null;
  readonly latencyMs: number;
}

// ── op3 解析运行状态与错误摘要 ─────────────────────────────────────

export interface IngestRunDto {
  readonly runId: string;
  readonly sourceRevisionId: string;
  readonly executionStatus: string;
  readonly resultState: string;
  readonly errorKind: string | null;
  readonly idempotencyKey: string;
  readonly pipelineFingerprint: string;
  readonly startedAtUtc: string;
  readonly finishedAtUtc: string | null;
}

// ── op2/4/5 解析结果 ───────────────────────────────────────────────

export interface IngestWriteCountsDto {
  readonly episodes: number;
  readonly thoughts: number;
  readonly mentions: number;
  readonly rejectedMentions: number;
  readonly suggestions: number;
  readonly evidenceRepairs: number;
  readonly deduplicated: number;
  readonly unrouted: number;
  readonly unresolvedEntities: number;
}

export interface IngestFailureDto {
  readonly errorKind: string | null;
  readonly retryable: boolean;
  readonly message: string;
  readonly issues: readonly string[];
}

export interface IngestResultDto {
  readonly runId: string;
  readonly idempotencyKey: string;
  readonly pipelineFingerprint: string;
  /** 派生只读兼容字段（草案 §五）；判定与展示请读 `axes`。 */
  readonly processingMode: string;
  /**
   * 本次 run 实际按哪三轴装配（草案 §七 断言 7）：`cloud_raw` 与 `cloud_redacted`
   * 在 `processingMode` 上本就是两个值，但它们共享同一云端适配器，只有三轴能说清
   * 「这一份载荷是原文还是脱敏文本」。
   */
  readonly axes: ThreeAxesDto;
  readonly succeeded: boolean;
  readonly replayed: boolean;
  readonly recovered: boolean;
  /** Phase B：首次整理成功即生效（PD-1）；重跑/已有 current 时为 false，结果仍在候选层。 */
  readonly autoAdopted?: boolean;
  readonly provider: string;
  readonly model: string;
  readonly callPath: string;
  readonly attemptedPaths: readonly string[];
  readonly degraded: boolean;
  readonly errorKind: string | null;
  readonly writes: IngestWriteCountsDto;
  readonly title: string;
  readonly summary: string;
  readonly failure: IngestFailureDto | null;
}

// ── op6 实际待发送文本（脱敏预览；map 绝不上线） ────────────────────

/**
 * 一处遮蔽在**预览面**的投影（M9-4c）：`SendPreview.map.spans` 里 UI 需要的那几列。
 *
 * `kind` 与 `source` 都是封闭枚举成员的字符串（`REDACTION_KINDS` / `REDACTION_SOURCES`），
 * 不是自由文本；`originalStart/originalEnd` 是该处在**原文**里的 UTF-16 坐标——既有 DTO
 * 本就按原文坐标回锚（`candidates[].occurrences`），这里不新增暴露面。
 * 占位符本体（`placeholder`）是脱敏文本里已经看得见的那一段。
 */
/**
 * 遮蔽来源的对外清单（M6-0F 的 `RedactionSpan.source`）。
 *
 * **这是第二份声明**：`dto.ts` 属于共享层，不 import 服务端（web 端 tsconfig 会消费它），
 * 所以它拿不到 `src/server/privacy/redaction.ts` 的 `REDACTION_SOURCES`。两份的一致性由
 * `tests/m9-4d-2-redaction-mode.test.ts` 静态对账钉住（逐值同序），与 `JOB_STATUS_DTO_VALUES`
 * 同一手法：前端要按来源挑人话标签，就需要一份能 import 的封闭清单，而不是手抄字面量。
 */
export const REDACTION_SOURCE_DTO_VALUES = [
  "rule",
  "entity_memory",
  "local_llm",
  "user_confirmed",
] as const;
export type RedactionSourceDto = (typeof REDACTION_SOURCE_DTO_VALUES)[number];

/**
 * 「这次本地模型没用上」的原因清单：与服务端 `LOCAL_LLM_FAILURE_KINDS`（`privacy/grantService.ts`）
 * 逐值同序，同样由 `tests/m9-4d-2-redaction-mode.test.ts` 对账。它同时也是
 * `preview_llm_failed:<rev>` 那枚标记的取值域——只有封闭类别，永远不是自由文本（§11.2）。
 */
export const LLM_FAILURE_KIND_DTO_VALUES = [
  "not_loopback",
  "timeout",
  "network",
  "http",
  "invalid_json",
  "unstructured",
] as const;
export type LlmFailureKindDto = (typeof LLM_FAILURE_KIND_DTO_VALUES)[number];

export interface SendPreviewSpanDto {
  readonly kind: string;
  readonly placeholder: string;
  readonly source: string;
  readonly originalStart: number;
  readonly originalEnd: number;
  /**
   * 词表来源（`source === "entity_memory"`）时指向 `entity.id`，其余来源为 `null`。
   * 预览面据此提供「从词表去掉」，不必让用户再去设置页按词面找人。
   */
  readonly entityId: string | null;
}

/**
 * 本地模型这一层这次的上报（M9-4c）：`used` 说的是「这一层跑过」（M9-D-5），
 * 不是「这一层遮出了东西」；`failureKind` 是封闭枚举成员的字符串，只有没跑成才出现。
 */
export interface SendPreviewLlmLayerDto {
  readonly used: boolean;
  readonly candidates: number;
  readonly dropped: number;
  readonly failureKind?: string;
}

export interface SendPreviewDto {
  readonly recordId: string;
  readonly recordRevisionId: string;
  readonly revisionNumber: number;
  readonly policyVersion: string;
  /**
   * 这份预览对应的 `send_content_mode`（M6-0C）：`redacted` 时 `payloadText` 是脱敏文本，
   * `raw` 时是用户原文。授权绑的是 `payloadSha256`，两种载荷的哈希天然不同，
   * 所以「对原文的点头」不可能被脱敏路径复用——反过来也一样。
   */
  readonly sendContentMode: SendContentMode;
  readonly redactedText: string;
  readonly payloadText: string;
  readonly payloadSha256: string;
  /** 该 payload 是否已有适用授权（用户已明确确认）。 */
  readonly hasApplicableGrant: boolean;
  /**
   * 逐处「这一处是谁遮的」（M9-4c，准则 §五 / §二之二 M9-D-4）：服务端**一律给全**，
   * 不设可选——缺字段的前端降级是 M9-4d 的事，服务端不把两种形状都抛给消费面。
   */
  readonly spans: readonly SendPreviewSpanDto[];
  /** 「这次本地模型没用上（原因）」这段文案的数据源；非 `local_llm` 档恒为 `used:false` 零计数。 */
  readonly llmLayer: SendPreviewLlmLayerDto;
}

// ── op7 用户明确确认 → CloudSendGrant ──────────────────────────────

export interface GrantDto {
  readonly grantId: string;
  readonly recordRevisionId: string;
  readonly payloadSha256: string;
  readonly policyVersion: string;
  readonly confirmedAtUtc: string;
}

// ── op9 用户修正后的有效结果（current 视图 ⊕ override 投影） ─────────

export interface OverrideDto {
  readonly objectTable: string;
  readonly objectId: string;
  readonly fieldName: string;
  readonly valueJson: string;
  readonly updatedAtUtc: string;
}

export interface EffectiveResultDto {
  readonly revisionId: string;
  readonly currentRunId: string | null;
  readonly episodes: readonly string[];
  readonly thoughts: readonly string[];
  readonly emotions: readonly string[];
  readonly topics: readonly string[];
  readonly entities: readonly string[];
  readonly candidates: readonly { readonly runId: string; readonly fingerprint: string }[];
  readonly overrides: readonly OverrideDto[];
  // ── 以下为 M3-PROJ-1 的可读扩集（§六 缺口清单）。既有九个字段的名字/类型/顺序逐字未动。
  // 一律**可选**（RED-1 已验收的扩集姿势）：旧消费方不读它也照样编译，
  // 且「服务端没算这一块」与「算了但结果为空」在响应里可区分。
  /** 与 `episodes` 同一集合的可读形状，逐条对应。 */
  readonly episodeItems?: readonly EffectiveEpisodeItemDto[];
  /** 与 `thoughts` 同一集合的可读形状。 */
  readonly thoughtItemItems?: readonly EffectiveThoughtItemItemDto[];
  /** 与 `emotions` 同一集合的可读形状（提及级，含强度）。 */
  readonly emotionItems?: readonly EffectiveEmotionItemDto[];
  /** 与 `topics` 同一集合的可读形状（提及级）。 */
  readonly topicItems?: readonly EffectiveTopicItemDto[];
  /** 与 `entities` 同一集合的可读形状（提及级，含 role）。 */
  readonly entityItems?: readonly EffectiveEntityItemDto[];
  /** 上述情绪/主题提及指向的概念（按 `conceptId` 连接）。 */
  readonly conceptTargets?: readonly EffectiveConceptTargetDto[];
  /** 上述实体提及指向的实体（按 `entityId` 连接）。 */
  readonly entityTargets?: readonly EffectiveEntityTargetDto[];
  /** 与该版本相干、且尚未定案的建议（待确认页的料）。 */
  readonly suggestionItems?: readonly EffectiveSuggestionItemDto[];
  /** **当前结果**那一次 run 的标题与摘要（0007 补列后事后取回，不再只在发起那一次可见）。
   *  没有 current 时是空串：候选的那份标题在它自己的 `runHistory` 行里，不冒充「当前」。 */
  readonly aiTitle?: string;
  readonly aiSummary?: string;
  /** 该 revision 的全部历次结果（含 current / candidate / superseded / failed）——「历次结果」那一页的料。 */
  readonly runHistory?: readonly EffectiveRunHistoryItemDto[];
}

/**
 * 证据的对外形状：文本 + 原文坐标 + 是否回锚成功。
 * 库里**没有**「是否回锚成功」这一列，投影时现算（按坐标在所属 revision 的 `raw_text` 上
 * 逐字取回，取回内容 === `text` 才算 `anchored`）——它是派生读值，不是列，0008 也没有为它加列。
 */
export interface EffectiveEvidenceDto {
  readonly text: string;
  readonly start: number | null;
  readonly end: number | null;
  readonly anchored: boolean;
}

/** 提及的来源容器：三选一、恰好一个（§3.14 K-04）。取值取 enums.json `mention_source_kinds`。 */
export interface EffectiveMentionSourceDto {
  readonly kind: string;
  readonly containerId: string;
}

export interface EffectiveEpisodeItemDto {
  readonly id: string;
  readonly summary: string;
  readonly lifecycleStatus: string;
  readonly originType: string;
  readonly evidence: EffectiveEvidenceDto;
  readonly eventTimeRaw: string | null;
  readonly eventTimePrecision: string;
  readonly eventTimeCertainty: string;
}

export interface EffectiveThoughtItemItemDto {
  readonly id: string;
  readonly text: string;
  readonly lifecycleStatus: string;
  readonly originType: string;
  readonly evidence: EffectiveEvidenceDto;
}

export interface EffectiveEmotionItemDto {
  readonly id: string;
  /** 连接键：所属概念（§六 概念条目所列那张表的主键）。 */
  readonly conceptId: string;
  readonly labelSaid: string;
  readonly basis: string;
  readonly status: string;
  readonly source: EffectiveMentionSourceDto;
  readonly evidence: EffectiveEvidenceDto;
  readonly intensity: number | null;
  /** 「是否用户改过」：库里 `intensity_source` 只可能为 'user' 或空，故这里是布尔。 */
  readonly intensityModifiedByUser: boolean;
}

export interface EffectiveTopicItemDto {
  readonly id: string;
  readonly conceptId: string;
  readonly labelSaid: string;
  readonly basis: string;
  readonly status: string;
  readonly source: EffectiveMentionSourceDto;
  readonly evidence: EffectiveEvidenceDto;
}

export interface EffectiveEntityItemDto {
  readonly id: string;
  /** 连接键：所属实体。 */
  readonly entityId: string;
  readonly labelSaid: string;
  readonly basis: string;
  readonly status: string;
  readonly source: EffectiveMentionSourceDto;
  readonly evidence: EffectiveEvidenceDto;
  readonly role: string | null;
}

export interface EffectiveConceptTargetDto {
  readonly id: string;
  readonly canonicalName: string;
  readonly conceptType: string;
  readonly lifecycleStatus: string;
}

export interface EffectiveEntityTargetDto {
  readonly id: string;
  readonly canonicalName: string;
  readonly displayName: string;
  readonly entityType: string;
  readonly lifecycleStatus: string;
}

export interface EffectiveSuggestionItemDto {
  readonly id: string;
  readonly kind: string;
  readonly subjectTerm: string;
  readonly status: string;
  /** 展示说明；库里可空，且写路径只放规则标识与内部定位，永不放原文片段。 */
  readonly displayNote: string | null;
  /** 建议证据；当前写路径一律留空，如实投影为 null（不编造）。 */
  readonly evidence: string | null;
}

/**
 * 历次结果的一条：只带 UI 需要的展示件。
 * `pipeline_manifest`（含 `redactionMap`）被**物理跳过**——查询用显式列名，不 `select *`。
 */
export interface EffectiveRunHistoryItemDto {
  readonly runId: string;
  readonly resultState: string;
  readonly executionStatus: string;
  readonly errorKind: string | null;
  readonly aiTitle: string;
  readonly aiSummary: string;
  readonly startedAtUtc: string;
  readonly finishedAtUtc: string | null;
}

// ── op7' 采纳候选结果（§四-8 收账：服务面 adoptCurrent 早已存在且已测，缺对外路由） ──

export interface AdoptRunRequestDto {
  readonly candidateRunId: string;
}

export interface AdoptRunResultDto {
  readonly adoptedRunId: string;
  readonly supersededRunId: string | null;
}

/**
 * op7'' 放弃候选结果（§4.7b：`candidate → superseded`，历史行留在库里）。
 *
 * 这一格本轮补对外，理由与采纳同一条：服务面 `discardCandidate` 早已存在且已测，缺的只是路由。
 * 它**不是删除** —— 不碰原文、不碰派生行，只改一个 run 的结果态，
 * 所以界面敢把它做成一个能点的按钮（派发件禁的是「新造删除语义」，不是这个）。
 */
export interface DiscardRunResultDto {
  readonly discardedRunId: string;
}

// ════════════════════════════════════════════════════════════════════
// M6-0E 后台任务队列的观测面（草案 §七 轮询）。
// 本段仍是纯类型 + 一份字面量清单：web 端与 jobsRoutes.ts 共用同一形状。
// ════════════════════════════════════════════════════════════════════

/**
 * 调度状态对外清单。
 *
 * **这是第二份声明**：`dto.ts` 属于共享层，不 import 服务端模块（web 端 tsconfig 会消费它），
 * 所以它拿不到 `src/server/jobs/jobStore.ts` 的 `JOB_STATUSES`。两份的一致性由
 * `tests/m6-0e-job-routes.test.ts` 的静态对账钉住——逐字同值、同序，任一侧漂移即红。
 * 这与 0D/0E 既有的做法同形（封闭清单 + 一条对账测试，而不是靠手抄）。
 */
export const JOB_STATUS_DTO_VALUES = ["queued", "redacting", "analyzing", "done", "failed", "canceled"] as const;
export type JobStatusDto = (typeof JOB_STATUS_DTO_VALUES)[number];

/**
 * 一条后台任务的对外视图（UI 轮询读它）。
 *
 * 投影纪律：`snapshot_json` 里**只摘 `send_content_mode` 一项**——UI 需要说清「这次自动处理
 * 发的是原文还是脱敏文本」，而模型标识、提示词/契约版本是运维明细，上了线只是多一处外泄面，
 * 也不会改变用户的任何决定。原文与脱敏映射根本不在任务行里（草案 §二 要点），故无从带出。
 */
export interface JobViewDto {
  readonly id: string;
  readonly recordId: string;
  readonly recordRevisionId: string;
  readonly status: JobStatusDto;
  readonly attempts: number;
  /**
   * 失败分类**名**（草案 §五 的五值），不是自由文本。
   * 这里刻意用 `string | null` 而不是抄一份联合类型：它是给 UI 显示分类名用的，
   * 客户端不该因为服务端新增一个分类就编译失败；封闭集仍由服务端的 `JOB_ERROR_KINDS` 守门。
   */
  readonly errorKind: string | null;
  readonly cancelRequested: boolean;
  readonly sendContentMode: "redacted" | "raw" | "none";
  readonly createdAtUtc: string;
  readonly updatedAtUtc: string;
  readonly startedAtUtc: string | null;
  readonly finishedAtUtc: string | null;
}

/** `GET /api/jobs?recordId=...` 的响应：该记录的任务，时间序从旧到新（前端自己取末项展示）。 */
export interface JobListDto {
  readonly jobs: readonly JobViewDto[];
}

// ── M8-1 实体转正（唯一的 provisional → active 写入面，用户手动那一下） ──

/** 请求体：只有要转正的那一个实体。 */
export interface EntityPromoteRequestDto {
  readonly entityId: string;
}

/**
 * 回给的实体面：只出「这一行现在是什么」的四项显示量。
 * 词面/隐私级/来源/创建时间转正都不改，因此也不需要在回包里重复一遍。
 */
export interface PromotedEntityDto {
  readonly id: string;
  readonly entityType: string;
  readonly displayName: string;
  readonly lifecycleStatus: string;
}

export interface EntityPromoteResultDto {
  /** `false` = 它本来就已转正（幂等，不是冲突）。 */
  readonly promoted: boolean;
  readonly entity: PromotedEntityDto;
}

// ── Phase D / S10 词表管理（只列语义层真的会遮的三类） ──

export interface VocabularyEntityDto {
  readonly entityId: string;
  readonly entityType: string;
  readonly canonicalName: string;
  readonly displayName: string;
  readonly lifecycleStatus: string;
  readonly originType: string;
  /** `false` = 这个词已移出 L1 遮蔽集合；本机模型仍可能独立识别到它。 */
  readonly maskEnabled: boolean;
  readonly terms: readonly string[];
}

export interface VocabularyResponseDto {
  readonly entities: readonly VocabularyEntityDto[];
}

export interface EntityMaskRequestDto {
  readonly maskEnabled: boolean;
}
