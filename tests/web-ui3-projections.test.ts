import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  clockOf,
  deletePhaseMessage,
  effectiveLines,
  filterByLocalDay,
  firstLine,
  localDay,
  monthDayOf,
  NO_READABLE_DATA,
  parsedCount,
  toRowView,
} from "../src/web/projections.ts";
import type { DeletePhaseResult, EffectiveResultDto, RecordRow } from "../src/shared/dto.ts";

/**
 * M3 UI-3 的 node 断言面：**投影逻辑**与**数据来源**。
 *
 * 渲染对不对不由这里负责（vitest 的 environment 是 node，没有 DOM），
 * 归 `prototype/scripts/render-check.mjs` 的两档渲染证据门（任务书 §九）。
 * 这里断言的是能在 node 里说死的部分：
 * - 「今天」的日历日口径（错一天就少一整天的记录，而且看起来完全正常）；
 * - 整理结果的降级：只出数量，**一个 id 都不许印**；
 * - 删除三态的措辞：阶段 B 失败不能被说成回滚；
 * - 面板取数只走 `apiClient`，展示组件不取数。
 */

function recordRow(over: Partial<RecordRow>): RecordRow {
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

describe("projections —— 「今天」的日历日口径", () => {
  it("localDay 补零成 YYYY-MM-DD（本机时区，不是 UTC）", () => {
    expect(localDay(new Date(2026, 9, 6, 13, 4, 5))).toBe("2026-10-06");
    expect(localDay(new Date(2026, 0, 1, 0, 0, 0))).toBe("2026-01-01");
  });

  it("跨 UTC 日界仍算同一天：晚上十一点写的记录不该隔天就掉出「今天」", () => {
    // 2026-10-16T23:30+08:00 == 2026-10-16T15:30Z；反过来 00:30+08:00 是前一天 16:30Z。
    expect(localDay(new Date(2026, 9, 16, 23, 30))).toBe("2026-10-16");
    expect(localDay(new Date(2026, 9, 16, 0, 30))).toBe("2026-10-16");
  });

  it("filterByLocalDay 只留 created_local_date 相等的那些，并保持服务端顺序", () => {
    const rows = [
      recordRow({ id: "rec_a", created_local_date: "2026-10-16" }),
      recordRow({ id: "rec_b", created_local_date: "2026-10-15" }),
      recordRow({ id: "rec_c", created_local_date: "2026-10-16" }),
    ];
    expect(filterByLocalDay(rows, "2026-10-16").map((row) => row.id)).toEqual(["rec_a", "rec_c"]);
    expect(filterByLocalDay(rows, "2026-10-14")).toEqual([]);
  });

  it("clockOf / monthDayOf 按迁移 0002 钉住的形状切片（整串太长会把行挤爆）", () => {
    const local = "2026-10-16T13:04:05.123+08:00";
    expect(clockOf(local)).toBe("13:04");
    expect(monthDayOf(local)).toBe("10-16T13:04");
  });

  it("firstLine 只取首行，超限才补省略号", () => {
    expect(firstLine("第一行\n第二行", 40)).toBe("第一行");
    expect(firstLine("一".repeat(40), 40)).toBe("一".repeat(40));
    expect(firstLine("一".repeat(41), 40)).toBe(`${"一".repeat(40)}…`);
    expect(firstLine("", 40)).toBe("");
  });

  it("toRowView 把 DTO 行 + 摘要 + 元信息收成列表显示量", () => {
    const view = toRowView(recordRow({ id: "rec_x" }), "标题行\n正文", "13:04 · 已捕获");
    expect(view).toEqual({ id: "rec_x", title: "标题行", meta: "13:04 · 已捕获" });
  });

  it("parsedCount 只数「已整理」，别的状态一律不算产出", () => {
    const rows = [
      recordRow({ processing_status: "parsed" }),
      recordRow({ processing_status: "captured" }),
      recordRow({ processing_status: "parsed" }),
      recordRow({ processing_status: "needs_reparse" }),
      recordRow({ processing_status: "failed" }),
    ];
    expect(parsedCount(rows)).toBe(2);
    expect(parsedCount([])).toBe(0);
  });
});

describe("projections —— 整理结果的降级（不许印 id）", () => {
  const effective: EffectiveResultDto = {
    revisionId: "rev_000000000000000000000000000001",
    currentRunId: "run_000000000000000000000000000001",
    episodes: ["epi_1", "epi_2"],
    thoughts: ["thi_1"],
    emotions: [],
    topics: ["top_1", "top_2", "top_3"],
    entities: [],
    candidates: [{ runId: "run_2", fingerprint: "fp" }],
    overrides: [
      {
        objectTable: "emotion_mention",
        objectId: "men_000000000000000000000000000001",
        fieldName: "status",
        valueJson: '"rejected"',
        updatedAtUtc: "2026-10-16T05:04:05.123Z",
      },
    ],
  };

  it("有效结果 → 「类别 + 计数」，顺序即阅读顺序，数字来自数组长度", () => {
    expect(effectiveLines(effective)).toEqual([
      ["经历", 2],
      ["念头", 1],
      ["情绪", 0],
      ["主题", 3],
      ["人物与事物", 0],
      ["用户修正", 1],
    ]);
  });

  it("降级文案里不出现任何 id —— 内部主键印在界面上是事故，不是信息", () => {
    const printed = [...effectiveLines(effective).map(([label, count]) => `${label}${count}`), NO_READABLE_DATA];
    const ids = [
      effective.revisionId,
      effective.currentRunId ?? "",
      ...effective.episodes,
      ...effective.thoughts,
      ...effective.topics,
      ...effective.overrides.map((override) => override.objectId),
    ];
    for (const text of printed) {
      for (const id of ids) {
        if (id === "") continue;
        expect(text, `界面文案泄露了 id ${id}`).not.toContain(id);
      }
      expect(text).not.toMatch(/rec_|rev_|run_|epi_|thi_|top_|ent_|men_|ovr_|cand_/);
    }
  });

  it("NO_READABLE_DATA 是那句人话，不含英文取值原文", () => {
    expect(NO_READABLE_DATA).toBe("这段还没有可读数据。");
  });
});

describe("projections —— 删除三态的措辞", () => {
  function phaseResult(status: DeletePhaseResult["phaseB"]["status"]): DeletePhaseResult {
    const phaseA = { committed: true, revisionsRemoved: 3 } as const;
    if (status === "ok") return { phaseA, phaseB: { status: "ok" } };
    if (status === "pending") return { phaseA, phaseB: { status: "pending", detail: "checkpoint 未释放" } };
    return { phaseA, phaseB: { status: "failed_unpersisted", detail: "登记未落盘" } };
  }

  it("三态都承认「记录删掉了」这一件事", () => {
    for (const status of ["ok", "pending", "failed_unpersisted"] as const) {
      expect(deletePhaseMessage(phaseResult(status))).toContain("记录");
    }
    expect(deletePhaseMessage(phaseResult("ok"))).toContain("已提交");
    expect(deletePhaseMessage(phaseResult("failed_unpersisted"))).toContain("已提交");
    expect(deletePhaseMessage(phaseResult("pending"))).toContain("已删除");
  });

  it("严禁把阶段 B 失败说成回滚", () => {
    for (const status of ["ok", "pending", "failed_unpersisted"] as const) {
      expect(deletePhaseMessage(phaseResult(status)), status).not.toContain("回滚");
    }
    expect(deletePhaseMessage(phaseResult("failed_unpersisted"))).toContain("未落盘");
    expect(deletePhaseMessage(phaseResult("pending"))).toContain("待完成");
    expect(deletePhaseMessage(phaseResult("ok"))).toContain("清理完成");
  });
});

/* ── 数据来源与分层（任务书 §5.4 断言 1、2 的 node 可断言部分） ───── */

const WEB = join(process.cwd(), "src", "web");

function source(name: string): string {
  return readFileSync(join(WEB, name), "utf8");
}

describe("UI-3 面板：数据只走 apiClient，展示组件不取数", () => {
  const panels = ["TodayPanel.tsx", "RecordsPanel.tsx", "IngestPanel.tsx", "RecordDetail.tsx"];

  for (const name of panels) {
    it(`${name} 的取数口子只有 apiClient（直接或经 useRecords），且不碰假数据目录`, () => {
      const text = source(name);
      expect(text).toMatch(/from "\.\/(apiClient|useRecords)\.ts"/);
      expect(text).not.toContain("mock/");
      expect(text).not.toContain("prototype/");
      // 面板不许绕过 apiClient 自己发请求。
      expect(text).not.toMatch(/\bfetch\s*\(/);
    });
  }

  it("RecordList.tsx 与 projections.ts 是纯显示/纯投影层：不取数、不引 apiClient、没有本地状态", () => {
    for (const name of ["RecordList.tsx", "projections.ts"]) {
      const text = source(name);
      expect(text).not.toMatch(/\bfetch\s*\(/);
      expect(text).not.toContain("apiClient");
      expect(text).not.toContain("useState");
      expect(text).not.toContain("prototype/");
    }
  });

  it("两栏页都用 ui/ListDetail 的壳，没有自造第三套布局", () => {
    for (const name of ["RecordsPanel.tsx", "IngestPanel.tsx"]) {
      expect(source(name), `${name} 应当用 ListDetail 壳`).toContain('from "./ui/ListDetail.tsx"');
    }
  });

  it("整理结果页取数前先问 ingestReady，不会拿注定 503 的请求去撞", () => {
    const text = source("RecordDetail.tsx");
    expect(text).toContain("api.ingestConfig()");
    expect(text).toContain("config.ingestReady");
  });

  /**
   * UI-4 之后这条断言的对象变了（〔对齐修正，理由单列在 UI-4 worklog〕）：
   * 原来断言的是「PENDING_VIEWS 名单里不含 today」，UI-4 把那张表整体删掉了 ——
   * 于是这里断言得更死：名单**不许存在**，而「今天」仍然是第一屏、仍然挂着真面板。
   * 这不是削弱：`not.toMatch(/PENDING_VIEWS/)` 比原来的「名单里没 today」更难满足。
   */
  it("开机第一屏是「今天」，且诚实空态名单已随 UI-4 的真页面整体移除", () => {
    const text = source("App.tsx");
    expect(text).toContain('useState<ViewKey>("today")');
    expect(text).toContain("<TodayPanel");
    expect(text).not.toMatch(/\bPENDING_VIEWS\b/);
    expect(text).not.toMatch(/\bPendingPage\b/);
  });
});
