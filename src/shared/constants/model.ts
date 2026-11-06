/** 用户不需要配置环境变量名；这是保留给旧启动脚本与环境变量后备的固定默认值。 */
export const DEFAULT_API_KEY_ENV = "TB_MODEL_API_KEY";

/**
 * 「本地模型辅助脱敏这一档现在为什么不可用」的封闭取值（M9-1 定义，M9-D-4 钉死位置）。
 *
 * 住在 `shared` 而不是 `server/config`：`reason` 是前后端共用的**分支依据**（前端按它选文案，
 * 服务端按它装配错误），而 `src/shared/dto.ts` 不 import 服务端（分层方向 + web tsconfig 只吃
 * 纯类型）。取值域由这一份常量数组独占，`config.ts` 与 `dto.ts` 各自 re-export 它的元素类型——
 * 「界面说可用、请求被拒」最常见的成因就是两边各抄一份清单。
 */
export const LOCAL_LLM_UNUSABLE_REASONS = [
  "not_configured",
  "disabled",
  "not_loopback",
  "no_model",
] as const;
export type LocalLlmUnusableReason = (typeof LOCAL_LLM_UNUSABLE_REASONS)[number];

/**
 * 连接探测失败的类别（M9-D-4 的「探测失败类别」）：与 op8 两档模型连接测试**同一套码**，
 * 不另造第二份——同一个 401 在两个测试按钮上不该长成两个样子。
 * 它是封闭数组而不是手抄的字面量联合：`ModelConnectionTestFailureDto.code` 与
 * `LocalLlmTestResultDto.reason` 都从这一份派生元素类型。
 */
export const CONNECTION_TEST_FAILURE_CODES = [
  "invalid_config",
  "auth_failed",
  "model_not_found",
  "rate_limited",
  "provider_unavailable",
  "network",
  "timeout",
  "invalid_response",
] as const;
export type ConnectionTestFailureCode = (typeof CONNECTION_TEST_FAILURE_CODES)[number];

/**
 * 本地脱敏档连接测试响应里 `reason` 的完整取值域：配置层不可用的四个原因 + 探测失败类别。
 * 两条路径共用一个字段是 M9-1 的形状，M9-D-4 只是把**人话**从这个字段里搬进 `message`。
 */
export const LOCAL_LLM_TEST_REASONS = [
  ...LOCAL_LLM_UNUSABLE_REASONS,
  ...CONNECTION_TEST_FAILURE_CODES,
] as const;
export type LocalLlmTestReason = (typeof LOCAL_LLM_TEST_REASONS)[number];
