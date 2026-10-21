import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const WEB = join(process.cwd(), "src", "web");

function source(name: string): string {
  return readFileSync(join(WEB, name), "utf8");
}

function declaredClasses(): Set<string> {
  return new Set([...source("styles.css").matchAll(/\.([A-Za-z][\w-]*)/g)].map((match) => match[1]!));
}

describe("M5-5D · 情绪页默认盒子，并提供盒子的开合外观", () => {
  const box = source("BoxPanel.tsx");

  it("情绪页默认盒子、盒子排在列表前，并按页面记住用户选择", () => {
    expect(box).toContain('const BOX_DISPLAY_KEY_PREFIX = "tb-box-view:"');
    expect(box).toContain('const LEGACY_BOX_DISPLAY_KEY = "tb-box-view"');
    expect(box).toContain('return view === "emotions";');
    expect(box).toContain('return "box";');
    expect(box).toContain("window.localStorage.setItem(key, display)");
    expect(box).toContain("storedDisplay(shape.view)");
    expect(box).toContain("{canChooseDisplay && (");
    expect(box).toContain('aria-pressed={display === "box"}');
    expect(box).toContain('aria-pressed={display === "list"}');
    expect(box.indexOf('aria-pressed={display === "box"}')).toBeLessThan(
      box.indexOf('aria-pressed={display === "list"}'),
    );
    expect(source("App.tsx")).toContain("<BoxPanel key={view} view={view} port={port} />");
  });

  it("列表模式仍保留 RecordList 的键盘与详情路径", () => {
    expect(box).toContain('<RecordList');
    expect(box).toContain('{display === "list" && (');
    expect(box).toContain('selectedId={selectedId}');
    expect(box).toContain('onSelect={setSelectedId}');
  });

  it("盖子用原生 button，开合状态与受控区域对辅助技术可见", () => {
    expect(box).toContain('className="box-lid-hit"');
    expect(box).toContain("aria-label={`${props.open ? \"合上\" : \"打开\"}${props.title}`}");
    expect(box).toContain("aria-expanded={props.open}");
    expect(box).toContain("aria-controls={props.trayId}");
    expect(box).toContain("onClick={props.onToggle}");
    expect(box).toContain('{props.open ? "合上" : "打开"}');
    expect(box).toContain("const [boxOpen, setBoxOpen] = useState(false)");
  });

  it("数量、计数占位与分组说明都收进次级折叠层", () => {
    const disclosed = box.match(/<DisclosureNote summary="数量与分组说明">[\s\S]*?<\/DisclosureNote>/)?.[0] ?? "";
    expect(disclosed).toContain('className="row-meta"');
    expect(disclosed).toContain("props.content.counts[index] ?? COUNT_PLACEHOLDER");
    expect(disclosed).toContain("{group.note}");
    expect(box.indexOf("<CountsAndNotes")).toBeGreaterThan(
      box.indexOf('{display === "box" && content !== null'),
    );
  });

  it("只有情绪页有盒子档；其它四页固定列表，不再渲染占位球", () => {
    expect(box).not.toContain("BOX_PLACEHOLDER_COUNT");
    expect(box).not.toContain("box-placeholder-grid");
    expect(box).not.toContain("box-placeholder");
    expect(box).toContain('props.hasRows && scene.balls.length > 0');
    expect(box).toContain('<p className="box-empty">盒子还是空的</p>');
  });

  it("数据口给不出这一页时，列表与盒子两档都只显示诚实状态，不假装空盒", () => {
    expect(box.match(/\{content === null && <StatusLine>\{PROJECTION_UNREADY\}<\/StatusLine>\}/g)).toHaveLength(1);
    expect(box).toContain('{display === "box" && content === null && <StatusLine>{PROJECTION_UNREADY}</StatusLine>}');
    expect(box).toContain('{display === "box" && content !== null && (');
  });

  it("盒子页使用的新类名全部在 styles.css 封闭词汇表里", () => {
    const declared = declaredClasses();
    for (const token of [
      "box-page-head",
      "box-view-switch",
      "box-view-option",
      "box-notes",
      "box-visual",
      "is-open",
      "has-pager",
      "box-stage",
      "box-svg",
      "box-svg-background",
      "box-svg-foreground",
      "box-face",
      "box-face-floor",
      "box-face-inner",
      "box-face-inner-shade",
      "box-face-outer",
      "box-face-outer-shade",
      "box-face-rim",
      "box-face-lid",
      "box-face-lid-edge",
      "box-ground-shadow",
      "box-ball-shadow",
      "box-lid-hit",
      "box-lid-title",
      "box-lid-action",
      "box-interior",
      "box-emotion-map",
      "box-ball",
      "box-ball-label",
      "box-pager",
      "box-page-btn",
      "box-empty",
      "box-row-detail",
      "box-row-detail-title",
      "box-detail-blocks",
      "box-detail-block",
      "box-detail-block-head",
      "box-detail-badges",
      "box-detail-badge",
      "box-detail-fields",
      "box-detail-field",
      "box-detail-evidence",
      "box-detail-dialog",
      "box-detail-shell",
      "box-detail-scroll",
      "box-detail-close",
      "citation-view",
      "citation-back",
      "citation-heading",
      "citation-version",
      "citation-evidence",
    ]) {
      expect(declared.has(token), `.${token}`).toBe(true);
    }
  });
});

