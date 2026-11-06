/**
 * M9-8 专项测试：把「本机检查要等多久」讲清楚（只改前端文案与等待显示）。
 *
 * 为什么值得单独一批：本地模型档下「查看实际待发送文本」要服务端问一次本机模型，实测 9 s 到
 * 264 s。那段时间界面只有三个字「处理中…」。而事实是那条调用**没有 caller signal** —— 关掉页面
 * 它照样跑完并把结果落进 `app_meta`，回来再点一次若已跑成就是秒出。界面一句都没说。
 *
 * 本批钉的六件事，全是「说出来」而不是「改流程」：
 *  - **W1/W2** 等待中那句文案本体（含已等秒数）与秒数的算法（向下取整、不为负、时钟回拨算 0）。
 *  - **W3** `llmUnusedNoticeText` 六格全表：只有 `timeout` 那格点名两种可能（记录太长 / 服务卡住），
 *    其余五格与「原因未登记」「只有标题」两路逐字不变。
 *  - **W4** 静态扫：每一处 `api.ingestPreview(` 之前都按下起点、收口只在一个 `finally` 里、
 *    定时器成对出现（漏一处就会出现「界面写着正在检查，其实早停了」）。
 *  - **W5** 禁区还在：整个 `src/web` 不接 `AbortSignal`，`IngestPanel.tsx` 不自己判断回环。
 *
 * M9-8b 补的两处收尾（都是「说的不是事实」，不是流程问题）：
 *  - **W6** `checkingLlm` 必须看档位：`manual` 档那条预览服务端根本不问模型，界面却会闪一句
 *    「本机正在检查这段文字」——那是谎报，与 `llmLayer.used` 那条同源。
 *  - **W7** 「可以再点一次「重新取一份」」与那颗早已改口的按钮不同名，两处手写必然漂移；
 *    现在那句话读 `LLM_PREVIEW_RETRY_LABEL` 拼出来。
 *
 * vitest 的 environment 是 node（没有 DOM），沿用本仓惯例做源码级断言；判据与文案本体走纯函数直接调用。
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  LLM_PREVIEW_RETRY_LABEL,
  LLM_UNUSED_HEADLINE,
  elapsedSecondsSince,
  llmCheckingText,
  llmUnusedNoticeText,
} from "../src/web/redactionTier.ts";
import { LLM_FAILURE_KIND_DTO_VALUES } from "../src/shared/dto.ts";

const WEB = join(process.cwd(), "src", "web");

function source(rel: string): string {
  return readFileSync(join(WEB, rel), "utf8");
}

/**
 * 剥掉注释但**保持行号**（`//` 与 `/* *\/` 都只清空、不删行）：
 * W4 配对的是真实调用，注释里提到 `api.ingestPreview(` 不算按下起点。
 */
function stripCommentsKeepingLines(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, (m) => "\n".repeat(m.split("\n").length - 1)).replace(/^[ \t]*\/\/.*$/gm, "");
}

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(path));
    else out.push(path);
  }
  return out.sort();
}

/* ── W1 等待中那句文案 ──────────────────────────────────────────── */

describe("W1 —— llmCheckingText 说的是「要等多久」和「走开之后结果还在」", () => {
  it("刚开始等（seconds <= 0）：不带秒数，其余逐字不变", () => {
    expect(llmCheckingText(0)).toBe(
      "本机正在检查这段文字，刚开始等。这一步通常要一两分钟；你可以先去做别的——检查完的结果会留在本机，回来点「查看实际待发送文本」就能看到。",
    );
    // 负数不出现：时钟回拨 / 上游算歪了都按「刚开始等」显示，不显示「已等 -3 秒」。
    expect(llmCheckingText(-3)).toBe(llmCheckingText(0));
  });

  it("已等 45 秒：报出秒数，并说清结果留在本机、回来再点一次就能看到", () => {
    expect(llmCheckingText(45)).toBe(
      "本机正在检查这段文字，已等 45 秒。这一步通常要一两分钟；你可以先去做别的——检查完的结果会留在本机，回来点「查看实际待发送文本」就能看到。",
    );
  });

  it("句子里必须有的四个信息点：在等什么、大概多久、可以走开、结果不会丢", () => {
    const text = llmCheckingText(45);
    expect(text).toContain("已等 45 秒");
    expect(text).toContain("可以先去做别的");
    expect(text).toContain("结果会留在本机");
    expect(text).toContain("回来点「查看实际待发送文本」");
    // 秒数向下取整，且两档之间只差那一格。
    expect(llmCheckingText(45.9)).toBe(llmCheckingText(45));
  });
});

/* ── W2 秒数算法 ────────────────────────────────────────────────── */

