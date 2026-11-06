import { newId } from "../../shared/contracts/ids.ts";
import { loadEnums } from "../../shared/contracts/load.ts";
import type { Database } from "../db/adapter.ts";

/**
 * 图边（`graph_edge`）的**存储层**（M7-1）。
 *
 * 契约正文：`docs/dev-specs/2026-10-27-M7关系分析阶段任务拆分与执行准则.md` §二 裁决、
 * §三.1 关系类型表、§三.2 迁移 0011。迁移：`src/server/db/migrations/0011_graph_edge_ai_relations.sql`。
 *
 * 本批的边界（写在文件头，因为它决定了下面每个方法为什么长这样）：
 *  - **不开任何 HTTP 路由、不做 UI**（准则 §五-4）。抽取（M7-2）与收敛/回填校验（M7-3）都还没做，
 *    这里只把「一条关系边怎样合法地落进库里」这一件事的服务层落点立起来。
 *  - **不解析标签、不创建实体**（§五-2 / K-14 同构）：调用方给的必须是已经解析到的实体 id。
 *    解析歧义、未命中、`provisional` 三种情况属于 M7-2 的 `ConceptResolver`，本层只负责
 *    「端点如果不合规，这一条我不写」。
 *
 * 为什么有几道校验**只能落在这里、库里守不住**（这是本文件存在的重点，不是装饰）：
 *  1. `Entity:active`：`graph_edge` 的端点是多态引用（`src_kind`/`src_id`），库里只能用触发器守
 *     **存在性**（0011 原样重建 `graph_edge_endpoints_bi` / `_bu`）。生命周期是不是 `active`，
 *     CHECK 与触发器都管不到——R3 那句「provisional 端点 ⇒ 该条关系丢弃，绝不顺手把实体转正」
 *     在库里没有对应物，只有这里能守。取值面从 `enums.json` 的 `source`/`target` 后缀派生
 *     （`Entity:active` 要 active，`Entity` 只要存在），不在本文件抄第二份清单。
 *  2. 无向类型的字典序归一（R6）：库里的 CHECK 是**拒绝**反方向的写法（`src_id <= dst_id`），
 *     它不会替你把两端换过来。要「正反两次插入落同一行」，归一必须发生在写入之前，也就是这里。
 *  3. `ai_may_never_create`（K-18）：0011 之前这一条由 `created_by` 的 CHECK 整体兜住（那列只有
 *     用户来源的两个值）；放行 `ai_generated` 之后，列约束再也表达不了「哪几类关系 AI 永不创建」。
 *     库里现在**能**写出 `same_as + ai_generated` 这一行——所以这一条改由本层守，落点是下面的
 *     `AI_NEVER_CREATE`。这不是可选校验：拿放宽列约束当没看见，就是把一条既有隐私/审计不变式丢了。
 *
 * 「哪些类型是 GraphEdge 载体、哪些有向、端点是哪种对象」一律从 `enums.json` 派生
 * （装载期 `validateEnums` 已核对过取值面，本文件不复制清单，只解释它）。
 */

const ENUMS = loadEnums();

/** 迁移 0011 的 `created_by` CHECK 的取值集；静态对账由 `tests/m7-1-graph-contract.test.ts` 钉住。 */
export const GRAPH_EDGE_CREATORS = ["user", "user_confirmed_suggestion", "ai_generated"] as const;
export type GraphEdgeCreator = (typeof GRAPH_EDGE_CREATORS)[number];

export function isGraphEdgeCreator(value: unknown): value is GraphEdgeCreator {
  return typeof value === "string" && (GRAPH_EDGE_CREATORS as readonly string[]).includes(value);
}

/** 多态端点的种类列取值，与 0003/0011 的 `src_kind` / `dst_kind` CHECK 同集。 */
type EndpointKind = "episode" | "entity" | "concept";

/**
 * `enums.json` 里一条关系声明的端点面拆解。
 *
 * `source: "Entity:active"` 拆成 `{ kind: "entity", requiresActive: true }`；
 * `source: "Entity"` 拆成 `{ kind: "entity", requiresActive: false }`。
 * 这里不做「前缀不认识就退回某个默认值」的兜底：`validateEnums` 在装载时就把 GraphEdge 的端点
 * 限定在 `Episode` / `Concept` / `Entity` / `Entity:active` 四项内，认识不了的那一种根本进不来。
 */
