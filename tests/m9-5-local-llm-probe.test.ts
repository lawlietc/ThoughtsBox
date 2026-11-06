/**
 * M9-5 专项测试：标定工具 `scripts/local-llm-probe.mjs`（执行准则 §七）。
 *
 * 全程离线：绝大多数用例**直接导入脚本导出的 `main`**，把 `fetchImpl` 注成假端点——
 * 这样能拿到结构化的行数据与打印行，也能对「一次请求都不发」做真实计数。
 * 只有 CLI 那一组起 `node:http` 假端点、用 `node:child_process` 跑真命令行进程序，
 * 钉住「`node scripts/local-llm-probe.mjs` 本身跑得起来、退出码与参数解析是真的」。
 *
 * T1–T6 与任务书一一对应；断言的落点是**打印出来的那些字**，不只是内部结构：
 * 标定要读的就是这份输出。
 *
 * G1–G5 钉**金标自己**（准则 §二之二 M9-D-16）：金标与原文对不上是数据错误，必须先在这里红，
 * 否则标定报告里它会长成「模型漏报」的样子——那是最难查的一类假信号。
 * M1–M6 钉**指标口径**：优先调脚本导出的纯函数 `scoreSample` / `summarize`，只在需要钉
 * 「打印」与「退出码」时起假端点跑整趟，不去解析 stdout。
 */

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import { buildLocalLlmRequest } from "../src/server/privacy/localLlm.ts";
import { ENTITY_REDACTION_KINDS } from "../src/server/privacy/redaction.ts";
import { LOCAL_LLM_OUTPUT_SHAPE, LOCAL_LLM_PROMPT_VERSION } from "../src/server/privacy/localLlmPrompt.ts";

const SCRIPT_PATH = fileURLToPath(new URL("../scripts/local-llm-probe.mjs", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

/* ── 脚本的接口面（`.mjs` 无声明文件，这里就地描述测试要用的那一格） ── */

interface ProbeOptions {
  baseUrl: string;
  model: string;
  structured: boolean;
  /** `--compare`：同一条样本两种跑法都跑（M9-D-22 的分段实验）。 */
  compare: boolean;
  text: string | null;
  textFile: string | null;
  timeoutMs: number;
  repeat: number;
  /** `--chunk <字符上限>`；`null` = 不走分段路径。 */
  chunkMaxChars: number | null;
}

/** 金标的一条：词面 + 类别，偏移一律由脚本从原文算（M9-D-16）。 */
interface GoldEntry {
  kind: string;
  surface: string;
  occurrence?: number;
}

interface GoldSpan extends GoldEntry {
  occurrence: number;
  start: number;
  end: number;
}

interface ResolvedGold {
  spans: GoldSpan[];
  missing: string[];
}

interface ScoredSample {
  label: string;
  text: string;
  expected: GoldEntry[];
}

/**
 * `scoreSample` 的返回值；`scored: false` = 这条样本没有金标（外部文本），不进任何分母。
 * 五桶（M9-D-18）：`hits` 区间全等且类别对 / `kindWrong` 区间对上但类别错 /
 * `wider` 候选严格包住期望 / `partial` 候选严格在期望内 / `falsePositive` 谁也不包谁。
 */
interface SampleScore {
  scored: boolean;
  expected: number;
  reported: number;
  hits: number;
  misses: number;
  kindWrong: number;
  wider: number;
  partial: number;
  falsePositive: number;
  goldMissing: string[];
}

interface ProbeRow {
  index: number;
  /** 第几遍（`--repeat` 用，M9-D-20）。 */
  pass: number;
  label: string;
  /** 这一行是整段跑法还是分段跑法出来的（M9-D-22 的对比表靠它分侧）。 */
  mode: "whole" | "chunked";
  jsonOk: boolean;
  candidates: number;
  admitted: { start: number; end: number; kind: string; surface: string }[];
  dropped: { count: number; byReason: Record<string, number> };
  latencyMs: number;
  /** 分段跑法：切出的段数（整段跑法恒为 1）。 */
  chunkCount: number;
  /** 分段跑法：最慢那一段的耗时（整段跑法 = `latencyMs`）。 */
  maxChunkLatencyMs: number;
  /** 第二处校验（按全文）丢掉的候选数——平移量算错就在这里露出来，不抛。 */
  mergeMismatch: number;
  transportFailure: string | null;
  failureKind: string | null;
  score: SampleScore;
}

/** `chunkText` 切出来的一段：区间首尾相接，`text` 就是 `原文.slice(start,end)`。 */
interface ProbeChunk {
  start: number;
  end: number;
  text: string;
}

/** 对比表的一侧合计。 */
interface CompareSide {
  rows: ProbeRow[];
  metrics: CalibrationMetrics;
  latencySum: number;
  slowestMs: number;
}

interface CompareReport {
  whole: CompareSide;
  chunked: CompareSide & {
    segmentCount: number;
    maxSegmentLatencyMs: number;
    mergeMismatch: number;
  };
}

interface CalibrationMetrics {
  scoredSamples: number;
  expected: number;
  reported: number;
  hits: number;
  misses: number;
  kindWrong: number;
  wider: number;
  partial: number;
  falsePositive: number;
  /** 分子 = 命中 + 类别错 + 更宽（`部分` 不进）。分母为 0 ⇒ `null`（打印 `n/a`），不是 100。 */
  recall: number | null;
  precision: number | null;
}

/** 跨遍统计：三项都是百分数，`null` = 各遍的分母都是 0。 */
interface Spread {
  min: number | null;
  median: number | null;
  max: number | null;
}

interface RepeatStatistics {
  repeats: number;
  recall: Spread;
  precision: Spread;
  /** N 遍之间 `命中/漏/误报` 有任何一项不同的样本序号。 */
  unstableSamples: number[];
}

interface ProbeSummary {
  /** 全部遍的样本行合计 = 样本数 × 遍数。 */
  total: number;
  repeats: number;
  sampleCount: number;
  /** `--chunk` 的取值；`null` = 没走分段。 */
  chunkMaxChars: number | null;
  /** `--compare` 的两侧合计与判据读数；没开对比 ⇒ `null`。 */
  compare: CompareReport | null;
  jsonOkCount: number;
  jsonValidityRate: number;
  averageLatencyMs: number;
  candidateSum: number;
  droppedSum: number;
  dropTotals: Record<string, number>;
  transportFailures: number;
  /** 跨全部遍的合并指标。 */
  metrics: CalibrationMetrics;
  passes: { metrics: CalibrationMetrics; transportFailures: number; jsonOkCount: number }[];
  statistics: RepeatStatistics;
}

interface ProbeRun {
  exitCode: number;
  lines: string[];
  rows: ProbeRow[];
  summary: ProbeSummary | null;
}

interface ProbeModule {
  DEFAULT_TIMEOUT_MS: number;
  DEFAULT_REPEAT: number;
  /** `--chunk` 的缺省字符上限（M9-D-22 的实验刻度）。 */
  DEFAULT_CHUNK_MAX_CHARS: number;
  EXIT_USAGE: number;
  EXIT_NOT_LOOPBACK: number;
  SAMPLES: ScoredSample[];
  parseArgv(argv: string[]): { ok: true; options: ProbeOptions } | { ok: false; error: string };
  /** 按行边界切段：只在 `\n` 之后下刀，单行超长整段发。 */
  chunkText(text: string, maxChars?: number): ProbeChunk[];
  /** 分段候选平移回全文坐标 + 第二处校验（按全文逐字），对不上就丢进 `mergeMismatch`，从不抛。 */
  mergeChunkCandidates(
    fullText: string,
    chunks: ProbeChunk[],
    admittedPerChunk: Candidate[][],
  ): { candidates: Candidate[]; mergeMismatch: number };
  nthOccurrenceAt(text: string, surface: string, occurrence: number): number;
  resolveGold(sample: ScoredSample): ResolvedGold | null;
  scoreSample(
    sample: ScoredSample,
    candidates: { start: number; end: number; kind: string; surface: string }[],
  ): SampleScore;
  summarize(rows: { score?: SampleScore }[]): CalibrationMetrics;
  /** 中位数：排序取中间，偶数个取中间两个的平均；空数组 ⇒ null。 */
  median(values: number[]): number | null;
  spreadOf(values: (number | null)[]): Spread;
  unstableIndexes(passRows: ProbeRow[][]): number[];
  main(
    argv: string[],
    deps?: { log?: (line: string) => void; fetchImpl?: typeof fetch },
  ): Promise<ProbeRun>;
}

async function loadProbe(): Promise<ProbeModule> {
  const specifier: string = SCRIPT_PATH;
  return (await import(specifier)) as ProbeModule;
}

/* ── 假端点 ─────────────────────────────────────────────────────── */

interface CapturedRequest {
  url: string;
  body: Record<string, unknown>;
  messages: { role: string; content: string }[];
}

interface FakeReply {
  status: number;
  body: string;
}

/** OpenAI 兼容信封：`sendChatCompletion` 只认 `choices[0].message.content`。 */
function envelope(content: string): FakeReply {
  return { status: 200, body: JSON.stringify({ choices: [{ message: { content } }] }) };
}

const OK_JSON: FakeReply = envelope('{"candidates":[]}');

/**
 * 假 fetch：按调用次序查表回稿，同时把每一次请求原文记下来。
 * 表里没有的调用一律回 `{"candidates":[]}`（合法但零命中）。
 */
function fakeEndpoint(replyFor: (userText: string, callIndex: number) => FakeReply): {
  fetchImpl: typeof fetch;
  requests: CapturedRequest[];
} {
  const requests: CapturedRequest[] = [];
  const impl = (input: unknown, init?: RequestInit): Promise<Response> => {
    const raw = String(init?.body ?? "{}");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const messages = (parsed.messages ?? []) as { role: string; content: string }[];
    requests.push({ url: String(input), body: parsed, messages });
    const userText = messages.find((message) => message.role === "user")?.content ?? "";
    const reply = replyFor(userText, requests.length - 1);
    return Promise.resolve({
      status: reply.status,
      text: () => Promise.resolve(reply.body),
    } as unknown as Response);
  };
  return { fetchImpl: impl as unknown as typeof fetch, requests };
}

/** 一个都不会被调用的假 fetch：用它数「到底发没发请求」。 */
function countingFetch(): { fetchImpl: typeof fetch; calls: unknown[] } {
  const calls: unknown[] = [];
  const impl = (input: unknown): Promise<Response> => {
    calls.push(input);
    return Promise.resolve({ status: 200, text: () => Promise.resolve("{}") } as unknown as Response);
  };
  return { fetchImpl: impl as unknown as typeof fetch, calls };
}

function collect(): { lines: string[]; log: (line: string) => void } {
  const lines: string[] = [];
  return { lines, log: (line: string) => lines.push(line) };
}

/** 不关心打印的用例用它吞掉输出，免得假端点的打印混进测试报告。 */
const QUIET = (): void => {};

const LOOPBACK = "http://127.0.0.1:11434/v1";

/* ── 金标工具（G/M 两组共用） ────────────────────────────────────── */

type Candidate = { start: number; end: number; kind: string; surface: string };

/** 一条样本的**满分回稿**：金标区间逐字回给脚本。 */
function perfectReply(probe: ProbeModule, sample: ScoredSample): Candidate[] {
  const gold = probe.resolveGold(sample);
  if (gold === null) throw new Error(`${sample.label} 没有金标`);
  if (gold.missing.length > 0) throw new Error(`${sample.label} 金标漂移：${gold.missing.join(",")}`);
  return gold.spans.map((span) => ({
    start: span.start,
    end: span.end,
    kind: span.kind,
    surface: span.surface,
  }));
}

/** 按原文找出所属样本（假端点只拿得到 user 消息，那就是原文本身）。 */
function sampleByText(probe: ProbeModule, userText: string): ScoredSample | undefined {
  return probe.SAMPLES.find((sample) => sample.text === userText);
}

function envelopeOf(candidates: Candidate[]): FakeReply {
  return envelope(JSON.stringify({ candidates }));
}

/** 代理对的**结束**偏移：高 surrogate 之后一位就是它占满 2 个 code unit 的位置。 */
function surrogatePairEnds(text: string): number[] {
  const ends: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) ends.push(i + 2);
  }
  return ends;
}

