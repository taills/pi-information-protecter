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

type ImageReplacement = { data: string; mimeType?: string };
type ImageView = { image: InlineImageAttachment; write: (next: ImageReplacement) => Record<string, unknown> };
const DATA_URL = /^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\s]*)$/i;

function dataUrlImage(url: unknown): InlineImageAttachment | undefined {
  if (typeof url !== "string") return undefined;
  const match = DATA_URL.exec(url);
  return match ? { type: "image", mimeType: match[1].toLowerCase(), data: match[2].replace(/\s+/g, "") } : undefined;
}
const dataUrl = (next: ImageReplacement, fallback?: string) =>
  `data:${next.mimeType ?? fallback ?? "image/png"};base64,${next.data}`;

/**
 * Normalize inline images in Pi and provider formats (Pi/Gemini, Anthropic,
 * OpenAI chat/responses data URLs). Remote URLs stay opaque.
 * 统一识别 Pi 与各提供商格式的内嵌图片；远程 URL 仍按不透明附件处理。
 */
function imageView(record: Record<string, unknown>): ImageView | undefined {
  const mime = typeof record.mimeType === "string" ? record.mimeType : typeof record.mime_type === "string" ? record.mime_type : undefined;
  if (typeof record.data === "string" && (record.type === "image" || mime?.startsWith("image/"))) {
    const key = typeof record.mimeType === "string" || typeof record.mime_type !== "string" ? "mimeType" : "mime_type";
    return {
      image: { type: "image", data: record.data, mimeType: mime },
      write: (next) => ({ ...record, data: next.data, [key]: next.mimeType ?? mime }),
    };
  }
  const source = record.source as Record<string, unknown> | undefined;
  if (record.type === "image" && source && typeof source === "object" && source.type === "base64" && typeof source.data === "string") {
    const mediaType = typeof source.media_type === "string" ? source.media_type : undefined;
    return {
      image: { type: "image", data: source.data, mimeType: mediaType },
      write: (next) => ({ ...record, source: { ...source, data: next.data, media_type: next.mimeType ?? mediaType } }),
    };
  }
  const nested = record.image_url as Record<string, unknown> | undefined;
  if (nested && typeof nested === "object") {
    const image = dataUrlImage(nested.url);
    if (image) return { image, write: (next) => ({ ...record, image_url: { ...nested, url: dataUrl(next, image.mimeType) } }) };
  }
  if (typeof record.image_url === "string") {
    const image = dataUrlImage(record.image_url);
    if (image) return { image, write: (next) => ({ ...record, image_url: dataUrl(next, image.mimeType) }) };
  }
  return undefined;
}

export const isImageAttachment = (value: unknown): value is InlineImageAttachment =>
  !!value && typeof value === "object" && !Array.isArray(value) && imageView(value as Record<string, unknown>) !== undefined;

const isOpaqueAttachment = (value: Record<string, unknown>) =>
  typeof value.type === "string" && /image|audio|video|document|(^|_)file($|_)/i.test(value.type);

export type AttachmentItem = InlineImageAttachment | undefined;

interface Visit {
  image?: InlineImageAttachment;
  path?: string;
}

/**
 * Walk attachments in payload order. `replace` receives each attachment and
 * may return a substitute node. One walker keeps items, paths and
 * replacements aligned.
 * 按请求体顺序遍历附件；items、路径与替换共用同一遍历，保证序号一致。
 */
function walk(value: unknown, onAttachment: (visit: Visit, view?: ImageView) => unknown, depth = 0): unknown {
  if (depth > 80 || !value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((child) => walk(child, onAttachment, depth + 1));
  const record = value as Record<string, unknown>;
  const view = imageView(record);
  if (view) return onAttachment({ image: view.image, path: localAttachmentPath(record) }, view) ?? value;
  if (isOpaqueAttachment(record)) return onAttachment({ path: localAttachmentPath(record) }) ?? value;
  const output: Record<string, unknown> = Object.create(null);
  for (const [key, child] of Object.entries(record)) {
    if (isOpaqueAttachmentKey(key)) {
      const childRecord = child && typeof child === "object" && !Array.isArray(child) ? (child as Record<string, unknown>) : undefined;
      const childView = childRecord ? imageView(childRecord) : undefined;
      // A string image_url sits on its parent; view the parent shape instead.
      // 字符串形式的 image_url 位于父对象，按父对象结构识别。
      output[key] = onAttachment(
        { image: childView?.image, path: childRecord ? localAttachmentPath(childRecord) : undefined },
        childView,
      ) ?? child;
    } else output[key] = walk(child, onAttachment, depth + 1);
  }
  return output;
}

/** Return a local source path for each attachment when the payload contains one. */
export function attachmentPaths(value: unknown): Array<string | undefined> {
  const paths: Array<string | undefined> = [];
  walk(value, (visit) => { paths.push(visit.path); return undefined; });
  return paths;
}

function localAttachmentPath(record: Record<string, unknown>): string | undefined {
  for (const key of ["filePath", "file_path", "path"]) {
    const candidate = record[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate;
  }
  for (const key of ["source", "file", "metadata"]) {
    const nested = record[key];
    if (nested && typeof nested === "object") {
      const path = localAttachmentPath(nested as Record<string, unknown>);
      if (path) return path;
    }
  }
  return undefined;
}

/** Return every opaque attachment independently, in payload order. / 按顺序逐个返回不透明附件。 */
export function attachmentItems(value: unknown): AttachmentItem[] {
  const items: AttachmentItem[] = [];
  walk(value, (visit) => { items.push(visit.image); return undefined; });
  return items;
}

type PayloadNode = object | string | number | boolean | null | undefined;

/**
 * Replace inline images by image order without mutating the original payload.
 * 按图片顺序替换内嵌图片，不修改原始请求体。
 */
export function replaceImageAttachments(
  value: unknown,
  replacements: ReadonlyArray<ImageReplacement | undefined>,
): PayloadNode {
  let index = 0;
  return walk(value, (visit, view) => {
    if (!visit.image || !view) return undefined;
    const replacement = replacements[index++];
    return replacement ? view.write(replacement) : undefined;
  }) as PayloadNode;
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
