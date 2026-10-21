import { useState } from "react";

import { ApiError, api } from "./apiClient.ts";
import { clockOf, firstLine } from "./projections.ts";
import { RecordList } from "./RecordList.tsx";
import { ProcessingModePicker } from "./ui/ProcessingModePicker.tsx";
import type { RecordRowView } from "./projections.ts";

/**
 * 「睡前收尾」（spec §2.1(11) / §2.4 / M3 验收）。
 *
 * 这一页不是「简化版的记录页」，它背着一套硬约束 —— 而且正是这些约束让它有意义：
 *
 * · **不显示任何待办数量**（§3.4 / M3 验收）：这一页不数「还有多少条没整理」，也不数「等你表态的有几条」。
 * · **不展开旧经历或跨记录关联**（§2.4）：只列本轮放进去的那几条。
 * · **不挽留**（§1.2 原则 5）：「收好并结束」不检查任何没处理的事，也不弹「你还有 N 条没整理」。
 *
 * 违反其中任何一条，这页就退化成换了名字的待办中心 —— 和它的产品目标（结束本次使用）正好相反。
 * 所以这一页故意「什么都没有」：没有侧栏计数、没有红点、没有「你可能还想看」。那不是没画完。
 */

export interface SleepPanelProps {
  /** 点今晚某一条 = 选中它并去「全部记录」看原文。 */
  readonly onSelectRecord: (id: string) => void;
  /** 「直接退出」回「今天」—— 收尾的终点就是离开这一页。 */
  readonly onFinished: () => void;
}

export function SleepPanel(props: SleepPanelProps): React.ReactNode {
  const [text, setText] = useState("");
  const [mode, setMode] = useState("manual_only");
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 本轮放进来的那几条（不是「今天的全部记录」）：id + 刚存下的原文与时间。 */
  const [added, setAdded] = useState<readonly RecordRowView[]>([]);
  const [ended, setEnded] = useState(false);

  async function put(): Promise<void> {
    if (adding || text.trim() === "") return;
    setAdding(true);
    setError(null);
    try {
      // 「今晚放进去的」只认这一轮的 POST 回执：服务端给不出别的时间口径，
      // 而把白天记的也算进「今晚」正是这一页最不该犯的错。
      const { revision } = await api.createRecord(text, mode);
      const row: RecordRowView = {
        id: revision.record_id,
        title: firstLine(revision.raw_text, 40),
        meta: clockOf(revision.created_at_local),
      };
      setAdded((prev) => [row, ...prev]);
      setText("");
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.detail : "放进去失败");
    } finally {
      setAdding(false);
    }
  }

  if (ended) {
    return (
      <div className="columns">
        <section className="card closing">
          <h2 className="closing-line">这些事情已经收好了。</h2>
          <p className="closing-line">明天想继续时，我们再打开。</p>
          <p className="hint">
            今晚放进去 {added.length} 条。它们已经存在本机 —— 你可以直接关掉这个窗口。
          </p>
          <div className="actions">
            <button className="btn primary" onClick={props.onFinished}>
              直接退出
            </button>
            <button className="btn" onClick={() => setEnded(false)}>
              还没收完，回去再写一条
            </button>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="columns">
      <section className="card">
        <h2>睡前收尾</h2>
        <p className="hint">
          把今天还没倒出来的写下来，放一条存一条，再收好。<strong>不用整理，不用分类，不用管之前记了什么。</strong>
        </p>

        <textarea
          rows={6}
          placeholder="现在脑子里还有什么……"
          value={text}
          onChange={(event) => setText(event.target.value)}
        />

        <ProcessingModePicker name="sleep-mode" value={mode} onChange={setMode} />
        <p className="hint">这里只负责保存；只有选了本机整理或云端发送，才会进入「待整理」。</p>

        <div className="actions">
          <button className="btn primary" onClick={() => void put()} disabled={adding || text.trim() === ""}>
            {adding ? "放进去中…" : "放进去"}
          </button>
        </div>
        {error !== null && <p className="warn">{error}</p>}

        <h3>今晚放进去的（{added.length}）</h3>
        <RecordList
          rows={added}
          selectedId={null}
          onSelect={props.onSelectRecord}
          emptyText="还没有。写一条试试。"
        />

        <div className="actions">
          <button className="btn primary" onClick={() => setEnded(true)}>
            收好并结束
          </button>
        </div>
        <p className="hint">这里不会数你还有多少条没处理，也不挽留。</p>
      </section>
    </div>
  );
}
