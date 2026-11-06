/**
 * M9-4d-2 专项测试：脱敏档在记录上**单独可改**（裁决 M9-D-15）+ 发送区档位两选与预览来源标注。
 *
 * 为什么要有这一批：用户能选的是 `processing_mode`，而 `(cloud, local_llm, redacted)` 与
 * `(cloud, manual, redacted)` **都派生成 `cloud_redacted`**——界面表达不出「这次用本地模型脱敏」。
 * 加一个 mode 值要动 0008 的 CHECK（等于加迁移，禁区），所以「谁来做脱敏」从「在哪分析」里拆出来，
 * 落成一条只动 `redaction_mode` 一列的窄入口。
 *
 * 钉住的两组：
 *  - **服务端 R1–R5**：合法切换只改一列 + 重算派生列；非法组合 400 且零写入；取值/键集合门；
 *    404 与幂等；**不产生任何外发副作用**（grant / parse_run / app_meta 计数不变，Provider 桩零调用）。
 *  - **前端 R6–R8**：档位行的判据（禁用只依赖 `usable`、原因来自封闭枚举映射、页面里不重算回环）、
 *    预览区的来源标注与「这次本地模型没用上」、切档后确实重新拉一次预览。
 *
 * 全程离线：云端是 `stubTransport`；数据库只落 `TB_DATA_DIR` 沙箱。前端断言走 `web-ui4-pages`
 * 的源码级手法（vitest 的 environment 是 node，没有 DOM），判据本体另由纯函数直接调用断言。
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ensureConfigFile } from "../src/server/config/config.ts";
import type { DataLayout } from "../src/server/config/paths.ts";
import { LOCAL_LLM_FAILURE_KINDS } from "../src/server/privacy/grantService.ts";
import { REDACTION_SOURCES } from "../src/server/privacy/redaction.ts";
import { boot, shutdown, type BootResult } from "../src/server/runtime/bootstrap.ts";
import {
  LLM_FAILURE_KIND_DTO_VALUES,
  REDACTION_SOURCE_DTO_VALUES,
  type LocalLlmTierDto,
  type RecordRow,
} from "../src/shared/dto.ts";
import { localLlmFailureHeadline } from "../src/web/localLlmSettings.ts";
import {
  REDACTION_TIERS,
  REDACTION_TIER_LABEL,
  llmUnusedNoticeText,
  redactionSourceLabel,
  redactionTierEnabled,
  redactionTierOfMode,
  redactionTierUnavailableText,
  showRedactionTierRow,
  tierSwitchedNotice,
  type RedactionTier,
} from "../src/web/redactionTier.ts";
import {
  OK_ENVELOPE,
  SYSTEM_PROMPT,
  makeAdapter,
  stubTransport,
  validOutput,
  type StubTransport,
} from "./helpers/ingestFixtures.ts";
import { countRows, makeSandbox, type Sandbox } from "./helpers/sandbox.ts";

/* ── 运行夹具（真 HTTP 面 + 桩云端 transport） ────────────────────── */

interface Instance {
  readonly booted: BootResult;
  readonly box: Sandbox;
  readonly base: string;
  readonly stub: StubTransport;
}

const live: Instance[] = [];

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
  writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
}

async function startInstance(): Promise<Instance> {
  const box = makeSandbox("tb-m9-4d2-");
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
  const inst: Instance = { booted, box, base: `http://127.0.0.1:${port}`, stub };
  live.push(inst);
  return inst;
}

let shared: Promise<Instance> | undefined;
function instance(): Promise<Instance> {
  shared ??= startInstance();
  return shared;
}

afterEach(async () => {
  while (live.length > 0) {
    const inst = live.pop()!;
    await shutdown(inst.booted);
    inst.box.cleanup();
  }
  shared = undefined;
});

interface ApiResult {
  status: number;
  json: any;
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
  return { status: res.status, json };
}

/** 直接读库里的行：断言「逐字不动」要拿**存储事实**说话，不能只信响应体。 */
function rowOf(inst: Instance, recordId: string): RecordRow {
  return inst.booted.db
    .prepare("select * from capture_record where id = ?")
    .get(recordId) as unknown as RecordRow;
}

