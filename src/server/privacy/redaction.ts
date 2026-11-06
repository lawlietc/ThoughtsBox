import { createHash, randomBytes } from "node:crypto";

import { loadEnums } from "../../shared/contracts/load.ts";
import type { Database } from "../db/adapter.ts";
import type { JsonObject } from "./manifest.ts";
import { findFormatCandidates, FORMAT_REDACTION_KINDS } from "./rules.ts";
import { isEntityStopTerm } from "./entityStopTerms.ts";

/**
 * 规则脱敏与原文↔脱敏文本的区间映射（M2-3 / D7）。
 *
 * 上游取值（逐条对应，不自行发明）：
 * - Spec §5.1.4 / §6.2：本地预处理做「已知实体别名替换」+「手机号、邮箱等规则脱敏」；
 *   未知敏感人名不保证能自动识别；脱敏标识映射只保留在本地，必要时按单次请求生成占位符。
 * - Schema §7.6〔冻结·B9〕：脱敏替换会改变文本长度，模型给出的偏移是**脱敏坐标**，
 *   入库前必须经区间映射换回原文坐标，并按原文坐标切片与返回文本**逐字核验**。
 * - Schema K-23：偏移一律锚定明确 RecordRevision 的 `raw_text`，单位固定为
 *   JavaScript UTF-16 code unit（代理对被算作 2，不是码点计数）。
 * - Schema §3.6：`redacted_sha256` 保证映射与载荷一致性；映射本身存 `pipeline_manifest.redactionMap`，
 *   仅本地、永不上传。
 *
 * 本模块只读原文、只产出新文本与映射，**不写任何表**（禁区：脱敏后的文本不得回写原始记录）。
 */

/**
 * 脱敏策略版本：进 `cloud_send_grant.policy_version` 与 `pipeline_manifest.redaction`。
 * 策略字面量或规则集合任何改变都必须升版——K-17 的「策略变化即旧授权不适用」靠这个值成立。
 *
 * 升版判定只看**替换集合**：规则集合、实体匹配优先级、重叠消解规则、占位符格式，任一改变即升版。
 * `RedactionSpan.source`（M6-0F）是**元数据**——它记录某一处是被哪一层遮的，不改变哪些区间被替换，
 * 因此脱敏文本与 `payload_sha256` 逐字不变、加它不升版，存量 `cloud_send_grant` 继续有效（草案 §三）。
 */
export const REDACTION_POLICY_VERSION = "rules-v2";

/**
 * 本地模型辅助档的策略版本（M9-3 / 执行准则 §五）。
 *
 * 升版理由不是「多了一层来源标记」而是**替换集合真的变了**：LLM 候选会把规则与实体记忆
 * 都没遮到的区间遮掉，同一原文的脱敏文本与 `payload_sha256` 随之不同。所以它与 `rules-v1`
 * 互不命中，`rules-v1` 上签发的授权对本档不适用，反之亦然（K-17）。
 */
export const LOCAL_LLM_POLICY_VERSION = "rules+local_llm-v2";

/**
 * 原文发送授权的策略版本（M6-0D / 0D 草案 §三）：语义是「发送原文这一行为本身的契约版本」。
 * 与 `REDACTION_POLICY_VERSION` 并列放在这里的理由：两条轨道靠 policy_version 互不命中，
 * 就近摆放让「准备给规则集升版」的人一眼看到还有另一条轨道存在。
 *
 * 它**不随规则集变化**：原文发送不经过脱敏层，规则升版不该让既有的原文授权一起失效
 * （那是语义错误，0D 草案 §四 的失效表）。只有「原文发送本身引入新的告知或确认步骤」时
 * 才升到 `raw-v2`。
 */
export const RAW_SEND_POLICY_VERSION = "raw-v1";

/**
 * 规则类占位符的取值集合（L0，2026-11-04 升 v2）。
 *
 * 只收「与语言无关、按格式判定」的东西：手机号、邮箱、身份证号、银行卡号、密钥/token。
 * 姓名/地名/机构名**不在这里**——那是 L2 本机模型的事。
 * CDK/兑换码本轮不做（PD-7）；遇到时没有任何一层会遮它。
 */
