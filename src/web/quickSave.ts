import { ApiError } from "./apiClient.ts";
import { failurePlanOf } from "./failureActions.ts";

/**
 * M5-2：QuickPanel 保存动作的**可跑逻辑**（与 React 无关的纯驱动面）。
 *
 * 为什么单独一层：本仓 node 测试程序（根 tsconfig）不装 jsx/DOM，`.tsx` 模块进不了
 * typecheck 闭包（实测 TS6142）；而「createRecord 必先于后续动作」「创建失败绝不后续动作」
 * 这类时序只有真跑一遍才钉得住。于是时序落在这份纯 `.ts` 里，`QuickPanel.tsx` 只做渲染
 * 与状态映射（〔偏离任务书交付清单登记，见 worklog〕）。
 */

/** 当前模式对应的第二动作；`null` = 这一档没有第二按钮（只有 `manual_only`）。 */
export type QuickSecondAction = { readonly kind: "enqueue"; readonly label: "保存并整理" };

/**
 * 「保存并整理」——三档（`local_model` / `cloud_redacted` / `cloud_raw`）从此是同一个动作、
 * 同一句文案（整理方式改动 S-2/S-3）。它不再在本页同步跑模型：
 * 保存 → 排进后台队列 → 提示 → 回上一页。
 *
 * 云端两档从前叫「保存，去确认发送」并把用户带到待整理页；现在它也只负责排进去。
 * 这不等于放开那道门：`POST /api/jobs` 写下这一行后，外发轨缺本次授权 ⇒ worker 每一拍跳过它
 * （认领侧闸门，S-4），记录在待整理页如实显示「待确认发送」，发送仍逐次确认（K-17 一字未动）。
 * 变的只是用户不用再自己当那个搬运工。
 */
export function quickSecondActionFor(mode: string): QuickSecondAction | null {
  if (mode === "local_model" || mode === "cloud_redacted" || mode === "cloud_raw") {
    return { kind: "enqueue", label: "保存并整理" };
  }
  return null;
}

/** 驱动面与真实取数层的接缝：测试注入记账假件，组件注入 `api`。 */
export interface QuickSaveDeps {
  createRecord(text: string, mode: string): Promise<{ record: { id: string } }>;
  /** `POST /api/jobs`：把这一条排进后台队列。用户显式动作，保存本身不自动入队。 */
  enqueueJob(recordId: string): Promise<unknown>;
  /**
   * `createRecord` 成功当刻的即时回调——早于入队。
   * 入队通常瞬时，但「保存成功即清空输入」这条语义继续挂在这里：QuickPanel 用它立刻
   * `setText("")`。创建失败时绝不被调用（原文留着）。
   */
  onCreated(recordId: string): void;
  onSaved(): void;
  /**
   * 入队成功当刻：QuickPanel 借此发全局提示并回到上一页（S-5）。
   * 与 `onSaved` 分开是因为时机不同——徽章在创建当刻就该重取，而「离开这一页」必须等
   * 队列确实收下了这一行；入队失败时绝不能被调用（留在本页报错）。
   */
  onQueued(recordId: string): void;
}

export type QuickSaveOutcome =
  /** 保存就没成功：输入不清空，如实报错，绝不入队。 */
  | { readonly kind: "create-failed"; readonly detail: string }
  /** 保存成功且没要求整理（`manual_only` 那颗「只保存」）：`flash` 说清这一档接下来发生了什么。 */
  | { readonly kind: "saved"; readonly flash: string }
  /** 保存成功且已排进后台队列：提示与离开都由 `onQueued` 负责，这里只回执。 */
  | { readonly kind: "saved-queued" }
  /**
   * 保存成功但入队失败：`warn` 只说人话并先讲「原文已保存」，
   * `technical` 是折叠区里的服务端读数（错误分类与消息），不丢。
   */
  | { readonly kind: "saved-organize-failed"; readonly warn: string; readonly technical: string | null };

/**
 * 一次「保存」或「保存并整理」的完整时序：
 * `createRecord` 必须先成功——它抛错就直接 `create-failed`，队列里一行都不会写下；
 * 成功后**立刻** `onCreated(recordId)`（QuickPanel 借此清空输入），再 `onSaved()` 刷徽章，
 * 然后才按模式分派第二动作。第二动作只入队：等队列收下这一行后 `onQueued()`，
 * 入队本身失败则留在本页报错（原文已保存这一事实先讲）。
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
  // 保存成功当刻即清空输入（早于第二动作）。
  deps.onCreated(recordId);
  deps.onSaved();

  const second = organize ? quickSecondActionFor(mode) : null;
  if (second === null) {
    return { kind: "saved", flash: "已保存。原文已经在这台电脑上了。" };
  }

  try {
    await deps.enqueueJob(recordId);
  } catch (cause) {
    const failure = failurePlanOf(cause);
    return {
      kind: "saved-organize-failed",
      warn: `原文已保存（就在这台电脑上）。${failure.headline}`,
      technical: failure.technical,
    };
  }
  deps.onQueued(recordId);
  return { kind: "saved-queued" };
}
