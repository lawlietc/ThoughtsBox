import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { migrate } from "../src/server/db/migrator.ts";
import { seedVocabulary } from "../src/server/db/seed.ts";
import { RecordService, buildTimestamps } from "../src/server/records/service.ts";
import {
  collectKnownEntities,
  redact,
  type KnownEntity,
} from "../src/server/privacy/redaction.ts";
import {
  ConceptResolver,
  RESOLVER_VERSION,
} from "../src/server/ingest/resolver.ts";
import {
  IngestService,
  IngestInputError,
  IngestStateError,
  RedactionMapRequiredError,
  RunNotAdoptableError,
  assertStateTransition,
  isStateTransitionAllowed,
  stateMachine,
  type StateMachineName,
} from "../src/server/ingest/ingestService.ts";
import { ProcessingModeError, PARSE_ERROR_KINDS } from "../src/server/ingest/provider.ts";
import type { ProviderCallPath, ProviderTransport, TransportRequest, TransportResponse } from "../src/server/ingest/provider.ts";
import { TraceSession } from "../src/server/ingest/trace.ts";
import { CorrectionService, CollectionAddViaPatchError, DetachConfirmationRequiredError } from "../src/server/correction/service.ts";
import { loadContracts } from "../src/shared/contracts/load.ts";
import { newId, seedConceptId } from "../src/shared/contracts/ids.ts";
import { countRows, makeSandbox, openSandboxDb, type Sandbox } from "./helpers/sandbox.ts";
import {
  ANXIETY_CONCEPT,
  CLOUD_RAW,
  FIXTURE_NOW,
  FIXTURE_TIMEZONE,
  LOCAL_RAW,
  OK_ENVELOPE,
  SYSTEM_PROMPT,
  WORK_CONCEPT,
  createRecord,
  envelope,
  makeAdapter,
  stubTransport,
  validOutput,
} from "./helpers/ingestFixtures.ts";
import type { Database } from "../src/server/db/adapter.ts";
import type { IngestServiceOptions } from "../src/server/ingest/ingestService.ts";

/**
 * M2-5 Ingest 服务面（D12 + 编排门）。
 *
 * 契约依据：Schema §3.7（当前视图 join）/ §3.19（候选采纳制）/ §4.7（ParseRun 双态）/
 * §4.8（处理状态机）/ §7.4（修正持久化与防复活）、Spec §3.2.3 / §5.4、指令 §8.1–§8.4 / §9.1，
 * 以及 M2-4 复审裁决 2（降级留痕单一表示）与裁决 3（`cloud_redacted` 必带脱敏映射）。
 *
 * 覆盖的必过断言：T-05、T-06（服务面）、T-18、T-19、T-20（detach 面）、T-30（服务面）、
 * 解析器三步顺序（D10）。崩溃幂等 T-04 在 `m2-idempotency.test.ts`，证据回锚 T-27 在
 * `m2-evidence.test.ts`。
 *
 * T-06/T-20/T-30 的服务面断言写在**本文件**而不是 `m2-correction.test.ts`：后者头注自陈
 * 「服务层的 add 拒绝（T-30）、采纳时的 object_id 迁移归 M2-5，不在本 DB 面断言」，
 * 且本任务不得改写既有断言——新增测试文件是零风险的位置。
 *
 * 全程离线：模型调用由注入的假 Transport 驱动。
 */

const CONTRACTS = loadContracts();
const HEX64 = "0123456789abcdef".repeat(4);
const CLOUD_BASE_URL = "https://cloud.example.com/v1";

const MANIFEST = JSON.stringify({
  prompt: "m2-prompt-v1",
  schema: "m2-output-v1",
  model: "qwen2.5:7b",
  provider: "ollama",
  params: {},
  redaction: "rules-v1",
  redactionMap: null,
  resolver: RESOLVER_VERSION,
  validation: "validation-v1",
});

let sandbox: Sandbox;
let db: Database;
let revisionId: string;
let recordId: string;

beforeEach(() => {
  sandbox = makeSandbox("tb-m2-5-svc-");
  db = openSandboxDb(sandbox.layout);
  migrate(db);
  seedVocabulary(db);
  const created = createRecord(db, LOCAL_RAW, "local_model");
  recordId = created.recordId;
  revisionId = created.revisionId;
});

afterEach(() => {
  db.close();
  sandbox.cleanup();
});

type ServiceOverrides = Partial<Omit<IngestServiceOptions, "db">>;

function makeService(overrides: ServiceOverrides = {}): IngestService {
  const options: IngestServiceOptions = {
    db,
    adapter: makeAdapter(),
    transport: stubTransport(OK_ENVELOPE(validOutput())).transport,
    systemPrompt: SYSTEM_PROMPT,
    now: () => new Date(FIXTURE_NOW),
    ...overrides,
  };
  return new IngestService(options);
}

/** 一次本地成功解析的默认夹具（含调用计数，供「零调用」类断言用）。 */
function localStub(
  output = validOutput(),
  overrides: ServiceOverrides = {},
): { service: IngestService; stub: ReturnType<typeof stubTransport> } {
  const stub = stubTransport(OK_ENVELOPE(output));
  return { service: makeService({ ...overrides, transport: stub.transport }), stub };
}

function selectIds(sql: string, ...params: unknown[]): string[] {
  return (db.prepare(sql).all(...(params as never[])) as Array<{ id: string }>).map((row) => row.id);
}

function statusOf(table: string, id: string): string {
  const column = table === "parse_run" ? "result_state" : table.endsWith("mention") ? "status" : "lifecycle_status";
  const row = db.prepare(`select ${column} as s from ${table} where id = ?`).get(id) as { s: string };
  return row.s;
}

function textOf(table: string, id: string, column: string): string {
  const row = db.prepare(`select ${column} as v from ${table} where id = ?`).get(id) as { v: string };
  return row.v;
}

function valueOf(table: string, id: string, column: string): unknown {
  const row = db.prepare(`select ${column} as v from ${table} where id = ?`).get(id) as { v: unknown };
  return row.v;
}

function recordStatus(): string {
  return (db.prepare("select processing_status as s from capture_record where id = ?").get(recordId) as { s: string }).s;
}