export const RULE_REDACTION_KINDS = FORMAT_REDACTION_KINDS;
export type RuleRedactionKind = (typeof RULE_REDACTION_KINDS)[number];

/** 实体类占位符的 kind 直接取 enums.json 的封闭 `entity_types`，不另立名称。 */
export const ENTITY_REDACTION_KINDS: readonly string[] = loadEnums().entity_types;

/**
 * 语义层（L1 词表 + L2 本机模型）只产出这三类（2026-11-04 裁决）。
 * `work` / `product` / `activity` / `event` / `other` 一律不遮；
 * `entity_types` 的八值全集仍保留给旧 map 回读（`parseRedactionMap`）。
 */
export const SEMANTIC_REDACTION_KINDS = ["person", "place", "organization"] as const;
export type SemanticRedactionKind = (typeof SEMANTIC_REDACTION_KINDS)[number];

/** 全部合法 kind：五个规则类别 + 七个实体类型（封闭集，`closed_set_rule`）。 */
export const REDACTION_KINDS: readonly string[] = [...RULE_REDACTION_KINDS, ...ENTITY_REDACTION_KINDS];

export function isRedactionKind(value: string): boolean {
  return REDACTION_KINDS.includes(value);
}

/**
 * 一处遮蔽的**来源层**（M6-0F / 草案 §二，4 值封闭集）。
 *
 * 取值域留在本文件、与 `REDACTION_KINDS` 同级，**不进 `enums.json`**（草案 §四末条）：
 * `enumFileSchema` 是 `.strict()`，新增顶层键会被拒；一旦塞进 enums，本次改动就从
 * 「加元数据」升级为「改枚举契约」，性质变了。
 *
 * - `rule`：手机号 / 邮箱正则，与具体用户无关。
 * - `entity_memory`：`collectKnownEntities()` 命中的本机实体/别名记忆，**包括**此前
 *   「以后也隐藏」落下的 provisional 实体——它们同样走 entity 通道。
 * - `local_llm`：本地模型辅助脱敏（M9-3 起由 `extraCandidates` 产出，M9-4c 接进 op6 预览）。
 * - `user_confirmed`：**占位值，本阶段不产出**。由阶段 1 预览里的「逐处标记」交互产出，
 *   与 `entity_memory` 的区别是「只对这一次」还是「已持久化」。
 */
export const REDACTION_SOURCES = ["rule", "entity_memory", "local_llm", "user_confirmed"] as const;
export type RedactionSource = (typeof REDACTION_SOURCES)[number];

/** 入参按 `unknown`：来源值的真实出处是库里的 manifest 文本，编译期形状不作数。 */
export function isRedactionSource(value: unknown): value is RedactionSource {
  return typeof value === "string" && (REDACTION_SOURCES as readonly string[]).includes(value);
}

/** 单次请求占位符的一次性随机量：跨请求不稳定，避免关联暴露（Spec §6.2）。 */
function newNonce(): string {
  return randomBytes(3).toString("hex");
}

export interface KnownEntity {
  readonly entityId: string;
  readonly entityType: string;
  /** 该实体在原文中可能被写出的全部字面形式：标准名、展示名与别名（逐字，不做大小写折叠）。 */
  readonly terms: readonly string[];
  /** 以下三项是可选的：测试夹具可以只给前三个字段，行为按「放行」处理（旧夹具兼容）。 */
  readonly lifecycleStatus?: string;
  readonly originType?: string;
  /** 这个实体是否至少有一条 `entity_mention(status='active', basis='explicit')`。 */
  readonly hasExplicitActiveMention?: boolean;
}

/**
 * 一条区间映射：原文坐标 ↔ 脱敏坐标，两边都是 UTF-16 code unit 的偏移量。
 * 不变式：`spans` 按 `originalStart` 升序、互不重叠；原文区间与脱敏区间一一对应。
 */
