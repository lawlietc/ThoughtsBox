/**
 * 界面的视图类型 —— 只回答「这一页要画什么」，不回答「数据从哪来」。
 *
 * 产品侧与服务端 DTO 映射进来，开发模式的假数据也映射成同样的形状，两边对同一个口子。
 * 这一层因此**不得**读任何全局状态、不得自己取数（`tests/web-ui-shell.test.ts`
 * 把这条变成会红的纯度断言）：只要有一处组件直接读某个 store，它就只能跑在那一侧，
 * 「一份 UI 两个数据源」立刻不成立。
 *
 * ⚠️ `src/shared/dto.ts` 里**没有** `Evidence` / `Basis` / `MentionStatus` 这几个类型
 * （服务端那个 `ValidatedEvidence` 是内部件，对外结果只有 id 数组）。所以视图类型由界面自己定义，
 * 由数据源各自映射进来 —— 这是设计，不是缺口。
 *
 * 封闭枚举的单一事实源仍是 `src/shared/constants/enums.json`：标签表在装载时对照它核键集合，
 * 取值一漂移就抛，不在界面里留一份会过期的抄本。
 */

import type { ReactNode } from "react";

/* ── 外壳结构 ───────────────────────────────────────────────────── */

/**
 * 三个主 tab。〔用户裁定 2026-10-19 · M5-4〕收成：
 * 今天（每天用的）/ 盒子（偶尔回看的，搜索也在这里）/ 更多（一年点不了几次）。
 */
export type TabKey = "today" | "boxes" | "more";

/**
 * 主题名。浅色「晨雾」与深色「夜灯」共用同一套信息层级，只换光线与纸面
 * （tokens 见 `src/web/styles.css`）；用户没显式选过时跟随系统。
 */
export type ThemeName = "light" | "dark";

/**
 * 页面标识。归属哪个主 tab 由 `nav.ts` 的 `tabOf()` 算，不另存一份状态。
 *
 * - `quick` / `sleep` 是**动作**，不是可以逛的地方，不在任何标签栏里。
 * - `overview` 是沟通件自己的目录页，产品里没有这个入口。
 * - `graph` 整个功能按裁定推迟，先挂着不给入口。
 */
export type ViewKey =
  // 今天 tab（顶部子 tab）
  | "today"
  | "quick"
  | "records"
  | "ingest"
  | "suggestions"
  | "sleep"
  // 盒子 tab（顶部子 tab，搜索收在这里）
  | "emotions"
  | "episodes"
  | "thoughts"
  | "entities"
  | "topics"
  | "search"
  // 更多 tab
  | "more"
  | "data"
  // 不在任何 tab 里
  | "overview"
  | "graph";

/* ── 提及与证据 ─────────────────────────────────────────────────── */

/**
 * 提及的依据：`explicit` = 用户原话里说出口的，`inferred` = 模型推断的。
 * 硬约束矩阵规定 `inferred` 只能配「用户确认过的建议」—— 模型的推断没有资格直接成为提及。
 * 所以界面上这两者必须一眼可辨，这是产品对人的承诺。
 */
export type Basis = "explicit" | "inferred";

/** 提及状态。`rejected` = 你移除的：重跑不得静默复活它，但它在界面上仍然看得见。 */
export type MentionStatus = "active" | "superseded" | "rejected";

/** 概念的两大类（情绪 / 主题）。 */
export type ConceptKind = "emotion" | "topic";

/** 提及的来源容器 —— 恰好一种（数据库用 CHECK 强制）。三者在图谱上待遇完全不同。 */
export type MentionSourceKind = "record_revision" | "episode" | "thought_item";

export interface MentionSourceView {
  readonly kind: MentionSourceKind;
  readonly containerId: string;
}

/**
 * 证据锚点：文本 + 原文区间 + 是否回锚成功。
 *
 * `anchored === false` 是真实存在的路径（模型给的词面在原文里找不到）。按契约它不得成为有效提及，
 * 界面必须把这条失败路径显示出来 —— 假装抽取永远成功，等于假装「点证据能回原文」这件事可信。
 */
export interface EvidenceView {
  readonly text: string;
  readonly start: number;
  readonly end: number;
  readonly anchored: boolean;
}

