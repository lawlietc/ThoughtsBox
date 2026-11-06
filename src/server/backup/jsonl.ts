import { createHash } from "node:crypto";

import { z } from "zod";

import { loadEnums } from "../../shared/contracts/load.ts";
import { hasPrefix } from "../../shared/contracts/ids.ts";
import {
  assertThreeAxes,
  axesForProcessingMode,
  coerceAxes,
  deriveProcessingMode,
  isProcessingModeValue,
  type ThreeAxes,
} from "../../shared/contracts/enums.ts";
import { serializeTokens, tokenize } from "../../shared/search/tokenizer.ts";
import type { Database } from "../db/adapter.ts";
import { currentSchemaVersion, listMigrationFiles } from "../db/migrator.ts";

/**
 * JSONL 导出/导入契约（M1b §六）。
 *
 * 对象集合是**显式决定**，不是遗漏：导出只承载业务数据 `capture_record` + `record_revision`
 * （JSONL 的用途是跨安装迁移记录本身）。以下对象**不进契约**，理由各自独立成立：
 * - `deletion_audit`：属于「这个数据库文件」的履历。快照备份整库携带它；把审计流水
 *   搬进新库等于伪造另一台机器上的删除历史。
 * - `app_meta`（含备份缓存、存储维护任务）：**运行期状态不得盲目重放**——维护任务
 *   指向导出机器上的物理文件；恢复语义属于快照，不属于行数据。
 * - FTS 影子表：派生索引，由 record_ai 触发器在导入时重建，不携带。
 *
 * 导入前置校验不得绕过服务层与 DB CHECK/FK：这里是「先全量验票、后一次性提交」，
 * 提交时延迟外键在 COMMIT 处兜底，任何失败整批回滚，不留半导入状态。
 */

export const EXPORT_SCHEMA_VERSION = 1;

export class JsonlImportError extends Error {
  readonly issues: string[];
  readonly kind: "invalid" | "not_empty";

  constructor(message: string, issues: string[] = [], kind: "invalid" | "not_empty" = "invalid") {
    super(message);
    this.name = "JsonlImportError";
    this.issues = issues;
    this.kind = kind;
  }
}

const RECORD_COLUMNS = [
  "id",
  "created_at_utc",
  "created_at_local",
  "timezone_id",
  "created_local_date",
  "current_revision_id",
  "processing_status",
  "processing_mode",
  "privacy_level",
  // 三轴随导出（草案 §八之二-4 的裁决）：派生是**有损**的——`local+manual` 与
  // `local+local_llm` 都派生成 `local_model`，只带 `processing_mode` 的备份换机后反推不回原值。
  "analysis_provider",
  "redaction_mode",
  "send_content_mode",
] as const;

/** 导出行的列名集合（`toRecordRow` 与本清单逐键对齐，少一个键即编译不过）。 */
type RecordColumn = (typeof RECORD_COLUMNS)[number];

const REVISION_COLUMNS = [
  "id",
  "record_id",
  "revision_number",
  "raw_text",
  "content_sha256",
  "tokens",
  "created_at_utc",
  "created_at_local",
  "timezone_id",
] as const;

export interface ExportMetaLine {
  readonly line: "meta";
  readonly app: "ThoughtsBox";
  readonly export_schema_version: number;
  readonly database_schema_version: number;
  readonly exported_at_utc: string;
  /** 显式声明对象集合与排除项，让消费方不必靠猜。 */
  readonly object_types: readonly string[];
  readonly excluded_types: readonly string[];
}

const UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;
const LOCAL_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;
const LOCAL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const SHA_PATTERN = /^[0-9a-f]{64}$/;

const enums = loadEnums();

const closedEnum = (values: string[], label: string) =>
  z.string().refine((v) => values.includes(v), `${label} 不在封闭枚举内`);

const utcText = (label: string) =>
  z.string().refine((v) => UTC_PATTERN.test(v), `${label} 不是合法 UTC 文本`);

const metaLineSchema = z
  .object({
    line: z.literal("meta"),
    app: z.literal("ThoughtsBox"),
    export_schema_version: z.number().int(),
    database_schema_version: z.number().int(),
    exported_at_utc: z.string(),
    object_types: z.array(z.string()).optional(),
    excluded_types: z.array(z.string()).optional(),
  })
  .strict();

