import type { IncomingMessage, ServerResponse } from "node:http";

import { z } from "zod";

import {
  assertThreeAxes,
  coerceAxes,
  deriveProcessingMode,
  isEgress,
  SEND_CONTENT_MODE_VALUES,
  ThreeAxisCombinationError,
  ThreeAxisValueError,
} from "../../shared/contracts/enums.ts";
import type { JobListDto, JobViewDto } from "../../shared/dto.ts";
import { localLlmStatus } from "../config/config.ts";
import { DEFAULT_PROMPT_VERSION } from "../ingest/ingestService.ts";
import {
  adapterForLocalLlm,
  assertRedactionPlanRunnable,
  ProcessingModeError,
  RedactionModeUnavailableError,
} from "../ingest/provider.ts";
import { JobLease } from "../jobs/jobLease.ts";
import {
  JobInputError,
  JobNotFoundError,
  JobRevisionNotFoundError,
  JobStore,
  type JobRow,
} from "../jobs/jobStore.ts";
import {
  CloudSendAuthorizationRequiredError,
  LocalLlmTierCacheMissingError,
  RevisionNotFoundError,
} from "../privacy/grantService.ts";
import { LocalLlmNotPreviewedError } from "../privacy/egressPreview.ts";
import { REDACTION_POLICY_VERSION } from "../privacy/redaction.ts";
import { resolveEgressPreview } from "../privacy/localLlmPreview.ts";
import { RecordNotFoundError } from "../records/service.ts";
import type { ServerFacts } from "./httpServer.ts";
import { BodyTooLargeError } from "./recordsRoutes.ts";

/**
 * M6-0E 第二批：后台任务队列的**观测与取消**面（草案 §六 / §七 / §八 断言 6）。
 *
 * 前缀单独占 `/api/jobs`，不挂到 `/api/records/:id/...` 下面：`recordsRoutes.ts` 以
 * `/api/records` 前缀整体接管那一段路径，往里塞子路径会让「谁先处理这个请求」变成
 * 路由顺序问题，而不是语义问题。三条接口：
 *   · `GET  /api/jobs?recordId=<id>`  ⇒ `JobListDto`（时间序从旧到新，前端自己取末项）。
 *   · `POST /api/jobs`（`{recordId}`）⇒ 手动入队（M6-1D）：`created` ⇒ 201，幂等命中 ⇒ 200，
 *     两者都回 `JobViewDto`。
 *   · `POST /api/jobs/:id/cancel`     ⇒ 取消后的 `JobViewDto`。
 * 观测方式是**轮询**（§七 已定口径）：不建 SSE/WebSocket，也不给进度百分比。
 * 「取消全部」「清空失败」这类接口草案里没有，就不做——用户一次只关心一条任务。
 * **没有自动入队**（M6-1D 的裁决）：这一面只有用户按下的那一次。
 */
const JOBS_PREFIX = "/api/jobs";

const MAX_BODY_BYTES = 1_048_576;

const listQuery = z.object({ recordId: z.string().min(1) });
/** 入队体只有**一条记录**这一个指针：三轴、载荷、文本全都不由调用方给（下面按在册值现取）。 */
const enqueueBody = z.object({ recordId: z.string().min(1) }).strict();

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new BodyTooLargeError();
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
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

/**
 * 请求期现取任务服务：`workspace.db` 是会被整库替换（R-5）换掉的可变句柄，
 * 所以这里每请求构造一个 `JobStore`，和 records 路由「每请求现取服务」同一条纪律。
 *
 * 这个工厂为什么住在路由层：`JobStore` 不属于 `Workspace` 的单例装配面（草案没有为队列
 * 建常驻服务，worker 那一批自己另有点），而 `ingestRoutes.ts` 又必须能取消同 revision 的
 * 排队任务（断言 6）。把构造点收在这里，同步入口只需要 `jobStoreFor(facts)` 一个调用，
 * 不必自己碰 db 句柄——那条纪律由 `m2-api` 的静态断言钉着（路由文件里不得出现
 * `facts.workspace.db` / 裸 SQL）。
 */
export function jobStoreFor(facts: ServerFacts): JobStore {
  return new JobStore(facts.workspace.db, { leases: jobLeaseFor(facts) });
}

/**
 * 租约归属的**请求期**一份读数（M6-1D 裁决 ①-b）。
 * 身份是进程级单例（`currentProcessInstanceId`），所以路由这一份与 bootstrap 里 worker 那一份
 * 在同一进程内永远同 id：本进程正在跑的行不会被路由侧误判成「别人在用」。
 * 它与 `jobStoreFor` 同点构造——两者都按 R-5 每请求现取句柄，不冻在闭包里。
 */
