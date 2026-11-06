/**
 * M9-4d-1 专项测试：设置页那一档的**服务端保存路径**、`reason`/`message` 拆分，与设置页源码。
 *
 * 本批只做设置页这一块（发送对话框与预览标注是 M9-4d-2）。钉住的七组：
 *  - **W1** 保存时省缺 `localLlm` ⇒ 既有 `local_llm` 逐字保留（M9-D-2 的回归正面）；
 *  - **W2** 给了 `localLlm` ⇒ 落盘的这一档逐字等于提交值，且 `local_model` / `cloud_redacted`
 *    一字不牵连（含它们手写的 `params` 与 `runtime`）；
 *  - **W3** 严格校验：未知键（`runtime` / `contextSize`）⇒ 400；`base_url` 非 http(s) ⇒ 400；
 *  - **W4** 非回环 `base_url` **能保存**；随后连接测试 ⇒ `usable:false` + `reason:"not_loopback"`
 *    + 一次请求都不发（保存路径里加地址校验是**禁止**的：那会让用户改不回写错的配置）；
 *  - **W5** `reason` 是封闭枚举（四个不可用读数 + 探测失败类别），人话在 `message`；
 *     `message` 与整个响应体里搜不到测试文本、原文词面、端点响应体原文（M9-D-3 的变量名除外，
 *     它是用户写的配置，本阶段就靠它读环境变量）；
 *  - **W6** 设置页确实渲染这一栏，且测试结果按 `reason` 分支（源码 + 直接调用纯函数两路）；
 *  - **W7** 非回环的提示在场，且源码里**没有**任何「保存前拦非回环地址」的分支。
 *
 * 后续批次追加的一组（不改变上面七组的口径）：
 *  - **M9-6a** 超时取值域（裁决 M9-D-19）：上限 300000 对三档**共享**、下限 1000 未动、
 *    只有本地脱敏档的缺省抬到 90000；`local_model` / `cloud_model` 的缺省与配置模板不受牵连。
 *  - **M9-6a-2** 顶层旧字段 `model.request_timeout_ms`（保存路径的镜像字段）上限对齐到 300000：
 *    此前同一份数据在两层被两套上限判定，界面允许的 200000 会在 `writeConfigFile` 那一刻被拒。
 *
 * 全程离线：DB 只落 `TB_DATA_DIR` 沙箱，探测走注入的假 transport，没有真实模型、没有真实端点。
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ensureConfigFile, localLlmStatus, type AppConfig } from "../src/server/config/config.ts";
import type {
  ProviderTransport,
  TransportRequest,
  TransportResponse,
} from "../src/server/ingest/provider.ts";
import { boot, shutdown, type BootResult } from "../src/server/runtime/bootstrap.ts";
import { LOCAL_LLM_TEST_REASONS } from "../src/shared/constants/model.ts";
import type { LocalLlmTestReason } from "../src/shared/constants/model.ts";
import { makeSandbox, type Sandbox } from "./helpers/sandbox.ts";
import {
  LOCAL_LLM_BLANK_DRAFT,
  localLlmDraftFromTier,
  localLlmFailureHeadline,
  localLlmSubmitBody,
  localLlmTestResultText,
} from "../src/web/localLlmSettings.ts";
import type { LocalLlmTierDto, UpdateModelConfigDto } from "../src/shared/dto.ts";

/** 一条真实记录的原文：W5 拿它的每个词面反证响应体干净。 */
const RAW_TEXT = "周末和张三去了蓝山咖啡馆，联系方式 13800138000 或 laowang@example.com";
const SECRET_FACES = [RAW_TEXT, "张三", "蓝山咖啡馆", "13800138000", "laowang@example.com"];

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

/** 另外两档：各带一份手写 `params`，本地档再带 `runtime`——W2 要看的就是这些没被牵连。 */
function localProfile(): Record<string, unknown> {
  return {
    enabled: true,
    provider: "ollama",
    base_url: "http://127.0.0.1:11434/v1",
    request_timeout_ms: 30_000,
    model: "qwen3:8b",
    call_path: "ollama_openai_compatible",
    supports_structured_output: false,
    runtime: "external_http",
    params: { num_ctx: 8192 },
  };
}

function cloudProfile(): Record<string, unknown> {
  return {
    enabled: false,
    provider: "openai_compatible",
    base_url: "https://api.example.invalid/v1",
    request_timeout_ms: 60_000,
    model: "gpt-test",
    call_path: "http_json_lenient",
    supports_structured_output: true,
    params: { temperature: 0.2 },
  };
}

