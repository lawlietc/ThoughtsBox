/**
 * M9-4d-pre 专项测试：**发送前再问一次模型**（裁决 M9-D-13，任务 §6 的 S1–S8）。
 *
 * 本批改掉的是 M9-4c 留下的一条死路：op6 征询失败时只落规则档、不留任何记号，于是
 * 「用户看过的就是回落那一份」这个事实在库里没有凭据——随后的 op7 按 `local_llm` 档复现
 * 就读不到采信区间 ⇒ `LocalLlmTierCacheMissingError` ⇒ 用户只能**改档**才发得出去。
 * 新语义（M9-D-13）：
 *  - op6 问不成 ⇒ 落规则档载荷，并在 `app_meta` 记一枚**封闭取值**的咨询失败标记；
 *  - op7 凭这枚标记把用户**看过的那一份**签出去（`rules-v1`），不要求改档，也不自动重问；
 *  - op2 / 入队 / 后台执行体在发送前**再问一次**：
 *      问成 ⇒ 载荷变了 ⇒ 已有的四腿授权闸门抛 409，请用户重新预览确认（没有「自动重新确认」）；
 *      仍问不成 ⇒ 发出去的就是用户看过并签了 `rules-v1` 的那一份。
 *
 * 钉住的八组（任务 §6）：
 *  - **S1** 征询失败后：标记在册且取值属于封闭集，本档那三键一枚都不写。
 *  - **S2** op7 凭标记签发：不改档、不重问，签出 `rules-v1`，哈希逐字等于用户看过的那份。
 *  - **S3** 发送前重问**成功** ⇒ 409 + 三键落齐 + 标记被清；随后 op6（走复现，不再问）→ op7 → op2
 *    发出去的是新遮过的那份。
 *  - **S4** 发送前重问**仍失败** ⇒ 照发用户看过的那份规则档载荷：云端请求体里搜不到任何被遮词面，
 *    也不含任何 `local_llm` 来源的占位符；库里的授权行哈希与之一致。
 *  - **S5** 没预览过就点确认 ⇒ 409 `local_llm_not_previewed`，授权行零条。
 *  - **S6** 采信区间缓存被改坏 ⇒ 409 `redaction_tier_cache_missing`（不再是通用 500），op7 / op2 / 入队三处同一码。
 *  - **S7** `send_content_mode=none` ⇒ 问了也没有对象：一次都不咨询，落规则档载荷，且不写标记。
 *  - **S8** 硬删除清的是**六枚**键（规则 2 + LLM 3 + 失败标记 1），删完 `app_meta` 里没有 `preview_` 残行。
 *
 * 全程离线：本地模型是一枚**装在全局 fetch 上的假 handler**（只截 `127.0.0.1:14555`，其余请求
 * 原样转给真 fetch）；与 m9-4c 的差别是这里的 handler **可以在用例中途换**——S3/S8 要的就是
 * 「先问不成、后来问成」这一条时间线。云端是 `stubTransport` 记录请求体；数据库只落 `TB_DATA_DIR` 沙箱。
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { ensureConfigFile } from "../src/server/config/config.ts";
import type { DataLayout } from "../src/server/config/paths.ts";
import { setMeta } from "../src/server/db/migrator.ts";
import { boot, shutdown, type BootResult } from "../src/server/runtime/bootstrap.ts";
import type { StructuredOutput } from "../src/server/ingest/contract.ts";
import { LOCAL_LLM_FAILURE_KINDS } from "../src/server/privacy/grantService.ts";
import { LOCAL_LLM_POLICY_VERSION, REDACTION_POLICY_VERSION, sha256OfText } from "../src/server/privacy/redaction.ts";
import { seedConceptId } from "../src/shared/contracts/ids.ts";
import {
  OK_ENVELOPE,
  SYSTEM_PROMPT,
  makeAdapter,
  stubTransport,
  type StubTransport,
} from "./helpers/ingestFixtures.ts";
import { makeSandbox, type Sandbox } from "./helpers/sandbox.ts";

/* ── 夹具文本与词面（与 m9-4c 同一句：四层各遮一处）────────────────── */

const RAW = "周末和张三去了蓝山咖啡馆，电话 13800138000，聊聊《星海》，聊了三个小时";
const ZHANG = "张三";
const PHONE = "13800138000";
const CAFE = "蓝山咖啡馆";
const WORK = "《星海》";

