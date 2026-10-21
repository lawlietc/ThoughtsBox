import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { boot, shutdown } from "../src/server/runtime/bootstrap.ts";
import { checkpointAndTruncate, openDatabase, type Database } from "../src/server/db/adapter.ts";
import { ensureConfigFile } from "../src/server/config/config.ts";
import { resolveDataLayout, type DataLayout } from "../src/server/config/paths.ts";
import { currentSchemaVersion, migrate } from "../src/server/db/migrator.ts";
import { seedVocabulary } from "../src/server/db/seed.ts";
import { RecordService } from "../src/server/records/service.ts";
import { serializeTokens, tokenize } from "../src/shared/search/tokenizer.ts";
import { DataCheckFailure, runDataCheck } from "../src/server/runtime/dataCheck.ts";
import { HEAD_SCHEMA_VERSION, makeSandbox, openSandboxDb, type Sandbox } from "./helpers/sandbox.ts";

/**
 * §8.3 的七项自检测试 + 启动整合。脱锚构造沿用 M1a 实测配方：
 * 幽灵 = 摘掉 record_ad 后删主表行（级联删版本而索引残留影子行）；
 * 缺失 = 摘掉 record_ai 后直接 INSERT（版本行存在而索引无影子行）。
 * 两种都必须当场恢复触发器原文，否则失败会落在 required-objects 上，
 * 掩盖真正要测的一致性判据。
 */

const ALL_STEPS = [
  "schema-version",
  "required-objects",
  "integrity-check",
  "foreign-key-check",
  "fts-queryable",
  "fts-index-consistency",
] as const;

const TRIGGER_AD = `create trigger record_ad after delete on record_revision begin
  insert into record_fts(record_fts, rowid, tokens) values ('delete', old.rowid, old.tokens);
end;`;
const TRIGGER_AI = `create trigger record_ai after insert on record_revision begin
  insert into record_fts(rowid, tokens) values (new.rowid, new.tokens);
end;`;

let sandbox: Sandbox;
let db: Database;
let service: RecordService;

beforeEach(() => {
  sandbox = makeSandbox("tb-m1b-datacheck-");
  db = openSandboxDb(sandbox.layout);
  migrate(db);
  seedVocabulary(db);
  service = new RecordService(db);
});

afterEach(() => {
  try {
    db.close();
  } catch {
    /* 施暴用例可能已经关过句柄 */
  }
  sandbox.cleanup();
});

function expectDataCheckFailure(handle: Database): DataCheckFailure {
  try {
    runDataCheck(handle);
    throw new Error("数据面自检竟然通过了——本用例预期失败");
  } catch (cause) {
    expect(cause).toBeInstanceOf(DataCheckFailure);
    return cause as DataCheckFailure;
  }
}

function makePhantom(handle: Database, recordId: string): void {
  handle.exec("drop trigger record_ad");
  handle.prepare("delete from capture_record where id = ?").run(recordId);
  handle.exec(TRIGGER_AD);
}