/* ── T1 正常返回合法 JSON ───────────────────────────────────────── */

describe("T1 每个样本回合法 JSON ⇒ 全绿、合法率 100%、退出码 0", () => {
  it("样本集覆盖九个类别：原六类各至少两条，三条难样本各一条", async () => {
    const probe = await loadProbe();
    const labels = new Set(probe.SAMPLES.map((sample) => sample.label));
    expect(labels).toEqual(
      new Set(["人名", "花名", "地名", "组织", "无敏感", "长文本", "代理对", "中英混排", "真长文本"]),
    );
    // 原六类是「每类两条」；三条难样本（M9-D-16）各一条，是刻意补的结构性缺口，不翻倍。
    for (const label of ["人名", "花名", "地名", "组织", "无敏感", "长文本"]) {
      expect(probe.SAMPLES.filter((sample) => sample.label === label).length).toBeGreaterThanOrEqual(2);
    }
    for (const label of ["代理对", "中英混排", "真长文本"]) {
      expect(probe.SAMPLES.filter((sample) => sample.label === label)).toHaveLength(1);
    }
  });

  it("十五个样本 json=ok、合法率 100.0%、退出码 0", async () => {
    const probe = await loadProbe();
    const sink = collect();
    const { fetchImpl, requests } = fakeEndpoint((userText) => {
      // 「李雷娜」在第一个样本里唯一命中：报真实坐标，验证采信链路真的通到底。
      const at = userText.indexOf("李雷娜");
      if (at < 0) return OK_JSON;
      return envelope(
        JSON.stringify({
          candidates: [{ start: at, end: at + "李雷娜".length, kind: "person", surface: "李雷娜" }],
        }),
      );
    });

    const run = await probe.main(["--base-url", LOOPBACK, "--model", "标定专用模型", "--repeat", "1"], {
      log: sink.log,
      fetchImpl,
    });

    expect(run.exitCode).toBe(0);
    expect(run.rows).toHaveLength(probe.SAMPLES.length);
    expect(run.rows.every((row) => row.jsonOk)).toBe(true);
    expect(run.rows.every((row) => row.transportFailure === null)).toBe(true);
    expect(run.summary!.jsonOkCount).toBe(run.summary!.total);
    expect(run.summary!.jsonValidityRate).toBe(100);
    expect(run.summary!.transportFailures).toBe(0);
    expect(run.rows[0]!.candidates).toBe(1);

    const sampleLines = run.lines.filter((line) => line.startsWith("样本 "));
    expect(sampleLines).toHaveLength(probe.SAMPLES.length);
    for (const line of sampleLines) expect(line).toContain("json=ok");
    expect(run.lines.join("\n")).toMatch(/合法率=100\.0%/);
    expect(run.lines.join("\n")).toContain("平均耗时=");
  });

  it("请求装配复用产品那一份：字段与 buildLocalLlmRequest 逐字一致", async () => {
    const probe = await loadProbe();
    const { fetchImpl, requests } = fakeEndpoint(() => OK_JSON);
    await probe.main(["--base-url", LOOPBACK, "--model", "标定专用模型", "--repeat", "1"], {
      log: QUIET,
      fetchImpl,
    });

    expect(requests).toHaveLength(probe.SAMPLES.length);
    for (let i = 0; i < requests.length; i += 1) {
      const request = requests[i]!;
      const expected = buildLocalLlmRequest(probe.SAMPLES[i]!.text, false);
      expect(request.url).toBe(`${LOOPBACK}/chat/completions`);
      expect(request.messages).toEqual(expected.messages);
      expect(request.body.temperature).toBe(0);
      expect(request.body.stream).toBe(false);
      expect(request.body.model).toBe("标定专用模型");
      // 未带 --structured ⇒ 不带 response_format（与产品的「能力来自声明」同一条）
      expect(request.body.response_format).toBeUndefined();
    }
    // 原文不加包装：user 消息就是样本本身，偏移锚点才不漂移。
    expect(requests[0]!.messages[1]!.content).toBe(probe.SAMPLES[0]!.text);
    expect(requests[0]!.messages[0]!.content).toContain(LOCAL_LLM_OUTPUT_SHAPE);
  });

  it("--structured ⇒ 按声明带上 response_format，schema 名取提示词版本", async () => {
    const probe = await loadProbe();
    const { fetchImpl, requests } = fakeEndpoint(() => OK_JSON);
    const run = await probe.main(
      ["--base-url", LOOPBACK, "--model", "m", "--structured", "--text", "编造的例子：李雷娜"],
      { log: QUIET, fetchImpl },
    );
    expect(run.exitCode).toBe(0);
    expect(requests[0]!.body.response_format).toEqual({
      type: "json_schema",
      name: LOCAL_LLM_PROMPT_VERSION,
    });
  });
});

/* ── T2 脏 JSON 仍然算合法（宽松解析） ──────────────────────────── */

describe("T2 前后夹说明文字 / ``` 围栏 ⇒ 宽松解析仍判合法", () => {
  const DIRTY = [
    "好的，下面是我的标注结果：",
    "```json",
    '{"candidates":[{"start":0,"end":3,"kind":"person","surface":"李雷娜"}]}',
    "```",
    "以上，希望有帮助。",
  ].join("\n");

  it("带说明文字与围栏的回稿 json=ok，候选照旧采信", async () => {
    const probe = await loadProbe();
    const { fetchImpl } = fakeEndpoint(() => envelope(DIRTY));
    const run = await probe.main(
      ["--base-url", LOOPBACK, "--model", "m", "--text", "李雷娜在白沙湾等韩梅梅。"],
      { log: QUIET, fetchImpl },
    );

    expect(run.exitCode).toBe(0);
    expect(run.rows[0]!.jsonOk).toBe(true);
    expect(run.rows[0]!.candidates).toBe(1);
    expect(run.lines.some((line) => line.includes("json=ok 候选=1"))).toBe(true);
  });
});

/* ── T3 越界 span ───────────────────────────────────────────────── */

describe("T3 越界 span ⇒ 丢进 out_of_range，脚本不抛", () => {
  const TEXT = "李雷娜在白沙湾等韩梅梅，三点散会。";

  it("end 超过原文长度 ⇒ 该候选被丢、原因分布里出现 out_of_range", async () => {
    const probe = await loadProbe();
    const { fetchImpl } = fakeEndpoint(() =>
      envelope(
        JSON.stringify({
          candidates: [
            { start: 0, end: TEXT.length + 50, kind: "person", surface: "李雷娜" },
            { start: 999, end: 1001, kind: "place", surface: "白沙湾" },
          ],
        }),
      ),
    );
    const run = await probe.main(
      ["--base-url", LOOPBACK, "--model", "m", "--text", TEXT, "--repeat", "1"],
      { log: QUIET, fetchImpl },
    );

    expect(run.exitCode).toBe(0);
    expect(run.rows[0]!.jsonOk).toBe(true);
    expect(run.rows[0]!.candidates).toBe(0);
    expect(run.rows[0]!.dropped.byReason.out_of_range).toBe(2);
    expect(run.summary!.dropTotals.out_of_range).toBe(2);
    expect(run.lines.join("\n")).toContain("out_of_range=2");
  });
});

/* ── T4 整体坏 JSON ─────────────────────────────────────────────── */

describe("T4 回稿根本不是 JSON ⇒ 该样本 json=bad，其余照常，退出码仍是 0", () => {
  it("第三个样本坏 JSON，其余合法", async () => {
    const probe = await loadProbe();
    const { fetchImpl } = fakeEndpoint((_userText, callIndex) =>
      callIndex === 2
        ? envelope("抱歉，我不太理解这个任务，下面是我的一段说明文字，没有花括号。")
        : OK_JSON,
    );
    const run = await probe.main(["--base-url", LOOPBACK, "--model", "m", "--repeat", "1"], {
      log: QUIET,
      fetchImpl,
    });

    expect(run.exitCode).toBe(0);
    expect(run.rows[2]!.jsonOk).toBe(false);
    expect(run.rows[2]!.failureKind).toBe("invalid_json");
    expect(run.rows[2]!.transportFailure).toBe(null);
    expect(run.rows.filter((row) => row.jsonOk)).toHaveLength(run.summary!.total - 1);
    expect(run.summary!.transportFailures).toBe(0);
    expect(run.lines[3]!).toContain("json=bad");
    expect(run.lines.join("\n")).toMatch(/合法率=\d+\.\d%/);
  });

  it("传输失败（超时）才是非 0 退出，坏 JSON 不是", async () => {
    const probe = await loadProbe();
    const { fetchImpl } = fakeEndpoint(() => ({ status: 503, body: "unavailable" }));
    const run = await probe.main(
      ["--base-url", LOOPBACK, "--model", "m", "--text", "编造的例子", "--repeat", "1"],
      { log: QUIET, fetchImpl },
    );
    expect(run.exitCode).not.toBe(0);
    expect(run.rows[0]!.transportFailure).toBe("http");
    expect(run.summary!.transportFailures).toBe(1);
  });
});

/* ── T5 非回环直接拒绝 ──────────────────────────────────────────── */

