import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

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

describe("M5-5AB · 快速记录的四档选择器与两颗动作", () => {
  const quick = stripComments(source("QuickPanel.tsx"));

  it("写入页恢复整理方式选择器，第二动作按档位渲染", () => {
    expect(quick).toContain("<ProcessingModePicker");
    expect(quick).toContain("quickSecondActionFor(mode)");
    expect(quick).toMatch(/second !== null && \(/);
    expect(quick).not.toContain("MODE_ACTION_NOTE");
  });

  it("保存成功才清空、先保存后排队列、这一页不越权碰任何模型调用", () => {
    // 形状随 M6-1C-R 调整（那条回调先记 recordId 再清空）：锁的还是「清空发生在 onCreated 体内」。
    expect(quick).toMatch(/onCreated:\s*\(recordId\)\s*=>\s*\{[^}]*setText\(""\)[^}]*\}/);
    expect(quick).toContain("api.createRecord(");
    // 〔整理方式改动〕第二动作 = 入队；这一页对模型的调用点归零（比从前的「不碰 reparse/preview」更严）。
    expect(quick).toContain("api.enqueueJob");
    expect(quick).not.toMatch(/\bapi\.ingest(Parse|Reparse|Preview|ConfirmSend)\b/);
  });
});

describe("M5-5AB · 记录详情原文优先、技术信息分层", () => {
  const detail = stripComments(source("RecordDetail.tsx"));

  it("原文区排在整理结果之前，技术上不再层层套 card", () => {
    expect(detail.indexOf("<SourceSection")).toBeLessThan(detail.indexOf("<ResultSection"));
    expect(detail).toContain('className="detail-primary"');
    expect(detail).toContain('className="detail-result"');
    // 〔web-redesign 有意变动 · 理由单列在 worklogs/2026-11-03-web-redesign-第二步-批4-编辑独立页与保存确认.md〕
    // 旧判据是「详情页里有 `className="detail-editor"`」。批 4 按方案 C 把编辑搬成独立子页面
    // （内嵌 textarea 的四个病里有三个修不掉：同一句话在一屏里出现两份/三份、键盘弹起把上下文推出视野、
    // 窄屏返回直接把草稿卸掉）。判据因此改成两头一起钉：**详情页不再有那一层**（阅读态与书写态分开），
    // **编辑页有那张同款纸**（能力没删，只是换了地方）。这比原来多钉了一件事，不是放宽。
    expect(detail).not.toContain('className="detail-editor"');
    const edit = stripComments(source("RecordEditPanel.tsx"));
    expect(edit).toContain('className="quick-sheet"');
    expect(edit).toContain("<textarea");
  });

  it("窄屏详情是独立阅读页，时间不再直接暴露 ISO 串", () => {
    const app = stripComments(source("App.tsx"));
    expect(app).toContain("const detailOpen = narrow && view === \"records\" && selectedId !== null");
    expect(app).toContain('return "记录详情"');
    expect(detail).toContain('monthDayOf(record.created_at_local).replace("T", " ")');
    expect(detail).not.toContain("{record.created_at_local} ·");
  });

  // 〔web-redesign 有意变动 · 理由单列在 worklogs/2026-11-03-web-redesign-第二步-批9-详情页四处调整.md〕
  // 用户裁定：详情页的整理方式换成「今天」页那个选择器（`ProcessingModePicker`），
  // 「整理方式：…」这行 summary 因此不再由详情页手写，而是由那个组件的 `summary` 画
  // （前缀仍逐字在 `ui/ProcessingModePicker.tsx` 里，`m5-2`/`m5-3`/`m5-5` 都还在钉它）。
  // 判据换了一头钉：详情页**装了那个组件**；其余三件原样在，能力一件没少。
  it("整理方式、版本历史、整理详情与技术值默认折叠，能力没有删除", () => {
    expect(detail).toContain("<ProcessingModePicker");
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
