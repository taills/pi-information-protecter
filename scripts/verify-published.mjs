/**
 * Assert that a version-level registry document really describes this release.
 * 校验版本级 registry 文档确实对应本次发布。
 *
 * The publish step is not what fails in practice; the read path is. `npm view`
 * reads the whole packument, which a CDN edge can serve stale for longer than
 * the publish takes, so the workflow fetches
 * `https://registry.npmjs.org/<name>/<version>` with caching disabled and
 * checks the result here, where a wrong name, version or missing tarball is a
 * hard failure rather than a log line.
 * 实际失败的不是发布而是读取端。`npm view` 读取整份 packument，CDN 边缘缓存可能比发布
 * 本身更持久，因此工作流改为禁用缓存地获取
 * `https://registry.npmjs.org/<name>/<version>` 并在此校验：名称、版本不符或缺少
 * tarball 一律视为硬失败，而不是一行日志。
 */
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const [documentPath] = process.argv.slice(2);
assert.ok(documentPath, "usage: node scripts/verify-published.mjs <file>");

/**
 * A truncated or HTML error body must fail with a readable reason, not a bare
 * SyntaxError: the verification result is what a release decision is based on.
 * 被截断的响应或 HTML 错误页必须以可读原因失败，而不是裸的 SyntaxError：
 * 发布决策正是以该校验结果为依据。
 */
function readJson(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    assert.fail(`cannot read ${path}: ${error.code ?? error.name}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    assert.fail(`${path} is not valid JSON (${text.length} bytes)`);
  }
}

const local = readJson("package.json");
const published = readJson(documentPath);

assert.equal(published.name, local.name, "registry name must match");
assert.equal(published.version, local.version, "registry version must match");
assert.equal(
  typeof published.dist?.integrity,
  "string",
  "registry document must carry dist.integrity",
);
assert.equal(
  typeof published.dist?.tarball,
  "string",
  "registry document must carry dist.tarball",
);

console.log(`${published.name}@${published.version}`);
console.log(published.dist.integrity);
console.log(published.dist.tarball);
