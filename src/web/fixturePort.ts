/**
 * 数据口的**第二个实现**：把顶层那份假数据映射成 UI-4 定下的形状（`DataPort`）。
 *
 * ⚠️ 这一层**只在 dev 构建里存在**。它被 `fakeDataEntry.tsx` 引用，而后者只经 `main.tsx`
 * 里那个动态 import 进来 —— 生产入口的静态图不含这一层，也不含假数据本体
 * （`tests/web-ui5-fixtures.test.ts` 把这条变成会红的断言，构建产物扫描再钉一遍）。
 *
 * 三条口径，都是「假数据不能骗人」的具体形态：
 *
 * 1. **只看当前视图。** `run.resultState !== "current"` 的那份产出（失败 run、被取代的旧结果）
 *    不进盒子 —— 真实投影将来也是这一条规则（§3.7）。建议例外：历史运行提出的建议
 *    仍然留在建议表里，那正是「待确认」页要按状态分四组的原因。
 * 2. **不打印产品契约里还没有的取值。** 假数据里有 `time_of_day` 这一档时间精度（沟通件按
 *    〔用户裁定 2026-10-14〕预览的实验档），`enums.json` 没有。这一层把它**折叠进「时间不明」
 *    那一组**，原文写的时段与「产品还没有这一档」写进详情 —— 看的人得到同一条信息，
 *    但界面上不会出现一个契约里不存在的取值。
 * 3. **措辞一律来自 `ui/labels.ts`**（其键集合在装载时对照 `enums.json` 核对）。
 *    这一层自己一个枚举词都不抄 —— 抄一份就等于埋一颗「界面显示过期世界」的雷。
 */

import { CONCEPTS, ENTITIES, makeSeedAttachments, makeSeedRecords } from "../../fixtures/data.ts";
import {
  BASIS_LABEL,
  CONCEPT_LIFECYCLE_LABEL,
  DERIVED_LIFECYCLE_LABEL,
  ENTITY_LIFECYCLE_LABEL,
  ENTITY_TYPE_LABEL,
  EVENT_TIME_PRECISION_LABEL,
  MENTION_STATUS_LABEL,
  SUGGESTION_LABEL,
  SUGGESTION_STATUS_LABEL,
} from "./ui/labels.ts";
import { boxGroupHeading } from "./projectionPort.ts";
import type { EntityMention, Episode, Mention, Suggestion, ThoughtItem } from "../../fixtures/types.ts";
import type {
  BoxView,
  DataPort,
  PortCitation,
  PortDetailBlock,
  PortDetailPair,
  PortRow,
  RecordSource,
} from "./projectionPort.ts";

interface WithRecord {
  readonly recordId: string;
}

/** 一条假数据里的对象，摊平成「按对象看」的五张表（数据是静态的，加载时算一次）。 */
const CURRENT_RUNS = Object.values(makeSeedAttachments())
  .flat()
  .filter((attachment) => attachment.run.resultState === "current");

const RECORDS = makeSeedRecords();

const RECORD_DATES: Readonly<Record<string, string>> = Object.fromEntries(
  RECORDS.map((record) => [record.id, record.createdAtLocal.slice(0, 10)]),
);

const RECORD_BY_ID = new Map(RECORDS.map((record) => [record.id, record]));

const CONCEPT_MENTIONS: readonly (Mention & WithRecord)[] = CURRENT_RUNS.flatMap((attachment) =>
  [...attachment.output.emotions, ...attachment.output.topics].map((mention) => ({
    ...mention,
    recordId: attachment.run.recordId,
  })),
);

const ENTITY_MENTIONS: readonly (EntityMention & WithRecord)[] = CURRENT_RUNS.flatMap((attachment) =>
  attachment.output.entityMentions.map((mention) => ({ ...mention, recordId: attachment.run.recordId })),
);

const EPISODES: readonly (Episode & WithRecord)[] = CURRENT_RUNS.flatMap((attachment) =>
  attachment.output.episodes.map((episode) => ({ ...episode, recordId: attachment.run.recordId })),
);

const THOUGHTS: readonly (ThoughtItem & WithRecord)[] = CURRENT_RUNS.flatMap((attachment) =>
  attachment.output.thoughts.map((thought) => ({ ...thought, recordId: attachment.run.recordId })),
);

