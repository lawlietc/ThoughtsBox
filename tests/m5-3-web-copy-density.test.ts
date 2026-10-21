import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  BOX_SHAPES,
  COUNT_PLACEHOLDER,
  NO_SUGGESTION_ROWS,
  PROJECTION_UNREADY,
  SEARCH_LAYERS,
  SUGGESTION_ACTIONS,
  SUGGESTION_GAP,
  SUGGESTIONS_UNREADY,
} from "../src/web/projectionPort.ts";

/**
 * M5-3A · Web UI 文案降噪与信息分层（批次 A：基础设施 + 核心页面）。
 *
 * 钉的是方案的验收面（`docs/dev-specs/2026-10-18-M5-3-Web-UI文案降噪与信息分层方案.md` §九）：
 * - `DisclosureNote` 必须是原生 `details/summary`，默认关闭、不靠 hover；
 * - `styles.css` 声明了新增的四个类；
 * - QuickPanel 底部那段重复长解释已经消失；
 * - 云端闸门的**实际待发送文本（payloadText）仍在主可见区**，没有只藏进折叠区；
 * - 删除 / 恢复 / 缺授权 / 候选原样外发这些危险信息没有被折叠成默认不可见；
 * - 策略版本、指纹、sha256、枚举与时间戳等技术值只出现在「技术详情 / 说明」折叠段里。
 *
 * vitest 是 node 环境（没有 DOM），沿用本仓惯例做源码级断言：
 * 先把注释与折叠段（`<DisclosureNote>…</DisclosureNote>`、`<TechnicalDetails … />`）剥掉，
 * 剩下的就是「主界面直接可见」的文案与代码。注释是写给付费的开发者看的，不算主界面。
 */

const WEB = join(process.cwd(), "src", "web");

function source(rel: string): string {
  return readFileSync(join(WEB, rel), "utf8");
}

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** 页面上默认不可见的折叠段：DisclosureNote 整段 + 自闭合的 TechnicalDetails。 */
function foldedSegments(text: string): string[] {
  return [
    // 开标签单独成行（`<DisclosureNote\n  summary="…">`）也是合法 JSX，两种写法都要抠得出来。
    ...[...text.matchAll(/<DisclosureNote[\s\S]*?<\/DisclosureNote>/g)].map((m) => m[0]),
    ...[...text.matchAll(/<TechnicalDetails[\s\S]*?\/>/g)].map((m) => m[0]),
  ];
}

/** 主界面直接可见的那一份源码（注释与折叠段都已剥掉）。 */
function visibleCopy(rel: string): string {
  let text = stripComments(source(rel));
  for (const segment of foldedSegments(text)) text = text.replace(segment, "«折叠»");
  return text;
}

/** 折叠段里的那一份（用来证明技术值「收进去了」而不是「删掉了」）。 */
function foldedCopy(rel: string): string {
  const text = stripComments(source(rel));
  return foldedSegments(text).join("\n");
}

/** 全文（含注释）—— 批次 B 的「开发语言连注释一起清零」用它。 */
function fullText(rel: string): string {
  return source(rel);
}

/** 盒子形状里点名的缺口字段（拼接成一格，便于 toContain）。 */
function fields(view: string): string {
  return BOX_SHAPES.find((shape) => shape.view === view)!.gap.missing.join("|");
}

/** styles.css 声明的类名词表（封闭词汇表，两批共用）。 */
function declaredClasses(): Set<string> {
  const css = source("styles.css");
  return new Set([...css.matchAll(/\.([A-Za-z][\w-]*)/g)].map((match) => match[1]!));
}

/** 按 web-ui4 同款写法收集一份页面用到的 className 词，并逐个核已声明。 */
function checkClassNames(page: string, declared: Set<string>): void {
  const text = stripComments(source(page));
  const used = new Set<string>();
  for (const match of text.matchAll(/className=(?:"([^"]+)"|\{[^{}]*\})/g)) {
    const chunk = match[1] ?? match[0].slice(match[0].indexOf("{") + 1, match[0].lastIndexOf("}"));
    const literals = match[1] !== undefined ? [match[1]] : [...chunk.matchAll(/"([^"]*)"/g)].map((m) => m[1]!);
    for (const literal of literals) {
      for (const token of literal.split(/\s+/)) if (token !== "") used.add(token);
    }
  }
  expect(used.size, page).toBeGreaterThan(0);
  for (const token of used) {
    // candidate-review / candidate-term / candidate-disclosure 是 M3 闸门遗留类名，
    // 不在本批「只加最小必要样式」的授权范围内（web-ui4 的封闭检查不含 IngestPanel）。
    if (page === "IngestPanel.tsx" && token.startsWith("candidate-")) continue;
    expect(declared.has(token), `${page} 用了未定义的类名 .${token}`).toBe(true);
  }
}

/* ── A. 基础设施：DisclosureNote / TechnicalDetails / StatusLine ── */

