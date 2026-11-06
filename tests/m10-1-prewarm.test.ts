/**
 * M10-1 专项测试：预跑（保存之后在本机把脱敏结果先算好）——执行准则 §四、裁决 M10-D-1…D-7。
 *
 * 这一批只挪「算」的时机，不挪「发哪一份」。断言因此围着四件事转：
 *  1. **同源**（B3，最重要）：预跑落下的那份载荷与用户点预览现算的那份**逐字相同**，第二次一个
 *     请求都不发。M10-D-6 要求跑体只走 `resolveLocalLlmPreview` 这一个入口——这条断言就是那个
 *     裁决的落地证明：入口一分岔，两份文本必然漂移。
 *  2. **判据只有档位**（B4/B5/B8）：`(cloud, local_llm, redacted)` 之外一律零请求；非回环一律
 *     零请求；记录被删 / 被改档一律静默跳过。
 *  3. **不越界**（B6/B7/B9）：不签发授权、失败不降级、不改三轴与 `processing_status`。
 *  4. **保存面不被拖累**（B10/B11/B12）：回调缺席 ⇒ 与今天逐字相同；回调抛 ⇒ 保存照样成功；
 *     先提交后回调 ⇒ 回调里读到的必须是刚写的那一版。
 *
 * 全程离线：数据库只落 `TB_DATA_DIR` 沙箱；本地模型一律假 fetch，不碰 socket。
 * B3 里有一条走真 HTTP 面（建记录 → 改档 → 编辑 → `POST /api/ingest/preview`），钉的是**接线本身**：
 * 队列与路由用的是同一个适配器读数手法，而 `preview_llm_v2_payload:<rev>` 这一枚键就是用户在浏览器里
 * 点预览时端出去的那一串。
 */

import { createServer } from "node:net";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import type { Database } from "../src/server/db/adapter.ts";
import { migrate } from "../src/server/db/migrator.ts";
import { ensureConfigFile } from "../src/server/config/config.ts";
import type { DataLayout } from "../src/server/config/paths.ts";
import type { ModelAdapter } from "../src/server/ingest/provider.ts";
import { isLocalLlmRedactedTrack } from "../src/server/privacy/egressPreview.ts";
import { resolveEgressPreview } from "../src/server/privacy/localLlmPreview.ts";
import {
  CloudSendAuthorizationRequiredError,
  GrantService,
  LOCAL_LLM_FAILURE_KINDS,
} from "../src/server/privacy/grantService.ts";
import {
  DEFAULT_PREWARM_DEBOUNCE_MS,
  PrewarmQueue,
  PREWARM_OUTCOMES,
} from "../src/server/privacy/prewarmQueue.ts";
import { LOCAL_LLM_POLICY_VERSION, sha256OfText } from "../src/server/privacy/redaction.ts";
import { RecordService } from "../src/server/records/service.ts";
import { boot, shutdown, type BootResult } from "../src/server/runtime/bootstrap.ts";
import { Workspace } from "../src/server/runtime/workspace.ts";
import type { ThreeAxes } from "../src/shared/contracts/enums.ts";
import {
  OK_ENVELOPE,
  SYSTEM_PROMPT,
  makeAdapter,
  stubTransport,
  validOutput,
  type StubTransport,
} from "./helpers/ingestFixtures.ts";
import { countRows, makeSandbox, openSandboxDb, type Sandbox } from "./helpers/sandbox.ts";

/* ── 夹具文本与词面 ────────────────────────────────────────────────── */

/** 规则（手机号）与实体记忆（张三）之外，只有本地模型会遮的两处：咖啡馆与作品名。 */
const RAW = "周末和张三去了蓝山咖啡馆，电话 13800138000，聊聊《星海》";
const ZHANG = "张三";
const PHONE = "13800138000";
const CAFE = "蓝山咖啡馆";
const WORK = "《星海》";
/** 泄漏扫描的词面清单（叶子级）：原文本体 + 每一个被遮住的词面。 */
const FACES = [RAW, ZHANG, PHONE, CAFE, WORK];

const at = (term: string): number => {
  const index = RAW.indexOf(term);
  if (index < 0) throw new Error(`夹具文本里没有 ${term}`);
  return index;
};

