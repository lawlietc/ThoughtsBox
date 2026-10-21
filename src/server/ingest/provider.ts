/**
 * 统一 Provider Adapter（D5）：三条调用路径 + 封闭错误分类 + 超时/取消。
 *
 * 契约取值：Spec §5.1/§5.2/§5.3/§9.4、指令 §6.1–§6.3/§7.5/§8.1、ADR-003、ADR-006。
 *
 * 「三路径」在这份契约里有**两个正交维度**，本文件把两者都钉住，不混为一谈：
 *
 * 1. `processing_mode`（enums.json 封闭三值 `manual_only` / `local_model` / `cloud_redacted`，
 *    Spec §5.2、§11-隐私）决定**这条记录要不要发出请求**：
 *    · `manual_only` 不调用任何模型（一次 transport 调用都不许发生）；
 *    · `local_model` 不向云端模型服务发送内容——端点必须是回环地址，否则在发送前就拒；
 *    · `cloud_redacted` 缺本次 `CloudSendGrant` 不得发出请求（复用 M2-3 的闸门，不另造一份）。
 * 2. 调用路径（指令 §6.2 的「至少覆盖」三项）决定**已经要发了，怎么发**：
 *    · `sdk_structured` 已验证支持结构化输出的服务端能力；
 *    · `http_json_lenient` 其他 HTTP/JSON 兼容端点，走容错提取；
 *    · `ollama_openai_compatible` Ollama 的 OpenAI-compatible 本地端点。
 *    走哪条由适配器配置**显式声明**，不靠每次请求失败试探（ADR-006 第一句）。
 *
 * 本模块**不做业务校验**（指令 §6.2 末段：Provider Adapter 不负责绕过业务校验）：
 * 它把回稿收敛成「一个 JSON 对象 + 走了哪条路径 + 是否降级」，Zod 与业务校验一律在
 * `contract.ts`，两条路径共用同一套（ADR-006）。
 */

import { REDACTION_POLICY_VERSION } from "../privacy/redaction.ts";
import { buildPipelineManifest, type JsonObject, type JsonValue, type PipelineManifest } from "../privacy/manifest.ts";
import { InvalidJsonError, extractJson } from "./extractJson.ts";

/**
 * 封闭错误分类：逐字取 `0003_derived_layer.sql` 的 `parse_run.error_kind` CHECK 清单
 * （七值，见该文件 §3.7）。清单与 SQL 的一致性由 `tests/m2-provider.test.ts` 对账，
 * 与 T-16「迁移字面量 == enums.json」同一手法——这里不硬编码第二份语义，只钉住同一份取值。
 */
export const PARSE_ERROR_KINDS = [
  "network",
  "timeout",
  "invalid_json",
  "business_validation",
  "provider_schema",
  "cancelled",
  "evidence_unmapped",
] as const;

export type ParseErrorKind = (typeof PARSE_ERROR_KINDS)[number];

/** 指令 §6.2 的三条调用路径（封闭集）。 */
export const PROVIDER_CALL_PATHS = [
  "sdk_structured",
  "http_json_lenient",
  "ollama_openai_compatible",
] as const;

export type ProviderCallPath = (typeof PROVIDER_CALL_PATHS)[number];

/** enums.json 的封闭处理模式；这里不重抄取值，运行时从单一事实源取。 */
export type ProcessingMode = "manual_only" | "local_model" | "cloud_redacted";

/**
 * 可重试性是指令 §11.1 要求 Trace 记录的事实，也是 §6.4 状态机的输入。
 * 取消不算瞬时故障：那是用户动作，重跑是一次新的意图，不是自动重试（`retryable: false`）。
 */
export const ERROR_RETRYABILITY: Readonly<Record<ParseErrorKind, boolean>> = {
  network: true,
  timeout: true,
  invalid_json: false,
  business_validation: false,
  provider_schema: false,
  cancelled: false,
  evidence_unmapped: false,
};

export class ProviderError extends Error {
  readonly kind: ParseErrorKind;
  readonly retryable: boolean;
  /** 只放内部 ID 与状态码之类的安全诊断信息；永不放原文、载荷、映射或密钥（指令 §11.2）。 */
  readonly diagnostics: Readonly<JsonObject>;

  constructor(
    kind: ParseErrorKind,
    message: string,
    diagnostics: JsonObject = {},
    retryable: boolean = ERROR_RETRYABILITY[kind],
  ) {
    super(message);
    this.name = "ProviderError";
    this.kind = kind;
    this.retryable = retryable;
    this.diagnostics = diagnostics;
  }
}

