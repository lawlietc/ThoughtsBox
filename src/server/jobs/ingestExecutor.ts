import {
  assertThreeAxes,
  coerceAxes,
  deriveProcessingMode,
  isEgress,
  type ThreeAxes,
} from "../../shared/contracts/enums.ts";
import { IngestInputError, type IngestResult } from "../ingest/ingestService.ts";
import type { LocalLlmStatus } from "../config/config.ts";

import type { ModelAdapter, ParseErrorKind, ProcessingMode } from "../ingest/provider.ts";
import { assertRedactionPlanRunnable, LOCAL_LLM_STATUS_UNSET } from "../ingest/provider.ts";
import { resolveEgressPreview } from "../privacy/localLlmPreview.ts";
import { hasApplicableGrantForAxes } from "../privacy/egressPreview.ts";
import { RecordNotFoundError } from "../records/service.ts";
import type { Workspace } from "../runtime/workspace.ts";
import { JOB_SNAPSHOT_FIELDS, type JobErrorKind, type JobRow } from "./jobStore.ts";
import type { JobExecutionContext, JobExecutionResult, JobExecutor } from "./jobWorker.ts";

/**
 * 后台队列的真实执行体（M6-1D 第一批）。
 *
 * 契约正文：`docs/dev-specs/2026-10-23-M6-0E-后台任务队列设计草案.md` §五 结局分类、§六 与同步入口的关系。
 * 它是 `jobWorker.ts` 里那句「执行体由 `executor` 注入，`JobExecutionResult` 是它与循环之间唯一的契约」
 * 的第一份真实实现。
 *
 * 与同步入口 `runParse` 的关系（§六「同一件事的两个入口，不是两套逻辑」）：
 *  - **载荷与授权同源**：外发轨的待发送文本继续由装配层那**一个**入口（`resolveEgressPreview`）本次
 *    现算，授权闸门继续是 `requireApplicableGrant` 的四腿匹配。这条轨道上「用户预览到的」与「发出去的」
 *    必须是同一份文本，两条入口各算一遍就等于允许它们分岔——所以那两道门被抽到 `privacy/` 共用。
 *    M9-4d-pre 起这里也是「发送前再问一次模型」那一步的唯一归属（裁决 M9-D-13）。
 *  - **档位判定源同为一套**：读任务快照里的三轴（不是 `processing_mode`，草案 §五），
 *    派生出 mode 只为了取适配器。
 *  - **不共享的部分只有一个形状**：同步入口把结果投影成 DTO 交给 HTTP，这里把结果收敛成
 *    `JobExecutionResult` 交给循环。真正的执行仍是同一个 `IngestService`。
 *
 * 本模块**明确不做**：
 *  - **不写 `privacy_job`**：收尾全在 `jobWorker`，这里连一次 `transition` 都不调用。
 *  - **不自创取消检查点**：`ctx.signal` 原样接进 `IngestService`（它一路传到 `ExtractionRequest.signal`
 *    → `provider.ts` 的 `guardedSend` → `httpTransport` 的 `fetch`），所以**发出前与在途都中止得掉**；
 *    但谁来 abort 它是调度循环的事（M6-1D：单次尝试到点 ⇒ worker abort 这个 controller），
 *    用户点「取消」走的是库里的 `cancel_requested` 位（§五 的权威），本执行体只在调模型前查那一位。
 *  - **不入队、不判 HTTP 状态码**：入队闸门是路由的事。
 */

/** 快照之外的键名不是真相：读不出三轴的行就是不可执行的行，报错带上任务 id 便于定位。 */
class JobSnapshotError extends Error {
  constructor(jobId: string, detail: string) {
    super(`后台任务 ${jobId} 的配置快照不可用：${detail}`);
    this.name = "JobSnapshotError";
  }
}

export interface LocalLlmReadings {
  readonly status: LocalLlmStatus;
  /** 与 `status` 出自同一次配置读数的本地模型适配器；`null` = 这一档没 profile。 */
  readonly adapter: ModelAdapter | null;
}

/**
 * 读出快照里的三轴。
 * 键集是存储层那份封闭清单（`JOB_SNAPSHOT_FIELDS`），这里不重抄键名；缺键即失败，
 * 不兜底成保守组合——兜底等于替这条任务改写它当初承诺的隐私档位。
 */
function axesOfJob(job: JobRow): ThreeAxes {
  let parsed: unknown;
  try {
    parsed = JSON.parse(job.snapshot_json);
  } catch {
    throw new JobSnapshotError(job.id, "snapshot_json 不是合法 JSON");
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new JobSnapshotError(job.id, "snapshot_json 不是对象");
  }
  const fields = parsed as Record<string, unknown>;
  for (const field of JOB_SNAPSHOT_FIELDS) {
    const value = fields[field];
    if (typeof value !== "string" || value.trim() === "") {
      throw new JobSnapshotError(job.id, `缺少 ${field}`);
    }
  }
  const axes = coerceAxes(
    fields.analysis_provider as string,
    fields.redaction_mode as string,
    fields.send_content_mode as string,
  );
  assertThreeAxes(axes);
  return axes;
}