const recordLineSchema = z
  .object({
    line: z.literal("capture_record"),
    id: z.string().regex(/^rec_/),
    created_at_utc: utcText("created_at_utc"),
    created_at_local: z.string().refine((v) => LOCAL_PATTERN.test(v), "created_at_local 不是合法本地时刻文本"),
    timezone_id: z.string().min(1),
    created_local_date: z.string().refine((v) => LOCAL_DATE_PATTERN.test(v), "created_local_date 必须是 YYYY-MM-DD"),
    current_revision_id: z.string().regex(/^rev_/),
    processing_status: closedEnum(enums.processing_statuses, "processing_status"),
    processing_mode: closedEnum(enums.processing_modes, "processing_mode"),
    privacy_level: closedEnum(enums.privacy_levels, "privacy_level"),
    // 三轴可选**只为兼容**：0008 之前生成的 v1 导出文件里没有这三键，那份文件里的
    // `processing_mode` 只可能是旧三值，按草案 §四 的旧值映射反推是无损的。
    // 新导出的行三轴齐全；契约版本仍是 1（加键、且读侧宽容，不是一次破坏性变更）。
    analysis_provider: closedEnum(enums.analysis_providers, "analysis_provider").optional(),
    redaction_mode: closedEnum(enums.redaction_modes, "redaction_mode").optional(),
    send_content_mode: closedEnum(enums.send_content_modes, "send_content_mode").optional(),
  })
  .strict();

const revisionLineSchema = z
  .object({
    line: z.literal("record_revision"),
    id: z.string().regex(/^rev_/),
    record_id: z.string().regex(/^rec_/),
    revision_number: z.number().int().positive(),
    raw_text: z.string().min(1).refine((v) => v.trim() !== "", "raw_text 不能仅空白"),
    content_sha256: z.string().regex(SHA_PATTERN, "content_sha256 必须是 64 位小写十六进制"),
    tokens: z.string(),
    created_at_utc: utcText("created_at_utc"),
    created_at_local: z.string().refine((v) => LOCAL_PATTERN.test(v), "created_at_local 不是合法本地时刻文本"),
    timezone_id: z.string().min(1),
  })
  .strict();

function plain(row: unknown): Record<string, unknown> {
  return { ...(row as Record<string, unknown>) };
}

export function exportJsonl(
  db: Database,
  options: { now?: () => Date } = {},
): string {
  const meta: ExportMetaLine = {
    line: "meta",
    app: "ThoughtsBox",
    export_schema_version: EXPORT_SCHEMA_VERSION,
    database_schema_version: currentSchemaVersion(db),
    exported_at_utc: (options.now ?? (() => new Date()))().toISOString(),
    object_types: ["capture_record", "record_revision"],
    excluded_types: ["deletion_audit", "app_meta", "record_fts", "运行期存储维护任务"],
  };
  const records = db
    .prepare(`select ${RECORD_COLUMNS.join(", ")} from capture_record order by created_at_utc, id`)
    .all() as unknown[];
  const revisions = db
    .prepare(`select ${REVISION_COLUMNS.join(", ")} from record_revision order by record_id, revision_number`)
    .all() as unknown[];
  const lines = [
    JSON.stringify(meta),
    ...records.map((row) => JSON.stringify({ line: "capture_record", ...plain(row) })),
    ...revisions.map((row) => JSON.stringify({ line: "record_revision", ...plain(row) })),
  ];
  return `${lines.join("\n")}\n`;
}

interface ParsedImport {
  readonly records: ParsedRecord[];
  readonly revisions: Array<{ lineNo: number; data: z.infer<typeof revisionLineSchema> }>;
}

/** 一条 `capture_record` 行的解析产物：核对过的三轴 + 可直接落库的具名列值。 */
interface ParsedRecord {
  readonly lineNo: number;
  readonly data: z.infer<typeof recordLineSchema>;
  readonly axes: ThreeAxes;
  readonly row: Record<RecordColumn, string>;
}

const AXIS_COLUMNS = ["analysis_provider", "redaction_mode", "send_content_mode"] as const;

/**
 * 行里的三轴 → 核对过的 `ThreeAxes` + 插入用列值。三件核对各自独立成立：
 *
 * 1. **取值在封闭集**（schema 判过一道，`coerceAxes` 再判一道——两道都不静默兜底）。
 * 2. **组合合法**（草案 §三 矩阵）：库里两条表级 CHECK 也会拒，但 COMMIT 阶段的报错没有行号；
 *    在这里判，问题才归到「第 N 行」，整批仍然零写入。
 * 3. **派生一致**（§七 断言 2）：`processing_mode` 必须等于三轴的派生结果。不一致说明这份文件
 *    被手改过，或来自语义不同的另一份契约。
 *
 * 三键**同时缺席**是 0008 之前的旧文件：按 §四 旧值映射反推。那份文件里的 `processing_mode`
 * 只可能是旧三值（当时的 CHECK 就钉在三值内），反推因此是无损的；部分缺席没有可信的映射，拒。
 */
