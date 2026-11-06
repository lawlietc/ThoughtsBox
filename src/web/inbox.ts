import { isEgress } from "../shared/contracts/enums.ts";
import type { InboxNextAction, PendingRecordDto, ReviewQueueEntryDto } from "../shared/dto.ts";
import { STATUS_LABEL } from "./ui/labels.ts";
import { SEND_TRACK_LABEL, trackOfAxes } from "./sendTrack.ts";

/**
 * 待整理页唯一的收件箱（S5）：只列「此刻需要你动作」的记录，一行给出唯一下一步。
 *
 * 为什么单独一层：服务端有两份只读投影（`/api/ingest/pending` 与非外发记录的队列项），
 * 界面不该把两份原始形状直接摊到 JSX 里让人脑去重、去排序。这里做一次合并，
 * 让「一行 ↔ 一个动作」在 node 侧就能逐项断言。
 */

export interface InboxRow {
  readonly recordId: string;
  readonly title: string;
  readonly meta: string;
  readonly nextAction: InboxNextAction;
  readonly egress: boolean;
  readonly failed: boolean;
  /** 只有缺授权的外发行才配复选框：批量确认就是一次签多张逐条授权。 */
  readonly confirmable: boolean;
  /** 这一条是否已拿到可用的发送授权（非外发 pending 恒为 true：本机整理无需授权）。 */
  readonly hasGrant: boolean;
  /** 是否配复选框（批量确认 / 批量发起整理都从勾选来）：`nextAction ∈ {confirm, organize}`。 */
  readonly selectable: boolean;
  /** 是否可选入「批量发起整理」：`nextAction ∈ {confirm, organize}`（retry/wait 不算）。 */
  readonly organizable: boolean;
  readonly retryable: boolean;
  readonly checkingSinceMs: number | null;
}

/** 行的动作文案。`failed` 的整理不是「去整理」，是「重试整理」。 */
export function inboxActionLabel(row: Pick<InboxRow, "nextAction" | "failed">): string {
  switch (row.nextAction) {
    case "confirm":
      return "确认发送";
    case "retry":
      return "重新检查";
    case "wait":
      return "等待本机检查";
    case "organize":
      return row.failed ? "重试整理" : "去整理";
  }
}

const ACTION_RANK: Readonly<Record<InboxNextAction, number>> = Object.freeze({
  retry: 0,
  confirm: 1,
  organize: 2,
  wait: 3,
});

function pendingTitle(record: PendingRecordDto): string {
  const text = record.preview.trim();
  return text === "" ? "（无内容）" : text.slice(0, 40);
}

function queueTitle(entry: ReviewQueueEntryDto): string {
  return `v${entry.revisionNumber} · ${SEND_TRACK_LABEL[trackOfAxes(entry.axes)]}`;
}

function queueMeta(entry: ReviewQueueEntryDto): string {
  const status = STATUS_LABEL[entry.processingStatus] ?? entry.processingStatus;
  // D-1：行内只留一句基础状态。轨道/待确认这些细节回到右侧操作框里。
  return status;
}

function pendingMeta(record: PendingRecordDto): string {
  // D-1：一句基础状态；整理方式在右侧操作框/记录详情里看。
  return STATUS_LABEL[record.processingStatus] ?? record.processingStatus;
}

/**
 * 合并两份投影并去重。
 *
 * 外发行以队列项为准（它有授权/载荷/本机模型三格），`pending` 里同名的那条只用来取本地摘要；
 * 非外发的待整理记录队列里没有，单独补进来。完成态（`parsed` 等）在服务端已经不算动作项，
 * 这里不再二次判断——两份投影各自是那件事的权威。
 */
export function buildInboxRows(
  pending: readonly PendingRecordDto[],
  queue: readonly ReviewQueueEntryDto[],
): readonly InboxRow[] {
  const previewById = new Map(pending.map((row) => [row.recordId, row]));
  const rows: InboxRow[] = [];

  for (const entry of queue) {
    if (!entry.needsAction || entry.nextAction === null) continue;
    const local = previewById.get(entry.recordId);
    const title = local === undefined ? queueTitle(entry) : pendingTitle(local);
    rows.push({
      recordId: entry.recordId,
      title,
      meta: queueMeta(entry),
      nextAction: entry.nextAction,
      egress: true,
      failed: entry.processingStatus === "failed",
      confirmable: entry.nextAction === "confirm",
      hasGrant: entry.hasGrant,
      selectable: entry.nextAction === "confirm" || entry.nextAction === "organize",
      organizable: entry.nextAction === "confirm" || entry.nextAction === "organize",
      retryable: entry.nextAction === "retry",
      checkingSinceMs: entry.checkingSinceUtc === null ? null : Date.parse(entry.checkingSinceUtc),
    });
  }

  for (const record of pending) {
    if (isEgress(record.axes)) continue;
    rows.push({
      recordId: record.recordId,
      title: pendingTitle(record),
      meta: pendingMeta(record),
      nextAction: "organize",
      egress: false,
      failed: record.processingStatus === "failed",
      confirmable: false,
      hasGrant: true,
      selectable: true,
      organizable: true,
      retryable: false,
      checkingSinceMs: null,
    });
  }

  // 同类里的先后沿用服务端顺序（队列已按「不确定的顶上去」排好，待整理按创建时间）。
  return rows.sort((a, b) => ACTION_RANK[a.nextAction] - ACTION_RANK[b.nextAction]);
}
