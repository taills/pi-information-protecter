const catalog = {
  INTERNAL: ["internal", "Unexpected local failure / 未预期的本地错误", "Reload; check the installed package integrity / 重载并检查安装包完整性"],
  NOT_READY: ["initialization", "Protection is not initialized / 防护尚未初始化", "Run /protecter status for the initialization error, fix it, then /reload / 查看初始化错误，修复后重载"],
  UNSUPPORTED_PI: ["initialization", "Unsupported Pi version / Pi 版本不受支持", "Use Pi 0.85.1-0.85.x / 请使用受支持的 Pi 版本"],
  MACHINE_ID: ["initialization", "Machine identifier unavailable / 无法获取机器标识", "Check local OS machine-ID access; no random fallback is used / 检查系统机器标识访问权限，不使用随机回退"],
  CONFIG_JSON: ["configuration", "Invalid configuration JSON / 配置 JSON 无效", "Fix JSON syntax locally, then /reload / 本地修复 JSON 语法后重载"],
  CONFIG_SCHEMA: ["configuration", "Invalid configuration structure or rule / 配置结构或规则无效", "Use version 1, a sensitiveWords array and documented fields; rule shows the 1-based index / 使用版本1、敏感词数组及文档字段，rule 为规则序号"],
  CONFIG_REGEX: ["configuration", "Invalid regex or flags / 正则或标志无效", "Fix the numbered rule; flags support gimsu only / 修复指定规则，标志仅支持 gimsu"],
  CONFIG_TARGET: ["configuration", "Invalid fixed replacement target / 固定替换目标无效", "Use a non-blank string under 8192 characters without reserved __PIP_ names / 使用非空且少于8192字符的目标，不含保留名称"],
  CONFIG_CONFLICT: ["configuration", "Conflicting rule definitions / 规则定义冲突", "Give the same matcher one replacement policy across all configs / 为同一匹配器设置一致的替换策略"],
  CONFIG_SIZE: ["configuration", "Configuration exceeds size or rule limit / 配置超过体积或规则数上限", "Reduce configuration size or rule count; rules are never truncated / 减少配置体积或规则数，规则不会被截断"],
  CONFIG_IO: ["configuration", "Cannot access configuration / 无法访问配置", "Check local permissions, ownership and free space / 检查本地权限、所有者和磁盘空间"],
  CONFIG_UNSAFE: ["configuration", "Unsafe configuration file / 配置文件不安全", "Use an owned regular file without symbolic or hard links / 使用本人所有的普通文件，不含符号或硬链接"],
  CONFIG_EMPTY_MATCH: ["configuration", "Regex matches an empty string / 正则匹配空字符串", "Require a non-empty match in the numbered rule / 修改指定规则，要求非空匹配"],
  CONFIG_SENSITIVE_TARGET: ["configuration", "Fixed target overlaps a sensitive rule / 固定目标与敏感规则重叠", "Choose a target unrelated to every sensitive matcher / 选择与所有敏感匹配器无关的目标"],
  CONFIG_ALIAS_CONFLICT: ["configuration", "Fixed aliases overlap each other / 固定别名相互重叠", "Use distinct aliases that are not substrings of one another / 使用互不包含的不同别名"],
  CONFIG_TIMEOUT: ["configuration", "Rule validation timed out / 规则验证超时", "Simplify regex rules, then /reload / 简化正则规则后重载"],
  MIGRATION_LOCKED: ["migration", "Configuration migration lock is busy / 配置迁移锁被占用", "Wait for other Pi processes; inspect a stale lock only after stopping them / 等待其他进程，全部停止后再检查残留锁"],
  MIGRATION_CHANGED: ["migration", "Configuration changed during migration / 迁移期间配置发生变化", "Stop concurrent edits and /reload; source files are preserved / 停止并发编辑后重载，源文件会保留"],
  MIGRATION_LIMIT: ["migration", "Too many configuration candidates / 候选配置过多", "Consolidate old configuration files locally / 在本地整理旧配置文件"],
  MIGRATION_IO: ["migration", "Migration file operation failed / 迁移文件操作失败", "Check permissions, free space and leftover files before retrying / 检查权限、空间和残留文件后重试"],
  PAYLOAD_JSON: ["request", "Request is not serializable JSON / 请求无法序列化为 JSON", "Inspect the provider or another payload-modifying extension; no payload is logged / 检查提供商或其他请求改写扩展，不记录请求内容"],
  PAYLOAD_SIZE: ["request", "Request exceeds the size limit / 请求超过体积上限", "Reduce history or tool output size, or start a new session / 减少历史或工具输出，或新建会话"],
  SCAN_TIMEOUT: ["scan", "Redaction worker timed out / 脱敏 worker 超时", "Simplify regex rules or reduce input size / 简化正则规则或缩小输入"],
  WORKER_FAILED: ["worker", "Worker failed to start or exited early / worker 启动失败或提前退出", "Verify all dist files and the Node version; reinstall if needed / 检查 dist 文件完整性和 Node 版本，必要时重装"],
  SCAN_INTERNAL: ["scan", "Unexpected scan failure / 未预期的扫描错误", "Review recent rule changes and retry with smaller input / 检查最近的规则改动并缩小输入"],
  SCAN_ZERO_WIDTH: ["scan", "Regex produced a zero-width match / 正则产生零宽匹配", "Require a non-empty match in the numbered rule / 修改指定规则，要求非空匹配"],
  SCAN_MATCH_LIMIT: ["scan", "Too many matches in one request / 单次请求匹配次数过多", "Narrow overly broad rules or reduce input / 缩小过宽规则或减少输入"],
  SCAN_MAPPING_LIMIT: ["scan", "Mapping limit reached / 映射数量达到上限", "Start a new session or /reload; in-memory mappings reset / 新建会话或重载，内存映射将重置"],
  FIXED_MAPPING_CONFLICT: ["scan", "One original has conflicting replacements / 同一原文存在冲突替换", "Use one replacement for overlapping matchers, then /reload / 为重叠匹配器使用同一目标后重载"],
  FIXED_ALIAS_REUSED: ["scan", "Fixed alias already maps to another original / 固定别名已映射其他原文", "A fixed regex represents one original per instance; use random replacement or split literal rules / 固定正则在同一实例仅代表一种原文，改用随机替换或拆分字面规则"],
  FIXED_SENSITIVE_TARGET: ["scan", "Replacement contains the matched original / 替换目标包含命中原文", "Choose a target without sensitive content / 选择不含敏感内容的目标"],
  FIXED_OVERLAP: ["scan", "Fixed replacement partially overlaps another match / 固定替换与其他匹配部分重叠", "Remove the partial overlap or use random rules; rule and otherRule show both rules / 消除部分重叠或改用随机规则，rule 与 otherRule 指出两条规则"],
  FIXED_ALIAS_CROSSING: ["scan", "Regex crosses a learned fixed alias / 正则跨越已学习的固定别名", "Narrow the regex or choose a different alias / 缩小正则范围或更换别名"],
  SCAN_COMPLEXITY: ["scan", "Request exceeds depth or node limits / 请求超过层级或节点上限", "Reduce nested data and tool schema size / 减少嵌套数据和工具结构体积"],
  SCAN_JSON_REWRITE: ["scan", "Replacement breaks embedded JSON syntax / 替换破坏内嵌 JSON 语法", "Avoid rules spanning JSON syntax; match field values instead / 避免跨 JSON 语法的规则，改为匹配字段值"],
  SCAN_ATTACHMENT: ["scan", "Unsupported image, audio, video or file content / 不支持图片、音频、视频或文件内容", "Remove attachments or send reviewed text only / 移除附件或仅发送已审查的文本"],
  SCAN_KEY_COLLISION: ["scan", "Replacement creates duplicate object keys / 替换后对象键重复", "Use distinct targets or avoid matching schema keys / 使用不同目标或避免匹配结构键"],
  AUDIT_BATCH_LIMIT: ["audit", "Audit batch exceeds the size limit / 审计批次超过上限", "Reduce matched content per request / 减少单个请求的命中内容"],
  AUDIT_FULL: ["audit", "Audit log would exceed the size limit / 审计日志将超过上限", "Review records, then run /protecter logs clear or archive locally / 检查记录后清空日志或本地归档"],
  AUDIT_PARTIAL: ["audit", "Audit log has an incomplete last line / 审计日志末行不完整", "Inspect locally or run /protecter logs clear; never upload the log / 本地检查或清空日志，不要上传日志"],
  AUDIT_LOCKED: ["audit", "Audit lock stayed busy / 审计锁持续被占用", "Wait for writers; stop all Pi processes before inspecting a stale lock / 等待写入完成，全部停止后再检查残留锁"],
  AUDIT_UNSAFE: ["audit", "Unsafe audit file / 审计文件不安全", "Use an owned regular file without links; checks are not bypassed / 使用本人普通文件且不含链接，不会绕过检查"],
  AUDIT_IO: ["audit", "Audit file operation failed / 审计文件操作失败", "Check errno, permissions and free space; no path or content is exposed / 检查错误码、权限和磁盘空间，不暴露路径或内容"],
} as const;

