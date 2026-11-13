/**
 * Minimal System One client. Calls the decision endpoint directly with fetch,
 * never through Pi's model runtime, so detection cannot recurse into the
 * redaction guard or reach a cloud model.
 * 最小化的 System One 客户端。直接用 fetch 调用决策接口，不经过 Pi 的模型运行时，
 * 因此检测不会递归进入脱敏闸门，也不会发往云端模型。
 */
import { failure, ProtectionError } from "../diagnostics.ts";

export type NoulQuestions = Record<string, { type: "noul"; instructions: string }>;

export interface SystemOneRequest {
  state: string;
  images?: string[];
  questions: NoulQuestions;
}

export interface ClientOptions {
  endpoint: string;
  apiKey?: string;
  model?: string;
  timeoutMs: number;
  signal?: AbortSignal;
  fetch?: typeof fetch;
}

/** Errors that say the service is unhealthy, not that one input was bad. / 表示服务不可用（而非单个输入有误）的错误。 */
export function isServiceFailure(error: unknown): boolean {
  if (error instanceof DetectionCancelled) return false;
  if (!(error instanceof ProtectionError)) return true;
  const { code, status } = error.diagnostic;
  if (code === "DETECT_UNAVAILABLE" || code === "DETECT_TIMEOUT") return true;
  return code === "DETECT_HTTP" && (status === undefined || status >= 500 || status === 401 || status === 403);
}

/** Thrown only when the caller's own signal aborted; never a detection result. / 仅在调用方信号中止时抛出，不是检测结果。 */
export class DetectionCancelled extends Error {
  constructor() {
    super("cancelled");
    this.name = "DetectionCancelled";
  }
}

/**
 * Evaluate yes/no questions; returns each question's probability of "yes".
 * Validates the response the way the integration contract requires: answers
 * are read by question ID, and `noul` must be a number in [0, 1], never a boolean.
 * 评估是/否问题，返回各问题为“是”的概率。按接入契约校验响应：按问题 ID 读取答案，
 * `noul` 必须是 [0,1] 内的数字，不能是布尔值。
 */
export async function evaluateNoul(
  request: SystemOneRequest,
  options: ClientOptions,
): Promise<Record<string, number>> {
  if (options.signal?.aborted) throw new DetectionCancelled();
  const timeout = AbortSignal.timeout(options.timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (options.apiKey) headers.Authorization = `Bearer ${options.apiKey}`;
  const body = JSON.stringify({
    ...(options.model ? { model: options.model } : {}),
    state: request.state,
    ...(request.images?.length ? { images: request.images } : {}),
    questions: request.questions,
  });
  const doFetch = options.fetch ?? fetch;
  let text: string;
  let status: number;
  try {
    const response = await doFetch(options.endpoint, { method: "POST", headers, body, signal });
    status = response.status;
    text = await response.text();
  } catch (error) {
    if (options.signal?.aborted) throw new DetectionCancelled();
    if (timeout.aborted) throw failure("DETECT_TIMEOUT", { timeoutMs: options.timeoutMs });
    throw failure("DETECT_UNAVAILABLE", { errorName: (error as Error)?.name });
  }
  // The error body may echo the request; only the status is kept.
  // 错误响应体可能回显请求内容，只保留状态码。
  if (status < 200 || status >= 300) throw failure("DETECT_HTTP", { status });
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw failure("DETECT_RESPONSE");
  }
  const answers = (data as { answers?: unknown } | null)?.answers;
  if (!answers || typeof answers !== "object") throw failure("DETECT_RESPONSE");
  const result: Record<string, number> = {};
  for (const id of Object.keys(request.questions)) {
    const answer = (answers as Record<string, unknown>)[id] as { type?: unknown; noul?: unknown } | undefined;
    const p = answer?.noul;
    if (
      !answer ||
      answer.type !== "noul" ||
      typeof p !== "number" ||
      !Number.isFinite(p) ||
      p < 0 ||
      p > 1
    )
      throw failure("DETECT_RESPONSE");
    result[id] = p;
  }
  return result;
}

export interface ServiceInfo {
  healthy: boolean;
  model?: string;
  vision?: boolean;
  contextTokens?: number;
  slots?: number;
}

/**
 * Best-effort service probe for `/protecter detect status`. Derives the base
 * URL from the endpoint; every field may be missing on other servers.
 * 供 `/protecter detect status` 使用的尽力探测。基地址由端点推导，其他服务器可能缺少任何字段。
 */
export async function probeService(options: Omit<ClientOptions, "model">): Promise<ServiceInfo> {
  const base = new URL(options.endpoint);
  base.pathname = base.pathname.replace(/\/v1\/systemone\/?$/, "/");
  const doFetch = options.fetch ?? fetch;
  const headers: Record<string, string> = options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {};
  const get = async (path: string): Promise<unknown> => {
    try {
      const response = await doFetch(new URL(path, base), {
        headers,
        signal: AbortSignal.timeout(Math.min(options.timeoutMs, 5000)),
      });
      return response.ok ? await response.json() : undefined;
    } catch {
      return undefined;
    }
  };
  const [health, props, models] = await Promise.all([get("health"), get("props"), get("v1/models")]);
  const p = props as
    | { modalities?: { vision?: unknown }; total_slots?: unknown; default_generation_settings?: { n_ctx?: unknown } }
    | undefined;
  const m = (models as { data?: Array<{ id?: unknown }> } | undefined)?.data?.[0]?.id;
  const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
  return {
    healthy: (health as { status?: unknown } | undefined)?.status === "ok",
    model: typeof m === "string" ? m : undefined,
    vision: typeof p?.modalities?.vision === "boolean" ? p.modalities.vision : undefined,
    contextTokens: num(p?.default_generation_settings?.n_ctx),
    slots: num(p?.total_slots),
  };
}
