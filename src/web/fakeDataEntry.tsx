/**
 * 产品 web 侧假数据的**唯一入口**：被 `main.tsx` 那个 dev-only 动态 import 进来。
 *
 * 它把三件事拼在一起，然后交给那个**一行没改过**的 `<App>`：
 * 1. `installFakeFetch()` —— 把 `globalThis.fetch` 换成假路由，于是记录那几页（今天 / 全部 / 待整理 / 搜索）
 *    在没有后端时也吃上假数据；面板代码完全不知道数据是假的（这正是「一份 UI 两个数据源」要证的）。
 * 2. `FIXTURE_DATA_PORT` —— 盒子五页与待确认页那条口的假数据实现（经 `App` 的 `port` prop 注入）。
 * 3. `banner` —— 「这一屏是假数据」那一条横幅，措辞与产品外壳已有的 `.banner` 同一套，不自造视觉语言。
 *
 * 这一层之所以返回 `Promise<AppProps>` 而不是直接 render：保持 `main.tsx` 里生产分支**静态**只 render
 * `<App />`，假分支才不会被 Rollup 当成静态依赖拖进生产图。
 */

import { FAKE_DATA_BANNER_TEXT, FIXTURE_DATA_PORT } from "./fixturePort.ts";
import { installFakeFetch } from "./fakeApi.ts";
import type { AppProps } from "./App.tsx";

installFakeFetch();

/** dev 假数据模式下要喂给 `<App>` 的那一份 props。 */
export function fakeAppProps(): AppProps {
  return {
    port: FIXTURE_DATA_PORT,
    banner: (
      <div className="banner" role="status">
        <strong>这是假数据。</strong>
        {FAKE_DATA_BANNER_TEXT}
      </div>
    ),
  };
}
