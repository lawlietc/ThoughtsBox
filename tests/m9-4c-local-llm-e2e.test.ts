/**
 * M9-4c 专项测试：op6 在 `redaction_mode=local_llm` 时**真的去问本地模型**，
 * 预览 DTO 把「哪一处是谁遮的」（`spans[].source`）与「这次模型用上没有」（`llmLayer`）带给前端。
 *
 * 这一批接的是 M9-4b 留下的最后一段死路：拆门之后 `local_llm` + 配置可用时，op6 仍走
 * `previewForEgress` 的**复现**路径，而那一档的采信区间还没人落下 ⇒ `LocalLlmTierCacheMissingError`
 * ⇒ 通用 500（任务 §0c）。本批之后 op6 先征询模型、把采信的区间落进自己那三键，
 * op7/op2 才谈得上复现，于是 E5 钉「不再是 5xx」与「同一 revision 第二次 op6 不再调模型」。
 *
 * 钉住的五组（任务 §3）：
 *  - **E1** 完整链路：op6 征询 ⇒ 三种来源齐备 ⇒ op7 签发 `rules+local_llm-v2` ⇒ op2 发出的载荷里
 *    逐条搜不到 `spans` 的原文切片，且哈希与签出的那一行一致。
 *  - **E2** 本地服务超时：op6 仍 200、`used:false`、`failureKind:"timeout"`、policy 维持 `rules-v2`；
 *    同一档随后 op7→op2 走得通，发的就是用户看过的规则档那一套（载荷里没有原文片段，也没有任何
 *    `local_llm` 来源的占位符）。M9-4d-pre 起这里**不再需要用户改档**，而发送前会再问一次模型（M9-D-13）。
 *  - **E3** 非回环 / 未配置：op6 409 + 封闭 `reason`，一次请求都不发，缓存零键。
 *  - **E4** 无原文外泄：链路结束后 `parse_run.pipeline_manifest` 与 `app_meta` 逐叶子扫，
 *    原文与被遮词面一个都不许在（`app_meta` 里只有本档那几枚预览键，键名在五个合法键之内）。
 *  - **E5** 不再是 500 + 幂等：配置可用 ⇒ op6 非 5xx；同一 revision 第二次 op6 模型调用计数不增、
 *    载荷逐字相同（M9-D-8 的缓存语义在 HTTP 面的落点）。
 *
 * 全程离线：本地模型是一枚**装在全局 fetch 上的假 handler**（只截 `127.0.0.1:14555`，其余请求
 * 原样转给真 fetch，测试自己打本机 HTTP 面的那条路不受影响）；云端是 `stubTransport` 记录请求体。
 * 数据库只落 `TB_DATA_DIR` 沙箱。
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { ensureConfigFile, localLlmStatus, type AppConfig } from "../src/server/config/config.ts";
import type { DataLayout } from "../src/server/config/paths.ts";
import { boot, shutdown, type BootResult } from "../src/server/runtime/bootstrap.ts";
import type { StructuredOutput } from "../src/server/ingest/contract.ts";
import { LOCAL_LLM_POLICY_VERSION, REDACTION_POLICY_VERSION, REDACTION_SOURCES } from "../src/server/privacy/redaction.ts";
import { seedConceptId } from "../src/shared/contracts/ids.ts";
import {
  OK_ENVELOPE,
  SYSTEM_PROMPT,
  makeAdapter,
  stubTransport,
  type StubTransport,
} from "./helpers/ingestFixtures.ts";
import { makeSandbox, type Sandbox } from "./helpers/sandbox.ts";

/* ── 夹具文本与词面 ───────────────────────────────────────────────── */

/**
 * 四层各遮一处：实体记忆（张三）、规则（手机号）、本地模型（蓝山咖啡馆 / 《星海》），
 * 「聊了三个小时」是云端回稿的证据词面——它不属于任何一层，回锚因此与档位无关。
 */
const RAW = "周末和张三去了蓝山咖啡馆，电话 13800138000，聊聊《星海》，聊了三个小时";
const ZHANG = "张三";
const PHONE = "13800138000";
const CAFE = "蓝山咖啡馆";
const WORK = "《星海》";
/** 泄漏扫描的词面清单：原文本体 + 每一个被遮住的词面（叶子级，照 M7-3 C 组手法）。 */
const FACES = [RAW, ZHANG, PHONE, CAFE, WORK];

