import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Ellipsis } from "lucide-react";

import { api, ApiError, type RecordDetailData } from "./apiClient.ts";
import { errorStatusOf, noticeForError, noticeForOutcome, recordTechnicalRows } from "./notices.ts";
import {
  COUNT_ONLY_CATEGORIES,
  WORD_LEVEL_CATEGORIES,
  effectiveLines,
  evidencePhrase,
  foldChips,
  monthDayOf,
  readableResult,
} from "./projections.ts";
import { crossesIntoCloud } from "./modeDefaults.ts";
import { ProcessingModePicker } from "./ui/ProcessingModePicker.tsx";
import {
  DisclosureNote,
  EvidenceLine,
  KeyValue,
  MentionChip,
  StatusLine,
  TechnicalDetails,
} from "./ui/bits.tsx";
import { MODE_LABEL, STATUS_LABEL } from "./ui/labels.ts";
import { ConfirmDialog } from "./ui/ConfirmDialog.tsx";
import { SourceText } from "./ui/SourceText.tsx";
import type { ActionOutcome } from "./notices.ts";
import type { NoticeInput } from "./useNotices.ts";
import type { ReadableResultGroup } from "./projections.ts";
import type {
  DeletePhaseResult,
  EffectiveEvidenceDto,
  EffectiveResultDto,
  IngestRunDto,
  ProcessingModeAvailabilityDto,
  RecordRow,
  RevisionRow,
} from "../shared/dto.ts";

/**
 * 记录详情 = 「原文」+「整理结果」两块（布局对应原型的 SourceView 与 ResultView）。
 *
 * 分层与外壳那条硬约束一致：**这一层取数，画的那两层只吃 props**。
 * 取数只走 `apiClient`，没有第二份数据来源。
 *
 * 三条既有语义逐字保留（它们是 M1a 的验收面，不是这次重写的对象）：
 * - 空 diff 不建版（保存按钮在未改动时禁用，服务端也会回 `changed: false`）；
 * - 历史版本永不改写，访问历史 ≠ 历史参与搜索；
 * - 删除的三态如实呈现，**严禁把 Phase B 失败说成回滚**（提示文案在父面板）。
 *
 * M3 投影就绪时在这一页加了三件事，都是「投影可用之后界面该说的话」：
 * - **可读行**：整理结果不再只有数量，经历/念头/提及逐条列出词面、依据、状态、强度；
 * - **点证据回原文**：锚点坐标来自服务端（界面不许按词面 `indexOf` 猜位置），
 *   `<p class="raw">` 里那一截套 `<mark>`。这一跳是整个产品的信任基础；
 * - **采纳 / 放弃候选**：`run.result_state = candidate` 的产出**不进**当前视图，
 *   不接这两个动作，盒子那五页就永远是空的（§3.7 / §4.7b）。
 */

/**
 * 详情页统一的反馈出口（〔web-redesign 批 2 · 事项 I/J〕）。
 *
 * 为什么是一个口子而不是各块各自的 `useState`：原文栏、整理结果栏、页脚三处各自存一份
 * 「上一次的回话」，于是同一句失败在不同栏里语气不同、有的在折叠里、有的六秒就没了。
 * 两个方法把这一屏的话收进同一个面：`deliver` 说回话，`fail` 说失败并带上下一步。
 */
interface DetailFeedback {
  readonly deliver: (outcome: ActionOutcome) => void;
  readonly fail: (message: string, status: number, retry?: () => void) => void;
}

type DetailView =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "ready"; readonly data: RecordDetailData };

/**
 * 整理结果的取数状态。五种都会真实出现：
 * `loading` 刚进来；`unready` 服务端回报解析能力没装配（此时 op9 直接 503，所以先问 op8 再决定要不要取）；
 * `none` 这个版本还没有 run；`ready` 有 run 但可读投影缺字段（只出计数）；`error` 服务端点名失败。
 */
type ResultView =
  | { readonly kind: "loading" }
  | { readonly kind: "unready" }
  | { readonly kind: "none"; readonly effective: EffectiveResultDto }
  | { readonly kind: "ready"; readonly effective: EffectiveResultDto; readonly run: IngestRunDto }
  | { readonly kind: "error"; readonly message: string };

export interface RecordDetailProps {
  readonly id: string;
  /** 原文有新版 / 处理态变化：父面板要重取列表（与待整理徽章）。 */
  readonly onChanged: () => void;
  readonly onDeleted: (result: DeletePhaseResult) => void;
  /** 统一反馈面（挂在 App 的 `useNotices`）：这一屏的回话与失败都交给它。 */
  readonly notify: (input: NoticeInput) => void;
  /** 换一条记录：上一条的回话与失败不该跟着过来。 */
  readonly clearScope: (scope: string) => void;
  /**
   * 409 的下一步：这一动作要的前置条件在「待整理」那一侧（逐次确认发送）。
   * 待整理页自己不传 —— 用户已经在那一屏了，跳过去是原地打转。
   */
  readonly onGoPending?: () => void;
  /**
   * 「编辑原文」：写是独占动作，去独立子页面做（〔web-redesign 批 4 · C〕）。
   * 这一层只负责跳过去；草稿、守卫、保存确认都在那一页（`RecordEditPanel`）。
   */
  readonly onEdit: () => void;
}

