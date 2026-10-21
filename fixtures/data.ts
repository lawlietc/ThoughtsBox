/**
 * 假数据本体 —— **全项目唯一的一份**（§四 第 3 条推论）。
 *
 * 〔M3-UI-5〕这一份原先在 `prototype/src/mock/`，现在提到顶层，因为消费方变成两个：
 *   · 沟通件（原型）：`prototype/src/mock/data.ts` 只做转发，界面直接吃这些对象；
 *   · 产品的 dev 模式：`src/web/fixturePort.ts` + `src/web/fakeApi.ts` 把它们折成
 *     产品的数据口形状与 `/api` 回执（生产构建里这两个文件都不存在）。
 * 两个消费方读的是**同一份字节**。谁也不许抄一份 —— 抄一份就会各自漂移，
 * 而「原型上看到的」与「产品 dev 模式上看到的」不一致，正是这份 fixture 存在的全部意义所禁止的。
 *
 * ⚠️ 三件事必须先说清楚，否则你会误读你看到的一切：
 *
 * 1. **这些整理结果是手写的，不是模型跑出来的。** 真实模型的抽取质量远不如这里漂亮 ——
 *    它可能只抽得出两三个标签、可能给一堆回锚不上的证据。所以这份 fixture 能对齐的是
 *    「信息架构与交互」，**对齐不了「抽得准不准」**。
 * 2. **每个字段的形状都照冻结契约**，包括 0003 的 CHECK 约束语义（时间精度三件套一致、
 *    提及恰好一种来源、inferred 只能配 user_confirmed_suggestion…）。形状错的假数据会骗你。
 * 3. **`productNotes` 是专门放「产品问题」的地方** —— 那些一画出来就发现契约表达不了的东西。
 *    它们才是这轮迭代真正要讨论的对象，比界面好不好看重要得多。
 *
 * 原文素材取自 `scratch/seed-demo.mjs` 的 14 条演示记录（同一批内容，便于和真实库里那批对照）。
 *
 * ⚠️ 两处取值**故意比 `enums.json` 宽**（〔用户裁定 2026-10-14〕）：时间精度多了 `time_of_day`、
 * 实体大类是 8 类（`game` 并入 `work`，新增 `activity` / `event`）。原型照原样显示并把「这是产品
 * 还没有的档」写在总览页；产品 dev 入口必须**折叠回产品取值**再显示，不许把 `time_of_day` 打印出去。
 * 对账关系见 `prototype/src/mock/contract.ts` 的三条通道（problems / experiments / pending）。
 */

import type {
  Attachment,
  Concept,
  Entity,
  EntityMention,
  Episode,
  EventTimeCertainty,
  EventTimePrecision,
  Evidence,
  Mention,
  ParseRun,
  RecordItem,
  RunOutput,
  Suggestion,
  ThoughtItem,
} from "./types.ts";

export const TIMEZONE = "Asia/Shanghai";
export const POLICY_VERSION = "redaction-policy-v1";

/**
 * 证据锚：fixture 只声明「证据是哪句话」，坐标由代码算。
 * 手数偏移量必然出错，而且一旦出错，原型演示的「证据回溯」就是假的。
 * `indexOf` 返回 -1 时 `anchored=false` —— 那正是 §7.6.4 要演的那条失败路径。
 */
export function anchor(rawText: string, text: string): Evidence {
  const start = rawText.indexOf(text);
  return {
    text,
    start,
    end: start < 0 ? -1 : start + text.length,
    anchored: start >= 0,
  };
}

/* ══════════════════════════════════════════════════════════════════
 * 概念与实体（词表播种器产物 + 本次解析新归一的）
 * 真实 ID 形如 `concept_seed_<sha256前12>`；原型用可读后缀，只图能对着看。
 * ══════════════════════════════════════════════════════════════════ */

const cid = (name: string): string => `concept_seed_${name}`;
const eid = (name: string): string => `entity_${name}`;

const SEEDED_CONCEPTS: readonly [string, "emotion" | "topic"][] = [
  ["焦虑", "emotion"],
  ["恐惧", "emotion"],
  ["内疚", "emotion"],
  ["失落", "emotion"],
  ["愤怒", "emotion"],
  ["平静", "emotion"],
  ["疲惫", "emotion"],
  ["愧疚", "emotion"],
  ["自我怀疑", "topic"],
  ["沟通", "topic"],
  ["挫败", "topic"],
  ["独处", "topic"],
  ["家庭", "topic"],
  ["复盘", "topic"],
  ["睡眠", "topic"],
  ["选择", "topic"],
  // ── 二轮扩充（让「情绪盒子 / 主题浏览」的频次与排序有真东西可排） ──
  ["高兴", "emotion"],
  ["委屈", "emotion"],
  ["期待", "emotion"],
  ["孤独", "emotion"],
  ["释然", "emotion"],
  ["兴奋", "emotion"],
  ["烦躁", "emotion"],
  ["无力", "emotion"],
  ["尴尬", "emotion"],
  ["感激", "emotion"],
  ["温暖", "emotion"],
  ["紧张", "emotion"],
  ["满足", "emotion"],
  ["工作", "topic"],
  ["关系", "topic"],
  ["健康", "topic"],
  ["边界感", "topic"],
  ["拖延", "topic"],
  ["表达", "topic"],
  ["亲情", "topic"],
  ["金钱", "topic"],
  ["自我成长", "topic"],
];

export const CONCEPTS: Readonly<Record<string, Concept>> = Object.fromEntries(
  SEEDED_CONCEPTS.map(([name, conceptType]) => [
    cid(name),
    {
      id: cid(name),
      conceptType,
      canonicalName: name,
      lifecycleStatus: "active",
      // 词表播种：**唯一**允许 AI 之外凭空出现概念的路径。
      // 模型自己没有建概念的权限，它只能提 `new_concept` 建议（见 rec_01「创作焦虑」）。
      originType: "system_seed",
    } satisfies Concept,
  ]),
);

export const CONCEPT_BY_NAME: Readonly<Record<string, Concept>> = Object.fromEntries(
  Object.values(CONCEPTS).map((c) => [c.canonicalName, c]),
);

export const ENTITIES: Readonly<Record<string, Entity>> = {
  [eid("小林")]: {
    id: eid("小林"),
    entityType: "person",
    canonicalName: "小林",
    displayName: "小林",
    lifecycleStatus: "active",
  },
  [eid("杭州")]: {
    id: eid("杭州"),
    entityType: "place",
    canonicalName: "杭州",
    displayName: "杭州",
    lifecycleStatus: "active",
  },
  [eid("西湖")]: {
    id: eid("西湖"),
    entityType: "place",
    canonicalName: "西湖",
    displayName: "西湖",
    lifecycleStatus: "active",
  },
  // provisional：不进普通浏览列表，也不生成 about 边（端点必须是 Entity:active）。
  [eid("二泉映月")]: {
    id: eid("二泉映月"),
    entityType: "work",
    canonicalName: "二泉映月",
    displayName: "《二泉映月》",
    lifecycleStatus: "provisional",
  },
  // ── 二轮扩充：让人物/事物列表与「涉及」边有密度 ──
  [eid("老周")]: {
    id: eid("老周"),
    entityType: "person",
    canonicalName: "老周",
    displayName: "老周",
    lifecycleStatus: "active",
  },
  [eid("阿May")]: {
    id: eid("阿May"),
    entityType: "person",
    canonicalName: "阿May",
    displayName: "阿May",
    lifecycleStatus: "active",
  },
  [eid("妈妈")]: {
    id: eid("妈妈"),
    entityType: "person",
    canonicalName: "妈妈",
    displayName: "妈妈",
    lifecycleStatus: "active",
  },
  [eid("老家")]: {
    id: eid("老家"),
    entityType: "place",
    canonicalName: "老家",
    displayName: "老家",
    lifecycleStatus: "active",
  },
  [eid("公司")]: {
    id: eid("公司"),
    entityType: "place",
    canonicalName: "公司",
    displayName: "公司",
    lifecycleStatus: "active",
  },
  [eid("被讨厌的勇气")]: {
    id: eid("被讨厌的勇气"),
    entityType: "work",
    canonicalName: "被讨厌的勇气",
    displayName: "《被讨厌的勇气》",
    lifecycleStatus: "active",
  },
  [eid("置身事内")]: {
    id: eid("置身事内"),
    entityType: "work",
    canonicalName: "置身事内",
    displayName: "《置身事内》",
    lifecycleStatus: "active",
  },
  // 第二个 provisional：用来验证「待转正」不是一个孤例，列表入口够不够显眼。
  [eid("塞尔达传说")]: {
    id: eid("塞尔达传说"),
    entityType: "work",
    canonicalName: "塞尔达传说",
    displayName: "《塞尔达传说》",
    lifecycleStatus: "provisional",
  },
  // ── 二轮分类调整后新增的两类：活动 / 事件。
  //    加它们是想让你看着界面判断：把「跑步」和「老周」放在同一页，是不是对的。
  [eid("跑步")]: {
    id: eid("跑步"),
    entityType: "activity",
    canonicalName: "跑步",
    displayName: "跑步",
    lifecycleStatus: "active",
  },
  [eid("生日")]: {
    id: eid("生日"),
    entityType: "event",
    canonicalName: "生日",
    displayName: "生日",
    lifecycleStatus: "active",
  },
};

/* ══════════════════════════════════════════════════════════════════
 * 原文层
 * ══════════════════════════════════════════════════════════════════ */

const R01 = `早上醒来第一个念头就是那个还没交的东西。躺了十分钟，越想越紧，像是有一只手按在胸口。

其实离死线还有两周，但我知道自己怕的不是时间，是怕做出来之后发现它根本不行。`;