/** 假本地模型的回稿：坐标锚定 `RAW` 的 UTF-16 偏移。 */
function candidatesBody(): string {
  const content = JSON.stringify({
    candidates: [
      { start: at(CAFE), end: at(CAFE) + CAFE.length, kind: "place", surface: CAFE },
      { start: at(WORK), end: at(WORK) + WORK.length, kind: "work", surface: WORK },
    ],
  });
  return JSON.stringify({ choices: [{ message: { content } }] });
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 主推的那一档（矩阵 #8）的三轴——`resolveEgressPreview` 的入参，也是 `isWanted` 的判据对象。 */
const LLM_AXES: ThreeAxes = { analysisProvider: "cloud", redactionMode: "local_llm", sendContentMode: "redacted" };

const LLM_PAYLOAD_KEY = (revisionId: string): string => `preview_llm_v2_payload:${revisionId}`;
const LLM_SPANS_KEY = (revisionId: string): string => `preview_llm_v2_spans:${revisionId}`;
const LLM_NONCE_KEY = (revisionId: string): string => `preview_llm_v2_nonce:${revisionId}`;
const LLM_FAILED_KEY = (revisionId: string): string => `preview_llm_v2_failed:${revisionId}`;

/* ── 假端点（计数 / 在途并发 / 可回 5xx / 可挂起） ─────────────────── */

interface FakeState {
  calls: number;
  inFlight: number;
  maxInFlight: number;
  bodies: string[];
  /** 被 `signal` 掐断的请求数：>0 才证明走的真是「按下超时窗口」这条路，而不是「慢一点回包」。 */
  aborts: number;
}

/**
 * 真 fetch 在 `signal` 被按下时**立刻拒**，这是 `makeSendWithGuards` 能把失败分类成
 * `timeout` / `cancelled` 的唯一前提（provider.ts:449 那段 catch 靠异常进来）。假端点要是只顾
 * 睡完再回 200，`requestTimeoutMs: 1` 那条守卫按下 abort 也没人理睬，超时这条路根本走不通——
 * 于是 B7 看到的不是「超时没落标记」，而是「压根没超时」。
 */
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

function fakeFetch(options: { status?: number; body?: string; delayMs?: number } = {}): {
  fetchImpl: typeof fetch;
  state: FakeState;
} {
  const state: FakeState = { calls: 0, inFlight: 0, maxInFlight: 0, bodies: [], aborts: 0 };
  const status = options.status ?? 200;
  const body = options.body ?? candidatesBody();
  const delayMs = options.delayMs ?? 0;
  const impl = async (_input: unknown, init?: RequestInit): Promise<Response> => {
    state.calls += 1;
    state.inFlight += 1;
    state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
    if (typeof init?.body === "string") state.bodies.push(init.body);
    try {
      if (delayMs > 0) await abortAwareSleep(delayMs, init?.signal);
      return { status, text: () => Promise.resolve(body) } as unknown as Response;
    } catch (cause) {
      state.aborts += 1;
      throw cause;
    } finally {
      state.inFlight -= 1;
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
    requestTimeoutMs: 1000,
    ...overrides,
  };
}

/* ── 沙箱与三轴夹具 ───────────────────────────────────────────────── */

let sandbox: Sandbox | undefined;
let db: Database | undefined;
let schemaVersion = 0;
let records: RecordService;
let grants: GrantService;

function setup(): void {
  sandbox = makeSandbox("tb-m10-1-");
  db = openSandboxDb(sandbox.layout);
  schemaVersion = migrate(db).schemaVersion;
  records = new RecordService(db, {
    timezoneId: "Asia/Shanghai",
    now: () => new Date("2026-10-30T01:00:00.000Z"),
  });
  grants = new GrantService(db, { now: () => new Date("2026-10-30T01:00:00.000Z") });
}

afterEach(() => {
  uninstallFakeLocalLlm();
  while (liveInstances.length > 0) {
    const inst = liveInstances.pop()!;
    void shutdown(inst.booted).then(() => inst.box.cleanup());
  }
  db?.close();
  sandbox?.cleanup();
  db = undefined;
  sandbox = undefined;
});

/**
 * 建一条记录并（按需）把脱敏档改成 `local_llm`。走**服务层自己的** `setRedactionMode`：
 * 这一档在 M9-4d-2 起有正式的改档入口，夹具不该另抄一份裸 SQL 的轴列写法。
 */
function saveRecord(text: string, mode: string, redactionMode?: string): { recordId: string; revisionId: string } {
  const created = records.createRecord(text, mode);
  if (redactionMode !== undefined) records.setRedactionMode(created.record.id, redactionMode);
  return { recordId: created.record.id, revisionId: created.revision.id };
}

function saveLlmRecord(text: string = RAW): { recordId: string; revisionId: string } {
  return saveRecord(text, "cloud_redacted", "local_llm");
}

/**
 * 与 `bootstrap.ts` 同源的队列装配。判据只有一条，写在这里而不是各条用例现编——
 * 「测试自己判一遍」正是 B4 最容易假过去的形状（数组为空是因为压根没跑，而不是因为档位不对）。
 */
function makeQueue(
  fetchImpl: typeof fetch,
  overrides: { delayMs?: number; adapter?: ModelAdapter | null } = {},
): PrewarmQueue {
  const adapter = overrides.adapter === undefined ? localAdapter() : overrides.adapter;
  return new PrewarmQueue({
    getGrants: () => grants,
    resolveAdapter: () => adapter,
    isWanted: (revisionId) => {
      const axes = records.axesOfRevision(revisionId);
      return axes !== null && isLocalLlmRedactedTrack(axes);
    },
    fetchImpl,
    ...(overrides.delayMs === undefined ? {} : { delayMs: overrides.delayMs }),
  });
}

/* ── app_meta / 事实表读数 ───────────────────────────────────────── */

function metaRows(): { key: string; value: string }[] {
  return db!.prepare("select key, value from app_meta order by key").all() as { key: string; value: string }[];
}

/**
 * `app_meta` 里**没有任何一处断言该拿空表当基线**：迁移本身就在表里写下水位键
 * （`migration_0008_three_axis_backfill`）。所以「这一拍队列没写键」的正确说法是
 * **入队前的全表逐字快照 == 跑完后的全表**——不是 `toEqual([])`，也不是排除 `migration_*`
 * 之后比较（那样将来任何一处顺手写一枚新键都拦得住不住）。
 */
function expectMetaUnchanged(before: { key: string; value: string }[], label?: string): void {
  expect(metaRows(), label ?? "app_meta 整表逐字不变").toEqual(before);
}

/** 键前缀 = 第一枚 `:` 之前那段；`migration_x` 这种没有冒号的键整名即前缀。 */
function keyPrefix(key: string): string {
  const colon = key.indexOf(":");
  return colon < 0 ? key : key.slice(0, colon);
}

function metaValue(key: string): string | undefined {
  const row = db!.prepare("select value from app_meta where key = ?").get(key) as { value: string } | undefined;
  return row?.value;
}

/** 逐字快照：三轴 + 派生读数 + 状态 + 当前版本指针。 */
function axesSnapshot(recordId: string): Record<string, unknown> {
  return db!
    .prepare(
      `select analysis_provider, redaction_mode, send_content_mode, processing_mode,
              processing_status, current_revision_id, privacy_level
         from capture_record where id = ?`,
    )
    .get(recordId) as Record<string, unknown>;
}

function revisionSnapshot(revisionId: string): unknown {
  return db!
    .prepare("select id, record_id, revision_number, raw_text, content_sha256 from record_revision where id = ?")
    .get(revisionId);
}

function collectStrings(value: unknown, into: string[]): string[] {
  if (typeof value === "string") {
    into.push(value);
    return into;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, into);
    return into;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      into.push(key);
      collectStrings(child, into);
    }
  }
  return into;
}

