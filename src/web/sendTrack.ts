import type { ThreeAxes } from "../shared/contracts/enums.ts";

/**
 * M6-1B：发送面板那两轨（脱敏 / 原文）的判据与作用范围声明（与 React 无关）。
 *
 * 与 `modeDefaults.ts`、`noLocalModelHint.ts` 同一层理由：根 tsconfig 的 lib 没有 DOM，
 * `.tsx` 进不了 node 测试那个闭包，只有纯 `.ts` 才能让判据与文案在测试里直接被断言。
 *
 * 三条契约（阶段 1 准则 §二 Q1 裁定）：
 * 1. **轨道读记录轴**（`send_content_mode`），不读设置里的默认值——档位挂在记录上，
 *    编辑产生新版本也不换轨（断言「编辑不重置」）。
 * 2. 一轨只对应一个档位值：`redacted ⇔ cloud_redacted`、`raw ⇔ cloud_raw`（enums.ts
 *    `AXES_BY_PROCESSING_MODE` 那两张表是唯一来源，这里不另抄一份轴取值）。
 * 3. 单条覆盖永不自动改全局：改全局只发生在「以后新建的记录也用…」被勾上那一次。
 */

export type SendTrack = "redacted" | "raw";

/** 面板上那两档的显示顺序与短标签（脱敏在前：它是默认世界，原文是用户主动选的那一侧）。 */
export const SEND_TRACKS: readonly SendTrack[] = ["redacted", "raw"];

export const SEND_TRACK_LABEL: Readonly<Record<SendTrack, string>> = Object.freeze({
  redacted: "脱敏",
  raw: "原文",
});

/**
 * 一轨对应的档位值。取值写成这张表而不是散在组件里的字面量分支：组件只调
 * `modeForTrack(track)`，档位与轨道的对应关系在这里一处说了算。
 */
export const SEND_TRACK_MODE: Readonly<Record<SendTrack, string>> = Object.freeze({
  redacted: "cloud_redacted",
  raw: "cloud_raw",
});

/**
 * 记录轴 → 轨道。
 *
 * `send_content_mode === "none"` 不是外发档，压根不该看到发送面板（`IngestPanel` 只在
 * `isEgress(axes)` 时渲染 CloudGate）。这里按**脱敏**处理并说明理由：那一刻没有任何文本
 * 要离开本机，而脱敏那句是风险描述更轻的一侧——把它判成原文等于对着一个根本不会发送的
 * 载荷宣布「原文会完整离开本机」，那是虚报。
 */
export function trackOfAxes(axes: ThreeAxes): SendTrack {
  return axes.sendContentMode === "raw" ? "raw" : "redacted";
}

/** 档位值 → 轨道；非外发档与不在册的值同 `trackOfAxes` 的处理（按脱敏）。 */
export function trackOfMode(mode: string): SendTrack {
  return mode === SEND_TRACK_MODE.raw ? "raw" : "redacted";
}

/** 轨道 → 档位值（写记录轴与写全局默认共用这一个映射）。 */
export function modeForTrack(track: SendTrack): string {
  return SEND_TRACK_MODE[track];
}

/**
 * 两轨各自说清「这一次发出去的是什么」（Q1 裁定第 5 条）。
 *
 * 两句必须不同，且各含自己的那一半事实：原文那句说不做任何脱敏、完整离开本机；
 * 脱敏那句说发出去的是遮过的版本、对照表只留在本机。字面量只住在这里，组件引常量。
 */
export const SEND_TRACK_RAW_COPY =
  "这一次发出去的是原文：不做任何脱敏，会完整离开本机。";

export const SEND_TRACK_REDACTED_COPY =
  "这一次发出去的是脱敏后的文本：占位符与原词的对照只留在本机。";

/** 切换处固定显示的作用范围声明（不是视觉调整，是 Q1 裁定第 2 条的功能）。 */
export const SCOPE_ONLY_THIS_RECORD = "仅这一条（这条记录以后都按它发送）";

/** 换轨之后那句提示：旧预览与旧授权都作废了，得重新来一遍。 */
export function trackSwitchedNotice(track: SendTrack): string {
  return `已切到${SEND_TRACK_LABEL[track]}，需要重新预览并逐次确认。`;
}

/* ── 遮蔽清单弹窗在原文轨上的声明（2026-11-04 删候选段后只剩这一条） ──
 *
 * 原文轨什么都不遮，讲「脱敏了哪些名字」就是谎报；这条常量只负责把这件事说清。
 */
export const RAW_TRACK_REVIEW_NOTE =
  "这一条不做脱敏：发出去的就是你写的原文，会完整离开本机。";
