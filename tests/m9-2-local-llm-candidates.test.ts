/**
 * M9-2 专项测试：本地脱敏模型的提示词、调用与严格校验（执行准则 §四 V1–V10）。
 *
 * 全程离线：HTTP 走注入的假 `fetch`，没有真实模型、没有真实端点、没有 socket。
 * 本批不接预览（M9-3）、不做前端（M9-4）、不翻 `local_llm` 的占位门——所以这里**只**钉
 * 「提示词写了什么」与「脏输出能不能被挡住」两件事。
 *
 * 断言的落点是**丢弃原因的分桶**，不只是「丢了几条」：五类原因各自对应模型的一种错法
 * （越界 / 偏移错位 / 伪造类别 / 结构缺失 / 重复重叠），标定要读的就是这张分布表。
 */

import { describe, expect, it } from "vitest";

import type { ModelAdapter } from "../src/server/ingest/provider.ts";
import { sendChatCompletion } from "../src/server/ingest/provider.ts";
import {
  buildLocalLlmRequest,
  parseLocalLlmResponse,
  proposeRedactionCandidates,
  validateLocalLlmCandidates,
} from "../src/server/privacy/localLlm.ts";
import {
  buildLocalLlmSystemPrompt,
  LOCAL_LLM_OUTPUT_SHAPE,
  LOCAL_LLM_PROMPT_VERSION,
} from "../src/server/privacy/localLlmPrompt.ts";
import { SEMANTIC_REDACTION_KINDS } from "../src/server/privacy/redaction.ts";

/**
 * 一条含非 BMP、英文、全角标点的原文：偏移单位在这里最容易出错（V6）。
 * `张三` 与 `张江` 各只出现一次（可重定位），`实验室` 出现两次（多处命中即丢）。
 */
const RAW = '老张说🙂：周三下午张三在张江实验室见，Zhang San 也会来另一间实验室。《星海》是他说的。';

const IDX = {
  laoZhang: RAW.indexOf("老张"),
  emoji: RAW.indexOf("🙂"),
  zhangSan: RAW.indexOf("张三"),
  zhangJiang: RAW.indexOf("张江"),
  shiYanShi: RAW.indexOf("实验室"),
  xingHai: RAW.indexOf("《星海》"),
} as const;

/* ── 夹具 ─────────────────────────────────────────────────────────── */

function adapter(overrides: Partial<ModelAdapter> = {}): ModelAdapter {
  return {
    provider: "ollama",
    model: "qwen3:8b",
    baseUrl: "http://127.0.0.1:11434/v1",
    callPath: "ollama_openai_compatible",
    supportsStructuredOutput: false,
    requestTimeoutMs: 1000,
    ...overrides,
  };
}

/** OpenAI 兼容信封：`sendChatCompletion` 只认 `choices[0].message.content`。 */
function envelope(content: string): string {
  return JSON.stringify({ choices: [{ message: { content } }] });
}

function candidate(start: number, end: number, kind: string, surface: string): Record<string, unknown> {
  return { start, end, kind, surface };
}

function jsonOf(...candidates: readonly unknown[]): string {
  return JSON.stringify({ candidates });
}

function byRaw(...candidates: readonly unknown[]): string {
  return jsonOf(...candidates);
}

/** 假 fetch：固定状态码 + 固定响应体。 */
function fetchReturning(status: number, body: string): { fetchImpl: typeof fetch; calls: RequestInit[] } {
  const calls: RequestInit[] = [];
  const fetchImpl = (
    _input: unknown,
    init?: RequestInit,
  ): Promise<Response> => {
    calls.push(init ?? {});
    return Promise.resolve({
      status,
      text: () => Promise.resolve(body),
    } as unknown as Response);
  };
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

/** 假 fetch：收下请求却永不回稿，直到 signal abort（真 fetch 的行为）。 */
function fetchHanging(): typeof fetch {
  const impl = (
    _input: unknown,
    init?: { signal?: AbortSignal },
  ): Promise<Response> =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("The user aborted a request.")));
    });
  return impl as unknown as typeof fetch;
}

/** 假 fetch：连接直接被拒（真网络故障的形态）。 */
function fetchRejecting(): typeof fetch {
  const impl = (): Promise<Response> => Promise.reject(new TypeError("Failed to fetch"));
  return impl as unknown as typeof fetch;
}

