import { ChevronDown } from "lucide-react";
import type { ReactNode } from "react";

import { MODE_LABEL } from "./labels.ts";
import { isModeAvailable, modeUnavailableReason } from "../modeDefaults.ts";
import { processingModeChoices } from "../projectionPort.ts";
import type { ProcessingModeAvailabilityDto } from "../../shared/dto.ts";

/**
 * 单选行上的说明：一句话讲清「这一档保存之后会发生什么」。
 *
 * 折叠起来的那一行（`<summary>`）只写**档位名称**（`MODE_LABEL`）——收起时用户问的是
 * 「我现在选的是哪一档」，不是「这一档会怎么样」。把说明塞进这一行，收起后的抬头就变成
 * 一长句解释，「仅保存 / 本地模型 / 云端…」这些名字反而看不见了。
 */
export const MODE_SHORT_LABEL: Record<string, string> = {
  manual_only: "只保存在本地，不发送到模型整理",
  local_model: "先保存，需要时在本机整理",
  cloud_redacted: "本地模型处理脱敏，发送云端模型整理",
  // 第 4 档（草案 §六「前端标签」）：与 cloud_redacted 的区别必须写在说明上——
  // 缺这一个键，选择器会把「原文送出」显示成空文案，用户看不出两档的隐私差别。
  cloud_raw: "不进行脱敏，原文发送云端模型整理",
};

/**
 * 快速记录、睡前收尾与记录详情共用同一套整理方式选择器。
 * 三页的差别只在「选完什么时候生效」：前两页是保存这条新记录时一起生效，
 * 详情页是**选完要按保存**——那两颗键因此由调用方经 `children` 塞进来，
 * 和列表一起展开、一起收起（否则收起状态下页面上会多出一颗没头没尾的按钮）。
 */
export function ProcessingModePicker(props: {
  readonly name: string;
  readonly value: string;
  readonly onChange: (mode: string) => void;
  readonly availability?: ProcessingModeAvailabilityDto | null;
  /** 列表下面那块（保存键、说明）。不传就只有列表，与从前逐字相同。 */
  readonly children?: ReactNode;
}): React.ReactNode {
  return (
    <details className="quick-mode">
      <summary>
        <span>
          整理方式：<strong>{MODE_LABEL[props.value] ?? props.value}</strong>
        </span>
        <ChevronDown className="quick-mode-chevron" aria-hidden="true" size={17} />
      </summary>
      <ul className="quick-mode-list">
        {processingModeChoices().map((choice) => {
          const available = isModeAvailable(choice.key, props.availability ?? null);
          return (
            <li key={choice.key}>
              <label className="quick-mode-choice">
                <input
                  type="radio"
                  name={props.name}
                  checked={props.value === choice.key}
                  disabled={!available}
                  onChange={() => props.onChange(choice.key)}
                />
                <span className="row-title">{choice.label}</span>
                <span className="row-meta">
                  {available ? MODE_SHORT_LABEL[choice.key] : modeUnavailableReason(choice.key)}
                </span>
              </label>
            </li>
          );
        })}
      </ul>
      {props.children}
    </details>
  );
}
