/**
 * M7-2b「关系写入路径」专项测试（准则 §3.5，任务口径见工作日志）。
 *
 * M7-2a 钉的是抽取与校验（`contract.ts`，零库）；本文件钉的是**过完门的那几条怎么落库**：
 * `writeRelations()` → `ConceptResolver.resolveEntity` → `GraphStore.insertEdgeIfAbsent`，
 * 全部发生在 `commitDerived` 的同一笔事务里。
 *
 * 分工边界，避免与既有测试重复或留缝：
 *  - `m7-1-graph-contract` 钉库与 store 层自己守得住什么（六类可插、CHECK、UNIQUE、无向归一）；
 *  - `m7-2-relations-extract` 钉门的判据与丢弃清单；
 *  - 本文件只钉**服务层这一笔**：四类丢弃计数各归各处、落库列的形状、重跑不覆盖、失败路径不缺字段。
 *
 * 全程离线：回稿由注入的假 Transport 给出；库一律是 `TB_DATA_DIR` 沙箱里的真库真 migrator。
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { migrate } from "../src/server/db/migrator.ts";
import { seedVocabulary } from "../src/server/db/seed.ts";
import { GraphStore } from "../src/server/graph/store.ts";
import {
  IngestService,
  emptyWrites,
  type IngestResult,
} from "../src/server/ingest/ingestService.ts";
import type {
  ExtractedLabel,
  ExtractedRelation,
  StructuredOutput,
} from "../src/server/ingest/contract.ts";
import { loadContracts } from "../src/shared/contracts/load.ts";
import { aiCreatableGraphEdgeRelationTypes } from "../src/shared/contracts/enums.ts";
import {
  FIXTURE_NOW,
  HTTP_ERROR,
  OK_ENVELOPE,
  SYSTEM_PROMPT,
  createRecord,
  makeAdapter,
  stubTransport,
} from "./helpers/ingestFixtures.ts";
import { makeSandbox, openSandboxDb, type Sandbox } from "./helpers/sandbox.ts";
import type { Database } from "../src/server/db/adapter.ts";

/**
 * 两次 run 必须落在**不同管线**上才是新任务（同 revision 同指纹 = 重放，走不到写入面）。
 * 用合成串而不是真实版本号：`DEFAULT_PROMPT_VERSION` 一升到该值，这两条就并回同一条管线。
 */
const PIPELINE_A = "test-prompt-relations-a";
const PIPELINE_B = "test-prompt-relations-b";

/** 本文件用到的实体：`entity_w_me < entity_w_zhang`，无向归一的断言依赖这个字典序。 */
const ENT_ME = "entity_w_me";
const ENT_ZHANG = "entity_w_zhang";
const ENT_LI = "entity_w_li";

/** 一条记录的全部素材：两端词面、一处逐字容得下两者的证据切片，外加一句给 thoughts 用。 */
const RAW = "张三是我的同事，我们一道改了发布计划";
const EV = "张三是我的同事";
const EV_START = RAW.indexOf(EV);
const EV_END = EV_START + EV.length;

let sandbox: Sandbox;
let db: Database;

beforeEach(() => {
  sandbox = makeSandbox("tb-m7-2b-");
  db = openSandboxDb(sandbox.layout);
  migrate(db);
  seedVocabulary(db);
});

afterEach(() => {
  db.close();
  sandbox.cleanup();
});

// ── 夹具 ────────────────────────────────────────────────────────────

function insertEntity(id: string, lifecycle: string, canonicalName: string): void {
  db.prepare(
    `insert into entity
       (id, entity_type, canonical_name, display_name, lifecycle_status, privacy_level, origin_type, created_at_utc)
     values (?, 'person', ?, ?, ?, 'normal', 'user_created', ?)`,
  ).run(id, canonicalName, canonicalName, lifecycle, FIXTURE_NOW);
}

