import { newId } from "../../shared/contracts/ids.ts";
import { loadEnums } from "../../shared/contracts/load.ts";
import type { Database } from "../db/adapter.ts";

/**
 * 「确认采纳的候选」落 provisional 实体（M3-RED-1「已定」②c/③）。
 *
 * 走的是既有 `entity` 表 + `entity_alias` 表同一条路（与「人物与事物」待转正区同一 lifecycle 语义），
 * **不开新表、零模型调用**：本模块只做纯本地词表写入，不碰任何 Provider。确认的那一步
 * 写的 entity 恒为 `lifecycle_status='provisional'`、`origin_type='user_created'`，
 * 词面 = 用户原词逐字（canonical/display/alias 三处都是那个原词）。
 *
 * 之后该词在下一次预览被遮，是因为 `collectKnownEntities` 现读到了这条已确认实体
 * （既有通道），不是因为这里新增了自动遮规则。
 */

/** 确认请求里非法 kind（不在封闭 8 值内）时抛，路由映射为 400。 */
export class EntityConfirmError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EntityConfirmError";
  }
}

export interface AdoptedCandidate {
  readonly term: string;
  readonly kind: string;
}

export interface ConfirmedEntity {
  readonly entityId: string;
  readonly term: string;
  readonly kind: string;
}

export interface ConfirmResult {
  readonly created: ConfirmedEntity[];
  readonly skipped: string[];
}

/** 词面是否已是在册实体（canonical/display/alias 任一，provisional 或 active）——幂等门。 */
function alreadyKnown(db: Database, term: string): boolean {
  const row = db
    .prepare(
      `select 1 as hit from entity
        where lifecycle_status IN ('provisional', 'active')
          and (canonical_name = ? collate binary or display_name = ? collate binary)
        union all
       select 1 as hit from entity_alias
        where alias = ? collate binary
          and entity_id in (select id from entity where lifecycle_status IN ('provisional', 'active'))
        limit 1`,
    )
    .get(term, term, term) as { hit: number } | undefined;
  return row !== undefined;
}

export function confirmCandidateEntities(
  db: Database,
  adopted: readonly AdoptedCandidate[],
  now: () => Date = () => new Date(),
): ConfirmResult {
  const entityTypes = loadEnums().entity_types as readonly string[];
  const created: ConfirmedEntity[] = [];
  const skipped: string[] = [];

  for (const item of adopted) {
    const term = item.term;
    if (term.trim() === "") {
      throw new EntityConfirmError("候选词面不能为空");
    }
    if (!entityTypes.includes(item.kind)) {
      throw new EntityConfirmError(`kind 不在封闭集内：${item.kind}`);
    }
    if (alreadyKnown(db, term)) {
      skipped.push(term);
      continue;
    }
    const ts = now().toISOString();
    const entityId = newId("entity");
    db.prepare(
      `insert into entity (id, entity_type, canonical_name, display_name, lifecycle_status, privacy_level, origin_type, created_at_utc)
       values (?, ?, ?, ?, 'provisional', 'normal', 'user_created', ?)`,
    ).run(entityId, item.kind, term, term, ts);
    db.prepare(`insert into entity_alias (entity_id, alias, created_at_utc) values (?, ?, ?)`).run(entityId, term, ts);
    created.push({ entityId, term, kind: item.kind });
  }

  return { created, skipped };
}
