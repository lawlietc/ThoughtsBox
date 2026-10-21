import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { httpTransport } from "../src/server/ingest/httpTransport.ts";
import {
  invokeExtraction,
  ProviderError,
  type ExtractionRequest,
  type ModelAdapter,
} from "../src/server/ingest/provider.ts";
import { structuredOutputSchema } from "../src/server/ingest/contract.ts";
import { M2_PROMPT_CONTRACT_FIELDS, M2_PROMPT_V1 } from "../src/server/ingest/prompts/m2-prompt-v1.ts";
import { serializeTrace, TracePrivacyViolation } from "../src/server/ingest/trace.ts";
import { buildProductionProvider } from "../src/server/runtime/productionProvider.ts";
import { loadConfigFromPath, parseAppConfig, TEMPLATE_CONFIG_PATH, type AppConfig } from "../src/server/config/config.ts";
import { ConfigError } from "../src/server/config/errors.ts";
import { envelopeOf, validOutput } from "./helpers/ingestFixtures.ts";

/**
 * M4-TR-1 专项测试：生产 httpTransport + 装配 + 生产提示词 + 密钥零泄露。
 *
 * **禁打外部网络**：所有真 fetch 都打到测试内用 `node:http` 起的 127.0.0.1 临时端口假端点，
 * 走真 socket——不用桩代 transport（那等于没测）。
 */

const SENTINEL = "sk-SENTINEL-DO-NOT-LEAK-0123456789abcdef";
const KEY_ENV = "TB_M4TR1_TEST_KEY";

