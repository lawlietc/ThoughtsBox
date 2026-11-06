/**
 * M7-2a「关系抽取的契约层收尾」专项测试（准则 §3.3 / §3.4，任务口径见工作日志）。
 *
 * 本轮到**抽取与校验**为止：形状门（`parseStructuredOutput`）+ 关系事实门
 * （`validateRelations`）+ prompt v2 正文。**不含写库**——端点解析、`active` 判定、
 * `commitDerived` 里的那一笔属 M7-2b，这里一个都不碰（禁区：不写 `writeRelations`）。
 *
 * 全程离线、零数据库：两道门都不查库（`contract.ts` 头注），夹具因此不需要沙箱。
 */

import { describe, expect, it } from "vitest";

import {
  ContractSchemaError,
  parseStructuredOutput,
  validateBusiness,
  validateRelations,
  type BusinessValidationContext,
  type ExtractedRelation,
  type RelationGateRule,
  type StructuredOutput,
} from "../src/server/ingest/contract.ts";
import { M2_PROMPT_V2 } from "../src/server/ingest/prompts/m2-prompt-v2.ts";
import { loadContracts } from "../src/shared/contracts/load.ts";
import { aiCreatableGraphEdgeRelationTypes } from "../src/shared/contracts/enums.ts";
import { redact, type KnownEntity } from "../src/server/privacy/redaction.ts";
import { LOCAL_RAW, validOutput } from "./helpers/ingestFixtures.ts";

/** 判据名取回来看一眼，比只数数量更能说明「为什么这条被丢」。 */
function rulesOf(discarded: readonly { reasons: readonly { rule: RelationGateRule }[] }[]): string[] {
  return discarded.flatMap((item) => item.reasons.map((reason) => reason.rule)).sort();
}

function detailsOf(discarded: readonly { reasons: readonly { detail: string }[] }[]): string {
  return discarded.flatMap((item) => item.reasons.map((reason) => reason.detail)).join("\n");
}

function capture(action: () => unknown): unknown {
  try {
    action();
    return undefined;
  } catch (cause) {
    return cause;
  }
}

/* ── 本地档夹具：一条在场关系与它的原文坐标 ─────────────────────────── */

/** LOCAL_RAW 里在场的一对词面：`我` 与 `项目组`（证据切片同时容得下两者）。 */
const LOCAL_EVIDENCE = "今天和项目组的同事讨论了发布计划，我";

function relation(overrides: Partial<ExtractedRelation> = {}): ExtractedRelation {
  return {
    relationType: "colleague_of",
    srcLabel: "我",
    dstLabel: "项目组",
    evidence: LOCAL_EVIDENCE,
    ...overrides,
  };
}

function withRelations(relations: ExtractedRelation[]): StructuredOutput {
  return { ...validOutput(), relations };
}

const localContext = (): BusinessValidationContext => ({ sentText: LOCAL_RAW, rawText: LOCAL_RAW });

/* ── 云端档夹具：三个人名、四处出现 ⇒ 四条 span、三个标识 ─────────── */

const CLOUD_NONCE = "z9y8x7";
const CLOUD_RAW = "张三是李四的上级，张三是王五的同学";
const CLOUD_ENTITIES: readonly KnownEntity[] = [
  { entityId: "entity_zhang", entityType: "person", terms: ["张三"] },
  { entityId: "entity_li", entityType: "person", terms: ["李四"] },
  { entityId: "entity_wang", entityType: "person", terms: ["王五"] },
];
const CLOUD = redact(CLOUD_RAW, CLOUD_ENTITIES, { nonce: CLOUD_NONCE });
/**
 * 占位符按**原文词面**从映射里查，不按 `spans` 下标取。
 *
 * `redact` 替换的是每一处出现：`张三` 在这条记录里出现两次 ⇒ `spans` 是**四条**而不是三条，
 * 第二处仍复用 `[person_1_*]`（同一实体在本次请求内共用一个占位符，模型才回溯得了）。
 * 按「第 N 条 span == 第 N 个实体」取下标，夹具自己就先错位——`王五` 会被读成第二个 `张三`。
 */
