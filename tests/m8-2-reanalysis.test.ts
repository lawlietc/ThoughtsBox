/**
 * M8-2 重新分析的语义与入口（任务书 §4.2 R1–R7）。
 *
 * 钉的是七件事：
 *  - **R1** `reanalysis` 缺席 ⇒ 与今天逐字一致（同键重放、不新增 run、provider 只调一次）；
 *  - **R2/R3** 显式重新分析 ⇒ 同一条管线上再开一单，键 `…_a2`、`…_a3`，序号只增不重；
 *  - **R4** 新候选被采纳后旧 run 才转 superseded（M8-D-5：重新分析产出的仍是 candidate）；
 *  - **R5** 该版本上已有一单在飞 ⇒ 第二次 `reanalysis` 被拒（M8-D-8）：不发起调用、不长第二行，
 *    服务层抛 `ReanalysisInFlightError`，路由映射 409 `state_conflict`；
 *  - **R6** 授权闸门一条不减（M8-D-6）：无 grant 的 `reanalyze` 与无 grant 的 `parse` 报同一个错；
 *  - **R7** 非当前 revision 的 `reanalyze` 与 `parse` 同口径被拒；
 *  - **§4.1.4** 记录详情那个按钮：无 body 的 POST、显示条件只读这一页已有的 run 历史、
 *    代价（再调一次模型 + 产出仍是候选）写在按钮旁边、回话与忙态走采纳/放弃同一条通道。
 *
 * ## 为什么这一组现在能真跑（读我）
 *
 * R2–R5 的前提是「同一条管线上的旧 current 与新 candidate 同时存在」。`ux_run_live` 在 0003 里
 * 按 `result_state in ('candidate','current')` 建，物理上拒绝这一形态——`beginRun` 的 insert
 * 直接撞 `UNIQUE constraint failed: parse_run.source_revision_id, parse_run.pipeline_fingerprint`。
 * M8-D-7 用迁移 `0012_narrow_run_live_index.sql` 把谓词收窄到 `execution_status in ('queued','running')`：
 * 真正要保的是「至多一份在途」，「至多一个现行」一直由 `ux_run_current` 独家守。
 * 同批收账的两条既有断言见 `tests/m2-schema-contract.test.ts`、`tests/m2-ingest-service.test.ts`
 * 的 ux_run_live 用例（只许更强：在途互斥仍在，定案可共存新成立）。
 * 上一轮这里的 `liveRunCollides()` 探针 + `describe.skipIf` 因此删掉——索引已经收窄，四条回到真跑；
 * 留着探针等于给「有人把索引改回去」留一个静默跳过的后门。
 *
 * 时钟纪律：所有 run 都用夹具 `FIXTURE_NOW`，`started_at_utc` 因此不是「两列恰好都等于 now」。
 * 全程离线：模型调用由注入的假 transport 驱动并计数。
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { boot, shutdown, type BootResult } from "../src/server/runtime/bootstrap.ts";
import { ensureConfigFile } from "../src/server/config/config.ts";
import type { DataLayout } from "../src/server/config/paths.ts";
import { migrate } from "../src/server/db/migrator.ts";
import { seedVocabulary } from "../src/server/db/seed.ts";
import { RecordService } from "../src/server/records/service.ts";
import {
  IngestInputError,
  IngestService,
  ReanalysisInFlightError,
  deriveIdempotencyKey,
} from "../src/server/ingest/ingestService.ts";
import type { Database } from "../src/server/db/adapter.ts";
import {
  FIXTURE_NOW,
  FIXTURE_TIMEZONE,
  LOCAL_RAW,
  OK_ENVELOPE,
  SYSTEM_PROMPT,
  createRecord,
  makeAdapter,
  stubTransport,
  validOutput,
  type StubTransport,
} from "./helpers/ingestFixtures.ts";
import { countRows, makeSandbox, openSandboxDb, type Sandbox } from "./helpers/sandbox.ts";

/** 源码级断言的读文件口子（本仓 UI 惯例：vitest 是 node 环境，没有 DOM）。 */
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const sourceAt = (relative: string): string =>
  readFileSync(join(ROOT, relative), "utf8").replace(/\r\n/g, "\n");

