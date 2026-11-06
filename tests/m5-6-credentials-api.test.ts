import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ensureConfigFile } from "../src/server/config/config.ts";
import type { DataLayout } from "../src/server/config/paths.ts";
import type {
  ModelAdapter,
  ProviderTransport,
  TransportRequest,
  TransportResponse,
} from "../src/server/ingest/provider.ts";
import { boot, shutdown, type BootResult } from "../src/server/runtime/bootstrap.ts";
import { DEFAULT_API_KEY_ENV } from "../src/shared/constants/model.ts";
import { makeSandbox, countRows, type Sandbox } from "./helpers/sandbox.ts";

const SENTINEL = "sk-M5-6-API-SENTINEL-DO-NOT-LEAK";
const ENV_KEY = "env-key-for-m5-6-test";
const ENV_NAME = DEFAULT_API_KEY_ENV;

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

function writePort(layout: DataLayout, port: number): void {
  mkdirSync(layout.dataDir, { recursive: true });
  const file = ensureConfigFile(layout);
  const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  (raw.server as Record<string, unknown>).port = port;
  writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
}

function testAdapter(): ModelAdapter {
  return {
    provider: "test-provider",
    model: "test-model",
    baseUrl: "http://127.0.0.1:11434/v1",
    callPath: "ollama_openai_compatible",
    supportsStructuredOutput: false,
    requestTimeoutMs: 2000,
  };
}

async function start(
  options: {
    readonly env?: NodeJS.ProcessEnv;
    readonly response?: TransportResponse;
  } = {},
): Promise<RunningApp> {
  const sandbox = makeSandbox("tb-m56-api-");
  const seen: TransportRequest[] = [];
  const transport: ProviderTransport = {
    async send(request) {
      seen.push(request);
      return options.response ?? {
        status: 200,
        body: JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }),
      };
    },
  };
  const port = await freePort();
  writePort(sandbox.layout, port);
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
        adapter: testAdapter(),
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

async function call(
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

function profile(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    enabled: false,
    provider: "openai_compatible",
    model: "test-model",
    baseUrl: "https://api.example.invalid/v1",
    callPath: "http_json_lenient",
    supportsStructuredOutput: false,
    requestTimeoutMs: 5000,
    ...overrides,
  };
}

function configBody(cloud: Record<string, unknown>): Record<string, unknown> {
  return { localModel: profile(), cloudModel: profile(cloud) };
}

function secretPath(app: RunningApp): string {
  return join(app.sandbox.root, ".thoughtsbox", "secrets", "cloud_redacted.key");
}

afterEach(async () => {
  while (running.length > 0) {
    await running.pop()!.stop();
  }
});

