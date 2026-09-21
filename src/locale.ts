/**
 * Single-language messages chosen from the environment locale.
 * 根据环境语言选择单一语言的提示文案。
 */
export type Locale = "en" | "zh";

const DIAGNOSTIC_EN: Record<string, [string, string]> = {
  INTERNAL: [
    "Unexpected local failure",
    "Reload; check the installed package integrity",
  ],
  NOT_READY: [
    "Protection is not initialized",
    "Run /protecter status for the initialization error, fix it, then /reload",
  ],
  UNSUPPORTED_PI: ["Unsupported Pi version", "Use Pi 0.85.1-0.85.x"],
  MACHINE_ID: [
    "Machine identifier unavailable",
    "Check local OS machine-ID access; no random fallback is used",
  ],
  CONFIG_JSON: [
    "Invalid configuration JSON",
    "Fix JSON syntax locally, then /reload",
  ],
  CONFIG_SCHEMA: [
    "Invalid configuration structure or rule",
    "Use version 1, a sensitiveWords array and documented fields; rule shows the 1-based index",
  ],
  CONFIG_REGEX: [
    "Invalid regex or flags",
    "Fix the numbered rule; flags support gimsu only",
  ],
  CONFIG_TARGET: [
    "Invalid fixed replacement target",
    "Use a non-blank string under 8192 characters without reserved __PIP_ names",
  ],
  CONFIG_CONFLICT: [
    "Conflicting rule definitions",
    "Give the same matcher one replacement policy across all configs",
  ],
  CONFIG_SIZE: [
    "Configuration exceeds size or rule limit",
    "Reduce configuration size or rule count; rules are never truncated",
  ],
  CONFIG_IO: [
    "Cannot access configuration",
    "Check local permissions, ownership and free space",
  ],
  CONFIG_UNSAFE: [
    "Unsafe configuration file",
    "Use an owned regular file without symbolic or hard links",
  ],
  CONFIG_EMPTY_MATCH: [
    "Regex matches an empty string",
    "Require a non-empty match in the numbered rule",
  ],
  CONFIG_SENSITIVE_TARGET: [
    "Fixed target overlaps a sensitive rule",
    "Choose a target unrelated to every sensitive matcher",
  ],
  CONFIG_ALIAS_CONFLICT: [
    "Fixed aliases overlap each other",
    "Use distinct aliases that are not substrings of one another",
  ],
  CONFIG_TIMEOUT: [
    "Rule validation timed out",
    "Simplify regex rules, then /reload",
  ],
  MIGRATION_LOCKED: [
    "Configuration migration lock is busy",
    "Wait for other Pi processes; inspect a stale lock only after stopping them",
  ],
  MIGRATION_CHANGED: [
    "Configuration changed during migration",
    "Stop concurrent edits and /reload; source files are preserved",
  ],
  MIGRATION_LIMIT: [
    "Too many configuration candidates",
    "Consolidate old configuration files locally",
  ],
  MIGRATION_IO: [
    "Migration file operation failed",
    "Check permissions, free space and leftover files before retrying",
  ],
  PAYLOAD_JSON: [
    "Request is not serializable JSON",
    "Inspect the provider or another payload-modifying extension; no payload is logged",
  ],
  PAYLOAD_SIZE: [
    "Request exceeds the size limit",
    "Reduce history or tool output size, or start a new session",
  ],
  SCAN_TIMEOUT: [
    "Redaction worker timed out",
    "Simplify regex rules or reduce input size",
  ],
  WORKER_FAILED: [
    "Worker failed to start or exited early",
    "Verify all dist files and the Node version; reinstall if needed",
  ],
  SCAN_INTERNAL: [
    "Unexpected scan failure",
    "Review recent rule changes and retry with smaller input",
  ],
  SCAN_NUMBER_UNSAFE: [
    "Replacement would turn a numeric JSON value into an invalid number",
    "Narrow the rule so it does not match inside numeric fields such as timestamps or schema limits",
  ],
  SCAN_UNIQUE_FAILED: [
    "Could not generate a unique shape-preserving replacement",
    "The matched value is too short; match a longer value or set an explicit replacement",
  ],
  SCAN_ZERO_WIDTH: [
    "Regex produced a zero-width match",
    "Require a non-empty match in the numbered rule",
  ],
  SCAN_MATCH_LIMIT: [
    "Too many matches in one request",
    "Narrow overly broad rules or reduce input",
  ],
  SCAN_MAPPING_LIMIT: [
    "Mapping limit reached",
    "Start a new session or /reload; in-memory mappings reset",
  ],
  FIXED_MAPPING_CONFLICT: [
    "One original has conflicting replacements",
    "Use one replacement for overlapping matchers, then /reload",
  ],
  FIXED_ALIAS_REUSED: [
    "Fixed alias already maps to another original",
    "A fixed regex represents one original per instance; use random replacement or split literal rules",
  ],
  FIXED_SENSITIVE_TARGET: [
    "Replacement contains the matched original",
    "Choose a target without sensitive content",
  ],
  FIXED_OVERLAP: [
    "Fixed replacement partially overlaps another match",
    "Remove the partial overlap or use random rules; rule and otherRule show both rules",
  ],
  FIXED_ALIAS_CROSSING: [
    "Regex crosses a learned fixed alias",
    "Narrow the regex or choose a different alias",
  ],
  SCAN_COMPLEXITY: [
    "Request exceeds depth or node limits",
    "Reduce nested data and tool schema size",
  ],
  SCAN_JSON_REWRITE: [
    "Replacement breaks embedded JSON syntax",
    "Avoid rules spanning JSON syntax; match field values instead",
  ],
  SCAN_ATTACHMENT: [
    "Unsupported image, audio, video or file content",
    "Remove attachments or send reviewed text only",
  ],
  SCAN_KEY_COLLISION: [
    "Replacement creates duplicate object keys",
    "Use distinct targets or avoid matching schema keys",
  ],
  RESTORE_COMPLEXITY: [
    "Response nesting is too deep to restore",
    "Reduce nested structures or start a new session with /new",
  ],
  RESTORE_KEY_COLLISION: [
    "Restoring produced duplicate object keys",
    "Use more specific rules or fixed targets that cannot collide with schema keys",
  ],
  AUDIT_BATCH_LIMIT: [
    "Audit batch exceeds the size limit",
    "Reduce matched content per request",
  ],
  AUDIT_FULL: [
    "Audit log would exceed the size limit",
    "Review records, then run /protecter logs clear or archive locally",
  ],
  AUDIT_PARTIAL: [
    "Audit log has an incomplete last line",
    "Inspect locally or run /protecter logs clear; never upload the log",
  ],
  AUDIT_LOCKED: [
    "Audit lock stayed busy",
    "Wait for writers; stop all Pi processes before inspecting a stale lock",
  ],
  AUDIT_UNSAFE: [
    "Unsafe audit file",
    "Use an owned regular file without links; checks are not bypassed",
  ],
  AUDIT_IO: [
    "Audit file operation failed",
    "Check errno, permissions and free space; no path or content is exposed",
  ],
};

