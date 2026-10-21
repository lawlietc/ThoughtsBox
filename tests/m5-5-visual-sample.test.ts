import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { quickSecondActionFor } from "../src/web/quickSave.ts";
import { TABS } from "../src/web/ui/nav.ts";

/**
 * M5-5AB · 三页视觉样张的源码验收面。
 *
 * 任务书：`docs/dev-specs/2026-10-19-M5-5AB-三页视觉样张任务书.md`。
 * vitest 是 node 环境，因此这里钉住能由源码说死的部分：
 * 依赖、B 月白青 tokens、图标 + 文字导航、三页的信息层级，以及原有的行为出口。
 * 真实观感仍由 390 / 1440 的渲染评审负责。
 */

const ROOT = process.cwd();
const WEB = join(ROOT, "src", "web");

function source(rel: string): string {
  return readFileSync(rel.startsWith("src/") ? join(ROOT, rel) : join(WEB, rel), "utf8");
}

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("M5-5AB · 依赖与夜灯 B 月白青", () => {
  it("只新增 lucide-react，保留 React 与 zod", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    expect(pkg.dependencies["lucide-react"]).toBeDefined();
    expect(pkg.dependencies.react).toBeDefined();
    expect(pkg.dependencies["react-dom"]).toBeDefined();
    expect(pkg.dependencies.zod).toBeDefined();
    for (const banned of ["@mui/", "antd", "@chakra-ui/", "@radix-ui/"]) {
      expect(Object.keys(pkg.dependencies).join(" ")).not.toContain(banned);
    }
  });

  it("深色主题换成用户确认的五个值，浅色晨雾不变", () => {
    const css = source("styles.css");
    const dark = css.slice(css.indexOf('[data-theme="dark"] {'), css.indexOf("body {", css.indexOf('[data-theme="dark"] {')));
    expect(dark).toContain("--accent: #a9c2b8");
    expect(dark).toContain("--accent-soft: #2b3733");
    expect(dark).toContain("--accent-ink: #171b19");
    expect(dark).toContain("--warm: #b47b68");
    expect(dark).toContain("--amber: #c6b188");
    expect(dark).not.toContain("--accent: #d8a65a");
    expect(css.slice(0, css.indexOf('[data-theme="dark"] {'))).not.toContain("--accent: #a9c2b8");
  });
});

describe("M5-5AB · 图标 + 文字导航", () => {
  const shell = stripComments(source("ui/Shell.tsx"));

  it("顶层仍是今天 / 盒子 / 更多，不新增第四格", () => {
    expect(TABS.map((entry) => entry.label)).toEqual(["今天", "盒子", "更多"]);
  });

  it("使用 lucide-react 图标，但文字始终可读，不做纯图标底栏", () => {
    expect(shell).toContain('from "lucide-react"');
    for (const icon of ["SunMedium", "BoxIcon", "Ellipsis"]) expect(shell).toContain(icon);
    expect(shell).toContain('className="tab-icon"');
    expect(shell).toContain('className="tab-label"');
    expect(shell).toContain("{entry.label}");
    expect(shell).toContain('aria-current={tab === entry.key ? "page" : undefined}');
  });

  it("首页不再常驻四个今天子 tab；记录类子页仍能到达", () => {
    expect(shell).toContain('tab === "today" && !standalone && view !== "today"');
    expect(shell).toContain("props.detailOpen !== true");
    expect(shell).toContain("TODAY_TABS.map");
  });
});

describe("M5-5AB · 今天页先给行动，不先讲产品", () => {
  const today = stripComments(source("TodayPanel.tsx"));

  it("删掉产品说明与旧三链接组，保留一个主问题和一个主行动", () => {
    expect(today).not.toContain("不必想清楚");
    expect(today).not.toContain("today-links");
    expect(today).toContain("今天，想留下什么？");
    expect(today).toContain('onNavigate("quick")');
    expect(today).toContain('onNavigate("sleep")');
    expect(today).toContain("全部片段");
  });

  it("待整理只在有内容时出现一条轻提示，且不再重复「待确认」入口", () => {
    expect(today).toContain("props.pendingCount !== null && props.pendingCount > 0");
    expect(today).toContain("有 {props.pendingCount} 条待整理 · 去看看");
    expect(today).not.toContain('onNavigate("suggestions")');
  });

  it("仍是两段结构、真实取数、空态只说一次", () => {
    expect([...today.matchAll(/<section/g)]).toHaveLength(2);
    expect(today).toContain("const feed = useRecords();");
    expect(today).toContain("filterByLocalDay(feed.rows, today)");
    expect([...today.matchAll(/今天还没有/g)]).toHaveLength(1);
  });
});

