/**
 * 结构化输出契约：Zod 结构门 + 本地业务门（D6，ADR-006 的落点）。
 *
 * 契约取值：Spec §3.2.2/§3.2.3/§3.2.5/§5.3、指令 §6.3/§9.1、
 * ADR-006、ADR-014、Schema §7.6〔K-23/B9〕、`enums.json` 封闭集。
 *
 * ADR-006 的理由就是本文件存在的理由：SDK 能保证 `evidence` 是个字符串，
 * 保证不了那条情绪在原文里出现过。所以这里是**两道分别可拒的门**：
 *
 *   ① `parseStructuredOutput()` —— 形状。缺字段、类型错、多字段（`intensity` /
 *      `triggered_by`）都在这里被拒，拒了记 `provider_schema`。
 *      〔M7-2〕`relations` 自 `m2-output-v2` 起是**在册键**，不再属于「多出来的那一个」；
 *      它是唯一一个键允许缺席（缺席即空数组），因为旧 prompt、旧夹具、已有 run 的回放
 *      不得因为契约多一个键而被拒（准则 §3.3）。
 *   ② `validateBusiness()` —— 事实。证据能否在实际发送的输入文本里回溯、映射不出原文坐标、
 *      占位符有没有被擅自增删、候选 ID 是否有效、实体匹配有没有足够依据、时间五元组是否相容；
 *      拒了记 `business_validation`，纯证据类失败记 `evidence_unmapped`。
 *      关系走 `validateRelations()`：同一套判据、同一个回锚实现，但**失败只丢那一条**，
 *      不进致命收集器（准则 §3.4「关系是增量产出，不能让一条坏关系毁掉整次解析」）。
 *
 * 两条 Provider 路径（原生结构化输出 / 容错提取）的结果**必须走同一对门**（指令 §6.2 末段），
 * 所以本文件不接收「来自哪个 Provider」这种参数——门与路径无关。
 *
 * 通过②不等于可以写库：②只负责把「能进正式图谱」与「只能进待确认队列」分开
 * （ADR-014：推断结果永远不能未经用户接受就成为有效提及），写入边界属 M2-5。
 */

import { z } from "zod";

import { loadContracts, type Contracts } from "../../shared/contracts/load.ts";
import { aiCreatableGraphEdgeRelationTypes } from "../../shared/contracts/enums.ts";
import { ID_PREFIXES, seedConceptId } from "../../shared/contracts/ids.ts";
import { resolveEvidenceToOriginal, type RedactionMap } from "../privacy/redaction.ts";
import type { ParseErrorKind } from "./provider.ts";

/**
 * 契约取值一律来自单一事实源（E-07）：`basis` / `event_time_precision` /
 * `event_time_certainty` 三处封闭集都从 `enums.json` 取，本文件一个字都不抄。
 */
const CONTRACTS: Contracts = loadContracts();
const ENUM_VALUES = CONTRACTS.enums;

function enumArray(values: readonly string[]): [string, ...string[]] {
  const first = values[0];
  if (first === undefined) throw new Error(`enums.json 的封闭集为空：${JSON.stringify(values)}`);
  return [first, ...values.slice(1)] as [string, ...string[]];
}

/** 业务规则标识——写进 Trace 与验收对账，而不是散落在 if 里（ADR-006 Consequences）。 */
export const BUSINESS_RULES = [
  "evidence_traceable",
  "evidence_mappable_to_original",
  "placeholder_untouched",
  "candidate_id_valid",
  "entity_basis_sufficient",
  "event_time_compatible",
] as const;

export type BusinessRule = (typeof BUSINESS_RULES)[number];

/** 证据类规则：只有它们坏时，错误类别才是 `evidence_unmapped` 而非泛化的业务失败。 */
const EVIDENCE_RULES: readonly BusinessRule[] = ["evidence_traceable", "evidence_mappable_to_original"];

/** 形状门不通过。`kind` 固定为 `provider_schema`——它是结构问题，不是事实问题。 */
export class ContractSchemaError extends Error {
  readonly kind: ParseErrorKind = "provider_schema";
  readonly retryable = false;
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`结构化输出不符合 Schema：\n  - ${issues.join("\n  - ")}`);
    this.name = "ContractSchemaError";
    this.issues = issues;
  }
}

