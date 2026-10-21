import type { Database } from "../db/adapter.ts";
import { currentSchemaVersion } from "../db/migrator.ts";
import { RecordService } from "../records/service.ts";

/**
 * 数据面健康检查（M1b §八）：启动自检的 M1a 扩展，被启动流程、备份校验与恢复复检共用——
 * 健康判据只实现这一套（§8.1「避免出现前端、备份服务、启动自检各自实现互相矛盾的健康判断」）。
 *
 * FTS 健康的硬要求（§8.2，M1a 实测入档）：
 * `PRAGMA integrity_check` 与 FTS5 `integrity-check` 对本构建的幽灵行/内容篡改脱锚都不报错，
 * 因此一致性判据是 `record_fts_docsize` 影子比对（detectIndexDesync），integrity-check 只作基本盘。
 * 已知限制（§8.3 尾注）：**纯内容篡改而行id不变**的脱锚（直接改写 raw_text/tokens）
 * 不在 docsize 对照面上，需要额外语义检查才能发现——本检查如实声明，不宣称覆盖一切物理损坏。
 */

export const MIN_SCHEMA_VERSION = 2;

/**
 * 必需对象按 schema 版本分层：v2 库（M1 时代备份恢复后尚未升级）用 M1 判据，
 * 派生层对象要到它真正存在的版本起才纳入要求。
 * 这样既不放任缺表，也不让旧备份在版本判定上被未来的迁移误伤。
 */
interface RequiredObjects {
  readonly fromVersion: number;
  readonly tables: readonly string[];
  readonly triggers: readonly string[];
  readonly indexes: readonly string[];
}

const REQUIRED_BASE: RequiredObjects = {
  fromVersion: 2,
  tables: [
    "schema_migrations",
    "app_meta",
    "capture_record",
    "record_revision",
    "deletion_audit",
    "record_fts",
  ],
  triggers: ["record_ai", "record_ad", "record_au"],
  indexes: [
    "ix_capture_record_created_utc",
    "ix_capture_record_local_date",
    "ux_record_revision_owner",
  ],
};

const REQUIRED_DERIVED: RequiredObjects = {
  fromVersion: 3,
  tables: [
    "cloud_send_grant",
    "parse_run",
    "episode",
    "thought_item",
    "concept",
    "concept_alias",
    "entity",
    "entity_alias",
    "emotion_mention",
    "topic_mention",
    "entity_mention",
    "suggestion",
    "graph_edge",
  ],
  // 多态引用的存在性守门只能靠触发器，它们缺席等于约束缺席。
  triggers: ["concept_alias_domain_bi", "graph_edge_endpoints_bi"],
  // 四个唯一索引是幂等/去重契约的物理载体。
  indexes: [
    "ux_run_current",
    "ux_run_live",
    "ux_concept_alias",
    "ux_emotion_mention_run",
  ],
};

const REQUIRED_CORRECTION: RequiredObjects = {
  // 0004 修正层引入 user_scalar_override / user_collection_patch；0005 只是重建 override 表并
  // 原样恢复六个触发器，两表与全部触发器在 v4/v5 都存在，故本层从 v4 起要求。
  // 分层要义：v2/v3 库（M1 时代备份恢复后尚未升级）不该被要求具备修正层对象，
  // 加了这一层也不改变 v2/v3 的 passedSteps 数量——既有 M1 判据不误伤。
  fromVersion: 4,
  tables: ["user_scalar_override", "user_collection_patch"],
  // 多态引用（object_table/container_table）无法用 FK，存在性/清理全靠触发器；
  // 任一缺席即等于约束缺席（override 可指向不存在对象、或目标删除后留孤儿）。
  triggers: [
    "ovo_target_bi",
    "ovo_target_bu",
    "ovo_episode_ad",
    "ovo_thought_ad",
    "ovo_concept_ad",
    "ovo_entity_ad",
    "ucp_container_bi",
    "ucp_container_bu",
    "ucp_episode_ad",
    "ucp_thought_ad",
  ],
  // override/patch 的唯一约束都是表级 UNIQUE（sqlite 自动索引，无用户命名对象），
  // 因此本层没有可点名的命名索引——存在性判据已由上面的表 + 触发器完整覆盖。
  indexes: [],
};

const REQUIRED_BACKFILL: RequiredObjects = {
  // 0007 只新增一张表（§3.16 trigger_assertion）与 parse_run 两个列——列不是命名对象，
  // 点名面在这里只有表。补了这一层，「缺表也能开门」才不再成立。
  fromVersion: 7,
  tables: ["trigger_assertion"],
  triggers: [],
  indexes: [],
};

const REQUIRED_TIERS: readonly RequiredObjects[] = [
  REQUIRED_BASE,
  REQUIRED_DERIVED,
  REQUIRED_CORRECTION,
  REQUIRED_BACKFILL,
];

/** 兼容旧导出名：基础层（v2）清单。 */
export const REQUIRED_TABLES = REQUIRED_BASE.tables;
export const REQUIRED_TRIGGERS = REQUIRED_BASE.triggers;
export const REQUIRED_INDEXES = REQUIRED_BASE.indexes;

