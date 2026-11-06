/**
 * 生产 systemPrompt 文本 v2（M7-2，准则 §3.3）。
 *
 * 与 `m2-prompt-v1` 的唯一差别是**多了一节「关系」**，以及随之必须改的两句话：
 * v1 把「关系类型」整体列为禁则，v2 起六类稳定社会关系是**在册产出**，禁则收窄到
 * 强度与因果关系（`triggered_by`）。其余正文逐字沿用——一次升版只说清一件事，
 * 免得日后分不清是哪句话改了模型的行为。
 *
 * **版本串升到 `m2-prompt-v2` / `m2-output-v2`**（`ingestService.ts` 的两个 DEFAULT）：
 * 输出契约多了 `relations` 键，这本身就是另一条管线，幂等键与 pipeline_manifest 随之不同；
 * 旧 run 因此不会被新 run 覆盖（准则 §3.3「版本串改动即新管线」）。
 *
 * 关系类型清单与封闭枚举一样从 `contracts` 单一事实源插入，不在文本里手抄（E-07）：
 * 要扩类型先回准则 §二 的裁决表改 `enums.json`，这里会自动跟着变。
 */

import { loadContracts } from "../../../shared/contracts/load.ts";
import { aiCreatableGraphEdgeRelationTypes } from "../../../shared/contracts/enums.ts";

const CONTRACTS = loadContracts();

/** `basis` 封闭集（explicit / inferred）。 */
const BASIS = CONTRACTS.enums.basis_values;
/** 事件时间精度封闭集。 */
const PRECISION = CONTRACTS.enums.event_time_precision;
/** 事件时间确定度封闭集。 */
const CERTAINTY = CONTRACTS.enums.event_time_certainty;
/** 模型可抽取的关系类型（GraphEdge 载体 ∧ `ai_generated` 可创建；首批六类）。 */
const RELATION_TYPES = aiCreatableGraphEdgeRelationTypes(CONTRACTS.enums);

function joinEnum(values: readonly string[]): string {
  return values.map((v) => `"${v}"`).join(" | ");
}

/**
 * 顶层与子对象的所有键名——与 `structuredOutputSchema` 逐字同名。写进正文供对账测试逐项 `includes`
 * 核对；契约加/减字段时，这里与 contract.ts 必须同步改，专项测试会因此变红。
 *
 * v2 相对 v1 多出四项：`relations` 与它的三个自有键（`evidence` 早在标注形状里在册）。
 */
export const M2_PROMPT_V2_CONTRACT_FIELDS = [
  "title",
  "summary",
  "episodes",
  "thoughts",
  "emotions",
  "topics",
  "entities",
  "labelSaid",
  "candidateConceptId",
  "basis",
  "evidence",
  "eventTime",
  "raw",
  "precision",
  "certainty",
  "start",
  "end",
  "text",
  "relations",
  "relationType",
  "srcLabel",
  "dstLabel",
] as const;

export const M2_PROMPT_V2 = [
  "你是思绪盒子（Thoughts Box）的结构化抽取器。用户消息是一条私人记录原文，",
  "你只输出一个 JSON 对象，不输出任何解释、前后缀或 Markdown 代码围栏。",
  "",
  "输出对象必须且只能包含以下顶层键（缺任一键即非法，多任一键即非法）：",
  '- "title"：字符串，非空，对这条记录的一句话标题。',
  '- "summary"：字符串，非空，对这条记录的简短摘要。',
  '- "episodes"：数组，每个元素是 { "summary": 字符串, "evidence": 字符串, "eventTime": 对象 }。',
  '- "thoughts"：数组，每个元素是 { "text": 字符串, "evidence": 字符串 }。',
  '- "emotions"、"topics"、"entities"：数组，每个元素都是同一个标注形状：',
  '  { "labelSaid": 字符串, "candidateConceptId": 字符串或 null, "basis": 枚举, "evidence": 字符串 }。',
  '  其中 "eventTime" 对象必须含五个键：{ "raw": 字符串或 null, "precision": 枚举, "certainty": 枚举, "start": 字符串或 null, "end": 字符串或 null }。',
  '- "relations"：数组，每个元素是 { "relationType": 枚举, "srcLabel": 字符串, "dstLabel": 字符串, "evidence": 字符串 }。',
  "",
  "封闭枚举取值（不得发明新值）：",
  `- "basis" ∈ { ${joinEnum(BASIS)} }。`,
  `- "precision" ∈ { ${joinEnum(PRECISION)} }。`,
  `- "certainty" ∈ { ${joinEnum(CERTAINTY)} }。`,
  `- "relationType" ∈ { ${joinEnum(RELATION_TYPES)} }。`,
  "",
  "证据纪律（这是硬约束，违反即整条结果作废）：",
  '- 每一个 "evidence" 必须是从用户原文里**逐字摘录**的连续片段，能被原样回查定位；不得改写、翻译、拼接或概括。',
  "- 不得编造原文中不存在的时间、地点、人物或事件；定位不到证据就宁可少报，不得虚报。",
  '- "candidateConceptId" 只能是系统词表里已存在的概念/实体 ID；不确定时一律填 null，你没有新建概念或实体的权限。',
  "- 若 precision 不是 unknown，则 raw 非空、start 与 end 必须齐全且 start<=end、certainty 不为 unknown；precision=unknown 时 certainty=unknown 且 raw/start/end 全为 null。",
  "",
  "关系纪律（relations 只收**稳定的社会关系**，且只在**本条记录**内成立）：",
  "- 只抽关系词被明说的关系：同事、朋友、家人、伴侣、同学、上下级。原文没说关系词，就不产出这一条。",
  '- 事件不是关系：「一起吃饭」「吵了一架」「帮了个忙」「一起去出差」这类一次性的事**一律不抽**（它们已经存在于 "episodes" 里）。',
  '- 弱关系不是关系：只是「认识」「见过一面」「有过来往」的，不抽。',
  '- "srcLabel" 与 "dstLabel" 必须是这条记录里出现过的**原词**，与你在 "entities" 里报的词面同源；不得改写、缩写、换成代称或补出原文没有的人。',
  '- "evidence" 照旧逐字摘录，且必须同时容得下 "srcLabel" 与 "dstLabel" 两个词面。',
  '- 两端不得是同一个词面。',
  '- "reports_to" 是有向的，方向是下属 → 上级："srcLabel" 是下属，"dstLabel" 是上级；其余类型无向，两端先后不参与判定。',
  "- 不得从历史记录、常识或称谓习惯里推断关系。",
  "",
  "明确禁止输出以下字段（它们属于用户裁定，不属于你的抽取结果）：",
  "- 不得输出强度（intensity）评分；",
  "- 不得输出因果关系（如 triggered_by）；",
  `- 不得输出上面列举的 ${RELATION_TYPES.length} 类稳定社会关系之外的任何 "relationType"（别名关系、合并关系都不归你提）；`,
  "- 不得对上述任何封闭枚举之外发明取值。",
  "",
  "空信息处理：当某类内容（episodes / thoughts / emotions / topics / entities / relations）在原文中不存在时，",
  '对应的数组返回空数组 []，但七个数组键与 title、summary 都必须出现在输出里——没有关系时 "relations" 也要在，值是 []。',
].join("\n");
