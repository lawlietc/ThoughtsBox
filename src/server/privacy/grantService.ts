import { randomBytes } from "node:crypto";

import { newId } from "../../shared/contracts/ids.ts";
import type { Database } from "../db/adapter.ts";
import { deleteMeta, getMeta, setMeta } from "../db/migrator.ts";
import {
  LOCAL_LLM_POLICY_VERSION,
  RAW_SEND_POLICY_VERSION,
  REDACTION_POLICY_VERSION,
  collectKnownEntities,
  isRedactionKind,
  redact,
  sha256OfText,
  type ExtraRedactionCandidate,
  type KnownEntity,
  type RedactionMap,
} from "./redaction.ts";

/**
 * 发送前预览与 `CloudSendGrant` 签发/复用/不适用（M2-3 / D8）。
 *
 * 契约取值：Spec §5.2、§6.2、指令 §7.2/§7.3、Schema §3.6 与 §7.3〔K-17〕。
 *
 * 「失效」在这份契约里**没有状态位**：`cloud_send_grant` 只有身份/哈希列加一个内容轴标签，
 * 复用键是 `UNIQUE(record_revision_id, send_content_mode, payload_sha256, policy_version)`。
 * 所以失效不是某个动作的结果，而是键不再被满足——原文变了（新 revision）、
 * 待发送内容变了（payload 哈希变）、策略变了（policy_version 变）、记录删了（FK CASCADE），
 * 旧行都自动对不上号。加一个 `revoked` 列反而是发明契约外的语义，故本服务只提供
 * 「按当前内容查适用授权」这一个入口，不存在「拿旧授权发出去」这条路。
 *
 * 原文授权同样是**复用**口径（0D 草案 §四/§七，2026-10-24 定）：与脱敏授权同构，命中四元组即放行，
 * 不引入 `consumed_at_utc`、不提供 `consumeGrant`。代价如实写进产品文案：同一 revision 内容未改时
 * 的重复后台重跑会静默重发原文；改一个字即新 revision，届时必须重新确认。
 *
 * 本服务对业务表只写 `cloud_send_grant` 一张，且永不写原文（表内不存待发送文本本体，§3.6）；
 * 脱敏映射随 preview 返回，由 M2-5 写进 run 行的 `pipeline_manifest.redactionMap`（仅本地）。
 * 唯一的例外写入是运行期缓存：`app_meta` 里**每个档位各一套键**（M3-GRANT-1 / M9-D-8 / M9-D-9 / M9-D-13）——
 * 规则档两键（nonce、最终载荷）＋本地模型档三键（自己的 nonce、自己的载荷、采信区间）
 * ＋一枚本地模型档独有的**咨询失败标记**（`preview_llm_failed:<rev>`，值是封闭枚举），
 * 键前缀与敏感面核对见下方缓存常量注释；app_meta 不进导出、不进上传组装路径。
 * raw 轨道对 app_meta **零读零写**（见 `prepareRawPreview`）：那套键存在的唯一作用是让占位符
 * nonce 在预览→确认→解析三段之间逐字稳定，而那一轨没有 nonce。
 */

/**
 * 授权表那一域的 `send_content_mode` 取值（0D 草案 §二）。
 *
 * 与 `enums.json` 的记录轴（`redacted|raw|none`，0008）**不是一个定义域**——enums.json
 * `send_content_mode_domains` 明文：「不得引用本清单当同一份，否则出现『三值 CHECK 里塞两值』的漂移」。
 * 这里的 'none' 没有意义：不外发就不会有授权行。字面量与 0009 的列 CHECK 逐项同序，
 * 由 `tests/m6-0d-raw-grant.test.ts` 的静态对账钉住。
 */
export const GRANT_SEND_CONTENT_MODES = ["redacted", "raw"] as const;
export type GrantSendContentMode = (typeof GRANT_SEND_CONTENT_MODES)[number];

/**
 * 复核队列问「这条外发腿有没有授权」时的三条腿（M10-2）：两条脱敏档 + 原文轨。
 *
 * 前两个取值与 `PreviewOptions.tier` 同一套名字（各档的载荷缓存键由 `keysForTier` 给出），
 * `raw` 不是档位而是另一条轨道——它的载荷没有缓存键，就是该版本自己的原文。
 */
export type GrantPayloadLeg = "rules" | "local_llm" | "raw";

/**
 * 每一轨的**缺省起点**策略版本（0D 草案 §三）：`redacted` 跟脱敏策略走，`raw` 跟
 * 「发送原文这一行为的契约版本」走。两个取值互不命中，因此一条轨道的授权不可能被另一条命中。
 *
 * 它不再是 `issueGrant` 的判据（M9-4a / M9-D-6）：脱敏轨现在接受一个封闭集，见
 * `REDACTED_TRACK_POLICY_VERSIONS`。留着是因为「这一档从哪个版本起步」仍由装配层读它。
 */
export function grantPolicyVersionFor(mode: GrantSendContentMode): string {
  return mode === "raw" ? RAW_SEND_POLICY_VERSION : REDACTION_POLICY_VERSION;
}

/**
 * 脱敏轨允许的策略版本（封闭集）：K-17 靠它判断「这一份预览能不能签发」。
 *
 * 两条取值互不顶替：`rules-v1` 的授权覆盖不到本地模型档多遮的那些区间，反之亦然，
 * 所以两档各自成一行、各自命中（准则 §五 P2）。集合外的任何值（含 `rules-v2` 这类
 * 拼写漂移）都签不出去——升版必须由人改动这里，不由运行期的字符串凑出来。
 */
export const REDACTED_TRACK_POLICY_VERSIONS = [REDACTION_POLICY_VERSION, LOCAL_LLM_POLICY_VERSION] as const;

/**
 * 「这一轨 + 这个策略版本」是否允许签发（M9-D-6）。raw 轨仍然只认 `raw-v1`：
 * 两条轨道绝不能互相顶替（草案 §六 断言 3，双向），所以这里按 mode 分支而不是并成一个集合。
 */
