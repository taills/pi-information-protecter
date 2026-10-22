import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ModelRegistry,
  ModelRuntime,
  VERSION,
} from "@earendil-works/pi-coding-agent";
import { installRuntimeGuard } from "../src/guard-runtime.ts";
import { ProtectionError } from "../src/diagnostics.ts";

/**
 * The guard wraps methods internal to Pi, so the assumptions it makes are
 * asserted against Pi's own classes: the field `ModelRegistry` keeps the
 * runtime in, and the call methods that runtime declares. If a Pi release
 * renames either, this fails here instead of silently sending plaintext.
 * 该闸门包装的是 Pi 内部方法，因此其假设直接对 Pi 自身的类做断言：`ModelRegistry`
 * 保存运行时的字段，以及该运行时声明的调用方法。若 Pi 某个版本重命其中任何一项，
 * 则在此处失败，而不是静默地发送明文。
 */
test("Pi still exposes the wrapped surface / Pi 仍暴露被包装的接口", () => {
  const member = (name: string) =>
    typeof (ModelRuntime.prototype as unknown as Record<string, unknown>)[name];
  // Pi's own summarizers reach the provider through these, in every supported
  // release. / 在所有受支持版本中，Pi 自身的摘要器都经这些方法发往提供商。
  for (const name of ["stream", "streamSimple", "complete", "completeSimple"])
    assert.equal(member(name), "function", `ModelRuntime.${name} must exist`);

  // Classifier and image models joined the runtime in 0.99. On such a host they
  // must still be wrappable: a rename would quietly drop that coverage.
  // 分类与图像模型在 0.99 加入运行时。在这类宿主上它们必须仍可被包装：重命会静默地丢掉这部分覆盖。
  const [major, minor] = VERSION.split(".").map(Number);
  const hasTypedModels = major >= 1 || minor >= 99;
  for (const name of ["classify", "generateImages"])
    assert.equal(
      member(name),
      hasTypedModels ? "function" : "undefined",
      `ModelRuntime.${name} on Pi ${VERSION}`,
    );

  // Pi keeps the shared runtime on this field; the guard reaches it there.
  // Pi 将共享运行时保在该字段上，闸门由此访问。
  const runtime = {
    stream: () => undefined,
    streamSimple: () => undefined,
    classify: async () => undefined,
    generateImages: async () => undefined,
  };
  const original = runtime.streamSimple;
  const registry = new ModelRegistry(runtime as unknown as ModelRuntime);
  const release = installRuntimeGuard(registry, async (_m, c) => c);
  // Installing must replace the members of the runtime Pi shares, not a copy.
  // 安装必须改写 Pi 共享的那个运行时的成员，而非副本。
  assert.notEqual(runtime.streamSimple, original);
  release();
  assert.equal(runtime.streamSimple, original);
});

interface Seen {
  method: string;
  model: unknown;
  context: unknown;
  options: unknown;
}

/**
 * Mirrors the shape this guard wraps: `stream`/`streamSimple` return a lazy
 * stream synchronously, because the cache warmer calls `.result()` on the
 * return value without awaiting it.
 * 复刻本闸门所包装的形态：`stream`/`streamSimple` 同步返回惰性流，
 * 因为缓存预热会直接在返回值上调用 `.result()` 而不 await。
 */
function fakeRuntime() {
  const seen: Seen[] = [];
  const lazy = (method: string) =>
    function (this: unknown, model: unknown, context: unknown, options?: unknown) {
      seen.push({ method, model, context, options });
      return { result: () => Promise.resolve({ method, self: this }) };
    };
  const async = (method: string) =>
    async function (this: unknown, model: unknown, context: unknown, options?: unknown) {
      seen.push({ method, model, context, options });
      return { method };
    };
  const runtime = {
    marker: "runtime",
    stream: lazy("stream"),
    streamSimple: lazy("streamSimple"),
    classify: async("classify"),
    generateImages: async("generateImages"),
  };
  return { runtime, registry: { runtime }, seen };
}

const redactor = () => {
  const calls: unknown[] = [];
  return {
    calls,
    redact: async (_model: unknown, context: unknown) => {
      calls.push(context);
      return { redacted: true };
    },
  };
};