const DIAGNOSTIC_ZH: Record<string, [string, string]> = {
  INTERNAL: ["未预期的本地错误", "重载并检查安装包完整性"],
  NOT_READY: ["防护尚未初始化", "查看初始化错误，修复后重载"],
  UNSUPPORTED_PI: ["Pi 版本不受支持", "请使用受支持的 Pi 版本"],
  MACHINE_ID: ["无法获取机器标识", "检查系统机器标识访问权限，不使用随机回退"],
  CONFIG_JSON: ["配置 JSON 无效", "本地修复 JSON 语法后重载"],
  CONFIG_SCHEMA: [
    "配置结构或规则无效",
    "使用版本1、敏感词数组及文档字段，rule 为规则序号",
  ],
  CONFIG_REGEX: ["正则或标志无效", "修复指定规则，标志仅支持 gimsu"],
  CONFIG_TARGET: [
    "固定替换目标无效",
    "使用非空且少于8192字符的目标，不含保留名称",
  ],
  CONFIG_CONFLICT: ["规则定义冲突", "为同一匹配器设置一致的替换策略"],
  CONFIG_SIZE: [
    "配置超过体积或规则数上限",
    "减少配置体积或规则数，规则不会被截断",
  ],
  CONFIG_IO: ["无法访问配置", "检查本地权限、所有者和磁盘空间"],
  CONFIG_UNSAFE: ["配置文件不安全", "使用本人所有的普通文件，不含符号或硬链接"],
  CONFIG_EMPTY_MATCH: ["正则匹配空字符串", "修改指定规则，要求非空匹配"],
  CONFIG_SENSITIVE_TARGET: [
    "固定目标与敏感规则重叠",
    "选择与所有敏感匹配器无关的目标",
  ],
  CONFIG_ALIAS_CONFLICT: ["固定别名相互重叠", "使用互不包含的不同别名"],
  CONFIG_TIMEOUT: ["规则验证超时", "简化正则规则后重载"],
  MIGRATION_LOCKED: [
    "配置迁移锁被占用",
    "等待其他进程，全部停止后再检查残留锁",
  ],
  MIGRATION_CHANGED: [
    "迁移期间配置发生变化",
    "停止并发编辑后重载，源文件会保留",
  ],
  MIGRATION_LIMIT: ["候选配置过多", "在本地整理旧配置文件"],
  MIGRATION_IO: ["迁移文件操作失败", "检查权限、空间和残留文件后重试"],
  PAYLOAD_JSON: [
    "请求无法序列化为 JSON",
    "检查提供商或其他请求改写扩展，不记录请求内容",
  ],
  PAYLOAD_SIZE: ["请求超过体积上限", "减少历史或工具输出，或新建会话"],
  SCAN_TIMEOUT: ["脱敏 worker 超时", "简化正则规则或缩小输入"],
  WORKER_FAILED: [
    "worker 启动失败或提前退出",
    "检查 dist 文件完整性和 Node 版本，必要时重装",
  ],
  SCAN_INTERNAL: ["未预期的扫描错误", "检查最近的规则改动并缩小输入"],
  SCAN_NUMBER_UNSAFE: [
    "替换会把 JSON 数值变成无效数字",
    "缩小规则范围，避免匹配时间戳或结构上限等数值字段",
  ],
  SCAN_UNIQUE_FAILED: [
    "无法生成唯一的同形替换值",
    "命中内容过短或可选空间过小，请匹配更长内容或设置固定 replacement",
  ],
  SCAN_ZERO_WIDTH: ["正则产生零宽匹配", "修改指定规则，要求非空匹配"],
  SCAN_MATCH_LIMIT: ["单次请求匹配次数过多", "缩小过宽规则或减少输入"],
  SCAN_MAPPING_LIMIT: ["映射数量达到上限", "新建会话或重载，内存映射将重置"],
  FIXED_MAPPING_CONFLICT: [
    "同一原文存在冲突替换",
    "为重叠匹配器使用同一目标后重载",
  ],
  FIXED_ALIAS_REUSED: [
    "固定别名已映射其他原文",
    "固定正则在同一实例仅代表一种原文，改用随机替换或拆分字面规则",
  ],
  FIXED_SENSITIVE_TARGET: ["替换目标包含命中原文", "选择不含敏感内容的目标"],
  FIXED_OVERLAP: [
    "固定替换与其他匹配部分重叠",
    "消除部分重叠或改用随机规则，rule 与 otherRule 指出两条规则",
  ],
  FIXED_ALIAS_CROSSING: ["正则跨越已学习的固定别名", "缩小正则范围或更换别名"],
  SCAN_COMPLEXITY: ["请求超过层级或节点上限", "减少嵌套数据和工具结构体积"],
  SCAN_JSON_REWRITE: [
    "替换破坏内嵌 JSON 语法",
    "避免跨 JSON 语法的规则，改为匹配字段值",
  ],
  SCAN_ATTACHMENT: [
    "不支持图片、音频、视频或文件内容",
    "移除附件或仅发送已审查的文本",
  ],
  SCAN_KEY_COLLISION: ["替换后对象键重复", "使用不同目标或避免匹配结构键"],
  RESTORE_COMPLEXITY: [
    "还原响应时层级过深",
    "减少嵌套结构，或使用 /new 开始新会话",
  ],
  RESTORE_KEY_COLLISION: [
    "还原后对象键重复",
    "使用更具体的规则或固定替换目标，避免与结构键冲突",
  ],
  AUDIT_BATCH_LIMIT: ["审计批次超过上限", "减少单个请求的命中内容"],
  AUDIT_FULL: ["审计日志将超过上限", "检查记录后清空日志或本地归档"],
  AUDIT_PARTIAL: ["审计日志末行不完整", "本地检查或清空日志，不要上传日志"],
  AUDIT_LOCKED: ["审计锁持续被占用", "等待写入完成，全部停止后再检查残留锁"],
  AUDIT_UNSAFE: ["审计文件不安全", "使用本人普通文件且不含链接，不会绕过检查"],
  AUDIT_IO: [
    "审计文件操作失败",
    "检查错误码、权限和磁盘空间，不暴露路径或内容",
  ],
};

