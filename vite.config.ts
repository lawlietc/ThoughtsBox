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
      "/api": { target: "http://127.0.0.1:8737", changeOrigin: false },
    },
  },
});
