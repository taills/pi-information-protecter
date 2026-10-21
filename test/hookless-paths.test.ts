import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  discoverAndLoadExtensions,
  ExtensionRunner,
  SessionManager,
  type ModelRegistry,
  type ExtensionContextActions,
} from "@earendil-works/pi-coding-agent";

/**
 * Pi's own summarizers have no payload hook, so this extension redacts the
 * `preparation` Pi is about to summarize, in place, and lets Pi summarize with
 * the session's own model. These tests drive the real loader and runner, so
 * they fail if the hook stops mutating what Pi actually reads.
 * Pi 自身的摘要器没有请求钩子，因此本扩展对 Pi 即将摘要的 `preparation` 原地脱敏，
 * 再由 Pi 用会话自身的模型生成摘要。这些测试驱动真实加载器与执行器，
 * 一旦钩子不再改动 Pi 真正读取的对象即会失败。
 */
async function host(t: { after(fn: () => void): void }, compaction = "protected") {
  const dir = mkdtempSync(join(tmpdir(), "spi-hookless-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  const previousLang = process.env.PI_PROTECTER_LANG;
  process.env.PI_CODING_AGENT_DIR = dir;
  process.env.PI_PROTECTER_LANG = "en";
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    if (previousLang === undefined) delete process.env.PI_PROTECTER_LANG;
    else process.env.PI_PROTECTER_LANG = previousLang;
    rmSync(dir, { recursive: true, force: true });
  });
  writeFileSync(
    join(dir, "protecter.json"),
    JSON.stringify({
      version: 1,
      sensitiveWords: ["fake-private-password"],
      compaction,
    }),
  );
  const loaded = await discoverAndLoadExtensions(
    [resolve("src/index.ts")],
    dir,
    dir,
  );
  assert.deepEqual(loaded.errors, []);
  const notices: string[] = [];
  const runner = new ExtensionRunner(
    loaded.extensions,
    loaded.runtime,
    dir,
    SessionManager.inMemory(dir),
    {
      runtime: {
        stream: () => ({ result: async () => ({}) }),
        streamSimple: () => ({ result: async () => ({}) }),
        classify: async () => ({}),
        generateImages: async () => ({}),
      },
    } as unknown as ModelRegistry,
  );
  runner.bindCore(
    {
      sendMessage() {},
      sendUserMessage() {},
      appendEntry() {},
      setSessionName() {},
      getSessionName: () => undefined,
      setLabel() {},
      getActiveTools: () => [],
      getAllTools: () => [],
      getSettings: () => ({}) as never,
      setActiveTools() {},
      refreshTools() {},
      getCommands: () => [],
      setModel: async () => true,
      getThinkingLevel: () => "off",
      setThinkingLevel() {},
    },
    {
      getModel: () => ({ provider: "fixture-provider" }) as never,
      getScopedModels: () => [],
      isIdle: () => true,
      isProjectTrusted: () => true,
      getSignal: () => undefined,
      abort: () => {},
      hasPendingMessages: () => false,
      shutdown() {},
      getContextUsage: () => undefined,
      compact() {},
      getSystemPrompt: () => "",
    } satisfies ExtensionContextActions,
  );
  await runner.emit({ type: "session_start", reason: "startup" });
  t.after(async () => {
    await runner.emit({ type: "session_shutdown", reason: "quit" });
  });
  const configPath = join(
    dir,
    readdirSync(dir).find((name) =>
      /^protecter\.[a-f0-9]{32}\.json$/.test(name),
    )!,
  );
  return { dir, runner, notices, configPath };
}

const userMessage = (text: string) => ({
  role: "user" as const,
  content: [{ type: "text" as const, text }],
  timestamp: 1,
});

function preparationFixture() {
  return {
    firstKeptEntryId: "keep",
    messagesToSummarize: [userMessage("fake-private-password")],
    turnPrefixMessages: [userMessage("prefix fake-private-password")],
    isSplitTurn: false,
    tokensBefore: 10,
    previousSummary: "before: fake-private-password",
    fileOps: { read: [], modified: [] },
    settings: { reserveTokens: 16384 },
  };
}