function normalizeRecordLine(
  data: z.infer<typeof recordLineSchema>,
  lineNo: number,
  issues: string[],
): ParsedRecord | null {
  const present = AXIS_COLUMNS.filter((column) => data[column] !== undefined);
  let axes: ThreeAxes | null = null;
  if (present.length === AXIS_COLUMNS.length) {
    try {
      axes = coerceAxes(
        data.analysis_provider as string,
        data.redaction_mode as string,
        data.send_content_mode as string,
      );
      assertThreeAxes(axes);
    } catch (cause) {
      issues.push(`第 ${lineNo} 行：${(cause as Error).message}`);
      return null;
    }
    const derived = deriveProcessingMode(axes);
    if (derived !== data.processing_mode) {
      issues.push(
        `第 ${lineNo} 行：processing_mode=${data.processing_mode} 与三轴的派生结果 ${derived} 不一致（草案 §五）`,
      );
      return null;
    }
  } else if (present.length === 0) {
    if (!isProcessingModeValue(data.processing_mode)) {
      issues.push(`第 ${lineNo} 行：三轴缺席时 processing_mode 必须可映射（${data.processing_mode} 不在册）`);
      return null;
    }
    axes = axesForProcessingMode(data.processing_mode);
  } else {
    issues.push(`第 ${lineNo} 行：三轴必须同时出现或同时缺席，现状为 ${present.join(" / ")}`);
    return null;
  }

  const row: Record<RecordColumn, string> = {
    id: data.id,
    created_at_utc: data.created_at_utc,
    created_at_local: data.created_at_local,
    timezone_id: data.timezone_id,
    created_local_date: data.created_local_date,
    current_revision_id: data.current_revision_id,
    processing_status: data.processing_status,
    processing_mode: data.processing_mode,
    privacy_level: data.privacy_level,
    analysis_provider: axes.analysisProvider,
    redaction_mode: axes.redactionMode,
    send_content_mode: axes.sendContentMode,
  };
  return { lineNo, data, axes, row };
}

// M1b：导入结果类型上收为前后端共用契约；re-export 保持既有导入路径可用。
import type { ImportResult } from "../../shared/dto.ts";
export type { ImportResult } from "../../shared/dto.ts";

function recheckBusinessSemantics(parsed: ParsedImport, issues: string[]): void {
  const revisionById = new Map<string, z.infer<typeof revisionLineSchema>>();
  const recordIds = new Set<string>();
  const seenRevisionNumbers = new Set<string>();

  for (const item of parsed.revisions) {
    const rev = item.data;
    if (!hasPrefix(rev.id, "recordRevision")) {
      issues.push(`第 ${item.lineNo} 行：revision id 前缀非法`);
    }
    if (revisionById.has(rev.id)) {
      issues.push(`第 ${item.lineNo} 行：revision id ${rev.id} 重复`);
    }
    revisionById.set(rev.id, rev);
    const numberKey = `${rev.record_id}#${rev.revision_number}`;
    if (seenRevisionNumbers.has(numberKey)) {
      issues.push(`第 ${item.lineNo} 行：记录 ${rev.record_id} 的 revision_number ${rev.revision_number} 重复`);
    }
    seenRevisionNumbers.add(numberKey);
    // 派生量核对：哈希与词元都必须能从 raw_text 复算——导入不接受「内容与其派生数据打架」的行。
    const expectedHash = createHash("sha256").update(rev.raw_text.normalize("NFC")).digest("hex");
    if (rev.content_sha256 !== expectedHash) {
      issues.push(`第 ${item.lineNo} 行：content_sha256 与 raw_text 不一致`);
    }
    if (rev.tokens !== serializeTokens(tokenize(rev.raw_text))) {
      issues.push(`第 ${item.lineNo} 行：tokens 与 raw_text 不一致`);
    }
  }

  for (const item of parsed.records) {
    const record = item.data;
    if (!hasPrefix(record.id, "captureRecord")) {
      issues.push(`第 ${item.lineNo} 行：record id 前缀非法`);
    }
    if (recordIds.has(record.id)) {
      issues.push(`第 ${item.lineNo} 行：record id ${record.id} 重复`);
    }
    recordIds.add(record.id);
    const current = revisionById.get(record.current_revision_id);
    if (current === undefined) {
      issues.push(`第 ${item.lineNo} 行：current_revision_id ${record.current_revision_id} 在文件中不存在`);
    } else if (current.record_id !== record.id) {
      issues.push(`第 ${item.lineNo} 行：current_revision_id 指向其他记录的版本`);
    }
  }

  for (const item of parsed.revisions) {
    if (!recordIds.has(item.data.record_id)) {
      issues.push(`第 ${item.lineNo} 行：record_id ${item.data.record_id} 在文件中不存在`);
    }
  }
}

/**
 * 导入语义（显式裁决）：**只允许导入到没有业务记录的库**。
 * 合并语义（同名 ID 冲突、版本指针跨库交织）在 V0 未定义，不假装能做——
 * 有业务数据时整批拒绝（not_empty），跨机迁移的完整库请走快照恢复。
 */
