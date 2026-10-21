import {
  type SessionBeforeCompactEvent,
  type SessionBeforeTreeEvent,
} from "@earendil-works/pi-coding-agent";
import { failure } from "./diagnostics.ts";

/**
 * Pi builds its summarization request internally and passes no `onPayload`
 * callback, so `before_provider_request` never fires for it. It does, however,
 * hand this hook the very same `preparation` object it then summarizes, so
 * redacting that object in place is what makes Pi's own request carry redacted
 * text only. Nothing is summarized here: routing, credentials, retries and the
 * token budget stay with Pi, which is why a single configured model is enough.
 * Pi 在内部构造摘要请求且不传 `onPayload` 回调，`before_provider_request` 对其不会触发。
 * 但它交给本钩子的 `preparation` 就是它随后用于摘要的同一个对象，因此在此处原地脱敏，
 * 即可让 Pi 自己的请求只携带脱敏文本。此处不生成任何摘要：路由、凭证、重试与 token 预算
 * 仍由 Pi 负责，因此只配一个模型也足够。
 */

/** Only redaction is needed: nothing is restored before it is sent. / 只需脱敏：发送前不做任何还原。 */
export interface SummaryEngine {
  redact(payload: unknown, provider?: string): Promise<unknown>;
}

/**
 * Replace an array's contents without replacing the array. The tree path keeps
 * its own reference to `entriesToSummarize`, so assigning a new array there
 * would redact a copy Pi never reads.
 * 替换数组内容而不替换数组本身。tree 路径自己持有 `entriesToSummarize` 的引用，
 * 在该处赋新数组只会脱敏一个 Pi 根本不会读取的副本。
 */
function replaceContents(target: unknown[], next: readonly unknown[]): void {
  target.length = 0;
  // push in a loop: spreading a long conversation would hit the argument limit.
  // 逐个 push：展开长对话会触碰参数个数上限。
  for (const item of next) target.push(item);
}

function requireArray(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) throw failure("COMPACT_FAILED");
  return value;
}

function requireString(value: unknown): string {
  if (typeof value !== "string") throw failure("COMPACT_FAILED");
  return value;
}

/**
 * Redact everything Pi will summarize, in one scan so one audit record covers
 * the whole compaction.
 * 一次扫描内脱敏 Pi 将要摘要的全部内容，使一条审计记录覆盖整次压缩。
 */
export async function redactCompaction(
  event: SessionBeforeCompactEvent,
  engine: SummaryEngine,
  provider: string,
): Promise<void> {
  const { preparation } = event;
  // JSON round-trips drop `undefined`, so absent values travel as null.
  // JSON 往返会丢弃 `undefined`，因此缺失值以 null 传递。
  const redacted = (await engine.redact(
    {
      messages: preparation.messagesToSummarize,
      prefix: preparation.turnPrefixMessages,
      previous: preparation.previousSummary ?? null,
      instructions: event.customInstructions ?? null,
    },
    provider,
  )) as Record<string, unknown>;
  if (!redacted || typeof redacted !== "object") throw failure("COMPACT_FAILED");

  // Pi reads `customInstructions` from its own variable, not from this event,
  // so instructions holding a protected value cannot be redacted here. Cancel
  // instead: `/compact <instruction>` is the only path that can reach this.
  // Pi 从自己的变量读取 `customInstructions`，不读本事件，因此含受保护值的指令无法在此
  // 脱敏。改为取消：只有 `/compact <指令>` 会走到这里。
  if (
    typeof event.customInstructions === "string" &&
    redacted.instructions !== event.customInstructions
  )
    throw failure("COMPACT_INSTRUCTIONS");

  const messages = requireArray(redacted.messages);
  const prefix = requireArray(redacted.prefix);
  const previous =
    preparation.previousSummary === undefined
      ? undefined
      : requireString(redacted.previous);

  // Mutate only after every part validated, so a failure cannot leave half of
  // the conversation redacted and half of it in the clear.
  // 全部校验通过后才改写，避免失败时留下一半脱敏、一半明文的对话。
  replaceContents(preparation.messagesToSummarize, messages);
  replaceContents(preparation.turnPrefixMessages, prefix);
  if (previous !== undefined) preparation.previousSummary = previous;
}

/**
 * Branch summaries for `/tree` take the same internal path, so they are
 * redacted the same way. This event does read its instructions back, so they
 * are returned redacted rather than cancelling.
 * `/tree` 的分支摘要走同一条内部路径，因此以同样方式脱敏。该事件会读回指令，
 * 因此返回脱敏后的指令，而不是取消。
 */
export async function redactTree(
  event: SessionBeforeTreeEvent,
  engine: SummaryEngine,
  provider: string,
): Promise<{ customInstructions?: string }> {
  const { preparation } = event;
  const redacted = (await engine.redact(
    {
      entries: preparation.entriesToSummarize,
      instructions: preparation.customInstructions ?? null,
    },
    provider,
  )) as Record<string, unknown>;
  if (!redacted || typeof redacted !== "object") throw failure("COMPACT_FAILED");

  const entries = requireArray(redacted.entries);
  const instructions =
    preparation.customInstructions === undefined
      ? undefined
      : requireString(redacted.instructions);

  replaceContents(preparation.entriesToSummarize, entries);
  return instructions === undefined ? {} : { customInstructions: instructions };
}
