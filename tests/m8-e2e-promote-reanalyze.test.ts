/**
 * M8 端到端验收（准则 §五）：把 M7 的关系写入面与 M8 的两个动作串成真实用户走的那条路。
 *
 * 三个场景各要证的那一件事：
 *  - **E1** 完整闭环：写下记录 → 确认候选（落成 provisional）→ 首次分析（关系被丢弃）
 *    → 转正 → 重新分析 → 关系**真的进 `graph_edge`** → 采纳 → 边在 `current` 名下可读。
 *    这一条是 M8 的存在理由：M7 把写边的能力做完了，但在真实使用中一次都走不到。
 *  - **E2** 闭环不靠重新分析：先转正、再写新记录 ⇒ **首次**分析就落边。
 *  - **E3** 反面：不转正直接重新分析 ⇒ 关系照旧被丢弃，采纳也救不回来。
 *    「转正」不是可以省掉的前置，它是关系端点的硬要求（M7-D-2 / R3）。
 *
 * 与既有两份文件的分工（不重复造）：
 *  - `m8-1-entity-promote` 钉转正这一跳本身的字段边界与路由四形态；
 *  - `m8-2-reanalysis` 钉尝试序号、在途拒绝、授权闸门、采纳语义，以及记录详情那个按钮的接线；
 *  - 本文件钉的是**串起来走得通**：provisional 实体只经 `entityConfirm` 那唯一一条路产生，
 *    边上读的是 `GraphStore` 的在册读面，模型调用全程由注入的假 transport 驱动并计数。
 *
 * 真库真 migrator（`TB_DATA_DIR` 沙箱），注入时钟固定为夹具时刻。
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { migrate } from "../src/server/db/migrator.ts";
import { seedVocabulary } from "../src/server/db/seed.ts";
import { GraphStore } from "../src/server/graph/store.ts";
import { createProvisionalEntity } from "./helpers/entityFixtures.ts";
import { promoteEntity } from "../src/server/entities/promote.ts";
import {
  IngestService,
  deriveIdempotencyKey,
} from "../src/server/ingest/ingestService.ts";
import type { ExtractedLabel, ExtractedRelation, StructuredOutput } from "../src/server/ingest/contract.ts";
import type { StubTransport } from "./helpers/ingestFixtures.ts";
import {
  FIXTURE_NOW,
  OK_ENVELOPE,
  SYSTEM_PROMPT,
  createRecord,
  makeAdapter,
  stubTransport,
} from "./helpers/ingestFixtures.ts";
import { countRows, makeSandbox, openSandboxDb, type Sandbox } from "./helpers/sandbox.ts";
import type { Database } from "../src/server/db/adapter.ts";

/** 全文只有一条管线：换了管线就换了指纹，`_a2` 那个后缀的意义也就不存在了。 */
const PIPELINE = "test-m8-e2e-promote-reanalyze";
/** 三轮 ingest 共用夹具时钟：本文件不判「旧行有没有被续期」，那已由 m7-3 钉死。 */
const CLOCK = new Date(FIXTURE_NOW);

/** 那条承诺了同事关系的原文，与它的证据切片（坐标按 §3.5 是**原文**坐标）。 */
const RAW = "张三是我的同事，我们一道改了发布计划";
const EV = "张三是我的同事";
const EV_START = RAW.indexOf(EV);
const EV_END = EV_START + EV.length;

let sandbox: Sandbox;
let db: Database;

beforeEach(() => {
  sandbox = makeSandbox("tb-m8-e2e-");
  db = openSandboxDb(sandbox.layout);
  migrate(db);
  seedVocabulary(db);
});

afterEach(() => {
  db.close();
  sandbox.cleanup();
});

// ── 夹具：用户的那几下动作 ────────────────────────────────────────

/** 用户写下那条记录（整理方式 = 本机模型：不外发、不涉授权）。 */
function writeRecord(): { recordId: string; revisionId: string } {
  return createRecord(db, RAW, "local_model");
}

/**
 * 用户在预览里点头确认两个词 ⇒ 落成 provisional。产品侧的确认入口已随启发式删除，
 * 这里用夹具直接写同形行（字段与旧 `entityConfirm` 逐字同形）。
 */
function confirmTerms(): { meId: string; zhangId: string } {
  const meId = createProvisionalEntity(db, "我", "person", CLOCK.toISOString());
  const zhangId = createProvisionalEntity(db, "张三", "person", CLOCK.toISOString());
  return { meId, zhangId };
}

function makeService(stub: StubTransport): IngestService {
  return new IngestService({
    db,
    adapter: makeAdapter(),
    transport: stub.transport,
    systemPrompt: SYSTEM_PROMPT,
    now: () => CLOCK,
    promptVersion: PIPELINE,
  });
}

function label(labelSaid: string): ExtractedLabel {
  return { labelSaid, candidateConceptId: null, basis: "explicit", evidence: EV };
}

