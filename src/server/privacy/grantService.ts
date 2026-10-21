import { randomBytes } from "node:crypto";

import { newId } from "../../shared/contracts/ids.ts";
import type { Database } from "../db/adapter.ts";
import { deleteMeta, getMeta, setMeta } from "../db/migrator.ts";
import {
  REDACTION_POLICY_VERSION,
  collectKnownEntities,
  redact,
  sha256OfText,
  type KnownEntity,
  type RedactionMap,
} from "./redaction.ts";
import { deriveNameCandidates, type NameCandidate } from "./candidates.ts";
import {
  confirmCandidateEntities,
  type AdoptedCandidate,
  type ConfirmResult,
} from "./entityConfirm.ts";

/**
 * 发送前预览与 `CloudSendGrant` 签发/复用/不适用（M2-3 / D8）。
 *
 * 契约取值：Spec §5.2、§6.2、指令 §7.2/§7.3、Schema §3.6 与 §7.3〔K-17〕。
 *
 * 「失效」在这份契约里**没有状态位**：`cloud_send_grant` 只有六个身份/哈希列，
 * 复用键是 `UNIQUE(record_revision_id, payload_sha256, policy_version)`。
 * 所以失效不是某个动作的结果，而是键不再被满足——原文变了（新 revision）、
 * 待发送内容变了（payload 哈希变）、策略变了（policy_version 变）、记录删了（FK CASCADE），
 * 旧行都自动对不上号。加一个 `revoked` 列反而是发明契约外的语义，故本服务只提供
 * 「按当前内容查适用授权」这一个入口，不存在「拿旧授权发出去」这条路。
 *
 * 本服务对业务表只写 `cloud_send_grant` 一张，且永不写原文（表内不存待发送文本本体，§3.6）；
 * 脱敏映射随 preview 返回，由 M2-5 写进 run 行的 `pipeline_manifest.redactionMap`（仅本地）。
 * 唯一的例外写入是运行期缓存：预览产物的 nonce 与最终载荷落 `app_meta`（M3-GRANT-1，
 * 键前缀与敏感面核对见下方缓存常量注释；app_meta 不进导出、不进上传组装路径）。
 */

export interface CloudSendGrantRow {
  readonly id: string;
  readonly record_revision_id: string;
  readonly redacted_sha256: string;
  readonly payload_sha256: string;
  readonly policy_version: string;
  readonly confirmed_at_utc: string;
}

interface RevisionRecord {  readonly id: string;
  readonly record_id: string;
  readonly revision_number: number;
  readonly raw_text: string;
}

/**
 * 发送预览（指令 §7.2 的第 3–5 步）：这就是**实际准备发送的那份内容**，
 * 用户看到的与发出去的必须逐字相同（§7.2 末段：不能先调用模型再显示「本来打算发送」的预览）。
 */
export interface SendPreview {
  readonly recordId: string;
  readonly recordRevisionId: string;
  readonly revisionNumber: number;
  readonly policyVersion: string;
  /** 规则与实体脱敏后的文本。 */
  readonly redactedText: string;
  /** 实际待发送文本：默认等于脱敏文本；用户在预览里手工替换后即为替换结果。 */
  readonly payloadText: string;
  readonly redactedSha256: string;
  readonly payloadSha256: string;
  /** 原文↔脱敏文本的区间映射：本地凭据，不进 payload、不进导出、不进 Trace。 */
  readonly map: RedactionMap;
}

export interface PreviewOptions {
  /** 用户在预览里手工替换后的待发送文本（§7.2 第 5 步）。 */
  readonly payloadText?: string;
  /** 注入实体清单只为测试可控；缺省从 `entity` + `entity_alias` 现读。 */
  readonly entities?: readonly KnownEntity[];
  /** 注入单次请求占位符的随机量，同上只为测试可复现。 */
  readonly nonce?: string;
}

export interface IssueGrantOptions {
  /** 注入确认时刻只为测试可断言；缺省取当前 UTC。 */
  readonly confirmedAtUtc?: string;
}

