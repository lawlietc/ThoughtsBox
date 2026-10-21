import { emotionBallLayout } from "./boxBalls.ts";
import type { EmotionBall } from "./boxBalls.ts";
import type { PortRow } from "./projectionPort.ts";

/**
 * 盒子场景的唯一相机与几何定义。
 *
 * 这里不碰 React 和 DOM：盒体、盖子与球先形成三维坐标，再用同一个固定相机
 * 投影到 SVG。这样盖子的后沿铰链、盒内空间和球的遮挡才来自同一套场景。
 */

export const SCENE_WIDTH = 720;
export const SCENE_HEIGHT = 640;
export const OPEN_ANGLE_DEG = 49;

export const BOX_SPEC = {
  width: 6,
  depth: 6,
  height: 2,
  wall: 0.3,
  lidThickness: 0.28,
  lidLip: 0.58,
  floorY: 0.3,
} as const;

export const SCENE_CAMERA = {
  fovDeg: 45,
  pitchDeg: 40,
  radius: 12,
  lookAtY: 2.2,
} as const;

export interface Vec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface ProjectedPoint extends Vec3 {
  readonly screenX: number;
  readonly screenY: number;
  readonly depth: number;
  /** 同一深度下，一个世界单位对应多少 SVG 像素。 */
  readonly scale: number;
}

export type FaceTone =
  | "floor"
  | "inner"
  | "inner-shade"
  | "outer"
  | "outer-shade"
  | "rim"
  | "lid"
  | "lid-edge";

export interface SceneFace {
  readonly id: string;
  readonly tone: FaceTone;
  readonly points: readonly ProjectedPoint[];
  readonly depth: number;
  readonly foreground: boolean;
}

export interface SceneBall extends EmotionBall {
  readonly screenX: number;
  readonly screenY: number;
  readonly depth: number;
  readonly projectedRadius: number;
  readonly layer: number;
}

export interface BallShadow {
  readonly id: string;
  readonly cx: number;
  readonly cy: number;
  readonly rx: number;
  readonly ry: number;
}

export interface SceneLabel {
  readonly x: number;
  readonly y: number;
}

export interface BoxScene {
  readonly backFaces: readonly SceneFace[];
  readonly foregroundFaces: readonly SceneFace[];
  readonly balls: readonly SceneBall[];
  readonly shadows: readonly BallShadow[];
  readonly groundShadow: {
    readonly cx: number;
    readonly cy: number;
    readonly rx: number;
    readonly ry: number;
  };
  readonly lidQuad: readonly ProjectedPoint[];
  readonly lidTitle: SceneLabel;
  readonly lidAction: SceneLabel;
  readonly lidBounds: {
    readonly left: number;
    readonly top: number;
    readonly width: number;
    readonly height: number;
  };
}

const HALF_WIDTH = BOX_SPEC.width / 2;
const HALF_DEPTH = BOX_SPEC.depth / 2;
const INNER_HALF_WIDTH = HALF_WIDTH - BOX_SPEC.wall;
const INNER_HALF_DEPTH = HALF_DEPTH - BOX_SPEC.wall;
const DEG = Math.PI / 180;

