import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { migrate } from "../src/server/db/migrator.ts";
import { RecordService } from "../src/server/records/service.ts";
import {
  JOB_ERROR_KINDS,
  JobStore,
  consumesAttempt,
  isJobTransitionAllowed,
  recordProcessingStatusForJobStatus,
  type JobRow,
  type JobStatus,
} from "../src/server/jobs/jobStore.ts";
import {
  JOB_MAX_ATTEMPTS,
  JobWorker,
  DEFAULT_LEASE_MS,
  DEFAULT_POLL_INTERVAL_MS,
  type JobExecutionContext,
  type JobExecutionResult,
  type JobExecutor,
  type JobWorkerFailureEvent,
} from "../src/server/jobs/jobWorker.ts";
import { isStateTransitionAllowed } from "../src/server/ingest/ingestService.ts";
import { makeSandbox, openSandboxDb, type Sandbox } from "./helpers/sandbox.ts";
import type { Database } from "../src/server/db/adapter.ts";

/**
 * M6-0E 第二批 A：后台任务队列**调度循环**（`jobWorker.ts`）的验收。
 *
 * 契约正文：`docs/dev-specs/2026-10-23-M6-0E-后台任务队列设计草案.md`
 * §三 状态机、§四 恢复、§五 调度与取消、§六 与同步入口的关系、§八 断言 2/4/5。
 * 本批不接线：没有 HTTP 路由、没有真实脱敏/分析执行器、bootstrap 不构造本类——
 * 所以执行体一律是假 executor，模型一次都没被真调（禁区）。
 *
 * 与存储层那份测试（`m6-0e-job-store.test.ts`）的分工：那份钉「边能不能走、幂等键只一行、
 * 租约到期才回收」这些**动作本身**；这份钉「按什么顺序、在什么条件下调用那些动作」——
 * provider 闸门在取任务**之前**、取消检查点在每次推进**之前**、attempts 只在两类结局里加。
 */

const NOW = "2026-10-25T09:00:00.000Z";
const NOW_MS = Date.parse(NOW);
/** 草案 §九 的建议阈值：默认值本身由 `DEFAULT_LEASE_MS` 钉，这里只用来摆夹具。 */
const TEN_MINUTES_MS = 10 * 60_000;

const AXES = { analysisProvider: "cloud", redactionMode: "manual", sendContentMode: "redacted" } as const;
const VERSIONS = {
  promptVersion: "m2-prompt-v1",
  schemaVersion: "m2-output-v1",
  modelId: "qwen2.5:7b",
  redactionPolicyVersion: "rules-v1",
};
const RAW = "👍张三说打 13800138000 给 laowang@example.com 或老周";

let sandbox: Sandbox;
let db: Database;
let records: RecordService;
let store: JobStore;
let recordId: string;
let revisionId: string;

beforeEach(() => {
  sandbox = makeSandbox("tb-m6-0e-w-");
  db = openSandboxDb(sandbox.layout);
  migrate(db);
  records = new RecordService(db, { timezoneId: "Asia/Shanghai", now: () => new Date(NOW) });
  store = new JobStore(db, { now: () => new Date(NOW) });
  const created = records.createRecord(RAW, "cloud_redacted");
  recordId = created.record.id;
  revisionId = created.revision.id;
});

afterEach(() => {
  vi.restoreAllMocks();
  db.close();
  sandbox.cleanup();
});

// ── 夹具 ────────────────────────────────────────────────────────────

function enqueue(revision: string = revisionId): JobRow {
  return store.enqueue({ recordRevisionId: revision, axes: AXES, versions: VERSIONS }).row;
}

function rowOf(id: string): JobRow {
  const row = store.get(id);
  if (row === null) throw new Error(`任务行不存在：${id}`);
  return row;
}

let revisionCounter = 0;
/** 并存的多行各要一条自己的 revision（同 revision 只留一个活跃任务，见存储层的 supersede）。 */
function freshRevision(): string {
  revisionCounter += 1;
  const edited = records.editRecord(recordId, `${RAW}（夹具第 ${revisionCounter} 次改动）`);
  if (!edited.changed) throw new Error(`夹具没能建出新 revision：第 ${revisionCounter} 次`);
  return edited.revision.id;
}

function ageJob(id: string, agoMs: number): void {
  db.prepare("update privacy_job set updated_at_utc = ? where id = ?")
    .run(new Date(NOW_MS - agoMs).toISOString(), id);
}

/**
 * 清场：`claimNextRunnable()` 取的是**全表**最早的可执行行（`order by created_at_utc, id`），
 * 而同一个 it 里连跑整张矩阵时，上一组留下的 `queued` 行会把这一组的 tick抢走——被测的就不再
 * 是刚入队的那一行。把多余的 queued 一律按 §三 的 `queued → canceled` 收掉，候选只剩一行。
 */
