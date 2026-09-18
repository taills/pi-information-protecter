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

export type Rule =
  | string
  | { type: "literal"; value: string }
  | { type: "regex"; pattern: string; flags?: string };
export interface Config {
  version: 1;
  sensitiveWords: Rule[];
}
export const DEFAULT_CONFIG: Config = { version: 1, sensitiveWords: [] };
export const CONFIG_ERROR =
  "protecter: 配置无法安全读取或格式无效；请在本地修复 protecter.json。";

export function parseConfig(raw: string): Config {
  try {
    const value = JSON.parse(raw);
    if (
      !value ||
      value.version !== 1 ||
      !Array.isArray(value.sensitiveWords) ||
      value.sensitiveWords.length > 1000 ||
      Object.keys(value).some((k) => !["version", "sensitiveWords"].includes(k))
    )
      throw new Error();
    for (const rule of value.sensitiveWords) {
      if (typeof rule === "string") {
        if (!rule || rule.length > 8192) throw new Error();
        continue;
      }
      if (!rule || typeof rule !== "object") throw new Error();
      if (rule.type === "literal") {
        if (
          Object.keys(rule).some((k) => !["type", "value"].includes(k)) ||
          typeof rule.value !== "string" ||
          !rule.value ||
          rule.value.length > 8192
        )
          throw new Error();
      } else if (rule.type === "regex") {
        if (
          Object.keys(rule).some(
            (k) => !["type", "pattern", "flags"].includes(k),
          ) ||
          typeof rule.pattern !== "string" ||
          !rule.pattern ||
          rule.pattern.length > 8192 ||
          (rule.flags !== undefined &&
            (typeof rule.flags !== "string" || !/^[gimsu]*$/.test(rule.flags)))
        )
          throw new Error();
        const re = new RegExp(rule.pattern, rule.flags ?? "");
        if (re.test("")) throw new Error();
      } else throw new Error();
    }
    return value;
  } catch {
    throw new Error(CONFIG_ERROR);
  }
}

/** Do not follow a symlink, accept a hard-linked file, or print parser/OS errors containing secrets. */
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
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    fd = openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.size > 1024 * 1024 ||
      (process.getuid && stat.uid !== process.getuid())
    )
      throw new Error();
    if (process.platform !== "win32") fchmodSync(fd, 0o600);
    const raw = readFileSync(fd, "utf8");
    if (Buffer.byteLength(raw) > 1024 * 1024) throw new Error();
    return { config: parseConfig(raw), raw };
  } catch {
    throw new Error(CONFIG_ERROR);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
