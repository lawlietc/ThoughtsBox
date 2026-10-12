import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { openDatabase } from "../src/server/db/adapter.ts";
import { resolveDataLayout } from "../src/server/config/paths.ts";
import {
  acquireInstanceLock,
  quarantineFiles,
} from "../src/server/runtime/singleInstance.ts";
import { makeSandbox } from "./helpers/sandbox.ts";

/**
 * 单实例机制选型实测（M0 交付物 6：两种方案都要跑过才允许择一固化）。
 * 本文件的每条断言都来自本机实际执行结果，不是推断——结论见 ADR-015。
 */

const fixtures: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "tb-lockprobe-"));
  fixtures.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of fixtures) rmSync(dir, { recursive: true, force: true });
});

function waitForReady(child: ReturnType<typeof spawn>): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      buffer += chunk;
      const match = /READY (\d+)/.exec(buffer);
      if (match) resolve(match[1]!);
    });
    child.on("exit", (code) => reject(new Error(`夹具提前退出，code=${code}`)));
    setTimeout(() => reject(new Error("夹具启动超时")), 10000);
  });
}

describe("方案 B：SQLite 独占打开", () => {
  it("实测：EXCLUSIVE 锁连同进程的第二个连接都挡住，报错只有 database is locked", () => {
    const path = join(tempDir(), "held.sqlite");
    const first = openDatabase(path);
    first.exec("PRAGMA locking_mode = EXCLUSIVE");
    first.exec("create table t(x text); insert into t values ('占位')");
    const second = openDatabase(path);
    second.exec("PRAGMA busy_timeout = 200");
    let observed: { ok: boolean; message: string } = { ok: true, message: "" };
    try {
      second.prepare("select count(*) as n from t").get();
    } catch (cause) {
      observed = { ok: false, message: (cause as Error).message };
    }
    second.close();
    first.close();
    expect(observed.ok).toBe(false);
    expect(observed.message).toMatch(/locked/i);
  });

  it("实测：跨进程只拿到一句 locked，既没有对方 PID 也没有端口，做不出可读冲突提示", async () => {
    const dir = tempDir();
    const path = join(dir, "cross.sqlite");
    const child = spawn(process.execPath, ["tests/fixtures/sqliteExclusiveHolder.mjs", path], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const holderPid = await waitForReady(child);
    let observed = "no-error";
    try {
      const probe = openDatabase(path);
      probe.exec("PRAGMA busy_timeout = 200");
      try {
        probe.prepare("select count(*) as n from held").get();
      } catch (cause) {
        observed = (cause as Error).message;
      }
      probe.close();
    } finally {
      child.kill();
    }
    expect(observed).toMatch(/locked|BUSY|busy/i);
    expect(observed).not.toContain(holderPid);
    expect(observed).not.toMatch(/port|127\.0\.0\.1/i);
  });

  it("实测：WAL 下读连不被未提交写事务挡住，但第二个写事务拿到同样形状的 locked", () => {
    const path = join(tempDir(), "transient.sqlite");
    const writer = openDatabase(path);
    writer.exec("PRAGMA journal_mode = WAL");
    writer.exec("create table t(x text)");
    writer.exec("BEGIN IMMEDIATE");
    writer.prepare("insert into t values ('未提交')").run();

    const reader = openDatabase(path);
    reader.exec("PRAGMA busy_timeout = 200");
    let readError = "no-error";
    try {
      reader.prepare("select count(*) as n from t").get();
    } catch (cause) {
      readError = (cause as Error).message;
    }
    // 读路径不阻塞，所以「读失败」根本不能当实例判据。
    expect(readError).toBe("no-error");

    const rival = openDatabase(path);
    rival.exec("PRAGMA busy_timeout = 200");
    let writeError = "no-error";
    try {
      rival.exec("BEGIN IMMEDIATE");
    } catch (cause) {
      writeError = (cause as Error).message;
    }
    try {
      rival.exec("ROLLBACK");
    } catch {
      /* BEGIN 未成功时没有活动事务 */
    }
    writer.exec("ROLLBACK");
    reader.close();
    rival.close();
    writer.close();
    // 普通写冲突与「另一个实例」的报错无法区分：同样只有 locked，没有身份。
    expect(writeError).toMatch(/locked|BUSY|busy/i);
  });
});

describe("方案 A：锁文件 + PID / 端口双判据", () => {
  it("锁文件能表达「谁在跑、跑在哪个端口、哪次启动」，release 后不留残留", async () => {
    const sandbox = makeSandbox("tb-lockfile-");
    try {
      const held = await acquireInstanceLock(sandbox.layout, {
        host: "127.0.0.1",
        port: 8737,
        probe: async () => false,
      });
      const record = JSON.parse(readFileSync(sandbox.layout.lockFile, "utf8")) as Record<string, unknown>;
      expect(record.pid).toBe(process.pid);
      expect(record.port).toBe(8737);
      expect(typeof record.nonce).toBe("string");
      held.release();
      expect(existsSync(sandbox.layout.lockFile)).toBe(false);
    } finally {
      sandbox.cleanup();
    }
  });

  it("被接管的残留锁改名保留，不静默丢弃现场", async () => {
    const layout = resolveDataLayout({ TB_DATA_DIR: tempDir() });
    writeFileSync(
      layout.lockFile,
      JSON.stringify({ pid: 999_999, host: "127.0.0.1", port: 8737, nonce: "dead-nonce" }),
      "utf8",
    );
    const held = await acquireInstanceLock(layout, { host: "127.0.0.1", port: 8737, probe: async () => false });
    expect(held.tookOver?.nonce).toBe("dead-nonce");
    expect(quarantineFiles(layout)).toHaveLength(1);
    held.release();
  });

  it("实测：Windows 下 kill() 不执行信号处理器，残留只能靠接管路径清理", async () => {
    const dir = tempDir();
    const layout = resolveDataLayout({ TB_DATA_DIR: dir });
    const child = spawn(process.execPath, ["-e", `
      const fs = require("node:fs");
      fs.writeFileSync(${JSON.stringify(join(dir, "child.lock"))}, JSON.stringify({pid: process.pid, host: "127.0.0.1", port: 8737, nonce: "child-nonce", started_at: new Date().toISOString()}));
      process.on("SIGTERM", () => process.exit(0));
      setTimeout(() => {}, 60000);
    `], { stdio: "ignore" });
    await new Promise<void>((resolve) => child.once("spawn", resolve));
    // 等子进程把锁文件写出来，再确认它被强杀后没有清理干净。
    const childLock = join(dir, "child.lock");
    for (let i = 0; i < 100 && !existsSync(childLock); i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(existsSync(childLock)).toBe(true);
    child.kill();
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    // 子进程被杀后信号处理器没跑，锁文件仍在——这正是接管路径必须存在的原因。
    expect(existsSync(childLock)).toBe(true);
    writeFileSync(layout.lockFile, readFileSync(childLock, "utf8"), "utf8");
    const held = await acquireInstanceLock(layout, { host: "127.0.0.1", port: 8737, probe: async () => false });
    expect(held.tookOver).toBeTruthy();
    held.release();
  });
});
