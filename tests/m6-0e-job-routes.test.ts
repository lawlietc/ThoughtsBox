import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import { boot, shutdown, type BootResult } from "../src/server/runtime/bootstrap.ts";
import { ensureConfigFile } from "../src/server/config/config.ts";
import { resolveDataLayout, type DataLayout } from "../src/server/config/paths.ts";
import { JOB_STATUSES, JobStore, type JobRow, type JobVersions } from "../src/server/jobs/jobStore.ts";
import { axesForProcessingMode } from "../src/shared/contracts/enums.ts";
import { JOB_STATUS_DTO_VALUES } from "../src/shared/dto.ts";
import type { TransportResponse } from "../src/server/ingest/provider.ts";
import { makeSandbox, type Sandbox } from "./helpers/sandbox.ts";
import {
  FIXTURE_NOW,
  LOCAL_RAW,
  OK_ENVELOPE,
  SYSTEM_PROMPT,
  envelope,
  makeAdapter,
  stubTransport,
  validOutput,
} from "./helpers/ingestFixtures.ts";

/**
 * M6-0E 第二批 B：后台任务队列的**观测与取消**面（轮询）+ 同步入口取消同 revision 的排队任务。
 *
 * 被测的是三条对外承诺：
 *  1. `GET /api/jobs?recordId=…` 只投影 `JobViewDto`，任务行的 `snapshot_json` 里只出
 *     `send_content_mode` 一项（草案 §二 要点：内容不在任务行上，故原文与脱敏映射无从带出）。
 *  2. `POST /api/jobs/:id/cancel` 是服务层 `requestCancel` 的直通：queued 直接终态、
 *     在途只置请求位、终态幂等返回，路由不自己判状态。
 *  3. 同步入口（op2）真的做完之后，同 revision 的 queued 任务作废；失败时一个都不动。
 *
 * 全程真实 HTTP + 沙箱数据目录（`TB_DATA_DIR` 指到 mkdtemp），Provider 用注入的假 transport，
 * 起服务方式与 `m1a-api` / `m2-api` 一致。
 */

const SENTINEL = "👍张三说打 13800138000 给 laowang@example.com 或老周";
/** 快照里的运维明细：它们留在库里，一个都不上线。 */
const VERSIONS: JobVersions = {
  promptVersion: "m2-prompt-v1",
  schemaVersion: "m2-output-v1",
  modelId: "qwen2.5:7b",
  redactionPolicyVersion: "rules-v1",
};
/** 入队夹具的时钟基线：每次入队推高 1 秒，`created_at_utc` 因此严格递增（时间序断言的前提）。 */
const T0 = Date.parse("2026-10-25T09:00:00.000Z");

/** `JobViewDto` 的全部键：响应里多一个键（少一个键）都算偏离契约，故按集合逐一对账。 */
const JOB_VIEW_KEYS = [
  "attempts",
  "cancelRequested",
  "createdAtUtc",
  "errorKind",
  "finishedAtUtc",
  "id",
  "recordId",
  "recordRevisionId",
  "sendContentMode",
  "startedAtUtc",
  "status",
  "updatedAtUtc",
];

interface Instance {
  readonly booted: BootResult;
  readonly box: Sandbox;
  readonly base: string;
}

const instances: Instance[] = [];

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

/**
 * 起一个带 Provider 桩的实例。`response` 决定模型这一次回什么：默认回合法结果
 * （同步入口成功），传一份坏 JSON 则得到「HTTP 200 但任务失败」那一支——断言 6 的
 * 失败半边要的正是这一支，因为抛错的失败（409/503）根本走不到收尾那一步。
 */
async function startInstance(response?: TransportResponse): Promise<Instance> {
  const port = await testPort();
  const box = makeSandbox("tb-m6-0e-routes-");
  writePort(box.layout, port);
  const stub = stubTransport(response ?? OK_ENVELOPE(validOutput()));
  const booted = await boot({
    env: { TB_DATA_DIR: box.root, USERPROFILE: box.root, HOME: box.root },
    log: () => {},
    // M6-1D 接线后 boot 默认会把队列跑起来；本文件观察的是**路由面**，行必须由夹具留着原状，
    // 所以在跑 worker 的循环会把这里排的任务取走。关掉它不是削弱断言，是保住断言的前提。
    startJobsWorker: false,
    ingestProvider: {
      adapter: makeAdapter(),
      transport: stub.transport,
      systemPrompt: SYSTEM_PROMPT,
      now: () => new Date(FIXTURE_NOW),
    },
  });
  const inst: Instance = { booted, box, base: `http://127.0.0.1:${port}` };
  instances.push(inst);
  return inst;
}

