#!/usr/bin/env node
/**
 * 生产起服入口 + 密钥注入器（M4-TR-1 任务 5；任务书 §六-1 的落地件）。
 *
 * 存在的意义：给「真实调用模型」和 LIVE 验证一条**执行者全程见不到 key 值**的正规起服路径。
 * 它把密钥从「仓库外的密钥文件」读进**子进程的 env**，然后 spawn 后端。
 *
 * 红线（§六）：
 *  - key 的值**不打印、不进 argv、不进任何日志**（argv 在进程列表可见，同样算泄露面）；
 *  - 密钥文件缺省在 `~/.thoughtsbox/provider.key`（仓库外，git 物理够不着）；
 *  - 文件不存在或空 ⇒ 视为「未配置」，**照常起服务**（不注入该 env，装配走 null 或本地路径）；
 *  - 后端的 stdout/stderr 原样 inherit 到本进程——本脚本自身对 key 值零接触、零 echo。
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const serverEntry = join(projectRoot, "src", "server", "index.ts");
const KEY_ENV = "TB_MODEL_API_KEY";
const DEFAULT_KEY_FILE = join(homedir(), ".thoughtsbox", "provider.key");

/** 只解析 --key-file，绝不把它的值之外 anything 打出来；未知参数忽略。 */
function resolveKeyFile(argv) {
  const idx = argv.indexOf("--key-file");
  if (idx !== -1 && typeof argv[idx + 1] === "string") return resolve(argv[idx + 1]);
  return DEFAULT_KEY_FILE;
}

function readKeyValue(keyFile) {
  if (!existsSync(keyFile)) return undefined;
  let raw;
  try {
    raw = readFileSync(keyFile, "utf8");
  } catch {
    // 读不到（权限/损坏）等同未配置：不崩、不打印原因里可能含路径之外的内容。
    return undefined;
  }
  const value = raw.trim();
  return value === "" ? undefined : value;
}

const keyFile = resolveKeyFile(process.argv.slice(2));
const value = readKeyValue(keyFile);
const signalNumbers = { SIGINT: 2, SIGTERM: 15, SIGHUP: 1 };

const env = { ...process.env };
if (value !== undefined) {
  env[KEY_ENV] = value;
  // 只报「已注入」这一布尔事实，永不 echo 值、不报文件内容。
  process.stdout.write("已从密钥文件注入 " + KEY_ENV + "（值不显示）。\n");
} else {
  process.stdout.write("未提供密钥（密钥文件缺失或为空）：" + KEY_ENV + " 不注入，按未配置启动。\n");
}

const child = spawn(process.execPath, [serverEntry], {
  cwd: projectRoot,
  stdio: ["inherit", "inherit", "inherit"],
  env,
});

let shuttingDown = false;
function forward(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  child.kill(signal);
}
process.on("SIGINT", () => forward("SIGINT"));
process.on("SIGTERM", () => forward("SIGTERM"));

child.on("exit", (code, signal) => {
  if (signal !== null) process.exit(128 + (signalNumbers[signal] ?? 0));
  process.exit(code ?? 0);
});
child.on("error", () => {
  process.stderr.write("无法启动后端进程。\n");
  process.exit(1);
});
