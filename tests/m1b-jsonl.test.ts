import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase, type Database } from "../src/server/db/adapter.ts";
import { migrate } from "../src/server/db/migrator.ts";
import { RecordService } from "../src/server/records/service.ts";
import {
  EXPORT_SCHEMA_VERSION,
  JsonlImportError,
  exportJsonl,
  importJsonl,
} from "../src/server/backup/jsonl.ts";
import { HEAD_SCHEMA_VERSION, makeSandbox, openSandboxDb, type Sandbox } from "./helpers/sandbox.ts";

const CLOCK = new Date("2026-10-12T15:30:00.000Z");

let sandbox: Sandbox;
let db: ReturnType<typeof openSandboxDb>;
let records: RecordService;
let extraHandles: Database[] = [];

/** 目标库：迁移过但没有任何业务数据的全新文件——导入的空库门槛由它反证。 */
function openEmptyTarget(name = "target.sqlite"): Database {
  const handle = openDatabase(join(sandbox.root, name));
  handle.exec("PRAGMA foreign_keys = ON");
  migrate(handle);
  extraHandles.push(handle);
  return handle;
}

function rowsOf(handle: Database, table: string): Array<Record<string, unknown>> {
  return handle.prepare(`select * from ${table} order by rowid`).all() as unknown as Array<
    Record<string, unknown>
  >;
}

function counts(handle: Database): { records: number; revisions: number; fts: number } {
  return {
    records: (handle.prepare("select count(*) as n from capture_record").get() as { n: number }).n,
    revisions: (handle.prepare("select count(*) as n from record_revision").get() as { n: number }).n,
    fts: (handle.prepare("select count(*) as n from record_fts_docsize").get() as { n: number }).n,
  };
}

function expectImportFailure(handle: Database, text: string): JsonlImportError {
  let error: JsonlImportError | undefined;
  try {
    importJsonl(handle, text);
  } catch (cause) {
    error = cause as JsonlImportError;
  }
  expect(error).toBeInstanceOf(JsonlImportError);
  return error!;
}

beforeEach(() => {
  sandbox = makeSandbox("tb-m1b-jsonl-");
  db = openSandboxDb(sandbox.layout);
  migrate(db);
  records = new RecordService(db, { timezoneId: "Asia/Shanghai", now: () => CLOCK });
  extraHandles = [];
});

afterEach(() => {
  for (const handle of extraHandles) handle.close();
  db.close();
  sandbox.cleanup();
});

describe("JSONL 导出（M1b §六 契约）", () => {
  it("meta 行 + 对象类型 + ID/版本/关系引用逐列保真", () => {
    const a = records.createRecord("第一条思绪");
    records.editRecord(a.record.id, "第一条思绪（修订）");
    records.createRecord("第二条思绪");

    const text = exportJsonl(db, { now: () => CLOCK });
    const lines = text.trimEnd().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);

    const meta = lines[0]!;
    expect(meta).toMatchObject({
      line: "meta",
      app: "ThoughtsBox",
      export_schema_version: EXPORT_SCHEMA_VERSION,
      database_schema_version: HEAD_SCHEMA_VERSION,
      exported_at_utc: CLOCK.toISOString(),
    });
    expect(meta.object_types).toEqual(["capture_record", "record_revision"]);
    expect(lines.slice(1).map((l) => l.line)).toEqual([
      "capture_record",
      "capture_record",
      "record_revision",
      "record_revision",
      "record_revision",
    ]);

    // 与库内行逐列相等：JSON 往返无损
    const exportedRecords = lines
      .filter((l) => l.line === "capture_record")
      .map((l) => {
        const { line: _line, ...rest } = l;
        return rest;
      })
      .sort((x, y) => String(x.id).localeCompare(String(y.id)));
    expect(exportedRecords).toEqual(
      [...rowsOf(db, "capture_record")].sort((x, y) =>
        String(x.id).localeCompare(String(y.id)),
      ),
    );
  });

  it("排除面显式：删除审计、app_meta、运行期维护任务不进导出，已删原文也不出现", () => {
    const doomed = records.createRecord("注定被删掉的私密原文");
    records.editRecord(doomed.record.id, "注定被删掉的私密原文（改）");
    records.createRecord("要保留并导出的原文");
    records.deleteRecord(doomed.record.id);

    const text = exportJsonl(db, { now: () => CLOCK });
    const kinds = new Set(
      text
        .trimEnd()
        .split("\n")
        .map((l) => (JSON.parse(l) as { line: string }).line),
    );
    // 库里有删除审计行与（可能存在的）维护任务记录，导出里一类都不许出现
    expect((db.prepare("select count(*) as n from deletion_audit").get() as { n: number }).n).toBeGreaterThan(0);
    expect(kinds).toEqual(new Set(["meta", "capture_record", "record_revision"]));
    expect(text).not.toContain("注定被删掉");
    expect(text).not.toContain("storage_maintenance_pending");
    expect(text).toContain("要保留并导出的原文");
  });

  it("导出只读：不改库内容、不新增 app_meta 记录，导完库照常可用", () => {
    records.createRecord("只读导出演练");
    const before = JSON.stringify(rowsOf(db, "capture_record"));
    const metaBefore = JSON.stringify(rowsOf(db, "app_meta"));
    exportJsonl(db, { now: () => CLOCK });
    expect(JSON.stringify(rowsOf(db, "capture_record"))).toBe(before);
    expect(JSON.stringify(rowsOf(db, "app_meta"))).toBe(metaBefore);
  });
});

