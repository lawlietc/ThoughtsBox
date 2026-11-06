import { readFileSync, readdirSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MIGRATIONS_DIR, migrate } from "../src/server/db/migrator.ts";
import { RecordService } from "../src/server/records/service.ts";
import { exportJsonl } from "../src/server/backup/jsonl.ts";
import { ID_PREFIXES, newId } from "../src/shared/contracts/ids.ts";
import type { ThreeAxes } from "../src/shared/contracts/enums.ts";
import {
  JOB_ERROR_KINDS,
  JOB_RETRY_BACKOFF_CAP_MS,
  JOB_RETRY_BACKOFF_BASE_MS,
  JOB_SNAPSHOT_FIELDS,
  JOB_STATUSES,
  JOB_TERMINAL_STATUSES,
  JOB_TO_RECORD_PROCESSING_STATUS,
  JOB_TRANSITIONS,
  JobInputError,
  JobNotFoundError,
  JobRevisionNotFoundError,
  JobStore,
  JobTransitionError,
  consumesAttempt,
  idempotencyKeyFor,
  isJobErrorKind,
  isJobStatus,
  isJobTerminalStatus,
  isJobTransitionAllowed,
  jobRetryBackoffMs,
  recordProcessingStatusForJobStatus,
  snapshotJson,
  snapshotFor,
  type EnqueueInput,
  type JobErrorKind,
  type JobRow,
  type JobStatus,
  type JobVersions,
} from "../src/server/jobs/jobStore.ts";
import { makeSandbox, openSandboxDb, countRows, type Sandbox } from "./helpers/sandbox.ts";
import type { Database } from "../src/server/db/adapter.ts";

/**
 * M6-0E 第一批：后台任务队列**存储层**的验收（迁移 0010 + `jobStore.ts`）。
 *
 * 契约正文：`docs/dev-specs/2026-10-23-M6-0E-后台任务队列设计草案.md`
 * §一 现状约束、§二 表结构、§三 状态机、§四 恢复、§五 失败分类、§八 断言。
 * 本批不做 worker 循环、不做 HTTP 路由、不做自动触发——所以这里没有「跑起来」的断言，
 * 只有「状态只能沿合法边推进、幂等键只允许一行、租约到期才回收、任务行不进导出」这一类
 * 存储层判据。断言 4/5/6（在途中止无半成品、provider 恢复后继续、同步入口取消 queued）
 * 需要 worker 或同步入口的接线，属于第二批；本批只交它们的物理前提。
 *
 * 分工边界：
 *  - `m0-migration-seed` 钉迁移清单与表集合（本次的两个既有同步点）；
 *  - `m2-schema-contract` 的 `sqlAllCode` 钉「每张带 id 的业务表都有前缀 CHECK」；
 *  - 本文件钉 0010 新增的那部分：**取值域与 TS 常量的静态对账**、状态机、幂等入队、
 *    租约回收、取消、supersede、FK 级联、不进导出。
 */

const NOW = "2026-10-25T09:00:00.000Z";
const NOW_MS = Date.parse(NOW);
const TEN_MINUTES_MS = 10 * 60 * 1000;

/** 去掉行注释后的 0010 正文：静态对账只认 SQL 代码，头注里引用的字面量不参与。 */
function stripSqlComments(source: string): string {
  return source
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
}
const MIGRATION_0010_SQL = stripSqlComments(
  readFileSync(`${MIGRATIONS_DIR}/0010_privacy_job.sql`, "utf8"),
);

const enums = JSON.parse(readFileSync("src/shared/constants/enums.json", "utf8")) as {
  processing_statuses: string[];
};

/** 三轴夹具：草案 §二 的快照内容就是「三轴 + 版本标识」，这里取云端脱敏那条轨道。 */
const AXES: ThreeAxes = { analysisProvider: "cloud", redactionMode: "manual", sendContentMode: "redacted" };
/** 云端发原文那条轨道（0D 的 `cloud_raw`）：幂等键的末三段与 AXES 不同，故与它各成一行。 */
const RAW_AXES: ThreeAxes = { analysisProvider: "cloud", redactionMode: "none", sendContentMode: "raw" };
const VERSIONS: JobVersions = {
  promptVersion: "m2-prompt-v1",
  schemaVersion: "m2-output-v1",
  modelId: "qwen2.5:7b",
  redactionPolicyVersion: "rules-v1",
};
/** 含脱敏源的那份原文：断言 9 要在导出与快照两个面上证明文本没进任务行。 */
const RAW = "👍张三说打 13800138000 给 laowang@example.com 或老周";

let sandbox: Sandbox;
let db: Database;
let records: RecordService;
let store: JobStore;
let recordId: string;
let revisionId: string;

beforeEach(() => {
  sandbox = makeSandbox("tb-m6-0e-");
  db = openSandboxDb(sandbox.layout);
  migrate(db);
  records = new RecordService(db, { timezoneId: "Asia/Shanghai", now: () => new Date(NOW) });
  store = new JobStore(db, { now: () => new Date(NOW) });
  const created = records.createRecord(RAW, "cloud_redacted");
  recordId = created.record.id;
  revisionId = created.revision.id;
});

afterEach(() => {
  db.close();
  sandbox.cleanup();
});

// ── 夹具 ────────────────────────────────────────────────────────────

/** 探完即回滚的拒绝断言：夹具现场不被污染（手法与 m6-0d / m2-schema-contract 一致）。 */
function expectRejected(statement: () => void, pattern: RegExp): void {
  let thrown: Error | undefined;
  db.exec("begin immediate");
  try {
    statement();
  } catch (cause) {
    thrown = cause as Error;
  } finally {
    db.exec("rollback");
  }
  if (thrown === undefined) throw new Error(`期望被 ${pattern} 拒绝，但写入成功了`);
  expect(thrown.message).toMatch(pattern);
}

function enqueue(
  revision: string = revisionId,
  versions: JobVersions = VERSIONS,
  axes: ThreeAxes = AXES,
): { row: JobRow; created: boolean; superseded: string[] } {
  return store.enqueue({ recordRevisionId: revision, axes, versions });
}

function rowOf(id: string): JobRow {
  const row = store.get(id);
  if (row === null) throw new Error(`任务行不存在：${id}`);
  return row;
}

/**
 * 造一个真正的新 revision 并返回它的 id。
 *
 * 有了「同 revision 只留一个活跃任务」这条收口（`enqueue` 的 supersede），「在同一条 revision 上
 * 摆好多个 queued 行」已经不是被测形状了；确实需要多条互不取代的并存任务时，就各给一条 revision——
 * 这正是草案 §八-7 与断言 5 的真实场景（多条记录/多个版本各自排队）。
 * `editRecord` 只在文本真的变了才建版（B13：空 diff 不建版），所以标签必须逐次不同。
 */
let revisionCounter = 0;
function freshRevision(): string {
  revisionCounter += 1;
  const edited = records.editRecord(recordId, `${RAW}（夹具第 ${revisionCounter} 次改动）`);
  if (!edited.changed) throw new Error(`夹具没能建出新 revision：第 ${revisionCounter} 次`);
  return edited.revision.id;
}

/** 把 `updated_at_utc` 摆到过去，模拟「上次推进之后进程死了」。 */
function ageJob(id: string, agoMs: number): void {
  db.prepare("update privacy_job set updated_at_utc = ? where id = ?")
    .run(new Date(NOW_MS - agoMs).toISOString(), id);
}

