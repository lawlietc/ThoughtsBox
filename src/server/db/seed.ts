import { createHash } from "node:crypto";

import type { VocabFile } from "../../shared/contracts/vocab.ts";
import { seedConceptId, seedAliasId } from "../../shared/contracts/ids.ts";
import { loadContracts, type Contracts } from "../../shared/contracts/load.ts";
import type { Database } from "./adapter.ts";
import { setMeta } from "./migrator.ts";

export interface SeedEntry {
  readonly watermarkKey: string;
  readonly kind: "emotion" | "topic";
  readonly entryKind: "concept" | "alias";
  readonly conceptId: string;
  readonly canonicalName: string;
  readonly alias: string | null;
  readonly aliasMode: "auto" | "suggest" | null;
  readonly contentSha256: string;
}

function hash(...parts: string[]): string {
  return createHash("sha256").update(parts.join("\u0000").normalize("NFC")).digest("hex");
}

/**
 * 由词表数据文件生成播种条目（规格 §4.3、§9.3）。
 * 确定性 ID 让同一标准名在任何安装、任何次重放中得到同一个标识，因此重跑不产生第二条。
 */
export function buildSeedEntries(vocab: VocabFile): SeedEntry[] {
  const entries: SeedEntry[] = [];
  for (const concept of vocab.concepts) {
    const conceptId = seedConceptId(concept.canonical_name);
    entries.push({
      watermarkKey: `concept:${vocab.kind}:${conceptId}`,
      kind: vocab.kind,
      entryKind: "concept",
      conceptId,
      canonicalName: concept.canonical_name,
      alias: null,
      aliasMode: null,
      contentSha256: hash(vocab.kind, concept.canonical_name),
    });
    for (const entry of concept.aliases) {
      entries.push({
        watermarkKey: `alias:${vocab.kind}:${conceptId}:${entry.alias}`,
        kind: vocab.kind,
        entryKind: "alias",
        conceptId,
        canonicalName: concept.canonical_name,
        alias: entry.alias,
        aliasMode: entry.mode,
        contentSha256: hash(vocab.kind, concept.canonical_name, entry.alias, entry.mode),
      });
    }
  }
  return entries;
}

export interface SeedSummary {
  readonly inserted: number;
  readonly unchanged: number;
  readonly changed: number;
  readonly concepts: number;
  readonly aliases: number;
  readonly autoAliases: number;
  readonly suggestAliases: number;
  readonly fingerprint: string;
  /** M2：水位之外的真实 Concept/ConceptAlias 回填计数。 */
  readonly tables: ConceptTableSummary;
}

export interface ConceptTableSummary {
  readonly conceptsInserted: number;
  readonly conceptsExisting: number;
  readonly aliasesInserted: number;
  readonly aliasesExisting: number;
  /** 标准名/别名已被非种子行占据：播种器让位于既有数据，只登记不覆盖。 */
  readonly skippedForUserRows: number;
}

/**
 * 把词表落到真正的 Concept / ConceptAlias 表（Spec §9.3、K-14、K-15）。
 *
 * 三条守门规则：
 * - 冲突目标写 `(concept_type, canonical_name)` 与 `(domain, alias)` 这两个业务唯一键，
 *   并用 `where origin_type='system_seed'` / `where source='seed'` 限定：已被用户行占据的名字
 *   直接跳过（DO UPDATE 的 WHERE 为假时既不更新也不报错），种子永不夺走用户已认领的概念。
 * - 别名的 concept_id 取自回填后**实际存在**的那一行，而不是词表推导的种子 ID——
 *   标准名若由用户先建，别名必须挂到用户行上，否则指向不存在的对象。
 * - mode 逐字来自词表文件：`auto` 只有这里能写进去（K-14），服务层与 T-22 共同守门。
 */