/* ── V1–V3：通过、容忍排版、越界 ──────────────────────────────────── */

describe("V1 正常 JSON ⇒ 候选逐条通过", () => {
  const text = byRaw(
    candidate(IDX.laoZhang, IDX.laoZhang + 2, "person", "老张"),
    candidate(IDX.zhangJiang, IDX.zhangJiang + 2, "place", "张江"),
    candidate(IDX.xingHai, IDX.xingHai + 4, "person", "《星海》"),
  );

  it("三条全部采信，零丢弃", () => {
    const parsed = parseLocalLlmResponse(text);
    expect(parsed.ok).toBe(true);
    const result = validateLocalLlmCandidates(RAW, parsed.ok ? parsed.candidates : []);
    expect(result.dropped.count).toBe(0);
    expect(result.candidates).toHaveLength(3);
  });

  it("surface 与原文逐字一致（采纳的是切片，不是模型给的字面）", () => {
    const parsed = parseLocalLlmResponse(text);
    const result = validateLocalLlmCandidates(RAW, parsed.ok ? parsed.candidates : []);
    for (const one of result.candidates) {
      expect(one.surface).toBe(RAW.slice(one.start, one.end));
    }
  });

  it("候选按 start 升序返回，互不重叠", () => {
    const parsed = parseLocalLlmResponse(text);
    const result = validateLocalLlmCandidates(RAW, parsed.ok ? parsed.candidates : []);
    const starts = result.candidates.map((one) => one.start);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
    for (let i = 1; i < result.candidates.length; i += 1) {
      expect(result.candidates[i]!.start).toBeGreaterThanOrEqual(result.candidates[i - 1]!.end);
    }
  });
});

describe("V2 ```json 围栏与前后说明文字 ⇒ 仍解析成功", () => {
  const inner = jsonOf(candidate(IDX.zhangSan, IDX.zhangSan + 2, "person", "张三"));

  it("围栏", () => {
    expect(parseLocalLlmResponse("```json\n" + inner + "\n```").ok).toBe(true);
  });

  it("前面有说明", () => {
    expect(parseLocalLlmResponse("好的，我找到了以下片段：\n" + inner).ok).toBe(true);
  });

  it("后面也有说明（含多出来的花括号句子）", () => {
    expect(parseLocalLlmResponse(inner + "\n以上就是结果 {完毕}。").ok).toBe(true);
  });

  it("多余空白与换行", () => {
    expect(parseLocalLlmResponse("  \n\t" + inner + "\n\n  ").ok).toBe(true);
  });

  it("解析出来的候选仍然可用", () => {
    const parsed = parseLocalLlmResponse("```json\n" + inner + "\n```");
    expect(parsed.ok).toBe(true);
    const result = validateLocalLlmCandidates(RAW, parsed.ok ? parsed.candidates : []);
    expect(result.candidates).toEqual([
      { start: IDX.zhangSan, end: IDX.zhangSan + 2, kind: "person", surface: "张三" },
    ]);
    expect(result.dropped.count).toBe(0);
  });
});

