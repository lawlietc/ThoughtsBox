import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parseEnums, type EnumFile } from "./enums.ts";
import { assertVocabSize, parseVocab, type VocabFile } from "./vocab.ts";

const SHARED_DIR = join(import.meta.dirname, "..");
export const VOCAB_DIR = join(SHARED_DIR, "vocab");
export const CONSTANTS_DIR = join(SHARED_DIR, "constants");

export function loadVocab(kind: "emotion" | "topic", dir = VOCAB_DIR): VocabFile {
  const file = join(dir, `${kind}s.json`);
  const vocab = parseVocab(JSON.parse(readFileSync(file, "utf8")), file);
  assertVocabSize(vocab);
  return vocab;
}

export function loadEnums(dir = CONSTANTS_DIR): EnumFile {
  const file = join(dir, "enums.json");
  return parseEnums(JSON.parse(readFileSync(file, "utf8")));
}

export interface Contracts {
  emotions: VocabFile;
  topics: VocabFile;
  enums: EnumFile;
  fingerprint: string;
}

export interface ContractsSource {
  readonly vocabDir?: string;
  readonly constantsDir?: string;
}

export function contractsFingerprint(emotions: VocabFile, topics: VocabFile, enums: EnumFile): string {
  return createHash("sha256")
    .update(JSON.stringify({ emotions, topics, enums }))
    .digest("hex");
}

/**
 * 词表与枚举的规范化指纹，是 pipeline_manifest 的组成部分之一（规格 §5.4）：
 * 改一个别名模式，就该让旧派生结果可被识别为来自不同管线。
 * 目录可注入，让这条性质在测试里可验证，而不是只能靠改仓库文件。
 */
export function loadContracts(source: ContractsSource = {}): Contracts {
  const emotions = loadVocab("emotion", source.vocabDir);
  const topics = loadVocab("topic", source.vocabDir);
  const enums = loadEnums(source.constantsDir);
  return {
    emotions,
    topics,
    enums,
    fingerprint: contractsFingerprint(emotions, topics, enums),
  };
}
