import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { dayHeading, needsAttention, recordListMeta } from "../src/web/projections.ts";
import { axesForProcessingMode, isProcessingModeValue } from "../src/shared/contracts/enums.ts";
import type { RecordRow } from "../src/shared/dto.ts";

const WEB = join(process.cwd(), "src", "web");

function source(name: string): string {
  return readFileSync(join(WEB, name), "utf8");
}

function recordRow(over: Partial<RecordRow> = {}): RecordRow {
  const mode = over.processing_mode ?? "manual_only";
  if (!isProcessingModeValue(mode)) throw new Error(`夹具写入了契约外的 processing_mode：${mode}`);
  const axes = axesForProcessingMode(mode);
  return {
    id: "rec_000000000000000000000000000001",
    created_at_utc: "2026-10-16T05:04:05.123Z",
    created_at_local: "2026-10-16T13:04:05.123+08:00",
    timezone_id: "Asia/Shanghai",
    created_local_date: "2026-10-16",
    current_revision_id: "rev_000000000000000000000000000001",
    processing_status: "captured",
    processing_mode: mode,
    privacy_level: "normal",
    // M6-0C：派生列与三轴必须成对出现（0008 的表级 CHECK 在库里就是这么要求的）。
    analysis_provider: axes.analysisProvider,
    redaction_mode: axes.redactionMode,
    send_content_mode: axes.sendContentMode,
    ...over,
  };
}

describe("M5-5C · 记录列表按日分组、普通行不再显示模式", () => {
  it("日期标题是本地自然日，不从 ISO 时间截出 UTC 日期", () => {
    expect(dayHeading("2026-10-19")).toBe("2026 年 10 月 19 日");
    expect(dayHeading("not-a-date")).toBe("not-a-date");
  });

  it("只有需要行动的状态出现在列表主层；普通记录只留时间", () => {
    expect(recordListMeta(recordRow())).toBe("13:04");
    expect(recordListMeta(recordRow({ processing_status: "parsed", processing_mode: "cloud_redacted" }))).toBe(
      "13:04",
    );
    expect(recordListMeta(recordRow({ processing_status: "failed" }))).toBe("13:04 · 整理失败");
    expect(recordListMeta(recordRow({ processing_status: "needs_reparse" }))).toBe(
      "13:04 · 原文已改，待重新整理",
    );
    expect(needsAttention("parsed")).toBe(false);
    expect(needsAttention("processing")).toBe(true);
  });

  it("全部记录页把日期作为分组键，盒子 / 搜索仍可复用同一个列表", () => {
    const list = source("RecordList.tsx");
    const records = source("RecordsPanel.tsx");
    expect(list).toContain("groupByDate?: boolean");
    expect(list).toContain('className="record-groups"');
    expect(list).toContain('className="record-day"');
    expect(records).toContain("recordListMeta(row)");
    expect(records).toContain("dayHeading(row.created_local_date)");
    expect(records).toContain("groupByDate");
  });
});

describe("M5-5C · 云端授权以最新预览为准", () => {
  const ingest = source("IngestPanel.tsx");

  it("没有可适用授权时，云端整理按钮不可点", () => {
    expect(ingest).toContain("const canStartOrganize =");
    expect(ingest).toContain("preview?.hasApplicableGrant === true");
    // 〔web-redesign 第三步〕主键在缺授权时由阶段机判为 `needs-grant`：点它只打开确认框、
    // 不发请求；真正会外发的「排到后台」那颗仍由 `canStartOrganize` 钉死。
    expect(ingest).toContain("disabled={busy || !canStartOrganize || !stagePrimaryEnabled(stage)}");
    expect(ingest).toContain("disabled={busy || !stagePrimaryEnabled(stage)}");
  });

  it("重新预览和记录变更都会清掉旧 grant", () => {
    // 〔web-redesign 第三步〕原来的 `onPreview` 入口换成了 `refetchPreview`（页面自己驱动重取），
    // 清授权这件事没有变；记录变更仍走 `onChanged`。
    const refetchAt = ingest.indexOf("async function refetchPreview");
    expect(refetchAt).toBeGreaterThanOrEqual(0);
    expect(ingest.slice(refetchAt, refetchAt + 500)).toContain("setGrant(null)");
    const changedAt = ingest.indexOf("onChanged={() =>");
    expect(changedAt).toBeGreaterThanOrEqual(0);
    expect(ingest.slice(changedAt, changedAt + 500)).toContain("resetDetail()");
  });

  it("409 只给用户一句可行动的话，服务端内部原因收进技术详情", () => {
    // 〔S7〕409 的映射收进 `failureActions.ts`（按服务端错误码，不按状态码二次分类）：
    // 主文案说人话，错误码 / `detail` 只放进折叠的技术详情。
    const failure = source("failureActions.ts");
    expect(failure).toContain('case "state_conflict":');
    expect(failure).toContain("这一步现在不能做");
    expect(failure).toContain("cause.detail");
    expect(failure).toContain("function technicalOf(");
    expect(ingest).toContain("failurePlanOf");
    expect(ingest).toContain("FailureSurface");
  });
});
