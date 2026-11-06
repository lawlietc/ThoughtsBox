import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { JOB_STATUS_LABEL } from "../src/web/ui/labels.ts";

/**
 * M6-1D-R「假后端的授权状态失真」专项验收。
 *
 * 现象（浏览器实测）：`npm run start:mock` 里点了「确认发送」，同一屏的预览再拉一次仍然
 * `hasApplicableGrant: false` ⇒ 「这份发送内容已确认过」与「这份发送内容还没有确认」同时上屏，
 * 连带 `canStartOrganize` 恒假（发起整理 / 排到后台处理两个按钮永远焊死）。
 *
 * 根因：`previewBody` 读的是 `SEED_BY_ID[...].grant`（fixture 里恒为 `null`，新建记录连种子都没有
 * ⇒ 恒假），而 `confirm-send` 只拼一份回包、从不记账。
 *
 * 本轮口径（与 `grantService.findApplicableGrant` 同源）：授权绑
 * `(recordRevisionId, payloadSha256, policyVersion, sendContentMode)` 四腿，任一不同都不算命中。
 * 失效不写代码：改写原文 ⇒ 新 revision；换轨 ⇒ `sendContentMode` 变。两条路都由四腿匹配自然落空。
 *
 * 驱动方式：这份假后端**只能真实调用**才能证伪「路由自己没记账」，而 `fakeApi.ts` 依赖 `window`、
 * 进不了根 tsconfig 的 node 程序（`m5-6-processing-defaults.test.ts` 里写明的那条限制）。
 * 这里用运行期动态 import 拿 `installFakeFetch()`，把 `globalThis.fetch` 换成那份路由，
 * 然后走 `fetch` 打真端点——不复制一份判据，也不 mock 掉被测对象。
 *
 * E 段那两个 `new Function` 与 `m6-1b-send-track.test.ts` 同一手法：编译的只有本仓自己这份
 * `IngestPanel.tsx` 源码里的片段（正则取不到就当场断言失败），不含任何外部输入。
 */

const WEB = join(process.cwd(), "src", "web");

function source(rel: string): string {
  return readFileSync(join(WEB, rel), "utf8");
}

interface PreviewDto {
  readonly recordId: string;
  readonly recordRevisionId: string;
  readonly revisionNumber: number;
  readonly policyVersion: string;
  readonly sendContentMode: string;
  readonly payloadText: string;
  readonly payloadSha256: string;
  readonly hasApplicableGrant: boolean;
}

interface GrantDto {
  readonly grantId: string;
  readonly recordRevisionId: string;
  readonly payloadSha256: string;
  readonly policyVersion: string;
  readonly confirmedAtUtc: string;
}

interface Reply<T> {
  readonly status: number;
  readonly json: T;
}

async function send<T>(method: string, path: string, body?: unknown): Promise<Reply<T>> {
  const res = await fetch(path, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, json: (await res.json()) as T };
}

const preview = (recordId: string) => send<PreviewDto>("POST", "/api/ingest/preview", { recordId });
const confirmSend = (recordId: string) => send<GrantDto>("POST", "/api/ingest/confirm-send", { recordId });
const setMode = (recordId: string, mode: string) =>
  send<{ record: { id: string }; changed: boolean }>("PATCH", `/api/records/${recordId}/mode`, {
    processing_mode: mode,
  });
const editText = (recordId: string, text: string) =>
  send<{ record: { current_revision_id: string }; revision: { id: string }; changed: boolean }>(
    "PUT",
    `/api/records/${recordId}`,
    { text },
  );

let textCounter = 0;

/** 每条断言各建一条新记录：登记表是模块级的运行期状态，不复用才谈得上「未确认时必假」。 */
async function newCloudRecord(mode: string): Promise<string> {
  textCounter += 1;
  const created = await send<{ record: { id: string }; revision: { id: string } }>(
    "POST",
    "/api/records",
    { text: `M6-1D-R 第 ${textCounter} 条：张三在开会，聊到量子计算。`, processing_mode: mode },
  );
  expect(created.status, `建记录（${mode}）`).toBe(201);
  return created.json.record.id;
}

let restoreFetch: (() => void) | null = null;

beforeAll(async () => {
  const spec = new URL("../src/web/fakeApi.ts", import.meta.url).href;
  const fakeApi = (await import(/* @vite-ignore */ spec)) as { installFakeFetch: () => () => void };
  restoreFetch = fakeApi.installFakeFetch();
});