const R02 = `跟小林吵了一架。他说我总是在他讲事情的时候打断他，我第一反应是反驳，然后闭嘴了。

回家路上想，他说的可能是对的。我不是在听，我是在等着说我的下一句。`;

const R03 = `《被讨厌的勇气》读到一半。阿德勒说一切烦恼都是人际关系的烦恼 —— 这句我不同意，但暂时说不出哪里不对。`;

const R04 = `评审被否了。做了三个星期的方案，对方十分钟就说完「方向不对」。

散会之后我在会议室坐了一会儿。不是愤怒，更像是一种很熟悉的空洞 —— 小时候考完试在教室等成绩的那种。`;

// 原文写明了日期 —— 于是这条能有 day/explicit 的事件时间。别条都没有，见 productNotes。
const R05 = `10月2日。在杭州，早上六点起来走到西湖边，雾还没散，有人在打太极，有个老头在拉二胡，拉的是《二泉映月》，音很涩。

我站在那儿听了整首。什么都没想。这半年少有的半小时。`;

const R06 = `给我妈打电话，她又提起我该考虑成家的事。我说了句「知道了」就岔开话题。

挂了之后有点难受。我难受的不是她问，是我知道她一个人在家，问这个只是因为想找个由头多聊两句。`;

const R07 = `今天情绪很奇怪，说不清是烦躁还是累。什么都没做，又觉得什么都欠着。`;

const R08 = `周会复盘。三件事：接口对齐拖了两天是因为我一开始没把依赖讲清楚；测试环境的事我不该自己去弄，应该直接找运维；最后那个方案我讲得太快了。

下次讲方案，先讲约束再讲做法。`;

const R09 = `重看《置身事内》。上次读的时候只记住了「土地财政」，这次注意到的是它讲地方政府的激励结构 —— 同一件事，两次读看到的东西完全不同。`;

const R10 = `连续第四天睡不够六小时。眼睛干，注意力像漏水的桶。

不是没时间睡，是躺下之后脑子自动开始放白天没处理完的事。`;

const R11 = `两个选择摆在这儿：留下来，这个方向我熟，但我知道自己已经三个月没有学到新东西；走，什么都得重来，而且大概率会有一段很不好看的时间。

我一直在等一个「想清楚了」的时刻，但好像它不会来。`;

const R12 = `问自己一个问题：如果这件事没人会知道，我还会做吗？

答案是会。那说明我做的理由里，至少有一部分是真的。`;

const R13 = `今天结束了。

没做成什么大事，但把堆了三天的那件小事做完了，心里松了一块。

今晚先到这里。`;

// 含手机号 —— 用来演 cloud_redacted 的**规则脱敏**（预览里会看到占位符）。
const R14 = `想到一个可能有点用的做法：把每次「说不清为什么烦」的时刻记下来，过一个月回头看，也许能看出模式。

先记着，不急着解释。

（上次那个号：138 0013 8000，先存着。）`;

/* ── 二轮扩充的原文（rec_15…rec_38） ─────────────────────────────── */

const R15 = `傍晚从公司出来，天是那种很淡的橘色。走到地铁口才发现自己一直在绷着，看到那片天忽然松了。

没什么理由。就是松了。`;

// 含时段词「深夜」——实验档 time_of_day 的第一个样本。
const R16 = `深夜两点还醒着。白天会上小林说的一句话在脑子里转，转来转去变成了「他是不是觉得我不行」。

我知道这是过度解读，但知道归知道。`;

const R17 = `跟老周聊了半小时。他说：你不是怕做不好，你是怕做得不够好到没人挑得出毛病。

我愣了一下，因为他说的对。`;

const R18 = `早上开会前，手心是湿的。轮到我讲的时候嗓子发紧，第一句话差点没说出来。

讲完之后其实没那么糟。但开会前那十分钟，我整个人是缩着的。`;

const R19 = `今天是我妈生日。打电话过去，她第一句是「有事吗」。

我说没事就是想聊聊。她沉默了一下，然后开始说家里的事。挂之前她说，你忙你的，不用记着我生日。

我记着呢。`;

// 原文写了日期「10月3日」→ day/explicit。
const R20 = `10月3日。回老家看奶奶。她比上次瘦了，但精神还好，一直给我夹菜。

临走时她站在门口挥手，我走到拐角回头，她还在那儿。`;

const R21 = `项目上线了，成了。群里刷了一屏，我跟着笑了两分钟，然后坐下来，忽然空得厉害。

晚上回家打了会儿《塞尔达传说》，跑图跑了很久，什么都没干。`;

const R22 = `会上阿May当着所有人指出我那个数算错了。她是对的，我确实错了。

但我难受的不是错。是她说完之后，我下意识笑着说「哦对，我看看」，那个笑让我自己都别扭。`;

const R23 = `中午一个人去楼下吃面。周围都是三三两两的人，有人在大声讲电话。

我忽然很想有人跟我说句话。就一句也行。`;

const R24 = `傍晚去江边跑。跑到第三公里忽然不那么喘了，脑子里的那些事也跟着慢下来。

原来我不是想不通，是一直没停下来。`;

const R25 = `早上醒得比闹钟早，躺着听窗外的鸟叫。心里是轻的。

这种早上不多。记一下。`;

const R26 = `一整天什么都没干成。刷手机、看时间、又刷手机。到了晚上开始骂自己。

我知道骂也没用，明天大概还是一样。`;

const R27 = `想报个周末的课，想了三个星期还没报。怕报了也坚持不下来，又怕不报就这么一直拖着。`;

const R28 = `今天在地铁上听到一个人跟朋友抱怨工作，语气跟我一模一样。

我在旁边听着，忽然觉得自己有点可笑，也有点想笑。`;

const R29 = `把上周的复盘翻出来看了一遍。有三条当时写下的，现在还是原样。

原来写下来不等于改了。`;

const R30 = `跟小林说我想换个方向。他没劝我，只问了一句「那你想干什么」。

我答不上来。`;

const R31 = `今天没什么好说的。吃了饭，睡了觉，活了。`;

const R32 = `开始记这个。不知道能记多久，也不知道有什么用。

先记着。`;

const R33 = `晚上散步的时候想到一件事：我好像很久没有因为「高兴」而做什么事了，都是因为「应该」。`;

const R34 = `看到一句话：你可以同时是「正在变好」和「还很糟糕」。这句话让我安静了一会儿。`;

const R35 = `开会开了两个小时，一半时间在讨论一个其实不影响结果的问题。散会之后我很烦躁，又觉得没什么好烦的。`;

const R36 = `给自己定了个规矩：晚上十一点之后不回工作消息。第一天执行，手痒了三次。`;

const R37 = `梦到自己在考试，题目一个都不会。醒来发现是周一。

居然松了口气。`;

const R38 = `（有个邮箱要记一下：zhouluo@example.com，是老周的那个。）`;

const RAW: Readonly<Record<string, string>> = {
  rec_01: R01,
  rec_02: R02,
  rec_03: R03,
  rec_04: R04,
  rec_05: R05,
  rec_06: R06,
  rec_07: R07,
  rec_08: R08,
  rec_09: R09,
  rec_10: R10,
  rec_11: R11,
  rec_12: R12,
  rec_13: R13,
  rec_14: R14,
  rec_15: R15,
  rec_16: R16,
  rec_17: R17,
  rec_18: R18,
  rec_19: R19,
  rec_20: R20,
  rec_21: R21,
  rec_22: R22,
  rec_23: R23,
  rec_24: R24,
  rec_25: R25,
  rec_26: R26,
  rec_27: R27,
  rec_28: R28,
  rec_29: R29,
  rec_30: R30,
  rec_31: R31,
  rec_32: R32,
  rec_33: R33,
  rec_34: R34,
  rec_35: R35,
  rec_36: R36,
  rec_37: R37,
  rec_38: R38,
};

/** 规则脱敏：手机号 → 占位符。**映射表留在本机，绝不上线**（§5.1 步骤 5）。 */
export const REDACTION_RULES: readonly { readonly pattern: RegExp; readonly placeholder: string }[] = [
  { pattern: /\b1\d{2}\s?\d{4}\s?\d{4}\b/g, placeholder: "⟦手机号1⟧" },
  { pattern: /[\w.+-]+@[\w-]+\.[\w.]+/g, placeholder: "⟦邮箱1⟧" },
];

export interface PreviewResult {
  readonly payloadText: string;
  readonly map: Readonly<Record<string, string>>;
  readonly hits: readonly { readonly placeholder: string; readonly original: string }[];
}

/** 生成「实际准备发送的那份文本」。界面必须显示**这一份**，不是原文。 */
export function buildPreview(rawText: string): PreviewResult {
  let payloadText = rawText;
  const map: Record<string, string> = {};
  const hits: { placeholder: string; original: string }[] = [];
  for (const rule of REDACTION_RULES) {
    payloadText = payloadText.replace(rule.pattern, (match) => {
      map[rule.placeholder] = match;
      hits.push({ placeholder: rule.placeholder, original: match });
      return rule.placeholder;
    });
  }
  return { payloadText, map, hits };
}

interface RecordSeed {
  readonly id: string;
  readonly at: string;
  readonly mode: RecordItem["processingMode"];
  readonly status: RecordItem["processingStatus"];
  readonly privacy?: RecordItem["privacyLevel"];
}