export function isGrantablePolicyVersion(mode: GrantSendContentMode, policyVersion: string): boolean {
  if (mode === "raw") return policyVersion === RAW_SEND_POLICY_VERSION;
  return (REDACTED_TRACK_POLICY_VERSIONS as readonly string[]).includes(policyVersion);
}

export interface CloudSendGrantRow {
  readonly id: string;
  readonly record_revision_id: string;
  readonly send_content_mode: GrantSendContentMode;
  /** 脱敏文本的哈希。raw 行没有脱敏文本 ⇒ 恒为 NULL（0009 的组合 CHECK 在库里钉死这一配对）。 */
  readonly redacted_sha256: string | null;
  readonly payload_sha256: string;
  readonly policy_version: string;
  readonly confirmed_at_utc: string;
}

interface RevisionRecord {  readonly id: string;
  readonly record_id: string;
  readonly revision_number: number;
  readonly raw_text: string;
}

export interface LlmLayerSummary {
  /** 本次预览**采信**了本地模型层（候选为空数组也算跑过）；回落时如实为 false。 */
  readonly used: boolean;
  readonly candidates: number;
  readonly dropped: number;
  /** 未跑成的原因（`not_loopback` / `timeout` / `invalid_json` …），仅 `used:false` 时有意义。 */
  readonly failureKind?: string;
}

/**
 * 发送预览（指令 §7.2 的第 3–5 步）：这就是**实际准备发送的那份内容**，
 * 用户看到的与发出去的必须逐字相同（§7.2 末段：不能先调用模型再显示「本来打算发送」的预览）。
 */
export interface SendPreview {
  readonly recordId: string;
  readonly recordRevisionId: string;
  readonly revisionNumber: number;
  /** 这份预览属于哪一条外发轨道（0D 草案 §二）：授权四元组的第二腿，签发与匹配都按它分道。 */
  readonly sendContentMode: GrantSendContentMode;
  readonly policyVersion: string;
  /** 规则与实体脱敏后的文本；raw 轨道上它等于原文本身（没有脱敏这一步）。 */
  readonly redactedText: string;
  /** 实际待发送文本：默认等于脱敏文本；用户在预览里手工替换后即为替换结果。 */
  readonly payloadText: string;
  /** 脱敏文本的哈希。raw 轨道没有脱敏文本 ⇒ null，不拿原文哈希冒充它。 */
  readonly redactedSha256: string | null;
  readonly payloadSha256: string;
  /** 原文↔脱敏文本的区间映射：本地凭据，不进 payload、不进导出、不进 Trace。 */
  readonly map: RedactionMap;
  /**
   * 逐处来源（M9-3 / 准则 §五）：`map.spans` 的投影，只留 UI 需要的那几列。
   * 单列出来是为了让预览 DTO 的装配方不必理解偏移算术就能标注「这一处是谁遮的」。
   */
  readonly spans: readonly {
    readonly kind: string;
    readonly placeholder: string;
    readonly source: string;
    readonly originalStart: number;
    readonly originalEnd: number;
    /** 词表来源时指向 `entity.id`，其余来源为 `null`（预览面「从词表去掉」用）。 */
    readonly entityId: string | null;
  }[];
  /** 本地模型这一层这次到底用上了没有——UI 的「这次本地模型没用上（原因）」读它。 */
  readonly llmLayer: LlmLayerSummary;
}

export interface PreviewOptions {
  /** 用户在预览里手工替换后的待发送文本（§7.2 第 5 步）。 */
  readonly payloadText?: string;
  /** 注入实体清单只为测试可控；缺省从 `entity` + `entity_alias` 现读。 */
  readonly entities?: readonly KnownEntity[];
  /** 注入单次请求占位符的随机量，同上只为测试可复现。 */
  readonly nonce?: string;
  /**
   * 本地模型层候选（已由其来源校验过区间与词面）。**出现即声明这一档跑过了**——空数组也是：
   * 「模型跑完了，只是没报出可采信的区间」与「这一档根本没跑」是两种语义，前者升 policy、
   * 后者维持 `rules-v1`（准则 §五 P1）。
   */
  readonly llmSpans?: readonly ExtraRedactionCandidate[];
  /** 本地模型层丢掉的候选数，只进 `llmLayer` 上报，不参与任何替换判定。 */
  readonly llmDropped?: number;
  /** 这一档没跑成的原因；给了它通常就不给 `llmSpans`（回落路径）。 */
  readonly llmFailureKind?: string;
  /**
   * 预览档位（M9-D-8）：由三轴的 `redaction_mode` 显式指定，**不由「有没有传 `llmSpans`」推测**。
   *
   * - `rules`（缺省）：行为与 M9-3 之前逐字相同，只读写 `preview_nonce:` / `preview_payload:`，
   *   三个 `preview_llm_*` 键**不读不写**。
   * - `local_llm` + `llmSpans`：首次预览（op6）——用它们脱敏并落自己的三键（`preview_llm_nonce` /
   *   `preview_llm_payload` / `preview_llm_spans`）。
   * - `local_llm` 无 `llmSpans`：复现预览（op7/op2）——区间从 `preview_llm_spans` 读回重算，
   *   缺键即抛 `LocalLlmTierCacheMissingError`，**绝不静默退回规则档**（隐私降级 + 哈希漂移）。
   *
   * 不传时按 M9-3 的既有语义推断（`llmSpans !== undefined` ⇒ `local_llm`），显式值优先。
   */
  readonly tier?: "rules" | "local_llm";
}

export interface IssueGrantOptions {
  /** 注入确认时刻只为测试可断言；缺省取当前 UTC。 */
  readonly confirmedAtUtc?: string;
}