/** 业务门不通过（事实层面不可采信），原因逐条可定位。 */
export class BusinessValidationError extends Error {
  readonly kind: ParseErrorKind;
  readonly retryable = false;
  readonly rule: BusinessRule;
  readonly issues: readonly string[];

  constructor(rule: BusinessRule, issues: readonly string[], kind: ParseErrorKind) {
    super(`业务校验不通过（${rule}）：\n  - ${issues.join("\n  - ")}`);
    this.name = "BusinessValidationError";
    this.kind = kind;
    this.rule = rule;
    this.issues = issues;
  }
}

/** Spec §5.3 的 `ExtractedLabel`，四个字段逐字同名。 */
export const extractedLabelSchema = z
  .object({
    labelSaid: z.string().min(1),
    candidateConceptId: z.string().nullable(),
    basis: z.enum(enumArray(ENUM_VALUES.basis_values)),
    evidence: z.string().min(1),
  })
  .strict();

export type ExtractedLabel = z.infer<typeof extractedLabelSchema>;

/** 原始时间表达 + 归一化五元组（取值取 enums.json，相容性取 §3.8/B8/P14）。 */
export const extractedEventTimeSchema = z
  .object({
    raw: z.string().min(1).nullable(),
    precision: z.enum(enumArray(ENUM_VALUES.event_time_precision)),
    certainty: z.enum(enumArray(ENUM_VALUES.event_time_certainty)),
    start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
    end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  })
  .strict();

export type ExtractedEventTime = z.infer<typeof extractedEventTimeSchema>;

const nonEmpty = z.string().min(1);

export const extractedEpisodeSchema = z
  .object({
    summary: nonEmpty,
    evidence: nonEmpty,
    eventTime: extractedEventTimeSchema,
  })
  .strict();

export const extractedThoughtSchema = z
  .object({
    text: nonEmpty,
    evidence: nonEmpty,
  })
  .strict();

/**
 * 一条稳定社会关系（M7-2，准则 §3.3）。四个键与 prompt v2 正文逐字同名。
 *
 * 这里只收**形状**：`relationType` 是否在六值内、两端是否同词、证据能否回锚、
 * 词面是否在证据里逐字出现，全属事实门，见 `validateRelations()`。
 * `.strict()` 照旧：模型多给一个 `intensity`、`confidence`、`episodeId` 之类的键仍然进不来。
 */
export const extractedRelationSchema = z
  .object({
    relationType: nonEmpty,
    srcLabel: nonEmpty,
    dstLabel: nonEmpty,
    evidence: nonEmpty,
  })
  .strict();

export type ExtractedRelation = z.infer<typeof extractedRelationSchema>;

/**
 * 顶层输出。`.strict()` 是「Schema 不含 `intensity`、不含 `triggered_by`」
 * （Spec §5.3、§3.2.5、ADR-014）的**执行处**：模型多给任何一个这类键都在这里被拒，
 * 而不是「先收下再忽略」——收下就等于承认模型可以提议强度与因果关系。
 *
 * 「空信息返回空数组」= 六个数组键都必须在场且可为空；缺键是结构问题（§5.3 末条），
 * 用 `.array()` 不用 `.default([])`：默认值等于替模型把 Schema 填满。
 *
 * 唯一的例外是 `relations`：它**允许缺席**，缺席即 `[]`。理由是上面那段——升契约键时
 * 库里已有的 run 回放、还在用的旧 prompt、`m2-output-v1` 形状的夹具都必须照旧通过形状门
 * （准则 §3.3），而「新 prompt 必须输出这个键，空数组也要在」这条要求住在 prompt v2 的正文里，
 * 不住在 Schema 的必填性里。
 */
export const structuredOutputSchema = z
  .object({
    title: nonEmpty,
    summary: nonEmpty,
    episodes: z.array(extractedEpisodeSchema),
    thoughts: z.array(extractedThoughtSchema),
    emotions: z.array(extractedLabelSchema),
    topics: z.array(extractedLabelSchema),
    entities: z.array(extractedLabelSchema),
    relations: z.array(extractedRelationSchema).default([]),
  })
  .strict();

export type StructuredOutput = z.infer<typeof structuredOutputSchema>;

/** 第一道门：形状。返回的是 Zod 收敛后的值，不是 `unknown`。 */
export function parseStructuredOutput(raw: unknown): StructuredOutput {
  const parsed = structuredOutputSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  throw new ContractSchemaError(
    parsed.error.issues.map((issue) => `${issue.path.join(".") || "(根)"}: ${issue.message}`),
  );
}