function subtract(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

function normalize(v: Vec3): Vec3 {
  const length = Math.hypot(v.x, v.y, v.z);
  return { x: v.x / length, y: v.y / length, z: v.z / length };
}

const CAMERA_RAD = SCENE_CAMERA.pitchDeg * DEG;
const EYE: Vec3 = {
  x: 0,
  y: SCENE_CAMERA.lookAtY + SCENE_CAMERA.radius * Math.sin(CAMERA_RAD),
  z: SCENE_CAMERA.radius * Math.cos(CAMERA_RAD),
};
const TARGET: Vec3 = { x: 0, y: SCENE_CAMERA.lookAtY, z: 0 };
const FORWARD = normalize(subtract(TARGET, EYE));
const RIGHT = normalize(cross(FORWARD, { x: 0, y: 1, z: 0 }));
const UP = cross(RIGHT, FORWARD);
const TAN_HALF_FOV = Math.tan((SCENE_CAMERA.fovDeg * DEG) / 2);
const ASPECT = SCENE_WIDTH / SCENE_HEIGHT;

export function projectPoint(point: Vec3): ProjectedPoint {
  const relative = subtract(point, EYE);
  const depth = dot(relative, FORWARD);
  const tanScale = depth * TAN_HALF_FOV;
  const xNdc = dot(relative, RIGHT) / (tanScale * ASPECT);
  const yNdc = dot(relative, UP) / tanScale;
  return {
    ...point,
    screenX: SCENE_WIDTH / 2 + (xNdc * SCENE_WIDTH) / 2,
    screenY: SCENE_HEIGHT / 2 - (yNdc * SCENE_HEIGHT) / 2,
    depth,
    scale: SCENE_WIDTH / (2 * TAN_HALF_FOV * ASPECT * depth),
  };
}

function rotateLidPoint(point: Vec3, openProgress: number): Vec3 {
  const angle = clamp01(openProgress) * OPEN_ANGLE_DEG * DEG;
  const sin = Math.sin(angle);
  const cos = Math.cos(angle);
  return {
    x: point.x,
    y: point.y * cos + point.z * sin + BOX_SPEC.height,
    z: -point.y * sin + point.z * cos - HALF_DEPTH,
  };
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function makeFace(
  id: string,
  tone: FaceTone,
  foreground: boolean,
  points: readonly Vec3[],
): SceneFace {
  const projected = points.map(projectPoint);
  return {
    id,
    tone,
    foreground,
    points: projected,
    depth: projected.reduce((sum, point) => sum + point.depth, 0) / projected.length,
  };
}

function byDepthThenId(a: SceneFace, b: SceneFace): number {
  return b.depth - a.depth || a.id.localeCompare(b.id);
}

/** 开盖只改变一个 0..1 进度；盖子绕后沿上缘的 X 轴旋转。 */
export function boxFacesFor(openProgress: number): readonly SceneFace[] {
  const floorY = BOX_SPEC.floorY;
  const topY = BOX_SPEC.height;
  const faces: SceneFace[] = [
    makeFace(
      "floor",
      "floor",
      false,
      [
        { x: -INNER_HALF_WIDTH, y: floorY, z: -INNER_HALF_DEPTH },
        { x: INNER_HALF_WIDTH, y: floorY, z: -INNER_HALF_DEPTH },
        { x: INNER_HALF_WIDTH, y: floorY, z: INNER_HALF_DEPTH },
        { x: -INNER_HALF_WIDTH, y: floorY, z: INNER_HALF_DEPTH },
      ],
    ),
    makeFace(
      "inner-back",
      "inner-shade",
      false,
      [
        { x: -INNER_HALF_WIDTH, y: floorY, z: -INNER_HALF_DEPTH },
        { x: INNER_HALF_WIDTH, y: floorY, z: -INNER_HALF_DEPTH },
        { x: INNER_HALF_WIDTH, y: topY, z: -INNER_HALF_DEPTH },
        { x: -INNER_HALF_WIDTH, y: topY, z: -INNER_HALF_DEPTH },
      ],
    ),
    makeFace(
      "inner-left",
      "inner",
      false,
      [
        { x: -INNER_HALF_WIDTH, y: floorY, z: -INNER_HALF_DEPTH },
        { x: -INNER_HALF_WIDTH, y: topY, z: -INNER_HALF_DEPTH },
        { x: -INNER_HALF_WIDTH, y: topY, z: INNER_HALF_DEPTH },
        { x: -INNER_HALF_WIDTH, y: floorY, z: INNER_HALF_DEPTH },
      ],
    ),
    makeFace(
      "inner-right",
      "inner",
      false,
      [
        { x: INNER_HALF_WIDTH, y: floorY, z: INNER_HALF_DEPTH },
        { x: INNER_HALF_WIDTH, y: topY, z: INNER_HALF_DEPTH },
        { x: INNER_HALF_WIDTH, y: topY, z: -INNER_HALF_DEPTH },
        { x: INNER_HALF_WIDTH, y: floorY, z: -INNER_HALF_DEPTH },
      ],
    ),
    makeFace(
      "outer-left",
      "outer-shade",
      true,
      [
        { x: -HALF_WIDTH, y: 0, z: -HALF_DEPTH },
        { x: -HALF_WIDTH, y: topY, z: -HALF_DEPTH },
        { x: -HALF_WIDTH, y: topY, z: HALF_DEPTH },
        { x: -HALF_WIDTH, y: 0, z: HALF_DEPTH },
      ],
    ),
    makeFace(
      "outer-right",
      "outer-shade",
      true,
      [
        { x: HALF_WIDTH, y: 0, z: HALF_DEPTH },
        { x: HALF_WIDTH, y: topY, z: HALF_DEPTH },
        { x: HALF_WIDTH, y: topY, z: -HALF_DEPTH },
        { x: HALF_WIDTH, y: 0, z: -HALF_DEPTH },
      ],
    ),
    makeFace(
      "outer-front",
      "outer",
      true,
      [
        { x: -HALF_WIDTH, y: 0, z: HALF_DEPTH },
        { x: -HALF_WIDTH, y: topY, z: HALF_DEPTH },
        { x: HALF_WIDTH, y: topY, z: HALF_DEPTH },
        { x: HALF_WIDTH, y: 0, z: HALF_DEPTH },
      ],
    ),
    makeFace(
      "front-rim",
      "rim",
      true,
      [
        { x: -HALF_WIDTH, y: topY, z: INNER_HALF_DEPTH },
        { x: -HALF_WIDTH, y: topY, z: HALF_DEPTH },
        { x: HALF_WIDTH, y: topY, z: HALF_DEPTH },
        { x: HALF_WIDTH, y: topY, z: INNER_HALF_DEPTH },
      ],
    ),
    makeFace(
      "left-rim",
      "rim",
      true,
      [
        { x: -HALF_WIDTH, y: topY, z: -HALF_DEPTH },
        { x: -INNER_HALF_WIDTH, y: topY, z: -HALF_DEPTH },
        { x: -INNER_HALF_WIDTH, y: topY, z: HALF_DEPTH },
        { x: -HALF_WIDTH, y: topY, z: HALF_DEPTH },
      ],
    ),
    makeFace(
      "right-rim",
      "rim",
      true,
      [
        { x: INNER_HALF_WIDTH, y: topY, z: HALF_DEPTH },
        { x: INNER_HALF_WIDTH, y: topY, z: -HALF_DEPTH },
        { x: HALF_WIDTH, y: topY, z: -HALF_DEPTH },
        { x: HALF_WIDTH, y: topY, z: HALF_DEPTH },
      ],
    ),
    makeFace(
      "back-rim",
      "rim",
      true,
      [
        { x: -HALF_WIDTH, y: topY, z: -HALF_DEPTH },
        { x: HALF_WIDTH, y: topY, z: -HALF_DEPTH },
        { x: INNER_HALF_WIDTH, y: topY, z: -INNER_HALF_DEPTH },
        { x: -INNER_HALF_WIDTH, y: topY, z: -INNER_HALF_DEPTH },
      ],
    ),
  ];

  const lid = (point: Vec3): Vec3 => rotateLidPoint(point, openProgress);
  faces.push(
    makeFace(
      "lid-top",
      "lid",
      true,
      [
        lid({ x: -HALF_WIDTH, y: BOX_SPEC.lidThickness, z: 0 }),
        lid({ x: HALF_WIDTH, y: BOX_SPEC.lidThickness, z: 0 }),
        lid({ x: HALF_WIDTH, y: BOX_SPEC.lidThickness, z: BOX_SPEC.depth }),
        lid({ x: -HALF_WIDTH, y: BOX_SPEC.lidThickness, z: BOX_SPEC.depth }),
      ],
    ),
    makeFace(
      "lid-front-edge",
      "lid-edge",
      true,
      [
        lid({ x: -HALF_WIDTH, y: BOX_SPEC.lidThickness, z: BOX_SPEC.depth }),
        lid({ x: HALF_WIDTH, y: BOX_SPEC.lidThickness, z: BOX_SPEC.depth }),
        lid({ x: HALF_WIDTH, y: -BOX_SPEC.lidLip, z: BOX_SPEC.depth }),
        lid({ x: -HALF_WIDTH, y: -BOX_SPEC.lidLip, z: BOX_SPEC.depth }),
      ],
    ),
    makeFace(
      "lid-left-edge",
      "lid-edge",
      true,
      [
        lid({ x: -HALF_WIDTH, y: BOX_SPEC.lidThickness, z: 0 }),
        lid({ x: -HALF_WIDTH, y: BOX_SPEC.lidThickness, z: BOX_SPEC.depth }),
        lid({ x: -HALF_WIDTH, y: -BOX_SPEC.lidLip, z: BOX_SPEC.depth }),
        lid({ x: -HALF_WIDTH, y: -BOX_SPEC.lidLip, z: 0 }),
      ],
    ),
    makeFace(
      "lid-right-edge",
      "lid-edge",
      true,
      [
        lid({ x: HALF_WIDTH, y: BOX_SPEC.lidThickness, z: BOX_SPEC.depth }),
        lid({ x: HALF_WIDTH, y: BOX_SPEC.lidThickness, z: 0 }),
        lid({ x: HALF_WIDTH, y: -BOX_SPEC.lidLip, z: 0 }),
        lid({ x: HALF_WIDTH, y: -BOX_SPEC.lidLip, z: BOX_SPEC.depth }),
      ],
    ),
    makeFace(
      "lid-back-edge",
      "lid-edge",
      true,
      [
        lid({ x: HALF_WIDTH, y: BOX_SPEC.lidThickness, z: 0 }),
        lid({ x: -HALF_WIDTH, y: BOX_SPEC.lidThickness, z: 0 }),
        lid({ x: -HALF_WIDTH, y: -BOX_SPEC.lidLip, z: 0 }),
        lid({ x: HALF_WIDTH, y: -BOX_SPEC.lidLip, z: 0 }),
      ],
    ),
  );

  return faces.sort(byDepthThenId);
}

function lidQuad(openProgress: number): readonly ProjectedPoint[] {
  const lid = (x: number, z: number): Vec3 => rotateLidPoint({ x, y: BOX_SPEC.lidThickness, z }, openProgress);
  return [
    projectPoint(lid(-HALF_WIDTH, 0)),
    projectPoint(lid(HALF_WIDTH, 0)),
    projectPoint(lid(HALF_WIDTH, BOX_SPEC.depth)),
    projectPoint(lid(-HALF_WIDTH, BOX_SPEC.depth)),
  ];
}

function sceneLabel(x: number, z: number, openProgress: number): SceneLabel {
  const point = rotateLidPoint({ x, y: BOX_SPEC.lidThickness + 0.01, z }, openProgress);
  const projected = projectPoint(point);
  return { x: projected.screenX, y: projected.screenY };
}

export function boxScene(openProgress: number, rows: readonly PortRow[], pageVariant: number = 0): BoxScene {
  const faces = boxFacesFor(openProgress);
  const layout = emotionBallLayout(rows, pageVariant);
  const projected = layout
    .map((ball): Omit<SceneBall, "layer"> => {
      const center = projectPoint({
        x: ball.sceneX,
        y: BOX_SPEC.floorY + ball.radius,
        z: ball.sceneZ,
      });
      return {
        ...ball,
        screenX: center.screenX,
        screenY: center.screenY,
        depth: center.depth,
        projectedRadius: ball.desktopSize / 2,
      };
    })
    .toSorted((a, b) => b.depth - a.depth || a.id.localeCompare(b.id));
  const balls = projected.map((ball, index): SceneBall => ({ ...ball, layer: 100 + index }));

  const shadows = balls.map((ball): BallShadow => {
    return {
      id: ball.id,
      cx: ball.screenX,
      cy: ball.screenY + ball.projectedRadius * 0.62,
      rx: ball.projectedRadius * 1.05,
      ry: ball.projectedRadius * 0.3,
    };
  });

  const footprint = [
    projectPoint({ x: -HALF_WIDTH, y: 0, z: -HALF_DEPTH }),
    projectPoint({ x: HALF_WIDTH, y: 0, z: -HALF_DEPTH }),
    projectPoint({ x: HALF_WIDTH, y: 0, z: HALF_DEPTH }),
    projectPoint({ x: -HALF_WIDTH, y: 0, z: HALF_DEPTH }),
  ];
  const footprintLeft = Math.min(...footprint.map((point) => point.screenX));
  const footprintRight = Math.max(...footprint.map((point) => point.screenX));
  const footprintTop = Math.min(...footprint.map((point) => point.screenY));
  const footprintBottom = Math.max(...footprint.map((point) => point.screenY));
  const groundShadow = {
    cx: (footprintLeft + footprintRight) / 2,
    cy: footprintBottom - (footprintBottom - footprintTop) * 0.16,
    rx: ((footprintRight - footprintLeft) / 2) * 1.08,
    ry: Math.max(24, (footprintBottom - footprintTop) * 0.16),
  };

  const quad = lidQuad(openProgress);
  const left = Math.min(...quad.map((point) => point.screenX));
  const right = Math.max(...quad.map((point) => point.screenX));
  const top = Math.min(...quad.map((point) => point.screenY));
  const bottom = Math.max(...quad.map((point) => point.screenY));

  return {
    backFaces: faces.filter((face) => !face.foreground),
    foregroundFaces: faces.filter((face) => face.foreground),
    balls,
    shadows,
    groundShadow,
    lidQuad: quad,
    lidTitle: sceneLabel(-1.9, 4.75, openProgress),
    lidAction: sceneLabel(1.9, 4.75, openProgress),
    lidBounds: {
      left: (left / SCENE_WIDTH) * 100,
      top: (top / SCENE_HEIGHT) * 100,
      width: ((right - left) / SCENE_WIDTH) * 100,
      height: ((bottom - top) / SCENE_HEIGHT) * 100,
    },
  };
}