export interface RedactionSpan {
  readonly kind: string;
  readonly placeholder: string;
  readonly originalStart: number;
  readonly originalEnd: number;
  readonly redactedStart: number;
  readonly redactedEnd: number;
  /** 这一处是被哪一层遮的（元数据，不参与替换判定）。 */
  readonly source: RedactionSource;
  /**
   * 词表来源（`source === "entity_memory"`）时，被命中的 `entity.id`。
   * 只进预览投影供「从词表去掉」使用，**不写进 manifest 的映射本体**：坐标与占位符才是回锚所需，
   * 实体 id 是管理面的事；不落盘也让旧映射的回读形状逐字不变。
   */
  readonly entityId?: string;
}

export interface RedactionMap {
  readonly policyVersion: string;
  readonly nonce: string;
  readonly spans: readonly RedactionSpan[];
}

export interface RedactionResult {
  readonly redactedText: string;
  readonly map: RedactionMap;
}

export interface OriginalRange {
  readonly start: number;
  readonly end: number;
}

/** 调用方提供的额外候选区间：坐标锚定同一份 `rawText` 的 UTF-16 偏移。 */
export interface ExtraRedactionCandidate {
  readonly start: number;
  readonly end: number;
  readonly kind: string;
}

export interface RedactionOptions {
  /** 注入随机量只为了测试可复现；生产路径每次都新生成。 */
  readonly nonce?: string;
  /**
   * 本地模型层产出的候选（M9-3）。来源固定记为 `local_llm`——本入参就是这一层的入口，
   * 不接受调用方自报来源，免得把 `rule` 的优先级冒充出来。
   */
  readonly extraCandidates?: readonly ExtraRedactionCandidate[];
  /** 本次替换集合所属的策略版本；缺省维持 `rules-v1`，逐字不变。 */
  readonly policyVersion?: string;
}

/**
 * 已知实体清单来自 `entity` + `entity_alias`（§3.12/§3.13），不是调用方手抄的名字表。
 * 取全部 lifecycle_status：archived 实体仍是真实存在的人名，脱敏面宁宽勿窄。
 */
export function collectKnownEntities(db: Database): KnownEntity[] {
  const rows = db
    .prepare(
      `select e.id as entity_id, e.entity_type as entity_type,
              e.canonical_name as canonical_name, e.display_name as display_name,
              e.lifecycle_status as lifecycle_status, e.origin_type as origin_type,
              a.alias as alias,
              exists(
                select 1 from entity_mention as m
                 where m.entity_id = e.id and m.status = 'active' and m.basis = 'explicit'
              ) as has_explicit
       from entity as e
       left join entity_alias as a on a.entity_id = e.id
       where e.mask_enabled = 1
       order by e.id`,
    )
    .all() as unknown as Array<{
    entity_id: string;
    entity_type: string;
    canonical_name: string;
    display_name: string;
    lifecycle_status: string;
    origin_type: string;
    alias: string | null;
    has_explicit: number;
  }>;

  const byEntity = new Map<
    string,
    {
      type: string;
      lifecycleStatus: string;
      originType: string;
      hasExplicitActiveMention: boolean;
      terms: Set<string>;
    }
  >();
  for (const row of rows) {
    const bucket = byEntity.get(row.entity_id) ?? {
      type: row.entity_type,
      lifecycleStatus: row.lifecycle_status,
      originType: row.origin_type,
      hasExplicitActiveMention: row.has_explicit === 1,
      terms: new Set<string>(),
    };
    for (const term of [row.canonical_name, row.display_name, row.alias ?? ""]) {
      if (term !== "") bucket.terms.add(term);
    }
    byEntity.set(row.entity_id, bucket);
  }

  return [...byEntity.entries()].map(([entityId, bucket]) => ({
    entityId,
    entityType: bucket.type,
    lifecycleStatus: bucket.lifecycleStatus,
    originType: bucket.originType,
    hasExplicitActiveMention: bucket.hasExplicitActiveMention,
    terms: [...bucket.terms],
  }));
}

