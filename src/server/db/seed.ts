import { createHash } from "node:crypto";

import type { VocabFile } from "../../shared/contracts/vocab.ts";
import { seedConceptId } from "../../shared/contracts/ids.ts";
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
}

/**
 * 词表播种水位写入（M0 交付物 4）。Concept 表本身属于 Schema 审查之后的里程碑，
 * 这里先保证「词表声明了什么」在数据层可查、可重放、可检测变化。
 */
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
  db.exec("BEGIN IMMEDIATE");
  try {
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
    db.exec("COMMIT");
  } catch (cause) {
    db.exec("ROLLBACK");
    throw cause;
  }

  return {
    inserted,
    unchanged,
    changed,
    concepts: entries.filter((e) => e.entryKind === "concept").length,
    aliases: entries.filter((e) => e.entryKind === "alias").length,
    autoAliases: entries.filter((e) => e.aliasMode === "auto").length,
    suggestAliases: entries.filter((e) => e.aliasMode === "suggest").length,
    fingerprint: contracts.fingerprint,
  };
}

export function countSeedWatermark(db: Database): number {
  const row = db.prepare("select count(*) as n from vocab_seed_watermark").get() as { n: number };
  return row.n;
}