const at = (term: string): number => {
  const index = RAW.indexOf(term);
  if (index < 0) throw new Error(`夹具文本里没有 ${term}`);
  return index;
};

/** 假本地模型的回稿：坐标锚定 `RAW` 的 UTF-16 偏移，与真模型的契约形状同形。 */
const MODEL_CANDIDATES = [
  { start: at(CAFE), end: at(CAFE) + CAFE.length, kind: "place", surface: CAFE },
  { start: at(WORK), end: at(WORK) + WORK.length, kind: "person", surface: WORK },
];

/** 结构合法、证据可回锚的最小回稿（与 m9-4b 同一份形状）。 */
function parseReply(): StructuredOutput {
  return {
    title: "一次线下的见面",
    summary: "记录了一次线下见面",
    episodes: [],
    thoughts: [{ text: "见面比线上沟通更有效", evidence: "聊了三个小时" }],
    emotions: [
      { labelSaid: "开心", candidateConceptId: seedConceptId("开心"), basis: "explicit", evidence: "聊了三个小时" },
    ],
    topics: [
      { labelSaid: "社交", candidateConceptId: seedConceptId("朋友与社交"), basis: "explicit", evidence: "聊了三个小时" },
    ],
    entities: [],
    relations: [],
  };
}

/* ── 配置 ─────────────────────────────────────────────────────────── */

/** 假本地模型端点：回环 + 有模型名 ⇒ `localLlmStatus` 判 usable；端口本身没人监听（fetch 被截）。 */
const FAKE_LLM_MARK = "127.0.0.1:14555";

function llmProfile(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    enabled: true,
    provider: "ollama",
    base_url: `http://${FAKE_LLM_MARK}/v1`,
    // schema 的下限是 1000ms：E2 的「超时」由假 handler 挂在 abort 上，1 秒内即落 `timeout`。
    request_timeout_ms: 1000,
    model: "qwen3:8b",
    ...overrides,
  };
}

/* ── 假本地模型服务（装在全局 fetch 上） ──────────────────────────── */

interface FakeLlmState {
  calls: number;
  bodies: string[];
}

type FakeHandler = (init?: RequestInit) => Promise<Response>;

function envelope(content: string): string {
  return JSON.stringify({ choices: [{ message: { content } }] });
}

function responds(candidates: readonly unknown[]): FakeHandler {
  return async () =>
    ({
      status: 200,
      text: () => Promise.resolve(envelope(JSON.stringify({ candidates }))),
    }) as unknown as Response;
}

/** 永不 resolve、只在 abort 时拒绝：provider 的超时守卫把 AbortController 一按，`failureKind:"timeout"`。 */
const hangs: FakeHandler = (init) =>
  new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new Error("The user aborted a request.")));
  });

const restored: (() => void)[] = [];

/** 只截假端点，其余（测试自己打本机 HTTP 面的那些请求）原样转给真 fetch。 */
function installFakeLocalLlm(handler: FakeHandler): FakeLlmState {
  const state: FakeLlmState = { calls: 0, bodies: [] };
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    if (!String(input).includes(FAKE_LLM_MARK)) {
      return (real as (a: unknown, b?: RequestInit) => Promise<Response>)(input, init);
    }
    state.calls += 1;
    if (typeof init?.body === "string") state.bodies.push(init.body);
    return handler(init);
  }) as unknown as typeof fetch;
  restored.push(() => {
    globalThis.fetch = real;
  });
  return state;
}

/* ── 运行夹具（真 HTTP 面 + 桩云端 transport） ────────────────────── */

interface Instance {
  readonly booted: BootResult;
  readonly box: Sandbox;
  readonly base: string;
  readonly stub: StubTransport;
}

const live: Instance[] = [];

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

function writeConfig(layout: DataLayout, port: number, localLlm: Record<string, unknown> | undefined): void {
  mkdirSync(layout.dataDir, { recursive: true });
  const file = ensureConfigFile(layout);
  const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  (raw.server as Record<string, unknown>).port = port;
  (raw.model as Record<string, unknown>).enabled = false;
  (raw.model as Record<string, unknown>).cloud_redacted_enabled = true;
  if (localLlm !== undefined) (raw.model as Record<string, unknown>).local_llm = localLlm;
  writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
}