async function makeRecord(inst: Instance, text: string, mode: string): Promise<string> {
  const created = await call(inst, "POST", "/api/records", { text, processing_mode: mode });
  expect(created.status).toBe(201);
  const id = created.json.record.id as string;
  // A-0 起新建 cloud_redacted 默认 local_llm；这一批测的是「在 manual 与 local_llm 之间切」，
  // 把基线显式落回 manual，避免默认值变化把用例的前提悄悄换掉。
  if (mode === "cloud_redacted") {
    const manual = await call(inst, "PATCH", `/api/records/${id}/redaction-mode`, { redaction_mode: "manual" });
    expect(manual.status).toBe(200);
  }
  return id;
}

function axesOf(row: RecordRow): string {
  return `${row.analysis_provider}|${row.redaction_mode}|${row.send_content_mode}`;
}

const PATCHABLE = "周末和张三去了蓝山咖啡馆，电话 13800138000";

/* ── R1 合法切换：只改一轴，派生列重算 ───────────────────────────── */

describe("R1 —— 合法的脱敏档切换只改 redaction_mode", () => {
  it("cloud|manual|redacted ⇒ cloud|local_llm|redacted：另两轴逐字不动，派生列仍是 cloud_redacted", async () => {
    const inst = await instance();
    const id = await makeRecord(inst, PATCHABLE, "cloud_redacted");
    const before = rowOf(inst, id);
    expect(axesOf(before)).toBe("cloud|manual|redacted");

    const switched = await call(inst, "PATCH", `/api/records/${id}/redaction-mode`, {
      redaction_mode: "local_llm",
    });
    expect(switched.status).toBe(200);
    expect(switched.json.changed).toBe(true);
    expect(switched.json.record.processing_mode).toBe("cloud_redacted");

    const after = rowOf(inst, id);
    expect(axesOf(after)).toBe("cloud|local_llm|redacted");
    expect(after.processing_mode).toBe(before.processing_mode);
    // 另两轴逐字未变（M9-D-15 的全部要点：档位拆出来，别的那两轴不跟着动）。
    expect(after.analysis_provider).toBe(before.analysis_provider);
    expect(after.send_content_mode).toBe(before.send_content_mode);
    // 与脱敏档无关的列一律不许被顺手改写。
    expect(after.processing_status).toBe(before.processing_status);
    expect(after.current_revision_id).toBe(before.current_revision_id);
    expect(after.created_at_utc).toBe(before.created_at_utc);
    expect(after.created_local_date).toBe(before.created_local_date);
    expect(after.privacy_level).toBe(before.privacy_level);
  });

  it("反向切回 manual 同样成立（两档之间来回，派生列两次都是 cloud_redacted）", async () => {
    const inst = await instance();
    const id = await makeRecord(inst, PATCHABLE, "cloud_redacted");
    const toLlm = await call(inst, "PATCH", `/api/records/${id}/redaction-mode`, {
      redaction_mode: "local_llm",
    });
    expect(toLlm.status).toBe(200);
    const back = await call(inst, "PATCH", `/api/records/${id}/redaction-mode`, {
      redaction_mode: "manual",
    });
    expect(back.status).toBe(200);
    expect(back.json.changed).toBe(true);
    expect(axesOf(rowOf(inst, id))).toBe("cloud|manual|redacted");
    expect(rowOf(inst, id).processing_mode).toBe("cloud_redacted");
  });

  it("非外发记录也切得动：none|manual|none ⇒ none|local_llm|none（矩阵 #3），派生列仍是 manual_only", async () => {
    const inst = await instance();
    const id = await makeRecord(inst, "今天很烦", "manual_only");
    const before = rowOf(inst, id);
    const switched = await call(inst, "PATCH", `/api/records/${id}/redaction-mode`, {
      redaction_mode: "local_llm",
    });
    expect(switched.status).toBe(200);
    const after = rowOf(inst, id);
    expect(axesOf(after)).toBe("none|local_llm|none");
    expect(after.processing_mode).toBe("manual_only");
    // 脱敏档不参与外发判定（`isEgress` 只看 `send_content_mode`），所以状态一格都不该动。
    expect(after.processing_status).toBe(before.processing_status);
  });
});

/* ── R2 非法组合：400 且一个字节都不写 ───────────────────────────── */

