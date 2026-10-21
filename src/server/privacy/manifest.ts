import { createHash } from "node:crypto";

/**
 * `pipeline_manifest` / `pipeline_fingerprint`（M2-3 的 T-33 侧，Schema §3.7；ADR-011；指令 §8.1/§8.4）。
 *
 * 字段集合是**封闭的九项**，逐字取自 `0003_derived_layer.sql` 的 CHECK：
 * prompt / schema / model / provider / params / redaction / redactionMap / resolver / validation。
 * 数据库只守「九项皆非空」这一半（缺失被 CHECK 拒），多写一项它在物理上拒不掉——
 * 所以封闭性的另一半在这里：构造与解析都要求键集合**恰好相等**，不认识的键即报错。
 *
 * `pipeline_fingerprint` 是**除 redactionMap 外八项**的规范化哈希（0003 头注、§3.7「不含 redactionMap
 * 中的一次性随机量」）。理由不是性能而是隐私：脱敏映射里带着真实姓名与偏移，
 * 每次请求还换一个一次性随机量；把它折进指纹，等于让一次性随机量决定去重键，
 * 又等于把敏感定位信息的存在性广播给每一个会读指纹的下游。
 *
 * 本文件不写库、不发请求：规范化编码与哈希是纯函数，序列化格式一旦分叉，
 * 同一 manifest 得到不同哈希就是幂等键失效（指令 §8.1 末段）。
 */

export const PIPELINE_MANIFEST_FIELDS = [
  "prompt",
  "schema",
  "model",
  "provider",
  "params",
  "redaction",
  "redactionMap",
  "resolver",
  "validation",
] as const;

export type PipelineManifestField = (typeof PIPELINE_MANIFEST_FIELDS)[number];

/** 参与指纹的八项：封闭九项去掉 redactionMap。这条差集就是 T-33 要钉住的关系本身。 */
export const PIPELINE_FINGERPRINT_FIELDS: readonly PipelineManifestField[] =
  PIPELINE_MANIFEST_FIELDS.filter((field) => field !== "redactionMap");

export const REDACTION_MAP_FIELD = "redactionMap";

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type PipelineManifest = { readonly [K in PipelineManifestField]: JsonValue };

export class PipelineManifestError extends Error {
  readonly issues: string[];

  constructor(message: string, issues: string[] = []) {
    super(issues.length > 0 ? `${message}：\n  - ${issues.join("\n  - ")}` : message);
    this.name = "PipelineManifestError";
    this.issues = issues;
  }
}

/**
 * 规范化 JSON：对象键按码元升序排序、无空白。
 * 字段顺序变化与序列化格式变化都不该让同一 manifest 得到不同哈希（指令 §8.4）。
 */
export function canonicalJson(value: JsonValue): string {
  if (value === null) return "null";
  if (typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new PipelineManifestError(`规范化 JSON 不接受非有限数：${value}`);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const entries = Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key] as JsonValue)}`);
  return `{${entries.join(",")}}`;
}

function missingKeys(candidate: JsonObject, label: string, required: readonly string[]): string[] {
  const issues: string[] = [];
  for (const key of required) {
    if (!(key in candidate)) issues.push(`${label} 缺字段：${key}`);
    else if (candidate[key] === undefined) issues.push(`${label} 字段值为 undefined：${key}`);
  }
  return issues;
}

function unexpectedKeys(candidate: JsonObject, label: string, allowed: readonly string[]): string[] {
  return Object.keys(candidate)
    .filter((key) => !allowed.includes(key))
    .map((key) => `${label} 出现契约外字段：${key}`);
}

/**
 * 构造封闭九项。缺任一项、多任一项都被拒——九项的形状只在这里定义一次，
 * 消费方（M2-4 的 provider、M2-5 的 run 写入）拿到的就是已验票的对象。
 * 入参按 `unknown` 处理：manifest 的真实来源是请求体与库里的文本，编译期形状不作数。
 */
export function buildPipelineManifest(input: unknown): PipelineManifest {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new PipelineManifestError("pipeline_manifest 必须是对象");
  }
  const candidate = input as JsonObject;
  const issues = [
    ...missingKeys(candidate, "pipeline_manifest", PIPELINE_MANIFEST_FIELDS),
    ...unexpectedKeys(candidate, "pipeline_manifest", PIPELINE_MANIFEST_FIELDS),
  ];
  if (issues.length > 0) throw new PipelineManifestError("pipeline_manifest 字段集合不封闭", issues);
  const normalized: JsonObject = {};
  for (const field of PIPELINE_MANIFEST_FIELDS) {
    normalized[field] = candidate[field] as JsonValue;
  }
  return normalized as unknown as PipelineManifest;
}

/** 指纹输入面：只剩八项，映射本体不在其中。 */
export function manifestWithoutRedactionMap(manifest: PipelineManifest): JsonObject {
  const candidate = manifest as unknown as JsonObject;
  const projected: JsonObject = {};
  for (const field of PIPELINE_FINGERPRINT_FIELDS) {
    projected[field] = candidate[field] as JsonValue;
  }
  return projected;
}

export function pipelineFingerprint(manifest: PipelineManifest): string {
  return createHash("sha256").update(canonicalJson(manifestWithoutRedactionMap(manifest))).digest("hex");
}

/** 落 `parse_run.pipeline_manifest` 的规范化文本：九项全在，仅本地存储。 */
export function pipelineManifestLocalJson(manifest: PipelineManifest): string {
  return canonicalJson(buildPipelineManifest(manifest) as unknown as JsonValue);
}

/**
 * 从库里读回 manifest（run 行 → 对象）。走的是同一个构造门：库里多出一项说明写入方
 * 越过了契约，静默接受等于把「字段集合封闭」变成只在建的一侧成立。
 */
export function parsePipelineManifest(json: string): PipelineManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new PipelineManifestError("pipeline_manifest 不是合法 JSON");
  }
  return buildPipelineManifest(parsed);
}