describe("V3 越界 ⇒ 逐条 out_of_range", () => {
  const cases = [
    ["end > length", candidate(0, RAW.length + 3, "person", "老张说🙂：")],
    ["start === end", candidate(4, 4, "person", "")],
    ["start > end", candidate(9, 5, "person", "老张")],
    ["负数 start", candidate(-2, 3, "person", "老张")],
    ["小数偏移", candidate(0, 2.5, "person", "老张")],
  ] as const;

  it.each(cases)("%s ⇒ out_of_range", (_label, entry) => {
    const result = validateLocalLlmCandidates(RAW, [entry]);
    expect(result.candidates).toHaveLength(0);
    expect(result.dropped.byReason.out_of_range).toBe(1);
    expect(result.dropped.count).toBe(1);
  });

  it("四条坏区间 + 一条好候选：计数只算坏的那几条", () => {
    const result = validateLocalLlmCandidates(RAW, [
      candidate(0, RAW.length + 1, "person", "x"),
      candidate(5, 5, "person", "x"),
      candidate(-1, 2, "person", "x"),
      candidate(0, 1.5, "person", "x"),
      candidate(IDX.laoZhang, IDX.laoZhang + 2, "person", "老张"),
    ]);
    expect(result.dropped.byReason.out_of_range).toBe(4);
    expect(result.candidates).toHaveLength(1);
  });

  it("结构不合法（缺字段/类型不对）⇒ malformed，与 out_of_range 分桶", () => {
    const result = validateLocalLlmCandidates(RAW, [
      { start: IDX.laoZhang, end: IDX.laoZhang + 2, kind: "person" },
      { start: IDX.laoZhang, end: IDX.laoZhang + 2, surface: 42, kind: "person" },
      { start: "0", end: 2, kind: "person", surface: "老张" },
      "老张",
      null,
      [1, 2],
    ]);
    expect(result.dropped.byReason.malformed).toBe(6);
    expect(result.candidates).toHaveLength(0);
    expect(result.dropped.count).toBe(6);
  });

  it("五类计数互不串门：byReason 五键恒在", () => {
    const result = validateLocalLlmCandidates(RAW, []);
    expect(Object.keys(result.dropped.byReason).sort()).toEqual(
      ["duplicate", "kind_not_allowed", "malformed", "out_of_range", "surface_mismatch"].sort(),
    );
    expect(result.dropped.count).toBe(0);
  });
});

/* ── V4–V6：词面核验与重定位 ──────────────────────────────────────── */

describe("V4 surface 与区间不符", () => {
  it("全篇唯一命中 ⇒ 采纳，且 start/end 是重定位结果", () => {
    const result = validateLocalLlmCandidates(RAW, [candidate(0, 2, "person", "张三")]);
    expect(result.candidates).toEqual([
      { start: IDX.zhangSan, end: IDX.zhangSan + 2, kind: "person", surface: "张三" },
    ]);
    expect(result.dropped.count).toBe(0);
  });

  it("全篇多处命中 ⇒ surface_mismatch（不知道它想说的是哪一处）", () => {
    const result = validateLocalLlmCandidates(RAW, [candidate(0, 2, "organization", "实验室")]);
    expect(result.candidates).toHaveLength(0);
    expect(result.dropped.byReason.surface_mismatch).toBe(1);
  });

  it("全篇根本没有这个词面 ⇒ surface_mismatch", () => {
    const result = validateLocalLlmCandidates(RAW, [
      candidate(IDX.laoZhang, IDX.laoZhang + 2, "person", "李四"),
    ]);
    expect(result.dropped.byReason.surface_mismatch).toBe(1);
  });

  it("空 surface ⇒ 丢弃（它能在每个位置「匹配」，不可采信）", () => {
    const result = validateLocalLlmCandidates(RAW, [candidate(IDX.laoZhang, IDX.laoZhang + 2, "person", "")]);
    expect(result.dropped.byReason.surface_mismatch).toBe(1);
  });

  it("大小写不同的词面不做折叠匹配 ⇒ surface_mismatch", () => {
    const result = validateLocalLlmCandidates(RAW, [
      candidate(RAW.indexOf("Zhang San"), RAW.indexOf("Zhang San") + 9, "person", "zhang san"),
    ]);
    expect(result.dropped.byReason.surface_mismatch).toBe(1);
  });
});

describe("V5 伪造 kind ⇒ kind_not_allowed", () => {
  it.each([["person_name"], ["姓名"], [""], ["Person"], ["人名"]] as const)("%s", (kind) => {
    const result = validateLocalLlmCandidates(RAW, [
      candidate(IDX.zhangJiang, IDX.zhangJiang + 2, kind, "张江"),
    ]);
    expect(result.candidates).toHaveLength(0);
    expect(result.dropped.byReason.kind_not_allowed).toBe(1);
  });

  it("3 类语义取值逐个被接受（取值集合与契约同源，不是手抄）", () => {
    expect(SEMANTIC_REDACTION_KINDS).toHaveLength(3);
    for (const kind of SEMANTIC_REDACTION_KINDS) {
      const result = validateLocalLlmCandidates(RAW, [
        candidate(IDX.zhangJiang, IDX.zhangJiang + 2, kind, "张江"),
      ]);
      expect(result.candidates).toHaveLength(1);
      expect(result.candidates[0]!.kind).toBe(kind);
    }
  });
});

