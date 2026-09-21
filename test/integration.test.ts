import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readdirSync,
  readFileSync,
  mkdirSync,
  symlinkSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  discoverAndLoadExtensions,
  ExtensionRunner,
  SessionManager,
  type ModelRegistry,
  type ExtensionContextActions,
} from "@earendil-works/pi-coding-agent";

for (const mode of ["source", "packed"] as const) {
  test(`real Pi loader and workers (${mode}) / 真实 Pi 加载器与 worker`, async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "spi-integration-"));
    const previous = process.env.PI_CODING_AGENT_DIR;
    const previousLang = process.env.PI_PROTECTER_LANG;
    process.env.PI_CODING_AGENT_DIR = dir;
    // Pin the language so assertions do not depend on the host locale.
    // 固定语言，避免断言依赖宿主环境语言。
    process.env.PI_PROTECTER_LANG = "en";
    t.after(() => {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
      if (previousLang === undefined) delete process.env.PI_PROTECTER_LANG;
      else process.env.PI_PROTECTER_LANG = previousLang;
      rmSync(dir, { recursive: true, force: true });
    });
    let entry = resolve("src/index.ts");
    if (mode === "packed") {
      const packed = join(dir, "packed");
      mkdirSync(packed);
      // Build ran via pretest; test the actual tarball with no source fallback.
      // pretest 已完成构建，此处验证真实压缩包，不允许回退源码。
      const output = execFileSync(
        "npm",
        ["pack", "--ignore-scripts", "--json", "--pack-destination", packed],
        { encoding: "utf8" },
      );
      const [archive] = JSON.parse(output);
      assert.ok(
        archive.files.some(
          (f: { path: string }) => f.path === "dist/index.mjs",
        ),
      );
      assert.ok(
        archive.files.some(
          (f: { path: string }) => f.path === "dist/scan-worker.mjs",
        ),
      );
      assert.ok(
        archive.files.some(
          (f: { path: string }) => f.path === "dist/validate-worker.mjs",
        ),
      );
      assert.ok(
        !archive.files.some((f: { path: string }) =>
          /^(src|test|scripts|node_modules)\/|\.map$|\.ts$/.test(f.path),
        ),
      );
      execFileSync("tar", [
        "-xzf",
        join(packed, archive.filename),
        "-C",
        packed,
      ]);
      const root = join(packed, "package");
      const manifest = JSON.parse(
        readFileSync(join(root, "package.json"), "utf8"),
      );
      assert.deepEqual(manifest.pi.extensions, ["./dist/index.mjs"]);
      // Resolve only through the test host; consumers use Pi's installed peer package.
      // 通过测试宿主解析依赖，实际用户使用 Pi 提供的 peer 包。
      symlinkSync(
        resolve("node_modules"),
        join(root, "node_modules"),
        "junction",
      );
      entry = join(root, manifest.pi.extensions[0]);
    }
    const loaded = await discoverAndLoadExtensions([entry], dir, dir);
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
    let injected = 0;
    runner.bindCore(
      {
        sendMessage() {
          injected++;
        },
        sendUserMessage() {
          injected++;
        },
        appendEntry() {
          injected++;
        },
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
        getModel: () => ({ provider: "fixture-provider" }) as never,
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
    writeFileSync(
      join(dir, "protecter.json"),
      JSON.stringify({
        version: 1,
        sensitiveWords: [
          "fake-private-password",
          {
            type: "literal",
            value: "Apple Inc.",
            replacement: "Alphabet Inc.",
          },
        ],
      }),
    );
    await runner.emit({ type: "session_start", reason: "startup" });
    t.after(async () => {
      await runner.emit({ type: "session_shutdown", reason: "quit" });
    });
    const path = join(
      dir,
      readdirSync(dir).find((name) =>
        /^protecter\.[a-f0-9]{32}\.json$/.test(name),
      )!,
    );
    const outgoing = (await runner.emitBeforeProviderRequest({
      model: "demo",
      messages: [{ role: "user", content: "fake-private-password" }],
    })) as { messages: { content: string }[] };
    const auditPath = path.replace(/\.json$/, ".jsonl");
    const audit = JSON.parse(readFileSync(auditPath, "utf8").trim());
    assert.equal(audit.provider, "fixture-provider");
    assert.equal(audit.original, "fake-private-password");
    const token = outgoing.messages[0].content;
    assert.equal(audit.replacement, token);
    const command = runner.getCommand("protecter")!;
    const commandCtx = runner.createCommandContext();
    const previews: string[] = [];
    const notices: string[] = [];
    let waited = 0;
    const localCtx = {
      ...commandCtx,
      mode: "tui" as const,
      waitForIdle: async () => {
        waited++;
      },
      ui: {
        ...commandCtx.ui,
        notify: (message: string) => {
          notices.push(message);
        },
        select: async (_title: string, options: string[]) => options[0],
        confirm: async () => true,
        editor: async (_title: string, text?: string) => {
          previews.push(text ?? "");
          return undefined;
        },
      },
    };
    await command.handler("", localCtx);
    assert.ok(previews[0].includes("fake-private-password"));
    await command.handler("logs", { ...localCtx, mode: "rpc" });
    assert.equal(previews.length, 1);
    await command.handler("logs", {
      ...localCtx,
      ui: { ...localCtx.ui, confirm: async () => false },
    });
    assert.equal(previews.length, 1);
    assert.equal(injected, 0);
    // Shape-preserving value: same length, same hyphen layout, letters only.
    // 同形替换值：长度与连字符位置不变，仅含字母。
    assert.match(token, /^[a-z]{4}-[a-z]{7}-[a-z]{8}$/);
    assert.equal(token.length, "fake-private-password".length);
    assert.ok(!JSON.stringify(outgoing).includes("fake-private-password"));
    const fixed = (await runner.emitBeforeProviderRequest({
      text: "Apple Inc.",
    })) as { text: string };
    assert.equal(fixed.text, "Alphabet Inc.");
    assert.equal(
      runner.getMarkdownTransformers()[0](fixed.text, {
        messageType: "assistant",
        isStreaming: false,
        availableWidth: 80,
      }),
      "Apple Inc.",
    );
    const fixedCall = {
      type: "tool_call" as const,
      toolName: "write",
      toolCallId: "fixed",
      input: { path: "safe.txt", content: fixed.text },
    };
    assert.equal(await runner.emitToolCall(fixedCall), undefined);
    assert.equal(fixedCall.input.content, "Apple Inc.");
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
      ["read", { path: auditPath }],
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

    const savedAudit = readFileSync(auditPath, "utf8");
    const savedConfig = readFileSync(path, "utf8");
    await command.handler("logs clear", { ...localCtx, mode: "rpc" });
    await command.handler("logs clear", { ...localCtx, mode: "print" });
    await command.handler("logs clear", {
      ...localCtx,
      ui: { ...localCtx.ui, confirm: async () => false },
    });
    await command.handler("logs clear extra", localCtx);
    assert.equal(readFileSync(auditPath, "utf8"), savedAudit);
    assert.equal(waited, 0);
    await command.handler("logs clear", localCtx);
    assert.equal(waited, 1);
    assert.equal(readFileSync(auditPath, "utf8"), "");
    assert.equal(readFileSync(path, "utf8"), savedConfig);
    assert.ok(
      notices.some((message) => message.startsWith("Audit log cleared:")),
    );
    assert.equal(injected, 0);
    const afterClear = (await runner.emitBeforeProviderRequest({
      text: "fake-private-password",
    })) as { text: string };
    assert.equal(afterClear.text, token);
    assert.equal(
      JSON.parse(readFileSync(auditPath, "utf8").trim()).replacement,
      token,
    );

    rmSync(path);
    assert.ok(
      !JSON.stringify(
        await runner.emitBeforeProviderRequest({
          text: "fake-private-password",
        }),
      ).includes("fake-private-password"),
    );
    rmSync(auditPath);
    mkdirSync(auditPath);
    await command.handler("logs clear", localCtx);
    // Failures name the audit stage instead of a generic message.
    // 失败会指出审计阶段，而非笼统提示。
    assert.ok(
      notices.some(
        (message) =>
          message.includes("stage=audit") && message.includes("code=AUDIT_"),
      ),
    );
    const blockedByAudit = await runner.emitBeforeProviderRequest({
      text: "fake-private-password",
    });
    assert.deepEqual(blockedByAudit, {});
    const auditNotice = notices.at(-1)!;
    assert.ok(auditNotice.includes("stage=audit"));
    assert.ok(!auditNotice.includes("fake-private-password"));
    assert.ok(!auditNotice.includes(auditPath));
    writeFileSync(path, "invalid-secret-config");
    await runner.emit({ type: "session_start", reason: "reload" });
    assert.deepEqual(
      await runner.emitBeforeProviderRequest({
        messages: [{ content: "must-never-leave" }],
      }),
      {},
    );
    // Configuration failures stay identifiable through status after reload.
    // 配置失败在重载后仍可通过状态命令定位。
    await command.handler("status", localCtx);
    const statusNotice = notices.at(-1)!;
    assert.ok(statusNotice.includes("Last block @"));
    // Single-language output only: no Chinese in the English locale. / 单语言输出：英文环境不出现中文。
    assert.ok(!/[\u4e00-\u9fa5]/.test(statusNotice));
    assert.ok(statusNotice.includes("code=CONFIG_JSON"));
    assert.ok(statusNotice.includes("stage=configuration"));
    assert.ok(!statusNotice.includes("must-never-leave"));
    assert.ok(!statusNotice.includes("fake-private-password"));
    assert.equal(aborted, true);
    const blockedTool = await runner.emitToolCall(call);
    assert.equal(blockedTool?.block, true);
    assert.ok(String(blockedTool?.reason).includes("code=CONFIG_JSON"));
  });
}