describe("R2 —— 非法三轴组合被拒且零写入", () => {
  it("cloud_raw 的记录（cloud|none|raw）切到 manual 是非法组合 ⇒ 400，库里逐字不变", async () => {
    const inst = await instance();
    const id = await makeRecord(inst, PATCHABLE, "cloud_raw");
    const before = rowOf(inst, id);
    expect(axesOf(before)).toBe("cloud|none|raw");

    const rejected = await call(inst, "PATCH", `/api/records/${id}/redaction-mode`, {
      redaction_mode: "manual",
    });
    expect(rejected.status).toBe(400);
    expect(rejected.json.error).toBe("invalid_request");

    const after = rowOf(inst, id);
    expect(axesOf(after)).toBe("cloud|none|raw");
    expect(after.processing_mode).toBe(before.processing_mode);
    expect(after.processing_status).toBe(before.processing_status);
    expect(after.current_revision_id).toBe(before.current_revision_id);
  });

  it("local_model 的记录（local|manual|none）切到 none 是非法组合（矩阵 #6）⇒ 400，整行逐字不变", async () => {
    const inst = await instance();
    const id = await makeRecord(inst, "今天很烦", "local_model");
    const before = rowOf(inst, id);
    expect(axesOf(before)).toBe("local|manual|none");

    const rejected = await call(inst, "PATCH", `/api/records/${id}/redaction-mode`, {
      redaction_mode: "none",
    });
    expect(rejected.status).toBe(400);
    expect(rowOf(inst, id)).toEqual(before);
  });

  it("cloud_redacted 的记录切到 none 是非法组合（矩阵 #12）⇒ 400", async () => {
    const inst = await instance();
    const id = await makeRecord(inst, PATCHABLE, "cloud_redacted");
    const before = rowOf(inst, id);

    const rejected = await call(inst, "PATCH", `/api/records/${id}/redaction-mode`, {
      redaction_mode: "none",
    });
    expect(rejected.status).toBe(400);
    expect(rowOf(inst, id)).toEqual(before);
  });
});

/* ── R3 取值与键集合门 ───────────────────────────────────────────── */

describe("R3 —— 请求体的门：不在册的取值与多余键都是 400", () => {
  it("redaction_mode 取值不在册 ⇒ 400，detail 点名字段且 issues 只带字段名", async () => {
    const inst = await instance();
    const id = await makeRecord(inst, PATCHABLE, "cloud_redacted");
    const before = rowOf(inst, id);

    const rejected = await call(inst, "PATCH", `/api/records/${id}/redaction-mode`, {
      redaction_mode: "cloud_llm",
    });
    expect(rejected.status).toBe(400);
    expect(rejected.json.error).toBe("invalid_request");
    expect(rejected.json.issues).toEqual(["redaction_mode"]);
    expect(rowOf(inst, id)).toEqual(before);
  });

  it("非字符串 / 缺字段 / 多余键（.strict）⇒ 400", async () => {
    const inst = await instance();
    const id = await makeRecord(inst, PATCHABLE, "cloud_redacted");
    const path = `/api/records/${id}/redaction-mode`;

    expect((await call(inst, "PATCH", path, { redaction_mode: 7 })).status).toBe(400);
    expect((await call(inst, "PATCH", path, {})).status).toBe(400);
    expect(
      (await call(inst, "PATCH", path, { redaction_mode: "manual", send_content_mode: "raw" })).status,
    ).toBe(400);
    // 「顺手改别的轴」因此不可能发生。
    expect(axesOf(rowOf(inst, id))).toBe("cloud|manual|redacted");
  });

  it("方法不对 ⇒ 405（这条窄入口只认 PATCH）", async () => {
    const inst = await instance();
    const id = await makeRecord(inst, PATCHABLE, "cloud_redacted");
    const put = await call(inst, "PUT", `/api/records/${id}/redaction-mode`, { redaction_mode: "manual" });
    expect(put.status).toBe(405);
  });
});

/* ── R4 404 与幂等 ───────────────────────────────────────────────── */

