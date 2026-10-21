import { useEffect, useRef } from "react";

import type { EvidenceView } from "./types.ts";

export interface SourceTextProps {
  readonly text: string;
  readonly highlight: EvidenceView | null;
  readonly missingMessage?: string | undefined;
}

/**
 * 只读原文 + 证据高亮。
 *
 * 坐标必须先在当前原文上验证，不能拿旧版本区间硬套新版本；高亮错了比不高亮更糟。
 */
export function SourceText(props: SourceTextProps): React.ReactNode {
  const markRef = useRef<HTMLElement>(null);
  const highlight = props.highlight;
  const anchor =
    highlight !== null &&
    highlight.start >= 0 &&
    highlight.end >= highlight.start &&
    props.text.slice(highlight.start, highlight.end) === highlight.text
      ? { start: highlight.start, end: highlight.end }
      : null;

  useEffect(() => {
    if (anchor !== null) markRef.current?.scrollIntoView({ block: "center" });
  }, [anchor, props.text]);

  if (props.text === "") return <p className="hint">（原文为空）</p>;

  if (anchor === null) {
    return (
      <>
        <p className="raw">{props.text}</p>
        {(highlight !== null || props.missingMessage !== undefined) && (
          <p className="warn">
            {props.missingMessage ??
              "这一条证据点不回当前版本：当前原文里找不到这段文字。上面显示的是当前版本。"}
          </p>
        )}
      </>
    );
  }

  return (
    <p className="raw">
      {props.text.slice(0, anchor.start)}
      <mark ref={markRef}>{props.text.slice(anchor.start, anchor.end)}</mark>
      {props.text.slice(anchor.end)}
    </p>
  );
}
