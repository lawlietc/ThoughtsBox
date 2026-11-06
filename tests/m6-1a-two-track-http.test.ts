import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { boot, shutdown, type BootResult } from "../src/server/runtime/bootstrap.ts";
import { ensureConfigFile } from "../src/server/config/config.ts";
import { type DataLayout } from "../src/server/config/paths.ts";
import {
  REDACTION_POLICY_VERSION,
  RAW_SEND_POLICY_VERSION,
  sha256OfText,
} from "../src/server/privacy/redaction.ts";
import {
  FIXTURE_NOW,
  LOCAL_RAW,
  OK_ENVELOPE,
  SYSTEM_PROMPT,
  makeAdapter,
  stubTransport,
  validOutput,
  type StubTransport,
} from "./helpers/ingestFixtures.ts";
import { makeSandbox, type Sandbox } from "./helpers/sandbox.ts";

/**
 * M6-1A：两轨（脱敏 / 原文）发送链路的 **HTTP 层**口径收尾。
 *
 * 分工边界（覆盖审计见 `docs/dev-specs/worklogs/2026-10-25-M6-1A-两轨HTTP收尾.md`）：
 *  - `m6-0d-raw-grant` 钉的是**存储层**：两轨授权互不命中、复用口径、原文预览不调 `redact()`。
 *  - `m6-0c-three-axis-matrix` 钉的是**判定层**：矩阵合法性、派生、档位可用性门。
 *  - `m2-api` / `m3-grant-1-payload` 钉的是**脱敏那一轨**的 op6→op7→op2 往返。
 *  - 本文件钉的是三者之间没人站的那段：**请求经过路由与闸门**。同一个 revision 换一条轨道，
 *    对外形状怎么变、授权为什么互不通用、失败面在哪一层被拦。
 *
 * 「换轨」一律走 HTTP `PATCH /api/records/:id/mode`（阶段 1 §二 Q1 裁定：切换即写记录轴，
 * 不新增请求契约），所以夹具里那个直接改库的 `setRecordMode` 在这里不参与装配——
 * 用它是绕过路由，而本任务要验的正是路由。
 *
 * 全程离线：Provider 由 `boot({ ingestProvider })` 注入桩 transport（真实 IngestService 全链路，
 * 同 m2-api 的验收方式）；数据库只落 `TB_DATA_DIR` 沙箱。
 */

/** 含可脱敏源：两轨预览**形状**的对照面（raw 逐字、redacted 被规则遮掉）。 */
const RAW_PII = "周末和张三去了蓝山咖啡馆，联系方式 13800138000 或 laowang@example.com";
/**
 * 不含任何规则/实体命中面 ⇒ 两轨的 `payloadText` 与 `payloadSha256` **逐字相同**。
 * 授权不通用因此只能归因于四元组里的那两腿（`send_content_mode` + 策略版本），
 * 而不是「哈希本来就不同」——这是本文件与 0D 存储层断言的实质差别。
 */
const TRACK_NEUTRAL = LOCAL_RAW;

let sandbox: Sandbox | undefined;
let booted: BootResult | undefined;
let base = "";
/**
 * 每个用例一个全新沙箱与全新 boot，桩 transport 也跟着重建：
 * 「零外发」类断言（`callCount()` 为 0）必须是这一条用例自己的计数，不能是模块累计。
 */
let stub: StubTransport = stubTransport(OK_ENVELOPE(validOutput()));

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