afterEach(async () => {
  while (instances.length > 0) {
    const inst = instances.pop();
    if (inst === undefined) break;
    await shutdown(inst.booted);
    inst.box.cleanup();
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

// ── 队列夹具 ────────────────────────────────────────────────────────

let clock = 0;

function storeOf(inst: Instance): JobStore {
  clock += 1;
  return new JobStore(inst.booted.db, { now: () => new Date(T0 + clock * 1000) });
}

/** 入队并返回那一行；时钟由 `storeOf` 推进，故多次入队的 `created_at_utc` 严格递增。 */
function enqueue(
  inst: Instance,
  revisionId: string,
  axes = axesForProcessingMode("cloud_redacted"),
  versions: JobVersions = VERSIONS,
): JobRow {
  return storeOf(inst).enqueue({ recordRevisionId: revisionId, axes, versions }).row;
}

function rowOf(inst: Instance, id: string): JobRow {
  const row = storeOf(inst).get(id);
  if (row === null) throw new Error(`任务行不存在：${id}`);
  return row;
}

/** 建一条记录（默认云端脱敏档），返回两个指针。 */
async function makeRecord(
  inst: Instance,
  text = SENTINEL,
  mode = "cloud_redacted",
): Promise<{ recordId: string; revisionId: string }> {
  const created = inst.booted.workspace.records.createRecord(text, mode);
  // A-0 起 cloud_redacted 默认 local_llm；这一批的断言以规则档为基线，显式落回 manual。
  if (mode === "cloud_redacted") {
    inst.booted.workspace.records.setRedactionMode(created.record.id, "manual");
  }
  return { recordId: created.record.id, revisionId: created.revision.id };
}

/** 造一个真正的新 revision（B13：文本变了才建版）。 */
function editRecord(inst: Instance, recordId: string, text: string): string {
  const edited = inst.booted.workspace.records.editRecord(recordId, text);
  if (!edited.changed) throw new Error(`夹具没能建出新 revision：${text}`);
  return edited.revision.id;
}

// ── 静态对账 ────────────────────────────────────────────────────────

describe("状态清单的静态对账（共享 DTO ↔ 服务层）", () => {
  it("JOB_STATUS_DTO_VALUES 与 jobStore 的 JOB_STATUSES 逐字同值、同序", () => {
    // 两份声明是刻意的（dto.ts 属共享层，不能 import 服务端模块），一致性靠这条钉住。
    // 与迁移 0010 的 CHECK 清单对账由 m6-0e-job-store 那份测试负责，这里不重复钉。
    expect([...JOB_STATUS_DTO_VALUES]).toEqual([...JOB_STATUSES]);
    expect(JOB_STATUS_DTO_VALUES.join("|")).toBe(JOB_STATUSES.join("|"));
    expect(new Set(JOB_STATUSES).size).toBe(JOB_STATUSES.length);
  });
});

// ── GET /api/jobs ───────────────────────────────────────────────────

describe("GET /api/jobs?recordId=…（轮询观测面）", () => {
  it("该记录没有任务 ⇒ { jobs: [] }（空列表是「还没任务」，不是错误）", async () => {
    const inst = await startInstance();
    const { recordId } = await makeRecord(inst);
    const r = await call(inst, "GET", `/api/jobs?recordId=${recordId}`);
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ jobs: [] });
  });

  it("缺 recordId ⇒ 400 invalid_request；空串同样 400；记录不存在 ⇒ 404 not_found", async () => {
    const inst = await startInstance();
    const missing = await call(inst, "GET", "/api/jobs");
    expect(missing.status).toBe(400);
    expect(missing.json.error).toBe("invalid_request");

    const blank = await call(inst, "GET", "/api/jobs?recordId=");
    expect(blank.status).toBe(400);
    expect(blank.json.error).toBe("invalid_request");

    const phantom = await call(inst, "GET", "/api/jobs?recordId=rec_不存在");
    expect(phantom.status).toBe(404);
    expect(phantom.json.error).toBe("not_found");
    // 轮询一条已删除的记录必须是 404：返回空列表会被前端读成「还没任务」而一直等下去。
    expect(phantom.json.jobs).toBeUndefined();
  });

  it("两行任务 ⇒ 时间序从旧到新、字段齐全、send_content_mode 逐行取自快照", async () => {
    const inst = await startInstance();
    const { recordId, revisionId } = await makeRecord(inst);
    const first = enqueue(inst, revisionId); // 云端脱敏档
    const rev2 = editRecord(inst, recordId, `${SENTINEL}（第二版）`);
    const second = enqueue(inst, rev2, axesForProcessingMode("cloud_raw"));

    const r = await call(inst, "GET", `/api/jobs?recordId=${recordId}`);
    expect(r.status).toBe(200);
    expect(r.json.jobs).toHaveLength(2);
    expect(r.json.jobs[0].id).toBe(first.id);
    expect(r.json.jobs[1].id).toBe(second.id);
    expect(r.json.jobs[0].createdAtUtc < r.json.jobs[1].createdAtUtc).toBe(true);

    // 形状：键集合逐字等于 DTO 声明，不许多也不许可少（多个键就是外泄面，少一个键前端就断轨）。
    for (const job of r.json.jobs) {
      expect(Object.keys(job).sort()).toEqual(JOB_VIEW_KEYS);
    }
    expect(r.json.jobs[0]).toMatchObject({
      recordId,
      recordRevisionId: revisionId,
      status: "queued",
      attempts: 0,
      errorKind: null,
      cancelRequested: false,
      sendContentMode: "redacted",
      startedAtUtc: null,
      finishedAtUtc: null,
    });
    expect(r.json.jobs[1].sendContentMode).toBe("raw");
    expect(r.json.jobs[0].id).toMatch(/^pjob_/);
  });

  it("响应文本不含原文、不含 snapshot_json、不含脱敏映射，也不含快照里的运维明细", async () => {
    const inst = await startInstance();
    const { recordId, revisionId } = await makeRecord(inst);
    enqueue(inst, revisionId);

    const r = await call(inst, "GET", `/api/jobs?recordId=${recordId}`);
    expect(r.status).toBe(200);
    for (const forbidden of [
      SENTINEL,
      "张三",
      "13800138000",
      "laowang@example.com",
      "snapshot_json",
      "snapshot",
      "redactionMap",
      "redaction_map",
      '"map"',
      "spans",
      "placeholder",
      "idempotency_key",
      VERSIONS.modelId,
      VERSIONS.promptVersion,
      VERSIONS.schemaVersion,
      VERSIONS.redactionPolicyVersion,
    ]) {
      expect(r.text, `响应里出现了不该出现的 ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("只列本记录的任务；队列面不接的方法（DELETE）⇒ 405，不被别的前缀接管", async () => {
    const inst = await startInstance();
    const mine = await makeRecord(inst);
    const other = await makeRecord(inst, "另一条记录的内容", "local_model");
    enqueue(inst, mine.revisionId);
    enqueue(inst, other.revisionId, axesForProcessingMode("local_model"));

    const r = await call(inst, "GET", `/api/jobs?recordId=${mine.recordId}`);
    expect(r.json.jobs).toHaveLength(1);
    expect(r.json.jobs[0].recordId).toBe(mine.recordId);

    // M6-1D 起 POST /api/jobs 是**入队**接口，不再是「本前缀下的陌生方法」；
    // 这一格要证的还是「队列面接管了这个前缀，但它不认的方法一律 405」，换成 DELETE 同样成立。
    const wrongMethod = await call(inst, "DELETE", "/api/jobs", {});
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.json.error).toBe("method_not_allowed");
  });
});

// ── POST /api/jobs/:id/cancel ───────────────────────────────────────

describe("POST /api/jobs/:id/cancel（服务层三分支的直通）", () => {
  it("queued ⇒ 200 且直接终态 canceled，库里同一行同值", async () => {
    const inst = await startInstance();
    const { recordId, revisionId } = await makeRecord(inst);
    const job = enqueue(inst, revisionId);

    const r = await call(inst, "POST", `/api/jobs/${job.id}/cancel`);
    expect(r.status).toBe(200);
    expect(r.json.status).toBe("canceled");
    expect(r.json.cancelRequested).toBe(false); // queued 的取消是直接终态，不是「请求」
    expect(r.json.finishedAtUtc).not.toBeNull();
    expect(r.json.recordId).toBe(recordId);

    const row = rowOf(inst, job.id);
    expect(row.status).toBe("canceled");
    expect(row.cancel_requested).toBe(0);
    expect(row.finished_at_utc).toBe(r.json.finishedAtUtc);
  });

  it("重复取消 ⇒ 200 同一行（幂等，第二次不写库）", async () => {
    const inst = await startInstance();
    const { revisionId } = await makeRecord(inst);
    const job = enqueue(inst, revisionId);

    const first = await call(inst, "POST", `/api/jobs/${job.id}/cancel`);
    const second = await call(inst, "POST", `/api/jobs/${job.id}/cancel`);
    expect(second.status).toBe(200);
    expect(second.json).toEqual(first.json);
  });

  it("在途任务 ⇒ 200 且只是请求位：status 仍在途，cancelRequested=true", async () => {
    const inst = await startInstance();
    const { revisionId } = await makeRecord(inst);
    const job = enqueue(inst, revisionId);
    storeOf(inst).transition(job.id, "redacting"); // 合法边：queued → redacting（worker 已取走）

    const r = await call(inst, "POST", `/api/jobs/${job.id}/cancel`);
    expect(r.status).toBe(200);
    expect(r.json.status).toBe("redacting");
    expect(r.json.cancelRequested).toBe(true);
    expect(r.json.finishedAtUtc).toBeNull(); // 终态由 worker 的检查点写，这里不抢

    const row = rowOf(inst, job.id);
    expect(row.status).toBe("redacting");
    expect(row.cancel_requested).toBe(1);
    expect(row.finished_at_utc).toBeNull();
  });

  it("不存在的任务 id ⇒ 404 not_found，且不回显 id", async () => {
    const inst = await startInstance();
    const phantom = "pjob_不存在";
    const r = await call(inst, "POST", `/api/jobs/${phantom}/cancel`);
    expect(r.status).toBe(404);
    expect(r.json.error).toBe("not_found");
    expect(r.text).not.toContain(phantom);
  });

  it("取消路径只认 POST ⇒ 405", async () => {
    const inst = await startInstance();
    const { revisionId } = await makeRecord(inst);
    const job = enqueue(inst, revisionId);
    const r = await call(inst, "GET", `/api/jobs/${job.id}/cancel`);
    expect(r.status).toBe(405);
  });
});

// ── 断言 6：同步入口 vs 队列 ────────────────────────────────────────

describe("断言 6：同步入口只取消同 revision 的排队任务", () => {
  it("造一条 queued ⇒ 一次成功的同步 ingest（op2）后它转为 canceled", async () => {
    const inst = await startInstance();
    const { recordId, revisionId } = await makeRecord(inst, LOCAL_RAW, "local_model");
    const job = enqueue(inst, revisionId, axesForProcessingMode("local_model"));
    expect(rowOf(inst, job.id).status).toBe("queued");

    const parse = await call(inst, "POST", "/api/ingest/parse", { recordId });
    expect(parse.status).toBe(200);
    expect(parse.json.succeeded).toBe(true);

    const row = rowOf(inst, job.id);
    expect(row.status).toBe("canceled");
    expect(row.finished_at_utc).not.toBeNull();
    // 库里那一行直接进终态、不带请求位：queued 还没开跑，没有半成品要收拾。
    expect(row.cancel_requested).toBe(0);

    const list = await call(inst, "GET", `/api/jobs?recordId=${recordId}`);
    expect(list.json.jobs).toHaveLength(1);
    expect(list.json.jobs[0].status).toBe("canceled");
  });

  it("越界的三类一个都不动：在途行、旧 revision 的排队行、别条记录的行", async () => {
    const inst = await startInstance();
    const { recordId, revisionId: rev1 } = await makeRecord(inst, LOCAL_RAW, "local_model");
    const other = await makeRecord(inst, "另一条记录，同样排队", "local_model");

    // rev1 上摆两行：一行已被 worker 取走（在途），一行还在排队。
    const inFlight = enqueue(inst, rev1, axesForProcessingMode("local_model"));
    storeOf(inst).transition(inFlight.id, "redacting");
    const queuedOldRevision = enqueue(inst, rev1, axesForProcessingMode("local_model"), {
      ...VERSIONS,
      modelId: "qwen3:8b",
    });
    const otherJob = enqueue(inst, other.revisionId, axesForProcessingMode("local_model"));

    // 编辑产生 rev2 并成为 current ⇒ 同步入口这一次跑的是 rev2。
    const rev2 = editRecord(inst, recordId, `${LOCAL_RAW}（改过一次）`);
    const current = enqueue(inst, rev2, axesForProcessingMode("local_model"), {
      ...VERSIONS,
      modelId: "llama3:8b",
    });

    const parse = await call(inst, "POST", "/api/ingest/parse", { recordId });
    expect(parse.json.succeeded).toBe(true);
    expect(rowOf(inst, current.id).status).toBe("canceled");

    // 在途的归 worker 的检查点管；跨 revision 的取代是 `supersedeQueuedJobs` 那条路径（阶段 1 接线），
    // 都不归本批的「同步入口成功后作废」管。
    expect(rowOf(inst, inFlight.id).status).toBe("redacting");
    expect(rowOf(inst, queuedOldRevision.id).status).toBe("queued");
    expect(rowOf(inst, otherJob.id).status).toBe("queued");

    const list = await call(inst, "GET", `/api/jobs?recordId=${recordId}`);
    const byId = new Map<string, string>(list.json.jobs.map((j: any) => [j.id as string, j.status as string]));
    expect(byId.get(current.id)).toBe("canceled");
    expect(byId.get(inFlight.id)).toBe("redacting");
    expect(byId.get(queuedOldRevision.id)).toBe("queued");
  });

  it("失败是数据（HTTP 200 + succeeded=false）⇒ 排队任务仍是 queued，一条不丢", async () => {
    const inst = await startInstance({ status: 200, body: envelope("这不是一个合法 JSON 对象") });
    const { recordId, revisionId } = await makeRecord(inst, LOCAL_RAW, "local_model");
    const job = enqueue(inst, revisionId, axesForProcessingMode("local_model"));

    const parse = await call(inst, "POST", "/api/ingest/parse", { recordId });
    expect(parse.status).toBe(200);
    expect(parse.json.succeeded).toBe(false);

    const row = rowOf(inst, job.id);
    expect(row.status).toBe("queued");
    expect(row.cancel_requested).toBe(0);
    expect(row.finished_at_utc).toBeNull();
  });

  it("失败是错误（授权闸门 409，抛出前零写入）⇒ 排队任务仍是 queued", async () => {
    const inst = await startInstance();
    const { recordId, revisionId } = await makeRecord(inst); // cloud_redacted：没有本次授权
    const job = enqueue(inst, revisionId);

    const parse = await call(inst, "POST", "/api/ingest/parse", { recordId });
    expect(parse.status).toBe(409);
    expect(parse.json.error).toBe("state_conflict");

    expect(rowOf(inst, job.id).status).toBe("queued");
  });

  it("响应形状未动：成功支的 op2 仍是原来的 IngestResultDto，不因队列接线多字段", async () => {
    const inst = await startInstance();
    const { recordId, revisionId } = await makeRecord(inst, LOCAL_RAW, "local_model");
    enqueue(inst, revisionId, axesForProcessingMode("local_model"));

    const parse = await call(inst, "POST", "/api/ingest/parse", { recordId });
    const keys = Object.keys(parse.json).sort();
    expect(keys).toEqual(
      [
        "attemptedPaths",
        "autoAdopted",
        "axes",
        "callPath",
        "degraded",
        "errorKind",
        "failure",
        "idempotencyKey",
        "model",
        "pipelineFingerprint",
        "processingMode",
        "provider",
        "recovered",
        "replayed",
        "runId",
        "succeeded",
        "summary",
        "title",
        "writes",
      ].sort(),
    );
    // 队列这一个字都没进同步入口的响应（用户要观察任务请走 /api/jobs，两套形状不混）。
    expect(parse.text).not.toContain("privacy_job");
    expect(parse.text).not.toContain('"jobs"');
  });

  it("op5 重跑同样收口：同 revision 的 queued 在成功后作废", async () => {
    const inst = await startInstance();
    const { recordId, revisionId } = await makeRecord(inst, LOCAL_RAW, "local_model");
    const first = await call(inst, "POST", "/api/ingest/parse", { recordId });
    expect(first.json.succeeded).toBe(true);

    const job = enqueue(inst, revisionId, axesForProcessingMode("local_model"));
    const reparse = await call(inst, "POST", `/api/ingest/records/${recordId}/reparse`);
    expect(reparse.status).toBe(200);
    expect(reparse.json.replayed).toBe(true); // 同 revision + 同管线 = 重放，也算「这件事已做完」
    expect(rowOf(inst, job.id).status).toBe("canceled");
  });
});

// ── 前缀归属 ────────────────────────────────────────────────────────

describe("路由链上的前缀归属", () => {
  it("/api/jobs 由队列面接管，`/api/jobs` 之外的相近前缀仍落到 404 兜底", async () => {
    const inst = await startInstance();

    // 挂在 /api/jobs 前缀下的未知形状：由队列面裁决成 405，而不是穿透到 ingest 或 404。
    const unknownSubpath = await call(inst, "GET", "/api/jobs/没有这个形状的路径");
    expect(unknownSubpath.status).toBe(405);
    expect(unknownSubpath.json.error).toBe("method_not_allowed");

    // 少一个字母的前缀不属于队列面：整条链无人认领 ⇒ 404，与被接管是两件事。
    const unrelated = await call(inst, "GET", "/api/jobq?recordId=x");
    expect(unrelated.status).toBe(404);
    expect(unrelated.json.error).toBe("not_found");
  });
});
