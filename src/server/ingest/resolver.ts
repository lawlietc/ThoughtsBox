/**
 * 概念/实体解析器（D10）。
 *
 * 契约取值：Spec §3.2.3「概念归属由本地解析器决定」、Spec §4.3 别名机制、
 * Schema §3.11/§3.13、M2 规格交付项「解析器的概念归属顺序」。
 *
 * 顺序是**冻结的三步**，不接受任何越级：
 *
 * 1. `mode=auto` 的别名表命中（K-14：`auto` 只由词表数据文件设定，模型无权）；
 * 2. 标准名精确命中；
 * 3. 其余进入待确认队列——本模块**只判定、只给出建议种类**，不写库。
 *
 * 模型输出的 `candidateConceptId` 在这套顺序里**没有定位**：它不构成写入权限
 * （Spec §3.2.3、M2 规格输出契约），只用来决定第 3 步的承接种类——
 * 点名了既存概念 ⇒ `Suggestion(kind=alias)`（§3.17 端点矩阵要求别名建议必带既存
 * concept 端点，否则无法确认）；没点名 ⇒ `Suggestion(kind=new_concept)`。
 * 命中 `mode=suggest` 的别名同样走 `kind=alias`（§4.3「近义词一律 suggest，
 * 只生成建议，用户确认后才写入别名表并生效」）。
 *
 * 实体一侧与概念一侧**不对称**，这是契约明确规定的（§3.13/B5/K-12）：
 * 别名→实体不做跨实体全局唯一，同名不同人是常态，所以解析返回**候选列表**，
 * 多于一个候选即不写入，绝不自动合并。
 */

import type { Database } from "../db/adapter.ts";
import type { ConceptIndex } from "./contract.ts";

/** 解析策略版本，落 `pipeline_manifest.resolver`（指令 §8.1 的「实体解析策略」）。 */
export const RESOLVER_VERSION = "resolver-v1";

export type ConceptDomain = "emotion" | "topic";

/** 命中途径：只有这两种才算「解析成功」，顺序即 §3.2.3 的两步。 */
export type ConceptMatchVia = "auto_alias" | "canonical_name";

export interface ConceptMatch {
  readonly conceptId: string;
  readonly canonicalName: string;
  readonly via: ConceptMatchVia;
}

/** 建议种类取自 0003 `suggestion.kind` 的封闭集，本模块不新增取值。 */
export type ResolverSuggestionKind = "alias" | "new_concept";

export type ConceptResolution =
  | { readonly kind: "resolved"; readonly match: ConceptMatch }
  | {
      readonly kind: "suggestion";
      readonly suggestionKind: ResolverSuggestionKind;
      /** `alias` 的既存目标概念；`new_concept` 为 null。 */
      readonly targetConceptId: string | null;
    };

export type EntityResolution =
  | { readonly kind: "resolved"; readonly entityId: string }
  /** §3.13：多于一个候选 ⇒ 由用户选择，本层不写 Mention。 */
  | { readonly kind: "ambiguous"; readonly candidates: readonly string[] }
  | { readonly kind: "unmatched" };

/** 参与归一化的别名行：`mode` 决定它是权限还是建议（§4.3）。 */
interface AliasRow {
  readonly concept_id: string;
  readonly canonical_name: string;
  readonly mode: string;
}

/**
 * 归档/已合并的概念不再接收新的自动归一（§4.2：`merged` 由 merged_into 驱动，
 * mention 不迁移；`archived` 不是删除但也不该被重新提出）。
 */
const LIVE_CONCEPT = "c.lifecycle_status = 'active'";

/**
 * 实体候选集合：`provisional` 与 `active` 都可以承载提及（Spec §3.1：
 * Provisional Entity 可用于本地身份映射，只是不进默认图谱），`archived` 排除。
 */
const LIVE_ENTITY = "lifecycle_status IN ('provisional', 'active')";

