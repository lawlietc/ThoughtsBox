import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase } from "../src/server/db/adapter.ts";
import {
  MIGRATIONS_DIR,
  currentSchemaVersion,
  listMigrationFiles,
  migrate,
  setMeta,
} from "../src/server/db/migrator.ts";
import { STORAGE_MAINTENANCE_KEY } from "../src/server/records/service.ts";
import { Workspace } from "../src/server/runtime/workspace.ts";
import { RestoreError, restoreFromBackup } from "../src/server/backup/restoreService.ts";
import { makeSandbox, openSandboxDb, type Sandbox } from "./helpers/sandbox.ts";

let sandbox: Sandbox;
let db: ReturnType<typeof openSandboxDb>;
let workspace: Workspace;

function backupPath(name: string): string {
  return join(sandbox.layout.backupsDir, name);
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * 本文件不重复钉 schema 版本（那一钉在 m0-migration-seed）：这里只关心「恢复/重放相对当前版本」的行为，
 * 所以版本号一律从迁移目录读出来，避免每个里程碑都回来改一遍与语义无关的字面量。
 * PROBE_VERSION 是一个尚未落地的高位版本号，用来模拟「应用比备份新」。
 */
const CURRENT_VERSION = listMigrationFiles(MIGRATIONS_DIR).at(-1)!.version;
const PROBE_VERSION = CURRENT_VERSION + 1;

/** 在备份文件的临时副本上施暴后放回——校验面接受、重开面出问题的构造手段。 */
function mutateBackup(name: string, mutate: (handle: ReturnType<typeof openDatabase>) => void): void {
  const tmp = join(sandbox.root, `mutate-${name}.sqlite`);
  copyFileSync(backupPath(name), tmp);
  const mutant = openDatabase(tmp);
  try {
    mutate(mutant);
  } finally {
    mutant.close();
  }
  copyFileSync(tmp, backupPath(name));
  rmSync(tmp, { force: true });
}

function expectRestoreFailure(name: string): RestoreError {
  try {
    restoreFromBackup(workspace, name);
    throw new Error("恢复竟然成功了——本用例预期失败");
  } catch (cause) {
    expect(cause).toBeInstanceOf(RestoreError);
    return cause as RestoreError;
  }
}

beforeEach(() => {
  sandbox = makeSandbox("tb-m1b-restore-");
  db = openSandboxDb(sandbox.layout);
  migrate(db);
  workspace = new Workspace(sandbox.layout, db, currentSchemaVersion(db));
});

afterEach(() => {
  try {
    workspace.db.close();
  } catch {
    /* 已关闭的旧句柄不需要二次关闭 */
  }
  if (workspace.db !== db) {
    try {
      db.close();
    } catch {
      /* 恢复流程已经关过原句柄 */
    }
  }
  sandbox.cleanup();
});

describe("快照恢复（M1b §六 R-5：整库原位替换）", () => {
  it("基本替换：库内容回到备份时刻，索引与查询在新句柄上全功能", () => {
    const a = workspace.records.createRecord("恢复演练：甲记录");
    workspace.records.editRecord(a.record.id, "恢复演练：甲记录（备份版）");
    const backup = workspace.backups.createBackup();
    const hashBefore = sha256(backupPath(backup.name));

    workspace.records.createRecord("恢复后会消失的记录");
    workspace.records.editRecord(a.record.id, "恢复演练：甲记录（备份后编辑）");

    const result = restoreFromBackup(workspace, backup.name);
    expect(result.schemaVersion).toBe(CURRENT_VERSION);
    expect(result.fromSchemaVersion).toBe(CURRENT_VERSION);
    expect(result.records).toBe(1);
    expect(result.revisions).toBe(2);
    expect(result.safetyBackupName.startsWith("prerestore-")).toBe(true);
    // 备份文件只读消费：恢复不改它一个字节
    expect(sha256(backupPath(backup.name))).toBe(hashBefore);

    const live = workspace.records.getRecord(a.record.id);
    expect(live.revisions).toHaveLength(2);
    expect(live.current.raw_text).toBe("恢复演练：甲记录（备份版）");
    expect(workspace.records.searchRecords("会消失").hits).toHaveLength(0);
    expect(workspace.records.searchRecords("甲记录").hits.length).toBeGreaterThan(0);
    expect(workspace.records.detectIndexDesync()).toEqual({ phantom: 0, missing: 0 });
    expect(workspace.db).not.toBe(db);
  });

  it("已删除记录随整库复活（K-20 边界）；删除审计随库文件走", () => {
    const doomedLater = workspace.records.createRecord("备份后会被删除又复活");
    workspace.records.createRecord("备份前就已被删除");
    const backup = workspace.backups.createBackup();

    workspace.records.deleteRecord(doomedLater.record.id);
    expect(workspace.records.listRecords(10, 0).total).toBe(1);

    const result = restoreFromBackup(workspace, backup.name);
    expect(result.records).toBe(2);
    const revived = workspace.records.getRecord(doomedLater.record.id);
    expect(revived.current.raw_text).toContain("又复活");
    // 备份后的那次删除不在恢复后的履历里：审计（deletion_audit 行）也回到了备份时刻
    expect(workspace.records.listRecords(10, 0).total).toBe(2);
  });

  it("拒绝先于动作：高 schema 版本备份（R-5 拒绝并提示升级）不产生任何副作用", () => {
    const kept = workspace.records.createRecord("拒绝恢复演练：现存记录");
    const backup = workspace.backups.createBackup();
    mutateBackup(backup.name, (mutant) => {
      mutant.exec(
        "insert into schema_migrations (version, name, sha256, applied_at) values (999, 'future', 'x', '2026-01-01T00:00:00Z')",
      );
    });

    const error = expectRestoreFailure(backup.name);
    expect(error.message).toMatch(/高于当前应用支持/);
    expect(error.message).toMatch(/升级/);
    // 拒绝发生在安全快照之前：备份目录只有那一份被施暴的备份
    expect(readdirSync(sandbox.layout.backupsDir)).toEqual([backup.name]);
    expect(workspace.records.getRecord(kept.record.id).record.id).toBe(kept.record.id);

    // 非法文件名同样拒绝，且不碰库
    const second = expectRestoreFailure("../outside.sqlite");
    expect(second.message).toMatch(/拒绝/);
    expect(workspace.db).toBe(db);
  });

  it("中途失败注入（历史迁移 sha 漂移）：回滚到恢复前状态，数据完好，让位文件归位", () => {
    const a = workspace.records.createRecord("回滚演练：备份后继续工作");
    const backup = workspace.backups.createBackup();
    workspace.records.editRecord(a.record.id, "回滚演练：备份后继续工作（改）");

    // 校验面只看版本号；重开迁移面会因 sha 漂移显式失败——两个面的缝隙正是回滚要 cover 的场景
    mutateBackup(backup.name, (mutant) => {
      mutant.exec("update schema_migrations set sha256 = 'deadbeef' where version = 1");
    });

    const error = expectRestoreFailure(backup.name);
    expect(error.message).toMatch(/回滚/);
    expect(error.safetyBackupName).toMatch(/^prerestore-/);

    // 现库回到恢复前：内容仍是「备份后继续工作（改）」
    const live = workspace.records.getRecord(a.record.id);
    expect(live.current.raw_text).toBe("回滚演练：备份后继续工作（改）");
    expect(existsSync(sandbox.layout.dbFile)).toBe(true);
    expect(readdirSync(sandbox.layout.dataDir).filter((f) => f.includes(".replaced-"))).toEqual([]);
    // 安全快照留在备份目录：可再校验、可再恢复
    expect(readdirSync(sandbox.layout.backupsDir).some((f) => f.startsWith("prerestore-"))).toBe(true);
  });

  it("备份 schema 更旧：恢复时按序重放迁移，业务数据保住、新库带上新对象", () => {
    const a = workspace.records.createRecord("版本重放演练");
    const backup = workspace.backups.createBackup();

    // 在沙箱里复制一份迁移目录并追加一个**比当前应用更高**的迁移：让「当前应用」比备份新——
    // R-5 的另一半（旧备份可恢复并升级）。版本号从真实目录推导，绝不与已落地的 0003/0004 相撞。
    // 不写共享 MIGRATIONS_DIR：并行运行的其他用例（如启动自检的重放检查）会被多余文件误伤。
    const futureDir = join(sandbox.root, "migrations-future");
    mkdirSync(futureDir);
    for (const file of readdirSync(MIGRATIONS_DIR)) {
      copyFileSync(join(MIGRATIONS_DIR, file), join(futureDir, file));
    }
    const probeFile = `${String(PROBE_VERSION).padStart(4, "0")}_restore_replay_probe.sql`;
    writeFileSync(join(futureDir, probeFile), "create table restore_replay_probe (marker text) STRICT;\n", "utf8");

    const result = restoreFromBackup(workspace, backup.name, { migrationsDir: futureDir });
    expect(result.fromSchemaVersion).toBe(CURRENT_VERSION);
    expect(result.schemaVersion).toBe(PROBE_VERSION);
    expect(workspace.schemaVersion).toBe(PROBE_VERSION);
    const probe = workspace.db
      .prepare("select count(*) as n from restore_replay_probe")
      .get() as { n: number };
    expect(probe.n).toBe(0);
    const live = workspace.records.getRecord(a.record.id);
    expect(live.current.raw_text).toBe("版本重放演练");
  });

  it("备份中的 storage_maintenance_pending 任务随库复活并用同一条幂等重试路径处理", () => {
    setMeta(
      db,
      STORAGE_MAINTENANCE_KEY,
      JSON.stringify([
        {
          operation: "delete",
          object_id: "rec_历史任务对象",
          failed_step: "wal_checkpoint_truncate",
          ts: "2026-10-11T00:00:00.000Z",
        },
      ]),
    );
    workspace.records.createRecord("带着待清理任务的时间点");
    const backup = workspace.backups.createBackup();

    // 当前库随后清空了任务集合——恢复后应以备份内容为准重新面对它
    setMeta(db, STORAGE_MAINTENANCE_KEY, JSON.stringify([]));

    const result = restoreFromBackup(workspace, backup.name);
    expect(result.maintenanceTasksFound).toBe(1);
    expect(result.maintenanceOk).toBe(true);
    expect(result.maintenanceResolved).toBe(1);
    expect(workspace.records.getMaintenanceTasks()).toEqual([]);
  });

  it("恢复前安全快照覆盖回滚边界：事后校验通过，内容恰是恢复前状态", () => {
    const a = workspace.records.createRecord("安全快照演练");
    workspace.records.editRecord(a.record.id, "安全快照演练（将被快照保护的状态）");
    const backup = workspace.backups.createBackup();

    const result = restoreFromBackup(workspace, backup.name);
    const verification = workspace.backups.verifyBackup(result.safetyBackupName);
    expect(verification.status).toBe("ok");

    const tmp = join(sandbox.root, "safety-read.sqlite");
    copyFileSync(backupPath(result.safetyBackupName), tmp);
    const probe = openDatabase(tmp);
    try {
      const text = probe
        .prepare("select raw_text from record_revision order by revision_number desc limit 1")
        .get() as { raw_text: string };
      expect(text.raw_text).toBe("安全快照演练（将被快照保护的状态）");
    } finally {
      probe.close();
      rmSync(tmp, { force: true });
    }

    const listed = workspace.backups.listBackups();
    expect(listed.backups.some((b) => b.name === result.safetyBackupName)).toBe(true);
  });

  it("恢复后换血完整性：新句柄可写、备份服务绑在新库上、缓存登记延续", () => {
    workspace.records.createRecord("换血演练");
    const backup = workspace.backups.createBackup();

    restoreFromBackup(workspace, backup.name);
    const written = workspace.records.createRecord("恢复后继续新建");
    expect(written.record.id).toMatch(/^rec_/);
    const second = workspace.backups.createBackup();
    expect(second.verification?.status).toMatch(/^ok/);

    const index = JSON.parse(
      (workspace.db
        .prepare("select value from app_meta where key = 'backup_index'")
        .get() as { value: string } | undefined)?.value ?? "{}",
    ) as Record<string, unknown>;
    expect(Object.keys(index)).toContain(backup.name);
    expect(Object.keys(index)).toContain(resultSafety(second.name));
  });
});

/** 上例辅助：prerestore 快照在换血后由恢复流程补登记，这里只断言其存在性。 */
function resultSafety(snapshotName: string): string {
  // 名称形如 prerestore-...；不精确匹配具体文件，验证缓存里存在任一 prerestore 登记即可
  const index = JSON.parse(
    (workspace.db
      .prepare("select value from app_meta where key = 'backup_index'")
      .get() as { value: string } | undefined)?.value ?? "{}",
  ) as Record<string, unknown>;
  const prerestore = Object.keys(index).find((key) => key.startsWith("prerestore-"));
  expect(prerestore, `期望缓存含 prerestore 登记（本次快照 ${snapshotName}）`).toBeDefined();
  return prerestore!;
}
