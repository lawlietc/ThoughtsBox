import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { boot, shutdown, type BootResult } from "../src/server/runtime/bootstrap.ts";
import { ensureConfigFile } from "../src/server/config/config.ts";
import type { DataLayout } from "../src/server/config/paths.ts";
import { IngestService } from "../src/server/ingest/ingestService.ts";
import { makeSandbox, type Sandbox } from "./helpers/sandbox.ts";
import {
  FIXTURE_NOW,
  LOCAL_RAW,
  OK_ENVELOPE,
  SYSTEM_PROMPT,
  envelopeOf,
  makeAdapter,
  stubTransport,
  validOutput,
} from "./helpers/ingestFixtures.ts";
import type { StructuredOutput } from "../src/server/ingest/contract.ts";

import {
  evidencePhrase,
  MENTION_SOURCE_PHRASE,
  productBoxPage,
  productSuggestions,
  readableResult,
  type EffectiveEntry,
} from "../src/web/projections.ts";
import { BOX_SHAPES, boxShapeOf, COUNT_PLACEHOLDER } from "../src/web/projectionPort.ts";
import type { PortRow } from "../src/web/projectionPort.ts";
import {
  BASIS_LABEL,
  CONCEPT_LIFECYCLE_LABEL,
  ENUM_VALUES,
  MENTION_STATUS_LABEL,
} from "../src/web/ui/labels.ts";
import type { EffectiveEvidenceDto, EffectiveResultDto, RecordRow } from "../src/shared/dto.ts";

/**
 * M3-PROJ-1 可读投影补全的验收面。
 *
 * 三块，对应任务书本体的三条线：
 * 1. **服务端**：§六 缺口清单逐项落地（`EffectiveResultDto` 的扩集字段真的带出内容来），
 *    与 `currentView` 同口径，采纳/放弃两条新路由与错误面，以及三条红线里属于后端的那两条。
 * 2. **纯映射层**：`productBoxPage` / `readableResult` 与形状表、标签表对齐（node 里就能钉死的部分）。
 * 3. **红线③（单轨）**：`fakeApi` 那份诚实语义没被渲染门推翻。
 *
 * 渲染对不对仍归两档渲染证据门（任务书 §九）：这里没有 DOM，`productPort.ts` 的取数
 * 也不在 node 里跑（它要 `globalThis.fetch`）——它由门 1 的真后端那一趟实测覆盖。
 *
 * 全程离线：Provider 由 `boot({ ingestProvider })` 注入桩 transport；库只落 `TB_DATA_DIR` 沙箱。
 */

const WEB_DIR = join(process.cwd(), "src", "web");
const SERVER_DIR = join(process.cwd(), "src", "server");
const MIGRATIONS = join(SERVER_DIR, "db", "migrations");

function webSource(name: string): string {
  return readFileSync(join(WEB_DIR, name), "utf8");
}

/* ════════════════════════════════════════════════════════════════════
 * 服务端夹具：一份桩 transport，回稿按当前剧本现取（云端那一趟要现算占位符）。
 * ════════════════════════════════════════════════════════════════════ */

let sandbox: Sandbox | undefined;
let booted: BootResult | undefined;
let base = "";
let currentOutput: () => StructuredOutput = () => validOutput();

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

async function ensureShared(): Promise<void> {
  if (booted !== undefined) return;
  const port = await testPort();
  sandbox = makeSandbox("tb-m3-proj1-");
  writePort(sandbox.layout, port);
  booted = await boot({
    env: { TB_DATA_DIR: sandbox.root },
    log: () => {},
    ingestProvider: {
      adapter: makeAdapter(),
      transport: {
        send: async () => ({ status: 200, body: envelopeOf(currentOutput()) }),
      },
      systemPrompt: SYSTEM_PROMPT,
      now: () => new Date(FIXTURE_NOW),
    },
  });
  base = `http://127.0.0.1:${port}`;
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

/** 错误回话里的分类码（`fail()` 的分类表那一列）。 */
async function errorKindOf(res: Response): Promise<string> {
  const body = (await res.json()) as { error?: unknown };
  return typeof body.error === "string" ? body.error : "";
}

async function makeRecord(text: string, mode?: string): Promise<{ recordId: string; revisionId: string }> {
  await ensureShared();
  const created = booted!.workspace.records.createRecord(text);
  if (mode !== undefined) {
    booted!.db
      .prepare("update capture_record set processing_mode = ? where id = ?")
      .run(mode, created.record.id);
  }
  return { recordId: created.record.id, revisionId: created.revision.id };
}

async function effectiveOf(revisionId: string): Promise<EffectiveResultDto> {
  const res = await call("GET", `/api/ingest/effective/${revisionId}`);
  expect(res.status, "op9 应该 200").toBe(200);
  return res.json as EffectiveResultDto;
}

/** 把某条记录整理好**并采纳**（§3.7：candidate 不采纳就永远不进 current 视图）。 */
async function parsedAndAdopted(
  text = LOCAL_RAW,
  mode = "local_model",
): Promise<{ recordId: string; revisionId: string; runId: string; effective: EffectiveResultDto }> {
  const { recordId, revisionId } = await makeRecord(text, mode);
  const parse = await call("POST", "/api/ingest/parse", { recordId });
  expect(parse.json.succeeded, parse.text).toBe(true);
  const adopt = await call("POST", "/api/ingest/adopt", { candidateRunId: parse.json.runId });
  expect(adopt.status, adopt.text).toBe(200);
  return { recordId, revisionId, runId: parse.json.runId as string, effective: await effectiveOf(revisionId) };
}

/**
 * 第二个 run：同一 revision、不同 `prompt_version` ⇒ 不同指纹 ⇒ 不同幂等键（任务书 §3.19 的
 * 「历次结果」在现实里就是这么产生的）。走的是真实 `IngestService.ingest`，不是手写 SQL 造行。
 */
async function secondRun(revisionId: string, promptVersion: string): Promise<string> {
  await ensureShared();
  const service = new IngestService({
    db: booted!.db,
    adapter: makeAdapter(),
    transport: stubTransport(OK_ENVELOPE(validOutput())).transport,
    systemPrompt: SYSTEM_PROMPT,
    now: () => new Date(FIXTURE_NOW),
    promptVersion,
  });
  const result = await service.ingest({ recordRevisionId: revisionId });
  expect(result.succeeded, "第二个 run 应当解析成功").toBe(true);
  return result.runId;
}

/** 递归收集一份 JSON 里出现过的所有对象键名（红线① 的直接扫描用）。 */
function jsonKeys(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) jsonKeys(item, out);
    return out;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out.push(key);
      jsonKeys(child, out);
    }
  }
  return out;
}

const LEAKY_KEYS = ["spans", "nonce", "redactionMap", "pipeline_manifest", "originalStart", "originalEnd"];

