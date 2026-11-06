/**
 * M9-3 专项测试：本地模型候选接进脱敏与预览（执行准则 §五 P1–P8）。
 *
 * 本批只做**预览层**：`redact()` 收额外候选、`preparePreview` 收候选并升 policy、
 * 异步装配 `resolveLocalLlmPreview`。HTTP 路由、accept/send 路径、前端、占位门
 * 一律未动（M9-4）。所以这里断言的落点是三件事：
 * 1. **替换集合变了 ⇒ 策略版本变了 ⇒ 授权不跨档复用**（K-17 的另一面）；
 * 2. **优先级是显式的**：规则/实体记忆命中的区间不可能被 LLM 候选覆盖或切成两段；
 * 3. **缺省路径逐字不变**：不带 LLM 层时，文本、哈希、缓存行为与改动前同形。
 *
 * 全程离线：数据库只落 TB_DATA_DIR 沙箱；本地模型一律假 fetch，不碰 socket。
 * LLM 候选的直接入参（`llmSpans`）与经由装配的入参（假服务回稿）都覆盖到。
 */

import { afterEach, describe, expect, it } from "vitest";

import type { Database } from "../src/server/db/adapter.ts";
import { migrate } from "../src/server/db/migrator.ts";
import type { ModelAdapter } from "../src/server/ingest/provider.ts";
import {
  CloudSendAuthorizationRequiredError,
  GrantService,
  type PreviewOptions,
  type SendPreview,
} from "../src/server/privacy/grantService.ts";
import {
  LOCAL_LLM_POLICY_VERSION,
  REDACTION_POLICY_VERSION,
  redact,
  sha256OfText,
  type KnownEntity,
} from "../src/server/privacy/redaction.ts";
import { resolveLocalLlmPreview, LocalLlmConsultFailedError } from "../src/server/privacy/localLlmPreview.ts";
import { makeSandbox, openSandboxDb, type Sandbox } from "./helpers/sandbox.ts";
import { createRecord } from "./helpers/ingestFixtures.ts";

const NONCE = "a1b2c3";

/** 一句凑齐四层命中的原文：实体记忆（张三）、规则（手机号）、LLM 建议（咖啡馆 / 作品名）。 */
const RAW = "张三说：周三在蓝山咖啡馆见，电话 13800138000，聊聊《星海》";
const PHONE = "13800138000";
const CAFE = "蓝山咖啡馆";
const WORK = "《星海》";

const ENTITY_ZHANG: KnownEntity = { entityId: "e_zhang", entityType: "person", terms: ["张三"] };

const at = (term: string): number => {
  const index = RAW.indexOf(term);
  if (index < 0) throw new Error(`夹具文本里没有 ${term}`);
  return index;
};

/** 一条 LLM 候选：坐标锚定 `RAW` 的 UTF-16 偏移，与 `localLlm.ts` 产出的形状同形。 */
const llmSpan = (term: string, kind: string) => ({ start: at(term), end: at(term) + term.length, kind });

/* ── 沙箱与夹具 ───────────────────────────────────────────────────── */

let sandbox: Sandbox | undefined;
let db: Database | undefined;
let grants: GrantService;
let revisionId = "";

function setup(rawText: string = RAW): GrantService {
  sandbox = makeSandbox("tb-m9-3-");
  db = openSandboxDb(sandbox.layout);
  migrate(db);
  const record = createRecord(db, rawText, "cloud_redacted");
  revisionId = record.revisionId;
  grants = new GrantService(db, { now: () => new Date("2026-10-28T01:00:00.000Z") });
  return grants;
}

afterEach(() => {
  db?.close();
  sandbox?.cleanup();
  db = undefined;
  sandbox = undefined;
  revisionId = "";
});

/** 缺省入参：注入 nonce 与实体清单，让两份预览只差在 LLM 层。 */
const base = (options: PreviewOptions = {}): SendPreview =>
  grants.preparePreview(revisionId, { nonce: NONCE, entities: [ENTITY_ZHANG], ...options });

