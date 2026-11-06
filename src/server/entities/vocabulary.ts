import type { Database } from "../db/adapter.ts";
import { purgePreviewCache } from "../privacy/grantService.ts";
import { SEMANTIC_REDACTION_KINDS } from "../privacy/redaction.ts";

/**
 * 词表管理（Phase D / S10）：查看会让 L1 自动遮的实体，并把误判的那一个移出遮蔽集合。
 *
 * **不是删除**。`entity` 行还承载转正状态、提及与关系端点；删掉会让这些一起断。
 * `mask_enabled = 0` 只表达「这个词不再因词表命中被替换」，本机模型仍可能独立识别到它。
 *
 * 词表只可能遮 `person` / `place` / `organization`（2026-11-04 裁决，G0），
 * 所以这里也只列这三类：把 `work` / `product` 放进来会让人以为关了开关就能挡住它们，
 * 而它们本来就不在遮蔽集合里。
 */

export interface VocabularyEntityRow {
  readonly entityId: string;
  readonly entityType: string;
  readonly canonicalName: string;
  readonly displayName: string;
  readonly lifecycleStatus: string;
  readonly originType: string;
  readonly maskEnabled: boolean;
  readonly terms: readonly string[];
}

export class EntityVocabularyError extends Error {
  readonly kind: "missing";

  constructor(entityId: string) {
    super(`实体不存在，无法调整词表：${entityId}`);
    this.name = "EntityVocabularyError";
    this.kind = "missing";
  }
}

const SEMANTIC_TYPES_SQL = SEMANTIC_REDACTION_KINDS.map((kind) => `'${kind}'`).join(", ");

interface RawRow {
  id: string;
  entity_type: string;
  canonical_name: string;
  display_name: string;
  lifecycle_status: string;
  origin_type: string;
  mask_enabled: number;
  alias: string | null;
}

function toRow(rows: readonly RawRow[]): VocabularyEntityRow {
  const first = rows[0]!;
  const terms = new Set<string>([first.canonical_name, first.display_name]);
  for (const row of rows) {
    if (row.alias !== null && row.alias !== "") terms.add(row.alias);
  }
  return {
    entityId: first.id,
    entityType: first.entity_type,
    canonicalName: first.canonical_name,
    displayName: first.display_name,
    lifecycleStatus: first.lifecycle_status,
    originType: first.origin_type,
    maskEnabled: first.mask_enabled === 1,
    terms: [...terms],
  };
}

function readEntityRows(db: Database, entityId: string): RawRow[] {
  return db
    .prepare(
      `select e.id as id, e.entity_type as entity_type, e.canonical_name as canonical_name,
              e.display_name as display_name, e.lifecycle_status as lifecycle_status,
              e.origin_type as origin_type, e.mask_enabled as mask_enabled,
              a.alias as alias
       from entity as e
       left join entity_alias as a on a.entity_id = e.id
       where e.id = ? and e.entity_type in (${SEMANTIC_TYPES_SQL})
       order by a.alias`,
    )
    .all(entityId) as unknown as RawRow[];
}

export function listVocabulary(db: Database): VocabularyEntityRow[] {
  const rows = db
    .prepare(
      `select e.id as id, e.entity_type as entity_type, e.canonical_name as canonical_name,
              e.display_name as display_name, e.lifecycle_status as lifecycle_status,
              e.origin_type as origin_type, e.mask_enabled as mask_enabled,
              a.alias as alias
       from entity as e
       left join entity_alias as a on a.entity_id = e.id
       where e.entity_type in (${SEMANTIC_TYPES_SQL})
       order by e.display_name collate nocase, e.id, a.alias`,
    )
    .all() as unknown as RawRow[];

  const grouped = new Map<string, RawRow[]>();
  for (const row of rows) {
    const bucket = grouped.get(row.id);
    if (bucket === undefined) grouped.set(row.id, [row]);
    else bucket.push(row);
  }
  return [...grouped.values()].map(toRow);
}

function allRevisionIds(db: Database): string[] {
  return (
    db.prepare("select id from record_revision").all() as unknown as { id: string }[]
  ).map((row) => row.id);
}

/**
 * 改一个实体的遮蔽开关。值真的变了才清预览缓存：缓存里的载荷是用旧词表算的，
 * 不清就会「预览看不到它、发送仍是旧哈希」——两句话各自为真却对不上。
 */
export function setEntityMask(db: Database, entityId: string, maskEnabled: boolean): VocabularyEntityRow {
  const existing = readEntityRows(db, entityId);
  if (existing.length === 0) throw new EntityVocabularyError(entityId);
  const current = existing[0]!.mask_enabled === 1;
  if (current !== maskEnabled) {
    db.prepare("update entity set mask_enabled = ? where id = ?").run(maskEnabled ? 1 : 0, entityId);
    purgePreviewCache(db, allRevisionIds(db));
  }
  return toRow(readEntityRows(db, entityId));
}
