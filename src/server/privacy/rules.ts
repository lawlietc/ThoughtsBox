/**
 * L0 格式层：与语言无关、按格式判定的敏感信息。
 *
 * 这里**只**做「换一种语言、换一个用户，规则照样成立」的东西：
 * 手机号、邮箱、身份证号、银行卡号、密钥/token。
 *
 * 禁区（2026-11-04 裁决）：
 * - 不猜姓名、地名、机构名、项目名；那些是 L2 本机模型的事；
 * - 不遮「所有长数字」；身份证必须过校验位、银行卡必须过 Luhn；
 * - 不做高熵长串、不做 CDK 自定义格式（PD-7 本轮不做）；
 * - 原文只读，不进日志。
 *
 * 坐标单位与全仓一致：UTF-16 code unit（K-23）。
 */

export const FORMAT_REDACTION_KINDS = ["phone", "email", "id_number", "bank_card", "secret"] as const;
export type FormatRedactionKind = (typeof FORMAT_REDACTION_KINDS)[number];

export interface FormatCandidate {
  readonly kind: FormatRedactionKind;
  /** 同一 kind 内同一词面共用一个占位符。 */
  readonly dedupeKey: string;
  readonly start: number;
  readonly end: number;
  readonly source: "rule";
}

const PHONE_PATTERN = /(?<!\d)(?:\+?86[- ]?)?1[3-9]\d{9}(?!\d)/g;
const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;

/** 18 位身份证：先按形状取候选，再校验 GB 11643 的校验位。 */
const ID_NUMBER_PATTERN = /(?<![0-9A-Za-z])\d{17}[\dXx](?![0-9A-Za-z])/g;
const ID_WEIGHTS = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2] as const;
const ID_CHECK = ["1", "0", "X", "9", "8", "7", "6", "5", "4", "3", "2"] as const;

/** 16–19 位数字，允许空格/短横分组；校验前先剥掉分隔符。 */
const BANK_CARD_PATTERN = /(?<!\d)\d(?:[ -]?\d){14,18}(?!\d)/g;

const PRIVATE_KEY_PATTERN =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi;
const PREFIX_TOKEN_PATTERNS: readonly RegExp[] = [
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bghp_[A-Za-z0-9]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAIza[0-9A-Za-z_-]{20,}\b/g,
];
/** `scheme://user:pass@host`：只遮 user:pass，不遮 scheme 与 host。 */
const URL_CREDENTIALS_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/([^\s:@/]+:[^\s@/]+)@/gi;
/** `?token=...` / `&api_key=...`：只遮等号后的值，保留键名。 */
const QUERY_SECRET_PATTERN =
  /[?&](?:token|api_key|apikey|access_token|password|secret)=([^&\s]+)/gi;
/** 正文里的 `password: ...` / `token=...`：只遮值。 */
const KEY_VALUE_SECRET_PATTERN =
  /\b(?:password|passwd|pwd|secret|token|api_key)\s*[:=]\s*([^\s,;]{6,})/gi;

function push(
  found: FormatCandidate[],
  text: string,
  start: number,
  end: number,
  kind: FormatRedactionKind,
): void {
  if (!Number.isInteger(start) || !Number.isInteger(end)) return;
  if (start < 0 || end <= start || end > text.length) return;
  const value = text.slice(start, end);
  found.push({ kind, dedupeKey: `${kind}\u0000${value}`, start, end, source: "rule" });
}

function pushMatches(
  found: FormatCandidate[],
  text: string,
  pattern: RegExp,
  kind: FormatRedactionKind,
): void {
  for (const match of text.matchAll(pattern)) {
    const value = match[0];
    const start = match.index;
    if (value === "" || start === undefined) continue;
    push(found, text, start, start + value.length, kind);
  }
}

function checksumOfIdNumber(value: string): boolean {
  if (!/^\d{17}[\dXx]$/.test(value)) return false;
  let sum = 0;
  for (let i = 0; i < 17; i += 1) sum += Number(value[i]) * ID_WEIGHTS[i]!;
  return ID_CHECK[sum % 11] === value[17]!.toUpperCase();
}

function luhnOf(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let n = Number(digits[i]);
    if (double) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    double = !double;
  }
  return sum % 10 === 0;
}

function isBankCard(value: string): boolean {
  const digits = value.replace(/[ -]/g, "");
  if (!/^\d{16,19}$/.test(digits)) return false;
  return luhnOf(digits);
}

function pushCaptured(
  found: FormatCandidate[],
  text: string,
  pattern: RegExp,
  captureOf: (match: RegExpMatchArray) => string | undefined,
): void {
  for (const match of text.matchAll(pattern)) {
    const captured = captureOf(match);
    const start = match.index;
    if (captured === undefined || captured === "" || start === undefined) continue;
    const offset = match[0].lastIndexOf(captured);
    if (offset < 0) continue;
    push(found, text, start + offset, start + offset + captured.length, "secret");
  }
}

/**
 * 一次扫描，产出全部格式类候选。重叠由 `redact()` 的 `resolveOverlaps` 统一消解
 * （左起最长优先）；这里不预判谁赢。
 */
export function findFormatCandidates(text: string): FormatCandidate[] {
  const found: FormatCandidate[] = [];
  pushMatches(found, text, PHONE_PATTERN, "phone");
  pushMatches(found, text, EMAIL_PATTERN, "email");

  for (const match of text.matchAll(ID_NUMBER_PATTERN)) {
    const value = match[0];
    const start = match.index;
    if (start === undefined || !checksumOfIdNumber(value)) continue;
    push(found, text, start, start + value.length, "id_number");
  }

  for (const match of text.matchAll(BANK_CARD_PATTERN)) {
    const value = match[0];
    const start = match.index;
    if (start === undefined || !isBankCard(value)) continue;
    push(found, text, start, start + value.length, "bank_card");
  }

  pushMatches(found, text, PRIVATE_KEY_PATTERN, "secret");
  pushMatches(found, text, JWT_PATTERN, "secret");
  pushMatches(found, text, BEARER_PATTERN, "secret");
  for (const pattern of PREFIX_TOKEN_PATTERNS) pushMatches(found, text, pattern, "secret");

  pushCaptured(found, text, URL_CREDENTIALS_PATTERN, (match) => match[1]);
  pushCaptured(found, text, QUERY_SECRET_PATTERN, (match) => match[1]);
  pushCaptured(found, text, KEY_VALUE_SECRET_PATTERN, (match) => match[1]);

  return found;
}