const RECORD_SEEDS: readonly RecordSeed[] = [
  { id: "rec_01", at: "2026-09-22T08:12:41+08:00", mode: "cloud_redacted", status: "captured" },
  { id: "rec_15", at: "2026-09-23T18:40:22+08:00", mode: "local_model", status: "parsed" },
  { id: "rec_02", at: "2026-09-24T23:47:02+08:00", mode: "local_model", status: "captured" },
  { id: "rec_16", at: "2026-09-26T02:12:31+08:00", mode: "local_model", status: "parsed" },
  // manual_only：**不入待整理**（enums.json processing_rules.manual_only_not_pending）
  { id: "rec_03", at: "2026-09-27T14:03:19+08:00", mode: "manual_only", status: "not_processed" },
  { id: "rec_17", at: "2026-09-28T20:17:05+08:00", mode: "local_model", status: "parsed" },
  {
    id: "rec_04",
    at: "2026-09-30T19:26:55+08:00",
    mode: "cloud_redacted",
    status: "captured",
    privacy: "sensitive",
  },
  { id: "rec_18", at: "2026-10-01T09:06:44+08:00", mode: "local_model", status: "parsed" },
  { id: "rec_05", at: "2026-10-02T09:41:07+08:00", mode: "local_model", status: "captured" },
  { id: "rec_20", at: "2026-10-03T11:02:19+08:00", mode: "local_model", status: "parsed" },
  {
    id: "rec_06",
    at: "2026-10-04T21:15:33+08:00",
    mode: "cloud_redacted",
    status: "captured",
    privacy: "sensitive",
  },
  { id: "rec_19", at: "2026-10-05T21:33:52+08:00", mode: "local_model", status: "parsed" },
  // 失败态：原文完好，错误类别可读，有重试入口（M2 验收断言之一）
  { id: "rec_07", at: "2026-10-06T16:52:10+08:00", mode: "local_model", status: "failed" },
  { id: "rec_21", at: "2026-10-07T22:41:08+08:00", mode: "local_model", status: "parsed" },
  // 已整理：供你体验「改原文 → 待重新整理 → 重跑 → 旧结果被取代」整条链
  { id: "rec_08", at: "2026-10-08T18:08:44+08:00", mode: "local_model", status: "parsed" },
  { id: "rec_22", at: "2026-10-09T15:20:37+08:00", mode: "local_model", status: "parsed" },
  // manual_only + needs_reparse：同样不入待整理
  { id: "rec_09", at: "2026-10-09T22:34:26+08:00", mode: "manual_only", status: "needs_reparse" },
  { id: "rec_10", at: "2026-10-10T07:29:58+08:00", mode: "local_model", status: "captured" },
  { id: "rec_23", at: "2026-10-10T12:35:11+08:00", mode: "local_model", status: "parsed" },
  { id: "rec_31", at: "2026-10-11T07:00:03+08:00", mode: "manual_only", status: "not_processed" },
  { id: "rec_24", at: "2026-10-11T18:55:40+08:00", mode: "local_model", status: "parsed" },
  { id: "rec_11", at: "2026-10-11T20:47:15+08:00", mode: "cloud_redacted", status: "captured" },
  { id: "rec_25", at: "2026-10-12T07:12:58+08:00", mode: "local_model", status: "parsed" },
  { id: "rec_30", at: "2026-10-12T19:00:26+08:00", mode: "local_model", status: "failed" },
  { id: "rec_12", at: "2026-10-12T23:12:03+08:00", mode: "local_model", status: "captured" },
  { id: "rec_29", at: "2026-10-13T10:00:14+08:00", mode: "local_model", status: "needs_reparse" },
  { id: "rec_13", at: "2026-10-13T22:58:31+08:00", mode: "local_model", status: "captured" },
  { id: "rec_26", at: "2026-10-13T23:40:09+08:00", mode: "local_model", status: "parsed" },
  { id: "rec_28", at: "2026-10-14T08:30:12+08:00", mode: "local_model", status: "captured" },
  { id: "rec_27", at: "2026-10-14T09:15:47+08:00", mode: "local_model", status: "captured" },
  // 待确认发送：打开它就能看到规则脱敏后的待发送文本
  {
    id: "rec_14",
    at: "2026-10-14T10:05:47+08:00",
    mode: "cloud_redacted",
    status: "awaiting_privacy_review",
  },
  { id: "rec_35", at: "2026-10-14T11:20:33+08:00", mode: "cloud_redacted", status: "awaiting_privacy_review" },
  { id: "rec_36", at: "2026-10-14T12:00:05+08:00", mode: "manual_only", status: "captured" },
  { id: "rec_34", at: "2026-10-14T13:00:41+08:00", mode: "cloud_redacted", status: "captured" },
  { id: "rec_33", at: "2026-10-14T14:05:19+08:00", mode: "local_model", status: "processing" },
  { id: "rec_37", at: "2026-10-14T16:30:07+08:00", mode: "local_model", status: "captured" },
  {
    id: "rec_38",
    at: "2026-10-14T17:00:52+08:00",
    mode: "cloud_redacted",
    status: "captured",
    privacy: "sensitive",
  },
  { id: "rec_32", at: "2026-10-14T21:00:00+08:00", mode: "local_model", status: "captured" },
];

export function makeSeedRecords(): RecordItem[] {
  return RECORD_SEEDS.map((seed) => ({
    id: seed.id,
    createdAtLocal: seed.at,
    timezoneId: TIMEZONE,
    processingStatus: seed.status,
    processingMode: seed.mode,
    privacyLevel: seed.privacy ?? "normal",
    revisions: [
      {
        id: `rev_${seed.id}_1`,
        number: 1,
        rawText: RAW[seed.id] ?? "",
        createdAtLocal: seed.at,
      },
    ],
    currentRevisionId: `rev_${seed.id}_1`,
    grant: seed.id === "rec_08" ? null : null,
  }));
}

/* ══════════════════════════════════════════════════════════════════
 * 解析产出（手写 fixture）
 * ══════════════════════════════════════════════════════════════════ */

function mention(
  id: string,
  conceptName: string,
  kind: "emotion" | "topic",
  labelSaid: string,
  evidence: Evidence,
  source: Mention["source"],
  opts: { basis?: Mention["basis"]; origin?: Mention["originType"]; status?: Mention["status"] } = {},
): Mention {
  return {
    id,
    kind,
    conceptId: cid(conceptName),
    labelSaid,
    basis: opts.basis ?? "explicit",
    originType: opts.origin ?? "ai_generated",
    status: opts.status ?? "active",
    evidence,
    source,
  };
}

function entityMention(
  id: string,
  entityName: string,
  labelSaid: string,
  evidence: Evidence,
  source: EntityMention["source"],
  role: string | null,
): EntityMention {
  return {
    id,
    entityId: eid(entityName),
    labelSaid,
    basis: "explicit",
    originType: "ai_generated",
    status: "active",
    evidence,
    source,
    role,
  };
}

/**
 * 经历/念头的构造助手 —— 二轮扩充后手写条目变多，把「三件套一致性」
 * （时间精度 + 确定性 + 原文）收在一处，免得写漏一个就造出契约不允许的行。
 * `time` 不传 = unknown/unknown（原文没写时间的诚实默认）。
 */
function episode(
  id: string,
  summary: string,
  evidence: Evidence,
  time?: { readonly raw: string; readonly precision: EventTimePrecision; readonly certainty: EventTimeCertainty },
): Episode {
  return {
    id,
    summary,
    originType: "ai_generated",
    lifecycleStatus: "active",
    eventTimeRaw: time?.raw ?? null,
    eventTimePrecision: time?.precision ?? "unknown",
    eventTimeCertainty: time?.certainty ?? "unknown",
    evidence,
  };
}

function thought(id: string, text: string, evidence: Evidence): ThoughtItem {
  return { id, text, originType: "ai_generated", lifecycleStatus: "active", evidence };
}

const LOCAL = { provider: "ollama", model: "qwen2.5:7b-instruct", callPath: "openai_compatible" };
const CLOUD = { provider: "anthropic", model: "claude-sonnet-5-5", callPath: "sdk_structured" };

function run(
  id: string,
  recordId: string,
  revisionId: string,
  at: string,
  which: typeof LOCAL,
  resultState: ParseRun["resultState"] = "current",
  executionStatus: ParseRun["executionStatus"] = "succeeded",
  errorKind: string | null = null,
): ParseRun {
  return {
    id,
    recordId,
    revisionId,
    resultState,
    executionStatus,
    errorKind,
    startedAtLocal: at,
    finishedAtLocal: at,
    provider: which.provider,
    model: which.model,
    callPath: which.callPath,
  };
}

