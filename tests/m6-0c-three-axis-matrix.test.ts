import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ANALYSIS_PROVIDER_VALUES,
  REDACTION_MODE_VALUES,
  SEND_CONTENT_MODE_VALUES,
  UNIMPLEMENTED_REDACTION_MODES,
  assertThreeAxes,
  axesForProcessingMode,
  coerceAxes,
  deriveProcessingMode,
  isEgress,
  isLegalCombination,
  isProcessingModeValue,
  isUnimplementedRedactionMode,
  ThreeAxisCombinationError,
  ThreeAxisValueError,
  type ProcessingModeValue,
  type ThreeAxes,
} from "../src/shared/contracts/enums.ts";
import { MIGRATIONS_DIR, currentSchemaVersion, migrate } from "../src/server/db/migrator.ts";
import { serializeTrace, TracePrivacyViolation, type TraceEntry } from "../src/server/ingest/trace.ts";
import type { Database } from "../src/server/db/adapter.ts";
import { HEAD_SCHEMA_VERSION, makeSandbox, openSandboxDb, type Sandbox } from "./helpers/sandbox.ts";
import {
  assertRedactionPlanRunnable,
  LOCAL_LLM_STATUS_UNSET,
  RedactionModeUnavailableError,
} from "../src/server/ingest/provider.ts";
import type { LocalLlmStatus } from "../src/server/config/config.ts";

/**
 * M6-0C 三轴契约的**判定面**验收（草案 §七 断言 1/2/5/6 + §八之三 3/4）。
 *
 * 分工：本文件只管「三轴组合的判定源」（代码 `isLegalCombination` ↔ `enums.json` 12 行矩阵 ↔
 * 0008 的库内 CHECK）与「旧值映射的真升级」「trace 取值门」。
 * 装配与外发行为（§七 断言 3/4/7、§八之三 1/2 的「显式拒绝、不降级」）在
 * `m6-0c-egress-and-assembly.test.ts`，那一条需要真实 HTTP 与桩 transport。
 *
 * 三条纪律在本文件里的落法：
 *  - 判定表**不抄第二份**：矩阵、旧值映射、占位清单全部从 `enums.json` 读，代码只做逐行对账。
 *  - 库内 CHECK 与代码判定必须同结论（草案 §八-2「三处引用同一份清单」的最硬证据）。
 *  - 升级用真的应用 migrator（`migrate`），不是手搓 SQL 近似。
 */

const ENUMS_FILE = "src/shared/constants/enums.json";
const enums = JSON.parse(readFileSync(ENUMS_FILE, "utf8")) as {
  three_axis_rules: {
    combination_matrix: { row: number; axes: string; legal: boolean; reason: string }[];
    legacy_axis_mapping: string[];
    placeholder_unimplemented: string[];
    derived_processing_mode: string[];
  };
  // 装载时 `validateEnums` 已逐值对账过这份清单与代码字面量，读作契约联合类型而非宽 string。
  processing_modes: ProcessingModeValue[];
};
const RULES = enums.three_axis_rules;

/** `"cloud|manual|redacted"` → 三轴对象（取值门照走 `coerceAxes`，字面量不由本文件发明）。 */
function tripleToAxes(triple: string): ThreeAxes {
  const [analysisProvider, redactionMode, sendContentMode] = triple.split("|");
  return coerceAxes(analysisProvider!, redactionMode!, sendContentMode!);
}

/** 27 个组合的全集：矩阵只登记 12 行，其余 15 行必须由判定源自己说「不合法」。 */
function allCombinations(): ThreeAxes[] {
  const out: ThreeAxes[] = [];
  for (const analysisProvider of ANALYSIS_PROVIDER_VALUES) {
    for (const redactionMode of REDACTION_MODE_VALUES) {
      for (const sendContentMode of SEND_CONTENT_MODE_VALUES) {
        out.push({ analysisProvider, redactionMode, sendContentMode });
      }
    }
  }
  return out;
}

const axesKeyOf = (a: ThreeAxes): string =>
  `${a.analysisProvider}|${a.redactionMode}|${a.sendContentMode}`;

/** `capture_record` 的派生列 + 三轴列的行形状（四列在 0008 里都是 NOT NULL）。 */
type AxesRow = {
  processing_mode: string;
  analysis_provider: string;
  redaction_mode: string;
  send_content_mode: string;
};

