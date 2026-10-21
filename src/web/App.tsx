import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";

import { api, type Health } from "./apiClient.ts";
import { BoxPanel } from "./BoxPanel.tsx";
import { DataPanel } from "./DataPanel.tsx";
import { IngestPanel } from "./IngestPanel.tsx";
import { boxShapeOf } from "./projectionPort.ts";
import { useProductDataPort } from "./productPort.ts";
import { QuickPanel } from "./QuickPanel.tsx";
import { RecordsPanel } from "./RecordsPanel.tsx";
import { SearchPanel } from "./SearchPanel.tsx";
import { SettingsPanel } from "./SettingsPanel.tsx";
import { SleepPanel } from "./SleepPanel.tsx";
import { SuggestionsPanel } from "./SuggestionsPanel.tsx";
import { TodayPanel } from "./TodayPanel.tsx";
import { Shell } from "./ui/Shell.tsx";
import { useIsNarrow } from "./ui/bits.tsx";
import type { DataPort } from "./projectionPort.ts";
import type { ViewKey } from "./ui/types.ts";

/**
 * 产品外壳与路由：三个主 tab（今天 / 盒子 / 更多）+ 子 tab + 底部动作条。
 * 外壳本身在 `ui/Shell.tsx`，这一层只负责三件事——**决定现在画哪一页**、**取共享数据**、
 * **持有跨页的选中记录**。
 *
 * 三条边界：
 *
 * 1. **页面路由是本地状态，不进 URL。** 产品侧没有「分享某个页面」的需求，
 *    加一层 router 只会让「谁都能直接跳进一个还没就绪的页」变成可能。
 * 2. **每一页都是真页面。** UI-4 之后这张表里没有「占位页」了：盒子五页 / 待确认 / 搜索 /
 *    快速记录 / 睡前收尾 / 设置都按原型布局建成，数据口回「投影还没就绪」时它们显示诚实空态
 *    （措辞与出处都在 `projectionPort.ts`），PROJ-1 落地时只换数据、不换形状 —— 已经换了。
 *    UI-5 加的是**第二个数据源**：`port` 与 `banner` 由入口那一层注入，注入了就用那一份；
 *    生产接线两个都不传，`port` 因此落到真投影那一份（`productPort.ts`，读 op9 摊成 `PortRow`）。
 *    两个源喂的是同一个口子、同一套形状，所以这一层的 JSX 里没有「这是假数据」的分支。
 * 3. **取数分工**：今天 / 全部记录 / 待整理 / 详情 / 数据管理 自己取真数据；
 *    这一层取跨页共享的三件（health、待整理计数、盒子那批有效结果）。
 *
 * 「选中哪条记录」放在这一层而不是各面板里：从「今天」点一条进「全部记录」要看的正是那一条，
 * 待整理里选中的那条也该和记录页保持一致。各页存一份就会漂移 —— 切个 tab 回到第一条，
 * 看起来像界面忘了你刚才点了什么。
 */

/**
 * 还没有实现的页：只剩图谱（〔用户裁定〕整个功能按推迟处理，`ViewKey` 里挂着但不给入口）。
 * 这一张表存在的意义就是把「为什么这页只有一句话」写在明处。
 */
const DEFERRED_VIEWS: readonly ViewKey[] = ["graph"];

/** 窄屏标题栏只回答「现在在哪」，不再重复产品名和品牌副标题。 */
function pageTitle(view: ViewKey, detailOpen: boolean): string {
  if (view === "records" && detailOpen) return "记录详情";
  const boxTitle = boxShapeOf(view)?.title;
  if (boxTitle !== undefined) return boxTitle;
  switch (view) {
    case "today":
      return "今天";
    case "quick":
      return "快速记录";
    case "records":
      return "全部记录";
    case "ingest":
      return "待整理";
    case "suggestions":
      return "待确认";
    case "sleep":
      return "睡前收尾";
    case "search":
      return "搜索";
    case "more":
      return "更多";
    case "data":
      return "设置与数据";
    default:
      return "思绪盒子";
  }
}

/**
 * 「更多」是数据管理的家〔用户裁定 2026-10-15〕：顶层 tab 没了，入口在这页里。
 * 页面本身只留入口与一句产品承诺；技术信息统一放在设置与数据页底部。
 */
function MorePage(props: {
  readonly onOpenData: () => void;
}): React.ReactNode {
  return (
    <div className="stack">
      <section className="card">
        <h2>更多</h2>
        <ul className="list">
          <li>
            <button className="btn wide" onClick={props.onOpenData}>
              <span>设置与数据管理</span>
              <span className="tag">解析与隐私 · 备份 · 导出 · 导入 · 恢复</span>
            </button>
          </li>
        </ul>
      </section>

      <section className="card">
        <h3>关于</h3>
        <p className="hint">
          思绪盒子 · 先把自己写下来，再慢慢看清。记录不会离开这台电脑，除非你在某一条上明确同意发送。
        </p>
      </section>
    </div>
  );
}

export interface AppProps {
  /**
   * 盒子五页与待确认页的数据口。
   * 不传 = 用真投影那一份（`productPort.ts` 取服务端的有效结果）；传了就用传的那一份，
   * 真数据口同时**不再发任何请求** —— dev 假数据那一路不该有后端。
   */
  readonly port?: DataPort;
  /** 整屏顶部横幅。生产接线不传 —— dev 模式的假数据入口传「这一屏是假数据」那一条。 */
  readonly banner?: ReactNode;
}

