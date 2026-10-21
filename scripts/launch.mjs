#!/usr/bin/env node
/**
 * 一键启动：本地后端（8737）+ Web UI（5173）。
 *
 * 与 `scripts/dev.mjs` 的唯一区别：后端走 `run-server.mjs` 而非直起 `index.ts`，
 * 于是**若存在 `~/.thoughtsbox/provider.key`，模型 API key 会被自动注入子进程 env**，
 * 真实链路（输入记录→模型解释）就绪；没有 key 文件则照常按「未配置」启动，等价于 dev.mjs。
 *
 * 不变量（照 dev.mjs 的设计）：
 *  - 两个进程都退出——留一个孤儿后端 = 端口被占 + 锁文件残留，下次启动只能靠接管规则收拾；
 *  - 任一端非预期退出 ⇒ 立刻停另一端并按其退出码退出；
 *  - SIGINT/SIGTERM（Ctrl+C）干净拆栈。
 *
 * 端口固定、不自动切换（strictPort，产品约束）：后端 8737 见 config.local.json，前端 5173 见 vite.config.ts。
 * 数据目录沿用 `TB_DATA_DIR` 直通——不设它就是在真实数据目录上跑后端。
 */
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** 给子进程输出加彩色前缀逐行转发，便于在一屏里区分后端/前端。 */
function label(stream, name, color) {
  const prefix = `\x1b[${color}m[${name}]\x1b[0m `;
  let buffer = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) process.stdout.write(prefix + line + "\n");
  });
  stream.on("end", () => {
    if (buffer !== "") process.stdout.write(prefix + buffer + "\n");
  });
}

const children = [];
let shuttingDown = false;

function start(name, scriptArgs, color) {
  const child = spawn(process.execPath, scriptArgs, {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
  label(child.stdout, name, color);
  label(child.stderr, name, "31");
  child.on("exit", (code, signal) => {
    if (shuttingDown) return;
    console.log(`\x1b[31m[${name}]\x1b[0m 退出（code=${code} signal=${signal}），停止其余进程`);
    stopAll(typeof code === "number" && code !== 0 ? code : 1);
  });
  children.push(child);
  return child;
}

function stopAll(code) {
  shuttingDown = true;
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  }
  setTimeout(() => process.exit(code), 300).unref();
}

process.on("SIGINT", () => stopAll(0));
process.on("SIGTERM", () => stopAll(0));

// 后端：经 run-server.mjs（有 provider.key 就注入密钥；无则按未配置起）。
// 它自身再 spawn src/server/index.ts，SIGTERM 会被 run-server 转发给后端子进程。
start("server", [join(projectRoot, "scripts", "run-server.mjs")], "36");
// 前端：vite dev（5173），把 /api/ 代理到后端 8737。
start("web", [join(projectRoot, "node_modules", "vite", "bin", "vite.js")], "35");

console.log("\x1b[36m[launch]\x1b[0m Web UI  http://127.0.0.1:5173    ·  后端  http://127.0.0.1:8737/api/health");
console.log("\x1b[36m[launch]\x1b[0m 模型链路：配了 ~/.thoughtsbox/provider.key 即自动生效；Ctrl+C 一起停。");