/**
 * 路径选择与安全闸门类失败：这些情况**一次请求都不该发出**，
 * 因此不属于 `error_kind` 的传输分类，而是「不该走到那一步」的拒绝。
 * （§11-隐私：`manual_only` 不调用任何模型；`local_model` 不向云端发送；缺授权不发出。）
 */
export type ProcessingModeFailure = "manual_only" | "local_model_egress" | "cloud_grant_missing";

export class ProcessingModeError extends Error {
  readonly reason: ProcessingModeFailure;
  readonly recordRevisionId: string;

  constructor(reason: ProcessingModeFailure, recordRevisionId: string, message: string) {
    super(message);
    this.name = "ProcessingModeError";
    this.reason = reason;
    this.recordRevisionId = recordRevisionId;
  }
}

/** 适配器配置：结构化输出能力是**声明**出来的，不是试探出来的（ADR-006）。 */
export interface ModelAdapter {
  readonly provider: string;
  readonly model: string;
  readonly baseUrl: string;
  readonly callPath: ProviderCallPath;
  readonly supportsStructuredOutput: boolean;
  readonly requestTimeoutMs: number;
  /** 只传变量名，密钥值由 `resolveApiKey` 在发送那一刻取，永不进日志/Trace/manifest。 */
  readonly apiKeyEnv?: string;
  readonly params?: JsonObject;
}

export interface TransportRequest {
  readonly url: string;
  readonly body: JsonObject;
  readonly headers: Readonly<Record<string, string>>;
  readonly signal: AbortSignal;
  readonly callPath: ProviderCallPath;
}

export interface TransportResponse {
  readonly status: number;
  readonly body: string;
}

export interface ProviderTransport {
  send(request: TransportRequest): Promise<TransportResponse>;
}

export interface ExtractionRequest {
  readonly recordRevisionId: string;
  readonly processingMode: ProcessingMode;
  /** 实际发送的那份文本（云端=已确认载荷，本地=原文）。脱敏映射永不下发（指令 §11.2）。 */
  readonly payloadText: string;
  readonly systemPrompt: string;
  readonly promptVersion: string;
  readonly outputSchemaVersion: string;
  readonly contractsFingerprint: string;
  readonly resolverVersion: string;
  readonly validationVersion: string;
  readonly redactionMap?: JsonValue;
  readonly signal?: AbortSignal;
}

export interface ExtractionOutcome {
  readonly json: JsonObject;
  readonly callPath: ProviderCallPath;
  /** 实际尝试过的路径，按顺序；降级路径要能记录所走路径（ADR-006 Consequences）。 */
  readonly attemptedPaths: readonly ProviderCallPath[];
  readonly degraded: boolean;
  readonly degradationReason?: string;
  readonly model: string;
  readonly provider: string;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** §6.2 端点 → chat/completions；`/v1` 结尾与不带结尾都归一到同一路径。 */
function completionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  return trimmed.endsWith("/chat/completions") ? trimmed : `${trimmed}/chat/completions`;
}

export function isLoopbackUrl(baseUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return false;
  }
  return LOOPBACK_HOSTS.has(url.hostname);
}

/**
 * 发送前的两道闸门（Spec §5.2、§11-隐私、指令 §7.5）。
 * 在 transport 之前调用，所以「不该发」在物理上就是零次调用。
 */
export function assertSendable(request: ExtractionRequest, adapter: ModelAdapter): void {
  if (request.processingMode === "manual_only") {
    throw new ProcessingModeError(
      "manual_only",
      request.recordRevisionId,
      "manual_only 不调用任何模型：该记录不进入解析路径（Spec §5.2）。",
    );
  }
  if (request.processingMode === "local_model" && !isLoopbackUrl(adapter.baseUrl)) {
    throw new ProcessingModeError(
      "local_model_egress",
      request.recordRevisionId,
      `local_model 端点不是回环地址，拒绝向云端发送私人记录：${adapter.baseUrl}`,
    );
  }
}

/**
 * `cloud_redacted` 的授权闸门：复用 M2-3 的 `requireApplicableGrant` 语义，
 * 本模块只接受一个「有授权才放行」的回调，不自己查库、不另造一份授权判定。
 */
export function assertCloudGranted(request: ExtractionRequest, grantCheck: () => void): void {
  if (request.processingMode !== "cloud_redacted") return;
  try {
    grantCheck();
  } catch (cause) {
    throw new ProcessingModeError(
      "cloud_grant_missing",
      request.recordRevisionId,
      `缺本次发送授权，请求不得发出：${(cause as Error).message}`,
    );
  }
}

