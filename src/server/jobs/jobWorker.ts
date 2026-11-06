import { isStateTransitionAllowed } from "../ingest/ingestService.ts";
import type { Database } from "../db/adapter.ts";
import type { JobLease } from "./jobLease.ts";
import {
  recordProcessingStatusForJobStatus,
  type JobErrorKind,
  type JobRow,
  type JobStatus,
  type JobStore,
  type JobTransitionPatch,
} from "./jobStore.ts";

/**
 * 后台任务队列的**调度循环**（M6-0E 第二批 A）。
 *
 * 契约正文：`docs/dev-specs/2026-10-23-M6-0E-后台任务队列设计草案.md`
 * §三 状态机、§四 恢复与僵尸任务、§五 调度与取消、§六 与同步入口的关系、§八 断言 2/4/5。
 * 下层：`jobStore.ts` —— `privacy_job` 的每一次写入都从那里过，本模块不直接写这张表。
 *
 * 本模块**明确不做**（写进文件头是因为它决定了下面每个方法为什么长这样）：
 *  - **不装配 provider、不判 provider 为什么没就绪**：就绪与否由 `providerReady` 注入，
 *    这里只问一次布尔值（§五「可执行 = queued 且 cancel_requested=0 且 provider 就绪」的最后一段）。
 *  - **不实现真实脱敏/分析**：执行体由 `executor` 注入，`JobExecutionResult` 是它与循环之间唯一的契约。
 *  - **不入队**（入队点是 `JobStore.enqueue`）、**不建 HTTP 面**、**不改 bootstrap / ingestRoutes**、
 *    **不做同步入口的取消联动**（§六 的后半句与断言 6 属第二批 B）。
 *    接线点只有一处：将来由 bootstrap 用真实 executor 构造本类并 `start()`。
 *  - **不自动触发、不加 `enums.json` 键、不给 `privacy_job` 造新列**（尤其没有「下次尝试时间」列，
 *    理由见 `settle` 的 retryable 分支）。
 *
 * 串行（§一-3 的设计前提）：一次 `tickOnce` 至多取一件活，`start()` 的定时器在上一 tick 未结束时
 * 直接跳过这一拍（`current` 那把闸），所以循环里不可能同时跑两个任务。
 */

/**
 * 草案 §五「最多 2 次」——一次尝试加一次重试。测试里断言这个常量等于 2，
 * 并把「第二次失败就落 `failed`」的行为与之对上（断言 5 之外的重试上限）。
 */
export const JOB_MAX_ATTEMPTS = 2;

/** 租约阈值默认值（草案 §九 建议 10 分钟；本地模型很慢时可放宽，构造时可覆盖）。 */
export const DEFAULT_LEASE_MS = 10 * 60_000;
/**
 * 轮询间隔默认值。它同时是**重试的实际退避下限**：本批没有「下次尝试时间」列，
 * 退避靠 `jobRetryBackoffMs`（存储层的纯函数）与这个间隔共同体现——见 `settle` 的 retryable 分支。
 */
export const DEFAULT_POLL_INTERVAL_MS = 2_000;

/** 在途态：只有这两个状态需要 worker 收尾，也是取消检查点与恢复扫描的判据集合。 */
const IN_FLIGHT: ReadonlySet<JobStatus> = new Set<JobStatus>(["redacting", "analyzing"]);

/** 异常面的消息取法：非 Error 的抛出值也要有可读的一行，但不能把对象整个 stringify 进日志。 */
function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * 执行器与调度循环之间的唯一契约（草案 §六 的两种幂等收尾 + §五 的三类结局）。
 *
 * 要害只有一维：`done` / `already_done` 与 `retryable` 的差别**只在「要不要算一次失败尝试」**，
 * 不在「要不要再跑」——三者都表示执行体这一轮做完了事，收尾时只有一个给 attempts 加一。
 *
 * `already_done` 与 `done` 对循环的动作完全一致（都推进到 `done`）：分开两个取值是为了说清
 * 「这一次有没有重复调模型」——同步入口已产出当前结果时任务幂等收尾（§六），而不是又跑一遍。
 * `provider_unavailable` 的 `errorKind` 取值域恰好是 `consumesAttempt()` 判 false 的那两类
 * （`provider_unavailable` / `provider_loading`），测试把这条对账钉住。
 */