/* ════════════════════════════════════════════════════════════════════
 * A. §七 断言 1：12 行逐行 + 27 组合完备
 * ════════════════════════════════════════════════════════════════════ */

describe("A. 组合矩阵逐行判定（§七 断言 1 的代码面）", () => {
  it("矩阵恰好 12 行，且 12 行的三轴取值全部在册（不靠行数巧合）", () => {
    expect(RULES.combination_matrix).toHaveLength(12);
    expect(RULES.combination_matrix.map((r) => r.row)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    for (const row of RULES.combination_matrix) {
      expect(() => tripleToAxes(row.axes)).not.toThrow();
    }
  });

  it("12 行逐行：legal=true 进得了装配（并可派生），legal=false 抛出带规则依据的组合错误", () => {
    for (const row of RULES.combination_matrix) {
      const axes = tripleToAxes(row.axes);
      expect(isLegalCombination(axes), `矩阵 #${row.row} ${row.axes}`).toBe(row.legal);
      if (row.legal) {
        expect(() => assertThreeAxes(axes), `矩阵 #${row.row}`).not.toThrow();
        expect(enums.processing_modes).toContain(deriveProcessingMode(axes));
      } else {
        const thrown = (() => {
          try {
            assertThreeAxes(axes);
            return undefined;
          } catch (cause) {
            return cause;
          }
        })();
        expect(thrown, `矩阵 #${row.row} ${row.axes} 应被拒`).toBeInstanceOf(ThreeAxisCombinationError);
        // 错误消息点名三个取值与规则依据：都是封闭枚举成员，可以进日志（指令 §11.2）。
        const message = (thrown as Error).message;
        expect(message).toContain(axes.analysisProvider);
        expect(message).toContain(axes.redactionMode);
        expect(message).toContain(axes.sendContentMode);
        // 消息里只有封闭枚举取值与规则依据：不含原文、不含姓名，因此可以进日志（指令 §11.2）。
      }
    }
  });

  it("矩阵未登记的 15 个组合一律判不合法：判定源覆盖全空间，不是 12 条 if", () => {
    const declared = new Map(RULES.combination_matrix.map((r) => [r.axes, r.legal]));
    const undeclared = allCombinations().filter((a) => !declared.has(axesKeyOf(a)));
    expect(undeclared).toHaveLength(27 - 12);
    for (const axes of undeclared) {
      expect(isLegalCombination(axes), axesKeyOf(axes)).toBe(false);
      expect(() => assertThreeAxes(axes), axesKeyOf(axes)).toThrow(ThreeAxisCombinationError);
    }
    // 未登记的那三类形态正是「说了不外发却往外发」，逐类点名一次（草案 §三 matrix_completeness）。
    for (const pattern of [/^none\|.*\|(redacted|raw)$/, /^local\|.*\|(redacted|raw)$/, /^cloud\|.*\|none$/]) {
      const hit = undeclared.filter((a) => pattern.test(axesKeyOf(a)));
      expect(hit.length, String(pattern)).toBeGreaterThan(0);
      for (const axes of hit) expect(isLegalCombination(axes)).toBe(false);
    }
  });

  it("§七 断言 5：(cloud,manual,raw) / (cloud,local_llm,raw) / (cloud,none,redacted) 三行全部被拒", () => {
    for (const triple of ["cloud|manual|raw", "cloud|local_llm|raw", "cloud|none|redacted"]) {
      const axes = tripleToAxes(triple);
      expect(isLegalCombination(axes), triple).toBe(false);
      expect(() => assertThreeAxes(axes), triple).toThrow(/不合法/);
      // 派生函数同样不放过：非法组合拿不到派生值，因此不可能「带着非法组合去装配」。
      expect(() => deriveProcessingMode(axes), triple).toThrow(ThreeAxisCombinationError);
    }
  });

  it("外发闸门只看 send_content_mode：redacted 与 raw 同门外发，none 一律不外发（§五 egress_gate）", () => {
    for (const axes of allCombinations()) {
      expect(isEgress(axes), axesKeyOf(axes)).toBe(axes.sendContentMode !== "none");
    }
    // 两档云端派生值都在门外，`cloud_raw` 不可能因为「新档位」漏过闸门。
    expect(isEgress(axesForProcessingMode("cloud_raw"))).toBe(true);
    expect(isEgress(axesForProcessingMode("cloud_redacted"))).toBe(true);
    expect(isEgress(axesForProcessingMode("manual_only"))).toBe(false);
    expect(isEgress(axesForProcessingMode("local_model"))).toBe(false);
  });

  it("四档派生值与反向映射闭环：axesForProcessingMode → deriveProcessingMode 逐档回到自身", () => {
    for (const mode of enums.processing_modes) {
      expect(isProcessingModeValue(mode), mode).toBe(true);
      const axes = axesForProcessingMode(mode);
      expect(isLegalCombination(axes), mode).toBe(true);
      expect(deriveProcessingMode(axes), mode).toBe(mode);
    }
    // cloud_raw 是唯一「原文 + 不脱敏」的档，与 cloud_redacted 只差在两个轴值上（§七 断言 7 的根）。
    const raw = axesForProcessingMode("cloud_raw");
    const redacted = axesForProcessingMode("cloud_redacted");
    expect(raw.analysisProvider).toBe(redacted.analysisProvider);
    expect(raw.sendContentMode).toBe("raw");
    expect(raw.redactionMode).toBe("none");
  });
});

/* ════════════════════════════════════════════════════════════════════
 * B. 库内 CHECK 与代码判定同结论（判定源在库里，不只在你 import 的那个函数里）
 * ════════════════════════════════════════════════════════════════════ */

describe("B. 0008 的组合 CHECK + 派生 CHECK 逐行同结论（§七 断言 1 的库内面）", () => {
  let sandbox: Sandbox;
  let db: Database;
  let recordId: string;
  let original: AxesRow;

  const columns = "processing_mode, analysis_provider, redaction_mode, send_content_mode";

  beforeEach(() => {
    sandbox = makeSandbox("tb-m6-0c-matrix-");
    db = openSandboxDb(sandbox.layout);
    migrate(db);
    recordId = createViaService(db);
    original = db.prepare(`select ${columns} from capture_record where id = ?`).get(recordId) as AxesRow;
  });

  afterEach(() => {
    db.close();
    sandbox.cleanup();
  });

  /** 直接写一条 manual_only 记录（三列走 0008 的 DEFAULT，派生 CHECK 因此成立）。 */
  function createViaService(handle: Database): string {
    const id = "rec_m6_0c_matrix";
    const revisionId = "rev_m6_0c_matrix";
    const now = "2026-10-24T02:00:00.000Z";
    handle.exec("BEGIN IMMEDIATE");
    try {
      handle
        .prepare(
          `insert into capture_record (id, created_at_utc, created_at_local, timezone_id, created_local_date,
             current_revision_id, processing_status, processing_mode, privacy_level)
           values (?, ?, ?, ?, ?, ?, 'captured', 'manual_only', 'normal')`,
        )
        .run(id, now, now, "Asia/Shanghai", "2026-10-24", revisionId);
      handle
        .prepare(
          `insert into record_revision (id, record_id, revision_number, raw_text, content_sha256, tokens,
             created_at_utc, created_at_local, timezone_id)
           values (?, ?, 1, ?, ?, '[]', ?, ?, 'Asia/Shanghai')`,
        )
        .run(revisionId, id, "三轴判定面的现场", "a".repeat(64), now, now);
      handle.exec("COMMIT");
    } catch (cause) {
      handle.exec("ROLLBACK");
      throw cause;
    }
    return id;
  }

  function tryWriteAxes(axes: ThreeAxes): string | undefined {
    // 非法组合给不出派生值：随手写一个在册模式，让**库**来做拒绝（判定源在库内 CHECK，不在这里）。
    const mode = isLegalCombination(axes) ? deriveProcessingMode(axes) : "manual_only";
    db.exec("SAVEPOINT axes_probe");
    try {
      db.prepare(
        `update capture_record set processing_mode = ?, analysis_provider = ?, redaction_mode = ?, send_content_mode = ?
         where id = ?`,
      ).run(
        mode,
        axes.analysisProvider,
        axes.redactionMode,
        axes.sendContentMode,
        recordId,
      );
      db.exec("ROLLBACK TO axes_probe");
      db.exec("RELEASE axes_probe");
      return undefined;
    } catch (cause) {
      db.exec("ROLLBACK TO axes_probe");
      db.exec("RELEASE axes_probe");
      return (cause as Error).message;
    }
  }

  it("矩阵 12 行逐行：库里接受的就等于代码判定合法的，拒绝的都写着 CHECK", () => {
    for (const row of RULES.combination_matrix) {
      const axes = tripleToAxes(row.axes);
      const rejected = tryWriteAxes(axes);
      if (row.legal) {
        expect(rejected, `矩阵 #${row.row} ${row.axes} 应被库接受`).toBeUndefined();
      } else {
        expect(rejected, `矩阵 #${row.row} ${row.axes} 应被库拒绝`).toMatch(/CHECK constraint failed/);
      }
    }
  });

  it("写歪的派生列被单独拒：三轴合法但 processing_mode 说假话，库里不留这一行（§五 派生 CHECK）", () => {
    const axes = axesForProcessingMode("cloud_raw");
    db.exec("SAVEPOINT lie");
    const thrown = (() => {
      try {
        db.prepare(
          `update capture_record set processing_mode = 'cloud_redacted', analysis_provider = ?, redaction_mode = ?, send_content_mode = ? where id = ?`,
        ).run(axes.analysisProvider, axes.redactionMode, axes.sendContentMode, recordId);
        return undefined;
      } catch (cause) {
        return (cause as Error).message;
      }
    })();
    db.exec("ROLLBACK TO lie");
    db.exec("RELEASE lie");
    expect(thrown).toMatch(/CHECK constraint failed/);
  });

  it("在册之外的轴取值连门都进不来：三列各自的 CHECK 与代码取值门同集合（E-07 / T-16）", () => {
    for (const bad of ["Cloud", "cloud ", "", "hybrid", "manual_only"]) {
      const axes: ThreeAxes = { analysisProvider: bad as never, redactionMode: "manual", sendContentMode: "none" };
      expect(() => coerceAxes(bad, "manual", "none"), bad).toThrow(ThreeAxisValueError);
      expect(tryWriteAxes(axes), bad).toMatch(/CHECK constraint failed|FOREIGN KEY/);
    }
    expect(() => coerceAxes("cloud", "semantic", "redacted")).toThrow(ThreeAxisValueError);
    expect(() => coerceAxes("cloud", "manual", "original")).toThrow(ThreeAxisValueError);
  });

  it("现场未被这些探针改动：判定面测试不留下任何写侧痕迹", () => {
    expect(db.prepare(`select ${columns} from capture_record where id = ?`).get(recordId)).toEqual(original);
    // 判据是「探针没有把库推进或推离 HEAD」，不是「HEAD 恰好等于 8」——0009（0D）落地后这条仍成立。
    expect(currentSchemaVersion(db)).toBe(HEAD_SCHEMA_VERSION);
  });
});

/* ════════════════════════════════════════════════════════════════════
 * C. §七 断言 2：三行旧值映射在真升级上成立
 * ════════════════════════════════════════════════════════════════════ */

const PRE_0008 = [
  "0001_bootstrap.sql",
  "0002_records_and_search.sql",
  "0003_derived_layer.sql",
  "0004_correction_layer.sql",
  "0005_override_value_gate.sql",
  "0006_entity_types_v2.sql",
  "0007_schema_backfill_m2_debt.sql",
];

const LEGACY_NOW = "2026-10-17T09:00:00.000Z";

/** 0002 时代的写法：没有任何三轴列，只有 processing_mode 三值。 */
function createLegacyRecord(db: Database, mode: string, text: string): string {
  const id = `rec_legacy_${mode}`;
  const revisionId = `rev_legacy_${mode}`;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(
      `insert into capture_record (id, created_at_utc, created_at_local, timezone_id, created_local_date,
         current_revision_id, processing_status, processing_mode, privacy_level)
       values (?, ?, ?, ?, ?, ?, 'captured', ?, 'normal')`,
    ).run(id, LEGACY_NOW, LEGACY_NOW, "Asia/Shanghai", "2026-10-17", revisionId, mode);
    db.prepare(
      `insert into record_revision (id, record_id, revision_number, raw_text, content_sha256, tokens,
         created_at_utc, created_at_local, timezone_id)
       values (?, ?, 1, ?, ?, '[]', ?, ?, 'Asia/Shanghai')`,
    ).run(revisionId, id, text, "a".repeat(64), LEGACY_NOW, LEGACY_NOW);
    db.exec("COMMIT");
  } catch (cause) {
    db.exec("ROLLBACK");
    throw cause;
  }
  return id;
}

