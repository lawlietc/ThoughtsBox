import { randomUUIDv7 } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

import { statfsSync } from "node:fs";

import { openDatabase, type Database } from "../db/adapter.ts";
import { currentSchemaVersion, getMeta, listMigrationFiles, setMeta } from "../db/migrator.ts";
import { missingDataPlaneObjects } from "../runtime/dataCheck.ts";
import { ensureDataDirs, type DataLayout } from "../config/paths.ts";
import { RecordService } from "../records/service.ts";

/**
 * SQLite 快照备份（M1b §五）。产品规格 §8.1：备份 = VACUUM INTO 的一致性快照，
 * 不是对运行中 .db 的字节复制——WAL 模式下裸复制得到的是「主文件 + 未合并日志」的拼接，
 * 缺页或半提交都可能在恢复时才暴露。
 *
 * 边界（如实声明）：备份文件本身不加密（V0 裁决），内容与主库同敏感度；
 * 备份是时间点快照，已删除内容可能仍活在旧备份里（K-20），由恢复与导出的文案承担告知义务。
 */

export class BackupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackupError";
  }
}

/**
 * 文件名由系统安全生成：snapshot-/prerestore- + UTC 时间头 + UUIDv7。
 * 用户输入永不进入路径——列表、校验、删除都只认这个严格模式，其余文件一律视为无关文件。
 */