const UI_EN = {
  blockedHeader: "SPI Protecter blocked this request",
  reasonLabel: "Reason",
  actionLabel: "Action",
  detailsLabel: "Details",
  statusReady: "ready",
  statusNotReady: "not ready",
  statusLine:
    "SPI Protecter: {state}; {rules}; {mappings}. Memory snapshot; /reload to refresh.",
  statusLastBlock: "Last block @ {at}:",
  statusNoBlock: "No recorded block in this session.",
  statusBarRules: "SPI Protecter · {rules}",
  statusBarNotReady: "SPI Protecter · not ready",
  emptyRules:
    "SPI Protecter: no rules configured; edit the local machine config, then /reload.",
  commandDescription: "View local SPI protection records",
  usage:
    "Usage: /protecter [logs [1-100|clear]|status|reload]. Never type secrets as arguments.",
  logsTuiOnly: "Open the local TUI to view protection records.",
  logsNone: "No readable records.",
  logsSelectTitle: "Protection records",
  logsTruncated: " (limited tail)",
  logsRevealTitle: "Sensitive plaintext",
  logsRevealBody: "Reveal locally? Never share this view.",
  logsPreviewTitle: "Local preview; edits are discarded",
  logsPreviewTruncated: "[Preview truncated]",
  clearTitle: "Clear the current audit log?",
  clearBody:
    "Irreversible. Only this machine's log is cleared; configuration and in-memory mappings stay. Later requests may add new records.",
  cleared: "Audit log cleared: {bytes}.",
  toolBlocked:
    "SPI Protecter blocked tool access to the protected configuration or audit log; edit it locally.",
  compactUnsupported:
    "SPI Protecter does not support remote context compaction yet; use /new to start a new session.",
};