export type JobExecutionResult =
  | { readonly kind: "done" }
  | { readonly kind: "already_done" }
  | { readonly kind: "canceled" }
  | { readonly kind: "retryable"; readonly errorKind: JobErrorKind }
  | { readonly kind: "provider_unavailable"; readonly errorKind: "provider_unavailable" | "provider_loading" };

/**
 * 交给执行器的上下文。
 *  - `signal`：给执行器转发给外层调用（如 `fetch`）用；本批循环**不**主动 abort 它——
 *    §五 的「中止」权威是 `cancel_requested` 位 + 检查点，不是进程内的 AbortController
 *    （重启后那位还在、controller 不在，恢复语义只能建立在库上）。
 *  - `isCancelRequested`：每次调用现读库里的 `cancel_requested`，让执行器能在自己的
 *    分段点提前收尾（返回 `kind:"canceled"`）。它与 worker 侧的检查点是**两条独立路径**，
 *    都要有测试：执行器不配合时，worker 仍不许把已被取消的任务按正常结果收尾。
 */
export interface JobExecutionContext {
  readonly signal: AbortSignal;
  readonly isCancelRequested: () => boolean;
}

export type JobExecutor = (job: JobRow, ctx: JobExecutionContext) => Promise<JobExecutionResult>;

/**
 * 异常信息的去处（§八 之外的实现口径）：`privacy_job` 里**没有**任何自由文本列，
 * 也不该为一次异常加列（禁区），所以原始 message 只进这个事件面（日志），库里只落分类。
 * 缺席即静默——本批不接线，bootstrap 那一批再决定它接到哪个日志器上。
 */
export interface JobWorkerFailureEvent {
  readonly jobId: string | null;
  /**
   * `executor` = 执行器抛出的异常（已按 `retryable` + `internal` 归类）；
   * `worker` = 循环自身的意外失败；
   * `lease_lost` = 收尾时任务行已不在在途态（被 `recover()`/别的实例回收过，或检查点已把它落成
   *   `canceled`），这一次的结果**作废**——不自创边去救一个不再属于自己的行（见 `advance`）。
   */
  readonly stage: "executor" | "worker" | "lease_lost";
  readonly message: string;
  readonly atUtc: string;
}

export interface JobWorkerOptions {
  /**
   * 与 `store` 同一个数据库句柄。**只**用于 §一-3 要求的记录级推进
   * （`update capture_record set processing_status`）；`privacy_job` 的写入一律走 `store`。
   * 构造清单里多出来的这一项是必需的：JobStore 的 db 是私有字段，而记录级状态必须由队列推进，
   * 否则记录卡在在途态（草案 §一-3 末段）。
   */
  readonly db: Database;
  readonly store: JobStore;
  readonly executor: JobExecutor;
  readonly providerReady: () => boolean;
  /** 注入只为测试可控（与 `JobStore`、`GrantService` 同形）；默认 `() => new Date()`。 */
  readonly now?: () => Date;
  readonly leaseMs?: number;
  readonly pollIntervalMs?: number;
  /**
   * 租约归属记录（M6-1D 裁决 ①-b）。取到任务后写明「这一行我在用、用到什么时候」，收尾即删；
   * 缺席即不登记——0E 那批只测调度语义的用例因此行为逐字不变，真实接线由 bootstrap 注入。
   * 它**不是**单次尝试的超时（那是裁决 ③，本轮不做，见交付记录）。
   */
  readonly leases?: JobLease;
  readonly onFailure?: (event: JobWorkerFailureEvent) => void;
  /**
   * 「这一行此刻能不能开工」（整理方式改动 S-4）。递进 `store.claimNextRunnable`，
   * 判据为假的外发轨行**原样留在 `queued`**（不占位、不动 attempts、不发字节）——
   * 那是等用户在待整理确认，不是一次失败。生产接线只有一条判据：外发四腿没授权 ⇒ 假；
   * 缺席 ⇒ 与从前逐字相同（最早的一行直接占住），0E 那批只测调度语义的用例因此不变。
   */
  readonly runnable?: (job: JobRow) => boolean;
}

