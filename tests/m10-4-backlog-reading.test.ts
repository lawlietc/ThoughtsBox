/**
 * M10-4 专项测试：积压与重试读数 —— 执行准则 §七、裁决 M10-D-9 / D-10 / D-11 / D-12 / D-13。
 *
 * 这一批给复核队列添的是**一张表的说法**：预跑队列此刻在册哪几条、各自从什么时候开始等。
 * 断言因此围着五件事转：
 *  1. **读数不产生工作**（E1，最重要）：`pending > 0` 时连读端点（轮询走的就是同一条 GET）四张表
 *     整表逐字不变，本机模型一次都没被多问。与 C1 同一手法，只是这回表里**确实有东西在等**。
 *  2. **读数对得上队**（E2）：`snapshot().pending === size()`、`sinceByRevision` 的键数 `=== pending`
 *     在任何时刻都成立（含随机时序与「正在跑的那一条」），端点那格 `checkingSinceUtc` 就是表里那个
 *     时刻；跑完/被摘后不留幽灵行。起点在 `enqueue` 按下、重复保存即重置（M10-D-11）。
 *  3. **不谎报**（E3/E4，M10-D-9）：`hasPayload === false` 不等于「正在检查」——这一档没配好被静默
 *     跳过的那条，三格（在册时刻 / 载荷 / 失败标记）必须同时说「没算好、也没在跑」；问过的失败
 *     那条则由既有失败标记说。
 *  4. **文案同源**（E5，静态扫）：「本机正在检查」这句在 `src/web` 下只有 `redactionTier.ts` 一处实现，
 *     队列与单条两屏都调用它；重试按钮读 `LLM_PREVIEW_RETRY_LABEL`，且只画在 `local_llm` 的行上（D-12）。
 *  5. **不外扩**（E6/E7/E8）：不新增 `app_meta` 键前缀（N-5）、前端不 `fetch(`（轮询只重取，D-13）、
 *     响应里仍没有任何文本面，新增两格只有数与时刻（N-6）。
 *
 * 全程离线：库只落 `TB_DATA_DIR` 沙箱；本机模型一律假 fetch（挂起 / 回 500），不碰 socket。
 * 假端点读 `AbortSignal`：否则「永不回包」这一条钉子靠的是超时窗口没生效，而不是它在测的东西。
 */

import { createServer } from "node:net";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { Database } from "../src/server/db/adapter.ts";
import { migrate } from "../src/server/db/migrator.ts";
import { ensureConfigFile } from "../src/server/config/config.ts";
import type { DataLayout } from "../src/server/config/paths.ts";
import type { ModelAdapter } from "../src/server/ingest/provider.ts";
import { isLocalLlmRedactedTrack } from "../src/server/privacy/egressPreview.ts";
import { GrantService } from "../src/server/privacy/grantService.ts";
import { PrewarmQueue } from "../src/server/privacy/prewarmQueue.ts";
import { RecordService } from "../src/server/records/service.ts";
import { boot, shutdown, type BootResult } from "../src/server/runtime/bootstrap.ts";
import type { ReviewQueueEntryDto, ReviewQueueResponse } from "../src/shared/dto.ts";
import { OK_ENVELOPE, SYSTEM_PROMPT, makeAdapter, stubTransport, validOutput } from "./helpers/ingestFixtures.ts";
import { countRows, makeSandbox, openSandboxDb, type Sandbox } from "./helpers/sandbox.ts";

/* ── 夹具文本与词面（E8 的泄漏哨兵） ─────────────────────────────── */

const FIRST = "张三的电话是13800138000，他说蓝山咖啡馆见";
const SECOND = "另一条：邮箱 a@example.com，顺便聊聊《星海》";
const THIRD = "这一条走一遍就行，不用重跑";
const FACES = [FIRST, SECOND, THIRD, "张三", "13800138000", "蓝山咖啡馆", "a@example.com", "《星海》"];

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 等一个条件成立；超时即抛——**不许**用它把「还没跑完」读成「跑完了」。 */
async function until(condition: () => boolean, label: string, budgetMs = 8000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    if (condition()) return;
    if (Date.now() > deadline) throw new Error(`等待超时：${label}`);
    await sleep(5);
  }
}

/* ── 假端点：永不回包（读 `AbortSignal`）/ 直接回错码 ─────────────── */

interface FakeState {
  calls: number;
  /** 被 `signal` 掐断的次数：>0 才证明「这条真的挂在请求上」，而不是端点压根没被叫到。 */
  aborts: number;
}