describe("M5-5F · 盒子详情弹窗与同层引用返回", () => {
  const box = source("BoxPanel.tsx");
  const detail = source("BoxDetail.tsx");
  const list = source("ui/ListDetail.tsx");
  const sourceText = source("ui/SourceText.tsx");

  it("列表与盒子共用分段详情；盒子模式始终单栏，详情交给弹窗", () => {
    expect(box).toContain("<BoxRowDetail");
    expect(box).toContain("<BoxDetailDialog");
    expect(box).toContain('listOnly={display === "box"}');
    expect(box).toContain("display === \"box\" && boxSelected !== null");
    expect(box).not.toContain("<KeyValue");
    expect(list).toContain("const listOnly = props.listOnly === true");
    expect(list).toContain("(!narrow || !hasSelection || listOnly)");
  });

  it("详情弹窗使用原生 dialog，并在同一个弹窗内钻取引用", () => {
    expect(detail).toContain('<dialog');
    expect(detail).toContain("dialog.showModal()");
    expect(detail).toContain("backToDetail");
    expect(detail).toContain("setCitation(null)");
    expect(detail).toContain("event.target !== event.currentTarget");
    expect(detail).toContain("<SourceText");
    expect(detail).toContain("data-block-id={block.id}");
    expect(detail).toContain('querySelector<HTMLButtonElement>("button.mention")?.focus()');
    expect(detail).toContain("autoFocus");
  });

  it("证据引用不经过页面导航，列表模式也在盒子页内打开引用弹窗", () => {
    expect(box).toContain("<CitationDialog");
    expect(box).not.toContain("setView(");
    expect(box).not.toContain("apiClient");
    expect(detail).not.toContain("setView(");
    expect(detail).not.toContain("apiClient");
    expect(detail).toContain("onBack={backToDetail}");
  });

  it("原文高亮先验证当前版本坐标，减少系统动态效果时关闭弹窗动画", () => {
    expect(sourceText).toContain("props.text.slice(highlight.start, highlight.end) === highlight.text");
    expect(sourceText).toContain("scrollIntoView({ block: \"center\" })");
    expect(source("styles.css")).toContain("body:has(.box-detail-dialog[open])");
    expect(source("styles.css")).toContain("@keyframes box-detail-rise");
  });
});

describe("M5-5D · 拟物化材质与动效的边界", () => {
  const css = source("styles.css");
  const scene = source("boxScene.ts");
  const box = source("BoxPanel.tsx");

  it("盒体由固定相机投影成 SVG，盖子绕后沿旋转，不依赖图片或 3D 引擎", () => {
    expect(scene).toContain("export const OPEN_ANGLE_DEG = 49");
    expect(scene).toContain("export function projectPoint");
    expect(scene).toContain("export function boxFacesFor");
    expect(scene).toContain("function rotateLidPoint");
    expect(scene).toContain("z: -point.y * sin + point.z * cos - HALF_DEPTH");
    expect(css).toContain(".box-stage");
    expect(css).toMatch(/\.box-stage\s*\{[\s\S]*?perspective: none;/);
    expect(css).toContain(".box-svg");
    expect(css).not.toMatch(/background-image:\s*url\(/);
  });

  it("浅色与深色各自有盒体材质，玻璃珠有透明边缘、高光和可读名称", () => {
    expect(css).toContain('[data-theme="dark"] .box-visual');
    expect(css).toContain("--glass-tint");
    expect(css).toContain("--glass-rim");
    expect(css).toContain("radial-gradient(circle at 32% 23%");
    expect(css).toContain(".box-ball-label");
    expect(css).toContain("backdrop-filter: blur(1.5px) saturate(0.94)");
  });

  it("减少动态效果时直接切换开合，不留下位移或淡入", () => {
    expect(box).toContain('window.matchMedia("(prefers-reduced-motion: reduce)")');
    expect(box).toContain("progressRef.current = to");
    expect(box).toContain("requestAnimationFrame(tick)");
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.box-interior,[\s\S]*?\.box-ball[\s\S]*?transition: none;/);
  });

  it("合上时盖子遮住内腔；打开后内腔才可见，球按钮保留键盘路径", () => {
    expect(css).toMatch(/\.box-visual \.box-interior\s*\{[\s\S]*?visibility: hidden;/);
    expect(css).toMatch(/\.box-visual\.is-open \.box-interior\s*\{[\s\S]*?visibility: visible;/);
    expect(box).toContain("scene.foregroundFaces");
    expect(box).toContain("box-svg-foreground");
    expect(box).toContain("className=\"box-ball\"");
    expect(css).toContain(".box-ball:focus-visible");
  });
});
