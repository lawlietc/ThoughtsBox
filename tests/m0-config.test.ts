import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
