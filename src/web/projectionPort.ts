/**
 * UI-4 那批页面的**数据口**：这一页该长什么形状、还缺哪些字段、缺的时候说哪句话。
 *
 * 为什么单独一层（而不是写在各面板的 JSX 里）：
 * - 任务书 §5.5 的判据是「产品模式下不得渲染任何假数据，数据口返回明确的『投影还没就绪』」。
 *   那句话要有出处，而且要能被 node 断言 —— 于是形状与缺口都收成这里的纯数据。
 * - 同一份形状将来在 dev 模式接上顶层那份假数据（UI-5 已做，见下面的 `DataPort`），
 *   在产品这一侧接上真实投影（`productPort.ts`）。
 *   形状若散在组件里，两个数据源就会各自漂移。
 *
 * 三条纪律：
 * 1. **表头里的枚举词一律来自 `ui/labels.ts` 的标签表**（其键集合在装载时对照 `enums.json`）。
 *    手抄一份「待转正」就等于埋一颗雷：契约改取值，界面不会红，只会显示过期世界。
 * 2. **缺口点名到字段**，字段名逐字取自任务书 §六（那是真实投影的施工清单）。
 * 3. 计数位留着、值填 `—`。空着看起来像漏画，编一个数字看起来像真的 —— 两者都比「还不知道」更糟。
 */

import {
  ENUM_VALUES,
  ENTITY_LIFECYCLE_LABEL,
  EVENT_TIME_PRECISION_LABEL,
  MODE_LABEL,
  SUGGESTION_LABEL,
  SUGGESTION_STATUS_LABEL,
} from "./ui/labels.ts";
import type { ViewKey } from "./ui/types.ts";

/** 数据口说「还没就绪」的那句话（与 UI-3 的诚实空态同一措辞）。 */
export const PROJECTION_UNREADY = "这一页的数据投影还没就绪。";

/** 「待确认」页那两格空态：一句说取不到，一句说真的没有等你表态的行。 */
export const SUGGESTIONS_UNREADY = "建议数据还没准备好，暂时无法显示。";
export const NO_SUGGESTION_ROWS = "还没有待确认的建议。";

/** 计数位的占位符：有位置、没数字。 */
export const COUNT_PLACEHOLDER = "—";

/** 一个页面的投影缺口。 */
export interface ProjectionGap {
  /** 这一页要长出内容还缺的字段（逐字取自任务书 §六）。 */
  readonly missing: readonly string[];
  /** 形状已经就位、暂时填不进数的位置（计数位与分组）。 */
  readonly slots: readonly string[];
}

/** §六 里三条线共用的一部分缺口，写一次，各页引用。 */
const MENTION_MISSING = [
  "labelSaid（原话里出现的那个词面）",
  "basis（原话说出口 / 模型推断）",
  "status（有效 / 已被取代 / 你已移除）",
  "来源容器（record_revision / episode / thought_item + 容器 id）",
  "evidence（文本 + 区间 + 是否回锚成功）",
];

/** 标签表按取值取中文名（`noUncheckedIndexedAccess` 下取值是 `string | undefined`，漏了键就退回原文）。 */
function enumLabel(table: Readonly<Record<string, string>>, key: string): string {
  return table[key] ?? key;
}

export type BoxView = "emotions" | "episodes" | "thoughts" | "entities" | "topics";

export interface BoxGroup {
  readonly heading: string;
  readonly note: string;
}

/** 盒子某一页的**形状**：表头、分组、计数位。内容一律等投影。 */
export interface BoxShape {
  readonly view: BoxView;
  readonly title: string;
  readonly lede: string;
  readonly counts: readonly string[];
  readonly groups: readonly BoxGroup[];
  /** 详情那一栏的表头。 */
  readonly detailHeading: string;
  /** 列表那栏的空态措辞 —— 每页说自己的那一类东西。 */
  readonly emptyHint: string;
  readonly gap: ProjectionGap;
}