test("hooked requests pass through untouched and stay synchronous / 已挂钩请求原样直通并保持同步", async () => {
  const { registry, seen } = fakeRuntime();
  const { redact, calls } = redactor();
  const release = installRuntimeGuard(registry, redact);
  const context = { messages: ["plain"] };

  for (const method of ["stream", "streamSimple"] as const) {
    const returned = (
      registry.runtime as unknown as Record<string, (...a: unknown[]) => unknown>
    )[method]({ provider: "p" }, context, { onPayload: () => undefined });
    // The cache warmer calls .result() on the return value without awaiting it.
    // 缓存预热不 await 就在返回值上调用 .result()。
    assert.equal(
      typeof (returned as { result?: unknown }).result,
      "function",
      `${method} must return synchronously`,
    );
  }
  // before_provider_request already covers these, so nothing is scanned twice.
  // 这些已由 before_provider_request 覆盖，因此不重复扫描。
  assert.deepEqual(calls, []);
  assert.deepEqual(
    seen.map((entry) => entry.context),
    [context, context],
  );
  release();
});

test("hookless model calls are redacted / 无钩子的模型调用被脱敏", async () => {
  const { registry, seen } = fakeRuntime();
  const { redact, calls } = redactor();
  const release = installRuntimeGuard(registry, redact);
  const context = { messages: ["13800138000"] };

  for (const method of [
    "stream",
    "streamSimple",
    "classify",
    "generateImages",
  ] as const) {
    await (
      registry.runtime as unknown as Record<
        string,
        (...a: unknown[]) => Promise<unknown>
      >
    )[method]({ provider: "p" }, context, { apiKey: "k" });
  }
  assert.equal(calls.length, 4);
  for (const entry of seen) assert.deepEqual(entry.context, { redacted: true });
  // Options travel on unchanged: credentials are not ours to rewrite.
  // 选项原样传递：凭证不由本扩展改写。
  for (const entry of seen) assert.deepEqual(entry.options, { apiKey: "k" });
  release();
});

test("a request hook that never runs is covered by the guard / 钩子未执行时由闸门覆盖", async () => {
  // This is what replaces the old version allowlist: instead of trusting that a
  // given Pi release still fires before_provider_request, the guard counts the
  // extension's own hook runs around Pi's awaited onPayload. A release that
  // renames or drops the hook is detected on the first call and redacted here,
  // so a Pi upgrade cannot silently turn passthrough into plaintext.
  // 这就是取代旧版本白名单的机制：不再假定某个 Pi 版本仍会触发
  // before_provider_request，而是在 Pi 所 await 的 onPayload 前后统计本扩展钩子的执行次数。
  // 若某版本改名或移除该钩子，首次调用即被发现并在此脱敏，
  // 因此 Pi 升级不会把直通静默地变成明文。
  const { registry, seen } = fakeRuntime();
  const { redact, calls } = redactor();
  let hookRuns = 0;
  let bypasses = 0;
  const release = installRuntimeGuard(registry, redact, {
    runs: () => hookRuns,
    onBypass: () => {
      bypasses++;
    },
  });
  const call = (onPayload: (payload: unknown) => unknown) =>
    (
      registry.runtime as unknown as Record<
        string,
        (...a: unknown[]) => { result: () => Promise<unknown> }
      >
    ).stream({ provider: "p" }, { messages: ["plain"] }, { onPayload });

  // A hook that runs keeps the passthrough: Pi's own result is used as is.
  // 钩子正常执行时保持直通：Pi 自身的结果原样采用。
  call(() => {
    hookRuns++;
    return { hooked: true };
  });
  const hooked = await (seen[0].options as {
    onPayload: (payload: unknown) => Promise<unknown>;
  }).onPayload({ messages: ["plain"] });
  assert.deepEqual(hooked, { hooked: true });
  assert.equal(bypasses, 0);
  assert.deepEqual(calls, []);

  // A hook Pi no longer routes through this extension must not pass through.
  // Pi 不再经本扩展转发的钩子不得直通。
  call((payload) => payload);
  const bypassed = await (seen[1].options as {
    onPayload: (payload: unknown) => Promise<unknown>;
  }).onPayload({ messages: ["plain"] });
  assert.deepEqual(bypassed, { redacted: true });
  assert.equal(bypasses, 1);
  assert.equal(calls.length, 1);
  release();
});

test("classification and images are redacted even when hooked / 分类与图像即便带钩子也脱敏", async () => {
  const { registry, seen } = fakeRuntime();
  const { redact } = redactor();
  const release = installRuntimeGuard(registry, redact);
  // Only the lazy stream methods may pass through: these never carry the agent
  // loop's payload hook, so an onPayload here must not buy an exemption.
  // 只有惰性流方法可直通：这两者从不携带智能体循环的请求钩子，
  // 因此此处出现 onPayload 不得成为豁免理由。
  await registry.runtime.classify({ provider: "p" }, { text: "secret" }, {
    onPayload: () => undefined,
  });
  assert.deepEqual(seen[0].context, { redacted: true });
  release();
});