describe("V6 非 BMP 偏移错位", () => {
  it("按码点计数（少算了 emoji 的第二个 code unit）⇒ 重定位后采纳", () => {
    // 「张江」的真实 UTF-16 起点比码点数大 1：🙂 是代理对。
    const codePointStart = [...RAW.slice(0, IDX.zhangJiang)].length;
    expect(codePointStart).toBe(IDX.zhangJiang - 1);
    const result = validateLocalLlmCandidates(RAW, [
      candidate(codePointStart, codePointStart + 2, "place", "张江"),
    ]);
    expect(result.candidates).toEqual([
      { start: IDX.zhangJiang, end: IDX.zhangJiang + 2, kind: "place", surface: "张江" },
    ]);
    expect(result.dropped.count).toBe(0);
  });

  it("含 emoji 的词面：end 按码点少算一格 ⇒ 重定位后采纳，surface 是原文切片", () => {
    const surface = "说🙂：";
    const at = RAW.indexOf(surface);
    const codePointEnd = at + [...surface].length; // 3 个码点，实际占 4 个 code unit
    expect(RAW.slice(at, codePointEnd)).not.toBe(surface);
    const result = validateLocalLlmCandidates(RAW, [candidate(at, codePointEnd, "person", surface)]);
    expect(result.candidates).toEqual([
      { start: at, end: at + surface.length, kind: "person", surface },
    ]);
    expect(result.dropped.count).toBe(0);
  });

  it("偏移错位 + 词面多处命中 ⇒ 丢弃（宁丢勿错）", () => {
    const cpStart = [...RAW.slice(0, IDX.shiYanShi)].length;
    const result = validateLocalLlmCandidates(RAW, [
      candidate(cpStart, cpStart + 6, "organization", "实验室"),
    ]);
    expect(result.candidates).toHaveLength(0);
    expect(result.dropped.byReason.surface_mismatch).toBe(1);
  });

  it("区间本身合法且逐字相等（emoji 计入 2 个 code unit）⇒ 通过", () => {
    const result = validateLocalLlmCandidates(RAW, [
      candidate(IDX.emoji, IDX.emoji + 2, "person", "🙂"),
    ]);
    expect(result.candidates).toEqual([
      { start: IDX.emoji, end: IDX.emoji + 2, kind: "person", surface: "🙂" },
    ]);
  });
});

/* ── V7：重叠与重复 ────────────────────────────────────────────────── */

describe("V7 重叠与重复", () => {
  it("完全重复（同 start/end/kind）⇒ 只留一条，另一条计入 duplicate", () => {
    const twice = candidate(IDX.zhangJiang, IDX.zhangJiang + 2, "place", "张江");
    const result = validateLocalLlmCandidates(RAW, [twice, structuredClone(twice)]);
    expect(result.candidates).toHaveLength(1);
    expect(result.dropped.byReason.duplicate).toBe(1);
  });

  it("同起点不同长度 ⇒ 左起最长保留，短的那条被吃掉", () => {
    const result = validateLocalLlmCandidates(RAW, [
      candidate(IDX.xingHai + 1, IDX.xingHai + 3, "person", "星海"),
      candidate(IDX.xingHai, IDX.xingHai + 4, "person", "《星海》"),
    ]);
    expect(result.candidates).toEqual([
      { start: IDX.xingHai, end: IDX.xingHai + 4, kind: "person", surface: "《星海》" },
    ]);
    expect(result.dropped.byReason.duplicate).toBe(1);
  });

  it("跨界重叠（后一条起点落在前一条区间内）⇒ 左起保留，被吃掉的计入 duplicate", () => {
    const zj = IDX.zhangJiang;
    const result = validateLocalLlmCandidates(RAW, [
      candidate(zj, zj + 5, "organization", "张江实验室"),
      candidate(zj + 2, zj + 5, "place", "实验室"),
    ]);
    expect(result.candidates).toEqual([
      { start: zj, end: zj + 5, kind: "organization", surface: "张江实验室" },
    ]);
    expect(result.dropped.byReason.duplicate).toBe(1);
  });

  it("同区间不同 kind ⇒ 不是完全重复，按重叠消解只留左起第一条", () => {
    const result = validateLocalLlmCandidates(RAW, [
      candidate(IDX.zhangSan, IDX.zhangSan + 2, "person", "张三"),
      candidate(IDX.zhangSan, IDX.zhangSan + 2, "person", "张三"),
    ]);
    expect(result.candidates).toHaveLength(1);
    expect(result.dropped.byReason.duplicate).toBe(1);
  });

  it("丢弃计数 = 五类之和", () => {
    const result = validateLocalLlmCandidates(RAW, [
      candidate(IDX.zhangJiang, IDX.zhangJiang + 2, "place", "张江"),
      candidate(IDX.zhangJiang, IDX.zhangJiang + 2, "place", "张江"),
      candidate(0, RAW.length + 1, "person", "x"),
      candidate(IDX.laoZhang, IDX.laoZhang + 2, "person_name", "老张"),
      { kind: "person" },
      candidate(3, 4, "organization", "实验室"),
    ]);
    const sum = Object.values(result.dropped.byReason).reduce((a, b) => a + b, 0);
    expect(result.dropped.count).toBe(sum);
    expect(result.dropped.count).toBe(5);
    expect(result.candidates).toHaveLength(1);
  });
});

