import { newId } from "../../shared/contracts/ids.ts";
import type { ThreeAxes } from "../../shared/contracts/enums.ts";
import type { Database } from "../db/adapter.ts";
import { JobLease } from "./jobLease.ts";

/**
 * 后台任务队列的**存储层**（M6-0E 第一批）。
 *
 * 契约正文：`docs/dev-specs/2026-10-23-M6-0E-后台任务队列设计草案.md`
 * §一 三条现状约束、§二 表结构、§三 状态机、§四 恢复、§五 失败分类、§八 断言。
 * 迁移：`src/server/db/migrations/0010_privacy_job.sql`。
 *
 * 本批的边界（写在文件头是因为它决定了下面每个方法为什么长这样）：
 *  - **没有 worker 循环、没有 HTTP 路由、没有任何自动触发**。`claimNextRunnable()` 与
 *    `reclaimExpiredLeases()` 只提供「取一件可做的活」与「收僵尸租约」这两个动作本身，
 *    谁来按节拍调用它们属于第二批。
 *  - **不接线到记录级写入路径**：`recordProcessingStatusForJobStatus()` 是纯函数 + 全量覆盖测试，
 *    草案 §一-3 要求的映射表先立起来，落点留给 worker。
 *  - **不碰 op2/op4/op5 的同步幂等入口**（执行准则的 M6-0E 禁区）：这张表与 `runParse` 共存，
 *    本文件里没有任何一条语句读写 `capture_record` / `record_revision` / `parse_run`。
 *    唯一的读取是 `enqueue` 从 `record_revision` 现取 `record_id`（见那里）。
 *
 * 与 `parse_run.execution_status` 的分工（草案 §一-3，不造第三套执行态）：
 * `privacy_job.status` 只承载 run 没有的**调度语义**（排队顺序、取消请求、租约、退避）；
 * 一次模型执行走到哪，权威仍然是 `parse_run.execution_status`。两者靠 `record_revision_id` 关联。
 *
 * `status` / `error_kind` 的取值域**不在 `enums.json`**：那是记录级领域生命周期与执行态的契约面，
 * 调度语义塞进去只会让「谁是权威」更糊（迁移头注同一口径）。取值域是这里的模块局部 `as const`
 * 加迁移里的 CHECK，二者由 `tests/m6-0e-job-store.test.ts` 的静态对账钉成同源——照 0D 的
 * `GRANT_SEND_CONTENT_MODES` 做法，不手抄第二份。
 */