/* ══════════════════════════════════════════════════════════════════
 * 服务层夹具（R1–R5、R7）
 * ══════════════════════════════════════════════════════════════════ */

let sandbox: Sandbox | undefined;
let db: Database | undefined;

function setup(mode = "local_model"): { recordId: string; revisionId: string } {
  sandbox = makeSandbox("tb-m8-2-service-");
  db = openSandboxDb(sandbox.layout);
  migrate(db);
  seedVocabulary(db);
  const { recordId, revisionId } = createRecord(db, LOCAL_RAW, mode);
  return { recordId, revisionId };
}

function liveDb(): Database {
  if (db === undefined) throw new Error("夹具未初始化");
  return db;
}

afterEach(() => {
  db?.close();
  db = undefined;
  sandbox?.cleanup();
  sandbox = undefined;
});

function makeService(stub: StubTransport, options: { grantCheck?: () => void } = {}): IngestService {
  return new IngestService({
    db: liveDb(),
    adapter: makeAdapter(),
    transport: stub.transport,
    systemPrompt: SYSTEM_PROMPT,
    now: () => new Date(FIXTURE_NOW),
    ...(options.grantCheck === undefined ? {} : { grantCheck: options.grantCheck }),
  });
}

/** 派生场面快照：R1 的「重放不重写」与 R4 的「产出随采纳可见」都读这张表。 */
function derivedCounts(revisionId: string): Record<string, number> {
  const handle = liveDb();
  const one = (sql: string): number => (handle.prepare(sql).get(revisionId) as { n: number }).n;
  return {
    episode: one("select count(*) as n from episode where source_record_revision_id = ?"),
    thought_item: one("select count(*) as n from thought_item where source_record_revision_id = ?"),
    emotion_mention: one("select count(*) as n from emotion_mention where source_record_revision_id = ?"),
    topic_mention: one("select count(*) as n from topic_mention where source_record_revision_id = ?"),
    entity_mention: one("select count(*) as n from entity_mention where source_record_revision_id = ?"),
  };
}

interface RunLite {
  readonly id: string;
  readonly key: string;
  readonly exec: string;
  readonly state: string;
}

/** 库里这一版本名下的 run，按落库顺序（rowid）——序号「只增不重」看的就是这个序列。 */
function runsOf(revisionId: string): RunLite[] {
  return liveDb()
    .prepare(
      `select id, idempotency_key as key, execution_status as exec, result_state as state
         from parse_run where source_revision_id = ? order by rowid`,
    )
    .all(revisionId) as unknown as RunLite[];
}

async function captureError(body: () => Promise<unknown>): Promise<unknown> {
  try {
    await body();
  } catch (cause) {
    return cause;
  }
  throw new Error("预期抛错，实际正常返回");
}

/* ── R1 ─────────────────────────────────────────────────────────── */