describe("M5-3A · 折叠件基础设施", () => {
  const bits = source("ui/bits.tsx");
  const types = source("ui/types.ts");
  const css = source("styles.css");

  it("DisclosureNote 用原生 details/summary，默认关闭，props 里不含开关状态", () => {
    expect(bits).toMatch(/<details className="disclosure">/);
    expect(bits).toMatch(/<summary>\{props\.summary\}<\/summary>/);
    expect(types).toContain("DisclosureNoteProps");
    expect(types).toContain("TechnicalDetailsProps");
    expect(types).toContain("StatusLineProps");
    // 默认关闭：不允许出现 open 属性；组件不许自带 useState。
    expect(bits).not.toMatch(/<details[^>]*\sopen[=\s>]/);
    const disclosureBlock = /export function DisclosureNote[\s\S]*?\n}/.exec(bits)?.[0] ?? "";
    expect(disclosureBlock).not.toBe("");
    expect(disclosureBlock).not.toContain("useState");
  });

  it("styles.css 声明了四个新类，且折叠不靠 hover 显隐", () => {
    for (const cls of [".disclosure", ".disclosure-body", ".status-line"]) {
      expect(css, `缺少 ${cls}`).toContain(cls);
    }
    expect(css).toMatch(/\.disclosure\s*>\s*summary\s*\{/);
    const summaryRule = /\.disclosure > summary \{[^}]*\}/.exec(css)?.[0] ?? "";
    expect(summaryRule).toContain("cursor: pointer");
    expect(css).not.toMatch(/\.disclosure[^{]*:hover/);
  });

  it("StatusLine 复用现有 warn 视觉，但保持单行语义", () => {
    expect(bits).toMatch(/export function StatusLine/);
    expect(bits).toMatch(/status-line warn/);
  });
});

/* ── B. QuickPanel：短标签 + 单条行动说明，长解释退场 ───────────── --> */

describe("M5-3A · QuickPanel", () => {
  const quick = visibleCopy("QuickPanel.tsx");

  it("底部重复的长 Prose 解释已删除，Prose 不再被引用", () => {
    expect(quick).not.toContain("<Prose");
    expect(quick).not.toContain("存完就停在这");
    expect(quick).not.toContain("先把原文存进本机，再谈别的");
    expect(quick).not.toContain("会送云端脱敏版：");
    expect(quick).not.toContain("内容不出本机：保存后进「待整理」；也可以在这里直接「保存并整理」。");
  });

  it("三种模式收进一行折叠说明，主层不再渲染长行动解释", () => {
    const picker = visibleCopy("ui/ProcessingModePicker.tsx");
    expect(quick).toContain("<ProcessingModePicker");
    expect(picker).toContain("整理方式：");
    expect(picker).toContain("<details className=\"quick-mode\">");
    expect(picker).toContain("只保存在本机");
    expect(picker).toContain("先保存，需要时在本机整理");
    expect(picker).toContain("保存后去确认发送");
    expect(quick).not.toContain("MODE_ACTION_NOTE");
  });

  it("行为语义原样保留：先保存原文、本机模型、不自动发送、逐次确认", () => {
    expect(quick).toContain("quickSecondActionFor(mode)");
    expect(quick).toContain('busy === "save" ? "保存中…"');
    expect(quick).toContain("api.ingestParse");
    expect(quick).not.toMatch(/\bapi\.ingest(Reparse|Preview|ConfirmSend)\b/);
  });
});

/* ── C. IngestPanel + 云端闸门：降噪但不降授权语义 ───────────── */

describe("M5-3A · IngestPanel 主可见区", () => {
  const ingest = visibleCopy("IngestPanel.tsx");

  it("待整理引导压成一句，「为什么不在这里」缩成一行且不再列清单", () => {
    expect(ingest).toContain("待发送、待重跑和整理失败的记录都在这里。");
    expect(ingest).toContain("只保存的记录不会进入待整理。");
    expect(ingest).not.toContain("为什么不在这里");
    expect(ingest).not.toContain("最近");
  });

  it("配置行退出主界面：Provider 字样与七行清单不再直接可见", () => {
    expect(ingest).not.toContain("当前模型与隐私模式");
    expect(ingest).not.toContain("Provider：");
    expect(ingest).not.toContain("ParseRun");
    expect(ingest).not.toContain("命中幂等重放");
    expect(ingest).not.toContain("provisional");
  });

  it("状态行进主界面：解析与云端通道各一句", () => {
    expect(ingest).toContain("解析就绪");
    expect(ingest).toContain("解析未就绪");
    expect(ingest).toContain("云端通道可用");
    expect(ingest).toContain("云端通道未开启");
  });
});

