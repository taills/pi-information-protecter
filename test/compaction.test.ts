import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_COMPACTION_SETTINGS } from "@earendil-works/pi-coding-agent";
import { Protecter } from "../src/engine.ts";
import {
  buildProtectedBranchSummary,
  buildProtectedSummary,
  compactionBudget,
  resolveCompactionModel,
  type BranchSummarizer,
  type Summarizer,
} from "../src/compaction.ts";
import {
  compactionSettings,
  parseConfig,
  DEFAULT_COMPACTION,
  type CompactionSettings,
  type Rule,
} from "../src/config.ts";

const SECRETS = ["13800138000", "sk-live-abcdefgh", "张三"];

async function engineWith(
  t: { after(fn: () => void): void },
  rules: Rule[] = SECRETS,
  compaction?: string | Partial<CompactionSettings>,
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

test("summarization trouble degrades, it does not cancel / 摘要出问题时降级而不取消", async (t) => {
  // The extra model call needs its own routing and credentials and can return
  // nothing, so compaction must not depend on it succeeding.
  // 额外的模型调用需要单独的路由与凭证，且可能返回空内容，压缩不应依赖它成功。
  const engine = await engineWith(t);
  const event = fixtureEvent([
    { role: "user", content: [{ type: "text", text: "call 13800138000 now" }] },
    {
      role: "assistant",
      content: [
        { type: "text", text: "noted for 张三" },
        { type: "toolCall", name: "read" },
      ],
    },
  ]);
  const degradedOf = async (ctx: unknown, summarize: unknown) => {
    const result = await buildProtectedSummary(
      event,
      ctx as never,
      engine,
      "demo",
      summarize as Summarizer,
    );
    const detail = (result.details as { protecter?: { code?: string } })
      ?.protecter;
    return { code: detail?.code, summary: result.summary };
  };
  const ok = (async () => ({
    text: "fine",
    usage: undefined,
  })) as unknown as Summarizer;

  for (const [label, ctx, summarize, expected] of [
    ["no model", fixtureCtx({ model: undefined }), ok, "COMPACT_UNAVAILABLE"],
    [
      "no credentials",
      fixtureCtx({
        modelRegistry: {
          getApiKeyAndHeaders: async () => ({ ok: false, error: "no key" }),
        },
      }),
      ok,
      "COMPACT_UNAVAILABLE",
    ],
    [
      "call throws",
      fixtureCtx(),
      async () => {
        throw new Error("provider exploded with 13800138000 inside");
      },
      "COMPACT_FAILED",
    ],
    [
      "empty answer",
      fixtureCtx(),
      async () => ({ text: "   ", usage: undefined }),
      "COMPACT_EMPTY",
    ],
  ] as const) {
    const { code, summary } = await degradedOf(ctx, summarize);
    assert.equal(code, expected, label);
    // A local summary is still produced, and it restores to the original.
    // 仍会产出本地摘要，且还原为原文。
    assert.match(summary, /Local compaction summary/, label);
    assert.ok(summary.includes("13800138000"), label);
    assert.ok(summary.includes("read"), label);
  }
});

test("redaction failure still cancels / 脱敏失败仍然取消", async (t) => {
  // Degrading is only safe because the local summary is built from redacted
  // text. If redaction itself fails there is nothing safe to summarize.
  // 降级之所以安全，是因为本地摘要基于已脱敏文本。若脱敏本身失败，就没有可安全摘要的内容。
  const engine = await engineWith(t);
  const broken = {
    redact: async () => {
      throw new Error("scan failed");
    },
    restoreText: (value: string) => value,
  };
  await assert.rejects(
    buildProtectedSummary(
      fixtureEvent([{ role: "user", content: [{ type: "text", text: "x" }] }]),
      fixtureCtx(),
      broken,
      "demo",
      (async () => ({ text: "fine", usage: undefined })) as unknown as Summarizer,
    ),
  );
  // The healthy engine is what the other tests rely on. / 其他用例依赖正常引擎。
  assert.equal(engine.compactionMode, "ask");
});

test("a failure reports its kind without content / 失败上报类型而不带内容", async (t) => {
  // One opaque code cannot separate authentication, transport and argument
  // errors, which is what made three releases guess at the same failure.
  // 单一不透明错误码无法区分认证、传输与参数错误，这正是三个版本反复猜测的原因。
  const engine = await engineWith(t);
  const event = fixtureEvent([{ role: "user", content: "13800138000" }]);
  // The kind is carried on the degraded result, since compaction continues.
  // 类型随降级结果一同返回，因为压缩会继续。
  const reported = async (make: () => Error): Promise<string> => {
    const result = await buildProtectedSummary(
      event,
      fixtureCtx(),
      engine,
      "demo",
      (async () => {
        throw make();
      }) as unknown as Summarizer,
    );
    return JSON.stringify(
      (result.details as { protecter?: unknown })?.protecter ?? {},
    );
  };

  const message = await reported(() =>
    Object.assign(new Error("unauthorized for 13800138000"), {
      name: "AuthenticationError",
      status: 401,
    }),
  );
  assert.match(message, /"code":"COMPACT_FAILED"/);
  assert.match(message, /"errorName":"AuthenticationError"/);
  assert.match(message, /"status":401/);
  // The provider message must never appear. / 提供商消息绝不出现。
  assert.ok(!message.includes("13800138000"));
  assert.ok(!message.includes("unauthorized"));

  // A name that is not a plain identifier is dropped, not echoed.
  // 非普通标识符的名称会被丢弃，不会回显。
  const weird = await reported(() =>
    Object.assign(new Error("x"), { name: "13800138000 leaked" }),
  );
  assert.ok(!weird.includes("13800138000"));
  assert.ok(!weird.includes("errorName"));
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

test("branch summaries are redacted too / 分支摘要同样脱敏", async (t) => {
  const engine = await engineWith(t);
  const entries = [
    { type: "message", id: "a", message: { role: "user", content: "张三 13800138000" } },
    { type: "message", id: "b", message: { role: "assistant", content: "key sk-live-abcdefgh" } },
  ];
  let seen: unknown;
  let seenOptions: Record<string, unknown> | undefined;
  const summarize = (async (input: unknown, options: Record<string, unknown>) => {
    seen = input;
    seenOptions = options;
    return { summary: "branch summary", usage: { totalTokens: 3 } };
  }) as unknown as BranchSummarizer;

  const result = await buildProtectedBranchSummary(
    {
      type: "session_before_tree",
      preparation: {
        targetId: "t",
        oldLeafId: null,
        commonAncestorId: null,
        entriesToSummarize: entries,
        userWantsSummary: true,
        customInstructions: "keep 张三 details",
        replaceInstructions: true,
      },
      signal: new AbortController().signal,
    } as never,
    fixtureCtx(),
    engine,
    "demo",
    summarize,
  );

  const sent = JSON.stringify(seen);
  for (const secret of SECRETS)
    assert.ok(!sent.includes(secret), `leaked: ${secret}`);
  // Entry structure must survive so the summarizer still understands it.
  // 条目结构必须保留，摘要函数才能理解。
  assert.equal(JSON.parse(sent).length, 2);
  assert.equal(JSON.parse(sent)[0].type, "message");
  assert.ok(!String(seenOptions?.customInstructions).includes("张三"));
  assert.equal(seenOptions?.replaceInstructions, true);
  assert.equal(result.summary, "branch summary");
  assert.deepEqual(result.usage, { totalTokens: 3 });
});

test("branch summaries fail closed / 分支摘要失败时拒绝放行", async (t) => {
  const engine = await engineWith(t);
  const event = {
    type: "session_before_tree",
    preparation: {
      targetId: "t",
      oldLeafId: null,
      commonAncestorId: null,
      entriesToSummarize: [{ type: "message", message: { content: "13800138000" } }],
      userWantsSummary: true,
    },
    signal: new AbortController().signal,
  } as never;
  assert.equal(
    await codeOf(
      buildProtectedBranchSummary(
        event,
        fixtureCtx({ model: undefined }),
        engine,
        "demo",
        (async () => ({ summary: "x" })) as unknown as BranchSummarizer,
      ),
    ),
    "COMPACT_UNAVAILABLE",
  );
  assert.equal(
    await codeOf(
      buildProtectedBranchSummary(
        event,
        fixtureCtx(),
        engine,
        "demo",
        (async () => {
          throw new Error("boom 13800138000");
        }) as unknown as BranchSummarizer,
      ),
    ),
    "COMPACT_FAILED",
  );
  assert.equal(
    await codeOf(
      buildProtectedBranchSummary(
        event,
        fixtureCtx(),
        engine,
        "demo",
        (async () => ({ summary: "  " })) as unknown as BranchSummarizer,
      ),
    ),
    "COMPACT_FAILED",
  );
});

test("summarization routes through the model registry / 摘要经由模型注册表发起", async (t) => {
  // Without a stream function the summarizer issues a bare provider call using
  // only the passed key, which bypasses OAuth refresh and provider base URLs.
  // 不传流函数时会发起裸请求，绕过 OAuth 刷新与 provider 地址解析。
  const engine = await engineWith(t);
  const event = fixtureEvent([{ role: "user", content: "13800138000" }]);

  // Pi 0.86+: streamSimple is preferred. / Pi 0.86+ 优先使用 streamSimple。
  let usedStreamSimple = false;
  let streamFnSeen: unknown;
  await buildProtectedSummary(
    event,
    fixtureCtx({
      modelRegistry: {
        getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "k" }),
        streamSimple: () => {
          usedStreamSimple = true;
          return { result: async () => ({ text: "s" }) };
        },
        complete: async () => ({ text: "never" }),
      },
    }),
    engine,
    "demo",
    (async (...args: unknown[]) => {
      streamFnSeen = args[9];
      return { text: "ok", usage: undefined };
    }) as unknown as Summarizer,
  );
  assert.equal(typeof streamFnSeen, "function", "a stream function must be passed");
  await (streamFnSeen as (...a: unknown[]) => { result(): Promise<unknown> })(
    {},
    {},
    {},
  ).result();
  assert.equal(usedStreamSimple, true, "streamSimple must be preferred");

  // Pi 0.84/0.85: complete is adapted instead. / Pi 0.84/0.85 改用 complete 适配。
  let usedComplete = false;
  let legacySeen: unknown;
  await buildProtectedSummary(
    event,
    fixtureCtx({
      modelRegistry: {
        getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "k" }),
        complete: async () => {
          usedComplete = true;
          return { text: "s" };
        },
      },
    }),
    engine,
    "demo",
    (async (...args: unknown[]) => {
      legacySeen = args[9];
      return { text: "ok", usage: undefined };
    }) as unknown as Summarizer,
  );
  assert.equal(typeof legacySeen, "function");
  await (legacySeen as (...a: unknown[]) => { result(): Promise<unknown> })(
    {},
    {},
    {},
  ).result();
  assert.equal(usedComplete, true, "complete must be used when streamSimple is absent");
});

