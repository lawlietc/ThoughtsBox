/**
 * 生产 systemPrompt 文本（M4-TR-1，缺口三）。
 *
 * 此前全仓没有生产提示词来源：`IngestServiceOptions.systemPrompt` 必填，但只有测试夹具
 * `ingestFixtures.ts` 的占位串「你是结构化抽取器。只输出 JSON。」。这份文本严格按
 * `contract.ts` 的 `m2-output-v1` 输出契约撰写——字段名、枚举封闭集、以及「证据必须逐字摘自
 * 原文、不得编造坐标/概念」等硬要求都写进指令正文。
 *
 * **版本串沿用 `m2-prompt-v1` 不升**（`ingestService.ts:73` 的 `DEFAULT_PROMPT_VERSION`）：
 * 升版本 = 动 pipeline_manifest 的 `prompt` 项 = 动 K-17 指纹与幂等语义，超出本任务范围。
 *
 * 枚举取值一律从 `contracts` 单一事实源插入，不在文本里手抄第二份封闭集（E-07，与
 * `contract.ts`、`trace.ts` 同法）；「提示词 ↔ contract 字段表对账」断言见新专项测试。
 */

import { loadContracts } from "../../../shared/contracts/load.ts";

const CONTRACTS = loadContracts();

/** `basis` 封闭集（explicit / inferred）。 */
const BASIS = CONTRACTS.enums.basis_values;
/** 事件时间精度封闭集。 */
const PRECISION = CONTRACTS.enums.event_time_precision;
/** 事件时间确定度封闭集。 */
const CERTAINTY = CONTRACTS.enums.event_time_certainty;

function joinEnum(values: readonly string[]): string {
  return values.map((v) => `"${v}"`).join(" | ");
}

/**
 * 顶层与子对象的所有键名——与 `structuredOutputSchema` 逐字同名。写进正文供对账测试逐项 `includes`
 * 核对；契约加/减字段时，这里与 contract.ts 必须同步改，专项测试会因此变红。
 */
export const M2_PROMPT_CONTRACT_FIELDS = [
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
] as const;

export const M2_PROMPT_V1 = [
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
  "",
  "封闭枚举取值（不得发明新值）：",
  `- "basis" ∈ { ${joinEnum(BASIS)} }。`,
  `- "precision" ∈ { ${joinEnum(PRECISION)} }。`,
  `- "certainty" ∈ { ${joinEnum(CERTAINTY)} }。`,
  "",
  "证据纪律（这是硬约束，违反即整条结果作废）：",
  '- 每一个 "evidence" 必须是从用户原文里**逐字摘录**的连续片段，能被原样回查定位；不得改写、翻译、拼接或概括。',
  "- 不得编造原文中不存在的时间、地点、人物或事件；定位不到证据就宁可少报，不得虚报。",
  '- "candidateConceptId" 只能是系统词表里已存在的概念/实体 ID；不确定时一律填 null，你没有新建概念或实体的权限。',
  "- 若 precision 不是 unknown，则 raw 非空、start 与 end 必须齐全且 start<=end、certainty 不为 unknown；precision=unknown 时 certainty=unknown 且 raw/start/end 全为 null。",
  "",
  "明确禁止输出以下字段（它们属于用户裁定，不属于你的抽取结果）：",
  "- 不得输出强度（intensity）评分；",
  "- 不得输出关系类型或因果关系（如 triggered_by）；",
  "- 不得对上述任何封闭枚举之外发明取值。",
  "",
  "空信息处理：当某类内容（episodes / thoughts / emotions / topics / entities）在原文中不存在时，",
  "对应的数组返回空数组 []，但六个数组键与 title、summary 都必须出现在输出里。",
].join("\n");