describe("数据面自检（M1b §八）", () => {
  it("①健康的当前版本库通过全部六项检查", () => {
    service.createRecord("健康探针用的一条记录");
    const report = runDataCheck(db);
    expect(report.schemaVersion).toBe(HEAD_SCHEMA_VERSION);
    expect(report.passedSteps).toEqual([
      "schema-version",
      "required-objects",
      "integrity-check",
      "foreign-key-check",
      "fts-queryable",
      "fts-index-consistency",
    ]);
    expect(report.searchIndexRebuilt).toBe(false);
    expect(report.desyncBeforeRebuild).toBeNull();
  });

  it("②缺少必需对象时按名字定位能力缺口", () => {
    service.createRecord("对象缺失演练");
    db.exec("drop trigger record_ad");
    const triggerFail = expectDataCheckFailure(db);
    expect(triggerFail.step).toBe("required-objects");
    expect(triggerFail.detail).toContain("触发器 record_ad");
    db.exec(TRIGGER_AD);

    db.exec("drop index ix_capture_record_local_date");
    const indexFail = expectDataCheckFailure(db);
    expect(indexFail.detail).toContain("索引 ix_capture_record_local_date");
  });

  it("②表级缺失同样点名（record_fts 整表消失无法自动修复，只能显式阻断）", () => {
    service.createRecord("虚表缺失演练");
    db.exec("drop table record_fts");
    const failure = expectDataCheckFailure(db);
    expect(failure.step).toBe("required-objects");
    expect(failure.detail).toContain("表 record_fts");
    expect(failure.message).toContain("数据面自检失败〔required-objects〕");
  });

  it("③外键违规被识别：违规=缺陷，不自动清洗（M1a 契约）", () => {
    service.createRecord("外键演练：存活记录");
    db.exec("PRAGMA foreign_keys = OFF");
    db.prepare(
      `insert into record_revision (id, record_id, revision_number, raw_text, content_sha256, tokens, created_at_utc, created_at_local, timezone_id)
       values ('rev_fk_幽灵', 'rec_fk_不存在', 1, '孤儿版本', ?, ?, '2026-10-12T10:00:00.000Z', '2026-10-12T10:00:00Z', 'Asia/Shanghai')`,
    ).run("0".repeat(64), serializeTokens(tokenize("孤儿版本")));
    db.exec("PRAGMA foreign_keys = ON");

    const failure = expectDataCheckFailure(db);
    expect(failure.step).toBe("foreign-key-check");
    expect(failure.detail).toMatch(/1 行外键违规/);
    // 不自愈：检查失败后违规行必须还在，清洗是显式决策，不是自检的副作用。
    const still = db.prepare("select count(*) as n from record_revision where id = 'rev_fk_幽灵'").get() as { n: number };
    expect(still.n).toBe(1);
  });

  it("④幽灵行脱锚：integrity_check 与 FTS5 integrity-check 都不报错，判据是 docsize 对照", () => {
    const a = service.createRecord("幻影词 alpha 将被绕过删除");
    service.createRecord("留存词 beta 仍在");
    makePhantom(db, a.record.id);

    // M1a 实测事实的回归钉：两道「传统」检查都是绿的——只信它们就会误判健康。
    const integrity = db.prepare("PRAGMA integrity_check").all() as unknown as { integrity_check: string }[];
    expect(integrity).toEqual([{ integrity_check: "ok" }]);
    expect(() => db.exec("insert into record_fts(record_fts) values('integrity-check')")).not.toThrow();
    expect(service.detectIndexDesync().phantom).toBe(1);

    const report = runDataCheck(db);
    expect(report.searchIndexRebuilt).toBe(true);
    expect(report.desyncBeforeRebuild).toEqual({ phantom: 1, missing: 0 });
    // 重建后：幻影影子行消失，留存记录检索不受影响。
    expect(service.detectIndexDesync()).toEqual({ phantom: 0, missing: 0 });
    expect(service.searchRecords("beta").hits).toHaveLength(1);
    expect(service.searchRecords("alpha").hits).toHaveLength(0);
  });

  it("⑤缺失脱锚（绕过 record_ai 直插）：重建后检索恢复并通过再次检查", () => {
    const text = "补录的缺失词元 delta";
    db.exec("drop trigger record_ai");
    db.exec("BEGIN IMMEDIATE");
    db.prepare(
      `insert into capture_record (id, created_at_utc, created_at_local, timezone_id, created_local_date, current_revision_id)
       values ('rec_dc_missing', '2026-10-12T10:00:00.000Z', '2026-10-12T18:00:00+08:00', 'Asia/Shanghai', '2026-10-12', 'rev_dc_missing')`,
    ).run();
    db.prepare(
      `insert into record_revision (id, record_id, revision_number, raw_text, content_sha256, tokens, created_at_utc, created_at_local, timezone_id)
       values ('rev_dc_missing', 'rec_dc_missing', 1, ?, ?, ?, '2026-10-12T10:00:00.000Z', '2026-10-12T18:00:00+08:00', 'Asia/Shanghai')`,
    ).run(text, createHash("sha256").update(text.normalize("NFC")).digest("hex"), serializeTokens(tokenize(text)));
    db.exec("COMMIT");
    db.exec(TRIGGER_AI);

    // 重建前：索引查不到这条真实存在的记录。
    expect(service.searchRecords("delta").hits).toHaveLength(0);

    const report = runDataCheck(db);
    expect(report.searchIndexRebuilt).toBe(true);
    expect(report.desyncBeforeRebuild).toEqual({ phantom: 0, missing: 1 });

    const recheck = runDataCheck(db);
    expect(recheck.desyncBeforeRebuild).toBeNull();
    expect(recheck.passedSteps).toContain("fts-index-consistency");
    expect(service.searchRecords("delta").hits.map((h) => h.id)).toEqual(["rev_dc_missing"]);
  });

  it("⑥损坏库文件的裸报错被归名到具体检查步骤（不静默、不裸抛）", () => {
    service.createRecord("截断演练的数据体");
    checkpointAndTruncate(db);
    db.close();
    const bytes = readFileSync(sandbox.layout.dbFile);
    const truncated = join(sandbox.root, "truncated.sqlite");
    writeFileSync(truncated, bytes.subarray(0, Math.floor(bytes.length / 2)));

    const broken = openDatabase(truncated);
    try {
      const failure = expectDataCheckFailure(broken);
      expect(ALL_STEPS).toContain(failure.step);
      expect(failure.detail).toContain("检查异常终止");
      // 本机实测（2026-10-13）：截断库的裸报错原文是英文 "database disk image is malformed"。
      expect(failure.detail).toMatch(/malformed/i);
    } finally {
      try {
        broken.close();
      } catch {
        /* 坏库关闭失败不掩盖检查结果断言 */
      }
    }
  });
});