interface Candidate {
  readonly kind: string;
  /** 同一 kind 内的去重键：同一实体/同一号码在本次请求内共用一个占位符，模型才能回溯引用。 */
  readonly dedupeKey: string;
  readonly start: number;
  readonly end: number;
  /** 产出这条候选的那一层。重叠消解保留谁，来源就跟着谁走——来源是候选的属性，不是区间的属性。 */
  readonly source: RedactionSource;
  /** 仅 `entity_memory` 候选携带；随 span 进预览投影，供「从词表去掉」。 */
  readonly entityId?: string;
}

function ruleCandidates(text: string): Candidate[] {
  return findFormatCandidates(text);
}

const ASCII_TERM = /^[\x00-\x7F]+$/;
const WORD_CHAR = /[A-Za-z0-9_]/;

/** G1 词形门：太短、纯数字、纯标点、黑名单词都不进自动遮。 */
function termPassesWordForm(term: string): boolean {
  const clean = term.trim();
  if (clean.length < 2) return false;
  if (/^\d+$/.test(clean)) return false;
  if (!/[\p{L}\p{N}]/u.test(clean)) return false;
  if (isEntityStopTerm(clean)) return false;
  return true;
}

/**
 * G2 边界门：拉丁/数字词面前后不能是 `[A-Za-z0-9_]`。
 * CJK 没有词边界，靠长度与黑名单兜；两种词面都不做大小写折叠。
 */
function findTermOccurrences(text: string, term: string): number[] {
  const out: number[] = [];
  if (term === "") return out;
  const needsBoundary = ASCII_TERM.test(term);
  let from = 0;
  for (;;) {
    const at = text.indexOf(term, from);
    if (at < 0) break;
    if (!needsBoundary) {
      out.push(at);
      from = at + term.length;
      continue;
    }
    const before = at === 0 ? undefined : text[at - 1];
    const after = text[at + term.length];
    const leftOk = before === undefined || !WORD_CHAR.test(before);
    const rightOk = after === undefined || !WORD_CHAR.test(after);
    if (leftOk && rightOk) out.push(at);
    from = at + 1;
  }
  return out;
}

/**
 * G4 来源/证据门：`user_created` 放行；`active`（用户转正过）放行；`archived` 放行；
 * `ai_generated + provisional` 默认不放行，除非至少有一条 explicit 的活跃提及。
 * 测试夹具只给前三个字段时（`originType` 缺席）按放行处理，保持旧夹具可用。
 */
function entityPassesSourceGate(entity: KnownEntity): boolean {
  if (entity.originType !== "ai_generated") return true;
  if (entity.lifecycleStatus === "active" || entity.lifecycleStatus === "archived") return true;
  return entity.hasExplicitActiveMention === true;
}

function entityCandidates(text: string, entities: readonly KnownEntity[]): Candidate[] {
  const found: Candidate[] = [];
  for (const entity of entities) {
    if (!isRedactionKind(entity.entityType)) {
      throw new Error(`实体 ${entity.entityId} 的 entity_type 不在封闭集内：${entity.entityType}`);
    }
    // G0：语义层只遮三类。
    if (!(SEMANTIC_REDACTION_KINDS as readonly string[]).includes(entity.entityType)) continue;
    if (!entityPassesSourceGate(entity)) continue;
    for (const term of entity.terms) {
      if (!termPassesWordForm(term)) continue;
      for (const at of findTermOccurrences(text, term)) {
        found.push({
          kind: entity.entityType,
          dedupeKey: `${entity.entityType}\u0000entity\u0000${entity.entityId}`,
          start: at,
          end: at + term.length,
          source: "entity_memory",
          entityId: entity.entityId,
        });
      }
    }
  }
  return found;
}