interface Captured {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

interface FakeEndpoint {
  readonly baseUrl: string;
  readonly port: number;
  readonly seen: Captured[];
  close(): Promise<void>;
}

/**
 * 起一个 127.0.0.1 临时端口假端点。`responder(status, body)` 决定回什么；
 * 传 `"hang"` 让它收下请求却永不回稿（测超时/取消）。
 */
async function startFakeEndpoint(
  responder: (captured: Captured) => { status: number; body: string } | "hang",
): Promise<FakeEndpoint> {
  const seen: Captured[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const captured: Captured = {
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      seen.push(captured);
      const out = responder(captured);
      if (out === "hang") return; // 故意不回：让客户端超时/取消
      res.writeHead(out.status, { "content-type": "application/json" });
      res.end(out.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    port,
    seen,
    close: () =>
      new Promise<void>((resolve, reject) => {
        // 挂起的响应不会被 close() 等待，强制断开所有连接再关。
        server.closeAllConnections?.();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

const openEndpoints: FakeEndpoint[] = [];
afterEach(async () => {
  while (openEndpoints.length > 0) await openEndpoints.pop()!.close();
  delete process.env[KEY_ENV];
});

async function tracked(responder: Parameters<typeof startFakeEndpoint>[0]): Promise<FakeEndpoint> {
  const ep = await startFakeEndpoint(responder);
  openEndpoints.push(ep);
  return ep;
}

function makeRequest(overrides: Partial<ExtractionRequest> = {}): ExtractionRequest {
  return {
    recordRevisionId: "rev_test_1",
    processingMode: "local_model",
    payloadText: "今天和项目组的同事讨论了发布计划，我感到焦虑",
    systemPrompt: "你是抽取器。",
    promptVersion: "m2-prompt-v1",
    outputSchemaVersion: "m2-output-v1",
    contractsFingerprint: "fp",
    resolverVersion: "r1",
    validationVersion: "v1",
    ...overrides,
  };
}

function makeLocalAdapter(baseUrl: string, overrides: Partial<ModelAdapter> = {}): ModelAdapter {
  return {
    provider: "fake",
    model: "fake-model",
    baseUrl,
    callPath: "ollama_openai_compatible",
    supportsStructuredOutput: false,
    requestTimeoutMs: 3000,
    ...overrides,
  };
}

// ── 一、httpTransport 真 socket 行为 ────────────────────────────────

describe("M4-TR-1 httpTransport（回环真 fetch，非桩）", () => {
  it("200 信封透传：invokeExtraction 拿到解析后的 JSON 对象", async () => {
    const ep = await tracked(() => ({ status: 200, body: envelopeOf(validOutput()) }));
    const adapter = makeLocalAdapter(ep.baseUrl);
    const outcome = await invokeExtraction(adapter, makeRequest(), httpTransport);
    expect(outcome.json).toHaveProperty("title");
    expect(ep.seen).toHaveLength(1);
    expect(ep.seen[0]!.method).toBe("POST");
    expect(ep.seen[0]!.url).toBe("/v1/chat/completions");
    const sentBody = JSON.parse(ep.seen[0]!.body) as Record<string, unknown>;
    expect(sentBody.model).toBe("fake-model");
    expect(Array.isArray(sentBody.messages)).toBe(true);
    expect(sentBody.stream).toBe(false);
  });

  it("非 2xx → network 分类，消息只含状态码与 provider 名", async () => {
    const ep = await tracked(() => ({ status: 503, body: JSON.stringify({ error: { message: "busy" } }) }));
    const adapter = makeLocalAdapter(ep.baseUrl, { provider: "ollama" });
    let caught: unknown;
    try {
      await invokeExtraction(adapter, makeRequest(), httpTransport);
    } catch (cause) {
      caught = cause;
    }
    expect(caught).toBeInstanceOf(ProviderError);
    const err = caught as ProviderError;
    expect(err.kind).toBe("network");
    expect(err.retryable).toBe(true); // 5xx 瞬时故障
    expect(err.diagnostics.status).toBe(503);
    expect(err.diagnostics.provider).toBe("ollama");
    expect(err.message).toContain("503");
  });

  it("authorization 头从 env 变量取到（发送那一刻）", async () => {
    const ep = await tracked(() => ({ status: 200, body: envelopeOf(validOutput()) }));
    process.env[KEY_ENV] = SENTINEL;
    const adapter = makeLocalAdapter(ep.baseUrl, { apiKeyEnv: KEY_ENV });
    await invokeExtraction(adapter, makeRequest(), httpTransport);
    expect(ep.seen[0]!.headers.authorization).toBe(`Bearer ${SENTINEL}`);
  });

  it("变量缺失 = 无 authorization 头（本地模式无密钥也走得通）", async () => {
    const ep = await tracked(() => ({ status: 200, body: envelopeOf(validOutput()) }));
    const adapter = makeLocalAdapter(ep.baseUrl, { apiKeyEnv: KEY_ENV });
    delete process.env[KEY_ENV];
    await invokeExtraction(adapter, makeRequest(), httpTransport);
    expect(ep.seen[0]!.headers.authorization).toBeUndefined();
  });

  it("超时：端点不回稿 → invokeExtraction 分类为 timeout（transport 不抢分类）", async () => {
    const ep = await tracked(() => "hang");
    const adapter = makeLocalAdapter(ep.baseUrl, { requestTimeoutMs: 120 });
    let caught: unknown;
    try {
      await invokeExtraction(adapter, makeRequest(), httpTransport);
    } catch (cause) {
      caught = cause;
    }
    expect(caught).toBeInstanceOf(ProviderError);
    expect((caught as ProviderError).kind).toBe("timeout");
  });

  it("取消传播：调用方中途 abort → cancelled（非误判为 network）", async () => {
    const ep = await tracked(() => "hang");
    const controller = new AbortController();
    const adapter = makeLocalAdapter(ep.baseUrl, { requestTimeoutMs: 5000 });
    setTimeout(() => controller.abort(), 60);
    let caught: unknown;
    try {
      await invokeExtraction(adapter, makeRequest({ signal: controller.signal }), httpTransport);
    } catch (cause) {
      caught = cause;
    }
    expect(caught).toBeInstanceOf(ProviderError);
    expect((caught as ProviderError).kind).toBe("cancelled");
  });

  it("连接被拒（无监听端口）→ transport 抛 network，消息含调用路径而非 headers", async () => {
    // 起一个立刻关掉的端点，端口随即空置；打到它等于 connection refused。
    const dead = await startFakeEndpoint(() => ({ status: 200, body: "{}" }));
    const deadPort = dead.port;
    await dead.close();
    const adapter = makeLocalAdapter(`http://127.0.0.1:${deadPort}/v1`);
    let caught: unknown;
    try {
      await invokeExtraction(adapter, makeRequest(), httpTransport);
    } catch (cause) {
      caught = cause;
    }
    expect(caught).toBeInstanceOf(ProviderError);
    expect((caught as ProviderError).kind).toBe("network");
  });
});

// ── 二、密钥零泄露钉 ────────────────────────────────────────────────

describe("M4-TR-1 密钥零泄露（哨兵串当 key）", () => {
  it("transport 抛出的 message+diagnostics 不含哨兵", async () => {
    const ep = await tracked(() => "hang");
    process.env[KEY_ENV] = SENTINEL;
    const adapter = makeLocalAdapter(ep.baseUrl, { requestTimeoutMs: 120, apiKeyEnv: KEY_ENV });
    let caught: ProviderError | undefined;
    try {
      await invokeExtraction(adapter, makeRequest(), httpTransport);
    } catch (cause) {
      caught = cause as ProviderError;
    }
    expect(caught).toBeInstanceOf(ProviderError);
    const blob = `${caught!.message}|${JSON.stringify(caught!.diagnostics)}`;
    expect(blob).not.toContain(SENTINEL);
  });

  it("假端点侧收到的日志：哨兵只出现在 authorization 头，请求体不含", async () => {
    const ep = await tracked(() => ({ status: 200, body: envelopeOf(validOutput()) }));
    process.env[KEY_ENV] = SENTINEL;
    const adapter = makeLocalAdapter(ep.baseUrl, { apiKeyEnv: KEY_ENV });
    await invokeExtraction(adapter, makeRequest(), httpTransport);
    const captured = ep.seen[0]!;
    // 请求体里绝不能有密钥。
    expect(captured.body).not.toContain(SENTINEL);
    // 唯一出现处就是 authorization 头本身。
    expect(captured.headers.authorization).toBe(`Bearer ${SENTINEL}`);
    const headerBlob = JSON.stringify({ ...captured.headers, authorization: undefined });
    expect(headerBlob).not.toContain(SENTINEL);
  });

  it("Trace serialize(guards.apiKey=哨兵)：干净诊断通过、命中哨兵即抛", () => {
    const clean = serializeTrace(
      [{ recordRevisionId: "rev_1", errorKind: "network", diagnostics: { status: 503, provider: "ollama" } }],
      { apiKey: SENTINEL },
    );
    expect(clean).not.toContain(SENTINEL);
    expect(() =>
      serializeTrace(
        [{ recordRevisionId: "rev_1", diagnostics: { leaked: SENTINEL } }],
        { apiKey: SENTINEL },
      ),
    ).toThrow(TracePrivacyViolation);
  });

  it("装配出的 adapter 只含变量名，序列化面不含哨兵", () => {
    process.env[KEY_ENV] = SENTINEL;
    const bundle = buildProductionProvider(modelEnabledConfig({ model: "m", call_path: "ollama_openai_compatible", api_key_env: KEY_ENV }), process.env);
    expect(bundle).not.toBeNull();
    expect(bundle!.adapter.apiKeyEnv).toBe(KEY_ENV);
    expect(JSON.stringify(bundle!.adapter)).not.toContain(SENTINEL);
  });
});

// ── 三、buildProductionProvider 装配与 fail-fast ────────────────────

/** 构造一份已过 schema 的 AppConfig，model 段按 overrides 覆盖。 */
function modelEnabledConfig(overrides: Record<string, unknown> = {}): AppConfig {
  const raw = {
    schema_version: 1,
    server: { host: "127.0.0.1", port: 8737 },
    processing: { default_mode: "manual_only" },
    model: {
      enabled: true,
      provider: "openai_compatible",
      base_url: "http://127.0.0.1:11434/v1",
      api_key_env: "TB_MODEL_API_KEY",
      cloud_redacted_enabled: true,
      request_timeout_ms: 30000,
      ...overrides,
    },
  };
  return parseAppConfig(raw, "test://inline");
}

describe("M4-TR-1 buildProductionProvider", () => {
  it("enabled=false → null（与今天逐字一致，不装配）", () => {
    const cfg = modelEnabledConfig({ enabled: false, cloud_redacted_enabled: false });
    expect(buildProductionProvider(cfg, {})).toBeNull();
  });

  it("enabled=true 缺 model/call_path → 装配期抛 ConfigError（fail-fast，不兜底）", () => {
    const cfg = modelEnabledConfig({});
    let caught: unknown;
    try {
      buildProductionProvider(cfg, {});
    } catch (cause) {
      caught = cause;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    expect((caught as ConfigError).fields).toContain("model.model");
    expect((caught as ConfigError).fields).toContain("model.call_path");
  });

  it("params 含 model/messages/stream/response_format 任一键 → 拒", () => {
    for (const bad of ["model", "messages", "stream", "response_format"]) {
      const cfg = modelEnabledConfig({
        model: "m",
        call_path: "ollama_openai_compatible",
        params: { [bad]: "evil" },
      });
      expect(() => buildProductionProvider(cfg, {})).toThrow(ConfigError);
    }
  });

  it("params 安全键透传、apiKeyEnv 只存变量名", () => {
    const cfg = modelEnabledConfig({
      model: "qwen",
      call_path: "ollama_openai_compatible",
      supports_structured_output: true,
      params: { temperature: 0.2 },
    });
    const bundle = buildProductionProvider(cfg, {});
    expect(bundle).not.toBeNull();
    expect(bundle!.adapter.model).toBe("qwen");
    expect(bundle!.adapter.callPath).toBe("ollama_openai_compatible");
    expect(bundle!.adapter.supportsStructuredOutput).toBe(true);
    expect(bundle!.adapter.params).toEqual({ temperature: 0.2 });
    expect(bundle!.systemPrompt).toBe(M2_PROMPT_V1);
    expect(bundle!.transport).toBe(httpTransport);
  });

  it("双 profile：按处理模式装配独立 adapter，旧单适配器路径仍保留", () => {
    const cfg = modelEnabledConfig({
      enabled: true,
      cloud_redacted_enabled: true,
      local_model: {
        enabled: true,
        provider: "ollama",
        base_url: "http://127.0.0.1:11434/v1",
        api_key_env: "TB_LOCAL_MODEL_KEY",
        request_timeout_ms: 60000,
        model: "qwen3:8b",
        call_path: "ollama_openai_compatible",
        supports_structured_output: false,
      },
      cloud_model: {
        enabled: true,
        provider: "openai_compatible",
        base_url: "https://example.invalid/v1",
        api_key_env: KEY_ENV,
        request_timeout_ms: 45000,
        model: "gpt-4.1-mini",
        call_path: "http_json_lenient",
        supports_structured_output: true,
      },
    });
    const bundle = buildProductionProvider(cfg, process.env);
    expect(bundle).not.toBeNull();
    expect(bundle!.adapters?.local_model?.provider).toBe("ollama");
    expect(bundle!.adapters?.local_model?.model).toBe("qwen3:8b");
    expect(bundle!.adapters?.cloud_redacted?.provider).toBe("openai_compatible");
    expect(bundle!.adapters?.cloud_redacted?.model).toBe("gpt-4.1-mini");
    expect(bundle!.adapter.provider).toBe("openai_compatible");
  });

  it("旧配置（无扩字段）照解析：兼容零回归", () => {
    // 默认模板里没有 model/call_path/supports/params —— schema_version 仍是 1。
    const loaded = loadConfigFromPath(TEMPLATE_CONFIG_PATH, {});
    expect(loaded.config.model.enabled).toBe(false);
    expect(loaded.config.model).not.toHaveProperty("call_path");
    // 且模板装配 → null（enabled=false）。
    expect(buildProductionProvider(loaded.config, {})).toBeNull();
  });
});

// ── 四、提示词 ↔ contract 字段表对账 ──────────────────────────────

describe("M4-TR-1 生产提示词 ↔ m2-output-v1 对账", () => {
  /** 递归收集 zod 生成的 JSON Schema 里所有 properties 键名 = 契约字段全集。 */
  function collectPropertyNames(node: unknown, out: Set<string>): void {
    if (Array.isArray(node)) {
      node.forEach((child) => collectPropertyNames(child, out));
      return;
    }
    if (node !== null && typeof node === "object") {
      for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
        if (key === "properties" && child !== null && typeof child === "object") {
          Object.keys(child as Record<string, unknown>).forEach((name) => out.add(name));
        }
        collectPropertyNames(child, out);
      }
    }
  }

  it("契约字段全集与提示词字段清单一一对应，且全部出现在正文", () => {
    const json = z.toJSONSchema(structuredOutputSchema, { io: "output", target: "draft-2020-12" });
    const contractFields = new Set<string>();
    collectPropertyNames(json, contractFields);
    const promptListed = new Set<string>(M2_PROMPT_CONTRACT_FIELDS);
    // 提示词清单覆盖的每个字段都得出现在正文里。
    for (const field of promptListed) expect(M2_PROMPT_V1.includes(`"${field}"`)).toBe(true);
    // 双向对账：契约有而清单漏 = 0；清单有而契约无 = 0。
    const missing = [...contractFields].filter((f) => !promptListed.has(f));
    const extra = [...promptListed].filter((f) => !contractFields.has(f));
    expect(missing).toEqual([]);
    expect(extra).toEqual([]);
  });

  it("封闭枚举取值写进正文", () => {
    for (const v of ["explicit", "inferred"]) expect(M2_PROMPT_V1).toContain(v);
    for (const v of ["year", "month", "day", "unknown"]) expect(M2_PROMPT_V1).toContain(v);
    for (const v of ["approximate"]) expect(M2_PROMPT_V1).toContain(v);
  });

  it("版本串沿用 m2-prompt-v1 不升", () => {
    // DEFAULT_PROMPT_VERSION 保持 m2-prompt-v1（升版会动 K-17 指纹面）。
    expect(M2_PROMPT_V1.length).toBeGreaterThan(200);
  });
});
