/**
 * M10-2 专项测试：复核队列视图（只读派生）——执行准则 §五、裁决 M10-D-3。
 *
 * 这一批只新增一个**观测面**：`GET /api/ingest/review-queue`。断言因此围着五件事转：
 *  1. **只读**（C1，最重要）：调用前后 `capture_record` / `record_revision` / `cloud_send_grant` /
 *     `app_meta` 四张表整表逐字不变，Provider 传输的调用计数也不动。队列一旦去「补算一次」，
 *     它写的就是用户没看过的那份载荷，M10-3 的批量确认会照着它签发。
 *  2. **派生正确**（C2）：四条夹具（有载荷有授权 / 有载荷无授权 / 本档没跑成 / 从没预览过）
 *     各自的 `hasPayload` / `hasGrant` / `llm.*` 逐字对上。
 *  3. **排序**（C3）：「不确定顶上去」——没跑成 → 没载荷 → 没授权 → 同级按 `createdAtUtc` 倒序。
 *  4. **不泄漏**（C4）：响应里没有原文、没有词面、没有载荷文本，也没有 op1 那种前 80 字摘要。
 *  5. **不外发**（C6 + C1 的计数）：非外发轨记录压根不进队列，进队列的也不惊动任何模型。
 *
 * 前端那一侧（C5）走源码级：静态扫钉住「唯一收件箱在场、空态有一句话」与「一行只给一个下一步」
 * （动作文案收在 `inbox.ts`，来源统计不搬进收件箱），以及取数只在面板那一层。
 *
 * 全程离线：库只落 `TB_DATA_DIR` 沙箱；配置里不启用本地模型档 ⇒ 预跑队列拿到的适配器恒为 null，
 * 一个字节都不离开本机（C2 的本档状态由服务层入口直接摆好，不靠真模型）。
 */

import { createServer } from "node:net";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

import { afterAll, describe, expect, it } from "vitest";

import type { Database } from "../src/server/db/adapter.ts";
import { ensureConfigFile } from "../src/server/config/config.ts";
import type { DataLayout } from "../src/server/config/paths.ts";
import {
  LOCAL_LLM_POLICY_VERSION,
  RAW_SEND_POLICY_VERSION,
  REDACTION_POLICY_VERSION,
} from "../src/server/privacy/redaction.ts";
import type { ReviewQueueEntryDto, ReviewQueueResponse } from "../src/shared/dto.ts";
import { boot, shutdown, type BootResult } from "../src/server/runtime/bootstrap.ts";
import { OK_ENVELOPE, SYSTEM_PROMPT, makeAdapter, stubTransport, validOutput } from "./helpers/ingestFixtures.ts";
import { makeSandbox, type Sandbox } from "./helpers/sandbox.ts";

/* ── 夹具文本：一条含敏感人名与手机号，用作 C4 的哨兵 ─────────────── */

const SENTINEL = "张三的电话是13800138000，他说蓝山咖啡馆见";
const ZHANG = "张三";
const PHONE = "13800138000";
const CAFE = "蓝山咖啡馆";
const SECOND = "第二条要发脱敏版的内容，邮箱 a@example.com";
const THIRD = "这一条模型没跑成，用户看的是回落那份";
const FOURTH = "这一条从没预览过";
const RAW_TRACK = "这一条走原文轨，一个字都不遮";
const LOCAL_ONLY = "这一条只在本机整理，不外发";
const MANUAL = "这一条只保存在本机";
const ALL_FACES = [SENTINEL, SECOND, THIRD, FOURTH, RAW_TRACK, LOCAL_ONLY, MANUAL, ZHANG, PHONE, CAFE];

/** 本档的两条采信区间：坐标锚定 `SENTINEL` 的 UTF-16 偏移。 */
function llmSpans(): Array<{ kind: string; start: number; end: number; surface: string }> {
  const person = SENTINEL.indexOf(ZHANG);
  const place = SENTINEL.indexOf(CAFE);
  return [
    { kind: "person", start: person, end: person + ZHANG.length, surface: ZHANG },
    { kind: "place", start: place, end: place + CAFE.length, surface: CAFE },
  ];
}

