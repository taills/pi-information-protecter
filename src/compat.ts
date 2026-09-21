/**
 * Supported Pi versions, established by running the full suite, including the
 * real loader and worker integration tests, against each release.
 * 受支持的 Pi 版本，依据是在每个版本上运行完整测试（含真实加载器与 worker 集成测试）。
 *
 * - 0.83.0 and earlier lack `registerMarkdownTransformer`, which this
 *   extension always registers, so loading fails outright.
 *   0.83.0 及更早缺少 `registerMarkdownTransformer`，本扩展必定注册该接口，加载直接失败。
 * - 0.85.0 ships `dist/experimental/server.js` importing `@earendil-works/pi-server`,
 *   which no Pi release declares as a dependency, so the loader cannot resolve it.
 *   0.85.0 的 `dist/experimental/server.js` 引用了任何 Pi 版本都未声明的
 *   `@earendil-works/pi-server`，加载器无法解析。
 *
 * Refuse anything outside the verified set: a wrong guess here means sending
 * plaintext, not a broken feature.
 * 超出已验证范围一律拒绝：此处判断失误意味着发送明文，而不仅是功能失效。
 */
export const SUPPORTED_PI = "0.84.0-0.84.x, 0.85.1-0.87.x";

/** Accept only Pi releases verified against the full test suite. / 仅接受经完整测试验证的 Pi 版本。 */
export function supportsPi(version: string): boolean {
  const parsed = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!parsed) return false;
  const [major, minor, patch] = parsed.slice(1).map(Number);
  if (major !== 0) return false;
  if (minor === 84) return true;
  // 0.85.0 is excluded by Pi's own unresolvable import. / 0.85.0 因 Pi 自身无法解析的引用被排除。
  if (minor === 85) return patch >= 1;
  return minor === 86 || minor === 87;
}