describe("R1 reanalysis 缺席：与今天逐字一致", () => {
  it("首次的键没有后缀；第二次同键 ⇒ 重放，不新增 run、provider 只被调一次、派生行 delta 为 0", async () => {
    const { revisionId } = setup();
    const stub = stubTransport(OK_ENVELOPE(validOutput()));
    const service = makeService(stub);

    const first = await service.ingest({ recordRevisionId: revisionId });
    expect(first.replayed).toBe(false);
    expect(first.succeeded).toBe(true);
    // 两参调用 = 冻结件里的旧键形状；缺席路径必须逐字落在这串上，一个字节都不能多。
    expect(first.idempotencyKey).toBe(deriveIdempotencyKey(revisionId, first.pipelineFingerprint));
    expect(first.idempotencyKey).toBe(`idem_${revisionId}_${first.pipelineFingerprint}`);
    expect(/_a\d+$/.test(first.idempotencyKey)).toBe(false);
    const afterFirst = derivedCounts(revisionId);
    expect(afterFirst.episode).toBe(1);

    const second = await service.ingest({ recordRevisionId: revisionId });
    expect(second.replayed).toBe(true);
    expect(second.runId).toBe(first.runId);
    expect(second.idempotencyKey).toBe(first.idempotencyKey);
    expect(countRows(liveDb(), "parse_run")).toBe(1);
    expect(stub.callCount()).toBe(1);
    expect(derivedCounts(revisionId)).toEqual(afterFirst);
  });

  it("显式 reanalysis:false 与缺席同一条分支（键仍是旧形状，仍然命中重放）", async () => {
    const { revisionId } = setup();
    const stub = stubTransport(OK_ENVELOPE(validOutput()));
    const service = makeService(stub);

    const first = await service.ingest({ recordRevisionId: revisionId });
    const flagged = await service.ingest({ recordRevisionId: revisionId, reanalysis: false });

    expect(flagged.replayed).toBe(true);
    expect(flagged.runId).toBe(first.runId);
    expect(flagged.idempotencyKey).toBe(first.idempotencyKey);
    expect(/_a\d+$/.test(flagged.idempotencyKey)).toBe(false);
    expect(countRows(liveDb(), "parse_run")).toBe(1);
    expect(stub.callCount()).toBe(1);
  });

  it("键函数本身：attempt<=1 ⇒ 旧形状逐字不变，>1 才追加 _a<attempt>", () => {
    const base = deriveIdempotencyKey("rev_x", "f".repeat(64));
    expect(base).toBe("idem_rev_x_" + "f".repeat(64));
    expect(deriveIdempotencyKey("rev_x", "f".repeat(64), 1)).toBe(base);
    expect(deriveIdempotencyKey("rev_x", "f".repeat(64), 0)).toBe(base);
    expect(deriveIdempotencyKey("rev_x", "f".repeat(64), 2)).toBe(`${base}_a2`);
    expect(deriveIdempotencyKey("rev_x", "f".repeat(64), 3)).toBe(`${base}_a3`);
  });
});

/* ── R2–R5（探针为真时整组跳过，理由见文件头）──────────────────────── */

