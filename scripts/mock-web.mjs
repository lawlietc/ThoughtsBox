#!/usr/bin/env node
// mock 数据前端的启动器（5174）：不起后端、不读真实数据目录，纯演示界面。
//
// 为什么要一个 node 脚本而不是 `VITE_USE_MOCK=1 npm run start:web`：
// 前置赋值是 POSIX 语法，cmd/PowerShell 不认；`set X=1 && npm run ...` 反过来只在 Windows 成立。
// 跨平台只有一条路——在 node 里改 env 再 spawn，三个系统共用同一条 `npm run start:mock`。
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 5174;

const child = spawn(
  process.execPath,
  [join(projectRoot, "node_modules", "vite", "bin", "vite.js"), "--host", "127.0.0.1", "--port", String(PORT), "--strictPort"],
  { cwd: projectRoot, stdio: "inherit", env: { ...process.env, VITE_USE_MOCK: "1" } },
);

child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 1)));
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}

console.log(`\x1b[35m[mock]\x1b[0m http://127.0.0.1:${PORT}  ·  mock 数据已启用，无需后端；Ctrl+C 停止。`);