function abortAwareSleep(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    timer.unref?.();
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * 「挂起」= 除了被 `requestTimeoutMs` 掐断，永不返回。这一档要测的是「用户已经等了 N 秒」这一格
 * 读数，而它只在请求**还在路上**时才存在；一个会立刻回包的假端点测不到它。
 */
function hangingFetch(): { fetchImpl: typeof fetch; state: FakeState } {
  const state: FakeState = { calls: 0, aborts: 0 };
  const impl = async (_input: unknown, init?: RequestInit): Promise<Response> => {
    state.calls += 1;
    try {
      await abortAwareSleep(10 * 60 * 1000, init?.signal);
      return { status: 200, text: () => Promise.resolve("{}") } as unknown as Response;
    } catch (cause) {
      state.aborts += 1;
      throw cause;
    }
  };
  return { fetchImpl: impl as unknown as typeof fetch, state };
}

function localAdapter(overrides: Partial<ModelAdapter> = {}): ModelAdapter {
  return {
    provider: "ollama",
    model: "qwen3:8b",
    baseUrl: "http://127.0.0.1:11434/v1",
    callPath: "ollama_openai_compatible",
    supportsStructuredOutput: false,
    requestTimeoutMs: 300,
    ...overrides,
  };
}

/* ── 单元夹具：直连队列（E2 的表自洽要在随机时序上对账，不必起 HTTP 面） ── */

function makeUnitBox(): { box: Sandbox; db: Database; records: RecordService; grants: GrantService } {
  const box = makeSandbox("tb-m10-4-unit-");
  const db = openSandboxDb(box.layout);
  migrate(db);
  const records = new RecordService(db, { timezoneId: "Asia/Shanghai", now: () => new Date("2026-10-30T01:00:00.000Z") });
  const grants = new GrantService(db, { now: () => new Date("2026-10-30T01:00:00.000Z") });
  return { box, db, records, grants };
}

/** 与 `bootstrap.ts` 同源的装配：判据只有一条，不在这里自己判第二遍。 */
function makeUnitQueue(
  deps: { records: RecordService; grants: GrantService },
  fetchImpl: typeof fetch,
  overrides: { delayMs?: number; requestTimeoutMs?: number } = {},
): PrewarmQueue {
  return new PrewarmQueue({
    getGrants: () => deps.grants,
    resolveAdapter: () => localAdapter({ requestTimeoutMs: overrides.requestTimeoutMs ?? 300 }),
    isWanted: (revisionId) => {
      const axes = deps.records.axesOfRevision(revisionId);
      return axes !== null && isLocalLlmRedactedTrack(axes);
    },
    fetchImpl,
    ...(overrides.delayMs === undefined ? {} : { delayMs: overrides.delayMs }),
  });
}

function saveLlmRevision(records: RecordService, text: string): { recordId: string; revisionId: string } {
  const created = records.createRecord(text, "cloud_redacted");
  records.setRedactionMode(created.record.id, "local_llm");
  return { recordId: created.record.id, revisionId: created.revision.id };
}

/* ── 端到端夹具（真 HTTP 面 + 假本机模型，照 m10-1 / m10-2 的手法） ── */

const FAKE_LLM_MARK = "127.0.0.1:14557";
const QUEUE_PATH = "/api/ingest/review-queue";

interface Instance {
  readonly booted: BootResult;
  readonly box: Sandbox;
  readonly base: string;
  readonly db: Database;
  readonly stub: ReturnType<typeof stubTransport>;
}

const liveInstances: Instance[] = [];
const unitBoxes: { box: Sandbox; db: Database }[] = [];
let restoreFetch: (() => void) | null = null;

/** 只截假端点，其余（测试自己打本机 HTTP 面的请求）原样转给真 fetch。 */
function installFakeLlm(behaviour: { kind: "hang" } | { kind: "status"; status: number }): FakeState {
  const state: FakeState = { calls: 0, aborts: 0 };
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    if (!String(input).includes(FAKE_LLM_MARK)) {
      return (real as (a: unknown, b?: RequestInit) => Promise<Response>)(input, init);
    }
    state.calls += 1;
    if (behaviour.kind === "hang") {
      try {
        await abortAwareSleep(10 * 60 * 1000, init?.signal);
      } catch (cause) {
        state.aborts += 1;
        throw cause;
      }
      return { status: 200, text: () => Promise.resolve("{}") } as unknown as Response;
    }
    return {
      status: behaviour.status,
      text: () => Promise.resolve(JSON.stringify({ error: { message: "upstream busy" } })),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  restoreFetch = () => {
    globalThis.fetch = real;
    restoreFetch = null;
  };
  return state;
}

afterEach(async () => {
  restoreFetch?.();
  restoreFetch = null;
  while (liveInstances.length > 0) {
    const inst = liveInstances.pop()!;
    await shutdown(inst.booted);
    inst.box.cleanup();
  }
  while (unitBoxes.length > 0) {
    const held = unitBoxes.pop()!;
    held.db.close();
    held.box.cleanup();
  }
});

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (address === null || typeof address === "string") {
        reject(new Error("无法取得空闲端口"));
        return;
      }
      probe.close(() => resolve(address.port));
    });
  });
}

/**
 * `localLlm` 传 `null` = 配置里**不写**这一档：预跑队列拿到的适配器恒为 null（E3 要的就是这个
 * 形状，同时少一个假端点就少一处「测试自己骗自己说没发请求」）。
 */
function writeConfig(layout: DataLayout, port: number, localLlm: Record<string, unknown> | null): void {
  mkdirSync(layout.dataDir, { recursive: true });
  const file = ensureConfigFile(layout);
  const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  (raw.server as Record<string, unknown>).port = port;
  (raw.model as Record<string, unknown>).enabled = false;
  (raw.model as Record<string, unknown>).cloud_redacted_enabled = true;
  if (localLlm !== null) (raw.model as Record<string, unknown>).local_llm = localLlm;
  writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
}

