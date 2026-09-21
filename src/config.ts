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
export interface Config {
  version: 1;
  sensitiveWords: Rule[];
}
export const DEFAULT_CONFIG: Config = { version: 1, sensitiveWords: [] };

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
      Object.keys(value).some((k) => !["version", "sensitiveWords"].includes(k))
    )
      throw failure("CONFIG_SCHEMA");
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
