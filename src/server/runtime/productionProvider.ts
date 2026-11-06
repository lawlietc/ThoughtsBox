/**
 * 生产 Provider 装配（M4-TR-1，缺口二）：把 config.model 组装成 `IngestProviderBundle`。
 *
 * 这是「配置面」与「调用面」之间此前完全缺失的一环：`ModelAdapter` 要 provider/model/baseUrl/
 * callPath/supportsStructuredOutput/timeout/apiKeyEnv/params 八项，而 `config.ts` 过去只给了
 * 六项里的四个真值（缺 model/call_path/supports/params），也没有任何 config→adapter 的装配代码。
 * 本文件补上这段装配，并把两处 fail-fast 写死在这里（「装配期」判定，非配置解析期）：
 *
 * 1. `enabled=true` 却缺 `model`/`call_path` ⇒ 抛 `ConfigError`——不默认兜底、不静默降级，
 *    与 `config.ts`「不拿默认值糊弄矛盾配置」同一条精神。
 * 2. `params` 含 `model`/`messages`/`stream`/`response_format` 任一键 ⇒ 抛 `ConfigError`。
 *    理由写死：`requestBody`（provider.ts:222-231）的 `...adapter.params` 展开发生在 messages
 *    之后、response_format 之前，不拦就等于配置面能篡改请求本体、覆盖掉 provider 组装的四键。
 *
 * **密钥红线**：`apiKeyEnv` 只传**变量名**，密钥值由 `invokeExtraction` 在发送那一刻从
 * `process.env` 取。本装配不读、不持有任何密钥值；`env` 形参保留给装配期可能需要的其它判定，
 * 当前不消费它（密钥也不在此消费）。
 */

import type { AppConfig, ModelProfileConfig } from "../config/config.ts";
import { defaultCredentialStore, type CredentialProfile, type CredentialStore } from "../config/credentials.ts";
import { ConfigError } from "../config/errors.ts";
import { DEFAULT_API_KEY_ENV } from "../../shared/constants/model.ts";
import { httpTransport } from "../ingest/httpTransport.ts";
import { M2_PROMPT_V2 } from "../ingest/prompts/m2-prompt-v2.ts";
import {
  isLoopbackUrl,
  type ModelAdapter,
  type ProcessingMode,
  type ProviderCallPath,
} from "../ingest/provider.ts";
import type { IngestProviderBundle } from "./workspace.ts";

/** requestBody 组装的请求本体四键：配置面无权通过 params 覆盖它们。 */
const FORBIDDEN_PARAM_KEYS = ["model", "messages", "stream", "response_format"] as const;

function buildAdapter(
  profile: ModelProfileConfig,
  fieldPrefix: string,
  /** 凭证档位（两家端点、两份密钥）。记录级三轴不影响它：`cloud_raw` 用的就是 `cloud_redacted` 这一档。 */
  credential: CredentialProfile,
  credentials: CredentialStore,
  env: NodeJS.ProcessEnv,
): ModelAdapter {
  const missing: string[] = [];
  if (profile.model === undefined || profile.model.trim() === "") missing.push(`${fieldPrefix}.model`);
  if (profile.call_path === undefined) missing.push(`${fieldPrefix}.call_path`);
  if (missing.length > 0) {
    throw new ConfigError(
      "模型已启用但缺少装配必需的 model / call_path：不默认兜底、不静默降级（fail-fast）。",
      { fields: missing },
    );
  }

  const params = profile.params;
  if (params !== undefined) {
    const offenders = FORBIDDEN_PARAM_KEYS.filter((key) => Object.prototype.hasOwnProperty.call(params, key));
    if (offenders.length > 0) {
      throw new ConfigError(
        "模型 params 不得覆盖请求本体四键（model/messages/stream/response_format 由 provider 组装，配置面无权改写）。",
        { fields: offenders.map((key) => `${fieldPrefix}.params.${key}`) },
      );
    }
  }

  return {
    provider: profile.provider,
    model: profile.model as string,
    baseUrl: profile.base_url,
    callPath: profile.call_path as ProviderCallPath,
    supportsStructuredOutput: profile.supports_structured_output ?? false,
    requestTimeoutMs: profile.request_timeout_ms,
    // 只保留变量名与取密钥闭包；密钥值永不进装配对象、不进配置、不进日志。
    apiKeyEnv: profile.api_key_env ?? DEFAULT_API_KEY_ENV,
    resolveApiKey: () =>
      credentials.resolve(credential, profile.api_key_env ?? DEFAULT_API_KEY_ENV, env).key,
    ...(params === undefined ? {} : { params }),
  };
}

export function buildProductionProvider(
  config: AppConfig,
  env: NodeJS.ProcessEnv,
  credentials: CredentialStore = defaultCredentialStore(env),
): IngestProviderBundle | null {
  const model = config.model;
  const hasProfiles = model.local_model !== undefined || model.cloud_model !== undefined;

  if (hasProfiles) {
    const adapters: Partial<Record<ProcessingMode, ModelAdapter>> = {};
    if (model.local_model?.enabled === true) {
      adapters.local_model = buildAdapter(
        model.local_model,
        "model.local_model",
        "local_model",
        credentials,
        env,
      );
    }
    if (model.cloud_model?.enabled === true) {
      const cloud = buildAdapter(
        model.cloud_model,
        "model.cloud_model",
        "cloud_redacted",
        credentials,
        env,
      );
      adapters.cloud_redacted = cloud;
      // `cloud_raw` 登记的是**同一个适配器对象**（草案 §六）：两家端点没有第三家，密钥也没有
      // 第三份，差别只在发出去的那份文本是原文还是脱敏文本——那是三轴与授权绑定的事，不是装配的事。
      adapters.cloud_raw = cloud;
    }
    const adapter = adapters.cloud_redacted ?? adapters.cloud_raw ?? adapters.local_model;
    if (adapter === undefined) return null;
    return { adapter, adapters, transport: httpTransport, systemPrompt: M2_PROMPT_V2 };
  }

  // 旧配置仍按单一适配器装配，避免升级瞬间改变既有行为。
  if (!model.enabled) return null;
  const legacy: ModelProfileConfig = {
    enabled: true,
    provider: model.provider,
    base_url: model.base_url,
    api_key_env: model.api_key_env ?? DEFAULT_API_KEY_ENV,
    request_timeout_ms: model.request_timeout_ms,
    ...(model.model === undefined ? {} : { model: model.model }),
    ...(model.call_path === undefined ? {} : { call_path: model.call_path }),
    ...(model.supports_structured_output === undefined
      ? {}
      : { supports_structured_output: model.supports_structured_output }),
    ...(model.params === undefined ? {} : { params: model.params }),
  };
  const adapter = buildAdapter(
    legacy,
    "model",
    isLoopbackUrl(legacy.base_url) ? "local_model" : "cloud_redacted",
    credentials,
    env,
  );

  return { adapter, transport: httpTransport, systemPrompt: M2_PROMPT_V2 };
}
