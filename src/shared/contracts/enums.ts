import { z } from "zod";

export const RELATION_CARRIERS = ["derived_from_mention", "GraphEdge", "TriggerAssertion", "Suggestion"] as const;

export const relationTypeSchema = z
  .object({
    type: z.string().min(1),
    carrier: z.enum(RELATION_CARRIERS),
    source: z.string().min(1),
    target: z.string().min(1),
    directed: z.boolean(),
    creators: z.array(z.string()).min(1),
  })
  .strict();

export const lifecycleStateSchema = z
  .object({
    values: z.array(z.string()).min(1),
    transitions: z.record(z.string(), z.array(z.string())),
    notes: z.string().optional(),
  })
  .strict();

/** 规则表：文字说明、清单、布尔标记三类内容混在一张表里，取值本身受封闭集规则约束。 */
export const ruleTableSchema = z.record(z.string(), z.union([z.string(), z.array(z.string()), z.boolean()]));

export const basisOriginMatrixSchema = z
  .object({
    legal: z.string().min(1),
    illegal: z.array(z.string().min(1)).min(1),
  })
  .strict();

/**
 * 合法组合矩阵的一行（草案 §三）。`axes` 是 `analysis_provider | redaction_mode | send_content_mode`
 * 的字面量三元组，由 `validateEnums` 解析并核对成员资格——放在这里而不写进 schema 的 z.enum，
 * 是为了让「引用了未声明取值」以契约问题的形式报出来，而不是 zod 的路径错误。
 */
export const threeAxisMatrixRowSchema = z
  .object({
    row: z.number().int().min(1).max(12),
    axes: z.string().min(1),
    legal: z.boolean(),
    reason: z.string().min(1),
  })
  .strict();

/**
 * 三轴契约的规则表（M6-0C / 草案 §三、§四、§五、§八之三）。
 *
 * 长度是被钉住的：`combination_matrix` 恰好 12 行、`derived_processing_mode` 恰好 4 条、
 * `legacy_axis_mapping` 恰好 3 行。这不是冗余的严格——`validateEnums` 会把这三份声明与
 * `isLegalCombination` / `deriveProcessingMode` / `AXES_BY_PROCESSING_MODE` 的实现**逐组合对账**，
 * 一旦有人只改 JSON 或只改代码，装载即失败。
 */
export const threeAxisRulesSchema = z
  .object({
    note: z.string().min(1),
    spec_ref: z.string().min(1),
    placeholder_unimplemented: z.array(z.string().min(1)),
    placeholder_note: z.string().min(1),
    send_content_mode_note: z.string().min(1),
    send_content_mode_domains: z.string().min(1),
    egress_gate: z.string().min(1),
    combination_matrix: z.array(threeAxisMatrixRowSchema).length(12),
    matrix_completeness: z.string().min(1),
    derived_processing_mode: z.array(z.string().min(1)).length(4),
    legacy_axis_mapping: z.array(z.string().min(1)).length(3),
    legacy_axis_mapping_note: z.string().min(1),
    cloud_raw_is_separate_value: z.string().min(1),
  })
  .strict();

export const enumFileSchema = z
  .object({
    schema_version: z.number().int().positive(),
    spec_ref: z.string().min(1),
    note: z.string(),
    relation_types: z.array(relationTypeSchema).min(1),
    relation_type_rules: ruleTableSchema,
    entity_types: z.array(z.string()).min(1),
    entity_type_rules: ruleTableSchema,
    mention_source_kinds: z.array(z.string()).length(3),
    mention_source_rule: z.string(),
    origin_types: z.array(z.string()).length(4),
    origin_type_subsets: ruleTableSchema,
    basis_values: z.array(z.string()).length(2),
    basis_origin_matrix: basisOriginMatrixSchema,
    lifecycle_states: z.record(z.string(), lifecycleStateSchema),
    processing_modes: z.array(z.string()).length(4),
    analysis_providers: z.array(z.string()).length(3),
    redaction_modes: z.array(z.string()).length(3),
    send_content_modes: z.array(z.string()).length(3),
    three_axis_rules: threeAxisRulesSchema,
    processing_statuses: z.array(z.string()).min(1),
    processing_status_transitions: lifecycleStateSchema,
    processing_rules: ruleTableSchema,
    suggestion_kinds: z.array(z.string()).min(1),
    event_time_precision: z.array(z.string()).length(4),
    event_time_certainty: z.array(z.string()).length(3),
    event_time_rules: ruleTableSchema,
    privacy_levels: z.array(z.string()).min(1),
    sleep_session_states: z.array(z.string()).length(2),
    closed_set_rule: z.string(),
  })
  .strict();