function phOf(term: string): string {
  const span = CLOUD.map.spans.find((s) => CLOUD_RAW.slice(s.originalStart, s.originalEnd) === term);
  if (span === undefined) throw new Error(`夹具映射里没有词面 ${term} 的占位符`);
  return span.placeholder;
}
const PH_ZHANG = phOf("张三"); // [person_1_z9y8x7]
const PH_LI = phOf("李四"); // [person_2_z9y8x7]
const PH_WANG = phOf("王五"); // [person_3_z9y8x7]

const cloudContext = (): BusinessValidationContext => ({
  sentText: CLOUD.redactedText,
  rawText: CLOUD_RAW,
  redactionMap: CLOUD.map,
});

/* ── 一、合法关系 ─────────────────────────────────────────────────── */

describe("M7-2a 关系门：合法产出", () => {
  it("一条合法关系过门，坐标落在**原文**切片上", () => {
    const result = validateRelations(withRelations([relation()]), localContext());
    expect(result.discarded).toEqual([]);
    expect(result.relations).toHaveLength(1);
    const kept = result.relations[0]!;
    expect(kept).toMatchObject({ relationType: "colleague_of", srcLabel: "我", dstLabel: "项目组" });
    expect(kept.evidenceStart).toBe(LOCAL_RAW.indexOf(LOCAL_EVIDENCE));
    expect(kept.evidenceEnd).toBe(LOCAL_RAW.indexOf(LOCAL_EVIDENCE) + LOCAL_EVIDENCE.length);
    expect(LOCAL_RAW.slice(kept.evidenceStart, kept.evidenceEnd)).toBe(kept.evidenceText);
  });

  /**
   * 云端：证据引用占位符本体，词面是**原文**人名。`termGroundedIn` 必须两面都看
   * （发送切片有占位符、原文切片有词面），否则这条合法关系会被误丢。
   */
  it("云端合法：证据是占位符切片，词面在映射回的原文里", () => {
    const kept = validateRelations(
      { ...validOutput(), relations: [
        { relationType: "reports_to", srcLabel: "李四", dstLabel: "张三", evidence: `${PH_ZHANG}是${PH_LI}的上级` },
        { relationType: "classmate_of", srcLabel: "张三", dstLabel: "王五", evidence: `${PH_ZHANG}是${PH_WANG}的同学` },
      ] },
      cloudContext(),
    );
    expect(kept.discarded).toEqual([]);
    expect(kept.relations.map((r) => r.relationType)).toEqual(["reports_to", "classmate_of"]);
    expect(kept.relations[0]!.evidenceText).toBe("张三是李四的上级");
    expect(kept.relations[1]!.evidenceText).toBe("张三是王五的同学");
    // 入库的坐标是原文坐标，不是脱敏坐标（K-23）。
    expect(CLOUD_RAW.slice(kept.relations[0]!.evidenceStart, kept.relations[0]!.evidenceEnd)).toBe("张三是李四的上级");
    // 夹具前提：两条证据引用的是**同一个** `张三` 标识，而映射里它占两处区间。
    expect(CLOUD.map.spans.filter((s) => s.placeholder === PH_ZHANG)).toHaveLength(2);
  });

  /** 六类各一条（§3.1 的允许集）。词面/证据都用本地那条在场切片：这一条只验**类型集**是否放行。 */
  it("六类稳定社会关系各一条，全部过门", () => {
    const types = aiCreatableGraphEdgeRelationTypes(loadContracts().enums);
    expect([...types].sort()).toEqual(
      ["classmate_of", "colleague_of", "family_of", "friend_of", "partner_of", "reports_to"].sort(),
    );
    const result = validateRelations(
      withRelations(types.map((relationType) => relation({ relationType }))),
      localContext(),
    );
    expect(result.discarded).toEqual([]);
    expect(result.relations.map((r) => r.relationType).sort()).toEqual([...types].sort());
  });

  it("没有关系：两个清单都空，且不抛", () => {
    const result = validateRelations(withRelations([]), localContext());
    expect(result).toEqual({ relations: [], discarded: [] });
  });
});

