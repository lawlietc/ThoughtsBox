/**
 * M9-2：本地模型辅助脱敏的**纯逻辑**层（执行准则 §四、裁决 M9-D-1）。
 *
 * 本文件只做三件事：组装请求、把回稿**宽松解析**成候选、把候选**严格校验**成可采信的区间。
 * HTTP 调用不在这里——装配请求只有一份实现，在 `ingest/provider.ts` 的 `sendChatCompletion`
 * （M9-D-1：不许两边各写半套请求装配）。
 *
 * 三条判定纪律，来自准则 §一-3 与 §四 的禁区：
 * 1. **模型给的位置一律不可信**：`start/end` 只有与 `rawText` 逐字对得上才成立；对不上就按
 *    `surface` 回原文找**唯一**命中，仍不中即丢。这与 Schema §7.6 的「按原文坐标逐字核验」
 *    是同一条规则，只是坐标来自另一个不可信来源。
 * 2. **`surface` 不是权威**：采纳的是重定位后的区间，下游按区间切原文，不按模型给的文本替换。
 * 3. **丢弃不抛错**：脏输出是本地模型的常态。抛错会让上层发送流程中断成异常，而正确的行为是
 *    「这一档没跑出候选」＋如实计数（M9-3 接进预览，M9-4 接进 trace 与 UI）。
 *
 * 偏移单位与全仓一致：JavaScript UTF-16 code unit（K-23），代理对占 2。模型按码点或按字节计数
 * 是最常见的错法，所以下面允许一次「按词面重定位」，也所以 V6 专门钉非 BMP。
 */

import {
  isLoopbackUrl,
  sendChatCompletion,
  type ChatCompletionRequest,
  type ModelAdapter,
} from "../ingest/provider.ts";
import { SEMANTIC_REDACTION_KINDS } from "./redaction.ts";
import {
  buildLocalLlmSystemPrompt,
  buildLocalLlmUserMessage,
  LOCAL_LLM_PROMPT_VERSION,
} from "./localLlmPrompt.ts";

/** 一条通过校验的候选：区间锚定 `rawText` 的 UTF-16 偏移。 */
export interface LocalLlmCandidate {
  readonly start: number;
  readonly end: number;
  readonly kind: string;
  readonly surface: string;
}

/**
 * 丢弃原因（封闭集）。分成这几类是标定要读的粒度（M9-5/M9-6 看丢弃率分布）：
 * 「越界」和「词面对不上」混成一个数，就看不出模型到底错在哪一环。
 */
export type LocalLlmDropReason =
  | "surface_mismatch"
  | "kind_not_allowed"
  | "out_of_range"
  | "malformed"
  | "duplicate";

export interface LocalLlmValidation {
  readonly candidates: readonly LocalLlmCandidate[];
  readonly dropped: {
    readonly count: number;
    readonly byReason: Readonly<Record<LocalLlmDropReason, number>>;
  };
}

export interface LocalLlmProposal {
  readonly ok: boolean;
  readonly candidates: readonly LocalLlmCandidate[];
  readonly dropped: number;
  readonly failureKind?: string;
  readonly latencyMs: number;
}

/**
 * 组装一次候选征询请求（准则 §四 的 `buildLocalLlmRequest`）。
 *
 * `temperature: 0`：报位置不是创意任务，抖动只会带来更多 `surface_mismatch`。
 * 结构化输出**照配置声明**带上（ADR-006：能力来自声明，不来自上一次失败试探）；不带时纯靠
 * 提示词约束。两条都做是用户已定的（规划 D8），实际能不能用由 M9-1 的探测与标定说。
 */
export function buildLocalLlmRequest(rawText: string, structured: boolean): ChatCompletionRequest {
  const base: ChatCompletionRequest = {
    messages: [
      { role: "system", content: buildLocalLlmSystemPrompt() },
      { role: "user", content: buildLocalLlmUserMessage(rawText) },
    ],
    temperature: 0,
  };
  return structured
    ? { ...base, responseFormat: "json_schema", responseSchemaName: LOCAL_LLM_PROMPT_VERSION }
    : base;
}

function zeroDropCounts(): Record<LocalLlmDropReason, number> {
  return { surface_mismatch: 0, kind_not_allowed: 0, out_of_range: 0, malformed: 0, duplicate: 0 };
}