const at = (term: string): number => {
  const index = RAW.indexOf(term);
  if (index < 0) throw new Error(`夹具文本里没有 ${term}`);
  return index;
};

/** 假本地模型的回稿：坐标锚定 `RAW` 的 UTF-16 偏移。 */
const MODEL_CANDIDATES = [
  { start: at(CAFE), end: at(CAFE) + CAFE.length, kind: "place", surface: CAFE },
  { start: at(WORK), end: at(WORK) + WORK.length, kind: "work", surface: WORK },
];

/** 结构合法、证据可回锚的最小回稿（与 m9-4c 同一份）。 */
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

const FAKE_LLM_MARK = "127.0.0.1:14555";

function llmProfile(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    enabled: true,
    provider: "ollama",
    base_url: `http://${FAKE_LLM_MARK}/v1`,
    request_timeout_ms: 1000,
    model: "qwen3:8b",
    ...overrides,
  };
}

/* ── 假本地模型服务（可中途换 handler）───────────────────────────── */

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

/** 永不 resolve、只在 abort 时拒绝 ⇒ provider 的超时守卫按下 ⇒ `failureKind:"timeout"`。 */
const hangs: FakeHandler = (init) =>
  new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new Error("The user aborted a request.")));
  });

const restored: (() => void)[] = [];

/**
 * 装上假 handler，并交出 `setHandler`：S3/S8 要的是「同一条链路上模型先坏后好」，
 * m9-4c 那种一装定终身的 handler 表达不了这条时间线。
 */
function installFakeLocalLlm(initial: FakeHandler): FakeLlmState & { setHandler(next: FakeHandler): void } {
  const state: FakeLlmState & { setHandler(next: FakeHandler): void } = {
    calls: 0,
    bodies: [],
    setHandler: (next) => {
      current = next;
    },
  };
  let current = initial;
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    if (!String(input).includes(FAKE_LLM_MARK)) {
      return (real as (a: unknown, b?: RequestInit) => Promise<Response>)(input, init);
    }
    state.calls += 1;
    if (typeof init?.body === "string") state.bodies.push(init.body);
    return current(init);
  }) as unknown as typeof fetch;
  restored.push(() => {
    globalThis.fetch = real;
  });
  return state;
}

/* ── 运行夹具（真 HTTP 面 + 桩云端 transport）────────────────────── */

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
  const box = makeSandbox("tb-m9-4d-pre-");
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
 * 一条 `cloud|local_llm|redacted`（矩阵 #8）的记录。没有 HTTP 入口能把记录设成 `local_llm` 档
 * （M9-4d 才开界面），照 0C 的现场直接写轴列。
 */
async function makeLlmRecord(
  inst: Instance,
  axes: { analysis: string; redaction: string; send: string; mode: string } = {
    analysis: "cloud",
    redaction: "local_llm",
    send: "redacted",
    mode: "cloud_redacted",
  },
): Promise<{ recordId: string; revisionId: string }> {
  const created = await call(inst, "POST", "/api/records", { text: RAW, processing_mode: axes.mode });
  expect(created.status).toBe(201);
  const recordId = created.json.record.id as string;
  inst.booted.db
    .prepare(
      `update capture_record
          set processing_mode = ?, analysis_provider = ?, redaction_mode = ?, send_content_mode = ?
        where id = ?`,
    )
    .run(axes.mode, axes.analysis, axes.redaction, axes.send, recordId);
  // 已确认实体「张三」（与 m9-4c 同一份夹具）：让规则层之外的第二层也有活干，
  // 「回落不降级」才扫得出来——实体记忆遮掉的词面在两份载荷里都必须不存在。
  inst.booted.db
    .prepare(
      `insert into entity (id, entity_type, canonical_name, display_name, lifecycle_status, privacy_level, origin_type, created_at_utc)
       values ('entity_zhang', 'person', ?, ?, 'active', 'normal', 'user_created', '2026-10-29T01:00:00.000Z')`,
    )
    .run(ZHANG, ZHANG);
  const revisionId = inst.booted.records.getRecord(recordId).record.current_revision_id;
  return { recordId, revisionId };
}

/* ── 缓存键面 ─────────────────────────────────────────────────────── */

