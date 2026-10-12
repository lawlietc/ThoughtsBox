import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { ConfigError } from "./errors.ts";

const APP_DIR_NAME = "ThoughtsBox";

/**
 * 数据目录（ADR-015）：运行时数据一律在系统数据目录，仓库只放模板与代码。
 * `TB_DATA_DIR` 覆盖它——测试与多实例开发必须走这条路径，禁止碰用户真实目录。
 */
export function defaultDataDir(env: NodeJS.ProcessEnv = process.env): string {
  if (process.platform === "win32") {
    const local = env.LOCALAPPDATA;
    if (local && local.trim() !== "") return join(local, APP_DIR_NAME);
    return join(homedir(), "AppData", "Local", APP_DIR_NAME);
  }
  const xdg = env.XDG_DATA_HOME;
  if (xdg && xdg.trim() !== "") return join(xdg, APP_DIR_NAME);
  return join(homedir(), ".local", "share", APP_DIR_NAME);
}

export interface DataLayout {
  readonly envOverride: boolean;
  readonly dataDir: string;
  readonly dbFile: string;
  readonly backupsDir: string;
  readonly logsDir: string;
  readonly debugDir: string;
  readonly configFile: string;
  readonly lockFile: string;
}

export function resolveDataLayout(env: NodeJS.ProcessEnv = process.env): DataLayout {
  const override = env.TB_DATA_DIR;
  const explicit = override !== undefined && override.trim() !== "";
  const dataDir = resolve(explicit ? override! : defaultDataDir(env));
  if (dataDir === "" || dataDir === resolve(process.cwd())) {
    // 把整个仓库当数据目录会让私人记录与代码同生死，拒绝这种配置。
    throw new ConfigError(`TB_DATA_DIR 解析结果为空或等于仓库根：${dataDir}`, { fields: ["TB_DATA_DIR"] });
  }
  return {
    envOverride: explicit,
    dataDir,
    dbFile: join(dataDir, "thoughts-box.sqlite"),
    backupsDir: join(dataDir, "backups"),
    logsDir: join(dataDir, "logs"),
    debugDir: join(dataDir, "debug-export"),
    configFile: join(dataDir, "config.local.json"),
    lockFile: join(dataDir, "runtime.lock"),
  };
}

export function ensureDataDirs(layout: DataLayout): void {
  for (const dir of [layout.dataDir, layout.backupsDir, layout.logsDir]) {
    mkdirSync(dir, { recursive: true });
  }
}
