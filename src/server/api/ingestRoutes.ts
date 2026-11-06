import type { IncomingMessage, ServerResponse } from "node:http";

import { z } from "zod";

import type {
  AdoptRunResultDto,
  DiscardRunResultDto,
  EffectiveResultDto,
  GrantDto,
  InboxNextAction,
  IngestResultDto,
  IngestRunDto,
  LocalLlmTestResultDto,
  LocalLlmTierDto,
  ModelConnectionTestResultDto,
  ModelProfileDto,
  ModelPrivacyConfigDto,
  OverrideDto,
  PendingRecordDto,
  PendingRecordsResponse,
  ProcessingDefaultsDto,
  RecordRow,
  ReviewQueueEntryDto,
  ReviewQueueLlmDto,
  ReviewQueueResponse,
  SendPreviewDto,
} from "../../shared/dto.ts";
import { DEFAULT_API_KEY_ENV } from "../../shared/constants/model.ts";
import {
  ANALYSIS_PROVIDER_VALUES,
  assertThreeAxes,
  coerceAxes,
  deriveProcessingMode,
  isEgress,
  REDACTION_MODE_VALUES,
  SEND_CONTENT_MODE_VALUES,
  ThreeAxisCombinationError,
  ThreeAxisValueError,
  type ProcessingModeValue,
  type ThreeAxes,
} from "../../shared/contracts/enums.ts";
import {
  effectiveModelProfile,
  effectiveProcessingDefaults,
  ensureConfigFile,
  localLlmStatus,
  PROCESSING_MODE_VALUES,
  writeConfigFile,
  type AppConfig,
  type EffectiveModelProfile,
  type LocalModelProfileConfig,
  type ModelProfileConfig,
} from "../config/config.ts";
import type { CredentialProfile } from "../config/credentials.ts";
import { ConfigError } from "../config/errors.ts";
import type { OverridableTable } from "../correction/service.ts";
import {
  CorrectionInputError,
  OverrideFieldError,
} from "../correction/service.ts";
import {
  IngestInputError,
  IngestStateError,
  ReanalysisInFlightError,
  RedactionMapRequiredError,
  RunNotAdoptableError,
  RunNotFoundError,
  type IngestResult,
} from "../ingest/ingestService.ts";
import { httpTransport } from "../ingest/httpTransport.ts";
import {
  adapterForLocalLlm,
  assertRedactionPlanRunnable,
  localLlmUnusableMessage,
  probeLocalLlm,
  probeModelConnection,
  ProcessingModeError,
  PROVIDER_CALL_PATHS,
  RedactionModeUnavailableError,
  type ModelAdapter,
} from "../ingest/provider.ts";
import {
  CloudSendAuthorizationRequiredError,
  LocalLlmTierCacheMissingError,
  PolicyVersionError,
  RevisionNotFoundError,
  type GrantService,
} from "../privacy/grantService.ts";
import {
  LocalLlmNotPreviewedError,
  grantLegsFor,
  hasApplicableGrantForAxes,
  isLocalLlmRedactedTrack,
  previewForConfirmSend,
} from "../privacy/egressPreview.ts";
import { resolveEgressPreview, LocalLlmConsultFailedError } from "../privacy/localLlmPreview.ts";
import { RecordNotFoundError, RecordValidationError } from "../records/service.ts";
import type { ServerFacts } from "./httpServer.ts";
import { jobStoreFor } from "./jobsRoutes.ts";
import { BodyTooLargeError } from "./recordsRoutes.ts";

/**
 * Ingest / 隐私 / 修正 的 HTTP 面（M2-6 §十二）。
 *
 * 三条纪律，逐条对应本阶段的验收：
 *  1. **只经服务层，不写派生数据**：本文件没有任何 prepare/insert/update 落派生表；
 *     解析写走 IngestService，授权写走 GrantService，修正投影读走 CorrectionService，
 *     记录读走 RecordService。路由只做「请求契约 → 服务调用 → DTO 投影」。
 *  2. **四类错误可自动化区分**：验证(400/404) / 状态冲突(409) / 任务失败(200, succeeded=false)
 *     / 内部(500)。任务失败是数据不是传输错误——run 已建、终态已落，HTTP 仍 200。
 *  3. **零敏感外泄**：错误 detail 一律取服务层策展消息（只含内部 ID 与类别，见各错误类注释），
 *     `redactionMap`、原文、密钥、身份映射绝不出现在任何响应；SendPreview 的 `map` 在此被投影剔除。
 *
 * 单一轨道：请求体 zod 形状与 `shared/dto.ts` 的 *RequestDto 逐字对齐；响应一律投影 DTO，
 * 服务层内部对象（collisions / pipeline_manifest 原文 / preview.map）不进对外面。
 */

const MAX_BODY_BYTES = 1_048_576;

const INGEST_PREFIX = "/api/ingest";

/**
 * §4.8 处理态里「等待用户/系统动作」的集合——不含 preprocessing/processing（在途）与 parsed（已完成）。
 * 待整理过滤还含**模式维度**：enums.json processing_rules.manual_only_not_pending
 * （「manual_only 的记录不计入待整理」），故 op1 在本集合之外再按三轴排除
 * `analysis_provider === "none"`（= 派生的 manual_only，草案 §五）。
 */
const PENDING_STATUSES: readonly string[] = [
  "captured",
  "awaiting_privacy_review",
  "needs_reparse",
  "failed",
  "not_processed",
];

const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});
/**
 * 请求体里的三轴（草案 §六「ingest 请求暴露三轴」）。取值门引用 `enums.json` 的三份封闭清单，
 * 不重抄字面量；组合合法性不在 zod 判（`assertThreeAxes` 的报错带规则依据，是策展消息）。
 */
const axesBody = z
  .object({
    analysisProvider: z.enum(ANALYSIS_PROVIDER_VALUES),
    redactionMode: z.enum(REDACTION_MODE_VALUES),
    sendContentMode: z.enum(SEND_CONTENT_MODE_VALUES),
  })
  .strict();
const parseBody = z
  .object({
    recordId: z.string().min(1),
    /** 派生只读兼容字段（草案 §五）：只能核对在册值，改不了它。取值跟 enums 第四值扩。 */
    processingMode: z.enum(PROCESSING_MODE_VALUES).optional(),
    axes: axesBody.optional(),
    payloadText: z.string().optional(),
    /** Phase B：缺省 true（首次整理自动生效）；显式 false 时保留「先看再采纳」。 */
    autoAdoptFirstResult: z.boolean().optional(),
  })
  .strict();
const previewBody = z
  .object({
    recordId: z.string().min(1),
    payloadText: z.string().optional(),
    // F-2：「重跑脱敏」带 force:true ⇒ 服务端先清本地模型档缓存再重征询；缺省/false 走缓存。
    force: z.boolean().optional(),
  })
  .strict();
const callPathSchema = z.enum([PROVIDER_CALL_PATHS[0], ...PROVIDER_CALL_PATHS.slice(1)]);
const modelProfileBody = z
  .object({
    enabled: z.boolean(),
    provider: z.string().trim().min(1).max(80),
    model: z.string().trim().max(200),
    baseUrl: z.url(),
    callPath: callPathSchema,
    supportsStructuredOutput: z.boolean(),
    // M9-6a：上限 300000 = 配置层 `modelProfileConfigSchema` 的同一份取值域，对三档共享
    // （这份 body 本地档与云端档各用一次）；本批只改本地脱敏档的缺省值，下限 1000 不变。
    // M9-6a-2：三档经这条路都够得到 300000——保存时这个值被镜像进顶层旧字段
    // `model.request_timeout_ms`，那份 schema 的上限此前仍是 120000，于是界面允许的值会在写盘前
    // 被拒（报出来的还是与超时无关的配置校验错误）。它已对齐到 300000，两层同一套上限。
    requestTimeoutMs: z.number().int().min(1000).max(300000),
    /** 旧客户端兼容字段；服务端始终使用系统默认变量名。 */
    apiKeyEnv: z.string().optional(),
    apiKey: z.string().max(8192).optional(),
    clearApiKey: z.boolean().optional(),
  })
  .strict()
  .superRefine((profile, ctx) => {
    if (profile.enabled && profile.model === "") {
      ctx.addIssue({
        code: "custom",
        path: ["model"],
        message: "启用某档模型时，模型 ID 不能为空",
      });
    }
    if (
      profile.clearApiKey === true &&
      profile.apiKey !== undefined &&
      profile.apiKey.trim() !== ""
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["clearApiKey"],
        message: "不能同时输入新密钥并清除已保存密钥",
      });
    }
  });
