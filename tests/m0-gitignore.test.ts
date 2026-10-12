import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, copyFileSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

/**
 * .gitignore 不是靠肉眼确认的（M0 验收：密钥、运行数据、构建产物一律不入库）。
 * 这里把仓库根的真实 .gitignore 拷进一个临时 git 仓库，让 git 自己判定每个路径。
 */

import { projectRoot } from "../src/server/config/config.ts";

const root = projectRoot();
const sandboxes: string[] = [];

afterAll(() => {
  for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function gitInTempRepo(paths: string[]): Set<string> {
  const dir = mkdtempSync(join(tmpdir(), "tb-gitignore-"));
  sandboxes.push(dir);
  execFileSync("git", ["init", "-q"], { cwd: dir });
  copyFileSync(join(root, ".gitignore"), join(dir, ".gitignore"));
  // 真实存在的路径才会在 --untracked-files=all 的 status 里出现
  for (const p of paths) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), "占位\n", "utf8");
  }
  writeFileSync(join(dir, "src_keep.ts"), "export const keep = 1;\n", "utf8");
  const out = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], {
    cwd: dir,
    encoding: "utf8",
  });
  return new Set(
    out
      .split("\n")
      .map((line) => line.slice(3).trim().replace(/\\/g, "/"))
      .filter((line) => line.length > 0),
  );
}

describe("隐私边界：.gitignore 实测", () => {
  const sensitive = [
    ".env",
    ".env.local",
    "config.local.json",
    "data/thoughts.sqlite",
    "data/thoughts.sqlite-wal",
    "data/runtime.lock",
    "data/runtime.lock.stale-018e-submitted",
    "backups/backup-2026-10-12.sqlite",
    "debug-export/thoughts.jsonl.bak",
    "logs/server.log",
    "dist/index.html",
    "node_modules/pkg/index.js",
    "coverage/lcov.info",
  ];

  it("密钥、运行数据、备份、调试导出、构建产物全部不入库", () => {
    const visible = gitInTempRepo(sensitive);
    const leaked = sensitive.filter((p) => visible.has(p));
    expect(leaked).toEqual([]);
  });

  it("模板与源码照常入库——屏蔽规则没有一刀切", () => {
    const visible = gitInTempRepo([
      ".env.example",
      "config.example.json",
      "src_keep.ts",
      "src/server/index.ts",
    ]);
    expect(visible.has("src_keep.ts")).toBe(true);
    expect(visible.has(".env.example")).toBe(true);
    expect(visible.has("config.example.json")).toBe(true);
  });

  it("每条例外规则都对应一个真实存在的模板文件", () => {
    const text = readFileSync(join(root, ".gitignore"), "utf8");
    const negations = text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("!"))
      .map((line) => line.slice(1));
    expect(negations.length).toBeGreaterThan(0);
    // 例外必须逐个点名：通配例外（!.env*）会把真实密钥文件放回来。
    for (const pattern of negations) {
      expect(pattern).not.toContain("*");
      expect(existsSync(join(root, pattern)), `例外规则 ${pattern} 指向的模板不存在`).toBe(true);
    }
  });
});
