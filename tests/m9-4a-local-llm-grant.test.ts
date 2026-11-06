/**
 * M9-4a 专项测试：本地模型档**能签发、能复现**（服务层 + 缓存，不接路由）。
 *
 * 这一批修的是 M9-3 按旧 D3 留下的缺口：LLM 档不读不写预览缓存 ⇒ 同一 revision 两次预览
 * nonce 不同 ⇒ 载荷与哈希不同 ⇒ 用户在 op6 确认的那份到 op2 真正发送时对不上号，授权永不
 * 命中——那一档只能看不能发。M9-D-8 把「采信的区间」落进 `preview_llm_v2_spans:<revisionId>`
 * （只 `{kind,start,end}` 三列，不含原文更不含词面）；M9-D-9 进一步把这一档的 nonce 与载荷
 * 也拆成自己的两键 `preview_llm_v2_nonce:` / `preview_llm_v2_payload:`，规则档那两枚
 * `preview_v2_nonce:` / `preview_v2_payload:` 因此一个字节都没动——共用键会让规则档把含 LLM
 * 占位符的载荷当缺省待发送文本（哈希与 `map` 描述两份不同的东西），也会让任一档重写 nonce
 * 时使另一档已缓存的载荷内部占位符过期。
 *
 * 断言因此分四条主线：
 * 1. **签发口**（M9-D-6）：脱敏轨接受一个封闭策略集，raw 轨仍只认 `raw-v1`，两轨互不顶替；
 * 2. **五键的读写时机**：本档首预览写、本档复现读、两档各读各的键互不可见，硬删除连五键一起清；
 * 3. **不静默降级**：`local_llm` 档缺缓存或缓存损坏 ⇒ 抛可读错误，绝不当成「这一档没跑过」。
 * 4. **档位隔离**（M9-D-9）：交替预览/复现四次的产出两两对照，键集恰为五枚、无第六枚。
 *
 * 全程离线：数据库只落 TB_DATA_DIR 沙箱；本地模型一律假 fetch，不碰 socket。
 * 路由、占位门、前端、Trace 一律未动（M9-4b / M9-4c）。
 */

import { afterEach, describe, expect, it } from "vitest";

import type { Database } from "../src/server/db/adapter.ts";
import { deleteMeta, migrate, setMeta } from "../src/server/db/migrator.ts";
import type { ModelAdapter } from "../src/server/ingest/provider.ts";
import {
  CloudSendAuthorizationRequiredError,
  GrantService,
  LocalLlmTierCacheMissingError,
  PolicyVersionError,
  REDACTED_TRACK_POLICY_VERSIONS,
  isGrantablePolicyVersion,
  purgePreviewCache,
  type PreviewOptions,
  type SendPreview,
} from "../src/server/privacy/grantService.ts";
import {
  LOCAL_LLM_POLICY_VERSION,
  RAW_SEND_POLICY_VERSION,
  REDACTION_POLICY_VERSION,
  parseRedactionMap,
  redact,
  redactionMapJsonValue,
  type KnownEntity,
} from "../src/server/privacy/redaction.ts";
import { resolveLocalLlmPreview, LocalLlmConsultFailedError } from "../src/server/privacy/localLlmPreview.ts";
import { previewForEgress } from "../src/server/privacy/egressPreview.ts";
import type { ThreeAxes } from "../src/shared/contracts/enums.ts";
import { countRows, makeSandbox, openSandboxDb, type Sandbox } from "./helpers/sandbox.ts";
import { createRecord } from "./helpers/ingestFixtures.ts";

const NONCE = "a1b2c3";

/** 一句凑齐四层命中的原文：实体记忆（张三）、规则（手机号）、LLM 建议（咖啡馆 / 作品名）。 */
const RAW = "张三说：周三在蓝山咖啡馆见，电话 13800138000，聊聊《星海》";
const ZHANG = "张三";
const PHONE = "13800138000";
const CAFE = "蓝山咖啡馆";
const WORK = "《星海》";
/** 缓存里不许出现的词面：原文本体 + 每一个被遮住的词面（M9-D-8 的暴露面判据）。 */
const FACES = [RAW, ZHANG, PHONE, CAFE, WORK];

const SPANS_KEY = (revisionId: string): string => `preview_llm_v2_spans:${revisionId}`;
/** 本地模型档自己的两键（M9-D-9：与规则档那两枚同构，只是各归各的档位）。 */
const LLM_NONCE_KEY = (revisionId: string): string => `preview_llm_v2_nonce:${revisionId}`;
const LLM_PAYLOAD_KEY = (revisionId: string): string => `preview_llm_v2_payload:${revisionId}`;
/** 规则档的两键：本批里它们**只该被规则档读写**，逐字不变（`m3-grant-1` / `m6-0f` 的口径）。 */
const RULES_NONCE_KEY = (revisionId: string): string => `preview_v2_nonce:${revisionId}`;
const RULES_PAYLOAD_KEY = (revisionId: string): string => `preview_v2_payload:${revisionId}`;
/** 五键全清单，按字典序——`app_meta` 里 `preview_%` 的合法键集就这么多，没有第六个。 */
const ALL_FIVE_KEYS = (revisionId: string): string[] =>
  [
    RULES_NONCE_KEY(revisionId),
    RULES_PAYLOAD_KEY(revisionId),
    LLM_NONCE_KEY(revisionId),
    LLM_PAYLOAD_KEY(revisionId),
    SPANS_KEY(revisionId),
  ].sort();