export type EnumFile = z.infer<typeof enumFileSchema>;
export type RelationType = z.infer<typeof relationTypeSchema>;

/* ── M6-0C 三轴：代码侧字面量，与 enums.json 在装载时对账 ─────────────────── */

/** 派生兼容字段 `processing_mode` 的取值（第 4 值 `cloud_raw` 由三轴新增，见草案 §五）。 */
export const PROCESSING_MODE_VALUES = ["manual_only", "local_model", "cloud_redacted", "cloud_raw"] as const;
export type ProcessingModeValue = (typeof PROCESSING_MODE_VALUES)[number];

/**
 * 把外部输入（DTO 的宽 `string`、配置文件、测试夹具）收窄成契约值。
 *
 * 存在理由不是省一次 cast：`processing_mode` 在 `RecordRow` 上刻意保持宽类型，
 * 而派生与合法性判定需要值类型。各处自己抄一份 `.includes()` 检查迟早会各抄成三套，
 * 所以判定归这里——与取值清单同处一地，改枚举时不可能漏改。
 */
export function isProcessingModeValue(value: string): value is ProcessingModeValue {
  return (PROCESSING_MODE_VALUES as readonly string[]).includes(value);
}

export const ANALYSIS_PROVIDER_VALUES = ["local", "cloud", "none"] as const;
export type AnalysisProvider = (typeof ANALYSIS_PROVIDER_VALUES)[number];

export const REDACTION_MODE_VALUES = ["local_llm", "manual", "none"] as const;
export type RedactionMode = (typeof REDACTION_MODE_VALUES)[number];

export const SEND_CONTENT_MODE_VALUES = ["redacted", "raw", "none"] as const;
export type SendContentMode = (typeof SEND_CONTENT_MODE_VALUES)[number];

/**
 * 占位、无实现的 `redaction_mode` 取值（草案 §八之三）。
 *
 * **当前为空**（M9-D-11）：`local_llm` 在 M9 落了实现，三个取值都有真身，没有占位档了。
 * 机制本身保留——取值域一直完整保留三值（重启一条路线不必再升一次契约），而「哪几档没实现」
 * 这件事需要一个能被对账的表达处：`enums.json` 的 `three_axis_rules.placeholder_unimplemented`
 * 与本清单由 `validateEnums` 逐值对账，两处一旦漂移，装载就失败，而不是留一条死分支。
 * 下一次真出现占位档时，改这两处即可，闸门（`egressPreview` / `provider`）不再需要新代码。
 */
export const UNIMPLEMENTED_REDACTION_MODES: readonly RedactionMode[] = [];

/** 三轴的组合面。列名与 0008 迁移的 `analysis_provider` / `redaction_mode` / `send_content_mode` 同源。 */
export interface ThreeAxes {
  readonly analysisProvider: AnalysisProvider;
  readonly redactionMode: RedactionMode;
  readonly sendContentMode: SendContentMode;
}

/**
 * 组合不合法（草案 §三 矩阵 / §七 断言 1、5）。
 *
 * 消息里只有三个轴的取值与规则依据：都是封闭枚举成员，不含原文、不含姓名，
 * 因此可以进日志与错误响应（指令 §11.2 的敏感面约束）。
 */
export class ThreeAxisCombinationError extends Error {
  readonly axes: ThreeAxes;

  constructor(axes: ThreeAxes, rule: string) {
    super(
      `三轴组合不合法：analysis_provider=${axes.analysisProvider} + redaction_mode=${axes.redactionMode}` +
        ` + send_content_mode=${axes.sendContentMode}（${rule}）`,
    );
    this.name = "ThreeAxisCombinationError";
    this.axes = axes;
  }
}

/**
 * 组合合法性：照抄草案 §三「派生规则」四条蕴含式，不逐行写 12 个 if。
 *
 * ```text
 * raw      ⟺ cloud ∧ ¬none(redaction)
 * redacted ⟹ cloud ∧ ¬none(redaction)
 * none     ⟺ analysis_provider ≠ cloud
 * local    ⟹ redaction_mode ≠ none      （v1 限制，矩阵 #6）
 * ```
 *
 * 第 3 条是双向的，所以 `cloud + * + none` 一律非法：判定源是三轴，
 * 「不外发」与「云端分析」不能同时成立。
 */
