/**
 * M9-4b 专项测试：`local_llm` 档从「占位、没实现」翻成「已实现，未配置即不可用」。
 *
 * 这一批**只搬闸门**：契约层的占位清单清空（M9-D-11）、守门人换成可读的不可用错误（M9-D-10）、
 * 配置状态一路传到四个调用点与发送前的最后一道门。op6 的首次征询路由、DTO、前端、trace 都不在
 * 本批（M9-4c / M9-4d），所以 U2 的正面路径靠服务层先把采信区间缓存落库来复现 op6 之后的现场。
 *
 * 钉住的五组：
 *  - **U1** 四种「不可用」的配置读数（`not_configured` / `disabled` / `not_loopback` / `no_model`）
 *    ⇒ 四道门（op2 / op6 / op7 / 入队）各抛一次，`reason` 与 `localLlmStatus()` 逐字一致；
 *    发送前的 `assertSendable` 同判据、同 `reason`。
 *  - **U2** 配置可用 ⇒ 门都不抛；HTTP 面因此走到真实装配（预览 200、签发 201、解析 200）。
 *  - **U3** `manual` / `none` 两档在任何配置读数下都不受影响（回归）。
 *  - **U4** 错误消息与 HTTP 响应体里搜不到原文、词面、记录内容（叶子级扫描）。
 *  - **U5** `validateEnums` 对空清单仍然通过，与 `UNIMPLEMENTED_REDACTION_MODES` 的逐值对账仍在
 *    （伪造漂移 ⇒ 装载失败）。
 *
 * 全程离线：数据库只落 `TB_DATA_DIR` 沙箱；「可用」的端点是一个**没人监听的回环地址**——
 * 本批没有请求可发，门只读配置读数，不碰 socket。
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import {
  ensureConfigFile,
  localLlmStatus,
  parseAppConfig,
  type AppConfig,
  type LocalLlmStatus,
} from "../src/server/config/config.ts";
import type { DataLayout } from "../src/server/config/paths.ts";
import { boot, shutdown, type BootResult } from "../src/server/runtime/bootstrap.ts";
import type { ModelAdapter } from "../src/server/ingest/provider.ts";
import {
  RedactionModeUnavailableError,
  assertRedactionPlanRunnable,
  assertSendable,
  type ExtractionRequest,
} from "../src/server/ingest/provider.ts";
import { GrantService } from "../src/server/privacy/grantService.ts";
import {
  LOCAL_LLM_POLICY_VERSION,
  REDACTION_POLICY_VERSION,
  type KnownEntity,
} from "../src/server/privacy/redaction.ts";
import {
  UNIMPLEMENTED_REDACTION_MODES,
  EnumContractError,
  isUnimplementedRedactionMode,
  parseEnums,
  validateEnums,
  type ThreeAxes,
} from "../src/shared/contracts/enums.ts";
import { loadContracts } from "../src/shared/contracts/load.ts";
import { seedConceptId } from "../src/shared/contracts/ids.ts";
import type { StructuredOutput } from "../src/server/ingest/contract.ts";
import {
  OK_ENVELOPE,
  SYSTEM_PROMPT,
  makeAdapter,
  stubTransport,
  type StubTransport,
} from "./helpers/ingestFixtures.ts";
import { makeSandbox, type Sandbox } from "./helpers/sandbox.ts";

/** 一句含可脱敏源的原文：U4 拿它的每个词面反证响应体干净。 */
const RAW_TEXT = "周末和张三去了蓝山咖啡馆，联系方式 13800138000 或 laowang@example.com";
const SECRET_FACES = [RAW_TEXT, "张三", "蓝山咖啡馆", "13800138000", "laowang@example.com", "周末"];

/**
 * 走通链路的原文（U2 / U3）：`parseReply()` 的证据词面「聊了三个小时」在这一段里，
 * 而两档遮的分别是人名与店名——回锚成功与否因此与档位无关，`succeeded` 才只反映「门放行了」。
 */
const CHAIN_TEXT = "周末和张三去了蓝山咖啡馆，聊了三个小时";

/** 结构合法、证据可回锚的最小回稿（夹具的 `validOutput()` 证据属于另一段原文，这里不用它）。 */
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
      {
        labelSaid: "社交",
        candidateConceptId: seedConceptId("朋友与社交"),
        basis: "explicit",
        evidence: "聊了三个小时",
      },
    ],
    entities: [],
    relations: [],
  };
}

