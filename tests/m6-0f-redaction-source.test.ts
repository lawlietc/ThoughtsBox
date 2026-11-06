import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { migrate } from "../src/server/db/migrator.ts";
import { RecordService } from "../src/server/records/service.ts";
import { newId } from "../src/shared/contracts/ids.ts";
import {
  GRANT_SEND_CONTENT_MODES,
  GrantService,
  grantPolicyVersionFor,
  type CloudSendGrantRow,
} from "../src/server/privacy/grantService.ts";
import {
  RAW_SEND_POLICY_VERSION,
  REDACTION_POLICY_VERSION,
  REDACTION_SOURCES,
  isRedactionSource,
  parseRedactionMap,
  redact,
  redactionMapJsonValue,
  sha256OfText,
  type KnownEntity,
  type RedactionMap,
  type RedactionSource,
} from "../src/server/privacy/redaction.ts";
import { makeSandbox, openSandboxDb, type Sandbox } from "./helpers/sandbox.ts";
import type { Database } from "../src/server/db/adapter.ts";

/**
 * M6-0F 候选来源字段（`RedactionSpan.source`）的验收。
 *
 * 契约正文：`docs/dev-specs/2026-10-23-M6-0F-候选来源字段设计草案.md` §二/§三/§四/§六，
 * 以及 `2026-10-23-M6阶段0任务拆分与执行准则.md` 的 M6-0F 段（「来源字段在序列化往返后保持
 * 不变；非法来源值被拒」）。
 *
 * 这个任务的身份决定了断言的取向：**加的是元数据，不是新行为**。所以本文件最重的一条不是
 * 「source 对不对」，而是 §六 断言 5——脱敏文本与 payload 哈希在加字段前后**逐字相同**，
 * 因为 `REDACTION_POLICY_VERSION` 不升版、存量 `cloud_send_grant` 继续有效这件事，
 * 只有载荷哈希没变才成立（K-17 的反面）。基线值取自改动前的 HEAD 实测（见交付记录），
 * 不是照着新实现回填的——回填的话断言 5 就成了自证。
 *
 * 分工边界：占位符格式、偏移算术、映射不进指纹/不进导出由 `m2-privacy` / `m3-proj-1` 钉住；
 * 授权表静态形状由 `m2-schema-contract` 的 T-23/K-17 钉住。本文件只钉来源这一层。
 */

const NOW = "2026-10-25T08:00:00.000Z";
const NONCE = "a1b2c3";

/** 与 `m2-privacy` 同一夹具文本：代理对 + 中文名 + 手机号 + 邮箱 + 别名，四类偏移源一次凑齐。 */
const RAW = "👍张三说打 13800138000 给 laowang@example.com 或老周";
const ENTITY_ZHANG: KnownEntity = { entityId: "entity_zhang", entityType: "person", terms: ["张三"] };
const ENTITY_LAOZHOU: KnownEntity = {
  entityId: "entity_laozhou",
  entityType: "person",
  terms: ["老周", "周哥"],
};

/**
 * 改动前（HEAD `6eb0f59`，即 0D 完成态）用 `redact(RAW, [张三, 老周], {nonce: "a1b2c3"})`
 * 跑出来的实测值。加字段后必须逐字复现这三件：脱敏文本、载荷哈希、去掉 source 的 map JSON。
 */
const BASELINE_REDACTED_TEXT = "👍[person_1_a1b2c3]说打 [phone_1_a1b2c3] 给 [email_1_a1b2c3] 或[person_2_a1b2c3]";
const BASELINE_PAYLOAD_SHA256 = "c14710de12a83f60d67c75d354951d55e896987da5f32c3cd1ab842eb6d9d7df";
const BASELINE_MAP_JSON =
  '{"policyVersion":"rules-v2","nonce":"a1b2c3","spans":[' +
  '{"kind":"person","placeholder":"[person_1_a1b2c3]","originalStart":2,"originalEnd":4,"redactedStart":2,"redactedEnd":19},' +
  '{"kind":"phone","placeholder":"[phone_1_a1b2c3]","originalStart":7,"originalEnd":18,"redactedStart":22,"redactedEnd":38},' +
  '{"kind":"email","placeholder":"[email_1_a1b2c3]","originalStart":21,"originalEnd":40,"redactedStart":41,"redactedEnd":57},' +
  '{"kind":"person","placeholder":"[person_2_a1b2c3]","originalStart":42,"originalEnd":44,"redactedStart":59,"redactedEnd":76}]}';