/**
 * M9-4d-1：设置页编辑本地脱敏档的请求段。字段名沿用 `modelProfileBody` 那套驼峰命名
 * （`baseUrl` / `requestTimeoutMs` / `supportsStructuredOutput` / `apiKeyEnv`），这样同一张设置表
 * 里三档的写法一致；命名一致**不等于**形状一致——这一档没有 `apiKey` / `clearApiKey`
 * （本阶段不提供界面存密钥，准则 §三），`callPath` 与 `apiKeyEnv` 可省缺。
 *
 * `.strict()` 与 `modelProfileConfigSchema` 同一取向：`runtime` / `contextSize` 这类未知键直接 400，
 * 不在这里放行、到写盘时才被配置层拒（那会让用户看到两个不同形状的「保存失败」）。
 */
const localLlmProfileBody = z
  .object({
    enabled: z.boolean(),
    provider: z.string().trim().min(1).max(80),
    model: z.string().trim().max(200),
    baseUrl: z
      .url()
      .refine(
        (value) => /^https?:\/\//i.test(value),
        "接口地址只支持 http 或 https",
      ),
    // M9-6a：上限 300000 与另外两档同一份取值域（共享，不另开一条更松的路）；
    // 这一档的**缺省**由 `web/localLlmSettings.ts` 给，本批抬到 90000，另两档缺省不变。
    requestTimeoutMs: z.number().int().min(1000).max(300000),
    supportsStructuredOutput: z.boolean().optional(),
    callPath: callPathSchema.optional(),
    // 界面不暴露这个字段（M9-4d-1b：本阶段不提供界面存 key，只从环境变量读）；
    // 保留为可选只为手写配置文件的那部分用户——提交体省缺 ⇒ localLlmProfileFromBody 沿用既有值。
    apiKeyEnv: z.string().trim().max(200).optional(),
  })
  .strict();
const updateModelConfigBody = z
  .object({
    localModel: modelProfileBody,
    cloudModel: modelProfileBody,
    /** 省缺 ⇒ 既有 `local_llm` 逐字保留（M9-D-2）。给了 ⇒ 重建这一档。 */
    localLlm: localLlmProfileBody.optional(),
  })
  .strict();

/**
 * M9-4d-1b 连接测试的请求体：`profile` 可选。
 *  - 给了 ⇒ 测的是**草稿**（表单里那份，还没保存）；服务端据此临时装配探测，不写盘。
 *  - 省缺（或空 body ⇒ `readJsonBody` 给 `{}`）⇒ 现行行为：读已保存的那一档（M9-1）。
 * 形状复用 `localLlmProfileBody`：与保存路径同一套校验，不另开一条更松的路。
 */
const localLlmTestBody = z
  .object({
    profile: localLlmProfileBody.optional(),
  })
  .strict();

/** M5-6 PATCH 体：部分更新，但至少提供一个字段（全空请求改不出任何东西，拒为 400）。 */
const processingModeSchema = z.enum(PROCESSING_MODE_VALUES);
const updateProcessingDefaultsBody = z
  .object({
    recordDefaultMode: processingModeSchema.optional(),
    sleepDefaultMode: processingModeSchema.optional(),
    rememberLastMode: z.boolean().optional(),
  })
  .strict()
  .refine(
    (body) =>
      body.recordDefaultMode !== undefined ||
      body.sleepDefaultMode !== undefined ||
      body.rememberLastMode !== undefined,
    { message: "至少提供一个整理方式字段" },
  );

const testModelConnectionBody = z
  .object({
    profile: z.enum(["local", "cloud"]),
    provider: z.string().trim().min(1).max(80),
    model: z.string().trim().min(1).max(200),
    baseUrl: z.url(),
    callPath: callPathSchema,
    supportsStructuredOutput: z.boolean(),
    // M9-6a：连接测试的草稿值走同一上限（三档共享，见 `modelProfileBody`）。
    requestTimeoutMs: z.number().int().min(1000).max(300000),
    apiKey: z.string().max(8192).optional(),
  })
  .strict();

/** op7' 采纳：只认一个候选 run 主键，其余判断（能否采纳）全在服务层。 */
const adoptBody = z
  .object({
    candidateRunId: z.string().min(1),
  })
  .strict();

/** Phase B：撤销一次已生效的结果（current → superseded）。 */
const undoBody = z
  .object({
    runId: z.string().min(1),
  })
  .strict();

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new BodyTooLargeError();
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function replyJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = `${JSON.stringify(body, null, 2)}\n`;
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  res.end(payload);
}

// ── DTO 投影（服务内部对象 → 对外形状） ────────────────────────────

function toIngestResultDto(result: IngestResult): IngestResultDto {
  return {
    runId: result.runId,
    idempotencyKey: result.idempotencyKey,
    pipelineFingerprint: result.pipelineFingerprint,
    processingMode: result.processingMode,
    // 判定源原样带出（草案 §七 断言 7）：`cloud_raw` 与 `cloud_redacted` 在这里可区分，
    // 不必让消费方去猜那个派生字段。
    axes: result.axes,
    succeeded: result.succeeded,
    replayed: result.replayed,
    recovered: result.recovered,
    autoAdopted: result.autoAdopted,
    provider: result.provider,
    model: result.model,
    callPath: result.callPath,
    attemptedPaths: [...result.attemptedPaths],
    degraded: result.degraded,
    errorKind: result.errorKind,
    writes: {
      episodes: result.writes.episodes,
      thoughts: result.writes.thoughts,
      mentions: result.writes.mentions,
      rejectedMentions: result.writes.rejectedMentions,
      suggestions: result.writes.suggestions,
      evidenceRepairs: result.writes.evidenceRepairs,
      deduplicated: result.writes.deduplicated,
      unrouted: result.writes.unrouted,
      unresolvedEntities: result.writes.unresolvedEntities,
    },
    // collisions 含建议词面（可能等于人名/实体面），不进对外面——诊断留在服务与 Trace。
    title: result.title,
    summary: result.summary,
    failure:
      result.failure === undefined
        ? null
        : {
            errorKind: result.failure.errorKind,
            retryable: result.failure.retryable,
            message: result.failure.message,
            issues: [...result.failure.issues],
          },
  };
}

function toRunDto(row: {
  id: string;
  source_revision_id: string;
  execution_status: string;
  result_state: string;
  error_kind: string | null;
  idempotency_key: string;
  pipeline_fingerprint: string;
  started_at_utc: string;
  finished_at_utc: string | null;
}): IngestRunDto {
  return {
    runId: row.id,
    sourceRevisionId: row.source_revision_id,
    executionStatus: row.execution_status,
    resultState: row.result_state,
    errorKind: row.error_kind,
    idempotencyKey: row.idempotency_key,
    pipelineFingerprint: row.pipeline_fingerprint,
    startedAtUtc: row.started_at_utc,
    finishedAtUtc: row.finished_at_utc,
  };
}

function profileFromBody(
  input: z.infer<typeof modelProfileBody>,
  previous: EffectiveModelProfile,
  /** 判别字段只属于本地档：带进 `cloud_model` 会被严格 schema 当未知字段拒绝，保存直接失败。 */
  mode: CredentialProfile,
): LocalModelProfileConfig {
  return {
    enabled: input.enabled,
    provider: input.provider,
    base_url: input.baseUrl,
    api_key_env: DEFAULT_API_KEY_ENV,
    request_timeout_ms: input.requestTimeoutMs,
    ...(input.model === "" ? {} : { model: input.model }),
    call_path: input.callPath,
    supports_structured_output: input.supportsStructuredOutput,
    // 设置页只编辑常用项；配置文件里已有的高级 params 原样保留。
    ...(previous.params === undefined ? {} : { params: previous.params }),
    // `runtime` 同理：设置页不展示它，保存时必须原样带回去，否则一次保存就抹掉用户的判别字段。
    ...(mode === "local_model" ? { runtime: previous.runtime } : {}),
  };
}

