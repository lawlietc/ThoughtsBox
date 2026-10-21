import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App.tsx";
import type { AppProps } from "./App.tsx";
import "./styles.css";

const container = document.getElementById("root");
if (container === null) {
  throw new Error("缺少 #root 挂载点");
}

/**
 * 「一份 UI 两个数据源」里那个开关：只有 dev 构建、且显式点亮了那个环境变量，才把假数据入口
 * 动态 import 进来。两个条件缺一个，这一行就只是 `<App />`——生产静态图因此根本不含假数据本体，
 * 也不是「摇掉了」而是「压根没引」（`tests/web-ui5-fixtures.test.ts` + 构建产物扫描各钉一遍）。
 *
 * `import.meta.env.DEV` 在 `npm run build` 后是字面 `false`，于是整支动态 import 连同 `fixtures/`
 * 被 Rollup 摇掉；`VITE_USE_MOCK` 不设也一样。动态 import 不被 vite 预打包进 index，留独立 chunk。
 */
async function resolveAppProps(): Promise<AppProps> {
  if (import.meta.env.DEV && import.meta.env.VITE_USE_MOCK === "1") {
    const entry = await import("./fakeDataEntry.tsx");
    return entry.fakeAppProps();
  }
  return {};
}

void resolveAppProps().then((appProps) => {
  createRoot(container).render(
    <StrictMode>
      <App {...appProps} />
    </StrictMode>,
  );
});