/** 库里直插一条 run 行（T-05 的非法组合只能这样造，服务层不会造它们）。 */
function insertRunRow(
  id: string,
  over: { readonly execution_status: string; readonly result_state: string; readonly key: string; readonly fingerprint?: string; readonly revision?: string },
): void {
  db.prepare(
    `insert into parse_run
       (id, source_revision_id, pipeline_manifest, pipeline_fingerprint, idempotency_key,
        execution_status, result_state, started_at_utc)
     values (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, over.revision ?? revisionId, MANIFEST, over.fingerprint ?? HEX64, over.key, over.execution_status, over.result_state, FIXTURE_NOW);
}

/** 期望被拒：写入包在显式事务里，无论成败都回滚，夹具现场不留脏行。 */
function expectRejected(statement: () => void, pattern: RegExp): void {
  db.exec("begin immediate");
  let thrown: Error | undefined;
  try {
    statement();
  } catch (cause) {
    thrown = cause as Error;
  } finally {
    db.exec("rollback");
  }
  expect(thrown, `期望被拒但写入成功：${pattern.source}`).toBeDefined();
  expect(thrown?.message).toMatch(pattern);
}

function expectAccepted(statement: () => void): void {
  db.exec("begin immediate");
  try {
    statement();
  } finally {
    db.exec("rollback");
  }
}

// ── 闸门 ────────────────────────────────────────────────────────────

describe("闸门：不该发出的请求，物理上是零次调用、零行写入", () => {
  it("manual_only：不调用任何模型、不建 run 行、记录态原地不动", async () => {
    db.prepare("update capture_record set processing_mode = 'manual_only' where id = ?").run(recordId);
    const stub = stubTransport(OK_ENVELOPE(validOutput()));
    const service = makeService({ transport: stub.transport });
    let thrown: unknown;
    try {
      await service.ingest({ recordRevisionId: revisionId });
    } catch (cause) {
      thrown = cause;
    }
    expect(thrown).toBeInstanceOf(ProcessingModeError);
    expect((thrown as ProcessingModeError).reason).toBe("manual_only");
    expect(stub.callCount()).toBe(0);
    expect(countRows(db, "parse_run")).toBe(0);
    expect(countRows(db, "episode")).toBe(0);
    expect(recordStatus()).toBe("captured");
  });

  it("裁决 h：cloud_redacted 缺本次脱敏映射 ⇒ 发起调用之前即拒，零调用零写入", async () => {
    db.prepare("update capture_record set processing_mode = 'cloud_redacted' where id = ?").run(recordId);
    const stub = stubTransport(OK_ENVELOPE(validOutput()));
    const service = makeService({
      adapter: makeAdapter({ baseUrl: CLOUD_BASE_URL }),
      transport: stub.transport,
      grantCheck: () => {},
    });
    let thrown: unknown;
    try {
      // 只给载荷、不给映射：Provider 层的 redactionMap 是可选的，门必须由编排层补。
      await service.ingest({ recordRevisionId: revisionId, payloadText: "脱敏后的载荷" });
    } catch (cause) {
      thrown = cause;
    }
    expect(thrown).toBeInstanceOf(RedactionMapRequiredError);
    expect((thrown as RedactionMapRequiredError).recordRevisionId).toBe(revisionId);
    expect(stub.callCount()).toBe(0);
    expect(countRows(db, "parse_run")).toBe(0);
    expect(recordStatus()).toBe("captured");
  });

  it("裁决 h 反向对照：两个本地模式不受映射门约束（local_model 无映射照常走完）", async () => {
    const { service, stub } = localStub();
    const result = await service.ingest({ recordRevisionId: revisionId });
    expect(result.succeeded).toBe(true);
    expect(result.processingMode).toBe("local_model");
    expect(stub.requests[0]?.body["messages"]).toBeDefined();
    expect(countRows(db, "parse_run")).toBe(1);
  });

  it("cloud_redacted 缺授权闸门 ⇒ 零调用；授权闸门抛 ⇒ 同样零调用零写入", async () => {
    db.prepare("update capture_record set processing_mode = 'cloud_redacted' where id = ?").run(recordId);
    const { map, redactedText } = redact(CLOUD_RAW, collectKnownEntities(db), { nonce: "cafe01" });
    const withoutGate = makeService({ adapter: makeAdapter({ baseUrl: CLOUD_BASE_URL }) });
    await expect(withoutGate.ingest({ recordRevisionId: revisionId, payloadText: redactedText, redactionMap: map })).rejects.toBeInstanceOf(IngestInputError);
    expect(countRows(db, "parse_run")).toBe(0);

    const denied = stubTransport(OK_ENVELOPE(validOutput()));
    const service = makeService({
      adapter: makeAdapter({ baseUrl: CLOUD_BASE_URL }),
      transport: denied.transport,
      grantCheck: () => {
        throw new Error("本次授权不存在或已过期");
      },
    });
    await expect(service.ingest({ recordRevisionId: revisionId, payloadText: redactedText, redactionMap: map })).rejects.toThrow(/授权/);
    expect(denied.callCount()).toBe(0);
    expect(countRows(db, "parse_run")).toBe(0);
  });

  it("模式是记录在册的用户设置：显式传入与在册值不一致即拒，且不发请求", async () => {
    const stub = stubTransport(OK_ENVELOPE(validOutput()));
    const service = makeService({ transport: stub.transport });
    await expect(service.ingest({ recordRevisionId: revisionId, processingMode: "cloud_redacted" })).rejects.toBeInstanceOf(IngestInputError);
    expect(stub.callCount()).toBe(0);
    expect(countRows(db, "parse_run")).toBe(0);
    // 与在册值一致不算越权：同一件事再说一遍，放行。
    const ok = await service.ingest({ recordRevisionId: revisionId, processingMode: "local_model" });
    expect(ok.processingMode).toBe("local_model");
  });

  it("解析只针对记录的当前版本：老 revision 直接拒，不建 run 行", async () => {
    const records = new RecordService(db, { timezoneId: "Asia/Shanghai", now: () => new Date(FIXTURE_NOW) });
    const edited = records.editRecord(recordId, `${LOCAL_RAW}，我打算明天定稿。`);
    expect(edited.changed).toBe(true);
    const stub = stubTransport(OK_ENVELOPE(validOutput()));
    const service = makeService({ transport: stub.transport });
    await expect(service.ingest({ recordRevisionId: revisionId })).rejects.toThrow(/current_revision/);
    expect(stub.callCount()).toBe(0);
    expect(countRows(db, "parse_run")).toBe(0);
    // 新版本才是可解析对象。
    const fresh = await service.ingest({ recordRevisionId: edited.revision.id });
    expect(fresh.succeeded).toBe(true);
  });
});

// ── T-05 ────────────────────────────────────────────────────────────

describe("T-05：parse_run 双态的合法/非法组合与采纳的原子切换", () => {
  it("§4.7 组合 CHECK：queued/running 只能挂 candidate，四种非法搭配逐一被拒", () => {
    for (const [execution_status, result_state] of [
      ["queued", "current"],
      ["queued", "superseded"],
      ["running", "current"],
      ["running", "superseded"],
    ] as const) {
      expectRejected(
        () => insertRunRow(`run_bad_${execution_status}_${result_state}`, {
          execution_status,
          result_state,
          key: `k_bad_${execution_status}_${result_state}`,
        }),
        /CHECK constraint failed/,
      );
    }
    for (const [execution_status, result_state] of [
      ["queued", "candidate"],
      ["running", "candidate"],
      ["failed", "candidate"],
      ["succeeded", "current"],
      ["succeeded", "candidate"],
      ["succeeded", "superseded"],
      ["failed", "superseded"],
    ] as const) {
      expectAccepted(() =>
        insertRunRow(`run_ok_${execution_status}_${result_state}`, {
          execution_status,
          result_state,
          key: `k_ok_${execution_status}_${result_state}`,
        }),
      );
    }
  });

  it("current 必须 succeeded、failed 不得 current（第三、四条组合不变式）", () => {
    expectRejected(
      () => insertRunRow("run_failed_current", { execution_status: "failed", result_state: "current", key: "k_failed_current" }),
      /CHECK constraint failed/,
    );
  });

  it("ux_run_current：同一 revision 的第二条 current 被拒（双 current 不可能出现）", () => {
    insertRunRow("run_first_current", { execution_status: "succeeded", result_state: "current", key: "k_first_current", fingerprint: "a".repeat(64) });
    expectRejected(
      () =>
        insertRunRow("run_second_current", {
          execution_status: "succeeded",
          result_state: "current",
          key: "k_second_current",
          fingerprint: "b".repeat(64),
        }),
      /UNIQUE constraint failed/,
    );
    // 另一条 revision 上的 current 与它无关：局部唯一索引按 revision 分组。
    const other = createRecord(db, "另一条记录，同样需要一个当前解析结果。", "local_model");
    expectAccepted(() =>
      insertRunRow("run_other_current", {
        execution_status: "succeeded",
        result_state: "current",
        key: "k_other_current",
        revision: other.revisionId,
      }),
    );
  });

  it("ux_run_live：同 (revision, fingerprint) 的第二条 live run 被拒；不同 fingerprint 放行", () => {
    insertRunRow("run_live_a", { execution_status: "succeeded", result_state: "current", key: "k_live_a", fingerprint: HEX64 });
    expectRejected(
      () => insertRunRow("run_live_b", { execution_status: "running", result_state: "candidate", key: "k_live_b", fingerprint: HEX64 }),
      /UNIQUE constraint failed/,
    );
    expectAccepted(() =>
      insertRunRow("run_live_c", {
        execution_status: "running",
        result_state: "candidate",
        key: "k_live_c",
        fingerprint: "c".repeat(64),
      }),
    );
  });

  it("adoptCurrent：旧 current→superseded 与新 candidate→current 原子切换，恒只有一条 current", async () => {
    const first = localStub();
    const a = await first.service.ingest({ recordRevisionId: revisionId });
    expect(first.service.adoptCurrent({ candidateRunId: a.runId }).supersededRunId).toBeNull();
    expect(statusOf("parse_run", a.runId)).toBe("current");

    const second = makeService({ promptVersion: "m2-prompt-v2", transport: stubTransport(OK_ENVELOPE(validOutput())).transport });
    const b = await second.ingest({ recordRevisionId: revisionId });
    expect(statusOf("parse_run", b.runId)).toBe("candidate");

    const swapped = second.adoptCurrent({ candidateRunId: b.runId });
    expect(swapped).toEqual({ supersededRunId: a.runId, adoptedRunId: b.runId });
    expect(statusOf("parse_run", a.runId)).toBe("superseded");
    expect(statusOf("parse_run", b.runId)).toBe("current");
    const currents = selectIds("select id from parse_run where source_revision_id = ? and result_state = 'current'", revisionId);
    expect(currents).toEqual([b.runId]);
    expect(db.prepare("select execution_status as s from parse_run where id = ?").get(b.runId)).toEqual({ s: "succeeded" });
  });

  it("采纳中途失败 ⇒ 整个事务回滚：候选没被抬、旧 current 没被动、旧行没被 supersede", async () => {
    const first = localStub();
    const a = await first.service.ingest({ recordRevisionId: revisionId });
    first.service.adoptCurrent({ candidateRunId: a.runId });
    const second = makeService({ promptVersion: "m2-prompt-v2", transport: stubTransport(OK_ENVELOPE(validOutput())).transport });
    const b = await second.ingest({ recordRevisionId: revisionId });
    const oldEpisode = selectIds("select id from episode where parse_run_id = ?", a.runId);
    expect(oldEpisode.length).toBe(1);

    // 迁移一条不存在的 override：migrateOverride 在同一个事务里抛，两侧的状态迁移必须一起撤销。
    expect(() =>
      second.adoptCurrent({
        candidateRunId: b.runId,
        overrideMigrations: [{ objectTable: "episode", fromObjectId: "ep_missing", toObjectId: oldEpisode[0]!, fieldName: "summary" }],
      }),
    ).toThrow(/没有可迁移的 override/);

    expect(statusOf("parse_run", a.runId)).toBe("current");
    expect(statusOf("parse_run", b.runId)).toBe("candidate");
    expect(statusOf("episode", oldEpisode[0]!)).toBe("active");
    expect(recordStatus()).toBe("parsed");
  });

  it("只有 succeeded 的 candidate 可被采纳；failed 或非 candidate 被拒", async () => {
    const { service } = localStub();
    const ok = await service.ingest({ recordRevisionId: revisionId });
    service.adoptCurrent({ candidateRunId: ok.runId });
    expect(() => service.adoptCurrent({ candidateRunId: ok.runId })).toThrow(RunNotAdoptableError);

    // 换一个指纹：同一 (revision, fingerprint) 的同键请求会被认成**重放**（上面那条 run 已经
    // succeeded/current），拿不到「failed 的 run」这一形态。指纹不同才是新 run。
    const failedService = makeService({
      promptVersion: "m2-prompt-v5",
      transport: { send: async () => ({ status: 503, body: "{}" }) },
    });
    const failed = await failedService.ingest({ recordRevisionId: revisionId });
    expect(failed.succeeded).toBe(false);
    expect(() => failedService.adoptCurrent({ candidateRunId: failed.runId })).toThrow(/执行成功/);
    // 放弃候选：candidate→superseded，历史保留。
    const second = makeService({ promptVersion: "m2-prompt-v3", transport: stubTransport(OK_ENVELOPE(validOutput())).transport });
    const c = await second.ingest({ recordRevisionId: revisionId });
    second.discardCandidate(c.runId);
    expect(statusOf("parse_run", c.runId)).toBe("superseded");
    expect(() => second.discardCandidate(c.runId)).toThrow(RunNotAdoptableError);
  });
});

// ── T-18 ────────────────────────────────────────────────────────────

describe("T-18：状态机合法/非法转换（§4.7 双态 + §4.8 处理态）", () => {
  const machines: readonly StateMachineName[] = [
    "ParseRun.execution_status",
    "ParseRun.result_state",
    "Mention.status",
    "Episode.lifecycle_status",
    "ThoughtItem.lifecycle_status",
    "processing_status",
  ];

  it("enums.json 在册的每一条边都被服务认账（单一事实源，不抄第二份表）", () => {
    for (const name of machines) {
      const spec = stateMachine(name, CONTRACTS.enums);
      for (const [from, targets] of Object.entries(spec.transitions)) {
        for (const to of targets) {
          expect(isStateTransitionAllowed(name, from, to, CONTRACTS.enums), `${name} ${from}→${to}`).toBe(true);
        }
      }
    }
  });

  it("未在册的转换一律拒，包括看似合理的捷径", () => {
    const illegal: readonly [StateMachineName, string, string][] = [
      ["ParseRun.execution_status", "succeeded", "running"],
      ["ParseRun.execution_status", "succeeded", "failed"],
      ["ParseRun.execution_status", "queued", "succeeded"],
      ["ParseRun.execution_status", "failed", "succeeded"],
      ["ParseRun.execution_status", "running", "queued"],
      ["ParseRun.result_state", "superseded", "current"],
      ["ParseRun.result_state", "current", "candidate"],
      ["Mention.status", "rejected", "active"],
      ["Mention.status", "superseded", "active"],
      ["Episode.lifecycle_status", "superseded", "active"],
      ["processing_status", "captured", "processing"],
      ["processing_status", "parsed", "processing"],
      ["processing_status", "processing", "preprocessing"],
    ];
    for (const [name, from, to] of illegal) {
      expect(isStateTransitionAllowed(name, from, to, CONTRACTS.enums), `${name} ${from}→${to}`).toBe(false);
      expect(() => assertStateTransition(name, from, to, CONTRACTS.enums)).toThrow(IngestStateError);
    }
    // 对照：candidate→superseded 在册且合法，证明上面的清单不是「全都拒」的假断言。
    expect(isStateTransitionAllowed("ParseRun.result_state", "candidate", "superseded", CONTRACTS.enums)).toBe(true);
  });

  it("§4.8：一次真实解析走完 captured→preprocessing→processing→parsed", async () => {
    expect(recordStatus()).toBe("captured");
    const { service } = localStub();
    // 观察中间态：闸门阶段之后记录态是 processing，用 trace 的时序做外证不方便，这里分两步跑。
    const run = service.beginRun({ recordRevisionId: revisionId });
    expect(recordStatus()).toBe("processing");
    const result = await service.ingest({ recordRevisionId: revisionId });
    expect(result.runId).toBe(run.runId);
    expect(recordStatus()).toBe("parsed");
  });

  it("重跑已 parsed 的记录：parsed→needs_reparse→preprocessing→processing→parsed（没有捷径边可用）", async () => {
    const first = localStub();
    await first.service.ingest({ recordRevisionId: revisionId });
    expect(recordStatus()).toBe("parsed");
    const second = makeService({ promptVersion: "m2-prompt-v9", transport: stubTransport(OK_ENVELOPE(validOutput())).transport });
    const result = await second.ingest({ recordRevisionId: revisionId });
    expect(result.succeeded).toBe(true);
    expect(recordStatus()).toBe("parsed");
    expect(isStateTransitionAllowed("processing_status", "parsed", "processing", CONTRACTS.enums)).toBe(false);
  });

  it("失败把记录推进到 failed，重跑从 failed→preprocessing 起锚", async () => {
    const failing = makeService({ transport: { send: async () => ({ status: 500, body: "{}" }) } });
    const result = await failing.ingest({ recordRevisionId: revisionId });
    expect(result.succeeded).toBe(false);
    expect(recordStatus()).toBe("failed");
    const retry = makeService({ transport: stubTransport(OK_ENVELOPE(validOutput())).transport });
    const again = await retry.ingest({ recordRevisionId: revisionId });
    expect(again.succeeded).toBe(true);
    expect(recordStatus()).toBe("parsed");
  });

  it("error_kind 只在封闭集内：失败落 network，成功清成 NULL", async () => {
    const failing = makeService({ transport: { send: async () => ({ status: 429, body: "{}" }) } });
    const result = await failing.ingest({ recordRevisionId: revisionId });
    const row = failing.readRun(result.runId);
    expect(row?.error_kind).toBe("network");
    expect((PARSE_ERROR_KINDS as readonly string[]).includes(String(row?.error_kind))).toBe(true);
    const retry = makeService({ transport: stubTransport(OK_ENVELOPE(validOutput())).transport });
    const ok = await retry.ingest({ recordRevisionId: revisionId });
    expect(retry.readRun(ok.runId)?.error_kind).toBeNull();
    // 库里同样不收封闭集之外的取值（服务层的分类不是建议）。
    expectRejected(
      () =>
        db
          .prepare(
            `insert into parse_run (id, source_revision_id, pipeline_manifest, pipeline_fingerprint, idempotency_key,
                                    execution_status, result_state, error_kind, started_at_utc)
             values ('run_set_bad', ?, ?, ?, 'k_set_bad', 'failed', 'candidate', 'model_refused', ?)`,
          )
          .run(revisionId, MANIFEST, "d".repeat(64), FIXTURE_NOW),
      /CHECK constraint failed/,
    );
  });

  it("库里非法的 result_state 取值被 CHECK 拒（封闭集不是注释）", () => {
    expectRejected(
      () =>
        db.prepare(
          `insert into parse_run (id, source_revision_id, pipeline_manifest, pipeline_fingerprint, idempotency_key, execution_status, result_state, started_at_utc)
           values ('run_bad_state', ?, ?, ?, 'k_bad_state', 'queued', 'adopted', ?)`,
        ).run(revisionId, MANIFEST, "e".repeat(64), FIXTURE_NOW),
      /CHECK constraint failed/,
    );
  });
});

// ── T-19 ────────────────────────────────────────────────────────────

describe("T-19：候选永不进入当前视图，采纳只换那一套行", () => {
  it("候选 run 的派生行在库里，但 §3.7 join 看不见它", async () => {
    const { service } = localStub();
    const result = await service.ingest({ recordRevisionId: revisionId });
    expect(result.writes.episodes).toBe(1);
    expect(selectIds("select id from episode where parse_run_id = ?", result.runId).length).toBe(1);
    const view = service.currentView(revisionId);
    expect(view.currentRunId).toBeNull();
    expect(view.episodes).toEqual([]);
    expect(view.thoughts).toEqual([]);
    expect(view.emotions).toEqual([]);
    expect(view.topics).toEqual([]);
    expect(view.candidates.map((row) => row.runId)).toEqual([result.runId]);
  });

  it("采纳后当前视图恰好是新 run 的那一套行（逐 id 集合相等，不多不少）", async () => {
    const first = localStub();
    const a = await first.service.ingest({ recordRevisionId: revisionId });
    first.service.adoptCurrent({ candidateRunId: a.runId });
    const viewA = first.service.currentView(revisionId);
    expect(viewA.currentRunId).toBe(a.runId);
    expect(viewA.episodes).toEqual(selectIds("select id from episode where parse_run_id = ?", a.runId));
    expect(viewA.emotions).toEqual(selectIds("select id from emotion_mention where parse_run_id = ?", a.runId));
    expect(viewA.topics).toEqual(selectIds("select id from topic_mention where parse_run_id = ?", a.runId));

    const second = makeService({ promptVersion: "m2-prompt-v2", transport: stubTransport(OK_ENVELOPE(validOutput())).transport });
    const b = await second.ingest({ recordRevisionId: revisionId });
    second.adoptCurrent({ candidateRunId: b.runId });

    const viewB = second.currentView(revisionId);
    expect(viewB.currentRunId).toBe(b.runId);
    expect(viewB.episodes).toEqual(selectIds("select id from episode where parse_run_id = ?", b.runId));
    expect(viewB.episodes).not.toEqual(viewA.episodes);
    // 旧 run 的行整批转 superseded：不是被删、也不是被改写内容。
    expect(selectIds("select id from episode where parse_run_id = ?", a.runId).length).toBe(1);
    expect(statusOf("episode", viewA.episodes[0]!)).toBe("superseded");
    expect(statusOf("emotion_mention", viewA.emotions[0]!)).toBe("superseded");
    expect(db.prepare("select count(*) as n from episode").get()).toEqual({ n: 2 });
    expect(textOf("episode", viewA.episodes[0]!, "summary")).toBe(textOf("episode", viewB.episodes[0]!, "summary"));
  });

  it("带用户修正的旧行绝不被动（§3.19 第 2 步），其余旧行照常转 superseded", async () => {
    const first = localStub();
    const a = await first.service.ingest({ recordRevisionId: revisionId });
    first.service.adoptCurrent({ candidateRunId: a.runId });
    const corrections = new CorrectionService(db, { now: () => new Date(FIXTURE_NOW) });
    const touchedEpisode = first.service.currentView(revisionId).episodes[0]!;
    const untouchedThought = first.service.currentView(revisionId).thoughts[0]!;
    corrections.setOverride({ objectTable: "episode", objectId: touchedEpisode, fieldName: "summary", valueJson: '"我自己写的摘要"' });

    const second = makeService({ promptVersion: "m2-prompt-v2", transport: stubTransport(OK_ENVELOPE(validOutput())).transport });
    const b = await second.ingest({ recordRevisionId: revisionId });
    second.adoptCurrent({ candidateRunId: b.runId });

    expect(statusOf("episode", touchedEpisode)).toBe("active");
    expect(statusOf("thought_item", untouchedThought)).toBe("superseded");
    // override 不回写基表（ADR-011）：基表 summary 仍是 AI 那份，投影后才换成用户那份。
    const base = db.prepare("select summary as s from episode where id = ?").get(touchedEpisode) as { s: string };
    expect(base.s).not.toBe("我自己写的摘要");
    const projected = corrections.projectEffective("episode", { id: touchedEpisode, summary: base.s });
    expect(projected.summary).toBe("我自己写的摘要");
  });

  it("采纳时经用户确认的 override 才迁移指向；未确认的留在原行", async () => {
    const first = localStub();
    const a = await first.service.ingest({ recordRevisionId: revisionId });
    first.service.adoptCurrent({ candidateRunId: a.runId });
    const corrections = new CorrectionService(db, { now: () => new Date(FIXTURE_NOW) });
    const oldEpisode = first.service.currentView(revisionId).episodes[0]!;
    corrections.setOverride({ objectTable: "episode", objectId: oldEpisode, fieldName: "summary", valueJson: '"修正后的摘要"' });

    const second = makeService({ promptVersion: "m2-prompt-v2", transport: stubTransport(OK_ENVELOPE(validOutput())).transport });
    const b = await second.ingest({ recordRevisionId: revisionId });
    const newEpisode = selectIds("select id from episode where parse_run_id = ?", b.runId)[0]!;
    second.adoptCurrent({
      candidateRunId: b.runId,
      overrideMigrations: [{ objectTable: "episode", fromObjectId: oldEpisode, toObjectId: newEpisode, fieldName: "summary" }],
    });

    expect(corrections.overridesFor("episode", oldEpisode)).toEqual([]);
    const moved = corrections.overridesFor("episode", newEpisode);
    expect(moved.length).toBe(1);
    expect(moved[0]?.value_json).toBe('"修正后的摘要"');
  });

  it("用户自建行（无 run）恒在当前视图——§3.7 左腿不因存在 current run 而失效", async () => {
    const corrections = new CorrectionService(db, { now: () => new Date(FIXTURE_NOW) });
    const { service } = localStub();
    const a = await service.ingest({ recordRevisionId: revisionId });
    service.adoptCurrent({ candidateRunId: a.runId });
    expect(service.currentView(revisionId).currentRunId).toBe(a.runId);

    // 左腿的另一半：用户在同一 revision 上手工新增的 thought（origin_type='user_created'，无 run）。
    // 注意 0003 的形状不对称：episode 的 CHECK 把 user_created 钉成「无来源 revision」，
    // 所以事件行的左腿在库里根本造不出来（§3.20 的 detach 正是因此只能零引用）；
    // thought_item 与三类 Mention 的 CHECK 允许 user_created 挂 revision，§3.7 左腿由它们承担。
    const ownThought = newId("thoughtItem");
    db.prepare(
      `insert into thought_item
         (id, text, source_record_revision_id, source_episode_id, parse_run_id,
          origin_type, lifecycle_status, evidence_text, evidence_start, evidence_end, created_at_utc)
       values (?, '用户手写的想法', ?, NULL, NULL, 'user_created', 'active', '', NULL, NULL, ?)`,
    ).run(ownThought, revisionId, FIXTURE_NOW);

    const own = corrections.addUserMention({
      collection: "emotions",
      source: { kind: "revision", id: revisionId },
      memberId: ANXIETY_CONCEPT,
      labelSaid: "焦虑",
    });

    const view = service.currentView(revisionId);
    expect(view.emotions).toContain(own);
    expect(view.thoughts).toContain(ownThought);
    for (const derived of selectIds("select id from episode where parse_run_id = ?", a.runId)) {
      expect(view.episodes).toContain(derived);
    }
  });

  it("§3.7 第三腿〔M3-DB-2 补票，§四-5 裁决=补腿〕：user_confirmed_suggestion 且无 run ⇒ 当前视图可见", async () => {
    // 〔改向·DB-2〕本条原文断言的是「按冻结 §3.7 两腿字面执行 ⇒ 确认过的建议行不可见」这一存疑事实
    // （原文与理由逐字登记在 worklog 2026-10-17-M3-db-2-schema-backfill.md）。DB-2 裁定补第三腿后，
    // 这里的语义**必然**翻转：不是削弱，是收紧——同一批断言同时钉住旧两腿逐字不变：
    //   左腿 user_created 恒可见；右腿 current run 的派生行采纳后才可见。
    // 补腿没有打开候选门，这一点由「ingest 后 not.toContain、adopt 后 toContain」成对证明。
    const id = newId("emotionMention");
    db.prepare(
      `insert into emotion_mention
         (id, concept_id, source_record_revision_id, parse_run_id, label_said,
          evidence_text, evidence_start, evidence_end, origin_type, basis, created_at_utc)
       values (?, ?, ?, NULL, '焦虑', '', NULL, NULL, 'user_confirmed_suggestion', 'explicit', ?)`,
    ).run(id, ANXIETY_CONCEPT, revisionId, FIXTURE_NOW);

    const { service } = localStub();
    expect(service.currentView(revisionId).emotions).toContain(id);
    expect(countRows(db, "emotion_mention")).toBe(1);

    // 左腿逐字不变：user_created 且无 run。
    const userCreated = newId("emotionMention");
    db.prepare(
      `insert into emotion_mention
         (id, concept_id, source_record_revision_id, parse_run_id, label_said,
          evidence_text, evidence_start, evidence_end, origin_type, basis, created_at_utc)
       values (?, ?, ?, NULL, '焦虑', '', NULL, NULL, 'user_created', 'explicit', ?)`,
    ).run(userCreated, ANXIETY_CONCEPT, revisionId, FIXTURE_NOW);
    expect(service.currentView(revisionId).emotions).toContain(userCreated);

    // 右腿逐字不变：ai_generated 行必须挂在 current run 上才可见。
    const a = await service.ingest({ recordRevisionId: revisionId });
    const derived = selectIds("select id from emotion_mention where parse_run_id = ?", a.runId)[0]!;
    expect(service.currentView(revisionId).emotions).not.toContain(derived); // candidate：门还关着
    service.adoptCurrent({ candidateRunId: a.runId });
    expect(service.currentView(revisionId).emotions).toContain(derived);
  });
});

// ── T-06 ────────────────────────────────────────────────────────────

describe("T-06 服务面：remove 补丁之后任何 run 命中即 rejected，补丁不被清除", () => {
  it("补丁挂在旧 run 的 episode 上，新 candidate 命中同一成员即落 rejected", async () => {
    const first = localStub();
    const a = await first.service.ingest({ recordRevisionId: revisionId });
    first.service.adoptCurrent({ candidateRunId: a.runId });
    const corrections = new CorrectionService(db, { now: () => new Date(FIXTURE_NOW) });
    const episode = first.service.currentView(revisionId).episodes[0]!;
    const before = corrections.patchCount();

    const removed = corrections.removeMember({ containerTable: "episode", containerId: episode, collection: "emotions", memberId: ANXIETY_CONCEPT });
    expect(removed.patch.op).toBe("remove");
    expect(corrections.patchCount()).toBe(before + 1);

    // 重跑一条新管线：candidate 也不例外——命中即 rejected。
    const second = makeService({ promptVersion: "m2-prompt-v2", transport: stubTransport(OK_ENVELOPE(validOutput())).transport });
    const b = await second.ingest({ recordRevisionId: revisionId });
    expect(b.succeeded).toBe(true);
    expect(b.writes.rejectedMentions).toBe(1);
    const emotions = selectIds("select id, status from emotion_mention where parse_run_id = ?", b.runId);
    expect(emotions.length).toBe(1);
    expect(statusOf("emotion_mention", emotions[0]!)).toBe("rejected");
    // 补丁不因重跑而清除。
    expect(corrections.patchCount()).toBe(before + 1);
    expect(corrections.hasRemovePatch({ containerTable: "episode", containerId: episode }, "emotions", ANXIETY_CONCEPT)).toBe(true);
  });

  it("采纳那条 run 之后，被拒的提及仍不进当前视图，补丁照旧在册", async () => {
    const first = localStub();
    const a = await first.service.ingest({ recordRevisionId: revisionId });
    first.service.adoptCurrent({ candidateRunId: a.runId });
    const corrections = new CorrectionService(db, { now: () => new Date(FIXTURE_NOW) });
    const episode = first.service.currentView(revisionId).episodes[0]!;
    corrections.removeMember({ containerTable: "episode", containerId: episode, collection: "emotions", memberId: ANXIETY_CONCEPT });

    const second = makeService({ promptVersion: "m2-prompt-v2", transport: stubTransport(OK_ENVELOPE(validOutput())).transport });
    const b = await second.ingest({ recordRevisionId: revisionId });
    second.adoptCurrent({ candidateRunId: b.runId });

    const view = second.currentView(revisionId);
    expect(view.emotions).toEqual([]);
    expect(view.topics.length).toBe(1);
    expect(corrections.patchCount()).toBe(1);
    // rejected 是终态：采纳不会把它洗回 active。
    const rejected = selectIds("select id from emotion_mention where status = 'rejected'");
    expect(rejected.length).toBe(1);
  });

  it("既存 rejected 行（同词面）同样挡住复活，即使补丁挂在别的容器上", async () => {
    const first = localStub();
    const a = await first.service.ingest({ recordRevisionId: revisionId });
    first.service.adoptCurrent({ candidateRunId: a.runId });
    const mention = selectIds("select id from emotion_mention where parse_run_id = ?", a.runId)[0]!;
    db.prepare("update emotion_mention set status = 'rejected' where id = ?").run(mention);

    const second = makeService({ promptVersion: "m2-prompt-v2", transport: stubTransport(OK_ENVELOPE(validOutput())).transport });
    const b = await second.ingest({ recordRevisionId: revisionId });
    expect(b.writes.rejectedMentions).toBe(1);
    expect(statusOf("emotion_mention", selectIds("select id from emotion_mention where parse_run_id = ?", b.runId)[0]!)).toBe("rejected");
  });

  it("服务层拒 add 补丁：添加的唯一落地是真实 user_created Mention（T-30 服务面）", () => {
    const corrections = new CorrectionService(db, { now: () => new Date(FIXTURE_NOW) });
    let thrown: unknown;
    try {
      corrections.applyCollectionPatch({
        containerTable: "episode",
        containerId: "ep_missing",
        collection: "emotions",
        memberId: ANXIETY_CONCEPT,
        op: "add",
      });
    } catch (cause) {
      thrown = cause;
    }
    expect(thrown).toBeInstanceOf(CollectionAddViaPatchError);
    expect(corrections.patchCount()).toBe(0);
    expect(countRows(db, "emotion_mention")).toBe(0);

    const added = corrections.addUserMention({
      collection: "emotions",
      source: { kind: "revision", id: revisionId },
      memberId: ANXIETY_CONCEPT,
      labelSaid: "焦虑",
    });
    const row = db.prepare("select origin_type, basis, status, parse_run_id from emotion_mention where id = ?").get(added) as {
      origin_type: string;
      basis: string;
      status: string;
      parse_run_id: string | null;
    };
    expect(row).toEqual({ origin_type: "user_created", basis: "explicit", status: "active", parse_run_id: null });
  });

  it("remove 之后用户仍可显式添加：user_created 行不受防复活门约束", () => {
    const corrections = new CorrectionService(db, { now: () => new Date(FIXTURE_NOW) });
    db.prepare(`insert into episode (id, origin_type, lifecycle_status, summary, evidence_text, created_at_utc)
                values ('ep_manual', 'user_created', 'active', '用户自建', '', ?)`).run(FIXTURE_NOW);
    corrections.removeMember({ containerTable: "episode", containerId: "ep_manual", collection: "emotions", memberId: ANXIETY_CONCEPT });
    const added = corrections.addUserMention({
      collection: "emotions",
      source: { kind: "episode", id: "ep_manual" },
      memberId: ANXIETY_CONCEPT,
      labelSaid: "焦虑",
    });
    expect(statusOf("emotion_mention", added)).toBe("active");
    expect(corrections.activeMentionIdsFor({ containerTable: "episode", containerId: "ep_manual" }, "emotions")).toEqual([added]);
  });
});

// ── T-20 ────────────────────────────────────────────────────────────

describe("T-20：detach 出的新行对旧记录零引用，未确认文本绝不入库", () => {
  it("未经确认的摘要：抛，且库里一行都不多", async () => {
    const { service } = localStub();
    const a = await service.ingest({ recordRevisionId: revisionId });
    service.adoptCurrent({ candidateRunId: a.runId });
    const corrections = new CorrectionService(db, { now: () => new Date(FIXTURE_NOW) });
    const episode = service.currentView(revisionId).episodes[0]!;
    const before = countRows(db, "episode");
    expect(() => corrections.detachEpisode({ episodeId: episode })).toThrow(DetachConfirmationRequiredError);
    expect(countRows(db, "episode")).toBe(before);
  });

  it("确认后的新行：无 parse_run、无来源 revision、内容只来自确认文本", async () => {
    const { service } = localStub();
    const a = await service.ingest({ recordRevisionId: revisionId });
    service.adoptCurrent({ candidateRunId: a.runId });
    const corrections = new CorrectionService(db, { now: () => new Date(FIXTURE_NOW) });
    const episode = service.currentView(revisionId).episodes[0]!;
    const detached = corrections.detachEpisode({ episodeId: episode, confirmedSummary: "用户确认过的独立事件" });

    const row = db.prepare("select * from episode where id = ?").get(detached) as Record<string, unknown>;
    expect(row["parse_run_id"]).toBeNull();
    expect(row["source_record_revision_id"]).toBeNull();
    expect(row["origin_type"]).toBe("user_created");
    expect(row["lifecycle_status"]).toBe("active");
    expect(row["summary"]).toBe("用户确认过的独立事件");
    expect(row["evidence_start"]).toBeNull();
    expect(row["evidence_end"]).toBeNull();
    // 旧行不被 detach 改写、也不删除（它是历史）。
    expect(db.prepare("select summary as s from episode where id = ?").get(episode)).toBeTruthy();
  });

  it("detach 出来的新行对旧记录零引用（新 thought 挂在自己的新记录上）", async () => {
    const { service } = localStub();
    const a = await service.ingest({ recordRevisionId: revisionId });
    service.adoptCurrent({ candidateRunId: a.runId });
    const corrections = new CorrectionService(db, { now: () => new Date(FIXTURE_NOW) });
    const thought = service.currentView(revisionId).thoughts[0]!;
    let createdRecordId = "";
    const detached = corrections.detachThought({
      thoughtId: thought,
      confirmedText: "独立成条的想法",
      // §3.20 第 1 步要求「同事务先建 CaptureRecord + RecordRevision」，而
      // `RecordService.createRecord` 自带 `begin immediate`，在 detachThought 的事务里嵌套即抛。
      // 所以契约要求调用方提供**语句级**创建器（detachThought 头注同此），这里逐字照抄其两条 insert。
      createSourceRecord: (text) => {
        const ts = buildTimestamps(new Date(FIXTURE_NOW), FIXTURE_TIMEZONE);
        const id = newId("captureRecord");
        const rev = newId("recordRevision");
        db.prepare(
          `insert into capture_record (id, created_at_utc, created_at_local, timezone_id, created_local_date, current_revision_id)
           values (?, ?, ?, ?, ?, ?)`,
        ).run(id, ts.utc, ts.local, ts.timezoneId, ts.localDate, rev);
        db.prepare(
          `insert into record_revision (id, record_id, revision_number, raw_text, content_sha256, tokens,
                                        created_at_utc, created_at_local, timezone_id)
           values (?, ?, 1, ?, ?, '', ?, ?, ?)`,
        ).run(rev, id, text, createHash("sha256").update(text.normalize("NFC")).digest("hex"), ts.utc, ts.local, ts.timezoneId);
        createdRecordId = id;
        return { revisionId: rev };
      },
    });
    const row = db.prepare("select * from thought_item where id = ?").get(detached) as Record<string, unknown>;
    expect(row["parse_run_id"]).toBeNull();
    expect(row["source_episode_id"]).toBeNull();
    expect(row["origin_type"]).toBe("user_created");
    expect(row["source_record_revision_id"]).not.toBe(revisionId);
    const newRecord = db.prepare("select id, processing_status from capture_record where id = ?").get(createdRecordId) as {
      id: string;
      processing_status: string;
    };
    expect(newRecord.id).toBe(createdRecordId);
    // 新记录是一条独立在册的记录，不与旧记录共享任何 revision。
    const shared = db
      .prepare("select count(*) as n from record_revision where record_id = ? and id = ?")
      .get(createdRecordId, revisionId) as { n: number };
    expect(shared.n).toBe(0);
  });

  it("detach 出来的行进入它自己那条记录的当前视图，不出现在旧记录的视图里", async () => {
    const { service } = localStub();
    const a = await service.ingest({ recordRevisionId: revisionId });
    service.adoptCurrent({ candidateRunId: a.runId });
    const corrections = new CorrectionService(db, { now: () => new Date(FIXTURE_NOW) });
    const oldEpisode = service.currentView(revisionId).episodes[0]!;
    const detached = corrections.detachEpisode({ episodeId: oldEpisode, confirmedSummary: "脱离原记录的独立事件" });
    expect(service.currentView(revisionId).episodes).not.toContain(detached);
    expect(service.currentView(revisionId).episodes).toContain(oldEpisode);
  });
});

// ── 裁决 g ──────────────────────────────────────────────────────────

describe("裁决 2：降级留痕对外收敛为数组，与 Provider 的诊断串逐值相等", () => {
  /**
   * Provider 写 `attempted_paths: attempted.join(">")`，`ExtractionOutcome.attemptedPaths`
   * 是数组。编排层只暴露数组，所以这里把两条路都走一遍并**逐值**对账。
   */
  it("成功降级：数组 == 诊断串切分 == 对外结果 == Trace", async () => {
    const bodies: TransportResponse[] = [
      { status: 200, body: JSON.stringify({ nope: true }) }, // 结构化端点拿不回信封 ⇒ 可降级
      OK_ENVELOPE(validOutput()),
    ];
    let call = 0;
    const trace = new TraceSession();
    // 降级与处理模式无关，这里走本地回路（`sdk_structured` 声明 + 循环地址），
    // 以免把云端授权门与脱敏映射一起拖进这条断言。
    const service = makeService({
      adapter: makeAdapter({ callPath: "sdk_structured", supportsStructuredOutput: true }),
      transport: { send: async () => bodies[Math.min(call++, bodies.length - 1)]! },
      trace,
    });
    const result = await service.ingest({ recordRevisionId: revisionId });

    const expected: readonly ProviderCallPath[] = ["sdk_structured", "http_json_lenient"];
    expect(call).toBe(2);
    expect(result.attemptedPaths).toEqual(expected);
    expect(result.attemptedPaths.join(">")).toBe(expected.join(">"));
    expect(result.degraded).toBe(true);
    expect(result.succeeded).toBe(true);

    const entries = JSON.parse(trace.serialize({ rawText: LOCAL_RAW })) as Array<{
      attemptedPaths?: string[];
      degraded?: boolean;
      callPath?: string;
    }>;
    expect(entries.length).toBe(1);
    expect(entries[0]?.attemptedPaths).toEqual(expected);
    expect(entries[0]?.degraded).toBe(true);
  });

  it("失败路径：ProviderError 的 attempted_paths 串还原为数组，degraded 一并透传", async () => {
    let call = 0;
    const trace = new TraceSession();
    const service = makeService({
      adapter: makeAdapter({ callPath: "sdk_structured", supportsStructuredOutput: true }),
      transport: {
        send: async (): Promise<TransportResponse> =>
          call++ === 0
            ? { status: 200, body: JSON.stringify({ nope: true }) }
            : { status: 200, body: envelope("这条回稿根本不是 JSON") },
      },
      trace,
    });
    db.prepare("update capture_record set processing_mode = 'local_model' where id = ?").run(recordId);
    const result = await service.ingest({ recordRevisionId: revisionId });
    expect(result.succeeded).toBe(false);
    expect(result.errorKind).toBe("invalid_json");
    expect(result.attemptedPaths).toEqual(["sdk_structured", "http_json_lenient"]);
    expect(result.degraded).toBe(true);
    expect(result.failure?.issues.join(" ")).toMatch(/invalid_json/);
    // 库里没有派生行，但 run 行留有封闭的 error_kind。
    expect(countRows(db, "episode")).toBe(0);
    expect(service.readRun(result.runId)?.error_kind).toBe("invalid_json");
    const entries = JSON.parse(trace.serialize()) as Array<{ attemptedPaths?: string[]; errorKind?: string }>;
    expect(entries[0]?.attemptedPaths).toEqual(result.attemptedPaths);
    expect(entries[0]?.errorKind).toBe("invalid_json");
  });
});

// ── 解析器（D10）────────────────────────────────────────────────────

describe("解析器：冻结的三步顺序与实体侧的不对称", () => {
  function insertConcept(id: string, type: "emotion" | "topic", name: string, lifecycle = "active"): void {
    db.prepare(
      `insert into concept (id, concept_type, canonical_name, origin_type, lifecycle_status, created_at_utc)
       values (?, ?, ?, 'user_created', ?, ?)`,
    ).run(id, type, name, lifecycle, FIXTURE_NOW);
  }
  function insertAlias(id: string, alias: string, conceptId: string, domain: "emotion" | "topic", mode: "auto" | "suggest"): void {
    db.prepare(
      `insert into concept_alias (id, alias, concept_id, domain, mode, source, confirmed_at_utc)
       values (?, ?, ?, ?, ?, 'user_confirmed', ?)`,
    ).run(id, alias, conceptId, domain, mode, FIXTURE_NOW);
  }
  function insertEntity(id: string, name: string, lifecycle = "active"): void {
    db.prepare(
      `insert into entity (id, entity_type, canonical_name, display_name, lifecycle_status, privacy_level, origin_type, created_at_utc)
       values (?, 'person', ?, ?, ?, 'normal', 'user_created', ?)`,
    ).run(id, name, name, lifecycle, FIXTURE_NOW);
  }
  function insertEntityAlias(alias: string, entityId: string): void {
    db.prepare("insert into entity_alias (entity_id, alias, created_at_utc) values (?, ?, ?)").run(entityId, alias, FIXTURE_NOW);
  }

  it("第 1 步：mode=auto 的别名命中优先于标准名（K-14，模型无权设定 auto）", () => {
    // 词面一律用夹具专名：种子的 UNIQUE(concept_type, canonical_name) 与别名表会撞掉同名夹具。
    insertConcept("concept_target_x", "emotion", "夹具情绪甲");
    insertAlias("ca_auto_x", "夹具别名甲", "concept_target_x", "emotion", "auto");
    insertConcept("concept_decoy_x", "emotion", "夹具别名甲", "active");
    const resolver = new ConceptResolver(db);
    const hit = resolver.resolveConcept("emotion", "夹具别名甲");
    expect(hit.kind).toBe("resolved");
    if (hit.kind === "resolved") expect(hit.match).toEqual({ conceptId: "concept_target_x", canonicalName: "夹具情绪甲", via: "auto_alias" });
  });

  it("第 2 步：标准名精确命中；别名不参与时按 canonical_name 走", () => {
    insertConcept("concept_plain", "topic", "个人成长");
    const resolver = new ConceptResolver(db);
    const hit = resolver.resolveConcept("topic", "个人成长");
    if (hit.kind !== "resolved") throw new Error("应命中标准名");
    expect(hit.match.via).toBe("canonical_name");
    expect(hit.match.conceptId).toBe("concept_plain");
  });

  it("第 3 步：suggest 别名只生成 alias 建议；candidateConceptId 不构成写入权限", () => {
    insertConcept("concept_near", "emotion", "夹具情绪乙");
    insertAlias("ca_suggest_near", "夹具别名乙", "concept_near", "emotion", "suggest");
    const resolver = new ConceptResolver(db);
    const suggest = resolver.resolveConcept("emotion", "夹具别名乙");
    expect(suggest).toEqual({ kind: "suggestion", suggestionKind: "alias", targetConceptId: "concept_near" });
    const named = resolver.resolveConcept("emotion", "夹具词面丙", "concept_near");
    expect(named).toEqual({ kind: "suggestion", suggestionKind: "alias", targetConceptId: "concept_near" });
    const fresh = resolver.resolveConcept("emotion", "夹具词面丙", null);
    expect(fresh).toEqual({ kind: "suggestion", suggestionKind: "new_concept", targetConceptId: null });
    // 未归档概念才参与归一。
    insertConcept("concept_arched", "emotion", "夹具情绪丁");
    insertAlias("ca_arched", "夹具别名丁", "concept_arched", "emotion", "auto");
    db.prepare("update concept set lifecycle_status = 'archived' where id = 'concept_arched'").run();
    expect(new ConceptResolver(db).resolveConcept("emotion", "夹具别名丁").kind).toBe("suggestion");
  });

  it("匹配按 NFC 归一，落库保留用户原词逐字", async () => {
    // 同一词面的两种 Unicode 形式：é 的组合式（e + U+0301）与预组合式必须解析到同一概念。
    const composed = "café";
    const decomposed = "cafe\u0301";
    expect(decomposed.normalize("NFC")).toBe(composed);
    insertConcept("concept_cafe", "topic", composed);
    const corrections = new CorrectionService(db, { now: () => new Date(FIXTURE_NOW) });
    const hit = new ConceptResolver(db).resolveConcept("topic", decomposed);
    if (hit.kind !== "resolved") throw new Error("NFC 归一后应命中标准名");
    expect(hit.match.conceptId).toBe("concept_cafe");
    const mention = corrections.addUserMention({
      collection: "topics",
      source: { kind: "revision", id: revisionId },
      memberId: hit.match.conceptId,
      labelSaid: decomposed,
    });
    const stored = db.prepare("select label_said as s from topic_mention where id = ?").get(mention) as { s: string };
    expect(stored.s).toBe(decomposed);
  });

  it("实体侧不对称：同名多候选 ⇒ ambiguous，本层绝不自动合并", () => {
    insertEntity("entity_zhang_1", "张三");
    insertEntity("entity_zhang_2", "张三");
    const resolver = new ConceptResolver(db);
    expect(resolver.resolveEntity("张三")).toEqual({ kind: "ambiguous", candidates: ["entity_zhang_1", "entity_zhang_2"] });
    insertEntityAlias("老张", "entity_zhang_1");
    expect(new ConceptResolver(db).resolveEntity("老张")).toEqual({ kind: "resolved", entityId: "entity_zhang_1" });
    insertEntity("entity_arched", "王五", "archived");
    expect(new ConceptResolver(db).resolveEntity("王五")).toEqual({ kind: "unmatched" });
  });

  it("服务面：未归属的标签落 suggestion，不建 concept 行", async () => {
    const output = validOutput();
    output.emotions.push({ labelSaid: "说不上来的堵", candidateConceptId: null, basis: "explicit", evidence: "我感到焦虑" });
    const conceptsBefore = countRows(db, "concept");
    const { service } = localStub(output);
    const result = await service.ingest({ recordRevisionId: revisionId });
    expect(result.writes.suggestions).toBe(1);
    expect(countRows(db, "concept")).toBe(conceptsBefore);
    const rows = db
      .prepare("select kind, endpoint_a, subject_term, status, parse_run_id from suggestion")
      .all() as Array<{ kind: string; endpoint_a: string; subject_term: string; status: string; parse_run_id: string }>;
    expect(rows.length).toBe(1);
    expect(rows[0]).toEqual({ kind: "new_concept", endpoint_a: revisionId, subject_term: "说不上来的堵", status: "pending", parse_run_id: result.runId });
  });

  it("服务面：basis=inferred 的情绪永不成为 Mention，只成 emotion_candidate 建议（§3.2.2）", async () => {
    const output = validOutput();
    output.emotions = [{ labelSaid: "焦虑", candidateConceptId: ANXIETY_CONCEPT, basis: "inferred", evidence: "我感到焦虑" }];
    const { service } = localStub(output);
    const result = await service.ingest({ recordRevisionId: revisionId });
    expect(result.writes.mentions).toBe(1);
    expect(result.writes.suggestions).toBe(1);
    const kinds = db.prepare("select kind from suggestion").all() as Array<{ kind: string }>;
    expect(kinds.map((row) => row.kind)).toEqual(["emotion_candidate"]);
    expect(countRows(db, "emotion_mention")).toBe(0);
  });

  it("服务面：别名建议必带既存 concept 端点（§3.17 端点矩阵）", async () => {
    insertAliasFixture("ca_suggest_alias", "心慌", "concept_alias_target", "emotion", "suggest");
    const output = validOutput();
    output.emotions = [{ labelSaid: "心慌", candidateConceptId: null, basis: "explicit", evidence: "我感到焦虑" }];
    const { service } = localStub(output);
    const result = await service.ingest({ recordRevisionId: revisionId });
    const row = db.prepare("select kind, endpoint_a, subject_term from suggestion").get() as {
      kind: string;
      endpoint_a: string;
      subject_term: string;
    };
    expect(row).toEqual({ kind: "alias", endpoint_a: "concept_alias_target", subject_term: "心慌" });
    expect(result.writes.mentions).toBe(1);
  });

  function insertAliasFixture(id: string, alias: string, conceptId: string, domain: "emotion" | "topic", mode: "auto" | "suggest"): void {
    db.prepare(
      `insert into concept (id, concept_type, canonical_name, origin_type, lifecycle_status, created_at_utc)
       values (?, ?, ?, 'user_created', 'active', ?)`,
    ).run(conceptId, domain, "夹具情绪己", FIXTURE_NOW);
    db.prepare(
      `insert into concept_alias (id, alias, concept_id, domain, mode, source, confirmed_at_utc)
       values (?, ?, ?, ?, ?, 'user_confirmed', ?)`,
    ).run(id, alias, conceptId, domain, mode, FIXTURE_NOW);
  }
});

describe("Trace 与会话面：一次解析只留一条可定位记录", () => {
  it("成功路径：一条 TraceEntry，字段面全在封闭集内，diagnostics 只有计数", async () => {
    const trace = new TraceSession();
    const { service } = localStub(validOutput(), { trace });
    const result = await service.ingest({ recordRevisionId: revisionId });
    expect(trace.entryCount).toBe(1);
    const entries = JSON.parse(trace.serialize({ rawText: LOCAL_RAW })) as Array<Record<string, unknown>>;
    expect(entries.length).toBe(1);
    const entry = entries[0]!;
    expect(entry["recordId"]).toBe(recordId);
    expect(entry["recordRevisionId"]).toBe(revisionId);
    expect(entry["parseRunId"]).toBe(result.runId);
    expect(entry["idempotencyKey"]).toBe(result.idempotencyKey);
    expect(entry["pipelineFingerprint"]).toBe(result.pipelineFingerprint);
    expect(entry["processingMode"]).toBe("local_model");
    expect(entry["provider"]).toBe("ollama");
    expect(entry["model"]).toBe("qwen2.5:7b");
    expect(entry["derivedWriteCommitted"]).toBe(true);
    expect(entry["structuredParseSucceeded"]).toBe(true);
    expect((entry["businessValidation"] as { passed: boolean }).passed).toBe(true);
    expect(entry["errorKind"]).toBeUndefined();
    expect(Object.keys(entry)).not.toContain("rawText");
  });

  it("幂等重放：另留一条记录，但不声称发生过解析（无 structuredParseSucceeded 键）", async () => {
    const trace = new TraceSession();
    const { service, stub } = localStub(validOutput(), { trace });
    await service.ingest({ recordRevisionId: revisionId });
    const replay = await service.ingest({ recordRevisionId: revisionId });
    expect(replay.replayed).toBe(true);
    expect(stub.callCount()).toBe(1);
    expect(trace.entryCount).toBe(2);
    const entries = JSON.parse(trace.serialize()) as Array<Record<string, unknown>>;
    expect(entries[1]?.["structuredParseSucceeded"]).toBeUndefined();
    expect(entries[1]?.["derivedWriteCommitted"]).toBe(false);
    expect(entries[1]?.["parseRunId"]).toBe(entries[0]?.["parseRunId"]);
  });
});