/**
 * 预览产物缓存的键前缀（M3-GRANT-1 / 风险 R-2）。**每个档位一套**（M9-D-9，2026-10-29 定）：
 * 规则档两键（`preview_nonce:` / `preview_payload:`，逐字不变）＋本地模型档三键（`preview_llm_*`）。
 *
 * 机理：占位符 `[kind_index_nonce]` 里的 nonce 若每次预览都随机，预览→确认→解析三段的
 * payload_sha256 永不对齐，op7 签发的 grant 在 op2 永远不可用。裁定取向：**nonce 同一
 * revision 内复用**；revision 是内容版本本身（内容编辑产生新 revision id），跨 revision
 * 换新 nonce 不破坏防串发。
 *
 * 档位隔离是 `preview_llm_*` 这三键存在的**唯一理由**：两档共用 `preview_nonce:` /
 * `preview_payload:` 会串档——LLM 档先预览 ⇒ 载荷键里躺着含 LLM 占位符的文本；用户改回规则档
 * 再预览 ⇒ `cachedPayload` 把那份文本当缺省待发送载荷，而 `redactedText` 与 `map` 是纯规则的，
 * `redactedSha256` 与 `payloadSha256` 于是描述两份不同的东西，且 `map` 里没有那些 LLM span，
 * 回锚（`resolveEvidenceToOriginal`）对模型引用到的 `[place_1_…]` 一律判 null，静默落证据修复。
 * 反向同理：共用一个 nonce 键时，任一档重写 nonce 都会让另一档**已缓存的载荷**内部占位符过期。
 * 各档读写自己的键之后，这条串档路径在构造上就不存在了，不需要任何「读之前判档位」的特例。
 *
 * 缓存面最小化（实测结论）：回锚只消费 `map.spans` 的坐标与占位符字面，从不读 `map.nonce`
 * 字段本体；spans 又可由 raw_text + 已知实体 + nonce 确定性重算 ⇒ **映射本体不缓存**，
 * 只缓存 ① nonce（保证重算逐字一致）与 ② 最终 payloadText 本体（承载手工替换）。
 * 本地模型档多出的第三键缓存的是**这一层的输入区间**（不是 `map`）：那一层不是确定性的
 * （问的是模型），不存下来就没有「重算」可言——见 `LLM_SPANS_CACHE_PREFIX`。
 *
 * 敏感面核对〔冻结·B9〕：payloadText 是脱敏后、经用户确认、本就注定上传的那份文本，缓存它不新增
 * 暴露；nonce 已内嵌于上传文本的占位符里；两档的这两类值内容同类，只是各归各的键（M9-D-9）。
 * 采信区间键只含 `kind` + 原文偏移，词面与原文本体不入：这些区间遮住的内容正是同档那份载荷的
 * 脱敏结果。六枚键都落 app_meta——该表被 JSONL 导出显式排除（m1b-jsonl 断言在案），且 Provider 的
 * request 组装路径（provider.requestBody）只读 ExtractionRequest 字段，与本表零接触。
 */
/**
 * 预览缓存 epoch（2026-11-04，rules-v2）。
 *
 * 脱敏规则集合变了，旧缓存里的 payload / spans 是**用旧规则算出来的**，不能在新规则下复用：
 * 否则用户看到的是旧载荷、发出去的是新哈希，授权永远对不上。把 epoch 写进键前缀之后，
 * 旧键自然读不到（它们留在 app_meta 里成为孤儿，不参与任何判定），新规则第一次预览重新算。
 */
const PREVIEW_CACHE_EPOCH = "v2";
const NONCE_CACHE_PREFIX = `preview_${PREVIEW_CACHE_EPOCH}_nonce:`;
const PAYLOAD_CACHE_PREFIX = `preview_${PREVIEW_CACHE_EPOCH}_payload:`;
/**
 * 本地模型档自己的 nonce / 载荷键（M9-D-9）：与上面两键**同构**（同样的值形态、同样的读写时机），
 * 唯一区别是属于哪一档。复用同一套读写代码，前缀由 `keysForTier` 给出。
 */
const LLM_NONCE_CACHE_PREFIX = `preview_llm_${PREVIEW_CACHE_EPOCH}_nonce:`;
const LLM_PAYLOAD_CACHE_PREFIX = `preview_llm_${PREVIEW_CACHE_EPOCH}_payload:`;
/**
 * 采信区间键（M9-D-8，2026-10-28 用户确认修正 D3）。
 *
 * 为什么必须有它：同一 revision 两次预览若拿到不同 nonce，载荷与哈希就不同，用户在 op6
 * 确认的那份到 op2 真正发送时对不上号，授权永不命中——这一档只能看不能发。本键补上「重算所需的
 * 那一层」；另两键同属这一档（`preview_llm_nonce` / `preview_llm_payload`），规则档从不触碰。
 *
 * 敏感面核对〔与 B9 同口径〕：值是 `JSON.stringify([{kind,start,end}, …])`——**不含原文，
 * 也不含词面**（`surface` 在落盘前逐条剥掉）。偏移本身已由同档的 `preview_llm_payload` 覆盖
 * （那份载荷就是这些区间的产物），新增这一键不扩大暴露面。
 */
const LLM_SPANS_CACHE_PREFIX = `preview_llm_${PREVIEW_CACHE_EPOCH}_spans:`;

/**
 * 本地模型这一层没跑成的原因（封闭集，与 `localLlm.ts` 的产出逐字同集合）：
 * `not_loopback` / `timeout` 来自 `proposeRedactionCandidates` 本身，`network` / `http` /
 * `unstructured` 来自 `provider.sendChatCompletion`，`invalid_json` 是回稿解析失败那一格。
 * 这一清单同时是 `preview_llm_failed:<rev>` 的**取值域**——标记只说「没跑成，属于哪一类」，
 * 永远不装错误消息（指令 §11.2：日志与 app_meta 都不许带自由文本敏感面）。
 */
export const LOCAL_LLM_FAILURE_KINDS = [
  "not_loopback",
  "timeout",
  "network",
  "http",
  "invalid_json",
  "unstructured",
] as const;

