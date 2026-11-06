/**
 * Phase D / S10 词表管理。
 *
 * 钉四件事：
 *  1. `mask_enabled` 是**持久开关**（缺省 1，存量行保持原行为）；
 *  2. L1 只读 `mask_enabled=1` 的实体，关掉就真的不再替换；
 *  3. 预览的每一处词表命中都带 `entityId`（其他来源为 null），界面才能就地「这个词不脱敏」；
 *  4. 开关变化清掉该 revision 的预览缓存，避免旧载荷与旧授权对不上新词表。
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureConfigFile } from "../src/server/config/config.ts";
import type { DataLayout } from "../src/server/config/paths.ts";
import { migrate } from "../src/server/db/migrator.ts";
import type { Database } from "../src/server/db/adapter.ts";
import {
  EntityVocabularyError,
  listVocabulary,
  setEntityMask,
} from "../src/server/entities/vocabulary.ts";
import { GrantService } from "../src/server/privacy/grantService.ts";
import { collectKnownEntities, redact } from "../src/server/privacy/redaction.ts";
import { RecordService } from "../src/server/records/service.ts";
import { boot, shutdown, type BootResult } from "../src/server/runtime/bootstrap.ts";
import { makeSandbox, openSandboxDb, type Sandbox } from "./helpers/sandbox.ts";
import {
  FIXTURE_NOW,
  OK_ENVELOPE,
  SYSTEM_PROMPT,
  makeAdapter,
  stubTransport,
  validOutput,
} from "./helpers/ingestFixtures.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const sourceAt = (relative: string): string =>
  readFileSync(join(ROOT, relative), "utf8").replace(/\r\n/g, "\n");

const NOW = "2026-11-05T01:00:00.000Z";
const RAW = "张三说明天去杭州，电话 13800138000";

let sandbox: Sandbox;
let db: Database;
let revisionId: string;

beforeEach(() => {
  sandbox = makeSandbox("tb-phaseD-vocab-");
  db = openSandboxDb(sandbox.layout);
  migrate(db);
  const records = new RecordService(db, { timezoneId: "Asia/Shanghai", now: () => new Date(NOW) });
  revisionId = records.createRecord(RAW).revision.id;
});

afterEach(() => {
  db.close();
  sandbox.cleanup();
});

function insertEntity(
  handle: Database,
  id: string,
  entityType: string,
  term: string,
  lifecycle = "active",
  origin = "user_created",
): void {
  handle.prepare(
    `insert into entity (id, entity_type, canonical_name, display_name, lifecycle_status, privacy_level, origin_type, created_at_utc)
     values (?, ?, ?, ?, ?, 'normal', ?, ?)`,
  ).run(id, entityType, term, term, lifecycle, origin, NOW);
}

function entityRow(id: string): { mask_enabled: number } | undefined {
  return db.prepare("select mask_enabled from entity where id = ?").get(id) as
    | { mask_enabled: number }
    | undefined;
}

describe("Phase D · mask_enabled 是持久开关", () => {
  it("迁移后列存在、缺省为 1，存量行为逐字不变", () => {
    const column = (
      db.prepare(`select name, dflt_value, "notnull" as not_null from pragma_table_info('entity') where name = 'mask_enabled'`).get() as
        | { name: string; dflt_value: string; not_null: number }
        | undefined
    );
    expect(column).toEqual({ name: "mask_enabled", dflt_value: "1", not_null: 1 });

    insertEntity(db, "entity_zhang", "person", "张三");
    expect(entityRow("entity_zhang")!.mask_enabled).toBe(1);
  });

  it("只列 person / place / organization：词表本来就不遮其他类型", () => {
    insertEntity(db, "entity_zhang", "person", "张三");
    insertEntity(db, "entity_hz", "place", "杭州");
    insertEntity(db, "entity_santi", "work", "三体");
    const ids = listVocabulary(db).map((row) => row.entityId);
    expect(ids).toEqual(expect.arrayContaining(["entity_zhang", "entity_hz"]));
    expect(ids).not.toContain("entity_santi");
  });

  it("关闭后再打开：持久化的是开关，不是删除实体", () => {
    insertEntity(db, "entity_zhang", "person", "张三");
    const off = setEntityMask(db, "entity_zhang", false);
    expect(off.maskEnabled).toBe(false);
    expect(entityRow("entity_zhang")!.mask_enabled).toBe(0);

    const on = setEntityMask(db, "entity_zhang", true);
    expect(on.maskEnabled).toBe(true);
    expect(entityRow("entity_zhang")!.mask_enabled).toBe(1);
  });

  it("不在册 / 非语义类型 ⇒ EntityVocabularyError(missing)", () => {
    insertEntity(db, "entity_santi", "work", "三体");
    expect(() => setEntityMask(db, "entity_missing", false)).toThrow(EntityVocabularyError);
    expect(() => setEntityMask(db, "entity_santi", false)).toThrow(EntityVocabularyError);
  });
});

describe("Phase D · L1 只读开启的词", () => {
  it("关闭词表项后 collectKnownEntities 不再返回它，redact 也不再替换", () => {
    insertEntity(db, "entity_zhang", "person", "张三");
    insertEntity(db, "entity_hz", "place", "杭州");

    const before = collectKnownEntities(db).map((entity) => entity.entityId);
    expect(before).toEqual(expect.arrayContaining(["entity_zhang", "entity_hz"]));

    setEntityMask(db, "entity_zhang", false);
    const after = collectKnownEntities(db).map((entity) => entity.entityId);
    expect(after).not.toContain("entity_zhang");

    const { redactedText, map } = redact(RAW, collectKnownEntities(db), { nonce: "d1e2f3" });
    expect(redactedText).toContain("张三");
    expect(redactedText).not.toContain("杭州");
    expect(map.spans.every((span) => span.entityId !== "entity_zhang")).toBe(true);
  });

  it("预览 span 带 entityId：词表来源指向实体，规则来源为 null", () => {
    insertEntity(db, "entity_zhang", "person", "张三");
    const grants = new GrantService(db, { now: () => new Date(NOW) });
    const preview = grants.preparePreview(revisionId, { nonce: "a1b2c3" });

    const person = preview.spans.find((span) => span.source === "entity_memory");
    expect(person).toMatchObject({ entityId: "entity_zhang", kind: "person" });
    const ruleSpans = preview.spans.filter((span) => span.source === "rule");
    expect(ruleSpans.length).toBeGreaterThan(0);
    expect(ruleSpans.every((span) => span.entityId === null)).toBe(true);
  });
});

describe("Phase D · 开关变化清预览缓存", () => {
  it("六枚缓存键被清掉，旧载荷不会带着旧词表继续发", () => {
    insertEntity(db, "entity_zhang", "person", "张三");
    const keys = [
      `preview_v2_nonce:${revisionId}`,
      `preview_v2_payload:${revisionId}`,
      `preview_llm_v2_nonce:${revisionId}`,
      `preview_llm_v2_payload:${revisionId}`,
      `preview_llm_v2_spans:${revisionId}`,
      `preview_llm_v2_failed:${revisionId}`,
    ];
    for (const key of keys) {
      db.prepare("insert into app_meta (key, value, updated_at) values (?, 'x', ?)").run(key, NOW);
    }

    setEntityMask(db, "entity_zhang", false);

    for (const key of keys) {
      expect(
        db.prepare("select count(*) as n from app_meta where key = ?").get(key),
      ).toEqual({ n: 0 });
    }
  });

  it("值没变就不清缓存（重复保存同一开关不制造空洞）", () => {
    insertEntity(db, "entity_zhang", "person", "张三");
    const key = `preview_v2_payload:${revisionId}`;
    db.prepare("insert into app_meta (key, value, updated_at) values (?, 'x', ?)").run(key, NOW);

    setEntityMask(db, "entity_zhang", true);

    expect(db.prepare("select count(*) as n from app_meta where key = ?").get(key)).toEqual({ n: 1 });
  });
});

/* ══════════════════════════════════════════════════════════════════
 * HTTP：/api/entities/vocabulary 与 /api/entities/:id/mask
 * ══════════════════════════════════════════════════════════════════ */

