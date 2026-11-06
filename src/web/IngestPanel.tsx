import { useCallback, useEffect, useRef, useState } from "react";

import { isEgress } from "../shared/contracts/enums.ts";
import { api } from "./apiClient.ts";
import { deletePhaseMessage } from "./projections.ts";
import {
  SEND_TRACK_LABEL,
  modeForTrack,
  trackOfAxes,
  trackSwitchedNotice,
  type SendTrack,
} from "./sendTrack.ts";
import { RecordDetail } from "./RecordDetail.tsx";
import { SELECTED_BACKGROUND } from "./RecordList.tsx";
import { buildInboxRows, type InboxRow } from "./inbox.ts";
import {
  REDACTION_TIERS,
  REDACTION_TIER_LABEL,
  llmCheckingText,
  llmUnusedNoticeText,
  prewarmPendingText,
  redactionSourceLabel,
  redactionTierEnabled,
  redactionTierOfMode,
  redactionTierUnavailableText,
  showRedactionTierRow,
  tierSwitchedNotice,
  type RedactionTier,
} from "./redactionTier.ts";
import {
  BATCH_CONFIRM_FAILURE_TEXT,
  REVIEW_QUEUE_POLL_MS,
  confirmReviewEntries,
  type BatchConfirmOutcome,
} from "./reviewBatch.ts";
import {
  BATCH_ORGANIZE_FAILURE_TEXT,
  runBatchOrganize,
  summarizeBatchOrganize,
  type BatchOrganizeMode,
  type BatchOrganizeOutcome,
  type BatchOrganizeTarget,
} from "./batchOrganize.ts";
import { ListDetail } from "./ui/ListDetail.tsx";
import { JOB_STATUS_LABEL, MODE_LABEL } from "./ui/labels.ts";
import { DisclosureNote, StatusLine, TechnicalDetails, useIsNarrow } from "./ui/bits.tsx";
import { ConfirmDialog } from "./ui/ConfirmDialog.tsx";
import { SendReviewDialog } from "./ui/SendReviewDialog.tsx";
import { SendMethodDialog } from "./ui/SendMethodDialog.tsx";
import {
  FAILURE_ACTION_LABEL,
  failurePlanOf,
  type FailureAction,
  type FailurePlan,
} from "./failureActions.ts";
import { INGEST_STAGE_ACTION, INGEST_STAGE_LABEL, ingestStageOf, stagePrimaryEnabled } from "./ingestStage.ts";
import { useElapsedSeconds } from "./useElapsedSeconds.ts";
import { useRecords } from "./useRecords.ts";
import type { NoticeInput } from "./useNotices.ts";
import type {
  GrantDto,
  JobStatusDto,
  JobViewDto,
  ModelPrivacyConfigDto,
  PendingRecordDto,
  ReviewQueueEntryDto,
  ReviewQueuePrewarmDto,
  SendPreviewDto,
} from "../shared/dto.ts";
import type { IngestResultDto } from "../shared/dto.ts";
import { ChevronRight } from "lucide-react";

/**
 * 「待整理」：等发送授权、解析失败、原文改了要重跑的记录都在这里（布局对齐原型的待整理页）。
 *
 * 这一页的设计要点是**不推、不催**：用户主动来的地方，不显示压力性数字，不红点催办。
 * 它同时是云路径唯一的发送授权入口 —— 隐私承诺就落在这几个按钮上。
 *
 * 取数全在面板这一层（`api.ingestConfig` / `api.ingestPending` + `useRecords`），
 * 画的组件只吃 props。没有静态假数据：后端不可达就如实报错。
 */

export interface IngestPanelProps {
  readonly selectedId: string | null;
  readonly onSelect: (id: string | null) => void;
  readonly onBadgesChanged: () => void;
  /** 统一反馈面（挂在 App 的 `useNotices`），交给这一页挂的 `RecordDetail` 用。 */
  readonly notify: (input: NoticeInput) => void;
  readonly clearScope: (scope: string) => void;
  /** 详情页的「编辑原文」：写是独占动作，跳独立子页面（父层路由，面板不自己跳）。 */
  readonly onEdit: () => void;
  /** 「解析未就绪」那一格要一个真能走过去的下一步：去「设置与数据」装配模型。 */
  readonly onOpenSettings: () => void;
}

/**
 * 队列观测的轮询间隔（0E §七 已定口径：轮询，不建 SSE/WebSocket，也不给进度百分比）。
 * 与服务端 worker 的 `DEFAULT_POLL_INTERVAL_MS` 同量级；这里是**读侧**的取数节奏，
 * 不是任务的时间预算（那一头的时间权威是 `privacy_job` 行上的租约，见 `jobLease.ts`）。
 */
const JOB_POLL_INTERVAL_MS = 2_000;

/**
 * 还可能在动的状态：非这一列 ⇒ 终态 ⇒ 停止轮询。
 * 取值的封闭清单在 `shared/dto.ts` 的 `JOB_STATUS_DTO_VALUES`（服务端 `JOB_STATUSES` 由
 * `tests/m6-0e-job-routes.test.ts` 逐字对账），这里只列出其中「还没跑完」的三个。
 */
const JOB_ACTIVE_STATUSES: readonly JobStatusDto[] = ["queued", "redacting", "analyzing"];

/**
 * 每一类失败都落到同一个面（S7）：一句人话 + 最多三个下一步 + 折叠的技术详情。
 * 动作集合由 `failureActions.ts` 的映射表给，这里只负责按钮接线，不再按错误码分叉。
 */
function FailureSurface(props: {
  readonly plan: FailurePlan;
  readonly busy: boolean;
  readonly onAction: (action: FailureAction) => void;
}): React.ReactNode {
  return (
    <div className="stack">
      <p className="warn">{props.plan.headline}</p>
      <div className="actions">
        {props.plan.actions.map((action) => (
          <button
            key={action}
            className="btn"
            type="button"
            disabled={props.busy}
            onClick={() => props.onAction(action)}
          >
            {FAILURE_ACTION_LABEL[action]}
          </button>
        ))}
      </div>
      {props.plan.technical !== null && (
        <TechnicalDetails rows={[["技术详情", props.plan.technical]]} />
      )}
    </div>
  );
}