/**
 * 咨询失败标记（M9-D-13）：`preview_llm_failed:<revisionId>`。
 *
 * 为什么必须有它：`local_llm` 档预览失败时回落到规则档，而规则档那份**就是用户看过并点头的那一份**。
 * 「这一档没跑过」与「这一档跑过、失败了、按回落那份给你」从此是可区分的事实：没有这枚标记，
 * op7 只能面对一个缺 spans 缓存的 local_llm 档（要么静默降档，要么永远签不出去）。
 * 有标记 ⇒ op7 按规则档签发；有区间缓存 ⇒ 按 `local_llm` 档签发；两者都没有 ⇒ 还没预览过，拒绝确认。
 */
const LLM_FAILED_CACHE_PREFIX = `preview_llm_${PREVIEW_CACHE_EPOCH}_failed:`;

/** 一个档位读写的那两枚同构键（nonce + 最终载荷）。 */
interface TierCacheKeys {
  readonly nonce: string;
  readonly payload: string;
}

/**
 * 档位 → 键前缀的唯一映射点（M9-D-9）。规则档那份逐字不变；`local_llm` 那份是新增的三个 `preview_llm_*`
 * 键里的两枚，第三枚（采信区间）本就只属于这一档，因此不在这里出现。
 */
function keysForTier(tier: "rules" | "local_llm"): TierCacheKeys {
  return tier === "local_llm"
    ? { nonce: LLM_NONCE_CACHE_PREFIX, payload: LLM_PAYLOAD_CACHE_PREFIX }
    : { nonce: NONCE_CACHE_PREFIX, payload: PAYLOAD_CACHE_PREFIX };
}

/** 落盘形态：只留 `{kind,start,end}` 三列。调用方递来的对象可能带 `surface`，这里逐条剥掉。 */
function llmSpansCacheValue(spans: readonly ExtraRedactionCandidate[]): string {
  return JSON.stringify(spans.map((span) => ({ kind: span.kind, start: span.start, end: span.end })));
}

/**
 * 读回来的区间先过一遍结构校验：`kind` 落在封闭集内、偏移是非负整数、`start < end`，
 * 且不超出本次 `raw_text` 的长度（超出说明这份缓存不属于这个内容版本）。
 * 任一不成立 ⇒ `null`，由调用方抛错：**损坏的缓存不许被当成有效凭据**。
 */
function parseLlmSpansCache(value: string, rawTextLength: number): ExtraRedactionCandidate[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const spans: ExtraRedactionCandidate[] = [];
  for (const entry of parsed) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return null;
    const span = entry as Record<string, unknown>;
    if (typeof span.kind !== "string" || !isRedactionKind(span.kind)) return null;
    const { start, end } = span;
    if (typeof start !== "number" || typeof end !== "number") return null;
    if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
    if (start < 0 || end <= start || end > rawTextLength) return null;
    spans.push({ kind: span.kind, start, end });
  }
  return spans;
}

/**
 * 清掉给定 revision 的预览缓存**六个**键（M3-RED-1 修的 GRANT-1 残行 + M9-4a 的第三键 +
 * M9-D-9 的档位隔离 + M9-D-13 的咨询失败标记）。
 *
 * 记录硬删除后，规则档的 `preview_nonce:<rev>` / `preview_payload:<rev>`、本地模型档的
 * `preview_llm_nonce:<rev>` / `preview_llm_payload:<rev>` / `preview_llm_spans:<rev>` 与
 * `preview_llm_failed:<rev>` 若不清，敏感载荷文本与采信区间会永驻 app_meta，违 K-09「硬删除不留痕」
 * 意图。删除路径按 revision_id 精确删这六键。键结构、前缀字面与 `storePreviewArtifacts` /
 * `storeLlmTierArtifacts` / `markLlmConsultFailed` 逐字同源（此处是唯一真相，避免两处漂移）。
 */
export function purgePreviewCache(db: Database, revisionIds: readonly string[]): void {
  for (const revisionId of revisionIds) {
    for (const keys of [keysForTier("rules"), keysForTier("local_llm")]) {
      deleteMeta(db, `${keys.nonce}${revisionId}`);
      deleteMeta(db, `${keys.payload}${revisionId}`);
    }
    deleteMeta(db, `${LLM_SPANS_CACHE_PREFIX}${revisionId}`);
    deleteMeta(db, `${LLM_FAILED_CACHE_PREFIX}${revisionId}`);
  }
}

export class RevisionNotFoundError extends Error {
  constructor(id: string) {
    super(`记录版本不存在：${id}`);
    this.name = "RevisionNotFoundError";
  }
}

/**
 * 缺本次授权 ⇒ 不得发出请求（Spec §5.2、M2 规格「缺本次授权的 cloud_redacted 不发请求」）。
 * 消息里只有内部 ID 与错误类别：原文、脱敏前载荷、真实姓名映射一律不得进日志（指令 §11.2）。
 */
export class CloudSendAuthorizationRequiredError extends Error {
  readonly recordRevisionId: string;
  readonly payloadSha256: string;
  readonly policyVersion: string;

  constructor(recordRevisionId: string, payloadSha256: string, policyVersion: string) {
    super(`该版本与载荷没有适用授权（需要用户确认后重新签发）：${recordRevisionId}`);
    this.name = "CloudSendAuthorizationRequiredError";
    this.recordRevisionId = recordRevisionId;
    this.payloadSha256 = payloadSha256;
    this.policyVersion = policyVersion;
  }
}

export class PolicyVersionError extends Error {
  constructor(found: string) {
    super(`预览携带的脱敏策略版本与当前实现不一致，拒绝签发：${found}`);
    this.name = "PolicyVersionError";
  }
}

/**
 * `local_llm` 档复现预览却拿不到「采信的区间」（键不存在 / 缓存结构不成立）⇒ 抛（M9-D-8）。
 *
 * 这一档**没有**「退回规则档」这条路：静默降级既把用户点过的隐私承诺换成了更弱的一档，
 * 又让载荷哈希与用户确认的那份漂移——两样都必须在调用方看得见的时候失败。
 *
 * 消息里只有 revisionId 与缺键原因类别：原文、词面、缓存值本体一律不得进日志（指令 §11.2）。
 */
