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
 * only safe options are to summarize redacted text ourselves or to refuse.
 * 上下文压缩的处理方式。Pi 在内部构造摘要请求，不经过 `before_provider_request`，
 * 因此只有两种安全选择：由本扩展对脱敏后的文本生成摘要，或直接拒绝。
 *
 * - `ask`: confirm each compaction, then summarize redacted text. / 每次确认后，对脱敏文本生成摘要。
 * - `protected`: summarize redacted text without asking. / 不询问，直接对脱敏文本生成摘要。
 * - `off`: always refuse. / 始终拒绝。
 */
export type CompactionMode = "ask" | "protected" | "off";
export const COMPACTION_MODES: CompactionMode[] = ["ask", "protected", "off"];

/**
 * A dedicated summarization model. The conversation is redacted before it is
 * sent, but it is still an entire conversation leaving for a second
 * destination, so prefer a local or otherwise trusted endpoint.
 * 专用的摘要模型。发送前会先脱敏，但毕竟是整段对话发往第二个目的地，应优先使用
 * 本地或可信端点。
 *
 * A smaller summarization model must also drive the compaction threshold:
 * waiting for the main model's window would hand it more text than it can read.
 * 较小的摘要模型还必须决定压缩阈值：若等到主模型的窗口才触发，交给它的文本会超出
 * 其可读取范围。
 */
export interface CompactionSettings {
  mode: CompactionMode;
  provider?: string;
  model?: string;
  /**
   * Both are inherited and only needed as overrides: the window comes from
   * Pi's model catalogue, and the reserve from Pi's own compaction settings.
   * Set the window for a private endpoint Pi does not know, and the reserve
   * only when the summarization model needs a different margin.
   * 两者均会继承，仅在需要覆盖时填写：窗口来自 Pi 的模型目录，预留值来自 Pi 自身的
   * 压缩设置。Pi 未收录的私有端点需填窗口，摘要模型需要不同余量时才填预留值。
   */
  contextWindow?: number;
  reserveTokens?: number;
}

export interface Config {
  version: 1;
  sensitiveWords: Rule[];
  compaction?: CompactionMode | CompactionSettings;
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
  const allowed = [
    "mode",
    "provider",
    "model",
    "contextWindow",
    "reserveTokens",
  ];
  if (Object.keys(settings).some((key) => !allowed.includes(key)))
    throw failure("CONFIG_COMPACTION");
  if (
    settings.mode !== undefined &&
    !COMPACTION_MODES.includes(settings.mode as CompactionMode)
  )
    throw failure("CONFIG_COMPACTION");
  for (const key of ["provider", "model"] as const) {
    const entry = settings[key];
    if (entry === undefined) continue;
    if (typeof entry !== "string" || !entry.trim() || entry.length > 200)
      throw failure("CONFIG_COMPACTION");
  }
  // A provider without a model, or the reverse, cannot resolve to anything.
  // 只写 provider 或只写 model 都无法解析出模型。
  if (
    (settings.provider === undefined) !== (settings.model === undefined)
  )
    throw failure("CONFIG_COMPACT_MODEL");
  for (const key of ["contextWindow", "reserveTokens"] as const) {
    const entry = settings[key];
    if (entry === undefined) continue;
    if (
      typeof entry !== "number" ||
      !Number.isSafeInteger(entry) ||
      entry <= 0 ||
      entry > 100_000_000
    )
      throw failure("CONFIG_COMPACTION");
  }
  // Reserving the whole window would leave no room for the conversation.
  // 预留整个窗口将不给对话留下空间。
  const window = settings.contextWindow as number | undefined;
  const reserve = settings.reserveTokens as number | undefined;
  if (window !== undefined && reserve !== undefined && reserve >= window)
    throw failure("CONFIG_COMPACTION");
}

/** Normalize either accepted form into one shape. / 将两种写法归一为同一结构。 */
export function compactionSettings(
  value: Config["compaction"],
): CompactionSettings {
  if (value === undefined) return { mode: DEFAULT_COMPACTION };
  if (typeof value === "string") return { mode: value };
  return { ...value, mode: value.mode ?? DEFAULT_COMPACTION };
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
        (k) => !["version", "sensitiveWords", "compaction"].includes(k),
      )
    )
      throw failure("CONFIG_SCHEMA");
    if (Object.hasOwn(value, "compaction"))
      validateCompaction((value as { compaction?: unknown }).compaction);
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
