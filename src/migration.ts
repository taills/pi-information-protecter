import * as fs from "node:fs";
import { join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { CONFIG_ERROR, DEFAULT_CONFIG, loadConfig, parseConfig, type Config, type Rule } from "./config.ts";

export const CONFIG_NAME = /^protecter(?:\.[a-f0-9]{32})?\.json$/;
export interface Snapshot { path: string; config: Config; raw: string; sourceRaws: string[]; migrated: number }
interface Source { name: string; raw: string; config: Config; identity: string; digest: string }
export interface MigrationOptions {
  lockTimeoutMs?: number;
  // Local fault injection for regression tests only. / 仅供本地回归测试注入故障。
  checkpoint?: (stage: "beforeCommit" | "afterCommit" | "beforeDelete", path: string) => void;
}

export function validatePatterns(configs: Config[]): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const worker = new Worker(fileURLToPath(new URL("./validate-worker.mjs", import.meta.url)), { workerData: configs, execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 64 } });
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      void worker.terminate();
      if (ok) resolvePromise(); else reject(new Error(CONFIG_ERROR));
    };
    const timer = setTimeout(() => finish(false), 2000);
    worker.once("message", value => finish(value === true));
    worker.once("error", () => finish(false));
    worker.once("exit", () => finish(false));
  });
}

export function mergeConfigs(configs: Config[]): Config {
  const seen = new Set<string>();
  const rules: Rule[] = [];
  for (const config of configs) for (const rule of config.sensitiveWords) {
    const key = typeof rule === "string" ? JSON.stringify(["literal", rule]) : rule.type === "literal" ? JSON.stringify(["literal", rule.value]) : JSON.stringify(["regex", rule.pattern, [...new Set((rule.flags ?? "") + "g")].sort().join("")]);
    if (!seen.has(key)) { seen.add(key); rules.push(rule); }
  }
  const raw = JSON.stringify({ version: 1, sensitiveWords: rules });
  if (Buffer.byteLength(raw) > 1024 * 1024) throw new Error(CONFIG_ERROR);
  return parseConfig(raw);
}

function identity(path: string): string {
  const s = fs.lstatSync(path, { bigint: true });
  if (!s.isFile() || s.nlink !== 1n || (process.getuid && s.uid !== BigInt(process.getuid()))) throw new Error(CONFIG_ERROR);
  return `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}`;
}
function source(dir: string, name: string): Source {
  const path = join(dir, name), before = identity(path);
  const loaded = loadConfig(path);
  if (identity(path) !== before) throw new Error(CONFIG_ERROR);
  return { name, ...loaded, identity: before, digest: createHash("sha256").update(loaded.raw).digest("hex") };
}
function unchanged(dir: string, previous: Source): void {
  const now = source(dir, previous.name);
  if (now.identity !== previous.identity || now.digest !== previous.digest) throw new Error(CONFIG_ERROR);
}
function names(dir: string): string[] { return fs.readdirSync(dir).filter(name => CONFIG_NAME.test(name)).sort(); }
function syncDir(dir: string): void {
  // Windows does not support POSIX directory fsync. / Windows 不支持 POSIX 目录同步。
  if (process.platform === "win32") return;
  const fd = fs.openSync(dir, fs.constants.O_RDONLY);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

/** Commit before deleting; repeat safely after partial cleanup. / 先提交再删除，部分清理后可安全重试。 */
export async function migrateConfig(directory: string, hash: string, options: MigrationOptions = {}): Promise<Snapshot> {
  if (!/^[a-f0-9]{32}$/.test(hash)) throw new Error(CONFIG_ERROR);
  const dir = resolve(directory), targetName = `protecter.${hash}.json`, path = join(dir, targetName);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lock = join(dir, ".protecter-migration.lock"), deadline = Date.now() + (options.lockTimeoutMs ?? 5000);
  for (;;) {
    try { fs.mkdirSync(lock, { mode: 0o700 }); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || Date.now() >= deadline) throw new Error("SPI Protecter: migration locked; check active processes / 迁移锁被占用，请检查活动进程。");
      await new Promise(resolvePromise => setTimeout(resolvePromise, 50));
    }
  }
  let temp: string | undefined;
  try {
    const discovered = names(dir);
    if (discovered.length > 64) throw new Error(CONFIG_ERROR);
    const ordered = [...discovered].sort((a, b) => a === targetName ? -1 : b === targetName ? 1 : a.localeCompare(b));
    const sources = ordered.map(name => source(dir, name));
    const config = mergeConfigs(sources.length ? sources.map(s => s.config) : [DEFAULT_CONFIG]);
    await validatePatterns(sources.length ? sources.map(s => s.config) : [config]);
    if (sources.length === 1 && sources[0].name === targetName) {
      unchanged(dir, sources[0]);
      if (JSON.stringify(names(dir)) !== JSON.stringify(discovered)) throw new Error(CONFIG_ERROR);
      return { path, config: sources[0].config, raw: sources[0].raw, sourceRaws: [sources[0].raw], migrated: 0 };
    }
    const raw = JSON.stringify(config, null, 2) + "\n";
    if (Buffer.byteLength(raw) > 1024 * 1024) throw new Error(CONFIG_ERROR);
    temp = join(dir, `.protecter-migration.${randomUUID()}.tmp`);
    const fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    try { fs.writeFileSync(fd, raw); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    options.checkpoint?.("beforeCommit", path);
    if (JSON.stringify(names(dir)) !== JSON.stringify(discovered)) throw new Error(CONFIG_ERROR);
    for (const s of sources) unchanged(dir, s);
    fs.renameSync(temp, path);
    temp = undefined;
    syncDir(dir);
    const committed = source(dir, targetName);
    if (committed.raw !== raw) throw new Error(CONFIG_ERROR);
    options.checkpoint?.("afterCommit", path);
    for (const s of sources) {
      if (s.name === targetName) continue;
      options.checkpoint?.("beforeDelete", join(dir, s.name));
      unchanged(dir, committed);
      unchanged(dir, s);
      fs.unlinkSync(join(dir, s.name));
    }
    syncDir(dir);
    const expected = [targetName];
    if (JSON.stringify(names(dir)) !== JSON.stringify(expected)) throw new Error(CONFIG_ERROR);
    unchanged(dir, committed);
    return { path, config, raw, sourceRaws: [...new Set([...sources.map(s => s.raw), raw])], migrated: sources.filter(s => s.name !== targetName).length };
  } catch { throw new Error(CONFIG_ERROR); }
  finally {
    if (temp) { try { fs.unlinkSync(temp); } catch { /* Preserve on failure. / 失败时保留待人工检查。 */ } }
    fs.rmdirSync(lock);
  }
}
