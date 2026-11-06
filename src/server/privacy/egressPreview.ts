import type { ThreeAxes } from "../../shared/contracts/enums.ts";
import { IngestInputError } from "../ingest/ingestService.ts";
import type { GrantPayloadLeg, GrantService, SendPreview } from "./grantService.ts";

/**
 * 外发轨的**载荷装配**（草案 §五 的表、§三 矩阵 #9）。
 *
 * 存在的前提是 M6-1D：同步入口 `runParse` 与后台执行体都要「按 `send_content_mode` 现算这次
 * 真的准备发出去的那份文本」，而预览与授权四元组必须同源——两处各写一遍就等于允许两条轨道
 * 上「用户看到的」和「实际发送的」分岔。所以这里只有一份实现，行为与被抽出前逐字相同。
 *
 * 依赖只到 `GrantService`（服务层），不到 HTTP 面：路由与执行体各自把自己的 workspace 服务面递进来。
 *
 * M9-4b 起这一层不再管档位：`assertImplementedRedactionPlan` 换成了
 * `provider.assertRedactionPlanRunnable`——判据从「这一档没实现」变成「这一档没配置好」，
 * 与发送前那道门叫的是同一个函数（错误类住在 provider 那侧，反向 import 会构成模块环）。
 * 四个调用点的 import 因此改指 `ingest/provider.ts`，位置一个都没挪。
 *
 * M9-4d-pre（M9-D-13）在这一层加了确认入口 `previewForConfirmSend`：它和 `previewForEgress`
 * 一样是**同步复现**语义（确认不许咨询模型），区别只在它把「没缓存」这一事实按标记分成两种——
 * 回落过 ⇒ 照用户看过的规则档那份签；从没预览过 ⇒ 409。档位判据 `isLocalLlmRedactedTrack`
 * 是本文件唯一的档位判断点，异步装配层（`localLlmPreview.ts`）也调它，不另写一遍。
 */

/**
 * 「这一份预览属不属于本地模型辅助档的脱敏轨」——三处入口共用的**唯一**判据（M9-D-13）。
 *
 * 两个条件缺一不可：
 *  - `redaction_mode != local_llm` ⇒ 本档从没存在过，规则档行为逐字不变。
 *  - `send_content_mode != redacted` ⇒ 没有要外发的脱敏载荷，问了模型也没有对象，
 *    那三枚 `preview_llm_*` 键根本不该被读写（`none` 轨上按 local_llm 档复现还会抛缺键，
 *    把一条从没跑过的轨道说成「缓存坏了」）。
 */
export function isLocalLlmRedactedTrack(axes: ThreeAxes): boolean {
  return axes.redactionMode === "local_llm" && axes.sendContentMode === "redacted";
}

/**
 * op7（用户明确确认）那一份预览：**只复现，绝不咨询模型**。
 *
 * 确认绑定的是「用户看过的那一份」，咨询会现算出一份新载荷——那等于让用户对一个没见过的文本点头
 * （§7.2 末段）。M9-D-13 之后这一档有三种事实，逐条对应一个分支：
 *  - 采信区间在册 ⇒ 按 `local_llm` 档复现，签 `rules+local_llm-v1`；
 *  - 没有区间但有咨询失败标记 ⇒ 用户看过的就是**回落那份**（规则档），签 `rules-v1`；
 *  - 两者都没有 ⇒ 这条 revision 从没预览过 ⇒ 抛 `LocalLlmNotPreviewedError`（409），零签发。
 *
 * 第三个分支不许静默走规则档：那样「先签一张规则档授权、再发」就成了绕过本档预览的捷径。
 */
export function previewForConfirmSend(
  grants: GrantService,
  revisionId: string,
  axes: ThreeAxes,
  payloadText?: string,
): SendPreview {
  if (isLocalLlmRedactedTrack(axes) && !grants.hasCachedLlmSpans(revisionId)) {
    // PD-2（2026-11-04）：本机模型档不签规则档授权。没跑成就是没跑成，唯一出路是
    // 重试本机模型，或把记录的 redaction_mode 显式改成 manual 后重新预览。
    throw new LocalLlmNotPreviewedError(revisionId);
  }
  return previewForEgress(grants, revisionId, axes, payloadText);
}

