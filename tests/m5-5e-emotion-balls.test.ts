import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  DESKTOP_MAX_BALL_DIAMETER,
  EMOTION_BALLS_PER_PAGE,
  emotionBallPages,
  emotionBallLayout,
  MIN_BALL_DIAMETER,
  MOBILE_MAX_BALL_DIAMETER,
} from "../src/web/boxBalls.ts";
import type { PortRow } from "../src/web/projectionPort.ts";

const WEB = join(process.cwd(), "src", "web");

function source(name: string): string {
  return readFileSync(join(WEB, name), "utf8");
}

function row(id: string, weight?: number): PortRow {
  return {
    id,
    title: `情绪 ${id}`,
    meta: `${weight ?? "—"} 次提及`,
    detail: [],
    ...(weight === undefined ? {} : { weight }),
  };
}

describe("M5-5E · 频次是结构化数据，不从文案反解", () => {
  it("PortRow 增加可选 weight，生产与 fixture 都写 mentions.length", () => {
    expect(source("projectionPort.ts")).toContain("readonly weight?: number");
    expect(source("projections.ts")).toContain("weight: mentions.length");
    expect(source("fixturePort.ts")).toContain("weight: mentions.length");
    expect(source("fixturePort.ts")).toContain("weight: 0");
  });

  it("布局只读 weight，不解析 meta 里的「N 次提及」", () => {
    const layout = source("boxBalls.ts");
    expect(layout).toContain("row.weight");
    expect(layout).not.toMatch(/\.meta\s*\.(match|split|replace|includes)/);
    expect(source("BoxPanel.tsx")).not.toMatch(/\.meta\s*\.(match|split|replace|includes)/);
  });
});

describe("M5-5E · 尺寸与位置确定、可重复", () => {
  it("weight 0 与 undefined 不进球区；所有出现过的情绪按 9 个一页完整分页", () => {
    const rows = [
      row("zero", 0),
      row("unknown"),
      ...Array.from({ length: 30 }, (_, index) => row(`r${index + 1}`, 30 - index)),
    ];
    const pages = emotionBallPages(rows);
    expect(EMOTION_BALLS_PER_PAGE).toBe(9);
    expect(pages.map((page) => page.length)).toEqual([9, 9, 9, 3]);
    expect(pages.flat().map((item) => item.weight)).toEqual(
      Array.from({ length: 30 }, (_, index) => 30 - index),
    );
    expect(pages.flat().some((item) => item.id === "zero" || item.id === "unknown")).toBe(false);
  });

  it("同一批数据两次计算结果完全一致，位置自然散落且只允许适度交叠", () => {
    const rows = Array.from({ length: 12 }, (_, index) => row(`emotion-${index}`, 100 - index * 7));
    const first = emotionBallLayout(rows);
    const second = emotionBallLayout(rows);
    expect(first).toEqual(second);
    expect(first).toHaveLength(rows.length);
    for (const ball of first) {
      expect(ball.sceneX).toBeGreaterThanOrEqual(-2.4);
      expect(ball.sceneX).toBeLessThanOrEqual(2.4);
      expect(ball.sceneZ).toBeGreaterThanOrEqual(-2.4);
      expect(ball.sceneZ).toBeLessThanOrEqual(2.4);
      expect(ball.radius).toBeGreaterThan(0);
    }
    expect(new Set(first.map((ball) => `${ball.sceneX}:${ball.sceneZ}`)).size).toBe(first.length);
    expect(new Set(first.map((ball) => ball.sceneZ.toFixed(4))).size).toBe(first.length);
    for (let left = 0; left < first.length; left += 1) {
      for (let right = left + 1; right < first.length; right += 1) {
        const a = first[left]!;
        const b = first[right]!;
        const distance = Math.hypot(a.sceneX - b.sceneX, a.sceneZ - b.sceneZ);
        expect(distance).toBeGreaterThan((a.radius + b.radius) * 0.82);
      }
    }
  });

  it("翻页变体只改变确定性落点，不改变这一页的球与频次", () => {
    const rows = Array.from({ length: 9 }, (_, index) => row(`emotion-${index}`, 9 - index));
    const first = emotionBallLayout(rows, 0);
    const second = emotionBallLayout(rows, 1);
    const repeated = emotionBallLayout(rows, 1);
    expect(second).toEqual(repeated);
    expect(second.map((ball) => ball.id)).toEqual(first.map((ball) => ball.id));
    expect(second.map((ball) => ball.weight)).toEqual(first.map((ball) => ball.weight));
    expect(
      second.some(
        (ball, index) =>
          ball.sceneX !== first[index]!.sceneX ||
          ball.sceneZ !== first[index]!.sceneZ,
      ),
    ).toBe(true);
  });

  it("直径按平方根缩放：手机最大 48px，桌面最大 64px，最小始终 44px", () => {
    const balls = emotionBallLayout([row("max", 100), row("quarter", 25), row("min", 1)]);
    const max = balls.find((ball) => ball.id === "max")!;
    const quarter = balls.find((ball) => ball.id === "quarter")!;
    const min = balls.find((ball) => ball.id === "min")!;

    expect(max.mobileSize).toBe(MOBILE_MAX_BALL_DIAMETER);
    expect(max.desktopSize).toBe(DESKTOP_MAX_BALL_DIAMETER);
    expect(quarter.mobileSize).toBe(
      Math.round(MIN_BALL_DIAMETER + (MOBILE_MAX_BALL_DIAMETER - MIN_BALL_DIAMETER) * 0.5),
    );
    expect(quarter.desktopSize).toBe(
      Math.round(MIN_BALL_DIAMETER + (DESKTOP_MAX_BALL_DIAMETER - MIN_BALL_DIAMETER) * 0.5),
    );
    for (const ball of balls) {
      expect(ball.mobileSize).toBeGreaterThanOrEqual(MIN_BALL_DIAMETER);
      expect(ball.mobileSize).toBeLessThanOrEqual(MOBILE_MAX_BALL_DIAMETER);
      expect(ball.desktopSize).toBeGreaterThanOrEqual(MIN_BALL_DIAMETER);
      expect(ball.desktopSize).toBeLessThanOrEqual(DESKTOP_MAX_BALL_DIAMETER);
    }
    expect(min.mobileSize).toBeLessThan(quarter.mobileSize);
    expect(quarter.mobileSize).toBeLessThan(max.mobileSize);

    const crowded = emotionBallLayout(Array.from({ length: 18 }, (_, index) => row(`crowded-${index}`, 18 - index)));
    expect(Math.max(...crowded.map((ball) => ball.desktopSize))).toBeLessThanOrEqual(DESKTOP_MAX_BALL_DIAMETER);
    expect(Math.max(...crowded.map((ball) => ball.mobileSize))).toBeLessThanOrEqual(MOBILE_MAX_BALL_DIAMETER);
  });
});