/** rec_01：一条普通记录被整理出来之后，界面上到底该长什么样。 */
function attachment01(): Attachment {
  const raw = R01;
  const ep = "ep_rec01_1";
  return {
    run: run("run_rec01_1", "rec_01", "rev_rec_01_1", "2026-09-22T08:19:02+08:00", CLOUD),
    output: {
      title: "怕的不是时间，是怕做出来之后发现它不行",
      summary:
        "早上醒来被一件还没交出去的东西压住，越躺越紧。写下来之后意识到：真正怕的不是赶不完，是做出来之后被否定。",
      episodes: [
        {
          id: ep,
          summary: "早上醒来，被一件还没交出去的东西困住",
          originType: "ai_generated",
          lifecycleStatus: "active",
          // 原文只写了「早上」—— 不到「日」的精度，按契约只能落 unknown。见 productNotes。
          eventTimeRaw: null,
          eventTimePrecision: "unknown",
          eventTimeCertainty: "unknown",
          evidence: anchor(raw, "早上醒来第一个念头就是那个还没交的东西"),
        },
      ],
      thoughts: [
        {
          id: "thought_rec01_1",
          text: "怕的不是时间，是怕做出来之后发现它根本不行。",
          originType: "ai_generated",
          lifecycleStatus: "active",
          evidence: anchor(raw, "怕的不是时间，是怕做出来之后发现它根本不行"),
        },
      ],
      emotions: [
        mention("em_rec01_1", "焦虑", "emotion", "紧", anchor(raw, "越想越紧"), {
          kind: "episode",
          containerId: ep,
        } as Mention["source"]),
      ],
      topics: [
        mention("tm_rec01_1", "自我怀疑", "topic", "怕做出来之后发现它根本不行", anchor(raw, "怕做出来之后发现它根本不行"), {
          kind: "episode",
          containerId: ep,
        } as Mention["source"]),
      ],
      entityMentions: [],
      suggestions: [
        {
          id: "sug_rec01_em",
          kind: "emotion_candidate",
          recordId: "rec_01",
          runId: "run_rec01_1",
          subjectTerm: "恐惧",
          reasonCode: "inferred_emotion",
          displayNote: "模型从「怕」推断出恐惧。它**不能**直接成为标签 —— 推断情绪只有你确认后才落库。",
          status: "pending",
          evidence: anchor(raw, "怕做出来之后发现它根本不行"),
        },
        {
          id: "sug_rec01_new",
          kind: "new_concept",
          recordId: "rec_01",
          runId: "run_rec01_1",
          subjectTerm: "创作焦虑",
          reasonCode: "unknown_label",
          displayNote: "词表里没有这个词。模型没有建主题的权限，只能提出来等你决定。",
          status: "pending",
          evidence: anchor(raw, "那个还没交的东西"),
        },
        {
          id: "sug_rec01_rel",
          kind: "possibly_related",
          recordId: "rec_01",
          runId: "run_rec01_1",
          subjectTerm: "ep_rec04_1",
          reasonCode: "shared_emotion_topic",
          displayNote:
            "和 9月30日「方案评审被否」都落在「怕做出来之后被否定」上。接受后才会在两者之间连一条边。",
          status: "pending",
          evidence: null,
        },
      ],
      redactionMap: {},
      evidenceRepairs: [],
      unrouted: [],
      productNotes: [
        "原文只写了「早上」。当前契约的时间精度只有 year / month / day / unknown —— **「早上 / 傍晚 / 刚才」这类时段表达无处安放**，只能落到 unknown。M3 要不要补一档 time_of_day？",
      ],
    },
  };
}

/** rec_02：local_model，无脱敏；演示「原文没写时间 ⇒ 只能是 unknown」。 */
function attachment02(): Attachment {
  const raw = R02;
  const ep = "ep_rec02_1";
  return {
    run: run("run_rec02_1", "rec_02", "rev_rec_02_1", "2026-09-24T23:52:10+08:00", LOCAL),
    output: {
      title: "我不是在听，我是在等着说我的下一句",
      summary: "和小林的一次争吵之后，回家路上意识到问题不在谁对谁错，而在于听的方式。",
      episodes: [
        {
          id: ep,
          summary: "和小林的一次争吵",
          originType: "ai_generated",
          lifecycleStatus: "active",
          // 原文里一个时间词都没有 → 契约强制 unknown 三件套一致，产品拒绝让模型猜日期。
          eventTimeRaw: null,
          eventTimePrecision: "unknown",
          eventTimeCertainty: "unknown",
          evidence: anchor(raw, "跟小林吵了一架"),
        },
      ],
      thoughts: [
        {
          id: "thought_rec02_1",
          text: "我不是在听，我是在等着说我的下一句。",
          originType: "ai_generated",
          lifecycleStatus: "active",
          evidence: anchor(raw, "我不是在听，我是在等着说我的下一句"),
        },
      ],
      emotions: [],
      topics: [
        mention(
          "tm_rec02_1",
          "沟通",
          "topic",
          "打断他",
          anchor(raw, "他说我总是在他讲事情的时候打断他"),
          { kind: "episode", containerId: ep },
        ),
      ],
      entityMentions: [
        entityMention("enm_rec02_1", "小林", "小林", anchor(raw, "小林"), { kind: "episode", containerId: ep }, "朋友"),
      ],
      suggestions: [
        {
          id: "sug_rec02_em",
          kind: "emotion_candidate",
          recordId: "rec_02",
          runId: "run_rec02_1",
          subjectTerm: "内疚",
          reasonCode: "inferred_emotion",
          displayNote: "「闭嘴了」之后那一段，模型读到了内疚 —— 但原文没写，所以它只能是个待确认的候选。",
          status: "pending",
          evidence: anchor(raw, "我第一反应是反驳，然后闭嘴了"),
        },
      ],
      redactionMap: {},
      evidenceRepairs: [],
      unrouted: [],
      productNotes: [
        "原文一个时间词都没有 ⇒ 事件时间只能是 unknown/unknown。**这是好设计**：模型不许自己补一个日期出来。你在界面上会看到「时间不明」，那是诚实，不是缺陷。",
      ],
    },
  };
}

/** rec_04：否定句式误判 + 「忽略」可找回。 */
function attachment04(): Attachment {
  const raw = R04;
  const ep = "ep_rec04_1";
  return {
    run: run("run_rec04_1", "rec_04", "rev_rec_04_1", "2026-09-30T19:33:41+08:00", CLOUD),
    output: {
      title: "做了三个星期的方案，十分钟被否",
      summary: "方案在评审上被否。散会后坐在会议室里的那种感觉，和小时候等成绩是同一种。",
      episodes: [
        {
          id: ep,
          summary: "方案在评审上被否",
          originType: "ai_generated",
          lifecycleStatus: "active",
          eventTimeRaw: null,
          eventTimePrecision: "unknown",
          eventTimeCertainty: "unknown",
          evidence: anchor(raw, "评审被否了"),
        },
      ],
      thoughts: [
        {
          id: "thought_rec04_1",
          text: "不是愤怒，更像是一种很熟悉的空洞 —— 小时候考完试在教室等成绩的那种。",
          originType: "ai_generated",
          lifecycleStatus: "active",
          evidence: anchor(raw, "更像是一种很熟悉的空洞 —— 小时候考完试在教室等成绩的那种"),
        },
      ],
      emotions: [
        mention("em_rec04_1", "失落", "emotion", "空洞", anchor(raw, "更像是一种很熟悉的空洞"), {
          kind: "episode",
          containerId: ep,
        }),
      ],
      topics: [
        mention("tm_rec04_1", "挫败", "topic", "被否", anchor(raw, "评审被否了"), {
          kind: "episode",
          containerId: ep,
        }),
      ],
      entityMentions: [],
      suggestions: [
        {
          id: "sug_rec04_em",
          kind: "emotion_candidate",
          recordId: "rec_04",
          runId: "run_rec04_1",
          subjectTerm: "愤怒",
          reasonCode: "inferred_emotion",
          displayNote:
            "模型从「不是愤怒」里读出了愤怒 —— 否定句式是情绪误判的高发区。**试试忽略它**：忽略后它不重复提出，但能在「已忽略」里找回。",
          status: "pending",
          evidence: anchor(raw, "不是愤怒"),
        },
      ],
      redactionMap: {},
      evidenceRepairs: [],
      unrouted: [],
      productNotes: [
        "这条故意留了一个**误判**：模型从「不是愤怒」读出愤怒。别急着把它当成 bug —— 真实模型会比这错得多。你要判断的是：界面上「忽略」这个动作放在哪、够不够顺手、忽略之后你还找不找得回来。",
      ],
    },
  };
}

/** rec_05：唯一有明确日期的一条；provisional 实体演示。 */
function attachment05(): Attachment {
  const raw = R05;
  const ep = "ep_rec05_1";
  const src = { kind: "episode", containerId: ep } as const;
  return {
    run: run("run_rec05_1", "rec_05", "rev_rec_05_1", "2026-10-02T09:48:20+08:00", LOCAL),
    output: {
      title: "西湖边听完了一整首《二泉映月》",
      summary: "清晨在西湖边站着听完一首拉的二胡，什么都没想 —— 半年里少有的半小时。",
      episodes: [
        {
          id: ep,
          summary: "清晨在西湖边站着听完一首二胡",
          originType: "ai_generated",
          lifecycleStatus: "active",
          // 原文写了「10月2日」→ 才是 day/explicit。全库只有这一条够得上。
          eventTimeRaw: "10月2日",
          eventTimePrecision: "day",
          eventTimeCertainty: "explicit",
          evidence: anchor(raw, "10月2日"),
        },
      ],
      thoughts: [
        {
          id: "thought_rec05_1",
          text: "我站在那儿听了整首。什么都没想。",
          originType: "ai_generated",
          lifecycleStatus: "active",
          evidence: anchor(raw, "我站在那儿听了整首。什么都没想"),
        },
      ],
      emotions: [
        mention("em_rec05_1", "平静", "emotion", "什么都没想", anchor(raw, "什么都没想"), src),
      ],
      topics: [mention("tm_rec05_1", "独处", "topic", "站在那儿听了整首", anchor(raw, "我站在那儿听了整首"), src)],
      entityMentions: [
        entityMention("enm_rec05_1", "杭州", "杭州", anchor(raw, "在杭州"), src, "location"),
        entityMention("enm_rec05_2", "西湖", "西湖", anchor(raw, "走到西湖边"), src, "location"),
        entityMention("enm_rec05_3", "二泉映月", "《二泉映月》", anchor(raw, "《二泉映月》"), src, "曲子"),
      ],
      suggestions: [],
      redactionMap: {},
      evidenceRepairs: [],
      unrouted: [],
      productNotes: [
        "实体「二泉映月」被判为 **provisional**。provisional 不进普通浏览列表、也**不生成 about 边** —— 所以你在图谱上根本看不到它，只在「待确认」里能把它转正。这是设计意图（§2.1(6)），不是丢数据。你要确认的是：转正的入口够不够好找？",
        "全库 14 条里只有这一条能算出「日」精度的事件时间。**如果抽取质量真实如此，时间轴类的界面（按时间回看）基本撑不起来。** 这条值得你专门判断：是真做不到（原文确实没写），还是契约把「早上/傍晚」这类表达给漏了？",
      ],
    },
  };
}