export function RecordDetail(props: RecordDetailProps): React.ReactNode {
  const [view, setView] = useState<DetailView>({ kind: "loading" });
  const [result, setResult] = useState<ResultView>({ kind: "loading" });
  // 现在要高亮回原文的那一段证据。null = 没点过，原文按整段画。
  const [jump, setJump] = useState<EffectiveEvidenceDto | null>(null);
  const [actionBusy, setActionBusy] = useState(false);

  const loadResult = useCallback(async (revisionId: string): Promise<void> => {
    setResult({ kind: "loading" });
    try {
      const config = await api.ingestConfig();
      if (!config.ingestReady) {
        // Provider 面未装配时 op9 必定 503。先问配置再决定取不取：
        // 拿一个注定失败的请求去撞，界面上只能显示一句错误，显示不出「为什么」。
        setResult({ kind: "unready" });
        return;
      }
      const effective = await api.ingestEffective(revisionId);
      if (effective.currentRunId === null) {
        setResult({ kind: "none", effective });
        return;
      }
      setResult({ kind: "ready", effective, run: await api.ingestRun(effective.currentRunId) });
    } catch (cause) {
      setResult({
        kind: "error",
        message: cause instanceof ApiError ? cause.detail : "整理结果读取失败",
      });
    }
  }, []);

  // 重取这一屏的把手：加载失败时「重试」就按它（把 `active` 守卫留在原有效果里，不另开一份取数）。
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let active = true;
    setView({ kind: "loading" });
    setResult({ kind: "loading" });
    // 换一条记录，上一次点的那一段证据就不相干了 —— 不清掉，高亮落在另一段原文上。
    setJump(null);
    api
      .getRecord(props.id)
      .then((data) => {
        if (!active) return;
        setView({ kind: "ready", data });
        void loadResult(data.current.id);
      })
      .catch((cause: unknown) => {
        if (!active) return;
        setView({
          kind: "error",
          message: cause instanceof ApiError ? cause.detail : "详情加载失败",
        });
      });
    return () => {
      active = false;
    };
  }, [props.id, loadResult, reloadKey]);

  /**
   * 换记录 / 离开这一屏：清掉属于这一条的提示（〔批 2 · 事项 I〕）。
   * 以前这件事也会发生，但是**意外发生**的：面板一重挂载、loading 一盖就把旧回话冲掉。
   * 「这条记录整理失败了」与「那条记录整理失败了」是两句话，混在一屏里就是撒谎。
   *
   * 清理挂在 effect 的退出上，不是挂在 `props.id` 的变化上：窄屏点「← 返回列表」是直接把
   * 这一屏卸掉，id 从头到尾没变过 —— 390 实测那样会漏着上一条的错误在屏上。
   *
   * **但要晚一拍才清**（〔批 4 · D〕实测逼出来的）：dev 的 StrictMode 把每个 effect 跑成
   * 「挂载 → 清理 → 挂载」，立刻清会把**同一批提交里刚推上去的回执**一起抹掉 ——
   * 保存成功正是这种：编辑页推完「已保存为新版本 v2」就跳回本页，本页一挂载就把那句话清了。
   * 留一拍，同一个 id 挂回来就取消；真走了（或 id 真的换了）才清。
   */
  const clearScope = props.clearScope;
  const pendingClear = useRef<{ readonly id: string; cancelled: boolean } | null>(null);
  useEffect(() => {
    const pending = pendingClear.current;
    if (pending !== null && pending.id === props.id) {
      pending.cancelled = true;
      pendingClear.current = null;
    }
    const id = props.id;
    return () => {
      const token = { id, cancelled: false };
      pendingClear.current = token;
      // 下一拍才真清（理由见上）：同一次提交里同一个 id 挂回来，就把这一清作废。
      queueMicrotask(() => {
        if (token.cancelled) return;
        if (pendingClear.current === token) pendingClear.current = null;
        clearScope(id);
      });
    };
  }, [props.id, clearScope]);

  if (view.kind === "loading") return <p className="hint">加载详情中…</p>;
  if (view.kind === "error") {
    // 区域状态留在内容流（它解释的是「这一屏为什么是空的」），但按事项 J 必须自带下一步。
    return (
      <p className="warn">
        {view.message}{" "}
        <button className="btn" onClick={() => setReloadKey((key) => key + 1)}>
          重试
        </button>
      </p>
    );
  }

  const { record, current, revisions } = view.data;

  /** 这一条记录的技术值。原来常驻页脚折叠件，现在随失败按需给出（C1 裁定）。 */
  function technicalRows(): readonly (readonly [string, string])[] {
    return recordTechnicalRows(record, current, result.kind === "ready" ? result.run : null);
  }

  /**
   * 把排障要用的那几句取走。剪贴板不可用（非安全上下文、浏览器拒绝）时不假装成功：
   * 同一条提示里那些值就在「技术详情」折叠件里，手动选中复制是兜底，不是第二套说法。
   */
  async function copyTechnical(): Promise<void> {
    const text = technicalRows()
      .map(([key, value]) => `${key}：${value}`)
      .join("\n");
    try {
      await navigator.clipboard.writeText(text);
      props.notify({ tone: "ok", message: "技术信息已复制到剪贴板。", scope: record.id });
    } catch {
      props.notify(
        noticeForError("这一条没能复制到剪贴板。", 0, {
          scope: record.id,
          retry: () => void copyTechnical(),
          rows: technicalRows(),
        }),
      );
    }
  }

  /** 回话进统一面：`ok` 六秒自己走，不如预期的（`warn`）留在原地直到被关掉。 */
  function deliver(outcome: ActionOutcome): void {
    props.notify(noticeForOutcome(outcome, record.id));
  }

  function fail(message: string, status: number, retry?: () => void): void {
    props.notify(
      noticeForError(message, status, {
        scope: record.id,
        ...(retry === undefined ? {} : { retry }),
        ...(props.onGoPending === undefined ? {} : { goPending: props.onGoPending }),
        copy: copyTechnical,
        rows: technicalRows(),
      }),
    );
  }

  const feedback: DetailFeedback = { deliver, fail };

  /** M5-1：改这一条的处理模式。成功/幂等都回读详情；409 这类服务端点名原样上屏，界面不猜。 */
  async function changeMode(mode: string): Promise<ActionOutcome> {
    const result = await api.setRecordMode(record.id, mode);
    if (!result.changed) return { tone: "warn", text: "这条记录本来就是这个模式，什么都没动。" };
    props.onChanged();
    const refreshed = await api.getRecord(record.id);
    setView({ kind: "ready", data: refreshed });
    const statusNote =
      refreshed.record.processing_status === "awaiting_privacy_review"
        ? "它现在停在「待隐私确认」，进「待整理」；首次发送前还要逐条确认。"
        : refreshed.record.processing_status === "not_processed"
          ? "它回退为「未处理」；模式 ≠ 授权，之前的发送授权不作数。"
          : "";
    return {
      tone: "ok",
      text: `已把这条的模式改为「${MODE_LABEL[mode] ?? mode}」。${statusNote}改模式不会自动发起整理。`,
    };
  }

  async function reparse(): Promise<ActionOutcome> {
    const parsed = await api.ingestReparse(record.id);
    props.onChanged();
    const refreshed = await api.getRecord(record.id);
    setView({ kind: "ready", data: refreshed });
    void loadResult(refreshed.current.id);
    if (!parsed.succeeded) {
      return {
        tone: "warn",
        text: `整理未成功（${parsed.errorKind ?? "未分类"}）：${parsed.failure?.message ?? "原文完好无损。"}`,
      };
    }
    return {
      tone: "ok",
      text: `已重跑：写入 经历 ${parsed.writes.episodes} · 念头 ${parsed.writes.thoughts} · 提及 ${parsed.writes.mentions}${parsed.replayed ? "（命中幂等重放，未重复产出）" : ""}。`,
    };
  }

  /**
   * S8：给 `manual_only` 一条明路。
   *
   * 这一档的语义是「不自动调用模型」，所以「整理这一条」必须先把模式改成 `local_model`，
   * 再发起整理；不能靠 `ingestReparse` 在 manual_only 上碰运气。改模式不会外发任何内容。
   */
  async function organizeManualOnly(): Promise<ActionOutcome> {
    await api.setRecordMode(record.id, "local_model");
    const parsed = await api.ingestParse({ recordId: record.id });
    props.onChanged();
    const refreshed = await api.getRecord(record.id);
    setView({ kind: "ready", data: refreshed });
    void loadResult(refreshed.current.id);
    if (!parsed.succeeded) {
      return {
        tone: "warn",
        text: `整理未成功（${parsed.errorKind ?? "未分类"}）：${parsed.failure?.message ?? "原文完好无损。"}`,
      };
    }
    return {
      tone: "ok",
      text: `已整理：写入 经历 ${parsed.writes.episodes} · 念头 ${parsed.writes.thoughts} · 提及 ${parsed.writes.mentions}${parsed.replayed ? "（命中幂等重放，未重复产出）" : ""}。`,
    };
  }

  async function removeRecord(): Promise<void> {
    props.onDeleted(await api.deleteRecord(record.id));
  }

  /** 采纳与放弃都只改 run 的结果态，不碰原文与派生行 —— 但详情、整理结果、徽章都得跟着重取。 */
  async function refreshAfterDecision(): Promise<void> {
    const refreshed = await api.getRecord(record.id);
    setView({ kind: "ready", data: refreshed });
    setJump(null);
    void loadResult(refreshed.current.id);
  }

  async function runAction(action: () => Promise<ActionOutcome>): Promise<void> {
    setActionBusy(true);
    try {
      deliver(await action());
    } catch (cause) {
      // 服务端点名的原因（如「只有 candidate 结果态可被采纳：当前 current」）原样显示，界面不替它猜。
      // 走统一面而不是本页的一份局部状态：它不自动消失，并按状态码给出下一步（事项 I/J）。
      fail(
        cause instanceof ApiError ? cause.detail : "操作失败，这一行的状态没有变化。",
        errorStatusOf(cause),
        () => void runAction(action),
      );
    } finally {
      setActionBusy(false);
    }
  }

  async function adoptCandidate(candidateRunId: string): Promise<ActionOutcome> {
    const adopted = await api.ingestAdopt(candidateRunId);
    props.onChanged();
    await refreshAfterDecision();
    return {
      tone: "ok",
      text:
        adopted.supersededRunId === null
          ? "已采纳：这一份现在是这条记录的当前结果，盒子那几页看得见它了。"
          : "已采纳：旧的当前结果连同它派生的行一起转为「已被取代」，历史仍在库里、没有删掉。",
    };
  }

  async function discardCandidate(candidateRunId: string): Promise<ActionOutcome> {
    await api.ingestDiscard(candidateRunId);
    props.onChanged();
    await refreshAfterDecision();
    return { tone: "ok", text: "已放弃：这一份候选转为「已被取代」。原文与既有结果都没动。" };
  }

  /** Phase B：撤销一次已生效的结果（current → superseded）。历史行留在库里。 */
  async function undoAdoption(runId: string): Promise<ActionOutcome> {
    await api.ingestUndoAdopt(runId);
    props.onChanged();
    await refreshAfterDecision();
    return { tone: "ok", text: "已撤销：这一份结果不再生效，历史仍在库里。" };
  }

  /**
   * 转正这一个实体（M8-1）。它只改这一行的生命周期，既不建边也不重跑模型——
   * 所以话说清楚：旧记录里那些因此被丢掉的关系，不会因为转正就自己出现（那要 M8-2 的重新分析）。
   * 回读走既有的整理结果通道：那一行的状态来自服务端，界面不留副本。
   */
  async function promoteEntity(entityId: string): Promise<ActionOutcome> {
    const promoted = await api.entityPromote(entityId);
    props.onChanged();
    await refreshAfterDecision();
    return promoted.promoted
      ? {
          tone: "ok",
          text: "已转正：它进默认列表了。已丢掉的关系不会因此自己出现——那要再发起一次分析。",
        }
      : { tone: "warn", text: "这个实体本来就已转正，什么都没动。" };
  }

  /**
   * 重新分析这一个版本（M8-2）。它**再调用一次模型**，产出的仍是候选：不采纳就进不了盒子那几页，
   * 旧的当前结果也不会被它偷偷改掉。这一版本有单在途 ⇒ 409，服务端那句原话经 `runAction` 原样上屏。
   */
  async function reanalyze(): Promise<ActionOutcome> {
    const again = await api.ingestReanalyze(record.id);
    props.onChanged();
    const refreshed = await api.getRecord(record.id);
    setView({ kind: "ready", data: refreshed });
    void loadResult(refreshed.current.id);
    if (!again.succeeded) {
      return {
        tone: "warn",
        text: `这次分析没跑成（${again.errorKind ?? "未分类"}）：${again.failure?.message ?? "既有的整理结果完好无损。"}`,
      };
    }
    return {
      tone: "ok",
      text:
        `已重新分析：这一次的结果还是候选，要你采纳才生效${again.replayed ? "（命中幂等重放，未重复产出）" : ""}。` +
        `写入 经历 ${again.writes.episodes} · 念头 ${again.writes.thoughts} · 提及 ${again.writes.mentions}。`,
    };
  }

  return (
    <div className="detail-page">
      <SourceSection
        record={record}
        current={current}
        highlight={jump}
        feedback={feedback}
        onEdit={props.onEdit}
        onDelete={removeRecord}
      />
      <ResultSection
        result={result}
        processingStatus={record.processing_status}
        highlight={jump}
        onJump={setJump}
        busy={actionBusy}
        onAdopt={(runId) => void runAction(() => adoptCandidate(runId))}
        onDiscard={(runId) => void runAction(() => discardCandidate(runId))}
        onUndo={(runId) => void runAction(() => undoAdoption(runId))}
        onPromote={(entityId) => void runAction(() => promoteEntity(entityId))}
        onReparse={() => void runAction(() => reparse())}
        onReanalyze={() => void runAction(() => reanalyze())}
        manualOnly={record.processing_mode === "manual_only"}
        onOrganizeManualOnly={() => void runAction(() => organizeManualOnly())}
        onRetryResult={() => void loadResult(current.id)}
      />
      {/* 〔web-redesign 第二步〕整理方式、版本历史、技术详情降到页脚：这一屏的主行动是读和改，
          不是配置。三件都在，只是不再排在用户那句话与整理结果之间当拦路的一堵表单墙。 */}
      <DetailFooter
        record={record}
        revisions={revisions}
        feedback={feedback}
        onSaveMode={changeMode}
      />
    </div>
  );
}