/** 草案 §三 的六值调度状态；顺序与迁移 0010 的 CHECK 清单逐项同序（静态对账钉住）。 */
export const JOB_STATUSES = ["queued", "redacting", "analyzing", "done", "failed", "canceled"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/** 草案 §五 的失败分类；NULL 表示「还没有失败过」，与迁移的 `error_kind IS NULL OR IN (...)` 同源。 */
export const JOB_ERROR_KINDS = [
  "provider_unavailable",
  "provider_loading",
  "timeout",
  "invalid_output",
  "internal",
] as const;
export type JobErrorKind = (typeof JOB_ERROR_KINDS)[number];

/**
 * 「不会再需要 worker 执行」的一档：`requestCancel` 的幂等分支、恢复扫描的排除面用它。
 *
 * 它与**状态机终态不是同一回事**：终态（无出边）只有 `done` / `canceled`，`failed` 还能被用户
 * 重试成 `queued`（草案 §三 末行）。这条区别不由注释自证，由
 * `tests/m6-0e-job-store.test.ts` 从 `JOB_TRANSITIONS` 反推「无出边的状态集合」钉住。
 */
export const JOB_TERMINAL_STATUSES = ["done", "failed", "canceled"] as const;
export type JobTerminalStatus = (typeof JOB_TERMINAL_STATUSES)[number];

const TERMINAL_SET: ReadonlySet<JobStatus> = new Set<JobStatus>(JOB_TERMINAL_STATUSES);
const STARTED_TARGETS: ReadonlySet<JobStatus> = new Set<JobStatus>(["redacting", "analyzing"]);
const FINISHED_TARGETS: ReadonlySet<JobStatus> = new Set<JobStatus>(JOB_TERMINAL_STATUSES);

/**
 * 带判据认领时一次扫描的排队行上限（`claimNextRunnable(runnable)`）：本地单用户量级下够用，
 * 且窗口外的行不会被丢弃——判据为假的行只是这一拍不被看到，下一拍重问。
 */
const CLAIM_SCAN_LIMIT = 200;

export function isJobStatus(value: unknown): value is JobStatus {
  return typeof value === "string" && (JOB_STATUSES as readonly string[]).includes(value);
}

export function isJobErrorKind(value: unknown): value is JobErrorKind {
  return typeof value === "string" && (JOB_ERROR_KINDS as readonly string[]).includes(value);
}

export function isJobTerminalStatus(status: JobStatus): boolean {
  return TERMINAL_SET.has(status);
}

/**
 * 这次失败**是否消耗一次 attempts**（草案 §五）：
 * `provider_unavailable` / `provider_loading` 是「环境还没准备好」（本地 `external_http` 未就绪、
 * 云端不可达、模型还在装载），不是任务的错，判 failed 会把配额抖动变成用户可见的失败；
 * 所以这两类不计数，任务回 `queued` 等恢复（§四 末段、断言 5）。其余三类消耗。
 */
export function consumesAttempt(kind: JobErrorKind): boolean {
  return kind !== "provider_unavailable" && kind !== "provider_loading";
}

/** 指数退避基数：与草案 §五「最多 2 次」的量级相称，第一次重试两秒后就试。 */
export const JOB_RETRY_BACKOFF_BASE_MS = 2_000;
/**
 * 退避上限 2 分钟（草案没给数，这里定数并注明；建议口径 ≤ 5 分钟）。
 * 取 2 分钟而不是 5 分钟：单次云端调用本身在 `requestTimeoutMs` 量级，退避再长就与
 * 「保存后自动处理」的期望延迟矛盾；上限只为防御将来把最大次数调高，实际两次退避落在 2s / 4s。
 */
export const JOB_RETRY_BACKOFF_CAP_MS = 120_000;

/**
 * 第 `attempts` 次尝试之后该等多久（小步指数退避：`BASE * 2^attempts`，封顶 `CAP`）。
 * `attempts` 取「已尝试次数」，所以还没跑过的新任务传 0 ⇒ 基数 2s；失败一次后传 1 ⇒ 4s。
 * 纯函数、无状态：worker 那一批拿它算等待时长。
 */
export function jobRetryBackoffMs(attempts: number): number {
  const step = Math.max(0, Math.floor(attempts));
  return Math.min(JOB_RETRY_BACKOFF_BASE_MS * 2 ** step, JOB_RETRY_BACKOFF_CAP_MS);
}

/**
 * 合法转换表（草案 §三 的转换表逐条 + §四 的两条恢复边）。
 *
 * §三 的表列了七行，展开成六个「从」态：
 *   queued → redacting（调度器取到任务）/ → canceled（用户取消或被新 revision 取代）
 *   redacting → analyzing（脱敏计划生成完成）/ → failed / → canceled（中止信号生效）
 *   analyzing → done（结果写入成功）/ → failed / → canceled
 *   failed → queued（用户手动重试，attempts+1）
 *   done / canceled：无出边（§三 末段）
 *
 * **两条额外的边**：`redacting → queued`、`analyzing → queued`。§三 的表没有它们，
 * 但 §四 明确要求「租约过期 ⇒ 视为崩溃，回退到 queued」。恢复回退也是一次状态推进，
 * 没有理由绕过服务层校验另开一条写入路径——那样「状态只能沿合法边推进」就不再是单一守门人。
 * 因此这两条边进表，并在 `reclaimExpiredLeases` 上注明出处；§八 断言 2 钉的是它们的行为。
 *
 * 其余一律拒绝：`queued → done`（没跑过不能算完成）、`queued → analyzing`（脱敏是第一段）、
 * `done → *`、`canceled → *`、`analyzing → redacting`（倒着走）。
 */
export const JOB_TRANSITIONS: Readonly<Record<JobStatus, readonly JobStatus[]>> = Object.freeze({
  queued: Object.freeze(["redacting", "canceled"] as const),
  // queued ← 的这一条来自 §四（租约过期回收），不是 §三 的表。
  redacting: Object.freeze(["analyzing", "failed", "canceled", "queued"] as const),
  analyzing: Object.freeze(["done", "failed", "canceled", "queued"] as const),
  done: Object.freeze([] as const),
  failed: Object.freeze(["queued"] as const),
  canceled: Object.freeze([] as const),
});

export function isJobTransitionAllowed(from: JobStatus, to: JobStatus): boolean {
  return JOB_TRANSITIONS[from].includes(to);
}

/**
 * 记录级映射（草案 §一-3 末段：队列负责推进 `capture_record.processing_status`，否则记录卡在在途态）。
 *
 * 这里是**一张表 + 一个查表函数**，不是散落在写入路径里的 if。第一批不接线：函数与全量覆盖测试
 * 先立起来，worker 那一批才有落点（禁区：不把队列语义混进同步入口）。
 *
 * 逐条对位 §一-3 的 `preprocessing → processing → parsed/failed`：
 *   queued     → preprocessing  已排到队但还没开跑，仍在「处理之前」那一段。
 *   redacting  → processing      脱敏在跑。
 *   analyzing  → processing      模型在跑；§一-2 明说记录状态描述「这条记录现在处于什么阶段」，
 *                                脱敏与解析同属「处理中」这一阶段，不再细分。
 *   done       → parsed          结果已写入。
 *   failed     → failed          执行失败就是记录级失败。
 *   canceled   → preprocessing   取消**不是**处理失败：用户取消（或新 revision 取代旧任务）之后，
 *                                这条记录仍然等着被处理，回到排队前的那一档最贴近事实，
 *                                也不会污染 `failed` 的统计含义。
 *                                另一个可选口径是回 `captured`（当作什么都没发生过），
 *                                那需要断言「该记录从来没有跑过」——队列做不到，重跑与重试是常态。
 *                                取 preprocessing 而非 captured 的理由就在这一句；**此条待裁**
 *                                （见交付记录的存疑项），代码不自行改判。
 *
 * 返回值域是 `enums.json` 的 `processing_statuses`（8 值）的**子集**；测试动态读 enums 核对成员，
 * 本文件不复制那份清单。
 */
export const JOB_TO_RECORD_PROCESSING_STATUS = {
  queued: "preprocessing",
  redacting: "processing",
  analyzing: "processing",
  done: "parsed",
  failed: "failed",
  canceled: "preprocessing",
} as const satisfies Record<JobStatus, string>;

/** 映射可能落到的四个记录级状态（`processing_statuses` 的子集，判据在测试里动态核对）。 */
export type JobMappedProcessingStatus = (typeof JOB_TO_RECORD_PROCESSING_STATUS)[JobStatus];

export function recordProcessingStatusForJobStatus(status: JobStatus): JobMappedProcessingStatus {
  return JOB_TO_RECORD_PROCESSING_STATUS[status];
}

/** `privacy_job` 的行形状：列名与迁移 0010 逐字一致（snake_case），不做驼峰改写。 */
export interface JobRow {
  readonly id: string;
  readonly record_id: string;
  readonly record_revision_id: string;
  readonly idempotency_key: string;
  readonly status: JobStatus;
  readonly attempts: number;
  readonly error_kind: JobErrorKind | null;
  readonly cancel_requested: 0 | 1;
  readonly snapshot_json: string;
  readonly created_at_utc: string;
  readonly updated_at_utc: string;
  readonly started_at_utc: string | null;
  readonly finished_at_utc: string | null;
}

const JOB_COLUMNS =
  "id, record_id, record_revision_id, idempotency_key, status, attempts, error_kind, " +
  "cancel_requested, snapshot_json, created_at_utc, updated_at_utc, started_at_utc, finished_at_utc";

/**
 * 配置快照的**封闭字段集**（草案 §二 要点：三轴 + 模型标识 + 提示词/契约版本）。
 *
 * 这份清单就是「快照里没有原文、没有脱敏映射」的物理形态：类型是
 * `Record<JobSnapshotField, string>`，七个键名全部在这里，多一个键编译不过。
 * 断言 9 的另一半在测试里：动态读这份清单核对成员，并核对序列化结果不含文本类字段名。
 */
export const JOB_SNAPSHOT_FIELDS = [
  "analysis_provider",
  "redaction_mode",
  "send_content_mode",
  "prompt_version",
  "schema_version",
  "model_id",
  "redaction_policy_version",
] as const;
export type JobSnapshotField = (typeof JOB_SNAPSHOT_FIELDS)[number];
export type JobSnapshot = Readonly<Record<JobSnapshotField, string>>;

/** 幂等键的第 2–5 段（草案 §二 的四个版本标识，不是内容）；第 6–8 段是 `axes` 的三轴，见 `idempotencyKeyFor`。 */
export interface JobVersions {
  readonly promptVersion: string;
  readonly schemaVersion: string;
  readonly modelId: string;
  readonly redactionPolicyVersion: string;
}

/**
 * 入队入参：只有 revision 指针、三轴与版本标识。
 * **没有任何一个字段能承载文本**（断言 9 的入参面）：原文与脱敏映射继续留在既有表里，
 * 队列要读内容时按 `record_revision_id` 现取，绝不在任务行上带一份副本。
 */
export interface EnqueueInput {
  readonly recordRevisionId: string;
  readonly axes: ThreeAxes;
  readonly versions: JobVersions;
}

/** `transition` 的可选补丁：attempts 的增减与 error_kind 的写/清。 */
export interface JobTransitionPatch {
  /**
   * `attempts` 的**增量**（不是绝对值）。全模块只有这一处能改 attempts——
   * `claimNextRunnable()` 取任务时**不**加，因为「取到任务」还不是一次失败的尝试；
   * §三 的重试与 §四 的租约回收各自显式传 `+1`，语义不会在两个方法里各写一遍。
   */
  readonly attemptsDelta?: number;
  /** `undefined` = 该列不动；`null` = 显式清空（写回「还没失败过」）；有值 = 记这次失败的分类。 */
  readonly errorKind?: JobErrorKind | null;
}

export interface JobStoreOptions {
  readonly now?: () => Date;
  /**
   * 租约归属（M6-1D 裁决 ①-b）：缺席即按同一个 db 自建一份，身份是本进程。
   * 单进程部署下这与接线前逐字等价（`heldByOther()` 恒假）；显式注入只为测试能扮演两个进程。
   */
  readonly leases?: JobLease;
}

export class JobNotFoundError extends Error {
  constructor(id: string) {
    super(`后台任务不存在：${id}`);
    this.name = "JobNotFoundError";
  }
}

export class JobRevisionNotFoundError extends Error {
  constructor(recordRevisionId: string) {
    super(`记录版本不存在，任务无处挂接：${recordRevisionId}`);
    this.name = "JobRevisionNotFoundError";
  }
}

/**
 * 非法状态推进：消息带任务 id 与 from/to，便于日志定位（不含任何文本内容，指令 §11.2）。
 * 这是「状态只能沿 §三 的边推进」在服务层的唯一拒绝点——迁移的 CHECK 只保证取值合法，
 * 保证不了取值之间的**顺序**合法（`done → analyzing` 在 CHECK 之下照样能写进去）。
 */
export class JobTransitionError extends Error {
  readonly jobId: string;
  readonly from: JobStatus;
  readonly to: JobStatus;

  constructor(jobId: string, from: JobStatus, to: JobStatus) {
    super(`后台任务 ${jobId} 的状态推进不被允许：${from} → ${to}`);
    this.name = "JobTransitionError";
    this.jobId = jobId;
    this.from = from;
    this.to = to;
  }
}

/** 入队入参不符合幂等键的构成要求（空段会让不同配置撞进同一行，破坏断言 1 的反面）。 */
export class JobInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JobInputError";
  }
}