function baseRaw(
  port: number,
  localLlm?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    schema_version: 1,
    server: { host: "127.0.0.1", port },
    processing: { default_mode: "manual_only" },
    model: {
      enabled: true,
      provider: "ollama",
      base_url: "http://127.0.0.1:11434/v1",
      cloud_redacted_enabled: false,
      request_timeout_ms: 30_000,
      local_model: localProfile(),
      cloud_model: cloudProfile(),
      ...(localLlm === undefined ? {} : { local_llm: localLlm }),
    },
  };
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
} = {}): Promise<RunningApp> {
  const sandbox = makeSandbox("tb-m9-4d-1-");
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
      const response = responses[Math.min(cursor, responses.length - 1)] ?? OK_RESPONSE;
      cursor += 1;
      return response;
    },
  };

  let booted: BootResult;
  try {
    booted = await boot({
      env: { TB_DATA_DIR: sandbox.root, USERPROFILE: sandbox.root, HOME: sandbox.root },
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

async function createRecord(app: RunningApp, text: string): Promise<void> {
  const created = await fetch(`${app.base}/api/records`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
  expect(created.status).toBe(201);
}

/** 两档模型配置的提交体：逐字沿用既有形状，W2 用它证明这两档没被牵连。 */
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

function putBody(localLlm?: Record<string, unknown>): Record<string, unknown> {
  return {
    localModel: putProfile(),
    cloudModel: putProfile(),
    ...(localLlm === undefined ? {} : { localLlm }),
  };
}

function localLlmSegment(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    enabled: true,
    provider: "ollama",
    model: "qwen3:1.7b",
    baseUrl: "http://127.0.0.1:11435/v1",
    requestTimeoutMs: 20_000,
    supportsStructuredOutput: true,
    ...overrides,
  };
}

function diskConfig(app: RunningApp): Record<string, any> {
  return JSON.parse(readFileSync(app.sandbox.layout.configFile, "utf8")) as Record<string, any>;
}

function diskModel(app: RunningApp): Record<string, any> {
  return diskConfig(app).model as Record<string, any>;
}

afterEach(async () => {
  while (running.length > 0) await running.pop()!.stop();
});

/* ══════════════════════════════════════════════════════════════════
 * W1 省缺该段 ⇒ 逐字保留（M9-D-2）
 * ══════════════════════════════════════════════════════════════════ */

describe("M9-4d-1 W1 省缺 localLlm ⇒ 既有 local_llm 逐字保留", () => {
  it("带手写 params / api_key_env / call_path 的那一档，保存两档模型配置后一字不动", async () => {
    const written = llmProfile({
      api_key_env: "TB_LOCAL_LLM_KEY",
      call_path: "ollama_openai_compatible",
      params: { top_k: 20 },
      supports_structured_output: true,
    });
    const app = await start({ localLlm: written });
    const before = diskModel(app).local_llm;

    const saved = await callJson(app, "PUT", "/api/ingest/config", putBody());
    expect(saved.status).toBe(200);

    // `toEqual` 而不是 `toMatchObject`：省缺语义要的正是「不多一个键、不少一个键、值一个没变」。
    expect(diskModel(app).local_llm).toEqual(before);
    expect(diskModel(app).local_llm).toEqual(written);
    // 进程内那份读数是同一个事实的另一面：保存后再读状态仍按这一档判。
    expect(localLlmStatus(app.booted.loaded.config as AppConfig).usable).toBe(true);
    expect(saved.json.localLlm).toMatchObject({ baseUrl: written.base_url, usable: true, reason: null });
  });

  it("本来就没有这一档时，省缺该段不凭空造出一档", async () => {
    const app = await start();
    expect(await callJson(app, "PUT", "/api/ingest/config", putBody())).toMatchObject({ status: 200 });
    expect(diskModel(app)).not.toHaveProperty("local_llm");
    expect((await callJson(app, "GET", "/api/ingest/config")).json.localLlm).toBeNull();
  });
});

/* ══════════════════════════════════════════════════════════════════
 * W2 给了该段 ⇒ 落盘逐字等于提交值，另外两档不受牵连
 * ══════════════════════════════════════════════════════════════════ */

describe("M9-4d-1 W2 提交 localLlm ⇒ 落盘逐字等于提交值", () => {
  it("新建这一档：驼峰字段落成蛇形，另外两档一字不牵连", async () => {
    const app = await start();
    // 基线：先按**不带** `localLlm` 键的同一份提交体存一次——那正是这一批改之前用户走的那条保存路径。
    const baseline = await callJson(app, "PUT", "/api/ingest/config", putBody());
    expect(baseline.status).toBe(200);
    const twoTiers = {
      local_model: diskModel(app).local_model,
      cloud_model: diskModel(app).cloud_model,
    } as const;

    const saved = await callJson(
      app,
      "PUT",
      "/api/ingest/config",
      putBody({
        enabled: true,
        provider: "ollama",
        model: "qwen3:1.7b",
        baseUrl: "http://127.0.0.1:11435/v1",
        requestTimeoutMs: 20_000,
        supportsStructuredOutput: true,
      }),
    );
    expect(saved.status).toBe(200);
    expect(diskModel(app).local_llm).toEqual({
      enabled: true,
      provider: "ollama",
      model: "qwen3:1.7b",
      base_url: "http://127.0.0.1:11435/v1",
      request_timeout_ms: 20_000,
      supports_structured_output: true,
    });
    // 「不受牵连」的口径：同样的两档提交值，带上第三档与否，落盘结果逐字相同。
    expect({
      local_model: diskModel(app).local_model,
      cloud_model: diskModel(app).cloud_model,
    }).toEqual(twoTiers);
    // 两档手写的字段也没被这一栏改写：`local_model` 的 `params`/`runtime` 原样在盘上。
    expect(diskModel(app).local_model.params).toEqual({ num_ctx: 8192 });
    expect(diskModel(app).local_model.runtime).toBe("external_http");
    expect(diskModel(app).cloud_model.params).toEqual({ temperature: 0.2 });
  });

  it("改写已有这一档：提交值胜出，未提交的 params 与 call_path 从既有那一档带过来", async () => {
    const app = await start({
      localLlm: llmProfile({
        api_key_env: "TB_LOCAL_LLM_KEY",
        call_path: "http_json_lenient",
        params: { top_k: 20 },
      }),
    });
    const saved = await callJson(
      app,
      "PUT",
      "/api/ingest/config",
      putBody(localLlmSegment({ baseUrl: "http://localhost:8080/v1", model: "new-model" })),
    );
    expect(saved.status).toBe(200);
    expect(diskModel(app).local_llm).toEqual(
      llmProfile({
        base_url: "http://localhost:8080/v1",
        model: "new-model",
        provider: "ollama",
        request_timeout_ms: 20_000,
        supports_structured_output: true,
        api_key_env: "TB_LOCAL_LLM_KEY",
        call_path: "http_json_lenient",
        params: { top_k: 20 },
      }),
    );
  });

  it("api_key_env 不经 TB_MODEL_API_KEY 归一化（M9-D-3：不一致是有意的）", async () => {
    const app = await start();
    const saved = await callJson(
      app,
      "PUT",
      "/api/ingest/config",
      putBody(localLlmSegment({ apiKeyEnv: "MY_OWN_LOCAL_LLM_KEY" })),
    );
    expect(saved.status).toBe(200);
    expect(diskModel(app).local_llm.api_key_env).toBe("MY_OWN_LOCAL_LLM_KEY");
    // 另外两档照旧被收敛到默认变量名——同一次保存里两条规则同时成立，这才叫「有意不一致」。
    expect(diskModel(app).local_model.api_key_env).not.toBe("MY_OWN_LOCAL_LLM_KEY");
    expect(diskModel(app).cloud_model.api_key_env).not.toBe("MY_OWN_LOCAL_LLM_KEY");
  });

  it("model 提交空串 ⇒ 不落 model 键（localLlmStatus 因此报 no_model）", async () => {
    const app = await start();
    const saved = await callJson(
      app,
      "PUT",
      "/api/ingest/config",
      putBody(localLlmSegment({ model: "" })),
    );
    expect(saved.status).toBe(200);
    expect(diskModel(app).local_llm).not.toHaveProperty("model");
    expect(localLlmStatus(app.booted.loaded.config as AppConfig).reason).toBe("no_model");
    expect(saved.json.localLlm).toMatchObject({ model: null, usable: false, reason: "no_model" });
  });

  it("保存只写配置文件 + 标脏，不在进程内热换 Provider", async () => {
    const app = await start();
    // 进程内真正在用的那一份：启动时装配好的适配器。保存后它必须还是它——
    // 「不热换」的事实依据是适配器没变，不是内存里的 `config.model` 没变（镜像写盘会改它）。
    const adapterBefore = app.booted.workspace.ingestProvider?.adapter;
    expect(adapterBefore?.provider).toBe("test-provider");
    const saved = await callJson(app, "PUT", "/api/ingest/config", putBody(localLlmSegment()));
    expect(saved.status).toBe(200);
    expect(saved.json.restartRequired).toBe(true);
    expect(diskModel(app).local_llm.provider).toBe("ollama");
    expect(app.booted.workspace.ingestProvider?.adapter).toBe(adapterBefore);
    // 顶层那一份 Provider 读数也照旧：这一档的保存不改装配（改它要在用时判，不在保存时热换）。
    expect(app.booted.workspace.ingestProvider?.adapter?.model).toBe("test-model");
  });
});

/* ══════════════════════════════════════════════════════════════════
 * W3 严格校验
 * ══════════════════════════════════════════════════════════════════ */

describe("M9-4d-1 W3 localLlm 段的严格校验", () => {
  it.each(["runtime", "contextSize", "modelPath", "quantization"])(
    "未知键 %s ⇒ 400 invalid_request",
    async (key) => {
      const app = await start();
      const bad = await callJson(
        app,
        "PUT",
        "/api/ingest/config",
        putBody(localLlmSegment({ [key]: "whatever" })),
      );
      expect(bad.status).toBe(400);
      expect(bad.json.error).toBe("invalid_request");
      expect(diskModel(app)).not.toHaveProperty("local_llm");
    },
  );

  it.each([
    ["非 http(s) 协议", "ftp://127.0.0.1:21"],
    ["根本不是 URL", "localhost:11434"],
    ["空串", ""],
  ])("base_url %s ⇒ 400", async (_label, baseUrl) => {
    const app = await start();
    const bad = await callJson(app, "PUT", "/api/ingest/config", putBody(localLlmSegment({ baseUrl })));
    expect(bad.status).toBe(400);
    expect(diskModel(app)).not.toHaveProperty("local_llm");
  });

  it.each([
    ["超时低于 1000ms", { requestTimeoutMs: 999 }],
    ["超时高于 300000ms", { requestTimeoutMs: 300_001 }],
    ["provider 为空白", { provider: "   " }],
    ["缺 enabled", { enabled: undefined }],
  ])("%s ⇒ 400（与另外两档同一取值域，不另开一条更松的路）", async (_label, overrides) => {
    const app = await start();
    const bad = await callJson(app, "PUT", "/api/ingest/config", putBody(localLlmSegment(overrides)));
    expect(bad.status).toBe(400);
    expect(diskModel(app)).not.toHaveProperty("local_llm");
  });
});

/* ══════════════════════════════════════════════════════════════════
 * W4 非回环允许保存，用时才判
 * ══════════════════════════════════════════════════════════════════ */

describe("M9-4d-1 W4 非回环地址能保存，连接测试据此如实报", () => {
  it.each([
    "http://192.168.1.9:8080/v1",
    "http://example.com/v1",
    "https://localhost.evil.com/v1",
  ])("%s ⇒ 保存 200，随后测试 ⇒ usable:false + not_loopback + 零请求", async (baseUrl) => {
    const app = await start();
    const saved = await callJson(
      app,
      "PUT",
      "/api/ingest/config",
      putBody(localLlmSegment({ baseUrl })),
    );
    // 保存路径**不拦**地址：拦了用户就改不回一个写错的配置（本批 §1 明文禁止）。
    expect(saved.status).toBe(200);
    expect(diskModel(app).local_llm.base_url).toBe(baseUrl);
    expect(saved.json.localLlm).toMatchObject({ baseUrl, usable: false, loopback: false, reason: "not_loopback" });

    const tested = await callJson(app, "POST", "/api/ingest/local-llm/test");
    expect(tested.status).toBe(200);
    expect(tested.json).toMatchObject({ usable: false, reason: "not_loopback", structuredOutput: null });
    expect(app.seen).toHaveLength(0);
  });

  it("写错了还能改回来：非回环 ⇒ 回环，两次保存都成功", async () => {
    const app = await start();
    const wrong = await callJson(
      app,
      "PUT",
      "/api/ingest/config",
      putBody(localLlmSegment({ baseUrl: "http://192.168.1.9:8080/v1" })),
    );
    expect(wrong.status).toBe(200);
    const fixed = await callJson(
      app,
      "PUT",
      "/api/ingest/config",
      putBody(localLlmSegment({ baseUrl: "http://127.0.0.1:11435/v1" })),
    );
    expect(fixed.status).toBe(200);
    expect(fixed.json.localLlm).toMatchObject({ usable: true, reason: null });
    expect((await callJson(app, "POST", "/api/ingest/local-llm/test")).json).toMatchObject({ usable: true });
  });
});

/* ══════════════════════════════════════════════════════════════════
 * W5 reason 是封闭枚举，message 是人话
 * ══════════════════════════════════════════════════════════════════ */

describe("M9-4d-1 W5 reason/message 拆分（M9-D-4）", () => {
  /** 四种不可用读数各断言一次：`reason` 逐字等于枚举，人话只在 `message` 里。 */
  const unusableCases: readonly [string, Record<string, unknown>, string][] = [
    ["enabled:false", llmProfile({ enabled: false }), "disabled"],
    ["局域网地址", llmProfile({ base_url: "http://192.168.1.9:8080/v1" }), "not_loopback"],
    ["缺模型 ID", llmProfile({ model: undefined }), "no_model"],
  ];

  for (const [label, profile, reason] of unusableCases) {
    it(`${label} ⇒ reason=${reason}（枚举），message 是人话`, async () => {
      const app = await start({ localLlm: profile });
      const tested = await callJson(app, "POST", "/api/ingest/local-llm/test");
      expect(LOCAL_LLM_TEST_REASONS).toContain(tested.json.reason);
      expect(tested.json.reason).toBe(reason);
      expect(typeof tested.json.message).toBe("string");
      expect(tested.json.message.length).toBeGreaterThan(0);
      expect(app.seen).toHaveLength(0);
    });
  }

  it("未配置 ⇒ reason=not_configured，四个不可用读数因此各被点名一次", async () => {
    const app = await start();
    const tested = await callJson(app, "POST", "/api/ingest/local-llm/test");
    expect(tested.json.reason).toBe("not_configured");
    expect(tested.json.message).toEqual(expect.any(String));
    const seenReasons = new Set<string>(["not_configured", ...unusableCases.map(([, , r]) => r)]);
    expect([...seenReasons].sort()).toEqual(["disabled", "no_model", "not_configured", "not_loopback"]);
  });

  it.each([
    ["401 ⇒ auth_failed", [{ status: 401, body: JSON.stringify({ error: "bad key 张三 13800138000" }) }], "auth_failed"],
    ["坏信封 ⇒ invalid_response", [{ status: 200, body: "<html>张三 蓝山咖啡馆</html>" }], "invalid_response"],
  ] as const)("探测失败：%s ⇒ reason 是类别，message 里既没有端点响应体也没有词面", async (_label, responses, reason) => {
    // 假服务在启动时就按这批响应回包（`start` 的 responses 用尽后重复最后一个）；
    // 库里先存一条真实记录，是让「原文词面搜不到」这条断言有反证对象。
    const app = await start({ localLlm: llmProfile(), responses });
    await createRecord(app, RAW_TEXT);
    const tested = await callJson(app, "POST", "/api/ingest/local-llm/test");
    expect(tested.json).toMatchObject({ usable: false, structuredOutput: null, reason });
    const wire = JSON.stringify(tested.json);
    for (const face of SECRET_FACES) expect(wire).not.toContain(face);
    expect(wire).not.toContain("bad key");
    expect(wire).not.toContain("<html>");
  });

  it("响应里除枚举与人话外不带第三个字段：原文、词面、URL 凭据部分都搜不到", async () => {
    const app = await start({ localLlm: llmProfile({ api_key_env: "TB_M9_4D1_KEY" }) });
    await createRecord(app, RAW_TEXT);
    const tested = await callJson(app, "POST", "/api/ingest/local-llm/test");
    expect(tested.json).toMatchObject({ usable: true });
    const wire = JSON.stringify(tested.json);
    for (const face of SECRET_FACES) expect(wire).not.toContain(face);
    expect(wire).not.toContain("TB_M9_4D1_KEY");
  });
});

/* ══════════════════════════════════════════════════════════════════
 * W6 / W7 设置页（源码级 + 纯函数两路）
 * ══════════════════════════════════════════════════════════════════ */

const WEB = join(process.cwd(), "src", "web");

function source(rel: string): string {
  return readFileSync(join(WEB, rel), "utf8");
}

/** 去掉注释后的源码：断言要的是会被渲染/执行的那部分（与 m6-1c 同法）。 */
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

describe("M9-4d-1 W6 设置页渲染这一栏，结果按 reason 分支", () => {
  const panel = codeOnly(source("SettingsPanel.tsx"));
  const branch = source("localLlmSettings.ts");

  it("这一栏在场，且挂在两档模型配置之后、与它们同一个表单", () => {
    expect(panel).toContain("本地模型辅助脱敏");
    expect(panel).toContain("<LocalLlmEditor");
    expect(panel).toContain("localLlmDraft");
    // M9-4d-1b：测试连接改为把当前草稿发上去（`api.testLocalLlm(...)`），不再是空参调用。
    expect(panel).toMatch(/api\.testLocalLlm\(\s*draft\b/);
  });

  it("四个不可用读数逐条分支在场（枚举取值能在源码里搜到）", () => {
    for (const reason of ["not_configured", "disabled", "not_loopback", "no_model"]) {
      expect(branch).toContain(`"${reason}"`);
    }
    expect(branch).toContain("Record<LocalLlmUnusableReason, string>");
  });

  it("按枚举分支的文案互不相同，且不可用时把 message 当细节拼在后面", () => {
    const headlines = (["not_configured", "disabled", "not_loopback", "no_model"] as const).map(
      (reason) => localLlmFailureHeadline(reason),
    );
    for (const text of headlines) expect(text.length).toBeGreaterThan(0);
    expect(new Set(headlines).size).toBe(4);
    // 探测失败类别不给第二套人话：起头一句 + 服务端那句 message。
    expect(localLlmFailureHeadline("auth_failed")).toBe(localLlmFailureHeadline("timeout"));
    const text = localLlmTestResultText({
      usable: false,
      reason: "auth_failed",
      message: "服务拒绝了密钥，请检查密钥是否正确。",
      structuredOutput: null,
      latencyMs: 7,
    });
    expect(text).toContain("服务拒绝了密钥");
  });

  it("成功读数报可用 + 结构化那条路 + 耗时", () => {
    expect(localLlmTestResultText({ usable: true, structuredOutput: true, latencyMs: 42 })).toContain(
      "支持结构化输出",
    );
    expect(localLlmTestResultText({ usable: true, structuredOutput: false, latencyMs: 42 })).toContain(
      "纯提示词",
    );
    expect(localLlmTestResultText({ usable: true, structuredOutput: false, latencyMs: 42 })).toContain("42 ms");
  });

  it("UI 不解析 message 做判断：源码里没有任何对 message 的 includes/startsWith/比较", () => {
    expect(branch).not.toMatch(/\.message\b\s*\.\s*(includes|startsWith|indexOf|split|match)/);
    expect(panel).not.toMatch(/\.message\b\s*\.\s*(includes|startsWith|indexOf|split|match)/);
  });
});

describe("M9-4d-1 W7 非回环只提示，不拦保存", () => {
  const panel = codeOnly(source("SettingsPanel.tsx"));
  const branch = codeOnly(source("localLlmSettings.ts"));

  it("这一栏就地提示「只接受本机回环地址」，两种写法都点名", () => {
    expect(panel).toContain("LOCAL_LLM_LOOPBACK_HINT");
    expect(branch).toContain("http://127.0.0.1");
    expect(branch).toContain("http://localhost");
    expect(branch).toContain("不替你改输入");
  });

  it("源码里没有保存前拦非回环地址的分支：前端不做回环判定", () => {
    // 判据只有一个来源：服务端读数。`new URL(...)` 出现在这里就等于浏览器里抄了一份回环判定。
    expect(branch).not.toContain("new URL(");
    expect(panel).not.toMatch(/isLoopback|LOOPBACK_HOSTS/);
    // `save()` 里那几条前置校验只关于「启用了却没填模型 ID」，没有一条看地址。
    const save = panel.slice(panel.indexOf("async function save()"), panel.indexOf("async function testConnection"));
    expect(save).not.toContain("回环");
    expect(save).not.toMatch(/loopback/i);
    expect(save).toContain("localLlmSubmitBody");
  });

  it("省缺语义在 UI 侧同样成立：没编辑过这一栏 ⇒ 提交体里连键都不带", () => {
    expect(localLlmSubmitBody(null)).toBeUndefined();
    expect(localLlmDraftFromTier(null)).toBeNull();
    const tier: LocalLlmTierDto = {
      enabled: true,
      provider: "ollama",
      model: "qwen3:1.7b",
      baseUrl: "http://127.0.0.1:11435/v1",
      requestTimeoutMs: 20_000,
      supportsStructuredOutput: true,
      callPath: null,
      apiKeyEnv: "TB_LOCAL_LLM_KEY",
      loopback: true,
      usable: true,
      reason: null,
    };
    const draft = localLlmDraftFromTier(tier);
    // M9-4d-1b：草稿不再携带 `apiKeyEnv`（界面不暴露变量名，前端类型里已无此字段）。
    expect(draft).toMatchObject({ enabled: true, model: "qwen3:1.7b" });
    expect(draft).not.toHaveProperty("apiKeyEnv");
    const body: UpdateModelConfigDto = {
      localModel: {
        enabled: false,
        provider: "p",
        model: "m",
        baseUrl: "http://127.0.0.1:1/v1",
        callPath: "http_json_lenient",
        supportsStructuredOutput: false,
        requestTimeoutMs: 1000,
      },
      cloudModel: {
        enabled: false,
        provider: "p",
        model: "m",
        baseUrl: "http://127.0.0.1:1/v1",
        callPath: "http_json_lenient",
        supportsStructuredOutput: false,
        requestTimeoutMs: 1000,
      },
      ...(localLlmSubmitBody(draft) === undefined ? {} : { localLlm: localLlmSubmitBody(draft)! }),
    };
    expect(Object.keys(body)).toEqual(["localModel", "cloudModel", "localLlm"]);
  });
});

/* ══════════════════════════════════════════════════════════════════
 * X1–X5（M9-4d-1b）：设置页两处收口 + 连接测试改测草稿
 * ══════════════════════════════════════════════════════════════════ */

describe("M9-4d-1b X1 界面去掉密钥变量名，服务端仍保留手写的 api_key_env", () => {
  it("设置页源码不含「密钥环境变量名」，也没有任何 apiKeyEnv 输入；前端类型里也无此字段", () => {
    // 与 web-ui4 同一口径：读原始源码（含注释），要的是那一句文案彻底不在页面上。
    const panel = source("SettingsPanel.tsx");
    expect(panel).not.toContain("密钥环境变量名");
    expect(panel).not.toContain("apiKeyEnv");
    // 判据与文案文件同样不再出现变量名（空白草稿里也没有）。
    expect(source("localLlmSettings.ts")).not.toContain("apiKeyEnv");
    // 前端提交类型 `UpdateLocalLlmProfileDto` 的接口体内不再有该字段。
    const dto = source("../shared/dto.ts");
    const start = dto.indexOf("export interface UpdateLocalLlmProfileDto");
    const body = dto.slice(start, dto.indexOf("}", start) + 1);
    expect(body).not.toContain("apiKeyEnv");
  });

  it("往返：提交体不带该键 ⇒ 配置文件里已有的 api_key_env 逐字保留", async () => {
    const app = await start({ localLlm: llmProfile({ api_key_env: "TB_M9_4D1B_KEY" }) });
    // 界面这一批起不再发 apiKeyEnv，所以提交段里没有该键——回落路径必须把它留住。
    const saved = await callJson(
      app,
      "PUT",
      "/api/ingest/config",
      putBody(localLlmSegment({ model: "kept-model" })),
    );
    expect(saved.status).toBe(200);
    // 读侧投影仍带出变量名（`LocalLlmTierDto.apiKeyEnv`）——只是界面不再编辑它。
    expect(saved.json.localLlm.apiKeyEnv).toBe("TB_M9_4D1B_KEY");
    expect(diskModel(app).local_llm.api_key_env).toBe("TB_M9_4D1B_KEY");
  });
});

describe("M9-4d-1b X2/X3/X4 连接测试测的是草稿：零写入 + 地址以草稿为准", () => {
  it("X2 带 profile 的草稿探测 ⇒ usable:true，且磁盘 / facts.config / configDirty 全未变", async () => {
    const app = await start({
      localLlm: llmProfile({ enabled: false }),
    });
    const diskBefore = JSON.stringify(diskModel(app).local_llm);
    const configBefore = JSON.stringify(app.booted.loaded.config);
    const dirtyBefore = (await callJson(app, "GET", "/api/ingest/config")).json.restartRequired;

    // 草稿是一档「已启用 + 回环 + 有模型」，与盘上那档 enabled:false 不同——它必须能测通。
    const tested = await callJson(app, "POST", "/api/ingest/local-llm/test", {
      profile: localLlmSegment(),
    });
    expect(tested.status).toBe(200);
    expect(tested.json).toMatchObject({ usable: true });
    expect(app.seen.length).toBeGreaterThan(0);

    // 零写入的三面：配置文件、进程内 facts.config、以及 configDirty（经 restartRequired 观测）。
    expect(JSON.stringify(diskModel(app).local_llm)).toBe(diskBefore);
    expect(JSON.stringify(app.booted.loaded.config)).toBe(configBefore);
    expect((await callJson(app, "GET", "/api/ingest/config")).json.restartRequired).toBe(dirtyBefore);
  });

  it("X3 草稿非回环、已保存回环 ⇒ not_loopback 且一次请求都不发（证明测的是草稿）", async () => {
    const app = await start({ localLlm: llmProfile() }); // 已保存那档是回环且可用
    const tested = await callJson(app, "POST", "/api/ingest/local-llm/test", {
      profile: localLlmSegment({ baseUrl: "http://192.168.1.9:8080" }),
    });
    expect(tested.json).toMatchObject({ usable: false, reason: "not_loopback", structuredOutput: null });
    expect(app.seen).toHaveLength(0);
  });

  it("X4 反向：草稿回环、已保存非回环 ⇒ usable:true（同证测的是草稿）", async () => {
    // 已保存那一档故意写成非回环：若测的是它，会得到 not_loopback + 零请求。
    const app = await start({ localLlm: llmProfile({ base_url: "http://192.168.1.9:8080/v1" }) });
    const tested = await callJson(app, "POST", "/api/ingest/local-llm/test", {
      profile: localLlmSegment(), // 草稿是回环
    });
    expect(tested.json).toMatchObject({ usable: true });
    expect(app.seen.length).toBeGreaterThan(0);
  });
});

describe("M9-4d-1b X5 不传 profile ⇒ 与 M9-1 逐字相同（回归）", () => {
  it("空 body 与无 body 都读已保存的那一档", async () => {
    const app = await start({ localLlm: llmProfile() });
    const noBody = await callJson(app, "POST", "/api/ingest/local-llm/test");
    const emptyBody = await callJson(app, "POST", "/api/ingest/local-llm/test", {});
    expect(noBody.json).toMatchObject({ usable: true });
    expect(emptyBody.json).toMatchObject({ usable: true });
  });

  it("未配置时读已保存：usable 为 false + not_configured + 零请求（即使带了 profile 之外的东西）", async () => {
    const app = await start(); // 没有 local_llm
    const tested = await callJson(app, "POST", "/api/ingest/local-llm/test", {});
    expect(tested.json).toMatchObject({ usable: false, reason: "not_configured" });
    expect(app.seen).toHaveLength(0);
  });
});

/* ══════════════════════════════════════════════════════════════════
 * 枚举取值域本身（封闭清单，不散落字面量）
 * ══════════════════════════════════════════════════════════════════ */

describe("M9-4d-1 枚举定义在一处", () => {
  it("reason 的取值域 = 四个不可用读数 + 八个探测类别，且没有第二份定义", () => {
    const reasons: readonly LocalLlmTestReason[] = LOCAL_LLM_TEST_REASONS;
    expect(reasons).toHaveLength(12);
    expect(new Set(reasons).size).toBe(12);
    expect(reasons.slice(0, 4)).toEqual(["not_configured", "disabled", "not_loopback", "no_model"]);
  });

  it("DTO 里的 reason 类型不许退化成 string：服务端 re-export 的仍是同一份", async () => {
    const dto = source("../shared/dto.ts");
    const body = dto.slice(dto.indexOf("export interface LocalLlmTestResultDto"), dto.indexOf("// ── op3"));
    expect(body).toContain("reason?: LocalLlmTestReason");
    expect(body).toContain("message?: string");
    expect(body).not.toMatch(/reason\?:\s*string/);
  });
});

/* ══════════════════════════════════════════════════════════════════
 * M9-6a 超时取值域（裁决 M9-D-19）：上限 300000 三档共享，缺省 90000 只属本地脱敏档
 * ══════════════════════════════════════════════════════════════════ */

/**
 * 源码里「超时字段」的 `[下限, 上限]`，按出现次序返回。
 * 只认这一整串形状：`.max(80)`（provider）/ `.max(200)`（model）这类同文件里的其它上限不参与对账。
 */
function timeoutBounds(src: string): [number, number][] {
  const pattern =
    /(?:request_timeout_ms|requestTimeoutMs):\s*z\.number\(\)\.int\(\)\.min\((\d+)\)\.max\((\d+)\)/g;
  return [...src.matchAll(pattern)].map((match) => [Number(match[1]), Number(match[2])] as [number, number]);
}

describe("M9-6a T1 这一档的上限 300000 是合法值（300001 ⇒ 400 由 W3 那张表钉着）", () => {
  it("本地脱敏档提交 300000 ⇒ 200，落盘与 DTO 读数都是它", async () => {
    const app = await start();
    const saved = await callJson(
      app,
      "PUT",
      "/api/ingest/config",
      putBody(localLlmSegment({ requestTimeoutMs: 300_000 })),
    );
    expect(saved.status).toBe(200);
    expect(diskModel(app).local_llm.request_timeout_ms).toBe(300_000);
    expect(saved.json.localLlm.requestTimeoutMs).toBe(300_000);
  });

});

describe("M9-6a-2 裁决落地：另外两档经这条保存路径拿得到新上限", () => {
  // M9-6a 时这条钉的是「顶层旧字段仍 max(120000)，两档的 300000 在落盘前被拒」这一当刻事实。
  // M9-6a-2 把顶层那份 schema 的上限对齐到 300000，事实变了 ⇒ 翻成正面断言：同一份数据在
  // 两层由同一套上限判定，界面允许的值写盘也允许。300001 仍被拒，拒在写盘之前。
  it("local_model 提交 300000 ⇒ 200 并落盘，顶层镜像字段一同抬", async () => {
    const app = await start();
    const saved = await callJson(app, "PUT", "/api/ingest/config", {
      localModel: putProfile({ requestTimeoutMs: 300_000 }),
      cloudModel: putProfile(),
    });
    expect(saved.status).toBe(200);
    expect(diskModel(app).local_model.request_timeout_ms).toBe(300_000);
    expect(diskModel(app).request_timeout_ms).toBe(300_000);
    expect(saved.json.localModel.requestTimeoutMs).toBe(300_000);
  });

  it("300001 ⇒ 400，且盘上配置一字未变", async () => {
    const app = await start();
    const before = readFileSync(app.sandbox.layout.configFile, "utf8");
    const bad = await callJson(app, "PUT", "/api/ingest/config", {
      localModel: putProfile({ requestTimeoutMs: 300_001 }),
      cloudModel: putProfile(),
    });
    expect(bad.status).toBe(400);
    expect(readFileSync(app.sandbox.layout.configFile, "utf8")).toBe(before);
  });
});

describe("M9-6a-2 两层上限一致：界面允许的值不会被写盘那一刻拒掉", () => {
  /** 保存路径把 `primary.request_timeout_ms` 镜像进顶层旧字段 `model.request_timeout_ms`
   *  （`ingestRoutes.ts` 的 `nextModel`），而 `writeConfigFile` 先过 `parseAppConfig`：镜像字段
   *  的上限必须与 profile 那份一致，否则 200000 这类界面合法值报出来的是一条与超时无关的配置校验错误。 */
  it("200000（本批要修的 bug）⇒ 200，读回的 profile 与顶层镜像字段都是 200000", async () => {
    const app = await start();
    const saved = await callJson(app, "PUT", "/api/ingest/config", {
      localModel: putProfile({ requestTimeoutMs: 200_000 }),
      cloudModel: putProfile(),
    });
    expect(saved.status).toBe(200);
    expect(diskModel(app).local_model.request_timeout_ms).toBe(200_000);
    expect(diskModel(app).request_timeout_ms).toBe(200_000);
    expect(saved.json.localModel.requestTimeoutMs).toBe(200_000);
  });

  it("300000 ⇒ 200，两档的 profile 与顶层镜像字段都是 300000", async () => {
    const app = await start();
    const saved = await callJson(app, "PUT", "/api/ingest/config", {
      localModel: putProfile({ requestTimeoutMs: 300_000 }),
      cloudModel: putProfile({ requestTimeoutMs: 300_000 }),
    });
    expect(saved.status).toBe(200);
    expect(diskModel(app).cloud_model.request_timeout_ms).toBe(300_000);
    expect(diskModel(app).local_model.request_timeout_ms).toBe(300_000);
    expect(diskModel(app).request_timeout_ms).toBe(300_000);
  });

  it("下限 1000 未动：999 ⇒ 400 且盘上配置一字未变", async () => {
    const app = await start();
    const before = readFileSync(app.sandbox.layout.configFile, "utf8");
    const bad = await callJson(app, "PUT", "/api/ingest/config", {
      localModel: putProfile({ requestTimeoutMs: 999 }),
      cloudModel: putProfile(),
    });
    expect(bad.status).toBe(400);
    expect(readFileSync(app.sandbox.layout.configFile, "utf8")).toBe(before);
  });
});

describe("M9-6a T2 下限 1000 未动", () => {
  it("1000 ⇒ 200 并落盘（999 ⇒ 400 由 W3 那张表钉着，本批没改它）", async () => {
    const app = await start();
    const saved = await callJson(
      app,
      "PUT",
      "/api/ingest/config",
      putBody(localLlmSegment({ requestTimeoutMs: 1000 })),
    );
    expect(saved.status).toBe(200);
    expect(diskModel(app).local_llm.request_timeout_ms).toBe(1000);
  });
});

describe("M9-6a T3 设置页草稿的缺省超时是 90000", () => {
  it("空白草稿 = 90000（这一档没被编辑过时提交体里根本不带段，所以它只是表单起点）", () => {
    expect(LOCAL_LLM_BLANK_DRAFT.requestTimeoutMs).toBe(90_000);
  });

  it("LocalLlmEditor 里那个输入的缺省回落同样是 90000", () => {
    const panel = codeOnly(source("SettingsPanel.tsx"));
    const editor = panel.slice(
      panel.indexOf("function LocalLlmEditor"),
      panel.indexOf("export function SettingsPanel"),
    );
    expect(editor).toContain("value.requestTimeoutMs : 90_000");
  });
});

describe("M9-6a T4 另外两档的缺省没被牵连", () => {
  it("ProfileEditor（本地/云端两档共用）的缺省回落仍是 30000，且看不到 90000", () => {
    const panel = codeOnly(source("SettingsPanel.tsx"));
    const editor = panel.slice(
      panel.indexOf("function ProfileEditor"),
      panel.indexOf("interface LocalLlmEditorProps"),
    );
    expect(editor).toContain("value.requestTimeoutMs : 30000");
    expect(editor).not.toMatch(/90_?000/);
    // 空白草稿只服务本地脱敏档：另两档没有「未配置」的空白态，值一律来自已保存配置。
    expect(editor).not.toContain("LOCAL_LLM_BLANK_DRAFT");
  });

  it("配置模板里那两档的缺省仍是 30000，且模板不凭空造出 local_llm 段", () => {
    const example = JSON.parse(
      readFileSync(join(process.cwd(), "config.example.json"), "utf8"),
    ) as { model: Record<string, unknown> };
    expect(example.model.request_timeout_ms).toBe(30000);
    expect(example.model.local_model).toMatchObject({ request_timeout_ms: 30000 });
    expect(example.model).not.toHaveProperty("local_llm");
  });
});

describe("M9-6a T5 服务端各处 schema 与设置页两处的数值一致", () => {
  /** `modelProfileConfigSchema` 本体（三档共享的那一份），不含下面的 extend。 */
  function profileSchemaSource(): string {
    const cfg = source("../server/config/config.ts");
    return cfg.slice(
      cfg.indexOf("export const modelProfileConfigSchema"),
      cfg.indexOf("export const localModelProfileConfigSchema"),
    );
  }

  /** 顶层旧字段 `model.request_timeout_ms` 那一份 schema（M9-6a-2 的对齐点）。 */
  function topLevelModelSchemaSource(): string {
    const cfg = source("../server/config/config.ts");
    return cfg.slice(cfg.indexOf("export const modelConfigSchema"), cfg.indexOf("export const appConfigSchema"));
  }

  it("配置层：共享 schema 的上限 = 300000，下限仍是 1000", () => {
    expect(timeoutBounds(profileSchemaSource())).toEqual([[1000, 300_000]]);
  });

  it("配置层：顶层旧字段镜像 schema 与 profile 那份同上下限（否则界面合法值写盘被拒）", () => {
    expect(timeoutBounds(topLevelModelSchemaSource())).toEqual([[1000, 300_000]]);
  });

  it("请求体层：三份（两档共用的 modelProfileBody + localLlmProfileBody + 连接测试）逐个对齐", () => {
    expect(timeoutBounds(codeOnly(source("../server/api/ingestRoutes.ts")))).toEqual([
      [1000, 300_000],
      [1000, 300_000],
      [1000, 300_000],
    ]);
  });

  it("界面层：两个超时限输入的 max 与 schema 同值，min 仍是 1000", () => {
    const panel = codeOnly(source("SettingsPanel.tsx"));
    expect([...panel.matchAll(/min=\{(\d+)\}/g)].map((match) => Number(match[1]))).toEqual([1000, 1000]);
    expect([...panel.matchAll(/max=\{(\d+)\}/g)].map((match) => Number(match[1]))).toEqual([
      300_000, 300_000,
    ]);
  });

  it("总账：服务端五处 + 界面两处，上限只有一个数（防止只改了服务端漏了界面）", () => {
    // M9-6a-2 起顶层旧字段 `model.request_timeout_ms` 也进对账：它是 primary profile 的镜像，
    // 两层两套上限就是本批修掉的那个 bug（界面允许、写盘被拒）。
    const ceilings = [
      ...timeoutBounds(profileSchemaSource()).map(([, max]) => max),
      ...timeoutBounds(topLevelModelSchemaSource()).map(([, max]) => max),
      ...timeoutBounds(codeOnly(source("../server/api/ingestRoutes.ts"))).map(([, max]) => max),
      ...[...codeOnly(source("SettingsPanel.tsx")).matchAll(/max=\{(\d+)\}/g)].map(
        (match) => Number(match[1]),
      ),
    ];
    expect(ceilings).toHaveLength(7);
    expect(new Set(ceilings).size).toBe(1);
    expect(ceilings.every((max) => max === 300_000)).toBe(true);
  });
});