async function startInstance(localLlm: Record<string, unknown> | null): Promise<Instance> {
  const box = makeSandbox("tb-m10-4-e2e-");
  const port = await freePort();
  writeConfig(box.layout, port, localLlm);
  const stub = stubTransport(OK_ENVELOPE(validOutput()));
  let booted: BootResult;
  try {
    booted = await boot({
      env: { TB_DATA_DIR: box.root, USERPROFILE: box.root, HOME: box.root },
      log: () => {},
      startJobsWorker: false,
      ingestProvider: { adapter: makeAdapter(), transport: stub.transport, systemPrompt: SYSTEM_PROMPT },
    });
  } catch (cause) {
    box.cleanup();
    throw cause;
  }
  const inst: Instance = { booted, box, base: `http://127.0.0.1:${port}`, db: booted.db, stub };
  liveInstances.push(inst);
  return inst;
}

const HANGING_PROFILE = {
  enabled: true,
  provider: "ollama",
  base_url: `http://${FAKE_LLM_MARK}/v1`,
  // 窗口取配置允许的最小值：`drain()` 之后这一拍必然被掐断，幽灵行那一条断言才不是在测运气。
  request_timeout_ms: 1000,
  model: "qwen3:8b",
};

interface ApiResult {
  status: number;
  json: ReviewQueueResponse;
  text: string;
}

async function getQueue(inst: Instance): Promise<ApiResult> {
  const res = await fetch(`${inst.base}${QUEUE_PATH}`);
  const text = await res.text();
  return { status: res.status, json: JSON.parse(text) as ReviewQueueResponse, text };
}

function entryOf(result: ApiResult, recordId: string): ReviewQueueEntryDto {
  const found = result.json.entries.find((entry) => entry.recordId === recordId);
  if (found === undefined) throw new Error(`队列里没有记录 ${recordId}`);
  return found;
}

/** 四张表的整表快照（与 C1 同一口径：行数与内容逐字）。 */
const SNAPSHOT_TABLES = ["capture_record", "record_revision", "cloud_send_grant", "app_meta"] as const;

function snapshot(db: Database): Record<string, string> {
  const out: Record<string, string> = {};
  for (const table of SNAPSHOT_TABLES) {
    out[table] = JSON.stringify(db.prepare(`select * from ${table} order by rowid`).all() as unknown[]);
  }
  return out;
}

/**
 * 摆一条「正在被本机检查」的记录：走**当前实例自己的** `workspace.records`（保存回调就接在这一份上），
 * 于是入队是真的从保存路径进来的，不是测试替队列排的。
 */
async function saveWantedRevision(inst: Instance, text: string): Promise<{ recordId: string; revisionId: string }> {
  const { records } = inst.booted.workspace;
  const created = records.createRecord(text, "cloud_redacted");
  records.setRedactionMode(created.record.id, "local_llm");
  const edited = records.editRecord(created.record.id, `${text}（改过一笔）`);
  return { recordId: created.record.id, revisionId: edited.revision.id };
}

/* ══════════════════════════════════════════════════════════════════
 * E1 读数不产生工作
 * ══════════════════════════════════════════════════════════════════ */

describe("M10-4 · E1 有积压时读数仍然只读", () => {
  it("pending > 0 时连读五次（轮询走的就是这一条 GET）⇒ 四张表逐字不变，模型一次都没被多问", async () => {
    const spy = installFakeLlm({ kind: "hang" });
    const inst = await startInstance(HANGING_PROFILE);
    const { recordId } = await saveWantedRevision(inst, FIRST);

    const queue = inst.booted.prewarm;
    expect(queue.snapshot().pending, "夹具没把东西排进去，后面全是空断言").toBeGreaterThanOrEqual(1);

    const tablesBefore = snapshot(inst.db);
    const callsBefore = spy.calls;
    const stubBefore = inst.stub.callCount();

    let last: ApiResult | null = null;
    for (let round = 0; round < 5; round += 1) {
      last = await getQueue(inst);
      expect(last.status).toBe(200);
      expect(last.json.entries.length).toBeGreaterThan(0);
    }

    expect(snapshot(inst.db), "读数一旦去「补算一次」，写的就是用户没看过的那份载荷").toEqual(tablesBefore);
    expect(spy.calls, "看一眼队列不等于排一次预跑：本机模型没被多问一次").toBe(callsBefore);
    expect(inst.stub.callCount(), "读数不叫 Provider，也不排任何外发").toBe(stubBefore);
    // 两次读必须给回同一份东西，且说的就是那条在等的记录。
    expect(last?.json).not.toBeNull();
    expect(entryOf(last!, recordId).checkingSinceUtc, "在册 ⇒ 这一格有时刻").toBeTypeOf("string");
    expect(last!.json.prewarm).toEqual({ pending: queue.snapshot().pending });
  });

  it("读数不碰任何标记：预跑在册时 `preview_*` 键集合与读数前逐字相同", async () => {
    installFakeLlm({ kind: "hang" });
    const inst = await startInstance(HANGING_PROFILE);
    const readKeys = (): unknown[] =>
      inst.db.prepare("select key from app_meta where key like 'preview_%' order by key").all();
    const before = readKeys();
    await getQueue(inst);
    await getQueue(inst);
    expect(readKeys()).toEqual(before);
    expect(before, "这套夹具本来就没算过任何一条（否则空集合等于没断言）").toEqual([]);
  });
});

