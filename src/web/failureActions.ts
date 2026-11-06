import { ApiError } from "./apiClient.ts";
import type { IngestResultDto } from "../shared/dto.ts";

/**
 * 失败面统一成一个下一步（S7）。
 *
 * 旧界面把 409/503、错误码、阶段名与「去设置/重试/排后台」散在各处，用户看到的是一串
 * 技术词拼成的原因。这里把每一次失败收敛成三件事之一：
 *   · 重试——同样的动作再跑一次（网络抖动、本机模型没起来、载荷要重新检查）；
 *   · 去改设置——问题不在这一条记录，而在模型 / 脱敏档的装配；
 *   · 只保存，稍后再说——这次不整理、不外发，原文已经在本机，之后还能再来。
 *
 * 主文案只说人话；服务端 `detail` 与错误码原样放进 `technical`，由界面折叠展示，不丢。
 * 纯 `.ts`：不依赖 React / DOM，映射表能在 node 测试里逐码断言。
 */

export type FailureAction = "retry" | "settings" | "save-only";

export const FAILURE_ACTION_LABEL: Readonly<Record<FailureAction, string>> = Object.freeze({
  retry: "重试",
  settings: "去改设置",
  "save-only": "只保存，稍后再说",
});

export interface FailurePlan {
  /** 主文案：一句话说清发生了什么、有没有伤到原文。 */
  readonly headline: string;
  /** 可选的下一步，按「最该先点的」排在前面。 */
  readonly actions: readonly FailureAction[];
  /** 折叠区里的技术详情：服务端策展过的 detail 与错误码，不在这里改写。 */
  readonly technical: string | null;
}

function plan(
  headline: string,
  actions: readonly FailureAction[],
  technical: string | null,
): FailurePlan {
  return { headline, actions, technical };
}

function technicalOf(cause: unknown): string | null {
  if (cause instanceof ApiError) {
    const meta = [`HTTP ${cause.status}`, cause.code];
    if (cause.step !== null) meta.push(cause.step);
    if (cause.detail.trim() !== "" && cause.detail !== cause.code) meta.push(cause.detail);
    return meta.join(" · ");
  }
  if (cause instanceof Error && cause.message.trim() !== "") return cause.message;
  return null;
}

const RETRY_LATER = ["retry", "save-only"] as const;
const SETTINGS_FIRST = ["settings", "retry", "save-only"] as const;

/**
 * 传输层 / API 错误 → 下一步。
 *
 * 码表逐条对照 `ingestRoutes.ts` 的 `fail()`：每个服务端错误码都必须落在一句人话上，
 * 认不出的码按「本地后端出错」处理（重试 + 只保存），绝不把原始错误码当主文案。
 */
export function failurePlanOf(cause: unknown): FailurePlan {
  if (!(cause instanceof ApiError)) {
    return plan("操作没有完成。原文没有被改动。", RETRY_LATER, technicalOf(cause));
  }
  switch (cause.code) {
    case "network_error":
      return plan("连不上本地后端，什么都没改。", RETRY_LATER, technicalOf(cause));
    case "ingest_unavailable":
      return plan("整理现在用不了：模型还没准备好。", SETTINGS_FIRST, technicalOf(cause));
    case "redaction_mode_unavailable":
      return plan("这一档脱敏现在用不了。", ["settings", "save-only"], technicalOf(cause));
    case "redaction_tier_cache_missing":
      return plan("本机检查的结果读不回来了，需要重新检查。", RETRY_LATER, technicalOf(cause));
    case "local_llm_not_previewed":
      return plan("还没看过这次要发的内容，先重新检查一遍。", RETRY_LATER, technicalOf(cause));
    case "local_llm_consult_failed":
      return plan(
        "本机模型没跑成，名字和地名没有检查。",
        ["retry", "settings", "save-only"],
        technicalOf(cause),
      );
    case "state_conflict":
      return plan("这一步现在不能做：这条记录的状态变了，或这次确认已经失效。", RETRY_LATER, technicalOf(cause));
    case "not_found":
      return plan("这条记录找不到了。", ["save-only"], technicalOf(cause));
    case "invalid_request":
    case "invalid_json":
    case "body_too_large":
    case "invalid_three_axis_combination":
      return plan("这次请求没有通过检查，原文没有被改动。", ["save-only"], technicalOf(cause));
    default:
      return plan("本地后端出错了，原文没有被改动。", RETRY_LATER, technicalOf(cause));
  }
}

/**
 * `ingestParse` 返回 `succeeded:false` 时的下一步（不是抛错，是服务端如实报告没整理成）。
 *
 * `errorKind` 的封闭集在服务端 `PARSE_ERROR_KINDS`；这里不复制那份联合类型，
 * 认不出的一律按「整理没有成功」处理。
 */
export function failurePlanOfResult(
  result: Pick<IngestResultDto, "failure" | "errorKind">,
): FailurePlan {
  const errorKind = result.failure?.errorKind ?? result.errorKind;
  const message = result.failure?.message?.trim() ?? "";
  const technical =
    [errorKind, message].filter((part): part is string => part !== null && part !== "").join(" · ") ||
    null;
  switch (errorKind) {
    case "network":
      return plan("本机模型连不上，这次没整理成。", RETRY_LATER, technical);
    case "timeout":
      return plan("本机模型太慢，这次没整理完。", RETRY_LATER, technical);
    case "invalid_json":
    case "provider_schema":
    case "business_validation":
      return plan("模型返回的内容不合规，这次没整理成。", RETRY_LATER, technical);
    case "evidence_unmapped":
      return plan("整理出的内容对不上原文，这次没有写入。", RETRY_LATER, technical);
    case "cancelled":
      return plan("这次整理被取消了。", RETRY_LATER, technical);
    default:
      return plan("整理没有成功。原文完好无损。", RETRY_LATER, technical);
  }
}