describe("M5-3A · 云端发送闸门（最需要谨慎降噪的地方）", () => {
  const ingest = visibleCopy("IngestPanel.tsx");
  const folded = foldedCopy("IngestPanel.tsx");

  it("实际待发送文本仍然直接渲染在主可见区，没有只藏进折叠区", () => {
    expect(ingest).toContain("<pre className=\"record-text\">{preview.payloadText}</pre>");
    expect(ingest).toContain("这才是");
    expect(ingest).toContain("实际发出去的文本");
    expect(folded).not.toContain("payloadText");
  });

  it("候选风险、脱敏不等于匿名化、授权状态与确认/取消按钮全部保持直接可见", () => {
    expect(ingest).toContain("原样发出去");
    expect(ingest).toContain("跳过 = 不遮 = 风险自负");
    expect(ingest).toContain("脱敏");
    expect(ingest).toContain("匿名化");
    expect(ingest).toContain("确认本次发送内容");
    expect(ingest).toContain("确认，就按这份内容发送");
    expect(ingest).toContain("再想想");
    expect(ingest).toContain("这份发送内容已确认过");
    expect(ingest).toContain("这份发送内容还没有确认");
    expect(ingest).toContain("改动原文后，这条授权立即失效");
    expect(ingest).toContain("缺本次发送授权");
  });

  it("策略版本、载荷指纹、授权时间进技术详情，不再占主界面", () => {
    expect(ingest).not.toContain("policyVersion");
    expect(ingest).not.toContain("payloadSha256");
    expect(ingest).not.toContain("confirmedAtUtc");
    expect(folded).toContain("策略版本");
    expect(folded).toContain("内容指纹");
    expect(folded).toContain("payloadSha256");
  });
});

/* ── D. RecordDetail：元信息分层，删除确认不折叠 ─────────────── */

describe("M5-3A · RecordDetail", () => {
  const detail = visibleCopy("RecordDetail.tsx");
  const folded = foldedCopy("RecordDetail.tsx");

  it("主元信息不再显示记录 id、时区 id、sha256 与内部枚举", () => {
    expect(detail).not.toContain("（{record.timezone_id}）");
    expect(detail).not.toContain("{record.id} ·");
    expect(detail).not.toContain("· sha256");
    expect(detail).not.toContain('["结果态"');
    expect(detail).not.toContain("起于 {run.startedAtUtc}");
  });

  it("这些技术值改在「技术详情」里，可访问而不是消失", () => {
    expect(folded).toContain("记录编号");
    expect(folded).toContain("record.timezone_id");
    expect(folded).toContain("content_sha256");
    expect(folded).toContain("run.resultState");
    expect(folded).toContain("run.startedAtUtc");
  });

  it("开发说明（ADR / PROJ）整页退场", () => {
    expect(detail).not.toMatch(/ADR-\d+/);
    expect(detail).not.toMatch(/PROJ-\d/);
    expect(folded).not.toMatch(/ADR-\d+/);
  });

  it("删除确认的不可逆风险与全部历史版本说明继续直接可见", () => {
    expect(detail).toContain("全部历史版本");
    expect(detail).toContain("无法从当前界面撤销");
    expect(detail).toContain("旧备份中可能仍存在这些内容");
    expect(detail).toContain("确认删除");
  });

  it("真实失败路径继续可见：证据点不回当前版本、整理失败原文完好", () => {
    expect(detail).toContain("这一条证据点不回当前版本");
    expect(detail).toContain("原文完好无损");
    expect(detail).toContain("等待你表态");
  });

  it("「改原文不会自动重新整理」只剩方案推荐的行动句", () => {
    expect(detail).toContain("改原文");
    expect(detail).toContain("不会");
    expect(detail).toContain("原文已改，待重新整理");
    expect(detail).not.toContain("旧结果也不算过期");
  });
});

/* ── E. SettingsPanel / DataPanel ─────────────────────────────── */

describe("M5-3A · SettingsPanel", () => {
  const settings = visibleCopy("SettingsPanel.tsx");
  const folded = foldedCopy("SettingsPanel.tsx");

  it("重复的云端确认卡片与「本机装配实况」卡片退出主界面", () => {
    expect(settings).not.toContain("发送前你会看到什么");
    expect(settings).not.toContain("本机装配实况");
    expect(folded).toContain("调用通道");
    expect(folded).toContain("请求超时");
  });

  it("关键隐私事实保留：逐次确认、不做默认勾选、没点头按原话发", () => {
    expect(settings).toContain("首次发送前");
    expect(settings).toContain("不做默认勾选");
    expect(settings).toContain("按原话发出去");
    expect(settings).toContain("一律换成占位符");
  });

  it("三种模式只剩短标签；当前默认单独显示且用用户语言", () => {
    expect(settings).toContain("完全不送出去。");
    expect(settings).toContain("内容不出本机，整理慢一些。");
    expect(settings).toContain("当前默认：");
    expect(settings).not.toContain("当前生效：{config.defaultMode}");
  });

  it("对照表只在折叠说明里，主界面不再解释代号类型机理", () => {
    expect(settings).not.toContain("这张对照表<strong>不会</strong>发出去");
    expect(folded).toContain("对照表");
  });
});