/**
 * 幂等键：
 * `<record_revision_id>:<prompt_version>:<schema_version>:<model_id>:<redaction_policy_version>:<analysis_provider>:<redaction_mode>:<send_content_mode>`
 *
 * 前五段照草案 §二 逐字；末尾三段是**三轴**，依据是 §二 要点那句「同一 revision、同一套配置
 * 只允许一个任务；**配置变了就是另一个任务**（旧任务标 `canceled`）」——三轴不进键，
 * 「配置变了」在同一个 revision 上就永远拼出同一个键、落进同一行，那句裁定无从成立。
 * 三轴不同 ⇒ 另一行，旧行由 `enqueue` 的 supersede 收口成 `canceled`（草案 §三 的 supersede
 * 只管旧 **revision**，同 revision 的配置漂移在这里补齐，判据与理由见 `enqueue`）。
 *
 * `send_content_mode` 尤其必须在键内：它决定这一次外发出去的是**原文**还是**脱敏文本**。
 * 让一个「脱敏」任务的行被「发原文」的入队复用，等于拿一份**未经确认的发送意向**顶替另一份——
 * 正是 0D 在授权层已经堵掉的那类混淆（`cloud_raw` 必须有显式授权才能发原文），不能到了队列层
 * 又靠一次入队悄悄绕开。
 *
 * 分隔符照草案用冒号，而 `model_id` 可能自带冒号（ollama 风格 `qwen2.5:7b`）——这在原则上让键
 * 可歧义。落到实处的判据是：八段里可能带冒号的只有 `model_id` 与 `redaction_policy_version`，
 * 而后者是本仓库的常量（`rules-v1` / `raw-v1`，无冒号），要构造碰撞得让 model_id 与 policy 各带
 * 一个冒号且拼出同一串，实际不存在。故不改键形（契约优先）；若将来 policy 版本引入冒号，
 * 这条注释就是要改的地方。末尾三段是**封闭集枚举值**（`contracts/enums.ts` 的三轴取值清单，
 * `local|cloud|none` / `local_llm|manual|none` / `redacted|raw|none`），本身不含冒号，
 * 追加它们不新增歧义面。
 */