afterAll(() => {
  restoreFetch?.();
  restoreFetch = null;
});

/* ══════════════════════════════════════════════════════════════════
 * A. 新记录：确认动作在假后端真的记了账
 * ══════════════════════════════════════════════════════════════════ */

describe("M6-1D-R · 新记录的确认链", () => {
  it("未确认 ⇒ false；确认 ⇒ 同一 revision 同轨 true（这一对在同一屏上不再自相矛盾）", async () => {
    const recordId = await newCloudRecord("cloud_redacted");

    const before = await preview(recordId);
    expect(before.status).toBe(200);
    expect(before.json.hasApplicableGrant).toBe(false);

    const confirmed = await confirmSend(recordId);
    expect(confirmed.status).toBe(200);

    const after = await preview(recordId);
    expect(after.json.recordRevisionId).toBe(before.json.recordRevisionId);
    expect(after.json.hasApplicableGrant).toBe(true);
  });

  it("记进登记表的就是这份预览给出的那四条腿（两处不许各算一遍）", async () => {
    const recordId = await newCloudRecord("cloud_redacted");
    const p = await preview(recordId);
    const grant = await confirmSend(recordId);

    expect(grant.json.recordRevisionId).toBe(p.json.recordRevisionId);
    expect(grant.json.payloadSha256).toBe(p.json.payloadSha256);
    expect(grant.json.policyVersion).toBe(p.json.policyVersion);
    // 载荷逐字等于预览文本：确认的是「这一份内容」，不是别的什么哈希。
    expect(grant.json.payloadSha256).not.toBe("");
    expect(p.json.payloadText).not.toBe("");
  });

  it("同一 revision + 同一轨道重复确认 ⇒ 覆盖同一张条子，不多签一张", async () => {
    const recordId = await newCloudRecord("cloud_redacted");
    await preview(recordId);
    const first = await confirmSend(recordId);
    const second = await confirmSend(recordId);

    expect(second.json.grantId).toBe(first.json.grantId);
    expect(second.json.confirmedAtUtc).toBe(first.json.confirmedAtUtc);
    expect((await preview(recordId)).json.hasApplicableGrant).toBe(true);
  });
});

/* ══════════════════════════════════════════════════════════════════
 * B. 四腿之「轨道」：旧授权不跨轨命中，切回来条子还在
 * ══════════════════════════════════════════════════════════════════ */

describe("M6-1D-R · 授权不跨发送轨道", () => {
  it("脱敏轨确认后切到原文轨 ⇒ false；切回脱敏轨 ⇒ 又是 true（那张条子仍有效）", async () => {
    const recordId = await newCloudRecord("cloud_redacted");
    const redactedPreview = await preview(recordId);
    const granted = await confirmSend(recordId);
    expect((await preview(recordId)).json.hasApplicableGrant).toBe(true);

    const switched = await setMode(recordId, "cloud_raw");
    expect(switched.json.changed).toBe(true);
    const rawPreview = await preview(recordId);
    expect(rawPreview.json.sendContentMode).toBe("raw");
    expect(rawPreview.json.hasApplicableGrant).toBe(false);
    // 假侧两条轨道的载荷文本同文（没有真脱敏），哈希逐字相同 ⇒ 这一格 false 只能来自
    // `sendContentMode` 那一腿本身在参与匹配，而不是被载荷差异顺带遮掉。
    expect(rawPreview.json.payloadSha256).toBe(redactedPreview.json.payloadSha256);

    await setMode(recordId, "cloud_redacted");
    const backAgain = await preview(recordId);
    expect(backAgain.json.sendContentMode).toBe("redacted");
    expect(backAgain.json.hasApplicableGrant).toBe(true);
    // 切回来再确认一次拿到的还是同一张条子：证明命中的是既有登记，不是重签。
    const reConfirm = await confirmSend(recordId);
    expect(reConfirm.json.grantId).toBe(granted.json.grantId);
  });

  it("反向同样成立：原文轨的授权对脱敏轨不可见（双向不跨轨）", async () => {
    const recordId = await newCloudRecord("cloud_raw");
    await preview(recordId);
    await confirmSend(recordId);
    expect((await preview(recordId)).json.hasApplicableGrant).toBe(true);

    await setMode(recordId, "cloud_redacted");
    const moved = await preview(recordId);
    expect(moved.json.sendContentMode).toBe("redacted");
    expect(moved.json.hasApplicableGrant).toBe(false);
  });
});

