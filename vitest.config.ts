import { defineConfig } from "vitest/config";

/**
 * 测试与运行时共用一条纪律：隔离数据目录。
 * 任何测试都不允许落到 %LOCALAPPDATA%\ThoughtsBox（M0 高风险不变量 3）。
 */
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    pool: "forks",
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
