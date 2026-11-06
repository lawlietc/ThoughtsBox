/**
 * M8-1 实体转正：服务 + 路由 + 前端动作。
 *
 * 钉的是「用户手动把待转正实体转正」这一跳的六件事（任务书 §3.2）：
 *  - **P1** provisional → active 只改那一列，其余六列逐字段未变；
 *  - **P2** 幂等：对 active 再转正不抛、行不变；
 *  - **P3** archived 拒绝（恢复是另一个动作，本轮不做）；
 *  - **P4** 不存在的 id ⇒ `missing`，且 relation 面一行未增；
 *  - **P5** 转正**不建边、不调 provider**（防「转正=关系自动出现」的误解）；
 *  - **P6** 路由四形态 200/404/409/400，非法 body 不落库；
 *  - **P7** UI：待转正行有转正动作、已转正行没有；点了之后读回来是 active。
 *
 * 时钟纪律：P1/P2/P3 都拿「转正前的整行快照」逐字段对比，`created_at_utc` 由夹具固定，
 * 因此「别的列没动」是可证伪的而不是恒真。
 *
 * P5/P6/P7 走真实 HTTP + `TB_DATA_DIR` 沙箱真库真 migrator（与 `m6-0e-job-routes` 同一套起法），
 * Provider 用注入的假 transport 并计数——转正一次都不该碰到它。
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
import {
  EntityPromoteError,
  promoteEntity,
  type EntityRow,
} from "../src/server/entities/promote.ts";
import { newId } from "../src/shared/contracts/ids.ts";
import { readableResult } from "../src/web/projections.ts";
import type { EffectiveResultDto } from "../src/shared/dto.ts";
import type { Database } from "../src/server/db/adapter.ts";
import {
  FIXTURE_NOW,
  LOCAL_RAW,
  OK_ENVELOPE,
  SYSTEM_PROMPT,
  makeAdapter,
  stubTransport,
  validOutput,
} from "./helpers/ingestFixtures.ts";
import { countRows, makeSandbox, openSandboxDb, type Sandbox } from "./helpers/sandbox.ts";
import { createProvisionalEntity } from "./helpers/entityFixtures.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const sourceAt = (relative: string): string =>
  readFileSync(join(ROOT, relative), "utf8").replace(/\r\n/g, "\n");

/** 转正不许碰的六列 + 主键：快照按这八列取，`toEqual` 因此是逐字段的。 */
const ENTITY_COLUMNS =
  "id, entity_type, canonical_name, display_name, lifecycle_status, privacy_level, origin_type, created_at_utc";

/** 夹具时钟：写死而不是 `new Date()`，好让「这一列没变」不等于「两列恰好都是 now」。 */
const CREATED_AT = "2026-10-28T01:00:00.000Z";

/* ══════════════════════════════════════════════════════════════════
 * 服务层夹具（P1–P4）：沙箱真库 + 真 migrator，直接插 entity 行
 * ══════════════════════════════════════════════════════════════════ */

let serviceSandbox: Sandbox | null = null;
let serviceDb: Database | null = null;

/**
 * 服务层用例各要一份干净的沙箱库；HTTP 那一组不碰它，就一份都不建。
 * 建过的那一份在 `afterEach` 里先关句柄再删目录——Windows 上不关就删不掉。
 */
function serviceDbOf(): Database {
  if (serviceDb === null) {
    serviceSandbox = makeSandbox("tb-m8-1-service-");
    serviceDb = openSandboxDb(serviceSandbox.layout);
    migrate(serviceDb);
    seedVocabulary(serviceDb);
  }
  return serviceDb;
}

afterEach(() => {
  serviceDb?.close();
  serviceDb = null;
  serviceSandbox?.cleanup();
  serviceSandbox = null;
});

