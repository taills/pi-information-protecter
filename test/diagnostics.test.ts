import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Protecter } from "../src/engine.ts";
import { diagnostic, failure, formatDiagnostic, sanitizeError, workerError } from "../src/diagnostics.ts";
import { type Rule } from "../src/config.ts";

async function fixture(t: { after(fn: () => void): void }, rules: Rule[], timeout = 2000) {
  const dir = fs.mkdtempSync(join(tmpdir(), "spi-diag-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(join(dir, "protecter.json"), JSON.stringify({ version: 1, sensitiveWords: rules }));
  const engine = new Protecter(dir, timeout, () => "a".repeat(32));
  t.after(() => engine.close());
  await engine.initialize();
  return { engine, dir };
}

/** Typed rejection helper; a success is reported instead of throwing. / 类型安全的失败获取器，成功时返回可断言的标记。 */
function errorOf(action: Promise<unknown>): Promise<Error> {
  return action.then(
    () => new Error("expected failure but succeeded / 预期失败但成功"),
    (error) => error as Error,
  );
}

async function codeOf(action: Promise<unknown>) {
  const error = await errorOf(action);
  if (error.message.includes("expected failure but succeeded")) return "NO_ERROR";
  return error.message.match(/code=([A-Z_]+)/)?.[1] ?? "UNPARSED";
}

test("diagnostics expose code, stage and action without free text / 诊断输出错误码、阶段和建议且不含自由文本", () => {
  const text = formatDiagnostic(diagnostic("SCAN_TIMEOUT", { timeoutMs: 2000 }));
  assert.ok(text.includes("code=SCAN_TIMEOUT"));
  assert.ok(text.includes("stage=scan"));
  assert.ok(text.includes("timeoutMs=2000"));
  assert.ok(text.includes("Action / 处理:"));
  assert.ok(text.includes("/protecter status"));
});

test("only safe coordinates and known errno survive / 仅保留安全定位与已知错误码", () => {
  const value = diagnostic("AUDIT_IO", {
    rule: 3,
    node: 7,
    bytes: 11,
    limit: 12,
    timeoutMs: 13,
    errno: "EACCES",
  });
  assert.equal(value.rule, 3);
  assert.equal(value.errno, "EACCES");
  const rejected = diagnostic("AUDIT_IO", {
    rule: -1,
    node: 1.5,
    bytes: Number.NaN,
    errno: "secret-path /home/user/protecter.json",
  } as never);
  assert.equal(rejected.rule, undefined);
  assert.equal(rejected.node, undefined);
  assert.equal(rejected.bytes, undefined);
  assert.equal(rejected.errno, undefined);
});

test("raw errors and worker payloads are sanitized / 原始错误与 worker 数据被净化", () => {
  const raw = Object.assign(new Error("secret value at /home/user/protecter.json"), { code: "EACCES" });
  const safe = sanitizeError(raw, "AUDIT_IO");
  assert.ok(!safe.message.includes("secret value"));
  assert.ok(!safe.message.includes("/home/user"));
  assert.ok(safe.message.includes("errno=EACCES"));
  const hostile = workerError({ code: "__proto__", rule: "3", note: "leak /tmp/secret" }, "SCAN_INTERNAL");
  assert.ok(hostile.message.includes("code=SCAN_INTERNAL"));
  assert.ok(!hostile.message.includes("leak"));
  assert.equal(hostile.diagnostic.rule, undefined);
  assert.equal(failure("INTERNAL").diagnostic.stage, "internal");
});

test("request stages report distinct codes / 请求各阶段报告不同错误码", async (t) => {
  const { engine } = await fixture(t, ["secret"]);
  assert.equal(await codeOf(engine.redact({ self: {} as never, ...{} })), "NO_ERROR");
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.equal(await codeOf(engine.redact(cyclic)), "PAYLOAD_JSON");
  assert.equal(await codeOf(engine.redact("x".repeat(8 * 1024 * 1024 + 1))), "PAYLOAD_SIZE");
  assert.equal(await codeOf(engine.redact({ type: "image", data: "secret" })), "SCAN_ATTACHMENT");
  assert.equal(await codeOf(engine.redact({ parts: [{ inlineData: { data: "secret" } }] })), "SCAN_ATTACHMENT");
  let deep: unknown = "secret";
  for (let i = 0; i < 90; i++) deep = [deep];
  assert.equal(await codeOf(engine.redact(deep)), "SCAN_COMPLEXITY");
});

test("scan timeout and mapping conflicts are identified with rule numbers / 超时与映射冲突给出规则编号", async (t) => {
  const slow = await fixture(t, [{ type: "regex", pattern: "(a+)+$" }], 150);
  assert.equal(await codeOf(slow.engine.redact("a".repeat(10000) + "!")), "SCAN_TIMEOUT");

  const zero = await fixture(t, ["safe", { type: "regex", pattern: "(?=x)" }]);
  const zeroError = await errorOf(zero.engine.redact("x"));
  assert.ok(zeroError.message.includes("code=SCAN_ZERO_WIDTH"));
  assert.ok(zeroError.message.includes("rule=2"));

  const overlap = await fixture(t, [{ type: "literal", value: "abc", replacement: "Alias" }, "bcde"]);
  const overlapError = await errorOf(overlap.engine.redact("abcde"));
  assert.ok(overlapError.message.includes("code=FIXED_OVERLAP"));
  assert.ok(overlapError.message.includes("rule=1"));
  assert.ok(overlapError.message.includes("otherRule=2"));

  const reused = await fixture(t, [{ type: "regex", pattern: "key-[0-9]+", replacement: "MyPrivateKey" }]);
  await reused.engine.redact("key-1");
  const reusedError = await errorOf(reused.engine.redact("key-2"));
  assert.ok(reusedError.message.includes("code=FIXED_ALIAS_REUSED"));
  assert.ok(!reusedError.message.includes("key-2"));
});

test("configuration failures name the stage and rule / 配置失败指出阶段与规则", async (t) => {
  const dir = fs.mkdtempSync(join(tmpdir(), "spi-diag-config-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const engine = new Protecter(dir, 2000, () => "a".repeat(32));
  t.after(() => engine.close());
  const path = join(dir, "protecter.json");

  fs.writeFileSync(path, "{broken");
  assert.equal(await codeOf(engine.initialize()), "CONFIG_JSON");
  // A blocked request reuses the initialization cause. / 被拦截的请求复用初始化原因。
  assert.equal(await codeOf(engine.redact("anything")), "CONFIG_JSON");
  assert.ok(engine.lastDiagnosticText!.includes("code=CONFIG_JSON"));

  fs.writeFileSync(path, JSON.stringify({ version: 2, sensitiveWords: [] }));
  assert.equal(await codeOf(engine.initialize()), "CONFIG_SCHEMA");

  fs.writeFileSync(path, JSON.stringify({ version: 1, sensitiveWords: [{ type: "regex", pattern: ".*" }] }));
  assert.equal(await codeOf(engine.initialize()), "CONFIG_EMPTY_MATCH");

  fs.writeFileSync(path, JSON.stringify({ version: 1, sensitiveWords: [{ type: "literal", value: "secret", replacement: "secret-copy" }] }));
  assert.equal(await codeOf(engine.initialize()), "CONFIG_SENSITIVE_TARGET");

  fs.writeFileSync(path, JSON.stringify({ version: 1, sensitiveWords: [{ type: "literal", value: "one", replacement: "Alias" }, { type: "literal", value: "two", replacement: "AliasLong" }] }));
  const aliasCode = await codeOf(engine.initialize());
  assert.equal(aliasCode, "CONFIG_ALIAS_CONFLICT");

  fs.writeFileSync(path, JSON.stringify({ version: 1, sensitiveWords: ["ok"] }));
  await engine.initialize();
  assert.equal(engine.lastDiagnostic, undefined);
});

test("audit failures identify the audit stage / 审计失败指出审计阶段", async (t) => {
  const { engine } = await fixture(t, ["secret"]);
  fs.mkdirSync(engine.auditPath);
  const error = await errorOf(engine.redact("secret"));
  assert.ok(error.message.includes("stage=audit"));
  assert.ok(!error.message.includes("secret"));
  assert.ok(!error.message.includes(engine.auditPath));
  fs.rmdirSync(engine.auditPath);

  fs.writeFileSync(engine.auditPath, "partial-line-without-newline");
  assert.equal(await codeOf(engine.redact("secret")), "AUDIT_PARTIAL");
  fs.truncateSync(engine.auditPath, 0);
  fs.mkdirSync(`${engine.auditPath}.lock`);
  assert.equal(await codeOf(engine.redact("secret")), "AUDIT_LOCKED");
  fs.rmdirSync(`${engine.auditPath}.lock`);
  await engine.redact("secret");
  assert.equal(engine.auditRecords().records.length, 1);
});

test("closed instances and machine failures stay explainable / 关闭实例与机器标识失败仍可解释", async (t) => {
  const { engine } = await fixture(t, ["secret"]);
  engine.close();
  assert.equal(await codeOf(engine.redact("secret")), "NOT_READY");

  const dir = fs.mkdtempSync(join(tmpdir(), "spi-diag-machine-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const broken = new Protecter(dir, 2000, () => {
    throw new Error("ioreg unavailable at /usr/sbin/ioreg");
  });
  t.after(() => broken.close());
  const error = await errorOf(broken.initialize());
  assert.ok(error.message.includes("code=MACHINE_ID"));
  assert.ok(!error.message.includes("/usr/sbin/ioreg"));
});
