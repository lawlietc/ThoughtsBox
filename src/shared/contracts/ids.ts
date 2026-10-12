import { createHash, randomUUIDv7 } from "node:crypto";

/**
 * ID 约定（规格 §9.3）：业务对象使用「类型前缀 + UUIDv7」。
 * UUIDv7 由 Node 内置提供（>= 24.16.0），不自实现、不引依赖；
 * 存在性由启动自检保证，这里只做一次同等的显式失败。
 */
function requireUuidv7(): () => string {
  if (typeof randomUUIDv7 !== "function") {
    throw new Error(
      "运行时缺少 crypto.randomUUIDv7()：需要 Node >= 24.16.0（当前基线 >=24.18.0 <27）。不使用自实现或第三方替代。",
    );
  }
  return randomUUIDv7;
}

export const ID_PREFIXES = {
  captureRecord: "rec",
  recordRevision: "rev",
  episode: "ep",
  thoughtItem: "thought",
  concept: "concept",
  entity: "entity",
  graphEdge: "edge",
  triggerAssertion: "trig",
  suggestion: "sug",
  parseRun: "run",
  sleepSession: "sleep",
  emotionMention: "em",
  topicMention: "tm",
  entityMention: "enm",
  cloudSendGrant: "csg",
  deletionAudit: "del",
  conceptAlias: "ca",
  userScalarOverride: "ovo",
  userCollectionPatch: "ucp",
} as const;

export type IdKind = keyof typeof ID_PREFIXES;

export function newId(kind: IdKind): string {
  return `${ID_PREFIXES[kind]}_${requireUuidv7()()}`;
}

/**
 * 种子概念例外：确定性 ID，让重复播种幂等、跨安装结果一致。
 * concept_seed_ + sha256(NFC(标准名)) 的前 12 位十六进制。
 */
export function seedConceptId(canonicalName: string): string {
  const hash = createHash("sha256").update(canonicalName.normalize("NFC")).digest("hex");
  return `concept_seed_${hash.slice(0, 12)}`;
}

export function hasPrefix(id: string, kind: IdKind): boolean {
  return id.startsWith(`${ID_PREFIXES[kind]}_`);
}