describe("R2–R5 同管线再开一单（M8-D-4/D-5/D-8）", () => {
  it("R2 已成功的 revision + reanalysis ⇒ 新 run、键 _a2、result_state=candidate、旧 run 仍 current、provider 恰好一次", async () => {
    const { revisionId } = setup();
    const stub = stubTransport(OK_ENVELOPE(validOutput()));
    const service = makeService(stub);

    const first = await service.ingest({ recordRevisionId: revisionId });
    service.adoptCurrent({ candidateRunId: first.runId });
    expect(service.readRun(first.runId)?.result_state).toBe("current");
    const callsAfterFirst = stub.callCount();

    const again = await service.ingest({ recordRevisionId: revisionId, reanalysis: true });

    expect(again.runId).not.toBe(first.runId);
    expect(again.replayed).toBe(false);
    expect(again.succeeded).toBe(true);
    expect(again.pipelineFingerprint).toBe(first.pipelineFingerprint);
    expect(again.idempotencyKey).toBe(`${deriveIdempotencyKey(revisionId, again.pipelineFingerprint)}_a2`);
    expect(service.readRun(again.runId)?.result_state).toBe("candidate");
    // 旧 run 一步都没动：重新分析不自作主张地改现行结果。
    expect(service.readRun(first.runId)?.result_state).toBe("current");
    expect(stub.callCount()).toBe(callsAfterFirst + 1);
    expect(countRows(liveDb(), "parse_run")).toBe(2);
  });

  it("R3 再来一次 ⇒ _a3；三行的键按落库顺序严格递增、不重号", async () => {
    const { revisionId } = setup();
    const stub = stubTransport(OK_ENVELOPE(validOutput()));
    const service = makeService(stub);

    const first = await service.ingest({ recordRevisionId: revisionId });
    const base = deriveIdempotencyKey(revisionId, first.pipelineFingerprint);
    await service.ingest({ recordRevisionId: revisionId, reanalysis: true });
    const third = await service.ingest({ recordRevisionId: revisionId, reanalysis: true });

    expect(third.idempotencyKey).toBe(`${base}_a3`);
    expect(runsOf(revisionId).map((r) => r.key)).toEqual([base, `${base}_a2`, `${base}_a3`]);
    // 序号只增不重：同一条管线上第 N 单永远只有一行。
    expect(new Set(runsOf(revisionId).map((r) => r.key)).size).toBe(3);
    expect(stub.callCount()).toBe(3);
  });

  it("R4 采纳新候选 ⇒ 旧 run superseded、新 run current，且新 run 名下的产出随采纳成为现行视图", async () => {
    const { revisionId } = setup();
    const stub = stubTransport(OK_ENVELOPE(validOutput()));
    const service = makeService(stub);

    const first = await service.ingest({ recordRevisionId: revisionId });
    service.adoptCurrent({ candidateRunId: first.runId });
    const again = await service.ingest({ recordRevisionId: revisionId, reanalysis: true });

    const adopted = service.adoptCurrent({ candidateRunId: again.runId });

    expect(adopted).toEqual({ supersededRunId: first.runId, adoptedRunId: again.runId });
    expect(service.readRun(first.runId)?.result_state).toBe("superseded");
    expect(service.readRun(again.runId)?.result_state).toBe("current");
    // 唯一 current 不变式仍成立（ux_run_current）。
    expect(runsOf(revisionId).filter((r) => r.state === "current").map((r) => r.id)).toEqual([again.runId]);
    // 新 run 名下的产出在采纳后才是「有效结果」读面的现行内容。
    const view = service.currentView(revisionId);
    expect(view.currentRunId).toBe(again.runId);
    expect(liveDb().prepare("select count(*) as n from episode where parse_run_id = ?").get(again.runId)).toEqual({
      n: 1,
    });
  });

  it("R5 在途即拒绝（M8-D-8）：第二次 reanalysis 抛 ReanalysisInFlightError，provider 总调用数为 1、库里只多一条 run", async () => {
    const { revisionId } = setup();
    const stub = stubTransport(OK_ENVELOPE(validOutput()));
    const service = makeService(stub);
    const first = await service.ingest({ recordRevisionId: revisionId });
    service.adoptCurrent({ candidateRunId: first.runId });
    const callsAfterFirst = stub.callCount();

    // 不 await 第一单：`beginRun` 全同步，这一句返回时库里已经有一行 running，而模型调用还挂在 await 上。
    // 「查在途」与「插入」因此落在同一个 tick——这正是 M8-D-8 认定 UNIQUE 冲突捕获是死代码的那个理由。
    const inFlight = service.ingest({ recordRevisionId: revisionId, reanalysis: true });
    const second = await captureError(() => service.ingest({ recordRevisionId: revisionId, reanalysis: true }));
    const again = await inFlight;

    expect(again.replayed).toBe(false);
    expect(again.idempotencyKey).toBe(`${deriveIdempotencyKey(revisionId, again.pipelineFingerprint)}_a2`);
    expect(second).toBeInstanceOf(ReanalysisInFlightError);
    const detail = second as ReanalysisInFlightError;
    // 挡路的就是那一单在飞的 run：错误里报得出身份，也报得出它凭什么算「在途」。
    expect(detail.runId).toBe(again.runId);
    expect(detail.executionStatus).toBe("running");
    expect(detail.message).toContain(again.runId);
    expect(detail.message).toContain("running");
    // 隐私面：拒绝消息里只有标识符与枚举值，一个字的原文都不带。
    expect(detail.message).not.toContain(LOCAL_RAW);
    // 被拒的一条不多调模型、不留第二行：库里只比首次多一条。
    expect(stub.callCount()).toBe(callsAfterFirst + 1);
    expect(runsOf(revisionId).map((r) => r.id)).toEqual([first.runId, again.runId]);
    expect(countRows(liveDb(), "parse_run")).toBe(2);
  });
});

