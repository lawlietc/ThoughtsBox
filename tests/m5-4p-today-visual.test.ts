import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { BOX_SUB_TABS, TABS, TODAY_TABS, tabOf } from "../src/web/ui/nav.ts";

/**
 * M5-4P · 「今天」页视觉试改的验收面
 * （任务书：`docs/dev-specs/2026-10-19-M5-4P-今天页视觉试改任务书.md` §五）。
 *
 * vitest 是 node 环境（没有 DOM），沿用本仓惯例做源码级断言：
 * 先把注释剥掉、把 JSX 的属性与表达式剥掉，剩下的就是「主界面直接可见」的文案。
 * 光线、留白、呼吸感这类事最终仍归 390 / 1440 真渲染评审（任务书 §六），
 * 这里钉的是**能被源码说死的那一半**：导航结构、主题 tokens 的成对存在、
 * 取数路径没被换成假数据、以及页面不许出现工程黑话。
 */

const WEB = join(process.cwd(), "src", "web");

function source(name: string): string {
  return readFileSync(join(WEB, name), "utf8");
}

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/**
 * JSX 里「肉眼读得到」的那一份：标签之间的纯文本。
 * 属性（`className="…"`）、表达式（`{clockOf(row.created_at_local)}`）与语句都不是 —— 用户读不到它们。
 *
 * 做法：剥注释后，把 `<标签>` 与 `{…}` 的边界都换成换行，于是每行要么是 JSX 文本节点，
 * 要么是一段被切出来的代码。留「含中文且不含代码标点」的那些行：
 * `row.processing_status`、`todays.length` 这类会被标点挡掉，而「ParseRun 读取失败」这种
 * 真·黑话文案里没有代码标点，会被留下 —— 正因为留得下，第 4 组那条禁令才有牙齿。
 */