/** 已知概念索引：概念 ID → `emotion | topic`。 */
export type ConceptIndex = ReadonlyMap<string, "emotion" | "topic">;

/**
 * 默认索引 = 词表播种出来的那批概念 ID（`seedConceptId` 的确定性规则，M0 已交付）。
 * 只覆盖词表种子；用户自建概念/别名由 M2-5 从库里现读后经 `knownConcepts` 注入——
 * 本模块不查库，否则结构门与业务门就没法脱离数据单独验证。
 */
export function seedConceptIndex(contracts: Contracts = CONTRACTS): ConceptIndex {
  const index = new Map<string, "emotion" | "topic">();
  const put = (id: string, domain: "emotion" | "topic", name: string): void => {
    const existing = index.get(id);
    if (existing !== undefined && existing !== domain) {
      throw new Error(`词表种子跨域同名会让概念 ID 撞主键：${name}（${existing} / ${domain}）`);
    }
    index.set(id, domain);
  };
  for (const concept of contracts.emotions.concepts) put(seedConceptId(concept.canonical_name), "emotion", concept.canonical_name);
  for (const concept of contracts.topics.concepts) put(seedConceptId(concept.canonical_name), "topic", concept.canonical_name);
  return index;
}

export interface BusinessValidationContext {
  /** 实际发送给模型的那份文本（云端=已确认载荷；本地=原文）。§5.3：证据在**它**里回溯。 */
  readonly sentText: string;
  /** 该 revision 的 `raw_text`——入库证据永远锚它（K-23）。 */
  readonly rawText: string;
  /** 原文↔脱敏坐标映射；本地路径没有映射（两份文本同一份），云端必须有。 */
  readonly redactionMap?: RedactionMap;
  readonly knownConcepts?: ConceptIndex;
  readonly knownEntityIds?: ReadonlySet<string>;
}

/**
 * 分流去向（§3.2.2 的写入分层）：
 * `mention` 可进正式提及；`suggestion` 只能进待确认队列（契约点名的只有情绪的 `emotion_candidate`）；
 * `unrouted` 是「既不能落 Mention、契约又没点名该生成哪种建议」的推断项，交由 M2-5/§3.4 裁决，
 * 本模块不发明 suggestion kind。
 */
export type MentionRoute = "mention" | "suggestion" | "unrouted";

export interface ValidatedEvidence {
  /** 要入库的 evidence_text：原文切片（K-23）。 */
  readonly evidenceText: string;
  readonly evidenceStart: number;
  readonly evidenceEnd: number;
  /** 模型实际看到的切片，核验用。 */
  readonly sentSlice: string;
}

export interface ValidatedLabel extends ValidatedEvidence {
  readonly labelSaid: string;
  /** 逐字保留模型提出的候选；它**无写入权限**（K-14），归一化由 M2-5 的解析器决定。 */
  readonly candidateConceptId: string | null;
  readonly basis: string;
  readonly route: MentionRoute;
  readonly suggestionKind: string | null;
}

export interface ValidatedEpisode extends ValidatedEvidence {
  readonly summary: string;
  readonly eventTime: ExtractedEventTime;
}

export interface ValidatedThought extends ValidatedEvidence {
  readonly text: string;
}

export interface BusinessValidationResult {
  readonly title: string;
  readonly summary: string;
  readonly episodes: readonly ValidatedEpisode[];
  readonly thoughts: readonly ValidatedThought[];
  readonly emotions: readonly ValidatedLabel[];
  readonly topics: readonly ValidatedLabel[];
  readonly entities: readonly ValidatedLabel[];
  /** 走过的规则标识，供 Trace 记录「业务校验结果」（指令 §11.1）。 */
  readonly checkedRules: readonly BusinessRule[];
}

/** 占位符形态：`[kind_序号_一次性随机量]`，与 `redaction.ts` 第 223 行的生成式同形。 */
const PLACEHOLDER_SHAPE = /\[[a-z][a-z0-9_]*_\d+_[^\]\s]+\]/g;

/**
 * 失败上报口。**同一份判定实现**服务于两道门，去向不同：
 *  - `validateBusiness()` 递的是 `IssueCollector.add`——攒齐后整批抛，run 落 `failed`；
 *  - `validateRelations()` 递的是自己的丢弃清单——只作废那一条，run 照旧成功（准则 §3.4）。
 */