/* ── R6 ─────────────────────────────────────────────────────────── */

describe("R5/R6 经真实路由：在途拒绝与授权闸门", () => {
  const instances: Instance[] = [];

  interface Instance {
    readonly booted: BootResult;
    readonly box: Sandbox;
    readonly base: string;
    readonly transport: StubTransport;
  }

  async function testPort(): Promise<number> {
    const { createServer } = await import("node:net");
    return new Promise((resolve, reject) => {
      const probe = createServer();
      probe.once("error", reject);
      probe.listen(0, "127.0.0.1", () => {
        const address = probe.address();
        if (address === null || typeof address === "string") {
          reject(new Error("无法取得空闲端口"));
          return;
        }
        const port = address.port;
        probe.close(() => resolve(port));
      });
    });
  }

  function writePort(layout: DataLayout, port: number): void {
    mkdirSync(layout.dataDir, { recursive: true });
    const file = ensureConfigFile(layout);
    const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    (raw.server as Record<string, unknown>).port = port;
    writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
  }

  async function startInstance(): Promise<Instance> {
    const port = await testPort();
    const box = makeSandbox("tb-m8-2-routes-");
    writePort(box.layout, port);
    const transport = stubTransport(OK_ENVELOPE(validOutput()));
    const booted = await boot({
      env: { TB_DATA_DIR: box.root, USERPROFILE: box.root, HOME: box.root },
      log: () => {},
      // 队列 worker 一起来就会成为「provider 被调了几次」的第二个来源，本文件不要它。
      startJobsWorker: false,
      ingestProvider: {
        adapter: makeAdapter(),
        transport: transport.transport,
        systemPrompt: SYSTEM_PROMPT,
        now: () => new Date(FIXTURE_NOW),
      },
    });
    const inst: Instance = { booted, box, base: `http://127.0.0.1:${port}`, transport };
    instances.push(inst);
    return inst;
  }

  afterEach(async () => {
    while (instances.length > 0) {
      const inst = instances.pop();
      if (inst === undefined) break;
      await shutdown(inst!.booted);
      inst!.box.cleanup();
    }
  });

  interface ApiResult {
    status: number;
    json: any;
    text: string;
  }

  async function call(inst: Instance, method: string, path: string, body?: unknown): Promise<ApiResult> {
    const init: RequestInit = { method };
    if (body !== undefined) {
      init.headers = { "content-type": "application/json" };
      init.body = JSON.stringify(body);
    }
    const res = await fetch(`${inst.base}${path}`, init);
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text === "" ? null : JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: res.status, json, text };
  }

  async function createRecordViaHttp(
    inst: Instance,
    text: string,
    processingMode: string,
  ): Promise<{ recordId: string; revisionId: string }> {
    const r = await call(inst, "POST", "/api/records", { text, processing_mode: processingMode });
    expect(r.status).toBe(201);
    const recordId = r.json.record.id as string;
    // A-0 起 cloud_redacted 默认 local_llm；这里要测的是「缺授权」那道门，先落回 manual。
    if (processingMode === "cloud_redacted") {
      const manual = await call(inst, "PATCH", `/api/records/${recordId}/redaction-mode`, { redaction_mode: "manual" });
      expect(manual.status).toBe(200);
    }
    return { recordId, revisionId: r.json.revision.id as string };
  }

  function runsFor(inst: Instance, revisionId: string): number {
    return (
      inst.booted.db
        .prepare("select count(*) as n from parse_run where source_revision_id = ?")
        .get(revisionId) as { n: number }
    ).n;
  }

  it("R5 在途即拒绝经路由映射 409 state_conflict：不发起调用，也不留下第二行", async () => {
    const inst = await startInstance();
    const { recordId, revisionId } = await createRecordViaHttp(inst, LOCAL_RAW, "local_model");
    const first = await call(inst, "POST", "/api/ingest/parse", { recordId });
    expect(first.status).toBe(200);
    const callsAfterFirst = inst.transport.callCount();
    expect(callsAfterFirst).toBe(1);

    // 造一份「在飞」的现场：复用真跑出来的 manifest/指纹，只把执行态换成 queued。
    // 这是库里可以真实存在的形态（上一进程在 run 起步后崩掉、或以后接上队列时的排队单），
    // 不是为了让断言通过而发明的状态。
    const host = inst.booted.db
      .prepare("select pipeline_manifest, pipeline_fingerprint from parse_run where id = ?")
      .get(first.json.runId as string) as { pipeline_manifest: string; pipeline_fingerprint: string };
    inst.booted.db
      .prepare(
        `insert into parse_run
           (id, source_revision_id, pipeline_manifest, pipeline_fingerprint, idempotency_key,
            execution_status, result_state, started_at_utc)
         values ('run_m8_2_inflight', ?, ?, ?, 'k_m8_2_inflight', 'queued', 'candidate', ?)`,
      )
      .run(revisionId, host.pipeline_manifest, host.pipeline_fingerprint, FIXTURE_NOW);

    const reanalyze = await call(inst, "POST", `/api/ingest/records/${recordId}/reanalyze`);

    expect(reanalyze.status).toBe(409);
    expect(reanalyze.json.error).toBe("state_conflict");
    // detail 报得出挡路的那一单，且一个字的原文都不带。
    expect(reanalyze.json.detail).toContain("run_m8_2_inflight");
    expect(reanalyze.json.detail).toContain("queued");
    expect(reanalyze.json.detail).not.toContain(LOCAL_RAW);
    expect(inst.transport.callCount()).toBe(callsAfterFirst);
    // parse 那一行 + 夹具那一行：被拒的这一单没有落库。
    expect(runsFor(inst, revisionId)).toBe(2);
  });

  it("无 grant 的外发记录：reanalyze 与 parse 回同一个状态、同一个错误体，零外发、零 run", async () => {
    const inst = await startInstance();
    const { recordId, revisionId } = await createRecordViaHttp(inst, LOCAL_RAW, "cloud_redacted");

    const parse = await call(inst, "POST", "/api/ingest/parse", { recordId });
    const reanalyze = await call(inst, "POST", `/api/ingest/records/${recordId}/reanalyze`);

    expect(parse.status).toBe(409);
    expect(parse.json.error).toBe("state_conflict");
    expect(reanalyze.status).toBe(parse.status);
    expect(reanalyze.json.error).toBe(parse.json.error);
    // 同一条消息：闸门是同一个抛点，重新分析没有换一个更松的口径。
    expect(reanalyze.json.detail).toBe(parse.json.detail);
    expect(inst.transport.callCount()).toBe(0);
    expect(runsFor(inst, revisionId)).toBe(0);
  });

  it("manual_only 与占位档的拒绝同样一致：reanalyze 不绕开 op2 的任何一道前置门", async () => {
    const inst = await startInstance();
    const { recordId } = await createRecordViaHttp(inst, LOCAL_RAW, "manual_only");

    const parse = await call(inst, "POST", "/api/ingest/parse", { recordId });
    const reanalyze = await call(inst, "POST", `/api/ingest/records/${recordId}/reanalyze`);

    expect(parse.status).toBe(409);
    expect(reanalyze.status).toBe(parse.status);
    expect(reanalyze.json.detail).toBe(parse.json.detail);
    expect(inst.transport.callCount()).toBe(0);
  });

  it("本地轨接线：还没分析过的记录走 reanalyze ⇒ 同一道闸门、第一单仍是旧键形状", async () => {
    const inst = await startInstance();
    const { recordId, revisionId } = await createRecordViaHttp(inst, LOCAL_RAW, "local_model");

    const reanalyze = await call(inst, "POST", `/api/ingest/records/${recordId}/reanalyze`);

    expect(reanalyze.status).toBe(200);
    expect(reanalyze.json.succeeded).toBe(true);
    // 这一版本名下 0 行 ⇒ attempt = 1 ⇒ 不带后缀（M8-D-4：第 1 单的键逐字向后兼容）。
    expect(/_a\d+$/.test(reanalyze.json.idempotencyKey as string)).toBe(false);
    expect(reanalyze.json.idempotencyKey).toBe(
      deriveIdempotencyKey(revisionId, reanalyze.json.pipelineFingerprint as string),
    );
    expect(runsFor(inst, revisionId)).toBe(1);
    expect(inst.transport.callCount()).toBe(1);
  });

  it("op5 reparse 的既有语义未被改动：同幂等入口重放同一个 run，不新增行", async () => {
    const inst = await startInstance();
    const { recordId, revisionId } = await createRecordViaHttp(inst, LOCAL_RAW, "local_model");
    const first = await call(inst, "POST", "/api/ingest/parse", { recordId });
    expect(first.status).toBe(200);

    const reparse = await call(inst, "POST", `/api/ingest/records/${recordId}/reparse`);

    expect(reparse.status).toBe(200);
    expect(reparse.json.runId).toBe(first.json.runId);
    expect(reparse.json.idempotencyKey).toBe(first.json.idempotencyKey);
    expect(reparse.json.replayed).toBe(true);
    expect(runsFor(inst, revisionId)).toBe(1);
    expect(inst.transport.callCount()).toBe(1);
  });

  it("路由挂在 ingest 面之内：GET 与坏 recordId 不会静默成功", async () => {
    const inst = await startInstance();
    const { recordId } = await createRecordViaHttp(inst, LOCAL_RAW, "local_model");

    const wrongMethod = await call(inst, "GET", `/api/ingest/records/${recordId}/reanalyze`);
    const missing = await call(inst, "POST", `/api/ingest/records/rec_不存在的记录/reanalyze`);

    // 未匹配的路径由 ingest 面接管后落到 404/405 口径，绝不返回一个成功的解析结果。
    expect(wrongMethod.status).toBeGreaterThanOrEqual(400);
    expect(missing.status).toBe(404);
    expect(missing.json.error).toBe("not_found");
  });
});