export class DataCheckFailure extends Error {
  readonly step: string;
  readonly detail: string;

  constructor(step: string, detail: string) {
    super(`数据面自检失败〔${step}〕：${detail}`);
    this.name = "DataCheckFailure";
    this.step = step;
    this.detail = detail;
  }
}

export function missingDataPlaneObjects(
  db: Database,
  schemaVersion: number = currentSchemaVersion(db),
): string[] {
  const missing: string[] = [];
  for (const tier of REQUIRED_TIERS) {
    if (schemaVersion < tier.fromVersion) continue;
    for (const table of tier.tables) {
      const row = db
        .prepare("select count(*) as n from sqlite_master where type = 'table' and name = ?")
        .get(table) as { n: number };
      if (row.n === 0) missing.push(`表 ${table}`);
    }
    for (const trigger of tier.triggers) {
      const row = db
        .prepare("select count(*) as n from sqlite_master where type = 'trigger' and name = ?")
        .get(trigger) as { n: number };
      if (row.n === 0) missing.push(`触发器 ${trigger}`);
    }
    for (const index of tier.indexes) {
      const row = db
        .prepare("select count(*) as n from sqlite_master where type = 'index' and name = ?")
        .get(index) as { n: number };
      if (row.n === 0) missing.push(`索引 ${index}`);
    }
  }
  return missing;
}

// M1b：报告类型上收为前后端共用契约；re-export 保持既有导入路径可用。
import type { DataCheckReport } from "../../shared/dto.ts";
export type { DataCheckReport } from "../../shared/dto.ts";

/** 每个检查步骤的异常都要归名到步骤上：损坏库的裸报错也要变成「哪一步、为什么」。 */
function attempt<T>(step: string, fn: () => T): T {
  try {
    return fn();
  } catch (cause) {
    if (cause instanceof DataCheckFailure) throw cause;
    throw new DataCheckFailure(step, `检查异常终止：${(cause as Error).message}`);
  }
}

export function runDataCheck(db: Database): DataCheckReport {
  const passedSteps: string[] = [];

  const schemaVersion = attempt("schema-version", () => currentSchemaVersion(db));
  if (schemaVersion < MIN_SCHEMA_VERSION) {
    throw new DataCheckFailure(
      "schema-version",
      `schema 版本 ${schemaVersion} 低于数据面要求的最低版本 ${MIN_SCHEMA_VERSION}`,
    );
  }
  passedSteps.push("schema-version");

  const missing = attempt("required-objects", () => missingDataPlaneObjects(db, schemaVersion));
  if (missing.length > 0) {
    throw new DataCheckFailure("required-objects", `缺少必需对象：${missing.join("、")}`);
  }
  passedSteps.push("required-objects");

  const integrity = attempt("integrity-check", () =>
    db.prepare("PRAGMA integrity_check").all() as unknown as { integrity_check: string }[],
  );
  if (integrity.length !== 1 || integrity[0]!.integrity_check !== "ok") {
    throw new DataCheckFailure(
      "integrity-check",
      `库页级完整性异常：${integrity.map((row) => row.integrity_check).join("；")}`,
    );
  }
  passedSteps.push("integrity-check");

  const fkViolations = attempt("foreign-key-check", () =>
    db.prepare("PRAGMA foreign_key_check").all() as unknown[],
  );
  if (fkViolations.length > 0) {
    throw new DataCheckFailure(
      "foreign-key-check",
      `存在 ${fkViolations.length} 行外键违规（M1a 契约：违规=缺陷，不自动清洗）`,
    );
  }
  passedSteps.push("foreign-key-check");

  attempt("fts-queryable", () =>
    db.prepare("select rowid from record_fts where record_fts match ? limit 1").get("健康探针"),
  );
  passedSteps.push("fts-queryable");

  // 真实一致性判据：docsize 影子对照；可安全重建的派生索引先重建再复检（§8.2 恢复策略）。
  const service = new RecordService(db);
  let desync = attempt("fts-index-consistency", () => service.detectIndexDesync());
  let searchIndexRebuilt = false;
  const desyncBeforeRebuild =
    desync.phantom > 0 || desync.missing > 0 ? { ...desync } : null;
  if (desyncBeforeRebuild !== null) {
    attempt("fts-index-consistency", () => service.rebuildSearchIndex());
    searchIndexRebuilt = true;
    desync = attempt("fts-index-consistency", () => service.detectIndexDesync());
    if (desync.phantom > 0 || desync.missing > 0) {
      throw new DataCheckFailure(
        "fts-index-consistency",
        `派生索引重建后仍不一致（幽灵 ${desync.phantom} / 缺失 ${desync.missing}），无法自动修复`,
      );
    }
  }
  passedSteps.push("fts-index-consistency");

  return { schemaVersion, passedSteps, searchIndexRebuilt, desyncBeforeRebuild };
}
