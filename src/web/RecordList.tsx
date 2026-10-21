import type { RecordRowView } from "./projections.ts";

/**
 * 记录行的列表 —— 「今天」与「全部记录」共用同一份。
 *
 * 分成两层是有理由的：取数是面板的事，这一层**只吃 view model**（`RecordRowView`），
 * 于是同一条记录在两页里不可能长得不一样。原型那一侧将来 import 的也是这一份。
 */

/** 选中行的底色，与原型同一表达式（不是新发明的视觉语言）。 */
const SELECTED_BACKGROUND = "color-mix(in srgb, canvastext 8%, transparent)";

export interface RecordListProps {
  readonly rows: readonly RecordRowView[];
  /** 当前选中的记录 id；没有选中就传 null，列表不画高亮。 */
  readonly selectedId: string | null;
  readonly onSelect: (id: string) => void;
  /** 空列表的那句话由调用方给：「今天还没有记录。」与「还没有记录。」是两回事。 */
  readonly emptyText: string;
  /** 全部记录页按行上的 `group` 分日显示；盒子 / 搜索等列表保持原样。 */
  readonly groupByDate?: boolean;
}

export function RecordList(props: RecordListProps): React.ReactNode {
  if (props.rows.length === 0) {
    return <p className="hint">{props.emptyText}</p>;
  }

  const rowButton = (row: RecordRowView): React.ReactNode => (
    <li key={row.id}>
      <button
        className="row-btn"
        onClick={() => props.onSelect(row.id)}
        style={row.id === props.selectedId ? { background: SELECTED_BACKGROUND } : undefined}
      >
        <span className="row-title">{row.title}</span>
        <span className="row-meta">{row.meta}</span>
      </button>
    </li>
  );

  if (props.groupByDate !== true) {
    return <ul className="list">{props.rows.map(rowButton)}</ul>;
  }

  const grouped = new Map<string, RecordRowView[]>();
  for (const row of props.rows) {
    const heading = row.group ?? "";
    const rows = grouped.get(heading);
    if (rows === undefined) grouped.set(heading, [row]);
    else rows.push(row);
  }
  const groups = [...grouped.entries()].map(([heading, rows]) => ({ heading, rows }));

  return (
    <div className="record-groups">
      {groups.map((group) => (
        <section className="record-group" key={group.heading}>
          {group.heading !== "" && <h3 className="record-day">{group.heading}</h3>}
          <ul className="list">{group.rows.map(rowButton)}</ul>
        </section>
      ))}
    </div>
  );
}