export function isLegalCombination(axes: ThreeAxes): boolean {
  const { analysisProvider, redactionMode, sendContentMode } = axes;
  if (sendContentMode === "raw") return analysisProvider === "cloud" && redactionMode === "none";
  if (sendContentMode === "redacted") return analysisProvider === "cloud" && redactionMode !== "none";
  // send_content_mode === none
  if (analysisProvider === "cloud") return false;
  if (analysisProvider === "local" && redactionMode === "none") return false;
  return true;
}

/** 逐组合的规则依据，用于错误消息与 §七 断言 1 的逐行定位。 */
function combinationRule(axes: ThreeAxes): string {
  const { analysisProvider, redactionMode, sendContentMode } = axes;
  if (sendContentMode === "raw") {
    return analysisProvider === "cloud"
      ? "raw 当且仅当 cloud + 不脱敏"
      : "raw 要求 analysis_provider=cloud（草案 §三 规则 1）";
  }
  if (sendContentMode === "redacted") {
    return redactionMode === "none"
      ? "未脱敏却声称发送脱敏文本（矩阵 #12）"
      : "redacted 要求 analysis_provider=cloud（草案 §三 规则 2）";
  }
  return analysisProvider === "cloud"
    ? "不外发与云端分析不能同时成立（草案 §三 规则 3）"
    : "本地分析必须使用脱敏文本（矩阵 #6，R2 裁决）";
}

/** 闸门入口：组合不成立即抛，调用方因此拿不到任何可发送的东西。 */
export function assertThreeAxes(axes: ThreeAxes): void {
  if (!isLegalCombination(axes)) throw new ThreeAxisCombinationError(axes, combinationRule(axes));
}

/** §五 派生规则：三轴 → 兼容字段。只在合法组合上有意义。 */
export function deriveProcessingMode(axes: ThreeAxes): ProcessingModeValue {
  assertThreeAxes(axes);
  if (axes.analysisProvider === "none") return "manual_only";
  if (axes.analysisProvider === "local") return "local_model";
  return axes.sendContentMode === "raw" ? "cloud_raw" : "cloud_redacted";
}

/**
 * §四 旧值映射（0008 回填依据）加 `cloud_raw` 的轴组。
 *
 * **有损**：`local_model` 只对应 `(local, manual, none)`，而 `(local, local_llm, none)`
 * 派生后同为 `local_model`——所以三轴必须进导出面（草案 §八之二-4），
 * 这个反向映射只用于「手里只有 processing_mode」的兼容入口，不用于恢复历史三轴。
 */
export const AXES_BY_PROCESSING_MODE: Readonly<Record<ProcessingModeValue, ThreeAxes>> = Object.freeze({
  manual_only: { analysisProvider: "none", redactionMode: "manual", sendContentMode: "none" },
  local_model: { analysisProvider: "local", redactionMode: "manual", sendContentMode: "none" },
  cloud_redacted: { analysisProvider: "cloud", redactionMode: "manual", sendContentMode: "redacted" },
  cloud_raw: { analysisProvider: "cloud", redactionMode: "none", sendContentMode: "raw" },
} as Record<ProcessingModeValue, ThreeAxes>);

export function axesForProcessingMode(mode: ProcessingModeValue): ThreeAxes {
  return AXES_BY_PROCESSING_MODE[mode];
}

/** 封闭集外的轴取值（来自库里行、JSONL 行或请求体）。消息只带字段名与标签，不带原值。 */
export class ThreeAxisValueError extends Error {
  readonly field: string;

  constructor(field: string, label: string) {
    super(`三轴取值不在封闭集内：${field}（${label}）`);
    this.name = "ThreeAxisValueError";
    this.field = field;
  }
}

/**
 * 从「三个字符串」读回三轴（0008 的列、JSONL 的行、请求体的显式字段共用这一道门）。
 *
 * 不在册的取值一律拒，**不静默兜底**成保守组合：判定源就是这三列，兜底等于替用户改写
 * 隐私承诺（草案 §一-4「判定点分散」的教训）。
 */