type UiKey = keyof typeof UI_EN;

const UI_ZH: Record<UiKey, string> = {
  blockedHeader: "SPI Protecter 已阻止该请求",
  reasonLabel: "原因",
  actionLabel: "处理",
  detailsLabel: "详情",
  statusReady: "就绪",
  statusNotReady: "未就绪",
  statusLine:
    "SPI Protecter：{state}；{rules}；{mappings}。内存快照，重载后更新。",
  statusLastBlock: "最近一次拦截 @ {at}：",
  statusNoBlock: "本会话暂无拦截记录。",
  statusBarRules: "SPI Protecter · {rules}",
  statusBarNotReady: "SPI Protecter · 未就绪",
  emptyRules: "SPI Protecter：尚未配置规则，请编辑本地机器配置后重载。",
  commandDescription: "查看本地保护记录",
  usage:
    "用法：/protecter [logs [1-100|clear]|status|reload]。不要在参数中输入敏感内容。",
  logsTuiOnly: "请在本地 TUI 查看保护记录。",
  logsNone: "暂无可读记录。",
  logsSelectTitle: "保护记录",
  logsTruncated: "（仅显示有限尾部）",
  logsRevealTitle: "敏感明文",
  logsRevealBody: "确认在本地显示？请勿分享此界面。",
  logsPreviewTitle: "本地预览，编辑不会保存",
  logsPreviewTruncated: "[预览已截断]",
  clearTitle: "确认清空当前审计日志？",
  clearBody:
    "不可撤销。仅清空本机日志，配置和内存映射保留；后续请求可能写入新记录。",
  cleared: "已清空审计日志：{bytes}。",
  toolBlocked:
    "SPI Protecter 已阻止工具访问受保护的配置或审计日志，请在本地编辑。",
  compactUnsupported:
    "SPI Protecter 暂不支持远程上下文压缩，请使用 /new 开始新会话。",
};