/**
 * 绕过状态机直接落某个状态的夹具。
 *
 * 只在「测的是恢复扫描/取任务的筛选面，而不是状态机」时使用，并且调用处必须写明——
 * 状态机的合法边由 §C 那组用例逐条钉，这里要造的是「扫描面上一长排各态行」这种夹具形状，
 * 沿合法边走过去要为它补一串与本用例无关的推进步骤，反而把被测的那一件事埋掉了。
 */
function forceStatus(id: string, status: JobStatus): void {
  db.prepare("update privacy_job set status = ? where id = ?").run(status, id);
}

/** 抽某段迁移正文里某列**定义处**的 `column IN ( … )` 字面量清单（含顺序）。 */
function inListFrom(sql: string, column: string, label: string): string[] {
  const pattern = new RegExp(`${column} TEXT[^)]*${column} IN \\(([\\s\\S]*?)\\)`);
  const match = pattern.exec(sql);
  if (match === null) throw new Error(`${label} 里没抓到 ${column} 的定义处 IN (...) CHECK，对账失效`);
  return [...match[1]!.matchAll(/'([^']*)'/g)].map((found) => found[1]!);
}

/** 0010 那一列的清单（对账 TS 常量用）。 */
function migrationInList(column: string): string[] {
  return inListFrom(MIGRATION_0010_SQL, column, "0010");
}

/** 按表名找到**定义它的那份迁移**的去注释正文：跨迁移的封闭集对账不靠猜文件名。 */
function migrationSqlForTable(table: string): string {
  for (const name of readdirSync(MIGRATIONS_DIR).sort()) {
    if (!name.endsWith(".sql")) continue;
    const sql = stripSqlComments(readFileSync(`${MIGRATIONS_DIR}/${name}`, "utf8"));
    if (new RegExp(`CREATE TABLE ${table} \\(`).test(sql)) return sql;
  }
  throw new Error(`没有任何迁移创建表 ${table}，对账失效`);
}

/** 任意迁移里某列的 IN (...) 封闭集清单。 */
function migrationInListFor(table: string, column: string): string[] {
  return inListFrom(migrationSqlForTable(table), column, table);
}

// ── A. 静态对账：TS 常量 === 迁移 CHECK（口径 1 的落点）──────────────────

describe("A. 取值域与迁移 CHECK 同源（不手抄第二份）", () => {
  it("JOB_STATUSES 逐字等于 0010 的 status CHECK 清单，顺序也一致", () => {
    expect(migrationInList("status")).toEqual([...JOB_STATUSES]);
    // enums.json 里没有 privacy_job 的清单：调度语义不进枚举契约（口径 1）。
    const enumsRaw = readFileSync("src/shared/constants/enums.json", "utf8");
    expect(enumsRaw).not.toContain("redacting");
    expect(enumsRaw).not.toContain("privacy_job");
  });

  it("JOB_ERROR_KINDS 逐字等于 0010 的 error_kind CHECK 清单", () => {
    expect(migrationInList("error_kind")).toEqual([...JOB_ERROR_KINDS]);
    expect(MIGRATION_0010_SQL).toMatch(/error_kind IS NULL\s+OR error_kind IN/);
  });

  it("类型守卫与两份清单同进同出：在册的真，陌生与非法类型的假", () => {
    for (const status of JOB_STATUSES) expect(isJobStatus(status)).toBe(true);
    for (const kind of JOB_ERROR_KINDS) expect(isJobErrorKind(kind)).toBe(true);
    expect(isJobStatus("running")).toBe(false);
    expect(isJobStatus("succeeded")).toBe(false);
    expect(isJobStatus(null)).toBe(false);
    expect(isJobStatus(3)).toBe(false);
    expect(isJobErrorKind("network")).toBe(false);
    expect(isJobErrorKind(undefined)).toBe(false);
  });

  it("0010 的键与挂接面：UNIQUE(idempotency_key)、前缀 CHECK、FK CASCADE、STRICT 都在", () => {
    expect(MIGRATION_0010_SQL).toMatch(/UNIQUE \(idempotency_key\)/);
    expect(MIGRATION_0010_SQL).toMatch(new RegExp(`CHECK \\(id GLOB '${ID_PREFIXES.privacyJob}_\\*'\\)`));
    expect(ID_PREFIXES.privacyJob).toBe("pjob");
    expect(MIGRATION_0010_SQL).toMatch(
      /FOREIGN KEY \(record_revision_id\) REFERENCES record_revision \(id\) ON DELETE CASCADE/,
    );
    expect(MIGRATION_0010_SQL).toMatch(/\) STRICT;/);
    expect(MIGRATION_0010_SQL).toMatch(/CHECK \(json_valid\(snapshot_json\)\)/);
    expect(MIGRATION_0010_SQL).toMatch(/CHECK \(attempts >= 0\)/);
    expect(MIGRATION_0010_SQL).toMatch(/CHECK \(cancel_requested IN \(0, 1\)\)/);
    // 调度与恢复共用的索引，加上 record_id 那一处：不多造别的。
    expect(MIGRATION_0010_SQL).toMatch(/CREATE INDEX ix_privacy_job_dispatch ON privacy_job \(status, created_at_utc\)/);
    expect(MIGRATION_0010_SQL).toMatch(/CREATE INDEX ix_privacy_job_record ON privacy_job \(record_id\)/);
    const indexes = (
      db.prepare("select name from sqlite_master where type='index' and tbl_name='privacy_job' order by name").all() as Array<{
        name: string;
      }>
    ).map((row) => row.name);
    expect(indexes).toContain("ix_privacy_job_dispatch");
    expect(indexes).toContain("ix_privacy_job_record");
  });

  it("JobRow 的键集合与库里的列集合逐字一致（snake_case，不另起别名）", () => {
    const created = enqueue();
    const columns = (db.prepare("pragma table_info(privacy_job)").all() as Array<{ name: string }>).map(
      (column) => column.name,
    );
    expect(Object.keys(created.row).sort()).toEqual([...columns].sort());
    expect(columns).toEqual([
      "id",
      "record_id",
      "record_revision_id",
      "idempotency_key",
      "status",
      "attempts",
      "error_kind",
      "cancel_requested",
      "snapshot_json",
      "created_at_utc",
      "updated_at_utc",
      "started_at_utc",
      "finished_at_utc",
    ]);
  });

  it("四个时间列一律认 toISOString() 形态；本地时区与坏 JSON 一律被 CHECK 拒", () => {
    expectRejected(
      () =>
        db
          .prepare(
            `insert into privacy_job (id, record_id, record_revision_id, idempotency_key, status, snapshot_json, created_at_utc, updated_at_utc)
             values ('pjob_local_time', ?, ?, 'k-local', 'queued', '{}', '2026-10-25T17:00:00+08:00', ?)`,
          )
          .run(recordId, revisionId, NOW),
      /CHECK constraint failed/,
    );
    expectRejected(
      () =>
        db
          .prepare(
            `insert into privacy_job (id, record_id, record_revision_id, idempotency_key, status, snapshot_json, created_at_utc, updated_at_utc, started_at_utc)
             values ('pjob_bad_started', ?, ?, 'k-started', 'queued', '{}', ?, ?, 'nope')`,
          )
          .run(recordId, revisionId, NOW, NOW),
      /CHECK constraint failed/,
    );
    expectRejected(
      () =>
        db
          .prepare(
            `insert into privacy_job (id, record_id, record_revision_id, idempotency_key, status, snapshot_json, created_at_utc, updated_at_utc)
             values ('pjob_bad_json', ?, ?, 'k-json', 'queued', 'not json', ?, ?)`,
          )
          .run(recordId, revisionId, NOW, NOW),
      /CHECK constraint failed/,
    );
  });

  it("库里那一层的取值守门：陌生 status / error_kind / 负 attempts / 非 0-1 取消位都被拒", () => {
    const base =
      `insert into privacy_job (id, record_id, record_revision_id, idempotency_key, status, attempts, error_kind, cancel_requested, snapshot_json, created_at_utc, updated_at_utc)
       values (?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?)`;
    expectRejected(
      () => db.prepare(base).run("pjob_status", recordId, revisionId, "k1", "running", 0, null, 0, NOW, NOW),
      /CHECK constraint failed/,
    );
    expectRejected(
      () => db.prepare(base).run("pjob_kind", recordId, revisionId, "k2", "queued", 0, "network", 0, NOW, NOW),
      /CHECK constraint failed/,
    );
    expectRejected(
      () => db.prepare(base).run("pjob_neg", recordId, revisionId, "k3", "queued", -1, null, 0, NOW, NOW),
      /CHECK constraint failed/,
    );
    expectRejected(
      () => db.prepare(base).run("pjob_cancel", recordId, revisionId, "k4", "queued", 0, null, 2, NOW, NOW),
      /CHECK constraint failed/,
    );
    expectRejected(
      () => db.prepare(base).run("job_noprefix", recordId, revisionId, "k5", "queued", 0, null, 0, NOW, NOW),
      /CHECK constraint failed/,
    );
    // 同前缀但指向不存在的 revision：FK 拒绝（断言 8 的另一面——挂接必须有处可挂）。
    expectRejected(
      () => db.prepare(base).run(newId("privacyJob"), recordId, "rev_missing", "k6", "queued", 0, null, 0, NOW, NOW),
      /FOREIGN KEY constraint failed/,
    );
    expect(countRows(db, "privacy_job")).toBe(0);
  });

  it("record_id 不建外键（0010 头注的裁决）：陌生 record_id 能落库，权威挂接在 revision 上", () => {
    const { row } = store.enqueue({
      recordRevisionId: revisionId,
      axes: AXES,
      versions: { ...VERSIONS, promptVersion: "other-prompt" },
    });
    expect(row.record_id).toBe(recordId);
    // 没有 FK(record_id) → capture_record：删记录不会绕过 revision 那条 CASCADE 产生第二种失败模式。
    const fks = db.prepare("pragma foreign_key_list(privacy_job)").all() as Array<{
      table: string;
      from: string;
      on_delete: string;
    }>;
    expect(fks.map((fk) => fk.from)).toEqual(["record_revision_id"]);
    expect(fks[0]!.table).toBe("record_revision");
    expect(fks[0]!.on_delete).toBe("CASCADE");
  });
});

