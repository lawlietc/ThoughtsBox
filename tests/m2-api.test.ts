import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { boot, shutdown, type BootResult } from "../src/server/runtime/bootstrap.ts";
import { ensureConfigFile } from "../src/server/config/config.ts";
import { resolveDataLayout } from "../src/server/config/paths.ts";
import type { DataLayout } from "../src/server/config/paths.ts";
import {
  makeSandbox,
  type Sandbox,
} from "./helpers/sandbox.ts";
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
 * M2-6 §十二 API 面端到端验收：九项操作各映射到一条路由并被真实 HTTP 驱动，
 * 四类错误语义可自动化区分，敏感面零外泄，外加两条静态源码断言（单一轨道 + 只经服务层）。
 *
 * Provider 由 `boot({ ingestProvider })` 注入桩适配器与假 transport（全程离线），
 * 走的是真实 IngestService 全链路，不是路由层的假数据。
 */

let sandbox: Sandbox | undefined;
let booted: BootResult | undefined;
let base = "";

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

afterEach(async () => {
  if (booted !== undefined) {
    await shutdown(booted);
    booted = undefined;
  }
  if (sandbox !== undefined) {
    sandbox.cleanup();
    sandbox = undefined;
  }
});

/** 多数用例共用一个带 Provider 的服务实例，生命周期由 afterEach 统一收尾。 */
async function ensureShared(): Promise<void> {
  if (booted !== undefined) return;
  const port = await testPort();
  sandbox = makeSandbox("tb-m2-api-");
  writePort(sandbox.layout, port);
  const stub = stubTransport(OK_ENVELOPE(validOutput()));
  booted = await boot({
    env: { TB_DATA_DIR: sandbox.root },
    log: () => {},
    ingestProvider: {
      adapter: makeAdapter(),
      transport: stub.transport,
      systemPrompt: SYSTEM_PROMPT,
      now: () => new Date(FIXTURE_NOW),
    },
  });
  base = `http://127.0.0.1:${port}`;
}

interface ApiResult {
  status: number;
  json: any;
  text: string;
}

async function call(method: string, path: string, body?: unknown): Promise<ApiResult> {
  await ensureShared();
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(body);
  }
  const res = await fetch(`${base}${path}`, init);
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text === "" ? null : JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, json, text };
}

/** 建一条记录并按需改处理模式。 */
async function makeRecord(text: string, mode?: string): Promise<{ recordId: string; revisionId: string }> {
  await ensureShared();
  const created = booted!.workspace.records.createRecord(text);
  const recordId = created.record.id;
  if (mode !== undefined) {
    booted!.db.prepare("update capture_record set processing_mode = ? where id = ?").run(mode, recordId);
    // 记录被改模式不算内容编辑，版本不变。
  }
  return { recordId, revisionId: created.revision.id };
}

