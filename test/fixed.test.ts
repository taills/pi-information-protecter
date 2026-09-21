import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Protecter } from "../src/engine.ts";
import { parseConfig, type Rule } from "../src/config.ts";
import { migrateConfig } from "../src/migration.ts";

async function fixture(t: { after(fn: () => void): void }, rules: Rule[]) {
  const dir = mkdtempSync(join(tmpdir(), "spi-fixed-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(
    join(dir, "protecter.json"),
    JSON.stringify({ version: 1, sensitiveWords: rules }),
  );
  const engine = new Protecter(dir, 2000, () => "a".repeat(32));
  t.after(() => engine.close());
  await engine.initialize();
  return { engine, dir };
}

test("fixed literals plus random fallback and audit / 固定字面替换、随机回退及审计", async (t) => {
  const { engine } = await fixture(t, [
    { type: "literal", value: "Apple Inc.", replacement: "Alphabet Inc." },
    { type: "literal", value: "test-key-123", replacement: "MyPrivateKey" },
    "random-secret",
  ]);
  const original = "Apple Inc. test-key-123 random-secret";
  const masked = (await engine.redact(original, "demo")) as string;
  assert.match(masked, /^Alphabet Inc\. MyPrivateKey __PIP_[a-f0-9]{48}__$/);
  assert.equal(engine.restoreText(masked), original);
  assert.equal(await engine.redact(masked), masked);
  assert.equal(engine.restoreText("AlphabetXInc."), "AlphabetXInc.");
  assert.equal(await engine.redact(original), masked);
  assert.equal(engine.auditRecords().records[0].replacement, "Alphabet Inc.");
});

test("multi-turn history keeps exact redacted prefixes / 多轮历史保持精确脱敏前缀", async (t) => {
  const { engine } = await fixture(t, [
    "random-secret",
    { type: "literal", value: "Apple Inc.", replacement: "Alphabet Inc." },
  ]);
  const first = [{ role: "user", content: "random-secret Apple Inc." }];
  const masked = (await engine.redact(first)) as typeof first;
  const restored = engine.restoreText(masked[0].content);
  const next = (await engine.redact([
    ...first,
    { role: "assistant", content: restored },
    { role: "user", content: "continue" },
  ])) as typeof first;
  assert.equal(JSON.stringify(next[0]), JSON.stringify(masked[0]));
  assert.equal(next[1].content, masked[0].content);
});

test("regex fixed values retain reversibility and reject multiple originals / 正则固定替换可还原并拒绝多原文", async (t) => {
  const { engine } = await fixture(t, [
    { type: "regex", pattern: "key-[0-9]+", replacement: "MyPrivateKey" },
  ]);
  assert.equal(await engine.redact("key-123"), "MyPrivateKey");
  assert.equal(engine.restoreText("MyPrivateKey"), "key-123");
  await assert.rejects(engine.redact("key-456"));
  assert.equal(engine.auditRecords().records.length, 1);
});

test("replacement is literal including dollar and quotes / 替换值按字面处理含美元符与引号", async (t) => {
  const replacement = '$& "alias"\nline';
  const { engine } = await fixture(t, [
    { type: "literal", value: "secret", replacement },
  ]);
  const masked = (await engine.redact({
    arguments: JSON.stringify({ value: "secret" }),
  })) as { arguments: string };
  assert.equal(JSON.parse(masked.arguments).value, replacement);
  assert.equal(engine.restoreText(replacement), "secret");
  assert.equal(engine.auditRecords().records[0].replacement, replacement);
});

test("reject invalid targets and ambiguous definitions / 拒绝非法目标与歧义定义", async (t) => {
  for (const replacement of ["", "   ", null, 12, "__PIP_fake__"]) {
    assert.throws(() =>
      parseConfig(
        JSON.stringify({
          version: 1,
          sensitiveWords: [{ type: "literal", value: "secret", replacement }],
        }),
      ),
    );
  }
  for (const rules of [
    [{ type: "literal", value: "secret", replacement: "secret-copy" }],
    [
      { type: "literal", value: "one", replacement: "Alias" },
      { type: "literal", value: "two", replacement: "Alias" },
    ],
    [
      { type: "literal", value: "one", replacement: "Alias" },
      { type: "literal", value: "two", replacement: "AliasLong" },
    ],
    ["secret", { type: "literal", value: "secret", replacement: "Alias" }],
    [{ type: "literal", value: "one", replacement: "two" }, "two"],
  ] as Rule[][])
    await assert.rejects(fixture(t, rules));
});

test("fixed overlapping matches fail instead of dropping suffix / 固定重叠匹配拒绝而非泄漏后缀", async (t) => {
  const { engine } = await fixture(t, [
    { type: "literal", value: "abc", replacement: "Alias" },
    "bcde",
  ]);
  await assert.rejects(engine.redact("abcde"));
  assert.equal(engine.auditRecords().records.length, 0);
});

test("regex cannot leak by crossing a learned fixed alias / 正则不能跨已学习别名泄漏", async (t) => {
  const { engine } = await fixture(t, [
    { type: "literal", value: "original", replacement: "Alias" },
    { type: "regex", pattern: "prefixAliasSuffix" },
  ]);
  await engine.redact("original");
  await assert.rejects(engine.redact("prefixAliasSuffix"));
});

test("migration preserves fixed target and stops conflicting merge / 迁移保留固定目标并拒绝冲突合并", async (t) => {
  const { engine, dir } = await fixture(t, [
    { type: "literal", value: "secret", replacement: "Alias" },
  ]);
  assert.equal(
    JSON.parse(readFileSync(engine.configPath, "utf8")).sensitiveWords[0]
      .replacement,
    "Alias",
  );
  const before = readFileSync(engine.configPath, "utf8");
  const legacy = join(dir, "protecter.json");
  writeFileSync(
    legacy,
    JSON.stringify({
      version: 1,
      sensitiveWords: [
        { type: "literal", value: "secret", replacement: "Other" },
      ],
    }),
  );
  await assert.rejects(migrateConfig(dir, "a".repeat(32)));
  assert.equal(readFileSync(engine.configPath, "utf8"), before);
  assert.ok(readFileSync(legacy, "utf8").includes("Other"));
});
