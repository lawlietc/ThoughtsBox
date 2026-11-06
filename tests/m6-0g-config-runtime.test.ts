import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { isAbsolute, join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  configSourcePath,
  effectiveModelProfile,
  ensureConfigFile,
  LOCAL_MODEL_RUNTIMES,
  loadConfigFromPath,
  parseAppConfig,
  TEMPLATE_CONFIG_PATH,
  writeConfigFile,
} from "../src/server/config/config.ts";
import { ConfigError } from "../src/server/config/errors.ts";
import { defaultDataDir, resolveDataLayout, type DataLayout } from "../src/server/config/paths.ts";
import { boot, shutdown, type BootResult } from "../src/server/runtime/bootstrap.ts";
import { DEFAULT_API_KEY_ENV } from "../src/shared/constants/model.ts";
import { makeAdapter, OK_ENVELOPE, stubTransport, SYSTEM_PROMPT, validOutput } from "./helpers/ingestFixtures.ts";
import { makeSandbox, type Sandbox } from "./helpers/sandbox.ts";

/**
 * M6-0G：配置层的 `runtime` 判别字段。
 * 口径（2026-10-24 裁决）：不内置本地模型运行时，`runtime` 唯一取值 `external_http`、可省略，
 * 存量配置行为逐字不变；其余运行时字段一个都不引入，出现即被严格 schema 拒绝。
 */

const LOCAL_LOOPBACK = "http://127.0.0.1:11434/v1";

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()!();
  }
});

function localProfile(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    enabled: true,
    provider: "ollama",
    base_url: LOCAL_LOOPBACK,
    request_timeout_ms: 60000,
    model: "qwen3:8b",
    call_path: "ollama_openai_compatible",
    supports_structured_output: false,
    ...overrides,
  };
}

function cloudProfile(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    enabled: false,
    provider: "openai_compatible",
    base_url: "https://api.example.invalid/v1",
    request_timeout_ms: 45000,
    model: "gpt-4.1-mini",
    call_path: "http_json_lenient",
    supports_structured_output: true,
    ...overrides,
  };
}

/** 一份「双 profile 且本地档没写过 runtime」的旧配置——存量用户升级后看到的就是这个形状。 */
function legacyRaw(
  local: Record<string, unknown> = localProfile(),
  cloud: Record<string, unknown> = cloudProfile(),
): Record<string, unknown> {
  return {
    schema_version: 1,
    server: { host: "127.0.0.1", port: 8737 },
    processing: { default_mode: "manual_only" },
    model: {
      enabled: true,
      provider: "ollama",
      base_url: LOCAL_LOOPBACK,
      cloud_redacted_enabled: false,
      request_timeout_ms: 60000,
      model: "qwen3:8b",
      call_path: "ollama_openai_compatible",
      local_model: local,
      cloud_model: cloud,
    },
  };
}

function expectConfigError(build: () => unknown): ConfigError {
  try {
    build();
  } catch (cause) {
    expect(cause, String(cause)).toBeInstanceOf(ConfigError);
    return cause as ConfigError;
  }
  throw new Error("预期抛 ConfigError，实际没有抛");
}

function listTree(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const child = `${dir}/${entry.name}`;
    out.push(child);
    if (entry.isDirectory()) out.push(...listTree(child));
  }
  return out;
}

function inside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

function sandboxEnv(sandbox: Sandbox): NodeJS.ProcessEnv {
  // 连后备路径也指进沙箱：本次测试不存在触碰 %LOCALAPPDATA%\ThoughtsBox 的可能。
  return {
    TB_DATA_DIR: sandbox.layout.dataDir,
    LOCALAPPDATA: sandbox.root,
    USERPROFILE: sandbox.root,
    HOME: sandbox.root,
  };
}

/* ── 断言 1/2：旧配置逐字不变 ─────────────────────────────────────── */

