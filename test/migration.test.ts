import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { machineHash } from "../src/machine.ts";
import { migrateConfig } from "../src/migration.ts";
import { type Rule } from "../src/config.ts";

const A = "a".repeat(32), B = "b".repeat(32), C = "c".repeat(32);
function fixture(t: { after(fn: () => void): void }) {
  const dir = fs.mkdtempSync(join(tmpdir(), "spi-migrate-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const put = (name: string, sensitiveWords: Rule[]) => fs.writeFileSync(join(dir, name), JSON.stringify({ version: 1, sensitiveWords }));
  return { dir, put };
}

test("machine hash stable and domain separated / 机器哈希稳定且隔离", () => {
  const id = "12345678-1234-1234-1234-123456789abc";
  assert.equal(machineHash(id), machineHash(id.toUpperCase().replaceAll("-", "")));
  assert.match(machineHash(id), /^[a-f0-9]{32}$/);
  assert.throws(() => machineHash(""));
  assert.throws(() => machineHash("0".repeat(32)));
});

test("merge legacy and multiple files, preserve semantics / 合并旧配置且保留语义", async t => {
  const { dir, put } = fixture(t);
  put(`protecter.${A}.json`, ["same", " spaced ", { type: "regex", pattern: "secret", flags: "ig" }]);
  put("protecter.json", [{ type: "literal", value: "same" }, " spaced", { type: "regex", pattern: "secret", flags: "i" }]);
  put(`protecter.${B}.json`, ["other", { type: "regex", pattern: "secret" }]);
  put("protecter.example.json", ["unrelated"]);
  const snapshot = await migrateConfig(dir, A);
  assert.equal(snapshot.migrated, 2);
  assert.equal(snapshot.config.sensitiveWords.length, 6);
  assert.deepEqual(fs.readdirSync(dir).sort(), [`protecter.${A}.json`, "protecter.example.json"].sort());
  if (process.platform !== "win32") assert.equal(fs.statSync(snapshot.path).mode & 0o777, 0o600);
  assert.deepEqual((await migrateConfig(dir, A)).config, snapshot.config);
  const changed = await migrateConfig(dir, C);
  assert.deepEqual(changed.config, snapshot.config);
  assert.ok(!fs.existsSync(snapshot.path));
});

test("invalid source or target preserves every original / 无效文件不删除任何原配置", async t => {
  const { dir, put } = fixture(t);
  put("protecter.json", ["old"]);
  const target = join(dir, `protecter.${A}.json`);
  for (const raw of ["bad", '{"version":2,"sensitiveWords":[]}', '{"version":1,"sensitiveWords":[{"type":"regex","pattern":".*"}]}']) {
    fs.writeFileSync(target, raw);
    await assert.rejects(migrateConfig(dir, A));
    assert.equal(fs.readFileSync(target, "utf8"), raw);
    assert.ok(fs.existsSync(join(dir, "protecter.json")));
  }
});

test("merged overflow and unsafe links rejected / 拒绝合并超限和不安全链接", async t => {
  const { dir, put } = fixture(t);
  put("protecter.json", Array.from({ length: 600 }, (_, i) => `old-${i}`));
  put(`protecter.${B}.json`, Array.from({ length: 600 }, (_, i) => `new-${i}`));
  await assert.rejects(migrateConfig(dir, A));
  assert.ok(!fs.existsSync(join(dir, `protecter.${A}.json`)));
  fs.rmSync(join(dir, `protecter.${B}.json`));
  fs.symlinkSync(join(dir, "protecter.json"), join(dir, `protecter.${B}.json`));
  await assert.rejects(migrateConfig(dir, A));
});

test("concurrent initialization creates one config / 并发初始化仅产生一份配置", async t => {
  const { dir } = fixture(t);
  const snapshots = await Promise.all(Array.from({ length: 6 }, () => migrateConfig(dir, A)));
  assert.ok(snapshots.every(s => s.path === snapshots[0].path));
  assert.deepEqual(fs.readdirSync(dir), [`protecter.${A}.json`]);
});

test("independent processes share directory lock / 独立进程共享目录锁", async t => {
  const { dir, put } = fixture(t);
  put("protecter.json", ["secret"]);
  const code = `import { migrateConfig } from ${JSON.stringify(pathToFileURL(resolve("src/migration.ts")).href)}; await migrateConfig(${JSON.stringify(dir)}, ${JSON.stringify(A)});`;
  await Promise.all(Array.from({ length: 3 }, () => promisify(execFile)(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code])));
  assert.deepEqual(fs.readdirSync(dir), [`protecter.${A}.json`]);
});

test("precommit failure cleans temporary file / 提交前失败清理临时文件", async t => {
  const { dir, put } = fixture(t);
  put("protecter.json", ["secret"]);
  await assert.rejects(migrateConfig(dir, A, { checkpoint(stage) { if (stage === "beforeCommit") throw new Error("disk failure / 磁盘故障"); } }));
  assert.deepEqual(fs.readdirSync(dir), ["protecter.json"]);
});

test("precommit edit is retained, no new target / 提交前修改保留且不创建目标", async t => {
  const { dir, put } = fixture(t);
  put("protecter.json", ["old"]);
  await assert.rejects(migrateConfig(dir, A, { checkpoint(stage) { if (stage === "beforeCommit") put("protecter.json", ["edited"]); } }));
  assert.ok(!fs.existsSync(join(dir, `protecter.${A}.json`)));
  assert.match(fs.readFileSync(join(dir, "protecter.json"), "utf8"), /edited/);
});

test("postcommit failure and partial deletion recover / 提交后失败及部分删除可恢复", async t => {
  const { dir, put } = fixture(t);
  put("protecter.json", ["old"]);
  put(`protecter.${B}.json`, ["second"]);
  await assert.rejects(migrateConfig(dir, A, { checkpoint(stage) { if (stage === "afterCommit") throw new Error("injected / 注入故障"); } }));
  assert.ok(fs.existsSync(join(dir, "protecter.json")));
  let deletes = 0;
  await assert.rejects(migrateConfig(dir, A, { checkpoint(stage) { if (stage === "beforeDelete" && ++deletes === 2) throw new Error("injected / 注入故障"); } }));
  const result = await migrateConfig(dir, A);
  assert.equal(result.config.sensitiveWords.length, 2);
  assert.deepEqual(fs.readdirSync(dir), [`protecter.${A}.json`]);
});

test("source edited before deletion is never deleted / 删除前被修改的来源不删除", async t => {
  const { dir, put } = fixture(t);
  put("protecter.json", ["old"]);
  await assert.rejects(migrateConfig(dir, A, { checkpoint(stage) { if (stage === "beforeDelete") put("protecter.json", ["new"]); } }));
  assert.ok(fs.existsSync(join(dir, "protecter.json")));
  assert.deepEqual((await migrateConfig(dir, A)).config.sensitiveWords, ["old", "new"]);
});

test("stale lock fails bounded, preserves files / 残留锁限时失败并保留文件", async t => {
  const { dir, put } = fixture(t);
  put("protecter.json", ["old"]);
  fs.mkdirSync(join(dir, ".protecter-migration.lock"));
  await assert.rejects(migrateConfig(dir, A, { lockTimeoutMs: 10 }));
  assert.ok(fs.existsSync(join(dir, "protecter.json")));
});
