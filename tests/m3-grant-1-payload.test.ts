import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { boot, shutdown, type BootResult } from "../src/server/runtime/bootstrap.ts";
import { ensureConfigFile } from "../src/server/config/config.ts";
import { type DataLayout } from "../src/server/config/paths.ts";
import { migrate } from "../src/server/db/migrator.ts";
import { GrantService } from "../src/server/privacy/grantService.ts";
import { sha256OfText } from "../src/server/privacy/redaction.ts";
import {
  makeSandbox,
  openSandboxDb,
  type Sandbox,
} from "./helpers/sandbox.ts";
import { createRecord } from "./helpers/ingestFixtures.ts";
import {
  FIXTURE_NOW,
  SYSTEM_PROMPT,
  envelopeOf,
  makeAdapter,
  validOutput,
} from "./helpers/ingestFixtures.ts";
import type { StructuredOutput } from "../src/server/ingest/contract.ts";

/**
 * M3-GRANT-1（风险 R-2）：云端往返载荷一致性——op6 预览 → op7 确认 → op2 解析三段
 * 走同一份缓存载荷，payload_sha256 逐字相等；op7 签发的 grant 在 op2 放行面实际可用。
 *
 * 修复前的现场：`redact()` 不传 nonce 时每次随机（redaction.ts:205），三段各自
 * preparePreview ⇒ 三份占位符文本 ⇒ 三个哈希 ⇒ `requireApplicableGrant` 三绑定
 * 永远查不到，云端放行面从未走通（既有面只有 `cloud_grant_missing` 拒绝断言）。
 *
 * 全程离线：Provider 由 `boot({ ingestProvider })` 注入桩 transport（真实 IngestService
 * 全链路，同 m2-api 的验收方式）；数据库只落 TB_DATA_DIR 沙箱。
 */

const RAW_A = "联系我 13800138000 或 zhang@example.com 详谈";
const RAW_B = "换个记录：拨 13911112222 或 li@example.org 详谈";
const REPLACED_TAIL = "（用户手工删掉了地址那半句";

let sandbox: Sandbox | undefined;
let booted: BootResult | undefined;
let base = "";
/** 桩 transport 每次发送时取当前剧本回稿（占位符 nonce 只有预览后才知道）。 */
let currentOutput: () => StructuredOutput = () => validOutput();
/** 已发出的 transport 请求（放行面计数与发送体核对用）。 */
const sentRequests: { body: Record<string, unknown> }[] = [];

interface FakeStub {
  requests(): number;
  lastBody(): string;
}

const stub: FakeStub = {
  requests: () => sentRequests.length,
  lastBody: () => JSON.stringify(sentRequests.at(-1)?.body ?? {}),
};

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

async function ensureBooted(): Promise<BootResult> {
  if (booted !== undefined) return booted;
  const port = await testPort();
  sandbox = makeSandbox("tb-m3-grant1-");
  writePort(sandbox.layout, port);
  sentRequests.length = 0;
  const transport = {
    send: async (
      request: { url: string; body: Record<string, unknown>; headers: Record<string, string>; signal: AbortSignal; callPath: string },
    ) => {
      sentRequests.push(request);
      return { status: 200, body: envelopeOf(currentOutput()) };
    },
  };
  booted = await boot({
    env: { TB_DATA_DIR: sandbox!.root },
    log: () => {},
    ingestProvider: {
      adapter: makeAdapter(),
      transport,
      systemPrompt: SYSTEM_PROMPT,
      now: () => new Date(FIXTURE_NOW),
    },
  });
  base = `http://127.0.0.1:${port}`;
  return booted;
}