type IssueReport = (rule: BusinessRule, target: string, detail: string) => void;

/**
 * §5.3 + K-23：脱敏坐标的证据 → 原文坐标 + 逐字一致性。返回 null 即不可采信。
 *
 * 抽成模块级函数只为让关系门复用**同一个**回锚实现；把它拆成两份「看起来一样」的定位逻辑，
 * 等于给「脱敏文本里的偏移永不得入库」这条不变式准备两个可能走样的副本。
 */
function resolveAnchor(
  context: BusinessValidationContext,
  report: IssueReport,
  target: string,
  evidence: string,
): ValidatedEvidence | null {
  const start = context.sentText.indexOf(evidence);
  if (start < 0) {
    report("evidence_traceable", target, "证据无法在实际发送的输入文本中逐字回溯");
    return null;
  }
  const end = start + evidence.length;
  const map = context.redactionMap;
  if (map !== undefined) {
    const mapped = resolveEvidenceToOriginal(map, context.rawText, context.sentText, start, end);
    if (mapped === null) {
      report("evidence_mappable_to_original", target, "证据区间切坏了占位符或映射不出原文坐标");
      return null;
    }
    return {
      evidenceText: mapped.originalText,
      evidenceStart: mapped.originalStart,
      evidenceEnd: mapped.originalEnd,
      sentSlice: mapped.redactedSlice,
    };
  }
  // 本地路径没有映射：发送文本就是原文，坐标同一（§5.1 第 4 步的脱敏只对云端成立）。
  return {
    evidenceText: context.rawText.slice(start, end),
    evidenceStart: start,
    evidenceEnd: end,
    sentSlice: context.sentText.slice(start, end),
  };
}

/** §5.3「占位符必须完全沿用」+ §11-隐私「未知/非法占位符不得映射到真实实体」。 */
function checkPlaceholdersAgainstSentText(
  context: BusinessValidationContext,
  report: IssueReport,
  target: string,
  evidence: string,
): void {
  for (const match of evidence.matchAll(PLACEHOLDER_SHAPE)) {
    if (!context.sentText.includes(match[0])) {
      report(
        "placeholder_untouched",
        target,
        `模型编造了输入文本中不存在的占位符标识：${match[0]}`,
      );
    }
  }
}

/**
 * 词面是否有逐字依据：看**发送切片**，也看映射回的**原文切片**。
 * 与 `validateLabel()` 里实体那条判据同一口径（云端词面可能是占位符本体，映射后才是原文词面）。
 */
function termGroundedIn(
  anchored: ValidatedEvidence | null,
  evidence: string,
  term: string,
): boolean {
  const said = term.normalize("NFC");
  return (
    evidence.normalize("NFC").includes(said) ||
    (anchored !== null && anchored.evidenceText.normalize("NFC").includes(said))
  );
}

/** 按规则归桶的失败收集器：一次调用收集全部失败，M2-5 才能整批生成修复建议。 */
class IssueCollector {
  private readonly buckets = new Map<BusinessRule, string[]>();

  add(rule: BusinessRule, target: string, detail: string): void {
    const bucket = this.buckets.get(rule);
    if (bucket === undefined) this.buckets.set(rule, [`${target} — ${detail}`]);
    else bucket.push(`${target} — ${detail}`);
  }

  get empty(): boolean {
    return this.buckets.size === 0;
  }

  /** 抛出：证据类独占 ⇒ `evidence_unmapped`；混有其它 ⇒ `business_validation`。 */
  throwIfAny(): void {
    if (this.buckets.size === 0) return;
    const rules = BUSINESS_RULES.filter((rule) => this.buckets.has(rule));
    const issues = rules.flatMap((rule) => {
      const bucket = this.buckets.get(rule) ?? [];
      return bucket.map((line) => `${rule}：${line}`);
    });
    const evidenceOnly = rules.every((rule) => EVIDENCE_RULES.includes(rule));
    throw new BusinessValidationError(
      rules[0] ?? "evidence_traceable",
      issues,
      evidenceOnly ? "evidence_unmapped" : "business_validation",
    );
  }
}