describe("R4 —— 记录不存在 404；同值幂等不写库", () => {
  it("记录不存在 ⇒ 404", async () => {
    const inst = await instance();
    const missing = await call(inst, "PATCH", `/api/records/rec_不存在/redaction-mode`, {
      redaction_mode: "local_llm",
    });
    expect(missing.status).toBe(404);
    expect(missing.json.error).toBe("not_found");
  });

  it("同值再切一次 ⇒ changed:false，整行逐字不变", async () => {
    const inst = await instance();
    const id = await makeRecord(inst, PATCHABLE, "cloud_redacted");
    const first = await call(inst, "PATCH", `/api/records/${id}/redaction-mode`, {
      redaction_mode: "local_llm",
    });
    expect(first.json.changed).toBe(true);
    const snapshot = rowOf(inst, id);

    const again = await call(inst, "PATCH", `/api/records/${id}/redaction-mode`, {
      redaction_mode: "local_llm",
    });
    expect(again.status).toBe(200);
    expect(again.json.changed).toBe(false);
    expect(again.json.record.redaction_mode).toBe("local_llm");
    expect(rowOf(inst, id)).toEqual(snapshot);
  });
});

/* ── R5 零外发副作用 ─────────────────────────────────────────────── */

describe("R5 —— 切档不产生任何外发副作用", () => {
  it("grant / parse_run / app_meta / privacy_job 计数前后不变，Provider 桩零调用", async () => {
    const inst = await instance();
    const id = await makeRecord(inst, PATCHABLE, "cloud_redacted");
    // 先跑一次预览把缓存键落下去，再取基线：这样「不变」才真的 covers 预览缓存那一档。
    expect((await call(inst, "POST", "/api/ingest/preview", { recordId: id })).status).toBe(200);

    const before = {
      grants: countRows(inst.booted.db, "cloud_send_grant"),
      runs: countRows(inst.booted.db, "parse_run"),
      meta: countRows(inst.booted.db, "app_meta"),
      jobs: countRows(inst.booted.db, "privacy_job"),
      calls: inst.stub.callCount(),
    };
    expect(before.calls).toBe(0);

    const switched = await call(inst, "PATCH", `/api/records/${id}/redaction-mode`, {
      redaction_mode: "local_llm",
    });
    expect(switched.status).toBe(200);

    expect(countRows(inst.booted.db, "cloud_send_grant")).toBe(before.grants);
    expect(countRows(inst.booted.db, "parse_run")).toBe(before.runs);
    expect(countRows(inst.booted.db, "app_meta")).toBe(before.meta);
    expect(countRows(inst.booted.db, "privacy_job")).toBe(before.jobs);
    expect(inst.stub.callCount()).toBe(before.calls);
  });

  it("非法组合被拒时同样零副作用", async () => {
    const inst = await instance();
    const id = await makeRecord(inst, PATCHABLE, "cloud_raw");
    const before = {
      grants: countRows(inst.booted.db, "cloud_send_grant"),
      meta: countRows(inst.booted.db, "app_meta"),
      calls: inst.stub.callCount(),
    };
    expect(
      (await call(inst, "PATCH", `/api/records/${id}/redaction-mode`, { redaction_mode: "manual" })).status,
    ).toBe(400);
    expect(countRows(inst.booted.db, "cloud_send_grant")).toBe(before.grants);
    expect(countRows(inst.booted.db, "app_meta")).toBe(before.meta);
    expect(inst.stub.callCount()).toBe(before.calls);
  });
});

/* ── 共享封闭清单与服务端同源 ─────────────────────────────────────── */

describe("共享封闭清单与服务端逐字同集合", () => {
  it("LLM_FAILURE_KIND_DTO_VALUES == 服务端 LOCAL_LLM_FAILURE_KINDS", () => {
    expect([...LLM_FAILURE_KIND_DTO_VALUES]).toEqual([...LOCAL_LLM_FAILURE_KINDS]);
  });

  it("REDACTION_SOURCE_DTO_VALUES == 服务端 REDACTION_SOURCES", () => {
    expect([...REDACTION_SOURCE_DTO_VALUES]).toEqual([...REDACTION_SOURCES]);
  });
});

/* ── 前端判据本体（纯函数直接调用） ──────────────────────────────── */

/** 造一整份 tier DTO，只关心 usable / reason 两格。 */
function fakeTier(usable: boolean, reason: LocalLlmTierDto["reason"]): LocalLlmTierDto {
  return {
    enabled: !usable,
    provider: "ollama",
    model: "qwen3:8b",
    baseUrl: "http://example.invalid/v1",
    requestTimeoutMs: 30_000,
    supportsStructuredOutput: false,
    callPath: null,
    apiKeyEnv: null,
    loopback: usable,
    usable,
    reason,
  };
}