export class JobWorker {
  private readonly db: Database;
  private readonly store: JobStore;
  private readonly executor: JobExecutor;
  private readonly providerReady: () => boolean;
  private readonly now: () => Date;
  private readonly leaseMs: number;
  private readonly pollIntervalMs: number;
  private readonly leases: JobLease | null;
  private readonly onFailure: ((event: JobWorkerFailureEvent) => void) | undefined;
  private readonly runnable: ((job: JobRow) => boolean) | undefined;
  private timer: NodeJS.Timeout | null = null;
  /** 在跑的那一次 tick；非 null 即「上一拍还没完」，定时器的这一拍直接跳过（串行保证）。 */
  private current: Promise<void> | null = null;

  constructor(options: JobWorkerOptions) {
    this.db = options.db;
    this.store = options.store;
    this.executor = options.executor;
    this.providerReady = options.providerReady;
    this.now = options.now ?? (() => new Date());
    this.leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.leases = options.leases ?? null;
    this.onFailure = options.onFailure;
    this.runnable = options.runnable;
  }

  /**
   * 启动恢复的**唯一入口**（§四 + 断言 2）：回收过期租约，返回被回收的任务 id。
   * 未过期的在途行一行不动——单进程部署下不该出现，判据留着是给将来多实例的。
   * 语义全在 `JobStore.reclaimExpiredLeases`（含「已请求取消的回 canceled 而不是 queued」那条分岔）。
   */
  recover(): string[] {
    return this.store.reclaimExpiredLeases(this.leaseMs);
  }

  /**
   * 一次调度。顺序是契约（§五），**不可**调整：
   *  a. provider 没就绪 ⇒ 一行都不取，直接返回。判据必须在 `claimNextRunnable()` 之前：
   *     先占住 `redacting` 再回退，就要为断言 5 凭空多写一条 `redacting → queued`，
   *     库里留下一次没有发生的「执行」痕迹（`updated_at_utc` 也被刷新过）。
   *  b. 取最早的**可开工**任务并占住它（`queued → redacting`，不动 attempts）：递了 `runnable`
   *     就按它筛，被跳过的外发行原样留在 `queued`，这一拍等同「没有活」。
   *  c. 交给执行器，异常也有归宿（见 `execute`）。
   *  d/e. 按结果收尾，收尾前每步过一次取消检查点（见 `advance`）。
   *  f. 收尾成功（真的写过行）才推进记录级状态（见 `syncRecordProcessingStatus`）；
   *     一拍什么都没写成 ⇒ 连记录级也不动，那一拍的执行结果并不属于这个 worker。
   */
  async tickOnce(): Promise<void> {
    if (!this.providerReady()) return;
    const job = this.store.claimNextRunnable(this.runnable);
    if (job === null) return;
    // 归属登记（M6-1D 裁决 ①-b）：从占到这一行到写完终态，`job_lease:<id>` 写明「我在用、用到什么时候」。
    // 到点时长取 `leaseMs`——超过它，回收方按 §四 认这一拍已经崩了（续租与单次尝试的真超时属裁决 ③，本轮不做）。
    this.leases?.acquire(job.id, this.leaseMs);
    try {
      const result = await this.execute(job);
      if (this.settle(job.id, result)) {
        this.syncRecordProcessingStatus(job.id);
        return;
      }
      // 一步都没写成：行要么随记录消失了（FK CASCADE，没有可推进的东西），要么已不在在途态
      //（租约被回收过 / 检查点已把它落成终态）。后者要看得见，前者不必——只报仍然存在的那一种。
      const surviving = this.store.get(job.id);
      if (surviving !== null) {
        this.emit(
          job.id,
          "lease_lost",
          `收尾作废：任务行已不在在途态（status=${surviving.status}），不自创边去救不再属于自己的行`,
        );
      }
    } finally {
      this.leases?.release(job.id);
    }
  }

  /**
   * 启动：先做一次 `recover()`（断言 2 的「启动后回到 queued」），再按 `pollIntervalMs` 排 tick。
   * 定时器 `unref()`——它不该单独把进程留住（测试与 CLI 退出不能被它粘住）。
   * 幂等：已在跑就不再排第二个定时器。
   */
  start(): void {
    if (this.timer !== null) return;
    this.recover();
    this.timer = setInterval(() => this.scheduleTick(), this.pollIntervalMs);
    this.timer.unref();
  }

