import { axesForProcessingMode } from "../shared/contracts/enums.ts";
import type { ProcessingModeValue } from "../shared/contracts/enums.ts";
import type { ProcessingModeAvailabilityDto, UpdateProcessingDefaultsDto } from "../shared/dto.ts";

/**
 * M5-6：入口页（快速记录 / 睡前收尾）整理方式初始化的**可跑逻辑**（与 React 无关）。
 *
 * 规则只有一条真相：配置里的默认值就是入口页的初始值；「记住上次」开启时入口页的
 * 切换立即写回**自己作用域**的那一个默认值（快速页只写 record，睡前页只写 sleep）。
 * 默认值后来变得不可用时：不改配置文件，本次回退 `manual_only` 并提示一次。
 */

export const FALLBACK_MODE = "manual_only";

/** 拿不到配置时（availability 为 null）不虚报禁用——那一刻我们并不知情。 */
export function isModeAvailable(
  mode: string,
  availability: ProcessingModeAvailabilityDto | null,
): boolean {
  if (mode === FALLBACK_MODE) return true;
  if (availability === null) return true;
  if (mode === "local_model") return availability.local_model;
  if (mode === "cloud_redacted") return availability.cloud_redacted;
  // 第 4 个模式值（草案 §六「前端可用性」）：服务端把 `cloud_raw` 与 `cloud_redacted`
  // 算在同一家云端端点上，但仍是两个独立键——漏一条就等于新增的档位永远不可选。
  if (mode === "cloud_raw") return availability.cloud_raw;
  return false;
}

/** 禁用项的原因文案；可用时返回 null。 */
export function modeUnavailableReason(mode: string): string | null {
  if (mode === "local_model") return "本机模型未启用或当前实例未装配，暂不可选";
  if (mode === "cloud_redacted") return "云端模型未启用或当前实例未装配，暂不可选";
  if (mode === "cloud_raw") return "云端原文发送未装配可用端点，暂不可选";
  return null;
}

export interface ResolvedEntryMode {
  readonly mode: string;
  /** true = 保存的默认这次用不了，已回退 manual_only（入口页据此提示一次）。 */
  readonly fellBack: boolean;
}

export function resolveEntryMode(
  savedDefault: string,
  availability: ProcessingModeAvailabilityDto | null,
): ResolvedEntryMode {
  if (isModeAvailable(savedDefault, availability)) {
    return { mode: savedDefault, fellBack: false };
  }
  return { mode: FALLBACK_MODE, fellBack: true };
}

/** 入口页记忆写回：每个页面只发自己作用域的字段，另一页的默认绝不被动。 */
export function processingPatchForScope(
  scope: "record" | "sleep",
  mode: string,
): UpdateProcessingDefaultsDto {
  return scope === "record" ? { recordDefaultMode: mode } : { sleepDefaultMode: mode };
}

/**
 * 这一次改档会不会**跨进**云端（〔web-redesign 第二步 · 批 6 · 事项 H〕）。
 *
 * 判据取三轴里的 `analysis_provider`，不另列一份「哪些模式算云端」的清单 ——
 * 契约加档时这里不用跟着改，也不会与 `enums.json` 漂移。
 * **只有「非云端 → 云端」这个方向要确认**：§4.8 里它把记录推进到「逐条确认发送」
 * （`records/service.ts:305-307`）；反向（离开云端）回到「未处理」，是可以退回来的。
 *
 * 放在这一层而不是详情页里：它是纯判据，能在 node 里逐对断言，
 * 不必为了测一条「哪几对要问一句」去开浏览器。
 */
export function crossesIntoCloud(from: string, to: string): boolean {
  const providerOf = (mode: string): string =>
    axesForProcessingMode(mode as ProcessingModeValue).analysisProvider;
  return providerOf(to) === "cloud" && providerOf(from) !== "cloud";
}