/* ── 原文那一块（只吃 props，自己只管「⋯」菜单与删除确认这类本地界面状态） ── */

interface SourceSectionProps {
  readonly record: RecordRow;
  readonly current: RevisionRow;
  /** 现在要高亮回原文的那一段证据（点整理结果里的证据行传下来）。 */
  readonly highlight: EffectiveEvidenceDto | null;
  readonly feedback: DetailFeedback;
  /** 去编辑子页面（〔批 4 · C〕）：这一层不再背一张 textarea。 */
  readonly onEdit: () => void;
  /** 成功即由父层换页；失败必须抛出，这一层才能如实显示「记录仍在」。 */
  readonly onDelete: () => Promise<void>;
}

function SourceSection(props: SourceSectionProps): React.ReactNode {
  const { record, current } = props;
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const moreRef = useRef<HTMLDetailsElement>(null);

  /**
   * 原生 `<details>` 只会被它自己的 summary 收起，点到别处不关 —— 一个开着不走的菜单
   * 会和后面的确认框叠在一起。点在外面就收起，点在里面交给各自的 onClick。
   */
  useEffect(() => {
    function onPointerDown(event: PointerEvent): void {
      const menu = moreRef.current;
      if (menu === null || !menu.open) return;
      if (event.target instanceof Node && menu.contains(event.target)) return;
      menu.open = false;
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, []);

  async function confirmDelete(): Promise<void> {
    setDeleting(true);
    try {
      await props.onDelete();
    } catch (cause) {
      // 失败那句原来显示在 `{confirmingDelete && …}` 里面：一撤确认它就跟着没了，
      // 用户看到的只有「点了确认，什么都没发生」。改走统一面，它才真的看得见。
      props.feedback.fail(
        cause instanceof ApiError ? cause.detail : "删除请求失败（记录仍在）",
        errorStatusOf(cause),
        () => void confirmDelete(),
      );
      setConfirmingDelete(false);
    } finally {
      setDeleting(false);
    }
  }

  return (
    <section className="detail-primary">
      {/* 〔web-redesign 批 2 · 事项 K〕这一行不再挂状态片：整屏只留一句状态，
          落在整理结果栏第一行。「已捕获」与「已整理」同屏互相矛盾（`needs_reparse`
          的真实记录正是「原文已改」+「有现行结果」），用户不该自己判断哪颗片更新。 */}
      <p className="detail-status">
        <span>{monthDayOf(record.created_at_local).replace("T", " ")}</span>
        {record.privacy_level === "sensitive" && <span className="badge warn-badge">敏感</span>}
      </p>

      {/* 〔web-redesign 第二步〕「原文」这两个字从版面上撤了：这一屏最大的字应该是用户自己写的话，
          不是栏目的名字。名字仍在 DOM 里，读屏软件照样念得出来。 */}
      <h2 className="visually-hidden">原文</h2>

      <SourceText
        text={current.raw_text}
        highlight={
          props.highlight === null || props.highlight.start === null || props.highlight.end === null
            ? null
            : {
                text: props.highlight.text,
                start: props.highlight.start,
                end: props.highlight.end,
                anchored: props.highlight.anchored,
              }
        }
        missingMessage={
          props.highlight === null
            ? undefined
            : `这一条证据点不回当前版本：${evidencePhrase(props.highlight)}（上面显示的是当前版本）。`
        }
      />

      {/*
        〔web-redesign 第二步 · 批 3 · B〕动作分级：这一排**只有两个可点**。
        - `编辑原文` 保留文字与一级样式：它是有代价的动作（保存会新建版本），不许伪装成零代价。
          批 4 起它不再展开一张内嵌 textarea，而是**去独立的编辑页**（写是独占动作）。
        - `重新整理` 挪去它产出所在的整理结果栏（见 `ResultSection` 的「重新整理」）。
        - `删除记录` 语义已固化、且是唯一一个不可逆的破坏性动作，收进行末的「⋯」里；
          触发件是原生 `<details>`（不做 hover-only，键盘与触屏都开得了），命中区 44×44。
      */}
      <div className="actions detail-actions">
        <button className="btn primary" onClick={props.onEdit}>
          编辑原文
        </button>
        <details className="detail-more" ref={moreRef}>
          <summary className="detail-more-toggle" aria-label="更多操作" title="更多操作">
            <Ellipsis size={20} aria-hidden="true" />
          </summary>
          <div className="detail-more-menu">
            <button
              className="detail-more-item"
              disabled={deleting || confirmingDelete}
              onClick={() => {
                // 选完就收起菜单：确认面板要独占视线，不能和一层没关的菜单一起摆在屏上。
                if (moreRef.current !== null) moreRef.current.open = false;
                setConfirmingDelete(true);
              }}
            >
              删除记录
            </button>
          </div>
        </details>
      </div>

      {/* 〔批 4 · C → 批 7 归位〕「改原文不会自动重新整理」这句预告**不在这一页**：
          它说的是按下保存会发生什么，归属于「编辑」这个动作，而编辑已经是独立的一页。
          按方案 §一-3「消息的位置由它归属于谁决定」，它跟着动作搬去了 `RecordEditPanel`，
          就摆在保存键上方。保存那一次的完整后果仍由编辑页的确认框在决策点说清（D）。 */}

      {/* 不可逆那句警告跟着动作走：点了「删除记录」才出现。
          常驻在版面上不会让删除更安全，只会让每一屏都先读到一句「这个操作会毁掉东西」。
          〔批 6 · 事项 I 的第三类〕整类升级成 `<dialog showModal>`：删除是唯一一个
          「必须处理才能继续」的破坏性动作，它该独占一屏，而不是和原文挤在同一张纸上。 */}
      {confirmingDelete && (
        <ConfirmDialog
          title="删除这条记录？"
          confirmLabel={deleting ? "删除中…" : "确认删除"}
          cancelLabel="取消"
          busy={deleting}
          danger
          onConfirm={() => void confirmDelete()}
          onCancel={() => setConfirmingDelete(false)}
        >
          <p>
            这条记录及其<strong>全部历史版本</strong>会从当前数据库中移除，
            且无法从当前界面撤销。
            旧备份中可能仍存在这些内容（恢复旧备份会将其带回）。
          </p>
        </ConfirmDialog>
      )}
    </section>
  );
}

/* ── 页脚那一排：整理方式与版本历史（技术值改由错误按需取回，见 `notices.ts`） ── */

interface DetailFooterProps {
  readonly record: RecordRow;
  readonly revisions: readonly RevisionRow[];
  readonly feedback: DetailFeedback;
  /** M5-1：改这一条的处理模式（PATCH /api/records/:id/mode）。 */
  readonly onSaveMode: (mode: string) => Promise<ActionOutcome>;
}

function DetailFooter(props: DetailFooterProps): React.ReactNode {
  const { record } = props;
  const [modeDraft, setModeDraft] = useState(record.processing_mode);
  const [busy, setBusy] = useState(false);
  const [confirmModeOpen, setConfirmModeOpen] = useState(false);
  /**
   * 可用的档位（哪几档这台机器上真能选、不能选的为什么）。
   * 与「今天」页那个选择器同一份判据：`api.ingestConfig().processingAvailability`。
   * 读不到就传 `null`（= 都可选）—— 不拿"不知道"冒充"不可用"。
   */
  const [availability, setAvailability] = useState<ProcessingModeAvailabilityDto | null>(null);

  // 切到另一条记录、或模式刚被服务端改过：草稿跟回在册值，不拿旧选择冒充新状态。
  useEffect(() => {
    setModeDraft(record.processing_mode);
  }, [record.id, record.processing_mode]);

  useEffect(() => {
    let active = true;
    api
      .ingestConfig()
      .then((config) => {
        if (active) setAvailability(config.processingAvailability);
      })
      .catch(() => {
        // 读不到配置不拦改档：保持 null，四档都画成可选，服务端仍会拦真正不可用的那一档。
      });
    return () => {
      active = false;
    };
  }, []);

  async function run(action: () => Promise<ActionOutcome>): Promise<void> {
    setBusy(true);
    try {
      props.feedback.deliver(await action());
    } catch (cause) {
      props.feedback.fail(
        cause instanceof ApiError ? cause.detail : "操作失败",
        errorStatusOf(cause),
        () => void run(action),
      );
    } finally {
      setBusy(false);
    }
  }

  /** 保存这一档。云端方向的确认由 `crossesIntoCloud` 在按键那一侧判，这里只管发。 */
  function saveMode(): Promise<void> {
    return run(() => props.onSaveMode(modeDraft));
  }

  return (
    <footer className="detail-foot">
      <ProcessingModePicker
        name={`detail-mode-${record.id}`}
        value={modeDraft}
        onChange={setModeDraft}
        availability={availability}
      >
        <div className="actions">
          <button
            className="btn"
            disabled={busy || modeDraft === record.processing_mode}
            onClick={() => {
              // 〔批 6 · 事项 H〕确认只花在「改变隐私边界」那一个方向。
              if (crossesIntoCloud(record.processing_mode, modeDraft)) setConfirmModeOpen(true);
              else void saveMode();
            }}
          >
            保存模式
          </button>
          {/* 上面那个摘要跟着草稿走（和快速记录一致），所以草稿没保存时必须明说 ——
              否则「整理方式：云端…」会读成已经生效。 */}
          {modeDraft !== record.processing_mode && (
            <span className="hint">改成「{MODE_LABEL[modeDraft] ?? modeDraft}」，按「保存模式」之后生效。</span>
          )}
        </div>
        {/* 回话不再留在折叠件里面（〔批 2 · 事项 I〕）：关掉那层 `details` 它就没了，
            而「模式改成了什么」正需要在你合上那一层之后还看得见。 */}
        <p className="hint">改模式不会自动发起整理；首次发送前仍要在「待整理」页逐次确认。</p>
      </ProcessingModePicker>
      {/* 选完要按保存（原本就是这样）；改到云端档时保存前多问一句 ——
          §4.8 的边：`captured + 云端 → awaiting_privacy_review`，这条以后会被逐条确认发送。 */}
      {confirmModeOpen && (
        <ConfirmDialog
          title="这条以后会送云端"
          confirmLabel="确认改档"
          cancelLabel="再看看"
          busy={busy}
          onConfirm={() => {
            setConfirmModeOpen(false);
            void saveMode();
          }}
          onCancel={() => setConfirmModeOpen(false)}
        >
          <p>
            改成「{MODE_LABEL[modeDraft] ?? modeDraft}」之后，这条会走云端通道。
            首次发送前仍要在「待整理」页逐次确认实际发出的那段文本。
          </p>
        </ConfirmDialog>
      )}

      <DisclosureNote summary={`版本历史（${props.revisions.length}）`}>
        <ul className="history">
          {[...props.revisions]
            .sort((a, b) => b.revision_number - a.revision_number)
            .map((rev) => (
              <li key={rev.id} className={rev.id === record.current_revision_id ? "current" : ""}>
                <p className="row-meta">
                  v{rev.revision_number}
                  {rev.id === record.current_revision_id ? " · 当前" : ""} · {rev.created_at_local}
                </p>
                <p className="record-text">
                  {rev.id === record.current_revision_id
                    ? rev.raw_text.slice(0, 120)
                    : `${rev.raw_text.slice(0, 60)}…`}
                </p>
              </li>
            ))}
        </ul>
        <p className="hint">版本只增不改。整理结果绑定的是具体某个版本。</p>
      </DisclosureNote>
      {/* 〔web-redesign 批 2 · C1 已裁定〕原来这一处常驻「技术详情」折叠件（记录编号 / 时区 /
          版本编号 / 内容指纹）撤了。理由：这四行值一年看不了两次，却占了每一条记录的页脚，
          把「读你自己写的话」那一屏压成一张工单。值没有被销毁 —— 它们由 `recordTechnicalRows`
          组装，随任何一条失败提示按需给出（`复制技术信息`，剪贴板不可用时就在同一条的
          「技术详情」折叠件里手动复制）。 */}
    </footer>
  );
}

/* ── 整理结果那一块（可读行 + 证据回原文 + 采纳/放弃候选） ── */

interface ResultSectionProps {
  readonly result: ResultView;
  /** 这一条记录的处置状态 —— 整屏唯一那句状态的前半句（事项 K）。 */
  readonly processingStatus: string;
  readonly highlight: EffectiveEvidenceDto | null;
  readonly onJump: (evidence: EffectiveEvidenceDto) => void;
  readonly busy: boolean;
  readonly onAdopt: (runId: string) => void;
  readonly onDiscard: (runId: string) => void;
  /** Phase B：撤销当前生效结果。 */
  readonly onUndo: (runId: string) => void;
  /** 转正「人物与事物」里某一行指向的实体（M8-1）。 */
  readonly onPromote: (entityId: string) => void;
  /** 重算的两个真实动作，收在同一个入口后面（〔批 3 · F〕）。 */
  readonly onReparse: () => void;
  /** 再发起一次分析（M8-2）。只在「这一版本真跑成过一次」时才有这一个动作。 */
  readonly onReanalyze: () => void;
  /** S8：这一条是 `manual_only`，没有结果时给一颗「整理这一条」。 */
  readonly manualOnly: boolean;
  readonly onOrganizeManualOnly: () => void;
  /** 整理结果这一栏读取失败后的重试：重取当前版本的 effective。 */
  readonly onRetryResult: () => void;
}

function ResultSection(props: ResultSectionProps): React.ReactNode {
  const { result } = props;
  // 只有取到结果那两种状态才有可读行可言（loading / unready / error 时这栏压根不该出现）。
  const groups = result.kind === "none" || result.kind === "ready" ? readableResult(result.effective) : [];
  return (
    <section className="detail-result">
      <div className="detail-heading">
        {/* 〔web-redesign 第二步〕这一栏的名字留着、但降到页脚那一排的份量：
            它是机器写的话，得有个名字免得被当成用户原文；它不该和用户的字比字号。 */}
        <h2 className="detail-kicker">整理结果</h2>
        <ResultState
          status={props.processingStatus}
          run={result.kind === "ready" ? result.run : null}
        />
      </div>

      {result.kind === "loading" && <p className="hint">读取中…</p>}

      {result.kind === "unready" && (
        <StatusLine tone="warn">解析未就绪，暂时取不到整理结果。</StatusLine>
      )}

      {result.kind === "error" && (
        // 区域状态留在内容流（事项 I 的分类：它解释的是「这一栏为什么是空的」），
        // 但按事项 J，一句失败必须就近带着下一步，不能只留一句红字。
        <p className="warn">
          {result.message}{" "}
          <button className="btn" onClick={props.onRetryResult}>
            重试
          </button>
        </p>
      )}

      {result.kind === "none" && (
        <>
          <p className="hint">这条记录还没有整理结果。</p>
          {/* 「还没有整理结果」说的是没有**现行**结果；候选那一份照样跑成功过，所以重新分析在这儿也有意义。 */}
          <RecalculateEntry
            effective={result.effective}
            busy={props.busy}
            manualOnly={props.manualOnly}
            onReparse={props.onReparse}
            onReanalyze={props.onReanalyze}
            onOrganizeManualOnly={props.onOrganizeManualOnly}
          />
        </>
      )}

      {result.kind === "ready" && (
        <>
          {/* 〔web-redesign 第二步 · 批 5 · 事项 E〕默认可见的那一层：
              状态（上一条 `.detail-heading`，第一行、随页面滚）+ 短词类的词与数量 +
              长句类只报数量 + 一个动作。**没有一个字是原文复读。** */}
          <ResultChips effective={result.effective} groups={groups} onJump={props.onJump} />

          {result.run.resultState === "current" && (
            <div className="actions">
              <button className="btn" disabled={props.busy} onClick={() => props.onUndo(result.run.runId)}>
                撤销这次生效
              </button>
            </div>
          )}

          <CandidateActions
            effective={result.effective}
            busy={props.busy}
            onAdopt={props.onAdopt}
            onDiscard={props.onDiscard}
          />
          {/* 重算入口与它的产出同栏：以前重算在原文框里，产出在这一栏，中间隔着整段原文。 */}
          <RecalculateEntry
            effective={result.effective}
            busy={props.busy}
            manualOnly={props.manualOnly}
            onReparse={props.onReparse}
            onReanalyze={props.onReanalyze}
            onOrganizeManualOnly={props.onOrganizeManualOnly}
          />

          <DisclosureNote summary="查看整理详情">
            {/* 标题与摘要（R5：`aiTitle` 退出默认可见面）进折叠件的**开头**：
                它们是机器的复读，是核对时才要的东西，不该占「扫一眼」那一层。 */}
            <ResultSummary effective={result.effective} />
            <ResultReadable
              groups={groups}
              onJump={props.onJump}
              busy={props.busy}
              onPromote={props.onPromote}
            />
            <ResultCounts effective={result.effective} />
            <KeyValue
              rows={[
                ["结果态", result.run.resultState],
                ["执行态", result.run.executionStatus],
                ["错误分类", result.run.errorKind ?? "无"],
                ["开始时间（UTC）", result.run.startedAtUtc],
              ]}
            />
          </DisclosureNote>
        </>
      )}
    </section>
  );
}

/**
 * 默认可见的 chip 行（〔web-redesign 第二步 · 批 5 · 事项 E〕裁定 R3 / R6）。
 *
 * 之前这一栏默认先摊标题与摘要：样张下来，整栏 92 个字里那两句占 55 个（60%），
 * 而且 100% / 98% 逐字来自原文 —— 机器的复读把「这一条算出了什么」挤出了视野。
 * 现在默认只回答两件事：
 *   · **短词类**（`情绪` / `主题`）：具体是哪些词，各几个 —— 点一下回原文并高亮，
 *     这条信任链因此提到一级，而不是要展开折叠件才摸得到；
 *   · **长句类**（`经历` / `念头` / `人物与事物`）：只有数量。它们的「词」是句子或专名，
 *     摊在每一屏的默认面上正是上面那个病根，也等于把名字一直露在外面。
 *
 * 数据与折叠件**同源**（`readableResult` 的同一批分组、同一个顺序）：两处不会各说各话。
 */
function ResultChips(props: {
  readonly effective: EffectiveResultDto;
  readonly groups: readonly ReadableResultGroup[];
  readonly onJump: (evidence: EffectiveEvidenceDto) => void;
}): React.ReactNode {
  if (props.groups.length === 0) {
    return <p className="hint">这次整理没有可显示的内容。</p>;
  }
  const wordGroups = props.groups.filter((group) => WORD_LEVEL_CATEGORIES.includes(group.category));
  const counts = effectiveLines(props.effective).filter(([label]) => COUNT_ONLY_CATEGORIES.includes(label));
  return (
    <div className="result-chips">
      {wordGroups.map((group) => {
        const folded = foldChips(group.lines);
        return (
          <div key={group.category} className="chip-row">
            <span className="chip-row-label">
              {group.category}（{group.lines.length}）
            </span>
            <ul className="chips">
              {folded.shown.map((line) => {
                const chip = line.chip;
                if (chip === undefined) return null;
                return (
                  <li key={line.id}>
                    <MentionChip
                      label={chip.label}
                      basis={chip.basis}
                      status={chip.status}
                      title={`原文说「${chip.said}」`}
                      onClick={() => props.onJump(line.evidence)}
                    />
                  </li>
                );
              })}
              {/* 被折走的一定是猜测：排序 explicit → inferred → 已移除（R6）。 */}
              {folded.hidden > 0 && <li className="chip-more">…还有 {folded.hidden} 个</li>}
            </ul>
          </div>
        );
      })}
      <p className="result-counts">
        {counts.map(([label, count]) => (
          <span key={label}>
            {label} {count}
          </span>
        ))}
      </p>
    </div>
  );
}

/**
 * 整屏唯一那句状态（〔web-redesign 批 2 · 事项 K〕）。
 *
 * 原来有两颗片：原文栏挂 `STATUS_LABEL[processing_status]`（「已捕获」），整理结果栏再挂一颗
 * run 的状态（「已整理」）。同屏两个口径、还互相矛盾 —— 真实的 `needs_reparse` 记录就是
 * 「原文已改，待重新整理」+「有一个现行结果」。合并成一句：处置状态打头（它是唯一的真值来源），
 * 这一版结果需要表态或被取代时补后半句 —— 补的是**同一件事的下一层**，不是第二套状态。
 * 位置按 R4 裁定留在整理结果栏第一行，跟着页面滚，不做第四层悬浮。
 */
function ResultState(props: { readonly status: string; readonly run: IngestRunDto | null }): React.ReactNode {
  const base = STATUS_LABEL[props.status] ?? props.status;
  const run = props.run;
  const tail =
    run === null ? "" : run.resultState === "candidate" ? " · 新结果等待你表态" : run.resultState === "superseded" ? " · 这一版结果已被取代" : "";
  const failed = run !== null && run.executionStatus === "failed";
  return (
    <span className={failed ? "detail-state fail" : "detail-state"}>
      {base}
      {tail}
    </span>
  );
}

/**
 * 这一版本名下有没有一次**真的跑成功**的 run。判据只取这一页已经读回来的 run 历史
 * （`effective.runHistory`），不新开一次查询：一次都没成功过的版本没有「重新分析」的对象。
 */
function hasSucceededRun(effective: EffectiveResultDto): boolean {
  return (effective.runHistory ?? []).some((item) => item.executionStatus === "succeeded");
}

/**
 * 重算这一个人口（〔web-redesign 第二步 · 批 3 · F〕）。
 *
 * 以前是**两个按钮**：原文栏一颗灰链接「重新整理」（op5）、整理结果栏一颗「重新分析」（op8）。
 * 两者名字同形、位置分家、产出不同（一个直接生效、一个出候选），平铺入口等于让用户自己试错：
 * 字没变点重算 = 幂等重放白跑；字变了点再分析 = 白堆一份候选。
 *
 * 现在只有一个入口，差别写在点开的那一层。**服务端一个字节没动**：两条路的授权闸门本来就是
 * 同一条（op5/op8 共用的解析能力与发送授权判定），差别只在 `reanalysis: true` 这个意图位。
 */
function RecalculateEntry(props: {
  readonly effective: EffectiveResultDto;
  readonly busy: boolean;
  readonly manualOnly: boolean;
  readonly onReparse: () => void;
  readonly onReanalyze: () => void;
  readonly onOrganizeManualOnly: () => void;
}): React.ReactNode {
  const [open, setOpen] = useState(false);
  /**
   * 这一版一次都没跑成过 ⇒ 这不是「重新」整理，是第一次整理。
   *
   * 以前这里无条件叫「重新整理」并弹一个两选 dialog：可那两选里的「重新分析」
   * 早被 `hasSucceededRun` 挡掉了，实际只剩一条路 —— 用户等于点开一层只为再点一次，
   * 而且「没有旧结果，重新什么？」这个问题没人回答得了。
   * 现在：没跑过就是一颗「发起整理」，直接跑，不弹层。
   */
  if (!hasSucceededRun(props.effective)) {
    // S8：manual_only 的记录原本没有整理入口；这颗按钮先把模式改成 local_model 再整理，
    // 避免 `ingestReparse` 在「不调用模型」的那一档上原地打转。
    if (props.manualOnly) {
      return (
        <div className="stack">
          <p className="hint">这条记录之前选择只保存，没有调用模型。整理会把模式改为本机模型，内容不出这台电脑。</p>
          <div className="actions">
            <button className="btn" disabled={props.busy} onClick={props.onOrganizeManualOnly}>
              整理这一条
            </button>
          </div>
        </div>
      );
    }
    return (
      <div className="actions">
        <button className="btn" disabled={props.busy} onClick={props.onReparse}>
          发起整理
        </button>
      </div>
    );
  }
  return (
    <div className="actions">
      <button className="btn" disabled={props.busy} onClick={() => setOpen(true)}>
        重新整理
      </button>
      {open && (
        <RecalculateDialog
          effective={props.effective}
          busy={props.busy}
          onReparse={props.onReparse}
          onReanalyze={props.onReanalyze}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}

/**
 * 两条路的说明面。做成 `<dialog showModal>` 而不是就地展开：它要的不是「读一下」，
 * 而是「选一个」——模态把背景压掉，两个选项都是真的动作，点错一次的代价是一次白跑。
 * 关法沿用 `BoxDetailDialog` 那一套：Escape / 点背景 / 取消，三条路都回到原处。
 */
function RecalculateDialog(props: {
  readonly effective: EffectiveResultDto;
  readonly busy: boolean;
  readonly onReparse: () => void;
  readonly onReanalyze: () => void;
  readonly onClose: () => void;
}): React.ReactNode {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog !== null && !dialog.open) dialog.showModal();
  }, []);

  // 选完先关再跑：请求在屏外跑，回话落到顶部那条统一提示面上（批 2 的面）。
  const choose = (action: () => void): void => {
    props.onClose();
    action();
  };

  return (
    <dialog
      className="modal-sheet"
      ref={dialogRef}
      aria-labelledby={titleId}
      onClose={props.onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) props.onClose();
      }}
    >
      <div className="modal-sheet-body">
        <h2 id={titleId}>重新整理这条</h2>
        <p className="hint">两条路都会再算一遍，差别是结果算不算数。</p>

        <div className="modal-option">
          <h3>重新整理</h3>
          <p>按现在的原文直接重跑，结果直接生效，不用再表态。原文改过、结果还停在旧版本时用它。</p>
          <button className="btn" disabled={props.busy} onClick={() => choose(props.onReparse)}>
            重新整理
          </button>
        </div>

        <ReanalyzeAction
          effective={props.effective}
          busy={props.busy}
          onReanalyze={() => choose(props.onReanalyze)}
        />

        <div className="actions">
          <button className="btn" onClick={props.onClose}>
            再想想
          </button>
        </div>
      </div>
    </dialog>
  );
}