async function startInstance(localLlm: Record<string, unknown> | undefined): Promise<Instance> {
  const box = makeSandbox("tb-m9-4c-");
  const port = await freePort();
  writeConfig(box.layout, port, localLlm);
  const stub = stubTransport(OK_ENVELOPE(parseReply()));
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
  live.push(inst);
  return inst;
}

afterEach(async () => {
  while (restored.length > 0) restored.pop()!();
  while (live.length > 0) {
    const inst = live.pop()!;
    await shutdown(inst.booted);
    inst.box.cleanup();
  }
});

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

/**
 * 一条 `cloud|local_llm|redacted`（矩阵 #8，本方案主推路径）的记录，外加一条已确认实体「张三」。
 * 没有 HTTP 入口能把记录设成 `local_llm` 档（M9-4d 才开界面），照 0C 的现场直接写轴列。
 */
async function makeLlmRecord(inst: Instance): Promise<{ recordId: string; revisionId: string }> {
  const created = await call(inst, "POST", "/api/records", { text: RAW, processing_mode: "cloud_redacted" });
  expect(created.status).toBe(201);
  const recordId = created.json.record.id as string;
  inst.booted.db
    .prepare(
      `update capture_record
          set processing_mode = 'cloud_redacted', analysis_provider = 'cloud', redaction_mode = 'local_llm',
              send_content_mode = 'redacted'
        where id = ?`,
    )
    .run(recordId);
  inst.booted.db
    .prepare(
      `insert into entity (id, entity_type, canonical_name, display_name, lifecycle_status, privacy_level, origin_type, created_at_utc)
       values ('entity_zhang', 'person', ?, ?, 'active', 'normal', 'user_created', '2026-10-29T01:00:00.000Z')`,
    )
    .run(ZHANG, ZHANG);
  const revisionId = inst.booted.records.getRecord(recordId).record.current_revision_id;
  return { recordId, revisionId };
}

/* ── 缓存键与叶子级扫描 ──────────────────────────────────────────── */

const RULES_NONCE_KEY = (revisionId: string): string => `preview_v2_nonce:${revisionId}`;
const RULES_PAYLOAD_KEY = (revisionId: string): string => `preview_v2_payload:${revisionId}`;
const LLM_NONCE_KEY = (revisionId: string): string => `preview_llm_v2_nonce:${revisionId}`;
const LLM_PAYLOAD_KEY = (revisionId: string): string => `preview_llm_v2_payload:${revisionId}`;
const LLM_SPANS_KEY = (revisionId: string): string => `preview_llm_v2_spans:${revisionId}`;
/** 五个合法预览键（M9-D-9）：本批不新增第六枚。 */
const ALL_FIVE_KEYS = (revisionId: string): string[] =>
  [
    RULES_NONCE_KEY(revisionId),
    RULES_PAYLOAD_KEY(revisionId),
    LLM_NONCE_KEY(revisionId),
    LLM_PAYLOAD_KEY(revisionId),
    LLM_SPANS_KEY(revisionId),
  ].sort();

function previewKeys(inst: Instance): string[] {
  return (inst.booted.db.prepare("select key from app_meta where key like 'preview_%'").all() as { key: string }[])
    .map((row) => row.key)
    .sort();
}

function stringLeaves(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") {
    out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) stringLeaves(item, out);
    return out;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out.push(key);
      stringLeaves(item, out);
    }
  }
  return out;
}

/** 一条 JSON 列 + `app_meta` 全表：任何字符串叶子都不许带原文词面。 */
function expectNoLeakageInLocalStore(inst: Instance, message: string): void {
  const rows = inst.booted.db.prepare("select key, value from app_meta order by key").all() as {
    key: string;
    value: string;
  }[];
  const leaves: string[] = [];
  for (const row of rows) {
    leaves.push(row.key);
    leaves.push(row.value);
    try {
      stringLeaves(JSON.parse(row.value), leaves);
    } catch {
      /* 载荷 / nonce 不是 JSON，按字符串叶子扫过即可 */
    }
  }
  const runs = inst.booted.db.prepare("select pipeline_manifest from parse_run").all() as {
    pipeline_manifest: string;
  }[];
  for (const row of runs) {
    leaves.push(row.pipeline_manifest);
    try {
      stringLeaves(JSON.parse(row.pipeline_manifest), leaves);
    } catch {
      /* 同上 */
    }
  }
  expect(leaves.length, `${message}（扫描面为空即是断言失效）`).toBeGreaterThan(0);
  for (const leaf of leaves) {
    for (const face of FACES) {
      expect(leaf, `${message}：叶子字段里出现了词面「${face}」`).not.toContain(face);
    }
  }
}