/* ── 真 HTTP 面夹具（照 m10-1 的手法，只是不配本机模型） ──────────── */

const QUEUE_PATH = "/api/ingest/review-queue";

interface Instance {
  readonly booted: BootResult;
  readonly box: Sandbox;
  readonly base: string;
  readonly db: Database;
  readonly stub: ReturnType<typeof stubTransport>;
}

const liveInstances: Instance[] = [];

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (address === null || typeof address === "string") {
        reject(new Error("无法取得空闲端口"));
        return;
      }
      probe.close(() => resolve(address.port));
    });
  });
}

function writeConfig(layout: DataLayout, port: number): void {
  mkdirSync(layout.dataDir, { recursive: true });
  const file = ensureConfigFile(layout);
  const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  (raw.server as Record<string, unknown>).port = port;
  (raw.model as Record<string, unknown>).enabled = false;
  (raw.model as Record<string, unknown>).cloud_redacted_enabled = true;
  // 本地模型档**不配置**：预跑队列拿到的适配器恒为 null。少一个假端点，就少一处
  // 「测试自己骗自己说没发请求」；C2 要的本档状态由服务层入口摆好。
  writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
}

async function startInstance(): Promise<Instance> {
  const box = makeSandbox("tb-m10-2-");
  const port = await freePort();
  writeConfig(box.layout, port);
  const stub = stubTransport(OK_ENVELOPE(validOutput()));
  let booted: BootResult;
  try {
    booted = await boot({
      env: { TB_DATA_DIR: box.root, USERPROFILE: box.root, HOME: box.root },
      log: () => {},
      startJobsWorker: false,
      ingestProvider: { adapter: makeAdapter(), transport: stub.transport, systemPrompt: SYSTEM_PROMPT },
    });
  } catch (cause) {
    box.cleanup();
    throw cause;
  }
  const inst: Instance = { booted, box, base: `http://127.0.0.1:${port}`, db: booted.db, stub };
  liveInstances.push(inst);
  return inst;
}

afterAll(async () => {
  for (const inst of liveInstances) {
    await shutdown(inst.booted);
    inst.box.cleanup();
  }
  liveInstances.length = 0;
});

interface ApiResult {
  status: number;
  json: ReviewQueueResponse;
  text: string;
}

async function getQueue(inst: Instance): Promise<ApiResult> {
  const res = await fetch(`${inst.base}${QUEUE_PATH}`);
  const text = await res.text();
  return { status: res.status, json: JSON.parse(text) as ReviewQueueResponse, text };
}

/* ── 四张表的整表快照（C1 的唯一口径：行数与内容逐字） ────────────── */

const SNAPSHOT_TABLES = ["capture_record", "record_revision", "cloud_send_grant", "app_meta"] as const;

function snapshot(db: Database): Record<string, string> {
  const out: Record<string, string> = {};
  for (const table of SNAPSHOT_TABLES) {
    const rows = db.prepare(`select * from ${table} order by rowid`).all() as unknown[];
    out[table] = JSON.stringify(rows);
  }
  return out;
}

/* ── 夹具装配（整套用例共用一份：队列是只读的，没什么好重置的） ──── */

interface Fixture {
  readonly inst: Instance;
  /** ① 有载荷有授权（本档）② 有载荷无授权 ③ 预跑失败 ④ 从没预览过。 */
  readonly withGrantAndPayload: string;
  readonly withPayload: string;
  readonly consultFailed: string;
  readonly neverPreviewed: string;
  /** 原文轨且有授权（另一条腿的覆盖）。 */
  readonly rawWithGrant: string;
  /** 与 ② 同秩的第二条，倒序那一条断言要用。 */
  readonly withPayloadOlder: string;
  /** 两条非外发轨：只保存 / 只本机整理。 */
  readonly manualOnly: string;
  readonly localOnly: string;
}