describe("M6-0G · 旧配置照常加载", () => {
  it("local_model 无 runtime ⇒ 加载成功、推导为 external_http，既有字段一字不改", () => {
    const parsed = parseAppConfig(legacyRaw(), "inline");
    const local = effectiveModelProfile(parsed, "local_model");

    expect(local.runtime).toBe("external_http");
    // 判别字段是「读出来补上的」，不是被写回配置对象的：内存里的 profile 仍与旧文件同形。
    expect(parsed.model.local_model).not.toHaveProperty("runtime");
    expect(parsed.model.local_model).toEqual({ ...localProfile(), api_key_env: DEFAULT_API_KEY_ENV });
    // 云端那一档同样恒填 external_http，仅为单一返回形状，配置里不出现这个键。
    expect(effectiveModelProfile(parsed, "cloud_redacted").runtime).toBe("external_http");
    expect(parsed.model.cloud_model).not.toHaveProperty("runtime");
  });

  it("更老的形态（只有 model.base_url，无 profile）仍按回退链推导并填 external_http", () => {
    const raw = legacyRaw();
    const model = raw.model as Record<string, unknown>;
    delete model.local_model;
    delete model.cloud_model;
    const parsed = parseAppConfig(raw, "inline");
    const local = effectiveModelProfile(parsed, "local_model");

    expect(local.enabled).toBe(true);
    expect(local.base_url).toBe(LOCAL_LOOPBACK);
    expect(local.runtime).toBe("external_http");
    expect(parsed.model).not.toHaveProperty("local_model");
  });

  it("非回环的本地端点仍被拒（既有错误行为不变，runtime 不参与判定）", () => {
    const err = expectConfigError(() =>
      parseAppConfig(legacyRaw(localProfile({ base_url: "https://not-local.example/v1" })), "inline"),
    );
    expect(err.message).toMatch(/本地模型只允许回环地址/);
    expect(err.fields).toContain("model.local_model.base_url");
  });

  it("显式写了 external_http 的配置照解析，值原样保留", () => {
    const parsed = parseAppConfig(legacyRaw(localProfile({ runtime: "external_http" })), "inline");
    expect(parsed.model.local_model?.runtime).toBe("external_http");
    expect(effectiveModelProfile(parsed, "local_model").runtime).toBe("external_http");
  });

  it("取值域钉死为单项 external_http（扩取值必须先重启本地运行时路线）", () => {
    expect(LOCAL_MODEL_RUNTIMES).toEqual(["external_http"]);
  });
});

/* ── 断言 3/4：非法 runtime 与已删除的运行时字段 ──────────────────── */

describe("M6-0G · 启动期拒绝", () => {
  const rejectedRuntimes: unknown[] = [
    "managed_llama_cpp",
    "embedded",
    "EXTERNAL_HTTP",
    "External_HTTP",
    "external_http ",
    "ollama",
    "",
    42,
    true,
    null,
    [],
    {},
  ];

  for (const value of rejectedRuntimes) {
    it(`runtime=${JSON.stringify(value)} ⇒ 可读的 ConfigError，带字段路径`, () => {
      const err = expectConfigError(() => parseAppConfig(legacyRaw(localProfile({ runtime: value })), "inline"));
      expect(err.fields).toContain("model.local_model.runtime");
      expect(err.message).toMatch(/不内置本地模型运行时/);
      expect(err.message).toMatch(/external_http/);
      expect(err.message).toMatch(/M6-0H/);
    });
  }

  it("cloud_model.runtime 也被拒：判别字段只存在于本地一档", () => {
    const err = expectConfigError(() =>
      parseAppConfig(legacyRaw(localProfile(), cloudProfile({ runtime: "external_http" })), "inline"),
    );
    expect(err.message).toMatch(/model\.cloud_model/);
    expect(err.message).toMatch(/runtime/);
    // 不是 runtime 那条前置校验报的：它只看本地档。
    expect(err.message).not.toMatch(/不内置本地模型运行时/);
  });

  const removedFields = [
    "context_size",
    "threads",
    "max_ram_mb",
    "load_policy",
    "idle_unload_sec",
    "model_path",
    "model_id",
  ];

  for (const field of removedFields) {
    it(`local_model 里出现已删除的运行时字段 ${field} ⇒ 严格 schema 拒绝`, () => {
      const err = expectConfigError(() =>
        parseAppConfig(legacyRaw(localProfile({ [field]: field === "load_policy" ? "eager" : 1 })), "inline"),
      );
      expect(err.message).toContain(field);
      expect(err.message).toMatch(/model\.local_model/);
      expect(err.message).not.toMatch(/不内置本地模型运行时/);
    });
  }

  it("前置校验对畸形入参不越权：raw 不是对象、各层为 null 或数组时当「未设置」", () => {
    // 这些仍会因 schema 失败，但不能失败在 runtime 那条分支上——错误归因要准。
    for (const broken of [null, "config", [], { model: null }, { model: { local_model: "ollama" } }]) {
      const err = expectConfigError(() => parseAppConfig(broken, "inline"));
      expect(err.message).not.toMatch(/不内置本地模型运行时/);
    }
  });
});

