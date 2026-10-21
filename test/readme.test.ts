import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { isIPv4, isIPv6 } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Protecter } from "../src/engine.ts";
import { parseConfig, type Config } from "../src/config.ts";

/**
 * The README is what users copy from, so its examples are tested like the
 * shipped example file: a documented rule that does not load, or an address
 * rule that produces an invalid address, is a defect.
 * README 是用户直接复制的来源，因此其示例与随包示例文件一样纳入测试：
 * 文档中的规则加载不了，或地址规则产出非法地址，都属于缺陷。
 */
function readmeConfigs(): { block: number; config: Config }[] {
  const text = readFileSync(resolve("README.md"), "utf8");
  const found: { block: number; config: Config }[] = [];
  let block = 0;
  for (const match of text.matchAll(/```json\n([\s\S]*?)```/g)) {
    block++;
    let parsed: unknown;
    try {
      parsed = JSON.parse(match[1]);
    } catch {
      assert.fail(`README json block ${block} is not valid JSON`);
    }
    if (!parsed || typeof parsed !== "object") continue;
    if (!Object.hasOwn(parsed, "version")) continue;
    // Validate through the extension's own parser, not a looser check.
    // 使用本扩展自己的解析器校验，而不是更宽松的检查。
    found.push({ block, config: parseConfig(JSON.stringify(parsed)) });
  }
  return found;
}

test("every README configuration example loads / README 中每个配置示例都可加载", () => {
  const configs = readmeConfigs();
  // Both language halves document the same examples. / 两种语言各自记录同样的示例。
  assert.ok(configs.length >= 4, `found ${configs.length} example configs`);
});

test("the documented address rules produce valid addresses / 文档中的地址规则产出合法地址", async (t) => {
  // The largest documented example carries the rules a user starts from.
  // 文档中最完整的示例承载了用户的起步规则。
  const config = readmeConfigs()
    .map((entry) => entry.config)
    .reduce((widest, entry) =>
      entry.sensitiveWords.length > widest.sensitiveWords.length
        ? entry
        : widest,
    );
  assert.ok(config.sensitiveWords.length >= 7, "example lost its rules");

  const dir = mkdtempSync(join(tmpdir(), "spi-readme-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "protecter.json"), JSON.stringify(config));
  const engine = new Protecter(dir, 2000, () => "b".repeat(32));
  t.after(() => engine.close());
  await engine.initialize();

  const payload = {
    v4: "192.168.1.10",
    v6: "fe80:0000:0000:0000:0204:61ff:fe9d:f156",
    v6short: "fe80::1ff:fe23:4567",
    phone: "13800138000",
    name: "Alex Morgan",
    password: "your-private-password",
    company: "Apple Inc.",
  };
  const masked = (await engine.redact(payload, "readme")) as typeof payload;

  // Addresses must stay parseable, which is what the README promises.
  // 地址必须仍可解析，这正是 README 的承诺。
  assert.ok(isIPv4(masked.v4), `v4: ${masked.v4}`);
  assert.ok(isIPv6(masked.v6), `v6: ${masked.v6}`);
  assert.ok(isIPv6(masked.v6short), `v6short: ${masked.v6short}`);
  // The compressed form keeps its shape instead of being expanded.
  // 压缩形式保持其形态，不会被展开。
  assert.ok(masked.v6short.includes("::"), masked.v6short);
  assert.match(masked.phone, /^\d{11}$/);
  // The documented fixed alias is used verbatim. / 文档中的固定别名原样使用。
  assert.equal(masked.company, "Alphabet Inc.");

  for (const [key, original] of Object.entries(payload))
    assert.notEqual(
      masked[key as keyof typeof payload],
      original,
      `${key} must be redacted`,
    );
  // Restoration must round-trip every documented rule. Restored objects carry
  // a null prototype, so compare them as plain data.
  // 还原必须对每条文档规则精确往返。还原后的对象原型为 null，因此按纯数据比较。
  assert.deepEqual({ ...engine.restore(masked) }, payload);
});