/* ── 二、逐条丢弃（准则 §3.4）─────────────────────────────────────── */

describe("M7-2a 关系门：坏一条只丢那一条", () => {
  it("类型不在六值内 ⇒ 丢弃，并点名允许集", () => {
    // 因果关系：§一 明确不收，K-18 亦禁（`triggered_by`）。
    const causal = validateRelations(withRelations([relation({ relationType: "triggered_by" })]), localContext());
    expect(causal.relations).toEqual([]);
    expect(rulesOf(causal.discarded)).toEqual(["relation_type_allowed"]);
    expect(detailsOf(causal.discarded)).toContain("triggered_by");

    // `same_as` 落在 GraphEdge 载体上但 AI 永不创建（K-18）：抽取面同样不放行。
    expect(rulesOf(validateRelations(withRelations([relation({ relationType: "same_as" })]), localContext()).discarded)).toEqual([
      "relation_type_allowed",
    ]);

    // 投影类（`has_emotion`）根本不入图，同理被丢。
    expect(rulesOf(validateRelations(withRelations([relation({ relationType: "has_emotion" })]), localContext()).discarded)).toEqual([
      "relation_type_allowed",
    ]);
  });

  it("两端同词 ⇒ 丢弃（NFC 归一后比较，写法不同也算同词）", () => {
    const same = validateRelations(withRelations([relation({ srcLabel: "项目组", dstLabel: "项目组" })]), localContext());
    expect(same.relations).toEqual([]);
    expect(rulesOf(same.discarded)).toEqual(["relation_endpoints_distinct"]);

    // `e\u0301`（组合字符）与 `\u00e9`（预组字符）逐字不相等、NFC 归一后相等：
    // 只在源码里 `===` 比较的话这一条会被放行，端点自环就写进了图。
    const nfcRaw = "é 和 é 是同事";
    const result = validateRelations(
      { ...validOutput(), relations: [{ relationType: "friend_of", srcLabel: "é", dstLabel: "é", evidence: nfcRaw }] },
      { sentText: nfcRaw, rawText: nfcRaw },
    );
    expect(result.relations).toEqual([]);
    expect(rulesOf(result.discarded)).toEqual(["relation_endpoints_distinct"]);
  });

  it("证据不可回锚 ⇒ 丢弃（evidence_traceable）", () => {
    const result = validateRelations(withRelations([relation({ evidence: "和隔壁部门的老周吵了一架" })]), localContext());
    expect(result.relations).toEqual([]);
    expect(rulesOf(result.discarded)).toEqual([
      "evidence_traceable",
      "relation_label_grounded",
      "relation_label_grounded",
    ]);
    expect(result.discarded[0]!.target).toBe("relations[0]");
  });

  it("证据切坏了占位符 ⇒ 映射不出原文坐标，丢弃的是那一条而不是整次 run", () => {
    // 从 `[person_1_z9y8x7]` 中间起切：能在发送文本里定位，但映射不出原文（§7.6.2 同一道门）。
    const result = validateRelations(
      { ...validOutput(), relations: [{ relationType: "friend_of", srcLabel: "张三", dstLabel: "李四", evidence: `person_1_${CLOUD_NONCE}]是${PH_LI}的上级` }] },
      cloudContext(),
    );
    // 坏的那一条没进 accepted，其余产出（这一条只有 relations）照旧不抛。
    expect(result.relations).toEqual([]);
    expect(result.discarded).toHaveLength(1);
    expect(result.discarded[0]!.target).toBe("relations[0]");
    // 判据是**包含**而不是「恰好一条」：回锚不出坐标 ⇒ 两端的词面逐字依据同样查不出来，
    // 一并记 `relation_label_grounded`。丢弃清单的用途是诊断（`DiscardedRelation.reasons`
    // 头注「不只报第一个」），条数随坏法浮动，钉死数量等于把诊断信息当噪声消掉。
    expect(rulesOf(result.discarded)).toContain("evidence_mappable_to_original");
  });

  it("证据不含某一端的逐字依据 ⇒ 丢弃并点名是哪一端", () => {
    const result = validateRelations(
      withRelations([relation({ evidence: "和项目组的同事讨论了发布计划" })]),
      localContext(),
    );
    expect(result.relations).toEqual([]);
    expect(rulesOf(result.discarded)).toEqual(["relation_label_grounded"]);
    expect(detailsOf(result.discarded)).toContain("srcLabel");
    expect(detailsOf(result.discarded)).toContain("我");
    expect(detailsOf(result.discarded)).not.toContain("dstLabel");
  });

  it("占位符规则对关系同样生效：编造的标识既回溯失败也不产生证据", () => {
    const result = validateRelations(
      { ...validOutput(), relations: [{ relationType: "friend_of", srcLabel: "张三", dstLabel: "李四", evidence: `和 [person_9_zzzz99] 是同学` }] },
      cloudContext(),
    );
    expect(result.relations).toEqual([]);
    expect(result.discarded).toHaveLength(1);
    // 与标签门同一口径（`m2-provider` 那条占位符负例报的也是这两条规则名）；关系门两端各查一次
    // 词面依据，回锚不出时还会多记两笔 ⇒ 判「哪些规则被触犯」用包含，不钉清单长度。
    expect(rulesOf(result.discarded)).toContain("evidence_traceable");
    expect(rulesOf(result.discarded)).toContain("placeholder_untouched");
    // 诊断信息不许丢：被编造的那个标识必须在 detail 里点名，运维才知道模型臆造了谁。
    expect(detailsOf(result.discarded)).toContain("[person_9_zzzz99]");
  });

  it("一条坏关系可以同时坏在两处：判据逐条留痕，不只报第一个", () => {
    const result = validateRelations(
      withRelations([relation({ relationType: "triggered_by", srcLabel: "项目组", dstLabel: "项目组", evidence: "不存在的话" })]),
      localContext(),
    );
    expect(rulesOf(result.discarded)).toEqual([
      "evidence_traceable",
      "relation_endpoints_distinct",
      "relation_label_grounded",
      "relation_label_grounded",
      "relation_type_allowed",
    ]);
    expect(result.discarded).toHaveLength(1);
  });

  it("丢弃清单只记索引与判据，坏关系本身不进 accepted 清单（写入侧据此计数）", () => {
    const mixed = validateRelations(
      withRelations([relation(), relation({ relationType: "same_as" }), relation({ srcLabel: "小林", dstLabel: "项目组" })]),
      localContext(),
    );
    expect(mixed.relations).toHaveLength(1);
    expect(mixed.discarded.map((d) => d.index)).toEqual([1, 2]);
  });
});