/* ── V8：坏输出不抛 ───────────────────────────────────────────────── */

describe("V8 坏 JSON / 空串 / HTML 错误页 ⇒ ok:false 且不抛", () => {
  const cases = [
    ["空串", ""],
    ["纯空白", "   \n\t "],
    ["坏 JSON（截断）", '{"candidates":[{"start":0,"end":2,'],
    ["根本不是 JSON", "我不知道该怎么做。"],
    ["HTML 错误页", "<html><head><style>body{color:red}</style></head><body><h1>502 Bad Gateway</h1></body></html>"],
    ["candidates 不是数组", '{"candidates":{"start":0,"end":2}}'],
    ["candidates 缺席", '{"result":[]}'],
    ["candidates 是字符串", '{"candidates":"[]"}'],
    ["顶层是数组", '[{"start":0,"end":2,"kind":"person","surface":"老张"}]'],
    ["只有花括号", "{}"],
  ] as const;

  it.each(cases)("%s", (_label, text) => {
    expect(() => parseLocalLlmResponse(text)).not.toThrow();
    expect(parseLocalLlmResponse(text).ok).toBe(false);
  });

  it("合法但候选为空 ⇒ ok:true（「没有敏感内容」与「没按契约输出」是两件事）", () => {
    expect(parseLocalLlmResponse('{"candidates":[]}')).toEqual({ ok: true, candidates: [] });
  });

  it("validate 不抛：候选里塞进各种畸形值", () => {
    expect(() =>
      validateLocalLlmCandidates(RAW, [undefined, null, 42, "x", [], {}, { start: NaN, end: 1 }]),
    ).not.toThrow();
  });

  it("空原文 ⇒ 一切候选都越界，不抛", () => {
    expect(() => validateLocalLlmCandidates("", [candidate(0, 1, "person", "老张")])).not.toThrow();
    const result = validateLocalLlmCandidates("", [candidate(0, 1, "person", "老张")]);
    expect(result.dropped.byReason.out_of_range).toBe(1);
  });

  it("proposeRedactionCandidates 不抛：假端点回 HTML 错误页", async () => {
    const fake = fetchReturning(200, "<html><body>502</body></html>");
    await expect(proposeRedactionCandidates(adapter(), RAW, { fetchImpl: fake.fetchImpl })).resolves.toMatchObject({
      ok: false,
    });
  });
});

/* ── V9：提示词正文 ───────────────────────────────────────────────── */

