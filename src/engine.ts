import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.ts";

export const REQUEST_ERROR =
  "protecter: 请求已清空。配置无效、扫描超时或包含不支持的附件；修复后重试。";
export class Protecter {
  private readonly tokens = new Map<string, string>();
  private queue: Promise<unknown> = Promise.resolve();
  private readonly workers = new Set<Worker>();
  private closed = false;
  constructor(
    readonly configPath: string,
    private readonly timeoutMs = 2000,
  ) {}

  initialize(): void {
    loadConfig(this.configPath, true);
  }
  get mappingCount(): number {
    return this.tokens.size;
  }

  /**
   * Serialise scans so two requests cannot assign different tokens to the same value.
   * 串行扫描，避免两个请求为同一原文分配不同占位符。
   */
  redact(payload: unknown): Promise<unknown> {
    const run = this.queue.then(() => this.scan(payload));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async scan(payload: unknown): Promise<unknown> {
    if (this.closed) throw new Error(REQUEST_ERROR);
    const { config, raw } = loadConfig(this.configPath);
    const serialized = JSON.stringify(payload);
    if (!serialized || Buffer.byteLength(serialized) > 8 * 1024 * 1024)
      throw new Error(REQUEST_ERROR);
    let snapshot: unknown;
    try {
      snapshot = JSON.parse(serialized);
    } catch {
      throw new Error(REQUEST_ERROR);
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      const worker = new Worker(
        fileURLToPath(new URL("./scan-worker.mjs", import.meta.url)),
        {
          workerData: {
            payload: snapshot,
            rules: config.sensitiveWords,
            entries: [...this.tokens],
            configRaw: raw,
          },
          resourceLimits: { maxOldGenerationSizeMb: 128 },
        },
      );
      this.workers.add(worker);
      const finish = (data?: {
        payload: unknown;
        additions: [string, string][];
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
        for (const [token, original] of data.additions)
          this.tokens.set(token, original);
        resolve(data.payload);
      };
      const timer = setTimeout(() => finish(), this.timeoutMs);
      worker.once("message", (data) => finish(data.failed ? undefined : data));
      worker.once("error", () => finish());
      worker.once("exit", () => finish());
    });
  }

  restoreText(text: string): string {
    // One pass, never recursively expand text introduced by a replacement.
    // 仅替换一遍，不递归展开替换后引入的文本。
    return text.replace(
      /__PIP_[a-f0-9]{48}__/g,
      (token) => this.tokens.get(token) ?? token,
    );
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
    this.tokens.clear();
    for (const worker of this.workers) void worker.terminate();
    this.workers.clear();
  }
}
