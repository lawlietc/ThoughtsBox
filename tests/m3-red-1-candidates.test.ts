import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import { boot, shutdown, type BootResult } from "../src/server/runtime/bootstrap.ts";
import { ensureConfigFile } from "../src/server/config/config.ts";
import { type DataLayout } from "../src/server/config/paths.ts";
import { migrate } from "../src/server/db/migrator.ts";
import { GrantService } from "../src/server/privacy/grantService.ts";
import {
  REDACTION_POLICY_VERSION,
  collectKnownEntities,
  redact,
  type KnownEntity,
} from "../src/server/privacy/redaction.ts";
import { deriveNameCandidates } from "../src/server/privacy/candidates.ts";
import { confirmCandidateEntities } from "../src/server/privacy/entityConfirm.ts";
import { loadEnums } from "../src/shared/contracts/load.ts";
import { makeSandbox, openSandboxDb, type Sandbox } from "./helpers/sandbox.ts";
import {
  FIXTURE_NOW,
  SYSTEM_PROMPT,
  envelopeOf,
  makeAdapter,
  validOutput,
} from "./helpers/ingestFixtures.ts";
import { createRecord } from "./helpers/ingestFixtures.ts";
import type { StructuredOutput } from "../src/server/ingest/contract.ts";

/**
 * M3-RED-1：陌生名字的脱敏缺口（方向乙+丁）。缺口清单 §五「已定」五条逐条实测。
 *
 * - ①占位符带类型；②候选只进预览 + 确认落 provisional + 类型取值门 + 跳过=原样发；
 * - ③provisional 路径（不进默认浏览、零模型调用）；④不走「先发再遮」；⑤如实告知面。
 * - 一并修 GRANT-1 缓存残行（删除清 preview_nonce/preview_payload 两键）。
 *
 * 「零模型调用」用两层实证：Group B 全程 `openSandboxDb`（**不 boot、不装任何 Provider**）
 * 也能走完「确认 → 该词被既有通道遮掉」；HTTP 组实测 confirm-candidates 后 transport 计数仍为 0。
 */

const ENTITY_TYPES = loadEnums().entity_types as readonly string[];

// ── ① 占位符带类型（纯函数，无 Provider）────────────────────────────

describe("① 占位符 kind 面：类型进占位符字面", () => {
  it("每种实体 kind 的占位符都带该 kind 字面：[<kind>_<index>_<nonce>]", () => {
    const kinds = ["person", "organization", "place", "work", "product", "activity", "event", "other"];
    for (const kind of kinds) {
      const term = `某${kind}词`;
      const entities: KnownEntity[] = [{ entityId: `entity_${kind}`, entityType: kind, terms: [term] }];
      const { redactedText, map } = redact(`前缀${term}后缀`, entities, { nonce: "abcdef" });
      expect(map.spans).toHaveLength(1);
      const ph = map.spans[0]!.placeholder;
      expect(ph).toBe(`[${kind}_1_abcdef]`);
      expect(redactedText).not.toContain(term);
      expect(redactedText).toContain(ph);
      expect(map.spans[0]!.kind).toBe(kind);
    }
  });

  it("形状不变式：kind_index_nonce 三段，nonce 复用不漂", () => {
    const entities: KnownEntity[] = [{ entityId: "e1", entityType: "person", terms: ["王小明"] }];
    const { map } = redact("王小明和王小明", entities, { nonce: "ff00aa" });
    expect(map.spans.every((s) => /^\[person_[0-9]+_ff00aa\]$/.test(s.placeholder))).toBe(true);
    // 同一请求内同一实体共用同一占位符（长度 2 命中 → 1 个去重键）
    expect(new Set(map.spans.map((s) => s.placeholder)).size).toBe(1);
  });
});

// ── ②a 候选规则层（纯函数，无 Provider，绝不进 redact 替换集）────────

