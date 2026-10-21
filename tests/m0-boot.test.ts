import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";

import { ensureConfigFile } from "../src/server/config/config.ts";
import { resolveDataLayout, type DataLayout } from "../src/server/config/paths.ts";
import {
  HEAD_SCHEMA_VERSION,
  countRows,
  makeSandbox,
  openSandboxDb,
  type Sandbox,
} from "./helpers/sandbox.ts";
import { boot, shutdown } from "../src/server/runtime/bootstrap.ts";

/**
 * 启动顺序的端到端验收（M0 验收断言）。
 * Windows 上 kill 子进程不会运行信号处理器，所以"优雅释放锁"与"崩溃残留被接管"是两条必须分别证明的路径。
 */

let sandbox: Sandbox | undefined;
const children: ChildProcessByStdio<null, Readable, Readable>[] = [];

async function exited(child: ChildProcessByStdio<null, Readable, Readable>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 5000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

afterEach(async () => {
  // Windows 上 kill 即 TerminateProcess，句柄释放是异步的：先等子进程真退出，再删临时目录。
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited(child);
  }
  if (sandbox !== undefined) {
    sandbox.cleanup();
    sandbox = undefined;
  }
});

/** 测试端口一律向系统要一个空闲端口：不与用户可能正在跑的 8737 实例相撞。 */
async function testPort(): Promise<number> {
  const { createServer } = await import("node:net");
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (address === null || typeof address === "string") {
        reject(new Error("无法取得空闲端口"));
        return;
      }
      const port = address.port;
      probe.close(() => resolve(port));
    });
  });
}

function layoutAt(dataDir: string, port: number): DataLayout {
  const layout = resolveDataLayout({ TB_DATA_DIR: dataDir });
  mkdirSync(layout.dataDir, { recursive: true });
  const file = ensureConfigFile(layout);
  const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  (raw.server as Record<string, unknown>).port = port;
  writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
  return layout;
}

function startChild(dataDir: string): ChildProcessByStdio<null, Readable, Readable> {
  const child = spawn(process.execPath, ["src/server/index.ts"], {
    // 显式 cwd：子进程不继承 vitest 的工作目录，避免测试结束时临时目录还被当作 cwd 占用。
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, TB_DATA_DIR: dataDir },
  });
  children.push(child);
  return child;
}

function collect(child: ChildProcessByStdio<null, Readable, Readable>): { stdout: string; stderr: string } {
  const buffers = { stdout: "", stderr: "" };
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => (buffers.stdout += chunk));
  child.stderr.on("data", (chunk: string) => (buffers.stderr += chunk));
  return buffers;
}

function until(predicate: () => boolean, timeoutMs = 20000): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const tick = (): void => {
      if (predicate()) return resolve();
      if (Date.now() > deadline) return reject(new Error("等待条件超时"));
      setTimeout(tick, 50);
    };
    tick();
  });
}

async function health(port: number): Promise<Record<string, string | number>> {
  const response = await fetch(`http://127.0.0.1:${port}/api/health`);
  if (!response.ok) throw new Error(`health HTTP ${response.status}`);
  return (await response.json()) as Record<string, string | number>;
}

describe("进程内启动与优雅关闭", () => {
  it("boot → shutdown：锁被释放，迁移只执行一次", async () => {
    sandbox = makeSandbox("tb-inproc-");
    const port = await testPort();
    const env = { TB_DATA_DIR: sandbox.root };
    const layout = layoutAt(sandbox.root, port);

    const first = await boot({ env, log: () => {} });
    try {
      expect(first.schemaVersion).toBe(HEAD_SCHEMA_VERSION);
      expect(await health(port)).toMatchObject({ status: "ok", schemaVersion: HEAD_SCHEMA_VERSION });
      expect(existsSync(layout.lockFile)).toBe(true);
    } finally {
      await shutdown(first);
    }
    expect(existsSync(layout.lockFile)).toBe(false);
    expect(existsSync(layout.dbFile)).toBe(true);

    const second = await boot({ env, log: () => {} });
    await shutdown(second);
    const db = openSandboxDb(layout);
    try {
      expect(countRows(db, "schema_migrations")).toBe(HEAD_SCHEMA_VERSION);
    } finally {
      db.close();
    }
  });

  it("拿到锁之后启动失败：已持有的锁必须被释放，不留现场垃圾", async () => {
    sandbox = makeSandbox("tb-boot-fail-");
    const layout = layoutAt(sandbox.root, await testPort());
    // 用一个非法文件冒充数据库：失败发生在锁之后、迁移之内，正好走 release 分支。
    writeFileSync(layout.dbFile, "这不是一本 SQLite 数据库", "utf8");
    await expect(boot({ env: { TB_DATA_DIR: sandbox.root }, log: () => {} })).rejects.toBeTruthy();
    expect(existsSync(layout.lockFile)).toBe(false);
  });
});