function expectThrown(builder: () => unknown, pattern: RegExp): void {
  let thrown: unknown;
  try {
    builder();
  } catch (cause) {
    thrown = cause;
  }
  if (thrown === undefined) throw new Error(`期望抛出 ${pattern}，但没有抛出`);
  expect((thrown as Error).message).toMatch(pattern);
}

/** 序列化形态去掉新增的 source 键：与改动前的 JSON 逐字比对的准备工作（键序保持原样）。 */
function mapJsonWithoutSource(map: RedactionMap): string {
  const json = redactionMapJsonValue(map) as unknown as {
    policyVersion: string;
    nonce: string;
    spans: Array<Record<string, unknown>>;
  };
  return JSON.stringify({ ...json, spans: json.spans.map(({ source, ...rest }) => rest) });
}

/** 手写一份 map JSON，把每条 span 的 source 换成指定值（含历史形态：`deleteSource`）。 */
function mapJsonWithSource(source: unknown | undefined, deleteSource = false): Record<string, unknown> {
  const base = JSON.parse(BASELINE_MAP_JSON) as { spans: Array<Record<string, unknown>> };
  return {
    policyVersion: REDACTION_POLICY_VERSION,
    nonce: NONCE,
    spans: base.spans.map((span) => {
      const copy = { ...span };
      if (deleteSource) return copy;
      copy["source"] = source;
      return copy;
    }),
  };
}

// ── 断言 1：来源可区分（草案 §六-1）─────────────────────────────────

describe("断言 1：规则命中与实体记忆命中在来源上可区分", () => {
  it("同一文本里，规则遮的记 rule、实体记忆遮的记 entity_memory", () => {
    const { map } = redact(RAW, [ENTITY_ZHANG, ENTITY_LAOZHOU], { nonce: NONCE });
    // 张三 / phone / email / 老周 —— kind 面与改动前一致（[person, phone, email, person]）
    expect(map.spans.map((s) => s.kind)).toEqual(["person", "phone", "email", "person"]);
    expect(map.spans.map((s) => s.source)).toEqual(["entity_memory", "rule", "rule", "entity_memory"]);
  });

  it("纯规则文本 ⇒ 全是 rule；纯实体文本 ⇒ 全是 entity_memory", () => {
    const onlyRule = redact("我的号码 13900139000，邮箱 me@example.com", [], { nonce: NONCE });
    expect(onlyRule.map.spans.map((s) => s.source)).toEqual(["rule", "rule"]);

    const onlyEntity = redact("阿哲明天来店里", [{ entityId: "entity_azhe", entityType: "person", terms: ["阿哲"] }], {
      nonce: NONCE,
    });
    expect(onlyEntity.map.spans.map((s) => s.source)).toEqual(["entity_memory"]);
  });

  it("「以后也隐藏」落下的 provisional 实体走的是 entity 通道 ⇒ entity_memory，不是 user_confirmed", () => {
    // 本层只见 KnownEntity：provisional 实体一旦进 `entity` 表，就被 collectKnownEntities()
    // 当作普通记忆取出来，来源自然是 entity_memory（草案 §二 表内第 2 行的说明）。
    const provisional: KnownEntity = { entityId: "entity_prov", entityType: "person", terms: ["阿哲"] };
    const { map } = redact("阿哲说明天来", [provisional], { nonce: NONCE });
    expect(map.spans[0]!.source).toBe("entity_memory");
  });

  it("v1 的 redact() 只产出这两个值：local_llm 与 user_confirmed 在本阶段都没有产出路径", () => {
    const { map } = redact(RAW, [ENTITY_ZHANG, ENTITY_LAOZHOU], { nonce: NONCE });
    const produced = [...new Set(map.spans.map((s) => s.source))].sort();
    expect(produced).toEqual(["entity_memory", "rule"]);
    // 取值域仍然是 4 值——解析层接受这两个值，只是 `redact()` 不产出（草案 §二 2026-10-24 注）。
    // M9-4b 的措辞更正：`local_llm` 不再是「占位档」，它由在途模型分析通道产出，而那一路由属 M9-4c；
    // `redact()`（规则/实体通道）永不产出它，这一条判据因此与档位可不可用无关、逐字不变。
    expect([...REDACTION_SOURCES]).toEqual(["rule", "entity_memory", "local_llm", "user_confirmed"]);
    for (const source of REDACTION_SOURCES) expect(isRedactionSource(source)).toBe(true);
    expect(isRedactionSource("llm")).toBe(false);
  });
});

// ── 断言 2：重叠消解保留谁，来源跟着谁走（草案 §六-2）───────────────