function revisionOf(fx: Fixture, recordId: string): string {
  return fx.inst.booted.workspace.records.getRecord(recordId).record.current_revision_id;
}

async function buildFixture(): Promise<Fixture> {
  const inst = await startInstance();
  const { records, grants } = inst.booted.workspace;

  const make = (text: string, mode: string): string => records.createRecord(text, mode).record.id;
  const withGrantAndPayload = make(SENTINEL, "cloud_redacted");
  const withPayload = make(SECOND, "cloud_redacted");
  const consultFailed = make(THIRD, "cloud_redacted");
  const neverPreviewed = make(FOURTH, "cloud_redacted");
  const rawWithGrant = make(RAW_TRACK, "cloud_raw");
  const withPayloadOlder = make(`${SECOND}（副本）`, "cloud_redacted");
  const manualOnly = make(MANUAL, "manual_only");
  const localOnly = make(LOCAL_ONLY, "local_model");

  const fx: Fixture = {
    inst,
    withGrantAndPayload,
    withPayload,
    consultFailed,
    neverPreviewed,
    rawWithGrant,
    withPayloadOlder,
    manualOnly,
    localOnly,
  };

  // 两条本档记录：把 `redaction_mode` 换成 `local_llm`（走 M9-D-15 那条窄入口，只改这一列）。
  records.setRedactionMode(withGrantAndPayload, "local_llm");
  records.setRedactionMode(consultFailed, "local_llm");
  // A-0 起 cloud_redacted 默认 local_llm；② 要演的是「规则档有载荷、无人点头」，显式落回 manual。
  records.setRedactionMode(withPayload, "manual");
  records.setRedactionMode(withPayloadOlder, "manual");
  // 建记录时这两条还是手动档 ⇒ 预跑队列的 `isWanted` 一口回绝；换档那一列不产生新版本，
  // 也就没有新的入队。跑一拍只为把「万一排了」这条路也在快照之前收干净。
  await inst.booted.prewarm.drain();

  // ① 有载荷有授权：本档预览（落 `preview_llm_*` 三键，采信区间两条）⇒ 照这份签发授权。
  grants.issueGrant(grants.preparePreview(revisionOf(fx, withGrantAndPayload), {
    tier: "local_llm",
    llmSpans: llmSpans(),
  }));

  // ②⑥ 有载荷无授权：规则档预览一次（落 `preview_v2_payload:`），没人点过头。
  grants.preparePreview(revisionOf(fx, withPayload), { tier: "rules" });
  grants.preparePreview(revisionOf(fx, withPayloadOlder), { tier: "rules" });

  // ③ 预跑失败：只有咨询失败标记；PD-2 起不再算一份回落载荷。
  const failedRevision = revisionOf(fx, consultFailed);
  grants.markLlmConsultFailed(failedRevision, "timeout");

  // ④ 从没预览过：什么都不做（四枚键都不该在场）。

  // ⑤ 原文轨：载荷就是该版本原文，签发 `raw-v1` 那张条子。
  grants.issueGrant(grants.prepareRawPreview(revisionOf(fx, rawWithGrant)));

  // 建记录的时刻挤在同一毫秒里，倒序断言就没有确定性：把创建时间钉成互不相同的串。
  const stamp = new Map<string, string>([
    [withGrantAndPayload, "2026-10-30T08:00:00.000Z"],
    [withPayload, "2026-10-30T09:00:00.000Z"],
    [consultFailed, "2026-10-30T10:00:00.000Z"],
    [neverPreviewed, "2026-10-30T11:00:00.000Z"],
    [rawWithGrant, "2026-10-30T12:00:00.000Z"],
    [withPayloadOlder, "2026-10-30T07:00:00.000Z"],
    [manualOnly, "2026-10-30T13:00:00.000Z"],
    [localOnly, "2026-10-30T14:00:00.000Z"],
  ]);
  const update = inst.db.prepare("update capture_record set created_at_utc = ? where id = ?");
  for (const [recordId, utc] of stamp) update.run(utc, recordId);

  return fx;
}