/**
 * 时间五元组相容（§3.8 / B8 / P14，规则原文见 `enums.json` 的 `event_time_rules.compatibility`）：
 * unknown ⇒ 起止皆空且 certainty=unknown；year/month/day ⇒ 起止齐全、精确覆盖完整年度/自然月/单日、
 * start<=end、raw 非空、certainty∈{explicit,approximate}。
 * 库里同一规则由 0003 的 CHECK 兜住，这里提前拒：业务门的存在意义就是不让注定被 CHECK 拒的输出白跑一趟。
 *
 * 返回**未满足项的描述**（空数组即相容）——收集失败的责任在调用方，本函数只做判定。
 */
export function eventTimeViolations(time: ExtractedEventTime): string[] {
  const out: string[] = [];
  if (ENUM_VALUES.event_time_rules["compatibility"] === undefined) {
    return ["enums.json 缺少 compatibility 规则原文，无法核对"];
  }
  if (time.precision === "unknown") {
    if (time.certainty !== "unknown" || time.start !== null || time.end !== null) {
      out.push("precision=unknown 必须同时 certainty=unknown 且起止皆空");
    }
    return out;
  }
  const required: string[] = [];
  if (time.raw === null) required.push("raw 非空");
  if (time.start === null || time.end === null) required.push("起止齐全");
  if (time.certainty === "unknown") required.push("certainty∈{explicit,approximate}");
  if (time.start !== null && time.end !== null && time.start > time.end) required.push("start<=end");
  if (required.length > 0) {
    return [`precision=${time.precision} 未满足：${required.join("、")}`];
  }
  const start = time.start as string;
  const end = time.end as string;
  if (time.precision === "year" && !(start.endsWith("-01-01") && end.endsWith("-12-31"))) {
    out.push("year 必须精确覆盖完整年度 01-01..12-31");
  }
  if (time.precision === "month") {
    const parts = start.split("-");
    const year = Number(parts[0]);
    const month = Number(parts[1]);
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const coverage = `-${String(lastDay).padStart(2, "0")}`;
    if (!start.endsWith("-01") || !end.endsWith(coverage) || start.slice(0, 7) !== end.slice(0, 7)) {
      out.push("month 必须精确覆盖单个自然月");
    }
  }
  if (time.precision === "day" && start !== end) {
    out.push("day 的起止必须是同一天");
  }
  return out;
}

/**
 * 第二道门：事实。全部失败一次性收集后抛出（不是首错即停）——
 * M2-5 需要知道这条回稿一共坏在哪，才能按 §7.6.4 生成 `evidence_repair` 建议，
 * 而不是修一条再撞下一条。
 */