describe("§十二 九项操作（真实 HTTP，Provider 注入走真链路）", () => {
  it("op8 GET /api/ingest/config：如实上报模型与隐私模式，密钥只报布尔", async () => {
    const r = await call("GET", "/api/ingest/config");
    expect(r.status).toBe(200);
    expect(r.json.ingestReady).toBe(true);
    expect(r.json.provider).toBe("ollama");
    expect(r.json.defaultMode).toBe("manual_only");
    expect(r.json.apiKeyConfigured).toBe(false);
    expect(r.json.localModel).toHaveProperty("ready", true);
    expect(r.json.cloudModel).toHaveProperty("ready", true);
    expect(r.json.restartRequired).toBe(false);
  });

  it("op8 PUT /api/ingest/config：保存两档模型配置，标记重启生效且不泄露密钥", async () => {
    const sentinel = "sk-config-test-sentinel";
    process.env.TB_UI_TEST_KEY = sentinel;
    try {
      const r = await call("PUT", "/api/ingest/config", {
        localModel: {
          enabled: true,
          provider: "ollama",
          model: "qwen3:8b",
          baseUrl: "http://127.0.0.1:11434/v1",
          callPath: "ollama_openai_compatible",
          supportsStructuredOutput: false,
          requestTimeoutMs: 60000,
          apiKeyEnv: "TB_LOCAL_TEST_KEY",
        },
        cloudModel: {
          enabled: true,
          provider: "openai_compatible",
          model: "gpt-4.1-mini",
          baseUrl: "https://example.invalid/v1",
          callPath: "http_json_lenient",
          supportsStructuredOutput: true,
          requestTimeoutMs: 45000,
          apiKeyEnv: "TB_UI_TEST_KEY",
        },
      });
      expect(r.status).toBe(200);
      expect(r.json.restartRequired).toBe(true);
      expect(r.json.localModel.model).toBe("qwen3:8b");
      expect(r.json.cloudModel.model).toBe("gpt-4.1-mini");
      expect(r.json.cloudModel.apiKeyConfigured).toBe(true);
      expect(r.text).not.toContain(sentinel);

      const saved = JSON.parse(readFileSync(booted!.layout.configFile, "utf8")) as {
        model: { local_model: { model: string }; cloud_model: { api_key_env: string } };
      };
      expect(saved.model.local_model.model).toBe("qwen3:8b");
      expect(saved.model.cloud_model.api_key_env).toBe("TB_UI_TEST_KEY");
      expect(JSON.stringify(saved)).not.toContain(sentinel);
    } finally {
      delete process.env.TB_UI_TEST_KEY;
    }
  });

  it("op1 GET /api/ingest/pending：列出待处理记录带状态与摘要", async () => {
    // 待整理只列非 manual_only 模式（enums.json manual_only_not_pending）。
    // 用 local_model 造记录，验证会被列出；captured 态尚未解析。
    const { recordId: recA } = await makeRecord("待处理甲：今天下午要开会", "local_model");
    const { recordId: recB } = await makeRecord("待处理乙：周末爬山", "local_model");
    const r = await call("GET", "/api/ingest/pending?limit=100");
    expect(r.status).toBe(200);
    expect(r.json.total).toBeGreaterThanOrEqual(2);
    expect(r.json.records.some((x: any) => x.recordId === recA)).toBe(true);
    expect(r.json.records.some((x: any) => x.recordId === recB)).toBe(true);
    expect(r.json.records.every((x: any) => x.preview.length > 0)).toBe(true);
    expect(
      r.json.records
        .filter((x: any) => x.recordId === recA || x.recordId === recB)
        .every((x: any) => x.processingStatus === "captured"),
    ).toBe(true);
  });

  it("op1 D-B：manual_only 记录不计入待整理（enums.json manual_only_not_pending）", async () => {
    const { recordId: manualId } = await makeRecord("手动整理，不该出现在待整理", "manual_only");
    const { recordId: localId } = await makeRecord("本地模型，应出现在待整理", "local_model");
    const r = await call("GET", "/api/ingest/pending?limit=500");
    expect(r.status).toBe(200);
    // 这一对里只有 local_model 那条被列出。
    expect(r.json.records.some((x: any) => x.recordId === localId)).toBe(true);
    expect(r.json.records.some((x: any) => x.recordId === manualId)).toBe(false);
    // 全局不变式：待整理结果里绝不出现 manual_only 模式，total 也不含它。
    expect(r.json.records.every((x: any) => x.processingMode !== "manual_only")).toBe(true);
    expect(r.json.total).toBe(r.json.records.length);
  });

  it("op2/op3/op4/op5 local_model 解析全链路：成功→运行状态→重放（幂等）", async () => {
    const { recordId } = await makeRecord(LOCAL_RAW, "local_model");

    const parse = await call("POST", "/api/ingest/parse", { recordId });
    expect(parse.status).toBe(200);
    expect(parse.json.succeeded).toBe(true);
    expect(parse.json.runId).toMatch(/^run_/);
    expect(parse.json.writes.episodes).toBeGreaterThanOrEqual(1);
    const runId = parse.json.runId as string;

    // op3 运行状态与错误摘要
    const run = await call("GET", `/api/ingest/runs/${runId}`);
    expect(run.status).toBe(200);
    expect(run.json.executionStatus).toBe("succeeded");
    expect(run.json.errorKind).toBeNull();

    // op5 主动重新解析：同 revision + 同管线 = 同幂等键 → 重放，不重复产出。
    const reparse = await call("POST", `/api/ingest/records/${recordId}/reparse`);
    expect(reparse.status).toBe(200);
    expect(reparse.json.replayed).toBe(true);

    // op4 重试失败任务：成功 run 再触发也是重放（POST 与 GET 同路径，方法区分意图）。
    const retry = await call("POST", `/api/ingest/runs/${runId}`);
    expect(retry.status).toBe(200);
    expect(retry.json.replayed).toBe(true);

    // 成功后记录进入 parsed → 不再出现在待处理列表。
    const after = await call("GET", `/api/ingest/pending?limit=100`);
    expect(after.json.records.some((x: any) => x.recordId === recordId)).toBe(false);
  });

  it("op6 POST /api/ingest/preview：展示实际待发送文本，规则脱敏生效且映射不出本机", async () => {
    const { recordId } = await makeRecord("联系我 13800138000 或 zhang@example.com 详谈");
    const r = await call("POST", "/api/ingest/preview", { recordId });
    expect(r.status).toBe(200);
    expect(r.json.policyVersion).toBeTruthy();
    expect(r.json.hasApplicableGrant).toBe(false);
    // 待发送文本已脱敏：原文里的手机号/邮箱不出现。
    expect(r.json.payloadText).not.toContain("13800138000");
    expect(r.json.payloadText).not.toContain("zhang@example.com");
    // 映射（本地凭据）绝不出现在响应：无 map/spans/nonce/originalStart 任何键。
    for (const forbidden of ['"map"', '"spans"', '"nonce"', '"originalStart"', '"redactionMap"']) {
      expect(r.text).not.toContain(forbidden);
    }
  });

  it("op7 POST /api/ingest/confirm-send：保存用户明确确认，签发 CloudSendGrant", async () => {
    const { recordId } = await makeRecord("确认发送用的样本内容");
    const r = await call("POST", "/api/ingest/confirm-send", { recordId });
    expect(r.status).toBe(201);
    expect(r.json.grantId).toMatch(/^csg_/);
    expect(r.json.payloadSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(r.json.policyVersion).toBeTruthy();
    expect(r.json.confirmedAtUtc).toMatch(/Z$/);
  });

  it("op9 GET /api/ingest/effective：current 视图 ⊕ 修正投影（override 只读呈现）", async () => {
    const { recordId, revisionId } = await makeRecord(LOCAL_RAW, "local_model");
    const parse = await call("POST", "/api/ingest/parse", { recordId });
    expect(parse.json.succeeded).toBe(true);

    // 新解析落的是 candidate 结果态；op9 读的是 §3.7 current 视图，须经采纳才可见。
    // 采纳走服务面 adoptCurrent（路由层不裸改状态），再验证投影。
    booted!.workspace.makeIngestService()!.adoptCurrent({ candidateRunId: parse.json.runId as string });

    const before = await call("GET", `/api/ingest/effective/${revisionId}`);
    expect(before.status).toBe(200);
    expect(before.json.currentRunId).toBe(parse.json.runId);
    expect(before.json.episodes.length).toBeGreaterThanOrEqual(1);
    expect(before.json.overrides).toHaveLength(0);

    // 通过服务层给一条 episode 写标量覆盖，再经 op9 读回——修正只投影、不回写基表。
    const episodeId = before.json.episodes[0] as string;
    booted!.workspace.corrections.setOverride({
      objectTable: "episode",
      objectId: episodeId,
      fieldName: "summary",
      valueJson: JSON.stringify("用户改过的摘要"),
    });

    const after = await call("GET", `/api/ingest/effective/${revisionId}`);
    expect(after.json.overrides).toHaveLength(1);
    expect(after.json.overrides[0]).toMatchObject({
      objectTable: "episode",
      objectId: episodeId,
      fieldName: "summary",
    });
    expect(JSON.parse(after.json.overrides[0].valueJson)).toBe("用户改过的摘要");
  });
});

describe("四类错误语义可自动化区分", () => {
  it("验证错误：缺字段 / 类型错 / 坏 JSON 一律 400，且不回显内容", async () => {
    const missing = await call("POST", "/api/ingest/parse", {});
    expect(missing.status).toBe(400);
    expect(missing.json.error).toBe("invalid_request");

    const wrongType = await call("POST", "/api/ingest/parse", { recordId: 123 });
    expect(wrongType.status).toBe(400);

    await ensureShared();
    const bad = await fetch(`${base}/api/ingest/parse`, { method: "POST", body: "{坏json" });
    expect(bad.status).toBe(400);
    const badJson = (await bad.json()) as { error: string };
    expect(badJson.error).toBe("invalid_json");
  });

  it("资源不存在：未知记录 / 未知 run → 404", async () => {
    const noRec = await call("POST", "/api/ingest/parse", { recordId: "rec_不存在" });
    expect(noRec.status).toBe(404);
    expect(noRec.json.error).toBe("not_found");

    const noRun = await call("GET", "/api/ingest/runs/run_不存在");
    expect(noRun.status).toBe(404);
  });

  it("状态冲突：对 manual_only 记录发起解析 → 409 state_conflict（模式是记录设置，不可外发）", async () => {
    const { recordId } = await makeRecord("手动整理，不经模型"); // 默认 manual_only
    const r = await call("POST", "/api/ingest/parse", { recordId });
    expect(r.status).toBe(409);
    expect(r.json.error).toBe("state_conflict");
  });

  it("状态冲突：cloud_redacted 无本次授权 → 409，且敏感原文/映射/载荷一律不外泄", async () => {
    const { recordId, revisionId } = await makeRecord("和张三在蓝山咖啡馆见面 13800138000", "cloud_redacted");
    const r = await call("POST", "/api/ingest/parse", { recordId });
    expect(r.status).toBe(409);
    expect(r.json.error).toBe("state_conflict");
    // 授权闸门在建 run 行之前抛出（零写入），错误响应不含原文姓名/手机号，也不含映射键。
    expect(r.text).not.toContain("张三");
    expect(r.text).not.toContain("蓝山咖啡馆");
    expect(r.text).not.toContain("13800138000");
    for (const forbidden of ['"spans"', '"map"', '"nonce"', '"originalStart"']) {
      expect(r.text).not.toContain(forbidden);
    }
    // 零写入核验：该 revision 没有落下任何 parse_run（授权门在建 run 之前抛出）。
    await ensureShared();
    const runs = booted!.db
      .prepare("select count(*) as n from parse_run where source_revision_id = ?")
      .get(revisionId) as { n: number };
    expect(runs.n).toBe(0);
  });

  it("任务失败是数据不是传输错误：Provider 回稿非法 JSON → HTTP 200 且 succeeded=false", async () => {
    // 独立实例：transport 每次返回不可解析的响应体，触发 invalid_json 终态。
    const port = await testPort();
    const box = makeSandbox("tb-m2-api-fail-");
    writePort(box.layout, port);
    const stub = stubTransport({ status: 200, body: envelope("这不是一个合法 JSON 对象") });
    const failing = await boot({
      env: { TB_DATA_DIR: box.root },
      log: () => {},
      ingestProvider: {
        adapter: makeAdapter(),
        transport: stub.transport,
        systemPrompt: SYSTEM_PROMPT,
        now: () => new Date(FIXTURE_NOW),
      },
    });
    try {
      const created = failing.workspace.records.createRecord(LOCAL_RAW);
      failing.db
        .prepare("update capture_record set processing_mode = 'local_model' where id = ?")
        .run(created.record.id);
      const res = await fetch(`http://127.0.0.1:${port}/api/ingest/parse`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ recordId: created.record.id }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.succeeded).toBe(false);
      expect(body.errorKind).toBe("invalid_json");
      expect(body.failure).not.toBeNull();
      expect(body.failure.retryable).toBe(false);
      // 任务失败仍不落派生数据（原文不丢，run 记终态）。
      expect(body.writes.episodes).toBe(0);
    } finally {
      await shutdown(failing);
      box.cleanup();
    }
  });
});