describe("T5 非回环 --base-url ⇒ 拒绝运行、一次请求都不发", () => {
  for (const baseUrl of ["http://8.8.8.8:11434/v1", "http://10.0.0.1:11434/v1", "https://api.example.com/v1"]) {
    it(`${baseUrl}：退出码非 0，fetch 调用数 0`, async () => {
      const probe = await loadProbe();
      const sink = collect();
      const spy = countingFetch();
      const run = await probe.main(["--base-url", baseUrl, "--model", "m"], {
        log: sink.log,
        fetchImpl: spy.fetchImpl,
      });

      expect(run.exitCode).toBe(probe.EXIT_NOT_LOOPBACK);
      expect(run.exitCode).not.toBe(0);
      expect(spy.calls).toHaveLength(0);
      expect(run.rows).toHaveLength(0);
      expect(run.lines.join("\n")).toContain("拒绝运行");
      expect(run.lines.join("\n")).toContain("回环");
      // 拒绝也不能读 --text-file：不碰任何文件
      expect(run.summary).toBe(null);
    });
  }

  it("--text-file 指向不存在的文件 ⇒ 用法错误退出码，不发请求", async () => {
    const probe = await loadProbe();
    const sink = collect();
    const spy = countingFetch();
    const run = await probe.main(
      ["--base-url", LOOPBACK, "--model", "m", "--text-file", "m9-5-nonexistent.txt"],
      { log: sink.log, fetchImpl: spy.fetchImpl },
    );
    expect(run.exitCode).toBe(probe.EXIT_USAGE);
    expect(spy.calls).toHaveLength(0);
    expect(run.lines.join("\n")).toContain("读不到 --text-file");
  });
});

/* ── T6 源码级禁区 ─────────────────────────────────────────────── */