/* ════════════════════════════════════════════════════════════════════
 * A. §六 缺口清单 → op9 的扩集字段（逐项，用真实解析结果）
 * ════════════════════════════════════════════════════════════════════ */

describe("A. op9 可读扩集：§六 清单逐项（真 HTTP + 真解析）", () => {
  it("扩集十个字段一个不缺，且既有九个字段的名字与顺序逐字未动（G2 契约门）", async () => {
    const { effective } = await parsedAndAdopted();
    const keys = Object.keys(effective);
    expect(keys.slice(0, 9)).toEqual([
      "revisionId",
      "currentRunId",
      "episodes",
      "thoughts",
      "emotions",
      "topics",
      "entities",
      "candidates",
      "overrides",
    ]);
    for (const added of [
      "episodeItems",
      "thoughtItemItems",
      "emotionItems",
      "topicItems",
      "entityItems",
      "conceptTargets",
      "entityTargets",
      "suggestionItems",
      "aiTitle",
      "aiSummary",
      "runHistory",
    ]) {
      expect(keys, `扩集字段 ${added} 缺席`).toContain(added);
    }
  });

  it("经历：summary / 生命周期 / originType / evidence / event_time 三件，且与 episodes 同一集合", async () => {
    const { effective } = await parsedAndAdopted();
    expect(effective.episodeItems).toBeDefined();
    expect([...effective.episodes].sort()).toEqual(effective.episodeItems!.map((x) => x.id).sort());
    const item = effective.episodeItems![0]!;
    expect(item.summary).toBe("和项目组的同事讨论发布计划");
    expect(item.lifecycleStatus).toBe("active");
    expect(item.originType).toBe("ai_generated");
    expect(item.eventTimeRaw).toBe("今天");
    expect(item.eventTimePrecision).toBe("day");
    expect(item.eventTimeCertainty).toBe("explicit");
    expect(item.evidence.text).toBe("讨论了发布计划");
    expect(item.evidence.anchored).toBe(true);
    expect(LOCAL_RAW.slice(item.evidence.start!, item.evidence.end!)).toBe(item.evidence.text);
  });

  it("念头：text / 生命周期 / originType / evidence，且与 thoughts 同一集合", async () => {
    const { effective } = await parsedAndAdopted();
    expect([...effective.thoughts].sort()).toEqual(effective.thoughtItemItems!.map((x) => x.id).sort());
    const item = effective.thoughtItemItems![0]!;
    expect(item.text).toBe("发布计划需要提前定稿");
    expect(item.originType).toBe("ai_generated");
    expect(item.evidence.text).toBe("讨论了发布计划");
  });

  it("提及五件共同项：词面 / 依据 / 状态 / 来源容器 / 证据（§六 第一条）", async () => {
    const { effective, revisionId } = await parsedAndAdopted();
    expect([...effective.emotions].sort()).toEqual(effective.emotionItems!.map((x) => x.id).sort());
    const mention = effective.emotionItems![0]!;
    expect(mention.labelSaid).toBe("焦虑");
    expect(mention.basis).toBe("explicit");
    expect(mention.status).toBe("active");
    // AI 生成的提及挂在 revision 上（写路径 insert 里 episode/thought 两列恒 NULL）。
    expect(mention.source.kind).toBe("record_revision");
    expect(mention.source.containerId).toBe(revisionId);
    expect(ENUM_VALUES.mentionSourceKinds).toContain(mention.source.kind);
    expect(mention.evidence.text).toBe("我感到焦虑");
  });

  it("情绪另需 intensity 与「是不是用户改的」：库里写了 user 来源才报 true（§3.14 K-19）", async () => {
    const { effective, revisionId } = await parsedAndAdopted();
    const mention = effective.emotionItems![0]!;
    // 模型没给强度：null，且没被用户改过。
    expect(mention.intensity).toBeNull();
    expect(mention.intensityModifiedByUser).toBe(false);

    // 库里 `intensity_source` 只可能为 'user' 或空（0003:383），写它 = 用户自己动过强度。
    booted!.db
      .prepare("update emotion_mention set intensity = ?, intensity_source = ? where id = ?")
      .run(4, "user", mention.id);

    const after = await effectiveOf(revisionId);
    const updated = after.emotionItems!.find((x) => x.id === mention.id)!;
    expect(updated.intensity).toBe(4);
    expect(updated.intensityModifiedByUser).toBe(true);
  });

  it("实体另需 role：库里没写就是 null，写了就原样带出（B2/I5 可空自由文本）", async () => {
    const { recordId, revisionId } = await makeRecord(LOCAL_RAW, "local_model");
    // 先让「项目组」成为一个可解析的实体（RED-1 的应用内通道，不手写 entity 行）。
    const confirm = await call("POST", "/api/ingest/confirm-candidates", {
      recordId,
      adopted: [{ term: "项目组", kind: "organization" }],
    });
    expect(confirm.status, confirm.text).toBe(201);

    const parse = await call("POST", "/api/ingest/parse", { recordId });
    expect(parse.json.succeeded).toBe(true);
    const adopt = await call("POST", "/api/ingest/adopt", { candidateRunId: parse.json.runId });
    expect(adopt.status).toBe(200);

    const before = await effectiveOf(revisionId);
    const mention = before.entityItems!.find((x) => x.labelSaid === "项目组");
    expect(mention, "解析出的实体提及应当可见").toBeDefined();
    expect(mention!.role).toBeNull();

    booted!.db.prepare("update entity_mention set role = ? where id = ?").run("对话方", mention!.id);
    const after = await effectiveOf(revisionId);
    expect(after.entityItems!.find((x) => x.id === mention!.id)!.role).toBe("对话方");
  });

  it("概念与实体 targets 与连接键闭环：提及指向的目标必在 targets 里（§六 概念/实体两条）", async () => {
    const { effective } = await parsedAndAdopted();
    const conceptIds = new Set(effective.conceptTargets!.map((x) => x.id));
    for (const mention of [...effective.emotionItems!, ...effective.topicItems!]) {
      expect(conceptIds.has(mention.conceptId), `概念 ${mention.conceptId} 没被返回`).toBe(true);
    }
    const anxiety = effective.conceptTargets!.find((x) => x.canonicalName === "焦虑")!;
    expect(anxiety.conceptType).toBe("emotion");
    expect(ENUM_VALUES.conceptLifecycle).toContain(anxiety.lifecycleStatus);
    expect(ANXIETY_NAME_IN_TARGETS(effective)).toBe(true);

    const entityIds = new Set(effective.entityTargets!.map((x) => x.id));
    for (const mention of effective.entityItems!) {
      expect(entityIds.has(mention.entityId), `实体 ${mention.entityId} 没被返回`).toBe(true);
    }
    for (const target of effective.entityTargets!) {
      expect(target.displayName).not.toBe("");
      expect(target.canonicalName).not.toBe("");
      expect(ENUM_VALUES.entityTypes).toContain(target.entityType);
      expect(ENUM_VALUES.entityLifecycle).toContain(target.lifecycleStatus);
    }
  });

  it("建议：kind / subjectTerm / status / displayNote / evidence（§六 第四条，用真实的 new_concept）", async () => {
    // 未登记的词面 ⇒ 解析器第三步落 `new_concept` 建议（resolver.ts:118）。
    const { effective } = await parsedAndAdopted();
    const suggestions = effective.suggestionItems!;
    expect(suggestions.length, "local_model 这一趟本就没有新概念建议").toBe(0);

    const { recordId, revisionId } = await makeRecord(LOCAL_RAW, "local_model");
    currentOutput = () => {
      const output = validOutput();
      output.emotions = [
        { ...output.emotions[0]!, labelSaid: "内耗", candidateConceptId: null },
      ] as typeof output.emotions;
      return output;
    };
    const parse = await call("POST", "/api/ingest/parse", { recordId });
    expect(parse.json.succeeded, parse.text).toBe(true);
    currentOutput = () => validOutput();

    const seen = await effectiveOf(revisionId);
    // 建议挂在 run 上（run 还是 candidate）：`suggestionsForRevision` 不按结果态过滤——
    // 这正是「待确认」页要按状态分组的理由（§3.7 的 current 例外）。
    const fresh = seen.suggestionItems!.find((x) => x.subjectTerm === "内耗");
    expect(fresh, "新概念的候选建议应当出现在这一版的有效结果里").toBeDefined();
    expect(fresh!.kind).toBe("new_concept");
    expect(fresh!.status).toBe("pending");
    expect(ENUM_VALUES.suggestionKinds).toContain(fresh!.kind);
    expect(ENUM_VALUES.suggestionStatus).toContain(fresh!.status);
    expect(fresh!.displayNote).toBeNull();
    expect(fresh!.evidence).toBeNull();
  });

  it("结果的整体信息事后取回：aiTitle / aiSummary == 发起那一次返回的那两份（§六 第六条）", async () => {
    const { recordId, revisionId } = await makeRecord(LOCAL_RAW, "local_model");
    const parse = await call("POST", "/api/ingest/parse", { recordId });
    expect(parse.json.succeeded, parse.text).toBe(true);
    expect(parse.json.title).toBe("关于发布计划的讨论");

    const adopt = await call("POST", "/api/ingest/adopt", { candidateRunId: parse.json.runId });
    expect(adopt.status).toBe(200);

    const effective = await effectiveOf(revisionId);
    expect(effective.aiTitle).toBe(parse.json.title);
    expect(effective.aiSummary).toBe(parse.json.summary);
  });

  it("历次结果：runHistory 带出该 revision 的**全部** run（含已被取代的那一条），字段齐", async () => {
    const seeded = await parsedAndAdopted();
    const firstRunId = seeded.runId;
    const secondRunId = await secondRun(seeded.revisionId, "m3-proj1-prompt-v2");
    const adopt = await call("POST", "/api/ingest/adopt", { candidateRunId: secondRunId });
    expect(adopt.status, adopt.text).toBe(200);
    expect(adopt.json.supersededRunId).toBe(firstRunId);

    const effective = await effectiveOf(seeded.revisionId);
    const history = effective.runHistory!;
    const byId = new Map(history.map((row) => [row.runId, row]));
    expect(byId.has(firstRunId), "历次结果里没有那条已被取代的 run").toBe(true);
    expect(byId.has(secondRunId)).toBe(true);
    expect(byId.get(firstRunId)!.resultState).toBe("superseded");
    expect(byId.get(secondRunId)!.resultState).toBe("current");
    for (const row of history) {
      expect(row.executionStatus).toBe("succeeded");
      expect(row.errorKind).toBeNull();
      expect(row.aiTitle).toBe("关于发布计划的讨论");
      expect(row.aiSummary).not.toBe("");
      expect(row.startedAtUtc).toMatch(/Z$/);
      expect(row.finishedAtUtc).toMatch(/Z$/);
    }
    // runHistory 的条数 == 库里该 revision 的 run 条数：没有按结果态偷偷筛掉谁。
    const dbCount = booted!.db
      .prepare("select count(*) as n from parse_run where source_revision_id = ?")
      .get(seeded.revisionId) as { n: number };
    expect(history.length).toBe(dbCount.n);
  });

  it("修正层合流：override 改过的值出现在可读行里，集合本身不变（ADR-011）", async () => {
    const { effective, revisionId } = await parsedAndAdopted();
    const episodeId = effective.episodes[0]!;
    booted!.workspace.corrections.setOverride({
      objectTable: "episode",
      objectId: episodeId,
      fieldName: "summary",
      valueJson: JSON.stringify("我自己写的摘要"),
    });

    const after = await effectiveOf(revisionId);
    expect(after.overrides).toHaveLength(1);
    expect(after.episodeItems!.find((x) => x.id === episodeId)!.summary).toBe("我自己写的摘要");
    expect([...after.episodes].sort()).toEqual([...effective.episodes].sort());
  });
});