/** 情绪 / 主题提及的一行视图数据。 */
export interface MentionView {
  readonly id: string;
  readonly kind: ConceptKind;
  /** 用户原文里出现的那个词，不是标准名 —— 证据回溯就是回到它。 */
  readonly labelSaid: string;
  readonly basis: Basis;
  readonly status: MentionStatus;
  /** 提及所属的记录：跳转要回的就是它。由数据源填，组件只经 `onJump` 用。 */
  readonly recordId: string;
  readonly source: MentionSourceView;
  readonly evidence: EvidenceView | null;
  /** 仅情绪有。`intensitySource === "user"` 表示这个强度是你改过的，不是模型给的。 */
  readonly intensity?: number;
  readonly intensitySource?: "user";
}

/** 实体提及的一行视图数据。`role` 是普通文本属性，V0 不约束枚举、不生成边。 */
export interface EntityMentionView {
  readonly id: string;
  readonly labelSaid: string;
  readonly basis: Basis;
  readonly status: MentionStatus;
  readonly recordId: string;
  readonly source: MentionSourceView;
  readonly evidence: EvidenceView | null;
  readonly role: string | null;
}

/* ── 展示组件的 props ──────────────────────────────────────────── */

export interface MentionChipProps {
  readonly label: string;
  readonly basis: Basis;
  readonly status: MentionStatus;
  /** 悬停说明：这个标签为什么在这里。 */
  readonly title: string;
  /** 点 chip 本身 —— 与「点证据回原文」是两件事，由调用方决定语义。 */
  readonly onClick?: () => void;
  /** 挂在 chip 上的类别小标签（「情绪」「人物」之类），不传就不挂。 */
  readonly kind?: string;
}

export interface EvidenceLineProps {
  readonly evidence: EvidenceView | null;
  /**
   * 「点证据要跳转」这件事的**唯一出口**。
   *
   * 组件不知道也不该知道跳到哪去、有没有详情抽屉、回不回得来 —— 那些是喂数据那一层的决定。
   * 原来这里是个直接读全局状态的 hook，那份组件因此只能跑在一侧；换成 prop 才是「一份 UI 两个数据源」。
   */
  readonly onJump: (evidence: EvidenceView) => void;
  readonly emptyText?: string;
}

export interface ProseProps {
  readonly text: string;
}

export interface KeyValueProps {
  readonly rows: readonly (readonly [string, ReactNode])[];
}

/**
 * 「说明 / 技术详情」折叠件（M5-3 信息分层的 B 层）。
 * 原生 `details/summary`：默认关闭、键盘与触屏可开合，不依赖 hover。
 */
export interface DisclosureNoteProps {
  readonly summary: string;
  readonly children: ReactNode;
}

/** 技术详情：只放排障用的技术值，主界面不直接显示这些。 */
export interface TechnicalDetailsProps {
  readonly rows: readonly (readonly [string, ReactNode])[];
}

/** 动作附近的单行状态（当前状态或阻塞原因），不用于长篇解释。 */
export interface StatusLineProps {
  readonly tone?: "info" | "warn";
  readonly children: ReactNode;
}

export interface ShellProps {
  /** 当前页。tab 高亮与子 tab 由它算出来，不另存。 */
  readonly view: ViewKey;
  /** 窄屏已进入列表详情：藏掉子 tab 与底部写作动作，让详情成为独立阅读页。 */
  readonly detailOpen?: boolean;
  readonly onNavigate: (view: ViewKey) => void;
  /** 子 tab 上的计数（待整理 / 待确认）。没有计数的页不传。 */
  readonly badges?: Partial<Record<ViewKey, number>>;
  /** 一次性提示文案（`**加粗**` 由 `Prose` 渲染）。 */
  readonly notice?: string | null;
  readonly title: string;
  readonly lede?: string;
  /** 标题栏右侧的入口。产品不传 —— 沟通件自己的目录页入口属于那一侧。 */
  readonly headerAside?: ReactNode;
  /** 整屏顶部的横幅（「这份模拟数据在骗你」那一类）。产品不传。 */
  readonly banner?: ReactNode;
  /** 页面主体：调用方按 `view` 渲染对应页面，外壳不知道有哪些页的实现。 */
  readonly children: ReactNode;
}

export interface ListDetailProps {
  /** 列表那一栏。 */
  readonly list: ReactNode;
  /** 详情那一栏。 */
  readonly detail: ReactNode;
  /** 窄屏要靠它决定现在该看哪一栏；宽屏两栏同屏，这个值不起作用。 */
  readonly hasSelection: boolean;
  /** 宽屏沉浸视图：还没选中条目时只铺列表，避免空的详情栏挤窄主视觉。 */
  readonly wideListOnly?: boolean;
  /** 盒子模式：宽窄屏都只显示列表，详情由弹窗接管。 */
  readonly listOnly?: boolean;
  readonly onBack: () => void;
}
