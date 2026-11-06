import { ApiError } from "./apiClient.ts";

/**
 * 批量发起整理的纯逻辑（D-3）：把「勾了几条 ⇒ 要不要先确认、要不要跳过未确认、按什么顺序跑」
 * 收在一个不碰 DOM、不碰 HTTP 的模块里。界面只负责画勾选、弹三选一、显示进度与结果。
 *
 * 与 `reviewBatch.ts` 同一条纪律：服务端一个字节都不动，没有批量端点，一次还是一条一次整理。
 */

export interface BatchOrganizeTarget {
  readonly recordId: string;
  /** 缺授权（外发会离开本机）：`hasGrant === false`。 */
  readonly needsConfirm: boolean;
}

export interface BatchOrganizeSummary {
  readonly total: number;
  /** 需要先确认的条数；`> 0` 时先弹三选一。 */
  readonly needsConfirm: number;
  /** 可直接整理的条数（已授权或本机整理）。 */
  readonly ready: number;
}

export type BatchOrganizeMode = "confirm-and-organize" | "organize-confirmed-only";

export type BatchOrganizeFailureReason = "confirm_failed" | "organize_failed" | "network";

export interface BatchOrganizeFailure {
  readonly recordId: string;
  readonly reason: BatchOrganizeFailureReason;
}

export interface BatchOrganizeOutcome {
  /** 按输入顺序，真正整理且成功的。 */
  readonly organized: readonly string[];
  /** 「只整理已确认」模式下跳过的未确认项。 */
  readonly skipped: readonly string[];
  readonly failed: readonly BatchOrganizeFailure[];
}

export interface BatchOrganizeDeps {
  /** 签一张发送授权；抛错 = 这一条确认失败。 */
  readonly confirm: (recordId: string) => Promise<unknown>;
  /** 整理一条；返回 `succeeded` 决定算成功还是失败。抛错 = 这一条整理失败。 */
  readonly organize: (recordId: string) => Promise<{ readonly succeeded: boolean }>;
  /** 串行进度（第 `index` 条开始前回调，1 起）。 */
  readonly onProgress?: (recordId: string, index: number, total: number) => void;
}

export const BATCH_ORGANIZE_FAILURE_TEXT: Readonly<Record<BatchOrganizeFailureReason, string>> =
  Object.freeze({
    confirm_failed: "没签出发送授权",
    organize_failed: "这条没整理成",
    network: "连不上本机后端",
  });

function dedupe(targets: readonly BatchOrganizeTarget[]): BatchOrganizeTarget[] {
  const seen = new Set<string>();
  const unique: BatchOrganizeTarget[] = [];
  for (const target of targets) {
    if (seen.has(target.recordId)) continue;
    seen.add(target.recordId);
    unique.push(target);
  }
  return unique;
}

/** 勾选里有多少条需要先确认、多少条可直接整理。 */
export function summarizeBatchOrganize(
  targets: readonly BatchOrganizeTarget[],
): BatchOrganizeSummary {
  const unique = dedupe(targets);
  const needsConfirm = unique.filter((target) => target.needsConfirm).length;
  return { total: unique.length, needsConfirm, ready: unique.length - needsConfirm };
}

function reasonOf(cause: unknown, stage: "confirm" | "organize"): BatchOrganizeFailureReason {
  if (cause instanceof ApiError && cause.status === 0) return "network";
  return stage === "confirm" ? "confirm_failed" : "organize_failed";
}

/**
 * 串行整理这一批：各跑各的，**不连坐**（一条失败照常跑下一条），**从不抛**。
 *
 * `organize-confirmed-only`：跳过 `needsConfirm` 的项（记进 `skipped`），只整理已确认的；
 * `confirm-and-organize`：未确认的先 `confirm` 再 `organize`，已确认的直接整理。
 */
export async function runBatchOrganize(
  targets: readonly BatchOrganizeTarget[],
  mode: BatchOrganizeMode,
  deps: BatchOrganizeDeps,
): Promise<BatchOrganizeOutcome> {
  const unique = dedupe(targets);
  const organized: string[] = [];
  const skipped: string[] = [];
  const failed: BatchOrganizeFailure[] = [];
  const attemptable = unique.filter(
    (target) => !(mode === "organize-confirmed-only" && target.needsConfirm),
  );

  for (const [offset, target] of attemptable.entries()) {
    deps.onProgress?.(target.recordId, offset + 1, attemptable.length);
    let stage: "confirm" | "organize" = "organize";
    try {
      if (mode === "confirm-and-organize" && target.needsConfirm) {
        stage = "confirm";
        await deps.confirm(target.recordId);
      }
      stage = "organize";
      const result = await deps.organize(target.recordId);
      if (result.succeeded) organized.push(target.recordId);
      else failed.push({ recordId: target.recordId, reason: "organize_failed" });
    } catch (cause) {
      failed.push({ recordId: target.recordId, reason: reasonOf(cause, stage) });
    }
  }

  if (mode === "organize-confirmed-only") {
    for (const target of unique) {
      if (target.needsConfirm) skipped.push(target.recordId);
    }
  }

  return { organized, skipped, failed };
}
