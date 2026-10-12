import { randomUUIDv7 } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { dirname, join } from "node:path";

import type { DataLayout } from "../config/paths.ts";
import { InstanceConflictError, type LockRecord, type LockState } from "./lockTypes.ts";

/**
 * 单实例保护（ADR-015、M0 交付物 6）。
 *
 * 两种候选都实测过（tests/m0-single-instance-strategies.test.ts），结论：
 * - 只靠端口占用不够：端口既可能被无关程序占据，也可能在崩溃后立刻释放，分不清"别人在跑"和"我上次崩了"。
 * - 只靠 SQLite 文件锁不够：跨进程的 SQLITE_BUSY 不区分"另一个思绪盒子"与"一个备份/只读工具"，
 *   而且它在迁移开始之前就给不出可读的冲突原因，违反"先判定实例、再碰数据库"的顺序约束。
 * 固化方案：锁文件 + 双判据（PID 存活 **且** 端口有人应答）才算他人在运行；
 * 只有 PID 存活而端口无应答（挂死、或 PID 被复用）判为残留并接管。
 *
 * 这里不使用 `flock`：Node 没有可移植的咨询锁 API，Windows 上语义与 POSIX 不同。
 */

const REQUIRED_FIELDS = ["pid", "host", "port", "nonce"] as const;

export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    // EPERM：进程存在但不归当前用户管，仍算存活；ESRCH：不存在。
    return (cause as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function parseLockRecord(raw: string): LockRecord | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (REQUIRED_FIELDS.some((field) => record[field] === undefined || record[field] === "")) {
    return undefined;
  }
  const port = Number(record.port);
  if (!Number.isInteger(port)) return undefined;
  return {
    pid: Number(record.pid),
    host: String(record.host),
    port,
    nonce: String(record.nonce),
    startedAt: String(record.startedAt ?? ""),
    nodeVersion: String(record.nodeVersion ?? ""),
    dataDir: String(record.dataDir ?? ""),
  };
}

/** 端口探针：能建立 TCP 连接即认为有人在监听。 */
export function probePort(host: string, port: number, timeoutMs = 600): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    let settled = false;
    const finish = (answer: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(answer);
    };
    socket.setTimeout(timeoutMs);
    socket.on("connect", () => finish(true));
    socket.on("timeout", () => finish(false));
    socket.on("error", () => finish(false));
  });
}

export type PortProbe = (host: string, port: number) => Promise<boolean>;

export async function inspectLock(layout: DataLayout, probe: PortProbe = probePort): Promise<LockState> {
  let raw: string;
  try {
    raw = readFileSync(layout.lockFile, "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return { state: "free" };
    throw cause;
  }
  if (raw.trim() === "") return { state: "corrupt", raw, reason: "锁文件为空" };
  const record = parseLockRecord(raw);
  if (record === undefined) return { state: "corrupt", raw, reason: "锁文件内容无法解析" };
  if (!isPidAlive(record.pid)) {
    return { state: "stale", by: record, reason: `PID ${record.pid} 已不存在` };
  }
  if (!(await probe(record.host, record.port))) {
    return {
      state: "stale",
      by: record,
      reason: `PID ${record.pid} 存活，但 ${record.host}:${record.port} 无人应答（挂死或 PID 复用）`,
    };
  }
  return { state: "held", by: record };
}

function stagingPath(layout: DataLayout): string {
  return `${layout.lockFile}.${process.pid}.${randomUUIDv7()}.staging`;
}

/** 先写临时文件再 rename：读取方永远看不到半个 JSON。 */
function writeLockAtomically(layout: DataLayout, record: LockRecord): void {
  // 首次启动时数据目录还不存在；建目录不是数据库写入，不违反"先锁后库"的顺序约束。
  mkdirSync(layout.dataDir, { recursive: true });
  const staging = stagingPath(layout);
  const fd = openSync(staging, "w");
  try {
    writeFileSync(fd, `${JSON.stringify(record, null, 2)}\n`);
  } finally {
    closeSync(fd);
  }
  renameSync(staging, layout.lockFile);
}

export interface AcquireOptions {
  readonly host: string;
  readonly port: number;
  readonly probe?: PortProbe;
}

export interface HeldLock {
  readonly record: LockRecord;
  readonly tookOver: LockRecord | null;
  release(): void;
}

/**
 * 获取运行锁。**必须在任何数据库写入与迁移之前调用**（M0 高风险不变量 1：顺序错误即缺陷）。
 * 他人持有或端口被占 → InstanceConflictError；残留 / 损坏 → 接管，并把旧锁改名保留以便追查。
 */
export async function acquireInstanceLock(
  layout: DataLayout,
  options: AcquireOptions,
): Promise<HeldLock> {
  const probe = options.probe ?? probePort;
  const state = await inspectLock(layout, probe);
  if (state.state === "held") {
    throw new InstanceConflictError(`PID ${state.by.pid} 仍在持有运行锁`, state.by);
  }

  // 此刻本进程还没 bind，端口有人应答就一定不是自己：无关程序占了固定端口。
  // 必须在改写锁文件之前拒绝，否则会把别人的服务伪装成我们的实例。
  if (await probe(options.host, options.port)) {
    throw new InstanceConflictError(
      `${options.host}:${options.port} 已被其他程序占用，端口不自动切换`,
      null,
    );
  }

  let tookOver: LockRecord | null = null;
  if (state.state === "stale" || state.state === "corrupt") {
    tookOver = state.state === "stale" ? state.by : null;
    if (existsSync(layout.lockFile)) {
      renameSync(layout.lockFile, `${layout.lockFile}.stale-${randomUUIDv7()}`);
    }
  }

  const record: LockRecord = {
    pid: process.pid,
    host: options.host,
    port: options.port,
    nonce: randomUUIDv7(),
    startedAt: new Date().toISOString(),
    nodeVersion: process.version,
    dataDir: layout.dataDir,
  };
  writeLockAtomically(layout, record);

  // 竞争窗口：两个进程同时接管残留锁时后写者会覆盖，用 nonce 回读确认所有权。
  const readback = parseLockRecord(readFileSync(layout.lockFile, "utf8"));
  if (readback === undefined || readback.nonce !== record.nonce) {
    rmSync(layout.lockFile, { force: true });
    throw new InstanceConflictError("接管竞争失败：锁文件已被其他进程改写", readback ?? null);
  }

  return { record, tookOver, release: () => releaseLock(layout, record) };
}

export function releaseLock(layout: DataLayout, record: LockRecord): void {
  let raw: string;
  try {
    raw = readFileSync(layout.lockFile, "utf8");
  } catch {
    return;
  }
  const parsed = parseLockRecord(raw);
  // 只删自己持有的锁：接管场景下锁可能已被别的进程改写。
  if (parsed !== undefined && parsed.nonce === record.nonce) {
    rmSync(layout.lockFile, { force: true });
  }
}

export function quarantineFiles(layout: DataLayout): string[] {
  // 被接管的残留锁改名保留，不直接丢弃：崩溃现场的可追溯性比目录整洁重要。
  const dir = dirname(layout.lockFile);
  const prefix = `${layout.lockFile}.stale-`;
  try {
    return readdirSync(dir).map((name) => join(dir, String(name))).filter((path) => path.startsWith(prefix));
  } catch {
    return [];
  }
}

export function lockAgeMs(layout: DataLayout, now = Date.now()): number | undefined {
  try {
    return now - statSync(layout.lockFile).mtimeMs;
  } catch {
    return undefined;
  }
}
