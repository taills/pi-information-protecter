import { describeCode, getLocale, t } from "./locale.ts";

/** Codes and stages stay language-neutral so they remain greppable. / 错误码与阶段保持语言无关，便于检索。 */
const stages = {
  INTERNAL: "internal",
  NOT_READY: "initialization",
  UNSUPPORTED_PI: "initialization",
  MACHINE_ID: "initialization",
  CONFIG_JSON: "configuration",
  CONFIG_SCHEMA: "configuration",
  CONFIG_REGEX: "configuration",
  CONFIG_TARGET: "configuration",
  CONFIG_CONFLICT: "configuration",
  CONFIG_SIZE: "configuration",
  CONFIG_IO: "configuration",
  CONFIG_UNSAFE: "configuration",
  CONFIG_EMPTY_MATCH: "configuration",
  CONFIG_SENSITIVE_TARGET: "configuration",
  CONFIG_ALIAS_CONFLICT: "configuration",
  CONFIG_TIMEOUT: "configuration",
  CONFIG_COMPACTION: "configuration",
  CONFIG_COMPACT_MODEL: "configuration",
  MIGRATION_LOCKED: "migration",
  MIGRATION_CHANGED: "migration",
  MIGRATION_LIMIT: "migration",
  MIGRATION_IO: "migration",
  PAYLOAD_JSON: "request",
  PAYLOAD_SIZE: "request",
  SCAN_TIMEOUT: "scan",
  WORKER_FAILED: "worker",
  SCAN_INTERNAL: "scan",
  SCAN_NUMBER_UNSAFE: "scan",
  SCAN_UNIQUE_FAILED: "scan",
  SCAN_ZERO_WIDTH: "scan",
  SCAN_MATCH_LIMIT: "scan",
  SCAN_MAPPING_LIMIT: "scan",
  FIXED_MAPPING_CONFLICT: "scan",
  FIXED_ALIAS_REUSED: "scan",
  FIXED_SENSITIVE_TARGET: "scan",
  FIXED_OVERLAP: "scan",
  FIXED_ALIAS_CROSSING: "scan",
  SCAN_COMPLEXITY: "scan",
  SCAN_JSON_REWRITE: "scan",
  SCAN_ATTACHMENT: "scan",
  SCAN_KEY_COLLISION: "scan",
  RESTORE_COMPLEXITY: "restore",
  RESTORE_KEY_COLLISION: "restore",
  COMPACT_DENIED: "compaction",
  COMPACT_UNAVAILABLE: "compaction",
  COMPACT_FAILED: "compaction",
  COMPACT_EMPTY: "compaction",
  AUDIT_BATCH_LIMIT: "audit",
  AUDIT_FULL: "audit",
  AUDIT_PARTIAL: "audit",
  AUDIT_LOCKED: "audit",
  AUDIT_UNSAFE: "audit",
  AUDIT_IO: "audit",
} as const;

/** Exported so tests can assert every code has catalog text. / 导出以便测试断言每个错误码都有文案。 */
export const STAGES = stages;
export type DiagnosticCode = keyof typeof stages;
const COORDS = [
  "rule",
  "otherRule",
  "node",
  "bytes",
  "limit",
  "timeoutMs",
  "status",
] as const;
// An error class name identifies the failure kind without quoting content.
// 错误类名可标识失败类型，且不引用任何内容。
const ERROR_NAME = /^[A-Za-z][A-Za-z0-9]{0,39}$/;
const ERRNO =
  /^(EACCES|EPERM|ENOENT|ENOSPC|EDQUOT|EROFS|ELOOP|EISDIR|ENOTDIR|EMFILE|ENFILE|EIO|EEXIST|EBADF|EBUSY|ENOTEMPTY)$/;

export interface Details {
  rule?: number;
  otherRule?: number;
  node?: number;
  bytes?: number;
  limit?: number;
  timeoutMs?: number;
  /** HTTP status from a provider response. / 提供商响应的 HTTP 状态码。 */
  status?: number;
  errno?: string;
  /** Error class name only, never its message. / 仅错误类名，不包含消息。 */
  errorName?: string;
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
export function diagnostic(
  code: DiagnosticCode,
  details: Details = {},
): Diagnostic {
  const { reason, action } = describeCode(code);
  const safe: Details = {};
  for (const key of COORDS) {
    const value = details[key];
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
      safe[key] = value;
  }
  if (typeof details.errno === "string" && ERRNO.test(details.errno))
    safe.errno = details.errno;
  if (
    typeof details.errorName === "string" &&
    ERROR_NAME.test(details.errorName)
  )
    safe.errorName = details.errorName;
  return { code, stage: stages[code], reason, action, ...safe };
}

export function formatDiagnostic(value: Diagnostic): string {
  const separator = getLocale() === "zh" ? "：" : ": ";
  const coords = [...COORDS, "errno" as const, "errorName" as const]
    .filter((key) => value[key] !== undefined)
    .map((key) => `${key}=${value[key]}`)
    .join(" ");
  return [
    t("blockedHeader"),
    `code=${value.code} stage=${value.stage}${coords ? ` ${coords}` : ""}`,
    `${t("reasonLabel")}${separator}${value.reason}`,
    `${t("actionLabel")}${separator}${value.action}`,
    `${t("detailsLabel")}${separator}/protecter status`,
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

export function failure(
  code: DiagnosticCode,
  details: Details = {},
): ProtectionError {
  return new ProtectionError(code, details);
}

/** Keep OS errno but never reuse a raw message. / 保留系统错误码，但不复用原始消息。 */
export function sanitizeError(
  error: unknown,
  fallback: DiagnosticCode,
  details: Details = {},
): ProtectionError {
  if (error instanceof ProtectionError)
    return failure(error.diagnostic.code, { ...error.diagnostic, ...details });
  const errno =
    error && typeof error === "object" && "code" in error
      ? (error as { code?: unknown }).code
      : undefined;
  return failure(fallback, {
    ...details,
    errno: typeof errno === "string" ? errno : undefined,
  });
}

/** Accept only catalog codes from worker boundaries. / worker 边界仅接受目录内错误码。 */
export function workerError(
  value: unknown,
  fallback: DiagnosticCode,
): ProtectionError {
  if (!value || typeof value !== "object") return failure(fallback);
  const data = value as { code?: unknown } & Details;
  const code =
    typeof data.code === "string" && Object.hasOwn(stages, data.code)
      ? (data.code as DiagnosticCode)
      : fallback;
  return failure(code, data);
}