/* ══════════════════════════════════════════════════════════════════
 * E2 读数对得上队
 * ══════════════════════════════════════════════════════════════════ */

describe("M10-4 · E2 `pending` 与在册表在任何时刻都自洽", () => {
  it("随机时序反复入队：`pending === size()`、键数 === pending，跑完一张都不剩（无幽灵行）", async () => {
    const unit = makeUnitBox();
    unitBoxes.push(unit);
    const revisions = [FIRST, SECOND, THIRD].map((text) => saveLlmRevision(unit.records, text).revisionId);
    const spy = hangingFetch();
    const queue = makeUnitQueue(unit, spy.fetchImpl, { delayMs: 3, requestTimeoutMs: 120 });
    const startedAt = Date.now();
    let sawBacklog = 0;
    let sawInFlight = false;

    for (let round = 0; round < 40; round += 1) {
      queue.enqueue(revisions[round % revisions.length]!);
      await sleep(Math.floor(Math.random() * 6));
      const snap = queue.snapshot();
      expect(snap.pending, "两处读数不是同一份事实").toBe(queue.size());
      expect(snap.sinceByRevision.size, "键集合与 pending 是同一件事的两个说法").toBe(snap.pending);
      for (const [revisionId, sinceMs] of snap.sinceByRevision) {
        expect(revisions, `表里出现了没入过队的 revisionId`).toContain(revisionId);
        expect(sinceMs, "入队时刻不能来自未来").toBeLessThanOrEqual(Date.now());
        expect(sinceMs, "入队时刻早于本用例开始").toBeGreaterThanOrEqual(startedAt);
      }
      sawBacklog = Math.max(sawBacklog, snap.pending);
      if (spy.state.calls > 0 && snap.pending > 0) sawInFlight = true;
    }

    expect(sawBacklog, "整轮都没排上过东西 = 这条用例在测空表").toBeGreaterThan(0);
    expect(spy.state.calls, "假端点一次都没被叫到 = 串行跑体没跑起来").toBeGreaterThan(0);
    await queue.drain();
    const after = queue.snapshot();
    expect(after.pending).toBe(0);
    expect([...after.sinceByRevision.keys()], "跑完还留在表里 = 一条永远「已等」的幽灵行").toEqual([]);
    // 前提钉住：这三条都是 `(cloud, local_llm, redacted)` ⇒ 跑体真的去问了模型；
    // 假端点一直挂着 ⇒ PD-2 下这些拍记 `failed`（不再是「回落也算 ran」）。
    expect(queue.stats()).toMatchObject({ skipped: 0 });
    expect(queue.stats().failed).toBeGreaterThan(0);
    expect(sawInFlight).toBe(true);
  });

  it("正在跑的那一条也算在册；被掐断跑完之后即从表里摘掉", async () => {
    const unit = makeUnitBox();
    unitBoxes.push(unit);
    const { revisionId } = saveLlmRevision(unit.records, FIRST);
    const spy = hangingFetch();
    const queue = makeUnitQueue(unit, spy.fetchImpl, { delayMs: 0, requestTimeoutMs: 200 });

    queue.enqueue(revisionId);
    await until(() => spy.state.calls === 1, "请求没进来，测不到「在跑的那条也在表里」");
    const mid = queue.snapshot();
    expect(mid.pending).toBe(1);
    expect([...mid.sinceByRevision.keys()]).toEqual([revisionId]);
    expect(mid.pending, "在跑的这一条同样算积压").toBe(queue.size());

    await queue.drain();
    expect(spy.state.aborts, "请求没被掐断 = 这一拍压根没在等").toBe(1);
    expect(queue.snapshot().pending).toBe(0);
    expect([...queue.snapshot().sinceByRevision.keys()]).toEqual([]);
  });

  it("等待的起点 = 入队这一刻；同一版再保存一次即重置（M10-D-11）", async () => {
    const unit = makeUnitBox();
    unitBoxes.push(unit);
    const { revisionId } = saveLlmRevision(unit.records, FIRST);
    const spy = hangingFetch();
    // 窗口长到本次跑不完：这一条钉的是那张表的起点，不是防抖本身（防抖归 B1）。
    const queue = makeUnitQueue(unit, spy.fetchImpl, { delayMs: 600_000 });

    const firstSave = Date.now();
    queue.enqueue(revisionId);
    expect(queue.snapshot().sinceByRevision.get(revisionId), "起点在 `enqueue` 里按下").toBeGreaterThanOrEqual(firstSave);
    const firstSince = queue.snapshot().sinceByRevision.get(revisionId)!;

    await sleep(30);
    const secondSave = Date.now();
    queue.enqueue(revisionId);
    const secondSince = queue.snapshot().sinceByRevision.get(revisionId)!;
    expect(secondSince, "重复保存不重置起点 = 报的是上一次编辑的等待").toBeGreaterThanOrEqual(secondSave);
    expect(secondSince).toBeGreaterThan(firstSince);
    expect(queue.snapshot().pending, "重置不是排第二条").toBe(1);
    expect(spy.state.calls, "还在窗口里就不该去问模型").toBe(0);
  });

  it("端点那格 `checkingSinceUtc` 就是队列表里那个时刻（同一次 `snapshot()`）", async () => {
    const spy = installFakeLlm({ kind: "hang" });
    const inst = await startInstance(HANGING_PROFILE);
    const { recordId, revisionId } = await saveWantedRevision(inst, FIRST);

    const snap = inst.booted.prewarm.snapshot();
    const result = await getQueue(inst);
    const entry = entryOf(result, recordId);
    expect(entry.currentRevisionId).toBe(revisionId);
    expect(entry.checkingSinceUtc, "在册 ⇒ 有时刻").toBe(new Date(snap.sinceByRevision.get(revisionId)!).toISOString());
    expect(result.json.prewarm.pending).toBe(snap.pending);

    await inst.booted.prewarm.drain();
    expect(spy.aborts, "请求没被掐断 = 这一拍压根没在等").toBeGreaterThanOrEqual(1);
    const drained = await getQueue(inst);
    expect(drained.json.prewarm.pending).toBe(0);
    expect(entryOf(drained, recordId).checkingSinceUtc, "跑完之后这一格即归零（幽灵行就没了）").toBeNull();
  });
});