describe("T6 脚本源码里没有写库 / 落盘 / 读配置的调用", () => {
  const source = readFileSync(SCRIPT_PATH, "utf8");

  const FORBIDDEN: { name: string; pattern: RegExp }[] = [
    { name: "元数据表", pattern: /app_meta/ },
    { name: "开库", pattern: /openDb|node:sqlite|DatabaseSync/ },
    { name: "应用配置文件", pattern: /config\.json|parseAppConfig|loadAppConfig|effectiveModelProfile/ },
    { name: "写文件", pattern: /writeFileSync|appendFileSync|mkdirSync|rmSync|createWriteStream/ },
    { name: "数据目录", pattern: /TB_DATA_DIR|USERPROFILE|process\.env/ },
    { name: "SQL", pattern: /\bSELECT\b|\bINSERT\b|\bUPDATE\b|\bDELETE\b|prepare\(/ },
  ];

  for (const { name, pattern } of FORBIDDEN) {
    it(`没有${name}的调用`, () => {
      expect(source).not.toMatch(pattern);
    });
  }

  it("可达模块只有那六个：装配层（config/db/grantService/api）一个都 import 不到", () => {
    const specifiers = [...source.matchAll(/from "([^"]+)"/g)].map((match) => match[1]!);
    expect([...new Set(specifiers)].sort()).toEqual(
      [
        "../src/server/ingest/provider.ts",
        "../src/server/privacy/localLlm.ts",
        "../src/server/privacy/localLlmPrompt.ts",
        "node:fs",
        "node:path",
        "node:url",
      ].sort(),
    );
  });

  it("提示词与校验都不另写一套：只 import 那四个纯函数", () => {
    expect(source).toContain("buildLocalLlmRequest");
    expect(source).toContain("parseLocalLlmResponse");
    expect(source).toContain("validateLocalLlmCandidates");
    expect(source).toContain("isLoopbackUrl");
    expect(source).toContain("sendChatCompletion");
    // 脚本里没有提示词正文、没有第二种 JSON 容错、没有第二套丢弃判定
    expect(source).not.toContain("【输出格式】");
    expect(source).not.toMatch(/JSON\.parse/);
    expect(source).not.toMatch(/surface_mismatch\s*[:=]/);
  });

  it("package.json 里有 npm run local-llm:probe 这条入口", () => {
    const pkgPath = fileURLToPath(new URL("../package.json", import.meta.url));
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { scripts: Record<string, string> };
    expect(pkg.scripts["local-llm:probe"]).toBe("node scripts/local-llm-probe.mjs");
  });
});

/* ── G1–G5 金标自身的断言（M9-D-16：金标漂移是数据错误，不许当成模型错误） ── */

describe("G 金标不许与原文漂移", () => {
  it("G1 每条 expected 的词面都能在所属原文里找到（occurrence 次以上）", async () => {
    const probe = await loadProbe();
    for (const sample of probe.SAMPLES) {
      const gold = probe.resolveGold(sample);
      expect(gold, `${sample.label} 应有金标`).not.toEqual(null);
      const drift = gold!.missing;
      expect(drift, `${sample.label} 的金标与原文对不上：${drift.join(", ")}`).toEqual([]);
      // 词面逐字取自原文（偏移由脚本算，所以这条同时钉住「没有手写偏移」）
      for (const span of gold!.spans) {
        expect(sample.text.slice(span.start, span.end)).toBe(span.surface);
      }
    }
  });

  it("G2 同一条样本内期望区间互不重叠（按算出来的偏移判定）", async () => {
    const probe = await loadProbe();
    for (const sample of probe.SAMPLES) {
      const spans = [...probe.resolveGold(sample)!.spans].sort((a, b) => a.start - b.start);
      for (let i = 1; i < spans.length; i += 1) {
        expect(
          spans[i]!.start >= spans[i - 1]!.end,
          `${sample.label}：「${spans[i - 1]!.surface}」与「${spans[i]!.surface}」区间重叠`,
        ).toBe(true);
      }
    }
  });

  it("G3 kind 全部在 ENTITY_REDACTION_KINDS 册内，不在册即失败", async () => {
    const probe = await loadProbe();
    for (const sample of probe.SAMPLES) {
      for (const entry of sample.expected) {
        expect(ENTITY_REDACTION_KINDS, `${sample.label}：kind ${entry.kind} 不在册`).toContain(entry.kind);
      }
    }
  });

  it("G4 负样本的 expected 是显式空数组，不是 undefined", async () => {
    const probe = await loadProbe();
    const negatives = probe.SAMPLES.filter((sample) => sample.label === "无敏感");
    expect(negatives.length).toBeGreaterThanOrEqual(2);
    for (const sample of probe.SAMPLES) {
      // 「忘写金标」与「确认无敏感」必须是两件事：任一样本金标缺失都直接失败。
      expect(Array.isArray(sample.expected), `${sample.label} 缺 expected 字段`).toBe(true);
    }
    for (const sample of negatives) {
      expect(sample.expected).toEqual([]);
      expect(probe.resolveGold(sample)!.spans).toEqual([]);
    }
  });

  it("G5 三条难样本各有一条实体落在代理对之后（这才真是偏移难样本）", async () => {
    const probe = await loadProbe();
    for (const label of ["代理对", "中英混排", "真长文本"]) {
      const sample = probe.SAMPLES.find((entry) => entry.label === label)!;
      const ends = surrogatePairEnds(sample.text);
      if (label === "中英混排") {
        // 中英混排这一条测的是「带空格英文词面 + 混排」，不含非 BMP 字符是设计内的：
        // 代理对的偏移难度由「代理对」「真长文本」两条负责，这里只钉它自己的难。
        expect(sample.text).toMatch(/[A-Za-z]{3,}\s[A-Za-z]{3,}/);
        expect(sample.expected.some((entry) => entry.surface.includes(" "))).toBe(true);
        continue;
      }
      expect(ends.length, `${label} 里没有代理对`).toBeGreaterThan(0);
      const afterPair = probe.resolveGold(sample)!.spans.filter((span) =>
        ends.some((end) => span.start > end),
      );
      expect(
        afterPair.length,
        `${label} 里没有任何实体的 UTF-16 起始偏移落在代理对之后`,
      ).toBeGreaterThan(0);
    }
  });
});

/* ── M1–M6 指标口径 ─────────────────────────────────────────────── */

describe("M 指标：召回 / 精确 / 类别错 / 更宽 / 部分 / 误报", () => {
  /**
   * M1–M4 钉的是**一遍**的算术（期望总条数、某一行打印的合计数），所以要显式 `--repeat 1`；
   * 缺省是 3 遍（M9-D-20），跨遍的算术在 B 组钉。M5/M6 不关心绝对数，留着走缺省路径。
   */
  const ARGS = ["--base-url", LOOPBACK, "--model", "m", "--repeat", "1"];

  /** 全部样本的期望总条数（负样本贡献 0）。 */
  function goldTotal(probe: ProbeModule): number {
    return probe.SAMPLES.reduce((sum, sample) => sum + sample.expected.length, 0);
  }

  function replyFrom(pick: (sample: ScoredSample, spans: GoldSpan[]) => Candidate[]) {
    return (probe: ProbeModule) =>
      fakeEndpoint((userText) => {
        const sample = sampleByText(probe, userText);
        if (sample === undefined) return OK_JSON;
        return envelopeOf(pick(sample, probe.resolveGold(sample)!.spans));
      });
  }

  it("M1 回稿与金标逐字一致 ⇒ 召回率 100%、精确率 100%、漏 0、误报 0", async () => {
    const probe = await loadProbe();
    const { fetchImpl } = replyFrom((_sample, spans) =>
      spans.map((span) => ({ start: span.start, end: span.end, kind: span.kind, surface: span.surface })),
    )(probe);
    const sink = collect();
    const run = await probe.main(ARGS, { log: sink.log, fetchImpl });

    const metrics = run.summary!.metrics;
    expect(run.exitCode).toBe(0);
    expect(metrics.expected).toBe(goldTotal(probe));
    expect(metrics.hits).toBe(metrics.expected);
    expect(metrics.misses).toBe(0);
    expect(metrics.wider).toBe(0);
    expect(metrics.partial).toBe(0);
    expect(metrics.falsePositive).toBe(0);
    expect(metrics.recall).toBe(100);
    expect(metrics.precision).toBe(100);
    // 打印口径与结构口径同源
    const joined = run.lines.join("\n");
    expect(joined).toContain("召回率=100.0%");
    expect(joined).toContain("精确率=100.0%");
    expect(joined).toContain("漏合计=0");
    expect(joined).toContain("误报合计=0");
    expect(joined).toContain("类别错合计=0");
    expect(joined).toContain("更宽合计=0");
    expect(joined).toContain("部分合计=0");
  });

  it("M2 只报一半 ⇒ 召回率按比例、漏数正确", async () => {
    const probe = await loadProbe();
    const { fetchImpl } = replyFrom((_sample, spans) =>
      spans
        .filter((_span, i) => i % 2 === 0)
        .map((span) => ({ start: span.start, end: span.end, kind: span.kind, surface: span.surface })),
    )(probe);
    const run = await probe.main(ARGS, { log: QUIET, fetchImpl });

    const metrics = run.summary!.metrics;
    expect(metrics.hits).toBeGreaterThan(0);
    expect(metrics.misses).toBeGreaterThan(0);
    expect(metrics.hits + metrics.misses).toBe(metrics.expected);
    expect(metrics.recall).toBeCloseTo((metrics.hits / metrics.expected) * 100, 6);
    expect(metrics.recall).not.toBe(100);
    // 报出来的那半全是命中 ⇒ 精确率仍是 100%（漏报不伤精确率，只伤召回率）
    expect(metrics.precision).toBe(100);

    // 单条样本的数也按比例：第一条样本 4 条期望 ⇒ 报 2 中 2 漏 2
    const first = probe.SAMPLES[0]!;
    const half = probe.resolveGold(first)!.spans
      .filter((_span, i) => i % 2 === 0)
      .map((span) => ({ start: span.start, end: span.end, kind: span.kind, surface: span.surface }));
    const single = probe.scoreSample(first, half);
    expect(single).toMatchObject({
      scored: true,
      expected: first.expected.length,
      reported: half.length,
      hits: half.length,
      misses: first.expected.length - half.length,
      kindWrong: 0,
      falsePositive: 0,
    });
  });

  it("M3 词面对、类别错 ⇒ 计入类别错，既不进命中也不进漏", async () => {
    const probe = await loadProbe();
    const swap: Record<string, string> = { person: "place", place: "person", organization: "person" };
    const { fetchImpl } = replyFrom((_sample, spans) =>
      spans.map((span) => ({
        start: span.start,
        end: span.end,
        kind: swap[span.kind] ?? "person",
        surface: span.surface,
      })),
    )(probe);
    const run = await probe.main(ARGS, { log: QUIET, fetchImpl });

    const metrics = run.summary!.metrics;
    expect(metrics.hits).toBe(0);
    expect(metrics.kindWrong).toBe(metrics.expected);
    expect(metrics.misses).toBe(0);
    expect(metrics.falsePositive).toBe(0);
    // 认对了片段 ⇒ 不算漏（该遮蔽的照样会被遮蔽，只是标签错）；单列的类别错负责暴露它
    expect(run.lines.join("\n")).toContain(`类别错合计=${metrics.expected}`);
    expect(run.lines.join("\n")).toContain("命中合计=0");
  });

  it("M4 负样本里报了东西 ⇒ 误报 > 0，且不动召回率分母", async () => {
    const probe = await loadProbe();
    const expectedTotal = goldTotal(probe);
    const { fetchImpl } = fakeEndpoint((userText) => {
      const sample = sampleByText(probe, userText);
      if (sample === undefined) return OK_JSON;
      if (sample.label !== "无敏感") return envelopeOf([]);
      const at = userText.indexOf("天气") >= 0 ? userText.indexOf("天气") : 0;
      const surface = userText.slice(at, at + 2);
      return envelopeOf([{ start: at, end: at + 2, kind: "person", surface }]);
    });
    const run = await probe.main(ARGS, { log: QUIET, fetchImpl });

    const metrics = run.summary!.metrics;
    expect(metrics.expected).toBe(expectedTotal);
    expect(metrics.falsePositive).toBeGreaterThan(0);
    expect(metrics.hits).toBe(0);
    expect(metrics.misses).toBe(expectedTotal);
    expect(metrics.recall).toBe(0);
    expect(metrics.precision).not.toBe(100);
    // 负样本自己：期望 0、命中 0、误报 1——它不进召回分母，只进精确分母
    for (const row of run.rows.filter((entry) => entry.label === "无敏感")) {
      expect(row.score.expected).toBe(0);
      expect(row.score.misses).toBe(0);
      expect(row.score.falsePositive).toBe(1);
    }
  });

  it("M5 一个候选都没报出 ⇒ 精确率 n/a（不是 100.0%）、召回率 0%", async () => {
    const probe = await loadProbe();
    const { fetchImpl } = fakeEndpoint(() => OK_JSON);
    const sink = collect();
    const run = await probe.main(["--base-url", LOOPBACK, "--model", "m"], { log: sink.log, fetchImpl });

    expect(run.summary!.metrics.reported).toBe(0);
    expect(run.summary!.metrics.precision).toBe(null);
    expect(run.summary!.metrics.recall).toBe(0);
    const joined = run.lines.join("\n");
    expect(joined).toContain("精确率=n/a");
    expect(joined).not.toContain("精确率=100.0%");
    expect(joined).toContain("召回率=0.0%");
    expect(run.exitCode).toBe(0);
  });

  it("M6 金标对不上是数据不是故障 ⇒ 退出码仍是 0", async () => {
    const probe = await loadProbe();
    // 故意错得离谱：全部报 `other`、词面全抄第一个字 ⇒ 一堆误报 + 一堆漏
    const { fetchImpl } = replyFrom((sample) => {
      const surface = sample.text.slice(0, 2);
      return [{ start: 0, end: 2, kind: "other", surface }];
    })(probe);
    const run = await probe.main(["--base-url", LOOPBACK, "--model", "m"], { log: QUIET, fetchImpl });

    expect(run.exitCode).toBe(0);
    expect(run.summary!.transportFailures).toBe(0);
    expect(run.summary!.metrics.misses).toBeGreaterThan(0);
    expect(run.summary!.metrics.recall).toBeLessThan(100);
  });

  it("外部文本（--text）无金标 ⇒ 不进任何分母，也不假装 0 分", async () => {
    const probe = await loadProbe();
    const { fetchImpl } = fakeEndpoint(() =>
      envelope(JSON.stringify({ candidates: [{ start: 0, end: 3, kind: "person", surface: "李雷娜" }] })),
    );
    const run = await probe.main(
      ["--base-url", LOOPBACK, "--model", "m", "--text", "李雷娜在白沙湾等韩梅梅。"],
      { log: QUIET, fetchImpl },
    );

    const metrics = run.summary!.metrics;
    expect(metrics.scoredSamples).toBe(0);
    expect(metrics.expected).toBe(0);
    expect(metrics.reported).toBe(0);
    expect(metrics.precision).toBe(null);
    expect(metrics.recall).toBe(null);
    expect(run.rows[0]!.candidates).toBe(1);
    expect(run.rows[0]!.score.scored).toBe(false);
    expect(run.exitCode).toBe(0);
  });
});

/* ── B1–B9 五桶匹配与重复（准则 §二之二 M9-D-18 / M9-D-20） ──────── */

describe("B 五桶匹配（命中/类别错/更宽/部分/误报）与 --repeat", () => {
  /** 金标区间 ⇒ 候选（`shift` 为正＝多包几个字（更宽），为负＝少遮几个字（部分））。 */
  function asCandidates(spans: GoldSpan[], text: string, shift = 0): Candidate[] {
    return spans.map((span) => {
      const end = span.end + shift;
      return { start: span.start, end, kind: span.kind, surface: text.slice(span.start, end) };
    });
  }

  /** 把某一条期望换成「更宽的读法」（右端多吃 `extra` 个字），其余逐字回给脚本。 */
  function widenOne(spans: GoldSpan[], text: string, surface: string, extra: string): Candidate[] {
    return spans.map((span) => {
      if (span.surface !== surface) {
        return { start: span.start, end: span.end, kind: span.kind, surface: span.surface };
      }
      const end = span.end + extra.length;
      return { start: span.start, end, kind: span.kind, surface: text.slice(span.start, end) };
    });
  }

  function sampleOf(probe: ProbeModule, needle: string): ScoredSample {
    const sample = probe.SAMPLES.find((entry) => entry.text.includes(needle));
    if (sample === undefined) throw new Error(`样本集里没有「${needle}」`);
    return sample;
  }

  it("B1 候选严格包住期望 ⇒ 更宽=1、漏=0、误报=0（青鹿大道北口 / 岚水镇文化活动中心）", async () => {
    const probe = await loadProbe();
    const cases: { needle: string; surface: string; extra: string }[] = [
      { needle: "青鹿大道北口", surface: "青鹿大道", extra: "北口" },
      { needle: "岚水镇文化活动中心", surface: "岚水镇", extra: "文化活动中心" },
    ];
    for (const { needle, surface, extra } of cases) {
      const sample = sampleOf(probe, needle);
      const spans = probe.resolveGold(sample)!.spans;
      const target = spans.find((span) => span.surface === surface)!;
      // 这条「更宽的读法」确实逐字长在原文里，且多吃的就是那 `extra` 个字
      expect(sample.text.slice(target.start, target.end + extra.length)).toBe(needle);
      const score = probe.scoreSample(sample, widenOne(spans, sample.text, surface, extra));
      expect(score, needle).toMatchObject({
        scored: true,
        expected: spans.length,
        reported: spans.length,
        hits: spans.length - 1,
        kindWrong: 0,
        wider: 1,
        partial: 0,
        misses: 0,
        falsePositive: 0,
      });
      // 旧口径在这里是「漏 1 + 误报 1」双重扣分；新口径下两个率都不掉
      expect(probe.summarize([{ score }]).recall, needle).toBe(100);
      expect(probe.summarize([{ score }]).precision, needle).toBe(100);
    }
  });

  it("B2 候选严格在期望内 ⇒ 部分=1，既不进命中也不进漏，但不进召回/精确分子", async () => {
    const probe = await loadProbe();
    const sample: ScoredSample = {
      label: "地名",
      text: "沿着青鹿大道往北走两公里。",
      expected: [{ kind: "place", surface: "青鹿大道" }],
    };
    const span = probe.resolveGold(sample)!.spans[0]!;
    const score = probe.scoreSample(sample, asCandidates([span], sample.text, -1));
    expect(score).toMatchObject({
      scored: true,
      expected: 1,
      reported: 1,
      hits: 0,
      kindWrong: 0,
      wider: 0,
      partial: 1,
      falsePositive: 0,
    });
    // 「部分」把这条期望吃掉了 ⇒ 不再重复计入 `漏`（否则又是一次双重扣分）
    expect(score.misses).toBe(0);
    const metrics = probe.summarize([{ score }]);
    expect(metrics.recall).toBe(0);
    expect(metrics.precision).toBe(0);
  });

  it("B3 包含但类别不同 ⇒ 计入类别错而不是更宽（类别错优先于宽窄判定）", async () => {
    const probe = await loadProbe();
    const sample = sampleOf(probe, "岚水镇文化活动中心");
    const spans = probe.resolveGold(sample)!.spans;
    const town = spans.find((span) => span.surface === "岚水镇")!;
    const reply = spans.map((span) =>
      span === town
        ? {
            start: span.start,
            end: span.end + "文化活动中心".length,
            kind: "organization",
            surface: "岚水镇文化活动中心",
          }
        : { start: span.start, end: span.end, kind: span.kind, surface: span.surface },
    );
    const score = probe.scoreSample(sample, reply);
    expect(score.kindWrong).toBe(1);
    expect(score.wider).toBe(0);
    expect(score.hits).toBe(spans.length - 1);
    expect(score.misses).toBe(0);
    expect(score.falsePositive).toBe(0);
    // 类别错进两个分子（与 `更宽` 一样遮住住了），所以召回仍是 100
    expect(probe.summarize([{ score }]).recall).toBe(100);
  });

  it("B4 两条恒等式对每个样本、每套候选都成立", async () => {
    const probe = await loadProbe();
    for (const sample of probe.SAMPLES) {
      const spans = probe.resolveGold(sample)!.spans;
      const junk: Candidate[] = [{ start: 0, end: 1, kind: "other", surface: sample.text.slice(0, 1) }];
      const variants: { name: string; reply: Candidate[] }[] = [
        { name: "空报", reply: [] },
        { name: "逐字全中", reply: asCandidates(spans, sample.text) },
        { name: "全部更宽", reply: asCandidates(spans, sample.text, +1) },
        { name: "全部只遮一半", reply: asCandidates(spans, sample.text, -1) },
        { name: "宽窄混合", reply: [...asCandidates(spans.slice(0, 1), sample.text, +2), ...asCandidates(spans.slice(1), sample.text, -1)] },
        { name: "全加一条对不上的", reply: [...asCandidates(spans, sample.text), ...junk] },
      ];
      for (const { name, reply } of variants) {
        const score = probe.scoreSample(sample, reply);
        const where = `${sample.label} / ${name}`;
        expect(
          score.hits + score.kindWrong + score.wider + score.partial + score.misses,
          `${where}：期望那一侧数不平`,
        ).toBe(score.expected);
        expect(
          score.hits + score.kindWrong + score.wider + score.partial + score.falsePositive,
          `${where}：报出那一侧数不平`,
        ).toBe(score.reported);
        const metrics = probe.summarize([{ score }]);
        if (score.expected > 0) {
          expect(metrics.recall, where).toBeCloseTo(
            ((score.hits + score.kindWrong + score.wider) / score.expected) * 100,
            9,
          );
        }
        if (score.reported > 0) {
          expect(metrics.precision, where).toBeCloseTo(
            ((score.hits + score.kindWrong + score.wider) / score.reported) * 100,
            9,
          );
        }
      }
    }
  });

  it("B5 样本 5 的期望补了 旧码头 ⇒ 三条，且 G1/G2 仍然成立", async () => {
    const probe = await loadProbe();
    const fifth = probe.SAMPLES[4]!;
    expect(fifth.label).toBe("地名");
    expect(fifth.expected).toHaveLength(3);
    expect(fifth.expected.map((entry) => entry.surface)).toEqual(["白沙湾", "青鹿大道", "旧码头"]);
    const gold = probe.resolveGold(fifth)!;
    expect(gold.missing).toEqual([]); // G1
    const spans = [...gold.spans].sort((a, b) => a.start - b.start);
    for (let i = 1; i < spans.length; i += 1) {
      expect(spans[i]!.start >= spans[i - 1]!.end).toBe(true); // G2
    }
    // 金标口径必须**处处一致**：凡是原文里出现 `旧码头` 的样本，金标都得认它。
    // 最初只在样本 5 补了这一条，结果同一个词在另外两条长样本里出现时，模型做**同样正确**的
    // 判断会被算成误报——那不是模型不稳定，是金标自相矛盾。这里钉的是不变式，不是条数：
    // 哪天再加一条含 `旧码头` 的样本，忘了补金标，这条会红。
    const samplesWithWharf = probe.SAMPLES.filter((sample) => sample.text.includes("旧码头"));
    expect(samplesWithWharf.length).toBeGreaterThan(0);
    for (const sample of samplesWithWharf) {
      expect(
        sample.expected.some((entry) => entry.surface === "旧码头" && entry.kind === "place"),
        `${sample.label} 的原文含「旧码头」，金标却没认它`,
      ).toBe(true);
    }
  });

  it("样本行同时打印 更宽= 与 部分= 两栏", async () => {
    const probe = await loadProbe();
    const target = sampleOf(probe, "岚水镇文化活动中心");
    const { fetchImpl } = fakeEndpoint((userText) => {
      const sample = sampleByText(probe, userText);
      if (sample === undefined) return OK_JSON;
      const spans = probe.resolveGold(sample)!.spans;
      if (sample !== target) return envelopeOf(asCandidates(spans, sample.text));
      // 一条更宽（岚水镇→岚水镇文化活动中心）+ 一条只遮一半（穿山甲→穿山）
      const town = spans.find((span) => span.surface === "岚水镇")!;
      const alias = spans.find((span) => span.surface === "穿山甲")!;
      return envelopeOf([
        ...spans.filter((span) => span !== town && span !== alias).map((span) => asCandidates([span], sample.text)[0]!),
        { start: town.start, end: town.end + "文化活动中心".length, kind: "place", surface: "岚水镇文化活动中心" },
        { start: alias.start, end: alias.start + 2, kind: "person", surface: "穿山" },
      ]);
    });
    const run = await probe.main(["--base-url", LOOPBACK, "--model", "m", "--repeat", "1"], {
      log: QUIET,
      fetchImpl,
    });
    const line = run.lines.find((entry) => entry.startsWith("样本 ") && entry.includes("更宽=1 部分=1"));
    expect(line, "样本行里没有 更宽=1 部分=1 这两栏").toBeDefined();
    expect(line).toContain(`[${target.label}]`);
    expect(run.lines.join("\n")).toContain("更宽合计=1 部分合计=1");
  });

  it("B6 --repeat 3 且三遍回稿不同 ⇒ 最小/中位/最大成行，不稳定样本被点名", async () => {
    const probe = await loadProbe();
    const total = probe.SAMPLES.length;
    const target = sampleOf(probe, "岚水镇文化活动中心");
    const targetIndex = probe.SAMPLES.indexOf(target) + 1;
    const junk = ((): Candidate => {
      const at = target.text.indexOf("预算");
      return { start: at, end: at + 2, kind: "person", surface: "预算" };
    })();
    const { fetchImpl } = fakeEndpoint((userText, callIndex) => {
      const sample = sampleByText(probe, userText);
      if (sample === undefined) return OK_JSON;
      const spans = probe.resolveGold(sample)!.spans;
      if (sample !== target) return envelopeOf(asCandidates(spans, sample.text));
      const pass = Math.floor(callIndex / total);
      if (pass === 1) return envelopeOf(asCandidates(spans, sample.text).slice(1));
      if (pass === 2) return envelopeOf([...asCandidates(spans, sample.text), junk]);
      return envelopeOf(asCandidates(spans, sample.text));
    });
    const sink = collect();
    const run = await probe.main(["--base-url", LOOPBACK, "--model", "m", "--repeat", "3"], {
      log: sink.log,
      fetchImpl,
    });

    expect(run.exitCode).toBe(0);
    expect(run.rows).toHaveLength(total * 3);
    expect(run.summary!.sampleCount).toBe(total);
    expect(run.summary!.repeats).toBe(3);
    expect(run.summary!.passes).toHaveLength(3);
    expect(run.lines.filter((line) => line.startsWith("— 第 "))).toHaveLength(3);
    expect(run.lines.filter((line) => line.startsWith("标定 召回率="))).toHaveLength(3);

    const stats = run.summary!.statistics;
    expect(stats.repeats).toBe(3);
    const repeatLines = run.lines.filter((line) => line.startsWith("重复 3 次 "));
    expect(repeatLines).toHaveLength(3);
    // 打印的数与结构的数同源
    expect(repeatLines[0]).toBe(
      `重复 3 次 召回 最小=${stats.recall.min!.toFixed(1)}% 中位=${stats.recall.median!.toFixed(1)}% 最大=${stats.recall.max!.toFixed(1)}%`,
    );
    expect(repeatLines[1]).toBe(
      `重复 3 次 精确 最小=${stats.precision.min!.toFixed(1)}% 中位=${stats.precision.median!.toFixed(1)}% 最大=${stats.precision.max!.toFixed(1)}%`,
    );
    expect(repeatLines[2]).toBe(`重复 3 次 结果不稳定的样本 = ${targetIndex}`);
    expect(stats.unstableSamples).toEqual([targetIndex]);
    // 三遍各错一样：少一条（伤召回）、多一条对不上的（伤精确）、全中
    // `min/median/max` 的类型是 `number | null`（分母为 0 时是 `n/a`）；这三遍都有分母，
    // 上一行又已经按非空打印过，所以这里断非空之后再比大小——不是把它们强转成 0。
    expect(stats.recall.min).not.toBeNull();
    expect(stats.precision.min).not.toBeNull();
    expect(stats.recall.min!).toBeLessThan(stats.recall.max!);
    expect(stats.precision.min!).toBeLessThan(stats.precision.max!);
    expect(stats.recall.max).toBe(100);
    expect(stats.precision.max).toBe(100);
  });

  it("B7 中位数取法：奇数取中间，偶数取中间两个的平均", async () => {
    const probe = await loadProbe();
    expect(probe.median([3])).toBe(3);
    expect(probe.median([5, 1, 3])).toBe(3);
    expect(probe.median([4, 1, 3, 2])).toBe(2.5);
    expect(probe.median([2, 4])).toBe(3);
    expect(probe.median([])).toBe(null);
    expect(probe.spreadOf([3, 1, 2])).toEqual({ min: 1, median: 2, max: 3 });
    expect(probe.spreadOf([2, 4, 6, 8])).toEqual({ min: 2, median: 5, max: 8 });
    // 分母为 0 的那些遍（null）先剔掉，不按 0 计
    expect(probe.spreadOf([null, 2, null])).toEqual({ min: 2, median: 2, max: 2 });
    expect(probe.spreadOf([null, null])).toEqual({ min: null, median: null, max: null });
    expect(probe.unstableIndexes([])).toEqual([]);
  });

  it("B8 --repeat 1 的输出不含「重复」段（缺省是 3，且 --repeat 非法值报用法）", async () => {
    const probe = await loadProbe();
    expect(probe.DEFAULT_REPEAT).toBe(3);
    const parsed = probe.parseArgv(["--base-url", LOOPBACK, "--model", "m"]);
    expect(parsed.ok && parsed.options.repeat).toBe(3);
    for (const bad of [["--repeat", "0"], ["--repeat", "-1"], ["--repeat", "abc"], ["--repeat", "1.5"]]) {
      const outcome = probe.parseArgv(["--base-url", LOOPBACK, "--model", "m", ...bad]);
      expect(outcome.ok, bad.join(" ")).toBe(false);
      expect(!outcome.ok && outcome.error).toContain("正整数重复次数");
    }

    const { fetchImpl } = fakeEndpoint(() => OK_JSON);
    const run = await probe.main(["--base-url", LOOPBACK, "--model", "m", "--repeat", "1"], {
      log: QUIET,
      fetchImpl,
    });
    const joined = run.lines.join("\n");
    // 口径：单遍**不打**跨遍段（一行汇总就是那一遍的数，再打一遍是噪音）；分隔行也不打。
    expect(run.lines.filter((line) => line.startsWith("重复 "))).toEqual([]);
    expect(joined).not.toContain("— 第 ");
    expect(joined).toContain("重复=1");
    expect(run.summary!.statistics.recall.median).toBe(run.summary!.metrics.recall);
    expect(run.summary!.statistics.unstableSamples).toEqual([]);
  });

  it("B9 某一遍传输失败 ⇒ 退出码仍非 0，其余各遍照常打完", async () => {
    const probe = await loadProbe();
    const total = probe.SAMPLES.length;
    const { fetchImpl } = fakeEndpoint((_userText, callIndex) =>
      callIndex === total + 2 ? { status: 503, body: "unavailable" } : OK_JSON,
    );
    const run = await probe.main(["--base-url", LOOPBACK, "--model", "m", "--repeat", "3"], {
      log: QUIET,
      fetchImpl,
    });
    expect(run.exitCode).not.toBe(0);
    expect(run.summary!.transportFailures).toBe(1);
    // 三遍都跑完了：三段样本行、三段汇总
    expect(run.lines.filter((line) => line.startsWith("样本 "))).toHaveLength(total * 3);
    expect(run.lines.filter((line) => line.startsWith("汇总 样本="))).toHaveLength(3);
    expect(run.lines.filter((line) => line.startsWith("标定 召回率="))).toHaveLength(3);
    expect(run.lines.filter((line) => line.startsWith("警告 "))).toHaveLength(1);
    expect(run.rows.filter((row) => row.transportFailure !== null)).toHaveLength(1);
  });
});

/* ── C1–C6 长文本分段征询的实验（准则 §二之二 M9-D-22：只在 probe 里验，不进产品） ── */

describe("C 分段征询：切分、偏移平移、两处校验与对比表", () => {
  /** 分段实验要在**同一条命令行**上与整段比：除了 `--chunk`，其余口径一字不改。 */
  const ARGS = ["--base-url", LOOPBACK, "--model", "m", "--repeat", "1"];

  /** 一段里有几行：段尾那个 `\n` 不算多一行。 */
  function lineCount(slice: string): number {
    return slice.replace(/\n$/, "").split("\n").length;
  }

  const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff;
  const isLowSurrogate = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff;

  /**
   * 切分的地基：各段区间首尾相接、不重不漏，拼回去逐字等于原文。
   * 偏移平移靠的就是这个——这里只要错一个单元，整张对比表就不可信。
   */
  function expectLossless(text: string, chunks: ProbeChunk[]): void {
    expect(chunks.map((chunk) => chunk.text).join("")).toBe(text);
    let cursor = 0;
    for (const chunk of chunks) {
      expect(chunk.start).toBe(cursor);
      expect(chunk.end).toBe(cursor + chunk.text.length);
      expect(text.slice(chunk.start, chunk.end)).toBe(chunk.text);
      cursor = chunk.end;
    }
    expect(cursor).toBe(text.length);
  }

  /** 没有任何切点落在代理对中间（C3 的判据，逐段两头各查一次）。 */
  function expectNoSurrogateCut(text: string, chunks: ProbeChunk[]): void {
    for (const chunk of chunks) {
      if (chunk.start > 0) {
        const before = text.charCodeAt(chunk.start - 1);
        expect(isHighSurrogate(before), `切点 ${chunk.start} 落在代理对中间`).toBe(false);
        // 比「不是代理对」更强的一条：切点只可能是换行之后。
        expect(before, `切点 ${chunk.start} 不在行边界`).toBe(0x0a);
      }
      if (chunk.end < text.length) {
        expect(isLowSurrogate(text.charCodeAt(chunk.end)), `段尾 ${chunk.end} 切断代理对`).toBe(false);
      }
    }
  }

  /**
   * 假端点的回稿表：`原文切片 → 该切片内金标的**局部**坐标`。
   * 整段那一侧的键是样本全文（局部 == 全局），分段那一侧的键是 `chunkText` 切出的每一段——
   * 同一条表服务两种跑法，两边读的是同一份金标，差别只在「一次发多少字」。
   */
  function goldReplyTable(probe: ProbeModule, maxChars: number): Map<string, Candidate[]> {
    const table = new Map<string, Candidate[]>();
    const put = (key: string, list: Candidate[]): void => {
      const prior = table.get(key);
      if (prior !== undefined && JSON.stringify(prior) !== JSON.stringify(list)) {
        throw new Error(`分段上限 ${maxChars} 下「${key.slice(0, 16)}…」同时要求两种不同的回稿，换一个上限`);
      }
      table.set(key, list);
    };
    for (const sample of probe.SAMPLES) {
      const spans = probe.resolveGold(sample)!.spans;
      put(
        sample.text,
        spans.map((span) => ({ start: span.start, end: span.end, kind: span.kind, surface: span.surface })),
      );
      for (const chunk of probe.chunkText(sample.text, maxChars)) {
        put(
          chunk.text,
          spans
            .filter((span) => span.start >= chunk.start && span.end <= chunk.end)
            .map((span) => ({
              start: span.start - chunk.start,
              end: span.end - chunk.start,
              kind: span.kind,
              surface: span.surface,
            })),
        );
      }
    }
    return table;
  }

  /** 找一个每段都能被假端点唯一认回来的上限；撞车就由 `goldReplyTable` 抛出来换下一个。 */
  function pickChunkWidth(probe: ProbeModule): number {
    for (const maxChars of [40, 60, 90, 120, 200, 400]) {
      try {
        const table = goldReplyTable(probe, maxChars);
        // 段数确实>1 才有实验意义：至少要有一条样本被切开过。
        const segments = probe.SAMPLES.reduce(
          (sum, sample) => sum + probe.chunkText(sample.text, maxChars).length,
          0,
        );
        if (table.size > 0 && segments > probe.SAMPLES.length) return maxChars;
      } catch {
        // 换一个上限重试
      }
    }
    throw new Error("样本集里找不到可用的分段上限");
  }

  /** 按上表回稿的假端点：认不出来的切片一律记下来（测试断言它为空，免得悄悄回空把召回打没）。 */
  function tableEndpoint(probe: ProbeModule, maxChars: number): {
    fetchImpl: typeof fetch;
    requests: CapturedRequest[];
    unmatched: string[];
  } {
    const table = goldReplyTable(probe, maxChars);
    const unmatched: string[] = [];
    const inner = fakeEndpoint((userText) => {
      const reply = table.get(userText);
      if (reply === undefined) {
        unmatched.push(userText.slice(0, 20));
        return OK_JSON;
      }
      return envelopeOf(reply);
    });
    return { fetchImpl: inner.fetchImpl, requests: inner.requests, unmatched };
  }

  it("C1 五段不同长度的行 ⇒ 拼回去逐字等于原文；每段 ≤ maxChars 或该段只有一行", async () => {
    const probe = await loadProbe();
    const text = [
      "第一行很短。",
      "第二行中等长度，大概二十来个字，够和上一行攒到一块儿。",
      "第三行是最长的一行，长到单独就超过上限，所以它必须整段发出去，不许为了切得均匀而把它切开。",
      "第四行也短。",
      "第五行不短不长，用来检验切点是不是只落在换行之后。",
    ].join("\n");
    const maxChars = 40;
    const chunks = probe.chunkText(text, maxChars);

    expectLossless(text, chunks);
    // 贪心攒行：第 1+2 行攒一段、超长的第 3 行独占一段、第 4+5 行攒一段。
    // 钉「几行一段」而不是钉字数：字数由原文决定，行分组才是这条切分规则本身。
    expect(chunks.map((chunk) => lineCount(chunk.text))).toEqual([2, 1, 2]);
    expect(chunks[1]!.text).toContain("第三行是最长的一行");
    expect(chunks[1]!.text.length).toBeGreaterThan(maxChars);
    for (const chunk of chunks) {
      expect(chunk.text.length <= maxChars || lineCount(chunk.text) === 1, chunk.text).toBe(true);
    }
    // 缺省上限就是 400（`--compare` 不带 `--chunk` 时走它）
    expect(probe.DEFAULT_CHUNK_MAX_CHARS).toBe(400);
    expect(probe.chunkText(text).length).toBe(1);
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(() => probe.chunkText(text, bad), String(bad)).toThrow(/正整数/);
    }
  });

  it("C2 单行超过上限 ⇒ 单独成段，不被切开", async () => {
    const probe = await loadProbe();
    const only = "甲".repeat(60);
    expect(probe.chunkText(only, 10)).toEqual([{ start: 0, end: 60, text: only }]);

    const text = ["短行。", only, "尾行。"].join("\n");
    const chunks = probe.chunkText(text, 10);
    expectLossless(text, chunks);
    const oversized = chunks.filter((chunk) => chunk.text.length > 10);
    expect(oversized).toHaveLength(1);
    expect(oversized[0]!.text).toBe(`${only}\n`);
    expect(lineCount(oversized[0]!.text)).toBe(1);
  });

  it("C3 含代理对（emoji 与扩展区字）⇒ 没有任何切点在代理对中间", async () => {
    const probe = await loadProbe();
    const text = [
      "集合点在青鹿大道北口🚇，李雷娜背着包🎒站在路口等他。",
      "她朋友𠮷水勇（网名夜航船）刚从白沙湾坐船过来，迟到了十分钟。",
      "整段都是代理对：😀😀😀 𠮷𠮷𠮷 段尾也是🚇",
      "三个人最后去了城南棋牌室，路上又碰见韩梅梅。",
    ].join("\n");
    for (const maxChars of [7, 13, 25, 40, 400]) {
      const chunks = probe.chunkText(text, maxChars);
      expectLossless(text, chunks);
      expectNoSurrogateCut(text, chunks);
    }

    // 真实样本集也一样：每条样本、每个上限都不许切出半个代理对
    for (const sample of probe.SAMPLES) {
      for (const maxChars of [10, 40, 120, 400]) {
        const chunks = probe.chunkText(sample.text, maxChars);
        expectLossless(sample.text, chunks);
        expectNoSurrogateCut(sample.text, chunks);
      }
    }
  });

  it("C4 分段回稿平移后对全文逐字对得上，打分与整段跑完全一致", async () => {
    const probe = await loadProbe();
    const total = probe.SAMPLES.length;
    const maxChars = pickChunkWidth(probe);
    const wholeSide = tableEndpoint(probe, maxChars);
    const whole = await probe.main(ARGS, { log: QUIET, fetchImpl: wholeSide.fetchImpl });
    expect(wholeSide.unmatched).toEqual([]);

    const chunkSide = tableEndpoint(probe, maxChars);
    const chunked = await probe.main([...ARGS, "--chunk", String(maxChars)], {
      log: QUIET,
      fetchImpl: chunkSide.fetchImpl,
    });
    expect(chunkSide.unmatched).toEqual([]);
    expect(chunked.exitCode).toBe(0);
    expect(chunked.rows.every((row) => row.mode === "chunked")).toBe(true);
    // 分段一侧真的多发了请求（不然比的是同一件事）
    expect(chunkSide.requests.length).toBeGreaterThan(wholeSide.requests.length);
    expect(wholeSide.requests.length).toBe(total);
    const long = chunked.rows.find((row) => row.label === "真长文本")!;
    expect(long.chunkCount).toBeGreaterThan(1);

    const byStart = (list: Candidate[]): Candidate[] =>
      [...list].sort((a, b) => a.start - b.start || a.end - b.end);
    for (let i = 0; i < total; i += 1) {
      const sample = probe.SAMPLES[i]!;
      const single = whole.rows[i]!;
      const split = chunked.rows[i]!;
      // 第二处校验（按全文）不丢任何东西：平移是对的
      expect(split.mergeMismatch, sample.label).toBe(0);
      expect(split.dropped.byReason.merge_mismatch, sample.label).toBe(0);
      for (const candidate of split.admitted) {
        expect(candidate.start, sample.label).toBeGreaterThanOrEqual(0);
        expect(candidate.end, sample.label).toBeLessThanOrEqual(sample.text.length);
        expect(sample.text.slice(candidate.start, candidate.end), `${sample.label} 平移后对不上`).toBe(
          candidate.surface,
        );
      }
      expect(byStart(split.admitted), sample.label).toEqual(byStart(single.admitted));
      // 口径与整段跑完全一致（同一个 scoreSample、同一套五桶）
      expect(split.score, sample.label).toEqual(single.score);
    }
    expect(whole.summary!.metrics.recall).toBe(100);
    expect(chunked.summary!.metrics).toEqual(whole.summary!.metrics);
    expect(chunked.summary!.chunkMaxChars).toBe(maxChars);
    // 分段一侧的丢弃原因里数出了 `merge_mismatch` 这一栏
    expect(chunked.lines.join("\n")).toContain("merge_mismatch=0");
  });

  it("C5 合并校验真会丢：平移后对不上的候选进 merge_mismatch，且不抛", async () => {
    const probe = await loadProbe();
    const text = "李雷娜在白沙湾。\n韩梅梅在青鹿大道。";
    const chunks = probe.chunkText(text, 8);
    expect(chunks.length).toBe(2);

    const bad = { start: 0, end: 3, kind: "person", surface: "不是这一段的词面" };
    const merged = probe.mergeChunkCandidates(
      text,
      chunks,
      [
        [{ start: 0, end: 3, kind: "person", surface: "李雷娜" }],
        [bad, { start: 0, end: 3, kind: "person", surface: "韩梅梅" }],
      ],
    );
    expect(merged.mergeMismatch).toBe(1);
    expect(merged.candidates.map((candidate) => candidate.surface)).toEqual(["李雷娜", "韩梅梅"]);
    // 平移后的坐标确实是全文坐标：第二段从偏移 9 起（第一段连行尾 `\n` 共 9 个单元）
    expect(merged.candidates[1]).toMatchObject({ start: 9, end: 12 });

    // 越界的也丢：`end` 顶到全文之外
    const outOfRange = probe.mergeChunkCandidates(text, chunks, [
      [{ start: 0, end: 999, kind: "place", surface: "白沙湾" }],
      [],
    ]);
    expect(outOfRange.mergeMismatch).toBe(1);
    expect(outOfRange.candidates).toEqual([]);
    expect(() => probe.mergeChunkCandidates(text, chunks, [[], []])).not.toThrow();

    // 这个计数确实进了行数据与打印：分段一侧的丢弃原因表里有它
    const maxChars = pickChunkWidth(probe);
    const { fetchImpl } = tableEndpoint(probe, maxChars);
    const run = await probe.main([...ARGS, "--chunk", String(maxChars)], { log: QUIET, fetchImpl });
    for (const row of run.rows) {
      expect(Object.keys(row.dropped.byReason)).toContain("merge_mismatch");
    }
  });

  it("C6 --compare ⇒ 同一条样本逐条并排打两行，末尾给对比汇总与三条判据", async () => {
    const probe = await loadProbe();
    // 这一条专门验「不给 --chunk、对比模式自己走缺省上限」——回稿表就必须按缺省上限来切。
    const maxChars = probe.DEFAULT_CHUNK_MAX_CHARS;
    const endpoint = tableEndpoint(probe, maxChars);
    const sink = collect();
    const run = await probe.main([...ARGS, "--compare"], { log: sink.log, fetchImpl: endpoint.fetchImpl });
    const joined = run.lines.join("\n");

    expect(run.exitCode).toBe(0);
    expect(endpoint.unmatched).toEqual([]);
    const total = probe.SAMPLES.length;
    expect(run.lines.filter((line) => line.includes("] 整段 json="))).toHaveLength(total);
    expect(run.lines.filter((line) => line.includes("] 分段 段数="))).toHaveLength(total);
    // 并排：两种跑法的行紧挨着，按样本序号成对出现
    const pairs = run.lines.filter((line) => line.startsWith("样本 "));
    expect(pairs[0]).toContain("] 整段 json=");
    expect(pairs[1]).toContain("] 分段 段数=");
    expect(pairs[2]).toContain("] 整段 json=");
    // 分段那一侧的行走 `summary.compare.chunked.rows`（`main` 返回的 `rows` 只装整段一侧）
    expect(run.summary!.compare!.chunked.rows.filter((row) => row.mode === "chunked")).toHaveLength(total);
    expect(run.rows.filter((row) => row.mode === "whole")).toHaveLength(total);
    // 表里两边的数都在
    expect(joined).toContain("合并丢弃=0");
    expect(run.lines.filter((line) => line.startsWith("对比 第1/1遍 "))).toHaveLength(2);
    expect(run.lines.some((line) => line.startsWith("对比 第1/1遍 整段 总耗时=") && line.includes("最慢样本="))).toBe(true);
    expect(
      run.lines.some(
        (line) => line.startsWith("对比 第1/1遍 分段 段数=") && line.includes("最慢段=") && line.includes("合并丢弃="),
      ),
    ).toBe(true);
    for (const prefix of [
      "对比汇总 整段 总耗时=",
      "对比汇总 分段 段数=",
      "对比汇总 延迟 分段/整段=",
      "对比汇总 判据1",
      "对比汇总 判据2",
      "对比汇总 判据3",
    ]) {
      expect(joined, prefix).toContain(prefix);
    }
    // 召回与精确两边同口径都是 100%（金标逐字回，分段没把任何一个字面弄丢）
    expect(run.summary!.compare).not.toBeNull();
    expect(run.summary!.compare!.whole.metrics.recall).toBe(100);
    expect(run.summary!.compare!.chunked.metrics.recall).toBe(100);
    expect(run.summary!.compare!.chunked.metrics).toEqual(run.summary!.compare!.whole.metrics);
    expect(run.summary!.compare!.chunked.mergeMismatch).toBe(0);
    expect(run.summary!.compare!.chunked.segmentCount).toBeGreaterThan(total);
    // 不带 `--chunk` 时对比模式走缺省上限，并在首行写明
    expect(run.lines[0]).toContain(`对比模式 · 分段上限=${probe.DEFAULT_CHUNK_MAX_CHARS}字符`);
    // 对比模式下不再打单侧的 汇总/标定 行（换成对比行），也不再有 `样本 i/N [label] json=` 那种裸行
    expect(run.lines.filter((line) => line.startsWith("汇总 样本="))).toEqual([]);
    expect(run.lines.filter((line) => line.startsWith("标定 召回率="))).toEqual([]);
    // 分段一侧多发了多少请求：段数合计 − 每遍每样本一次
    expect(run.lines.some((line) => line.includes("分段多发的请求="))).toBe(true);
  });

  it("C4b 对比模式仍走 --repeat：两遍各打一对样本行与一对对比行", async () => {
    const probe = await loadProbe();
    const maxChars = pickChunkWidth(probe);
    const endpoint = tableEndpoint(probe, maxChars);
    const run = await probe.main(
      ["--base-url", LOOPBACK, "--model", "m", "--repeat", "2", "--compare", "--chunk", String(maxChars)],
      { log: QUIET, fetchImpl: endpoint.fetchImpl },
    );
    const total = probe.SAMPLES.length;
    expect(run.rows).toHaveLength(total * 2);
    expect(run.summary!.compare!.chunked.rows).toHaveLength(total * 2);
    expect(run.lines.filter((line) => line.startsWith("— 第 "))).toHaveLength(2);
    expect(run.lines.filter((line) => line.startsWith("对比 第"))).toHaveLength(4);
    expect(run.lines.filter((line) => line.startsWith("重复 2 次 "))).toHaveLength(3);
  });
});