function requestBody(adapter: ModelAdapter, request: ExtractionRequest, structured: boolean): JsonObject {
  const body: JsonObject = {
    model: adapter.model,
    messages: [
      { role: "system", content: request.systemPrompt },
      { role: "user", content: request.payloadText },
    ],
    stream: false,
    ...(adapter.params ?? {}),
  };
  if (structured) {
    // 声明式结构化输出：能力来自配置，不来自上一次失败（ADR-006）。
    body.response_format = { type: "json_schema", name: request.outputSchemaVersion };
  } else {
    body.response_format = { type: "json_object" };
  }
  return body;
}

/** OpenAI-compatible 信封 → 回稿文本；信封不合法 ⇒ `provider_schema`（与「内容不是 JSON」区分开）。 */
function completionText(response: TransportResponse, adapter: ModelAdapter): string {
  let envelope: unknown;
  try {
    envelope = JSON.parse(response.body);
  } catch {
    throw new ProviderError(
      "provider_schema",
      "Provider 响应体不是合法 JSON 信封",
      { status: response.status, provider: adapter.provider },
    );
  }
  const choices = (envelope as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new ProviderError(
      "provider_schema",
      "Provider 响应缺少 choices 数组",
      { status: response.status, provider: adapter.provider },
    );
  }
  const first = choices[0] as { message?: { content?: unknown }; text?: unknown };
  const content = first?.message?.content ?? first?.text;
  if (typeof content !== "string" || content.trim() === "") {
    throw new ProviderError(
      "provider_schema",
      "Provider 响应的回稿字段不是非空字符串",
      { status: response.status, provider: adapter.provider },
    );
  }
  return content;
}

/**
 * HTTP 状态 → 封闭分类。
 * 契约的封闭集里没有「鉴权/配置」这一类，所以所有非成功状态都归 `network`，
 * 原因（状态码）留在 diagnostics 里由 Trace 承载——**归并是为了不发明取值，不是掩盖原因**。
 * 429/5xx 按瞬时故障对待（可重试），其余 4xx 重发一次没有依据（不可重试）。
 */
function isTransientStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

interface SendWithGuards {
  (send: (signal: AbortSignal) => Promise<TransportResponse>): Promise<TransportResponse>;
}

/**
 * 超时与取消都在这里发生，且**不依赖真实网络**：`timeoutMs` 与 `signal` 都可注入。
 * 自己起 timer 而不是用 `AbortSignal.timeout()`，是为了让 timer `unref`——
 * 一次未完成的默认 30s 超时不该把测试进程按住 30s。
 */
function makeSendWithGuards(timeoutMs: number, callerSignal?: AbortSignal): SendWithGuards {
  return async (send) => {
    if (callerSignal?.aborted === true) {
      throw new ProviderError("cancelled", "调用方在发出请求前已取消", { timeout_ms: timeoutMs });
    }
    const controller = new AbortController();
    let timedOut = false;
    let cancelled = false;
    const onCallerAbort = (): void => {
      cancelled = true;
      controller.abort();
    };
    callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    timer.unref?.();
    try {
      return await send(controller.signal);
    } catch (cause) {
      if (cause instanceof ProviderError || cause instanceof InvalidJsonError) throw cause;
      if (timedOut) {
        throw new ProviderError("timeout", `模型调用超时（${timeoutMs}ms）`, { timeout_ms: timeoutMs });
      }
      if (cancelled || controller.signal.aborted) {
        throw new ProviderError("cancelled", "调用方取消了本次模型请求", {});
      }
      throw new ProviderError(
        "network",
        `模型调用未能完成：${(cause as Error).name}`,
        { error_name: (cause as Error).name },
      );
    } finally {
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", onCallerAbort);
    }
  };
}

export interface InvokeOptions {
  /** `cloud_redacted` 必须有本次授权；由调用方注入 M2-3 的闸门，本模块不查库。 */
  readonly requireGrant?: () => void;
}

/**
 * 一次结构化提取调用。返回的是**已解析的 JSON 对象**，不是校验过的结果——
 * Zod 与业务校验在 `contract.ts`，两条路径共用同一套（ADR-006）。
 *
 * 降级：声明支持结构化输出却拿不回可解析的对象时，改走容错提取再试一次，
 * 并把「所走路径与是否降级」记进 outcome（ADR-006 Consequences）。
 */
