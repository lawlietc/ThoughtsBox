import type { PortRow } from "./projectionPort.ts";

/**
 * 情绪球的确定性布局。
 *
 * `weight` 是数据口给的频次，不从 `meta` 反解。位置落在盒底的三维平面上，
 * 先按黄金角铺开，再做少量确定性避让；同一批数据每次打开都落在同一处。
 */

export const EMOTION_BALLS_PER_PAGE = 9;
export const MIN_BALL_DIAMETER = 44;
export const MOBILE_MAX_BALL_DIAMETER = 48;
export const DESKTOP_MAX_BALL_DIAMETER = 64;

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const MAX_FLOOR_RADIUS = 2.2;
const INNER_HALF_SIZE = 2.7;
const COMFORTABLE_BALL_COUNT = 8;
const MIN_BALL_RADIUS = 0.24;
const MAX_BALL_RADIUS = 0.46;
const MIN_SEPARATION = 0.9;
const RELAXATION_STEPS = 48;
const BACK_BIAS = 0.75;
const PAGE_ROTATION_STEP = 0.73;

export interface EmotionBall {
  readonly id: string;
  readonly title: string;
  readonly weight: number;
  /** 盒底局部坐标；y 由场景层按球半径落到盒底上。 */
  readonly sceneX: number;
  readonly sceneZ: number;
  readonly radius: number;
  readonly mobileSize: number;
  readonly desktopSize: number;
}

type WeightedRow = PortRow & { readonly weight: number };

interface BallDraft {
  id: string;
  title: string;
  weight: number;
  sceneX: number;
  sceneZ: number;
  radius: number;
  mobileSize: number;
  desktopSize: number;
}

/**
 * 黄金角负责“自然散落”，避让只消除几乎完全重合的球，不把球排成网格。
 * 中心距保留 10% 的半径交叠，投影后仍有适度的前后遮挡。
 */
function relaxBallPositions(balls: BallDraft[]): void {
  for (let step = 0; step < RELAXATION_STEPS; step += 1) {
    for (let left = 0; left < balls.length; left += 1) {
      for (let right = left + 1; right < balls.length; right += 1) {
        const first = balls[left]!;
        const second = balls[right]!;
        let dx = second.sceneX - first.sceneX;
        let dz = second.sceneZ - first.sceneZ;
        let distance = Math.hypot(dx, dz);
        const minimum = (first.radius + second.radius) * MIN_SEPARATION;
        if (distance >= minimum) continue;

        if (distance < 1e-6) {
          const fallbackAngle = (left + 1) * (right + 2);
          dx = Math.cos(fallbackAngle);
          dz = Math.sin(fallbackAngle);
          distance = 1;
        }

        const push = (minimum - distance) / 2;
        const nx = dx / distance;
        const nz = dz / distance;
        first.sceneX -= nx * push;
        first.sceneZ -= nz * push;
        second.sceneX += nx * push;
        second.sceneZ += nz * push;
      }
    }

    for (const ball of balls) {
      const limit = INNER_HALF_SIZE - ball.radius - 0.12;
      const distance = Math.hypot(ball.sceneX, ball.sceneZ);
      if (distance <= limit) continue;
      const ratio = limit / distance;
      ball.sceneX *= ratio;
      ball.sceneZ *= ratio;
    }
  }
}

function weightedRows(rows: readonly PortRow[]): readonly WeightedRow[] {
  return rows
    .filter((row): row is WeightedRow => row.weight !== undefined && row.weight > 0)
    .toSorted((a, b) => b.weight - a.weight || a.id.localeCompare(b.id));
}

/** 把出现过的情绪按固定排序切成 9 个一页；未出现或未知频次不进球区。 */
export function emotionBallPages(rows: readonly PortRow[]): readonly (readonly PortRow[])[] {
  const weighted = weightedRows(rows);
  const pages: PortRow[][] = [];
  for (let index = 0; index < weighted.length; index += EMOTION_BALLS_PER_PAGE) {
    pages.push(weighted.slice(index, index + EMOTION_BALLS_PER_PAGE));
  }
  return pages;
}

export function emotionBallLayout(rows: readonly PortRow[], pageVariant: number = 0): readonly EmotionBall[] {
  const weighted = weightedRows(rows);

  if (weighted.length === 0) return [];

  const maxWeight = weighted[0]!.weight;
  const count = weighted.length;
  const densityScale = Math.sqrt(Math.min(1, COMFORTABLE_BALL_COUNT / count));
  const balls = weighted.map((row, index): BallDraft => {
    const weightRatio = Math.sqrt(row.weight / maxWeight);
    const visualRatio = weightRatio * densityScale;
    const radius = MIN_BALL_RADIUS + (MAX_BALL_RADIUS - MIN_BALL_RADIUS) * visualRatio;
    const spread = Math.sqrt((index + 0.45) / count);
    const distance = spread * MAX_FLOOR_RADIUS;
    // 每页换一个确定性的起始角：翻页后仍是自然散落，但不会与上一页完全重合。
    const angle = index * GOLDEN_ANGLE + 0.42 + pageVariant * PAGE_ROTATION_STEP;
    return {
      id: row.id,
      title: row.title,
      weight: row.weight,
      sceneX: Math.cos(angle) * distance,
      sceneZ: Math.sin(angle) * distance,
      radius,
      mobileSize: Math.round(
        MIN_BALL_DIAMETER + (MOBILE_MAX_BALL_DIAMETER - MIN_BALL_DIAMETER) * visualRatio,
      ),
      desktopSize: Math.round(
        MIN_BALL_DIAMETER + (DESKTOP_MAX_BALL_DIAMETER - MIN_BALL_DIAMETER) * visualRatio,
      ),
    };
  });

  relaxBallPositions(balls);
  // 整体略向后落，避免最靠前的球被盒前壁吞掉；分布形状不变。
  for (const ball of balls) {
    const backLimit = -(INNER_HALF_SIZE - ball.radius - 0.12);
    ball.sceneZ = Math.max(backLimit, ball.sceneZ - BACK_BIAS);
  }
  return balls;
}