/** 一片扫描面上的每个叶子字段都不许含原文与词面（N-6）。 */
function assertNoRawFace(leaves: string[], surface: string): void {
  for (const leaf of leaves) {
    for (const face of FACES) {
      expect(leaf, `「${surface}」的叶子字段里出现了词面「${face}」`).not.toContain(face);
    }
  }
}

function describeForScan(arg: unknown): string {
  if (typeof arg === "string") return arg;
  try {
    return JSON.stringify(arg) ?? String(arg);
  } catch {
    return String(arg);
  }
}

type LogSink = (...args: unknown[]) => void;

/**
 * 把 console 的五个出口临时接进 `into`，返回还原函数。
 * 预跑路径今天一行日志都不写，接采集器是为了「将来谁加日志就自动进扫描面」。
 */
function captureConsoleLog(into: string[]): () => void {
  const sinks = console as unknown as Record<string, LogSink>;
  const originals = new Map<string, LogSink>();
  for (const level of ["log", "info", "warn", "error", "debug"]) {
    const original = sinks[level]!;
    originals.set(level, original);
    sinks[level] = (...args: unknown[]) => {
      into.push(args.map(describeForScan).join(" "));
      original.apply(console, args);
    };
  }
  return () => {
    for (const [level, original] of originals) sinks[level] = original;
  };
}

/**
 * 预跑这一拍**唯一允许**出现在 `app_meta` 里的新键前缀（N-5：不新增键前缀）。
 * `preview_llm_failed` 也在册：模型没跑成时那是既有装配层落的既有标记。
 */
const PREWARM_ALLOWED_NEW_PREFIXES = [
  "preview_llm_v2_payload",
  "preview_llm_v2_spans",
  "preview_llm_v2_nonce",
  "preview_llm_v2_failed",
] as const;

/* ══════════════════════════════════════════════════════════════════
 * B1 幂等与防抖（M10-D-1）
 * ══════════════════════════════════════════════════════════════════ */

describe("B1 同一 revision 连续入队只保留最后一次", () => {
  it("缺省窗口 3 秒；三次入队 ⇒ 模型只被问一次", async () => {
    setup();
    const { revisionId } = saveLlmRecord();
    const spy = fakeFetch();
    const queue = makeQueue(spy.fetchImpl);
    expect(DEFAULT_PREWARM_DEBOUNCE_MS).toBe(3000);
    expect(queue.stats()).toEqual({ ran: 0, skipped: 0, failed: 0, last: null });

    queue.enqueue(revisionId);
    queue.enqueue(revisionId);
    queue.enqueue(revisionId);
    expect(queue.size(), "三次入队在同一条队列里只占一个位置").toBe(1);

    await queue.drain();
    expect(spy.state.calls).toBe(1);
    expect(queue.size()).toBe(0);
    expect(queue.stats()).toMatchObject({ ran: 1, skipped: 0, failed: 0 });
    expect(queue.stats().last).toEqual({ revisionId, outcome: "ran" });
    expect(PREWARM_OUTCOMES).toEqual(["ran", "skipped", "failed"]);
  });

  it("窗口内再次入队**重置**计时器，而不是排第二次", async () => {
    setup();
    const { revisionId } = saveLlmRecord();
    const spy = fakeFetch();
    const queue = makeQueue(spy.fetchImpl, { delayMs: 60 });

    // 每 25ms 保存一次，始终没跨过 60ms 的窗口 ⇒ 一次都不该跑。
    queue.enqueue(revisionId);
    await sleep(25);
    queue.enqueue(revisionId);
    await sleep(25);
    queue.enqueue(revisionId);
    await sleep(25);
    expect(spy.state.calls, "还在窗口内就跑 = 防抖没起作用").toBe(0);

    // 停手超过窗口 ⇒ 只补算最后一次。
    await sleep(80);
    expect(spy.state.calls).toBe(1);
    await queue.drain();
    expect(spy.state.calls).toBe(1);
  });

  it("不同 revision 各自排队：两条 = 两次，不互相吞掉", async () => {
    setup();
    const first = saveLlmRecord(RAW);
    const second = saveLlmRecord(`另一条记录：${CAFE} 与 ${WORK}`);
    const spy = fakeFetch();
    const queue = makeQueue(spy.fetchImpl, { delayMs: 0 });

    queue.enqueue(first.revisionId);
    queue.enqueue(second.revisionId);
    expect(queue.size()).toBe(2);
    await queue.drain();
    expect(spy.state.calls).toBe(2);
  });
});

/* ══════════════════════════════════════════════════════════════════
 * B2 串行（M10-D-5）
 * ══════════════════════════════════════════════════════════════════ */

describe("B2 同时最多一条在跑", () => {
  it("两条 revision 一起入队 ⇒ 在途计数最大值恰为 1", async () => {
    setup();
    const a = saveLlmRecord(RAW);
    const b = saveLlmRecord(`另一句：${PHONE} 也在这条里`);
    const spy = fakeFetch({ delayMs: 20 });
    const queue = makeQueue(spy.fetchImpl, { delayMs: 0 });

    queue.enqueue(a.revisionId);
    queue.enqueue(b.revisionId);
    await queue.drain();

    expect(spy.state.calls).toBe(2);
    expect(spy.state.maxInFlight, "并发只会把本机模型打成两份都更慢").toBe(1);
    // 串行不是「只跑第一条」：两条各落自己那三键。
    for (const revisionId of [a.revisionId, b.revisionId]) {
      expect(metaValue(LLM_PAYLOAD_KEY(revisionId)), revisionId).toBeTypeOf("string");
      expect(metaValue(LLM_SPANS_KEY(revisionId)), revisionId).toBeTypeOf("string");
    }
  });

  it("跑的过程中新保存一条：排在后面，不打断在跑的", async () => {
    setup();
    const a = saveLlmRecord(RAW);
    const b = saveLlmRecord(`另一句：${CAFE}`);
    const spy = fakeFetch({ delayMs: 20 });
    const queue = makeQueue(spy.fetchImpl, { delayMs: 0 });

    queue.enqueue(a.revisionId);
    await sleep(5); // a 已在跑
    queue.enqueue(b.revisionId);
    await queue.drain();

    expect(spy.state.calls).toBe(2);
    expect(spy.state.maxInFlight).toBe(1);
  });
});

