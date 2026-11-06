/**
 * M10-3 专项测试：批量确认（纯前端串行循环既有接口）——执行准则 §六、裁决 M10-D-4。
 *
 * 这一批不该动服务端一个字节：所谓「批量」是把「逐条点进单条复核、再逐条点确认」那六下操作
 * 收成两下。断言因此围着五件事转：
 *  1. **真接口、真授权**（D1）：起真服务、真 HTTP，`confirmReviewEntries` 调的是既有那条
 *     `POST /api/ingest/confirm-send`，签出来的每张条子都能被 `requireApplicableGrant` 命中。
 *     「前端循环」不是「前端自己算了一套」的同义词。
 *  2. **不连坐**（D2）：中间那条原文变了 ⇒ 只有那一条没签出去，另外两条照常落库；失败那条
 *     仍在队列里（它没消失，只是回到「待确认」）。
 *  3. **形状封闭**（D3）：回报只有 `recordId` + 封闭的 `reason`。服务端那句 `detail` 是策展过的
 *     自由文本，不往这一屏端；原文与词面更不该出现在结果里。
 *  4. **串行**（D4）：一次一条在途。并发时「第几条失败了」说不清，进度那句也无从落笔。
 *  5. **纯前端**（D7/D8）：界面画的是带数量的确认（`确认选中的 3 条`），没有「全部确认」这种
 *     免看确认；`reviewBatch.ts` 不 import 服务端，也不 `Promise.all`。
 *
 * 全程离线：库只落 `TB_DATA_DIR` 沙箱；本机模型那个地址由假 handler 截住，一个字节都不离开本机
 * （D2 要的「这版内容变过」只有 `local_llm` 档才落在 409 上：那一档确认的是用户看过的区间，
 * 新版本没有区间在册 ⇒ `local_llm_not_previewed`，与「重新预览一次」是同一句话）。
 */

import { createServer } from "node:net";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

import { afterAll, describe, expect, it } from "vitest";

import type { Database } from "../src/server/db/adapter.ts";
import { ensureConfigFile } from "../src/server/config/config.ts";
import type { DataLayout } from "../src/server/config/paths.ts";
import { sha256OfText } from "../src/server/privacy/redaction.ts";
import { boot, shutdown, type BootResult } from "../src/server/runtime/bootstrap.ts";
import type { ReviewQueueResponse, SendPreviewDto } from "../src/shared/dto.ts";
import { ApiError } from "../src/web/apiClient.ts";
import {
  BATCH_CONFIRM_FAILURE_TEXT,
  confirmReviewEntries,
  type BatchConfirmFailureReason,
} from "../src/web/reviewBatch.ts";
import { makeAdapter, OK_ENVELOPE, stubTransport, SYSTEM_PROMPT, validOutput } from "./helpers/ingestFixtures.ts";
import { countRows, makeSandbox, type Sandbox } from "./helpers/sandbox.ts";

/* ── 夹具文本 ────────────────────────────────────────────────────── */

const SENTINEL = "张三的电话是13800138000，他说蓝山咖啡馆见";
const SECOND = "第二条要发脱敏版的内容，邮箱 a@example.com";
const RAW_TRACK_TEXT = "这一条走原文轨，一个字都不遮，可张三还在里面";
const D2_LEFT = "左边这一条：批量确认里它要照常签出去";
const D2_RIGHT = "右边这一条：跟中间那条没关系，各签各的";
/**
 * 走本机模型档那条的夹具文本。假 handler 给的候选坐标锚在这一句里（偏移落不进原文就被丢掉），
 * 所以凡是要预览的本机模型记录都用**同一份**文本——D1 那条与 D2 中间那条。
 */
const LLM_TEXT = "中间这一条要先问本机模型：蓝山咖啡馆见，别把店名发出去";
const LLM_SURFACE = "蓝山咖啡馆";
const LLM_TEXT_EDITED = `${LLM_TEXT}（改了一个字）`;

