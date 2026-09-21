import {
  generateSummaryWithUsage,
  type CompactionResult,
  type ExtensionContext,
  type SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import { failure } from "./diagnostics.ts";

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
  const model = ctx.model;
  if (!model) throw failure("COMPACT_UNAVAILABLE");
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

  let auth: Awaited<
    ReturnType<ExtensionContext["modelRegistry"]["getApiKeyAndHeaders"]>
  >;
  try {
    auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  } catch {
    // Never surface provider or key details. / 不暴露提供商或密钥细节。
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

  let text: string;
  let usage: CompactionResult["usage"];
  try {
    const result = await summarize(
      redacted,
      model,
      preparation.settings.reserveTokens,
      auth.apiKey,
      headers,
      event.signal,
      instructions,
      previous,
      ctx.thinkingLevel,
      undefined,
      auth.env,
    );
    text = result.text;
    usage = result.usage;
  } catch {
    throw failure("COMPACT_FAILED");
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
