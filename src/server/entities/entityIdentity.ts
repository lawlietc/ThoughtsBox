import type { Database } from "../db/adapter.ts";
import { newId } from "../../shared/contracts/ids.ts";

/**
 * 实体身份的**唯一**落脚点（D-3 / D-4，2026-11-05）。
 *
 * 本机脱敏识别出的人名/地名/机构名要登记成实体；云端围绕占位符组织的实体也要能归并到这里。
 * 今天的行为：按 `(entity_type, NFC 真名)` 查在册实体，命中复用、未命中新建。
 *
 * 「同名同类型不同人」在今天的默认策略里会被**合并**成一个实体。这是为「跨记录累计提及」
 * 必须付出的代价；把决策收进这一个函数，是为了将来能换成上下文消歧或事后拆分，而不动上层。
 * `entity` 表**没有**名字唯一约束（B5 裁决），同名不同人本就可并存；`entity_mention` 保留了
 * 来源版本/解析运行/证据坐标，未来拆分可据此重算归属，无需迁移。
 */

/** 参与语义脱敏的三类实体。与 `redaction.ts` 的 `SEMANTIC_REDACTION_KINDS` 同集合。 */
export const SEMANTIC_ENTITY_TYPES = ["person", "place", "organization"] as const;
export type SemanticEntityType = (typeof SEMANTIC_ENTITY_TYPES)[number];

export interface ResolveOrCreateEntityInput {
  /** 真名（原文逐字，写入前按 NFC 比较，不改写词面）。 */
  readonly name: string;
  /** `enums.json` 的 `entity_types` 之一。 */
  readonly type: string;
  /** ISO 时间戳（调用方给，便于同一事务内一致）。 */
  readonly now: string;
  readonly originType?: "ai_generated" | "user_created";
  readonly lifecycleStatus?: "provisional" | "active" | "archived";
  readonly privacyLevel?: "normal" | "sensitive";
}

export interface ResolveOrCreateEntityResult {
  readonly entityId: string;
  readonly created: boolean;
}

/**
 * 复用或新建一条实体（并在新建时补一条同词别名）。
 * 调用方必须在事务内调用：本函数只做行写入，不回滚、不提交。
 */
export function resolveOrCreateEntity(
  db: Database,
  input: ResolveOrCreateEntityInput,
): ResolveOrCreateEntityResult {
  const name = input.name;
  if (name.trim() === "") throw new Error("实体名不能为空串");
  const normalized = name.normalize("NFC");

  const existing = db
    .prepare(
      `select id from entity
        where entity_type = ? and canonical_name = ?
          and lifecycle_status in ('provisional', 'active')
        order by id limit 1`,
    )
    .get(input.type, normalized) as { id: string } | undefined;
  if (existing !== undefined) return { entityId: existing.id, created: false };

  const id = newId("entity");
  db.prepare(
    `insert into entity
       (id, entity_type, canonical_name, display_name, lifecycle_status, privacy_level, origin_type, created_at_utc)
     values (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.type,
    normalized,
    name,
    input.lifecycleStatus ?? "active",
    input.privacyLevel ?? "normal",
    input.originType ?? "ai_generated",
    input.now,
  );
  db.prepare(
    `insert into entity_alias (entity_id, alias, created_at_utc) values (?, ?, ?)`,
  ).run(id, normalized, input.now);
  return { entityId: id, created: true };
}