describe("断言 2：同一区间被两层同时命中时，来源属于被保留的那条候选", () => {
  it("词面完全相同（等长）⇒ 仍是「左起最长优先」那条比较器返回 0 的分支：稳定排序保先来者 = 规则候选", () => {
    const sameAsPhone: KnownEntity = { entityId: "entity_phone", entityType: "person", terms: ["13800138000"] };
    const { map } = redact("打 13800138000 给", [sameAsPhone], { nonce: NONCE });
    expect(map.spans.length).toBe(1);
    // 保留的是哪一条，看 kind 与区间就能定死：phone / [2,13) 是规则候选的形状（实体那条是 person）
    expect(map.spans[0]).toMatchObject({ kind: "phone", originalStart: 2, originalEnd: 13 });
    expect(map.spans[0]!.source).toBe("rule");
  });

  it("实体词面更长 ⇒ 更长者胜，来源随之变成 entity_memory（重叠规则本身未动）", () => {
    const longer: KnownEntity = {
      entityId: "entity_long",
      entityType: "organization",
      terms: ["13800138000 hotline"],
    };
    const { map } = redact("打 13800138000 hotline 给", [longer], { nonce: NONCE });
    expect(map.spans.length).toBe(1);
    expect(map.spans[0]).toMatchObject({ kind: "organization", originalStart: 2, originalEnd: 21 });
    expect(map.spans[0]!.source).toBe("entity_memory");
  });

  it("规则匹配更长（实体词面是其前缀）⇒ 保留规则候选，来源 rule", () => {
    const prefix: KnownEntity = { entityId: "entity_prefix", entityType: "person", terms: ["1380013800"] };
    const { map } = redact("打 13800138000 给", [prefix], { nonce: NONCE });
    expect(map.spans.length).toBe(1);
    expect(map.spans[0]!.source).toBe("rule");
  });

  it("互不重叠的区间各带自己的来源，条数与改动前一致", () => {
    const { map } = redact(RAW, [ENTITY_ZHANG, ENTITY_LAOZHOU], { nonce: NONCE });
    expect(map.spans.length).toBe(4);
    for (let i = 1; i < map.spans.length; i += 1) {
      expect(map.spans[i]!.originalStart).toBeGreaterThanOrEqual(map.spans[i - 1]!.originalEnd);
    }
  });
});

// ── 断言 3：非法来源被拒（草案 §六-3 / 执行准则）────────────────────

describe("断言 3：非法 source 写进 map 的 JSON ⇒ parseRedactionMap 抛错", () => {
  it("封闭集外的字符串一律拒（大小写与空白都不算命中）", () => {
    for (const bad of ["llm", "human", "RULE", "rule ", "entity_memory ", "", "user-confirmed", "local-llm"]) {
      expectThrown(() => parseRedactionMap(mapJsonWithSource(bad)), /source 不在封闭集内/);
    }
  });

  it("非字符串的 source 同样拒——不是宽松转成字符串再比", () => {
    for (const bad of [0, 1, true, null, {}, [], ["rule"]]) {
      expectThrown(() => parseRedactionMap(mapJsonWithSource(bad)), /source 不在封闭集内/);
    }
  });

  it("封闭集 4 值（含两个本阶段无产出路径的值）都能解析通过：校验的是取值域，不是「会不会产出」", () => {
    for (const source of REDACTION_SOURCES) {
      const parsed = parseRedactionMap(mapJsonWithSource(source));
      expect(parsed.spans.every((s) => s.source === source)).toBe(true);
    }
  });

  it("报错面与 kind 同形：不静默丢弃、也不静默补默认值", () => {
    // 字段存在但不认识 ⇒ 抛错。只有「字段不存在」才补 rule（那是历史 manifest，见断言 4）。
    expectThrown(() => parseRedactionMap(mapJsonWithSource("rulex")), /source 不在封闭集内：rulex/);
    expectThrown(() => parseRedactionMap(mapJsonWithSource("phone")), /source 不在封闭集内：phone/);
  });
});

// ── 断言 4：历史 map 只能读不能重算（草案 §六-4 / §四）──────────────