describe("V9 提示词逐条在场", () => {
  const prompt = buildLocalLlmSystemPrompt();

  it("版本号出现在返回值里（组装出来的请求也带它）", () => {
    expect(prompt).toContain(LOCAL_LLM_PROMPT_VERSION);
    const request = buildLocalLlmRequest(RAW, true);
    expect(request.messages[0]!.content).toContain(LOCAL_LLM_PROMPT_VERSION);
    expect(request.responseSchemaName).toBe(LOCAL_LLM_PROMPT_VERSION);
  });

  it("输出形状的字面量在正文里（与断言同源，不各抄一份）", () => {
    expect(prompt).toContain(LOCAL_LLM_OUTPUT_SHAPE);
    expect(LOCAL_LLM_OUTPUT_SHAPE).toContain('"candidates"');
    for (const field of ["start", "end", "kind", "surface"]) {
      expect(LOCAL_LLM_OUTPUT_SHAPE).toContain(field);
    }
  });

  it("3 类 kind 取值逐个在场，且与契约同源", () => {
    expect(SEMANTIC_REDACTION_KINDS).toHaveLength(3);
    for (const kind of SEMANTIC_REDACTION_KINDS) {
      expect(prompt).toContain(kind);
    }
    expect(prompt).toContain(SEMANTIC_REDACTION_KINDS.join(" / "));
  });

  it("UTF-16 偏移：写明单位，并否定字符数/码点数/字节数", () => {
    expect(prompt).toContain("UTF-16");
    expect(prompt).toContain("不是字符数");
    expect(prompt).toContain("不是码点数");
    expect(prompt).toContain("不是字节数");
  });

  it("surface 必须是原文该区间的逐字拷贝", () => {
    expect(prompt).toContain("逐字拷贝");
  });

  it("召回优先：含「宁可多报」原句，且写明不确定时也报", () => {
    expect(prompt).toContain("宁可多报");
    expect(prompt).toContain("不可漏报");
    expect(prompt).toContain("不确定时也要报");
  });

  it("含「不要复述上下文」原句，并禁止总结与 JSON 之外的输出", () => {
    expect(prompt).toContain("不要复述上下文");
    expect(prompt).toContain("禁止复述上下文");
    expect(prompt).toContain("禁止总结");
    expect(prompt).toContain("禁止输出 JSON 之外的任何内容");
  });

  it("user 消息逐字就是原文（任何包装都会让偏移错位）", () => {
    const request = buildLocalLlmRequest(RAW, false);
    expect(request.messages[1]!.content).toBe(RAW);
    expect(request.messages[1]!.role).toBe("user");
  });

  it("温度低、未声明结构化时不带 response_format", () => {
    expect(buildLocalLlmRequest(RAW, false).temperature).toBe(0);
    expect(buildLocalLlmRequest(RAW, false).responseFormat).toBeUndefined();
    expect(buildLocalLlmRequest(RAW, true).responseFormat).toBe("json_schema");
  });
});

/* ── V11–V13：M9-7a 的类别边界那一条 + 版本号 ─────────────────────── */

describe("V11 类别边界那一条逐字在场", () => {
  const prompt = buildLocalLlmSystemPrompt();
  const line = prompt.split("\n").find((each) => each.startsWith("10. **类别边界**")) ?? "";

  it("那一条落在【取舍原则】一节内（不是补在末尾）", () => {
    expect(line).not.toBe("");
    const section = prompt.slice(prompt.indexOf("【取舍原则】"), prompt.indexOf("【绝对禁止】"));
    expect(section).toContain(line);
  });

  it("场所那一侧的例子写死：宾馆、门店这类「有名字的地方」在列", () => {
    for (const word of ["门店", "饭店", "宾馆", "酒店", "菜市场", "收费站", "小区"]) {
      expect(line).toContain(word);
    }
  });

  it("机构那一侧的范围同时写清：公司 / 学校 / 医院 / 政府机关", () => {
    for (const word of ["公司", "学校", "基金会", "医院", "政府机关"]) {
      expect(line).toContain(word);
    }
  });

  it("几个类别名用的是契约里的取值（不是手抄的近似词）", () => {
    expect(SEMANTIC_REDACTION_KINDS).toContain("person");
    expect(SEMANTIC_REDACTION_KINDS).toContain("place");
    expect(SEMANTIC_REDACTION_KINDS).toContain("organization");
    expect(line).toContain("`place`");
    expect(line).toContain("`organization`");
  });

  it("判不出来时按最接近的一类报，并明确禁止瞎猜", () => {
    expect(line).not.toContain("`other`");
    expect(line).toContain("优先 `place`");
    expect(line).toContain("宁可留给人确认");
    expect(line).toContain("不要瞎猜");
  });
});