/* M9-4a / M9-D-6 之后不再有裸 SQL 授权夹具：脱敏轨的签发口接受封闭集
   `rules-v2 | rules+local_llm-v2`，P2/P6 两档都直接走 `issueGrant`。 */

/* ── 假本地模型端点 ───────────────────────────────────────────────── */

function adapter(overrides: Partial<ModelAdapter> = {}): ModelAdapter {
  return {
    provider: "ollama",
    model: "qwen3:8b",
    baseUrl: "http://127.0.0.1:11434/v1",
    callPath: "ollama_openai_compatible",
    supportsStructuredOutput: false,
    requestTimeoutMs: 1000,
    ...overrides,
  };
}

function envelope(content: string): string {
  return JSON.stringify({ choices: [{ message: { content } }] });
}

function candidatesJson(
  entries: readonly { start: number; end: number; kind: string; surface: string }[],
): string {
  return envelope(JSON.stringify({ candidates: entries }));
}

/** 假 fetch：固定回稿，并记下调用次数与请求体（P7 要断言「一次都不发」）。 */
function fetchReturning(body: string): { fetchImpl: typeof fetch; state: { calls: number; bodies: string[] } } {
  const state = { calls: 0, bodies: [] as string[] };
  const impl = (_input: unknown, init?: RequestInit): Promise<Response> => {
    state.calls += 1;
    state.bodies.push(typeof init?.body === "string" ? init.body : "");
    return Promise.resolve({ status: 200, text: () => Promise.resolve(body) } as unknown as Response);
  };
  return { fetchImpl: impl as unknown as typeof fetch, state };
}

function fetchHanging(): typeof fetch {
  const impl = (_input: unknown, init?: { signal?: AbortSignal }): Promise<Response> =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("The user aborted a request.")));
    });
  return impl as unknown as typeof fetch;
}

/* ── P1 策略版本 ──────────────────────────────────────────────────── */

describe("P1 LLM 参与与否决定 policyVersion（逐字）", () => {
  it("不带 llmSpans ⇒ 'rules-v2'（缺省路径的字面量不变）", () => {
    setup();
    const preview = base();
    expect(preview.policyVersion).toBe("rules-v2");
    expect(preview.policyVersion).toBe(REDACTION_POLICY_VERSION);
    expect(preview.map.policyVersion).toBe("rules-v2");
    expect(preview.llmLayer.used).toBe(false);
  });

  it("带 llmSpans（非空）⇒ 'rules+local_llm-v2'", () => {
    setup();
    const preview = base({ llmSpans: [llmSpan(CAFE, "place")] });
    expect(preview.policyVersion).toBe("rules+local_llm-v2");
    expect(preview.policyVersion).toBe(LOCAL_LLM_POLICY_VERSION);
    expect(preview.llmLayer).toMatchObject({ used: true, candidates: 1 });
  });

  it("带空数组也算「这一档跑过了」⇒ 仍是 LLM 档（与「没跑」不是同一件事）", () => {
    setup();
    const preview = base({ llmSpans: [] });
    expect(preview.policyVersion).toBe(LOCAL_LLM_POLICY_VERSION);
    expect(preview.llmLayer).toMatchObject({ used: true, candidates: 0, dropped: 0 });
  });

  it("redact() 单点：extraCandidates 与 policyVersion 各自独立生效", () => {
    const plain = redact(RAW, [ENTITY_ZHANG], { nonce: NONCE });
    expect(plain.map.policyVersion).toBe(REDACTION_POLICY_VERSION);
    const withLlm = redact(RAW, [ENTITY_ZHANG], {
      nonce: NONCE,
      extraCandidates: [llmSpan(WORK, "person")],
      policyVersion: LOCAL_LLM_POLICY_VERSION,
    });
    expect(withLlm.map.policyVersion).toBe(LOCAL_LLM_POLICY_VERSION);
    // 不传 policyVersion 也不许自己升版：升版是调用方的判定，不是「有额外候选」的副产品。
    const implicit = redact(RAW, [ENTITY_ZHANG], { nonce: NONCE, extraCandidates: [llmSpan(WORK, "person")] });
    expect(implicit.map.policyVersion).toBe(REDACTION_POLICY_VERSION);
  });
});

