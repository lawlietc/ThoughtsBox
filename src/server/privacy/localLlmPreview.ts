/**
 * M9-3 / M9-4d-pre：本地模型候选 → 预览的**异步装配**（执行准则 §五 末段、裁决 M9-D-13）。
 *
 * `redact()` 与 `preparePreview` 保持同步（禁区），所以「先问模型、再脱敏」这段等待只能
 * 外置到这一层。三个入口都走 `resolveEgressPreview`（op6 预览、op2/入队、后台执行体）：
 * 「这次要不要咨询模型」因此只有一处判定，路由与执行体不各判一遍。op7 不走这里——确认
 * 不许咨询模型，它走同步的 `previewForConfirmSend`。
 *
 * 回落纪律（准则 §一-4「失败不降级到更弱隐私，只回落到规则+记忆并显示出来」）：
 * 本地模型没跑成 ⇒ 走**不带 LLM 层**的预览，policy 维持 `rules-v1`，同时把
 * `dropped` / `failureKind` 如实填进 `llmLayer`。绝不在失败时谎报 `used:true`。
 *
 * M9-D-13 改的是失败的**后果**：失败不再等价于「这一档没跑过」。回落结果是一条被记住的事实
 * （`app_meta` 里的 `preview_llm_failed:<rev>`，值是封闭的 failureKind），用户对着回落那份点过头
 * 就能签发 `rules-v1`；发送前再咨询一次模型——
 *  - 模型恢复 ⇒ 产出的载荷与用户确认过的那份不同 ⇒ 哈希不符 ⇒ 现有四腿授权检查抛 409，
 *    请用户重新预览确认（不再新增「自动重新确认」）；
 *  - 模型仍失败 ⇒ 按用户**看过的**那份（规则档回落）照发。
 */

import type { ThreeAxes } from "../../shared/contracts/enums.ts";
import type { ModelAdapter } from "../ingest/provider.ts";
import { isLocalLlmRedactedTrack, previewForEgress } from "./egressPreview.ts";
import { proposeRedactionCandidates } from "./localLlm.ts";
import type { GrantService, PreviewOptions, SendPreview } from "./grantService.ts";

export interface LocalLlmPreviewOptions extends PreviewOptions {
  /** 注入 fetch 只为测试离线可控；生产路径走真回环端点。 */
  readonly fetchImpl?: typeof fetch;
}

/**
 * 本机模型档咨询失败（2026-11-04 裁决 PD-2）。
 *
 * 旧行为是「失败 ⇒ 回落规则档 + 留标记」，用户看到的只是小字提示，照发就把没检查过的
 * 名字/地名带出去了。现在改为**阻断**：`local_llm` 轨不产出任何可签发的预览；
 * 想用规则档，必须显式把记录的 `redaction_mode` 改成 `manual`（三轴变了，用户看到的那份也变了）。
 *
 * 消息只带 revisionId 与封闭 failureKind，不带原文、词面、URL 凭据。
 */
export class LocalLlmConsultFailedError extends Error {
  readonly recordRevisionId: string;
  readonly failureKind: string;

  constructor(recordRevisionId: string, failureKind: string) {
    super(`本机模型辅助脱敏没有跑成（${failureKind}）：${recordRevisionId}——已阻断，不回落规则档`);
    this.name = "LocalLlmConsultFailedError";
    this.recordRevisionId = recordRevisionId;
    this.failureKind = failureKind;
  }
}

/**
 * 这次要给用户／要发送的预览：`local_llm` 档在必要时咨询一次模型，失败则如实回落并留下标记。
 *
 * 四种状态，按顺序判：
 *  1. `adapter === null`（这一档没配置好）⇒ 连一次请求都不发，落 `tier:"rules"`，**不写标记**：
 *     标记说的是「问过没问成」，而这里根本没问。路由在更早处已按可用性判过（`assertRedactionPlanRunnable`），
 *     走到这里拿到 `null` 属防御性分支。
 *  2. 采信区间在册 ⇒ **复现**（`tier:"local_llm"`），不咨询、不动标记。少了这一短路，两次预览
 *     就可能拿到两套候选 ⇒ 载荷漂移 ⇒ 用户点头的那份与真正发出去的那份不再是同一份（M9-D-8）。
 *  3. 咨询成功 ⇒ `tier:"local_llm"` + 采信区间，落本档三键，**清掉**标记（成功过就不该再留着失败的说法）。
 *  4. 咨询失败 ⇒ `tier:"rules"` + `llmDropped`/`llmFailureKind`，**写下**标记。这一份就是此后
 *     op7 能签、op2 能发的那一份。
 */
export async function resolveLocalLlmPreview(
  grants: GrantService,
  adapter: ModelAdapter | null,
  recordRevisionId: string,
  options: LocalLlmPreviewOptions = {},
): Promise<SendPreview> {
  const { fetchImpl, ...previewOptions } = options;
  const deps = fetchImpl === undefined ? {} : { fetchImpl };

  if (adapter === null) {
    throw new LocalLlmConsultFailedError(recordRevisionId, "not_configured");
  }

  if (grants.hasCachedLlmSpans(recordRevisionId)) {
    return grants.preparePreview(recordRevisionId, { ...previewOptions, tier: "local_llm" });
  }

  const rawText = grants.rawTextOfRevision(recordRevisionId);
  const proposal = await proposeRedactionCandidates(adapter, rawText, deps);
  if (!proposal.ok) {
    const failureKind = proposal.failureKind ?? "network";
    grants.markLlmConsultFailed(recordRevisionId, failureKind);
    // PD-2：不再回落规则档。规则档只遮格式类；名字/地名没检查就发，等于把隐私承诺降级。
    throw new LocalLlmConsultFailedError(recordRevisionId, failureKind);
  }

  grants.clearLlmConsultFailed(recordRevisionId);
  return grants.preparePreview(recordRevisionId, {
    ...previewOptions,
    tier: "local_llm",
    llmSpans: proposal.candidates,
    llmDropped: proposal.dropped,
  });
}

/**
 * 三个外发入口（op6 预览、op2/手动入队、后台执行体）**唯一**的预览装配点。
 *
 * 判据只有 `isLocalLlmRedactedTrack` 一条：只有「本地模型档 + 脱敏轨」才可能咨询模型，
 * 其余（`raw` 轨、`none`、`manual` / `none` 档）逐字走 `previewForEgress` 的既有分支。
 * 调用方因此不需要知道这一档什么时候该问模型——`runParse`、`enqueueForRecord`、执行体三处
 * 各自判一遍就等于允许三条轨道上「用户看到的」与「发出去的」分岔。
 */
export async function resolveEgressPreview(
  grants: GrantService,
  adapter: ModelAdapter | null,
  revisionId: string,
  axes: ThreeAxes,
  options: LocalLlmPreviewOptions = {},
): Promise<SendPreview> {
  if (isLocalLlmRedactedTrack(axes)) {
    return resolveLocalLlmPreview(grants, adapter, revisionId, options);
  }
  return previewForEgress(grants, revisionId, axes, options.payloadText);
}
