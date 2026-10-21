import process from "node:process";

import { applyPragmas, openDatabase } from "../../src/server/db/adapter.ts";
import { resolveDataLayout } from "../../src/server/config/paths.ts";
import { IngestService } from "../../src/server/ingest/ingestService.ts";
import { makeAdapter, stubTransport, SYSTEM_PROMPT } from "../helpers/ingestFixtures.ts";

/**
 * T-04 崩溃夹具（由测试用真子进程运行，不是测试文件，也不被 vitest 收编）。
 *
 * 只做一件事：把 run 行推进到 `running` 并**成功提交**，随后 `process.abort()`。
 * abort 走 C 运行时 `abort(3)`：不运行任何 `finally`/`exit` 钩子，不关连接、不做
 * WAL checkpoint，因此库里留下的正是真实崩溃现场——一行 `running` 的 run、零条派生行。
 *
 * 适配器与版本串全部取自 `ingestFixtures`，与父进程同源：幂等键由
 * `f(revision, pipeline_fingerprint)` 决定，两边差一个字节就是两个任务。
 */

function readArg(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (typeof value !== "string") throw new Error(`夹具缺少参数 ${name}`);
  return value;
}

const layout = resolveDataLayout({ TB_DATA_DIR: readArg("--data-dir") });
const db = openDatabase(layout.dbFile);
applyPragmas(db);

const never = stubTransport({ status: 200, body: "不会被调用" });
const service = new IngestService({
  db,
  adapter: makeAdapter(),
  transport: never.transport,
  systemPrompt: SYSTEM_PROMPT,
});

const run = service.beginRun({ recordRevisionId: readArg("--revision-id") });
process.stdout.write(`RUN ${run.runId}\n`);
process.stdout.write(`KEY ${run.idempotencyKey}\n`);
process.stdout.write(`FP ${run.pipelineFingerprint}\n`);

process.abort();