export function coerceAxes(analysisProvider: string, redactionMode: string, sendContentMode: string): ThreeAxes {
  const axes: ThreeAxes = {
    analysisProvider: analysisProvider as AnalysisProvider,
    redactionMode: redactionMode as RedactionMode,
    sendContentMode: sendContentMode as SendContentMode,
  };
  if (!ANALYSIS_PROVIDER_VALUES.includes(axes.analysisProvider)) {
    throw new ThreeAxisValueError("analysis_provider", "analysis_providers");
  }
  if (!REDACTION_MODE_VALUES.includes(axes.redactionMode)) {
    throw new ThreeAxisValueError("redaction_mode", "redaction_modes");
  }
  if (!SEND_CONTENT_MODE_VALUES.includes(axes.sendContentMode)) {
    throw new ThreeAxisValueError("send_content_mode", "send_content_modes");
  }
  return axes;
}

/** 内容是否离开本机：闸门的唯一判据（草案 §五，取代 `=== "cloud_redacted"` 字面量分支）。 */
export function isEgress(axes: ThreeAxes): boolean {
  return axes.sendContentMode !== "none";
}

/**
 * 这一档是不是「取值在册、实现缺席」的占位档。
 *
 * **当前恒为 `false`**（M9-D-11：清单为空）。保留导出而不是删掉：判定源与对账都走这一条，
 * `validateThreeAxisContract` 的旧值映射护栏（「不许把占位取值当回填事实源」）也靠它——
 * 清单重新非空那天，这两处自动恢复效力，不需要有人想起来再写一遍。
 */
export function isUnimplementedRedactionMode(mode: RedactionMode): boolean {
  return UNIMPLEMENTED_REDACTION_MODES.includes(mode);
}

export class EnumContractError extends Error {
  constructor(issues: string[]) {
    super(`枚举契约不成立：\n  - ${issues.join("\n  - ")}`);
    this.name = "EnumContractError";
  }
}

/**
 * 状态机自洽性：每个转换的源与目标都必须是该集合里的合法取值。
 * 这条检查存在的意义是——迁移脚本的 CHECK 约束由这些值生成，值写错就等于数据库层写错。
 */
export function validateEnums(enums: EnumFile): EnumFile {
  const issues: string[] = [];

  const checkTransitions = (name: string, spec: { values: string[]; transitions: Record<string, string[]> }) => {
    const set = new Set(spec.values);
    if (set.size !== spec.values.length) issues.push(`${name} 存在重复取值`);
    for (const [from, targets] of Object.entries(spec.transitions)) {
      if (!set.has(from)) issues.push(`${name} 的转换源不在取值集合中：${from}`);
      for (const to of targets) {
        if (!set.has(to)) issues.push(`${name} 的转换目标不在取值集合中：${from} → ${to}`);
      }
    }
    for (const value of spec.values) {
      if (!(value in spec.transitions)) issues.push(`${name} 的取值缺少转换声明：${value}`);
    }
  };

  for (const [name, spec] of Object.entries(enums.lifecycle_states)) checkTransitions(name, spec);

  // I3：处理状态机的取值集合必须与 processing_statuses 完全一致——迁移 CHECK 由后者生成，
  // 两处一旦漂移，状态机就是在约束一个数据库根本不存在的值域。
  const psTransitions = new Set(enums.processing_status_transitions.values);
  const psDeclared = new Set(enums.processing_statuses);
  if (psTransitions.size !== enums.processing_status_transitions.values.length) {
    issues.push("processing_status_transitions 存在重复取值");
  }
  for (const v of psDeclared) if (!psTransitions.has(v)) issues.push(`processing_status 取值未进入转换表：${v}`);
  for (const v of psTransitions) if (!psDeclared.has(v)) issues.push(`转换表引用了未声明的 processing_status：${v}`);
  checkTransitions("processing_status_transitions", enums.processing_status_transitions);

  const types = enums.relation_types.map((r) => r.type);
  if (new Set(types).size !== types.length) issues.push(`关系类型重复：${types.join("、")}`);

  const graphEdgeTargets = new Set(["Episode", "Concept", "Entity:active", "Entity"]);
  for (const rel of enums.relation_types) {
    if (rel.carrier === "GraphEdge" && (!graphEdgeTargets.has(rel.source) || !graphEdgeTargets.has(rel.target))) {
      issues.push(`GraphEdge 端点必须属于可视节点集合：${rel.type}（${rel.source} → ${rel.target}）`);
    }
    if (rel.creators.includes("ai_suggestion") && rel.carrier === "GraphEdge") {
      issues.push(`AI 建议不得直接以 GraphEdge 为载体：${rel.type}`);
    }
  }

  const notStored = enums.relation_type_rules["not_stored_in_graph_edge"];
  if (Array.isArray(notStored)) {
    for (const t of notStored) {
      const rel = enums.relation_types.find((r) => r.type === t);
      if (rel && rel.carrier === "GraphEdge") issues.push(`规则声明不入 GraphEdge，但载体是 GraphEdge：${t}`);
    }
  }

  // basis ⊥ origin_type 的非法组合必须用**已声明的取值**表达，否则规则会随着改名悄悄失效。
  const basis = new Set(enums.basis_values);
  const origins = new Set(enums.origin_types);
  const combination = /basis\s*=\s*([a-z_]+)\s*\+\s*origin_type\s*=\s*([a-z_]+)/g;
  for (const entry of enums.basis_origin_matrix.illegal) {
    let matched = false;
    for (const match of entry.matchAll(combination)) {
      const value = match[1];
      const origin = match[2];
      if (value === undefined || origin === undefined) continue;
      matched = true;
      if (!basis.has(value)) issues.push(`非法组合引用了未声明的 basis：${entry}`);
      if (!origins.has(origin)) issues.push(`非法组合引用了未声明的 origin_type：${entry}`);
    }
    if (!matched) issues.push(`非法组合无法解析为 basis + origin_type：${entry}`);
  }

  validateThreeAxisContract(enums, issues);

  if (issues.length > 0) throw new EnumContractError(issues);
  return enums;
}

