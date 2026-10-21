/**
 * 共用展示小组件。
 *
 * 放在一处是为了「同一个概念在界面上永远长得一样」—— 尤其提及的四种状态
 * （原话说出口 / 模型推断 / 已移除 / 已取代）。它们散落在各页各画一套，
 * 是这类界面最容易崩坏的地方。
 *
 * 硬约束：这些组件**只吃 props**。数据从哪来、点证据跳到哪去，都是喂数据那一层的事。
 * `tests/web-ui-shell.test.ts` 里那条纯度断言就是为了让这件事不能靠自觉。
 */

import { useEffect, useState } from "react";

import { BASIS_LABEL } from "./labels.ts";
import type {
  DisclosureNoteProps,
  EvidenceLineProps,
  KeyValueProps,
  MentionChipProps,
  ProseProps,
  StatusLineProps,
  TechnicalDetailsProps,
} from "./types.ts";

/**
 * 「现在这个窗口是不是窄屏」—— 全产品唯一的断点来源。
 *
 * 为什么值得单独抽出来：盒子类页面在宽屏是「左边列表 / 右边详情」，在窄屏是
 * 「列表 → 点进去看详情 → 点返回」。这个判断如果各页各写一套（有的用 `matchMedia`、
 * 有的读 `innerWidth`、有的写死 900），迟早会出现「这一页认为自己是宽屏、
 * 那一页认为自己是窄屏」的错位。
 *
 * 断点与 `src/web/styles.css` 里那条 `@media (max-width: 63.99rem)` 是同一个数 ——
 * 改一处必须改另一处。
 *
 * 它只读视口，不读任何状态，所以留在这里；那个曾经直接读全局状态再 dispatch 的跳转 hook
 * 没有跟着搬过来 —— 界面只声明「点证据要跳转」（`onJump`），跳转怎么做由调用方传进来。
 */
export const NARROW_QUERY = "(max-width: 63.99rem)";

export function useIsNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => window.matchMedia(NARROW_QUERY).matches);
  useEffect(() => {
    const mq = window.matchMedia(NARROW_QUERY);
    const onChange = (): void => setNarrow(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return narrow;
}

/**
 * 提及 chip。`explicit` 实心边（这是事实），`inferred` 虚线加淡色（这是猜测），
 * 非 `active` 划掉但仍可见（移除 ≠ 抹掉，它只是不再是「有效」）。
 */
export function MentionChip(props: MentionChipProps): React.ReactNode {
  const cls = [
    "mention",
    props.basis === "inferred" ? "inferred" : "explicit",
    props.status !== "active" ? "dead" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const statusMark =
    props.status === "rejected" ? "（你已移除）" : props.status === "superseded" ? "（已被取代）" : "";
  return (
    <button
      className={cls}
      title={`${props.title}\n${BASIS_LABEL[props.basis] ?? ""}${statusMark}`}
      onClick={props.onClick}
    >
      <span>{props.label}</span>
      {props.kind !== undefined && <span className="tag">{props.kind}</span>}
      {props.basis === "inferred" && <span className="tag">推断</span>}
    </button>
  );
}

/**
 * 证据行：点一下回原文并高亮。整个产品的信任基础就在这一跳，
 * 任何页面都不该省掉它，也不该把它实现成另一种行为。
 */
export function EvidenceLine(props: EvidenceLineProps): React.ReactNode {
  const { evidence } = props;
  if (evidence === null) {
    return <p className="hint">{props.emptyText ?? "（无证据锚点）"}</p>;
  }
  if (!evidence.anchored) {
    return (
      <p className="warn">
        证据回锚失败：模型给的「{evidence.text}」在原文中找不到 —— 按契约它不得成为有效提及。
      </p>
    );
  }
  return (
    <p className="hint">
      证据：
      <button className="mention" onClick={() => props.onJump(evidence)}>
        「{evidence.text}」
      </button>
    </p>
  );
}

/**
 * 文案里的 `**加粗**` 渲染成真的加粗。
 * 存在的理由很实在：大量文案（建议说明、操作提示）写在 `.ts` 数据文件里，那里写不了 JSX；
 * 不处理的话界面上会直接露出星号 —— 那看起来像 bug，不是强调。
 */
export function Prose(props: ProseProps): React.ReactNode {
  const parts = props.text.split(/\*\*(.+?)\*\*/g);
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? <strong key={i}>{part}</strong> : <span key={i}>{part}</span>,
      )}
    </>
  );
}

/** 一行元信息：`键 值 · 键 值`。 */
export function KeyValue(props: KeyValueProps): React.ReactNode {
  return (
    <p className="row-meta">
      {props.rows.map(([key, value], i) => (
        <span key={key}>
          {i > 0 && " · "}
          {key} {value}
        </span>
      ))}
    </p>
  );
}

/**
 * B 层折叠件（M5-3 信息分层）：值得留、但不需要每次看见的解释。
 * 必须是原生 `details/summary` —— 可聚焦、Enter/Space 开合、触屏可点，
 * 不引入客户端状态，也不做只有鼠标能发现的交互。默认关闭。
 */
export function DisclosureNote(props: DisclosureNoteProps): React.ReactNode {
  return (
    <details className="disclosure">
      <summary>{props.summary}</summary>
      <div className="disclosure-body">{props.children}</div>
    </details>
  );
}

/** 技术详情：排障用的技术值统一收进这一个入口，主界面不直接显示。 */
export function TechnicalDetails(props: TechnicalDetailsProps): React.ReactNode {
  return (
    <DisclosureNote summary="技术详情">
      <KeyValue rows={props.rows} />
    </DisclosureNote>
  );
}

/** 单行状态：当前状态或阻塞原因。长解释是 `DisclosureNote` 的事，失败与风险才用 warn。 */
export function StatusLine(props: StatusLineProps): React.ReactNode {
  return <p className={props.tone === "warn" ? "status-line warn" : "status-line"}>{props.children}</p>;
}
