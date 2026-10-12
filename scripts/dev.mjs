#!/usr/bin/env node
// 开发启动器：一条命令同时拉起本地后端与前端。
// 两端都必须退出——留下一个孤儿后端意味着端口被占、锁文件残留，下次启动只能靠接管规则收拾。
import { spawn } from "node:child_process";
import process from "node:process";

const children = [];
let shuttingDown = false;

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

function start(name, args, color) {
  const child = spawn(process.execPath, args, {
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

start("server", ["src/server/index.ts"], "36");
start("web", ["node_modules/vite/bin/vite.js"], "35");

console.log("后端 http://127.0.0.1:8737/api/health · 前端 http://127.0.0.1:5173");
