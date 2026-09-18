import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { CONFIG_NAME } from "./migration.ts";
import { fileURLToPath } from "node:url";

function normalized(path: string, cwd: string): string {
  let value = path.replace(/^@/, "");
  if (value.startsWith("file://")) value = fileURLToPath(value);
  if (value === "~" || value.startsWith("~/"))
    value = homedir() + value.slice(1);
  return resolve(cwd, value);
}
function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    const parent = dirname(path);
    return parent === path
      ? path
      : resolve(canonical(parent), relative(parent, path));
  }
}
function contains(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
function sameFile(a: string, b: string): boolean {
  try {
    const x = statSync(a),
      y = statSync(b);
    return x.dev === y.dev && x.ino === y.ino;
  } catch {
    return false;
  }
}

/**
 * Best-effort access guard. Arbitrary shell/third-party tools are NOT sandboxed.
 * 尽力而为的访问防护，不对任意 shell 或第三方工具提供沙箱隔离。
 */
export function blocksConfigAccess(
  tool: string,
  input: Record<string, unknown>,
  cwd: string,
  configPath: string,
): boolean {
  if (!configPath) return true;
  const target = canonical(resolve(configPath));
  // Inspect executable fields, not document bodies. / 检查可执行字段，不检查文档正文。
  if (["bash", "powershell"].includes(tool)) {
    const command = typeof input.command === "string" ? input.command : "";
    if (/protecter(?:\.[a-f0-9]{32})?\.json|\.protecter-migration/i.test(command) || command.includes(configPath)) return true;
  }
  const candidate = input.path ?? input.file_path ?? input.filePath;
  const recursive = ["grep", "find", "ls"].includes(tool);
  if (typeof candidate !== "string" && !recursive) return false;
  try {
    const path = normalized(
      typeof candidate === "string" ? candidate : ".",
      cwd,
    );
    const real = canonical(path);
    return (
      (dirname(real) === dirname(target) && (CONFIG_NAME.test(basename(real)) || basename(real).startsWith(".protecter-migration"))) ||
      real === target ||
      sameFile(path, configPath) ||
      (recursive && contains(real, target))
    );
  } catch {
    return true;
  }
}