describe("redactionTier —— 档位判据与文案", () => {
  it("两选：当前默认在前，取值是 redaction_mode 的在册子集，两句标签互不相同", () => {
    expect([...REDACTION_TIERS]).toEqual<RedactionTier[]>(["manual", "local_llm"]);
    expect(REDACTION_TIER_LABEL.manual).toContain("规则");
    expect(REDACTION_TIER_LABEL.local_llm).toContain("本地模型");
    expect(REDACTION_TIER_LABEL.manual).not.toBe(REDACTION_TIER_LABEL.local_llm);
  });

  it("R6 禁用条件只依赖 usable：manual 恒可选，local_llm 当且仅当 usable", () => {
    expect(redactionTierEnabled("manual", false)).toBe(true);
    expect(redactionTierEnabled("manual", true)).toBe(true);
    expect(redactionTierEnabled("local_llm", false)).toBe(false);
    expect(redactionTierEnabled("local_llm", true)).toBe(true);
  });

  it("R6 不可用时的原因来自封闭枚举映射；这一档没配置 ⇒ not_configured 那一句", () => {
    expect(redactionTierUnavailableText(null)).toBe(localLlmFailureHeadline("not_configured"));
    for (const reason of ["not_configured", "disabled", "not_loopback", "no_model"] as const) {
      const text = redactionTierUnavailableText(fakeTier(false, reason));
      expect(text, reason).toBe(localLlmFailureHeadline(reason));
      expect(text.length).toBeGreaterThan(0);
    }
    // 可用 ⇒ 没有原因可说（返回空串，页面因此不画那一句）。
    expect(redactionTierUnavailableText(fakeTier(true, null))).toBe("");
  });

  it("原文轨不画档位行（raw 的 redaction_mode 恒为 none，任何切换都是非法组合）", () => {
    expect(showRedactionTierRow("redacted")).toBe(true);
    expect(showRedactionTierRow("raw")).toBe(false);
  });

  it("R7 三个来源各有一句人话，local_llm 一眼认得出来；不在册的值原样透出", () => {
    const labels = REDACTION_SOURCE_DTO_VALUES.map(redactionSourceLabel);
    expect(new Set(labels).size).toBe(labels.length);
    expect(redactionSourceLabel("local_llm")).toContain("本地模型");
    expect(redactionSourceLabel("rule")).not.toBe("rule");
    expect(redactionSourceLabel("made_up")).toBe("made_up");
  });

  it("R7 「这次本地模型没用上」：有封闭枚举原因就带上，没有就只说没用上", () => {
    expect(llmUnusedNoticeText(undefined)).toBe("这次本地模型没用上");
    expect(llmUnusedNoticeText("")).toBe("这次本地模型没用上");
    expect(llmUnusedNoticeText("timeout")).toContain("等了太久");
    // M9-8 起 timeout 那一格点名两种可能（太长 / 服务卡住），「超时」二字不再出现；
    // 这一条断言的意图不变：那一格仍然给出一句人话，而不是只剩标题。
    expect(llmUnusedNoticeText("timeout")).toContain("卡住");
    expect(llmUnusedNoticeText("not_loopback")).toContain("回环");
    for (const kind of LLM_FAILURE_KIND_DTO_VALUES) {
      expect(llmUnusedNoticeText(kind), kind).toContain("这次本地模型没用上");
      expect(llmUnusedNoticeText(kind), kind).not.toBe(llmUnusedNoticeText(undefined));
    }
  });

  it("R8 切档后那句提示说的是「重新预览并逐次确认」，档位读回只认在册值", () => {
    expect(tierSwitchedNotice("local_llm")).toContain("本地模型");
    expect(tierSwitchedNotice("local_llm")).toContain("确认");
    expect(tierSwitchedNotice("manual")).toContain("规则");
    expect(redactionTierOfMode("local_llm")).toBe("local_llm");
    expect(redactionTierOfMode("manual")).toBe("manual");
    expect(redactionTierOfMode("none")).toBeNull();
    expect(redactionTierOfMode("")).toBeNull();
  });
});

