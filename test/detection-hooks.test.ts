import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
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
 * Detection through Pi's real loader and runner: the input, tool_result and
 * before_provider_request hooks against a local System One stand-in.
 * 通过 Pi 真实的加载器与执行器验证检测：input、tool_result 与 before_provider_request
 * 钩子对接本地 System One 替身服务。
 */
test("System One detection in real Pi hooks / 真实 Pi 钩子中的 System One 检测", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "spi-detect-hooks-"));
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

  // Stand-in decision service: "credential" fires on SECRET or any image.
  // 替身决策服务：含 SECRET 或任意图片时 "credential" 命中。
  const states: string[] = [];
  let up = true;
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      if (!up) {
        res.writeHead(503).end();
        return;
      }
      if (req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(req.url === "/health" ? { status: "ok" } : {}));
        return;
      }
      const body = JSON.parse(raw) as { state: string; images?: string[]; questions: Record<string, unknown> };
      states.push(body.state);
      const rule = Object.keys(body.questions)[0];
      const yes = rule === "credential" && (body.state.includes("SECRET") || !!body.images?.length);
      res.writeHead(200, { "Content-Type": "application/json" }).end(
        JSON.stringify({ answers: { [rule]: { type: "noul", noul: yes ? 0.97 : 0.02 } } }),
      );
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => server.close());
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/systemone`;

  writeFileSync(
    join(dir, "protecter.json"),
    JSON.stringify({
      version: 1,
      attachments: "allow",
      sensitiveWords: ["fake-private-password"],
      detection: {
        model: { endpoint },
        rules: [
          { id: "credential", instructions: "credential?", action: "block" },
          { id: "pii", instructions: "pii?" },
        ],
      },
    }),
  );

  const loaded = await discoverAndLoadExtensions([resolve("src/index.ts")], dir, dir);
  assert.deepEqual(loaded.errors, []);
  const runtime = {
    stream: () => ({ result: async () => ({}) }),
    streamSimple: () => ({ result: async () => ({}) }),
    classify: async () => ({}),
    generateImages: async () => ({}),
  };
  const runner = new ExtensionRunner(
    loaded.extensions,
    loaded.runtime,
    dir,
    SessionManager.inMemory(dir),
    { runtime } as unknown as ModelRegistry,
  );
  const notices: string[] = [];
  const editorTexts: string[] = [];
  const statuses = new Map<string, string | undefined>();
  let aborted = 0;
  runner.setUIContext({
    select: async (_title: string, options: string[]) => options[0],
    confirm: async () => true,
    input: async () => undefined,
    notify: (message: string) => notices.push(message),
    onTerminalInput: () => () => {},
    setStatus: (key: string, value: string | undefined) => statuses.set(key, value),
    setWorkingMessage: () => {},
    setWorkingVisible: () => {},
    setWorkingIndicator: () => {},
    setHiddenThinkingLabel: () => {},
    setWidget: () => {},
    setFooter: () => {},
    setHeader: () => {},
    setEditorText: (text: string) => editorTexts.push(text),
    custom: async () => undefined,
    editor: async () => undefined,
  } as never, "tui");
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
      abort: () => {
        aborted++;
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
  assert.equal(statuses.get("protecter-detect"), "System One · log/block");
  // Migration moved the model service and rules into the machine file, like
  // every other setting. / 与其他设置一样，迁移后模型服务与规则保存在机器配置文件中。
  const machineFile = readdirSync(dir).find((name) => /^protecter\.[a-f0-9]{32}\.json$/.test(name));
  assert.ok(machineFile);
  assert.ok(!readdirSync(dir).includes("protecter.json"));
  const stored = JSON.parse(readFileSync(join(dir, machineFile!), "utf8"));
  assert.equal(stored.detection.model.endpoint, endpoint);
  assert.deepEqual(stored.detection.rules.map((rule: { id: string }) => rule.id), ["credential", "pii"]);
  // A loopback endpoint raises no remote warning. / 回环端点不触发远程提示。
  assert.ok(!notices.some((n) => n.includes("not on this computer")));

  // 1. Input: a blocking hit is handled, never sent, and put back in the editor.
  // 1. 输入：阻断命中即被处理，不会发送，并放回编辑框。
  const blockedInput = await runner.emitInput("deploy with SECRET token", undefined, "interactive");
  assert.deepEqual(blockedInput, { action: "handled" });
  assert.deepEqual(editorTexts, ["deploy with SECRET token"]);
  assert.ok(notices.some((n) => n.includes("System One blocked your message") && n.includes("credential 97%")));
  assert.equal((await runner.emitInput("refactor this function", undefined, "interactive")).action, "continue");
  const imageInput = await runner.emitInput("look", [{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }], "interactive");
  assert.deepEqual(imageInput, { action: "handled" });

  // 2. Tool result: blocked output is replaced; the model sees only rule IDs.
  // 2. 工具结果：被阻断的输出被替换，模型只看到规则 ID。
  const withheld = await runner.emitToolResult({
    type: "tool_result", toolName: "read", toolCallId: "r1", input: { path: "/tmp/.env" },
    content: [{ type: "text", text: "API_KEY=SECRET-abc" }], isError: false, details: undefined,
  } as never);
  assert.equal(withheld?.isError, true);
  const notice = (withheld?.content?.[0] as { text: string }).text;
  assert.ok(notice.includes("Tool output withheld") && notice.includes("credential"));
  assert.ok(!notice.includes("SECRET"));
  const clean = await runner.emitToolResult({
    type: "tool_result", toolName: "read", toolCallId: "r2", input: { path: "/tmp/a.ts" },
    content: [{ type: "text", text: "export const a = 1;" }], isError: false, details: undefined,
  } as never);
  assert.equal(clean?.content, undefined);

  // 3. Request: content that bypassed both hooks is blocked fail-closed; the
  // withheld notice itself is not re-checked; redaction still runs.
  // 3. 请求：绕过前两道检查的内容会失败即阻断；拦截提示本身不再复检；脱敏照常执行。
  const blockedRequest = await runner.emitBeforeProviderRequest({
    system: "AGENTS.md says the SECRET is here",
    messages: [{ role: "user", content: "hello there" }],
  });
  assert.deepEqual(blockedRequest, {});
  assert.equal(aborted, 1);
  assert.ok(notices.some((n) => n.includes("code=DETECT_HIT")));
  const before = states.length;
  const passed = (await runner.emitBeforeProviderRequest({
    messages: [
      { role: "user", content: "hello there" },
      { role: "assistant", content: "model text with SECRET is not re-checked" },
      { role: "tool", content: notice },
      { role: "user", content: "my fake-private-password please" },
    ],
  })) as { messages: Array<{ content: string }> };
  assert.equal(aborted, 1);
  assert.ok(!passed.messages[3].content.includes("fake-private-password"), "redaction still runs");
  assert.ok(!states.slice(before).some((s) => s.includes("model text") || s === notice));

  // 4. Session override to log: hits are recorded in the background, nothing blocks.
  // 4. 会话覆盖为记录：命中在后台记录，不阻断任何内容。
  const command = runner.getCommand("protecter")!;
  const commandCtx = runner.createCommandContext();
  await command.handler("detect log", commandCtx);
  assert.equal(statuses.get("protecter-detect"), "System One · log");
  assert.equal((await runner.emitInput("another SECRET value", undefined, "interactive")).action, "continue");
  await new Promise((done) => setTimeout(done, 200));
  assert.ok(notices.some((n) => n.includes("your message matched credential 97%; recorded")));

  // 5. Unavailable service with a blocking rule: onError "block" fails closed.
  // 5. 服务不可用且存在阻断规则：onError 为 "block" 时失败即阻断。
  await command.handler("detect block", commandCtx);
  up = false;
  assert.deepEqual(await runner.emitInput("brand new text never seen", undefined, "interactive"), { action: "handled" });
  assert.ok(notices.some((n) => n.includes("could not check your message") && /DETECT_(HTTP|UNAVAILABLE)/.test(n)));
  up = true;

  // 6. Off: no calls at all. / 关闭：不发起任何调用。
  await command.handler("detect off", commandCtx);
  const count = states.length;
  assert.equal((await runner.emitInput("SECRET while off", undefined, "interactive")).action, "continue");
  assert.equal(states.length, count);

  // 7. The detection log holds metadata only, and tools cannot read it.
  // 7. 检测日志仅含元数据，且工具无法读取。
  const logName = readdirSync(dir).find((name) => /^protecter\.[a-f0-9]{32}\.detections\.jsonl$/.test(name));
  assert.ok(logName);
  const raw = readFileSync(join(dir, logName!), "utf8");
  assert.ok(!raw.includes("SECRET"));
  assert.ok(raw.includes('"source":"tool:read"'));
  for (const input of [{ path: join(dir, logName!) }]) {
    const blocked = await runner.emitToolCall({ type: "tool_call", toolName: "read", toolCallId: "x", input });
    assert.equal(blocked?.block, true);
  }
  const bashBlocked = await runner.emitToolCall({
    type: "tool_call", toolName: "bash", toolCallId: "y", input: { command: `tail ${logName}` },
  });
  assert.equal(bashBlocked?.block, true);

  // 8. Commands: test reports every rule; logs and status render.
  // 8. 命令：test 输出每条规则；logs 与 status 可正常展示。
  notices.length = 0;
  await command.handler("detect test my SECRET", commandCtx);
  assert.ok(notices.some((n) => n.includes("● credential: 0.970") && n.includes("○ pii: 0.020")));
  await command.handler("detect status", commandCtx);
  assert.ok(notices.some((n) => n.includes("System One detection: off") && n.includes("credential≥0.8→block")));
  await command.handler("detect bogus", commandCtx);
  assert.ok(notices.at(-1)!.startsWith("Usage: /protecter detect"));
  await command.handler("status", commandCtx);
  assert.ok(notices.at(-1)!.includes("Content detection (System One): off; 2 rule(s)."));
});
