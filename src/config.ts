import {
  constants,
  closeSync,
  fchmodSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { failure, ProtectionError, sanitizeError } from "./diagnostics.ts";

export type Rule =
  | string
  | { type: "literal"; value: string; replacement?: string }
  | { type: "regex"; pattern: string; flags?: string; replacement?: string };
/**
 * How to handle context compaction. Pi builds the summarization request
 * internally and never routes it through `before_provider_request`, so the
 * only safe options are to redact what Pi is about to summarize, or to refuse.
 * 上下文压缩的处理方式。Pi 在内部构造摘要请求，不经过 `before_provider_request`，
 * 因此只有两种安全选择：对 Pi 即将摘要的内容先脱敏，或直接拒绝。
 *
 * Pi summarizes with the session's own model, so a single configured model is
 * enough and nothing here selects one.
 * Pi 使用会话自身的模型生成摘要，因此只配一个模型也足够，此处不再选择模型。
 *
 * - `ask`: confirm each compaction, then redact what Pi summarizes. / 每次确认后，对 Pi 要摘要的内容脱敏。
 * - `protected`: redact without asking. / 不询问，直接脱敏。
 * - `off`: always refuse. / 始终拒绝。
 */
export type CompactionMode = "ask" | "protected" | "off";
export const COMPACTION_MODES: CompactionMode[] = ["ask", "protected", "off"];

export interface CompactionSettings {
  mode: CompactionMode;
}

/**
 * Accepted but ignored since 0.11.0, when summarization moved back to Pi and
 * the session's own model. Rejecting them would fail the whole configuration
 * closed and block every request of an otherwise working setup, so they are
 * reported at startup instead.
 * 自 0.11.0 起只接收、不生效：摘要已交回 Pi 及会话自身的模型。直接拒绝会使整份配置
 * 失败并拦住原本可用环境的所有请求，因此改为在启动时上报。
 */
export const IGNORED_COMPACTION_KEYS = [
  "provider",
  "model",
  "contextWindow",
  "reserveTokens",
] as const;

/** Which ignored keys a configuration still carries. / 配置中仍存在哪些已忽略项。 */
export function ignoredCompactionKeys(value: Config["compaction"]): string[] {
  if (!value || typeof value !== "object") return [];
  return IGNORED_COMPACTION_KEYS.filter((key) => Object.hasOwn(value, key));
}

export interface Config {
  version: 1;
  sensitiveWords: Rule[];
  compaction?: CompactionMode | CompactionSettings;
  attachments?: "ask" | "allow" | "deny";
}
export const DEFAULT_CONFIG: Config = { version: 1, sensitiveWords: [] };
/** Asking is the default: compaction stays visible instead of silent. / 默认询问，不让压缩静默发生。 */
export const DEFAULT_COMPACTION: CompactionMode = "ask";

/**
 * Reject anything the compaction path cannot act on, at load time rather than
 * when the context fills up and compaction is the only way forward.
 * 在加载时拒绝压缩路径无法使用的配置，而不是等到上下文冒满、只能靠压缩时才报错。
 */
function validateCompaction(value: unknown): void {
  if (typeof value === "string") {
    if (!COMPACTION_MODES.includes(value as CompactionMode))
      throw failure("CONFIG_COMPACTION");
    return;
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw failure("CONFIG_COMPACTION");
  const settings = value as Record<string, unknown>;
  const allowed = ["mode", ...IGNORED_COMPACTION_KEYS];
  if (Object.keys(settings).some((key) => !allowed.includes(key as never)))
    throw failure("CONFIG_COMPACTION");
  if (
    settings.mode !== undefined &&
    !COMPACTION_MODES.includes(settings.mode as CompactionMode)
  )
    throw failure("CONFIG_COMPACTION");
  // The ignored keys are only checked for a plausible type: they no longer
  // select anything, so a stale value must not decide whether requests flow.
  // 已忽略的项只做类型粗检：它们不再决定任何行为，陈旧取值不应左右请求能否通过。
  for (const key of IGNORED_COMPACTION_KEYS) {
    const entry = settings[key];
    if (entry === undefined) continue;
    if (typeof entry !== "string" && typeof entry !== "number")
      throw failure("CONFIG_COMPACTION");
  }
}

/** Normalize either accepted form into one shape. / 将两种写法归一为同一结构。 */
export function compactionSettings(
  value: Config["compaction"],
): CompactionSettings {
  if (value === undefined) return { mode: DEFAULT_COMPACTION };
  if (typeof value === "string") return { mode: value };
  // Return only the mode: an ignored key must not travel on as if it applied.
  // 仅返回 mode：已忽略的项不应继续传递，以免看似仍在生效。
  return { mode: value.mode ?? DEFAULT_COMPACTION };
}

export function parseConfig(raw: string): Config {
  let value: { version?: unknown; sensitiveWords?: unknown };
  try {
    value = JSON.parse(raw);
  } catch {
    throw failure("CONFIG_JSON");
  }
  let index = 0;
  try {
    if (
      !value ||
      value.version !== 1 ||
      !Array.isArray(value.sensitiveWords) ||
      Object.keys(value).some(
        (k) => !["version", "sensitiveWords", "compaction", "attachments"].includes(k),
      )
    )
      throw failure("CONFIG_SCHEMA");
    if (Object.hasOwn(value, "compaction"))
      validateCompaction((value as { compaction?: unknown }).compaction);
    if (Object.hasOwn(value, "attachments") && !["ask", "allow", "deny"].includes((value as { attachments?: string }).attachments ?? ""))
      throw failure("CONFIG_ATTACHMENT");
    if (value.sensitiveWords.length > 1000)
      throw failure("CONFIG_SIZE", { limit: 1000 });
    const definitions = new Map<string, string | undefined>();
    for (const rule of value.sensitiveWords as Rule[]) {
      index++;
      if (typeof rule === "string") {
        if (!rule || rule.length > 8192)
          throw failure("CONFIG_SCHEMA", { rule: index, limit: 8192 });
        const key = JSON.stringify(["literal", rule]);
        if (definitions.has(key) && definitions.get(key) !== undefined)
          throw failure("CONFIG_CONFLICT", { rule: index });
        definitions.set(key, undefined);
        continue;
      }
      if (!rule || typeof rule !== "object")
        throw failure("CONFIG_SCHEMA", { rule: index });
      if (
        Object.hasOwn(rule, "replacement") &&
        (typeof rule.replacement !== "string" ||
          !rule.replacement.trim() ||
          rule.replacement.length > 8192 ||
          rule.replacement.includes("__PIP_"))
      )
        throw failure("CONFIG_TARGET", { rule: index, limit: 8192 });
      if (rule.type === "literal") {
        if (
          Object.keys(rule).some(
            (k) => !["type", "value", "replacement"].includes(k),
          ) ||
          typeof rule.value !== "string" ||
          !rule.value ||
          rule.value.length > 8192
        )
          throw failure("CONFIG_SCHEMA", { rule: index, limit: 8192 });
      } else if (rule.type === "regex") {
        if (
          Object.keys(rule).some(
            (k) => !["type", "pattern", "flags", "replacement"].includes(k),
          ) ||
          typeof rule.pattern !== "string" ||
          !rule.pattern ||
          rule.pattern.length > 8192 ||
          (rule.flags !== undefined &&
            (typeof rule.flags !== "string" || !/^[gimsu]*$/.test(rule.flags)))
        )
          throw failure("CONFIG_REGEX", { rule: index, limit: 8192 });
        // Compilation only here; matching is bounded in the worker. / 此处仅编译，匹配在限时 worker 内执行。
        try {
          void new RegExp(rule.pattern, rule.flags ?? "");
        } catch {
          throw failure("CONFIG_REGEX", { rule: index });
        }
      } else throw failure("CONFIG_SCHEMA", { rule: index });
      const key =
        rule.type === "literal"
          ? JSON.stringify(["literal", rule.value])
          : JSON.stringify([
              "regex",
              rule.pattern,
              [...new Set((rule.flags ?? "") + "g")].sort().join(""),
            ]);
      if (definitions.has(key) && definitions.get(key) !== rule.replacement)
        throw failure("CONFIG_CONFLICT", { rule: index });
      definitions.set(key, rule.replacement);
    }
    return value as Config;
  } catch (error) {
    throw error instanceof ProtectionError
      ? error
      : failure("CONFIG_SCHEMA", { rule: index });
  }
}

/**
 * Reject symlinks and hard links; never print parser/OS errors containing secrets.
 * 拒绝符号链接和硬链接；不输出可能包含敏感值的解析器或系统错误。
 */
export function loadConfig(
  path: string,
  create = false,
): { config: Config; raw: string } {
  let fd: number | undefined;
  try {
    if (create) {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      try {
        const initial = openSync(
          path,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
          0o600,
        );
        try {
          writeFileSync(
            initial,
            JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n",
          );
        } finally {
          closeSync(initial);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST")
          throw sanitizeError(error, "CONFIG_IO");
      }
    }
    fd = openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const stat = fstatSync(fd);
    if (stat.size > 1024 * 1024)
      throw failure("CONFIG_SIZE", { bytes: stat.size, limit: 1024 * 1024 });
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      (process.getuid && stat.uid !== process.getuid())
    )
      throw failure("CONFIG_UNSAFE");
    if (process.platform !== "win32") fchmodSync(fd, 0o600);
    const raw = readFileSync(fd, "utf8");
    if (Buffer.byteLength(raw) > 1024 * 1024)
      throw failure("CONFIG_SIZE", {
        bytes: Buffer.byteLength(raw),
        limit: 1024 * 1024,
      });
    return { config: parseConfig(raw), raw };
  } catch (error) {
    const errno =
      error && typeof error === "object" && "code" in error
        ? (error as { code?: unknown }).code
        : undefined;
    throw sanitizeError(
      error,
      errno === "ELOOP" || errno === "EISDIR" || errno === "ENOTDIR"
        ? "CONFIG_UNSAFE"
        : "CONFIG_IO",
    );
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