/* ══════════════════════════════════════════════════════════════════
 * B3 逐字同源（最重要）
 * ══════════════════════════════════════════════════════════════════ */

describe("B3 预跑落下的载荷 = 用户点预览时端出去的那一份", () => {
  it("服务层：预跑之后走 op6 同一个装配入口 ⇒ 逐字相同、哈希相同、第二次零请求", async () => {
    setup();
    const { revisionId } = saveLlmRecord();
    const prewarmSpy = fakeFetch();
    const queue = makeQueue(prewarmSpy.fetchImpl, { delayMs: 0 });
    queue.enqueue(revisionId);
    await queue.drain();
    expect(prewarmSpy.state.calls).toBe(1);

    const landed = metaValue(LLM_PAYLOAD_KEY(revisionId));
    expect(landed, "预跑必须把本档载荷落进既有那枚键").toBeTypeOf("string");

    // 用户点预览：op6 走 `resolveEgressPreview`（档位判据住在它里面）。
    const clickSpy = fakeFetch();
    const preview = await resolveEgressPreview(grants, localAdapter(), revisionId, LLM_AXES, {
      fetchImpl: clickSpy.fetchImpl,
    });

    expect(clickSpy.state.calls, "命中缓存就一个请求都不发（M10-D-6 的全部意义）").toBe(0);
    expect(preview.payloadText).toBe(landed);
    expect(preview.payloadSha256).toBe(sha256OfText(landed!));
    expect(preview.policyVersion).toBe(LOCAL_LLM_POLICY_VERSION);
    expect(preview.llmLayer).toMatchObject({ used: true, candidates: 1 });
    // 载荷确实是「遮过」的那一份：模型遮掉的 place 词面不在里面。
    expect(preview.payloadText).not.toContain(CAFE);
    // 《星海》是 work，按 Phase A 的三类裁决不再遮；这里不再断言它消失。
  });

  it("端到端（真 HTTP 面 + 真接线）：保存触发预跑，随后 op6 秒出且逐字相同", async () => {
    const spy = installFakeLocalLlm();
    const inst = await startInstance(llmProfile());

    // ① 建记录（这一版落库时脱敏档还是 `manual`）⇒ 队列收到它，但档位判据不成立：零请求。
    const created = await call(inst, "POST", "/api/records", { text: `${RAW}。`, processing_mode: "cloud_redacted" });
    expect(created.status).toBe(201);
    const recordId = created.json.record.id as string;
    // A-0 起新建即 local_llm；这一段要演的是「先 manual（不预跑）→ 再切 local_llm」，先显式落回 manual。
    const manual = await call(inst, "PATCH", `/api/records/${recordId}/redaction-mode`, { redaction_mode: "manual" });
    expect(manual.status).toBe(200);
    expect(inst.booted.prewarm.size(), "保存后队列里必须已有这一版在等防抖").toBe(1);
    await inst.booted.prewarm.drain();
    expect(spy.calls, "档位不是 local_llm ⇒ 预跑静默跳过，一次都不问").toBe(0);

    // ② 用户把这条记录的脱敏档改成「本地模型辅助」（M9-4d-2 的正式入口，不建新版）。
    const tier = await call(inst, "PATCH", `/api/records/${recordId}/redaction-mode`, { redaction_mode: "local_llm" });
    expect(tier.status).toBe(200);

    // ③ 用户再改一次文本 ⇒ 新版本 ⇒ 保存后预跑真的去问本机模型。
    const edited = await call(inst, "PUT", `/api/records/${recordId}`, { text: RAW });
    expect(edited.status).toBe(200);
    const revisionId = edited.json.revision.id as string;
    await inst.booted.prewarm.drain();
    expect(spy.calls, "local_llm 档的新版本 ⇒ 预跑问一次").toBe(1);

    const landed = metaValueOf(inst, LLM_PAYLOAD_KEY(revisionId));
    expect(landed, "预跑落的正是既有那枚键").toBeTypeOf("string");

    // ④ 用户点预览：走真路由、零新请求，端出来的与 ③ 落下的逐字相同。
    const preview = await call(inst, "POST", "/api/ingest/preview", { recordId });
    expect(preview.status).toBe(200);
    expect(spy.calls, "命中缓存：点预览不再等本机模型").toBe(1);
    expect(preview.json.payloadText).toBe(landed);
    expect(preview.json.policyVersion).toBe(LOCAL_LLM_POLICY_VERSION);
    expect(preview.json.llmLayer).toMatchObject({ used: true, candidates: 1 });
    expect(preview.json.payloadSha256).toBe(sha256OfText(landed!));
    expect(preview.json.redactedText).not.toContain(CAFE);
    // 队列不签授权：预跑跑完之后 `cloud_send_grant` 仍是零行。
    expect(countRows(inst.booted.db, "cloud_send_grant")).toBe(0);
    // 原文进了本机模型（回环之内），没进别处。
    expect(spy.bodies[0]).toContain(RAW);
  });
});

/* ══════════════════════════════════════════════════════════════════
 * B4 判据只有档位（M10-D-2）
 * ══════════════════════════════════════════════════════════════════ */