function drainQueued(): void {
  const stale = db.prepare("select id from privacy_job where status = 'queued'").all() as Array<{ id: string }>;
  for (const row of stale) store.requestCancel(row.id);
}

function recordStatus(id: string): string {
  const row = db.prepare("select processing_status from capture_record where id = ?").get(id) as
    | { processing_status: string }
    | undefined;
  if (row === undefined) throw new Error(`记录不存在：${id}`);
  return row.processing_status;
}

function recordFullRow(id: string): Record<string, unknown> {
  return db.prepare("select * from capture_record where id = ?").get(id) as Record<string, unknown>;
}

/**
 * 把记录级状态摆到某个值。**夹具绕过状态机**，调用处必须写明为什么：
 * 沿合法边把记录开到 `processing` 要真跑一次同步入口（`enterProcessing` 那一串），
 * 而那与「worker 收尾时怎么推进记录级状态」是两件事，补上去只会把被测的那件事埋掉。
 * 摆进去的取值都在 `processing_statuses` 封闭集内，不越迁移的 CHECK。
 */
function setRecordStatus(id: string, status: string): void {
  db.prepare("update capture_record set processing_status = ? where id = ?").run(status, id);
}

interface WorkerFixture {
  readonly worker: JobWorker;
  readonly failures: JobWorkerFailureEvent[];
  /** 断言 5 的开关：`ready=false` 时 worker 一个任务都不该取。 */
  readonly provider: { ready: boolean };
  readonly calls: () => number;
}

/** 假 executor 与可控 now：本批不装配 provider，所以时间只有注入的这一份。 */
function makeWorker(
  executor: JobExecutor,
  options: {
    ready?: boolean;
    pollIntervalMs?: number;
    leaseMs?: number;
    /** 整理方式改动 S-4：认领判据（外发轨没本次授权的那一行不许被占住）。 */
    runnable?: (job: JobRow) => boolean;
  } = {},
): WorkerFixture {
  const failures: JobWorkerFailureEvent[] = [];
  const provider = { ready: options.ready ?? true };
  let calls = 0;
  const worker = new JobWorker({
    db,
    store,
    executor: async (job, ctx) => {
      calls += 1;
      return executor(job, ctx);
    },
    providerReady: () => provider.ready,
    now: () => new Date(NOW),
    onFailure: (event) => {
      failures.push(event);
    },
    ...(options.pollIntervalMs === undefined ? {} : { pollIntervalMs: options.pollIntervalMs }),
    ...(options.leaseMs === undefined ? {} : { leaseMs: options.leaseMs }),
    ...(options.runnable === undefined ? {} : { runnable: options.runnable }),
  });
  return { worker, failures, provider, calls: () => calls };
}

/** 一次就成功的执行器：绝大多数用例只关心收尾那几步。 */
const succeed: JobExecutor = async () => ({ kind: "done" });

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 等真实定时器把 tick 排起来用（只服务 start/stop 那两个用例，与被测语义无关）。 */
async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (predicate()) return;
    await sleep(5);
  }
  throw new Error(`等待条件超时：${label}`);
}

/** 一扇由测试手动推开的大门：让执行器停在「结果写不写」的那一步之前。 */
function deferredGate(): { readonly wait: Promise<void>; release(): void } {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release: () => release() };
}

// ── A. 断言 5：provider 不可用 ⇒ 一行都不取 ────────────────────────────

describe("A. §八-5 provider 闸门在取任务之前", () => {
  it("providerReady=false ⇒ 不 claim、不跑 executor，任务行逐字不变（连 updated_at 都不动）", async () => {
    const { id } = enqueue();
    const before = rowOf(id);
    const claim = vi.spyOn(store, "claimNextRunnable");
    const fx = makeWorker(succeed, { ready: false });

    await fx.worker.tickOnce();

    // 「先 claim 再回退」会在这里露馅：取到过就要凭空多一条 redacting→queued 的写。
    expect(claim).not.toHaveBeenCalled();
    expect(fx.calls()).toBe(0);
    expect(rowOf(id)).toEqual(before);
    expect(rowOf(id).status).toBe("queued");
    expect(rowOf(id).attempts).toBe(0);
    expect(rowOf(id).error_kind).toBeNull();
    // 记录级那一格也不动：什么都没发生就该像什么都没发生。
    expect(recordStatus(recordId)).toBe("awaiting_privacy_review");
  });

  it("provider 恢复后自动继续：同一个 worker、同一个 tickOnce 正常开跑（断言 5 后半句）", async () => {
    const { id } = enqueue();
    const seen: JobRow[] = [];
    const fx = makeWorker(async (job) => {
      seen.push(job);
      return { kind: "done" };
    });
    fx.provider.ready = false;
    await fx.worker.tickOnce();
    expect(fx.calls()).toBe(0);
    expect(rowOf(id).status).toBe("queued");

    fx.provider.ready = true;
    await fx.worker.tickOnce();
    expect(fx.calls()).toBe(1);
    // 执行器拿到的是**已占用**的那一行（claimNextRunnable 的产物，不是 queued 的快照）。
    expect(seen[0]?.id).toBe(id);
    expect(seen[0]?.status).toBe("redacting");
    expect(rowOf(id).status).toBe("done");
    expect(rowOf(id).attempts).toBe(0);
  });

  it("provider 就绪但没有 queued 行 ⇒ claim 了个空、executor 不被调用", async () => {
    const claim = vi.spyOn(store, "claimNextRunnable");
    const fx = makeWorker(succeed);
    await fx.worker.tickOnce();
    expect(claim).toHaveBeenCalledTimes(1);
    expect(fx.calls()).toBe(0);
  });
});