/**
 * 请求段 → 配置文件里那一档（`modelProfileConfigSchema` 同形）。
 *
 * 三条与另外两档不同的地方，每条都是裁决而不是风格：
 *  - **不过 `TB_MODEL_API_KEY` 归一化**（M9-D-3）。另外两档的变量名是内部兼容细节，会被改写；
 *    这一档本阶段界面不存密钥、只从环境读，变量名是用户配置的一部分。省缺 ⇒ 沿用既有那一个，
 *    空串 ⇒ 这一档不读环境变量。不一致是有意的，`config.ts` 的归一化那几行同样注明了这点。
 *  - 段里没提到的字段（`call_path` / `supports_structured_output` / `params`）从**既有那一档**带过来，
 *    不凭空造也不抹掉：M9-D-2 的理由在字段级别一样成立。
 *  - **不在这里判回环**。非回环允许保存（配置是配置，可用性在用时由 `localLlmStatus` 如实报），
 *    拦在保存路径里会让用户改不回一个写错的配置。
 */
function localLlmProfileFromBody(
  input: z.infer<typeof localLlmProfileBody>,
  previous: ModelProfileConfig | undefined,
): ModelProfileConfig {
  const next: ModelProfileConfig = {
    enabled: input.enabled,
    provider: input.provider,
    base_url: input.baseUrl,
    request_timeout_ms: input.requestTimeoutMs,
  };
  const apiKeyEnv = input.apiKeyEnv ?? previous?.api_key_env;
  if (apiKeyEnv !== undefined && apiKeyEnv !== "") next.api_key_env = apiKeyEnv;
  if (input.model !== "") next.model = input.model;
  const callPath = input.callPath ?? previous?.call_path;
  if (callPath !== undefined) next.call_path = callPath;
  const structured = input.supportsStructuredOutput ?? previous?.supports_structured_output;
  if (structured !== undefined) next.supports_structured_output = structured;
  if (previous?.params !== undefined) next.params = previous.params;
  return next;
}

function toModelProfileDto(
  facts: ServerFacts,
  profile: ModelProfileConfig,
  /** 凭证档位（两家端点/两份密钥），不是记录级三轴：`cloud_raw` 落在这两档里的云端一档。 */
  mode: CredentialProfile,
): ModelProfileDto {
  const resolved = facts.credentials.resolve(mode, profile.api_key_env ?? DEFAULT_API_KEY_ENV, facts.env);
  return {
    enabled: profile.enabled,
    provider: profile.provider,
    model: profile.model ?? null,
    baseUrl: profile.base_url,
    callPath: profile.call_path ?? null,
    supportsStructuredOutput: profile.supports_structured_output ?? false,
    requestTimeoutMs: profile.request_timeout_ms,
    apiKeyEnv: profile.api_key_env ?? DEFAULT_API_KEY_ENV,
    apiKeyConfigured: resolved.key !== undefined,
    apiKeySource: resolved.source,
    ready: facts.workspace.ingestReadyFor(mode),
  };
}

function toProcessingDefaultsDto(facts: ServerFacts): ProcessingDefaultsDto {
  const processing = effectiveProcessingDefaults(facts.config.processing);
  return {
    recordDefaultMode: processing.record_default_mode,
    sleepDefaultMode: processing.sleep_default_mode,
    rememberLastMode: processing.remember_last_mode,
  };
}

/**
 * 本地脱敏档的对外读数（设置页那一栏）。
 *
 * `loopback` / `usable` / `reason` 三个字段逐字取自 `localLlmStatus`——「这一档能不能用」在前后端
 * 只有这一条口径，浏览器里不重算回环（那是隐私红线的判据，抄第二份迟早漂移）。
 * 不投影 `ready` / `apiKeySource`：这一档不在凭证体系里（`CredentialProfile` 只有本地与云端两档）。
 */
function toLocalLlmTierDto(facts: ServerFacts): LocalLlmTierDto | null {
  const profile = facts.config.model.local_llm;
  if (profile === undefined) return null;
  const status = localLlmStatus(facts.config);
  return {
    enabled: profile.enabled,
    provider: profile.provider,
    model: profile.model ?? null,
    baseUrl: profile.base_url,
    requestTimeoutMs: profile.request_timeout_ms,
    supportsStructuredOutput: profile.supports_structured_output ?? false,
    callPath: profile.call_path ?? null,
    apiKeyEnv: profile.api_key_env ?? null,
    loopback: status.loopback,
    usable: status.usable,
    reason: status.reason ?? null,
  };
}

function modelConfigDto(facts: ServerFacts): ModelPrivacyConfigDto {
  const model = facts.config.model;
  const local = effectiveModelProfile(facts.config, "local_model");
  const cloud = effectiveModelProfile(facts.config, "cloud_redacted");
  const cloudKey = facts.credentials.resolve(
    "cloud_redacted",
    cloud.api_key_env ?? DEFAULT_API_KEY_ENV,
    facts.env,
  );
  // provider/model/callPath 的真值来自当前实际装配的适配器；未装配时如实为 null，不猜。
  const adapter = facts.workspace.ingestProvider?.adapter ?? null;
  return {
    defaultMode: effectiveProcessingDefaults(facts.config.processing).record_default_mode,
    modelEnabled: model.enabled,
    provider: adapter?.provider ?? null,
    model: adapter?.model ?? null,
    callPath: adapter?.callPath ?? null,
    cloudRedactedEnabled: model.cloud_redacted_enabled,
    requestTimeoutMs: model.request_timeout_ms,
    apiKeyConfigured: cloudKey.key !== undefined,
    ingestReady: facts.workspace.ingestReady,
    localModel: toModelProfileDto(facts, local, "local_model"),
    cloudModel: toModelProfileDto(facts, cloud, "cloud_redacted"),
    localLlm: toLocalLlmTierDto(facts),
    processingDefaults: toProcessingDefaultsDto(facts),
    // 「已启用」与「当前实例已装配」两个条件都成立才算可用；manual_only 永远可选。
    // 键集合必须与 `processing_modes` 的四个取值逐一对应：少一个档位，前端就把一个真实存在的
    // 外发模式永远显示成不可用（草案 §六「前端可用性」）。`cloud_raw` 与 `cloud_redacted`
    // 共用同一家云端端点，所以两者的可用性同源——但仍是**两个键**，UI 据此分别呈现。
    processingAvailability: {
      manual_only: true as const,
      local_model: local.enabled && facts.workspace.ingestReadyFor("local_model"),
      cloud_redacted: cloud.enabled && facts.workspace.ingestReadyFor("cloud_redacted"),
      cloud_raw: cloud.enabled && facts.workspace.ingestReadyFor("cloud_raw"),
    },
    restartRequired: facts.runtime.configDirty,
  };
}

type ModelProfileBody = z.infer<typeof modelProfileBody>;

function typedApiKey(input: ModelProfileBody): string | undefined {
  const value = input.apiKey?.trim();
  return value === undefined || value === "" ? undefined : value;
}

function keyAfterSave(
  facts: ServerFacts,
  /** 凭证档位（两家端点/两份密钥），不是记录级三轴：`cloud_raw` 落在这两档里的云端一档。 */
  mode: CredentialProfile,
  input: ModelProfileBody,
  profile: ModelProfileConfig,
): string | undefined {
  const typed = typedApiKey(input);
  if (typed !== undefined) return typed;
  if (input.clearApiKey === true) {
    const fallback = facts.env[profile.api_key_env ?? DEFAULT_API_KEY_ENV]?.trim();
    return fallback === undefined || fallback === "" ? undefined : fallback;
  }
  return facts.credentials.resolve(mode, profile.api_key_env ?? DEFAULT_API_KEY_ENV, facts.env).key;
}