export function validateBusiness(
  output: StructuredOutput,
  context: BusinessValidationContext,
): BusinessValidationResult {
  const issues = new IssueCollector();
  const knownConcepts = context.knownConcepts ?? seedConceptIndex();
  const knownEntityIds = context.knownEntityIds ?? new Set<string>();
  /** 这道门的去向：攒进致命收集器，最后整批抛（`validateRelations()` 用的是另一个去向）。 */
  const fatal: IssueReport = (rule, target, detail) => issues.add(rule, target, detail);

  /** §5.3 + K-23：脱敏坐标的证据 → 原文坐标 + 逐字一致性。返回 null 即不可采信。 */
  const anchor = (target: string, evidence: string): ValidatedEvidence | null =>
    resolveAnchor(context, fatal, target, evidence);

  /** §5.3「占位符必须完全沿用」+ §11-隐私「未知/非法占位符不得映射到真实实体」。 */
  const checkPlaceholders = (target: string, evidence: string): void =>
    checkPlaceholdersAgainstSentText(context, fatal, target, evidence);

  const checkCandidateId = (
    target: string,
    collection: "emotions" | "topics" | "entities",
    id: string | null,
  ): void => {
    if (id === null) return;
    const expectedPrefix = collection === "entities" ? `${ID_PREFIXES.entity}_` : `${ID_PREFIXES.concept}_`;
    if (!id.startsWith(expectedPrefix)) {
      issues.add("candidate_id_valid", target, `${collection} 的候选 ID 必须带 ${expectedPrefix} 前缀，收到 ${id}`);
      return;
    }
    if (collection === "entities") {
      if (!knownEntityIds.has(id)) {
        issues.add("candidate_id_valid", target, `实体候选不在已知实体集内，匹配依据不足：${id}`);
      }
      return;
    }
    const domain = knownConcepts.get(id);
    if (domain === undefined) {
      issues.add("candidate_id_valid", target, `候选概念 ID 不在本地词表内（模型无权新建概念，K-14）：${id}`);
      return;
    }
    const want = collection === "emotions" ? "emotion" : "topic";
    if (domain !== want) {
      issues.add("candidate_id_valid", target, `候选概念域不匹配：${collection} 拿到 ${domain}（${id}）`);
    }
  };

  const validateLabel = (
    collection: "emotions" | "topics" | "entities",
    item: ExtractedLabel,
    index: number,
    accepted: ValidatedLabel[],
  ): void => {
    const target = `${collection}[${index}]`;
    const anchored = anchor(target, item.evidence);
    checkPlaceholders(target, item.evidence);
    checkCandidateId(target, collection, item.candidateConceptId);
    if (collection === "entities") {
      const said = item.labelSaid.normalize("NFC");
      const grounded =
        item.evidence.normalize("NFC").includes(said) ||
        (anchored !== null && anchored.evidenceText.normalize("NFC").includes(said));
      if (!grounded) {
        issues.add("entity_basis_sufficient", target, "实体候选在所引证据中没有逐字依据，匹配依据不足");
      }
    }
    if (anchored === null) return;
    accepted.push({
      ...anchored,
      labelSaid: item.labelSaid,
      candidateConceptId: item.candidateConceptId,
      basis: item.basis,
      // §3.2.2 推论 + ADR-014：inferred 的 ai_generated Mention 在库里就非法，这里根本不放行。
      route: item.basis !== "explicit"
        ? collection === "emotions"
          ? "suggestion"
          : "unrouted"
        : "mention",
      suggestionKind: item.basis !== "explicit" && collection === "emotions" ? "emotion_candidate" : null,
    });
  };

  const episodes: ValidatedEpisode[] = [];
  output.episodes.forEach((episode, index) => {
    const target = `episodes[${index}]`;
    const anchored = anchor(target, episode.evidence);
    checkPlaceholders(target, episode.evidence);
    for (const violation of eventTimeViolations(episode.eventTime)) {
      issues.add("event_time_compatible", target, violation);
    }
    if (anchored !== null) episodes.push({ ...anchored, summary: episode.summary, eventTime: episode.eventTime });
  });

  const thoughts: ValidatedThought[] = [];
  output.thoughts.forEach((thought, index) => {
    const target = `thoughts[${index}]`;
    const anchored = anchor(target, thought.evidence);
    checkPlaceholders(target, thought.evidence);
    if (anchored !== null) thoughts.push({ ...anchored, text: thought.text });
  });

  const groups: Record<"emotions" | "topics" | "entities", ValidatedLabel[]> = {
    emotions: [],
    topics: [],
    entities: [],
  };
  (["emotions", "topics", "entities"] as const).forEach((collection) => {
    output[collection].forEach((item, index) => validateLabel(collection, item, index, groups[collection]));
  });

  // 标题/摘要同样是要入库的派生文本，不得夹带编造标识（同上一条规则）。
  for (const field of ["title", "summary"] as const) {
    const text = output[field];
    for (const match of text.matchAll(PLACEHOLDER_SHAPE)) {
      if (!context.sentText.includes(match[0])) {
        issues.add("placeholder_untouched", field, `摘要中出现输入文本里没有的占位符：${match[0]}`);
      }
    }
  }

  issues.throwIfAny();

  return {
    title: output.title,
    summary: output.summary,
    episodes,
    thoughts,
    emotions: groups.emotions,
    topics: groups.topics,
    entities: groups.entities,
    checkedRules: BUSINESS_RULES,
  };
}

/* ── 关系门（M7-2，准则 §3.4）─────────────────────────────────────── */

/**
 * 关系专属的三条判据。**不加进 `BUSINESS_RULES`**：那份清单是 Trace 里
 * `businessValidation.rules` 的记账面（六条「坏即整批不采信」的规则，`m2-provider` 逐条对账），
 * 而关系坏只作废那一条——两者去向不同，混进同一张台账会让 Trace 声称一次成功的 run 拒过什么。
 * 证据回锚与占位符两条沿用 `BusinessRule` 的同名标识，判据与实现本就同源（`resolveAnchor`）。
 */
export const RELATION_RULES = [
  "relation_type_allowed",
  "relation_endpoints_distinct",
  "relation_label_grounded",
] as const;

export type RelationRule = (typeof RELATION_RULES)[number];

