import { useEffect, useRef, useState } from "react";

import { api, ApiError, type RecordDetailData } from "./apiClient.ts";
import { errorStatusOf, noticeForError, recordTechnicalRows } from "./notices.ts";
import { ConfirmDialog } from "./ui/ConfirmDialog.tsx";
import type { NoticeInput } from "./useNotices.ts";
import type { ViewKey } from "./ui/types.ts";

/**
 * 「编辑原文」——〔web-redesign 第二步 · 批 4 · C〕从详情页里那张内嵌 textarea 搬出来的独立子页面。
 *
 * 为什么是独立页面，而不是把内嵌那块修好：那块有四个可指认的病，其中两个修不掉——
 *   ① 同一句话在屏上出现两到三份（原文 hero + textarea + 整理结果摘要）；
 *   ② 窄屏 594px 以下键盘弹起后，原文与结果同时被推出视野；
 *   ③ **草稿静默丢失**：窄屏「← 返回列表」走 `onBack` → `selectedId=null` → 整个详情卸载；
 *      宽屏经 `view.kind==="loading"` 早退同样卸载。实测 `editorOpen:false`，字没了；
 *   ④ 阅读态与书写态共用一张纸。
 * 而且只有**独占的一面**才让「保存」名正言顺地弹确认（〔批 4 · D〕）：保存一次动四件事实。
 *
 * 代价要认：编辑时看不见这条的整理结果。补偿不是「把结果栏也塞进这一页」——
 * 那是把两个状态硬拼回一张纸；补偿是保存确认框在决策点把后果说清（D 的逐字文案）。
 *
 * 这一层**只吃 props、只经 `apiClient` 取数**（与详情页同一条纪律）。
 */

type LoadView =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "ready"; readonly data: RecordDetailData };

export interface RecordEditPanelProps {
  readonly recordId: string;
  /** 保存成功：父层要重取列表与徽章（真实状态变了）。 */
  readonly onSaved: () => void;
  /**
   * 回详情页。父层走的是**绕过守卫**的那一次跳转 ——
   * 用户已经明确选了「丢弃改动」或保存成功，守卫再拦一次就是自己跟自己打架。
   * 参数是「去那一页」：从 tab 被拦下来的话，丢弃后要去的正是他刚才点的那一页。
   */
  readonly onLeave: (next?: ViewKey) => void;
  readonly notify: (input: NoticeInput) => void;
  /**
   * 有未保存的改动时，把守卫交给外壳：返回 / 切 tab 都先问它，它返回 `false` 就不跳。
   * 为什么不在这里自己拦：返回键与三个 tab 都是外壳画的，页面拦不到它们。
   */
  readonly onGuard: (guard: ((next: ViewKey) => boolean) | null) => void;
}