function insertAlias(entityId: string, alias: string): void {
  db.prepare(`insert into entity_alias (entity_id, alias, created_at_utc) values (?, ?, ?)`).run(
    entityId,
    alias,
    FIXTURE_NOW,
  );
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

/** 全表读回来：每一节都直接数「库里到底有几行边」，而不是信服务层自报的计数。 */
function allEdges(): EdgeRow[] {
  return db
    .prepare(
      `select id, relation_type, src_kind, dst_kind, src_id, dst_id, lifecycle_status, created_by,
              origin_parse_run_id, evidence_reason
         from graph_edge order by relation_type, src_id, dst_id`,
    )
    .all() as unknown as EdgeRow[];
}

function lifecycleOf(entityId: string): string {
  const row = db.prepare(`select lifecycle_status as s from entity where id = ?`).get(entityId) as { s: string };
  return row.s;
}

function label(labelSaid: string, evidence = EV): ExtractedLabel {
  return { labelSaid, candidateConceptId: null, basis: "explicit", evidence };
}

function relation(overrides: Partial<ExtractedRelation> = {}): ExtractedRelation {
  return { relationType: "colleague_of", srcLabel: "我", dstLabel: "张三", evidence: EV, ...overrides };
}

/**
 * 基线回稿：两个实体标签 + 一条同事关系。负例都由它**单点**变异而来。
 * `episodes` 留空是因为本文件不验事件写入，只验边。
 */
function output(overrides: Partial<StructuredOutput> = {}): StructuredOutput {
  return {
    title: "一次关系写入的回稿",
    summary: "张三与我是同事",
    episodes: [],
    thoughts: [],
    emotions: [],
    topics: [],
    entities: [label("我"), label("张三")],
    relations: [relation()],
    ...overrides,
  };
}

function newRecord(text = RAW): { recordId: string; revisionId: string } {
  return createRecord(db, text, "local_model");
}

async function ingest(
  revisionId: string,
  out: StructuredOutput,
  promptVersion = PIPELINE_A,
): Promise<IngestResult> {
  const service = new IngestService({
    db,
    adapter: makeAdapter(),
    transport: stubTransport(OK_ENVELOPE(out)).transport,
    systemPrompt: SYSTEM_PROMPT,
    now: () => new Date(FIXTURE_NOW),
    promptVersion,
  });
  return service.ingest({ recordRevisionId: revisionId });
}

/** §3.5 钉死的证据串形状，在测试侧写一遍：实现改了形状要在这里一起红。 */
function reasonOf(runId: string, revisionId: string, start: number, end: number, evidence: string): string {
  return `parse_run:${runId} rev:${revisionId} span:${start}-${end} evidence=${evidence.slice(0, 200)}`;
}

const SIX_TYPES = aiCreatableGraphEdgeRelationTypes(loadContracts().enums);

// ── 一、合法关系：落库的那一行长什么样 ──────────────────────────────

describe("M7-2b 写入面：合法关系", () => {
  it("两端 active 且在本次 entities 里 ⇒ 写一行，来源与证据按 §3.5 的形状", async () => {
    // 夹具前提：坐标是**原文**坐标，切片读回来就是证据本体。
    expect(RAW.slice(EV_START, EV_END)).toBe(EV);
    insertEntity(ENT_ME, "active", "我");
    insertEntity(ENT_ZHANG, "active", "张三");
    const record = newRecord();

    const result = await ingest(record.revisionId, output());

    expect(result.succeeded).toBe(true);
    expect(result.writes.relations).toBe(1);
    expect([
      result.writes.relationDroppedByContract,
      result.writes.relationAmbiguous,
      result.writes.relationUnmatched,
      result.writes.relationProvisional,
    ]).toEqual([0, 0, 0, 0]);

    const edges = allEdges();
    expect(edges).toHaveLength(1);
    const edge = edges[0]!;
    expect(edge.relation_type).toBe("colleague_of");
    expect(edge.src_kind).toBe("entity");
    expect(edge.dst_kind).toBe("entity");
    expect(edge.lifecycle_status).toBe("active");
    expect(edge.created_by).toBe("ai_generated");
    expect(edge.origin_parse_run_id).toBe(result.runId);
    // R6：方向归一归 store，写入面交出去的仍是原始方向，库里躺着的是字典序那一头。
    expect([edge.src_id, edge.dst_id]).toEqual([ENT_ME, ENT_ZHANG]);
    expect(edge.evidence_reason).toBe(reasonOf(result.runId, record.revisionId, EV_START, EV_END, EV));
  });

  it("六类各一条 ⇒ 六行，全部 ai_generated、全部挂本次 run", async () => {
    expect([...SIX_TYPES].sort()).toEqual(
      ["classmate_of", "colleague_of", "family_of", "partner_of", "reports_to", "friend_of"].sort(),
    );
    insertEntity(ENT_ME, "active", "我");
    insertEntity(ENT_ZHANG, "active", "张三");
    const record = newRecord();

    const result = await ingest(record.revisionId, output({ relations: SIX_TYPES.map((relationType) => relation({ relationType })) }));

    expect(result.succeeded).toBe(true);
    expect(result.writes.relations).toBe(6);
    expect(allEdges().map((edge) => edge.relation_type).sort()).toEqual([...SIX_TYPES].sort());
    expect(allEdges().every((edge) => edge.created_by === "ai_generated" && edge.origin_parse_run_id === result.runId)).toBe(true);
  });

  it("证据原文按 §3.5 截到 200 字，坐标仍是完整区间", async () => {
    insertEntity(ENT_ME, "active", "我");
    insertEntity(ENT_ZHANG, "active", "张三");
    const raw = `${EV}，${"我们一道讨论了发布计划里每一个细节".repeat(12)}`;
    const record = newRecord(raw);
    const longEvidence = raw.slice(0, 210);
    expect(longEvidence.length).toBe(210);
    expect(longEvidence).toContain("我");
    expect(longEvidence).toContain("张三");

    const result = await ingest(record.revisionId, output({ relations: [relation({ evidence: longEvidence })] }));

    expect(result.writes.relations).toBe(1);
    const edge = allEdges()[0]!;
    // 截的是证据文本，**不是**坐标：span 仍是 0-210，事后照旧能回锚到原文。
    expect(edge.evidence_reason).toBe(reasonOf(result.runId, record.revisionId, 0, 210, longEvidence));
    expect(edge.evidence_reason!.length).toBe(
      `parse_run:${result.runId} rev:${record.revisionId} span:0-210 evidence=`.length + 200,
    );
  });
});

// ── 二、四类丢弃，各归各的计数 ──────────────────────────────────────

describe("M7-2b 写入面：丢弃分类计数（§3.5）", () => {
  /** 关系是增量产出：端点解析不出来只作废那一条，其余产出与 run 成败都不该被牵动。 */
  it("端点没有在册实体 ⇒ unmatched +1，run 仍成功、其余产出照写", async () => {
    insertEntity(ENT_ME, "active", "我"); // 库里根本没有「张三」这个实体
    const record = newRecord();

    const result = await ingest(
      record.revisionId,
      output({ thoughts: [{ text: "发布计划要提前定稿", evidence: "我们一道改了发布计划" }] }),
    );

    expect(result.succeeded).toBe(true);
    expect(result.errorKind).toBeNull();
    expect(result.writes.relations).toBe(0);
    expect(result.writes.relationUnmatched).toBe(1);
    expect([result.writes.relationAmbiguous, result.writes.relationProvisional, result.writes.relationDroppedByContract]).toEqual([0, 0, 0]);
    // 这一笔 run 真的提交了别的东西，不是整批不采信。
    expect(result.writes.thoughts).toBe(1);
    expect(allEdges()).toEqual([]);
  });

  it("端点仍是 provisional ⇒ provisional +1，且实体不转正（R3）", async () => {
    insertEntity(ENT_ME, "active", "我");
    insertEntity(ENT_ZHANG, "provisional", "张三");
    const record = newRecord();

    const result = await ingest(record.revisionId, output());

    expect(result.succeeded).toBe(true);
    expect(result.writes.relations).toBe(0);
    expect(result.writes.relationProvisional).toBe(1);
    expect([result.writes.relationAmbiguous, result.writes.relationUnmatched]).toEqual([0, 0]);
    expect(allEdges()).toEqual([]);
    expect(lifecycleOf(ENT_ZHANG)).toBe("provisional");
    // Mention 挂在 provisional 实体上是 §3.1 的合法形态：这一路不因为边被丢而一起丢。
    expect(result.writes.mentions).toBe(2);
  });

  it("端点是在册 active 实体、但词面不属于本条记录的 entities ⇒ 不写并计入 unmatched", async () => {
    insertEntity(ENT_ME, "active", "我");
    insertEntity(ENT_ZHANG, "active", "张三");
    insertEntity(ENT_LI, "active", "李四");
    const record = newRecord("张三是李四的同事，我也在旁边");

    const result = await ingest(
      record.revisionId,
      output({
        entities: [label("我", "我也在旁边"), label("张三", "张三是李四的同事")],
        relations: [relation({ srcLabel: "张三", dstLabel: "李四", evidence: "张三是李四的同事" })],
      }),
    );

    // 「李四」过了 §3.4 的事实门（证据里逐字在场），但不是**这条记录**抽出的实体 ⇒
    // 关系划不出本条记录的范围，按 unmatched 计（`IngestWriteCounts.relationUnmatched` 的头注）。
    expect(result.succeeded).toBe(true);
    expect(result.writes.relations).toBe(0);
    expect(result.writes.relationUnmatched).toBe(1);
    expect(allEdges()).toEqual([]);
  });

  it("词面解析出多个候选 ⇒ ambiguous +1，本层绝不猜（与 §3.13 同一取向）", async () => {
    insertEntity("entity_w_zhang_1", "active", "张三");
    insertEntity("entity_w_zhang_2", "active", "张三");
    insertEntity(ENT_ME, "active", "我");
    const record = newRecord();

    const result = await ingest(record.revisionId, output());

    expect(result.succeeded).toBe(true);
    expect(result.writes.relations).toBe(0);
    expect(result.writes.relationAmbiguous).toBe(1);
    expect([result.writes.relationUnmatched, result.writes.relationProvisional]).toEqual([0, 0]);
    // 标签面同样交给用户：两个候选没被自动合并成一条 Mention。
    expect(result.writes.unresolvedEntities).toBe(1);
    expect(allEdges()).toEqual([]);
  });

  it("两端解析到同一个实体 ⇒ 也算 ambiguous，库里不许出现自环边", async () => {
    insertEntity(ENT_ZHANG, "active", "张三");
    insertAlias(ENT_ZHANG, "我"); // 「我」与「张三」是同一个人的两种写法
    const record = newRecord();

    const result = await ingest(record.revisionId, output());

    expect(result.succeeded).toBe(true);
    expect(result.writes.relations).toBe(0);
    expect(result.writes.relationAmbiguous).toBe(1);
    // 库里一行都没有：自环边根本没机会落（store 的「端点是同一个实体」门在身后兜着）。
    expect(allEdges()).toEqual([]);
  });

  /** 丢弃数落在写入面上，而不是像致命门那样整批不采信（§3.4 与 §3.5 的分界）。 */
  it("校验门作废的那几条计入 droppedByContract，且不等于写入失败", async () => {
    insertEntity(ENT_ME, "active", "我");
    insertEntity(ENT_ZHANG, "active", "张三");
    const record = newRecord();

    const result = await ingest(
      record.revisionId,
      output({
        relations: [
          relation(),
          relation({ relationType: "triggered_by" }), // 不在模型可抽取的六值内
          relation({ srcLabel: "张三", dstLabel: "张三", evidence: EV }), // 两端同词（NFC 后相等）
          relation({ evidence: "原文里根本没有的一句证据" }), // 回锚不出坐标
        ],
      }),
    );

    expect(result.succeeded).toBe(true);
    expect(result.errorKind).toBeNull();
    expect(result.writes.relations).toBe(1); // 好的那一条照写
    expect(result.writes.relationDroppedByContract).toBe(3);
    // 门都没放行的条数不占用写入面那三类的计数——两个数是两件事。
    expect([result.writes.relationAmbiguous, result.writes.relationUnmatched, result.writes.relationProvisional]).toEqual([0, 0, 0]);
    expect(allEdges()).toHaveLength(1);
  });

  it("失败路径的 writes 面一个字段都不缺", async () => {
    insertEntity(ENT_ME, "active", "我");
    insertEntity(ENT_ZHANG, "active", "张三");
    const record = newRecord();
    const service = new IngestService({
      db,
      adapter: makeAdapter(),
      transport: stubTransport(HTTP_ERROR()).transport,
      systemPrompt: SYSTEM_PROMPT,
      now: () => new Date(FIXTURE_NOW),
      promptVersion: PIPELINE_A,
    });

    const result = await service.ingest({ recordRevisionId: record.revisionId });

    expect(result.succeeded).toBe(false);
    expect(Object.keys(result.writes).sort()).toEqual(Object.keys(emptyWrites()).sort());
    expect(result.writes).toEqual(emptyWrites());
    expect(allEdges()).toEqual([]);
  });
});

// ── 三、重跑语义：只增不删、不覆盖（R5 + 禁区 §五-3）────────────────

describe("M7-2b 写入面：重跑与既有边", () => {
  it("同一条关系第二次 run 仍只有一行，既有行一个字都不改", async () => {
    insertEntity(ENT_ME, "active", "我");
    insertEntity(ENT_ZHANG, "active", "张三");
    const record = newRecord();

    const first = await ingest(record.revisionId, output(), PIPELINE_A);
    const second = await ingest(record.revisionId, output(), PIPELINE_B);

    expect(second.succeeded).toBe(true);
    // 命中既有三元组不是「本 run 新写的边」（R5）。
    expect(second.writes.relations).toBe(0);
    const edges = allEdges();
    expect(edges).toHaveLength(1);
    expect(edges[0]!.origin_parse_run_id).toBe(first.runId);
    expect(edges[0]!.evidence_reason).toBe(reasonOf(first.runId, record.revisionId, EV_START, EV_END, EV));
  });

  it("用户手写的同 (type, pair) 边不被覆盖", async () => {
    insertEntity(ENT_ME, "active", "我");
    insertEntity(ENT_ZHANG, "active", "张三");
    const store = new GraphStore(db, { now: () => new Date(FIXTURE_NOW) });
    store.insertEdgeIfAbsent({
      relationType: "colleague_of",
      srcEntityId: ENT_ZHANG,
      dstEntityId: ENT_ME,
      createdBy: "user",
      evidenceReason: "用户手动确认的关系",
    });
    const record = newRecord();

    const result = await ingest(record.revisionId, output());

    expect(result.succeeded).toBe(true);
    expect(result.writes.relations).toBe(0);
    const edges = allEdges();
    expect(edges).toHaveLength(1);
    expect(edges[0]!.created_by).toBe("user");
    expect(edges[0]!.origin_parse_run_id).toBeNull();
    expect(edges[0]!.evidence_reason).toBe("用户手动确认的关系");
  });

  it("无向类型把两端写反，落的还是同一行", async () => {
    insertEntity(ENT_ME, "active", "我");
    insertEntity(ENT_ZHANG, "active", "张三");
    const record = newRecord();

    await ingest(record.revisionId, output(), PIPELINE_A); // 我 → 张三
    const reversed = await ingest(
      record.revisionId,
      output({ relations: [relation({ srcLabel: "张三", dstLabel: "我" })] }),
      PIPELINE_B,
    );

    expect(reversed.writes.relations).toBe(0);
    const edges = allEdges();
    expect(edges).toHaveLength(1);
    expect([edges[0]!.src_id, edges[0]!.dst_id]).toEqual([ENT_ME, ENT_ZHANG]);
  });

  it("reports_to 是 directed：正反两向是两行，各自记自己的 run", async () => {
    insertEntity(ENT_ME, "active", "我");
    insertEntity(ENT_ZHANG, "active", "张三");
    const record = newRecord();

    const down = await ingest(
      record.revisionId,
      output({ relations: [relation({ relationType: "reports_to", srcLabel: "张三", dstLabel: "我" })] }),
      PIPELINE_A,
    );
    const up = await ingest(
      record.revisionId,
      output({ relations: [relation({ relationType: "reports_to", srcLabel: "我", dstLabel: "张三" })] }),
      PIPELINE_B,
    );

    expect(down.writes.relations).toBe(1);
    expect(up.writes.relations).toBe(1);
    const edges = allEdges();
    expect(edges).toHaveLength(2);
    expect(edges.map((edge) => `${edge.src_id}>${edge.dst_id}`).sort()).toEqual(
      [`${ENT_ME}>${ENT_ZHANG}`, `${ENT_ZHANG}>${ENT_ME}`].sort(),
    );
    expect(edges.every((edge) => edge.relation_type === "reports_to")).toBe(true);
    expect(edges.map((edge) => edge.origin_parse_run_id).sort()).toEqual([down.runId, up.runId].sort());
  });
});
