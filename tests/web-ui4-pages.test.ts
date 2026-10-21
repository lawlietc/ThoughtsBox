import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { NO_READABLE_DATA } from "../src/web/projections.ts";
import {
  BOX_SHAPES,
  cleanSearchTerm,
  COUNT_PLACEHOLDER,
  boxShapeOf,
  PROJECTION_UNREADY,
  processingModeChoices,
  SEARCH_LAYERS,
  SUGGESTION_ACTIONS,
  SUGGESTION_ALL_KEY,
  suggestionFilters,
  SUGGESTION_GAP,
} from "../src/web/projectionPort.ts";
import {
  ENTITY_LIFECYCLE_LABEL,
  ENUM_VALUES,
  EVENT_TIME_PRECISION_LABEL,
  MODE_LABEL,
  SUGGESTION_LABEL,
  SUGGESTION_STATUS_LABEL,
} from "../src/web/ui/labels.ts";
import { BOX_TABS } from "../src/web/ui/nav.ts";
import type { BoxShape, BoxView } from "../src/web/projectionPort.ts";

/**
 * M3 UI-4 的 node 断言面：**数据口的口径**与**页面的真/假**。
 *
 * 渲染对不对仍归两档渲染证据门（任务书 §九）：vitest 的 environment 是 node，没有 DOM。
 * 这里能说死的是那几条「一眼看不出对错、但错了就是事故」的事：
 * - 页面形状里的枚举词必须来自标签表（手抄一份就会显示过期世界）；
 * - 缺口必须点名到字段，而不是只写一句「暂无数据」；
 * - 计数位只能放占位符，不许出现编出来的数字；
 * - 盒子页压根没有端点，所以它**不许**偷偷去撞 `apiClient`；
 * - 收编掉的页内卡片，能力必须落在新页面上而不是消失；
 * - 不发明第三套布局 = 不引入 styles.css 里没有的类名。
 */

const WEB = join(process.cwd(), "src", "web");

function source(name: string): string {
  return readFileSync(join(WEB, name), "utf8");
}

const UI4_FILES = [
  "projectionPort.ts",
  "BoxPanel.tsx",
  "SuggestionsPanel.tsx",
  "SearchPanel.tsx",
  "QuickPanel.tsx",
  "SleepPanel.tsx",
  "SettingsPanel.tsx",
];

/** 有 JSX 的那几份（类名扫描对纯 `.ts` 没有意义）。 */
const UI4_VIEWS = UI4_FILES.filter((name) => name.endsWith(".tsx"));

/** 按 view 取形状（`BoxView` 是数据口自己导出的联合类型，测试里不需要 cast）。 */
function shapeOf(view: BoxView): BoxShape {
  const found = BOX_SHAPES.find((shape) => shape.view === view);
  expect(found, view).toBeDefined();
  return found!;
}

/* ── A. 数据口的口径（纯函数与纯数据） ─────────────────────────── */

