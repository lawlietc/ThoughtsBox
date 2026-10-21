import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * 前端只是可视化层（ADR-012）：数据一律来自本地后端，dev 环境用代理避免跨域，
 * strictPort 与后端一致——端口不静默切换是产品约束，不是偏好。
 */
export default defineConfig({
  root: fileURLToPath(new URL("src/web/", import.meta.url)),
  plugins: [react()],
  build: {
    outDir: fileURLToPath(new URL("dist/", import.meta.url)),
    emptyOutDir: true,
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      // 必须带尾斜杠：代理键是**前缀**匹配，写成 "/api" 会连前端自己的模块一起吞进后端，
      // 导致整棵 React 挂载失败、页面空白（浏览器首验时撞的正是当时的 `src/web/api.ts`，
      // dev 路径 `/api.ts`；该模块已改名 `apiClient.ts`，撞名从根上消除，此处保险不变）。
      // API 面所有路径都是 `/api/<段>`，带斜杠不会漏。改动此键前先确认没有 `/api` 结尾的端点。
      "/api/": { target: "http://127.0.0.1:8737", changeOrigin: false },
    },
  },
});
