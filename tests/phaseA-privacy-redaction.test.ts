import { describe, expect, it } from "vitest";

import {
  REDACTION_POLICY_VERSION,
  collectKnownEntities,
  redact,
  type KnownEntity,
} from "../src/server/privacy/redaction.ts";
import { findFormatCandidates } from "../src/server/privacy/rules.ts";

const NONCE = "a1b2c3";

function kindsOf(text: string): string[] {
  return findFormatCandidates(text).map((candidate) => candidate.kind);
}

function entity(overrides: Partial<KnownEntity> & Pick<KnownEntity, "entityId" | "entityType" | "terms">): KnownEntity {
  return overrides;
}

describe("Phase A · L0 只做格式类", () => {
  it("手机号与邮箱仍然命中", () => {
    expect(kindsOf("打 13800138000 或 zhang@example.com 找我")).toEqual(["phone", "email"]);
  });

  it("身份证必须过 GB 11643 校验位", () => {
    expect(kindsOf("身份证 11010519491231002X")).toEqual(["id_number"]);
    expect(kindsOf("编号 110105194912310021")).toEqual([]);
  });

  it("银行卡必须过 Luhn，订单号不误伤", () => {
    expect(kindsOf("卡号 4111 1111 1111 1111")).toEqual(["bank_card"]);
    expect(kindsOf("订单 1234567890123456")).toEqual([]);
  });

  it("密钥/token 的常见形态", () => {
    expect(kindsOf("sk-abcdefghijklmnop1234")).toEqual(["secret"]);
    expect(kindsOf("AKIAABCDEFGHIJKLMNOP")).toEqual(["secret"]);
    // URL 凭据里 `pass@example.com` 也会命中邮箱正则；redact 的重叠消解保留更早的 secret。
    expect(redact("https://user:pass@example.com/x", [], { nonce: NONCE }).map.spans.map((s) => s.kind)).toEqual([
      "secret",
    ]);
    expect(redact("https://example.com/x?token=abcdef123456", [], { nonce: NONCE }).map.spans.map((s) => s.kind)).toEqual([
      "secret",
    ]);
  });

  it("格式类不碰语义词", () => {
    expect(kindsOf("张三在杭州，字节跳动附近，聊《三体》和 iPhone 15")).toEqual([]);
  });

  it("redact 仍产出互不重叠的 spans；手机号占位符形状未变", () => {
    const result = redact("打 13800138000 给张三", [], { nonce: NONCE });
    expect(result.redactedText).toBe("打 [phone_1_a1b2c3] 给张三");
    expect(result.map.policyVersion).toBe(REDACTION_POLICY_VERSION);
  });
});

describe("Phase A · L1 词表只遮三类", () => {
  const raw = "张三在杭州，字节跳动附近，聊《三体》和 iPhone 15";

  it("person / place / organization 会遮", () => {
    const result = redact(raw, [
      entity({ entityId: "entity_1", entityType: "person", terms: ["张三"], originType: "user_created" }),
      entity({ entityId: "entity_2", entityType: "place", terms: ["杭州"], originType: "user_created" }),
      entity({ entityId: "entity_3", entityType: "organization", terms: ["字节跳动"], originType: "user_created" }),
    ], { nonce: NONCE });
    expect(result.map.spans.map((span) => span.kind)).toEqual(["person", "place", "organization"]);
  });

  it("work / product 即使 user_created 也不遮", () => {
    const result = redact(raw, [
      entity({ entityId: "entity_4", entityType: "work", terms: ["《三体》"], originType: "user_created" }),
      entity({ entityId: "entity_5", entityType: "product", terms: ["iPhone 15"], originType: "user_created" }),
    ], { nonce: NONCE });
    expect(result.map.spans).toEqual([]);
  });

  it("单字、泛称、无边界拉丁词不遮", () => {
    const result = redact("王老板在 Announcement 里说", [
      entity({ entityId: "entity_6", entityType: "person", terms: ["王"], originType: "user_created" }),
      entity({ entityId: "entity_7", entityType: "person", terms: ["老板"], originType: "user_created" }),
      entity({ entityId: "entity_8", entityType: "person", terms: ["Ann"], originType: "user_created" }),
    ], { nonce: NONCE });
    expect(result.map.spans).toEqual([]);
  });

  it("ai_generated + provisional：没有 explicit 提及就不遮；有才遮", () => {
    const base = entity({
      entityId: "entity_9",
      entityType: "person",
      terms: ["张三"],
      originType: "ai_generated",
      lifecycleStatus: "provisional",
    });
    expect(redact("张三来了", [base], { nonce: NONCE }).map.spans).toEqual([]);
    expect(redact("张三来了", [{ ...base, hasExplicitActiveMention: true }], { nonce: NONCE }).map.spans).toHaveLength(1);
  });

  it("collectKnownEntities 仍从 entity + entity_alias 读词面", () => {
    // 这个用例只钉接口形状：真实库由 m2-privacy 的夹具覆盖。
    expect(typeof collectKnownEntities).toBe("function");
  });
});
