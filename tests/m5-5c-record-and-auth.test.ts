import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { dayHeading, needsAttention, recordListMeta } from "../src/web/projections.ts";
import type { RecordRow } from "../src/shared/dto.ts";

const WEB = join(process.cwd(), "src", "web");

function source(name: string): string {
  return readFileSync(join(WEB, name), "utf8");
}

function recordRow(over: Partial<RecordRow> = {}): RecordRow {
  return {
    id: "rec_000000000000000000000000000001",
    created_at_utc: "2026-10-16T05:04:05.123Z",
    created_at_local: "2026-10-16T13:04:05.123+08:00",
    timezone_id: "Asia/Shanghai",
    created_local_date: "2026-10-16",
    current_revision_id: "rev_000000000000000000000000000001",
    processing_status: "captured",
    processing_mode: "manual_only",
    privacy_level: "normal",
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
    expect(ingest).toContain("disabled={busy || !canStartOrganize}");
  });

  it("重新预览、确认候选和记录变更都会清掉旧 grant", () => {
    const previewAt = ingest.indexOf("onPreview={() =>");
    const candidatesAt = ingest.indexOf("onConfirmCandidates={(adopted)");
    const changedAt = ingest.indexOf("onChanged={() =>");
    for (const at of [previewAt, candidatesAt]) {
      expect(at).toBeGreaterThanOrEqual(0);
      expect(ingest.slice(at, at + 500)).toContain("setGrant(null)");
    }
    expect(changedAt).toBeGreaterThanOrEqual(0);
    expect(ingest.slice(changedAt, changedAt + 500)).toContain("resetDetail()");
  });

  it("409 只给用户一句可行动的话，服务端内部原因收进技术详情", () => {
    expect(ingest).toContain("cause.status === 409");
    expect(ingest).toContain("这次发送需要重新确认");
    expect(ingest).toContain("errorDetail");
    expect(ingest).toContain('["服务端原文", errorDetail]');
    expect(ingest).toContain('["原文 revision", preview.recordRevisionId]');
  });
});
