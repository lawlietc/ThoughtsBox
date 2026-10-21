import { readFileSync } from "node:fs";
import { join } from "node:path";

import { CONSTANTS_DIR, loadEnums } from "../../shared/contracts/load.ts";
import type { KnownEntity } from "./redaction.ts";

/**
 * 「陌生名字」候选规则层（M3-RED-1 / 缺口清单 §五「已定」②）。
 *
 * 它**只在预览里提候选**，不进 `redact()` 的替换集合：候选在用户确认前不改变任何
 * 待发送文本，脱敏集合不变 ⇒ `REDACTION_POLICY_VERSION` 保持 `rules-v1`（判据见 worklog）。
 * 用户确认后，那个词之所以被遮，是因为它变成了「已确认实体」（走既有 `collectKnownEntities`
 * 通道），不是因为这里新增了自动遮规则。
 *
 * 词表在 `src/shared/constants/surname-rules.json`——与 `enums.json` 隔离（那才是封闭契约面），
 * 本模块只读取、不把它当契约。规则是**启发式召回**：中文姓名没有可靠规则，猜不中就是漏，
 * 靠丁（如实告知哪些被跳过、将原样外发）兜底，不假装它可靠。
 */

export interface NameCandidate {
  /** 词面：用户原词逐字（不做大小写折叠 / 归一化改写）。 */
  readonly term: string;
  /** 猜测的实体类型，取 enums.json `entity_types` 的 8 值之一。 */
  readonly suggestedKind: string;
  /** 猜测依据（命中的规则名 + 线索），供预览展示「凭什么猜它是这个类型」。 */
  readonly basis: string;
  /** 该词面在原文中出现的全部起始坐标（UTF-16 偏移，升序去重）。 */
  readonly occurrences: readonly number[];
}

interface SurnameRules {
  readonly surnames: readonly string[];
  readonly honorifics: readonly string[];
  readonly orgSuffixes: readonly string[];
  readonly nameCues: readonly string[];
  readonly stopTerms: readonly string[];
}

let cachedRules: SurnameRules | undefined;

function loadRules(): SurnameRules {
  if (cachedRules !== undefined) return cachedRules;
  const file = join(CONSTANTS_DIR, "surname-rules.json");
  const parsed = JSON.parse(readFileSync(file, "utf8")) as SurnameRules;
  cachedRules = parsed;
  return parsed;
}

const CJK = "[\\u4e00-\\u9fa5]";

function collectOccurrences(text: string, term: string): number[] {
  const at: number[] = [];
  let from = 0;
  for (;;) {
    const idx = text.indexOf(term, from);
    if (idx < 0) break;
    at.push(idx);
    from = idx + term.length;
  }
  return at;
}

/** 词面若是已确认实体的任一字面形式，它本就会被既有通道遮掉 ⇒ 不作候选。 */
function isKnownTerm(term: string, known: Set<string>): boolean {
  return known.has(term.normalize("NFC"));
}

function kindOf(term: string, rules: SurnameRules): { kind: string; basis: string } {
  for (const suffix of rules.orgSuffixes) {
    if (term.endsWith(suffix)) return { kind: "organization", basis: `org-suffix:${suffix}` };
  }
  return { kind: "person", basis: "" };
}

/**
 * 从原文捞陌生名字候选：姓氏表 + 称谓（老X/小X/阿X）+ 上下文线索（X说/X跟/和X…）。
 * `knownEntities` 提供已确认词面（这些不入围）；返回按首次出现升序、按词面去重。
 */
export function deriveNameCandidates(
  rawText: string,
  knownEntities: readonly KnownEntity[] = [],
): NameCandidate[] {
  const rules = loadRules();
  const entityTypes = loadEnums().entity_types as readonly string[];
  const known = new Set<string>();
  for (const e of knownEntities) for (const t of e.terms) known.add(t.normalize("NFC"));

  const byTerm = new Map<string, { kind: string; basis: string }>();
  const add = (term: string, basisHint: string, forceKind?: string): void => {
    const clean = term.trim();
    if (clean.length < 2) return;
    if (rules.stopTerms.includes(clean)) return;
    if (isKnownTerm(clean, known)) return;
    if (byTerm.has(clean)) return;
    const inferred = kindOf(clean, rules);
    const kind = forceKind ?? inferred.kind;
    const basis = forceKind ? basisHint : inferred.basis || basisHint;
    // suggestedKind 必须落在封闭 8 值内；规则只产 person/organization，二者恒合法。
    if (!entityTypes.includes(kind)) return;
    byTerm.set(clean, { kind, basis });
  };

  // 0. 机构后缀：以「公司/大学/医院…」结尾的词，直接判 organization（缺口清单「已定」②）。
  const orgCls = rules.orgSuffixes.map((s) => escapeRe(s)).join("|");
  if (orgCls !== "") {
    const re = new RegExp(`${CJK}{1,4}(?:${orgCls})`, "gu");
    for (const m of rawText.matchAll(re)) {
      if (m.index === undefined) continue;
      add(m[0]!, `org-suffix:${m[0]!.replace(new RegExp(`(?:${orgCls})$`), "")}`, "organization");
    }
  }

  // 1. 称谓前缀：老X / 小X / 阿X（1–2 字名字体）。
  for (const h of rules.honorifics) {
    const re = new RegExp(`${h}(${CJK}{1,2})`, "gu");
    for (const m of rawText.matchAll(re)) {
      if (m.index === undefined) continue;
      add(m[0]!, `honorific:${h}`);
    }
  }

  // 2. 姓氏开头：常见姓 + 1–2 字（覆盖「王小明」这类全名 / 半名）。
  const surnameCls = rules.surnames.map((s) => escapeRe(s)).join("|");
  if (surnameCls !== "") {
    const re = new RegExp(`(${surnameCls})(${CJK}{1,2})`, "gu");
    for (const m of rawText.matchAll(re)) {
      if (m.index === undefined) continue;
      add(m[0]!, "surname");
    }
  }

  // 3. 上下文线索：动词/介词前紧邻的 2–3 字序列。
  const cueCls = rules.nameCues.map((c) => escapeRe(c)).join("|");
  if (cueCls !== "") {
    const re = new RegExp(`(${CJK}{2,3})(?:${cueCls})`, "gu");
    for (const m of rawText.matchAll(re)) {
      if (m.index === undefined) continue;
      add(m[1]!, "context-cue");
    }
  }

  const out: NameCandidate[] = [];
  for (const [term, meta] of byTerm) {
    const occurrences = collectOccurrences(rawText, term);
    if (occurrences.length === 0) continue;
    out.push({ term, suggestedKind: meta.kind, basis: meta.basis, occurrences });
  }
  out.sort((a, b) => (a.occurrences[0] ?? 0) - (b.occurrences[0] ?? 0));
  return out;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
