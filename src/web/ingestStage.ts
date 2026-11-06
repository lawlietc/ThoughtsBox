/**
 * 待整理页右侧「操作」框的阶段判据（〔web-redesign 第三步〕）。
 *
 * 为什么单独一个纯函数：这一框以前用四五个布尔在渲染里互相纠缠
 * （`egressSelected` / `cloudNeedsConfirmation` / `canStartOrganize` / `parseReady` / `jobView`），
 * 「什么状态下显示哪颗键」只能靠人脑在 JSX 里推。收成一个函数之后：
 * 一个入口、六种阶段，每阶段的标题与动作都在这张表里，node 侧能逐态断言。
 *
 * `loading` 是**用户碰不到的瞬时态**：进屏即自动取预览（只读、不发请求），
 * 取到就直接是 `needs-grant`。它不是一个"步骤"，所以那一格没有可点的动作 ——
 * 让用户为「看一眼」专门点一次，等于把一次没有选择的点击伪装成一个阶段。
 *
 * 本机档（不涉发送）没有 `loading` / `needs-grant`：不发送，就不该出现"看要发的内容"这种事。
 */

export type IngestStage =
  | "blocked"
  | "queued"
  | "loading"
  | "needs-grant"
  | "failed"
  | "ready";

export interface IngestStageInput {
  /** 本机解析能力就绪（`config.ingestReady`）。 */
  readonly parseReady: boolean;
  /** 这条走云端（三轴里 `analysis_provider=cloud`）。 */
  readonly cloud: boolean;
  /** 已经取到这份载荷的预览。 */
  readonly hasPreview: boolean;
  /** 这份载荷拿到了**本次**发送授权。 */
  readonly hasGrant: boolean;
  /** 后台任务仍在排队/处理。 */
  readonly jobActive: boolean;
  /** 上一次整理失败。 */
  readonly lastFailed: boolean;
}

/** 阶段名。写在这里而不是 JSX 里：它是状态的一部分，不是某次渲染的临时文案。 */
export const INGEST_STAGE_LABEL: Readonly<Record<IngestStage, string>> = Object.freeze({
  blocked: "解析未就绪",
  queued: "后台处理中",
  loading: "读取发送内容",
  "needs-grant": "等你确认",
  failed: "整理失败",
  ready: "可以整理",
});

/**
 * 主按键的动词。`loading` 与 `queued` 都按不动（前者在等本机，后者在跑），
 * 所以它们的动词只是占位，不让这一格在两种宽度下跳字。
 */
export const INGEST_STAGE_ACTION: Readonly<Record<IngestStage, string>> = Object.freeze({
  blocked: "去设置",
  queued: "发起整理",
  loading: "发起整理",
  "needs-grant": "确认并整理",
  failed: "重试整理",
  ready: "发起整理",
});

/**
 * 顺序是有意的：
 * 1. 没解析能力时什么都做不了 —— 先拦；
 * 2. 后台在跑时不再问「要不要确认」—— 那一单已经在路上了，界面不该同时开第二个决定；
 * 3. 云端先过关：预览还没取到 → 读取中；有预览没授权 → 确认；两关都过才轮到「可以整理」；
 * 4. 剩下的按上次成败分。
 */
export function ingestStageOf(input: IngestStageInput): IngestStage {
  if (!input.parseReady) return "blocked";
  if (input.jobActive) return "queued";
  if (input.cloud) {
    if (!input.hasPreview) return "loading";
    if (!input.hasGrant) return "needs-grant";
  }
  if (input.lastFailed) return "failed";
  return "ready";
}

/** 这一阶段要不要画「发送方式」那一行（只有云端、且已经取到预览时才谈得上发送方式）。 */
export function stageShowsSendSettings(stage: IngestStage): boolean {
  return stage === "needs-grant" || stage === "ready";
}

/** 这一阶段的主按键按不按得动。`loading` 是在等本机，不是等用户。 */
export function stagePrimaryEnabled(stage: IngestStage): boolean {
  return stage !== "loading" && stage !== "queued";
}
