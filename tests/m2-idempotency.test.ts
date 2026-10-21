import { spawn } from "node:child_process";
import type { ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";

import { migrate } from "../src/server/db/migrator.ts";
import { seedVocabulary } from "../src/server/db/seed.ts";
import { IngestService, deriveIdempotencyKey, emptyWrites } from "../src/server/ingest/ingestService.ts";
import type { ParseRunRow } from "../src/server/ingest/ingestService.ts";
import { countRows, makeSandbox, openSandboxDb, type Sandbox } from "./helpers/sandbox.ts";
import {
  FIXTURE_NOW,
  LOCAL_RAW,
  OK_ENVELOPE,
  SYSTEM_PROMPT,
  createRecord,
  HTTP_ERROR,
  makeAdapter,
  stubTransport,
  validOutput,
} from "./helpers/ingestFixtures.ts";
import type { Database } from "../src/server/db/adapter.ts";

/**
 * T-04（D9）：崩溃幂等。
 *
 * 指令点名「不得只做两个连续成功请求的普通测试，然后宣称崩溃幂等已经验证」——
 * 所以本文件的正向路径由**真实子进程**制造现场：夹具在 run 行已提交为 `running`、
 * 派生写入尚未发生时 `process.abort()`。父进程随后用同一份管线配置重放，必须
 * 复用同一行（同一 `idempotency_key`），且派生行 delta 为 0——不多写、不重写、不翻倍。
 *
 * 契约依据：§7.1（同任务重试幂等）、§7.1b/B3（失败重试复用同一行同一键）、
 * §4.7a（running→failed→queued→running 的合法恢复链）、指令 §8.2（半途失败不得留下部分有效对象）、
 * K-03（`idempotency_key` UNIQUE）。
 *
 * 全程离线：夹具与父进程都用注入的假 Transport，不发网络请求。
 */

const CRASH_PROBE = "tests/fixtures/ingestCrashProbe.ts";

let sandbox: Sandbox | undefined;
let db: Database | undefined;

afterEach(() => {
  db?.close();
  db = undefined;
  sandbox?.cleanup();
  sandbox = undefined;
});

function setup(mode = "local_model"): { revisionId: string; recordId: string } {
  sandbox = makeSandbox("tb-m2-5-idem-");
  db = openSandboxDb(sandbox.layout);
  migrate(db);
  seedVocabulary(db);
  const record = createRecord(db, LOCAL_RAW, mode);
  return record;
}

/** 派生场面快照：T-04 的「delta 为 0」就是对这张表做前后差。 */
function derivedCounts(revisionId: string): Record<string, number> {
  if (db === undefined) throw new Error("夹具未初始化");
  const handle = db;
  const one = (sql: string): number => (handle.prepare(sql).get(revisionId) as { n: number }).n;
  return {
    episode: one("select count(*) as n from episode where source_record_revision_id = ?"),
    thought_item: one("select count(*) as n from thought_item where source_record_revision_id = ?"),
    emotion_mention: one("select count(*) as n from emotion_mention where source_record_revision_id = ?"),
    topic_mention: one("select count(*) as n from topic_mention where source_record_revision_id = ?"),
    entity_mention: one("select count(*) as n from entity_mention where source_record_revision_id = ?"),
    suggestion: one("select count(*) as n from suggestion where parse_run_id in (select id from parse_run where source_revision_id = ?)"),
  };
}

/** 库里读 run 行：T-04 的对账对象是**库中事实**，不是服务返回的镜像。 */
function runRow(runId: string): ParseRunRow | null {
  if (db === undefined) throw new Error("夹具未初始化");
  const row = db
    .prepare(
      `select id, source_revision_id, pipeline_manifest, pipeline_fingerprint, idempotency_key,
              execution_status, result_state, error_kind, started_at_utc, finished_at_utc
         from parse_run where id = ?`,
    )
    .get(runId) as ParseRunRow | undefined;
  return row ?? null;
}

interface CrashResult {
  readonly runId: string;
  readonly idempotencyKey: string;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stderr: string;
}

/**
 * 真跑一个子进程：它只把 run 推进到 running 便 abort。
 * 返回崩溃现场留下的行身份，供父进程断言「重放复用的就是这一行」。
 */
function crashProbe(dataDir: string, revisionId: string): Promise<CrashResult> {
  return new Promise((resolve, reject) => {
    const child: ChildProcessByStdio<null, Readable, Readable> = spawn(
      process.execPath,
      [CRASH_PROBE, "--data-dir", dataDir, "--revision-id", revisionId],
      {
        // 显式 cwd：子进程不继承 vitest 的工作目录，避免临时目录被当作 cwd 占用。
        cwd: process.cwd(),
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, TB_DATA_DIR: dataDir },
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`崩溃夹具超时未退出，stdout=${stdout}`));
    }, 25000);
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      const runId = /^RUN (\S+)$/m.exec(stdout)?.[1];
      const idempotencyKey = /^KEY (\S+)$/m.exec(stdout)?.[1];
      if (runId === undefined || idempotencyKey === undefined) {
        reject(new Error(`崩溃夹具没有报告 run 身份，stdout=${stdout} stderr=${stderr}`));
        return;
      }
      resolve({ runId, idempotencyKey, exitCode: code, signal, stderr });
    });
    child.on("error", (cause) => {
      clearTimeout(timer);
      reject(cause);
    });
  });
}

