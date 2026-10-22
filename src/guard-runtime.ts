import { failure } from "./diagnostics.ts";

/**
 * A choke point for the provider calls no extension event can see.
 *
 * Only the agent loop's own requests carry Pi's `onPayload` callback, which is
 * what fires `before_provider_request`. Pi's internal summarizers — context
 * compaction, `/tree` branch summaries and the `/bug` report summary — build
 * their request options from scratch and have no hook, and `/bug` cannot even
 * be shadowed by an extension command because the interactive editor handles it
 * before extension dispatch. Nested calls made by other extensions and by
 * `codemode` scripts (`models.classify()`, `models.generateImages()`) are
 * equally invisible.
 *
 * All of them go through the one `ModelRuntime` instance the session shares, so
 * wrapping its call methods redacts what the documented hooks cannot reach.
 *
 * 为那些任何扩展事件都看不到的提供商调用设置总闸门。
 *
 * 只有智能体循环自身的请求携带 Pi 的 `onPayload` 回调，而它才是触发
 * `before_provider_request` 的原因。Pi 的内部摘要器——上下文压缩、`/tree` 分支摘要、
 * `/bug` 报告摘要——的请求选项是从零构造的，没有钩子；`/bug` 甚至无法被扩展命令遮蔽，
 * 因为交互式编辑器在扩展分发之前就处理了它。其他扩展与 `codemode` 脚本发起的嵌套调用
 * （`models.classify()`、`models.generateImages()`）同样不可见。
 *
 * 它们都经过会话共享的同一个 `ModelRuntime` 实例，因此包装其调用方法即可覆盖文档钩子
 * 无法触及的部分。
 */

/** Redact one request's context. Throwing must cancel the call. / 脱敏单次请求的内容；抛出即应取消该调用。 */
export type RedactContext = (
  model: unknown,
  context: unknown,
) => Promise<unknown>;

/**
 * `stream`/`streamSimple` return a lazy stream synchronously, and the cache
 * warmer calls `.result()` on the returned object without awaiting it. Those
 * calls carry `onPayload`, so they are passed through untouched and keep their
 * synchronous shape; every call this guard redacts is awaited by its caller.
 * `stream`/`streamSimple` 同步返回惰性流，缓存预热会直接在返回值上调用 `.result()`
 * 而不 await。这些调用都携带 `onPayload`，因此原样直通并保持同步形态；本闸门真正
 * 脱敏的调用，调用方都会 await。
 */
const LAZY_METHODS = ["stream", "streamSimple"] as const;
/**
 * Always async, never routed through the agent loop, and only present from Pi
 * 0.99, which added classifier and image models to the runtime. Earlier
 * supported releases have no such provider path, so coverage stays complete
 * without them — but a method that exists and is not wrapped would not be, so
 * they are wrapped whenever present.
 * 始终异步，不经智能体循环，且仅 Pi 0.99 起存在（该版本为运行时加入分类与图像模型）。
 * 更早的受支持版本没有这类提供商路径，因此没有它们也不影响覆盖完整性；但已存在却未包装
 * 就是缺口，所以一旦存在就一律包装。
 */
const OPTIONAL_ASYNC_METHODS = ["classify", "generateImages"] as const;
/**
 * `complete` and `completeSimple` delegate through `this.stream` and
 * `this.streamSimple` in every supported release, so wrapping those two covers
 * them as well.
 * 在所有受支持版本中，`complete` 与 `completeSimple` 都经由 `this.stream` 和
 * `this.streamSimple` 转发，因此包装这两个即可连带覆盖。
 */
const REQUIRED_METHODS = LAZY_METHODS;

/** Marks a runtime this guard already wraps, so reload cannot stack guards. / 标记已被包装的运行时，避免重载后叠加。 */
const INSTALLED = Symbol.for("pi-information-protecter.runtime-guard");

type Call = (model: unknown, context: unknown, options?: unknown) => unknown;
type Target = Record<string, unknown> & { [INSTALLED]?: () => void };

/** Pi's `ModelRegistry` wraps the one `ModelRuntime` the session shares. / Pi 的 `ModelRegistry` 包装会话共享的那个 `ModelRuntime`。 */
function resolveRuntime(registry: unknown): Target {
  const runtime = (registry as { runtime?: unknown } | undefined)?.runtime;
  if (!runtime || typeof runtime !== "object") throw failure("GUARD_UNAVAILABLE");
  const target = runtime as Target;
  for (const name of REQUIRED_METHODS)
    if (typeof target[name] !== "function") throw failure("GUARD_UNAVAILABLE");
  return target;
}

