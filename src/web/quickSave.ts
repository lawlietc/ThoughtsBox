import { ApiError } from "./apiClient.ts";
import type { IngestResultDto } from "../shared/dto.ts";

/**
 * M5-2：QuickPanel 保存动作的**可跑逻辑**（与 React 无关的纯驱动面）。
 *
 * 为什么单独一层：本仓 node 测试程序（根 tsconfig）不装 jsx/DOM，`.tsx` 模块进不了
 * typecheck 闭包（实测 TS6142）；而「createRecord 必先于 ingestParse」「创建失败绝不 parse」
 * 这类时序只有真跑一遍才钉得住。于是时序落在这份纯 `.ts` 里，`QuickPanel.tsx` 只做渲染
 * 与状态映射（〔偏离任务书交付清单登记，见 worklog〕）。
 */

/** 当前模式对应的第二动作；`null` = 这一档没有第二按钮。取值照旧来自 enums 三档。 */
export type QuickSecondAction =
  | { readonly kind: "organize-local"; readonly label: "保存并整理" }
  | { readonly kind: "go-pending"; readonly label: "保存，去确认发送" };

export function quickSecondActionFor(mode: string): QuickSecondAction | null {
  if (mode === "local_model") return { kind: "organize-local", label: "保存并整理" };
  if (mode === "cloud_redacted") return { kind: "go-pending", label: "保存，去确认发送" };
  return null;
}

/**
 * 第二按钮处于忙碌态时的文案，按模式区分。
 *
 * `local_model` 是真在调用本机模型整理（可达数十秒）——「整理中…」名副其实；
 * `cloud_redacted` 的第二动作只是把用户带到「待整理」页（纯导航、瞬时），并没有整理，
 * 显示「整理中…」是撒谎，因此这里改用「正在打开…」。
 */
export function quickOrganizeBusyLabel(mode: string): string {
  return mode === "local_model" ? "整理中…" : "正在打开…";
}

/** 驱动面与真实取数层的接缝：测试注入记账假件，组件注入 `api`。 */
export interface QuickSaveDeps {
  createRecord(text: string, mode: string): Promise<{ record: { id: string } }>;
  ingestParse(body: { recordId: string }): Promise<IngestResultDto>;
  /**
   * `createRecord` 成功当刻的即时回调——早于任何 `ingestParse` / `onOpenPending`。
   * 本地整理可能持续数十秒，「保存成功即清空输入」只能挂在这里：QuickPanel 用它
   * 立刻 `setText("")`，而不是等整段 `runQuickSave` 返回。创建失败时绝不被调用（原文留着）。
   */
  onCreated(recordId: string): void;
  onSaved(): void;
  onOpenPending(recordId: string): void;
}

export type QuickSaveOutcome =
  /** 保存就没成功：输入不清空，如实报错，绝不进整理。 */
  | { readonly kind: "create-failed"; readonly detail: string }
  /** 保存成功（输入清空、徽章刷新）：`flash` 说清这一档接下来发生了什么。 */
  | { readonly kind: "saved"; readonly flash: string }
  /** 保存成功但整理失败：话必须先说「原文已保存」，再带真实失败原因。 */
  | { readonly kind: "saved-organize-failed"; readonly warn: string };

/**
 * 一次「保存」或「保存并整理」的完整时序：
 * `createRecord` 必须先成功——它抛错就直接 `create-failed`，模型一个 token 都不会被调用；
 * 成功后**立刻** `onCreated(recordId)`（QuickPanel 借此清空输入，不等整理返回），
 * 再 `onSaved()` 刷徽章，然后才按模式分派第二动作。
 * 本地整理结束后（无论成败）再 `onSaved()` 一次：状态机已经写了派生行。
 * 云端第二动作只导航（`onOpenPending`），不 parse、不 preview、不 confirm-send。
 */
export async function runQuickSave(
  deps: QuickSaveDeps,
  text: string,
  mode: string,
  organize: boolean,
): Promise<QuickSaveOutcome> {
  let created: { record: { id: string } };
  try {
    // 原文逐字交给服务端（`validateText` 只拒绝纯空白），前端不 trim、不改写。
    created = await deps.createRecord(text, mode);
  } catch (cause) {
    return {
      kind: "create-failed",
      detail: cause instanceof ApiError ? cause.detail : "保存失败：这一条没能写进本机。",
    };
  }
  const recordId = created.record.id;
  // 保存成功当刻即清空输入（早于第二动作，尤其早于可能持续数十秒的 ingestParse）。
  deps.onCreated(recordId);
  deps.onSaved();

  const second = organize ? quickSecondActionFor(mode) : null;
  if (second === null) {
    return { kind: "saved", flash: "已保存。原文已经在这台电脑上了。" };
  }
  if (second.kind === "go-pending") {
    // 云端只带到「待整理」门口：发送授权仍要在那一页逐次做。
    deps.onOpenPending(recordId);
    return {
      kind: "saved",
      flash: "原文已保存。已带你到「待整理」页并选中这一条——发送前仍要先预览，并逐次确认。",
    };
  }

  try {
    const result = await deps.ingestParse({ recordId });
    deps.onSaved();
    if (result.succeeded) {
      return { kind: "saved", flash: "原文已保存，本机模型整理完成。结果在「待整理」页里看。" };
    }
    const failure = result.failure;
    const reason =
      failure !== null
        ? failure.errorKind !== null
          ? `${failure.message}（errorKind: ${failure.errorKind}）`
          : failure.message
        : result.errorKind !== null
          ? `整理未成功（errorKind: ${result.errorKind}）`
          : "整理未成功（服务端没给出原因）";
    return { kind: "saved-organize-failed", warn: `原文已保存（就在这台电脑上）。整理没有成功：${reason}` };
  } catch (cause) {
    deps.onSaved();
    const detail = cause instanceof ApiError ? cause.detail : "整理调用失败（本地模型没给出详情）";
    return { kind: "saved-organize-failed", warn: `原文已保存（就在这台电脑上）。整理没有成功：${detail}` };
  }
}