/** 泄漏扫描的词面清单：每一条夹具原文 + 其中每一个敏感词面。 */
const ALL_FACES = [
  SENTINEL,
  SECOND,
  RAW_TRACK_TEXT,
  D2_LEFT,
  D2_RIGHT,
  LLM_TEXT,
  LLM_TEXT_EDITED,
  "张三",
  "13800138000",
  LLM_SURFACE,
  "a@example.com",
];

/* ── 真 HTTP 面夹具（照 m10-2 / m10-1 的手法） ───────────────────── */

/** 本机模型的假地址：只有带这个标记的请求被截住，其余（打本机 HTTP 面的）原样转真 fetch。 */
const FAKE_LLM_MARK = "127.0.0.1:14557";
const CONFIRM_PATH = "/api/ingest/confirm-send";

interface LlmState {
  calls: number;
}

let llmCalls: LlmState = { calls: 0 };
let restoreFetch: (() => void) | null = null;

/**
 * 本机模型的候选征询截肢成一句本地回稿（照 m10-1 的 e2e 手法）。D2 的那条 `local_llm` 记录
 * 要先有一次真预览，这一份假回稿就是那次预览问的东西；确认那一步**不该**再叫它（有断言）。
 */
function installFakeLocalLlm(): void {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    if (!String(input).includes(FAKE_LLM_MARK)) {
      return (real as (a: unknown, b?: RequestInit) => Promise<Response>)(input, init);
    }
    llmCalls.calls += 1;
    const start = LLM_TEXT.indexOf(LLM_SURFACE);
    const content = JSON.stringify({
      candidates: [
        { start, end: start + LLM_SURFACE.length, kind: "place", surface: LLM_SURFACE },
      ],
    });
    const body = JSON.stringify({ choices: [{ message: { content } }] });
    return { status: 200, text: () => Promise.resolve(body) } as unknown as Response;
  }) as unknown as typeof fetch;
  restoreFetch = () => {
    globalThis.fetch = real;
  };
}

function uninstallFakeLocalLlm(): void {
  restoreFetch?.();
  restoreFetch = null;
}

interface Instance {
  readonly booted: BootResult;
  readonly box: Sandbox;
  readonly base: string;
  readonly db: Database;
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
  // 本机模型档**配好但没人监听**：`localLlmStatus.usable` 为真 ⇒ `local_llm` 档的确认能过
  // 那道档位门（`assertRedactionPlanRunnable`），D2 才轮得到「没预览过 ⇒ 409」那一条分支。
  (raw.model as Record<string, unknown>).local_llm = {
    enabled: true,
    provider: "ollama",
    base_url: `http://${FAKE_LLM_MARK}/v1`,
    request_timeout_ms: 2000,
    model: "qwen3:8b",
  };
  writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
}

let shared: Instance | null = null;

async function instance(): Promise<Instance> {
  if (shared !== null) return shared;
  installFakeLocalLlm();
  const box = makeSandbox("tb-m10-3-");
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
    uninstallFakeLocalLlm();
    box.cleanup();
    throw cause;
  }
  shared = { booted, box, base: `http://127.0.0.1:${port}`, db: booted.db };
  liveInstances.push(shared);
  return shared;
}

afterAll(async () => {
  uninstallFakeLocalLlm();
  for (const inst of liveInstances) {
    await shutdown(inst.booted);
    inst.box.cleanup();
  }
  liveInstances.length = 0;
  shared = null;
});

interface ApiResult {
  status: number;
  json: Record<string, unknown>;
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
  let json: Record<string, unknown> = {};
  try {
    json = text === "" ? {} : (JSON.parse(text) as Record<string, unknown>);
  } catch {
    json = {};
  }
  return { status: res.status, json, text };
}

/** 建一条外发轨记录（真 HTTP），返回 recordId。 */
async function makeRecord(inst: Instance, text: string, processingMode: string): Promise<string> {
  const created = await call(inst, "POST", "/api/records", { text, processing_mode: processingMode });
  expect(created.status, `建记录失败：${created.text}`).toBe(201);
  const record = created.json.record as { id: string };
  return record.id;
}

