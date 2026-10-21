/**
 * CJK 分词器（Spec §7.2：检索正确性的地基；查询侧与索引侧共用本实现）。
 *
 * 来源：llm-wiki-agent/src/qa/tokenizer.ts
 * 移植时源文件 sha256：6c7ba3ae6a3f869ef12933a0a13807d40fe9132328241cad66d7521b714a738
 * 移植日期：2026-10-12；无第三方依赖；逻辑逐字保留，仅统一代码风格。
 *
 * 策略：NFKC 归一 → 小写 → 去标点（保留词内撇号/连字符/下划线）
 * → Han/平假名/片假名/谚文连续段输出确定性的 1/2/3-gram
 * → ASCII 词整体作为 token。小停用词表偏召回。
 *
 * 输出有序且确定性：按文本扫描顺序产 token（每位置先 unigram 再 bigram 再 trigram），
 * 重复 token 保留（BM25 需要 tf）。
 */

/** CJK / Kana / Hangul 连续段（用于 n-gram 切分）
 *  范围：CJK 扩展 A(U+3400-U+4DBF) + 主块(U+4E00-U+9FFF) + 平假名(U+3040-U+30FF) + 谚文(U+AC00-U+D7AF) */
const CJK_RUN = /[㐀-䶿一-鿿぀-ヿ가-힯]+/;
/** 单个 CJK 字符类（用于判定某 token 是否为 CJK 段） */
const CJK_CHAR = /[㐀-䶿一-鿿぀-ヿ가-힯]/;
/** ASCII 词：字母数字 + 词内撇号/连字符/下划线（don't / state-of-art / foo_bar）。
 *  `tokenize` 直接用 SCAN 扫描，此正则单独导出供调用方做词边界判定（如需）。 */
export const ASCII_WORD = /[A-Za-z0-9]+(?:['_\-][A-Za-z0-9]+)*/g;
/** 全文扫描：CJK 段 或 ASCII 词（其余标点被丢弃） */
const SCAN = /[㐀-䶿一-鿿぀-ヿ가-힯]+|[A-Za-z0-9]+(?:['_\-][A-Za-z0-9]+)*/g;

/** 停用词小表（偏召回：仅高频虚词）。中英文各少量。 */
export const STOPWORDS: ReadonlySet<string> = new Set([
  // 中文高频虚词
  "的", "了", "和", "是", "在", "我", "你", "他", "她", "它", "我们", "你们", "他们",
  "这", "那", "有", "与", "及", "或", "也", "都", "就", "而", "一个", "一种", "可以", "通过",
  // 英文
  "the", "a", "an", "is", "are", "of", "to", "and", "or", "in", "on", "for", "with", "at", "by",
]);

/** 对一段 CJK 字符产出确定性的 1/2/3-gram（按扫描顺序） */
function cjkGrams(run: string): string[] {
  const out: string[] = [];
  const n = run.length;
  for (let i = 0; i < n; i++) {
    out.push(run.slice(i, i + 1)); // unigram
    if (i + 1 < n) out.push(run.slice(i, i + 2)); // bigram
    if (i + 2 < n) out.push(run.slice(i, i + 3)); // trigram
  }
  return out;
}

/**
 * 分词主入口。
 * @param text 任意文本（记录原文 / 查询串）
 * @returns token 数组（有序、含重复，供 BM25 计 tf）
 */
export function tokenize(text: string): string[] {
  if (!text) return [];
  const normalized = text.normalize("NFKC").toLowerCase();
  const tokens: string[] = [];
  let m: RegExpExecArray | null;
  SCAN.lastIndex = 0;
  while ((m = SCAN.exec(normalized)) !== null) {
    const tok = m[0];
    if (CJK_CHAR.test(tok)) {
      // CJK 段：每个 n-gram 单独过停用词（单字虚词如「的/了」也要剔除）
      for (const g of cjkGrams(tok)) {
        if (!STOPWORDS.has(g)) tokens.push(g);
      }
    } else if (!STOPWORDS.has(tok)) {
      tokens.push(tok);
    }
    // 其余（空匹配不会发生在 SCAN 上）跳过
  }
  return tokens;
}

/** 供其它模块判定某 token 是否为 CJK 段（测试/调试用） */
export function isCjk(token: string): boolean {
  return CJK_RUN.test(token);
}

/** 索引列与查询串的序列化契约：token 以单空格连接，可逆 split(" ") 还原。 */
export function serializeTokens(tokens: readonly string[]): string {
  return tokens.join(" ");
}

export function deserializeTokens(stored: string): string[] {
  return stored === "" ? [] : stored.split(" ");
}