describe("M5-6 credential API", () => {
  it("PUT stores a typed key without putting the secret in config or responses", async () => {
    const app = await start({ env: { [ENV_NAME]: ENV_KEY } });

    const saved = await call(
      app,
      "PUT",
      "/api/ingest/config",
      configBody({ enabled: true, apiKey: SENTINEL }),
    );

    expect(saved.status).toBe(200);
    expect(saved.json.cloudModel.apiKeySource).toBe("saved");
    expect(JSON.stringify(saved.json)).not.toContain(SENTINEL);
    expect(readFileSync(app.sandbox.layout.configFile, "utf8")).not.toContain(SENTINEL);
    expect(readFileSync(secretPath(app), "utf8").trim()).toBe(SENTINEL);

    const loaded = await call(app, "GET", "/api/ingest/config");
    expect(loaded.status).toBe(200);
    expect(loaded.json.cloudModel.apiKeySource).toBe("saved");
    expect(JSON.stringify(loaded.json)).not.toContain(SENTINEL);
  });

  it("a saved key beats the environment, a blank key preserves it, and clear falls back to the environment", async () => {
    const app = await start({ env: { [ENV_NAME]: ENV_KEY } });

    const first = await call(
      app,
      "PUT",
      "/api/ingest/config",
      configBody({ enabled: true, apiKey: SENTINEL }),
    );
    expect(first.status).toBe(200);
    expect(first.json.cloudModel.apiKeySource).toBe("saved");

    const blank = await call(
      app,
      "PUT",
      "/api/ingest/config",
      configBody({ enabled: true, apiKey: "   " }),
    );
    expect(blank.status).toBe(200);
    expect(blank.json.cloudModel.apiKeySource).toBe("saved");
    expect(readFileSync(secretPath(app), "utf8").trim()).toBe(SENTINEL);

    const rotated = `${SENTINEL}-ROTATED`;
    const replaced = await call(
      app,
      "PUT",
      "/api/ingest/config",
      configBody({ enabled: true, apiKey: rotated }),
    );
    expect(replaced.status).toBe(200);
    expect(replaced.json.cloudModel.apiKeySource).toBe("saved");
    expect(readFileSync(secretPath(app), "utf8").trim()).toBe(rotated);

    const cleared = await call(
      app,
      "PUT",
      "/api/ingest/config",
      configBody({ enabled: true, clearApiKey: true }),
    );
    expect(cleared.status).toBe(200);
    expect(cleared.json.cloudModel.apiKeySource).toBe("environment");
    expect(existsSync(secretPath(app))).toBe(false);
  });

  it("clear leaves no source when there is neither a saved key nor an environment fallback", async () => {
    const app = await start();

    const saved = await call(
      app,
      "PUT",
      "/api/ingest/config",
      configBody({ apiKey: SENTINEL }),
    );
    expect(saved.status).toBe(200);
    expect(saved.json.cloudModel.apiKeySource).toBe("saved");

    const cleared = await call(
      app,
      "PUT",
      "/api/ingest/config",
      configBody({ clearApiKey: true }),
    );
    expect(cleared.status).toBe(200);
    expect(cleared.json.cloudModel.apiKeySource).toBe("none");
    expect(existsSync(secretPath(app))).toBe(false);
  });

  it("enabling the cloud profile without any usable key is rejected before writing config", async () => {
    const app = await start();

    const rejected = await call(
      app,
      "PUT",
      "/api/ingest/config",
      configBody({ enabled: true }),
    );

    expect(rejected.status).toBe(400);
    expect(rejected.json).toMatchObject({ error: "invalid_request" });
    expect(existsSync(secretPath(app))).toBe(false);
    const loaded = await call(app, "GET", "/api/ingest/config");
    expect(loaded.json.cloudModel.enabled).toBe(false);
  });

  it("local model works without any key and its probe sends no Authorization header", async () => {
    const app = await start();

    const saved = await call(app, "PUT", "/api/ingest/config", {
      localModel: profile({
        enabled: true,
        provider: "ollama",
        baseUrl: "http://127.0.0.1:11434/v1",
        callPath: "ollama_openai_compatible",
      }),
      cloudModel: profile(),
    });
    expect(saved.status).toBe(200);
    expect(saved.json.localModel).toMatchObject({
      enabled: true,
      apiKeyConfigured: false,
      apiKeySource: "none",
    });

    const result = await call(app, "POST", "/api/ingest/config/test", {
      profile: "local",
      provider: "ollama",
      model: "probe-model",
      baseUrl: "http://127.0.0.1:11434/v1",
      callPath: "ollama_openai_compatible",
      supportsStructuredOutput: false,
      requestTimeoutMs: 5000,
    });
    expect(result.status).toBe(200);
    expect(result.json).toMatchObject({ ok: true });
    expect(app.seen).toHaveLength(1);
    expect(app.seen[0]?.headers.authorization).toBeUndefined();
  });
});

describe("M5-6 connection-test API", () => {
  it("uses an unsaved typed key, sends only the fixed probe, and writes no record or parse run", async () => {
    const app = await start();
    const beforeRecords = countRows(app.booted.db, "capture_record");
    const beforeRuns = countRows(app.booted.db, "parse_run");

    const result = await call(app, "POST", "/api/ingest/config/test", {
      profile: "cloud",
      provider: "openai_compatible",
      model: "probe-model",
      baseUrl: "https://api.example.invalid/v1",
      callPath: "http_json_lenient",
      supportsStructuredOutput: false,
      requestTimeoutMs: 5000,
      apiKey: SENTINEL,
    });

    expect(result.status).toBe(200);
    expect(result.json).toMatchObject({ ok: true, provider: "openai_compatible", model: "probe-model" });
    expect(JSON.stringify(result.json)).not.toContain(SENTINEL);
    expect(app.seen).toHaveLength(1);
    expect(app.seen[0]?.headers.authorization).toBe(`Bearer ${SENTINEL}`);
    expect(app.seen[0]?.body.messages).toEqual([
      { role: "system", content: "这是模型服务连通性检查，不涉及用户记录。" },
      { role: "user", content: '请只回复 JSON：{"ok":true}' },
    ]);
    expect(existsSync(secretPath(app))).toBe(false);
    expect(countRows(app.booted.db, "capture_record")).toBe(beforeRecords);
    expect(countRows(app.booted.db, "parse_run")).toBe(beforeRuns);
  });

  it("returns a closed failure code without echoing the provider body", async () => {
    const app = await start({
      response: { status: 500, body: JSON.stringify({ error: SENTINEL }) },
    });

    const result = await call(app, "POST", "/api/ingest/config/test", {
      profile: "cloud",
      provider: "openai_compatible",
      model: "probe-model",
      baseUrl: "https://api.example.invalid/v1",
      callPath: "http_json_lenient",
      supportsStructuredOutput: false,
      requestTimeoutMs: 5000,
      apiKey: SENTINEL,
    });

    expect(result.status).toBe(200);
    expect(result.json).toMatchObject({
      ok: false,
      code: "provider_unavailable",
      httpStatus: 500,
    });
    expect(JSON.stringify(result.json)).not.toContain(SENTINEL);
    expect(countRows(app.booted.db, "parse_run")).toBe(0);
  });
});