const ENTITY_ZHANG: KnownEntity = { entityId: "e_zhang", entityType: "person", terms: ["张三"] };

/** 矩阵 #8（本方案主推路径）：`local_llm` 脱敏 + 云端分析 + 脱敏外发。 */
const AXES_LLM_CLOUD: ThreeAxes = { analysisProvider: "cloud", redactionMode: "local_llm", sendContentMode: "redacted" };
/** 矩阵 #3 / #5：含 `local_llm` 的另外两行合法组合。 */
const AXES_LLM_NONE: ThreeAxes = { analysisProvider: "none", redactionMode: "local_llm", sendContentMode: "none" };
const AXES_LLM_LOCAL: ThreeAxes = { analysisProvider: "local", redactionMode: "local_llm", sendContentMode: "none" };
/** 另外两档：闸门对本批的任何配置读数都无话可说。 */
const AXES_MANUAL: ThreeAxes = { analysisProvider: "cloud", redactionMode: "manual", sendContentMode: "redacted" };
const AXES_NONE: ThreeAxes = { analysisProvider: "cloud", redactionMode: "none", sendContentMode: "raw" };

/* ── 配置读数夹具：四种「不可用」+ 一种「可用」 ───────────────────── */

function llmProfile(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    enabled: true,
    provider: "ollama",
    // 回环 + 有模型名 ⇒ usable。端口没人监听也无妨：本批一次请求都不发。
    base_url: "http://127.0.0.1:11434/v1",
    request_timeout_ms: 30_000,
    model: "qwen3:8b",
    ...overrides,
  };
}

function configWith(localLlm?: Record<string, unknown>): AppConfig {
  return parseAppConfig(
    {
      schema_version: 1,
      server: { host: "127.0.0.1", port: 8737 },
      processing: { default_mode: "manual_only" },
      model: {
        enabled: false,
        provider: "openai_compatible",
        base_url: "https://api.example.invalid/v1",
        cloud_redacted_enabled: false,
        request_timeout_ms: 30_000,
        ...(localLlm === undefined ? {} : { local_llm: localLlm }),
      },
    },
    "inline",
  );
}

/** `reason` 与 `usable` 的对照表：`localLlmStatus` 是唯一事实源，本文件不另抄一份判据。 */
const UNUSABLE_CASES: readonly { label: string; localLlm: Record<string, unknown> | undefined; reason: string }[] = [
  { label: "未配置（整个 profile 缺席）", localLlm: undefined, reason: "not_configured" },
  { label: "已配置但关闭", localLlm: llmProfile({ enabled: false }), reason: "disabled" },
  {
    label: "端点不是回环",
    localLlm: llmProfile({ base_url: "http://192.168.1.9:11434/v1" }),
    reason: "not_loopback",
  },
  { label: "缺 model", localLlm: llmProfile({ model: undefined }), reason: "no_model" },
];

const USABLE: LocalLlmStatus = localLlmStatus(configWith(llmProfile()));

/* ── 运行夹具（真 HTTP 面 + 桩 transport） ────────────────────────── */

interface Instance {
  readonly booted: BootResult;
  readonly box: Sandbox;
  readonly base: string;
  readonly localLlm: Record<string, unknown> | undefined;
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
  if (localLlm !== undefined) {
    (raw.model as Record<string, unknown>).local_llm = localLlm;
  }
  writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
}

async function startInstance(localLlm: Record<string, unknown> | undefined): Promise<Instance> {
  const box = makeSandbox("tb-m9-4b-");
  const port = await freePort();
  writeConfig(box.layout, port, localLlm);
  const stub = stubTransport(OK_ENVELOPE(parseReply()));
  let booted: BootResult;
  try {
    booted = await boot({
      env: { TB_DATA_DIR: box.root, USERPROFILE: box.root, HOME: box.root },
      log: () => {},
      // worker 不启动：入队面只验闸门，不给队列机会改写行的状态。
      startJobsWorker: false,
      ingestProvider: {
        adapter: makeAdapter(),
        transport: stub.transport,
        systemPrompt: SYSTEM_PROMPT,
      },
    });
  } catch (cause) {
    box.cleanup();
    throw cause;
  }
  const inst: Instance = { booted, box, base: `http://127.0.0.1:${port}`, localLlm, stub };
  live.push(inst);
  return inst;
}