export const BOX_SHAPES: readonly BoxShape[] = [
  {
    view: "emotions",
    title: "情绪盒子",
    lede: "出现过的情绪，按频次排。",
    counts: ["出现过的情绪", "词表里但从未出现", "有效提及", "不上图"],
    groups: [
      { heading: "出现过的情绪", note: "按提及频次排；显示的是词表里的标准名，不是你当时写下的那个词。" },
      {
        heading: "词表里但从未出现",
        note: "词表里有、但你一次都没提到过。",
      },
    ],
    detailHeading: "出现的地方",
    emptyHint: "这里还没有可读的情绪提及。",
    gap: {
      missing: [...MENTION_MISSING, "intensity 与它是不是用户改过的", "conceptType / canonicalName / 生命周期"],
      slots: ["出现过的情绪", "词表里但从未出现", "原话说出口 / 推断 / 挂经历 / 不上图 四个计数位"],
    },
  },
  {
    view: "episodes",
    title: "经历盒子",
    lede: "按发生的事回看。",
    counts: ["经历总数", "够「日」精度", enumLabel(EVENT_TIME_PRECISION_LABEL, "unknown")],
    groups: [
      { heading: "能排进时间轴的", note: "时间精确到「日」的经历，才真的排得进这条线。" },
      {
        heading: `${enumLabel(EVENT_TIME_PRECISION_LABEL, "unknown")}的`,
        note: "给不出日期的经历，排不进按时间回看的那条线。",
      },
    ],
    detailHeading: "这条经历",
    emptyHint: "这里还没有可读的经历。",
    gap: {
      missing: ["summary", "生命周期（active / superseded）", "originType", "evidence", "event_time_raw / precision / certainty"],
      slots: ["经历总数", "够「日」精度", "时间不明"],
    },
  },
  {
    view: "thoughts",
    title: "念头盒子",
    lede: "经历是发生的事，念头是你说给自己听的话。",
    counts: ["念头总数", "挂着标签的", "没挂标签的"],
    groups: [
      { heading: "挂着标签的", note: "挂着情绪与主题标签的念头。" },
      { heading: "没挂标签的", note: "没挂标签的念头同样在这里。" },
    ],
    detailHeading: "这个念头",
    emptyHint: "这里还没有可读的念头。",
    gap: {
      missing: ["text", "生命周期（active / superseded）", "originType", "evidence", ...MENTION_MISSING],
      slots: ["念头总数", "挂着标签的", "没挂标签的"],
    },
  },
  {
    view: "entities",
    title: "人物与事物",
    lede: "提到过的人与事物，按身份状态分开看。",
    counts: [
      enumLabel(ENTITY_LIFECYCLE_LABEL, "active"),
      enumLabel(ENTITY_LIFECYCLE_LABEL, "provisional"),
      enumLabel(ENTITY_LIFECYCLE_LABEL, "archived"),
      "提到的次数",
    ],
    groups: [
      {
        heading: enumLabel(ENTITY_LIFECYCLE_LABEL, "active"),
        note: "你确认过的实体：正常显示、正常上图。",
      },
      {
        heading: enumLabel(ENTITY_LIFECYCLE_LABEL, "provisional"),
        note: "模型认出来了但还没转正：不进默认列表。转正的是这条本身，不会另建一个。",
      },
      {
        heading: enumLabel(ENTITY_LIFECYCLE_LABEL, "archived"),
        note: "归档的仍然看得见，只是不再出现在默认列表里。",
      },
      {
        heading: `「${enumLabel(SUGGESTION_LABEL, "possibly_same_as")}」候选`,
        note: "疑似是同一个：合并在「待确认」页表态，且可撤销。",
      },
    ],
    detailHeading: "出现的地方",
    emptyHint: "这里还没有可读的实体。",
    gap: {
      missing: ["canonicalName / displayName / entityType / 生命周期", "role", ...MENTION_MISSING],
      slots: [
        enumLabel(ENTITY_LIFECYCLE_LABEL, "active"),
        enumLabel(ENTITY_LIFECYCLE_LABEL, "provisional"),
        enumLabel(ENTITY_LIFECYCLE_LABEL, "archived"),
        "提到的次数",
      ],
    },
  },
  {
    view: "topics",
    title: "主题浏览",
    lede: "情绪是「当时什么感觉」，这里是「在想什么事」。",
    counts: ["出现过的主题", "有效提及", enumLabel(SUGGESTION_LABEL, "new_concept")],
    groups: [
      { heading: "出现过的主题", note: "按提及频次排；找感觉和找事情不是同一个动作。" },
      {
        heading: `还没被你收下的${enumLabel(SUGGESTION_LABEL, "new_concept")}`,
        note: "词表里还没有的主题，先在「待确认」里被采纳，才会进这一页。",
      },
    ],
    detailHeading: "出现的地方",
    emptyHint: "这里还没有可读的主题提及。",
    gap: {
      missing: ["canonicalName / conceptType / 生命周期（merged / archived）", ...MENTION_MISSING],
      slots: ["出现过的主题", "有效提及", "新主题候选"],
    },
  },
];

