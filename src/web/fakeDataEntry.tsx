/**
 * 产品 web 侧假数据的**唯一入口**：被 `main.tsx` 那个 dev-only 动态 import 进来。
 *
 * 它把三件事拼在一起，然后交给那个**一行没改过**的 `<App>`：
 * 1. `installFakeFetch()` —— 把 `globalThis.fetch` 换成假路由，于是记录那几页（今天 / 全部 / 待整理 / 搜索）
 *    在没有后端时也吃上假数据；面板代码完全不知道数据是假的（这正是「一份 UI 两个数据源」要证的）。
 * 2. `FIXTURE_DATA_PORT` —— 盒子五页与待确认页那条口的假数据实现（经 `App` 的 `port` prop 注入）。
 * 3. `banner` —— 「这一屏是假数据」那一条横幅，措辞与产品外壳已有的 `.banner` 同一套，不自造视觉语言。
 *
 * 另加一件（web-redesign 第二步）：地址串里的 `?rich=1` → `setFakeRichResult(true)`，
 * 让详情页把「整理结果」那一栏画出来好看效果。它是**默认关**的样张开关，横幅会跟着多念一句
 * 「这一栏也是手写的投影」；这个参数不住在这一层以外，生产图里根本没有这一页。
 *
 * 这一层之所以返回 `Promise<AppProps>` 而不是直接 render：保持 `main.tsx` 里生产分支**静态**只 render
 * `<App />`，假分支才不会被 Rollup 当成静态依赖拖进生产图。
 */

import { FAKE_DATA_BANNER_TEXT, FIXTURE_DATA_PORT } from "./fixturePort.ts";
import { installFakeFetch, setFakeCandidateSample, setFakePendingSample, setFakeRichResult } from "./fakeApi.ts";
import type { AppProps } from "./App.tsx";

/**
 * 样张开关：`?rich=1` 才把详情页那栏「整理结果」画出来（`fakeApi.ts` §样张）。
 * 读地址串的只有这一层——它已经躲在 `main.tsx` 的动态 import 后面，产品面板与生产构建
 * 都不认识这个参数。默认关：关着时详情页照旧走「解析未就绪」那条既有诚实路径。
 */
const RICH_SAMPLE = new URLSearchParams(window.location.search).has("rich");
/**
 * 候选那一支（`?rich=1&cand=1`）：多一份「等你表态」的候选结果。
 * 单独一个开关是为了让批 5 量过的样张基线（没有候选时的那份）继续可复现。
 */
const CANDIDATE_SAMPLE = RICH_SAMPLE && new URLSearchParams(window.location.search).has("cand");
/** 待整理样张（`?pending=1`）：把一条记录翻成「云端 · 待确认发送」，让那一框有得看。 */
const PENDING_SAMPLE = new URLSearchParams(window.location.search).has("pending");

installFakeFetch();
if (RICH_SAMPLE) setFakeRichResult(true);
if (CANDIDATE_SAMPLE) setFakeCandidateSample(true);
if (PENDING_SAMPLE) setFakePendingSample(true);

/** dev 假数据模式下要喂给 `<App>` 的那一份 props。 */
export function fakeAppProps(): AppProps {
  return {
    port: FIXTURE_DATA_PORT,
    banner: (
      <div className="banner" role="status">
        <strong>这是假数据。</strong>
        {FAKE_DATA_BANNER_TEXT}
        {RICH_SAMPLE && "（样张开关开着：详情页那栏整理结果也是手写的投影，用 ?rich=1 打开。）"}
        {CANDIDATE_SAMPLE && "（候选样张也开着：详情页会多一块「等你表态」，用 ?rich=1&cand=1 打开。）"}
        {PENDING_SAMPLE && "（待整理样张开着：有一条记录被翻成「云端 · 待确认发送」，用 ?pending=1 打开。）"}
      </div>
    ),
  };
}
