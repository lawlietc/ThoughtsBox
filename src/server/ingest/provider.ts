/**
 * 统一 Provider Adapter（D5）：三条调用路径 + 封闭错误分类 + 超时/取消。
 *
 * 契约取值：Spec §5.1/§5.2/§5.3/§9.4、指令 §6.1–§6.3/§7.5/§8.1、ADR-003、ADR-006。
 *
 * 「三路径」在这份契约里有**两个正交维度**，本文件把两者都钉住，不混为一谈：
 *
 * 1. 记录级**三轴**（M6-0C / 草案 §二、§五）决定**这条记录要不要发出请求**：
 *    · `analysis_provider = none` 不调用任何模型（一次 transport 调用都不许发生）；
 *    · `analysis_provider = local` 不向云端模型服务发送内容——端点必须是回环地址，否则在发送前就拒；
 *    · `send_content_mode ≠ none`（`redacted` 与 `raw` 皆然）缺本次 `CloudSendGrant` 不得发出请求
 *      （复用 M2-3 的闸门，不另造一份）。
 *    闸门**只读三轴**。`processing_mode` 仍然随请求带着，但它是草案 §五 的派生只读兼容字段，
 *    本模块没有任何一条分支看它做决定——那是 §一-4「判定点分散」的根因，也是本次要拆掉的东西。
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

import {
  assertThreeAxes,
  isEgress,
  type ProcessingModeValue,
  type RedactionMode,
  type ThreeAxes,
} from "../../shared/contracts/enums.ts";
import type { LocalLlmStatus, LocalLlmUnusableReason, ModelProfileConfig } from "../config/config.ts";
import type {
  ConnectionTestFailureCode,
  LocalLlmTestReason,
} from "../../shared/constants/model.ts";
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

/**
 * 派生只读兼容字段 `processing_mode` 的取值（草案 §五）。
 *
 * 这一行以前是这个模块自己抄的三值联合类型——`cloud_raw` 因此不可能被装配层选中，
 * 而真正的取值域在 `enums.json`。现在它是契约字面量的别名：契约加一个值，这里自动跟着变。
 */
export type ProcessingMode = ProcessingModeValue;

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
 * （§11-隐私：`analysis_provider=none` 不调用任何模型；本地分析不向云端发送；外发缺授权不发出。）
 *
 * 三个 reason 名沿用旧称（`manual_only` / `local_model_egress` / `cloud_grant_missing`）：
 * 它们已经进了既有测试与错误码面，改名的收益是零、代价是把 trace 的历史读法打断。
 * 语义在 M6-0C 起按三轴理解：`manual_only` = 没有任何分析者，`local_model_egress` = 本地分析者
 * 却配了非回环端点，`cloud_grant_missing` = 任何一次外发（`redacted` 与 `raw`）缺本次授权。
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

/**
 * `reason` → 一句人话。封闭枚举本身住在 `config.ts`（`LocalLlmUnusableReason`），这里只是文案，
 * 分支一律走枚举：前端按 `reason` 决定说什么，不解析 `message`（M9-D-4）。
 */
const LOCAL_LLM_UNAVAILABLE_TEXT: Record<LocalLlmUnusableReason, string> = {
  not_configured: "未配置",
  disabled: "已关闭",
  not_loopback: "端点不是回环地址",
  no_model: "未填模型名",
};

/**
 * 配置层不可用时给连接测试的那句 `message`（M9-D-4）：短句在前端按 `reason` 分支另有其处，
 * 这一句是「细节」，只解释现状与下一步，**不含**端点响应体、URL 凭据部分或任何记录内容。
 */
export function localLlmUnusableMessage(reason: LocalLlmUnusableReason): string {
  return `本地模型辅助脱敏这一档当前不可用（${LOCAL_LLM_UNAVAILABLE_TEXT[reason]}）。`;
}

