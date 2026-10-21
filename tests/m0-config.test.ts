import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  configSourcePath,
  ensureConfigFile,
  loadConfig,
  loadConfigFromPath,
  parseAppConfig,
  TEMPLATE_CONFIG_PATH,
  writeConfigFile,
} from "../src/server/config/config.ts";
import { ConfigError } from "../src/server/config/errors.ts";
import { resolveDataLayout } from "../src/server/config/paths.ts";

let root: string | undefined;

afterEach(() => {
  if (root !== undefined) {
    rmSync(root, { recursive: true, force: true });
    root = undefined;
  }
});

function sandboxDataDir(): string {
  root = mkdtempSync(join(tmpdir(), "tb-config-"));
  return join(root, "data");
}

function layoutWith(dataDir: string) {
  mkdirSync(dataDir, { recursive: true });
  return resolveDataLayout({ TB_DATA_DIR: dataDir });
}

function dualProfileRaw(): Record<string, unknown> {
  return {
    schema_version: 1,
    server: { host: "127.0.0.1", port: 8737 },
    processing: { default_mode: "manual_only" },
    model: {
      enabled: true,
      provider: "ollama",
      base_url: "http://127.0.0.1:11434/v1",
      api_key_env: "TB_LOCAL_MODEL_KEY",
      cloud_redacted_enabled: false,
      request_timeout_ms: 60000,
      model: "qwen3:8b",
      call_path: "ollama_openai_compatible",
      supports_structured_output: false,
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
        enabled: false,
        provider: "openai_compatible",
        base_url: "https://example.invalid/v1",
        api_key_env: "TB_CLOUD_MODEL_KEY",
        request_timeout_ms: 45000,
        model: "gpt-4.1-mini",
        call_path: "http_json_lenient",
        supports_structured_output: true,
      },
    },
  };
}

