/**
 * M7-3 关系一致性专项测试：A 组「重跑/编辑的收敛语义」+ B 组「导出与备份对账」+ C 组「Trace 面」+ D 组「补 UI 时的回填校验」。
 *
 * 分工边界（避免与既有文件重复或留缝）：
 *  - `m7-1-graph-contract` 钉 store 层自己守得住什么（库约束、UNIQUE、无向归一）；
 *  - `m7-2-relations-write` 钉**一次 run** 的写入面：四类计数、落库列的形状、重跑不覆盖；
 *  - 本文件钉的是**时间维度与读维度**：跨 run、跨 revision 的收敛语义（只增不删到底到什么程度）、
 *    关系图在导出/备份两条对外通道上各走哪条（B 组）、关系证据在 Trace 面上的缺席（C 组），
 *    以及「UI 回填只读库、不回头找 provider」（D 组）。
 *
 * 时钟纪律（第二批补强）：凡断言「旧行未变」，第二轮一律走 `CLOCK_SECOND`（晚一小时）。
 * 两轮共用一个 `now` 时这类断言恒真——见 `CLOCK_FIRST` 处的说明。
 *
 * 全程离线：回稿由注入的假 Transport 给出；库一律是 `TB_DATA_DIR` 沙箱里的真库真 migrator。
 */

import { copyFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { migrate, currentSchemaVersion } from "../src/server/db/migrator.ts";
import { seedVocabulary } from "../src/server/db/seed.ts";
import { ensureDataDirs } from "../src/server/config/paths.ts";
import { RecordService } from "../src/server/records/service.ts";
import { GraphStore } from "../src/server/graph/store.ts";
import { exportJsonl } from "../src/server/backup/jsonl.ts";
import { Workspace } from "../src/server/runtime/workspace.ts";
import { restoreFromBackup } from "../src/server/backup/restoreService.ts";
import { IngestService, type IngestResult } from "../src/server/ingest/ingestService.ts";
import type {
  ExtractedLabel,
  ExtractedRelation,
  StructuredOutput,
} from "../src/server/ingest/contract.ts";
import type { ProviderTransport } from "../src/server/ingest/provider.ts";
import { TraceSession, TracePrivacyViolation, type PrivacyGuards } from "../src/server/ingest/trace.ts";
import type { RedactionSpan } from "../src/server/privacy/redaction.ts";
import {
  FIXTURE_NOW,
  FIXTURE_TIMEZONE,
  OK_ENVELOPE,
  SYSTEM_PROMPT,
  createRecord,
  makeAdapter,
  stubTransport,
} from "./helpers/ingestFixtures.ts";
import { makeSandbox, openSandboxDb, type Sandbox } from "./helpers/sandbox.ts";
import type { Database } from "../src/server/db/adapter.ts";

/**
 * 「换一条管线」的标记：合成串，不是版本号。`DEFAULT_PROMPT_VERSION` 一升到这两个值，
 * 重跑就并回同一条管线，A1/A4 会静默变成「同键重放」而不是「新 run 撞既有边」。
 */
const PIPELINE_A = "test-prompt-consistency-a";
const PIPELINE_B = "test-prompt-consistency-b";

/**
 * 两轮时钟（第二批补强）：第一轮是夹具时刻，第二轮**晚整整一小时**。
 *
 * 为什么必须有第二个时钟：A1/A2/A3/A4 都断言「旧行的 `created_at_utc`/`updated_at_utc` 未变」，
 * 而两轮 ingest 与建边过去共用同一个 `FIXTURE_NOW`——实现就算偷偷把时间戳刷成「当下」，
 * 读回来的串也一模一样，那条断言恒真、证伪不了任何东西。第二轮换成本夹具里独一份的时刻后，
 * 任何续期都会把 `CLOCK_SECOND` 写进旧行，`expectFrozenAtFirstClock` 立刻红。
 */
const CLOCK_FIRST = new Date(FIXTURE_NOW);
const CLOCK_SECOND = new Date(CLOCK_FIRST.getTime() + 3_600_000);
const FIRST_ISO = CLOCK_FIRST.toISOString();
const LATER_ISO = CLOCK_SECOND.toISOString();

const ENT_ME = "entity_c_me";
const ENT_ZHANG = "entity_c_zhang";

/** r1 的原文与证据切片（坐标按 §3.5 是**原文**坐标）。 */
const RAW = "张三是我的同事，我们一道改了发布计划";
const EV = "张三是我的同事";
const EV_START = RAW.indexOf(EV);
const EV_END = EV_START + EV.length;

/** r2（A2）：关系仍在，换了别的字句。 */
const RAW_2 = "张三是我的同事，我们一道改了发布计划的每一个字";
/** r2（A3）：关系那段从原文里删掉了。 */
const RAW_DROPPED = "今天把发布计划提前定稿了";

let sandbox: Sandbox;
let db: Database;

beforeEach(() => {
  sandbox = makeSandbox("tb-m7-3-");
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

/** 整行读回来：收敛语义断言的是「这一行有没有被碰过」，所以列要一次取全。 */
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
  created_at_utc: string;
  updated_at_utc: string;
}

function allEdges(): EdgeRow[] {
  return db
    .prepare(
      `select id, relation_type, src_kind, dst_kind, src_id, dst_id, lifecycle_status, created_by,
              origin_parse_run_id, evidence_reason, created_at_utc, updated_at_utc
         from graph_edge order by relation_type, src_id, dst_id`,
    )
    .all() as unknown as EdgeRow[];
}

function store(now: Date = CLOCK_FIRST): GraphStore {
  return new GraphStore(db, { now: () => now });
}

/**
 * 「旧行没被续期」的硬版本：两列时间戳逐字等于**第一轮**的时钟，并显式排除第二轮那个
 * 只在本夹具里出现过的时刻。`toEqual(before)` 做的是全量对账，这一句钉的是它到底在防什么。
 */
function expectFrozenAtFirstClock(row: { created_at_utc: string; updated_at_utc: string }): void {
  expect(row.created_at_utc).toBe(FIRST_ISO);
  expect(row.updated_at_utc).toBe(FIRST_ISO);
  expect(row.created_at_utc).not.toBe(LATER_ISO);
  expect(row.updated_at_utc).not.toBe(LATER_ISO);
}

function label(labelSaid: string, evidence = EV): ExtractedLabel {
  return { labelSaid, candidateConceptId: null, basis: "explicit", evidence };
}

function relation(overrides: Partial<ExtractedRelation> = {}): ExtractedRelation {
  return { relationType: "colleague_of", srcLabel: "我", dstLabel: "张三", evidence: EV, ...overrides };
}

/** 基线回稿：两个实体标签 + 一条同事关系，其余产出留空。 */
function output(overrides: Partial<StructuredOutput> = {}): StructuredOutput {
  return {
    title: "一次关系收敛的回稿",
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

/** A3 用：新原文里既没有那段关系，回稿也不再提它——只剩一条与关系无关的念头。 */
function outputWithoutRelation(): StructuredOutput {
  return output({
    title: "定稿发布计划",
    summary: "把发布计划定稿了",
    entities: [],
    relations: [],
    thoughts: [{ text: "发布计划要提前定稿", evidence: "发布计划提前定稿" }],
  });
}

function newRecord(text = RAW): { recordId: string; revisionId: string } {
  return createRecord(db, text, "local_model");
}

/** 编辑记录 ⇒ 新 revision（K-01：历史原文不改写）；返回新 revision 的 id。 */
function editRecord(recordId: string, text: string, now: Date = CLOCK_FIRST): string {
  const service = new RecordService(db, {
    timezoneId: FIXTURE_TIMEZONE,
    now: () => now,
  });
  const result = service.editRecord(recordId, text);
  expect(result.changed).toBe(true);
  return result.revision.id;
}

async function ingestWith(
  revisionId: string,
  out: StructuredOutput,
  transport: ProviderTransport,
  promptVersion: string,
  now: Date = CLOCK_FIRST,
): Promise<IngestResult> {
  const service = new IngestService({
    db,
    adapter: makeAdapter(),
    transport,
    systemPrompt: SYSTEM_PROMPT,
    now: () => now,
    promptVersion,
  });
  return service.ingest({ recordRevisionId: revisionId });
}

function ingest(
  revisionId: string,
  out: StructuredOutput,
  promptVersion = PIPELINE_A,
  now: Date = CLOCK_FIRST,
): Promise<IngestResult> {
  return ingestWith(revisionId, out, stubTransport(OK_ENVELOPE(out)).transport, promptVersion, now);
}

/** §3.5 钉死的证据串形状，在测试侧写一遍：实现改形状要在这里一起红。 */
function reasonOf(runId: string, revisionId: string, start: number, end: number, evidence: string): string {
  return `parse_run:${runId} rev:${revisionId} span:${start}-${end} evidence=${evidence.slice(0, 200)}`;
}

/** D 组的 provider 哨兵：任何调用先计数再抛错——「读到 0」才是硬结论。 */
function spyTransport(): { readonly transport: ProviderTransport; callCount(): number } {
  let calls = 0;
  const transport: ProviderTransport = {
    send: async () => {
      calls += 1;
      throw new Error("回填校验不该发出任何模型调用");
    },
  };
  return { transport, callCount: () => calls };
}

// ── A 组：重跑/编辑的收敛语义（只增不删）───────────────────────────

describe("M7-3 A 组：重跑/编辑的收敛语义（只增不删）", () => {
  it("A1 同一 revision 换管线重跑：仍只有一行，旧行逐字段未变", async () => {
    insertEntity(ENT_ME, "active", "我");
    insertEntity(ENT_ZHANG, "active", "张三");
    const record = newRecord();

    const first = await ingest(record.revisionId, output(), PIPELINE_A);
    expect(first.writes.relations).toBe(1);
    const before = allEdges();
    expect(before).toHaveLength(1);
    // 夹具前提：旧行确实带着第一轮的时钟，否则下面那句「未变」又是恒真的。
    expectFrozenAtFirstClock(before[0]!);

    // 第二轮换了管线，也换了时钟（晚一小时）：这一轮任何对旧行的触碰都留得住痕迹。
    const second = await ingest(record.revisionId, output(), PIPELINE_B, CLOCK_SECOND);

    // 夹具前提：第二次是**一次真的新 run**（新管线 ⇒ 新指纹），不是同键重放；
    // 否则「relations=0」是重放的必然结果，压根没走到写入面。
    expect(second.succeeded).toBe(true);
    expect(second.replayed).toBe(false);
    expect(second.runId).not.toBe(first.runId);

    // 命中既有三元组不算本 run 新建（R5）。
    expect(second.writes.relations).toBe(0);
    const after = allEdges();
    expect(after).toHaveLength(1);
    // 整行逐字段对账：id / created_at_utc / updated_at_utc / lifecycle_status / 来源，一个都没动。
    expect(after).toEqual(before);
    expectFrozenAtFirstClock(after[0]!);
    expect(after[0]!.lifecycle_status).toBe("active");
    expect(after[0]!.origin_parse_run_id).toBe(first.runId);
    expect(after[0]!.evidence_reason).toBe(reasonOf(first.runId, record.revisionId, EV_START, EV_END, EV));
    // 新 run 名下零边：旧行没被「改姓」，新行也没被补写。
    expect(store(CLOCK_SECOND).edgesOfRun(second.runId)).toEqual([]);
  });

  it("A2 编辑产生新 revision、新 run 提取到同一关系：旧边不动、没有重复行", async () => {
    insertEntity(ENT_ME, "active", "我");
    insertEntity(ENT_ZHANG, "active", "张三");
    const record = newRecord();

    const first = await ingest(record.revisionId, output(), PIPELINE_A);
    expect(first.writes.relations).toBe(1);
    const before = allEdges();
    expectFrozenAtFirstClock(before[0]!);

    // 第二轮整轮走晚一小时的时钟：编辑本身、重跑、以及重跑之后读图用的 store 都是。
    const revision2 = editRecord(record.recordId, RAW_2, CLOCK_SECOND);
    expect(revision2).not.toBe(record.revisionId);

    const second = await ingest(revision2, output(), PIPELINE_A, CLOCK_SECOND);

    expect(second.succeeded).toBe(true);
    expect(second.runId).not.toBe(first.runId);
    // 这一笔确实重新整理过（mention 是新 revision 自己的），不是空转。
    expect(second.writes.mentions).toBe(2);
    // 同 (type, pair) 在三元组上唯一：跨 revision 也一样，于是这一次仍然「没新建」。
    expect(second.writes.relations).toBe(0);

    const after = allEdges();
    expect(after).toHaveLength(1);
    expect(after).toEqual(before);
    expectFrozenAtFirstClock(after[0]!);
    expect(after[0]!.origin_parse_run_id).toBe(first.runId);
    expect(after[0]!.evidence_reason).toBe(reasonOf(first.runId, record.revisionId, EV_START, EV_END, EV));
    expect(store(CLOCK_SECOND).edgesOfRun(second.runId)).toEqual([]);
  });

  it("A3 新 revision 里那段关系消失了：旧边仍在——这是刻意的只增不删", async () => {
    insertEntity(ENT_ME, "active", "我");
    insertEntity(ENT_ZHANG, "active", "张三");
    const record = newRecord();

    const first = await ingest(record.revisionId, output(), PIPELINE_A);
    expect(first.writes.relations).toBe(1);
    const before = allEdges();
    expectFrozenAtFirstClock(before[0]!);

    // 夹具前提：新原文里逐字不含旧证据，回稿也不再提这条关系。
    expect(RAW_DROPPED).not.toContain(EV);
    // 第二轮整轮走晚一小时的时钟。
    const revision2 = editRecord(record.recordId, RAW_DROPPED, CLOCK_SECOND);

    const second = await ingest(revision2, outputWithoutRelation(), PIPELINE_A, CLOCK_SECOND);
    expect(second.succeeded).toBe(true);
    expect(second.writes.relations).toBe(0);
    expect(second.writes.thoughts).toBe(1);

    /**
     * 断言的是「旧边还在」：AI 重跑**只增不删**，关系在原文里消失不构成删除图谱事实的理由
     * （R5；M7-2b 工作日志「未做项」第 3 条把它留给收敛语义）。删除是用户的动作，等 UI 阶段的
     * `lifecycle_status='superseded'` 落点——所以这里不是漏删，也不是等在这里补的 bug。
     */
    const after = allEdges();
    expect(after).toHaveLength(1);
    expect(after).toEqual(before);
    expectFrozenAtFirstClock(after[0]!);
    expect(after[0]!.lifecycle_status).toBe("active");
    expect(after[0]!.origin_parse_run_id).toBe(first.runId);
  });

  it("A4 用户边被 AI 重跑两轮后，lifecycle_status 与 evidence_reason 仍未变", async () => {
    // 「用户边不被覆盖 ⇒ created_by 仍是 user、origin_parse_run_id 仍是 NULL」已由
    // `tests/m7-2-relations-write.test.ts`「用户手写的同 (type, pair) 边不被覆盖」钉死，
    // 这里不重复造，只补那条用例没看的那两列。
    insertEntity(ENT_ME, "active", "我");
    insertEntity(ENT_ZHANG, "active", "张三");
    // 用户手写的边落在第一轮时钟上；两轮 AI 重跑都在一小时后——旧行「没被续期」这才可证伪。
    store(CLOCK_FIRST).insertEdgeIfAbsent({
      relationType: "colleague_of",
      srcEntityId: ENT_ZHANG,
      dstEntityId: ENT_ME,
      createdBy: "user",
      evidenceReason: "用户手动确认的关系",
    });
    const before = allEdges();
    expect(before).toHaveLength(1);
    expectFrozenAtFirstClock(before[0]!);

    const record = newRecord();
    const first = await ingest(record.revisionId, output(), PIPELINE_A, CLOCK_SECOND);
    const second = await ingest(record.revisionId, output(), PIPELINE_B, CLOCK_SECOND);

    expect(first.succeeded).toBe(true);
    expect(second.succeeded).toBe(true);
    expect(first.writes.relations).toBe(0);
    expect(second.writes.relations).toBe(0);

    const after = allEdges();
    expect(after).toHaveLength(1);
    expect(after).toEqual(before);
    expectFrozenAtFirstClock(after[0]!);
    // 本用例的两列窄面：既没被续期，也没被 AI 的证据串顶掉。
    expect(after[0]!.lifecycle_status).toBe("active");
    expect(after[0]!.evidence_reason).toBe("用户手动确认的关系");
    expect(store(CLOCK_SECOND).edgesOfRun(first.runId)).toEqual([]);
    expect(store(CLOCK_SECOND).edgesOfRun(second.runId)).toEqual([]);
  });
});

// ── B 组：导出与备份对账 ────────────────────────────────────────────

/**
 * 一条边的「对账八列」投影（指令点名的那一组）。
 * 整行 `toEqual` 是它的超集，这份投影的作用是把**对账的到底是哪几列**写在测试里，
 * 而不是留给读者去猜两个行形状是不是同一套列。
 */
interface EdgeFingerprintRow {
  readonly id: string;
  readonly relation_type: string;
  readonly src_id: string;
  readonly dst_id: string;
  readonly created_by: string;
  readonly origin_parse_run_id: string | null;
  readonly evidence_reason: string | null;
  readonly lifecycle_status: string;
}

function edgeFingerprint(rows: readonly EdgeFingerprintRow[]): unknown[] {
  return rows.map((row) => ({
    id: row.id,
    relation_type: row.relation_type,
    src_id: row.src_id,
    dst_id: row.dst_id,
    created_by: row.created_by,
    origin_parse_run_id: row.origin_parse_run_id,
    evidence_reason: row.evidence_reason,
    lifecycle_status: row.lifecycle_status,
  }));
}

/**
 * 收齐一份 JSON 对象里**所有的键名与字符串叶子**——「导出里有没有图谱边」按对象名/表名/列名/主键扫，
 * 不靠猜某一段具体文案。
 */
function collectKeysAndStrings(value: unknown, into: Set<string>): void {
  if (typeof value === "string") {
    into.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectKeysAndStrings(item, into);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      into.add(key);
      collectKeysAndStrings(child, into);
    }
  }
}

describe("M7-3 B 组：导出与备份对账", () => {
  /**
   * 带关系的库：一条 AI 边（带 `origin_parse_run_id`）+ 一条用户手写的边（来源指针为 NULL）。
   * 两种形状都留着，导出面和备份面才不是只对着其中一种表态。
   */
  async function libraryWithRelations(): Promise<{ readonly recordId: string; readonly edges: EdgeRow[] }> {
    insertEntity(ENT_ME, "active", "我");
    insertEntity(ENT_ZHANG, "active", "张三");
    store(CLOCK_FIRST).insertEdgeIfAbsent({
      relationType: "friend_of",
      srcEntityId: ENT_ME,
      dstEntityId: ENT_ZHANG,
      createdBy: "user",
      evidenceReason: "用户手动确认的关系",
    });
    const record = newRecord();
    const first = await ingest(record.revisionId, output(), PIPELINE_A, CLOCK_FIRST);
    expect(first.writes.relations).toBe(1);
    const edges = allEdges();
    expect(edges).toHaveLength(2);
    return { recordId: record.recordId, edges };
  }

  it("B1 JSONL 导出的对象集合仍是记录 + 版本，图谱边一行都不出去", async () => {
    /**
     * 这一条钉的是**既有事实**，不是本轮扩导出：`exportJsonl` 的清单只有 `capture_record` 与
     * `record_revision`（`src/server/backup/jsonl.ts` 的 `object_types`），M7 的关系面从来不在导出契约里。
     * 关系靠 B2 那条快照备份走。指令 §3 明确划了禁区：本轮不扩 JSONL 导出。
     */
    const { edges } = await libraryWithRelations();

    const exported = exportJsonl(db, { now: () => CLOCK_FIRST });
    const lines = exported
      .trimEnd()
      .split("\n")
      .map((raw) => JSON.parse(raw) as Record<string, unknown>);

    const meta = lines[0]!;
    expect(meta.line).toBe("meta");
    // 导出面自己声明的对象集：说什么就导出什么，也不越界宣称导出了图谱。
    expect(meta.object_types).toEqual(["capture_record", "record_revision"]);

    const dataLines = lines.slice(1);
    const kinds = [...new Set(dataLines.map((line) => line.line))].sort();
    expect(kinds).toEqual(["capture_record", "record_revision"]);
    // 夹具前提：导出确实有内容，否则上面那个「集合相等」可以是空集蒙过去的。
    expect(dataLines.filter((line) => line.line === "capture_record")).toHaveLength(1);
    expect(dataLines.filter((line) => line.line === "record_revision")).toHaveLength(1);

    const leaves = new Set<string>();
    for (const line of lines) collectKeysAndStrings(line, leaves);
    // 库里那两条边的主键，一个都没出现在导出里——按 id 扫，不是按表名猜。
    for (const edge of edges) expect(leaves.has(edge.id)).toBe(false);
    // graph_edge 的表名与列名也不以任何键的形式出现。
    for (const token of [
      "graph_edge",
      "relation_type",
      "src_kind",
      "dst_kind",
      "origin_parse_run_id",
      "origin_suggestion_id",
      "created_by",
      "lifecycle_status",
    ]) {
      expect(leaves.has(token)).toBe(false);
    }
  });

  it("B2 快照备份恢复到新库：关系图逐字段完好", async () => {
    /**
     * 快照是 `VACUUM INTO` 的**整库复制**（M1b §六 R-5：恢复 = 整库原位替换），所以关系图跟着走
     * 是既有事实；这一条就是那个事实的可执行证据——`exportJsonl` 那份按对象导出的面反而不带它（B1）。
     * 刻意恢复到**另一个沙箱的新库**，而不是同一个库原地回滚：同库回滚可以靠「文件本来就是它自己」
     * 蒙对，跨库才证得出内容真在快照里。
     */
    await libraryWithRelations();
    const source = new Workspace(sandbox.layout, db, currentSchemaVersion(db));
    const backup = source.backups.createBackup();

    const beforeMe = store(CLOCK_FIRST).edgesOfEntity(ENT_ME);
    const beforeZhang = store(CLOCK_FIRST).edgesOfEntity(ENT_ZHANG);
    expect(beforeMe).toHaveLength(2);
    expect(beforeZhang).toHaveLength(2);

    const target = makeSandbox("tb-m7-3-restore-");
    let targetWorkspace: Workspace | null = null;
    try {
      ensureDataDirs(target.layout);
      const targetDb = openSandboxDb(target.layout);
      migrate(targetDb);
      seedVocabulary(targetDb);
      targetWorkspace = new Workspace(target.layout, targetDb, currentSchemaVersion(targetDb));

      // 夹具前提：新库里一条边都没有——下面读回来的边只可能来自那份快照。
      expect(new GraphStore(targetWorkspace.db, { now: () => CLOCK_FIRST }).edgesOfEntity(ENT_ME)).toEqual([]);

      copyFileSync(join(sandbox.layout.backupsDir, backup.name), join(target.layout.backupsDir, backup.name));
      const result = restoreFromBackup(targetWorkspace, backup.name);
      expect(result.records).toBe(1);

      const restored = new GraphStore(targetWorkspace.db, { now: () => CLOCK_FIRST });
      const afterMe = restored.edgesOfEntity(ENT_ME);
      const afterZhang = restored.edgesOfEntity(ENT_ZHANG);

      // 整行对账（含两列时间戳），外加指令点名的那八列的逐字段投影。
      expect(afterMe).toEqual(beforeMe);
      expect(edgeFingerprint(afterMe)).toEqual(edgeFingerprint(beforeMe));
      expect(afterZhang).toEqual(beforeZhang);
      expect(edgeFingerprint(afterZhang)).toEqual(edgeFingerprint(beforeZhang));
      // 无向边从任一端点都读得到，且两条边的来源形状各保留一种。
      expect(afterMe.map((row) => row.created_by).sort()).toEqual(["ai_generated", "user"]);
      expect(afterMe.map((row) => row.origin_parse_run_id).filter((id) => id !== null)).toHaveLength(1);
    } finally {
      // 恢复流程换过血：原句柄早被它关掉了，这里只补刀活动的那一个。
      try {
        targetWorkspace?.db.close();
      } catch {
        /* 已被恢复流程关闭的旧句柄不需要二次关闭 */
      }
      target.cleanup();
    }
  });
});

// ── C 组：Trace 面 ──────────────────────────────────────────────────

/**
 * 关系写入带来的全部**真实文字**：两端的实体词面，加上入库那段证据原文。
 * 它们之中任何一个出现在普通 Trace 的序列化结果里，都等于关系面把「用户原话」
 * 复制到了第三条对外通道上（前两条由 B 组对账：JSONL 导出、快照备份）。
 */
const FACES = ["张三", "我", EV];

/** 序列化结果里**所有**字符串叶子（含键名）——C 组按叶子扫，不靠列举某几段文案。 */
function leavesOf(entries: unknown): Set<string> {
  const into = new Set<string>();
  collectKeysAndStrings(entries, into);
  return into;
}

/**
 * 把词面交给守门函数。
 *
 * `PrivacyGuards` 的原生通道只有三条（`rawText` / `redactionMap` / `apiKey`），实体词面
 * 不属于其中任何一条的原生形态——这里借 `redactionMap` 的**占位符本体**通道递进去：
 * `guardLiterals`（`src/server/ingest/trace.ts:188`）逐条取 `spans[].placeholder`，
 * 三条通道的字面量在 `serializeTrace` 里受同一道门（`json.includes(literal)` 即拒），
 * 所以判定强度与直接传原文相同。坐标只为让这份映射的形状成立（每 100 一档、互不重叠），
 * Trace 面不读它们——`guards` 本身永不进任何序列化结果。
 */
function faceGuards(faces: readonly string[]): PrivacyGuards {
  return {
    redactionMap: {
      policyVersion: "test-m7-3-faces-only",
      nonce: "000000",
      spans: faces.map((face, index): RedactionSpan => ({
        kind: "person",
        placeholder: face,
        originalStart: index * 100,
        originalEnd: index * 100 + face.length,
        redactedStart: index * 100,
        redactedEnd: index * 100 + face.length,
        source: "entity_memory",
      })),
    },
  };
}

/**
 * 一次**真的跑起来**的带关系 run，Trace 由 `IngestService` 自己写进会话。
 *
 * 不手工构造 `TraceEntry`：那样测到的是守门函数的形状，测不到「关系写入这条路径上
 * 有没有人往 Trace 里塞文字」。调试原文开关显式打开（`debugRawText: true`），
 * 让 `captureDebugRaw` 真的收下原文——否则「序列化里搜不到原文」可以由「容器本来就是空的」
 * 蒙对，那什么都不证明。
 */
async function runWithTrace(): Promise<{
  readonly session: TraceSession;
  readonly result: IngestResult;
  readonly record: { readonly recordId: string; readonly revisionId: string };
}> {
  insertEntity(ENT_ME, "active", "我");
  insertEntity(ENT_ZHANG, "active", "张三");
  const record = newRecord();
  const session = new TraceSession({ now: () => CLOCK_FIRST, debugRawText: true });
  const service = new IngestService({
    db,
    adapter: makeAdapter(),
    transport: stubTransport(OK_ENVELOPE(output())).transport,
    systemPrompt: SYSTEM_PROMPT,
    now: () => CLOCK_FIRST,
    promptVersion: PIPELINE_A,
    trace: session,
  });
  const result = await service.ingest({ recordRevisionId: record.revisionId });

  // 夹具前提：这确实是一次**带关系**的成功 run，且 Trace 是它自己写出来的。
  expect(result.succeeded).toBe(true);
  expect(result.replayed).toBe(false);
  expect(result.writes.relations).toBe(1);
  expect(session.entryCount).toBe(1);
  return { session, result, record };
}

describe("M7-3 C 组：Trace 面（关系不新增敏感面）", () => {
  it("C1 带关系的 run：原文与实体词面作 guards 不抛，序列化结果里一个都搜不到", async () => {
    const { session, record } = await runWithTrace();

    // 调试原文容器**确实**装着原文：下面那句「普通序列化里搜不到」由此才有内容。
    expect(session.debugRawTextEnabled).toBe(true);
    expect(session.debugRecordCount).toBeGreaterThan(0);
    expect(session.exportDebugRaw(true).map((row) => row.rawText)).toContain(RAW);

    const guards: PrivacyGuards = { rawText: RAW, ...faceGuards(FACES) };
    // 守门放行——关系写入没有把任何一条 guard 字面量带进普通 Trace。
    expect(() => session.serialize(guards)).not.toThrow();

    const json = session.serialize(guards);
    expect(json).not.toContain(RAW);
    expect(json).not.toContain(EV);
    for (const face of FACES) expect(json).not.toContain(face);

    /**
     * 两个容器互不可见，是实现事实而非约定：`session.serialize()` 就是
     * `serializeTrace(this.#entries, guards)`（`trace.ts:443-445`），而调试原文住在
     * `#debugRecords`，字段面封闭集里根本没有承载它的键（`TRACE_ENTRY_FIELDS`）。
     * 所以「开着调试开关」不能让原文进导出/日志面。
     */
    const leaves = leavesOf(JSON.parse(json));
    const leaked = [...leaves].filter((leaf) => [...FACES, RAW].some((face) => leaf.includes(face)));
    expect(leaked).toEqual([]);

    /**
     * 正控制（防「不抛」是空转）：同一组 guards 遇到真泄露时**必抛**——证明上面放行的是
     * Trace 本身干净，不是门没生效。`diagnostics` 是字段面里唯一允许自由键的位置，
     * 也是关系证据最可能被顺手记进去的地方，泄露就造在那里。
     */
    const poisoned = new TraceSession({ now: () => CLOCK_FIRST });
    poisoned.record({ recordRevisionId: record.revisionId, diagnostics: { evidence: RAW } });
    expect(() => poisoned.serialize(guards)).toThrow(TracePrivacyViolation);
  });

  it("C2 关系证据只以库里的 evidence_reason 形态存在：形状对得上，Trace 面里搜不到它", async () => {
    const { session, result, record } = await runWithTrace();

    const edges = allEdges();
    expect(edges).toHaveLength(1);
    const reason = edges[0]!.evidence_reason;
    expect(reason, "AI 边必须带证据串").not.toBeNull();

    // 库内形状：`parse_run:<id> rev:<id> span:<a>-<b> evidence=<切片>`。
    const matched = /^parse_run:(\S+) rev:(\S+) span:(\d+)-(\d+) evidence=([\s\S]+)$/.exec(reason!);
    expect(matched, `证据串形状不符：${reason}`).not.toBeNull();
    const [, runId, revisionId, startText, endText, slice] = matched!;
    expect(runId).toBe(result.runId);
    expect(revisionId).toBe(record.revisionId);
    expect(slice).toBe(EV);
    // 坐标不是装饰：按它切**原文**正好切出这段证据（§3.5 钉的是原文坐标，不是发送文本坐标）。
    const start = Number(startText);
    const end = Number(endText);
    expect(end).toBeGreaterThan(start);
    expect(RAW.slice(start, end)).toBe(EV);
    // 与测试侧另写一遍的构造器对账（A1/D1 同款）：实现改形状要在这里一起红。
    expect(reason).toBe(reasonOf(result.runId, record.revisionId, EV_START, EV_END, EV));

    const json = session.serialize({ rawText: RAW, ...faceGuards([...FACES, reason!]) });
    expect(json).not.toContain(EV);
    expect(json).not.toContain(reason!);
    expect(json).not.toContain("evidence=");
    for (const face of FACES) expect(json).not.toContain(face);

    // 更强的窄面：一次带关系的 run 之后，Trace 里**没有任何含汉字的叶子**——
    // 证据切片与两端词面在库里存在，在 Trace 面上无处存在。
    const cjkLeaves = [...leavesOf(JSON.parse(json))].filter((leaf) => /[一-鿿]/.test(leaf));
    expect(cjkLeaves).toEqual([]);

    // `diagnostics` 是唯一允许自由键的位置，它此刻只该是计数：一个字符串叶子都没有。
    const diagnostics = (JSON.parse(json) as { diagnostics?: Record<string, unknown> }[])[0]!.diagnostics!;
    expect(Object.keys(diagnostics).length).toBeGreaterThan(0);
    for (const value of Object.values(diagnostics)) expect(typeof value).toBe("number");
  });
});

// ── D 组：补 UI 时的回填校验 ────────────────────────────────────────

describe("M7-3 D 组：补 UI 时的回填校验（读图不回 provider）", () => {
  it("D1 关系子图直接读库即与 run 写下的边一致，且 provider 调用次数为 0", async () => {
    insertEntity(ENT_ME, "active", "我");
    insertEntity(ENT_ZHANG, "active", "张三");
    const record = newRecord();

    // 先照常跑一次：这一步**该**调用 provider 一次，否则下面那句「0 次」毫无意义。
    const runStub = stubTransport(OK_ENVELOPE(output()));
    const result = await ingestWith(record.revisionId, output(), runStub.transport, PIPELINE_A);
    expect(result.succeeded).toBe(true);
    expect(result.writes.relations).toBe(1);
    expect(runStub.callCount()).toBe(1);

    // run 结束后把 provider 换成「任何调用即计数并抛错」的哨兵。**不**重新授权原文、
    // **不**重跑 ingest：这就是 UI 打开图谱时的装配形态。
    const spy = spyTransport();
    const servedBySpy = new IngestService({
      db,
      adapter: makeAdapter(),
      transport: spy.transport,
      systemPrompt: SYSTEM_PROMPT,
      now: () => new Date(FIXTURE_NOW),
      promptVersion: PIPELINE_A,
    });

    // UI 会用的那条在册读面也走一遍：拿着坏掉的 provider 照样读得回来。
    // 口径如实记下——AI 的 run 在用户采纳前一直是 `candidate`，所以 current 是空的，
    // 而关系边是**写在 candidate 名下**的（§3.5 的来源指针），照样读得到。
    const view = servedBySpy.currentView(record.revisionId);
    expect(view.currentRunId).toBeNull();
    expect(view.candidates.map((candidate) => candidate.runId)).toContain(result.runId);

    const subgraph = store().edgesOfEntity(ENT_ME);

    // 主断言：回填走的是纯库读，一个模型请求都没发出。
    expect(spy.callCount()).toBe(0);

    // 子图内容与 run 时写下的边一致（同三元组 + 同一来源指针）。
    expect(subgraph).toHaveLength(1);
    expect(subgraph).toEqual(store().edgesOfRun(result.runId));
    const edge = subgraph[0]!;
    expect(edge.relation_type).toBe("colleague_of");
    expect(edge.src_kind).toBe("entity");
    expect(edge.dst_kind).toBe("entity");
    expect([edge.src_id, edge.dst_id]).toEqual([ENT_ME, ENT_ZHANG]);
    expect(edge.lifecycle_status).toBe("active");
    expect(edge.created_by).toBe("ai_generated");
    expect(edge.origin_parse_run_id).toBe(result.runId);
    expect(edge.evidence_reason).toBe(reasonOf(result.runId, record.revisionId, EV_START, EV_END, EV));
    // 无向边从**任一端点**都读得到同一行——UI 聚焦哪一头不影响回填结果。
    expect(store().edgesOfEntity(ENT_ZHANG)).toEqual(subgraph);
    expect(spy.callCount()).toBe(0);
  });
});
