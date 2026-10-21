/**
 * Trace、日志与可观测性（D14）：默认无原文，调试原文模式是显式开关。
 *
 * 契约取值：指令 §11.1（Trace 要能定位什么）、§11.2（隐私纪律）、§11.3（错误处理）；
 * Spec §5.5（失败与重试）、§11-隐私（脱敏映射不进 Trace、调试模式默认关闭且重启失效）；
 * ADR-006 Consequences（降级路径要能记录错误类型、所走路径与最终是否通过校验）。
 *
 * 两条硬约束决定了本文件的形态：
 *
 * 1. **Trace 不是第二份数据库**（指令 §11.1 末段）。所以字段是封闭的一小撮：
 *    内部 ID、阶段与时刻、Provider/模型标识、结构解析是否成功、业务校验结果、
 *    写入是否提交、错误类别与可重试性。原文、载荷、映射、密钥一概不在类型里——
 *    不是「记得别填」，是**没有地方可填**。
 * 2. **调试原文模式不与普通 Trace 混用**（指令 §11.2 末段、Spec §5.5）。所以它是
 *    `TraceSession` 上另一个**独立容器**：普通序列化路径（`serializeTrace`）永远看不见它，
 *    要拿到原文必须显式调用导出并再次确认。默认关闭、会话范围、只进内存、重启即失效。
 *
 * 序列化时还有一道**主动守门**：`serializeTrace(entries, guards)` 接收本次会话已知的
 * 敏感字面量（原文、真实词面与占位符的映射文本、API Key），逐项扫描输出，命中即抛。
 * 类型约束只能保证「本模块没写进去」，保证不了调用方把一个原文塞进 `diagnostics`；
 * 这一道扫描让「普通 Trace 不含原文」在**边界上**成立，而不是只在约定上成立。
 */

import { loadEnums } from "../../shared/contracts/load.ts";
import type { JsonObject } from "../privacy/manifest.ts";
import type { RedactionMap } from "../privacy/redaction.ts";
import {
  PARSE_ERROR_KINDS,
  PROVIDER_CALL_PATHS,
  type ParseErrorKind,
  type ProcessingMode,
  type ProviderCallPath,
} from "./provider.ts";

/**
 * 阶段名封闭集（指令 §11.1 列举的「阶段名称及开始、结束时间」+ Spec §5.1 的 3–12 步）。
 * 不在这里的一律不接受：阶段集合一旦开放，Trace 就开始长成第二份数据库。
 */
export const TRACE_PHASES = [
  "preprocess",
  "provider_call",
  "schema_validation",
  "business_validation",
  "derived_write",
] as const;

export type TracePhase = (typeof TRACE_PHASES)[number];

/** 未知阶段名直接拒——阶段集合一旦开放，Trace 就开始长成第二份数据库（指令 §11.1 末段）。 */
export function isTracePhase(value: unknown): value is TracePhase {
  return typeof value === "string" && (TRACE_PHASES as readonly string[]).includes(value);
}

/**
 * Trace 的字段面封闭集：§11.1 逐项列出的定位能力落完就收口。
 * 序列化时逐键核对，多一个键即拒——「不得扩展为第二份数据库」由此成为可执行断言，
 * 而不是一句注释。
 */
export const TRACE_ENTRY_FIELDS = [
  "recordId",
  "recordRevisionId",
  "parseRunId",
  "idempotencyKey",
  "pipelineFingerprint",
  "processingMode",
  "provider",
  "model",
  "callPath",
  "attemptedPaths",
  "degraded",
  "structuredParseSucceeded",
  "businessValidation",
  "derivedWriteCommitted",
  "errorKind",
  "retryable",
  "diagnostics",
  "phases",
] as const;

const ALLOWED_TRACE_KEYS = new Set<string>(TRACE_ENTRY_FIELDS);

/** 嵌套结构允许的键（`diagnostics` 内部另按自由对象处理，只受 FORBIDDEN 约束）。 */
const NESTED_ALLOWED_KEYS = new Set<string>([
  "phase",
  "startedAtUtc",
  "finishedAtUtc",
  "passed",
  "rules",
]);

export interface PhaseTiming {
  readonly phase: TracePhase;
  readonly startedAtUtc: string;
  readonly finishedAtUtc: string;
}

/** `business_validation` 阶段的结果：走过的规则 + 是否通过（ADR-006 Consequences 要求可记录）。 */
export interface BusinessValidationRecord {
  readonly passed: boolean;
  readonly rules: readonly string[];
}

