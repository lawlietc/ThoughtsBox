/**
 * 容错 JSON 提取（D5 的降级路径；Spec §9.5、ADR-006）。
 *
 * 移植来源：`llm-wiki-agent/src/ingest/extract.ts` 的 `extractJson()`
 * 移植时源文件 sha256：82f6e8c2591e16355623c208a929822a6f64dc4c759374272cd7adc4ed87d4b7
 * 移植日期：2026-10-13；无第三方依赖；**解析逻辑逐字保留**，只换错误类型
 * （上游的 `ValidationError(code, message)` 换成本项目的封闭错误分类）。
 *
 * Spec §9.5 点名了一个具体的坑：上游 `src/qa/synthesize.ts` 里有一个**同名但返回 string**
 * 的实现，误取就等于把「解析成对象」降级成「取一段文本」。本文件的签名返回对象，
 * 且 `tests/m2-provider.test.ts` 钉住了这一形状（返回的是已解析对象，不是字符串）。
 *
 * 本函数只做**结构容错**（剥围栏、取首 `{` 到末 `}`），不做任何业务判断：
 * 能否采信由 `contract.ts` 的同一套 Zod + 业务校验决定（ADR-006「结构正确 ≠ 事实正确」）。
 */

import type { JsonObject } from "../privacy/manifest.ts";

/**
 * 回稿不可解析。`kind` 取 `parse_run.error_kind` 封闭集中的 `invalid_json`
 * （0003_derived_layer.sql 的 CHECK；清单本身由 provider.ts 对账，本处只落一个值）。
 */
export class InvalidJsonError extends Error {
  readonly kind = "invalid_json" as const;
  readonly retryable = false;

  constructor(reason: string) {
    super(`模型回稿无法解析为 JSON 对象：${reason}`);
    this.name = "InvalidJsonError";
  }
}

/**
 * 从 LLM 回稿中提取 JSON 对象（容错）：
 * 1) 剥整段 ```json 围栏；2) 取首个 `{` 到末个 `}` 的片段再 parse。
 * @throws InvalidJsonError —— 找不到 JSON 对象，或片段不是合法 JSON 对象
 */
export function extractJson(text: string): JsonObject {
  let t = text.trim();
  const f = /^```(?:json|js|yaml|ya?ml|markdown|md)?\s*\n([\s\S]*?)\n```$/.exec(t);
  if (f) t = f[1]!.trim();
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new InvalidJsonError("回稿中找不到 JSON 对象");
  }
  try {
    const parsed: unknown = JSON.parse(t.slice(start, end + 1));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    return parsed as JsonObject;
  } catch {
    throw new InvalidJsonError("回稿不是合法 JSON 对象");
  }
}

/** 回稿是否能解析——供 Provider 决定是否走降级路径，不改变解析语义。 */
export function canExtractJson(text: string): boolean {
  try {
    extractJson(text);
    return true;
  } catch {
    return false;
  }
}