function applyCredentialChange(
  facts: ServerFacts,
  /** 凭证档位（两家端点/两份密钥），不是记录级三轴：`cloud_raw` 落在这两档里的云端一档。 */
  mode: CredentialProfile,
  input: ModelProfileBody,
): void {
  const typed = typedApiKey(input);
  if (typed !== undefined) {
    facts.credentials.write(mode, typed);
  } else if (input.clearApiKey === true) {
    facts.credentials.clear(mode);
  }
}

// ── 解析核心（op2 发起 / op4 重试 / op5 主动重跑共用同一幂等入口） ──

/**
 * 记录在册的三轴 = 唯一判定源（草案 §五）。列值先过取值门再过组合门：
 * 库里 0008 的 CHECK 已经拦过一道，这里是**读侧**的同一道核对（导出换机、旧库回灌都可能绕过写侧）。
 * 不静默兜底成保守组合——兜底等于替用户改写隐私承诺。
 */
function axesOfRecord(record: RecordRow): ThreeAxes {
  const axes = coerceAxes(record.analysis_provider, record.redaction_mode, record.send_content_mode);
  assertThreeAxes(axes);
  return axes;
}

/** 请求体显式带来的三轴：同样过两道门；它只能**核对**在册值，改写不了承诺（服务层 `resolveAxes` 兜住）。 */
function axesFromBody(body: z.infer<typeof axesBody>): ThreeAxes {
  const axes = coerceAxes(body.analysisProvider, body.redactionMode, body.sendContentMode);
  assertThreeAxes(axes);
  return axes;
}

/**
 * 一条记录 → 复核队列的一行（M10-2）。**全程只读**：读的是 `capture_record` 已在册的轴、
 * `app_meta` 里那几枚既有预览缓存键、`cloud_send_grant` 的四腿匹配。
 *
 * 不调 `preparePreview` / `previewForEgress` / `resolveLocalLlmPreview`：那三条都会现算一次脱敏
 * （前者还会顺手写回 nonce 与载荷两枚键），把「看一眼队列」变成「跑一次」——断言 C1 与 C2 抓的就是
 * 这条线。判据因此取「在册的那份载荷有没有被授权过」，没算过就说没算过。
 *
 * 响应里没有任何文本：不含原文、不含 `surface`、不含载荷文本，也不给 op1 那种前 80 字摘要（C4）。
 *
 * `checkingSinceMs` 由调用方从**同一次** `PrewarmQueue.snapshot()` 里取（M10-4）：这里不自己去问队列，
 * 免得一份响应里两处读数不是同一刻。传进来只是转 ISO，仍然一次都不触发预跑。
 */
function reviewQueueEntry(
  grants: GrantService,
  record: RecordRow,
  revisionNumber: number,
  checkingSinceMs: number | null,
): ReviewQueueEntryDto {
  const axes = axesOfRecord(record);
  const revisionId = record.current_revision_id;
  const isRawTrack = axes.sendContentMode === "raw";
  const localLlmTrack = isLocalLlmRedactedTrack(axes);

  // 问哪几条腿、有没有授权，与后台队列「这一行能不能认领」共用同一处判据（`egressPreview.ts`）：
  // 两处各写一遍，就可能一处说「等你确认」、另一处已经把内容发出去。
  const legs = grantLegsFor(axes);
  // 原文轨没有载荷缓存这回事（要发的就是原文本身，永远取得到），所以它恒为「已算好」。
  const hasPayload =
    isRawTrack || legs.some((leg) => leg !== "raw" && grants.hasCachedPayload(revisionId, leg));
  const hasGrant = hasApplicableGrantForAxes(grants, revisionId, axes);

  // 只有本地模型档才有这三格：手动档没有区间缓存这份东西，`spanCount` 因此**不现算**、只说没数。
  const llm: ReviewQueueLlmDto = localLlmTrack
    ? {
        used: grants.hasCachedLlmSpans(revisionId),
        failureKind: grants.llmConsultFailedKind(revisionId) ?? null,
        spanCount: grants.llmSpanCount(revisionId),
      }
    : { used: false, failureKind: null, spanCount: 0 };

  const nextAction = reviewQueueNextAction({
    status: record.processing_status,
    hasPayload,
    hasGrant,
    checking: checkingSinceMs !== null,
    llmFailureKind: llm.failureKind,
  });

  return {
    recordId: record.id,
    currentRevisionId: revisionId,
    revisionNumber,
    axes,
    processingStatus: record.processing_status,
    processingMode: deriveProcessingMode(axes),
    privacyLevel: record.privacy_level,
    needsAction: nextAction !== null,
    nextAction,
    hasPayload,
    hasGrant,
    llm,
    createdAtUtc: record.created_at_utc,
    // 「还在检查」只认预跑队列的在册状态（M10-D-9）：`hasPayload === false` 说的是「没算好」，
    // 至于是因为在跑、还是因为这一档压根没配好，它答不了——那一格由这里如实填。
    checkingSinceUtc: checkingSinceMs === null ? null : new Date(checkingSinceMs).toISOString(),
  };
}

/**
 * 收件箱这一行此刻唯一该做的事（S5）。
 *
 * 优先级就是用户该先处理的那件事：本机模型没跑成要先重问（否则看到的是回落载荷）；
 * 还在算就等；没有本次授权就确认；剩下未完成的才轮到整理。`parsed` 等完成态与
 * `preprocessing/processing` 在途态都不给动作——它们不再留在收件箱里。
 */
function reviewQueueNextAction(input: {
  readonly status: string;
  readonly hasPayload: boolean;
  readonly hasGrant: boolean;
  readonly checking: boolean;
  readonly llmFailureKind: string | null;
}): InboxNextAction | null {
  if (input.llmFailureKind !== null) return "retry";
  if (!input.hasPayload && input.checking) return "wait";
  if (!input.hasGrant) return "confirm";
  if (PENDING_STATUSES.includes(input.status)) return "organize";
  return null;
}

/**
 * 「不确定顶上去」的那一把秩（M10-2 排序口径）：没检查成 → 没载荷 → 没授权 → 都已就绪。
 *
 * 写成显式秩而不是布尔相减：布尔减法读不出「谁为什么排在谁前面」，而这一条是队列唯一的语义。
 */
function reviewQueueRank(entry: ReviewQueueEntryDto): number {
  if (entry.llm.failureKind !== null) return 0;
  if (entry.hasPayload !== true) return 1;
  if (entry.hasGrant !== true) return 2;
  return 3;
}

/** 同秩按 `createdAtUtc` 倒序（新的在上），再同则按记录 id 定序——比较器必须全序，不然结果随驱动走。 */
function compareReviewQueueEntries(a: ReviewQueueEntryDto, b: ReviewQueueEntryDto): number {
  const rank = reviewQueueRank(a) - reviewQueueRank(b);
  if (rank !== 0) return rank;
  if (a.createdAtUtc !== b.createdAtUtc) return a.createdAtUtc < b.createdAtUtc ? 1 : -1;
  return a.recordId < b.recordId ? -1 : a.recordId > b.recordId ? 1 : 0;
}

/**
 * §六 + §八 断言 6：同步入口这一次真的把该 revision 做完了 ⇒ 作废它下面还在排队的任务，
 * 免得「一次保存，模型跑两遍」。
 *
 * 只在 `succeeded` 之后动任务行：失败——包括「任务失败是数据」那种 HTTP 200 +
 * `succeeded=false`——一律让 queued 原样留着。开始前取消等于把用户「保存后自动处理」的
 * 意图押在一次可能失败的执行上，一旦失败那份意图就无从弥补；成功之后取消才等价于
 * 「这件事已经做完了，队列不用再做」。在途的行由服务层自己排除（只动 queued）。
 */
function settleQueuedJobsAfterSync(facts: ServerFacts, dto: IngestResultDto, revisionId: string): void {
  if (!dto.succeeded) return;
  jobStoreFor(facts).cancelQueuedForRevision(revisionId);
}