/* ── CLI：真命令行进程序 + 真 socket 假端点 ─────────────────────── */

/**
 * 真命令行输出的归一化：假端点每次随机端口、耗时是真实测量的毫秒——
 * 这两处不是「输出格式」的内容，归一化之后剩下的每一个字节都要与基准相同（断言 C7）。
 */
function normalizeCliOutput(stdout: string, baseUrl: string): string {
  return stdout
    .replaceAll(baseUrl, "http://127.0.0.1:PORT/v1")
    .replace(/耗时=\d+ms/g, "耗时=NNms");
}

/**
 * 改动**前**那一份脚本（`git show HEAD:scripts/local-llm-probe.mjs`）在同一命令行、同一假端点
 * （`{"candidates":[]}` × 15 条样本、`--repeat 1`）下的输出，已按 `normalizeCliOutput` 归一化。
 * 基准是在工作树改动之前用同一条命令录的，不是从新代码反推的。
 */
const BASELINE_HEAD_OUTPUT = `本地模型标定 · 提示词 local-llm-v3 · 端点 http://127.0.0.1:PORT/v1 · 模型 标定专用模型 · 结构化=off · 超时=30000ms · 样本=15 · 重复=1
样本 1/15 [人名] json=ok 候选=0 丢弃=0 {surface_mismatch=0,kind_not_allowed=0,out_of_range=0,malformed=0,duplicate=0} 耗时=NNms | 期望=4 报出=0 命中=0 漏=4 类别错=0 更宽=0 部分=0 误报=0
样本 2/15 [人名] json=ok 候选=0 丢弃=0 {surface_mismatch=0,kind_not_allowed=0,out_of_range=0,malformed=0,duplicate=0} 耗时=NNms | 期望=2 报出=0 命中=0 漏=2 类别错=0 更宽=0 部分=0 误报=0
样本 3/15 [花名] json=ok 候选=0 丢弃=0 {surface_mismatch=0,kind_not_allowed=0,out_of_range=0,malformed=0,duplicate=0} 耗时=NNms | 期望=3 报出=0 命中=0 漏=3 类别错=0 更宽=0 部分=0 误报=0
样本 4/15 [花名] json=ok 候选=0 丢弃=0 {surface_mismatch=0,kind_not_allowed=0,out_of_range=0,malformed=0,duplicate=0} 耗时=NNms | 期望=2 报出=0 命中=0 漏=2 类别错=0 更宽=0 部分=0 误报=0
样本 5/15 [地名] json=ok 候选=0 丢弃=0 {surface_mismatch=0,kind_not_allowed=0,out_of_range=0,malformed=0,duplicate=0} 耗时=NNms | 期望=3 报出=0 命中=0 漏=3 类别错=0 更宽=0 部分=0 误报=0
样本 6/15 [地名] json=ok 候选=0 丢弃=0 {surface_mismatch=0,kind_not_allowed=0,out_of_range=0,malformed=0,duplicate=0} 耗时=NNms | 期望=4 报出=0 命中=0 漏=4 类别错=0 更宽=0 部分=0 误报=0
样本 7/15 [组织] json=ok 候选=0 丢弃=0 {surface_mismatch=0,kind_not_allowed=0,out_of_range=0,malformed=0,duplicate=0} 耗时=NNms | 期望=2 报出=0 命中=0 漏=2 类别错=0 更宽=0 部分=0 误报=0
样本 8/15 [组织] json=ok 候选=0 丢弃=0 {surface_mismatch=0,kind_not_allowed=0,out_of_range=0,malformed=0,duplicate=0} 耗时=NNms | 期望=1 报出=0 命中=0 漏=1 类别错=0 更宽=0 部分=0 误报=0
样本 9/15 [无敏感] json=ok 候选=0 丢弃=0 {surface_mismatch=0,kind_not_allowed=0,out_of_range=0,malformed=0,duplicate=0} 耗时=NNms | 期望=0 报出=0 命中=0 漏=0 类别错=0 更宽=0 部分=0 误报=0
样本 10/15 [无敏感] json=ok 候选=0 丢弃=0 {surface_mismatch=0,kind_not_allowed=0,out_of_range=0,malformed=0,duplicate=0} 耗时=NNms | 期望=0 报出=0 命中=0 漏=0 类别错=0 更宽=0 部分=0 误报=0
样本 11/15 [长文本] json=ok 候选=0 丢弃=0 {surface_mismatch=0,kind_not_allowed=0,out_of_range=0,malformed=0,duplicate=0} 耗时=NNms | 期望=17 报出=0 命中=0 漏=17 类别错=0 更宽=0 部分=0 误报=0
样本 12/15 [长文本] json=ok 候选=0 丢弃=0 {surface_mismatch=0,kind_not_allowed=0,out_of_range=0,malformed=0,duplicate=0} 耗时=NNms | 期望=5 报出=0 命中=0 漏=5 类别错=0 更宽=0 部分=0 误报=0
样本 13/15 [代理对] json=ok 候选=0 丢弃=0 {surface_mismatch=0,kind_not_allowed=0,out_of_range=0,malformed=0,duplicate=0} 耗时=NNms | 期望=7 报出=0 命中=0 漏=7 类别错=0 更宽=0 部分=0 误报=0
样本 14/15 [中英混排] json=ok 候选=0 丢弃=0 {surface_mismatch=0,kind_not_allowed=0,out_of_range=0,malformed=0,duplicate=0} 耗时=NNms | 期望=6 报出=0 命中=0 漏=6 类别错=0 更宽=0 部分=0 误报=0
样本 15/15 [真长文本] json=ok 候选=0 丢弃=0 {surface_mismatch=0,kind_not_allowed=0,out_of_range=0,malformed=0,duplicate=0} 耗时=NNms | 期望=20 报出=0 命中=0 漏=20 类别错=0 更宽=0 部分=0 误报=0
汇总 样本=15 json合法=15 合法率=100.0% 平均耗时=NNms
汇总 采信候选=0 丢弃合计=0 {surface_mismatch=0,kind_not_allowed=0,out_of_range=0,malformed=0,duplicate=0}
标定 有金标样本=15 期望合计=76 报出合计=0 命中合计=0 漏合计=76 类别错合计=0 更宽合计=0 部分合计=0 误报合计=0
标定 召回率=0.0% 精确率=n/a
`;

