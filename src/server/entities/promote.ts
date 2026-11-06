import type { Database } from "../db/adapter.ts";

/**
 * 实体转正（M8-1，M8-D-1/M8-D-2）。
 *
 * 历史口径是「唯一的 provisional → active 写入路径：用户手动点『转正』那一下，AI 不转正任何实体」。
 * 2026-11-05 的 D-1 裁决**例外**：整理时从本机脱敏 span 自动登记实体直接落 `active`
 * （见 `entityIdentity.ts` 的 `resolveOrCreateEntity`），否则云端整理出的关系端点不可用。
 * 本函数仍是**用户手动转正**那条路，也只被路由直接调用；它不负责自动登记。
 *
 * **只改 `lifecycle_status` 一列**：不建边、不建别名、不改词面/类型/隐私级/来源/创建时间、
 * 不调任何 Provider。转正本身不产生关系——关系要等用户重新分析（M8-2）。
 *
 * 端点存在的意义：`GraphStore` 要求关系端点是 `Entity:active`（M7-D-2 / R3），
 * 而 `entityConfirm` 恒写 provisional；没有这里，M7 的关系写入在真实使用中永远走不到。
 */

/** 一行 `entity` 的全部列（列名与 0006 重建后的表逐字一致，不做驼峰改写）。 */
export interface EntityRow {
  readonly id: string;
  readonly entity_type: string;
  readonly canonical_name: string;
  readonly display_name: string;
  readonly lifecycle_status: string;
  readonly privacy_level: string;
  readonly origin_type: string;
  readonly created_at_utc: string;
}

export interface PromoteResult {
  readonly promoted: boolean;
  readonly entity: EntityRow;
}

/** 转正被拒。`missing`=id 不在册，`archived`=已归档（恢复是另一个动作，本轮不做）。 */
export class EntityPromoteError extends Error {
  readonly kind: "missing" | "archived";

  constructor(kind: "missing" | "archived", entityId: string) {
    super(
      kind === "missing"
        ? `实体不存在，无法转正：${entityId}`
        : `实体已归档，转正不接受（先恢复是另一个动作）：${entityId}`,
    );
    this.name = "EntityPromoteError";
    this.kind = kind;
  }
}

const ENTITY_COLUMNS =
  "id, entity_type, canonical_name, display_name, lifecycle_status, privacy_level, origin_type, created_at_utc";

function readEntity(db: Database, entityId: string): EntityRow | undefined {
  return db.prepare(`select ${ENTITY_COLUMNS} from entity where id = ?`).get(entityId) as
    | EntityRow
    | undefined;
}

export function promoteEntity(db: Database, entityId: string): PromoteResult {
  // 条件 UPDATE 而不是先读后写：读到的 lifecycle 与写下去的那一刻之间没有任何缝隙可挤。
  const changed =
    db
      .prepare(
        `update entity set lifecycle_status = 'active'
          where id = ? and lifecycle_status = 'provisional'`,
      )
      .run(entityId).changes > 0;
  const entity = readEntity(db, entityId);
  if (entity === undefined) throw new EntityPromoteError("missing", entityId);
  if (changed) return { promoted: true, entity };
  if (entity.lifecycle_status === "archived") throw new EntityPromoteError("archived", entityId);
  // 剩下的唯一取值是 active：已经在册，幂等地回「什么都没变」。
  return { promoted: false, entity };
}