// ── B. 断言 1：同幂等键重复入队只有一行、不改写既有行 ＋ 同 revision 的配置漂移收口 ──

describe("B. §八-1 幂等入队：重复入队连一次写入都不发生", () => {
  it("幂等键逐字是 <revision>:<prompt>:<schema>:<model>:<policy>:<provider>:<redaction>:<send>", () => {
    const key = idempotencyKeyFor(revisionId, VERSIONS, AXES);
    // 末三段是三轴（封闭集取值，不含冒号）：§二 要点「配置变了就是另一个任务」要求它们在键内。
    expect(key).toBe(`${revisionId}:m2-prompt-v1:m2-output-v1:qwen2.5:7b:rules-v1:cloud:manual:redacted`);
    expect(enqueue().row.idempotency_key).toBe(key);
    expect(store.findByIdempotencyKey(key)?.id).toBe(enqueue().row.id);
    // 换一条轨道就是另一个键：`send_content_mode` 段从 redacted 变 raw。
    expect(idempotencyKeyFor(revisionId, VERSIONS, RAW_AXES)).toBe(
      `${revisionId}:m2-prompt-v1:m2-output-v1:qwen2.5:7b:rules-v1:cloud:none:raw`,
    );
  });

  it("同键第二次入队 created=false，库里仍一行，status/attempts/created_at_utc 不被改写", () => {
    const first = enqueue();
    expect(first.created).toBe(true);

    // 先把它推进到在途态并加一次尝试，再重复入队：既有行的任何字段都不许被重置。
    store.transition(first.row.id, "redacting");
    store.transition(first.row.id, "analyzing", { attemptsDelta: 1, errorKind: "timeout" });
    const before = rowOf(first.row.id);
    expect(before.status).toBe("analyzing");
    expect(before.attempts).toBe(1);

    const again = enqueue();
    expect(again.created).toBe(false);
    expect(again.superseded).toEqual([]); // 同键重放：既没有新配置，也没有旧配置可取代
    expect(again.row.id).toBe(first.row.id);
    expect(countRows(db, "privacy_job")).toBe(1);
    expect(rowOf(first.row.id)).toEqual(before);
  });

  it("配置变一个字段就是另一行：四段版本标识逐段各自成键", () => {
    const base = enqueue().row.id;
    const ids = new Set<string>([base]);
    for (const patch of [
      // 这四段各自只要「与 VERSIONS 不同」即可；用合成串而不是真实版本号，
      // 免得真实默认值一升级就悄悄撞上别处的值。
      { promptVersion: "test-prompt-next" },
      { schemaVersion: "test-output-next" },
      { modelId: "qwen3:8b" },
      { redactionPolicyVersion: "raw-v1" },
    ] satisfies Partial<JobVersions>[]) {
      const result = enqueue(revisionId, { ...VERSIONS, ...patch });
      expect(result.created).toBe(true);
      ids.add(result.row.id);
    }
    expect(ids.size).toBe(5);
    expect(countRows(db, "privacy_job")).toBe(5);
    // 「各成一行」判的是行数与键，不是状态：同 revision 只留一个活跃任务（§二 要点的 supersede），
    // 所以前四行都被最后一次入队顶替成 canceled，行本身仍在表里作历史。
    expect(rowOf(base).status).toBe("canceled");
    expect([...ids].filter((id) => rowOf(id).status === "queued")).toHaveLength(1);
  });

  it("另一条 revision 同配置也是另一行；三轴不同同样是另一行，被顶替的旧 queued 转 canceled", () => {
    const base = enqueue();
    expect(base.created).toBe(true);

    // 不同 revision ⇒ 键的第一段就不同 ⇒ 另一行（跨 revision 的取代由 supersedeQueuedJobs 显式管）。
    const edited = records.editRecord(recordId, `${RAW}（又改了一个字）`);
    expect(edited.changed).toBe(true);
    const other = enqueue(edited.revision.id);
    expect(other.created).toBe(true);
    expect(other.row.record_revision_id).toBe(edited.revision.id);
    expect(other.row.record_id).toBe(recordId);
    expect(rowOf(base.row.id).status).toBe("queued"); // 跨 revision 的入队不碰这一行

    // 三轴进键（§二 要点：配置变了就是另一个任务）：同 revision 换到发原文那条轨道 ⇒ 另一行，
    // 且这一行的 send_content_mode=raw 不会复用上面那份「脱敏」任务的行——两类发送意向各自成键。
    const cloudRaw = enqueue(revisionId, VERSIONS, RAW_AXES);
    expect(cloudRaw.created).toBe(true);
    expect(cloudRaw.row.status).toBe("queued");
    expect(cloudRaw.row.idempotency_key).toBe(`${revisionId}:m2-prompt-v1:m2-output-v1:qwen2.5:7b:rules-v1:cloud:none:raw`);
    // 本次改动的核心证据：同 revision、键不同的旧 queued 行被顶替，活跃任务只剩刚插入的这一行。
    expect(cloudRaw.superseded).toEqual([base.row.id]);
    expect(rowOf(base.row.id).status).toBe("canceled");
    expect(rowOf(base.row.id).finished_at_utc).toBe(NOW);
    expect(rowOf(base.row.id).cancel_requested).toBe(0); // queued 的取代是直接终态，不是「请求」

    // 三轴相同 ⇒ 键相同 ⇒ 连一次写入都不发生，回读到的就是上面那行 raw 任务本身。
    const again = enqueue(revisionId, VERSIONS, RAW_AXES);
    expect(again.created).toBe(false);
    expect(again.superseded).toEqual([]);
    expect(again.row.id).toBe(cloudRaw.row.id);
    expect(store.currentForRevision(revisionId)?.id).toBe(cloudRaw.row.id);
  });

  it("入队的初始形状：queued / attempts 0 / error_kind NULL / cancel_requested 0 / 时间列为空", () => {
    const { row } = enqueue();
    expect(row.status).toBe("queued");
    expect(row.attempts).toBe(0);
    expect(row.error_kind).toBeNull();
    expect(row.cancel_requested).toBe(0);
    expect(row.created_at_utc).toBe(NOW);
    expect(row.updated_at_utc).toBe(NOW);
    expect(row.started_at_utc).toBeNull();
    expect(row.finished_at_utc).toBeNull();
    expect(row.id.startsWith(`${ID_PREFIXES.privacyJob}_`)).toBe(true);
  });

  it("空的版本标识段被拒：空段会让不同配置撞进同一行（断言 1 的反面）", () => {
    expect(() => enqueue(revisionId, { ...VERSIONS, modelId: "   " })).toThrow(JobInputError);
    expect(() => store.enqueue({ recordRevisionId: "  ", axes: AXES, versions: VERSIONS })).toThrow(JobInputError);
    expect(countRows(db, "privacy_job")).toBe(0);
  });

  it("revision 不存在 ⇒ JobRevisionNotFoundError，一行都不落", () => {
    expect(() => enqueue("rev_not_here")).toThrow(JobRevisionNotFoundError);
    expect(countRows(db, "privacy_job")).toBe(0);
  });
});

