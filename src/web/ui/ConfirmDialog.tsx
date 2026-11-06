/**
 * 「必须处理才能继续」的那一层（〔web-redesign 第二步 · 事项 I〕的第三类）。
 *
 * 为什么单独立一个组件而不是每处各写一份 `<dialog>`：本产品里这类确认已经有四个
 * （保存为新版本 / 丢弃改动 / 删除记录 / 放弃候选），它们回答的是同一件事——
 * 「这一步之后没有回头路，你确定吗」。四份各写一遍，迟早在关闭方式、忙态、危险色上分家。
 *
 * 三条纪律与 `BoxDetailDialog` 一致：遮罩压掉背景、Escape 与点背景都算「不做」、
 * 打开时把焦点交给确认键（原生 `showModal` 自己做）。**是原生 `<dialog>`，不是自绘浮层**：
 * 焦点陷阱、Esc、`::backdrop` 全部由浏览器给，代码里不重造。
 *
 * 纯展示：只吃 props，不取数、不判断语义（`danger` 只是颜色的开关，不是「该不该危险」的判据）。
 */

import { useEffect, useId, useRef } from "react";
import type { ReactNode } from "react";

export interface ConfirmDialogProps {
  readonly title: string;
  /** 正文。不可逆的那几句话写在这里，逐字由调用方负责。 */
  readonly children: ReactNode;
  readonly confirmLabel: string;
  readonly cancelLabel: string;
  /** 请求在途：两颗键都禁用，确认键换成调用方给的进行中文案。 */
  readonly busy?: boolean;
  /** 破坏性动作：确认键用 danger 描边（不是整块红色，理由同 `.detail-more-item`）。 */
  readonly danger?: boolean;
  readonly onConfirm: () => void;
  /** 「不做」的那颗键（正文外的第二个按钮）。 */
  readonly onCancel: () => void;
  /**
   * Escape 与点背景走哪条路。默认等同「不做」；
   * 只有在**第二颗键本身是破坏性动作**时才需要单给（编辑页的「丢弃改动」就是这种：
   * 按 Esc 的人想的是「别走」，不是「把字丢了」）。
   */
  readonly onDismiss?: () => void;
}

export function ConfirmDialog(props: ConfirmDialogProps): React.ReactNode {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const busy = props.busy === true;
  const dismiss = props.onDismiss ?? props.onCancel;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog !== null && !dialog.open) dialog.showModal();
  }, []);

  return (
    <dialog
      className="modal-sheet"
      ref={dialogRef}
      aria-labelledby={titleId}
      onClose={dismiss}
      onClick={(event) => {
        if (event.target === event.currentTarget) dismiss();
      }}
    >
      <div className="modal-sheet-body">
        <h2 id={titleId}>{props.title}</h2>
        {props.children}
        <div className="actions">
          <button
            className={props.danger === true ? "btn danger" : "btn primary"}
            disabled={busy}
            onClick={props.onConfirm}
          >
            {props.confirmLabel}
          </button>
          <button className="btn" disabled={busy} onClick={props.onCancel}>
            {props.cancelLabel}
          </button>
        </div>
      </div>
    </dialog>
  );
}