let fixture: Fixture | null = null;

async function sharedFixture(): Promise<Fixture> {
  if (fixture === null) fixture = await buildFixture();
  return fixture;
}

async function queue(): Promise<ApiResult> {
  const fx = await sharedFixture();
  return getQueue(fx.inst);
}

function entryOf(result: ApiResult, recordId: string): ReviewQueueEntryDto {
  const found = result.json.entries.find((entry) => entry.recordId === recordId);
  if (found === undefined) throw new Error(`队列里没有记录 ${recordId}`);
  return found;
}

/* ══════════════════════════════════════════════════════════════════
 * C1 只读
 * ══════════════════════════════════════════════════════════════════ */

describe("M10-2 · C1 队列是只读投影", () => {
  it("调用前后四张表的行数与内容逐字不变，Provider 一次都没被叫", async () => {
    const fx = await sharedFixture();
    const callsBefore = fx.inst.stub.callCount();
    const before = snapshot(fx.inst.db);

    const first = await getQueue(fx.inst);
    const afterFirst = snapshot(fx.inst.db);
    const second = await getQueue(fx.inst);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(afterFirst, "四张表整表逐字不变（不是只查某一列）").toEqual(before);
    expect(snapshot(fx.inst.db), "连读两次仍然不改表").toEqual(before);
    expect(fx.inst.stub.callCount(), "队列不叫 Provider，也不排任何外发").toBe(callsBefore);
    // 两次读必须给回同一份东西：观测面不该有自己的随机性。
    expect(second.json).toEqual(first.json);
  });

  it("载荷缺失时也不现算：一枚新的 `preview_` 键都不冒出来", async () => {
    const fx = await sharedFixture();
    const readKeys = (): unknown[] =>
      fx.inst.db.prepare("select key from app_meta where key like 'preview_%' order by key").all();
    const before = readKeys();
    await getQueue(fx.inst);
    expect(readKeys()).toEqual(before);
    // ④ 那条真的什么都没有：它的四枚键一枚都不在册。
    const revision = revisionOf(fx, fx.neverPreviewed);
    const keys = new Set((readKeys() as Array<{ key: string }>).map((row) => row.key));
    for (const prefix of ["preview_v2_payload:", "preview_v2_nonce:", "preview_llm_v2_payload:", "preview_llm_v2_spans:"]) {
      expect(keys.has(`${prefix}${revision}`), `${prefix} 不该为一条没预览过的记录出现`).toBe(false);
    }
  });
});

/* ══════════════════════════════════════════════════════════════════
 * C2 派生正确
 * ══════════════════════════════════════════════════════════════════ */