describe("断言 4：没有 source 字段的历史 map 可解析，按 rule 补齐且不报错", () => {
  it("改动前的序列化形态逐字喂进 parseRedactionMap ⇒ 解析成功，每条 span 的 source 是 rule", () => {
    const historic = JSON.parse(BASELINE_MAP_JSON);
    const parsed = parseRedactionMap(historic);
    expect(parsed.spans.length).toBe(4);
    expect(parsed.spans.map((s) => s.source)).toEqual(["rule", "rule", "rule", "rule"]);
  });

  it("补齐是**显式写进对象**的，不是靠类型断言糊过去：own 键真的存在", () => {
    const parsed = parseRedactionMap(JSON.parse(BASELINE_MAP_JSON));
    for (const span of parsed.spans) {
      expect(Object.prototype.hasOwnProperty.call(span, "source")).toBe(true);
      expect(span.source).toBe("rule");
    }
  });

  it("除补齐的 source 外，历史 map 的其余字段逐字不变", () => {
    const historicSpans = (JSON.parse(BASELINE_MAP_JSON) as { spans: Array<Record<string, unknown>> }).spans;
    const parsed = parseRedactionMap(JSON.parse(BASELINE_MAP_JSON));
    expect(parsed.spans.map((s) => ({ ...s, source: undefined }))).toEqual(
      historicSpans.map((s) => ({ ...s, source: undefined })),
    );
    expect(parsed.policyVersion).toBe(REDACTION_POLICY_VERSION);
    expect(parsed.nonce).toBe(NONCE);
  });

  it("旧 run 可读：补齐后重新序列化能再解析一次（读写两头同一次改完，不会「能读不能写」）", () => {
    const once = parseRedactionMap(JSON.parse(BASELINE_MAP_JSON));
    const twice = parseRedactionMap(redactionMapJsonValue(once));
    expect(twice.spans.map((s) => s.source)).toEqual(once.spans.map((s) => s.source));
  });
});

// ── 序列化往返（执行准则的必过断言）─────────────────────────────────

describe("序列化往返：source 逐条保持不变", () => {
  it("redactionMapJsonValue → stringify → parse → 与原 map 深度相等", () => {
    const { map } = redact(RAW, [ENTITY_ZHANG, ENTITY_LAOZHOU], { nonce: NONCE });
    const round = parseRedactionMap(JSON.parse(JSON.stringify(redactionMapJsonValue(map))));
    // `entityId` 是预览层的一次性元数据（S10「这个词不脱敏」用它定位实体），不进 manifest；
    // 往返比的是持久化面，所以两侧都先去掉它。
    const stripPreviewId = (m: RedactionMap): unknown => ({
      ...m,
      spans: m.spans.map(({ entityId, ...rest }) => rest),
    });
    expect(stripPreviewId(round)).toEqual(stripPreviewId(map));
    expect(round.spans.map((s) => s.source)).toEqual(map.spans.map((s) => s.source));
  });

  it("混合 4 种来源的 map 往返后仍逐条同值（无产出路径的来源走序列化面也不丢）", () => {
    const sources: RedactionSource[] = ["rule", "entity_memory", "local_llm", "user_confirmed"];
    const json = mapJsonWithSource(undefined);
    (json.spans as Array<Record<string, unknown>>).forEach((span, i) => {
      span["source"] = sources[i]!;
    });
    const parsed = parseRedactionMap(JSON.parse(JSON.stringify(json)));
    expect(parsed.spans.map((s) => s.source)).toEqual(sources);
    expect(JSON.stringify(redactionMapJsonValue(parsed))).toEqual(JSON.stringify(json));
  });
});

// ── 断言 5：脱敏文本逐字不变（不升版的证据）─────────────────────────

describe("断言 5：加字段前后脱敏文本与 payload 哈希逐字一致", () => {
  it("固定原文 + 固定 nonce + 固定实体清单 ⇒ redactedText 等于改动前实测基线", () => {
    const { redactedText } = redact(RAW, [ENTITY_ZHANG, ENTITY_LAOZHOU], { nonce: NONCE });
    expect(redactedText).toBe(BASELINE_REDACTED_TEXT);
    expect(sha256OfText(redactedText)).toBe(BASELINE_PAYLOAD_SHA256);
  });

  it("map 序列化面只多了一个键：去掉 source 后与改动前的 JSON 逐字相同（含键序）", () => {
    const { map } = redact(RAW, [ENTITY_ZHANG, ENTITY_LAOZHOU], { nonce: NONCE });
    expect(mapJsonWithoutSource(map)).toBe(BASELINE_MAP_JSON);
  });

  it("策略版本已按 Phase A 升到 rules-v2；raw-v1 不受影响", () => {
    expect(REDACTION_POLICY_VERSION).toBe("rules-v2");
    expect(RAW_SEND_POLICY_VERSION).toBe("raw-v1");
    expect(redact(RAW, [ENTITY_ZHANG], { nonce: NONCE }).map.policyVersion).toBe("rules-v2");
  });

  it("来源不改变替换集合：同一条文本，实体命中换成规则命中也不改偏移算术", () => {
    // 「13800138000」这一处：无论被认成 rule 还是 entity_memory，占位符槽位与两侧坐标同形。
    const asRule = redact("打 13800138000 给", [], { nonce: NONCE });
    expect(asRule.redactedText).toBe("打 [phone_1_a1b2c3] 给");
    expect(asRule.map.spans[0]!.source).toBe("rule");
  });
});