export function idempotencyKeyFor(recordRevisionId: string, versions: JobVersions, axes: ThreeAxes): string {
  return [
    recordRevisionId,
    versions.promptVersion,
    versions.schemaVersion,
    versions.modelId,
    versions.redactionPolicyVersion,
    axes.analysisProvider,
    axes.redactionMode,
    axes.sendContentMode,
  ].join(":");
}

function assertKeySegment(label: string, value: string): string {
  if (value.trim() === "") {
    throw new JobInputError(`幂等键的 ${label} 段不得为空：空的版本标识会让不同配置撞进同一行`);
  }
  return value;
}

/** 快照的构造点：键序即 `JOB_SNAPSHOT_FIELDS` 的顺序，序列化因此是确定的（同配置 ⇒ 同文本）。 */
export function snapshotFor(axes: ThreeAxes, versions: JobVersions): JobSnapshot {
  return {
    analysis_provider: axes.analysisProvider,
    redaction_mode: axes.redactionMode,
    send_content_mode: axes.sendContentMode,
    prompt_version: versions.promptVersion,
    schema_version: versions.schemaVersion,
    model_id: versions.modelId,
    redaction_policy_version: versions.redactionPolicyVersion,
  };
}

/** 按封闭字段清单序列化快照；不 `JSON.stringify(任意对象)`，多写的键进不了这份键序。 */
export function snapshotJson(snapshot: JobSnapshot): string {
  const ordered: Record<string, string> = {};
  for (const field of JOB_SNAPSHOT_FIELDS) ordered[field] = snapshot[field];
  return JSON.stringify(ordered);
}