/** 本地模型档那一套的三键。 */
const LLM_THREE_KEYS = (revisionId: string): string[] =>
  [LLM_NONCE_KEY(revisionId), LLM_PAYLOAD_KEY(revisionId), SPANS_KEY(revisionId)].sort();

const ENTITY_ZHANG: KnownEntity = { entityId: "e_zhang", entityType: "person", terms: [ZHANG] };

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
  sandbox = makeSandbox("tb-m9-4a-");
  db = openSandboxDb(sandbox.layout);
  migrate(db);
  const record = createRecord(db, rawText, "cloud_redacted");
  revisionId = record.revisionId;
  grants = new GrantService(db, { now: () => new Date("2026-10-29T01:00:00.000Z") });
  return grants;
}

afterEach(() => {
  db?.close();
  sandbox?.cleanup();
  db = undefined;
  sandbox = undefined;
  revisionId = "";
});

/** 注入 nonce 的缺省入参：缓存完全绕过，断言只关心脱敏与签发本身。 */
const base = (options: PreviewOptions = {}): SendPreview =>
  grants.preparePreview(revisionId, { nonce: NONCE, entities: [ENTITY_ZHANG], ...options });

/** 不注入 nonce 的入参：走真实缓存路径（op6 首预览 / op7-op2 复现）。 */
const live = (options: PreviewOptions = {}): SendPreview =>
  grants.preparePreview(revisionId, { entities: [ENTITY_ZHANG], ...options });

function cacheRows(): { key: string; value: string }[] {
  return db!
    .prepare("select key, value from app_meta where key like 'preview_%'")
    .all() as { key: string; value: string }[];
}

function cacheKeys(): string[] {
  return cacheRows().map((row) => row.key).sort();
}

function cacheValue(key: string): string | undefined {
  const row = db!.prepare("select value from app_meta where key = ?").get(key) as { value: string } | undefined;
  return row?.value;
}

/**
 * `app_meta` 全表快照（不止 `preview_%`）：档位隔离的断言要能证明「规则档这一次预览**没碰过**
 * 三个 `preview_llm_*` 键」，逐字比较键名与值，任何改写/新增/删除都会在这里露出来。
 */
function snapshotRows(): { key: string; value: string }[] {
  return db!.prepare("select key, value from app_meta order by key").all() as { key: string; value: string }[];
}

/**
 * 叶子级扫描（照 M7-3 C 组的手法）：把一份值反序列化成对象后，收齐**所有**字符串叶子，
 * 逐个与词面清单比。不靠「搜一段序列化文案」——键名、嵌套数组里的字符串都在扫描范围内。
 */
function collectStrings(value: unknown, into: Set<string>): Set<string> {
  if (typeof value === "string") {
    into.add(value);
    return into;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, into);
    return into;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      into.add(key);
      collectStrings(child, into);
    }
  }
  return into;
}

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

