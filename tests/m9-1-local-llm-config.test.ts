/**
 * M9-1 本地脱敏模型的配置、状态判定与连接测试（任务拆分与执行准则 §三 C1–C6）。
 *
 * 本批只做**配置层 + 状态判定 + 一个连接测试路由**：不写提示词、不接预览、不改前端、
 * 不翻 `local_llm` 的四道占位门（那是 M9-3/M9-4）。
 *
 * 钉住的六件事：
 *  - **C1** 未配置 / `enabled:false` ⇒ 原因分别是 `not_configured` / `disabled`；
 *  - **C2** 非回环端点 ⇒ `not_loopback`，**且连接测试一次请求都不发**（隐私红线 P-1：
 *    「非回环即未配置」，不是「调用后失败」）；
 *  - **C3** 回环但 `model` 缺席 / 只有空白 ⇒ `no_model`；
 *  - **C4** 严格 schema：`local_llm` 里出现 `runtime` / `context_size` 等未知键 ⇒ 解析失败；
 *  - **C5** 连接测试的成功/降级/失败语义，**且探测请求体里搜不到任何用户原文**；
 *  - **C6** 连接测试前后库零变更、不产生 grant。
 *
 * 后续批次追加的一组（裁决 M9-D-19）：超时的取值域——上限 300000 对三档共享、下限 1000 不动，
 * 本地脱敏档的缺省 90000 由设置页那份空白草稿给出（配置层没有 `.default()`）。
 *
 * 全程离线：探测走注入的假 transport（与常规解析共用同一个装配口子），没有真实模型、没有真实端点。
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import {
  ensureConfigFile,
  localLlmStatus,
  parseAppConfig,
  writeConfigFile,
  type AppConfig,
} from "../src/server/config/config.ts";
import { ConfigError } from "../src/server/config/errors.ts";
import type {
  ProviderTransport,
  TransportRequest,
  TransportResponse,
} from "../src/server/ingest/provider.ts";
import { boot, shutdown, type BootResult } from "../src/server/runtime/bootstrap.ts";
import { countRows, makeSandbox, type Sandbox } from "./helpers/sandbox.ts";

/** 一条真实记录的原文：C5 用它反证探测请求里没有任何用户内容的痕迹。 */
const USER_TEXT = "和张三在上海张江实验室开会，讨论 TBP-SENTINEL-7QX9 的预算";
const USER_FRAGMENTS = ["张三", "上海", "张江", "实验室", "开会", "预算", "TBP-SENTINEL-7QX9"];

/* ── 配置夹具 ─────────────────────────────────────────────────────── */

/** 第三档的最小合法形状（与 `cloud_model` 同形，**不含** `runtime`）。 */
function llmProfile(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    enabled: true,
    provider: "ollama",
    base_url: "http://127.0.0.1:11434/v1",
    request_timeout_ms: 30_000,
    model: "qwen3:8b",
    ...overrides,
  };
}

function baseRaw(port: number, localLlm?: Record<string, unknown>): Record<string, unknown> {
  return {
    schema_version: 1,
    server: { host: "127.0.0.1", port },
    processing: { default_mode: "manual_only" },
    model: {
      enabled: false,
      provider: "openai_compatible",
      base_url: "https://api.example.invalid/v1",
      cloud_redacted_enabled: false,
      request_timeout_ms: 30_000,
      ...(localLlm === undefined ? {} : { local_llm: localLlm }),
    },
  };
}

function parse(localLlm?: Record<string, unknown>): AppConfig {
  return parseAppConfig(baseRaw(8737, localLlm), "inline");
}

/* ── 运行夹具（真 HTTP 面 + 假 transport） ────────────────────────── */

interface RunningApp {
  readonly sandbox: Sandbox;
  readonly booted: BootResult;
  readonly base: string;
  readonly seen: TransportRequest[];
  stop(): Promise<void>;
}

const running: RunningApp[] = [];