export type DiagnosticCode = keyof typeof catalog;
const COORDS = ["rule", "otherRule", "node", "bytes", "limit", "timeoutMs"] as const;
const ERRNO = /^(EACCES|EPERM|ENOENT|ENOSPC|EDQUOT|EROFS|ELOOP|EISDIR|ENOTDIR|EMFILE|ENFILE|EIO|EEXIST|EBADF|EBUSY|ENOTEMPTY)$/;
export interface Details {
  rule?: number;
  otherRule?: number;
  node?: number;
  bytes?: number;
  limit?: number;
  timeoutMs?: number;
  errno?: string;
}
export interface Diagnostic extends Details {
  code: DiagnosticCode;
  stage: string;
  reason: string;
  action: string;
}

/**
 * Allow only known codes, numeric coordinates and OS errno values.
 * 仅允许已知错误码、数字定位和系统错误码，不透传消息、路径或原文。
 */
export function diagnostic(code: DiagnosticCode, details: Details = {}): Diagnostic {
  const [stage, reason, action] = catalog[code];
  const safe: Details = {};
  for (const key of COORDS) {
    const value = details[key];
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) safe[key] = value;
  }
  if (typeof details.errno === "string" && ERRNO.test(details.errno)) safe.errno = details.errno;
  return { code, stage, reason, action, ...safe };
}

