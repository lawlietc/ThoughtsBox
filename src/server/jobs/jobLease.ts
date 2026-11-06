import { randomUUID } from "node:crypto";

import type { Database } from "../db/adapter.ts";
import { deleteMeta, getMeta, setMeta } from "../db/migrator.ts";

/**
 * 任务租约的**归属记录**（M6-1D 裁决 ①-b）。
 *
 * 要解决的问题：草案 §四 的租约权威是 `privacy_job.updated_at_utc`，而它只是「上一次状态变更的时刻」
 * ——一个时钟超前的第二实例会把它算成「已过期」，于是 `reclaimExpiredLeases()` 抢走另一个进程
 * 正在跑的那一行，两个实例同时整理同一条记录，并且其中一个完全不知道自己被抢了。
 * 「回收过期租约」要成立，前提是先能回答**这一行的租约现在归谁**。
 *
 * 为什么落在 `app_meta` 而不是别处：
 *  - `privacy_job` 不能加列（0010 冻结，本轮禁区）。
 *  - `updated_at_utc` 承载不了归属——它是时刻，不是持有者。
 *  - `app_meta` 与任务行**同库同文件**，所以它天然共享「R-5 换句柄」的不变量：换库即换租约集，
 *    不会出现「租约说这一行还活着、库已经不认这个任务」的劈叉。`GrantService` 的预览缓存走的是
 *    同一块地方（`preview_nonce:<rev>` / `preview_payload:<rev>`），一致性口径因此有既有先例。
 *  - 值是一行 JSON，每个任务一个键：`job_lease:<jobId>`。
 *
 * 单进程部署（本项目的现实）下这份记录不改变任何既有语义：持有者永远是自己，
 * `heldByOther()` 恒假，回收与取消的行为与接线前逐字相同。它只为「两个进程共用一个数据目录」
 * 这一种情形提供判据——而那一情形下它替代的是一条已知会出错的判据。
 */

/** 键前缀：一个任务一个键，收尾即删（残键只会让下一次回收多读一行，见 `holderOf` 的过期判定）。 */
export const JOB_LEASE_KEY_PREFIX = "job_lease";

export function leaseKeyOf(jobId: string): string {
  return `${JOB_LEASE_KEY_PREFIX}:${jobId}`;
}

/** 一行租约记录的内容：持有者 + 到点时刻。没有第三项——它不是状态机，只是一张「谁在用」的条子。 */
export interface JobLeaseHolder {
  readonly jobId: string;
  readonly instanceId: string;
  readonly expiresAtUtc: string;
}

export interface JobLeaseOptions {
  /** 进程身份。默认取本进程一次性生成的 UUID——**不要求跨重启稳定**：崩溃的进程没有活的租约。 */
  readonly instanceId?: string;
  /** 注入只为测试可控（与 `JobStore`、`GrantService` 同形）；默认 `() => new Date()`。 */
  readonly now?: () => Date;
}

/** 同一进程内共享一个身份：两个 `JobLease` 实例不该把彼此当成另一台机器。 */
let processInstanceId: string | undefined;

export function currentProcessInstanceId(): string {
  processInstanceId ??= randomUUID();
  return processInstanceId;
}

export class JobLease {
  private readonly db: Database;
  readonly instanceId: string;
  private readonly now: () => Date;

  constructor(db: Database, options: JobLeaseOptions = {}) {
    this.db = db;
    this.instanceId = options.instanceId ?? currentProcessInstanceId();
    this.now = options.now ?? (() => new Date());
  }

  /**
   * 占住这一行的租约并写明到点时刻。由**持有者**调用（M6-1D 里是 `JobWorker` 取到任务之后），
   * 存储层不自动写——「谁在执行任务」只有调度循环知道。
   */
  acquire(jobId: string, timeoutMs: number): JobLeaseHolder {
    const holder: JobLeaseHolder = {
      jobId,
      instanceId: this.instanceId,
      expiresAtUtc: new Date(this.now().getTime() + timeoutMs).toISOString(),
    };
    setMeta(this.db, leaseKeyOf(jobId), JSON.stringify(holder));
    return holder;
  }

  /** 释放（收尾那一步）。删除而不是改写过期时刻：残键会让「有没有人占着」这一问题多一个说谎的答案。 */
  release(jobId: string): void {
    deleteMeta(this.db, leaseKeyOf(jobId));
  }

  /**
   * 这一行现在的持有者；**没有键或键已过点都返回 null**。
   * 过点的键不再算持有者，所以崩溃进程留下的残条不会永久挡住回收（草案 §四 的语义保持）。
   */
  holderOf(jobId: string): JobLeaseHolder | null {
    const raw = getMeta(this.db, leaseKeyOf(jobId));
    if (raw === undefined) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
    if (typeof parsed !== "object" || parsed === null) return null;
    const fields = parsed as Record<string, unknown>;
    const jobIdValue = fields.jobId;
    const instanceValue = fields.instanceId;
    const expiresValue = fields.expiresAtUtc;
    if (
      typeof jobIdValue !== "string" ||
      typeof instanceValue !== "string" ||
      typeof expiresValue !== "string"
    ) {
      return null;
    }
    if (new Date(expiresValue).getTime() <= this.now().getTime()) return null;
    return { jobId: jobIdValue, instanceId: instanceValue, expiresAtUtc: expiresValue };
  }

  /** 有一个**尚未过点**的持有者且不是我。这就是 §四 回收与取消那两处唯一需要的新判据。 */
  heldByOther(jobId: string): boolean {
    const holder = this.holderOf(jobId);
    return holder !== null && holder.instanceId !== this.instanceId;
  }

  /** 有未过点的持有者（不论是谁）——取消入口问的是「这一行正被使用吗」。 */
  isLive(jobId: string): boolean {
    return this.holderOf(jobId) !== null;
  }
}
