import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import { ensureConfigFile } from "../src/server/config/config.ts";
import type { DataLayout } from "../src/server/config/paths.ts";
import { boot, shutdown, type BootResult } from "../src/server/runtime/bootstrap.ts";
import { getMeta } from "../src/server/db/migrator.ts";
import type { ProviderTransport, TransportResponse } from "../src/server/ingest/provider.ts";
import { makeEgressGrantRunnable, makeIngestExecutor } from "../src/server/jobs/ingestExecutor.ts";
import { JobLease, leaseKeyOf } from "../src/server/jobs/jobLease.ts";
import { JobStore, type JobRow, type JobVersions } from "../src/server/jobs/jobStore.ts";
import { DEFAULT_LEASE_MS, JobWorker } from "../src/server/jobs/jobWorker.ts";
import { axesForProcessingMode, type ProcessingModeValue } from "../src/shared/contracts/enums.ts";
import {
  FIXTURE_NOW,
  LOCAL_RAW,
  OK_ENVELOPE,
  SYSTEM_PROMPT,
  makeAdapter,
  stubTransport,
  validOutput,
} from "./helpers/ingestFixtures.ts";
import { makeSandbox, type Sandbox } from "./helpers/sandbox.ts";

/**
 * M6-1D：后台队列的**接线**与**手动入队**。
 *
 * 被测的七组承诺：
 *  ① 启动恢复走的是生产装配路径（第二次 boot 的 `start()` 里那次 `recover()`），不是夹具路径；
 *  ② provider 未就绪时队列原地不动（取活之前就判，不消耗 attempts）；
 *  ③ `POST /api/jobs` 的手动入队面：201/200/404/409/503 各归位；
 *  ④ 失败路径回归：接上 worker 之后 op2/op6/op7 的拒因一个都没漏、也没有多出一个入口漏判；
 *  ⑤ `stop()` 不掐断在跑的那一拍；
 *  ⑥ 结构纪律：路由不碰库句柄、执行体不写 `privacy_job`、shutdown 顺序写在码上；
 *  ⑦ 租约归属（裁决 ①-b）：`app_meta` 里那条 `job_lease:<id>` 是「这一行现在归谁」的权威，
 *     回收与取消都读它，不再只读 `updated_at_utc` 这一个时刻。
 *
 * 全程真实 HTTP + `TB_DATA_DIR` 沙箱，模型调用一律由注入的假 transport 驱动。
 * 观察路由/存储面的用例传 `startJobsWorker: false`（否则 worker 循环会取走夹具排的行——
 * 那是断言的前提被破坏，不是断言被削弱）；观察队列推进的用例用默认值。
 */

const CLOUD_RAW_TEXT = "周末和张三去了蓝山咖啡馆，聊了三个小时";
/** 快照四段版本标识：入队夹具用固定值，断言只关心状态与归属，不关心运维明细。 */
const VERSIONS: JobVersions = {
  promptVersion: "m2-prompt-v1",
  schemaVersion: "m2-output-v1",
  modelId: "qwen2.5:7b",
  redactionPolicyVersion: "rules-v1",
};
/** 夹具时钟基线：每次入队推高 1 秒，`created_at_utc` 因此严格递增。 */
const T0 = Date.now();
/** 「早就过期」：比现在早 24 小时，远超 `DEFAULT_LEASE_MS`（相对值，不依赖今天几号）。 */
const LONG_AGO = T0 - 24 * 60 * 60_000;

/** `JobViewDto` 的全部键：多一个键（少一个键）都算偏离契约，故按集合逐一对账。 */
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

const live: Instance[] = [];