export class LocalLlmTierCacheMissingError extends Error {
  readonly recordRevisionId: string;
  readonly reason: "absent" | "malformed";

  constructor(recordRevisionId: string, reason: "absent" | "malformed") {
    super(
      reason === "absent"
        ? `本地模型档没有可复现的采信区间缓存，拒绝退回规则档：${recordRevisionId}`
        : `本地模型档的采信区间缓存结构不成立，拒绝当作有效凭据：${recordRevisionId}`,
    );
    this.name = "LocalLlmTierCacheMissingError";
    this.recordRevisionId = recordRevisionId;
    this.reason = reason;
  }
}

export interface GrantServiceOptions {
  readonly now?: () => Date;
}

export class GrantService {
  private readonly db: Database;
  private readonly now: () => Date;

  constructor(db: Database, options: GrantServiceOptions = {}) {
    this.db = db;
    this.now = options.now ?? (() => new Date());
  }

  private revisionRow(id: string): RevisionRecord {
    const row = this.db
      .prepare("select id, record_id, revision_number, raw_text from record_revision where id = ?")
      .get(id) as RevisionRecord | undefined;
    if (row === undefined) throw new RevisionNotFoundError(id);
    return row;
  }

  /** §7.2 第 1 步：取该记录的**当前** RecordRevision，再走脱敏与预览。 */
  currentRevisionIdOf(recordId: string): string {
    const row = this.db.prepare("select current_revision_id from capture_record where id = ?").get(recordId) as
      | { current_revision_id: string }
      | undefined;
    if (row === undefined) throw new RevisionNotFoundError(recordId);
    return row.current_revision_id;
  }

  preparePreviewForRecord(recordId: string, options: PreviewOptions = {}): SendPreview {
    return this.preparePreview(this.currentRevisionIdOf(recordId), options);
  }

  /**
   * 该版本的原文（只在本地读取，不外发）。异步装配层（`localLlmPreview`）需要它来向本地模型
   * 征询候选——候选坐标锚定的就是这份 `raw_text`；`redact()` 保持同步，不自己读库。
   */
  rawTextOfRevision(recordRevisionId: string): string {
    return this.revisionRow(recordRevisionId).raw_text;
  }

  /**
   * §7.2 第 2–4 步：读原文 → 本地脱敏 → 生成实际待发送 payload。
   * 原文只读不写；除缓存落库（app_meta 里本档那套键，最多三枚）外对业务表零写入（禁区：脱敏后的文本不得回写原始记录）。
   *
   * 档位由 `options.tier` 显式决定（M9-D-8），**每档读写自己那套键**（M9-D-9）：
   *  - `rules`：`preview_nonce` / `preview_payload`，三个 `preview_llm_*` 键**不读不写**——
   *    这一档的行为与 M9-3 之前逐字相同。
   *  - `local_llm` + 给了 `llmSpans`（首次，op6）：用它们脱敏，落 `preview_llm_nonce` /
   *    `preview_llm_payload` / `preview_llm_spans` 三键。载荷自己现算，不把缓存里那份载荷当默认值
   *    （用户看到的必须是这一档的脱敏结果）。
   *  - `local_llm` 没给 `llmSpans`（复现，op7/op2）：读那三键——区间重算、nonce 与载荷照旧，
   *    于是这份载荷与 op6 逐字相同、刚签的那行授权命中得上。缺 spans 键 ⇒ 抛
   *    `LocalLlmTierCacheMissingError`，绝不静默退回规则档；缺载荷键 ⇒ 回落到本档现算的脱敏文本
   *    （与规则档同一取向：缓存是加速与承载手工替换，不是唯一真相）。
   *
   * 显式注入 nonce 的调用（测试可控）完全绕过缓存：不读写、不落盘，两档同口径。
   *
   * LLM 档产出的 `policyVersion` 是 `rules+local_llm-v1`，它现在**在签发口在册**
   * （`REDACTED_TRACK_POLICY_VERSIONS` / M9-D-6）：这一档确认的那份能签、能命中，不再是只能看。
   */
  preparePreview(recordRevisionId: string, options: PreviewOptions = {}): SendPreview {
    const revision = this.revisionRow(recordRevisionId);
    const entities = options.entities ?? collectKnownEntities(this.db);
    // 显式 tier 优先；不传时按 M9-3 的既有语义推断，因此那一批的调用点不改也能跑。
    const tier = options.tier ?? (options.llmSpans !== undefined ? "local_llm" : "rules");
    const llmSpansGiven = options.llmSpans !== undefined;
    // 「这一层跑过没有」（M9-D-5）：给了候选，或 local_llm 档的复现路径，都算跑过 ⇒ 升 policy。
    const llmUsed = tier === "local_llm" || llmSpansGiven;
    const useCache = options.nonce === undefined;
    const keys = keysForTier(tier);
    const nonce = useCache ? this.cachedNonce(revision.id, keys) : options.nonce;
    const llmSpans = llmSpansGiven
      ? options.llmSpans
      : tier === "local_llm"
        ? this.readLlmSpansCache(revision.id, revision.raw_text)
        : undefined;
    const { redactedText, map } = redact(revision.raw_text, entities, {
      ...(nonce === undefined ? {} : { nonce }),
      ...(llmUsed ? { extraCandidates: llmSpans ?? [], policyVersion: LOCAL_LLM_POLICY_VERSION } : {}),
    });
    // 首预览（给了 `llmSpans`）的缺省载荷必须是本档现算的脱敏文本，因此不读自己那份载荷键；
    // 复现路径读回来，才承载得住用户在预览里手工替换的那一份。载荷键缺失时回落到现算文本
    // （与规则档同一取向：缓存是加速与承载手工替换，不是唯一真相）。
    const readOwnPayloadCache = useCache && !llmSpansGiven;
    const payloadText =
      options.payloadText ??
      (readOwnPayloadCache ? this.cachedPayload(revision.id, keys) : undefined) ??
      redactedText;
    if (useCache && nonce !== undefined) {
      if (tier === "local_llm") this.storeLlmTierArtifacts(revision.id, keys, nonce, payloadText, llmSpans ?? []);
      else this.storePreviewArtifacts(revision.id, keys, nonce, payloadText);
    }
    return {
      recordId: revision.record_id,
      recordRevisionId: revision.id,
      revisionNumber: revision.revision_number,
      sendContentMode: "redacted",
      policyVersion: map.policyVersion,
      redactedText,
      payloadText,
      redactedSha256: sha256OfText(redactedText),
      payloadSha256: sha256OfText(payloadText),
      map,
      spans: map.spans.map((span) => ({
        kind: span.kind,
        placeholder: span.placeholder,
        source: span.source,
        originalStart: span.originalStart,
        originalEnd: span.originalEnd,
        entityId: span.entityId ?? null,
      })),
      llmLayer: {
        used: llmUsed,
        candidates: llmSpans?.length ?? 0,
        dropped: options.llmDropped ?? 0,
        ...(options.llmFailureKind === undefined ? {} : { failureKind: options.llmFailureKind }),
      },
    };
  }

