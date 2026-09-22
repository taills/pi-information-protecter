import {
  DEFAULT_COMPACTION_SETTINGS,
  generateBranchSummary,
  generateSummaryWithUsage,
  type CompactionResult,
  type ExtensionContext,
  type SessionBeforeCompactEvent,
  type SessionBeforeTreeEvent,
} from "@earendil-works/pi-coding-agent";
import {
  failure,
  sanitizeError,
  type Details,
  type Diagnostic,
} from "./diagnostics.ts";
import { type CompactionSettings } from "./config.ts";

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
 * Prefer the configured summarization model. Sending the conversation to a
 * second destination is the point of the setting, so a configured model that
 * cannot be resolved is an error rather than a silent fall back to the main
 * model, which would send the conversation somewhere the user did not choose.
 * 优先使用配置的摘要模型。该设置的目的就是把对话发往第二个目的地，因此配了却解析不到
 * 应当报错，而不是静默回退到主模型——那会把对话发往用户未选择的地方。
 */
export function resolveCompactionModel(
  ctx: ExtensionContext,
  settings?: CompactionSettings,
): ExtensionContext["model"] {
  if (!settings?.provider || !settings.model) return ctx.model;
  const found = ctx.modelRegistry.find(settings.provider, settings.model);
  if (!found) throw failure("CONFIG_COMPACT_MODEL");
  return found;
}

/**
 * The compaction threshold must follow the summarization model, not the main
 * one: waiting for a 1M window before summarizing with a 256k model hands it
 * more text than it can read.
 * 压缩阈值必须跟随摘要模型而非主模型：用 256k 的模型摘要却等到 1M 窗口才触发，
 * 交给它的文本会超出其可读取范围。
 */
export function compactionBudget(
  ctx: ExtensionContext,
  settings: CompactionSettings,
  piReserveTokens?: number,
): { window: number; reserve: number; threshold: number } | undefined {
  let model: ExtensionContext["model"];
  try {
    model = resolveCompactionModel(ctx, settings);
  } catch {
    return undefined;
  }
  const window =
    settings.contextWindow ??
    (model as { contextWindow?: number } | undefined)?.contextWindow;
  if (typeof window !== "number" || window <= 0) return undefined;
  // Inherit Pi's effective reserve so it is configured in one place; the
  // local setting is only an override for a summarization model that needs a
  // different margin than the conversation model.
  // 继承 Pi 的生效预留值，使其只需配置一处；本地设置仅在摘要模型需要与对话模型不同的
  // 余量时作为覆盖。
  const reserve =
    settings.reserveTokens ??
    piReserveTokens ??
    DEFAULT_COMPACTION_SETTINGS.reserveTokens;
  if (reserve >= window) return undefined;
  return { window, reserve, threshold: window - reserve };
}

/**
 * Resolve request credentials without surfacing provider or key details.
 * 获取请求凭证，不暴露提供商或密钥细节。
 */
async function resolveAuth(
  ctx: ExtensionContext,
  settings?: CompactionSettings,
) {
  const model = resolveCompactionModel(ctx, settings);
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
/**
 * Build a summary locally, with no model call at all.
 *
 * The model call is the fragile part: it needs its own routing and
 * credentials, and it can return nothing. This runs on the already redacted
 * messages, sends nothing and always produces something, so compaction
 * degrades instead of failing. It is mechanical, not an LLM summary, so it
 * keeps facts rather than reasoning.
 * 完全不调用模型的本地摘要。模型调用是脆弱环节：需要单独的路由与凭证，且可能返回空内容。
 * 本函数基于已脱敏的消息运行，不发送任何内容且总能产出结果，使压缩降级而非失败。
 * 它是机械摘录而非模型摘要，保留事实而非推理。
 */
export function buildLocalSummary(messages: readonly unknown[]): string {
  const requests: string[] = [];
  const replies: string[] = [];
  const tools = new Map<string, number>();
  const clip = (value: string, limit: number) =>
    value.length > limit ? `${value.slice(0, limit)}\u2026` : value;

  for (const message of messages) {
    const entry = message as { role?: unknown; content?: unknown };
    if (!Array.isArray(entry.content)) continue;
    for (const raw of entry.content) {
      const block = raw as { type?: unknown; text?: unknown; name?: unknown };
      if (block.type === "toolCall" && typeof block.name === "string")
        tools.set(block.name, (tools.get(block.name) ?? 0) + 1);
      if (block.type !== "text" || typeof block.text !== "string") continue;
      const text = block.text.trim();
      if (!text) continue;
      if (entry.role === "user") requests.push(clip(text, 300));
      else if (entry.role === "assistant") replies.push(clip(text, 300));
    }
  }

  const used = [...tools.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([name, count]) => `${name} x${count}`);
  const sections = [
    "# Local compaction summary",
    "",
    "Generated locally without a model call, so it lists facts rather than",
    "interpreting them. Protected values appear as their replacements.",
    "",
    `- Messages summarized: ${messages.length}`,
    used.length ? `- Tools used: ${used.join(", ")}` : "",
    "",
    "## Requests",
    ...(requests.length
      ? requests.slice(-12).map((value) => `- ${value}`)
      : ["- (none recorded)"]),
    "",
    "## Latest replies",
    ...(replies.length
      ? replies.slice(-6).map((value) => `- ${value}`)
      : ["- (none recorded)"]),
  ];
  return sections.filter((line) => line !== "").join("\n");
}

export async function buildProtectedSummary(
  event: SessionBeforeCompactEvent,
  ctx: ExtensionContext,
  engine: SummaryEngine,
  provider: string,
  summarize: Summarizer = generateSummaryWithUsage,
  settings?: CompactionSettings,
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

  let text = "";
  let usage: CompactionResult["usage"];
  let degraded: Diagnostic | undefined;
  try {
    const auth = await resolveAuth(ctx, settings);
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
    text = typeof result.text === "string" ? result.text : "";
    usage = result.usage;
    // An empty answer is not a failed call, but it is not a summary either.
    // 空回答不算调用失败，但也不是摘要。
    if (!text.trim()) degraded = failure("COMPACT_EMPTY").diagnostic;
  } catch (error) {
    // Keep the sanitized cause: codes, an allow-listed errno, the error class
    // name and an HTTP status only, never the provider message.
    // 保留经净化的原因：仅错误码、白名单 errno、错误类名和 HTTP 状态码，不包含提供商消息。
    const safe = sanitizeError(error, "COMPACT_FAILED");
    degraded =
      safe.diagnostic.code === "COMPACT_FAILED"
        ? failure("COMPACT_FAILED", errorIdentity(error)).diagnostic
        : safe.diagnostic;
  }

  // Degrade to the local summary rather than cancelling: it is built from the
  // same redacted messages, so it cannot leak, and it keeps compaction usable
  // where the extra model call is not.
  // 降级为本地摘要而不取消：它基于同一批已脱敏消息，不会泄露，并在额外模型调用不可用时
  // 保持压缩可用。
  if (degraded)
    return {
      summary: engine.restoreText(buildLocalSummary(redacted)),
      firstKeptEntryId: preparation.firstKeptEntryId,
      tokensBefore: preparation.tokensBefore,
      // The caller reports this, so a degraded summary is never silent.
      // 调用方会上报该信息，降级不会静默发生。
      details: { protecter: degraded },
    };

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
  settings?: CompactionSettings,
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
  const auth = await resolveAuth(ctx, settings);

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
