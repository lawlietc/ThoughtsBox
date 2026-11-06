import { type RedactionMode } from "../shared/contracts/enums.ts";
import {
  LLM_FAILURE_KIND_DTO_VALUES,
  REDACTION_SOURCE_DTO_VALUES,
  type LocalLlmTierDto,
  type RedactionSourceDto,
} from "../shared/dto.ts";
import { localLlmFailureHeadline } from "./localLlmSettings.ts";
import type { SendTrack } from "./sendTrack.ts";

/**
 * M9-4d-2：发送区「谁来做脱敏」这一档的判据与文案（与 React 无关）。
 *
 * 与 `sendTrack.ts` / `noLocalModelHint.ts` / `localLlmSettings.ts` 同一层理由：根 tsconfig 的 lib
 * 没有 DOM，`.tsx` 进不了 node 测试那个闭包，只有纯 `.ts` 才能让判据与文案被直接调用断言。
 * 而这一格里错的代价最高：判据写歪一次，用户就会在「以为模型帮忙遮过」的错觉下把文本发出去。
 *
 * 三条判据纪律：
 * 1. **这一档不是第五个 `processing_mode`**。`(cloud, manual, redacted)` 与
 *    `(cloud, local_llm, redacted)` 派生后同为 `cloud_redacted`（裁决 M9-D-15），所以界面上
 *    这两选写的是 `redaction_mode`，切档走 `PATCH /api/records/:id/redaction-mode`。
 * 2. **可用性判据只有一个来源**：`config.localLlm.usable`（服务端 `localLlmStatus` 的产物）。
 *    页面里不许出现「是不是回环」的第二套判断——那是隐私判据，判错一侧就是外发事故。
 * 3. **绝不静默回落**：切到本地模型档但这一层没跑成时，档位选择保持不变，只在预览区如实说一句
 *    「这次本地模型没用上（原因）」。把选择悄悄改回 `manual` 等于替用户改写隐私承诺。
 */

/**
 * 界面可选的脱敏档：`redaction_mode` 封闭集里「有人做脱敏」的那两个取值。
 * `none` 不在这里——它由 `send_content_mode=raw` 那一轨决定，而 `raw` 下任何脱敏档切换都是非法组合。
 */
export type RedactionTier = Extract<RedactionMode, "manual" | "local_llm">;

/** 两选的顺序：当前默认（规则 + 实体记忆）在前，本地模型那一侧在后。 */
export const REDACTION_TIERS: readonly RedactionTier[] = ["manual", "local_llm"];

export const REDACTION_TIER_LABEL: Readonly<Record<RedactionTier, string>> = Object.freeze({
  manual: "规则 + 实体记忆",
  local_llm: "本地模型辅助脱敏",
});

/** 在册值 → 档位；`none` 与不在册的值给 null（原文轨压根不画这一行，见 `showRedactionTierRow`）。 */
export function redactionTierOfMode(mode: string): RedactionTier | null {
  return (REDACTION_TIERS as readonly string[]).includes(mode) ? (mode as RedactionTier) : null;
}

/**
 * 这一档此刻可选吗。
 *
 * 判据只有传进来的那一个布尔——它来自 `config.localLlm.usable`，前端不再看地址、不再看开关、
 * 不再看模型名（M9-D-4 的取向：分支依据是服务端算好的那一格，不是页面自己凑的条件）。
 */
export function redactionTierEnabled(tier: RedactionTier, usable: boolean): boolean {
  return tier === "manual" ? true : usable;
}

/**
 * 档位行在原文轨不出现。
 *
 * 不是「藏起来更好看」：`send_content_mode=raw` 记录在册的脱敏档恒为 `none`（草案 §三 规则 1），
 * 切到 `manual` 或 `local_llm` 都是非法组合、服务端必然 400。画一个怎么选都被拒的选项，
 * 等于把契约错误摊成用户的一次点击。
 */
export function showRedactionTierRow(track: SendTrack): boolean {
  return track === "redacted";
}

/**
 * 第二项不可用时的那句原因。
 *
 * 文案的唯一来源是 `localLlmFailureHeadline`（按封闭枚举分支，见 M9-D-4），这里只补一条
 * 「这一档还没配置」的映射：配置文件里没有 `model.local_llm` 时 DTO 整个是 null，
 * 服务端无从给出 `reason`，而 `not_configured` 正是它的对应事实。
 * 可用时返回空串——那一刻没有原因可说，页面也就不画那一句。
 */
export function redactionTierUnavailableText(tier: LocalLlmTierDto | null): string {
  if (tier !== null && tier.usable) return "";
  return localLlmFailureHeadline(tier?.reason ?? "not_configured");
}

/** 逐处「这一处是谁遮的」的人话标签（R7：`local_llm` 那一条要一眼认得出来）。 */
const SOURCE_LABEL: Readonly<Record<RedactionSourceDto, string>> = Object.freeze({
  rule: "规则脱敏（号码 / 邮箱这类固定格式）",
  entity_memory: "本机词表脱敏",
  local_llm: "本地模型脱敏",
  user_confirmed: "你手动标记脱敏的",
});

/**
 * 来源 → 标签。不在清单里的值**原样透出**：宁可显示一枚没人认识的英文码，
 * 也不编一句人话替它解释——后者会把「契约加了一个来源而这里没跟上」盖成一次正常显示。
 */
export function redactionSourceLabel(source: string): string {
  const known = (REDACTION_SOURCE_DTO_VALUES as readonly string[]).includes(source);
  return known ? SOURCE_LABEL[source as RedactionSourceDto] : source;
}