/**
 * 取文本中**第一个平衡闭合、且能解析成对象**的花括号片段；找不到返回 `undefined`。
 *
 * 为什么不用现成的 `ingest/extractJson.ts`：它取「首个 `{` 到末个 `}`」再整块 parse——模型在
 * JSON 之后又写一句带 `}` 的说明、或前后各带一段文字时，整块就 parse 失败。本档的产出是一个
 * 小对象，值得按平衡切。两处容错范围由各自断言钉，所以这是**两份语义**而不是重复实现。
 */
function firstBalancedJsonObject(text: string): Record<string, unknown> | undefined {
  for (let start = text.indexOf("{"); start >= 0; start = text.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i += 1) {
      const char = text[i]!;
      if (inString) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') inString = true;
      else if (char === "{") depth += 1;
      else if (char === "}") {
        depth -= 1;
        if (depth > 0) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(text.slice(start, i + 1));
        } catch {
          parsed = undefined;
        }
        if (parsed !== undefined && parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>;
        }
        break; // 这个起点不是合法对象（如 HTML 错误页里的 CSS 块）：换下一个 `{` 再试。
      }
    }
  }
  return undefined;
}

/**
 * 宽松解析回稿：容忍 ```json 围栏、前后说明文字、多余空白，只认「第一个平衡对象里的
 * `candidates` 数组」。拿不到就是拿不到——`{ ok: false }`，不抛、不猜。
 *
 * 容忍的是**排版**，不容忍**结构**：`{"candidates": {...}}`（对象而非数组）一律 `ok:false`。
 * 把它当空候选集放过，等于把「模型没按契约输出」伪装成「模型说没有敏感内容」——后者在上层
 * 是「脱敏干净、可以外发」，语义完全相反。
 */
export function parseLocalLlmResponse(text: string): { ok: true; candidates: unknown[] } | { ok: false } {
  const unusable = { ok: false } as const;
  if (typeof text !== "string" || text.trim() === "") return unusable;
  const parsed = firstBalancedJsonObject(text);
  if (parsed === undefined) return unusable;
  const candidates = parsed.candidates;
  if (!Array.isArray(candidates)) return unusable;
  return { ok: true, candidates };
}

/**
 * `surface` 在全篇的命中：首个位置 + 是否唯一。空词面永不视为命中（它在每个位置都「匹配」，
 * 唯一性判定会得出荒谬结论）。
 */
function locateSurface(rawText: string, surface: string): { at: number; unique: boolean } {
  if (surface === "") return { at: -1, unique: false };
  const first = rawText.indexOf(surface);
  if (first < 0) return { at: -1, unique: false };
  return { at: first, unique: rawText.indexOf(surface, first + surface.length) < 0 };
}

/**
 * 严格校验：逐条判可否采信，**从不抛**。
 *
 * 判定顺序就是丢弃原因的归属顺序（一条候选只记**第一个**命中的原因，否则计数重复）：
 * 结构 → 区间 → 逐字（含一次重定位）→ 类别 → 重复/重叠。
 *
 * 重定位只允许一次、且**唯一命中才采纳**：偏移错位而词面全篇只出现一处时，采纳没有歧义；
 * 出现多处时「它想说的是哪一处」无法判定，宁丢勿错。
 *
 * 完全重复与被重叠吃掉的同记 `duplicate`：两者都是「这条已被前面某条覆盖」，是同一件事的两种
 * 形态。标定要读的是「丢了几个」，不是「被吃掉的算重复还是算重叠」。
 * 重叠消解规则与 `redaction.ts` 的 `resolveOverlaps` 一致（左起最长），M9-3 把候选喂进
 * `redact()` 时两层才会给出同一组区间。
 */
