/**
 * 证据回锚与 `evidence_repair` 承接（D11）。
 *
 * 契约取值：Schema §7.6〔冻结·B9〕逐字五步、§3.14〔K-23〕、§3.17〔U-3 已批准的
 * `evidence_repair` 种类〕、指令 §7.4/§9.1；T-27。
 *
 * 本模块解决的是 `contract.ts` 那道门**故意不做**的一件事：它把全部失败一次性收集后
 * 整批抛出（ADR-006 要求「一次调用就知道坏在哪」），于是「部分条目证据核验不过」与
 * 「整批都不过」在它的返回值里是同一种失败。§7.6.4 要求这两者分流：
 *
 *   · 整批失败 ⇒ run `failed` + `error_kind='evidence_unmapped'`；
 *   · 部分失败 ⇒ run 仍 `succeeded`，**失败的那几条**不得成为有效 Mention，
 *     逐条落 `Suggestion(kind=evidence_repair, endpoint_a=来源 revision, subject_term=候选词面)`，
 *     通过的条目照常写 Mention（§7.6.3「核验通过 ⇒ 写 mention」）。
 *
 * 所以这里做的是**逐条**回锚：区间在发送文本里定位 → 映射回原文坐标 → 按原文坐标切片
 * 与模型给出的切片逐字核验。任何一步不过就产出一条修复建议的输入，绝不「勉强写入」
 * （指令 §9.4 末条）。偏移单位恒为 JavaScript UTF-16 code unit（§7.6.5）。
 *
 * 入库的 `evidence_start/end` 一律是**原文坐标**（K-23）：脱敏文本里的偏移永不得写入。
 */

import { newId } from "../../shared/contracts/ids.ts";
import type { Database } from "../db/adapter.ts";
import { resolveEvidenceToOriginal, type RedactionMap } from "../privacy/redaction.ts";
import type { ExtractedEventTime, StructuredOutput, ValidatedEvidence } from "./contract.ts";

/**
 * 证据类规则标识——与 `contract.ts` 内部那份**同源**（同为 §7.6 的两条），
 * 逐值对账断言写在 `tests/m2-evidence.test.ts`：两侧不得各说各话。
 */
export const EVIDENCE_RULES = ["evidence_traceable", "evidence_mappable_to_original"] as const;

export type EvidenceRule = (typeof EVIDENCE_RULES)[number];

/** 建议种类取自 0003 `suggestion.kind` 的封闭集；本模块只用到 `evidence_repair`。 */
export const EVIDENCE_REPAIR_KIND = "evidence_repair";

export interface EvidenceAnchorContext {
  /** 实际发送给模型的那份文本（云端=已确认载荷，本地=原文）。 */
  readonly sentText: string;
  /** 该 revision 的 `raw_text`：入库证据永远锚它。 */
  readonly rawText: string;
  /** 原文↔脱敏坐标映射；本地路径没有映射（两份文本同一份）。 */
  readonly redactionMap?: RedactionMap;
}

export type AnchorOutcome =
  | { readonly ok: true; readonly anchor: ValidatedEvidence }
  | { readonly ok: false; readonly rule: EvidenceRule; readonly detail: string };

/** 失败条目的定位信息：`subject_term` 即 §3.17 的「候选词面」，无词面类为空串。 */
export interface EvidenceFailure {
  readonly collection: "episodes" | "thoughts" | "emotions" | "topics" | "entities";
  readonly index: number;
  readonly subjectTerm: string;
  readonly rule: EvidenceRule;
  readonly detail: string;
}

export interface PlannedEpisode extends ValidatedEvidence {
  readonly summary: string;
  readonly eventTime: ExtractedEventTime;
}

export interface PlannedThought extends ValidatedEvidence {
  readonly text: string;
}

export interface PlannedLabel extends ValidatedEvidence {
  readonly collection: "emotions" | "topics" | "entities";
  readonly labelSaid: string;
  readonly candidateConceptId: string | null;
  readonly basis: string;
}

export interface ExtractionPlan {
  readonly episodes: PlannedEpisode[];
  readonly thoughts: PlannedThought[];
  readonly labels: PlannedLabel[];
  readonly failures: EvidenceFailure[];
  /** 整批失败判据：有条目且**没有一条**通过——§7.6.4 的「全批失败场景」。 */
  readonly whollyFailed: boolean;
}

/**
 * 单条证据的回锚。判定顺序与 `contract.ts` 的 `anchor()` 逐字同构：
 * 先在发送文本里定位（`evidence_traceable`），有映射时再映射回原文并逐字核验
 * （`evidence_mappable_to_original`）。越界与核验不过都归后者——
 * §7.6.2 把「映射不出」与「切片对不上」写成同一道门。
 */
