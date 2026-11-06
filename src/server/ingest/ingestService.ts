/**
 * Ingest 编排服务（D12 + 编排门）。
 *
 * 契约依据：Schema §3.7（当前视图 join）/ §3.19（候选采纳制）/ §4.7（ParseRun 双态）/
 * §4.8（处理状态机）/ §7.1（同任务重试幂等）/ §7.4（修正持久化与防复活）/ §7.6（证据回锚与修复）、
 * ADR-007 / ADR-011、Spec §3.2.2–§3.2.4 / §5.2–§5.4、指令 §8.1–§8.4 / §9.1–§9.4。
 *
 * 本模块只做四件事，且每件只有一处实现：
 *
 * 1. **闸门**：判定源是记录在册的**三轴**（M6-0C / 草案 §二、§五）；`resolveMode` /
 *    `resolveAxes` 只允许调用方**核对**在册值，不允许替用户改隐私承诺。
 *    `analysis_provider=none`、本地分析配非回环端点、占位而未实现的 `redaction_mode`
 *    由 `assertSendable` 在任何写入之前拒；任何一次外发（`send_content_mode ≠ none`，
 *    `raw` 与 `redacted` 皆然）在本层补上 Provider 层无法强制的「必带载荷 + 必带本次授权」门，
 *    `redacted` 另补「必带脱敏映射」门（M2-4 复审裁决 3），缺任何一件都是零写入。
 * 2. **ParseRun 生命周期**：`idempotency_key = f(revision, fingerprint)`，命中即复用同一行
 *    （§7.1）；崩溃遗留的 `running` 走 running→failed→queued→running 的合法链恢复。
 * 3. **派生写入**：一个事务内完成 run→succeeded + Episode/ThoughtItem/Mention/Suggestion +
 *    `graph_edge` 关系边（M7-2b，准则 §3.5）+ 记录态→parsed（指令 §8.2「任务半途失败不得留下
 *    部分有效的对象」）。
 * 4. **采纳与放弃**：`candidate→current` 与旧 `current→superseded` 同事务切换（§3.19 第 4 步），
 *    带用户修正的旧行一律不被动（§3.19 第 2 步）。
 *
 * 状态机转换表只从 `enums.json` 读（I3 单一事实源），本文件不抄第二份取值；
 * 降级留痕对外收敛为**数组**（M2-4 复审裁决 2）。
 */

import {
  applyOverrides,
  CorrectionService,
  mentionShapeFor,
  type OverrideRow,
  type OverridableTable,
  type PatchCollection,
} from "../correction/service.ts";
import type { Database } from "../db/adapter.ts";
import type { LocalLlmStatus } from "../config/config.ts";
import { loadContracts, type Contracts } from "../../shared/contracts/load.ts";
import {
  assertThreeAxes,
  coerceAxes,
  deriveProcessingMode,
  isEgress,
  type ThreeAxes,
} from "../../shared/contracts/enums.ts";
import { newId } from "../../shared/contracts/ids.ts";
import { pipelineFingerprint, type PipelineManifest } from "../privacy/manifest.ts";
import {
  parseRedactionMap,
  redactionMapJsonValue,
  SEMANTIC_REDACTION_KINDS,
  type RedactionMap,
} from "../privacy/redaction.ts";
import { restorePlaceholders } from "../privacy/placeholderRestore.ts";
import { resolveOrCreateEntity } from "../entities/entityIdentity.ts";
import {
  assertSendable,
  buildRunManifest,
  invokeExtraction,
  ProviderError,
  type ExtractionOutcome,
  type ExtractionRequest,
  type ModelAdapter,
  type ParseErrorKind,
  type ProcessingMode,
  type ProviderCallPath,
  type ProviderTransport,
} from "./provider.ts";
import {
  BUSINESS_RULES,
  BusinessValidationError,
  ContractSchemaError,
  parseStructuredOutput,
  validateBusiness,
  validateRelations,
  type BusinessValidationResult,
  type ExtractedEventTime,
  type StructuredOutput,
  type ValidatedRelation,
} from "./contract.ts";
import {
  EVIDENCE_REPAIR_KIND,
  planEvidence,
  writeEvidenceRepairSuggestion,
  type EvidenceFailure,
  type ExtractionPlan,
} from "./evidence.ts";
import { GraphEdgeEndpointError, GraphStore } from "../graph/store.ts";
import { ConceptResolver, RESOLVER_VERSION } from "./resolver.ts";
import type { TraceSession } from "./trace.ts";

const DEFAULT_CONTRACTS: Contracts = loadContracts();

/**
 * 三轴的短标识（`ap|rm|sc`）。
 *
 * 只由封闭枚举成员拼成，所以可以安全进错误消息、日志与 Trace（指令 §11.2：那个位置
 * 永不可能出现原文、词面或映射）。错误消息点名「在册的是什么」是这道闸门有用与否的关键——
 * 只说「不一致」而不说当前值，调用方无从知道自己错在哪一半。
 */
function axesKey(axes: ThreeAxes): string {
  return `${axes.analysisProvider}|${axes.redactionMode}|${axes.sendContentMode}`;
}

/** 版本串一旦改动就是新管线，而不是新常量：默认值与 `contract.ts`、M2-4 夹具同源。 */
export const DEFAULT_PROMPT_VERSION = "m2-prompt-v2";
export const DEFAULT_OUTPUT_SCHEMA_VERSION = "m2-output-v2";
export const DEFAULT_VALIDATION_VERSION = "validation-v1";

let savepointCounter = 0;

/**
 * 可重入事务：与 `correction/service.ts` 同法用 SAVEPOINT。
 * 采纳路径要调进 `CorrectionService.migrateOverride()`，它自己也开事务；
 * 裸 BEGIN 在已有事务里直接抛「within a transaction」，两层必须能合成一个原子单元。
 */
function inTransaction<T>(db: Database, body: () => T): T {
  savepointCounter += 1;
  const name = `sp_ingest_${savepointCounter}`;
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

// ── 状态机（§4.7 / §4.8 / §4.4）─────────────────────────────────────

export type StateMachineName =
  | "ParseRun.execution_status"
  | "ParseRun.result_state"
  | "Mention.status"
  | "Episode.lifecycle_status"
  | "ThoughtItem.lifecycle_status"
  | "processing_status";

export interface StateMachine {
  readonly values: readonly string[];
  readonly transitions: Readonly<Record<string, readonly string[]>>;
}

/**
 * `processing_status` 的转换表在 enums.json 顶层（I3 落点），其余四类在
 * `lifecycle_states` 下按 `对象.字段` 命名。两处都过封闭集校验，这里不再验取值。
 */
export function stateMachine(name: StateMachineName, enums: Contracts["enums"] = DEFAULT_CONTRACTS.enums): StateMachine {
  if (name === "processing_status") {
    return { values: enums.processing_status_transitions.values, transitions: enums.processing_status_transitions.transitions };
  }
  const spec = enums.lifecycle_states[name];
  if (spec === undefined) throw new IngestStateError(`enums.json 缺少状态机：${name}`);
  return { values: spec.values, transitions: spec.transitions };
}

export function isStateTransitionAllowed(
  machine: StateMachineName,
  from: string,
  to: string,
  enums?: Contracts["enums"],
): boolean {
  const spec = stateMachine(machine, enums);
  if (!spec.values.includes(from) || !spec.values.includes(to)) return false;
  return (spec.transitions[from] ?? []).includes(to);
}

/** 非法转换即抛：状态机是契约不是建议。 */
export function assertStateTransition(
  machine: StateMachineName,
  from: string,
  to: string,
  enums?: Contracts["enums"],
): void {
  if (isStateTransitionAllowed(machine, from, to, enums)) return;
  const legal = (stateMachine(machine, enums).transitions[from] ?? []).join("、") || "终态，无出边";
  throw new IngestStateError(`${machine} 不允许 ${from} → ${to}（${from} 的合法去向：${legal}）`);
}

// ── 错误 ────────────────────────────────────────────────────────────

export class IngestInputError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "IngestInputError";
  }
}

/** 状态机拒绝：转换表里没有这条边，或库里读到的态不在封闭集内。 */
export class IngestStateError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "IngestStateError";
  }
}

/**
 * 裁决 3（M2-4 复审）：`ExtractionRequest.redactionMap` 是可选的，Provider 层无法表达
 * 「发送脱敏文本必带映射」。编排层在发起调用之前补这道门：缺映射即拒，一次请求都不发出、
 * 一行数据都不写。
 *
 * M6-0C 起判据换成 `send_content_mode === "redacted"`：不外发的路径不需要映射（没有第二份
 * 文本要对齐），发**原文**的路径也不受此门约束——矩阵 #9 的定义就是不脱敏，要求映射反而是矛盾。
 */
export class RedactionMapRequiredError extends Error {
  readonly recordRevisionId: string;

  constructor(recordRevisionId: string) {
    super(
      "send_content_mode=redacted 必须携带本次脱敏映射，否则证据无法回锚原文坐标（§7.6.1）：" +
        recordRevisionId,
    );
    this.name = "RedactionMapRequiredError";
    this.recordRevisionId = recordRevisionId;
  }
}

export class RunNotFoundError extends Error {
  constructor(runId: string) {
    super(`ParseRun 不存在：${runId}`);
    this.name = "RunNotFoundError";
  }
}

/** 采纳/放弃的前置条件不成立。 */
export class RunNotAdoptableError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "RunNotAdoptableError";
  }
}

/**
 * 重新分析的前置条件不成立（M8-D-8）：这一版本上已经有一份在途的解析（`queued` / `running`），
 * 不再开第二单。路由映射 409 `state_conflict`。
 *
 * 消息只带 run id 与执行态：这两个都是库里的标识符与枚举值，重新分析被拒这件事不构成新的外发面，
 * 因此这里**绝不**拼任何载荷文本或模型输出。
 */
export class ReanalysisInFlightError extends Error {
  readonly runId: string;
  readonly executionStatus: string;

  constructor(runId: string, executionStatus: string) {
    super(`该版本已有一次解析在途，重新分析被拒：${runId} (${executionStatus})`);
    this.name = "ReanalysisInFlightError";
    this.runId = runId;
    this.executionStatus = executionStatus;
  }
}

// ── 数据结构 ────────────────────────────────────────────────────────

export interface ParseRunRow {
  readonly id: string;
  readonly source_revision_id: string;
  readonly pipeline_manifest: string;
  readonly pipeline_fingerprint: string;
  readonly idempotency_key: string;
  readonly execution_status: string;
  readonly result_state: string;
  readonly error_kind: string | null;
  readonly started_at_utc: string;
  readonly finished_at_utc: string | null;
}

export interface RevisionContext {
  readonly recordId: string;
  readonly revisionId: string;
  readonly rawText: string;
  readonly processingStatus: string;
  /** 派生只读兼容字段，只用于对外展示与核对；判定读 `axes`（草案 §五）。 */
  readonly processingMode: ProcessingMode;
  /** 记录级三轴（草案 §二）：本服务一切闸门的唯一判定源。 */
  readonly axes: ThreeAxes;
}

export interface IngestInput {
  readonly recordRevisionId: string;
  /** 省略则取记录在册的 `processing_mode`；显式传入必须与之一致（见 `resolveMode`）。 */
  readonly processingMode?: ProcessingMode;
  /** 省略则取在册三轴；显式传入必须与之一致（见 `resolveAxes`）——隐私承诺不是调用参数。 */
  readonly axes?: ThreeAxes;
  /** 实际准备发送的那份文本：任何一次外发（`send_content_mode ≠ none`）必填且必须是用户确认过的那份；本地模式省略即原文。 */
  readonly payloadText?: string;
  readonly redactionMap?: RedactionMap;
  readonly signal?: AbortSignal;
  /**
   * 用户显式触发的重新分析（M8-D-4）：同一条管线上再开一单，键带尝试序号。
   * 缺席或 false ⇒ 幂等键与既有行为逐字不变。
   */
  readonly reanalysis?: boolean;
  /**
   * Phase B（PD-1）：首次整理（该 revision 没有 current）成功后自动生效。
   * 产品侧（op2 / reparse / reanalyze / 后台执行体）传 true；缺省 false 保留服务层原语语义，
   * 便于测试与显式控制。已有 current 时无论传什么都仍落 candidate。
   */
  readonly autoAdoptFirstResult?: boolean;
}

/** `beginRun` 的产物：run 行已提交，尚未发起任何模型调用。 */
export interface RunHandle {
  readonly runId: string;
  readonly idempotencyKey: string;
  readonly pipelineFingerprint: string;
  readonly manifest: PipelineManifest;
  readonly processingMode: ProcessingMode;
  readonly request: ExtractionRequest;
  readonly context: RevisionContext;
  /** 命中已 `succeeded` 的同键 run：不再发起调用、不再写任何派生行。 */
  readonly replayed: boolean;
  /** 本次续跑恢复了上一进程遗留的 `running` 行（崩溃重放，§7.1）。 */
  readonly recovered: boolean;
}

