/**
 * 配置与数据目录错误的统一出口：必须报出文件路径与字段名（M0 交付物 5），
 * 不静默回落到默认值——尤其是密钥，回落只会把配置错误变成隐私事故。
 */
export class ConfigError extends Error {
  readonly filePath: string | undefined;
  readonly fields: readonly string[];

  constructor(message: string, options: { filePath?: string; fields?: string[] } = {}) {
    const parts = [message];
    if (options.filePath !== undefined) parts.push(`文件：${options.filePath}`);
    if (options.fields !== undefined && options.fields.length > 0) {
      parts.push(`字段：${options.fields.join("、")}`);
    }
    super(parts.join("\n  "));
    this.name = "ConfigError";
    this.filePath = options.filePath;
    this.fields = options.fields ?? [];
  }
}
