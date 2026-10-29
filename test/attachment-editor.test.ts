import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { editImageAttachment, supportsImageEditing, viewImageAttachment } from "../src/attachment-editor.ts";

const tinyPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/pV8AAAAASUVORK5CYII=",
  "base64",
);

test("edit attachment uses a private copy and returns saved bytes", async () => {
  assert.equal(supportsImageEditing({ data: tinyPng.toString("base64"), mimeType: "image/png" }), true);
  assert.equal(supportsImageEditing({ data: tinyPng.toString("base64"), mimeType: "image/svg+xml" }), false);
  let scratchPath = "";
  const editedBytes = Buffer.concat([tinyPng.subarray(0, 8), Buffer.from("edited-image-data")]);
  const result = await editImageAttachment(
    { data: tinyPng.toString("base64"), mimeType: "image/png" },
    async (path) => {
      scratchPath = path;
      assert.equal(statSync(path).mode & 0o777, 0o600);
      assert.deepEqual(readFileSync(path), tinyPng);
      writeFileSync(path, editedBytes);
    },
  );
  assert.equal(result.data, editedBytes.toString("base64"));
  assert.equal(result.mimeType, "image/png");
  assert.ok(scratchPath);
  assert.equal(existsSync(scratchPath), false, "the temporary image is removed after editing");
});

test("view attachment shows the exact bytes read-only and removes the copy / 查看附件展示原始字节且只读，并删除副本", async () => {
  let viewed = "";
  await viewImageAttachment({ data: tinyPng.toString("base64"), mimeType: "image/png" }, async (path) => {
    viewed = path;
    assert.ok(path.endsWith(".png"));
    assert.equal(statSync(path).mode & 0o777, 0o400);
    assert.deepEqual(readFileSync(path), tinyPng);
  });
  assert.equal(existsSync(viewed), false, "the viewing copy is removed after returning");
  // Format comes from the bytes, not the declared type. / 格式按字节判断，而非声明类型。
  await viewImageAttachment({ data: tinyPng.toString("base64"), mimeType: "image/jpeg" }, async (path) => {
    assert.ok(path.endsWith(".png"));
  });
  await assert.rejects(viewImageAttachment({ data: Buffer.from("not an image").toString("base64") }, async () => {}));
  let failedPath = "";
  await assert.rejects(viewImageAttachment({ data: tinyPng.toString("base64") }, async (path) => {
    failedPath = path;
    throw new Error("viewer failed");
  }));
  assert.equal(existsSync(failedPath), false, "the copy is removed even when the viewer fails");
});

test("edit attachment rejects unsupported formats and unsafe editor output", async () => {
  await assert.rejects(
    editImageAttachment({ data: tinyPng.toString("base64"), mimeType: "image/svg+xml" }, async () => {}),
  );
  await assert.rejects(
    editImageAttachment({ data: tinyPng.toString("base64"), mimeType: "image/png" }, async (path) => {
      writeFileSync(path, "not an image");
    }),
  );
});
