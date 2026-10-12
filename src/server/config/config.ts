import { readFileSync } from "node:fs";
import { copyFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { z } from "zod";

import { ConfigError } from "./errors.ts";
import type { DataLayout } from "./paths.ts";

/** 仓库根 = 本文件向上到 package.json 所在目录；运行时数据一律不在这里（ADR-015）。 */
export function projectRoot(): string {
  let dir = dirname(import.meta.dirname);
  for (;;) {
    if (existsSync(join(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) {
      throw new ConfigError("未找到 package.json，无法定位配置模板 config.example.json");
    }
    dir = parent;
  }
}

export const TEMPLATE_CONFIG_PATH = join(projectRoot(), "config.example.json");

export const serverConfigSchema = z
  .object({
    host: z.literal("127.0.0.1"),
    port: z.number().int().min(1024).max(65535),
  })
  .strict();

export const processingConfigSchema = z
  .object({
    default_mode: z.enum(["manual_only", "local_model", "cloud_redacted"]),
  })
  .strict();

export const modelConfigSchema = z
  .object({
    enabled: z.boolean(),
    provider: z.string().min(1),
    base_url: z.url(),
    /** 只允许记录变量名：密钥值从不进入配置文件。 */
    api_key_env: z.string().regex(/^[A-Z][A-Z0-9_]{1,127}$/),
    cloud_redacted_enabled: z.boolean(),
    request_timeout_ms: z.number().int().min(1000).max(120000),
  })
  .strict();

export const appConfigSchema = z
  .object({
    schema_version: z.literal(1),
    server: serverConfigSchema,
    processing: processingConfigSchema,
    model: modelConfigSchema,
  })
  .strict();

export type AppConfig = z.infer<typeof appConfigSchema>;

const SECRETISH_KEYS = ["api_key", "apiKey", "key", "secret", "token", "password"];

/**
 * 用户很容易把密钥直接写进 config.local.json（模板里就有 model 一节）。
 * 这里不猜、不剥离、不降级使用：直接拒绝，并说明正确做法。
 */
function rejectInlineSecrets(raw: unknown, filePath: string): void {
  if (typeof raw !== "object" || raw === null) return;
  const offenders: string[] = [];
  const walk = (value: unknown, path: string[]): void => {
    if (typeof value !== "object" || value === null) return;
    for (const [key, child] of Object.entries(value)) {
      const next = [...path, key];
      if (SECRETISH_KEYS.includes(key) && next.join(".") !== "model.api_key_env") {
        offenders.push(next.join("."));
      }
      walk(child, next);
    }
  };
  walk(raw, []);
  if (offenders.length > 0) {
    throw new ConfigError(
      "配置文件中出现了疑似密钥字段。密钥只允许通过环境变量提供（model.api_key_env 指明变量名），不落盘、不进 Git。",
      { filePath, fields: offenders },
    );
  }
}

function zodFields(error: z.ZodError): string[] {
  return error.issues.map((issue) => `${issue.path.join(".") || "(根)"}: ${issue.message}`);
}

export function parseAppConfig(raw: unknown, filePath: string): AppConfig {
  rejectInlineSecrets(raw, filePath);
  const parsed = appConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigError("配置不符合 Schema，未使用任何默认值兜底", {
      filePath,
      fields: zodFields(parsed.error),
    });
  }
  if (parsed.data.model.enabled && !parsed.data.model.cloud_redacted_enabled) {
    throw new ConfigError(
      "model.enabled 为 true 但 cloud_redacted_enabled 为 false：矛盾配置。云端整理必须显式开启（ADR-003）。",
      { filePath, fields: ["model.enabled", "model.cloud_redacted_enabled"] },
    );
  }
  return parsed.data;
}

/** 首次启动：从仓库模板生成，绝不写入任何真实值。 */
export function ensureConfigFile(layout: DataLayout, templatePath = TEMPLATE_CONFIG_PATH): string {
  if (!existsSync(layout.configFile)) {
    if (!existsSync(templatePath)) {
      throw new ConfigError("配置模板缺失，无法初始化本地配置", { filePath: templatePath });
    }
    copyFileSync(templatePath, layout.configFile);
  }
  return layout.configFile;
}

export interface LoadedConfig {
  readonly config: AppConfig;
  readonly filePath: string;
  /** 解析出的 API Key；未配置时为 undefined，由使用方按处理模式决定是否可继续。 */
  readonly apiKey: string | undefined;
}

/**
 * 只读地把配置来源定位到已存在的本地配置，否则定位到模板（ADR-015 顺序约束：
 * 端口要参与运行锁判定，而拿锁之前不允许任何写入）。
 */
export function configSourcePath(layout: DataLayout): string {
  return existsSync(layout.configFile) ? layout.configFile : TEMPLATE_CONFIG_PATH;
}

export function loadConfigFromPath(
  filePath: string,
  env: NodeJS.ProcessEnv = process.env,
): LoadedConfig {
  const resolved = resolve(filePath);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(resolved, "utf8")) as unknown;
  } catch (cause) {
    throw new ConfigError(`配置无法读取或解析：${(cause as Error).message}`, { filePath: resolved });
  }
  const config = parseAppConfig(raw, resolved);
  const keyName = config.model.api_key_env;
  const envValue = env[keyName];
  const apiKey = envValue === undefined || envValue.trim() === "" ? undefined : envValue;
  if (config.model.enabled && apiKey === undefined) {
    throw new ConfigError(
      `云端整理已开启，但环境变量 ${keyName} 未提供密钥。不会静默降级为本地模式。`,
      { filePath: resolved, fields: ["model.enabled", keyName] },
    );
  }
  return { config, filePath: resolved, apiKey };
}

/** 已持有运行锁之后的正式读取：允许生成配置文件。 */
export function loadConfig(layout: DataLayout, env: NodeJS.ProcessEnv = process.env): LoadedConfig {
  return loadConfigFromPath(ensureConfigFile(layout), env);
}