/** 用户点「查看实际待发送文本」那一步（真 HTTP）；返回那份预览的三条腿读数。 */
async function preview(inst: Instance, recordId: string): Promise<SendPreviewDto> {
  const result = await call(inst, "POST", "/api/ingest/preview", { recordId });
  expect(result.status, `预览失败：${result.text}`).toBe(200);
  return result.json as unknown as SendPreviewDto;
}

/**
 * 界面上那颗确认按钮发的那一个请求：只带 `recordId`（载荷由服务端复现，前端不端上去）。
 * 错误按 `apiClient` 同一手法收成 `ApiError`（状态码 + 错误码 + 服务端 detail），批量那一层
 * 只读**状态码**分类原因，不读 detail 正文。
 */
async function confirmViaHttp(inst: Instance, recordId: string): Promise<void> {
  const res = await fetch(`${inst.base}${CONFIRM_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ recordId }),
  });
  const text = await res.text();
  if (!res.ok) {
    const parsed = JSON.parse(text) as { error?: string; detail?: string };
    throw new ApiError(res.status, parsed.error ?? `http_${res.status}`, parsed.detail ?? "");
  }
}

function grantRows(inst: Instance): Array<Record<string, unknown>> {
  return inst.db.prepare("select * from cloud_send_grant order by rowid").all() as unknown as Array<
    Record<string, unknown>
  >;
}

function revisionIdOf(inst: Instance, recordId: string): string {
  const row = inst.db.prepare("select current_revision_id from capture_record where id = ?").get(recordId) as {
    current_revision_id: string;
  };
  return row.current_revision_id;
}

/* ══════════════════════════════════════════════════════════════════
 * D1 真接口、真授权
 * ══════════════════════════════════════════════════════════════════ */

describe("M10-3 · D1 批量确认签的是真授权（真服务 + 真 HTTP）", () => {
  it("三条各签一张：新增 3 行，四腿两两不同，每张都能被 requireApplicableGrant 命中", async () => {
    const inst = await instance();
    const { grants } = inst.booted.workspace;
    const ids = {
      sentinel: await makeRecord(inst, SENTINEL, "cloud_redacted"),
      second: await makeRecord(inst, SECOND, "cloud_redacted"),
      raw: await makeRecord(inst, RAW_TRACK_TEXT, "cloud_raw"),
    };
    const previews = {
      [ids.sentinel]: await preview(inst, ids.sentinel),
      [ids.second]: await preview(inst, ids.second),
      [ids.raw]: await preview(inst, ids.raw),
    } as Record<string, SendPreviewDto>;

    const before = countRows(inst.db, "cloud_send_grant");
    const order: string[] = [];
    const outcome = await confirmReviewEntries([ids.sentinel, ids.second, ids.raw], {
      confirm: async (recordId) => {
        order.push(recordId);
        await confirmViaHttp(inst, recordId);
      },
    });
    const rows = grantRows(inst);
    const fresh = rows.slice(before);

    expect(outcome.confirmed).toEqual([ids.sentinel, ids.second, ids.raw]);
    expect(outcome.failed).toEqual([]);
    expect(order, "每条都真的发了一次 confirm-send").toEqual([ids.sentinel, ids.second, ids.raw]);
    expect(fresh, "一次点击 = 三条各签一张，没有第四张").toHaveLength(3);

    // 四腿：revision / payload_sha256 / policy_version / send_content_mode。整组两两不同，
    // revision 这一腿更是必须三条三个值（一条记录一张条子，不是三条共用一张）。
    const legs = fresh.map((row) =>
      [
        row.record_revision_id,
        row.payload_sha256,
        row.policy_version,
        row.send_content_mode,
      ].join("|"),
    );
    expect(new Set(legs).size, "四元组两两不同").toBe(3);
    expect(new Set(fresh.map((row) => row.record_revision_id)).size).toBe(3);
    expect(new Set(fresh.map((row) => row.policy_version)).size, "脱敏轨 rules-v1 与原文轨 raw-v1 各归各档").toBe(2);

    for (const row of fresh) {
      const revisionId = row.record_revision_id as string;
      const payloadSha256 = row.payload_sha256 as string;
      const policyVersion = row.policy_version as string;
      const sendContentMode = row.send_content_mode as "redacted" | "raw";
      const recordId = Object.keys(previews).find((key) => previews[key]!.recordRevisionId === revisionId);
      expect(recordId, "这张条子属于本次批量里的某一条记录").toBeDefined();
      const previewOfRow = previews[recordId!]!;
      // 签的就是用户看过的那一份载荷：哈希与 policy 都取自那一份预览，不是前端另算的。
      expect(payloadSha256).toBe(previewOfRow.payloadSha256);
      expect(policyVersion).toBe(previewOfRow.policyVersion);
      expect(sendContentMode).toBe(previewOfRow.sendContentMode);
      // 发送前那道门用的就是这一个入口：命中即这张条子真的能放行。
      expect(
        grants.requireApplicableGrant(revisionId, sha256OfText(previewOfRow.payloadText), policyVersion, sendContentMode).id,
      ).toBe(row.id);
    }
  });

  it("确认这一步不再咨询本机模型：预览问一次，确认一次都不问", async () => {
    const inst = await instance();
    const recordId = await makeRecord(inst, LLM_TEXT, "cloud_redacted");
    const tier = await call(inst, "PATCH", `/api/records/${recordId}/redaction-mode`, { redaction_mode: "local_llm" });
    expect(tier.status, tier.text).toBe(200);

    await preview(inst, recordId);
    expect(llmCalls.calls, "这一档的第一次预览要问本机模型").toBeGreaterThan(0);
    const afterPreview = llmCalls.calls;

    const outcome = await confirmReviewEntries([recordId], {
      confirm: (id) => confirmViaHttp(inst, id),
    });
    expect(outcome.confirmed).toEqual([recordId]);
    expect(llmCalls.calls, "确认不许再问本机模型：那等于让用户对一个没见过的文本点头").toBe(afterPreview);
  });
});

/* ══════════════════════════════════════════════════════════════════
 * D2 不连坐
 * ══════════════════════════════════════════════════════════════════ */

describe("M10-3 · D2 中间那条原文变了，只有它没签出去", () => {
  it("那一条 failed(payload_changed)，另外两条照常 confirmed 且授权照常落库", async () => {
    const inst = await instance();
    const left = await makeRecord(inst, D2_LEFT, "cloud_redacted");
    const middle = await makeRecord(inst, LLM_TEXT, "cloud_redacted");
    const right = await makeRecord(inst, D2_RIGHT, "cloud_redacted");

    // 中间那条换到「本地模型辅助」档并预览一次：确认绑的就是这一版的采信区间（M9-D-13）。
    const tier = await call(inst, "PATCH", `/api/records/${middle}/redaction-mode`, { redaction_mode: "local_llm" });
    expect(tier.status, tier.text).toBe(200);
    await preview(inst, left);
    await preview(inst, middle);
    await preview(inst, right);
    const reviewedRevision = revisionIdOf(inst, middle);

    // 用户改原文 ⇒ 新版本。刚看过的那一份载荷属于上一版，这一版没有可确认的东西。
    const edited = await call(inst, "PUT", `/api/records/${middle}`, { text: LLM_TEXT_EDITED });
    expect(edited.status, edited.text).toBe(200);
    const newRevision = (edited.json.revision as { id: string }).id;
    expect(newRevision).not.toBe(reviewedRevision);

    const before = countRows(inst.db, "cloud_send_grant");
    const outcome = await confirmReviewEntries([left, middle, right], {
      confirm: (recordId) => confirmViaHttp(inst, recordId),
    });

    expect(outcome.confirmed).toEqual([left, right]);
    expect(outcome.failed).toEqual([{ recordId: middle, reason: "payload_changed" }]);
    expect(countRows(inst.db, "cloud_send_grant"), "两条各签一张，失败的第三条不连坐别人").toBe(before + 2);
    expect(
      grantRows(inst).some((row) => row.record_revision_id === newRevision),
      "新那一版一个字都没签出去：没被看过的载荷不能替用户点头",
    ).toBe(false);

    // 失败那条没消失，只是回到「待确认」——用户在这里看得见它，才会去重新预览。
    const queue = await call(inst, "GET", "/api/ingest/review-queue");
    expect(queue.status).toBe(200);
    const entries = (queue.json as unknown as ReviewQueueResponse).entries;
    const stillThere = entries.find((entry) => entry.recordId === middle);
    expect(stillThere, "改过原文的那条仍在队列里").toBeDefined();
    expect(stillThere!.hasGrant).toBe(false);
    expect(stillThere!.revisionNumber, "队列报的是改过之后那一版").toBe(2);
  });
});

/* ══════════════════════════════════════════════════════════════════
 * D3 回报的形状：只有 id 与封闭的原因
 * ══════════════════════════════════════════════════════════════════ */

describe("M10-3 · D3 回报里没有任何内容面", () => {
  it("结果对象逐字段扫过：不含原文、不含词面、不含服务端 detail 正文", async () => {
    const inst = await instance();
    const sentinel = await makeRecord(inst, SENTINEL, "cloud_redacted");
    const broken = await makeRecord(inst, SECOND, "cloud_redacted");
    await preview(inst, sentinel);
    // 一条从没预览过、又被换到本机模型档的记录 ⇒ 服务端那句 detail 是「…请先预览一次：<rev>」
    // 这样的策展自由文本。它一个字都不许进结果：结果只认状态码。
    await call(inst, "PATCH", `/api/records/${broken}/redaction-mode`, { redaction_mode: "local_llm" });

    const outcome = await confirmReviewEntries([sentinel, broken], {
      confirm: (recordId) => confirmViaHttp(inst, recordId),
    });
    const scan = JSON.stringify(outcome);

    expect(outcome.confirmed).toEqual([sentinel]);
    expect(outcome.failed).toHaveLength(1);
    for (const face of ALL_FACES) {
      expect(scan, `结果里出现了夹具文本 ${face}`).not.toContain(face);
    }
    expect(scan, "服务端那句 detail 不进结果").not.toContain("本地模型");
    expect(scan, "连错误码也不夹带进来当文案用").not.toContain("previewed");
    // 形状封闭：只有 id + 那个封闭集的取值。
    expect(Object.keys(outcome).sort()).toEqual(["confirmed", "failed"]);
    for (const failure of outcome.failed) {
      expect(new Set(Object.keys(failure))).toEqual(new Set(["recordId", "reason"]));
    }
  });

  it("原因映射只由状态码派生，取值落在那个封闭集里，每格都有成句文案", async () => {
    const cases: readonly { label: string; cause: unknown; reason: BatchConfirmFailureReason }[] = [
      {
        label: "409 载荷变了",
        cause: new ApiError(409, "local_llm_not_previewed", "内部 id 与类别"),
        reason: "payload_changed",
      },
      { label: "0 连不上后端", cause: new ApiError(0, "network_error", "无法连接本地后端"), reason: "network" },
      { label: "500 服务端出错", cause: new ApiError(500, "internal_error", "内部错误"), reason: "other" },
      { label: "不是 ApiError", cause: new Error("boom"), reason: "other" },
    ];
    for (const testCase of cases) {
      const outcome = await confirmReviewEntries(["rec_x"], {
        confirm: async () => {
          throw testCase.cause;
        },
      });
      expect(outcome.failed, testCase.label).toEqual([{ recordId: "rec_x", reason: testCase.reason }]);
      expect(outcome.confirmed, testCase.label).toEqual([]);
      // 每一格都有成句文案，界面不自己再造一套说法。
      expect(BATCH_CONFIRM_FAILURE_TEXT[testCase.reason]).toBeTruthy();
    }
  });
});

/* ══════════════════════════════════════════════════════════════════
 * D4 串行 · D5 去重 · D6 从不抛
 * ══════════════════════════════════════════════════════════════════ */

describe("M10-3 · D4 串行：任意时刻在途最多一条", () => {
  it("进入/离开顺序两两咬合，confirmed 顺序 == 输入顺序", async () => {
    const ids = ["rec_a", "rec_b", "rec_c", "rec_d"];
    let inFlight = 0;
    let maxInFlight = 0;
    const events: string[] = [];
    const progress: Array<[string, number, number]> = [];

    const outcome = await confirmReviewEntries(ids, {
      onProgress: (recordId, index, total) => progress.push([recordId, index, total]),
      confirm: async (recordId) => {
        events.push(`enter:${recordId}`);
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        // 故意错开每条的耗时：并发写法（Promise.all）在这一条断言下必然露出来。
        await new Promise((resolve) => setTimeout(resolve, recordId.charCodeAt(4) % 3));
        inFlight -= 1;
        events.push(`leave:${recordId}`);
      },
    });

    expect(maxInFlight, "串行：同时在途的不止一条就是并发").toBe(1);
    expect(events).toEqual([
      "enter:rec_a",
      "leave:rec_a",
      "enter:rec_b",
      "leave:rec_b",
      "enter:rec_c",
      "leave:rec_c",
      "enter:rec_d",
      "leave:rec_d",
    ]);
    expect(outcome.confirmed).toEqual(ids);
    expect(progress).toEqual([
      ["rec_a", 1, 4],
      ["rec_b", 2, 4],
      ["rec_c", 3, 4],
      ["rec_d", 4, 4],
    ]);
  });

  it("一条失败不阻断后面的，失败也不改在途数", async () => {
    const seen: string[] = [];
    const outcome = await confirmReviewEntries(["rec_a", "rec_b", "rec_c"], {
      confirm: async (recordId) => {
        seen.push(recordId);
        if (recordId === "rec_b") throw new ApiError(409, "local_llm_not_previewed", "detail");
      },
    });
    expect(seen).toEqual(["rec_a", "rec_b", "rec_c"]);
    expect(outcome).toEqual({ confirmed: ["rec_a", "rec_c"], failed: [{ recordId: "rec_b", reason: "payload_changed" }] });
  });
});

describe("M10-3 · D5 去重", () => {
  it("[a, a, b] 只调两次：同一个 id 签两张没有第二重含义", async () => {
    const called: string[] = [];
    const outcome = await confirmReviewEntries(["rec_a", "rec_a", "rec_b"], {
      confirm: async (recordId) => {
        called.push(recordId);
      },
    });
    expect(called).toEqual(["rec_a", "rec_b"]);
    expect(outcome.confirmed).toEqual(["rec_a", "rec_b"]);
    expect(outcome.failed).toEqual([]);
  });

  it("空输入不叫任何东西，也不抛", async () => {
    let calls = 0;
    const outcome = await confirmReviewEntries([], {
      confirm: async () => {
        calls += 1;
      },
    });
    expect(calls).toBe(0);
    expect(outcome).toEqual({ confirmed: [], failed: [] });
  });
});

describe("M10-3 · D6 从不抛", () => {
  it("confirm 抛非 ApiError（TypeError / Error / 字符串）都收成结果里的 one failure", async () => {
    for (const cause of [new Error("boom"), new TypeError("x is not a function"), "not even an error"]) {
      const outcome = await confirmReviewEntries(["rec_a", "rec_b"], {
        confirm: async (recordId) => {
          if (recordId === "rec_a") throw cause;
        },
      });
      expect(outcome, String(cause)).toEqual({
        confirmed: ["rec_b"],
        failed: [{ recordId: "rec_a", reason: "other" }],
      });
    }
  });

  it("全部失败也照样正常返回（不 throw、不 rollback 已成功的那几条）", async () => {
    const outcome = await confirmReviewEntries(["rec_a", "rec_b"], {
      confirm: async () => {
        throw new ApiError(0, "network_error", "无法连接本地后端");
      },
    });
    expect(outcome.failed.map((failure) => failure.reason)).toEqual(["network", "network"]);
    expect(outcome.confirmed).toEqual([]);
  });
});

/* ══════════════════════════════════════════════════════════════════
 * D7 / D8 源码面（纯前端，带数量的确认）
 * ══════════════════════════════════════════════════════════════════ */

describe("M10-3 · D7 收件箱那一屏的源码面（S5 合并后）", () => {
  const panel = readFileSync(new URL("../src/web/IngestPanel.tsx", import.meta.url), "utf8");
  const section = /function InboxSection[\s\S]*?\n}/.exec(panel)?.[0] ?? "";
  const outcomeText = /function batchConfirmOutcomeText[\s\S]*?\n}/.exec(panel)?.[0] ?? "";

  it("两段本体都被断言到（不是空表蒙混过关）", () => {
    expect(section, "InboxSection 本体要被断言到").not.toBe("");
    expect(outcomeText, "batchConfirmOutcomeText 本体要被断言到").not.toBe("");
  });

  it("每行前面一颗复选框，行本身点击仍然只是选中那条记录", () => {
    expect(section).toContain('type="checkbox"');
    expect(section).toMatch(/onChange=\{\(\) =>\s*setChecked/);
    expect(section).toContain("onClick={() => props.onSelect(row.recordId)}");
    // 复选框只给「缺授权的外发行」：收件箱里还有只需整理的记录，它们不该混进批量确认。
    expect(section).toContain("row.confirmable");
  });

  it("按钮文案带数量；没勾选时那句不带数量且 disabled", () => {
    expect(section).toMatch(/确认选中的 \$\{[^}]*\} 条/);
    expect(section).toContain('"确认选中的记录"');
    expect(section).toMatch(/disabled=\{running \|\| confirmPicked\.length === 0\}/);
    // 免看确认不在这屏：这句话一个字都不许出现。
    expect(panel).not.toContain("全部确认");
  });

  it("串行进度看得见（第几条 / 共几条），跑完那句结果上屏", () => {
    expect(section).toMatch(/正在处理第 \{[^}]*\}\/\{[^}]*\} 条…/);
    expect(section).toContain("confirmReviewEntries");
    expect(section).toContain("setResult(null)");
    expect(section).toContain("props.onConfirmed()");
  });

  it("失败只说封闭集那三句之一，不带服务端 detail 正文", () => {
    expect(outcomeText).toContain("BATCH_CONFIRM_FAILURE_TEXT[failure.reason]");
    expect(outcomeText).not.toMatch(/detail|cause/);
    expect(panel).not.toMatch(/ingestErrorDetail\(.*batch|batch.*ingestErrorDetail/);
  });

  it("取数仍在面板那一层：这一屏不碰 api.，发送授权只有 confirmSendGrant 那一条通道", () => {
    expect(section).not.toMatch(/\bapi\./);
    expect(panel.match(/api\.ingestConfirmSend/g)).toHaveLength(1);
    expect(panel).toContain("async function confirmSendGrant(recordId: string)");
    // 批量走 props 递进来的同一条通道，不另开第二份请求写法。
    expect(panel).toMatch(/onConfirmOne=\{async \(recordId\) => \{\s*await confirmSendGrant\(recordId\);/);
  });
});

describe("M10-3 · D8 这一批纯前端", () => {
  const batch = readFileSync(new URL("../src/web/reviewBatch.ts", import.meta.url), "utf8");
  const code = batch.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("reviewBatch.ts 不 import 服务端：模块图里 `../server/` 一个都不出现", () => {
    const imports = [...code.matchAll(/^import[\s\S]*?from "([^"]+)";/gm)].map((match) => match[1]!);
    expect(imports.length).toBeGreaterThan(0);
    for (const specifier of imports) {
      expect(specifier, `不该 import 服务端：${specifier}`).not.toContain("../server/");
      expect(specifier).not.toContain("src/server");
    }
  });

  it("串行写在实现里：没有 Promise.all，也没有把批量端成一次请求", () => {
    expect(code).not.toMatch(/Promise\.all|Promise\.allSettled|Promise\.race/);
    expect(code).toMatch(/for \(const \[offset, recordId\] of targets\.entries\(\)\)/);
    expect(code).toContain("await deps.confirm(recordId)");
    expect(code).not.toMatch(/\bfetch\(|ingestConfirmSend|\/api\//);
  });

  it("原因映射只读状态码：409 ⇒ payload_changed，0 ⇒ network，其余 ⇒ other", () => {
    expect(code).toMatch(/if \(cause\.status === 409\) return "payload_changed"/);
    expect(code).toMatch(/if \(cause\.status === 0\) return "network"/);
    expect(code).not.toMatch(/cause\.detail|cause\.code/);
  });
});
