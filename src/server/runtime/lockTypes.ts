export interface LockRecord {
  readonly pid: number;
  readonly host: string;
  readonly port: number;
  readonly nonce: string;
  readonly startedAt: string;
  readonly nodeVersion: string;
  readonly dataDir: string;
}

export type LockState =
  | { readonly state: "free" }
  | { readonly state: "held"; readonly by: LockRecord }
  | { readonly state: "stale"; readonly by: LockRecord; readonly reason: string }
  | { readonly state: "corrupt"; readonly raw: string; readonly reason: string };

export class InstanceConflictError extends Error {
  readonly holder: LockRecord | null;
  readonly reason: string;
  constructor(reason: string, holder: LockRecord | null = null) {
    const who =
      holder === null
        ? "本端口已被其他程序占用（它不是思绪盒子实例）"
        : `已有一个思绪盒子实例在运行：PID ${holder.pid}，监听 ${holder.host}:${holder.port}，数据目录 ${holder.dataDir}`;
    super(
      `${who}。\n` +
        `本进程不写入数据库、不执行迁移，直接退出。V0 只支持单实例，端口不自动切换（规格 §6.4、ADR-015）。`,
    );
    this.name = "InstanceConflictError";
    this.holder = holder;
    this.reason = reason;
  }
}