afterEach(async () => {
  currentOutput = () => validOutput();
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
  await ensureBooted();
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

async function makeCloudRecord(text = RAW_A): Promise<{ recordId: string; revisionId: string }> {
  const b = await ensureBooted();
  const created = b.workspace.records.createRecord(text);
  b.db
    .prepare("update capture_record set processing_mode = 'cloud_redacted' where id = ?")
    .run(created.record.id);
  return { recordId: created.record.id, revisionId: created.revision.id };
}

/** 从载荷文本抠出占位符与 nonce：`[phone_1_ab12cd]` ⇒ kind/index/nonce。 */
function placeholdersOf(text: string): { kind: string; index: number; nonce: string; raw: string }[] {
  const out: { kind: string; index: number; nonce: string; raw: string }[] = [];
  for (const m of text.matchAll(/\[([a-z_]+)_([0-9]+)_([0-9a-f]{6})\]/g)) {
    out.push({ kind: m[1]!, index: Number(m[2]), nonce: m[3]!, raw: m[0]! });
  }
  return out;
}

/** 证据引用占位符本体的合法云端回稿：词面随本次预览的 nonce 现取。 */
function cloudOutput(phonePh: string, emailPh: string): StructuredOutput {
  return {
    title: "一次联络安排",
    summary: `通过 ${phonePh} 与 ${emailPh} 联络`,
    episodes: [
      {
        summary: "约定联络方式",
        evidence: "详谈",
        eventTime: { raw: "今天", precision: "day", certainty: "explicit", start: "2026-10-17", end: "2026-10-17" },
      },
    ],
    thoughts: [{ text: "电话比邮件直接", evidence: "联系我" }],
    emotions: [{ labelSaid: "期待", candidateConceptId: null, basis: "explicit", evidence: "详谈" }],
    topics: [{ labelSaid: "联络", candidateConceptId: null, basis: "explicit", evidence: "详谈" }],
    entities: [{ labelSaid: phonePh, candidateConceptId: null, basis: "explicit", evidence: phonePh }],
  } as unknown as StructuredOutput;
}

function sentUserText(): string {
  const body = JSON.parse(stub.lastBody()) as { messages: { role: string; content: string }[] };
  const user = body.messages.find((m) => m.role === "user");
  return user?.content ?? "";
}

function grantRowOf(revisionId: string, payloadSha: string): any {
  return booted!.db
    .prepare("select * from cloud_send_grant where record_revision_id = ? and payload_sha256 = ?")
    .get(revisionId, payloadSha);
}

// ── 1. 缓存落 app_meta：nonce 与载荷两份，映射本体不落 ───────────────

describe("预览产物按 revision 缓存（R-2 修复面）", () => {
  it("缓存只落 app_meta 两键：nonce 与最终载荷；spans/坐标/映射本体不在缓存值里", async () => {
    const { recordId } = await makeCloudRecord();
    const preview = await call("POST", "/api/ingest/preview", { recordId });
    expect(preview.status).toBe(200);
    const b = await ensureBooted();
    const rows = b.db.prepare("select key, value from app_meta where key like 'preview_%'").all() as {
      key: string;
      value: string;
    }[];
    const keys = rows.map((r) => r.key);
    expect(keys.some((k) => k.startsWith("preview_nonce:"))).toBe(true);
    expect(keys.some((k) => k.startsWith("preview_payload:"))).toBe(true);
    const serialized = JSON.stringify(rows);
    for (const forbidden of ["spans", "originalStart", "redactedStart", "placeholder", '"map"', "13800138000", "zhang@example.com"]) {
      expect(serialized).not.toContain(forbidden);
    }
    // nonce 值 = 载荷占位符里的 nonce（证明缓存的就是那份产物）
    const nonceRow = rows.find((r) => r.key.startsWith("preview_nonce:"))!;
    expect(preview.json.payloadText).toContain(`_${nonceRow.value}]`);
  });

  it("同 revision 重复预览：nonce 同一份、文本逐字稳定（同载荷同哈希）", async () => {
    const { recordId } = await makeCloudRecord();
    const p1 = await call("POST", "/api/ingest/preview", { recordId });
    const p2 = await call("POST", "/api/ingest/preview", { recordId });
    expect(p2.json.payloadText).toBe(p1.json.payloadText);
    expect(p2.json.payloadSha256).toBe(p1.json.payloadSha256);
    expect(placeholdersOf(p2.json.payloadText).map((p) => p.nonce)).toEqual(
      placeholdersOf(p1.json.payloadText).map((p) => p.nonce),
    );
  });

  it("显式注入 nonce 的调用绕过缓存：不读写 app_meta 缓存键", async () => {
    const b = await ensureBooted();
    const s = new GrantService(b.db);
    const { recordId, revisionId } = await makeCloudRecord();
    const before = b.db.prepare("select count(*) as n from app_meta where key like 'preview_%'").get() as { n: number };
    const preview = s.preparePreview(revisionId, { nonce: "abcdef", entities: [] });
    const after = b.db.prepare("select count(*) as n from app_meta where key like 'preview_%'").get() as { n: number };
    expect(after.n).toBe(before.n);
    expect(preview.payloadText).toContain("_abcdef]");
    void recordId;
  });
});

// ── 2. 三段往返：op6 → op7 → op2 放行面实际可用，哈希逐字一致 ────────

describe("op6→op7→op2 完整三段（放行面，沙箱 + Provider 桩，全程离线）", () => {
  it("op7 签发的 grant 在 op2 实际可用：requireApplicableGrant 放行，解析成功", async () => {
    const { recordId, revisionId } = await makeCloudRecord();

    const p = await call("POST", "/api/ingest/preview", { recordId });
    expect(p.status).toBe(200);
    expect(p.json.hasApplicableGrant).toBe(false);
    const ph = placeholdersOf(p.json.payloadText as string);
    const phone = ph.find((x) => x.kind === "phone")!;
    const email = ph.find((x) => x.kind === "email")!;
    expect(p.json.payloadText).not.toContain("13800138000");
    expect(p.json.payloadText).not.toContain("zhang@example.com");

    const confirm = await call("POST", "/api/ingest/confirm-send", { recordId });
    expect(confirm.status).toBe(201);
    expect(confirm.json.payloadSha256).toBe(p.json.payloadSha256);

    // 确认后预览如实上报「已有适用授权」
    const pAfter = await call("POST", "/api/ingest/preview", { recordId });
    expect(pAfter.json.hasApplicableGrant).toBe(true);
    expect(pAfter.json.payloadText).toBe(p.json.payloadText);

    currentOutput = () => cloudOutput(phone.raw, email.raw);
    const parse = await call("POST", "/api/ingest/parse", { recordId });
    expect(parse.status).toBe(200);
    expect(parse.json.succeeded).toBe(true);
    expect(parse.json.processingMode).toBe("cloud_redacted");
    expect(stub.requests()).toBe(1);

    // 三段 payload_sha256 逐字相等：预览产出的 = 确认落库的 = 解析校验的
    const sent = sentUserText();
    expect(sent).toBe(p.json.payloadText);
    const sentSha = createHash("sha256").update(sent).digest("hex");
    expect(sentSha).toBe(p.json.payloadSha256);
    expect(sentSha).toBe(confirm.json.payloadSha256);
    const row = grantRowOf(revisionId, p.json.payloadSha256);
    expect(row).toBeTruthy();
    expect(row.policy_version).toBe(confirm.json.policyVersion);
  });

  it("用户手工替换载荷：替换那份成为 op7 签发与 op2 复用的同一份，三段哈希一致", async () => {
    const { recordId, revisionId } = await makeCloudRecord();
    const p0 = await call("POST", "/api/ingest/preview", { recordId });
    const ph = placeholdersOf(p0.json.payloadText as string);
    const email = ph.find((x) => x.kind === "email")!;
    const replaced = `${p0.json.payloadText}${REPLACED_TAIL}）`;
    const replacedSha = sha256OfText(replaced);

    const p1 = await call("POST", "/api/ingest/preview", { recordId, payloadText: replaced });
    expect(p1.json.payloadText).toBe(replaced);
    expect(p1.json.payloadSha256).toBe(replacedSha);

    const confirm = await call("POST", "/api/ingest/confirm-send", { recordId, payloadText: replaced });
    expect(confirm.json.payloadSha256).toBe(replacedSha);

    // op2 不带 payloadText：复用缓存里被替换的那份
    currentOutput = () => cloudOutput(ph.find((x) => x.kind === "phone")!.raw, email.raw);
    const parse = await call("POST", "/api/ingest/parse", { recordId });
    expect(parse.json.succeeded).toBe(true);
    expect(sentUserText()).toBe(replaced);
    expect(createHash("sha256").update(sentUserText()).digest("hex")).toBe(replacedSha);
    expect(grantRowOf(revisionId, replacedSha)).toBeTruthy();

    // 手工替换后默认预览回报的也是替换后的载荷（缓存以用户确认为准）
    const p2 = await call("POST", "/api/ingest/preview", { recordId });
    expect(p2.json.payloadText).toBe(replaced);
  });

  it("既有拒绝面保持：cloud_redacted 未确认直接 op2 → 409 state_conflict、零外发、零 run 行", async () => {
    const { recordId, revisionId } = await makeCloudRecord();
    const parse = await call("POST", "/api/ingest/parse", { recordId });
    expect(parse.status).toBe(409);
    expect(parse.json.error).toBe("state_conflict");
    expect(parse.text).not.toContain("13800138000");
    expect(parse.text).not.toContain("zhang@example.com");
    for (const forbidden of ['"spans"', '"map"', '"nonce"', '"originalStart"']) {
      expect(parse.text).not.toContain(forbidden);
    }
    expect(stub.requests()).toBe(0);
    const runs = booted!.db
      .prepare("select count(*) as n from parse_run where source_revision_id = ?")
      .get(revisionId) as { n: number };
    expect(runs.n).toBe(0);
  });
});

// ── 3. 跨 revision 防串发 + 缓存失效 ────────────────────────────────

describe("跨 revision 不串发（缓存失效语义）", () => {
  it("同文本两个记录各自走三段：nonce 不同、载荷哈希不同、grant 互不可用", async () => {
    const a = await makeCloudRecord(RAW_A);
    const b = await makeCloudRecord(RAW_A);
    const pa = await call("POST", "/api/ingest/preview", { recordId: a.recordId });
    const pb = await call("POST", "/api/ingest/preview", { recordId: b.recordId });
    // 同内容不同 revision：nonce 随机量跨 revision 必须不同（防关联/防串发的正面）
    expect(pb.json.payloadText).not.toBe(pa.json.payloadText);
    expect(pb.json.payloadSha256).not.toBe(pa.json.payloadSha256);

    const ca = await call("POST", "/api/ingest/confirm-send", { recordId: a.recordId });
    const cb = await call("POST", "/api/ingest/confirm-send", { recordId: b.recordId });
    await ensureBooted();
    const grants = new GrantService(booted!.db);
    // A 的 grant 对 B 不可用（三绑定第一腿 revision 就断），反之亦然
    expect(grants.findApplicableGrant(b.revisionId, pa.json.payloadSha256, ca.json.policyVersion)).toBeNull();
    expect(grants.findApplicableGrant(a.revisionId, pb.json.payloadSha256, cb.json.policyVersion)).toBeNull();
    expect(grants.findApplicableGrant(a.revisionId, pa.json.payloadSha256, ca.json.policyVersion)).toBeTruthy();
    expect(grants.findApplicableGrant(b.revisionId, pb.json.payloadSha256, cb.json.policyVersion)).toBeTruthy();

    // B 直接 op2：用的仍是 B 自己缓存的载荷，不会被 A 的缓存外溢污染
    const phB = placeholdersOf(pb.json.payloadText as string);
    currentOutput = () =>
      cloudOutput(phB.find((x) => x.kind === "phone")!.raw, phB.find((x) => x.kind === "email")!.raw);
    const parse = await call("POST", "/api/ingest/parse", { recordId: b.recordId });
    expect(parse.json.succeeded).toBe(true);
    expect(sentUserText()).toBe(pb.json.payloadText);
  });

  it("内容编辑产生新 revision：旧缓存不外溢，新 revision 预览哈希与旧载荷不同且首预览不继承旧载荷", async () => {
    const { recordId, revisionId } = await makeCloudRecord();
    const p1 = await call("POST", "/api/ingest/preview", { recordId });
    // 先做用户手工替换，让旧 revision 缓存里带上一份替换载荷
    const replaced = `${p1.json.payloadText}（改过）`;
    await call("POST", "/api/ingest/confirm-send", { recordId, payloadText: replaced });

    const b = await ensureBooted();
    const edited = b.workspace.records.editRecord(recordId, `${RAW_A}，改日再聊`);
    expect(edited.changed).toBe(true);
    expect(edited.revision.id).not.toBe(revisionId);

    const p2 = await call("POST", "/api/ingest/preview", { recordId });
    expect(p2.json.recordRevisionId).toBe(edited.revision.id);
    // 新 revision 的首预览绝不等于旧 revision 的替换载荷，也不等于旧默认载荷
    expect(p2.json.payloadText).not.toBe(replaced);
    expect(p2.json.payloadText).not.toBe(p1.json.payloadText);
    expect(p2.json.payloadSha256).not.toBe(p1.json.payloadSha256);
    // nonce 也是新的（占位符 nonce 不同）
    expect(placeholdersOf(p2.json.payloadText as string)[0]!.nonce).not.toBe(
      placeholdersOf(p1.json.payloadText as string)[0]!.nonce,
    );
    // 旧载荷仍只在旧 revision 的缓存键上
    const oldPayload = b.db
      .prepare("select value from app_meta where key = ?")
      .get(`preview_payload:${revisionId}`) as { value: string } | undefined;
    expect(oldPayload?.value).toBe(replaced);
  });
});

// ── 4. K-17 与三绑定语义不变（服务端面，独立沙箱库） ─────────────────

describe("K-17 复用与三绑定：修复后语义逐条不变", () => {
  let sbox: Sandbox | undefined;
  let db: ReturnType<typeof openSandboxDb> | undefined;

  function setup(): { grants: GrantService; db: NonNullable<typeof db>; revisionId: string } {
    sbox = makeSandbox("tb-m3-grant1-svc-");
    db = openSandboxDb(sbox.layout);
    migrate(db);
    const rec = createRecord(db, "和张三在蓝山咖啡馆见面 13800138000", "cloud_redacted");
    const service = new GrantService(db, { now: () => new Date(FIXTURE_NOW) });
    return { grants: service, db, revisionId: rec.revisionId };
  }

  afterEach(() => {
    db?.close();
    sbox?.cleanup();
    db = undefined;
    sbox = undefined;
  });

  it("同载荷重复确认命中 K-17 复用：首次 confirmed_at 保持、表内仍一行", async () => {
    const { recordId, revisionId } = await makeCloudRecord();
    const p = await call("POST", "/api/ingest/preview", { recordId });
    const c1 = await call("POST", "/api/ingest/confirm-send", { recordId });
    const c2 = await call("POST", "/api/ingest/confirm-send", { recordId });
    expect(c2.json.grantId).toBe(c1.json.grantId);
    expect(c2.json.confirmedAtUtc).toBe(c1.json.confirmedAtUtc);
    await ensureBooted();
    const rows = booted!.db
      .prepare("select count(*) as n from cloud_send_grant where record_revision_id = ?")
      .get(revisionId) as { n: number };
    expect(rows.n).toBe(1);
    expect(p.status).toBe(200);
  });

  it("三绑定不得放宽：policy_version 不同即不适用（revision+哈希对齐也查不到）", () => {
    const { grants: g, db: svcDb, revisionId } = setup();
    const preview = g.preparePreview(revisionId);
    const grant = g.issueGrant(preview, { confirmedAtUtc: "2026-10-17T01:00:00.000Z" });
    // 手写一条只差 policy_version 的行：证明查询是三腿全等，不是两腿
    svcDb
      .prepare(
        `insert into cloud_send_grant (id, record_revision_id, redacted_sha256, payload_sha256, policy_version, confirmed_at_utc)
         values ('csg_policy_v9_probe', ?, ?, ?, 'rules-v9', '2026-10-17T01:00:00.000Z')`,
      )
      .run(revisionId, grant.redacted_sha256, grant.payload_sha256);
    expect(g.findApplicableGrant(revisionId, preview.payloadSha256, "rules-v9")?.id).toBe("csg_policy_v9_probe");
    expect(g.findApplicableGrant(revisionId, preview.payloadSha256, preview.policyVersion)?.id).toBe(grant.id);
    // 两腿匹配的那条不构成对当前 policy 的授权
    expect(g.requireApplicableGrant(revisionId, preview.payloadSha256, preview.policyVersion).id).toBe(grant.id);
    svcDb.prepare("delete from cloud_send_grant where id = 'csg_policy_v9_probe'").run();
  });

  it("无 grant 时 requireApplicableGrant 仍拒：cloud_grant_missing 拒绝面不因缓存放行面而削弱", () => {
    const { grants: g, db: svcDb, revisionId } = setup();
    const preview = g.preparePreview(revisionId);
    expect(() =>
      g.requireApplicableGrant(revisionId, sha256OfText(`${preview.payloadText}没确认过的载荷`), preview.policyVersion),
    ).toThrow(/没有适用授权/);
    expect(() => g.requireApplicableGrant(revisionId, "f".repeat(64), preview.policyVersion)).toThrow(
      /没有适用授权/,
    );
  });

  it("同 revision 二次预览再确认：复用同一 grant（缓存文本稳定直接喂给 K-17）", () => {
    const { grants: g, db: svcDb, revisionId } = setup();
    const p1 = g.preparePreview(revisionId);
    const first = g.issueGrant(p1, { confirmedAtUtc: "2026-10-17T02:00:00.000Z" });
    const p2 = g.preparePreview(revisionId);
    expect(p2.payloadText).toBe(p1.payloadText);
    expect(p2.payloadSha256).toBe(p1.payloadSha256);
    const again = g.issueGrant(p2);
    expect(again.id).toBe(first.id);
    expect(again.confirmed_at_utc).toBe("2026-10-17T02:00:00.000Z");
  });
});