function jsxVisibleText(name: string): string {
  const code = stripComments(source(name))
    .replace(/<[^<>]*>/g, "\n")
    .replace(/[{}]/g, "\n");
  const lines = code
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => /[\u4e00-\u9fff]/.test(line) && !/[;:.()<>[\]&|!?*+"'/\\]/.test(line));
  return lines.join("\n");
}

/** 取某条选择器的规则体（只取第一条，够用）。 */
function cssRule(css: string, selector: string): string {
  const at = css.indexOf(selector);
  expect(at, `styles.css 缺少选择器 ${selector}`).toBeGreaterThanOrEqual(0);
  const open = css.indexOf("{", at);
  const close = css.indexOf("}", open);
  return css.slice(open + 1, close);
}

/* ── 1 & 2. 顶层导航收成三个入口 ─────────────────────────────── */

describe("M5-4P · 顶层导航", () => {
  it("顶层只有三项，标签逐字等于「今天 / 盒子 / 更多」", () => {
    expect(TABS.map((entry) => entry.label)).toEqual(["今天", "盒子", "更多"]);
  });

  it("页面归属：记录类归今天、搜索归盒子、数据归更多", () => {
    expect(tabOf("records")).toBe("today");
    expect(tabOf("search")).toBe("boxes");
    expect(tabOf("data")).toBe("more");
    // 「今天」下的四个子页全部归今天；盒子五页 + 搜索全部归盒子。
    for (const entry of TODAY_TABS) expect(tabOf(entry.key)).toBe("today");
    for (const entry of BOX_SUB_TABS) expect(tabOf(entry.key)).toBe("boxes");
  });

  it("quick / sleep 仍是动作页，语义没被改成可逛的地方", () => {
    const nav = source("ui/nav.ts");
    expect(nav).toContain('export const STANDALONE: readonly ViewKey[] = ["quick", "sleep", "overview"]');
    // 动作页归到「今天」这条线上，所以高亮仍然对。
    expect(tabOf("quick")).toBe("today");
    expect(tabOf("sleep")).toBe("today");
  });

  it("外壳画的就是这三项，并把主题开关接在标题栏", () => {
    const shell = stripComments(source("ui/Shell.tsx"));
    expect(shell).toContain("{TABS.map((entry) =>");
    expect(shell).toContain("<ThemeToggle />");
    expect(shell).toContain("className=\"head-tools\"");
    expect(shell).toContain("aria-current={tab === entry.key ? \"page\" : undefined}");
    expect(shell).toContain("className=\"tab-icon\"");
    expect(shell).toContain("className=\"tab-label\"");
    expect(shell).toContain("SunMedium");
    expect(shell).toContain("BoxIcon");
    expect(shell).toContain("Ellipsis");
    // 顶层不再出现「搜索」那一格：它只在盒子的子 tab 里。
    expect(shell).not.toContain('label: "搜索"');
    expect(shell).toContain("BOX_SUB_TABS.map");
  });

  it("今天首页不重复画第二套「写一条 / 睡前收尾」底栏", () => {
    const shell = stripComments(source("ui/Shell.tsx"));
    // 首页自己的开场卡已经有两个动作；底栏只在今天的其他子页出现。
    expect(shell).toContain('tab === "today" && !standalone && view !== "today"');
  });
});

/* ── 3. 取数路径与「不许有假的情绪 / 假的保存」 ─────────────────── */

describe("M5-4P · 今天页的数据是真的", () => {
  // 一律看**去掉注释**的源码：注释里点名 `apiClient` 是说明取数链路，不是这一页自己去请求。
  const today = stripComments(source("TodayPanel.tsx"));

  it("唯一取数口仍是 useRecords() → apiClient → 本地后端", () => {
    expect(today).toContain('from "./useRecords.ts"');
    expect(today).toContain("const feed = useRecords();");
    expect(today).toContain("filterByLocalDay(feed.rows, today)");
    // 这一页不发请求，也不写数据。
    expect(today).not.toContain("apiClient");
    expect(today).not.toMatch(/\bapi\./);
    expect(today).not.toContain("fetch(");
    expect(today).not.toMatch(/createRecord|ingestParse|onSave|onSubmit/);
  });

  it("没有引入假的情绪数据，也没有「点了不保存」的假动作", () => {
    expect(today).not.toMatch(/mood|心情/i);
    expect(today).not.toContain("useState");
    // 页面上所有按钮都只做两件事：跳转（onNavigate）、选中（onSelectRecord）、重试（reload）。
    const handlers = [...stripComments(today).matchAll(/onClick=\{\(\) => ([^}]*)\}/g)].map((m) => m[1]!.trim());
    expect(handlers.length).toBeGreaterThan(0);
    for (const handler of handlers) {
      expect(handler, `这一处 click 干了别的：${handler}`).toMatch(
        /^(props\.onNavigate\("[a-z]+"\)|props\.onSelectRecord\(row\.id\)|void feed\.reload\(\))$/,
      );
    }
  });

  it("主行动仍指向 quick、次级动作仍指向 sleep（动作语义没被改版改走样）", () => {
    const visible = jsxVisibleText("TodayPanel.tsx");
    expect(visible).toContain("写一条");
    expect(visible).toContain("睡前收尾");
    expect(today).toContain('onNavigate("quick")');
    expect(today).toContain('onNavigate("sleep")');
  });

  it("标题栏只显示当前页，不再重复品牌副标题", () => {
    const app = source("App.tsx");
    expect(app).toContain("title={pageTitle(view, detailOpen)}");
    expect(app).toContain('return "今天"');
    expect(app).not.toContain('lede="把此刻，轻轻收好"');
    expect(app).not.toContain('lede="本地优先的思绪整理工具"');
  });
});

/* ── 4 & 5. 主界面文案 ────────────────────────────────────────── */