function hasPayloadHook(options: unknown): boolean {
  if (!options || typeof options !== "object") return false;
  return (options as { onPayload?: unknown }).onPayload !== undefined;
}

/**
 * Per-call proof that Pi really ran `before_provider_request`.
 *
 * A payload-carrying call is passed through because the documented hook
 * redacts it, and because `stream`/`streamSimple` must keep their synchronous
 * shape. If a future Pi renames, reorders or drops that hook, passing the call
 * through would send plaintext, and no version check can see it happen. So the
 * guard wraps `onPayload`: Pi awaits it and uses its return value, so counting
 * this extension's own hook runs around it turns an unverifiable assumption
 * into a per-call check, and the guard redacts the payload itself when the hook
 * did not run.
 *
 * 按次证明 Pi 确实执行了 `before_provider_request`。
 *
 * 带 payload 钩子的调用之所以直通，是因为文档钩子会对其脱敏，且
 * `stream`/`streamSimple` 必须保持同步形态。若未来的 Pi 改名、调整顺序或移除该钩子，
 * 直通就会发送明文，而任何版本检查都无法发现。因此闸门包装 `onPayload`：Pi 会 await
 * 它并使用其返回值，在其前后统计本扩展钩子的执行次数，就把不可验证的假设变成了逐次校验；
 * 钩子未执行时，由闸门自行脱敏该请求体。
 */
export interface HookWitness {
  /** Monotonic count of this extension's request-hook runs. / 本扩展请求钩子的单调递增计数。 */
  runs: () => number;
  /** Called once per call Pi did not route through the hook. / Pi 未经钩子处理的调用每次上报一次。 */
  onBypass?: () => void;
}

/** Pi's own call options; only `onPayload` is inspected. / Pi 自身的调用选项，仅检查 `onPayload`。 */
type CallOptions = Record<string, unknown>;

function verifiedOptions(
  model: unknown,
  options: unknown,
  redact: RedactContext,
  witness: HookWitness | undefined,
): CallOptions | undefined {
  if (!options || typeof options !== "object") return undefined;
  const hook = (options as { onPayload?: unknown }).onPayload;
  if (!witness || typeof hook !== "function") return options as CallOptions;
  const original = hook as (payload: unknown) => unknown;
  return {
    ...(options as Record<string, unknown>),
    onPayload: async (payload: unknown) => {
      const before = witness.runs();
      const result = await original(payload);
      if (witness.runs() > before) return result;
      witness.onBypass?.();
      // Fail closed: throwing here cancels the call, redacting keeps it working.
      // 失败拦截：在此抛出会取消调用，此处脱敏则能继续工作。
      return redact(model, result === undefined ? payload : result);
    },
  };
}

/**
 * Wrap the runtime and return an idempotent uninstall function. Failing to
 * install is a protection failure, not a degraded feature: the caller must
 * block, because these paths would otherwise send plaintext.
 * 包装运行时并返回可重复调用的卸载函数。安装失败属于保护失效而非功能降级：
 * 调用方必须拦截，否则这些路径会发送明文。
 */
export function installRuntimeGuard(
  registry: unknown,
  redact: RedactContext,
  witness?: HookWitness,
): () => void {
  const target = resolveRuntime(registry);
  // A reload builds a new extension runtime around the same ModelRuntime.
  // 重载会围绕同一个 ModelRuntime 构建新的扩展运行时。
  target[INSTALLED]?.();

  const originals = [
    ...REQUIRED_METHODS,
    ...OPTIONAL_ASYNC_METHODS.filter((name) => typeof target[name] === "function"),
  ].map((name) => [name, target[name] as Call] as const);
  for (const [name, original] of originals) {
    const lazy = (LAZY_METHODS as readonly string[]).includes(name);
    const wrapper: Call = function (this: unknown, model, context, options) {
      if (lazy && hasPayloadHook(options))
        return original.call(
          this,
          model,
          context,
          verifiedOptions(model, options, redact, witness),
        );
      return (async () =>
        original.call(this, model, await redact(model, context), options))();
    };
    target[name] = wrapper;
  }

  const restore = () => {
    for (const [name, original] of originals) target[name] = original;
    delete target[INSTALLED];
  };
  Object.defineProperty(target, INSTALLED, {
    value: restore,
    configurable: true,
    enumerable: false,
    writable: true,
  });
  return restore;
}