const TRIPLE_PATTERN = /^([a-z_*]+)\|([a-z_*]+)\|([a-z_*]+)$/;
const DERIVED_PATTERN = /^([a-z_*]+)\|([a-z_*]+)\|([a-z_*]+)\s*=>\s*([a-z_]+)$/;
const LEGACY_PATTERN = /^([a-z_]+)\s*=>\s*([a-z_*]+)\|([a-z_*]+)\|([a-z_*]+)$/;

/**
 * 三轴契约对账（T-16 手法）：`enums.json` 里的声明与代码里的实现逐组合比对。
 *
 * - 值域：四份清单与代码字面量**同序**（迁移 CHECK 与 trace 门都从这里生成，序不同就等于两处不同）。
 * - 矩阵：12 行行号不重不漏；每行 `axes` 的三个取值都已声明；实现判定的合法性与 `legal` 一致。
 *   全空间 27 个组合逐个核对，期望值取自行声明、**未列出的组合期望为非法**
 *   （草案只列有语义的 12 行，剩下 15 个由蕴含规则天然排除；实现若放行它们就是漂移）。
 * - 派生规则：规则覆盖到的合法组合，派生结果必须与 `deriveProcessingMode` 一致，且合法组合全覆盖。
 * - 旧值映射：每行落到合法组合、正向派生回到该旧值（§七 断言 2「派生列与旧值一致」的静态面），
 *   并且不把占位取值当回填事实源。
 * - 占位清单：与 `UNIMPLEMENTED_REDACTION_MODES` 逐值相等。
 */
