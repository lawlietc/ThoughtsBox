/**
 * 中文标签表 —— 纯展示，不参与契约判定。
 *
 * 有一条纪律在这里被写成代码而不是注释：**每张表的键集合来自 `src/shared/constants/enums.json`，
 * 不是本文件抄的**。抄一遍取值就等于埋一颗雷 —— 契约加了个值，界面不会报错，只会把新值
 * 显示成空白或原文，而那种「看起来正常」的漏显示最难被发现。
 *
 * 所以 `labeled()` 在装载时双向核对着：enums.json 有的取值这里必须有标签，
 * 这里多出来的键必须是 enums.json 已经删掉的取值。对不上就抛 —— 宁可白屏一次，
 * 也不让界面带着一个过期的取值世界跑下去。
 */

import enumsJson from "../../shared/constants/enums.json" with { type: "json" };
import type { EnumFile } from "../../shared/contracts/enums.ts";

/** 与 `contracts/enums.ts` 同一份结构声明，这里不另抄一遍字段形状。 */
const enums = enumsJson as unknown as EnumFile;

/** 封闭枚举的运行时取值清单 —— 界面要用「有哪些取值」时从这里拿，不许自己列。 */
export const ENUM_VALUES = {
  basis: enums.basis_values,
  processingStatuses: enums.processing_statuses,
  processingModes: enums.processing_modes,
  suggestionKinds: enums.suggestion_kinds,
  entityTypes: enums.entity_types,
  mentionSourceKinds: enums.mention_source_kinds,
  originTypes: enums.origin_types,
  eventTimePrecision: enums.event_time_precision,
  eventTimeCertainty: enums.event_time_certainty,
  privacyLevels: enums.privacy_levels,
  mentionStatus: enums.lifecycle_states["Mention.status"]?.values ?? [],
  suggestionStatus: enums.lifecycle_states["Suggestion.status"]?.values ?? [],
  episodeLifecycle: enums.lifecycle_states["Episode.lifecycle_status"]?.values ?? [],
  conceptLifecycle: enums.lifecycle_states["Concept.lifecycle_status"]?.values ?? [],
  entityLifecycle: enums.lifecycle_states["Entity.lifecycle_status"]?.values ?? [],
} as const;

type LabelTable = Readonly<Record<string, string>>;

/** 装载时核对键集合，见文件头的纪律说明。 */
function labeled(table: string, values: readonly string[], entries: Record<string, string>): LabelTable {
  const missing = values.filter((value) => !(value in entries));
  const stale = Object.keys(entries).filter((key) => !values.includes(key));
  if (missing.length === 0 && stale.length === 0) return entries;
  const parts: string[] = [];
  if (missing.length > 0) parts.push(`契约有、标签表没有：${missing.join("、")}`);
  if (stale.length > 0) parts.push(`标签表里有、契约已经没有：${stale.join("、")}`);
  throw new Error(`标签表 ${table} 与 enums.json 的取值对不上 —— ${parts.join("；")}`);
}

export const STATUS_LABEL = labeled("STATUS_LABEL", ENUM_VALUES.processingStatuses, {
  captured: "已捕获",
  awaiting_privacy_review: "待确认发送",
  preprocessing: "预处理中",
  processing: "解析中",
  parsed: "已整理",
  failed: "整理失败",
  needs_reparse: "原文已改，待重新整理",
  not_processed: "未处理",
});

export const MODE_LABEL = labeled("MODE_LABEL", ENUM_VALUES.processingModes, {
  manual_only: "只自己看，不送模型",
  local_model: "本地模型",
  cloud_redacted: "云端（脱敏后发送）",
});

export const ENTITY_TYPE_LABEL = labeled("ENTITY_TYPE_LABEL", ENUM_VALUES.entityTypes, {
  person: "人物",
  organization: "组织",
  place: "地点",
  work: "作品",
  product: "物品",
  activity: "活动",
  event: "事件",
  other: "其他",
});

export const SUGGESTION_LABEL = labeled("SUGGESTION_LABEL", ENUM_VALUES.suggestionKinds, {
  emotion_candidate: "情绪候选",
  alias: "别名候选",
  new_concept: "新主题候选",
  possibly_related: "疑似相关",
  possibly_same_as: "疑似同一实体",
  evidence_repair: "证据对不上",
});

export const SUGGESTION_STATUS_LABEL = labeled("SUGGESTION_STATUS_LABEL", ENUM_VALUES.suggestionStatus, {
  pending: "等你表态",
  accepted: "已采纳",
  ignored: "已忽略",
  withdrawn: "已撤回",
});

export const BASIS_LABEL = labeled("BASIS_LABEL", ENUM_VALUES.basis, {
  explicit: "原话说出口",
  inferred: "模型推断（你确认过）",
});

export const MENTION_STATUS_LABEL = labeled("MENTION_STATUS_LABEL", ENUM_VALUES.mentionStatus, {
  active: "有效",
  superseded: "已被取代",
  rejected: "你已移除",
});

/** Episode / ThoughtItem 只有两态，没有 rejected。 */
export const DERIVED_LIFECYCLE_LABEL = labeled("DERIVED_LIFECYCLE_LABEL", ENUM_VALUES.episodeLifecycle, {
  active: "有效",
  superseded: "已被取代",
});

/** Concept 没有 superseded，但有 merged（合并可撤销，ADR-010）。 */
export const CONCEPT_LIFECYCLE_LABEL = labeled("CONCEPT_LIFECYCLE_LABEL", ENUM_VALUES.conceptLifecycle, {
  active: "在用",
  merged: "已合并",
  archived: "已归档",
});

/** Entity 的 provisional 是缺省态，不进默认浏览列表。 */
export const ENTITY_LIFECYCLE_LABEL = labeled("ENTITY_LIFECYCLE_LABEL", ENUM_VALUES.entityLifecycle, {
  provisional: "待转正",
  active: "已转正",
  archived: "已归档",
});

export const EVENT_TIME_PRECISION_LABEL = labeled(
  "EVENT_TIME_PRECISION_LABEL",
  ENUM_VALUES.eventTimePrecision,
  {
    year: "年",
    month: "月",
    day: "日",
    unknown: "时间不明",
  },
);

export const EVENT_TIME_CERTAINTY_LABEL = labeled("EVENT_TIME_CERTAINTY_LABEL", ENUM_VALUES.eventTimeCertainty, {
  explicit: "原文写明",
  approximate: "约摸",
  unknown: "原文未提",
});