export async function invokeExtraction(
  adapter: ModelAdapter,
  request: ExtractionRequest,
  transport: ProviderTransport,
  options: InvokeOptions = {},
): Promise<ExtractionOutcome> {
  assertSendable(request, adapter);
  if (request.processingMode === "cloud_redacted") {
    if (options.requireGrant === undefined) {
      throw new ProcessingModeError(
        "cloud_grant_missing",
        request.recordRevisionId,
        "cloud_redacted 必须提供本次授权闸门，缺闸门即不发请求（指令 §7.3）。",
      );
    }
    assertCloudGranted(request, options.requireGrant);
  }

  const guardedSend = makeSendWithGuards(adapter.requestTimeoutMs, request.signal);
  const url = completionsUrl(adapter.baseUrl);
  const headers: Record<string, string> = { "content-type": "application/json" };
  const apiKey = adapter.apiKeyEnv === undefined ? undefined : process.env[adapter.apiKeyEnv];
  if (typeof apiKey === "string" && apiKey !== "") headers.authorization = `Bearer ${apiKey}`;

  const attempted: ProviderCallPath[] = [];
  const structured = adapter.supportsStructuredOutput && adapter.callPath === "sdk_structured";

  const sendOnce = async (path: ProviderCallPath): Promise<string> => {
    attempted.push(path);
    const response = await guardedSend(async (signal) => {
      const sent = await transport.send({
        url,
        body: requestBody(adapter, request, path === "sdk_structured"),
        headers,
        signal,
        callPath: path,
      });
      if (sent.status < 200 || sent.status >= 300) {
        throw new ProviderError(
          "network",
          `Provider 返回非成功状态：${sent.status}`,
          { status: sent.status, provider: adapter.provider },
          isTransientStatus(sent.status),
        );
      }
      return sent;
    });
    return completionText(response, adapter);
  };

  let text: string;
  let degraded = false;
  let degradationReason: string | undefined;
  try {
    text = await sendOnce(structured ? "sdk_structured" : adapter.callPath);
  } catch (cause) {
    if (!(cause instanceof ProviderError)) throw cause;
    // 声明为结构化输出的端点拿不回可用信封：能降级就降级，不能就如实上报（ADR-006）。
    if (!structured || !canRecoverLenient(cause)) throw cause;
    degradationReason = `结构化输出未生效（${cause.kind}），改走容错提取`;
    degraded = true;
    text = await sendOnce("http_json_lenient");
  }

  try {
    const json = extractJson(text);
    return {
      json,
      callPath: adapter.callPath,
      attemptedPaths: attempted,
      degraded,
      ...(degradationReason === undefined ? {} : { degradationReason }),
      model: adapter.model,
      provider: adapter.provider,
    };
  } catch (cause) {
    if (cause instanceof InvalidJsonError) {
      throw new ProviderError("invalid_json", cause.message, {
        attempted_paths: attempted.join(">"),
        degraded,
      });
    }
    throw cause;
  }
}

/** 降级只对「响应本身拿得到、但内容不成结构」有意义；传输类失败重发一次没有依据。 */
function canRecoverLenient(cause: ProviderError): boolean {
  return cause.kind === "provider_schema" && cause.retryable === false;
}

/**
 * 组装本次运行的 `pipeline_manifest`（九项封闭，直接复用 M2-3 的 `buildPipelineManifest`，
 * 不在这里另造第二份字段清单——T-33 的封闭性只有一个守门点）。
 *
 * 契约指纹落在 `validation` 之内：指令 §8.1 要求 manifest 含「枚举与词表契约指纹」，
 * 而九项是封闭的，所以它必须是某一项的**值**，不能是第十项（Spec §5.4 同义）。
 */
export function buildRunManifest(input: {
  readonly promptVersion: string;
  readonly outputSchemaVersion: string;
  readonly provider: string;
  readonly model: string;
  readonly params: JsonValue;
  readonly contractsFingerprint: string;
  readonly resolverVersion: string;
  readonly validationVersion: string;
  readonly redactionMap: JsonValue;
}): PipelineManifest {
  return buildPipelineManifest({
    prompt: { version: input.promptVersion },
    schema: { version: input.outputSchemaVersion },
    provider: input.provider,
    model: input.model,
    params: input.params,
    redaction: REDACTION_POLICY_VERSION,
    redactionMap: input.redactionMap,
    resolver: { version: input.resolverVersion },
    validation: { version: input.validationVersion, contracts_fingerprint: input.contractsFingerprint },
  });
}