export function anchorEvidence(evidence: string, context: EvidenceAnchorContext): AnchorOutcome {
  const start = context.sentText.indexOf(evidence);
  if (start < 0) {
    return { ok: false, rule: "evidence_traceable", detail: "证据无法在实际发送的输入文本中逐字回溯" };
  }
  const end = start + evidence.length;
  const map = context.redactionMap;
  if (map !== undefined) {
    const mapped = resolveEvidenceToOriginal(map, context.rawText, context.sentText, start, end);
    if (mapped === null) {
      return {
        ok: false,
        rule: "evidence_mappable_to_original",
        detail: "证据区间越界或映射不出原文坐标",
      };
    }
    return {
      ok: true,
      anchor: {
        evidenceText: mapped.originalText,
        evidenceStart: mapped.originalStart,
        evidenceEnd: mapped.originalEnd,
        sentSlice: mapped.redactedSlice,
      },
    };
  }
  return {
    ok: true,
    anchor: {
      evidenceText: context.rawText.slice(start, end),
      evidenceStart: start,
      evidenceEnd: end,
      sentSlice: context.sentText.slice(start, end),
    },
  };
}

/**
 * 逐条分流：通过的进写入集，不过的进修复建议集。
 * 这里**只判证据**——其它业务规则（占位符、候选 ID、实体依据、时间相容）已由
 * `validateBusiness` 整批放行才会走到这一步（它抛出的 `evidence_unmapped` 类别
 * 按 `contract.ts` 的归桶规则保证「坏的只有证据类」）。
 */
export function planEvidence(output: StructuredOutput, context: EvidenceAnchorContext): ExtractionPlan {
  const episodes: PlannedEpisode[] = [];
  const thoughts: PlannedThought[] = [];
  const labels: PlannedLabel[] = [];
  const failures: EvidenceFailure[] = [];

  const record = (
    collection: EvidenceFailure["collection"],
    index: number,
    subjectTerm: string,
    outcome: AnchorOutcome,
  ): ValidatedEvidence | null => {
    if (outcome.ok) return outcome.anchor;
    failures.push({ collection, index, subjectTerm, rule: outcome.rule, detail: outcome.detail });
    return null;
  };

  output.episodes.forEach((episode, index) => {
    const anchored = record("episodes", index, "", anchorEvidence(episode.evidence, context));
    if (anchored !== null) {
      episodes.push({ ...anchored, summary: episode.summary, eventTime: episode.eventTime });
    }
  });

  output.thoughts.forEach((thought, index) => {
    const anchored = record("thoughts", index, "", anchorEvidence(thought.evidence, context));
    if (anchored !== null) thoughts.push({ ...anchored, text: thought.text });
  });

  for (const collection of ["emotions", "topics", "entities"] as const) {
    output[collection].forEach((label, index) => {
      const anchored = record(collection, index, label.labelSaid, anchorEvidence(label.evidence, context));
      if (anchored !== null) {
        labels.push({
          ...anchored,
          collection,
          labelSaid: label.labelSaid,
          candidateConceptId: label.candidateConceptId,
          basis: label.basis,
        });
      }
    });
  }

  const counted = episodes.length + thoughts.length + labels.length;
  return { episodes, thoughts, labels, failures, whollyFailed: counted === 0 && failures.length > 0 };
}

/**
 * 落一条 `evidence_repair` 建议（§7.6.4）。
 *
 * 去重同时守两个键：表级 `UNIQUE(kind, relation_type, endpoint_a, endpoint_b)`
 * 与部分唯一索引 `ux_sug_term(kind, endpoint_a, subject_term)`（§3.17）。
 * 无词面类（Episode/ThoughtItem 的证据坏）`subject_term` 取空串哨兵，于是同一 revision
 * 的多条同类失败**天然并成一轮**——那正是 P5「禁可空键列」选择的表示方式，
 * 第二次写入只更新时间戳而不新增行。
 *
 * 建议**不是**有效提及：修复完成并经用户确认前不得成为 Mention（§7.6.4 用户裁决补充、U-3）。
 */
export function writeEvidenceRepairSuggestion(
  db: Database,
  input: {
    readonly parseRunId: string;
    readonly sourceRevisionId: string;
    readonly failure: EvidenceFailure;
    readonly now: string;
  },
): string {
  const failure = input.failure;
  const existing = db
    .prepare(
      `select id from suggestion
        where kind = ? and endpoint_a = ? and subject_term = ?`,
    )
    .get(EVIDENCE_REPAIR_KIND, input.sourceRevisionId, failure.subjectTerm) as { id: string } | undefined;
  if (existing !== undefined) {
    db.prepare(`update suggestion set updated_at_utc = ? where id = ?`).run(input.now, existing.id);
    return existing.id;
  }
  const id = newId("suggestion");
  db.prepare(
    `insert into suggestion
       (id, kind, relation_type, endpoint_a, endpoint_b, subject_term, status, reason_code,
        display_note, parse_run_id, created_at_utc, updated_at_utc)
     values (?, ?, '', ?, '', ?, 'pending', '', ?, ?, ?, ?)`,
  ).run(
    id,
    EVIDENCE_REPAIR_KIND,
    input.sourceRevisionId,
    failure.subjectTerm,
    // 展示用说明只写规则标识与内部定位，永不写原文/证据文本（指令 §11.2、§3.4 B6）。
    `${failure.rule}:${failure.collection}[${failure.index}]`,
    input.parseRunId,
    input.now,
    input.now,
  );
  return id;
}