// ── A2. 整理方式改动 S-4：认领判据（不可开工的行不许被占住）────────────────

describe("A2. 认领判据：跳过不可开工的行，后面的行照常跑", () => {
  it("判据为假的队首行原样留在 queued，这一拍去执行后面那一行", async () => {
    const blocked = enqueue();
    const otherRevision = freshRevision();
    const ready = enqueue(otherRevision);
    const before = rowOf(blocked.id);

    const seen: string[] = [];
    const fx = makeWorker(async (job) => {
      seen.push(job.id);
      return { kind: "done" };
    }, { runnable: (job) => job.record_revision_id === otherRevision });

    await fx.worker.tickOnce();

    expect(seen).toEqual([ready.id]);
    expect(rowOf(ready.id).status).toBe("done");
    // 被跳过的行：不占位、不消耗 attempts、活跃度列不刷新——它是「等用户确认」，不是失败。
    expect(rowOf(blocked.id)).toEqual(before);
  });

  it("全部不可开工 ⇒ 一拍无事发生：执行器一次都不调，行留在队里等下一拍重问", async () => {
    const { id } = enqueue();
    const before = rowOf(id);
    const fx = makeWorker(succeed, { runnable: () => false });

    await fx.worker.tickOnce();
    await fx.worker.tickOnce();

    expect(fx.calls()).toBe(0);
    expect(rowOf(id)).toEqual(before);
    expect(rowOf(id).status).toBe("queued");
    expect(rowOf(id).attempts).toBe(0);
  });

  it("判据放行后同一行立刻可认领：不是永久跳过，也不是自动失败", async () => {
    const { id } = enqueue();
    let open = false;
    const fx = makeWorker(succeed, { runnable: () => open });

    await fx.worker.tickOnce();
    expect(rowOf(id).status).toBe("queued");

    open = true;
    await fx.worker.tickOnce();
    expect(fx.calls()).toBe(1);
    expect(rowOf(id).status).toBe("done");
  });
});

// ── B. 断言 4：中止不留半成品（两条取消路径都要成立）─────────────────────

describe("B. §八-4 取消在途任务 ⇒ canceled，且没有半成品", () => {
  it("执行器自己观察 ctx.isCancelRequested() ⇒ canceled + finished_at_utc，假写入器一次都没被调用", async () => {
    const { id } = enqueue();
    // 「只有全部成功才写结果」的假写入器：取消路径下它必须保持零调用。
    const fakeWriter = vi.fn();
    const gate = deferredGate();
    const fx = makeWorker(async (job, ctx: JobExecutionContext) => {
      await gate.wait;
      if (ctx.isCancelRequested()) return { kind: "canceled" } satisfies JobExecutionResult;
      fakeWriter(job.id);
      return { kind: "done" } satisfies JobExecutionResult;
    });

    const tick = fx.worker.tickOnce();
    await sleep(0);
    const requested = store.requestCancel(id);
    expect(requested.status).toBe("redacting"); // 在途的取消只置请求位
    gate.release();
    await tick;

    const after = rowOf(id);
    expect(after.status).toBe("canceled");
    expect(after.finished_at_utc).toBe(NOW);
    expect(after.cancel_requested).toBe(1);
    expect(after.attempts).toBe(0); // 取消不是一次尝试
    expect(after.error_kind).toBeNull(); // 取消不是失败
    expect(fakeWriter).not.toHaveBeenCalled();
  });

  it("执行器不配合（照常返回 done）⇒ worker 侧检查点仍改走 canceled，且不写中间态 analyzing", async () => {
    const { id } = enqueue();
    const fakeWriter = vi.fn();
    const fx = makeWorker(async (job) => {
      fakeWriter(job.id);
      // 模拟「执行期间用户点了取消」：执行器自己不看 ctx，检查点必须独立成立。
      store.requestCancel(job.id);
      return { kind: "done" };
    });
    const transition = vi.spyOn(store, "transition");

    await fx.worker.tickOnce();

    const after = rowOf(id);
    expect(after.status).toBe("canceled");
    expect(after.finished_at_utc).toBe(NOW);
    expect(after.attempts).toBe(0);
    expect(after.error_kind).toBeNull();
    // 取消收尾不吃 patch：既不给 error_kind 也不给 attempts——检查点抢在 analyzing 之前。
    const walked = transition.mock.calls.map((call) => call[1]);
    expect(walked).toEqual(["redacting", "canceled"]);
  });

  it("对照组：没有取消时同一个执行器照常写结果并落 done（证明上一例的零调用不是假象）", async () => {
    const { id } = enqueue();
    const fakeWriter = vi.fn();
    const gate = deferredGate();
    const fx = makeWorker(async (job) => {
      await gate.wait;
      fakeWriter(job.id);
      return { kind: "done" };
    });
    const tick = fx.worker.tickOnce();
    await sleep(0);
    gate.release();
    await tick;
    expect(fakeWriter).toHaveBeenCalledTimes(1);
    expect(rowOf(id).status).toBe("done");
  });
});