export function formatDiagnostic(value: Diagnostic): string {
  const coords = [...COORDS, "errno" as const]
    .filter((key) => value[key] !== undefined)
    .map((key) => `${key}=${value[key]}`)
    .join(" ");
  return [
    `SPI Protecter blocked this request / 已阻止该请求`,
    `code=${value.code} stage=${value.stage}${coords ? ` ${coords}` : ""}`,
    `Reason / 原因: ${value.reason}`,
    `Action / 处理: ${value.action}`,
    `Details / 详情: /protecter status`,
  ].join("\n");
}

export class ProtectionError extends Error {
  readonly diagnostic: Diagnostic;
  constructor(code: DiagnosticCode, details: Details = {}) {
    const value = diagnostic(code, details);
    super(formatDiagnostic(value));
    this.name = "ProtectionError";
    this.diagnostic = value;
  }
}

export function failure(code: DiagnosticCode, details: Details = {}): ProtectionError {
  return new ProtectionError(code, details);
}

/** Keep OS errno but never reuse a raw message. / 保留系统错误码，但不复用原始消息。 */
export function sanitizeError(error: unknown, fallback: DiagnosticCode, details: Details = {}): ProtectionError {
  if (error instanceof ProtectionError) return failure(error.diagnostic.code, { ...error.diagnostic, ...details });
  const errno = error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined;
  return failure(fallback, { ...details, errno: typeof errno === "string" ? errno : undefined });
}

/** Accept only catalog codes from worker boundaries. / worker 边界仅接受目录内错误码。 */
export function workerError(value: unknown, fallback: DiagnosticCode): ProtectionError {
  if (!value || typeof value !== "object") return failure(fallback);
  const data = value as { code?: unknown } & Details;
  const code = typeof data.code === "string" && Object.hasOwn(catalog, data.code) ? (data.code as DiagnosticCode) : fallback;
  return failure(code, data);
}