describe("B4 只有 (cloud, local_llm, redacted) 才预跑", () => {
  const NOT_WANTED: readonly { label: string; mode: string; redactionMode?: string }[] = [
    { label: "manual 档（脱敏轨）", mode: "cloud_redacted", redactionMode: "manual" },
    { label: "none 档（原文外发轨）", mode: "cloud_raw" },
    { label: "manual_only（不外发）", mode: "manual_only" },
    { label: "local_model（本地分析）", mode: "local_model" },
  ];

  for (const testCase of NOT_WANTED) {
    it(`${testCase.label} ⇒ 入队了也零请求、零缓存键`, async () => {
      setup();
      const { revisionId } = saveRecord(RAW, testCase.mode, testCase.redactionMode);
      const metaBefore = metaRows();
      const spy = fakeFetch();
      const queue = makeQueue(spy.fetchImpl, { delayMs: 0 });
      queue.enqueue(revisionId);
      await queue.drain();

      expect(spy.state.calls, testCase.label).toBe(0);
      expect(queue.stats(), testCase.label).toMatchObject({ ran: 0, skipped: 1, failed: 0 });
      // 队列从不写预览缓存 ⇒ 入队前后 `app_meta` 整表逐字相同（N-5：不新增键前缀）。
      expectMetaUnchanged(metaBefore, testCase.label);
    });
  }

  it("`local_llm` + `raw` 轨的组合不成立：改档入口先拦住，轮不到队列去猜", () => {
    setup();
    const { recordId } = saveRecord(RAW, "cloud_raw");
    expect(() => records.setRedactionMode(recordId, "local_llm")).toThrow();
    expect(records.axesOfRevision(records.getRecord(recordId).record.current_revision_id)).toEqual<ThreeAxes>({
      analysisProvider: "cloud",
      redactionMode: "none",
      sendContentMode: "raw",
    });
  });

  it("axesOfRevision 只读：跑完一趟，事实表计数一张都不动", async () => {
    setup();
    const { revisionId } = saveLlmRecord();
    const before = {
      record: countRows(db!, "capture_record"),
      revision: countRows(db!, "record_revision"),
      grant: countRows(db!, "cloud_send_grant"),
      job: countRows(db!, "privacy_job"),
    };
    expect(records.axesOfRevision(revisionId)).toEqual<ThreeAxes>(LLM_AXES);

    const spy = fakeFetch();
    const queue = makeQueue(spy.fetchImpl, { delayMs: 0 });
    queue.enqueue(revisionId);
    await queue.drain();
    expect(spy.state.calls).toBe(1);

    expect({
      record: countRows(db!, "capture_record"),
      revision: countRows(db!, "record_revision"),
      grant: countRows(db!, "cloud_send_grant"),
      job: countRows(db!, "privacy_job"),
    }).toEqual(before);
    expect(records.axesOfRevision("rr_never_existed")).toBeNull();
  });
});

/* ══════════════════════════════════════════════════════════════════
 * B5 非回环 / 档位没配好（N-4）
 * ══════════════════════════════════════════════════════════════════ */

describe("B5 端点不是回环 ⇒ 一次请求都不发", () => {
  it("非回环适配器：spy 计数为 0，失败面由既有装配层如实落下", async () => {
    setup();
    const { revisionId } = saveLlmRecord();
    const spy = fakeFetch();
    const queue = makeQueue(spy.fetchImpl, {
      delayMs: 0,
      adapter: localAdapter({ baseUrl: "http://192.168.1.9:11434/v1" }),
    });
    queue.enqueue(revisionId);
    await queue.drain();

    expect(spy.state.calls).toBe(0);
    // 跑体只有 `resolveLocalLlmPreview` 一个入口（M10-D-6）：这一档的可用性不由队列另判一遍，
    // 所以留下的说法与「用户点预览时没跑成」逐字同一枚键、同一个封闭取值。
    expect(metaValue(LLM_FAILED_KEY(revisionId))).toBe("not_loopback");
    expect(metaValue(LLM_PAYLOAD_KEY(revisionId))).toBeUndefined();
  });

  it("适配器取不到（这一档根本没配）⇒ 跳过，零请求、零标记", async () => {
    setup();
    const { revisionId } = saveLlmRecord();
    const metaBefore = metaRows();
    const spy = fakeFetch();
    const queue = makeQueue(spy.fetchImpl, { delayMs: 0, adapter: null });
    queue.enqueue(revisionId);
    await queue.drain();

    expect(spy.state.calls).toBe(0);
    expect(queue.stats()).toMatchObject({ ran: 0, skipped: 1, failed: 0 });
    expectMetaUnchanged(metaBefore);
  });
});

/* ══════════════════════════════════════════════════════════════════
 * B6 不写授权（N-1 / N-2）
 * ══════════════════════════════════════════════════════════════════ */

describe("B6 预跑不签发授权：cloud_send_grant 逐字不动，闸门照旧抛", () => {
  it("跑前跑后行数与内容相同；requireApplicableGrant 仍抛 CloudSendAuthorizationRequiredError", async () => {
    setup();
    const { revisionId } = saveLlmRecord();
    const rowsBefore = db!.prepare("select * from cloud_send_grant order by id").all();
    expect(rowsBefore).toEqual([]);

    const spy = fakeFetch();
    const queue = makeQueue(spy.fetchImpl, { delayMs: 0 });
    queue.enqueue(revisionId);
    await queue.drain();
    expect(spy.state.calls).toBe(1);

    const preview = await resolveEgressPreview(grants, localAdapter(), revisionId, LLM_AXES, {
      fetchImpl: fakeFetch().fetchImpl,
    });
    expect(db!.prepare("select * from cloud_send_grant order by id").all()).toEqual(rowsBefore);
    expect(countRows(db!, "cloud_send_grant")).toBe(0);
    expect(() =>
      grants.requireApplicableGrant(revisionId, preview.payloadSha256, preview.policyVersion, "redacted"),
    ).toThrow(CloudSendAuthorizationRequiredError);
    // 算好了 ≠ 批准了：用户那一下确认仍是唯一签发口。
    expect(grants.grantForPreview(preview)).toBeNull();
  });
});

/* ══════════════════════════════════════════════════════════════════
 * B7 失败不降级（N-3 / M9-D-13 / M10-D-7）
 * ══════════════════════════════════════════════════════════════════ */