/**
 * 队列的存储服务（本批的全部面积）。
 *
 * 写面只有 `privacy_job` 一张表；`record_revision` 只读（取 `record_id`）。
 * 时间列一律 `toISOString()`（与既有 `*_utc` 列同形，迁移的 CHECK 认这个形态）。
 * 租约比较用 SQL 的字符串 `<`：`toISOString()` 是定宽 UTC、尾缀 `Z`，字典序即时间序，
 * 而迁移对四个时间列的 CHECK 已经保证库里不可能出现别的形态——取回内存再判断反而要为
 * 「格式漂移」多写一道码，而那一道正是 CHECK 已经替我们做的事。（二选一，此处选 SQL 侧。）
 */
export class JobStore {
  private readonly db: Database;
  private readonly now: () => Date;
  private readonly leases: JobLease;

  constructor(db: Database, options: JobStoreOptions = {}) {
    this.db = db;
    this.now = options.now ?? (() => new Date());
    this.leases = options.leases ?? new JobLease(db, { now: this.now });
  }

  private row(id: string): JobRow | undefined {
    const row = this.db.prepare(`select ${JOB_COLUMNS} from privacy_job where id = ?`).get(id) as
      | unknown
      | undefined;
    return row === undefined ? undefined : (row as JobRow);
  }

  private requireRow(id: string): JobRow {
    const row = this.row(id);
    if (row === undefined) throw new JobNotFoundError(id);
    return row;
  }

  /**
   * 入队（草案 §二 的幂等键 + §八 断言 1）。
   *
   * `INSERT … ON CONFLICT (idempotency_key) DO NOTHING` 后**回读**那一行：
   * `created=true` 是本次插进去的，`created=false` 说明同键已有任务，此时**只回读、不更新**——
   * 不改 status、不改 attempts、不重置时间。这是「重复入队 ⇒ 只执行一次」的物理基础：
   * 重复入队连一次写入都没发生，worker 面对的永远是同一行的同一状态。
   *
   * `record_id` 从 revision 现读而不是采信调用方：两个指针必须同源，而库里唯一能保证的
   * 同源方式就是让它由 FK 指向的那一行自己说。revision 不存在 ⇒ `JobRevisionNotFoundError`
   * （插进去就是一条 FK 违规，但错误消息会来自 SQLite 的约束名，对用户没有信息量）。
   *
   * **同一个 revision 上只留一个活跃任务**（§二 要点「配置变了就是另一个任务（旧任务标
   * `canceled`）」的后半句）：插入成功后，把该 revision 下**幂等键不同且仍 `queued`** 的行转
   * `canceled`，`superseded` 返回它们的 id。三条口径：
   *   · 保留者是**刚插进去的这一行**，认它的 `id`（不是按 `created_at_utc` 猜「最新创建」——
   *     时间列是夹具可写的，`id` 才是「这一次入队」的事实）。
   *   · 只动 `queued`：在途的 `redacting` / `analyzing` 不能在这里掐断（那是 `requestCancel`
   *     + 检查点的活），已定案的行没有可取代的东西。与 `supersedeQueuedJobs` 同一取向。
   *   · 只在 `created` 时做：`created=false` 意味着同键重放，既没有新配置也没有旧配置可取代。
   * 只读不写的 `canceled` 行留作历史（不被删，也不参与 `currentForRevision`），因此「配置漂移
   * 会产生多行」这件事仍然是真的——变的只是活跃行数。
   */
  enqueue(input: EnqueueInput): { row: JobRow; created: boolean; superseded: string[] } {
    const revisionId = input.recordRevisionId;
    assertKeySegment("record_revision_id", revisionId);
    assertKeySegment("prompt_version", input.versions.promptVersion);
    assertKeySegment("schema_version", input.versions.schemaVersion);
    assertKeySegment("model_id", input.versions.modelId);
    assertKeySegment("redaction_policy_version", input.versions.redactionPolicyVersion);

    const revision = this.db
      .prepare("select id, record_id from record_revision where id = ?")
      .get(revisionId) as { id: string; record_id: string } | undefined;
    if (revision === undefined) throw new JobRevisionNotFoundError(revisionId);

    const key = idempotencyKeyFor(revisionId, input.versions, input.axes);
    const snapshot = snapshotFor(input.axes, input.versions);
    const timestamp = this.now().toISOString();
    const inserted = this.db
      .prepare(
        `insert into privacy_job (
           id, record_id, record_revision_id, idempotency_key, status, attempts, error_kind,
           cancel_requested, snapshot_json, created_at_utc, updated_at_utc, started_at_utc, finished_at_utc
         )
         values (?, ?, ?, ?, 'queued', 0, NULL, 0, ?, ?, ?, NULL, NULL)
         on conflict (idempotency_key) do nothing`,
      )
      .run(
        newId("privacyJob"),
        revision.record_id,
        revisionId,
        key,
        snapshotJson(snapshot),
        timestamp,
        timestamp,
      );

    const row = this.findByIdempotencyKey(key);
    if (row === null) {
      // 插入要么成功、要么被 DO NOTHING 跳过（同键行已在），两种情况这行都必须读得回来。
      // 读不回来只可能是并发 CASCADE 删掉了它——如实报错，不静默返回「没建成」。
      throw new Error(`入队后读不回幂等键对应的任务行：${key}`);
    }
    const created = Number(inserted.changes ?? 0) === 1;

    const superseded: string[] = [];
    if (created) {
      // 同 revision 的配置漂移收口（§二 要点后半句）：保留者是刚插进来的 `row.id`。
      const stale = this.db
        .prepare(
          `select id from privacy_job
           where record_revision_id = ? and id <> ? and status = 'queued'
           order by created_at_utc, id`,
        )
        .all(revisionId, row.id) as unknown as Array<{ id: string }>;
      for (const candidate of stale) {
        this.transition(candidate.id, "canceled");
        superseded.push(candidate.id);
      }
    }
    return { row, created, superseded };
  }

