import type { IncomingMessage, ServerResponse } from "node:http";

import { z } from "zod";

import type {
  AdoptRunResultDto,
  ConfirmCandidatesResultDto,
  DiscardRunResultDto,
  EffectiveResultDto,
  GrantDto,
  IngestResultDto,
  IngestRunDto,
  ModelProfileDto,
  ModelPrivacyConfigDto,
  OverrideDto,
  PendingRecordDto,
  PendingRecordsResponse,
  SendPreviewCandidateDto,
  SendPreviewDto,
} from "../../shared/dto.ts";
import {
  effectiveModelProfile,
  ensureConfigFile,
  writeConfigFile,
  type AppConfig,
  type ModelProfileConfig,
} from "../config/config.ts";
import { ConfigError } from "../config/errors.ts";
import type { OverridableTable } from "../correction/service.ts";
import {
  CorrectionInputError,
  OverrideFieldError,
} from "../correction/service.ts";
import {
  IngestInputError,
  IngestStateError,
  RedactionMapRequiredError,
  RunNotAdoptableError,
  RunNotFoundError,
  type IngestResult,
} from "../ingest/ingestService.ts";
import { ProcessingModeError, PROVIDER_CALL_PATHS } from "../ingest/provider.ts";
import {
  CloudSendAuthorizationRequiredError,
  PolicyVersionError,
  RevisionNotFoundError,
} from "../privacy/grantService.ts";
import { EntityConfirmError } from "../privacy/entityConfirm.ts";
import { RecordNotFoundError, RecordValidationError } from "../records/service.ts";
import type { ServerFacts } from "./httpServer.ts";
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
 * （「manual_only 的记录不计入待整理」），故 op1 在本集合之外再排除 processing_mode === "manual_only"。
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
const parseBody = z
  .object({
    recordId: z.string().min(1),
    processingMode: z.enum(["manual_only", "local_model", "cloud_redacted"]).optional(),
    payloadText: z.string().optional(),
  })
  .strict();
const previewBody = z
  .object({
    recordId: z.string().min(1),
    payloadText: z.string().optional(),
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
    requestTimeoutMs: z.number().int().min(1000).max(120000),
    apiKeyEnv: z.string().regex(/^[A-Z][A-Z0-9_]{1,127}$/),
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
  });
const updateModelConfigBody = z
  .object({
    localModel: modelProfileBody,
    cloudModel: modelProfileBody,
  })
  .strict();

// RED-1 确认采纳候选 → provisional 实体：kind 的取值门在 entityConfirm 里按封闭 8 值判，
// 这里只做形状约束（词面非空、kind 为字符串），非法 kind 由服务层拒为 400。
const confirmCandidatesBody = z
  .object({
    recordId: z.string().min(1),
    adopted: z
      .array(
        z
          .object({
            term: z.string().min(1),
            kind: z.string().min(1),
          })
          .strict(),
      ),
  })
  .strict();

