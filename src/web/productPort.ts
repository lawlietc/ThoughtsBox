import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { api } from "./apiClient.ts";
import { productBoxPage, productSuggestions } from "./projections.ts";
import { UNREADY_DATA_PORT } from "./projectionPort.ts";
import type { EffectiveEntry } from "./projections.ts";
import type { BoxPageContent, BoxView, DataPort, RecordSource, SuggestionContent } from "./projectionPort.ts";

/**
 * 数据口的**第一个实现**：真投影那一份 —— 「一份 UI 两个数据源」里产品这一侧的源头。
 *
 * 三条边界：
 *
 * 1. **这一层是唯一的取数处**。`BoxPanel` / `SuggestionsPanel` 只吃 `DataPort`
 *    （`tests/web-ui4-pages.test.ts` 钉死了它们不许出现 `apiClient` 与 `api.`），
 *    所以「盒子页现在能从哪儿取数」这个问题的答案只有这一个文件。
 * 2. **取不到就返回 `null`**，不给空数组。`null` 让面板退回 UI-4 的诚实空态（计数位 `—`、
 *    列表空、缺口点名到字段）；空数组说的是「这一页确实没有东西」——
 *    在后端不可达、还没取完、或者只取到一半的时候，那句话是假的。
 * 3. **它是 `main.tsx` 那条 dev 假数据路的对立面，不是它的替代**。mock 分支逐字不动：
 *    那条路上 `App` 收到了显式注入的 `port`，这一层的取数因此整个不启动（见 `enabled`）。
 *
 * 取法（派发件指定的那一条）：读 `apiClient.ingestEffective` 摊成 `PortRow`。
 * 一次 `listRecords` + 每条待看记录一次 op9，**并发发出去**、单条失败不拖垮整页。
 * 为什么不做成一次请求：§六 的清单是「某条记录的当前结果」，跨记录聚合端点不在清单里，
 * 本轮不发明（多一个端点就多一次泄露面）。代价与口径写进 worklog。
 */

/** 一页取多少条记录。翻页取完，不设上限 —— 盒子页说的是「全部」，取一半数一半就是撒谎。 */
const PAGE_SIZE = 200;

/**
 * 这三个状态从没离开过「解析之前」那一段（`enums.json` 的 processing_status 转换表：
 * `captured` / `awaiting_privacy_review` / `not_processed` 都到不了 `parsed`），
 * 因此不可能有 `result_state='current'` 的 run —— 不必去打 op9。
 *
 * 反过来，`failed` / `needs_reparse` / `processing` 都可能带着**上一次成功整理**的现存结果
 * （失败的新 run 不改写既有 current 视图，§3.7），所以它们一律要问。
 * 这一条是取数优化，不是可见性判断：可见性的唯一口径仍在服务端的 `currentView` 里。
 */
const NEVER_PARSED_STATUSES: readonly string[] = ["captured", "awaiting_privacy_review", "not_processed"];

async function fetchAllRecords(): Promise<readonly EffectiveEntry["record"][]> {
  const records: EffectiveEntry["record"][] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const page = await api.listRecords(PAGE_SIZE, offset);
    records.push(...page.records);
    // 空页 = 到底了（服务端 total 会随删除变化，不能拿它当循环终点）。
    if (page.records.length === 0) return records;
  }
}

async function fetchEntries(): Promise<readonly EffectiveEntry[]> {
  const records = await fetchAllRecords();
  const settled = await Promise.all(
    records
      .filter((record) => !NEVER_PARSED_STATUSES.includes(record.processing_status))
      .map(async (record): Promise<EffectiveEntry | null> => {
        try {
          return { record, effective: await api.ingestEffective(record.current_revision_id) };
        } catch {
          // 单条读不到不影响其它记录：那一格少一行，比整页黑掉诚实。
          return null;
        }
      }),
  );
  return settled.filter((entry): entry is EffectiveEntry => entry !== null);
}

/** `App` 用的那一口子：数据口本体 + 「重取一次」。 */
export interface ProductDataPortHandle {
  readonly port: DataPort;
  /** 记录被改动之后（发起整理、采纳、删除）由徽章那条线带着调一次；进行中的取数不重复发起。 */
  readonly refresh: () => Promise<void>;
}

/**
 * 真数据口。`enabled=false` 时一个请求都不发 —— 那是 dev 假数据那一路（`main.tsx` 注入了
 * `port`），这一层让位。生产接线（`App` 不传 `port`）走的就是这里。
 */
export function useProductDataPort(enabled: boolean = true): ProductDataPortHandle {
  // `null` = 「还不知道」：加载前、加载失败后都是它，面板因此显示 UI-4 那句诚实空态。
  const [entries, setEntries] = useState<readonly EffectiveEntry[] | null>(null);
  const inFlight = useRef<Promise<void> | null>(null);

  const refresh = useCallback((): Promise<void> => {
    if (!enabled) return Promise.resolve();
    const running = inFlight.current;
    if (running !== null) return running;
    const task = fetchEntries().then(
      (list) => {
        inFlight.current = null;
        setEntries(list);
      },
      () => {
        // 后端不可达 / 列表取不到：回到「不知道」，界面显示空态而不是留着上一批过期内容。
        inFlight.current = null;
        setEntries(null);
      },
    );
    inFlight.current = task;
    return task;
  }, [enabled]);

  useEffect(() => {
    if (enabled) void refresh();
  }, [enabled, refresh]);

  const port = useMemo<DataPort>(
    () =>
      enabled
        ? {
            boxPage: (view: BoxView): BoxPageContent | null =>
              entries === null ? null : productBoxPage(entries, view),
            recordSource: async (recordId: string): Promise<RecordSource> => {
              const data = await api.getRecord(recordId);
              return {
                recordId,
                recordDate: data.record.created_local_date,
                rawText: data.current.raw_text,
                revisionLabel: `v${data.current.revision_number}`,
              };
            },
            suggestions: (): SuggestionContent | null => (entries === null ? null : productSuggestions(entries)),
          }
        : UNREADY_DATA_PORT,
    [enabled, entries],
  );

  return { port, refresh };
}