export interface IngestWriteCounts {
  readonly episodes: number;
  readonly thoughts: number;
  readonly mentions: number;
  /** 命中防复活而直接落成 rejected 的提及（T-06）。 */
  readonly rejectedMentions: number;
  readonly suggestions: number;
  readonly evidenceRepairs: number;
  /** 同 run 内命中部分唯一索引而被并入的重复条目（索引键即 run 内身份）。 */
  readonly deduplicated: number;
  /** `basis=inferred` 的非情绪标签：契约未点名建议种类，本层不发明取值（§3.2.2 只覆盖情绪）。 */
  readonly unrouted: number;
  /** 歧义或未命中的实体标签数（§3.13：由用户选择，本层绝不自动合并）。 */
  readonly unresolvedEntities: number;
  /** 真写进 `graph_edge` 的关系条数（M7-2b / §3.5）。已存在的同三元组不算新写入（R5：一个字都不改）。 */
  readonly relations: number;
  /**
   * 关系门（§3.4）作废的条数：类型不在六值内、两端同词、证据回锚不出、词面无逐字依据。
   * 与下面三类的区别是**来源**——那三类到了写入面才被判，这一类连写入面都没进。
   * 坏一条只丢那一条，所以这个数不等于 run 失败。
   */
  readonly relationDroppedByContract: number;
  /** 关系端点解析歧义而丢弃的条数（§3.5 三类分开计数：诊断时「为什么没边」是三个不同的答案）。 */
  readonly relationAmbiguous: number;
  /** 关系端点未解析到在册实体、或词面不属于本条记录而丢弃的条数。 */
  readonly relationUnmatched: number;
  /** 关系端点仍是 `provisional` 而丢弃的条数（R3：实体不转正）。 */
  readonly relationProvisional: number;
}

/** commitDerived 边写边累计需要可变面；对外交出的仍是上面的只读面。 */
type MutableIngestWriteCounts = { -readonly [K in keyof IngestWriteCounts]: IngestWriteCounts[K] };

/** 建议槽位被不同词面占据而未能提出的项（0003 表级 UNIQUE 的实际粒度）。 */
export interface SuggestionCollision {
  readonly kind: string;
  readonly endpointA: string;
  /** 库里既存行的词面：保持原状，含用户的 `ignored` 状态。 */
  readonly heldTerm: string;
  /** 本次想提而未能提出的词面。 */
  readonly droppedTerm: string;
}

export interface IngestFailure {
  readonly errorKind: ParseErrorKind | null;
  readonly retryable: boolean;
  readonly message: string;
  /** 逐条失败说明（规则标识 + 内部定位，不含原文）。 */
  readonly issues: readonly string[];
}

export interface IngestResult {
  readonly runId: string;
  readonly idempotencyKey: string;
  readonly pipelineFingerprint: string;
  /** 派生只读兼容字段（草案 §五）。 */
  readonly processingMode: ProcessingMode;
  /** 本次实际按哪三轴装配（§七 断言 7：`cloud_raw` 与 `cloud_redacted` 必须可区分）。 */
  readonly axes: ThreeAxes;
  readonly succeeded: boolean;
  readonly replayed: boolean;
  readonly recovered: boolean;
  /** Phase B：首次整理（该 revision 没有 current）成功后自动生效；重跑/已有 current 时为 false。 */
  readonly autoAdopted: boolean;
  readonly provider: string;
  readonly model: string;
  readonly callPath: ProviderCallPath;
  /** 裁决 2：对外一律数组；诊断串只是同一事实的另一种写法，逐值相等由测试对账。 */
  readonly attemptedPaths: readonly ProviderCallPath[];
  readonly degraded: boolean;
  /** 与库里 `parse_run.error_kind`、Trace 同值的对外投影；成功即 null，不是「缺席」。 */
  readonly errorKind: ParseErrorKind | null;
  readonly writes: IngestWriteCounts;
  readonly collisions: readonly SuggestionCollision[];
  readonly title: string;
  readonly summary: string;
  readonly failure?: IngestFailure;
}

interface CandidateLabelWrite {
  readonly collection: PatchCollection;
  readonly labelSaid: string;
  readonly candidateConceptId: string | null;
  readonly basis: string;
  readonly evidenceText: string;
  readonly evidenceStart: number;
  readonly evidenceEnd: number;
  readonly route: string;
  readonly suggestionKind: string | null;
}

interface CandidateEpisodeWrite {
  readonly summary: string;
  readonly eventTime: ExtractedEventTime;
  readonly evidenceText: string;
  readonly evidenceStart: number;
  readonly evidenceEnd: number;
}

interface CandidateThoughtWrite {
  readonly text: string;
  readonly evidenceText: string;
  readonly evidenceStart: number;
  readonly evidenceEnd: number;
}

interface WritePlan {
  readonly episodes: readonly CandidateEpisodeWrite[];
  readonly thoughts: readonly CandidateThoughtWrite[];
  readonly labels: readonly CandidateLabelWrite[];
}

export function emptyWrites(): IngestWriteCounts {
  return {
    episodes: 0,
    thoughts: 0,
    mentions: 0,
    rejectedMentions: 0,
    suggestions: 0,
    evidenceRepairs: 0,
    deduplicated: 0,
    unrouted: 0,
    unresolvedEntities: 0,
    relations: 0,
    relationDroppedByContract: 0,
    relationAmbiguous: 0,
    relationUnmatched: 0,
    relationProvisional: 0,
  };
}

/**
 * 关系边 `evidence_reason` 的证据原文上限（准则 §3.5）。
 * 原文本来就在 `record_revision.raw_text` 与 `entity_mention.evidence_text` 里，截断只是不让
 * 一列变成第二份长文存储。
 */
const RELATION_EVIDENCE_MAX_CHARS = 200;

/** `parse_run:<runId> rev:<revisionId> span:<start>-<end> evidence=<原文≤200 字>`（§3.5）。 */
function relationEvidenceReason(runId: string, revisionId: string, relation: ValidatedRelation): string {
  const span = `${relation.evidenceStart}-${relation.evidenceEnd}`;
  return (
    `parse_run:${runId} rev:${revisionId} span:${span} ` +
    `evidence=${relation.evidenceText.slice(0, RELATION_EVIDENCE_MAX_CHARS)}`
  );
}

/**
 * 逻辑任务的唯一身份：同一 revision + 同一管线 = 同一任务（§7.1、K-03）。
 * `attempt` 只在用户显式重新分析时 >1（M8-D-4）：第 1 单的键逐字保持旧形状，
 * 之后的单才追加 `_a<attempt>` 后缀——否则既有幂等/重放面会换一个身份。
 */
export function deriveIdempotencyKey(recordRevisionId: string, fingerprint: string, attempt = 1): string {
  const base = `idem_${recordRevisionId}_${fingerprint}`;
  return attempt <= 1 ? base : `${base}_a${attempt}`;
}

/**
 * 裁决 2 的收敛点：Provider 把降级留痕写成 `join(">")` 的字符串，而
 * `ExtractionOutcome.attemptedPaths` 是数组。编排层对外只暴露数组，因此这里把诊断串
 * 还原成同一条序列——不修改 Provider，也不留两份真相。
 */
export function attemptedPathsFromDiagnostics(diagnostics: unknown): readonly ProviderCallPath[] {
  if (typeof diagnostics !== "string" || diagnostics === "") return [];
  return diagnostics.split(">").filter((path) => path !== "") as readonly ProviderCallPath[];
}

/**
 * §3.2.2 的路由规则：`inferred` 永不成 Mention。情绪有专门的建议种类，
 * 其余推断标签契约未点名种类，本层不发明取值（`unrouted`）。
 */
export function routeFor(
  collection: PatchCollection,
  basis: string,
): { readonly route: "mention" | "suggestion" | "unrouted"; readonly suggestionKind: string | null } {
  if (basis === "explicit") return { route: "mention", suggestionKind: null };
  if (collection === "emotions") return { route: "suggestion", suggestionKind: "emotion_candidate" };
  return { route: "unrouted", suggestionKind: null };
}

function toWritePlan(result: BusinessValidationResult): WritePlan {
  const labels: CandidateLabelWrite[] = [];
  for (const collection of ["emotions", "topics", "entities"] as const) {
    for (const label of result[collection]) {
      labels.push({
        collection,
        labelSaid: label.labelSaid,
        candidateConceptId: label.candidateConceptId,
        basis: label.basis,
        evidenceText: label.evidenceText,
        evidenceStart: label.evidenceStart,
        evidenceEnd: label.evidenceEnd,
        route: label.route,
        suggestionKind: label.suggestionKind,
      });
    }
  }
  return {
    episodes: result.episodes.map((episode) => ({
      summary: episode.summary,
      eventTime: episode.eventTime,
      evidenceText: episode.evidenceText,
      evidenceStart: episode.evidenceStart,
      evidenceEnd: episode.evidenceEnd,
    })),
    thoughts: result.thoughts.map((thought) => ({
      text: thought.text,
      evidenceText: thought.evidenceText,
      evidenceStart: thought.evidenceStart,
      evidenceEnd: thought.evidenceEnd,
    })),
    labels,
  };
}

/**
 * `evidence_unmapped` 分支的写入来源：逐条分流后的可采信条目。
 * 走到这里的前提是 `contract.ts` 的归桶规则保证「坏的只有证据类」，其余业务规则对每一条
 * 都已成立，所以路由按同一条 §3.2.2 规则现算即可。
 */
function planToWritePlan(plan: ExtractionPlan): WritePlan {
  const labels: CandidateLabelWrite[] = plan.labels.map((label) => {
    const route = routeFor(label.collection, label.basis);
    return {
      collection: label.collection,
      labelSaid: label.labelSaid,
      candidateConceptId: label.candidateConceptId,
      basis: label.basis,
      evidenceText: label.evidenceText,
      evidenceStart: label.evidenceStart,
      evidenceEnd: label.evidenceEnd,
      route: route.route,
      suggestionKind: route.suggestionKind,
    };
  });
  return {
    episodes: plan.episodes.map((episode) => ({
      summary: episode.summary,
      eventTime: episode.eventTime,
      evidenceText: episode.evidenceText,
      evidenceStart: episode.evidenceStart,
      evidenceEnd: episode.evidenceEnd,
    })),
    thoughts: plan.thoughts.map((thought) => ({
      text: thought.text,
      evidenceText: thought.evidenceText,
      evidenceStart: thought.evidenceStart,
      evidenceEnd: thought.evidenceEnd,
    })),
    labels,
  };
}

// ── 占位符回填与本地实体登记（D-2/D-3/D-7，2026-11-05）────────────────

interface EntityClaim {
  readonly name: string;
  readonly type: string;
}

interface EntityOccurrence extends EntityClaim {
  readonly start: number;
  readonly end: number;
}

/** 把回稿里的占位符换回真名（`evidence` 不动）。字段集合即 D-7。 */
function restoreOutputPlaceholders(
  output: StructuredOutput,
  map: RedactionMap,
  rawText: string,
): StructuredOutput {
  const r = (text: string): string => restorePlaceholders(text, map, rawText);
  // 云端看不到真实实体 ID，可能把占位符本身填进 `candidateConceptId`——带方括号
  //（`[person_1_x]`）或不带（`person_1_x`）都可能出现（实测两种都见过）。
  // 合法候选 ID 只可能是 `entity_` / `concept_` 前缀；其余形态一律不是可用 ID，回填后清空。
  // 实体身份改由回填后的真名经解析器/本机登记确定。
  const isRealCandidateId = (value: string): boolean =>
    value.startsWith("entity_") || value.startsWith("concept_");
  const id = (value: string | null): string | null =>
    value === null || isRealCandidateId(value) ? value : null;
  const label = <T extends { readonly labelSaid: string; readonly candidateConceptId: string | null }>(
    entry: T,
  ): T => ({ ...entry, labelSaid: r(entry.labelSaid), candidateConceptId: id(entry.candidateConceptId) });
  return {
    ...output,
    title: r(output.title),
    summary: r(output.summary),
    episodes: output.episodes.map((episode) => ({ ...episode, summary: r(episode.summary) })),
    thoughts: output.thoughts.map((thought) => ({ ...thought, text: r(thought.text) })),
    emotions: output.emotions.map(label),
    topics: output.topics.map(label),
    entities: output.entities.map(label),
    relations: output.relations.map((relation) => ({
      ...relation,
      srcLabel: r(relation.srcLabel),
      dstLabel: r(relation.dstLabel),
    })),
  };
}

/**
 * 从本机脱敏映射里抽出「要登记成实体」的语义 span。
 * 只取 `source === "local_llm"` 且 kind ∈ 人/地/组织：`entity_memory` span 已有实体、rule span 是格式类。
 */
function localEntityClaims(
  map: RedactionMap,
  rawText: string,
): { readonly claims: readonly EntityClaim[]; readonly occurrences: readonly EntityOccurrence[] } {
  const seen = new Set<string>();
  const claims: EntityClaim[] = [];
  const occurrences: EntityOccurrence[] = [];
  for (const span of map.spans) {
    if (span.source !== "local_llm") continue;
    if (!(SEMANTIC_REDACTION_KINDS as readonly string[]).includes(span.kind)) continue;
    const name = rawText.slice(span.originalStart, span.originalEnd);
    if (name.trim() === "") continue;
    const key = `${span.kind}\u0000${name.normalize("NFC")}`;
    if (!seen.has(key)) {
      seen.add(key);
      claims.push({ name, type: span.kind });
    }
    occurrences.push({ name, type: span.kind, start: span.originalStart, end: span.originalEnd });
  }
  return { claims, occurrences };
}

/**
 * 云端没为某个本机实体出标签时，用本机 span 自己补一条 explicit 提及，
 * 保证「人物与事物」里有这条实体时至少有一条真实出现记录。已被云端标签覆盖的词面不重复补。
 */