describe("M5-3A · DataPanel", () => {
  const data = visibleCopy("DataPanel.tsx");
  const folded = foldedCopy("DataPanel.tsx");

  it("恢复的全部风险、整体替换、安全快照与确认勾选继续直接可见（不许折叠）", () => {
    expect(data).toContain("整体替换");
    expect(data).toContain("恢复前安全快照");
    expect(data).toContain('type="checkbox"');
    expect(data).toContain("我已了解上述影响，确认用");
    expect(data).toContain("恢复旧备份可能重新引入此前删除的内容");
    expect(data).toContain("备份不自动上传到第三方服务");
    expect(data).toContain("V0 不提供应用层备份加密");
    expect(data).toContain("删除当前记录不自动修改旧备份");
  });

  it("导出/导入缩成一句，隐私清理保留核心承诺，细节才折叠", () => {
    expect(data).toContain("导出全部记录与版本历史（NDJSON），文件只保存在本机。");
    expect(data).toContain("仅支持导入空数据库");
    expect(data).toContain("清理是尽力而为，不保证物理副本绝对不可恢复。");
    expect(data).toContain("数据只在本机：服务仅监听 127.0.0.1");
    expect(folded).toContain("删除审计与运行期维护任务不随导出迁移");
    expect(folded).toContain("SSD 磨损均衡");
  });

  it("导入失败的逐行清单继续可见，主界面不再有 §九 这类开发引用", () => {
    expect(data).toContain("导入被拒绝，未写入任何数据");
    expect(data).not.toMatch(/§[四九]|\bM1a\b/);
  });
});

/* ── F. 全站口径：批次 A 页面主界面不得出现工程黑话 ────────────── */

describe("M5-3A · 主界面纯度（批次 A 五页）", () => {
  const pages = ["QuickPanel.tsx", "IngestPanel.tsx", "RecordDetail.tsx", "SettingsPanel.tsx", "DataPanel.tsx"];

  it("五个核心页面直接可见的部分不含方案点名的开发语言", () => {
    for (const page of pages) {
      const visible = visibleCopy(page);
      for (const banned of ["ParseRun", "policy fingerprint", "这一页还缺什么", "§九", "§4.1"]) {
        expect(visible, `${page} 主界面出现了「${banned}」`).not.toContain(banned);
      }
      expect(visible, `${page} 主界面出现了 ADR 引用`).not.toMatch(/ADR-\d/);
      expect(visible, `${page} 主界面出现了 PROJ 引用`).not.toMatch(/PROJ-\d/);
    }
  });

  it("类名词汇表继续封闭：批次 A 页面只用 styles.css 已声明的类", () => {
    const declared = declaredClasses();
    for (const page of [...pages, "ui/bits.tsx"]) {
      checkClassNames(page, declared);
    }
  });
});

/* ══════════════════════════════════════════════════════════════════
 * 批次 B（M5-3B）：次级页面 + 全站收口。
 * 方案 §6.8–§6.13 的验收面：缺口卡 / 字段清单 / 实现理由退出主界面，
 * 数据契约（BOX_SHAPES 的 gap、SEARCH_LAYERS、SUGGESTION_GAP）继续留给
 * 数据源与测试；诚实空态、真实错误、无计数 / 无挽留语义一条不许丢。
 * ══════════════════════════════════════════════════════════════════ */

describe("M5-3B · BoxPanel：缺口卡与规格语言退出主界面", () => {
  const box = visibleCopy("BoxPanel.tsx");

  it("主界面没有「这一页还缺什么」卡、字段清单与详情区规格语言", () => {
    expect(box).not.toContain("这一页还缺什么");
    expect(box).not.toContain("还缺什么");
    expect(box).not.toMatch(/shape\.gap|gap\.missing|\.checklist/);
    expect(box).not.toContain("detailNote");
    expect(box).not.toContain("点一条之后要显示的是");
  });

  it("真实空态与诚实出处仍在：NO_READABLE_DATA + 数据口给不出时一句 PROJECTION_UNREADY", () => {
    expect(box).toContain("NO_READABLE_DATA");
    expect(box).toContain("content === null && <StatusLine>{PROJECTION_UNREADY}</StatusLine>");
    expect(box).toContain("emptyText={shape.emptyHint}");
  });

  it("仍复用 ListDetail / RecordList 这一套布局，没有发明新壳", () => {
    expect(box).toContain('from "./ui/ListDetail.tsx"');
    expect(box).toContain("<RecordList");
    expect(box).toContain("COUNT_PLACEHOLDER");
  });
});