  /**
   * 原文外发（`send_content_mode=raw`，草案 §三 矩阵 #9）的预览：载荷就是该版本自己的原文。
   *
   * 不调用 `redact()`（0D 草案 §五）：脱敏一旦跑过就产出占位符，那份文本与「不脱敏」这条承诺矛盾；
   * 也让 `redacted_sha256` 免遭「拿脱敏哈希冒充原文授权」的语义污染——raw 行没有脱敏文本，
   * 于是该列就是 NULL（0009 的组合 CHECK 在库里把这层配对钉死）。映射取恒等形态
   * （`policyVersion=raw-v1`、`spans=[]`）：空 spans 让 `redactedRangeToOriginal` 原样返回原文偏移，
   * 现有投影函数因此无需第二个分支（草案 §五）。
   *
   * 对 app_meta **零读零写**，不新增独立缓存键（草案 §五 给的第二个选项在此没有存在的理由）：
   * 那两键存在的唯一作用是让占位符 nonce 在预览→确认→解析三段之间逐字稳定，而 raw 轨道
   * 没有 nonce、载荷又是 revision 自身的确定性函数（`raw_text` 本体，且装配层拒绝替换文本，
   * 见 `previewForEgress`），三段本来必然算出同一个哈希。把原文写进**任一档的载荷键**
   * （`preview_payload:<rev>` / `preview_llm_payload:<rev>`）
   * 反而有害：该键的既有语义是「脱敏后、经用户确认的那份载荷」（本文件头 敏感面核对〔冻结·B9〕），
   * 混入原文会让此后该 revision 的**脱敏**缺省载荷漂向宽松一侧。`nonce: ""` 只活在这份内存
   * map 里，不落盘、不进 payload、不进导出。
   */
  prepareRawPreview(recordRevisionId: string): SendPreview {
    const revision = this.revisionRow(recordRevisionId);
    const payloadText = revision.raw_text;
    return {
      recordId: revision.record_id,
      recordRevisionId: revision.id,
      revisionNumber: revision.revision_number,
      sendContentMode: "raw",
      policyVersion: RAW_SEND_POLICY_VERSION,
      redactedText: payloadText,
      payloadText,
      redactedSha256: null,
      payloadSha256: sha256OfText(payloadText),
      map: { policyVersion: RAW_SEND_POLICY_VERSION, nonce: "", spans: [] },
      spans: [],
      llmLayer: { used: false, candidates: 0, dropped: 0 },
    };
  }

  private cachedNonce(revisionId: string, keys: TierCacheKeys): string {
    const cached = getMeta(this.db, `${keys.nonce}${revisionId}`);
    if (cached !== undefined) return cached;
    // 占位符的一次性随机量语义不变：每个 revision 首预览生成一次，之后该 revision 内复用。
    return randomBytes(3).toString("hex");
  }

  private cachedPayload(revisionId: string, keys: TierCacheKeys): string | undefined {
    return getMeta(this.db, `${keys.payload}${revisionId}`);
  }

  private storePreviewArtifacts(revisionId: string, keys: TierCacheKeys, nonce: string, payloadText: string): void {
    setMeta(this.db, `${keys.nonce}${revisionId}`, nonce);
    setMeta(this.db, `${keys.payload}${revisionId}`, payloadText);
  }

  /**
   * 本地模型档的三键：自己的 nonce、自己的最终载荷、采信区间（M9-D-9）。前两键与规则档
   * **同一段代码**（`storePreviewArtifacts`），只是 `keys` 给的是 `preview_llm_*` 那一套；
   * 区间由 `llmSpansCacheValue` 剥成 `{kind,start,end}` 三列后落盘。
   */
  private storeLlmTierArtifacts(
    revisionId: string,
    keys: TierCacheKeys,
    nonce: string,
    payloadText: string,
    spans: readonly ExtraRedactionCandidate[],
  ): void {
    setMeta(this.db, `${LLM_SPANS_CACHE_PREFIX}${revisionId}`, llmSpansCacheValue(spans));
    this.storePreviewArtifacts(revisionId, keys, nonce, payloadText);
  }

  /**
   * 这一档本 revision 有没有已落盘的采信区间（M9-4c / 任务 §0c、E5）。
   *
   * 只答「有没有」，不答「健不健康」：结构校验仍然只在复现路径那一次做
   * （`readLlmSpansCache`，损坏的缓存照旧抛 `LocalLlmTierCacheMissingError`）。
   * 装配层用它决定「这次 op6 要不要去咨询模型」——问过一次的 revision 不再问第二次，
   * 两次预览才拿得到逐字相同的载荷。
   */
  hasCachedLlmSpans(recordRevisionId: string): boolean {
    return getMeta(this.db, `${LLM_SPANS_CACHE_PREFIX}${recordRevisionId}`) !== undefined;
  }