/**
 * `redaction_mode=local_llm` 这一档**当前不可用**（M9-4b / 裁决 M9-D-10）。
 *
 * 这一档已实现，被拒的理由换成了配置状态：没配、关了、端点不是回环、没填模型名。
 * 类因此从 `RedactionModeUnimplementedError` 改名——沿用旧名会让人朝「代码还没写」的方向排查，
 * 而那已经不是事实。`reason` 是封闭枚举（M9-D-4：分支按枚举、展示按 `message`），
 * 由调用方从 `localLlmStatus()` 原样递进来，本类不再自己判一遍端点。
 * 消息只带人话文案、所选档位的封闭取值与内部 ID（指令 §11.2），**不带原文、不带词面**：选中这一档
 * 却被拒必须显式失败，静默降级成 `manual` 或 `none` 等于替用户改写脱敏承诺，而那种降级在界面上看不出来。
 */
export class RedactionModeUnavailableError extends Error {
  readonly reason: LocalLlmUnusableReason;
  readonly redactionMode: RedactionMode;
  readonly recordRevisionId: string;

  constructor(axes: ThreeAxes, recordRevisionId: string, reason: LocalLlmUnusableReason) {
    super(
      `本地模型辅助脱敏这一档（redaction_mode=${axes.redactionMode}）当前不可用（${LOCAL_LLM_UNAVAILABLE_TEXT[reason]}）：` +
        `${recordRevisionId}——本次请求被拒绝，不会静默改用其他脱敏方式（草案 §八之三、M9-D-10）。`,
    );
    this.name = "RedactionModeUnavailableError";
    this.reason = reason;
    this.redactionMode = axes.redactionMode;
    this.recordRevisionId = recordRevisionId;
  }
}

/**
 * 「本地模型辅助脱敏这一档现在能不能跑」的**唯一守门人**（草案 §八之三-2，M9-4b 换的判据）。
 *
 * 判据只有一条：选了 `local_llm` 而状态读数说它不可用。其余取值（`manual` / `none`）逐字放行，
 * 行为与翻门前相同。状态由调用方递进来——回环与否的唯一判定住在 `config.ts`，本模块不重抄，
 * 也不在这里读配置（`provider.ts` 拿不到 `AppConfig`，读配置会把它绑到装配层上）。
 *
 * 住在这里而不是 `egressPreview.ts`：错误类住在这一层，而 `egressPreview` 已经 import 本模块，
 * 反过来让发送前的门去叫 `egressPreview` 里的函数会构成模块环（`jobsRoutes.ts` 为同一条理由
 * 另立过一个同义错误类）。op2/op6/op7/入队四道门与本模块 `assertSendable` 因此叫的是同一个函数，
 * 「不复制第二份判断」这条纪律未变。
 */
export function assertRedactionPlanRunnable(
  axes: ThreeAxes,
  recordRevisionId: string,
  localLlm: LocalLlmStatus,
): void {
  if (axes.redactionMode !== "local_llm") return;
  if (localLlm.usable) return;
  throw new RedactionModeUnavailableError(axes, recordRevisionId, localLlm.reason ?? "not_configured");
}

/**
 * 拿不到配置时的缺省读数：fail-closed 按「未配置」处理。
 *
 * 只给既有的测试注入面与旧调用点当后备（`assertSendable` 的第三参、`invokeExtraction` 的
 * `InvokeOptions`）。生产调用链上路由与执行体都有 `facts.config`，一律显式递进来，不走这里。
 * 形状与 `config.ts` 的 `localLlmStatus()` 未配置分支逐字同值；在这里写字面量而不是 import 那个
 * 函数，是因为 `config.ts` 反过来 import 本模块的取值清单，运行期互 import 会成环。
 */
export const LOCAL_LLM_STATUS_UNSET: LocalLlmStatus = {
  configured: false,
  loopback: false,
  usable: false,
  reason: "not_configured",
  profile: null,
};

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
  /** 生产装配注入的运行时取密钥闭包；测试或临时输入可覆盖。 */
  readonly resolveApiKey?: () => string | undefined;
  readonly params?: JsonObject;
}