describe("M5-3B · projectionPort 数据契约未变，只有界面措辞缩短", () => {
  it("五页的 gap.missing / gap.slots / counts / groups 全部原样保留（测试与诚实空态还要用）", () => {
    expect(BOX_SHAPES).toHaveLength(5);
    for (const shape of BOX_SHAPES) {
      expect(shape.gap.missing.length, shape.view).toBeGreaterThan(0);
      expect(shape.gap.slots.length, shape.view).toBeGreaterThan(0);
      expect(shape.counts.length, shape.view).toBeGreaterThanOrEqual(3);
      expect(shape.groups.length, shape.view).toBeGreaterThanOrEqual(2);
      for (const group of shape.groups) {
        expect(group.note, `${shape.view} 分组 note 不许为空`).not.toBe("");
        expect(group.heading, shape.view).not.toBe("");
      }
    }
    expect(fields("emotions")).toContain("labelSaid");
    expect(fields("emotions")).toContain("basis");
    expect(fields("episodes")).toContain("event_time_raw");
    expect(fields("thoughts")).toContain("text");
    expect(fields("entities")).toContain("displayName");
    expect(fields("topics")).toContain("conceptType");
  });

  it("搜索层与待确认缺口的枚举数据未动；detailNote 字段随渲染一起移除（无消费方）", () => {
    expect(SEARCH_LAYERS.map((layer) => layer.key)).toEqual(["all", "records", "derived", "tags", "entities"]);
    expect(SEARCH_LAYERS.filter((layer) => layer.ready).map((layer) => layer.key)).toEqual(["all", "records"]);
    for (const layer of SEARCH_LAYERS.filter((entry) => !entry.ready)) {
      expect(layer.missing.length, layer.key).toBeGreaterThan(0);
    }
    expect(SUGGESTION_GAP.missing).toEqual(["kind", "subjectTerm", "status", "displayNote", "evidence"]);
    expect(SUGGESTION_ACTIONS).toEqual(["采纳", "忽略", "撤回（依据没了）"]);
    expect(source("projectionPort.ts")).not.toContain("detailNote");
    expect(PROJECTION_UNREADY).toBe("这一页的数据投影还没就绪。");
  });

  it("lede 收短到一句话，note 缩短但不为空；开发黑话连注释一起清零", () => {
    for (const shape of BOX_SHAPES) {
      expect(shape.lede.length, `${shape.view} lede 超预算`).toBeLessThanOrEqual(30);
      expect(shape.lede, shape.view).not.toBe("");
    }
    const port = source("projectionPort.ts");
    expect(port).not.toMatch(/ADR-\d/);
    expect(port).not.toContain("about 边");
    expect(port).not.toContain("天花板");
    expect(port).not.toContain("凑数");
  });
});

describe("M5-3B · SearchPanel：只渲染现在真正可用的原文层", () => {
  const search = visibleCopy("SearchPanel.tsx");

  it("筛选条只列 ready 层；未就绪层、字段清单与「不猜」实现说明退出页面", () => {
    expect(search).toContain('SEARCH_LAYERS.filter((layer) => layer.ready)');
    expect(search).not.toMatch(/!layer\.ready/);
    expect(search).not.toContain("PROJECTION_UNREADY");
    expect(search).not.toContain("COUNT_PLACEHOLDER");
    expect(search).not.toMatch(/\.checklist|layer\.missing/);
    expect(search).not.toContain("不猜");
    expect(search).not.toContain("搜索要走后端");
    expect(search).not.toContain("<Prose");
  });

  it("输入前 / 无结果各一句产品语言", () => {
    expect(search).toContain("输入一个词，搜索你写过的内容。");
    expect(search).toContain("换个说法试试");
    expect(search).not.toContain("还没接上投影");
  });

  it("api.search、真实错误与 VERBATIM 钉死的空态一字不丢", () => {
    expect(search).toContain("api.search(term)");
    expect(search).toContain("cause instanceof ApiError ? cause.detail");
    expect(search).toContain('emptyText="没有匹配的记录。"');
    expect(search).toContain('from "./RecordList.tsx"');
  });
});

describe("M5-3B · SuggestionsPanel：状态语义压成一句，缺口卡删除", () => {
  const sugg = visibleCopy("SuggestionsPanel.tsx");

  it("没有「这一页还缺什么」卡、SUGGESTION_GAP 清单与端点解释", () => {
    expect(sugg).not.toContain("还缺什么");
    expect(sugg).not.toMatch(/SUGGESTION_GAP|SUGGESTION_ACTIONS|\.checklist/);
    expect(sugg).not.toContain("端点");
  });

  // 〔M5-3C 有意变动·理由单列在工作日志〕旧断言钉的是「空态逐字引用 NO_READABLE_DATA +
  // PROJECTION_UNREADY 这两个常量」。拼出来的那句讲的是投影，不是建议 —— 属于方案 C 层。
  // 等价语义：空态仍是一句 import 的用户语言（一对新常量），出处由 web-ui7 钉两边共用同一对。
  it("状态语义一句话保留；空态是一句 import 的用户语言，不再拼两个投影常量", () => {
    expect(sugg).toContain("忽略不会删除；采纳和撤回是终态。");
    expect(sugg).toContain("emptyText={content === null ? SUGGESTIONS_UNREADY : NO_SUGGESTION_ROWS}");
    expect(sugg).not.toContain("NO_READABLE_DATA");
    expect(sugg).not.toContain("PROJECTION_UNREADY");
  });

  it("没有动作就不摆假按钮：本页不渲染任何表态按钮，筛选条与真实计数位仍在", () => {
    expect(sugg).not.toMatch(/<button[^>]*>[^<]*采纳/);
    expect(sugg).not.toMatch(/<button[^>]*>[^<]*撤回/);
    expect(sugg).toContain("suggestionFilters()");
    expect(sugg).toContain("content?.total ?? COUNT_PLACEHOLDER");
  });

  it("徽章裁定仍在：这一页不拿占位符装计数（0 与「不知道」不能长一样）", () => {
    expect(sugg).toContain("COUNT_PLACEHOLDER");
  });
});

