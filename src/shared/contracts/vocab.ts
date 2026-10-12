import { z } from "zod";

/** 别名模式：只有词表数据文件有权设定 auto（规格 §4.3、ADR-014）。 */
export const aliasModeSchema = z.enum(["auto", "suggest"]);
export type AliasMode = z.infer<typeof aliasModeSchema>;

export const aliasSchema = z
  .object({
    alias: z.string().min(1),
    mode: aliasModeSchema,
  })
  .strict();

export const vocabConceptSchema = z
  .object({
    canonical_name: z.string().min(1),
    aliases: z.array(aliasSchema).default([]),
  })
  .strict();

export const vocabFileSchema = z
  .object({
    kind: z.enum(["emotion", "topic"]),
    schema_version: z.number().int().positive(),
    spec_ref: z.string().min(1),
    id_rule: z.string().min(1),
    rules: z.record(z.string(), z.string()),
    concepts: z.array(vocabConceptSchema).min(1),
  })
  .strict();

export type VocabFile = z.infer<typeof vocabFileSchema>;
export type VocabConcept = z.infer<typeof vocabConceptSchema>;

export class VocabContractError extends Error {
  constructor(issues: string[]) {
    super(`词表数据契约不成立：\n  - ${issues.join("\n  - ")}`);
    this.name = "VocabContractError";
  }
}

/**
 * 结构合法之外的业务校验：重复名、别名撞标准名、同一别名指向两个概念、
 * 别名与自身标准名相同。这些都会让归一化结果不确定，属于契约错误。
 */
export function validateVocab(vocab: VocabFile): VocabFile {
  const issues: string[] = [];
  const names = vocab.concepts.map((c) => c.canonical_name);
  const dupNames = names.filter((n, i) => names.indexOf(n) !== i);
  if (dupNames.length > 0) issues.push(`标准名重复：${[...new Set(dupNames)].join("、")}`);

  const aliasOwner = new Map<string, string>();
  for (const concept of vocab.concepts) {
    for (const entry of concept.aliases) {
      if (entry.alias === concept.canonical_name) {
        issues.push(`别名与标准名相同（应由标准名命中，不进别名表）：${entry.alias}`);
      }
      if (names.includes(entry.alias)) {
        issues.push(`别名指向了另一个标准概念：${entry.alias}`);
      }
      const owner = aliasOwner.get(entry.alias);
      if (owner !== undefined && owner !== concept.canonical_name) {
        issues.push(`同一别名指向两个概念：${entry.alias} → ${owner} / ${concept.canonical_name}`);
      }
      aliasOwner.set(entry.alias, concept.canonical_name);
    }
  }
  if (issues.length > 0) throw new VocabContractError(issues);
  return vocab;
}

export function parseVocab(raw: unknown, sourceName: string): VocabFile {
  const parsed = vocabFileSchema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n  - ");
    throw new VocabContractError([`${sourceName} 结构不符合词表 Schema\n  - ${detail}`]);
  }
  return validateVocab(parsed.data);
}

/** 期望数量是产品决策的一部分（36 情绪 / 18 主题），变了必须显式改这里。 */
export const EXPECTED_VOCAB_SIZE = { emotion: 36, topic: 18 } as const;

export function assertVocabSize(vocab: VocabFile): void {
  const expected = EXPECTED_VOCAB_SIZE[vocab.kind];
  const actual = vocab.concepts.length;
  if (actual !== expected) {
    throw new VocabContractError([`${vocab.kind} 词表数量 ${actual} != 规格约定 ${expected}`]);
  }
}

export function autoAliases(vocab: VocabFile): Array<{ alias: string; concept: string }> {
  return vocab.concepts.flatMap((c) => c.aliases.filter((a) => a.mode === "auto").map((a) => ({ alias: a.alias, concept: c.canonical_name })));
}
