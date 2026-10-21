/**
 * 应用外壳：三个主 tab + 各 tab 的子 tab + 底部动作条 + 主题开关。
 *
 * 四个设计决定，都是被实测逼出来的，改动前先读懂再动：
 *
 * 1. **tab 的位置跟着屏幕走，靠 CSS 摆，不用 JS 判断。**
 *    窄屏 → 底部一条，像 App 的底部导航栏；宽屏 → 左侧一列通高，正文在右边。
 *    同一份 DOM，两条媒体查询（见 `src/web/styles.css`）。用 JS 判断会在首帧闪一下，
 *    而「导航栏刚才还在上面」是最难看的。
 *
 * 2. **宽屏时只有正文那一栏滚**，标题与侧栏钉在一屏高里。
 *    整页一起滚的话，切页面时正文长度一变、滚动位置跟着变，左侧导航会上下跳一下 ——
 *    用起来像「点了之后界面动了」。
 *
 * 3. **外壳不知道有哪些页面**：它只按 `view` 决定高亮与子 tab，页面主体由调用方传进来（`children`）。
 *    所以这一层没有任何取数与状态：跳转、计数、提示文案一律经 props。
 *
 * 4. **主题归外壳，不归任何一页。** 深浅两套光线是全局的事，挂在 `<html data-theme>` 上；
 *    开关放在标题栏右侧，与沟通件自己的入口（`headerAside`）同一位。
 */

import { useEffect, useRef } from "react";
import { Box as BoxIcon, Ellipsis, SunMedium } from "lucide-react";

import { Prose } from "./bits.tsx";
import { BOX_SUB_TABS, STANDALONE, TABS, TODAY_TABS, tabOf } from "./nav.ts";
import { ThemeToggle } from "./ThemeToggle.tsx";
import type { ShellProps, TabKey, ViewKey } from "./types.ts";

/**
 * 「随时能写」不藏在任何页面里：在「今天」tab 下常驻底部，
 * 窄屏时正好落在底部导航栏的上面。盒子里翻旧账时不打扰，所以只在今天 tab 出现。
 */
const RECORD_ACTIONS: readonly { readonly view: ViewKey; readonly label: string; readonly primary: boolean }[] = [
  { view: "quick", label: "写一条", primary: true },
  { view: "sleep", label: "睡前收尾", primary: false },
];

const TAB_ICONS: Record<TabKey, typeof SunMedium> = {
  today: SunMedium,
  boxes: BoxIcon,
  more: Ellipsis,
};

export function Shell(props: ShellProps): React.ReactNode {
  const { view, onNavigate, badges, notice } = props;
  const tab = tabOf(view);
  const standalone = STANDALONE.includes(view);
  const mainRef = useRef<HTMLDivElement>(null);

  /**
   * 换一页就回到顶部。
   *
   * 少了这一步会有个很像 bug 的行为：正文那一栏是**同一个滚动容器**，
   * 从「全部记录」滚到中间再切到「待整理」，新页面会沿用上一页的滚动位置，
   * 一进来就是半截 —— 看起来像「点了一下界面跳了一段」。
   * 页面切换本来就该从顶部开始读。
   */
  useEffect(() => {
    mainRef.current?.scrollTo({ top: 0 });
    window.scrollTo({ top: 0 });
  }, [view]);

  const badgeOf = (key: ViewKey): number => badges?.[key] ?? 0;
  const withBadge = (label: string, key: ViewKey): string => {
    const count = badgeOf(key);
    return count > 0 ? `${label} ${count}` : label;
  };

  return (
    <main className="shell">
      <header className="app-head">
        <div>
          <h1>{props.title}</h1>
          {props.lede !== undefined && props.lede !== "" && <p className="lede">{props.lede}</p>}
        </div>
        <div className="head-tools">
          {props.headerAside}
          <ThemeToggle />
        </div>
      </header>

      {props.banner}

      <div className="app-body">
        {/* 同一份 tab，窄屏在底部、宽屏在左侧 —— 位置交给 CSS，不用 JS 判断。 */}
        <nav className="tabbar">
          {TABS.map((entry) => {
            const Icon = TAB_ICONS[entry.key];
            return (
              <button
                key={entry.key}
                className={tab === entry.key ? "tab-btn active" : "tab-btn"}
                aria-current={tab === entry.key ? "page" : undefined}
                onClick={() => onNavigate(entry.home)}
              >
                <Icon className="tab-icon" aria-hidden="true" size={22} strokeWidth={1.8} />
                <span className="tab-label">{entry.label}</span>
              </button>
            );
          })}
        </nav>

        <div className="app-main" ref={mainRef}>
          {tab === "boxes" && (
            <nav className="sub-tabs">
              {BOX_SUB_TABS.map((entry) => (
                <button
                  key={entry.key}
                  className={view === entry.key ? "sub-btn active" : "sub-btn"}
                  onClick={() => onNavigate(entry.key)}
                >
                  {entry.label}
                </button>
              ))}
            </nav>
          )}

          {/* 「今天」tab 的子页面。快速记录与睡前收尾**不在这里** —— 它们是动作，
              入口在「今天」那一页上，以及下面那条底部动作条里。 */}
          {tab === "today" && !standalone && view !== "today" && props.detailOpen !== true && (
            <nav className="sub-tabs">
              {TODAY_TABS.map((entry) => (
                <button
                  key={entry.key}
                  className={view === entry.key ? "sub-btn active" : "sub-btn"}
                  onClick={() => onNavigate(entry.key)}
                >
                  {withBadge(entry.label, entry.key)}
                </button>
              ))}
            </nav>
          )}

          {/* 不在标签栏里的页面得自带「回去」的动作。 */}
          {standalone && (
            <button className="btn" onClick={() => onNavigate("today")}>
              ← 返回今天
            </button>
          )}

          {notice !== null && notice !== undefined && (
            <p className="flash">
              <Prose text={notice} />
            </p>
          )}

          {props.children}

          {/* 首页自己已经有「写一条 / 睡前收尾」，不再重复一条底栏；
              今天下的全部记录、待整理等页面仍保留随时可写的入口。 */}
          {tab === "today" && !standalone && view !== "today" && props.detailOpen !== true && (
            <div className="bottombar">
              {RECORD_ACTIONS.map((action) => (
                <button
                  key={action.view}
                  className={action.primary ? "btn primary" : "btn"}
                  onClick={() => onNavigate(action.view)}
                >
                  {action.label}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