export interface TransportRequest {
  readonly url: string;
  readonly body: JsonObject;
  readonly headers: Readonly<Record<string, string>>;
  readonly signal: AbortSignal;
  readonly callPath: ProviderCallPath;
  /** 连通性探测显式禁止重定向；常规解析保持原有 fetch 默认行为。 */
  readonly redirect?: "follow" | "error" | "manual";
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
  /**
   * 记录级三轴——本模块**唯一的判定源**（草案 §二、§五）。装配层从库里的三列读出来，
   * 组合不合法（草案 §三 矩阵）在这里根本拿不到：闸门之前 `assertThreeAxes` 先过一遍。
   */
  readonly axes: ThreeAxes;
  /** 派生只读兼容字段（UI/导出/trace 兼容面继续读它）；任何判定都不许分支它。 */
  readonly processingMode: ProcessingMode;
  /** 实际发送的那份文本（`redacted`=用户确认过的脱敏载荷，`raw`=原文，本地=原文）。脱敏映射永不下发（指令 §11.2）。 */
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
 * 发送前的三道闸门（Spec §5.2、§11-隐私、指令 §7.5、草案 §五）。
 * 在 transport 之前调用，所以「不该发」在物理上就是零次调用。
 *
 * 判据全是三轴，没有一条分支看 `processing_mode`：草案 §一-4 把「判定点分散」列为本阶段要拆掉
 * 的根因，而 `cloud_raw` 恰好是那种「按旧字面量分支就会静默漏掉授权检查」的取值。
 *
 * `localLlm` 是 `redaction_mode=local_llm` 那一档的状态读数，由调用方从配置算好递下来
 * （M9-4b）：本模块不读配置文件，回环与否的判定只住在 `config.ts` 那一处。省略即按「未配置」
 * 处理——缺省只会让这一档被拒，不会让它被静默放行。
 */
export function assertSendable(
  request: ExtractionRequest,
  adapter: ModelAdapter,
  localLlm: LocalLlmStatus = LOCAL_LLM_STATUS_UNSET,
): void {
  const { axes } = request;
  assertThreeAxes(axes);
  assertRedactionPlanRunnable(axes, request.recordRevisionId, localLlm);
  if (axes.analysisProvider === "none") {
    throw new ProcessingModeError(
      "manual_only",
      request.recordRevisionId,
      `analysis_provider=none（派生 processing_mode=manual_only）—— manual_only 不调用任何模型：` +
        "该记录不进入解析路径（Spec §5.2、草案 §三 规则 3）。",
    );
  }
  if (axes.analysisProvider === "local" && !isLoopbackUrl(adapter.baseUrl)) {
    throw new ProcessingModeError(
      "local_model_egress",
      request.recordRevisionId,
      `本地分析的端点不是回环地址，拒绝向云端发送私人记录：${adapter.baseUrl}`,
    );
  }
}

/**
 * 外发的授权闸门（草案 §五 `egress_gate`）：`send_content_mode ≠ none` 一律要本次授权，
 * `redacted` 与 `raw` 走同一道门。复用 M2-3 的 `requireApplicableGrant` 语义，
 * 本模块只接受一个「有授权才放行」的回调，不自己查库、不另造一份授权判定。
 *
 * 函数名保留 `assertCloudGranted`：它是 M2-3 以来 trace 与测试认得的守门点名字，
 * 改名不会让判定更清楚，只会让历史读法断档。
 */
export function assertCloudGranted(request: ExtractionRequest, grantCheck: () => void): void {
  if (!isEgress(request.axes)) return;
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

function resolveAdapterApiKey(
  adapter: ModelAdapter,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const injected = adapter.resolveApiKey?.();
  if (typeof injected === "string" && injected.trim() !== "") return injected.trim();
  if (adapter.apiKeyEnv === undefined) return undefined;
  const fromEnv = env[adapter.apiKeyEnv];
  return typeof fromEnv === "string" && fromEnv.trim() !== "" ? fromEnv.trim() : undefined;
}

export interface InvokeOptions {
  /** 任何一次外发（`send_content_mode ≠ none`）都必须有本次授权；由调用方注入 M2-3 的闸门，本模块不查库。 */
  readonly requireGrant?: () => void;
  /** `redaction_mode=local_llm` 档的状态读数，与 `assertSendable` 的第三参同一条来源。 */
  readonly localLlm?: LocalLlmStatus;
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
  assertSendable(request, adapter, options.localLlm ?? LOCAL_LLM_STATUS_UNSET);
  if (isEgress(request.axes)) {
    if (options.requireGrant === undefined) {
      throw new ProcessingModeError(
        "cloud_grant_missing",
        request.recordRevisionId,
        `send_content_mode=${request.axes.sendContentMode} 的内容要离开本机，必须提供本次授权闸门，缺闸门即不发请求（指令 §7.3、草案 §五）。`,
      );
    }
    assertCloudGranted(request, options.requireGrant);
  }

  const guardedSend = makeSendWithGuards(adapter.requestTimeoutMs, request.signal);
  const url = completionsUrl(adapter.baseUrl);
  const headers: Record<string, string> = { "content-type": "application/json" };
  const apiKey = resolveAdapterApiKey(adapter);
  if (apiKey !== undefined) headers.authorization = `Bearer ${apiKey}`;

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

/**
 * M9-D-1 的**窄接口**：给 `privacy/localLlm.ts` 用的「发一次 chat/completions、把失败折成结果」。
 *
 * 存在的理由是裁决本身：请求装配（URL 归一、密钥解析、超时/取消守卫、信封抽取）在本文件里
 * 只有一份，脱敏侧不许再写半套。与 `invokeExtraction` 的差别只在**上层要什么**：
 * 解析层拿到的是**原始回稿文本**，不是已解析对象，也不再走降级重发——本地模型的脏输出由
 * `validateLocalLlmCandidates` 逐条丢弃，重发一次没有依据（准则 §一-4：失败不降级到更弱隐私）。
 *
 * **不抛**：任何失败都折成 `{ ok: false, failureKind }`。调用方是发送流程的一部分，
 * 一次本地模型故障不该把整条链路打断成异常。四类取值是封闭的：
 * `network`（连不上/被拒/非 abort 的传输错）、`timeout`（超时）、
 * `http`（拿到响应但状态码非 2xx）、`unstructured`（2xx 但信封不成模型回稿）。
 *
 * 注入点是 `fetchImpl`（测试用假 fetch），不是 `ProviderTransport`：这一档的端点由用户自备，
 * M9-2 的断言要在**不碰 socket** 的前提下钉住状态码与超时折叠。
 */
export interface ChatCompletionRequest {
  readonly messages: readonly { role: "system" | "user"; content: string }[];
  /** 声明式结构化输出：与 `invokeExtraction` 的 structured 路径同一个意思，能力来自配置而非试探（ADR-006）。 */
  readonly responseFormat?: "json_schema";
  /**
   * 结构化输出的 schema 名，落在 `response_format.name`（沿用现有 structured 路径的形状）。
   * 只在 `responseFormat` 出现时被读；由调用方给（脱敏侧传提示词版本），本模块不认识那个语义。
   */
  readonly responseSchemaName?: string;
  readonly temperature?: number;
}

export type ChatCompletionFailureKind = "network" | "timeout" | "http" | "unstructured";

export interface ChatCompletionOutcome {
  readonly ok: boolean;
  readonly content?: string;
  readonly failureKind?: ChatCompletionFailureKind;
  readonly latencyMs: number;
}

export interface ChatCompletionDeps {
  readonly fetchImpl?: typeof fetch;
}

/**
 * fetch → `{status, body}` 的一层薄映射，语义与 `httpTransport` 一致：
 * abort 类失败**原样抛出**，交给 `makeSendWithGuards` 分类成 `timeout`/`cancelled`
 * （提前包成 `ProviderError` 会把超时误判成 network）。不 import `httpTransport` 是因为
 * 那个模块依赖本文件，反向引用会成环；这里只允许「读响应」这四行重复。
 */
function transportFromFetch(fetchImpl: typeof fetch): ProviderTransport {
  return {
    async send(request: TransportRequest): Promise<TransportResponse> {
      const response = await fetchImpl(request.url, {
        method: "POST",
        headers: { ...request.headers },
        body: JSON.stringify(request.body),
        signal: request.signal,
        redirect: request.redirect ?? "follow",
      });
      return { status: response.status, body: await response.text() };
    },
  };
}

export async function sendChatCompletion(
  adapter: ModelAdapter,
  request: ChatCompletionRequest,
  deps: ChatCompletionDeps = {},
): Promise<ChatCompletionOutcome> {
  const startedAt = performance.now();
  const elapsed = (): number => Math.max(0, Math.round(performance.now() - startedAt));
  const failure = (failureKind: ChatCompletionFailureKind): ChatCompletionOutcome => ({
    ok: false,
    failureKind,
    latencyMs: elapsed(),
  });

  const body: JsonObject = {
    model: adapter.model,
    messages: request.messages.map((message) => ({ role: message.role, content: message.content })),
    stream: false,
    ...(adapter.params ?? {}),
  };
  if (request.temperature !== undefined) body.temperature = request.temperature;
  if (request.responseFormat === "json_schema") {
    body.response_format = {
      type: "json_schema",
      name: request.responseSchemaName ?? "chat_completion",
    };
  }

  const headers: Record<string, string> = { "content-type": "application/json" };
  const apiKey = resolveAdapterApiKey(adapter);
  if (apiKey !== undefined) headers.authorization = `Bearer ${apiKey}`;

  const transport = transportFromFetch(deps.fetchImpl ?? globalThis.fetch);
  const guardedSend = makeSendWithGuards(adapter.requestTimeoutMs);
  let response: TransportResponse;
  try {
    response = await guardedSend((signal) =>
      transport.send({
        url: completionsUrl(adapter.baseUrl),
        body,
        headers,
        signal,
        callPath: adapter.callPath,
        // 拒绝重定向：这一条路径携带的是**用户原文**，一次 3xx 就能把它送到回环之外（隐私红线 P-1）。
        redirect: "error",
      }),
    );
  } catch (cause) {
    if (cause instanceof ProviderError && cause.kind === "timeout") return failure("timeout");
    return failure("network");
  }
  if (response.status < 200 || response.status >= 300) return failure("http");

  try {
    return { ok: true, content: completionText(response, adapter), latencyMs: elapsed() };
  } catch {
    return failure("unstructured");
  }
}

/**
 * 探测失败类别的取值域住在 `shared/constants/model.ts`（M9-D-4）：连接测试的 `code` 与本地脱敏档
 * 的 `reason` 从同一份常量数组派生，所以同一个 401 不会在两个测试按钮上长成两个样子。
 */
export type { ConnectionTestFailureCode };

export interface ConnectionProbeSuccess {
  readonly ok: true;
  readonly latencyMs: number;
  readonly provider: string;
  readonly model: string;
  readonly callPath: ProviderCallPath;
  readonly checkedAtUtc: string;
}

export interface ConnectionProbeFailure {
  readonly ok: false;
  readonly latencyMs: number;
  readonly code: ConnectionTestFailureCode;
  readonly message: string;
  readonly httpStatus?: number;
}

export type ConnectionProbeResult = ConnectionProbeSuccess | ConnectionProbeFailure;

const PROBE_TIMEOUT_CAP_MS = 20_000;
const PROBE_MESSAGE = '请只回复 JSON：{"ok":true}';
const PROBE_SYSTEM_MESSAGE = "这是模型服务连通性检查，不涉及用户记录。";

function probeFailure(
  startedAt: number,
  code: ConnectionTestFailureCode,
  message: string,
  httpStatus?: number,
): ConnectionProbeFailure {
  return {
    ok: false,
    latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
    code,
    message,
    ...(httpStatus === undefined ? {} : { httpStatus }),
  };
}

function failureCodeForStatus(status: number): ConnectionTestFailureCode {
  if (status === 401 || status === 403) return "auth_failed";
  if (status === 404) return "model_not_found";
  if (status === 429) return "rate_limited";
  if (status === 400 || status === 422) return "invalid_config";
  if (status >= 500) return "provider_unavailable";
  return "provider_unavailable";
}

function failureMessageForStatus(code: ConnectionTestFailureCode, status: number): string {
  switch (code) {
    case "auth_failed":
      return "服务拒绝了密钥，请检查密钥是否正确。";
    case "model_not_found":
      return "服务或模型未找到，请检查接口地址和模型 ID。";
    case "rate_limited":
      return "服务暂时限流，请稍后再试。";
    case "invalid_config":
      return "服务认为请求配置不合法，请检查接口地址、模型和调用方式。";
    case "provider_unavailable":
      return `模型服务暂时不可用（HTTP ${status}）。`;
    default:
      return "连接测试失败。";
  }
}

function isConnectionResponse(body: string): boolean {
  let envelope: unknown;
  try {
    envelope = JSON.parse(body);
  } catch {
    return false;
  }
  const choices = (envelope as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return false;
  const first = choices[0] as { message?: { content?: unknown }; text?: unknown };
  const content = first?.message?.content ?? first?.text;
  return typeof content === "string" && content.trim() !== "";
}

/**
 * 一次固定最小请求的连通性探测。它不读取记录、不携带脱敏载荷、不写数据库，
 * 只复用生产发送的 URL 归一化、超时和密钥解析路径。
 *
 * 参数 `mode` 是**凭证档位**（本机回环 / 云端两家，与 `config/credentials.ts` 的 `CredentialProfile`
 * 同一份定义），不是记录级判定源，所以它只有两个值是有意的：
 * `cloud_raw` 与 `cloud_redacted` 共用同一份云端配置与密钥（差别在发什么内容，不在连的是谁），
 * 不该多出第三个 profile 或第二个密钥文件。
 */
export async function probeModelConnection(
  adapter: ModelAdapter,
  mode: "local_model" | "cloud_redacted",
  transport: ProviderTransport,
  options: { readonly signal?: AbortSignal } = {},
): Promise<ConnectionProbeResult> {
  const startedAt = performance.now();
  if (adapter.provider.trim() === "" || adapter.model.trim() === "") {
    return probeFailure(startedAt, "invalid_config", "服务名称和模型 ID 不能为空。");
  }

  let url: URL;
  try {
    url = new URL(adapter.baseUrl);
  } catch {
    return probeFailure(startedAt, "invalid_config", "接口地址不是合法 URL。");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return probeFailure(startedAt, "invalid_config", "接口地址只支持 http 或 https。");
  }
  if (mode === "local_model" && !isLoopbackUrl(adapter.baseUrl)) {
    return probeFailure(startedAt, "invalid_config", "本地模型只允许回环地址。");
  }

  const headers: Record<string, string> = { "content-type": "application/json" };
  const apiKey = resolveAdapterApiKey(adapter);
  if (apiKey !== undefined) headers.authorization = `Bearer ${apiKey}`;

  const timeoutMs = Math.min(adapter.requestTimeoutMs, PROBE_TIMEOUT_CAP_MS);
  const guardedSend = makeSendWithGuards(timeoutMs, options.signal);
  try {
    const response = await guardedSend((signal) =>
      transport.send({
        url: completionsUrl(adapter.baseUrl),
        body: {
          model: adapter.model,
          messages: [
            { role: "system", content: PROBE_SYSTEM_MESSAGE },
            { role: "user", content: PROBE_MESSAGE },
          ],
          stream: false,
          response_format: { type: "json_object" },
        },
        headers,
        signal,
        callPath: adapter.callPath,
        redirect: "error",
      }),
    );

    if (response.status < 200 || response.status >= 300) {
      const code = failureCodeForStatus(response.status);
      return probeFailure(startedAt, code, failureMessageForStatus(code, response.status), response.status);
    }
    if (!isConnectionResponse(response.body)) {
      return probeFailure(
        startedAt,
        "invalid_response",
        "服务有响应，但返回内容不是可识别的模型响应。",
        response.status,
      );
    }
    return {
      ok: true,
      latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
      provider: adapter.provider,
      model: adapter.model,
      callPath: adapter.callPath,
      checkedAtUtc: new Date().toISOString(),
    };
  } catch (cause) {
    if (cause instanceof ProviderError && cause.kind === "timeout") {
      return probeFailure(startedAt, "timeout", `连接测试超时（${timeoutMs}ms）。`);
    }
    if (cause instanceof ProviderError && cause.kind === "cancelled") {
      return probeFailure(startedAt, "network", "连接测试已取消。");
    }
    return probeFailure(startedAt, "network", "无法连接到模型服务，请检查地址或本机网络。");
  }
}

/**
 * `model.local_llm` profile → `ModelAdapter`（M9-D-1：请求装配只有一份）。
 *
 * M9-1 的连接探测与 M9-4c 的 op6 预览共用这一处：URL 归一、超时、状态码分类都留在本模块，
 * 路由只递配置读数。返回 `null` 即这一档根本没有 profile——调用方（`resolveLocalLlmPreview`）
 * 据此走「不咨询模型」的回落分支，不在路由里再判一次可用性。
 *
 * 凭证（M9-D-3）：另外两档的 `api_key_env` 会被配置层归一成 `TB_MODEL_API_KEY`，这一档**保留
 * 用户写的变量名**（本阶段界面不存 key，只从环境读）。这个不一致是有意的。
 */
export function adapterForLocalLlm(profile: ModelProfileConfig, env?: NodeJS.ProcessEnv): ModelAdapter;
export function adapterForLocalLlm(
  profile: ModelProfileConfig | null | undefined,
  env?: NodeJS.ProcessEnv,
): ModelAdapter | null;
export function adapterForLocalLlm(
  profile: ModelProfileConfig | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): ModelAdapter | null {
  if (profile === null || profile === undefined) return null;
  const keyValue = profile.api_key_env === undefined ? undefined : env[profile.api_key_env]?.trim();
  return {
    provider: profile.provider,
    model: profile.model ?? "",
    baseUrl: profile.base_url,
    // 探测与候选征询都只走 OpenAI 兼容的 `/chat/completions`：这一档没写 call_path 也照样能问。
    callPath: profile.call_path ?? "http_json_lenient",
    supportsStructuredOutput: profile.supports_structured_output ?? false,
    requestTimeoutMs: profile.request_timeout_ms,
    ...(keyValue === undefined || keyValue === "" ? {} : { resolveApiKey: () => keyValue }),
  };
}

/**
 * M9-1：本地脱敏模型（`model.local_llm`）的连接探测。
 *
 * 与 `probeModelConnection` 的差别只有一处语义：这一档要**探出结构化输出实际能不能用**（规划 D8），
 * 声明支持时先带 `response_format` 试一次，失败再不带试一次，两条都不成才算不可用。
 * 超时、URL 归一、固定占位消息、状态码分类全部复用本模块既有的那一份实现，不复制平行版本。
 *
 * 隐私红线（执行准则 §三）：请求体只有固定占位文本——永不携带用户原文、记录内容或实体词面。
 * 非回环在这里再挡一次（配置层 `localLlmStatus` 已判过一次）：本函数是公开入口，M9-3/M9-4 会
 * 直接调它，不能假设调用方先查过状态。
 *
 * M9-D-4：失败读数分两栏——`reason` 是封闭枚举（UI 唯一的分支依据），`message` 是给人看的句子。
 * 两者在同一个 `unusable()` 里成对产生，所以不存在「一个字段各缺一半」的那种形状。
 */
export interface LocalLlmProbeResult {
  readonly usable: boolean;
  /** 成功时＝实际走通的那条路（true=结构化被接受）；不可用时为 null。 */
  readonly structuredOutput: boolean | null;
  /** 封闭枚举（M9-D-4）：配置层四个原因 + 探测失败类别；UI 按它分支，不解析 `message`。 */
  readonly reason?: LocalLlmTestReason;
  /** 人话文案：只解释现状，绝不含端点响应体、URL 凭据部分或任何记录内容（红线 P-1）。 */
  readonly message?: string;
  readonly latencyMs: number;
}

/** 一次探测的失败读数：类别进 `reason`，句子进 `message`，两者同处产生、不会各缺一半。 */
interface AttemptFailure {
  readonly code: ConnectionTestFailureCode;
  readonly message: string;
}

export async function probeLocalLlm(
  adapter: ModelAdapter,
  transport: ProviderTransport,
  options: { readonly signal?: AbortSignal } = {},
): Promise<LocalLlmProbeResult> {
  const startedAt = performance.now();
  const elapsed = (): number => Math.max(0, Math.round(performance.now() - startedAt));
  const unusable = (
    reason: LocalLlmTestReason,
    message: string,
  ): LocalLlmProbeResult => ({
    usable: false,
    structuredOutput: null,
    reason,
    message,
    latencyMs: elapsed(),
  });

  // 这两道是公开入口的自检（配置层 `localLlmStatus` 已判过一次）：原因仍是配置层那四个枚举值，
  // 不换一套「探测专用」的说法，否则同一个事实有两个名字。
  if (!isLoopbackUrl(adapter.baseUrl)) {
    return unusable("not_loopback", localLlmUnusableMessage("not_loopback"));
  }
  if (adapter.model.trim() === "") {
    return unusable("no_model", localLlmUnusableMessage("no_model"));
  }

  const headers: Record<string, string> = { "content-type": "application/json" };
  const apiKey = resolveAdapterApiKey(adapter);
  if (apiKey !== undefined) headers.authorization = `Bearer ${apiKey}`;
  const timeoutMs = Math.min(adapter.requestTimeoutMs, PROBE_TIMEOUT_CAP_MS);
  const guardedSend = makeSendWithGuards(timeoutMs, options.signal);

  /** 返回 `null` 即这条路走通。 */
  const attempt = async (structured: boolean): Promise<AttemptFailure | null> => {
    const body: JsonObject = {
      model: adapter.model,
      messages: [
        { role: "system", content: PROBE_SYSTEM_MESSAGE },
        { role: "user", content: PROBE_MESSAGE },
      ],
      stream: false,
    };
    if (structured) body.response_format = { type: "json_object" };
    try {
      const response = await guardedSend((signal) =>
        transport.send({
          url: completionsUrl(adapter.baseUrl),
          body,
          headers,
          signal,
          callPath: structured ? "sdk_structured" : adapter.callPath,
          redirect: "error",
        }),
      );
      if (response.status < 200 || response.status >= 300) {
        const code = failureCodeForStatus(response.status);
        return { code, message: failureMessageForStatus(code, response.status) };
      }
      if (!isConnectionResponse(response.body)) {
        return { code: "invalid_response", message: "服务有响应，但返回内容不是可识别的模型响应。" };
      }
      return null;
    } catch (cause) {
      if (cause instanceof ProviderError && cause.kind === "timeout") {
        // 括号里的毫秒数来自**配置**，不是端点回的东西；它是「该改哪个字段」的线索。
        return { code: "timeout", message: `连接测试超时（${timeoutMs}ms）。` };
      }
      if (cause instanceof ProviderError && cause.kind === "cancelled") {
        return { code: "network", message: "连接测试已取消。" };
      }
      return { code: "network", message: "无法连接到模型服务，请检查地址或本机网络。" };
    }
  };

  if (adapter.supportsStructuredOutput) {
    const structured = await attempt(true);
    if (structured === null) return { usable: true, structuredOutput: true, latencyMs: elapsed() };
    const plain = await attempt(false);
    if (plain === null) return { usable: true, structuredOutput: false, latencyMs: elapsed() };
    // 两条路都不通 ⇒ 类别取**纯提示词那一次**（用户实际会依赖的那条路），文案把两次都列出来。
    return unusable(
      plain.code,
      `结构化与非结构化两次探测都失败：${structured.message}／${plain.message}`,
    );
  }
  const plain = await attempt(false);
  if (plain !== null) return unusable(plain.code, plain.message);
  return { usable: true, structuredOutput: false, latencyMs: elapsed() };
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