describe("C. 旧值映射三行各一条（§七 断言 2）", () => {
  it("停在 0007 的库升到 HEAD：三轴取值等于声明的映射，processing_mode 逐字不变且等于派生结果", () => {
    const staging = makeSandbox("tb-m6-0c-legacy-");
    const dir = mkdtempSync(join(tmpdir(), "tb-m6-0c-mig-"));
    const legacy = openSandboxDb(staging.layout);
    try {
      for (const file of PRE_0008) copyFileSync(join(MIGRATIONS_DIR, file), join(dir, file));
      expect(migrate(legacy, dir).schemaVersion).toBe(7);

      const ids = ["manual_only", "local_model", "cloud_redacted"].map((mode) =>
        createLegacyRecord(legacy, mode, `${mode} 的旧原文`),
      );
      // 升级前的现场计数：版本行与 FTS 行各 3 条。CASCADE 回归钉在下面那条。
      expect((legacy.prepare("select count(*) as n from record_revision").get() as { n: number }).n).toBe(3);

      copyFileSync(join(MIGRATIONS_DIR, "0008_three_axis_contract.sql"), join(dir, "0008_three_axis_contract.sql"));
      const advanced = migrate(legacy, dir);
      expect(advanced.schemaVersion).toBe(8);
      expect(advanced.applied.map((f) => f.name)).toEqual(["three_axis_contract"]);

      // 映射表本身从 enums.json 读：`manual_only => none|manual|none`
      const declared = new Map(
        RULES.legacy_axis_mapping.map((line) => {
          const [mode, triple] = line.split("=>");
          return [mode!.trim(), triple!.trim()];
        }),
      );
      expect([...declared.keys()]).toEqual(["manual_only", "local_model", "cloud_redacted"]);

      for (const id of ids) {
        const row = legacy
          .prepare(
            `select processing_mode, analysis_provider, redaction_mode, send_content_mode
             from capture_record where id = ?`,
          )
          .get(id) as AxesRow;
        const triple = `${row.analysis_provider}|${row.redaction_mode}|${row.send_content_mode}`;
        expect(triple, id).toBe(declared.get(row.processing_mode)!);
        // 「降级为派生兼容字段」在升级后的每一行上都是事实，而不只是约定。
        expect(deriveProcessingMode(coerceAxes(row.analysis_provider, row.redaction_mode, row.send_content_mode)), id).toBe(
          row.processing_mode,
        );
      }

      // 迁移报告（§四 末段）：回填行数如实，脏值计数为 0（0002 的三值 CHECK 决定了它只能是 0）。
      const report = legacy
        .prepare("select value from app_meta where key = 'migration_0008_three_axis_backfill'")
        .get() as { value: string };
      expect(JSON.parse(report.value)).toMatchObject({ rows_backfilled: 3, dirty_processing_mode_rows: 0 });
      expect(legacy.prepare("select * from pragma_foreign_key_check").all()).toEqual([]);
    } finally {
      legacy.close();
      rmSync(dir, { recursive: true, force: true });
      staging.cleanup();
    }
  });

  it("DROP 窗口不 cascade 删版本：record_revision 与 FTS 行在升级前后一模一样（0008 的 CASCADE 回归钉）", () => {
    const staging = makeSandbox("tb-m6-0c-cascade-");
    const dir = mkdtempSync(join(tmpdir(), "tb-m6-0c-cascade-mig-"));
    const legacy = openSandboxDb(staging.layout);
    try {
      for (const file of PRE_0008) copyFileSync(join(MIGRATIONS_DIR, file), join(dir, file));
      migrate(legacy, dir);
      for (const mode of ["manual_only", "local_model", "cloud_redacted"]) {
        createLegacyRecord(legacy, mode, `${mode} 的旧原文，含张三`);
      }
      const revisionsBefore = (legacy.prepare("select count(*) as n from record_revision").get() as { n: number }).n;
      const ftsBefore = (legacy.prepare("select count(*) as n from record_fts").get() as { n: number }).n;
      const rawBefore = legacy
        .prepare("select id, raw_text from record_revision order by id")
        .all() as Array<{ id: string; raw_text: string }>;

      copyFileSync(join(MIGRATIONS_DIR, "0008_three_axis_contract.sql"), join(dir, "0008_three_axis_contract.sql"));
      migrate(legacy, dir);

      // `record_revision.record_id → capture_record(id) ON DELETE CASCADE`：`DROP TABLE` 的隐式
      // DELETE 会照着这条动作把版本行删光。守卫表把那种静默数据丢失变成事务失败（0008 文件头实测记录），
      // 这条断言就是它存在的理由——删掉守卫，本条立刻变红。
      expect((legacy.prepare("select count(*) as n from record_revision").get() as { n: number }).n).toBe(revisionsBefore);
      expect((legacy.prepare("select count(*) as n from record_fts").get() as { n: number }).n).toBe(ftsBefore);
      expect(legacy.prepare("select id, raw_text from record_revision order by id").all()).toEqual(rawBefore);
      // 子表外键文本仍指向重建后的那张表，且重建后 CASCADE 照常生效（不是靠关掉外键蒙过去的）。
      const childSql = legacy.prepare("select sql from sqlite_master where name = 'record_revision'").get() as {
        sql: string;
      };
      expect(childSql.sql).toMatch(/REFERENCES capture_record \(id\) ON DELETE CASCADE/);
      legacy.exec("BEGIN IMMEDIATE");
      legacy.prepare("delete from capture_record where id = ?").run("rec_legacy_manual_only");
      legacy.exec("COMMIT");
      expect(
        (legacy.prepare("select count(*) as n from record_revision where record_id = 'rec_legacy_manual_only'").get() as {
          n: number;
        }).n,
      ).toBe(0);
      expect(legacy.prepare("select * from pragma_foreign_key_check").all()).toEqual([]);
    } finally {
      legacy.close();
      rmSync(dir, { recursive: true, force: true });
      staging.cleanup();
    }
  });

  it("重跑 0008 不丢行也不撞主键：崩溃落在「schema 已改、版本号未记」之间时升级路仍然走得通", () => {
    const sandbox = makeSandbox("tb-m6-0c-rerun-");
    const db = openSandboxDb(sandbox.layout);
    try {
      migrate(db);
      const id = createLegacyRecordOnHead(db, "cloud_redacted");
      const before = db
        .prepare("select processing_mode, analysis_provider, send_content_mode from capture_record where id = ?")
        .get(id) as Record<string, string>;
      // 把版本号抹掉 = 模拟那次崩溃：schema 已经是 0008 的形态，记录里却还没有第 8 版。
      db.prepare("delete from schema_migrations where version = 8").run();
      const again = migrate(db);
      expect(again.applied.map((f) => f.name)).toEqual(["three_axis_contract"]);
      expect(db.prepare("select processing_mode, analysis_provider, send_content_mode from capture_record where id = ?").get(id)).toEqual(
        before,
      );
      expect((db.prepare("select count(*) as n from record_revision").get() as { n: number }).n).toBe(1);
    } finally {
      db.close();
      sandbox.cleanup();
    }
  });
});

