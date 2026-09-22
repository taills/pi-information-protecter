import {
  generateBranchSummary,
  generateSummaryWithUsage,
  type CompactionResult,
  type ExtensionContext,
  type SessionBeforeCompactEvent,
  type SessionBeforeTreeEvent,
} from "@earendil-works/pi-coding-agent";
import { failure, sanitizeError, type Details } from "./diagnostics.ts";

/**
 * Identify a summarization failure without quoting anything from it. A class
 * name and an HTTP status separate authentication, transport and argument
 * errors, which a single opaque code cannot.
 * 在不引用任何内容的前提下标识摘要失败。类名与 HTTP 状态码能区分认证、传输和参数
 * 错误，单一不透明的错误码做不到。
 */
function errorIdentity(error: unknown): Details {
  const details: Details = {};
  if (!error || typeof error !== "object") return details;
  const name = (error as { name?: unknown }).name;
  if (typeof name === "string") details.errorName = name;
  else if (typeof error.constructor?.name === "string")
    details.errorName = error.constructor.name;
  for (const key of ["status", "statusCode"] as const) {
    const value = (error as Record<string, unknown>)[key];
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
      details.status = value;
      break;
    }
  }
  return details;
}

/**
 * Pi builds the summarization request internally and never routes it through
 * `before_provider_request`, so letting Pi summarize would send the stored
 * conversation, which holds restored plaintext, straight to the provider.
 * Redact first, summarize the redacted text, then restore locally.
 * Pi 在内部构造摘要请求，不经过 `before_provider_request`，直接交给 Pi 生成摘要会把
 * 存有还原明文的会话内容原样发给提供商。因此先脱敏、对脱敏文本生成摘要，再在本地还原。
 */

export interface SummaryEngine {
  redact(payload: unknown, provider?: string): Promise<unknown>;
  restoreText(text: string): string;
}

/** Injected so tests can assert that only redacted text reaches the model. / 可注入，以便测试断言只有脱敏文本会到达模型。 */
export type Summarizer = typeof generateSummaryWithUsage;
export type BranchSummarizer = typeof generateBranchSummary;

/**
 * Resolve request credentials without surfacing provider or key details.
 * 获取请求凭证，不暴露提供商或密钥细节。
 */