/** 全部运行（含被取代与失败的）提出的建议 —— 建议表不按 current 过滤，见文件头第 1 条。 */
const SUGGESTIONS: readonly (Suggestion & WithRecord)[] = Object.values(makeSeedAttachments())
  .flat()
  .flatMap((attachment) => attachment.output.suggestions.map((s) => ({ ...s, recordId: attachment.run.recordId })));

/* ── 详情行的措辞（全部由标签表拼出来） ─────────────────────────── */

function labelOf(table: Readonly<Record<string, string>>, key: string): string {
  return table[key] ?? key;
}

/** 提及来源：三选一在图上待遇完全不同，详情必须说清是哪一种。 */
function sourceText(source: Mention["source"]): string {
  if (source.kind === "episode") return `经历 ${source.containerId}（只有这一类上图）`;
  if (source.kind === "thought_item") return `念头 ${source.containerId}（不上图）`;
  return `原文版本 ${source.containerId}（不上图）`;
}

function evidenceText(evidence: Mention["evidence"]): string {
  if (evidence === null) return "没有证据 —— 按契约它不得成为有效提及";
  if (!evidence.anchored) return `「${evidence.text}」—— 回锚失败：这句在原文里找不到`;
  return `「${evidence.text}」（原文第 ${evidence.start}–${evidence.end} 字）`;
}

function recordText(recordId: string): string {
  return `${recordId}（${RECORD_DATES[recordId] ?? "日期未知"}）`;
}

function citationOf(
  recordId: string,
  evidence: Mention["evidence"] | Episode["evidence"],
): PortCitation {
  return {
    recordId,
    recordDate: RECORD_DATES[recordId] ?? "日期未知",
    evidence:
      evidence === null
        ? null
        : {
            text: evidence.text,
            start: evidence.start,
            end: evidence.end,
            anchored: evidence.anchored,
          },
  };
}

function fieldsBlock(
  id: string,
  title: string,
  rows: readonly PortDetailPair[],
  citation?: PortCitation,
): PortDetailBlock {
  return citation === undefined
    ? { id, kind: "fields", title, fields: rows }
    : { id, kind: "fields", title, fields: rows, citation };
}

function mentionDetail(mention: Mention & WithRecord, index: number): PortDetailBlock {
  const fields: PortDetailPair[] = [["来源", sourceText(mention.source)]];
  if (mention.kind === "emotion") {
    fields.push([
      "强度",
      mention.intensity === undefined
        ? "没给"
        : `${mention.intensity}${mention.intensitySource === "user" ? "（你改过的，不是模型给的）" : ""}`,
    ]);
  }
  fields.push(["记录", RECORD_DATES[mention.recordId] ?? "日期未知"]);
  return {
    id: mention.id,
    kind: "mention",
    title: `「${mention.labelSaid}」`,
    badges: [
      { label: `提及 ${index + 1}`, tone: "neutral" },
      { label: labelOf(BASIS_LABEL, mention.basis), tone: "basis" },
      { label: labelOf(MENTION_STATUS_LABEL, mention.status), tone: "status" },
    ],
    fields,
    citation: citationOf(mention.recordId, mention.evidence),
  };
}

/* ── 情绪 / 主题：底层同一份，入口分开 ───────────────────────────── */

function mentionsOf(conceptKind: "emotion" | "topic", conceptId: string): readonly (Mention & WithRecord)[] {
  return CONCEPT_MENTIONS.filter((m) => m.kind === conceptKind && m.conceptId === conceptId);
}

function seenConceptRows(conceptKind: "emotion" | "topic"): readonly PortRow[] {
  return Object.values(CONCEPTS)
    .filter((concept) => concept.conceptType === conceptKind)
    .map((concept) => ({ concept, mentions: mentionsOf(conceptKind, concept.id) }))
    .filter((entry) => entry.mentions.length > 0)
    .sort((a, b) => b.mentions.length - a.mentions.length)
    .map(({ concept, mentions }) => ({
      id: concept.id,
      title: concept.canonicalName,
      meta: `${mentions.length} 次提及 · 最近词面「${mentions[0]?.labelSaid ?? ""}」`,
      weight: mentions.length,
      detail: [
        fieldsBlock(`${concept.id}-overview`, "概念", [
          ["标准名", `${concept.canonicalName}（词表里的名字，不是你当时写下的那个词）`],
          ["生命周期", labelOf(CONCEPT_LIFECYCLE_LABEL, concept.lifecycleStatus)],
        ]),
        ...mentions.map((mention, index) => mentionDetail(mention, index)),
      ],
    }));
}