/* ── 预览 DTO 的公共核对（两批用例共用） ─────────────────────────── */

function expectClosedEnumFields(preview: ApiResult): void {
  for (const span of preview.json.spans) {
    expect(REDACTION_SOURCES).toContain(span.source);
    expect(Number.isInteger(span.originalStart)).toBe(true);
    expect(Number.isInteger(span.originalEnd)).toBe(true);
    expect(span.originalEnd).toBeGreaterThan(span.originalStart);
  }
  if (preview.json.llmLayer.failureKind !== undefined) {
    // 封闭集：`proposeRedactionCandidates` 只会报这几类（不是自由文本）。
    expect(["not_loopback", "timeout", "network", "http", "invalid_json", "unstructured"]).toContain(
      preview.json.llmLayer.failureKind,
    );
  }
}

/** 逐条扫 `spans` 的原文切片：一份外发请求体里任何一条命中都算原文外泄。 */
function expectNoMaskedSurface(body: string, spans: readonly { originalStart: number; originalEnd: number }[]): void {
  expect(spans.length).toBeGreaterThan(0);
  for (const span of spans) {
    const surface = RAW.slice(span.originalStart, span.originalEnd);
    expect(body, `云端请求体里出现了被遮过的词面「${surface}」`).not.toContain(surface);
  }
}

/* ════════════════════════════════════════════════════════════════════
 * E1 完整链路
 * ════════════════════════════════════════════════════════════════════ */

describe("E1 记录轴列 local_llm + 配置可用：op6 真的问模型，签发与解析都复现同一份载荷", () => {
  it("200 + used:true + rules+local_llm-v2 + 三种来源齐备；op7 签发；op2 云端只收到遮过的载荷", async () => {
    const spy = installFakeLocalLlm(responds(MODEL_CANDIDATES));
    const inst = await startInstance(llmProfile());
    const { recordId } = await makeLlmRecord(inst);

    const preview = await call(inst, "POST", "/api/ingest/preview", { recordId });
    expect(preview.status).toBe(200);
    expect(spy.calls, "op6 首预览必须真的征询一次本地模型").toBe(1);
    expect(preview.json.policyVersion).toBe(LOCAL_LLM_POLICY_VERSION);
    expect(preview.json.sendContentMode).toBe("redacted");
    expect(preview.json.llmLayer).toMatchObject({ used: true, candidates: 2, dropped: 0 });
    expectClosedEnumFields(preview);
    // 三处来源同屏：规则（手机号）、实体记忆（张三）、本地模型（咖啡馆 / 作品名）。
    const sources = (preview.json.spans as { source: string; kind: string }[]).map((span) => span.source);
    expect(new Set(sources)).toEqual(new Set(["rule", "entity_memory", "local_llm"]));
    expect(preview.json.spans.filter((s: { source: string }) => s.source === "local_llm")).toHaveLength(2);
    // 载荷确实被本地模型档遮过：规则与实体记忆都遮不掉这两个词面。
    expect(preview.json.redactedText).not.toContain(CAFE);
    expect(preview.json.redactedText).not.toContain(WORK);
    expect(preview.json.redactedText).not.toContain(ZHANG);
    expect(preview.json.redactedText).not.toContain(PHONE);

    const confirmed = await call(inst, "POST", "/api/ingest/confirm-send", { recordId });
    expect(confirmed.status).toBe(201);
    expect(confirmed.json.policyVersion).toBe(LOCAL_LLM_POLICY_VERSION);
    expect(confirmed.json.payloadSha256).toBe(preview.json.payloadSha256);

    const parsed = await call(inst, "POST", "/api/ingest/parse", { recordId });
    expect(parsed.status).toBe(200);
    expect(parsed.json.succeeded).toBe(true);

    // 模型只被问过这一次：op7 / op2 走的是缓存复现，不是第二次征询。
    expect(spy.calls).toBe(1);
    expect(inst.stub.callCount()).toBe(1);
    expectNoMaskedSurface(inst.stub.lastBody(), preview.json.spans);
    // 本地模型收到的正是本机原文（回环之内，符合 P-1），云端收到的不是。
    expect(spy.bodies[0]).toContain(RAW);

    const grant = inst.booted.db
      .prepare("select payload_sha256, policy_version from cloud_send_grant where id = ?")
      .get(confirmed.json.grantId) as { payload_sha256: string; policy_version: string };
    expect(grant.payload_sha256).toBe(preview.json.payloadSha256);
    expect(grant.policy_version).toBe(LOCAL_LLM_POLICY_VERSION);
  });
});