/* ── P2 两种模式不同载荷，grant 不跨 policy ───────────────────────── */

describe("P2 LLM 档换了替换集合 ⇒ 载荷不同 ⇒ 旧授权不适用", () => {
  it("同一原文两次预览：redactedText 与 payloadSha256 都不同", () => {
    setup();
    const rules = base();
    const llm = base({ llmSpans: [llmSpan(CAFE, "place"), llmSpan(WORK, "person")] });
    expect(llm.redactedText).not.toBe(rules.redactedText);
    expect(llm.payloadSha256).not.toBe(rules.payloadSha256);
    expect(llm.payloadSha256).toBe(sha256OfText(llm.payloadText));
    expect(rules.redactedText).toContain(CAFE);
    expect(llm.redactedText).not.toContain(CAFE);
    expect(llm.redactedText).not.toContain(WORK);
  });

  it("rules-v2 的授权对 LLM 档不适用，反之亦然（requireApplicableGrant 四腿）", () => {
    setup();
    const rules = base();
    const llm = base({ llmSpans: [llmSpan(CAFE, "place")] });
    const rulesGrant = grants.issueGrant(rules);
    const llmGrant = grants.issueGrant(llm);
    expect(rulesGrant.policy_version).toBe(REDACTION_POLICY_VERSION);
    expect(llmGrant.policy_version).toBe(LOCAL_LLM_POLICY_VERSION);

    // 旧 policy 的 grant 对新 policy 不适用：revision/载荷…即便对上，policy 这一腿断掉
    expect(
      grants.findApplicableGrant(revisionId, rules.payloadSha256, llm.policyVersion, "redacted"),
    ).toBeNull();
    expect(() =>
      grants.requireApplicableGrant(revisionId, rules.payloadSha256, llm.policyVersion, "redacted"),
    ).toThrow(CloudSendAuthorizationRequiredError);

    // 反向：LLM 档的授权也不构成对 rules-v2 的授权
    expect(grants.requireApplicableGrant(revisionId, llm.payloadSha256, LOCAL_LLM_POLICY_VERSION, "redacted").id).toBe(
      llmGrant.id,
    );
    expect(
      grants.findApplicableGrant(revisionId, rules.payloadSha256, REDACTION_POLICY_VERSION, "redacted")?.id,
    ).toBe(rulesGrant.id);
    expect(
      grants.findApplicableGrant(revisionId, llm.payloadSha256, REDACTION_POLICY_VERSION, "redacted"),
    ).toBeNull();
  });

  it("LLM 档签得出授权：脱敏轨的签发口认这一支（M9-D-6 翻正了 M9-3 钉下的现状）", () => {
    setup();
    const llm = base({ llmSpans: [llmSpan(CAFE, "place")] });
    const grant = grants.issueGrant(llm);
    expect(grant.policy_version).toBe("rules+local_llm-v2");
    expect(grants.grantForPreview(llm)?.id).toBe(grant.id);
  });
});

/* ── P3 / P4 优先级是显式的 ───────────────────────────────────────── */