describe("M5-4P · 今天页可见文案", () => {
  const visible = jsxVisibleText("TodayPanel.tsx");

  it("问候、主行动、时间线标题都在", () => {
    expect(visible).toContain("今天，想留下什么？");
    expect(visible).toContain("写一条");
    expect(visible).toContain("今天的片段");
  });

  it("空态只说一句，且说给的是「片段」不是「记录条目」", () => {
    expect([...visible.matchAll(/今天还没有/g)]).toHaveLength(1);
    expect(visible).toContain("今天还没有留下片段。");
  });

  it("工程黑话一个都不许出现在可见文案里", () => {
    for (const banned of ["ParseRun", "PROJ-", "sha256", "provider", "Provider", "created_at_local", "processing_status"]) {
      expect(visible, `可见文案里出现了「${banned}」`).not.toContain(banned);
    }
    // 全文（含注释与属性）也不许出现这两个内部枚举名。
    expect(visible).not.toMatch(/manual_only|local_model|cloud_redacted/);
  });

  it("真实错误如实显示：读取失败仍是原样文案 + 重试，没有被吞成一句模糊的加载失败", () => {
    const today = stripComments(source("TodayPanel.tsx"));
    expect(today).toContain("{feed.error}");
    expect(today).toContain('className="warn"');
    expect(today).toContain("void feed.reload()");
    expect(today).not.toContain("加载失败</p>");
  });

  it("第一屏不是连续三张后台卡片：整页只剩两段，且不共用 .card", () => {
    const today = stripComments(source("TodayPanel.tsx"));
    expect([...today.matchAll(/<section/g)]).toHaveLength(2);
    expect(today).not.toContain('className="card"');
    expect(today).toContain('className="today-open"');
    expect(today).toContain('className="today-feed"');
  });
});

/* ── 6. 双主题 tokens ─────────────────────────────────────────── */