  /**
   * 停止：清定时器，并**等在跑的那一次 tick 收尾**。不掐断执行器——§五 的中止权威是
   * 取消请求 + 检查点，`stop()` 只是不再排新活；正在写的结果让它写完，才不会留半成品。
   */
  async stop(): Promise<void> {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.current;
  }

  /** 定时器的落点：重入闸门 + 把意外失败收进事件面（不能让 tick 的 reject 变成未处理拒绝）。 */
  private scheduleTick(): void {
    if (this.current !== null) return;
    const tick: Promise<void> = this.tickOnce()
      .catch((cause: unknown) => {
        this.emit(null, "worker", messageOf(cause));
      })
      .finally(() => {
        if (this.current === tick) this.current = null;
      });
    this.current = tick;
  }

  /**
   * c. 执行器抛异常也要有归宿：按 §五 的 `internal` 归类（消耗 attempts），
   *    而不是让一次调度循环崩溃、也不是直接落 `failed`（未达上限时它就该回 `queued` 重试）。
   *    原始 message 只进 `onFailure` 事件面，库里只有分类——表里没有承载文本的列，也不加。
   */
  private async execute(job: JobRow): Promise<JobExecutionResult> {
    const controller = new AbortController();
    const ctx: JobExecutionContext = {
      signal: controller.signal,
      isCancelRequested: () => this.store.get(job.id)?.cancel_requested === 1,
    };
    try {
      return await this.executor(job, ctx);
    } catch (cause) {
      this.emit(job.id, "executor", messageOf(cause));
      return { kind: "retryable", errorKind: "internal" };
    }
  }

  /**
   * d. 按结果收尾。**只有草案 §三 表里的那些边**，别自创：
   *  · `done` / `already_done`：`redacting` 时先 `→ analyzing` 再 `→ done`——§三 没有
   *    `redacting → done` 这条边（脱敏与执行两段各有一个在途态），而 `already_done` 也一样要走完
   *    这两步，因为「没重复调模型」不改变「两段都算过了」。
   *  · `canceled`：两个在途态都允许。
   *  · `provider_unavailable`：回 `queued` 且**不传 attemptsDelta**（= 不消耗，断言 5），
   *    `errorKind` 照写——清成 null 就把「上次为什么没跑成」这条线索抹了，运维只看到一行凭空重排的任务。
   *  · `retryable`：`attempts + 1 >= JOB_MAX_ATTEMPTS` ⇒ `failed`，否则回 `queued`；两者都 `+1`。
   *
   * attempts 读的是**收尾现读的那一行**而不是 `claimNextRunnable()` 时的快照：中途可能有取消、
   * 也可能被恢复扫描动过（§四 的租约回收本身就 `attempts + 1`），拿旧快照判上限会多给一次尝试。
   *
   * 退避为什么没有专列：§五 要的是「指数退避」，而承载它需要「下次尝试时间」列（禁区——0010 不改）。
   * 现有形状下退避由两处共同体现：`jobRetryBackoffMs(attempts)`（存储层纯函数，基数 2s）与
   * worker 的 `pollIntervalMs`（默认 2s）——重试的实际等待不小于退避基数，两次尝试的量级因此相称。
   * 要做精确到行的退避，得先由裁决给这张表加列或让 worker 常驻内存计时，都不属本批。
   */
  private settle(jobId: string, result: JobExecutionResult): boolean {
    switch (result.kind) {
      case "canceled": {
        return this.advance(jobId, "canceled", {});
      }
      case "provider_unavailable": {
        return this.advance(jobId, "queued", { errorKind: result.errorKind });
      }
      case "retryable": {
        const current = this.store.get(jobId);
        if (current === null) return false;
        const exhausted = current.attempts + 1 >= JOB_MAX_ATTEMPTS;
        return this.advance(jobId, exhausted ? "failed" : "queued", {
          errorKind: result.errorKind,
          attemptsDelta: 1,
        });
      }
      case "done":
      case "already_done": {
        const current = this.store.get(jobId);
        if (current === null) return false;
        // 两段各一次推进；任一次被检查点改道成 canceled，后一次就只是「行已定案，不再动」。
        const walked = current.status === "redacting" ? this.advance(jobId, "analyzing", {}) : false;
        const reached = this.advance(jobId, "done", {});
        return walked || reached;
      }
    }
  }