  /**
   * 记下「这一档咨询过模型、没跑成，原因是 X」（M9-D-13）。
   *
   * 只认 `LOCAL_LLM_FAILURE_KINDS` 里的封闭取值：清单之外的字符串（含任何错误消息）一律不落盘——
   * 这一枚键的存在理由就是把「失败过」变成一条**被记住的事实**，它不该顺带把文本带进库里。
   */
  markLlmConsultFailed(recordRevisionId: string, failureKind: string): void {
    if (!(LOCAL_LLM_FAILURE_KINDS as readonly string[]).includes(failureKind)) return;
    setMeta(this.db, `${LLM_FAILED_CACHE_PREFIX}${recordRevisionId}`, failureKind);
  }

  /** 咨询成功 ⇒ 标记作废：此后「有没有区间缓存」重新成为唯一的事实，两枚键不该同时说话。 */
  clearLlmConsultFailed(recordRevisionId: string): void {
    deleteMeta(this.db, `${LLM_FAILED_CACHE_PREFIX}${recordRevisionId}`);
  }

  /**
   * 强制重跑（F-2）：「重跑脱敏」时清掉本地模型档这一版的缓存，让下一次预览重新咨询模型。
   *
   * 只清 `local_llm` 档——nonce/payload 复用 `keysForTier("local_llm")`，外加 spans 与 failed 两键。
   * 规则档 `preview_*` 一字不动：规则档不涉模型，强制重跑对它没有意义。键结构、前缀字面
   * 与 `purgePreviewCache` / `storeLlmTierArtifacts` / `markLlmConsultFailed` 逐字同源，避免漂移。
   *
   * 清完之后 `hasCachedLlmSpans` 变假 ⇒ 装配层会真的再问一次模型；成功则重新落三键，
   * 失败则 `markLlmConsultFailed` + 抛 `LocalLlmConsultFailedError`（PD-2 阻断不变）。
   */
  clearLlmTierCache(recordRevisionId: string): void {
    const keys = keysForTier("local_llm");
    deleteMeta(this.db, `${keys.nonce}${recordRevisionId}`);
    deleteMeta(this.db, `${keys.payload}${recordRevisionId}`);
    deleteMeta(this.db, `${LLM_SPANS_CACHE_PREFIX}${recordRevisionId}`);
    deleteMeta(this.db, `${LLM_FAILED_CACHE_PREFIX}${recordRevisionId}`);
  }

  /**
   * 这一档最近一次咨询有没有失败、属于哪一类；没有标记 ⇒ `undefined`。
   *
   * 这里**不做任何降档**：读到标记之后该走规则档是装配层的显式决定（`resolveLocalLlmPreview` /
   * `previewForConfirmSend`），服务层不替调用方改主意，也不把「有标记」当成「这一档跑过了」。
   */
  llmConsultFailedKind(recordRevisionId: string): string | undefined {
    const kind = getMeta(this.db, `${LLM_FAILED_CACHE_PREFIX}${recordRevisionId}`);
    return kind === undefined ? undefined : kind;
  }

  /**
   * 这一档采信了几处（M10-2 队列的「遮了几处」）。
   *
   * 纯读：把 `preview_llm_spans:<rev>` 数一遍。**结构不成立 ⇒ 0**，不抛也不当成「这一档跑过」——
   * 队列是观测面，一枚坏缓存不该让整个列表 500；签发口自有那道
   * `LocalLlmTierCacheMissingError`（`readLlmSpansCache`），两处判据不同是刻意的。
   * 只返回**数**：区间本体（含偏移）留在这里，不进响应（断言 C4）。
   */
  llmSpanCount(recordRevisionId: string): number {
    const cached = getMeta(this.db, `${LLM_SPANS_CACHE_PREFIX}${recordRevisionId}`);
    if (cached === undefined) return 0;
    let parsed: unknown;
    try {
      parsed = JSON.parse(cached);
    } catch {
      return 0;
    }
    return Array.isArray(parsed) ? parsed.length : 0;
  }

  /**
   * 本档的最终载荷在不在册（M10-2 队列的「本机算好了没有」）。只看键，不现算脱敏。
   *
   * 原文轨没有这一问（载荷恒等于该版本原文），所以调用方只在脱敏轨上问它。
   */
  hasCachedPayload(recordRevisionId: string, tier: "rules" | "local_llm"): boolean {
    return this.cachedPayload(recordRevisionId, keysForTier(tier)) !== undefined;
  }

  /**
   * 这一条外发腿有没有已确认的授权（M10-2 队列的 `hasGrant`）——四腿全等，判据与
   * `requireApplicableGrant` 逐字同一条，只是不抛。
   *
   * 载荷一律**取在册的那份**（脱敏轨读 `preview_payload:` / `preview_llm_payload:`，原文轨取该版本
   * 自己的 `raw_text`），缺载荷 ⇒ `false`。这里绝不为了凑一个哈希去调 `preparePreview`：
   * 那既会现算一次脱敏（把只读投影变成「算一次」），又会顺手写回 nonce 与载荷两键（断言 C1 当场红）。
   */
  hasApplicableGrantForPayload(recordRevisionId: string, leg: GrantPayloadLeg): boolean {
    if (leg === "raw") {
      const payload = this.revisionRow(recordRevisionId).raw_text;
      return (
        this.findApplicableGrant(
          recordRevisionId,
          sha256OfText(payload),
          RAW_SEND_POLICY_VERSION,
          "raw",
        ) !== null
      );
    }
    const payload = this.cachedPayload(recordRevisionId, keysForTier(leg));
    if (payload === undefined) return false;
    const policyVersion = leg === "local_llm" ? LOCAL_LLM_POLICY_VERSION : REDACTION_POLICY_VERSION;
    return this.findApplicableGrant(recordRevisionId, sha256OfText(payload), policyVersion, "redacted") !== null;
  }

