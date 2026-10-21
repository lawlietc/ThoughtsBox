import { describe, expect, it } from "vitest";

import { STOPWORDS, deserializeTokens, isCjk, serializeTokens, tokenize } from "../src/shared/search/tokenizer.ts";

describe("分词器（Spec §7.2，移植自 llm-wiki-agent，sha256 见文件头）", () => {
  it("CJK 段按位置产出 1/2/3-gram，顺序确定", () => {
    expect(tokenize("难堪")).toEqual(["难", "难堪", "堪"]);
    expect(tokenize("很尴尬")).toEqual(["很", "很尴", "很尴尬", "尴", "尴尬", "尬"]);
  });

  it("停用词剔除单字虚词，但含虚词的多字 gram 保留（偏召回）", () => {
    const tokens = tokenize("的情绪");
    expect(tokens).not.toContain("的");
    expect(tokens).toContain("的情");
  });

  it("ASCII 词整体成 token，词内撇号/连字符/下划线保留", () => {
    expect(tokenize("don't state-of-art foo_bar")).toEqual(["don't", "state-of-art", "foo_bar"]);
  });

  it("NFKC 归一 + 小写：全角与大小写折叠到同一 token", () => {
    expect(tokenize("ＡＰＰＬｅ")).toEqual(tokenize("apple"));
  });

  it("混合文本按扫描顺序产 token，重复保留（BM25 需要 tf）", () => {
    const tokens = tokenize("难堪 难堪");
    expect(tokens.filter((t) => t === "难堪")).toHaveLength(2);
    const mixed = tokenize("felt 很难");
    expect(mixed[0]).toBe("felt");
    expect(mixed).toContain("很难");
  });

  it("确定性：同一输入连续调用 100 次结果逐位相同（含全局正则状态复位）", () => {
    const input = "那天真的很尴尬，and I felt awful， awful 也一样";
    const first = tokenize(input);
    for (let i = 0; i < 100; i += 1) {
      expect(tokenize(input)).toEqual(first);
    }
  });

  it("空输入与纯标点输入产出空数组", () => {
    expect(tokenize("")).toEqual([]);
    expect(tokenize("！！！。。。~~~")).toEqual([]);
  });

  it("序列化契约：写入列与查询串共用同一 token 序列，split 可逆", () => {
    const tokens = tokenize("尴尬的情绪 mixed token");
    expect(deserializeTokens(serializeTokens(tokens))).toEqual(tokens);
    expect(serializeTokens([])).toBe("");
  });

  it("isCjk 判定段种，停用词表为封闭小表", () => {
    expect(isCjk("难堪")).toBe(true);
    expect(isCjk("apple")).toBe(false);
    expect(STOPWORDS.has("的")).toBe(true);
    expect(STOPWORDS.has("难堪")).toBe(false);
  });
});