/** HEAD 形态下建一条带模式的记录（三轴由夹具写侧入口给，见 helpers/ingestFixtures 的理由）。 */
function createLegacyRecordOnHead(db: Database, mode: ProcessingModeValue): string {
  const id = `rec_head_${mode}`;
  const revisionId = `rev_head_${mode}`;
  expect(isProcessingModeValue(mode), mode).toBe(true);
  const axes = axesForProcessingMode(mode);
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(
      `insert into capture_record (id, created_at_utc, created_at_local, timezone_id, created_local_date,
         current_revision_id, processing_status, processing_mode, privacy_level,
         analysis_provider, redaction_mode, send_content_mode)
       values (?, ?, ?, ?, ?, ?, 'captured', ?, 'normal', ?, ?, ?)`,
    ).run(
      id,
      LEGACY_NOW,
      LEGACY_NOW,
      "Asia/Shanghai",
      "2026-10-17",
      revisionId,
      mode,
      axes.analysisProvider,
      axes.redactionMode,
      axes.sendContentMode,
    );
    db.prepare(
      `insert into record_revision (id, record_id, revision_number, raw_text, content_sha256, tokens,
         created_at_utc, created_at_local, timezone_id)
       values (?, ?, 1, ?, ?, '[]', ?, ?, 'Asia/Shanghai')`,
    ).run(revisionId, id, `${mode} 的原文`, "a".repeat(64), LEGACY_NOW, LEGACY_NOW);
    db.exec("COMMIT");
  } catch (cause) {
    db.exec("ROLLBACK");
    throw cause;
  }
  return id;
}