  get(id: string): JobRow | null {
    return this.row(id) ?? null;
  }

  findByIdempotencyKey(key: string): JobRow | null {
    const row = this.db
      .prepare(`select ${JOB_COLUMNS} from privacy_job where idempotency_key = ?`)
      .get(key) as unknown as JobRow | undefined;
    return row ?? null;
  }

  /** UI 观测面（草案 §七 的轮询查询）；时间序从旧到新，前端自己取末项展示。 */
  listForRecord(recordId: string): JobRow[] {
    return this.db
      .prepare(`select ${JOB_COLUMNS} from privacy_job where record_id = ? order by created_at_utc, id`)
      .all(recordId) as unknown as JobRow[];
  }

  /**
   * 该 revision 当前的任务：最近一个**未被取消**的行。
   *
   * 为什么排除 `canceled`：它已经不再代表「这件事还要不要做」，把它当 current 会让
   * supersede 之后的旧 revision 看起来还在途。为什么按 created_at 取末项而不是「唯一活跃行」：
   * 同 revision 的配置漂移（幂等键变了）会留下多行——活跃的那一行**已在 `enqueue` 里收口**
   * （键不同且仍 `queued` 的旧行转 `canceled`，见那里的「同一个 revision 上只留一个活跃任务」），
   * 不再是待拍事项；`canceled` 的历史行仍留在表里，所以读侧保留「取末项」这一道防御，
   * 而不是假设这里只会命中一行。
   */
  currentForRevision(recordRevisionId: string): JobRow | null {
    const row = this.db
      .prepare(
        `select ${JOB_COLUMNS} from privacy_job
         where record_revision_id = ? and status <> 'canceled'
         order by created_at_utc desc, id desc
         limit 1`,
      )
      .get(recordRevisionId) as unknown as JobRow | undefined;
    return row ?? null;
  }

  /**
   * 状态推进（§三 的唯一落点）。
   *
   * 服务层先校验 `isJobTransitionAllowed`，非法即抛 `JobTransitionError`；合法时用**同一条 UPDATE**
   * 写 `status`、`updated_at_utc` 与按目标态该填的时间列：
   *   · 进 `redacting` / `analyzing` ⇒ **首次**写 `started_at_utc`（已有值就不覆盖：租约回收后
   *     重跑保留最早的开跑时刻，`updated_at_utc` 才是活跃度判据）。
   *   · 进 `done` / `failed` / `canceled` ⇒ 写 `finished_at_utc`（每次覆盖：它是「最后一次收尾」）。
   * `updated_at_utc` 无条件写——草案 §四 的「不允许出现永远 running 的任务」全靠这一条，
   * 任何一次推进都刷新租约，恢复扫描才有过期的东西可收。
   * 目标态与当前态同名（幂等自转，如 `queued → queued`）不被允许：`JOB_TRANSITIONS` 没有自环，
   * 幂等重放该由调用方判状态，不该把「什么都没变」伪装成一次推进。
   */
  transition(id: string, to: JobStatus, patch: JobTransitionPatch = {}): JobRow {
    const current = this.requireRow(id);
    if (!isJobTransitionAllowed(current.status, to)) {
      throw new JobTransitionError(id, current.status, to);
    }
    const sets: string[] = ["status = ?", "updated_at_utc = ?"];
    const timestamp = this.now().toISOString();
    const params: (string | number | null)[] = [to, timestamp];

    if (STARTED_TARGETS.has(to) && current.started_at_utc === null) {
      sets.push("started_at_utc = ?");
      params.push(timestamp);
    }
    if (FINISHED_TARGETS.has(to)) {
      sets.push("finished_at_utc = ?");
      params.push(timestamp);
    }
    if (patch.errorKind !== undefined) {
      sets.push("error_kind = ?");
      params.push(patch.errorKind);
    }
    if (patch.attemptsDelta !== undefined && patch.attemptsDelta !== 0) {
      sets.push("attempts = attempts + ?");
      params.push(patch.attemptsDelta);
    }
    params.push(id);
    this.db.prepare(`update privacy_job set ${sets.join(", ")} where id = ?`).run(...params);
    return this.requireRow(id);
  }