async function freePort(): Promise<number> {
  return new Promise((resolvePromise, rejectPromise) => {
    const probe = createServer();
    probe.once("error", rejectPromise);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (address === null || typeof address === "string") {
        rejectPromise(new Error("无法取得空闲端口"));
        return;
      }
      const port = address.port;
      probe.close(() => resolvePromise(port));
    });
  });
}

function envelope(content: string): string {
  return JSON.stringify({ choices: [{ message: { content } }] });
}

const OK_RESPONSE: TransportResponse = { status: 200, body: envelope('{"ok":true}') };

async function start(options: {
  readonly localLlm?: Record<string, unknown>;
  /** 按次序返回；用尽后重复最后一个。缺省是「一次就成」。 */
  readonly responses?: readonly TransportResponse[];
  /** 永不回包、只在 signal abort 时抛出：用来真走超时那条路。 */
  readonly hang?: boolean;
  /** 注入到本次启动的环境（路由读的是这份，不是 process.env）。 */
  readonly env?: NodeJS.ProcessEnv;
} = {}): Promise<RunningApp> {
  const sandbox = makeSandbox("tb-m9-1-");
  mkdirSync(sandbox.layout.dataDir, { recursive: true });
  const port = await freePort();
  const file = ensureConfigFile(sandbox.layout);
  writeFileSync(file, JSON.stringify(baseRaw(port, options.localLlm), null, 2), "utf8");

  const seen: TransportRequest[] = [];
  const responses = options.responses ?? [OK_RESPONSE];
  let cursor = 0;
  const transport: ProviderTransport = {
    async send(request) {
      seen.push(request);
      if (options.hang === true) {
        return new Promise<TransportResponse>((_, rejectPromise) => {
          request.signal.addEventListener("abort", () => rejectPromise(new Error("aborted")), {
            once: true,
          });
        });
      }
      const response = responses[Math.min(cursor, responses.length - 1)] ?? OK_RESPONSE;
      cursor += 1;
      return response;
    },
  };

  const env: NodeJS.ProcessEnv = {
    TB_DATA_DIR: sandbox.root,
    USERPROFILE: sandbox.root,
    HOME: sandbox.root,
    ...options.env,
  };
  let booted: BootResult;
  try {
    booted = await boot({
      env,
      log: () => {},
      ingestProvider: {
        adapter: {
          provider: "test-provider",
          model: "test-model",
          baseUrl: "http://127.0.0.1:11434/v1",
          callPath: "ollama_openai_compatible",
          supportsStructuredOutput: false,
          requestTimeoutMs: 2000,
        },
        transport,
        systemPrompt: "test-system-prompt",
      },
    });
  } catch (cause) {
    sandbox.cleanup();
    throw cause;
  }
  const app: RunningApp = {
    sandbox,
    booted,
    base: `http://127.0.0.1:${port}`,
    seen,
    async stop() {
      await shutdown(booted);
      sandbox.cleanup();
    },
  };
  running.push(app);
  return app;
}

async function callJson(
  app: RunningApp,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(body);
  }
  const response = await fetch(`${app.base}${path}`, init);
  const text = await response.text();
  return { status: response.status, json: text === "" ? null : JSON.parse(text) };
}

async function postJson(
  app: RunningApp,
  path: string,
): Promise<{ status: number; json: any }> {
  return callJson(app, "POST", path);
}

async function createRecord(app: RunningApp, text: string): Promise<void> {
  const created = await fetch(`${app.base}/api/records`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
  expect(created.status).toBe(201);
}

function putProfile(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    enabled: false,
    provider: "openai_compatible",
    model: "test-model",
    baseUrl: "http://127.0.0.1:11434/v1",
    callPath: "ollama_openai_compatible",
    supportsStructuredOutput: false,
    requestTimeoutMs: 5000,
    ...overrides,
  };
}

function diskConfig(app: RunningApp): Record<string, unknown> {
  return JSON.parse(readFileSync(app.sandbox.layout.configFile, "utf8")) as Record<string, unknown>;
}