/* ════════════════════════════════════════════════════════════════════
 * D. §七 断言 6：trace 的三轴取值门
 * ════════════════════════════════════════════════════════════════════ */

describe("D. trace 注入：非法取值抛，合法取值过（§七 断言 6）", () => {
  const entry = (over: Partial<TraceEntry>): TraceEntry => ({
    recordRevisionId: "rev_m6_0c_trace",
    processingMode: "cloud_raw",
    analysisProvider: "cloud",
    redactionMode: "none",
    sendContentMode: "raw",
    ...over,
  });

  function capture(builder: () => unknown): unknown {
    try {
      builder();
      return undefined;
    } catch (cause) {
      return cause;
    }
  }

  it("三份封闭清单各自注入一个契约外取值 ⇒ TracePrivacyViolation，且消息点名是哪一个字段", () => {
    const offenders: [keyof TraceEntry, string][] = [
      ["analysisProvider", "hybrid"],
      ["analysisProvider", "cloud_raw"], // 模式值不是 provider 值：混档即拒
      ["analysisProvider", "CLOUD"],
      ["redactionMode", "semantic"],
      ["redactionMode", "none "],
      ["sendContentMode", "original"],
      ["sendContentMode", "raw|redacted"],
    ];
    for (const [key, value] of offenders) {
      const thrown = capture(() => serializeTrace([entry({ [key]: value } as Partial<TraceEntry>)]));
      expect(thrown, `${String(key)}=${value}`).toBeInstanceOf(TracePrivacyViolation);
      expect((thrown as Error).message).toContain(String(key));
      expect((thrown as Error).message).toMatch(/不在封闭集/);
    }
  });

  it("在册取值逐个放行：三轴的每个值都能序列化回来（历史/人工写入读得懂）", () => {
    for (const analysisProvider of ANALYSIS_PROVIDER_VALUES) {
      for (const redactionMode of REDACTION_MODE_VALUES) {
        for (const sendContentMode of SEND_CONTENT_MODE_VALUES) {
          const json = JSON.parse(
            serializeTrace([entry({ analysisProvider, redactionMode, sendContentMode })]),
          ) as Array<Record<string, unknown>>;
          expect(json[0]).toMatchObject({ analysisProvider, redactionMode, sendContentMode });
        }
      }
    }
  });

  it("合法组合的两档云端派生值在 trace 上留下可区分的三键（§七 断言 7 的 trace 面）", () => {
    const raw = axesForProcessingMode("cloud_raw");
    const redacted = axesForProcessingMode("cloud_redacted");
    const jsonRaw = serializeTrace([
      entry({ processingMode: "cloud_raw", analysisProvider: raw.analysisProvider, redactionMode: raw.redactionMode, sendContentMode: raw.sendContentMode }),
    ]);
    const jsonRedacted = serializeTrace([
      entry({
        processingMode: "cloud_redacted",
        analysisProvider: redacted.analysisProvider,
        redactionMode: redacted.redactionMode,
        sendContentMode: redacted.sendContentMode,
      }),
    ]);
    expect(jsonRaw).not.toBe(jsonRedacted);
    expect(jsonRaw).toContain('"sendContentMode":"raw"');
    expect(jsonRedacted).toContain('"sendContentMode":"redacted"');
    // 同一个云端适配器、同一条 provider/model：只有三轴能说明这次发的是原文还是脱敏文本。
    expect(jsonRaw).toContain('"analysisProvider":"cloud"');
    expect(jsonRedacted).toContain('"analysisProvider":"cloud"');
  });
});

