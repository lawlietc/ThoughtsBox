import { loadContracts } from "../../shared/contracts/load.ts";
import { newId } from "../../shared/contracts/ids.ts";
import type { Database } from "../db/adapter.ts";

/**
 * 用户修正层的服务面（D13）：修正合并、防复活、detach。
 *
 * 契约取值：Schema §3.18 / §3.19 / §3.20 / §7.4 / §7.5、Spec §3.5、ADR-011、
 * 迁移 0004 / 0005 的封闭集与白名单。DB 地板已由 M2-2 / M2-2b 钉住，本模块负责
 * 地板之上的**动作语义**：哪一种修正写哪张表、add 为什么不走补丁表。
 *
 * 三条决定形态的契约条款：
 *
 * 1. **add 不落补丁行**（§3.18 / §7.4）：集合添加的唯一落地是真实的
 *    `origin_type='user_created'` Mention 行（FK 与投影走同一套数据）；
 *    `op` 的 CHECK 保留 `add` 值只为未来语义，M2 服务层禁止写它（T-30 服务面）。
 *    因此本模块只有一个补丁写入口，且它对 `add` 直接抛。
 * 2. **remove 才用补丁行**：语义是「隐藏 + 防复活」——既存当前提及转 rejected，
 *    并且任何 run（candidate 亦然）写入命中同一 (容器, 目标, label_said NFC) 即落 rejected（T-06）。
 *    补丁行永不因重跑而被清除：清它的是容器删除触发器，不是解析路径。
 * 3. **override 是投影，不写基表**（ADR-011）：生效视图 = 基表行 + override 覆盖，
 *    本模块提供 `projectEffective()`，绝不 UPDATE 业务表列。
 */

/** 0004 `user_collection_patch.op` 的封闭集（冻结原文 `add|remove`；服务层禁写 add）。 */
export const PATCH_OPS = ["add", "remove"] as const;
export type PatchOp = (typeof PATCH_OPS)[number];

/** 0004 `container_table` 封闭集。 */
export const PATCH_CONTAINER_TABLES = ["episode", "thought_item"] as const;
export type PatchContainerTable = (typeof PATCH_CONTAINER_TABLES)[number];

/** 0004 `collection` 封闭集。 */
export const PATCH_COLLECTIONS = ["emotions", "topics", "entities"] as const;
export type PatchCollection = (typeof PATCH_COLLECTIONS)[number];

/** 0004/0005 `object_table` 封闭集（可修正对象）。 */
export const OVERRIDABLE_TABLES = ["episode", "thought_item", "concept", "entity"] as const;
export type OverridableTable = (typeof OVERRIDABLE_TABLES)[number];

/**
 * §3.18 field_name 白名单（含 M2-2b 增补的 `entity.entity_type`）。
 * 与迁移的 CASE CHECK 逐值一致——对账断言在 `m2-ingest-service.test.ts`，
 * 手法同 T-16：本清单与 0004/0005 的 SQL 字面量逐项相等，不各说各话。
 */
export const OVERRIDE_FIELD_WHITELIST: Readonly<Record<OverridableTable, readonly string[]>> = {
  episode: ["summary", "event_time_raw", "event_time_precision", "event_time_certainty"],
  thought_item: ["text"],
  concept: ["canonical_name"],
  entity: ["display_name", "canonical_name", "entity_type"],
};

/**
 * §3.18 增补的取值门：白名单里的枚举型字段只能写所属封闭枚举内的值。
 * 值域取 `enums.json`（单一事实源），这里只登记「哪个字段归哪个枚举」。
 */
export const OVERRIDE_VALUE_GATES: Readonly<Record<string, "event_time_precision" | "event_time_certainty" | "entity_types">> = {
  event_time_precision: "event_time_precision",
  event_time_certainty: "event_time_certainty",
  entity_type: "entity_types",
};

const ENUMS = loadContracts().enums;

/** 补丁集合 → Mention 表 / 目标列 / ID 前缀的对应（三类 Mention 对称结构的必要投影）。 */
export interface MentionShape {
  readonly table: "emotion_mention" | "topic_mention" | "entity_mention";
  readonly targetColumn: "concept_id" | "entity_id";
  readonly idKind: "emotionMention" | "topicMention" | "entityMention";
}