function syntheticEntityLabels(
  occurrences: readonly EntityOccurrence[],
  cloudEntities: readonly { readonly labelSaid: string }[],
): CandidateLabelWrite[] {
  const covered = new Set(cloudEntities.map((label) => label.labelSaid.normalize("NFC")));
  const labels: CandidateLabelWrite[] = [];
  for (const occurrence of occurrences) {
    if (covered.has(occurrence.name.normalize("NFC"))) continue;
    labels.push({
      collection: "entities",
      labelSaid: occurrence.name,
      candidateConceptId: null,
      basis: "explicit",
      evidenceText: occurrence.name,
      evidenceStart: occurrence.start,
      evidenceEnd: occurrence.end,
      route: "mention",
      suggestionKind: null,
    });
  }
  return labels;
}

export interface IngestServiceOptions {
  readonly db: Database;
  readonly adapter: ModelAdapter;
  readonly transport: ProviderTransport;
  readonly systemPrompt: string;
  readonly promptVersion?: string;
  readonly outputSchemaVersion?: string;
  readonly validationVersion?: string;
  readonly now?: () => Date;
  readonly trace?: TraceSession;
  /** 云端授权闸门：本层在写任何行之前调用一次，Provider 在发送时刻再校一次（两道门不互替）。 */
  readonly grantCheck?: () => void;
  /**
   * `redaction_mode=local_llm` 档的状态读数（M9-4b）：装配层从 `facts.config` 算好后递进来，
   * 本层与 Provider 都不读配置文件。省略即按「未配置」处理——那一档因此被拒，而不是被放行。
   */
  readonly localLlm?: LocalLlmStatus;
  readonly contracts?: Contracts;
}

/** 用户逐条确认后的新旧映射（§3.19 第 2 步）：只有列在这里的 override 才迁移指向。 */
export interface OverrideMigration {
  readonly objectTable: OverridableTable;
  readonly fromObjectId: string;
  readonly toObjectId: string;
  readonly fieldName: string;
}

export interface AdoptInput {
  readonly candidateRunId: string;
  readonly overrideMigrations?: readonly OverrideMigration[];
}

export interface CurrentView {
  readonly revisionId: string;
  readonly currentRunId: string | null;
  readonly episodes: readonly string[];
  readonly thoughts: readonly string[];
  readonly emotions: readonly string[];
  readonly topics: readonly string[];
  readonly entities: readonly string[];
  readonly candidates: readonly { readonly runId: string; readonly fingerprint: string }[];
}

const RUN_COLUMNS = `id, source_revision_id, pipeline_manifest, pipeline_fingerprint, idempotency_key,
       execution_status, result_state, error_kind, started_at_utc, finished_at_utc`;

// ── M3-PROJ-1 可读投影的行形状 ─────────────────────────────────────
// 与 `shared/dto.ts` 的 EffectiveResultDto 扩集逐字段对应（单轨）；这里只登记服务层读到的
// 库里那一行的形状，路由再做 camelCase 投影。

/** `episode` 表被 UI 用到的列。 */
interface EpisodeReadableRow {
  readonly id: string;
  readonly summary: string;
  readonly origin_type: string;
  readonly lifecycle_status: string;
  readonly evidence_text: string;
  readonly evidence_start: number | null;
  readonly evidence_end: number | null;
  readonly event_time_raw: string | null;
  readonly event_time_precision: string;
  readonly event_time_certainty: string;
}

interface ThoughtReadableRow {
  readonly id: string;
  readonly text: string;
  readonly origin_type: string;
  readonly lifecycle_status: string;
  readonly evidence_text: string;
  readonly evidence_start: number | null;
  readonly evidence_end: number | null;
}

/** 三类 Mention 的公共列 + 各自附加列（未附加的字段在这里就是 `undefined`）。 */
interface MentionReadableRow {
  readonly id: string;
  readonly target_id: string;
  readonly label_said: string;
  readonly basis: string;
  readonly status: string;
  readonly source_record_revision_id: string | null;
  readonly source_episode_id: string | null;
  readonly source_thought_id: string | null;
  readonly evidence_text: string;
  readonly evidence_start: number | null;
  readonly evidence_end: number | null;
  readonly intensity?: number | null;
  readonly intensity_source?: string | null;
  readonly role?: string | null;
}

interface ConceptReadableRow {
  readonly id: string;
  readonly canonical_name: string;
  readonly concept_type: string;
  readonly lifecycle_status: string;
}

interface EntityReadableRow {
  readonly id: string;
  readonly canonical_name: string;
  readonly display_name: string;
  readonly entity_type: string;
  readonly lifecycle_status: string;
}

interface SuggestionReadableRow {
  readonly id: string;
  readonly kind: string;
  readonly subject_term: string;
  readonly status: string;
  readonly display_note: string | null;
  readonly evidence: string | null;
}

/** 历次结果的一行：**不含** `pipeline_manifest`——那条查询里就没选。 */
interface RunReadableRow {
  readonly id: string;
  readonly result_state: string;
  readonly execution_status: string;
  readonly error_kind: string | null;
  readonly ai_title: string;
  readonly ai_summary: string;
  readonly started_at_utc: string;
  readonly finished_at_utc: string | null;
}

export interface ReadableEvidence {
  readonly text: string;
  readonly start: number | null;
  readonly end: number | null;
  readonly anchored: boolean;
}

export interface ReadableEpisode {
  readonly id: string;
  readonly summary: string;
  readonly eventTimeRaw: string | null;
  readonly eventTimePrecision: string;
  readonly eventTimeCertainty: string;
  readonly lifecycleStatus: string;
  readonly originType: string;
  readonly evidence: ReadableEvidence;
}

export interface ReadableThought {
  readonly id: string;
  readonly text: string;
  readonly lifecycleStatus: string;
  readonly originType: string;
  readonly evidence: ReadableEvidence;
}

export interface ReadableEmotion {
  readonly id: string;
  readonly conceptId: string;
  readonly labelSaid: string;
  readonly basis: string;
  readonly status: string;
  readonly source: { readonly kind: string; readonly containerId: string };
  readonly evidence: ReadableEvidence;
  readonly intensity: number | null;
  readonly intensityModifiedByUser: boolean;
}

export interface ReadableTopic {
  readonly id: string;
  readonly conceptId: string;
  readonly labelSaid: string;
  readonly basis: string;
  readonly status: string;
  readonly source: { readonly kind: string; readonly containerId: string };
  readonly evidence: ReadableEvidence;
}

export interface ReadableEntityMention {
  readonly id: string;
  readonly entityId: string;
  readonly labelSaid: string;
  readonly basis: string;
  readonly status: string;
  readonly source: { readonly kind: string; readonly containerId: string };
  readonly evidence: ReadableEvidence;
  readonly role: string | null;
}

export interface ReadableConceptTarget {
  readonly id: string;
  readonly canonicalName: string;
  readonly conceptType: string;
  readonly lifecycleStatus: string;
}

export interface ReadableEntityTarget {
  readonly id: string;
  readonly canonicalName: string;
  readonly displayName: string;
  readonly entityType: string;
  readonly lifecycleStatus: string;
}

export interface ReadableSuggestion {
  readonly id: string;
  readonly kind: string;
  readonly subjectTerm: string;
  readonly status: string;
  readonly displayNote: string | null;
  readonly evidence: string | null;
}

export interface ReadableRun {
  readonly runId: string;
  readonly resultState: string;
  readonly executionStatus: string;
  readonly errorKind: string | null;
  readonly aiTitle: string;
  readonly aiSummary: string;
  readonly startedAtUtc: string;
  readonly finishedAtUtc: string | null;
}

/** `currentView` 的全部字段 ⊕ 可读形状（可读层不另立可见性口径，见 `readableView`）。 */
export type ReadableView = CurrentView & {
  readonly episodeItems: readonly ReadableEpisode[];
  readonly thoughtItems: readonly ReadableThought[];
  readonly emotionItems: readonly ReadableEmotion[];
  readonly topicItems: readonly ReadableTopic[];
  readonly entityItems: readonly ReadableEntityMention[];
  readonly conceptTargets: readonly ReadableConceptTarget[];
  readonly entityTargets: readonly ReadableEntityTarget[];
  readonly suggestionItems: readonly ReadableSuggestion[];
  readonly runHistory: readonly ReadableRun[];
  readonly aiTitle: string;
  readonly aiSummary: string;
};

/** 证据的三列（各表同名），用来在任何一行上现算「是否回锚成功」。 */
function evidenceOf(
  row: { readonly evidence_text: string; readonly evidence_start: number | null; readonly evidence_end: number | null },
  rawText: string,
): ReadableEvidence {
  const start = row.evidence_start;
  const end = row.evidence_end;
  const text = row.evidence_text;
  const anchored = text !== "" && start !== null && end !== null && rawText.slice(start, end) === text;
  return { text, start, end, anchored };
}

/** 提及来源三选一（§3.14 exactly-one）→ 对外的 kind + 容器主键。 */
function mentionSourceOf(row: MentionReadableRow): { readonly kind: string; readonly containerId: string } {
  if (row.source_episode_id !== null) return { kind: "episode", containerId: row.source_episode_id };
  if (row.source_thought_id !== null) return { kind: "thought_item", containerId: row.source_thought_id };
  return { kind: "record_revision", containerId: row.source_record_revision_id ?? "" };
}