// ── C. 中途 provider 掉线：不消耗 attempts，且保留分类 ───────────────────

describe("C. provider_unavailable 回 queued 且不消耗 attempts（§五 + 断言 5）", () => {
  for (const errorKind of ["provider_unavailable", "provider_loading"] as const) {
    it(`执行器返回 provider_unavailable(${errorKind}) ⇒ 回 queued、attempts 仍 0、error_kind 保留`, async () => {
      const { id } = enqueue();
      const fx = makeWorker(async () => ({ kind: "provider_unavailable", errorKind }));

      await fx.worker.tickOnce();

      const after = rowOf(id);
      expect(after.status).toBe("queued");
      expect(after.attempts).toBe(0); // 不消耗：环境没准备好不是任务的错
      expect(after.error_kind).toBe(errorKind); // 没被清成 null：上一次为什么没跑成这条线索要留着
      expect(after.started_at_utc).toBe(NOW); // 确实开跑过（这一条边是 §四 的恢复边）

      // 回 queued 就还能被再取：不消耗 ⇒ 不会被上限挡在门外。
      const again = makeWorker(succeed);
      await again.worker.tickOnce();
      expect(rowOf(id).status).toBe("done");
      expect(rowOf(id).attempts).toBe(0);
    });
  }

  it("§五 的对账：provider 类结果可携带的 errorKind 恰是 consumesAttempt 判 false 的那两类", () => {
    const nonConsuming = JOB_ERROR_KINDS.filter((kind) => !consumesAttempt(kind));
    expect(nonConsuming).toEqual(["provider_unavailable", "provider_loading"]);
    expect(JOB_ERROR_KINDS.filter((kind) => consumesAttempt(kind))).toEqual(["timeout", "invalid_output", "internal"]);
    // 覆盖性：五个分类都判过，将来加第 6 类不会在这里静默漏判。
    expect(nonConsuming.length + JOB_ERROR_KINDS.filter((kind) => consumesAttempt(kind)).length).toBe(
      JOB_ERROR_KINDS.length,
    );
  });
});

// ── D. 重试上限：最多 2 次 ───────────────────────────────────────────

