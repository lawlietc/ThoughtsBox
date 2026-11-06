import type { RedactionMap } from "./redaction.ts";

/**
 * 占位符回填（D-7，2026-11-05）。
 *
 * 云端只看到脱敏文本，回稿里的标题/摘要/经历/念头/实体词面/关系两端会带着
 * `[person_1_abcd12]` 这类占位符。本函数把这些占位符按本地映射换回原文片段的**真名**，
 * 让入库与展示都是真名。`evidence` 字段**不在回填范围**——证据锚定必须留在脱敏坐标里算
 * （见 `redaction.ts` 的 `resolveEvidenceToOriginal`）。
 *
 * 纪律：
 *  - 只替换映射里**真实存在**的占位符，串匹配；
 *  - 不猜、不改写未知占位符（宁缺不伪）；
 *  - 原文切片取自 `rawText[originalStart, originalEnd]`，不做归一化。
 *
 * 云端模型偶尔会把方括号丢掉（回稿里写成 `person_1_eb8aef` 而不是 `[person_1_eb8aef]`），
 * 所以每个占位符先替换带括号的原形，再替换去掉括号的裸形；两条都只针对**本次映射里真实存在**
 * 的那一个串，不会误伤别的占位符。
 */
export function restorePlaceholders(text: string, map: RedactionMap, rawText: string): string {
  if (text === "" || map.spans.length === 0) return text;
  let out = text;
  for (const span of map.spans) {
    const original = rawText.slice(span.originalStart, span.originalEnd);
    // 先换带括号的原形；再把「去掉括号的裸形」换掉——模型可能只丢括号、随机量不动。
    // 顺序不能反：先换裸形会把 `[person_1_x]` 变成 `[张三]`，残留方括号。
    for (const needle of [span.placeholder, span.placeholder.replace(/^\[|\]$/g, "")]) {
      if (needle === "" || !out.includes(needle)) continue;
      // split/join 而非 replace：占位符在同一段文本里可能多次出现（同一个人被多次提及）。
      out = out.split(needle).join(original);
    }
  }
  return out;
}