export function RecordEditPanel(props: RecordEditPanelProps): React.ReactNode {
  const [view, setView] = useState<LoadView>({ kind: "loading" });
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  // 只有「说的是这个输入框自己」的话留在这里（事项 I 的分类：字段校验就地显示）。
  const [inline, setInline] = useState<string | null>(null);
  const [confirmSaveOpen, setConfirmSaveOpen] = useState(false);
  const [confirmLeaveOpen, setConfirmLeaveOpen] = useState(false);
  /** 读回来的那一版原文：`dirty` 拿它当基线，不是拿「上次 draft」。 */
  const baseText = view.kind === "ready" ? view.data.current.raw_text : "";
  const dirty = draft !== baseText;

  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let active = true;
    setView({ kind: "loading" });
    api
      .getRecord(props.recordId)
      .then((data) => {
        if (!active) return;
        setView({ kind: "ready", data });
        setDraft(data.current.raw_text);
        setInline(null);
      })
      .catch((cause: unknown) => {
        if (!active) return;
        setView({
          kind: "error",
          message: cause instanceof ApiError ? cause.detail : "这条记录读取失败",
        });
      });
    return () => {
      active = false;
    };
  }, [props.recordId, reloadKey]);

  /**
   * 把「走不走得掉」交给外壳。`dirty` 一变就换一次守卫：
   * 没改动时撤掉守卫（`null`），有改动时守卫只做一件事——**把二选一摆出来**，然后说不许走。
   * 真正离开的两条路（保存成功 / 丢弃）由本页调 `onLeave()`，那一次跳转不经过守卫。
   *
   * 守卫收下目的地并记住它：拦下来只为了问一句，不是为了替用户改主意 ——
   * 他点的是「盒子」，选「丢弃」之后要去的就该是盒子。
   */
  const pendingLeaveTo = useRef<ViewKey | null>(null);
  const onGuard = props.onGuard;
  useEffect(() => {
    if (!dirty) {
      pendingLeaveTo.current = null;
      onGuard(null);
      return;
    }
    onGuard((next) => {
      pendingLeaveTo.current = next;
      setConfirmLeaveOpen(true);
      return false;
    });
    return () => onGuard(null);
  }, [dirty, onGuard]);

  /** 这一条的技术值：随失败按需给出（C1 裁定：值可取得，不必常驻）。 */
  function technicalRows(): readonly (readonly [string, string])[] {
    if (view.kind !== "ready") return [];
    return recordTechnicalRows(view.data.record, view.data.current);
  }

  async function copyTechnical(): Promise<void> {
    const text = technicalRows()
      .map(([key, value]) => `${key}：${value}`)
      .join("\n");
    try {
      await navigator.clipboard.writeText(text);
      props.notify({ tone: "ok", message: "技术信息已复制到剪贴板。", scope: props.recordId });
    } catch {
      props.notify(
        noticeForError("这一条没能复制到剪贴板。", 0, {
          scope: props.recordId,
          retry: () => void copyTechnical(),
          rows: technicalRows(),
        }),
      );
    }
  }

  /**
   * 真正发 `PUT`。**只有确认框按下之后才走到这里**（〔批 4 · D〕：进入编辑零代价，保存有代价）。
   * 空 diff 仍然先被 `dirty` 挡住；万一服务端回 `changed:false`（例如它做了自己的规范化），
   * 那句「没有变化」留在保存键上方 —— 它说的是这个输入框，不该去占顶部提示位。
   */
  async function save(): Promise<void> {
    if (view.kind !== "ready") return;
    setBusy(true);
    setInline(null);
    try {
      const saved = await api.editRecord(view.data.record.id, draft);
      setConfirmSaveOpen(false);
      if (!saved.changed) {
        setInline("原文没有变化，未创建新版本。");
        return;
      }
      props.onSaved();
      props.notify({
        tone: "ok",
        message: `已保存为新版本 v${saved.revision.revision_number}。`,
        scope: props.recordId,
      });
      // 保存成功 = 这一版就是新的基线，守卫此时已经没有要拦的东西了。
      props.onLeave();
    } catch (cause) {
      setConfirmSaveOpen(false);
      // 服务端那句 detail 逐字上屏，界面不替它猜；能重试的（连不上 / 5xx）给重试。
      props.notify(
        noticeForError(cause instanceof ApiError ? cause.detail : "保存失败，原文没有改动。", errorStatusOf(cause), {
          scope: props.recordId,
          retry: () => void save(),
          copy: copyTechnical,
          rows: technicalRows(),
        }),
      );
    } finally {
      setBusy(false);
    }
  }

  /** 「取消」与外壳的返回走同一条判断：有改动就先问，没改动直接走。 */
  function requestLeave(): void {
    if (dirty) setConfirmLeaveOpen(true);
    else props.onLeave();
  }

  if (view.kind === "loading") return <p className="hint">读取这一条…</p>;
  if (view.kind === "error") {
    return (
      <p className="warn">
        {view.message}{" "}
        <button className="btn" onClick={() => setReloadKey((key) => key + 1)}>
          重试
        </button>
      </p>
    );
  }

  return (
    <div className="quick-page">
      {/* 与「快速记录」同一张纸：写这件事在哪儿都该长得一样。 */}
      <section className="quick-sheet">
        <h2 className="visually-hidden">编辑原文</h2>
        <textarea
          className="quick-input"
          rows={9}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
        {/* 字段校验那句话留在保存键上方：它说的是这个框，不该去占用顶部提示位。 */}
        {inline !== null && <p className="warn">{inline}</p>}
        <div className="actions">
          <button
            className="btn primary"
            disabled={busy || !dirty}
            onClick={() => setConfirmSaveOpen(true)}
          >
            保存为新版本
          </button>
          <button className="btn" disabled={busy} onClick={requestLeave}>
            取消
          </button>
          {!dirty && <span className="hint">内容与当前版本一致。</span>}
        </div>
      </section>

      {confirmSaveOpen && (
        <ConfirmDialog
          title="保存为新版本？"
          confirmLabel={busy ? "保存中…" : "保存为新版本"}
          cancelLabel="再看看"
          busy={busy}
          onConfirm={() => void save()}
          onCancel={() => setConfirmSaveOpen(false)}
        >
          <p>
            修改保存后的原文为新版本，整理结果仍为旧记录的整理结果，需要发送给模型重新整理后才会以新版本更新整理结果。
          </p>
        </ConfirmDialog>
      )}

      {confirmLeaveOpen && (
        <ConfirmDialog
          title="还没保存"
          confirmLabel="留下改动"
          cancelLabel="丢弃改动"
          /* Esc / 点背景 = 留下：按 Esc 的人想的是「别走」，不是「把字丢了」。 */
          onDismiss={() => setConfirmLeaveOpen(false)}
          onConfirm={() => setConfirmLeaveOpen(false)}
          onCancel={() => props.onLeave(pendingLeaveTo.current ?? undefined)}
        >
          <p>离开这一页，改过的字就没了。</p>
        </ConfirmDialog>
      )}
    </div>
  );
}