describe("projectionPort —— 盒子五页的形状", () => {
  it("形状表恰好覆盖 BOX_TABS 的五个子 tab，一页不多一页不少", () => {
    expect(BOX_SHAPES.map((shape) => shape.view)).toEqual(BOX_TABS.map((entry) => entry.key));
    for (const entry of BOX_TABS) {
      expect(boxShapeOf(entry.key), `${entry.key} 该有形状`).not.toBeNull();
    }
    expect(boxShapeOf("today")).toBeNull();
  });

  it("每页都有真标题、导语、至少两个分组、至少三个计数位", () => {
    for (const shape of BOX_SHAPES) {
      expect(shape.title, shape.view).not.toBe("");
      expect(shape.lede, shape.view).not.toBe("");
      expect(shape.groups.length, shape.view).toBeGreaterThanOrEqual(2);
      expect(shape.counts.length, shape.view).toBeGreaterThanOrEqual(3);
      expect(new Set(shape.groups.map((group) => group.heading)).size, `${shape.view} 分组表头有重复`).toBe(
        shape.groups.length,
      );
      for (const group of shape.groups) {
        expect(group.heading, shape.view).not.toBe("");
        expect(group.note, shape.view).not.toBe("");
      }
    }
  });

  it("缺口点名到 §六 的字段名 —— 「暂无数据」不说明等什么", () => {
    const fields = (view: BoxView): string => shapeOf(view).gap.missing.join("|");
    expect(fields("emotions")).toContain("labelSaid");
    expect(fields("emotions")).toContain("basis");
    expect(fields("emotions")).toContain("evidence");
    expect(fields("emotions")).toContain("intensity");
    expect(fields("episodes")).toContain("event_time_raw");
    expect(fields("episodes")).toContain("originType");
    expect(fields("thoughts")).toContain("text");
    expect(fields("entities")).toContain("displayName");
    expect(fields("entities")).toContain("role");
    expect(fields("topics")).toContain("conceptType");
    for (const shape of BOX_SHAPES) {
      expect(shape.gap.missing.length, shape.view).toBeGreaterThan(0);
      expect(shape.gap.slots.length, shape.view).toBeGreaterThan(0);
    }
  });

  it("分组表头与计数位里的枚举词来自标签表，不是手抄的抄本", () => {
    const headings = (view: BoxView): string =>
      shapeOf(view)
        .groups.map((group) => group.heading)
        .join("|");
    expect(headings("entities")).toContain(ENTITY_LIFECYCLE_LABEL.active);
    expect(headings("entities")).toContain(ENTITY_LIFECYCLE_LABEL.provisional);
    expect(headings("entities")).toContain(ENTITY_LIFECYCLE_LABEL.archived);
    expect(headings("episodes")).toContain(EVENT_TIME_PRECISION_LABEL.unknown);
    expect(headings("topics")).toContain(SUGGESTION_LABEL.new_concept);
    expect(shapeOf("entities").counts).toContain(ENTITY_LIFECYCLE_LABEL.provisional);
  });

  it("经历页只用冻结枚举里的精度档：`time_of_day` 是原型实验档，产品不许发明取值", () => {
    expect(ENUM_VALUES.eventTimePrecision).not.toContain("time_of_day");
    for (const shape of BOX_SHAPES) {
      expect(`${shape.title}${JSON.stringify(shape.groups)}`).not.toContain("time_of_day");
    }
  });
});

describe("projectionPort —— 筛选器、搜索层、模式选项", () => {
  it("待确认筛选条的键集合 == enums.json 的建议状态 + 聚合项「全部」", () => {
    const filters = suggestionFilters();
    expect(filters.map((entry) => entry.key)).toEqual([...ENUM_VALUES.suggestionStatus, SUGGESTION_ALL_KEY]);
    for (const entry of filters.slice(0, ENUM_VALUES.suggestionStatus.length)) {
      expect(entry.label, entry.key).toBe(SUGGESTION_STATUS_LABEL[entry.key]);
    }
    expect(filters.at(-1)?.label).toBe("全部");
  });

  it("表态动作用词面写出来，但一个都不接（建议没有读写端点）", () => {
    expect(SUGGESTION_ACTIONS).toEqual(["采纳", "忽略", "撤回（依据没了）"]);
    expect(SUGGESTION_GAP.missing).toEqual(["kind", "subjectTerm", "status", "displayNote", "evidence"]);
  });

  it("搜索四层里只有原文层现在能查，未就绪的层必须点名缺哪些字段", () => {
    expect(SEARCH_LAYERS.map((layer) => layer.key)).toEqual(["all", "records", "derived", "tags", "entities"]);
    expect(SEARCH_LAYERS.filter((layer) => layer.ready).map((layer) => layer.key)).toEqual(["all", "records"]);
    for (const layer of SEARCH_LAYERS.filter((entry) => !entry.ready)) {
      expect(layer.missing.length, layer.key).toBeGreaterThan(0);
    }
  });

  it("整理模式选项取自标签表（键集合 == enums.json 的 processing_modes）", () => {
    expect(processingModeChoices().map((choice) => choice.key)).toEqual([...ENUM_VALUES.processingModes]);
    for (const choice of processingModeChoices()) {
      expect(choice.label, choice.key).toBe(MODE_LABEL[choice.key]);
    }
  });

  it("搜索词只清首尾空白：中间的字由服务端 tokenize 裁决，前端不替用户改写查询", () => {
    expect(cleanSearchTerm("  周末 爬山  ")).toBe("周末 爬山");
    expect(cleanSearchTerm("ABC")).toBe("ABC");
    expect(cleanSearchTerm("\t\n 只剩空白与制表 \n")).toBe("只剩空白与制表");
    expect(cleanSearchTerm("")).toBe("");
  });

  it("计数位的占位符不是数字 —— 0 与「不知道」不能长得一样", () => {
    expect(COUNT_PLACEHOLDER).not.toMatch(/\d/);
    expect(PROJECTION_UNREADY).toBe("这一页的数据投影还没就绪。");
  });
});