afterEach(async () => {
  while (running.length > 0) await running.pop()!.stop();
});

/* ══════════════════════════════════════════════════════════════════
 * C1 / C3 状态判定（纯函数）
 * ══════════════════════════════════════════════════════════════════ */

describe("M9-1 C1 未配置与未启用", () => {
  it("没有 model.local_llm ⇒ not_configured，且拿不到 profile", () => {
    expect(localLlmStatus(parse())).toEqual({
      configured: false,
      loopback: false,
      usable: false,
      reason: "not_configured",
      profile: null,
    });
  });

  it("配好了但 enabled:false ⇒ disabled（配置在场，能力不在场）", () => {
    const status = localLlmStatus(parse(llmProfile({ enabled: false })));
    expect(status.configured).toBe(true);
    expect(status.usable).toBe(false);
    expect(status.reason).toBe("disabled");
    expect(status.profile?.model).toBe("qwen3:8b");
  });

  it("齐备 ⇒ usable、无原因，profile 就是配置里那一份（不另造平行形状）", () => {
    const config = parse(llmProfile({ supports_structured_output: true }));
    const status = localLlmStatus(config);
    expect(status).toMatchObject({ configured: true, loopback: true, usable: true });
    expect(status.reason).toBeUndefined();
    expect(status.profile).toEqual(config.model.local_llm);
  });
});

describe("M9-1 C3 回环但缺模型", () => {
  it("省略 model ⇒ no_model", () => {
    expect(localLlmStatus(parse(llmProfile({ model: undefined }))).reason).toBe("no_model");
  });

  it("model 只有空白 ⇒ no_model（schema 的 min(1) 拦得住空串，拦不住空格）", () => {
    expect(localLlmStatus(parse(llmProfile({ model: "   " }))).reason).toBe("no_model");
  });

  it("空串根本进不了配置层：schema 先拒", () => {
    expect(() => parse(llmProfile({ model: "" }))).toThrow(ConfigError);
  });
});

/* ══════════════════════════════════════════════════════════════════
 * C2 非回环
 * ══════════════════════════════════════════════════════════════════ */

describe("M9-1 C2 非回环端点", () => {
  it.each([
    "http://192.168.1.9:8080",
    "http://example.com",
    "https://localhost.evil.com",
    "http://127.0.0.2:11434/v1",
  ])("%s ⇒ not_loopback", (baseUrl) => {
    const status = localLlmStatus(parse(llmProfile({ base_url: baseUrl })));
    expect(status.loopback).toBe(false);
    expect(status.usable).toBe(false);
    expect(status.reason).toBe("not_loopback");
  });

  it("回环写法一律放行：判定既没放宽到局域网，也没收紧成只认 127.0.0.1", () => {
    for (const baseUrl of [
      "http://127.0.0.1:11434/v1",
      "http://localhost:8080/v1",
      "http://[::1]:8080/v1",
    ]) {
      expect(localLlmStatus(parse(llmProfile({ base_url: baseUrl }))).loopback).toBe(true);
    }
  });

  it("配置层不因非回环而拒绝解析：这一档要能在设置页被解释成「为什么不可用」", () => {
    expect(() => parse(llmProfile({ base_url: "http://192.168.1.9:8080" }))).not.toThrow();
  });
});

/* ══════════════════════════════════════════════════════════════════
 * C4 严格 schema
 * ══════════════════════════════════════════════════════════════════ */