/* ══════════════════════════════════════════════════════════════════
 * C. 四腿之「版本」：改写原文 ⇒ 新 revision 不继承授权
 * ══════════════════════════════════════════════════════════════════ */

describe("M6-1D-R · 改写原文之后旧授权自然失效", () => {
  it("确认后改原文：两条轨道都 false（新 revision 一条都没继承）", async () => {
    const recordId = await newCloudRecord("cloud_redacted");
    const before = await preview(recordId);
    await confirmSend(recordId);
    expect((await preview(recordId)).json.hasApplicableGrant).toBe(true);

    const edited = await editText(recordId, "改过的原文：张三在开会，聊到量子计算，后来又补了一句。");
    expect(edited.json.changed).toBe(true);
    expect(edited.json.revision.id).not.toBe(before.json.recordRevisionId);

    const onRedacted = await preview(recordId);
    expect(onRedacted.json.recordRevisionId).toBe(edited.json.revision.id);
    expect(onRedacted.json.hasApplicableGrant).toBe(false);

    // 旧那条脱敏授权在这条记录的原文轨上同样不相干：两轨各自重新确认过才算。
    await setMode(recordId, "cloud_raw");
    const onRaw = await preview(recordId);
    expect(onRaw.json.sendContentMode).toBe("raw");
    expect(onRaw.json.hasApplicableGrant).toBe(false);
  });

  it("新 revision 上重新确认 ⇒ 这一轨 true，另一轨仍然 false（两张条子互不覆盖）", async () => {
    const recordId = await newCloudRecord("cloud_redacted");
    await preview(recordId);
    await confirmSend(recordId);
    await editText(recordId, "又改了一次：量子计算那段删掉了。");

    await setMode(recordId, "cloud_raw");
    await preview(recordId);
    const rawGrant = await confirmSend(recordId);
    expect((await preview(recordId)).json.hasApplicableGrant).toBe(true);

    await setMode(recordId, "cloud_redacted");
    expect((await preview(recordId)).json.hasApplicableGrant).toBe(false);

    const redactedGrant = await confirmSend(recordId);
    expect(redactedGrant.json.grantId).not.toBe(rawGrant.json.grantId);
    await setMode(recordId, "cloud_raw");
    expect((await preview(recordId)).json.hasApplicableGrant).toBe(true);
  });

  it("空 diff 编辑不建版 ⇒ 四腿未变 ⇒ 授权仍在（失效只由版本与轨道触发）", async () => {
    const recordId = await newCloudRecord("cloud_redacted");
    const p = await preview(recordId);
    await confirmSend(recordId);

    const edited = await editText(recordId, p.json.payloadText);
    expect(edited.json.changed).toBe(false);
    expect((await preview(recordId)).json.hasApplicableGrant).toBe(true);
  });
});

/* ══════════════════════════════════════════════════════════════════
 * D. 种子记录
 * ══════════════════════════════════════════════════════════════════ */

describe("M6-1D-R · 种子记录不因为「是种子」就默认已授权", () => {
  it("种子记录（rec_01，cloud_redacted）未确认前 false；确认之后才 true", async () => {
    const list = await send<{ records: { id: string }[] }>("GET", "/api/records?limit=100");
    expect(list.json.records.some((row) => row.id === "rec_01"), "rec_01 在册").toBe(true);

    const before = await preview("rec_01");
    expect(before.status).toBe(200);
    expect(before.json.hasApplicableGrant, "种子记录未确认前不得报成已授权").toBe(false);

    await confirmSend("rec_01");
    expect((await preview("rec_01")).json.hasApplicableGrant).toBe(true);
  });
});

/* ══════════════════════════════════════════════════════════════════
 * E. 文案层锚点：确认之后按钮真的能亮
 * ══════════════════════════════════════════════════════════════════ */

const INGEST = source("IngestPanel.tsx");
const CAN_START_EXPR = /const canStartOrganize = ([^;]+);/.exec(INGEST)?.[1];

function evalCanStartOrganize(preview: PreviewDto | null, egressSelected: boolean, parseReady: boolean): boolean {
  expect(CAN_START_EXPR, "canStartOrganize 的判据要被断言到").not.toBeUndefined();
  return new Function("egressSelected", "parseReady", "preview", `return (${CAN_START_EXPR});`)(
    egressSelected,
    parseReady,
    preview,
  ) as boolean;
}

