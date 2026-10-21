import { useCallback, useEffect, useState } from "react";

import { api, ApiError, type RecordDetailData } from "./apiClient.ts";
import { effectiveLines, evidencePhrase, monthDayOf, readableResult } from "./projections.ts";
import { processingModeChoices } from "./projectionPort.ts";
import { DisclosureNote, EvidenceLine, KeyValue, StatusLine, TechnicalDetails } from "./ui/bits.tsx";
import { MODE_LABEL, STATUS_LABEL } from "./ui/labels.ts";
import { SourceText } from "./ui/SourceText.tsx";
import type { ReadableResultGroup } from "./projections.ts";
import type {
  DeletePhaseResult,
  EffectiveEvidenceDto,
  EffectiveResultDto,
  IngestRunDto,
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

/** 一次操作的回话。语气决定界面用 `flash` 还是 `warn` 显示。 */
interface ActionOutcome {
  readonly tone: "ok" | "warn";
  readonly text: string;
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
}

export function RecordDetail(props: RecordDetailProps): React.ReactNode {
  const [view, setView] = useState<DetailView>({ kind: "loading" });
  const [result, setResult] = useState<ResultView>({ kind: "loading" });
  // 现在要高亮回原文的那一段证据。null = 没点过，原文按整段画。
  const [jump, setJump] = useState<EffectiveEvidenceDto | null>(null);
  const [candidateBusy, setCandidateBusy] = useState(false);
  const [candidateOutcome, setCandidateOutcome] = useState<ActionOutcome | null>(null);

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
  }, [props.id, loadResult]);

  if (view.kind === "loading") return <p className="hint">加载详情中…</p>;
  if (view.kind === "error") return <p className="warn">{view.message}</p>;

  const { record, current, revisions } = view.data;

  async function saveEdit(text: string): Promise<ActionOutcome> {
    const saved = await api.editRecord(record.id, text);
    if (!saved.changed) return { tone: "warn", text: "原文没有变化，未创建新版本。" };
    props.onChanged();
    const refreshed = await api.getRecord(record.id);
    setView({ kind: "ready", data: refreshed });
    void loadResult(refreshed.current.id);
    return { tone: "ok", text: `已保存为新版本 v${saved.revision.revision_number}。` };
  }

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

  async function runOnCandidate(action: () => Promise<ActionOutcome>): Promise<void> {
    setCandidateBusy(true);
    setCandidateOutcome(null);
    try {
      setCandidateOutcome(await action());
    } catch (cause) {
      // 服务端点名的原因（如「只有 candidate 结果态可被采纳：当前 current」）原样显示，界面不替它猜。
      setCandidateOutcome({
        tone: "warn",
        text: cause instanceof ApiError ? cause.detail : "操作失败，这一份候选的结果态没有变化。",
      });
    } finally {
      setCandidateBusy(false);
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

  return (
    <div className="detail-page">
      <SourceSection
        record={record}
        current={current}
        revisions={revisions}
        highlight={jump}
        onSave={saveEdit}
        onSaveMode={changeMode}
        onReparse={reparse}
        onDelete={removeRecord}
      />
      <ResultSection
        result={result}
        highlight={jump}
        onJump={setJump}
        busy={candidateBusy}
        outcome={candidateOutcome}
        onAdopt={(runId) => void runOnCandidate(() => adoptCandidate(runId))}
        onDiscard={(runId) => void runOnCandidate(() => discardCandidate(runId))}
      />
    </div>
  );
}

/* ── 原文那一块（只吃 props，自己只管开合编辑器/确认删除这类本地界面状态） ── */

interface SourceSectionProps {
  readonly record: RecordRow;
  readonly current: RevisionRow;
  readonly revisions: readonly RevisionRow[];
  /** 现在要高亮回原文的那一段证据（点整理结果里的证据行传下来）。 */
  readonly highlight: EffectiveEvidenceDto | null;
  readonly onSave: (text: string) => Promise<ActionOutcome>;
  /** M5-1：改这一条的处理模式（PATCH /api/records/:id/mode）。 */
  readonly onSaveMode: (mode: string) => Promise<ActionOutcome>;
  readonly onReparse: () => Promise<ActionOutcome>;
  /** 成功即由父层换页；失败必须抛出，这一层才能如实显示「记录仍在」。 */
  readonly onDelete: () => Promise<void>;
}

function SourceSection(props: SourceSectionProps): React.ReactNode {
  const { record, current } = props;
  const [editorOpen, setEditorOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<ActionOutcome | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [modeDraft, setModeDraft] = useState(record.processing_mode);

  // 切到另一条记录、或模式刚被服务端改过：草稿跟回在册值，不拿旧选择冒充新状态。
  useEffect(() => {
    setModeDraft(record.processing_mode);
  }, [record.id, record.processing_mode]);

  const dirty = draft !== current.raw_text;

  async function run(action: () => Promise<ActionOutcome>): Promise<void> {
    setBusy(true);
    setFailure(null);
    setOutcome(null);
    try {
      setOutcome(await action());
    } catch (cause) {
      setFailure(cause instanceof ApiError ? cause.detail : "操作失败");
    } finally {
      setBusy(false);
    }
  }

  async function save(): Promise<void> {
    await run(async () => {
      const saved = await props.onSave(draft);
      if (saved.tone === "ok") setEditorOpen(false);
      return saved;
    });
  }

  async function confirmDelete(): Promise<void> {
    setDeleting(true);
    setDeleteError(null);
    try {
      await props.onDelete();
    } catch (cause) {
      setDeleteError(cause instanceof ApiError ? cause.detail : "删除请求失败（记录仍在）");
      setConfirmingDelete(false);
    } finally {
      setDeleting(false);
    }
  }

  return (
    <>
      <section className="detail-primary">
        <div className="detail-heading">
          <h2>原文</h2>
          <p className="detail-status">
            {monthDayOf(record.created_at_local).replace("T", " ")} ·{" "}
            {STATUS_LABEL[record.processing_status] ?? record.processing_status}
            {record.privacy_level === "sensitive" && <span className="badge warn-badge">敏感</span>}
          </p>
        </div>

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
        <p className="detail-version">v{current.revision_number}</p>

        <div className="actions detail-actions">
          <button
            className="btn"
            disabled={editorOpen || busy}
            onClick={() => {
              setEditorOpen(true);
              setDraft(current.raw_text);
            }}
          >
            编辑原文
          </button>
          <button className="btn" disabled={busy} onClick={() => void run(props.onReparse)}>
            重新整理
          </button>
        </div>

        {outcome !== null &&
          (outcome.tone === "ok" ? <p className="flash">{outcome.text}</p> : <p className="warn">{outcome.text}</p>)}
        {failure !== null && <p className="warn">{failure}</p>}

        {editorOpen && (
          <div className="detail-editor">
            <textarea rows={6} value={draft} onChange={(e) => setDraft(e.target.value)} />
            <div className="actions">
              <button className="btn primary" disabled={busy || !dirty} onClick={() => void save()}>
                {busy ? "保存中…" : "保存为新版本"}
              </button>
              <button className="btn" disabled={busy} onClick={() => setEditorOpen(false)}>
                取消
              </button>
              {!dirty && <span className="hint">内容与当前版本一致，保存不会产生新版本。</span>}
            </div>
            <p className="hint">
              改原文<strong>不会</strong>自动重新整理；旧结果会保留，但状态会变为「原文已改，待重新整理」。
            </p>
          </div>
        )}

        <DisclosureNote summary={`整理方式：${MODE_LABEL[record.processing_mode] ?? record.processing_mode}`}>
          <ul className="list">
            {processingModeChoices().map((choice) => (
              <li key={choice.key} className="item">
                <label className="row-btn">
                  <input
                    type="radio"
                    name={`detail-mode-${record.id}`}
                    checked={modeDraft === choice.key}
                    disabled={busy}
                    onChange={() => setModeDraft(choice.key)}
                  />
                  <span className="row-title">{choice.label}</span>
                  <span className="row-meta">
                    {choice.key === record.processing_mode
                      ? "（在册当前值）"
                      : modeDraft === choice.key
                        ? "（保存后生效）"
                        : ""}
                  </span>
                </label>
              </li>
            ))}
          </ul>
          <div className="actions">
            <button
              className="btn"
              disabled={busy || modeDraft === record.processing_mode}
              onClick={() => void run(() => props.onSaveMode(modeDraft))}
            >
              保存模式
            </button>
          </div>
          <p className="hint">改模式不会自动发起整理；首次发送前仍要在「待整理」页逐次确认。</p>
        </DisclosureNote>

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

        <TechnicalDetails
          rows={[
            ["记录编号", record.id],
            ["时区", record.timezone_id],
            ["版本编号", current.id],
            ["内容指纹", `${current.content_sha256.slice(0, 12)}…`],
          ]}
        />
      </section>

      <section className="danger-zone">
        <h3>删除记录</h3>
        <p className="hint">删除后无法从当前界面撤销。</p>
        <button
          className="btn danger"
          disabled={confirmingDelete || busy}
          onClick={() => setConfirmingDelete(true)}
        >
          删除记录
        </button>

        {confirmingDelete && (
          <div className="confirm">
            <p>
              确认删除这条记录及其<strong>全部历史版本</strong>？
              删除将从当前数据库中移除记录，且无法从当前界面撤销。
              旧备份中可能仍存在这些内容（恢复旧备份会将其带回）。
            </p>
            {deleteError !== null && <p className="warn">{deleteError}</p>}
            <div className="actions">
              <button className="btn danger" disabled={deleting} onClick={() => void confirmDelete()}>
                {deleting ? "删除中…" : "确认删除"}
              </button>
              <button className="btn" disabled={deleting} onClick={() => setConfirmingDelete(false)}>
                取消
              </button>
            </div>
          </div>
        )}
      </section>
    </>
  );
}

/* ── 整理结果那一块（可读行 + 证据回原文 + 采纳/放弃候选） ── */

interface ResultSectionProps {
  readonly result: ResultView;
  readonly highlight: EffectiveEvidenceDto | null;
  readonly onJump: (evidence: EffectiveEvidenceDto) => void;
  readonly busy: boolean;
  readonly outcome: ActionOutcome | null;
  readonly onAdopt: (runId: string) => void;
  readonly onDiscard: (runId: string) => void;
}

function ResultSection(props: ResultSectionProps): React.ReactNode {
  const { result } = props;
  // 只有取到结果那两种状态才有可读行可言（loading / unready / error 时这栏压根不该出现）。
  const groups = result.kind === "none" || result.kind === "ready" ? readableResult(result.effective) : [];
  return (
    <section className="detail-result">
      <h2>整理结果</h2>

      {result.kind === "loading" && <p className="hint">读取中…</p>}

      {result.kind === "unready" && (
        <>
          <StatusLine tone="warn">解析未就绪：模型没有装配，这一层现在取不到整理结果。</StatusLine>
          <p className="row-meta">未就绪只影响派生内容 —— 上面的原文完好无损。</p>
        </>
      )}

      {result.kind === "error" && <p className="warn">{result.message}</p>}

      {result.kind === "none" && (
        <p className="hint">这条记录还没有整理结果。到「待整理」里发起一次。</p>
      )}

      {result.kind === "ready" && (
        <>
          <ResultRun run={result.run} />
          <ResultSummary effective={result.effective} />

          <CandidateActions
            effective={result.effective}
            busy={props.busy}
            onAdopt={props.onAdopt}
            onDiscard={props.onDiscard}
          />
          {props.outcome !== null &&
            (props.outcome.tone === "ok" ? (
              <p className="flash">{props.outcome.text}</p>
            ) : (
              <p className="warn">{props.outcome.text}</p>
            ))}

          <DisclosureNote summary="查看整理详情">
            <ResultReadable groups={groups} onJump={props.onJump} />
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

function ResultRun(props: { readonly run: IngestRunDto }): React.ReactNode {
  const { run } = props;
  const stateLabel =
    run.executionStatus === "failed"
      ? "整理失败"
      : run.resultState === "candidate"
        ? "等待你表态"
        : run.resultState === "superseded"
          ? "已被取代"
          : "已整理";
  return (
    <>
      <p className="detail-run-state">当前状态：{stateLabel}</p>
      {run.executionStatus === "failed" && (
        <p className="warn">
          整理失败。<strong>原文完好无损</strong> —— 失败路径下也不会丢原文。
        </p>
      )}
    </>
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

/** 可读行：按类别分组，每行「词面 → 标准名」加一行元信息，再挂上那个能点回原文的证据。 */
function ResultReadable(props: {
  readonly groups: readonly ReadableResultGroup[];
  readonly onJump: (evidence: EffectiveEvidenceDto) => void;
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
            {group.lines.map((line) => (
              <li key={line.id} className="item">
                <span className="row-title">{line.title}</span>
                <span className="row-meta">{line.meta}</span>
                <EvidenceJump evidence={line.evidence} onJump={props.onJump} />
              </li>
            ))}
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
 */
function CandidateActions(props: {
  readonly effective: EffectiveResultDto;
  readonly busy: boolean;
  readonly onAdopt: (runId: string) => void;
  readonly onDiscard: (runId: string) => void;
}): React.ReactNode {
  const candidates = props.effective.candidates;
  if (candidates.length === 0) return null;
  const history = new Map((props.effective.runHistory ?? []).map((item) => [item.runId, item]));
  return (
    <div className="candidate-panel">
      <h3>有 {candidates.length} 份候选结果等你表态</h3>
      <p className="hint">候选还没有进入当前视图；采纳或放弃都不删除历史。</p>
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
                <button className="btn" disabled={props.busy} onClick={() => props.onDiscard(candidate.runId)}>
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