/* ── 三、坏关系不毁掉整次解析（§3.4 的「不整批失败」）───────────────── */

describe("M7-2a 关系门与致命门的边界", () => {
  it("坏关系被丢时，其余产出照旧通过且整次校验不抛", () => {
    const output = withRelations([
      relation(),
      relation({ relationType: "triggered_by" }),
      relation({ srcLabel: "项目组", dstLabel: "项目组" }),
      relation({ evidence: "原文里没有的一句证据" }),
    ]);
    const parsed = parseStructuredOutput(output);

    // ① 关系门自己不抛，坏的进丢弃清单。
    const relations = validateRelations(parsed, localContext());
    expect(relations.relations).toHaveLength(1);
    expect(relations.discarded).toHaveLength(3);

    // ② 同一份回稿的其余产出照旧过致命门：一条坏关系不牵动 episodes / thoughts / 标签。
    const business = validateBusiness(parsed, localContext());
    expect(business.episodes).toHaveLength(1);
    expect(business.thoughts).toHaveLength(1);
    expect([business.emotions, business.topics, business.entities].map((list) => list.length)).toEqual([1, 1, 1]);
  });

  it("关系门的判据不混进 BUSINESS_RULES 台账（去向不同）", () => {
    // `validateBusiness` 只看六条致命规则；关系专属的三条判据不在那份清单里，
    // 否则 Trace 会声称一次成功的 run 拒过什么（`contract.ts` 的 RELATION_RULES 头注）。
    const businessRules: readonly string[] = [
      "evidence_traceable",
      "evidence_mappable_to_original",
      "placeholder_untouched",
      "candidate_id_valid",
      "entity_basis_sufficient",
      "event_time_compatible",
    ];
    for (const rule of ["relation_type_allowed", "relation_endpoints_distinct", "relation_label_grounded"]) {
      expect(businessRules).not.toContain(rule);
    }
  });
});