describe("M5-5E · 圆球可点击、有可读名称，并保留列表退路", () => {
  const box = source("BoxPanel.tsx");

  it("情绪页读取三维场景结果；每个球都是原生 button，名称带情绪与频次", () => {
    expect(box).toContain('import { boxScene, SCENE_HEIGHT, SCENE_WIDTH } from "./boxScene.ts"');
    expect(box).toContain("const scene = boxScene(progress");
    expect(box).toContain("scene.balls.map");
    expect(box).toContain('<button');
    expect(box).toContain('className="box-ball"');
    expect(box).toContain("aria-label={label}");
    expect(box).toContain("const label = `${props.ball.title}，出现 ${props.ball.weight} 次`");
    expect(box).toContain('className="box-ball-label"');
    expect(box).toContain("{props.ball.title}");
  });

  it("点球进入现有详情；左右按钮翻页，不显示页码或剩余数量", () => {
    expect(box).toContain("onClick={() => props.onSelect(props.ball.id)}");
    expect(box).toContain("onSelect={setSelectedId}");
    expect(box).toContain("const pages = emotionBallPages(props.rows)");
    expect(box).toContain('className="box-pager"');
    expect(box).toContain('aria-label="上一组情绪球"');
    expect(box).toContain('aria-label="下一组情绪球"');
    expect(box).not.toContain("hiddenBallCount");
    expect(box).not.toContain("盒内展示出现最多的");
    expect(box).toContain('{display === "list" && (');
  });

  it("翻页时复用简单入场动画，并尊重减少动态偏好", () => {
    const css = source("styles.css");
    expect(source("BoxPanel.tsx")).toContain("boxScene(progress, currentRows, safePageIndex)");
    expect(source("BoxPanel.tsx")).toContain("key={`page-${safePageIndex}`}");
    expect(css).toContain("animation: box-ball-settle 180ms ease-out");
    expect(css).toContain("animation: box-ball-label-settle 180ms ease-out");
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.box-emotion-map \.box-ball/);
  });

  it("翻页按钮位于盒体下方，并为按钮预留布局空间", () => {
    const css = source("styles.css");
    const pager = css.match(/\.box-pager\s*\{[^}]*\}/)?.[0] ?? "";
    const pagedBox = css.match(/\.box-visual\.has-pager\s*\{[^}]*\}/)?.[0] ?? "";
    expect(pager).toContain("position: absolute");
    expect(pager).toContain("top: calc(100% + 0.55rem)");
    expect(pagedBox).toContain("margin-bottom: 3.55rem");
  });

  it("投影位置与尺寸走 CSS 变量；手机和桌面分别使用各自上限", () => {
    const css = source("styles.css");
    expect(css).toContain("left: var(--ball-x)");
    expect(css).toContain("top: var(--ball-y)");
    expect(css).toContain("width: var(--ball-mobile-size)");
    expect(css).toMatch(/@media \(min-width: 64rem\) \{[\s\S]*?\.box-ball\s*\{[\s\S]*?var\(--ball-desktop-size\)/);
    expect(css).toContain(".box-ball:focus-visible");
    expect(css).toContain("calc(var(--ball-mobile-size) * 0.155)");
    expect(css).toContain("calc(var(--ball-desktop-size) * 0.16)");
    expect(css).toContain("color: var(--ball-label-ink)");
    expect(css).toContain("text-shadow: var(--ball-label-shadow)");
    expect(css).not.toContain("background: var(--ball-label-bg)");
    expect(css).not.toContain("border: 1px solid var(--ball-label-rim)");
    expect(css).toContain("z-index: 500 !important");
  });
});
