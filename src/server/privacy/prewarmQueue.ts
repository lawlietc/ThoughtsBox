/**
 * M10-1（执行准则 §四、裁决 M10-D-1 / D-2 / D-5 / D-6 / D-7）：保存之后在本机把脱敏结果**先算好**。
 *
 * 为什么可以有这一层：本地模型档下每次预览要问一次本机模型，实测 9–264 s，而服务端那次调用没有
 * caller signal，算出来的结果本来就会落 `app_meta`（`preview_llm_spans:` / `preview_llm_payload:`）。
 * 于是「算」可以提前——用户点预览时命中缓存、秒出。**本层只把「算」挪到前面，不改变发哪一份**：
 * 四腿授权、载荷哈希、`policy_version`、三轴、`processing_status` 一个字都不动（N-1 / N-2 / N-7）。
 *
 * 五条纪律对应五条裁决：
 *  - **防抖**（M10-D-1）：同一 revision 连续保存只算最后一次；编辑停手 3 秒才真的去问。
 *  - **串行**（M10-D-5）：同时最多一条在跑。本机模型单次已经要几十秒，并发只会把机器打满。
 *  - **同一个装配入口**（M10-D-6）：跑体只调 `resolveLocalLlmPreview`，不另写一条「只算候选」的路——
 *    否则「预跑得的那份」与「用户点预览现算的那份」是两条实现，逐字同源（断言 B3）就名存实亡。
 *  - **不自动重试**（M10-D-7）：失败只落既有失败标记，重试的凭据是用户那一下点击。
 *  - **不做总开关**（M10-D-2）：要不要预跑只有一个判据 = 那条记录自己的三轴，由 `isWanted` 现读。
 *
 * 「跑之前重新核对」是这一层唯一的意图判定：记录被删、被改档 ⇒ 意图变了，不是错误 ⇒ 静默跳过、
 * 零请求、不抛。任何异常都就地吞掉，只累加一个封闭类别的计数（N-6：原文 / 词面 / 自由文本
 * 都不许进这里，观测面只有 revisionId、入队时刻与三档计数）。
 */

import type { ModelAdapter } from "../ingest/provider.ts";
import { resolveLocalLlmPreview, type LocalLlmPreviewOptions } from "./localLlmPreview.ts";
import type { GrantService } from "./grantService.ts";

/**
 * 这一条预跑的去向（封闭集，取值就这三个）：
 *  - `ran` —— 走到装配入口并拿到了结果（模型没跑成时由 `resolveLocalLlmPreview` 自己落失败标记，
 *    这一层不另立「模型失败」类别：那已经是既有事实，不是本层的新状态）。
 *  - `skipped` —— 跑前重新核对不成立（记录没了 / 已改档 / 这一档没配好），零请求。
 *  - `failed` —— 装配入口抛出（含库里读不到那一版）。不重试，只计数。
 */
export const PREWARM_OUTCOMES = ["ran", "skipped", "failed"] as const;
export type PrewarmOutcome = (typeof PREWARM_OUTCOMES)[number];

/** 防抖窗口（M10-D-1，用户 2026-10-30 拍板取「保存即跑」+ 3 秒）。 */
export const DEFAULT_PREWARM_DEBOUNCE_MS = 3000;

export interface PrewarmDeps {
  /** 现取当前活动工作区里的 GrantService（R-5 换库后仍要指当前那份）。 */
  readonly getGrants: () => GrantService;
  /** 现读当前配置快照下的本地模型适配器；`null` = 这一档没配好，直接跳过。 */
  readonly resolveAdapter: () => ModelAdapter | null;
  /** 这条 revision 现在还要不要预跑：存在、且其记录三轴是 `(cloud, local_llm, redacted)`。 */
  readonly isWanted: (revisionId: string) => boolean;
  /** 防抖窗口，缺省 `DEFAULT_PREWARM_DEBOUNCE_MS`。 */
  readonly delayMs?: number;
  /** 只给测试注入假端点；生产不传（走真回环端点）。 */
  readonly fetchImpl?: typeof fetch;
}