function backfillConceptTables(
  db: Database,
  entries: readonly SeedEntry[],
  now: string,
): ConceptTableSummary {
  const selectConcept = db.prepare(
    "select id, origin_type from concept where concept_type = ? and canonical_name = ?",
  );
  const upsertConcept = db.prepare(
    `insert into concept (id, concept_type, canonical_name, origin_type, lifecycle_status, created_at_utc)
     values (?, ?, ?, 'system_seed', 'active', ?)
     on conflict(concept_type, canonical_name) do update
       set canonical_name = excluded.canonical_name
       where origin_type = 'system_seed'`,
  );
  const selectAlias = db.prepare("select id, source from concept_alias where domain = ? and alias = ?");
  const upsertAlias = db.prepare(
    `insert into concept_alias (id, alias, concept_id, domain, mode, source, confirmed_at_utc)
     values (?, ?, ?, ?, ?, 'seed', NULL)
     on conflict(domain, alias) do update
       set concept_id = excluded.concept_id, mode = excluded.mode, source = 'seed'
       where source = 'seed'`,
  );

  const summary: { -readonly [K in keyof ConceptTableSummary]: number } = {
    conceptsInserted: 0,
    conceptsExisting: 0,
    aliasesInserted: 0,
    aliasesExisting: 0,
    skippedForUserRows: 0,
  };
  /** 词表推导的 concept_id -> 库里真实占据该标准名的行 id。 */
  const resolvedIds = new Map<string, string>();

  for (const entry of entries) {
    if (entry.entryKind !== "concept") continue;
    const holder = selectConcept.get(entry.kind, entry.canonicalName) as
      | { id: string; origin_type: string }
      | undefined;
    if (holder === undefined) {
      upsertConcept.run(entry.conceptId, entry.kind, entry.canonicalName, now);
      resolvedIds.set(entry.conceptId, entry.conceptId);
      summary.conceptsInserted += 1;
      continue;
    }
    resolvedIds.set(entry.conceptId, holder.id);
    if (holder.origin_type === "system_seed") {
      upsertConcept.run(entry.conceptId, entry.kind, entry.canonicalName, now);
      summary.conceptsExisting += 1;
    } else {
      summary.skippedForUserRows += 1;
    }
  }

  for (const entry of entries) {
    if (entry.entryKind !== "alias" || entry.alias === null || entry.aliasMode === null) continue;
    const conceptId = resolvedIds.get(entry.conceptId);
    if (conceptId === undefined) {
      throw new Error(`别名 ${entry.alias} 的标准概念 ${entry.canonicalName} 未在本次播种中落位`);
    }
    const domain = entry.kind;
    const alias = entry.alias;
    const holder = selectAlias.get(domain, alias) as { id: string; source: string } | undefined;
    if (holder !== undefined && holder.source !== "seed") {
      summary.skippedForUserRows += 1;
      continue;
    }
    upsertAlias.run(seedAliasId(domain, alias), alias, conceptId, domain, entry.aliasMode);
    if (holder === undefined) summary.aliasesInserted += 1;
    else summary.aliasesExisting += 1;
  }

  return summary;
}

/**
 * 词表播种：一个事务里既写「词表声明了什么」的水位（M0 交付物 4），
 * 也把标准名与别名落成真正的 Concept / ConceptAlias 行（M2，Spec §9.3）。
 * 水位让声明在数据层可查、可重放、可检测变化；两张业务表是归一化与图谱的真实入口。
 */
function runInTransaction<T>(db: Database, body: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = body();
    db.exec("COMMIT");
    return result;
  } catch (cause) {
    db.exec("ROLLBACK");
    throw cause;
  }
}

export function seedVocabulary(
  db: Database,
  contracts: Contracts = loadContracts(),
  now = new Date().toISOString(),
): SeedSummary {
  const entries = [...buildSeedEntries(contracts.emotions), ...buildSeedEntries(contracts.topics)];
  const select = db.prepare("select content_sha256 from vocab_seed_watermark where watermark_key = ?");
  const write = db.prepare(
    `insert into vocab_seed_watermark
       (watermark_key, kind, entry_kind, concept_id, canonical_name, alias, alias_mode, content_sha256, seeded_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?)
     on conflict(watermark_key) do update set
       canonical_name = excluded.canonical_name,
       alias = excluded.alias,
       alias_mode = excluded.alias_mode,
       content_sha256 = excluded.content_sha256,
       seeded_at = excluded.seeded_at`,
  );

  let inserted = 0;
  let unchanged = 0;
  let changed = 0;
  const tables = runInTransaction(db, () => {
    for (const entry of entries) {
      const existing = select.get(entry.watermarkKey) as { content_sha256: string } | undefined;
      if (existing === undefined) inserted += 1;
      else if (existing.content_sha256 !== entry.contentSha256) changed += 1;
      else unchanged += 1;
      write.run(
        entry.watermarkKey,
        entry.kind,
        entry.entryKind,
        entry.conceptId,
        entry.canonicalName,
        entry.alias,
        entry.aliasMode,
        entry.contentSha256,
        now,
      );
    }
    setMeta(db, "contracts_fingerprint", contracts.fingerprint);
    setMeta(db, "vocab_seeded_at", now);
    return backfillConceptTables(db, entries, now);
  });

  return {
    inserted,
    unchanged,
    changed,
    concepts: entries.filter((e) => e.entryKind === "concept").length,
    aliases: entries.filter((e) => e.entryKind === "alias").length,
    autoAliases: entries.filter((e) => e.aliasMode === "auto").length,
    suggestAliases: entries.filter((e) => e.aliasMode === "suggest").length,
    fingerprint: contracts.fingerprint,
    tables,
  };
}

export function countSeedWatermark(db: Database): number {
  const row = db.prepare("select count(*) as n from vocab_seed_watermark").get() as { n: number };
  return row.n;
}
