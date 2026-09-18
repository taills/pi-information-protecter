import assert from "node:assert/strict";
import { test } from "node:test";
import {
  chmodSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig, parseConfig, type Rule } from "../src/config.ts";
import { Protecter } from "../src/engine.ts";
import { blocksConfigAccess } from "../src/guard.ts";

function fixture(
  t: { after(fn: () => void): void },
  words: Rule[] = [],
  timeout = 2000,
) {
  const dir = mkdtempSync(join(tmpdir(), "spi-test-"));
  const path = join(dir, "protecter.json");
  const engine = new Protecter(path, timeout);
  engine.initialize();
  const save = (rules: Rule[]) =>
    writeFileSync(path, JSON.stringify({ version: 1, sensitiveWords: rules }));
  save(words);
  t.after(() => {
    engine.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, path, engine, save };
}

test("configuration is private, non-destructive, strict and has sanitized errors", (t) => {
  const { path, engine } = fixture(t, ["private-value"]);
  const before = readFileSync(path, "utf8");
  chmodSync(path, 0o644);
  engine.initialize();
  assert.equal(readFileSync(path, "utf8"), before);
  if (process.platform !== "win32")
    assert.equal(statSync(path).mode & 0o777, 0o600);
  for (const sensitiveWords of [
    [""],
    [{ type: "regex", pattern: "(" }],
    [{ type: "regex", pattern: ".*" }],
    [{ type: "regex", pattern: "x", flags: "y" }],
    [{ type: "literal", value: "x", typo: 1 }],
  ]) {
    assert.throws(
      () => parseConfig(JSON.stringify({ version: 1, sensitiveWords })),
      /配置/,
    );
  }
  assert.throws(
    () => parseConfig('{"super-secret-invalid'),
    (error) => !(error as Error).message.includes("super-secret"),
  );
  assert.throws(() =>
    parseConfig('{"version":1,"sensitiveWords":[],"typo":true}'),
  );
});

test("reject symlink and hard-linked config files", (t) => {
  const { dir, path } = fixture(t);
  const alias = join(dir, "alias");
  symlinkSync(path, alias);
  assert.throws(() => loadConfig(alias));
  rmSync(alias);
  linkSync(path, alias);
  assert.throws(() => loadConfig(path));
});

test("redact all payload text and restore without mutating local source", async (t) => {
  const words = [
    "张三",
    "https://internal.test/a",
    "fake-password",
    "13800138000",
  ];
  const { engine } = fixture(t, words);
  const payload = {
    model: "safe-model",
    system: "用户 张三",
    messages: [
      { role: "user", content: "https://internal.test/a" },
      { role: "tool", content: "fake-password and 13800138000" },
    ],
    tools: [
      {
        name: "lookup",
        description: "张三",
        parameters: { properties: { "fake-password": { type: "string" } } },
      },
    ],
  };
  const original = structuredClone(payload);
  const masked = await engine.redact(payload);
  for (const word of words) assert.ok(!JSON.stringify(masked).includes(word));
  assert.deepEqual(
    JSON.parse(JSON.stringify(engine.restore(masked))),
    original,
  );
  assert.deepEqual(payload, original);
  assert.match(JSON.stringify(masked), /__PIP_[a-f0-9]{48}__/);
});

test("same value reuses random token, parallel scans agree and tokens are idempotent", async (t) => {
  const { engine } = fixture(t, ["secret"]);
  const [a, b] = await Promise.all([
    engine.redact("secret"),
    engine.redact("secret"),
  ]);
  assert.equal(a, b);
  assert.equal(await engine.redact(a), a);
  const other = fixture(t, ["secret"]).engine;
  assert.notEqual(await other.redact("secret"), a);
  const fabricated = `__PIP_${"a".repeat(48)}__`;
  assert.equal(engine.restoreText(fabricated), fabricated);
});

test("regex captures replace only full match, retain exact case, and handle overlapping rules", async (t) => {
  const { engine } = fixture(t, [
    "abc",
    "bcde",
    { type: "regex", pattern: "(?<=Bearer )[A-Z]+", flags: "i" },
  ]);
  const input = "abcde Bearer SeCrEt Bearer OTHER";
  const masked = (await engine.redact(input)) as string;
  assert.equal(
    masked.replace(/__PIP_[a-f0-9]{48}__/g, "TOKEN"),
    "TOKEN Bearer TOKEN Bearer TOKEN",
  );
  assert.ok(masked.includes("Bearer "));
  assert.equal(engine.restoreText(masked), input);
});

test("learned regex matches remain protected after context loss and rule removal", async (t) => {
  const { engine, save } = fixture(t, [
    { type: "regex", pattern: "(?<=Bearer )[A-Za-z]+" },
  ]);
  const masked = (await engine.redact("Bearer PrivateToken")) as string;
  const token = masked.slice("Bearer ".length);
  assert.equal(engine.restoreText(token), "PrivateToken");
  assert.equal(await engine.redact("PrivateToken"), token);
  save([]);
  assert.equal(await engine.redact("PrivateToken"), token);
});

test("JSON-encoded arguments unescape sensitive values before matching", async (t) => {
  const secret = 'p\\a"ss\nword';
  const { engine } = fixture(t, [secret]);
  const payload = { arguments: JSON.stringify({ password: secret }) };
  const masked = (await engine.redact(payload)) as typeof payload;
  const decoded = JSON.parse(masked.arguments);
  assert.notEqual(decoded.password, secret);
  assert.deepEqual(JSON.parse(JSON.stringify(engine.restore(decoded))), {
    password: secret,
  });
});

test("rules spanning JSON syntax reject rather than silently bypass matching", async (t) => {
  const { engine } = fixture(t, ['{"pin":"1234"}']);
  await assert.rejects(engine.redact({ arguments: '{"pin":"1234"}' }));
});

test("numeric IDs, unicode, full config and prototype keys", async (t) => {
  const { engine, path } = fixture(t, ["13800138000", "姓名😀"]);
  const numeric = (await engine.redact({ number: 13800138000 })) as {
    number: string;
  };
  assert.match(numeric.number, /^__PIP_/);
  const raw = readFileSync(path, "utf8");
  const masked = (await engine.redact(raw)) as string;
  assert.match(masked, /^__PIP_/);
  assert.equal(engine.restoreText(masked), raw);
  const object = JSON.parse('{"__proto__":"姓名😀"}');
  const roundtrip = engine.restore(await engine.redact(object)) as Record<
    string,
    unknown
  >;
  assert.equal(Object.getPrototypeOf(roundtrip), null);
  assert.equal(roundtrip.__proto__, "姓名😀");
});

test("config changes apply to each request; corruption/deletion fails closed", async (t) => {
  const { engine, path, save } = fixture(t, ["old"]);
  const token = (await engine.redact("old")) as string;
  save(["new"]);
  assert.notEqual(await engine.redact("new"), "new");
  assert.equal(engine.restoreText(token), "old");
  writeFileSync(path, "broken-private-config");
  await assert.rejects(engine.redact("private-input"));
  rmSync(path);
  await assert.rejects(engine.redact("private-input"));
});

test("regex timeout and zero-width runtime matches fail without leaking or hanging", async (t) => {
  const { engine, save } = fixture(
    t,
    [{ type: "regex", pattern: "(a+)+$" }],
    150,
  );
  const started = Date.now();
  await assert.rejects(engine.redact("a".repeat(10000) + "!"));
  assert.ok(Date.now() - started < 3000);
  save([{ type: "regex", pattern: "(?=x)" }]);
  await assert.rejects(engine.redact("x"));
});

test("common opaque attachments and limits are rejected", async (t) => {
  const { engine } = fixture(t);
  for (const payload of [
    { content: [{ type: "image", data: "secret-binary" }] },
    { content: [{ type: "input_image", image_url: "https://image" }] },
    { parts: [{ inlineData: { mimeType: "image/png", data: "private" } }] },
    { parts: [{ fileData: { fileUri: "private" } }] },
    { type: "document", source: { data: "private" } },
    "x".repeat(8 * 1024 * 1024 + 1),
  ])
    await assert.rejects(engine.redact(payload));
});

test("path guard handles relative, @, file URL, symlink, hardlink, parents and shell mention", (t) => {
  const { path, dir } = fixture(t);
  const alias = join(dir, "alias");
  symlinkSync(path, alias);
  for (const candidate of [
    path,
    "@protecter.json",
    "protecter.json",
    pathToFileURL(path).href,
    alias,
  ]) {
    assert.equal(
      blocksConfigAccess("read", { path: candidate }, dir, path),
      true,
    );
  }
  rmSync(alias);
  linkSync(path, alias);
  assert.equal(blocksConfigAccess("edit", { path: alias }, dir, path), true);
  assert.equal(blocksConfigAccess("grep", { path: dir }, dir, path), true);
  assert.equal(blocksConfigAccess("find", {}, dir, path), true);
  assert.equal(
    blocksConfigAccess(
      "bash",
      { command: "cat ~/.pi/agent/protecter.json" },
      dir,
      path,
    ),
    true,
  );
  assert.equal(
    blocksConfigAccess("read", { path: "src/app.ts" }, dir, path),
    false,
  );
  assert.equal(
    blocksConfigAccess("bash", { command: "npm test" }, dir, path),
    false,
  );
});

test("shutdown destroys mappings and prevents future scans", async (t) => {
  const { engine } = fixture(t, ["secret"]);
  const token = (await engine.redact("secret")) as string;
  engine.close();
  assert.equal(engine.mappingCount, 0);
  assert.equal(engine.restoreText(token), token);
  await assert.rejects(engine.redact("secret"));
});
