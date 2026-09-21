import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Protecter } from "../src/engine.ts";
import { buildProtectedSummary, type Summarizer } from "../src/compaction.ts";
import { parseConfig, DEFAULT_COMPACTION } from "../src/config.ts";
import { type Rule } from "../src/config.ts";

const SECRETS = ["13800138000", "sk-live-abcdefgh", "张三"];

async function engineWith(
  t: { after(fn: () => void): void },
  rules: Rule[] = SECRETS,
  compaction?: string,
) {
  const dir = fs.mkdtempSync(join(tmpdir(), "spi-compact-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(
    join(dir, "protecter.json"),
    JSON.stringify({
      version: 1,
      sensitiveWords: rules,
      ...(compaction === undefined ? {} : { compaction }),
    }),
  );
  const engine = new Protecter(dir, 2000, () => "a".repeat(32));
  t.after(() => engine.close());
  await engine.initialize();
  return engine;
}

/** Minimal event/context doubles; only the fields the summary path reads. / 仅包含摘要路径会读取的字段。 */
function fixtureEvent(messages: unknown[], extras: Record<string, unknown> = {}) {
  return {
    type: "session_before_compact",
    preparation: {
      messagesToSummarize: messages,
      firstKeptEntryId: "entry-7",
      tokensBefore: 4242,
      settings: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
      ...extras,
    },
    branchEntries: [],
    reason: "threshold",
    willRetry: false,
    signal: new AbortController().signal,
  } as never;
}

function fixtureCtx(overrides: Record<string, unknown> = {}) {
  return {
    model: { provider: "demo", id: "demo-model" },
    thinkingLevel: undefined,
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({
        ok: true as const,
        apiKey: "key",
        headers: { "x-a": "1", "x-drop": null },
      }),
    },
    ...overrides,
  } as never;
}

function codeOf(action: Promise<unknown>): Promise<string> {
  return action.then(
    () => "NO_ERROR",
    (error) =>
      (error as Error).message.match(/code=([A-Z_]+)/)?.[1] ?? "UNPARSED",
  );
}

test("only redacted text reaches the model / 只有脱敏后的文本会到达模型", async (t) => {
  const engine = await engineWith(t);
  const messages = [
    { role: "user", content: "phone 13800138000 key sk-live-abcdefgh" },
    { role: "assistant", content: "张三 confirmed" },
  ];
  let seen: unknown;
  let seenKey: string | undefined;
  let seenHeaders: unknown;
  const summarize = (async (
    input: unknown,
    _model: unknown,
    _reserve: unknown,
    apiKey: string | undefined,
    headers: unknown,
  ) => {
    seen = input;
    seenKey = apiKey;
    seenHeaders = headers;
    // Echo a replacement back so restoration can be observed. / 回显替换值以便观察还原。
    const text = JSON.stringify(input);
    const digits = text.match(/\d{11}/)?.[0] ?? "";
    return { text: `summary mentioning ${digits}`, usage: { totalTokens: 9 } };
  }) as unknown as Summarizer;

  const result = await buildProtectedSummary(
    fixtureEvent(messages),
    fixtureCtx(),
    engine,
    "demo",
    summarize,
  );

  // The security property: no protected value may appear in the model input.
  // 安全属性：模型输入中不得出现任何受保护值。
  const sent = JSON.stringify(seen);
  for (const secret of SECRETS)
    assert.ok(!sent.includes(secret), `leaked: ${secret}`);
  assert.ok(sent.includes("phone "), "non-sensitive text must survive");

  // The summary is restored locally before it is stored. / 摘要在保存前已在本地还原。
  assert.ok(result.summary.includes("13800138000"));
  assert.equal(result.firstKeptEntryId, "entry-7");
  assert.equal(result.tokensBefore, 4242);
  assert.deepEqual(result.usage, { totalTokens: 9 });
  assert.equal(seenKey, "key");
  // Null header values are dropped, not passed through. / 值为 null 的头会被丢弃。
  assert.deepEqual(seenHeaders, { "x-a": "1" });
});