/* ── 四、形状门：`.strict()` 与缺席的 relations 键 ──────────────────── */

describe("M7-2a 形状门：relations 在册但不必填", () => {
  it("条目里多给的键仍被 `.strict()` 拒（强度、置信度、端点 ID 都不进得来）", () => {
    for (const extra of [
      { intensity: 5 },
      { confidence: 0.9 },
      { srcId: "entity_zhang" },
      { episodeId: "ep_1" },
    ]) {
      const raw = { ...validOutput(), relations: [{ ...relation(), ...extra }] };
      const thrown = capture(() => parseStructuredOutput(JSON.parse(JSON.stringify(raw))));
      expect(thrown, `期望形状门拒掉多余键 ${JSON.stringify(extra)}`).toBeInstanceOf(ContractSchemaError);
      const issues = (thrown as ContractSchemaError).issues.join("\n");
      expect(issues).toContain("relations");
      expect(issues).toContain(Object.keys(extra)[0]!);
    }
  });

  it("关系条目缺任一键（四键齐备）被形状门拒", () => {
    for (const key of ["relationType", "srcLabel", "dstLabel", "evidence"] as const) {
      const raw: Record<string, unknown> = { ...relation() };
      delete raw[key];
      const thrown = capture(() =>
        parseStructuredOutput(JSON.parse(JSON.stringify({ ...validOutput(), relations: [raw] }))),
      );
      expect(thrown, `缺 ${key} 应被拒`).toBeInstanceOf(ContractSchemaError);
    }
  });

  it("空字符串的词面/证据被形状门拒（非空是形状，不是事实）", () => {
    const thrown = capture(() =>
      parseStructuredOutput(JSON.parse(JSON.stringify({ ...validOutput(), relations: [{ ...relation(), srcLabel: "" }] }))),
    );
    expect(thrown).toBeInstanceOf(ContractSchemaError);
  });

  /**
   * 运行期断言（准则 §3.3 后半句的存在理由）：**不带 `relations` 键的旧输出 payload**
   * 仍要过形状门，解析后 `relations === []`。
   *
   * 这一条故意走 `JSON.stringify → JSON.parse`：TS 类型在这里帮不上忙（喂进去的是
   * `unknown`），证的正是「旧 prompt 的回稿 / 库里已有的 run 回放 / `m2-output-v1` 形状的夹具
   * 不会因为契约多一个键而被拒」。改成 `.optional()` 也能过这条门，但那会把「缺席即空数组」
   * 推给每一个下游消费者去兜，`.default([])` 才是收敛点。
   */
  it("旧 payload（无 relations 键）过形状门，解析后 relations 是空数组", () => {
    const legacy: Record<string, unknown> = { ...validOutput() };
    delete legacy["relations"];
    const wire = JSON.stringify(legacy);
    expect(wire, "夹具本身必须真的不带这个键").not.toContain("relations");

    const parsed = parseStructuredOutput(JSON.parse(wire));
    expect(Array.isArray(parsed.relations)).toBe(true);
    expect(parsed.relations).toEqual([]);
    expect(Object.keys(parsed).sort()).toEqual(
      ["emotions", "entities", "episodes", "relations", "summary", "thoughts", "title", "topics"].sort(),
    );

    // 同一份旧载荷过完形状门后，关系门自然是空产出——不抛、不牵动其余校验。
    expect(validateRelations(parsed, localContext())).toEqual({ relations: [], discarded: [] });
    expect(capture(() => validateBusiness(parsed, localContext()))).toBeUndefined();
  });

  it("空数组与缺席等价：新 prompt 要求键在场，Schema 不逼它", () => {
    const withEmpty = parseStructuredOutput(JSON.parse(JSON.stringify({ ...validOutput(), relations: [] })));
    expect(withEmpty.relations).toEqual([]);
    // 关系键不得被降级成「多出来的那一个」：`.strict()` 认它在册。
    expect(capture(() => parseStructuredOutput(JSON.parse(JSON.stringify({ ...validOutput(), relation: [] })))))
      .toBeInstanceOf(ContractSchemaError);
  });
});