/** rec_06：另一条云路径记录，验一下不重复的形态。 */
function attachment06(): Attachment {
  const raw = R06;
  const ep = "ep_rec06_1";
  const src = { kind: "episode", containerId: ep } as const;
  return {
    run: run("run_rec06_1", "rec_06", "rev_rec_06_1", "2026-10-04T21:22:03+08:00", CLOUD),
    output: {
      title: "挂了电话之后有点难受",
      summary: "母亲又提起成家的事，我岔开了话题。难受的不是她问，是知道她只是想找个由头多聊两句。",
      episodes: [
        {
          id: ep,
          summary: "和母亲的一次通话",
          originType: "ai_generated",
          lifecycleStatus: "active",
          eventTimeRaw: null,
          eventTimePrecision: "unknown",
          eventTimeCertainty: "unknown",
          evidence: anchor(raw, "给我妈打电话"),
        },
      ],
      thoughts: [
        {
          id: "thought_rec06_1",
          text: "我难受的不是她问，是我知道她一个人在家，问这个只是因为想找个由头多聊两句。",
          originType: "ai_generated",
          lifecycleStatus: "active",
          evidence: anchor(raw, "我难受的不是她问，是我知道她一个人在家"),
        },
      ],
      emotions: [
        mention("em_rec06_1", "愧疚", "emotion", "难受", anchor(raw, "挂了之后有点难受"), src),
      ],
      topics: [
        mention("tm_rec06_1", "家庭", "topic", "成家的事", anchor(raw, "她又提起我该考虑成家的事"), src),
      ],
      entityMentions: [],
      suggestions: [],
      redactionMap: {},
      evidenceRepairs: [],
      unrouted: [],
      productNotes: [
        "这条隐私级别是 **sensitive**。请特别看一眼：「敏感」在界面上到底体现在哪里？（当前设计里它**没有**任何视觉表达 —— 只在记录详情的一行元信息里写着。这够不够，是你的判断。）",
      ],
    },
  };
}

/** rec_08：已在库里的整理结果 —— 供你体验「改原文 → 重跑 → 旧结果被取代」。 */
function attachment08(): Attachment {
  const raw = R08;
  return {
    run: run("run_rec08_1", "rec_08", "rev_rec_08_1", "2026-10-08T18:15:44+08:00", LOCAL),
    output: {
      title: "周会复盘：三件事",
      summary: "接口对齐、测试环境、方案讲解各有一处该改的地方。结论是先讲约束再讲做法。",
      // 一条记录里有三个独立经历 —— 各自证据独立，这是 §5.3 的硬要求。
      episodes: [
        {
          id: "ep_rec08_1",
          summary: "接口对齐拖了两天",
          originType: "ai_generated",
          lifecycleStatus: "active",
          eventTimeRaw: null,
          eventTimePrecision: "unknown",
          eventTimeCertainty: "unknown",
          evidence: anchor(raw, "接口对齐拖了两天是因为我一开始没把依赖讲清楚"),
        },
        {
          id: "ep_rec08_2",
          summary: "测试环境的事自己上了手",
          originType: "ai_generated",
          lifecycleStatus: "active",
          eventTimeRaw: null,
          eventTimePrecision: "unknown",
          eventTimeCertainty: "unknown",
          evidence: anchor(raw, "测试环境的事我不该自己去弄，应该直接找运维"),
        },
        {
          id: "ep_rec08_3",
          summary: "方案讲得太快",
          originType: "ai_generated",
          lifecycleStatus: "active",
          eventTimeRaw: null,
          eventTimePrecision: "unknown",
          eventTimeCertainty: "unknown",
          evidence: anchor(raw, "最后那个方案我讲得太快了"),
        },
      ],
      thoughts: [
        {
          id: "thought_rec08_1",
          text: "下次讲方案，先讲约束再讲做法。",
          originType: "ai_generated",
          lifecycleStatus: "active",
          evidence: anchor(raw, "下次讲方案，先讲约束再讲做法"),
        },
      ],
      emotions: [
        // 〔UI-5〕整份 fixture 里唯一一条 **inferred** 的提及：它必须先是一条 `emotion_candidate`
        // 建议、经你确认，才有资格成为提及（basis_origin_matrix 是硬的）。
        // 情绪盒子那一页要区分「原话说出口」与「模型推断（你确认过）」，靠的就是这一条。
        mention(
          "em_rec08_1",
          "内疚",
          "emotion",
          "不该自己去弄",
          anchor(raw, "测试环境的事我不该自己去弄"),
          { kind: "episode", containerId: "ep_rec08_2" },
          { basis: "inferred", origin: "user_confirmed_suggestion" },
        ),
      ],
      topics: [
        mention("tm_rec08_1", "复盘", "topic", "周会复盘", anchor(raw, "周会复盘"), {
          kind: "episode",
          containerId: "ep_rec08_1",
        }),
        // 〔UI-5〕来源是 thought_item 的标签：念头盒子那一页的「挂着标签的」分组要有内容，
        // 而「念头上挂的标签不上图」这件事也得有一条样本可看。
        mention(
          "tm_rec08_2",
          "边界感",
          "topic",
          "应该直接找运维",
          anchor(raw, "应该直接找运维"),
          { kind: "thought_item", containerId: "thought_rec08_1" },
        ),
      ],
      entityMentions: [],
      suggestions: [
        {
          id: "sug_rec08_em",
          kind: "emotion_candidate",
          recordId: "rec_08",
          runId: "run_rec08_1",
          subjectTerm: "内疚",
          reasonCode: "inferred_emotion",
          status: "accepted",
          evidence: anchor(raw, "测试环境的事我不该自己去弄"),
          displayNote:
            "你确认过它 —— 于是它成为上面那条**推断来的**提及（basis=推断、origin=你确认过的建议）。" +
            "模型自己没有落库的权限，这是它唯一的入场券。",
        },
        {
          id: "sug_rec08_alias",
          kind: "alias",
          recordId: "rec_08",
          runId: "run_rec08_1",
          subjectTerm: "演示·蓝鲸",
          reasonCode: "unknown_label_alias_candidate",
          status: "ignored",
          evidence: anchor(raw, "应该直接找运维"),
          displayNote:
            "模型猜「演示·蓝鲸」是「运维」的别名 —— 它猜错了，你判了不对。" +
            "**忽略不是删除**：它留在「已忽略」里，随时能找回。" +
            "（词面是故意起的假名，不让 fixture 里出现像真人、真产品的名字。）",
        },
        {
          id: "sug_rec08_repair",
          kind: "evidence_repair",
          recordId: "rec_08",
          runId: "run_rec08_1",
          subjectTerm: "ep_rec08_3",
          reasonCode: "evidence_unanchored",
          status: "withdrawn",
          evidence: null,
          displayNote:
            "那次整理的输入后来换过一版，这条「证据对不上」已经没有对象可对 —— " +
            "**撤回不是你表过态，是依据消失了**。这两种状态必须分开显示，否则你会以为自己是撤回过一条误判。",
        },
      ],
      redactionMap: {},
      evidenceRepairs: [],
      unrouted: [],
      productNotes: [
        "这一条是**已经整理好**的。请拿它试整条链：编辑原文 → 状态变「原文已改，待重新整理」（**不会自动重跑**，ADR-007）→ 手动重跑 → 旧结果变成 superseded 但仍可查看。",
        "它也是「一条记录三个经历」的样本。注意三个 Episode 的证据各自独立 —— 界面上要能看出「这条标签属于哪个经历」。",
        "〔UI-5〕它还兼任「**建议的四种状态各长什么样**」的样本：一条已采纳（它变成了 inferred 提及）、一条已忽略（能找回）、一条已撤回（依据没了，不是表态）。「等你表态」那一档在 rec_01 / rec_02 / rec_04 上。",
      ],
    },
  };
}

/** rec_10：无 Episode；且提及来源是 RecordRevision ⇒ 不上图。 */
function attachment10(): Attachment {
  const raw = R10;
  // 来源是 RecordRevision —— 这一条是整份原型里最容易被误读的地方，见 productNotes。
  const src = { kind: "record_revision", containerId: "rev_rec_10_1" } as const;
  return {
    run: run("run_rec10_1", "rec_10", "rev_rec_10_1", "2026-10-10T07:35:12+08:00", LOCAL),
    output: {
      title: "连续第四天睡不够六小时",
      summary: "身体上的疲惫明显，但真正的问题不是没时间睡，是躺下之后脑子停不下来。",
      // 没有 Episode —— 原文里没有「发生了什么」，只有状态和判断。
      // 契约允许这样：没有明确经历的记录，情绪与主题仍然保留。
      episodes: [],
      thoughts: [
        {
          id: "thought_rec10_1",
          text: "不是没时间睡，是躺下之后脑子自动开始放白天没处理完的事。",
          originType: "ai_generated",
          lifecycleStatus: "active",
          evidence: anchor(raw, "是躺下之后脑子自动开始放白天没处理完的事"),
        },
      ],
      emotions: [mention("em_rec10_1", "疲惫", "emotion", "眼睛干", anchor(raw, "眼睛干"), src)],
      topics: [
        mention("tm_rec10_1", "睡眠", "topic", "睡不够六小时", anchor(raw, "连续第四天睡不够六小时"), src),
      ],
      entityMentions: [],
      suggestions: [],
      redactionMap: {},
      evidenceRepairs: [],
      unrouted: [],
      productNotes: [
        "这条**没有 Episode**（原文里没有「发生了什么」），但情绪和主题还在。而且它们的来源是**记录本身**而不是某个经历 —— 按 §3.2.4，这类提及**不生成图谱边、也不生成影子节点**。",
        "所以：你在「情绪盒子」里能看到「疲惫」，但在图谱上找不到它连到哪。**这是对的**。你要判断的是 —— 这件事在界面上讲清楚了吗？用户会不会以为数据丢了？",
      ],
    },
  };
}