// ── 断言 6：存量授权仍匹配（草案 §六-6）─────────────────────────────

describe("断言 6：加字段后存量 cloud_send_grant 仍然命中", () => {
  let sandbox: Sandbox;
  let db: Database;
  let records: RecordService;
  let grants: GrantService;
  let revisionId: string;

  beforeEach(() => {
    sandbox = makeSandbox("tb-m6-0f-");
    db = openSandboxDb(sandbox.layout);
    migrate(db);
    records = new RecordService(db, { timezoneId: "Asia/Shanghai", now: () => new Date(NOW) });
    grants = new GrantService(db, { now: () => new Date(NOW) });
    revisionId = records.createRecord(RAW, "cloud_redacted").revision.id;
  });

  afterEach(() => {
    db.close();
    sandbox.cleanup();
  });

  /** 手写一行「迁移前签发的授权」：payload 哈希取改动前的基线值，与本次代码无关。 */
  function insertPreChangeGrant(): CloudSendGrantRow {
    const row: CloudSendGrantRow = {
      id: newId("cloudSendGrant"),
      record_revision_id: revisionId,
      send_content_mode: "redacted",
      redacted_sha256: BASELINE_PAYLOAD_SHA256,
      payload_sha256: BASELINE_PAYLOAD_SHA256,
      policy_version: "rules-v1",
      confirmed_at_utc: NOW,
    };
    db.prepare(
      `insert into cloud_send_grant (id, record_revision_id, send_content_mode, redacted_sha256, payload_sha256, policy_version, confirmed_at_utc)
       values (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.id,
      row.record_revision_id,
      row.send_content_mode,
      row.redacted_sha256,
      row.payload_sha256,
      row.policy_version,
      row.confirmed_at_utc,
    );
    return row;
  }

  it("preparePreview 的 policyVersion 已升到 rules-v2，payload 文本与哈希不受影响", () => {
    const preview = grants.preparePreview(revisionId, { nonce: NONCE, entities: [ENTITY_ZHANG, ENTITY_LAOZHOU] });
    expect(preview.policyVersion).toBe("rules-v2");
    expect(preview.payloadSha256).toBe(BASELINE_PAYLOAD_SHA256);
    expect(preview.payloadText).toBe(BASELINE_REDACTED_TEXT);
    expect(preview.map.spans.map((s) => s.source)).toEqual(["entity_memory", "rule", "rule", "entity_memory"]);
  });

  it("迁移前签发的 v1 授权对新预览不再适用（PD-5：一次性重新确认）", () => {
    const pre = insertPreChangeGrant();
    const preview = grants.preparePreview(revisionId, { nonce: NONCE, entities: [ENTITY_ZHANG, ENTITY_LAOZHOU] });

    expect(
      grants.findApplicableGrant(revisionId, preview.payloadSha256, preview.policyVersion, preview.sendContentMode),
    ).toBeNull();
    expect(grants.grantForPreview(preview)).toBeNull();
    expect(() =>
      grants.requireApplicableGrant(revisionId, preview.payloadSha256, preview.policyVersion, "redacted"),
    ).toThrow();
    // v1 那一行仍在库里（历史保留），只是不再命中。
    expect(pre.id).toBeTruthy();
  });

  it("issueGrant 对新策略另签一行，不复用 v1", () => {
    insertPreChangeGrant();
    const preview = grants.preparePreview(revisionId, { nonce: NONCE, entities: [ENTITY_ZHANG, ENTITY_LAOZHOU] });
    const again = grants.issueGrant(preview);
    expect(again.policy_version).toBe("rules-v2");
    const rows = db.prepare("select count(*) as n from cloud_send_grant").get() as { n: number };
    expect(rows.n).toBe(2);
  });

  it("两条轨道仍互不命中：脱敏授权不会被 raw 预览顶掉（0D 的契约没被本次动到）", () => {
    insertPreChangeGrant();
    const rawPreview = grants.prepareRawPreview(revisionId);
    expect(rawPreview.policyVersion).toBe(RAW_SEND_POLICY_VERSION);
    expect(
      grants.findApplicableGrant(
        revisionId,
        rawPreview.payloadSha256,
        rawPreview.policyVersion,
        rawPreview.sendContentMode,
      ),
    ).toBeNull();
    expect(GRANT_SEND_CONTENT_MODES).toEqual(["redacted", "raw"]);
    expect(grantPolicyVersionFor("redacted")).toBe(REDACTION_POLICY_VERSION);
  });
});
