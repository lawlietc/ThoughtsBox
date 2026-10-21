/**
 * 前后端共用的数据传输契约（M1b）。
 * 类型形状与服务端各模块逐字对应；服务端仍从原模块 re-export，接口不变。
 * 本文件必须保持纯类型：不得引用任何 node 内置模块（web 端 tsconfig 会消费它）。
 */

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

export interface RecordRow {
  readonly id: string;
  readonly created_at_utc: string;
  readonly created_at_local: string;
  readonly timezone_id: string;
  readonly created_local_date: string;
  readonly current_revision_id: string;
  readonly processing_status: string;
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
  /** 省略则取记录在册的 processing_mode；显式传入必须与之一致。 */
  readonly processingMode?: string;
  /** cloud_redacted 必填：用户在预览里确认后的实际待发送文本。 */
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
  readonly processingMode: string;
  readonly privacyLevel: string;
  readonly createdLocalDate: string;
  /** 列表展示用的截断摘要（本机 UI，非云发内容）。 */
  readonly preview: string;
}

export interface PendingRecordsResponse {
  readonly records: PendingRecordDto[];
  readonly total: number;
}

// ── op8 当前模型与隐私模式 ─────────────────────────────────────────

export interface ModelProfileDto {
  readonly enabled: boolean;
  readonly provider: string;
  readonly model: string | null;
  readonly baseUrl: string;
  readonly callPath: string | null;
  readonly supportsStructuredOutput: boolean;
  readonly requestTimeoutMs: number;
  /** 环境变量名，不是密钥值。 */
  readonly apiKeyEnv: string;
  readonly apiKeyConfigured: boolean;
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
  readonly apiKeyEnv: string;
}

export interface UpdateModelConfigDto {
  readonly localModel: UpdateModelProfileDto;
  readonly cloudModel: UpdateModelProfileDto;
}

export interface ModelPrivacyConfigDto {
  /** processing.default_mode。 */
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
  /** 配置已写盘，但当前进程仍在使用旧装配；重启本地后端后生效。 */
  readonly restartRequired: boolean;
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
  readonly processingMode: string;
  readonly succeeded: boolean;
  readonly replayed: boolean;
  readonly recovered: boolean;
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
 * 陌生名字候选（M3-RED-1「已定」②b）：规则层在预览里高亮一个疑似人名/机构词，
 * 等用户「点头」（采纳并可改类型）或跳过。**只读**——它不进脱敏集合，只是给用户做减法的建议。
 */
export interface SendPreviewCandidateDto {
  /** 词面：用户原词逐字。 */
  readonly term: string;
  /** 建议的实体类型，取 enums.json `entity_types` 的 8 值之一。 */
  readonly suggestedKind: string;
  /** 猜测依据（命中的规则 + 线索），让用户知道凭什么这么猜。 */
  readonly basis: string;
  /** 该词面在原文出现的全部起始坐标。 */
  readonly occurrences: readonly number[];
}

export interface SendPreviewDto {
  readonly recordId: string;
  readonly recordRevisionId: string;
  readonly revisionNumber: number;
  readonly policyVersion: string;
  readonly redactedText: string;
  readonly payloadText: string;
  readonly payloadSha256: string;
  /** 该 payload 是否已有适用授权（用户已明确确认）。 */
  readonly hasApplicableGrant: boolean;
  /**
   * 陌生名字候选（M3-RED-1）。只增不减：旧消费面（fakeApi / web 既有分支）不读它照样编译、照样绿；
   * 缺席即「无候选可提示」。它不影响 payloadText / payloadSha256（脱敏集合未变）。
   */
  readonly candidates?: readonly SendPreviewCandidateDto[];
}

// ── op7 用户明确确认 → CloudSendGrant ──────────────────────────────

export interface GrantDto {
  readonly grantId: string;
  readonly recordRevisionId: string;
  readonly payloadSha256: string;
  readonly policyVersion: string;
  readonly confirmedAtUtc: string;
}

// ── RED-1 确认采纳的候选 → provisional 实体（零模型调用，纯本地词表通道） ──

/** 请求体：采纳的候选子集 + 类型（可被用户改成 8 值里任意一个）。 */
export interface ConfirmCandidatesRequestDto {
  readonly recordId: string;
  readonly adopted: readonly { readonly term: string; readonly kind: string }[];
}

export interface ConfirmedEntityDto {
  readonly entityId: string;
  readonly term: string;
  readonly kind: string;
}

export interface ConfirmCandidatesResultDto {
  readonly created: readonly ConfirmedEntityDto[];
  /** 因已是已确认实体而跳过创建的词面（幂等：重复确认不造重复 provisional 实体）。 */
  readonly skipped: readonly string[];
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
 * 逐字取回，取回内容 === `text` 才算 `anchored`）；本轮明令不开 0008，故不新增列。
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