describe("M9-1 C4 local_llm 的严格 schema", () => {
  it.each(["runtime", "context_size", "model_path", "quantization"])(
    "未知键 %s ⇒ ConfigError，字段路径点到 local_llm",
    (key) => {
      let error: unknown;
      try {
        parse(llmProfile({ [key]: "whatever" }));
      } catch (cause) {
        error = cause;
      }
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).fields.join("\n")).toContain("model.local_llm");
    },
  );

  it("连 runtime=external_http 也不放行：这一档没有运行时判别字段，复用同形即严格", () => {
    expect(() => parse(llmProfile({ runtime: "external_http" }))).toThrow(ConfigError);
  });

  it("api_key_env 不被收敛成默认变量名：本阶段界面不存键，配置里写了就按它读环境变量", () => {
    expect(parse(llmProfile({ api_key_env: "TB_LOCAL_LLM_KEY" })).model.local_llm?.api_key_env).toBe(
      "TB_LOCAL_LLM_KEY",
    );
  });

  it("writeConfigFile 往返：local_llm 一字不改地落盘", () => {
    const sandbox = makeSandbox("tb-m9-1-config-");
    try {
      mkdirSync(sandbox.layout.dataDir, { recursive: true });
      const file = ensureConfigFile(sandbox.layout);
      const profile = llmProfile({ supports_structured_output: true });
      writeConfigFile(file, parse(profile));
      const reread = JSON.parse(readFileSync(file, "utf8")) as { model: Record<string, unknown> };
      expect(reread.model.local_llm).toEqual(profile);
    } finally {
      sandbox.cleanup();
    }
  });
});

/* ══════════════════════════════════════════════════════════════════
 * M9-6a 超时的取值域（裁决 M9-D-19：上限抬到 300000，下限 1000 不动）
 * ══════════════════════════════════════════════════════════════════ */

describe("M9-6a 配置层超时取值域", () => {
  it("300000 是合法的上限本身：能解析，也能原样落盘回读", () => {
    const sandbox = makeSandbox("tb-m9-6a-");
    try {
      mkdirSync(sandbox.layout.dataDir, { recursive: true });
      const file = ensureConfigFile(sandbox.layout);
      const profile = llmProfile({ request_timeout_ms: 300_000 });
      const parsed = parse(profile);
      writeConfigFile(file, parsed);
      const reread = JSON.parse(readFileSync(file, "utf8")) as { model: Record<string, any> };
      expect(reread.model.local_llm.request_timeout_ms).toBe(300_000);
    } finally {
      sandbox.cleanup();
    }
  });

  it("下限 1000 一个字节没动：1000 仍在域内", () => {
    expect(parse(llmProfile({ request_timeout_ms: 1000 })).model.local_llm?.request_timeout_ms).toBe(
      1000,
    );
  });

  it.each([
    ["高于新上限 300000", 300_001],
    ["低于下限 1000", 999],
  ])("request_timeout_ms = %s ⇒ ConfigError", (_label, ms) => {
    expect(() => parse(llmProfile({ request_timeout_ms: ms }))).toThrow(ConfigError);
  });

  it("上限对三档共享：手写配置里另两档也收 300000", () => {
    // 这一条测的是**配置层** schema（读文件那条路）。设置页那条保存路径会把
    // `primary.request_timeout_ms` 镜像进顶层旧字段，两份上限已由 M9-6a-2 对齐——正面断言见
    // `tests/m9-4d-1-local-llm-save.test.ts` 的「M9-6a-2 裁决落地」。
    const raw = baseRaw(8737);
    const model = raw.model as Record<string, unknown>;
    model.local_model = llmProfile({ request_timeout_ms: 300_000 });
    model.cloud_model = llmProfile({ enabled: false, request_timeout_ms: 300_000 });
    const parsed = parseAppConfig(raw, "inline");
    expect(parsed.model.local_model?.request_timeout_ms).toBe(300_000);
    expect(parsed.model.cloud_model?.request_timeout_ms).toBe(300_000);
    // 顶层那个旧字段是另一份 schema，这里没提交它，保持手写配置里的原值。
    expect(parsed.model.request_timeout_ms).toBe(30_000);
  });
});

/* ══════════════════════════════════════════════════════════════════
 * C2（路由）——不可用即一次都不发
 * ══════════════════════════════════════════════════════════════════ */