describe("B7 本机模型没跑成 ⇒ 只落既有失败标记", () => {
  it("假端点回 500：failed 标记是封闭枚举值，本档载荷 / 区间 / nonce 都不被写", async () => {
    setup();
    const { revisionId } = saveLlmRecord();
    const spy = fakeFetch({ status: 500, body: JSON.stringify({ error: { message: "upstream busy" } }) });
    const queue = makeQueue(spy.fetchImpl, { delayMs: 0 });
    queue.enqueue(revisionId);
    await queue.drain();

    expect(spy.state.calls).toBe(1);
    const failureKind = metaValue(LLM_FAILED_KEY(revisionId));
    expect(failureKind, "失败标记必须在册，否则 op7 拿不到用户看过的回落那份").toBeDefined();
    expect(LOCAL_LLM_FAILURE_KINDS).toContain(failureKind!);
    expect(failureKind).toBe("http");
    // 本档那三键一枚都不写：没有「算出但没采信」的载荷，也就没有任何可签发的东西。
    expect(metaValue(LLM_PAYLOAD_KEY(revisionId))).toBeUndefined();
    expect(metaValue(LLM_SPANS_KEY(revisionId))).toBeUndefined();
    expect(metaValue(LLM_NONCE_KEY(revisionId))).toBeUndefined();
    expect(countRows(db!, "cloud_send_grant")).toBe(0);
    // 队列这一侧记 failed：装配入口抛了（PD-2 阻断），模型没跑成由上面那枚既有标记说。
    expect(queue.stats()).toMatchObject({ ran: 0, failed: 1 });
  });

  it("超时：一次就是那一次，不自动重试（M10-D-7）", async () => {
    setup();
    const { revisionId } = saveLlmRecord();
    const spy = fakeFetch({ delayMs: 40 });
    const queue = makeQueue(spy.fetchImpl, { delayMs: 0 });
    // 超时由 provider 的守卫按下：把适配器的窗口压到 1ms。
    const tight = new PrewarmQueue({
      getGrants: () => grants,
      resolveAdapter: () => localAdapter({ requestTimeoutMs: 1 }),
      isWanted: (id) => {
        const axes = records.axesOfRevision(id);
        return axes !== null && isLocalLlmRedactedTrack(axes);
      },
      fetchImpl: spy.fetchImpl,
      delayMs: 0,
    });
    expect(queue.size()).toBe(0);
    tight.enqueue(revisionId);
    await tight.drain();

    expect(spy.state.calls).toBe(1);
    // 前提本身也要钉住：这一次请求是被 `requestTimeoutMs` 掐断的（假端点认 signal），
    // 否则下面那枚 `timeout` 标记只是碰巧由别的东西写出来的。
    expect(spy.state.aborts, "端点没被掐断 = 这条用例压根没在测超时").toBe(1);
    expect(metaValue(LLM_FAILED_KEY(revisionId))).toBe("timeout");
    expect(metaValue(LLM_PAYLOAD_KEY(revisionId))).toBeUndefined();
    // 不自动重试（M10-D-7）：超时之后这一版既没有载荷，也没有第二拍。
    expect(tight.stats()).toMatchObject({ ran: 0, failed: 1 });
    expect(spy.state.calls, "超时之后再问一次就是自动重试").toBe(1);
  });

  it("装配入口抛出 ⇒ 就地吞掉，只记 failed 计数，不冒泡、不重试", async () => {
    setup();
    const { revisionId } = saveLlmRecord();
    const spy = fakeFetch();
    const broken = new PrewarmQueue({
      getGrants: () => {
        throw new Error("装配面抛");
      },
      resolveAdapter: () => localAdapter(),
      isWanted: () => true,
      fetchImpl: spy.fetchImpl,
      delayMs: 0,
    });
    broken.enqueue(revisionId);
    await broken.drain();

    expect(spy.state.calls).toBe(0);
    expect(broken.stats()).toMatchObject({ ran: 0, skipped: 0, failed: 1 });
    expect(broken.stats().last).toEqual({ revisionId, outcome: "failed" });
    expect(broken.size()).toBe(0);
  });
});

/* ══════════════════════════════════════════════════════════════════
 * B8 记录被删 / 被改档
 * ══════════════════════════════════════════════════════════════════ */

describe("B8 入队后意图变了 ⇒ 跑前核对失败，静默跳过、零请求、不抛", () => {
  it("删记录 ⇒ axesOfRevision 返回 null ⇒ skipped，且没写回任何键", async () => {
    setup();
    const { recordId, revisionId } = saveLlmRecord();
    const spy = fakeFetch();
    const queue = makeQueue(spy.fetchImpl, { delayMs: 10 });

    queue.enqueue(revisionId);
    records.deleteRecord(recordId);
    await queue.drain();

    expect(spy.state.calls).toBe(0);
    expect(queue.stats()).toMatchObject({ ran: 0, skipped: 1, failed: 0 });
    expect(records.axesOfRevision(revisionId)).toBeNull();
    // 删除路径自己已连那六键一起清掉（K-09），队列这一拍没写回任何东西。
    expect(metaRows().filter((row) => row.key.startsWith("preview_"))).toEqual([]);
  });

  it("改成别的脱敏档 ⇒ 同样静默跳过", async () => {
    setup();
    const { recordId, revisionId } = saveLlmRecord();
    const metaBefore = metaRows();
    const spy = fakeFetch();
    const queue = makeQueue(spy.fetchImpl, { delayMs: 10 });

    queue.enqueue(revisionId);
    records.setRedactionMode(recordId, "manual");
    await queue.drain();

    expect(spy.state.calls).toBe(0);
    expect(queue.stats()).toMatchObject({ skipped: 1, failed: 0 });
    expectMetaUnchanged(metaBefore);
  });
});

/* ══════════════════════════════════════════════════════════════════
 * B9 不改轴 / 不外泄
 * ══════════════════════════════════════════════════════════════════ */

