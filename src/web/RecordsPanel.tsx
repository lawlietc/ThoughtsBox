import { useCallback, useEffect, useState } from "react";

import { ApiError, api } from "./apiClient.ts";
import { RecordDetail } from "./RecordDetail.tsx";
import { RecordList } from "./RecordList.tsx";
import { dayHeading, deletePhaseMessage, recordListMeta, toRowView } from "./projections.ts";
import { ListDetail } from "./ui/ListDetail.tsx";
import { useIsNarrow } from "./ui/bits.tsx";
import { useRecords } from "./useRecords.ts";
import type { StorageMaintenanceTask } from "../shared/dto.ts";

/**
 * 「全部记录」：以记录为单位，按创建时间倒序，展示处理状态（布局对齐原型的记录页）。
 *
 * 两栏结构交给 `ui/ListDetail.tsx`：宽屏列表与详情同屏，窄屏「列表 → 点进去 → 返回列表」。
 * 选中项由父层持有（`selectedId`），所以从「今天」点一条进来时，选中的就是那一条 ——
 * 各页自己存一份选中，切个 tab 就回到第一条，看起来像界面忘了你刚才点了什么。
 *
 * 页内的「快速记录」卡与「搜索」卡在 UI-4 **收编成独立页面**（`QuickPanel` / `SearchPanel`），
 * 这一页因此只剩「列表 + 详情 + 存储清理横幅」。能力没丢：写走 `POST /api/records`，
 * 查走 `GET /api/search`，只是挪到了「写一条」和「搜索」那两个入口上。
 */

export interface RecordsPanelProps {
  readonly selectedId: string | null;
  /** 窄屏的「返回列表」就是取消选中（传 null）。 */
  readonly onSelect: (id: string | null) => void;
  /** 记录内容或状态变了：父层要重取外壳徽章（待整理计数）。 */
  readonly onBadgesChanged: () => void;
}

export function RecordsPanel(props: RecordsPanelProps): React.ReactNode {
  const narrow = useIsNarrow();
  const feed = useRecords();

  const [flash, setFlash] = useState<string | null>(null);
  const [pendingTasks, setPendingTasks] = useState<StorageMaintenanceTask[]>([]);
  const [retrying, setRetrying] = useState(false);

  const reloadMaintenance = useCallback(async (): Promise<void> => {
    try {
      const m = await api.maintenance();
      setPendingTasks(m.pending);
    } catch {
      /* 维护横幅读取失败不打扰主流程，下一次刷新自然重试 */
    }
  }, []);

  useEffect(() => {
    void reloadMaintenance();
  }, [reloadMaintenance]);

  useEffect(() => {
    if (flash === null) return;
    const timer = setTimeout(() => setFlash(null), 6000);
    return () => clearTimeout(timer);
  }, [flash]);

  // 宽屏两栏同屏，没选中就落到第一条，详情永远有内容；窄屏只有用户点过才算选中。
  const selected = props.selectedId ?? (narrow ? null : (feed.rows[0]?.id ?? null));

  const rows = feed.rows.map((row) => ({
    ...toRowView(row, feed.previews[row.id] ?? "…", recordListMeta(row)),
    group: dayHeading(row.created_local_date),
  }));

  async function retryMaintenance(): Promise<void> {
    if (retrying) return;
    setRetrying(true);
    try {
      const result = await api.retryMaintenance();
      setFlash(
        result.ok
          ? `存储清理重试完成，处理 ${result.resolvedTasks} 项。`
          : `存储清理仍需处理${result.detail ? `（${result.detail}）` : ""}，可稍后再次重试。`,
      );
    } catch (cause) {
      setFlash(cause instanceof ApiError ? `重试失败：${cause.detail}` : "重试失败");
    }
    await reloadMaintenance();
    setRetrying(false);
  }

  return (
    <ListDetail
      hasSelection={selected !== null}
      onBack={() => props.onSelect(null)}
      list={
        <>
          {pendingTasks.length > 0 && (
            <div className="banner pending" role="status">
              <strong>记录已删除，存储清理待完成</strong>
              <span>
                {" "}
                共 {pendingTasks.length} 项待清理（删除本身已提交，不是回滚）。
              </span>
              <button className="btn" onClick={() => void retryMaintenance()} disabled={retrying}>
                {retrying ? "重试中…" : "立即重试清理"}
              </button>
            </div>
          )}
          {flash !== null && <p className="flash">{flash}</p>}

          <section className="card">
            <h2>记录（{feed.total}）</h2>
            {feed.error !== null ? (
              <p className="warn">
                {feed.error}{" "}
                <button className="btn" onClick={() => void feed.reload()}>
                  重试
                </button>
              </p>
            ) : feed.loading ? (
              <p className="hint">加载中…</p>
            ) : (
              <RecordList
                rows={rows}
                selectedId={selected}
                onSelect={props.onSelect}
                emptyText="还没有记录。用下方的「写一条」写下第一条。"
                groupByDate
              />
            )}
          </section>
        </>
      }
      detail={
        selected === null ? (
          <section className="card">
            <h2>原文</h2>
            <p className="hint">未选中记录。</p>
          </section>
        ) : (
          <RecordDetail
            id={selected}
            onChanged={() => {
              void feed.reload();
              props.onBadgesChanged();
            }}
            onDeleted={(result) => {
              props.onSelect(null);
              void feed.reload();
              void reloadMaintenance();
              props.onBadgesChanged();
              setFlash(deletePhaseMessage(result));
            }}
          />
        )
      }
    />
  );
}