describe("M10-2 · C2 四条夹具的派生逐字对上", () => {
  it("① 有载荷有授权（本档采信区间两条）", async () => {
    const fx = await sharedFixture();
    const entry = entryOf(await queue(), fx.withGrantAndPayload);
    expect(entry.hasPayload).toBe(true);
    expect(entry.hasGrant).toBe(true);
    expect(entry.llm).toEqual({ used: true, failureKind: null, spanCount: 2 });
    expect(entry.axes).toEqual({
      analysisProvider: "cloud",
      redactionMode: "local_llm",
      sendContentMode: "redacted",
    });
    expect(entry.revisionNumber).toBe(1);
    expect(entry.processingStatus).toBe("awaiting_privacy_review");
    expect(entry.currentRevisionId).toBe(revisionOf(fx, fx.withGrantAndPayload));
    expect(entry.createdAtUtc).toBe("2026-10-30T08:00:00.000Z");
  });

  it("② 有载荷无授权：规则档那份载荷在册，但没人点过头", async () => {
    const fx = await sharedFixture();
    const entry = entryOf(await queue(), fx.withPayload);
    expect(entry.hasPayload).toBe(true);
    expect(entry.hasGrant).toBe(false);
    // 手动档没有区间缓存这份东西 ⇒ 三个数一律默认值（前端因此不说数字，只说「规则 + 词表」）。
    expect(entry.llm).toEqual({ used: false, failureKind: null, spanCount: 0 });
    expect(entry.axes.redactionMode).toBe("manual");
  });

  it("③ 预跑失败：标记在册、没有任何待发送载荷", async () => {
    const fx = await sharedFixture();
    const entry = entryOf(await queue(), fx.consultFailed);
    expect(entry.hasPayload).toBe(false);
    expect(entry.hasGrant).toBe(false);
    expect(entry.llm).toEqual({ used: false, failureKind: "timeout", spanCount: 0 });
  });

  it("④ 从没预览过：两枚布尔都是假，`llm` 三个数都是默认", async () => {
    const fx = await sharedFixture();
    const entry = entryOf(await queue(), fx.neverPreviewed);
    expect(entry.hasPayload).toBe(false);
    expect(entry.hasGrant).toBe(false);
    expect(entry.llm).toEqual({ used: false, failureKind: null, spanCount: 0 });
  });

  it("⑤ 原文轨：载荷恒在册，`raw-v1` 那张条子命中", async () => {
    const fx = await sharedFixture();
    const entry = entryOf(await queue(), fx.rawWithGrant);
    expect(entry.axes.sendContentMode).toBe("raw");
    expect(entry.hasPayload).toBe(true);
    expect(entry.hasGrant).toBe(true);
    expect(entry.llm).toEqual({ used: false, failureKind: null, spanCount: 0 });
  });

  it("四腿核对只认自己那一档：策略版本取值仍是在册那三档，没有第四个", async () => {
    const fx = await sharedFixture();
    const { grants } = fx.inst.booted.workspace;
    const llmRevision = revisionOf(fx, fx.withGrantAndPayload);
    const rulesRevision = revisionOf(fx, fx.withPayload);
    // 两条载荷键各归各档：本档那条不会去读规则档的键，反之亦然（M9-D-9）。
    expect(grants.hasCachedPayload(llmRevision, "local_llm")).toBe(true);
    expect(grants.hasCachedPayload(llmRevision, "rules")).toBe(false);
    expect(grants.hasCachedPayload(rulesRevision, "rules")).toBe(true);
    expect(grants.hasCachedPayload(rulesRevision, "local_llm")).toBe(false);
    // 授权按档分道：规则档那条没签过任何一张条子，换到本档腿上去问也不该命中。
    expect(grants.hasApplicableGrantForPayload(llmRevision, "local_llm")).toBe(true);
    expect(grants.hasApplicableGrantForPayload(rulesRevision, "rules")).toBe(false);
    expect(grants.hasApplicableGrantForPayload(revisionOf(fx, fx.rawWithGrant), "raw")).toBe(true);
    expect(REDACTION_POLICY_VERSION).toBe("rules-v2");
    expect(LOCAL_LLM_POLICY_VERSION).toBe("rules+local_llm-v2");
    expect(RAW_SEND_POLICY_VERSION).toBe("raw-v1");
  });

  it("`llmSpanCount` 只数不写：缺键与坏缓存都读成 0，且不改表", async () => {
    const fx = await sharedFixture();
    const { grants } = fx.inst.booted.workspace;
    const absent = "rev-absent-for-m10-2";
    expect(grants.llmSpanCount(absent)).toBe(0);
    expect(grants.hasCachedPayload(absent, "rules")).toBe(false);
    // 一条只签过 raw 的记录，本档区间数仍是 0（那一档从没存在过）。
    expect(grants.llmSpanCount(revisionOf(fx, fx.rawWithGrant))).toBe(0);

    const before = snapshot(fx.inst.db);
    const key = `preview_llm_v2_spans:${absent}`;
    fx.inst.db
      .prepare("insert into app_meta (key, value, updated_at) values (?, ?, ?)")
      .run(key, "{不是 JSON", "2026-10-30T00:00:00.000Z");
    expect(grants.llmSpanCount(absent)).toBe(0);
    // 数完仍然不写回：夹具自己那行是测试摆的，队列读它一个字节都不动。
    fx.inst.db.prepare("delete from app_meta where key = ?").run(key);
    expect(snapshot(fx.inst.db)).toEqual(before);
  });
});

