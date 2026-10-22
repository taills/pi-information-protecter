import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ISSUE_URL,
  VERIFIED_PI,
  isVerified,
  missingCapabilities,
} from "../src/compat.ts";
import { describeCode, setLocale, detectLocale } from "../src/locale.ts";

/**
 * The gate is what this Pi build exposes, not its version number: a Pi upgrade
 * must keep working, and only a missing capability may stop the extension.
 * 门禁取决于当前 Pi 构建暴露了什么，而不是版本号：Pi 升级后必须继续可用，
 * 只有能力缺失才允许阻止扩展。
 */
function fakeApi(overrides: Record<string, unknown> = {}) {
  return {
    on() {},
    registerCommand() {},
    registerMarkdownTransformer() {},
    ...overrides,
  };
}

function fakeContext(overrides: Record<string, unknown> = {}) {
  return {
    waitForIdle() {},
    reload() {},
    abort() {},
    modelRegistry: { runtime: {} },
    ui: {
      notify() {},
      setStatus() {},
      select() {},
      confirm() {},
      editor() {},
    },
    ...overrides,
  };
}

test("a complete Pi build reports no missing capability / 能力齐备的 Pi 构建无缺失项", () => {
  assert.deepEqual(missingCapabilities(fakeApi()), []);
  assert.deepEqual(missingCapabilities(fakeApi(), fakeContext()), []);
});

test("each required capability is detected when absent / 每项必需能力缺失都能被发现", () => {
  // 0.83.0 and earlier lacked the Markdown transformer; the probe must refuse
  // such a build without knowing its version number.
  // 0.83.0 及更早没有 Markdown 转换器；探测必须在不知版本号的情况下拒绝该构建。
  for (const name of ["on", "registerCommand", "registerMarkdownTransformer"]) {
    const api = fakeApi({ [name]: undefined });
    assert.deepEqual(
      missingCapabilities(api),
      [`pi.${name}()`],
      `should detect missing ${name}`,
    );
  }
  assert.deepEqual(
    missingCapabilities(fakeApi(), fakeContext({ abort: undefined })),
    ["ctx.abort()"],
  );
  // Command UX is not a protection capability: `/protecter logs` degrades, but
  // nothing is sent as plaintext, so these must not block.
  // 命令交互不属于保护能力：`/protecter logs` 会削弱，但不会发送明文，因此不得拦截。
  for (const name of ["waitForIdle", "reload", "select", "confirm", "editor"])
    assert.deepEqual(
      missingCapabilities(
        fakeApi(),
        fakeContext({
          [name]: undefined,
          ui: { ...fakeContext().ui, [name]: undefined },
        }),
      ),
      [],
      `${name} must not block protection`,
    );
  for (const name of ["notify", "setStatus"]) {
    const ui = { ...fakeContext().ui, [name]: undefined };
    assert.deepEqual(
      missingCapabilities(fakeApi(), fakeContext({ ui })),
      [`ctx.ui.${name}()`],
    );
  }
  // Without a model runtime, compaction, /tree, /bug and nested calls would
  // send plaintext, so its absence must block too.
  // 没有模型运行时，压缩、/tree、/bug 与嵌套调用会发送明文，因此缺失同样必须拦截。
  assert.deepEqual(
    missingCapabilities(fakeApi(), fakeContext({ modelRegistry: undefined })),
    ["ctx.modelRegistry"],
  );
  // A non-object API must never be treated as capable. / 非对象 API 一律不得视为可用。
  assert.ok(missingCapabilities(undefined).length >= 3);
  assert.ok(missingCapabilities("not-an-api").length >= 3);
});

test("verified releases are announced, not enforced / 已验证版本用于提示而非门禁", () => {
  for (const version of [
    "0.84.0",
    "0.85.1",
    "0.87.1",
    "0.99.2",
    "1.2.0",
    "1.3.0",
    "1.4.0",
  ])
    assert.equal(isVerified(version), true, `should be verified: ${version}`);
  // Unverified only means "announce once"; the capability probe still decides.
  // 未验证仅意味着"提示一次"，判断仍由能力探测负责。
  for (const version of ["0.83.0", "1.5.0", "2.0.0", "", "not-a-version"])
    assert.equal(isVerified(version), false, `should not be verified: ${version}`);
  assert.match(VERIFIED_PI, /0\.84\.0/);
  assert.match(VERIFIED_PI, /1\.4\.x/);
});

test("the capability failure points at the issue tracker / 能力失败指向问题反馈地址", (t) => {
  // A user cannot fix Pi internals, so the only useful action is a report with
  // the exact capability name, in whichever language the session uses.
  // 用户无法修改 Pi 内部实现，唯一有用的处理是带上准确能力名去反馈，且需与会话语言一致。
  t.after(() => setLocale(detectLocale()));
  assert.match(ISSUE_URL, /^https:\/\/github\.com\/taills\/pi-information-protecter\//);
  for (const locale of ["en", "zh"] as const) {
    setLocale(locale);
    for (const code of ["PI_CAPABILITY", "GUARD_UNAVAILABLE"]) {
      const { action } = describeCode(code);
      assert.ok(
        action.includes(ISSUE_URL),
        `${locale} ${code} advice must quote the issue URL: ${action}`,
      );
    }
  }
});
