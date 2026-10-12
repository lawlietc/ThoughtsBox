import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { defaultDataDir } from "../src/server/config/paths.ts";
import { runSelfCheck, SELF_CHECK_STEPS, SelfCheckFailure } from "../src/server/runtime/selfCheck.ts";

let root: string | undefined;

afterEach(() => {
  if (root !== undefined) {
    rmSync(root, { recursive: true, force: true });
    root = undefined;
  }
});

function tempRoot(): string {
  root = mkdtempSync(join(tmpdir(), "tb-selfcheck-"));
  return root;
}

describe("启动自检（M0 交付物 3）", () => {
  it("本机全部能力通过", () => {
    const report = runSelfCheck();
    expect(report.passed).toEqual(SELF_CHECK_STEPS.map((step) => step.capability));
    expect(report.sqliteVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(report.contractsFingerprint).toHaveLength(64);
  });

  it("缺少 crypto.randomUUIDv7 时报的是能力名，不是泛化错误", () => {
    const failure = (() => {
      try {
        runSelfCheck({ uuidv7: undefined, tmpRoot: tempRoot() });
        return undefined;
      } catch (cause) {
        return cause;
      }
    })();
    expect(failure).toBeInstanceOf(SelfCheckFailure);
    expect((failure as SelfCheckFailure).capability).toBe("crypto.randomUUIDv7");
    expect((failure as Error).message).toContain("不降级、不自实现");
  });

  it("按顺序检查：能力名出现在错误里，而不是只剩 SQL 原文", () => {
    const broken = {
      capability: "FTS5 虚拟表",
      id: "fts5",
      run: () => ({
        ok: false as const,
        capability: "FTS5 虚拟表",
        detail: "no such module: fts5",
      }),
    };
    const steps = SELF_CHECK_STEPS.map((step) => (step.id === "fts5" ? broken : step));
    try {
      runSelfCheck({ steps, tmpRoot: tempRoot() });
      throw new Error("应该失败");
    } catch (cause) {
      expect(cause).toBeInstanceOf(SelfCheckFailure);
      expect((cause as SelfCheckFailure).capability).toBe("FTS5 虚拟表");
    }
  });

  it("自检只在临时目录里动手，不碰用户真实数据目录", () => {
    // 只 stat 目录本身（列目录内容算读用户数据，违反验收断言）。
    const stamp = (): number | null => {
      try {
        return statSync(defaultDataDir()).mtimeMs;
      } catch {
        return null;
      }
    };
    const before = stamp();
    const isolated = tempRoot();
    runSelfCheck({ tmpRoot: isolated });
    expect(stamp()).toBe(before);
    // 自检自己的工作痕迹用完即清，临时目录里不留文件。
    expect(readdirSync(isolated)).toEqual([]);
  });

  it("external-content FTS5 的删除同步被真正验证过（不是只建表成功）", () => {
    const step = SELF_CHECK_STEPS.find((entry) => entry.id === "ecosystem-fts5")!;
    const outcome = step.run({ tmpRoot: tempRoot() });
    expect(outcome.ok).toBe(true);
  });
});