  /**
   * e. 状态推进 + 取消检查点。返回**这一次调用有没有真的写库**。
   *
   * 每次推进**之前**重读一次行：`cancel_requested=1` 且仍在途 ⇒ 这一拍改走 `canceled`，
   * 不再按正常结果收尾（§五「worker 在下一个检查点中止并置 canceled」）。这就是那两个检查点里
   * 的 worker 侧那一个——执行器不配合（不检查 `ctx`、照常返回 `done`）时它仍然成立。
   *
   * 取消收尾**不带 patch**：取消不是失败，既不写 `errorKind` 也不消耗 attempts
   * （与 `reclaimExpiredLeases` 的 canceled 分支、`recordProcessingStatusForJobStatus` 的
   * canceled 映射同一个理由）。
   *
   * 行已不在途 ⇒ 不推进。这一条不是防御性代码而是**唯一不自创边的走法**：§三 里没有
   * `canceled → done`、也没有 `queued → failed`，而这两种现状都会在这里出现（检查点刚把行落成
   * `canceled`，或租约被 `recover()` 收回去了）。硬要走就抛 `JobTransitionError`、把一次已定案的
   * 任务整成一次崩溃；改道去走别的边就是自创转换。所以停手，交给 `tickOnce` 报一条 `lease_lost`
   * 事件——这个行不再属于这一拍。
   *
   * 行读不回来 ⇒ 返回 false 且不做事：任务行只能随 `record_revision` 的 FK CASCADE 消失，
   * 记录都没了，为一条不存在的行推进状态没有意义（也不该抛错——抛错只会把这次调度整成噪声）。
   */
  private advance(id: string, to: JobStatus, patch: JobTransitionPatch): boolean {
    const current = this.store.get(id);
    if (current === null) return false;
    if (current.cancel_requested === 1 && IN_FLIGHT.has(current.status)) {
      this.store.transition(id, "canceled");
      return true;
    }
    if (!IN_FLIGHT.has(current.status)) return false;
    this.store.transition(id, to, patch);
    return true;
  }

  /**
   * f. 记录级推进（§一-3 末段）：队列负责 `capture_record.processing_status`，否则记录卡在在途态。
   * 目标值由 `recordProcessingStatusForJobStatus(job.status)` 给出（那张映射表在存储层，不在这里重抄）。
   *
   * **先过 enums 的合法边判定**（`isStateTransitionAllowed("processing_status", 当前, 目标)`），
   * 不合法就跳过这一次记录级写入，其余动作一概不变。理由：状态机是契约不是建议，worker 无权
   * 自创边；而这里也不该像同步入口那样 `assertStateTransition` 直接抛——同步入口面对的是用户点击，
   * 转换不成立必须如实回给用户；worker 面对的是后台循环，抛错没有接收方，只会把**已经定案的任务行**
   * 连带拖成一次调度失败（任务状态的权威已经完成，记录级这一格只是没能刷新）。
   * 跳过 = 损失这一次记录级刷新，任务行的权威状态不受影响。哪些边该补，交回裁决（见交付记录存疑项）。
   *
   * 只动 `processing_status` 这一列：派生结果、原文、修正层都不是队列的职责。
   */
  private syncRecordProcessingStatus(jobId: string): void {
    const job = this.store.get(jobId);
    if (job === null) return;
    const target = recordProcessingStatusForJobStatus(job.status);
    const record = this.db
      .prepare("select processing_status from capture_record where id = ?")
      .get(job.record_id) as { processing_status: string } | undefined;
    if (record === undefined) return;
    if (!isStateTransitionAllowed("processing_status", record.processing_status, target)) return;
    this.db
      .prepare("update capture_record set processing_status = ? where id = ?")
      .run(target, job.record_id);
  }

  private emit(jobId: string | null, stage: JobWorkerFailureEvent["stage"], message: string): void {
    if (this.onFailure === undefined) return;
    this.onFailure({ jobId, stage, message, atUtc: this.now().toISOString() });
  }
}