/**
 * 把外部候选并进来：**先**剔除与任一 rule/entity 候选**有任何重叠**的那条，剩下的才与既有
 * 候选一起过 `resolveOverlaps`。优先级因此写在代码结构里，不靠数组顺序或排序键的偶然性
 * （准则 §五 禁区：不得让 LLM 候选覆盖规则命中）。区间不成立（非整数、越界、`end <= start`）
 * 的不采信：除了这里，产出链路上没有第二道校验，而这些坐标要进 `RedactionMap` 参与反向映射。
 *
 * `kind` 同样在这里过封闭集（M9-D-7）：`redact()` 是导出面，而 `redactionMap` 的 `kind` 在
 * 写入/回读两侧都要求落在封闭集内（`parseRedactionMap`），漏一条 unknown kind 会产出
 * **读不回来的映射**。区间合法但 kind 伪造 ⇒ 整条丢弃，不抛（上层发送流程不因模型坏输出中断）。
 *
 * 同一 kind、同一词面的多条外部候选共用一个占位符，与规则层同一条去重口径（模型才能回溯引用）。
 */
function admitExtraCandidates(
  rawText: string,
  base: readonly Candidate[],
  extras: readonly ExtraRedactionCandidate[],
): Candidate[] {
  const admitted: Candidate[] = [];
  for (const extra of extras) {
    if (!isRedactionKind(extra.kind)) continue;
    // L2 只产三类（2026-11-04 裁决）。这是第二道保险：调用方即使递来 work/product，也在这里丢弃。
    if (!(SEMANTIC_REDACTION_KINDS as readonly string[]).includes(extra.kind)) continue;
    if (!Number.isInteger(extra.start) || !Number.isInteger(extra.end)) continue;
    if (extra.start < 0 || extra.end <= extra.start || extra.end > rawText.length) continue;
    if (base.some((held) => held.start < extra.end && extra.start < held.end)) continue;
    admitted.push({
      kind: extra.kind,
      dedupeKey: `${extra.kind}\u0000llm\u0000${rawText.slice(extra.start, extra.end)}`,
      start: extra.start,
      end: extra.end,
      source: "local_llm",
    });
  }
  return admitted;
}

/**
 * 左起最长优先：同一位置上更长的字面形式胜出（"张三丰" 不被 "张三" 截断），
 * 且永不产出重叠区间——重叠区间会让反向映射失去唯一性。
 */
function resolveOverlaps(candidates: readonly Candidate[]): Candidate[] {
  const sorted = [...candidates].sort((a, b) =>
    a.start !== b.start ? a.start - b.start : b.end - b.start - (a.end - a.start),
  );
  const accepted: Candidate[] = [];
  let cursor = 0;
  for (const candidate of sorted) {
    if (candidate.start < cursor) continue;
    accepted.push(candidate);
    cursor = candidate.end;
  }
  return accepted;
}

/**
 * 脱敏主入口：产出脱敏文本与区间映射。
 * 原文**逐字不被修改**，也不被写回任何地方——返回值里的 map 是本地凭据。
 */
export function redact(
  rawText: string,
  entities: readonly KnownEntity[] = [],
  options: RedactionOptions = {},
): RedactionResult {
  const nonce = options.nonce ?? newNonce();
  const base = [...ruleCandidates(rawText), ...entityCandidates(rawText, entities)];
  const candidates = resolveOverlaps([
    ...base,
    ...admitExtraCandidates(rawText, base, options.extraCandidates ?? []),
  ]);

  const placeholderByKind = new Map<string, number>();
  const placeholderByKey = new Map<string, string>();
  const spans: RedactionSpan[] = [];
  let out = "";
  let cursor = 0;
  for (const candidate of candidates) {
    out += rawText.slice(cursor, candidate.start);
    let placeholder = placeholderByKey.get(candidate.dedupeKey);
    if (placeholder === undefined) {
      const index = (placeholderByKind.get(candidate.kind) ?? 0) + 1;
      placeholderByKind.set(candidate.kind, index);
      placeholder = `[${candidate.kind}_${index}_${nonce}]`;
      placeholderByKey.set(candidate.dedupeKey, placeholder);
    }
    const redactedStart = out.length;
    out += placeholder;
    spans.push({
      kind: candidate.kind,
      placeholder,
      originalStart: candidate.start,
      originalEnd: candidate.end,
      redactedStart,
      redactedEnd: out.length,
      source: candidate.source,
      ...(candidate.entityId === undefined ? {} : { entityId: candidate.entityId }),
    });
    cursor = candidate.end;
  }
  out += rawText.slice(cursor);

  return {
    redactedText: out,
    map: { policyVersion: options.policyVersion ?? REDACTION_POLICY_VERSION, nonce, spans },
  };
}