export function boxShapeOf(view: ViewKey): BoxShape | null {
  return BOX_SHAPES.find((shape) => shape.view === view) ?? null;
}

/**
 * 取某一页第 `index` 个分组的**表头原文**。
 *
 * 数据源拼分组时一律走这里，不许自己重拼一遍表头：面板是按形状表的表头去找分组的
 * （`BoxPanel` 的 `rowsOf(heading)`），两边各拼一遍就会有对不上的那天 ——
 * 而错的那天界面不红，只画一个空组，看起来像「这一组确实没东西」。
 */
export function boxGroupHeading(view: BoxView, index: number): string {
  return BOX_SHAPES.find((shape) => shape.view === view)?.groups[index]?.heading ?? "";
}

/** 待确认页的筛选器骨架：键与标签来自建议状态标签表，「全部」是界面自己的聚合项。 */
export interface SuggestionFilter {
  readonly key: string;
  readonly label: string;
}

export const SUGGESTION_ALL_KEY = "all";

export function suggestionFilters(): readonly SuggestionFilter[] {
  return [
    ...ENUM_VALUES.suggestionStatus.map((status) => ({
      key: status,
      label: SUGGESTION_STATUS_LABEL[status] ?? status,
    })),
    { key: SUGGESTION_ALL_KEY, label: "全部" },
  ];
}

export const SUGGESTION_GAP: ProjectionGap = {
  missing: ["kind", "subjectTerm", "status", "displayNote", "evidence"],
  slots: ["等你表态", "已采纳", "已忽略", "已撤回", "建议条数"],
};

/** 建议的三种表态动作；服务端还没有对应的写通路，所以这一页只摆出位置不接。 */
export const SUGGESTION_ACTIONS: readonly string[] = ["采纳", "忽略", "撤回（依据没了）"];

/**
 * 搜索的四层。**只有原文层现在查得动**（`GET /api/search`），
 * 其余三层要等 §六 的可读投影 —— 这份数据留给接上那天与测试；主界面（SearchPanel）只画 ready 的层。
 */
export interface SearchLayer {
  readonly key: string;
  readonly label: string;
  readonly ready: boolean;
  readonly missing: readonly string[];
}

export const SEARCH_LAYERS: readonly SearchLayer[] = [
  { key: "all", label: "全部", ready: true, missing: [] },
  { key: "records", label: "原文", ready: true, missing: [] },
  {
    key: "derived",
    label: "经历与念头",
    ready: false,
    missing: ["summary / text", "生命周期", "originType", "evidence"],
  },
  { key: "tags", label: "情绪与主题", ready: false, missing: MENTION_MISSING },
  { key: "entities", label: "人与事物", ready: false, missing: ["canonicalName / displayName / entityType", ...MENTION_MISSING] },
];

export function searchLayerOf(key: string): SearchLayer | null {
  return SEARCH_LAYERS.find((layer) => layer.key === key) ?? null;
}

/**
 * 搜索词只做首尾清理：中间的字符由服务端 `tokenize()` 裁决。
 * 前端擅自转小写、切词、去符号，就是在替用户改写他要找的东西 —— 那一层不归界面负责。
 */
export function cleanSearchTerm(raw: string): string {
  return raw.trim();
}

/** 整理模式的可选项：取值来自标签表（键集合 == `enums.json` 的 `processing_modes`）。 */
export function processingModeChoices(): readonly { readonly key: string; readonly label: string }[] {
  return ENUM_VALUES.processingModes.map((mode) => ({ key: mode, label: MODE_LABEL[mode] ?? mode }));
}

