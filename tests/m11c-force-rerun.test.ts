/**
 * M11c 专项测试：「重跑脱敏」的强制重跑（裁决 F-1…F-5）。
 *
 * 根因：`resolveLocalLlmPreview` 只要 `hasCachedLlmSpans(rev)` 为真就复现已缓存结果、不再咨询
 * 模型；点「重跑脱敏」等于把同一份缓存再算一遍 ⇒ 毫秒返回、内容逐字不变 ⇒ 看起来「没反应」。
 *
 * 本批只钉两件事（都是「让重跑真的重跑」）：
 *  1. **F-2 服务层**：`GrantService.clearLlmTierCache` 把本地模型档这一版的三枚缓存键
 *     （nonce / payload / spans）与失败标记一并删掉，而规则档 `preview_*` 一字不动。
 *  2. **F-2/F-3 接线**：op6 预览在 `force:true` 时才清缓存；前端「重跑脱敏」唯一的调用点
 *     `retryLocalLlm` 带 `force:true`；弹窗把失败主文案（`retryError`）读进弹窗内。
 *
 * vitest environment 是 node（无 DOM），接线断言沿用本仓惯例做源码级扫描；服务层用真实
 * `TB_DATA_DIR` 沙箱数据库。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { Database } from "../src/server/db/adapter.ts";
import { migrate } from "../src/server/db/migrator.ts";
import { GrantService, LOCAL_LLM_FAILURE_KINDS } from "../src/server/privacy/grantService.ts";
import { RecordService } from "../src/server/records/service.ts";
import { makeSandbox, openSandboxDb, type Sandbox } from "./helpers/sandbox.ts";

/* ── 夹具 ──────────────────────────────────────────────────────────── */

const RAW = "周末和张三去了蓝山咖啡馆";
const ZHANG = "张三";
const at = (term: string): number => {
  const index = RAW.indexOf(term);
  if (index < 0) throw new Error(`夹具文本里没有 ${term}`);
  return index;
};

let sandbox: Sandbox | undefined;
let db: Database | undefined;
let records: RecordService;
let grants: GrantService;

function setup(): { recordId: string; revisionId: string } {
  sandbox = makeSandbox("tb-m11c-");
  db = openSandboxDb(sandbox.layout);
  migrate(db);
  records = new RecordService(db, {
    timezoneId: "Asia/Shanghai",
    now: () => new Date("2026-11-06T01:00:00.000Z"),
  });
  grants = new GrantService(db, { now: () => new Date("2026-11-06T01:00:00.000Z") });
  const created = records.createRecord(RAW, "cloud_redacted");
  records.setRedactionMode(created.record.id, "local_llm");
  return { recordId: created.record.id, revisionId: created.revision.id };
}

afterEach(() => {
  db?.close();
  sandbox?.cleanup();
  db = undefined;
  sandbox = undefined;
});

/* ── F-2 服务层 ────────────────────────────────────────────────────── */

describe("F-2 clearLlmTierCache：清本地模型档缓存，规则档不动", () => {
  it("清掉本地模型档三键 + 失败标记，且不动规则档", () => {
    const { revisionId } = setup();

    // 规则档先种一份（清缓存不该碰到它）。
    grants.preparePreview(revisionId, { tier: "rules" });
    expect(grants.hasCachedPayload(revisionId, "rules")).toBe(true);

    // 本地模型档：首预览给了 llmSpans ⇒ 落 nonce/payload/spans 三键。
    grants.preparePreview(revisionId, {
      tier: "local_llm",
      llmSpans: [{ kind: "person", start: at(ZHANG), end: at(ZHANG) + ZHANG.length }],
    });
    expect(grants.hasCachedLlmSpans(revisionId)).toBe(true);
    expect(grants.hasCachedPayload(revisionId, "local_llm")).toBe(true);
    expect(grants.llmSpanCount(revisionId)).toBe(1);

    // 再补一枚失败标记（模拟「这一档失败过」），clearLlmTierCache 应把它一并删掉。
    grants.markLlmConsultFailed(revisionId, LOCAL_LLM_FAILURE_KINDS[0]!);
    expect(grants.llmConsultFailedKind(revisionId)).toBe(LOCAL_LLM_FAILURE_KINDS[0]);

    grants.clearLlmTierCache(revisionId);

    // 本地模型档三键 + 失败标记全清 ⇒ 下次预览必然重新咨询模型。
    expect(grants.hasCachedLlmSpans(revisionId)).toBe(false);
    expect(grants.hasCachedPayload(revisionId, "local_llm")).toBe(false);
    expect(grants.llmSpanCount(revisionId)).toBe(0);
    expect(grants.llmConsultFailedKind(revisionId)).toBeUndefined();

    // 规则档一字不动。
    expect(grants.hasCachedPayload(revisionId, "rules")).toBe(true);
  });
});

/* ── F-2/F-3 接线（源码级） ────────────────────────────────────────── */

const ROOT = process.cwd();
function readSource(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

describe("F-2/F-3 接线：force 只在 op6 预览、只在前端「重跑脱敏」处触发", () => {
  it("op6 预览带 force:true 时调用 clearLlmTierCache", () => {
    const src = readSource("src/server/api/ingestRoutes.ts");
    expect(src).toContain("force: z.boolean().optional()");
    expect(src).toContain("if (parsed.force === true)");
    expect(src).toContain("clearLlmTierCache(record.current_revision_id)");
  });

  it("前端「重跑脱敏」传 force:true，apiClient 允许 force 透传，弹窗读 retryError", () => {
    const api = readSource("src/web/apiClient.ts");
    expect(api).toContain("force?: boolean");

    const panel = readSource("src/web/IngestPanel.tsx");
    expect(panel).toContain("api.ingestPreview({ recordId, force: true })");
    expect(panel).toContain("retryError={failure !== null ? failure.headline : null}");

    const dialog = readSource("src/web/ui/SendReviewDialog.tsx");
    expect(dialog).toContain("retryError?: string | null");
    expect(dialog).toContain("{props.retryError}");
  });

  it("重跑期间只留「关闭」可点：关闭键不因 busy 禁用，另两颗由 busy/retrying 禁用", () => {
    const dialog = readSource("src/web/ui/SendReviewDialog.tsx");
    // 关闭键：不再挂在 `disabled={props.busy}` 上，关窗随时可点（操作在后台继续）。
    expect(dialog).not.toMatch(/<button className="btn" disabled=\{props\.busy\} onClick=\{props\.onClose\}/);
    expect(dialog).toMatch(/<button className="btn" onClick=\{props\.onClose\}>/);
    // 「重跑脱敏」与「确认整理」在重跑/忙碌时仍禁用。
    expect(dialog).toContain("disabled={props.busy || props.retrying === true}");
    expect(dialog).toContain("disabled={props.busy || props.retrying === true || props.preview === null}");
  });
});
