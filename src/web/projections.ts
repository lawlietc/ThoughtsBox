import {
  BASIS_LABEL,
  CONCEPT_LIFECYCLE_LABEL,
  DERIVED_LIFECYCLE_LABEL,
  ENTITY_LIFECYCLE_LABEL,
  ENTITY_TYPE_LABEL,
  EVENT_TIME_CERTAINTY_LABEL,
  EVENT_TIME_PRECISION_LABEL,
  MENTION_STATUS_LABEL,
  STATUS_LABEL,
  SUGGESTION_LABEL,
  SUGGESTION_STATUS_LABEL,
} from "./ui/labels.ts";
import { boxGroupHeading, COUNT_PLACEHOLDER } from "./projectionPort.ts";
import type {
  BoxPageContent,
  BoxView,
  PortCitation,
  PortDetailBlock,
  PortDetailPair,
  PortRow,
  SuggestionContent,
} from "./projectionPort.ts";
import type {
  DeletePhaseResult,
  EffectiveConceptTargetDto,
  EffectiveEmotionItemDto,
  EffectiveEntityItemDto,
  EffectiveEntityTargetDto,
  EffectiveEvidenceDto,
  EffectiveResultDto,
  EffectiveSuggestionItemDto,
  EffectiveTopicItemDto,
  RecordRow,
} from "../shared/dto.ts";

/**
 * 服务端 DTO → 界面显示量的投影。**纯函数、无 DOM、无 fetch**：
 * 「今天」的日期口径与整理结果的降级文案都在这里，能在 node 里逐条断言
 * （`tests/web-ui3-projections.test.ts`）；渲染对不对仍归渲染证据门（任务书 §九）。
 *
 * 为什么这几件事值得单独一层：`TodayPanel`、`RecordsPanel`、`IngestPanel` 都要
 * 「同一行记录长得一样」，而 `RecordDetail` 的整理结果要把只有 id 数组的
 * `EffectiveResultDto` 翻译成一句人话。两处各写一遍就会开始漂移。
 */

/** 一行记录在列表里的显示量（列表组件只吃这个，不吃 DTO、不取数）。 */
export interface RecordRowView {
  readonly id: string;
  readonly title: string;
  readonly meta: string;
  /** 仅「全部记录」按日分组时使用；盒子 / 搜索列表不填。 */
  readonly group?: string;
}

/**
 * 「今天」按自然日算（〔用户裁定 2026-10-14〕），口径与服务端写入的
 * `created_local_date` 同一个 `YYYY-MM-DD`（本机时区的日历日，不是 UTC 日）。
 */