function offsetsUsable(start: number, end: number): boolean {
  return (
    Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end >= start
  );
}

/** 边界落在占位符内部 ⇒ 该区间把某个标识切坏了，不可靠映射（模型违反 §5.3 的「完整沿用」）。 */
function slicesPlaceholder(span: RedactionSpan, start: number, end: number, side: "redacted" | "original"): boolean {
  const lo = side === "redacted" ? span.redactedStart : span.originalStart;
  const hi = side === "redacted" ? span.redactedEnd : span.originalEnd;
  return (start > lo && start < hi) || (end > lo && end < hi);
}

function deltaAt(map: RedactionMap, offset: number, side: "redacted" | "original"): number {
  let delta = 0;
  for (const span of map.spans) {
    const lo = side === "redacted" ? span.redactedStart : span.originalStart;
    const hi = side === "redacted" ? span.redactedEnd : span.originalEnd;
    const shift = span.redactedEnd - span.redactedStart - (span.originalEnd - span.originalStart);
    if (hi <= offset) delta += shift;
  }
  return delta;
}

/**
 * 脱敏坐标 ⇒ 原文坐标（§7.6 的反向）。返回 null 表示**不可靠映射**：
 * 越界、非整数、区间倒置，或边界切进某个占位符内部。
 * null 不是「偏移为 0」——调用方必须据此走 §7.6.4 的修复路径，绝不静默写入证据。
 */
export function redactedRangeToOriginal(map: RedactionMap, start: number, end: number): OriginalRange | null {
  if (!offsetsUsable(start, end)) return null;
  for (const span of map.spans) {
    if (slicesPlaceholder(span, start, end, "redacted")) return null;
  }
  return { start: start - deltaAt(map, start, "redacted"), end: end - deltaAt(map, end, "redacted") };
}

/** 原文坐标 ⇒ 脱敏坐标（正向，预览与 UI 用）。同样的「切坏即 null」纪律。 */
export function originalRangeToRedacted(map: RedactionMap, start: number, end: number): OriginalRange | null {
  if (!offsetsUsable(start, end)) return null;
  for (const span of map.spans) {
    if (slicesPlaceholder(span, start, end, "original")) return null;
  }
  return { start: start + deltaAt(map, start, "original"), end: end + deltaAt(map, end, "original") };
}

/**
 * 把一段原文切片按映射重写成它「应当长成的脱敏样子」。
 * 边界切进某个原区间（该区间被部分引用）⇒ null：部分占位符不是合法标识。
 */
export function projectOriginalSlice(
  map: RedactionMap,
  rawText: string,
  start: number,
  end: number,
): string | null {
  if (!offsetsUsable(start, end) || end > rawText.length) return null;
  let out = "";
  let cursor = start;
  for (const span of map.spans) {
    if (span.originalEnd <= start) continue;
    if (span.originalStart >= end) break;
    if (span.originalStart < start || span.originalEnd > end) return null;
    out += rawText.slice(cursor, span.originalStart);
    out += span.placeholder;
    cursor = span.originalEnd;
  }
  out += rawText.slice(cursor, end);
  return out;
}

export interface MappedEvidence {
  readonly originalStart: number;
  readonly originalEnd: number;
  /** 要入库的 evidence_text：原文切片，锚定该 revision 的 raw_text（K-23）。 */
  readonly originalText: string;
  /** 模型实际看到的切片（脱敏坐标下逐字），核验用。 */
  readonly redactedSlice: string;
}