describe("M5-3B · TodayPanel：引导一句、工程段删除", () => {
  const today = source("TodayPanel.tsx");

  it("全文没有 PROJ 引用与可读投影缺口说明", () => {
    expect(today).not.toMatch(/PROJ-\d/);
    expect(today).not.toContain("还给不出");
    expect(today).not.toContain("凑数");
    expect(today).not.toContain("NO_READABLE_DATA");
  });

  // 〔M5-4P 有意变动 · 理由单列在 worklogs/2026-10-19-M5-4P-today-visual-pilot.md〕
  // 这一页的版式重排了：三张等重力的卡换成「一句问候 + 一个主行动 + 一条时间线」。
  // 原来钉的三件事一件没丢，只是换到新措辞上 ——
  //   引导仍只有一句、今天的计数仍在、三个次级入口仍在、空态仍然只出现一次。
  it("顶部不再带产品引导；今天计数与必要入口保留；空态只留一句", () => {
    const visible = visibleCopy("TodayPanel.tsx");
    expect(visible).not.toContain("不必想清楚");
    expect(visible).toContain("todays.length");
    expect(visible).toContain("今天的片段");
    for (const entry of ['onNavigate("records")', 'onNavigate("ingest")']) {
      expect(visible, entry).toContain(entry);
    }
    expect(visible).not.toContain('onNavigate("suggestions")');
    expect(visible).toContain("今天还没有留下片段。");
    // 空态只说一次：旧版在列表空态和「今天的东西」卡里各说了一遍。
    expect([...visible.matchAll(/今天还没有/g)]).toHaveLength(1);
    expect(today).not.toContain("emptyText");
  });
});

describe("M5-3B · SleepPanel：实现理由退场，安静语义保留", () => {
  const sleep = source("SleepPanel.tsx");

  it("「模式没接上写端点」的实现理由与内部字段名从整页消失", () => {
    expect(sleep).not.toContain("端点");
    expect(sleep).not.toContain("processing_mode");
    expect(sleep).not.toContain("缺省值落库");
  });

  it("模式区改成一句产品语言；收好动作继续无计数、不检查、不挽留", () => {
    const visible = visibleCopy("SleepPanel.tsx");
    expect(visible).toContain("这里只负责保存；只有选了本机整理或云端发送，才会进入「待整理」。");
    expect(visible).toContain("<ProcessingModePicker");
    expect(visible).toContain("这里不会数你还有多少条没处理，也不挽留。");
    expect(visible).toContain("收好并结束");
    expect(visible).not.toContain("ingestPending");
    expect(visible).not.toContain("pendingCount");
    expect(visible).not.toMatch(/\bapi\.ingest(Parse|Reparse|Preview|ConfirmSend)\b/);
  });
});

describe("M5-3B · App/MorePage：技术信息进折叠，入口与返回件不动", () => {
  const app = visibleCopy("App.tsx");
  const folded = foldedCopy("App.tsx");

  it("信息架构说明删除；设置与数据收成一个入口，返回件仍在", () => {
    expect(app).not.toContain("两个入口落在同一页");
    expect(app).toContain("解析与隐私");
    expect(app).toContain("设置与数据管理");
    expect(app).toContain("← 返回更多");
  });

  it("schema / SQLite / 数据目录移到设置页底的「技术详情」折叠段里", () => {
    for (const token of ["schemaVersion", "sqliteVersion", "dataDir", "SQLite"]) {
      expect(app, `主界面直接可见处出现了「${token}」`).not.toContain(token);
    }
    expect(app).toContain("<SettingsPanel health={health}>");
    const settingsFolded = foldedCopy("SettingsPanel.tsx");
    expect(settingsFolded).toContain("schemaVersion");
    expect(settingsFolded).toContain("sqliteVersion");
    expect(settingsFolded).toContain("dataDir");
    expect(source("SettingsPanel.tsx")).toContain('<DisclosureNote summary="技术详情">');
  });

  it("关于只留一句产品承诺；后端不可达的真实警示继续可见", () => {
    expect(app).toContain("记录不会离开这台电脑，除非你在某一条上明确同意发送。");
    expect(app).toContain("本地后端不可达。请先启动 npm run start:server（仅监听 127.0.0.1）。");
  });
});