export interface PrewarmStats {
  readonly ran: number;
  readonly skipped: number;
  readonly failed: number;
  /** 最近一条的去向。只有 revisionId 与类别——没有原文、没有词面、没有自由文本（N-6）。 */
  readonly last: { readonly revisionId: string; readonly outcome: PrewarmOutcome } | null;
}

/**
 * 队列此刻的在册读数（M10-4，执行准则 §七）。表里只有 revisionId 与时刻两个字段（N-6）。
 *
 * 这一层存在的唯一理由：界面上「还没算出待发送文本」有三件不同的成因（排队中 / 在跑 / 这一档没配好
 * 被静默跳过），而只有本队列分得清前三者里的后两者——裁决 M10-D-9 因此规定「还在检查」只认这份
 * 在册状态，绝不从 `hasPayload === false` 反推。
 */
export interface PrewarmSnapshot {
  /** 在册条数：防抖中的 + 已排队的 + 正在跑的那一条。恒等于 `size()`——两者读同一张表。 */
  readonly pending: number;
  /** revisionId ⇒ 入队时刻（epoch ms）。键集合与 `pending` 是同一份事实的两个说法。 */
  readonly sinceByRevision: ReadonlyMap<string, number>;
}

export class PrewarmQueue {
  private readonly deps: PrewarmDeps;
  private readonly delayMs: number;
  private readonly previewOptions: LocalLlmPreviewOptions;
  /** 防抖已到期、排队等串行执行的 revisionId（按入队顺序）。 */
  private readonly due: string[] = [];
  /** 还在防抖窗口里的 revisionId ⇒ 它的计时器。同一 id 至多一枚，重复 enqueue 换新的。 */
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** 串行执行体；`null` = 当前没有在跑的这一拍。 */
  private running: Promise<void> | null = null;
  /**
   * 在册登记表：revisionId ⇒ 入队时刻（epoch ms）。防抖中的、已排队的、正在跑的都在这一张表里，
   * `size()` 与 `snapshot()` 因此是同一份事实的两个说法，而不是两段各数一遍的数数逻辑。
   *
   * 起点在 `enqueue` 里按下（M10-D-11：用户等的是「我保存了，多久能看到算好的文本」，防抖那 3 秒
   * 也在他的等待里），重复 enqueue 重置。跑完 / 被跳过 / 抛错 ⇒ `retire` 摘掉；一条都不许留，
   * 留着就是幽灵行：队列空了而某条记录还写着「已等 40 秒」。
   */
  private readonly backlog = new Map<string, number>();
  private ran = 0;
  private skipped = 0;
  private failed = 0;
  private last: PrewarmStats["last"] = null;