// ── C. §三 状态机（含 §四 的两条恢复边）───────────────────────────────

describe("C. 状态机：非法转换一律抛，合法转换在同一条 UPDATE 里写时间列", () => {
  it("转换表的键覆盖六个状态；无出边的正是 done / canceled（与「不再执行」那一档不同）", () => {
    expect(Object.keys(JOB_TO_RECORD_PROCESSING_STATUS).sort()).toEqual([...JOB_STATUSES].sort());
    for (const status of JOB_STATUSES) {
      expect(Object.keys(JOB_TRANSITIONS)).toContain(status);
    }
    expect(Object.keys(JOB_TRANSITIONS).sort()).toEqual([...JOB_STATUSES].sort()); // 键面恰是六值，不多不少
    const noOutEdge = JOB_STATUSES.filter((status) => !JOB_STATUSES.some((to) => isJobTransitionAllowed(status, to)));
    expect(noOutEdge).toEqual(["done", "canceled"]);
    // JOB_TERMINAL_STATUSES 判的是「不再需要 worker 执行」，多出的那一个就是可被用户重试的 failed。
    expect([...JOB_TERMINAL_STATUSES]).toEqual(["done", "failed", "canceled"]);
    expect(isJobTerminalStatus("failed")).toBe(true);
    expect(isJobTerminalStatus("redacting")).toBe(false);
  });

  it("§三 的七行逐条放行", () => {
    expect(isJobTransitionAllowed("queued", "redacting")).toBe(true);
    expect(isJobTransitionAllowed("redacting", "analyzing")).toBe(true);
    expect(isJobTransitionAllowed("analyzing", "done")).toBe(true);
    expect(isJobTransitionAllowed("redacting", "failed")).toBe(true);
    expect(isJobTransitionAllowed("analyzing", "failed")).toBe(true);
    expect(isJobTransitionAllowed("queued", "canceled")).toBe(true);
    expect(isJobTransitionAllowed("redacting", "canceled")).toBe(true);
    expect(isJobTransitionAllowed("analyzing", "canceled")).toBe(true);
    expect(isJobTransitionAllowed("failed", "queued")).toBe(true);
  });

  it("§四 的恢复边（redacting/analyzing → queued）在服务层放行，不另开一条绕过校验的写入路径", () => {
    expect(isJobTransitionAllowed("redacting", "queued")).toBe(true);
    expect(isJobTransitionAllowed("analyzing", "queued")).toBe(true);
  });

  it("其余一律拒绝：queued→done/failed/analyzing、终态出边、倒着走、自环", () => {
    const rejected: Array<[JobStatus, JobStatus]> = [
      ["queued", "done"],
      ["queued", "failed"],
      ["queued", "analyzing"],
      ["queued", "queued"],
      ["redacting", "done"],
      ["analyzing", "redacting"],
      ["analyzing", "analyzing"],
      ["done", "analyzing"],
      ["done", "queued"],
      ["canceled", "queued"],
      ["canceled", "failed"],
      ["failed", "done"],
      ["failed", "analyzing"],
    ];
    for (const [from, to] of rejected) expect(isJobTransitionAllowed(from, to), `${from} → ${to}`).toBe(false);

    const { row } = enqueue();
    expect(() => store.transition(row.id, "done")).toThrow(JobTransitionError);
    expect(rowOf(row.id).status).toBe("queued");
    expect(rowOf(row.id).finished_at_utc).toBeNull();
  });

  it("JobTransitionError 的消息带任务 id 与 from/to；陌生任务 id 抛 JobNotFoundError", () => {
    const { row } = enqueue();
    let message = "";
    try {
      store.transition(row.id, "analyzing");
    } catch (cause) {
      expect(cause).toBeInstanceOf(JobTransitionError);
      message = (cause as Error).message;
    }
    expect(message).toContain(row.id);
    expect(message).toContain("queued");
    expect(message).toContain("analyzing");
    expect(message).not.toContain(RAW);
    expect(() => store.transition("pjob_absent", "redacting")).toThrow(JobNotFoundError);
    expect(() => store.requestCancel("pjob_absent")).toThrow(JobNotFoundError);
  });

  it("进在途态首次写 started_at_utc；租约回收后再被取走不覆盖它（updated_at 才是活跃度判据）", () => {
    const { row } = enqueue();
    const claimed = store.claimNextRunnable();
    expect(claimed?.id).toBe(row.id);
    const startedAt = rowOf(row.id).started_at_utc;
    expect(startedAt).toBe(NOW);

    ageJob(row.id, 11 * 60 * 1000);
    store.reclaimExpiredLeases(TEN_MINUTES_MS);
    const reclaimed = rowOf(row.id);
    expect(reclaimed.status).toBe("queued");
    expect(reclaimed.started_at_utc).toBe(startedAt);

    const again = store.claimNextRunnable();
    expect(again?.id).toBe(row.id);
    expect(rowOf(row.id).started_at_utc).toBe(startedAt);
    expect(rowOf(row.id).updated_at_utc).toBe(NOW);
  });

  it("带判据认领：判据为假的行原样留在队列里，这一拍取后面那一行", () => {
    const blocked = enqueue().row;
    const otherRevision = freshRevision();
    const later = enqueue(otherRevision).row;

    const claimed = store.claimNextRunnable((job) => job.record_revision_id === otherRevision);

    expect(claimed?.id).toBe(later.id);
    expect(claimed?.status).toBe("redacting");
    // 被跳过的那一行整行逐字未变：没占位、没消耗 attempts、活跃度列不刷新。
    expect(rowOf(blocked.id)).toEqual(blocked);
  });

  it("带判据认领：全为假 ⇒ 这一拍没有活，一行都不动（下一拍会重问同一个判据）", () => {
    const { row } = enqueue();
    expect(store.claimNextRunnable(() => false)).toBeNull();
    expect(rowOf(row.id)).toEqual(row);
  });

  it("不传判据 ⇒ 与从前逐字相同：取最早的那一行（老用例的语义一个字都没放宽）", () => {
    const { row } = enqueue();
    expect(store.claimNextRunnable()?.id).toBe(row.id);
  });

  it("推进必写 updated_at_utc，并在 done/failed/canceled 三个终态写 finished_at_utc", () => {
    const { row } = enqueue();
    store.transition(row.id, "redacting");
    store.transition(row.id, "analyzing");
    expect(rowOf(row.id).finished_at_utc).toBeNull();

    const done = store.transition(row.id, "done");
    expect(done.status).toBe("done");
    expect(done.finished_at_utc).toBe(NOW);
    expect(done.updated_at_utc).toBe(NOW);
    expect(done.started_at_utc).toBe(NOW);

    // 三次推进都刷新了活跃度：§四「不允许出现永远 running 的任务」的判据列。
    const updates = db
      .prepare("select count(distinct updated_at_utc) as n from privacy_job")
      .get() as { n: number };
    expect(updates.n).toBe(1); // 同一次测试里 now 固定， distinct 只有一值是应有的形状
  });

  it("errorKind 的三态：undefined 不动该列、null 显式清空、有值写分类；attempts 只由增量改", () => {
    const { row } = enqueue();
    store.transition(row.id, "redacting", { errorKind: "timeout" });
    expect(rowOf(row.id).error_kind).toBe("timeout");
    expect(rowOf(row.id).attempts).toBe(0);

    store.transition(row.id, "analyzing");
    expect(rowOf(row.id).error_kind).toBe("timeout"); // 不传就不碰

    store.transition(row.id, "failed", { attemptsDelta: 1 });
    expect(rowOf(row.id).attempts).toBe(1);
    const retried = store.transition(row.id, "queued", { attemptsDelta: 0, errorKind: null });
    expect(retried.error_kind).toBeNull();
    expect(retried.attempts).toBe(1);
    expect(retried.status).toBe("queued");

    // attempts 的下限由库里那一层的 CHECK（attempts >= 0）挡下，服务层不再重复实现一道。
    // 原期望在此处对 `queued → redacting` 断言「被 CHECK 拒绝」，是算错了：那条边合法，
    // 而且它不碰 attempts，永远撞不到 CHECK——能撞的只有 attempts 的取值门。
    // 直接用 SQL 钉这一条（夹具绕过状态机，测的是取值门而不是状态机）。
    expectRejected(
      () => db.prepare("update privacy_job set attempts = -1 where id = ?").run(row.id),
      /CHECK constraint failed/,
    );
    // 走服务层的合法边把 attempts 从 1 累到 5，再用 -9 压到 **-4**（不是 0）才是该被拒的那一下。
    // 原序列有两个错：① `+1 +1 +1 +1 -5` 从 1 出发正好落在 0，而 CHECK 只拒负数，于是写入成功；
    // ② 它把 `queued → failed` 当合法边（§三 没有这条，failed 只能从两个在途态进），
    //    真跑起来先抛的是 JobTransitionError，消息对不上 CHECK。故重试段之后都补一步 redacting。
    expectRejected(() => {
      store.transition(row.id, "redacting"); //                       attempts 1
      store.transition(row.id, "failed", { attemptsDelta: 1 }); //    2
      store.transition(row.id, "queued", { attemptsDelta: 1 }); //    3  §三 的重试边
      store.transition(row.id, "redacting");
      store.transition(row.id, "failed", { attemptsDelta: 1 }); //    4
      store.transition(row.id, "queued", { attemptsDelta: 1 }); //    5
      store.transition(row.id, "redacting");
      store.transition(row.id, "failed", { attemptsDelta: -9 }); //   -4 ⇒ CHECK 拒
    }, /CHECK constraint failed/);
    expect(rowOf(row.id)).toEqual(retried); // 两次探完即回滚：现场还是 attempts 1 / queued
  });
});