/* ════════════════════════════════════════════════════════════════════
 * E2 本地服务超时
 * ════════════════════════════════════════════════════════════════════ */

describe("E2 本地模型超时：op6/op7/op2 都阻断，零外发、零授权", () => {
  it("failureKind=timeout；op7 409 local_llm_not_previewed；op2 409 local_llm_consult_failed", async () => {
    const spy = installFakeLocalLlm(hangs);
    const inst = await startInstance(llmProfile());
    const { recordId } = await makeLlmRecord(inst);

    const preview = await call(inst, "POST", "/api/ingest/preview", { recordId });
    expect(preview.status).toBe(409);
    expect(preview.json.error).toBe("local_llm_consult_failed");
    expect(preview.json.reason).toBe("timeout");
    expect(spy.calls).toBe(1);

    const revisionId = inst.booted.records.getRecord(recordId).record.current_revision_id;
    expect(previewKeys(inst)).toEqual([`preview_llm_v2_failed:${revisionId}`]);

    expect(inst.booted.records.getRecord(recordId).record.redaction_mode).toBe("local_llm");
    const confirmed = await call(inst, "POST", "/api/ingest/confirm-send", { recordId });
    expect(confirmed.status).toBe(409);
    expect(confirmed.json.error).toBe("local_llm_not_previewed");
    const grantCount = inst.booted.db
      .prepare("select count(*) as n from cloud_send_grant")
      .get() as { n: number };
    expect(grantCount.n, "阻断路径零授权").toBe(0);

    const parsed = await call(inst, "POST", "/api/ingest/parse", { recordId });
    expect(parsed.status).toBe(409);
    expect(parsed.json.error).toBe("local_llm_consult_failed");
    expect(inst.stub.callCount(), "阻断发生在任何外发之前").toBe(0);
    expect(spy.calls, "op6 一次 + op2 前再问一次，两次都没跑成").toBe(2);
  });
});

/* ════════════════════════════════════════════════════════════════════
 * E3 非回环 / 未配置
 * ════════════════════════════════════════════════════════════════════ */

describe("E3 档位不可用：op6 409 + 封闭 reason，一次请求都不发，缓存零键", () => {
  const UNUSABLE: readonly { label: string; localLlm: Record<string, unknown> | undefined; reason: string }[] = [
    { label: "未配置", localLlm: undefined, reason: "not_configured" },
    { label: "端点不是回环", localLlm: llmProfile({ base_url: "http://192.168.1.9:11434/v1" }), reason: "not_loopback" },
    { label: "已配置但关闭", localLlm: llmProfile({ enabled: false }), reason: "disabled" },
    { label: "缺 model", localLlm: llmProfile({ model: undefined }), reason: "no_model" },
  ];

  for (const testCase of UNUSABLE) {
    it(`${testCase.label} ⇒ 409 redaction_mode_unavailable / reason=${testCase.reason}`, async () => {
      const spy = installFakeLocalLlm(responds(MODEL_CANDIDATES));
      const inst = await startInstance(testCase.localLlm);
      const { recordId } = await makeLlmRecord(inst);

      const preview = await call(inst, "POST", "/api/ingest/preview", { recordId });
      expect(preview.status, testCase.label).toBe(409);
      expect(preview.json.error, testCase.label).toBe("redaction_mode_unavailable");
      expect(preview.json.reason, testCase.label).toBe(testCase.reason);
      // 状态读数与判定源同源（`localLlmStatus` 是唯一判据，路由不另算一遍）。
      const config = inst.booted.loaded.config as AppConfig;
      expect(localLlmStatus(config).reason, testCase.label).toBe(testCase.reason);
      expect(spy.calls, `${testCase.label}：不可用的档位一次请求都不该发出`).toBe(0);
      expect(previewKeys(inst), `${testCase.label}：拒绝之前不产生任何缓存键`).toEqual([]);
    });
  }
});

