import { failure } from "./diagnostics.ts";

export type AttachmentMode = "ask" | "allow" | "deny";
export const ATTACHMENT_MODES: AttachmentMode[] = ["ask", "allow", "deny"];

export function attachmentMode(value: unknown): AttachmentMode {
  if (value === undefined) return "ask";
  if (typeof value === "string" && ATTACHMENT_MODES.includes(value as AttachmentMode))
    return value as AttachmentMode;
  throw failure("CONFIG_ATTACHMENT");
}

/** True only for opaque attachment markers; ordinary text and URLs are untouched. */
export function hasAttachment(value: unknown, depth = 0): boolean {
  if (depth > 80 || !value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((item) => hasAttachment(item, depth + 1));
  const record = value as Record<string, unknown>;
  if (isOpaqueAttachment(record)) return true;
  if (Object.keys(record).some(isOpaqueAttachmentKey)) return true;
  return Object.values(record).some((item) => hasAttachment(item, depth + 1));
}

export interface InlineImageAttachment {
  type?: string;
  data: string;
  mimeType?: string;
}

export const isImageAttachment = (value: unknown): value is InlineImageAttachment => {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.data === "string" &&
    (record.type === "image" || (typeof record.mimeType === "string" && record.mimeType.startsWith("image/")));
};

const isOpaqueAttachment = (value: Record<string, unknown>) =>
  typeof value.type === "string" && /image|audio|video|document|(^|_)file($|_)/i.test(value.type);

export type AttachmentItem = InlineImageAttachment | undefined;

/** Return every opaque attachment independently, in payload order. / 按顺序逐个返回不透明附件。 */
export function attachmentItems(value: unknown, depth = 0): AttachmentItem[] {
  if (depth > 80 || !value || typeof value !== "object") return [];
  if (isImageAttachment(value)) return [value];
  const record = value as Record<string, unknown>;
  if (!Array.isArray(value) && isOpaqueAttachment(record)) return [undefined];
  const output: AttachmentItem[] = [];
  const entries: Array<[string | number, unknown]> = Array.isArray(value)
    ? Array.from(value.entries())
    : Object.entries(record);
  for (const [keyOrIndex, child] of entries) {
    if (typeof keyOrIndex === "string" && isOpaqueAttachmentKey(keyOrIndex)) {
      if (isImageAttachment(child)) output.push(child);
      else output.push(undefined);
    } else output.push(...attachmentItems(child, depth + 1));
  }
  return output;
}

type PayloadNode = object | string | number | boolean | null | undefined;

/** Replace inline images in order without mutating the original payload. / 按顺序替换内嵌图片且不修改原始请求体。 */
export function replaceImageAttachments(
  value: unknown,
  replacements: ReadonlyArray<{ data: string; mimeType?: string } | undefined>,
): PayloadNode {
  let index = 0;
  const visit = (item: unknown, depth: number): PayloadNode => {
    if (depth > 80 || !item || typeof item !== "object") return item as PayloadNode;
    if (isImageAttachment(item)) {
      const replacement = replacements[index++];
      return replacement
        ? { ...item, data: replacement.data, mimeType: replacement.mimeType ?? item.mimeType }
        : item;
    }
    const record = item as Record<string, unknown>;
    if (!Array.isArray(item) && isOpaqueAttachment(record)) return item;
    if (Array.isArray(item)) return item.map((child) => visit(child, depth + 1));
    const output: Record<string, unknown> = Object.create(null);
    for (const [key, child] of Object.entries(record))
      output[key] = isOpaqueAttachmentKey(key) && !isImageAttachment(child)
        ? child
        : visit(child, depth + 1);
    return output;
  };
  return visit(value, 0);
}
const isOpaqueAttachmentKey = (key: string) =>
  /^(inlineData|inline_data|fileData|file_data|image_url|input_audio)$/.test(key);

/** Redact textual fields while preserving opaque attachment values unchanged. */
export async function redactAroundAttachments(
  value: unknown,
  redact: (text: string) => Promise<unknown>,
  depth = 0,
): Promise<unknown> {
  if (depth > 80) throw failure("SCAN_COMPLEXITY");
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value))
    return Promise.all(value.map((item) => redactAroundAttachments(item, redact, depth + 1)));
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (isOpaqueAttachment(record)) return value;
    const output: Record<string, unknown> = Object.create(null);
    for (const [key, item] of Object.entries(record)) {
      if (isOpaqueAttachmentKey(key)) output[key] = item;
      else if (key === "type" && typeof item === "string") output[key] = item;
      else output[key] = await redactAroundAttachments(item, redact, depth + 1);
    }
    return output;
  }
  return value;
}