/* ══════════════════════════════════════════════════════════════════
 * C3 排序
 * ══════════════════════════════════════════════════════════════════ */

describe("M10-2 · C3 不确定的顶在上面", () => {
  it("没跑成 → 没载荷 → 没授权 → 都已就绪，同级按 createdAtUtc 倒序", async () => {
    const fx = await sharedFixture();
    const result = await queue();
    expect(result.json.entries.map((entry) => entry.recordId)).toEqual([
      fx.consultFailed,
      fx.neverPreviewed,
      fx.withPayload,
      fx.withPayloadOlder,
      fx.rawWithGrant,
      fx.withGrantAndPayload,
    ]);
    // 同秩内部确实是倒序：09:00 在 07:00 之前，12:00 在 08:00 之前。
    const times = result.json.entries.map((entry) => entry.createdAtUtc);
    expect(times.slice(2)).toEqual([
      "2026-10-30T09:00:00.000Z",
      "2026-10-30T07:00:00.000Z",
      "2026-10-30T12:00:00.000Z",
      "2026-10-30T08:00:00.000Z",
    ]);
    expect(result.json.total).toBe(result.json.entries.length);
  });

  it("「都没问题」的那两条不会因为读两次换个次序", async () => {
    const fx = await sharedFixture();
    const first = (await getQueue(fx.inst)).json.entries.map((entry) => entry.recordId);
    const again = (await getQueue(fx.inst)).json.entries.map((entry) => entry.recordId);
    expect(again).toEqual(first);
  });
});

/* ══════════════════════════════════════════════════════════════════
 * C4 不泄漏
 * ══════════════════════════════════════════════════════════════════ */