describe("B9 预跑不改三轴 / processing_mode / processing_status（N-7）", () => {
  it("跑前跑后逐字相同", async () => {
    setup();
    const { recordId, revisionId } = saveLlmRecord();
    const recordBefore = axesSnapshot(recordId);
    const revisionBefore = revisionSnapshot(revisionId);

    const spy = fakeFetch();
    const queue = makeQueue(spy.fetchImpl, { delayMs: 0 });
    queue.enqueue(revisionId);
    await queue.drain();
    expect(spy.state.calls).toBe(1);

    expect(axesSnapshot(recordId)).toEqual(recordBefore);
    expect(revisionSnapshot(revisionId)).toEqual(revisionBefore);
    expect(records.axesOfRevision(revisionId)).toEqual<ThreeAxes>(LLM_AXES);
  });

  /**
   * N-6 的扫描面 = **这一层新增/改动的**观测面与作业快照，不是整个 `app_meta`。
   *
   * 为什么不扫 `preview_llm_v2_payload:<rev>` 的值：那枚键存的就是「将要从本机发出去的那串字节」，
   * 是 M9 定下来的既有事实（M9-D-13 口径），它当然在库里。夹具里的「张三」既不在词表、规则也不遮它，
   * 于是它出现在载荷里是**既有行为**，与预跑无关——预跑没有多写一个字。把它当泄漏，等于把 M9 的
   * 落库形状判成 M10 的罪。真正的红线由别处钉：载荷不含模型遮掉的词面（B3）、键名不许带文本、
   * 新键前缀封闭（N-5）、观测面与日志与 `privacy_job` 逐字段干净。
   */
  it("落库面与观测面都不含原文与词面（N-6）", async () => {
    setup();
    const { revisionId } = saveLlmRecord();
    const metaBefore = metaRows();
    const spy = fakeFetch();
    const queue = makeQueue(spy.fetchImpl, { delayMs: 0 });

    const logged: string[] = [];
    const releaseConsole = captureConsoleLog(logged);
    try {
      queue.enqueue(revisionId);
      await queue.drain();
    } finally {
      releaseConsole();
    }
    expect(spy.state.calls).toBe(1);

    // ① 观测面：stats() 逐字段，形状本身就是断言——只有 revisionId 与三个类别计数。
    const stats = queue.stats();
    expect(Object.keys(stats)).toEqual(["ran", "skipped", "failed", "last"]);
    expect(Object.keys(stats.last ?? {}).sort()).toEqual(["outcome", "revisionId"]);
    expect(stats.last).toEqual({ revisionId, outcome: "ran" });
    const statLeaves = collectStrings(stats, []);
    expect(statLeaves.length, "扫描面为空即是断言失效").toBeGreaterThan(0);
    assertNoRawFace(statLeaves, "stats() 观测面");

    // ② 队列路径的日志行。
    const logLeaves: string[] = [];
    for (const line of logged) collectStrings(line, logLeaves);
    assertNoRawFace(logLeaves, "预跑日志");

    // ③ 作业快照：`privacy_job` 逐列扫（预跑不建任务行 ⇒ 这一片应当是空的；有行也照样扫）。
    const jobRows = db!.prepare("select * from privacy_job").all() as Record<string, unknown>[];
    const jobLeaves: string[] = [];
    for (const row of jobRows) collectStrings(row, jobLeaves);
    assertNoRawFace(jobLeaves, "privacy_job 快照");

    // ④ 落库面的**键名**：键不许携带文本本体。
    const metaAfter = metaRows();
    assertNoRawFace(metaAfter.map((row) => row.key), "app_meta 键名");

    // ⑤ N-5 的强断言：新增的键只可能是既有那四枚前缀，**不许出现任何新前缀**。
    const beforeKeys = new Set(metaBefore.map((row) => row.key));
    const added = metaAfter.filter((row) => !beforeKeys.has(row.key));
    expect(added.length, "预跑成功却不落任何键 = 断言失效").toBeGreaterThan(0);
    const newPrefixes = [...new Set(added.map((row) => keyPrefix(row.key)))].sort();
    for (const prefix of newPrefixes) {
      expect(PREWARM_ALLOWED_NEW_PREFIXES, `预跑写出了新键前缀「${prefix}」`).toContain(prefix);
    }
    // 成功路径落的恰好是三枚（`preview_llm_failed` 是失败路径那一条说的，见 B7）。
    expect(newPrefixes).toEqual(["preview_llm_v2_nonce", "preview_llm_v2_payload", "preview_llm_v2_spans"]);
    // 既有键一枚都不许被这一拍改写。
    for (const row of metaBefore) {
      expect(metaValue(row.key), `既有键「${row.key}」被预跑改写了`).toBe(row.value);
    }
  });
});

/* ══════════════════════════════════════════════════════════════════
 * B10 / B11 / B12 保存面
 * ══════════════════════════════════════════════════════════════════ */

describe("B10 回调抛异常不许冒泡：保存必须成功", () => {
  it("注入一个必抛的 onRevisionSaved ⇒ 新建与编辑都照常落库", () => {
    setup();
    const boom = new RecordService(db!, {
      timezoneId: "Asia/Shanghai",
      onRevisionSaved: () => {
        throw new Error("预跑排程炸了");
      },
    });
    const created = boom.createRecord(RAW, "cloud_redacted");
    const edited = boom.editRecord(created.record.id, `${RAW}（改过）`);
    expect(edited.changed).toBe(true);

    // 记录与版本都真的入库了：回调的失败没有牵连事务。
    const row = db!.prepare("select * from capture_record where id = ?").get(created.record.id) as {
      current_revision_id: string;
      processing_status: string;
    };
    expect(row.current_revision_id).toBe(edited.revision.id);
    expect((db!.prepare("select raw_text from record_revision where id = ?").get(edited.revision.id) as {
      raw_text: string;
    }).raw_text).toBe(`${RAW}（改过）`);
    expect(countRows(db!, "capture_record")).toBe(1);
    expect(countRows(db!, "record_revision")).toBe(2);
  });
});