interface EndpointSpec {
  readonly kind: EndpointKind;
  readonly requiresActive: boolean;
}

function endpointSpec(declared: string): EndpointSpec {
  const [head, qualifier] = declared.split(":");
  return {
    kind: (head ?? "").toLowerCase() as EndpointKind,
    requiresActive: qualifier === "active",
  };
}

/** GraphEdge 载体的关系类型按名字索引（9 值，见 §三.1 与迁移 0011 的 CHECK）。 */
const EDGE_RELATIONS = new Map<string, { directed: boolean; source: EndpointSpec; target: EndpointSpec }>();
for (const rel of ENUMS.relation_types) {
  if (rel.carrier !== "GraphEdge") continue;
  EDGE_RELATIONS.set(rel.type, {
    directed: rel.directed,
    source: endpointSpec(rel.source),
    target: endpointSpec(rel.target),
  });
}

/**
 * K-18：AI 永不创建的关系类型（`same_as` / `merged_into`；`triggered_by` 不入图，天然不在写入面内）。
 *
 * `relation_type_rules` 的取值面是混合的（说明文字 / 清单 / 布尔标记三样都在这张表里），
 * 所以要显式收窄。收窄不成清单就当契约断裂处理、装载期就抛：留成空集合等于把 K-18 静默丢掉，
 * 那是比启动失败严重得多的一种错。
 */
const aiNeverCreateRule = ENUMS.relation_type_rules["ai_may_never_create"];
if (!Array.isArray(aiNeverCreateRule)) {
  throw new Error("enums.relation_type_rules.ai_may_never_create 不是清单，无法据此守门");
}
const AI_NEVER_CREATE = new Set<string>(aiNeverCreateRule);

/**
 * 入参不成立（未知类型、非实体边、自己连自己、取值不在 created_by 集合内）。
 */
export class GraphEdgeInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GraphEdgeInputError";
  }
}

/**
 * 端点不合规。`reason` 分成两档是因为 M7-2 要按 §3.5「三种分开计数」做诊断：
 * `missing`（库里根本没这个实体）与 `not_active`（有实体，但还挂着 provisional）是两件不同的事，
 * 合成一个错误就没法分开计数，只能靠解析错误文本。
 */
export class GraphEdgeEndpointError extends Error {
  readonly reason: "missing" | "not_active";
  readonly entityId: string;

  constructor(reason: "missing" | "not_active", entityId: string) {
    super(
      reason === "missing"
        ? `关系端点实体不存在，该条关系不入库：${entityId}`
        : `关系端点实体不是 active（provisional 不转正，该条关系丢弃）：${entityId}`,
    );
    this.name = "GraphEdgeEndpointError";
    this.reason = reason;
    this.entityId = entityId;
  }
}

/** 行形状：列名与迁移 0011 逐字一致（snake_case），不做驼峰改写。 */
export interface GraphEdgeRow {
  readonly id: string;
  readonly relation_type: string;
  readonly src_kind: EndpointKind;
  readonly dst_kind: EndpointKind;
  readonly src_id: string;
  readonly dst_id: string;
  readonly lifecycle_status: "active" | "superseded";
  readonly created_by: GraphEdgeCreator;
  readonly origin_suggestion_id: string | null;
  readonly origin_parse_run_id: string | null;
  readonly evidence_reason: string | null;
  readonly created_at_utc: string;
  readonly updated_at_utc: string;
}

const EDGE_COLUMNS =
  "id, relation_type, src_kind, dst_kind, src_id, dst_id, lifecycle_status, created_by, " +
  "origin_suggestion_id, origin_parse_run_id, evidence_reason, created_at_utc, updated_at_utc";

export interface GraphEdgeInput {
  readonly relationType: string;
  readonly srcEntityId: string;
  readonly dstEntityId: string;
  readonly createdBy: GraphEdgeCreator;
  /** 来源解析运行（§3.5）。`null` / 缺席 = 「不是某次解析产出的」，与「用户手工边」不混为一谈。 */
  readonly originParseRunId?: string | null;
  /** `parse_run:<id> rev:<id> span:<start>-<end>` 形态的来源说明；拼装属 M7-2，本层只照写。 */
  readonly evidenceReason?: string | null;
  /** 缺席用构造注入的时钟；两个时间列同一次写入取同一个时刻。 */
  readonly now?: Date;
}