  /**
   * 复现路径读回采信区间。缺键与「读回来但结构不成立」都抛
   * `LocalLlmTierCacheMissingError`：损坏的缓存不许被当成有效凭据，也不许被当作「这一档没跑」
   * 而顺带走规则档（那既降级隐私又漂哈希）。
   */
  private readLlmSpansCache(revisionId: string, rawText: string): ExtraRedactionCandidate[] {
    const cached = getMeta(this.db, `${LLM_SPANS_CACHE_PREFIX}${revisionId}`);
    if (cached === undefined) throw new LocalLlmTierCacheMissingError(revisionId, "absent");
    const spans = parseLlmSpansCache(cached, rawText.length);
    if (spans === null) throw new LocalLlmTierCacheMissingError(revisionId, "malformed");
    return spans;
  }

  /**
   * 签发（K-17 复用规则的落点）：同一 revision 上 `(send_content_mode, payload_sha256, policy_version)`
   * 相同即复用已有授权并保留**首次**确认时刻；不同则另建一行。
   * 不做「顺手更新 confirmed_at」——那会让一次旧授权在被复用时看起来是刚确认的。
   *
   * raw 与 redacted 走这同一段代码，不区分、也没有第二条入口（0D 草案 §四「复用口径」）：
   * 差别全部体现在 preview 自带的两腿上（内容轴 + 该轴的策略版本），库里因此不可能出现
   * 「为原文另设的消费状态」这类契约外语义。
   *
   * 「该轴的策略版本」按 `isGrantablePolicyVersion` 的封闭集判（M9-D-6）：脱敏轨 `rules-v1` 与
   * `rules+local_llm-v1` 都在册（两档各签一行、互不命中），raw 轨仍只认 `raw-v1`。
   */
  issueGrant(preview: SendPreview, options: IssueGrantOptions = {}): CloudSendGrantRow {
    // 每一轨只认自己那一支**在册**的策略版本：拿脱敏预览去签 raw 授权（或反之）在这里就断掉；
    // 脱敏轨在册的是封闭集（`rules-v1` | `rules+local_llm-v1`），集合外的值同样在这里就断掉（M9-D-6）。
    if (!isGrantablePolicyVersion(preview.sendContentMode, preview.policyVersion)) {
      throw new PolicyVersionError(preview.policyVersion);
    }
    const existing = this.findApplicableGrant(
      preview.recordRevisionId,
      preview.payloadSha256,
      preview.policyVersion,
      preview.sendContentMode,
    );
    if (existing !== null) return existing;

    const row: CloudSendGrantRow = {
      id: newId("cloudSendGrant"),
      record_revision_id: preview.recordRevisionId,
      send_content_mode: preview.sendContentMode,
      redacted_sha256: preview.redactedSha256,
      payload_sha256: preview.payloadSha256,
      policy_version: preview.policyVersion,
      confirmed_at_utc: options.confirmedAtUtc ?? this.now().toISOString(),
    };
    this.db
      .prepare(
        `insert into cloud_send_grant (id, record_revision_id, send_content_mode, redacted_sha256, payload_sha256, policy_version, confirmed_at_utc)
         values (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.record_revision_id,
        row.send_content_mode,
        row.redacted_sha256,
        row.payload_sha256,
        row.policy_version,
        row.confirmed_at_utc,
      );
    return row;
  }

  /**
   * 逐版本授权的唯一入口：四个绑定项全等才存在适用授权（0009 的 UNIQUE 四元组）。
   * `sendContentMode` 是一腿而不是一句注释：raw 的授权不可能被脱敏发送命中，反之亦然
   * （草案 §六 断言 3，双向）。复用口径下这里**没有**任何消费状态可查（草案 §四/§七）。
   */
  findApplicableGrant(
    recordRevisionId: string,
    payloadSha256: string,
    policyVersion: string,
    sendContentMode: GrantSendContentMode,
  ): CloudSendGrantRow | null {
    const row = this.db
      .prepare(
        `select id, record_revision_id, send_content_mode, redacted_sha256, payload_sha256, policy_version, confirmed_at_utc
         from cloud_send_grant
         where record_revision_id = ? and send_content_mode = ? and payload_sha256 = ? and policy_version = ?`,
      )
      .get(recordRevisionId, sendContentMode, payloadSha256, policyVersion) as CloudSendGrantRow | undefined;
    return row ?? null;
  }

  grantForPreview(preview: SendPreview): CloudSendGrantRow | null {
    return this.findApplicableGrant(
      preview.recordRevisionId,
      preview.payloadSha256,
      preview.policyVersion,
      preview.sendContentMode,
    );
  }

  /**
   * 发送前的闸门：没有适用授权就抛，调用方因此拿不到任何可发送的东西。
   * 授权与 `processing_mode` / `processing_status` 相互独立，不得互相推断（K-17），
   * 所以这里只看授权本身，不看记录被标成了什么模式。
   * 闸门判「是否外发」按三轴（0C），外发**哪一轨**按 `sendContentMode` 这一腿（0D）：
   * 少了它，原文授权就能被脱敏发送顶掉，或反过来把用户的「发送原文」点头当成脱敏许可。
   */
  requireApplicableGrant(
    recordRevisionId: string,
    payloadSha256: string,
    policyVersion: string,
    sendContentMode: GrantSendContentMode,
  ): CloudSendGrantRow {
    const found = this.findApplicableGrant(recordRevisionId, payloadSha256, policyVersion, sendContentMode);
    if (found === null) {
      throw new CloudSendAuthorizationRequiredError(recordRevisionId, payloadSha256, policyVersion);
    }
    return found;
  }
}
/**
 * 唯一「离开本机」的内容：待发送文本本体。
 * 单独成函数是为了让「映射不出本机」这条断言有明确的对象可查——
 * 脱敏映射、真实姓名与偏移只存在于本地库的 run 行与内存里的 preview 中。
 */
export function outboundRequestText(preview: SendPreview): string {
  return preview.payloadText;
}