describe("D. §五 重试上限（JOB_MAX_ATTEMPTS）", () => {
  it("常量等于草案 §五 的「最多 2 次」，第一次回 queued、第二次落 failed，之后不再被取", async () => {
    expect(JOB_MAX_ATTEMPTS).toBe(2);
    const { id } = enqueue();
    const fx = makeWorker(async () => ({ kind: "retryable", errorKind: "timeout" }));

    await fx.worker.tickOnce();
    expect(rowOf(id)).toMatchObject({ status: "queued", attempts: 1, error_kind: "timeout" });

    await fx.worker.tickOnce();
    expect(rowOf(id)).toMatchObject({ status: "failed", attempts: 2, error_kind: "timeout" });
    expect(rowOf(id).finished_at_utc).toBe(NOW);
    expect(fx.calls()).toBe(2);

    // failed 不是可执行态：第三次 tick 一个任务都不该跑。
    await fx.worker.tickOnce();
    expect(fx.calls()).toBe(2);
    expect(rowOf(id).status).toBe("failed");
  });

  for (const errorKind of ["timeout", "invalid_output", "internal"] as const) {
    it(`消耗类 ${errorKind} 每次都 attempts+1`, async () => {
      const { id } = enqueue();
      const fx = makeWorker(async () => ({ kind: "retryable", errorKind }));
      await fx.worker.tickOnce();
      expect(rowOf(id).attempts).toBe(1);
      expect(rowOf(id).status).toBe("queued");
    });
  }

  it("attempts 现读收尾时那一行：执行期间另有写入者加过一度，就不会多给一次尝试", async () => {
    const { id } = enqueue();
    const fx = makeWorker(async (job) => {
      // 夹具绕过状态机直接摆 attempts（单进程串行下不会发生，但这一读就是为那种并发准备的）：
      // 用 claim 时的快照（0）判上限会判成「还可以再来一次」，现读才知道配额已经烧完。
      db.prepare("update privacy_job set attempts = ? where id = ?").run(JOB_MAX_ATTEMPTS - 1, job.id);
      return { kind: "retryable", errorKind: "timeout" };
    });
    await fx.worker.tickOnce();
    expect(rowOf(id)).toMatchObject({ status: "failed", attempts: JOB_MAX_ATTEMPTS, error_kind: "timeout" });
  });

  it("收尾时行已不在途（租约被 recover 收回）⇒ 这一拍作废：不自创边、不写记录级、报一条事件", async () => {
    const { id } = enqueue();
    const transition = vi.spyOn(store, "transition");
    const fx = makeWorker(async (job) => {
      // 阈值给成负数 ⇒ 「这一行早就过期了」，等价于另一个实例已经把它回收过一次（§四）。
      store.reclaimExpiredLeases(-1);
      expect(rowOf(job.id).status).toBe("queued");
      return { kind: "done" };
    });

    await fx.worker.tickOnce(); // 不 reject：非法的 queued→done 一次都没被尝试

    const after = rowOf(id);
    expect(after).toMatchObject({ status: "queued", attempts: 1, error_kind: "internal" }); // 回收的形状原样保留
    expect(transition.mock.calls.map((call) => call[1])).toEqual(["redacting", "queued"]); // claim + reclaim
    expect(fx.failures).toHaveLength(1);
    expect(fx.failures[0]).toMatchObject({ jobId: id, stage: "lease_lost" });
    // 记录级那一格也不动：这一拍没有任何属于它的收尾。
    expect(recordStatus(recordId)).toBe("awaiting_privacy_review");
  });
});

// ── E. 执行器抛异常：按 internal 归类，不崩溃、不直接落定 ────────────────

describe("E. 执行器抛异常 ⇒ retryable + internal", () => {
  it("抛 Error(\"boom\")：tickOnce 不 reject、第一次只回 queued，原始 message 不进库", async () => {
    const { id } = enqueue();
    const fx = makeWorker(async () => {
      throw new Error("boom");
    });

    await expect(fx.worker.tickOnce()).resolves.toBeUndefined();

    const after = rowOf(id);
    expect(after.status).toBe("queued"); // 不是「一抛就 failed」
    expect(after.attempts).toBe(1);
    expect(after.error_kind).toBe("internal");
    // 库里只落分类：表里没有自由文本列，也不为此加列。
    expect(JSON.stringify(after)).not.toContain("boom");
    // 异常信息进的是事件面（日志），不是数据库。
    expect(fx.failures).toHaveLength(1);
    expect(fx.failures[0]).toMatchObject({ jobId: id, stage: "executor", message: "boom", atUtc: NOW });
  });

  it("连续两次抛 ⇒ 第二次到上限落 failed（与 retryable 同一套上限判据）", async () => {
    const { id } = enqueue();
    const fx = makeWorker(async () => {
      throw new Error("boom");
    });
    await fx.worker.tickOnce();
    await fx.worker.tickOnce();
    expect(rowOf(id)).toMatchObject({ status: "failed", attempts: 2, error_kind: "internal" });
    expect(fx.failures).toHaveLength(2);
  });

  it("抛出非 Error 值也归类 internal，不因消息取不到而崩在循环里", async () => {
    const { id } = enqueue();
    const fx = makeWorker(async () => {
      throw "not an error"; // eslint-disable-line no-throw-literal
    });
    await fx.worker.tickOnce();
    expect(rowOf(id)).toMatchObject({ status: "queued", attempts: 1, error_kind: "internal" });
    expect(fx.failures[0]?.message).toBe("not an error");
  });
});

// ── F. already_done：幂等收尾，不重复调模型（§六）───────────────────────