test("a redaction failure cancels the call / 脱敏失败即取消该调用", async () => {
  const { registry, seen } = fakeRuntime();
  const release = installRuntimeGuard(registry, async () => {
    throw new Error("scan failed");
  });
  await assert.rejects(() =>
    registry.runtime.classify({ provider: "p" }, { text: "secret" }, {}),
  );
  await assert.rejects(() =>
    (
      registry.runtime as unknown as Record<
        string,
        (...a: unknown[]) => Promise<unknown>
      >
    ).streamSimple({ provider: "p" }, { text: "secret" }, {}),
  );
  // Fail closed: the provider call never happens. / 失败即拦截：提供商调用不会发生。
  assert.deepEqual(seen, []);
  release();
});

test("the wrapper keeps the receiver / 包装保持调用者对象", async () => {
  const { registry } = fakeRuntime();
  const { redact } = redactor();
  const release = installRuntimeGuard(registry, redact);
  const stream = await (
    registry.runtime as unknown as Record<
      string,
      (...a: unknown[]) => Promise<{ result: () => Promise<unknown> }>
    >
  ).streamSimple({ provider: "p" }, {}, {});
  assert.deepEqual(await stream.result(), {
    method: "streamSimple",
    self: registry.runtime,
  });
  release();
});

test("reinstalling does not stack guards / 重复安装不叠加包装", async () => {
  const { registry, runtime } = fakeRuntime();
  const originals = {
    stream: runtime.stream,
    streamSimple: runtime.streamSimple,
    classify: runtime.classify,
    generateImages: runtime.generateImages,
  };
  const first = redactor();
  const second = redactor();
  installRuntimeGuard(registry, first.redact);
  // A reload builds a new extension runtime around the same ModelRuntime.
  // 重载会围绕同一个 ModelRuntime 构建新的扩展运行时。
  const release = installRuntimeGuard(registry, second.redact);
  await registry.runtime.classify({ provider: "p" }, { text: "x" }, {});
  assert.equal(first.calls.length, 0);
  assert.equal(second.calls.length, 1);

  release();
  assert.equal(runtime.stream, originals.stream);
  assert.equal(runtime.streamSimple, originals.streamSimple);
  assert.equal(runtime.classify, originals.classify);
  assert.equal(runtime.generateImages, originals.generateImages);
  // Releasing twice must stay harmless. / 重复卸载必须无害。
  release();
  assert.equal(runtime.classify, originals.classify);
});

test("a runtime without the 0.99 methods is covered / 缺少 0.99 新增方法的运行时仍被覆盖", async () => {
  // Pi added classifier and image models to the runtime in 0.99; earlier
  // supported releases have no such provider path to cover.
  // Pi 在 0.99 为运行时加入分类与图像模型；更早的受支持版本没有该提供商路径需要覆盖。
  const seen: unknown[] = [];
  const runtime: Record<string, unknown> = {
    stream: (_m: unknown, context: unknown) => {
      seen.push(context);
      return { result: async () => ({}) };
    },
    streamSimple: (_m: unknown, context: unknown) => {
      seen.push(context);
      return { result: async () => ({}) };
    },
    complete: undefined,
  };
  const release = installRuntimeGuard({ runtime }, async () => ({
    redacted: true,
  }));
  await (
    runtime.streamSimple as (
      m: unknown,
      c: unknown,
      o?: unknown,
    ) => Promise<unknown>
  )({ provider: "p" }, { text: "secret" }, {});
  assert.deepEqual(seen, [{ redacted: true }]);
  // Absent optional members must not be created by the guard.
  // 缺席的可选成员不得被闸门凭空创建。
  assert.equal(runtime.classify, undefined);
  assert.ok(!Object.hasOwn(runtime, "generateImages"));
  release();
});

test("an unexpected runtime fails closed / 运行时形态异常即拦截", () => {
  for (const registry of [
    undefined,
    {},
    { runtime: null },
    { runtime: {} },
    // Pi's own summarizers reach the provider through these two, so neither
    // may be missing. / Pi 自身的摘要器经这两个方法发往提供商，缺一不可。
    { runtime: { stream: () => undefined } },
    { runtime: { streamSimple: () => undefined } },
  ]) {
    const error = (() => {
      try {
        installRuntimeGuard(registry, async (_m, c) => c);
        return undefined;
      } catch (value) {
        return value;
      }
    })();
    assert.ok(error instanceof ProtectionError, "must refuse to install");
    assert.equal(error.diagnostic.code, "GUARD_UNAVAILABLE");
  }
});