function relation(): ExtractedRelation {
  return { relationType: "colleague_of", srcLabel: "我", dstLabel: "张三", evidence: EV };
}

/** 回稿：两端各一个实体标签 + 一条同事关系，其余产出留空。 */
function output(): StructuredOutput {
  return {
    title: "一次闭环的回稿",
    summary: "张三与我是同事",
    episodes: [],
    thoughts: [],
    emotions: [],
    topics: [],
    entities: [label("我"), label("张三")],
    relations: [relation()],
  };
}

interface EdgeRow {
  id: string;
  relation_type: string;
  src_kind: string;
  dst_kind: string;
  src_id: string;
  dst_id: string;
  lifecycle_status: string;
  created_by: string;
  origin_parse_run_id: string | null;
  evidence_reason: string | null;
}

function allEdges(): EdgeRow[] {
  return db
    .prepare(
      `select id, relation_type, src_kind, dst_kind, src_id, dst_id, lifecycle_status, created_by,
              origin_parse_run_id, evidence_reason
         from graph_edge order by relation_type, src_id, dst_id`,
    )
    .all() as unknown as EdgeRow[];
}

function store(): GraphStore {
  return new GraphStore(db, { now: () => CLOCK });
}

function lifecycleOf(entityId: string): string {
  return (db.prepare(`select lifecycle_status as s from entity where id = ?`).get(entityId) as {
    s: string;
  }).s;
}

/** §3.5 钉死的证据串形状，在测试侧再写一遍（与 m7-3 同一份构造）：实现改形状要在这里一起红。 */
function reasonOf(runId: string, revisionId: string, start: number, end: number, evidence: string): string {
  return `parse_run:${runId} rev:${revisionId} span:${start}-${end} evidence=${evidence.slice(0, 200)}`;
}

// ── E1：完整闭环 ──────────────────────────────────────────────────

describe("M8 E2E E1 确认→分析→转正→重新分析→采纳：关系真的落进图谱", () => {
  it("首跳丢关系、转正不建边、重新分析写出边、采纳后 current 名下可读", async () => {
    const { revisionId } = writeRecord();
    const { meId, zhangId } = confirmTerms();
    const stub = stubTransport(OK_ENVELOPE(output()));
    const service = makeService(stub);

    // 第一跳：首次分析。关系过了事实门，但两端还是待转正 ⇒ 一条边都不落（M7-D-2 / R3）。
    const first = await service.ingest({ recordRevisionId: revisionId });
    expect(first.succeeded).toBe(true);
    expect(first.replayed).toBe(false);
    expect(first.writes.relations).toBe(0);
    expect(first.writes.relationProvisional).toBe(1);
    expect(countRows(db, "graph_edge")).toBe(0);
    expect(lifecycleOf(zhangId)).toBe("provisional");
    expect(stub.callCount()).toBe(1);

    // 第二跳：用户把两端都转正。关系端点要求 Entity:active，两端都在闸门之内。
    expect(promoteEntity(db, meId).promoted).toBe(true);
    const promoted = promoteEntity(db, zhangId);
    expect(promoted.promoted).toBe(true);
    expect(promoted.entity.lifecycle_status).toBe("active");
    expect(lifecycleOf(zhangId)).toBe("active");
    // 转正自己不写任何边、也不多调一次模型（M8-D-1；`m8-1` 的 P5 在闭环里再对一次账）。
    expect(countRows(db, "graph_edge")).toBe(0);
    expect(stub.callCount()).toBe(1);

    // 第三跳：用户点「重新分析」。同一条管线再开一单，产出仍是候选。
    const again = await service.ingest({ recordRevisionId: revisionId, reanalysis: true });
    expect(again.succeeded).toBe(true);
    expect(again.replayed).toBe(false);
    expect(again.runId).not.toBe(first.runId);
    expect(again.pipelineFingerprint).toBe(first.pipelineFingerprint);
    expect(again.idempotencyKey).toBe(
      `${deriveIdempotencyKey(revisionId, again.pipelineFingerprint)}_a2`,
    );
    expect(again.writes.relations).toBe(1);
    expect(again.writes.relationProvisional).toBe(0);
    expect(stub.callCount()).toBe(2);

    // 落库的那一条边：来源指针指向**新** run，证据串形状与 M7-3 逐字同形。
    const edges = allEdges();
    expect(edges).toHaveLength(1);
    const edge = edges[0]!;
    expect(edge.relation_type).toBe("colleague_of");
    expect(edge.src_kind).toBe("entity");
    expect(edge.dst_kind).toBe("entity");
    expect([edge.src_id, edge.dst_id].sort()).toEqual([meId, zhangId].sort());
    expect(edge.lifecycle_status).toBe("active");
    expect(edge.created_by).toBe("ai_generated");
    expect(edge.origin_parse_run_id).toBe(again.runId);
    expect(edge.evidence_reason).toBe(reasonOf(again.runId, revisionId, EV_START, EV_END, EV));

    // 第四跳：采纳 ⇒ 这一份成为现行结果，图谱读面按 current run 取得到那条边。
    const adopted = service.adoptCurrent({ candidateRunId: again.runId });
    expect(adopted.adoptedRunId).toBe(again.runId);
    expect(adopted.supersededRunId).toBeNull();
    expect(service.readRun(again.runId)?.result_state).toBe("current");
    expect(service.currentView(revisionId).currentRunId).toBe(again.runId);
    expect(store().edgesOfRun(again.runId)).toHaveLength(1);
    // 无向边从任一端点都读得到同一行 —— 后续图谱 UI 聚焦哪一头都不影响这一跳。
    expect(store().edgesOfEntity(zhangId).map((row) => row.id)).toEqual([edge.id]);
    expect(store().edgesOfEntity(meId).map((row) => row.id)).toEqual([edge.id]);
  });
});