describe("P3 规则命中优先于 LLM 候选", () => {
  it("与手机号重叠的候选被整条剔除：只留 source=rule 的那一个 span", () => {
    setup();
    const overlapping = { start: at(PHONE) + 3, end: at(PHONE) + 6, kind: "person" };
    const preview = base({ llmSpans: [overlapping] });
    const phoneSpans = preview.spans.filter((s) => s.kind === "phone");
    expect(phoneSpans).toHaveLength(1);
    expect(phoneSpans[0]!.source).toBe("rule");
    expect(phoneSpans[0]!.originalStart).toBe(at(PHONE));
    expect(phoneSpans[0]!.originalEnd).toBe(at(PHONE) + PHONE.length);
    // 没有第二个 span 落在手机号区间里，也没有 source=local_llm 的残留
    expect(preview.spans.filter((s) => s.source === "local_llm")).toHaveLength(0);
    expect(preview.redactedText).toContain("[phone_1_a1b2c3]");
    expect(preview.redactedText).not.toContain(PHONE);
  });

  it("完全等于规则命中的候选同样被剔除（不是「两个 span 抢同一区间」）", () => {
    setup();
    const same = llmSpan(PHONE, "person");
    const preview = base({ llmSpans: [same] });
    expect(preview.spans.filter((s) => s.originalStart === at(PHONE))).toHaveLength(1);
    expect(preview.spans.find((s) => s.originalStart === at(PHONE))!.source).toBe("rule");
  });
});

describe("P4 实体记忆命中优先于 LLM 候选", () => {
  it("与已知实体重叠的候选被剔除：span 的 source=entity_memory", () => {
    setup();
    const preview = base({ llmSpans: [llmSpan("张三说", "person")] });
    const zhangSpans = preview.spans.filter((s) => s.originalStart === at("张三"));
    expect(zhangSpans).toHaveLength(1);
    expect(zhangSpans[0]!.source).toBe("entity_memory");
    expect(preview.spans.filter((s) => s.source === "local_llm")).toHaveLength(0);
  });

  it("不重叠的 LLM 候选正常生效且带 source=local_llm", () => {
    setup();
    const preview = base({ llmSpans: [llmSpan(CAFE, "place")] });
    const cafe = preview.spans.find((s) => s.originalStart === at(CAFE));
    expect(cafe).toBeTruthy();
    expect(cafe!.source).toBe("local_llm");
    expect(cafe!.kind).toBe("place");
    expect(cafe!.placeholder).toBe("[place_1_a1b2c3]");
    // 三层来源在同一次预览里各归各位：实体记忆 / LLM / 规则
    expect(preview.spans.map((s) => s.source).sort()).toEqual(["entity_memory", "local_llm", "rule"]);
  });

  it("区间不成立的候选不进替换集合（非整数 / 越界 / 倒置）", () => {
    setup();
    const preview = base({
      llmSpans: [
        { start: at(CAFE), end: at(CAFE) + 0.5, kind: "place" },
        { start: -1, end: 3, kind: "place" },
        { start: RAW.length, end: RAW.length + 5, kind: "place" },
        { start: at(WORK), end: at(WORK), kind: "person" },
      ],
    });
    expect(preview.spans.filter((s) => s.source === "local_llm")).toHaveLength(0);
    expect(preview.redactedText).toContain(CAFE);
  });
});

/* ── P5 预览缓存：LLM 档不写也不读 ────────────────────────────────── */

