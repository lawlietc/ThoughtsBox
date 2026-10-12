import { resolve } from "node:path";

import { ConfigError } from "./config/errors.ts";
import { MigrationError } from "./db/migrator.ts";
import { SelfCheckFailure } from "./runtime/selfCheck.ts";
import { InstanceConflictError } from "./runtime/lockTypes.ts";
import { PortConflictError } from "./api/httpServer.ts";
import { boot, shutdown, type BootResult } from "./runtime/bootstrap.ts";

export const EXIT_OK = 0;
export const EXIT_CONFIG_OR_CAPABILITY = 11;
export const EXIT_INSTANCE_CONFLICT = 12;

export function describeFailure(cause: unknown): { message: string; exitCode: number } {
  if (cause instanceof InstanceConflictError || cause instanceof PortConflictError) {
    return { message: cause.message, exitCode: EXIT_INSTANCE_CONFLICT };
  }
  if (cause instanceof SelfCheckFailure || cause instanceof ConfigError || cause instanceof MigrationError) {
    return { message: cause.message, exitCode: EXIT_CONFIG_OR_CAPABILITY };
  }
  if (cause instanceof Error) {
    return { message: `启动失败：${cause.message}`, exitCode: EXIT_CONFIG_OR_CAPABILITY };
  }
  return { message: `启动失败：${String(cause)}`, exitCode: EXIT_CONFIG_OR_CAPABILITY };
}

let running: BootResult | undefined;

async function stop(signal: string): Promise<void> {
  const target = running;
  running = undefined;
  if (target !== undefined) {
    console.log(`收到 ${signal}，正在关闭…`);
    await shutdown(target);
  }
  process.exit(EXIT_OK);
}

export async function main(): Promise<void> {
  process.on("SIGINT", () => void stop("SIGINT"));
  process.on("SIGTERM", () => void stop("SIGTERM"));
  try {
    running = await boot();
  } catch (cause) {
    const { message, exitCode } = describeFailure(cause);
    console.error(message);
    process.exitCode = exitCode;
    running = undefined;
  }
}

// 只有作为入口直接运行时才启动，便于测试导入 describeFailure 等纯函数。
if (process.argv[1] !== undefined && import.meta.filename === resolve(process.argv[1])) {
  void main();
}