describe("JSONL 导入与往返（M1b §六）", () => {
  function seedRichSource(): string {
    const a = records.createRecord("往返测试：甲记录初稿");
    records.editRecord(a.record.id, "往返测试：甲记录初稿（含修订）");
    records.createRecord("往返测试：乙记录");
    return exportJsonl(db, { now: () => CLOCK });
  }

  it("往返无损：导入空库后业务表逐列一致，搜索索引由触发器重建可用", () => {
    const text = seedRichSource();
    const target = openEmptyTarget();

    const result = importJsonl(target, text);
    expect(result).toEqual({ records: 2, revisions: 3 });
    const byId = (rows: Array<Record<string, unknown>>) =>
      [...rows].sort((x, y) => String(x.id).localeCompare(String(y.id)));
    expect(byId(rowsOf(target, "capture_record"))).toEqual(byId(rowsOf(db, "capture_record")));
    expect(byId(rowsOf(target, "record_revision"))).toEqual(byId(rowsOf(db, "record_revision")));

    const revived = new RecordService(target, { timezoneId: "Asia/Shanghai", now: () => CLOCK });
    expect(revived.listRecords(10, 0).total).toBe(2);
    expect(revived.searchRecords("甲记录初稿").hits.length).toBeGreaterThan(0);
    expect(revived.detectIndexDesync()).toEqual({ phantom: 0, missing: 0 });
  });

  it("派生量随行：tokens 列与源库逐字节一致（索引内容不重算出偏差）", () => {
    const text = seedRichSource();
    const target = openEmptyTarget();
    importJsonl(target, text);
    const srcTokens = rowsOf(db, "record_revision").map((r) => r.tokens);
    const dstTokens = rowsOf(target, "record_revision").map((r) => r.tokens);
    expect(dstTokens).toEqual(srcTokens);
  });

  it("空库门槛：目标库已有业务记录时整批拒绝，原数据一字不动", () => {
    const text = seedRichSource();
    const kept = records.createRecord("目标库已有记录");
    const before = JSON.stringify(rowsOf(db, "capture_record"));

    const error = expectImportFailure(db, text);
    expect(error.kind).toBe("not_empty");
    expect(JSON.stringify(rowsOf(db, "capture_record"))).toBe(before);
    expect(kept.record.id).toMatch(/^rec_/);
  });

  it("任一问题行都整批不写入：坏行号报出，目标库零业务数据（无半导入状态）", () => {
    const goodA = records.createRecord("合法行一号");
    records.editRecord(goodA.record.id, "合法行一号（改）");
    records.createRecord("合法行二号");
    const text = exportJsonl(db, { now: () => CLOCK });
    const poisoned = `${text}{"line":"record_revision","id":"rev_forged","record_id":"${goodA.record.id}","revision_number":9,"raw_text":"伪造版本","content_sha256":"${"b".repeat(64)}","tokens":"伪造","created_at_utc":"2026-10-12T15:30:00.000Z","created_at_local":"2026-10-12T23:30:00.000+08:00","timezone_id":"Asia/Shanghai"}\n`;

    const target = openEmptyTarget();
    const error = expectImportFailure(target, poisoned);
    expect(error.kind).toBe("invalid");
    // 伪造行的哈希与 raw_text 打架，必须带行号点名（meta + 2 记录 + 3 版本 → 伪造是第 7 行）
    expect(error.issues.some((issue) => /第 7 行/.test(issue) && /content_sha256/.test(issue))).toBe(true);
    expect(counts(target)).toEqual({ records: 0, revisions: 0, fts: 0 });
  });

  it("前置校验不绕过任何约束：非法枚举、错误前缀、悬空指针、契约版本超限、未知类型逐条点名", () => {
    records.createRecord("校验绕过演练");
    const text = exportJsonl(db, { now: () => CLOCK });
    const parsed = text.trimEnd().split("\n");
    const meta = JSON.parse(parsed[0]!) as Record<string, unknown>;
    const recordLine = JSON.parse(parsed[1]!) as Record<string, unknown>;

    const cases: Array<{ label: string; file: string; expect: RegExp }> = [
      {
        label: "契约版本",
        file: `${JSON.stringify({ ...meta, export_schema_version: 99 })}\n${parsed.slice(1).join("\n")}`,
        expect: /契约版本/,
      },
      {
        label: "schema 超限",
        file: `${JSON.stringify({ ...meta, database_schema_version: 999 })}\n${parsed.slice(1).join("\n")}`,
        expect: /schema 版本/,
      },
      {
        label: "非法枚举",
        file: `${parsed[0]}\n${JSON.stringify({ ...recordLine, processing_status: "ai_done" })}\n${parsed.slice(2).join("\n")}`,
        expect: /processing_status/,
      },
      {
        label: "错误前缀",
        file: `${parsed[0]}\n${JSON.stringify({ ...recordLine, id: "zz_1" })}\n${parsed.slice(2).join("\n")}`,
        expect: /id/,
      },
      {
        label: "悬空指针",
        file: `${parsed[0]}\n${JSON.stringify({ ...recordLine, current_revision_id: "rev_not_in_file" })}\n${parsed.slice(2).join("\n")}`,
        expect: /current_revision_id/,
      },
      {
        label: "未知类型",
        file: `${parsed[0]}\n${JSON.stringify({ ...recordLine, line: "episode" })}\n${parsed.slice(2).join("\n")}`,
        expect: /未知对象类型/,
      },
      {
        label: "语法坏行",
        file: `${parsed[0]}\n{这不是 JSON}\n${parsed.slice(2).join("\n")}`,
        expect: /第 2 行.*语法错误/,
      },
    ];

    for (const testCase of cases) {
      const target = openEmptyTarget(`target-${testCase.label}.sqlite`);
      const error = expectImportFailure(target, testCase.file);
      expect(error.issues.join("\n"), testCase.label).toMatch(testCase.expect);
      expect(counts(target), testCase.label).toEqual({ records: 0, revisions: 0, fts: 0 });
    }
  });

  it("current 指针跨记录指向同文件内合法版本：结构性验票拒绝（不依赖 FK 兜底）", () => {
    records.createRecord("指针演练甲");
    records.createRecord("指针演练乙");
    const text = exportJsonl(db, { now: () => CLOCK });
    const parsed = text.trimEnd().split("\n");
    const recordLines = parsed.filter((l) => (JSON.parse(l) as { line: string }).line === "capture_record");
    const revisionLines = parsed.filter((l) => (JSON.parse(l) as { line: string }).line === "record_revision");
    const firstRecord = JSON.parse(recordLines[0]!) as Record<string, unknown>;
    const stolen = JSON.parse(revisionLines[1]!) as Record<string, unknown>;

    const rebuilt = [
      parsed[0],
      JSON.stringify({ ...firstRecord, current_revision_id: stolen.id }),
      ...recordLines.slice(1),
      ...revisionLines,
    ].join("\n");

    const target = openEmptyTarget();
    const error = expectImportFailure(target, rebuilt);
    expect(error.issues.join("\n")).toMatch(/指向其他记录/);
    expect(counts(target)).toEqual({ records: 0, revisions: 0, fts: 0 });
  });

  it("导入文件本身不被改写：只读消费文本（导出文件不可变性）", () => {
    const text = seedRichSource();
    const target = openEmptyTarget();
    importJsonl(target, text);
    expect(exportJsonl(target, { now: () => CLOCK })).toBe(text);
  });
});
