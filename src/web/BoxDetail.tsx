import { useEffect, useId, useRef, useState } from "react";

import { NO_READABLE_DATA, evidencePhrase } from "./projections.ts";
import { EvidenceLine } from "./ui/bits.tsx";
import { SourceText } from "./ui/SourceText.tsx";
import type { PortCitation, PortDetailBlock, PortRow, RecordSource } from "./projectionPort.ts";

type RecordSourceLoader = (recordId: string) => Promise<RecordSource | null>;

function evidenceView(citation: PortCitation) {
  const evidence = citation.evidence;
  if (evidence === null || !evidence.anchored || evidence.start === null || evidence.end === null) {
    return null;
  }
  return {
    text: evidence.text,
    start: evidence.start,
    end: evidence.end,
    anchored: true,
  };
}

function DetailBlock(props: {
  readonly block: PortDetailBlock;
  readonly onCite: (citation: PortCitation) => void;
}): React.ReactNode {
  const { block } = props;
  const evidence = block.citation?.evidence ?? null;
  const view = block.citation === undefined || block.citation === null ? null : evidenceView(block.citation);

  return (
    <section
      className={block.kind === "mention" ? "box-detail-block is-mention" : "box-detail-block"}
      data-block-id={block.id}
    >
      <div className="box-detail-block-head">
        <h3>{block.title}</h3>
        {block.badges !== undefined && block.badges.length > 0 && (
          <div className="box-detail-badges">
            {block.badges.map((badge) => (
              <span className={`box-detail-badge ${badge.tone}`} key={`${block.id}-${badge.tone}-${badge.label}`}>
                {badge.label}
              </span>
            ))}
          </div>
        )}
      </div>

      <dl className="box-detail-fields">
        {block.fields.map(([label, value]) => (
          <div className="box-detail-field" key={`${block.id}-${label}`}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>

      {block.citation !== undefined && block.citation !== null && (
        <div className="box-detail-evidence">
          {view !== null ? (
            <EvidenceLine evidence={view} onJump={() => props.onCite(block.citation!)} />
          ) : evidence === null ? (
            <p className="hint">这条没有可回看的证据。</p>
          ) : (
            <p className={evidence.anchored ? "hint" : "warn"}>{evidencePhrase(evidence)}</p>
          )}
        </div>
      )}
    </section>
  );
}

export function BoxRowDetail(props: {
  readonly row: PortRow;
  readonly heading: string;
  readonly titleId?: string;
  readonly onCite: (citation: PortCitation) => void;
}): React.ReactNode {
  return (
    <div className="box-row-detail">
      <h2 id={props.titleId}>{props.heading}</h2>
      <p className="box-row-detail-title">{props.row.title}</p>
      <p className="hint">{props.row.meta}</p>
      {props.row.detail.length === 0 ? (
        <p className="hint">{NO_READABLE_DATA}</p>
      ) : (
        <div className="box-detail-blocks">
          {props.row.detail.map((block) => (
            <DetailBlock block={block} key={block.id} onCite={props.onCite} />
          ))}
        </div>
      )}
    </div>
  );
}

type CitationState =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "ready"; readonly source: RecordSource };

function CitationView(props: {
  readonly citation: PortCitation;
  readonly titleId: string;
  readonly backLabel: string;
  readonly loadSource: RecordSourceLoader;
  readonly onBack: () => void;
}): React.ReactNode {
  const [state, setState] = useState<CitationState>({ kind: "loading" });

  useEffect(() => {
    let active = true;
    setState({ kind: "loading" });
    props
      .loadSource(props.citation.recordId)
      .then((source) => {
        if (!active) return;
        setState(
          source === null
            ? { kind: "error", message: "找不到这条记录的原文。" }
            : { kind: "ready", source },
        );
      })
      .catch((cause: unknown) => {
        if (!active) return;
        setState({
          kind: "error",
          message: cause instanceof Error ? cause.message : "原文读取失败。",
        });
      });
    return () => {
      active = false;
    };
  }, [props.citation.recordId, props.loadSource]);

  const evidence = props.citation.evidence;
  return (
    <div className="citation-view">
      <button className="btn citation-back" type="button" onClick={props.onBack} autoFocus>
        ← {props.backLabel}
      </button>
      <div className="citation-heading">
        <h2 id={props.titleId}>引用原文</h2>
        <p className="hint">记录 {props.citation.recordDate}</p>
      </div>

      {state.kind === "loading" && <p className="hint">正在读取原文…</p>}
      {state.kind === "error" && <p className="warn">{state.message}</p>}
      {state.kind === "ready" && (
        <>
          <p className="citation-version">{state.source.revisionLabel}</p>
          {evidence !== null && <p className="citation-evidence">证据：「{evidence.text}」</p>}
          <SourceText
            text={state.source.rawText}
            highlight={
              evidence !== null && evidence.start !== null && evidence.end !== null
                ? {
                    text: evidence.text,
                    start: evidence.start,
                    end: evidence.end,
                    anchored: evidence.anchored,
                  }
                : null
            }
            missingMessage={
              evidence === null ? undefined : `这一条证据点不回当前版本：${evidencePhrase(evidence)}`
            }
          />
        </>
      )}
    </div>
  );
}

/**
 * 盒子模式的详情弹窗。
 *
 * 引用在同一个 dialog 内钻取，不叠第二层遮罩；返回时恢复详情滚动位置和证据按钮焦点。
 */
export function BoxDetailDialog(props: {
  readonly row: PortRow;
  readonly heading: string;
  readonly loadSource: RecordSourceLoader;
  readonly onClose: () => void;
}): React.ReactNode {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const evidenceBlockIdRef = useRef<string | null>(null);
  const detailScrollRef = useRef(0);
  const [citation, setCitation] = useState<PortCitation | null>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog !== null && !dialog.open) dialog.showModal();
  }, []);

  const cite = (next: PortCitation): void => {
    detailScrollRef.current = scrollRef.current?.scrollTop ?? 0;
    const active = document.activeElement;
    evidenceBlockIdRef.current =
      active instanceof HTMLElement
        ? (active.closest("[data-block-id]") as HTMLElement | null)?.dataset.blockId ?? null
        : null;
    setCitation(next);
  };

  const backToDetail = (): void => {
    const scrollTop = detailScrollRef.current;
    const blockId = evidenceBlockIdRef.current;
    setCitation(null);
    requestAnimationFrame(() => {
      if (scrollRef.current === null) return;
      scrollRef.current.scrollTop = scrollTop;
      const block = Array.from(scrollRef.current.querySelectorAll<HTMLElement>("[data-block-id]")).find(
        (node) => node.dataset.blockId === blockId,
      );
      block?.querySelector<HTMLButtonElement>("button.mention")?.focus();
    });
  };

  const close = (): void => {
    props.onClose();
  };

  return (
    <dialog
      className="box-detail-dialog"
      ref={dialogRef}
      aria-labelledby={titleId}
      onClose={close}
      onCancel={(event) => {
        if (citation !== null) {
          event.preventDefault();
          backToDetail();
        }
      }}
      onClick={(event) => {
        if (event.target !== event.currentTarget) return;
        if (citation !== null) backToDetail();
        else close();
      }}
    >
      <div className="box-detail-shell">
        <button className="box-detail-close" type="button" aria-label="关闭详情" onClick={close}>
          ×
        </button>
        <div className="box-detail-scroll" ref={scrollRef}>
          {citation === null ? (
            <BoxRowDetail row={props.row} heading={props.heading} titleId={titleId} onCite={cite} />
          ) : (
            <CitationView
              citation={citation}
              titleId={titleId}
              backLabel="返回详情"
              loadSource={props.loadSource}
              onBack={backToDetail}
            />
          )}
        </div>
      </div>
    </dialog>
  );
}

/** 列表模式的证据引用：留在盒子页，关闭后回到右栏详情。 */
export function CitationDialog(props: {
  readonly citation: PortCitation;
  readonly loadSource: RecordSourceLoader;
  readonly onClose: () => void;
}): React.ReactNode {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog !== null && !dialog.open) dialog.showModal();
  }, []);

  return (
    <dialog
      className="box-detail-dialog citation-dialog"
      ref={dialogRef}
      aria-labelledby={titleId}
      onClose={props.onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) props.onClose();
      }}
    >
      <div className="box-detail-shell">
        <button className="box-detail-close" type="button" aria-label="关闭引用" onClick={props.onClose}>
          ×
        </button>
        <div className="box-detail-scroll">
          <CitationView
            citation={props.citation}
            titleId={titleId}
            backLabel="返回盒子"
            loadSource={props.loadSource}
            onBack={props.onClose}
          />
        </div>
      </div>
    </dialog>
  );
}