describe("M9-1 连接测试路由：不可用 ⇒ 零请求 + 回枚举本身", () => {
  const unusableCases: readonly [string, Record<string, unknown>, string][] = [
    ["enabled:false", llmProfile({ enabled: false }), "disabled"],
    ["局域网地址", llmProfile({ base_url: "http://192.168.1.9:8080" }), "not_loopback"],
    ["公网地址", llmProfile({ base_url: "http://example.com/v1" }), "not_loopback"],
    ["伪装成 localhost 前缀", llmProfile({ base_url: "https://localhost.evil.com" }), "not_loopback"],
    ["缺模型 ID", llmProfile({ model: undefined }), "no_model"],
  ];

  for (const [label, profile, reason] of unusableCases) {
    it(`${label} ⇒ 200 + ${reason}，且假 transport 一次都没被调用`, async () => {
      const app = await start({ localLlm: profile });
      const response = await postJson(app, "/api/ingest/local-llm/test");
      expect(response.status).toBe(200);
      // M9-D-4 之后这条形状是五键：`message` 是人话那一栏，`reason` 只剩枚举。
      // 仍用 `toEqual` 而不是 `toMatchObject`——「不多不少这几个键」本来就是这条断言的意义。
      expect(response.json).toEqual({
        usable: false,
        reason,
        message: expect.any(String),
        structuredOutput: null,
        latencyMs: 0,
      });
      expect(app.seen).toHaveLength(0);
    });
  }

  it("未配置 ⇒ 200 + not_configured + 零请求", async () => {
    const app = await start();
    const response = await postJson(app, "/api/ingest/local-llm/test");
    expect(response.json).toEqual({
      usable: false,
      reason: "not_configured",
      message: expect.any(String),
      structuredOutput: null,
      latencyMs: 0,
    });
    expect(app.seen).toHaveLength(0);
  });
});

/* ══════════════════════════════════════════════════════════════════
 * C5 探测语义
 * ══════════════════════════════════════════════════════════════════ */