/** rec_11：证据回锚失败 → 逐条分流，不整批失败。 */
function attachment11(): Attachment {
  const raw = R11;
  const ep = "ep_rec11_1";
  const src = { kind: "episode", containerId: ep } as const;
  // 故意引错一个引号：模型给的是直引号，原文用的是「」。
  const badEvidence = anchor(raw, "我一直在等一个'想清楚了'的时刻");
  return {
    run: run("run_rec11_1", "rec_11", "rev_rec_11_1", "2026-10-11T20:54:31+08:00", CLOUD),
    output: {
      title: "在等一个「想清楚了」的时刻",
      summary: "两个选择各有代价。一直在等一个想清楚的时刻，但好像它不会来。",
      episodes: [
        {
          id: ep,
          summary: "在两个选择之间",
          originType: "ai_generated",
          lifecycleStatus: "active",
          eventTimeRaw: null,
          eventTimePrecision: "unknown",
          eventTimeCertainty: "unknown",
          evidence: anchor(raw, "两个选择摆在这儿"),
        },
      ],
      thoughts: [
        {
          id: "thought_rec11_1",
          text: "我一直在等一个「想清楚了」的时刻，但好像它不会来。",
          originType: "ai_generated",
          lifecycleStatus: "active",
          evidence: anchor(raw, "我一直在等一个「想清楚了」的时刻，但好像它不会来"),
        },
      ],
      emotions: [],
      topics: [mention("tm_rec11_1", "选择", "topic", "两个选择", anchor(raw, "两个选择摆在这儿"), src)],
      entityMentions: [],
      suggestions: [
        {
          id: "sug_rec11_repair",
          kind: "evidence_repair",
          recordId: "rec_11",
          runId: "run_rec11_1",
          subjectTerm: "迷茫",
          reasonCode: "evidence_not_found",
          displayNote:
            "模型给的证据是「我一直在等一个'想清楚了'的时刻」，原文用的是「」而不是 ''，**回锚不到**。按 §7.6.4 逐条分流：这一条不成为有效提及，其余照常写入。",
          status: "pending",
          evidence: badEvidence,
        },
      ],
      redactionMap: {},
      evidenceRepairs: ["迷茫（证据回锚失败：evidence_not_found）"],
      unrouted: [],
      productNotes: [
        "这条演的是**部分失败**：一条标签的证据对不上，其余照常落库 —— 不是整批作废。未通过的那条会以「待处理」形态停在这里，等你处理。",
        "请判断：一个引号之差就丢掉一条标签，这个代价你接受吗？还是宁可放宽匹配、把可疑项标出来让你自己看？",
      ],
    },
  };
}

/** rec_07：失败态（原文完好，错误类别可读，有重试入口）。 */
function attachment07(): Attachment {
  return {
    run: run(
      "run_rec07_1",
      "rec_07",
      "rev_rec_07_1",
      "2026-10-06T16:58:02+08:00",
      LOCAL,
      "candidate",
      "failed",
      "timeout",
    ),
    output: {
      title: "",
      summary: "",
      episodes: [],
      thoughts: [],
      emotions: [],
      topics: [],
      entityMentions: [],
      suggestions: [],
      redactionMap: {},
      evidenceRepairs: [],
      unrouted: [],
      productNotes: [
        "**失败不等于丢原文。** 这条记录整理失败（本地模型超时），但原文完好，状态显示可读的错误类别，并且有重试入口。M2 验收里这是硬断言。",
      ],
    },
  };
}

/* ── 二轮扩充的解析产出（rec_15…rec_26） ─────────────────────────── */

function attachment15(): Attachment {
  const raw = R15;
  const ep = "ep_rec15_1";
  const src = { kind: "episode", containerId: ep } as const;
  return {
    run: run("run_rec15_1", "rec_15", "rev_rec_15_1", "2026-09-23T18:46:10+08:00", LOCAL),
    output: {
      title: "看到那片淡橘色的天，忽然松了",
      summary: "傍晚从公司出来，一直绷着，看到晚霞的一刻松了下来，没有原因。",
      episodes: [
        episode(ep, "傍晚出公司看到晚霞，忽然松了", anchor(raw, "看到那片天忽然松了"), {
          raw: "傍晚",
          precision: "time_of_day",
          certainty: "explicit",
        }),
      ],
      thoughts: [thought("thought_rec15_1", "没什么理由。就是松了。", anchor(raw, "没什么理由。就是松了"))],
      emotions: [mention("em_rec15_1", "释然", "emotion", "松了", anchor(raw, "忽然松了"), src)],
      topics: [mention("tm_rec15_1", "工作", "topic", "公司", anchor(raw, "从公司出来"), src)],
      entityMentions: [entityMention("enm_rec15_1", "公司", "公司", anchor(raw, "从公司出来"), src, "location")],
      suggestions: [],
      redactionMap: {},
      evidenceRepairs: [],
      unrouted: [],
      productNotes: [
        "**这是 `time_of_day` 实验档的第一个样本。** 原文写的是「傍晚」，它不到「日」的精度 —— 按现行契约只能落 unknown，等于把「傍晚」这个信息丢了。这里先让它落进实验档，你看这条经历在界面上是否变得更有用。",
      ],
    },
  };
}

function attachment16(): Attachment {
  const raw = R16;
  const ep = "ep_rec16_1";
  const thoughtId = "thought_rec16_1";
  return {
    run: run("run_rec16_1", "rec_16", "rev_rec_16_1", "2026-09-26T02:19:44+08:00", LOCAL),
    output: {
      title: "他是不是觉得我不行",
      summary: "深夜睡不着，把白天的一句话反复咀嚼成了对自己的否定。",
      episodes: [
        episode(ep, "深夜醒着，反复想白天会上的一句话", anchor(raw, "深夜两点还醒着"), {
          raw: "深夜",
          precision: "time_of_day",
          certainty: "explicit",
        }),
      ],
      thoughts: [thought(thoughtId, "我知道这是过度解读，但知道归知道。", anchor(raw, "我知道这是过度解读，但知道归知道"))],
      emotions: [
        mention("em_rec16_1", "焦虑", "emotion", "转来转去", anchor(raw, "转来转去"), { kind: "episode", containerId: ep }),
        // 来源是**念头**、不是经历 —— 按 §3.2.4 不生成图谱边。情绪盒子里看得到，图上找不到。
        mention("em_rec16_2", "烦躁", "emotion", "知道自己过度解读", anchor(raw, "知道归知道"), {
          kind: "thought_item",
          containerId: thoughtId,
        }),
      ],
      topics: [
        mention("tm_rec16_1", "睡眠", "topic", "两点还醒着", anchor(raw, "深夜两点还醒着"), { kind: "episode", containerId: ep }),
        mention("tm_rec16_2", "自我怀疑", "topic", "是不是觉得我不行", anchor(raw, "他是不是觉得我不行"), {
          kind: "episode",
          containerId: ep,
        }),
      ],
      entityMentions: [entityMention("enm_rec16_1", "小林", "小林", anchor(raw, "小林说的一句话"), { kind: "episode", containerId: ep }, "朋友")],
      suggestions: [],
      redactionMap: {},
      evidenceRepairs: [],
      unrouted: [],
      productNotes: [
        "「烦躁」的**来源是念头而不是经历**。所以它进了「情绪盒子」，却永远不会出现在图谱上 —— 这一对（看得到 / 找不到）是这一页最该对齐的地方。",
      ],
    },
  };
}

function attachment17(): Attachment {
  const raw = R17;
  const ep = "ep_rec17_1";
  const src = { kind: "episode", containerId: ep } as const;
  return {
    run: run("run_rec17_1", "rec_17", "rev_rec_17_1", "2026-09-28T20:24:30+08:00", LOCAL),
    output: {
      title: "你不是怕做不好，是怕不够好到没人挑得出毛病",
      summary: "跟老周聊了半小时，被他一句话说中，愣在那里。",
      episodes: [episode(ep, "跟老周聊了半小时，被一句话点醒", anchor(raw, "跟老周聊了半小时"))],
      thoughts: [
        thought("thought_rec17_1", "你不是怕做不好，你是怕做得不够好到没人挑得出毛病。", anchor(raw, "你是怕做得不够好到没人挑得出毛病")),
      ],
      emotions: [
        mention("em_rec17_1", "释然", "emotion", "愣了一下", anchor(raw, "我愣了一下"), src),
        mention("em_rec17_2", "感激", "emotion", "被说中", anchor(raw, "因为他说的对"), src),
      ],
      topics: [
        mention("tm_rec17_1", "工作", "topic", "项目", anchor(raw, "跟老周聊了半小时"), src),
        mention("tm_rec17_2", "沟通", "topic", "被他点醒", anchor(raw, "他说"), src),
      ],
      entityMentions: [entityMention("enm_rec17_1", "老周", "老周", anchor(raw, "老周"), src, "同事")],
      suggestions: [
        {
          id: "sug_rec17_same",
          kind: "possibly_same_as",
          recordId: "rec_17",
          runId: "run_rec17_1",
          subjectTerm: "entity_老周",
          reasonCode: "alias_guess",
          displayNote: "别处出现过一个「周工」，模型猜是同一个老周。**合并要你确认** —— 合并可撤销（ADR-010），但历史提及怎么迁移是你要先想清楚的。",
          status: "pending",
          evidence: anchor(raw, "老周"),
        },
      ],
      redactionMap: {},
      evidenceRepairs: [],
      unrouted: [],
      productNotes: [
        "「possibly_same_as」（疑似同一实体）的入口。**这是全库里最容易做重的一次操作**：合并之后历史提及归到哪个 ID、撤销时要还原到什么程度，界面上现在完全没有交代。",
      ],
    },
  };
}