export interface InsertEdgeResult {
  readonly row: GraphEdgeRow;
  /** `false` = 同 `(relation_type, src_id, dst_id)` 已有行，本次一个字都没改（R5）。 */
  readonly created: boolean;
}

/** 一条 `entity` 行的生命周期面（本层只读这两列，不碰别的）。 */
interface EntityLifecycleRow {
  readonly lifecycle_status: string;
}

export interface GraphStoreOptions {
  readonly now?: () => Date;
}

/**
 * `graph_edge` 的存储服务（M7-1 的全部面积）。
 *
 * 写面只有 `graph_edge` 一张表；`entity` / `parse_run` 只读（核对端点与来源指针是否存在）。
 * 时间列一律 `toISOString()`，与既有 `*_utc` 列同形（迁移 CHECK 认这个形态）。
 * **不开事务**：`commitDerived` 的同事务写入（§3.5）由调用方负责，本层的每条语句都是
 * 单语句原子，重复插入的并发安全交给 `ON CONFLICT DO NOTHING` 而不是包一层事务。
 */
export class GraphStore {
  private readonly db: Database;
  private readonly now: () => Date;

  constructor(db: Database, options: GraphStoreOptions = {}) {
    this.db = db;
    this.now = options.now ?? (() => new Date());
  }

  private rowByTriple(relationType: string, srcId: string, dstId: string): GraphEdgeRow | null {
    const found = this.db
      .prepare(`select ${EDGE_COLUMNS} from graph_edge where relation_type = ? and src_id = ? and dst_id = ?`)
      .get(relationType, srcId, dstId) as unknown as GraphEdgeRow | undefined;
    return found ?? null;
  }

