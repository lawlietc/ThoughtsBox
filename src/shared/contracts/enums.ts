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
    processing_modes: z.array(z.string()).length(3),
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

  if (issues.length > 0) throw new EnumContractError(issues);
  return enums;
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
