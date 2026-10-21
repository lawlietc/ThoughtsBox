import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { BOX_SUB_TABS, BOX_TABS, STANDALONE, TABS, TODAY_TABS, tabOf } from "../src/web/ui/nav.ts";
import type { TabKey, ViewKey } from "../src/web/ui/types.ts";

/**
 * M3 UI-1 的两组断言，都能在 node 里跑（`vitest.config.ts` 的 environment 是 node，没有 DOM）：
 *
 * 1. **结构断言** —— 导航那几张表（TABS / TODAY_TABS / BOX_TABS / STANDALONE / tabOf）
 *    的内容与归属映射。这就是它们放在不带 JSX 的 `nav.ts` 的理由：
 *    一张表能被直接 import 来断言，就不必为了测它装一套 DOM。
 *
 * 2. **纯度断言** —— 把「展示组件不读全局状态、数据一律经 props」这条硬约束
 *    变成会红的测试。读源码文本用 `node:fs`，这是 node 环境最擅长的事。
 *    组件**渲染**对不对不由这里负责，由 prototype/scripts/render-check.mjs 的渲染证据门负责。
 *
 * 〔M5-4P 有意变动 · 理由单列在 `worklogs/2026-10-19-M5-4P-today-visual-pilot.md`〕
 * 顶层从四个（记录 / 盒子 / 搜索 / 更多）收成三个（今天 / 盒子 / 更多）：
 * 「搜索」不再占一个顶层格，改为盒子末位的子 tab。钉的东西没变 —— 每张表的键、标签、
 * 落地页与归属仍逐条对死，只是那三行换成了新的四行/五行断言。
 */

/* ── 1. 结构断言 ───────────────────────────────────────────────── */

describe("ui/nav —— 导航结构", () => {
  it("三个主 tab 的键、标签、落地页（今天 / 盒子 / 更多）", () => {
    expect(TABS).toEqual([
      { key: "today", label: "今天", home: "today" },
      { key: "boxes", label: "盒子", home: "emotions" },
      { key: "more", label: "更多", home: "more" },
    ]);
  });

  it("「今天」的四个子 tab（顺序即阅读顺序，今天在最前）", () => {
    expect(TODAY_TABS).toEqual([
      { key: "today", label: "今天" },
      { key: "records", label: "全部记录" },
      { key: "ingest", label: "待整理" },
      { key: "suggestions", label: "待确认" },
    ]);
  });

  it("「盒子」的五个平级子 tab", () => {
    expect(BOX_TABS).toEqual([
      { key: "emotions", label: "情绪" },
      { key: "episodes", label: "经历" },
      { key: "thoughts", label: "念头" },
      { key: "entities", label: "人物与事物" },
      { key: "topics", label: "主题" },
    ]);
  });

  it("画出来的盒子子 tab = 五个回看页 + 收编进来的搜索（顺序即高亮顺序）", () => {
    expect(BOX_SUB_TABS).toEqual([...BOX_TABS, { key: "search", label: "搜索" }]);
  });

  it("不进标签栏的是那两个动作与沟通件自己的目录页", () => {
    expect(STANDALONE).toEqual(["quick", "sleep", "overview"]);
  });

  it("每个 tab 的落地页都归属在这个 tab 自己下面", () => {
    for (const entry of TABS) {
      expect(tabOf(entry.home), `${entry.key} 的 home=${entry.home} 不属于该 tab`).toBe(entry.key);
    }
  });

  it("每张子表的条目都归属在对应的主 tab 下", () => {
    for (const entry of TODAY_TABS) expect(tabOf(entry.key)).toBe("today");
    for (const entry of BOX_SUB_TABS) expect(tabOf(entry.key)).toBe("boxes");
  });

  it("页面归属表逐条等于裁定后的结构", () => {
    const mapping: readonly (readonly [ViewKey, TabKey | null])[] = [
      ["today", "today"],
      ["quick", "today"],
      ["records", "today"],
      ["ingest", "today"],
      ["suggestions", "today"],
      ["sleep", "today"],
      ["emotions", "boxes"],
      ["episodes", "boxes"],
      ["thoughts", "boxes"],
      ["entities", "boxes"],
      ["topics", "boxes"],
      ["search", "boxes"],
      ["more", "more"],
      ["data", "more"],
      // 沟通件自己的目录页，与按裁定推迟的图谱，都不该被高亮到任何一个 tab 上
      ["overview", null],
      ["graph", null],
    ];
    const keys = mapping.map(([view]) => view);
    expect(new Set(keys).size, "归属表有重复页面").toBe(keys.length);
    for (const [view, tab] of mapping) {
      expect(tabOf(view), `${view} 的归属`).toBe(tab);
    }
  });
});

/* ── 2. 纯度断言 ───────────────────────────────────────────────── */

const UI_DIR = fileURLToPath(new URL("../src/web/ui/", import.meta.url));
const WEB_DIR = fileURLToPath(new URL("../src/web/", import.meta.url));

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(path));
    else out.push(path);
  }
  return out.sort();
}

/**
 * 界面层禁止出现的四类写法。每一条都是「这份组件只能跑在一侧」的具体形态：
 * 读某个 store、去假数据目录取数、反向依赖沟通件目录、或者自己发请求。
 */
const FORBIDDEN_IN_UI: readonly (readonly [string, string])[] = [
  ["useProto", "界面直接读那一侧的全局 store —— 数据必须从 props / context 进来"],
  ["mock/", "界面自己去取假数据"],
  ["prototype/", "产品反向依赖沟通件目录：依赖方向只能是原型 → 产品"],
  ["fetch(", "组件自己发请求：取数是调用方的事"],
];

describe("ui/ 纯度 —— 展示组件只吃 props", () => {
  const files = listFiles(UI_DIR);

  it("src/web/ui 确实有文件在被断言（不是空目录蒙混过关）", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    const source = readFileSync(file, "utf8");
    for (const [needle, why] of FORBIDDEN_IN_UI) {
      it(`${file.replace(/\\/g, "/")} 不含 ${needle}`, () => {
        expect(source, why).not.toContain(needle);
      });
    }
  }
});

describe("src/web 不得反向依赖沟通件目录", () => {
  for (const file of listFiles(WEB_DIR)) {
    it(`${file.replace(/\\/g, "/")} 不引用 prototype/`, () => {
      expect(readFileSync(file, "utf8")).not.toContain("prototype/");
    });
  }
});
