import {
  generateBranchSummary,
  generateSummaryWithUsage,
  type CompactionResult,
  type ExtensionContext,
  type SessionBeforeCompactEvent,
  type SessionBeforeTreeEvent,
} from "@earendil-works/pi-coding-agent";
import { failure, sanitizeError } from "./diagnostics.ts";

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
      undefined,
      auth.env,
    );
    text = result.text;
    usage = result.usage;
  } catch (error) {
    // Keep the sanitized cause: the code and allow-listed errno only, never
    // the provider message, which can quote the conversation.
    // 保留经净化的原因：仅错误码与白名单 errno，不包含可能引用会话的提供商消息。
    throw sanitizeError(error, "COMPACT_FAILED");
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
    });
  } catch (error) {
    throw sanitizeError(error, "COMPACT_FAILED");
  }
  const text = result?.summary;
  if (typeof text !== "string" || !text.trim()) throw failure("COMPACT_FAILED");
  return { summary: engine.restoreText(text), usage: result.usage };
}