describe("子进程级真实启动", () => {
  it("启动 → 关闭 → 再启动：接管残留锁而不是报错，且不重复初始化", async () => {
    sandbox = makeSandbox("tb-restart-");
    const port = await testPort();
    layoutAt(sandbox.root, port);

    const first = startChild(sandbox.root);
    const firstOutput = collect(first);
    await until(() => firstOutput.stdout.includes("/api/health"));
    expect(firstOutput.stdout).toContain(`执行迁移 ${HEAD_SCHEMA_VERSION} 份`);
    expect(firstOutput.stdout).toContain("TB_DATA_DIR 覆盖");
    expect(await health(port)).toMatchObject({ status: "ok", schemaVersion: HEAD_SCHEMA_VERSION });
    const dbBytes = readFileSync(sandbox.layout.dbFile).length;

    first.kill();
    await exited(first);
    // Windows 下 kill 不跑处理器，锁可能残留；残留与否都走同一条"不重复初始化"断言。
    const leftover = existsSync(sandbox.layout.lockFile);

    const second = startChild(sandbox.root);
    const secondOutput = collect(second);
    await until(() => secondOutput.stdout.includes("/api/health"));
    expect(secondOutput.stdout).toContain("迁移无需执行");
    if (leftover) expect(secondOutput.stdout).toContain("接管残留运行锁");
    expect(readFileSync(sandbox.layout.dbFile).length).toBeGreaterThanOrEqual(dbBytes);
    expect(await health(port)).toMatchObject({ status: "ok" });
  });

  it("第二个实例：不写数据库、不迁移，给出可读冲突提示并以 12 退出", async () => {
    sandbox = makeSandbox("tb-conflict-");
    const port = await testPort();
    layoutAt(sandbox.root, port);

    const first = startChild(sandbox.root);
    const firstOutput = collect(first);
    await until(() => firstOutput.stdout.includes("/api/health"));
    const holderPid = first.pid!;
    const dbBytes = readFileSync(sandbox.layout.dbFile).length;

    const loser = startChild(sandbox.root);
    const loserOutput = collect(loser);
    const code = await new Promise<number | null>((resolve) => loser.on("exit", resolve));
    const text = `${loserOutput.stdout}${loserOutput.stderr}`;

    expect(code).toBe(12);
    expect(text).toContain("已有一个思绪盒子实例在运行");
    expect(text).toContain(`PID ${holderPid}`);
    // 冲突提示本身就写着"不执行迁移"，所以只能断言没有真正的迁移/词表动作。
    expect(text).not.toMatch(/执行迁移 \d+ 份|迁移无需执行|词表水位/);
    expect(readFileSync(sandbox.layout.dbFile).length).toBe(dbBytes);
  });

  it("端口被无关程序占用：不换端口，直接冲突退出", async () => {
    sandbox = makeSandbox("tb-portbusy-");
    const port = await testPort();
    layoutAt(sandbox.root, port);
    const { createServer } = await import("node:http");
    const stranger = createServer((_req, res) => res.end("not thoughts box"));
    await new Promise<void>((resolve) => stranger.listen(port, "127.0.0.1", resolve));
    try {
      const child = startChild(sandbox.root);
      const output = collect(child);
      const code = await new Promise<number | null>((resolve) => child.on("exit", resolve));
      expect(code).toBe(12);
      expect(`${output.stdout}${output.stderr}`).toContain("已被其他程序占用");
      expect(existsSync(sandbox.layout.lockFile)).toBe(false);
      expect(existsSync(sandbox.layout.dbFile)).toBe(false);
    } finally {
      await new Promise<void>((resolve, reject) =>
        stranger.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
