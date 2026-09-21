import { test } from "node:test";
import assert from "node:assert/strict";
import { supportsPi, SUPPORTED_PI } from "../src/compat.ts";
import { describeCode, setLocale, detectLocale } from "../src/locale.ts";

test("only verified Pi releases are accepted / 仅接受经验证的 Pi 版本", () => {
  // Each entry was decided by running the full suite against that release.
  // 每一项都依据在该版本上运行完整测试的结果。
  const accepted = [
    "0.84.0",
    "0.84.1",
    "0.84.2",
    "0.84.3",
    "0.84.4",
    "0.85.1",
    "0.86.0",
    "0.86.1",
    "0.87.0",
  ];
  for (const version of accepted)
    assert.equal(supportsPi(version), true, `should accept ${version}`);

  const refused = [
    // Missing registerMarkdownTransformer. / 缺少 registerMarkdownTransformer。
    "0.74.0",
    "0.80.10",
    "0.82.1",
    "0.83.0",
    // Pi imports an undeclared package. / Pi 引用了未声明的包。
    "0.85.0",
    // Unverified future lines. / 未经验证的后续版本。
    "0.88.0",
    "1.0.0",
    // Unparseable input must never pass. / 无法解析的输入一律不通过。
    "",
    "not-a-version",
    "0.86",
  ];
  for (const version of refused)
    assert.equal(supportsPi(version), false, `should refuse ${version}`);
});

test("prerelease and build suffixes follow the base version / 预发布与构建后缀按基础版本判断", () => {
  assert.equal(supportsPi("0.86.1-beta.1"), true);
  assert.equal(supportsPi("0.87.0+build.5"), true);
  assert.equal(supportsPi("0.85.0-rc.1"), false);
  assert.equal(supportsPi("0.83.0-rc.1"), false);
});

test("the documented range matches the gate / 文档范围与门禁一致", () => {
  // The advice text must not promise a version the gate refuses.
  // 建议文案不得承诺门禁会拒绝的版本。
  for (const version of ["0.84.0", "0.85.1", "0.87.0"])
    assert.equal(supportsPi(version), true, version);
  assert.match(SUPPORTED_PI, /0\.84\.0/);
  assert.match(SUPPORTED_PI, /0\.87\.x/);
  assert.ok(!SUPPORTED_PI.includes("0.85.0"));
});

test("both languages quote the same supported range / 两种语言引用同一范围", (t) => {
  // The advice drifted from the gate once already; keep them tied together.
  // 这段建议曾与门禁脱节一次，此处将两者绑定。
  t.after(() => setLocale(detectLocale()));
  for (const locale of ["en", "zh"] as const) {
    setLocale(locale);
    const { action } = describeCode("UNSUPPORTED_PI");
    assert.ok(
      action.includes(SUPPORTED_PI),
      `${locale} advice must quote the supported range: ${action}`,
    );
  }
});
