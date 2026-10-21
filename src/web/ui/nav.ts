/**
 * 导航结构：三个主 tab、各 tab 的子 tab、不进标签栏的页、以及「某页属于哪个 tab」。
 *
 * 这个文件**故意不放 JSX，也不 import 任何带 DOM 的东西**：
 * node 环境的测试能直接 import 这几张表做结构断言，不必为了测一张表去装一套 DOM。
 *
 * 三个 tab 的分工（〔用户裁定 2026-10-19 · M5-4〕顶层收成三段）：
 *   今天 —— 每天用的。今天 / 全部记录 / 待整理 / 待确认都在这条线上。
 *   盒子 —— 偶尔回看的。情绪 / 经历 / 念头 / 人物与事物 / 主题，加一个「搜索」。
 *   更多 —— 一年点不了几次的：设置、隐私、数据与备份。
 *
 * 「搜索」不再是顶层入口：找不到东西的人仍然能搜，但那一格的位置让给「今天」。
 * 搜索页本身没被移动 —— 它挂在盒子的子 tab 末尾。
 */

import type { TabKey, ViewKey } from "./types.ts";

export interface TabEntry {
  readonly key: TabKey;
  readonly label: string;
  /** 点这个 tab 去的那一页 —— tab 高亮由 `tabOf(view)` 算，与此无关。 */
  readonly home: ViewKey;
}

export const TABS: readonly TabEntry[] = [
  { key: "today", label: "今天", home: "today" },
  { key: "boxes", label: "盒子", home: "emotions" },
  { key: "more", label: "更多", home: "more" },
];

/** 「今天」tab 的子 tab（与 `BOX_TABS` 同构；计数由外壳按 `badges` 追加）。 */
export const TODAY_TABS: readonly { readonly key: ViewKey; readonly label: string }[] = [
  { key: "today", label: "今天" },
  { key: "records", label: "全部记录" },
  { key: "ingest", label: "待整理" },
  { key: "suggestions", label: "待确认" },
];

/**
 * 盒子那五个**有数据形状**的子页 —— `BOX_SHAPES` 与它一一对应，
 * 所以这一张表保持五个，搜索不进来（搜索没有盒子形状，见 `BOX_SUB_TABS`）。
 */
export const BOX_TABS: readonly { readonly key: ViewKey; readonly label: string }[] = [
  { key: "emotions", label: "情绪" },
  { key: "episodes", label: "经历" },
  { key: "thoughts", label: "念头" },
  { key: "entities", label: "人物与事物" },
  { key: "topics", label: "主题" },
];

/** 盒子 tab 实际画出来的子 tab：五个回看页 + 收编进来的搜索。 */
export const BOX_SUB_TABS: readonly { readonly key: ViewKey; readonly label: string }[] = [
  ...BOX_TABS,
  { key: "search", label: "搜索" },
];

/**
 * 不在任何标签栏里的页面：`quick`（快速记录）与 `sleep`（睡前收尾）是**动作**，
 * 入口在「今天」那一页上；`overview` 是沟通件自己的目录页，产品里没有它。
 * 进去之后得自带「回去」的动作。
 */
export const STANDALONE: readonly ViewKey[] = ["quick", "sleep", "overview"];

/** 某个页面属于哪个主 tab；不属于任何 tab 的返回 `null`。 */
export function tabOf(view: ViewKey): TabKey | null {
  switch (view) {
    case "today":
    case "quick":
    case "records":
    case "ingest":
    case "suggestions":
    case "sleep":
      return "today";
    case "emotions":
    case "episodes":
    case "thoughts":
    case "entities":
    case "topics":
    case "search":
      return "boxes";
    case "more":
    case "data":
      return "more";
    default:
      return null;
  }
}