/* ── 断言 5/6：写盘往返与模板一致 ────────────────────────────────── */

describe("M6-0G · 往返与模板", () => {
  it("writeConfigFile 往返：runtime 不被丢，重读与内存对象逐字一致", () => {
    const sandbox = makeSandbox("tb-m6-0g-roundtrip-");
    cleanups.push(() => sandbox.cleanup());
    mkdirSync(sandbox.layout.dataDir, { recursive: true });

    const config = parseAppConfig(
      legacyRaw(localProfile({ runtime: "external_http" })),
      sandbox.layout.configFile,
    );
    writeConfigFile(sandbox.layout.configFile, config);

    const saved = JSON.parse(readFileSync(sandbox.layout.configFile, "utf8")) as {
      model: { local_model?: Record<string, unknown> };
    };
    expect(saved.model.local_model?.runtime).toBe("external_http");
    expect(parseAppConfig(saved, sandbox.layout.configFile)).toEqual(config);
    expect(readdirSync(sandbox.layout.dataDir).some((name) => name.endsWith(".tmp"))).toBe(false);
  });

  it("模板 config.example.json 带 local_model.runtime 且能被 parseAppConfig 解析（示例与 schema 不漂移）", () => {
    const raw = JSON.parse(readFileSync(TEMPLATE_CONFIG_PATH, "utf8")) as unknown;
    const parsed = parseAppConfig(raw, TEMPLATE_CONFIG_PATH);

    expect(parsed.model.local_model?.runtime).toBe("external_http");
    expect(effectiveModelProfile(parsed, "local_model").runtime).toBe("external_http");
    // 示例必须是「关掉」的状态，且不含任何密钥字面量。
    expect(parsed.model.local_model?.enabled).toBe(false);
    expect(parsed.model.local_model?.base_url).toBe("http://127.0.0.1:8080");
    expect(JSON.stringify(raw)).not.toMatch(/api_key/i);
  });
});

/* ── 断言 7：TB_DATA_DIR 沙箱隔离 ────────────────────────────────── */

