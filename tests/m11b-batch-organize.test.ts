import { describe, expect, it } from "vitest";

import { ApiError } from "../src/web/apiClient.ts";
import { runBatchOrganize, summarizeBatchOrganize, type BatchOrganizeTarget } from "../src/web/batchOrganize.ts";
import { buildInboxRows } from "../src/web/inbox.ts";
import type { PendingRecordDto, ReviewQueueEntryDto } from "../src/shared/dto.ts";
import { axesForProcessingMode } from "../src/shared/contracts/enums.ts";

/**
 * M11b：待整理收件箱简化的两个新纯逻辑面（2026-11-06 设计 · D-2/D-3）。
 *  · `batchOrganize.ts`：勾选 ⇒ 「要确认 / 可直接整理」的计数与两种模式的串行编排；
 *  · `inbox.ts`：行上的 `hasGrant / selectable / organizable` 三个新字段。
 */

const T = (recordId: string, needsConfirm: boolean): BatchOrganizeTarget => ({ recordId, needsConfirm });

describe("M11b · summarizeBatchOrganize", () => {
  it("按 recordId 去重，分别数出需要确认与可直接整理", () => {
    expect(summarizeBatchOrganize([T("a", true), T("b", false), T("a", true)])).toEqual({
      total: 2,
      needsConfirm: 1,
      ready: 1,
    });
  });
});

describe("M11b · runBatchOrganize", () => {
  it("confirm-and-organize：未确认先签再整理，已确认直接整理，顺序稳定", async () => {
    const calls: string[] = [];
    const outcome = await runBatchOrganize([T("a", true), T("b", false)], "confirm-and-organize", {
      confirm: async (id) => {
        calls.push(`confirm:${id}`);
      },
      organize: async (id) => {
        calls.push(`organize:${id}`);
        return { succeeded: true };
      },
    });
    expect(outcome).toEqual({ organized: ["a", "b"], skipped: [], failed: [] });
    expect(calls).toEqual(["confirm:a", "organize:a", "organize:b"]);
  });

  it("organize-confirmed-only：跳过未确认，只整理已确认", async () => {
    const outcome = await runBatchOrganize([T("a", true), T("b", false)], "organize-confirmed-only", {
      confirm: async () => {
        throw new Error("不该签授权");
      },
      organize: async () => ({ succeeded: true }),
    });
    expect(outcome.organized).toEqual(["b"]);
    expect(outcome.skipped).toEqual(["a"]);
    expect(outcome.failed).toEqual([]);
  });

  it("一条整理失败不连坐：成功的照常收齐，失败的记 organize_failed", async () => {
    const outcome = await runBatchOrganize([T("x", false), T("y", false)], "confirm-and-organize", {
      confirm: async () => ({}),
      organize: async (id) => ({ succeeded: id === "y" }),
    });
    expect(outcome.organized).toEqual(["y"]);
    expect(outcome.failed).toEqual([{ recordId: "x", reason: "organize_failed" }]);
  });

  it("确认阶段的网络错误落 network；非 ApiError 落 confirm_failed", async () => {
    const network = await runBatchOrganize([T("a", true)], "confirm-and-organize", {
      confirm: async () => {
        throw new ApiError(0, "network_error", "连不上", [], null);
      },
      organize: async () => ({ succeeded: true }),
    });
    expect(network.failed).toEqual([{ recordId: "a", reason: "network" }]);

    const other = await runBatchOrganize([T("b", true)], "confirm-and-organize", {
      confirm: async () => {
        throw new Error("boom");
      },
      organize: async () => ({ succeeded: true }),
    });
    expect(other.failed).toEqual([{ recordId: "b", reason: "confirm_failed" }]);
  });
});

describe("M11b · inbox 行上的新字段（D-2）", () => {
  const pendingRow = (overrides: Partial<PendingRecordDto> = {}): PendingRecordDto => ({
    recordId: "p1",
    currentRevisionId: "r1",
    processingStatus: "captured",
    processingMode: "local_model",
    axes: axesForProcessingMode("local_model"),
    privacyLevel: "normal",
    createdLocalDate: "2026-11-06",
    preview: "本机待整理",
    ...overrides,
  });

  const queueRow = (overrides: Partial<ReviewQueueEntryDto> = {}): ReviewQueueEntryDto => ({
    recordId: "q1",
    currentRevisionId: "r1",
    revisionNumber: 3,
    axes: axesForProcessingMode("cloud_redacted"),
    processingStatus: "awaiting_privacy_review",
    processingMode: "cloud_redacted",
    privacyLevel: "normal",
    needsAction: true,
    nextAction: "confirm",
    hasPayload: true,
    hasGrant: false,
    llm: { used: false, failureKind: null, spanCount: 0 },
    createdAtUtc: "2026-11-06T00:00:00.000Z",
    checkingSinceUtc: null,
    ...overrides,
  });

  it("非外发 pending：已授权（无需授权）、可勾选、可整理", () => {
    const [row] = buildInboxRows([pendingRow()], []);
    expect(row?.hasGrant).toBe(true);
    expect(row?.selectable).toBe(true);
    expect(row?.organizable).toBe(true);
    expect(row?.confirmable).toBe(false);
    // D-1：meta 只剩一句状态。
    expect(row?.meta).toBe("已捕获");
  });

  it("外发缺授权：hasGrant=false、可勾选/可整理/可确认", () => {
    const [row] = buildInboxRows([], [queueRow({ nextAction: "confirm", hasGrant: false })]);
    expect(row?.hasGrant).toBe(false);
    expect(row?.selectable).toBe(true);
    expect(row?.organizable).toBe(true);
    expect(row?.confirmable).toBe(true);
  });

  it("retry/wait 不配复选框、不进批量整理", () => {
    const rows = buildInboxRows(
      [],
      [
        queueRow({ recordId: "retry", nextAction: "retry", processingStatus: "failed" }),
        queueRow({
          recordId: "wait",
          nextAction: "wait",
          hasPayload: false,
          checkingSinceUtc: "2026-11-06T00:00:01.000Z",
        }),
      ],
    );
    for (const row of rows) {
      expect(row.selectable).toBe(false);
      expect(row.organizable).toBe(false);
    }
  });
});