interface Instance {
  readonly booted: BootResult;
  readonly box: Sandbox;
  readonly base: string;
}

const instances: Instance[] = [];

function testPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    import("node:net").then(({ createServer }) => {
      const probe = createServer();
      probe.on("error", reject);
      probe.listen(0, "127.0.0.1", () => {
        const address = probe.address();
        if (address === null || typeof address === "string") {
          reject(new Error("无法取得空闲端口"));
          return;
        }
        const port = address.port;
        probe.close(() => resolve(port));
      });
    }, reject);
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
  const box = makeSandbox("tb-phaseD-vocab-routes-");
  writePort(box.layout, port);
  const booted = await boot({
    env: { TB_DATA_DIR: box.root, USERPROFILE: box.root, HOME: box.root },
    log: () => {},
    startJobsWorker: false,
    ingestProvider: {
      adapter: makeAdapter(),
      transport: stubTransport(OK_ENVELOPE(validOutput())).transport,
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

describe("Phase D · 路由", () => {
  it("GET /api/entities/vocabulary 只回语义三类，形状对齐 DTO", async () => {
    const inst = await startInstance();
    insertEntity(inst.booted.db, "entity_zhang", "person", "张三");
    insertEntity(inst.booted.db, "entity_santi", "work", "三体");

    const res = await call(inst, "GET", "/api/entities/vocabulary");

    expect(res.status).toBe(200);
    expect(res.json.entities.map((row: { entityId: string }) => row.entityId)).toEqual([
      "entity_zhang",
    ]);
    expect(Object.keys(res.json.entities[0]).sort()).toEqual(
      [
        "canonicalName",
        "displayName",
        "entityId",
        "entityType",
        "lifecycleStatus",
        "maskEnabled",
        "originType",
        "terms",
      ].sort(),
    );
  });

  it("PATCH mask 关闭后读回 false，GET 同步", async () => {
    const inst = await startInstance();
    insertEntity(inst.booted.db, "entity_zhang", "person", "张三");

    const patched = await call(inst, "PATCH", "/api/entities/entity_zhang/mask", {
      maskEnabled: false,
    });
    expect(patched.status).toBe(200);
    expect(patched.json.maskEnabled).toBe(false);

    const listed = await call(inst, "GET", "/api/entities/vocabulary");
    expect(listed.json.entities[0].maskEnabled).toBe(false);
  });

  it("未知实体 404、body 不合法 400、非法 JSON 400", async () => {
    const inst = await startInstance();

    const missing = await call(inst, "PATCH", "/api/entities/entity_missing/mask", {
      maskEnabled: false,
    });
    expect(missing.status).toBe(404);
    expect(missing.json.error).toBe("not_found");

    const bad = await call(inst, "PATCH", "/api/entities/entity_missing/mask", { maskEnabled: "no" });
    expect(bad.status).toBe(400);
    expect(bad.json.error).toBe("invalid_request");

    const res = await fetch(`${inst.base}/api/entities/entity_missing/mask`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_json");
  });
});

describe("Phase D · 前端入口", () => {
  it("设置页有词表管理，预览弹窗的词表来源有「这个词不脱敏」", () => {
    const settings = sourceAt("src/web/SettingsPanel.tsx");
    expect(settings).toContain("词表管理");
    expect(settings).toContain("entityVocabulary");
    expect(settings).toContain("entitySetMask");

    const dialog = sourceAt("src/web/ui/SendReviewDialog.tsx");
    expect(dialog).toContain("这个词不脱敏");
    expect(dialog).toContain("onDisableEntity");

    const pending = sourceAt("src/web/IngestPanel.tsx");
    expect(pending).toContain("api.entitySetMask(entityId, false)");
    expect(pending).toContain("loadPreview(selected.recordId)");
  });
});