describe("V12 版本号升到 local-llm-v3，且在 system prompt 第一行", () => {
  it("常量本身是 local-llm-v3", () => {
    expect(LOCAL_LLM_PROMPT_VERSION).toBe("local-llm-v3");
  });

  it("正文第一行逐字带着它（不是「某处包含」）", () => {
    const firstLine = buildLocalLlmSystemPrompt().split("\n")[0]!;
    expect(firstLine).toBe(`提示词版本：${LOCAL_LLM_PROMPT_VERSION}。`);
    expect(firstLine).toBe("提示词版本：local-llm-v3。");
  });

  it("正文里不再残留 local-llm-v1（改措辞靠升版，不靠就地覆盖）", () => {
    expect(buildLocalLlmSystemPrompt()).not.toContain("local-llm-v1");
  });
});

describe("V13 结构化输出的 schema 名跟着版本常量走", () => {
  it("responseSchemaName 取自常量：与 LOCAL_LLM_PROMPT_VERSION 相等，且是 v2 字面量", () => {
    const request = buildLocalLlmRequest(RAW, true);
    expect(request.responseSchemaName).toBe(LOCAL_LLM_PROMPT_VERSION);
    expect(request.responseSchemaName).toBe("local-llm-v3");
  });

  it("未声明结构化时仍然没有 responseSchemaName", () => {
    expect(buildLocalLlmRequest(RAW, false).responseSchemaName).toBeUndefined();
  });
});

/* ── V10：sendChatCompletion 的失败折叠 ───────────────────────────── */