const MENTION_SHAPE: Readonly<Record<PatchCollection, MentionShape>> = {
  emotions: { table: "emotion_mention", targetColumn: "concept_id", idKind: "emotionMention" },
  topics: { table: "topic_mention", targetColumn: "concept_id", idKind: "topicMention" },
  entities: { table: "entity_mention", targetColumn: "entity_id", idKind: "entityMention" },
};

/** 导出给 ingest 层：派生写入与用户添加共用同一张形状表，避免两处各抄一份列名。 */
export function mentionShapeFor(collection: PatchCollection): MentionShape {
  return MENTION_SHAPE[collection];
}

/** Mention 来源 kind → 0003 的三选一来源列（§3.14 exactly-one）。 */
const SOURCE_COLUMN: Readonly<Record<MentionSource["kind"], string>> = {
  revision: "source_record_revision_id",
  episode: "source_episode_id",
  thought_item: "source_thought_id",
};

/**
 * ⊕ 合并的唯一实现：override 覆盖基表字段，未覆盖的保持基表值，返回新对象。
 * 单对象（`projectEffective`）与批量（PROJ-1 可读投影）两条路共用它，
 * 免得「同一个用户改过的值在两个面上显示成两份」。
 */
export function applyOverrides<T extends Record<string, unknown>>(
  row: T,
  overrides: readonly OverrideRow[],
): T {
  if (overrides.length === 0) return { ...row };
  const out: Record<string, unknown> = { ...row };
  for (const override of overrides) {
    out[override.field_name] = JSON.parse(override.value_json) as unknown;
  }
  return out as T;
}

/** 补丁 container_table → Mention 的来源列；record_revision 容器没有补丁语义（0004 封闭集只有两值）。 */
const CONTAINER_SOURCE_COLUMN: Readonly<Record<PatchContainerTable, string>> = {
  episode: "source_episode_id",
  thought_item: "source_thought_id",
};

export class CorrectionInputError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "CorrectionInputError";
  }
}

/**
 * T-30 服务面：`add` 补丁被服务层拒。
 * 单独一个错误类而不是泛化的 `CorrectionInputError`，是为了让「add 走的是另一条落地路径」
 * 在调用侧可判别——它不是「参数不合法」，是「这个动作不该写这张表」。
 */
export class CollectionAddViaPatchError extends Error {
  readonly collection: PatchCollection;
  readonly memberId: string;

  constructor(collection: PatchCollection, memberId: string) {
    super(
      `集合 add 不写 user_collection_patch：§3.18/§7.4 规定添加的唯一落地是真实的 ` +
        `origin_type='user_created' Mention 行（${collection} / ${memberId}）。请使用 addUserMention()。`,
    );
    this.name = "CollectionAddViaPatchError";
    this.collection = collection;
    this.memberId = memberId;
  }
}

/** §3.20：detach 的摘要/正文必须经用户确认，服务层不得静默复制可能泄露原文的内容入库。 */
export class DetachConfirmationRequiredError extends Error {
  constructor(objectTable: "episode" | "thought_item") {
    super(
      `detach ${objectTable} 需要用户确认后的文本：§3.20 第 3 步禁止把未经确认的摘要/正文静默写入新行。`,
    );
    this.name = "DetachConfirmationRequiredError";
  }
}

/** override 写入门：白名单 + 取值门在服务层先拒，不把注定被 CHECK 拒的写入送到库里。 */
export class OverrideFieldError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "OverrideFieldError";
  }
}

export interface OverrideRow {
  readonly id: string;
  readonly object_table: OverridableTable;
  readonly object_id: string;
  readonly field_name: string;
  readonly value_json: string;
  readonly updated_at_utc: string;
}

export interface PatchRow {
  readonly id: string;
  readonly container_table: PatchContainerTable;
  readonly container_id: string;
  readonly collection: PatchCollection;
  readonly member_id: string;
  readonly op: PatchOp;
  readonly created_at_utc: string;
}

export interface CollectionSource {
  readonly containerTable: PatchContainerTable;
  readonly containerId: string;
}

/** Mention 的来源三选一（§3.14 exactly-one）；服务层用它表达「add 挂在哪」。 */
export type MentionSource =
  | { readonly kind: "revision"; readonly id: string }
  | { readonly kind: "episode"; readonly id: string }
  | { readonly kind: "thought_item"; readonly id: string };

