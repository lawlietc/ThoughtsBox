import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";

import { BoxDetailDialog, BoxRowDetail, CitationDialog } from "./BoxDetail.tsx";
import { emotionBallPages } from "./boxBalls.ts";
import { boxScene, SCENE_HEIGHT, SCENE_WIDTH } from "./boxScene.ts";
import type { ProjectedPoint, SceneBall, SceneFace } from "./boxScene.ts";
import { NO_READABLE_DATA } from "./projections.ts";
import { boxShapeOf, COUNT_PLACEHOLDER, PROJECTION_UNREADY, UNREADY_DATA_PORT } from "./projectionPort.ts";
import { RecordList } from "./RecordList.tsx";
import { DisclosureNote, StatusLine } from "./ui/bits.tsx";
import { ListDetail } from "./ui/ListDetail.tsx";
import type {
  BoxPageContent,
  BoxShape,
  BoxView,
  DataPort,
  PortCitation,
  PortRow,
} from "./projectionPort.ts";
import type { ViewKey } from "./ui/types.ts";

type BoxDisplay = "list" | "box";

const BOX_DISPLAY_KEY_PREFIX = "tb-box-view:";
const LEGACY_BOX_DISPLAY_KEY = "tb-box-view";

function boxViewEnabled(view: BoxView): boolean {
  return view === "emotions";
}

/** 情绪页默认盒子；用户明确切到列表后按页面记住。其它四页固定列表。 */
function storedDisplay(view: BoxView): BoxDisplay {
  if (!boxViewEnabled(view)) return "list";
  const key = `${BOX_DISPLAY_KEY_PREFIX}${view}`;
  try {
    const stored = window.localStorage.getItem(key);
    if (stored === "box" || stored === "list") return stored;

    // 兼容上一版共享键：只迁移用户明确保存过的选择，没有值就落到新的默认盒子。
    const legacy = window.localStorage.getItem(LEGACY_BOX_DISPLAY_KEY);
    if (legacy === "box" || legacy === "list") {
      window.localStorage.setItem(key, legacy);
      return legacy;
    }
  } catch {
    // 隐私模式读不到就按默认盒子；当前这一屏仍可正常切换。
  }
  return "box";
}

function rememberDisplay(view: BoxView, display: BoxDisplay): void {
  if (!boxViewEnabled(view)) return;
  const key = `${BOX_DISPLAY_KEY_PREFIX}${view}`;
  try {
    window.localStorage.setItem(key, display);
  } catch {
    // 存不进去只影响下次打开；当前这一屏仍然按用户刚选的那一档显示。
  }
}

function CountsAndNotes(props: {
  readonly shape: BoxShape;
  readonly content: BoxPageContent;
}): React.ReactNode {
  return (
    <DisclosureNote summary="数量与分组说明">
      <p className="row-meta">
        {props.shape.counts
          .map((label, index) => `${label} ${props.content.counts[index] ?? COUNT_PLACEHOLDER}`)
          .join(" · ")}
      </p>
      <div className="box-notes">
        {props.shape.groups.map((group) => (
          <p key={group.heading}>
            <strong>{group.heading}</strong>：{group.note}
          </p>
        ))}
      </div>
    </DisclosureNote>
  );
}

function BallButton(props: {
  readonly ball: SceneBall;
  readonly onSelect: (id: string) => void;
}): React.ReactNode {
  const label = `${props.ball.title}，出现 ${props.ball.weight} 次`;
  const style: CSSProperties & Record<`--${string}`, string> = {
    "--ball-x": `${(props.ball.screenX / SCENE_WIDTH) * 100}%`,
    "--ball-y": `${(props.ball.screenY / SCENE_HEIGHT) * 100}%`,
    "--ball-mobile-size": `${props.ball.mobileSize}px`,
    "--ball-desktop-size": `${props.ball.desktopSize}px`,
    zIndex: props.ball.layer,
  };

  return (
    <button
      type="button"
      className="box-ball"
      aria-label={label}
      title={label}
      style={style}
      onClick={() => props.onSelect(props.ball.id)}
    >
    </button>
  );
}

function BallLabel(props: {
  readonly ball: SceneBall;
}): React.ReactNode {
  const style: CSSProperties & Record<`--${string}`, string> = {
    "--ball-x": `${(props.ball.screenX / SCENE_WIDTH) * 100}%`,
    "--ball-y": `${(props.ball.screenY / SCENE_HEIGHT) * 100}%`,
    "--ball-mobile-size": `${props.ball.mobileSize}px`,
    "--ball-desktop-size": `${props.ball.desktopSize}px`,
  };

  return (
    <span className="box-ball-label" aria-hidden="true" style={style}>
      {props.ball.title}
    </span>
  );
}