test("a dedicated summarization model is resolved and drives the threshold / 专用摘要模型可解析并决定阈值", async (t) => {
  const engine = await engineWith(t, ["secret"], {
    mode: "protected",
    provider: "A6000-vLLM",
    model: "Qwen38-27B-FP8",
  });
  const settings = engine.compaction;
  assert.equal(settings.mode, "protected");
  assert.equal(settings.provider, "A6000-vLLM");

  const local = { provider: "A6000-vLLM", id: "Qwen38-27B-FP8", contextWindow: 262144 };
  const ctx = fixtureCtx({
    model: { provider: "ma-cpa", id: "gpt-6-astra", contextWindow: 1_000_000 },
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "k" }),
      find: (provider: string, id: string) =>
        provider === local.provider && id === local.id ? local : undefined,
    },
  });

  // The configured model is used, not the conversation's model.
  // 使用配置的模型，而非当前对话模型。
  assert.equal(resolveCompactionModel(ctx, settings)?.id, "Qwen38-27B-FP8");

  // The threshold follows the summarization model's window, not the main one.
  // 阈值跟随摘要模型的窗口，而非主模型。
  const budget = compactionBudget(ctx, settings);
  assert.equal(budget?.window, 262144);
  assert.equal(budget?.threshold, 262144 - 16384);
  assert.ok(budget!.threshold < 1_000_000, "must compact before the main window");

  // An explicit window overrides the catalogue, for models Pi does not know.
  // 显式窗口覆盖目录值，适用于 Pi 未收录的模型。
  const override = compactionBudget(ctx, {
    ...settings,
    contextWindow: 32768,
    reserveTokens: 2048,
  });
  assert.equal(override?.threshold, 32768 - 2048);

  // Neither field has to be configured twice: the window comes from the model
  // catalogue and the reserve from Pi's own effective compaction settings.
  // 两个字段都不需要重复配置：窗口来自模型目录，预留值来自 Pi 自身的生效压缩设置。
  assert.equal(budget?.reserve, DEFAULT_COMPACTION_SETTINGS.reserveTokens);
  const inherited = compactionBudget(ctx, settings, 40000);
  assert.equal(inherited?.reserve, 40000, "Pi's reserve is inherited");
  assert.equal(inherited?.threshold, 262144 - 40000);
  // A local value still wins, for a model needing a different margin.
  // 本地值仍优先，适用于需要不同余量的模型。
  assert.equal(
    compactionBudget(ctx, { ...settings, reserveTokens: 1024 }, 40000)?.reserve,
    1024,
  );

  // Summarization must use the configured model end to end.
  // 摘要全程必须使用配置的模型。
  let seenModel: { id?: string } | undefined;
  await buildProtectedSummary(
    fixtureEvent([
      { role: "user", content: [{ type: "text", text: "secret here" }] },
    ]),
    ctx,
    engine,
    "demo",
    (async (_messages: unknown, model: { id?: string }) => {
      seenModel = model;
      return { text: "done", usage: undefined };
    }) as unknown as Summarizer,
    settings,
  );
  assert.equal(seenModel?.id, "Qwen38-27B-FP8");
});