test("Pi summarizes a redacted preparation / Pi 摘要的是已脱敏的 preparation", async (t) => {
  const { runner } = await host(t);
  const preparation = preparationFixture();
  const messages = preparation.messagesToSummarize;
  const result = await runner.emit({
    type: "session_before_compact",
    preparation,
    branchEntries: [],
    customInstructions: undefined,
    reason: "manual",
    willRetry: false,
    signal: new AbortController().signal,
  } as never);

  // No compaction is returned: Pi summarizes, with its own model and retries.
  // 不返回摘要：由 Pi 用自己的模型与重试策略生成。
  assert.equal(result, undefined);
  // Pi destructures this object and the tree path keeps array references, so
  // identity must survive the redaction.
  // Pi 解构该对象，tree 路径还持有数组引用，因此脱敏后必须保持同一对象。
  assert.equal(preparation.messagesToSummarize, messages);
  const summarized = JSON.stringify(preparation);
  assert.ok(!summarized.includes("fake-private-password"));
  assert.ok(summarized.includes("before: "));
  assert.equal(preparation.messagesToSummarize.length, 1);
  assert.equal(preparation.turnPrefixMessages.length, 1);
});

test("an instruction with a protected value cancels / 指令含受保护值则取消", async (t) => {
  const { runner } = await host(t);
  const preparation = preparationFixture();
  const result = (await runner.emit({
    type: "session_before_compact",
    preparation,
    branchEntries: [],
    // Pi reads this from its own state, so a redacted copy would be ignored.
    // Pi 从自身状态读取该字段，脱敏副本不会被采用。
    customInstructions: "focus on fake-private-password",
    reason: "manual",
    willRetry: false,
    signal: new AbortController().signal,
  } as never)) as { cancel?: boolean } | undefined;
  assert.equal(result?.cancel, true);
});

test("compaction off cancels instead of redacting / 关闭压缩时取消而非脱敏", async (t) => {
  const { runner } = await host(t, "off");
  const preparation = preparationFixture();
  const result = (await runner.emit({
    type: "session_before_compact",
    preparation,
    branchEntries: [],
    customInstructions: undefined,
    reason: "threshold",
    willRetry: false,
    signal: new AbortController().signal,
  } as never)) as { cancel?: boolean } | undefined;
  assert.equal(result?.cancel, true);
  assert.ok(
    JSON.stringify(preparation).includes("fake-private-password"),
    "a refused compaction must not send anything, redacted or not",
  );
});

test("branch summaries are redacted with their instructions / 分支摘要与其指令一并脱敏", async (t) => {
  const { runner } = await host(t);
  const preparation = {
    targetId: "target",
    oldLeafId: "leaf",
    commonAncestorId: null,
    entriesToSummarize: [userMessage("fake-private-password")],
    userWantsSummary: true,
    customInstructions: "keep fake-private-password details",
  };
  const entries = preparation.entriesToSummarize;
  const result = (await runner.emit({
    type: "session_before_tree",
    preparation,
    signal: new AbortController().signal,
  } as never)) as { customInstructions?: string } | undefined;

  assert.equal(preparation.entriesToSummarize, entries);
  assert.ok(!JSON.stringify(entries).includes("fake-private-password"));
  // This event reads its instructions back, so they are redacted, not refused.
  // 该事件会读回指令，因此脱敏而非拒绝。
  assert.ok(result?.customInstructions);
  assert.ok(
    !result.customInstructions.includes("fake-private-password"),
    "returned instructions must be redacted",
  );
  assert.ok(result.customInstructions.startsWith("keep "));
});

test("navigation without a summary sends nothing / 不生成摘要的导航不发送内容", async (t) => {
  const { runner } = await host(t);
  const preparation = {
    targetId: "target",
    oldLeafId: "leaf",
    commonAncestorId: null,
    entriesToSummarize: [userMessage("fake-private-password")],
    userWantsSummary: false,
  };
  assert.equal(
    await runner.emit({
      type: "session_before_tree",
      preparation,
      signal: new AbortController().signal,
    } as never),
    undefined,
  );
  // Nothing is summarized, so nothing is scanned either.
  // 不生成摘要，因此也不做扫描。
  assert.ok(
    JSON.stringify(preparation).includes("fake-private-password"),
  );
});

test("a broken configuration cancels compaction / 配置损坏时取消压缩", async (t) => {
  const { runner, configPath } = await host(t);
  writeFileSync(configPath, "not-json");
  await runner.emit({ type: "session_start", reason: "reload" });
  const preparation = preparationFixture();
  const result = (await runner.emit({
    type: "session_before_compact",
    preparation,
    branchEntries: [],
    customInstructions: undefined,
    reason: "overflow",
    willRetry: true,
    signal: new AbortController().signal,
  } as never)) as { cancel?: boolean } | undefined;
  assert.equal(result?.cancel, true);
});
