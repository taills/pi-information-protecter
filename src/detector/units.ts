/**
 * Turn hook data into detection units: text chunks and inline images.
 * 将钩子数据转换为检测单元：文本分段与内嵌图片。
 */
import { inlineImageOf } from "../attachment-gate.ts";

export type DetectUnit =
  | { kind: "text"; text: string }
  | { kind: "image"; data: string; mimeType: string };

/** Shorter text cannot carry a credential or identity worth a model call. / 更短的文本不足以承载值得调用模型的敏感信息。 */
const MIN_TEXT = 4;

/**
 * Split text into overlapping chunks so a value on a boundary is still seen whole.
 * 将文本切分为相互重叠的分段，使跨边界的值仍能完整出现在某一段中。
 */
export function chunkText(
  text: string,
  maxChars: number,
  maxChunks: number,
): { chunks: string[]; truncated: boolean } {
  if (text.trim().length < MIN_TEXT) return { chunks: [], truncated: false };
  if (text.length <= maxChars) return { chunks: [text], truncated: false };
  const overlap = Math.min(200, Math.floor(maxChars / 10));
  const step = maxChars - overlap;
  const chunks: string[] = [];
  for (let start = 0; start < text.length; start += step) {
    if (chunks.length === maxChunks) return { chunks, truncated: true };
    chunks.push(text.slice(start, start + maxChars));
    if (start + maxChars >= text.length) break;
  }
  return { chunks, truncated: false };
}

/** Content the model produced or Pi declared; it is not new user data. / 模型生成或 Pi 声明的内容，不是新的用户数据。 */
const SKIP_ROLES = new Set(["assistant", "model"]);
const SKIP_TYPES = new Set([
  "thinking",
  "redacted_thinking",
  "reasoning",
  "function_call",
  "tool_use",
  "server_tool_use",
  "toolCall",
  "tool_call",
]);
const SKIP_KEYS = new Set([
  "tools",
  "tool_choice",
  "toolConfig",
  "functionDeclarations",
  "response_format",
  "text_format",
  "generationConfig",
  "metadata",
]);
/** Keys whose string value is conversational text in Pi and provider formats. / 在 Pi 与各提供商格式中其字符串值为对话文本的键。 */
const TEXT_KEYS = new Set(["text", "content", "input", "instructions", "system", "output", "prompt"]);

/**
 * Collect user-side text and inline images from a provider payload. Model
 * output and tool declarations are skipped: they are not data the user is
 * about to disclose, and re-checking them every turn would only add latency.
 * 从提供商请求体中收集用户侧文本与内嵌图片。跳过模型输出和工具声明：它们不是用户即将
 * 披露的数据，每轮重复检测只会增加延迟。
 */
export function payloadUnits(payload: unknown): { texts: string[]; images: DetectUnit[] } {
  const texts = new Set<string>();
  const images: DetectUnit[] = [];
  const visit = (value: unknown, depth: number) => {
    if (depth > 80 || !value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const child of value) visit(child, depth + 1);
      return;
    }
    const image = inlineImageOf(value);
    if (image) {
      images.push({ kind: "image", data: image.data, mimeType: image.mimeType ?? "image/png" });
      return;
    }
    const record = value as Record<string, unknown>;
    if (typeof record.role === "string" && SKIP_ROLES.has(record.role)) return;
    if (typeof record.type === "string" && SKIP_TYPES.has(record.type)) return;
    for (const [key, child] of Object.entries(record)) {
      if (SKIP_KEYS.has(key)) continue;
      if (typeof child === "string") {
        if (TEXT_KEYS.has(key)) texts.add(child);
      } else visit(child, depth + 1);
    }
  };
  visit(payload, 0);
  return { texts: [...texts], images };
}

/** Pi content blocks (input images, tool results) as units. / 将 Pi 内容块（输入图片、工具结果）转换为检测单元。 */
export function contentUnits(
  content: ReadonlyArray<{ type: string; text?: string; data?: string; mimeType?: string }>,
): { texts: string[]; images: DetectUnit[] } {
  const texts: string[] = [];
  const images: DetectUnit[] = [];
  for (const block of content) {
    if (block.type === "text" && typeof block.text === "string") texts.push(block.text);
    else if (block.type === "image" && typeof block.data === "string")
      images.push({ kind: "image", data: block.data, mimeType: block.mimeType ?? "image/png" });
  }
  return { texts, images };
}
