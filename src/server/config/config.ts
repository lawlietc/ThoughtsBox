import { copyFileSync, existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { z } from "zod";

import { ConfigError } from "./errors.ts";
import type { DataLayout } from "./paths.ts";
import { isLoopbackUrl, PROVIDER_CALL_PATHS, type ProviderCallPath } from "../ingest/provider.ts";
import type { JsonObject, JsonValue } from "../privacy/manifest.ts";

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

/**
 * params 承载「直送 Provider 的额外请求参数」。取值面收敛成 JSON，不给任意结构；
 * 递归定义钉在 JsonValue 上，避免 z.unknown 把配置类型退化成 unknown。
 */
const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);
const jsonObjectSchema: z.ZodType<JsonObject> = z.record(z.string(), jsonValueSchema);

/** 调用路径取值逐字取自 provider.ts 的封闭常量，不在此重抄第二份字面量。 */
const callPathValues = [
  PROVIDER_CALL_PATHS[0],
  ...PROVIDER_CALL_PATHS.slice(1),
] as [ProviderCallPath, ...ProviderCallPath[]];

/**
 * 本地 / 云端两档模型配置。顶层 `model` 继续保留给旧配置与单适配器装配；
 * 一旦出现任一 profile，就以 profile 为对应处理模式的权威配置。
 */
export const modelProfileConfigSchema = z
  .object({
    enabled: z.boolean(),
    provider: z.string().min(1),
    base_url: z.url(),
    api_key_env: z.string().regex(/^[A-Z][A-Z0-9_]{1,127}$/),
    request_timeout_ms: z.number().int().min(1000).max(120000),
    model: z.string().min(1).optional(),
    call_path: z.enum(callPathValues).optional(),
    supports_structured_output: z.boolean().optional(),
    params: jsonObjectSchema.optional(),
  })
  .strict();

export type ModelProfileConfig = z.infer<typeof modelProfileConfigSchema>;

/**
 * M4-TR-1 扩字段全 `.optional()`：旧配置（无 model/call_path/supports/params）照解析，
 * 兼容性由专测钉。「缺 model/call_path 却 enabled=true」不在这里拒——那是装配期的 fail-fast
 * （productionProvider），配置层只保证「能解析」，语义完备性在装配时判定。
 */
export const modelConfigSchema = z
  .object({
    enabled: z.boolean(),
    provider: z.string().min(1),
    base_url: z.url(),
    /** 只允许记录变量名：密钥值从不进入配置文件。 */
    api_key_env: z.string().regex(/^[A-Z][A-Z0-9_]{1,127}$/),
    cloud_redacted_enabled: z.boolean(),
    request_timeout_ms: z.number().int().min(1000).max(120000),
    model: z.string().min(1).optional(),
    call_path: z.enum(callPathValues).optional(),
    supports_structured_output: z.boolean().optional(),
    params: jsonObjectSchema.optional(),
    local_model: modelProfileConfigSchema.optional(),
    cloud_model: modelProfileConfigSchema.optional(),
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
      if (SECRETISH_KEYS.includes(key) && !next.join(".").endsWith("api_key_env")) {
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
  const model = parsed.data.model;
  if (model.local_model?.enabled === true && !isLoopbackUrl(model.local_model.base_url)) {
    throw new ConfigError(
      "本地模型只允许回环地址；否则私人记录会被发到本机之外。",
      { filePath, fields: ["model.local_model.base_url"] },
    );
  }
  if (model.cloud_model?.enabled === true && !model.cloud_redacted_enabled) {
    throw new ConfigError(
      "云端模型已启用，但 cloud_redacted_enabled 未开启：矛盾配置。",
      { filePath, fields: ["model.cloud_model.enabled", "model.cloud_redacted_enabled"] },
    );
  }
  const hasProfiles = model.local_model !== undefined || model.cloud_model !== undefined;
  if (!hasProfiles && model.enabled && !model.cloud_redacted_enabled && !isLoopbackUrl(model.base_url)) {
    throw new ConfigError(
      "非回环模型已启用，但 cloud_redacted_enabled 为 false：云端整理必须显式开启（ADR-003）。",
      { filePath, fields: ["model.enabled", "model.cloud_redacted_enabled", "model.base_url"] },
    );
  }
  return parsed.data;
}

/**
 * 设置页与装配层共用同一条「某档当前是什么」的判定，避免 UI 和运行时各写一套回退规则。
 * 旧配置没有 profile 时，按端点是否回环推导它究竟是本地还是云端。
 */
export function effectiveModelProfile(
  config: AppConfig,
  mode: "local_model" | "cloud_redacted",
): ModelProfileConfig {
  const explicit = mode === "local_model" ? config.model.local_model : config.model.cloud_model;
  if (explicit !== undefined) return explicit;
  const loopback = isLoopbackUrl(config.model.base_url);
  return {
    enabled:
      mode === "local_model"
        ? config.model.enabled && loopback
        : config.model.enabled && config.model.cloud_redacted_enabled,
    provider: config.model.provider,
    base_url: config.model.base_url,
    api_key_env: config.model.api_key_env,
    request_timeout_ms: config.model.request_timeout_ms,
    ...(config.model.model === undefined ? {} : { model: config.model.model }),
    ...(config.model.call_path === undefined ? {} : { call_path: config.model.call_path }),
    ...(config.model.supports_structured_output === undefined
      ? {}
      : { supports_structured_output: config.model.supports_structured_output }),
    ...(config.model.params === undefined ? {} : { params: config.model.params }),
  };
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

/** 设置页保存模型配置：先完整校验，再以同目录临时文件换入，避免半份 JSON 落盘。 */
export function writeConfigFile(filePath: string, config: AppConfig): void {
  const parsed = parseAppConfig(config, filePath);
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tempPath, `${JSON.stringify(parsed, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(tempPath, filePath);
  } finally {
    if (existsSync(tempPath)) unlinkSync(tempPath);
  }
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
  const cloud = effectiveModelProfile(config, "cloud_redacted");
  const keyName = cloud.api_key_env;
  const cloudKey = env[keyName];
  const apiKey = cloudKey === undefined || cloudKey.trim() === "" ? undefined : cloudKey;
  if (cloud.enabled && apiKey === undefined) {
    throw new ConfigError(
      `云端整理已开启，但环境变量 ${keyName} 未提供密钥。不会静默降级为本地模式。`,
      { filePath: resolved, fields: ["model.cloud_model.enabled", keyName] },
    );
  }
  return { config, filePath: resolved, apiKey };
}

/** 已持有运行锁之后的正式读取：允许生成配置文件。 */
export function loadConfig(layout: DataLayout, env: NodeJS.ProcessEnv = process.env): LoadedConfig {
  return loadConfigFromPath(ensureConfigFile(layout), env);
}