/**
 * 认领侧的「这一行现在能不能开工」判据（整理方式改动 S-4，`jobWorker` 的 `runnable` 生产实现）。
 *
 * 为什么闸门从入队侧挪到这里：「保存并整理」必须允许一条从没预览过的外发记录进队（否则那一拍
 * 就是 409，用户看到的是「没保存成」）。但挪走的只是**时机**，不是那道门——发送前仍然逐字核
 * 四腿（`makeIngestExecutor` 里那句 `requireApplicableGrant` 一行没动），这里只是把它提前问一次：
 * 外发轨没有本次授权 ⇒ 这一行留在 `queued` 等用户确认，一个字节都不发。
 *
 * 判据必须**只读**（与待整理投影 `reviewQueueEntry` 共用 `hasApplicableGrantForAxes`）：
 * 这里绝不碰 `resolveEgressPreview`——那会现算一次脱敏、在 `local_llm` 档咨询本机模型，
 * 把「取任务」变成「跑一次」，还会写回载荷/nonce 两枚缓存键。
 *
 * 三种「问不出结果」一律放行（返回 `true`），交回执行体按既有语义落 `retryable/internal`：
 * 快照读不出档位、revision 已不在（`raw` 腿要现读原文）、以及任何库里冒出来的意外。
 * 判据没把握时假装「还不能开工」会让那一行永远排队；让它被认领、由执行体判失败，才是既有队列的形状。
 */
export function makeEgressGrantRunnable(workspace: Workspace): (job: JobRow) => boolean {
  return (job) => {
    try {
      const axes = axesOfJob(job);
      if (!isEgress(axes)) return true;
      return hasApplicableGrantForAxes(workspace.grants, job.record_revision_id, axes);
    } catch {
      return true;
    }
  };
}

/**
 * `ParseErrorKind`（解析面的七值）→ `JobErrorKind`（队列面的五值）的收敛表。
 *
 * 两张表不是一回事：解析面按「失败的成因」分类，队列面按「该不该再试、算不算一次尝试」分类，
 * 所以这里必然出现多对一。`cancelled` 在查表之前就被单独分流（取消不是失败）；
 * `null` 是「解析契约里没有 kind 的失败」（缺授权就落在这一格）——队列没有「无分类」这一列，
 * 落成 `internal` 让它至少留下一条可查的线索。
 */
const JOB_ERROR_KIND_BY_PARSE_ERROR_KIND: Record<ParseErrorKind, JobErrorKind> = {
  network: "timeout",
  timeout: "timeout",
  invalid_json: "invalid_output",
  provider_schema: "invalid_output",
  business_validation: "invalid_output",
  evidence_unmapped: "invalid_output",
  cancelled: "internal",
};

function jobErrorKindOf(errorKind: ParseErrorKind | null): JobErrorKind {
  if (errorKind === null) return "internal";
  return JOB_ERROR_KIND_BY_PARSE_ERROR_KIND[errorKind];
}

/**
 * 执行体：拿一次已经占住（`redacting`）的任务行，把它做完或如实说做不完。
 *
 * 五种结局在这里各有一条路径，逐条对应草案 §五：
 *  - `canceled`：用户在排期之后按下的取消，权威是库里那一位。
 *  - `provider_unavailable`：**这一拍什么都没做**，所以不消耗 attempts（断言 5）。
 *    两格取值分开：Provider 面整个没装配 ⇒ `provider_loading`；装配了但没有这一档的适配器
 *    ⇒ `provider_unavailable`。前者是启动时序，后者是用户所选那一档本机确实服务不了。
 *  - `already_done`：同 revision + 同管线的结果已经在库里（同步入口先做完了，§六）。
 *  - `done`：本次真的产出了结果。
 *  - `retryable`：其余一切失败。非瞬时故障（档位不可用、过期快照、缺授权）也先落在这里——
 *    队列没有「永久失败」这一格，第二次失败由 worker 收尾成 `failed`，不为此新增 kind。
 *
 * `readLocalLlm`（M9-4c / 任务 §0b + M9-4d-pre）是**取值函数**而不是启动期的快照：
 * `redaction_mode=local_llm` 那一档能不能跑、该拿哪个适配器去问，每次认领任务时现算一次。
 * 配置对象与 `boot` 手里那份是同一个（`bootstrap.ts`），设置页保存时就地改它，路由侧本来就是
 * 每次请求现读——传函数才与路由同源；传快照会让「入队时判可用、执行时仍判不可用」这种错位
 * 长期存在。缺席即按「未配置」处理：这一档的任务行做不成，而不是被静默放行。
 * 返回的是**一对**读数（状态 + 适配器），两者出自同一次 `localLlmStatus()`：分成两个 reader
 * 就可能读到配置改到一半的两次结果，档位门与咨询用的就不是同一份 profile 了。
 */
