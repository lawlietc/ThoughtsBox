import { useState } from "react";

import { ApiError, api, type SearchHit } from "./apiClient.ts";
import { firstLine } from "./projections.ts";
import { cleanSearchTerm, SEARCH_LAYERS } from "./projectionPort.ts";
import { RecordList } from "./RecordList.tsx";
import type { RecordRowView } from "./projections.ts";

/**
 * 「搜索」—— 独立主 tab。想不起来放哪了就走这里，所以它不藏在某个页面的角里。
 *
 * 搜索面按原型是四层（原文 / 经历与念头 / 情绪与主题 / 人与事物），形状数据仍在
 * `projectionPort.ts` 的 `SEARCH_LAYERS` 里。**主界面只展示现在真正可用的原文层**：
 * 未就绪的层不画（M5-3B：「还没接上」不是用户要做决定的事），接上之后从那里放回来。
 *
 * 命中一律回原文：标签离开上下文就没意义了。
 */

export interface SearchPanelProps {
  /** 点一条命中 = 选中那条记录并去「全部记录」看原文（与「今天」页的动作一致）。 */
  readonly onSelectRecord: (id: string) => void;
}

export function SearchPanel(props: SearchPanelProps): React.ReactNode {
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<string>("all");
  const [searching, setSearching] = useState(false);
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const term = cleanSearchTerm(query);
  const active = term !== "";

  async function submit(): Promise<void> {
    if (searching) return;
    if (term === "") {
      setHits(null);
      setError(null);
      return;
    }
    setSearching(true);
    setError(null);
    try {
      setHits((await api.search(term)).hits);
    } catch (cause) {
      setHits(null);
      setError(cause instanceof ApiError ? cause.detail : "搜索失败");
    } finally {
      setSearching(false);
    }
  }

  const show = (key: string): boolean => scope === "all" || scope === key;
  const rows: readonly RecordRowView[] = (hits ?? []).map((hit: SearchHit) => ({
    id: hit.record_id,
    title: firstLine(hit.raw_text, 48),
    meta: `${hit.record_created_local_date} · 版本 ${hit.revision_number}`,
  }));

  return (
    <div className="stack">
      <section className="card">
        <h2>搜索</h2>
        <input
          className="input"
          placeholder="找什么？人、事、感觉、还是当时写下的那句话"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void submit();
          }}
        />
        <div className="actions">
          <button className="btn primary" onClick={() => void submit()} disabled={searching || !active}>
            {searching ? "搜索中…" : "搜索"}
          </button>
          {hits !== null && (
            <button
              className="btn"
              onClick={() => {
                setHits(null);
                setQuery("");
              }}
            >
              清除
            </button>
          )}
        </div>
        {!active && <p className="hint">输入一个词，搜索你写过的内容。</p>}
        {/* 筛选条只列现在可用的层；未就绪的层不画 —— 界面不为做不到的事摆位置。 */}
        <div className="actions filterbar">
          {SEARCH_LAYERS.filter((layer) => layer.ready).map((layer) => (
            <button
              key={layer.key}
              className={scope === layer.key ? "btn primary" : "btn"}
              onClick={() => setScope(layer.key)}
            >
              {layer.label}
            </button>
          ))}
        </div>
        {error !== null && <p className="warn">{error}</p>}
        {hits !== null && <p className="row-meta">找到 {rows.length} 处</p>}
      </section>

      {active && hits !== null && hits.length === 0 && (
        <section className="card">
          <h3>原文里出现（0）</h3>
          <p className="hint">没有找到「{term}」，换个说法试试。</p>
        </section>
      )}

      {active && show("records") && rows.length > 0 && (
        <section className="card">
          <h3>原文里出现（{rows.length}）</h3>
          <RecordList rows={rows} selectedId={null} onSelect={props.onSelectRecord} emptyText="没有匹配的记录。" />
        </section>
      )}
    </div>
  );
}