describe("M5-3B · SettingsPanel：只读的原因从 title 变成可见说明", () => {
  const settings = visibleCopy("SettingsPanel.tsx");

  it("默认模式为何只读，直接可见而不是 hover-only", () => {
    expect(settings).toContain("默认模式由服务端的配置文件决定；这里只显示，不改。");
  });

  it("「写服务端的配置」的语义仍在这页的出处里；radio 仍全部 disabled", () => {
    expect(source("SettingsPanel.tsx")).toContain("写服务端的配置");
    const radios = [...source("SettingsPanel.tsx").matchAll(/<input\s+type="radio"[\s\S]*?\/>/g)];
    expect(radios.length).toBeGreaterThan(0);
    for (const radio of radios) {
      expect(radio[0], "默认模式仍然不该能点").toContain("disabled");
    }
  });
});

describe("M5-3B · IngestPanel：未取预览只剩一条状态说明", () => {
  const gate = visibleCopy("IngestPanel.tsx");

  it("未预览区不再重复两句：保留状态行，删掉「不发请求、不写任何数据」的 paraphrase", () => {
    expect(gate).toContain("先在本机查看实际发送文本；这一步不会发送。");
    expect(gate).not.toContain("不发请求、不写任何数据");
    expect(gate).toContain("查看实际待发送文本");
  });

  it("批次 A 钉死的授权语义不受影响：payloadText 仍在主可见区", () => {
    expect(gate).toContain("<pre className=\"record-text\">{preview.payloadText}</pre>");
    expect(gate).toContain("原样发出去");
    expect(gate).toContain("脱敏");
    expect(gate).toContain("匿名化");
  });
});

describe("M5-3B · 次级页面全站收口：开发语言清零与类名封闭", () => {
  const bPages = [
    "projectionPort.ts",
    "BoxPanel.tsx",
    "SearchPanel.tsx",
    "SuggestionsPanel.tsx",
    "TodayPanel.tsx",
    "SleepPanel.tsx",
  ];

  it("次级六份文件全文（含注释）不再出现缺口卡 / 端点解释 / ADR / PROJ 引用", () => {
    for (const page of bPages) {
      const text = fullText(page);
      expect(text, `${page} 还留着「还缺什么」`).not.toContain("还缺什么");
      expect(text, `${page} 还留着「端点」解释`).not.toContain("端点");
      expect(text, `${page} 出现了 ADR 引用`).not.toMatch(/ADR-\d/);
      expect(text, `${page} 出现了 PROJ 引用`).not.toMatch(/PROJ-\d/);
    }
  });

  it("批次 B 页面（含 App.tsx）的类名继续封闭在 styles.css 词汇表里", () => {
    const declared = declaredClasses();
    for (const page of ["BoxPanel.tsx", "SearchPanel.tsx", "SuggestionsPanel.tsx", "TodayPanel.tsx", "SleepPanel.tsx", "App.tsx"]) {
      checkClassNames(page, declared);
    }
  });
});

/* ══════════════════════════════════════════════════════════════════
 * M5-3C：390 / 1440 真实渲染后的三处收口（方案 §6.8 / §6.10 / §十一-6）。
 * 1. 工程缺口行整条退出盒子投影 —— 「这一组数不出来」那一句是给开发者的。
 * 2. 空态按页合并：未就绪只剩一句状态、整页无行只剩一句空态，分组只在真有行时出现。
 * 3. 「人物与事物」的 lede 不再声称只有两个身份状态（那一页实际有三个）。
 * ══════════════════════════════════════════════════════════════════ */

