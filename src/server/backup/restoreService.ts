import { randomUUIDv7 } from "node:crypto";
import { copyFileSync, existsSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";

import { applyPragmas, checkpointAndTruncate, openDatabase, type Database } from "../db/adapter.ts";
import { currentSchemaVersion, listMigrationFiles, migrate } from "../db/migrator.ts";
import { seedVocabulary } from "../db/seed.ts";
import { RecordService } from "../records/service.ts";
import type { Workspace } from "../runtime/workspace.ts";

/**
 * 快照恢复（M1b §六，R-5 裁决：整库原位替换，不做行级合并）。
 *
 * 顺序即安全边界：
 * ① 新鲜校验（缓存不算）——failed 直接拒绝；
 * ② 恢复前安全快照——失败即中止，此时还没碰过数据库；
 * ③ checkpoint(TRUNCATE) + 关句柄 + 现库改名让位 + 备份复制入位；
 * ④ 重开 → PRAGMA → 迁移复检（备份 schema 更旧时按序重放）→ 播种幂等
 *    → 外键/索引一致复检（脱锚先重建再检，仍不过就失败）；
 * ⑤ 全部通过才原子换血（Workspace.swap）。
 * ③④ 任何一步失败：删掉半成品、把让位的现库改回原名、重开旧句柄——
 * 回滚也失败时，让位文件与②的安全快照都保留，把可追查的物理证据留给用户。
 *
 * 如实的边界：整个过程同步完成、持有运行锁、单线程事件循环内不会与其他请求交错；
 * 已经在途、await 挂起中的请求若持旧服务引用，恢复后会收到显式失败而不是脏读。
 * 备份内容可能包含用户已删除的记录（K-20）：拒绝承诺「删除会消失到未来」，
 * 恢复前必须由 UI 明示这一点。备份不加密（V0），文件即库、敏感度相同。
 */

export class RestoreError extends Error {
  readonly safetyBackupName: string | null;
  /** rejected：拒绝发生在动库之前（备份目录也不该有新增）；failed：安全快照之后失败，走过回滚。 */
  readonly kind: "rejected" | "failed";

  constructor(
    message: string,
    safetyBackupName: string | null = null,
    kind: "rejected" | "failed" = "failed",
  ) {
    super(message);
    this.name = "RestoreError";
    this.safetyBackupName = safetyBackupName;
    this.kind = kind;
  }
}

// M1b：结果类型上收为前后端共用契约（src/shared/dto.ts）；re-export 保持既有导入路径可用。
import type { RestoreResult } from "../../shared/dto.ts";
export type { RestoreResult } from "../../shared/dto.ts";

export interface RestoreOptions {
  /** 迁移目录注入点：与 listMigrationFiles/migrate 同款可测性缝，测试用它构造「应用比备份新」而不碰真实仓库目录。 */
  readonly migrationsDir?: string;
}

export function restoreFromBackup(
  workspace: Workspace,
  fileName: string,
  options: RestoreOptions = {},
): RestoreResult {
  const layout = workspace.layout;

  // ① 新鲜校验：备份服务自带路径守卫，非法名在这里就被拒
  let verification;
  try {
    verification = workspace.backups.verifyBackup(fileName);
  } catch (cause) {
    throw new RestoreError(`恢复被拒绝：${(cause as Error).message}`, null, "rejected");
  }
  if (verification.schemaVersion !== null) {
    const supported = listMigrationFiles(options.migrationsDir).map((file) => file.version);
    const maxSupported = supported[supported.length - 1]!;
    if (verification.schemaVersion > maxSupported) {
      // R-5 裁决的明文分支：高版本备份拒绝恢复并提示升级，而不是悄悄丢表或强行降级。
      throw new RestoreError(
        `恢复被拒绝：备份 schema 版本 ${verification.schemaVersion} 高于当前应用支持的最高版本 ${maxSupported}，请升级应用后再恢复`,
        null,
        "rejected",
      );
    }
  }
  if (verification.status === "failed") {
    throw new RestoreError(`恢复被拒绝：备份校验失败——${verification.detail}`, null, "rejected");
  }

  // ② 恢复前安全快照：失败即中止，一步都不许往下走
  let safety;
  try {
    safety = workspace.backups.createPreRestoreSafetySnapshot();
  } catch (cause) {
    throw new RestoreError(
      `恢复中止：连恢复前安全快照都无法创建——${(cause as Error).message}`,
      null,
      "rejected",
    );
  }

  const previous = { db: workspace.db, schemaVersion: workspace.schemaVersion };
  const fromSchemaVersion = verification.schemaVersion ?? previous.schemaVersion;
  let candidate: Database | null = null;
  const aside = `${layout.dbFile}.replaced-${randomUUIDv7()}`;
  let movedAside = false;

  try {
    // ③ 让位与入位
    checkpointAndTruncate(previous.db);
    previous.db.close();
    renameSync(layout.dbFile, aside);
    movedAside = true;
    // 干净关闭后不应再有 -wal/-shm；若残留，它们属于已让位的库，随让位文件一起移开
    for (const suffix of ["-wal", "-shm"] as const) {
      const side = `${layout.dbFile}${suffix}`;
      if (existsSync(side)) renameSync(side, `${aside}${suffix}`);
    }
    copyFileSync(join(layout.backupsDir, fileName), layout.dbFile);

    // ④ 重开与复检
    const nextDb = openDatabase(layout.dbFile);
    candidate = nextDb;
    applyPragmas(nextDb);
    migrate(nextDb, options.migrationsDir);
    seedVocabulary(nextDb);

    const fkViolations = nextDb.prepare("PRAGMA foreign_key_check").all() as unknown[];
    if (fkViolations.length > 0) {
      throw new Error(`恢复后 foreign_key_check 仍有 ${fkViolations.length} 行违规`);
    }
    const probe = new RecordService(nextDb);
    let desync = probe.detectIndexDesync();
    let searchIndexRebuilt = false;
    if (desync.phantom > 0 || desync.missing > 0) {
      probe.rebuildSearchIndex();
      desync = probe.detectIndexDesync();
      if (desync.phantom > 0 || desync.missing > 0) {
        throw new Error(
          `恢复后搜索索引重建仍不一致（幽灵 ${desync.phantom} / 缺失 ${desync.missing}）`,
        );
      }
      searchIndexRebuilt = true;
    }

    // 备份里的存储维护任务属于「录下它的那个库文件」：整库替换后随库复活，
    // 恢复流程用同一条幂等重试路径处理，不另起第二套队列。
    const tasks = probe.getMaintenanceTasks();
    let maintenanceResolved = 0;
    let maintenanceOk = true;
    let maintenanceDetail: string | null = null;
    if (tasks.length > 0) {
      const retry = probe.retryStorageMaintenance();
      maintenanceResolved = retry.resolvedTasks;
      maintenanceOk = retry.ok;
      maintenanceDetail = retry.ok ? null : (retry.detail ?? "未知原因");
    }

    const schemaVersion = currentSchemaVersion(nextDb);
    // ⑤ 换血：从这一刻起对外就是新库
    workspace.swap({ db: nextDb, schemaVersion });
    candidate = null;

    // 成功后清理让位文件：恢复语义就是「现库被备份内容取代」，
    // 额外保留被取代的旧库等于在安全快照之外多留一份含已删数据的副本。
    rmSync(aside, { force: true });
    for (const suffix of ["-wal", "-shm"] as const) {
      rmSync(`${aside}${suffix}`, { force: true });
    }
    // 安全快照与来源备份都要在换血后的库里留有校验记录：
    // 快照的校验发生在旧库（记录随旧库一起被取代），来源备份的快照内容早于它自身的登记。
    workspace.backups.noteVerification(fileName, verification);
    workspace.backups.verifyBackup(safety.name);

    const counts = {
      records: (nextDb.prepare("select count(*) as n from capture_record").get() as { n: number }).n,
      revisions: (nextDb.prepare("select count(*) as n from record_revision").get() as { n: number }).n,
    };
    return {
      restoredFrom: fileName,
      safetyBackupName: safety.name,
      fromSchemaVersion,
      schemaVersion,
      records: counts.records,
      revisions: counts.revisions,
      searchIndexRebuilt,
      maintenanceTasksFound: tasks.length,
      maintenanceResolved,
      maintenanceOk,
      maintenanceDetail,
    };
  } catch (cause) {
    const reason = (cause as Error).message;
    // 回滚：清掉半成品，把让位的现库改回原名并重开
    try {
      candidate?.close();
    } catch {
      /* 半成品句柄关闭失败不掩盖原始原因 */
    }
    for (const suffix of ["-wal", "-shm"] as const) {
      rmSync(`${layout.dbFile}${suffix}`, { force: true });
      if (movedAside) rmSync(`${aside}${suffix}`, { force: true });
    }
    rmSync(layout.dbFile, { force: true });
    if (movedAside) renameSync(aside, layout.dbFile);

    try {
      const revived = openDatabase(layout.dbFile);
      applyPragmas(revived);
      workspace.swap({ db: revived, schemaVersion: previous.schemaVersion });
    } catch (rollbackCause) {
      throw new RestoreError(
        `恢复失败且自动回滚未能重开原库：${reason}；回滚原因：${(rollbackCause as Error).message}。` +
          `原数据库文件在 ${movedAside ? aside : layout.dbFile}，恢复前安全快照为 ${safety.name}，请手工处置后再启动。`,
        safety.name,
      );
    }
    throw new RestoreError(`恢复失败，已回滚到恢复前状态：${reason}`, safety.name);
  }
}
