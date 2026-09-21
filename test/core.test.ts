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

async function fixture(
  t: { after(fn: () => void): void },
  words: Rule[] = [],
  timeout = 2000,
) {
  const dir = mkdtempSync(join(tmpdir(), "spi-test-"));
  const path = join(dir, "protecter.json");
  const engine = new Protecter(dir, timeout, () => "a".repeat(32));
  const save = (rules: Rule[]) =>
    writeFileSync(path, JSON.stringify({ version: 1, sensitiveWords: rules }));
  save(words);
  await engine.initialize();
  const activePath = engine.configPath;
  const saveActive = (rules: Rule[]) =>
    writeFileSync(
      activePath,
      JSON.stringify({ version: 1, sensitiveWords: rules }),
    );
  t.after(() => {
    engine.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, path: activePath, engine, save: saveActive };
}

test("configuration is private, non-destructive, strict and has sanitized errors", async (t) => {
  const { path, engine } = await fixture(t, ["private-value"]);
  const before = readFileSync(path, "utf8");
  chmodSync(path, 0o644);
  await engine.initialize();
  assert.equal(readFileSync(path, "utf8"), before);
  if (process.platform !== "win32")
    assert.equal(statSync(path).mode & 0o777, 0o600);
  // Errors name the failing rule and stage without echoing configuration text.
  // 错误指出失败规则和阶段，不回显配置内容。
  for (const [sensitiveWords, code] of [
    [[""], "CONFIG_SCHEMA"],
    [[{ type: "regex", pattern: "(" }], "CONFIG_REGEX"],
    [[{ type: "regex", pattern: "x", flags: "y" }], "CONFIG_REGEX"],
    [[{ type: "literal", value: "x", typo: 1 }], "CONFIG_SCHEMA"],
  ] as const) {
    assert.throws(
      () => parseConfig(JSON.stringify({ version: 1, sensitiveWords })),
      (error) => {
        const message = (error as Error).message;
        return (
          message.includes(`code=${code}`) &&
          message.includes("rule=1") &&
          message.includes("stage=configuration")
        );
      },
    );
  }
  assert.throws(
    () => parseConfig('{"super-secret-invalid'),
    (error) =>
      !(error as Error).message.includes("super-secret") &&
      (error as Error).message.includes("code=CONFIG_JSON"),
  );
  assert.throws(() =>
    parseConfig('{"version":1,"sensitiveWords":[],"typo":true}'),
  );
});

test("reject symlink and hard-linked config files", async (t) => {
  const { dir, path } = await fixture(t);
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
  const { engine } = await fixture(t, words);
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
  // Replacements keep length, character classes and punctuation structure.
  // 替换值保持长度、字符类别和标点结构。
  const shaped = masked as typeof payload;
  assert.equal(shaped.system.length, payload.system.length);
  assert.match(shaped.system, /^用户 [\u4e00-\u9fa5]{2}$/);
  assert.match(
    shaped.messages[0].content,
    /^[a-z]{5}:\/\/[a-z]+\.[a-z]+\/[a-z]$/,
  );
  assert.match(shaped.messages[1].content, /^[a-z]{4}-[a-z]{8} and \d{11}$/);
});

test("same value reuses random token, parallel scans agree and tokens are idempotent", async (t) => {
  const { engine } = await fixture(t, ["secret"]);
  const [a, b] = await Promise.all([
    engine.redact("secret"),
    engine.redact("secret"),
  ]);
  assert.equal(a, b);
  assert.equal(await engine.redact(a), a);
  const other = (await fixture(t, ["secret"])).engine;
  assert.notEqual(await other.redact("secret"), a);
  // Unknown text is never restored, only recorded replacements are. / 未知文本不还原，仅还原已记录的替换值。
  assert.equal(engine.restoreText("unrelated-value"), "unrelated-value");
});

test("regex captures replace only full match, retain exact case, and handle overlapping rules", async (t) => {
  const { engine } = await fixture(t, [
    "abc",
    "bcde",
    { type: "regex", pattern: "(?<=Bearer )[A-Z]+", flags: "i" },
  ]);
  const input = "abcde Bearer SeCrEt Bearer OTHER";
  const masked = (await engine.redact(input)) as string;
  // Case pattern and word boundaries survive; only letters change. / 保留大小写形态与边界，仅替换字母。
  assert.match(masked, /^[a-z]{5} Bearer [A-Za-z]{6} Bearer [A-Z]{5}$/);
  assert.notEqual(masked, input);
  assert.equal(engine.restoreText(masked), input);
});

test("learned regex matches remain protected after context loss and rule removal", async (t) => {
  const { engine, save } = await fixture(t, [
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
  const { engine } = await fixture(t, [secret]);
  const payload = { arguments: JSON.stringify({ password: secret }) };
  const masked = (await engine.redact(payload)) as typeof payload;
  const decoded = JSON.parse(masked.arguments);
  assert.notEqual(decoded.password, secret);
  assert.deepEqual(JSON.parse(JSON.stringify(engine.restore(decoded))), {
    password: secret,
  });
});

test("rules spanning JSON syntax keep the argument parseable / 跨 JSON 语法的规则仍保持可解析", async (t) => {
  const { engine } = await fixture(t, ['{"pin":"1234"}']);
  const masked = (await engine.redact({ arguments: '{"pin":"1234"}' })) as {
    arguments: string;
  };
  // Punctuation is preserved, so the embedded JSON still parses. / 标点保留，内嵌 JSON 仍可解析。
  assert.notEqual(masked.arguments, '{"pin":"1234"}');
  const parsed = JSON.parse(masked.arguments);
  assert.equal(Object.keys(parsed).length, 1);
  assert.match(Object.keys(parsed)[0], /^[a-z]{3}$/);
  assert.match(String(Object.values(parsed)[0]), /^\d{4}$/);
  assert.equal(engine.restoreText(masked.arguments), '{"pin":"1234"}');
});

test("numeric IDs, unicode, full config and prototype keys", async (t) => {
  const { engine, path } = await fixture(t, ["13800138000", "姓名😀"]);
  const numeric = (await engine.redact({ number: 13800138000 })) as {
    number: number;
  };
  // A numeric field must stay a number with the same digit count. / 数值字段保持数字类型与位数。
  assert.equal(typeof numeric.number, "number");
  assert.equal(String(numeric.number).length, "13800138000".length);
  assert.notEqual(numeric.number, 13800138000);
  assert.equal(engine.restoreText(String(numeric.number)), "13800138000");
  const raw = readFileSync(path, "utf8");
  const masked = (await engine.redact(raw)) as string;
  assert.notEqual(masked, raw);
  assert.equal(engine.restoreText(masked), raw);
  const object = JSON.parse('{"__proto__":"姓名😀"}');
  const roundtrip = engine.restore(await engine.redact(object)) as Record<
    string,
    unknown
  >;
  assert.equal(Object.getPrototypeOf(roundtrip), null);
  assert.equal(roundtrip.__proto__, "姓名😀");
});

test("memory snapshot survives edits and deletion / 内存快照不受修改删除影响", async (t) => {
  const { engine, path, save } = await fixture(t, ["old"]);
  const token = await engine.redact("old");
  save(["new"]);
  assert.equal(await engine.redact("new"), "new");
  assert.equal(await engine.redact("old"), token);
  await engine.initialize();
  assert.notEqual(await engine.redact("new"), "new");
  writeFileSync(path, "broken-private-config");
  assert.notEqual(await engine.redact("new"), "new");
  rmSync(path);
  assert.notEqual(await engine.redact("new"), "new");
  writeFileSync(path, "broken-private-config");
  await assert.rejects(engine.initialize());
  await assert.rejects(engine.redact("new"));
});

test("regex timeout and zero-width runtime matches fail without leaking or hanging", async (t) => {
  const { engine, save } = await fixture(
    t,
    [{ type: "regex", pattern: "(a+)+$" }],
    150,
  );
  const started = Date.now();
  await assert.rejects(engine.redact("a".repeat(10000) + "!"));
  assert.ok(Date.now() - started < 3000);
  save([{ type: "regex", pattern: "(?=x)" }]);
  await engine.initialize();
  await assert.rejects(engine.redact("x"));
});

test("common opaque attachments and limits are rejected", async (t) => {
  const { engine } = await fixture(t);
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

test("path guard handles relative, @, file URL, symlink, hardlink, parents and shell mention", async (t) => {
  const { path, dir } = await fixture(t);
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
    blocksConfigAccess(
      "write",
      { path: "README.md", content: `protecter.json ${path}` },
      dir,
      path,
    ),
    false,
  );
  assert.equal(
    blocksConfigAccess("bash", { command: "npm test" }, dir, path),
    false,
  );
});

test("shutdown destroys mappings and prevents future scans", async (t) => {
  const { engine } = await fixture(t, ["secret"]);
  const token = (await engine.redact("secret")) as string;
  engine.close();
  assert.equal(engine.mappingCount, 0);
  assert.equal(engine.restoreText(token), token);
  await assert.rejects(engine.redact("secret"));
});