test("previous summary and instructions are redacted too / 历史摘要与自定义指令同样脱敏", async (t) => {
  const engine = await engineWith(t);
  let seenPrevious: unknown;
  let seenInstructions: unknown;
  const summarize = (async (
    _input: unknown,
    _model: unknown,
    _reserve: unknown,
    _apiKey: unknown,
    _headers: unknown,
    _signal: unknown,
    instructions: unknown,
    previous: unknown,
  ) => {
    seenInstructions = instructions;
    seenPrevious = previous;
    return { text: "ok", usage: undefined };
  }) as unknown as Summarizer;

  await buildProtectedSummary(
    {
      ...(fixtureEvent([{ role: "user", content: "hi" }], {
        previousSummary: "earlier we saw 13800138000",
      }) as unknown as Record<string, unknown>),
      customInstructions: "focus on 张三",
    } as never,
    fixtureCtx(),
    engine,
    "demo",
    summarize,
  );
  assert.ok(!String(seenPrevious).includes("13800138000"));
  assert.ok(!String(seenInstructions).includes("张三"));
});

test("compaction fails closed / 压缩失败时拒绝放行", async (t) => {
  const engine = await engineWith(t);
  const event = fixtureEvent([{ role: "user", content: "13800138000" }]);
  const ok = (async () => ({ text: "fine", usage: undefined })) as unknown as Summarizer;

  // No model to summarize with. / 没有可用模型。
  assert.equal(
    await codeOf(
      buildProtectedSummary(event, fixtureCtx({ model: undefined }), engine, "demo", ok),
    ),
    "COMPACT_UNAVAILABLE",
  );
  // Authentication unavailable. / 无法获取认证。
  assert.equal(
    await codeOf(
      buildProtectedSummary(
        event,
        fixtureCtx({
          modelRegistry: {
            getApiKeyAndHeaders: async () => ({ ok: false, error: "no key" }),
          },
        }),
        engine,
        "demo",
        ok,
      ),
    ),
    "COMPACT_UNAVAILABLE",
  );
  // The summarization call itself fails. / 摘要调用失败。
  assert.equal(
    await codeOf(
      buildProtectedSummary(
        event,
        fixtureCtx(),
        engine,
        "demo",
        (async () => {
          throw new Error("provider exploded with 13800138000 inside");
        }) as unknown as Summarizer,
      ),
    ),
    "COMPACT_FAILED",
  );
  // An empty summary is not a usable compaction. / 空摘要不可用。
  assert.equal(
    await codeOf(
      buildProtectedSummary(
        event,
        fixtureCtx(),
        engine,
        "demo",
        (async () => ({ text: "   ", usage: undefined })) as unknown as Summarizer,
      ),
    ),
    "COMPACT_FAILED",
  );
});

test("a provider error never leaks the original / 提供商错误不泄漏原文", async (t) => {
  const engine = await engineWith(t);
  const error = await buildProtectedSummary(
    fixtureEvent([{ role: "user", content: "13800138000" }]),
    fixtureCtx(),
    engine,
    "demo",
    (async () => {
      throw new Error("failed for 13800138000 / sk-live-abcdefgh");
    }) as unknown as Summarizer,
  ).catch((e: Error) => e);
  const text = String((error as Error).message);
  for (const secret of SECRETS) assert.ok(!text.includes(secret), secret);
});

test("compaction mode is configurable and validated / 压缩模式可配置且经校验", async (t) => {
  for (const mode of ["ask", "protected", "off"]) {
    const parsed = parseConfig(
      JSON.stringify({ version: 1, sensitiveWords: [], compaction: mode }),
    );
    assert.equal(parsed.compaction, mode);
    const engine = await engineWith(t, ["secret"], mode);
    assert.equal(engine.compactionMode, mode);
  }
  // Unknown values must be rejected, not silently ignored. / 未知取值必须拒绝，而非静默忽略。
  for (const bad of ["always", "on", "", true, 1, null]) {
    assert.throws(
      () =>
        parseConfig(
          JSON.stringify({
            version: 1,
            sensitiveWords: [],
            compaction: bad,
          }),
        ),
      /CONFIG_COMPACTION|CONFIG_SCHEMA/,
      `should reject ${JSON.stringify(bad)}`,
    );
  }
  // Omitting the field keeps the documented default. / 省略该字段时保持文档所述默认值。
  const engine = await engineWith(t, ["secret"]);
  assert.equal(engine.compactionMode, DEFAULT_COMPACTION);
  assert.equal(DEFAULT_COMPACTION, "ask");
});