/** targets 里能找到「焦虑」这一条（拼错连接键时它会缺席）。 */
function ANXIETY_NAME_IN_TARGETS(effective: EffectiveResultDto): boolean {
  return effective.conceptTargets!.some((x) => x.canonicalName === "焦虑");
}

/* ════════════════════════════════════════════════════════════════════
 * B. 口径唯一：可读层与 currentView 得说同一套话
 * ════════════════════════════════════════════════════════════════════ */

describe("B. 同一口径：readableView 的集合 == currentView 的集合", () => {
  it("五类集合逐一相等（可读层不另立可见性判断）", async () => {
    const { revisionId } = await parsedAndAdopted();
    await ensureShared();
    const service = booted!.workspace.makeIngestService()!;
    const view = service.currentView(revisionId);
    const readable = service.readableView(revisionId);

    expect(readable.revisionId).toBe(view.revisionId);
    expect(readable.currentRunId).toBe(view.currentRunId);
    expect(readable.episodes).toEqual(view.episodes);
    expect(readable.thoughts).toEqual(view.thoughts);
    expect(readable.emotions).toEqual(view.emotions);
    expect(readable.topics).toEqual(view.topics);
    expect(readable.entities).toEqual(view.entities);
    expect(readable.candidates).toEqual(view.candidates);

    expect(readable.episodeItems.map((x) => x.id).sort()).toEqual([...view.episodes].sort());
    expect(readable.thoughtItems.map((x) => x.id).sort()).toEqual([...view.thoughts].sort());
    expect(readable.emotionItems.map((x) => x.id).sort()).toEqual([...view.emotions].sort());
    expect(readable.topicItems.map((x) => x.id).sort()).toEqual([...view.topics].sort());
    expect(readable.entityItems.map((x) => x.id).sort()).toEqual([...view.entities].sort());
  });

  it("候选没采纳时两侧一样读不到（「列表数得出、点进去看不到」在结构上不可能）", async () => {
    const { recordId, revisionId } = await makeRecord(LOCAL_RAW, "local_model");
    const ok = await call("POST", "/api/ingest/parse", { recordId });
    expect(ok.json.succeeded, ok.text).toBe(true);

    const effective = await effectiveOf(revisionId);
    expect(effective.currentRunId).toBeNull();
    expect(effective.episodes).toHaveLength(0);
    expect(effective.episodeItems).toHaveLength(0);
    expect(effective.emotionItems).toHaveLength(0);
    expect(effective.candidates).toHaveLength(1); // 候选在册，等用户表态
    expect(effective.runHistory).toHaveLength(1); // 历次结果里看得见它（不是影子）
    // 「当前结果的标题」跟着 current 走：没采纳就没有当前标题，空串而不是拿候选冒充。
    // 候选那份标题在它自己的 `runHistory` 行里，一页都不少。
    expect(effective.aiTitle).toBe("");
    expect(effective.runHistory![0]!.aiTitle).toBe("关于发布计划的讨论");
    expect(effective.runHistory![0]!.resultState).toBe("candidate");
  });
});