/* ══════════════════════════════════════════════════════════════════
 * E3 跳过的不假装
 * ══════════════════════════════════════════════════════════════════ */

describe("M10-4 · E3 这一档没配好 ⇒ 没算好、也没在跑（M10-D-9）", () => {
  it("适配器取不到：跑完之后三格同时说「什么都没有」，而不是被读成正在检查", async () => {
    const inst = await startInstance(null);
    const { recordId } = await saveWantedRevision(inst, FIRST);

    await inst.booted.prewarm.drain();
    const stats = inst.booted.prewarm.stats();
    expect(stats.skipped, "这一条没走到跑体，下面三格等于在测空队列").toBeGreaterThanOrEqual(1);
    expect(stats.ran, "适配器取不到却报「跑成了」").toBe(0);

    const result = await getQueue(inst);
    const entry = entryOf(result, recordId);
    expect(inst.booted.prewarm.snapshot().pending).toBe(0);
    expect(entry.checkingSinceUtc, "静默跳过的不能被写成还在检查").toBeNull();
    expect(entry.hasPayload).toBe(false);
    expect(entry.llm.failureKind, "根本没问过模型 ⇒ 不该有失败标记").toBeNull();
    expect(entry.llm.used).toBe(false);
    expect(result.json.prewarm).toEqual({ pending: 0 });
  });
});

/* ══════════════════════════════════════════════════════════════════
 * E4 失败的
 * ══════════════════════════════════════════════════════════════════ */

describe("M10-4 · E4 模型没跑成 ⇒ 由既有失败标记说，且没有任何待发送载荷", () => {
  it("假端点回 500：不在册、无载荷、失败标记在册、没人点过头", async () => {
    const spy = installFakeLlm({ kind: "status", status: 500 });
    const inst = await startInstance(HANGING_PROFILE);
    const { recordId } = await saveWantedRevision(inst, FIRST);

    await inst.booted.prewarm.drain();
    // 这条记录有两个版本（建版时还是手动档、换档后编辑了一笔），`isWanted` 读的是**记录**的轴，
    // 所以两版都会走跑体：次数只钉「真的问过」，不钉恰好几次。
    expect(spy.calls, "假端点一次都没被叫到 = 下面那枚失败标记是别处写的").toBeGreaterThan(0);

    const result = await getQueue(inst);
    const entry = entryOf(result, recordId);
    expect(inst.booted.prewarm.snapshot().pending).toBe(0);
    expect(entry.checkingSinceUtc, "跑完就是跑完：这一格不该还写着在等").toBeNull();
    // PD-2：失败即阻断，不再算一份回落载荷。hasPayload=false 与「失败标记在册」同时成立。
    expect(entry.hasPayload, "模型没跑成 ⇒ 没有任何可签发的待发送文本").toBe(false);
    expect(entry.llm.failureKind, "封闭的失败种类必须如实在册").toBe("http");
    expect(entry.llm.used).toBe(false);
    expect(entry.hasGrant).toBe(false);
    expect(countRows(inst.db, "cloud_send_grant"), "读数与预跑都不签发授权").toBe(0);
  });
});

/* ══════════════════════════════════════════════════════════════════
 * E6 不新增键前缀（N-5）
 * ══════════════════════════════════════════════════════════════════ */