  /**
   * 取消请求（§五）：三种现状，三种动作，全部**幂等**。
   *   · `queued` ⇒ 直接 `canceled` 终态并写 `finished_at_utc`（还没开跑，没有半成品可收拾）。
   *     这条路径让 `claimNextRunnable()` 再也取不到它（断言 3）。
   *     M6-1D 裁决 ①-b 给这一格补了前提：**只在没有未过期租约时**才走直接终态。行上的状态是
   *     `queued` 而租约还活着，说明它刚被回收过、另一个进程那一拍还在跑——此时直接写 `canceled`
   *     会把人家正在跑的行定成一个没发生过的终态。只置位，让持有者在检查点收尾（同下一格）。
   *   · `redacting` / `analyzing` ⇒ 只置 `cancel_requested=1`：在途的执行不能从外面掐断，
   *     worker 在下一个检查点看到标志位才收尾（§五「中止不得留下半成品」；检查点属第二批）。
   *     `updated_at_utc` 一并刷新：取消请求本身是一次推进。
   *   · `done` / `failed` / `canceled` ⇒ 原样返回当前行，不抛错、不写库。用户点对已结束的
   *     任务说「取消」不是错误，给它一个幂等返回比给它一个红字更符合语义。
   */
  requestCancel(id: string): JobRow {
    const current = this.requireRow(id);
    if (isJobTerminalStatus(current.status)) return current;
    if (current.status === "queued" && !this.leases.isLive(id)) return this.transition(id, "canceled");

    this.db
      .prepare("update privacy_job set cancel_requested = 1, updated_at_utc = ? where id = ?")
      .run(this.now().toISOString(), id);
    return this.requireRow(id);
  }

  /**
   * 取最早的可执行任务并占住它（§五「可执行」= `status='queued'` 且 `cancel_requested=0`）。
   *
   * `provider` 就绪与否**不在这里判**（本批没有 provider 装配）：判据留一条不给两条，
   * worker 那一批在调用本方法之前先问 provider，provider 不可用时干脆不取任务
   * ——这正是断言 5「provider 不可用 ⇒ 任务保持 queued、attempts 不变」的落点。
   *
   * 占用只做 `queued → redacting` 加写 `started_at_utc` / `updated_at_utc`，**不动 attempts**：
   * 「取到任务」还不是一次尝试的结果，attempts 的增减只在 `transition(..., {attemptsDelta})`
   * 一处发生，避免「取任务」与「判失败」两处各写一遍加法语义。
   * 单进程串行（草案 §一-3 的设计前提）之下不存在两个调用者抢同一行；本方法不做跨进程互斥。
   *
   * `runnable`（整理方式改动 S-4）：调用方递来的「这一行此刻能不能开工」判据，本方法按
   * `created_at_utc, id` 顺序取**第一个通过的**行。不传 ⇒ 与从前逐字相同（取最早的一行）。
   * 判据为真的行才会被占住——被跳过的那些**原样留在 `queued`**：不写 `updated_at_utc`、
   * 不动 attempts、不发一个字节，下一拍再问一次。用途是外发轨「还没拿到本次授权」：
   * 那是等用户确认，不是失败，队列没有为它准备的 `error_kind`（冻结七值，禁区不加列）。
   * 扫描有界（`CLAIM_SCAN_LIMIT`）：窗口外的行只是这一拍没被看到，不是被丢弃，队首放行后自然轮到。
   */
  claimNextRunnable(runnable?: (job: JobRow) => boolean): JobRow | null {
    const rows = this.db
      .prepare(
        `select ${JOB_COLUMNS} from privacy_job
         where status = 'queued' and cancel_requested = 0
         order by created_at_utc, id
         limit ?`,
      )
      .all(runnable === undefined ? 1 : CLAIM_SCAN_LIMIT) as unknown as JobRow[];
    const candidate = rows.find((row) => (runnable === undefined ? true : runnable(row)));
    if (candidate === undefined) return null;
    return this.transition(candidate.id, "redacting");
  }

