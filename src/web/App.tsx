import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import { api, type Health } from "./apiClient.ts";
import { BoxPanel } from "./BoxPanel.tsx";
import { DataPanel } from "./DataPanel.tsx";
import { IngestPanel } from "./IngestPanel.tsx";
import { boxShapeOf } from "./projectionPort.ts";
import { useProductDataPort } from "./productPort.ts";
import { QuickPanel } from "./QuickPanel.tsx";
import { RecordEditPanel } from "./RecordEditPanel.tsx";
import { RecordsPanel } from "./RecordsPanel.tsx";
import { SearchPanel } from "./SearchPanel.tsx";
import { SettingsPanel } from "./SettingsPanel.tsx";
import { SleepPanel } from "./SleepPanel.tsx";
import { SuggestionsPanel } from "./SuggestionsPanel.tsx";
import { TodayPanel } from "./TodayPanel.tsx";
import { Shell } from "./ui/Shell.tsx";
import { useNotices } from "./useNotices.ts";
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

/** 「后端不可达」这条长期状态的 key/scope：同一个数既用于去重，也用于恢复时撤掉。 */
const BACKEND_DOWN_SCOPE = "backend-down";

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
    case "edit":
      return "编辑原文";
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
        <p className="hint">记录不会离开这台电脑，除非你在某一条上明确同意发送。</p>
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
  const { notices, push, dismiss, clearScope } = useNotices();
  // 裁定的开机第一屏就是「今天」（UI-3 已把这一页接上真实 RecordRow 列表）。
  const [view, setView] = useState<ViewKey>("today");
  const [health, setHealth] = useState<Health | null>(null);
  const [backendDown, setBackendDown] = useState(false);
  const [pendingCount, setPendingCount] = useState<number | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const detailOpen = narrow && view === "records" && selectedId !== null;

  /**
   * 离开一页之前的守卫（〔web-redesign 批 4 · C〕）。
   *
   * 编辑页有未保存的草稿时，**返回与三个 tab 都得先问它** —— 这两样都是外壳画的，
   * 页面自己拦不到。所以守卫住在这里：页面挂一个「去下一页走不走得掉」的判据，
   * 外壳的每一次跳转都过它。返回 `false` 时页面把自己的「留下改动 / 丢弃」二选摆出来，跳转不发生。
   *
   * 判据收下**目的地**：用户点的是「盒子」tab，那么选「丢弃」之后要去的也是盒子，
   * 不是固定回到进来时那一页 —— 拦下来的目的只是问一句，不是替他改主意。
   */
  const leaveGuard = useRef<((next: ViewKey) => boolean) | null>(null);
  const registerLeaveGuard = useCallback((guard: ((next: ViewKey) => boolean) | null) => {
    leaveGuard.current = guard;
  }, []);
  const navigate = useCallback((next: ViewKey) => {
    const guard = leaveGuard.current;
    if (guard !== null && !guard(next)) return;
    setView(next);
  }, []);
  /** 用户已经明确表态（保存成功 / 丢弃改动）之后的跳转：不再问守卫，问就是自己跟自己打架。 */
  const leaveWithoutGuard = useCallback((next: ViewKey) => {
    leaveGuard.current = null;
    setView(next);
  }, []);

  /**
   * 编辑页从哪儿来。返回时回到**原来那一页**，不是固定回「全部记录」：
   * 从「待整理」进编辑的人，回来该看见自己那一条的发送闸门，而不是被丢到另一页。
   */
  const [editFrom, setEditFrom] = useState<ViewKey>("records");
  const openEdit = useCallback(() => {
    setEditFrom(view);
    navigate("edit");
  }, [view, navigate]);

  /**
   * 「上一个不是写记录的页面」（整理方式改动 S-5）。
   *
   * 「保存并整理」成功后要回到来路那一页：写记录是今天的一个入口，也可能是从别处点进来的，
   * 固定回「今天」会把从搜索进来的人丢在错误的页面上。入口分散在各页（没有统一的
   * `openQuick`），所以来路不靠调用方报备，就在每次切页时把**上一个非 quick 的 view** 记下来——
   * 与 `editFrom` 同一个意思，只是那边有唯一入口、这边没有。
   */
  const [quickReturn, setQuickReturn] = useState<ViewKey>("today");
  useEffect(() => {
    if (view !== "quick") setQuickReturn(view);
  }, [view]);
  /** 排进队列后离开写记录页：走 `leaveWithoutGuard`——这一页没有需要守卫的草稿，草稿守卫属于编辑页。 */
  const returnFromQuick = useCallback(() => {
    leaveWithoutGuard(quickReturn);
  }, [leaveWithoutGuard, quickReturn]);

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

  /**
   * 「后端不可达」是一条**长期状态**，不是一次动作的回话（〔web-redesign 批 2 · 事项 I〕）：
   * 进顶部提示位、不自动消失、按 key 去重（每轮重取都不叠成好几条），
   * 恢复可达时随 scope 撤掉 —— 由不得页面自己「闪一下就过去」。
   */
  useEffect(() => {
    if (!backendDown) {
      clearScope(BACKEND_DOWN_SCOPE);
      return;
    }
    push({
      tone: "status",
      key: BACKEND_DOWN_SCOPE,
      scope: BACKEND_DOWN_SCOPE,
      message: "本地后端不可达。请先启动 npm run start:server（仅监听 127.0.0.1）。",
      action: { label: "重试连接", onClick: () => void reload() },
    });
  }, [backendDown, clearScope, push, reload]);

  return (
    <Shell
      view={view}
      detailOpen={detailOpen}
      onNavigate={navigate}
      badges={pendingCount === null ? {} : { ingest: pendingCount }}
      notices={notices}
      onDismissNotice={dismiss}
      banner={props.banner}
      title={pageTitle(view, detailOpen)}
      backTo={view === "edit" ? editFrom : "today"}
      backLabel={view === "edit" ? "← 返回这条记录" : "← 返回今天"}
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
          notify={push}
          clearScope={clearScope}
          onGoPending={() => navigate("ingest")}
          onEdit={openEdit}
        />
      )}
      {view === "ingest" && (
        <IngestPanel
          selectedId={selectedId}
          onSelect={setSelectedId}
          onBadgesChanged={refreshBadges}
          notify={push}
          clearScope={clearScope}
          onEdit={openEdit}
          onOpenSettings={() => navigate("data")}
        />
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
          notify={push}
          onReturnToPrevious={returnFromQuick}
          onOpenPending={(recordId) => {
            setSelectedId(recordId);
            setView("ingest");
          }}
          onOpenRecord={(recordId) => {
            setSelectedId(recordId);
            setView("records");
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
      {/* 编辑原文：写是独占动作，自成一面（〔web-redesign 批 4 · C〕）。 */}
      {view === "edit" && selectedId !== null && (
        <RecordEditPanel
          recordId={selectedId}
          onSaved={refreshBadges}
          /* 目的地由守卫那一侧带回来：用户点的是盒子 tab，丢弃后就该去盒子。 */
          onLeave={(next) => leaveWithoutGuard(next ?? editFrom)}
          notify={push}
          onGuard={registerLeaveGuard}
        />
      )}
      {DEFERRED_VIEWS.includes(view) && (
        <section className="card">
          <h2>图谱</h2>
          <p className="hint">图谱按裁定推迟，暂无入口。</p>
        </section>
      )}
    </Shell>
  );
}