// ── D. 断言 2：租约到期才回收，未过期一行不动 ──────────────────────────

describe("D. §八-2 恢复：过期租约回 queued，未过期不动，已请求取消的回 canceled", () => {
  it("redacting 且 11 分钟没推进 ⇒ 回 queued、attempts+1、error_kind=internal", () => {
    const { row } = enqueue();
    store.transition(row.id, "redacting");
    ageJob(row.id, 11 * 60 * 1000);

    const reclaimed = store.reclaimExpiredLeases(TEN_MINUTES_MS);
    expect(reclaimed).toEqual([row.id]);
    const after = rowOf(row.id);
    expect(after.status).toBe("queued");
    expect(after.attempts).toBe(1);
    expect(after.error_kind).toBe("internal");
    expect(after.updated_at_utc).toBe(NOW);
    // 取消位与快照不被回收动作改动。
    expect(after.cancel_requested).toBe(0);
    expect(after.snapshot_json).toBe(row.snapshot_json);
  });

  it("analyzing 过期同样回 queued（两个在途态都在恢复扫描面内）", () => {
    const { row } = enqueue();
    store.transition(row.id, "redacting");
    store.transition(row.id, "analyzing");
    ageJob(row.id, 10 * 60 * 1000 + 1);

    expect(store.reclaimExpiredLeases(TEN_MINUTES_MS)).toEqual([row.id]);
    expect(rowOf(row.id).status).toBe("queued");
  });

  it("2 分钟没推进 ⇒ 一行都不动（租约未过期就是「另一个实例正在跑」）", () => {
    const { row } = enqueue();
    store.transition(row.id, "redacting");
    ageJob(row.id, 2 * 60 * 1000);
    const before = rowOf(row.id);

    expect(store.reclaimExpiredLeases(TEN_MINUTES_MS)).toEqual([]);
    expect(rowOf(row.id)).toEqual(before);
  });

  it("恰好等于阈值的行不动（判据是严格早于 now-leaseMs）", () => {
    const { row } = enqueue();
    store.transition(row.id, "redacting"); // 合法路径：queued → redacting → analyzing
    store.transition(row.id, "analyzing"); //（原期望直接从 queued 跳 analyzing，被 §三 的状态机拒了）
    ageJob(row.id, TEN_MINUTES_MS);
    expect(store.reclaimExpiredLeases(TEN_MINUTES_MS)).toEqual([]);
    expect(rowOf(row.id).status).toBe("analyzing");
  });

  it("cancel_requested=1 的过期行回 canceled 而不是 queued：用户的取消不许被恢复扫描丢掉", () => {
    const { row } = enqueue();
    store.transition(row.id, "redacting");
    store.requestCancel(row.id);
    expect(rowOf(row.id).cancel_requested).toBe(1);
    ageJob(row.id, 11 * 60 * 1000);

    expect(store.reclaimExpiredLeases(TEN_MINUTES_MS)).toEqual([row.id]);
    const after = rowOf(row.id);
    expect(after.status).toBe("canceled");
    expect(after.finished_at_utc).toBe(NOW);
    expect(after.attempts).toBe(0); // 取消不是一次尝试
    expect(after.error_kind).toBeNull(); // 取消不是失败
  });

  it("queued 与三个终态都不在恢复扫描面内；多行按 updated_at 顺序全部回收", () => {
    // 六行各挂一条自己的 revision：同 revision 上只留一个活跃任务（`enqueue` 的 supersede），
    // 想要六行并存就得各给一条 revision——这也是断言 5 的真实形状（多条记录各自排队），
    // 而不是「同一条 revision 上摆六个任务」那种已经被键规则排除的形状。
    const inflightA = enqueue().row.id; //            redacting，最过期
    const inflightB = enqueue(freshRevision()).row.id; // analyzing，次过期
    const idle = enqueue(freshRevision()).row.id; //   留在 queued
    const done = enqueue(freshRevision()).row.id;
    const failed = enqueue(freshRevision()).row.id;
    const canceled = enqueue(freshRevision()).row.id;

    store.transition(inflightA, "redacting");
    store.transition(inflightB, "redacting");
    store.transition(inflightB, "analyzing");
    // 这三个终态用 SQL 直接落（夹具绕过状态机，测的是恢复扫描的筛选面而不是状态机）：
    // 沿合法边走到 done/failed/canceled 要为本用例补一串无关的推进步骤，反而埋掉被测的那件事。
    forceStatus(done, "done");
    forceStatus(failed, "failed");
    forceStatus(canceled, "canceled");

    ageJob(inflightA, 30 * 60 * 1000);
    ageJob(inflightB, 11 * 60 * 1000);
    ageJob(idle, 40 * 60 * 1000); // 再旧也不在扫描面内
    ageJob(done, 20 * 60 * 1000);
    ageJob(failed, 20 * 60 * 1000);
    ageJob(canceled, 20 * 60 * 1000);
    const idleBefore = rowOf(idle);
    const doneBefore = rowOf(done);
    const failedBefore = rowOf(failed);
    const canceledBefore = rowOf(canceled);

    // 回收顺序按 updated_at 从旧到新：A（30 分钟）先于 B（11 分钟）。
    expect(store.reclaimExpiredLeases(TEN_MINUTES_MS)).toEqual([inflightA, inflightB]);
    expect(rowOf(inflightA).status).toBe("queued");
    expect(rowOf(inflightB).status).toBe("queued");
    expect(rowOf(idle)).toEqual(idleBefore); // queued 不动
    expect(rowOf(done)).toEqual(doneBefore); // 已定案的行不动
    expect(rowOf(failed)).toEqual(failedBefore);
    expect(rowOf(canceled)).toEqual(canceledBefore);
    // 原期望只造了 redacting/analyzing/done 三行，且直接从 queued 跳 done（§三 无此边）。
  });
});