function validateThreeAxisContract(enums: EnumFile, issues: string[]): void {
  const rules = enums.three_axis_rules;

  const sameOrder = (declared: readonly string[], literal: readonly string[], label: string) => {
    if (declared.length !== literal.length || declared.some((v, i) => v !== literal[i])) {
      issues.push(`${label} 与代码字面量不同序或不同值：JSON=[${declared}] 代码=[${literal}]`);
    }
  };
  sameOrder(enums.processing_modes, PROCESSING_MODE_VALUES, "processing_modes");
  sameOrder(enums.analysis_providers, ANALYSIS_PROVIDER_VALUES, "analysis_providers");
  sameOrder(enums.redaction_modes, REDACTION_MODE_VALUES, "redaction_modes");
  sameOrder(enums.send_content_modes, SEND_CONTENT_MODE_VALUES, "send_content_modes");
  sameOrder(rules.placeholder_unimplemented, UNIMPLEMENTED_REDACTION_MODES, "three_axis_rules.placeholder_unimplemented");

  const analysisProviders = new Set<AnalysisProvider>(ANALYSIS_PROVIDER_VALUES);
  const redactionModes = new Set<RedactionMode>(REDACTION_MODE_VALUES);
  const sendContentModes = new Set<SendContentMode>(SEND_CONTENT_MODE_VALUES);

  const declared = new Map<string, boolean>();
  for (const entry of rules.combination_matrix) {
    const match = TRIPLE_PATTERN.exec(entry.axes);
    if (match === null) {
      issues.push(`矩阵 #${entry.row} 的 axes 无法解析为 ap|rm|sc：${entry.axes}`);
      continue;
    }
    const [ap, rm, sc] = [match[1], match[2], match[3]] as [string, string, string];
    if (!analysisProviders.has(ap as AnalysisProvider)) {
      issues.push(`矩阵 #${entry.row} 引用了未声明的 analysis_provider：${entry.axes}`);
    }
    if (!redactionModes.has(rm as RedactionMode)) {
      issues.push(`矩阵 #${entry.row} 引用了未声明的 redaction_mode：${entry.axes}`);
    }
    if (!sendContentModes.has(sc as SendContentMode)) {
      issues.push(`矩阵 #${entry.row} 引用了未声明的 send_content_mode：${entry.axes}`);
    }
    const key = `${ap}|${rm}|${sc}`;
    if (declared.has(key)) issues.push(`矩阵行重复声明同一组合：#${entry.row} ${key}`);
    declared.set(key, entry.legal);
  }
  const rowNumbers = rules.combination_matrix.map((r) => r.row);
  if (new Set(rowNumbers).size !== rowNumbers.length) issues.push("矩阵行号重复");
  for (let n = 1; n <= 12; n += 1) {
    if (!rowNumbers.includes(n)) issues.push(`矩阵缺少第 ${n} 行（草案 §三 的 12 行是契约面）`);
  }

  for (const axes of allCombinations()) {
    const expected = declared.get(keyOf(axes)) ?? false;
    const actual = isLegalCombination(axes);
    if (expected !== actual) {
      issues.push(
        `组合 ${keyOf(axes)}：${declared.has(keyOf(axes)) ? "声明" : "未声明，按非法"}为 legal=${expected}，实现判为 legal=${actual}`,
      );
    }
  }

  for (const entry of rules.derived_processing_mode) {
    const match = DERIVED_PATTERN.exec(entry);
    if (match === null) {
      issues.push(`派生规则无法解析为 ap|rm|sc => mode：${entry}`);
      continue;
    }
    const ap = match[1]!;
    const rm = match[2]!;
    const sc = match[3]!;
    const mode = match[4]!;
    if (ap !== "*" && !analysisProviders.has(ap as AnalysisProvider)) {
      issues.push(`派生规则引用了未声明的 analysis_provider：${entry}`);
    }
    if (rm !== "*" && !redactionModes.has(rm as RedactionMode)) {
      issues.push(`派生规则引用了未声明的 redaction_mode：${entry}`);
    }
    if (sc !== "*" && !sendContentModes.has(sc as SendContentMode)) {
      issues.push(`派生规则引用了未声明的 send_content_mode：${entry}`);
    }
    if (!(PROCESSING_MODE_VALUES as readonly string[]).includes(mode)) {
      issues.push(`派生规则的目标不在 processing_modes 内：${entry}`);
    }
    for (const axes of allCombinations()) {
      if (!isLegalCombination(axes) || !matchesRule(axes, ap, rm, sc)) continue;
      if (deriveProcessingMode(axes) !== mode) {
        issues.push(`派生规则与实现不一致：${keyOf(axes)} JSON=${mode} 实现=${deriveProcessingMode(axes)}`);
      }
    }
  }
  // 四条规则必须覆盖全部合法组合，否则「派生列由三轴生成」这件事有洞。
  for (const axes of allCombinations()) {
    if (!isLegalCombination(axes)) continue;
    const covered = rules.derived_processing_mode.some((entry) => {
      const match = DERIVED_PATTERN.exec(entry);
      return match !== null && matchesRule(axes, match[1]!, match[2]!, match[3]!);
    });
    if (!covered) issues.push(`合法组合没有任何派生规则覆盖：${keyOf(axes)}`);
  }

  const inverseAxes = AXES_BY_PROCESSING_MODE as Partial<Record<ProcessingModeValue, ThreeAxes>>;
  for (const entry of rules.legacy_axis_mapping) {
    const match = LEGACY_PATTERN.exec(entry);
    if (match === null) {
      issues.push(`旧值映射无法解析为 mode => ap|rm|sc：${entry}`);
      continue;
    }
    const mode = match[1]!;
    const ap = match[2]!;
    const rm = match[3]!;
    const sc = match[4]!;
    if (!(PROCESSING_MODE_VALUES as readonly string[]).includes(mode)) {
      issues.push(`旧值映射的旧值不在 processing_modes 内：${entry}`);
    }
    const axes: ThreeAxes = {
      analysisProvider: ap as AnalysisProvider,
      redactionMode: rm as RedactionMode,
      sendContentMode: sc as SendContentMode,
    };
    if (!analysisProviders.has(axes.analysisProvider) || !redactionModes.has(axes.redactionMode)
      || !sendContentModes.has(axes.sendContentMode)) {
      issues.push(`旧值映射引用了未声明的三轴取值：${entry}`);
      continue;
    }
    if (!isLegalCombination(axes)) issues.push(`旧值映射落到非法组合：${entry}`);
    else if (deriveProcessingMode(axes) !== mode) issues.push(`旧值映射正向派生不回到旧值：${entry}`);
    if (isUnimplementedRedactionMode(axes.redactionMode)) {
      issues.push(`旧值映射把占位取值当作回填事实源：${entry}`);
    }
    const inverse = inverseAxes[mode as ProcessingModeValue];
    if (inverse === undefined || keyOf(inverse) !== keyOf(axes)) {
      issues.push(`旧值映射与代码反向清单不一致：${entry}`);
    }
  }
}