/** 「词表里但从未出现」那一组：列出来是为了看清词表覆盖，不是为了凑数。 */
function neverSeenRows(conceptKind: "emotion" | "topic"): readonly PortRow[] {
  const mentioned = new Set(CONCEPT_MENTIONS.filter((m) => m.kind === conceptKind).map((m) => m.conceptId));
  return Object.values(CONCEPTS)
    .filter((concept) => concept.conceptType === conceptKind && !mentioned.has(concept.id))
    .map((concept) => ({
      id: concept.id,
      title: concept.canonicalName,
      meta: "词表里，一次都没被提到",
      weight: 0,
      detail: [
        fieldsBlock(`${concept.id}-overview`, "概念", [
          ["标准名", concept.canonicalName],
          ["生命周期", labelOf(CONCEPT_LIFECYCLE_LABEL, concept.lifecycleStatus)],
          ["为什么列出来", "看清词表的覆盖，不是为了凑数"],
        ]),
      ],
    }));
}

/* ── 经历 ───────────────────────────────────────────────────────── */

/** 产品契约只有 year / month / day / unknown；只有「日」排得进按时间回看那条线。 */
function timelineEligible(precision: string): boolean {
  return precision === "day";
}

/** 契约里没有的精度档（假数据的实验档）—— 一律折叠显示，绝不把原文取值打印出去。 */
function isUnlabeledPrecision(precision: string): boolean {
  return !["year", "month", "day", "unknown"].includes(precision);
}

function episodeDetail(episode: Episode & WithRecord): readonly PortDetailBlock[] {
  const precisionText = isUnlabeledPrecision(episode.eventTimePrecision)
    ? `排不进按日的回看 —— 原文写的是「${episode.eventTimeRaw ?? "未写"}」这类时段表达，产品契约现在没有这一档`
    : labelOf(EVENT_TIME_PRECISION_LABEL, episode.eventTimePrecision);
  const tags = CONCEPT_MENTIONS.filter(
    (m) => m.source.kind === "episode" && m.source.containerId === episode.id,
  );
  const entities = ENTITY_MENTIONS.filter(
    (m) => m.source.kind === "episode" && m.source.containerId === episode.id,
  );
  const related: PortDetailPair[] =
    tags.length + entities.length === 0
      ? []
      : [["关联", [...tags.map((m) => m.labelSaid), ...entities.map((m) => m.labelSaid)].join("、")]];
  return [
    fieldsBlock(
      episode.id,
      "这条经历",
      [
        ["摘要", episode.summary],
        ["事件时间（原文写的）", episode.eventTimeRaw ?? "原文没写时间"],
        ["时间精度", precisionText],
        ["生命周期", labelOf(DERIVED_LIFECYCLE_LABEL, episode.lifecycleStatus)],
        ["来自记录", recordText(episode.recordId)],
        ...related,
      ],
      citationOf(episode.recordId, episode.evidence),
    ),
  ];
}

/* ── 念头 ───────────────────────────────────────────────────────── */

function labelsOnThought(thoughtId: string): readonly (Mention & WithRecord)[] {
  return CONCEPT_MENTIONS.filter((m) => m.source.kind === "thought_item" && m.source.containerId === thoughtId);
}

function thoughtRow(thought: ThoughtItem & WithRecord): PortRow {
  const labels = labelsOnThought(thought.id);
  const notOnGraph: PortDetailPair[] =
    labels.length > 0
      ? [["不上图", "来源是念头的提及既不生成边、也不生成影子节点 —— 这一页是它们唯一的家"]]
      : [];
  return {
    id: thought.id,
    title: thought.text,
    meta: `${labels.length} 个标签 · ${thought.recordId}`,
    detail: [
      fieldsBlock(
        thought.id,
        "这个念头",
        [
          ["内容", thought.text],
          ["生命周期", labelOf(DERIVED_LIFECYCLE_LABEL, thought.lifecycleStatus)],
          ["来自记录", recordText(thought.recordId)],
          ...notOnGraph,
        ],
        citationOf(thought.recordId, thought.evidence),
      ),
      ...labels.map((mention, index) => mentionDetail(mention, index)),
    ],
  };
}

/* ── 人物与事物 ─────────────────────────────────────────────────── */

