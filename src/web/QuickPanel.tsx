import { useEffect, useRef, useState } from "react";

import { api } from "./apiClient.ts";
import { processingPatchForScope, resolveEntryMode } from "./modeDefaults.ts";
import {
  NO_LOCAL_MODEL_HINT_CLOUD_MISSING,
  NO_LOCAL_MODEL_HINT_TEXT,
  cloudSendAvailable,
  hintEntryFor,
  markHintDismissed,
  readHintDismissed,
  shouldShowNoLocalModelHint,
} from "./noLocalModelHint.ts";
import { quickSecondActionFor, runQuickSave, type QuickSaveDeps } from "./quickSave.ts";
import { TechnicalDetails } from "./ui/bits.tsx";
import { ProcessingModePicker } from "./ui/ProcessingModePicker.tsx";
import type { NoticeInput } from "./useNotices.ts";
import type { ProcessingModeAvailabilityDto } from "../shared/dto.ts";

/**
 * 「快速记录」—— 一段自由文本就能存下来，不要求先分类（spec §2.1(1)）。
 *
 * 这条能力原来长在「全部记录」页的页内卡片上，UI-4 收编成独立页面（〔Claude Code 裁决 2026-10-16〕：
 * 「写」是每天的动作，不该寄居在「翻旧账」的那一页里）。
 *
 * 整理方式（四档）在这里可选，初始值来自设置页的**同一个默认值**（`recordDefaultMode`），
 * 写入页、睡前页、设置页共用这一个值：在这里改档会立即回写它，三处因此永远一致。
 * 单条记录在详情页里单独改的整理方式只跟随那条记录，不回写这里。
 * M5-2：按所选模式补第二动作；整理方式改动（S-2/S-3）把它改成三档同一个动作、同一句文案——
 *   · `manual_only` —— 只有绿色的「只保存」，绝不调用模型，也没有第二颗键。
 *   · `local_model` / `cloud_redacted` / `cloud_raw` —— 「保存并整理」（绿色；「只保存」退成白色）：
 *     `createRecord` 成功后 `POST /api/jobs` 排进后台队列，回执「已保存并进入整理队列。」并回到
 *     来路那一页；入队失败就留在本页报错（原文已保存这一句先讲）。
 *     云端两档从前是「保存，去确认发送」并把人带到待整理页，现在只负责排进去。那道门没有放开：
 *     外发缺本次授权 ⇒ worker 认领时跳过这一行（`jobs/ingestExecutor.ts` 的 `makeEgressGrantRunnable`），
 *     记录在待整理如实显示「待确认发送」，发送仍逐次确认（K-17：模式 ≠ 授权 ≠ 已解析）。
 * 时序本体在 `quickSave.ts`（可跑逻辑与渲染分离的缘由见那一份的头注）。
 * M6-1C：这台电脑没有可用本机模型时，保存完成之后在本页补一句引导（判据与文案在
 * `noLocalModelHint.ts`）。它只是信息：不抢焦点、不打断编辑、不要求应答，关过一次就不再出现。
 * M6-1C-R：那句引导里带一个入口（复用云端第二动作那条 `onOpenPending`，不新增接口）；
 * 走入口不等于关掉提示，「知道了」的行为一字未动。
 * M6-1C-R2：入口按「保存当刻的档位」分流，落点由 `hintEntryFor` 判：云端档才落「待整理」，
 * manual_only / local_model 那条根本不进待整理，落到「全部记录」里这一条的详情（那里能改
 * 整理方式）。云端两档都没配置时不画入口，只补一句「云端通道还没配置」——没路可指就不指。
 */

export interface QuickPanelProps {
  /** 存下一条之后：外壳要重取徽章（真实状态变了）。 */
  readonly onSaved: () => void;
  /** 全局提示位（`useNotices.push`）：排进队列那句回执从这里走，本页的 flash 撑不过跳转。 */
  readonly notify: (input: NoticeInput) => void;
  /** 排进后台队列成功后离开：回到进这一页之前那一页（由 App 记来路，面板不自己路由）。 */
  readonly onReturnToPrevious: () => void;
  /** 云端第二动作 / 云端档的提示入口：选中新记录并切到「待整理」页（由 App 接线，面板不自己路由）。 */
  readonly onOpenPending: (recordId: string) => void;
  /**
   * 非云端档的提示入口：选中新记录并切到「全部记录」页，看这一条的详情。
   *
   * 为什么要另走这一条：manual_only / local_model 的记录不进「待整理」，那份列表里没有它，
   * 交给 `onOpenPending` 只会落到列表第一条别人的记录上（实测缺陷，1C-R2）。而这一页的详情
   * 带「整理方式」四档，用户在这里把档位改成云端档，那条记录才会出现在待整理里。
   */
  readonly onOpenRecord: (recordId: string) => void;
}