describe("M5-4P · 双主题", () => {
  const css = source("styles.css");

  it("浅色与深色各有一份完整 tokens，挂在 :root 与 [data-theme=\"dark\"] 上", () => {
    const light = cssRule(css, ":root {");
    const dark = cssRule(css, '[data-theme="dark"] {');
    for (const token of ["--bg:", "--surface:", "--ink:", "--muted:", "--accent:", "--accent-soft:", "--warm:", "--line:"]) {
      expect(light, `浅色缺 ${token}`).toContain(token);
      expect(dark, `深色缺 ${token}`).toContain(token);
    }
  });

  it("深色不是纯黑，浅色不是纯白", () => {
    const light = cssRule(css, ":root {");
    const dark = cssRule(css, '[data-theme="dark"] {');
    expect(dark).not.toMatch(/--bg:\s*#000/i);
    expect(dark).not.toMatch(/--surface:\s*#000/i);
    expect(light).not.toMatch(/--bg:\s*#fff;/i);
    expect(light).not.toMatch(/--surface:\s*#fff;/i);
  });

  it("系统深色不再把页面直接刷成黑底管理台：color-scheme 跟着主题走", () => {
    expect(css).not.toContain("color-scheme: light dark");
    expect(cssRule(css, ":root {")).toContain("color-scheme: light");
    expect(cssRule(css, '[data-theme="dark"] {')).toContain("color-scheme: dark");
  });

  it("主色是苔绿 / 暖琥珀 / 陶土 / 深墨；只有玻璃珠局部使用 backdrop-filter", () => {
    const dark = cssRule(css, '[data-theme="dark"] {');
    const light = cssRule(css, ":root {");
    expect(light).toContain("--accent: #5e7c68");
    expect(dark).toContain("--accent: #a9c2b8");
    expect(dark).toContain("--accent-soft: #2b3733");
    expect(dark).toContain("--warm: #b47b68");
    expect(light).toContain("--warm: #c9785a");
    const ballRule = css.match(/\.box-ball\s*\{[\s\S]*?\n\}/)?.[0] ?? "";
    expect(ballRule).toContain("backdrop-filter");
    expect(css.replace(ballRule, "")).not.toMatch(/backdrop-filter/);
    expect(css).not.toMatch(/linear-gradient\([^)]*purple/i);
  });
});

/* ── 7. 主题开关：可访问、不是 hover-only ─────────────────────── */

describe("M5-4P · ThemeToggle", () => {
  const toggle = source("ui/ThemeToggle.tsx");
  const css = source("styles.css");

  it("是一个原生 button，带说得出「切到哪」的 aria-label", () => {
    expect(toggle).toContain('type="button"');
    expect(toggle).toContain("className=\"theme-toggle\"");
    expect(toggle).toMatch(/aria-label=\{`切换到\$\{nextLabel\}主题`\}/);
    expect(toggle).toContain("title={`当前：");
    expect(toggle).toContain("MoonStar");
    expect(toggle).toContain("Sun");
    expect(toggle).toMatch(/theme === "dark" \? <MoonStar[\s\S]*? : <Sun/);
  });

  it("不依赖 hover：可见性不写在 :hover 里，键盘能到达（原生 button + focus 环）", () => {
    const base = cssRule(css, ".theme-toggle {");
    expect(base).not.toMatch(/display:\s*none|opacity:\s*0|visibility:\s*hidden/);
    const hover = cssRule(css, ".theme-toggle:hover");
    expect(hover).not.toMatch(/display:|visibility:/);
    expect(css).toMatch(/\.theme-toggle:focus-visible/);
  });

  it("显式选择进 localStorage，没选过就跟随系统，且首帧前就定色", () => {
    expect(toggle).toContain('const STORAGE_KEY = "tb-theme"');
    expect(toggle).toContain("localStorage.getItem(STORAGE_KEY)");
    expect(toggle).toContain("localStorage.setItem(STORAGE_KEY, next)");
    expect(toggle).toContain("prefers-color-scheme: dark");
    expect(toggle).toContain("paint(storedTheme() ?? systemTheme())");
    // 模块加载即上色，且能在没有 DOM 的环境里被 import（测试与 SSR 安全）。
    expect(toggle).toContain('if (typeof document !== "undefined") {');
  });
});

/* ── 8. 390 / 1440 两档的关键声明 ─────────────────────────────── */

describe("M5-4P · 两档布局的声明面", () => {
  const css = source("styles.css");

  it("今天页的关键类名都在，且时间线文本能自然换行", () => {
    for (const selector of [
      ".today-page {",
      ".today-open {",
      ".today-greeting {",
      ".today-feed {",
      ".timeline {",
      ".timeline-item {",
      ".timeline-time {",
      ".timeline-text {",
      ".timeline-state {",
      ".today-feed-head {",
      ".today-secondary {",
      ".today-pending {",
      ".tab-icon {",
      ".tab-label {",
      ".link-btn {",
      ".head-tools {",
      ".theme-toggle {",
    ]) {
      expect(css, `缺少 ${selector}`).toContain(selector);
    }
    expect(cssRule(css, ".timeline-text {")).toContain("overflow-wrap: anywhere");
  });

  it("窄屏那档（390px 落在这里）给固定底栏让位，宽屏那档（1440px）限制阅读宽度", () => {
    expect(css).toContain("@media (max-width: 63.99rem)");
    expect(css).toContain("@media (min-width: 64rem)");
    const narrow = css.slice(css.indexOf("@media (max-width: 63.99rem)"));
    expect(narrow).toContain("padding-bottom: 6.25rem");
    expect(narrow).toContain("--tabbar-h:");
    const wide = css.slice(css.indexOf("@media (min-width: 64rem)"));
    expect(wide).toContain("max-width: 44rem");
    expect(css).toContain("height: 100dvh");
  });

  it("外壳宽度把左右内边距算进去，390px 下不会横向撑出 48px", () => {
    expect(cssRule(css, ".shell {")).toContain("box-sizing: border-box");
  });

  it("可点条目都有明确的触控高度：主按钮与导航 44px，次级 pill 40px", () => {
    for (const selector of [".btn {", ".tab-btn {", ".link-btn {", ".theme-toggle {", ".sub-btn {"]) {
      expect(cssRule(css, selector), `${selector} 没有 min-height`).toContain("min-height");
    }
    expect(cssRule(css, ".btn {")).toContain("min-height: 2.75rem");
    expect(cssRule(css, ".tab-btn {")).toContain("min-height: 3.5rem");
    for (const selector of [".sub-btn {", ".link-btn {", ".theme-toggle {"]) {
      expect(cssRule(css, selector)).toContain("min-height: 2.5rem");
    }
  });

  it("动效尊重 prefers-reduced-motion", () => {
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
    const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(reduced).toContain("animation: none");
  });

  it("本轮没有引入任何 UI 框架 / 组件库依赖", () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    expect(Object.keys(pkg.dependencies).sort()).toEqual(["lucide-react", "react", "react-dom", "zod"]);
    expect(Object.keys(pkg.devDependencies).sort()).toEqual([
      "@types/node",
      "@types/react",
      "@types/react-dom",
      "@vitejs/plugin-react",
      "typescript",
      "vite",
      "vitest",
    ]);
  });
});