/* ── B. 这些页是真的产品页面，且不渲染假数据 ───────────────────── */

describe("UI-4 页面：真形状、假数据零", () => {
  for (const name of UI4_FILES) {
    it(`${name} 不引用假数据与沟通件目录，也不自己发请求`, () => {
      const text = source(name);
      expect(text).not.toContain("mock/");
      expect(text).not.toContain("prototype/");
      expect(text).not.toContain("fixture");
      expect(text).not.toContain("USE_MOCK");
      expect(text).not.toMatch(/\bfetch\s*\(/);
    });
  }

  it("有端点的页面只走 apiClient", () => {
    for (const name of ["SearchPanel.tsx", "QuickPanel.tsx", "SleepPanel.tsx", "SettingsPanel.tsx"]) {
      expect(source(name), name).toMatch(/from "\.\/apiClient\.ts"/);
    }
  });

  it("盒子五页与待确认页压根不取数：没有可读投影端点，就不去撞", () => {
    for (const name of ["BoxPanel.tsx", "SuggestionsPanel.tsx"]) {
      const text = source(name);
      expect(text).not.toContain("apiClient");
      expect(text).not.toMatch(/\bapi\./);
    }
  });

  // 〔M5-3B 有意变动·理由单列在工作日志〕旧断言把「缺口卡必须渲染在页面上」与
  // 「诚实空态的措辞有出处」混在了一起。M5-3B 把缺口卡从主界面删除（方案 §6.8/§6.10/§6.9），
  // 出处语义改为：措辞常量继续被真实引用（Box/Suggestions 的空态），SearchPanel 不再引用、
  // 也不再向用户展示未就绪层。行为语义不削弱：
  // BoxPanel 仍引用两个常量，SuggestionsPanel 的空态表达式由 web-ui7 逐字钉住。
  // 〔M5-3C 有意变动〕待确认页那一句是「NO_READABLE_DATA + PROJECTION_UNREADY」拼出来的工程
  // 措辞，用户读到的是「投影」两个字。它换成一对用户语言的常量（SUGGESTIONS_UNREADY /
  // NO_SUGGESTION_ROWS），出处语义不变：仍是 import 的常量、由 web-ui7 逐字钉住同一对。
  it("未就绪的措辞有出处；盒子/待确认仍引用它，搜索页不再把未就绪层画给用户", () => {
    const box = source("BoxPanel.tsx");
    expect(box).toContain("PROJECTION_UNREADY");
    expect(box).toContain("NO_READABLE_DATA");
    expect(box).not.toContain("gap.missing"); // 数据仍在 projectionPort，但面板不再把它列成字段清单
    expect(box).not.toContain("detailNote");
    const suggestions = source("SuggestionsPanel.tsx");
    expect(suggestions).toContain("SUGGESTIONS_UNREADY");
    expect(suggestions).toContain("NO_SUGGESTION_ROWS");
    expect(source("SearchPanel.tsx")).not.toContain("PROJECTION_UNREADY");
    expect(NO_READABLE_DATA).toBe("这段还没有可读数据。");
  });

  it("空态与两栏壳用既有组件，不发明第三套布局", () => {
    const box = source("BoxPanel.tsx");
    expect(box).toContain('from "./ui/ListDetail.tsx"');
    for (const name of ["BoxPanel.tsx", "SuggestionsPanel.tsx", "SearchPanel.tsx", "SleepPanel.tsx"]) {
      expect(source(name), name).toContain('from "./RecordList.tsx"');
    }
  });

  it("新页面不引入 styles.css 里没有的类名（布局词汇表是封闭的）", () => {
    const css = readFileSync(join(WEB, "styles.css"), "utf8");
    const declared = new Set([...css.matchAll(/\.([A-Za-z][\w-]*)/g)].map((match) => match[1]!));
    for (const name of UI4_VIEWS) {
      const text = source(name);
      const used = new Set<string>();
      // className 只有两种写法：静态串，或不含嵌套花括号的三元。两种都把字符串字面量里的词收走。
      for (const match of text.matchAll(/className=(?:"([^"]+)"|\{[^{}]*\})/g)) {
        const chunk = match[1] ?? match[0].slice(match[0].indexOf("{") + 1, match[0].lastIndexOf("}"));
        const literals = match[1] !== undefined ? [match[1]] : [...chunk.matchAll(/"([^"]*)"/g)].map((m) => m[1]!);
        for (const literal of literals) {
          for (const token of literal.split(/\s+/)) if (token !== "") used.add(token);
        }
      }
      expect(used.size, name).toBeGreaterThan(0);
      for (const token of used) {
        expect(declared.has(token), `${name} 用了未定义的类名 .${token}`).toBe(true);
      }
    }
  });
});

/* ── C. PENDING_VIEWS 消失 + 入口可达 + 收编不丢能力 ────────────── */

describe("App 接线：诚实空态名单整体消失，每页有真挂载", () => {
  const app = source("App.tsx");

  it("PENDING_VIEWS 与 PendingPage 都不再存在，未实现名单只剩图谱", () => {
    expect(app).not.toMatch(/\bPENDING_VIEWS\b/);
    expect(app).not.toMatch(/\bPendingPage\b/);
    const block = /const DEFERRED_VIEWS[\s\S]*?];/.exec(app)?.[0] ?? "";
    expect(block, "DEFERRED_VIEWS 名单本身要被断言到").not.toBe("");
    expect(block).toContain('"graph"');
    expect(block).not.toContain("suggestions");
    expect(block).not.toContain("emotions");
    expect(block).not.toContain("search");
  });

  it("七个 UI-4 页面都有真挂载：盒子五页按形状表挂，其余逐页挂", () => {
    expect(app).toContain("<BoxPanel");
    expect(app).toContain("boxShapeOf(view)");
    for (const tag of ["<SuggestionsPanel", "<SearchPanel", "<QuickPanel", "<SleepPanel", "<SettingsPanel"]) {
      expect(app, tag).toContain(tag);
    }
  });

  it("既有真数据页没有被顺手重写：三页仍各自挂自己的面板", () => {
    for (const tag of ["<TodayPanel", "<RecordsPanel", "<IngestPanel", "<DataPanel"]) {
      expect(app, tag).toContain(tag);
    }
  });

  it("设置页与数据管理同处 `data` 视图，返回件仍在", () => {
    const branch = /view === "data"[\s\S]*?<DataPanel \/>/.exec(app)?.[0] ?? "";
    expect(branch, "data 分支要被断言到").not.toBe("");
    expect(branch).toContain("<SettingsPanel");
    expect(branch).toContain("<DataPanel");
    expect(branch).toContain("← 返回更多");
  });

  it("「更多」给出解析与隐私的入口（原型那条线）", () => {
    expect(app).toContain("解析与隐私");
  });

  it("待确认徽章没有假计数：badges 只带真实取到的待整理数", () => {
    const badges = /badges=\{.*\}/.exec(app)?.[0] ?? "";
    expect(badges, "badges 表达式要被断言到").not.toBe("");
    expect(badges).toContain("ingest");
    expect(badges).not.toContain("suggestions");
  });
});