function pointsAttr(points: readonly ProjectedPoint[]): string {
  return points.map((point) => `${point.screenX.toFixed(1)},${point.screenY.toFixed(1)}`).join(" ");
}

function FaceLayer(props: {
  readonly faces: readonly SceneFace[];
}): React.ReactNode {
  return props.faces.map((face) => (
    <polygon
      key={face.id}
      className={`box-face box-face-${face.tone}`}
      points={pointsAttr(face.points)}
      data-depth={face.depth.toFixed(2)}
    />
  ));
}

function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** 开盖状态先切换可访问性；视觉进度单独用 0..1 驱动场景投影。 */
function useOpenProgress(open: boolean): number {
  const [progress, setProgress] = useState(open ? 1 : 0);
  const progressRef = useRef(open ? 1 : 0);

  useEffect(() => {
    const from = progressRef.current;
    const to = open ? 1 : 0;
    if (from === to) return;

    if (prefersReducedMotion()) {
      progressRef.current = to;
      setProgress(to);
      return;
    }

    const startedAt = performance.now();
    const duration = 380;
    let frame = 0;
    const tick = (now: number): void => {
      const elapsed = Math.min(1, (now - startedAt) / duration);
      const eased = 1 - Math.pow(1 - elapsed, 3);
      const next = from + (to - from) * eased;
      progressRef.current = next;
      setProgress(next);
      if (elapsed < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [open]);

  return progress;
}

/** 情绪页把全部出现过的情绪按 9 个一页放进盒子。 */
function BoxPreview(props: {
  readonly title: string;
  readonly open: boolean;
  readonly hasRows: boolean;
  readonly rows: readonly PortRow[];
  readonly trayId: string;
  readonly onToggle: () => void;
  readonly onSelect: (id: string) => void;
}): React.ReactNode {
  const progress = useOpenProgress(props.open);
  const pages = emotionBallPages(props.rows);
  const [pageIndex, setPageIndex] = useState(0);
  const safePageIndex = Math.min(pageIndex, Math.max(0, pages.length - 1));
  const pageCount = pages.length;
  const currentRows = pages[safePageIndex] ?? [];
  const scene = boxScene(progress, currentRows, safePageIndex);
  const showPager = props.open && pageCount > 1;
  const previousRef = useRef<HTMLButtonElement>(null);
  const nextRef = useRef<HTMLButtonElement>(null);
  const goToPage = (next: number): void => {
    const bounded = Math.max(0, Math.min(pageCount - 1, next));
    if (bounded === safePageIndex) return;
    setPageIndex(bounded);
    requestAnimationFrame(() => {
      if (bounded === 0) nextRef.current?.focus();
      else if (bounded === pageCount - 1) previousRef.current?.focus();
      else nextRef.current?.focus();
    });
  };
  const lid = scene.lidBounds;
  const lidClip = scene.lidQuad
    .map((point) => {
      const x = ((point.screenX / SCENE_WIDTH) * 100 - lid.left) / lid.width;
      const y = ((point.screenY / SCENE_HEIGHT) * 100 - lid.top) / lid.height;
      return `${(x * 100).toFixed(2)}% ${(y * 100).toFixed(2)}%`;
    })
    .join(", ");

  return (
    <div
      className={["box-visual", props.open ? "is-open" : "", showPager ? "has-pager" : ""]
        .filter(Boolean)
        .join(" ")}
      data-open-progress={progress.toFixed(3)}
    >
      <div className="box-stage">
        <svg
          className="box-svg box-svg-background"
          viewBox={`0 0 ${SCENE_WIDTH} ${SCENE_HEIGHT}`}
          preserveAspectRatio="xMidYMid meet"
          aria-hidden="true"
          focusable="false"
        >
          <ellipse
            className="box-ground-shadow"
            cx={scene.groundShadow.cx}
            cy={scene.groundShadow.cy}
            rx={scene.groundShadow.rx}
            ry={scene.groundShadow.ry}
          />
          <FaceLayer faces={scene.backFaces} />
          {scene.shadows.map((shadow) => (
            <ellipse
              key={shadow.id}
              className="box-ball-shadow"
              cx={shadow.cx}
              cy={shadow.cy}
              rx={shadow.rx}
              ry={shadow.ry}
            />
          ))}
        </svg>

        <div className="box-interior" id={props.trayId}>
          {!props.hasRows && <p className="box-empty">盒子还是空的</p>}

          {props.hasRows && scene.balls.length > 0 && (
            <div className="box-emotion-map" key={`page-${safePageIndex}`}>
              {scene.balls.map((ball) => (
                <BallButton ball={ball} key={ball.id} onSelect={props.onSelect} />
              ))}
              {scene.balls.map((ball) => (
                <BallLabel ball={ball} key={`label-${ball.id}`} />
              ))}
            </div>
          )}

          {props.hasRows && scene.balls.length === 0 && (
            <p className="box-empty">暂时没有可用的频次。</p>
          )}
        </div>

        <svg
          className="box-svg box-svg-foreground"
          viewBox={`0 0 ${SCENE_WIDTH} ${SCENE_HEIGHT}`}
          preserveAspectRatio="xMidYMid meet"
          aria-hidden="true"
          focusable="false"
        >
          <FaceLayer faces={scene.foregroundFaces} />
          <text className="box-lid-title" x={scene.lidTitle.x} y={scene.lidTitle.y} textAnchor="middle">
            {props.title}
          </text>
          <text className="box-lid-action" x={scene.lidAction.x} y={scene.lidAction.y} textAnchor="middle">
            {props.open ? "合上" : "打开"}
          </text>
        </svg>

        <button
          type="button"
          className="box-lid-hit"
          aria-label={`${props.open ? "合上" : "打开"}${props.title}`}
          aria-expanded={props.open}
          aria-controls={props.trayId}
          onClick={props.onToggle}
          style={{
            left: `${lid.left}%`,
            top: `${lid.top}%`,
            width: `${lid.width}%`,
            height: `${lid.height}%`,
            clipPath: `polygon(${lidClip})`,
          }}
        />
      </div>

      {showPager && (
        <div className="box-pager" role="group" aria-label="切换盒子里的情绪球">
          <button
            ref={previousRef}
            type="button"
            className="box-page-btn"
            aria-label="上一组情绪球"
            aria-controls={props.trayId}
            disabled={safePageIndex === 0}
            onClick={() => goToPage(safePageIndex - 1)}
          >
            ‹
          </button>
          <button
            ref={nextRef}
            type="button"
            className="box-page-btn"
            aria-label="下一组情绪球"
            aria-controls={props.trayId}
            disabled={safePageIndex === pageCount - 1}
            onClick={() => goToPage(safePageIndex + 1)}
          >
            ›
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * 盒子五页（情绪 / 经历 / 念头 / 人物与事物 / 主题）—— 按原型各页的布局建成真页面。
 *
 * 五个页面共用这一份实现，差别全部在 `projectionPort.ts` 的形状表里：
 * 同一套「左边分组列表 / 右边详情」的壳，五页各自的分表头与计数位。
 * 布局只有这一套（`ui/ListDetail.tsx`），所以「窄屏忘了返回列表」这种错只可能犯一次，
 * 但也只会犯一次。
 *
 * 内容来自**数据口**（`port`），这一层不知道数据从哪儿来（§四：展示组件不读全局状态）：
 * - 不传 = `UNREADY_DATA_PORT`：列表空、计数位 `—`，只说一句「投影还没就绪」，不列内部字段；
 * - dev 模式传假数据那一份，同一套 JSX 就长出内容 —— 「一份 UI 两个数据源」测的正是这一跳。
 *
 * M5-3B：主界面删除了缺口清单卡与详情区的规格语言；形状与计数数据本身
 * 继续留给数据源与测试（`projectionPort.ts` 的契约未动）。
 * M5-3C：整页一组行都没有时只说一次本页空态；数据口未就绪时不再逐组摆标题与 note。
 * M5-5D：列表仍是默认档；新增盒子视图与开合，计数和分组说明收进次级层。
 */

export interface BoxPanelProps {
  readonly view: ViewKey;
  /** 数据口。不传即为「这个数据源给不出这一页」—— 显示 UI-4 那句诚实空态。 */
  readonly port?: DataPort;
}

export function BoxPanel(props: BoxPanelProps): React.ReactNode {
  const shape = boxShapeOf(props.view);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [boxSelectedId, setBoxSelectedId] = useState<string | null>(null);
  const [listCitation, setListCitation] = useState<PortCitation | null>(null);
  const [display, setDisplay] = useState<BoxDisplay>(() =>
    shape === null ? "list" : storedDisplay(shape.view),
  );
  const [boxOpen, setBoxOpen] = useState(false);
  const ballTriggerRef = useRef<HTMLElement | null>(null);
  const citationTriggerRef = useRef<HTMLElement | null>(null);
  const port = props.port ?? UNREADY_DATA_PORT;
  const loadSource = useCallback(
    (recordId: string) => port.recordSource?.(recordId) ?? Promise.resolve(null),
    [port.recordSource],
  );

  // 形状表里没有这一页 —— 那不是这一层该画的东西（调用方按 view 挂载，见 App.tsx）。
  if (shape === null) return null;

  const chooseDisplay = (next: BoxDisplay): void => {
    setSelectedId(null);
    setBoxSelectedId(null);
    setListCitation(null);
    setDisplay(next);
    rememberDisplay(shape.view, next);
  };
  const canChooseDisplay = boxViewEnabled(shape.view);

  const content = port.boxPage(shape.view);
  const rowsOf = (heading: string): readonly PortRow[] =>
    content?.groups.find((group) => group.heading === heading)?.rows ?? [];
  const allRows: readonly PortRow[] = content?.groups.flatMap((group) => group.rows) ?? [];
  const selected = allRows.find((row) => row.id === selectedId) ?? null;
  const boxSelected = allRows.find((row) => row.id === boxSelectedId) ?? null;
  const trayId = `box-tray-${shape.view}`;

  const closeBoxDetail = (): void => {
    const trigger = ballTriggerRef.current;
    setBoxSelectedId(null);
    requestAnimationFrame(() => trigger?.focus());
  };

  const closeListCitation = (): void => {
    const trigger = citationTriggerRef.current;
    setListCitation(null);
    requestAnimationFrame(() => trigger?.focus());
  };

  return (
    <>
      <ListDetail
        hasSelection={selected !== null}
        listOnly={display === "box"}
        onBack={() => setSelectedId(null)}
        list={
          <section className="card">
            <div className="box-page-head">
              <div>
                <h2>{shape.title}</h2>
                <p className="hint">{shape.lede}</p>
              </div>
              {canChooseDisplay && (
                <div className="box-view-switch" role="group" aria-label="显示方式">
                  <button
                    type="button"
                    className="box-view-option"
                    aria-pressed={display === "box"}
                    onClick={() => chooseDisplay("box")}
                  >
                    盒子
                  </button>
                  <button
                    type="button"
                    className="box-view-option"
                    aria-pressed={display === "list"}
                    onClick={() => chooseDisplay("list")}
                  >
                    列表
                  </button>
                </div>
              )}
            </div>

            {display === "list" && (
              <>
                {/* 数据口给不出这一页时只说这一句诚实空态，不摆开发进度。 */}
                {content === null && <StatusLine>{PROJECTION_UNREADY}</StatusLine>}

                {/* 一页里一组行都没有，就只说一次本页的空态 —— 逐组重复同一句话是噪音，不是状态。 */}
                {content !== null && allRows.length === 0 && <p className="hint">{shape.emptyHint}</p>}

                {content !== null &&
                  allRows.length > 0 &&
                  shape.groups.map((group) => (
                    <div key={group.heading}>
                      <h3>{group.heading}</h3>
                      <RecordList
                        rows={rowsOf(group.heading)}
                        selectedId={selectedId}
                        onSelect={setSelectedId}
                        emptyText={shape.emptyHint}
                      />
                    </div>
                  ))}
              </>
            )}

            {display === "box" && content === null && <StatusLine>{PROJECTION_UNREADY}</StatusLine>}
            {display === "box" && content !== null && (
              <BoxPreview
                title={shape.title}
                open={boxOpen}
                hasRows={allRows.length > 0}
                rows={allRows}
                trayId={trayId}
                onToggle={() => setBoxOpen((open) => !open)}
                onSelect={(id) => {
                  ballTriggerRef.current =
                    document.activeElement instanceof HTMLElement ? document.activeElement : null;
                  setBoxSelectedId(id);
                }}
              />
            )}

            {/* 计数永远有位；缺值填占位符，不填 0（0 与「不知道」不能长得一样）。 */}
            {content !== null && <CountsAndNotes shape={shape} content={content} />}
          </section>
        }
        detail={
          <section className="card">
            {selected === null ? (
              <>
                <h2>{shape.detailHeading}</h2>
                <p className="hint">{NO_READABLE_DATA}</p>
              </>
            ) : (
              <BoxRowDetail
                row={selected}
                heading={shape.detailHeading}
                onCite={(citation) => {
                  citationTriggerRef.current =
                    document.activeElement instanceof HTMLElement ? document.activeElement : null;
                  setListCitation(citation);
                }}
              />
            )}
          </section>
        }
      />

      {display === "box" && boxSelected !== null && (
        <BoxDetailDialog
          row={boxSelected}
          heading={shape.detailHeading}
          loadSource={loadSource}
          onClose={closeBoxDetail}
        />
      )}

      {display === "list" && listCitation !== null && (
        <CitationDialog citation={listCitation} loadSource={loadSource} onClose={closeListCitation} />
      )}
    </>
  );
}