/* ── 五、prompt v2 正文（§3.3 的三条禁则住在文本里）────────────────── */

describe("M7-2a prompt v2：关系一节的禁则", () => {
  it("只抽关系词明说的稳定关系；事件与弱关系不抽", () => {
    expect(M2_PROMPT_V2).toContain("只抽关系词被明说的关系");
    for (const word of ["同事", "朋友", "家人", "伴侣", "同学", "上下级"]) expect(M2_PROMPT_V2).toContain(word);
    // 事件禁则点名原文里的两种说法（准则 §四：源码层断言）。
    expect(M2_PROMPT_V2).toContain("一起吃饭");
    expect(M2_PROMPT_V2).toContain("吵了一架");
    expect(M2_PROMPT_V2).toContain("事件不是关系");
    expect(M2_PROMPT_V2).toContain("弱关系不是关系");
  });

  it("两端词面必须是本条记录里出现过的原词，方向是下属 → 上级", () => {
    expect(M2_PROMPT_V2).toContain('"srcLabel" 与 "dstLabel" 必须是这条记录里出现过的**原词**');
    expect(M2_PROMPT_V2).toContain("下属 → 上级");
    expect(M2_PROMPT_V2).toContain("两端不得是同一个词面");
    // 「只在本条记录内成立」这条禁则在正文里是两句话：划范围的前半句 + 堵住推断来源的后半句。
    // 断言逐句对齐 prompt 实际写出的措辞，而不是测试拟定的口号。
    expect(M2_PROMPT_V2).toContain("且只在**本条记录**内成立");
    expect(M2_PROMPT_V2).toContain("不得从历史记录、常识或称谓习惯里推断关系");
  });

  it("没有关系时输出空数组，但 relations 键必须在场", () => {
    expect(M2_PROMPT_V2).toContain('"relations"');
    expect(M2_PROMPT_V2).toContain('没有关系时 "relations" 也要在，值是 []');
  });

  /** 关系类型封闭集取自 enums（E-07）：正文里的清单必须与允许集逐值相同。 */
  it("正文的 relationType 封闭集 == 抽取允许集（六值），且不含 triggered_by / same_as", () => {
    for (const type of aiCreatableGraphEdgeRelationTypes(loadContracts().enums)) {
      expect(M2_PROMPT_V2).toContain(`"${type}"`);
    }
    const enumLine = M2_PROMPT_V2.split("\n").find((line) => line.startsWith('- "relationType" ∈')) ?? "";
    for (const banned of ["triggered_by", "same_as", "merged_into", "possibly_same_as"]) {
      expect(enumLine, `允许集里混进了 ${banned}`).not.toContain(banned);
    }
    expect(enumLine).toContain("colleague_of");
  });

  it("强度与因果关系仍是禁则（v1 那句整体禁关系的话已随 §3.3 收窄）", () => {
    expect(M2_PROMPT_V2).toContain("不得输出强度（intensity）评分");
    expect(M2_PROMPT_V2).toContain("不得输出因果关系（如 triggered_by）");
    expect(M2_PROMPT_V2).not.toContain("不得输出关系类型或因果关系");
  });
});