describe("M9-1 C5 连接测试的探测语义", () => {
  it("回环 + 200 ⇒ usable:true；请求体只有固定占位文本，且不带密钥", async () => {
    const app = await start({ localLlm: llmProfile() });
    const response = await postJson(app, "/api/ingest/local-llm/test");

    expect(response.status).toBe(200);
    expect(response.json).toMatchObject({ usable: true, structuredOutput: false });
    expect(typeof response.json.latencyMs).toBe("number");
    expect(app.seen).toHaveLength(1);
    expect(app.seen[0]?.url).toBe("http://127.0.0.1:11434/v1/chat/completions");
    expect(app.seen[0]?.redirect).toBe("error");
    expect(app.seen[0]?.headers).not.toHaveProperty("authorization");
    expect(app.seen[0]?.body).toEqual({
      model: "qwen3:8b",
      messages: [
        { role: "system", content: "这是模型服务连通性检查，不涉及用户记录。" },
        { role: "user", content: '请只回复 JSON：{"ok":true}' },
      ],
      stream: false,
    });
  });

  it("声明支持结构化 ⇒ 带 response_format 一次走通，结论为 true", async () => {
    const app = await start({ localLlm: llmProfile({ supports_structured_output: true }) });
    const response = await postJson(app, "/api/ingest/local-llm/test");
    expect(response.json).toMatchObject({ usable: true, structuredOutput: true });
    expect(app.seen).toHaveLength(1);
    expect(app.seen[0]?.body.response_format).toEqual({ type: "json_object" });
  });

  it("结构化被拒 ⇒ 不带 response_format 再试一次，走通则结论为 false", async () => {
    const app = await start({
      localLlm: llmProfile({ supports_structured_output: true }),
      responses: [
        { status: 400, body: JSON.stringify({ error: "response_format unsupported" }) },
        { status: 200, body: envelope("pong") },
      ],
    });
    const response = await postJson(app, "/api/ingest/local-llm/test");
    expect(response.json).toMatchObject({ usable: true, structuredOutput: false });
    expect(app.seen).toHaveLength(2);
    expect(app.seen[0]?.body).toHaveProperty("response_format");
    expect(app.seen[1]?.body).not.toHaveProperty("response_format");
  });

  it("两条路都不通 ⇒ usable:false + 类别是枚举（纯提示词那一次），两次句子进 message", async () => {
    const app = await start({
      localLlm: llmProfile({ supports_structured_output: true }),
      responses: [{ status: 500, body: JSON.stringify({ error: "boom" }) }],
    });
    const response = await postJson(app, "/api/ingest/local-llm/test");
    expect(response.json).toMatchObject({ usable: false, structuredOutput: null });
    // M9-D-4：`reason` 只能是封闭取值，句子在 `message` 里。
    expect(response.json.reason).toBe("provider_unavailable");
    expect(response.json.message).toContain("两次探测都失败");
    expect(app.seen).toHaveLength(2);
  });

  it.each([
    [401, "auth_failed", "密钥"],
    [404, "model_not_found", "模型"],
    [429, "rate_limited", "限流"],
    [500, "provider_unavailable", "不可用"],
  ])("HTTP %i ⇒ usable:false + reason=%s，文案在 message 里点到问题本身", async (status, reason, needle) => {
    const app = await start({
      localLlm: llmProfile(),
      responses: [{ status, body: JSON.stringify({ error: "nope" }) }],
    });
    const response = await postJson(app, "/api/ingest/local-llm/test");
    expect(response.status).toBe(200);
    expect(response.json).toMatchObject({ usable: false, structuredOutput: null });
    expect(response.json.reason).toBe(reason);
    expect(response.json.message).toContain(needle);
    expect(app.seen).toHaveLength(1);
  });

  it("响应不是可识别的模型信封 ⇒ usable:false", async () => {
    const app = await start({
      localLlm: llmProfile(),
      responses: [{ status: 200, body: "<html>gateway</html>" }],
    });
    const response = await postJson(app, "/api/ingest/local-llm/test");
    expect(response.json).toMatchObject({ usable: false });
    expect(response.json.reason).toBe("invalid_response");
    expect(response.json.message).toContain("不是可识别的模型响应");
  });

  it("超时 ⇒ usable:false，超时用的是配置里的 request_timeout_ms", async () => {
    const app = await start({ localLlm: llmProfile({ request_timeout_ms: 1000 }), hang: true });
    const response = await postJson(app, "/api/ingest/local-llm/test");
    expect(response.json).toMatchObject({ usable: false, structuredOutput: null });
    expect(response.json.reason).toBe("timeout");
    expect(response.json.message).toContain("超时（1000ms）");
    expect(app.seen).toHaveLength(1);
  });

  it("探测请求里搜不到任何用户原文（库里有一条真实记录作对照）", async () => {
    const app = await start({
      localLlm: llmProfile({ supports_structured_output: true }),
      responses: [
        { status: 400, body: JSON.stringify({ error: "no json schema" }) },
        { status: 200, body: envelope("pong") },
      ],
    });
    await createRecord(app, USER_TEXT);

    const response = await postJson(app, "/api/ingest/local-llm/test");
    expect(response.json).toMatchObject({ usable: true });
    expect(app.seen).toHaveLength(2);
    for (const request of app.seen) {
      const wire = JSON.stringify({ url: request.url, headers: request.headers, body: request.body });
      expect(wire).not.toContain(USER_TEXT);
      for (const fragment of USER_FRAGMENTS) expect(wire).not.toContain(fragment);
    }
    expect(JSON.stringify(response.json)).not.toContain(USER_TEXT);
  });

  it("配了 api_key_env ⇒ 从本次启动的环境变量取键，且密钥不回显在响应里", async () => {
    const app = await start({
      localLlm: llmProfile({ api_key_env: "TB_M9_1_PROBE_KEY" }),
      env: { TB_M9_1_PROBE_KEY: "sk-local-llm-probe" },
    });
    const response = await postJson(app, "/api/ingest/local-llm/test");
    expect(response.json).toMatchObject({ usable: true });
    expect(app.seen[0]?.headers.authorization).toBe("Bearer sk-local-llm-probe");
    expect(JSON.stringify(response.json)).not.toContain("sk-local-llm-probe");
  });
});

