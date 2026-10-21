import { useState } from "react";

import {
  COUNT_PLACEHOLDER,
  NO_SUGGESTION_ROWS,
  SUGGESTION_ALL_KEY,
  SUGGESTIONS_UNREADY,
  suggestionFilters,
  UNREADY_DATA_PORT,
} from "./projectionPort.ts";
import { BoxRowDetail } from "./BoxDetail.tsx";
import { RecordList } from "./RecordList.tsx";
import type { DataPort } from "./projectionPort.ts";

/**
 * 「待确认」—— 模型唯一能被你看见并要求表态的出口。
 *
 * 页面按原型建出来：状态筛选条 + 建议列表。表态动作（采纳 / 忽略 / 撤回）的契约仍在
 * `projectionPort.ts` 里，但**这一页不摆点不动的假按钮**：动作要有服务端事实才上屏。
 *
 * 内容来自数据口（`port.suggestions()`）：计数位 `—`、列表给一句用户语言的空态 ——
 * 取不到内容说「还没准备好」，取到了但一条没有说「还没有待确认的建议」。
 * 布局仍是原型那一侧的单栏堆叠 —— 建议是「一条条表态」的地方，不是两栏回看的地方。
 *
 * 有一条裁定在这里落地：**这一页不显示徽章**。标签栏上的数字要来自真实计数，
 * 而服务端给不出「等你表态」有几条 —— 0 与「不知道」在标签栏上长得一样，那是撒谎。
 */

export interface SuggestionsPanelProps {
  readonly port?: DataPort;
}

export function SuggestionsPanel(props: SuggestionsPanelProps): React.ReactNode {
  const port = props.port ?? UNREADY_DATA_PORT;
  const [filter, setFilter] = useState<string>(suggestionFilters()[0]?.key ?? SUGGESTION_ALL_KEY);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const content = port.suggestions();
  const rows = content?.rows.filter((row) => filter === SUGGESTION_ALL_KEY || row.statusKey === filter) ?? [];
  const selected = rows.find((row) => row.id === selectedId) ?? null;

  return (
    <div className="stack">
      <section className="card">
        <h2>待确认建议</h2>
        {/* 窄屏这一排横着滑而不换行堆三排（`.filterbar` 见 styles.css）。计数位留着、值填占位符。 */}
        <div className="actions filterbar">
          {suggestionFilters().map((entry) => (
            <button
              key={entry.key}
              className={filter === entry.key ? "btn primary" : "btn"}
              onClick={() => setFilter(entry.key)}
            >
              {entry.label}
              {entry.key !== SUGGESTION_ALL_KEY && (
                <span className="tag"> {content?.counts[entry.key] ?? COUNT_PLACEHOLDER}</span>
              )}
            </button>
          ))}
        </div>
        <p className="hint">忽略不会删除；采纳和撤回是终态。</p>
      </section>

      <section className="card">
        <h3>建议（{content?.total ?? COUNT_PLACEHOLDER}）</h3>
        <RecordList
          rows={rows}
          selectedId={selectedId}
          onSelect={setSelectedId}
          emptyText={content === null ? SUGGESTIONS_UNREADY : NO_SUGGESTION_ROWS}
        />
      </section>

      {/* 点一条才出现的那一栏：把「词面 / 依据 / 证据 / 为什么在这」摊开给人看。 */}
      {selected !== null && (
        <section className="card">
          <BoxRowDetail row={selected} heading="建议详情" onCite={() => undefined} />
        </section>
      )}
    </div>
  );
}