  /**
   * 「有则原样返回，无则插入」（R5 的落点）。
   *
   * 写入面**限于实体↔实体的边**（`possibly_related` 是 episode×episode、`merged_into` 是
   * concept×concept，两者由既有的候选/合并路径写）；该配哪种端点这件事已经写在 `enums.json`
   * 的 `source`/`target` 上了，本层按它判，不让调用方各自猜一份。
   *
   * 三条口径：
   *  - **命中既有行时一个字都不改**：不改 `lifecycle_status`、不刷新 `updated_at_utc`、
   *    不换 `evidence_reason`。用户边尤其：重跑不得改写用户已经确认过的东西（§五-3）。
   *    实现上先按归一后的三元组回读，读得到就直接返回；读不到才 INSERT，且 INSERT 走
   *    `ON CONFLICT DO NOTHING` + 回读，所以「同事务内两次调用」与「并发」都收敛到同一行。
   *  - **无向类型先归一方向**（R6）：`src_id > dst_id` 就交换两端，于是「A 和 B 是同事」与
   *    「B 和 A 是同事」拼出同一个三元组、落同一行。有向类型（`reports_to` / `merged_into`）
   *    不归一——方向本身就是信息（下属 → 上级），正反是两行。
   *  - **端点不合规则整条不写**，抛 `GraphEdgeEndpointError`：这是 §3.5「丢弃并计数」的物理动作，
   *    计数器属 M7-2。这里绝不 `insert into entity`、绝不把 `provisional` 改成 `active`（§五-2）。
   */
  insertEdgeIfAbsent(input: GraphEdgeInput): InsertEdgeResult {
    const spec = EDGE_RELATIONS.get(input.relationType);
    if (spec === undefined) {
      throw new GraphEdgeInputError(
        `关系类型不在 GraphEdge 的取值集内（9 值之外的类型要么走 Mention 投影、要么不入图）：${input.relationType}`,
      );
    }
    if (spec.source.kind !== "entity" || spec.target.kind !== "entity") {
      throw new GraphEdgeInputError(
        `本层只写实体↔实体的边，${input.relationType} 的端点是 ${spec.source.kind}/${spec.target.kind}`,
      );
    }
    if (!isGraphEdgeCreator(input.createdBy)) {
      throw new GraphEdgeInputError(`边的写入者取值不在 created_by 集合内：${String(input.createdBy)}`);
    }
    if (input.createdBy === "ai_generated" && AI_NEVER_CREATE.has(input.relationType)) {
      throw new GraphEdgeInputError(`AI 永不创建的关系类型，不得以 ai_generated 入库：${input.relationType}`);
    }
    const first = input.srcEntityId;
    const second = input.dstEntityId;
    if (first === "" || second === "") {
      throw new GraphEdgeInputError("关系端点的实体 id 不得为空");
    }
    if (first === second) {
      throw new GraphEdgeInputError(`关系端点是同一个实体，不入库：${input.relationType} / ${first}`);
    }

    // 方向归一：无向类型按实体 id 字典序（与迁移的 `src_id <= dst_id` CHECK 同一口径）。
    const [srcId, dstId] = spec.directed || first <= second ? [first, second] : [second, first];

    const existing = this.rowByTriple(input.relationType, srcId, dstId);
    if (existing !== null) return { row: existing, created: false };

    if (spec.source.requiresActive || spec.target.requiresActive) {
      this.requireActiveEntity(srcId);
      this.requireActiveEntity(dstId);
    } else {
      this.requireEntity(srcId);
      this.requireEntity(dstId);
    }

    const timestamp = (input.now ?? this.now()).toISOString();
    const inserted = this.db
      .prepare(
        `insert into graph_edge (
           id, relation_type, src_kind, dst_kind, src_id, dst_id, lifecycle_status, created_by,
           origin_suggestion_id, origin_parse_run_id, evidence_reason, created_at_utc, updated_at_utc
         )
         values (?, ?, 'entity', 'entity', ?, ?, 'active', ?, NULL, ?, ?, ?, ?)
         on conflict (relation_type, src_id, dst_id) do nothing`,
      )
      .run(
        newId("graphEdge"),
        input.relationType,
        srcId,
        dstId,
        input.createdBy,
        input.originParseRunId ?? null,
        input.evidenceReason ?? null,
        timestamp,
        timestamp,
      );

    const row = this.rowByTriple(input.relationType, srcId, dstId);
    if (row === null) {
      // 要么插进去、要么同行已在（DO NOTHING），两种情况都读得回来。读不回来只可能是并发 CASCADE
      // 把端点删了——如实报错，不静默返回「没建成」。
      throw new Error(`写入关系边后读不回三元组：${input.relationType} / ${srcId} / ${dstId}`);
    }
    return { row, created: Number(inserted.changes ?? 0) === 1 };
  }

  /** 该实体为**任一端点**的边（无向类型归一后它可能在 src 也可能在 dst，两个方向都要读到）。 */
  edgesOfEntity(entityId: string): GraphEdgeRow[] {
    return this.db
      .prepare(
        `select ${EDGE_COLUMNS} from graph_edge
         where (src_kind = 'entity' and src_id = ?) or (dst_kind = 'entity' and dst_id = ?)
         order by created_at_utc, id`,
      )
      .all(entityId, entityId) as unknown as GraphEdgeRow[];
  }

  /** 某个 parse_run 产出的边（§3.5 的来源指针；存量老边 `origin_parse_run_id` 为 NULL，不在这一面里）。 */
  edgesOfRun(parseRunId: string): GraphEdgeRow[] {
    return this.db
      .prepare(`select ${EDGE_COLUMNS} from graph_edge where origin_parse_run_id = ? order by created_at_utc, id`)
      .all(parseRunId) as unknown as GraphEdgeRow[];
  }

  private entityLifecycle(entityId: string): string | undefined {
    const row = this.db
      .prepare("select lifecycle_status from entity where id = ?")
      .get(entityId) as EntityLifecycleRow | undefined;
    return row?.lifecycle_status;
  }

  private requireEntity(entityId: string): void {
    if (this.entityLifecycle(entityId) === undefined) throw new GraphEdgeEndpointError("missing", entityId);
  }

  private requireActiveEntity(entityId: string): void {
    const status = this.entityLifecycle(entityId);
    if (status === undefined) throw new GraphEdgeEndpointError("missing", entityId);
    if (status !== "active") throw new GraphEdgeEndpointError("not_active", entityId);
  }
}