/** op7' 采纳：只认一个候选 run 主键，其余判断（能否采纳）全在服务层。 */
const adoptBody = z
  .object({
    candidateRunId: z.string().min(1),
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
    succeeded: result.succeeded,
    replayed: result.replayed,
    recovered: result.recovered,
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
  previous: ModelProfileConfig,
): ModelProfileConfig {
  return {
    enabled: input.enabled,
    provider: input.provider,
    base_url: input.baseUrl,
    api_key_env: input.apiKeyEnv,
    request_timeout_ms: input.requestTimeoutMs,
    ...(input.model === "" ? {} : { model: input.model }),
    call_path: input.callPath,
    supports_structured_output: input.supportsStructuredOutput,
    // 设置页只编辑常用项；配置文件里已有的高级 params 原样保留。
    ...(previous.params === undefined ? {} : { params: previous.params }),
  };
}

function toModelProfileDto(
  facts: ServerFacts,
  profile: ModelProfileConfig,
  mode: "local_model" | "cloud_redacted",
): ModelProfileDto {
  const key = process.env[profile.api_key_env];
  return {
    enabled: profile.enabled,
    provider: profile.provider,
    model: profile.model ?? null,
    baseUrl: profile.base_url,
    callPath: profile.call_path ?? null,
    supportsStructuredOutput: profile.supports_structured_output ?? false,
    requestTimeoutMs: profile.request_timeout_ms,
    apiKeyEnv: profile.api_key_env,
    apiKeyConfigured: typeof key === "string" && key.trim() !== "",
    ready: facts.workspace.ingestReadyFor(mode),
  };
}

function modelConfigDto(facts: ServerFacts): ModelPrivacyConfigDto {
  const model = facts.config.model;
  const local = effectiveModelProfile(facts.config, "local_model");
  const cloud = effectiveModelProfile(facts.config, "cloud_redacted");
  const keyVal = process.env[cloud.api_key_env];
  // provider/model/callPath 的真值来自当前实际装配的适配器；未装配时如实为 null，不猜。
  const adapter = facts.workspace.ingestProvider?.adapter ?? null;
  return {
    defaultMode: facts.config.processing.default_mode,
    modelEnabled: model.enabled,
    provider: adapter?.provider ?? null,
    model: adapter?.model ?? null,
    callPath: adapter?.callPath ?? null,
    cloudRedactedEnabled: model.cloud_redacted_enabled,
    requestTimeoutMs: model.request_timeout_ms,
    apiKeyConfigured: typeof keyVal === "string" && keyVal.trim() !== "",
    ingestReady: facts.workspace.ingestReady,
    localModel: toModelProfileDto(facts, local, "local_model"),
    cloudModel: toModelProfileDto(facts, cloud, "cloud_redacted"),
    restartRequired: facts.runtime.configDirty,
  };
}

// ── 解析核心（op2 发起 / op4 重试 / op5 主动重跑共用同一幂等入口） ──

async function runParse(
  facts: ServerFacts,
  recordId: string,
  input: { processingMode?: string | undefined; payloadText?: string | undefined },
): Promise<IngestResultDto> {
  const { record } = facts.workspace.records.getRecord(recordId);
  const revisionId = record.current_revision_id;
  const mode = record.processing_mode as "manual_only" | "local_model" | "cloud_redacted";

  if (record.processing_mode === "cloud_redacted") {
    // 云端：映射与待发送文本由服务端本次现算（map 绝不上线），授权闸门绑定具体 (rev,payload,policy)。
    const preview = facts.workspace.grants.preparePreview(revisionId, {
      ...(input.payloadText === undefined ? {} : { payloadText: input.payloadText }),
    });
    const guarded = facts.workspace.makeIngestService("cloud_redacted", () =>
      facts.workspace.grants.requireApplicableGrant(
        preview.recordRevisionId,
        preview.payloadSha256,
        preview.policyVersion,
      ),
    );
    if (guarded === null) throw new IngestUnavailableError();
    const result = await guarded.ingest({
      recordRevisionId: revisionId,
      ...(input.processingMode === undefined ? {} : { processingMode: input.processingMode as never }),
      payloadText: preview.payloadText,
      redactionMap: preview.map,
    });
    return toIngestResultDto(result);
  }

  const service = facts.workspace.makeIngestService(mode);
  if (service === null) {
    // 解析能力未就绪：显式拒绝，不拿半套配置假装能发（fail-fast 精神，非内部错误）。
    throw new IngestUnavailableError();
  }
  const result = await service.ingest({
    recordRevisionId: revisionId,
    ...(input.processingMode === undefined ? {} : { processingMode: input.processingMode as never }),
    ...(input.payloadText === undefined ? {} : { payloadText: input.payloadText }),
  });
  return toIngestResultDto(result);
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
      cause instanceof PolicyVersionError ||
      cause instanceof EntityConfirmError
    ) {
      send(400, { error: "invalid_request", detail: cause.message });
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
      cause instanceof RunNotAdoptableError
    ) {
      send(409, { error: "state_conflict", detail: cause.message });
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
      const waiting = records.filter(
        (row) => PENDING_STATUSES.includes(row.processing_status) && row.processing_mode !== "manual_only",
      );
      // 摘要一次取齐（M3-PROJ-1）：旧写法每行再调一次 getRecord，既 N+1，
      // 又会把每条记录的全部历史版本读一遍只为拿当前版本那几个字。
      const rawById = facts.workspace.records.currentRawTexts(waiting.map((row) => row.id));
      const pending: PendingRecordDto[] = waiting.map((row) => ({
        recordId: row.id,
        currentRevisionId: row.current_revision_id,
        processingStatus: row.processing_status,
        processingMode: row.processing_mode,
        privacyLevel: row.privacy_level,
        createdLocalDate: row.created_local_date,
        preview: (rawById.get(row.id) ?? "").slice(0, 80),
      }));
      const body: PendingRecordsResponse = { records: pending, total: pending.length };
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
      );
      const cloud = profileFromBody(
        parsed.cloudModel,
        effectiveModelProfile(facts.config, "cloud_redacted"),
      );
      const primary = cloud.enabled ? cloud : local;
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
      };
      const nextConfig: AppConfig = {
        schema_version: facts.config.schema_version,
        server: facts.config.server,
        processing: facts.config.processing,
        model: nextModel,
      };
      writeConfigFile(ensureConfigFile(facts.layout), nextConfig);
      facts.config.model = nextModel;
      facts.runtime.configDirty = true;
      send(200, modelConfigDto(facts));
      return true;
    }

    // op6 展示实际准备发送的文本（脱敏预览；map 不上线）
    if (path === "/api/ingest/preview" && method === "POST") {
      const parsed = previewBody.parse(await readJsonBody(req));
      const { record } = facts.workspace.records.getRecord(parsed.recordId);
      const preview = facts.workspace.grants.preparePreview(record.current_revision_id, {
        ...(parsed.payloadText === undefined ? {} : { payloadText: parsed.payloadText }),
      });
      // 陌生名字候选（RED-1「已定」②）：只从原文现算、只进预览。它不进 redact() 替换集合，
      // 不改变 redactedText/payloadText/payloadSha256 —— 脱敏集合未变，policy_version 不升。
      const candidates: readonly SendPreviewCandidateDto[] = facts.workspace.grants
        .deriveCandidates(record.current_revision_id)
        .map((c) => ({
          term: c.term,
          suggestedKind: c.suggestedKind,
          basis: c.basis,
          occurrences: [...c.occurrences],
        }));
      const body: SendPreviewDto = {
        recordId: preview.recordId,
        recordRevisionId: preview.recordRevisionId,
        revisionNumber: preview.revisionNumber,
        policyVersion: preview.policyVersion,
        redactedText: preview.redactedText,
        payloadText: preview.payloadText,
        payloadSha256: preview.payloadSha256,
        hasApplicableGrant: facts.workspace.grants.grantForPreview(preview) !== null,
        candidates,
      };
      send(200, body);
      return true;
    }

    // RED-1 确认采纳的候选 → provisional 实体（零模型调用，纯本地词表/规则通道）
    if (path === "/api/ingest/confirm-candidates" && method === "POST") {
      const parsed = confirmCandidatesBody.parse(await readJsonBody(req));
      // 全走服务层：记录不存在 → currentRevisionIdOf 抛 RevisionNotFoundError(404)；
      // 非法 kind → entityConfirm 抛 EntityConfirmError(400)；确认成功后作废本 revision 预览缓存。
      const result = facts.workspace.grants.confirmCandidates(parsed.recordId, parsed.adopted);
      const body: ConfirmCandidatesResultDto = {
        created: result.created,
        skipped: result.skipped,
      };
      send(201, body);
      return true;
    }

    // op7 保存用户对发送内容的明确确认 → 签发 CloudSendGrant
    if (path === "/api/ingest/confirm-send" && method === "POST") {
      const parsed = previewBody.parse(await readJsonBody(req));
      const { record } = facts.workspace.records.getRecord(parsed.recordId);
      const preview = facts.workspace.grants.preparePreview(record.current_revision_id, {
        ...(parsed.payloadText === undefined ? {} : { payloadText: parsed.payloadText }),
      });
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

    send(404, { error: "not_found", path });
    return true;
  } catch (cause) {
    fail(cause);
    return true;
  }
}