/* ── R7 ─────────────────────────────────────────────────────────── */

describe("R7 非当前 revision：reanalyze 与 parse 同口径被拒", () => {
  it("旧版本的 reanalysis 抛同一个错误类、同一条消息，且不建 run、不调 provider", async () => {
    const { recordId, revisionId } = setup();
    const stub = stubTransport(OK_ENVELOPE(validOutput()));
    const service = makeService(stub);
    await service.ingest({ recordRevisionId: revisionId });
    expect(stub.callCount()).toBe(1);

    // 编辑 ⇒ 新 revision 成为 current，revisionId 退成历史版本。
    const records = new RecordService(liveDb(), {
      timezoneId: FIXTURE_TIMEZONE,
      now: () => new Date(FIXTURE_NOW),
    });
    const edited = records.editRecord(recordId, `${LOCAL_RAW}，后来又补了一句`);
    expect(edited.changed).toBe(true);
    expect(edited.revision.id).not.toBe(revisionId);

    const parse = await captureError(() => service.ingest({ recordRevisionId: revisionId }));
    const reanalyze = await captureError(() =>
      service.ingest({ recordRevisionId: revisionId, reanalysis: true }),
    );

    expect(parse).toBeInstanceOf(IngestInputError);
    expect(reanalyze).toBeInstanceOf(IngestInputError);
    expect((reanalyze as Error).message).toBe((parse as Error).message);
    expect((parse as Error).message).toContain("current_revision");
    // 被拒的两次都没有落任何 run，也没有多调一次模型。
    expect(countRows(liveDb(), "parse_run")).toBe(1);
    expect(stub.callCount()).toBe(1);
  });

  it("新版本自己重跑：reanalysis 缺席时与 parse 落在同一个键上（重放而非第二单）", async () => {
    const { recordId, revisionId } = setup();
    const stub = stubTransport(OK_ENVELOPE(validOutput()));
    const service = makeService(stub);
    await service.ingest({ recordRevisionId: revisionId });
    const records = new RecordService(liveDb(), {
      timezoneId: FIXTURE_TIMEZONE,
      now: () => new Date(FIXTURE_NOW),
    });
    const next = records.editRecord(recordId, `${LOCAL_RAW}，后来又补了一句`).revision.id;

    const parsed = await service.ingest({ recordRevisionId: next });
    const replay = await service.ingest({ recordRevisionId: next });

    expect(parsed.replayed).toBe(false);
    expect(replay.runId).toBe(parsed.runId);
    expect(replay.idempotencyKey).toBe(parsed.idempotencyKey);
    // 一条新 revision 上的 run 与旧 revision 上的 run 互不相干（键按 revision 分组）。
    expect(parsed.idempotencyKey).not.toBe(runsOf(revisionId)[0]!.key);
    expect(countRows(liveDb(), "parse_run")).toBe(2);
  });
});