// —— ⑦ 启动整合：自检挂在迁移/播种之后、对外服务之前；失败沿用 M0 fail-fast ——

async function testPort(): Promise<number> {
  const { createServer } = await import("node:net");
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (address === null || typeof address === "string") {
        reject(new Error("无法取得空闲端口"));
        return;
      }
      probe.close(() => resolve(address.port));
    });
  });
}

function bootLayout(dataDir: string, port: number): DataLayout {
  const layout = resolveDataLayout({ TB_DATA_DIR: dataDir });
  mkdirSync(layout.dataDir, { recursive: true });
  const file = ensureConfigFile(layout);
  const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  (raw.server as Record<string, unknown>).port = port;
  writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
  return layout;
}

describe("启动整合（数据面自检进入 boot）", () => {
  it("boot 输出数据面自检通过日志，服务照常可用", async () => {
    const bootSandbox = makeSandbox("tb-m1b-dc-boot-");
    const port = await testPort();
    const layout = bootLayout(bootSandbox.root, port);
    const lines: string[] = [];
    const booted = await boot({ env: { TB_DATA_DIR: bootSandbox.root }, log: (l) => lines.push(l) });
    try {
      expect(
        lines.some((l) => l.includes(`数据面自检通过：schema v${HEAD_SCHEMA_VERSION}，检查 ${ALL_STEPS.length} 项`)),
      ).toBe(true);
      expect(booted.schemaVersion).toBe(HEAD_SCHEMA_VERSION);
    } finally {
      await shutdown(booted);
      bootSandbox.cleanup();
    }
    expect(existsSync(layout.lockFile)).toBe(false);
  });

  it("boot 自动修复可重建的脱锚库：带幽灵索引也能干净开门", async () => {
    const bootSandbox = makeSandbox("tb-m1b-dc-repair-");
    bootLayout(bootSandbox.root, await testPort());
    const first = await boot({ env: { TB_DATA_DIR: bootSandbox.root }, log: () => {} });
    const doomed = first.records.createRecord("残留幻影词 gamma");
    first.records.createRecord("留存词 delta2 正常");
    await shutdown(first);

    const offline = openSandboxDb(bootSandbox.layout);
    makePhantom(offline, doomed.record.id);
    const desyncBefore = new RecordService(offline).detectIndexDesync();
    expect(desyncBefore.phantom).toBe(1);
    offline.close();

    const lines: string[] = [];
    const second = await boot({ env: { TB_DATA_DIR: bootSandbox.root }, log: (l) => lines.push(l) });
    try {
      expect(lines.some((l) => l.includes("搜索索引已自动重建"))).toBe(true);
      expect(second.records.detectIndexDesync()).toEqual({ phantom: 0, missing: 0 });
      expect(second.records.searchRecords("gamma").hits).toHaveLength(0);
      expect(second.records.searchRecords("delta2").hits).toHaveLength(1);
    } finally {
      await shutdown(second);
      bootSandbox.cleanup();
    }
  });

  it("数据面自检失败沿 M0 fail-fast：boot 显式失败、释放锁、不带着坏现场开门", async () => {
    const bootSandbox = makeSandbox("tb-m1b-dc-block-");
    const layout = bootLayout(bootSandbox.root, await testPort());
    const first = await boot({ env: { TB_DATA_DIR: bootSandbox.root }, log: () => {} });
    first.records.createRecord("将被抽掉索引库的演练");
    await shutdown(first);

    const offline = openSandboxDb(layout);
    offline.exec("drop table record_fts");
    offline.close();

    try {
      await boot({ env: { TB_DATA_DIR: bootSandbox.root }, log: () => {} });
      throw new Error("boot 竟然带着缺失 record_fts 的库启动了");
    } catch (cause) {
      expect(cause).toBeInstanceOf(DataCheckFailure);
      expect((cause as DataCheckFailure).step).toBe("required-objects");
      expect((cause as DataCheckFailure).detail).toContain("表 record_fts");
    }
    expect(existsSync(layout.lockFile)).toBe(false);
    // statSync 证明库文件仍在：失败不毁现场，修复是用户的显式决策。
    expect(statSync(layout.dbFile).isFile()).toBe(true);
    bootSandbox.cleanup();
  });
});