export class ConceptResolver {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  /**
   * §3.2.3 的三步顺序。匹配一律按 NFC 比较——`label_said` 与证据里保留用户原词逐字
   * （§4.3「归一化不改写原文」），归一化只发生在**匹配**这一步。
   */
  resolveConcept(domain: ConceptDomain, labelSaid: string, candidateConceptId: string | null = null): ConceptResolution {
    const term = labelSaid.normalize("NFC");
    const alias = this.#aliasHit(domain, term);
    if (alias !== null) {
      if (alias.mode === "auto") {
        return {
          kind: "resolved",
          match: { conceptId: alias.concept_id, canonicalName: alias.canonical_name, via: "auto_alias" },
        };
      }
      return { kind: "suggestion", suggestionKind: "alias", targetConceptId: alias.concept_id };
    }

    const canonical = this.#db
      .prepare(
        `select c.id as concept_id, c.canonical_name as canonical_name
           from concept as c
          where c.concept_type = ? and c.canonical_name = ? and ${LIVE_CONCEPT}`,
      )
      .get(domain, term) as { concept_id: string; canonical_name: string } | undefined;
    if (canonical !== undefined) {
      return {
        kind: "resolved",
        match: { conceptId: canonical.concept_id, canonicalName: canonical.canonical_name, via: "canonical_name" },
      };
    }

    // 第 3 步：未归属。点名既存概念 ⇒ 别名建议；否则新概念建议。
    return {
      kind: "suggestion",
      suggestionKind: candidateConceptId === null ? "new_concept" : "alias",
      targetConceptId: candidateConceptId,
    };
  }

  #aliasHit(domain: ConceptDomain, term: string): AliasRow | null {
    const row = this.#db
      .prepare(
        `select ca.concept_id as concept_id, c.canonical_name as canonical_name, ca.mode as mode
           from concept_alias as ca
           join concept as c on c.id = ca.concept_id
          where ca.domain = ? and ca.alias = ? collate binary and ${LIVE_CONCEPT}`,
      )
      .get(domain, term) as AliasRow | undefined;
    return row ?? null;
  }

  /**
   * 实体解析：别名命中 + 标准名命中合并成**候选列表**（§3.13）。
   * 恰有一个候选才落 Mention；多于一个 ⇒ `ambiguous`，由用户选择。
   */
  resolveEntity(labelSaid: string): EntityResolution {
    const term = labelSaid.normalize("NFC");
    const aliases = this.#db
      .prepare(
        `select entity_id as id from entity_alias
          where alias = ? collate binary
            and entity_id in (select id from entity where ${LIVE_ENTITY})`,
      )
      .all(term) as Array<{ id: string }>;
    const names = this.#db
      .prepare(`select id from entity where canonical_name = ? and ${LIVE_ENTITY}`)
      .all(term) as Array<{ id: string }>;

    const candidates: string[] = [];
    for (const row of [...aliases, ...names]) {
      if (!candidates.includes(row.id)) candidates.push(row.id);
    }
    if (candidates.length === 0) return { kind: "unmatched" };
    if (candidates.length > 1) return { kind: "ambiguous", candidates };
    const only = candidates[0] as string;
    return { kind: "resolved", entityId: only };
  }

  /**
   * 业务门的已知概念索引（`contract.ts` 的 `knownConcepts`）：库里现读，
   * 覆盖播种概念与用户自建/用户确认概念——`seedConceptIndex()` 只覆盖种子，
   * 注入这里是它的补集（contract.ts 头注点明的分工）。
   */
  knownConcepts(): ConceptIndex {
    const rows = this.#db
      .prepare(`select c.id as id, c.concept_type as concept_type from concept as c where ${LIVE_CONCEPT}`)
      .all() as Array<{ id: string; concept_type: string }>;
    const index = new Map<string, ConceptDomain>();
    for (const row of rows) index.set(row.id, row.concept_type as ConceptDomain);
    return index;
  }

  /** 业务门的已知实体集合（`knownEntityIds`）：实体候选 ID 必须已在册（K-14 同构）。 */
  knownEntityIds(): ReadonlySet<string> {
    const rows = this.#db.prepare(`select id from entity where ${LIVE_ENTITY}`).all() as Array<{ id: string }>;
    return new Set(rows.map((row) => row.id));
  }

  /** 概念域现读：写入侧据此决定落哪张 Mention 表。 */
  conceptDomainOf(conceptId: string): ConceptDomain | null {
    const row = this.#db
      .prepare(`select c.concept_type as concept_type from concept as c where c.id = ? and ${LIVE_CONCEPT}`)
      .get(conceptId) as { concept_type: string } | undefined;
    return row === undefined ? null : (row.concept_type as ConceptDomain);
  }
}