describe("W2 —— elapsedSecondsSince 是纯函数，不读时钟", () => {
  it("正常差值按整秒向下取整", () => {
    expect(elapsedSecondsSince(1_000, 45_000)).toBe(44);
    expect(elapsedSecondsSince(0, 60_000)).toBe(60);
  });

  it("临界：999ms 还没到一秒算 0，1000ms 算 1", () => {
    expect(elapsedSecondsSince(10_000, 10_999)).toBe(0);
    expect(elapsedSecondsSince(10_000, 11_000)).toBe(1);
  });

  it("时钟回拨（now < since）给 0，绝不给负数", () => {
    expect(elapsedSecondsSince(50_000, 10_000)).toBe(0);
    expect(elapsedSecondsSince(50_000, 49_999)).toBe(0);
  });
});

/* ── W3 六格全表：只有 timeout 那格改了 ─────────────────────────── */

describe("W3 —— llmUnusedNoticeText 六格全表", () => {
  it("timeout 那格点名两种可能，并给出下一步动作", () => {
    expect(llmUnusedNoticeText("timeout")).toBe(
      "这次本地模型没用上（等了太久没回——可能是这段太长，也可能是本机服务卡住了）。可以点「重跑脱敏」再试一次。",
    );
    const text = llmUnusedNoticeText("timeout");
    expect(text).toContain("太长");
    expect(text).toContain("卡住");
    expect(text).toContain("再试一次");
    // 那句话点名的按钮名与屏幕那颗同源：不是再手写一遍按钮文案。
    expect(text).toContain(LLM_PREVIEW_RETRY_LABEL);
  });

  it("其余五格逐字不变", () => {
    expect(llmUnusedNoticeText("not_loopback")).toBe("这次本地模型没用上（配置的地址不是本机回环）");
    expect(llmUnusedNoticeText("network")).toBe("这次本地模型没用上（没连上那台本机服务）");
    expect(llmUnusedNoticeText("http")).toBe("这次本地模型没用上（那台本机服务回了错误）");
    expect(llmUnusedNoticeText("invalid_json")).toBe("这次本地模型没用上（回稿不是合法 JSON）");
    expect(llmUnusedNoticeText("unstructured")).toBe("这次本地模型没用上（这条路没按结构化输出回）");
  });

  it("「原因未登记」与「只有标题」两路逐字不变", () => {
    expect(llmUnusedNoticeText(undefined)).toBe(LLM_UNUSED_HEADLINE);
    expect(llmUnusedNoticeText("")).toBe(LLM_UNUSED_HEADLINE);
    expect(llmUnusedNoticeText("cloud_side_halt")).toBe(`${LLM_UNUSED_HEADLINE}（原因未登记）`);
  });

  it("在册的六格每格都有一句话，且都不等于「只有标题」那一句", () => {
    for (const kind of LLM_FAILURE_KIND_DTO_VALUES) {
      expect(llmUnusedNoticeText(kind), kind).toContain(LLM_UNUSED_HEADLINE);
      expect(llmUnusedNoticeText(kind), kind).not.toBe(LLM_UNUSED_HEADLINE);
    }
    expect([...LLM_FAILURE_KIND_DTO_VALUES]).toHaveLength(6);
  });

  it("重问一次那颗按钮的文案常量存在且说清「是重新问模型」", () => {
    expect(LLM_PREVIEW_RETRY_LABEL).toBe("重跑脱敏");
  });
});

/* ── W4 起点按在每一处预览调用之前，收口只在一个 finally ────────── */