describe("②a 陌生名字候选规则层", () => {
  it("姓氏 + 上下文线索捞出候选：词面逐字、建议 kind ∈ 8 值、含出现位置", () => {
    const text = "王小明说今天要开会";
    const cands = deriveNameCandidates(text, []);
    const wang = cands.find((c) => c.term === "王小明");
    expect(wang).toBeDefined();
    expect(ENTITY_TYPES).toContain(wang!.suggestedKind);
    expect(wang!.occurrences.length).toBeGreaterThan(0);
    expect(wang!.occurrences[0]).toBe(text.indexOf("王小明"));
    expect(wang!.basis.length).toBeGreaterThan(0);
  });

  it("已确认实体的词面不作候选（它本就被既有通道遮掉）", () => {
    const text = "老周和小李都在";
    const known: KnownEntity[] = [{ entityId: "e1", entityType: "person", terms: ["老周"] }];
    const cands = deriveNameCandidates(text, known);
    expect(cands.some((c) => c.term === "老周")).toBe(false);
  });

  it("格式化命中不是候选来源：纯手机/邮箱文本零候选", () => {
    expect(deriveNameCandidates("联系我 13800138000 或 zhang@example.com 详谈", [])).toEqual([]);
  });

  it("机构后缀 → 建议 organization", () => {
    const cands = deriveNameCandidates("在蓝山公司上班", []);
    const org = cands.find((c) => c.suggestedKind === "organization");
    expect(org).toBeDefined();
    expect(org!.term.endsWith("公司") || org!.term.includes("公司")).toBe(true);
  });

  it("候选不改脱敏集合：候选词在确认前不进 redact() 的替换（payload 不含该词被遮的证据）", () => {
    const text = "王小明说今天要开会";
    const cands = deriveNameCandidates(text, []);
    const term = cands[0]!.term;
    // 拿候选词去 redact，不注入任何已确认实体 ⇒ 原文逐字不被遮（候选只进预览，脱敏集合没变）
    const { redactedText } = redact(text, [], { nonce: "abcdef" });
    expect(redactedText).toBe(text);
    expect(redactedText).toContain(term);
    // policy 面也没变
    expect(REDACTION_POLICY_VERSION).toBe("rules-v1");
  });
});

// ── ③ provisional 路径：确认 → 第二次出现自动遮（全程不装 Provider）──

describe("③ 确认落 provisional 实体 + 第二次出现自动遮（零模型调用面）", () => {
  let sbox: Sandbox | undefined;
  let db: ReturnType<typeof openSandboxDb> | undefined;

  afterEach(() => {
    db?.close();
    sbox?.cleanup();
    db = undefined;
    sbox = undefined;
  });

  it("不装 Provider 桩也能走完：确认前该词原样，确认后进词表、再脱敏即被既有通道遮掉", () => {
    sbox = makeSandbox("tb-m3-red1-svc-");
    db = openSandboxDb(sbox.layout);
    migrate(db);
    const text = "王小明今天来开会";
    const rec = createRecord(db, text, "cloud_redacted");

    // 确认前：候选存在，但该词不会被 redact 遮（无已确认实体）
    const before = deriveNameCandidates(text, collectKnownEntities(db));
    expect(before.some((c) => c.term === "王小明")).toBe(true);
    const s0 = new GrantService(db, { now: () => new Date(FIXTURE_NOW) });
    expect(s0.preparePreview(rec.revisionId, { nonce: "abcdef" }).redactedText).toContain("王小明");

    // 确认「王小明」为 person ⇒ 纯本地写入，本用例里没有 provider，照样跑通
    const res = confirmCandidateEntities(db, [{ term: "王小明", kind: "person" }], () => new Date(FIXTURE_NOW));
    expect(res.created).toHaveLength(1);

    // 落库形状：provisional + user_created + 词面逐字（canonical/display/alias 三处都是原词）
    const row = db
      .prepare("select entity_type, canonical_name, display_name, lifecycle_status, origin_type from entity where id = ?")
      .get(res.created[0]!.entityId) as Record<string, string>;
    expect(row.lifecycle_status).toBe("provisional");
    expect(row.origin_type).toBe("user_created");
    expect(row.entity_type).toBe("person");
    expect(row.canonical_name).toBe("王小明");
    expect(row.display_name).toBe("王小明");
    const alias = db.prepare("select alias from entity_alias where entity_id = ?").get(res.created[0]!.entityId) as {
      alias: string;
    };
    expect(alias.alias).toBe("王小明");

    // 第二次出现：该词现在是已确认实体 ⇒ collectKnownEntities 读到 ⇒ redact 既有通道遮掉它
    const known = collectKnownEntities(db);
    expect(known.some((e) => e.terms.includes("王小明"))).toBe(true);
    const s1 = new GrantService(db, { now: () => new Date(FIXTURE_NOW) });
    const after = s1.preparePreview(rec.revisionId, { nonce: "abcdef" });
    expect(after.redactedText).not.toContain("王小明");
    expect(after.redactedText).toContain("[person_1_abcdef]");
    expect(after.policyVersion).toBe("rules-v1"); // 不升版
  });

  it("不进默认浏览：确认的 provisional 实体没有任何 mention，绝不进派生实体列表", () => {
    sbox = makeSandbox("tb-m3-red1-browse-");
    db = openSandboxDb(sbox.layout);
    migrate(db);
    const rec = createRecord(db, "王小明今天来开会", "cloud_redacted");
    const res = confirmCandidateEntities(db, [{ term: "王小明", kind: "person" }], () => new Date(FIXTURE_NOW));
    const mentions = db
      .prepare("select count(*) as n from entity_mention where entity_id = ?")
      .get(res.created[0]!.entityId) as { n: number };
    expect(mentions.n).toBe(0);
    // 默认浏览（currentView.entities）源自 entity_mention；无 mention ⇒ 不可能进默认实体列表
    const anyActiveMention = db
      .prepare("select count(*) as n from entity_mention")
      .get() as { n: number };
    expect(anyActiveMention.n).toBe(0);
    void rec;
  });

  it("幂等：重复确认同一词不再新建（skipped），库里仍一条 entity", () => {
    sbox = makeSandbox("tb-m3-red1-idem-");
    db = openSandboxDb(sbox.layout);
    migrate(db);
    createRecord(db, "王小明来了", "cloud_redacted");
    const a = confirmCandidateEntities(db, [{ term: "王小明", kind: "person" }], () => new Date(FIXTURE_NOW));
    const b = confirmCandidateEntities(db, [{ term: "王小明", kind: "person" }], () => new Date(FIXTURE_NOW));
    expect(a.created).toHaveLength(1);
    expect(b.created).toHaveLength(0);
    expect(b.skipped).toContain("王小明");
    const n = db.prepare("select count(*) as c from entity where canonical_name = '王小明'").get() as { c: number };
    expect(n.c).toBe(1);
  });

  it("②e 取值门：非法 kind 抛错（词面不入库）", () => {
    sbox = makeSandbox("tb-m3-red1-gate-");
    const handle = openSandboxDb(sbox.layout);
    db = handle;
    migrate(handle);
    createRecord(handle, "赵二狗来了", "cloud_redacted");
    expect(() =>
      confirmCandidateEntities(handle, [{ term: "赵二狗", kind: "not_a_kind" }], () => new Date(FIXTURE_NOW)),
    ).toThrow(/kind 不在封闭集内/);
    const n = handle
      .prepare("select count(*) as c from entity where canonical_name = '赵二狗'")
      .get() as { c: number };
    expect(n.c).toBe(0);
  });
});