describe("M5-3C · 缺口行退出盒子投影", () => {
  const projections = stripComments(source("projections.ts"));

  it("unanswerableGroupRow 连同它的调用点一起删除", () => {
    expect(projections).not.toContain("unanswerableGroupRow");
    // 「词表里但从未出现」这一组在没有全词表清单时就是空行，不摆技术缺口。
    expect(projections).toMatch(/heading: groups\(1\), rows: \[\]/);
  });

  it("投影的字符串字面量里没有方案 C 层那句工程说明", () => {
    for (const banned of ["这一组数不出来", "数不出来", "服务端没有", "端点", "全量清单", "撒谎"]) {
      expect(projections, `projections.ts 的用户可见文案里出现了「${banned}」`).not.toContain(banned);
    }
  });

  it("BoxPanel 用户可见路径同样不转述工程缺口", () => {
    const box = visibleCopy("BoxPanel.tsx");
    for (const banned of ["这一组数不出来", "数不出来", "服务端没有", "端点", "全量清单"]) {
      expect(box, `BoxPanel 主界面出现了「${banned}」`).not.toContain(banned);
    }
  });

  it("答不出来的计数位仍然是占位符，没有被改成 0", () => {
    const shape = BOX_SHAPES.find((entry) => entry.view === "emotions")!;
    // 计数位的措辞仍在形状表里，值那一格由投影填 COUNT_PLACEHOLDER（数据断言见 m3-proj-1）。
    expect(shape.counts[1]).toBe("词表里但从未出现");
    expect(source("projections.ts")).toMatch(
      /counts:\s*\[\s*String\(seen\.length\),\s*COUNT_PLACEHOLDER,/,
    );
  });
});

describe("M5-3C · BoxPanel 空态按页合并，不逐组重复", () => {
  const box = visibleCopy("BoxPanel.tsx");

  it("三态各自只有一句：未就绪 → 状态行；整页无行 → 本页空态；真有行 → 才摆分组", () => {
    expect(box).toContain("content === null && <StatusLine>{PROJECTION_UNREADY}</StatusLine>");
    expect(box).toContain(
      'content !== null && allRows.length === 0 && <p className="hint">{shape.emptyHint}</p>',
    );
    expect(box).toMatch(/content !== null &&\s*allRows\.length > 0 &&\s*shape\.groups\.map/);
  });

  it("分组表头与 note 只在守卫之后渲染：全页只有一处 groups.map，且它前面就是守卫", () => {
    expect([...box.matchAll(/shape\.groups\.map/g)]).toHaveLength(1);
    const at = box.indexOf("shape.groups.map");
    const before = box.slice(Math.max(0, at - 120), at);
    expect(before).toContain("content !== null");
    expect(before).toContain("allRows.length > 0");
  });

  it("`shape.emptyHint` 在这一页只出现两次：整页那一句 + 分组列表自己的空态", () => {
    expect([...box.matchAll(/shape\.emptyHint/g)]).toHaveLength(2);
  });

  it("计数位、两栏壳与详情空态没有被这次收口动掉", () => {
    expect(box).toContain('from "./ui/ListDetail.tsx"');
    expect(foldedCopy("BoxPanel.tsx")).toContain("props.content.counts[index] ?? COUNT_PLACEHOLDER");
    expect(source("BoxPanel.tsx")).toContain('<DisclosureNote summary="数量与分组说明">');
    expect(box).toContain('<p className="hint">{NO_READABLE_DATA}</p>');
  });
});

describe("M5-3C · 待确认页空态改说用户语言", () => {
  it("两句常量本身就是用户语言：不提投影、不提数据口、一句话说完", () => {
    for (const text of [SUGGESTIONS_UNREADY, NO_SUGGESTION_ROWS]) {
      expect(text.length, text).toBeLessThanOrEqual(30);
      for (const banned of ["投影", "端点", "服务端", "缺口", "数据口"]) {
        expect(text, `「${text}」还带着「${banned}」`).not.toContain(banned);
      }
    }
    expect(SUGGESTIONS_UNREADY).toBe("建议数据还没准备好，暂时无法显示。");
    expect(NO_SUGGESTION_ROWS).toBe("还没有待确认的建议。");
  });

  it("筛选条、计数占位与真实详情都不受这次收口影响", () => {
    const sugg = visibleCopy("SuggestionsPanel.tsx");
    expect(sugg).toContain("suggestionFilters()");
    expect(sugg).toContain("content?.total ?? COUNT_PLACEHOLDER");
    expect(sugg).toContain("content?.counts[entry.key] ?? COUNT_PLACEHOLDER");
    expect(sugg).toContain("<BoxRowDetail");
    expect(sugg).toContain('heading="建议详情"');
  });
});

describe("M5-3C · 「人物与事物」的 lede 与页面真实状态数一致", () => {
  const entities = BOX_SHAPES.find((shape) => shape.view === "entities")!;

  it("lede 不再声称只有两个身份状态", () => {
    expect(entities.lede).toBe("提到过的人与事物，按身份状态分开看。");
    expect(entities.lede).not.toContain("两个");
    expect(entities.lede.length).toBeLessThanOrEqual(30);
  });

  it("那一页确实按状态分开：三档生命周期 + 候选，分组比状态数还多", () => {
    expect(entities.groups.length).toBeGreaterThanOrEqual(3);
    expect(entities.counts.length).toBeGreaterThanOrEqual(3);
    for (const state of ["已转正", "待转正", "已归档"]) {
      expect(entities.counts.join("|"), `计数位里没有「${state}」`).toContain(state);
    }
  });

  it("其余四页的 lede 仍然一句、且不新造说法", () => {
    for (const shape of BOX_SHAPES) {
      expect(shape.lede, shape.view).not.toContain("两个身份状态");
      expect(shape.lede.length, `${shape.view} lede 超预算`).toBeLessThanOrEqual(30);
    }
  });
});