/* ════════════════════════════════════════════════════════════════════
 * E4 无原文外泄
 * ════════════════════════════════════════════════════════════════════ */

describe("E4 链路跑完之后：parse_run 的 trace JSON 与 app_meta 里搜不到原文与词面", () => {
  it("本地模型档跑通的整条链路，落库面逐叶子干净，app_meta 只有本档那三枚预览键", async () => {
    const spy = installFakeLocalLlm(responds(MODEL_CANDIDATES));
    const inst = await startInstance(llmProfile());
    const { recordId, revisionId } = await makeLlmRecord(inst);

    const preview = await call(inst, "POST", "/api/ingest/preview", { recordId });
    expect(preview.status).toBe(200);
    const confirmed = await call(inst, "POST", "/api/ingest/confirm-send", { recordId });
    expect(confirmed.status).toBe(201);
    const parsed = await call(inst, "POST", "/api/ingest/parse", { recordId });
    expect(parsed.status).toBe(200);
    expect(parsed.json.succeeded).toBe(true);

    expectNoLeakageInLocalStore(inst, "E4 落库面");
    // 这一档只写自己的三键：规则档那两枚与「第六枚」都不许出现。
    expect(previewKeys(inst)).toEqual([LLM_NONCE_KEY(revisionId), LLM_PAYLOAD_KEY(revisionId), LLM_SPANS_KEY(revisionId)]);
    for (const key of previewKeys(inst)) {
      expect(ALL_FIVE_KEYS(revisionId), `键名不在五个合法预览键之内：${key}`).toContain(key);
    }
    // 采信区间键的取值面只有 kind 与数字：`surface` 在落盘前就被剥掉了。
    const spansValue = inst.booted.db
      .prepare("select value from app_meta where key = ?")
      .get(LLM_SPANS_KEY(revisionId)) as { value: string };
    expect(spansValue.value).not.toContain("surface");
    expect(spansValue.value).not.toContain(ZHANG);
    // trace 面（M9-D-12）：这一档不给 parse_run 加任何计数列。
    expect(spy.calls).toBe(1);
  });
});

/* ════════════════════════════════════════════════════════════════════
 * E5 不再是 500 + 第二次不调模型（任务 §0c）
 * ════════════════════════════════════════════════════════════════════ */

describe("E5 M9-4b 留下的 500 路径：本批之后是正常预览，且同一 revision 不重复征询", () => {
  it("op6 非 5xx；第二次 op6 模型调用计数不增、载荷逐字相同", async () => {
    const spy = installFakeLocalLlm(responds(MODEL_CANDIDATES));
    const inst = await startInstance(llmProfile());
    const { recordId } = await makeLlmRecord(inst);

    const first = await call(inst, "POST", "/api/ingest/preview", { recordId });
    expect(first.status).toBe(200);
    expect(first.status).toBeLessThan(500);
    expect(spy.calls).toBe(1);

    const second = await call(inst, "POST", "/api/ingest/preview", { recordId });
    expect(second.status).toBe(200);
    expect(second.status).toBeLessThan(500);
    expect(spy.calls, "同一 revision 的第二次预览走缓存复现，不再问模型").toBe(1);
    expect(second.json.payloadText).toBe(first.json.payloadText);
    expect(second.json.payloadSha256).toBe(first.json.payloadSha256);
    expect(second.json.redactedText).toBe(first.json.redactedText);
    expect(second.json.policyVersion).toBe(first.json.policyVersion);
    expect(second.json.spans).toEqual(first.json.spans);
    expect(second.json.llmLayer).toMatchObject({ used: true, candidates: 2 });

    // 手工替换文本仍走同一份缓存载荷键：第二次预览带 replacement，载荷随之更新。
    const replaced = await call(inst, "POST", "/api/ingest/preview", {
      recordId,
      payloadText: `${first.json.payloadText}（用户改过）`,
    });
    expect(replaced.status).toBe(200);
    expect(spy.calls).toBe(1);
    expect(replaced.json.payloadText).toBe(`${first.json.payloadText}（用户改过）`);
    expect(replaced.json.redactedText).toBe(first.json.redactedText);
  });
});
