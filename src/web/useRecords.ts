import { useCallback, useEffect, useState } from "react";

import { ApiError, api } from "./apiClient.ts";
import type { RecordRow } from "../shared/dto.ts";

/**
 * 「记录列表 + 每行当前版本的原文」——「今天」「全部记录」「待整理」三页都要这一份，
 * 所以取数只写一次，三页看到的同一条记录才是同一条。
 *
 * 为什么要按 id 再逐个取详情：服务端的 `RecordRow` 只有元数据，**没有摘要字段**，
 * 而一行只显示主键 id 的列表等于没有列表。`PendingRecordDto` 自带截断 `preview`，
 * 所以待整理那一栏的标题不必走这里（那里只用它算「为什么不在这里」）。
 *
 * 单条详情请求失败不拖垮整页：那一行显示「（内容读取失败）」，其余照常列出。
 */
export interface RecordsFeed {
  readonly rows: readonly RecordRow[];
  readonly previews: Readonly<Record<string, string>>;
  readonly total: number;
  readonly loading: boolean;
  readonly error: string | null;
  readonly reload: () => Promise<void>;
}

/** 读取失败的行仍然留在列表里（记录本身是好的，只是这一屏取不到摘要）。 */
const PREVIEW_FAILED = "（内容读取失败）";

export function useRecords(limit: number = 100): RecordsFeed {
  const [rows, setRows] = useState<readonly RecordRow[]>([]);
  const [previews, setPreviews] = useState<Readonly<Record<string, string>>>({});
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const list = await api.listRecords(limit, 0);
      const settled = await Promise.allSettled(list.records.map((row) => api.getRecord(row.id)));
      const next: Record<string, string> = {};
      settled.forEach((outcome, index) => {
        const row = list.records[index];
        if (row === undefined) return;
        next[row.id] = outcome.status === "fulfilled" ? outcome.value.current.raw_text : PREVIEW_FAILED;
      });
      setRows(list.records);
      setPreviews(next);
      setTotal(list.total);
      setLoading(false);
    } catch (cause) {
      setRows([]);
      setPreviews({});
      setTotal(0);
      setLoading(false);
      setError(cause instanceof ApiError ? cause.detail : "记录列表加载失败");
    }
  }, [limit]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { rows, previews, total, loading, error, reload };
}