/* ════════════════════════════════════════════════════════════════════
 * UI-5：数据口本身 —— 「一份 UI，两个数据源」里的那个「口」。
 *
 * 上面那些形状表回答的是「这一页该长什么样」；这一节回答的是「这一页的内容从哪儿来」。
 * 两个实现各自映射成这里声明的形状，谁也不知道对方存在：
 *   · 真实投影从服务端的派生表读；
 *   · dev 模式的假数据入口（那个开关只在 DEV 构建里生效）从顶层那一份假数据读。
 *
 * 为什么这个口是**同步**的：假数据是静态字节，不需要异步；真实投影落地时如果需要异步，
 * 换的是面板那一层的取数写法（`useRecords` 那一套已经有了），口的形状不变。
 *
 * 返回 `null` = **这个数据源给不出这一页**。面板因此退回 UI-4 的诚实空态：
 * 计数位 `—`、列表空着、缺口点名到字段。「空数组」与「不知道」不能是同一个返回值 ——
 * 前者会说「这一页确实没有东西」，后者才是不许撒谎的那一句。
 * ════════════════════════════════════════════════════════════════════ */

/** 详情里的一组标签 / 值。 */
export type PortDetailPair = readonly [string, string];

/** 详情徽标只承担辨识作用，不是状态机的第二份取值来源。 */
export type PortDetailBadgeTone = "neutral" | "basis" | "status";

export interface PortDetailBadge {
  readonly label: string;
  readonly tone: PortDetailBadgeTone;
}

/** 证据锚点：坐标缺失或回锚失败都是真实状态，不伪装成可点击。 */
export interface PortEvidence {
  readonly text: string;
  readonly start: number | null;
  readonly end: number | null;
  readonly anchored: boolean;
}

/** 一条详情块能回到哪条记录的哪段证据。 */
export interface PortCitation {
  readonly recordId: string;
  readonly recordDate: string;
  readonly evidence: PortEvidence | null;
}

/**
 * 盒子详情的一个独立小段。
 *
 * `fields` 用于概念/经历/念头等概览；`mention` 用于一次具体提及。两种都按纵向
 * 标签/值展示，界面不再从「提及 1 的词面」这种字符串前缀里反推结构。
 */
export interface PortDetailBlock {
  readonly id: string;
  readonly kind: "fields" | "mention";
  readonly title: string;
  readonly fields: readonly PortDetailPair[];
  readonly badges?: readonly PortDetailBadge[];
  readonly citation?: PortCitation | null;
}

/** 列表里的一行：主标题、副标题，与点进详情之后要显示的结构化块。 */
export interface PortRow {
  readonly id: string;
  readonly title: string;
  readonly meta: string;
  readonly detail: readonly PortDetailBlock[];
  /** 仅盒子可视化需要：出现频次；不知道时保持 undefined。 */
  readonly weight?: number;
}

/** 引用层要展示的只读原文。取数仍由 DataPort 负责，BoxPanel 不碰 apiClient。 */
export interface RecordSource {
  readonly recordId: string;
  readonly recordDate: string;
  readonly rawText: string;
  readonly revisionLabel: string;
}

/** 盒子某一页的内容。 */
export interface BoxPageContent {
  /** **与 `BoxShape.counts` 一一对应**的计数值；长度不同即为数据源的错（面板会照着 index 取）。 */
  readonly counts: readonly string[];
  /** 按形状表的表头分组；`heading` 必须能在该页的 `shape.groups` 里找到，找不到的分组面板不画。 */
  readonly groups: readonly { readonly heading: string; readonly rows: readonly PortRow[] }[];
}

/** 「待确认」页的内容。 */
export interface SuggestionContent {
  /** 按建议状态计数，键取自 `enums.json` 的 Suggestion.status（面板的筛选条就是那份键集合）。 */
  readonly counts: Readonly<Record<string, number>>;
  readonly total: number;
  /** 每行带着它属于哪个状态，筛选由面板按 `statusKey` 做（数据源不知道界面当前选了哪一档）。 */
  readonly rows: readonly (PortRow & { readonly statusKey: string })[];
}

export interface DataPort {
  readonly boxPage: (view: BoxView) => BoxPageContent | null;
  readonly suggestions: () => SuggestionContent | null;
  /** 盒子证据的只读引用；不提供或返回 null 时，界面只说找不到原文。 */
  readonly recordSource?: (recordId: string) => Promise<RecordSource | null>;
}

/**
 * 产品默认的那个数据源：**什么都给不出**。
 *
 * 它是「投影还没就绪」这件事的具名实现，不是占位。生产接线（`App.tsx` 不传 `port`）
 * 走的就是这一份，所以生产模式下这五页与 UI-4 交付时逐字一致。
 */
export const UNREADY_DATA_PORT: DataPort = {
  boxPage: () => null,
  suggestions: () => null,
};
