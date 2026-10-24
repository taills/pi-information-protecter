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

export const isImageAttachment = (value: unknown): value is { type: "image"; data: string; mimeType?: string } =>
  !!value && typeof value === "object" &&
  (value as Record<string, unknown>).type === "image" &&
  typeof (value as Record<string, unknown>).data === "string";

const isOpaqueAttachment = (value: Record<string, unknown>) =>
  typeof value.type === "string" && /image|audio|video|document|(^|_)file($|_)/i.test(value.type);

/** Return each inline image block independently, in payload order. */
export function imageAttachments(value: unknown, depth = 0): Array<{ type: "image"; data: string; mimeType?: string }> {
  if (depth > 80 || !value || typeof value !== "object") return [];
  if (isImageAttachment(value)) return [value];
  const children = Array.isArray(value) ? value : Object.values(value);
  return children.flatMap((child) => imageAttachments(child, depth + 1));
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
