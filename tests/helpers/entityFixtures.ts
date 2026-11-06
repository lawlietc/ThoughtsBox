import type { Database } from "../../src/server/db/adapter.ts";
import { newId } from "../../src/shared/contracts/ids.ts";

/**
 * 测试夹具：直接写一条 provisional 实体（canonical / display / alias 三处同词）。
 *
 * 2026-11-04 起产品侧删除了 `confirm-candidates` 端点（姓氏启发式整条链路一起删），
 * 但一批 M8 测试仍需要「用户确认过的 provisional 实体」作为前置状态。这个夹具只做
 * 那一件事，字段与旧 `entityConfirm` 逐字同形；它不参与产品运行路径。
 */
export function createProvisionalEntity(
  db: Database,
  term: string,
  kind = "person",
  createdAtUtc = "2026-01-01T00:00:00Z",
): string {
  const id = newId("entity");
  db.prepare(
    `insert into entity (id, entity_type, canonical_name, display_name, lifecycle_status, privacy_level, origin_type, created_at_utc)
     values (?, ?, ?, ?, 'provisional', 'normal', 'user_created', ?)`,
  ).run(id, kind, term, term, createdAtUtc);
  db.prepare(
    `insert into entity_alias (entity_id, alias, created_at_utc) values (?, ?, ?)`,
  ).run(id, term, createdAtUtc);
  return id;
}