async function runParse(
  facts: ServerFacts,
  recordId: string,
  input: {
    processingMode?: ProcessingModeValue | undefined;
    axes?: z.infer<typeof axesBody> | undefined;
    payloadText?: string | undefined;
    /** M8-2：用户点了「重新分析」。闸门一条不加、一条不减，只把这一意图交给服务层。 */
    reanalysis?: boolean | undefined;
    /** Phase B：缺省 true；显式 false 时保留候选（先看再采纳）。 */
    autoAdoptFirstResult?: boolean | undefined;
  },
): Promise<IngestResultDto> {
  const { record } = facts.workspace.records.getRecord(recordId);
  const revisionId = record.current_revision_id;
  const axes = axesOfRecord(record);
  const requestedAxes = input.axes === undefined ? undefined : axesFromBody(input.axes);
  /** 派生只读读数（草案 §五）：0008 的派生 CHECK 保证它等于三轴的派生结果，装配按它取适配器。 */
  const mode = deriveProcessingMode(axes);
  const requestedMode = input.processingMode === undefined ? {} : { processingMode: input.processingMode };
  const requestedAxesInput = requestedAxes === undefined ? {} : { axes: requestedAxes };
  // 缺席就整个不带这个键：`reanalysis: undefined` 与不传必须在服务层是同一条路径（M8-2 R1）。
  const requestedReanalysis = input.reanalysis === true ? { reanalysis: true } : {};

  // §八之三-2 + M9-4b：与 op6/op7 同一道门（见 `provider.assertRedactionPlanRunnable`），不复制第二份判断。
  // 状态读数取本请求的 `facts.config`：这一档已实现，被拒只可能是「没配置好」，而配置可能在
  // 上一次保存后变过（设置页写盘、重启才生效的是 Provider 装配，档位可用性是每次请求现读的）。
  const localLlm = localLlmStatus(facts.config);
  assertRedactionPlanRunnable(axes, revisionId, localLlm);
  if (axes.analysisProvider === "none") {
    // 派生 processing_mode=manual_only：这条记录承诺不经模型，压根没有适配器可查。
    // 「没有适配器」与「不该调用」是两件事——报 503 会把用户的设置说成系统故障。
    throw new ProcessingModeError(
      "manual_only",
      revisionId,
      `analysis_provider=none（派生 processing_mode=manual_only）—— manual_only 不调用任何模型：` +
        "该记录不进入解析路径（Spec §5.2、草案 §三 规则 3）。",
    );
  }

  if (isEgress(axes)) {
    // 外发（redacted 与 raw 同一道门）：载荷由服务端本次现算，授权闸门绑定具体
    // (revision, send_content_mode, payload, policy) 四腿（0D 草案 §四）。
    // M9-4d-pre / M9-D-13：这一句从同步的 `previewForEgress` 换成装配层那**一个**共用入口。
    // `local_llm` 档若在发送时还没有一次成功征询被缓存，发送前**再问一次**模型：
    //  - 问成 ⇒ 载荷与用户确认过的那份不同 ⇒ 下面 `requireApplicableGrant` 抛 409，
    //    请用户重新预览确认（没有「自动重新确认」这一条，四腿闸门原样不动）；
    //  - 仍问不成 ⇒ 落规则档那份，正是用户看过并签了 `rules-v1` 的那一份 ⇒ 照发。
    // 判档只在这一处（`resolveEgressPreview`），路由不另判一遍；`adapter` 为 null 时装配层
    // 自己落规则档，而 `assertRedactionPlanRunnable` 早已在更前面把这一档拒掉，不会走到这里。
    const preview = await resolveEgressPreview(
      facts.workspace.grants,
      adapterForLocalLlm(localLlm.profile, facts.env),
      revisionId,
      axes,
      input.payloadText === undefined ? {} : { payloadText: input.payloadText },
    );
    const guarded = facts.workspace.makeIngestService(mode, () =>
      facts.workspace.grants.requireApplicableGrant(
        preview.recordRevisionId,
        preview.payloadSha256,
        preview.policyVersion,
        preview.sendContentMode,
      ),
      localLlm);
    if (guarded === null) throw new IngestUnavailableError();
    const result = await guarded.ingest({
      recordRevisionId: revisionId,
      ...requestedMode,
      ...requestedAxesInput,
      ...requestedReanalysis,
      payloadText: preview.payloadText,
      autoAdoptFirstResult: input.autoAdoptFirstResult ?? true,
      // 映射只在 `redacted` 这一支有定义：raw 的载荷就是原文，没有映射可带（草案 §三 矩阵 #9）。
      ...(axes.sendContentMode === "redacted" ? { redactionMap: preview.map } : {}),
    });
    const dto = toIngestResultDto(result);
    settleQueuedJobsAfterSync(facts, dto, revisionId);
    return dto;
  }

  // 不外发的在途分析（`analysis_provider=local`，§八之三：只对应自备回环服务）：
  // 载荷省略即原文，脱敏映射与授权都不适用。
  const service = facts.workspace.makeIngestService(mode, undefined, localLlm);
  if (service === null) {
    // 解析能力未就绪：显式拒绝，不拿半套配置假装能发（fail-fast 精神，非内部错误）。
    throw new IngestUnavailableError();
  }
  const result = await service.ingest({
    recordRevisionId: revisionId,
    ...requestedMode,
    ...requestedAxesInput,
    ...requestedReanalysis,
    autoAdoptFirstResult: input.autoAdoptFirstResult ?? true,
    ...(input.payloadText === undefined ? {} : { payloadText: input.payloadText }),
  });
  const dto = toIngestResultDto(result);
  settleQueuedJobsAfterSync(facts, dto, revisionId);
  return dto;
}

class IngestUnavailableError extends Error {
  constructor() {
    super("解析能力未就绪：Provider 面未装配（模型未启用或本地 transport 未配置）。");
    this.name = "IngestUnavailableError";
  }
}