export function makeIngestExecutor(
  workspace: Workspace,
  readLocalLlm: () => LocalLlmReadings = () => ({ status: LOCAL_LLM_STATUS_UNSET, adapter: null }),
): JobExecutor {
  return async (job: JobRow, ctx: JobExecutionContext): Promise<JobExecutionResult> => {
    // §五 的取消权威是库里的位：调模型前查一次，这是本执行体唯一的检查点。
    if (ctx.isCancelRequested()) return { kind: "canceled" };

    let axes: ThreeAxes;
    try {
      axes = axesOfJob(job);
    } catch {
      // 快照坏到读不出档位：这一行永远做不成，让它走完两次尝试落 `failed`，而不是无限重排。
      return { kind: "retryable", errorKind: "internal" };
    }
    const mode: ProcessingMode = deriveProcessingMode(axes);

    if (axes.analysisProvider === "none") {
      // 派生 manual_only：这一档承诺不经模型，压根没有「执行」可做。入队闸门不该放行它，
      // 走到这里说明行是别处写下的——按做不成收尾，不去调任何适配器。
      return { kind: "retryable", errorKind: "internal" };
    }
    // 认领到这一行才现读档位状态（任务 §0b）：与路由侧「每次请求现读」同一条时点。
    const { status: localLlm, adapter: localLlmAdapter } = readLocalLlm();
    try {
      assertRedactionPlanRunnable(axes, job.record_revision_id, localLlm);
    } catch {
      // 档位不可用（local_llm 没配置好）：同理，这一拍没有可跑的东西。
      // `reason` 到此为止不外传：队列的 `error_kind` 是迁移 CHECK 里的封闭七值，
      // 为它新增取值属于改 migrations（禁区），本批按既有 `internal` 收尾。
      return { kind: "retryable", errorKind: "internal" };
    }

    if (workspace.ingestProvider === null) {
      return { kind: "provider_unavailable", errorKind: "provider_loading" };
    }
    if (!workspace.ingestReadyFor(mode)) {
      return { kind: "provider_unavailable", errorKind: "provider_unavailable" };
    }

    let currentRevisionId: string;
    try {
      currentRevisionId = workspace.records.getRecord(job.record_id).record.current_revision_id;
    } catch (cause) {
      if (cause instanceof RecordNotFoundError) return { kind: "retryable", errorKind: "internal" };
      throw cause;
    }
    if (currentRevisionId !== job.record_revision_id) {
      // 原文被改写过：这条任务当初针对的是上一个版本，而解析只针对记录的当前版本（§3.19 第 1 步）。
      // 不在旧版本上「替用户重做一遍」，也不自作主张挪到新版本——那是一次新的意图，得重新入队。
      return { kind: "retryable", errorKind: "internal" };
    }

    let result: IngestResult;
    try {
      // 外发（redacted 与 raw 同一道门）：载荷本次现算，授权闸门绑这份具体的
      // (revision, payload, policy, track) 四腿（0D 草案 §四），逐字照同步入口那一套核对。
      // M9-4d-pre / M9-D-13：这里也从装配层那**一个**入口取载荷——`local_llm` + `redacted` 且没有
      // 缓存区间时，发送前再问一次模型。问成 ⇒ 载荷与用户确认过的那份不同 ⇒ 下面四腿闸门抛 409
      // （由 worker 收落成失败，不「自动重新确认」）；仍问不成 ⇒ 落规则档那份，正是用户签过的那一份。
      const preview = isEgress(axes)
        ? await resolveEgressPreview(workspace.grants, localLlmAdapter, job.record_revision_id, axes)
        : null;
      // 不外发的在途分析（local_model）：载荷省略即原文，脱敏映射与授权都不适用。
      const service = workspace.makeIngestService(
        mode,
        preview === null
          ? undefined
          : () =>
              workspace.grants.requireApplicableGrant(
                preview.recordRevisionId,
                preview.payloadSha256,
                preview.policyVersion,
                preview.sendContentMode,
              ),
        localLlm,
      );
      if (service === null) return { kind: "provider_unavailable", errorKind: "provider_unavailable" };
      result = await service.ingest(
        preview === null
          ? { recordRevisionId: job.record_revision_id, axes, signal: ctx.signal, autoAdoptFirstResult: true }
          : {
              recordRevisionId: job.record_revision_id,
              axes,
              payloadText: preview.payloadText,
              signal: ctx.signal,
              autoAdoptFirstResult: true,
              // 映射只在 `redacted` 这一支有定义：raw 的载荷就是原文，没有映射可带（草案 §三 矩阵 #9）。
              ...(axes.sendContentMode === "redacted" ? { redactionMap: preview.map } : {}),
            },
      );
    } catch (cause) {
      if (cause instanceof IngestInputError) {
        // 快照与在册三轴不一致、修订不存在：都是「这条任务的意图已经过期」，不是重试能救的。
        // 按 §五 落 retryable + internal，第二次失败由 worker 收尾成 failed。
        return { kind: "retryable", errorKind: "internal" };
      }
      throw cause;
    }

    if (!result.succeeded) {
      if (result.errorKind === "cancelled") return { kind: "canceled" };
      return { kind: "retryable", errorKind: jobErrorKindOf(result.errorKind) };
    }
    return { kind: result.replayed ? "already_done" : "done" };
  };
}
