import { existsSync, readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { migrate } from "../src/server/db/migrator.ts";
import { RecordService } from "../src/server/records/service.ts";
import { makeSandbox, openSandboxDb, type Sandbox } from "./helpers/sandbox.ts";
import type { Database } from "../src/server/db/adapter.ts";
import type { DataLayout } from "../src/server/config/paths.ts";

/**
 * 字节级删除隐私测试（T-09/T-10/T-11，U-1 有条件批准的替代组合）。
 *
 * 承诺边界（Schema 审查稿 §11.2 U-1，必须原样进入交付文档）：这是针对 SQLite 数据文件、
 * FTS 索引与 WAL 的**尽力清理机制**，不保证所有物理副本绝对不可恢复——旧备份、
 * 操作系统缓存、SSD 磨损均衡与其他固件副本不在承诺范围内。
 *
 * 测试纪律：验证必须落到**文件字节**（删除 → checkpoint(TRUNCATE) → 全文件字节扫描），
 * 不得只查询 SQL 表来代替底层文件检查（M1a 指令 §六）。
 */

/** 高辨识、成段落的探针原文：任何 8-gram 残留在字节层都应当可见。 */
const SECRET_A = "朱雀桥边野草花，乌衣巷口夕阳斜。旧时王谢堂前燕，飞入寻常百姓家。";
const SECRET_B = "峰回路转，有亭翼然临于泉上者——此段仅用于删除后字节核对，不应在任何文件中留下痕迹。";

function grams(text: string, size = 8): string[] {
  const out: string[] = [];
  for (let i = 0; i + size <= text.length; i++) out.push(text.slice(i, i + size));
  if (text.length < size) out.push(text);
  return out;
}

/** 数据文件 + 伴生 -wal/-shm（若存在）：一并纳入字节扫描，杜绝「主文件干净、WAL 里躺着原文」。 */
function collectFileBytes(layout: DataLayout): Array<{ name: string; data: Buffer }> {
  const files = [layout.dbFile, `${layout.dbFile}-wal`, `${layout.dbFile}-shm`];
  const out: Array<{ name: string; data: Buffer }> = [];
  for (const f of files) {
    if (existsSync(f)) out.push({ name: f, data: readFileSync(f) });
  }
  return out;
}

function findLeaks(needles: Iterable<string>, blobs: Array<{ name: string; data: Buffer }>): string[] {
  const leaks: string[] = [];
  for (const needle of needles) {
    const buf = Buffer.from(needle, "utf8");
    for (const blob of blobs) {
      if (blob.data.includes(buf)) leaks.push(`${blob.name} :: ${needle}`);
    }
  }
  return leaks;
}

let sandbox: Sandbox;
let db: Database;
let service: RecordService;

beforeEach(() => {
  sandbox = makeSandbox("tb-m1a-privacy-");
  db = openSandboxDb(sandbox.layout);
  migrate(db);
  service = new RecordService(db, {
    timezoneId: "Asia/Shanghai",
    now: () => new Date("2026-10-12T06:30:00Z"),
  });
});

afterEach(() => {
  try {
    db.close();
  } catch {
    /* 测试体内可能已显式关闭 */
  }
  sandbox.cleanup();
});

describe("T-09：硬删除后字节级零残留（WAL + checkpoint(TRUNCATE)）", () => {
  it("删除+清理后，raw_text 与 tokens 的每个 8-gram 在全部数据文件中 0 命中", () => {
    const created = service.createRecord(SECRET_A);
    service.editRecord(created.record.id, SECRET_B);
    const tokens = (
      db.prepare("select tokens from record_revision").all() as Array<{ tokens: string }>
    ).map((r) => r.tokens);
    const needles = new Set<string>([...grams(SECRET_A), ...grams(SECRET_B), ...tokens.flatMap((t) => grams(t))]);

    const deleted = service.deleteRecord(created.record.id);
    expect(deleted.phaseB.status).toBe("ok");

    // 关闭连接：WAL/SHM 应随最后一次 checkpoint 消失或被截断；扫描发生在字节层。
    db.close();
    const blobs = collectFileBytes(sandbox.layout);
    expect(blobs.length).toBeGreaterThanOrEqual(1);
    const leaks = findLeaks(needles, blobs);
    expect(leaks).toEqual([]);
  });

  it("DELETE 回退模式下同样成立（journal_mode=DELETE 双模式守门）", () => {
    db.exec("PRAGMA journal_mode = DELETE");
    expect(
      (db.prepare("pragma journal_mode").get() as { journal_mode: string }).journal_mode,
    ).toBe("delete");

    const created = service.createRecord(SECRET_B);
    const tokens = (
      db.prepare("select tokens from record_revision").all() as Array<{ tokens: string }>
    ).map((r) => r.tokens);
    const needles = new Set<string>([...grams(SECRET_B), ...tokens.flatMap((t) => grams(t))]);

    const deleted = service.deleteRecord(created.record.id);
    expect(deleted.phaseA.committed).toBe(true);

    db.close();
    const leaks = findLeaks(needles, collectFileBytes(sandbox.layout));
    expect(leaks).toEqual([]);
  });

  it("能力探测记录：本构建 FTS5 secure_delete 表选项不被支持时机制仍成立（U-1 实测面）", () => {
    // 实测陷阱：裸形态 `fts5(x, secure_delete)` 会被解析成第二个「列名」而假通过；
    // 探测必须用选项形态 `secure_delete=1`。本机 Node 内建 SQLite 3.53.1 实测：unrecognized option。
    const supports = (() => {
      try {
        db.exec("create virtual table probe_fts using fts5(x, secure_delete=1)");
        db.exec("drop table probe_fts");
        return true;
      } catch {
        return false;
      }
    })();
    const created = service.createRecord(SECRET_A);
    service.deleteRecord(created.record.id);
    db.close();
    const leaks = findLeaks(grams(SECRET_A), collectFileBytes(sandbox.layout));
    expect(leaks).toEqual([]);
    // 把本机实测事实留在测试输出里（不得以推断代替实测）。
    console.info(`[U-1 实测] FTS5 secure_delete 表选项（secure_delete=1 形态）支持: ${supports}`);
  });
});

describe("T-11：审计行不含被删原文（deletion_audit 全表 × 8-gram 无交集）", () => {
  it("删除后审计表所有文本字段与被删 raw_text/tokens 任意 8-gram 无交集", () => {
    const created = service.createRecord(SECRET_A);
    service.editRecord(created.record.id, SECRET_B);
    const tokens = (
      db.prepare("select tokens from record_revision").all() as Array<{ tokens: string }>
    ).map((r) => r.tokens);
    service.deleteRecord(created.record.id);

    const rows = db.prepare("select * from deletion_audit").all() as Array<Record<string, unknown>>;
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const auditText = rows
      .flatMap((row) => Object.values(row))
      .filter((v): v is string => typeof v === "string")
      .join("\n");
    for (const gram of [...grams(SECRET_A), ...grams(SECRET_B), ...tokens.flatMap((t) => grams(t))]) {
      expect(auditText).not.toContain(gram);
    }
    // affected 只能是封闭计数键名（无自由文本 → 无原文通道）。
    for (const row of rows) {
      const affected = JSON.parse(row.affected as string) as Record<string, unknown>;
      expect(Object.keys(affected).sort()).toEqual(["revisions"]);
    }
  });
});

describe("T-10：全量重建一致性（同查询集重建前后结果相等 + integrity-check 通过）", () => {
  it("rebuild 前后查询集命中完全一致，integrity-check 不抛错", () => {
    const r1 = service.createRecord(SECRET_A);
    service.editRecord(r1.record.id, SECRET_B);
    service.createRecord("今天下午评审会，讨论脱敏管道的重试策略。");

    const queries = ["朱雀", "夕阳", "评审会", "脱敏", "巷口夕阳斜"];
    const snapshot = (): Array<[string, string[]]> =>
      queries.map((q) => [
        q,
        service
          .searchRecords(q)
          .hits.map((h) => h.id)
          .sort(),
      ]);

    const before = snapshot();
    // rebuildSearchIndex 内部执行 rebuild + integrity-check（external-content 一致性核验）。
    service.rebuildSearchIndex();
    const after = snapshot();
    expect(after).toEqual(before);
    expect(service.detectIndexDesync()).toEqual({ phantom: 0, missing: 0 });
  });
});
