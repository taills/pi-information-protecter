import { constants } from "node:fs";
import { spawn } from "node:child_process";
import { lstat, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { failure } from "./diagnostics.ts";

export interface EditableImage {
  data: string;
  mimeType?: string;
}

const IMAGE_FORMATS: Record<string, { extension: string; mimeType: string }> = {
  "image/png": { extension: ".png", mimeType: "image/png" },
  "image/jpeg": { extension: ".jpg", mimeType: "image/jpeg" },
  "image/webp": { extension: ".webp", mimeType: "image/webp" },
  "image/gif": { extension: ".gif", mimeType: "image/gif" },
};
const MAX_EDIT_IMAGE_BYTES = 25 * 1024 * 1024;

export function supportsImageEditing(image: EditableImage): boolean {
  const mimeType = image.mimeType ?? "image/png";
  const format = IMAGE_FORMATS[mimeType];
  if (!format || image.data.length > Math.ceil((MAX_EDIT_IMAGE_BYTES * 4) / 3) + 4) return false;
  return imageMimeType(Buffer.from(image.data, "base64")) === mimeType;
}

/** Open the temp copy with the OS file association, without a shell. / 不经 shell 调用系统文件关联打开临时副本。 */
export async function openImageWithDefaultApp(path: string): Promise<void> {
  let command = "";
  if (process.platform === "darwin") command = "open";
  else if (process.platform === "win32") command = "explorer.exe";
  else if (process.platform === "linux") command = "xdg-open";
  if (!command) throw failure("SCAN_ATTACHMENT");
  const args = [path];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

function imageMimeType(bytes: Buffer): string | undefined {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return "image/jpeg";
  if (bytes.length >= 6 && (bytes.toString("ascii", 0, 6) === "GIF87a" || bytes.toString("ascii", 0, 6) === "GIF89a"))
    return "image/gif";
  if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP")
    return "image/webp";
  return undefined;
}

/**
 * Show the exact bytes that will be sent in the OS image viewer, for terminals
 * without an inline image protocol. The read-only private copy is removed
 * after `view` returns.
 * 在不支持内联图片的终端中，用系统看图软件展示即将发送的原始字节；`view` 返回后删除只读私有副本。
 */
export async function viewImageAttachment(
  image: EditableImage,
  view: (path: string) => Promise<void>,
): Promise<void> {
  const bytes = Buffer.from(image.data, "base64");
  const format = IMAGE_FORMATS[imageMimeType(bytes) ?? ""];
  if (!format || bytes.length > MAX_EDIT_IMAGE_BYTES) throw failure("SCAN_ATTACHMENT");
  const directory = await mkdtemp(join(tmpdir(), "pi-protecter-view-"));
  try {
    const path = join(directory, `attachment${format.extension}`);
    await writeFile(path, bytes, { mode: 0o400, flag: "wx" });
    await view(path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** Safely edit a private temporary copy and return the saved image bytes. / 安全编辑私有临时副本并返回保存后的图片数据。 */
export async function editImageAttachment(
  image: EditableImage,
  edit: (path: string) => Promise<void>,
): Promise<Required<EditableImage>> {
  const mimeType = image.mimeType ?? "image/png";
  const format = IMAGE_FORMATS[mimeType];
  if (!format) throw failure("SCAN_ATTACHMENT");
  const original = Buffer.from(image.data, "base64");
  const canonicalBase64 = original.toString("base64").replace(/=+$/, "");
  if (
    !original.length || original.length > MAX_EDIT_IMAGE_BYTES ||
    canonicalBase64 !== image.data.replace(/=+$/, "") || imageMimeType(original) !== mimeType
  )
    throw failure("SCAN_ATTACHMENT");

  const directory = await mkdtemp(join(tmpdir(), "pi-protecter-image-"));
  const path = join(directory, `attachment${format.extension}`);
  try {
    await writeFile(path, original, { mode: 0o600, flag: "wx" });
    await edit(path);

    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size <= 0 || info.size > MAX_EDIT_IMAGE_BYTES)
      throw failure("SCAN_ATTACHMENT");
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    let saved: Buffer;
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.nlink !== 1 || opened.size <= 0 || opened.size > MAX_EDIT_IMAGE_BYTES)
        throw failure("SCAN_ATTACHMENT");
      saved = await handle.readFile();
    } finally {
      await handle.close();
    }
    const savedMimeType = imageMimeType(saved);
    if (!savedMimeType || !IMAGE_FORMATS[savedMimeType] || saved.equals(original))
      throw failure("SCAN_ATTACHMENT");
    return { data: saved.toString("base64"), mimeType: savedMimeType };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
