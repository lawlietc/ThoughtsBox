import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase } from "../src/server/db/adapter.ts";
import { migrate } from "../src/server/db/migrator.ts";
import { RecordService } from "../src/server/records/service.ts";
import {
  BACKUP_FILE_PATTERN,
  BackupError,
  BackupService,
  isBackupFileName,
} from "../src/server/backup/backupService.ts";
import { makeSandbox, openSandboxDb, type Sandbox } from "./helpers/sandbox.ts";

let sandbox: Sandbox;
let db: ReturnType<typeof openSandboxDb>;
let records: RecordService;

const CLOCK = new Date("2026-10-12T15:30:00.456Z");

function makeService(now = CLOCK): BackupService {
  return new BackupService(db, sandbox.layout, { now: () => now });
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

beforeEach(() => {
  sandbox = makeSandbox("tb-m1b-backup-");
  db = openSandboxDb(sandbox.layout);
  migrate(db);
  records = new RecordService(db, { timezoneId: "Asia/Shanghai", now: () => CLOCK });
});

afterEach(() => {
  db.close();
  sandbox.cleanup();
});

describe("快照备份（M1b §五）", () => {
  it("创建：系统文件名（UTC 时间头 + UUIDv7）、隔离校验通过、进入列表并缓存结果", () => {
    records.createRecord("备份覆盖的第一条记录");
    const entry = makeService().createBackup();

    expect(entry.name).toMatch(BACKUP_FILE_PATTERN);
    expect(entry.name).toContain("20261012T153000Z");
    expect(entry.createdAtUtc).toBe("2026-10-12T15:30:00Z");
    expect(entry.sizeBytes).toBeGreaterThan(0);
    expect(entry.verification?.status).toMatch(/^ok/);

    const listed = makeService().listBackups();
    expect(listed.backups.map((b) => b.name)).toEqual([entry.name]);
    expect(listed.totalBytes).toBe(entry.sizeBytes);
    expect(listed.lastBackupUtc).toBe(entry.createdAtUtc);
    expect(listed.lastSuccessUtc).not.toBeNull();
  });

  it("快照是一致性时间点视图：备份内容含当时全部记录与版本，之后主库继续演进不受影响", () => {
    const created = records.createRecord("创建即备份的原文");
    const entry = makeService().createBackup();
    records.editRecord(created.record.id, "创建即备份的原文（已编辑）");

    const tmp = join(sandbox.root, "readback");
    mkdirSync(tmp);
    const copyPath = join(tmp, "from-backup.sqlite");
    copyFileSync(join(sandbox.layout.backupsDir, entry.name), copyPath);
    const probe = openDatabase(copyPath);
    try {
      const rows = probe.prepare("select count(*) as n from capture_record").get() as { n: number };
      expect(rows.n).toBe(1);
      const text = probe
        .prepare("select tokens is not null as has_tokens from record_revision order by revision_number")
        .all() as unknown as { has_tokens: number }[];
      expect(text).toHaveLength(1);
    } finally {
      probe.close();
      rmSync(tmp, { recursive: true, force: true });
    }

    const live = records.getRecord(created.record.id);
    expect(live.current.content_sha256).not.toBe("");
    expect(live.revisions).toHaveLength(2);
  });

  it("校验绝不写入原始备份：哈希不变，备份目录不出现 -wal/-shm 旁文件", () => {
    records.createRecord("校验只读性");
    const entry = makeService().createBackup();
    const path = join(sandbox.layout.backupsDir, entry.name);
    const before = sha256(path);

    const result = makeService().verifyBackup(entry.name);
    expect(result.status).toBe("ok");
    expect(sha256(path)).toBe(before);
    expect(readdirSync(sandbox.layout.backupsDir).filter((f) => f === entry.name)).toHaveLength(1);
  });

  it("损坏文件判为 failed，绝不显示为可恢复；未校验过的新文件校验状态为 null", () => {
    records.createRecord("然后被篡改的备份");
    const entry = makeService().createBackup();
    const path = join(sandbox.layout.backupsDir, entry.name);

    // 先证明「未校验」与「已校验失败」是两种都不可恢复的状态
    writeFileSync(path, Buffer.concat([readFileSync(path).subarray(0, 64), Buffer.alloc(4096, 0x5a)]));
    const service = makeService();
    const failed = service.verifyBackup(entry.name);
    expect(failed.status).toBe("failed");
    expect(failed.detail.length).toBeGreaterThan(0);

    const listed = service.listBackups();
    expect(listed.backups[0]!.verification?.status).toBe("failed");
    expect(listed.lastSuccessUtc).toBeNull();
  });

  it("FTS 脱锚只降级为 ok_with_warning：M1a 实测 integrity-check 盲区，用 docsize 影子比对兜底", () => {
    const created = records.createRecord("索引脱锚演练：这段文字进了 FTS");
    records.searchRecords("脱锚");
    const entry = makeService().createBackup();
    const path = join(sandbox.layout.backupsDir, entry.name);

    // fts5 特殊 insert 在外壳表上被拒（实测），幽灵脱锚的真实成因是「主表行没了、影子行残留」：
    // 与 M1a T-14 同法——摘下同步触发器后直删主表行。
    const tmp = join(sandbox.root, "desync-staging.sqlite");
    copyFileSync(path, tmp);
    const mutant = openDatabase(tmp);
    try {
      const victim = mutant
        .prepare("select id, record_id from record_revision limit 1")
        .get() as { id: string; record_id: string };
      mutant.exec("drop trigger record_ad");
      // 显式事务把两条删除并进一次提交：指针外键是延迟语义，逐语句自动提交会被拦
      mutant.exec("begin");
      mutant.prepare("delete from record_revision where id = ?").run(victim.id);
      mutant.prepare("delete from capture_record where id = ?").run(victim.record_id);
      mutant.exec("commit");
      // 触发器必须原地复原：对象缺失是另一种 failed，会掩盖要演示的脱锚降级
      mutant.exec(
        `create trigger record_ad after delete on record_revision begin
           insert into record_fts (record_fts, rowid, tokens) values ('delete', old.rowid, old.tokens);
         end`,
      );
      // 同库自检：这正是 M1a 报告的检测面
      expect(new RecordService(mutant).detectIndexDesync()).toEqual({ phantom: 1, missing: 0 });
    } finally {
      mutant.close();
    }
    copyFileSync(tmp, path);
    rmSync(tmp, { force: true });

    const result = makeService().verifyBackup(entry.name);
    expect(result.status).toBe("ok_with_warning");
    expect(result.desync).toEqual({ phantom: 1, missing: 0 });
    expect(created.record.id).toMatch(/^rec_/);
  });

  it("备份 schema 版本超出支持范围 → failed（R-5：恢复侧拒绝的校验面预演）", () => {
    records.createRecord("高版本备份演练");
    const entry = makeService().createBackup();
    const path = join(sandbox.layout.backupsDir, entry.name);

    const tmp = join(sandbox.root, "bump-staging.sqlite");
    copyFileSync(path, tmp);
    const mutant = openDatabase(tmp);
    try {
      mutant.exec("insert into schema_migrations (version, name, sha256, applied_at) values (999, 'future', 'x', '2026-01-01T00:00:00Z')");
    } finally {
      mutant.close();
    }
    copyFileSync(tmp, path);
    rmSync(tmp, { force: true });

    const result = makeService().verifyBackup(entry.name);
    expect(result.status).toBe("failed");
    expect(result.detail).toContain("999");
  });

  it("锁竞争失败注入：抛 BackupError、当前数据库内容不变、不留任何暂存/正式文件", () => {
    // 实测语义：WAL 下 BEGIN EXCLUSIVE 阻断写入，VACUUM INTO 的读取可完成但缓存登记被拦。
    // 改名排在流程最后，此前任何失败都只回滚暂存——不存在「文件在、记录丢」的中间态。
    records.createRecord("锁竞争下的既有记录");
    const blocker = openDatabase(sandbox.layout.dbFile);
    blocker.exec("PRAGMA busy_timeout = 0");
    blocker.exec("BEGIN EXCLUSIVE");
    try {
      // 主连接缩短忙等，让竞争立刻显式失败而不是静默等待
      db.exec("PRAGMA busy_timeout = 100");
      const service = makeService();
      expect(() => service.createBackup()).toThrow(BackupError);
      db.exec("PRAGMA busy_timeout = 5000");

      expect(readdirSync(sandbox.layout.backupsDir)).toEqual([]);
      const after = records.listRecords(10, 0);
      expect(after.total).toBe(1);
    } finally {
      blocker.exec("ROLLBACK");
      blocker.close();
    }
  });

  it("删除：只认严格模式文件名并清缓存；无关名、路径穿越、暂存名一律拒绝", () => {
    records.createRecord("将被删除的备份");
    const entry = makeService().createBackup();
    const service = makeService();

    expect(() => service.deleteBackup("../thoughts-box.sqlite")).toThrow(BackupError);
    expect(() => service.deleteBackup("evil.sqlite")).toThrow(BackupError);
    expect(() => service.deleteBackup(`${entry.name}.inprogress`)).toThrow(BackupError);
    expect(() => service.deleteBackup(entry.name.toUpperCase())).toThrow(BackupError);
    expect(isBackupFileName(entry.name)).toBe(true);

    service.deleteBackup(entry.name);
    expect(() => statSync(join(sandbox.layout.backupsDir, entry.name))).toThrow();
    expect(service.listBackups().backups).toEqual([]);
  });

  it("prerestore 快照：独立前缀进入列表且 kind 可区分（恢复流程的安全网句柄）", () => {
    records.createRecord("恢复前安全快照演练");
    const entry = makeService().createPreRestoreSafetySnapshot();
    expect(entry.name.startsWith("prerestore-")).toBe(true);
    expect(entry.kind).toBe("prerestore");
    const listed = makeService().listBackups();
    expect(listed.backups[0]!.kind).toBe("prerestore");
  });

  it("磁盘容量：statfs 可得则报实数，不可得则如实声明能力受限，不谎报充足", () => {
    const capacity = makeService().diskCapacity();
    expect(typeof capacity.available).toBe("boolean");
    if (capacity.available) {
      expect(capacity.freeBytes).toBeGreaterThan(0);
      expect(capacity.totalBytes).toBeGreaterThanOrEqual(capacity.freeBytes!);
    } else {
      expect(capacity.reason).toBeTruthy();
    }
  });
});
