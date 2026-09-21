import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { migrateConfig, type Snapshot } from "./migration.ts";
import { getMachineHash } from "./machine.ts";
import { appendAudit, clearAudit, readAudit } from "./audit.ts";

export const REQUEST_ERROR =
  "SPI Protecter: request cleared; check config, audit log, scan limits or attachments / 请求已清空，请检查配置、审计日志、扫描限制或附件。";
export class Protecter {
  private readonly tokens = new Map<string, string>();
  private queue: Promise<unknown> = Promise.resolve();
  private readonly workers = new Set<Worker>();
  private closed = false;
  private snapshot?: Snapshot;
  constructor(
    private readonly configDir: string,
    private readonly timeoutMs = 2000,
    private readonly machineId: () => string = getMachineHash,
  ) {}

  async initialize(): Promise<void> {
    if (this.closed) throw new Error(REQUEST_ERROR);
    this.snapshot = undefined;
    const snapshot = await migrateConfig(this.configDir, this.machineId());
    if (this.closed) throw new Error(REQUEST_ERROR);
    this.snapshot = snapshot;
  }
  get configPath(): string {
    return this.snapshot?.path ?? "";
  }
  get auditPath(): string {
    return this.configPath ? this.configPath.replace(/\.json$/, ".jsonl") : "";
  }
  auditRecords(limit = 20) {
    if (!this.ready) throw new Error(REQUEST_ERROR);
    return readAudit(this.auditPath, limit);
  }
  clearAuditRecords(): Promise<number> {
    const run = this.queue.then(() => {
      if (!this.ready) throw new Error(REQUEST_ERROR);
      return clearAudit(this.auditPath);
    });
    this.queue = run.catch(() => undefined);
    return run;
  }
  get ruleCount(): number {
    return this.snapshot?.config.sensitiveWords.length ?? 0;
  }
  get ready(): boolean {
    return !!this.snapshot && !this.closed;
  }
  get mappingCount(): number {
    return this.tokens.size;
  }

  /**
   * Serialise scans so two requests cannot assign different tokens to the same value.
   * 串行扫描，避免两个请求为同一原文分配不同占位符。
   */
  redact(payload: unknown, provider = "unknown"): Promise<unknown> {
    const run = this.queue.then(() => this.scan(payload, provider));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async scan(payload: unknown, provider: string): Promise<unknown> {
    if (!this.ready) throw new Error(REQUEST_ERROR);
    const { config, sourceRaws } = this.snapshot!;
    const serialized = JSON.stringify(payload);
    if (!serialized || Buffer.byteLength(serialized) > 8 * 1024 * 1024)
      throw new Error(REQUEST_ERROR);
    let snapshot: unknown;
    try {
      snapshot = JSON.parse(serialized);
    } catch {
      throw new Error(REQUEST_ERROR);
    }
    const result = await new Promise<{
      payload: unknown;
      additions: [string, string][];
      hits: [string, string][];
    }>((resolve, reject) => {
      let settled = false;
      const worker = new Worker(
        fileURLToPath(new URL("./scan-worker.mjs", import.meta.url)),
        {
          workerData: {
            payload: snapshot,
            rules: config.sensitiveWords,
            entries: [...this.tokens],
            configRaws: sourceRaws,
          },
          execArgv: [],
          resourceLimits: { maxOldGenerationSizeMb: 128 },
        },
      );
      this.workers.add(worker);
      const finish = (data?: {
        payload: unknown;
        additions: [string, string][];
        hits: [string, string][];
      }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.workers.delete(worker);
        void worker.terminate();
        if (!data || this.closed) {
          reject(new Error(REQUEST_ERROR));
          return;
        }
        resolve(data);
      };
      const timer = setTimeout(() => finish(), this.timeoutMs);
      worker.once("message", (data) => finish(data.failed ? undefined : data));
      worker.once("error", () => finish());
      worker.once("exit", () => finish());
    });
    if (this.closed) throw new Error(REQUEST_ERROR);
    await appendAudit(this.auditPath, provider, result.hits);
    if (this.closed) throw new Error(REQUEST_ERROR);
    for (const [token, original] of result.additions)
      this.tokens.set(token, original);
    return result.payload;
  }

  restoreText(text: string): string {
    // One pass, never recursively expand text introduced by a replacement.
    // 仅替换一遍，不递归展开替换后引入的文本。
    const escape = (value: string) =>
      value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const fixed = [...this.tokens.keys()].filter(
      (token) => !/^__PIP_[a-f0-9]{48}__$/.test(token),
    );
    const pattern = new RegExp(
      [
        "__PIP_[a-f0-9]{48}__",
        ...fixed.sort((a, b) => b.length - a.length).map(escape),
      ].join("|"),
      "g",
    );
    return text.replace(pattern, (token) => this.tokens.get(token) ?? token);
  }

  restore<T>(value: T, depth = 0): T {
    if (depth > 80) throw new Error("protecter: 响应层级过深。");
    if (typeof value === "string") return this.restoreText(value) as T;
    if (Array.isArray(value))
      return value.map((item) => this.restore(item, depth + 1)) as T;
    if (value && typeof value === "object") {
      const result: Record<string, unknown> = Object.create(null);
      for (const [key, item] of Object.entries(value)) {
        const nextKey = this.restoreText(key);
        if (Object.hasOwn(result, nextKey))
          throw new Error("protecter: 响应键冲突。");
        result[nextKey] = this.restore(item, depth + 1);
      }
      return result as T;
    }
    return value;
  }

  close(): void {
    this.closed = true;
    this.snapshot = undefined;
    this.tokens.clear();
    for (const worker of this.workers) void worker.terminate();
    this.workers.clear();
  }
}