/**
 * 三条件都不成立（没缓存、没标记）⇒ 用户还没看过任何一份本档的预览（M9-D-13）。
 *
 * 不复用 `LocalLlmTierCacheMissingError`：那个错误说的是「缓存坏了或没了」，这一条说的是
 * 「还没预览」。两种事实对外必须是两个码，客户端才分得清「先去预览」与「缓存出问题了」。
 * 消息里只有 revisionId，没有原文与词面。
 */
export class LocalLlmNotPreviewedError extends Error {
  readonly recordRevisionId: string;

  constructor(recordRevisionId: string) {
    super(`本地模型辅助脱敏档还没有一次预览可供确认，请先预览一次：${recordRevisionId}`);
    this.name = "LocalLlmNotPreviewedError";
    this.recordRevisionId = recordRevisionId;
  }
}

/**
 * 本次外发的载荷来源，按 `send_content_mode` 分道（草案 §五 的表：闸门判「是否外发」，
 * 不再判 `processing_mode === "cloud_redacted"`——`cloud_raw` 因此**复用**同一套预览 + 授权装配）：
 *  - `redacted`：脱敏预览，可带用户在预览里替换后的文本（§7.2 第 5 步）；映射本次现算，绝不上线。
 *    档位按 `redaction_mode` 显式选（M9-D-8），且只在**脱敏轨**上选（M9-D-13）：`local_llm` +
 *    `redacted` ⇒ `tier:"local_llm"` 的**复现**路径（采信区间从 `preview_llm_spans:<rev>` 读回重算，
 *    缺键即抛，不退回规则档）；`local_llm` + `none` 没有要外发的载荷，本档那三键根本没有对象 ⇒
 *    按规则档装配（「问了也没有对象」这一条与 op6 同口径）。其余取值 ⇒ `tier:"rules"`，
 *    行为与之前逐字相同。这里**不调模型**——征询发生在装配层（`resolveLocalLlmPreview`），
 *    本函数因此保持同步。
 *  - `raw`：载荷只能是该版本自己的原文（§三 矩阵 #9）。替换文本一律拒——要改内容请走 editRecord
 *    生成新 revision，那才有「新内容 = 新授权」的逐版本绑定可言。
 */
export function previewForEgress(
  grants: GrantService,
  revisionId: string,
  axes: ThreeAxes,
  payloadText?: string,
): SendPreview {
  if (axes.sendContentMode === "raw") {
    const preview = grants.prepareRawPreview(revisionId);
    if (payloadText !== undefined && payloadText !== preview.payloadText) {
      throw new IngestInputError(
        `send_content_mode=raw 的待发送载荷只能是该版本自己的原文，预览替换文本不被接受：${revisionId}`,
      );
    }
    return preview;
  }
  return grants.preparePreview(revisionId, {
    ...(payloadText === undefined ? {} : { payloadText }),
    tier: isLocalLlmRedactedTrack(axes) ? "local_llm" : "rules",
  });
}

/**
 * 这一档的外发要问哪几条授权腿（**唯一**落点）。
 *
 * 原文轨一条（载荷就是该版本原文）；`local_llm` 脱敏轨**两条**——本机模型没跑成时用户看过并签下的是
 * 规则档回落那份（M9-D-13），只问 `local_llm` 那条会把已确认过的那份说成「没确认过」；其余一条 `rules`。
 * 只在 `send_content_mode ≠ none` 的外发轨上问：`none` 轨没有要发的载荷，问出来那句「没授权」是假的。
 */
export function grantLegsFor(axes: ThreeAxes): readonly GrantPayloadLeg[] {
  if (axes.sendContentMode === "raw") return ["raw"];
  return isLocalLlmRedactedTrack(axes) ? ["local_llm", "rules"] : ["rules"];
}

/**
 * 这几条腿上有没有一条已经签下本次授权（四腿全等，判据在 `GrantService` 那一侧，这里不查库）。
 *
 * 抽出来是因为现在有**两个**问题问的是同一件事：收件箱那一格「待确认发送」（观测面）与后台队列
 * 「这一行此刻能不能认领」（执行面）。两处各写一遍，就可能一处说「等你确认」、另一处已经把内容发出去。
 */
export function hasApplicableGrantForAxes(grants: GrantService, revisionId: string, axes: ThreeAxes): boolean {
  return grantLegsFor(axes).some((leg) => grants.hasApplicableGrantForPayload(revisionId, leg));
}
