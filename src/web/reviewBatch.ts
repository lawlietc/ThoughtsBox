import { ApiError } from "./apiClient.ts";

/**
 * M10-3 批量确认的纯逻辑：把「勾了几条 ⇒ 一次签几张四腿授权」这件事收在一个不碰 DOM、
 * 不碰 HTTP 的模块里。界面只负责画勾选与进度，服务端一个字节都不动（M10-D-4：
 * 不新增批量端点，一次还是一条一张条子）。
 */

/**
 * 队列那一片的轮询间隔（M10-4，裁决 M10-D-13）。
 *
 * 放在纯模块里是为了一句都能被断言：只有 `prewarm.pending > 0` 时才按这个间隔重取，归零即停。
 * 无条件常轮询会在「什么都没在跑」的时候持续敲服务端，而那一屏本来就不会变。
 */
export const REVIEW_QUEUE_POLL_MS = 5_000;

/**
 * 批量确认里一条失败的原因（封闭集，只由 HTTP 状态/错误码派生，不含自由文本）。
 */
export type BatchConfirmFailureReason = "payload_changed" | "network" | "other";

export interface BatchConfirmFailure {
  readonly recordId: string;
  readonly reason: BatchConfirmFailureReason;
}

export interface BatchConfirmOutcome {
  /** 按输入顺序。 */
  readonly confirmed: readonly string[];
  /** 按输入顺序。 */
  readonly failed: readonly BatchConfirmFailure[];
}

export interface BatchConfirmDeps {
  /** 一条一条确认；抛错就是那一条失败。 */
  readonly confirm: (recordId: string) => Promise<void>;
  /** 串行进度（第 `index` 条开始确认前回调，1 起）。 */
  readonly onProgress?: (recordId: string, index: number, total: number) => void;
}

/**
 * 失败原因的成句文案。三句话来自这个封闭集，**不**来自服务端的 `detail`：那一头是策展过的
 * 自由文本，把它原样端上来就等于在这一屏贴了一段没人复核过的内容，也不保证不含词面。
 */
export const BATCH_CONFIRM_FAILURE_TEXT: Readonly<Record<BatchConfirmFailureReason, string>> = {
  payload_changed: "这版内容变过，需要重新预览",
  network: "连不上本机后端",
  other: "这一条没签出去",
};

/**
 * 409 说的是「这份载荷不再是用户看过的那一份」（要重预览）；`ApiError.status === 0` 是
 * apiClient 里唯一「压根没连上后端」的取值。其余一律 `other`——包括根本不是 `ApiError` 的抛错。
 */
function failureReasonOf(cause: unknown): BatchConfirmFailureReason {
  if (cause instanceof ApiError) {
    if (cause.status === 409) return "payload_changed";
    if (cause.status === 0) return "network";
  }
  return "other";
}

/**
 * 串行确认这一批：一条一张授权，各签各的，**不连坐**（一条失败照常跑下一条），**从不抛**。
 *
 * 为什么串行而不是 `Promise.all`：每条都要在服务端走一遍四腿核对，并发时「第几条失败了」
 * 就说不清，进度那一句也无从落笔。顺序按输入顺序，去重后每个 id 只签一次——同一个 id 签两张
 * 是同一次点头的重复，没有第二重含义。
 */
export async function confirmReviewEntries(
  recordIds: readonly string[],
  deps: BatchConfirmDeps,
): Promise<BatchConfirmOutcome> {
  const targets: string[] = [];
  const seen = new Set<string>();
  for (const recordId of recordIds) {
    if (seen.has(recordId)) continue;
    seen.add(recordId);
    targets.push(recordId);
  }

  const confirmed: string[] = [];
  const failed: BatchConfirmFailure[] = [];
  for (const [offset, recordId] of targets.entries()) {
    const index = offset + 1;
    deps.onProgress?.(recordId, index, targets.length);
    try {
      await deps.confirm(recordId);
      confirmed.push(recordId);
    } catch (cause) {
      failed.push({ recordId, reason: failureReasonOf(cause) });
    }
  }
  return { confirmed, failed };
}