describe("CLI 真跑一遍（子进程 + node:http 假端点）", () => {
  const servers: { close: () => Promise<void> }[] = [];

  async function fakeModelEndpoint(
    replies: { status?: number; content: string }[],
  ): Promise<{ baseUrl: string; requests: string[]; bodies: string[] }> {
    const http = await import("node:http");
    const state = { requests: [] as string[], bodies: [] as string[] };
    let call = 0;
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        state.requests.push(`${req.method} ${req.url}`);
        state.bodies.push(Buffer.concat(chunks).toString("utf8"));
        const reply = replies[Math.min(call, replies.length - 1)]!;
        call += 1;
        res.writeHead(reply.status ?? 200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: reply.content } }] }));
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("假端点没拿到端口");
    servers.push({ close: () => new Promise<void>((resolve) => server.close(() => resolve())) });
    return { baseUrl: `http://127.0.0.1:${address.port}/v1`, requests: state.requests, bodies: state.bodies };
  }

  function runCli(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [SCRIPT_PATH, ...args], {
        cwd: REPO_ROOT,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => (stdout += chunk));
      child.stderr.on("data", (chunk: string) => (stderr += chunk));
      child.once("error", reject);
      child.once("close", (code) => resolve({ code, stdout, stderr }));
    });
  }

  afterAll(async () => {
    for (const server of servers) await server.close();
  });

  it("npm run local-llm:probe 的那条命令能跑通、退出码 0、假端点收到 SAMPLES.length 次 POST", async () => {
    const probe = await loadProbe();
    const endpoint = await fakeModelEndpoint([{ content: '{"candidates":[]}' }]);
    const cli = await runCli(["--base-url", endpoint.baseUrl, "--model", "标定专用模型", "--repeat", "1"]);

    // 子进程里跑 `.mjs → .ts`（Node 原生类型剥离）不该留下任何崩溃痕迹。
    expect(cli.stderr).not.toMatch(/ERR_|TypeError|SyntaxError|\n\s+at /);
    expect(cli.code).toBe(0);
    expect(cli.stdout).toContain(`本地模型标定 · 提示词 ${LOCAL_LLM_PROMPT_VERSION}`);
    expect(cli.stdout).toContain("合法率=100.0%");
    expect(endpoint.requests).toHaveLength(probe.SAMPLES.length);
    for (const request of endpoint.requests) expect(request).toBe("POST /v1/chat/completions");
    expect(endpoint.bodies[0]).toContain("李雷娜");
    // 零报出 ⇒ 精确率的分母是 0：打印 n/a，绝不打印 100%
    expect(cli.stdout).toContain("精确率=n/a");
    expect(cli.stdout).not.toContain("精确率=100.0%");
  });

  it("非回环 --base-url：退出码 3，假端点一个请求都没收到", async () => {
    const endpoint = await fakeModelEndpoint([{ content: '{"candidates":[]}' }]);
    const nonLoopback = endpoint.baseUrl.replace("127.0.0.1", "localhost.localdomain");
    const cli = await runCli(["--base-url", nonLoopback, "--model", "m"]);

    expect(cli.code).toBe(3);
    expect(cli.stdout).toContain("拒绝运行");
    expect(endpoint.requests).toHaveLength(0);
  });

  it("--text-file 读用户点名的那个文件，其余照常", async () => {
    const endpoint = await fakeModelEndpoint([{ content: '{"candidates":[{"start":0,"end":3,"kind":"person","surface":"李雷娜"}]}' }]);
    const file = fileURLToPath(new URL("./fixtures/m9-5-probe-text.txt", import.meta.url));
    const cli = await runCli([
      "--base-url",
      endpoint.baseUrl,
      "--model",
      "m",
      "--text-file",
      file,
      "--repeat",
      "1",
    ]);

    expect(cli.code).toBe(0);
    expect(endpoint.requests).toHaveLength(1);
    expect(endpoint.bodies[0]).toContain("白沙湾");
    expect(cli.stdout).toContain("json=ok 候选=1");
  });

  it("--repeat 2 从真命令行生效：样本集跑两遍、末尾有跨遍统计", async () => {
    const endpoint = await fakeModelEndpoint([{ content: '{"candidates":[]}' }]);
    const cli = await runCli(["--base-url", endpoint.baseUrl, "--model", "m", "--repeat", "2"]);

    const probe = await loadProbe();
    expect(cli.code).toBe(0);
    expect(endpoint.requests).toHaveLength(probe.SAMPLES.length * 2);
    expect(cli.stdout).toContain("重复=2");
    expect(cli.stdout).toContain("— 第 2/2 遍 —");
    expect(cli.stdout).toMatch(/重复 2 次 召回 最小=[\d.]+% 中位=[\d.]+% 最大=[\d.]+%/);
  });

  it("--repeat 0 / --repeat abc ⇒ 用法错误退出码 2", async () => {
    for (const bad of ["0", "-1", "abc", "1.5"]) {
      const cli = await runCli(["--base-url", LOOPBACK, "--model", "m", "--repeat", bad]);
      expect(cli.code).toBe(2);
      expect(cli.stdout).toContain("正整数重复次数");
    }
  });

  it("用法错误：缺 --model ⇒ 退出码 2", async () => {
    const cli = await runCli(["--base-url", LOOPBACK]);
    expect(cli.code).toBe(2);
    expect(cli.stdout).toContain("用法错误");
  });

  it("C7 不给 --chunk / --compare ⇒ 真命令行输出与改动前逐字相同", async () => {
    const endpoint = await fakeModelEndpoint([{ content: '{"candidates":[]}' }]);
    const cli = await runCli([
      "--base-url",
      endpoint.baseUrl,
      "--model",
      "标定专用模型",
      "--repeat",
      "1",
    ]);

    expect(cli.code).toBe(0);
    expect(cli.stderr).not.toMatch(/ERR_|TypeError|SyntaxError|\n\s+at /);
    expect(normalizeCliOutput(cli.stdout, endpoint.baseUrl)).toBe(BASELINE_HEAD_OUTPUT);
    // 一条都不许多：分段路径没被触发，也没有任何对比行
    expect(cli.stdout).not.toContain("分段");
    expect(cli.stdout).not.toContain("对比");
    expect(endpoint.requests).toHaveLength(15);
  });

  it("C8 --chunk 0 / --chunk abc ⇒ 用法错误退出码 2，一次请求都不发", async () => {
    const endpoint = await fakeModelEndpoint([{ content: '{"candidates":[]}' }]);
    for (const bad of ["0", "-1", "abc", "1.5"]) {
      const cli = await runCli(["--base-url", endpoint.baseUrl, "--model", "m", "--chunk", bad]);
      expect(cli.code, `--chunk ${bad}`).toBe(2);
      expect(cli.stdout).toContain("正整数分段字符上限");
      expect(cli.stdout).toContain("[--chunk <字符上限>] [--compare]");
    }
    expect(endpoint.requests).toHaveLength(0);

    const probe = await loadProbe();
    for (const args of [["--chunk", "0"], ["--chunk", "abc"], ["--chunk", "-2"], ["--chunk"]]) {
      const outcome = probe.parseArgv(["--base-url", LOOPBACK, "--model", "m", ...args]);
      expect(outcome.ok, args.join(" ")).toBe(false);
    }
    const both = probe.parseArgv(["--base-url", LOOPBACK, "--model", "m", "--chunk", "400", "--compare"]);
    expect(both.ok && both.options.chunkMaxChars).toBe(400);
    expect(both.ok && both.options.compare).toBe(true);
    // 两个参数都不给 ⇒ 缺省：不分段、不对比（回归面就钉在这里）
    const plain = probe.parseArgv(["--base-url", LOOPBACK, "--model", "m"]);
    expect(plain.ok && plain.options.chunkMaxChars).toBe(null);
    expect(plain.ok && plain.options.compare).toBe(false);
  });
});