export async function handleIngestRequest(
  facts: ServerFacts,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  const path = url.pathname;
  const method = req.method ?? "GET";
  if (path !== INGEST_PREFIX && !path.startsWith(`${INGEST_PREFIX}/`)) return false;

  const send = (status: number, body: unknown): void => replyJson(res, status, body);

  // 四类错误的集中裁决。detail 只带服务层策展消息（内部 ID + 类别），不透出原文/映射/密钥；
  // 内部错误固定文案，绝不回显 cause.message（未知异常消息可能含敏感上下文）。
  const fail = (cause: unknown): void => {
    if (cause instanceof z.ZodError) {
      send(400, { error: "invalid_request", detail: "请求体或查询参数不符合契约" });
    } else if (cause instanceof SyntaxError) {
      send(400, { error: "invalid_json" });
    } else if (cause instanceof BodyTooLargeError) {
      send(413, { error: "body_too_large" });
    } else if (
      cause instanceof RecordValidationError ||
      cause instanceof IngestInputError ||
      cause instanceof RedactionMapRequiredError ||
      cause instanceof ConfigError ||
      cause instanceof CorrectionInputError ||
      cause instanceof OverrideFieldError ||
      cause instanceof PolicyVersionError
    ) {
      send(400, { error: "invalid_request", detail: cause.message });
    } else if (cause instanceof ThreeAxisValueError || cause instanceof ThreeAxisCombinationError) {
      // §七 断言 1：非法组合必须落在**明确错误码**上，绝不进 500。消息只含三轴取值与规则依据。
      send(400, { error: "invalid_three_axis_combination", detail: cause.message });
    } else if (
      cause instanceof RecordNotFoundError ||
      cause instanceof RevisionNotFoundError ||
      cause instanceof RunNotFoundError
    ) {
      send(404, { error: "not_found", detail: cause.message });
    } else if (
      cause instanceof IngestStateError ||
      cause instanceof ProcessingModeError ||
      cause instanceof CloudSendAuthorizationRequiredError ||
      cause instanceof RunNotAdoptableError ||
      // M8-D-8：已有在途解析 ⇒ 与归档冲突同一档，409 且一次调用都不发。
      cause instanceof ReanalysisInFlightError
    ) {
      send(409, { error: "state_conflict", detail: cause.message });
    } else if (cause instanceof RedactionModeUnavailableError) {
      // M9-4b / M9-D-10 的对外面：这一档当前不可用，错误码点名它自己，`reason` 是封闭枚举。
      // 不复用 `state_conflict`：那会让「你选的这一档现在跑不了」混进「记录状态不对」里，客户端无法分辨。
      send(409, { error: "redaction_mode_unavailable", reason: cause.reason, detail: cause.message });
    } else if (cause instanceof LocalLlmTierCacheMissingError) {
      // M9-4d-pre §5：这一档的采信区间缓存**在册却读不回**（缺键 / 结构不成立）⇒ 409，不再落通用 500。
      // 消息只有 revisionId 与类别，不透出缓存本体、原文或词面。
      send(409, { error: "redaction_tier_cache_missing", reason: cause.reason, detail: cause.message });
    } else if (cause instanceof LocalLlmNotPreviewedError) {
      // 没预览过就点确认：与上一条是两个事实（「先去预览」vs「缓存坏了」），所以也是两个码。
      send(409, { error: "local_llm_not_previewed", detail: cause.message });
    } else if (cause instanceof LocalLlmConsultFailedError) {
      // PD-2：本机模型没跑成 ⇒ 阻断，不回落规则档。与「档位不可用」「没预览过」都是不同事实。
      send(409, {
        error: "local_llm_consult_failed",
        reason: cause.failureKind,
        detail: cause.message,
      });
    } else if (cause instanceof IngestUnavailableError) {
      send(503, { error: "ingest_unavailable", detail: cause.message });
    } else {
      send(500, { error: "internal_error" });
    }
  };

  try {
    // op1 查询待处理记录及状态
    if (path === "/api/ingest/pending" && method === "GET") {
      const q = listQuery.parse({
        limit: url.searchParams.get("limit") ?? undefined,
        offset: url.searchParams.get("offset") ?? undefined,
      });
      const { records } = facts.workspace.records.listRecords(q.limit ?? 200, q.offset ?? 0);
      // 判定读三轴（草案 §五）：`analysis_provider=none` 就是派生出的 manual_only，
      // 等价于旧的 `processing_mode !== "manual_only"`，但不再依赖派生字段说真话。
      const waiting = records.filter(
        (row) => PENDING_STATUSES.includes(row.processing_status) && row.analysis_provider !== "none",
      );
      // 摘要一次取齐（M3-PROJ-1）：旧写法每行再调一次 getRecord，既 N+1，
      // 又会把每条记录的全部历史版本读一遍只为拿当前版本那几个字。
      const rawById = facts.workspace.records.currentRawTexts(waiting.map((row) => row.id));
      const pending: PendingRecordDto[] = waiting.map((row) => ({
        recordId: row.id,
        currentRevisionId: row.current_revision_id,
        processingStatus: row.processing_status,
        processingMode: row.processing_mode,
        axes: axesOfRecord(row),
        privacyLevel: row.privacy_level,
        createdLocalDate: row.created_local_date,
        preview: (rawById.get(row.id) ?? "").slice(0, 80),
      }));
      const body: PendingRecordsResponse = { records: pending, total: pending.length };
      send(200, body);
      return true;
    }

    // M10-2 复核队列（只读派生视图，M10-D-3 的落点）。
    // 为什么挂在 `/api/ingest` 而不是规划里写的 `/api/records`：`handleRecordsRequest` 对
    // `/api/records` 前缀是**兜底认领**的（未命中就回 405），而它手里没有 `GrantService`——
    // 这一份投影要的正是 grants + `app_meta`，只有本路由拿得到（`facts.workspace.grants`）。
    if (path === "/api/ingest/review-queue" && method === "GET") {
      const q = listQuery.parse({
        limit: url.searchParams.get("limit") ?? undefined,
        offset: url.searchParams.get("offset") ?? undefined,
      });
      const { records } = facts.workspace.records.listRecords(q.limit ?? 200, q.offset ?? 0);
      // 队列只管**外发轨**（脱敏轨与原文轨）：`send_content_mode=none` 的记录没有要发的东西，
      // 复核它没有意义（断言 C6 钉这条排除）。三轴仍过 `axesOfRecord` 那道读侧门。
      const egress = records.filter((row) => isEgress(axesOfRecord(row)));
      const numbers = facts.workspace.records.currentRevisionNumbers(egress.map((row) => row.id));
      // 预跑读数**一次请求只取一次**（M10-D-10）：`snapshot()` 里的 `pending` 与每条的入队时刻
      // 出自同一张表、同一刻。取两次就会出现「同一份响应里两处读数不是同一刻」。
      const backlog = facts.prewarm?.snapshot() ?? null;
      const entries = egress
        .map(
          (row) =>
            reviewQueueEntry(
              facts.workspace.grants,
              row,
              numbers.get(row.id) ?? 0,
              backlog?.sinceByRevision.get(row.current_revision_id) ?? null,
            ),
        )
        .sort(compareReviewQueueEntries);
      const body: ReviewQueueResponse = {
        entries,
        total: entries.length,
        // 缺席的 0 是「这个夹具没接队列」，不是「本机没有在检查的任何东西」——见 `ServerFacts.prewarm`。
        prewarm: { pending: backlog?.pending ?? 0 },
      };
      send(200, body);
      return true;
    }

    // op8 查询当前模型与隐私模式（密钥只报「是否已配置」布尔，绝不报变量名取值）
    if (path === "/api/ingest/config" && method === "GET") {
      send(200, modelConfigDto(facts));
      return true;
    }

    // 设置页保存两档模型配置。只写配置文件并标记重启生效，不在本进程热换 Provider。
    if (path === "/api/ingest/config" && method === "PUT") {
      const parsed = updateModelConfigBody.parse(await readJsonBody(req));
      const local = profileFromBody(
        parsed.localModel,
        effectiveModelProfile(facts.config, "local_model"),
        "local_model",
      );
      const cloud = profileFromBody(
        parsed.cloudModel,
        effectiveModelProfile(facts.config, "cloud_redacted"),
        "cloud_redacted",
      );
      const primary = cloud.enabled ? cloud : local;
      // 本地脱敏档（M9-4d-1）：请求**省缺该段** ⇒ 逐字带回既有那一档（M9-D-2 的回归用例在
      // `tests/m9-1-local-llm-config.test.ts`）；给了该段 ⇒ 按同形严格校验重建，不碰另外两档。
      const localLlmNext =
        parsed.localLlm === undefined
          ? facts.config.model.local_llm
          : localLlmProfileFromBody(parsed.localLlm, facts.config.model.local_llm);
      const nextModel: AppConfig["model"] = {
        enabled: local.enabled || cloud.enabled,
        provider: primary.provider,
        base_url: primary.base_url,
        api_key_env: primary.api_key_env,
        cloud_redacted_enabled: cloud.enabled,
        request_timeout_ms: primary.request_timeout_ms,
        ...(primary.model === undefined ? {} : { model: primary.model }),
        ...(primary.call_path === undefined ? {} : { call_path: primary.call_path }),
        ...(primary.supports_structured_output === undefined
          ? {}
          : { supports_structured_output: primary.supports_structured_output }),
        ...(facts.config.model.params === undefined ? {} : { params: facts.config.model.params }),
        local_model: local,
        cloud_model: cloud,
        // 设置页不编辑这一档时它也要被带回去：整份 `model` 是被重建后写盘的，不带回去，
        // 一次「保存模型配置」就把用户手写的 `local_llm` 抹掉了（与上面 `params` 同一条理由）。
        ...(localLlmNext === undefined ? {} : { local_llm: localLlmNext }),
      };
      const nextConfig: AppConfig = {
        schema_version: facts.config.schema_version,
        server: facts.config.server,
        processing: facts.config.processing,
        model: nextModel,
      };
      if (cloud.enabled && keyAfterSave(facts, "cloud_redacted", parsed.cloudModel, cloud) === undefined) {
        throw new ConfigError(
          "云端整理已开启，但保存后没有可用密钥。请先输入密钥。",
          { fields: ["model.cloud_model.enabled", "credentials.cloud_redacted"] },
        );
      }
      writeConfigFile(ensureConfigFile(facts.layout), nextConfig);
      applyCredentialChange(facts, "local_model", parsed.localModel);
      applyCredentialChange(facts, "cloud_redacted", parsed.cloudModel);
      facts.config.model = nextModel;
      facts.runtime.configDirty = true;
      send(200, modelConfigDto(facts));
      return true;
    }

    // M5-6 测试连接：使用当前表单值做一次最小探测；不保存、不建记录、不写 parse_run。
    if (path === "/api/ingest/config/test" && method === "POST") {
      const parsed = testModelConnectionBody.parse(await readJsonBody(req));
      const mode = parsed.profile === "local" ? "local_model" : "cloud_redacted";
      const savedProfile = effectiveModelProfile(facts.config, mode);
      const typed = parsed.apiKey?.trim();
      const key =
        typed !== undefined && typed !== ""
          ? typed
          : facts.credentials.resolve(
              mode,
              savedProfile.api_key_env ?? DEFAULT_API_KEY_ENV,
              facts.env,
            ).key;
      const adapter: ModelAdapter = {
        provider: parsed.provider,
        model: parsed.model,
        baseUrl: parsed.baseUrl,
        callPath: parsed.callPath,
        supportsStructuredOutput: parsed.supportsStructuredOutput,
        requestTimeoutMs: parsed.requestTimeoutMs,
        apiKeyEnv: savedProfile.api_key_env ?? DEFAULT_API_KEY_ENV,
        ...(key === undefined ? {} : { resolveApiKey: () => key }),
      };
      const result = await probeModelConnection(
        adapter,
        mode,
        facts.workspace.ingestProvider?.transport ?? httpTransport,
      );
      send(200, result satisfies ModelConnectionTestResultDto);
      return true;
    }

    // M9-1 本地脱敏模型连接测试。M9-4d-1b 起可选收一个 `profile`（草稿）：
    //  - 给了 profile ⇒ 用**它**装配探测（与保存路径同一套 `localLlmProfileFromBody` 形状校验），
    //    但**不写盘、不改 `facts.config`、不置 `configDirty`**：只在一份浅拷贝的「影子」配置上判状态。
    //  - 省缺 profile（或空 body）⇒ 现行行为：读 `localLlmStatus(facts.config)` 与已保存的那一档。
    // 两种情况共用同一条纪律：不可用 ⇒ 一次请求都不发（执行准则 §三 C2），原因回枚举本身。
    if (path === "/api/ingest/local-llm/test" && method === "POST") {
      const body = localLlmTestBody.parse(await readJsonBody(req));
      const draft =
        body.profile === undefined
          ? null
          : localLlmProfileFromBody(body.profile, facts.config.model.local_llm);
      const status =
        draft === null
          ? localLlmStatus(facts.config)
          : localLlmStatus({ ...facts.config, model: { ...facts.config.model, local_llm: draft } });
      const profile = status.profile;
      if (!status.usable || profile === null) {
        const reason = status.reason ?? "not_configured";
        send(200, {
          usable: false,
          reason,
          // M9-D-4：判别进 `reason`，句子进 `message`。文案只解释现状与下一步，
          // 不带端点响应体、URL 的凭据部分或任何记录内容。
          message: localLlmUnusableMessage(reason),
          structuredOutput: null,
          latencyMs: 0,
        } satisfies LocalLlmTestResultDto);
        return true;
      }
      // 适配器装配与 op6 共用同一份（`provider.adapterForLocalLlm`，M9-D-1）。
      const adapter = adapterForLocalLlm(profile, facts.env);
      const result = await probeLocalLlm(adapter, facts.workspace.ingestProvider?.transport ?? httpTransport);
      send(200, result satisfies LocalLlmTestResultDto);
      return true;
    }

    // M5-6 保存整理方式默认值：部分更新 + 镜像写盘。不切 Provider 装配，因此不需要重启。
    if (path === "/api/ingest/config/processing" && method === "PATCH") {
      const parsed = updateProcessingDefaultsBody.parse(await readJsonBody(req));
      const current = effectiveProcessingDefaults(facts.config.processing);
      const record = parsed.recordDefaultMode ?? current.record_default_mode;
      const nextProcessing = {
        default_mode: record,
        record_default_mode: record,
        sleep_default_mode: parsed.sleepDefaultMode ?? current.sleep_default_mode,
        remember_last_mode: parsed.rememberLastMode ?? current.remember_last_mode,
      };
      const nextConfig: AppConfig = {
        schema_version: facts.config.schema_version,
        server: facts.config.server,
        processing: nextProcessing,
        model: facts.config.model,
      };
      writeConfigFile(ensureConfigFile(facts.layout), nextConfig);
      facts.config.processing = nextProcessing;
      send(200, toProcessingDefaultsDto(facts) satisfies ProcessingDefaultsDto);
      return true;
    }

    // op6 展示实际准备发送的文本（外发载荷预览；map 不上线）
    if (path === "/api/ingest/preview" && method === "POST") {
      const parsed = previewBody.parse(await readJsonBody(req));
      const { record } = facts.workspace.records.getRecord(parsed.recordId);
      const axes = axesOfRecord(record);
      const localLlm = localLlmStatus(facts.config);
      // 档位不可用（未配置 / 已关闭 / 非回环 / 缺 model）⇒ 预览阶段就拒：不给一份
      // 「别的档位产的脱敏文本」冒充用户所选那一档（M9-4b，取代旧的「这一档没实现」）。
      // 这一份读数是路由内**唯一**一处：往下 `resolveLocalLlmPreview` 不再判可用性。
      assertRedactionPlanRunnable(axes, record.current_revision_id, localLlm);
      // F-2 强制重跑：「重跑脱敏」带 force:true ⇒ 先清本地模型档这一版的缓存（三键 + 失败标记），
      // 让下面 `resolveEgressPreview` 里的 `hasCachedLlmSpans` 变假、真的再问一次模型。只清
      // `local_llm` 档，规则档 `preview_*` 不动（见 `GrantService.clearLlmTierCache`）。
      if (parsed.force === true) {
        facts.workspace.grants.clearLlmTierCache(record.current_revision_id);
      }
      // 预览装配的唯一入口（M9-4d-pre / M9-D-13）：档位判据住在 `resolveEgressPreview` 里，
      // 路由不判第二次。`local_llm` + `redacted` ⇒ 必要时咨询模型；咨询失败抛
      // `LocalLlmConsultFailedError`（409，PD-2 阻断），不再回落规则档。
      const preview = await resolveEgressPreview(
        facts.workspace.grants,
        adapterForLocalLlm(localLlm.profile, facts.env),
        record.current_revision_id,
        axes,
        parsed.payloadText === undefined ? {} : { payloadText: parsed.payloadText },
      );
      const body: SendPreviewDto = {
        recordId: preview.recordId,
        recordRevisionId: preview.recordRevisionId,
        revisionNumber: preview.revisionNumber,
        policyVersion: preview.policyVersion,
        // 这份预览属于哪一条外发轨道（草案 §八之二-1：授权绑 payload_sha256，
        // redacted 与 raw 的载荷哈希天然不同，所以「对原文的点头」不可能被脱敏路径复用）。
        sendContentMode: axes.sendContentMode,
        redactedText: preview.redactedText,
        payloadText: preview.payloadText,
        payloadSha256: preview.payloadSha256,
        hasApplicableGrant: facts.workspace.grants.grantForPreview(preview) !== null,
        // 「这一处是谁遮的」与「这一层这次跑过没有」（M9-4c）：都是服务层已算好的投影，
        // 路由不重新判定；映射本体（`preview.map`）依旧不外泄。
        spans: preview.spans,
        llmLayer: preview.llmLayer,
      };
      send(200, body);
      return true;
    }

    // op7 保存用户对发送内容的明确确认 → 签发 CloudSendGrant
    if (path === "/api/ingest/confirm-send" && method === "POST") {
      const parsed = previewBody.parse(await readJsonBody(req));
      const { record } = facts.workspace.records.getRecord(parsed.recordId);
      // 与 op6/op2 同一道载荷装配与同一道档位门（草案 §五）：确认的是**实际要发的那份文本**，
      // 而确认之前必须先问「用户选的这一档现在能不能跑」——否则签出的是一行永远发不出去的授权。
      // 若这里恒走脱敏预览，raw 记录签出的授权哈希永远对不上要发的原文，用户怎么确认都发不出去。
      const axes = axesOfRecord(record);
      assertRedactionPlanRunnable(axes, record.current_revision_id, localLlmStatus(facts.config));
      // op7 **只复现、不咨询**（M9-D-13）：确认绑定的是用户看过的那一份。三条分支收在
      // `previewForConfirmSend` 一处——有采信区间 ⇒ 签 `rules+local_llm-v1`；只有咨询失败标记
      // ⇒ 用户看过的就是回落那份，签 `rules-v1`；两者都没有 ⇒ 409 `local_llm_not_previewed`。
      const preview = previewForConfirmSend(
        facts.workspace.grants,
        record.current_revision_id,
        axes,
        parsed.payloadText,
      );
      const grant = facts.workspace.grants.issueGrant(preview);
      const body: GrantDto = {
        grantId: grant.id,
        recordRevisionId: grant.record_revision_id,
        payloadSha256: grant.payload_sha256,
        policyVersion: grant.policy_version,
        confirmedAtUtc: grant.confirmed_at_utc,
      };
      send(201, body);
      return true;
    }

    // op2 发起解析（body.recordId 定位当前版本）
    if (path === "/api/ingest/parse" && method === "POST") {
      const parsed = parseBody.parse(await readJsonBody(req));
      send(200, await runParse(facts, parsed.recordId, parsed));
      return true;
    }

    // op5 主动重新解析（同幂等入口：同 revision+同管线=同任务，重放而非重复产出）
    const reparseMatch = /^\/api\/ingest\/records\/([^/]+)\/reparse$/.exec(path);
    if (reparseMatch && method === "POST") {
      const recordId = decodeURIComponent(reparseMatch[1]!);
      send(200, await runParse(facts, recordId, {}));
      return true;
    }

    // M8-2 用户显式的「重新分析」：闸门与 op2 逐字同一条（档位门、manual_only 门、四腿授权门都在
    // runParse 里），差别只有 `reanalysis: true` 这一个意图位——它换来的是尝试序号后缀，
    // 换来不了任何放松。op5 的 reparse 语义（重放而非重复产出）保持原样，两者是两件事。
    const reanalyzeMatch = /^\/api\/ingest\/records\/([^/]+)\/reanalyze$/.exec(path);
    if (reanalyzeMatch && method === "POST") {
      const recordId = decodeURIComponent(reanalyzeMatch[1]!);
      send(200, await runParse(facts, recordId, { reanalysis: true }));
      return true;
    }

    // op3 查询解析运行状态和错误摘要 / op4 重新尝试失败任务
    const runMatch = /^\/api\/ingest\/runs\/([^/]+)$/.exec(path);
    if (runMatch) {
      const runId = decodeURIComponent(runMatch[1]!);
      const service = facts.workspace.makeIngestService();
      if (service === null) throw new IngestUnavailableError();
      if (method === "GET") {
        const row = service.readRun(runId);
        if (row === null) throw new RunNotFoundError(runId);
        send(200, toRunDto(row));
        return true;
      }
      // op4 重试失败任务：定位该 run 的来源版本所属记录，走同一幂等入口（成功重放、失败续跑）。
      if (method === "POST") {
        const row = service.readRun(runId);
        if (row === null) throw new RunNotFoundError(runId);
        const recordId = service.recordIdOfRevision(row.source_revision_id);
        if (recordId === null) throw new RevisionNotFoundError(row.source_revision_id);
        send(200, await runParse(facts, recordId, {}));
        return true;
      }
    }

    // op9 展示用户修正后的有效结果（current 视图 ⊕ override 投影；只读）
    const effectiveMatch = /^\/api\/ingest\/effective\/([^/]+)$/.exec(path);
    if (effectiveMatch && method === "GET") {
      const revisionId = decodeURIComponent(effectiveMatch[1]!);
      const service = facts.workspace.makeIngestService();
      if (service === null) throw new IngestUnavailableError();
      const view = service.readableView(revisionId);
      const corrections = facts.workspace.corrections;
      const overrides: OverrideDto[] = [];
      // 集合语义与 M2-6 逐字相同（哪些表、哪些 id、组内按 field_name），差别只在**一次**批量取数。
      const collect = (table: OverridableTable, ids: readonly string[]): void => {
        const grouped = corrections.overridesByObject(table, ids);
        for (const objectId of ids) {
          for (const o of grouped.get(objectId) ?? []) {
            overrides.push({
              objectTable: o.object_table,
              objectId: o.object_id,
              fieldName: o.field_name,
              valueJson: o.value_json,
              updatedAtUtc: o.updated_at_utc,
            });
          }
        }
      };
      collect("episode", view.episodes);
      collect("thought_item", view.thoughts);
      collect("concept", [...view.emotions, ...view.topics]);
      collect("entity", view.entities);
      const body: EffectiveResultDto = {
        revisionId: view.revisionId,
        currentRunId: view.currentRunId,
        episodes: [...view.episodes],
        thoughts: [...view.thoughts],
        emotions: [...view.emotions],
        topics: [...view.topics],
        entities: [...view.entities],
        candidates: view.candidates.map((c) => ({ runId: c.runId, fingerprint: c.fingerprint })),
        overrides,
        // ── M3-PROJ-1 可读扩集（§六 缺口清单；既有九字段逐字未动） ──
        episodeItems: [...view.episodeItems],
        thoughtItemItems: [...view.thoughtItems],
        emotionItems: [...view.emotionItems],
        topicItems: [...view.topicItems],
        entityItems: [...view.entityItems],
        conceptTargets: [...view.conceptTargets],
        entityTargets: [...view.entityTargets],
        suggestionItems: [...view.suggestionItems],
        aiTitle: view.aiTitle,
        aiSummary: view.aiSummary,
        runHistory: [...view.runHistory],
      };
      send(200, body);
      return true;
    }

    // op7' 采纳 / 放弃候选结果（§四-8 收账）：服务面 `adoptCurrent` 与 `discardCandidate`
    // 早已存在且已测（m2-ingest-service 钉着「只有 candidate 可以被放弃」那条），本轮补的是对外这一格。
    // 两个动作都**不是删除**：候选转 superseded、历史行留在库里，所以界面敢接。
    if (path === "/api/ingest/adopt" && method === "POST") {
      const parsed = adoptBody.parse(await readJsonBody(req));
      const service = facts.workspace.makeIngestService();
      if (service === null) throw new IngestUnavailableError();
      const adopted = service.adoptCurrent({ candidateRunId: parsed.candidateRunId });
      const body: AdoptRunResultDto = {
        adoptedRunId: adopted.adoptedRunId,
        supersededRunId: adopted.supersededRunId,
      };
      send(200, body);
      return true;
    }

    if (path === "/api/ingest/discard" && method === "POST") {
      const parsed = adoptBody.parse(await readJsonBody(req));
      const service = facts.workspace.makeIngestService();
      if (service === null) throw new IngestUnavailableError();
      service.discardCandidate(parsed.candidateRunId);
      send(200, { discardedRunId: parsed.candidateRunId } satisfies DiscardRunResultDto);
      return true;
    }

    // Phase B（PD-1）：撤销一次已生效的结果。只接受 succeeded + current；历史行不删。
    if (path === "/api/ingest/undo-adopt" && method === "POST") {
      const parsed = undoBody.parse(await readJsonBody(req));
      const service = facts.workspace.makeIngestService();
      if (service === null) throw new IngestUnavailableError();
      service.undoCurrent(parsed.runId);
      send(200, { undoneRunId: parsed.runId });
      return true;
    }

    send(404, { error: "not_found", path });
    return true;
  } catch (cause) {
    fail(cause);
    return true;
  }
}