function attachment18(): Attachment {
  const raw = R18;
  const ep = "ep_rec18_1";
  const src = { kind: "episode", containerId: ep } as const;
  return {
    run: run("run_rec18_1", "rec_18", "rev_rec_18_1", "2026-10-01T09:13:20+08:00", LOCAL),
    output: {
      title: "开会前那十分钟，我整个人是缩着的",
      summary: "早会前手心发湿、嗓子发紧；讲完之后发现其实没那么糟。",
      episodes: [
        episode(ep, "早会前紧张到嗓子发紧", anchor(raw, "早上开会前，手心是湿的"), {
          raw: "早上",
          precision: "time_of_day",
          certainty: "explicit",
        }),
      ],
      thoughts: [thought("thought_rec18_1", "讲完之后其实没那么糟。", anchor(raw, "讲完之后其实没那么糟"))],
      emotions: [
        mention("em_rec18_1", "紧张", "emotion", "手心是湿的", anchor(raw, "手心是湿的"), src),
        mention("em_rec18_2", "焦虑", "emotion", "嗓子发紧", anchor(raw, "嗓子发紧"), src),
      ],
      topics: [mention("tm_rec18_1", "工作", "topic", "开会", anchor(raw, "早上开会前"), src)],
      entityMentions: [],
      suggestions: [],
      redactionMap: {},
      evidenceRepairs: [],
      unrouted: [],
      productNotes: [
        "同一条经历挂两个情绪（紧张 + 焦虑）—— 情绪盒子的频次就是靠这类「一条多标签」堆出来的。",
      ],
    },
  };
}

function attachment19(): Attachment {
  const raw = R19;
  const ep = "ep_rec19_1";
  const src = { kind: "episode", containerId: ep } as const;
  return {
    run: run("run_rec19_1", "rec_19", "rev_rec_19_1", "2026-10-05T21:41:02+08:00", LOCAL),
    output: {
      title: "我记着呢",
      summary: "妈妈生日打了个电话，她的第一句是「有事吗」，最后一句是「不用记着我生日」。",
      episodes: [episode(ep, "妈妈生日的一个电话", anchor(raw, "今天是我妈生日"))],
      thoughts: [thought("thought_rec19_1", "我记着呢。", anchor(raw, "我记着呢。"))],
      emotions: [
        mention("em_rec19_1", "愧疚", "emotion", "愣了一下", anchor(raw, "她沉默了一下"), src),
        mention("em_rec19_2", "温暖", "emotion", "一直在说家里的事", anchor(raw, "开始说家里的事"), src),
      ],
      topics: [
        mention("tm_rec19_1", "亲情", "topic", "我妈生日", anchor(raw, "今天是我妈生日"), src),
        mention("tm_rec19_2", "家庭", "topic", "家里的事", anchor(raw, "开始说家里的事"), src),
      ],
      entityMentions: [
        entityMention("enm_rec19_1", "妈妈", "我妈", anchor(raw, "今天是我妈生日"), src, "家人"),
        // 「生日」是新增的「事件」类：它和「人物」并列出现，正好用来看这一页混排好不好读。
        entityMention("enm_rec19_2", "生日", "生日", anchor(raw, "今天是我妈生日"), src, null),
      ],
      suggestions: [
        {
          id: "sug_rec19_rel",
          kind: "possibly_related",
          recordId: "rec_19",
          runId: "run_rec19_1",
          subjectTerm: "ep_rec06_1",
          reasonCode: "shared_topic",
          displayNote: "和 10月4日「和母亲的一次通话」是同一类事（都是「她只想多聊两句」）。接受后会在两个经历之间连一条边。",
          status: "pending",
          evidence: null,
        },
      ],
      redactionMap: {},
      evidenceRepairs: [],
      unrouted: [],
      productNotes: [
        "「possibly_related」指向的是另一条**经历**（不是概念）。所以图上连接的可能是两个经历节点 —— 这正是「经历也是图谱节点」这件事最容易被忽略的地方。",
      ],
    },
  };
}

function attachment20(): Attachment {
  const raw = R20;
  const ep = "ep_rec20_1";
  const src = { kind: "episode", containerId: ep } as const;
  return {
    run: run("run_rec20_1", "rec_20", "rev_rec_20_1", "2026-10-03T11:09:55+08:00", LOCAL),
    output: {
      title: "走到拐角回头，她还在那儿",
      summary: "10月3日回老家看奶奶，比上次瘦了；临走时她一直站在门口挥手。",
      episodes: [
        episode(ep, "回老家看奶奶", anchor(raw, "回老家看奶奶"), {
          raw: "10月3日",
          precision: "day",
          certainty: "explicit",
        }),
      ],
      thoughts: [thought("thought_rec20_1", "我走到拐角回头，她还在那儿。", anchor(raw, "我走到拐角回头，她还在那儿"))],
      emotions: [
        mention("em_rec20_1", "平静", "emotion", "精神还好", anchor(raw, "精神还好"), src),
        mention("em_rec20_2", "悲伤", "emotion", "比上次瘦了", anchor(raw, "她比上次瘦了"), src),
      ],
      topics: [mention("tm_rec20_1", "亲情", "topic", "看奶奶", anchor(raw, "回老家看奶奶"), src)],
      entityMentions: [entityMention("enm_rec20_1", "老家", "老家", anchor(raw, "回老家"), src, "location")],
      suggestions: [],
      redactionMap: {},
      evidenceRepairs: [],
      unrouted: [],
      productNotes: [
        "全库**少数几条够得上「日」精度**的经历之一（原文写了「10月3日」）。数一下：38 条记录里，能算出「日」的仍然屈指可数 —— 经历盒子的时间轴撑不撑得起来，这一页看得很直接。",
      ],
    },
  };
}

function attachment21(): Attachment {
  const raw = R21;
  const ep1 = "ep_rec21_1";
  const ep2 = "ep_rec21_2";
  return {
    run: run("run_rec21_1", "rec_21", "rev_rec_21_1", "2026-10-07T22:48:39+08:00", LOCAL),
    output: {
      title: "笑了两分钟，然后空得厉害",
      summary: "项目上线成功，短暂的兴奋之后是一种空。晚上回家跑图跑了很久。",
      episodes: [
        episode(ep1, "项目上线成功", anchor(raw, "项目上线了，成了")),
        episode(ep2, "晚上回家跑图《塞尔达传说》", anchor(raw, "打了会儿《塞尔达传说》")),
      ],
      thoughts: [thought("thought_rec21_1", "我跟着笑了两分钟，然后忽然空得厉害。", anchor(raw, "我跟着笑了两分钟，然后坐下来，忽然空得厉害"))],
      emotions: [
        mention("em_rec21_1", "兴奋", "emotion", "群里刷了一屏", anchor(raw, "群里刷了一屏"), { kind: "episode", containerId: ep1 }),
        mention("em_rec21_2", "失落", "emotion", "空得厉害", anchor(raw, "忽然空得厉害"), { kind: "episode", containerId: ep1 }),
      ],
      topics: [mention("tm_rec21_1", "工作", "topic", "项目上线", anchor(raw, "项目上线了"), { kind: "episode", containerId: ep1 })],
      entityMentions: [
        entityMention("enm_rec21_1", "塞尔达传说", "《塞尔达传说》", anchor(raw, "《塞尔达传说》"), { kind: "episode", containerId: ep2 }, "游戏"),
      ],
      suggestions: [],
      redactionMap: {},
      evidenceRepairs: [],
      unrouted: [],
      productNotes: [
        "第二个 **provisional** 实体（《塞尔达传说》，游戏）。它在「人物与事物」的默认列表里看不到、图上也看不到 —— 只在「待确认」里能转正。两个 provisional 放在一起，才看得出「转正入口够不够显眼」这个问题是不是真问题。",
      ],
    },
  };
}

