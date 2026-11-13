import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Detector } from "../src/detector/detector.ts";
import { evaluateNoul, probeService } from "../src/detector/client.ts";
import {
  detectionSettings,
  isLoopbackEndpoint,
  mergeDetection,
  validateDetection,
  type DetectionConfig,
} from "../src/detector/settings.ts";
import { chunkText, payloadUnits } from "../src/detector/units.ts";
import { appendDetection, readDetections } from "../src/detector/log.ts";
import { parseConfig } from "../src/config.ts";
import { mergeConfigs } from "../src/migration.ts";
import { ProtectionError } from "../src/diagnostics.ts";

type Body = { state: string; images?: string[]; questions: Record<string, { type: string; instructions: string }> };

/**
 * Fake System One: `decide(rule, body)` returns the yes-probability.
 * Records peak concurrency so tests can prove rules run in parallel.
 * 模拟 System One：记录并发峰值，用于证明规则并行执行。
 */
function fakeService(
  decide: (rule: string, body: Body) => number | Response | Promise<number | Response>,
  delayMs = 20,
) {
  const state = { calls: [] as Array<{ rule: string; body: Body; auth?: string }>, inflight: 0, peak: 0 };
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Body;
    const rule = Object.keys(body.questions)[0];
    state.calls.push({ rule, body, auth: (init?.headers as Record<string, string>)?.Authorization });
    state.inflight++;
    state.peak = Math.max(state.peak, state.inflight);
    try {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      const decided = await decide(rule, body);
      if (decided instanceof Response) return decided;
      return new Response(
        JSON.stringify({ model: "m", answers: { [rule]: { type: "noul", noul: decided } }, usage: { input_tokens: 1, output_tokens: 0 } }),
        { status: 200 },
      );
    } finally {
      state.inflight--;
    }
  }) as typeof fetch;
  return { state, fetchImpl };
}

// The shipped example is the source of the rules under test, so it must load.
// 测试所用规则取自随包示例，因此示例本身必须可加载。
const example = parseConfig(readFileSync("protecter.example.json", "utf8"));
const RULES = example.detection!.rules;
// The example rules with their own actions removed, so the global action decides.
// 去掉各自动作的示例规则，由全局动作决定。
const LOG_RULES = RULES.map(({ action: _action, ...rule }) => rule);
const ENDPOINT = "http://127.0.0.1:9/v1/systemone";
const settings = (overrides: Partial<DetectionConfig> & { concurrency?: number } = {}) => {
  const { concurrency, ...rest } = overrides;
  return detectionSettings({
    model: { endpoint: ENDPOINT, ...(concurrency ? { concurrency } : {}) },
    rules: LOG_RULES,
    ...rest,
  });
};