describe("M6-0G · TB_DATA_DIR 沙箱", () => {
  it("读写只落在沙箱内；读取一个文件都不多写", () => {
    const sandbox = makeSandbox("tb-m6-0g-sandbox-");
    cleanups.push(() => sandbox.cleanup());
    // 数据目录另起一层：mkdtemp 已创建 sandbox.root，用它断言「拿锁前不建目录」会失真。
    const layout = resolveDataLayout({ TB_DATA_DIR: join(sandbox.root, "data") });
    const env: NodeJS.ProcessEnv = { ...sandboxEnv(sandbox), TB_DATA_DIR: layout.dataDir };
    expect(layout.envOverride).toBe(true);
    expect(inside(sandbox.root, defaultDataDir(env))).toBe(true);

    // 拿锁之前只读定位来源，不创建目录也不写文件。
    expect(existsSync(layout.dataDir)).toBe(false);
    expect(configSourcePath(layout)).toBe(TEMPLATE_CONFIG_PATH);
    expect(existsSync(layout.dataDir)).toBe(false);

    mkdirSync(layout.dataDir, { recursive: true }); // 正式启动里这一步是 ensureDataDirs 的责任
    const created = ensureConfigFile(layout);
    writeConfigFile(created, parseAppConfig(legacyRaw(localProfile({ runtime: "external_http" })), created));

    const afterWrite = listTree(sandbox.root);
    expect(afterWrite.every((path) => inside(sandbox.root, path))).toBe(true);
    expect(afterWrite.some((path) => path.endsWith("config.local.json"))).toBe(true);

    const loaded = loadConfigFromPath(created, env);
    expect(loaded.filePath).toBe(created);
    expect(inside(sandbox.root, loaded.filePath)).toBe(true);
    expect(effectiveModelProfile(loaded.config, "local_model").runtime).toBe("external_http");
    // 读取是纯读：沙箱里的文件清单一条都没多。
    expect(listTree(sandbox.root)).toEqual(afterWrite);
  });
});

/* ── 设置页保存不抹掉判别字段（ingestRoutes.profileFromBody） ─────── */

describe("M6-0G · 设置页保存", () => {
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
    const raw = legacyRaw(localProfile({ runtime: "external_http" })) as { server: { port: number } };
    raw.server.port = port;
    writeFileSync(layout.configFile, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
  }

  async function start(): Promise<{ sandbox: Sandbox; base: string }> {
    const sandbox = makeSandbox("tb-m6-0g-api-");
    mkdirSync(sandbox.layout.dataDir, { recursive: true });
    ensureConfigFile(sandbox.layout);
    const port = await freePort();
    writePort(sandbox.layout, port);
    const stub = stubTransport(OK_ENVELOPE(validOutput()));
    let booted: BootResult;
    try {
      booted = await boot({
        env: sandboxEnv(sandbox),
        log: () => {},
        ingestProvider: { adapter: makeAdapter(), transport: stub.transport, systemPrompt: SYSTEM_PROMPT },
      });
    } catch (cause) {
      sandbox.cleanup();
      throw cause;
    }
    cleanups.push(async () => {
      await shutdown(booted);
      sandbox.cleanup();
    });
    return { sandbox, base: `http://127.0.0.1:${port}` };
  }

  const localBody = {
    enabled: true,
    provider: "ollama",
    model: "qwen3:8b",
    baseUrl: LOCAL_LOOPBACK,
    callPath: "ollama_openai_compatible",
    supportsStructuredOutput: false,
    requestTimeoutMs: 60000,
  };
  const cloudBody = {
    enabled: false,
    provider: "openai_compatible",
    model: "gpt-4.1-mini",
    baseUrl: "https://api.example.invalid/v1",
    callPath: "http_json_lenient",
    supportsStructuredOutput: true,
    requestTimeoutMs: 45000,
  };

  it("PUT 保存一次：local_model.runtime 原样留住，cloud_model 不被添上这个键", async () => {
    const { sandbox, base } = await start();
    const response = await fetch(`${base}/api/ingest/config`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ localModel: localBody, cloudModel: cloudBody }),
    });
    expect(response.status).toBe(200);
    const dto = (await response.json()) as Record<string, unknown>;

    const onDisk = JSON.parse(readFileSync(sandbox.layout.configFile, "utf8")) as {
      model: { local_model?: Record<string, unknown>; cloud_model?: Record<string, unknown> };
    };
    expect(onDisk.model.local_model?.runtime).toBe("external_http");
    expect(onDisk.model.cloud_model).not.toHaveProperty("runtime");
    // 判别字段不进 DTO：设置页展示 runtime 属阶段 1 UI。
    expect(dto.localModel).not.toHaveProperty("runtime");
    expect(dto.cloudModel).not.toHaveProperty("runtime");
  });
});