export function App(props: AppProps): React.ReactNode {
  // 两个数据源的交接点就在这一行。
  // · 显式注入（dev 假数据那一路，见 `main.tsx` 那个双条件动态 import）→ 用注入的那份，
  //   并且 `enabled=false` 让真数据口**一个请求都不发** —— 假数据那一路本来就不该有后端。
  // · 生产接线（不传 `port`）→ 用真投影那份：读 `apiClient.ingestEffective` 摊成 `PortRow`，
  //   取不到（后端不可达、还没取完）就是 `UNREADY_DATA_PORT` 的诚实空态。
  const product = useProductDataPort(props.port === undefined);
  const port = props.port ?? product.port;
  const narrow = useIsNarrow();
  // 裁定的开机第一屏就是「今天」（UI-3 已把这一页接上真实 RecordRow 列表）。
  const [view, setView] = useState<ViewKey>("today");
  const [health, setHealth] = useState<Health | null>(null);
  const [backendDown, setBackendDown] = useState(false);
  const [pendingCount, setPendingCount] = useState<number | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const detailOpen = narrow && view === "records" && selectedId !== null;

  const reload = useCallback(async () => {
    let online = false;
    try {
      setHealth(await api.health());
      online = true;
    } catch {
      setHealth(null);
    }
    setBackendDown(!online);
    // 待整理计数拿不到就不显示徽章：0 与「不知道」在标签栏上长得一样，那是撒谎。
    try {
      setPendingCount((await api.ingestPending()).records.length);
    } catch {
      setPendingCount(null);
    }
    // 盒子五页与待确认页跟着同一批真实状态走：面板改完一条记录（发起整理 / 采纳 / 删除）
    // 都会经 `refreshBadges` 走到这里，派生内容因此不会停在「上次打开盒子时」那一版。
    await product.refresh();
  }, [product.refresh]);

  /**
   * 只在启动时取一次共享数据。
   *
   * 页面级的数据由各面板自己取（切页即重挂载，见下面），这里再挂一个 `view` 依赖
   * 等于每切一页都白跑一趟后端。面板改动了记录状态之后调 `refreshBadges`，
   * 徽章跟着真实状态走。
   */
  useEffect(() => {
    let active = true;
    void reload().catch(() => {
      if (active) setBackendDown(true);
    });
    return () => {
      active = false;
    };
  }, [reload]);

  const refreshBadges = useCallback(() => {
    void reload();
  }, [reload]);

  const backendDownNotice = backendDown
    ? "本地后端不可达。请先启动 npm run start:server（仅监听 127.0.0.1）。"
    : null;

  return (
    <Shell
      view={view}
      detailOpen={detailOpen}
      onNavigate={setView}
      badges={pendingCount === null ? {} : { ingest: pendingCount }}
      notice={backendDownNotice}
      banner={props.banner}
      title={pageTitle(view, detailOpen)}
    >
      {/* 面板按 view 条件渲染 = 切页即重挂载，列表与详情永远反映服务端当前状态。 */}
      {view === "today" && (
        <TodayPanel
          onNavigate={setView}
          onSelectRecord={(id) => {
            setSelectedId(id);
            setView("records");
          }}
          pendingCount={pendingCount}
        />
      )}
      {view === "records" && (
        <RecordsPanel
          selectedId={selectedId}
          onSelect={setSelectedId}
          onBadgesChanged={refreshBadges}
        />
      )}
      {view === "ingest" && (
        <IngestPanel selectedId={selectedId} onSelect={setSelectedId} onBadgesChanged={refreshBadges} />
      )}
      {view === "suggestions" && <SuggestionsPanel port={port} />}
      {/* 盒子五页共用一份实现，页与页的差别全在 `projectionPort.ts` 的形状表里。 */}
      {boxShapeOf(view) !== null && <BoxPanel key={view} view={view} port={port} />}
      {view === "search" && (
        <SearchPanel
          onSelectRecord={(id) => {
            setSelectedId(id);
            setView("records");
          }}
        />
      )}
      {view === "more" && <MorePage onOpenData={() => setView("data")} />}
      {view === "data" && (
        <div className="stack">
          {/* `data` 不在 STANDALONE 里，外壳不会给它返回按钮；入口在「更多」之下，返回得自己给。 */}
          <button className="btn" onClick={() => setView("more")}>
            ← 返回更多
          </button>
          <SettingsPanel health={health}>
            <DataPanel />
          </SettingsPanel>
        </div>
      )}
      {view === "quick" && (
        <QuickPanel
          onSaved={refreshBadges}
          onOpenPending={(recordId) => {
            setSelectedId(recordId);
            setView("ingest");
          }}
        />
      )}
      {view === "sleep" && (
        <SleepPanel
          onSelectRecord={(id) => {
            setSelectedId(id);
            setView("records");
          }}
          onFinished={() => setView("today")}
        />
      )}
      {DEFERRED_VIEWS.includes(view) && (
        <section className="card">
          <h2>图谱</h2>
          <p className="hint">图谱整体按裁定推迟，产品里没有这一页的入口。</p>
          <p className="row-meta">
            现在能回看的是盒子那五页：情绪 / 经历 / 念头 / 人物与事物 / 主题。
          </p>
        </section>
      )}
    </Shell>
  );
}