describe("收编：RecordsPanel 那两张卡删掉，能力落到新页面", () => {
  const records = source("RecordsPanel.tsx");

  it("页内「快速记录」卡与「搜索」卡已删除（卡片标题、输入件、提交函数都不在这一页了）", () => {
    expect(records).not.toMatch(/<h2>[^<]*快速记录[^<]*<\/h2>/);
    expect(records).not.toMatch(/<h2>[^<]*搜索[^<]*<\/h2>/);
    expect(records).not.toContain("<textarea");
    expect(records).not.toMatch(/\bapi\.createRecord\b/);
    expect(records).not.toMatch(/\bapi\.search\b/);
    expect(records).not.toContain("submitCapture");
    expect(records).not.toContain("submitSearch");
    expect(records).not.toContain("SearchHit");
  });

  it("这一页该留的还在：两栏壳、详情、存储清理横幅与重试", () => {
    expect(records).toContain('from "./ui/ListDetail.tsx"');
    expect(records).toContain("<RecordDetail");
    expect(records).toContain("api.maintenance()");
    expect(records).toContain("api.retryMaintenance()");
  });

  it("能力没丢：写落在 QuickPanel，查落在 SearchPanel", () => {
    expect(source("QuickPanel.tsx")).toContain("api.createRecord(");
    expect(source("SearchPanel.tsx")).toContain("api.search(");
    expect(source("SleepPanel.tsx")).toContain("api.createRecord(");
  });

  it("列表空态那句话改指向「写一条」，不再指着已经删掉的卡片", () => {
    expect(records).toContain("写一条");
    expect(records).not.toContain("用下面的快速记录");
  });
});