/**
 * 预览产物缓存的两个 app_meta 键前缀（M3-GRANT-1 / 风险 R-2）。
 *
 * 机理：占位符 `[kind_index_nonce]` 里的 nonce 若每次预览都随机，预览→确认→解析三段的
 * payload_sha256 永不对齐，op7 签发的 grant 在 op2 永远不可用。裁定取向：**nonce 同一
 * revision 内复用**；revision 是内容版本本身（内容编辑产生新 revision id），跨 revision
 * 换新 nonce 不破坏防串发。
 *
 * 缓存面最小化（实测结论）：回锚只消费 `map.spans` 的坐标与占位符字面，从不读 `map.nonce`
 * 字段本体；spans 又可由 raw_text + 已知实体 + nonce 确定性重算 ⇒ **映射本体不缓存**，
 * 只缓存 ① nonce（保证重算逐字一致）与 ② 最终 payloadText 本体（承载手工替换）。
 *
 * 敏感面核对〔冻结·B9〕：两条缓存值都不含映射（无 spans/坐标/真实词面）。payloadText 是
 * 脱敏后、经用户确认、本就注定上传的那份文本，缓存它不新增暴露；nonce 已内嵌于上传文本的
 * 占位符里。缓存落 app_meta——该表被 JSONL 导出显式排除（m1b-jsonl 断言在案），且 Provider
 * 的 request 组装路径（provider.requestBody）只读 ExtractionRequest 字段，与本表零接触。
 */
const NONCE_CACHE_PREFIX = "preview_nonce:";
const PAYLOAD_CACHE_PREFIX = "preview_payload:";

/**
 * 清掉给定 revision 的预览缓存两键（M3-RED-1 修的 GRANT-1 残行）。
 *
 * 记录硬删除后，其 `preview_nonce:<rev>` / `preview_payload:<rev>` 若不清，敏感载荷文本会
 * 永驻 app_meta，违 K-09「硬删除不留痕」意图。删除路径按 revision_id 精确删这两键。
 * 键结构、前缀字面与 `storePreviewArtifacts` 逐字同源（此处是唯一真相，避免两处漂移）。
 */