async function resolveAuth(ctx: ExtensionContext) {
  const model = ctx.model;
  if (!model) throw failure("COMPACT_UNAVAILABLE");
  let auth: Awaited<
    ReturnType<ExtensionContext["modelRegistry"]["getApiKeyAndHeaders"]>
  >;
  try {
    auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  } catch {
    throw failure("COMPACT_UNAVAILABLE");
  }
  if (!auth.ok) throw failure("COMPACT_UNAVAILABLE");
  // A null header value means "remove"; summarization takes plain strings.
  // 值为 null 表示删除该头，而摘要接口只接受字符串。
  const headers = Object.fromEntries(
    Object.entries(auth.headers ?? {}).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  return { model, apiKey: auth.apiKey, headers, env: auth.env };
}

/**
 * Without a stream function the summarizer issues a bare provider call using
 * only the passed key, bypassing Pi's request preparation, which is what
 * resolves OAuth tokens and provider base URLs. Route through the model
 * registry instead, which authenticates at request time.
 * 不传流函数时，摘要会只用传入的密钥发起裸请求，绕过 Pi 的请求准备（OAuth 令牌
 * 与 provider 地址由它解析）。改为经由模型注册表，在请求时完成认证。
 *
 * `streamSimple` exists from Pi 0.86; `complete` covers 0.84 and 0.85.
 * `streamSimple` 从 Pi 0.86 提供，`complete` 覆盖 0.84 与 0.85。
 */
function registryStreamFn(ctx: ExtensionContext) {
  // SAFETY: the supported Pi range declares different ModelRegistry members,
  // so the methods are treated as optional and every use is guarded by a
  // typeof check before being called. Nothing is assumed to exist.
  // SAFETY：受支持的 Pi 版本范围内 ModelRegistry 成员不同，因此将方法视为可选，
  // 每次调用前都经 typeof 检查，不假设任何成员存在。
  const registry = ctx.modelRegistry as unknown as {
    streamSimple?: (...args: unknown[]) => { result(): Promise<unknown> };
    complete?: (...args: unknown[]) => Promise<unknown>;
  };
  if (typeof registry.streamSimple === "function")
    return (model: unknown, context: unknown, options: unknown) =>
      registry.streamSimple!(model, context, options);
  if (typeof registry.complete === "function")
    return (model: unknown, context: unknown, options: unknown) => ({
      // completeSummarization only awaits result(). / completeSummarization 仅等待 result()。
      result: () => registry.complete!(model, context, options),
    });
  return undefined;
}

/**
 * Build a compaction summary without ever sending protected values.
 * Every failure throws, because the caller must cancel rather than fall back
 * to Pi's unredacted summarization.
 * 生成压缩摘要且不发送任何受保护值。任何失败都抛出，调用方必须取消，
 * 而不能回退到 Pi 未脱敏的摘要流程。
 */
export async function buildProtectedSummary(
  event: SessionBeforeCompactEvent,
  ctx: ExtensionContext,
  engine: SummaryEngine,
  provider: string,
  summarize: Summarizer = generateSummaryWithUsage,
): Promise<CompactionResult> {
  const { preparation } = event;

  // Redaction runs through the same bounded worker as an outgoing request.
  // 脱敏走与出站请求相同的限时 worker。
  const redacted = (await engine.redact(
    preparation.messagesToSummarize,
    provider,
  )) as typeof preparation.messagesToSummarize;
  const previous =
    preparation.previousSummary === undefined
      ? undefined
      : ((await engine.redact(
          preparation.previousSummary,
          provider,
        )) as string);
  const instructions =
    event.customInstructions === undefined
      ? undefined
      : ((await engine.redact(event.customInstructions, provider)) as string);

  const auth = await resolveAuth(ctx);

  let text: string;
  let usage: CompactionResult["usage"];
  try {
    const result = await summarize(
      redacted,
      auth.model,
      preparation.settings.reserveTokens,
      auth.apiKey,
      auth.headers,
      event.signal,
      instructions,
      previous,
      ctx.thinkingLevel,
      registryStreamFn(ctx) as never,
      auth.env,
    );
    text = result.text;
    usage = result.usage;
  } catch (error) {
    // Keep the sanitized cause: codes, an allow-listed errno, the error class
    // name and an HTTP status only, never the provider message.
    // 保留经净化的原因：仅错误码、白名单 errno、错误类名和 HTTP 状态码，不包含提供商消息。
    const safe = sanitizeError(error, "COMPACT_FAILED");
    throw safe.diagnostic.code === "COMPACT_FAILED"
      ? failure("COMPACT_FAILED", errorIdentity(error))
      : safe;
  }
  if (typeof text !== "string" || !text.trim()) throw failure("COMPACT_FAILED");

  // The summary is stored locally, so restore it like any assistant text; the
  // next outgoing request redacts it again.
  // 摘要保存在本地，因此与助手文本一样还原；下一次出站请求会再次脱敏。
  return {
    summary: engine.restoreText(text),
    firstKeptEntryId: preparation.firstKeptEntryId,
    tokensBefore: preparation.tokensBefore,
    usage,
  };
}

export interface ProtectedBranchSummary {
  summary: string;
  usage?: Awaited<ReturnType<BranchSummarizer>>["usage"];
}

/**
 * Branch summaries for `/tree` take the same internal path as compaction, so
 * they are produced here from redacted entries for the same reason.
 * `/tree` 的分支摘要走与压缩相同的内部路径，因此同样在此处基于脱敏条目生成。
 */
export async function buildProtectedBranchSummary(
  event: SessionBeforeTreeEvent,
  ctx: ExtensionContext,
  engine: SummaryEngine,
  provider: string,
  summarize: BranchSummarizer = generateBranchSummary,
): Promise<ProtectedBranchSummary> {
  const { preparation } = event;
  // Session entries are ordinary JSON, so the same scan covers them.
  // 会话条目是普通 JSON，同一扫描即可覆盖。
  const redacted = (await engine.redact(
    preparation.entriesToSummarize,
    provider,
  )) as typeof preparation.entriesToSummarize;
  const instructions =
    preparation.customInstructions === undefined
      ? undefined
      : ((await engine.redact(
          preparation.customInstructions,
          provider,
        )) as string);
  const auth = await resolveAuth(ctx);

  let result: Awaited<ReturnType<BranchSummarizer>>;
  try {
    result = await summarize(redacted, {
      model: auth.model,
      apiKey: auth.apiKey,
      headers: auth.headers,
      env: auth.env,
      signal: event.signal,
      customInstructions: instructions,
      replaceInstructions: preparation.replaceInstructions,
      streamFn: registryStreamFn(ctx) as never,
    });
  } catch (error) {
    const safe = sanitizeError(error, "COMPACT_FAILED");
    throw safe.diagnostic.code === "COMPACT_FAILED"
      ? failure("COMPACT_FAILED", errorIdentity(error))
      : safe;
  }
  const text = result?.summary;
  if (typeof text !== "string" || !text.trim()) throw failure("COMPACT_FAILED");
  return { summary: engine.restoreText(text), usage: result.usage };
}
