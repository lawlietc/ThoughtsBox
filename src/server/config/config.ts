import { copyFileSync, existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { z } from "zod";

import { DEFAULT_API_KEY_ENV, type LocalLlmUnusableReason } from "../../shared/constants/model.ts";
import {
  PROCESSING_MODE_VALUES,
  type ProcessingModeValue,
} from "../../shared/contracts/enums.ts";
import {
  defaultCredentialStore,
  type CredentialStore,
} from "./credentials.ts";
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

/**
 * 整理方式的封闭取值：从契约字面量 re-export，不在这里抄一份（草案 §六）。
 *
 * 这一行曾经是手抄的三值清单，后果是 `cloud_raw` 进不了 `processing.default_mode` 的 zod 校验：
 * 记录能存、界面能选，配置层却拒绝把它存成默认值。代码字面量与磁盘上的 `enums.json` 由
 * `validateEnums` 逐值同序对账，漂移即装载失败——所以「配置层不读契约文件」从来不等于
 * 「可以另抄一份取值」。
 */
export { PROCESSING_MODE_VALUES };
export type { ProcessingModeValue };
/**
 * M5-6：后三字段 `.optional()` —— 旧配置照解析；读取期由
 * `effectiveProcessingDefaults` 归一化（回退 `default_mode` / `false`），不要求用户手工迁移。
 */
export const processingConfigSchema = z
  .object({
    default_mode: z.enum(PROCESSING_MODE_VALUES),
    record_default_mode: z.enum(PROCESSING_MODE_VALUES).optional(),
    sleep_default_mode: z.enum(PROCESSING_MODE_VALUES).optional(),
    remember_last_mode: z.boolean().optional(),
  })
  .strict();

/**
 * 归一化后的四字段形状：`default_mode` 只是兼容镜像，真值永远是 `record_default_mode`。
 * 这样「默认」与「上次选择」不是上下两层配置，而是同一字段。
 */
export interface NormalizedProcessing {
  readonly default_mode: ProcessingModeValue;
  readonly record_default_mode: ProcessingModeValue;
  readonly sleep_default_mode: ProcessingModeValue;
  readonly remember_last_mode: boolean;
}

export function effectiveProcessingDefaults(
  processing: z.infer<typeof processingConfigSchema>,
): NormalizedProcessing {
  const legacy = processing.default_mode;
  return {
    default_mode: processing.record_default_mode ?? legacy,
    record_default_mode: processing.record_default_mode ?? legacy,
    sleep_default_mode: processing.sleep_default_mode ?? legacy,
    remember_last_mode: processing.remember_last_mode ?? false,
  };
}

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
 * 本地模型运行时的取值域：v1 只有 `external_http`——应用不内置运行时，本地模型一律是用户
 * 自备的回环服务（2026-10-24 M6-0H 裁决：0A 归档、0B 取消）。没有对应实现的取值
 * （`managed_llama_cpp` / `embedded`）不进取值域，写进来就在启动期被拒，不留「有值无实现」
 * 的死分支（与 `cloud_raw` 的教训同类）。
 * 它是**配置层的判别字段**，不是记录级三轴，所以不进 `enums.json`。
 */
export const LOCAL_MODEL_RUNTIMES = ["external_http"] as const;
export type LocalModelRuntime = (typeof LOCAL_MODEL_RUNTIMES)[number];

/**
 * 本地 / 云端两档模型配置。顶层 `model` 继续保留给旧配置与单适配器装配；
 * 一旦出现任一 profile，就以 profile 为对应处理模式的权威配置。
 */
export const modelProfileConfigSchema = z
  .object({
    enabled: z.boolean(),
    provider: z.string().min(1),
    base_url: z.url(),
    /** 旧字段兼容：可省略；解析后统一归一化为系统默认变量名。 */
    api_key_env: z.string().optional(),
    /**
     * M9-6a：上限 300000 对三档**共享**——`local_model` / `cloud_model` / `local_llm` 都走这一份
     * schema，抬高上限等于三档一起抬（比多开一个平行形状便宜）。本批只改**本地脱敏档的缺省值**
     * （`web/localLlmSettings.ts` 的空白草稿），另两档的缺省一字未动。下限 1000 不变。
     */
    request_timeout_ms: z.number().int().min(1000).max(300000),
    model: z.string().min(1).optional(),
    call_path: z.enum(callPathValues).optional(),
    supports_structured_output: z.boolean().optional(),
    params: jsonObjectSchema.optional(),
  })
  .strict();

export type ModelProfileConfig = z.infer<typeof modelProfileConfigSchema>;

/**
 * 本地档专属形状：`runtime` 只加在这里，不加进 `modelProfileConfigSchema` 本体——那个 schema
 * 与 `cloud_model` 共用，云端没有「本地运行时」这一维，加进去会造出 `cloud_model.runtime`
 * 这种无意义键。判别字段只在本地一档：`cloud_model.runtime` 因此被严格 schema 当未知字段拒绝。
 * `.optional()`：存量配置没有这个字段，缺省即 `external_http`，行为逐字不变。
 * `strict()` 由 `extend()` 保留：运行时参数（`context_size` / `model_path` 等）出现即被拒。
 */
export const localModelProfileConfigSchema = modelProfileConfigSchema.extend({
  runtime: z.enum(LOCAL_MODEL_RUNTIMES).optional(),
});

export type LocalModelProfileConfig = z.infer<typeof localModelProfileConfigSchema>;

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
    /** 旧字段兼容：可省略；解析后统一归一化为系统默认变量名。 */
    api_key_env: z.string().optional(),
    cloud_redacted_enabled: z.boolean(),
    /**
     * M9-6a-2：这一份是 primary profile 的**镜像字段**——设置页保存时 `nextModel` 把
     * `primary.request_timeout_ms` 原样写在这里（`ingestRoutes.ts`），而 `writeConfigFile`
     * 先过 `parseAppConfig`。上限必须与上面 `modelProfileConfigSchema` 那份一致（300000），
     * 否则界面允许的值（如 200000）会在写盘那一刻被这里拒掉，报出一条与超时无关的配置校验错误。
     * 下限 1000 同样对齐；缺省值本批一字未动。
     */
    request_timeout_ms: z.number().int().min(1000).max(300000),
    model: z.string().min(1).optional(),
    call_path: z.enum(callPathValues).optional(),
    supports_structured_output: z.boolean().optional(),
    params: jsonObjectSchema.optional(),
    local_model: localModelProfileConfigSchema.optional(),
    cloud_model: modelProfileConfigSchema.optional(),
    /**
     * M9-1：本地脱敏模型（`redaction_mode=local_llm` 那一档的能力来源），与内容分析模型
     * 并列而独立（规划 D1）——换分析模型不得悄悄换掉脱敏模型，所以是独立 profile。
     * **复用 `modelProfileConfigSchema` 同形，不加 `runtime`**：0H 暂停的是内置运行时，
     * 这一档从第一天起就只有「用户自备回环服务」一种形态，`runtime`/`context_size` 等
     * 未知键由 `.strict()` 拒绝（与 `cloud_model` 同一取向）。
     */
    local_llm: modelProfileConfigSchema.optional(),
  })
  .strict();