describe("P5 预览缓存按档位分道：规则档两键、LLM 档三键（M9-D-8 修正了 D3）", () => {
  function cacheRows(): { key: string; value: string }[] {
    return db!
      .prepare("select key, value from app_meta where key like 'preview_%'")
      .all() as { key: string; value: string }[];
  }

  it("非 LLM 档回归：首预览写两键，二预览复用同一 nonce 与同一载荷", () => {
    setup();
    expect(cacheRows()).toHaveLength(0);
    const p1 = grants.preparePreview(revisionId, { entities: [ENTITY_ZHANG] });
    const p2 = grants.preparePreview(revisionId, { entities: [ENTITY_ZHANG] });
    expect(cacheRows().map((r) => r.key).sort()).toEqual([
      `preview_v2_nonce:${revisionId}`,
      `preview_v2_payload:${revisionId}`,
    ]);
    expect(p2.payloadText).toBe(p1.payloadText);
    expect(p2.payloadSha256).toBe(p1.payloadSha256);
    expect(p2.map.nonce).toBe(p1.map.nonce);
  });

  it("LLM 档只写自己那三键：`preview_llm_*`，规则档的两键不存在", () => {
    setup();
    const threeKeys = [
      `preview_llm_v2_spans:${revisionId}`,
      `preview_llm_v2_nonce:${revisionId}`,
      `preview_llm_v2_payload:${revisionId}`,
    ].sort();
    grants.preparePreview(revisionId, { entities: [ENTITY_ZHANG], llmSpans: [llmSpan(CAFE, "place")] });
    expect(cacheRows().map((r) => r.key).sort()).toEqual(threeKeys);
    // 键名换了（M9-D-9），语义不变：这一档的产物各归各的键，规则档那两枚它从不写。
    expect(cacheRows().find((r) => r.key === `preview_v2_nonce:${revisionId}`)).toBeUndefined();
    expect(cacheRows().find((r) => r.key === `preview_v2_payload:${revisionId}`)).toBeUndefined();
    // 第三键只含 kind + 偏移：词面本体（`surface`）不落盘。
    const spansValue = cacheRows().find((r) => r.key === `preview_llm_v2_spans:${revisionId}`)!.value;
    expect(JSON.parse(spansValue)).toEqual([{ kind: "place", start: at(CAFE), end: at(CAFE) + CAFE.length }]);
    expect(spansValue).not.toContain(CAFE);

    // 第二次首预览覆盖同一键，不新增第四键（键名与 revision 一一对应）。
    grants.preparePreview(revisionId, { entities: [ENTITY_ZHANG], llmSpans: [] });
    expect(cacheRows().map((r) => r.key).sort()).toEqual(threeKeys);
    expect(cacheRows().find((r) => r.key === `preview_llm_v2_spans:${revisionId}`)!.value).toBe("[]");
  });

  it("LLM 档不拿规则档那份被替换的 payload 当默认值（本意不变，依据换成档位隔离）", () => {
    setup();
    const rules = grants.preparePreview(revisionId, { entities: [ENTITY_ZHANG] });
    const replaced = `${rules.payloadText}（用户手工改过）`;
    const withReplacement = grants.preparePreview(revisionId, {
      entities: [ENTITY_ZHANG],
      payloadText: replaced,
    });
    expect(withReplacement.payloadText).toBe(replaced);

    // 旧依据（M9-3 / D3）是「LLM 档完全不读缓存」；新依据（M9-D-8）是「首预览自己算载荷」+
    // 「采信区间只存 `preview_llm_v2_spans:` 这一个键，规则档从不读它」。跨档串用的本意仍然成立：
    // 这一档的缺省载荷必须是它自己那份脱敏文本，而不是别档缓存里的替换文本。
    const llm = grants.preparePreview(revisionId, { entities: [ENTITY_ZHANG], llmSpans: [llmSpan(CAFE, "place")] });
    expect(llm.payloadText).not.toBe(replaced);
    expect(llm.payloadText).toBe(llm.redactedText);
    expect(llm.payloadSha256).toBe(sha256OfText(llm.redactedText));
    // 反向同理：规则档重算一次，产出里没有一条来源是 local_llm——它读不到那一键。
    const rulesAgain = grants.preparePreview(revisionId, {
      entities: [ENTITY_ZHANG],
      tier: "rules",
      nonce: NONCE,
    });
    expect(rulesAgain.policyVersion).toBe(REDACTION_POLICY_VERSION);
    expect(rulesAgain.spans.filter((s) => s.source === "local_llm")).toHaveLength(0);
    expect(rulesAgain.redactedText).toContain(CAFE);
  });

  it("同一 revision 两次 LLM 预览：nonce 与载荷都相同，第二次不再调模型（M9-D-8 的正解）", async () => {
    setup();
    const spy = fetchReturning(
      candidatesJson([{ start: at(CAFE), end: at(CAFE) + CAFE.length, kind: "place", surface: CAFE }]),
    );
    const first = await resolveLocalLlmPreview(grants, adapter(), revisionId, {
      entities: [ENTITY_ZHANG],
      fetchImpl: spy.fetchImpl,
    });
    // 旧断言（「每次现生成 nonce ⇒ 两次不同」）正是这一档签不出的根因：op6 确认的那份
    // 与 op2 发送的那份哈希对不上。缓存落三键之后，复现逐字一致，签发口才真正有用。
    const second = grants.preparePreview(revisionId, { entities: [ENTITY_ZHANG], tier: "local_llm" });
    expect(spy.state.calls).toBe(1);
    expect(second.map.nonce).toBe(first.map.nonce);
    expect(second.payloadText).toBe(first.payloadText);
    expect(second.payloadSha256).toBe(first.payloadSha256);
    expect(second.redactedText).toBe(first.redactedText);
  });
});