export interface AddUserMentionInput {
  readonly collection: PatchCollection;
  readonly source: MentionSource;
  readonly memberId: string;
  readonly labelSaid: string;
  /** 用户自述依据：可空（0003 允许 user_created 行 evidence_text=''）。 */
  readonly evidenceText?: string;
  readonly evidenceStart?: number;
  readonly evidenceEnd?: number;
  /** 实体提及的角色（B2/I5 可空自由文本，不参与关系推断）。 */
  readonly role?: string;
}

export interface CorrectionServiceOptions {
  readonly now?: () => Date;
}

let savepointCounter = 0;

/**
 * 可重入的事务包装：用 SAVEPOINT 而不是 BEGIN IMMEDIATE。
 * 本模块的动作（detach 同事务建来源记录、采纳同事务迁移 override）必须能和调用方的
 * 事务合成一个原子单元；裸 BEGIN 在已有事务时会直接抛「within a transaction」，
 * SAVEPOINT 在无事务时等价于开启一个、在有事务时等价于嵌套，两种情形都成立。
 */
function inTransaction<T>(db: Database, body: () => T): T {
  savepointCounter += 1;
  const name = `sp_correction_${savepointCounter}`;
  db.exec(`SAVEPOINT ${name}`);
  try {
    const result = body();
    db.exec(`RELEASE ${name}`);
    return result;
  } catch (cause) {
    db.exec(`ROLLBACK TO ${name}`);
    db.exec(`RELEASE ${name}`);
    throw cause;
  }
}

function assertOneOf<T extends string>(value: string, allowed: readonly T[], label: string): T {
  if (!(allowed as readonly string[]).includes(value)) {
    throw new CorrectionInputError(`${label} 不在封闭集内：${value}`);
  }
  return value as T;
}

export class CorrectionService {
  private readonly db: Database;
  private readonly now: () => Date;

  constructor(db: Database, options: CorrectionServiceOptions = {}) {
    this.db = db;
    this.now = options.now ?? (() => new Date());
  }

  // ── 集合补丁：remove 的写入口（add 在此被拒，T-30 服务面）──────────