const RULES_NONCE_KEY = (revisionId: string): string => `preview_v2_nonce:${revisionId}`;
const RULES_PAYLOAD_KEY = (revisionId: string): string => `preview_v2_payload:${revisionId}`;
const LLM_NONCE_KEY = (revisionId: string): string => `preview_llm_v2_nonce:${revisionId}`;
const LLM_PAYLOAD_KEY = (revisionId: string): string => `preview_llm_v2_payload:${revisionId}`;
const LLM_SPANS_KEY = (revisionId: string): string => `preview_llm_v2_spans:${revisionId}`;
/** M9-D-13 的第六枚键：op6 咨询失败的标记，取值是封闭集里的一枚，不带任何文本。 */
const LLM_FAILED_KEY = (revisionId: string): string => `preview_llm_v2_failed:${revisionId}`;

/** 本地模型档那三键（成功路径写的，失败路径一枚都不该写）。 */
const LLM_THREE_KEYS = (revisionId: string): string[] =>
  [LLM_NONCE_KEY(revisionId), LLM_PAYLOAD_KEY(revisionId), LLM_SPANS_KEY(revisionId)].sort();

function previewKeys(inst: Instance): string[] {
  return (inst.booted.db.prepare("select key from app_meta where key like 'preview_%'").all() as { key: string }[])
    .map((row) => row.key)
    .sort();
}