function entityMentionsOf(entityId: string): readonly (EntityMention & WithRecord)[] {
  return ENTITY_MENTIONS.filter((m) => m.entityId === entityId);
}

function entityMentionDetail(mention: EntityMention & WithRecord, index: number): PortDetailBlock {
  return {
    id: mention.id,
    kind: "mention",
    title: `「${mention.labelSaid}」`,
    badges: [
      { label: `提及 ${index + 1}`, tone: "neutral" },
      { label: labelOf(BASIS_LABEL, mention.basis), tone: "basis" },
      { label: labelOf(MENTION_STATUS_LABEL, mention.status), tone: "status" },
    ],
    fields: [
      ["角色", mention.role ?? "没写"],
      ["来源", sourceText(mention.source)],
      ["记录", recordText(mention.recordId)],
    ],
    citation: citationOf(mention.recordId, mention.evidence),
  };
}

function entityRow(entityId: string): PortRow {
  const entity = ENTITIES[entityId];
  const mentions = entityMentionsOf(entityId);
  if (entity === undefined) {
    return { id: entityId, title: entityId, meta: "假数据里没有这个实体（数据源的错）", detail: [] };
  }
  return {
    id: entityId,
    title: entity.displayName,
    meta: `${labelOf(ENTITY_TYPE_LABEL, entity.entityType)} · 提到 ${mentions.length} 次`,
    detail: [
      fieldsBlock(`${entityId}-overview`, "这个实体", [
        ["显示名", entity.displayName],
        ["类型", labelOf(ENTITY_TYPE_LABEL, entity.entityType)],
        ["生命周期", labelOf(ENTITY_LIFECYCLE_LABEL, entity.lifecycleStatus)],
        ["提到的次数", String(mentions.length)],
      ]),
      ...mentions.map((mention, index) => entityMentionDetail(mention, index)),
    ],
  };
}

function entityIdsWithLifecycle(lifecycle: string): readonly PortRow[] {
  return Object.keys(ENTITIES)
    .filter((id) => ENTITIES[id]?.lifecycleStatus === lifecycle)
    .map(entityRow);
}

/* ── 建议（待确认页 + 主题页的候选那一组） ───────────────────────── */

function suggestionRow(suggestion: Suggestion & WithRecord): PortRow & { readonly statusKey: string } {
  return {
    id: suggestion.id,
    statusKey: suggestion.status,
    title: `${labelOf(SUGGESTION_LABEL, suggestion.kind)}：${suggestion.subjectTerm}`,
    meta: `${labelOf(SUGGESTION_STATUS_LABEL, suggestion.status)} · 来自 ${suggestion.recordId}`,
    detail: [
      fieldsBlock(suggestion.id, "这条建议", [
        ["建议类型", labelOf(SUGGESTION_LABEL, suggestion.kind)],
        ["状态", labelOf(SUGGESTION_STATUS_LABEL, suggestion.status)],
        ["对象词面", suggestion.subjectTerm],
        ["为什么在这儿", suggestion.displayNote],
        ["证据", evidenceText(suggestion.evidence)],
        ["记录 / 运行", `${recordText(suggestion.recordId)} · ${suggestion.runId}`],
      ]),
    ],
  };
}

function suggestionsWith(kind: Suggestion["kind"], status: Suggestion["status"]): readonly (Suggestion & WithRecord)[] {
  return SUGGESTIONS.filter((s) => s.kind === kind && s.status === status);
}

/* ── 那一入口 ───────────────────────────────────────────────────── */

interface BoxGroups {
  readonly heading: string;
  readonly rows: readonly PortRow[];
}

/**
 * 分组表头**一律从 `projectionPort.ts` 的形状表里取**，不在这里重拼一遍。
 * 拼两遍就会有第三遍对不上的那天：面板按形状表的表头找分组，找不到就画空组，
 * 而那种「看起来正常」的漏显示最难被发现。
 */
function heading(view: BoxView, index: number): string {
  return boxGroupHeading(view, index);
}