async function ensureShared(): Promise<BootResult> {
  if (booted !== undefined) return booted;
  const port = await testPort();
  sandbox = makeSandbox("tb-m6-1a-");
  writePort(sandbox.layout, port);
  stub = stubTransport(OK_ENVELOPE(validOutput()));
  booted = await boot({
    // 凭据与库都留在沙箱里，绝不碰真实用户目录。
    env: { TB_DATA_DIR: sandbox.root, USERPROFILE: sandbox.root, HOME: sandbox.root },
    log: () => {},
    ingestProvider: {
      adapter: makeAdapter(),
      transport: stub.transport,
      systemPrompt: SYSTEM_PROMPT,
      now: () => new Date(FIXTURE_NOW),
    },
  });
  base = `http://127.0.0.1:${port}`;
  return booted;
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

/** 建记录走真实 HTTP 入口（`processing_mode` 是创建参数的一部分）。 */
async function createRecord(text: string, processingMode: string): Promise<{ recordId: string; revisionId: string }> {
  const r = await call("POST", "/api/records", { text, processing_mode: processingMode });
  expect(r.status).toBe(201);
  const recordId = r.json.record.id as string;
  // A-0 起 cloud_redacted 默认 local_llm；这一批测的是规则档/原文轨的既有链路，基线落回 manual。
  if (processingMode === "cloud_redacted") {
    const manual = await call("PATCH", `/api/records/${recordId}/redaction-mode`, { redaction_mode: "manual" });
    expect(manual.status).toBe(200);
  }
  return { recordId, revisionId: r.json.revision.id as string };
}

/** Q1 裁定的换轨入口：切换即写记录轴，不新增请求契约。 */
async function switchMode(recordId: string, processingMode: string): Promise<void> {
  const r = await call("PATCH", `/api/records/${recordId}/mode`, { processing_mode: processingMode });
  expect(r.status).toBe(200);
  expect(r.json.changed).toBe(true);
  if (processingMode === "cloud_redacted") {
    const manual = await call("PATCH", `/api/records/${recordId}/redaction-mode`, { redaction_mode: "manual" });
    expect(manual.status).toBe(200);
  }
}

/** 桩 transport 实际收到的用户消息本体 = 真的离开本机的那份文本。 */
function sentUserText(): string {
  const body = JSON.parse(stub.lastBody()) as { messages: { role: string; content: string }[] };
  return body.messages.find((m) => m.role === "user")?.content ?? "";
}

function grantRowCount(revisionId: string): number {
  const rows = booted!.db
    .prepare("select send_content_mode from cloud_send_grant where record_revision_id = ?")
    .all(revisionId) as { send_content_mode: string }[];
  return rows.length;
}

// ── 1. 同一 revision 的两轨预览形状（op6，必过断言 1）─────────────────

describe("op6 两轨预览形状：同一个 revision，换轨改的是载荷本体与策略版本", () => {
  it("raw 轨：policyVersion=raw-v1、payloadText 逐字等于原文、sendContentMode=raw，且没有调 redact()", async () => {
    const { recordId, revisionId } = await createRecord(RAW_PII, "cloud_raw");
    const r = await call("POST", "/api/ingest/preview", { recordId });

    expect(r.status).toBe(200);
    expect(r.json.policyVersion).toBe(RAW_SEND_POLICY_VERSION);
    expect(r.json.policyVersion).toBe("raw-v1");
    expect(r.json.sendContentMode).toBe("raw");
    expect(r.json.payloadText).toBe(RAW_PII);
    expect(r.json.redactedText).toBe(RAW_PII); // raw 轨没有脱敏这一步，两份文本同一份本体
    expect(r.json.payloadSha256).toBe(sha256OfText(RAW_PII));
    expect(r.json.recordRevisionId).toBe(revisionId);
    expect(r.json.hasApplicableGrant).toBe(false);

    // 不调 redact() 的可查证据：敏感词面原样在，且一个占位符都没被造出来。
    expect(r.json.payloadText).toContain("13800138000");
    expect(r.json.payloadText).toContain("laowang@example.com");
    expect(r.json.payloadText).not.toMatch(/\[[a-z_]+_\d+_[0-9a-f]{6}\]/);

    // 映射与坐标这类本地凭据仍然不出现在响应上（两轨同一条纪律）。
    // M9-4c 把 `spans` 写进了 `SendPreviewDto`（预览要显示「哪一段是被谁遮的」），这条纪律的
    // 判据从「键名不在」换成「raw 轨的该字段逐字为空」——键名从来只是代理指标，实质是
    // raw 轨不产任何遮替来源、占位符与坐标。
    for (const forbidden of ['"map"', '"nonce"', '"originalStart"', '"redactionMap"']) {
      expect(r.text).not.toContain(forbidden);
    }
    expect(r.json.spans).toEqual([]);
    expect(r.json.llmLayer).toEqual({ used: false, candidates: 0, dropped: 0 });
    // `redactedSha256` 不在 `SendPreviewDto` 里（0D §五 的 null 是服务层不变式，
    // 契约未对外暴露该字段，本任务不许新增 DTO 字段）⇒ null 那一腿在下一条走服务层断言。
    expect("redactedSha256" in r.json).toBe(false);

    const service = booted!.workspace.grants.prepareRawPreview(revisionId);
    expect(service.redactedSha256).toBeNull();
    expect(service.sendContentMode).toBe("raw");
  });

  it("同一 revision 换到 redacted 轨：policyVersion=rules-v2、payloadText 是脱敏文本", async () => {
    const { recordId, revisionId } = await createRecord(RAW_PII, "cloud_raw");
    const rawPreview = await call("POST", "/api/ingest/preview", { recordId });
    await switchMode(recordId, "cloud_redacted");
    const r = await call("POST", "/api/ingest/preview", { recordId });

    expect(r.status).toBe(200);
    // 换轨不换版本：两轨预览挂的是同一个 revision（Q1 第 4 点「档位挂在记录上」的另一面）。
    expect(r.json.recordRevisionId).toBe(revisionId);
    expect(r.json.recordRevisionId).toBe(rawPreview.json.recordRevisionId);
    expect(r.json.revisionNumber).toBe(rawPreview.json.revisionNumber);

    expect(r.json.policyVersion).toBe(REDACTION_POLICY_VERSION);
    expect(r.json.policyVersion).toBe("rules-v2");
    expect(r.json.sendContentMode).toBe("redacted");
    expect(r.json.payloadText).not.toBe(RAW_PII);
    expect(r.json.payloadText).not.toContain("13800138000");
    expect(r.json.payloadText).not.toContain("laowang@example.com");
    expect(r.json.payloadText).toMatch(/\[[a-z_]+_\d+_[0-9a-f]{6}\]/);
    // 两轨的策略版本腿互不命中，载荷哈希也互不相等（0D §三 的对外可读结果）。
    expect(r.json.policyVersion).not.toBe(rawPreview.json.policyVersion);
    expect(r.json.payloadSha256).not.toBe(rawPreview.json.payloadSha256);
    // 服务层的对照腿：redacted 轨的 redactedSha256 有值，raw 轨才是 null。
    expect(booted!.workspace.grants.preparePreview(revisionId).redactedSha256).toBe(
      sha256OfText(r.json.redactedText as string),
    );
  });

  it("raw 轨拒绝预览替换文本：载荷只能是该版本自己的原文（400，不落 500）", async () => {
    const { recordId } = await createRecord(RAW_PII, "cloud_raw");
    const r = await call("POST", "/api/ingest/preview", { recordId, payloadText: "手改过的载荷" });
    expect(r.status).toBe(400);
    expect(r.json.error).toBe("invalid_request");
    // 拒绝理由透出的只是内部 ID，不回显被拒的替换文本。
    expect(r.text).not.toContain("手改过的载荷");

    // 同一份替换文本在 redacted 轨是合法用法（K-17 的第 5 步）——两轨的差别在这里可见。
    await switchMode(recordId, "cloud_redacted");
    const ok = await call("POST", "/api/ingest/preview", { recordId, payloadText: "手改过的载荷" });
    expect(ok.status).toBe(200);
    expect(ok.json.payloadText).toBe("手改过的载荷");
  });
});

// ── 2. 两轨授权双向不通用，经路由与闸门（必过断言 2）──────────────────

describe("op7 签发的授权经过 op2 闸门后双向不通用（同一个 revision、同一份载荷）", () => {
  it("raw 轨签发 ⇒ raw 轨发送成功；同 revision 换 redacted 轨 ⇒ 409 state_conflict 且一个请求都不外发", async () => {
    const { recordId, revisionId } = await createRecord(TRACK_NEUTRAL, "cloud_raw");

    const preview = await call("POST", "/api/ingest/preview", { recordId });
    expect(preview.json.policyVersion).toBe("raw-v1");

    const confirm = await call("POST", "/api/ingest/confirm-send", { recordId });
    expect(confirm.status).toBe(201);
    expect(confirm.json.policyVersion).toBe("raw-v1");
    expect(confirm.json.payloadSha256).toBe(preview.json.payloadSha256);
    expect(grantRowCount(revisionId)).toBe(1);

    // 该授权在 raw 轨上真的放行：发出的就是原文本体。
    const parse = await call("POST", "/api/ingest/parse", { recordId });
    expect(parse.status).toBe(200);
    expect(parse.json.succeeded).toBe(true);
    expect(parse.json.processingMode).toBe("cloud_raw");
    expect(stub.callCount()).toBe(1);
    expect(sentUserText()).toBe(TRACK_NEUTRAL);

    // 换轨：载荷逐字未变（这条记录没有任何可脱敏内容），变的只有轨道与策略版本两腿。
    await switchMode(recordId, "cloud_redacted");
    const after = await call("POST", "/api/ingest/preview", { recordId });
    expect(after.json.sendContentMode).toBe("redacted");
    expect(after.json.policyVersion).toBe("rules-v2");
    expect(after.json.payloadSha256).toBe(preview.json.payloadSha256); // 同一份内容
    expect(after.json.hasApplicableGrant).toBe(false); // 但那份原文授权对它不可见

    const blocked = await call("POST", "/api/ingest/parse", { recordId });
    expect(blocked.status).toBe(409);
    expect(blocked.json.error).toBe("state_conflict");
    expect(blocked.text).not.toContain(TRACK_NEUTRAL); // 闸门消息只带内部 ID 与类别
    expect(stub.callCount()).toBe(1); // 拒绝发生在任何外发之前
    expect(grantRowCount(revisionId)).toBe(1); // 没有为另一轨偷偷补签一行
  });

  it("反向：redacted 轨签发 ⇒ redacted 轨可用；换 raw 轨 ⇒ 409，且回到原轨仍然放行", async () => {
    const { recordId, revisionId } = await createRecord(TRACK_NEUTRAL, "cloud_redacted");

    const preview = await call("POST", "/api/ingest/preview", { recordId });
    expect(preview.json.policyVersion).toBe("rules-v2");
    const confirm = await call("POST", "/api/ingest/confirm-send", { recordId });
    expect(confirm.json.policyVersion).toBe("rules-v2");

    await switchMode(recordId, "cloud_raw");
    const after = await call("POST", "/api/ingest/preview", { recordId });
    expect(after.json.hasApplicableGrant).toBe(false);
    const blocked = await call("POST", "/api/ingest/parse", { recordId });
    expect(blocked.status).toBe(409);
    expect(blocked.json.error).toBe("state_conflict");
    expect(stub.callCount()).toBe(0); // 这一条从头到尾没有离开本机

    // 脱敏授权对它自己那一轨仍然有效：被拒的是轨道，不是授权本身失效。
    await switchMode(recordId, "cloud_redacted");
    const ok = await call("POST", "/api/ingest/parse", { recordId });
    expect(ok.status).toBe(200);
    expect(ok.json.succeeded).toBe(true);
    expect(stub.callCount()).toBe(1);
    expect(grantRowCount(revisionId)).toBe(1);
  });
});

// ── 3. 失败面的拦截层（必过断言 3）───────────────────────────────────

describe("失败面：缺授权与档位不可用都在建 run 之前被拒", () => {
  it("raw 轨缺授权直接 op2 ⇒ 409 state_conflict，零外发、零写入、不透出原文", async () => {
    const { recordId, revisionId } = await createRecord(RAW_PII, "cloud_raw");
    const preview = await call("POST", "/api/ingest/preview", { recordId });
    expect(preview.json.hasApplicableGrant).toBe(false);

    const r = await call("POST", "/api/ingest/parse", { recordId });
    expect(r.status).toBe(409);
    expect(r.json.error).toBe("state_conflict");
    expect(stub.callCount()).toBe(0);
    for (const secret of ["张三", "蓝山咖啡馆", "13800138000", "laowang@example.com"]) {
      expect(r.text).not.toContain(secret);
    }
    const runs = booted!.db
      .prepare("select count(*) as n from parse_run where source_revision_id = ?")
      .get(revisionId) as { n: number };
    expect(runs.n).toBe(0);
    expect(grantRowCount(revisionId)).toBe(0);
  });

  it("redaction_mode=local_llm 在 op2 被拒为 409 redaction_mode_unavailable（不静默降级成 manual）", async () => {
    const { recordId, revisionId } = await createRecord(TRACK_NEUTRAL, "cloud_redacted");
    // M9-4b：这一档已实现，但 HTTP 面还没接路由（op6 的 `local_llm` 分支属 M9-4c），沙箱配置里也没有
    // 本地模型档位 ⇒ 按 0C §八之三-1 的现场直接写轴列，验的是「不可用」这一支。
    booted!.db
      .prepare(
        `update capture_record
            set processing_mode = 'cloud_redacted', analysis_provider = 'cloud', redaction_mode = 'local_llm',
                send_content_mode = 'redacted'
          where id = ?`,
      )
      .run(recordId);

    const r = await call("POST", "/api/ingest/parse", { recordId });
    expect(r.status).toBe(409);
    expect(r.json.error).toBe("redaction_mode_unavailable"); // 不是 state_conflict，也不是 500
    expect(r.json.reason).toBe("not_configured"); // 封闭取值，逐字等于 `localLlmStatus` 的读数
    expect(r.json.detail).toContain("local_llm");
    expect(stub.callCount()).toBe(0);
    const runs = booted!.db
      .prepare("select count(*) as n from parse_run where source_revision_id = ?")
      .get(revisionId) as { n: number };
    expect(runs.n).toBe(0);
  });

  it("不可用的档位在选择阶段就被拒：local_llm 记录的 op6/op7/op2 三条全 409，零 grant 行", async () => {
    // 0C §八之三-2：被选为 `local_llm` 而当前不可用 ⇒ 返回明确错误码，不落 provider，不得静默降级。
    // 装配层的档位门（`assertRedactionPlanRunnable`）现在站在 op6/op7 的 `previewForEgress` 之前：
    // op6 不再拿规则/实体通道的产出去冒充用户所选那一档，op7 也不再签出一行永远发不出去的授权
    // （那行授权会让前端 `hasApplicableGrant` 变 true，对发不出去的档位给出「可以发送」的暗示）。
    const { recordId, revisionId } = await createRecord(TRACK_NEUTRAL, "cloud_redacted");
    booted!.db
      .prepare(
        `update capture_record
            set processing_mode = 'cloud_redacted', analysis_provider = 'cloud', redaction_mode = 'local_llm',
                send_content_mode = 'redacted'
          where id = ?`,
      )
      .run(recordId);

    const preview = await call("POST", "/api/ingest/preview", { recordId });
    expect(preview.status).toBe(409);
    expect(preview.json.error).toBe("redaction_mode_unavailable");
    expect(preview.json.reason).toBe("not_configured");
    expect(preview.json.detail).toContain("local_llm");
    // 拒绝形状是错误码，不是预览：没有 policyVersion，也就没有 `hasApplicableGrant` 可供前端点头。
    expect("policyVersion" in preview.json).toBe(false);
    expect("hasApplicableGrant" in preview.json).toBe(false);

    const grantsBefore = grantRowCount(revisionId);
    const confirm = await call("POST", "/api/ingest/confirm-send", { recordId });
    expect(confirm.status).toBe(409);
    expect(confirm.json.error).toBe("redaction_mode_unavailable");
    expect(confirm.json.reason).toBe("not_configured");
    expect(grantRowCount(revisionId)).toBe(grantsBefore); // 零新增 cloud_send_grant 行

    const parse = await call("POST", "/api/ingest/parse", { recordId });
    expect(parse.status).toBe(409);
    expect(parse.json.error).toBe("redaction_mode_unavailable");
    expect(parse.json.reason).toBe("not_configured");
    expect(stub.callCount()).toBe(0);
  });
});

// ── 4. 静态对账：本文件的判据来自契约，不是抄来的字面量 ───────────────

describe("装配面的常量与判定点同源", () => {
  it("raw-v1 / rules-v2 两个字面量没有被路由层各抄一份", async () => {
    const routeSrc = readFileSync(join(process.cwd(), "src/server/api/ingestRoutes.ts"), "utf8");
    expect(routeSrc).not.toMatch(/"raw-v1"/);
    expect(routeSrc).not.toMatch(/"rules-v2"/);
    expect(RAW_SEND_POLICY_VERSION).toBe("raw-v1");
    expect(REDACTION_POLICY_VERSION).toBe("rules-v2");
    expect(RAW_SEND_POLICY_VERSION).not.toBe(REDACTION_POLICY_VERSION);
  });
});