describe("M5-5AB · 快速记录收成一行整理方式", () => {
  const quick = stripComments(source("QuickPanel.tsx"));
  const picker = stripComments(source("ui/ProcessingModePicker.tsx"));

  it("三种模式收进原生 disclosure，不再直接铺三张说明卡", () => {
    expect(quick).toContain("<ProcessingModePicker");
    expect(picker).toContain("<details className=\"quick-mode\">");
    expect(picker).toContain("整理方式：");
    expect(picker).toContain("processingModeChoices()");
    expect(quick).not.toContain("MODE_ACTION_NOTE");
  });

  it("local_model 的「保存并整理」仍是唯一真实第二动作，manual 只有只保存", () => {
    expect(quickSecondActionFor("manual_only")).toBeNull();
    expect(quickSecondActionFor("local_model")?.label).toBe("保存并整理");
    expect(quickSecondActionFor("cloud_redacted")?.label).toBe("保存，去确认发送");
    expect(quick).toContain("quickSecondActionFor(mode)");
    expect(quick).toContain("second !== null && (");
  });

  it("保存成功才清空、先保存再整理、云端不越权", () => {
    expect(quick).toMatch(/onCreated:\s*\(\)\s*=>\s*setText\(""\)/);
    expect(quick).toContain("api.createRecord(");
    expect(quick).toContain("api.ingestParse");
    expect(quick).not.toMatch(/\bapi\.ingest(Reparse|Preview|ConfirmSend)\b/);
  });
});

describe("M5-5AB · 记录详情原文优先、技术信息分层", () => {
  const detail = stripComments(source("RecordDetail.tsx"));

  it("原文区排在整理结果之前，技术上不再层层套 card", () => {
    expect(detail.indexOf("<SourceSection")).toBeLessThan(detail.indexOf("<ResultSection"));
    expect(detail).toContain('className="detail-primary"');
    expect(detail).toContain('className="detail-result"');
    expect(detail).toContain('className="detail-editor"');
  });

  it("窄屏详情是独立阅读页，时间不再直接暴露 ISO 串", () => {
    const app = stripComments(source("App.tsx"));
    expect(app).toContain("const detailOpen = narrow && view === \"records\" && selectedId !== null");
    expect(app).toContain('return "记录详情"');
    expect(detail).toContain('monthDayOf(record.created_at_local).replace("T", " ")');
    expect(detail).not.toContain("{record.created_at_local} ·");
  });

  it("整理方式、版本历史、整理详情与技术值默认折叠，能力没有删除", () => {
    expect(detail).toContain("summary={`整理方式：");
    expect(detail).toContain("summary={`版本历史（");
    expect(detail).toContain('summary="查看整理详情"');
    expect(detail).toContain("<TechnicalDetails");
    expect(detail).toContain("onSaveMode");
    expect(detail).toContain("onReparse");
    expect(detail).toContain("onDelete");
    expect(detail).toContain("onAdopt");
    expect(detail).toContain("onDiscard");
  });

  it("风险与失败路径仍直接可见：删除不可撤销、整理失败原文完好", () => {
    expect(detail).toContain("无法从当前界面撤销");
    expect(detail).toContain("全部历史版本");
    expect(detail).toContain("原文完好无损");
  });
});

describe("M5-5AB · 390px 防溢出声明仍在", () => {
  it("关键滚动容器允许长中文换行，外壳把内边距算进宽度", () => {
    const css = source("styles.css");
    expect(css).toContain("@media (max-width: 63.99rem)");
    expect(css).toContain(".app-main {");
    expect(css).toContain("min-width: 0");
    expect(css).toContain(".timeline-text {");
    expect(css).toContain(".raw {");
    expect(css).toContain("overflow-wrap: anywhere");
    expect(css).toContain("box-sizing: border-box");
  });
});