  constructor(deps: PrewarmDeps) {
    this.deps = deps;
    this.delayMs = deps.delayMs ?? DEFAULT_PREWARM_DEBOUNCE_MS;
    // 生产不传 fetchImpl ⇒ 交给 `resolveLocalLlmPreview` 的缺省分支（真回环端点）。
    this.previewOptions = deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl };
  }

  /**
   * 登记「这一版刚保存」。同一 revision 连续 enqueue **只保留最后一次**：先撤掉它已有的计时器，
   * 再把它从已排队的队列里摘出去重排（编辑期间的每一次保存都只是重排，不是叠加）。
   * 调用点必须在写事务提交之后（B12），因为跑体要读库。
   */
  enqueue(revisionId: string): void {
    this.cancel(revisionId);
    const queuedIndex = this.due.indexOf(revisionId);
    if (queuedIndex >= 0) this.due.splice(queuedIndex, 1);
    const timer = setTimeout(() => {
      this.start(revisionId);
    }, this.delayMs);
    // 预跑不该按住进程退出：关窗即走，没跑成的最小后果 = 回到今天的行为（M10-D-5）。
    timer.unref?.();
    this.timers.set(revisionId, timer);
    // 等待的起点 = 这一刻。同一 revision 再保存一次，用户等的也是「这一次之后」，所以重置。
    this.backlog.set(revisionId, Date.now());
  }

  /** 待预跑的条数：还在防抖窗口里的 + 已排队的 + 正在跑的那一条。 */
  size(): number {
    return this.backlog.size;
  }

  /**
   * 此刻在册读数（M10-4）。**只读**：不写库、不建 `app_meta` 键、不发请求、不触发预跑。
   *
   * 返回的是这张表的副本——调用方（复核队列端点）拿到的时刻点不会随队列继续推进而变，
   * 一次请求取一次就够；取两次会让同一份响应里两处读数不是同一刻。
   */
  snapshot(): PrewarmSnapshot {
    return { pending: this.backlog.size, sinceByRevision: new Map(this.backlog) };
  }

  stats(): PrewarmStats {
    return { ran: this.ran, skipped: this.skipped, failed: this.failed, last: this.last };
  }

  /**
   * 把当前排队与在跑的跑完，**并且立刻兑现还没到点的防抖计时器**。
   * 存在的理由是测试不必真等 3 秒窗口，也不必装假计时器；生产路径从不叫它。
   */
  async drain(): Promise<void> {
    for (;;) {
      for (const revisionId of [...this.timers.keys()]) this.start(revisionId);
      if (this.running !== null) {
        await this.running;
        continue;
      }
      if (this.due.length === 0) return;
      this.kick();
    }
  }

  /** 计时器到点：撤掉自己那枚计时器、入队、踢一脚执行体。 */
  private start(revisionId: string): void {
    this.cancel(revisionId);
    if (!this.due.includes(revisionId)) this.due.push(revisionId);
    this.kick();
  }

  private cancel(revisionId: string): void {
    const timer = this.timers.get(revisionId);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.timers.delete(revisionId);
  }

  /** 串行的落点：执行体在册 ⇒ 后来者只排队，绝不并起第二条（M10-D-5）。 */
  private kick(): void {
    if (this.running !== null) return;
    const loop = this.runSerial();
    this.running = loop;
    void loop.then(() => {
      if (this.running === loop) this.running = null;
    });
  }

  private async runSerial(): Promise<void> {
    for (;;) {
      const revisionId = this.due.shift();
      if (revisionId === undefined) return;
      await this.runOne(revisionId);
      this.retire(revisionId);
    }
  }

  /**
   * 跑完一条就把它从登记表里摘掉——`runOne` 的三条出路（跑成 / 跳过 / 抛错）都走到这里。
   *
   * 唯一不摘的情形：跑的这一拍还没结束，同一条又保存了一次（新计时器在册或已重新排队）。
   * 那时登记表里那一格说的是**新那一次**的起点，摘掉就把一条还在排队/在跑的记录读成了「没人在算」。
   */
  private retire(revisionId: string): void {
    if (this.timers.has(revisionId) || this.due.includes(revisionId)) return;
    this.backlog.delete(revisionId);
  }

  private async runOne(revisionId: string): Promise<void> {
    try {
      // 跑之前重新核对：这两次读取说的都是**此刻**的意图，不是入队那一刻的。
      if (!this.deps.isWanted(revisionId)) {
        this.record("skipped", revisionId);
        return;
      }
      const adapter = this.deps.resolveAdapter();
      if (adapter === null) {
        this.record("skipped", revisionId);
        return;
      }
      // 唯一跑体（M10-D-6）：拿到结果即结束。不签发授权、不改三轴、不改 `processing_status`、
      // 不发任何外发请求——那些都不是这一层的职责。
      await resolveLocalLlmPreview(this.deps.getGrants(), adapter, revisionId, this.previewOptions);
      this.record("ran", revisionId);
    } catch {
      // 就地吞掉：预跑失败不能冒泡成用户可见的错误，也不重试（M10-D-7）。
      // 不记原因正文（N-6），只记这一条属于「没跑成」这一类。
      this.record("failed", revisionId);
    }
  }

  private record(outcome: PrewarmOutcome, revisionId: string): void {
    if (outcome === "ran") this.ran += 1;
    else if (outcome === "skipped") this.skipped += 1;
    else this.failed += 1;
    this.last = { revisionId, outcome };
  }
}