/* ════════════════════════════════════════════════════════════════════
 * C. 采纳 / 放弃：本轮补的两条对外路由与错误面
 * ════════════════════════════════════════════════════════════════════ */

describe("C. /api/ingest/adopt 与 /api/ingest/discard", () => {
  it("采纳 200：candidate→current，旧 current 转 superseded，返回两个 id", async () => {
    const { revisionId } = await parsedAndAdopted();
    const secondRunId = await secondRun(revisionId, "m3-proj1-prompt-v3");
    const adopt = await call("POST", "/api/ingest/adopt", { candidateRunId: secondRunId });
    expect(adopt.status).toBe(200);
    expect(adopt.json.adoptedRunId).toBe(secondRunId);
    expect(adopt.json.supersededRunId).not.toBeNull();
    const effective = await effectiveOf(revisionId);
    expect(effective.currentRunId).toBe(secondRunId);
  });

  it("放弃 200：candidate→superseded，原文与派生行一根毛都没动（§4.7b 不是删除）", async () => {
    const { recordId, revisionId } = await makeRecord(LOCAL_RAW, "local_model");
    const parse = await call("POST", "/api/ingest/parse", { recordId });
    const runId = parse.json.runId as string;

    const episodes = booted!.db
      .prepare("select count(*) as n from episode where parse_run_id = ?")
      .get(runId) as { n: number };
    expect(episodes.n).toBeGreaterThan(0);
    const rawTextBefore = booted!.db
      .prepare("select raw_text as t from record_revision where id = ?")
      .get(revisionId) as { t: string };

    const discard = await call("POST", "/api/ingest/discard", { candidateRunId: runId });
    expect(discard.status, discard.text).toBe(200);
    expect(discard.json).toEqual({ discardedRunId: runId });

    expect(
      booted!.db.prepare("select result_state as s from parse_run where id = ?").get(runId) as { s: string },
    ).toEqual({ s: "superseded" });
    expect(
      booted!.db.prepare("select count(*) as n from episode where parse_run_id = ?").get(runId) as { n: number },
    ).toEqual(episodes);
    const rawTextAfter = booted!.db
      .prepare("select raw_text as t from record_revision where id = ?")
      .get(revisionId) as { t: string };
    expect(rawTextAfter.t).toBe(rawTextBefore.t);

    const effective = await effectiveOf(revisionId);
    expect(effective.currentRunId).toBeNull();
    expect(effective.episodes).toHaveLength(0);
    expect(effective.runHistory!.find((x) => x.runId === runId)!.resultState).toBe("superseded");
  });

  it("错误面四类可自动化区分：400 / 404 / 409（放弃再放弃、采纳已采纳的都撞门）", async () => {
    const { recordId } = await makeRecord(LOCAL_RAW, "local_model");
    const parse = await call("POST", "/api/ingest/parse", { recordId });
    const runId = parse.json.runId as string;

    const badBody = await call("POST", "/api/ingest/adopt", { candidateRunId: 123 });
    expect(badBody.status).toBe(400);
    const missingBody = await call("POST", "/api/ingest/discard", {});
    expect(missingBody.status).toBe(400);

    const missing = await call("POST", "/api/ingest/adopt", { candidateRunId: "run_不存在" });
    expect(missing.status).toBe(404);
    expect(missing.json.error).toBe("not_found");
    const missingDiscard = await call("POST", "/api/ingest/discard", { candidateRunId: "run_不存在" });
    expect(missingDiscard.status).toBe(404);

    const adopt = await call("POST", "/api/ingest/adopt", { candidateRunId: runId });
    expect(adopt.status).toBe(200);
    const again = await call("POST", "/api/ingest/adopt", { candidateRunId: runId });
    expect(again.status).toBe(409);
    expect(again.json.error).toBe("state_conflict");
    // 已经 current 的 run 也不许被「放弃」：那会把当前事实抹掉，语义上根本是另一件事。
    const discardCurrent = await call("POST", "/api/ingest/discard", { candidateRunId: runId });
    expect(discardCurrent.status).toBe(409);
    expect(discardCurrent.json.error).toBe("state_conflict");
  });

  it("解析能力未就绪 ⇒ 三条读/写面一律 503 ingest_unavailable（不拿半套配置假装能读）", async () => {
    // 独立的第二个实例：不带 ingestProvider。用完当场拆，不与共用实例互踩。
    const solo = makeSandbox("tb-m3-proj1-offline-");
    const port = await testPort();
    writePort(solo.layout, port);
    const instance = await boot({ env: { TB_DATA_DIR: solo.root }, log: () => {} });
    try {
      const root = `http://127.0.0.1:${port}`;
      const effective = await fetch(`${root}/api/ingest/effective/rev_不存在`);
      expect(effective.status).toBe(503);
      expect(await errorKindOf(effective)).toBe("ingest_unavailable");
      for (const path of ["/api/ingest/adopt", "/api/ingest/discard"]) {
        const res = await fetch(`${root}${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ candidateRunId: "run_不存在" }),
        });
        expect(res.status, path).toBe(503);
        expect(await errorKindOf(res), path).toBe("ingest_unavailable");
      }
    } finally {
      await shutdown(instance);
      solo.cleanup();
    }
  });
});

/* ════════════════════════════════════════════════════════════════════
 * D. 红线①：redactionMap 绝不出现在任何 DTO / 路由返回
 * ════════════════════════════════════════════════════════════════════ */

describe("D. 红线①：pipeline_manifest 物理跳过（云端映射真在库里）", () => {
  const CLOUD_TEXT = "联系我 13800138000 或 zhang@example.com 详谈";

  it("正控制：这一趟的 run 行里 redactionMap 确实是填满的映射本体（否则下面那几条是空转）", async () => {
    const { recordId, revisionId } = await makeRecord(CLOUD_TEXT, "cloud_redacted");
    const preview = await call("POST", "/api/ingest/preview", { recordId });
    expect(preview.status, preview.text).toBe(200);
    // 占位符形态与 `redaction.ts:223` 的生成式同形：`[kind_序号_nonce]`。
    const placeholders = String(preview.json.payloadText).match(/\[[a-z][a-z0-9_]*_\d+_[^\]\s]+\]/g) ?? [];
    expect(placeholders.length, preview.json.payloadText).toBeGreaterThan(0);

    currentOutput = () => cloudishOutput(placeholders);
    const confirm = await call("POST", "/api/ingest/confirm-send", { recordId });
    expect(confirm.status, confirm.text).toBe(201);
    const parse = await call("POST", "/api/ingest/parse", { recordId });
    expect(parse.json.succeeded, parse.text).toBe(true);

    const run = booted!.db
      .prepare("select pipeline_manifest as m from parse_run where id = ?")
      .get(parse.json.runId) as { m: string };
    // 映射本体带着**区间与一次性随机量**：这条列就是红线① 要物理跳过的那一份。
    expect(run.m).toContain('"redactionMap"');
    expect(run.m).toContain('"spans"');
    expect(run.m).toContain('"nonce"');
    expect(run.m).toContain('"originalStart"');
    expect(run.m).toContain(placeholders[0]!); // 非空壳：这一条 span 真的在里面
    // 映射存的是 kind + 偏移 + 占位符（`redactionMapJsonValue`），不含原文词面 ——
    // 所以红线① 的探测器按**结构键名**扫，词面那一侧归红线② 管。
    expect(run.m).not.toContain("13800138000");

    const adopt = await call("POST", "/api/ingest/adopt", { candidateRunId: parse.json.runId });
    expect(adopt.status).toBe(200);

    const effective = await call("GET", `/api/ingest/effective/${revisionId}`);
    expect(effective.status).toBe(200);

    const discard = await call("POST", "/api/ingest/discard", { candidateRunId: parse.json.runId });
    expect(discard.status).toBe(409); // 它已经 current，放弃被拒——但拒绝面同样不许吐映射

    // 「泄露面」的定义是**结构**：映射的 spans / nonce / 原文侧偏移，一个键名都不许出现在对外面。
    // 词面那一侧归红线② 管（本地 /api 明令允许带 evidence_text，不许误豁免也不许误扩）。
    const expectNoMap = (res: ApiResult, where: string): void => {
      for (const key of LEAKY_KEYS) {
        expect(res.text, `${where} 响应里出现了 "${key}"`).not.toContain(`"${key}"`);
      }
      expect(res.text, `${where} 响应里出现了 map 键`).not.toContain('"map"');
      expect(jsonKeys(res.json).some((k) => LEAKY_KEYS.includes(k)), `${where} 递归键名里有映射结构`).toBe(false);
    };
    expectNoMap(effective, "op9");
    expectNoMap(adopt, "adopt");
    expectNoMap(discard, "discard");
  });

  it("源码面：历次结果用显式列名查询，`select *` 不在这一层出现", () => {
    const service = readFileSync(join(SERVER_DIR, "ingest", "ingestService.ts"), "utf8");
    expect(service).toContain("select id, result_state, execution_status, error_kind, ai_title, ai_summary,");
    expect(service).not.toContain("select * from parse_run");
    expect(service).not.toContain("select * from episode");
    expect(service).not.toContain("select * from emotion_mention");
  });
});

/** 云端合法回稿：证据引用占位符本体（`[phone_1_ab12cd]` 那种），映射后才落回原文坐标。 */
function cloudishOutput(placeholders: readonly string[]): StructuredOutput {
  const phone = placeholders[0] ?? "[phone_1_a1b2c3]";
  const output = validOutput();
  return {
    ...output,
    title: "一次联络安排",
    summary: `通过 ${phone} 联络`,
    episodes: [{ ...output.episodes[0]!, summary: "约定联络方式", evidence: "详谈" }],
    thoughts: [{ text: "电话比邮件直接", evidence: "联系我" }],
    emotions: [{ ...output.emotions[0]!, evidence: "详谈" }],
    topics: [{ ...output.topics[0]!, evidence: "详谈" }],
    entities: [{ labelSaid: phone, candidateConceptId: null, basis: "explicit", evidence: phone }],
  } as unknown as StructuredOutput;
}

/* ════════════════════════════════════════════════════════════════════
 * E. 红线②：先例的边界——别误扩（词面照样走本地 /api），也别误豁免（collisions 照旧不外发）
 * ════════════════════════════════════════════════════════════════════ */

describe("E. 红线②：ingestRoutes 那条先例只管 collisions", () => {
  it("不误扩：op9 带着 labelSaid 与 evidence_text（把它们抹掉就是把可读投影做回 id 数组）", async () => {
    const { effective } = await parsedAndAdopted();
    expect(effective.emotionItems![0]!.labelSaid).toBe("焦虑");
    expect(effective.emotionItems![0]!.evidence.text).toBe("我感到焦虑");
    expect(effective.episodeItems![0]!.evidence.text).toContain("发布计划");
  });

  it("不误豁免：解析响应的 collisions 一个都没对外（词面可能等于人名）", async () => {
    const { recordId } = await makeRecord(LOCAL_RAW, "local_model");
    const parse = await call("POST", "/api/ingest/parse", { recordId });
    expect(parse.status).toBe(200);
    expect(parse.text).not.toContain('"collisions"');
    expect(Object.keys(parse.json)).not.toContain("collisions");
    // 同一条先例的服务内面仍在（诊断留在服务与 Trace）：注释与实现得对得上。
    const routes = readFileSync(join(SERVER_DIR, "api", "ingestRoutes.ts"), "utf8");
    expect(routes).toContain("collisions 含建议词面");
  });
});

/* ════════════════════════════════════════════════════════════════════
 * F. 红线③：前后端单轨 + 假侧诚实语义维持
 * ════════════════════════════════════════════════════════════════════ */

describe("F. 红线③：一份 DTO，两个数据源，假侧不冒充就绪", () => {
  it("fakeApi 的 effective 返回值 satisfies 扩后的 DTO（单轨，编译期就钉住）", () => {
    const fake = webSource("fakeApi.ts");
    expect(fake).toContain("satisfies EffectiveResultDto");
    expect(fake).toContain("ingestReady: false"); // dev 入口仍走「解析未就绪」那条诚实路径
  });

  it("假侧那一份返回里十个可读字段一个都不填：没有 ≠ 空，假数据不冒充可读投影", () => {
    const fake = webSource("fakeApi.ts");
    const body = fake.slice(fake.indexOf("function effectiveBody"), fake.indexOf("function searchBody"));
    for (const added of ["emotionItems", "topicItems", "entityItems", "runHistory", "aiTitle", "aiSummary"]) {
      expect(body, `假侧不该自己填 ${added}`).not.toContain(added);
    }
    expect(body).toContain("currentRunId: null");
    // 消费面对「没有」的反应是诚实空态，而不是零行冒充「确实没有内容」。
    const legacyOnly: EffectiveResultDto = JSON.parse(
      JSON.stringify({
        revisionId: "rev_x",
        currentRunId: null,
        episodes: [],
        thoughts: [],
        emotions: [],
        topics: [],
        entities: [],
        candidates: [],
        overrides: [],
      }),
    ) as EffectiveResultDto;
    expect(readableResult(legacyOnly)).toEqual([]);
    const empty = productBoxPage([{ record: fakeRecord("rec_x"), effective: legacyOnly }], "emotions");
    expect(empty.groups[0]!.rows).toHaveLength(0);
    expect(empty.counts[0]).toBe("0");
  });

  it("apiClient 不重 declare 形状：返回类型全部来自 shared/dto（服务端与假侧同一个类型）", () => {
    const client = webSource("apiClient.ts");
    expect(client).toContain("request<EffectiveResultDto>");
    expect(client).toContain("jsonCall<AdoptRunResultDto>");
    expect(client).toContain("jsonCall<DiscardRunResultDto>");
    expect(client).not.toContain("interface EffectiveResultDto");
    const shared = readFileSync(join(process.cwd(), "src", "shared", "dto.ts"), "utf8");
    expect(shared).toContain("export interface DiscardRunResultDto");
  });
});

/* ════════════════════════════════════════════════════════════════════
 * G. 纯映射层：与形状表/标签表对齐（盒子五页 + 记录详情）
 * ════════════════════════════════════════════════════════════════════ */

const PROJ_RAW = "今天和项目组的同事讨论了发布计划，我感到焦虑";

function evid(text: string): EffectiveEvidenceDto {
  const start = PROJ_RAW.indexOf(text);
  return {
    text,
    start: start < 0 ? null : start,
    end: start < 0 ? null : start + text.length,
    anchored: start >= 0,
  };
}

function fakeRecord(id: string, date = "2026-10-17"): RecordRow {
  return {
    id,
    created_at_utc: `${date}T02:00:00.000Z`,
    created_at_local: `${date}T10:00:00.000+08:00`,
    timezone_id: "Asia/Shanghai",
    created_local_date: date,
    current_revision_id: `rev_of_${id}`,
    processing_status: "parsed",
    processing_mode: "local_model",
    privacy_level: "normal",
  };
}

function entry(id: string, effective: EffectiveResultDto, date = "2026-10-17"): EffectiveEntry {
  return { record: fakeRecord(`rec_${id}`, date), effective };
}

function baseEffective(patch: Partial<EffectiveResultDto> = {}): EffectiveResultDto {
  return {
    revisionId: "rev_of_rec_a",
    currentRunId: "run_A1",
    episodes: ["epi_A1111"],
    thoughts: ["tht_A2222"],
    emotions: ["csm_A3333"],
    topics: ["tpc_A4444"],
    entities: ["enm_A5555"],
    candidates: [],
    overrides: [],
    episodeItems: [
      {
        id: "epi_A1111",
        summary: "和项目组的同事讨论发布计划",
        lifecycleStatus: "active",
        originType: "ai_generated",
        evidence: evid("讨论了发布计划"),
        eventTimeRaw: "今天",
        eventTimePrecision: "day",
        eventTimeCertainty: "explicit",
      },
    ],
    thoughtItemItems: [
      {
        id: "tht_A2222",
        text: "发布计划需要提前定稿",
        lifecycleStatus: "active",
        originType: "ai_generated",
        evidence: evid("讨论了发布计划"),
      },
    ],
    emotionItems: [
      {
        id: "csm_A3333",
        conceptId: "con_A6666",
        labelSaid: "焦虑",
        basis: "explicit",
        status: "active",
        source: { kind: "record_revision", containerId: "rev_of_rec_a" },
        evidence: evid("我感到焦虑"),
        intensity: null,
        intensityModifiedByUser: false,
      },
    ],
    topicItems: [
      {
        id: "tpc_A4444",
        conceptId: "con_A7777",
        labelSaid: "工作",
        basis: "inferred",
        status: "active",
        source: { kind: "thought_item", containerId: "tht_A2222" },
        evidence: evid("讨论了发布计划"),
      },
    ],
    entityItems: [
      {
        id: "enm_A5555",
        entityId: "ent_A8888",
        labelSaid: "项目组",
        basis: "explicit",
        status: "active",
        source: { kind: "record_revision", containerId: "rev_of_rec_a" },
        evidence: evid("和项目组的同事"),
        role: null,
      },
    ],
    conceptTargets: [
      { id: "con_A6666", canonicalName: "焦虑", conceptType: "emotion", lifecycleStatus: "active" },
      { id: "con_A7777", canonicalName: "工作与职场", conceptType: "topic", lifecycleStatus: "active" },
    ],
    entityTargets: [
      {
        id: "ent_A8888",
        canonicalName: "项目组",
        displayName: "项目组",
        entityType: "organization",
        lifecycleStatus: "provisional",
      },
    ],
    suggestionItems: [
      {
        id: "sug_A9999",
        kind: "new_concept",
        subjectTerm: "内耗",
        status: "pending",
        displayNote: null,
        evidence: null,
      },
    ],
    aiTitle: "关于发布计划的讨论",
    aiSummary: "记录了一次发布计划讨论，当事人表达了焦虑",
    runHistory: [
      {
        runId: "run_A1",
        resultState: "current",
        executionStatus: "succeeded",
        errorKind: null,
        aiTitle: "关于发布计划的讨论",
        aiSummary: "记录了一次发布计划讨论，当事人表达了焦虑",
        startedAtUtc: "2026-10-17T02:00:00.000Z",
        finishedAtUtc: "2026-10-17T02:00:01.000Z",
      },
    ],
    ...patch,
  };
}

const INTERNAL_IDS = [
  "epi_A1111",
  "tht_A2222",
  "csm_A3333",
  "tpc_A4444",
  "enm_A5555",
  "con_A6666",
  "con_A7777",
  "ent_A8888",
  "sug_A9999",
  "rec_a",
  "run_A1",
];

/** 界面上会出现的全部文字（`PortRow.id` 只当 React key 与选中态用，不是显示量）。 */
function visibleText(row: PortRow): string {
  const blocks = row.detail.map((block) =>
    [
      block.title,
      ...(block.badges ?? []).map((badge) => badge.label),
      ...block.fields.map((pair) => `${pair[0]}\n${pair[1]}`),
      block.citation?.evidence?.text ?? "",
    ].join("\n"),
  );
  return `${row.title}\n${row.meta}\n${blocks.join("\n")}`;
}

describe("G. productBoxPage / productSuggestions：与形状表同一套口径", () => {
  const twoEntries: readonly EffectiveEntry[] = [
    entry("a", baseEffective()),
    entry(
      "b",
      baseEffective({
        emotionItems: [
          {
            id: "csm_B3333",
            conceptId: "con_A6666",
            labelSaid: "有点焦虑",
            basis: "inferred",
            status: "active",
            source: { kind: "episode", containerId: "epi_A1111" },
            evidence: { text: "焦虑", start: null, end: null, anchored: false },
            intensity: 3,
            intensityModifiedByUser: true,
          },
        ],
        topicItems: [],
        thoughtItemItems: [],
        entityItems: [],
        suggestionItems: [],
      }),
      "2026-10-16",
    ),
  ];

  it("五页的 counts 位数与分组数与形状表一位不差，表头逐位相等（BoxPanel 按表头找行）", () => {
    for (const shape of BOX_SHAPES) {
      const content = productBoxPage(twoEntries, shape.view);
      expect(content.counts, shape.view).toHaveLength(shape.counts.length);
      expect(content.groups, shape.view).toHaveLength(shape.groups.length);
      content.groups.forEach((group, index) => {
        expect(group.heading, `${shape.view} 第 ${index} 组表头`).toBe(shape.groups[index]!.heading);
      });
    }
  });

  it("答不出来的计数位填占位符，不填 0；那一组留空行，不画技术缺口（M5-3C）", () => {
    const emotions = productBoxPage(twoEntries, "emotions");
    expect(emotions.counts[1]).toBe(COUNT_PLACEHOLDER);
    // 旧断言要求这一组「给一行点名缺口」——那句话是发给开发者的，M5-3C 起退出用户可见路径。
    // 等价语义：这一组就是空的，而计数位仍是「—」（不是 0），「不知道」没有被说成「确实没有」。
    expect(emotions.groups[1]!.rows).toEqual([]);
    // 「数得出」的那些位必须是数字串——占位符只许出现在真答不出的那一格。
    expect(emotions.counts[0]).toBe("1"); // 出现过的概念：焦虑（两条提及同一个概念）
    expect(/^\d+$/.test(emotions.counts[0]!)).toBe(true);
    expect(emotions.counts[2]).toBe("2"); // 有效提及
    expect(emotions.counts[3]).toBe("1"); // 不上图：来源不是经历的那一条
  });

  it("五页的每一行可见文字都不含方案 C 层的工程缺口措辞（M5-3C）", () => {
    for (const shape of BOX_SHAPES) {
      const rows = productBoxPage(twoEntries, shape.view).groups.flatMap((group) => group.rows);
      expect(rows.length, `${shape.view} 这页在这份样本上没有可画的行，等于没验`).toBeGreaterThan(0);
      for (const row of rows) {
        const text = visibleText(row);
        for (const banned of ["这一组数不出来", "数不出来", "服务端没有", "端点", "全量清单", "缺口"]) {
          expect(text, `${shape.view} 的行「${row.title}」出现了「${banned}」`).not.toContain(banned);
        }
      }
    }
  });

  it("措辞一律经标签表：依据/状态/生命周期显示的是标签，不是契约原值也不是内部 id", () => {
    const emotions = productBoxPage(twoEntries, "emotions");
    const row = emotions.groups[0]!.rows[0]!;
    const text = visibleText(row);
    expect(text).toContain(BASIS_LABEL.explicit);
    expect(text).toContain(BASIS_LABEL.inferred);
    expect(text).toContain(MENTION_STATUS_LABEL.active);
    expect(text).toContain(CONCEPT_LIFECYCLE_LABEL.active);
    expect(text).toContain("焦虑");
    expect(text).toContain("「有点焦虑」"); // 词面与标准名同屏：用户才看得出模型改写了什么
    for (const id of INTERNAL_IDS) expect(text).not.toContain(id);
  });

  it("详情是结构化块：概念概览与每次提及分开，提及保留证据与来源记录", () => {
    const emotions = productBoxPage(twoEntries, "emotions");
    const row = emotions.groups[0]!.rows[0]!;
    const overview = row.detail[0]!;
    expect(overview.kind).toBe("fields");
    expect(overview.title).toBe("概念");
    expect(overview.fields.map(([label]) => label)).toEqual(["标准名", "生命周期"]);

    const mentions = row.detail.filter((block) => block.kind === "mention");
    expect(mentions).toHaveLength(2);
    expect(mentions[0]!.title).toContain("「");
    expect(mentions[0]!.badges?.map((badge) => badge.tone)).toEqual(["neutral", "basis", "status"]);
    expect(mentions[0]!.citation?.recordId).not.toBe("");
    expect(mentions[0]!.citation?.recordDate).not.toBe("");
    expect(mentions[0]!.citation?.evidence).not.toBeNull();
  });

  it("经历概览也带可回锚的引用，不再只把证据写成一句不可点的文字", () => {
    const episodes = productBoxPage(twoEntries, "episodes");
    const row = episodes.groups[0]!.rows[0];
    expect(row).toBeDefined();
    expect(row!.detail[0]!.citation?.recordId).not.toBe("");
    expect(row!.detail[0]!.citation?.evidence?.text).not.toBe("");
  });

  it("提及来源三档的键集合 == enums.json：契约加一档而这里没跟上就先红", () => {
    expect(Object.keys(MENTION_SOURCE_PHRASE).sort()).toEqual([...ENUM_VALUES.mentionSourceKinds].sort());
  });

  it("证据的三种真实情况各有说法：缺坐标 / 回锚失败 / 能点回原文", () => {
    expect(evidencePhrase(undefined)).toContain("没有证据");
    expect(evidencePhrase({ text: "", start: null, end: null, anchored: false })).toContain("没有证据文本");
    expect(evidencePhrase({ text: "焦虑", start: null, end: null, anchored: false })).toContain("点不回原文");
    expect(evidencePhrase({ text: "焦虑", start: 21, end: 23, anchored: false })).toContain("回锚失败");
    expect(evidencePhrase(evid("我感到焦虑"))).toContain("原文第 17–22 字");
  });

  it("经历页按精度分两组，只有能排进时间轴的那组收 day 精度（不靠字符串猜）", () => {
    const withUnknown = productBoxPage(
      [entry("a", baseEffective({
        episodeItems: [
          ...baseEffective().episodeItems!,
          {
            id: "epi_B0000",
            summary: "时间写不清楚的一条",
            lifecycleStatus: "active",
            originType: "user_created",
            evidence: evid("发布计划"),
            eventTimeRaw: null,
            eventTimePrecision: "unknown",
            eventTimeCertainty: "explicit",
          },
        ],
      }))],
      "episodes",
    );
    expect(withUnknown.counts[0]).toBe("2");
    expect(withUnknown.groups[0]!.rows).toHaveLength(1);
    expect(withUnknown.groups[1]!.rows).toHaveLength(1);
    expect(withUnknown.groups[1]!.rows[0]!.title).toBe("时间写不清楚的一条");
  });

  it("念头页把「挂着标签的」分出来：来源是念头的提及既不生成边也不生成影子节点，这页是它们唯一的家", () => {
    const thoughts = productBoxPage(twoEntries, "thoughts");
    expect(thoughts.groups[0]!.rows).toHaveLength(1); // tht_A2222 上挂着那条 inferred 主题
    expect(thoughts.groups[0]!.rows[0]!.meta).toContain("1 个标签");
    expect(visibleText(thoughts.groups[0]!.rows[0]!)).toContain("不上图");
    expect(thoughts.groups[1]!.rows).toHaveLength(0);
  });

  it("实体页按生命周期分三组，疑似同一实体的候选走建议那一组", () => {
    const entities = productBoxPage(twoEntries, "entities");
    expect(entities.groups[0]!.rows).toHaveLength(0); // active
    expect(entities.groups[1]!.rows).toHaveLength(1); // provisional：项目组
    expect(entities.groups[2]!.rows).toHaveLength(0); // archived
    expect(visibleText(entities.groups[1]!.rows[0]!)).toContain("项目组");
    const same = productBoxPage(
      [entry("a", baseEffective({
        suggestionItems: [
          { id: "sug_B1111", kind: "possibly_same_as", subjectTerm: "项目组", status: "pending", displayNote: null, evidence: null },
        ],
      }))],
      "entities",
    );
    expect(same.groups[3]!.rows).toHaveLength(1);
  });

  it("待确认页：counts 按状态键，total == 行数，行按 id 去重（同一条建议跨记录不重复列）", () => {
    const withDup = [
      entry("a", baseEffective()),
      entry("b", baseEffective({ suggestionItems: [{ id: "sug_A9999", kind: "new_concept", subjectTerm: "内耗", status: "pending", displayNote: null, evidence: null }] })),
    ];
    const content = productSuggestions(withDup);
    expect(content.total).toBe(1);
    expect(content.counts.pending).toBe(1);
    expect(content.rows[0]!.title).toContain("内耗");
    for (const id of INTERNAL_IDS) expect(visibleText(content.rows[0]!)).not.toContain(id);
  });

  it("记录详情的可读行：五类按顺序出现，空的类别不占位，且不印内部 id", () => {
    const groups = readableResult(baseEffective());
    expect(groups.map((g) => g.category)).toEqual(["经历", "念头", "情绪", "主题", "人物与事物"]);
    const emotion = groups.find((g) => g.category === "情绪")!.lines[0]!;
    expect(emotion.title).toBe("「焦虑」→ 焦虑");
    expect(emotion.meta).toContain(BASIS_LABEL.explicit);
    expect(emotion.evidence.text).toBe("我感到焦虑"); // 坐标原样带着：点回原文用它，不许界面自己 indexOf 猜
    for (const id of INTERNAL_IDS) {
      for (const group of groups) {
        for (const line of group.lines) expect(`${line.title}\n${line.meta}`).not.toContain(id);
      }
    }

    const onlyEpisodes = readableResult(baseEffective({ emotions: [], thoughtItemItems: [], emotionItems: [], topicItems: [], entityItems: [] }));
    expect(onlyEpisodes.map((g) => g.category)).toEqual(["经历"]);
  });

  it("形状表没这一页就不画（`boxShapeOf` 返回 null 的那些 view 不产内容）", () => {
    for (const view of ["today", "quick", "records", "suggestions", "graph"] as const) {
      expect(boxShapeOf(view)).toBeNull();
    }
  });
});

/* ════════════════════════════════════════════════════════════════════
 * H. 取数方式：N+1 已消 + 本轮不开 0008
 * ════════════════════════════════════════════════════════════════════ */

describe("H. 批量取数与「缺列即停」", () => {
  it("override 一次批量取（`object_id in (...)`），可读层每表一条 SQL", () => {
    const correction = readFileSync(join(SERVER_DIR, "correction", "service.ts"), "utf8");
    expect(correction).toContain("object_id in (");
    expect(correction).toContain("一次取齐多个对象的 override");
    const service = readFileSync(join(SERVER_DIR, "ingest", "ingestService.ts"), "utf8");
    expect(service).toContain("private rowsById<R>");
    expect(service).toContain("where id in (");
    expect(service).toContain("this.corrections.overridesByObject(");
  });

  it("op1 待整理列表的摘要走 `currentRawTexts` 一次取齐，不在循环里 getRecord（UI-3 存疑 2 的服务端那一半）", () => {
    const routes = readFileSync(join(SERVER_DIR, "api", "ingestRoutes.ts"), "utf8");
    expect(routes).toContain("currentRawTexts(");
    expect(routes).not.toMatch(/waiting[\s\S]{0,200}getRecord\(/);
    const records = readFileSync(join(SERVER_DIR, "records", "service.ts"), "utf8");
    expect(records).toContain("currentRawTexts(recordIds: readonly string[])");
  });

  it("真数据口的取法：翻页取完 + 每条一次 op9 并发发，单条失败不拖垮整页", () => {
    const port = webSource("productPort.ts");
    expect(port).toContain("Promise.all");
    expect(port).toContain("offset += PAGE_SIZE");
    expect(port).toContain("api.ingestEffective(");
    expect(port).toContain("UNREADY_DATA_PORT"); // enabled=false 时一个请求都不发（dev 假数据那一路）
    expect(port).toContain('["captured", "awaiting_privacy_review", "not_processed"]');
    // 盒子那两片仍然不许自己撞取数层（口径仍在 UI-4 那条断言里，这里补的是新文件）。
    for (const name of ["BoxPanel.tsx", "SuggestionsPanel.tsx"]) {
      expect(webSource(name)).not.toContain("apiClient");
      expect(webSource(name)).not.toContain("api.");
    }
  });

  it("本轮明令不开 0008：迁移目录停在 0007，缺的那一列（是否回锚成功）在投影里现算", () => {
    const files = readdirSync(MIGRATIONS).filter((name) => name.endsWith(".sql")).sort();
    expect(files.at(-1)!.startsWith("0007")).toBe(true);
    expect(files.some((name) => name.startsWith("0008"))).toBe(false);
    const service = readFileSync(join(SERVER_DIR, "ingest", "ingestService.ts"), "utf8");
    expect(service).toContain("rawText.slice(start, end) === text");
  });

  it("投影层保持纯函数：`projections.ts` 不引取数层、不发请求、没有本地状态", () => {
    const projections = webSource("projections.ts");
    expect(projections).not.toContain("apiClient");
    expect(projections).not.toContain("fetch(");
    expect(projections).not.toContain("useState");
    // 假数据那一层只许在**注释里**被提到（说清为什么不共用），不许进静态 import 闭包 ——
    // 引它等于把 `fixtures/` 本体拖进生产图（UI-5 那条会红的断言）。
    expect(projections).not.toMatch(/from\s+"[^"]*fixtures/);
  });
});