describe("B11 不注入回调 ⇒ 保存路径与改动前逐字相同", () => {
  it("Workspace 不传第 5 个参数：保存后零请求、app_meta 无新键", async () => {
    setup();
    const workspace = new Workspace(sandbox!.layout, db!, schemaVersion);
    const spy = fakeFetch();
    const metaBefore = metaRows();

    const created = workspace.records.createRecord(RAW, "cloud_redacted");
    workspace.records.setRedactionMode(created.record.id, "local_llm");
    const edited = workspace.records.editRecord(created.record.id, `${RAW}（改过）`);
    expect(edited.changed).toBe(true);

    await sleep(20);
    expect(spy.state.calls).toBe(0);
    expect(metaRows()).toEqual(metaBefore);
    expect(metaValue(LLM_PAYLOAD_KEY(edited.revision.id))).toBeUndefined();
    // 没注入 ⇒ 服务层连一次回调都不发（不是「发了但被吞掉」）。
    expect(workspace.records.axesOfRevision(edited.revision.id)).toEqual<ThreeAxes>({
      analysisProvider: "cloud",
      redactionMode: "local_llm",
      sendContentMode: "redacted",
    });
  });

  it("注入回调时 swap() 仍把它带下去（R-5 换库不许把预跑弄丢）", () => {
    setup();
    const seen: string[] = [];
    const workspace = new Workspace(sandbox!.layout, db!, schemaVersion, null, {
      onRevisionSaved: (revisionId) => seen.push(revisionId),
    });
    const created = workspace.records.createRecord(RAW, "cloud_redacted");
    expect(seen).toEqual([created.revision.id]);

    workspace.swap({ db: db!, schemaVersion });
    const afterSwap = workspace.records.editRecord(created.record.id, `${RAW}（改过）`);
    expect(seen, "swap 重建的 RecordService 丢了回调 = 恢复之后这一档再也不预跑").toEqual([
      created.revision.id,
      afterSwap.revision.id,
    ]);
  });
});

describe("B12 先提交、后回调", () => {
  it("回调里读库看到的就是刚写的那一版", () => {
    setup();
    const readbacks: { revisionId: string; rawText: string | undefined; current: string | undefined }[] = [];
    const observing = new RecordService(db!, {
      timezoneId: "Asia/Shanghai",
      onRevisionSaved: (revisionId) => {
        // 提交之后才回调 ⇒ 这两处读到的必须已经是新版本（队列跑体正是靠这一点读到对的原文）。
        const rawText = (db!.prepare("select raw_text from record_revision where id = ?").get(revisionId) as
          | { raw_text: string }
          | undefined)?.raw_text;
        const current = (db!
          .prepare(
            `select current_revision_id from capture_record
              where id = (select record_id from record_revision where id = ?)`,
          )
          .get(revisionId) as { current_revision_id: string } | undefined)?.current_revision_id;
        readbacks.push({ revisionId, rawText, current });
      },
    });

    const created = observing.createRecord(RAW, "cloud_redacted");
    expect(readbacks).toHaveLength(1);
    expect(readbacks[0]!.rawText, "回调里读到 undefined = 事务还没提交").toBe(RAW);
    expect(readbacks[0]!.current).toBe(created.revision.id);

    const edited = observing.editRecord(created.record.id, `${RAW}（改过）`);
    expect(readbacks).toHaveLength(2);
    expect(readbacks[1]!.rawText).toBe(`${RAW}（改过）`);
    expect(readbacks[1]!.current).toBe(edited.revision.id);

    // 空 diff 不建版 ⇒ 也就没有新的预跑意图（否则等于 M10-D-7 明令不做的自动重试）。
    const same = observing.editRecord(created.record.id, `${RAW}（改过）`);
    expect(same.changed).toBe(false);
    expect(readbacks).toHaveLength(2);

    // 本期只覆盖新建与编辑：改档 / 改模式 / 删除都不叫回调。
    observing.setRedactionMode(created.record.id, "local_llm");
    observing.setProcessingMode(created.record.id, "local_model");
    observing.deleteRecord(created.record.id);
    expect(readbacks).toHaveLength(2);
    expect(records.axesOfRevision(edited.revision.id)).toBeNull();
  });
});

/* ══════════════════════════════════════════════════════════════════
 * 端到端夹具（真 HTTP 面 + 假本机模型，照 m9-4c 的手法）
 * ══════════════════════════════════════════════════════════════════ */

const FAKE_LLM_MARK = "127.0.0.1:14556";

interface Instance {
  readonly booted: BootResult;
  readonly box: Sandbox;
  readonly base: string;
  readonly stub: StubTransport;
}

const liveInstances: Instance[] = [];
let restoreFetch: (() => void) | null = null;

function llmProfile(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    enabled: true,
    provider: "ollama",
    // 端口本身没人监听：候选征询被下面的假 handler 截住。
    base_url: `http://${FAKE_LLM_MARK}/v1`,
    request_timeout_ms: 2000,
    model: "qwen3:8b",
    ...overrides,
  };
}

/** 只截假端点，其余（测试自己打本机 HTTP 面的请求）原样转给真 fetch。 */
function installFakeLocalLlm(): FakeState {
  const state: FakeState = { calls: 0, inFlight: 0, maxInFlight: 0, bodies: [], aborts: 0 };
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    if (!String(input).includes(FAKE_LLM_MARK)) {
      return (real as (a: unknown, b?: RequestInit) => Promise<Response>)(input, init);
    }
    state.calls += 1;
    if (typeof init?.body === "string") state.bodies.push(init.body);
    return { status: 200, text: () => Promise.resolve(candidatesBody()) } as unknown as Response;
  }) as unknown as typeof fetch;
  restoreFetch = () => {
    globalThis.fetch = real;
  };
  return state;
}

function uninstallFakeLocalLlm(): void {
  restoreFetch?.();
  restoreFetch = null;
}

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

function writeConfig(layout: DataLayout, port: number, localLlm: Record<string, unknown>): void {
  mkdirSync(layout.dataDir, { recursive: true });
  const file = ensureConfigFile(layout);
  const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  (raw.server as Record<string, unknown>).port = port;
  (raw.model as Record<string, unknown>).enabled = false;
  (raw.model as Record<string, unknown>).cloud_redacted_enabled = true;
  (raw.model as Record<string, unknown>).local_llm = localLlm;
  writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
}

async function startInstance(localLlm: Record<string, unknown>): Promise<Instance> {
  const box = makeSandbox("tb-m10-1-e2e-");
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
  const inst: Instance = { booted, box, base: `http://127.0.0.1:${port}`, stub };
  liveInstances.push(inst);
  return inst;
}

interface ApiResult {
  status: number;
  json: any;
  text: string;
}

async function call(inst: Instance, method: string, path: string, body?: unknown): Promise<ApiResult> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(body);
  }
  const res = await fetch(`${inst.base}${path}`, init);
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text === "" ? null : JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, json, text };
}

function metaValueOf(inst: Instance, key: string): string | undefined {
  const row = inst.booted.db.prepare("select value from app_meta where key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}