afterEach(async () => {
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
 * 一条 `local_llm` 档的记录。默认原文是 U4 的扫描对象（闸门在它发送之前就拒掉，原文是什么都不发）；
 * 走通链路的用例传 `CHAIN_TEXT`。
 */
async function makeLlmRecord(inst: Instance, text = RAW_TEXT): Promise<string> {
  const created = await call(inst, "POST", "/api/records", { text, processing_mode: "cloud_redacted" });
  expect(created.status).toBe(201);
  const recordId = created.json.record.id as string;
  forceLocalLlm(inst, recordId);
  return recordId;
}

/** 没有 HTTP 入口能把记录设成 `local_llm` 档（M9-4d 才开界面），按 0C 的现场直接写轴列。 */
function forceLocalLlm(inst: Instance, recordId: string): void {
  inst.booted.db
    .prepare(
      `update capture_record
          set processing_mode = 'cloud_redacted', analysis_provider = 'cloud', redaction_mode = 'local_llm',
              send_content_mode = 'redacted'
        where id = ?`,
    )
    .run(recordId);
}

/** 四道门：op6 预览、op7 确认、op2 解析、`POST /api/jobs` 手动入队。 */
const FOUR_GATES: readonly { label: string; path: string }[] = [
  { label: "op6 预览", path: "/api/ingest/preview" },
  { label: "op7 确认签发", path: "/api/ingest/confirm-send" },
  { label: "op2 同步解析", path: "/api/ingest/parse" },
  { label: "手动入队", path: "/api/jobs" },
];

/* ── 叶子级扫描：任何字符串叶子都不许带原文词面 ──────────────────── */

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

function expectNoPlainTextLeakage(payload: unknown, message: string): void {
  const leaves = stringLeaves(payload);
  expect(leaves.length, message).toBeGreaterThan(0);
  for (const leaf of leaves) {
    for (const face of SECRET_FACES) {
      expect(leaf, `${message}：叶子字段里出现了词面「${face}」`).not.toContain(face);
    }
  }
}

/* ════════════════════════════════════════════════════════════════════
 * U1 未配置即不可用：四道门 + 发送前的门，reason 与 localLlmStatus 同值
 * ════════════════════════════════════════════════════════════════════ */

describe("U1 不可用的四种读数：门抛 RedactionModeUnavailableError", () => {
  it("门函数层：每种读数的 reason 与 localLlmStatus() 逐字一致", () => {
    for (const testCase of UNUSABLE_CASES) {
      const status = localLlmStatus(configWith(testCase.localLlm));
      expect(status.usable, testCase.label).toBe(false);
      expect(status.reason, testCase.label).toBe(testCase.reason);
      for (const axes of [AXES_LLM_CLOUD, AXES_LLM_NONE, AXES_LLM_LOCAL]) {
        expect(() => assertRedactionPlanRunnable(axes, "rr_gate", status), `${testCase.label} / ${axes.redactionMode}`).toThrow(
          RedactionModeUnavailableError,
        );
        let thrown: unknown;
        try {
          assertRedactionPlanRunnable(axes, "rr_gate", status);
        } catch (cause) {
          thrown = cause;
        }
        // reason 是封闭枚举、且就是状态读数那一个（M9-D-4：分支按枚举，展示按 message）。
        expect((thrown as RedactionModeUnavailableError).reason).toBe(status.reason);
        expect((thrown as RedactionModeUnavailableError).recordRevisionId).toBe("rr_gate");
      }
    }
  });

  it("发送前的门（assertSendable）同判据同 reason；缺省读数按「未配置」拒", () => {
    for (const testCase of UNUSABLE_CASES) {
      const status = localLlmStatus(configWith(testCase.localLlm));
      expect(() => assertSendable(sendRequest(AXES_LLM_CLOUD), makeAdapter(), status)).toThrow(
        RedactionModeUnavailableError,
      );
      let thrown: unknown;
      try {
        assertSendable(sendRequest(AXES_LLM_CLOUD), makeAdapter(), status);
      } catch (cause) {
        thrown = cause;
      }
      expect((thrown as RedactionModeUnavailableError).reason).toBe(status.reason);
    }
    // 拿不到配置的装配点（测试注入、旧调用面）fail-closed：不静默放行。
    let defaulted: unknown;
    try {
      assertSendable(sendRequest(AXES_LLM_CLOUD), makeAdapter());
    } catch (cause) {
      defaulted = cause;
    }
    expect(defaulted).toBeInstanceOf(RedactionModeUnavailableError);
    expect((defaulted as RedactionModeUnavailableError).reason).toBe("not_configured");
  });

  it("HTTP 面：四种读数 × 四道门各 409 redaction_mode_unavailable，reason 逐字一致", async () => {
    for (const testCase of UNUSABLE_CASES) {
      const inst = await startInstance(testCase.localLlm);
      const recordId = await makeLlmRecord(inst);
      const expectedReason = localLlmStatus(inst.booted.loaded.config).reason;
      expect(expectedReason, testCase.label).toBe(testCase.reason);
      for (const gate of FOUR_GATES) {
        const r = await call(inst, "POST", gate.path, { recordId });
        expect(r.status, `${testCase.label} / ${gate.label}`).toBe(409);
        expect(r.json.error, `${testCase.label} / ${gate.label}`).toBe("redaction_mode_unavailable");
        expect(r.json.reason, `${testCase.label} / ${gate.label}`).toBe(expectedReason);
        expect(r.json.detail, `${testCase.label} / ${gate.label}`).toContain("本地模型辅助脱敏");
      }
      // 拒绝不留副作用：没有授权行、没有任务行、一次外发都没发生。
      const grants = inst.booted.db
        .prepare("select count(*) as n from cloud_send_grant")
        .get() as { n: number };
      expect(grants.n, testCase.label).toBe(0);
      const jobs = inst.booted.db.prepare("select count(*) as n from privacy_job").get() as { n: number };
      expect(jobs.n, testCase.label).toBe(0);
      const runs = inst.booted.db.prepare("select count(*) as n from parse_run").get() as { n: number };
      expect(runs.n, testCase.label).toBe(0);
    }
  });
});

function sendRequest(axes: ThreeAxes): ExtractionRequest {
  return {
    recordRevisionId: "rr_send",
    axes,
    processingMode: "cloud_redacted",
    payloadText: "[person_1_a1b2c3]",
    systemPrompt: SYSTEM_PROMPT,
    promptVersion: "m2-prompt-v1",
    outputSchemaVersion: "m2-output-v1",
    contractsFingerprint: "f".repeat(64),
    resolverVersion: "v1",
    validationVersion: "v1",
  };
}

/* ════════════════════════════════════════════════════════════════════
 * U2 配置可用 ⇒ 门不抛；HTTP 因此走到真实装配
 * ════════════════════════════════════════════════════════════════════ */

describe("U2 配置可用：四道门都不抛，链路走到真实预览/签发/解析", () => {
  it("门函数层：usable ⇒ 三行合法组合与发送前的门一律放行", () => {
    expect(USABLE.usable).toBe(true);
    for (const axes of [AXES_LLM_CLOUD, AXES_LLM_NONE, AXES_LLM_LOCAL]) {
      expect(() => assertRedactionPlanRunnable(axes, "rr_ok", USABLE)).not.toThrow();
    }
    expect(() => assertSendable(sendRequest(AXES_LLM_CLOUD), makeAdapter(), USABLE)).not.toThrow();
    // 「可用」的判据仍然只有那三条：enabled ∧ 回环 ∧ model 非空。
    expect(localLlmStatus(configWith(llmProfile({ model: "  " }))).usable).toBe(false);
  });

  it("HTTP 面：可用配置下 op6→op7→op2 逐格走通（本批不征询模型，区间由服务层先落缓存）", async () => {
    const inst = await startInstance(llmProfile());
    const recordId = await makeLlmRecord(inst, CHAIN_TEXT);
    const revisionId = inst.booted.records
      .getRecord(recordId)
      .record.current_revision_id;
    // M9-4c 才是「路由层先问模型」的那次装配。本批用同一入口的等价现场：把采信区间落进
    // `preview_llm_spans`，于是 op6 之后每一跳的复现路径拿到的都是本地模型档那一套缓存。
    // 这里**不**传 `entities`：复现路径按库里的实体记忆现算，缓存载荷必须与它同源，否则
    // 载荷与映射两份凭据对不上，证据回锚会算出越界坐标。
    const cafeStart = CHAIN_TEXT.indexOf("蓝山咖啡馆");
    new GrantService(inst.booted.db).preparePreview(revisionId, {
      tier: "local_llm",
      llmSpans: [{ start: cafeStart, end: cafeStart + "蓝山咖啡馆".length, kind: "organization" }],
    });

    const preview = await call(inst, "POST", "/api/ingest/preview", { recordId });
    expect(preview.status).toBe(200);
    expect(preview.json.policyVersion).toBe(LOCAL_LLM_POLICY_VERSION);
    expect(preview.json.hasApplicableGrant).toBe(false);
    // 载荷确实被本地模型档遮过了：这一档采信的区间进得了待发文本，规则档遮不掉它。
    // （`张三` 不在册于本沙箱的实体记忆，op6 的复现路径按库里的记忆现算，所以它照旧是词面。）
    expect(preview.json.redactedText).not.toContain("蓝山咖啡馆");
    // 遮它的确实是本地模型档那一套区间（占位符形状在，`policyVersion` 已升为 `rules+local_llm-v1`）。
    expect(preview.json.redactedText).toMatch(/\[organization_1_[0-9a-f]{6}\]/);

    const confirmed = await call(inst, "POST", "/api/ingest/confirm-send", { recordId });
    expect(confirmed.status).toBe(201);
    expect(confirmed.json.policyVersion).toBe(LOCAL_LLM_POLICY_VERSION);

    const parse = await call(inst, "POST", "/api/ingest/parse", { recordId });
    expect(parse.status).toBe(200);
    expect(parse.json.succeeded).toBe(true);
    // 门放行之后真的发了一次，且发出去的就是那份遮过的载荷（店面的词面不在线上）。
    expect(inst.stub.callCount()).toBe(1);
    expect(inst.stub.lastBody()).not.toContain("蓝山咖啡馆");

    const queued = await call(inst, "POST", "/api/jobs", { recordId });
    expect(queued.status).toBe(201);
    expect(queued.json.sendContentMode).toBe("redacted");
  });
});

/* ════════════════════════════════════════════════════════════════════
 * U3 另外两档不受影响（回归）
 * ════════════════════════════════════════════════════════════════════ */

describe("U3 manual / none 两档在任何配置读数下都不受闸门影响", () => {
  it("门函数层：四种不可用读数 + 可用读数，manual/none 一律放行", () => {
    const statuses = [
      ...UNUSABLE_CASES.map((t) => localLlmStatus(configWith(t.localLlm))),
      USABLE,
    ];
    for (const status of statuses) {
      for (const axes of [AXES_MANUAL, AXES_NONE]) {
        expect(() => assertRedactionPlanRunnable(axes, "rr_other", status)).not.toThrow();
        expect(() => assertSendable(sendRequest(axes), makeAdapter(), status)).not.toThrow();
      }
    }
  });

  it("HTTP 面：配置「未配置」时传统云端路径 op6/op7/op2 逐字照旧", async () => {
    const inst = await startInstance(undefined);
    const created = await call(inst, "POST", "/api/records", { text: CHAIN_TEXT, processing_mode: "cloud_redacted" });
    const recordId = created.json.record.id as string;
    // A-0 起新建的 cloud_redacted 默认走 local_llm；这一条要测的是 manual 档不受闸门影响，先显式改档。
    const manual = await call(inst, "PATCH", `/api/records/${recordId}/redaction-mode`, { redaction_mode: "manual" });
    expect(manual.status).toBe(200);
    const preview = await call(inst, "POST", "/api/ingest/preview", { recordId });
    expect(preview.status).toBe(200);
    expect(preview.json.policyVersion).toBe(REDACTION_POLICY_VERSION);
    const confirmed = await call(inst, "POST", "/api/ingest/confirm-send", { recordId });
    expect(confirmed.status).toBe(201);
    const parse = await call(inst, "POST", "/api/ingest/parse", { recordId });
    expect(parse.status).toBe(200);
    expect(parse.json.succeeded).toBe(true);
    expect(parse.json.axes.redactionMode).toBe("manual"); // 没有静默改档：走的一直是 manual
    expect(inst.stub.callCount()).toBe(1);
    const queued = await call(inst, "POST", "/api/jobs", { recordId });
    expect(queued.status).toBe(201);
  });
});

/* ════════════════════════════════════════════════════════════════════
 * U4 错误面不泄露原文
 * ════════════════════════════════════════════════════════════════════ */

describe("U4 错误消息与响应体里没有原文、词面、记录内容", () => {
  it("Error.message 只说档位与内部 ID", () => {
    const status = localLlmStatus(configWith(undefined));
    let thrown: unknown;
    try {
      assertRedactionPlanRunnable(AXES_LLM_CLOUD, "rr_leak", status);
    } catch (cause) {
      thrown = cause;
    }
    const message = (thrown as RedactionModeUnavailableError).message;
    expect(message).toContain("本地模型辅助脱敏");
    expect(message).toContain("rr_leak");
    expectNoPlainTextLeakage({ message }, "Error.message");
  });

  it("四道门的响应体逐个叶子扫描：无原文词面、无载荷、无映射", async () => {
    const inst = await startInstance(llmProfile({ enabled: false }));
    const recordId = await makeLlmRecord(inst);
    for (const gate of FOUR_GATES) {
      const r = await call(inst, "POST", gate.path, { recordId });
      expect(r.status, gate.label).toBe(409);
      expectNoPlainTextLeakage(r.json, `${gate.label} 响应体`);
      expect(r.text, gate.label).not.toContain(RAW_TEXT);
      // 错误形状是错误码，不是预览：没有载荷、没有 policyVersion 可供前端点头。
      for (const forbidden of ["payloadText", "redactedText", "policyVersion", "map", "spans", "nonce"]) {
        expect(r.text, `${gate.label} 泄露了 ${forbidden}`).not.toContain(forbidden);
      }
    }
  });
});

/* ════════════════════════════════════════════════════════════════════
 * U5 契约层：空清单是合法且为真，对账机制仍在
 * ════════════════════════════════════════════════════════════════════ */

describe("U5 占位清单为空仍然通过装载，且与代码清单对账", () => {
  it("装载成功：清单为空、取值域三值未动、判定恒 false", () => {
    const contracts = loadContracts();
    expect(contracts.enums.three_axis_rules.placeholder_unimplemented).toEqual([]);
    expect([...UNIMPLEMENTED_REDACTION_MODES]).toEqual([]);
    expect(contracts.enums.redaction_modes).toEqual(["local_llm", "manual", "none"]);
    for (const mode of ["local_llm", "manual", "none"] as const) {
      expect(isUnimplementedRedactionMode(mode)).toBe(false);
    }
  });

  it("schema 允许空数组，但元素级 min(1) 仍在（空串/非字符串进不了清单）", () => {
    const raw = JSON.parse(readFileSync("src/shared/constants/enums.json", "utf8"));
    const rules = raw.three_axis_rules as Record<string, unknown>;
    expect(() => parseEnums(raw)).not.toThrow();
    rules.placeholder_unimplemented = [""];
    expect(() => parseEnums(raw)).toThrow(EnumContractError);
    rules.placeholder_unimplemented = [42];
    expect(() => parseEnums(raw)).toThrow(EnumContractError);
  });

  it("伪造一个占位档（代码清单非空、enums.json 不同步）⇒ 装载失败", () => {
    const list = UNIMPLEMENTED_REDACTION_MODES as unknown as string[];
    list.push("local_llm");
    try {
      const raw = JSON.parse(readFileSync("src/shared/constants/enums.json", "utf8"));
      expect(() => validateEnums(raw)).toThrow(/placeholder_unimplemented/);
    } finally {
      list.pop();
    }
    expect([...UNIMPLEMENTED_REDACTION_MODES]).toEqual([]);
  });

  it("清单为空 ⇒ 契约与实现不可能再对不上（旧漂移面只剩逐值对账一条）", () => {
    const raw = JSON.parse(readFileSync("src/shared/constants/enums.json", "utf8"));
    raw.three_axis_rules.placeholder_unimplemented = ["manual"];
    expect(() => validateEnums(raw)).toThrow(EnumContractError);
  });
});
