/**
 * 统一反馈面（web-redesign 批 2 · 事项 I）。
 *
 * 为什么要有这一层：提示散落在各页各栏里 —— 有的在滚动区里（滚上去就看不见）、
 * 有的 6 秒自己消失（错误也消失，用户找不到第二次机会）、有的只是文字没有下一步
 * （失败了，然后呢）。这一个组件把这些口径统一掉：**位置只有一个**（外壳里、滚动区之外），
 * **消失规则按类别**（做完一件事的回执会走，错误不会自己走），**错误必须带下一步**。
 *
 * 硬约束同 `bits.tsx`：只吃 props。谁 push、什么时候撤，是 `useNotices` 与调用方的事。
 */

import { X } from "lucide-react";

import { Prose, TechnicalDetails } from "./bits.tsx";
import type { NoticeBarProps, NoticeItem } from "./types.ts";

function NoticeRow(props: {
  readonly notice: NoticeItem;
  readonly onDismiss: (id: string) => void;
}): React.ReactNode {
  const { notice } = props;
  // 错误要抢读（打断），回执与长期状态让屏幕阅读器排队念，不打断正在读的内容。
  const assertive = notice.tone === "error";
  return (
    <div
      className={`notice ${notice.tone}`}
      role={assertive ? "alert" : "status"}
      aria-live={assertive ? "assertive" : "polite"}
    >
      <p className="notice-text">
        <Prose text={notice.message} />
      </p>
      {notice.action !== undefined && (
        <button className="notice-action" onClick={notice.action.onClick}>
          {notice.action.label}
        </button>
      )}
      {/* 关闭键排在折叠件之前：`.disclosure` 占满一整行（`flex:1 0 100%`），
          排在它后面就会被挤到第二行左下角，看着像另一个不相干的控件。 */}
      <button className="notice-close" aria-label="关闭提示" onClick={() => props.onDismiss(notice.id)}>
        <X size={16} aria-hidden="true" />
      </button>
      {notice.rows !== undefined && notice.rows.length > 0 && <TechnicalDetails rows={notice.rows} />}
    </div>
  );
}

export function NoticeBar(props: NoticeBarProps): React.ReactNode {
  if (props.notices.length === 0) return null;
  return (
    <div className="notice-bar">
      {props.notices.map((notice) => (
        <NoticeRow key={notice.id} notice={notice} onDismiss={props.onDismiss} />
      ))}
    </div>
  );
}