describe("配置加载（M0 交付物 5）", () => {
  it("模板文件本身不含真实密钥，只有占位值", () => {
    const raw = JSON.parse(readFileSync(TEMPLATE_CONFIG_PATH, "utf8")) as unknown;
    const text = JSON.stringify(raw);
    expect(text).toContain("REPLACE_WITH");
    expect(text).not.toMatch(/sk-/);
    const parsed = parseAppConfig(raw, TEMPLATE_CONFIG_PATH);
    expect(parsed.model.api_key_env).toBe("TB_MODEL_API_KEY");
  });

  it("首次启动从模板生成 config.local.json，二次启动不覆盖", () => {
    const layout = layoutWith(sandboxDataDir());
    expect(existsSync(layout.configFile)).toBe(false);
    expect(configSourcePath(layout)).toBe(TEMPLATE_CONFIG_PATH);
    const created = ensureConfigFile(layout);
    expect(created).toBe(layout.configFile);
    const first = readFileSync(layout.configFile, "utf8");
    writeFileSync(layout.configFile, `${first}\n`, "utf8");
    ensureConfigFile(layout);
    expect(readFileSync(layout.configFile, "utf8")).toBe(`${first}\n`);
  });

  it("默认配置是 manual_only 且云端未启用", () => {
    const layout = layoutWith(sandboxDataDir());
    const loaded = loadConfig(layout, {});
    expect(loaded.config.processing.default_mode).toBe("manual_only");
    expect(loaded.config.model.enabled).toBe(false);
    expect(loaded.config.model.cloud_redacted_enabled).toBe(false);
    expect(loaded.config.server.host).toBe("127.0.0.1");
    expect(loaded.apiKey).toBeUndefined();
  });

  it("绑定非回环地址被拒绝（配置层就挡掉，不等运行时）", () => {
    expect(() =>
      parseAppConfig(
        {
          schema_version: 1,
          server: { host: "0.0.0.0", port: 8737 },
          processing: { default_mode: "manual_only" },
          model: {
            enabled: false,
            provider: "openai_compatible",
            base_url: "https://example.invalid/v1",
            api_key_env: "TB_MODEL_API_KEY",
            cloud_redacted_enabled: false,
            request_timeout_ms: 30000,
          },
        },
        "inline",
      ),
    ).toThrow(ConfigError);
  });

  it("配置写错时报出文件路径与字段名，不静默使用默认值", () => {
    const layout = layoutWith(sandboxDataDir());
    ensureConfigFile(layout);
    const broken = JSON.parse(readFileSync(layout.configFile, "utf8")) as Record<string, unknown>;
    broken.schema_version = 2;
    (broken.processing as Record<string, unknown>).default_mode = "cloud_always";
    writeFileSync(layout.configFile, JSON.stringify(broken), "utf8");
    try {
      loadConfig(layout, {});
      throw new Error("应该失败");
    } catch (cause) {
      expect(cause).toBeInstanceOf(ConfigError);
      const message = (cause as Error).message;
      expect(message).toContain(layout.configFile);
      expect(message).toMatch(/schema_version/);
      expect(message).toMatch(/processing\.default_mode/);
    }
  });

  it("疑似密钥字段直接拒绝，不剥离也不回落", () => {
    const layout = layoutWith(sandboxDataDir());
    ensureConfigFile(layout);
    const withKey = JSON.parse(readFileSync(layout.configFile, "utf8")) as Record<string, unknown>;
    (withKey.model as Record<string, unknown>).api_key = "sk-replace-me";
    writeFileSync(layout.configFile, JSON.stringify(withKey), "utf8");
    try {
      loadConfig(layout, {});
      throw new Error("应该失败");
    } catch (cause) {
      expect(cause).toBeInstanceOf(ConfigError);
      expect((cause as ConfigError).fields).toContain("model.api_key");
      expect((cause as Error).message).toContain("环境变量");
    }
  });

  it("开了云端却没有密钥：报错，不降级为本地模式", () => {
    const layout = layoutWith(sandboxDataDir());
    ensureConfigFile(layout);
    const raw = JSON.parse(readFileSync(layout.configFile, "utf8")) as Record<string, unknown>;
    raw.model = {
      ...(raw.model as Record<string, unknown>),
      enabled: true,
      cloud_redacted_enabled: true,
      base_url: "https://example.invalid/v1",
    };
    writeFileSync(layout.configFile, JSON.stringify(raw), "utf8");
    expect(() => loadConfig(layout, {})).toThrow(/TB_MODEL_API_KEY/);
    const withKey = loadConfigFromPath(layout.configFile, { TB_MODEL_API_KEY: "secret" });
    expect(withKey.apiKey).toBe("secret");
  });

  it("双 profile 配置可解析；只启用本地档时不要求云端密钥", () => {
    const layout = layoutWith(sandboxDataDir());
    ensureConfigFile(layout);
    writeFileSync(layout.configFile, JSON.stringify(dualProfileRaw()), "utf8");
    const loaded = loadConfigFromPath(layout.configFile, {});
    expect(loaded.config.model.local_model?.enabled).toBe(true);
    expect(loaded.config.model.cloud_model?.enabled).toBe(false);
    expect(loaded.apiKey).toBeUndefined();
  });

  it("本地 profile 启用时必须是回环地址", () => {
    const raw = dualProfileRaw();
    const model = raw.model as Record<string, unknown>;
    const local = model.local_model as Record<string, unknown>;
    local.base_url = "https://not-local.example/v1";
    expect(() => parseAppConfig(raw, "inline")).toThrow(/本地模型只允许回环地址/);
  });

  it("云端 profile 启用但顶层隐私闸门关闭：矛盾配置直接拒绝", () => {
    const raw = dualProfileRaw();
    const model = raw.model as Record<string, unknown>;
    const cloud = model.cloud_model as Record<string, unknown>;
    cloud.enabled = true;
    model.cloud_redacted_enabled = false;
    expect(() => parseAppConfig(raw, "inline")).toThrow(/cloud_redacted_enabled 未开启/);
  });

  it("writeConfigFile 原子写回：落盘可重读且不遗留临时文件", () => {
    const layout = layoutWith(sandboxDataDir());
    ensureConfigFile(layout);
    const config = parseAppConfig(dualProfileRaw(), layout.configFile);
    writeConfigFile(layout.configFile, config);

    const saved = JSON.parse(readFileSync(layout.configFile, "utf8")) as {
      model: { local_model?: { model?: string } };
    };
    expect(saved.model.local_model?.model).toBe("qwen3:8b");
    expect(readdirSync(layout.dataDir).some((name) => name.endsWith(".tmp"))).toBe(false);
  });

  it("拿锁之前不写配置：configSourcePath 只读定位来源", () => {
    const dataDir = sandboxDataDir();
    const layout = resolveDataLayout({ TB_DATA_DIR: dataDir });
    expect(existsSync(dataDir)).toBe(false);
    expect(configSourcePath(layout)).toBe(TEMPLATE_CONFIG_PATH);
    expect(existsSync(dataDir)).toBe(false);
  });

  it("TB_DATA_DIR 为空串时不视为覆盖，等于仓库根时拒绝", () => {
    const same = resolveDataLayout({ TB_DATA_DIR: "  " });
    expect(same.envOverride).toBe(false);
    expect(() => resolveDataLayout({ TB_DATA_DIR: process.cwd() })).toThrow(/仓库根/);
  });
});