export interface TraceEntry {
  readonly recordId?: string;
  readonly recordRevisionId: string;
  readonly parseRunId?: string;
  readonly idempotencyKey?: string;
  readonly pipelineFingerprint?: string;
  /** 封闭三值；全字段面里唯一没有编译期保护的枚举字段，取值门在 `CLOSED_VALUE_GATES` 兜住。 */
  readonly processingMode?: ProcessingMode;
  readonly provider?: string;
  readonly model?: string;
  readonly callPath?: ProviderCallPath;
  /** 实际尝试过的路径与是否降级（ADR-006：降级路径要能记录所走路径）。 */
  readonly attemptedPaths?: readonly ProviderCallPath[];
  readonly degraded?: boolean;
  readonly structuredParseSucceeded?: boolean;
  readonly businessValidation?: BusinessValidationRecord;
  readonly derivedWriteCommitted?: boolean;
  readonly errorKind?: ParseErrorKind;
  readonly retryable?: boolean;
  /** 安全诊断：只放内部 ID、状态码、计数（指令 §11.1 末段、§11.2 末段）。 */
  readonly diagnostics?: JsonObject;
  readonly phases?: readonly PhaseTiming[];
}

/**
 * 敏感字面量来源：调用方把本次会话知道的原文/映射/密钥交给守门函数核对。
 * 它们只用于**比对**，永不被写出（`guards` 自身不进任何序列化结果）。
 */
export interface PrivacyGuards {
  readonly rawText?: string;
  readonly redactionMap?: RedactionMap;
  readonly apiKey?: string;
}

export class TracePrivacyViolation extends Error {
  constructor(reason: string) {
    super(`Trace 隐私守门拦截：${reason}（指令 §11.2：普通 Trace 不得含原文、脱敏前载荷、身份映射或密钥）`);
    this.name = "TracePrivacyViolation";
  }
}

/**
 * 契约外字段名：一旦出现在 Trace 的键上，无论值是什么都拒（防「第二份数据库」的入口）。
 * 注意这里**不含** `provider` / `model`：指令 §11.1 明确要求 Trace 记录它们。
 */
const FORBIDDEN_TRACE_KEYS = new Set<string>([
  "raw_text",
  "rawText",
  "payload",
  "payload_text",
  "payloadText",
  "prompt",
  "system_prompt",
  "completion",
  "response_body",
  "api_key",
  "apiKey",
  "redaction_map",
  "redactionMap",
  "spans",
  "placeholder",
  "originalStart",
  "originalEnd",
  "nonce",
]);

/** 映射里会暴露真实身份的东西：占位符本体 + 原文坐标字段名。 */
function guardLiterals(guards: PrivacyGuards): string[] {
  const literals: string[] = [];
  if (guards.rawText !== undefined && guards.rawText !== "") literals.push(guards.rawText);
  if (guards.apiKey !== undefined && guards.apiKey !== "") literals.push(guards.apiKey);
  for (const span of guards.redactionMap?.spans ?? []) {
    literals.push(span.placeholder);
  }
  return literals;
}

/**
 * 处理模式的封闭集**不在本文件里重抄**：运行时从 `enums.json` 的单一事实源取
 * （E-07，与 T-16「迁移字面量 == enums.json」同一手法）。清单漂移时门的判定跟着漂移，
 * 而不是两处各说各话。
 */
const PROCESSING_MODES: readonly string[] = loadEnums().processing_modes;

function membershipOf(values: readonly string[]): (value: unknown) => boolean {
  return (value: unknown): boolean => typeof value === "string" && values.includes(value);
}

/** 一个封闭集字段的取值门：`label` 指名它的事实源，报错时报的是源而不是抄来的清单。 */
interface ValueGate {
  readonly label: string;
  readonly accepts: (value: unknown) => boolean;
}

/**
 * 取值门（M2-4 复审裁决 1）：键名在册**不够**，取值也得在册。
 *
 * 原来这里只核对键名，运行时把 `phases[0].phase` 塞成 `"not_a_phase"` 照样序列化通过，
 * `isTracePhase()` 除了测试没有第二个调用点——与 M2-2b 裁定的 (d1)「白名单里的枚举字段
 * 补取值门」是同一类漏洞。四份清单一律引用各自的事实源：阶段取本文件的 `TRACE_PHASES`
 * （经由 `isTracePhase`），路径与错误类别取 `provider.ts`，处理模式取 `enums.json`。
 */
