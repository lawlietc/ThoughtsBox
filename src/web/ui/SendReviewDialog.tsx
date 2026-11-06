import { useEffect, useId, useRef } from "react";

import { LLM_PREVIEW_RETRY_LABEL, redactionSourceLabel } from "../redactionTier.ts";
import { RAW_TRACK_REVIEW_NOTE } from "../sendTrack.ts";
import type { SendTrack } from "../sendTrack.ts";
import type { SendPreviewDto } from "../../shared/dto.ts";

/**
 * 「这次发送要确认的东西」——〔web-redesign 第三步〕的遮蔽清单弹窗。
 *
 * 2026-11-04 起**只读**：陌生名字候选（姓氏启发式）已删除，这里不再有「勾选/改类型/确认这些词」
 * 那一层。用户要看的是「哪几处被遮、遮成了什么、是谁遮的」；确认发送本身在框外那颗按钮上。
 *
 * 两条纪律沿用原型：
 * 1. 原文 → 占位符的对照必须逐处给出，不能只给 `[person_1_ab12]`；
 * 2. 原文轨什么都不遮，讲「脱敏了哪些名字」就是谎报，所以那条轨只显示一句声明。
 */
export interface SendReviewDialogProps {
  /** 这一版要发出去的预览。重跑脱敏期间可能为 `null`（弹窗不卸载，显示「正在重新检查」）。 */
  readonly preview: SendPreviewDto | null;
  /**
   * 这一版原文（父层取的）。用来把每一处遮蔽还原成「原文 → 占位符」——
   * 只给占位符的话，用户面对 `[person_1_ab12]` 没有任何办法核对遮的是谁。
   * `null` = 没取到或版本对不上：那就只显示占位符，不瞎猜。
   */
  readonly rawText: string | null;
  /** 这一条此刻在哪一轨：原文轨什么都不遮，那条轨上不显示遮蔽承诺。 */
  readonly track: SendTrack;
  readonly busy: boolean;
  /** 正在重新跑脱敏：禁用手脚并显示等待文案（D-5）。 */
  readonly retrying?: boolean;
  /** 重跑失败的主文案（F-4）：把 failure 也带进弹窗，不再只藏在背后的操作框里。 */
  readonly retryError?: string | null;
  /** 「本地模型这次没用上」的说明，带进弹窗（D-7：原本长在操作框/列表行上的悬空引用）。 */
  readonly llmUnusedNotice?: string | null;
  readonly onClose: () => void;
  /** 「重跑脱敏」= 重取预览（`local_llm` 档重征询本地模型）；仅脱敏轨由父层传入。 */
  readonly onRetryRedaction?: (() => void) | undefined;
  /** 「确认整理」= 签授权 + 立即整理；仅脱敏轨由父层传入（D-6）。 */
  readonly onConfirmAndOrganize?: (() => void) | undefined;
  /**
   * Phase D / S10：把这一处词表命中的实体移出遮蔽集合（`mask_enabled=0`），随后父层重取预览。
   * 只能在词表来源（`source === "entity_memory"` 且带 `entityId`）的项上出现。
   */
  readonly onDisableEntity?: (entityId: string) => void;
}

/**
 * 按原文坐标切出被遮的那一段（UTF-16，与 DTO 的 `originalStart/End` 同一口径）。
 *
 * 越界就返回 `null`：版本对不上、或服务端换了坐标口径时，宁可写「原文对不上」，
 * 也不能显示出错位的那几个字 —— 那等于告诉用户「遮的是这个名字」，而它其实不是。
 */
function originalOf(rawText: string | null, start: number, end: number): string | null {
  if (rawText === null) return null;
  if (start < 0 || end <= start || end > rawText.length) return null;
  return rawText.slice(start, end);
}

export function SendReviewDialog(props: SendReviewDialogProps): React.ReactNode {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog !== null && !dialog.open) dialog.showModal();
  }, []);

  return (
    <dialog
      className="modal-sheet send-review"
      ref={dialogRef}
      aria-labelledby={titleId}
      onClose={props.onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) props.onClose();
      }}
    >
      <div className="modal-sheet-body">
        <h2 id={titleId}>这次发送要确认的东西</h2>

        {props.llmUnusedNotice !== undefined && props.llmUnusedNotice !== null && (
          <p className="warn">{props.llmUnusedNotice}</p>
        )}

        {props.retryError !== undefined && props.retryError !== null && props.retrying !== true && (
          <p className="warn">{props.retryError}</p>
        )}

        {props.track === "raw" ? (
          <p className="warn candidate-disclosure">{RAW_TRACK_REVIEW_NOTE}</p>
        ) : props.preview === null ? (
          <p className="hint">本机正在重新检查这段文字…</p>
        ) : (
          <>
            <h3 className="send-review-title">脱敏了 {props.preview.spans.length} 处</h3>
            {props.preview.spans.length === 0 ? (
              <p className="hint">这份记录没有需脱敏的内容</p>
            ) : (
              <ul className="list send-review-spans">
                {props.preview.spans.map((span) => {
                  const original = originalOf(props.rawText, span.originalStart, span.originalEnd);
                  return (
                    <li key={`${span.placeholder}:${span.originalStart}`} className="item send-review-span">
                      {original === null ? (
                        <span className="send-review-original send-review-original-missing">原文对不上</span>
                      ) : (
                        <span className="send-review-original">{original}</span>
                      )}
                      <span aria-hidden="true">→</span>
                      <mark className="candidate-term">{span.placeholder}</mark>
                      <span className="row-meta send-review-source">{redactionSourceLabel(span.source)}</span>
                      {span.source === "entity_memory" && span.entityId !== null && props.onDisableEntity !== undefined && (
                        <button
                          className="btn"
                          type="button"
                          disabled={props.busy}
                          onClick={() => props.onDisableEntity?.(span.entityId!)}
                        >
                          这个词不脱敏
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
            {props.onDisableEntity !== undefined && (
              <p className="hint">
                「这个词不脱敏」会把它移出词表；本机模型每次仍可能重新认出它。
              </p>
            )}
          </>
        )}

        {props.retrying === true && <p className="hint">本机正在重新检查这段文字…</p>}

        <p className="hint">
          {props.track !== "raw" && props.onRetryRedaction !== undefined
            ? `看完没问题就点「确认整理」；不满意可以「${LLM_PREVIEW_RETRY_LABEL}」。`
            : "这里只是让你核对脱敏了哪些地方；确认发送在框外那颗按钮上。"}
        </p>

        <div className="actions">
          {props.track !== "raw" && props.onRetryRedaction !== undefined && (
            <button
              className="btn"
              type="button"
              disabled={props.busy || props.retrying === true}
              onClick={props.onRetryRedaction}
            >
              {LLM_PREVIEW_RETRY_LABEL}
            </button>
          )}
          {props.track !== "raw" && props.onConfirmAndOrganize !== undefined && (
            <button
              className="btn primary"
              type="button"
              disabled={props.busy || props.retrying === true || props.preview === null}
              onClick={props.onConfirmAndOrganize}
            >
              确认整理
            </button>
          )}
          {/* 关闭键永不因 busy 禁用：重跑脱敏/整理都在后台继续，关掉弹窗不取消它们；
              重跑期间只留这颗可点，另两颗（重跑脱敏/确认整理）由上面的 disabled 禁用。 */}
          <button className="btn" onClick={props.onClose}>
            关闭
          </button>
        </div>
      </div>
    </dialog>
  );
}
