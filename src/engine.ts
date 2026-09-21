import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { migrateConfig, type Snapshot } from "./migration.ts";
import { getMachineHash } from "./machine.ts";
import { appendAudit, clearAudit, readAudit } from "./audit.ts";
import {
  failure,
  formatDiagnostic,
  sanitizeError,
  workerError,
  type Diagnostic,
} from "./diagnostics.ts";

export class Protecter {
  private readonly tokens = new Map<string, string>();
  private queue: Promise<unknown> = Promise.resolve();
  private readonly workers = new Set<Worker>();
  private closed = false;
  private snapshot?: Snapshot;
  private lastError?: Diagnostic;
  // Mappings only grow until close(), so size is a safe cache key. / 映射仅增长至关闭，因此数量可作缓存键。
  private restorePattern?: RegExp;
  private restoreSize = -1;
  constructor(
    private readonly configDir: string,
    private readonly timeoutMs = 2000,
    private readonly machineId: () => string = getMachineHash,
  ) {}

  /** Keep the last sanitized cause so later blocks stay explainable. / 保留最近的安全原因，使后续拦截可解释。 */
  get lastDiagnostic(): Diagnostic | undefined {
    return this.lastError ? { ...this.lastError } : undefined;
  }
  get lastDiagnosticText(): string | undefined {
    return this.lastError ? formatDiagnostic(this.lastError) : undefined;
  }

  async initialize(): Promise<void> {
    try {
      if (this.closed) throw failure("NOT_READY");
      this.snapshot = undefined;
      let hash: string;
      try {
        hash = this.machineId();
      } catch {
        throw failure("MACHINE_ID");
      }
      const snapshot = await migrateConfig(this.configDir, hash);
      if (this.closed) throw failure("NOT_READY");
      this.snapshot = snapshot;
      this.lastError = undefined;
    } catch (error) {
      const safe = sanitizeError(error, "CONFIG_IO");
      this.lastError = safe.diagnostic;
      throw safe;
    }
  }
  get configPath(): string {
    return this.snapshot?.path ?? "";
  }
  get auditPath(): string {
    return this.configPath ? this.configPath.replace(/\.json$/, ".jsonl") : "";
  }
  auditRecords(limit = 20) {
    if (!this.ready) throw this.notReady();
    return readAudit(this.auditPath, limit);
  }
  clearAuditRecords(): Promise<number> {
    const run = this.queue.then(() => {
      if (!this.ready) throw this.notReady();
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
    const run = this.queue
      .then(() => this.scan(payload, provider))
      .catch((error) => {
        const safe = sanitizeError(error, "INTERNAL");
        this.lastError = safe.diagnostic;
        throw safe;
      });
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Reuse the initialization cause instead of a generic not-ready error. / 复用初始化原因，而非笼统的未就绪错误。 */
  private notReady() {
    return this.lastError
      ? failure(this.lastError.code, this.lastError)
      : failure("NOT_READY");
  }

  private async scan(payload: unknown, provider: string): Promise<unknown> {
    if (!this.ready) throw this.notReady();
    const { config, sourceRaws } = this.snapshot!;
    let serialized: string | undefined;
    try {
      serialized = JSON.stringify(payload);
    } catch {
      throw failure("PAYLOAD_JSON");
    }
    if (!serialized) throw failure("PAYLOAD_JSON");
    if (Buffer.byteLength(serialized) > 8 * 1024 * 1024)
      throw failure("PAYLOAD_SIZE", {
        bytes: Buffer.byteLength(serialized),
        limit: 8 * 1024 * 1024,
      });
    let snapshot: unknown;
    try {
      snapshot = JSON.parse(serialized);
    } catch {
      throw failure("PAYLOAD_JSON");
    }
    const result = await new Promise<{
      payload: unknown;
      additions: [string, string][];
      hits: [string, string][];
    }>((resolve, reject) => {
      let settled = false;
      let worker: Worker;
      try {
        worker = new Worker(
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
      } catch (error) {
        reject(sanitizeError(error, "WORKER_FAILED"));
        return;
      }
      this.workers.add(worker);
      const finish = (
        data?: {
          payload: unknown;
          additions: [string, string][];
          hits: [string, string][];
        },
        error = failure("WORKER_FAILED"),
      ) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.workers.delete(worker);
        void worker.terminate();
        if (!data || this.closed) {
          reject(this.closed ? failure("NOT_READY") : error);
          return;
        }
        resolve(data);
      };
      const timer = setTimeout(
        () =>
          finish(
            undefined,
            failure("SCAN_TIMEOUT", { timeoutMs: this.timeoutMs }),
          ),
        this.timeoutMs,
      );
      worker.once("message", (data) => {
        if (data?.failed)
          finish(undefined, workerError(data.diagnostic, "SCAN_INTERNAL"));
        else if (
          data &&
          Array.isArray(data.additions) &&
          Array.isArray(data.hits)
        )
          finish(data);
        else finish();
      });
      worker.once("error", () => finish());
      worker.once("exit", () => finish());
    });
    if (this.closed) throw failure("NOT_READY");
    await appendAudit(this.auditPath, provider, result.hits);
    if (this.closed) throw failure("NOT_READY");
    for (const [token, original] of result.additions)
      this.tokens.set(token, original);
    return result.payload;
  }

  restoreText(text: string): string {
    // One pass, never recursively expand text introduced by a replacement.
    // 仅替换一遍，不递归展开替换后引入的文本。
    if (!this.tokens.size) return text;
    if (this.restoreSize !== this.tokens.size) {
      const escape = (value: string) =>
        value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      // Longest first so a shorter replacement cannot split a longer one.
      // 长值优先，避免短替换值切分较长的替换值。
      this.restorePattern = new RegExp(
        [...this.tokens.keys()]
          .sort((a, b) => b.length - a.length)
          .map(escape)
          .join("|"),
        "g",
      );
      this.restoreSize = this.tokens.size;
    }
    return text.replace(
      this.restorePattern!,
      (token) => this.tokens.get(token) ?? token,
    );
  }

  restore<T>(value: T, depth = 0): T {
    if (depth > 80) throw failure("RESTORE_COMPLEXITY", { node: depth });
    if (typeof value === "string") return this.restoreText(value) as T;
    if (Array.isArray(value))
      return value.map((item) => this.restore(item, depth + 1)) as T;
    if (value && typeof value === "object") {
      const result: Record<string, unknown> = Object.create(null);
      for (const [key, item] of Object.entries(value)) {
        const nextKey = this.restoreText(key);
        if (Object.hasOwn(result, nextKey))
          throw failure("RESTORE_KEY_COLLISION");
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