describe("M10-4 · E6 读数与积压登记都不写 `app_meta`", () => {
  /** 键前缀 = 第一枚 `:` 之前那段；没有冒号的键整名即前缀。 */
  const prefixOf = (key: string): string => {
    const colon = key.indexOf(":");
    return colon < 0 ? key : key.slice(0, colon);
  };
  const SIX = [
    "preview_v2_payload",
    "preview_v2_nonce",
    "preview_llm_v2_payload",
    "preview_llm_v2_spans",
    "preview_llm_v2_nonce",
    "preview_llm_v2_failed",
  ];

  it("跑完前后新增的键前缀 ⊆ 既有六枚；读数这一拍一枚都不新增", async () => {
    installFakeLlm({ kind: "status", status: 500 });
    const inst = await startInstance(HANGING_PROFILE);
    const keys = (): string[] => (inst.db.prepare("select key from app_meta order by key").all() as { key: string }[]).map((row) => row.key);
    const baseline = new Set(keys());

    const { recordId } = await saveWantedRevision(inst, FIRST);
    await getQueue(inst);
    await getQueue(inst);
    expect(keys(), "读数这一拍一枚键都不写").toEqual([...baseline].sort());

    await inst.booted.prewarm.drain();
    const added = keys().filter((key) => !baseline.has(key));
    expect(added.length, "跑成一拍却不落任何键 = 这条断言在空转").toBeGreaterThan(0);
    for (const key of added) {
      expect(SIX, `出现了新的键前缀「${prefixOf(key)}」`).toContain(prefixOf(key));
    }
    // 键名不许携带文本本体（N-6）。
    for (const key of keys()) {
      for (const face of FACES) expect(key, `键名里出现了词面「${face}」`).not.toContain(face);
    }
    expect(entryOf(await getQueue(inst), recordId).llm.failureKind).toBe("http");
  });
});

/* ══════════════════════════════════════════════════════════════════
 * E8 形状
 * ══════════════════════════════════════════════════════════════════ */