test("the configured model reaches the transport / 配置的模型确实到达传输层", async (t) => {
  // Passing a model into a stubbed summarizer only proves an argument was
  // forwarded. Run Pi's real summarization and observe the transport, which is
  // what actually decides where the conversation goes.
  // 将模型传给桩函数只能证明参数被转发。此处运行 Pi 的真实摘要代码并观察传输层，
  // 因为那里才真正决定对话发往何处。
  const engine = await engineWith(t, SECRETS, {
    mode: "protected",
    provider: "A6000-vLLM",
    model: "Qwen38-27B-FP8",
  });
  const configured = {
    id: "Qwen38-27B-FP8",
    provider: "A6000-vLLM",
    baseUrl: "http://10.0.0.9:8000/v1",
    api: "openai-completions",
    contextWindow: 262144,
    maxTokens: 8192,
    cost: { input: 0, output: 0 },
    input: ["text"],
    reasoning: false,
  };
  const conversationModel = {
    id: "gpt-6-astra",
    provider: "ma-cpa",
    baseUrl: "https://gateway.example/v1",
    contextWindow: 1_000_000,
  };
  const seen: { id?: string; provider?: string; sent?: string }[] = [];
  const ctx = fixtureCtx({
    model: conversationModel,
    modelRegistry: {
      find: (provider: string, id: string) =>
        provider === configured.provider && id === configured.id
          ? configured
          : undefined,
      getApiKeyAndHeaders: async () => ({
        ok: true as const,
        apiKey: "local-key",
      }),
      streamSimple: (model: typeof configured, context: unknown) => {
        seen.push({
          id: model?.id,
          provider: model?.provider,
          sent: JSON.stringify(context),
        });
        return {
          result: async () => ({
            role: "assistant",
            content: [{ type: "text", text: "summary of 13800138000" }],
            usage: { input: 1, output: 1, totalTokens: 2 },
          }),
        };
      },
    },
  });

  const result = await buildProtectedSummary(
    fixtureEvent([
      {
        role: "user",
        content: [{ type: "text", text: "call 13800138000 about \u5f20\u4e09" }],
      },
    ]),
    ctx,
    engine,
    "demo",
    undefined,
    engine.compaction,
  );

  assert.equal(seen.length, 1, "exactly one summarization request");
  assert.equal(seen[0].id, "Qwen38-27B-FP8", "configured model, not ctx.model");
  assert.equal(seen[0].provider, "A6000-vLLM");
  // The conversation model must not receive the summarization request.
  // 对话模型不得收到摘要请求。
  assert.ok(!seen.some((entry) => entry.id === "gpt-6-astra"));
  // What reached the transport must already be redacted.
  // 到达传输层的内容必须已经脱敏。
  for (const secret of SECRETS)
    assert.ok(!seen[0].sent?.includes(secret), `leaked: ${secret}`);
  // The summary is restored locally, so it reads with the original values.
  // 摘要在本地还原，因此呈现原始值。
  assert.ok(result.summary.includes("13800138000"));
  assert.equal(
    (result.details as { protecter?: unknown })?.protecter,
    undefined,
    "a working model must not degrade",
  );
});