/* ── P6 用户点掉一条候选 ─────────────────────────────────────────── */

describe("P6 点掉一条 LLM 候选 ⇒ 载荷变化 ⇒ 旧授权失效", () => {
  it("两条候选 vs 只回传一条：哈希不同，四腿匹配断在载荷与 policy 上", () => {
    setup();
    const both = base({ llmSpans: [llmSpan(CAFE, "place"), llmSpan(WORK, "person")] });
    const bothGrant = grants.issueGrant(both);
    expect(grants.requireApplicableGrant(revisionId, both.payloadSha256, both.policyVersion, "redacted").id).toBe(
      bothGrant.id,
    );

    const droppedOne = base({ llmSpans: [llmSpan(CAFE, "place")] });
    expect(droppedOne.redactedText).not.toBe(both.redactedText);
    expect(droppedOne.payloadSha256).not.toBe(both.payloadSha256);
    expect(droppedOne.redactedText).toContain(WORK);
    expect(() =>
      grants.requireApplicableGrant(revisionId, droppedOne.payloadSha256, droppedOne.policyVersion, "redacted"),
    ).toThrow(/没有适用授权/);
    expect(grants.grantForPreview(droppedOne)).toBeNull();
    // 点掉候选不降 policy：这一档仍然声明「本地模型参与过」
    expect(droppedOne.policyVersion).toBe(LOCAL_LLM_POLICY_VERSION);
  });
});

/* ── P7 装配层：adapter=null ⇒ 纯规则、零请求 ─────────────────────── */

describe("P7 resolveLocalLlmPreview(adapter=null) 阻断", () => {
  it("不跑 fetch、抛 LocalLlmConsultFailedError、不写任何缓存", async () => {
    setup();
    const spy = fetchReturning(envelope("{}"));
    await expect(
      resolveLocalLlmPreview(grants, null, revisionId, {
        entities: [ENTITY_ZHANG],
        nonce: NONCE,
        fetchImpl: spy.fetchImpl,
      }),
    ).rejects.toBeInstanceOf(LocalLlmConsultFailedError);
    expect(spy.state.calls).toBe(0);
    expect(grants.hasCachedLlmSpans(revisionId)).toBe(false);
  });
});

/* ── P8 propose 失败 ──────────────────────────────────────────────── */