/** 假 fetch：固定回稿，记下调用次数（复现路径必须一次都不增）。 */
function fetchReturning(body: string): { fetchImpl: typeof fetch; state: { calls: number } } {
  const state = { calls: 0 };
  const impl = (_input: unknown, _init?: RequestInit): Promise<Response> => {
    state.calls += 1;
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

/** 三轴：脱敏轨 + 本地模型辅助档。占位门在本批不翻，路由层也不接，这里只喂服务层。 */
const LLM_AXES: ThreeAxes = { analysisProvider: "cloud", redactionMode: "local_llm", sendContentMode: "redacted" };
const RULES_AXES: ThreeAxes = { analysisProvider: "cloud", redactionMode: "manual", sendContentMode: "redacted" };

/* ── G1 签发口（M9-D-6）───────────────────────────────────────────── */

describe("G1 签发口：脱敏轨接受封闭策略集，raw 轨仍只认 raw-v1", () => {
  it("LLM 预览能签出授权，行的 policy_version 逐字是 rules+local_llm-v2", () => {
    setup();
    const llm = base({ llmSpans: [llmSpan(CAFE, "place")] });
    const grant = grants.issueGrant(llm, { confirmedAtUtc: "2026-10-29T01:00:00.000Z" });
    expect(grant.policy_version).toBe("rules+local_llm-v2");
    const row = db!
      .prepare("select * from cloud_send_grant where id = ?")
      .get(grant.id) as Record<string, string | null>;
    expect(row.policy_version).toBe(LOCAL_LLM_POLICY_VERSION);
    expect(row.send_content_mode).toBe("redacted");
    expect(row.payload_sha256).toBe(llm.payloadSha256);
    expect(row.redacted_sha256).toBe(llm.redactedSha256);
    expect(grants.grantForPreview(llm)?.id).toBe(grant.id);
    expect(() =>
      grants.requireApplicableGrant(revisionId, llm.payloadSha256, LOCAL_LLM_POLICY_VERSION, "redacted"),
    ).not.toThrow();
  });

  it("raw 预览签 raw-v1 照常成功（这一轨没被动过）", () => {
    setup();
    const raw = grants.prepareRawPreview(revisionId);
    const grant = grants.issueGrant(raw, { confirmedAtUtc: "2026-10-29T01:00:00.000Z" });
    expect(grant.policy_version).toBe(RAW_SEND_POLICY_VERSION);
  });

  it("拿 rules+local_llm-v2 去签 raw 轨 ⇒ 抛（两条轨道绝不能互相顶替）", () => {
    setup();
    const llm = base({ llmSpans: [llmSpan(CAFE, "place")] });
    expect(() => grants.issueGrant({ ...llm, sendContentMode: "raw" })).toThrow(PolicyVersionError);
    expect(countRows(db!, "cloud_send_grant")).toBe(0);
    // 反向同样断：raw 那份签不到脱敏轨上。
    const raw = grants.prepareRawPreview(revisionId);
    expect(() => grants.issueGrant({ ...raw, sendContentMode: "redacted" })).toThrow(PolicyVersionError);
    expect(countRows(db!, "cloud_send_grant")).toBe(0);
  });

  it("伪造 rules-v3 ⇒ 抛，且消息逐字不变（在册的只有那一支封闭集）", () => {
    setup();
    const rules = base();
    expect(REDACTED_TRACK_POLICY_VERSIONS).toEqual(["rules-v2", "rules+local_llm-v2"]);
    expect(() => grants.issueGrant({ ...rules, policyVersion: "rules-v3" })).toThrow(
      new PolicyVersionError("rules-v3").message,
    );
    expect(countRows(db!, "cloud_send_grant")).toBe(0);
    expect(isGrantablePolicyVersion("redacted", "rules-v3")).toBe(false);
    expect(isGrantablePolicyVersion("redacted", REDACTION_POLICY_VERSION)).toBe(true);
    expect(isGrantablePolicyVersion("redacted", LOCAL_LLM_POLICY_VERSION)).toBe(true);
    expect(isGrantablePolicyVersion("raw", REDACTION_POLICY_VERSION)).toBe(false);
    expect(isGrantablePolicyVersion("raw", LOCAL_LLM_POLICY_VERSION)).toBe(false);
    expect(isGrantablePolicyVersion("raw", RAW_SEND_POLICY_VERSION)).toBe(true);
  });

  it("复用语义不变：同载荷二次签发仍是一行、首次 confirmed_at 不变", () => {
    setup();
    const llm = base({ llmSpans: [llmSpan(CAFE, "place")] });
    const first = grants.issueGrant(llm, { confirmedAtUtc: "2026-10-29T01:00:00.000Z" });
    const again = grants.issueGrant(llm, { confirmedAtUtc: "2026-10-29T09:00:00.000Z" });
    expect(again.id).toBe(first.id);
    expect(again.confirmed_at_utc).toBe("2026-10-29T01:00:00.000Z");
    expect(countRows(db!, "cloud_send_grant")).toBe(1);
  });
});

/* ── G2 首预览落三键 ─────────────────────────────────────────────── */

describe("G2 op6 首预览落三键，缓存值里没有原文与词面", () => {
  it("resolveLocalLlmPreview ⇒ 恰好多出三键，spans 值是 [{kind,start,end}]", async () => {
    setup();
    expect(cacheKeys()).toEqual([]);
    const spy = fetchReturning(
      envelope(
        JSON.stringify({
          candidates: [
            { start: at(CAFE), end: at(CAFE) + CAFE.length, kind: "place", surface: CAFE },
            { start: at(WORK), end: at(WORK) + WORK.length, kind: "person", surface: WORK },
          ],
        }),
      ),
    );
    const preview = await resolveLocalLlmPreview(grants, adapter(), revisionId, {
      entities: [ENTITY_ZHANG],
      fetchImpl: spy.fetchImpl,
    });
    expect(preview.policyVersion).toBe(LOCAL_LLM_POLICY_VERSION);
    // 只落这一档的三键：规则档那两枚**不存在**（M9-D-9，本档从不书写别档的键）。
    expect(cacheKeys()).toEqual(LLM_THREE_KEYS(revisionId));
    expect(cacheKeys().some((key) => key.startsWith("preview_v2_nonce:") || key.startsWith("preview_v2_payload:"))).toBe(
      false,
    );

    const raw = cacheValue(SPANS_KEY(revisionId))!;
    expect(JSON.parse(raw)).toEqual([
      { kind: "place", start: at(CAFE), end: at(CAFE) + CAFE.length },
      { kind: "person", start: at(WORK), end: at(WORK) + WORK.length },
    ]);
    // 叶子级扫描：三个键的键名与值里，原文与每一个词面都不许出现。
    const leaves = new Set<string>();
    for (const row of cacheRows()) {
      collectStrings(row.key, leaves);
      collectStrings(row.value, leaves);
      try {
        collectStrings(JSON.parse(row.value), leaves);
      } catch {
        /* nonce / 载荷不是 JSON，按字符串叶子扫过即可 */
      }
    }
    const serialized = [...leaves].join("\n");
    for (const face of FACES) {
      expect(serialized.includes(face)).toBe(false);
    }
    // 键的取值面也只有 kind 名与数字：`surface` 这一列在落盘前就被剥掉了。
    expect(serialized).not.toContain("surface");
  });

  it("采信区间为空数组也算跑过：三键照样落齐（复现路径拿得到空集合）", async () => {
    setup();
    const spy = fetchReturning(envelope(JSON.stringify({ candidates: [] })));
    const preview = await resolveLocalLlmPreview(grants, adapter(), revisionId, {
      entities: [ENTITY_ZHANG],
      fetchImpl: spy.fetchImpl,
    });
    expect(preview.llmLayer).toMatchObject({ used: true, candidates: 0 });
    expect(cacheKeys()).toEqual(LLM_THREE_KEYS(revisionId));
    expect(JSON.parse(cacheValue(SPANS_KEY(revisionId))!)).toEqual([]);
  });
});

/* ── G3 复现逐字一致 ─────────────────────────────────────────────── */

describe("G3 复现预览逐字等于首预览，且命中原签名", () => {
  it("第二次不调 fetch：payloadText / 哈希 / nonce / redactedText 全同，requireApplicableGrant 命中", async () => {
    setup();
    const spy = fetchReturning(
      envelope(
        JSON.stringify({
          candidates: [{ start: at(CAFE), end: at(CAFE) + CAFE.length, kind: "place", surface: CAFE }],
        }),
      ),
    );
    const first = await resolveLocalLlmPreview(grants, adapter(), revisionId, {
      entities: [ENTITY_ZHANG],
      fetchImpl: spy.fetchImpl,
    });
    expect(spy.state.calls).toBe(1);
    const grant = grants.issueGrant(first);

    // 复现：服务层的同步调用，模型一次都不再被问（M9-4b 的路由层负责「首预览才调模型」）。
    const again = live({ tier: "local_llm" });
    expect(spy.state.calls).toBe(1);
    expect(again.payloadText).toBe(first.payloadText);
    expect(again.payloadSha256).toBe(first.payloadSha256);
    expect(again.map.nonce).toBe(first.map.nonce);
    expect(again.redactedText).toBe(first.redactedText);
    expect(again.policyVersion).toBe(first.policyVersion);
    expect(again.llmLayer).toMatchObject({ used: true, candidates: 1 });
    expect(grants.requireApplicableGrant(revisionId, again.payloadSha256, again.policyVersion, "redacted").id).toBe(
      grant.id,
    );
    expect(grants.grantForPreview(again)?.id).toBe(grant.id);
  });

  it("复现路径把新的替换文本落回本档载荷键，区间键与 nonce 键不动", () => {
    setup();
    const first = live({ llmSpans: [llmSpan(CAFE, "place")] });
    const spansBefore = cacheValue(SPANS_KEY(revisionId));
    const nonceBefore = cacheValue(LLM_NONCE_KEY(revisionId));
    const replaced = `${first.payloadText}（用户在预览里改过）`;

    const confirmed = grants.preparePreview(revisionId, {
      entities: [ENTITY_ZHANG],
      tier: "local_llm",
      payloadText: replaced,
    });
    expect(confirmed.payloadText).toBe(replaced);
    expect(confirmed.redactedText).toBe(first.redactedText);
    expect(cacheValue(SPANS_KEY(revisionId))).toBe(spansBefore);
    expect(cacheValue(LLM_NONCE_KEY(revisionId))).toBe(nonceBefore);
    expect(cacheValue(LLM_PAYLOAD_KEY(revisionId))).toBe(replaced);
    // 手工替换只落在本档载荷键：规则档那两枚依旧不存在（这一路径从不书写别档的键）。
    expect(cacheValue(RULES_NONCE_KEY(revisionId))).toBeUndefined();
    expect(cacheValue(RULES_PAYLOAD_KEY(revisionId))).toBeUndefined();
    const grant = grants.issueGrant(confirmed);
    expect(live({ tier: "local_llm" }).payloadText).toBe(replaced);
    expect(grants.grantForPreview(live({ tier: "local_llm" }))?.id).toBe(grant.id);
  });
});

/* ── G4 档位隔离 ─────────────────────────────────────────────────── */

describe("G4 档位隔离：两档各读各的键，缺键的 LLM 档抛错不降级", () => {
  it("先 LLM 预览再规则预览 ⇒ 规则档端出自己那份纯规则载荷，且三个 llm 键逐字不动", () => {
    setup();
    const llm = live({ llmSpans: [llmSpan(CAFE, "place")] });
    // 前置条件：这一串里躺的就是含 LLM 占位符的载荷。旧实现把它当规则档的缺省待发送文本端出去
    // （M9-D-9 修的就是这个）；现在两档的载荷键互不相干。
    expect(llm.payloadText).toContain("[place_1_");
    expect(llm.payloadText).not.toContain(CAFE);
    const llmKeysBefore = snapshotRows();

    const rules = grants.preparePreview(revisionId, { entities: [ENTITY_ZHANG], tier: "rules", nonce: NONCE });
    const pure = redact(RAW, [ENTITY_ZHANG], { nonce: NONCE });

    expect(rules.policyVersion).toBe(REDACTION_POLICY_VERSION);
    expect(rules.payloadText).toBe(rules.redactedText);
    expect(rules.redactedText).toBe(pure.redactedText);
    expect(rules.payloadText).toBe(pure.redactedText);
    expect(rules.redactedText).toContain(CAFE); // 咖啡馆没被遮：这一档不读 LLM 区间
    expect(rules.spans.filter((s) => s.source === "local_llm")).toHaveLength(0);
    // 规则档那次预览对本地模型档的三个键**零接触**：逐字相等，连 updated_at 之外的面都没变。
    expect(snapshotRows()).toEqual(llmKeysBefore);
    expect(cacheKeys()).toEqual(LLM_THREE_KEYS(revisionId));

    // 三个 llm 键全删，规则档的产出仍逐字相同——它从不读它们（旧断言的强度保留）。
    deleteMeta(db!, SPANS_KEY(revisionId));
    deleteMeta(db!, LLM_NONCE_KEY(revisionId));
    deleteMeta(db!, LLM_PAYLOAD_KEY(revisionId));
    const withLlmKeysGone = grants.preparePreview(revisionId, {
      entities: [ENTITY_ZHANG],
      tier: "rules",
      nonce: NONCE,
    });
    expect(withLlmKeysGone).toEqual(rules);
  });

  it("规则预览落的两个键，其值不含 llm 占位符；LLM 档另两键是独立的两枚", () => {
    setup();
    const llm = live({ llmSpans: [llmSpan(CAFE, "place")] });
    grants.preparePreview(revisionId, { entities: [ENTITY_ZHANG], tier: "rules" });

    expect(cacheKeys()).toEqual(ALL_FIVE_KEYS(revisionId));
    // 规则档键集自己的载荷就是纯规则那份，与 llm 载荷键不是同一串。
    expect(cacheValue(RULES_PAYLOAD_KEY(revisionId))).toContain(CAFE);
    expect(cacheValue(LLM_PAYLOAD_KEY(revisionId))).toBe(llm.payloadText);
    expect(cacheValue(LLM_PAYLOAD_KEY(revisionId))).not.toContain(CAFE);
    // 两档 nonce 各自一枚：互不覆盖，因此谁重写都不会让另一档已缓存的载荷内部占位符过期。
    expect(cacheValue(RULES_NONCE_KEY(revisionId))).toBeDefined();
    expect(cacheValue(LLM_NONCE_KEY(revisionId))).toBeDefined();
  });

  it("三个 llm 键全缺后走 local_llm 档 ⇒ 抛 LocalLlmTierCacheMissingError，不静默退回规则档", () => {
    setup();
    const first = live({ llmSpans: [llmSpan(CAFE, "place")] });
    expect(live({ tier: "local_llm" }).payloadText).toBe(first.payloadText);

    deleteMeta(db!, SPANS_KEY(revisionId));
    let caught: unknown;
    try {
      live({ tier: "local_llm" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(LocalLlmTierCacheMissingError);
    expect((caught as LocalLlmTierCacheMissingError).reason).toBe("absent");
    expect((caught as LocalLlmTierCacheMissingError).message).toContain(revisionId);
    // 抛出去的那份不是「偷偷按规则档算好的预览」：本档载荷仍停在 op6 那一串，也没有新授权行。
    expect(cacheValue(LLM_PAYLOAD_KEY(revisionId))).toBe(first.payloadText);
    expect(countRows(db!, "cloud_send_grant")).toBe(0);
    // 规则档照常工作——降级只发生在「调用方自己指定 tier」这一层，服务层不替用户改主意。
    expect(grants.preparePreview(revisionId, { entities: [ENTITY_ZHANG], tier: "rules", nonce: NONCE }).policyVersion).toBe(
      REDACTION_POLICY_VERSION,
    );
  });

  it("错误消息只带 revisionId 与原因类别：原文与词面都不在里面", () => {
    setup();
    live({ llmSpans: [llmSpan(CAFE, "place")] });
    deleteMeta(db!, SPANS_KEY(revisionId));
    let message = "";
    try {
      live({ tier: "local_llm" });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain(revisionId);
    for (const face of FACES) expect(message.includes(face)).toBe(false);
    expect(message).not.toContain("preview_llm_spans");
  });
});

/* ── G5 损坏缓存 ─────────────────────────────────────────────────── */

describe("G5 损坏的第三键不许被当成有效凭据", () => {
  const cases: readonly { readonly name: string; readonly value: string }[] = [
    { name: "坏 JSON", value: "{not json" },
    { name: "不是数组", value: JSON.stringify({ kind: "place", start: 4, end: 9 }) },
    { name: "元素不是对象", value: JSON.stringify(["place", 4, 9]) },
    { name: "伪造 kind", value: JSON.stringify([{ kind: "person_name", start: at(CAFE), end: at(CAFE) + CAFE.length }]) },
    { name: "越界（end 超出原文）", value: JSON.stringify([{ kind: "place", start: at(CAFE), end: RAW.length + 5 }]) },
    { name: "负偏移", value: JSON.stringify([{ kind: "place", start: -1, end: 3 }]) },
    { name: "非整数偏移", value: JSON.stringify([{ kind: "place", start: 4.5, end: 9 }]) },
    { name: "区间倒置", value: JSON.stringify([{ kind: "place", start: 9, end: 4 }]) },
  ];

  for (const testCase of cases) {
    it(`${testCase.name} ⇒ 抛 LocalLlmTierCacheMissingError(malformed)，不产出预览`, () => {
      setup();
      live({ llmSpans: [llmSpan(CAFE, "place")] }); // 先落一份合法的三键
      setMeta(db!, SPANS_KEY(revisionId), testCase.value);
      const payloadBefore = cacheValue(LLM_PAYLOAD_KEY(revisionId));
      expect(() => live({ tier: "local_llm" })).toThrow(LocalLlmTierCacheMissingError);
      expect(() => live({ tier: "local_llm" })).toThrow(/结构不成立/);
      // 抛错时不写回任何东西：缓存停在原处，调用方拿不到预览，也就拿不到可签的东西。
      expect(cacheValue(LLM_PAYLOAD_KEY(revisionId))).toBe(payloadBefore);
      expect(countRows(db!, "cloud_send_grant")).toBe(0);
    });
  }
});

/* ── G6 硬删除不留痕 ─────────────────────────────────────────────── */

describe("G6 purgePreviewCache 连五个键一起删（K-09）", () => {
  it("两档的键全无；entity / capture_record / record_revision 计数不动", async () => {
    setup();
    const spy = fetchReturning(
      envelope(
        JSON.stringify({
          candidates: [
            { start: at(CAFE), end: at(CAFE) + CAFE.length, kind: "place", surface: CAFE },
            { start: at(WORK), end: at(WORK) + WORK.length, kind: "person", surface: WORK },
          ],
        }),
      ),
    );
    await resolveLocalLlmPreview(grants, adapter(), revisionId, {
      entities: [ENTITY_ZHANG],
      fetchImpl: spy.fetchImpl,
    });
    // 规则档也预览一次，把五键落齐——purge 删的是**两档**的键，不是本批那三键。
    grants.preparePreview(revisionId, { entities: [ENTITY_ZHANG], tier: "rules" });
    expect(cacheKeys()).toEqual(ALL_FIVE_KEYS(revisionId));

    const before = {
      entity: countRows(db!, "entity"),
      record: countRows(db!, "capture_record"),
      revision: countRows(db!, "record_revision"),
    };
    purgePreviewCache(db!, [revisionId]);
    expect(cacheKeys()).toEqual([]);
    expect(cacheRows()).toHaveLength(0);
    expect({
      entity: countRows(db!, "entity"),
      record: countRows(db!, "capture_record"),
      revision: countRows(db!, "record_revision"),
    }).toEqual(before);

    // 清干净之后，规则档仍能现算（它从不依赖第三键），LLM 档则按 G4 抛错。
    expect(grants.preparePreview(revisionId, { entities: [ENTITY_ZHANG], tier: "rules" }).policyVersion).toBe(
      REDACTION_POLICY_VERSION,
    );
    expect(() => live({ tier: "local_llm" })).toThrow(LocalLlmTierCacheMissingError);
  });

  it("键前缀与写入处逐字同源：purge 用的就是那五个前缀", () => {
    setup();
    live({ llmSpans: [llmSpan(CAFE, "place")] });
    grants.preparePreview(revisionId, { entities: [ENTITY_ZHANG], tier: "rules" });
    const written = cacheKeys();
    expect(written).toEqual(ALL_FIVE_KEYS(revisionId));
    purgePreviewCache(db!, [revisionId]);
    // 删完之后剩下的 preview_ 键数应为 0；若两处前缀漂移，这里就会留下孤儿键。
    expect(written.every((key) => key.startsWith("preview_"))).toBe(true);
    expect(cacheKeys()).toEqual([]);
  });
});

/* ── G7 kind 封闭集过滤（M9-D-7）─────────────────────────────────── */

describe("G7 redact() 对 extraCandidates 的 kind 也按封闭集丢弃", () => {
  it("伪造 kind 不产生 span、不抛错；同批合法 kind 照常生效", () => {
    const result = redact(RAW, [ENTITY_ZHANG], {
      nonce: NONCE,
      extraCandidates: [
        { start: at(CAFE), end: at(CAFE) + CAFE.length, kind: "person_name" },
        { start: at(WORK), end: at(WORK) + WORK.length, kind: "姓名" },
        { start: at(CAFE), end: at(CAFE) + CAFE.length, kind: "place" },
      ],
      policyVersion: LOCAL_LLM_POLICY_VERSION,
    });
    const llmSpans = result.map.spans.filter((s) => s.source === "local_llm");
    expect(llmSpans).toHaveLength(1);
    expect(llmSpans[0]!.kind).toBe("place");
    expect(result.redactedText).toContain(WORK); // 伪造 kind 的那条没遮任何东西
    expect(result.redactedText).not.toContain(CAFE);
    expect(() => parseRedactionMap(redactionMapJsonValue(result.map))).not.toThrow();
  });

  it("全是伪造 kind ⇒ 一个 local_llm span 都没有，映射仍读得回来", () => {
    const result = redact(RAW, [ENTITY_ZHANG], {
      nonce: NONCE,
      extraCandidates: [
        { start: at(CAFE), end: at(CAFE) + CAFE.length, kind: "person_name" },
        { start: at(ZHANG), end: at(ZHANG) + ZHANG.length, kind: "" },
      ],
      policyVersion: LOCAL_LLM_POLICY_VERSION,
    });
    expect(result.map.spans.filter((s) => s.source === "local_llm")).toHaveLength(0);
    expect(() => parseRedactionMap(redactionMapJsonValue(result.map))).not.toThrow();
    // 规则与实体记忆那两层不受影响：kind 过滤只作用在外部候选上。
    expect(result.map.spans.map((s) => s.source).sort()).toEqual(["entity_memory", "rule"]);
  });
});

/* ── G8 端到端（离线）───────────────────────────────────────────── */

describe("G8 假服务 → 首预览 → 签发 → previewForEgress 复现 → 闸门放行", () => {
  it("复现出来的载荷与签发时逐字相同，requireApplicableGrant 命中同一行", async () => {
    setup();
    const spy = fetchReturning(
      envelope(
        JSON.stringify({
          candidates: [
            { start: at(CAFE), end: at(CAFE) + CAFE.length, kind: "place", surface: CAFE },
            { start: at(WORK), end: at(WORK) + WORK.length, kind: "person", surface: WORK },
          ],
        }),
      ),
    );
    const op6 = await resolveLocalLlmPreview(grants, adapter(), revisionId, {
      entities: [ENTITY_ZHANG],
      fetchImpl: spy.fetchImpl,
    });
    expect(op6.policyVersion).toBe(LOCAL_LLM_POLICY_VERSION);
    const grant = grants.issueGrant(op6, { confirmedAtUtc: "2026-10-29T01:00:00.000Z" });
    expect(grant.policy_version).toBe(LOCAL_LLM_POLICY_VERSION);
    expect(spy.state.calls).toBe(1);

    // op2 真正发送时：三轴里的 redaction_mode 决定档位，复现走的是缓存而不是模型。
    const op2 = previewForEgress(grants, revisionId, LLM_AXES);
    expect(spy.state.calls).toBe(1);
    expect(op2.payloadText).toBe(op6.payloadText);
    expect(op2.payloadSha256).toBe(op6.payloadSha256);
    expect(op2.policyVersion).toBe(op6.policyVersion);
    expect(grants.requireApplicableGrant(revisionId, op2.payloadSha256, op2.policyVersion, "redacted").id).toBe(
      grant.id,
    );

    // 同一 revision 的规则档复现签的是另一行：两档互不顶替（K-17）。
    const rulesPreview = previewForEgress(grants, revisionId, RULES_AXES, base().payloadText);
    expect(rulesPreview.policyVersion).toBe(REDACTION_POLICY_VERSION);
    // 规则档读的是自己的两键（M9-D-9）：`preview_payload` 存的必须是它自己那份纯规则载荷，
    // 含 LLM 占位符的那一份只躺在 `preview_llm_payload` 里，这一档看不见也读不到。
    expect(cacheKeys()).toEqual(ALL_FIVE_KEYS(revisionId));
    expect(cacheValue(RULES_PAYLOAD_KEY(revisionId))).toContain(CAFE);
    expect(cacheValue(LLM_PAYLOAD_KEY(revisionId))).toBe(op6.payloadText);
    expect(cacheValue(LLM_PAYLOAD_KEY(revisionId))).not.toContain(CAFE);
    expect(cacheValue(RULES_NONCE_KEY(revisionId))).toBeDefined();
    expect(cacheValue(RULES_NONCE_KEY(revisionId))).not.toBe(cacheValue(LLM_NONCE_KEY(revisionId)));
    expect(rulesPreview.payloadText).toContain(CAFE);
    expect(grants.grantForPreview(rulesPreview)).toBeNull();
    expect(() =>
      grants.requireApplicableGrant(revisionId, rulesPreview.payloadSha256, LOCAL_LLM_POLICY_VERSION, "redacted"),
    ).toThrow(CloudSendAuthorizationRequiredError);
  });

  it("raw 轨分支逐字不变：替换文本仍被拒（本次没动它）", () => {
    setup();
    const raw = previewForEgress(grants, revisionId, {
      analysisProvider: "cloud",
      redactionMode: "manual",
      sendContentMode: "raw",
    });
    expect(raw.policyVersion).toBe(RAW_SEND_POLICY_VERSION);
    expect(() => previewForEgress(grants, revisionId, { ...LLM_AXES, sendContentMode: "raw" }, "改过的")).toThrow(
      /只能是该版本自己的原文/,
    );
  });
});

/* ── G9 失败即阻断（PD-2，2026-11-04）──────────────────────────── */

describe("G9 本地服务没跑成 ⇒ 阻断，不回落规则档", () => {
  it("超时 ⇒ 抛 LocalLlmConsultFailedError、不写第三键；显式 rules 档仍可单独预览", async () => {
    setup();
    await expect(
      resolveLocalLlmPreview(grants, adapter({ requestTimeoutMs: 30 }), revisionId, {
        entities: [ENTITY_ZHANG],
        fetchImpl: fetchHanging(),
        tier: "local_llm",
      }),
    ).rejects.toBeInstanceOf(LocalLlmConsultFailedError);
    // 失败标记只记类别，不装文本；采信区间键一枚不写。
    expect(grants.llmConsultFailedKind(revisionId)).toBe("timeout");
    expect(cacheValue(SPANS_KEY(revisionId))).toBeUndefined();
    expect(cacheKeys().filter((key) => key.startsWith("preview_llm_v2_spans:"))).toHaveLength(0);

    // 「规则档」是另一档：调用方显式选 tier:"rules" 才拿得到，不是从 local_llm 静默降下来的。
    const rules = grants.preparePreview(revisionId, { entities: [ENTITY_ZHANG], tier: "rules" });
    expect(rules.policyVersion).toBe(REDACTION_POLICY_VERSION);
    // 显式按 local_llm 档来复现这一份：没有区间缓存 ⇒ 抛，而不是把规则档那份端出去。
    expect(() => live({ tier: "local_llm" })).toThrow(LocalLlmTierCacheMissingError);
  });

  it("adapter=null（这一档根本没配置）⇒ 同样阻断", async () => {
    setup();
    await expect(
      resolveLocalLlmPreview(grants, null, revisionId, {
        entities: [ENTITY_ZHANG],
        tier: "local_llm",
      }),
    ).rejects.toBeInstanceOf(LocalLlmConsultFailedError);
    expect(cacheValue(SPANS_KEY(revisionId))).toBeUndefined();
  });
});

/* ── G10 双向隔离（M9-D-9）────────────────────────────────────────── */

describe("G10 两档交替预览：各档逐字复现自己那一份，两档之间永不串", () => {
  it("规则预览 → LLM 预览 → 规则预览 → LLM 复现 ⇒ 同档两份逐字相等，键集恰为五枚", () => {
    setup();
    const rules1 = live({ tier: "rules" });
    const llm1 = live({ llmSpans: [llmSpan(CAFE, "place")] });
    const rules2 = live({ tier: "rules" });
    const llm2 = live({ tier: "local_llm" });

    // 各自与同档上一次逐字相等：nonce、载荷本体、载荷哈希三样都是复现的凭据。
    expect(rules2.payloadText).toBe(rules1.payloadText);
    expect(rules2.payloadSha256).toBe(rules1.payloadSha256);
    expect(rules2.map.nonce).toBe(rules1.map.nonce);
    expect(llm2.payloadText).toBe(llm1.payloadText);
    expect(llm2.payloadSha256).toBe(llm1.payloadSha256);
    expect(llm2.map.nonce).toBe(llm1.map.nonce);

    // 两档之间不同：串档的标志就是这三样里任何一样相等。
    expect(rules1.payloadText).not.toBe(llm1.payloadText);
    expect(rules1.payloadSha256).not.toBe(llm1.payloadSha256);
    expect(rules1.map.nonce).not.toBe(llm1.map.nonce);
    // 且各自的 redacted/payload 配对一致——两腿描述同一份文本，不再一份规则一份 LLM。
    expect(rules1.payloadText).toBe(rules1.redactedText);
    expect(llm1.payloadText).toBe(llm1.redactedText);

    // 四个键读写完毕 + 采信区间 = 恰为五枚，无第六个。
    expect(cacheKeys()).toEqual(ALL_FIVE_KEYS(revisionId));
    expect(cacheRows()).toHaveLength(5);
  });

  it("规则档手工替换只落自己的载荷键，LLM 档那份载荷与区间不受影响", () => {
    setup();
    const llm1 = live({ llmSpans: [llmSpan(CAFE, "place")] });
    const spansBefore = cacheValue(SPANS_KEY(revisionId));
    const llmPayloadBefore = cacheValue(LLM_PAYLOAD_KEY(revisionId));
    const llmNonceBefore = cacheValue(LLM_NONCE_KEY(revisionId));

    const replaced = `${live({ tier: "rules" }).payloadText}（规则档的手工替换）`;
    const rulesReplaced = grants.preparePreview(revisionId, {
      entities: [ENTITY_ZHANG],
      tier: "rules",
      payloadText: replaced,
    });
    expect(rulesReplaced.payloadText).toBe(replaced);
    expect(cacheValue(RULES_PAYLOAD_KEY(revisionId))).toBe(replaced);
    // 反向串档同样不存在：规则档写载荷键，LLM 档的三键一个字节都没变。
    expect(cacheValue(LLM_PAYLOAD_KEY(revisionId))).toBe(llmPayloadBefore);
    expect(cacheValue(LLM_NONCE_KEY(revisionId))).toBe(llmNonceBefore);
    expect(cacheValue(SPANS_KEY(revisionId))).toBe(spansBefore);
    // LLM 档仍复现自己那份含占位符的载荷，而不是刚被替换的规则文本。
    expect(live({ tier: "local_llm" }).payloadText).toBe(llm1.payloadText);
    expect(cacheKeys()).toEqual(ALL_FIVE_KEYS(revisionId));
  });
});

/* ── G11 五键清理（M9-D-9）────────────────────────────────────────── */

describe("G11 purgePreviewCache 删的是五键，删完 LLM 档按缺键抛", () => {
  it("两档都预览过 ⇒ 五键；purge 后全无；随后 tier:local_llm 抛 absent", () => {
    setup();
    live({ tier: "rules" });
    live({ llmSpans: [llmSpan(CAFE, "place")] });
    expect(cacheKeys()).toEqual(ALL_FIVE_KEYS(revisionId));
    expect(cacheRows()).toHaveLength(5);

    purgePreviewCache(db!, [revisionId]);
    expect(cacheRows()).toHaveLength(0);
    expect(cacheKeys()).toEqual([]);

    let caught: unknown;
    try {
      live({ tier: "local_llm" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(LocalLlmTierCacheMissingError);
    expect((caught as LocalLlmTierCacheMissingError).reason).toBe("absent");
    // 规则档不依赖任何键，清完仍能现算（并且这次把两个规则键重新落回去）。
    const rules = live({ tier: "rules" });
    expect(rules.policyVersion).toBe(REDACTION_POLICY_VERSION);
    expect(cacheKeys()).toEqual([RULES_NONCE_KEY(revisionId), RULES_PAYLOAD_KEY(revisionId)]);
  });
});

/* ── G12 nonce 不串档（M9-D-9）────────────────────────────────────── */

describe("G12 任一档重写 nonce 都不动另一档那枚", () => {
  it("先规则预览再 LLM 首预览 ⇒ preview_nonce 不变，preview_llm_nonce 是另一枚", () => {
    setup();
    const rules = live({ tier: "rules" });
    const rulesNonce = cacheValue(RULES_NONCE_KEY(revisionId));
    expect(rulesNonce).toBe(rules.map.nonce);

    const llm = live({ llmSpans: [llmSpan(CAFE, "place")] });
    expect(cacheValue(RULES_NONCE_KEY(revisionId))).toBe(rulesNonce);
    expect(cacheValue(LLM_NONCE_KEY(revisionId))).toBe(llm.map.nonce);
    expect(cacheValue(LLM_NONCE_KEY(revisionId))).not.toBe(rulesNonce);
    // 规则档已缓存的载荷因此不会因为 LLM 档重写 nonce 而内部占位符过期。
    expect(cacheValue(RULES_PAYLOAD_KEY(revisionId))).toBe(rules.payloadText);
    expect(live({ tier: "rules" }).payloadText).toBe(rules.payloadText);
  });

  it("反之亦然：先 LLM 预览再规则预览 ⇒ preview_llm_nonce 不变", () => {
    setup();
    const llm = live({ llmSpans: [llmSpan(CAFE, "place")] });
    const llmNonce = cacheValue(LLM_NONCE_KEY(revisionId));
    expect(llmNonce).toBe(llm.map.nonce);

    const rules = live({ tier: "rules" });
    expect(cacheValue(LLM_NONCE_KEY(revisionId))).toBe(llmNonce);
    expect(cacheValue(RULES_NONCE_KEY(revisionId))).toBe(rules.map.nonce);
    expect(cacheValue(RULES_NONCE_KEY(revisionId))).not.toBe(llmNonce);
    expect(cacheValue(LLM_PAYLOAD_KEY(revisionId))).toBe(llm.payloadText);
    expect(live({ tier: "local_llm" }).payloadText).toBe(llm.payloadText);
  });
});