describe("F. §六 already_done ⇒ 直接收尾到 done，不动 attempts", () => {
  it("走的是 §三 那两条边（redacting→analyzing→done），没有自创 redacting→done", async () => {
    expect(isJobTransitionAllowed("redacting", "done")).toBe(false);
    const { id } = enqueue();
    const transition = vi.spyOn(store, "transition");
    const fx = makeWorker(async () => ({ kind: "already_done" }));

    await fx.worker.tickOnce();

    expect(transition.mock.calls.map((call) => call[1])).toEqual(["redacting", "analyzing", "done"]);
    const after = rowOf(id);
    expect(after.status).toBe("done");
    expect(after.attempts).toBe(0); // 幂等收尾不算失败尝试
    expect(after.error_kind).toBeNull();
    expect(after.finished_at_utc).toBe(NOW);
  });

  it("done 与 already_done 收尾动作一致：同样两段边、同样不动 attempts", async () => {
    const doneId = enqueue().id;
    const alreadyId = enqueue(freshRevision()).id;
    const transition = vi.spyOn(store, "transition");
    await makeWorker(async () => ({ kind: "done" })).worker.tickOnce();
    const doneWalk = transition.mock.calls.map((call) => call[1]);
    transition.mockClear();
    await makeWorker(async () => ({ kind: "already_done" })).worker.tickOnce();
    expect(transition.mock.calls.map((call) => call[1])).toEqual(doneWalk);
    expect(rowOf(doneId).status).toBe("done");
    expect(rowOf(alreadyId).status).toBe("done");
    expect(rowOf(doneId).attempts).toBe(0);
    expect(rowOf(alreadyId).attempts).toBe(0);
  });
});

// ── G. 记录级推进（§一-3 末段）───────────────────────────────────────

