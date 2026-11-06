import { useEffect, useId, useRef } from "react";

import {
  SCOPE_ONLY_THIS_RECORD,
  SEND_TRACK_LABEL,
  SEND_TRACK_RAW_COPY,
  SEND_TRACK_REDACTED_COPY,
  SEND_TRACKS,
  type SendTrack,
} from "../sendTrack.ts";
import {
  REDACTION_TIERS,
  REDACTION_TIER_LABEL,
  redactionTierEnabled,
  redactionTierOfMode,
  showRedactionTierRow,
  type RedactionTier,
} from "../redactionTier.ts";
import { TechnicalDetails } from "./bits.tsx";
import type { GrantDto, SendPreviewDto } from "../../shared/dto.ts";

/**
 * 「发送方式」——〔web-redesign 第三步〕从内嵌展开改成的第二层弹窗。
 *
 * 为什么不再就地展开：这一框的骨架是「阶段名 → 发什么 → 怎么发 → 动作」四条带，
 * 一展开就在第二和第四条之间插进五六行控件，把「确认这份」推离视线。
 * 弹窗让设置各占一层，框里那一行只报结论。
 *
 * 选择是**即时生效**的（与原来那组 radio 一致）：换轨/换档都会改库里那一列并作废本次授权，
 * 所以这里没有「保存」键，关掉就走。正因为会作废授权，选完这一框会退回「等你确认」。
 */
export interface SendMethodDialogProps {
  /** 预览可能正被换轨/换档作废（那一刻为 null）——技术详情就不画，别显示上一份的指纹。 */
  readonly preview: SendPreviewDto | null;
  readonly grant: GrantDto | null;
  readonly track: SendTrack;
  /** 这一条在册的 `redaction_mode`：档位画的是记录那一列，不是本地状态。 */
  readonly recordRedactionMode: string;
  readonly localLlmUsable: boolean;
  readonly localLlmWhyNot: string;
  readonly busy: boolean;
  readonly onSetTrack: (next: SendTrack) => void;
  readonly onSetRedactionTier: (tier: RedactionTier) => void;
  readonly onClose: () => void;
}

export function SendMethodDialog(props: SendMethodDialogProps): React.ReactNode {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const tier = redactionTierOfMode(props.recordRedactionMode);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog !== null && !dialog.open) dialog.showModal();
  }, []);

  return (
    <dialog
      className="modal-sheet send-method"
      ref={dialogRef}
      aria-labelledby={titleId}
      onClose={props.onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) props.onClose();
      }}
    >
      <div className="modal-sheet-body">
        <h2 id={titleId}>发送方式</h2>

        <div className="actions">
          <span className="row-title">发送方式：</span>
          {SEND_TRACKS.map((option) => (
            <label key={option} className="row-meta">
              <input
                type="radio"
                name="send-track"
                checked={props.track === option}
                disabled={props.busy}
                onChange={() => props.onSetTrack(option)}
              />
              {SEND_TRACK_LABEL[option]}
            </label>
          ))}
        </div>
        <p className="row-meta">{SCOPE_ONLY_THIS_RECORD}</p>
        <p className="warn">{props.track === "raw" ? SEND_TRACK_RAW_COPY : SEND_TRACK_REDACTED_COPY}</p>

        {showRedactionTierRow(props.track) && (
          <>
            <div className="actions">
              <span className="row-title">脱敏方式：</span>
              {REDACTION_TIERS.map((option) => (
                <label key={option} className="row-meta">
                  <input
                    type="radio"
                    name="redaction-tier"
                    checked={tier === option}
                    disabled={props.busy || !redactionTierEnabled(option, props.localLlmUsable)}
                    onChange={() => props.onSetRedactionTier(option)}
                  />
                  {REDACTION_TIER_LABEL[option]}
                </label>
              ))}
            </div>
            {/* 不可用时就地给原因，不把选项藏起来——藏了就没人知道自己少了什么。 */}
            {props.localLlmWhyNot !== "" && <p className="warn">{props.localLlmWhyNot}</p>}
            <p className="hint">
              脱敏<strong>不等于</strong>匿名化：规则猜不中的陌生名字，只有你确认过才会被脱敏。
            </p>
          </>
        )}

        {props.preview !== null && (
          <TechnicalDetails
            rows={[
              ["策略版本", props.preview.policyVersion],
              ["原文版本", `v${props.preview.revisionNumber}`],
              ["原文 revision", props.preview.recordRevisionId],
              ["内容指纹", `${props.preview.payloadSha256.slice(0, 12)}…`],
              ...(props.grant === null
                ? []
                : ([
                    ["授权编号", props.grant.grantId],
                    ["授权策略", props.grant.policyVersion],
                    ["授权确认于", props.grant.confirmedAtUtc],
                  ] as (readonly [string, string])[])),
            ]}
          />
        )}

        <p className="hint">换轨或换档会换掉这次要发的内容，那份确认要重做一遍。</p>

        <div className="actions">
          <button className="btn" onClick={props.onClose}>
            关闭
          </button>
        </div>
      </div>
    </dialog>
  );
}
