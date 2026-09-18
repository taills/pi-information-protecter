import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  discoverAndLoadExtensions,
  ExtensionRunner,
  SessionManager,
  type ModelRegistry,
  type ExtensionContextActions,
} from "@earendil-works/pi-coding-agent";

test("real Pi jiti loader + runner: outgoing payload, message restoration, tool guard, safe failure", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "spi-integration-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  const loaded = await discoverAndLoadExtensions(
    [resolve("src/index.ts")],
    dir,
    dir,
  );
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 1);
  const runner = new ExtensionRunner(
    loaded.extensions,
    loaded.runtime,
    dir,
    SessionManager.inMemory(dir),
    {} as ModelRegistry,
  );
  // Stub only the host UI/agent actions, not the extension, loader or middleware runner.
  // 仅模拟宿主界面和智能体动作，不模拟扩展、加载器或中间件执行器。
  let aborted = false;
  runner.bindCore(
    {
      sendMessage() {},
      sendUserMessage() {},
      appendEntry() {},
      setSessionName() {},
      getSessionName: () => undefined,
      setLabel() {},
      getActiveTools: () => ["read", "bash"],
      getAllTools: () => [],
      setActiveTools() {},
      refreshTools() {},
      getCommands: () => [],
      setModel: async () => true,
      getThinkingLevel: () => "off",
      setThinkingLevel() {},
    },
    {
      getModel: () => undefined,
      getScopedModels: () => [],
      isIdle: () => true,
      isProjectTrusted: () => true,
      getSignal: () => undefined,
      abort: () => {
        aborted = true;
      },
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
  const path = join(dir, "protecter.json");
  writeFileSync(
    path,
    JSON.stringify({ version: 1, sensitiveWords: ["fake-private-password"] }),
  );
  const outgoing = (await runner.emitBeforeProviderRequest({
    model: "demo",
    messages: [{ role: "user", content: "fake-private-password" }],
  })) as { messages: { content: string }[] };
  const token = outgoing.messages[0].content;
  assert.match(token, /^__PIP_[a-f0-9]{48}__$/);
  assert.ok(!JSON.stringify(outgoing).includes("fake-private-password"));
  const original = {
    role: "assistant" as const,
    api: "openai-completions" as const,
    provider: "demo",
    model: "demo",
    timestamp: 1,
    stopReason: "toolUse" as const,
    usage: {
      input: 1,
      output: 1,
      totalTokens: 2,
      cacheRead: 0,
      cacheWrite: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    content: [
      { type: "text" as const, text: token },
      {
        type: "thinking" as const,
        thinking: token,
        thinkingSignature: "keep-signature",
      },
      {
        type: "toolCall" as const,
        id: "keep-id",
        name: "write",
        arguments: { path: "safe.txt", content: token },
      },
    ],
  };
  const restored = await runner.emitMessageEnd({
    type: "message_end",
    message: original,
  });
  assert.ok(restored?.role === "assistant");
  assert.equal(
    restored.content[0].type === "text" && restored.content[0].text,
    "fake-private-password",
  );
  assert.equal(
    restored.content[1].type === "thinking" &&
      restored.content[1].thinkingSignature,
    "keep-signature",
  );
  assert.equal(
    restored.content[2].type === "toolCall" && restored.content[2].id,
    "keep-id",
  );
  assert.equal(
    runner.getMarkdownTransformers()[0](token, {
      messageType: "assistant",
      isStreaming: true,
      availableWidth: 80,
    }),
    "fake-private-password",
  );

  const call = {
    type: "tool_call" as const,
    toolName: "write",
    toolCallId: "id",
    input: { path: "safe.txt", content: token },
  };
  assert.equal(await runner.emitToolCall(call), undefined);
  assert.equal(call.input.content, "fake-private-password");
  for (const [toolName, input] of [
    ["read", { path }],
    ["bash", { command: `cat ${path}` }],
  ] as const) {
    assert.equal(
      (
        await runner.emitToolCall({
          type: "tool_call",
          toolName,
          toolCallId: "x",
          input,
        })
      )?.block,
      true,
    );
  }
  assert.equal(
    await runner.emitToolCall({
      type: "tool_call",
      toolName: "bash",
      toolCallId: "y",
      input: { command: "npm test" },
    }),
    undefined,
  );
  // The response is locally restored, then safely re-masked on the subsequent request.
  // 响应在本地还原，并在后续请求中再次安全脱敏。
  const followup = await runner.emitBeforeProviderRequest({
    messages: [restored],
  });
  assert.ok(!JSON.stringify(followup).includes("fake-private-password"));

  writeFileSync(path, "invalid-secret-config");
  assert.deepEqual(
    await runner.emitBeforeProviderRequest({
      messages: [{ content: "must-never-leave" }],
    }),
    {},
  );
  assert.equal(aborted, true);
  assert.equal((await runner.emitToolCall(call))?.block, true);
});
