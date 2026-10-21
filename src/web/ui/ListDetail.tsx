/**
 * 列表 / 详情两档布局的壳。
 *
 * 宽屏：两栏同屏（左边列表、右边详情），`hasSelection` 只决定右侧显示哪条详情。
 * 窄屏：一栏一屏 —— 列表 → 点一条进详情 → 点「← 返回列表」回来。
 *
 * 这一套在盒子的五个页面、待整理、记录详情里全是同一个形状，所以抽成壳：
 * 「切到窄屏就看不见返回列表」这种错，不该由每个页面各自负责一次。
 * 断点判断只有一个来源（`useIsNarrow`），与 CSS 里那条媒体查询同一个数。
 */

import { useIsNarrow } from "./bits.tsx";
import type { ListDetailProps } from "./types.ts";

export function ListDetail(props: ListDetailProps): React.ReactNode {
  const narrow = useIsNarrow();
  const { list, detail, hasSelection, onBack } = props;
  const listOnly = props.listOnly === true || (!narrow && props.wideListOnly === true);

  return (
    <div className={narrow || listOnly ? "stack" : "split"}>
      {(!narrow || !hasSelection || listOnly) && <div className="stack">{list}</div>}

      {!listOnly && (!narrow || hasSelection) && (
        <div className="stack">
          {narrow && (
            <button className="btn" onClick={onBack}>
              ← 返回列表
            </button>
          )}
          {detail}
        </div>
      )}
    </div>
  );
}
