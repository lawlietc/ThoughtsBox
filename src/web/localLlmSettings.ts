import type { LocalLlmUnusableReason } from "../shared/constants/model.ts";
import type {
  LocalLlmTestResultDto,
  LocalLlmTierDto,
  UpdateLocalLlmProfileDto,
} from "../shared/dto.ts";

/**
 * 设置页「本地模型辅助脱敏」那一栏的判据与文案（M9-4d-1）。
 *
 * 单独立一个不带 React 依赖的文件，与 `noLocalModelHint.ts` 同法：这一栏最容易写错的部分正是
 * 「按什么分支、说什么话」，把它放在 JSX 里就只能靠读源码来验，放在这里则能被直接调用断言。
 *
 * 分支纪律（裁决 M9-D-4）：判据**只有** `reason` 那枚封闭枚举。`message` 是服务端策展给人看的那一句，
 * 原样展示、不参与任何判断——前端一旦去解析它，改一个字就断，而且断在隐私相关的那一栏上。
 */

/** 这一栏要求的回环写法（提示语，不是判据：判据在服务端 `localLlmStatus`）。 */
export const LOCAL_LLM_LOOPBACK_HINT =
  "这一档只接受本机回环地址（http://127.0.0.1:… / http://localhost:…）。地址写错也能保存，但这一档不会被使用——这里不替你改输入。";

/**
 * 表单起点：`model.local_llm` 不在配置文件里时的空白值。
 *
 * 它**不是**「将要提交的配置」：这一栏没被编辑过时，保存请求里根本不带 `localLlm` 段
 * （M9-D-2 的省缺语义＝逐字保留，未配置就继续未配置）。编辑一次才物化成一个真段。
 */
export const LOCAL_LLM_BLANK_DRAFT: UpdateLocalLlmProfileDto = {
  enabled: false,
  provider: "ollama",
  model: "",
  baseUrl: "http://127.0.0.1:11434/v1",
  /**
   * M9-6a（裁决 M9-D-19）：真模型标定实测 241 / 206 / 1037 字分别要 53 / 65 / 145 秒，
   * 原先 30 秒的缺省会让**普通长度**的记录每一次都超时回落，而界面上只显示「这次本地模型没用上」。
   * 这是三档里唯一被改的缺省值；`local_model` / `cloud_model` 的缺省不在这份草稿里，也未改。
   */
  requestTimeoutMs: 90_000,
  supportsStructuredOutput: false,
};

export function localLlmDraftFromTier(tier: LocalLlmTierDto | null): UpdateLocalLlmProfileDto | null {
  if (tier === null) return null;
  return {
    enabled: tier.enabled,
    provider: tier.provider,
    model: tier.model ?? "",
    baseUrl: tier.baseUrl,
    requestTimeoutMs: tier.requestTimeoutMs,
    supportsStructuredOutput: tier.supportsStructuredOutput,
    ...(tier.callPath === null ? {} : { callPath: tier.callPath }),
  };
}

/** 省缺段 ⇒ 提交体里一个字节都不带（服务端据此保留既有那一档）。 */
export function localLlmSubmitBody(
  draft: UpdateLocalLlmProfileDto | null,
): UpdateLocalLlmProfileDto | undefined {
  if (draft === null) return undefined;
  return {
    ...draft,
    provider: draft.provider.trim(),
    model: draft.model.trim(),
    baseUrl: draft.baseUrl.trim(),
  };
}

/**
 * 配置层四个原因各配一句人话（`Record` 强制逐条覆盖：加一个取值而不写文案，编译期就红）。
 * 探测失败类别不在这里——那八种的句子由服务端 `message` 带来，这里再抄一份就是第二个真相。
 */
const UNUSABLE_HEADLINE: Record<LocalLlmUnusableReason, string> = {
  not_configured: "还没配置这一档：填好地址和模型 ID 再保存。",
  disabled: "这一档现在是关闭的，开了再测。",
  not_loopback: "已保存的地址不是本机回环地址，这一档不会被使用。",
  no_model: "缺模型 ID：填上这台本机服务里要用的模型名。",
};

/** 探测失败（连上了但没答上话 / 根本没连上）那一句的固定起头。 */
const PROBE_FAILURE_HEADLINE = "这台本机服务没有答上话。";

export function localLlmFailureHeadline(
  reason: LocalLlmTestResultDto["reason"] | undefined,
): string {
  switch (reason) {
    case "not_configured":
    case "disabled":
    case "not_loopback":
    case "no_model":
      return UNUSABLE_HEADLINE[reason satisfies LocalLlmUnusableReason];
    default:
      return PROBE_FAILURE_HEADLINE;
  }
}

/** 成功读数：可用 + 结构化那条路 + 耗时（`structuredOutput:null` 只伴随不可用，这里不解释它）。 */
export function localLlmSuccessText(result: LocalLlmTestResultDto): string {
  const path = result.structuredOutput === true ? "支持结构化输出" : "走纯提示词";
  return `连接可用 · ${path} · ${result.latencyMs} ms`;
}

/** 一栏里那行测试结果：先按 `reason` 选文案，再把 `message` 当细节拼在后面。 */
export function localLlmTestResultText(result: LocalLlmTestResultDto): string {
  if (result.usable) return localLlmSuccessText(result);
  const detail = result.message === undefined ? "" : ` ${result.message}`;
  return `${localLlmFailureHeadline(result.reason)}${detail}`;
}