// ── HTTP 面：预览带候选、确认端点、跳过、④拒绝面、缓存清理残行 ────────

let sandbox: Sandbox | undefined;
let booted: BootResult | undefined;
let base = "";
const sentRequests: { body: Record<string, unknown> }[] = [];
let currentOutput: () => StructuredOutput = () => validOutput();

async function testPort(): Promise<number> {
  const { createServer } = await import("node:net");
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const addr = probe.address();
      if (addr === null || typeof addr === "string") return reject(new Error("无法取得空闲端口"));
      const port = addr.port;
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
  sandbox = makeSandbox("tb-m3-red1-http-");
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

async function makeCloudRecord(text: string): Promise<{ recordId: string; revisionId: string }> {
  const b = await ensureBooted();
  const created = b.workspace.records.createRecord(text);
  b.db.prepare("update capture_record set processing_mode = 'cloud_redacted' where id = ?").run(created.record.id);
  return { recordId: created.record.id, revisionId: created.revision.id };
}

describe("②b/②c HTTP：预览带候选 + 确认端点 + 第二次出现自动遮", () => {
  it("预览返回候选只读段；既有字段逐字不动；payload 不含候选被遮（脱敏集合未变）", async () => {
    const { recordId } = await makeCloudRecord("王小明说明天见");
    const p = await call("POST", "/api/ingest/preview", { recordId });
    expect(p.status).toBe(200);
    // 既有字段名逐字在
    for (const key of [
      "recordId",
      "recordRevisionId",
      "revisionNumber",
      "policyVersion",
      "redactedText",
      "payloadText",
      "payloadSha256",
      "hasApplicableGrant",
    ]) {
      expect(key in p.json).toBe(true);
    }
    expect(p.json.policyVersion).toBe("rules-v1");
    expect(Array.isArray(p.json.candidates)).toBe(true);
    const wang = p.json.candidates.find((c: any) => c.term === "王小明");
    expect(wang).toBeDefined();
    expect(ENTITY_TYPES).toContain(wang.suggestedKind);
    expect(Array.isArray(wang.occurrences)).toBe(true);
    // 候选没改变待发文本：该词仍原样（陌生名字第一次出现，符合缺口现状）
    expect(p.json.payloadText).toContain("王小明");
  });

  it("确认采纳 → provisional；再预览该词被既有通道遮掉；全程零外发（transport 计数 0）", async () => {
    const { recordId, revisionId } = await makeCloudRecord("王小明说明天见");
    const before = await call("POST", "/api/ingest/confirm-candidates", {
      recordId,
      adopted: [{ term: "王小明", kind: "person" }],
    });
    expect(before.status).toBe(201);
    expect(before.json.created).toHaveLength(1);
    // 纯本地：确认没触发任何一次发送
    expect(sentRequests.length).toBe(0);

    // 确认改变了脱敏依据 ⇒ 缓存已作废，下一次预览现算、该词被遮
    const after = await call("POST", "/api/ingest/preview", { recordId });
    expect(after.json.payloadText).not.toContain("王小明");
    expect(after.json.payloadText).toContain("[person_1_");
    expect(after.json.policyVersion).toBe("rules-v1");

    const row = (await ensureBooted()).db
      .prepare("select lifecycle_status, origin_type from entity where id = ?")
      .get(before.json.created[0].entityId) as { lifecycle_status: string; origin_type: string };
    expect(row.lifecycle_status).toBe("provisional");
    expect(row.origin_type).toBe("user_created");
    void revisionId;
  });

  it("②e 取值门：HTTP 面非法 kind → 400 invalid_request，且不落库", async () => {
    const { recordId } = await makeCloudRecord("赵二狗来了");
    const bad = await call("POST", "/api/ingest/confirm-candidates", {
      recordId,
      adopted: [{ term: "赵二狗", kind: "superhero" }],
    });
    expect(bad.status).toBe(400);
    expect(bad.json.error).toBe("invalid_request");
    const b = await ensureBooted();
    const n = b.db.prepare("select count(*) as c from entity where canonical_name = '赵二狗'").get() as { c: number };
    expect(n.c).toBe(0);
  });

  it("②d 跳过=不遮=原样发：未确认的候选词在预览里仍原样（不自动遮）", async () => {
    const { recordId } = await makeCloudRecord("王小明和李小华都到场");
    const p = await call("POST", "/api/ingest/preview", { recordId });
    const li = p.json.candidates.find((c: any) => c.term.includes("李小华")) ?? { term: "李小华" };
    // 只确认王小明，跳过李小华 ⇒ 预览后李小华仍原样
    await call("POST", "/api/ingest/confirm-candidates", {
      recordId,
      adopted: [{ term: "王小明", kind: "person" }],
    });
    const after = await call("POST", "/api/ingest/preview", { recordId });
    expect(after.json.payloadText).not.toContain("王小明");
    expect(after.json.payloadText).toContain(li.term);
  });

  it("④ 不走先发再遮：确认候选不签发 grant、op2 未确认仍 409 且零外发", async () => {
    const { recordId } = await makeCloudRecord("王小明说明天见");
    await call("POST", "/api/ingest/confirm-candidates", {
      recordId,
      adopted: [{ term: "王小明", kind: "person" }],
    });
    // 确认候选 ≠ 确认发送：没有 grant，直接 op2 被闸门拒
    const parse = await call("POST", "/api/ingest/parse", { recordId });
    expect(parse.status).toBe(409);
    expect(parse.json.error).toBe("state_conflict");
    expect(sentRequests.length).toBe(0);
    const grants = (await ensureBooted()).db
      .prepare("select count(*) as n from cloud_send_grant")
      .get() as { n: number };
    expect(grants.n).toBe(0);
  });
});

describe("GRANT-1 残行修复：删记录后预览缓存两键消失（K-09 不留痕）", () => {
  it("预览写入两键 → 删除记录 → 该 revision 两键都不在 app_meta", async () => {
    const { recordId, revisionId } = await makeCloudRecord("联系我 13800138000 详谈");
    const p = await call("POST", "/api/ingest/preview", { recordId });
    expect(p.status).toBe(200);
    const b = await ensureBooted();
    const nonceKey = `preview_nonce:${revisionId}`;
    const payloadKey = `preview_payload:${revisionId}`;
    const has = (k: string) => b.db.prepare("select 1 as h from app_meta where key = ?").get(k) !== undefined;
    expect(has(nonceKey)).toBe(true);
    expect(has(payloadKey)).toBe(true);
    // 载荷里本就没有原文手机号（脱敏后），但键存在即缓存本体
    b.workspace.records.deleteRecord(recordId);
    expect(has(nonceKey)).toBe(false);
    expect(has(payloadKey)).toBe(false);
  });
});
