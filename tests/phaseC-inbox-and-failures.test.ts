import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ApiError } from "../src/web/apiClient.ts";
import { axesForProcessingMode } from "../src/shared/contracts/enums.ts";
import type {
  IngestResultDto,
  PendingRecordDto,
  ReviewQueueEntryDto,
} from "../src/shared/dto.ts";
import { buildInboxRows, inboxActionLabel } from "../src/web/inbox.ts";
import {
  FAILURE_ACTION_LABEL,
  failurePlanOf,
  failurePlanOfResult,
} from "../src/web/failureActions.ts";

/**
 * Phase C：单列表收件箱（S5）、失败映射（S7）与 manual_only 明路（S8）的验收面。
 *
 * 纯函数逐项断言；需要 DOM 的部分沿用本仓既有的源码断言（vitest 是 node 环境）。
 */

const WEB = join(process.cwd(), "src", "web");

function source(name: string): string {
  return readFileSync(join(WEB, name), "utf8");
}

function pending(overrides: Partial<PendingRecordDto> = {}): PendingRecordDto {
  return {
    recordId: "rec_pending",
    currentRevisionId: "rev_pending",
    processingStatus: "captured",
    processingMode: "local_model",
    axes: axesForProcessingMode("local_model"),
    privacyLevel: "normal",
    createdLocalDate: "2026-11-05",
    preview: "一条待整理的话",
    ...overrides,
  };
}

function queued(overrides: Partial<ReviewQueueEntryDto> = {}): ReviewQueueEntryDto {
  return {
    recordId: "rec_queue",
    currentRevisionId: "rev_queue",
    revisionNumber: 2,
    axes: axesForProcessingMode("cloud_redacted"),
    processingStatus: "awaiting_privacy_review",
    processingMode: "cloud_redacted",
    privacyLevel: "normal",
    needsAction: true,
    nextAction: "confirm",
    hasPayload: true,
    hasGrant: false,
    llm: { used: false, failureKind: null, spanCount: 0 },
    createdAtUtc: "2026-11-05T00:00:00.000Z",
    checkingSinceUtc: null,
    ...overrides,
  };
}

/* ── S5：一个收件箱，只列需要动作的记录 ─────────────────────────── */

describe("S5 · 单列表收件箱", () => {
  it("已完成（needsAction=false）的外发记录不进列表", () => {
    const rows = buildInboxRows(
      [],
      [queued({ recordId: "done", needsAction: false, nextAction: null, processingStatus: "parsed" })],
    );
    expect(rows).toEqual([]);
  });

  it("缺授权 → confirm，本机模型失败 → retry，未完成 → organize，检查中 → wait", () => {
    const rows = buildInboxRows(
      [],
      [
        queued({ recordId: "confirm", nextAction: "confirm" }),
        queued({ recordId: "retry", nextAction: "retry", processingStatus: "failed" }),
        queued({ recordId: "organize", nextAction: "organize", processingStatus: "needs_reparse", hasGrant: true }),
        queued({
          recordId: "wait",
          nextAction: "wait",
          hasPayload: false,
          hasGrant: false,
          checkingSinceUtc: "2026-11-05T00:00:01.000Z",
        }),
      ],
    );
    expect(rows.map((row) => [row.recordId, row.nextAction])).toEqual([
      ["retry", "retry"],
      ["confirm", "confirm"],
      ["organize", "organize"],
      ["wait", "wait"],
    ]);
  });

  it("非外发的待整理记录从 pending 补进来；外发记录不重复出现", () => {
    const rows = buildInboxRows(
      [
        pending({ recordId: "local", preview: "本机待整理" }),
        pending({
          recordId: "queue",
          preview: "同一份外发记录的本地摘要",
          axes: axesForProcessingMode("cloud_redacted"),
          processingMode: "cloud_redacted",
          processingStatus: "awaiting_privacy_review",
        }),
      ],
      [queued({ recordId: "queue", nextAction: "confirm" })],
    );
    expect(rows.map((row) => row.recordId).sort()).toEqual(["local", "queue"]);
    const queuedRow = rows.find((row) => row.recordId === "queue");
    expect(queuedRow?.title).toBe("同一份外发记录的本地摘要");
    expect(queuedRow?.egress).toBe(true);
    expect(rows.find((row) => row.recordId === "local")?.nextAction).toBe("organize");
  });

  it("每行只给一个动作；失败的是「重试整理」，检查中的不给按钮", () => {
    expect(inboxActionLabel({ nextAction: "confirm", failed: false })).toBe("确认发送");
    expect(inboxActionLabel({ nextAction: "retry", failed: true })).toBe("重新检查");
    expect(inboxActionLabel({ nextAction: "organize", failed: true })).toBe("重试整理");
    expect(inboxActionLabel({ nextAction: "organize", failed: false })).toBe("去整理");
    expect(inboxActionLabel({ nextAction: "wait", failed: false })).toBe("等待本机检查");
  });

  it("页面上只有一个 InboxSection，旧的复核队列列表已经退场", () => {
    const text = source("IngestPanel.tsx");
    expect(text).toContain("buildInboxRows(pending, reviewQueue)");
    expect(text).toContain("<InboxSection");
    expect(text).not.toContain("<ReviewQueueSection");
  });
});

/* ── S7：失败面统一映射 ─────────────────────────────────────────── */

