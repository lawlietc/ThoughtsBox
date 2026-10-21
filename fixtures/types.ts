/**
 * 假数据的类型层 —— **照冻结契约手抄，禁止自创取值**。
 *
 * 〔M3-UI-5〕这一份从 `prototype/src/mock/` 提升到顶层 `fixtures/`，因为现在有**两个消费方**：
 * 沟通件（原型）与产品的 dev 模式假数据入口。放在 `prototype/` 下，产品要引用就得反向依赖沟通件目录，
 * 那是 §四 明令禁止的依赖方向；放在 `src/shared/` 下又会把假数据本体混进产品类型图。
 * 顶层是唯一两个方向都成立的位置。
 *
 * 这是最重要的一条纪律。假数据如果自己发明一套数据形状，你就不是在对齐
 * 「产品该怎么呈现」，而是在对齐「我随手编的世界」；等你点头，真实实现根本长不出来。
 *
 * 取值来源（逐字）：
 *   · src/shared/constants/enums.json
 *   · src/server/db/migrations/0002–0006
 *   · spec §2.1 / §3 / §5.2
 *
 * ⚠️ 上述文件一旦改动，本文件必须同步 —— 所以 `prototype/src/mock/contract.ts` 会在启动时逐项对账，
 *    漂移就在横幅上报警，而不是等你发现原型和产品说的不是一件事。
 *    产品的 dev 入口另有一重对账：见 `tests/web-ui5-fixtures.test.ts`。
 *
 * 凡是这里**没有**的字段，就是产品现在**确实没有**的东西 —— 那正是要对齐的缺口。
 *
 * ⚠️ 这里的取值集合**允许比 enums.json 宽**：`time_of_day`（精度档）是〔用户裁定 2026-10-14〕
 *    的预览档，产品契约到现在（schema v6）仍只有 `year|month|day|unknown`。所以**产品侧消费
 *    这份 fixture 时必须把它折叠回产品取值**（见 `src/web/fixturePort.ts`），不许照着打印。
 *    （8 类实体大类曾经是第二处预览档，M3-DB-1 已随 0006 转正 —— 现在与 enums.json 同集合，
 *    不再是宽出来的档。）
 */

/* ── 原文层（0002） ─────────────────────────────────────────────── */

export type ProcessingStatus =
  | "captured"
  | "awaiting_privacy_review"
  | "preprocessing"
  | "processing"
  | "parsed"
  | "failed"
  | "needs_reparse"
  | "not_processed";

export type ProcessingMode = "manual_only" | "local_model" | "cloud_redacted";

export type PrivacyLevel = "normal" | "sensitive";

export interface Revision {
  readonly id: string;
  readonly number: number;
  readonly rawText: string;
  readonly createdAtLocal: string;
}

export interface Grant {
  readonly grantId: string;
  readonly revisionId: string;
  readonly policyVersion: string;
  readonly payloadSha256: string;
  readonly confirmedAtUtc: string;
}

export interface RecordItem {
  readonly id: string;
  readonly createdAtLocal: string;
  readonly timezoneId: string;
  readonly processingStatus: ProcessingStatus;
  readonly processingMode: ProcessingMode;
  readonly privacyLevel: PrivacyLevel;
  /** 版本只增不改（ADR-007）：编辑原文 = 追加新版本，旧版本永远在。 */
  readonly revisions: readonly Revision[];
  readonly currentRevisionId: string;
  /** cloud_redacted 的**本次**发送授权（绑定 revision + 载荷哈希 + 策略版本，内容一变即失效）。 */
  readonly grant: Grant | null;
}

/* ── 派生层（0003） ─────────────────────────────────────────────── */

export type ResultState = "candidate" | "current" | "superseded";
export type ExecutionStatus = "queued" | "running" | "succeeded" | "failed";

/** 0003 全表共用（origin_type_subsets 按表收紧）。 */
export type OriginType =
  | "system_seed"
  | "ai_generated"
  | "user_created"
  | "user_confirmed_suggestion";

/**
 * explicit = 用户原话里说出口的；inferred = 模型推断的。
 * **basis_origin_matrix 是硬的**：`inferred` 只允许配 `user_confirmed_suggestion`。
 * 也就是说 —— 模型的推断情绪**没有资格**直接成为一条提及，它必须先当建议，
 * 经你确认之后才落库，并且永远带着「推断」的标记。UI 必须让这两者一眼可辨。
 */
export type Basis = "explicit" | "inferred";

/** Episode / ThoughtItem：只有两态，没有 rejected（0003 + lifecycle_states）。 */
export type DerivedLifecycle = "active" | "superseded";

/** Mention：可以 rejected —— 你移除的标签，重跑不得静默复活（按稳定 ID 判定）。 */
export type MentionStatus = "active" | "superseded" | "rejected";

/** Concept：没有 superseded，但有 merged（合并可撤销，ADR-010）。 */
export type ConceptLifecycle = "active" | "merged" | "archived";

/** Entity：provisional 是缺省态，不进默认浏览列表（§2.1(6)）。 */
export type EntityLifecycle = "provisional" | "active" | "archived";