/* ── D. 睡前收尾与快速记录的硬约束 ─────────────────────────────── */

describe("quick / sleep / settings：模式写端点接通后的单选契约，睡前页不挽留", () => {
  // M3 断言「三页 radio 全 disabled」的前提是「还没有 mode 写端点」；M5-1 开了 POST 写通路，
  // 该前提只仍成立于 Sleep / Settings，对 Quick 失效。按新契约逐页改写，不削弱意图。
  const RADIO = /<input\s+type="radio"[\s\S]*?\/>/g;

  it("QuickPanel：模式单选来自共享 ProcessingModePicker，且已可点（解 disabled、带 checked/onChange）", () => {
    const text = source("QuickPanel.tsx");
    const picker = source("ui/ProcessingModePicker.tsx");
    expect(text).toContain("<ProcessingModePicker");
    expect(picker).toContain("processingModeChoices()");
    const radios = [...picker.matchAll(RADIO)];
    expect(radios.length, "QuickPanel 该有模式单选").toBeGreaterThan(0);
    for (const radio of radios) {
      expect(radio[0], "M5-1 已开写端点：radio 不得再 disabled").not.toContain("disabled");
      expect(radio[0], "可点就必须反映选中态").toContain("checked=");
      expect(radio[0], "可点就必须接 onChange").toContain("onChange=");
    }
  });

  it("QuickPanel：保存把所选模式真的写出去——api.createRecord(text, mode)", () => {
    expect(source("QuickPanel.tsx")).toMatch(/api\.createRecord\(\s*text\s*,\s*mode\s*\)/);
  });

  it("SleepPanel：与快速记录共用可选择模式，并把所选模式写入 createRecord", () => {
    const text = source("SleepPanel.tsx");
    const picker = source("ui/ProcessingModePicker.tsx");
    expect(text).toContain("<ProcessingModePicker");
    expect(text).toMatch(/api\.createRecord\(\s*text\s*,\s*mode\s*\)/);
    expect(picker).toContain("processingModeChoices()");
    const radios = [...picker.matchAll(RADIO)];
    expect(radios.length, "SleepPanel 该有模式单选").toBeGreaterThan(0);
    for (const radio of radios) {
      expect(radio[0], "两页共用后可点").not.toContain("disabled");
      expect(radio[0], "可点就必须反映选中态").toContain("checked=");
      expect(radio[0], "可点就必须接 onChange").toContain("onChange=");
    }
  });

  it("SettingsPanel：默认模式仍只读（配置即代码，不走界面写），radio 仍全部 disabled", () => {
    const text = source("SettingsPanel.tsx");
    expect(text).toContain("processingModeChoices()");
    const radios = [...text.matchAll(RADIO)];
    expect(radios.length, "SettingsPanel 该有默认模式单选").toBeGreaterThan(0);
    for (const radio of radios) {
      expect(radio[0], "默认模式没有写端点，不该能点").toContain("disabled");
    }
  });

  // 〔M5-2 契约变更·工作日志单列〕旧断言「quick 与 sleep 都不擅自发起整理」的前提是
  // QuickPanel 没有第二动作；M5-2 明确给 local 档加了「保存并整理」。按新契约拆成两条，
  // 除这一点外未放宽任何意图：SleepPanel 仍一字不变地不许碰整理，QuickPanel 仍不许碰
  // reparse / preview / confirm-send。
  it("M5-2 新契约：QuickPanel 的 local「保存并整理」会发起 api.ingestParse，但仍不碰 reparse/preview/confirm-send", () => {
    const text = source("QuickPanel.tsx");
    expect(text).toMatch(/\bapi\.ingestParse\b/);
    expect(text).not.toMatch(/\bapi\.ingest(Reparse|Preview|ConfirmSend)\b/);
  });

  it("SleepPanel 仍不擅自发起整理（没有 parse/reparse/preview/confirm-send 调用）", () => {
    expect(source("SleepPanel.tsx")).not.toMatch(/\bapi\.ingest(Parse|Reparse|Preview|ConfirmSend)\b/);
  });

  it("睡前收尾不显示待确认数量、不调待整理端点、不挽留", () => {
    const text = source("SleepPanel.tsx");
    expect(text).not.toContain("ingestPending");
    expect(text).not.toContain("pendingCount");
    expect(text).not.toContain("待确认");
    expect(text).toContain("收好并结束");
    // 〔M5-3B 有意变动·理由单列在工作日志〕旧钉的是「不检查任何队列」这句长说明；
    // 方案 §6.12 把它压成一句。语义等价：仍然直接可见「收好不检查没处理的条目、不催促」。
    expect(text).toContain("不会数你还有多少条没处理");
    expect(text).toContain("这些事情已经收好了。");
  });

  it("「今晚放进去的」只算本轮 POST 的回执，不把白天记的算进来", () => {
    const text = source("SleepPanel.tsx");
    expect(text).toMatch(/api\.createRecord\(\s*text\s*,\s*mode\s*\)/);
    expect(text).not.toMatch(/\bapi\.listRecords\b/);
  });

  it("设置页提供本地 / 云端两档模型配置，同时默认整理方式仍只读", () => {
    const text = source("SettingsPanel.tsx");
    expect(text).toContain("api.ingestConfig()");
    expect(text).toContain("api.updateModelConfig");
    expect(text).toContain("本地模型");
    expect(text).toContain("云端模型");
    expect(text).toContain("保存模型配置");
    expect(text).toContain("密钥环境变量名");
    expect(text).toContain("重启本地后端后生效");
    const radios = [...text.matchAll(RADIO)];
    expect(radios.length, "默认模式仍由配置文件决定").toBeGreaterThan(0);
    for (const radio of radios) {
      expect(radio[0]).toContain("disabled");
    }
  });
});