/**
 * §7.6.2 的核验原语：脱敏坐标的 evidence 区间 → 原文坐标 + 逐字一致性检查。
 *
 * 一致性判据是双向闭合的：把映射后的原文区间重新投影成脱敏文本，必须与模型给出的切片
 * **逐字相等**。任何一条不成立（映射缺失、越界、切片被替换文本改动）都返回 null，
 * 由调用方落 `Suggestion(kind=evidence_repair)`，绝不自动创建有效 Mention。
 *
 * 参数 `sentText` 是**实际发送出去的那份文本**：默认即脱敏文本；用户在预览里手工替换后
 * 替换区段不再被映射覆盖，本函数对它返回 null——这正是「宁缺不伪」的预期行为。
 */
export function resolveEvidenceToOriginal(
  map: RedactionMap,
  rawText: string,
  sentText: string,
  start: number,
  end: number,
): MappedEvidence | null {
  if (!offsetsUsable(start, end) || end > sentText.length) return null;
  const range = redactedRangeToOriginal(map, start, end);
  if (range === null) return null;
  if (range.start < 0 || range.end > rawText.length) return null;
  const expected = projectOriginalSlice(map, rawText, range.start, range.end);
  if (expected === null) return null;
  const slice = sentText.slice(start, end);
  if (expected !== slice) return null;
  return {
    originalStart: range.start,
    originalEnd: range.end,
    originalText: rawText.slice(range.start, range.end),
    redactedSlice: slice,
  };
}

/** 映射的可序列化形态（进 `pipeline_manifest.redactionMap`，仅本地）。 */
export function redactionMapJsonValue(map: RedactionMap): JsonObject {
  return {
    policyVersion: map.policyVersion,
    nonce: map.nonce,
    spans: map.spans.map((span) => ({
      kind: span.kind,
      placeholder: span.placeholder,
      originalStart: span.originalStart,
      originalEnd: span.originalEnd,
      redactedStart: span.redactedStart,
      redactedEnd: span.redactedEnd,
      source: span.source,
    })),
  };
}

export function parseRedactionMap(value: unknown): RedactionMap {
  const parsed = value as Partial<RedactionMap> | null;
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    typeof parsed.policyVersion !== "string" ||
    typeof parsed.nonce !== "string" ||
    !Array.isArray(parsed.spans)
  ) {
    throw new Error("redactionMap 结构不成立：需要 policyVersion / nonce / spans 三件");
  }
  const spans = parsed.spans.map((raw): RedactionSpan => {
    const span = raw as RedactionSpan;
    if (!isRedactionKind(span.kind)) throw new Error(`redactionMap 的 kind 不在封闭集内：${span.kind}`);
    for (const [name, number] of [
      ["originalStart", span.originalStart],
      ["originalEnd", span.originalEnd],
      ["redactedStart", span.redactedStart],
      ["redactedEnd", span.redactedEnd],
    ] as const) {
      if (!Number.isInteger(number) || number < 0) throw new Error(`redactionMap 的 ${name} 不是合法偏移：${number}`);
    }
    // 历史 manifest 没有 source 字段 ⇒ 按 `rule` 补齐、**不报错**：旧 run 的映射只能读不能重算，
    // 硬拒会让它们整体不可读（草案 §四）。字段存在却不认识 ⇒ 抛错，与 kind 现有处理同形。
    // 从 `raw` 取值而不是从 `span` 取：`span` 那份断言声称 source 已成立，拿它自检是自我认证。
    const declared = (raw as { source?: unknown }).source;
    const source = declared === undefined ? "rule" : declared;
    if (!isRedactionSource(source)) {
      throw new Error(`redactionMap 的 source 不在封闭集内：${String(declared)}`);
    }
    return { ...span, source };
  });
  for (let i = 1; i < spans.length; i += 1) {
    const previous = spans[i - 1]!;
    const current = spans[i]!;
    if (current.originalStart < previous.originalEnd) {
      throw new Error("redactionMap 的区间重叠，反向映射失去唯一性");
    }
  }
  return { policyVersion: parsed.policyVersion, nonce: parsed.nonce, spans };
}

/** 逐字哈希：授权绑定的是「实际准备发送的那份文本」，不做 NFC 归一（归一只属于 diff 与审计）。 */
export function sha256OfText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
