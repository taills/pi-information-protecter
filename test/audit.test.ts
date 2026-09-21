import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { appendAudit, clearAudit, readAudit, localTimestamp } from "../src/audit.ts";
import { Protecter } from "../src/engine.ts";
import { blocksConfigAccess } from "../src/guard.ts";

function fixture(t: { after(fn: () => void): void }) {
  const dir = fs.mkdtempSync(join(tmpdir(), "spi-audit-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, `protecter.${"a".repeat(32)}.jsonl`);
  return { dir, path };
}

test("timestamp, JSONL escaping, permissions and limits / 时间格式、转义、权限与读取限制", async (t) => {
  const { path } = fixture(t);
  assert.equal(
    localTimestamp(new Date(2026, 0, 2, 3, 4, 5)),
    "2026-01-02 03:04:05",
  );
  assert.deepEqual(readAudit(path), { records: [], truncated: false });
  await appendAudit(path, "demo-provider", [["token", 'secret\n"value\u001b']]);
  const lines = fs.readFileSync(path, "utf8").trim().split("\n");
  assert.equal(lines.length, 1);
  const r = JSON.parse(lines[0]);
  assert.match(r.time, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  assert.equal(r.original, 'secret\n"value\u001b');
  assert.equal(r.provider, "demo-provider");
  assert.equal(r.replacement, "token");
  if (process.platform !== "win32")
    assert.equal(fs.statSync(path).mode & 0o777, 0o600);
  assert.equal(readAudit(path, 1).records.length, 1);
  assert.throws(() => readAudit(path, 101));
});

test("concurrent batches remain valid JSONL / 并发批次保持合法 JSONL", async (t) => {
  const { path } = fixture(t);
  await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      appendAudit(path, "demo", [[`token-${i}`, `secret-${i}`]]),
    ),
  );
  const r = readAudit(path, 100);
  assert.equal(r.records.length, 8);
  assert.equal(new Set(r.records.map((v) => v.requestId)).size, 8);
  assert.equal(readAudit(path, 2).records.length, 2);
  assert.equal(readAudit(path, 2).truncated, true);
});

test("separate processes serialize audit batches / 独立进程串行写日志", async (t) => {
  const { path } = fixture(t);
  const code = `import { appendAudit } from ${JSON.stringify(pathToFileURL(resolve("src/audit.ts")).href)}; await appendAudit(${JSON.stringify(path)}, 'demo', [['t','secret']]);`;
  await Promise.all(
    Array.from({ length: 3 }, () =>
      promisify(execFile)(process.execPath, [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        code,
      ]),
    ),
  );
  assert.equal(readAudit(path).records.length, 3);
});

test("bounded tail skips malformed records / 有界尾部跳过损坏记录", async (t) => {
  const { path } = fixture(t);
  fs.writeFileSync(path, "x".repeat(1024 * 1024 + 10) + "\n");
  await appendAudit(path, "demo", [["t", "secret"]]);
  const result = readAudit(path);
  assert.equal(result.records.length, 1);
  assert.equal(result.truncated, true);
  fs.appendFileSync(path, "invalid-json\npartial");
  assert.equal(readAudit(path).truncated, true);
});

test("reject symlinks, hardlinks, partial lines and full logs / 拒绝链接、残行及满日志", async (t) => {
  const { dir, path } = fixture(t);
  const other = join(dir, "other");
  fs.writeFileSync(other, "private");
  fs.symlinkSync(other, path);
  await assert.rejects(appendAudit(path, "demo", [["t", "v"]]));
  assert.throws(() => readAudit(path));
  assert.equal(fs.readFileSync(other, "utf8"), "private");
  fs.unlinkSync(path);
  fs.linkSync(other, path);
  await assert.rejects(appendAudit(path, "demo", [["t", "v"]]));
  fs.unlinkSync(path);
  fs.writeFileSync(path, "partial");
  await assert.rejects(appendAudit(path, "demo", [["t", "v"]]));
  assert.equal(readAudit(path).truncated, true);
  fs.truncateSync(path, 32 * 1024 * 1024);
  await assert.rejects(appendAudit(path, "demo", [["t", "v"]]));
});

test("engine logs unique successful hits per request and fails closed / 每请求记录唯一成功命中且失败不放行", async (t) => {
  const { dir } = fixture(t);
  fs.writeFileSync(
    join(dir, "protecter.json"),
    JSON.stringify({ version: 1, sensitiveWords: ["secret"] }),
  );
  const engine = new Protecter(dir, 2000, () => "a".repeat(32));
  t.after(() => engine.close());
  await engine.initialize();
  await engine.redact("public", "demo");
  assert.ok(!fs.existsSync(engine.auditPath));
  const masked = await engine.redact("secret secret", "demo");
  const records = engine.auditRecords().records;
  assert.equal(records.length, 1);
  assert.equal(records[0].provider, "demo");
  assert.equal(records[0].original, "secret");
  assert.equal(masked, `${records[0].replacement} ${records[0].replacement}`);
  await engine.redact("secret", "second-provider");
  assert.equal(engine.auditRecords().records.length, 2);
  await engine.redact(records[0].replacement, "demo");
  await assert.rejects(
    engine.redact({ type: "image", data: "secret" }, "demo"),
  );
  assert.equal(engine.auditRecords().records.length, 2);
  fs.unlinkSync(engine.configPath);
  await engine.redact("secret", "demo");
  assert.equal(engine.auditRecords().records.length, 3);
  fs.unlinkSync(engine.auditPath);
  fs.mkdirSync(engine.auditPath);
  await assert.rejects(engine.redact("secret", "demo"));
});

test("clear log safely and resume writing / 安全清空后继续写入", async t => {
  const { dir, path } = fixture(t);
  assert.equal(await clearAudit(path), 0);
  assert.ok(!fs.existsSync(path));
  const other = join(dir, `protecter.${"b".repeat(32)}.jsonl`);
  fs.writeFileSync(other, "untouched");
  fs.writeFileSync(path, "broken-tail");
  const inode = fs.statSync(path).ino;
  assert.equal(await clearAudit(path), 11);
  assert.equal(fs.statSync(path).ino, inode);
  assert.equal(fs.readFileSync(path, "utf8"), "");
  assert.equal(fs.readFileSync(other, "utf8"), "untouched");
  if (process.platform !== "win32") assert.equal(fs.statSync(path).mode & 0o777, 0o600);
  fs.truncateSync(path, 32 * 1024 * 1024);
  assert.equal(await clearAudit(path), 32 * 1024 * 1024);
  await appendAudit(path, "demo", [["t", "value"]]);
  assert.equal(readAudit(path).records.length, 1);
});

test("clear rejects unsafe files and held locks / 清理拒绝危险文件及占用锁", async t => {
  const { dir, path } = fixture(t);
  const other = join(dir, "other");
  fs.writeFileSync(other, "untouched");
  fs.symlinkSync(other, path);
  await assert.rejects(clearAudit(path));
  fs.unlinkSync(path); fs.linkSync(other, path);
  await assert.rejects(clearAudit(path));
  fs.unlinkSync(path); fs.mkdirSync(path);
  await assert.rejects(clearAudit(path));
  fs.rmdirSync(path);
  fs.writeFileSync(path, "preserved");
  fs.mkdirSync(`${path}.lock`);
  await assert.rejects(clearAudit(path));
  assert.equal(fs.readFileSync(path, "utf8"), "preserved");
  assert.equal(fs.readFileSync(other, "utf8"), "untouched");
  assert.ok(fs.existsSync(`${path}.lock`));
});

test("clearing queues with scans and preserves mappings / 清空与扫描排队且保留映射", async t => {
  const { dir } = fixture(t);
  fs.writeFileSync(join(dir, "protecter.json"), JSON.stringify({ version: 1, sensitiveWords: ["secret"] }));
  const engine = new Protecter(dir, 2000, () => "a".repeat(32));
  t.after(() => engine.close());
  await engine.initialize();
  const config = fs.readFileSync(engine.configPath, "utf8");
  const first = engine.redact("secret");
  const clear = engine.clearAuditRecords();
  const second = engine.redact("secret");
  const [token, bytes, repeated] = await Promise.all([first, clear, second]);
  assert.ok(bytes > 0);
  assert.equal(token, repeated);
  assert.equal(engine.restoreText(token as string), "secret");
  assert.equal(engine.auditRecords().records.length, 1);
  assert.equal(fs.readFileSync(engine.configPath, "utf8"), config);
});

test("separate process clear waits for shared lock / 独立进程清理等待共享锁", async t => {
  const { path } = fixture(t);
  await appendAudit(path, "demo", [["t", "secret"]]);
  fs.mkdirSync(`${path}.lock`);
  const code = `import { clearAudit } from ${JSON.stringify(pathToFileURL(resolve("src/audit.ts")).href)}; await clearAudit(${JSON.stringify(path)});`;
  const child = promisify(execFile)(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code]);
  const release = new Promise<void>(resolveTimer => setTimeout(() => { fs.rmdirSync(`${path}.lock`); resolveTimer(); }, 250));
  await Promise.all([child, release]);
  assert.equal(fs.statSync(path).size, 0);
});

test("protect log paths and aliases without blocking documentation / 保护日志及别名但不拦截文档", async (t) => {
  const { dir, path } = fixture(t);
  await appendAudit(path, "demo", [["t", "v"]]);
  const config = path.replace(/\.jsonl$/, ".json");
  const alias = join(dir, "alias");
  fs.linkSync(path, alias);
  for (const candidate of [path, alias, `${path}.lock`])
    assert.equal(
      blocksConfigAccess("read", { path: candidate }, dir, config),
      true,
    );
  assert.equal(
    blocksConfigAccess("bash", { command: `cat ${path}` }, dir, config),
    true,
  );
  assert.equal(
    blocksConfigAccess(
      "write",
      { path: "README.md", content: path },
      dir,
      config,
    ),
    false,
  );
});