export type EdgeLifecycle = "active" | "superseded";

/**
 * 证据锚点。真实库里是 evidence_text + evidence_start/end 三元组，
 * 且**必须能在（脱敏后的）输入文本里回溯**（§5.3 / K-23），否则不得成为有效提及。
 * `anchored=false` 就是那条失败路径 —— 原型必须演出来，否则你会以为抽取永远成功。
 */
export interface Evidence {
  readonly text: string;
  readonly start: number;
  readonly end: number;
  readonly anchored: boolean;
}

/**
 * 事件时间精度。**契约现行值只有 `year|month|day|unknown`**（enums.json）。
 *
 * ⚠️ `time_of_day` 是本原型**故意加的实验档**（〔用户裁定 2026-10-14〕N-01）：
 * 原文里「早上 / 傍晚 / 深夜 / 刚才」这类**时段**表达无处安放，按现行契约只能落 unknown，
 * 等于把说得清的东西说丢。这里先让界面「有地方放它」，看多了这一档之后界面会长什么样 ——
 * 这正是原型最便宜的用法。它**不被 `auditContract` 当作通过**，而是单列进 `experiments`，
 * 顶部横幅会明说「你正在预览一个产品还没有的取值」，不装作它已经存在。
 */
export type EventTimePrecision = "year" | "month" | "day" | "time_of_day" | "unknown";
export type EventTimeCertainty = "explicit" | "approximate" | "unknown";

/** 一天内的时段档 —— 只在本原型的实验里出现，产品契约目前没有这个概念。 */
export type TimeOfDaySlot = "清晨" | "上午" | "中午" | "下午" | "傍晚" | "夜里" | "深夜";

export interface Episode {
  readonly id: string;
  readonly summary: string;
  readonly originType: OriginType;
  readonly lifecycleStatus: DerivedLifecycle;
  readonly eventTimeRaw: string | null;
  readonly eventTimePrecision: EventTimePrecision;
  readonly eventTimeCertainty: EventTimeCertainty;
  readonly evidence: Evidence | null;
}

export interface ThoughtItem {
  readonly id: string;
  readonly text: string;
  readonly originType: OriginType;
  readonly lifecycleStatus: DerivedLifecycle;
  readonly evidence: Evidence | null;
}

export type ConceptType = "emotion" | "topic";

export interface Concept {
  readonly id: string;
  readonly conceptType: ConceptType;
  readonly canonicalName: string;
  readonly lifecycleStatus: ConceptLifecycle;
  /** 词表播种的 vs 你确认后新建的 —— 这个概念是怎么来的。 */
  readonly originType: OriginType;
}

/*
 * 实体大类。**2026-10-14 晚改过一次，产品侧已于 M3-DB-1（schema v6）跟进**，见下。
 *
 * 原来 7 类，有两处不整齐：`game` 单独占一类（它其实是作品的一种）；
 * `work` 与 `product` 边界模糊（"一款 App"算哪个没标准）。
 * 现在合并成下面这 8 类，并新增 `activity` / `event` —— 理由是：
 * **"跑步"和"老周"其实是同一种东西**，会反复出现在很多条记录里，值得单独记一笔；
 * 放进"其他"就永远长不出来。
 *
 * 产品侧已走迁移 + 取值门落地：`0006_entity_types_v2.sql` 整表重建 `entity` 与
 * `user_scalar_override`，存量 `entity_type = 'game'` 的行按裁定归一为 `'work'`。
 * 与 enums.json 同集合，本文件这里不再是宽出来的档。
 */
export type EntityType =
  | "person"
  | "organization"
  | "place"
  | "work"
  | "product"
  | "activity"
  | "event"
  | "other";

export interface Entity {
  readonly id: string;
  readonly entityType: EntityType;
  readonly canonicalName: string;
  readonly displayName: string;
  readonly lifecycleStatus: EntityLifecycle;
}

/**
 * 提及的来源容器 —— 三选一（0003 用 CHECK 强制恰好一种）。
 * 这三者在图上**待遇完全不同**（§3.2.4 / §2.2），原型必须演出来：
 *   episode        → 生成 Episode—Concept / Episode—Entity 可视边
 *   record_revision→ 不生成边、不生成影子节点，只在详情与搜索里可达
 *   thought_item   → 同上
 * 否则你会以为所有标签都会变成图上的线 —— 那是个很贵的误会。
 */
export type MentionSourceKind = "record_revision" | "episode" | "thought_item";

export interface MentionSource {
  readonly kind: MentionSourceKind;
  readonly containerId: string;
}

export interface Mention {
  readonly id: string;
  readonly kind: ConceptType;
  readonly conceptId: string;
  /** 用户原文里出现的那个词/短语（不是标准名）—— 证据回溯就是回到它。 */
  readonly labelSaid: string;
  readonly basis: Basis;
  readonly status: MentionStatus;
  readonly originType: OriginType;
  readonly evidence: Evidence | null;
  readonly source: MentionSource;
  /** 仅 emotion 有；`intensitySource='user'` 表示这是你改过的，不是模型给的。 */
  readonly intensity?: number;
  readonly intensitySource?: "user";
}