describe("V10 sendChatCompletion：失败一律折成结果，不抛", () => {
  it("200 + 合法信封 ⇒ ok:true，content 是回稿文本", async () => {
    const reply = jsonOf(candidate(IDX.zhangSan, IDX.zhangSan + 2, "person", "张三"));
    const fake = fetchReturning(200, envelope(reply));
    const outcome = await sendChatCompletion(adapter(), buildLocalLlmRequest(RAW, false), {
      fetchImpl: fake.fetchImpl,
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.content).toBe(reply);
    expect(outcome.failureKind).toBeUndefined();
    expect(outcome.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("400 ⇒ http", async () => {
    const outcome = await sendChatCompletion(adapter(), buildLocalLlmRequest(RAW, false), {
      fetchImpl: fetchReturning(400, '{"error":"bad request"}').fetchImpl,
    });
    expect(outcome).toMatchObject({ ok: false, failureKind: "http" });
  });

  it("500 ⇒ http", async () => {
    const outcome = await sendChatCompletion(adapter(), buildLocalLlmRequest(RAW, false), {
      fetchImpl: fetchReturning(500, "<html>boom</html>").fetchImpl,
    });
    expect(outcome).toMatchObject({ ok: false, failureKind: "http" });
  });

  it("超时 ⇒ timeout（请求 hang 住，永不回稿）", async () => {
    const outcome = await sendChatCompletion(adapter({ requestTimeoutMs: 30 }), buildLocalLlmRequest(RAW, false), {
      fetchImpl: fetchHanging(),
    });
    expect(outcome).toMatchObject({ ok: false, failureKind: "timeout" });
  });

  it("连不上（fetch 直接 reject）⇒ network", async () => {
    const outcome = await sendChatCompletion(adapter(), buildLocalLlmRequest(RAW, false), {
      fetchImpl: fetchRejecting(),
    });
    expect(outcome).toMatchObject({ ok: false, failureKind: "network" });
  });

  it("200 但回稿是坏 JSON ⇒ unstructured", async () => {
    const outcome = await sendChatCompletion(adapter(), buildLocalLlmRequest(RAW, false), {
      fetchImpl: fetchReturning(200, "{ not json").fetchImpl,
    });
    expect(outcome).toMatchObject({ ok: false, failureKind: "unstructured" });
  });

  it("200 但信封没有 choices ⇒ unstructured", async () => {
    const outcome = await sendChatCompletion(adapter(), buildLocalLlmRequest(RAW, false), {
      fetchImpl: fetchReturning(200, '{"result":"ok"}').fetchImpl,
    });
    expect(outcome).toMatchObject({ ok: false, failureKind: "unstructured" });
  });

  it("URL 归一到 /chat/completions，且带 content-type", async () => {
    let url = "";
    const impl = (input: unknown, init?: RequestInit): Promise<Response> => {
      url = String(input);
      expect(init?.method).toBe("POST");
      expect((init?.headers as Record<string, string>)["content-type"]).toBe("application/json");
      return Promise.resolve({ status: 200, text: () => Promise.resolve(envelope('{"candidates":[]}')) } as unknown as Response);
    };
    const outcome = await sendChatCompletion(
      adapter({ baseUrl: "http://127.0.0.1:11434/v1/" }),
      buildLocalLlmRequest(RAW, false),
      { fetchImpl: impl as unknown as typeof fetch },
    );
    expect(url).toBe("http://127.0.0.1:11434/v1/chat/completions");
    expect(outcome.ok).toBe(true);
  });

  it("结构化声明落到 response_format（与现有 structured 路径同形）", async () => {
    let sent: Record<string, unknown> = {};
    const impl = (_input: unknown, init?: RequestInit): Promise<Response> => {
      sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Promise.resolve({ status: 200, text: () => Promise.resolve(envelope('{"candidates":[]}')) } as unknown as Response);
    };
    await sendChatCompletion(adapter({ supportsStructuredOutput: true }), buildLocalLlmRequest(RAW, true), {
      fetchImpl: impl as unknown as typeof fetch,
    });
    expect(sent.stream).toBe(false);
    expect(sent.temperature).toBe(0);
    expect(sent.response_format).toEqual({ type: "json_schema", name: LOCAL_LLM_PROMPT_VERSION });
    const messages = sent.messages as { role: string; content: string }[];
    expect(messages[1]!.content).toBe(RAW);
  });

  it("未声明结构化 ⇒ 请求体里没有 response_format", async () => {
    let sent: Record<string, unknown> = {};
    const impl = (_input: unknown, init?: RequestInit): Promise<Response> => {
      sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Promise.resolve({ status: 200, text: () => Promise.resolve(envelope('{"candidates":[]}')) } as unknown as Response);
    };
    await sendChatCompletion(adapter(), buildLocalLlmRequest(RAW, false), {
      fetchImpl: impl as unknown as typeof fetch,
    });
    expect(sent.response_format).toBeUndefined();
  });
});

/* ── 端到端（仍离线）与隐私红线 ───────────────────────────────────── */

describe("proposeRedactionCandidates：装配到采信的一条线", () => {
  it("正常回稿 ⇒ ok:true + 候选 + 丢弃数", async () => {
    const reply = "```json\n" + jsonOf(
      candidate(IDX.zhangSan, IDX.zhangSan + 2, "person", "张三"),
      candidate(IDX.zhangJiang, IDX.zhangJiang + 2, "place", "张江"),
      candidate(0, RAW.length + 5, "person", "整篇"),
    ) + "\n```";
    const fake = fetchReturning(200, envelope(reply));
    const result = await proposeRedactionCandidates(adapter(), RAW, { fetchImpl: fake.fetchImpl });
    expect(result.ok).toBe(true);
    expect(result.candidates).toHaveLength(2);
    expect(result.dropped).toBe(1);
    expect(result.failureKind).toBeUndefined();
  });

  it("非回环端点 ⇒ 一次请求都不发（隐私红线 P-1）", async () => {
    const fake = fetchReturning(200, envelope('{"candidates":[]}'));
    const result = await proposeRedactionCandidates(
      adapter({ baseUrl: "http://192.168.1.9:8080/v1" }),
      RAW,
      { fetchImpl: fake.fetchImpl },
    );
    expect(result.ok).toBe(false);
    expect(result.failureKind).toBe("not_loopback");
    expect(result.candidates).toHaveLength(0);
    expect(fake.calls).toHaveLength(0);
  });

  it("端点故障 ⇒ ok:false + failureKind，候选为空，不抛", async () => {
    const result = await proposeRedactionCandidates(adapter(), RAW, {
      fetchImpl: fetchReturning(503, "service unavailable").fetchImpl,
    });
    expect(result).toMatchObject({ ok: false, failureKind: "http", dropped: 0 });
    expect(result.candidates).toHaveLength(0);
  });
});