export function QuickPanel(props: QuickPanelProps): React.ReactNode {
  const [text, setText] = useState("");
  const [mode, setMode] = useState("manual_only");
  const [availability, setAvailability] = useState<ProcessingModeAvailabilityDto | null>(null);
  const touchedMode = useRef(false);
  const preferenceWrite = useRef<Promise<unknown>>(Promise.resolve());
  // M6-1C-R：提示条上的入口需要知道「刚存下来的那一条」是哪条。用 ref 不用 state：
  // 写入的当刻紧跟着就有 setText / setHintVisible 两次 setState，重渲染由它们负责。
  const savedRecordId = useRef<string | null>(null);
  // M6-1C-R2：入口的落点还要知道「那一条是按哪一档存进去的」。同样是 ref：档位 state 之后
  // 可能被用户点着改，而那条记录的去向由保存当刻的决定负责，不能跟着漂。
  const savedMode = useRef("manual_only");
  const [busy, setBusy] = useState<null | "save" | "organize">(null);
  const [error, setError] = useState<string | null>(null);
  const [errorDetail, setErrorDetail] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  // M6-1C：关过一次就再不出现（存进 localStorage），存不下也只当作没关过。
  const [hintDismissed, setHintDismissed] = useState(() => readHintDismissed(window.localStorage));
  const [hintVisible, setHintVisible] = useState(false);

  // 进入本页先从配置初始化默认方式（与设置页、睡前页同一个值）；拿不到配置就留在 manual_only。
  useEffect(() => {
    let active = true;
    api
      .ingestConfig()
      .then((cfg) => {
        if (!active) return;
        const resolved = resolveEntryMode(cfg.processingDefaults.recordDefaultMode, cfg.processingAvailability);
        setAvailability(cfg.processingAvailability);
        if (!touchedMode.current) setMode(resolved.mode);
        if (resolved.fellBack) {
          setFlash("保存的默认整理方式当前不可用，这一条先按「仅保存」处理。");
        }
      })
      .catch(() => {
        // 配置读不到不拦记录本身：保持 manual_only，不谎称知道可用性。
      });
    return () => {
      active = false;
    };
  }, []);

  /** 三处共用同一个默认值：本页改档立即回写 `recordDefaultMode`，设置页/睡前页随之一致。 */
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

  useEffect(() => {
    if (flash === null) return;
    const timer = setTimeout(() => setFlash(null), 6000);
    return () => clearTimeout(timer);
  }, [flash]);

  const second = quickSecondActionFor(mode);

  const deps: QuickSaveDeps = {
    createRecord: (text, mode) => api.createRecord(text, mode),
    enqueueJob: (recordId) => api.enqueueJob(recordId),
    // 保存成功当刻清空输入：走这条即时回调，而非等 runQuickSave 返回。创建失败时
    // runQuickSave 根本不调它，原文留着。
    onCreated: (recordId) => {
      // 先记下这一条（M6-1C-R：提示条上的入口指向它），再清空——两个动作同属「保存成功当刻」。
      savedRecordId.current = recordId;
      setText("");
    },
    onSaved: props.onSaved,
    // 队列收下这一行当刻：全局回执 + 回到来路那一页。提示走 `notify` 而不是本页的 `flash`——
    // `flash` 随这一页卸载一起消失，而这一刻恰好要离开这一页。
    onQueued: () => {
      props.notify({ tone: "ok", message: "已保存并进入整理队列。" });
      props.onReturnToPrevious();
    },
  };

  async function submit(organize: boolean): Promise<void> {
    if (busy !== null) return;
    setBusy(organize ? "organize" : "save");
    setError(null);
    setErrorDetail(null);
    try {
      const outcome = await runQuickSave(deps, text, mode, organize);
      // 清空已由 deps.onCreated 在 createRecord 成功当刻完成，这里不再 setText。
      if (outcome.kind === "create-failed") {
        setError(outcome.detail);
        return;
      }
      // `saved-queued`：回执与跳转都在 `deps.onQueued` 里做完，且已经离开这一页。
      if (outcome.kind === "saved") {
        // 记下保存当刻的档位：`mode` 是这次点击所属渲染的闭包值，await 期间不会被改写。
        savedMode.current = mode;
        setFlash(outcome.flash);
        // 只在保存成功之后提这一句：说在给这一条按下「保存」之前就是打断，
        // 而 `availability` 为 null（配置没读到）时 `shouldShowNoLocalModelHint` 自己会闭嘴。
        if (!hintDismissed && shouldShowNoLocalModelHint(availability)) setHintVisible(true);
      } else if (outcome.kind === "saved-organize-failed") {
        setError(outcome.warn);
        setErrorDetail(outcome.technical);
      }
    } finally {
      setBusy(null);
    }
  }

  /** 「知道了」：记住这一次关闭，并把这一屏的提示收掉。不影响任何其它状态。 */
  function dismissHint(): void {
    markHintDismissed(window.localStorage);
    setHintDismissed(true);
    setHintVisible(false);
  }

  // M6-1C-R：提示条上的入口只指向「这一次刚存下的那条」。取成局部 const 让下面 JSX 里的
  // 非空判据能收窄到它（ref.current 是可变属性，回调里不收窄）。
  const pendingRecordId = savedRecordId.current;
  // M6-1C-R2：入口落到哪一页由「保存当刻的档位 + 云端可用性」一起判（判据在 noLocalModelHint.ts）。
  const entry = hintEntryFor(savedMode.current, availability);

  return (
    <div className="quick-page">
      <section className="quick-sheet">
        {flash !== null && <p className="flash">{flash}</p>}
        {/* M6-1C：紧挨着 flash、不替换它。不抢焦点、不滚动定位、不让输入区变灰——
            用户此刻可以直接接着写下一条，这一句只是顺带的信息。 */}
        {hintVisible && (
          <div className="banner" role="status">
            {NO_LOCAL_MODEL_HINT_TEXT}
            {/* M6-1C-R2：云端两档都没配置时，正文那两条路此刻都走不通——如实补一句，
                并且不画入口（没路可指就不指，那比一个指错页的按钮诚实）。
                `availability === null`（配置没读到）不加这句：那一刻我们并不知情。 */}
            {availability !== null && !cloudSendAvailable(availability) && NO_LOCAL_MODEL_HINT_CLOUD_MISSING}
            {/* M6-1C-R：把「两条路」变成可点的下一步。走它不调 markHintDismissed：
                去看这一条不等于用户关掉了这句话（1C-R2：落到哪一页由上面的 entry 判）。 */}
            {entry !== null && pendingRecordId !== null && (
              <button
                type="button"
                className="btn"
                onClick={() => {
                  if (entry.kind === "pending") props.onOpenPending(pendingRecordId);
                  else props.onOpenRecord(pendingRecordId);
                }}
              >
                {entry.label}
              </button>
            )}
            <button type="button" className="btn" onClick={dismissHint}>知道了</button>
          </div>
        )}
        <textarea
          className="quick-input"
          rows={9}
          value={text}
          placeholder="想到什么就写什么，不用先想它属于哪一类。"
          onChange={(event) => setText(event.target.value)}
        />

        <ProcessingModePicker
          name="quick-mode"
          value={mode}
          onChange={selectMode}
          availability={availability}
        />

        <div className="actions">
          {/* 整理方式改动 S-2：绿色（`primary`）说的是「这一档接下来会发生什么」——
              `manual_only` 只有「只保存」那一颗，另三档把绿色让给「保存并整理」，「只保存」退成白色。
              两颗键的先后次序不变，只换颜色，用户的位置记忆跟着从前。 */}
          <button
            className={second === null ? "btn primary" : "btn"}
            onClick={() => void submit(false)}
            disabled={busy !== null || text.trim() === ""}
          >
            {busy === "save" ? "保存中…" : "只保存"}
          </button>
          {second !== null && (
            <button
              className="btn primary"
              onClick={() => void submit(true)}
              disabled={busy !== null || text.trim() === ""}
            >
              {busy === "organize" ? "排队中…" : second.label}
            </button>
          )}
        </div>
        {error !== null && <p className="warn">{error}</p>}
        {errorDetail !== null && <TechnicalDetails rows={[["技术详情", errorDetail]]} />}
      </section>
    </div>
  );
}