describe("G. 记录级 processing_status：合法边才写，非法就跳过且其余不变", () => {
  it("合法边：job done ⇒ 记录 processing→parsed，且只动 processing_status 这一列", async () => {
    setRecordStatus(recordId, "processing"); // 夹具绕过状态机（理由见 setRecordStatus）
    expect(isStateTransitionAllowed("processing_status", "processing", "parsed")).toBe(true);
    const { id } = enqueue();
    const before = recordFullRow(recordId);

    await makeWorker(succeed).worker.tickOnce();

    expect(rowOf(id).status).toBe("done");
    expect(recordStatus(recordId)).toBe("parsed");
    // 只动这一列：其余字段逐字与推进前相同。
    expect({ ...recordFullRow(recordId), processing_status: before.processing_status }).toEqual(before);
  });

  it("非法边：记录停在 awaiting_privacy_review ⇒ 跳过写，任务侧动作一概照常", async () => {
    expect(recordStatus(recordId)).toBe("awaiting_privacy_review"); // cloud_redacted 的建记录初态
    expect(isStateTransitionAllowed("processing_status", "awaiting_privacy_review", "parsed")).toBe(false);
    const { id } = enqueue();
    const before = recordFullRow(recordId);

    await makeWorker(succeed).worker.tickOnce();

    const after = rowOf(id);
    expect(after.status).toBe("done"); // 不抛错、不把已定案的任务连带拖坏
    expect(after.finished_at_utc).toBe(NOW);
    expect(recordFullRow(recordId)).toEqual(before); // 记录那一格没动
  });

  it("canceled ⇒ 记录回 preprocessing（这一条是登记边，夹具无需绕状态机）", async () => {
    expect(isStateTransitionAllowed("processing_status", "awaiting_privacy_review", "preprocessing")).toBe(true);
    const { id } = enqueue();
    const fx = makeWorker(async (job) => {
      store.requestCancel(job.id);
      return { kind: "done" }; // 执行器不配合，靠 worker 检查点收尾
    });

    await fx.worker.tickOnce();

    expect(rowOf(id).status).toBe("canceled");
    expect(recordStatus(recordId)).toBe("preprocessing");
  });

  it("failed 要两拍才落定：记录级也跟着走两拍，每一拍都只在登记边上", async () => {
    const { id } = enqueue();
    expect(recordStatus(recordId)).toBe("awaiting_privacy_review"); // cloud_redacted 的建记录初态
    const fx = makeWorker(async () => ({ kind: "retryable", errorKind: "timeout" as const }));

    await fx.worker.tickOnce(); // 第一次失败：任务回 queued
    expect(rowOf(id).status).toBe("queued");
    expect(isStateTransitionAllowed("processing_status", "awaiting_privacy_review", "preprocessing")).toBe(true);
    expect(recordStatus(recordId)).toBe("preprocessing");

    await fx.worker.tickOnce(); // 第二次到上限：落 failed
    expect(rowOf(id).status).toBe("failed");
    expect(isStateTransitionAllowed("processing_status", "preprocessing", "failed")).toBe(true);
    expect(recordStatus(recordId)).toBe("failed");
  });

  it("落点判据逐字等于 enums 的合法边：八起点 × 五种收尾，每一拍合法就写、非法就跳，worker 不自创边", async () => {
    const outcomes: Array<{ label: string; results: JobExecutionResult[]; finalStatus: JobStatus }> = [
      { label: "done", results: [{ kind: "done" }], finalStatus: "done" },
      { label: "already_done", results: [{ kind: "already_done" }], finalStatus: "done" },
      {
        label: "failed（两次消耗）",
        results: [
          { kind: "retryable", errorKind: "timeout" },
          { kind: "retryable", errorKind: "timeout" },
        ],
        finalStatus: "failed",
      },
      { label: "canceled", results: [{ kind: "canceled" }], finalStatus: "canceled" },
      {
        label: "provider_unavailable（回 queued）",
        results: [{ kind: "provider_unavailable", errorKind: "provider_unavailable" }],
        finalStatus: "queued",
      },
    ];
    const recordStatuses = [
      "captured",
      "awaiting_privacy_review",
      "preprocessing",
      "processing",
      "parsed",
      "failed",
      "needs_reparse",
      "not_processed",
    ];

    for (const outcome of outcomes) {
      for (const from of recordStatuses) {
        // 每种收尾 × 每个起点各要一条自己的记录：同一条记录上比对不出「这一格是谁写的」。
        drainQueued(); // 先清场：见 drainQueued 的注释（矩阵跑在同一个库里）
        const created = records.createRecord(`${RAW}（矩阵 ${outcome.label} ${from}）`, "cloud_redacted");
        setRecordStatus(created.record.id, from);
        const { id } = enqueue(created.revision.id);
        expect(
          (db.prepare("select count(*) as n from privacy_job where status = 'queued'").get() as { n: number }).n,
        ).toBe(1); // 唯一候选：这一拍取的必须是自己

        const queue = [...outcome.results];
        const fx = makeWorker(async () => queue.shift() ?? { kind: "already_done" });
        // **逐拍**核对：记录级那一格每拍都跟着任务态走，所以下一拍的起点是上一拍的结果
        //（多拍的 failed 用例正是靠这一点：awaiting→preprocessing 合法、preprocessing→failed 合法）。
        let recordAt = from;
        for (let round = 0; round < outcome.results.length; round += 1) {
          await fx.worker.tickOnce();
          const statusNow = rowOf(id).status;
          const target = recordProcessingStatusForJobStatus(statusNow);
          const legal = isStateTransitionAllowed("processing_status", recordAt, target);
          recordAt = legal ? target : recordAt;
          expect(
            recordStatus(created.record.id),
            `${outcome.label} 第 ${round + 1} 拍 / 记录 ${statusNow} ⇒ ${target}（合法边=${legal}）`,
          ).toBe(recordAt);
        }

        expect(rowOf(id).status, `${outcome.label} ⇒ 任务终态`).toBe(outcome.finalStatus);
      }
    }
  });

  it("记录已被删除（FK CASCADE 连带删掉任务行）⇒ 收尾一步都不做，也不抛", async () => {
    const { id } = enqueue();
    const fx = makeWorker(async (job) => {
      db.exec("begin immediate");
      db.prepare("delete from capture_record where id = ?").run(job.record_id);
      db.exec("commit");
      expect(store.get(job.id)).toBeNull();
      return { kind: "done" };
    });
    await expect(fx.worker.tickOnce()).resolves.toBeUndefined();
    expect(store.get(id)).toBeNull();
    expect(db.prepare("select * from pragma_foreign_key_check").all()).toEqual([]);
  });
});

// ── H. 恢复与循环本身：recover / start / stop ─────────────────────────

