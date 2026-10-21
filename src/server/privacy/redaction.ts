import { createHash, randomBytes } from "node:crypto";

import { loadEnums } from "../../shared/contracts/load.ts";
import type { Database } from "../db/adapter.ts";
import type { JsonObject } from "./manifest.ts";

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
 */
export const REDACTION_POLICY_VERSION = "rules-v1";

/**
 * 规则类占位符的取值集合。上游只枚举了「手机号、邮箱」（Spec §5.1.4 / §6.2），
 * 「等」没有清单，因此这里**不多做**一个规则类别——身份证、IP 之类若上游未点名，
 * 就不由实现方自行宣布为契约（宁可漏脱敏由用户确认兜住，也不静默扩大「已脱敏」的承诺面）。
 */
export const RULE_REDACTION_KINDS = ["phone", "email"] as const;
export type RuleRedactionKind = (typeof RULE_REDACTION_KINDS)[number];

/** 实体类占位符的 kind 直接取 enums.json 的封闭 `entity_types`，不另立名称。 */
export const ENTITY_REDACTION_KINDS: readonly string[] = loadEnums().entity_types;

/** 全部合法 kind：两个规则类别 + 七个实体类型（封闭集，`closed_set_rule`）。 */
export const REDACTION_KINDS: readonly string[] = [...RULE_REDACTION_KINDS, ...ENTITY_REDACTION_KINDS];

export function isRedactionKind(value: string): boolean {
  return REDACTION_KINDS.includes(value);
}

const PHONE_PATTERN = /(?<!\d)1[3-9]\d{9}(?!\d)/g;
const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;

/** 单次请求占位符的一次性随机量：跨请求不稳定，避免关联暴露（Spec §6.2）。 */
function newNonce(): string {
  return randomBytes(3).toString("hex");
}

export interface KnownEntity {
  readonly entityId: string;
  readonly entityType: string;
  /** 该实体在原文中可能被写出的全部字面形式：标准名、展示名与别名（逐字，不做大小写折叠）。 */
  readonly terms: readonly string[];
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

export interface RedactionOptions {
  /** 注入随机量只为了测试可复现；生产路径每次都新生成。 */
  readonly nonce?: string;
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
              a.alias as alias
       from entity as e
       left join entity_alias as a on a.entity_id = e.id
       order by e.id`,
    )
    .all() as unknown as Array<{
    entity_id: string;
    entity_type: string;
    canonical_name: string;
    display_name: string;
    alias: string | null;
  }>;

  const byEntity = new Map<string, { type: string; terms: Set<string> }>();
  for (const row of rows) {
    const bucket = byEntity.get(row.entity_id) ?? { type: row.entity_type, terms: new Set<string>() };
    for (const term of [row.canonical_name, row.display_name, row.alias ?? ""]) {
      if (term !== "") bucket.terms.add(term);
    }
    byEntity.set(row.entity_id, bucket);
  }

  return [...byEntity.entries()].map(([entityId, bucket]) => ({
    entityId,
    entityType: bucket.type,
    terms: [...bucket.terms],
  }));
}

interface Candidate {
  readonly kind: string;
  /** 同一 kind 内的去重键：同一实体/同一号码在本次请求内共用一个占位符，模型才能回溯引用。 */
  readonly dedupeKey: string;
  readonly start: number;
  readonly end: number;
}

function ruleCandidates(text: string, pattern: RegExp, kind: RuleRedactionKind): Candidate[] {
  const found: Candidate[] = [];
  for (const match of text.matchAll(pattern)) {
    const value = match[0];
    const start = match.index;
    if (value === "" || start === undefined) continue;
    found.push({ kind, dedupeKey: `${kind}\u0000${value}`, start, end: start + value.length });
  }
  return found;
}

function entityCandidates(text: string, entities: readonly KnownEntity[]): Candidate[] {
  const found: Candidate[] = [];
  for (const entity of entities) {
    if (!isRedactionKind(entity.entityType)) {
      throw new Error(`实体 ${entity.entityId} 的 entity_type 不在封闭集内：${entity.entityType}`);
    }
    for (const term of entity.terms) {
      if (term === "") continue;
      let from = 0;
      for (;;) {
        const at = text.indexOf(term, from);
        if (at < 0) break;
        found.push({
          kind: entity.entityType,
          dedupeKey: `${entity.entityType}\u0000entity\u0000${entity.entityId}`,
          start: at,
          end: at + term.length,
        });
        from = at + term.length;
      }
    }
  }
  return found;
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
  const candidates = resolveOverlaps([
    ...ruleCandidates(rawText, PHONE_PATTERN, "phone"),
    ...ruleCandidates(rawText, EMAIL_PATTERN, "email"),
    ...entityCandidates(rawText, entities),
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
    });
    cursor = candidate.end;
  }
  out += rawText.slice(cursor);

  return {
    redactedText: out,
    map: { policyVersion: REDACTION_POLICY_VERSION, nonce, spans },
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
    return span;
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
