/**
 * Local detection log: one JSON line per scan with a hit or an error. It holds
 * rule IDs, probabilities, actions and a content hash, never the content.
 * 本地检测日志：每次命中或出错的扫描写一行 JSON，仅含规则 ID、概率、动作与内容哈希，不含原文。
 */
import { constants, closeSync, fstatSync, openSync, readFileSync, writeSync } from "node:fs";
import { localTimestamp } from "../audit.ts";
import type { DetectionReport } from "./detector.ts";

const MAX_LOG = 16 * 1024 * 1024;

export interface DetectionRecord {
  version: 1;
  time: string;
  timezoneOffset: number;
  source: string;
  contentHash: string;
  block: boolean;
  hits: Array<{ rule: string; probability: number; action: string; kind: string }>;
  errors: string[];
  truncated: boolean;
  elapsedMs: number;
}

export function detectionLogPath(configPath: string): string {
  return configPath ? configPath.replace(/\.json$/, ".detections.jsonl") : "";
}

/**
 * Append one record. Refuses links and foreign files, keeps 0600, and stops at
 * the size cap instead of rotating. Returns false when nothing was written.
 * 追加一条记录。拒绝链接与他人文件，保持 0600 权限，达到上限后停止写入而不轮转。未写入时返回 false。
 */
export function appendDetection(
  path: string,
  source: string,
  contentHash: string,
  report: DetectionReport,
  now = new Date(),
): boolean {
  if (!path) return false;
  const record: DetectionRecord = {
    version: 1,
    time: localTimestamp(now),
    timezoneOffset: -now.getTimezoneOffset(),
    source,
    contentHash,
    block: report.block,
    hits: report.hits.map((hit) => ({
      rule: hit.rule,
      probability: Math.round(hit.probability * 10000) / 10000,
      action: hit.action,
      kind: hit.kind,
    })),
    errors: report.errors.map((error) => error.code),
    truncated: report.truncated,
    elapsedMs: report.elapsedMs,
  };
  const line = `${JSON.stringify(record)}\n`;
  let fd: number | undefined;
  try {
    fd = openSync(
      path,
      constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW,
      0o600,
    );
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || (process.getuid && stat.uid !== process.getuid())) return false;
    if (stat.size + Buffer.byteLength(line) > MAX_LOG) return false;
    writeSync(fd, line);
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Last `limit` records, newest first; unreadable lines are skipped. / 最近 `limit` 条记录（新的在前），跳过无法解析的行。 */
export function readDetections(path: string, limit = 20): DetectionRecord[] {
  let raw: string;
  try {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      raw = readFileSync(fd, "utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return [];
  }
  const out: DetectionRecord[] = [];
  const lines = raw.split("\n").filter(Boolean);
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    try {
      out.push(JSON.parse(lines[i]) as DetectionRecord);
    } catch {
      /* skip */
    }
  }
  return out;
}
