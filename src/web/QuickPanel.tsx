import { useEffect, useState } from "react";

import { api } from "./apiClient.ts";
import { quickOrganizeBusyLabel, quickSecondActionFor, runQuickSave, type QuickSaveDeps } from "./quickSave.ts";
import { ProcessingModePicker } from "./ui/ProcessingModePicker.tsx";

/**
 * 「快速记录」—— 一段自由文本就能存下来，不要求先分类（spec §2.1(1)）。
 *
 * 这条能力原来长在「全部记录」页的页内卡片上，UI-4 收编成独立页面（〔Claude Code 裁决 2026-10-16〕：
 * 「写」是每天的动作，不该寄居在「翻旧账」的那一页里）。
 *
 * 原型把处理模式摆在保存按钮旁边，理由是「送不送模型、送不送云端」该在下笔那一刻就有意识。
 * M5-1 起这个选择器**可写**；M5-2 起按所选模式补第二动作（〔主 Agent 裁决 2026-10-18〕）：
 *   · `manual_only` —— 只有「只保存」，绝不调用模型。
 *   · `local_model` —— 「保存并整理」：`createRecord` 成功后才 `ingestParse`，原文永远先落盘。
 *   · `cloud_redacted` —— 「保存，去确认发送」：只保存并带到「待整理」页，**不**自动
 *     preview / confirm-send / parse（K-17：模式 ≠ 授权 ≠ 已解析，每条首次发送前仍要逐次确认）。
 * 时序本体在 `quickSave.ts`（可跑逻辑与渲染分离的缘由见那一份的头注）。
 */

export interface QuickPanelProps {
  /** 存下一条之后：外壳要重取徽章（真实状态变了）。 */
  readonly onSaved: () => void;
  /** 云端第二动作：选中新记录并切到「待整理」页（由 App 接线，面板不自己路由）。 */
  readonly onOpenPending: (recordId: string) => void;
}

export function QuickPanel(props: QuickPanelProps): React.ReactNode {
  const [text, setText] = useState("");
  const [mode, setMode] = useState("manual_only");
  const [busy, setBusy] = useState<null | "save" | "organize">(null);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  useEffect(() => {
    if (flash === null) return;
    const timer = setTimeout(() => setFlash(null), 6000);
    return () => clearTimeout(timer);
  }, [flash]);

  const second = quickSecondActionFor(mode);

  const deps: QuickSaveDeps = {
    createRecord: (text, mode) => api.createRecord(text, mode),
    ingestParse: (body) => api.ingestParse(body),
    // 保存成功当刻清空输入：走这条即时回调，而非等 runQuickSave 返回——local 整理可达数十秒，
    // 那之后才清空就违反「保存成功即清空输入」。创建失败时 runQuickSave 根本不调它，原文留着。
    onCreated: () => setText(""),
    onSaved: props.onSaved,
    onOpenPending: props.onOpenPending,
  };

  async function submit(organize: boolean): Promise<void> {
    if (busy !== null) return;
    setBusy(organize ? "organize" : "save");
    setError(null);
    try {
      const outcome = await runQuickSave(deps, text, mode, organize);
      // 清空已由 deps.onCreated 在 createRecord 成功当刻完成，这里不再 setText。
      if (outcome.kind === "create-failed") {
        setError(outcome.detail);
        return;
      }
      if (outcome.kind === "saved") setFlash(outcome.flash);
      else setError(outcome.warn);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="quick-page">
      <section className="quick-sheet">
        {flash !== null && <p className="flash">{flash}</p>}
        <textarea
          className="quick-input"
          rows={9}
          value={text}
          placeholder="想到什么就写什么，不用先想它属于哪一类。"
          onChange={(event) => setText(event.target.value)}
        />

        <ProcessingModePicker name="quick-mode" value={mode} onChange={setMode} />

        <div className="actions">
          <button className="btn primary" onClick={() => void submit(false)} disabled={busy !== null || text.trim() === ""}>
            {busy === "save" ? "保存中…" : "只保存"}
          </button>
          {second !== null && (
            <button className="btn" onClick={() => void submit(true)} disabled={busy !== null || text.trim() === ""}>
              {busy === "organize" ? quickOrganizeBusyLabel(mode) : second.label}
            </button>
          )}
        </div>
        {error !== null && <p className="warn">{error}</p>}
      </section>
    </div>
  );
}