test("settings validation, merging and the shipped example / 配置校验、合并与随包示例", () => {
  // Nothing is built in: no section, no detection. / 无内置项：没有配置即不检测。
  const absent = detectionSettings(undefined);
  assert.equal(absent.configured, false);
  assert.equal(absent.enabled, false);
  assert.deepEqual(absent.rules, []);
  // The example ships disabled, with a loopback model service and five rules.
  // 示例默认关闭，使用回环地址的模型服务，包含五条规则。
  const shipped = detectionSettings(example.detection);
  assert.equal(shipped.configured, true);
  assert.equal(shipped.enabled, false);
  assert.ok(isLoopbackEndpoint(shipped.endpoint));
  assert.equal(shipped.apiKeyEnv, "PI_PROTECTER_SYSTEMONE_KEY");
  assert.deepEqual(shipped.rules.map((rule) => rule.id), ["credential", "pii", "id-document", "internal", "business"]);
  assert.equal(shipped.rules.find((rule) => rule.id === "business")!.images, false);
  const defaults = detectionSettings({ model: { endpoint: ENDPOINT }, rules: [] });
  assert.equal(defaults.enabled, true);
  assert.equal(defaults.action, "log");
  assert.equal(defaults.onError, "block");
  assert.equal(defaults.concurrency, 4);
  assert.ok(isLoopbackEndpoint("http://[::1]:8080/v1/systemone"));
  assert.ok(!isLoopbackEndpoint("http://10.100.0.152:38083/v1/systemone"));
  validateDetection({ model: { endpoint: "https://example.test/v1/systemone", name: "m" }, rules: [{ id: "a", instructions: "x", threshold: 0.5, action: "block" }] });
  const model = { endpoint: ENDPOINT };
  const rejects = [
    null,
    { model, rules: [], unknown: 1 },
    { rules: [] },
    { model },
    { model: { endpoint: "ftp://x" }, rules: [] },
    { model: { endpoint: "http://user:pw@host/" }, rules: [] },
    { model: { endpoint: "http://host/v1/systemone?key=secret" }, rules: [] },
    { model: { ...model, concurrency: 0 }, rules: [] },
    { model: { ...model, apiKeyEnv: "not valid" }, rules: [] },
    { model: { ...model, other: 1 }, rules: [] },
    { model, rules: [], action: "ask" },
    { model, rules: [], onError: "maybe" },
    { model, rules: [], targets: { other: true } },
    { model, rules: [{ id: "a", instructions: "" }] },
    { model, rules: [{ id: "a", instructions: "x" }, { id: "a", instructions: "y" }] },
    { model, rules: [{ id: "a", instructions: "x", threshold: 0 }] },
  ];
  for (const value of rejects)
    assert.throws(() => validateDetection(value), (error: ProtectionError) => error.diagnostic.code === "CONFIG_DETECTION");
  // Wired into the config parser. / 已接入配置解析。
  assert.throws(
    () => parseConfig(JSON.stringify({ version: 1, sensitiveWords: [], detection: { model, rules: [], action: "x" } })),
    (error: ProtectionError) => error.diagnostic.code === "CONFIG_DETECTION",
  );

  // Merging follows the other settings. / 合并方式与其他设置一致。
  const a: DetectionConfig = { model: { endpoint: ENDPOINT, concurrency: 2 }, action: "log", onError: "allow", rules: [{ id: "x", instructions: "x?" }] };
  const b: DetectionConfig = { model: { endpoint: "http://127.0.0.1:7/v1/systemone" }, action: "block", rules: [{ id: "x", instructions: "x?" }, { id: "y", instructions: "y?" }] };
  const merged = mergeDetection([a, b])!;
  assert.equal(merged.model.endpoint, ENDPOINT, "service from the machine file");
  assert.equal(merged.model.concurrency, 2);
  assert.deepEqual(merged.rules.map((rule) => rule.id), ["x", "y"], "rules combined, duplicates once");
  assert.equal(merged.action, "block", "stricter action wins");
  assert.equal(merged.onError, "allow", "only present values compete");
  assert.equal(mergeDetection([{ ...a, enabled: false }, b])!.enabled, undefined, "enabled if any file enables");
  assert.equal(mergeDetection([{ ...a, enabled: false }])!.enabled, false);
  assert.equal(mergeDetection([]), undefined);
  // Through migration: the merged machine file holds both rule sets, and one
  // rule ID with two definitions is rejected like a conflicting sensitive word.
  // 经由迁移：合并后的机器文件包含两组规则；同一规则 ID 有两种定义时像冲突的敏感词一样被拒绝。
  const viaMigration = mergeConfigs([
    { version: 1, sensitiveWords: [], detection: a },
    { version: 1, sensitiveWords: [], detection: b },
  ]);
  assert.deepEqual(viaMigration.detection?.rules.map((rule) => rule.id), ["x", "y"]);
  assert.throws(
    () =>
      mergeConfigs([
        { version: 1, sensitiveWords: [], detection: a },
        { version: 1, sensitiveWords: [], detection: { ...b, rules: [{ id: "x", instructions: "different" }] } },
      ]),
    (error: ProtectionError) => error.diagnostic.code === "CONFIG_DETECTION",
  );
});

test("chunking and payload extraction / 分段与请求体提取", () => {
  assert.deepEqual(chunkText("ab", 100, 4).chunks, []);
  const text = "x".repeat(950);
  const { chunks, truncated } = chunkText(text, 400, 8);
  assert.ok(!truncated);
  assert.ok(chunks.every((chunk) => chunk.length <= 400));
  assert.equal(chunks.join("").length >= text.length, true);
  assert.ok(chunkText("y".repeat(5000), 400, 2).truncated);
  const units = payloadUnits({
    model: "m",
    system: "system prompt with AGENTS.md content",
    tools: [{ name: "read", description: "tool declaration is skipped" }],
    messages: [
      { role: "user", content: [{ type: "text", text: "user secret text" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }] },
      { role: "assistant", content: [{ type: "text", text: "model output is skipped" }] },
      { role: "tool", content: "tool output text" },
    ],
  });
  assert.deepEqual(units.texts.sort(), ["system prompt with AGENTS.md content", "tool output text", "user secret text"]);
  assert.equal(units.images.length, 1);
});