describe("静态源码断言（单一轨道 + 只经服务层）", () => {
  const INGEST_DTO_NAMES = [
    "PendingRecordDto",
    "PendingRecordsResponse",
    "ModelPrivacyConfigDto",
    "IngestRunDto",
    "IngestWriteCountsDto",
    "IngestFailureDto",
    "IngestResultDto",
    "SendPreviewDto",
    "GrantDto",
    "OverrideDto",
    "EffectiveResultDto",
    "ParseRequestDto",
    "PreviewRequestDto",
    "ConfirmSendRequestDto",
  ];

  it("DTO 单一轨道：web/apiClient.ts 从 shared/dto.ts 导入，且不以同名 interface 重declare", () => {
    const apiSrc = readFileSync(join(process.cwd(), "src/web/apiClient.ts"), "utf8");
    expect(apiSrc).toContain('from "../shared/dto.ts"');
    for (const name of INGEST_DTO_NAMES) {
      // 不允许在 apiClient.ts 里出现 `interface Name {` 或 `type Name = {` 形式的本地重定义。
      expect(apiSrc).not.toMatch(new RegExp(`interface\\s+${name}\\b`));
      expect(apiSrc).not.toMatch(new RegExp(`type\\s+${name}\\s*=`));
    }
  });

  it("API 只经服务层：ingestRoutes.ts 不含任何裸 SQL / 写调用，且显式调用四个服务面", () => {
    const routeSrc = readFileSync(join(process.cwd(), "src/server/api/ingestRoutes.ts"), "utf8");
    // 无任何直接 DB 接触面（路由不引用 db 句柄，也不用字符串调用面执行 SQL）。
    expect(routeSrc).not.toMatch(/\.prepare\(/);
    expect(routeSrc).not.toMatch(/\.exec\(\s*["'`]/); // 禁 DB exec（SQL 字符串字面量），正则 .exec(var) 合法
    expect(routeSrc).not.toMatch(/\.run\(/);
    expect(routeSrc).not.toMatch(/\bfacts\.workspace\.db\b/);
    expect(routeSrc).not.toMatch(/insert\s+into/i);
    expect(routeSrc).not.toMatch(/update\s+\w+\s+set/i);
    expect(routeSrc).not.toMatch(/delete\s+from/i);
    // 全部业务经由服务层。
    expect(routeSrc).toContain("workspace.records");
    expect(routeSrc).toContain("workspace.grants");
    expect(routeSrc).toContain("workspace.corrections");
    expect(routeSrc).toContain("makeIngestService");
  });

  it("dataCheck 修正层分层存在（0004 对象在 v4 起纳入必需集）", () => {
    const dcSrc = readFileSync(join(process.cwd(), "src/server/runtime/dataCheck.ts"), "utf8");
    expect(dcSrc).toContain("user_scalar_override");
    expect(dcSrc).toContain("user_collection_patch");
    expect(dcSrc).toContain("fromVersion: 4");
  });
});