async function freePort(): Promise<number> {
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
      probe.close(() => resolve(address.port));
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

interface InstanceOptions {
  /** 是否注入 Provider 面。`false` ⇒ `ingestReady=false`，即「解析能力未就绪」。 */
  readonly provider: boolean;
  readonly startJobsWorker?: boolean;
  readonly jobsPollIntervalMs?: number;
  /** 自定义 transport（慢响应/失败剧本）；省略即用默认的一次合法回稿。 */
  readonly transport?: ProviderTransport;
}

/**
 * 在给定沙箱上起一个实例。同一个 `box` 可以先后起两次（前一个必须已 shutdown——运行锁是独占的），
 * ①「重启后的启动恢复」要的就是这条两次启动的路径。
 */
async function bootOn(box: Sandbox, options: InstanceOptions): Promise<Instance> {
  const port = await freePort();
  writePort(box.layout, port);
  const stub = stubTransport(OK_ENVELOPE(validOutput()));
  const booted = await boot({
    env: { TB_DATA_DIR: box.root, USERPROFILE: box.root, HOME: box.root },
    log: () => {},
    ...(options.startJobsWorker === undefined ? {} : { startJobsWorker: options.startJobsWorker }),
    ...(options.jobsPollIntervalMs === undefined ? {} : { jobsPollIntervalMs: options.jobsPollIntervalMs }),
    ...(options.provider
      ? {
          ingestProvider: {
            adapter: makeAdapter(),
            transport: options.transport ?? stub.transport,
            systemPrompt: SYSTEM_PROMPT,
            now: () => new Date(FIXTURE_NOW),
          },
        }
      : {}),
  });
  const inst: Instance = { booted, box, base: `http://127.0.0.1:${port}` };
  live.push(inst);
  return inst;
}

async function startInstance(options: InstanceOptions): Promise<Instance> {
  return bootOn(makeSandbox("tb-m6-1d-"), options);
}

/** 显式收掉一个实例（用于同一目录上的第二次启动），并从清理表里摘掉。 */
async function stopInstance(inst: Instance): Promise<void> {
  const index = live.indexOf(inst);
  if (index >= 0) live.splice(index, 1);
  await shutdown(inst.booted);
}

afterEach(async () => {
  while (live.length > 0) {
    const inst = live.pop();
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

/** 夹具用的存储：默认时钟每次推高 1 秒；显式传 `now` 时用来摆「过期/未过期」两种现场。 */
function fixtureStore(inst: Instance, now?: () => Date): JobStore {
  clock += 1;
  return new JobStore(inst.booted.db, { now: now ?? (() => new Date(T0 + clock * 1000)) });
}

function enqueueRow(inst: Instance, revisionId: string, mode: ProcessingModeValue = "local_model"): JobRow {
  return fixtureStore(inst).enqueue({
    recordRevisionId: revisionId,
    axes: axesForProcessingMode(mode),
    versions: VERSIONS,
  }).row;
}

function rowOf(inst: Instance, id: string): JobRow {
  const row = fixtureStore(inst, () => new Date()).get(id);
  if (row === null) throw new Error(`任务行不存在：${id}`);
  return row;
}

async function makeRecord(
  inst: Instance,
  text = LOCAL_RAW,
  mode: ProcessingModeValue = "local_model",
): Promise<{ recordId: string; revisionId: string }> {
  const created = inst.booted.workspace.records.createRecord(text, mode);
  // A-0 起新建 cloud_redacted 默认 local_llm；这一批要测的是「远端 + 规则档」的既有链路，
  // 基线显式落回 manual。需要 local_llm 的用例由 `forceLocalLlm` 单独覆盖。
  if (mode === "cloud_redacted") {
    inst.booted.workspace.records.setRedactionMode(created.record.id, "manual");
  }
  return { recordId: created.record.id, revisionId: created.revision.id };
}

/** M9-4c 之前 `local_llm` 还没有 HTTP 入口（UI 不可选），按 0C §八之三-1 的现场直接写轴列。 */
function forceLocalLlm(inst: Instance, recordId: string): void {
  inst.booted.db
    .prepare(
      `update capture_record
          set processing_mode = 'cloud_redacted', analysis_provider = 'cloud', redaction_mode = 'local_llm',
              send_content_mode = 'redacted'
        where id = ?`,
    )
    .run(recordId);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 执行体的直接调用点：本文件里所有「只看一次执行结果」的用例共用这一份上下文。 */
function executorContext(store: JobStore, jobId: string) {
  return {
    signal: new AbortController().signal,
    isCancelRequested: () => store.get(jobId)?.cancel_requested === 1,
  };
}

// ── ① 接线后的启动恢复（生产路径，不是夹具路径）─────────────────────

describe("M6-1D ① 启动恢复经真实装配路径", () => {
  it("过期在途行在第二次 boot 后回 queued；未过期的在途行一行不动", async () => {
    const box = makeSandbox("tb-m6-1d-recover-");
    const first = await bootOn(box, { provider: false, startJobsWorker: false });
    // 两行必须挂在**两个版本**上：同 revision + 同三轴 + 同版本 = 同一个幂等键，
    // 第二次入队只会回同一行，那时无奈只剩一行、过期现场也只剩一个。
    const staleRevision = (await makeRecord(first)).revisionId;
    const freshRevision = (await makeRecord(first)).revisionId;

    // 一行「早就过期」的在途任务：夹具时钟拨到 24 小时之前，`updated_at_utc` 因此落在租约之外。
    const stale = enqueueRow(first, staleRevision);
    fixtureStore(first, () => new Date(LONG_AGO)).transition(stale.id, "redacting");
    // 一行「刚刚占住」的在途任务：真实时钟，仍在 `DEFAULT_LEASE_MS` 之内。
    const fresh = enqueueRow(first, freshRevision);
    fixtureStore(first, () => new Date()).transition(fresh.id, "redacting");
    await stopInstance(first);

    // 同一个数据目录上的第二次启动：worker 默认起来，`start()` 里的 `recover()` 就是生产入口。
    // `provider: false` 让它恢复完就不再取活（取活路径由 ② 单独钉），断言因此看得见回收的结果。
    const second = await bootOn(box, { provider: false, jobsPollIntervalMs: 60_000 });
    const reclaimed = rowOf(second, stale.id);
    expect(reclaimed.status).toBe("queued");
    // 回收带一次尝试消耗与分类（0E §四）：它说的是「上一轮没跑完」，不是「这一轮失败了」。
    expect(reclaimed.attempts).toBe(1);
    expect(reclaimed.error_kind).toBe("internal");
    expect(rowOf(second, fresh.id).status).toBe("redacting");
    expect(rowOf(second, fresh.id).attempts).toBe(0);
    await stopInstance(second);
    box.cleanup();
  });

  it("boot 默认就把 worker 交出来，shutdown 等它收尾之后才关库", async () => {
    const inst = await startInstance({ provider: false });
    expect(inst.booted.jobs).toBeInstanceOf(JobWorker);
    // 显式收一次：`shutdown()` 里 `jobs.stop()` 在前，库句柄因此不会在拍子跑完之前被关掉。
    await stopInstance(inst);
    inst.box.cleanup();
  });
});

// ── ② provider 不可用：什么都不做 ───────────────────────────────────

describe("M6-1D ② provider 未就绪时队列原地不动", () => {
  it("worker 在取活之前就让路：行留 queued、attempts 不变、不写 started_at", async () => {
    const inst = await startInstance({ provider: false, jobsPollIntervalMs: 25 });
    const { revisionId } = await makeRecord(inst);
    const job = enqueueRow(inst, revisionId);
    await sleep(200); // ≥ 5 拍：判据若在 claim 之后，这里早就看见 redacting 了。
    const row = rowOf(inst, job.id);
    expect(row.status).toBe("queued");
    expect(row.attempts).toBe(0);
    expect(row.error_kind).toBeNull();
    expect(row.started_at_utc).toBeNull();
  });

  it("经执行体也是同一结论：Provider 面整个没装配 ⇒ provider_loading，这一拍什么都不做", async () => {
    const inst = await startInstance({ provider: false, startJobsWorker: false });
    const { revisionId } = await makeRecord(inst);
    const job = enqueueRow(inst, revisionId);
    const store = fixtureStore(inst, () => new Date());
    store.transition(job.id, "redacting");
    const executor = makeIngestExecutor(inst.booted.workspace);
    const result = await executor(store.get(job.id)!, executorContext(store, job.id));
    expect(result).toEqual({ kind: "provider_unavailable", errorKind: "provider_loading" });
    expect(store.get(job.id)!.attempts).toBe(0);
  });
});

// ── ③ POST /api/jobs（手动入队面）────────────────────────────────────

describe("M6-1D ③ POST /api/jobs 的手动入队面", () => {
  it("本地档记录 ⇒ 201 新建一行 queued，形状逐字是 JobViewDto", async () => {
    const inst = await startInstance({ provider: true, startJobsWorker: false });
    const { recordId, revisionId } = await makeRecord(inst);
    const r = await call(inst, "POST", "/api/jobs", { recordId });
    expect(r.status).toBe(201);
    expect(Object.keys(r.json).sort()).toEqual(JOB_VIEW_KEYS);
    expect(r.json.id).toMatch(/^pjob_/);
    expect(r.json.recordId).toBe(recordId);
    expect(r.json.recordRevisionId).toBe(revisionId);
    expect(r.json.status).toBe("queued");
    expect(r.json.attempts).toBe(0);
    expect(r.json.cancelRequested).toBe(false);
    expect(r.json.sendContentMode).toBe("none");
  });

  it("重复入队 ⇒ 200 同一行（幂等命中不是第二个计数）", async () => {
    const inst = await startInstance({ provider: true, startJobsWorker: false });
    const { recordId } = await makeRecord(inst);
    const first = await call(inst, "POST", "/api/jobs", { recordId });
    const again = await call(inst, "POST", "/api/jobs", { recordId });
    expect(first.status).toBe(201);
    expect(again.status).toBe(200);
    expect(again.json.id).toBe(first.json.id);
    expect(again.json.createdAtUtc).toBe(first.json.createdAtUtc);
  });

  it("记录不存在 ⇒ 404；请求体多带键 ⇒ 400（入队只接受一个指针）", async () => {
    const inst = await startInstance({ provider: true, startJobsWorker: false });
    const missing = await call(inst, "POST", "/api/jobs", { recordId: "rec_不存在" });
    expect(missing.status).toBe(404);
    expect(missing.json.error).toBe("not_found");

    const extra = await call(inst, "POST", "/api/jobs", {
      recordId: (await makeRecord(inst)).recordId,
      processing_mode: "cloud_redacted",
    });
    expect(extra.status).toBe(400);
    expect(extra.json.error).toBe("invalid_request");
  });

  it("外发轨缺本次授权 ⇒ 不再 409：201 写下 queued 行，闸门挪到认领侧（S-4）", async () => {
    const inst = await startInstance({ provider: true, startJobsWorker: false });
    const { recordId } = await makeRecord(inst, CLOUD_RAW_TEXT, "cloud_redacted");

    // 「保存并整理」必须能排进队——否则用户点一下就看到「没保存成」，而原文其实已经落盘。
    const queued = await call(inst, "POST", "/api/jobs", { recordId });
    expect(queued.status).toBe(201);
    expect(queued.json.status).toBe("queued");
    expect(queued.json.sendContentMode).toBe("redacted");
    expect(queued.json.attempts).toBe(0);

    // 「排进去」不等于「放行」：此刻认领判据为假，worker 一拍都不会碰它。
    expect(makeEgressGrantRunnable(inst.booted.workspace)(rowOf(inst, queued.json.id))).toBe(false);

    // 用户走完预览 + 确认：同一条 revision 的授权到手，判据当场翻成真。
    expect((await call(inst, "POST", "/api/ingest/preview", { recordId })).status).toBe(200);
    expect((await call(inst, "POST", "/api/ingest/confirm-send", { recordId })).status).toBe(201);
    expect(makeEgressGrantRunnable(inst.booted.workspace)(rowOf(inst, queued.json.id))).toBe(true);
  });

  it("不可用的脱敏档 ⇒ 409 redaction_mode_unavailable（与 op2/op6/op7 同一个码）", async () => {
    const inst = await startInstance({ provider: true, startJobsWorker: false });
    const { recordId } = await makeRecord(inst, CLOUD_RAW_TEXT, "cloud_redacted");
    forceLocalLlm(inst, recordId);
    const r = await call(inst, "POST", "/api/jobs", { recordId });
    expect(r.status).toBe(409);
    expect(r.json.error).toBe("redaction_mode_unavailable");
    expect(r.json.reason).toBe("not_configured"); // 沙箱配置没写 model.local_llm
    expect(r.json.detail).toContain("local_llm");
    // 拒绝不留下任务行：入队面与闸门同源，不能「先占一行再等失败」。
    const listed = await call(inst, "GET", `/api/jobs?recordId=${recordId}`);
    expect(listed.json.jobs).toEqual([]);
  });

  it("解析能力未就绪 ⇒ 503 ingest_unavailable（与 op2 同一格，不是 409）", async () => {
    const inst = await startInstance({ provider: false, startJobsWorker: false });
    const { recordId } = await makeRecord(inst);
    expect(inst.booted.workspace.ingestReady).toBe(false);
    const r = await call(inst, "POST", "/api/jobs", { recordId });
    expect(r.status).toBe(503);
    expect(r.json.error).toBe("ingest_unavailable");
  });

  it("没有自动入队：创建/编辑/换轨记录都不写 privacy_job", async () => {
    const inst = await startInstance({ provider: true, startJobsWorker: false });
    const created = await call(inst, "POST", "/api/records", { text: LOCAL_RAW, processing_mode: "local_model" });
    expect(created.status).toBe(201);
    const recordId = created.json.record.id as string;
    const edited = await call(inst, "PUT", `/api/records/${recordId}`, { text: `${LOCAL_RAW}改了` });
    expect(edited.status).toBe(200);
    const switched = await call(inst, "PATCH", `/api/records/${recordId}/mode`, {
      processing_mode: "cloud_redacted",
    });
    expect(switched.status).toBe(200);
    const listed = await call(inst, "GET", `/api/jobs?recordId=${recordId}`);
    expect(listed.json.jobs).toEqual([]);
  });
});

// ── ③b 认领侧授权判据（整理方式改动 S-4）────────────────────────────

describe("M6-1D ③b makeEgressGrantRunnable：外发没授权 ⇒ 这一行不可认领", () => {
  it("local_model（不外发）恒可认领：判据不给本机那条轨道凭空添一道门", async () => {
    const inst = await startInstance({ provider: true, startJobsWorker: false });
    const { revisionId } = await makeRecord(inst);
    const job = enqueueRow(inst, revisionId, "local_model");
    expect(makeEgressGrantRunnable(inst.booted.workspace)(job)).toBe(true);
  });

  it("外发轨：没本次授权 ⇒ 假；预览 + 确认之后 ⇒ 真（判据只读，不现算载荷）", async () => {
    const inst = await startInstance({ provider: true, startJobsWorker: false });
    const { recordId, revisionId } = await makeRecord(inst, CLOUD_RAW_TEXT, "cloud_redacted");
    const job = enqueueRow(inst, revisionId, "cloud_redacted");
    const runnable = makeEgressGrantRunnable(inst.booted.workspace);

    expect(runnable(job)).toBe(false);
    expect((await call(inst, "POST", "/api/ingest/preview", { recordId })).status).toBe(200);
    expect((await call(inst, "POST", "/api/ingest/confirm-send", { recordId })).status).toBe(201);
    expect(runnable(rowOf(inst, job.id))).toBe(true);
  });

  it("接线后的真实 worker：没授权的排队行一拍都不跑——留在 queued、attempts=0、零 parse_run", async () => {
    const inst = await startInstance({ provider: true, jobsPollIntervalMs: 20 });
    const { recordId, revisionId } = await makeRecord(inst, CLOUD_RAW_TEXT, "cloud_redacted");

    const queued = await call(inst, "POST", "/api/jobs", { recordId });
    expect(queued.status).toBe(201);

    // 让 worker 空转若干拍：它每拍都会看见这一行，然后按判据跳过。
    await sleep(150);

    const row = rowOf(inst, queued.json.id);
    expect(row.status).toBe("queued");
    expect(row.attempts).toBe(0);
    expect(row.error_kind).toBeNull();
    const runs = inst.booted.db
      .prepare("select count(*) as n from parse_run where source_revision_id = ?")
      .get(revisionId) as { n: number };
    expect(runs.n).toBe(0);
  });
});

// ── ④ 全链路失败路径回归 ────────────────────────────────────────────

describe("M6-1D ④ 失败路径回归：接上 worker 之后一口都没漏", () => {
  it("缺授权：op2 同步入口 409，且一个 parse_run 行都不落", async () => {
    const inst = await startInstance({ provider: true, startJobsWorker: false });
    const { recordId, revisionId } = await makeRecord(inst, CLOUD_RAW_TEXT, "cloud_redacted");
    const r = await call(inst, "POST", "/api/ingest/parse", { recordId });
    expect(r.status).toBe(409);
    expect(r.json.error).toBe("state_conflict");
    const runs = inst.booted.db
      .prepare("select count(*) as n from parse_run where source_revision_id = ?")
      .get(revisionId) as { n: number };
    expect(runs.n).toBe(0);
  });

  it("local_llm 三入口 + 新入队口四处同码：op6/op7/op2 与 POST /api/jobs 全 409", async () => {
    const inst = await startInstance({ provider: true, startJobsWorker: false });
    const { recordId } = await makeRecord(inst, CLOUD_RAW_TEXT, "cloud_redacted");
    forceLocalLlm(inst, recordId);
    for (const path of ["/api/ingest/preview", "/api/ingest/confirm-send", "/api/ingest/parse", "/api/jobs"]) {
      const r = await call(inst, "POST", path, { recordId });
      expect(r.status, path).toBe(409);
      expect(r.json.error, path).toBe("redaction_mode_unavailable");
      expect(r.json.reason, path).toBe("not_configured"); // 四道口读同一份配置，拒因逐字相同（M9-D-10）
    }
  });

  it("改原文即旧授权失效：redacted 与 raw 两轨各一条，op2 仍拒、入队照排但认领侧不放行", async () => {
    const inst = await startInstance({ provider: true, startJobsWorker: false });
    for (const mode of ["cloud_redacted", "cloud_raw"]) {
      const { recordId } = await makeRecord(inst, CLOUD_RAW_TEXT, mode as ProcessingModeValue);
      await call(inst, "POST", "/api/ingest/preview", { recordId });
      const confirmed = await call(inst, "POST", "/api/ingest/confirm-send", { recordId });
      expect(confirmed.status, mode).toBe(201);
      // 授权之前先证明门是通的：同一版本此刻可入队。
      expect((await call(inst, "POST", "/api/jobs", { recordId })).status, mode).toBe(201);

      const edited = await call(inst, "PUT", `/api/records/${recordId}`, {
        text: `${CLOUD_RAW_TEXT}，后来又聊了一句`,
      });
      expect(edited.status, mode).toBe(200);
      expect(edited.json.changed, mode).toBe(true);

      const after = await call(inst, "POST", "/api/ingest/preview", { recordId });
      expect(after.json.hasApplicableGrant, mode).toBe(false);
      const parse = await call(inst, "POST", "/api/ingest/parse", { recordId });
      expect(parse.status, mode).toBe(409);
      // 入队口不再拒绝（S-4 把它挪到了认领侧）：新版本 = 新幂等键，排的是新的一行；
      // 而这一行此刻不可认领——旧授权随旧版本一起作废，等用户对新版本再确认一次。
      const enqueue = await call(inst, "POST", "/api/jobs", { recordId });
      expect(enqueue.status, mode).toBe(201);
      expect(enqueue.json.status, mode).toBe("queued");
      expect(makeEgressGrantRunnable(inst.booted.workspace)(rowOf(inst, enqueue.json.id)), mode).toBe(
        false,
      );
    }
  });

  it("执行体不在旧版本上替用户重做：当前版本已换 ⇒ retryable + internal，一次模型都不调", async () => {
    const inst = await startInstance({ provider: true, startJobsWorker: false });
    const { recordId, revisionId } = await makeRecord(inst);
    const stale = enqueueRow(inst, revisionId);
    const edited = inst.booted.workspace.records.editRecord(recordId, `${LOCAL_RAW}，又补了一句`);
    expect(edited.changed).toBe(true);

    const store = fixtureStore(inst, () => new Date());
    store.transition(stale.id, "redacting");
    const executor = makeIngestExecutor(inst.booted.workspace);
    const result = await executor(store.get(stale.id)!, executorContext(store, stale.id));
    expect(result).toEqual({ kind: "retryable", errorKind: "internal" });
  });

  it("取消：在途行只置请求位；执行体在调模型前读那一位并回 canceled", async () => {
    const inst = await startInstance({ provider: true, startJobsWorker: false });
    const { revisionId } = await makeRecord(inst);
    const job = enqueueRow(inst, revisionId);
    const store = fixtureStore(inst, () => new Date());
    store.transition(job.id, "redacting");

    const canceled = await call(inst, "POST", `/api/jobs/${job.id}/cancel`);
    expect(canceled.status).toBe(200);
    expect(canceled.json.cancelRequested).toBe(true);
    expect(canceled.json.status).toBe("redacting");

    // 权威是库里那位而不是进程内的 controller：重启后它仍然成立（0E §五）。
    const executor = makeIngestExecutor(inst.booted.workspace);
    const result = await executor(store.get(job.id)!, executorContext(store, job.id));
    expect(result).toEqual({ kind: "canceled" });
  });
});

// ── ⑤ stop() 不掐断在跑的一拍 ───────────────────────────────────────

describe("M6-1D ⑤ stop() 让在跑的那一拍写完", () => {
  it("模型调用在途时停轮询：结果照样写完，租约照样释放", async () => {
    let calls = 0;
    let finished = 0;
    const slow: ProviderTransport = {
      send: async () => {
        calls += 1;
        await sleep(120);
        finished += 1;
        return OK_ENVELOPE(validOutput()) satisfies TransportResponse;
      },
    };
    const inst = await startInstance({ provider: true, startJobsWorker: false, transport: slow });
    const { revisionId } = await makeRecord(inst);
    const job = enqueueRow(inst, revisionId);

    const leases = new JobLease(inst.booted.db);
    const store = new JobStore(inst.booted.db, { leases });
    const worker = new JobWorker({
      db: inst.booted.db,
      store,
      executor: makeIngestExecutor(inst.booted.workspace),
      providerReady: () => true,
      leases,
      pollIntervalMs: 20,
    });
    worker.start();
    for (let waited = 0; calls === 0 && waited < 1_000; waited += 10) await sleep(10);
    // 在途：行已被占住，模型调用还没回。此时 `stop()` 只该「不再排新活」，不该掐断这一拍。
    expect(store.get(job.id)!.status).toBe("redacting");
    expect(getMeta(inst.booted.db, leaseKeyOf(job.id))).toBeDefined();
    await worker.stop();
    expect(calls).toBe(1);
    expect(finished).toBe(1);
    const row = store.get(job.id)!;
    expect(row.status).toBe("done");
    expect(row.attempts).toBe(0);
    // 收尾即销账：租约条子不能留在库里，否则下一次回收对着一个不存在的持有者说话。
    expect(getMeta(inst.booted.db, leaseKeyOf(job.id))).toBeUndefined();
  });

  it("bootstrap 把同一份 JobLease 同时交给 store 与 worker（两个答案=没有答案）", () => {
    const source = readFileSync("src/server/runtime/bootstrap.ts", "utf8");
    expect([...source.matchAll(/new JobLease\(/g)]).toHaveLength(1);
    expect(source).toMatch(/const leases = new JobLease\(db\);/);
    expect(source).toMatch(/new JobStore\(db, \{ leases \}\)/);
    // worker 选项里的 `leases` 与 store 的是同一个变量名，不是再造一份。
    const workerBlock = /const jobs = new JobWorker\(\{[\s\S]*?\n {2}\}\);/.exec(source)?.[0] ?? "";
    expect(workerBlock, "worker 构造块要被断言到").not.toBe("");
    expect(workerBlock).toMatch(/^\s*leases,$/m);
  });
});

// ── ⑥ 结构纪律 ──────────────────────────────────────────────────────

describe("M6-1D ⑥ 结构纪律：路由不碰库句柄，执行体不写 privacy_job", () => {
  /** 剥掉注释后的源码：这一组钉的是**代码里**没有的东西，注释里提到的名词不算违反。 */
  function codeOnly(rel: string): string {
    return readFileSync(rel, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
  }

  it("jobsRoutes 只在两个工厂里取 db 句柄，且不含任何 SQL", () => {
    const code = codeOnly("src/server/api/jobsRoutes.ts");
    expect([...code.matchAll(/facts\.workspace\.db/g)]).toHaveLength(2);
    for (const line of code.split("\n").filter((l) => l.includes("facts.workspace.db"))) {
      expect(line.trim()).toMatch(/^return new Job(Store|Lease)\(facts\.workspace\.db/);
    }
    expect(code).not.toMatch(/\.prepare\(/);
    expect(code).not.toMatch(/\.run\(/);
    expect(code).not.toMatch(/insert\s+into/i);
    expect(code).not.toMatch(/delete\s+from/i);
  });

  it("ingestExecutor 不经存储层写队列，也不碰裸 SQL", () => {
    const code = codeOnly("src/server/jobs/ingestExecutor.ts");
    expect(code).not.toMatch(/\.prepare\(/);
    expect(code).not.toMatch(/privacy_job/);
    expect(code).not.toMatch(/\.transition\(/);
    expect(code).not.toMatch(/JobStore/);
  });

  it("shutdown 的顺序：先停 worker，再关 server，最后关库", () => {
    const source = readFileSync("src/server/runtime/bootstrap.ts", "utf8");
    const body = /export async function shutdown[\s\S]*?\n}/.exec(source)?.[0] ?? "";
    expect(body, "shutdown 本体要被断言到").not.toBe("");
    const stopAt = body.indexOf("result.jobs.stop()");
    const closeServerAt = body.indexOf("server.close(");
    const closeDbAt = body.indexOf("result.db.close()");
    expect(stopAt).toBeGreaterThanOrEqual(0);
    expect(stopAt).toBeLessThan(closeServerAt);
    expect(closeServerAt).toBeLessThan(closeDbAt);
  });
});

// ── ⑦ 租约归属（裁决 ①-b：租约行 = 唯一租约权威）───────────────────

describe("M6-1D ⑦ 租约归属：两个进程共用一个数据目录时的判据", () => {
  it("同一进程内两份 JobLease 认得出彼此（身份是进程级单例）", async () => {
    const inst = await startInstance({ provider: false, startJobsWorker: false });
    const a = new JobLease(inst.booted.db);
    const b = new JobLease(inst.booted.db);
    expect(a.instanceId).toBe(b.instanceId);
    const { revisionId } = await makeRecord(inst);
    const job = enqueueRow(inst, revisionId);
    a.acquire(job.id, DEFAULT_LEASE_MS);
    expect(b.heldByOther(job.id)).toBe(false);
    expect(b.isLive(job.id)).toBe(true);
    expect(b.holderOf(job.id)?.jobId).toBe(job.id);
    a.release(job.id);
    expect(b.isLive(job.id)).toBe(false);
  });

  it("别的实例持有且未过点 ⇒ 回收跳过这一行（时钟超前的实例不再抢别人的活）", async () => {
    const inst = await startInstance({ provider: false, startJobsWorker: false });
    const { revisionId } = await makeRecord(inst);
    const job = enqueueRow(inst, revisionId);
    // 行「看起来」过期（`updated_at_utc` 在 24 小时之前），但租约条子说它在别人手上且还没到点。
    fixtureStore(inst, () => new Date(LONG_AGO)).transition(job.id, "redacting");
    const other = new JobLease(inst.booted.db, { instanceId: "other-instance" });
    other.acquire(job.id, DEFAULT_LEASE_MS);

    const local = new JobLease(inst.booted.db, { instanceId: "this-instance" });
    const store = new JobStore(inst.booted.db, { now: () => new Date(), leases: local });
    expect(store.reclaimExpiredLeases(DEFAULT_LEASE_MS)).toEqual([]);
    expect(store.get(job.id)!.status).toBe("redacting");

    // 持有者松手后，同一行才回到可回收；回收动作本身把条子也清掉。
    other.release(job.id);
    expect(store.reclaimExpiredLeases(DEFAULT_LEASE_MS)).toEqual([job.id]);
    expect(store.get(job.id)!.status).toBe("queued");
    expect(getMeta(inst.booted.db, leaseKeyOf(job.id))).toBeUndefined();
  });

  it("取消以租约行为权威：有人持有这一行 ⇒ 只置请求位，松手之后才落终态", async () => {
    const inst = await startInstance({ provider: false, startJobsWorker: false });
    const { revisionId } = await makeRecord(inst);
    const job = enqueueRow(inst, revisionId);
    const other = new JobLease(inst.booted.db, { instanceId: "other-instance" });
    other.acquire(job.id, DEFAULT_LEASE_MS);

    const local = new JobLease(inst.booted.db, { instanceId: "this-instance" });
    const store = new JobStore(inst.booted.db, { now: () => new Date(), leases: local });
    const pending = store.requestCancel(job.id);
    expect(pending.status).toBe("queued");
    expect(pending.cancel_requested).toBe(1);

    other.release(job.id);
    const done = store.requestCancel(job.id);
    expect(done.status).toBe("canceled");
    // 取消不是失败：不消耗尝试，也不写失败分类。
    expect(done.attempts).toBe(0);
    expect(done.error_kind).toBeNull();
  });

  it("过点的条子不算持有者：崩溃进程留下的残账不会永久挡住回收", async () => {
    const inst = await startInstance({ provider: false, startJobsWorker: false });
    const { revisionId } = await makeRecord(inst);
    const job = enqueueRow(inst, revisionId);
    const dead = new JobLease(inst.booted.db, { instanceId: "dead-instance", now: () => new Date(LONG_AGO) });
    dead.acquire(job.id, 1_000);
    fixtureStore(inst, () => new Date(LONG_AGO)).transition(job.id, "redacting");

    const alive = new JobLease(inst.booted.db, { instanceId: "this-instance", now: () => new Date() });
    expect(alive.heldByOther(job.id)).toBe(false);
    const store = new JobStore(inst.booted.db, { now: () => new Date(), leases: alive });
    expect(store.reclaimExpiredLeases(DEFAULT_LEASE_MS)).toEqual([job.id]);
  });

  it("没有条子的行照旧按 0E 的时刻判据回收（接线不改变单进程现实）", async () => {
    const inst = await startInstance({ provider: false, startJobsWorker: false });
    const { revisionId } = await makeRecord(inst);
    const job = enqueueRow(inst, revisionId);
    fixtureStore(inst, () => new Date(LONG_AGO)).transition(job.id, "redacting");
    const store = new JobStore(inst.booted.db, { now: () => new Date() });
    expect(store.reclaimExpiredLeases(DEFAULT_LEASE_MS)).toEqual([job.id]);
  });
});