/** 关系门上报的判据：三条关系专属 + 三条与标签门同名的证据/占位符规则。 */
export type RelationGateRule = RelationRule | BusinessRule;

/** 通过关系门的一条关系：四个字段 + 回锚后的原文坐标（写入面属 M7-2b）。 */
export interface ValidatedRelation extends ValidatedEvidence {
  readonly relationType: string;
  readonly srcLabel: string;
  readonly dstLabel: string;
}

export interface DiscardedRelation {
  readonly index: number;
  /** `relations[3]`：与致命门同形的定位串，issue 文案可以直接给运维看。 */
  readonly target: string;
  /** 一条坏关系可以同时坏在两处（既同词又无逐字依据），这里逐条留痕而不是只报第一个。 */
  readonly reasons: readonly { readonly rule: RelationGateRule; readonly detail: string }[];
}

export interface RelationValidationResult {
  readonly relations: readonly ValidatedRelation[];
  readonly discarded: readonly DiscardedRelation[];
}

/** 允许抽取的关系类型：`enums.json` 里「GraphEdge 载体 ∧ 模型可创建」的那一集（六值，E-07 不抄清单）。 */
const RELATION_TYPES_ALLOWED: readonly string[] = aiCreatableGraphEdgeRelationTypes(ENUM_VALUES);

/**
 * 关系的事实门（准则 §3.4）。四道判据逐条走，坏的**只丢那一条**：关系是增量产出，
 * 一条坏关系不得毁掉整次解析，所以这里既不碰 `IssueCollector`，也不抛
 * `BusinessValidationError`——去向是返回值里的丢弃清单，由写入侧计数。
 *
 * 端点是否解析到在册 `active` 实体、是否属于本条记录，属 §3.5 的写入面（M7-2b），不在这里。
 */
export function validateRelations(
  output: StructuredOutput,
  context: BusinessValidationContext,
): RelationValidationResult {
  const accepted: ValidatedRelation[] = [];
  const discarded: DiscardedRelation[] = [];

  output.relations.forEach((relation, index) => {
    const target = `relations[${index}]`;
    const reasons: { rule: RelationGateRule; detail: string }[] = [];
    /** 这道门的去向：记进本条的丢弃清单，不进致命收集器。 */
    const report = (rule: RelationGateRule, detail: string): void => {
      reasons.push({ rule, detail });
    };
    /** 同一个上报口喂给共用的证据/占位符实现：它们只报 `BusinessRule`，那是本集合的子集。 */
    const reportEvidence: IssueReport = (rule, _target, detail) => report(rule, detail);

    if (!RELATION_TYPES_ALLOWED.includes(relation.relationType)) {
      report(
        "relation_type_allowed",
        `关系类型不在模型可抽取的集合内（${RELATION_TYPES_ALLOWED.join(" / ")}）：${relation.relationType}`,
      );
    }
    if (relation.srcLabel.normalize("NFC") === relation.dstLabel.normalize("NFC")) {
      report("relation_endpoints_distinct", `两端是同一个词面，不构成关系：${relation.srcLabel}`);
    }

    checkPlaceholdersAgainstSentText(context, reportEvidence, target, relation.evidence);
    const anchored = resolveAnchor(context, reportEvidence, target, relation.evidence);

    // 词面逐字依据：两端各查一次（缺哪一个就点名哪一个）。
    for (const [role, term] of [
      ["srcLabel", relation.srcLabel],
      ["dstLabel", relation.dstLabel],
    ] as const) {
      if (!termGroundedIn(anchored, relation.evidence, term)) {
        report("relation_label_grounded", `${role}「${term}」在所引证据里没有逐字依据`);
      }
    }

    // 回锚不出坐标必然已记账（`resolveAnchor` 的两个 null 分支各自报一条），后半句只是让类型收敛。
    if (anchored === null || reasons.length > 0) {
      discarded.push({ index, target, reasons });
      return;
    }
    accepted.push({
      ...anchored,
      relationType: relation.relationType,
      srcLabel: relation.srcLabel,
      dstLabel: relation.dstLabel,
    });
  });

  return { relations: accepted, discarded };
}

/** 给 Trace 用的错误类别收敛：两道门抛出的错误都带封闭 kind。 */
export function errorKindOf(cause: unknown): ParseErrorKind | null {
  if (cause instanceof ContractSchemaError) return cause.kind;
  if (cause instanceof BusinessValidationError) return cause.kind;
  return null;
}