/**
 * 重新分析（M8-2）。两条代价必须写在按钮旁边：它再调用一次模型，且产出仍是候选。
 * 这一版本一次都没成功跑过就没有这个动作 —— 没有「再分析一次」的对象。
 */
function ReanalyzeAction(props: {
  readonly effective: EffectiveResultDto;
  readonly busy: boolean;
  readonly onReanalyze: () => void;
}): React.ReactNode {
  if (!hasSucceededRun(props.effective)) return null;
  return (
    <div className="modal-option">
      <h3>重新分析</h3>
      <p>这会再调用一次模型；旧结果不动，新产出要采纳才生效。</p>
      <button className="btn" disabled={props.busy} onClick={props.onReanalyze}>
        重新分析
      </button>
    </div>
  );
}

/**
 * 事后取回的标题与摘要（0007 补列之后它们存在库里，不再只在「发起整理」那一次的回话里出现）。
 * 两句都没有就不占位置 —— 空标题不是信息，一句「没有标题」才是。
 */
function ResultSummary(props: { readonly effective: EffectiveResultDto }): React.ReactNode {
  const title = props.effective.aiTitle ?? "";
  const summary = props.effective.aiSummary ?? "";
  if (title === "" && summary === "") {
    return <p className="hint">这一份结果没有留下标题与摘要。</p>;
  }
  return (
    <>
      {title !== "" && <p className="detail-title">{title}</p>}
      {summary !== "" && <p className="record-text">{summary}</p>}
    </>
  );
}