describe("T-04 崩溃幂等：真实子进程异常退出后的同键重放", () => {
  it("夹具确实异常退出（非零码或信号），且现场只有一行 running 的 run", async () => {
    const { revisionId } = setup();
    if (sandbox === undefined || db === undefined) throw new Error("夹具未初始化");
    const before = derivedCounts(revisionId);
    expect(before).toEqual({
      episode: 0,
      thought_item: 0,
      emotion_mention: 0,
      topic_mention: 0,
      entity_mention: 0,
      suggestion: 0,
    });

    const crash = await crashProbe(sandbox.root, revisionId);

    // 不是「跑完退出 0」——幂等断言的全部意义在于这次进程没走完。
    expect(crash.exitCode === 0 && crash.signal === null).toBe(false);
    expect(countRows(db, "parse_run")).toBe(1);
    const row = runRow(crash.runId);
    expect(row).not.toBeNull();
    expect(row?.execution_status).toBe("running");
    expect(row?.result_state).toBe("candidate");
    expect(row?.finished_at_utc).toBeNull();
    expect(row?.error_kind).toBeNull();
    // 崩溃点在派生写入之前：一个字节都没落地（指令 §8.2「不得留下部分有效的对象」）。
    expect(derivedCounts(revisionId)).toEqual(before);
    // 记录处理态停在 processing——恢复链要认得这个形态。
    expect((db.prepare("select processing_status as s from capture_record where id = (select record_id from record_revision where id = ?)").get(revisionId) as { s: string }).s).toBe("processing");
  });

  it("同幂等键重放：复用崩溃那一行、跑完派生写入，且不再有第二个 run 行", async () => {
    const { revisionId } = setup();
    if (sandbox === undefined || db === undefined) throw new Error("夹具未初始化");
    const crash = await crashProbe(sandbox.root, revisionId);
    expect(runRow(crash.runId)?.execution_status).toBe("running");

    const stub = stubTransport(OK_ENVELOPE(validOutput()));
    const service = new IngestService({
      db,
      adapter: makeAdapter(),
      transport: stub.transport,
      systemPrompt: SYSTEM_PROMPT,
      now: () => new Date(FIXTURE_NOW),
    });
    const result = await service.ingest({ recordRevisionId: revisionId });

    // 同一逻辑任务 = 同一行：夹具算出的键与父进程算出的键逐字相等。
    expect(result.idempotencyKey).toBe(crash.idempotencyKey);
    expect(result.idempotencyKey).toBe(deriveIdempotencyKey(revisionId, result.pipelineFingerprint));
    expect(result.runId).toBe(crash.runId);
    expect(result.recovered).toBe(true);
    expect(result.replayed).toBe(false);
    expect(result.succeeded).toBe(true);
    expect(countRows(db, "parse_run")).toBe(1);

    const row = runRow(crash.runId);
    expect(row?.execution_status).toBe("succeeded");
    expect(row?.result_state).toBe("candidate");
    expect(row?.error_kind).toBeNull();
    // running→failed(cancelled)→queued→running 只在同一行上发生，started_at 被刷新为本次时刻。
    expect(row?.started_at_utc).toBe(FIXTURE_NOW);

    // 派生写入照做且只做一份。
    expect(derivedCounts(revisionId)).toEqual({
      episode: 1,
      thought_item: 1,
      emotion_mention: 1,
      topic_mention: 1,
      entity_mention: 0,
      suggestion: 0,
    });
    expect(stub.callCount()).toBe(1);
  });

  it("成功提交之后再同键重放：零调用、零写入、delta 为 0", async () => {
    const { revisionId } = setup();
    if (sandbox === undefined || db === undefined) throw new Error("夹具未初始化");
    const stub = stubTransport(OK_ENVELOPE(validOutput()));
    const service = new IngestService({
      db,
      adapter: makeAdapter(),
      transport: stub.transport,
      systemPrompt: SYSTEM_PROMPT,
      now: () => new Date(FIXTURE_NOW),
    });

    const first = await service.ingest({ recordRevisionId: revisionId });
    expect(first.replayed).toBe(false);
    const afterFirst = derivedCounts(revisionId);
    const callsAfterFirst = stub.callCount();

    const second = await service.ingest({ recordRevisionId: revisionId });
    expect(second.replayed).toBe(true);
    expect(second.recovered).toBe(false);
    expect(second.runId).toBe(first.runId);
    expect(second.writes).toEqual(emptyWrites());
    // 「一次请求都不该发出」：重放路径上 Transport 一次也没被调用。
    expect(stub.callCount()).toBe(callsAfterFirst);
    expect(derivedCounts(revisionId)).toEqual(afterFirst);
    expect(countRows(db, "parse_run")).toBe(1);
    expect(service.readRun(first.runId)?.execution_status).toBe("succeeded");
  });

  it("B3：失败重试复用同一行同一键，最终成功也只留一份派生行", async () => {
    const { revisionId } = setup();
    if (sandbox === undefined || db === undefined) throw new Error("夹具未初始化");
    let response = HTTP_ERROR(503);
    const transport = {
      send: async () => response,
    };
    const service = new IngestService({
      db,
      adapter: makeAdapter(),
      transport,
      systemPrompt: SYSTEM_PROMPT,
      now: () => new Date(FIXTURE_NOW),
    });

    const failed = await service.ingest({ recordRevisionId: revisionId });
    expect(failed.succeeded).toBe(false);
    expect(failed.errorKind).toBe("network");
    expect(service.readRun(failed.runId)?.execution_status).toBe("failed");
    expect(service.readRun(failed.runId)?.error_kind).toBe("network");
    expect(derivedCounts(revisionId).episode).toBe(0);
    // 失败时记录处理态转 failed（§4.8），重跑时再由 enterProcessing 走 failed→preprocessing→processing。
    expect((db.prepare("select processing_status as s from capture_record where current_revision_id = ?").get(revisionId) as { s: string }).s).toBe("failed");

    response = OK_ENVELOPE(validOutput());
    const retry = await service.ingest({ recordRevisionId: revisionId });
    expect(retry.runId).toBe(failed.runId);
    expect(retry.recovered).toBe(false);
    expect(retry.replayed).toBe(false);
    expect(retry.succeeded).toBe(true);
    expect(retry.idempotencyKey).toBe(failed.idempotencyKey);
    expect(countRows(db, "parse_run")).toBe(1);
    expect(service.readRun(retry.runId)?.error_kind).toBeNull();
    expect(derivedCounts(revisionId)).toEqual({
      episode: 1,
      thought_item: 1,
      emotion_mention: 1,
      topic_mention: 1,
      entity_mention: 0,
      suggestion: 0,
    });
  });

  it("主动重跑 = 新管线：改一项 manifest 便是新指纹、新行，同指纹不会长出第二行", async () => {
    const { revisionId } = setup();
    if (sandbox === undefined || db === undefined) throw new Error("夹具未初始化");
    const stub = stubTransport(OK_ENVELOPE(validOutput()));
    const first = new IngestService({ db, adapter: makeAdapter(), transport: stub.transport, systemPrompt: SYSTEM_PROMPT });
    const a = await first.ingest({ recordRevisionId: revisionId });
    // 同配置再调：同键 ⇒ 复用，不产生 ux_run_live 冲突。
    const again = await first.ingest({ recordRevisionId: revisionId });
    expect(again.runId).toBe(a.runId);
    expect(again.replayed).toBe(true);
    expect(countRows(db, "parse_run")).toBe(1);

    // 换 prompt 版本 = 新管线（§8.3）：新指纹、新行，两条 live run 并存。
    const second = new IngestService({
      db,
      adapter: makeAdapter(),
      transport: stub.transport,
      systemPrompt: SYSTEM_PROMPT,
      promptVersion: "m2-prompt-v2",
    });
    const b = await second.ingest({ recordRevisionId: revisionId });
    expect(b.runId).not.toBe(a.runId);
    expect(b.pipelineFingerprint).not.toBe(a.pipelineFingerprint);
    expect(b.idempotencyKey).not.toBe(a.idempotencyKey);
    expect(countRows(db, "parse_run")).toBe(2);
    // 同一条新管线再调第三次仍是复用。
    const bReplay = await second.ingest({ recordRevisionId: revisionId });
    expect(bReplay.runId).toBe(b.runId);
    expect(bReplay.replayed).toBe(true);
    expect(countRows(db, "parse_run")).toBe(2);
  });

  it("换 model 也生成新身份；夹具与父进程的键由同一函数派生", async () => {
    const { revisionId } = setup();
    if (sandbox === undefined || db === undefined) throw new Error("夹具未初始化");
    const stub = stubTransport(OK_ENVELOPE(validOutput()));
    const service = new IngestService({
      db,
      adapter: makeAdapter(),
      transport: stub.transport,
      systemPrompt: SYSTEM_PROMPT,
    });
    const base = await service.ingest({ recordRevisionId: revisionId });
    const byModel = new IngestService({
      db,
      adapter: makeAdapter({ model: "qwen2.5:14b" }),
      transport: stub.transport,
      systemPrompt: SYSTEM_PROMPT,
    });
    const other = await byModel.ingest({ recordRevisionId: revisionId });
    expect(other.pipelineFingerprint).not.toBe(base.pipelineFingerprint);
    expect(other.idempotencyKey).toBe(deriveIdempotencyKey(revisionId, other.pipelineFingerprint));
    // 派生写入按 run 走：第二个 run 也写自己那份候选行（同 fingerprint 才受 ux_run_live 去重）。
    expect(derivedCounts(revisionId).episode).toBe(2);
  });
});
