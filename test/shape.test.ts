import { test } from "node:test";
import assert from "node:assert/strict";
import { isIPv4, isIPv6 } from "node:net";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Protecter } from "../src/engine.ts";
import { type Rule } from "../src/config.ts";

async function fixture(t: { after(fn: () => void): void }, rules: Rule[]) {
  const dir = fs.mkdtempSync(join(tmpdir(), "spi-shape-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(
    join(dir, "protecter.json"),
    JSON.stringify({ version: 1, sensitiveWords: rules }),
  );
  const engine = new Protecter(dir, 2000, () => "a".repeat(32));
  t.after(() => engine.close());
  await engine.initialize();
  return { engine };
}

function codeOf(action: Promise<unknown>): Promise<string> {
  return action.then(
    () => "NO_ERROR",
    (error) =>
      (error as Error).message.match(/code=([A-Z_]+)/)?.[1] ?? "UNPARSED",
  );
}

test("numeric schema values stay numbers / 数值型结构字段保持数字类型", async (t) => {
  // Reproduces the reported provider error: a numeric limit became a string.
  // 复现上报的提供商错误：数值上限被替换成字符串。
  const { engine } = await fixture(t, [
    { type: "regex", pattern: "(?<!\\d)\\d{10,19}(?!\\d)" },
  ]);
  const payload = {
    tools: [
      {
        name: "playwright_browser_network_request",
        parameters: {
          properties: { index: { type: "integer", maximum: 9007199254740991 } },
        },
      },
    ],
  };
  const masked = (await engine.redact(payload, "anthropic")) as typeof payload;
  const limit = masked.tools[0].parameters.properties.index.maximum;
  assert.equal(typeof limit, "number");
  assert.ok(Number.isSafeInteger(limit));
  assert.equal(String(limit).length, 16);
  assert.notEqual(limit, 9007199254740991);
  // The payload still serializes and parses as the same JSON types.
  // 请求体仍可序列化并解析为相同的 JSON 类型。
  assert.equal(
    typeof JSON.parse(JSON.stringify(masked)).tools[0].parameters.properties
      .index.maximum,
    "number",
  );
  assert.equal(engine.restoreText(String(limit)), "9007199254740991");
});

test("digit runs keep length and leading zeros / 数字串保持长度与前导零", async (t) => {
  const { engine } = await fixture(t, [
    { type: "regex", pattern: "(?<!\\d)\\d{6,}(?!\\d)" },
  ]);
  const masked = (await engine.redact({
    id: "000123456",
    phone: "13800138000",
    text: "order 987654 shipped",
  })) as Record<string, string>;
  // In string context every digit is replaced, so zero positions stay private.
  // 字符串上下文中每位数字都替换，不泄露零的位置。
  assert.match(masked.id, /^\d{9}$/);
  assert.notEqual(masked.id, "000123456");
  assert.equal(engine.restoreText(masked.id), "000123456");
  assert.equal(masked.phone.length, 11);
  assert.match(masked.phone, /^\d{11}$/);
  assert.match(masked.text, /^order \d{6} shipped$/);
  assert.notEqual(masked.phone, "13800138000");
  assert.equal(engine.restoreText(masked.phone), "13800138000");
});

test("scripts are replaced within their own writing system / 各文字体系内替换", async (t) => {
  const samples = {
    chinese: "张三李四",
    japaneseHiragana: "ひらがな",
    japaneseKatakana: "カタカナ",
    korean: "홍길동",
    cyrillic: "Иванов",
    greek: "Παπαδόπουλος",
    vietnamese: "Nguyễn Văn Tèo",
    thai: "สมชาย",
    arabic: "محمد",
  };
  const { engine } = await fixture(t, Object.values(samples));
  const masked = (await engine.redact({ ...samples })) as typeof samples;
  const ranges: Record<keyof typeof samples, RegExp> = {
    chinese: /^[\u4e00-\u9fa5]{4}$/,
    japaneseHiragana: /^[\u3041-\u3096]{4}$/,
    japaneseKatakana: /^[\u30a1-\u30fa]{4}$/,
    korean: /^[\uac00-\ud7a3]{3}$/,
    cyrillic: /^[\u0410-\u044f]{6}$/,
    greek: /^[\u0391-\u03ce]{12}$/,
    vietnamese:
      /^[A-Za-z\u00c0-\u017f\u1e00-\u1eff]+ [A-Za-z\u00c0-\u017f\u1e00-\u1eff]+ [A-Za-z\u00c0-\u017f\u1e00-\u1eff]+$/,
    thai: /^[\u0e01-\u0e2e\u0e30-\u0e3a\u0e40-\u0e4e]{5}$/,
    arabic: /^[\u0621-\u064a]{4}$/,
  };
  for (const key of Object.keys(samples) as (keyof typeof samples)[]) {
    assert.match(masked[key], ranges[key], `${key}: ${masked[key]}`);
    assert.equal(
      [...masked[key]].length,
      [...samples[key]].length,
      `${key} length`,
    );
    assert.notEqual(masked[key], samples[key], `${key} unchanged`);
    assert.equal(engine.restoreText(masked[key]), samples[key]);
  }
  // Spaces inside Vietnamese names are structure, not content. / 越南语姓名中的空格属于结构而非内容。
  assert.equal(masked.vietnamese.split(" ").length, 3);
});

test("punctuation, emoji and case layout survive / 标点、表情与大小写结构保持", async (t) => {
  const original = "Alex.Morgan+tag@Example.COM 😀 (ID-42)";
  const { engine } = await fixture(t, [original]);
  const masked = (await engine.redact(original)) as string;
  assert.notEqual(masked, original);
  assert.equal(masked.length, original.length);
  assert.ok(masked.includes("😀"));
  // Each non-letter, non-digit character keeps its position. / 非字母数字字符位置不变。
  for (const [index, char] of [...original].entries()) {
    if (!/[\p{L}\p{Nd}]/u.test(char))
      assert.equal([...masked][index], char, `position ${index}`);
  }
  assert.match(masked, /^[A-Z][a-z]{3}\.[A-Z][a-z]{5}\+[a-z]{3}@/);
  assert.equal(engine.restoreText(masked), original);
});

test("replacements never collide with payload content / 替换值不与请求内容冲突", async (t) => {
  const { engine } = await fixture(t, ["secret"]);
  const masked = (await engine.redact({
    a: "secret",
    b: "aaaaaa bbbbbb cccccc",
  })) as Record<string, string>;
  assert.notEqual(masked.a, "secret");
  assert.ok(!["aaaaaa", "bbbbbb", "cccccc"].includes(masked.a));
  assert.equal(masked.b, "aaaaaa bbbbbb cccccc");
  assert.equal(engine.restoreText(masked.a), "secret");
});

test("numeric candidates are retried, not blocked / 数值候选重试而不拦截", async (t) => {
  // A decimal or exponent match used to block roughly one request in ten,
  // because validity was checked only after a candidate was committed.
  // 跨小数或指数的匹配曾约有十分之一的请求被拦截，因为校验发生在候选值落定之后。
  // Values long enough to have distinct replacements; very short numbers are
  // covered by the fail-closed uniqueness test below.
  // 选用足够长的数值；极短数值由下方的唯一性拒绝用例覆盖。
  const numbers = [
    123.45, 9876.5432, 1234.5678, 0.00012345, 1.5e-7, 1.25e21, 2147483647,
    9007199254740991,
  ];
  for (let round = 0; round < 25; round++) {
    const { engine } = await fixture(t, [
      {
        type: "regex",
        pattern: "(?<![\\d.])[\\d.]+(?:[eE][+-]?\\d+)?(?![\\d.])",
      },
    ]);
    // Letter-only keys, so the broad pattern cannot match the key names.
    // 使用纯字母键名，避免宽泛模式匹配到键。
    const names = "abcdefgh".split("");
    const payload = Object.fromEntries(
      numbers.map((value, index) => [names[index], value]),
    );
    const masked = (await engine.redact(payload)) as Record<string, number>;
    for (const key of Object.keys(payload)) {
      assert.equal(typeof masked[key], "number", key);
      assert.ok(Number.isFinite(masked[key]), key);
    }
    // The payload must survive a JSON round trip as numbers. / 请求体经 JSON 往返后仍为数字。
    assert.deepEqual(JSON.parse(JSON.stringify(masked)), masked);
  }
});

test("exhausted and unsafe shapes fail closed / 无可用形状或数值不安全时拒绝放行", async (t) => {
  // Every single-digit candidate already appears, so uniqueness is impossible.
  // 所有单位数候选都已出现，无法生成唯一值。
  const digits = await fixture(t, [{ type: "regex", pattern: "(?<=pin )\\d" }]);
  assert.equal(
    await codeOf(digits.engine.redact({ all: "0123456789", v: "pin 7" })),
    "SCAN_UNIQUE_FAILED",
  );

  // A fixed alias is text by definition, so it can never stand in for a
  // numeric field; sending a string there would break the provider schema.
  // 固定别名本质上是文本，无法代替数值字段，否则会破坏提供商结构。
  const alias = await fixture(t, [
    { type: "literal", value: "123456", replacement: "SECRET-ID" },
  ]);
  assert.equal(
    await codeOf(alias.engine.redact({ account: 123456 })),
    "SCAN_NUMBER_UNSAFE",
  );
  // The same alias stays usable for the text form. / 同一别名在文本形式下仍可用。
  const text = await fixture(t, [
    { type: "literal", value: "123456", replacement: "SECRET-ID" },
  ]);
  assert.equal(await text.engine.redact("id 123456"), "id SECRET-ID");
});

test("one value maps to one replacement everywhere / 同一值在各处替换为同一值", async (t) => {
  const { engine } = await fixture(t, ["123456", "张三"]);
  const payload = {
    system: "code 123456 and again 123456",
    messages: [
      { role: "user", content: "123456 张三" },
      { role: "assistant", content: "repeat 123456" },
      { role: "tool", content: JSON.stringify({ pin: "123456", who: "张三" }) },
    ],
    numeric: 123456,
    nested: { deep: ["123456", "张三"] },
    "123456": "key position",
    tool: { arguments: JSON.stringify({ code: "123456" }) },
  };
  const masked = (await engine.redact(payload)) as typeof payload;
  const text = JSON.stringify(masked);
  assert.ok(!text.includes("123456"));
  assert.ok(!text.includes("张三"));
  // Every occurrence, including the key and the number, uses one value.
  // 包括键和数字在内的每一处都使用同一个值。
  const digits = [...text.matchAll(/\d{6}/g)].map((match) => match[0]);
  assert.equal(new Set(digits).size, 1, `multiple values: ${digits.join()}`);
  assert.equal(digits.length, 9);
  const names = [...text.matchAll(/[\u4e00-\u9fa5]{2}/g)].map((m) => m[0]);
  assert.equal(new Set(names).size, 1, `multiple values: ${names.join()}`);
  assert.equal(names.length, 3);
  // The number keeps its JSON type and shares the string replacement.
  // 数字保持 JSON 类型，并与字符串共用同一替换值。
  assert.equal(typeof masked.numeric, "number");
  assert.equal(String(masked.numeric), digits[0]);
  assert.deepEqual(
    JSON.parse(JSON.stringify(engine.restore(masked))),
    JSON.parse(JSON.stringify(payload)),
  );
});

test("redacted numbers are restored as numbers / 脱敏后的数字以数字还原", async (t) => {
  // Tool arguments are restored before execution, so a numeric argument must
  // return to its original value and type, not keep the replacement.
  // 工具参数在执行前还原，数值参数必须恢复原值和类型，不能保留替换值。
  const { engine } = await fixture(t, [
    { type: "regex", pattern: "(?<!\\d)\\d{6,}(?!\\d)" },
  ]);
  const payload = { id: 13800138000, limit: 9007199254740991, text: "483920" };
  const masked = (await engine.redact(payload)) as typeof payload;
  assert.equal(typeof masked.id, "number");
  assert.notEqual(masked.id, payload.id);
  const restored = engine.restore(masked) as typeof payload;
  assert.equal(typeof restored.id, "number");
  assert.equal(restored.id, 13800138000);
  assert.equal(restored.limit, 9007199254740991);
  assert.equal(restored.text, "483920");
  // An unknown number is left exactly as it is. / 未知数字原样保留。
  assert.equal(engine.restore({ other: 4242424242 }).other, 4242424242);
});

test("addresses stay parseable after replacement / 地址替换后仍可解析", async (t) => {
  // Digit-wise replacement would produce octets above 255 and non-hex groups.
  // 逐位替换会产生超过 255 的段和非十六进制分组。
  const { engine } = await fixture(t, [
    {
      type: "regex",
      pattern:
        "(?<![\\w.])(?:(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)\\.){3}(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)(?![\\w.])",
    },
    {
      type: "regex",
      pattern:
        "(?<![\\w:.])(?:[0-9A-Fa-f]{1,4}:){7}[0-9A-Fa-f]{1,4}(?![\\w:.])",
    },
    {
      type: "regex",
      pattern:
        "(?<![\\w:.])(?:[0-9A-Fa-f]{1,4}:){1,6}:(?:[0-9A-Fa-f]{1,4}(?::[0-9A-Fa-f]{1,4}){0,5})?(?![\\w:.])",
    },
  ]);
  const input = {
    a: "192.168.1.10",
    b: "10.0.255.254",
    c: "8.8.8.8",
    d: "2001:0db8:85a3:0000:0000:8a2e:0370:7334",
    e: "fe80::1ff:fe23:4567",
    keep: "version 1.2.3 and ratio 4.5.6.7.8",
  };
  const masked = (await engine.redact(input)) as typeof input;
  for (const key of ["a", "b", "c"] as const) {
    assert.ok(isIPv4(masked[key]), `${key}: ${masked[key]}`);
    assert.notEqual(masked[key], input[key]);
    assert.equal(masked[key].length, input[key].length);
  }
  for (const key of ["d", "e"] as const) {
    assert.ok(isIPv6(masked[key]), `${key}: ${masked[key]}`);
    assert.notEqual(masked[key], input[key]);
    assert.equal(masked[key].length, input[key].length);
  }
  // Compressed groups keep their position. / 压缩写法的位置保持不变。
  assert.ok(masked.e.includes("::"));
  // Version-like numbers are not addresses. / 类版本号数字不是地址。
  assert.equal(masked.keep, input.keep);
  assert.deepEqual(JSON.parse(JSON.stringify(engine.restore(masked))), input);
});

test("no shipped rule matches a very short string / 示例规则不匹配极短字符串", () => {
  // A short match has too few shape-preserving candidates, and on a large
  // payload such as a compaction request every candidate already occurs, so
  // the whole request fails with SCAN_UNIQUE_FAILED.
  // 极短匹配的同形候选值太少；在压缩请求这类大载荷下，每个候选值都已出现，
  // 整个请求会以 SCAN_UNIQUE_FAILED 失败。
  const example = JSON.parse(
    fs.readFileSync("protecter.example.json", "utf8"),
  ) as { sensitiveWords: Rule[] };
  const probe = [
    "Bearer x",
    "the Bearer token",
    "Bearer id",
    "call 1 or 7",
    "a.co",
    "::1",
    "1.2.3.4",
    "vpn.corp",
    "order 12 and 345",
  ].join("\n");
  for (const [index, rule] of example.sensitiveWords.entries()) {
    if (typeof rule === "string" || rule.type !== "regex") continue;
    const matcher = new RegExp(rule.pattern, `${rule.flags ?? ""}g`);
    const short = [...probe.matchAll(matcher)]
      .map((match) => match[0])
      .filter((value) => value.length <= 4);
    assert.deepEqual(
      short,
      [],
      `rule ${index + 1} matches short strings: ${short.map((v) => JSON.stringify(v)).join(", ")}`,
    );
  }
});

test("shipped example rules load and protect their targets / 示例配置可加载并生效", async (t) => {
  const example = JSON.parse(
    fs.readFileSync("protecter.example.json", "utf8"),
  ) as { sensitiveWords: Rule[] };
  const { engine } = await fixture(t, example.sensitiveWords);
  const input = {
    domain: "vpn.internal.corp",
    host: "db-01.prod.lan",
    email: "zhang.san+work@corp.example.com",
    v4: "172.16.42.7",
    v6: "2001:0db8:85a3:0000:0000:8a2e:0370:7334",
    fixed: "vpn.internal.example",
  };
  const masked = (await engine.redact(input)) as typeof input;
  for (const value of Object.values(input))
    assert.ok(!JSON.stringify(masked).includes(value), value);
  assert.equal(masked.fixed, "gateway.internal.example");
  assert.ok(isIPv4(masked.v4));
  assert.ok(isIPv6(masked.v6));
  assert.match(masked.email, /^[^@\s]+@[^@\s]+\.[A-Za-z]{2,}$/);
  assert.match(masked.domain, /^[a-z]{3}\.[a-z]{8}\.[a-z]{4}$/);
  assert.deepEqual(JSON.parse(JSON.stringify(engine.restore(masked))), input);
});

test("repeat requests reuse the same shaped value / 重复请求复用同一同形值", async (t) => {
  const { engine } = await fixture(t, ["13800138000", "张三"]);
  const first = (await engine.redact({
    phone: "13800138000",
    name: "张三",
  })) as Record<string, string>;
  const second = (await engine.redact({
    phone: "13800138000",
    name: "张三",
  })) as Record<string, string>;
  assert.deepEqual(second, first);
  // A restored response is masked back to the same value on the next request.
  // 还原后的响应在下一次请求中会被替换回同一值。
  assert.equal(await engine.redact("张三"), first.name);
});
