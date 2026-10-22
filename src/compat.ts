/**
 * Compatibility is decided by what this Pi build actually exposes, not by a
 * version allowlist: a new Pi release must keep working, and only a missing
 * capability may stop the extension.
 * 兼容性由当前 Pi 构建实际暴露的能力决定，而不是版本白名单：Pi 升级后扩展应继续可用，
 * 只有缺失能力才允许阻止扩展运行。
 *
 * Two things make this safe to do without pinning versions:
 * 不固定版本仍然安全，依赖两点：
 * - Every capability below is probed at session start and the extension fails
 *   closed when one is missing, so a renamed registration API blocks requests
 *   instead of silently passing plaintext.
 *   下列能力在会话启动时逐项探测，缺失即失败拦截，因此注册接口被改名会拦截请求，
 *   而不是静默放行明文。
 * - The model-runtime guard verifies, per call, that Pi really ran the request
 *   hook; if it did not, the guard redacts that call itself (see guard-runtime).
 *   模型运行时闸门会按次校验 Pi 是否真的执行了请求钩子；若未执行，则由闸门自行脱敏
 *   （见 guard-runtime）。
 *
 * - 0.83.0 and earlier lack `registerMarkdownTransformer`, so the probe refuses
 *   them without needing to know their version numbers.
 *   0.83.0 及更早缺少 `registerMarkdownTransformer`，探测会直接拒绝，无需知道版本号。
 * - 0.85.0 ships `dist/experimental/server.js` importing `@earendil-works/pi-server`,
 *   which no Pi release declares, so Pi itself fails to load before this runs.
 *   0.85.0 的 `dist/experimental/server.js` 引用任何 Pi 版本都未声明的
 *   `@earendil-works/pi-server`，Pi 自身在此之前就加载失败。
 */

/** Where a user must report a Pi build this extension refuses. / 被拒绝的 Pi 构建应在此反馈。 */
export const ISSUE_URL =
  "https://github.com/taills/pi-information-protecter/issues/new";

/**
 * Releases the full suite was run against. Newer releases are not refused; they
 * are announced once, because the capability probe, not this list, is the gate.
 * 已运行完整测试的版本。更高版本不会被拒绝，只提示一次，因为门禁是能力探测而非本清单。
 */
export const VERIFIED_PI = "0.84.0-0.84.x, 0.85.1-0.87.x, 0.99.x, 1.2.0-1.4.x";

/**
 * Capability names are fixed identifiers, never values read from a payload, so
 * they are safe to show to the user.
 * 能力名是固定标识，不来自任何请求内容，可安全展示给用户。
 */
export type Capability = string;

/** Registration APIs this extension cannot protect without. / 缺少这些注册接口即无法提供保护。 */
const REQUIRED_API = [
  "on",
  "registerCommand",
  "registerMarkdownTransformer",
] as const;

/**
 * Only the members the protection paths depend on. `waitForIdle`, `reload`,
 * `select`, `confirm` and `editor` belong to command UX: a missing one degrades
 * `/protecter`, it does not send plaintext, so it must not block protection.
 * 仅包含保护路径依赖的成员。`waitForIdle`、`reload`、`select`、`confirm`、`editor`
 * 属于命令交互：缺失只会削弱 `/protecter`，不会发送明文，因此不得拦截保护。
 */
const REQUIRED_CONTEXT = ["abort"] as const;
const REQUIRED_UI = ["notify", "setStatus"] as const;

function isFunction(host: unknown, name: string): boolean {
  if (!host || (typeof host !== "object" && typeof host !== "function"))
    return false;
  return typeof (host as Record<string, unknown>)[name] === "function";
}

/**
 * Probe one Pi build. An empty result means every capability this extension
 * depends on is present; anything listed must block the extension.
 * 探测当前 Pi 构建。返回空数组表示所依赖的能力齐备；一旦有项缺失即应阻止扩展。
 */
export function missingCapabilities(api: unknown, ctx?: unknown): Capability[] {
  const missing: Capability[] = [];
  for (const name of REQUIRED_API)
    if (!isFunction(api, name)) missing.push(`pi.${name}()`);
  if (ctx === undefined) return missing;
  const context = ctx as {
    ui?: unknown;
    modelRegistry?: unknown;
  } & Record<string, unknown>;
  for (const name of REQUIRED_CONTEXT)
    if (!isFunction(context, name)) missing.push(`ctx.${name}()`);
  for (const name of REQUIRED_UI)
    if (!isFunction(context.ui, name)) missing.push(`ctx.ui.${name}()`);
  // The runtime guard covers compaction, /tree, /bug and nested model calls;
  // without a runtime to wrap, those paths would send plaintext.
  // 运行时闸门覆盖压缩、/tree、/bug 与嵌套模型调用；没有可包装的运行时，
  // 这些路径会发送明文。
  if (!context.modelRegistry || typeof context.modelRegistry !== "object")
    missing.push("ctx.modelRegistry");
  return missing;
}

/** True when this release is in the suite-verified set. / 该版本是否在完整测试验证过的集合内。 */
export function isVerified(version: string): boolean {
  const parsed = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!parsed) return false;
  const [major, minor, patch] = parsed.slice(1).map(Number);
  if (major === 1) return minor >= 2 && minor <= 4;
  if (major !== 0) return false;
  if (minor === 84) return true;
  if (minor === 85) return patch >= 1;
  return minor === 86 || minor === 87 || minor === 99;
}