test("an unresolvable compaction model is an error / 无法解析的压缩模型属于错误", async (t) => {
  // Falling back to the main model would send the conversation to a
  // destination the user did not choose.
  // 回退到主模型会把对话发往用户未选择的目的地。
  const engine = await engineWith(t, ["secret"], {
    mode: "protected",
    provider: "missing",
    model: "nope",
  });
  const ctx = fixtureCtx({
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "k" }),
      find: () => undefined,
    },
  });
  assert.throws(
    () => resolveCompactionModel(ctx, engine.compaction),
    /CONFIG_COMPACT_MODEL/,
  );
  assert.equal(compactionBudget(ctx, engine.compaction), undefined);
});

test("compaction settings are validated / 压缩设置经过校验", () => {
  const parse = (compaction: unknown) =>
    parseConfig(
      JSON.stringify({ version: 1, sensitiveWords: [], compaction }),
    );
  // The object form is accepted alongside the shipped string form.
  // 对象写法与已发布的字符串写法共存。
  for (const mode of ["ask", "protected", "off"] as const) {
    assert.equal(compactionSettings(parse(mode).compaction).mode, mode);
    assert.equal(
      compactionSettings(parse({ mode }).compaction).mode,
      mode,
      "object form",
    );
  }
  const full = compactionSettings(
    parse({
      mode: "protected",
      provider: "A6000-vLLM",
      model: "Qwen38-27B-FP8",
      contextWindow: 262144,
      reserveTokens: 8192,
    }).compaction,
  );
  assert.equal(full.provider, "A6000-vLLM");
  assert.equal(full.contextWindow, 262144);
  assert.equal(full.reserveTokens, 8192);

  // Unknown values must be rejected, not silently ignored. / 未知取值必须拒绝，而非静默忽略。
  for (const bad of ["always", "on", "", true, 1, null, [], { mode: "nope" }])
    assert.throws(
      () => parse(bad),
      /CONFIG_COMPACTION|CONFIG_SCHEMA/,
      `should reject ${JSON.stringify(bad)}`,
    );
  // Half a model reference cannot resolve to anything. / 只写一半的模型引用无法解析。
  for (const half of [{ provider: "p" }, { model: "m" }])
    assert.throws(() => parse(half), /CONFIG_COMPACT_MODEL/);
  // Unknown keys and impossible budgets are rejected. / 未知字段与不可能的预算被拒绝。
  assert.throws(() => parse({ mode: "ask", nope: 1 }), /CONFIG_COMPACTION/);
  assert.throws(
    () => parse({ contextWindow: 1000, reserveTokens: 1000 }),
    /CONFIG_COMPACTION/,
  );
});

test("the default stays ask / 默认仍为 ask", async (t) => {
  const engine = await engineWith(t, ["secret"]);
  assert.equal(engine.compactionMode, DEFAULT_COMPACTION);
  assert.equal(DEFAULT_COMPACTION, "ask");
  assert.equal(engine.compaction.provider, undefined);
});