function keyOf(axes: ThreeAxes): string {
  return `${axes.analysisProvider}|${axes.redactionMode}|${axes.sendContentMode}`;
}

function matchesRule(axes: ThreeAxes, ap: string, rm: string, sc: string): boolean {
  return (ap === "*" || ap === axes.analysisProvider)
    && (rm === "*" || rm === axes.redactionMode)
    && (sc === "*" || sc === axes.sendContentMode);
}

function allCombinations(): ThreeAxes[] {
  const out: ThreeAxes[] = [];
  for (const analysisProvider of ANALYSIS_PROVIDER_VALUES) {
    for (const redactionMode of REDACTION_MODE_VALUES) {
      for (const sendContentMode of SEND_CONTENT_MODE_VALUES) {
        out.push({ analysisProvider, redactionMode, sendContentMode });
      }
    }
  }
  return out;
}

export function parseEnums(raw: unknown): EnumFile {
  const parsed = enumFileSchema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n  - ");
    throw new EnumContractError([`enums.json 结构不符合 Schema\n  - ${detail}`]);
  }
  return validateEnums(parsed.data);
}

export function relationTypeNames(enums: EnumFile): string[] {
  return enums.relation_types.map((r) => r.type);
}

/** 允许写入 GraphEdge 的关系类型——迁移脚本的 CHECK 由它生成。 */
export function graphEdgeRelationTypes(enums: EnumFile): string[] {
  return enums.relation_types.filter((r) => r.carrier === "GraphEdge").map((r) => r.type);
}

export function userOnlyRelationTypes(enums: EnumFile): string[] {
  return enums.relation_types.filter((r) => r.creators.length === 1 && r.creators[0] === "user").map((r) => r.type);
}

/**
 * 模型**可以**提议、且落点是 `graph_edge` 的关系类型（M7-2 抽取面的允许集）。
 *
 * 判据只有 `creators` 这一份声明，不在任何调用方抄清单（E-07）：`carrier === "GraphEdge"`
 * 砍掉投影类与不入图类，`creators` 含 `ai_generated` 砍掉 `same_as` / `merged_into`
 * （它们与 `relation_type_rules.ai_may_never_create` 的对账由 `validateEnums` 与
 * `graph/store.ts` 的 K-18 门分别守着）。要扩这一集必须先回到准则 §二 的裁决表改 enums，
 * 而不是在抽取侧顺手加一个值。
 */
export function aiCreatableGraphEdgeRelationTypes(enums: EnumFile): string[] {
  return enums.relation_types
    .filter((r) => r.carrier === "GraphEdge" && r.creators.includes("ai_generated"))
    .map((r) => r.type);
}