export interface EntityMention {
  readonly id: string;
  readonly entityId: string;
  readonly labelSaid: string;
  readonly basis: Basis;
  readonly status: MentionStatus;
  readonly originType: OriginType;
  readonly evidence: Evidence | null;
  readonly source: MentionSource;
  /** 普通文本属性（colleague / friend / location…），V0 不约束枚举、不参与关系类型、不生成边。 */
  readonly role: string | null;
}

/** 冻结六值。`new_concept` 是「主题候选」的正名，`possibly_same_as` 是「疑似同一实体」。 */
export type SuggestionKind =
  | "emotion_candidate"
  | "alias"
  | "new_concept"
  | "possibly_related"
  | "possibly_same_as"
  | "evidence_repair";

/** `pending → accepted | ignored | withdrawn`；ignored 可**找回**重提，accepted 与 withdrawn 是终态。 */
export type SuggestionStatus = "pending" | "accepted" | "ignored" | "withdrawn";

export interface Suggestion {
  readonly id: string;
  readonly kind: SuggestionKind;
  readonly recordId: string;
  readonly runId: string;
  /** 建议的对象：情绪候选名 / 新主题词面 / 关联到的记录 等。 */
  readonly subjectTerm: string;
  readonly reasonCode: string;
  readonly displayNote: string;
  readonly status: SuggestionStatus;
  readonly evidence: Evidence | null;
}

/* ── 图谱（M3 只读投影层，ADR-012：永不反向写入业务数据） ─────────── */

/** 真正落 `graph_edge` 表的三条。端点必须是 Episode / Concept / Entity:active。 */
export type GraphEdgeType = "possibly_related" | "same_as" | "merged_into";

/**
 * 三条**不入库**的展示边（relation_type_rules.not_stored_in_graph_edge）：
 * 它们由提及层实时投影，免得同一事实在库里写两遍。
 * 对界面而言两者都是「一条线」，但实现上是两条完全不同的路径。
 */
export type ProjectedEdgeType = "has_emotion" | "on_topic" | "about";

export interface GraphEdge {
  readonly id: string;
  readonly relationType: GraphEdgeType;
  readonly srcId: string;
  readonly dstId: string;
  readonly createdBy: "user" | "user_confirmed_suggestion";
  readonly lifecycleStatus: EdgeLifecycle;
  /** 边必须能追溯到一个依据（M4 断言：图上每条边都可追溯到有效提及或 GraphEdge）。 */
  readonly evidenceReason: string;
}

/* ── 一次解析运行（0003 parse_run） ─────────────────────────────── */

export interface ParseRun {
  readonly id: string;
  readonly recordId: string;
  readonly revisionId: string;
  /** candidate 不进当前视图也不进图谱；同一 revision 同时至多一个 current。 */
  readonly resultState: ResultState;
  readonly executionStatus: ExecutionStatus;
  readonly errorKind: string | null;
  readonly startedAtLocal: string;
  readonly finishedAtLocal: string | null;
  readonly model: string;
  readonly provider: string;
  readonly callPath: string;
}

/** 一次运行的完整产出。同一 recordId 的多次运行**并存** —— 旧结果不删，只是不再是 current。 */
export interface RunOutput {
  readonly title: string;
  readonly summary: string;
  readonly episodes: readonly Episode[];
  readonly thoughts: readonly ThoughtItem[];
  readonly emotions: readonly Mention[];
  readonly topics: readonly Mention[];
  readonly entityMentions: readonly EntityMention[];
  readonly suggestions: readonly Suggestion[];
  /** 本机映射，**绝不上线**（§5.1 步骤 5）：占位符 → 真实词面。 */
  readonly redactionMap: Readonly<Record<string, string>>;
  /** 证据回锚不上的条目（§7.6.4 逐条分流：通过的照写，不通过的进这里）。 */
  readonly evidenceRepairs: readonly string[];
  /** 无法归入任何 Experience/Thought 的标签 —— 仍可见，不静默丢弃。 */
  readonly unrouted: readonly string[];
  /** 模型给出的原始 title 之外，本次运行暴露的产品问题（原型专有的对齐提示）。 */
  readonly productNotes: readonly string[];
}

export interface ConceptBook {
  readonly concepts: Readonly<Record<string, Concept>>;
  readonly entities: Readonly<Record<string, Entity>>;
}

export interface Attachment {
  readonly run: ParseRun;
  readonly output: RunOutput;
}

/**
 * 到这里为止全是**数据形状**。
 *
 * 界面状态（`ViewKey` / `TabKey` / `tabOf` / `Highlight`）**不在这一份里** ——
 * 它们属于沟通件自己，产品有产品的一套导航（见 `src/web/ui/nav.ts`）。
 * 假数据本体放在顶层 `fixtures/` 是为了产品和原型共用同一份；
 * 共用的是数据形状，从来不是导航结构。
 */