const CLOSED_VALUE_GATES: Readonly<Record<string, ValueGate>> = {
  phase: { label: "TRACE_PHASES", accepts: isTracePhase },
  callPath: { label: "PROVIDER_CALL_PATHS", accepts: membershipOf(PROVIDER_CALL_PATHS) },
  attemptedPaths: { label: "PROVIDER_CALL_PATHS", accepts: membershipOf(PROVIDER_CALL_PATHS) },
  errorKind: { label: "PARSE_ERROR_KINDS", accepts: membershipOf(PARSE_ERROR_KINDS) },
  processingMode: { label: "enums.json 的 processing_modes", accepts: membershipOf(PROCESSING_MODES) },
};

/**
 * 逐值核对封闭集字段的取值；数组按元素逐个核对并报出下标。
 * 未在册的取值本身**不进错误消息**：那个位置完全可能被塞进原文，
 * 守门的报错不能自己成为新的泄露点（指令 §11.2）。
 */
function assertClosedValues(value: unknown, at: string, gate: ValueGate): void {
  const isList = Array.isArray(value);
  const items: readonly unknown[] = isList ? value : [value];
  const offenders: string[] = [];
  items.forEach((item, index) => {
    if (!gate.accepts(item)) offenders.push(isList ? `${at}[${index}]` : at);
  });
  if (offenders.length > 0) {
    throw new TracePrivacyViolation(`${offenders.join("、")} 的取值不在封闭集 ${gate.label} 内（Trace 取值集合是封闭的）`);
  }
}

/**
 * 形状守门：顶层键必须 ∈ 封闭集，嵌套键必须 ∈ 已知嵌套结构，封闭集字段的**取值**也必须 ∈
 * 各自的取值集合。`diagnostics` 是唯一允许自由键的位置（指令 §11.1），里面的同名键不受
 * 取值门约束——它承载的是调用方自己的安全诊断标签，不是 Trace 的契约字段。
 */
function assertClosedShape(entry: TraceEntry, at: string): void {
  for (const key of Object.keys(entry)) {
    if (!ALLOWED_TRACE_KEYS.has(key)) {
      throw new TracePrivacyViolation(`${at} 出现契约外字段 ${key}（Trace 字段集合是封闭的）`);
    }
  }
  const walk = (value: unknown, path: string, insideDiagnostics: boolean): void => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, `${path}[${index}]`, insideDiagnostics));
      return;
    }
    if (value === null || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN_TRACE_KEYS.has(key)) {
        throw new TracePrivacyViolation(`出现契约外字段 ${path}.${key}`);
      }
      const nextInside = insideDiagnostics || key === "diagnostics";
      if (!nextInside && !NESTED_ALLOWED_KEYS.has(key) && !ALLOWED_TRACE_KEYS.has(key)) {
        throw new TracePrivacyViolation(`出现契约外字段 ${path}.${key}`);
      }
      const gate = CLOSED_VALUE_GATES[key];
      // `undefined` 的可选字段由 prune() 抹掉，不构成「取值不在册」（形状稳定性断言依赖这一点）。
      if (gate !== undefined && !nextInside && child !== undefined) {
        assertClosedValues(child, `${path}.${key}`, gate);
      }
      walk(child, `${path}.${key}`, nextInside);
    }
  };
  walk(entry, at, false);
}

/**
 * 序列化普通 Trace。三道守门：
 * ① 键名守门——顶层与嵌套键都必须属于封闭集，原文/载荷/映射类字段名出现即拒；
 * ② 取值守门——封闭集字段（`phase` / `callPath` / `attemptedPaths` / `errorKind` /
 *    `processingMode`）的取值也必须属于各自的在册集合；
 * ③ 字面量守门——guards 提供的原文、真实词面占位符、密钥出现在文本里即拒。
 * 调试原文永不出现在这里：它根本不在 `TraceEntry` 的字段集合内（§11.2「不混用」）。
 */
export function serializeTrace(entries: readonly TraceEntry[], guards: PrivacyGuards = {}): string {
  entries.forEach((entry, index) => assertClosedShape(entry, `entry[${index}]`));
  const json = JSON.stringify(entries.map((entry) => prune(entry)));
  const violations: string[] = [];
  for (const literal of guardLiterals(guards)) {
    // 错误消息本身不回显敏感字面量，只报长度——否则守门函数自己成了泄露点。
    if (json.includes(literal)) violations.push(`命中敏感字面量（长度 ${literal.length}）`);
  }
  if (violations.length > 0) throw new TracePrivacyViolation(violations.join("；"));
  return json;
}

/** 去掉 undefined，避免序列化结果里出现形状漂移（指纹对账要求稳定文本）。 */
function prune(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(prune);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (child !== undefined) out[key] = prune(child);
    }
    return out;
  }
  return value;
}