function jobLeaseFor(facts: ServerFacts): JobLease {
  return new JobLease(facts.workspace.db);
}

/**
 * 手动入队（M6-1D）。闸门顺序照同步入口 `runParse`：那道入口在哪些地方拒绝，这一道就在同样的
 * 地方拒绝——两个入口做的是同一件事，拒绝的理由不许分岔。
 *
 * 返回 `{ row, created }`：`created=false` 是幂等命中（同 revision + 同三轴 + 同版本已经有一行），
 * 路由据此给 200 而不是 201，行的现状原样投影出去——用户看到的是「已经在排了」，不是两个计数。
 */
async function enqueueForRecord(
  facts: ServerFacts,
  jobs: JobStore,
  recordId: string,
): Promise<{ row: JobRow; created: boolean }> {
  const { record } = facts.workspace.records.getRecord(recordId);
  const revisionId = record.current_revision_id;
  const axes = coerceAxes(record.analysis_provider, record.redaction_mode, record.send_content_mode);
  assertThreeAxes(axes);
  const mode = deriveProcessingMode(axes);

  // `local_llm` 档（M9-4b）：与 op2/op6/op7 同一道门，错误码 `redaction_mode_unavailable`。
  // 位置不动——「这一档现在跑不了」必须在写下任务行之前就说出来，入队之后没人会再问配置。
  const localLlm = localLlmStatus(facts.config);
  assertRedactionPlanRunnable(axes, revisionId, localLlm);
  if (axes.analysisProvider === "none") {
    // reason 名沿用旧称 `manual_only`（三轴时代之前的名字，已进 trace 与既有错误面）。
    throw new ProcessingModeError(
      "manual_only",
      revisionId,
      `analysis_provider=none（派生 ${mode}）—— 这一档承诺不经任何模型，后台没有可排的活：` +
        "排进去只会得到一行永远做不成的任务（Spec §5.2、草案 §三 规则 3）。",
    );
  }
  // 这一档本机有没有适配器 = 解析能力就绪与否（`ingestReadyFor` 与它是同一个判据），
  // 顺手把适配器本身拿来填幂等键的 `model_id` 段——两处判据不许各问一遍。
  const adapter = facts.workspace.adapterFor(mode);
  if (adapter === null) {
    // 与 op2 同一口径：`ingest_unavailable` / 503。这一档本机没有可用的适配器，
    // 入队等于往库里写一行只有 worker 认领了才算数的意图，而 worker 现在就绪不了（§五 a 段）。
    throw new JobProviderUnavailableError();
  }

  // 外发轨（redacted 与 raw）：载荷本次现算。快照里没有载荷文本这个键（`JOB_SNAPSHOT_FIELDS` 是
  // 封闭七键，禁区不给它加列），执行体到点时用同一份装配现算预览：`redacted` 走 `GrantService` 的
  // nonce/载荷缓存（R-2），算出的正是 op7 确认时那一份，`raw` 恒等于该版本原文——所以队列与同步入口发的是同一份文本。
  //
  // 整理方式改动 S-4：**入队不再因缺授权被拒**。从前这里直接 `requireApplicableGrant`（抛 409），
  // 于是「保存并整理」对一条从没预览过的外发记录必然失败——用户看到的是「没存下来」，而实际上
  // 什么也没发生。那道门挪到认领侧（`makeEgressGrantRunnable`）：没有本次授权 ⇒ 行照样写下、
  // 排在队列里、worker 每一拍跳过它，直到用户在待整理确认。授权本身仍是四腿逐字那一份，一处没放宽。
  // 这次现算另有双重作用：把 `local_llm` 档的脱敏先跑好（预览口径 = 自动预跑），并拿到写进幂等键的
  // `redaction_policy_version`——问成之后载荷变了也照排这一版，因为「排进去」说的就是这一刻的意图。
  const preview = isEgress(axes)
    ? await resolveEgressPreview(
        facts.workspace.grants,
        adapterForLocalLlm(localLlm.profile, facts.env),
        revisionId,
        axes,
      )
    : null;

  const { row, created } = jobs.enqueue({
    recordRevisionId: revisionId,
    axes,
    versions: {
      // 四段版本标识一律取既有单点，不现编（执行准则 M6-1D）：
      promptVersion: DEFAULT_PROMPT_VERSION,
      schemaVersion: String(facts.workspace.schemaVersion),
      modelId: adapter.model ?? adapter.provider,
      // 不外发的档位没有本次脱敏产物，取当前在册的政策版本：它在幂等键里说的是「同一套政策
      // 算出同一个结果」，不是「这次发了什么」。
      redactionPolicyVersion: preview === null ? REDACTION_POLICY_VERSION : preview.policyVersion,
    },
  });
  return { row, created };
}

