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
      assert.equal(manifest.peerDependencies["@earendil-works/pi-tui"], "*");
      assert.equal(manifest.dependencies?.["@earendil-works/pi-tui"], undefined);
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
    // The registry must carry a model runtime of Pi's real shape: the guard
    // installed on it covers the provider calls no extension event can see.
    // 注册表必须带有与 Pi 真实形态一致的模型运行时：安装在其上的闸门
    // 覆盖了任何扩展事件都看不到的提供商调用。
    const sent: { method: string; context: unknown }[] = [];
    const lazy =
      (method: string) =>
      (_model: unknown, context: unknown, _options?: unknown) => {
        sent.push({ method, context });
        return { result: async () => ({ method }) };
      };
    const modelRuntime = {
      stream: lazy("stream"),
      streamSimple: lazy("streamSimple"),
      classify: async (
        _model: unknown,
        context: unknown,
        _options?: unknown,
      ) => {
        sent.push({ method: "classify", context });
        return {};
      },
      generateImages: async (
        _model: unknown,
        context: unknown,
        _options?: unknown,
      ) => {
        sent.push({ method: "generateImages", context });
        return {};
      },
    };
    const runner = new ExtensionRunner(
      loaded.extensions,
      loaded.runtime,
      dir,
      SessionManager.inMemory(dir),
      { runtime: modelRuntime } as unknown as ModelRegistry,
    );
    // Stub only the host UI/agent actions, not the extension, loader or middleware runner.
    // 仅模拟宿主界面和智能体动作，不模拟扩展、加载器或中间件执行器。
    let aborted = false;
    let injected = 0;
    const uiPreviews: string[] = [];
    let imageDecisions = 0;
    let imagePreviews = 0;
    const reviewTitles: string[] = [];
    const reviewOptions: string[][] = [];
    const hostNotices: string[] = [];
    runner.setUIContext({
      select: async (title: string, options: string[]) => {
        if (title.includes("Review attachment")) {
          imageDecisions++;
          reviewTitles.push(title);
          reviewOptions.push(options);
          assert.ok(title.includes("Review it before deciding"));
          if (imageDecisions === 1 && options[0] === "Open image") return options[0];
          return options.find((option) => option === "Allow this attachment") ?? options[0];
        }
        return options[0];
      },
      confirm: async () => true,
      input: async () => undefined,
      notify: (message: string) => {
        hostNotices.push(message);
      },
      onTerminalInput: () => () => {},
      setStatus: () => {},
      setWorkingMessage: () => {},
      setWorkingVisible: () => {},
      setWorkingIndicator: () => {},
      setHiddenThinkingLabel: () => {},
      setWidget: () => {},
      setFooter: () => {},
      setHeader: () => {},
      custom: async (factory: (tui: unknown, theme: unknown, keys: unknown, done: (result: unknown) => void) => { render(width: number): string[]; handleInput?(input: string): void; invalidate(): void }) => {
        imagePreviews++;
        const component = factory({}, { fg: (_color: string, text: string) => text }, {}, () => {});
        assert.ok(component.render(80).length > 0);
        component.handleInput?.("\\r");
        return undefined;
      },
      editor: async (_title: string, prefill?: string) => {
        uiPreviews.push(prefill ?? "");
        return undefined;
      },
    } as never, "tui");
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
        attachments: "ask",
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
        select: async (title: string, options: string[]) => {
        if (title.includes("Allow attachments?")) assert.ok(title.includes("cannot inspect or redact"));
        return options[0];
      },
        confirm: async () => true,
        editor: async (_title: string, text?: string) => {
          uiPreviews.push(text ?? "");
          return undefined;
        },
      },
    };
    const tinyPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/pV8AAAAASUVORK5CYII=";
    const attachmentPayload = { content: [
      { type: "text", text: "fake-private-password" },
      { type: "image", data: tinyPng, mimeType: "image/png" },
      { type: "image", data: tinyPng, mimeType: "image/png" },
    ] };
    const attachmentOutgoing = (await runner.emitBeforeProviderRequest(attachmentPayload)) as typeof attachmentPayload;
    assert.equal(attachmentOutgoing.content[1].data, tinyPng);
    assert.equal(attachmentOutgoing.content[2].data, tinyPng);
    assert.notEqual(attachmentOutgoing.content[0].text, "fake-private-password");
    assert.equal(imageDecisions, 3, "opening the first image returns to its confirmation menu; each image has its own decision");
    assert.equal(imagePreviews, 1);
    await runner.emitBeforeProviderRequest(attachmentPayload);
    assert.equal(imageDecisions, 3, "the same confirmed image content is not treated as newly added");
    const withNewImage = {
      content: [...attachmentPayload.content, { type: "image" as const, data: tinyPng, mimeType: "image/png" }],
    };
    await runner.emitBeforeProviderRequest(withNewImage);
    assert.equal(imageDecisions, 4, "a new image content fingerprint requires a fresh decision");
    assert.ok(reviewTitles.at(-1)!.includes("Local file path: Not provided by Pi"));

    // Provider-shaped inline images (Anthropic base64, OpenAI data URLs) can be
    // previewed instead of only allowed or cancelled.
    // 提供商格式的内嵌图片（Anthropic base64、OpenAI data URL）可预览，而不是只能放行或取消。
    await runner.emitBeforeProviderRequest({ messages: [{ role: "user", content: [
      { type: "image", source: { type: "base64", media_type: "image/png", data: "QUJDRA==" } },
      { type: "image_url", image_url: { url: "data:image/png;base64,QUJDRQ==" } },
      { type: "input_image", image_url: "data:image/png;base64,QUJDRg==" },
    ] }] });
    assert.equal(imageDecisions, 7);
    for (const options of reviewOptions.slice(-3)) assert.equal(options[0], "Open image");

    // Images read by a tool show their source path; one approval per path.
    // 工具读取的图片展示来源路径；同一路径只需允许一次。
    const shotPath = join(dir, "shot.png");
    await runner.emitToolResult({
      type: "tool_result", toolName: "read", toolCallId: "read-1", input: { path: shotPath },
      content: [{ type: "image", data: "UEFUSA==", mimeType: "image/png" }], isError: false, details: undefined,
    } as never);
    await runner.emitBeforeProviderRequest({ content: [{ type: "image", data: "UEFUSA==", mimeType: "image/png" }] });
    assert.equal(imageDecisions, 8);
    assert.ok(reviewTitles.at(-1)!.includes(`Local file path: ${shotPath}`));
    await runner.emitToolResult({
      type: "tool_result", toolName: "read", toolCallId: "read-2", input: { path: shotPath },
      content: [{ type: "image", data: "UEFUSDI=", mimeType: "image/png" }], isError: false, details: undefined,
    } as never);
    await runner.emitBeforeProviderRequest({ content: [{ type: "image", data: "UEFUSDI=", mimeType: "image/png" }] });
    assert.equal(imageDecisions, 8, "an approved path is not asked again");
    assert.ok(!aborted);

    await command.handler("", localCtx);
    assert.equal(uiPreviews.length, 1);
    await command.handler("logs", { ...localCtx, mode: "rpc" });
    assert.equal(previews.length, 0);
    await command.handler("logs", {
      ...localCtx,
      ui: { ...localCtx.ui, confirm: async () => false },
    });
    assert.equal(previews.length, 0);
    assert.equal(injected, 0);
    // Shape-preserving value: same length, same hyphen layout, letters only.
    // 同形替换值：长度与连字符位置不变，仅含字母。
    assert.match(token, /^[a-z]{4}-[a-z]{7}-[a-z]{8}$/);
    assert.equal(token.length, "fake-private-password".length);
    assert.ok(!JSON.stringify(outgoing).includes("fake-private-password"));

    // Offline test command: local text and local files are redacted with the
    // same rules and the same mapping, and nothing reaches a provider.
    // 离线测试命令：本地文本与本地文件使用相同规则和相同映射脱敏，且不发往提供商。
    const demoPath = join(dir, "demo.txt");
    writeFileSync(demoPath, "contact fake-private-password now");
    await command.handler(`test @${demoPath}`, localCtx);
    const filePreview = uiPreviews.at(-1)!;
    assert.ok(!filePreview.includes("fake-private-password"));
    assert.ok(filePreview.includes(token));
    await command.handler("test Apple Inc. stays fixed", localCtx);
    assert.ok(uiPreviews.at(-1)!.includes("Alphabet Inc."));
    // A missing argument prints usage; an unreadable path reports TEST_INPUT.
    // 缺少参数时提示用法；路径不可读时返回 TEST_INPUT。
    const previewCount = uiPreviews.length;
    await command.handler("test", localCtx);
    await command.handler(`test @${join(dir, "missing.txt")}`, localCtx);
    assert.equal(uiPreviews.length, previewCount);
    assert.match(notices.at(-1)!, /code=TEST_INPUT/);

    // Pi's own summarizers, /bug and nested model calls reach the provider
    // through the model runtime with no payload hook and no extension event.
    // Pi 自身的摘要器、/bug 与嵌套模型调用经模型运行时发往提供商，
    // 既无请求钩子也无扩展事件。
    const summarizerContext = {
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "fake-private-password" }],
        },
      ],
    };
    // Without a payload hook the guard redacts first, so the lazy stream
    // arrives as a promise instead of synchronously.
    // 无请求钩子时闸门会先脱敏，因此惰性流以 promise 而非同步形式返回。
    const hooklessStream = modelRuntime.streamSimple as unknown as (
      model: unknown,
      context: unknown,
      options?: unknown,
    ) => Promise<{ result: () => Promise<unknown> }>;
    await (
      await hooklessStream({ provider: "demo" }, summarizerContext, {
        apiKey: "k",
      })
    ).result();
    await modelRuntime.classify({ provider: "demo" }, summarizerContext, {});
    assert.equal(sent.length, 2);
    for (const call of sent) {
      assert.ok(
        !JSON.stringify(call.context).includes("fake-private-password"),
        `${call.method} must not carry plaintext`,
      );
      assert.ok(JSON.stringify(call.context).includes(token));
    }
    // The original stays untouched locally; only what leaves is redacted.
    // 本地原始对象不变，只有外发内容被脱敏。
    assert.equal(
      summarizerContext.messages[0].content[0].text,
      "fake-private-password",
    );
    // Agent-loop requests carry Pi's payload hook, which this extension already
    // covers, and their callers need the synchronous lazy stream.
    // 智能体循环请求携带 Pi 的请求钩子（已被本扩展覆盖），且调用方需要同步惰性流。
    const warmed = modelRuntime.streamSimple(
      { provider: "demo" },
      summarizerContext,
      { onPayload: async (payload: unknown) => payload },
    );
    assert.equal(typeof warmed.result, "function");
    assert.equal(sent.length, 3);
    assert.equal(sent[2].context, summarizerContext);
    sent.length = 0;

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
    // Fixed-rule overlaps show both configuration entries locally, never to the model.
    // 固定规则重叠时在本地展示两条配置条目，绝不提供给模型。
    writeFileSync(path, JSON.stringify({ version: 1, sensitiveWords: [
      "unrelated-word",
      { type: "literal", value: "Apple Inc.", replacement: "Alphabet Inc." },
      { type: "literal", value: "Inc. Ltd", replacement: "Corp Plc" },
    ] }));
    await runner.emit({ type: "session_start", reason: "reload" });
    assert.deepEqual(await runner.emitBeforeProviderRequest({ text: "Apple Inc. Ltd" }), {});
    const overlapNotice = hostNotices.at(-1)!;
    assert.ok(overlapNotice.includes("code=FIXED_OVERLAP"));
    assert.ok(overlapNotice.includes('#2 {"type":"literal","value":"Apple Inc.","replacement":"Alphabet Inc."}'));
    assert.ok(overlapNotice.includes('#3 {"type":"literal","value":"Inc. Ltd","replacement":"Corp Plc"}'));
    await command.handler("status", localCtx);
    assert.ok(notices.at(-1)!.includes("#3 "));
    const overlapTool = await runner.emitToolCall(call);
    assert.equal(overlapTool?.block, true);
    assert.ok(String(overlapTool?.reason).includes("code=FIXED_OVERLAP"));
    assert.ok(!String(overlapTool?.reason).includes("Inc. Ltd"), "rule contents never reach the model");
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