export function purgePreviewCache(db: Database, revisionIds: readonly string[]): void {
  for (const revisionId of revisionIds) {
    deleteMeta(db, `${NONCE_CACHE_PREFIX}${revisionId}`);
    deleteMeta(db, `${PAYLOAD_CACHE_PREFIX}${revisionId}`);
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
   * §7.2 第 2–4 步：读原文 → 本地脱敏 → 生成实际待发送 payload。
   * 原文只读不写；除缓存落库（app_meta 两键）外对业务表零写入（禁区：脱敏后的文本不得回写原始记录）。
   *
   * nonce 与最终载荷按 revision 缓存复用（R-2 修复）：显式注入 nonce 的调用（测试可控）
   * 完全绕过缓存，不读写、不落盘。
   */
  preparePreview(recordRevisionId: string, options: PreviewOptions = {}): SendPreview {
    const revision = this.revisionRow(recordRevisionId);
    const entities = options.entities ?? collectKnownEntities(this.db);
    const useCache = options.nonce === undefined;
    const nonce = useCache ? this.cachedNonce(revision.id) : (options.nonce as string);
    const { redactedText, map } = redact(revision.raw_text, entities, { nonce });
    const payloadText = options.payloadText ?? (useCache ? this.cachedPayload(revision.id) : undefined) ?? redactedText;
    if (useCache) {
      this.storePreviewArtifacts(revision.id, nonce, payloadText);
    }
    return {
      recordId: revision.record_id,
      recordRevisionId: revision.id,
      revisionNumber: revision.revision_number,
      policyVersion: map.policyVersion,
      redactedText,
      payloadText,
      redactedSha256: sha256OfText(redactedText),
      payloadSha256: sha256OfText(payloadText),
      map,
    };
  }

  private cachedNonce(revisionId: string): string {
    const cached = getMeta(this.db, `${NONCE_CACHE_PREFIX}${revisionId}`);
    if (cached !== undefined) return cached;
    // 占位符的一次性随机量语义不变：每个 revision 首预览生成一次，之后该 revision 内复用。
    return randomBytes(3).toString("hex");
  }

  private cachedPayload(revisionId: string): string | undefined {
    return getMeta(this.db, `${PAYLOAD_CACHE_PREFIX}${revisionId}`);
  }

  private storePreviewArtifacts(revisionId: string, nonce: string, payloadText: string): void {
    setMeta(this.db, `${NONCE_CACHE_PREFIX}${revisionId}`, nonce);
    setMeta(this.db, `${PAYLOAD_CACHE_PREFIX}${revisionId}`, payloadText);
  }

  /**
   * 陌生名字候选（RED-1「已定」②a/②b）：从该 revision 原文现算，只进预览。
   * 与 `preparePreview` 分道——候选不进 `redact()` 替换集合，脱敏集合未变（policy 不升）。
   */
  deriveCandidates(recordRevisionId: string): NameCandidate[] {
    const revision = this.revisionRow(recordRevisionId);
    return deriveNameCandidates(revision.raw_text, collectKnownEntities(this.db));
  }

  /**
   * 确认采纳的候选 → provisional 实体（RED-1「已定」②c/③，零模型调用）。
   * 确认后作废该 revision 的预览缓存：脱敏依据变了（该词从此是已确认实体），
   * 下一次预览现算即被既有 `collectKnownEntities` 通道遮掉。非法 kind 由 entityConfirm 抛。
   */
  confirmCandidates(recordId: string, adopted: readonly AdoptedCandidate[]): ConfirmResult {
    const revisionId = this.currentRevisionIdOf(recordId);
    const result = confirmCandidateEntities(this.db, adopted);
    purgePreviewCache(this.db, [revisionId]);
    return result;
  }

  /**
   * 签发（K-17 复用规则的落点）：同一 revision 上 `(payload_sha256, policy_version)` 相同
   * 即复用已有授权并保留**首次**确认时刻；不同则另建一行。
   * 不做「顺手更新 confirmed_at」——那会让一次旧授权在被复用时看起来是刚确认的。
   */
  issueGrant(preview: SendPreview, options: IssueGrantOptions = {}): CloudSendGrantRow {
    if (preview.policyVersion !== REDACTION_POLICY_VERSION) throw new PolicyVersionError(preview.policyVersion);
    const existing = this.findApplicableGrant(
      preview.recordRevisionId,
      preview.payloadSha256,
      preview.policyVersion,
    );
    if (existing !== null) return existing;

    const row: CloudSendGrantRow = {
      id: newId("cloudSendGrant"),
      record_revision_id: preview.recordRevisionId,
      redacted_sha256: preview.redactedSha256,
      payload_sha256: preview.payloadSha256,
      policy_version: preview.policyVersion,
      confirmed_at_utc: options.confirmedAtUtc ?? this.now().toISOString(),
    };
    this.db
      .prepare(
        `insert into cloud_send_grant (id, record_revision_id, redacted_sha256, payload_sha256, policy_version, confirmed_at_utc)
         values (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.record_revision_id,
        row.redacted_sha256,
        row.payload_sha256,
        row.policy_version,
        row.confirmed_at_utc,
      );
    return row;
  }

  /** 逐版本授权的唯一入口：三个绑定项全等才存在适用授权。 */
  findApplicableGrant(
    recordRevisionId: string,
    payloadSha256: string,
    policyVersion: string,
  ): CloudSendGrantRow | null {
    const row = this.db
      .prepare(
        `select id, record_revision_id, redacted_sha256, payload_sha256, policy_version, confirmed_at_utc
         from cloud_send_grant
         where record_revision_id = ? and payload_sha256 = ? and policy_version = ?`,
      )
      .get(recordRevisionId, payloadSha256, policyVersion) as CloudSendGrantRow | undefined;
    return row ?? null;
  }

  grantForPreview(preview: SendPreview): CloudSendGrantRow | null {
    return this.findApplicableGrant(preview.recordRevisionId, preview.payloadSha256, preview.policyVersion);
  }

  /**
   * 发送前的闸门：没有适用授权就抛，调用方因此拿不到任何可发送的东西。
   * 授权与 `processing_mode` / `processing_status` 相互独立，不得互相推断（K-17），
   * 所以这里只看授权本身，不看记录被标成了什么模式。
   */
  requireApplicableGrant(
    recordRevisionId: string,
    payloadSha256: string,
    policyVersion: string,
  ): CloudSendGrantRow {
    const found = this.findApplicableGrant(recordRevisionId, payloadSha256, policyVersion);
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