// ── E. 断言 3 + §五：取任务与取消 ─────────────────────────────────────

describe("E. §八-3 取消 queued 立即终态，worker 再也取不到它", () => {
  it("queued → requestCancel ⇒ canceled + finished_at_utc，且 claimNextRunnable 取不到", () => {
    const { row } = enqueue();
    const canceled = store.requestCancel(row.id);
    expect(canceled.status).toBe("canceled");
    expect(canceled.finished_at_utc).toBe(NOW);
    expect(canceled.updated_at_utc).toBe(NOW);
    expect(canceled.cancel_requested).toBe(0); // 直接终态，不走请求位

    expect(store.claimNextRunnable()).toBeNull();
    // 幂等：再取消一次拿到同一行，不抛错、不重写。
    expect(store.requestCancel(row.id)).toEqual(canceled);
    expect(rowOf(row.id)).toEqual(canceled);
  });

  it("在途态只置请求位：status 不变，取消由 worker 在检查点收尾（本批不实现检查点）", () => {
    const { row } = enqueue();
    store.transition(row.id, "redacting");
    const requested = store.requestCancel(row.id);
    expect(requested.status).toBe("redacting");
    expect(requested.cancel_requested).toBe(1);
    expect(requested.finished_at_utc).toBeNull();
    expect(requested.updated_at_utc).toBe(NOW);

    // 检查点之后的收尾就是 §三 的那条边：redacting → canceled。
    const closed = store.transition(row.id, "canceled");
    expect(closed.status).toBe("canceled");
    expect(closed.finished_at_utc).toBe(NOW);

    const analyzing = enqueue(revisionId, { ...VERSIONS, promptVersion: "p-analyzing" }).row.id;
    store.transition(analyzing, "redacting");
    store.transition(analyzing, "analyzing");
    expect(store.requestCancel(analyzing).cancel_requested).toBe(1);
  });

  it("done / failed 上 requestCancel 是幂等返回，不抛错也不写库", () => {
    const done = enqueue().row.id;
    store.transition(done, "redacting");
    store.transition(done, "analyzing");
    store.transition(done, "done");
    const doneBefore = rowOf(done);
    expect(store.requestCancel(done)).toEqual(doneBefore);
    expect(rowOf(done)).toEqual(doneBefore);

    // 这一行必须真的停在 `failed` 终态：原期望只推到 redacting 就断言「终态不变」，
    // 而 redacting 上 requestCancel 按 §五 就该置 cancel_requested=1 —— 那不是终态幂等，是在途请求。
    const failed = enqueue(freshRevision()).row.id;
    store.transition(failed, "redacting");
    store.transition(failed, "analyzing");
    store.transition(failed, "failed", { attemptsDelta: 1, errorKind: "timeout" });
    const failedBefore = rowOf(failed);
    expect(failedBefore.status).toBe("failed");
    expect(store.requestCancel(failed)).toEqual(failedBefore);
    expect(rowOf(failed)).toEqual(failedBefore);
    expect(rowOf(failed).cancel_requested).toBe(0); // 终态不吃请求位
  });

  it("claimNextRunnable 取最早的可执行任务，跳过 cancel_requested=1 的行", () => {
    // 三行各挂一条 revision：若都挤在同一条 revision 上，后入队的那次会把前一行 supersede 成
    // canceled，`requestCancel(older)` 就退化成终态幂等返回——本用例要钉的是「queued 被取消后
    // 取不到」，所以并存的前提得先成立。
    const older = enqueue().row.id;
    const newer = enqueue(freshRevision(), { ...VERSIONS, promptVersion: "p2" }).row.id;
    // 让 older 更晚创建：把时间摆到过去，判据是 created_at_utc。
    db.prepare("update privacy_job set created_at_utc = ? where id = ?").run(
      new Date(NOW_MS - 60_000).toISOString(),
      newer,
    );
    const beforeCancel = rowOf(older);
    expect(beforeCancel.status).toBe("queued"); // 确实还是 queued：取消走的真是那条终态边
    store.requestCancel(older);

    const claimed = store.claimNextRunnable();
    expect(claimed?.id).toBe(newer);
    expect(claimed?.status).toBe("redacting");
    expect(claimed?.attempts).toBe(0); // 取任务不是尝试：attempts 的增减只有一处落点
    expect(rowOf(newer).started_at_utc).toBe(NOW);
    expect(rowOf(newer).updated_at_utc).toBe(NOW);
    expect(rowOf(older).status).toBe("canceled");

    // 已请求取消的 queued 不被取走；取消它才落到终态。
    const pending = enqueue(freshRevision(), { ...VERSIONS, promptVersion: "p3" }).row.id;
    db.prepare("update privacy_job set cancel_requested = 1 where id = ?").run(pending);
    expect(store.claimNextRunnable()).toBeNull();
  });

  it("没有候选返回 null，且不写任何行", () => {
    expect(store.claimNextRunnable()).toBeNull();
    expect(countRows(db, "privacy_job")).toBe(0);
    const { row } = enqueue();
    store.transition(row.id, "redacting");
    expect(store.claimNextRunnable()).toBeNull();
  });
});

// ── F. 断言 7 + 查询面 ───────────────────────────────────────────────

