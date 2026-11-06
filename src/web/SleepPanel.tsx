import { useEffect, useRef, useState } from "react";

import { ApiError, api } from "./apiClient.ts";
import { processingPatchForScope, resolveEntryMode } from "./modeDefaults.ts";
import { clockOf, firstLine } from "./projections.ts";
import { RecordList } from "./RecordList.tsx";
import { ProcessingModePicker } from "./ui/ProcessingModePicker.tsx";
import type { RecordRowView } from "./projections.ts";
import type { ProcessingModeAvailabilityDto } from "../shared/dto.ts";

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
 *
 * 整理方式（四档）在这里可选，初始值来自设置页的**同一个默认值**（`recordDefaultMode`）：
 * 写入页、睡前页、设置页共用这一个值，在这里改档会立即回写它，三处因此永远一致。
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
  const [availability, setAvailability] = useState<ProcessingModeAvailabilityDto | null>(null);
  const touchedMode = useRef(false);
  const preferenceWrite = useRef<Promise<unknown>>(Promise.resolve());
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** 本轮放进来的那几条（不是「今天的全部记录」）：id + 刚存下的原文与时间。 */
  const [added, setAdded] = useState<readonly RecordRowView[]>([]);
  const [ended, setEnded] = useState(false);

  // 进入本页先从配置初始化（与设置页、写入页同一个值）；拿不到配置就留在 manual_only。
  useEffect(() => {
    let active = true;
    api
      .ingestConfig()
      .then((cfg) => {
        if (!active) return;
        const resolved = resolveEntryMode(cfg.processingDefaults.recordDefaultMode, cfg.processingAvailability);
        setAvailability(cfg.processingAvailability);
        if (!touchedMode.current) setMode(resolved.mode);
        if (resolved.fellBack) setNotice("保存的默认整理方式当前不可用，这一条先按「仅保存」处理。");
      })
      .catch(() => {
        // 读不到配置不拦收尾本身：保持 manual_only，不谎称知道可用性。
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (notice === null) return;
    const timer = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(timer);
  }, [notice]);

  /** 三处共用同一个默认值：本页改档立即回写 `recordDefaultMode`，设置页/写入页随之一致。 */
  function selectMode(next: string): void {
    touchedMode.current = true;
    setMode(next);
    const patch = processingPatchForScope("record", next);
    preferenceWrite.current = preferenceWrite.current
      .catch(() => undefined)
      .then(() => api.updateProcessingDefaults(patch))
      .then(
        () => undefined,
        () => undefined,
      );
  }

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
          <p className="hint">今晚放进去 {added.length} 条。</p>
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
        <textarea
          rows={6}
          placeholder="现在脑子里还有什么……"
          value={text}
          onChange={(event) => setText(event.target.value)}
        />

        <ProcessingModePicker
          name="sleep-mode"
          value={mode}
          onChange={selectMode}
          availability={availability}
        />
        {notice !== null && <p className="flash">{notice}</p>}
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
      </section>
    </div>
  );
}