describe("P8 本地模型没跑成 ⇒ 抛 LocalLlmConsultFailedError，不回落规则档", () => {
  it("超时 ⇒ failureKind=timeout，只落失败标记", async () => {
    setup();
    await expect(
      resolveLocalLlmPreview(grants, adapter({ requestTimeoutMs: 30 }), revisionId, {
        entities: [ENTITY_ZHANG],
        nonce: NONCE,
        fetchImpl: fetchHanging(),
      }),
    ).rejects.toBeInstanceOf(LocalLlmConsultFailedError);
    expect(grants.llmConsultFailedKind(revisionId)).toBe("timeout");
    expect(grants.hasCachedLlmSpans(revisionId)).toBe(false);
    expect(grants.hasCachedPayload(revisionId, "rules")).toBe(false);
  });

  it("坏 JSON ⇒ failureKind=invalid_json，且抛", async () => {
    setup();
    const spy = fetchReturning(envelope("<html>502 Bad Gateway</html>"));
    await expect(
      resolveLocalLlmPreview(grants, adapter(), revisionId, {
        entities: [ENTITY_ZHANG],
        nonce: NONCE,
        fetchImpl: spy.fetchImpl,
      }),
    ).rejects.toBeInstanceOf(LocalLlmConsultFailedError);
    expect(spy.state.calls).toBe(1);
    expect(grants.llmConsultFailedKind(revisionId)).toBe("invalid_json");
  });

  it("非回环端点 ⇒ not_loopback，一次请求都不发", async () => {
    setup();
    const spy = fetchReturning(envelope(JSON.stringify({ candidates: [] })));
    await expect(
      resolveLocalLlmPreview(grants, adapter({ baseUrl: "http://192.168.1.9:11434/v1" }), revisionId, {
        entities: [ENTITY_ZHANG],
        nonce: NONCE,
        fetchImpl: spy.fetchImpl,
      }),
    ).rejects.toBeInstanceOf(LocalLlmConsultFailedError);
    expect(spy.state.calls).toBe(0);
    expect(grants.llmConsultFailedKind(revisionId)).toBe("not_loopback");
  });

  it("成功回稿走装配：候选进替换集合且 used=true", async () => {
    setup();
    const spy = fetchReturning(
      candidatesJson([
        { start: at(CAFE), end: at(CAFE) + CAFE.length, kind: "place", surface: CAFE },
        { start: at(WORK), end: at(WORK) + WORK.length, kind: "person", surface: WORK },
      ]),
    );
    const preview = await resolveLocalLlmPreview(grants, adapter(), revisionId, {
      entities: [ENTITY_ZHANG],
      nonce: NONCE,
      fetchImpl: spy.fetchImpl,
    });
    expect(preview.llmLayer).toMatchObject({ used: true, candidates: 2, dropped: 0 });
    expect(preview.policyVersion).toBe(LOCAL_LLM_POLICY_VERSION);
    expect(preview.redactedText).not.toContain(CAFE);
    expect(preview.redactedText).not.toContain(WORK);
    expect(preview.spans.filter((s) => s.source === "local_llm")).toHaveLength(2);
    // 假服务的请求体里带的是原文（本地回环，符合 P-1）；载荷本身不含任何 LLM 档以外的新内容
    expect(spy.state.bodies[0]).toContain(RAW);
  });

  it("回稿全被严格校验丢掉 ⇒ used=true 且 candidates=0、dropped 如实", async () => {
    setup();
    const spy = fetchReturning(
      candidatesJson([{ start: 999, end: 1003, kind: "place", surface: "不存在" }]),
    );
    const preview = await resolveLocalLlmPreview(grants, adapter(), revisionId, {
      entities: [ENTITY_ZHANG],
      nonce: NONCE,
      fetchImpl: spy.fetchImpl,
    });
    expect(preview.llmLayer).toMatchObject({ used: true, candidates: 0, dropped: 1 });
    expect(preview.policyVersion).toBe(LOCAL_LLM_POLICY_VERSION);
  });

  it("陌生 revision 仍按既有语义抛 RevisionNotFoundError（装配层不吞服务层错误）", async () => {
    setup();
    await expect(
      resolveLocalLlmPreview(grants, adapter(), "rr_missing", {
        fetchImpl: fetchReturning("{}").fetchImpl,
      }),
    ).rejects.toThrow(/记录版本不存在/);
  });
});