describe("F. §八-7 supersede：新 revision 入队后旧 revision 的 queued 转 canceled", () => {
  it("同 record 两个 revision 各一行：旧的 canceled，新的仍 queued", () => {
    const old = enqueue().row.id;
    const edited = records.editRecord(recordId, `${RAW}（改一个字）`);
    const fresh = enqueue(edited.revision.id).row.id;

    const superseded = store.supersedeQueuedJobs(recordId, edited.revision.id);
    expect(superseded).toEqual([old]);
    expect(rowOf(old).status).toBe("canceled");
    expect(rowOf(old).finished_at_utc).toBe(NOW);
    expect(rowOf(old).cancel_requested).toBe(0); // queued 的取消是直接终态，不是请求位
    expect(rowOf(fresh).status).toBe("queued");
  });

  it("keep 那一行即便来自别的 record 也不被碰；非 queued 的旧行留给取消检查点处理", () => {
    const other = records.createRecord("另一条记录", "cloud_redacted");
    const otherQueued = enqueue(other.revision.id).row.id;
    const mine = enqueue().row.id;
    // 同 record 的另一条 revision（不是同一条 revision：那会被 enqueue 的 supersede 顶掉 mine，
    // 本用例要钉的是 supersedeQueuedJobs 这条**跨 revision** 的路径，同 revision 那条已由 B 钉过）。
    const inFlight = enqueue(freshRevision(), { ...VERSIONS, promptVersion: "p2" }).row.id;
    store.transition(inFlight, "redacting");

    expect(store.supersedeQueuedJobs(recordId, "rev_not_here")).toEqual([mine]);
    expect(rowOf(inFlight).status).toBe("redacting");
    expect(rowOf(otherQueued).status).toBe("queued");
  });

  it("幂等：再 supersede 一次返回空列表（已 canceled 的行不再候选）", () => {
    const old = enqueue().row.id;
    const edited = records.editRecord(recordId, `${RAW}（改一个字）`);
    store.supersedeQueuedJobs(recordId, edited.revision.id);
    expect(store.supersedeQueuedJobs(recordId, edited.revision.id)).toEqual([]);
    expect(rowOf(old).status).toBe("canceled");
  });

  it("查询面：get / findByIdempotencyKey / listForRecord / currentForRevision", () => {
    const first = enqueue().row.id;
    expect(store.get("pjob_absent")).toBeNull();
    expect(store.get(first)?.id).toBe(first);
    expect(store.findByIdempotencyKey("no-such-key")).toBeNull();

    const edited = records.editRecord(recordId, `${RAW}（改一个字）`);
    const second = enqueue(edited.revision.id).row.id;
    expect(store.listForRecord(recordId).map((row) => row.id)).toEqual([first, second]);
    expect(store.listForRecord("rec_absent")).toEqual([]);

    expect(store.currentForRevision(revisionId)?.id).toBe(first);
    expect(store.currentForRevision(edited.revision.id)?.id).toBe(second);
    // canceled 不代表「还要做的事」：currentForRevision 把它排除。
    store.requestCancel(second);
    expect(store.currentForRevision(edited.revision.id)).toBeNull();
  });
});

// ── G. 断言 8：FK 级联 ───────────────────────────────────────────────

describe("G. §八-8 删除 revision ⇒ 任务行级联消失（PRAGMA foreign_keys=ON）", () => {
  it("真删一行 revision，任务行随之消失；回滚则一行不少", () => {
    const { row } = enqueue();
    const grantsBefore = countRows(db, "privacy_job");
    expect(grantsBefore).toBe(1);
    expect((db.prepare("pragma foreign_keys").get() as { foreign_keys: number }).foreign_keys).toBe(1);

    db.exec("begin immediate");
    db.prepare("delete from record_revision where id = ?").run(revisionId);
    expect(store.get(row.id)).toBeNull();
    expect(countRows(db, "privacy_job")).toBe(0);
    db.exec("rollback");

    expect(countRows(db, "privacy_job")).toBe(1);
    expect(rowOf(row.id)).toEqual(row);
  });

  it("整条记录删掉（revision 随 CASCADE 消失）时任务行也不留；pragma_foreign_key_check 干净", () => {
    const edited = records.editRecord(recordId, `${RAW}（改一个字）`);
    enqueue();
    enqueue(edited.revision.id);
    expect(countRows(db, "privacy_job")).toBe(2);

    db.exec("begin immediate");
    db.prepare("delete from capture_record where id = ?").run(recordId);
    expect(countRows(db, "privacy_job")).toBe(0);
    db.exec("rollback");

    expect(countRows(db, "privacy_job")).toBe(2);
    expect(db.prepare("select * from pragma_foreign_key_check").all()).toEqual([]);
  });
});

// ── H. 断言 9：任务表不进导出、快照不含文本 ───────────────────────────

describe("H. §八-9 导出面：任务表不出现，快照只有 ID 与版本标识", () => {
  it("有任务行时导出一次：输出里不含 pjob_ 也不含 privacy_job", () => {
    // 一行 queued + 一行在途，各挂一条 revision：都挤在同一条 revision 上的话，后入队那次
    // 会把 queued 那行顶成 canceled，导出面就少了一种「还在排」的形状。
    const queued = enqueue().row.id;
    const inFlight = enqueue(freshRevision(), { ...VERSIONS, promptVersion: "p2" }).row.id;
    store.transition(inFlight, "redacting");
    expect(rowOf(queued).status).toBe("queued");
    expect(rowOf(inFlight).status).toBe("redacting");
    const dump = exportJsonl(db, { now: () => new Date(NOW) });

    expect(dump).not.toContain("pjob_");
    expect(dump).not.toContain("privacy_job");
    expect(dump).not.toContain("idempotency_key");
    expect(dump).not.toContain("snapshot_json");
    expect(dump).not.toContain("cancel_requested");
    // 导出本身照常工作：业务数据一个不少（排除是显式决定，不是漏）。
    expect(dump).toContain(RAW);
    expect(dump).toContain('"line":"capture_record"');
    expect(dump).toContain('"line":"record_revision"');
  });

  it("snapshot_json 的键集合恰好等于 JOB_SNAPSHOT_FIELDS，值全是取值标签", () => {
    const { row } = enqueue();
    const parsed = JSON.parse(row.snapshot_json) as Record<string, string>;
    expect(Object.keys(parsed)).toEqual([...JOB_SNAPSHOT_FIELDS]);
    expect(parsed.analysis_provider).toBe("cloud");
    expect(parsed.redaction_mode).toBe("manual");
    expect(parsed.send_content_mode).toBe("redacted");
    expect(parsed.prompt_version).toBe("m2-prompt-v1");
    expect(parsed.schema_version).toBe("m2-output-v1");
    expect(parsed.model_id).toBe("qwen2.5:7b");
    expect(parsed.redaction_policy_version).toBe("rules-v1");
    // 同配置 ⇒ 同文本（键序由封闭清单决定，快照因此可比对）。
    expect(row.snapshot_json).toBe(snapshotJson(snapshotFor(AXES, VERSIONS)));
  });

  it("快照与入参类型都不含文本字段：原文、脱敏文本、映射、占位符一个都进不来", () => {
    // 入参面：EnqueueInput 是封闭类型，下面这份字面量就是它全部的字段（多写一个文本字段编译不过）。
    const input: EnqueueInput = { recordRevisionId: revisionId, axes: AXES, versions: VERSIONS };
    expect(Object.keys(input).sort()).toEqual(["axes", "recordRevisionId", "versions"]);
    expect(Object.keys(input.axes).sort()).toEqual(["analysisProvider", "redactionMode", "sendContentMode"]);
    expect(Object.keys(input.versions).sort()).toEqual([
      "modelId",
      "promptVersion",
      "redactionPolicyVersion",
      "schemaVersion",
    ]);
    // 物理面：任何文本类字段名都不在快照清单里，任务行里也搜不到原文。
    const textish = /text|raw|span|map|placeholder|evidence|token|content_sha/i;
    for (const field of JOB_SNAPSHOT_FIELDS) expect(field, field).not.toMatch(textish);
    const { row } = enqueue();
    for (const needle of [RAW, "张三", "13800138000", "laowang@example.com", "spans", "redactionMap"]) {
      expect(JSON.stringify(row), needle).not.toContain(needle);
    }
  });

  it("迁移正文（去注释）里没有文本类列：表结构与快照都不承载内容本体", () => {
    for (const forbidden of ["raw_text", "redacted_text", "payload_text", "tokens", "evidence_text", "content_sha256"]) {
      expect(MIGRATION_0010_SQL, forbidden).not.toContain(forbidden);
    }
  });

  it("任务行不进删除审计的封闭集（0002 冻结，任务也不是用户业务对象）", () => {
    const objectTypes = migrationInListFor("deletion_audit", "object_type");
    // 先证明清单真抓到了（解析失败时 helper 抛，这里再钉一次它确实是一批业务对象表名），
    // 否则「不含 privacy_job」会因为空清单而空转通过。
    expect(objectTypes.length).toBeGreaterThan(0);
    expect(objectTypes).toContain("capture_record");
    expect(objectTypes).toContain("record_revision");
    expect(objectTypes).not.toContain("privacy_job");
  });
});