/* ── §4.1.4 前端「重新分析」入口 ─────────────────────────────────── */

/**
 * 本仓 UI 惯例：vitest 跑在 node 环境（没有 DOM），所以接线断言落在源码上。
 * 钉的是四条：无 body 的调用形状、显示条件的数据来源、两句必须说清的代价、忙态与回话走既有通道。
 */
describe("M8-2 §4.1.4 前端：记录详情的「重新分析」动作", () => {
  const client = sourceAt("src/web/apiClient.ts");
  const detail = sourceAt("src/web/RecordDetail.tsx");

  it("调用面是 POST 且一个请求体都不发（服务端不读 body）", () => {
    const call = /ingestReanalyze:[\s\S]{0,300}?\n\s{4}\}\),/.exec(client)?.[0] ?? "";
    expect(call, "apiClient 里要有 ingestReanalyze 这一格").not.toBe("");
    expect(call).toContain("/api/ingest/records/${encodeURIComponent(recordId)}/reanalyze");
    expect(call).toContain('method: "POST"');
    // 不走 `jsonCall`：那条口子会把请求体序列化出去，而这个端点压根不读 body。
    expect(call).not.toContain("jsonCall");
    expect(call).not.toContain("JSON.stringify");
  });

  it("显示条件只看这一页已经读回来的 run 历史，且一次都没成功过的版本没有这个动作", () => {
    const guard = /function hasSucceededRun[\s\S]*?\n}/.exec(detail)?.[0] ?? "";
    expect(guard, "判据要抽成一个具名函数，别散在 JSX 里").not.toBe("");
    expect(guard).toContain('item.executionStatus === "succeeded"');
    expect(guard).toContain("runHistory");
    // 判据不取数：不为此新开一次 op9，也没有第四份界面状态。
    expect(guard).not.toMatch(/\bapi\./);
    expect(detail).toMatch(/if \(!hasSucceededRun\(props\.effective\)\) return null/);
  });

  it("文案说清两条代价：再调用一次模型、产出仍是候选", () => {
    expect(detail).toContain("这会再调用一次模型");
    expect(detail).toContain("新产出要采纳才生效");
    expect(detail).toContain("已重新分析：这一次的结果还是候选，要你采纳才生效");
  });

  it("走既有的 runAction / ActionOutcome 通道；409 的原话由 ApiError.detail 原样上屏", () => {
    expect(detail).toContain("await api.ingestReanalyze(record.id)");
    expect(detail).toContain("onReanalyze={() => void runAction(() => reanalyze())}");
    // 在途那一次拒绝（M8-D-8 的 409）不靠界面猜：runAction 里那句 detail 是这个动作唯一的落点。
    const runner = /async function runAction[\s\S]*?\n  \}/.exec(detail)?.[0] ?? "";
    expect(runner).toContain("cause instanceof ApiError ? cause.detail");
    expect(runner).toContain("setActionBusy(true)");
  });

  it("不做自动轮询、不接后台队列", () => {
    expect(detail).not.toMatch(/\bsetInterval\b|\bsetTimeout\b/);
    expect(detail).not.toMatch(/\benqueueJob\b|\blistJobs\b|\bpoll\b/);
  });
});