const SNAPSHOT_NAME = /^snapshot-\d{8}T\d{6}Z-[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.sqlite$/;
const PRERESTORE_NAME = /^prerestore-\d{8}T\d{6}Z-[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.sqlite$/;
export const BACKUP_FILE_PATTERN = /^(snapshot|prerestore)-\d{8}T\d{6}Z-[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.sqlite$/;

export function isBackupFileName(name: string): boolean {
  return BACKUP_FILE_PATTERN.test(name);
}

/** app_meta 中的校验结果缓存：备份目录可能很大，列表不逐份重新打开校验。 */
export const BACKUP_INDEX_KEY = "backup_index";

// M1b：备份契约类型上收为前后端共用（src/shared/dto.ts）；re-export 保持既有导入路径可用。
import type { BackupEntry, BackupVerification, DiskCapacity, VerifyStatus } from "../../shared/dto.ts";
export type { BackupEntry, BackupVerification, DiskCapacity, VerifyStatus } from "../../shared/dto.ts";

interface CacheShape {
  [name: string]: BackupVerification;
}

function utcHeader(date: Date): string {
  return `${date.toISOString().slice(0, 19).replace(/[-:]/g, "")}Z`;
}

function parseHeaderUtc(name: string): string {
  const raw = /^(?:snapshot|prerestore)-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/.exec(name)!;
  return `${raw[1]}-${raw[2]}-${raw[3]}T${raw[4]}:${raw[5]}:${raw[6]}Z`;
}

function sqlQuote(path: string): string {
  return `'${path.replaceAll("'", "''")}'`;
}

// 健康判据单一来源：必需对象清单与缺失面由数据面自检模块统一定义（§8.1 复用要求）。
function missingObjects(db: Database): string[] {
  return missingDataPlaneObjects(db);
}

export interface VerifyFileOptions {
  readonly supportedSchemaVersions: readonly number[];
}

/**
 * 校验一个备份文件。核心约束：**不得写入原始备份文件**——
 * 打开 SQLite 就可能生成 -wal/-shm 旁文件，因此校验一律在临时目录的副本上进行。
 *
 * 完整性判据（M1b §5.2）：可打开、integrity_check 通过、foreign_key_check 无违规行、
 * schema 版本受支持、M1a 关键对象齐全、FTS 索引一致。
 * 最后一项 **不采用** FTS5 integrity-check：M1a 实测其对幽灵行与内容篡改两种脱锚都不敏感，
 * 这里使用 docsize 影子表比对（detectIndexDesync）。
 */
export function verifyBackupFile(
  filePath: string,
  options: VerifyFileOptions,
  now: () => Date = () => new Date(),
): BackupVerification {
  const checkedAtUtc = now().toISOString();
  const tmp = mkdtempSync(join(tmpdir(), "tb-verify-"));
  const copyPath = join(tmp, "candidate.sqlite");
  let db: Database | undefined;
  try {
    copyFileSync(filePath, copyPath);
    db = openDatabase(copyPath);
    db.exec("PRAGMA foreign_keys = ON");

    const integrity = db.prepare("PRAGMA integrity_check").all() as unknown as {
      integrity_check: string;
    }[];
    if (integrity.length !== 1 || integrity[0]!.integrity_check !== "ok") {
      return {
        status: "failed",
        checkedAtUtc,
        schemaVersion: null,
        detail: `integrity_check 未通过：${integrity.map((r) => r.integrity_check).join("；")}`,
      };
    }

    const fkViolations = db.prepare("PRAGMA foreign_key_check").all() as unknown[];
    if (fkViolations.length > 0) {
      return {
        status: "failed",
        checkedAtUtc,
        schemaVersion: null,
        detail: `foreign_key_check 存在 ${fkViolations.length} 行违规`,
      };
    }

    const schemaVersion = currentSchemaVersion(db);
    if (!options.supportedSchemaVersions.includes(schemaVersion)) {
      return {
        status: "failed",
        checkedAtUtc,
        schemaVersion,
        detail: `备份 schema 版本 ${schemaVersion} 超出当前应用支持范围（${options.supportedSchemaVersions.join(", ")}）`,
      };
    }

    const missing = missingObjects(db);
    if (missing.length > 0) {
      return {
        status: "failed",
        checkedAtUtc,
        schemaVersion,
        detail: `缺少关键对象：${missing.join("、")}`,
      };
    }

    const desync = new RecordService(db).detectIndexDesync();
    if (desync.phantom > 0 || desync.missing > 0) {
      return {
        status: "ok_with_warning",
        checkedAtUtc,
        schemaVersion,
        detail: `FTS 索引与主表不一致（幽灵 ${desync.phantom} / 缺失 ${desync.missing}），恢复后可重建`,
        desync,
      };
    }

    return {
      status: "ok",
      checkedAtUtc,
      schemaVersion,
      detail: "校验通过",
    };
  } catch (cause) {
    return {
      status: "failed",
      checkedAtUtc,
      schemaVersion: null,
      detail: `备份无法打开或校验异常：${(cause as Error).message}`,
    };
  } finally {
    db?.close();
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* 临时目录清理失败不影响校验结论 */
    }
  }
}

export class BackupService {
  private readonly db: Database;
  private readonly layout: DataLayout;
  private readonly now: () => Date;
  private readonly supportedVersions: number[];

  constructor(db: Database, layout: DataLayout, options: { now?: () => Date } = {}) {
    this.db = db;
    this.layout = layout;
    this.now = options.now ?? (() => new Date());
    this.supportedVersions = listMigrationFiles()
      .map((file) => file.version)
      .sort((a, b) => a - b);
  }

  private readCache(): CacheShape {
    const raw = getMeta(this.db, BACKUP_INDEX_KEY);
    if (raw === undefined) return {};
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (typeof parsed === "object" && parsed !== null) return parsed as CacheShape;
    } catch {
      /* 缓存损坏视同无缓存，下次校验会重写 */
    }
    return {};
  }

  private writeCache(cache: CacheShape): void {
    setMeta(this.db, BACKUP_INDEX_KEY, JSON.stringify(cache));
  }

  private updateCache(name: string, verification: BackupVerification): void {
    const cache = this.readCache();
    cache[name] = verification;
    this.writeCache(cache);
  }

  /**
   * 创建快照：VACUUM INTO 写入唯一命名的 .inprogress 暂存 → 隔离校验 → 校验结果写缓存 → 最后改名。
   * 改名放最后一步：此前任何失败都只回滚暂存，主库要么完全没被写过缓存、要么已含该备份的记录，
   * 不存在「文件在、记录丢」的中间态。未验证成功的文件绝不进入备份列表（§5.2）。
   */
  createBackup(kind: "snapshot" | "prerestore" = "snapshot"): BackupEntry {
    mkdirSync(this.layout.backupsDir, { recursive: true });
    const name = `${kind}-${utcHeader(this.now())}-${randomUUIDv7()}.sqlite`;
    const staging = join(this.layout.backupsDir, `${name}.inprogress`);
    try {
      this.db.exec(`VACUUM INTO ${sqlQuote(staging)}`);
    } catch (cause) {
      rmSync(staging, { force: true });
      throw new BackupError(
        `VACUUM INTO 快照失败（当前数据库未被改动）：${(cause as Error).message}`,
      );
    }

    try {
      const verification = verifyBackupFile(staging, { supportedSchemaVersions: this.supportedVersions }, this.now);
      if (verification.status === "failed") {
        throw new BackupError(`快照未通过完整性校验，已丢弃：${verification.detail}`);
      }
      this.updateCache(name, verification);
      renameSync(staging, join(this.layout.backupsDir, name));
    } catch (cause) {
      rmSync(staging, { force: true });
      if (cause instanceof BackupError) throw cause;
      throw new BackupError(
        `快照登记失败，暂存已清理（当前数据库内容未被此流程改动）：${(cause as Error).message}`,
      );
    }
    return this.entryFor(name);
  }

  private entryFor(name: string): BackupEntry {
    const path = this.safePath(name);
    const stat = statSync(path);
    return {
      name,
      kind: name.startsWith("prerestore-") ? "prerestore" : "snapshot",
      sizeBytes: stat.size,
      createdAtUtc: parseHeaderUtc(name),
      modifiedAtUtc: stat.mtime.toISOString(),
      verification: this.readCache()[name] ?? null,
    };
  }

  /** 名字必须命中系统生成模式且解析后仍在备份目录内：拒绝路径穿越与无关文件。 */
  private safePath(name: string): string {
    if (!isBackupFileName(name)) {
      throw new BackupError(`非法备份文件名：${name}（只接受系统生成的快照文件名）`);
    }
    const dir = resolve(this.layout.backupsDir);
    const path = resolve(dir, name);
    if (!path.startsWith(dir + sep)) {
      throw new BackupError(`备份文件路径越界：${name}`);
    }
    return path;
  }

  verifyBackup(name: string): BackupVerification {
    const verification = verifyBackupFile(
      this.safePath(name),
      { supportedSchemaVersions: this.supportedVersions },
      this.now,
    );
    this.updateCache(name, verification);
    return verification;
  }

  /** 外部已新鲜校验过的结果补登记（恢复流程用：校验发生在换血前，记录要落到换血后的库）。 */
  noteVerification(name: string, verification: BackupVerification): void {
    this.safePath(name);
    this.updateCache(name, verification);
  }

  /** 列表 = 目录严格模式扫描 + 缓存拼接；不对每个文件重新打开（成本高），新鲜度由 verify 显式提供。 */
  listBackups(): {
    backups: BackupEntry[];
    totalBytes: number;
    lastBackupUtc: string | null;
    lastSuccessUtc: string | null;
  } {
    ensureDataDirs(this.layout);
    let names: string[];
    try {
      names = readdirSync(this.layout.backupsDir).filter((file) => isBackupFileName(file));
    } catch {
      names = [];
    }
    const backups = names
      .map((name) => this.entryFor(name))
      .sort((a, b) => (a.createdAtUtc < b.createdAtUtc ? 1 : -1));
    const totalBytes = backups.reduce((sum, entry) => sum + entry.sizeBytes, 0);
    const lastBackupUtc = backups.length > 0 ? backups[0]!.createdAtUtc : null;
    const successes = backups
      .filter((entry) => entry.verification?.status === "ok" || entry.verification?.status === "ok_with_warning")
      .map((entry) => entry.verification!.checkedAtUtc)
      .sort();
    return {
      backups,
      totalBytes,
      lastBackupUtc,
      lastSuccessUtc: successes.length > 0 ? successes[successes.length - 1]! : null,
    };
  }

  /** V0 无自动清理（§8.2 裁决）：删除只由用户显式触发，且只认严格模式文件名。 */
  deleteBackup(name: string): void {
    const path = this.safePath(name);
    try {
      statSync(path);
    } catch {
      throw new BackupError(`备份文件不存在：${name}`);
    }
    rmSync(path, { force: true });
    const cache = this.readCache();
    delete cache[name];
    this.writeCache(cache);
  }

  /**
   * 磁盘余量：statfs 在本平台可用时报告实际值；不可用时如实返回能力受限，
   * 不猜测、不把「读不到」显示成「空间充足」。
   */
  diskCapacity(): DiskCapacity {
    try {
      const stats = statfsSync(this.layout.dataDir);
      return {
        available: true,
        totalBytes: Number(stats.blocks) * Number(stats.bsize),
        freeBytes: Number(stats.bavail) * Number(stats.bsize),
      };
    } catch (cause) {
      return {
        available: false,
        reason: `当前平台无法读取磁盘容量：${(cause as Error).message}`,
      };
    }
  }

  /** 恢复前安全快照：失败必须中止恢复（§六原子性前提），不允许「无安全网恢复」。 */
  createPreRestoreSafetySnapshot(): BackupEntry {
    return this.createBackup("prerestore");
  }
}