/** 一条证据：能点回原文的走共用组件，点不回的说清为什么，不摆一个按了没反应的按钮。 */
function EvidenceJump(props: {
  readonly evidence: EffectiveEvidenceDto;
  readonly onJump: (evidence: EffectiveEvidenceDto) => void;
}): React.ReactNode {
  const { evidence } = props;
  if (!evidence.anchored) return <p className="warn">证据：{evidencePhrase(evidence)}</p>;
  if (evidence.start === null || evidence.end === null) return <p className="hint">证据：{evidencePhrase(evidence)}</p>;
  return (
    <EvidenceLine
      evidence={{ text: evidence.text, start: evidence.start, end: evidence.end, anchored: true }}
      onJump={() => props.onJump(evidence)}
    />
  );
}

/**
 * 可读行：按类别分组，每行「词面 → 标准名」加一行元信息，再挂上那个能点回原文的证据。
 *
 * 「人物与事物」的行还多一个动作：待转正的实体在这里被用户转正（M8-1）。
 * 判定用的是投影带上来的**在册状态**，不是这一行的措辞——已转正与已归档都不给按钮，
 * 因为转正只接受 provisional 这一个前置状态（M8-D-2），给了也只会收到一句拒绝。
 */
function ResultReadable(props: {
  readonly groups: readonly ReadableResultGroup[];
  readonly onJump: (evidence: EffectiveEvidenceDto) => void;
  readonly busy: boolean;
  readonly onPromote: (entityId: string) => void;
}): React.ReactNode {
  if (props.groups.length === 0) {
    return <p className="hint">这次整理没有可显示的内容。</p>;
  }
  return (
    <>
      {props.groups.map((group) => (
        <div key={group.category}>
          <h3>
            {group.category}（{group.lines.length}）
          </h3>
          <ul className="list">
            {group.lines.map((line) => {
              const promotable =
                line.entity !== undefined && line.entity.lifecycleStatus === "provisional"
                  ? line.entity
                  : null;
              return (
                <li key={line.id} className="item">
                  <span className="row-title">{line.title}</span>
                  <span className="row-meta">{line.meta}</span>
                  <EvidenceJump evidence={line.evidence} onJump={props.onJump} />
                  {promotable !== null && (
                    <div className="actions">
                      <button
                        className="btn"
                        disabled={props.busy}
                        onClick={() => props.onPromote(promotable.id)}
                      >
                        转正
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </>
  );
}

/**
 * 候选结果的表态入口（§四-8 收账）。
 *
 * 为什么这一栏必须存在：`result_state = candidate` 的产出**不进**当前视图（§3.7 三腿口径），
 * 用户不表态，盒子那五页就永远看不见它。两个动作都只改 run 的结果态，
 * <strong>不删任何东西</strong> —— 原文、历史版本、派生行都留在库里。
 *
 * 〔批 6 · 事项 G〕**采纳不确认、放弃要确认**。`moveResultState` 只有三条边
 * （`candidate→current`、`current→superseded`、`candidate→superseded`），**没有回头路**：
 * 放弃之后这份候选不能再被采纳。而旁边那句「原文与既有结果都没动」是真话，却容易被读成
 * 「可以撤销」。确认因此只加在真正不可逆的那一侧，不是加在所有动作上。
 */
function CandidateActions(props: {
  readonly effective: EffectiveResultDto;
  readonly busy: boolean;
  readonly onAdopt: (runId: string) => void;
  readonly onDiscard: (runId: string) => void;
}): React.ReactNode {
  const [pendingDiscard, setPendingDiscard] = useState<string | null>(null);
  const candidates = props.effective.candidates;
  if (candidates.length === 0) return null;
  const history = new Map((props.effective.runHistory ?? []).map((item) => [item.runId, item]));
  const titleOf = (index: number, item: { readonly aiTitle: string } | undefined): string =>
    item === undefined || item.aiTitle === "" ? `第 ${index + 1} 份候选` : `第 ${index + 1} 份候选「${item.aiTitle}」`;
  const discardIndex = candidates.findIndex((candidate) => candidate.runId === pendingDiscard);
  return (
    <div className="candidate-panel">
      <h3>有 {candidates.length} 份候选结果等你表态</h3>
      <ul className="list">
        {candidates.map((candidate, index) => {
          const item = history.get(candidate.runId);
          return (
            <li key={candidate.runId} className="item">
              <span className="row-title">
                第 {index + 1} 份候选：{item === undefined || item.aiTitle === "" ? "（这一份没留标题）" : item.aiTitle}
              </span>
              {item === undefined && <span className="row-meta">这一份的状态没取回。</span>}
              <div className="actions">
                <button className="btn primary" disabled={props.busy} onClick={() => props.onAdopt(candidate.runId)}>
                  采纳
                </button>
                <button className="btn" disabled={props.busy} onClick={() => setPendingDiscard(candidate.runId)}>
                  放弃
                </button>
              </div>
            </li>
          );
        })}
      </ul>
      <TechnicalDetails
        rows={candidates.map((candidate, index) => {
          const item = history.get(candidate.runId);
          return [
            `候选 ${index + 1}`,
            item === undefined
              ? `结果 ${candidate.runId} · 历次结果里没返回`
              : `结果 ${candidate.runId} · ${item.executionStatus} · 起于 ${item.startedAtUtc}（UTC）`,
          ] as const;
        })}
      />
      {pendingDiscard !== null && (
        <ConfirmDialog
          title="放弃这份候选？"
          confirmLabel={props.busy ? "放弃中…" : "放弃这份候选"}
          cancelLabel="再看看"
          busy={props.busy}
          danger
          onConfirm={() => {
            const runId = pendingDiscard;
            setPendingDiscard(null);
            props.onDiscard(runId);
          }}
          onCancel={() => setPendingDiscard(null)}
        >
          <p>
            {discardIndex >= 0 && titleOf(discardIndex, history.get(pendingDiscard))} 会转成「已被取代」，
            之后<strong>不能再采纳</strong>。原文与已有的整理结果不会被动到。
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
}

function ResultCounts(props: { readonly effective: EffectiveResultDto }): React.ReactNode {
  const lines = effectiveLines(props.effective);
  const total = lines.reduce((sum, entry) => sum + entry[1], 0);
  if (total === 0) {
    // 空结果的句子由可读行那一栏统一说一次，这里不重复。
    return null;
  }
  return (
    <>
      <h3>数量</h3>
      <ul className="list">
        {lines.map(([label, count]) => (
          <li key={label} className="item">
            <span className="row-title">
              {label}（{count}）
            </span>
          </li>
        ))}
      </ul>
    </>
  );
}