describe("M10-4 · E8 并进的那两格只有数与时刻", () => {
  it("响应里仍无原文 / `surface` / 载荷文本；`prewarm` 只有 `pending`，时刻是 ISO", async () => {
    installFakeLlm({ kind: "hang" });
    const inst = await startInstance(HANGING_PROFILE);
    await saveWantedRevision(inst, FIRST);
    const result = await getQueue(inst);

    for (const face of FACES) {
      expect(result.text, `响应里出现了夹具文本 ${face}`).not.toContain(face);
    }
    expect(result.text).not.toContain("surface");
    expect(result.text).not.toContain("redactedText");
    expect(result.text).not.toContain("payloadText");
    expect(result.text).not.toMatch(/"payload[A-Za-z]*"\s*:\s*"/);

    expect(Object.keys(result.json).sort()).toEqual(["entries", "prewarm", "total"]);
    expect(Object.keys(result.json.prewarm)).toEqual(["pending"]);
    expect(result.json.prewarm.pending).toBeTypeOf("number");
    for (const entry of result.json.entries) {
      expect(Object.keys(entry).sort()).toContain("checkingSinceUtc");
      if (entry.checkingSinceUtc === null) continue;
      expect(entry.checkingSinceUtc, "时刻只有 ISO 串这一种形状").toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(Number.isFinite(Date.parse(entry.checkingSinceUtc))).toBe(true);
    }
  });

  /**
   * 队列缺席时读数一律是 `pending: 0` + `checkingSinceUtc: null`（M10-D-10）。生产路径恒有队列，
   * 走不到这一支；会走到的是「手搓 `ServerFacts` 的夹具」与前端那份假数据。这一支的意义在于
   * **它不能被读成「本机没有在检查的任何东西」**——所以钉法是：可选声明 + `?.` 取数 + 假数据同源。
   */
  it("队列缺席 ⇒ 读数是 0 / null，且这一支在源码里就只写成缺席", () => {
    const http = stripComments(readFileSync(new URL("../src/server/api/httpServer.ts", import.meta.url), "utf8"));
    const routes = stripComments(readFileSync(new URL("../src/server/api/ingestRoutes.ts", import.meta.url), "utf8"));
    const fake = stripComments(readFileSync(new URL("../src/web/fakeApi.ts", import.meta.url), "utf8"));
    expect(http).toMatch(/readonly prewarm\?: PrewarmQueue;/);
    expect(routes).toContain("const backlog = facts.prewarm?.snapshot() ?? null;");
    expect(routes).toContain("backlog?.sinceByRevision.get(row.current_revision_id) ?? null");
    expect(routes).toContain("prewarm: { pending: backlog?.pending ?? 0 }");
    expect(fake).toContain("prewarm: { pending: 0 }");
    expect(fake).toContain("checkingSinceUtc: null");
    // 一次请求只取一次：取两次就是「同一份响应里两处读数不是同一刻」。
    expect([...routes.matchAll(/\.snapshot\(\)/g)]).toHaveLength(1);
  });
});

/* ══════════════════════════════════════════════════════════════════
 * E5 / E7 前端（源码级静态扫）
 * ══════════════════════════════════════════════════════════════════ */

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const WEB_DIR = fileURLToPath(new URL("../src/web/", import.meta.url));

function webSources(): { name: string; code: string }[] {
  return readdirSync(WEB_DIR)
    .filter((name) => /\.tsx?$/.test(name))
    .map((name) => ({ name, code: stripComments(readFileSync(join(WEB_DIR, name), "utf8")) }));
}

describe("M10-4 · E5 等待文案与重试按钮同源（静态扫）", () => {
  const sources = webSources();
  const tier = readFileSync(new URL("../src/web/redactionTier.ts", import.meta.url), "utf8");
  const panel = stripComments(readFileSync(new URL("../src/web/IngestPanel.tsx", import.meta.url), "utf8"));
  const inbox = stripComments(readFileSync(new URL("../src/web/inbox.ts", import.meta.url), "utf8"));
  const section = /function InboxSection[\s\S]*?\n}/.exec(panel)?.[0] ?? "";

  it("「本机正在检查」这句措辞在 `src/web` 下只有 `redactionTier.ts` 一处，别处一次都不出现", () => {
    const hits = sources.filter((file) => file.code.includes("本机正在检查"));
    expect(hits.map((file) => file.name), "第二处实现 = 第二套说法（准则 §七）").toEqual(["redactionTier.ts"]);
    for (const file of sources.filter((row) => row.name !== "redactionTier.ts")) {
      expect(file.code, `${file.name} 里手写了这句文案`).not.toMatch(/["`『]本机正在检查/);
    }
    // 那一处里两句各一次：单条那句与队列那句共用同一段建议。
    const only = hits[0]!;
    expect([...only.code.matchAll(/本机正在检查/g)]).toHaveLength(2);
  });

  it("单条那句只在预览里、队列那句只在收件箱顶；建议段 `LLM_CHECKING_ADVICE` 只定义一次", () => {
    expect(section, "InboxSection 本体要被断言到").not.toBe("");
    // D-1 之后列表行不再有逐行计时：单条那句只剩 CloudGate 里那一处。
    expect([...panel.matchAll(/llmCheckingText\(/g)]).toHaveLength(1);
    expect([...tier.matchAll(/const LLM_CHECKING_ADVICE =/g)]).toHaveLength(1);
    // 2026-11-06：队列顶那句只报条数，不再复用这段建议，故只剩「定义 + 单条那句一次」= 2。
    expect([...tier.matchAll(/LLM_CHECKING_ADVICE/g)]).toHaveLength(2);
    expect(tier).toContain("export function prewarmPendingText(pending: number): string");
    expect([...panel.matchAll(/prewarmPendingText\(/g)]).toHaveLength(1);
    expect(section).toContain("prewarmPendingText(props.prewarm.pending)");
  });

  it("「重跑脱敏」按钮读 `LLM_PREVIEW_RETRY_LABEL`：文案字面量只在常量一处", () => {
    const dialog = readFileSync(new URL("../src/web/ui/SendReviewDialog.tsx", import.meta.url), "utf8");
    expect([...panel.matchAll(/重跑脱敏/g)]).toHaveLength(0);
    expect([...section.matchAll(/LLM_PREVIEW_RETRY_LABEL/g)]).toHaveLength(0);
    expect(dialog).toContain("LLM_PREVIEW_RETRY_LABEL");
    expect(tier).toMatch(/export const LLM_PREVIEW_RETRY_LABEL = "重跑脱敏"/);
  });

  it("重试从列表行搬进脱敏核对弹窗：判据仍在纯模块，接线只在非原文轨", () => {
    // 判据仍来自纯模块：`retryable` 直接用服务端派生的 `nextAction === "retry"`。
    expect(inbox).toContain('retryable: entry.nextAction === "retry"');
    expect(inbox).toContain('case "retry":');
    // 列表行不再画这颗按钮（D-7）。
    expect([...section.matchAll(/LLM_PREVIEW_RETRY_LABEL/g)]).toHaveLength(0);
    // 接线在面板：只有非原文轨才把 `onRetryRedaction` 递给弹窗。
    expect(panel).toContain("onRetryRedaction={");
    expect(panel).toMatch(/track !== "raw"\s*\?\s*\(\) => void retryLocalLlm\(selected\.recordId\)/);
  });

  it("等待读数走既有那枚计时 hook，不新写第二个（M10-D-13 的「每秒推进」仍是同一处）", () => {
    const timers = sources.filter((file) => file.code.includes("setInterval")).map((file) => file.name).sort();
    expect(timers, "新的计时 hook 就是第二套读数").toEqual(["IngestPanel.tsx", "useElapsedSeconds.ts"]);
    // 逐行计时已随 D-1 删除：`useElapsedSeconds` 现在只剩 CloudGate 那一处。
    expect([...panel.matchAll(/useElapsedSeconds\(/g)]).toHaveLength(1);
    expect(panel).toContain("useElapsedSeconds(props.previewPendingSince)");
  });

  /**
   * 讲「这句为什么必须这么说」的那一段，记的是 `llmCheckingText` 这条纪律本身，不是它下面那半句
   * 话的常量。挂错符号之后，下一个读的人以为这段在解释常量，而真正用着它、最需要这段理由的那个
   * 函数落了个空说明——于是下一次改动可以安心把那句话改掉（M10-4b）。
   */
  it("那段「为什么」挂在 `llmCheckingText` 正上方，不在常量头上", () => {
    expect([...tier.matchAll(/等本机模型检查时那句/g)]).toHaveLength(1);

    const fnAt = tier.indexOf("export function llmCheckingText(");
    expect(fnAt, "定位不到那个函数的定义").toBeGreaterThanOrEqual(0);
    const docAt = tier.lastIndexOf("/**", fnAt);
    expect(docAt, "定义上方要有说明块").toBeGreaterThanOrEqual(0);
    const headLine = (tier.slice(docAt, fnAt).split(/\r?\n/)[1] ?? "").replace(/^[\s*]+/, "");
    expect(headLine, "正上方那一段就是讲等待那句的「为什么」").toMatch(/^等本机模型检查时/);
    expect(tier.slice(tier.indexOf("*/", docAt) + 2, fnAt).trim(), "块尾与定义之间只隔空行").toBe("");

    const constAt = tier.indexOf("const LLM_CHECKING_ADVICE");
    expect(constAt, "常量的定义要被定位到").toBeGreaterThanOrEqual(0);
    expect(tier.slice(tier.lastIndexOf("/**", constAt), constAt)).not.toContain("等本机模型检查时那句");
    expect(docAt).toBeGreaterThan(constAt);
  });
});

describe("M10-4 · E7 前端不 fetch，轮询只重取", () => {
  const panel = stripComments(readFileSync(new URL("../src/web/IngestPanel.tsx", import.meta.url), "utf8"));
  const section = /function InboxSection[\s\S]*?\n}/.exec(panel)?.[0] ?? "";
  const batch = stripComments(readFileSync(new URL("../src/web/reviewBatch.ts", import.meta.url), "utf8"));
  const retry = /async function retryLocalLlm[\s\S]*?\n  \}/.exec(panel)?.[0] ?? "";

  it("间隔常量住在纯模块里，面板只 import 它：5 秒这一档只有一处定义", () => {
    expect([...batch.matchAll(/export const REVIEW_QUEUE_POLL_MS =/g)]).toHaveLength(1);
    expect(batch).toMatch(/export const REVIEW_QUEUE_POLL_MS = 5_000;/);
    expect([...panel.matchAll(/REVIEW_QUEUE_POLL_MS/g)]).toHaveLength(2);
    expect(panel).toContain('REVIEW_QUEUE_POLL_MS,');
    expect(panel).toContain('} from "./reviewBatch.ts";');
    // 纯模块那一侧不许出现计时器：间隔是数据，取数与计时都归界面。
    expect(batch).not.toContain("setInterval");
  });

  it("有得等才轮询，归零即清、卸载也清；这一拍只叫 `onReload`，不自己取数", () => {
    expect(section).toContain("if (props.prewarm.pending <= 0) return;");
    expect(section).toContain("const timer = setInterval(() => props.onReload(), REVIEW_QUEUE_POLL_MS);");
    expect(section).toContain("return () => clearInterval(timer);");
    expect(section).toContain("}, [props.prewarm.pending, props.onReload]);");
    expect([...section.matchAll(/setInterval/g)]).toHaveLength(1);
    // 轮询与按钮都不碰取数面：`api.` 与 `fetch(` 都不该出现在这个小节里。
    expect(section).not.toMatch(/\bapi\./);
    expect(panel).not.toContain("fetch(");
    // 传下去的必须是那个稳定身份：内联箭头会让计时器每次渲染都重来一遍。
    expect(panel).toContain("onReload={reload}");
  });

  it("重试只在面板那一层走既有的预览通道：起点按在 `api.ingestPreview(` 之前，收口仍是 `action()` 那一处", () => {
    expect(retry, "retryLocalLlm 本体要被断言到").not.toBe("");
    expect([...panel.matchAll(/setPreviewStartedAt\(null\)/g)]).toHaveLength(1);
    expect(retry).toContain("setPreviewStartedAt(Date.now());");
    expect(retry.indexOf("setPreviewStartedAt(Date.now());")).toBeLessThan(retry.indexOf("await api.ingestPreview("));
    expect(retry).toContain("await reload();");
    // 〔web-redesign 第三步〕预览写回多了一道代次条件（`seq === previewSeq.current`）：
    // 「进屏自动取预览」与「确认后重取」可能并存，先发的响应后到会覆盖新状态。
    // 这里钉的仍然是原来那一条判据（只写回当前选中那一条），换成子串以容纳前置的代次比较。
    expect(retry).toContain("recordId === selected?.recordId) setPreview(next);");
    // 全页只有既有那一条确认通道，重试不是第二个签发口。
    expect([...panel.matchAll(/api\.ingestConfirmSend/g)]).toHaveLength(1);
  });

  /**
   * `running` 只反映批量确认的进度，所以等模型的那一段时间里那颗按钮原本是能连点的：点两下就是
   * 两次模型请求，第二次排进预跑队列再问一遍——正是裁决 M10-D-7 要防的形态（等的凭据是用户那一下
   * 点击，不是屏幕自己数到的秒数）。
   */
  it("重跑脱敏在等待期间禁用两颗键：防连点（M10-D-7）随按钮搬进弹窗", () => {
    const dialog = stripComments(
      readFileSync(new URL("../src/web/ui/SendReviewDialog.tsx", import.meta.url), "utf8"),
    );
    expect(dialog).toContain("disabled={props.busy || props.retrying === true}");
    // 面板的 `retryLocalLlm` 仍在 `action()` 里跑，忙态由它统一收口。
    expect(panel).toContain("async function retryLocalLlm(recordId: string)");
  });
});
