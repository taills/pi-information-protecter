import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { editImageAttachment, supportsImageEditing } from "../src/attachment-editor.ts";

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
