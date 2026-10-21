import { useCallback, useEffect, useState } from "react";

import { ApiError, api } from "./apiClient.ts";
import { deletePhaseMessage, firstLine } from "./projections.ts";
import { RecordDetail } from "./RecordDetail.tsx";
import { RecordList } from "./RecordList.tsx";
import { ListDetail } from "./ui/ListDetail.tsx";
import { ENTITY_TYPE_LABEL, ENUM_VALUES, MODE_LABEL, STATUS_LABEL } from "./ui/labels.ts";
import { DisclosureNote, StatusLine, TechnicalDetails, useIsNarrow } from "./ui/bits.tsx";
import { useRecords } from "./useRecords.ts";
import type {
  GrantDto,
  ModelPrivacyConfigDto,
  PendingRecordDto,
  SendPreviewCandidateDto,
  SendPreviewDto,
} from "../shared/dto.ts";

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
}

const CLOUD_REAUTH_MESSAGE = "缺本次发送授权：这次发送需要重新确认，请先查看实际发送文本。";

function ingestErrorMessage(cause: unknown): string {
  if (cause instanceof ApiError && cause.status === 409) return CLOUD_REAUTH_MESSAGE;
  return cause instanceof ApiError ? cause.detail : "操作失败";
}

export function IngestPanel(props: IngestPanelProps): React.ReactNode {
  const narrow = useIsNarrow();
  const feed = useRecords();
  const [config, setConfig] = useState<ModelPrivacyConfigDto | null>(null);
  const [pending, setPending] = useState<readonly PendingRecordDto[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorDetail, setErrorDetail] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);

  const [preview, setPreview] = useState<SendPreviewDto | null>(null);
  const [grant, setGrant] = useState<GrantDto | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const reload = useCallback(async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setErrorDetail(null);
    try {
      const [cfg, list] = await Promise.all([api.ingestConfig(), api.ingestPending()]);
      setConfig(cfg);
      setPending(list.records);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.detail : "加载待处理记录失败");
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void reload();
    void feed.reload();
  }, [reload, feed.reload]);

  /** 换一条记录，上一份预览与授权就不相干了 —— 必须清空，不然显示的是别的版本的内容。 */
  const resetDetail = useCallback(() => {
    setPreview(null);
    setGrant(null);
    setConfirmOpen(false);
    setOutcome(null);
    setError(null);
    setErrorDetail(null);
  }, []);

  function choose(id: string | null): void {
    props.onSelect(id);
    resetDetail();
  }

  async function action(run: () => Promise<void>): Promise<void> {
    setBusy(true);
    setError(null);
    setErrorDetail(null);
    setOutcome(null);
    try {
      await run();
    } catch (cause) {
      setError(ingestErrorMessage(cause));
      setErrorDetail(cause instanceof ApiError && cause.status === 409 ? cause.detail : null);
    } finally {
      setBusy(false);
    }
  }

  // 宽屏没选中就落到第一条，详情栏永远有内容；窄屏只有用户点过才算选中。
  // 选中的 id 不在待整理里（比如从「全部记录」带过来的）也算没选中，不会假装它是待整理的。
  const selected =
    pending.find((row) => row.recordId === props.selectedId) ??
    (narrow ? null : (pending[0] ?? null));

  const parseReady = config?.ingestReady === true;
  const cloudNeedsConfirmation =
    selected?.processingMode === "cloud_redacted" && preview?.hasApplicableGrant !== true;
  const canStartOrganize =
    parseReady && (selected?.processingMode !== "cloud_redacted" || preview?.hasApplicableGrant === true);
  const selectedRevisionId = selected?.currentRevisionId ?? null;
  const previewRevisionId = preview?.recordRevisionId ?? null;

  useEffect(() => {
    if (selectedRevisionId === null || previewRevisionId === null) return;
    if (selectedRevisionId === previewRevisionId) return;
    setPreview(null);
    setGrant(null);
    setConfirmOpen(false);
  }, [previewRevisionId, selectedRevisionId]);

  return (
    <ListDetail
      hasSelection={selected !== null}
      onBack={() => choose(null)}
      list={
        <>
          {error !== null && selected === null && <p className="warn">{error}</p>}

          <section className="card">
            <h2>待整理（{pending.length}）</h2>
            <p className="hint">待发送、待重跑和整理失败的记录都在这里。不推送、不催办。</p>
            {busy && pending.length === 0 ? (
              <p className="hint">读取中…</p>
            ) : (
              <RecordList
                rows={pending.map((row) => ({
                  id: row.recordId,
                  title: firstLine(row.preview === "" ? "（无内容）" : row.preview, 40),
                  meta: `${STATUS_LABEL[row.processingStatus] ?? row.processingStatus} · ${
                    MODE_LABEL[row.processingMode] ?? row.processingMode
                  }`,
                }))}
                selectedId={selected?.recordId ?? null}
                onSelect={choose}
                emptyText="没有待整理的记录。"
              />
            )}
            <p className="hint">只保存的记录不会进入待整理。</p>
          </section>

          <section className="card">
            <h2>本机状态</h2>
            {config === null ? (
              <p className="hint">{error ?? "读取中…"}</p>
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
        selected === null ? (
          <section className="card">
            <h2>操作</h2>
            <p className="hint">左边选一条记录。</p>
          </section>
        ) : (
          <>
            <section className="card">
              <h2>操作</h2>
              <p className="row-meta">
                {STATUS_LABEL[selected.processingStatus] ?? selected.processingStatus} ·{" "}
                {MODE_LABEL[selected.processingMode] ?? selected.processingMode}
                {selected.privacyLevel === "sensitive" && <span className="badge warn-badge">敏感</span>}
                {preview?.hasApplicableGrant === true && (
                  <span className="badge ok">本次发送已授权</span>
                )}
              </p>

              {selected.processingMode === "cloud_redacted" && (
                <CloudGate
                  busy={busy}
                  preview={preview}
                  grant={grant}
                  confirmOpen={confirmOpen}
                  onPreview={() =>
                    void action(async () => {
                      setPreview(null);
                      setGrant(null);
                      setPreview(await api.ingestPreview({ recordId: selected.recordId }));
                    })
                  }
                  onAskConfirm={() => setConfirmOpen(true)}
                  onCancelConfirm={() => setConfirmOpen(false)}
                  onConfirm={() =>
                    void action(async () => {
                      const confirmed = await api.ingestConfirmSend({ recordId: selected.recordId });
                      setGrant(confirmed);
                      // 授权状态以最新预览为准；确认成功后重新取一次，避免界面自己猜。
                      setPreview(await api.ingestPreview({ recordId: selected.recordId }));
                      setConfirmOpen(false);
                      setOutcome("已确认这一份发送内容。改了原文，这条授权会立即失效。");
                    })
                  }
                  onConfirmCandidates={(adopted) =>
                    void action(async () => {
                      setPreview(null);
                      setGrant(null);
                      await api.ingestConfirmCandidates({ recordId: selected.recordId, adopted });
                      // 确认后进词表：重新取一份预览，该词即被既有通道遮掉（第二次出现自动遮）。
                      setPreview(await api.ingestPreview({ recordId: selected.recordId }));
                      setOutcome(
                        `已把 ${adopted.length} 个词确认进本机词表（本机完成，未调用模型）。这几个词下次出现会自动遮起来。`,
                      );
                    })
                  }
                />
              )}

              <div className="actions">
                <button
                  className="btn primary"
                  disabled={busy || !canStartOrganize}
                  onClick={() =>
                    void action(async () => {
                      const parsed = await api.ingestParse({ recordId: selected.recordId });
                      setOutcome(
                        parsed.succeeded
                          ? `已整理：写入 经历 ${parsed.writes.episodes} · 念头 ${parsed.writes.thoughts} · 提及 ${
                              parsed.writes.mentions
                            }（被拒 ${parsed.writes.rejectedMentions}）${
                              parsed.replayed ? " · 已有同样结果，未重复产出" : ""
                            }。`
                          : `整理未成功：${parsed.failure?.message ?? "服务端未给出原因。"} 原文完好无损。`,
                      );
                      props.onBadgesChanged();
                      await reload();
                    })
                  }
                >
                  {busy ? "处理中…" : "发起整理"}
                </button>
                {!parseReady ? (
                  <StatusLine tone="warn">解析未就绪：现在点不会发送请求。</StatusLine>
                ) : cloudNeedsConfirmation ? (
                  <StatusLine tone="warn">{CLOUD_REAUTH_MESSAGE}</StatusLine>
                ) : null}
              </div>

              {outcome !== null && <p className="flash">{outcome}</p>}
              {error !== null && <p className="warn">{error}</p>}
              {errorDetail !== null && (
                <TechnicalDetails rows={[["服务端原文", errorDetail]]} />
              )}
            </section>

            <RecordDetail
              id={selected.recordId}
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

/* ── 云端路径的授权闸门（只吃 props；取数在面板那一层） ── */

interface CloudGateProps {
  readonly busy: boolean;
  readonly preview: SendPreviewDto | null;
  readonly grant: GrantDto | null;
  readonly confirmOpen: boolean;
  readonly onPreview: () => void;
  readonly onAskConfirm: () => void;
  readonly onCancelConfirm: () => void;
  readonly onConfirm: () => void;
  readonly onConfirmCandidates: (adopted: { term: string; kind: string }[]) => void;
}

/**
 * 原型的这一段画了三件事，这里逐条对得上：
 * 1. 要看的是**实际发出去的那份文本**，不是原文；
 * 2. 占位符 → 原词的映射**留在本机**（服务端的 `SendPreviewDto` 本来就不带这张表）；
 * 3. 授权绑定这一个版本 —— 改了原文就得重新确认。
 *
 * M3-RED-1 又添了第四件：**陌生名字候选**。规则只猜、不自动遮；用户在预览里做减法
 * （对的留下、错的划掉、类型猜错可改），确认的词才落 provisional 实体、下次出现自动遮。
 * 跳过的词按原样发 —— 这一段同时是丁（如实告知「哪些将原样外发」）的落点。
 *
 * 候选的选取与编辑是**组件本地状态**（数据仍从 props 的 preview 来）；写操作只经
 * `onConfirmCandidates` 回调交回面板那层去取数，本组件不读全局、不自己 fetch。
 */
function CloudGate(props: CloudGateProps): React.ReactNode {
  const { preview, grant } = props;
  const revisionId = preview?.recordRevisionId ?? "";
  const candidates: readonly SendPreviewCandidateDto[] = preview?.candidates ?? [];
  // 换一条记录 / 新版本，候选的勾选与类型改判作废重来（按 revision 重置本地态）。
  const [skipped, setSkipped] = useState<Record<string, boolean>>({});
  const [kinds, setKinds] = useState<Record<string, string>>({});
  const [scopeId, setScopeId] = useState(revisionId);
  if (scopeId !== revisionId) {
    setScopeId(revisionId);
    setSkipped({});
    setKinds({});
  }

  const adopted = candidates
    .filter((c) => skipped[c.term] !== true)
    .map((c) => ({ term: c.term, kind: kinds[c.term] ?? c.suggestedKind }));
  const sendingRaw = candidates.filter((c) => skipped[c.term] === true).map((c) => c.term);

  return (
    <section className="card">
      <h3>这条要发到云端，先看清楚发的是什么</h3>
      {preview === null ? (
        <>
          <StatusLine>先在本机查看实际发送文本；这一步不会发送。</StatusLine>
          <div className="actions">
            <button className="btn" disabled={props.busy} onClick={props.onPreview}>
              查看实际待发送文本
            </button>
          </div>
        </>
      ) : (
        <>
          <StatusLine tone={preview.hasApplicableGrant ? "info" : "warn"}>
            {preview.hasApplicableGrant ? "这份发送内容已确认过" : "这份发送内容还没有确认"}
          </StatusLine>
          <pre className="record-text">{preview.payloadText}</pre>
          <p className="hint">
            这才是<strong>实际发出去的文本</strong>，不是你写的原文；占位符与原词的对照表只留在本机。
          </p>

          <TechnicalDetails
            rows={[
              ["策略版本", preview.policyVersion],
              ["原文版本", `v${preview.revisionNumber}`],
              ["原文 revision", preview.recordRevisionId],
              ["内容指纹", `${preview.payloadSha256.slice(0, 12)}…`],
              ...(grant === null
                ? []
                : ([
                    ["授权编号", grant.grantId],
                    ["授权策略", grant.policyVersion],
                    ["授权确认于", grant.confirmedAtUtc],
                  ] as (readonly [string, string])[])),
            ]}
          />

          <section className="candidate-review">
            <h4>陌生名字候选（需要你确认的新名字）</h4>
            {candidates.length === 0 ? (
              <p className="hint">规则没在这段里猜到需要你先确认的新名字。已确认过的词已按代号遮好了。</p>
            ) : (
              <ul className="list">
                {candidates.map((c) => {
                  const isSkipped = skipped[c.term] === true;
                  const kind = kinds[c.term] ?? c.suggestedKind;
                  return (
                    <li key={c.term} className="item">
                      <label>
                        <input
                          type="checkbox"
                          checked={!isSkipped}
                          disabled={props.busy}
                          onChange={() => setSkipped((prev) => ({ ...prev, [c.term]: !isSkipped }))}
                        />
                        <mark className="candidate-term">{c.term}</mark>
                      </label>
                      <span className="row-meta">依据 {c.basis || "规则猜测"}</span>
                      <select
                        aria-label={`${c.term} 的类型`}
                        value={kind}
                        disabled={isSkipped || props.busy}
                        onChange={(e) => setKinds((prev) => ({ ...prev, [c.term]: e.target.value }))}
                      >
                        {ENUM_VALUES.entityTypes.map((k) => (
                          <option key={k} value={k}>
                            {ENTITY_TYPE_LABEL[k] ?? k}
                          </option>
                        ))}
                      </select>
                    </li>
                  );
                })}
              </ul>
            )}
            {/* 如实告知：这次哪些词将原样外发 —— 跳过即不遮，这是发送决定的一部分，不许折叠。 */}
            <p className="warn candidate-disclosure">
              跳过的词会随本次发送<strong>原样发出去</strong>：
              {sendingRaw.length === 0 ? "（无）" : ` ${sendingRaw.join("、")} `}——跳过 = 不遮 = 风险自负；脱敏不等于匿名化。
            </p>
            <div className="actions">
              <button
                className="btn"
                disabled={props.busy || adopted.length === 0}
                onClick={() => props.onConfirmCandidates(adopted)}
              >
                确认这批遮起来
              </button>
            </div>
            <DisclosureNote summary="说明">
              <p className="hint">
                候选只是规则的猜测，你只需做减法：对的留下、错的划掉，类型猜错可以改。
                确认选中的词只写进本机词表（本机完成，不调用任何模型），下次出现才会自动遮 ——
                这一次发送里它们仍是原词。
              </p>
            </DisclosureNote>
          </section>

          <p className="warn">
            ⚠️ 脱敏<strong>不等于</strong>匿名化，也<strong>不保证</strong>识别出所有人名 ——
            规则猜不中的陌生名字，只有你在这里确认过才会被遮；漏掉的靠你这屏肉眼兜底。
          </p>
          <div className="actions">
            {grant !== null ? (
              <span className="flash">本次发送已确认；改动原文后，这条授权立即失效。</span>
            ) : props.confirmOpen ? (
              <>
                <button className="btn danger" disabled={props.busy} onClick={props.onConfirm}>
                  确认，就按这份内容发送
                </button>
                <button className="btn" disabled={props.busy} onClick={props.onCancelConfirm}>
                  再想想
                </button>
              </>
            ) : (
              <button className="btn" disabled={props.busy} onClick={props.onAskConfirm}>
                确认本次发送内容
              </button>
            )}
            <button className="btn" disabled={props.busy} onClick={props.onPreview}>
              重新取一份
            </button>
          </div>
        </>
      )}
    </section>
  );
}