describe("W4 —— 等待起点与所有预览调用成对（源码级）", () => {
  const panel = stripCommentsKeepingLines(source("IngestPanel.tsx"));
  const lines = panel.split("\n");
  const callLines = lines
    .map((line, index) => (line.includes("api.ingestPreview(") ? index : -1))
    .filter((index) => index >= 0);

  it("面板里确有 `api.ingestPreview(` 调用在被断言（不是空表蒙混过关）", () => {
    expect(callLines.length).toBeGreaterThanOrEqual(1);
    expect([...panel.matchAll(/api\.ingestPreview\(/g)].length).toBe(callLines.length);
  });

  it("每一处预览调用之前（紧邻 3 行内）都按下起点", () => {
    for (const index of callLines) {
      const window = lines.slice(Math.max(0, index - 3), index).join("\n");
      expect(
        window.includes("setPreviewStartedAt(Date.now())"),
        `第 ${index + 1} 行的 api.ingestPreview( 之前没有按下起点`,
      ).toBe(true);
    }
  });

  it("起点只在 `action()` 的 finally 里清空，且与 setBusy(false) 同一段", () => {
    expect([...panel.matchAll(/setPreviewStartedAt\(null\)/g)].length).toBeGreaterThanOrEqual(1);
    expect(panel, "setPreviewStartedAt(null) 不在收口那条 finally 里").toMatch(
      /finally\s*\{[^{}]*setBusy\(false\);[^{}]*setPreviewStartedAt\(null\)[^{}]*\}/,
    );
    // 起点只有 Date.now() 与 null 两种赋值：没有第三种「自己算一份」的起点。
    const starts = [...panel.matchAll(/setPreviewStartedAt\(((?:[^()]|\([^()]*\))*)\)/g)].map((m) => m[1]);
    expect(new Set(starts)).toEqual(new Set(["Date.now()", "null"]));
  });

  it("等待显示只接在 `preview === null` 那一支，且不新增别的流程", () => {
    // 〔web-redesign 第三步〕CloudGate 的这一支从「三元片段」改成了提前 return：
    // 判据不变——等待显示只能出现在这一支里，且这一支不出现确认链的文案。
    const noPreviewBranch = /if \(preview === null\) \{[\s\S]*?\n\s*\}\n/.exec(panel)?.[0] ?? "";
    expect(noPreviewBranch, "未预览那一支要被断言到").not.toBe("");
    expect(noPreviewBranch).toContain("正在本机取这份要发出去的内容");
    expect(noPreviewBranch).toContain("llmCheckingText(");
    expect(noPreviewBranch).not.toContain("确认本次发送内容");
    expect(panel).toContain("previewPendingSince");
    expect(panel).toContain("useElapsedSeconds(");
    // 「重新取一份」那颗按钮换成「重跑脱敏」（搬进脱敏核对弹窗），其余按钮文案一个不动。
    expect(source("ui/SendReviewDialog.tsx")).toContain("LLM_PREVIEW_RETRY_LABEL");
    // 确认链的两个键（S5 起在 ConfirmDialog 上）：原文轨与脱敏轨各一组，措辞仍逐字钉住。
    expect(panel).toContain('title={track === "raw" ? "确认发送原文" : "确认本次发送内容"}');
    expect(panel).toContain('confirmLabel={track === "raw" ? "确认原文并整理" : "确认并整理"}');
    expect(panel).toContain('cancelLabel="再想想"');
  });

  it("hook 文件里 setInterval 与 clearInterval 同时出现（起与收成对）", () => {
    const hook = source("useElapsedSeconds.ts");
    expect(hook).toContain("setInterval");
    expect(hook).toContain("clearInterval");
    expect(hook).toMatch(/return \(\) => clearInterval\(/);
    expect(hook).toContain("export function useElapsedSeconds(");
    // 没在等就不起定时器。
    expect(hook).toMatch(/if \(since === null\)/);
  });
});

/* ── W5 禁区仍在 ────────────────────────────────────────────────── */

describe("W5 —— 不接取消、不重算回环（源码级禁区）", () => {
  it("整个 src/web 不出现 AbortSignal：界面不假装能取消一条没有 caller signal 的调用", () => {
    const files = listFiles(WEB);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(readFileSync(file, "utf8"), file).not.toContain("AbortSignal");
    }
  });

  it("IngestPanel.tsx 不自己判断回环：地址字符串一个都不出现", () => {
    const panel = source("IngestPanel.tsx");
    expect(panel).not.toMatch(/127\.0\.0\.1/);
    expect(panel).not.toMatch(/localhost/);
  });

  it("等待中那句不承诺取消：没有「取消」按钮，也没有 abort 字样", () => {
    const panel = source("IngestPanel.tsx");
    const checkingRegion = /\{checkingLlm \?[^\n]*\}/.exec(panel)?.[0] ?? "";
    expect(checkingRegion, "等待那一句要被断言到").not.toBe("");
    expect(checkingRegion).not.toMatch(/abort|取消/i);
  });
});

/* ── W6 「正在检查」只看档位，绝不谎报 ──────────────────────────── */

describe("W6 —— checkingLlm 三条件齐全：没问模型的那一档不说「正在检查」（源码级）", () => {
  const panel = stripCommentsKeepingLines(source("IngestPanel.tsx"));
  const lines = panel.split("\n");
  const checkingIndex = lines.findIndex((line) => line.includes("const checkingLlm ="));

  it("checkingLlm 只有一处定义，且同一行内三条件齐备", () => {
    expect(lines.filter((line) => line.includes("const checkingLlm ="))).toHaveLength(1);
    expect(checkingIndex, "checkingLlm 的定义要被断言到").toBeGreaterThanOrEqual(0);
    const line = lines[checkingIndex];
    expect(line).toContain("preview === null");
    expect(line).toContain("previewPendingSince !== null");
    // 第三条是 M9-8b 补的那一格：`manual` 档那条预览服务端根本不问模型（`resolveEgressPreview`
    // 只在 local_llm + 脱敏轨才走异步装配），少了它界面就在谎报。
    expect(line).toContain('tier === "local_llm"');
  });

  it("档位判据只有一处，checkingLlm 复用同一函数里算出的那个 tier", () => {
    expect([...panel.matchAll(/redactionTierOfMode\(/g)].length).toBe(1);
    const tierIndex = lines.findIndex((line) => line.includes("const tier = redactionTierOfMode("));
    expect(tierIndex, "tier 的定义要被断言到").toBeGreaterThanOrEqual(0);
    expect(checkingIndex, "checkingLlm 要定义在 tier 之后，才谈得上复用").toBeGreaterThan(tierIndex);
  });

  /**
   * 「等待只有一处实现」这条纪律的落点；计数随显示位收敛而变。
   *
   * M10-4 之后曾是 2（单条那一支 + 收件箱行内那一支）。〔M11-B D-1〕把行内等待计时从列表行删掉
   * 之后，收件箱那一屏只报整体的「本机正在检查 N 条。」——那句出自同一个纯函数文件里的
   * `prewarmPendingText`，不是第二套自己编的文案。**判据没有变宽**：逐条那一句仍只许出现在
   * `checkingLlm` 那一支，收件箱那一屏只许经纯函数取句，两处都不许出现自造的「正在检查」字面量。
   */
  it("等待读数只有 `llmCheckingText(` 这一个来源：单条那一支一次，收件箱那一屏改走 `prewarmPendingText(`", () => {
    const hits = [...panel.matchAll(/llmCheckingText\(/g)];
    expect(hits).toHaveLength(1);
    const region = /\{checkingLlm \?[^\n]*\}/.exec(panel)?.[0] ?? "";
    expect(region, "等待那一句要被断言到").not.toBe("");
    expect(region).toContain("llmCheckingText(");
    const regionStart = panel.indexOf(region);
    const inRegion = hits.filter(
      (hit) => hit.index !== undefined && hit.index >= regionStart && hit.index < regionStart + region.length,
    );
    expect(inRegion).toHaveLength(1);
    expect(hits.length, "唯一的调用点就在被钉住的那一段里 ⇒ 别处没有第二处显示位").toBe(inRegion.length);
    // 收件箱那一屏的「还在检查」只报条数，且必须经那个纯函数取句；行内不再有逐条等待计时。
    const section = /function InboxSection[\s\S]*?\n}/.exec(panel)?.[0] ?? "";
    expect(section, "InboxSection 本体要被断言到").not.toBe("");
    expect([...section.matchAll(/prewarmPendingText\(/g)]).toHaveLength(1);
    expect(section).not.toMatch(/正在检查/);
    expect(section).not.toMatch(/llmCheckingText\(/);
  });

  it("那句等待文案仍然只接在 `preview === null` 那一支（没有第二处显示位）", () => {
    const noPreviewBranch = /if \(preview === null\) \{[\s\S]*?\n\s*\}\n/.exec(panel)?.[0] ?? "";
    expect(noPreviewBranch, "未预览那一支要被断言到").not.toBe("");
    expect(noPreviewBranch).toContain("llmCheckingText(");
    expect(noPreviewBranch).toContain("checkingLlm");
  });
});

/* ── W7 那句「再试一次」与屏幕那颗按钮同源 ──────────────────────── */

describe("W7 —— FAILURE_ACTION 读 `LLM_PREVIEW_RETRY_LABEL`，不手写第二遍按钮名（源码级）", () => {
  const tierModule = source("redactionTier.ts");

  /** `FAILURE_ACTION` 那一段：从定义起手，到它那个 `Object.freeze({...})` 收口。 */
  function failureActionSegment(): string {
    const start = tierModule.indexOf("const FAILURE_ACTION");
    if (start < 0) return "";
    const end = tierModule.indexOf("\n});", start);
    return end < 0 ? tierModule.slice(start) : tierModule.slice(start, end + 3);
  }

  it("FAILURE_ACTION 那一段不含字面量「重新取一份」，含那个常量", () => {
    const segment = failureActionSegment();
    expect(segment, "FAILURE_ACTION 的定义要被断言到").not.toBe("");
    expect(segment).not.toContain("「重新取一份」");
    expect(segment).toContain("LLM_PREVIEW_RETRY_LABEL");
  });

  it("整个 redactionTier.ts 不再出现「重新取一份」：按钮名只有一处定义", () => {
    expect(tierModule).not.toContain("重新取一份");
  });

  it("timeout 那格给出的动作，点名的按钮与常量逐字相同", () => {
    expect(llmUnusedNoticeText("timeout")).toContain(LLM_PREVIEW_RETRY_LABEL);
    expect(llmUnusedNoticeText("timeout")).not.toContain("重新取一份");
    // 其余五格没有那句话：动作只在「等太久」这一格有意义。
    for (const kind of LLM_FAILURE_KIND_DTO_VALUES) {
      if (kind === "timeout") continue;
      expect(llmUnusedNoticeText(kind), kind).not.toContain(LLM_PREVIEW_RETRY_LABEL);
    }
  });
});