export function importJsonl(db: Database, text: string): ImportResult {
  const liveRecords = (db.prepare("select count(*) as n from capture_record").get() as { n: number }).n;
  const liveRevisions = (db.prepare("select count(*) as n from record_revision").get() as { n: number }).n;
  if (liveRecords > 0 || liveRevisions > 0) {
    throw new JsonlImportError(
      `目标库已有业务记录（记录 ${liveRecords} / 版本 ${liveRevisions}）：V0 导入只接受空库，不做合并`,
      [],
      "not_empty",
    );
  }

  const issues: string[] = [];
  const parsed: ParsedImport = { records: [], revisions: [] };
  const rawLines = text.split(/\r?\n/);
  let metaSeen = false;

  rawLines.forEach((raw, index) => {
    const lineNo = index + 1;
    if (raw.trim() === "") return;
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      issues.push(`第 ${lineNo} 行：JSON 语法错误`);
      return;
    }
    if (typeof value !== "object" || value === null) {
      issues.push(`第 ${lineNo} 行：不是对象`);
      return;
    }
    const kind = (value as { line?: unknown }).line;
    if (!metaSeen) {
      if (kind !== "meta") {
        issues.push(`第 ${lineNo} 行：首个数据行必须是 meta 行`);
        return;
      }
      const metaResult = metaLineSchema.safeParse(value);
      if (!metaResult.success) {
        for (const problem of metaResult.error.issues) {
          issues.push(`第 ${lineNo} 行（meta）：${problem.path.join(".")} ${problem.message}`);
        }
        return;
      }
      if (metaResult.data.export_schema_version !== EXPORT_SCHEMA_VERSION) {
        issues.push(
          `第 ${lineNo} 行：导出契约版本 ${metaResult.data.export_schema_version} 不受支持（当前 ${EXPORT_SCHEMA_VERSION}）`,
        );
      }
      const supported = listMigrationFiles().map((file) => file.version);
      if (metaResult.data.database_schema_version > supported[supported.length - 1]!) {
        issues.push(
          `第 ${lineNo} 行：来源数据库 schema 版本 ${metaResult.data.database_schema_version} 高于当前应用支持范围，请升级应用`,
        );
      }
      metaSeen = true;
      return;
    }
    if (kind === "capture_record") {
      const result = recordLineSchema.safeParse(value);
      if (!result.success) {
        for (const problem of result.error.issues) {
          issues.push(`第 ${lineNo} 行：${problem.path.join(".") || "(root)"} ${problem.message}`);
        }
        return;
      }
      const normalized = normalizeRecordLine(result.data, lineNo, issues);
      if (normalized !== null) parsed.records.push(normalized);
      return;
    }
    if (kind === "record_revision") {
      const result = revisionLineSchema.safeParse(value);
      if (!result.success) {
        for (const problem of result.error.issues) {
          issues.push(`第 ${lineNo} 行：${problem.path.join(".") || "(root)"} ${problem.message}`);
        }
        return;
      }
      parsed.revisions.push({ lineNo, data: result.data });
      return;
    }
    issues.push(`第 ${lineNo} 行：未知对象类型 ${String(kind)}`);
  });

  if (!metaSeen && issues.length === 0) {
    issues.push("缺少 meta 行");
  }
  recheckBusinessSemantics(parsed, issues);
  if (issues.length > 0) {
    throw new JsonlImportError(`导入被拒绝：共 ${issues.length} 个问题，未写入任何数据`, issues);
  }

  // 验票全过才动笔：单事务写入，延迟外键在 COMMIT 兜底，失败整批回滚。
  db.exec("BEGIN IMMEDIATE");
  try {
    const insertRecord = db.prepare(
      `insert into capture_record (${RECORD_COLUMNS.join(", ")}) values (${RECORD_COLUMNS.map(() => "?").join(", ")})`,
    );
    const insertRevision = db.prepare(
      `insert into record_revision (${REVISION_COLUMNS.join(", ")}) values (${REVISION_COLUMNS.map(() => "?").join(", ")})`,
    );
    for (const item of parsed.records) {
      insertRecord.run(...RECORD_COLUMNS.map((column) => item.row[column]));
    }
    for (const item of parsed.revisions) {
      insertRevision.run(...REVISION_COLUMNS.map((column) => item.data[column]));
    }
    db.exec("COMMIT");
  } catch (cause) {
    db.exec("ROLLBACK");
    throw new JsonlImportError(
      `导入在提交阶段被数据库拒绝，已整体回滚：${(cause as Error).message}`,
    );
  }
  return { records: parsed.records.length, revisions: parsed.revisions.length };
}