function unique(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

/** 批量 override 取数：没有该对象的修正就是空数组（与「查不到」同义，库里语义如此）。 */
function listed(grouped: Map<string, OverrideRow[]>, objectId: string): readonly OverrideRow[] {
  return grouped.get(objectId) ?? [];
}

export class IngestService {
  private readonly db: Database;
  private readonly adapter: ModelAdapter;
  private readonly transport: ProviderTransport;
  private readonly systemPrompt: string;
  private readonly promptVersion: string;
  private readonly outputSchemaVersion: string;
  private readonly validationVersion: string;
  private readonly now: () => Date;
  private readonly contracts: Contracts;
  private readonly trace: TraceSession | undefined;
  private readonly grantCheck: (() => void) | undefined;
  /** `local_llm` 档的状态读数；缺席即由 Provider 按「未配置」处理（fail-closed，不放行）。 */
  private readonly localLlm: LocalLlmStatus | undefined;
  private readonly resolver: ConceptResolver;
  private readonly corrections: CorrectionService;
  private readonly graph: GraphStore;

  constructor(options: IngestServiceOptions) {
    this.db = options.db;
    this.adapter = options.adapter;
    this.transport = options.transport;
    this.systemPrompt = options.systemPrompt;
    this.promptVersion = options.promptVersion ?? DEFAULT_PROMPT_VERSION;
    this.outputSchemaVersion = options.outputSchemaVersion ?? DEFAULT_OUTPUT_SCHEMA_VERSION;
    this.validationVersion = options.validationVersion ?? DEFAULT_VALIDATION_VERSION;
    this.now = options.now ?? (() => new Date());
    this.contracts = options.contracts ?? DEFAULT_CONTRACTS;
    this.trace = options.trace;
    this.grantCheck = options.grantCheck;
    this.localLlm = options.localLlm;
    this.resolver = new ConceptResolver(options.db);
    this.corrections = new CorrectionService(options.db, { now: this.now });
    this.graph = new GraphStore(options.db, { now: this.now });
  }

  // ── 读取面 ────────────────────────────────────────────────────────

  readRun(runId: string): ParseRunRow | null {
    const row = this.db.prepare(`select ${RUN_COLUMNS} from parse_run where id = ?`).get(runId) as
      | ParseRunRow
      | undefined;
    return row ?? null;
  }

  findRunByIdempotencyKey(key: string): ParseRunRow | null {
    const row = this.db.prepare(`select ${RUN_COLUMNS} from parse_run where idempotency_key = ?`).get(key) as
      | ParseRunRow
      | undefined;
    return row ?? null;
  }

  /**
   * 这一版本在同一条管线上已经开过几单（M8-D-4 的尝试序号来源）。
   * 只按 (revision, fingerprint) 数行，不看 execution_status 也不看 result_state：
   * 序号钉的是「这条管线为这个版本跑过几次」，失败与遗留的单据同样占一个号。
   */
  private countRunsForRevision(revisionId: string, fingerprint: string): number {
    const row = this.db
      .prepare("select count(*) as n from parse_run where source_revision_id = ? and pipeline_fingerprint = ?")
      .get(revisionId, fingerprint) as { n: number };
    return row.n;
  }

  /**
   * 这一版本名下有没有还在飞的解析（M8-D-8 的前置查询）：`queued` / `running` 都算在途。
   * 按 revision 查而不是按 (revision, 指纹) 查——一次只让一份工作在飞，换管线也不例外。
   * 按 rowid 取最早的一条，报出来的才是「挡路的那一单」。
   */
  private findInFlightRun(revisionId: string): { id: string; execution_status: string } | null {
    const row = this.db
      .prepare(
        `select id, execution_status from parse_run
           where source_revision_id = ? and execution_status in ('queued', 'running')
           order by rowid limit 1`,
      )
      .get(revisionId) as { id: string; execution_status: string } | undefined;
    return row ?? null;
  }

  /** run 的来源版本 → 所属记录 ID（读面；供 M2-6 重试路由定位记录，不在路由里裸查表）。 */
  recordIdOfRevision(revisionId: string): string | null {
    const row = this.db
      .prepare("select record_id from record_revision where id = ?")
      .get(revisionId) as { record_id: string } | undefined;
    return row?.record_id ?? null;
  }

  /**
   * §3.7 当前视图的唯一定义：`(无 run 且用户侧来源) 或 run 是 current`，再叠各行自身状态过滤。
   * 候选 run 的派生行由 join 隐藏——没有影子表，也不需要可见性列。
   * 两腿不可合并成 `coalesce(parse_run_id,'') = ?`：那样一来只要存在 current run，
   * 用户自建行（parse_run_id 为 NULL）就会被一起筛掉，§3.7 的左腿就没了。
   *
   * 〔M3-DB-2 ③ / 任务书 §四-5 裁定「补腿」〕三张 Mention 表在 `user_created` 之外再认
   * `user_confirmed_suggestion`：确认过的建议按 K-05 不挂 run（0003 的 CHECK 把它钉成
   * `parse_run_id IS NULL`），若不补第三条腿，它与 §2.1「用户确认过的东西就是用户的当前事实」直接矛盾。
   * 腿写成两条独立的 NULL 分支而非合并成 `origin_type in (...)`：旧两腿逐字留在原地，
   * 收紧与扩面都能在读这段时一眼看见（既有断言只需为第三腿加一条，不必重写前两腿）。
   * `episode` / `thought_item` 无第三条腿可扩——0003:126 / :216 的 origin_type CHECK 只有两值，
   * §3.8/§3.9 也没给它们第三个来源；那里剩下的两条腿就是这个视图的全部。
   */
  currentView(revisionId: string): CurrentView {
    const current = this.db
      .prepare(`select id from parse_run where source_revision_id = ? and result_state = 'current'`)
      .get(revisionId) as { id: string } | undefined;
    const currentRunId = current?.id ?? null;
    const visible = `(parse_run_id is null and origin_type = 'user_created') or parse_run_id = ?`;
    const rows = (table: string): string[] =>
      (this.db
        .prepare(
          `select id from ${table}
            where source_record_revision_id = ? and lifecycle_status = 'active'
              and (${visible})`,
        )
        .all(revisionId, currentRunId) as Array<{ id: string }>).map((row) => row.id);
    const visibleMention =
      `(m.parse_run_id is null and m.origin_type = 'user_created')
        or (m.parse_run_id is null and m.origin_type = 'user_confirmed_suggestion')
        or m.parse_run_id = ?`;
    const mentionIds = (collection: PatchCollection): string[] => {
      const shape = mentionShapeFor(collection);
      return (
        this.db
          .prepare(
            `select m.id as id from ${shape.table} as m
              where m.source_record_revision_id = ? and m.status = 'active'
                and (${visibleMention})`,
          )
          .all(revisionId, currentRunId) as Array<{ id: string }>
      ).map((row) => row.id);
    };
    const candidates = this.db
      .prepare(
        `select id, pipeline_fingerprint from parse_run
          where source_revision_id = ? and result_state = 'candidate' and execution_status = 'succeeded'`,
      )
      .all(revisionId) as Array<{ id: string; pipeline_fingerprint: string }>;
    return {
      revisionId,
      currentRunId,
      episodes: rows("episode"),
      thoughts: rows("thought_item"),
      emotions: mentionIds("emotions"),
      topics: mentionIds("topics"),
      entities: mentionIds("entities"),
      candidates: candidates.map((row) => ({ runId: row.id, fingerprint: row.pipeline_fingerprint })),
    };
  }

  /**
   * M3-PROJ-1：**同一口径的可读形状**。
   *
   * 可见性只有一个来源——先调 `currentView()` 拿到三腿表达式选出的 ID 集合，再按主键一次取齐
   * 每张表要显示的字段。路由层与本页都不重抄那段 `(parse_run_id is null and …) or parse_run_id = ?`，
   * 所以「列表里数得出、点进去看不到」与「两处口径不一致」这两种形态在这里结构性不可能发生。
   *
   * 三条纪律：
   * 1. **`pipeline_manifest` 物理跳过**：历次结果用显式列名查询，那张躺着 `redactionMap` 的原文
   *    根本不进 JS 对象，也就无从被序列化进响应。
   * 2. **修正层合流**：episode/thought_item/concept/entity 的可修正字段经 `applyOverrides`
   *    与 `user_scalar_override` ⊕ 一次（ADR-011），显示的是用户改过的值而不是基表原值；
   *    合流语义与 `projectEffective()` 共用同一实现。
   * 3. **回锚现算**：库里没有「是否回锚成功」这一列（本轮明令不开 0008），按坐标在所属版本
   *    `raw_text` 上逐字取回、与写入文本相等才算 `anchored`。
   */
  readableView(revisionId: string): ReadableView {
    const view = this.currentView(revisionId);
    const rawText =
      (this.db.prepare(`select raw_text from record_revision where id = ?`).get(revisionId) as
        | { raw_text: string }
        | undefined)?.raw_text ?? "";

    const episodeRows = this.rowsById<EpisodeReadableRow>(
      "episode",
      view.episodes,
      `id, summary, origin_type, lifecycle_status, evidence_text, evidence_start, evidence_end,
       event_time_raw, event_time_precision, event_time_certainty`,
    );
    const episodeOverrides = this.corrections.overridesByObject("episode", view.episodes);
    const episodeItems = episodeRows.map((row) => {
      const merged = applyOverrides(
        {
          summary: row.summary,
          event_time_raw: row.event_time_raw,
          event_time_precision: row.event_time_precision,
          event_time_certainty: row.event_time_certainty,
        },
        listed(episodeOverrides, row.id),
      );
      return {
        id: row.id,
        summary: merged.summary,
        eventTimeRaw: merged.event_time_raw,
        eventTimePrecision: merged.event_time_precision,
        eventTimeCertainty: merged.event_time_certainty,
        lifecycleStatus: row.lifecycle_status,
        originType: row.origin_type,
        evidence: evidenceOf(row, rawText),
      };
    });

    const thoughtRows = this.rowsById<ThoughtReadableRow>(
      "thought_item",
      view.thoughts,
      `id, text, origin_type, lifecycle_status, evidence_text, evidence_start, evidence_end`,
    );
    const thoughtOverrides = this.corrections.overridesByObject("thought_item", view.thoughts);
    const thoughtItems = thoughtRows.map((row) => ({
      id: row.id,
      text: applyOverrides({ text: row.text }, listed(thoughtOverrides, row.id)).text,
      lifecycleStatus: row.lifecycle_status,
      originType: row.origin_type,
      evidence: evidenceOf(row, rawText),
    }));

    const emotionRows = this.mentionsById("emotions", view.emotions, ", intensity, intensity_source");
    const topicRows = this.mentionsById("topics", view.topics, "");
    const entityRows = this.mentionsById("entities", view.entities, ", role");

    const conceptIds = unique([...emotionRows.map((r) => r.target_id), ...topicRows.map((r) => r.target_id)]);
    const conceptRows = this.rowsById<ConceptReadableRow>(
      "concept",
      conceptIds,
      `id, canonical_name, concept_type, lifecycle_status`,
    );
    const conceptOverrides = this.corrections.overridesByObject("concept", conceptIds);
    const conceptTargets = conceptRows.map((row) => ({
      id: row.id,
      canonicalName: applyOverrides({ canonical_name: row.canonical_name }, listed(conceptOverrides, row.id)).canonical_name,
      conceptType: row.concept_type,
      lifecycleStatus: row.lifecycle_status,
    }));

    const entityIds = unique(entityRows.map((r) => r.target_id));
    const entityTargetRows = this.rowsById<EntityReadableRow>(
      "entity",
      entityIds,
      `id, canonical_name, display_name, entity_type, lifecycle_status`,
    );
    const entityOverrides = this.corrections.overridesByObject("entity", entityIds);
    const entityTargets = entityTargetRows.map((row) => {
      const merged = applyOverrides(
        { canonical_name: row.canonical_name, display_name: row.display_name, entity_type: row.entity_type },
        listed(entityOverrides, row.id),
      );
      return {
        id: row.id,
        canonicalName: merged.canonical_name,
        displayName: merged.display_name,
        entityType: merged.entity_type,
        lifecycleStatus: row.lifecycle_status,
      };
    });

    const runRows = this.db
      .prepare(
        // 显式列名：`pipeline_manifest`（含 redactionMap）根本不进这份对象。
        `select id, result_state, execution_status, error_kind, ai_title, ai_summary,
                started_at_utc, finished_at_utc
           from parse_run where source_revision_id = ? order by started_at_utc, id`,
      )
      .all(revisionId) as unknown as RunReadableRow[];
    const current = runRows.find((row) => row.id === view.currentRunId);

    return {
      ...view,
      episodeItems,
      thoughtItems,
      emotionItems: emotionRows.map((row) => ({
        id: row.id,
        conceptId: row.target_id,
        labelSaid: row.label_said,
        basis: row.basis,
        status: row.status,
        source: mentionSourceOf(row),
        evidence: evidenceOf(row, rawText),
        intensity: row.intensity ?? null,
        intensityModifiedByUser: row.intensity_source === "user",
      })),
      topicItems: topicRows.map((row) => ({
        id: row.id,
        conceptId: row.target_id,
        labelSaid: row.label_said,
        basis: row.basis,
        status: row.status,
        source: mentionSourceOf(row),
        evidence: evidenceOf(row, rawText),
      })),
      entityItems: entityRows.map((row) => ({
        id: row.id,
        entityId: row.target_id,
        labelSaid: row.label_said,
        basis: row.basis,
        status: row.status,
        source: mentionSourceOf(row),
        evidence: evidenceOf(row, rawText),
        role: row.role ?? null,
      })),
      conceptTargets,
      entityTargets,
      suggestionItems: this.suggestionsForRevision(revisionId, runRows.map((row) => row.id), [...conceptIds, ...entityIds]),
      runHistory: runRows.map((row) => ({
        runId: row.id,
        resultState: row.result_state,
        executionStatus: row.execution_status,
        errorKind: row.error_kind,
        aiTitle: row.ai_title,
        aiSummary: row.ai_summary,
        startedAtUtc: row.started_at_utc,
        finishedAtUtc: row.finished_at_utc,
      })),
      aiTitle: current?.ai_title ?? "",
      aiSummary: current?.ai_summary ?? "",
    };
  }

  /** 按主键集合一次取齐一张表的展示列（`ids` 来自 `currentView`，这里不再判可见性）。 */
  private rowsById<R>(table: string, ids: readonly string[], columns: string): R[] {
    if (ids.length === 0) return [];
    return this.db
      .prepare(
        `select ${columns} from ${table}
          where id in (${ids.map(() => "?").join(", ")})
          order by created_at_utc, id`,
      )
      .all(...ids) as unknown as R[];
  }

  /** 三类 Mention 对称结构：形状表给出表名与目标列，附加列由调用方补（intensity / role）。 */
  private mentionsById(
    collection: PatchCollection,
    ids: readonly string[],
    extraColumns: string,
  ): MentionReadableRow[] {
    const shape = mentionShapeFor(collection);
    return this.rowsById<MentionReadableRow>(
      shape.table,
      ids,
      `id, ${shape.targetColumn} as target_id, label_said, basis, status,
       source_record_revision_id, source_episode_id, source_thought_id,
       evidence_text, evidence_start, evidence_end${extraColumns}`,
    );
  }

  /**
   * 与该版本相干、尚未定案的建议。
   *
   * 相干的三条腿：端点指向本 revision（`new_concept` / `evidence_repair`）、端点指向本视图的
   * 概念或实体（`alias` / `possibly_*`）、或由本 revision 的某次解析产出（带 `parse_run_id`）。
   * 不按 run 的 `result_state` 过滤——历史运行提出的建议仍留在建议表，这正是「待确认」页
   * 要按状态分组的理由（§3.7 的 current 例外）。
   */
  private suggestionsForRevision(
    revisionId: string,
    runIds: readonly string[],
    endpointIds: readonly string[],
  ): ReadableSuggestion[] {
    const endpoints = [revisionId, ...endpointIds];
    const legs: string[] = [];
    const params: string[] = [];
    if (endpoints.length > 0) {
      const marks = endpoints.map(() => "?").join(",");
      legs.push(`(endpoint_a in (${marks}) or endpoint_b in (${marks}))`);
      params.push(...endpoints, ...endpoints);
    }
    if (runIds.length > 0) {
      legs.push(`parse_run_id in (${runIds.map(() => "?").join(",")})`);
      params.push(...runIds);
    }
    if (legs.length === 0) return [];
    const rows = this.db
      .prepare(
        `select id, kind, subject_term, status, display_note, evidence
           from suggestion
          where ${legs.join(" or ")}
          order by created_at_utc, id`,
      )
      .all(...params) as unknown as SuggestionReadableRow[];
    return rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      subjectTerm: row.subject_term,
      status: row.status,
      displayNote: row.display_note,
      evidence: row.evidence,
    }));
  }

  // ── 闸门与身份 ────────────────────────────────────────────────────

  private revisionContext(revisionId: string): RevisionContext {
    const row = this.db
      .prepare(
        `select cr.id as record_id, cr.current_revision_id as current_revision_id,
                cr.processing_status as processing_status, cr.processing_mode as processing_mode,
                cr.analysis_provider as analysis_provider,
                cr.redaction_mode as redaction_mode,
                cr.send_content_mode as send_content_mode,
                rr.raw_text as raw_text
           from record_revision as rr
           join capture_record as cr on cr.id = rr.record_id
          where rr.id = ?`,
      )
      .get(revisionId) as
      | {
          record_id: string;
          current_revision_id: string;
          processing_status: string;
          processing_mode: string;
          analysis_provider: string;
          redaction_mode: string;
          send_content_mode: string;
          raw_text: string;
        }
      | undefined;
    if (row === undefined) throw new IngestInputError(`RecordRevision 不存在：${revisionId}`);
    if (row.current_revision_id !== revisionId) {
      throw new IngestInputError(`解析只针对记录的当前版本（§3.19 第 1 步）：${revisionId} 已不是 current_revision`);
    }
    if (!(this.contracts.enums.processing_modes as readonly string[]).includes(row.processing_mode)) {
      throw new IngestInputError(`记录在册的 processing_mode 不在封闭集内：${row.processing_mode}`);
    }
    // 三轴是判定源（草案 §二）：取值不在册即拒，不兜底成保守组合——兜底等于替用户改写隐私承诺。
    // 组合合法性（§三 矩阵）在这里就过一遍，装配层因此拿不到一个不合法的 axes。
    const axes = coerceAxes(row.analysis_provider, row.redaction_mode, row.send_content_mode);
    assertThreeAxes(axes);
    return {
      recordId: row.record_id,
      revisionId,
      rawText: row.raw_text,
      processingStatus: row.processing_status,
      processingMode: row.processing_mode as ProcessingMode,
      axes,
    };
  }

  /**
   * 模式是用户在记录上的既定设置，不是解析请求的参数（§4.8「用户改 mode 后」走记录侧、
   * K-17 三者独立）：显式传入只允许与在册值一致，否则等于由调用方替用户改变隐私承诺。
   */
  private resolveMode(ctx: RevisionContext, requested?: ProcessingMode): ProcessingMode {
    if (requested === undefined) return ctx.processingMode;
    if (requested !== ctx.processingMode) {
      throw new IngestInputError(
        `processing_mode 属于记录在册的用户设置（当前 ${ctx.processingMode}），不得由解析调用改成 ${requested}`,
      );
    }
    return requested;
  }

  /** `resolveMode` 的同一条纪律，落在真正的判定源上：显式传入的三轴只允许**核对**在册值。 */
  private resolveAxes(ctx: RevisionContext, requested?: ThreeAxes): ThreeAxes {
    if (requested === undefined) return ctx.axes;
    if (axesKey(requested) !== axesKey(ctx.axes)) {
      throw new IngestInputError(
        `三轴属于记录在册的用户设置（当前 ${axesKey(ctx.axes)}），不得由解析调用改成 ${axesKey(requested)}`,
      );
    }
    return requested;
  }

  /**
   * 发起调用前的门序：三轴组合与占位取值 → 外发必带映射与载荷 → 本次授权。
   * 「不该发」必须在物理上是零次调用、零行写入，所以这些门全部在建 run 行之前。
   *
   * 判据是 `send_content_mode`，不是 `processing_mode` 字面量（草案 §五 `egress_gate`）：
   * `raw` 与 `redacted` 都离开本机，都要载荷、都要授权；只有「映射必带」是 `redacted` 独有的，
   * 因为 `raw` 的定义就是不脱敏（矩阵 #9）。
   */
  private preCallGates(ctx: RevisionContext, request: ExtractionRequest, redactionMap: RedactionMap | undefined): void {
    assertSendable(request, this.adapter, this.localLlm);
    if (!isEgress(request.axes)) return;
    if (request.axes.sendContentMode === "redacted" && redactionMap === undefined) {
      throw new RedactionMapRequiredError(ctx.revisionId);
    }
    if (request.payloadText === "") {
      throw new IngestInputError(
        `send_content_mode=${request.axes.sendContentMode} 的待发送载荷不能是空串：${ctx.revisionId}`,
      );
    }
    if (this.grantCheck === undefined) {
      throw new IngestInputError(
        `send_content_mode=${request.axes.sendContentMode} 必须注入本次授权闸门（指令 §7.3）：${ctx.revisionId}`,
      );
    }
    this.grantCheck();
  }

  private buildRequest(ctx: RevisionContext, mode: ProcessingMode, axes: ThreeAxes, input: IngestInput): ExtractionRequest {
    const redactionMap = input.redactionMap;
    // 派生列与三轴必须同源（0008 的表级 CHECK 已在库里钉住，这里是内存侧的同一道对账）：
    // 不一致意味着有人绕过了写入路径，此时不能继续装配一个「谁都不知道发的是什么的」请求。
    if (deriveProcessingMode(axes) !== mode) {
      throw new IngestInputError(
        `processing_mode=${mode} 与三轴 ${axesKey(axes)} 的派生结果不一致：拒绝装配（草案 §五）`,
      );
    }
    if (isEgress(axes) && input.payloadText === undefined) {
      throw new IngestInputError(
        `send_content_mode=${axes.sendContentMode} 的载荷必须是用户确认过的那份文本（§5.1 第 3 步）：${ctx.revisionId}`,
      );
    }
    // `raw` 发送的**必须**是这条记录自己的原文：客户端传了别的文本就等于拿「已授权发原文」
    // 的授权去发一份没被确认过的内容，那正是授权绑定要防的事。
    if (axes.sendContentMode === "raw" && input.payloadText !== undefined && input.payloadText !== ctx.rawText) {
      throw new IngestInputError(`raw 的载荷只能是该版本自己的原文（§三 矩阵 #9）：${ctx.revisionId}`);
    }
    // 上面两道门已经把「外发必须有确认过的载荷」钉死了，这里剩下的只是取那一份文本；
    // 不外发（本地/仅保存）时省略载荷照旧回落原文——那是 M2 以来的既有行为。
    const payloadText = input.payloadText ?? ctx.rawText;
    return {
      recordRevisionId: ctx.revisionId,
      axes,
      processingMode: mode,
      payloadText,
      systemPrompt: this.systemPrompt,
      promptVersion: this.promptVersion,
      outputSchemaVersion: this.outputSchemaVersion,
      contractsFingerprint: this.contracts.fingerprint,
      resolverVersion: RESOLVER_VERSION,
      validationVersion: this.validationVersion,
      ...(redactionMap === undefined ? {} : { redactionMap: redactionMapJsonValue(redactionMap) }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    };
  }

  // ── 生命周期：beginRun ────────────────────────────────────────────

  /**
   * 建/复用 run 行并把记录推进到 `processing`，在一个已提交事务内完成。
   * 单独公开这一半，是为了让「进程在 run 开始与派生写入之间死掉」成为可真实复现的形态（T-04）：
   * 子进程只调到这里就异常退出，重放方必须能恢复同一行。
   */
  beginRun(input: IngestInput): RunHandle {
    const ctx = this.revisionContext(input.recordRevisionId);
    const mode = this.resolveMode(ctx, input.processingMode);
    const axes = this.resolveAxes(ctx, input.axes);
    const request = this.buildRequest(ctx, mode, axes, input);
    this.preCallGates(ctx, request, input.redactionMap);

    const manifest = buildRunManifest({
      promptVersion: this.promptVersion,
      outputSchemaVersion: this.outputSchemaVersion,
      provider: this.adapter.provider,
      model: this.adapter.model,
      params: this.adapter.params ?? null,
      contractsFingerprint: this.contracts.fingerprint,
      resolverVersion: RESOLVER_VERSION,
      validationVersion: this.validationVersion,
      // 九项封闭且库里每键 `json_type(...) IS NOT NULL`：本地路径没有映射也要写 JSON null。
      redactionMap: input.redactionMap === undefined ? null : redactionMapJsonValue(input.redactionMap),
    });
    const fingerprint = pipelineFingerprint(manifest);
    // M8-D-8：显式重新分析先看在途。单进程内 beginRun 全同步——这次查询与下面的插入落在同一个 tick，
    // 中间不 await，因此不需要（也不该有）UNIQUE 冲突捕获那一层兜底。
    if (input.reanalysis === true) {
      const inFlight = this.findInFlightRun(ctx.revisionId);
      if (inFlight !== null) throw new ReanalysisInFlightError(inFlight.id, inFlight.execution_status);
    }
    // M8-D-4：尝试序号 = 1 + 这一版本同一条管线上已有的 run 行数，且**只有**显式重新分析才启用。
    // 缺席时序号恒为 1 ⇒ 键与既有形状逐字相同（既有幂等/重放面不受本次改动影响）。
    let attempt = input.reanalysis === true ? 1 + this.countRunsForRevision(ctx.revisionId, fingerprint) : 1;
    let idempotencyKey = deriveIdempotencyKey(ctx.revisionId, fingerprint, attempt);
    // Phase B（PD-1）：superseded 是终态，重放它只会得到一份永远不可见的「成功」。
    // 撤销/放弃之后用户再点整理，应沿同一管线顺延开新一单，而不是把旧行原样喂回来。
    if (input.reanalysis !== true) {
      while (this.findRunByIdempotencyKey(idempotencyKey)?.result_state === "superseded") {
        attempt += 1;
        idempotencyKey = deriveIdempotencyKey(ctx.revisionId, fingerprint, attempt);
      }
    }
    const ts = this.now().toISOString();

    return inTransaction(this.db, () => {
      const existing = this.findRunByIdempotencyKey(idempotencyKey);
      if (existing !== null && existing.execution_status === "succeeded") {
        // 同一逻辑任务已成功提交过一次：重放不再发起调用、不再写任何派生行（指令 §8.2）。
        return {
          runId: existing.id,
          idempotencyKey,
          pipelineFingerprint: fingerprint,
          manifest,
          processingMode: mode,
          request,
          context: ctx,
          replayed: true,
          recovered: false,
        };
      }

      let runId: string;
      let recovered = false;
      if (existing !== null) {
        runId = existing.id;
        if (existing.execution_status === "running") {
          // 上一进程遗留：running→failed(cancelled)→queued→running，逐边过状态机。
          recovered = true;
          this.moveRun(existing.id, "running", "failed", { errorKind: "cancelled", finishedAtUtc: ts });
          this.moveRun(existing.id, "failed", "queued", { errorKind: null, finishedAtUtc: null });
        } else if (existing.execution_status === "failed") {
          // B3：失败重试复用同一行、同一幂等键。
          this.moveRun(existing.id, "failed", "queued", { errorKind: null, finishedAtUtc: null });
        } else if (existing.execution_status !== "queued") {
          throw new IngestStateError(`parse_run ${existing.id} 的 execution_status=${existing.execution_status} 无法续跑`);
        }
        this.moveRun(existing.id, "queued", "running", { startedAtUtc: ts });
        if (this.readRun(runId)?.result_state !== "candidate") {
          throw new IngestStateError("§4.7 组合不变式被破坏：queued/running 的 run 只能挂 candidate 结果态");
        }
      } else {
        runId = newId("parseRun");
        this.db
          .prepare(
            `insert into parse_run
               (id, source_revision_id, pipeline_manifest, pipeline_fingerprint, idempotency_key,
                execution_status, result_state, started_at_utc)
             values (?, ?, ?, ?, ?, 'running', 'candidate', ?)`,
          )
          .run(runId, ctx.revisionId, JSON.stringify(manifest), fingerprint, idempotencyKey, ts);
      }

      this.enterProcessing(ctx.recordId);
      return {
        runId,
        idempotencyKey,
        pipelineFingerprint: fingerprint,
        manifest,
        processingMode: mode,
        request,
        context: ctx,
        replayed: false,
        recovered,
      };
    });
  }

  /**
   * 记录处理态推进到 `processing`（§4.8 逐边）。两条入口边需要先绕一圈：
   * - `processing`：崩溃遗留，processing→failed→preprocessing→processing；
   * - `parsed`：主动重跑，parsed→needs_reparse→preprocessing→processing（`parsed` 只有这一条出边）。
   */
  private enterProcessing(recordId: string): void {
    const step = (from: string, to: string): void => {
      assertStateTransition("processing_status", from, to, this.contracts.enums);
      this.db.prepare(`update capture_record set processing_status = ? where id = ?`).run(to, recordId);
    };
    const status = this.recordStatus(recordId);
    if (status === "processing") {
      step("processing", "failed");
      step("failed", "preprocessing");
    } else if (status === "parsed") {
      step("parsed", "needs_reparse");
      step("needs_reparse", "preprocessing");
    } else if (status !== "preprocessing") {
      step(status, "preprocessing");
    }
    step("preprocessing", "processing");
  }

  private recordStatus(recordId: string): string {
    const row = this.db.prepare(`select processing_status from capture_record where id = ?`).get(recordId) as
      | { processing_status: string }
      | undefined;
    if (row === undefined) throw new IngestInputError(`CaptureRecord 不存在：${recordId}`);
    return row.processing_status;
  }

  /** 双态之执行态：先过状态机，再落库，然后回读确认——并发漂移不得被静默接受。 */
  private moveRun(
    runId: string,
    from: string,
    to: string,
    stamp: {
      readonly errorKind?: string | null;
      readonly finishedAtUtc?: string | null;
      readonly startedAtUtc?: string;
    },
  ): void {
    assertStateTransition("ParseRun.execution_status", from, to, this.contracts.enums);
    const keepError = stamp.errorKind === undefined ? 1 : 0;
    const keepFinished = stamp.finishedAtUtc === undefined ? 1 : 0;
    const result = this.db
      .prepare(
        `update parse_run
            set execution_status = ?,
                error_kind = case when ? = 1 then error_kind else ? end,
                finished_at_utc = case when ? = 1 then finished_at_utc else ? end,
                started_at_utc = coalesce(?, started_at_utc)
          where id = ? and execution_status = ?`,
      )
      .run(to, keepError, stamp.errorKind ?? null, keepFinished, stamp.finishedAtUtc ?? null, stamp.startedAtUtc ?? null, runId, from);
    if (Number(result.changes ?? 0) !== 1 || this.readRun(runId)?.execution_status !== to) {
      throw new IngestStateError(`parse_run ${runId} 未从 ${from} 迁入 ${to}`);
    }
  }

  private moveResultState(runId: string, from: string, to: string): void {
    assertStateTransition("ParseRun.result_state", from, to, this.contracts.enums);
    this.db.prepare(`update parse_run set result_state = ? where id = ? and result_state = ?`).run(to, runId, from);
    const row = this.readRun(runId);
    if (row === null || row.result_state !== to) {
      throw new IngestStateError(`parse_run ${runId} 的 result_state 未从 ${from} 迁入 ${to}`);
    }
  }

  // ── 一次完整解析 ──────────────────────────────────────────────────

  async ingest(input: IngestInput): Promise<IngestResult> {
    const run = this.beginRun(input);
    if (run.replayed) {
      return this.buildResult(run, {
        succeeded: true,
        replayed: true,
        callPath: this.adapter.callPath,
        attemptedPaths: [],
        degraded: false,
        writes: emptyWrites(),
        collisions: [],
        title: "",
        summary: "",
        errorKind: null,
      });
    }

    this.trace?.captureDebugRaw("preprocess", {
      recordRevisionId: run.context.revisionId,
      rawText: run.context.rawText,
      parseRunId: run.runId,
    });

    let outcome: ExtractionOutcome;
    try {
      outcome = await invokeExtraction(
        this.adapter,
        run.request,
        this.transport,
        {
          ...(this.grantCheck === undefined ? {} : { requireGrant: this.grantCheck }),
          ...(this.localLlm === undefined ? {} : { localLlm: this.localLlm }),
        },
      );
    } catch (cause) {
      const failure = this.classify(cause);
      this.failRun(run, failure);
      return this.resultFromFailure(run, failure);
    }

    let parsed: StructuredOutput;
    try {
      parsed = parseStructuredOutput(outcome.json);
    } catch (cause) {
      const failure = this.classify(cause);
      this.failRun(run, failure);
      return this.resultFromOutcome(run, outcome, {
        succeeded: false,
        writes: emptyWrites(),
        collisions: [],
        title: "",
        summary: "",
        errorKind: failure.errorKind,
        failure: this.ingestFailure(failure),
        businessPassed: false,
        derivedWriteCommitted: false,
        structuredParseSucceeded: false,
      });
    }

    // D-7：先把回稿里的占位符换回真名，再进校验与写库；evidence 不在此列（证据锚定仍在脱敏坐标）。
    const redactionMap =
      run.request.redactionMap === undefined ? undefined : parseRedactionMap(run.request.redactionMap);
    const output: StructuredOutput =
      redactionMap === undefined ? parsed : restoreOutputPlaceholders(parsed, redactionMap, run.context.rawText);
    // D-2/D-3：本机脱敏识别出的语义实体，稍后在写库事务里登记。
    const local = redactionMap === undefined ? { claims: [], occurrences: [] } : localEntityClaims(redactionMap, run.context.rawText);

    const context = {
      sentText: run.request.payloadText,
      rawText: run.context.rawText,
      ...(redactionMap === undefined ? {} : { redactionMap }),
      knownConcepts: this.resolver.knownConcepts(),
      knownEntityIds: this.resolver.knownEntityIds(),
    };

    let plan: WritePlan;
    let repairs: readonly EvidenceFailure[] = [];
    let whollyFailed = false;
    try {
      plan = toWritePlan(validateBusiness(output, context));
    } catch (cause) {
      const failure = this.classify(cause);
      if (failure.errorKind !== "evidence_unmapped") {
        // 非证据类业务失败：整批不采信，零派生写入（指令 §8.2）。
        this.failRun(run, failure);
        return this.resultFromOutcome(run, outcome, {
          succeeded: false,
          writes: emptyWrites(),
          collisions: [],
          title: output.title,
          summary: output.summary,
          errorKind: failure.errorKind,
          failure: this.ingestFailure(failure),
          businessPassed: false,
          derivedWriteCommitted: false,
        });
      }
      // 只有证据类规则坏：逐条分流，通过的照写，不通过的落 evidence_repair（§7.6.4）。
      const split = planEvidence(output, context);
      plan = planToWritePlan(split);
      repairs = split.failures;
      whollyFailed = split.whollyFailed;
    }

    // D-2/D-3：本机识别、云端没出标签的实体，用 span 自身的真实出现补一条 explicit 提及。
    if (local.occurrences.length > 0) {
      plan = { ...plan, labels: [...plan.labels, ...syntheticEntityLabels(local.occurrences, output.entities)] };
    }

    // 关系门（§3.4）与致命门共用判据，但**去向不同**：坏一条只丢那一条，run 照旧成功。
    // 所以它不进 `issues.throwIfAny()`，只把通过的那部分交给写入面（§3.5）。
    const relationGate = validateRelations(output, context);

    const committed = this.commitDerived(run, plan, {
      whollyFailed,
      repairs,
      aiTitle: output.title,
      aiSummary: output.summary,
      relations: relationGate.relations,
      relationsDiscarded: relationGate.discarded.length,
      autoAdopt: input.autoAdoptFirstResult === true,
      entityClaims: local.claims,
    });
    return this.resultFromOutcome(run, outcome, {
      succeeded: committed.errorKind === null,
      writes: committed.writes,
      collisions: committed.collisions,
      title: output.title,
      summary: output.summary,
      errorKind: committed.errorKind,
      autoAdopted: committed.autoAdopted,
      ...(committed.errorKind === null
        ? {}
        : {
            failure: {
              errorKind: committed.errorKind,
              retryable: false,
              message: "全部条目的证据都无法回锚到原文坐标（§7.6.4）",
              issues: committed.issues,
            } satisfies IngestFailure,
          }),
      businessPassed: !whollyFailed,
      // 走到这里派生事务已经提交：全批失败提交的是 run 终态 + 记录态 + 修复建议。
      // 记 false 会让 Trace 声称「库里什么都没动」，而那与同一事务里写下的 suggestion 行直接矛盾。
      derivedWriteCommitted: true,
      issues: committed.issues,
    });
  }

  /**
   * 派生写入的唯一事务。全批证据失败时 run 落 `failed(evidence_unmapped)` 而修复建议照写：
   * §7.6.4 的「该条候选落 Suggestion」不以 run 成功为前提，T-27 要的就是这两件同时成立。
   */
  private commitDerived(
    run: RunHandle,
    plan: WritePlan,
    input: {
      readonly whollyFailed: boolean;
      readonly repairs: readonly EvidenceFailure[];
      /** Provider 产出的标题/摘要，来自 `StructuredOutput`；成功路径唯一落库处（§四-4）。 */
      readonly aiTitle: string;
      readonly aiSummary: string;
      /** 过关系门的那几条（§3.4）；端点解析与落库在 §3.5，只走成功路径。 */
      readonly relations: readonly ValidatedRelation[];
      /** 关系门作废的条数（§3.4）：门在事务之前就跑完了，与这一笔事务成没成无关，故无条件记账。 */
      readonly relationsDiscarded: number;
      /** Phase B：首次整理自动生效（PD-1）。产品侧传 true；服务层缺省 false。 */
      readonly autoAdopt: boolean;
      /** 本机脱敏识别出、要登记成实体的语义词面（D-2/D-3）。 */
      readonly entityClaims: readonly EntityClaim[];
    },
  ): {
    readonly writes: IngestWriteCounts;
    readonly collisions: readonly SuggestionCollision[];
    readonly errorKind: ParseErrorKind | null;
    readonly issues: readonly string[];
    readonly autoAdopted: boolean;
  } {
    return inTransaction(this.db, () => {
      const writes: MutableIngestWriteCounts = emptyWrites();
      const collisions: SuggestionCollision[] = [];
      let autoAdopted = false;
      const ts = this.now().toISOString();
      const revisionId = run.context.revisionId;
      // 关系门的丢弃条数不是这一笔事务的产物：门在事务之前就跑完了，整批证据失败那次同样记。
      writes.relationDroppedByContract = input.relationsDiscarded;

      // D-1/D-2/D-3：先登记本机识别出的实体（事务内，失败随本批一起回滚）。
      // 已存在则复用，绝不在复用路径上改词面/类型。
      for (const claim of input.entityClaims) {
        resolveOrCreateEntity(this.db, {
          name: claim.name,
          type: claim.type,
          originType: "ai_generated",
          lifecycleStatus: "active",
          privacyLevel: "normal",
          now: ts,
        });
      }

      writes.episodes = this.writeEpisodes(run.runId, revisionId, plan.episodes, ts);
      writes.thoughts = this.writeThoughts(run.runId, revisionId, plan.thoughts, ts);
      const labels = this.writeLabels(run.runId, revisionId, plan.labels, ts, collisions);
      writes.mentions = labels.mentions;
      writes.rejectedMentions = labels.rejected;
      writes.suggestions = labels.suggestions;
      writes.deduplicated = labels.deduplicated;
      writes.unrouted = labels.unrouted;
      writes.unresolvedEntities = labels.unresolvedEntities;

      for (const failure of input.repairs) {
        const slot = this.reserveSuggestionSlot(EVIDENCE_REPAIR_KIND, revisionId, failure.subjectTerm, collisions);
        if (slot === "collision") continue;
        writeEvidenceRepairSuggestion(this.db, {
          parseRunId: run.runId,
          sourceRevisionId: revisionId,
          failure,
          now: ts,
        });
        writes.evidenceRepairs += 1;
      }

      const issues = input.repairs.map(
        (failure) => `${failure.rule}：${failure.collection}[${failure.index}] — ${failure.detail}`,
      );
      const errorKind: ParseErrorKind | null = input.whollyFailed ? "evidence_unmapped" : null;

      if (errorKind === null) {
        // 关系边写在 run 转 succeeded **之前**：一条边的端点不合写入面（§3.5）就该整事务回滚，
        // 于是库里留下的是「running 的 run + 零关系边」这种可恢复形态，而不是 succeeded + 半套边。
        // 全批证据失败（errorKind 非 null）时不写：那次 run 连 Mention 都没落成，边更无从谈起。
        const recordEntityLabels = new Set<string>(
          plan.labels.filter((label) => label.collection === "entities").map((label) => label.labelSaid.normalize("NFC")),
        );
        const relationWrites = this.writeRelations(run.runId, revisionId, input.relations, ts, recordEntityLabels);
        writes.relations = relationWrites.relations;
        writes.relationAmbiguous = relationWrites.ambiguous;
        writes.relationUnmatched = relationWrites.unmatched;
        writes.relationProvisional = relationWrites.provisional;

        // §3.7 / M2 验收报告 §四-4：AI 标题/摘要的唯一落库处（0007 的两列）。
        // 候选 run 也写——「那次解析说了什么」与 result_state 无关，采纳前的候选同样要能事后取回。
        // 失败与回放路径都不走到这里，库里维持 0007 的 DEFAULT ''：空串 = 「这次没落过」，不拿猜测值冒充。
        this.db
          .prepare(`update parse_run set ai_title = ?, ai_summary = ? where id = ?`)
          .run(input.aiTitle, input.aiSummary, run.runId);
        this.moveRun(run.runId, "running", "succeeded", { errorKind: null, finishedAtUtc: ts });
        const status = this.recordStatus(run.context.recordId);
        assertStateTransition("processing_status", status, "parsed", this.contracts.enums);
        this.db.prepare(`update capture_record set processing_status = 'parsed' where id = ?`).run(run.context.recordId);
        // Phase B（PD-1）：该 revision 还没有任何 current 结果 ⇒ 首次整理自动生效，盒子那几页立刻看得见。
        // 已有 current（重跑 / 重新分析）仍落 candidate，由用户比较后自己采纳。
        const hasCurrent = this.db
          .prepare(`select 1 as hit from parse_run where source_revision_id = ? and result_state = 'current' limit 1`)
          .get(revisionId);
        if (input.autoAdopt && hasCurrent === undefined) {
          this.moveResultState(run.runId, "candidate", "current");
          autoAdopted = true;
        }
      } else {
        this.moveRun(run.runId, "running", "failed", { errorKind, finishedAtUtc: ts });
        const status = this.recordStatus(run.context.recordId);
        assertStateTransition("processing_status", status, "failed", this.contracts.enums);
        this.db.prepare(`update capture_record set processing_status = 'failed' where id = ?`).run(run.context.recordId);
      }

      return { writes, collisions, errorKind, issues, autoAdopted };
    });
  }

  private writeEpisodes(runId: string, revisionId: string, episodes: readonly CandidateEpisodeWrite[], ts: string): number {
    for (const episode of episodes) {
      this.db
        .prepare(
          `insert into episode
             (id, source_record_revision_id, parse_run_id, origin_type, lifecycle_status, summary,
              evidence_text, evidence_start, evidence_end,
              event_time_raw, event_time_precision, event_time_certainty,
              event_time_start, event_time_end, created_at_utc)
           values (?, ?, ?, 'ai_generated', 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          newId("episode"),
          revisionId,
          runId,
          episode.summary,
          episode.evidenceText,
          episode.evidenceStart,
          episode.evidenceEnd,
          episode.eventTime.raw,
          episode.eventTime.precision,
          episode.eventTime.certainty,
          episode.eventTime.start,
          episode.eventTime.end,
          ts,
        );
    }
    return episodes.length;
  }

  private writeThoughts(runId: string, revisionId: string, thoughts: readonly CandidateThoughtWrite[], ts: string): number {
    for (const thought of thoughts) {
      this.db
        .prepare(
          `insert into thought_item
             (id, text, source_record_revision_id, source_episode_id, parse_run_id,
              origin_type, lifecycle_status, evidence_text, evidence_start, evidence_end, created_at_utc)
           values (?, ?, ?, NULL, ?, 'ai_generated', 'active', ?, ?, ?, ?)`,
        )
        .run(
          newId("thoughtItem"),
          thought.text,
          revisionId,
          runId,
          thought.evidenceText,
          thought.evidenceStart,
          thought.evidenceEnd,
          ts,
        );
    }
    return thoughts.length;
  }

  /**
   * 标签 → 解析器 → Mention / Suggestion。
   * Mention 一律来源于 revision（§3.2.4：既不自动建 Episode，也不自动挂到该记录已有的 Episode）。
   */
  private writeLabels(
    runId: string,
    revisionId: string,
    labels: readonly CandidateLabelWrite[],
    ts: string,
    collisions: SuggestionCollision[],
  ): {
    readonly mentions: number;
    readonly rejected: number;
    readonly suggestions: number;
    readonly deduplicated: number;
    readonly unrouted: number;
    readonly unresolvedEntities: number;
  } {
    let mentions = 0;
    let rejected = 0;
    let suggestions = 0;
    let deduplicated = 0;
    let unrouted = 0;
    let unresolvedEntities = 0;
    const seen = new Set<string>();

    for (const label of labels) {
      const shape = mentionShapeFor(label.collection);
      let targetId: string | null = null;
      let pending: { readonly kind: string; readonly endpointA: string } | null = null;

      if (label.route !== "mention") {
        if (label.route === "suggestion" && label.suggestionKind !== null) {
          pending = { kind: label.suggestionKind, endpointA: revisionId };
        } else {
          unrouted += 1;
        }
      } else if (label.collection === "entities") {
        const resolution = this.resolver.resolveEntity(label.labelSaid);
        if (resolution.kind === "resolved") targetId = resolution.entityId;
        else unresolvedEntities += 1;
      } else {
        const domain = label.collection === "emotions" ? "emotion" : "topic";
        const resolution = this.resolver.resolveConcept(domain, label.labelSaid, label.candidateConceptId);
        if (resolution.kind === "resolved") {
          targetId = resolution.match.conceptId;
        } else if (resolution.suggestionKind === "alias" && resolution.targetConceptId !== null) {
          // §3.17：别名建议必带既存 concept 端点，否则无法确认。
          pending = { kind: "alias", endpointA: resolution.targetConceptId };
        } else {
          pending = { kind: "new_concept", endpointA: revisionId };
        }
      }

      if (targetId === null) {
        if (pending !== null) {
          const slot = this.reserveSuggestionSlot(pending.kind, pending.endpointA, label.labelSaid, collisions);
          if (slot !== "collision") {
            this.insertSuggestion({
              kind: pending.kind,
              endpointA: pending.endpointA,
              subjectTerm: label.labelSaid,
              parseRunId: runId,
              now: ts,
            });
            suggestions += 1;
          }
        }
        continue;
      }

      // run 内身份 = 0003 部分唯一索引的键；同键的第二条是被重复提出，不是第二条事实。
      const identity = `${shape.table}|${targetId}|${label.labelSaid.normalize("NFC")}|${label.evidenceStart}`;
      if (seen.has(identity)) {
        deduplicated += 1;
        continue;
      }
      seen.add(identity);

      const blocked =
        this.corrections.isResurrectionBlocked({
          collection: label.collection,
          containerId: revisionId,
          memberId: targetId,
          labelSaid: label.labelSaid,
          patchContainer: null,
        }) || this.corrections.hasRemovePatchInRevisionScope(revisionId, label.collection, targetId);

      this.db
        .prepare(
          `insert into ${shape.table}
             (id, ${shape.targetColumn}, source_record_revision_id, source_episode_id, source_thought_id,
              label_said, evidence_text, evidence_start, evidence_end,
              origin_type, basis, status, parse_run_id, created_at_utc)
           values (?, ?, ?, NULL, NULL, ?, ?, ?, ?, 'ai_generated', ?, ?, ?, ?)`,
        )
        .run(
          newId(shape.idKind),
          targetId,
          revisionId,
          label.labelSaid,
          label.evidenceText,
          label.evidenceStart,
          label.evidenceEnd,
          label.basis,
          blocked ? "rejected" : "active",
          runId,
          ts,
        );
      mentions += 1;
      if (blocked) rejected += 1;
    }

    return { mentions, rejected, suggestions, deduplicated, unrouted, unresolvedEntities };
  }

  /**
   * 关系 → 端点解析 → `graph_edge`（准则 §3.5，M7-2b 的写入面）。
   *
   * 三条口径与判据顺序：
   *  1. **词面必须属于本条记录**（`recordEntityLabels` = 本次 output 抽出的 entities 词面集）：
   *     不在集内按 `unmatched` 计——它压根不是「这条记录里的人和物」。
   *  2. `resolveEntity` 的 `ambiguous` / `unmatched` 各归各的计数（§3.13 的同一取向：多于一个候选
   *     是用户的事，本层绝不猜）。两端解析到**同一个实体**也归 `ambiguous`：那不构成两个实体间的关系。
   *  3. 端点实体 `lifecycle_status` 非 `active` ⇒ 归 `provisional` 计数，**实体不转正**（R3）。
   *
   * 方向归一与 `(relation_type, src_id, dst_id)` 命中既有行**都归 `GraphStore`**（R5/R6），
   * 这里不再做一次。store 抛 `GraphEdgeEndpointError` 时按它的 `reason` 记账（`missing` ⇒
   * unmatched、`not_active` ⇒ provisional）而不是吞掉：这一层唯一的取信来源是它。
   * `GraphEdgeInputError`（类型不在册、端点为空等）照抛——那是上游契约被违反，不是某一条关系坏。
   */
  private writeRelations(
    runId: string,
    revisionId: string,
    relations: readonly ValidatedRelation[],
    ts: string,
    recordEntityLabels: ReadonlySet<string>,
  ): {
    readonly relations: number;
    readonly ambiguous: number;
    readonly unmatched: number;
    readonly provisional: number;
  } {
    let written = 0;
    let ambiguous = 0;
    let unmatched = 0;
    let provisional = 0;

    for (const relation of relations) {
      const srcTerm = relation.srcLabel.normalize("NFC");
      const dstTerm = relation.dstLabel.normalize("NFC");
      if (!recordEntityLabels.has(srcTerm) || !recordEntityLabels.has(dstTerm)) {
        unmatched += 1;
        continue;
      }
      const src = this.resolver.resolveEntity(srcTerm);
      const dst = this.resolver.resolveEntity(dstTerm);
      if (src.kind === "ambiguous" || dst.kind === "ambiguous") {
        ambiguous += 1;
        continue;
      }
      if (src.kind !== "resolved" || dst.kind !== "resolved") {
        unmatched += 1;
        continue;
      }
      if (src.entityId === dst.entityId) {
        ambiguous += 1;
        continue;
      }
      if (!this.isActiveEntity(src.entityId) || !this.isActiveEntity(dst.entityId)) {
        provisional += 1;
        continue;
      }
      try {
        const inserted = this.graph.insertEdgeIfAbsent({
          relationType: relation.relationType,
          srcEntityId: src.entityId,
          dstEntityId: dst.entityId,
          createdBy: "ai_generated",
          originParseRunId: runId,
          evidenceReason: relationEvidenceReason(runId, revisionId, relation),
          now: new Date(ts),
        });
        // `created === false` 是同三元组已有行（R5：一个字都不改），不是本 run 新写的边。
        if (inserted.created) written += 1;
      } catch (cause) {
        if (cause instanceof GraphEdgeEndpointError) {
          if (cause.reason === "missing") unmatched += 1;
          else provisional += 1;
          continue;
        }
        throw cause;
      }
    }

    return { relations: written, ambiguous, unmatched, provisional };
  }

  /**
   * 端点实体的 active 判定（R3 的写入侧一半）。`resolveEntity` 的候选集含 `provisional`
   * （§3.1：Mention 可以挂在 Provisional Entity 上），所以「解析得到」不等于「可以进图」；
   * store 也会守一次，但那一守发生在**它的**取值门之后，本层的计数得在这里分得开。
   */
  private isActiveEntity(entityId: string): boolean {
    const row = this.db
      .prepare(`select lifecycle_status as s from entity where id = ?`)
      .get(entityId) as { s: string } | undefined;
    return row?.s === "active";
  }

  private insertSuggestion(input: {
    readonly kind: string;
    readonly endpointA: string;
    readonly subjectTerm: string;
    readonly parseRunId: string;
    readonly now: string;
  }): void {
    this.db
      .prepare(
        `insert into suggestion
           (id, kind, relation_type, endpoint_a, endpoint_b, subject_term, status, reason_code,
            evidence, display_note, parse_run_id, result_id, created_at_utc, updated_at_utc)
         values (?, ?, '', ?, '', ?, 'pending', '', NULL, NULL, ?, NULL, ?, ?)`,
      )
      .run(
        newId("suggestion"),
        input.kind,
        input.endpointA,
        input.subjectTerm,
        input.parseRunId,
        input.now,
        input.now,
      );
  }

  /**
   * 0003 的建议去重是**两层**：表级 `UNIQUE(kind, relation_type, endpoint_a, endpoint_b)`
   * 比 §3.17 增补的 `ux_sug_term(kind, endpoint_a, subject_term)` 更粗——同一 (kind, 端点)
   * 只能有一行。这里按粗键预检：同词面刷新时间；不同词面**不覆盖既存行**（它可能带着用户的
   * `ignored` 状态，§4.6「忽略后不重复提出」优先于「再提一次」），未提出的词面记进 `collisions`。
   * 冻结迁移造成的这条粒度损失登记为存疑项，本层既不放宽也不假装它不存在。
   */
  private reserveSuggestionSlot(
    kind: string,
    endpointA: string,
    subjectTerm: string,
    collisions: SuggestionCollision[],
  ): "empty" | "same-term" | "collision" {
    const existing = this.db
      .prepare(
        `select subject_term from suggestion
          where kind = ? and relation_type = '' and endpoint_a = ? and endpoint_b = ''`,
      )
      .get(kind, endpointA) as { subject_term: string } | undefined;
    if (existing === undefined) return "empty";
    if (existing.subject_term === subjectTerm) {
      this.db
        .prepare(
          `update suggestion set updated_at_utc = ?
            where kind = ? and relation_type = '' and endpoint_a = ?`,
        )
        .run(this.now().toISOString(), kind, endpointA);
      return "same-term";
    }
    collisions.push({ kind, endpointA, heldTerm: existing.subject_term, droppedTerm: subjectTerm });
    return "collision";
  }

  // ── 失败收口 ──────────────────────────────────────────────────────

  /**
   * 把两道门与传输层的错误收敛成封闭的 `error_kind` 与可重试标记。
   * 降级留痕在此统一为数组（裁决 2），与 `ExtractionOutcome.attemptedPaths` 逐值相等。
   */
  private classify(cause: unknown): {
    readonly errorKind: ParseErrorKind | null;
    readonly retryable: boolean;
    readonly message: string;
    readonly issues: readonly string[];
    readonly attemptedPaths: readonly ProviderCallPath[];
    readonly degraded: boolean;
  } {
    if (cause instanceof ProviderError) {
      return {
        errorKind: cause.kind,
        retryable: cause.retryable,
        message: cause.message,
        issues: [`${cause.kind}：${cause.message}`],
        attemptedPaths: attemptedPathsFromDiagnostics(cause.diagnostics["attempted_paths"]),
        degraded: cause.diagnostics["degraded"] === true,
      };
    }
    if (cause instanceof BusinessValidationError) {
      return {
        errorKind: cause.kind,
        retryable: cause.retryable,
        message: cause.message,
        issues: cause.issues,
        attemptedPaths: [],
        degraded: false,
      };
    }
    if (cause instanceof ContractSchemaError) {
      return {
        errorKind: cause.kind,
        retryable: cause.retryable,
        message: cause.message,
        issues: cause.issues,
        attemptedPaths: [],
        degraded: false,
      };
    }
    return {
      errorKind: null,
      retryable: false,
      message: cause instanceof Error ? cause.message : String(cause),
      issues: [],
      attemptedPaths: [],
      degraded: false,
    };
  }

  private ingestFailure(classified: {
    readonly errorKind: ParseErrorKind | null;
    readonly retryable: boolean;
    readonly message: string;
    readonly issues: readonly string[];
  }): IngestFailure {
    return {
      errorKind: classified.errorKind,
      retryable: classified.retryable,
      message: classified.message,
      issues: classified.issues,
    };
  }

  /** run→failed（封闭 error_kind）与记录态→failed 同事务；原文与既有派生行都不动（高风险不变量 3）。 */
  private failRun(run: RunHandle, failure: { readonly errorKind: ParseErrorKind | null; readonly issues: readonly string[] }): void {
    inTransaction(this.db, () => {
      const ts = this.now().toISOString();
      this.moveRun(run.runId, "running", "failed", { errorKind: failure.errorKind, finishedAtUtc: ts });
      const status = this.recordStatus(run.context.recordId);
      assertStateTransition("processing_status", status, "failed", this.contracts.enums);
      this.db.prepare(`update capture_record set processing_status = 'failed' where id = ?`).run(run.context.recordId);
    });
  }

  // ── 采纳与放弃（§3.19）───────────────────────────────────────────

  /**
   * 采纳候选：旧 current→superseded 与新 candidate→current 同事务，顺序不可反
   * （`ux_run_current` 是即时校验的部分唯一索引，反过来的那一瞬就是双 current）。
   * 旧 run 的派生行批量转 superseded，**但带用户修正的行不被动**（§3.19 第 2 步）；
   * override 只在调用方给出逐条确认的映射后才迁移指向。
   */
  adoptCurrent(input: AdoptInput): { readonly supersededRunId: string | null; readonly adoptedRunId: string } {
    const candidate = this.readRun(input.candidateRunId);
    if (candidate === null) throw new RunNotFoundError(input.candidateRunId);
    if (candidate.execution_status !== "succeeded") {
      throw new RunNotAdoptableError(`只有执行成功的 run 才可能被采纳：当前 ${candidate.execution_status}`);
    }
    if (candidate.result_state !== "candidate") {
      throw new RunNotAdoptableError(`只有 candidate 结果态可被采纳：当前 ${candidate.result_state}`);
    }
    const prior = this.db
      .prepare(`select ${RUN_COLUMNS} from parse_run where source_revision_id = ? and result_state = 'current'`)
      .get(candidate.source_revision_id) as ParseRunRow | undefined;

    return inTransaction(this.db, () => {
      if (prior !== undefined) this.moveResultState(prior.id, "current", "superseded");
      this.moveResultState(candidate.id, "candidate", "current");
      if (prior !== undefined) this.supersedeDerivedRows(prior.id);
      // 迁移必须排在 candidate→current 之后：0004/0005 的 BEFORE UPDATE 触发器要求目标行的 run 是 current。
      for (const migration of input.overrideMigrations ?? []) {
        this.corrections.migrateOverride(migration);
      }
      return { supersededRunId: prior?.id ?? null, adoptedRunId: candidate.id };
    });
  }

  /** 旧 run 的行转 superseded；被用户碰过的行留在原态，由用户自己处置（§3.19 第 2 步）。 */
  private supersedeDerivedRows(runId: string): void {
    const episodes = this.db
      .prepare(`select id from episode where parse_run_id = ? and lifecycle_status = 'active'`)
      .all(runId) as Array<{ id: string }>;
    for (const row of episodes) {
      if (this.corrections.isUserTouched("episode", row.id)) continue;
      assertStateTransition("Episode.lifecycle_status", "active", "superseded", this.contracts.enums);
      this.db.prepare(`update episode set lifecycle_status = 'superseded' where id = ?`).run(row.id);
    }
    const thoughts = this.db
      .prepare(`select id from thought_item where parse_run_id = ? and lifecycle_status = 'active'`)
      .all(runId) as Array<{ id: string }>;
    for (const row of thoughts) {
      if (this.corrections.isUserTouched("thought_item", row.id)) continue;
      assertStateTransition("ThoughtItem.lifecycle_status", "active", "superseded", this.contracts.enums);
      this.db.prepare(`update thought_item set lifecycle_status = 'superseded' where id = ?`).run(row.id);
    }
    for (const collection of ["emotions", "topics", "entities"] as const) {
      const shape = mentionShapeFor(collection);
      // rejected 是终态且不参与当前视图，留原状即「用户移除过」的凭据（§4.4）。
      const rows = this.db
        .prepare(`select id from ${shape.table} where parse_run_id = ? and status = 'active'`)
        .all(runId) as Array<{ id: string }>;
      for (const row of rows) {
        assertStateTransition("Mention.status", "active", "superseded", this.contracts.enums);
        this.db.prepare(`update ${shape.table} set status = 'superseded' where id = ?`).run(row.id);
      }
    }
  }

  /** 用户放弃候选（§4.7b：candidate→superseded，历史保留）。 */
  discardCandidate(runId: string): void {
    const run = this.readRun(runId);
    if (run === null) throw new RunNotFoundError(runId);
    if (run.result_state !== "candidate") {
      throw new RunNotAdoptableError(`只有 candidate 可以被放弃：当前 ${run.result_state}`);
    }
    inTransaction(this.db, () => {
      this.moveResultState(runId, "candidate", "superseded");
    });
  }

  /**
   * Phase B（PD-1）：撤销一次已生效的结果。
   *
   * 只接受 `succeeded + current`；把 current→superseded 并把这一 run 的派生行一起转 superseded。
   * 撤销后该 revision 没有 current 结果，盒子那几页看不见它；再想看就重新发起整理（会落一份新结果）。
   * 历史行不删（与采纳/放弃同一口径）。
   */
  undoCurrent(runId: string): void {
    const run = this.readRun(runId);
    if (run === null) throw new RunNotFoundError(runId);
    if (run.execution_status !== "succeeded") {
      throw new RunNotAdoptableError(`只有执行成功的 run 才能撤销：当前 ${run.execution_status}`);
    }
    if (run.result_state !== "current") {
      throw new RunNotAdoptableError(`只有 current 结果可以撤销：当前 ${run.result_state}`);
    }
    inTransaction(this.db, () => {
      this.moveResultState(runId, "current", "superseded");
      this.supersedeDerivedRows(runId);
    });
  }

  // ── Trace 与结果组装 ──────────────────────────────────────────────

  private recordTrace(
    run: RunHandle,
    input: {
      readonly callPath: ProviderCallPath;
      readonly attemptedPaths: readonly ProviderCallPath[];
      readonly degraded: boolean;
      readonly errorKind: ParseErrorKind | null;
      readonly businessPassed: boolean;
      readonly derivedWriteCommitted: boolean;
      /** 省略表示本次没有发生解析（幂等重放）。 */
      readonly structuredParseSucceeded?: boolean;
      readonly retryable?: boolean;
      readonly writes?: IngestWriteCounts;
      readonly issueCount?: number;
    },
  ): void {
    if (this.trace === undefined) return;
    const writes = input.writes ?? emptyWrites();
    this.trace.record({
      recordId: run.context.recordId,
      recordRevisionId: run.context.revisionId,
      parseRunId: run.runId,
      idempotencyKey: run.idempotencyKey,
      pipelineFingerprint: run.pipelineFingerprint,
      analysisProvider: run.request.axes.analysisProvider,
      redactionMode: run.request.axes.redactionMode,
      sendContentMode: run.request.axes.sendContentMode,
      processingMode: run.processingMode,
      provider: this.adapter.provider,
      model: this.adapter.model,
      callPath: input.callPath,
      attemptedPaths: input.attemptedPaths,
      degraded: input.degraded,
      ...(input.structuredParseSucceeded === undefined
        ? {}
        : { structuredParseSucceeded: input.structuredParseSucceeded }),
      businessValidation: { passed: input.businessPassed, rules: [...BUSINESS_RULES] },
      derivedWriteCommitted: input.derivedWriteCommitted,
      ...(input.errorKind === null ? {} : { errorKind: input.errorKind }),
      ...(input.retryable === undefined ? {} : { retryable: input.retryable }),
      diagnostics: {
        episodes: writes.episodes,
        thoughts: writes.thoughts,
        mentions: writes.mentions,
        rejected_mentions: writes.rejectedMentions,
        suggestions: writes.suggestions,
        evidence_repairs: writes.evidenceRepairs,
        unrouted: writes.unrouted,
        unresolved_entities: writes.unresolvedEntities,
        ...(input.issueCount === undefined ? {} : { issue_count: input.issueCount }),
      },
    });
  }

  /**
   * 失败结果的唯一出口之一：**没有 outcome 可依据**（传输失败、状态门拒绝）。
   * 留痕仍然要落——§11.1 要求「每次尝试」可定位，被拒的那次尤其需要证据它确实没发出请求。
   */
  private resultFromFailure(
    run: RunHandle,
    failure: {
      readonly errorKind: ParseErrorKind | null;
      readonly retryable: boolean;
      readonly message: string;
      readonly issues: readonly string[];
      readonly attemptedPaths: readonly ProviderCallPath[];
      readonly degraded: boolean;
    },
  ): IngestResult {
    this.recordTrace(run, {
      callPath: this.adapter.callPath,
      attemptedPaths: failure.attemptedPaths,
      degraded: failure.degraded,
      errorKind: failure.errorKind,
      businessPassed: false,
      derivedWriteCommitted: false,
      retryable: failure.retryable,
      issueCount: failure.issues.length,
    });
    return this.buildResult(run, {
      succeeded: false,
      callPath: this.adapter.callPath,
      attemptedPaths: failure.attemptedPaths,
      degraded: failure.degraded,
      writes: emptyWrites(),
      collisions: [],
      title: "",
      summary: "",
      errorKind: failure.errorKind,
      failure: this.ingestFailure(failure),
    });
  }

  private resultFromOutcome(
    run: RunHandle,
    outcome: ExtractionOutcome,
    input: {
      readonly succeeded: boolean;
      readonly writes: IngestWriteCounts;
      readonly collisions: readonly SuggestionCollision[];
      readonly title: string;
      readonly summary: string;
      readonly errorKind: ParseErrorKind | null;
      readonly businessPassed: boolean;
      readonly derivedWriteCommitted: boolean;
      /** Phase B：首次整理自动生效（PD-1）。 */
      readonly autoAdopted?: boolean;
      /** 形状门（Zod）是否放行——降级只解决「拿不回信封」，不保证结构成立。 */
      readonly structuredParseSucceeded?: boolean;
      readonly failure?: IngestFailure;
      readonly issues?: readonly string[];
    },
  ): IngestResult {
    this.recordTrace(run, {
      callPath: outcome.callPath,
      attemptedPaths: outcome.attemptedPaths,
      degraded: outcome.degraded,
      errorKind: input.errorKind,
      businessPassed: input.businessPassed,
      derivedWriteCommitted: input.derivedWriteCommitted,
      structuredParseSucceeded: input.structuredParseSucceeded ?? true,
      ...(input.failure === undefined ? {} : { retryable: input.failure.retryable }),
      writes: input.writes,
      issueCount: input.issues?.length ?? 0,
    });
    return this.buildResult(run, {
      succeeded: input.succeeded,
      autoAdopted: input.autoAdopted ?? false,
      callPath: outcome.callPath,
      attemptedPaths: outcome.attemptedPaths,
      degraded: outcome.degraded,
      writes: input.writes,
      collisions: input.collisions,
      title: input.title,
      summary: input.summary,
      errorKind: input.errorKind,
      ...(input.failure === undefined ? {} : { failure: input.failure }),
    });
  }

  private buildResult(
    run: RunHandle,
    input: {
      readonly succeeded: boolean;
      readonly replayed?: boolean;
      readonly autoAdopted?: boolean;
      readonly callPath: ProviderCallPath;
      readonly attemptedPaths: readonly ProviderCallPath[];
      readonly degraded: boolean;
      readonly writes: IngestWriteCounts;
      readonly collisions: readonly SuggestionCollision[];
      readonly title: string;
      readonly summary: string;
      readonly errorKind: ParseErrorKind | null;
      readonly failure?: IngestFailure;
    },
  ): IngestResult {
    if (input.replayed === true) {
      // 幂等重放也要留痕：同一条逻辑任务被提出了两次，这件事本身是可审计事实。
      // structuredParseSucceeded 缺席——重放没有发生任何解析，既不声称成功也不声称失败。
      this.recordTrace(run, {
        callPath: input.callPath,
        attemptedPaths: [],
        degraded: false,
        errorKind: null,
        businessPassed: true,
        derivedWriteCommitted: false,
      });
    }
    // 重放没有经过 commitDerived；它的「是否已生效」要现读那一行的 result_state，
    // 否则界面会把一份 current 结果说成「候选」。
    const autoAdopted =
      input.autoAdopted ??
      (input.replayed === true
        ? (this.db.prepare(`select result_state as s from parse_run where id = ?`).get(run.runId) as
            | { s: string }
            | undefined)?.s === "current"
        : false);
    return {
      runId: run.runId,
      idempotencyKey: run.idempotencyKey,
      pipelineFingerprint: run.pipelineFingerprint,
      axes: run.request.axes,
      processingMode: run.processingMode,
      succeeded: input.succeeded,
      replayed: input.replayed ?? false,
      recovered: run.recovered,
      autoAdopted,
      provider: this.adapter.provider,
      model: this.adapter.model,
      callPath: input.callPath,
      attemptedPaths: input.attemptedPaths,
      degraded: input.degraded,
      writes: input.writes,
      collisions: input.collisions,
      title: input.title,
      summary: input.summary,
      errorKind: input.errorKind,
      ...(input.failure === undefined ? {} : { failure: input.failure }),
    };
  }
}
