import { readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { newId, seedConceptId, hasPrefix, ID_PREFIXES } from "../src/shared/contracts/ids.ts";
import { loadContracts, loadEnums, loadVocab, VOCAB_DIR } from "../src/shared/contracts/load.ts";
import { autoAliases, EXPECTED_VOCAB_SIZE } from "../src/shared/contracts/vocab.ts";
import { graphEdgeRelationTypes, relationTypeNames } from "../src/shared/contracts/enums.ts";

describe("运行时基线（ADR-013）", () => {
  it("Node 版本满足 package.json 的 engines 范围", () => {
    const [major, minor] = process.versions.node.split(".").map(Number);
    expect(major).toBeGreaterThanOrEqual(24);
    expect(major).toBeLessThan(27);
    if (major === 24) expect(minor).toBeGreaterThanOrEqual(18);
  });

  it("crypto.randomUUIDv7 由运行时提供，且版本位为 7", () => {
    const value = newId("captureRecord");
    expect(value.startsWith("rec_")).toBe(true);
    expect(value.charAt("rec_".length + 14)).toBe("7");
  });

  it("seedConceptId 对同一标准名确定、对 NFC 等价值相同", () => {
    const a = seedConceptId("开心");
    expect(a).toBe(seedConceptId("开心"));
    expect(a.startsWith("concept_seed_")).toBe(true);
    expect(a).toHaveLength("concept_seed_".length + 12);
    // 组合字符的 NFC 与原始形式必须落到同一个 ID，否则播种不幂等。
    expect(seedConceptId("é".normalize("NFD"))).toBe(seedConceptId("é".normalize("NFC")));
  });

  it("ID 前缀覆盖规格 §9.3 的对象类别", () => {
    expect(hasPrefix(newId("emotionMention"), "emotionMention")).toBe(true);
    expect(ID_PREFIXES.triggerAssertion).toBe("trig");
    expect(ID_PREFIXES.cloudSendGrant).toBe("csg");
    expect(Object.values(ID_PREFIXES).every((prefix) => /^[a-z]+$/.test(prefix))).toBe(true);
  });
});

describe("词表与枚举契约（规格 §4.3、§3.7）", () => {
  it("情绪 36 / 主题 18，且各自 ID 确定唯一", () => {
    const contracts = loadContracts();
    expect(contracts.emotions.concepts).toHaveLength(EXPECTED_VOCAB_SIZE.emotion);
    expect(contracts.topics.concepts).toHaveLength(EXPECTED_VOCAB_SIZE.topic);
    const ids = [contracts.emotions, contracts.topics].flatMap((vocab) =>
      vocab.concepts.map((concept) => seedConceptId(concept.canonical_name)),
    );
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("别名模式只有 auto / suggest 两个取值，且 auto 集合非空", () => {
    const contracts = loadContracts();
    const modes = [contracts.emotions, contracts.topics].flatMap((vocab) =>
      vocab.concepts.flatMap((concept) => concept.aliases.map((alias) => alias.mode)),
    );
    expect(new Set(modes)).toEqual(new Set(["auto", "suggest"]));
    expect(autoAliases(contracts.emotions).length).toBeGreaterThan(0);
  });

  it("同一份词表重复加载得到同一指纹", () => {
    expect(loadContracts().fingerprint).toBe(loadContracts().fingerprint);
  });

  it("别名模式一变，契约指纹就变（它是管线身份的一部分）", () => {
    const baseline = loadContracts();
    const dir = mkdtempSync(join(tmpdir(), "tb-vocab-"));
    try {
      for (const name of ["emotions.json", "topics.json"]) {
        writeFileSync(
          join(dir, name),
          readFileSync(join(VOCAB_DIR, name), "utf8"),
          "utf8",
        );
      }
      const mutated = structuredClone(loadVocab("emotion", dir));
      const target = mutated.concepts.find((concept) => concept.aliases.length > 0)!;
      const entry = target.aliases[0]!;
      entry.mode = entry.mode === "auto" ? "suggest" : "auto";
      writeFileSync(join(dir, "emotions.json"), `${JSON.stringify(mutated, null, 2)}\n`, "utf8");
      const changed = loadContracts({ vocabDir: dir });
      expect(changed.fingerprint).not.toBe(baseline.fingerprint);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("alias_of 不作为关系类型，GraphEdge 只承载独立关系", () => {
    const enums = loadEnums();
    const names = relationTypeNames(enums);
    expect(names).not.toContain("alias_of");
    expect(names).toContain("possibly_related");
    expect(graphEdgeRelationTypes(enums)).not.toContain("has_emotion");
    expect(graphEdgeRelationTypes(enums)).not.toContain("triggered_by");
  });
});
