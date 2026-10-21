import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  SessionBeforeCompactEvent,
  SessionBeforeTreeEvent,
} from "@earendil-works/pi-coding-agent";
import { Protecter } from "../src/engine.ts";
import { redactCompaction, redactTree } from "../src/compaction.ts";
import {
  compactionSettings,
  ignoredCompactionKeys,
  parseConfig,
  DEFAULT_COMPACTION,
  type Rule,
} from "../src/config.ts";
import { ProtectionError } from "../src/diagnostics.ts";

const SECRETS = ["13800138000", "sk-live-abcdefgh", "张三"];

async function engineWith(
  t: { after(fn: () => void): void },
  rules: Rule[] = SECRETS,
  compaction?: string | Record<string, unknown>,
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

/**
 * Pi hands the hook the same preparation object it then summarizes, so the
 * fixture mirrors that: the arrays handed out here are the ones asserted on.
 * Pi 交给钩子的 preparation 就是它随后用于摘要的同一对象，因此夹具照此构造：
 * 此处交出的数组正是后续断言的对象。
 */
function compactEvent(options: {
  messages?: unknown[];
  prefix?: unknown[];
  previousSummary?: string;
  customInstructions?: string;
}) {
  const preparation = {
    firstKeptEntryId: "keep",
    messagesToSummarize: options.messages ?? [],
    turnPrefixMessages: options.prefix ?? [],
    isSplitTurn: false,
    tokensBefore: 100,
    previousSummary: options.previousSummary,
    fileOps: { read: [], modified: [] },
    settings: { reserveTokens: 16384 },
  };
  return {
    type: "session_before_compact",
    preparation,
    branchEntries: [],
    customInstructions: options.customInstructions,
    reason: "manual",
    willRetry: false,
    signal: new AbortController().signal,
  } as unknown as SessionBeforeCompactEvent;
}

function treeEvent(options: {
  entries?: unknown[];
  customInstructions?: string;
}) {
  const preparation = {
    targetId: "target",
    oldLeafId: "leaf",
    commonAncestorId: null,
    entriesToSummarize: options.entries ?? [],
    userWantsSummary: true,
    customInstructions: options.customInstructions,
  };
  return {
    type: "session_before_tree",
    preparation,
    signal: new AbortController().signal,
  } as unknown as SessionBeforeTreeEvent;
}

const userText = (text: string) => ({
  role: "user",
  content: [{ type: "text", text }],
});

test("what Pi summarizes is redacted in place / Pi 要摘要的内容被原地脱敏", async (t) => {
  const engine = await engineWith(t);
  const event = compactEvent({
    messages: [userText("call 13800138000"), userText("张三 approved")],
    prefix: [userText("token sk-live-abcdefgh")],
    previousSummary: "earlier: 13800138000",
  });
  const { preparation } = event;
  const messages = preparation.messagesToSummarize;
  const prefix = preparation.turnPrefixMessages;

  await redactCompaction(event, engine, "fixture");

  // Identity must survive: Pi destructures this object, and the tree path even
  // keeps its own reference to the array.
  // 必须保持同一对象：Pi 解构该对象，tree 路径甚至自己持有数组引用。
  assert.equal(preparation.messagesToSummarize, messages);
  assert.equal(preparation.turnPrefixMessages, prefix);
  const sent = JSON.stringify({
    messages,
    prefix,
    previous: preparation.previousSummary,
  });
  for (const secret of SECRETS)
    assert.ok(!sent.includes(secret), `${secret} must not reach Pi`);
  // Structure is preserved so Pi can still serialize the conversation.
  // 结构保持不变，Pi 仍能序列化该对话。
  assert.equal(messages.length, 2);
  assert.equal(prefix.length, 1);
  assert.match(sent, /call [a-z0-9]+/i);
  assert.ok(preparation.previousSummary?.startsWith("earlier: "));
});

test("an absent previous summary stays absent / 缺失的上次摘要保持缺失", async (t) => {
  const engine = await engineWith(t);
  const event = compactEvent({ messages: [userText("13800138000")] });
  await redactCompaction(event, engine, "fixture");
  assert.equal(event.preparation.previousSummary, undefined);
  assert.ok(
    !JSON.stringify(event.preparation.messagesToSummarize).includes(
      "13800138000",
    ),
  );
});

test("a protected value in the instruction cancels / 指令含受保护值则取消", async (t) => {
  const engine = await engineWith(t);
  // Pi reads customInstructions from its own state, so a redacted copy here
  // would never be used: the only safe answer is to refuse.
  // Pi 从自身状态读取 customInstructions，此处脱敏的副本不会被采用，只能拒绝。
  const event = compactEvent({
    messages: [userText("hello")],
    customInstructions: "focus on 13800138000",
  });
  const error = await redactCompaction(event, engine, "fixture").then(
    () => undefined,
    (value: unknown) => value,
  );
  assert.ok(error instanceof ProtectionError);
  assert.equal(error.diagnostic.code, "COMPACT_INSTRUCTIONS");
  // Nothing may be mutated when the call refuses. / 拒绝时不得改动任何内容。
  assert.deepEqual(event.preparation.messagesToSummarize, [userText("hello")]);
});

test("a clean instruction is accepted / 无受保护值的指令可通过", async (t) => {
  const engine = await engineWith(t);
  const event = compactEvent({
    messages: [userText("13800138000")],
    customInstructions: "keep the build steps",
  });
  await redactCompaction(event, engine, "fixture");
  assert.ok(
    !JSON.stringify(event.preparation.messagesToSummarize).includes(
      "13800138000",
    ),
  );
});

test("redaction failure throws, nothing is half redacted / 脱敏失败抛出且不留半脱敏状态", async (t) => {
  const engine = await engineWith(t);
  engine.close();
  const event = compactEvent({ messages: [userText("13800138000")] });
  await assert.rejects(() => redactCompaction(event, engine, "fixture"));
  // The caller cancels compaction; the original stays untouched locally.
  // 调用方会取消压缩；本地原始内容保持不变。
  assert.deepEqual(event.preparation.messagesToSummarize, [
    userText("13800138000"),
  ]);
});

test("branch entries are redacted and instructions returned / 分支条目脱敏且返回指令", async (t) => {
  const engine = await engineWith(t);
  const event = treeEvent({
    entries: [userText("张三 and sk-live-abcdefgh")],
    customInstructions: "summarize 13800138000 work",
  });
  const entries = event.preparation.entriesToSummarize;
  const result = await redactTree(event, engine, "fixture");

  assert.equal(event.preparation.entriesToSummarize, entries);
  const sent = JSON.stringify({ entries, result });
  for (const secret of SECRETS) assert.ok(!sent.includes(secret));
  // This event does read its instructions back, so they are redacted, not refused.
  // 该事件会读回指令，因此脱敏而非拒绝。
  assert.ok(result.customInstructions);
  assert.ok(result.customInstructions.startsWith("summarize "));
});

test("tree without instructions returns none / 无指令时不返回指令", async (t) => {
  const engine = await engineWith(t);
  const event = treeEvent({ entries: [userText("13800138000")] });
  assert.deepEqual(await redactTree(event, engine, "fixture"), {});
});

test("compaction settings keep only the mode / 压缩配置仅保留 mode", () => {
  assert.deepEqual(compactionSettings(undefined), {
    mode: DEFAULT_COMPACTION,
  });
  assert.deepEqual(compactionSettings("off"), { mode: "off" });
  // Settings that used to select a summarization model are accepted so an
  // upgrade cannot brick a working setup, but they are dropped here.
  // 过去用于选择摘要模型的设置仍被接收（避免升级后拦住可用环境），但在此处丢弃。
  assert.deepEqual(
    compactionSettings({
      mode: "protected",
      provider: "lmstudio",
      model: "qwen",
      contextWindow: 262144,
      reserveTokens: 4096,
    } as never),
    { mode: "protected" },
  );
});

test("ignored settings load and are reported / 已忽略的设置可加载并被上报", () => {
  const raw = JSON.stringify({
    version: 1,
    sensitiveWords: ["13800138000"],
    compaction: {
      mode: "protected",
      provider: "lmstudio",
      model: "qwen",
      reserveTokens: 4096,
    },
  });
  const config = parseConfig(raw);
  assert.deepEqual(ignoredCompactionKeys(config.compaction), [
    "provider",
    "model",
    "reserveTokens",
  ]);
  assert.equal(compactionSettings(config.compaction).mode, "protected");
  assert.deepEqual(ignoredCompactionKeys("off"), []);
  assert.deepEqual(ignoredCompactionKeys(undefined), []);
});

test("an unusable mode is still rejected / 无效 mode 仍被拒绝", () => {
  for (const compaction of [
    "sometimes",
    { mode: "sometimes" },
    { mode: "off", unknown: 1 },
    { provider: {} },
  ])
    assert.throws(() =>
      parseConfig(
        JSON.stringify({ version: 1, sensitiveWords: [], compaction }),
      ),
    );
});