describe("M10-2 · C4 响应里没有任何文本面", () => {
  it("原文、词面、`surface`、op1 那种前 80 字摘要一个都不出现", async () => {
    const result = await queue();
    for (const face of ALL_FACES) {
      expect(result.text, `响应里出现了夹具文本 ${face}`).not.toContain(face);
    }
    expect(result.text).not.toContain("surface");
    expect(result.text).not.toContain("redactedText");
    expect(result.text).not.toContain("payloadText");
    // 载荷本身也不给：只给「有没有」这一枚布尔。
    expect(result.text).not.toMatch(/"payload[A-Za-z]*"\s*:\s*"/);
  });

  /**
   * 键集合封闭。M10-4 让这一格**变宽**了一列（`checkingSinceUtc`）与响应顶上一格（`prewarm`）；
   * S5 又让每行多带四格（`needsAction` / `nextAction` / `processingMode` / `privacyLevel`）——
   * 收件箱要在一行里同时回答「要不要动」与「怎么动」。那仍然是「形状变宽」而不是「断言放宽」：
   * 清单照样逐字封闭，多一列就红，且新增的四格全是枚举/布尔，没有一格是文本。
   * 这套夹具在读队列之前已把预跑排空，所以每条都是 `null`：不在册就说不在册。
   */
  it("每行的键集合封闭：没有多带一列文本", async () => {
    const result = await queue();
    expect(result.json.entries.length).toBeGreaterThan(0);
    expect(Object.keys(result.json).sort()).toEqual(["entries", "prewarm", "total"]);
    expect(result.json.prewarm).toEqual({ pending: 0 });
    for (const entry of result.json.entries) {
      expect(Object.keys(entry).sort()).toEqual([
        "axes",
        "checkingSinceUtc",
        "createdAtUtc",
        "currentRevisionId",
        "hasGrant",
        "hasPayload",
        "llm",
        "needsAction",
        "nextAction",
        "privacyLevel",
        "processingMode",
        "processingStatus",
        "recordId",
        "revisionNumber",
      ]);
      expect(entry.checkingSinceUtc, "预跑已排空 ⇒ 没有一条在检查").toBeNull();
      expect(Object.keys(entry.axes).sort()).toEqual([
        "analysisProvider",
        "redactionMode",
        "sendContentMode",
      ]);
      expect(Object.keys(entry.llm).sort()).toEqual(["failureKind", "spanCount", "used"]);
    }
  });
});

/* ══════════════════════════════════════════════════════════════════
 * C6 非外发轨不进队列
 * ══════════════════════════════════════════════════════════════════ */

describe("M10-2 · C6 不外发的记录不在队列里", () => {
  it("只保存与只本机整理都不出现，队列只剩外发轨", async () => {
    const fx = await sharedFixture();
    const result = await queue();
    const ids = result.json.entries.map((entry) => entry.recordId);
    expect(ids).not.toContain(fx.manualOnly);
    expect(ids).not.toContain(fx.localOnly);
    expect(result.json.total).toBe(6);
    for (const entry of result.json.entries) {
      expect(entry.axes.sendContentMode).not.toBe("none");
    }
  });
});

/* ══════════════════════════════════════════════════════════════════
 * C5 前端（源码级）
 * ══════════════════════════════════════════════════════════════════ */

describe("M10-2 · C5 收件箱视图的源码面（S5 合并后）", () => {
  const panel = readFileSync(new URL("../src/web/IngestPanel.tsx", import.meta.url), "utf8");
  const inbox = readFileSync(new URL("../src/web/inbox.ts", import.meta.url), "utf8");
  const section = /function InboxSection[\s\S]*?\n}/.exec(panel)?.[0] ?? "";
  const rows = /export function buildInboxRows[\s\S]*?\n}/.exec(inbox)?.[0] ?? "";

  it("收件箱本体与合并逻辑都被断言到；旧的双列表不再存在", () => {
    expect(section, "InboxSection 本体要被断言到").not.toBe("");
    expect(rows, "buildInboxRows 本体要被断言到").not.toBe("");
    expect(panel).not.toContain("ReviewQueueSection");
    expect(panel).not.toContain("reviewQueueRowMeta");
    const queueAt = panel.indexOf("<InboxSection");
    expect(queueAt, "唯一收件箱画在页面上").toBeGreaterThan(-1);
  });

  it("空队列有一句说明，且这一屏不画空表格", () => {
    // S5 之后这一屏只列「此刻需要动作」的记录，所以空态说的是「没有需要你处理的记录」，
    // 而不是旧队列视图那句「没有待发送确认的记录」。壳仍是封闭类名，不画表格。
    expect(section).toContain('className="list"');
    expect(section).toContain("没有需要你处理的记录。");
    expect(section).not.toMatch(/<table|<tbody|<thead/);
    // 换壳不换视觉语言：行还是那三个类名。
    for (const cls of ["row-btn", "row-title", "row-meta"]) {
      expect(section, `收件箱那一行少了复用的 .${cls}`).toContain(cls);
    }
  });

  it("一行只给一个下一步：动作文案收在 inbox.ts，收件箱不再摆「本地模型遮了 N 处」", () => {
    // S5 把「来源统计」从行里拿掉：一行只回答「这条现在该做什么」，来源细节在详情的预览里。
    expect(inbox).toContain("export function inboxActionLabel");
    expect(rows).toContain("ACTION_RANK");
    // D-1：行 meta 收敛成一句状态，不再拼「轨道 · 待确认发送」那串。
    expect(inbox).not.toContain("待确认发送");
    expect(panel).not.toContain("本地模型遮了");
    expect(panel).not.toContain("本次本地模型没用上");
  });

  it("取数只在面板那一层：视图组件不碰 `api.`，也不签任何东西", () => {
    expect(panel).not.toContain("fetch(");
    expect(panel).toContain("api.reviewQueue()");
    expect(section).not.toMatch(/\bapi\./);
    expect(section).not.toContain("ingestConfirmSend");
    // 全页只有既有那一条确认通道，收件箱这一屏没给它加第二个入口。
    expect(panel.match(/api\.ingestConfirmSend/g)).toHaveLength(1);
  });
});