/**
 * 「这次本地模型没用上（原因）」里的原因。
 *
 * 按 `failureKind` 那枚封闭枚举取值（清单在 `shared/dto.ts`，与服务端逐值对账），
 * 不解析服务端自由文本。取值缺席（老预览 / 非本档）就只说「没用上」，不猜原因。
 */
const FAILURE_TEXT: Readonly<Record<(typeof LLM_FAILURE_KIND_DTO_VALUES)[number], string>> = Object.freeze({
  not_loopback: "配置的地址不是本机回环",
  timeout: "等了太久没回——可能是这段太长，也可能是本机服务卡住了",
  network: "没连上那台本机服务",
  http: "那台本机服务回了错误",
  invalid_json: "回稿不是合法 JSON",
  unstructured: "这条路没按结构化输出回",
});

/**
 * 脱敏核对弹窗里那颗「重跑脱敏」按钮的文案（按钮文案的唯一来源，M9-8b）。
 * 这一颗是真的要再问一次本地模型、重算脱敏载荷；写在弹窗里，配同一句「本地模型没用上」的说明。
 */
export const LLM_PREVIEW_RETRY_LABEL = "重跑脱敏";

/**
 * 只在 `timeout` 那一格追的「下一步做什么」。
 *
 * 其余五格的原因一句话就说完，这一格说不完：「这段太长」与「服务卡住了」在用户那边是两件不同的
 * 排查动作，而界面上能给的只有同一个动作（再问一次）。不点名两种可能，用户就分不清该缩文本还是该查服务。
 *
 * 值是函数不是字面量：那句话点名的按钮就是同一屏那颗重问按钮，名字必须跟着 `LLM_PREVIEW_RETRY_LABEL`
 * 走。手写第二遍必然漂移——界面指着一句早已改口的按钮文案，等于给用户一条不存在的出路。
 */
const FAILURE_ACTION: Readonly<
  Partial<Record<(typeof LLM_FAILURE_KIND_DTO_VALUES)[number], () => string>>
> = Object.freeze({
  timeout: () => `可以点「${LLM_PREVIEW_RETRY_LABEL}」再试一次。`,
});

export const LLM_UNUSED_HEADLINE = "这次本地模型没用上";

export function llmUnusedNoticeText(failureKind: string | undefined): string {
  if (failureKind === undefined || failureKind === "") return LLM_UNUSED_HEADLINE;
  const key = (LLM_FAILURE_KIND_DTO_VALUES as readonly string[]).includes(failureKind)
    ? (failureKind as (typeof LLM_FAILURE_KIND_DTO_VALUES)[number])
    : undefined;
  if (key === undefined) return `${LLM_UNUSED_HEADLINE}（原因未登记）`;
  const action = FAILURE_ACTION[key]?.() ?? "";
  if (action === "") return `${LLM_UNUSED_HEADLINE}（${FAILURE_TEXT[key]}）`;
  return `${LLM_UNUSED_HEADLINE}（${FAILURE_TEXT[key]}）。${action}`;
}

/**
 * 单条预览等待那句的后半段：「这一步要多久」与「走开之后结果还在不在」。
 * 只在 `llmCheckingText`（单条预览）用；队列顶上那句只报条数，不再复述这段（2026-11-06）。
 */
const LLM_CHECKING_ADVICE =
  "这一步通常要一两分钟；你可以先去做别的——检查完的结果会留在本机，回来点「查看实际待发送文本」就能看到。";

/**
 * 等本机模型检查时那句「要等多久 + 走开之后结果还在不在」。
 *
 * 这一格讲的是服务端本来就有的事实，界面只是把它说出来：那条调用没有 caller signal，关掉页面它
 * 照样跑完并把结果落进 `app_meta`，所以回来再点一次预览若已跑成就是秒出。不这么说的话，实测
 * 9 s 到 264 s 的等待只配三个字「处理中…」，用户唯一的理性选择就是刷新页面重来一遍。
 */
export function llmCheckingText(seconds: number): string {
  const waited = Math.max(0, Math.floor(seconds));
  const elapsed = waited <= 0 ? "刚开始等" : `已等 ${waited} 秒`;
  return `本机正在检查这段文字，${elapsed}。${LLM_CHECKING_ADVICE}`;
}

/**
 * 队列顶上那句「本机正在检查 N 条」（M10-4，执行准则 §七）。
 *
 * 条数取自预跑队列的在册状态，不是从「还没算出载荷」反推的（M10-D-9）。
 * `pending <= 0` 时不该被调用——调用方只在有得说的时候才说。
 *
 * 2026-11-06：只报条数，不再复述「要一两分钟 / 走开也在」那段长文案（用户反馈列表顶部太长、
 * 与操作框重复）；那段说明只在单条预览的 `llmCheckingText` 里保留。
 */
export function prewarmPendingText(pending: number): string {
  return `本机正在检查 ${pending} 条。`;
}

/** 已经过了多少整秒（向下取整、不为负；时钟回拨按 0 秒算）。 */
export function elapsedSecondsSince(since: number, now: number): number {
  return Math.max(0, Math.floor((now - since) / 1000));
}

/** 切档之后那句：旧预览与旧授权都作废了，得重新预览并再点一次确认。 */
export function tierSwitchedNotice(tier: RedactionTier): string {
  return `已切到「${REDACTION_TIER_LABEL[tier]}」，需要重新预览并逐次确认。`;
}