describe("S7 · 错误码 → 下一步", () => {
  function api(status: number, code: string, detail: string): ApiError {
    return new ApiError(status, code, detail, [], null);
  }

  it("三颗动作的文案逐字固定", () => {
    expect(FAILURE_ACTION_LABEL).toEqual({
      retry: "重试",
      settings: "去改设置",
      "save-only": "只保存，稍后再说",
    });
  });

  it("网络 / 本机模型失败 → 先重试；整理未就绪 → 先去改设置", () => {
    for (const cause of [
      api(0, "network_error", "无法连接本地后端"),
      api(409, "local_llm_consult_failed", "本机模型调用失败"),
    ]) {
      expect(failurePlanOf(cause).actions[0], cause.code).toBe("retry");
    }
    expect(failurePlanOf(api(503, "ingest_unavailable", "解析能力未就绪")).actions[0]).toBe("settings");
  });

  it("装配问题（档位不可用 / 未就绪）→ 先去改设置", () => {
    expect(failurePlanOf(api(409, "redaction_mode_unavailable", "未配置")).actions[0]).toBe("settings");
    expect(failurePlanOf(api(503, "ingest_unavailable", "未就绪")).actions[0]).toBe("settings");
  });

  it("重新检查类（缓存缺失 / 没预览过）→ 重试而不是去改设置", () => {
    for (const code of ["redaction_tier_cache_missing", "local_llm_not_previewed"]) {
      const planOf = failurePlanOf(api(409, code, "先看预览"));
      expect(planOf.actions, code).toEqual(["retry", "save-only"]);
    }
  });

  it("记录的请求本身不成立 → 不给重试，只留「只保存，稍后再说」", () => {
    for (const code of ["not_found", "invalid_request", "invalid_json", "body_too_large", "invalid_three_axis_combination"]) {
      expect(failurePlanOf(api(400, code, "不成立")).actions, code).toEqual(["save-only"]);
    }
  });

  it("认不出的错误码与非 ApiError 都落到「重试 + 只保存」，不把原码当主文案", () => {
    for (const cause of [api(500, "internal_error", "内部错误"), api(418, "teapot", "茶壶"), new Error("boom")]) {
      const planOf = failurePlanOf(cause);
      expect(planOf.actions).toEqual(["retry", "save-only"]);
      expect(planOf.headline).not.toContain("teapot");
    }
  });

  it("技术详情保留服务端 detail 与错误码，主文案只说人话", () => {
    const planOf = failurePlanOf(
      api(409, "local_llm_consult_failed", "revision rev_1 的本机模型调用失败"),
    );
    expect(planOf.headline).toBe("本机模型没跑成，名字和地名没有检查。");
    expect(planOf.technical).toContain("local_llm_consult_failed");
    expect(planOf.technical).toContain("本机模型调用失败");
    expect(planOf.headline).not.toContain("local_llm_consult_failed");
  });

  it("整理结果失败按 errorKind 说人话，技术详情仍带分类与消息", () => {
    const base: Pick<IngestResultDto, "failure" | "errorKind"> = {
      errorKind: "timeout",
      failure: { errorKind: "timeout", retryable: true, message: "等了 30 秒", issues: [] },
    };
    const planOf = failurePlanOfResult(base);
    expect(planOf.headline).toBe("本机模型太慢，这次没整理完。");
    expect(planOf.actions).toEqual(["retry", "save-only"]);
    expect(planOf.technical).toBe("timeout · 等了 30 秒");

    expect(failurePlanOfResult({ errorKind: "evidence_unmapped", failure: null }).headline).toContain(
      "对不上原文",
    );
    expect(failurePlanOfResult({ errorKind: null, failure: null }).headline).toBe("整理没有成功。原文完好无损。");
  });

  it("页面只用这一份映射：不再有按错误码分叉的本地文案函数", () => {
    const text = source("IngestPanel.tsx");
    expect(text).toContain("failurePlanOf(cause)");
    expect(text).not.toContain("ingestErrorMessage");
    expect(text).toContain("FAILURE_ACTION_LABEL");
    expect(text).toContain("TechnicalDetails");
  });

  it("快捷记录的入队失败也走同一份映射，技术细节折叠显示", () => {
    // 〔整理方式改动〕第二动作改进入队后，这一页不再有「同步整理跑完带回一个结果」那种失败：
    // `failurePlanOfResult` 因此从 `quickSave.ts` 退场（它仍服务于详情页与待整理页）。
    // 判据没有变宽——失败面只剩抛错这一种来源，仍走同一份 `failurePlanOf`，技术细节仍折叠。
    expect(source("quickSave.ts")).toContain("failurePlanOf(cause)");
    expect(source("quickSave.ts")).not.toContain("failurePlanOfResult");
    expect(source("QuickPanel.tsx")).toContain("<TechnicalDetails");
  });
});

/* ── S8：manual_only 的明路 ─────────────────────────────────────── */

describe("S8 · manual_only 整理入口", () => {
  it("详情页无当前结果时给「整理这一条」，先把模式改成 local_model 再整理", () => {
    const text = source("RecordDetail.tsx");
    expect(text).toContain("organizeManualOnly");
    expect(text).toMatch(/api\.setRecordMode\(\s*record\.id\s*,\s*"local_model"\s*\)/);
    expect(text).toContain("api.ingestParse({ recordId: record.id })");
    expect(text).toContain("整理这一条");
    expect(text).toContain('record.processing_mode === "manual_only"');
  });

  it("不是 manual_only 时仍是原来的「发起整理」", () => {
    const text = source("RecordDetail.tsx");
    expect(text).toContain("发起整理");
    expect(text).toContain("manualOnly");
  });
});