/** 按 `entityConfirm` 的字面列集插一行（词面 = 用户原词逐字，三处同词）。 */
function insertEntity(handle: Database, lifecycleStatus: string, term = "张三"): string {
  const id = newId("entity");
  handle
    .prepare(
      `insert into entity (${ENTITY_COLUMNS})
       values (?, 'person', ?, ?, ?, 'normal', 'user_created', ?)`,
    )
    .run(id, term, term, lifecycleStatus, CREATED_AT);
  return id;
}

function snapshot(handle: Database, id: string): EntityRow | undefined {
  return handle.prepare(`select ${ENTITY_COLUMNS} from entity where id = ?`).get(id) as
    | EntityRow
    | undefined;
}

/* ── P1 provisional → active：只改那一列 ─────────────────────────── */

describe("M8-1 P1 转正把 provisional 改成 active，其余六列逐字段未动", () => {
  it("返回 promoted:true，库里读回 active", () => {
    const db = serviceDbOf();
    const id = insertEntity(db, "provisional");
    const before = snapshot(db, id);

    const result = promoteEntity(db, id);

    expect(result.promoted).toBe(true);
    expect(result.entity.lifecycle_status).toBe("active");
    expect(snapshot(db, id)?.lifecycle_status).toBe("active");
    // 转正的是这条本身，没有另建一条。
    expect(countRows(db, "entity")).toBe(1);
    // 回给的行与库里读回的行是同一份事实。
    expect(result.entity).toEqual(snapshot(db, id));
    expect(before?.lifecycle_status).toBe("provisional");
  });

  it("其余六列（entity_type/canonical_name/display_name/privacy_level/origin_type/created_at_utc）逐字段未变", () => {
    const db = serviceDbOf();
    const id = insertEntity(db, "provisional");
    const before = snapshot(db, id)!;

    promoteEntity(db, id);

    const after = snapshot(db, id)!;
    expect(after).toEqual({ ...before, lifecycle_status: "active" });
    expect(after.entity_type).toBe(before.entity_type);
    expect(after.canonical_name).toBe(before.canonical_name);
    expect(after.display_name).toBe(before.display_name);
    expect(after.privacy_level).toBe(before.privacy_level);
    expect(after.origin_type).toBe(before.origin_type);
    expect(after.created_at_utc).toBe(before.created_at_utc);
  });
});

/* ── P2 幂等 ─────────────────────────────────────────────────────── */

describe("M8-1 P2 对已转正的实体再转正是幂等，不抛、行不变", () => {
  it("第二次 promoted:false，整行与第一次之后逐字段相同", () => {
    const db = serviceDbOf();
    const id = insertEntity(db, "provisional");
    promoteEntity(db, id);
    const afterFirst = snapshot(db, id)!;

    const second = promoteEntity(db, id);

    expect(second.promoted).toBe(false);
    expect(second.entity).toEqual(afterFirst);
    expect(snapshot(db, id)).toEqual(afterFirst);
    expect(countRows(db, "entity")).toBe(1);
  });

  it("第三次仍然 false——幂等不是只兜住第二次", () => {
    const db = serviceDbOf();
    const id = insertEntity(db, "provisional");
    promoteEntity(db, id);
    promoteEntity(db, id);
    const afterSecond = snapshot(db, id)!;

    expect(promoteEntity(db, id).promoted).toBe(false);
    expect(snapshot(db, id)).toEqual(afterSecond);
  });
});

/* ── P3 archived 拒绝 ───────────────────────────────────────────── */

describe("M8-1 P3 已归档的实体拒绝转正（恢复是另一个动作）", () => {
  it("抛 kind:'archived'，行一个字没变", () => {
    const db = serviceDbOf();
    const id = insertEntity(db, "archived");
    const before = snapshot(db, id)!;

    let caught: unknown = null;
    try {
      promoteEntity(db, id);
    } catch (cause) {
      caught = cause;
    }

    expect(caught).toBeInstanceOf(EntityPromoteError);
    expect((caught as EntityPromoteError).kind).toBe("archived");
    expect(snapshot(db, id)).toEqual(before);
    expect(countRows(db, "graph_edge")).toBe(0);
  });
});