/**
 * 全页唯一的发送授权通道：一次一条，一条一张四腿授权。
 *
 * 单条复核与队列那一屏的批量确认（M10-3）都从这一处签——批量不许另开第二份请求写法，
 * 也不许攒成一个批量端点（M10-D-4）。用户在哪一屏点的头都是同一件事：这一份载荷可以发出去。
 */
async function confirmSendGrant(recordId: string): Promise<GrantDto> {
  return api.ingestConfirmSend({ recordId });
}

export function IngestPanel(props: IngestPanelProps): React.ReactNode {
  const narrow = useIsNarrow();
  const feed = useRecords();
  const [config, setConfig] = useState<ModelPrivacyConfigDto | null>(null);
  const [pending, setPending] = useState<readonly PendingRecordDto[]>([]);
  /**
   * M10-2 复核队列：外发轨记录的「本机算出载荷没有 / 用户点头没有 / 本机模型跑成没有」。
   * 读的是服务端算好的那一屏（不重算、不咨询）；M10-3 起可以在这里勾几条、逐条签发发送授权。
   */
  const [reviewQueue, setReviewQueue] = useState<readonly ReviewQueueEntryDto[]>([]);
  /**
   * 预跑队列的整体读数（M10-4）。和 `reviewQueue` 出自同一份响应、同一次 `snapshot()`，
   * 所以这两格永远说同一刻。「还在检查」只认这里（M10-D-9），不从 `hasPayload` 反推。
   */
  const [prewarm, setPrewarm] = useState<ReviewQueuePrewarmDto>({ pending: 0 });
  const [busy, setBusy] = useState(false);
  /** S7：所有失败都收成这一份「人话 + 下一步 + 折叠详情」，不再各写各的错误字符串。 */
  const [failure, setFailure] = useState<FailurePlan | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);
  /** 「重试」重跑的是**最后一次动作**（preview / parse / 换轨…），不是另造一条路径。 */
  const lastRun = useRef<(() => Promise<void>) | null>(null);

  const [preview, setPreview] = useState<SendPreviewDto | null>(null);
  const [grant, setGrant] = useState<GrantDto | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  /**
   * 这一次「问本机模型」是从什么时候开始的（null = 没在等）。
   *
   * 只跟着 `api.ingestPreview(` 那几处起点走，不在别处赋值：界面写着「正在检查」而服务端其实没被
   * 问，比少写一句更糟。清空只在 `action()` 的 `finally` 里，一处收口。
   */
  const [previewStartedAt, setPreviewStartedAt] = useState<number | null>(null);

  /**
   * D-9：本次停留期间「刚整理成功」的记录集合（recordId → 标题 + 结果摘要）。
   * 列表顶部画成「已整理成功」行、右侧画完成卡；离开本页（组件卸载）自然清空，
   * 所以切页再回来时左右皆空（D-8）。
   */
  const [completed, setCompleted] = useState<Map<string, { title: string; message: string }>>(
    () => new Map(),
  );

  /** 排队后的观测：`jobView` 是末条任务，`jobWatchId` 非 null 即「还在轮询这条记录」。 */
  const [jobView, setJobView] = useState<JobViewDto | null>(null);
  const [jobWatchId, setJobWatchId] = useState<string | null>(null);

  const reload = useCallback(async (): Promise<void> => {
    setBusy(true);
    setFailure(null);
    try {
      const [cfg, list, queue] = await Promise.all([
        api.ingestConfig(),
        api.ingestPending(),
        api.reviewQueue(),
      ]);
      setConfig(cfg);
      setPending(list.records);
      setReviewQueue(queue.entries);
      setPrewarm(queue.prewarm);
    } catch (cause) {
      setFailure(failurePlanOf(cause));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void reload();
    void feed.reload();
  }, [reload, feed.reload]);

  /**
   * 预览请求的代次。
   *
   * 为什么需要：进屏会自动取一次预览，用户可能在这份还没回来时就点了「确认并整理」——
   * 确认成功后会再取一份（带授权的）。两个响应**到达顺序不保证**：先发的那份更晚到，
   * 就会把「已确认」覆盖回「没确认」，界面表现为按钮先变「发起整理」又弹回「等你确认」。
   * 只有最新一次请求的响应允许写回；换记录时把代次推一下，让在途的那份作废。
   */
  const previewSeq = useRef(0);

  /** 取一份预览并写回。所有「重取预览」的地方都走这一处，写回顺序由代次裁决。 */
  const previewInFlight = useRef(false);
  async function loadPreview(recordId: string): Promise<void> {
    const seq = ++previewSeq.current;
    previewInFlight.current = true;
    setPreviewStartedAt(Date.now());
    try {
      const next = await api.ingestPreview({ recordId });
      if (seq === previewSeq.current) setPreview(next);
    } finally {
      if (seq === previewSeq.current) previewInFlight.current = false;
    }
  }

  /** 换一条记录，上一份预览与授权就不相干了 —— 必须清空，不然显示的是别的版本的内容。 */
  const resetDetail = useCallback(() => {
    setPreview(null);
    setGrant(null);
    setRawText(null);
    setConfirmOpen(false);
    setOutcome(null);
    setFailure(null);
    lastRun.current = null;
    // 队列的观测也跟着作废：上一排的轮询结果属于另一条记录，继续显示就是谎报。
    setJobView(null);
    setJobWatchId(null);
    // 在途的预览也作废：它属于上一条，晚到一步就会覆盖这一条的空位。
    previewSeq.current += 1;
  }, []);

  function choose(id: string | null): void {
    props.onSelect(id);
    resetDetail();
  }

  /**
   * 失败面上的三个下一步（S7）。
   * `retry` 重跑最后一次动作；`settings` 只导航（不改任何配置）；`save-only` 让这一条留在本机，
   * 原文本来就已落盘，不需要再做一次写入。
   */
  function handleFailureAction(step: FailureAction): void {
    if (step === "retry") {
      const run = lastRun.current;
      if (run !== null) void action(run);
      else void reload();
      return;
    }
    if (step === "settings") {
      props.onOpenSettings();
      return;
    }
    setFailure(null);
    setOutcome("这一条先留着；原文已经在本机，之后可以在记录详情里重新整理。");
  }

  async function action(run: () => Promise<void>): Promise<void> {
    lastRun.current = run;
    setBusy(true);
    setFailure(null);
    setOutcome(null);
    try {
      await run();
    } catch (cause) {
      setFailure(failurePlanOf(cause));
    } finally {
      setBusy(false);
      // 等本机模型这件事只在 `action` 的这一段里发生，所以也在这一段结束：成功、失败、被拒
      // 三条路都收，界面不会停在一句「正在检查」上。
      setPreviewStartedAt(null);
    }
  }

  /**
   * 「重新问本机模型」（M10-4，裁决 M10-D-12）：队列里那一行自己按下这一次，只重算那一条。
   *
   * 起点仍在 `api.ingestPreview(` 之前按下（与既有四处同一纪律），收口仍走 `action()` 那一个
   * `finally`——不在这里再造第二个清空点。算好之后：正是当前选中的那条就换掉详情栏，
   * 否则丢掉返回值——队列那一屏只要这一条算好了，不该当场抢走用户正在看的另一条。
   */
  async function retryLocalLlm(recordId: string): Promise<void> {
    await action(async () => {
      const seq = ++previewSeq.current;
      setPreviewStartedAt(Date.now());
      // F-2：带 force:true ⇒ 服务端先清本地模型档缓存，真的再咨询一次模型（否则只会复现已缓存结果）。
      const next = await api.ingestPreview({ recordId, force: true });
      // 只在这条仍是当前选中、且没有更新的一次请求在后面时写回。
      if (seq === previewSeq.current && recordId === selected?.recordId) setPreview(next);
      await reload();
    });
  }

  /**
   * 唯一收件箱（S5）：两份只读投影合并成一行一个动作。
   * 队列项带授权/载荷/本机模型三格，`pending` 补本地摘要；外发行在 `pending` 里的副本不再单列。
   */
  const inboxRows = buildInboxRows(pending, reviewQueue);

  /**
   * 选中的那条：先看两份投影里有没有它，再决定宽屏的默认落点。
   * 不在任何一份里（比如从「全部记录」带过来的已完成记录）就算没选中，不假装它是待整理的。
   */
  function resolveSelected(id: string | null): PendingRecordDto | null {
    if (id === null) return null;
    const listed = pending.find((row) => row.recordId === id);
    if (listed !== undefined) return listed;
    const queued = reviewQueue.find((row) => row.recordId === id);
    if (queued === undefined) return null;
    // D-8：服务端 review-queue 不按状态过滤，已 parsed 的外发记录也在里面。只有仍需要动作
    // （needsAction）或本次刚整理成功（completed，D-9）的记录才认作选中；否则切页回来右侧
    // 会残留一条已完成的记录与它的原文，而列表已经空了。
    if (queued.needsAction !== true && !completed.has(id)) return null;
    // 队列项不含摘要（N-6），但详情要的字段它都有：补一个空摘要只为复用同一形状。
    return {
      recordId: queued.recordId,
      currentRevisionId: queued.currentRevisionId,
      processingStatus: queued.processingStatus,
      processingMode: queued.processingMode,
      axes: queued.axes,
      privacyLevel: queued.privacyLevel,
      createdLocalDate: queued.createdAtUtc.slice(0, 10),
      preview: "",
    };
  }
  const chosenId =
    props.selectedId !== null &&
    (resolveSelected(props.selectedId) !== null || completed.has(props.selectedId))
      ? props.selectedId
      : narrow
        ? null
        : (inboxRows[0]?.recordId ?? null);
  // 宽屏没选中就落到第一条，详情栏永远有内容；窄屏只有用户点过才算选中。
  const selected = resolveSelected(chosenId);

  const parseReady = config?.ingestReady === true;
  // 判定读三轴（草案 §五：processing_mode 只是派生兼容字段）：外发 ⟺ send_content_mode ≠ none。
  // 对既有两档 cloud_redacted ⟺ isEgress(axes)，故行为不变；新增的 cloud_raw 因此自动获得同一道闸门。
  const egressSelected = selected !== null && isEgress(selected.axes);
  const canStartOrganize = parseReady && (!egressSelected || preview?.hasApplicableGrant === true);
  // 这一条此刻在哪一步。六个阶段全由已有事实推出（`ingestStage.ts` 逐态可测），
  // 渲染里不再散落一串互相纠缠的布尔。
  const stage = ingestStageOf({
    parseReady,
    cloud: egressSelected,
    hasPreview: preview !== null,
    hasGrant: preview?.hasApplicableGrant === true,
    jobActive: jobView !== null && JOB_ACTIVE_STATUSES.includes(jobView.status),
    lastFailed: selected !== null && selected.processingStatus === "failed",
  });
  const track = selected === null ? ("redacted" as SendTrack) : trackOfAxes(selected.axes);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [methodOpen, setMethodOpen] = useState(false);
  /**
   * 这一版原文，只为了在确认弹窗里把每一处遮蔽还原成「原文 → 占位符」。
   * 懒取（打开弹窗才取），并校验 revision 一致 —— 坐标是**那一版**的偏移，
   * 版本对不上就宁可只显示占位符。
   */
  const [rawText, setRawText] = useState<string | null>(null);

  /**
   * 三个动作，按阶段挑一个 —— 这一框的「主行动只有一个」就落在这一处。
   * 以前它们分散在两颗并列按钮与一串布尔里，读者要自己拼「现在该点哪个」。
   */
  async function runPrimary(): Promise<void> {
    if (stage === "blocked") {
      props.onOpenSettings();
      return;
    }
    // `loading` 是在等本机，不是等用户：一律按不动，也就不需要分支。
    if (stage === "loading") return;
    if (stage === "needs-grant") {
      setConfirmOpen(true);
      return;
    }
    await organizeNow();
  }

  /**
   * 进屏即取预览（〔web-redesign 第三步 · 用户裁定〕）。
   *
   * 原来那一版给这一屏加了一个「先看一眼」的阶段：框里空着，只有一颗「看要发的内容」。
   * 那个状态没有信息可判断，用户唯一的选项就是点它 —— 等于把一次没有选择的点击伪装成一个阶段。
   * 改成选中即取（只读、不发请求），阶段直接落在「等你确认」。
   *
   * `previewKey` 带上三轴与修订号：换轨、换档、改原文都会换掉要发的内容，
   * 那就该重新取一份；`autoPreviewed` 防的是 StrictMode 的「挂载→清理→挂载」重复取，
   * 以及 effect 自己触发的重复渲染。
   */
  const previewKey =
    selected === null
      ? null
      : `${selected.recordId}:${selected.currentRevisionId}:${selected.axes.analysisProvider}:${selected.axes.redactionMode}:${selected.axes.sendContentMode}`;
  const autoPreviewed = useRef<string | null>(null);
  useEffect(() => {
    if (previewKey === null || !egressSelected) return;
    // D-9：已整理完成的记录不再去取预览（否则会为一张不再出现的卡片发一次只读请求）。
    if (selected !== null && completed.has(selected.recordId)) return;
    if (preview !== null) return;
    // 已经有人在取（换轨/换档/确认之后就自己取了）：不再发第二份。
    if (previewInFlight.current) return;
    if (autoPreviewed.current === previewKey) return;
    autoPreviewed.current = previewKey;
    void refetchPreview();
  }, [previewKey, egressSelected, preview]);

  /**
   * 打开「这次发送要确认的东西」，顺手把这一版原文取来 —— 遮蔽清单里只给占位符的话，
   * 用户没法核对遮的是谁（`[person_1_ab12]` 不指向任何可读的东西）。
   * 取不到不影响确认：弹窗照旧，只是那一列写「原文对不上」。
   */
  async function openReview(): Promise<void> {
    setReviewOpen(true);
    const current = selected;
    if (current === null || rawText !== null) return;
    try {
      const detail = await api.getRecord(current.recordId);
      setRawText(detail.current.id === preview?.recordRevisionId ? detail.current.raw_text : null);
    } catch {
      setRawText(null);
    }
  }

  /** 取一份实际待发送文本。只读、不发请求 —— 与服务端那条 preview 通道同一件事。 */
  async function refetchPreview(): Promise<void> {
    const current = selected;
    if (current === null) return;
    await action(async () => {
      setPreview(null);
      setGrant(null);
      await loadPreview(current.recordId);
    });
  }

  /** 把一次整理结果落成一句人话（organizeNow / confirmAndOrganize / 批量整理共用）。 */
  function organizeMessage(parsed: IngestResultDto): string {
    if (!parsed.succeeded) {
      return `整理未成功：${parsed.failure?.message ?? "服务端未给出原因。"} 原文完好无损。`;
    }
    const base = `写入 经历 ${parsed.writes.episodes} · 念头 ${parsed.writes.thoughts} · 提及 ${parsed.writes.mentions}（被拒 ${parsed.writes.rejectedMentions}）`;
    const replay = parsed.replayed ? " · 已有同样结果，未重复产出" : "";
    return parsed.autoAdopted === true
      ? `已整理并生效：${base}${replay}。`
      : `已整理：${base}${replay}；结果作为候选，等你采纳。`;
  }

  /** D-9：记一条「刚整理成功」，让列表顶部与右侧完成卡在离开本页前都能看到。 */
  function markCompleted(recordId: string, message: string): void {
    const title = inboxRows.find((row) => row.recordId === recordId)?.title ?? "这条记录";
    setCompleted((previous) => {
      const next = new Map(previous);
      next.set(recordId, { title, message });
      return next;
    });
  }

  /** 发起整理（云端档走到这里时授权已就位，闸门在服务端再判一次）。 */
  async function organizeNow(): Promise<void> {
    const current = selected;
    if (current === null) return;
    await action(async () => {
      const parsed = await api.ingestParse({ recordId: current.recordId });
      const message = organizeMessage(parsed);
      if (parsed.succeeded) markCompleted(current.recordId, message);
      setOutcome(message);
      props.onBadgesChanged();
      await reload();
    });
  }

  /** 批量整理用：整理一条并返回结果（成功记入完成集合）；由 InboxSection 逐条调用。 */
  async function organizeOne(recordId: string): Promise<{ succeeded: boolean; message: string }> {
    const parsed = await api.ingestParse({ recordId });
    const message = organizeMessage(parsed);
    if (parsed.succeeded) markCompleted(recordId, message);
    return { succeeded: parsed.succeeded, message };
  }

  /**
   * D-6：签授权 + 立即整理，一步走。脱敏核对弹窗的「确认整理」与框外的确认框
   * 都调这一处，不写第二份。调用方负责用 `action()` 包住（忙态与错误面统一）。
   */
  async function confirmAndOrganize(recordId: string): Promise<void> {
    const confirmed = await confirmSendGrant(recordId);
    setGrant(confirmed);
    // 签发成功本身就是「这份载荷已授权」的服务端读数，不再去问第二遍。
    setPreview((prev) => (prev === null ? prev : { ...prev, hasApplicableGrant: true }));
    setConfirmOpen(false);
    setReviewOpen(false);
    // Phase B（S4）：确认与整理合并成一次动作，四腿命中，不会再问第二次模型。
    const parsed = await api.ingestParse({ recordId });
    const message = organizeMessage(parsed);
    if (parsed.succeeded) markCompleted(recordId, message);
    props.onBadgesChanged();
    setOutcome(message);
    await reload();
  }

  /** 排到后台（旁路）：排进去之后这一屏不必陪着等。 */
  async function enqueueOrganize(): Promise<void> {
    const current = selected;
    if (current === null) return;
    await action(async () => {
      const queued = await api.enqueueJob(current.recordId);
      setJobView(queued);
      setJobWatchId(current.recordId);
      setOutcome(
        `${JOB_STATUS_LABEL[queued.status] ?? queued.status}。处理完这一条会自己写完，不用守着这一屏。`,
      );
      props.onBadgesChanged();
    });
  }
  // 本地模型辅助脱敏这一档可选吗：判据**只有** `usable` 这一格（服务端 `localLlmStatus` 的产物，
  // M9-D-4）。页面不重算回环、不看地址——那种第二套判断一旦写歪，错的一侧是「以为模型帮忙遮过」。
  const localLlmUsable = config?.localLlm?.usable === true;
  const localLlmWhyNot = redactionTierUnavailableText(config?.localLlm ?? null);
  const selectedRevisionId = selected?.currentRevisionId ?? null;
  const previewRevisionId = preview?.recordRevisionId ?? null;

  useEffect(() => {
    if (selectedRevisionId === null || previewRevisionId === null) return;
    if (selectedRevisionId === previewRevisionId) return;
    setPreview(null);
    setGrant(null);
    setConfirmOpen(false);
  }, [previewRevisionId, selectedRevisionId]);

  /**
   * 排队后的轮询（0E §七）：只读 `GET /api/jobs?recordId`，取时间序末项展示。
   * 停下来的三种情形都写死在这里：终态、换记录/卸载（effect 清理）、读失败
   * （队列面读不通时继续转只会盖住真正的错误，所以停轮询、把那一行状态原样留着）。
   */
  useEffect(() => {
    if (jobWatchId === null) return;
    const recordId = jobWatchId;
    let stopped = false;
    const poll = async (): Promise<void> => {
      try {
        const listed = await api.listJobs(recordId);
        if (stopped) return;
        const last = listed.jobs[listed.jobs.length - 1] ?? null;
        setJobView(last);
        if (last === null || !JOB_ACTIVE_STATUSES.includes(last.status)) setJobWatchId(null);
      } catch {
        if (!stopped) setJobWatchId(null);
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), JOB_POLL_INTERVAL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [jobWatchId]);

  return (
    <ListDetail
      hasSelection={selected !== null}
      onBack={() => choose(null)}
      list={
        <>
          {failure !== null && selected === null && (
            <FailureSurface plan={failure} busy={busy} onAction={handleFailureAction} />
          )}

          <InboxSection
            rows={inboxRows}
            completedRows={Array.from(completed.entries()).map(([recordId, value]) => ({
              recordId,
              title: value.title,
            }))}
            prewarm={prewarm}
            selectedId={chosenId}
            onSelect={choose}
            onReload={reload}
            onConfirmOne={async (recordId) => {
              await confirmSendGrant(recordId);
            }}
            onOrganizeOne={organizeOne}
            onConfirmed={() => {
              // 授权状态以服务端最新读数为准：队列与单条预览都重取，界面不自己猜。
              void reload();
              if (selected !== null && egressSelected) {
                void action(() => loadPreview(selected.recordId));
              }
              props.onBadgesChanged();
            }}
            loading={busy && inboxRows.length === 0}
          />

          <section className="card">
            <h2>本机状态</h2>
            {config === null ? (
              <p className="hint">{failure?.headline ?? "读取中…"}</p>
            ) : (
              <>
                <StatusLine tone={parseReady ? "info" : "warn"}>
                  {parseReady ? "解析就绪" : "解析未就绪"}
                </StatusLine>
                <StatusLine>
                  {config.cloudRedactedEnabled ? "云端通道可用" : "云端通道未开启"} ·{" "}
                  {config.apiKeyConfigured ? "密钥已配置" : "密钥未配置"}
                </StatusLine>
                <TechnicalDetails
                  rows={[
                    ["默认处理方式", MODE_LABEL[config.defaultMode] ?? config.defaultMode],
                    ["模型启用", config.modelEnabled ? "是" : "否"],
                    ["模型服务", config.provider ?? "（未装配）"],
                    ["调用通道", config.callPath ?? "（未配置）"],
                    ["密钥", config.apiKeyConfigured ? "已配置" : "未配置"],
                    ["解析能力", parseReady ? "就绪" : "未就绪"],
                    ["云端脱敏通道", config.cloudRedactedEnabled ? "开" : "关"],
                  ]}
                />
              </>
            )}
            <div className="actions">
              <button className="btn" onClick={() => void reload()} disabled={busy}>
                刷新
              </button>
            </div>
          </section>
        </>
      }
      detail={
        chosenId !== null && completed.has(chosenId) ? (
          <section className="card ingest-act">
            <div className="ingest-act-head">
              <h2 className="ingest-stage">已整理完成</h2>
              <span className="ingest-flags">
                {egressSelected && <span className="tag">{SEND_TRACK_LABEL[track]}</span>}
              </span>
            </div>
            <p className="flash">{completed.get(chosenId)?.message}</p>
            <p className="hint">这一条已从待整理移出；离开本页后不再显示。</p>
          </section>
        ) : selected === null ? (
          <section className="card">
            <h2>操作</h2>
            <p className="hint">左边选一条记录。</p>
          </section>
        ) : (
          <>
            <section className="card ingest-act" data-stage={stage}>
              {/* 〔web-redesign 第三步〕这一框现在只有一个头：**阶段名**。
                  以前这里是「操作」+ 状态 · 整理方式 + 两枚徽章 + 两轨单选 + 脱敏单选 + 两颗大按钮，
                  所有开关同时在场；现在阶段名回答「我在哪一步」，动作行回答「下一步做什么」。 */}
              <div className="ingest-act-head">
                <h2 className="ingest-stage">{INGEST_STAGE_LABEL[stage]}</h2>
                <span className="ingest-flags">
                  {egressSelected && <span className="tag">{SEND_TRACK_LABEL[track]}</span>}
                  {selected.privacyLevel === "sensitive" && <span className="badge warn-badge">敏感</span>}
                </span>
              </div>

              {egressSelected && (
                <CloudGate
                  preview={preview}
                  grant={grant}
                  track={track}
                  recordRedactionMode={selected.axes.redactionMode}
                  previewPendingSince={previewStartedAt}
                  onOpenReview={() => void openReview()}
                  onOpenMethod={() => setMethodOpen(true)}
                />
              )}

              {/* 一行动作。主按键的动词由阶段决定；「排到后台」永远是旁路，不与主行动抢重量。 */}
              <div className="actions ingest-actions">
                <button
                  className="btn primary"
                  disabled={busy || !stagePrimaryEnabled(stage)}
                  onClick={() => void runPrimary()}
                >
                  {busy ? "处理中…" : INGEST_STAGE_ACTION[stage]}
                </button>
                <button
                  className="ingest-side"
                  disabled={busy || !canStartOrganize || !stagePrimaryEnabled(stage)}
                  onClick={() => void action(enqueueOrganize)}
                >
                  排到后台
                </button>
              </div>

              {stage === "blocked" && <StatusLine tone="warn">解析未就绪：现在点不会发送请求。</StatusLine>}
              {stage === "failed" && <StatusLine tone="warn">上一次没整理成，可以重试。</StatusLine>}
              {stage === "queued" && jobView !== null && (
                <StatusLine tone="info">
                  后台：{JOB_STATUS_LABEL[jobView.status] ?? jobView.status}
                  {jobView.cancelRequested ? "（已请求取消）" : ""}
                </StatusLine>
              )}

              {outcome !== null && <p className="flash">{outcome}</p>}
              {failure !== null && (
                <FailureSurface plan={failure} busy={busy} onAction={handleFailureAction} />
              )}
            </section>

            {/* 「发送方式」：两轨 / 脱敏方式 / 作用范围 / 技术详情。整层弹窗，不在框里就地展开。 */}
            {methodOpen && preview !== null && (
              <SendMethodDialog
                preview={preview}
                grant={grant}
                track={track}
                recordRedactionMode={selected.axes.redactionMode}
                localLlmUsable={localLlmUsable}
                localLlmWhyNot={localLlmWhyNot}
                busy={busy}
                onSetTrack={(next) =>
                  void action(async () => {
                    // 换轨即换那份要发出去的载荷：旧预览与旧授权都不相干了，先作废再写轴，
                    // 写完由下面那个 `previewKey` 的 effect 重取一份（K-17：模式 ≠ 授权）。
                    setPreview(null);
                    setGrant(null);
                    setConfirmOpen(false);
                    await api.setRecordMode(selected.recordId, modeForTrack(next));
                    await reload();
                    props.onBadgesChanged();
                    setOutcome(trackSwitchedNotice(next));
                  })
                }
                onSetRedactionTier={(next) =>
                  void action(async () => {
                    // 换档即换那一份要发出去的载荷：旧预览与旧授权都不相干了，先作废再写那一列
                    // （与上面换轨同一手法）。失败时 `action` 收错误，记录在册的轴没变 ⇒ 选择
                    // 自然停在原档上，不停在「界面以为切了、库里没切」的半途。
                    setPreview(null);
                    setGrant(null);
                    setConfirmOpen(false);
                    await api.setRecordRedactionMode(selected.recordId, next);
                    await reload();
                    props.onBadgesChanged();
                    setOutcome(tierSwitchedNotice(next));
                  })
                }
                onClose={() => setMethodOpen(false)}
              />
            )}

            {/* 脱敏核对弹窗（D-4）：核对脱敏了哪些；不满意就地「重跑脱敏」，满意就「确认并整理」。 */}
            {reviewOpen && selected !== null && (
              <SendReviewDialog
                preview={preview}
                rawText={rawText}
                track={track}
                busy={busy}
                retrying={busy}
                retryError={failure !== null ? failure.headline : null}
                llmUnusedNotice={
                  track !== "raw" && preview !== null && !preview.llmLayer.used
                    ? llmUnusedNoticeText(preview.llmLayer.failureKind)
                    : null
                }
                onRetryRedaction={
                  track !== "raw" ? () => void retryLocalLlm(selected.recordId) : undefined
                }
                onConfirmAndOrganize={
                  track !== "raw"
                    ? () => void action(() => confirmAndOrganize(selected.recordId))
                    : undefined
                }
                onClose={() => setReviewOpen(false)}
                onDisableEntity={(entityId) =>
                  void action(async () => {
                    // 词表变了，这一版的载荷与哈希就变了：旧预览/旧授权都不再适用，
                    // 清掉本屏的授权并重取一份，用户接着核对新的那一份。
                    await api.entitySetMask(entityId, false);
                    setGrant(null);
                    await loadPreview(selected.recordId);
                    props.onBadgesChanged();
                    setOutcome("已把这个词移出词表；本机模型仍可能在每次整理时重新识别到它。");
                  })
                }
              />
            )}

            {/* 确认这件事本身也是一层确认框：它那两个键是 `m5-3` 逐字钉住的。 */}
            {confirmOpen && (
              <ConfirmDialog
                title={track === "raw" ? "确认发送原文" : "确认本次发送内容"}
                confirmLabel={track === "raw" ? "确认原文并整理" : "确认并整理"}
                cancelLabel="再想想"
                busy={busy}
                onConfirm={() => void action(() => confirmAndOrganize(selected.recordId))}
                onCancel={() => setConfirmOpen(false)}
              >
                {track === "raw" ? (
                  <p>
                    这一条会以<strong>原文完整离开本机</strong>，不做任何脱敏；远端模型会看到全文。
                    确认后立即整理，结果首次会直接生效。
                  </p>
                ) : (
                  <p>确认之后就会按这份内容发送并立即整理；改了原文，这份授权立即作废。</p>
                )}
              </ConfirmDialog>
            )}

            {/* key 里带 processingMode（1B-R 裁决 G-3）：RecordDetail 自带一份 view 状态，
                只在 props.id 变化时重取。换轨改的是同一条记录的档位，id 不变 ⇒ 那一行
                「整理方式：…」会停在旧档位上，直到别的操作才纠正。
                取舍：重挂会丢掉编辑框里未保存的草稿——切轨是显式动作，宁可丢草稿也不显示假档位。 */}
            <RecordDetail
              key={`${selected.recordId}:${selected.processingMode}`}
              id={selected.recordId}
              notify={props.notify}
              clearScope={props.clearScope}
              onEdit={props.onEdit}
              onChanged={() => {
                resetDetail();
                void reload();
                props.onBadgesChanged();
              }}
              onDeleted={(result) => {
                choose(null);
                void reload();
                void feed.reload();
                props.onBadgesChanged();
                setOutcome(deletePhaseMessage(result));
              }}
            />
          </>
        )
      }
    />
  );
}

/* ── 待整理：唯一收件箱（S5） ───────────────────────────────────── */

interface InboxSectionProps {
  /** 已合并、已排序、已去重的行（纯逻辑在 `inbox.ts`）。 */
  readonly rows: readonly InboxRow[];
  /** 本次停留期间刚整理成功的记录（D-9）：顶部画成「已整理成功」行。 */
  readonly completedRows: readonly { readonly recordId: string; readonly title: string }[];
  /** 预跑队列的整体读数（与队列项出自服务端同一次 `snapshot()`）。 */
  readonly prewarm: ReviewQueuePrewarmDto;
  readonly selectedId: string | null;
  readonly onSelect: (id: string) => void;
  /** 重取队列。轮询只调这一条，本组件不自己取数。 */
  readonly onReload: () => void;
  /** 确认一条：走面板那一层那唯一的发送授权通道，本组件不碰 `api.`。 */
  readonly onConfirmOne: (recordId: string) => Promise<void>;
  /** 整理一条：走面板那一层（`api.ingestParse`），成功会记入本地已完成集合。 */
  readonly onOrganizeOne: (recordId: string) => Promise<{ readonly succeeded: boolean; readonly message: string }>;
  /** 这一批跑完之后重读队列与单条预览。 */
  readonly onConfirmed: () => void;
  readonly loading: boolean;
}

/**
 * 一批跑完那一句结果：成了几条，没成的每一条是**哪一版**（`v3`）与**为什么**（封闭集映射的那三句）。
 *
 * 认人只报版本号：够用户认出自己刚勾的那一行，又不是内容。服务端那句 `detail` 不上这一屏。
 */
function batchConfirmOutcomeText(outcome: BatchConfirmOutcome, rows: readonly InboxRow[]): string {
  const head = `已确认 ${outcome.confirmed.length} 条`;
  if (outcome.failed.length === 0) return `${head}。`;
  const parts = outcome.failed.map((failure) => {
    const row = rows.find((item) => item.recordId === failure.recordId);
    return `${row?.title ?? "这一条"}（${BATCH_CONFIRM_FAILURE_TEXT[failure.reason]}）`;
  });
  return `${head}；${outcome.failed.length} 条没成：${parts.join("、")}。`;
}

/** 批量整理那一句结果：整理了几条、跳过几条未确认、哪几条没成（原因）。 */
function batchOrganizeOutcomeText(outcome: BatchOrganizeOutcome, rows: readonly InboxRow[]): string {
  const titleOf = (recordId: string): string =>
    rows.find((row) => row.recordId === recordId)?.title ?? "这一条";
  const parts: string[] = [`已整理 ${outcome.organized.length} 条`];
  if (outcome.skipped.length > 0) parts.push(`跳过 ${outcome.skipped.length} 条未确认`);
  if (outcome.failed.length > 0) {
    const failed = outcome.failed.map(
      (failure) => `${titleOf(failure.recordId)}（${BATCH_ORGANIZE_FAILURE_TEXT[failure.reason]}）`,
    );
    parts.push(`${outcome.failed.length} 条没成：${failed.join("、")}`);
  }
  return `${parts.join("；")}。`;
}

/**
 * 唯一列表：只画「此刻需要动作」的记录 + 本次刚整理成功的行。
 *
 * D-1：行内只留「标题 + 一句状态」；操作与细节都在右侧操作框里。
 * D-2：复选框给可操作行（`selectable`）；批量确认只作用于 `confirmable`，批量整理作用于 `organizable`。
 * D-9：本次停留期间刚整理成功的记录置顶显示为「已整理成功」，离开本页即消失。
 */
function InboxSection(props: InboxSectionProps): React.ReactNode {
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [progress, setProgress] = useState<{ index: number; total: number } | null>(null);
  const [result, setResult] = useState<string | null>(null);
  /** 批量整理前的三选一（勾选里混有未确认时）：D-3。 */
  const [organizePlan, setOrganizePlan] = useState<{
    readonly targets: readonly BatchOrganizeTarget[];
    readonly needsConfirm: number;
  } | null>(null);

  const confirmPicked = props.rows
    .filter((row) => row.confirmable && checked[row.recordId] === true)
    .map((row) => row.recordId);
  const organizePicked = props.rows.filter((row) => row.organizable && checked[row.recordId] === true);
  const running = progress !== null;

  // 有得等才轮询（M10-D-13）：归零或卸载即清计时器。
  useEffect(() => {
    if (props.prewarm.pending <= 0) return;
    const timer = setInterval(() => props.onReload(), REVIEW_QUEUE_POLL_MS);
    return () => clearInterval(timer);
  }, [props.prewarm.pending, props.onReload]);

  async function runBatchConfirm(): Promise<void> {
    const known = props.rows;
    // 上一批那句结果先抹掉：留着旧结果挂在还没跑完的这一批头上，说的是谎。
    setResult(null);
    const outcome = await confirmReviewEntries(confirmPicked, {
      confirm: props.onConfirmOne,
      onProgress: (_recordId, index, total) => setProgress({ index, total }),
    });
    setProgress(null);
    setChecked({});
    setResult(batchConfirmOutcomeText(outcome, known));
    props.onConfirmed();
  }

  async function executeBatchOrganize(
    targets: readonly BatchOrganizeTarget[],
    mode: BatchOrganizeMode,
  ): Promise<void> {
    const known = props.rows;
    setOrganizePlan(null);
    const outcome = await runBatchOrganize(targets, mode, {
      confirm: (recordId) => props.onConfirmOne(recordId),
      organize: (recordId) => props.onOrganizeOne(recordId),
      onProgress: (_recordId, index, total) => setProgress({ index, total }),
    });
    setProgress(null);
    setChecked({});
    setResult(batchOrganizeOutcomeText(outcome, known));
    props.onConfirmed();
  }

  function startBatchOrganize(): void {
    const targets: BatchOrganizeTarget[] = organizePicked.map((row) => ({
      recordId: row.recordId,
      needsConfirm: !row.hasGrant,
    }));
    const summary = summarizeBatchOrganize(targets);
    if (summary.total === 0) return;
    setResult(null);
    if (summary.needsConfirm === 0) {
      void executeBatchOrganize(targets, "confirm-and-organize");
      return;
    }
    setOrganizePlan({ targets, needsConfirm: summary.needsConfirm });
  }

  return (
    <section className="card">
      <h2>待整理（{props.rows.length}）</h2>
      {props.prewarm.pending > 0 && (
        <StatusLine tone="info">{prewarmPendingText(props.prewarm.pending)}</StatusLine>
      )}
      {props.loading ? (
        <p className="hint">读取中…</p>
      ) : props.rows.length === 0 && props.completedRows.length === 0 ? (
        <p className="hint">没有需要你处理的记录。</p>
      ) : (
        <ul className="list">
          {props.completedRows.map((row) => (
            <li key={`done-${row.recordId}`} style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
              <button
                className="row-btn"
                style={
                  row.recordId === props.selectedId ? { flex: 1, background: SELECTED_BACKGROUND } : { flex: 1 }
                }
                onClick={() => props.onSelect(row.recordId)}
              >
                <span className="row-title">{row.title}</span>
                <span className="row-meta">已整理成功</span>
              </button>
            </li>
          ))}
          {props.rows.map((row) => (
            <li key={row.recordId} style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
              {row.selectable && (
                <label className="row-meta" title="勾选后可批量确认或批量整理">
                  <input
                    type="checkbox"
                    checked={checked[row.recordId] === true}
                    disabled={running}
                    onChange={() =>
                      setChecked((previous) => ({
                        ...previous,
                        [row.recordId]: previous[row.recordId] !== true,
                      }))
                    }
                  />
                </label>
              )}
              <button
                className="row-btn"
                style={
                  row.recordId === props.selectedId ? { flex: 1, background: SELECTED_BACKGROUND } : { flex: 1 }
                }
                onClick={() => props.onSelect(row.recordId)}
              >
                <span className="row-title">{row.title}</span>
                <span className="row-meta">{row.meta}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <p className="hint">只保存的记录不进这里；在记录详情里可以单独整理。</p>

      <div className="actions">
        <button
          className="btn primary"
          disabled={running || confirmPicked.length === 0}
          onClick={() => void runBatchConfirm()}
        >
          {confirmPicked.length === 0 ? "确认选中的记录" : `确认选中的 ${confirmPicked.length} 条`}
        </button>
        <button
          className="btn"
          disabled={running || organizePicked.length === 0}
          onClick={() => startBatchOrganize()}
        >
          {organizePicked.length === 0 ? "批量发起整理" : `批量发起整理（${organizePicked.length} 条）`}
        </button>
        {progress !== null && (
          <StatusLine tone="info">
            正在处理第 {progress.index}/{progress.total} 条…
          </StatusLine>
        )}
      </div>
      {result !== null && <p className="flash">{result}</p>}

      {organizePlan !== null && (
        <ConfirmDialog
          title="批量发起整理"
          confirmLabel="确认并整理"
          cancelLabel="取消"
          busy={running}
          onConfirm={() => {
            const plan = organizePlan;
            if (plan !== null) void executeBatchOrganize(plan.targets, "confirm-and-organize");
          }}
          onCancel={() => setOrganizePlan(null)}
        >
          <p>其中 {organizePlan.needsConfirm} 条还没确认要发出去的内容（外发会离开本机）。</p>
          <p>「确认并整理」会为它们各签一张授权再整理；「只整理已确认」跳过这 {organizePlan.needsConfirm} 条。</p>
          <div className="actions">
            <button
              className="btn"
              type="button"
              disabled={running}
              onClick={() => {
                const plan = organizePlan;
                if (plan !== null) void executeBatchOrganize(plan.targets, "organize-confirmed-only");
              }}
            >
              只整理已确认（跳过 {organizePlan.needsConfirm} 条）
            </button>
          </div>
        </ConfirmDialog>
      )}
    </section>
  );
}

/* ── 云端路径的中间带（只吃 props；取数在面板那一层） ── */

interface CloudGateProps {
  readonly preview: SendPreviewDto | null;
  readonly grant: GrantDto | null;
  /** 这一条此刻在哪一轨：由父面板从**记录轴**派生（`trackOfAxes(selected.axes)`），不读默认值。 */
  readonly track: SendTrack;
  /** 这一条在册的 `redaction_mode`：只用来判断「本机模型这一档跑没跑成」。 */
  readonly recordRedactionMode: string;
  readonly previewPendingSince: number | null;
  /** 打开「这次发送要确认的东西」弹窗（遮蔽清单 + 待确认名字）。 */
  readonly onOpenReview: () => void;
  /** 打开「发送方式」弹窗（两轨 / 脱敏方式 / 作用范围 / 技术详情）。 */
  readonly onOpenMethod: () => void;
}

/**
 * 云端这一条的**中间带**（〔web-redesign 第三步〕），两条：
 *
 *   ① 要发出去的东西：一行小标 + 正文 + 一行「待确认：遮 N 处 · M 个名字待审」（点了开弹窗）
 *   ② 这一次怎么发：一行摘要（点了开**弹窗**，不在框里就地展开）
 *
 * 这一层不画任何控件：两条入口各自开一层弹窗。框里因此永远只有
 * 「阶段名 → 发什么 → 怎么发 → 一个动作」四行，长原文也顶不掉动作行。
 */
function CloudGate(props: CloudGateProps): React.ReactNode {
  const { preview, track } = props;
  const tier = redactionTierOfMode(props.recordRedactionMode);
  const waited = useElapsedSeconds(props.previewPendingSince);
  const checkingLlm = preview === null && props.previewPendingSince !== null && tier === "local_llm";

  if (preview === null) {
    // `loading` 是自动取预览的那几秒，用户不需要点任何东西。
    return (
      <p className="hint">
        {checkingLlm ? llmCheckingText(waited) : "正在本机取这份要发出去的内容…"}
      </p>
    );
  }

  const tierLabel = track === "raw" ? "不脱敏" : (REDACTION_TIER_LABEL[tier ?? "manual"] ?? "");
  const summary = `发送方式：${SEND_TRACK_LABEL[track]}${tierLabel === "" ? "" : ` · ${tierLabel}`}`;

  return (
    <>
      <p className="ingest-caption">实际发送文本</p>
      <div className="ingest-payload">
        <pre className="record-text">{preview.payloadText}</pre>
      </div>

      {preview.spans.length > 0 ? (
        <button className="ingest-review" onClick={props.onOpenReview}>
          脱敏了 {preview.spans.length} 处 · 确认具体信息 ▸
        </button>
      ) : (
        <p className="hint">没有需要脱敏的地方</p>
      )}

      {props.grant !== null && (
        <p className="hint">本次发送已确认；改动原文后，这条授权立即失效。</p>
      )}

      <button className="ingest-method-link" onClick={props.onOpenMethod}>
        <span>{summary}</span>
        <ChevronRight className="ingest-method-chevron" aria-hidden="true" size={16} />
      </button>
    </>
  );
}