function attachment22(): Attachment {
  const raw = R22;
  const ep = "ep_rec22_1";
  const src = { kind: "episode", containerId: ep } as const;
  return {
    run: run("run_rec22_1", "rec_22", "rev_rec_22_1", "2026-10-09T15:28:11+08:00", LOCAL),
    output: {
      title: "那个笑让我自己都别扭",
      summary: "会上被阿May当众指出数算错了。错在自己，但难受的是自己下意识用笑掩饰。",
      episodes: [episode(ep, "会上被当众指出数算错了", anchor(raw, "阿May当着所有人指出我那个数算错了"))],
      thoughts: [thought("thought_rec22_1", "那个笑让我自己都别扭。", anchor(raw, "那个笑让我自己都别扭"))],
      emotions: [
        mention("em_rec22_1", "尴尬", "emotion", "别扭", anchor(raw, "那个笑让我自己都别扭"), src),
        mention("em_rec22_2", "委屈", "emotion", "下意识笑着说哦对", anchor(raw, "我下意识笑着说「哦对，我看看」"), src),
      ],
      topics: [
        mention("tm_rec22_1", "工作", "topic", "会上", anchor(raw, "会上"), src),
        mention("tm_rec22_2", "边界感", "topic", "当着所有人", anchor(raw, "当着所有人指出"), src),
      ],
      entityMentions: [entityMention("enm_rec22_1", "阿May", "阿May", anchor(raw, "阿May"), src, "同事")],
      suggestions: [
        {
          id: "sug_rec22_new",
          kind: "new_concept",
          recordId: "rec_22",
          runId: "run_rec22_1",
          subjectTerm: "职场边界",
          reasonCode: "unknown_label",
          displayNote: "词表里没有「职场边界」这个主题。模型没有建主题的权限，只能提出来等你决定要不要收。",
          status: "pending",
          evidence: anchor(raw, "当着所有人"),
        },
      ],
      redactionMap: {},
      evidenceRepairs: [],
      unrouted: [],
      productNotes: [
        "「new_concept」候选。它被采纳之后才会出现在「主题浏览」里 —— 采纳入口在「待确认」。判断一下：从主题浏览页出发，用户能不能自己发现「我还有个新主题没决定」？",
      ],
    },
  };
}

function attachment23(): Attachment {
  const raw = R23;
  const ep = "ep_rec23_1";
  const src = { kind: "episode", containerId: ep } as const;
  return {
    run: run("run_rec23_1", "rec_23", "rev_rec_23_1", "2026-10-10T12:41:20+08:00", LOCAL),
    output: {
      title: "我忽然很想有人跟我说句话",
      summary: "中午一个人吃面，周围都是三三两两的人。",
      episodes: [episode(ep, "中午一个人在楼下吃面", anchor(raw, "中午一个人去楼下吃面"))],
      thoughts: [thought("thought_rec23_1", "就一句也行。", anchor(raw, "就一句也行。"))],
      emotions: [mention("em_rec23_1", "孤独", "emotion", "很想有人跟我说句话", anchor(raw, "我忽然很想有人跟我说句话"), src)],
      topics: [mention("tm_rec23_1", "独处", "topic", "一个人吃面", anchor(raw, "一个人去楼下吃面"), src)],
      entityMentions: [],
      suggestions: [],
      redactionMap: {},
      evidenceRepairs: [],
      unrouted: [],
      productNotes: ["「孤独」只出现这一条时，情绪盒子里它就是「低频」的那一类 —— 排序策略（按频次还是按时间）在这一页看得出来差别。"],
    },
  };
}

function attachment24(): Attachment {
  const raw = R24;
  const ep = "ep_rec24_1";
  const src = { kind: "episode", containerId: ep } as const;
  return {
    run: run("run_rec24_1", "rec_24", "rev_rec_24_1", "2026-10-11T19:02:14+08:00", LOCAL),
    output: {
      title: "我不是想不通，是一直没停下来",
      summary: "傍晚去江边跑步，跑到第三公里忽然不喘了，脑子里的事也跟着慢下来。",
      episodes: [
        episode(ep, "傍晚去江边跑步，第三公里想通了", anchor(raw, "傍晚去江边跑"), {
          raw: "傍晚",
          precision: "time_of_day",
          certainty: "explicit",
        }),
      ],
      thoughts: [thought("thought_rec24_1", "原来我不是想不通，是一直没停下来。", anchor(raw, "原来我不是想不通，是一直没停下来"))],
      emotions: [mention("em_rec24_1", "释然", "emotion", "不那么喘了", anchor(raw, "忽然不那么喘了"), src)],
      topics: [
        mention("tm_rec24_1", "健康", "topic", "跑步", anchor(raw, "去江边跑"), src),
        mention("tm_rec24_2", "独处", "topic", "一个人跑", anchor(raw, "去江边跑"), src),
      ],
      entityMentions: [
        // 「跑步」是新增的「活动」类 —— 它反复出现、值得单独记一笔，和人物是一回事。
        entityMention("enm_rec24_1", "跑步", "跑步", anchor(raw, "去江边跑"), src, null),
      ],
      suggestions: [],
      redactionMap: {},
      evidenceRepairs: [],
      unrouted: [],
      productNotes: [
        "第二条 `time_of_day`（「傍晚」）。两条实验样本放在一起，才看得出「时段」这一档在经历列表里到底有没有用。",
      ],
    },
  };
}

function attachment25(): Attachment {
  const raw = R25;
  const ep = "ep_rec25_1";
  const src = { kind: "episode", containerId: ep } as const;
  return {
    run: run("run_rec25_1", "rec_25", "rev_rec_25_1", "2026-10-12T07:20:31+08:00", LOCAL),
    output: {
      title: "这种早上不多，记一下",
      summary: "醒得比闹钟早，躺着听鸟叫，心里是轻的。",
      episodes: [
        episode(ep, "醒得比闹钟早，听窗外的鸟叫", anchor(raw, "早上醒得比闹钟早"), {
          raw: "早上",
          precision: "time_of_day",
          certainty: "explicit",
        }),
      ],
      thoughts: [thought("thought_rec25_1", "这种早上不多。记一下。", anchor(raw, "这种早上不多。记一下。"))],
      emotions: [
        mention("em_rec25_1", "高兴", "emotion", "心里是轻的", anchor(raw, "心里是轻的"), src),
        mention("em_rec25_2", "满足", "emotion", "躺着听鸟叫", anchor(raw, "躺着听窗外的鸟叫"), src),
      ],
      topics: [],
      entityMentions: [],
      suggestions: [],
      redactionMap: {},
      evidenceRepairs: [],
      unrouted: [],
      productNotes: ["这条**没有主题**，只有情绪 —— 界面上要能接受「一个只有情绪的经历」，不要为了凑字段硬塞一个主题。"],
    },
  };
}

function attachment26(): Attachment {
  const raw = R26;
  const ep = "ep_rec26_1";
  const src = { kind: "episode", containerId: ep } as const;
  return {
    run: run("run_rec26_1", "rec_26", "rev_rec_26_1", "2026-10-13T23:48:55+08:00", LOCAL),
    output: {
      title: "骂也没用，明天大概还是一样",
      summary: "一整天什么都没干成，晚上开始自责。",
      episodes: [episode(ep, "一整天什么都没干成", anchor(raw, "一整天什么都没干成"))],
      thoughts: [thought("thought_rec26_1", "我知道骂也没用，明天大概还是一样。", anchor(raw, "我知道骂也没用，明天大概还是一样"))],
      emotions: [
        mention("em_rec26_1", "内疚", "emotion", "开始骂自己", anchor(raw, "到了晚上开始骂自己"), src),
        mention("em_rec26_2", "无力", "emotion", "明天大概还是一样", anchor(raw, "明天大概还是一样"), src),
      ],
      topics: [
        mention("tm_rec26_1", "拖延", "topic", "什么都没干成", anchor(raw, "一整天什么都没干成"), src),
        mention("tm_rec26_2", "自我怀疑", "topic", "骂也没用", anchor(raw, "我知道骂也没用"), src),
      ],
      entityMentions: [],
      suggestions: [
        {
          id: "sug_rec26_em",
          kind: "emotion_candidate",
          recordId: "rec_26",
          runId: "run_rec26_1",
          subjectTerm: "焦虑",
          reasonCode: "inferred_emotion",
          displayNote: "模型从「刷手机、看时间、又刷手机」的循环推断出底层的焦虑 —— 原文没写，所以只能是候选。",
          status: "pending",
          evidence: anchor(raw, "刷手机、看时间、又刷手机"),
        },
      ],
      redactionMap: {},
      evidenceRepairs: [],
      unrouted: [],
      productNotes: ["「内疚 + 无力」经常一起出现。情绪盒子按单个情绪排序时，这种「成对出现」的模式完全看不见 —— 要不要支持「常见组合」？"],
    },
  };
}

export function makeSeedAttachments(): Record<string, Attachment[]> {
  const byRecord: Record<string, Attachment[]> = {};
  const put = (recordId: string, a: Attachment): void => {
    byRecord[recordId] = [...(byRecord[recordId] ?? []), a];
  };
  put("rec_01", attachment01());
  put("rec_02", attachment02());
  put("rec_04", attachment04());
  put("rec_05", attachment05());
  put("rec_06", attachment06());
  put("rec_08", attachment08());
  // rec_07 的失败 run 也进历史 —— 失败是历史的一部分，不该被抹掉
  put("rec_07", attachment07());
  put("rec_10", attachment10());
  put("rec_11", attachment11());
  // 二轮扩充
  put("rec_15", attachment15());
  put("rec_16", attachment16());
  put("rec_17", attachment17());
  put("rec_18", attachment18());
  put("rec_19", attachment19());
  put("rec_20", attachment20());
  put("rec_21", attachment21());
  put("rec_22", attachment22());
  put("rec_23", attachment23());
  put("rec_24", attachment24());
  put("rec_25", attachment25());
  put("rec_26", attachment26());
  return byRecord;
}

/** 新记录被解析时用的兜底产出（不必为每条手写一份完整结果）。 */
export function genericOutput(recordId: string, title: string, summary: string): RunOutput {
  return {
    title,
    summary,
    episodes: [],
    thoughts: [],
    emotions: [],
    topics: [],
    entityMentions: [],
    suggestions: [],
    redactionMap: {},
    evidenceRepairs: [],
    unrouted: [],
    productNotes: [
      `rec_${recordId}：这条是你在原型里现场记下的，模型产出用占位结果代替 —— 原型不假装自己会整理。`,
    ],
  };
}

export { RAW };