/** Environment variables win over Intl so containers stay predictable. / 环境变量优先于 Intl，便于容器环境保持可预测。 */
export function detectLocale(
  env: Record<string, string | undefined> = process.env,
): Locale {
  const raw =
    env.PI_PROTECTER_LANG ||
    env.LC_ALL ||
    env.LC_MESSAGES ||
    env.LANG ||
    env.LANGUAGE ||
    resolvedLocale();
  return /^zh\b|^zh[-_]/i.test(raw.trim()) ? "zh" : "en";
}

function resolvedLocale(): string {
  try {
    return new Intl.DateTimeFormat().resolvedOptions().locale;
  } catch {
    return "";
  }
}

let active: Locale = detectLocale();
export function getLocale(): Locale {
  return active;
}
/** Exposed for tests and explicit overrides. / 供测试和显式覆盖使用。 */
export function setLocale(locale: Locale): void {
  active = locale;
}

export function t(
  key: UiKey,
  params: Record<string, string | number> = {},
): string {
  const template = (active === "zh" ? UI_ZH : UI_EN)[key] ?? UI_EN[key];
  return template.replace(/\{(\w+)\}/g, (match, name) =>
    Object.hasOwn(params, name) ? String(params[name]) : match,
  );
}

// Counted nouns need locale plural rules; Intl already implements them.
// 带数量的名词需要语言复数规则，Intl 已内置实现。
const COUNTS = {
  en: {
    rules: { one: "{n} rule", other: "{n} rules" },
    mappings: { one: "{n} mapping", other: "{n} mappings" },
    bytes: { one: "{n} byte", other: "{n} bytes" },
  },
  zh: {
    rules: { other: "规则 {n} 条" },
    mappings: { other: "映射 {n} 个" },
    bytes: { other: "{n} 字节" },
  },
} as const;

export type CountKind = keyof (typeof COUNTS)["en"];
const pluralRules = new Map<Locale, Intl.PluralRules>();

/** Select the plural form for the active locale. / 按当前语言选择复数形式。 */
export function count(kind: CountKind, value: number): string {
  const tag = active === "zh" ? "zh-CN" : "en";
  let rules = pluralRules.get(active);
  if (!rules) {
    try {
      rules = new Intl.PluralRules(tag);
    } catch {
      rules = undefined;
    }
    if (rules) pluralRules.set(active, rules);
  }
  const category = rules?.select(value) ?? "other";
  const forms: Record<string, string> = COUNTS[active][kind];
  const template = forms[category] ?? forms.other;
  const formatted = new Intl.NumberFormat(tag).format(value);
  return template.replace("{n}", formatted);
}

/** Fall back to English text when a code lacks a translation. / 缺少译文时回退英文。 */
export function describeCode(code: string): { reason: string; action: string } {
  const localized = active === "zh" ? DIAGNOSTIC_ZH[code] : DIAGNOSTIC_EN[code];
  const entry = localized ?? DIAGNOSTIC_EN[code] ?? DIAGNOSTIC_EN.INTERNAL;
  return { reason: entry[0], action: entry[1] };
}