// ── E2：不必重跑的情形 ────────────────────────────────────────────

describe("M8 E2E E2 先转正、再写新记录：首次分析就落边", () => {
  it("闭环不只靠重新分析：待转正实体一旦在册为 active，第一单就把关系写进去", async () => {
    const { meId, zhangId } = confirmTerms();
    promoteEntity(db, meId);
    promoteEntity(db, zhangId);

    // 之后才写下这条新记录：关系两端在解析开始之前就已经是 `Entity:active`。
    const { revisionId } = writeRecord();
    const stub = stubTransport(OK_ENVELOPE(output()));
    const service = makeService(stub);

    const first = await service.ingest({ recordRevisionId: revisionId });

    expect(first.succeeded).toBe(true);
    expect(first.writes.relations).toBe(1);
    expect(first.writes.relationProvisional).toBe(0);
    expect(stub.callCount()).toBe(1);
    // 一次调用、一单 run：这里没有「重跑」可言。
    expect(countRows(db, "parse_run")).toBe(1);

    const edges = allEdges();
    expect(edges).toHaveLength(1);
    expect(edges[0]!.created_by).toBe("ai_generated");
    expect(edges[0]!.origin_parse_run_id).toBe(first.runId);
    expect(edges[0]!.evidence_reason).toBe(reasonOf(first.runId, revisionId, EV_START, EV_END, EV));
  });
});

// ── E3：反面 ──────────────────────────────────────────────────────

describe("M8 E2E E3 不转正直接重新分析：关系照旧被丢弃", () => {
  it("重新分析换来的是第二次丢弃，不是第二次机会——转正不是可省的前置", async () => {
    const record = writeRecord();
    const { zhangId } = confirmTerms();
    const stub = stubTransport(OK_ENVELOPE(output()));
    const service = makeService(stub);

    const first = await service.ingest({ recordRevisionId: record.revisionId });
    expect(first.writes.relationProvisional).toBe(1);
    expect(countRows(db, "graph_edge")).toBe(0);

    const again = await service.ingest({ recordRevisionId: record.revisionId, reanalysis: true });

    expect(again.succeeded).toBe(true);
    expect(again.runId).not.toBe(first.runId);
    expect(again.writes.relations).toBe(0);
    // 「计数 +1」记的是这一单也没落库：丢弃数按 run 计，两单各一次。
    expect(again.writes.relationProvisional).toBe(1);
    expect(stub.callCount()).toBe(2);
    expect(countRows(db, "graph_edge")).toBe(0);
    expect(lifecycleOf(zhangId)).toBe("provisional");

    // 采纳这一份也救不回来：被丢掉的不是「可见性」，是那条关系本身。
    service.adoptCurrent({ candidateRunId: again.runId });
    expect(service.currentView(record.revisionId).currentRunId).toBe(again.runId);
    expect(store().edgesOfEntity(zhangId)).toEqual([]);
    expect(countRows(db, "graph_edge")).toBe(0);
  });

  it("反面成立之后补一记对照：把转正补上再重新分析，同一份回稿就落边", async () => {
    const record = writeRecord();
    const { meId, zhangId } = confirmTerms();
    const stub = stubTransport(OK_ENVELOPE(output()));
    const service = makeService(stub);

    await service.ingest({ recordRevisionId: record.revisionId });
    const dropped = await service.ingest({ recordRevisionId: record.revisionId, reanalysis: true });
    expect(dropped.writes.relationProvisional).toBe(1);
    expect(countRows(db, "graph_edge")).toBe(0);

    promoteEntity(db, meId);
    promoteEntity(db, zhangId);
    const landed = await service.ingest({ recordRevisionId: record.revisionId, reanalysis: true });

    expect(landed.writes.relations).toBe(1);
    expect(allEdges()[0]!.origin_parse_run_id).toBe(landed.runId);
    expect(stub.callCount()).toBe(3);
  });
});
