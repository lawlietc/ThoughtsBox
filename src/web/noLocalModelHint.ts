import { axesForProcessingMode, isEgress, isProcessingModeValue } from "../shared/contracts/enums.ts";
import type { ProcessingModeAvailabilityDto } from "../shared/dto.ts";

/**
 * M6-1C：这台电脑没有可用本机模型时，第一条记录**保存完成之后**顺带说一句话。
 *
 * 与 `modeDefaults.ts` 同一层理由：不依赖 React、不碰 DOM，才能在 node 测试程序里
 * 直接断言判据与文案（根 tsconfig 的 lib 没有 DOM，`.tsx` 进不了那个闭包）。
 *
 * 四条边界：
 * 1. 只做「提示」，不做向导 / 模态 / 强制步骤——用户此时的主任务一直是记录本身。
 * 2. 拿不到配置（`availability === null`）时不提示：那一刻我们并不知情，静默比谎报好
 *    （与 `modeDefaults.ts` 里「不知道可用性就不虚报禁用」同一条取向）。
 * 3. 只在「本机模型确实不可用」时提示；「知道了」写进 localStorage，写不进去也只影响下次打开。
 * 4. 入口只在云端此刻真的可用时才画，落点按保存当刻的档位分流（1C-R2）——没路可指就不指。
 */

/** localStorage 键：命名照 `tb-theme` / `tb-box-view:` 那条既有前缀风格。 */
export const NO_LOCAL_MODEL_HINT_KEY = "tb-no-local-model-hint";

/** 这一格里唯一的在册取值：有值且等于它才算「用户关过」，别的一律当没关过。 */
const DISMISSED_MARK = "dismissed";

/**
 * 提示正文（导出成常量，测试直接断言文本）。
 *
 * 这一句必须同时做到两件事，缺一就是误导：说清「手动标记」不需要任何模型，
 * 也说清「发送原文」不做任何脱敏、会完整离开本机——不恐吓，也不淡化。
 */
export const NO_LOCAL_MODEL_HINT_TEXT =
  "这台电脑现在没有可用的本机模型，接下来有两条路：手动标记敏感词（不调用任何模型，走既有的候选与实体通道），或逐条选择发送原文——原文不做任何脱敏，会完整离开本机。";

/**
 * 提示条上的动作文案，按「保存当刻的档位」分两句（〔主 Agent 裁决 2026-10-27〕1C-R 要给这句
 * 引导带一个能按的下一步；同日的 1C-R2 修正它的落点）。
 *
 * 上一轮只有一句「去选择发送方式」，实测会误导：manual_only / local_model 的记录根本不进
 * 「待整理」（那一页自己的文案就写着「只保存的记录不会进入待整理」），入口于是落进列表第一条
 * 别人的记录。非外发档真正该去的是「全部记录」详情——那里有「整理方式」四档，
 * 切成云端档之后这条才进待整理。
 *
 * 与正文同一条纪律：动作文案只活在这里，`QuickPanel.tsx` 引常量、不另抄字面量。
 * 两句说的都是「去选择 / 去设置」而不是「去发送」——这一条到底发不发、发哪种，
 * 仍由发送面板逐次决定。
 */
export const NO_LOCAL_MODEL_HINT_ACTION_EGRESS = "去选择发送方式";

/** 保存档位是非外发档：入口落到「全部记录」里这一条的详情，那里能改整理方式。 */
export const NO_LOCAL_MODEL_HINT_ACTION_LOCAL = "去设置整理方式";

/**
 * 云端两档都没配置时补的一句（1C-R2）。
 *
 * 正文说的两条路此刻都走不通，只讲「有两条路」是空头承诺；但也不收回正文——那两条路仍然是
 * 这台机器接下来的选项，只是要先配好云端通道。
 */
export const NO_LOCAL_MODEL_HINT_CLOUD_MISSING = "云端通道还没配置，配置后这两条路才走通。";

/** 入口的落点：`pending` = 「待整理」页并选中这条；`record` = 「全部记录」里这条的详情。 */
export type HintEntry =
  | { readonly kind: "pending"; readonly label: string }
  | { readonly kind: "record"; readonly label: string };

/**
 * 只需要这两个方法：`window.localStorage` 结构上满足，测试则能传一份会抛的假件
 * （隐私模式下真 localStorage 就是这么直接抛的，见 `ui/ThemeToggle.tsx`、`BoxPanel.tsx`）。
 */
export interface HintStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** 判据读既有的 `processingAvailability.local_model`，这里不另造一套可用性判定。 */
export function shouldShowNoLocalModelHint(availability: ProcessingModeAvailabilityDto | null): boolean {
  if (availability === null) return false;
  return availability.local_model === false;
}

/**
 * 云端这条路此刻走不走得通：两档外发模式里至少一档可用。
 *
 * `availability === null`（配置没读到）返回 false，与 `shouldShowNoLocalModelHint` 同一条
 * 取向——那一刻我们并不知情，不开口比猜一个说法好。
 */
export function cloudSendAvailable(availability: ProcessingModeAvailabilityDto | null): boolean {
  if (availability === null) return false;
  return availability.cloud_redacted === true || availability.cloud_raw === true;
}

/**
 * 提示条的入口该落到哪、该说什么（1C-R2 的核心判据，抽成纯函数才能在 node 里逐档断言）。
 *
 * 输入是**保存当刻**的档位，不是页面此刻可能被改过的选择器状态：入口指的是刚存下的那一条，
 * 用户存完之后又切换默认整理方式，不该改走那一条的去向。
 *
 * 「是否外发档」判三轴（`isEgress(axesForProcessingMode(...))`），不另抄一份字面量分支——
 * 与 `IngestPanel.tsx` 那道发送闸门同一判据（草案 §五：`processing_mode` 只是派生兼容字段）。
 * 不在册的 mode 字符串按「非外发」处理：那是保守的一侧，落到能改整理方式的地方，四档仍然看得见；
 * 认不出就当外发会把人带进待整理页，而那条记录本不该出现在那里——等于替他做多一次决定。
 */
export function hintEntryFor(
  savedMode: string,
  availability: ProcessingModeAvailabilityDto | null,
): HintEntry | null {
  if (!cloudSendAvailable(availability)) return null;
  const egress = isProcessingModeValue(savedMode) && isEgress(axesForProcessingMode(savedMode));
  return egress
    ? { kind: "pending", label: NO_LOCAL_MODEL_HINT_ACTION_EGRESS }
    : { kind: "record", label: NO_LOCAL_MODEL_HINT_ACTION_LOCAL };
}

/** 读失败当作「没关过」：宁可多说一句，也不静默替用户做决定。 */
export function readHintDismissed(storage: HintStorage): boolean {
  try {
    return storage.getItem(NO_LOCAL_MODEL_HINT_KEY) === DISMISSED_MARK;
  } catch {
    return false;
  }
}

/** 写失败静默不抛：提示不该因为存不下就把刚保存成功的那一次弄成一次失败。 */
export function markHintDismissed(storage: HintStorage): void {
  try {
    storage.setItem(NO_LOCAL_MODEL_HINT_KEY, DISMISSED_MARK);
  } catch {
    // 存不进去只意味着下次打开还会说一遍，这一屏的关闭仍然生效。
  }
}