  /**
   * 回收过期租约（§四 + §八 断言 2）：`status IN ('redacting','analyzing')` 且
   * `updated_at_utc` 早于 `now - leaseMs` 的行视为崩溃。
   *
   * 两条分岔：
   *   · 没有取消请求 ⇒ 回 `queued`，`attempts + 1`，`error_kind='internal'`（§四 明写 attempts+1；
   *     分类选 `internal` 而不是留 NULL：留 NULL 会让「上一次为什么没跑完」这条线索彻底消失，
   *     运维只能看到一行凭空回到排队的任务。`internal` 属于消耗类，与 §四 的 attempts+1 同向，
   *     二者不矛盾——这也正是这里的 attempts 增量走 `transition` 而不是本地 +1 的理由。）
   *   · `cancel_requested=1` ⇒ 回 `canceled` 而不是 `queued`：用户已经说了不要，
   *     再排一遍队等于把取消请求丢掉。不写 error_kind——取消不是失败（与
   *     `recordProcessingStatusForJobStatus` 的 canceled 分支同一个理由）。
   *
   * 租约**未过期一行都不动**（§四：单进程部署下不该出现，但判据留着，将来多实例仍成立）。
   *
   * M6-1D 裁决 ①-b 在这一格加了一道**归属**判据：行自己的时刻（`updated_at_utc`）只说「上次被动过」，
   * 不说「现在谁在用」。一个时钟超前的实例会把别人正在跑的那一行算成已过期，于是抢走它，
   * 两个进程同时整理同一条记录，被抢的那个还毫不知情。所以过期之前先问 `job_lease` 那行记录：
   * 持有者还活着且不是我 ⇒ 这一行一行都不动（**也不写租约行**——弱侧对两边的状态零写入）。
   * 没有租约记录（本批之前的行、崩溃在 acquire 之前的行）仍按 §四 的时刻判据，行为与接线前逐字相同。
   */
  reclaimExpiredLeases(leaseMs: number): string[] {
    const cutoff = new Date(this.now().getTime() - leaseMs).toISOString();
    const stale = this.db
      .prepare(
        `select id, cancel_requested from privacy_job
         where status in ('redacting', 'analyzing') and updated_at_utc < ?
         order by updated_at_utc, id`,
      )
      .all(cutoff) as unknown as Array<{ id: string; cancel_requested: 0 | 1 }>;

    const reclaimed: string[] = [];
    for (const row of stale) {
      if (this.leases.heldByOther(row.id)) continue;
      if (row.cancel_requested === 1) {
        this.transition(row.id, "canceled");
      } else {
        this.transition(row.id, "queued", { attemptsDelta: 1, errorKind: "internal" });
      }
      // 回收即接管：旧持有者那条（已过点的）记录不再被任何人引用，留着只会让下一次判据说谎。
      this.leases.release(row.id);
      reclaimed.push(row.id);
    }
    return reclaimed;
  }

  /**
   * 新 revision 入队后取代旧 revision 的排队任务（§三 表 + §八 断言 7）：
   * 同 `record_id` 下、`record_revision_id <> keep` 且 `status='queued'` 的行转 `canceled`。
   *
   * 只动 `queued`：已经在跑的行不能在这里掐断（那是 `requestCancel` + 检查点的活），
   * 已结束的行没有可取代的东西。`cancel_requested` 保持 0：queued 的取消是直接终态，
   * 不是「请求」。返回值是被取消的任务 id，调用方（第二批的同步入口/入队点）据此刷新 UI。
   *
   * 两条 supersede 路径各管一头，不重叠：本方法管**跨 revision**（§三 表 + 断言 7，由调用方在
   * 新 revision 产生后显式触发）；`enqueue` 里那条管**同 revision 的配置漂移**（§二 要点）。
   */
  supersedeQueuedJobs(recordId: string, keepRecordRevisionId: string): string[] {
    const candidates = this.db
      .prepare(
        `select id from privacy_job
         where record_id = ? and record_revision_id <> ? and status = 'queued'
         order by created_at_utc, id`,
      )
      .all(recordId, keepRecordRevisionId) as unknown as Array<{ id: string }>;

    const superseded: string[] = [];
    for (const candidate of candidates) {
      this.transition(candidate.id, "canceled");
      superseded.push(candidate.id);
    }
    return superseded;
  }

  /**
   * 同一 revision 已由**同步入口**跑完 ⇒ 作废它下面还在排队的任务（草案 §六 + §八 断言 6）。
   *
   * 两条 supersede 路径的分工，逐字对齐到「取代关系是从哪一头来的」：
   *   · `supersedeQueuedJobs` 管**跨 revision**：用户编辑产生新版本，旧版本的排队任务失去意义，
   *     所以它按 `record_id` 圈行、按 `record_revision_id <> keep` 排除保留者。
   *   · 本方法管**同一 revision**：这一版要做的事刚刚由同步路径做完了，队列不必再做第二遍。
   *     没有「保留者」概念——命中行全部作废，因此它只需要 revision 一个参数。
   *
   * 只动 `queued`：在途的 `redacting` / `analyzing` 留给 worker 的取消检查点（§五）。从外面
   * 直接把在途行掐成终态，会让正在执行它的那一轮跑完后再写一次收尾，语义上等于凭空多一次状态推进。
   *
   * **调用时机是「同步执行成功之后」，不是之前**（断言 6 的后半句）：开始前取消，一旦这次
   * 同步执行失败，那条排队任务就白丢了——用户「保存后自动处理」的意图无从弥补。成功之后
   * 取消才等价于「这件事已经做完了」；失败路径一行都不动。
   */
  cancelQueuedForRevision(recordRevisionId: string): string[] {
    const candidates = this.db
      .prepare(
        `select id from privacy_job
         where record_revision_id = ? and status = 'queued'
         order by created_at_utc, id`,
      )
      .all(recordRevisionId) as unknown as Array<{ id: string }>;

    const canceled: string[] = [];
    for (const candidate of candidates) {
      this.transition(candidate.id, "canceled");
      canceled.push(candidate.id);
    }
    return canceled;
  }
}