  /**
   * 补丁表的唯一写入口。
   * `op='add'` 一律抛 `CollectionAddViaPatchError`（§3.18：add 落地为真实 user_created Mention，
   * 不落 add 补丁行）；库里 `op` 的 CHECK 仍收 add（那是冻结原文，DB 面不越权收紧），
   * 所以「禁写 add」这条只在服务层成立的规则必须由这里承担。
   */
  applyCollectionPatch(input: {
    readonly containerTable: string;
    readonly containerId: string;
    readonly collection: string;
    readonly memberId: string;
    readonly op: string;
  }): PatchRow {
    const containerTable = assertOneOf(input.containerTable, PATCH_CONTAINER_TABLES, "container_table");
    const collection = assertOneOf(input.collection, PATCH_COLLECTIONS, "collection");
    const op = assertOneOf(input.op, PATCH_OPS, "op");
    if (op === "add") throw new CollectionAddViaPatchError(collection, input.memberId);
    if (input.memberId === "") throw new CorrectionInputError("member_id 不能为空串");

    const row: PatchRow = {
      id: newId("userCollectionPatch"),
      container_table: containerTable,
      container_id: input.containerId,
      collection,
      member_id: input.memberId,
      op: "remove",
      created_at_utc: this.now().toISOString(),
    };
    inTransaction(this.db, () => {
      this.db
        .prepare(
          `insert into user_collection_patch
             (id, container_table, container_id, collection, member_id, op, created_at_utc)
           values (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          row.id,
          row.container_table,
          row.container_id,
          row.collection,
          row.member_id,
          row.op,
          row.created_at_utc,
        );
    });
    return row;
  }

  /**
   * remove 的完整语义：补丁行 + 既存当前提及转 rejected + 之后任何 run 命中即 rejected。
   * 「隐藏」靠 rejected 状态（§4.4 终态）与 §3.7 join，不删行——删行就没有防复活凭据了。
   */
  removeMember(input: CollectionSource & { readonly collection: string; readonly memberId: string }): {
    readonly patch: PatchRow;
    readonly rejectedMentions: number;
  } {
    const collection = assertOneOf(input.collection, PATCH_COLLECTIONS, "collection");
    const containerTable = assertOneOf(input.containerTable, PATCH_CONTAINER_TABLES, "container_table");
    const existing = this.findPatch(containerTable, input.containerId, collection, input.memberId);
    const patch = existing ?? this.applyCollectionPatch({ ...input, containerTable, collection, op: "remove" });
    const rejected = this.rejectExistingMentions({ containerTable, containerId: input.containerId }, collection, input.memberId);
    return { patch, rejectedMentions: rejected };
  }

  private findPatch(
    containerTable: PatchContainerTable,
    containerId: string,
    collection: PatchCollection,
    memberId: string,
  ): PatchRow | null {
    const row = this.db
      .prepare(
        `select id, container_table, container_id, collection, member_id, op, created_at_utc
           from user_collection_patch
          where container_table = ? and container_id = ? and collection = ? and member_id = ?`,
      )
      .get(containerTable, containerId, collection, memberId) as PatchRow | undefined;
    return row ?? null;
  }

  /** 既存「当前视图内」的同类提及 → rejected（§4.4：active → rejected）。 */
  private rejectExistingMentions(
    container: CollectionSource,
    collection: PatchCollection,
    memberId: string,
  ): number {
    const shape = MENTION_SHAPE[collection];
    const result = this.db
      .prepare(
        `update ${shape.table}
            set status = 'rejected'
          where source_container_id = ?
            and ${shape.targetColumn} = ?
            and status = 'active'
            and (parse_run_id is null or parse_run_id in (
                   select id from parse_run where result_state = 'current'))`,
      )
      .run(container.containerId, memberId);
    return Number(result.changes ?? 0);
  }

  // ── add 的真实落地路径（T-30 的另一半）────────────────────────────

  /**
   * 用户添加集合成员 = 写一条真实的 `origin_type='user_created'` Mention。
   * 不变式：`parse_run_id IS NULL`（0003 CHECK：user_created 行永不挂 run）、
   * `basis='explicit'`（inferred + user_created 是库里非法组合）。
   */
  addUserMention(input: AddUserMentionInput): string {
    const collection = assertOneOf(input.collection, PATCH_COLLECTIONS, "collection");
    if (input.labelSaid === "") throw new CorrectionInputError("label_said 不能为空串");
    const shape = MENTION_SHAPE[collection];
    const role = collection === "entities" ? this.normalizeRole(input.role) : undefined;
    const id = newId(shape.idKind);
    const columns = [
      "id",
      shape.targetColumn,
      SOURCE_COLUMN[input.source.kind],
      "label_said",
      "evidence_text",
      "evidence_start",
      "evidence_end",
      "origin_type",
      "basis",
      "status",
      "parse_run_id",
      "created_at_utc",
    ];
    const placeholders = [
      "?",
      "?",
      "?",
      "?",
      "?",
      "?",
      "?",
      `'user_created'`,
      `'explicit'`,
      `'active'`,
      "NULL",
      "?",
    ];
    const values: (string | number | null)[] = [
      id,
      input.memberId,
      input.source.id,
      input.labelSaid,
      input.evidenceText ?? "",
      input.evidenceStart ?? null,
      input.evidenceEnd ?? null,
      this.now().toISOString(),
    ];
    if (role !== undefined) {
      columns.push("role");
      placeholders.push("?");
      values.push(role);
    }
    inTransaction(this.db, () => {
      this.db
        .prepare(
          `insert into ${shape.table} (${columns.join(", ")}) values (${placeholders.join(", ")})`,
        )
        .run(...values);
    });
    return id;
  }

  /** B2/I5：role 是可空自由文本，库里只收 trim 后的 1–200 字符——服务层先归一，不送注定被 CHECK 拒的值。 */
  private normalizeRole(role: string | undefined): string | null {
    if (role === undefined) return null;
    const trimmed = role.trim();
    if (trimmed === "") return null;
    if (trimmed.length > 200) throw new CorrectionInputError("role 长度上限 200");
    return trimmed;
  }

  // ── 防复活（T-06）──────────────────────────────────────────────────

  /** 容器对该成员是否挂着 remove 补丁——run 写入前必查，补丁不因重跑而清除。 */
  hasRemovePatch(container: CollectionSource, collection: PatchCollection, memberId: string): boolean {
    return (
      this.db
        .prepare(
          `select 1 as hit from user_collection_patch
            where container_table = ? and container_id = ? and collection = ? and member_id = ? and op = 'remove'`,
        )
        .get(container.containerTable, container.containerId, collection, memberId) !== undefined
    );
  }

  /**
   * revision 维度的防复活门（T-06 服务面）：用户在**该 revision 派生出的任何容器**上移除过某成员，
   * 则本次派生对该成员的命中一律落 rejected。
   *
   * 为什么需要 scope 版而不是逐个容器问：AI 提及的来源容器是 record_revision 本身，
   * 而 0004 的 `container_table` 封闭集只有 episode / thought_item——两者的键空间不相交，
   * 单容器查询永远问不到「上一版把这些内容切在哪个 episode 里」。
   * 补丁不因重跑而清除（§3.19），所以这里连 superseded 的行也算凭据。
   */
  hasRemovePatchInRevisionScope(
    revisionId: string,
    collection: PatchCollection,
    memberId: string,
  ): boolean {
    return (
      this.db
        .prepare(
          `select 1 as hit from user_collection_patch as p
            where p.op = 'remove' and p.collection = ? and p.member_id = ?
              and (
                (p.container_table = 'episode' and p.container_id in (
                   select id from episode where source_record_revision_id = ?))
                or (p.container_table = 'thought_item' and p.container_id in (
                     select id from thought_item where source_record_revision_id = ?
                     union
                     select id from thought_item where source_episode_id in (
                       select id from episode where source_record_revision_id = ?)))
              )`,
        )
        .get(collection, memberId, revisionId, revisionId, revisionId) !== undefined
    );
  }

  /**
   * 防复活判据（§3.14 / §4.4 / §7.4）：同一容器对同一成员挂着 remove 补丁，
   * 或已有 rejected 行（同 label_said NFC）⇒ 新行必须落 rejected。
   * 任何 run 都适用，candidate 也不例外——这正是 T-06 要的「不得静默恢复」。
   * 容器以 `source_container_id`（0003 的 COALESCE 生成列）定位，三类来源列共用一个入口。
   */
  isResurrectionBlocked(input: {
    readonly collection: PatchCollection;
    readonly containerId: string;
    readonly memberId: string;
    readonly labelSaid: string;
    /** 仅当容器是 episode / thought_item 时有补丁语义；record_revision 容器传 null。 */
    readonly patchContainer?: PatchContainerTable | null;
  }): boolean {
    const shape = MENTION_SHAPE[input.collection];
    if (input.patchContainer !== undefined && input.patchContainer !== null) {
      if (
        this.hasRemovePatch(
          { containerTable: input.patchContainer, containerId: input.containerId },
          input.collection,
          input.memberId,
        )
      ) {
        return true;
      }
    }
    const rejected = this.db
      .prepare(
        `select id from ${shape.table}
          where source_container_id = ?
            and ${shape.targetColumn} = ?
            and status = 'rejected'
            and label_said = ? collate binary`,
      )
      .get(input.containerId, input.memberId, input.labelSaid.normalize("NFC"));
    return rejected !== undefined;
  }

  // ── 标量覆盖（override 是投影，不写基表）──────────────────────────

  /**
   * 写 override。两道服务层门（都在库里另有等价地板，这里提前拒以给出可定位的错误）：
   * ① field_name ∈ 该 object_table 的白名单；
   * ② 取值门字段（§3.18 增补）只接受所属封闭枚举内的 JSON 字符串。
   */
  setOverride(input: {
    readonly objectTable: string;
    readonly objectId: string;
    readonly fieldName: string;
    readonly valueJson: string;
  }): OverrideRow {
    const objectTable = assertOneOf(input.objectTable, OVERRIDABLE_TABLES, "object_table");
    const allowed = OVERRIDE_FIELD_WHITELIST[objectTable];
    if (!(allowed as readonly string[]).includes(input.fieldName)) {
      throw new OverrideFieldError(`${objectTable} 不含可修正字段 ${input.fieldName}（白名单：${allowed.join("、")}）`);
    }
    const gate = OVERRIDE_VALUE_GATES[input.fieldName];
    if (gate !== undefined) {
      const parsed: unknown = JSON.parse(input.valueJson);
      const values: readonly string[] = ENUMS[gate];
      if (typeof parsed !== "string" || !values.includes(parsed)) {
        throw new OverrideFieldError(
          `字段 ${input.fieldName} 的取值必须在封闭枚举 ${gate} 内，收到 ${JSON.stringify(parsed)}`,
        );
      }
    }
    const ts = this.now().toISOString();
    const existing = this.db
      .prepare(
        `select id from user_scalar_override where object_table = ? and object_id = ? and field_name = ?`,
      )
      .get(objectTable, input.objectId, input.fieldName) as { id: string } | undefined;
    inTransaction(this.db, () => {
      if (existing === undefined) {
        this.db
          .prepare(
            `insert into user_scalar_override (id, object_table, object_id, field_name, value_json, updated_at_utc)
             values (?, ?, ?, ?, ?, ?)`,
          )
          .run(newId("userScalarOverride"), objectTable, input.objectId, input.fieldName, input.valueJson, ts);
        return;
      }
      this.db
        .prepare(
          `update user_scalar_override set value_json = ?, updated_at_utc = ? where id = ?`,
        )
        .run(input.valueJson, ts, existing.id);
    });
    const row = this.db
      .prepare(
        `select id, object_table, object_id, field_name, value_json, updated_at_utc
           from user_scalar_override where object_table = ? and object_id = ? and field_name = ?`,
      )
      .get(objectTable, input.objectId, input.fieldName) as unknown as OverrideRow;
    return row;
  }

  overridesFor(objectTable: OverridableTable, objectId: string): OverrideRow[] {
    return this.db
      .prepare(
        `select id, object_table, object_id, field_name, value_json, updated_at_utc
           from user_scalar_override where object_table = ? and object_id = ? order by field_name`,
      )
      .all(objectTable, objectId) as unknown as OverrideRow[];
  }

  /**
   * 一次取齐多个对象的 override（PROJ-1 可读投影：一张表一条 SQL，替掉逐对象一问的 N+1）。
   * 返回按 `object_id` 分组的 Map，缺项即没有修正——调用方据此判断「没被改过」而不是「查失败」。
   */
  overridesByObject(objectTable: OverridableTable, objectIds: readonly string[]): Map<string, OverrideRow[]> {
    const grouped = new Map<string, OverrideRow[]>();
    if (objectIds.length === 0) return grouped;
    const rows = this.db
      .prepare(
        `select id, object_table, object_id, field_name, value_json, updated_at_utc
           from user_scalar_override
          where object_table = ? and object_id in (${objectIds.map(() => "?").join(", ")})
          order by object_id, field_name`,
      )
      .all(objectTable, ...objectIds) as unknown as OverrideRow[];
    for (const row of rows) {
      const bucket = grouped.get(row.object_id);
      if (bucket === undefined) grouped.set(row.object_id, [row]);
      else bucket.push(row);
    }
    return grouped;
  }

  /** 该对象是否被用户触碰过（§3.19：存在 override / patch 行的对象绝不自动搬运、绝不自动 supersede）。 */
  isUserTouched(objectTable: OverridableTable, objectId: string): boolean {
    if (this.overridesFor(objectTable, objectId).length > 0) return true;
    const patched = this.db
      .prepare(
        `select 1 as hit from user_collection_patch where container_table = ? and container_id = ?`,
      )
      .get(objectTable, objectId);
    return patched !== undefined;
  }

  /**
   * 生效视图 = 基表行 ⊕ override（ADR-011：派生层与修正层分离，override 永不回写基表）。
   * 返回新对象，不改动入参；未被覆盖的字段保持基表值。
   */
  projectEffective<T extends Record<string, unknown>>(
    objectTable: OverridableTable,
    row: T,
  ): T {
    return applyOverrides(row, this.overridesFor(objectTable, String(row["id"])));
  }

  /**
   * 采纳时迁移 override 指向（§3.19 第 2 步）：**只在用户逐条确认新旧映射后**调用，
   * 且必须发生在 candidate→current 之后（0004/0005 的 BEFORE UPDATE 触发器要求目标行的 run 是 current）。
   */
  migrateOverride(input: {
    readonly objectTable: OverridableTable;
    readonly fromObjectId: string;
    readonly toObjectId: string;
    readonly fieldName: string;
  }): void {
    const ts = this.now().toISOString();
    const result = this.db
      .prepare(
        `update user_scalar_override
            set object_id = ?, updated_at_utc = ?
          where object_table = ? and object_id = ? and field_name = ?`,
      )
      .run(input.toObjectId, ts, input.objectTable, input.fromObjectId, input.fieldName);
    if (Number(result.changes ?? 0) === 0) {
      throw new CorrectionInputError(
        `没有可迁移的 override：${input.objectTable}/${input.fromObjectId}/${input.fieldName}`,
      );
    }
  }

  // ── detach（§3.20，T-20）──────────────────────────────────────────

  /**
   * 把一条 AI 派生 Episode 转正为独立的用户对象。
   * 三条硬要求（§3.20）：新行 `origin_type='user_created'` 且 `parse_run_id=NULL`；
   * 不携带旧 evidence_start/end；`summary` 必须是用户确认后的文本（未确认即抛，
   * 不静默复制旧摘要——旧摘要可能含脱敏前原文片段）。
   */
  detachEpisode(input: {
    readonly episodeId: string;
    readonly confirmedSummary?: string;
    readonly confirmedEvidenceText?: string;
  }): string {
    if (input.confirmedSummary === undefined || input.confirmedSummary.trim() === "") {
      throw new DetachConfirmationRequiredError("episode");
    }
    const summary = input.confirmedSummary;
    const evidence = input.confirmedEvidenceText ?? "";
    const source = this.db
      .prepare(`select id from episode where id = ?`)
      .get(input.episodeId) as { id: string } | undefined;
    if (source === undefined) throw new CorrectionInputError(`episode 不存在：${input.episodeId}`);
    const id = newId("episode");
    const ts = this.now().toISOString();
    inTransaction(this.db, () => {
      this.db
        .prepare(
          `insert into episode
             (id, source_record_revision_id, parse_run_id, origin_type, lifecycle_status,
              summary, evidence_text, evidence_start, evidence_end,
              event_time_precision, event_time_certainty, created_at_utc)
           values (?, NULL, NULL, 'user_created', 'active', ?, ?, NULL, NULL, 'unknown', 'unknown', ?)`,
        )
        .run(id, summary, evidence, ts);
    });
    return id;
  }

  /**
   * ThoughtItem 的 detach 走 §3.9 的手工创建路径：**同事务先建 CaptureRecord + RecordRevision**
   * （正文=用户确认的文本），新行挂那个新 revision。于是数据库层面永无 source-less ThoughtItem，
   * 且新行与被删记录零引用（T-20）。
   *
   * `createSourceRecord` 的契约：在**本方法已开启的事务内**执行语句，不得自行 BEGIN
   * （§3.20 第 1 步要求「同事务」；RecordService.createRecord 自带事务，因此由调用方
   * 提供语句级的创建器，或未来给 RecordService 增加参与外部事务的入口）。
   */
  detachThought(input: {
    readonly thoughtId: string;
    readonly confirmedText?: string;
    readonly confirmedEvidenceText?: string;
    readonly createSourceRecord: (text: string) => { readonly revisionId: string };
  }): string {
    if (input.confirmedText === undefined || input.confirmedText.trim() === "") {
      throw new DetachConfirmationRequiredError("thought_item");
    }
    const text = input.confirmedText;
    const evidence = input.confirmedEvidenceText ?? "";
    const source = this.db.prepare(`select id from thought_item where id = ?`).get(input.thoughtId) as
      | { id: string }
      | undefined;
    if (source === undefined) throw new CorrectionInputError(`thought_item 不存在：${input.thoughtId}`);
    const id = newId("thoughtItem");
    const ts = this.now().toISOString();
    inTransaction(this.db, () => {
      const created = input.createSourceRecord(text);
      this.db
        .prepare(
          `insert into thought_item
             (id, text, source_record_revision_id, source_episode_id, parse_run_id,
              origin_type, lifecycle_status, evidence_text, evidence_start, evidence_end, created_at_utc)
           values (?, ?, ?, NULL, NULL, 'user_created', 'active', ?, NULL, NULL, ?)`,
        )
        .run(id, text, created.revisionId, evidence, ts);
    });
    return id;
  }

  /** 集合成员的当前有效提及 id 集合（供 UI 与测试对照「隐藏」效果）。 */
  activeMentionIdsFor(container: CollectionSource, collection: PatchCollection): string[] {
    const shape = MENTION_SHAPE[collection];
    const rows = this.db
      .prepare(
        `select m.id as id from ${shape.table} as m
          where ${CONTAINER_SOURCE_COLUMN[container.containerTable]} = ?
            and m.status = 'active'
            and (m.parse_run_id is null or m.parse_run_id in (
                   select id from parse_run where result_state = 'current'))`,
      )
      .all(container.containerId) as unknown as Array<{ id: string }>;
    return rows.map((row) => row.id);
  }

  patchCount(): number {
    const row = this.db.prepare(`select count(*) as n from user_collection_patch`).get() as { n: number };
    return row.n;
  }
}