// ── I. §五 失败分类与退避 ────────────────────────────────────────────

describe("I. §五 consumesAttempt 与指数退避", () => {
  it("provider_unavailable / provider_loading 不消耗 attempts，其余三类消耗", () => {
    const notConsuming: JobErrorKind[] = ["provider_unavailable", "provider_loading"];
    const consuming: JobErrorKind[] = ["timeout", "invalid_output", "internal"];
    for (const kind of notConsuming) expect(consumesAttempt(kind), kind).toBe(false);
    for (const kind of consuming) expect(consumesAttempt(kind), kind).toBe(true);
    // 覆盖性：分类表的每个取值都判过，将来加第 6 类不会静默漏判。
    expect([...notConsuming, ...consuming].sort()).toEqual([...JOB_ERROR_KINDS].sort());
  });

  it("退避：基数 2s、逐步翻倍、封顶 2 分钟（口径 ≤ 5 分钟）", () => {
    expect(jobRetryBackoffMs(0)).toBe(JOB_RETRY_BACKOFF_BASE_MS);
    expect(jobRetryBackoffMs(1)).toBe(4_000);
    expect(jobRetryBackoffMs(2)).toBe(8_000);
    expect(jobRetryBackoffMs(3)).toBe(16_000);
    expect(JOB_RETRY_BACKOFF_BASE_MS).toBe(2_000);
    expect(JOB_RETRY_BACKOFF_CAP_MS).toBeLessThanOrEqual(5 * 60 * 1000);
    let previous = 0;
    for (const attempts of [0, 1, 2, 3, 4, 8, 16, 40, 100]) {
      const wait = jobRetryBackoffMs(attempts);
      expect(wait).toBeGreaterThanOrEqual(previous);
      expect(wait).toBeLessThanOrEqual(JOB_RETRY_BACKOFF_CAP_MS);
      previous = wait;
    }
    expect(jobRetryBackoffMs(40)).toBe(JOB_RETRY_BACKOFF_CAP_MS);
    expect(jobRetryBackoffMs(-3)).toBe(JOB_RETRY_BACKOFF_BASE_MS); // 负数不给出「负等待」
  });
});

// ── J. 记录级映射（口径 2：本批只交函数与全量覆盖测试）─────────────────

describe("J. §一-3 映射表：六个 jobStatus 一个不漏", () => {
  it("逐条对位草案 §一-3 的 preprocessing → processing → parsed/failed", () => {
    expect(recordProcessingStatusForJobStatus("queued")).toBe("preprocessing");
    expect(recordProcessingStatusForJobStatus("redacting")).toBe("processing");
    expect(recordProcessingStatusForJobStatus("analyzing")).toBe("processing");
    expect(recordProcessingStatusForJobStatus("done")).toBe("parsed");
    expect(recordProcessingStatusForJobStatus("failed")).toBe("failed");
    expect(recordProcessingStatusForJobStatus("canceled")).toBe("preprocessing");
  });

  it("全量覆盖：映射的定义域恰是六个 jobStatus，值域落在 enums 的 processing_statuses 内", () => {
    const covered = Object.keys(JOB_TO_RECORD_PROCESSING_STATUS).sort();
    expect(covered).toEqual([...JOB_STATUSES].sort());
    for (const status of JOB_STATUSES) {
      const mapped = recordProcessingStatusForJobStatus(status);
      expect(enums.processing_statuses, `${status} → ${mapped}`).toContain(mapped);
    }
    // 映射把「排队/取消」这类调度态收进三个在途与定案态，不落到 captured 那一类初态。
    // 集合声明成 Set<string>：下面两条要问的是「映射**不**落到那两个初态」，
    // 判据本身在集合之外，窄类型只会让这两条断言写不出来。
    const values = new Set<string>(JOB_STATUSES.map((status) => recordProcessingStatusForJobStatus(status)));
    expect([...values].sort()).toEqual(["failed", "parsed", "preprocessing", "processing"]);
    expect(values.has("awaiting_privacy_review")).toBe(false);
    expect(values.has("not_processed")).toBe(false);
  });

  it("映射是纯函数：同入同出，不读库也不写库", () => {
    const { row } = enqueue();
    const recordRowBefore = db.prepare("select * from capture_record where id = ?").get(recordId);
    for (const status of JOB_STATUSES) {
      expect(recordProcessingStatusForJobStatus(status)).toBe(recordProcessingStatusForJobStatus(status));
    }
    expect(db.prepare("select * from capture_record where id = ?").get(recordId)).toEqual(recordRowBefore);
    expect(rowOf(row.id)).toEqual(row);
  });
});

// ── K. 存储层的隔离面（禁区）─────────────────────────────────────────

describe("K. 本批不接线：只写 privacy_job，只读 record_revision 的 id", () => {
  it("源码里没有任何对 capture_record / record_revision / parse_run 的写语句", () => {
    const source = readFileSync("src/server/jobs/jobStore.ts", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(source).not.toMatch(/update\s+capture_record/i);
    expect(source).not.toMatch(/update\s+record_revision/i);
    expect(source).not.toMatch(/insert\s+into\s+record_revision/i);
    expect(source).not.toMatch(/(update|insert\s+into|delete\s+from)\s+parse_run/i);
    expect(source).not.toMatch(/delete\s+from\s+privacy_job/i); // 删除只由 FK CASCADE 发生
    expect(source).not.toMatch(/console\.|process\.stdout|node:http|node:net|fetch\(/);
  });

  it("跑完一次完整生命周期后，记录级状态与既有表一行都没变（不接线是实测事实）", () => {
    const recordBefore = db.prepare("select * from capture_record where id = ?").get(recordId);
    const revisionCountBefore = countRows(db, "record_revision");
    const runCountBefore = countRows(db, "parse_run");

    const { row } = enqueue();
    store.claimNextRunnable();
    store.transition(row.id, "analyzing", { attemptsDelta: 1 });
    store.transition(row.id, "done");

    expect(db.prepare("select * from capture_record where id = ?").get(recordId)).toEqual(recordBefore);
    expect((row as JobRow).status).toBe("queued"); // enqueue 的返回值是入队那一刻的形状
    expect(rowOf(row.id).status).toBe("done");
    expect(countRows(db, "record_revision")).toBe(revisionCountBefore);
    expect(countRows(db, "parse_run")).toBe(runCountBefore);
  });
});