function evalDisabled(expr: string, canStartOrganize: boolean, busy = false, stageEnabled = true): boolean {
  return new Function("busy", "canStartOrganize", "stagePrimaryEnabled", "stage", `return (${expr});`)(
    busy,
    canStartOrganize,
    () => stageEnabled,
    "ready",
  ) as boolean;
}

/** 「排到后台处理」那次的一次性提示模板（同一个 `setOutcome` 里的那一句反引号串）。 */
const ENQUEUE_OUTCOME_EXPR =
  /const queued = await api\.enqueueJob\([^)]*\);[\s\S]*?setOutcome\(\s*(`[^`]*`),\s*\)/.exec(INGEST)?.[1];

function evalEnqueueOutcome(status: string): string {
  expect(ENQUEUE_OUTCOME_EXPR, "入队提示的模板串要被断言到").not.toBeUndefined();
  return new Function("JOB_STATUS_LABEL", "queued", `return (${ENQUEUE_OUTCOME_EXPR});`)(
    JOB_STATUS_LABEL,
    { status },
  ) as string;
}

describe("M6-1D-R · 锚点：确认之后「发起整理」与「排到后台处理」能亮", () => {
  it("真取一份预览：确认前判据为假，确认后为真——亮的是授权这一腿", async () => {
    const recordId = await newCloudRecord("cloud_raw");
    const before = await preview(recordId);
    expect(evalCanStartOrganize(before.json, true, true)).toBe(false);

    await confirmSend(recordId);
    const after = await preview(recordId);
    expect(evalCanStartOrganize(after.json, true, true)).toBe(true);
  });

  it("两个按钮共用同一道阶段闸门，且授权那一腿仍能把「排到后台」放行", async () => {
    const recordId = await newCloudRecord("cloud_raw");
    await preview(recordId);
    await confirmSend(recordId);
    const granted = await preview(recordId);
    const canStart = evalCanStartOrganize(granted.json, true, true);
    expect(canStart).toBe(true);

    // 〔web-redesign 第三步〕主键的动词由阶段决定：缺授权时阶段是 `needs-grant`，点它的那一下
    // 只打开确认框（不发请求），所以主键本身由阶段机把关；真正外发的「排到后台」仍由
    // `canStartOrganize` 额外钉死——这一条没有放宽。
    const primary = /<button\s+className="btn primary"\s+disabled=\{([^}]+)\}/.exec(INGEST)?.[1] ?? "";
    expect(primary).toBe("busy || !stagePrimaryEnabled(stage)");
    expect(evalDisabled(primary, canStart), "已授权：主键可点").toBe(false);

    const secondary = /<button\s+className="ingest-side"\s+disabled=\{([^}]+)\}/.exec(INGEST)?.[1] ?? "";
    expect(secondary).toBe("busy || !canStartOrganize || !stagePrimaryEnabled(stage)");
    expect(evalDisabled(secondary, canStart), "已授权：排到后台可点").toBe(false);
    expect(evalDisabled(secondary, false), "没授权：排到后台点不动").toBe(true);
  });

  it("文案同一份数据源：阶段名与动作词都来自 ingestStage.ts，页面不另写一份", async () => {
    const recordId = await newCloudRecord("cloud_raw");
    const before = await preview(recordId);
    // 确认前后都必须由同一份判据（记录轴 + 预览的授权格）决定，不另立一个布尔。
    expect(evalCanStartOrganize(before.json, true, true)).toBe(false);

    const stage = source("ingestStage.ts");
    expect(stage).toContain("export const INGEST_STAGE_LABEL");
    expect(stage).toContain("export const INGEST_STAGE_ACTION");
    expect(INGEST).toContain("INGEST_STAGE_LABEL[stage]");
    expect(INGEST).toContain("INGEST_STAGE_ACTION[stage]");
    // 顶部那枚「本次发送已授权」badge 读的是同一个字段——自相矛盾的正源就是这里两处不同步。
    expect(INGEST).toContain("hasGrant: preview?.hasApplicableGrant === true,");
    expect(INGEST).not.toContain("这份发送内容还没有确认");
  });

  it("非外发记录不受这道门约束（判据的另一半仍然成立）", async () => {
    const recordId = await newCloudRecord("local_model");
    const p = await preview(recordId);
    expect(p.json.hasApplicableGrant).toBe(false);
    expect(evalCanStartOrganize(p.json, false, true)).toBe(true);
  });

  it("解析未就绪那半句不受本轮影响：判据里授权不能替 parseReady 点头", async () => {
    const recordId = await newCloudRecord("cloud_raw");
    await preview(recordId);
    await confirmSend(recordId);
    const granted = await preview(recordId);
    expect(granted.json.hasApplicableGrant).toBe(true);
    expect(evalCanStartOrganize(granted.json, true, false)).toBe(false);
  });

  it("入队提示只讲一遍状态：句首不许再把 JOB_STATUS_LABEL 的取值复述一次（1D-R2）", () => {
    // 实测那两句：状态行「后台状态：已排到后台，等待处理」+ 一次性提示「已排到后台：已排到后台，等待处理。…」
    // 后一句把同一档标签说了两遍。提示从此以标签本身开头，前缀不再存在。
    expect(evalEnqueueOutcome("queued")).toBe(
      "已排到后台，等待处理。处理完这一条会自己写完，不用守着这一屏。",
    );
    expect(evalEnqueueOutcome("queued")).not.toContain("已排到后台：");

    for (const status of Object.keys(JOB_STATUS_LABEL)) {
      const label = JOB_STATUS_LABEL[status] ?? status;
      const outcome = evalEnqueueOutcome(status);
      expect(outcome, `${status}：提示以此档标签开头`).toBe(`${label}。处理完这一条会自己写完，不用守着这一屏。`);
      // 同档标签在句子里出现两次 = 有人把前缀加回去了。
      expect(outcome.split(label).length - 1, `${status}：标签不得重复`).toBe(1);
    }
  });
});

/* ══════════════════════════════════════════════════════════════════
 * F. 源码层：死引用删净，两处取值同源
 * ══════════════════════════════════════════════════════════════════ */

describe("M6-1D-R · 假后端源码面", () => {
  const fake = source("fakeApi.ts");

  it("对 `SEED_BY_ID[...].grant` 的死引用（恒假那条路子）已经删净", () => {
    expect(fake).not.toMatch(/SEED_BY_ID/);
    expect(fake).not.toMatch(/hasApplicableGrant: SEED/);
  });

  it("预览与确认发送共用同一份取值函数：假摘要在整份文件里只算一处", () => {
    expect([...fake.matchAll(/payloadSha256: fakeSha256\(/g)]).toHaveLength(1);
    const previewBody = /function previewBody\(rec: FakeRecord\): SendPreviewDto \{[\s\S]*?\n\}/.exec(fake)?.[0] ?? "";
    const grantBody = /function grantBody\(rec: FakeRecord\): GrantDto \{[\s\S]*?\n\}/.exec(fake)?.[0] ?? "";
    expect(previewBody, "previewBody 要被断言到").not.toBe("");
    expect(grantBody, "grantBody 要被断言到").not.toBe("");
    expect(previewBody).toContain("previewFields(rec)");
    expect(grantBody).toContain("issueFakeGrant(previewFields(rec))");
    expect(previewBody).toContain("findApplicableGrant(fields) !== null");
  });

  it("登记表是运行期的、按 (revision, 轨道) 一张条子；匹配看四腿", () => {
    expect(fake).toMatch(/const FAKE_GRANTS = new Map<string, FakeGrantRow>\(\);/);
    const find = /function findApplicableGrant\(fields: GrantLegs\): FakeGrantRow \| null \{[\s\S]*?\n\}/.exec(fake)?.[0] ?? "";
    expect(find, "findApplicableGrant 要被断言到").not.toBe("");
    for (const leg of ["recordRevisionId", "sendContentMode", "payloadSha256", "policyVersion"]) {
      expect(find, `四腿少了 ${leg}`).toContain(leg);
    }
    // 失效靠四腿匹配，不靠清表：登记这一段里不许出现 delete / clear。
    const registry = fake.slice(fake.indexOf("const FAKE_GRANTS"), fake.indexOf("function previewBody"));
    expect(registry).not.toMatch(/\.delete\(|\.clear\(/);
  });

  it("确认发送与预览走的还是原来那两条既有端点，没为 mock 新开端点", () => {
    expect(fake).toContain('if (path === "/api/ingest/preview")');
    expect(fake).toContain('if (path === "/api/ingest/confirm-send")');
    expect(fake).not.toMatch(/\/api\/[a-z/-]*grant/i);
  });
});