/** M9-1：本地脱敏档位就是同一个形状的第三份实例，不引入平行形状。 */
export type LocalLlmConfig = ModelProfileConfig;

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
      "配置文件中出现了疑似密钥字段。请在设置页直接输入密钥；密钥值不落配置、不进 Git。",
      { filePath, fields: offenders },
    );
  }
}

function zodFields(error: z.ZodError): string[] {
  return error.issues.map((issue) => `${issue.path.join(".") || "(根)"}: ${issue.message}`);
}

/** 入参是 `unknown`：任何一层不是对象（null / 数组 / 标量）都当「未设置」，交给 schema 去拒。 */
function readNested(raw: unknown, path: readonly string[]): unknown {
  let node: unknown = raw;
  for (const key of path) {
    if (typeof node !== "object" || node === null || Array.isArray(node)) return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return node;
}

/**
 * `runtime` 写错是「用户能自己改好」的配置错误，而 `z.enum` 的默认报错（Invalid option）
 * 只说取值不合法、不说该怎么办。所以取值域仍由 schema 把守，这里只负责把话说可读：
 * 与 `rejectInlineSecrets` 同一位置、同一种风格，先于 safeParse 抛 `ConfigError`。
 */
function rejectUnsupportedRuntime(raw: unknown, filePath: string): void {
  const runtime = readNested(raw, ["model", "local_model", "runtime"]);
  if (runtime === undefined) return;
  if (runtime === LOCAL_MODEL_RUNTIMES[0]) return;
  throw new ConfigError(
    `应用不内置本地模型运行时：只支持 ${LOCAL_MODEL_RUNTIMES[0]}（自备回环服务）。` +
      "把这一项删掉或改成它即可；托管运行时的参数（context_size / model_path 等）都不受支持。" +
      "详见 M6-0H 裁决「本地模型运行时路线暂停」。",
    { filePath, fields: ["model.local_model.runtime"] },
  );
}

export function parseAppConfig(raw: unknown, filePath: string): AppConfig {
  rejectInlineSecrets(raw, filePath);
  rejectUnsupportedRuntime(raw, filePath);
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
  // 环境变量名是内部兼容细节，不允许用户配置覆盖；旧文件中的值也统一收敛到默认名。
  // **`local_llm` 有意不在这条链上**（M9-D-3）：这一档本阶段不提供界面存 key，只从环境读，
  // 所以变量名是用户写的、要保留的东西——不一致是裁决，不是漏掉的一行。
  parsed.data.model.api_key_env = DEFAULT_API_KEY_ENV;
  if (parsed.data.model.local_model !== undefined) {
    parsed.data.model.local_model.api_key_env = DEFAULT_API_KEY_ENV;
  }
  if (parsed.data.model.cloud_model !== undefined) {
    parsed.data.model.cloud_model.api_key_env = DEFAULT_API_KEY_ENV;
  }
  // 读取期归一化：内存里四字段恒全，写盘（writeConfigFile）因此永远落兼容镜像。
  parsed.data.processing = effectiveProcessingDefaults(parsed.data.processing) as AppConfig["processing"];
  return parsed.data;
}

/**
 * 设置页与装配层共用同一条「某档当前是什么」的判定，避免 UI 和运行时各写一套回退规则。
 * 旧配置没有 profile 时，按端点是否回环推导它究竟是本地还是云端。
 *
 * `runtime` 恒有值，但它**只对 `local_model` 有意义**：`cloud_redacted` 那一档也填
 * `external_http`，只是为了保持单一返回形状，不另造第二套返回类型——云端没有本地运行时这一维，
 * 这个键因此不允许落进 `cloud_model`（严格 schema 会拒，见 `localModelProfileConfigSchema`）。
 * 回退链（显式 profile → 旧 `model.base_url` 推导 → 默认关闭）本身不变。
 */
export type EffectiveModelProfile = ModelProfileConfig & { readonly runtime: LocalModelRuntime };

export function effectiveModelProfile(
  config: AppConfig,
  mode: "local_model" | "cloud_redacted",
): EffectiveModelProfile {
  const explicit = mode === "local_model" ? config.model.local_model : config.model.cloud_model;
  if (explicit !== undefined) {
    // `runtime` 只声明在本地档那一侧，所以从 config 现取，不在共用的 profile 形状上假装它有这个字段。
    const runtime = mode === "local_model" ? config.model.local_model?.runtime : undefined;
    return {
      ...explicit,
      api_key_env: explicit.api_key_env ?? DEFAULT_API_KEY_ENV,
      runtime: runtime ?? LOCAL_MODEL_RUNTIMES[0],
    };
  }
  const loopback = isLoopbackUrl(config.model.base_url);
  return {
    enabled:
      mode === "local_model"
        ? config.model.enabled && loopback
        : config.model.enabled && config.model.cloud_redacted_enabled,
    provider: config.model.provider,
    base_url: config.model.base_url,
    api_key_env: config.model.api_key_env ?? DEFAULT_API_KEY_ENV,
    request_timeout_ms: config.model.request_timeout_ms,
    ...(config.model.model === undefined ? {} : { model: config.model.model }),
    ...(config.model.call_path === undefined ? {} : { call_path: config.model.call_path }),
    ...(config.model.supports_structured_output === undefined
      ? {}
      : { supports_structured_output: config.model.supports_structured_output }),
    ...(config.model.params === undefined ? {} : { params: config.model.params }),
    runtime: LOCAL_MODEL_RUNTIMES[0],
  };
}

/**
 * M9-1：本地脱敏模型「这一档现在到底能不能用」的判定。
 *
 * 纯函数、无 IO，UI 与服务端共用同一条口径（照 `effectiveModelProfile` 先例）——两边各写一套
 * 「可用」的定义，就会出现「界面说可用、请求被拒」或反过来（规划 P-1、M9 准则 §三）。
 * 判定顺序固定，第一个命中的原因胜出；`not_loopback` 复用 `isLoopbackUrl`，不复制第二份实现。
 * `reason` 的取值域住在 `src/shared/constants/model.ts`（M9-D-4：它是前后端共用的**分支依据**，
 * 而 `shared/dto.ts` 不 import 服务端），本文件只 re-export 那个名字。
 */
export type { LocalLlmUnusableReason };

export interface LocalLlmStatus {
  readonly configured: boolean;
  readonly loopback: boolean;
  readonly usable: boolean;
  readonly reason?: LocalLlmUnusableReason;
  readonly profile: ModelProfileConfig | null;
}

export function localLlmStatus(config: AppConfig): LocalLlmStatus {
  const profile = config.model.local_llm;
  if (profile === undefined) {
    return { configured: false, loopback: false, usable: false, reason: "not_configured", profile: null };
  }
  const loopback = isLoopbackUrl(profile.base_url);
  if (!profile.enabled) {
    return { configured: true, loopback, usable: false, reason: "disabled", profile };
  }
  if (!loopback) {
    return { configured: true, loopback: false, usable: false, reason: "not_loopback", profile };
  }
  const model = profile.model;
  if (model === undefined || model.trim() === "") {
    return { configured: true, loopback: true, usable: false, reason: "no_model", profile };
  }
  return { configured: true, loopback: true, usable: true, profile };
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
  credentials: CredentialStore = defaultCredentialStore(env),
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
  const keyName = cloud.api_key_env ?? DEFAULT_API_KEY_ENV;
  const apiKey = credentials.resolve("cloud_redacted", keyName, env).key;
  if (cloud.enabled && apiKey === undefined) {
    throw new ConfigError(
      "云端整理已开启，但没有可用密钥。请先在设置页输入密钥。不会静默降级为本地模式。",
      { filePath: resolved, fields: ["model.cloud_model.enabled", "credentials.cloud_redacted", keyName] },
    );
  }
  return { config, filePath: resolved, apiKey };
}

/** 已持有运行锁之后的正式读取：允许生成配置文件。 */
export function loadConfig(
  layout: DataLayout,
  env: NodeJS.ProcessEnv = process.env,
  credentials: CredentialStore = defaultCredentialStore(env),
): LoadedConfig {
  return loadConfigFromPath(ensureConfigFile(layout), env, credentials);
}