/* ── R6/R7/R8 页面源码级断言（沿 web-ui4-pages 手法） ─────────────── */

const WEB = join(process.cwd(), "src", "web");
function source(name: string): string {
  return readFileSync(join(WEB, name), "utf8");
}

describe("R6–R8 —— 发送区的档位行与预览标注（源码级）", () => {
  const panel = source("IngestPanel.tsx");
  const tier = source("redactionTier.ts");
  // 〔web-redesign 第三步〕档位行搬进「发送方式」弹窗，来源标签搬进遮蔽清单弹窗：
  // 判据没有放宽，只是落点跟着组件走。
  const method = source("ui/SendMethodDialog.tsx");
  const review = source("ui/SendReviewDialog.tsx");

  it("R6 档位行画两选，禁用判据只有 usable 一项", () => {
    expect(method).toContain("REDACTION_TIERS.map");
    expect(method).toContain("REDACTION_TIER_LABEL[");
    expect(method).toContain("redactionTierEnabled(");
    expect(method).toContain("props.localLlmUsable");
    expect(method).toContain("showRedactionTierRow(");
    // 面板只把「可不可用」与「为什么不可用」原样转交，不在页面里重算。
    expect(panel).toContain("localLlmUsable={localLlmUsable}");
    expect(panel).toContain("localLlmWhyNot={localLlmWhyNot}");
    // 判据本体的源码里读得到「只依赖 usable」：没有第二个条件、没有端点字符串。
    const enabled = /export function redactionTierEnabled\([\s\S]*?\n\}/.exec(tier);
    expect(enabled, "redactionTierEnabled 未导出").not.toBeNull();
    expect(enabled![0]).toMatch(/usable/);
    expect(enabled![0]).not.toMatch(/baseUrl|loopback|reason/);
  });

  it("R6 页面里不重算回环：127.0.0.1 / localhost 一个都不出现，原因走封闭枚举映射", () => {
    for (const name of ["IngestPanel.tsx", "redactionTier.ts", "ui/SendMethodDialog.tsx"]) {
      expect(source(name), name).not.toMatch(/127\.0\.0\.1/);
      expect(source(name), name).not.toMatch(/localhost/);
    }
    expect(panel).toContain("redactionTierUnavailableText");
    expect(tier).toContain("localLlmFailureHeadline");
  });

  it("R7 预览区逐条渲染来源标签与「没用上」提示；警示不改档位选择（不静默回落）", () => {
    expect(review).toContain("preview.spans");
    expect(review).toContain("redactionSourceLabel(");
    expect(panel).toContain("llmUnusedNoticeText(");
    expect(panel).toContain("llmLayer.used");
    expect(panel).not.toMatch(/setRedactionTier\(\s*"manual"/);
    expect(panel).not.toMatch(/redaction-mode[^"]*",\s*\{\s*redaction_mode: "manual"/);
  });

  it("R8 切档走 PATCH …/redaction-mode，且成功后确实重新拉一次预览", () => {
    const client = source("apiClient.ts");
    expect(client).toContain("/redaction-mode");
    expect(client).toContain("redaction_mode:");
    expect(panel).toContain("api.setRecordRedactionMode(");
    expect(panel).toContain("onSetRedactionTier");

    const switchRegion = /onSetRedactionTier=\{[\s\S]*?onClose=/.exec(panel);
    expect(switchRegion, "档位切换回调要被断言到").not.toBeNull();
    expect(switchRegion![0]).toContain("api.setRecordRedactionMode(");
    // 切档前旧预览与旧授权一起作废（与换轨同一手法）。
    expect(switchRegion![0]).toContain("setPreview(null)");
    expect(switchRegion![0]).toContain("setGrant(null)");
    // 重新取预览由预览键驱动：键里含记录轴上的 redactionMode，轴一变就 refetch 一份。
    expect(panel).toContain("selected.axes.redactionMode");
    expect(panel).toContain("refetchPreview()");
  });

  it("演示后端同形：fakeApi 也认这条窄入口，并按同一合法性判据拒", () => {
    const fake = source("fakeApi.ts");
    expect(fake).toContain("redaction-mode");
    expect(fake).toContain("isLegalCombination");
  });
});