test("rules run in parallel, not one after another / 规则并行而非串行", async () => {
  const { state, fetchImpl } = fakeService(() => 0.01, 50);
  const detector = new Detector(settings({ concurrency: 16 }), { fetch: fetchImpl });
  const started = Date.now();
  const report = await detector.scan({ texts: ["first text to check", "second text to check"], images: [] });
  const elapsed = Date.now() - started;
  assert.equal(state.calls.length, 2 * RULES.length);
  // Every (unit, rule) request was in flight together. / 所有（单元，规则）请求同时在途。
  assert.equal(state.peak, 2 * RULES.length);
  assert.ok(elapsed < 50 * 3, `parallel scan took ${elapsed} ms`);
  assert.deepEqual(report.hits, []);
  assert.equal(report.block, false);
  // The concurrency bound holds. / 并发上限生效。
  const bounded = fakeService(() => 0.01, 20);
  await new Detector(settings({ concurrency: 2 }), { fetch: bounded.fetchImpl }).scan({ texts: ["bounded text"], images: [] });
  assert.equal(bounded.state.peak, 2);
});

test("hits, actions, caching and early stop / 命中、动作、缓存与提前结束", async () => {
  const { state, fetchImpl } = fakeService((rule, body) => (rule === "credential" && body.state.includes("P@ss") ? 0.97 : 0.02));
  const detector = new Detector(settings(), { fetch: fetchImpl });
  const report = await detector.scan({ texts: ["db password P@ssw0rd!"], images: [] });
  assert.deepEqual(report.hits.map((hit) => [hit.rule, hit.action, hit.kind]), [["credential", "log", "text"]]);
  assert.equal(report.block, false);
  assert.ok(!detector.enforcing);
  // The same text is served from cache. / 相同文本命中缓存。
  const calls = state.calls.length;
  const again = await detector.scan({ texts: ["db password P@ssw0rd!"], images: [] });
  assert.equal(state.calls.length, calls);
  assert.equal(again.cached, RULES.length);
  assert.equal(again.hits.length, 1);
  // Session override to block. / 会话覆盖为阻断。
  detector.override.action = "block";
  assert.ok(detector.enforcing);
  const blocked = await detector.scan({ texts: ["db password P@ssw0rd!"], images: [] });
  assert.equal(blocked.block, true);

  // Concurrent scans share in-flight requests. / 并发扫描共享在途请求。
  const shared = fakeService(() => 0.01, 30);
  const sharing = new Detector(settings(), { fetch: shared.fetchImpl });
  await Promise.all([
    sharing.scan({ texts: ["shared text"], images: [] }),
    sharing.scan({ texts: ["shared text"], images: [] }),
  ]);
  assert.equal(shared.state.calls.length, RULES.length);

  // A block hit stops waiting for slower rules. / 阻断命中后不再等待更慢的规则。
  const slow = fakeService(async (rule) => {
    if (rule === "credential") return 0.99;
    await new Promise((resolve) => setTimeout(resolve, 400));
    return 0.01;
  }, 5);
  const fast = new Detector(settings({ rules: [
    { id: "credential", instructions: "c", action: "block" },
    { id: "slow", instructions: "s" },
  ] }), { fetch: slow.fetchImpl });
  const t0 = Date.now();
  const early = await fast.scan({ texts: ["token abcdef"], images: [] });
  assert.equal(early.block, true);
  assert.ok(Date.now() - t0 < 300);
});

test("errors follow onError only for blocking rules / 错误仅在阻断规则下遵循 onError", async () => {
  const down = (async () => {
    throw new TypeError("fetch failed");
  }) as unknown as typeof fetch;
  const logOnly = await new Detector(settings(), { fetch: down }).scan({ texts: ["some text"], images: [] });
  assert.equal(logOnly.block, false);
  assert.deepEqual(logOnly.errors.map((e) => e.code), ["DETECT_UNAVAILABLE"]);

  const enforced = new Detector(settings({ action: "block" }), { fetch: down });
  assert.equal((await enforced.scan({ texts: ["some text"], images: [] })).block, true);
  // The breaker opens after repeated failures. / 多次失败后熔断。
  assert.equal(enforced.available, false);
  const allow = await new Detector(settings({ action: "block", onError: "allow" }), { fetch: down }).scan({ texts: ["some text"], images: [] });
  assert.equal(allow.block, false);
  assert.equal(allow.errors.length, 1);

  // A boolean noul is invalid; 400 is not retried; 500 is retried once.
  // 布尔值 noul 无效；400 不重试；500 重试一次。
  const bad = fakeService(() => new Response(JSON.stringify({ answers: { credential: { type: "noul", noul: true } } })));
  const one = settings({ rules: [{ id: "credential", instructions: "c" }] });
  assert.deepEqual((await new Detector(one, { fetch: bad.fetchImpl }).scan({ texts: ["text"], images: [] })).errors.map((e) => e.code), ["DETECT_RESPONSE"]);
  const r400 = fakeService(() => new Response("{}", { status: 400 }));
  const report400 = await new Detector(one, { fetch: r400.fetchImpl }).scan({ texts: ["text"], images: [] });
  assert.equal(report400.errors[0].status, 400);
  assert.equal(r400.state.calls.length, 1);
  let attempts = 0;
  const flaky = fakeService(() => (++attempts === 1 ? new Response("{}", { status: 503 }) : 0.9));
  const recovered = await new Detector(one, { fetch: flaky.fetchImpl }).scan({ texts: ["text"], images: [] });
  assert.equal(recovered.hits.length, 1);
  assert.equal(flaky.state.calls.length, 2);
});