/* ══════════════════════════════════════════════════════════════════
 * C6 零写入
 * ══════════════════════════════════════════════════════════════════ */

describe("M9-1 C6 连接测试不写任何业务状态", () => {
  function snapshot(app: RunningApp): Record<string, number> {
    return {
      app_meta: countRows(app.booted.db, "app_meta"),
      entity: countRows(app.booted.db, "entity"),
      capture_record: countRows(app.booted.db, "capture_record"),
      cloud_send_grant: countRows(app.booted.db, "cloud_send_grant"),
      parse_run: countRows(app.booted.db, "parse_run"),
      privacy_job: countRows(app.booted.db, "privacy_job"),
    };
  }

  it("前后计数一字不动，且不产生 grant", async () => {
    const app = await start({ localLlm: llmProfile({ supports_structured_output: true }) });
    await createRecord(app, USER_TEXT);
    const before = snapshot(app);

    expect((await postJson(app, "/api/ingest/local-llm/test")).json).toMatchObject({ usable: true });
    expect((await postJson(app, "/api/ingest/local-llm/test")).json).toMatchObject({ usable: true });

    expect(snapshot(app)).toEqual(before);
    expect(before.cloud_send_grant).toBe(0);
  });

  it("不可用的那次同样零请求、零写入", async () => {
    const app = await start({ localLlm: llmProfile({ base_url: "http://192.168.1.9:8080" }) });
    await createRecord(app, USER_TEXT);
    const before = snapshot(app);
    expect((await postJson(app, "/api/ingest/local-llm/test")).json).toMatchObject({ usable: false });
    expect(snapshot(app)).toEqual(before);
    expect(app.seen).toHaveLength(0);
  });

  it("配置文件没被连接测试改写（探测不保存、不落盘）", async () => {
    const app = await start({ localLlm: llmProfile() });
    const before = readFileSync(app.sandbox.layout.configFile, "utf8");
    expect((await postJson(app, "/api/ingest/local-llm/test")).json).toMatchObject({ usable: true });
    expect(readFileSync(app.sandbox.layout.configFile, "utf8")).toBe(before);
  });
});

/* ══════════════════════════════════════════════════════════════════
 * 与既有保存路径的相容性（新增字段不该被整份重建的 model 抹掉）
 * ══════════════════════════════════════════════════════════════════ */

describe("M9-1 既有保存路径不吃掉 local_llm", () => {
  it("PUT /api/ingest/config 重建 model 时把手写的 local_llm 原样带回去", async () => {
    const profile = llmProfile({ supports_structured_output: true });
    const app = await start({ localLlm: profile });
    const saved = await callJson(app, "PUT", "/api/ingest/config", {
      localModel: putProfile(),
      cloudModel: putProfile(),
    });
    expect(saved.status).toBe(200);

    expect(diskConfig(app).model).toMatchObject({ local_llm: profile });
    expect(localLlmStatus(app.booted.loaded.config).usable).toBe(true);
    expect((await postJson(app, "/api/ingest/local-llm/test")).json).toMatchObject({
      usable: true,
      structuredOutput: true,
    });
  });

  it("没有 local_llm 时保存不凭空造出一档", async () => {
    const app = await start();
    const saved = await callJson(app, "PUT", "/api/ingest/config", {
      localModel: putProfile(),
      cloudModel: putProfile(),
    });
    expect(saved.status).toBe(200);
    expect(diskConfig(app).model).not.toHaveProperty("local_llm");
    expect(localLlmStatus(app.booted.loaded.config).reason).toBe("not_configured");
  });
});