describe("H. §四 启动恢复与定时器纪律", () => {
  it("recover() 只回收过期租约并返回其 id（默认阈值 = §九 建议的 10 分钟）", () => {
    expect(DEFAULT_LEASE_MS).toBe(TEN_MINUTES_MS);
    const aged = enqueue().id;
    store.transition(aged, "redacting");
    const fresh = enqueue(freshRevision()).id;
    store.transition(fresh, "redacting");
    store.transition(fresh, "analyzing");
    ageJob(aged, 11 * 60_000);
    ageJob(fresh, 2 * 60_000);

    const fx = makeWorker(succeed); // 不传 leaseMs ⇒ 用默认值
    expect(fx.worker.recover()).toEqual([aged]);
    expect(rowOf(aged)).toMatchObject({ status: "queued", attempts: 1, error_kind: "internal" });
    expect(rowOf(fresh).status).toBe("analyzing"); // 未过期就是「另一个实例正在跑」
  });

  it("start() 在第一次 tick 之前先 recover()（§四 启动恢复的唯一入口）", async () => {
    const reclaim = vi.spyOn(store, "reclaimExpiredLeases");
    const fx = makeWorker(succeed, { pollIntervalMs: 5 });
    fx.worker.start();
    expect(reclaim).toHaveBeenCalledTimes(1);
    expect(reclaim).toHaveBeenCalledWith(DEFAULT_LEASE_MS);
    await fx.worker.stop();
  });

  it("start() 传了 leaseMs 就按它回收（阈值可放宽，§九）", async () => {
    const reclaim = vi.spyOn(store, "reclaimExpiredLeases");
    const fx = makeWorker(succeed, { leaseMs: 30 * 60_000, pollIntervalMs: 5 });
    fx.worker.start();
    expect(reclaim).toHaveBeenCalledWith(30 * 60_000);
    await fx.worker.stop();
  });

  it("pollIntervalMs 驱动 tick；上一拍未完不重入；stop() 等在跑的 tick 收尾", async () => {
    const { id } = enqueue();
    const gate = deferredGate();
    const fx = makeWorker(async () => {
      await gate.wait;
      return { kind: "done" };
    }, { pollIntervalMs: 5 });

    fx.worker.start();
    await waitFor(() => fx.calls() >= 1, "第一次 tick 排起来");
    // 执行器还挂在 gate 上，这期间定时器又拍了好几次：串行闸门必须让它们全部跳过。
    await sleep(40);
    expect(fx.calls()).toBe(1);

    let stopped = false;
    const stopping = fx.worker.stop().then(() => {
      stopped = true;
    });
    await sleep(10);
    expect(stopped).toBe(false); // stop 不该抢在收尾之前返回

    gate.release();
    await stopping;
    expect(stopped).toBe(true);
    expect(rowOf(id).status).toBe("done"); // 收尾完整：stop 没有掐掉中途的写
    expect(fx.calls()).toBe(1);

    // 定时器已清：不再有新的 tick。
    await sleep(30);
    expect(fx.calls()).toBe(1);
  });

  it("默认节拍 2s：pollIntervalMs 与退避基数同量级（§五 退避靠它 + jobRetryBackoffMs）", () => {
    expect(DEFAULT_POLL_INTERVAL_MS).toBe(2_000);
  });

  it("模块头注写明了本批不做的三件事（路由 / 同步入口取消 / bootstrap 接线）", () => {
    const source = readFileSync("src/server/jobs/jobWorker.ts", "utf8");
    expect(source).toContain("不建 HTTP 面");
    expect(source).toContain("ingestRoutes");
    expect(source).toContain("bootstrap");
  });
});

// ── I. 隔离面与禁区 ─────────────────────────────────────────────────

describe("I. 禁区：不直接写 privacy_job、不碰别的表、不造新列", () => {
  const source = readFileSync("src/server/jobs/jobWorker.ts", "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");

  it("privacy_job 的写入只从 JobStore 走：源码里没有一条 update/insert/delete privacy_job", () => {
    expect(source).not.toMatch(/update\s+privacy_job/i);
    expect(source).not.toMatch(/insert\s+into\s+privacy_job/i);
    expect(source).not.toMatch(/delete\s+from\s+privacy_job/i);
    expect(source).not.toMatch(/insert\s+into/i);
    expect(source).not.toMatch(/delete\s+from/i);
  });

  it("唯一的记录级写入就是 processing_status 那一列，且只有一条语句", () => {
    const writes = source.match(/update\s+capture_record\s+set\s+processing_status\s*=\s*\?\s+where\s+id\s*=\s*\?/g) ?? [];
    expect(writes).toHaveLength(1);
    expect(source).not.toMatch(/update\s+capture_record\s+set\s+(?!processing_status)/i);
    expect(source).not.toMatch(/(update|insert\s+into|delete\s+from)\s+(record_revision|parse_run|episode|thought_item|concept|entity|suggestion)/i);
  });

  it("没有 HTTP 面、没有控制台输出、没有为退避造列", () => {
    expect(source).not.toMatch(/node:http|node:net|node:express|fetch\(/);
    expect(source).not.toMatch(/console\.|process\.stdout/);
    expect(source).not.toMatch(/next_attempt|scheduled_at|available_at|backoff_until/);
  });

  it("收尾只用 §三 那几条边：推进只有一个落点，目标态集合封闭", () => {
    // transition 只在 advance 里被调用两次：检查点改道那一条 + 正常推进那一条。
    expect([...source.matchAll(/this\.store\.transition\(/g)]).toHaveLength(2);
    const targets = [...source.matchAll(/this\.advance\([^,]+,\s*"(\w+)"/g)].map((found) => found[1]!);
    expect([...new Set(targets)].sort()).toEqual(["analyzing", "canceled", "done", "queued"]);
    // `failed` 只与 `queued` 成对出现在上限判据里，没有第三条边被顺手写出来。
    expect(source).toMatch(/exhausted \? "failed" : "queued"/);
  });
});