/**
 * 快照里的 `send_content_mode`（UI 需要说清这次自动处理发的是原文还是脱敏文本）。
 *
 * 读侧只做一件事：取值必须在 `SEND_CONTENT_MODE_VALUES` 的封闭清单里，否则按 `"none"`。
 * 落到兜底分支只可能是快照被外部篡改——写侧 `snapshotJson()` 按 `JOB_SNAPSHOT_FIELDS`
 * 的封闭字段清单序列化，`send_content_mode` 恒在其中且取值受迁移 CHECK 约束。这里**不抛
 * 500**：一个观测用的投影字段不该让整条轮询接口失败，保守地说「这一版不发任何内容」
 * 比谎报「发的是原文」好。
 */
function sendContentModeOf(snapshotJson: string): JobViewDto["sendContentMode"] {
  const isSendContentMode = (value: unknown): value is JobViewDto["sendContentMode"] =>
    typeof value === "string" && (SEND_CONTENT_MODE_VALUES as readonly string[]).includes(value);
  try {
    const parsed: unknown = JSON.parse(snapshotJson);
    if (parsed !== null && typeof parsed === "object" && "send_content_mode" in parsed) {
      const value = (parsed as Record<string, unknown>)["send_content_mode"];
      if (isSendContentMode(value)) return value;
    }
  } catch {
    // 损坏的 JSON 与缺失的键同样落到保守值。
  }
  return "none";
}

/**
 * `JobRow` → `JobViewDto` 的唯一投影点。
 *
 * 逐字段显式列出，不展开行对象：`snapshot_json` 与 `idempotency_key` 因此**物理进不了**
 * 响应（幂等键里含 revision id 与模型/策略标识，运维明细不上线）。
 * `cancel_requested` 是 0/1 列，对外是布尔。
 */
function toJobViewDto(row: JobRow): JobViewDto {
  return {
    id: row.id,
    recordId: row.record_id,
    recordRevisionId: row.record_revision_id,
    status: row.status,
    attempts: row.attempts,
    errorKind: row.error_kind,
    cancelRequested: row.cancel_requested === 1,
    sendContentMode: sendContentModeOf(row.snapshot_json),
    createdAtUtc: row.created_at_utc,
    updatedAtUtc: row.updated_at_utc,
    startedAtUtc: row.started_at_utc,
    finishedAtUtc: row.finished_at_utc,
  };
}

/**
 * 解析能力未就绪（M6-1D 的手动入队侧）。
 *
 * 消息与 `ingestRoutes.ts` 里那个 `IngestUnavailableError` 逐字同意，类却不是复用的那一个：
 * 那个类住在 `ingestRoutes.ts`，而 `ingestRoutes` 已经 import 了本文件的 `jobStoreFor`
 * （断言 6：同步入口成功后要作废同 revision 的排队任务）——反向 import 会构成模块环。
 * 一处判据、两份同义的错误类，是因为路由层之间的这条依赖方向是单向的；对外面（503 +
 * `ingest_unavailable`）由本文件的 `fail` 与那边各自映射到同一个码，客户端分辨不出差别。
 */
class JobProviderUnavailableError extends Error {
  constructor() {
    super("解析能力未就绪：Provider 面未装配（模型未启用或本地 transport 未配置）。");
    this.name = "JobProviderUnavailableError";
  }
}

/**
 * 错误响应只带错误码与策展消息，绝不回显原文（工程要求 5，与 records/ingest 两个面同纪律）。
 *
 * 分类口径与 op2 逐格对齐（M6-1D：两个入口做的是同一件事，客户端不该看到两套码）：
 * 验证 400 / 找不到 404 / 状态冲突与档位不可用 409 / 解析未就绪 503 / 其余 500。
 * 三类 404 分开写：`RecordNotFoundError`（记录已删）、`JobNotFoundError`（任务不存在）、
 * `JobRevisionNotFoundError`（入队时挂接的版本已不在）——对外同一个 `not_found`，对内是三个来源。
 */