function metaValue(inst: Instance, key: string): string | undefined {
  const row = inst.booted.db.prepare("select value from app_meta where key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

function grantRows(inst: Instance): { payload_sha256: string; policy_version: string }[] {
  return inst.booted.db
    .prepare("select payload_sha256, policy_version from cloud_send_grant order by rowid")
    .all() as { payload_sha256: string; policy_version: string }[];
}

/** 云端那次真的发出去了什么：`stub` 记的是 chat/completions 请求体，取 user 消息本体。 */
function sentUserText(inst: Instance): string {
  const body = JSON.parse(inst.stub.lastBody()) as { messages: { role: string; content: string }[] };
  return body.messages.find((message) => message.role === "user")?.content ?? "";
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
 * S1 征询失败 ⇒ 留标记，且不写本档那三键
 * ════════════════════════════════════════════════════════════════════ */

describe("S1 op6 问不成：409 阻断，只留一枚失败标记，不写任何载荷", () => {
  it("failureKind=timeout ⇒ 409 local_llm_consult_failed、标记在册、规则与 LLM 载荷键一枚不写", async () => {
    const spy = installFakeLocalLlm(hangs);
    const inst = await startInstance(llmProfile());
    const { recordId, revisionId } = await makeLlmRecord(inst);

    const preview = await call(inst, "POST", "/api/ingest/preview", { recordId });
    expect(preview.status).toBe(409);
    expect(preview.json.error).toBe("local_llm_consult_failed");
    expect(preview.json.reason).toBe("timeout");
    expect(spy.calls).toBe(1);

    // 六键里的这一枚：值就是失败类别本身，不是文案（任务 §1「不带任何文本」）。
    const marker = metaValue(inst, LLM_FAILED_KEY(revisionId));
    expect(marker).toBe("timeout");
    expect(LOCAL_LLM_FAILURE_KINDS as readonly string[]).toContain(marker);
    expect(marker).not.toContain(" ");

    // 失败不写任何载荷：写了就等于宣称「这一档跑过并采信了这些区间」。
    expect(LLM_THREE_KEYS(revisionId).map((key) => metaValue(inst, key))).toEqual([undefined, undefined, undefined]);
    expect(previewKeys(inst)).toEqual([LLM_FAILED_KEY(revisionId)]);
  });
});

/* ════════════════════════════════════════════════════════════════════
 * S2 op7 凭标记签发用户看过的那一份
 * ════════════════════════════════════════════════════════════════════ */

describe("S2 有失败标记 ⇒ op7 也阻断，不签规则档授权", () => {
  it("409 local_llm_not_previewed、零授权行、不再咨询模型", async () => {
    const spy = installFakeLocalLlm(hangs);
    const inst = await startInstance(llmProfile());
    const { recordId, revisionId } = await makeLlmRecord(inst);

    const preview = await call(inst, "POST", "/api/ingest/preview", { recordId });
    expect(preview.status).toBe(409);

    const confirmed = await call(inst, "POST", "/api/ingest/confirm-send", { recordId });
    expect(confirmed.status).toBe(409);
    expect(confirmed.json.error).toBe("local_llm_not_previewed");
    expect(spy.calls, "op7 只复现、不咨询").toBe(1);
    expect(grantRows(inst)).toEqual([]);
    expect(metaValue(inst, LLM_FAILED_KEY(revisionId))).toBe("timeout");
  });
});

/* ════════════════════════════════════════════════════════════════════
 * S3 发送前重问成功 ⇒ 四腿闸门 409
 * ════════════════════════════════════════════════════════════════════ */

describe("S3 模型恢复：失败预览 + 未签授权 ⇒ op2 先问成但缺授权（409），重预览后可走通", () => {
  it("op6 阻断 → op2 409 state_conflict（已问成、缺授权）→ op6 复现 → op7 → op2 发出新遮过的那份", async () => {
    const spy = installFakeLocalLlm(hangs);
    const inst = await startInstance(llmProfile());
    const { recordId, revisionId } = await makeLlmRecord(inst);

    const first = await call(inst, "POST", "/api/ingest/preview", { recordId });
    expect(first.status).toBe(409);
    expect(first.json.error).toBe("local_llm_consult_failed");
    expect(spy.calls).toBe(1);

    // 用户没有重新点预览，但本机模型在此期间恢复了。
    spy.setHandler(responds(MODEL_CANDIDATES));
    const denied = await call(inst, "POST", "/api/ingest/parse", { recordId });
    expect(denied.status).toBe(409);
    expect(denied.json.error).toBe("state_conflict");
    expect(spy.calls, "发送前那一次再问是这一批的核心动作").toBe(2);
    expect(inst.stub.callCount(), "拒绝发生在任何外发之前").toBe(0);
    for (const face of [RAW, ZHANG, PHONE, CAFE, WORK]) expect(denied.text).not.toContain(face);

    // 问成了 ⇒ 本档三键落齐、失败标记被清（这两件事是同一次咨询的两半）。
    for (const key of LLM_THREE_KEYS(revisionId)) expect(metaValue(inst, key), key).not.toBeUndefined();
    expect(metaValue(inst, LLM_FAILED_KEY(revisionId))).toBeUndefined();
    expect(metaValue(inst, LLM_PAYLOAD_KEY(revisionId))).toContain("[place_");
    expect(grantRows(inst)).toHaveLength(0);

    // 重新预览：走复现路径，不再问第三次。
    const second = await call(inst, "POST", "/api/ingest/preview", { recordId });
    expect(second.status).toBe(200);
    expect(spy.calls).toBe(2);
    expect(second.json.policyVersion).toBe(LOCAL_LLM_POLICY_VERSION);
    expect(second.json.llmLayer).toMatchObject({ used: true, candidates: 1 });
    expect(second.json.redactedText).not.toContain(CAFE);

    const reconfirmed = await call(inst, "POST", "/api/ingest/confirm-send", { recordId });
    expect(reconfirmed.status).toBe(201);
    expect(reconfirmed.json.policyVersion).toBe(LOCAL_LLM_POLICY_VERSION);
    expect(reconfirmed.json.payloadSha256).toBe(second.json.payloadSha256);

    const parsed = await call(inst, "POST", "/api/ingest/parse", { recordId });
    expect(parsed.status).toBe(200);
    expect(parsed.json.succeeded).toBe(true);
    expect(spy.calls, "确认过之后发送路径不再咨询（复现那一档的自己那份）").toBe(2);
    expect(inst.stub.callCount()).toBe(1);

    const body = inst.stub.lastBody();
    expectNoMaskedSurface(body, second.json.spans);
    expect(sentUserText(inst)).toBe(second.json.payloadText);
    expect(body).toContain("[place_");
    expect(body).not.toContain("[work_");
    expect(grantRows(inst)).toHaveLength(1);
    expect(grantRows(inst).at(-1)).toEqual({
      payload_sha256: second.json.payloadSha256,
      policy_version: LOCAL_LLM_POLICY_VERSION,
    });
  });
});

/* ════════════════════════════════════════════════════════════════════
 * S4 发送前重问仍失败 ⇒ 照发用户看过的那份
 * ════════════════════════════════════════════════════════════════════ */

describe("S4 模型还是问不成：op2 也阻断，零外发、零授权", () => {
  it("op6 与 op2 都 409 local_llm_consult_failed；云端请求计数 0、授权行 0、失败标记留在原地", async () => {
    const spy = installFakeLocalLlm(hangs);
    const inst = await startInstance(llmProfile());
    const { recordId, revisionId } = await makeLlmRecord(inst);

    const preview = await call(inst, "POST", "/api/ingest/preview", { recordId });
    expect(preview.status).toBe(409);
    expect(preview.json.error).toBe("local_llm_consult_failed");
    expect(preview.json.reason).toBe("timeout");

    const parsed = await call(inst, "POST", "/api/ingest/parse", { recordId });
    expect(parsed.status).toBe(409);
    expect(parsed.json.error).toBe("local_llm_consult_failed");
    expect(spy.calls, "op6 一次 + 发送前再问一次，两次都没跑成").toBe(2);
    expect(inst.stub.callCount(), "阻断发生在任何外发之前").toBe(0);
    expect(grantRows(inst)).toEqual([]);

    expect(metaValue(inst, LLM_FAILED_KEY(revisionId)), "重问仍失败：标记留在原地，取值仍是那一类").toBe("timeout");
    for (const key of LLM_THREE_KEYS(revisionId)) expect(metaValue(inst, key), key).toBeUndefined();
    // 六键里只剩失败标记；没有任何载荷被算出来。
    expect(previewKeys(inst)).toEqual([LLM_FAILED_KEY(revisionId)]);
  });
});

/* ════════════════════════════════════════════════════════════════════
 * S5 没预览过就点确认
 * ════════════════════════════════════════════════════════════════════ */

describe("S5 从没预览过的 local_llm 记录直接 op7 ⇒ 409 local_llm_not_previewed，零授权行", () => {
  it("409 + 封闭错误码 + 不透出原文；授权行零条；这一步自己不咨询模型", async () => {
    const spy = installFakeLocalLlm(responds(MODEL_CANDIDATES));
    const inst = await startInstance(llmProfile());
    const { recordId } = await makeLlmRecord(inst);

    const denied = await call(inst, "POST", "/api/ingest/confirm-send", { recordId });
    expect(denied.status).toBe(409);
    expect(denied.json.error).toBe("local_llm_not_previewed");
    expect(denied.json.detail).toContain("请先预览一次");
    for (const face of [RAW, ZHANG, PHONE, CAFE, WORK]) expect(denied.text).not.toContain(face);

    expect(spy.calls, "确认这一步从不咨询模型：它只复现用户看过的那一份").toBe(0);
    expect(grantRows(inst)).toHaveLength(0);
    expect(previewKeys(inst)).toEqual([]);
    const runs = inst.booted.db.prepare("select count(*) as n from parse_run").get() as { n: number };
    expect(runs.n).toBe(0);
  });
});

/* ════════════════════════════════════════════════════════════════════
 * S6 缓存坏了 ⇒ 409 而不是 500
 * ════════════════════════════════════════════════════════════════════ */

describe("S6 采信区间缓存被改坏 ⇒ 409 redaction_tier_cache_missing（不再是通用 500）", () => {
  it("op7 / op2 / 入队三处同一个码，reason=malformed，不透出缓存本体", async () => {
    const spy = installFakeLocalLlm(responds(MODEL_CANDIDATES));
    const inst = await startInstance(llmProfile());
    const { recordId, revisionId } = await makeLlmRecord(inst);

    const preview = await call(inst, "POST", "/api/ingest/preview", { recordId });
    expect(preview.status).toBe(200);
    expect(preview.json.policyVersion).toBe(LOCAL_LLM_POLICY_VERSION);
    expect(spy.calls).toBe(1);

    // 现场只改坏一件事：把采信的区间换成结构不成立的 JSON（不改载荷键，也不动标记）。
    inst.booted.db
      .prepare("update app_meta set value = ? where key = ?")
      .run(JSON.stringify({ not: "an array" }), LLM_SPANS_KEY(revisionId));

    const confirm = await call(inst, "POST", "/api/ingest/confirm-send", { recordId });
    expect(confirm.status).toBe(409);
    expect(confirm.json.error).toBe("redaction_tier_cache_missing");
    expect(confirm.json.reason).toBe("malformed");
    for (const face of [RAW, ZHANG, PHONE, CAFE, WORK]) expect(confirm.text).not.toContain(face);

    const parse = await call(inst, "POST", "/api/ingest/parse", { recordId });
    expect(parse.status).toBe(409);
    expect(parse.json.error).toBe("redaction_tier_cache_missing");
    expect(parse.json.reason).toBe("malformed");

    const enqueue = await call(inst, "POST", "/api/jobs", { recordId });
    expect(enqueue.status).toBe(409);
    expect(enqueue.json.error).toBe("redaction_tier_cache_missing");

    // 三个面都在复现那一步被拦住：缓存坏掉的档既不重问模型，也不降级成规则档冒充。
    expect(spy.calls).toBe(1);
    expect(inst.stub.callCount()).toBe(0);
    expect(grantRows(inst)).toHaveLength(0);
  });
});

/* ════════════════════════════════════════════════════════════════════
 * S7 不外发的那一档：问了也没有对象
 * ════════════════════════════════════════════════════════════════════ */

describe("S7 `local_llm` + `send_content_mode=none` ⇒ 一次都不咨询，且不写失败标记", () => {
  it("op6 200：规则档载荷、sendContentMode=none、模型调用计数 0、只有规则档那两枚键", async () => {
    const spy = installFakeLocalLlm(responds(MODEL_CANDIDATES));
    const inst = await startInstance(llmProfile());
    // 合法组合（§三 矩阵：`none ⇔ provider ≠ cloud`，`local ⇒ redaction ≠ none`）：
    // 这一档承诺脱敏，但这份记录不外发——没有要外发的载荷，问了也没有对象。
    const { recordId, revisionId } = await makeLlmRecord(inst, {
      analysis: "local",
      redaction: "local_llm",
      send: "none",
      mode: "local_model",
    });

    const preview = await call(inst, "POST", "/api/ingest/preview", { recordId });
    expect(preview.status).toBe(200);
    expect(spy.calls, "非脱敏外发轨不咨询模型（判档只在一处：isLocalLlmRedactedTrack）").toBe(0);
    expect(preview.json.sendContentMode).toBe("none");
    expect(preview.json.policyVersion).toBe(REDACTION_POLICY_VERSION);
    expect(preview.json.llmLayer).toMatchObject({ used: false });
    expect(preview.json.spans.filter((s: { source: string }) => s.source === "local_llm")).toHaveLength(0);

    expect(previewKeys(inst)).toEqual([RULES_NONCE_KEY(revisionId), RULES_PAYLOAD_KEY(revisionId)].sort());
    expect(metaValue(inst, LLM_FAILED_KEY(revisionId)), "没问过 ⇒ 没有「问不成」这回事").toBeUndefined();
  });
});

/* ════════════════════════════════════════════════════════════════════
 * S8 硬删除清六键
 * ════════════════════════════════════════════════════════════════════ */

describe("S8 硬删除清掉本档留下的键（LLM 3 + 失败标记 1）", () => {
  it("标记与三键齐备后 DELETE ⇒ app_meta 里没有 preview_ 残行（K-09 不留痕）", async () => {
    const spy = installFakeLocalLlm(hangs);
    const inst = await startInstance(llmProfile());
    const { recordId, revisionId } = await makeLlmRecord(inst);

    // 先问不成（只写失败标记，PD-2 不再写规则载荷），模型恢复后再问一次（写本档三键、清掉标记）。
    const failed = await call(inst, "POST", "/api/ingest/preview", { recordId });
    expect(failed.status).toBe(409);
    expect(failed.json.error).toBe("local_llm_consult_failed");
    expect(previewKeys(inst)).toEqual([LLM_FAILED_KEY(revisionId)]);
    spy.setHandler(responds(MODEL_CANDIDATES));
    const succeeded = await call(inst, "POST", "/api/ingest/preview", { recordId });
    expect(succeeded.json.policyVersion).toBe(LOCAL_LLM_POLICY_VERSION);
    expect(metaValue(inst, LLM_FAILED_KEY(revisionId))).toBeUndefined();
    setMeta(inst.booted.db, LLM_FAILED_KEY(revisionId), "network");

    expect(previewKeys(inst)).toHaveLength(4);
    expect(previewKeys(inst)).toEqual(
      [...LLM_THREE_KEYS(revisionId), LLM_FAILED_KEY(revisionId)].sort(),
    );

    const deleted = await call(inst, "DELETE", `/api/records/${recordId}`);
    expect(deleted.status).toBe(200);
    expect(previewKeys(inst)).toEqual([]);
    expect(metaValue(inst, LLM_FAILED_KEY(revisionId))).toBeUndefined();
    // K-09 的判据是「这个 revision 的痕迹一个不留」：app_meta 里剩下的行与本条记录无关（启动期配置键）。
    const residue = inst.booted.db
      .prepare("select count(*) as n from app_meta where key like ?")
      .get(`%${revisionId}`) as { n: number };
    expect(residue.n).toBe(0);
  });
});
