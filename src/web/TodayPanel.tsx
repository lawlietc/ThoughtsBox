import { useMemo } from "react";
import { MoonStar, PenLine } from "lucide-react";

import { clockOf, filterByLocalDay, firstLine, localDay, needsAttention } from "./projections.ts";
import { STATUS_LABEL } from "./ui/labels.ts";
import { useRecords } from "./useRecords.ts";
import type { ViewKey } from "./ui/types.ts";

/**
 * 「今天」—— 开机第一屏，也是这一轮视觉试改（M5-4P）唯一改到的页面。
 *
 * 这一页只承担两件事，都不复杂：
 * 1. **随时能写**：写一条 / 睡前收尾就在手边，不用先进哪个页面。
 * 2. **睡前看得见今天**：今天写下的片段摊在这里，点一条就进详情。
 *
 * 〔M5-5AB〕继续减量：一句问候 + 一个主行动 + 一条时间线。
 * 首页不再常驻子 tab、产品说明或重复入口；待整理只在真有内容时出现一次。
 * **取数路径一处没动**：还是 `useRecords()` → `apiClient` → 本地后端，
 * 这一页没有第二份来源，也没有任何假的情绪字段。
 *
 * 「今天」按自然日算（〔用户裁定 2026-10-14〕），口径是服务端的 `created_local_date`
 * ——本机时区的日历日，不是 UTC 日。判断逻辑在 `projections.ts`，能逐条断言。
 */

export interface TodayPanelProps {
  readonly onNavigate: (view: ViewKey) => void;
  /** 点今天的一条 = 选中它并去「全部记录」看详情（与原型的动作一致）。 */
  readonly onSelectRecord: (id: string) => void;
  /** 待整理徽章；拿不到就显示不带数字的按钮 —— 0 与「不知道」不能长得一样。 */
  readonly pendingCount: number | null;
}

const WEEKDAYS: readonly string[] = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

/** 「10 月 19 日 · 周日」：日期是给这一页定调的，不是给记录排序的。 */
function dateGreeting(date: Date): string {
  return `${String(date.getMonth() + 1)} 月 ${String(date.getDate())} 日 · ${WEEKDAYS[date.getDay()] ?? ""}`;
}

export function TodayPanel(props: TodayPanelProps): React.ReactNode {
  const feed = useRecords();
  const now = new Date();
  const today = localDay(now);
  const todays = useMemo(() => filterByLocalDay(feed.rows, today), [feed.rows, today]);

  return (
    <div className="stack today-page">
      <section className="today-open">
        <p className="today-date">{dateGreeting(now)}</p>
        <h2 className="today-greeting">今天，想留下什么？</h2>
        <div className="today-actions">
          <button className="btn primary" onClick={() => props.onNavigate("quick")}>
            <PenLine aria-hidden="true" size={18} strokeWidth={1.8} />
            写一条
          </button>
          <button className="today-secondary" onClick={() => props.onNavigate("sleep")}>
            <MoonStar aria-hidden="true" size={17} strokeWidth={1.7} />
            睡前收尾
          </button>
        </div>
      </section>

      <section className="today-feed">
        <div className="today-feed-head">
          <h3 className="today-feed-title">
            今天的片段
            {todays.length > 0 && <span className="tag"> {todays.length}</span>}
          </h3>
          <button className="link-btn" onClick={() => props.onNavigate("records")}>
            全部片段
          </button>
        </div>

        {feed.error !== null && (
          <p className="warn">
            {feed.error}{" "}
            <button className="btn" onClick={() => void feed.reload()}>
              重试
            </button>
          </p>
        )}
        {feed.error === null && feed.loading && <p className="hint">读取中…</p>}
        {feed.error === null && !feed.loading && todays.length === 0 && (
          <p className="hint">今天还没有留下片段。</p>
        )}
        {feed.error === null && !feed.loading && todays.length > 0 && (
          <ul className="timeline">
            {todays.map((row) => {
              const state = STATUS_LABEL[row.processing_status] ?? row.processing_status;
              const attention = needsAttention(row.processing_status);
              return (
                <li key={row.id}>
                  <button className="timeline-item" onClick={() => props.onSelectRecord(row.id)}>
                    <span className="timeline-time">{clockOf(row.created_at_local)}</span>
                    <span className="timeline-text">{firstLine(feed.previews[row.id] ?? "…", 60)}</span>
                    {attention && <span className="timeline-state">{state}</span>}
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        {props.pendingCount !== null && props.pendingCount > 0 && (
          <button className="today-pending" onClick={() => props.onNavigate("ingest")}>
            有 {props.pendingCount} 条待整理 · 去看看
          </button>
        )}
      </section>
    </div>
  );
}