test("images are checked; unsupported images are errors / 检测图片；不支持的图片按错误处理", async () => {
  const { state, fetchImpl } = fakeService((_rule, body) => (body.images?.length ? 0.95 : 0.01));
  const detector = new Detector(settings({ action: "block" }), { fetch: fetchImpl });
  const report = await detector.scan({ texts: [], images: [{ kind: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }] });
  assert.equal(report.block, true);
  assert.equal(report.hits[0].kind, "image");
  assert.ok(state.calls[0].body.images?.[0].startsWith("data:image/png;base64,"));
  const gif = await detector.scan({ texts: [], images: [{ kind: "image", data: "R0lGOD==", mimeType: "image/gif" }] });
  assert.deepEqual(gif.errors.map((e) => e.code), ["DETECT_IMAGE"]);
  assert.equal(gif.block, true);
  const noImages = new Detector(settings({ images: false }), { fetch: fetchImpl });
  const before = state.calls.length;
  await noImages.scan({ texts: [], images: [{ kind: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }] });
  assert.equal(state.calls.length, before);
});

test("HTTP client against a real server / 真实 HTTP 服务端", async (t) => {
  let seen: { auth?: string; body?: Body; path?: string } = {};
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      if (req.method === "GET") {
        const bodies: Record<string, unknown> = {
          "/health": { status: "ok" },
          "/props": { modalities: { vision: true }, total_slots: 2, default_generation_settings: { n_ctx: 16384 } },
          "/v1/models": { data: [{ id: "/models/Clef-Flash-Q8_0.gguf" }] },
        };
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(bodies[req.url ?? ""] ?? {}));
        return;
      }
      seen = { auth: req.headers.authorization, body: JSON.parse(raw), path: req.url };
      res.writeHead(200, { "Content-Type": "application/json" }).end(
        JSON.stringify({ answers: { leak: { type: "noul", noul: 0.42 } }, usage: { input_tokens: 9, output_tokens: 0 } }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/systemone`;
  const answers = await evaluateNoul(
    { state: "hello", questions: { leak: { type: "noul", instructions: "leak?" } } },
    { endpoint, apiKey: "k-123", timeoutMs: 5000 },
  );
  assert.deepEqual(answers, { leak: 0.42 });
  assert.equal(seen.auth, "Bearer k-123");
  assert.equal(seen.path, "/v1/systemone");
  // No chat-completion fields are sent. / 不发送聊天补全字段。
  assert.deepEqual(Object.keys(seen.body ?? {}).sort(), ["questions", "state"]);
  const info = await probeService({ endpoint, timeoutMs: 5000 });
  assert.deepEqual(info, { healthy: true, model: "/models/Clef-Flash-Q8_0.gguf", vision: true, contextTokens: 16384, slots: 2 });
  await assert.rejects(
    evaluateNoul({ state: "x", questions: { leak: { type: "noul", instructions: "?" } } }, { endpoint: "http://127.0.0.1:1/v1/systemone", timeoutMs: 2000 }),
    (error: ProtectionError) => error.diagnostic.code === "DETECT_UNAVAILABLE",
  );
});

test("detection log holds no content / 检测日志不含原文", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "spi-detect-log-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "protecter.0123456789abcdef0123456789abcdef.detections.jsonl");
  const { fetchImpl } = fakeService(() => 0.99);
  const report = await new Detector(settings(), { fetch: fetchImpl }).scan({ texts: ["password hunter2-secret"], images: [] });
  assert.ok(appendDetection(path, "input", "hash", report));
  const raw = readFileSync(path, "utf8");
  assert.ok(!raw.includes("hunter2"));
  if (process.platform !== "win32") assert.equal(statSync(path).mode & 0o777, 0o600);
  const [record] = readDetections(path);
  assert.equal(record.source, "input");
  assert.equal(record.hits.length, RULES.length);
});
