/**
 * 提示的说法与分级（web-redesign 批 2 · 事项 I / J）。
 *
 * 这一份是**纯**的：给定一次操作的回执或一个失败，返回该说什么、该给哪个下一步。
 * 它不碰 DOM、不读状态、不计时 —— 所以「同一句失败在全应用得到同一个下一步」这件事
 * 有唯一一处可改，也能被直接 import 来断言（这正是 `useNotices` 与外壳分开的理由）。
 *
 * 三条分级，口径与 `useNotices` 一致：
 * - 做完一件事的回执 = `ok`，会自己走；
 * - 没做成（含「什么都没动」这种不如预期）= `error`，**不会自己走**，并且带下一步；
 * - 长期状态（后端不可达那一类）= `status`，由触发它的那一侧负责撤。
 *
 * ⚠️ 服务端那句 `detail` 逐字进 `message`，界面不改写、不缩写、不替它猜原因。
 */

import { ApiError } from "./apiClient.ts";
import type { NoticeInput } from "./useNotices.ts";
import type { NoticeAction } from "./ui/types.ts";
import type { IngestRunDto, RecordRow, RevisionRow } from "../shared/dto.ts";

/** 一次操作的回话。`inline` = 说的是当前这个输入框，留在原地显示，不占用全局提示位。 */
export interface ActionOutcome {
  readonly tone: "ok" | "warn";
  readonly text: string;
  readonly inline?: boolean;
  /** 回执也需要下一步时（例如「进「待整理」」）由动作自己带上。 */
  readonly action?: NoticeAction;
}

/** 状态码用于选下一步；取不到状态码就按「连不上」这一档处理（重试才有意义）。 */
export function errorStatusOf(cause: unknown): number {
  return cause instanceof ApiError ? cause.status : 0;
}

export interface ErrorNoticeContext {
  readonly scope?: string;
  /** 重试：只对「连不上」与 5xx 有意义 —— 409 再点一次还是同一个冲突。 */
  readonly retry?: () => void;
  /** 409：这一动作要的前置条件不在本页，去「待整理」那一边做。 */
  readonly goPending?: () => void;
  /** 其余情形没有可自动重试的下一步，能做的就是把排障信息取走。 */
  readonly copy?: () => void;
  readonly rows?: readonly (readonly [string, string])[];
}

/**
 * 失败该说的话 + 该给的下一步。
 *
 * 409 在本服务里对应两件事（缺本次发送授权、这一版有单在途或模式刚变），服务端会点名是哪一种，
 * 界面**不**据状态码二次分类 —— 但两者的下一步都在「待整理」，所以 409 一律给这一个入口。
 */
export function noticeForError(message: string, status: number, ctx: ErrorNoticeContext): NoticeInput {
  let action: NoticeAction | undefined;
  if ((status === 0 || status >= 500) && ctx.retry !== undefined) {
    action = { label: "重试", onClick: ctx.retry };
  } else if (status === 409 && ctx.goPending !== undefined) {
    action = { label: "去待整理", onClick: ctx.goPending };
  } else if (ctx.copy !== undefined) {
    action = { label: "复制技术信息", onClick: ctx.copy };
  }
  return {
    tone: "error",
    message,
    ...(action === undefined ? {} : { action }),
    ...(ctx.rows === undefined || ctx.rows.length === 0 ? {} : { rows: ctx.rows }),
    ...(ctx.scope === undefined ? {} : { scope: ctx.scope }),
  };
}

/** 操作的回执：不如预期的一律不留时间窗，做成了的才自己走。 */
export function noticeForOutcome(outcome: ActionOutcome, scope?: string): NoticeInput {
  return {
    tone: outcome.tone === "ok" ? "ok" : "error",
    message: outcome.text,
    ...(outcome.action === undefined ? {} : { action: outcome.action }),
    ...(scope === undefined ? {} : { scope }),
  };
}

/**
 * 这一条记录的技术值（C1 裁定：不再常驻页脚折叠件，改为随提示按需取回）。
 *
 * 放在这里而不是详情页里：`m5-3` 那条「主界面不得出现 `["结果态"`」的断言读的是
 * `RecordDetail.tsx` 的可见层，值一旦在这里组装、那一侧只剩一个函数调用，口径才是干净的。
 */
export function recordTechnicalRows(
  record: RecordRow,
  current: RevisionRow,
  run?: IngestRunDto | null,
): readonly (readonly [string, string])[] {
  const rows: (readonly [string, string])[] = [
    ["记录编号", record.id],
    ["时区", record.timezone_id],
    ["版本编号", current.id],
    ["内容指纹", `${current.content_sha256.slice(0, 12)}…`],
  ];
  if (run !== undefined && run !== null) {
    rows.push(
      ["结果态", run.resultState],
      ["执行态", run.executionStatus],
      ["错误分类", run.errorKind ?? "无"],
      ["开始时间（UTC）", run.startedAtUtc],
    );
  }
  return rows;
}