export function localDay(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 今天的记录 = 本地日历日相等的那些；顺序沿用服务端的「新在前」（created_at_utc desc）。 */
export function filterByLocalDay(
  rows: readonly RecordRow[],
  day: string,
): RecordRow[] {
  return rows.filter((row) => row.created_local_date === day);
}

/**
 * 服务端 `created_at_local` 形如 `2026-10-16T13:04:05.123+08:00`（迁移 0002 的 CHECK 钉住这个形状）。
 * 列表只要「时:分」与「月-日 时:分」两种切片，整串太长会把行挤爆。
 */
export function clockOf(local: string): string {
  return local.slice(11, 16);
}

export function monthDayOf(local: string): string {
  return local.slice(5, 16);
}

/** 首行当前 40 字当标题；超长补省略号（不补的话看起来像被截断的 bug）。 */
export function firstLine(text: string, limit: number): string {
  const line = text.split("\n")[0] ?? "";
  return line.length > limit ? `${line.slice(0, limit)}…` : line;
}

/**
 * 时间线 / 列表里值得打扰用户的状态。普通状态只留在记录详情里，
 * 不让「回看」变成一张待办表。
 */
const ATTENTION_STATUSES: ReadonlySet<string> = new Set([
  "awaiting_privacy_review",
  "preprocessing",
  "processing",
  "failed",
  "needs_reparse",
]);

export function needsAttention(status: string): boolean {
  return ATTENTION_STATUSES.has(status);
}

/** 记录列表按本地自然日分组；输入来自服务端已校验的 `YYYY-MM-DD`。 */
export function dayHeading(localDate: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(localDate);
  if (match === null) return localDate;
  return `${match[1]} 年 ${Number(match[2])} 月 ${Number(match[3])} 日`;
}

/**
 * 记录行的主层元信息：时间始终显示，只有需要行动的状态才露出来。
 * 模式不是这一层的行动信息，留在详情里看。
 */
export function recordListMeta(row: RecordRow): string {
  const time = clockOf(row.created_at_local);
  if (!needsAttention(row.processing_status)) return time;
  return `${time} · ${STATUS_LABEL[row.processing_status] ?? row.processing_status}`;
}

/**
 * 已整理（`processing_status = parsed`）的条数 —— 「今天的东西」唯一敢说的产出量。
 *
 * 为什么只说条数：`RecordRow` 给得出状态，给不出「整理成了哪些情绪/主题/人物」
 * （那是 §六 的可读投影缺口）。说得出条数而说不出内容，就把这一句说出来，
 * 剩下那句由 `NO_READABLE_DATA` 顶上。
 */
export function parsedCount(rows: readonly RecordRow[]): number {
  return rows.filter((row) => row.processing_status === "parsed").length;
}

export function toRowView(row: RecordRow, previewText: string, meta: string): RecordRowView {
  return { id: row.id, title: firstLine(previewText, 40), meta };
}

/**
 * 投影缺字段时的**统一**降级文案（任务书 §5.4 断言 3）。
 * 界面在这里不许印 id：`EffectiveResultDto` 五类提及全是 id 数组（§六），
 * 印出来对用户没有任何信息量，还会把内部主键透出去。
 */
export const NO_READABLE_DATA = "这段还没有可读数据。";

/**
 * 有效结果 → 「类别 + 计数」若干行。服务端只有 id 数组，所以这里只出**数量**，
 * 名字、依据（原话说出口 / 模型推断）、证据区间一律等 PROJ-1 的可读投影。
 */
export function effectiveLines(effective: EffectiveResultDto): readonly (readonly [string, number])[] {
  return [
    ["经历", effective.episodes.length],
    ["念头", effective.thoughts.length],
    ["情绪", effective.emotions.length],
    ["主题", effective.topics.length],
    ["人物与事物", effective.entities.length],
    ["用户修正", effective.overrides.length],
  ];
}

/**
 * 删除结果 → 说给用户的那一句。两个面板都要说，所以写一次。
 *
 * 硬约束：**严禁把阶段 B 失败表述成回滚**。阶段 A 已提交 = 记录确实删掉了，
 * 没完成的只是存储清理；说成「已回滚」是把事实说反。
 */
export function deletePhaseMessage(result: DeletePhaseResult): string {
  return result.phaseB.status === "ok"
    ? "记录删除已提交，存储清理完成。"
    : result.phaseB.status === "pending"
      ? "记录已删除，存储清理待完成——可在上方横幅重试。"
      : "记录删除已提交，但清理任务登记未落盘——系统未能把待办持久化，请使用上方重试入口。";
}

/* ════════════════════════════════════════════════════════════════════
 * M3-PROJ-1：**产品那一份数据口**的映射层 —— 服务端可读投影（`EffectiveResultDto`
 * 的扩集字段）摊成 `DataPort` 的形状（`PortRow` / `BoxPageContent` / `SuggestionContent`）。
 * 取数在 `productPort.ts`，这一层仍是纯函数：不引取数那一层、不发请求、没有本地状态
 * （`tests/web-ui3-projections.test.ts` 那条纯度断言覆盖的就是这个文件）。
 *
 * 与 `fixturePort.ts` 那份的关系：两份实现、同一个口子、同一套标签表。
 * 为什么不共用代码：假数据那一层的类型来自 `fixtures/types.ts`，而产品入口的**静态**
 * import 闭包不许碰 `fixtures/`（UI-5 那条会红的断言）—— 引它等于把假数据本体拖进生产图。
 * 所以这里保证的是「口径一致」（同一个标签表、同一张分组表头、同一条诚实空态），
 * 不是「字节一致」。
 * ════════════════════════════════════════════════════════════════════ */

/** 一条记录的有效结果，连同「它是哪条记录」—— 盒子页要跨记录聚合，日期比主键有用。 */
export interface EffectiveEntry {
  readonly record: RecordRow;
  readonly effective: EffectiveResultDto;
}

function labelOf(table: Readonly<Record<string, string>>, key: string): string {
  return table[key] ?? key;
}

/**
 * 提及来源三选一，图上待遇完全不同，详情必须说清是哪一种。
 * 键集合 == `enums.json` 的 `mention_source_kinds` —— `tests/m3-proj-1-projection.test.ts`
 * 逐键核对：契约加了一档而这里没跟上，测试先红，界面不会静悄悄地显示过期世界。
 */
export const MENTION_SOURCE_PHRASE: Readonly<Record<string, string>> = {
  episode: "经历（只有这一类上图）",
  thought_item: "念头（不上图）",
  record_revision: "原文版本（不上图）",
};

function sourcePhrase(kind: string): string {
  return MENTION_SOURCE_PHRASE[kind] ?? `来源那一档标签表里没有：${kind}`;
}

/**
 * 证据的三种真实情况：有坐标且回锚成功（能点回原文）、坐标缺失、回锚失败。
 * 第三种是契约允许的真实路径（模型给的词面在原文里找不到），界面必须显示出来而不是藏掉。
 *
 * 导出是因为**两处**要说这句话：盒子页的详情栏（`productBoxPage` 摊的字段对）与
 * 记录详情的整理结果（`readableResult` 的行）。两处各写一遍就会开始漂移。
 */
export function evidencePhrase(evidence: EffectiveEvidenceDto | null | undefined): string {
  if (evidence === undefined || evidence === null) return "没有证据 —— 按契约它不得成为有效提及";
  if (evidence.text === "") return "没有证据文本 —— 按契约它不得成为有效提及";
  if (evidence.start === null || evidence.end === null) {
    return `「${evidence.text}」—— 服务端没给原文坐标，这一条点不回原文`;
  }
  if (!evidence.anchored) return `「${evidence.text}」—— 回锚失败：这句在原文里找不到`;
  return `「${evidence.text}」（原文第 ${evidence.start}–${evidence.end} 字）`;
}

/** 三张提及表在详情里的共同形状（情绪多强度两项，实体多 role）。 */
interface NormalizedMention {
  readonly id: string;
  readonly labelSaid: string;
  readonly basis: string;
  readonly status: string;
  readonly sourceKind: string;
  readonly evidence: EffectiveEvidenceDto;
  readonly recordId: string;
  readonly recordDate: string;
  readonly intensity?: number | null;
  readonly modifiedByUser?: boolean;
  readonly role?: string | null;
}

/** 一组字段对。写成函数是为了让条件追加的那些行仍推断成二元组（内联数组字面量会退化成 `string[]`）。 */
function pair(key: string, value: string): PortDetailPair {
  return [key, value];
}

function citationOf(
  recordId: string,
  recordDate: string,
  evidence: EffectiveEvidenceDto,
): PortCitation {
  return {
    recordId,
    recordDate,
    evidence: {
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
  fields: readonly PortDetailPair[],
  citation?: PortCitation,
): PortDetailBlock {
  return citation === undefined
    ? { id, kind: "fields", title, fields }
    : { id, kind: "fields", title, fields, citation };
}

function mentionDetail(mention: NormalizedMention, index: number): PortDetailBlock {
  const fields: PortDetailPair[] = [pair("来源", sourcePhrase(mention.sourceKind))];
  if (mention.intensity !== undefined || mention.modifiedByUser !== undefined) {
    fields.push(
      pair(
        "强度",
        `${mention.intensity ?? "没给"}${mention.modifiedByUser === true ? "（你改过的，不是模型给的）" : ""}`,
      ),
    );
  }
  if (mention.role !== undefined) {
    fields.push(pair("角色", mention.role ?? "没写"));
  }
  fields.push(pair("记录", mention.recordDate));
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
    citation: citationOf(mention.recordId, mention.recordDate, mention.evidence),
  };
}

function toConceptMention(
  item: EffectiveEmotionItemDto | EffectiveTopicItemDto,
  recordId: string,
  recordDate: string,
  withIntensity: boolean,
): NormalizedMention {
  const base: NormalizedMention = {
    id: item.id,
    labelSaid: item.labelSaid,
    basis: item.basis,
    status: item.status,
    sourceKind: item.source.kind,
    evidence: item.evidence,
    recordId,
    recordDate,
  };
  return withIntensity && "intensity" in item
    ? {
        ...base,
        intensity: item.intensity,
        modifiedByUser: item.intensityModifiedByUser === true,
      }
    : base;
}

function toEntityMention(
  item: EffectiveEntityItemDto,
  recordId: string,
  recordDate: string,
): NormalizedMention {
  return {
    id: item.id,
    labelSaid: item.labelSaid,
    basis: item.basis,
    status: item.status,
    sourceKind: item.source.kind,
    evidence: item.evidence,
    recordId,
    recordDate,
    role: item.role,
  };
}

/** 把各条记录返回的连接表收成一张按主键查的总表（跨记录聚合就靠它）。 */
function indexById<T extends { readonly id: string }>(
  entries: readonly EffectiveEntry[],
  pick: (effective: EffectiveResultDto) => readonly T[] | undefined,
): Map<string, T> {
  const map = new Map<string, T>();
  for (const entry of entries) {
    for (const item of pick(entry.effective) ?? []) map.set(item.id, item);
  }
  return map;
}

function mentionsGrouped<T>(
  entries: readonly EffectiveEntry[],
  pick: (effective: EffectiveResultDto) => readonly T[] | undefined,
  keyOf: (item: T) => string,
  toItem: (item: T, recordId: string, recordDate: string) => NormalizedMention,
): Map<string, NormalizedMention[]> {
  const grouped = new Map<string, NormalizedMention[]>();
  for (const entry of entries) {
    const recordId = entry.record.id;
    const date = entry.record.created_local_date;
    for (const item of pick(entry.effective) ?? []) {
      const key = keyOf(item);
      const list = grouped.get(key);
      if (list === undefined) grouped.set(key, [toItem(item, recordId, date)]);
      else list.push(toItem(item, recordId, date));
    }
  }
  return grouped;
}

/** 概念行（情绪页与主题页同一份实现：底层同一份，入口分开）。 */
function conceptRows(
  entries: readonly EffectiveEntry[],
  kind: "emotion" | "topic",
): readonly PortRow[] {
  const targets = indexById(entries, (effective) => effective.conceptTargets);
  const grouped = mentionsGrouped(
    entries,
    (effective) => (kind === "emotion" ? effective.emotionItems : effective.topicItems),
    (item) => item.conceptId,
    (item, recordId, date) => toConceptMention(item, recordId, date, kind === "emotion"),
  );
  return [...grouped.entries()]
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .map(([conceptId, mentions]) => {
      const target: EffectiveConceptTargetDto | undefined = targets.get(conceptId);
      return {
        id: conceptId,
        title: target?.canonicalName ?? `（标准名缺失：这条的连接对象没被返回，词面「${mentions[0]?.labelSaid ?? ""}」）`,
        meta: `${mentions.length} 次提及 · 最近词面「${mentions[0]?.labelSaid ?? ""}」`,
        weight: mentions.length,
        detail: [
          fieldsBlock(`${conceptId}-overview`, "概念", [
            pair("标准名", target?.canonicalName ?? "服务端没返回这一条的概念行"),
            pair(
              "生命周期",
              target === undefined ? "—" : labelOf(CONCEPT_LIFECYCLE_LABEL, target.lifecycleStatus),
            ),
          ]),
          ...mentions.map((mention, index) => mentionDetail(mention, index)),
        ],
      };
    });
}

function suggestionRows(
  entries: readonly EffectiveEntry[],
): readonly (PortRow & { readonly statusKey: string; readonly kindKey: string })[] {
  const seen = new Map<string, EffectiveSuggestionItemDto & { readonly recordDate: string }>();
  for (const entry of entries) {
    for (const item of entry.effective.suggestionItems ?? []) {
      if (seen.has(item.id)) continue;
      seen.set(item.id, { ...item, recordDate: entry.record.created_local_date });
    }
  }
  return [...seen.values()].map((item) => ({
    id: item.id,
    statusKey: item.status,
    kindKey: item.kind,
    title: `${labelOf(SUGGESTION_LABEL, item.kind)}：${item.subjectTerm}`,
    meta: `${labelOf(SUGGESTION_STATUS_LABEL, item.status)} · 记录 ${item.recordDate}`,
    detail: [
      fieldsBlock(item.id, "这条建议", [
        pair("建议类型", labelOf(SUGGESTION_LABEL, item.kind)),
        pair("状态", labelOf(SUGGESTION_STATUS_LABEL, item.status)),
        pair("对象词面", item.subjectTerm),
        pair("为什么在这儿", item.displayNote ?? "服务端没写说明"),
        pair("证据", item.evidence === null ? "这条建议没有证据文本（当前写路径一律留空）" : item.evidence),
        pair("来自记录", item.recordDate),
      ]),
    ],
  }));
}

/** 只有精确到「日」的经历才真的排得进按时间回看那条线（与假数据那一侧同一条规则）。 */
function timelineEligible(item: { readonly eventTimePrecision: string }): boolean {
  return item.eventTimePrecision === "day";
}

function episodeRows(
  entries: readonly EffectiveEntry[],
): readonly { readonly row: PortRow; readonly eligible: boolean }[] {
  const out: { row: PortRow; eligible: boolean }[] = [];
  for (const entry of entries) {
    const date = entry.record.created_local_date;
    for (const item of entry.effective.episodeItems ?? []) {
      out.push({
        eligible: timelineEligible(item),
        row: {
          id: item.id,
          title: item.summary,
          meta: `${labelOf(EVENT_TIME_PRECISION_LABEL, item.eventTimePrecision)} · 记录 ${date}`,
          detail: [
            fieldsBlock(
              item.id,
              "这条经历",
              [
                pair("摘要", item.summary),
                pair("事件时间（原文写的）", item.eventTimeRaw ?? "原文没写时间"),
                pair("时间精度", labelOf(EVENT_TIME_PRECISION_LABEL, item.eventTimePrecision)),
                pair("确定性", labelOf(EVENT_TIME_CERTAINTY_LABEL, item.eventTimeCertainty)),
                pair("生命周期", labelOf(DERIVED_LIFECYCLE_LABEL, item.lifecycleStatus)),
                pair("来源", item.originType),
                pair("来自记录", date),
              ],
              citationOf(entry.record.id, date, item.evidence),
            ),
          ],
        },
      });
    }
  }
  return out;
}

/** 念头上挂着的标签（来源是 thought_item 的提及）—— 「不上图的那些」唯一的家。 */
function mentionsOnThought(entries: readonly EffectiveEntry[], thoughtId: string): NormalizedMention[] {
  const out: NormalizedMention[] = [];
  for (const entry of entries) {
    const date = entry.record.created_local_date;
    for (const item of entry.effective.emotionItems ?? []) {
      if (item.source.kind === "thought_item" && item.source.containerId === thoughtId) {
        out.push(toConceptMention(item, entry.record.id, date, true));
      }
    }
    for (const item of entry.effective.topicItems ?? []) {
      if (item.source.kind === "thought_item" && item.source.containerId === thoughtId) {
        out.push(toConceptMention(item, entry.record.id, date, false));
      }
    }
  }
  return out;
}

function thoughtRows(entries: readonly EffectiveEntry[]): readonly PortRow[] {
  const out: PortRow[] = [];
  for (const entry of entries) {
    const date = entry.record.created_local_date;
    for (const item of entry.effective.thoughtItemItems ?? []) {
      const labels = mentionsOnThought(entries, item.id);
      const fields: PortDetailPair[] = [
        pair("内容", item.text),
        pair("生命周期", labelOf(DERIVED_LIFECYCLE_LABEL, item.lifecycleStatus)),
        pair("来源", item.originType),
        pair("来自记录", date),
      ];
      if (labels.length > 0) {
        fields.push(pair("不上图", "来源是念头的提及既不生成边、也不生成影子节点 —— 这一页是它们唯一的家"));
      }
      out.push({
        id: item.id,
        title: item.text,
        meta: `${labels.length} 个标签 · 记录 ${date}`,
        detail: [
          fieldsBlock(item.id, "这个念头", fields, citationOf(entry.record.id, date, item.evidence)),
          ...labels.map((mention, index) => mentionDetail(mention, index)),
        ],
      });
    }
  }
  return out;
}

function entityRows(entries: readonly EffectiveEntry[], lifecycle: string): readonly PortRow[] {
  const targets = indexById(entries, (effective) => effective.entityTargets);
  const grouped = mentionsGrouped(
    entries,
    (effective) => effective.entityItems,
    (item) => item.entityId,
    (item, recordId, date) => toEntityMention(item, recordId, date),
  );
  const out: PortRow[] = [];
  for (const [entityId, mentions] of grouped) {
    const target: EffectiveEntityTargetDto | undefined = targets.get(entityId);
    if (target === undefined || target.lifecycleStatus !== lifecycle) continue;
    out.push({
      id: entityId,
      title: target.displayName,
      meta: `${labelOf(ENTITY_TYPE_LABEL, target.entityType)} · 提到 ${mentions.length} 次`,
      detail: [
        fieldsBlock(`${entityId}-overview`, "这个实体", [
          pair("显示名", target.displayName),
          pair("标准名", target.canonicalName),
          pair("类型", labelOf(ENTITY_TYPE_LABEL, target.entityType)),
          pair("生命周期", labelOf(ENTITY_LIFECYCLE_LABEL, target.lifecycleStatus)),
          pair("提到的次数", String(mentions.length)),
        ]),
        ...mentions.map((mention, index) => mentionDetail(mention, index)),
      ],
    });
  }
  return out.sort((a, b) => b.meta.localeCompare(a.meta));
}

/** 有效提及数（`status = active` 的那些）—— 情绪页与主题页的第二个计数位都是它。 */
function activeMentions(entries: readonly EffectiveEntry[], kind: "emotion" | "topic"): number {
  let count = 0;
  for (const entry of entries) {
    const items = kind === "emotion" ? entry.effective.emotionItems : entry.effective.topicItems;
    count += (items ?? []).filter((item) => item.status === "active").length;
  }
  return count;
}

/** 来源不是经历的提及 = 不上图的那些（§3.2.4），情绪页第四个计数位。 */
function offGraphMentions(entries: readonly EffectiveEntry[]): number {
  let count = 0;
  for (const entry of entries) {
    for (const item of entry.effective.emotionItems ?? []) {
      if (item.source.kind !== "episode") count += 1;
    }
  }
  return count;
}

/**
 * 真投影 → 盒子某一页的内容。
 *
 * 计数位与 `BoxShape.counts` 一一对应；**答不出的那一格填 `COUNT_PLACEHOLDER`**，
 * 不填 0 —— 「词表里但从未出现」要的是全词表清单，这一层给不出那份清单，
 * 数出 0 就是把「不知道」说成「确实没有」。那一组因此留空行 —— 答不出来的那一格
 * 不该画成用户看得见的内容。
 */
export function productBoxPage(entries: readonly EffectiveEntry[], view: BoxView): BoxPageContent {
  const groups = (index: number) => boxGroupHeading(view, index);
  switch (view) {
    case "emotions": {
      const seen = conceptRows(entries, "emotion");
      return {
        counts: [
          String(seen.length),
          COUNT_PLACEHOLDER,
          String(activeMentions(entries, "emotion")),
          String(offGraphMentions(entries)),
        ],
        groups: [
          { heading: groups(0), rows: seen },
          { heading: groups(1), rows: [] },
        ],
      };
    }
    case "episodes": {
      const rows = episodeRows(entries);
      const eligible = rows.filter((entry) => entry.eligible).map((entry) => entry.row);
      const rest = rows.filter((entry) => !entry.eligible).map((entry) => entry.row);
      return {
        counts: [String(rows.length), String(eligible.length), String(rest.length)],
        groups: [
          { heading: groups(0), rows: eligible },
          { heading: groups(1), rows: rest },
        ],
      };
    }
    case "thoughts": {
      const rows = thoughtRows(entries);
      const labeled = rows.filter((row) => mentionsOnThought(entries, row.id).length > 0);
      return {
        counts: [String(rows.length), String(labeled.length), String(rows.length - labeled.length)],
        groups: [
          { heading: groups(0), rows: labeled },
          {
            heading: groups(1),
            rows: rows.filter((row) => mentionsOnThought(entries, row.id).length === 0),
          },
        ],
      };
    }
    case "entities": {
      const active = entityRows(entries, "active");
      const provisional = entityRows(entries, "provisional");
      const archived = entityRows(entries, "archived");
      let mentionCount = 0;
      for (const entry of entries) mentionCount += (entry.effective.entityItems ?? []).length;
      const candidates = suggestionsOfKind(entries, "possibly_same_as");
      return {
        counts: [String(active.length), String(provisional.length), String(archived.length), String(mentionCount)],
        groups: [
          { heading: groups(0), rows: active },
          { heading: groups(1), rows: provisional },
          { heading: groups(2), rows: archived },
          { heading: groups(3), rows: candidates },
        ],
      };
    }
    case "topics": {
      const seen = conceptRows(entries, "topic");
      const pendingNew = suggestionsOfKind(entries, "new_concept");
      return {
        counts: [String(seen.length), String(activeMentions(entries, "topic")), String(pendingNew.length)],
        groups: [
          { heading: groups(0), rows: seen },
          { heading: groups(1), rows: pendingNew },
        ],
      };
    }
  }
}

/**
 * 按建议种类取行（实体页的「疑似同一实体」候选、主题页的「新主题候选」都用它）。
 * 按 `kindKey` 筛而不是按标题前缀筛 —— 标题是给人看的措辞，措辞一改筛子就静默失效。
 */
function suggestionsOfKind(entries: readonly EffectiveEntry[], kind: string): readonly PortRow[] {
  return suggestionRows(entries).filter((row) => row.kindKey === kind);
}

/** 真投影 → 「待确认」页的内容。 */
export function productSuggestions(entries: readonly EffectiveEntry[]): SuggestionContent {
  const rows = suggestionRows(entries);
  const counts: Record<string, number> = {};
  for (const row of rows) counts[row.statusKey] = (counts[row.statusKey] ?? 0) + 1;
  return { counts, total: rows.length, rows };
}

/* ── 记录详情「整理结果」那一块的可读行 ─────────────────────────── */

/**
 * 一条可读结果：主标题 + 一行元信息 + 可点回原文的证据。
 *
 * `evidence` 原样带着（含 `start`/`end`），因为「点证据回原文并高亮」这一跳要的就是坐标；
 * 界面不许自己按词面去 `indexOf` 猜位置 —— 猜中的是另一处同样的字。
 */
export interface ReadableResultLine {
  readonly id: string;
  readonly title: string;
  readonly meta: string;
  readonly evidence: EffectiveEvidenceDto;
}

export interface ReadableResultGroup {
  /** 类别名，与 `effectiveLines` 用的是同一批词（列表与详情得说同一种话）。 */
  readonly category: string;
  readonly lines: readonly ReadableResultLine[];
}

/**
 * 有效结果 → 分组的可读行（空的类别不出现 —— 它们的数量在 `effectiveLines` 那一栏已经说了）。
 *
 * 词面一律带标准名一起显示（「当时写的词」→「词表里的名字」），因为这两件不是一回事：
 * 前者是证据回溯的锚点，后者是聚合的键。只印其中一个，用户就看不出模型改写了什么。
 */
export function readableResult(effective: EffectiveResultDto): readonly ReadableResultGroup[] {
  const concepts = new Map((effective.conceptTargets ?? []).map((target) => [target.id, target]));
  const entities = new Map((effective.entityTargets ?? []).map((target) => [target.id, target]));
  const nameOf = (id: string): string => concepts.get(id)?.canonicalName ?? "（这一条没返回标准名）";
  const groups: ReadableResultGroup[] = [];
  const push = (category: string, lines: readonly ReadableResultLine[]): void => {
    if (lines.length > 0) groups.push({ category, lines });
  };

  push(
    "经历",
    (effective.episodeItems ?? []).map((item) => ({
      id: item.id,
      title: item.summary,
      meta: `时间「${item.eventTimeRaw ?? "原文没写"}」· 精度${labelOf(EVENT_TIME_PRECISION_LABEL, item.eventTimePrecision)} · ${labelOf(DERIVED_LIFECYCLE_LABEL, item.lifecycleStatus)} · 来源 ${item.originType}`,
      evidence: item.evidence,
    })),
  );
  push(
    "念头",
    (effective.thoughtItemItems ?? []).map((item) => ({
      id: item.id,
      title: item.text,
      meta: `${labelOf(DERIVED_LIFECYCLE_LABEL, item.lifecycleStatus)} · 来源 ${item.originType}`,
      evidence: item.evidence,
    })),
  );
  push(
    "情绪",
    (effective.emotionItems ?? []).map((item) => ({
      id: item.id,
      title: `「${item.labelSaid}」→ ${nameOf(item.conceptId)}`,
      meta: `${labelOf(BASIS_LABEL, item.basis)} · ${labelOf(MENTION_STATUS_LABEL, item.status)} · 强度 ${item.intensity ?? "没给"}${item.intensityModifiedByUser === true ? "（你改过的）" : ""} · 挂在${sourcePhrase(item.source.kind)}`,
      evidence: item.evidence,
    })),
  );
  push(
    "主题",
    (effective.topicItems ?? []).map((item) => ({
      id: item.id,
      title: `「${item.labelSaid}」→ ${nameOf(item.conceptId)}`,
      meta: `${labelOf(BASIS_LABEL, item.basis)} · ${labelOf(MENTION_STATUS_LABEL, item.status)} · 挂在${sourcePhrase(item.source.kind)}`,
      evidence: item.evidence,
    })),
  );
  push(
    "人物与事物",
    (effective.entityItems ?? []).map((item) => ({
      id: item.id,
      title: `「${item.labelSaid}」→ ${entities.get(item.entityId)?.displayName ?? "（这一条没返回显示名）"}`,
      meta: `${labelOf(BASIS_LABEL, item.basis)} · ${labelOf(MENTION_STATUS_LABEL, item.status)}${item.role === null ? "" : ` · 角色 ${item.role}`} · 挂在${sourcePhrase(item.source.kind)}`,
      evidence: item.evidence,
    })),
  );
  return groups;
}