function boxContent(view: BoxView): { readonly counts: readonly string[]; readonly groups: readonly BoxGroups[] } {
  const emotionMentions = CONCEPT_MENTIONS.filter((m) => m.kind === "emotion");
  const topicMentions = CONCEPT_MENTIONS.filter((m) => m.kind === "topic");
  switch (view) {
    case "emotions": {
      const seen = seenConceptRows("emotion");
      const unseen = neverSeenRows("emotion");
      return {
        counts: [
          String(seen.length),
          String(unseen.length),
          String(emotionMentions.filter((m) => m.status === "active").length),
          // 「不上图」= 来源不是经历的那些提及（§3.2.4）—— 这一页是它们唯一的家。
          String(emotionMentions.filter((m) => m.source.kind !== "episode").length),
        ],
        groups: [
          { heading: heading("emotions", 0), rows: seen },
          { heading: heading("emotions", 1), rows: unseen },
        ],
      };
    }
    case "episodes": {
      const eligible = EPISODES.filter((e) => timelineEligible(e.eventTimePrecision));
      const rest = EPISODES.filter((e) => !timelineEligible(e.eventTimePrecision));
      return {
        counts: [String(EPISODES.length), String(eligible.length), String(rest.length)],
        groups: [
          { heading: heading("episodes", 0), rows: eligible.map(episodeRow) },
          { heading: heading("episodes", 1), rows: rest.map(episodeRow) },
        ],
      };
    }
    case "thoughts": {
      const rows = THOUGHTS.map(thoughtRow);
      const labeled = rows.filter((row) => labelsOnThought(row.id).length > 0);
      return {
        counts: [String(rows.length), String(labeled.length), String(rows.length - labeled.length)],
        groups: [
          { heading: heading("thoughts", 0), rows: labeled },
          { heading: heading("thoughts", 1), rows: rows.filter((row) => labelsOnThought(row.id).length === 0) },
        ],
      };
    }
    case "entities": {
      const candidates = suggestionsWith("possibly_same_as", "pending").map(suggestionRow);
      return {
        counts: [
          String(entityIdsWithLifecycle("active").length),
          String(entityIdsWithLifecycle("provisional").length),
          String(entityIdsWithLifecycle("archived").length),
          String(ENTITY_MENTIONS.length),
        ],
        groups: [
          { heading: heading("entities", 0), rows: entityIdsWithLifecycle("active") },
          { heading: heading("entities", 1), rows: entityIdsWithLifecycle("provisional") },
          { heading: heading("entities", 2), rows: entityIdsWithLifecycle("archived") },
          { heading: heading("entities", 3), rows: candidates },
        ],
      };
    }
    case "topics": {
      const seen = seenConceptRows("topic");
      const pendingNew = suggestionsWith("new_concept", "pending");
      return {
        counts: [
          String(seen.length),
          String(topicMentions.filter((m) => m.status === "active").length),
          String(pendingNew.length),
        ],
        groups: [
          { heading: heading("topics", 0), rows: seen },
          { heading: heading("topics", 1), rows: pendingNew.map(suggestionRow) },
        ],
      };
    }
  }
}

function episodeRow(episode: Episode & WithRecord): PortRow {
  return {
    id: episode.id,
    title: episode.summary,
    meta: `${episode.eventTimeRaw ?? "时间不明"} · ${episode.recordId}`,
    detail: episodeDetail(episode),
  };
}

/**
 * 假数据那一份数据口。
 *
 * 它**永远给得出内容**（假数据是静态字节），所以这里没有 `null` 那一条分支 ——
 * 「给不出」归产品默认那份（`UNREADY_DATA_PORT`）。
 */
export const FIXTURE_DATA_PORT: DataPort = {
  boxPage: (view) => boxContent(view),
  recordSource: async (recordId): Promise<RecordSource | null> => {
    const record = RECORD_BY_ID.get(recordId);
    const current = record?.revisions.find((revision) => revision.id === record.currentRevisionId);
    if (record === undefined || current === undefined) return null;
    return {
      recordId,
      recordDate: record.createdAtLocal.slice(0, 10),
      rawText: current.rawText,
      revisionLabel: `v${current.number}`,
    };
  },
  suggestions: () => {
    const rows = SUGGESTIONS.map(suggestionRow);
    const counts: Record<string, number> = {};
    for (const row of rows) counts[row.statusKey] = (counts[row.statusKey] ?? 0) + 1;
    return { counts, total: rows.length, rows };
  },
};

/** 「这一屏是假数据」横幅的措辞 —— 与假数据入口同层，生产接线不引用它。 */
export const FAKE_DATA_BANNER_TEXT =
  "这一屏吃的是顶层那份假数据：整理结果是手写的，不是模型跑出来的，用来看信息架构与交互，" +
  "不能用来判断抽得准不准。真实数据一条都没读，也一条都没写。";