export function validateLocalLlmCandidates(
  rawText: string,
  candidates: readonly unknown[],
): LocalLlmValidation {
  const byReason = zeroDropCounts();
  const admitted: LocalLlmCandidate[] = [];
  const seen = new Set<string>();

  for (const entry of candidates) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      byReason.malformed += 1;
      continue;
    }
    const raw = entry as Record<string, unknown>;
    const start = raw.start;
    const end = raw.end;
    const kind = raw.kind;
    const surface = raw.surface;
    if (
      typeof start !== "number" ||
      typeof end !== "number" ||
      typeof kind !== "string" ||
      typeof surface !== "string"
    ) {
      byReason.malformed += 1;
      continue;
    }
    // 小数、NaN、Infinity、负数、start>=end、越界同归 out_of_range：都是「偏移不成立」。
    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start < 0 ||
      end <= start ||
      end > rawText.length
    ) {
      byReason.out_of_range += 1;
      continue;
    }

    let finalStart = start;
    let finalEnd = end;
    if (rawText.slice(start, end) !== surface) {
      const hit = locateSurface(rawText, surface);
      if (!hit.unique) {
        byReason.surface_mismatch += 1;
        continue;
      }
      finalStart = hit.at;
      finalEnd = hit.at + surface.length;
    }

    if (!(SEMANTIC_REDACTION_KINDS as readonly string[]).includes(kind)) {
      byReason.kind_not_allowed += 1;
      continue;
    }

    const key = `${finalStart}~${finalEnd}~${kind}`;
    if (seen.has(key)) {
      byReason.duplicate += 1;
      continue;
    }
    seen.add(key);
    admitted.push({
      start: finalStart,
      end: finalEnd,
      kind,
      surface: rawText.slice(finalStart, finalEnd),
    });
  }

  const kept = resolveLeftLongest(admitted, byReason);
  const count = Object.values(byReason).reduce((sum, n) => sum + n, 0);
  return { candidates: kept, dropped: { count, byReason } };
}

/**
 * 左起最长优先，产出互不重叠的升序区间；被吃掉的计入 `duplicate`。
 * 与 `redaction.ts:resolveOverlaps` 同一条规则（那里是私有件，且候选形状带着 source/dedupeKey，
 * 本档的候选还没有来源层——M9-3 才补），所以这里是一份平行的小函数而不是抽公共。
 */
function resolveLeftLongest(
  admitted: readonly LocalLlmCandidate[],
  byReason: Record<LocalLlmDropReason, number>,
): LocalLlmCandidate[] {
  const sorted = [...admitted].sort((a, b) =>
    a.start !== b.start ? a.start - b.start : b.end - b.start - (a.end - a.start),
  );
  const accepted: LocalLlmCandidate[] = [];
  let cursor = 0;
  for (const candidate of sorted) {
    if (candidate.start < cursor) {
      byReason.duplicate += 1;
      continue;
    }
    accepted.push(candidate);
    cursor = candidate.end;
  }
  return accepted;
}

function unusable(failureKind: string, latencyMs: number): LocalLlmProposal {
  return { ok: false, candidates: [], dropped: 0, failureKind, latencyMs };
}

/**
 * 一次完整的候选征询：装配 → 发送 → 宽松解析 → 严格校验。
 *
 * **从不抛**：端点不是回环、超时、坏信封、坏 JSON、脏候选，全部折成
 * `{ ok:false, failureKind }` 或 `ok:true` + 空候选 + 计数。上层（M9-3）据此回落，
 * 而不是让本地模型的一次坏输出把发送流程打断成异常（准则 §一-4、§四 禁区）。
 *
 * 隐私红线（P-1）在发送前挡一次：本函数是公开入口，M9-3/M9-4 会直接调它，不能假设调用方
 * 先查过 `localLlmStatus`。非回环 ⇒ **一次请求都不发**，`failureKind:"not_loopback"`。
 */
export async function proposeRedactionCandidates(
  adapter: ModelAdapter,
  rawText: string,
  deps: { fetchImpl?: typeof fetch } = {},
): Promise<LocalLlmProposal> {
  const startedAt = performance.now();
  const elapsed = (): number => Math.max(0, Math.round(performance.now() - startedAt));
  if (!isLoopbackUrl(adapter.baseUrl)) return unusable("not_loopback", elapsed());

  const outcome = await sendChatCompletion(
    adapter,
    buildLocalLlmRequest(rawText, adapter.supportsStructuredOutput),
    deps,
  );
  if (!outcome.ok) return unusable(outcome.failureKind ?? "network", outcome.latencyMs);

  const parsed = parseLocalLlmResponse(outcome.content ?? "");
  if (!parsed.ok) return unusable("invalid_json", outcome.latencyMs);

  const validated = validateLocalLlmCandidates(rawText, parsed.candidates);
  return {
    ok: true,
    candidates: validated.candidates,
    dropped: validated.dropped.count,
    latencyMs: outcome.latencyMs,
  };
}