/* ════════════════════════════════════════════════════════════════════
 * E. §八之三 3 / 4：档位「当前不可用」的门留在装配层，不留在守门处
 *    （M9-4b：占位清单清空，`local_llm` 已实现；判据从「没实现」换成「没配好」）
 * ════════════════════════════════════════════════════════════════════ */

describe("E. 档位不可用（§八之三 3/4，M9-4b 改写）", () => {
  it("占位清单已清空，但取值域没有因为档位改名而被重新裁剪", () => {
    expect([...UNIMPLEMENTED_REDACTION_MODES]).toEqual(RULES.placeholder_unimplemented);
    // M9-D-11：清单为空是「机制保留、当前无占位档」，不是把这套对账拆掉。
    expect(RULES.placeholder_unimplemented).toEqual([]);
    expect(UNIMPLEMENTED_REDACTION_MODES).toHaveLength(0);
    expect([...REDACTION_MODE_VALUES]).toEqual(["local_llm", "manual", "none"]);
    expect([...ANALYSIS_PROVIDER_VALUES]).toEqual(["local", "cloud", "none"]);
    expect([...SEND_CONTENT_MODE_VALUES]).toEqual(["redacted", "raw", "none"]);
    // 机制仍在，只是当前没有任何取值落在上面：`isUnimplementedRedactionMode` 恒为 false。
    expect(isUnimplementedRedactionMode("local_llm")).toBe(false);
    expect(isUnimplementedRedactionMode("manual")).toBe(false);
    expect(isUnimplementedRedactionMode("none")).toBe(false);
  });

  it("trace 取值门仍接受这三个档位，并在守门处写明取值域来源（§八之三-3）", () => {
    expect(() =>
      serializeTrace([
        {
          recordRevisionId: "rev_placeholder",
          analysisProvider: "local",
          redactionMode: "local_llm",
          sendContentMode: "none",
        },
      ]),
    ).not.toThrow();
    const traceSource = readFileSync("src/server/ingest/trace.ts", "utf8");
    const redactionGate = /redactionMode: \{[\s\S]*?\n  \},/.exec(traceSource)?.[0];
    expect(redactionGate, "trace.ts 里找不到 redactionMode 的取值门").toBeDefined();
    expect(redactionGate!).toMatch(/CONTRACT_ENUMS\.redaction_modes/); // 引用事实源，不抄第二份清单
    // M9-4b 不改 trace（属 M9-4d）：守门处依旧只做取值域判断，档位可不可用问的是装配层。
    expect(redactionGate!).not.toMatch(/localLlm|usable/);
  });

  it("含 local_llm 的组合：#3/#5/#8 矩阵判合法、可用性门按配置拒绝；#11 连组合门都过不了", () => {
    const withLocalLlm = RULES.combination_matrix.filter((r) => r.axes.split("|")[1] === "local_llm");
    expect(withLocalLlm.map((r) => r.row)).toEqual([3, 5, 8, 11]);
    const legalRows = withLocalLlm.filter((r) => r.legal);
    // §八之三-4 点名的正是这三行：它们现在**可达**，可达与否取决于配置而非实现缺口。
    expect(legalRows.map((r) => r.row)).toEqual([3, 5, 8]);
    const usable: LocalLlmStatus = {
      configured: true,
      loopback: true,
      usable: true,
      profile: null,
    };
    for (const row of legalRows) {
      const axes = tripleToAxes(row.axes);
      expect(row.legal, `矩阵 #${row.row}`).toBe(true);
      expect(isLegalCombination(axes)).toBe(true); // 取值域保留：组合表不因档位实现状态而变
      expect(isUnimplementedRedactionMode(axes.redactionMode)).toBe(false); // 旧判据不再负责拒它
      // 拒它的是可用性门，且理由来自配置读数：未配置 ⇒ `not_configured`（M9-D-10）。
      expect(() => assertRedactionPlanRunnable(axes, "rev_unavailable", LOCAL_LLM_STATUS_UNSET)).toThrow(
        RedactionModeUnavailableError,
      );
      // 反向：配好了 ⇒ 同一组轴原样放行，不再有任何「没实现」的静态拒绝。
      expect(() => assertRedactionPlanRunnable(axes, "rev_available", usable)).not.toThrow();
      expect(enums.processing_modes).toContain(deriveProcessingMode(axes));
    }
    // #11（cloud|local_llm|raw）是组合矛盾本身：由组合门拒，与档位可不可用无关。
    expect(withLocalLlm.filter((r) => !r.legal).map((r) => r.row)).toEqual([11]);
    expect(() => assertThreeAxes(tripleToAxes("cloud|local_llm|raw"))).toThrow(ThreeAxisCombinationError);
    // 库里同样写得进 #5 那一行（0008 的 CHECK 不替装配层做可用性判断）：拒绝发生在装配层，
    // 由 `m6-1a-two-track-http.test.ts` 与 `tests/m9-4b-tier-unavailable.test.ts` 用真实 HTTP 钉住
    // 「明确错误码 + 封闭 reason、不静默降级」。
    expect(() => assertThreeAxes(tripleToAxes("local|local_llm|none"))).not.toThrow();
  });
});