/**
 * 调试原文条目：与普通 Trace 完全分离的另一份内存容器（指令 §11.2「不将其与普通 Trace 混用」）。
 * 它的存在与否由 `TraceSession.debugRawTextEnabled` 单点决定。
 */
export interface DebugRawRecord {
  readonly recordRevisionId: string;
  readonly parseRunId?: string;
  readonly stage: TracePhase;
  readonly rawText: string;
  readonly capturedAtUtc: string;
}

export class DebugExportConfirmationRequired extends Error {
  constructor() {
    super("显式导出调试数据需要额外确认（Spec §5.5）：未确认不产出任何原文。");
    this.name = "DebugExportConfirmationRequired";
  }
}

export interface TraceSessionOptions {
  readonly now?: () => Date;
  /**
   * 调试原文开关。**没有默认值可给**：默认关闭（Spec §5.5、指令 §11.2）。
   * 打开必须显式传 true，且只在当前会话内存里生效。
   */
  readonly debugRawText?: boolean;
}

/**
 * 一次运行会话。重启后不复用实例（`restart()` 造一个新会话），因此调试开关的
 * 「重启失效」不是靠记得去关闭，而是**没有地方可以持久**：本类不写文件、不写库。
 *
 * 状态用 ES `#` 私有字段而不是 TS `private`：后者只骗编译器，`JSON.stringify(session)`
 * 照样把调试原文整个吐出来。前者对结构化序列化**物理不可见**，
 * 「调试原文开了也不得进导出/日志面」由此成为实现事实而非约定。
 */
export class TraceSession {
  #entries: TraceEntry[] = [];
  #debugRecords: DebugRawRecord[] = [];
  #now: () => Date;
  #debugOn: boolean;

  constructor(options: TraceSessionOptions = {}) {
    this.#now = options.now ?? (() => new Date());
    this.#debugOn = options.debugRawText === true;
  }

  get debugRawTextEnabled(): boolean {
    return this.#debugOn;
  }

  /** 显式打开；调用点必须是用户动作（UI 开关），不是配置默认。 */
  enableDebugRawText(): void {
    this.#debugOn = true;
  }

  disableDebugRawText(): void {
    this.#debugOn = false;
    this.#debugRecords.length = 0;
  }

  /** 应用重启后自动关闭：新会话实例的开关只会是默认值。 */
  restart(): TraceSession {
    return new TraceSession({ now: this.#now });
  }

  record(entry: TraceEntry): TraceEntry {
    this.#entries.push(entry);
    return entry;
  }

  get entryCount(): number {
    return this.#entries.length;
  }

  /** 阶段计时：开始/结束时刻成对写入（指令 §11.1）。 */
  timed<T>(phase: TracePhase, run: () => T): { readonly value: T; readonly timing: PhaseTiming } {
    const startedAtUtc = this.#now().toISOString();
    const value = run();
    return { value, timing: { phase, startedAtUtc, finishedAtUtc: this.#now().toISOString() } };
  }

  /**
   * 调试原文只进这里。开关关闭时**静默丢弃**而不是抛：
   * 调用点在采集路径上，采集面不该因为一个没开的调试开关而中断正常解析（§11.3 不得吞异常
   * 说的是错误处理，这里是「没有请求可记录」）。
   */
  captureDebugRaw(
    stage: TracePhase,
    content: { readonly recordRevisionId: string; readonly rawText: string; readonly parseRunId?: string },
  ): void {
    if (!this.#debugOn) return;
    this.#debugRecords.push({
      stage,
      recordRevisionId: content.recordRevisionId,
      ...(content.parseRunId === undefined ? {} : { parseRunId: content.parseRunId }),
      rawText: content.rawText,
      capturedAtUtc: this.#now().toISOString(),
    });
  }

  get debugRecordCount(): number {
    return this.#debugRecords.length;
  }

  /** 普通 Trace 的序列化面；调试容器不参与。 */
  serialize(guards: PrivacyGuards = {}): string {
    return serializeTrace(this.#entries, guards);
  }

  /**
   * 调试原文的导出：必须再次确认（Spec §5.5「显式导出调试数据需额外确认」）。
   * 未确认 ⇒ 抛，且不产出任何字符串（不是返回空数组糊弄过去）。
   * 确认后仍只返回内存中的记录本体，不写文件——落盘动作属于调用方（M2-6）。
   */
  exportDebugRaw(confirmed: boolean): readonly DebugRawRecord[] {
    if (!this.#debugOn || !confirmed) throw new DebugExportConfirmationRequired();
    return [...this.#debugRecords];
  }
}
