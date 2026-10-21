import { describe, expect, it } from "vitest";

import { EMOTION_BALLS_PER_PAGE, emotionBallPages } from "../src/web/boxBalls.ts";
import {
  boxFacesFor,
  boxScene,
  OPEN_ANGLE_DEG,
  projectPoint,
  SCENE_HEIGHT,
  SCENE_WIDTH,
} from "../src/web/boxScene.ts";
import type { PortRow } from "../src/web/projectionPort.ts";

function row(id: string, weight: number): PortRow {
  return {
    id,
    title: `情绪 ${id}`,
    meta: `${weight} 次提及`,
    detail: [],
    weight,
  };
}

describe("M5-5F 前置 · 盒体、盖子与球共用一套固定相机", () => {
  it("投影是确定的；远处物体投影更小，正面中心点落在画布中轴", () => {
    const center = projectPoint({ x: 0, y: 0.3, z: 0 });
    const near = projectPoint({ x: 0, y: 0.3, z: 2.7 });
    const far = projectPoint({ x: 0, y: 0.3, z: -2.7 });

    expect(center.screenX).toBeCloseTo(SCENE_WIDTH / 2, 6);
    expect(center).toEqual(projectPoint({ x: 0, y: 0.3, z: 0 }));
    expect(near.scale).toBeGreaterThan(far.scale);
    expect(near.depth).toBeLessThan(far.depth);
  });

  it("盖子后沿是固定铰链：开合只抬高前缘，不移动后沿", () => {
    const closed = boxFacesFor(0).find((face) => face.id === "lid-top")!;
    const open = boxFacesFor(1).find((face) => face.id === "lid-top")!;

    expect(OPEN_ANGLE_DEG).toBe(49);
    expect(Math.abs(open.points[0]!.screenX - closed.points[0]!.screenX)).toBeLessThan(3);
    expect(Math.abs(open.points[0]!.screenY - closed.points[0]!.screenY)).toBeLessThan(3);
    expect(closed.points[2]!.screenY - open.points[2]!.screenY).toBeGreaterThan(150);
  });

  it("盖子顶板与四周翻边共享上缘，面板和裙边是一整块", () => {
    const faces = boxFacesFor(1);
    const top = faces.find((face) => face.id === "lid-top")!;
    const topCorners = new Set(
      top.points.map((point) => `${point.screenX.toFixed(4)},${point.screenY.toFixed(4)}`),
    );

    for (const id of ["lid-back-edge", "lid-front-edge", "lid-left-edge", "lid-right-edge"]) {
      const edge = faces.find((face) => face.id === id)!;
      const shared = edge.points.filter((point) =>
        topCorners.has(`${point.screenX.toFixed(4)},${point.screenY.toFixed(4)}`),
      );
      expect(shared, id).toHaveLength(2);
    }
  });

  it("开合进度会夹在 0..1，正反两个方向沿同一条路径返回", () => {
    const below = boxFacesFor(-1);
    const closed = boxFacesFor(0);
    const above = boxFacesFor(2);
    const open = boxFacesFor(1);

    expect(below).toEqual(closed);
    expect(above).toEqual(open);
  });

  it("所有盒体、盖子和球的投影都落在固定 viewBox 内", () => {
    const scene = boxScene(
      1,
      [row("calm", 100), row("tired", 64), row("joy", 25), row("sad", 9)],
    );
    const points = [...scene.backFaces, ...scene.foregroundFaces].flatMap((face) => face.points);
    for (const point of points) {
      expect(point.screenX).toBeGreaterThanOrEqual(0);
      expect(point.screenX).toBeLessThanOrEqual(SCENE_WIDTH);
      expect(point.screenY).toBeGreaterThanOrEqual(0);
      expect(point.screenY).toBeLessThanOrEqual(SCENE_HEIGHT);
    }
    for (const ball of scene.balls) {
      expect(ball.screenX).toBeGreaterThan(0);
      expect(ball.screenX).toBeLessThan(SCENE_WIDTH);
      expect(ball.screenY).toBeGreaterThan(0);
      expect(ball.screenY).toBeLessThan(SCENE_HEIGHT);
      expect(ball.projectedRadius).toBeGreaterThan(0);
    }
    expect(scene.groundShadow.cx).toBeGreaterThan(0);
    expect(scene.groundShadow.cx).toBeLessThan(SCENE_WIDTH);
    expect(scene.groundShadow.cy).toBeGreaterThan(0);
    expect(scene.groundShadow.cy).toBeLessThan(SCENE_HEIGHT);
    expect(scene.groundShadow.rx).toBeGreaterThan(0);
    expect(scene.groundShadow.ry).toBeGreaterThan(0);
  });

  it("盒体占据画布主要区域；情绪页每页最多放 9 个球", () => {
    const rows = Array.from({ length: 19 }, (_, index) => row(`emotion-${index}`, 19 - index));
    const firstPage = emotionBallPages(rows)[0] ?? [];
    const scene = boxScene(1, firstPage);
    const points = [...scene.backFaces, ...scene.foregroundFaces].flatMap((face) => face.points);
    const left = Math.min(...points.map((point) => point.screenX));
    const right = Math.max(...points.map((point) => point.screenX));
    const boxWidthRatio = (right - left) / SCENE_WIDTH;

    expect(boxWidthRatio).toBeGreaterThan(0.72);
    expect(boxWidthRatio).toBeLessThan(0.84);
    expect(scene.balls).toHaveLength(EMOTION_BALLS_PER_PAGE);
    expect(scene.balls.map((ball) => ball.weight).toSorted((a, b) => b - a)).toEqual(
      Array.from({ length: EMOTION_BALLS_PER_PAGE }, (_, index) => 19 - index),
    );
    expect(new Set(scene.balls.map((ball) => ball.screenY.toFixed(1))).size).toBeGreaterThanOrEqual(8);
  });

  it("球按深度从远到近排序；频次决定球体半径与投影面积", () => {
    const scene = boxScene(1, [row("max", 100), row("quarter", 25), row("min", 1)]);
    const max = scene.balls.find((ball) => ball.id === "max")!;
    const min = scene.balls.find((ball) => ball.id === "min")!;

    for (let index = 1; index < scene.balls.length; index += 1) {
      expect(scene.balls[index - 1]!.depth).toBeGreaterThanOrEqual(scene.balls[index]!.depth);
    }
    expect(max.radius).toBeGreaterThan(min.radius);
    expect(max.projectedRadius).toBeGreaterThan(min.projectedRadius);
    expect(scene.shadows).toHaveLength(scene.balls.length);
  });
});
