import * as fs from "node:fs";
import { randomUUID } from "node:crypto";

export const AUDIT_ERROR = "SPI Protecter: audit unavailable; request blocked / 审计日志不可用，请求已阻止。";
export interface AuditRecord {
  version: 1;
  time: string;
  timezoneOffset: number;
  requestId: string;
  provider: string;
  original: string;
  replacement: string;
}
const MAX_LOG = 32 * 1024 * 1024;
const MAX_BATCH = 8 * 1024 * 1024;

export function localTimestamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function openPrivate(path: string, write: boolean): number {
  const fd = fs.openSync(path, (write ? fs.constants.O_RDWR | fs.constants.O_CREAT : fs.constants.O_RDONLY) | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK, 0o600);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || (process.getuid && stat.uid !== process.getuid())) throw new Error();
    if (process.platform !== "win32") fs.fchmodSync(fd, 0o600);
    return fd;
  } catch { fs.closeSync(fd); throw new Error(AUDIT_ERROR); }
}

/** Persist only successful redactions, never full payloads. / 仅持久化成功替换，不记录完整请求体。 */
export async function appendAudit(path: string, provider: string, hits: [string, string][]): Promise<void> {
  if (!hits.length) return;
  const now = new Date(), requestId = randomUUID();
  const batch = Buffer.from(hits.map(([replacement, original]) => JSON.stringify({ version: 1, time: localTimestamp(now), timezoneOffset: -now.getTimezoneOffset(), requestId, provider: provider || "unknown", original, replacement } satisfies AuditRecord)).join("\n") + "\n");
  if (batch.length > MAX_BATCH) throw new Error(AUDIT_ERROR);
  const lock = `${path}.lock`, deadline = Date.now() + 2000;
  for (;;) {
    try { fs.mkdirSync(lock, { mode: 0o700 }); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || Date.now() >= deadline) throw new Error(AUDIT_ERROR);
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  let fd: number | undefined;
  try {
    fd = openPrivate(path, true);
    const size = fs.fstatSync(fd).size;
    if (size + batch.length > MAX_LOG) throw new Error();
    if (size) {
      const tail = Buffer.alloc(1);
      fs.readSync(fd, tail, 0, 1, size - 1);
      if (tail[0] !== 10) throw new Error();
    }
    try {
      let written = 0;
      while (written < batch.length) {
        const n = fs.writeSync(fd, batch, written, batch.length - written, size + written);
        if (!n) throw new Error();
        written += n;
      }
      fs.fsyncSync(fd);
    } catch {
      // Roll back partial writes while holding the cooperative lock. / 持有协作锁时回滚部分写入。
      fs.ftruncateSync(fd, size);
      fs.fsyncSync(fd);
      throw new Error();
    }
  } catch { throw new Error(AUDIT_ERROR); }
  finally {
    if (fd !== undefined) fs.closeSync(fd);
    fs.rmdirSync(lock);
  }
}

/** Read a bounded tail for explicit local display, never for model context. / 仅为显式本地展示读取有限尾部，不进入模型上下文。 */
export function readAudit(path: string, limit = 20): { records: AuditRecord[]; truncated: boolean } {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error(AUDIT_ERROR);
  let fd: number | undefined;
  try {
    try { fd = openPrivate(path, false); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { records: [], truncated: false };
      throw error;
    }
    const size = fs.fstatSync(fd).size, start = Math.max(0, size - 1024 * 1024);
    const buffer = Buffer.alloc(size - start);
    const count = fs.readSync(fd, buffer, 0, buffer.length, start);
    let text = buffer.subarray(0, count).toString("utf8");
    if (start) { const newline = text.indexOf("\n"); text = newline < 0 ? "" : text.slice(newline + 1); }
    const lines = text.split("\n");
    const partial = lines.pop() !== "";
    const records: AuditRecord[] = [];
    let invalid = false;
    for (const line of lines.slice(-limit)) {
      try {
        const r = JSON.parse(line);
        if (r.version !== 1 || typeof r.time !== "string" || typeof r.provider !== "string" || typeof r.original !== "string" || typeof r.replacement !== "string" || typeof r.requestId !== "string" || typeof r.timezoneOffset !== "number") throw new Error();
        records.push(r);
      } catch { invalid = true; }
    }
    return { records, truncated: start > 0 || lines.length > limit || partial || invalid };
  } catch { throw new Error(AUDIT_ERROR); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
