import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadConfigFromPath } from "../src/server/config/config.ts";
import { FileCredentialStore } from "../src/server/config/credentials.ts";
import {
  probeModelConnection,
  type ModelAdapter,
  type ProviderTransport,
  type TransportRequest,
} from "../src/server/ingest/provider.ts";

const SENTINEL = "sk-M5-6-SENTINEL-DO-NOT-LEAK";
const ENV_NAME = "TB_M5_6_TEST_KEY";
const roots: string[] = [];

function tempStore(): { root: string; store: FileCredentialStore } {
  const root = mkdtempSync(join(tmpdir(), "tb-m5-6-"));
  roots.push(root);
  return { root, store: new FileCredentialStore(join(root, ".thoughtsbox", "secrets")) };
}

afterEach(() => {
  delete process.env[ENV_NAME];
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function adapter(overrides: Partial<ModelAdapter> = {}): ModelAdapter {
  return {
    provider: "test-provider",
    model: "test-model",
    baseUrl: "http://127.0.0.1:11434/v1",
    callPath: "ollama_openai_compatible",
    supportsStructuredOutput: false,
    requestTimeoutMs: 2000,
    ...overrides,
  };
}

function transportReturning(
  status: number,
  body: string,
  seen: TransportRequest[] = [],
): ProviderTransport {
  return {
    async send(request) {
      seen.push(request);
      return { status, body };
    },
  };
}

describe("M5-6 CredentialStore", () => {
  it("保存密钥后可读，且已保存值优先于环境变量", () => {
    const { store } = tempStore();
    process.env[ENV_NAME] = "env-key";

    expect(store.resolve("cloud_redacted", ENV_NAME)).toEqual({
      key: "env-key",
      source: "environment",
    });
    store.write("cloud_redacted", SENTINEL);

    expect(store.read("cloud_redacted")).toBe(SENTINEL);
    expect(store.resolve("cloud_redacted", ENV_NAME)).toEqual({
      key: SENTINEL,
      source: "saved",
    });
  });

  it("文件使用用户私有权限；显式清除后删除文件并回退环境变量", () => {
    const { store } = tempStore();
    store.write("local_model", SENTINEL);
    const file = join(store.secretsDir, "local_model.key");

    expect(existsSync(file)).toBe(true);
    if (process.platform !== "win32") {
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(statSync(store.secretsDir).mode & 0o777).toBe(0o700);
    }

    process.env[ENV_NAME] = "env-key";
    store.clear("local_model");
    expect(existsSync(file)).toBe(false);
    expect(store.resolve("local_model", ENV_NAME)).toEqual({
      key: "env-key",
      source: "environment",
    });
  });

  it("空白输入不会覆盖旧密钥", () => {
    const { store } = tempStore();
    store.write("cloud_redacted", SENTINEL);
    expect(() => store.write("cloud_redacted", "   ")).toThrow(/空白/);
    expect(store.read("cloud_redacted")).toBe(SENTINEL);
  });

  it("启动读取配置时已保存密钥优先于环境变量", () => {
    const { root, store } = tempStore();
    store.write("cloud_redacted", SENTINEL);
    const file = join(root, "config.json");
    writeFileSync(
      file,
      JSON.stringify({
        schema_version: 1,
        server: { host: "127.0.0.1", port: 8737 },
        processing: { default_mode: "manual_only" },
        model: {
          enabled: true,
          provider: "openai_compatible",
          base_url: "https://api.example.invalid/v1",
          api_key_env: ENV_NAME,
          cloud_redacted_enabled: true,
          request_timeout_ms: 30000,
          cloud_model: {
            enabled: true,
            provider: "openai_compatible",
            base_url: "https://api.example.invalid/v1",
            api_key_env: ENV_NAME,
            request_timeout_ms: 30000,
          },
        },
      }),
      "utf8",
    );

    const loaded = loadConfigFromPath(file, { [ENV_NAME]: "env-key" }, store);
    expect(loaded.apiKey).toBe(SENTINEL);
  });
});

describe("M5-6 模型连通性探测", () => {
  it("只发送固定最小消息，复用 URL 归一化和临时密钥，不泄露密钥", async () => {
    const seen: TransportRequest[] = [];
    const result = await probeModelConnection(
      adapter({ resolveApiKey: () => SENTINEL }),
      "local_model",
      transportReturning(
        200,
        JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }),
        seen,
      ),
    );

    expect(result.ok).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe("http://127.0.0.1:11434/v1/chat/completions");
    expect(seen[0]?.redirect).toBe("error");
    expect(seen[0]?.headers.authorization).toBe(`Bearer ${SENTINEL}`);
    expect(seen[0]?.body.messages).toEqual([
      { role: "system", content: "这是模型服务连通性检查，不涉及用户记录。" },
      { role: "user", content: '请只回复 JSON：{"ok":true}' },
    ]);
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
  });

  it.each([
    [401, "auth_failed"],
    [403, "auth_failed"],
    [404, "model_not_found"],
    [429, "rate_limited"],
    [500, "provider_unavailable"],
  ] as const)("HTTP %s 映射为 %s", async (status, code) => {
    const result = await probeModelConnection(
      adapter(),
      "local_model",
      transportReturning(status, JSON.stringify({ error: SENTINEL })),
    );
    expect(result).toMatchObject({ ok: false, code, httpStatus: status });
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
  });

  it("非法响应体只报封闭错误码，不回显原始响应", async () => {
    const result = await probeModelConnection(
      adapter(),
      "local_model",
      transportReturning(200, SENTINEL),
    );
    expect(result).toMatchObject({ ok: false, code: "invalid_response", httpStatus: 200 });
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
  });

  it("网络失败、超时与非回环本地地址分别收敛", async () => {
    const network = await probeModelConnection(adapter(), "local_model", {
      async send() {
        throw new Error("socket refused");
      },
    });
    expect(network).toMatchObject({ ok: false, code: "network" });

    const timeout = await probeModelConnection(
      adapter({ requestTimeoutMs: 10 }),
      "local_model",
      {
        send(request) {
          return new Promise((_, reject) => {
            request.signal.addEventListener("abort", () => reject(new Error("aborted")), {
              once: true,
            });
          });
        },
      },
    );
    expect(timeout).toMatchObject({ ok: false, code: "timeout" });

    const nonLoopback = await probeModelConnection(
      adapter({ baseUrl: "https://example.com/v1" }),
      "local_model",
      transportReturning(200, "{}"),
    );
    expect(nonLoopback).toMatchObject({ ok: false, code: "invalid_config" });
  });
});