export async function handleJobsRequest(
  facts: ServerFacts,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  const path = url.pathname;
  const method = req.method ?? "GET";
  if (path !== JOBS_PREFIX && !path.startsWith(`${JOBS_PREFIX}/`)) return false;

  const send = (status: number, body: unknown): void => replyJson(res, status, body);
  const fail = (cause: unknown): void => {
    if (cause instanceof z.ZodError) {
      send(400, { error: "invalid_request", detail: "请求体或查询参数不符合契约" });
    } else if (cause instanceof SyntaxError) {
      send(400, { error: "invalid_json" });
    } else if (cause instanceof BodyTooLargeError) {
      send(413, { error: "body_too_large" });
    } else if (
      cause instanceof JobInputError ||
      cause instanceof ThreeAxisValueError ||
      cause instanceof ThreeAxisCombinationError
    ) {
      // 三轴取值/组合非法与幂等键空段都是「请求本身不合法」，与 op2 同一格落 400。
      send(400, { error: "invalid_request", detail: cause.message });
    } else if (
      cause instanceof RecordNotFoundError ||
      cause instanceof JobNotFoundError ||
      cause instanceof JobRevisionNotFoundError ||
      cause instanceof RevisionNotFoundError
    ) {
      send(404, { error: "not_found", detail: cause.message });
    } else if (cause instanceof RedactionModeUnavailableError) {
      // M9-4b 的对外面：与 op2/op6/op7 同一个码、同一个 `reason`，不混进 `state_conflict`。
      send(409, { error: "redaction_mode_unavailable", reason: cause.reason, detail: cause.message });
    } else if (cause instanceof LocalLlmTierCacheMissingError) {
      // M9-4d-pre §5：入队时本档的采信区间缓存读不回（缺键 / 结构不成立）⇒ 409，不落通用 500。
      // 与 op2 同一个码：两个入口做的是同一件事，客户端不该看到两套码。
      send(409, { error: "redaction_tier_cache_missing", reason: cause.reason, detail: cause.message });
    } else if (cause instanceof LocalLlmNotPreviewedError) {
      // 入队这一条路径其实问不到它（入队走 `resolveEgressPreview`，没预览过就先咨询一次），
      // 映射在册只为**错误面对齐**：同一份四腿事实的两个入口不许有一个漏码落进 500。
      send(409, { error: "local_llm_not_previewed", detail: cause.message });
    } else if (
      cause instanceof ProcessingModeError ||
      cause instanceof CloudSendAuthorizationRequiredError
    ) {
      send(409, { error: "state_conflict", detail: cause.message });
    } else if (cause instanceof JobProviderUnavailableError) {
      send(503, { error: "ingest_unavailable", detail: cause.message });
    } else {
      send(500, { error: "internal_error" });
    }
  };

  const jobs = jobStoreFor(facts);

  try {
    if (path === JOBS_PREFIX && method === "GET") {
      const q = listQuery.parse({ recordId: url.searchParams.get("recordId") ?? undefined });
      // 记录不存在 ⇒ 404 而不是 `{ jobs: [] }`：空列表会被轮询方读成「还没有任务」，
      // 而它真正的意思是「这条记录已经没了」，前端应当停止轮询而不是继续等。
      // 存在性只经服务层判定；`listForRecord` 的 `record_id` 过滤才是这一行的数据来源。
      facts.workspace.records.getRecord(q.recordId);
      const body: JobListDto = { jobs: jobs.listForRecord(q.recordId).map(toJobViewDto) };
      send(200, body);
      return true;
    }

    const cancelMatch = /^\/api\/jobs\/([^/]+)\/cancel$/.exec(path);
    if (cancelMatch) {
      if (method === "POST") {
        // `requestCancel` 自带三分支幂等（§五）：queued 直接终态、在途只置请求位、
        // 终态原样返回。所以这里不需要在路由层判状态，重复取消同一条也是 200 同一行。
        send(200, toJobViewDto(jobs.requestCancel(cancelMatch[1]!)));
        return true;
      }
    }

    if (path === JOBS_PREFIX && method === "POST") {
      // M6-1D：手动入队。只有用户按下这一次，没有任何「保存后自动排队」（本轮裁决）。
      const body = enqueueBody.parse(await readJsonBody(req));
      const { row, created } = await enqueueForRecord(facts, jobs, body.recordId);
      // 201 = 新建了这一行；200 = 幂等命中已有的那一行。两种都回同一形状，让调用方读到现状。
      send(created ? 201 : 200, toJobViewDto(row));
      return true;
    }

    send(405, { error: "method_not_allowed", method, path });
    return true;
  } catch (cause) {
    fail(cause);
    return true;
  }
}