/* ── P4 不存在 ──────────────────────────────────────────────────── */

describe("M8-1 P4 不存在的 id 抛 kind:'missing'，关系面一行未增", () => {
  it("抛 missing；graph_edge 计数前后都是 0", () => {
    const db = serviceDbOf();
    const id = insertEntity(db, "provisional");
    const edgesBefore = countRows(db, "graph_edge");

    let caught: unknown = null;
    try {
      promoteEntity(db, `entity_不存在_${id}`);
    } catch (cause) {
      caught = cause;
    }

    expect(caught).toBeInstanceOf(EntityPromoteError);
    expect((caught as EntityPromoteError).kind).toBe("missing");
    expect(countRows(db, "graph_edge")).toBe(edgesBefore);
    expect(countRows(db, "graph_edge")).toBe(0);
    // 失败的这一次同样没把那条在册的 provisional 改掉。
    expect(snapshot(db, id)?.lifecycle_status).toBe("provisional");
  });
});

/* ══════════════════════════════════════════════════════════════════
 * HTTP 面（P5–P7）：真实起服务 + 沙箱库，Provider 用计数假 transport
 * ══════════════════════════════════════════════════════════════════ */

interface Instance {
  readonly booted: BootResult;
  readonly box: Sandbox;
  readonly base: string;
  readonly transport: ReturnType<typeof stubTransport>;
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

async function startInstance(): Promise<Instance> {
  const port = await testPort();
  const box = makeSandbox("tb-m8-1-routes-");
  writePort(box.layout, port);
  const transport = stubTransport(OK_ENVELOPE(validOutput()));
  const booted = await boot({
    env: { TB_DATA_DIR: box.root, USERPROFILE: box.root, HOME: box.root },
    log: () => {},
    // 本文件看的是转正这一跳，队列跑起来只会让「provider 被调了几次」这件事多一个来源。
    startJobsWorker: false,
    ingestProvider: {
      adapter: makeAdapter(),
      transport: transport.transport,
      systemPrompt: SYSTEM_PROMPT,
      now: () => new Date(FIXTURE_NOW),
    },
  });
  const inst: Instance = {
    booted,
    box,
    base: `http://127.0.0.1:${port}`,
    transport,
  };
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

/** 真实用户那一步：确认采纳候选词 ⇒ 落成 provisional 实体（确认入口已删，测试直接写同形行）。 */
async function confirmEntity(inst: Instance, term: string, kind = "person"): Promise<string> {
  return createProvisionalEntity(inst.booted.db, term, kind);
}

/** 在册行的八列快照（经服务层同一个库读，不经任何本文件自造的缓存）。 */
function rowOf(inst: Instance, entityId: string): EntityRow | undefined {
  return inst.booted.db
    .prepare(`select ${ENTITY_COLUMNS} from entity where id = ?`)
    .get(entityId) as EntityRow | undefined;
}

/* ── P5 转正不建边、不调 provider ───────────────────────────────── */

describe("M8-1 P5 转正不建边、不调 provider（M8-D-1）", () => {
  it("转正前后 graph_edge 计数相等，provider 调用数一次都没增加", async () => {
    const inst = await startInstance();
    const entityId = await confirmEntity(inst, "张三");
    const edgesBefore = countRows(inst.booted.db, "graph_edge");
    const providerCallsBefore = inst.transport.callCount();

    const promoted = await call(inst, "POST", "/api/entities/promote", { entityId });

    expect(promoted.status).toBe(200);
    expect(promoted.json.promoted).toBe(true);
    expect(countRows(inst.booted.db, "graph_edge")).toBe(edgesBefore);
    expect(inst.transport.callCount()).toBe(providerCallsBefore);
    expect(inst.transport.callCount()).toBe(0);
  });

  it("别名表也没动：转正不建别名", async () => {
    const inst = await startInstance();
    const entityId = await confirmEntity(inst, "张三");
    const aliasesBefore = (
      inst.booted.db
        .prepare(`select count(*) as n from entity_alias where entity_id = ?`)
        .get(entityId) as { n: number }
    ).n;

    await call(inst, "POST", "/api/entities/promote", { entityId });

    const aliasesAfter = (
      inst.booted.db.prepare(`select count(*) as n from entity_alias where entity_id = ?`).get(entityId) as {
        n: number;
      }
    ).n;
    expect(aliasesAfter).toBe(aliasesBefore);
  });
});

/* ── P6 路由四形态 ──────────────────────────────────────────────── */

describe("M8-1 P6 路由：200/404/409/400", () => {
  it("200 ⇒ { promoted, entity: { id, entityType, displayName, lifecycleStatus } }", async () => {
    const inst = await startInstance();
    const entityId = await confirmEntity(inst, "张三");

    const promoted = await call(inst, "POST", "/api/entities/promote", { entityId });

    expect(promoted.status).toBe(200);
    expect(promoted.json.promoted).toBe(true);
    expect(Object.keys(promoted.json.entity).sort()).toEqual([
      "displayName",
      "entityType",
      "id",
      "lifecycleStatus",
    ]);
    expect(promoted.json.entity).toEqual({
      id: entityId,
      entityType: "person",
      displayName: "张三",
      lifecycleStatus: "active",
    });
  });

  it("幂等再点一次仍是 200，只是 promoted:false（不是冲突）", async () => {
    const inst = await startInstance();
    const entityId = await confirmEntity(inst, "张三");
    await call(inst, "POST", "/api/entities/promote", { entityId });

    const again = await call(inst, "POST", "/api/entities/promote", { entityId });

    expect(again.status).toBe(200);
    expect(again.json.promoted).toBe(false);
    expect(again.json.entity.lifecycleStatus).toBe("active");
  });

  it("404 ⇒ 实体不存在", async () => {
    const inst = await startInstance();

    const missing = await call(inst, "POST", "/api/entities/promote", { entityId: "entity_0000000000" });

    expect(missing.status).toBe(404);
    expect(missing.json.error).toBe("not_found");
  });

  it("409 ⇒ 已归档", async () => {
    const inst = await startInstance();
    const entityId = await confirmEntity(inst, "张三");
    inst.booted.db
      .prepare(`update entity set lifecycle_status = 'archived' where id = ?`)
      .run(entityId);

    const archived = await call(inst, "POST", "/api/entities/promote", { entityId });

    expect(archived.status).toBe(409);
    expect(archived.json.error).toBe("state_conflict");
    expect(rowOf(inst, entityId)?.lifecycle_status).toBe("archived");
  });

  it("400 三形态（缺字段 / 空串 / 多键）都不落库", async () => {
    const inst = await startInstance();
    const entityId = await confirmEntity(inst, "张三");
    const before = rowOf(inst, entityId);
    const entitiesBefore = countRows(inst.booted.db, "entity");

    const noField = await call(inst, "POST", "/api/entities/promote", {});
    const emptyId = await call(inst, "POST", "/api/entities/promote", { entityId: "" });
    const extraKey = await call(inst, "POST", "/api/entities/promote", { entityId, recordId: "rec_x" });
    const wrongType = await call(inst, "POST", "/api/entities/promote", { entityId: 123 });

    for (const bad of [noField, emptyId, extraKey, wrongType]) {
      expect(bad.status).toBe(400);
      expect(bad.json.error).toBe("invalid_request");
    }
    expect(rowOf(inst, entityId)).toEqual(before);
    expect(countRows(inst.booted.db, "entity")).toBe(entitiesBefore);
  });

  it("坏 JSON 体 ⇒ 400 invalid_json，不落库", async () => {
    const inst = await startInstance();
    const entityId = await confirmEntity(inst, "张三");
    const before = rowOf(inst, entityId);

    const res = await fetch(`${inst.base}/api/entities/promote`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{坏json",
    });

    expect(res.status).toBe(400);
    expect(rowOf(inst, entityId)).toEqual(before);
  });
});

/* ── P7 UI ──────────────────────────────────────────────────────── */

/** 从真实 op9 回包里取出「人物与事物」那一组的行。 */
function entityLines(effective: EffectiveResultDto) {
  return readableResult(effective).find((group) => group.category === "人物与事物")?.lines ?? [];
}

describe("M8-1 P7 UI：待转正行有转正动作、已转正行没有", () => {
  it("投影层带出判定所需的只读事实（转正的实体 id + 生命周期），已转正行同样带", async () => {
    const inst = await startInstance();
    const entityId = await confirmEntity(inst, "项目组", "organization");
    // 真跑一次解析，让「项目组」这个提及进 op9 的有效结果（不伪造 DTO）。
    const record = await call(inst, "POST", "/api/records", { text: LOCAL_RAW, processing_mode: "local_model" });
    const parsed = await call(inst, "POST", "/api/ingest/parse", { recordId: record.json.record.id });
    expect(parsed.status).toBe(200);
    if (parsed.json.autoAdopted !== true) {
      const adopted = await call(inst, "POST", "/api/ingest/adopt", {
        candidateRunId: parsed.json.runId,
      });
      expect(adopted.status).toBe(200);
    }

    const first = await call(inst, "GET", `/api/ingest/effective/${record.json.revision.id}`);
    expect(first.status).toBe(200);
    const provisionalLines = entityLines(first.json);
    expect(provisionalLines.length).toBeGreaterThan(0);
    const target = provisionalLines.find((line) => line.entity?.id === entityId);
    expect(target?.entity?.lifecycleStatus).toBe("provisional");

    // 点了转正 ⇒ 同一个读面回来的就是 active（动作后该行的按钮判定条件不再成立）
    const promoted = await call(inst, "POST", "/api/entities/promote", { entityId });
    expect(promoted.json.promoted).toBe(true);

    const second = await call(inst, "GET", `/api/ingest/effective/${record.json.revision.id}`);
    const promotedLines = entityLines(second.json);
    const after = promotedLines.find((line) => line.entity?.id === entityId);
    expect(after?.entity?.lifecycleStatus).toBe("active");
    expect(rowOf(inst, entityId)?.lifecycle_status).toBe("active");
    // 转正不改词面与类型：那一行显示的还是同一个名字。
    expect(after?.title).toBe(target?.title);
  });

  it("转正按钮只挂在 provisional 行上（组件层判定，投影里不含动作语义）", () => {
    const projections = sourceAt("src/web/projections.ts");
    const detail = sourceAt("src/web/RecordDetail.tsx");

    // 投影给的是事实，不是动作：没有 promote 这个词、也没有端点串。
    expect(projections).not.toMatch(/promote/i);
    expect(projections).toContain("lifecycleStatus: target.lifecycleStatus");
    // 组件按行判定，且判定条件只有 provisional 一种。
    expect(detail).toMatch(/line\.entity\.lifecycleStatus === "provisional"/);
    expect(detail).not.toMatch(/lifecycleStatus === "(active|archived)"[\s\S]{0,200}转正/);
    expect(detail).toContain("转正");
    expect(detail).toContain("api.entityPromote(");
  });

  it("动作走 apiClient 的同一个调用面，成功后复用既有刷新通道", () => {
    const client = sourceAt("src/web/apiClient.ts");
    const detail = sourceAt("src/web/RecordDetail.tsx");

    expect(client).toContain('jsonCall<EntityPromoteResultDto>("POST", "/api/entities/promote", { entityId })');
    // 就地刷新走的是既有的那条通道（详情 + 整理结果一起重取），没有第四份界面状态。
    expect(detail).toMatch(/promoteEntity[\s\S]{0,600}refreshAfterDecision\(/);
    expect(detail).toContain("props.onChanged()");
  });
});
