import { ChevronDown } from "lucide-react";

import { processingModeChoices } from "../projectionPort.ts";

/** 折叠行与单选行上的短标签：一眼回答「这条会保存吗、会送出去吗」。 */
export const MODE_SHORT_LABEL: Record<string, string> = {
  manual_only: "只保存在本机",
  local_model: "先保存，需要时在本机整理",
  cloud_redacted: "保存后去确认发送",
};

/**
 * 快速记录与睡前收尾共用同一套整理方式选择器。
 * 两页的差别只在保存后的动作，样张与文案不再各自漂移。
 */
export function ProcessingModePicker(props: {
  readonly name: string;
  readonly value: string;
  readonly onChange: (mode: string) => void;
}): React.ReactNode {
  return (
    <details className="quick-mode">
      <summary>
        <span>
          整理方式：<strong>{MODE_SHORT_LABEL[props.value] ?? props.value}</strong>
        </span>
        <ChevronDown className="quick-mode-chevron" aria-hidden="true" size={17} />
      </summary>
      <ul className="quick-mode-list">
        {processingModeChoices().map((choice) => (
          <li key={choice.key}>
            <label className="quick-mode-choice">
              <input
                type="radio"
                name={props.name}
                checked={props.value === choice.key}
                onChange={() => props.onChange(choice.key)}
              />
              <span className="row-title">{choice.label}</span>
              <span className="row-meta">{MODE_SHORT_LABEL[choice.key]}</span>
            </label>
          </li>
        ))}
      </ul>
    </details>
  );
}
