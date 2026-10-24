import {
  getAgentDir,
  VERSION,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Protecter } from "./engine.ts";
import {
  ISSUE_URL,
  VERIFIED_PI,
  isVerified,
  missingCapabilities,
} from "./compat.ts";
import { blocksConfigAccess } from "./guard.ts";
import { redactCompaction, redactTree } from "./compaction.ts";
import { installRuntimeGuard } from "./guard-runtime.ts";
import { ignoredCompactionKeys } from "./config.ts";
import { hasAttachment, imageAttachments, redactAroundAttachments } from "./attachment-gate.ts";
import { Image } from "@earendil-works/pi-tui";
import {
  failure,
  formatDiagnostic,
  sanitizeError,
  type Diagnostic,
} from "./diagnostics.ts";
import { count, detectLocale, setLocale, t } from "./locale.ts";
import { lstat, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

/** Offline test input: inline text, or @<path> for a local regular file. / 离线测试输入：行内文本，或用 @<路径> 指向本地普通文件。 */
const TEST_INPUT_LIMIT = 256 * 1024;
async function readTestInput(
  argument: string,
): Promise<{ text: string; fromFile: boolean }> {
  const unquote = (value: string) =>
    /^(['"]).*\1$/s.test(value) ? value.slice(1, -1) : value;
  const value = unquote(argument);
  if (!value.startsWith("@")) return { text: value, fromFile: false };
  const path = resolve(unquote(value.slice(1).trim()));
  let stats;
  try {
    // lstat, not stat: a symbolic link must not redirect the read.
    // 使用 lstat 而非 stat：不允许符号链接改变读取目标。
    stats = await lstat(path);
  } catch (error) {
    throw sanitizeError(error, "TEST_INPUT");
  }
  if (!stats.isFile()) throw failure("TEST_INPUT");
  if (stats.size > TEST_INPUT_LIMIT)
    throw failure("TEST_SIZE", {
      bytes: stats.size,
      limit: TEST_INPUT_LIMIT,
    });
  try {
    return { text: await readFile(path, "utf8"), fromFile: true };
  } catch (error) {
    throw sanitizeError(error, "TEST_INPUT");
  }
}

/**
 * Explicitly install this after other extensions that rewrite outgoing payloads.
 * 请将本扩展放在其他改写出站请求体的扩展之后加载。
 */
export default function informationProtecter(pi: ExtensionAPI): void {
  // One language per environment; messages never show two languages at once.
  // 每个环境只用一种语言，不同时展示两种语言。
  setLocale(detectLocale());
  const engine = new Protecter(getAgentDir());
  // Capability, not version: a missing hook blocks, a newer Pi keeps working.
  // 以能力而非版本为准：钩子缺失则拦截，更新的 Pi 仍可正常使用。
  let missing = missingCapabilities(pi);
  const compatible = () => missing.length === 0;
  // Counts this extension's request-hook runs so the runtime guard can prove,
  // per call, that Pi still routes payloads through it.
  // 记录本扩展请求钩子的执行次数，供运行时闸门逐次证明 Pi 仍经钩子传递请求体。
  let hookRuns = 0;
  let bypassReported = false;
  const approvedImageFingerprints = new Set<string>();
  let healthy = false;
  // Remember the last block so the user can inspect it after the notification.
  // 保留最近一次拦截原因，供通知消失后查看。
  let lastBlock: { at: string; text: string } | undefined;
  // Session-scoped compaction decision; the config holds the permanent one.
  // 会话级压缩决定，永久设置保存在配置中。
  let compactChoice: "allow" | "deny" | undefined;
  // Uninstalls the model-runtime choke point; set while a session is running.
  // 卸载模型运行时总闸门的函数，会话运行期间有值。
  let releaseGuard: (() => void) | undefined;
  const providerOf = (model: unknown) => {
    const value = (model as { provider?: unknown } | undefined)?.provider;
    return typeof value === "string" ? value : "unknown";
  };
  const record = (value: Diagnostic) => {
    const text = formatDiagnostic(value);
    lastBlock = { at: new Date().toISOString(), text };
    return text;
  };
  const previewAttachment = async (
    ctx: Pick<ExtensionContext, "ui">,
    data: string,
    mimeType: string,
  ): Promise<void> => {
    await ctx.ui.custom((_tui, theme, _keybindings, done) => {
      const image = new Image(data, mimeType, {
        fallbackColor: (text) => theme.fg("dim", text),
      }, { maxWidthCells: 72, maxHeightCells: 24 });
      return {
        render(width: number) {
          return [
            ...image.render(width),
            "",
            theme.fg("dim", t("attachmentPreviewHint")),
          ];
        },
        handleInput(input: string) {
          if (input === "\u001b" || input === "\r" || input.toLowerCase() === "q")
            done(undefined);
        },
        invalidate() { image.invalidate(); },
      };
    }, { overlay: true });
  };

  pi.on("session_start", async (_event, ctx) => {
    try {
      // Probe this build before anything else; a listed capability blocks.
      // 先探测当前构建；一旦有能力缺失即拦截。
      missing = missingCapabilities(pi, ctx);
      if (!compatible()) {
        ctx.ui.notify(
          t("capabilityBlocked", {
            names: missing.join(", "),
            url: ISSUE_URL,
          }),
          "error",
        );
        throw failure("PI_CAPABILITY");
      }
      await engine.initialize();
      approvedImageFingerprints.clear();
      // Install before reporting health: the paths this guard covers, Pi's own
      // summarizers and nested model calls, have no event to fail closed in.
      // 先安装再报告健康状态：该闸门覆盖的 Pi 内部摘要与嵌套模型调用，
      // 没有可供失败拦截的事件。
      releaseGuard = installRuntimeGuard(
        ctx.modelRegistry,
        (model, context) => engine.redact(context, providerOf(model)),
        {
          runs: () => hookRuns,
          onBypass: () => {
            // Protection held, but the documented hook stopped firing: say so
            // once, because that is what a user must report.
            // 保护仍生效，但文档钩子已不再触发：提示一次，因为这正是需要反馈的情况。
            if (bypassReported) return;
            bypassReported = true;
            try {
              ctx.ui.notify(t("hookBypassed", { url: ISSUE_URL }), "warning");
            } catch {
              /* Redaction already happened. / 脱敏已完成。 */
            }
          },
        },
      );
      healthy = true;
      // A newer Pi is announced, never refused: the probe above is the gate.
      // 更新的 Pi 只提示不拒绝：上方的能力探测才是门禁。
      if (!isVerified(VERSION))
        ctx.ui.notify(
          t("piNewer", {
            version: VERSION,
            verified: VERIFIED_PI,
            url: ISSUE_URL,
          }),
          "warning",
        );
      const rules = engine.ruleCount;
      ctx.ui.setStatus(
        "protecter",
        t("statusBarRules", { rules: count("rules", rules) }),
      );
      if (rules === 0) ctx.ui.notify(t("emptyRules"), "warning");
      // Report settings that no longer do anything, so a configuration kept
      // from an older version is not mistaken for one still in effect.
      // 上报已不生效的设置，避免旧版本留下的配置被误认为仍在生效。
      const ignored = ignoredCompactionKeys(engine.rawCompaction);
      if (ignored.length)
        ctx.ui.notify(
          t("compactIgnoredKeys", { keys: ignored.join(", ") }),
          "warning",
        );
    } catch (error) {
      healthy = false;
      ctx.ui.setStatus("protecter", t("statusBarNotReady"));
      ctx.ui.notify(
        record(sanitizeError(error, "CONFIG_IO").diagnostic),
        "error",
      );
    }
  });

  pi.on("before_provider_request", async (event, ctx) => {
    // Count the run before anything can fail: the runtime guard only needs to
    // know whether Pi reached this handler at all.
    // 在任何失败之前先计数：运行时闸门只需知道 Pi 是否到达过本处理器。
    hookRuns++;
    try {
      if (!compatible()) throw failure("PI_CAPABILITY");
      const mode = engine.attachmentMode;
      if (hasAttachment(event.payload)) {
        if (mode === "deny") throw failure("SCAN_ATTACHMENT");
        if (mode === "ask") {
          const images = imageAttachments(event.payload);
          const knownImages = new Set(approvedImageFingerprints);
          const occurrences = new Map<string, number>();
          const count = Math.max(images.length, 1);
          for (let index = 0; index < count; index++) {
            const image = images[index];
            const fingerprint = image
              ? createHash("sha256")
                  .update(image.mimeType ?? "image/png")
                  .update("\0")
                  .update(image.data)
                  .digest("hex")
              : undefined;
            let occurrence = 0;
            if (fingerprint) {
              occurrence = (occurrences.get(fingerprint) ?? 0) + 1;
              occurrences.set(fingerprint, occurrence);
            }
            const approvalKey = fingerprint ? `${fingerprint}:${occurrence}` : undefined;
            if (approvalKey && knownImages.has(approvalKey)) continue;
            const options = image
              ? [t("attachmentOpenImage"), t("attachmentAllow"), t("attachmentDeny")]
              : [t("attachmentAllow"), t("attachmentDeny")];
            let allowed = false;
            while (!allowed) {
              const picked = await ctx.ui.select(
                `${t("attachmentAskTitle", { index: index + 1, total: count })}\n\n${t("attachmentAskBody")}`,
                options,
              );
              if (image && picked === options[0]) {
                await previewAttachment(ctx, image.data, image.mimeType ?? "image/png");
                continue;
              }
              if (picked === options[image ? 1 : 0]) {
                allowed = true;
                if (approvalKey) approvedImageFingerprints.add(approvalKey);
              } else throw failure("SCAN_ATTACHMENT");
            }
          }
        }
        ctx.ui.notify(t("attachmentAllowed"), "warning");
        // Pass configured text through the ordinary redaction path before
        // allowing opaque attachment bytes to accompany it.
        const provider = ctx.model?.provider ?? "unknown";
        const redacted = await redactAroundAttachments(
          event.payload,
          async (text) => {
            const result = await engine.redact(text, provider);
            return typeof result === "string" ? result : text;
          },
        );
        healthy = true;
        return redacted;
      }
      const payload = await engine.redact(
        event.payload,
        ctx.model?.provider ?? "unknown",
      );
      healthy = true;
      return payload;
    } catch (error) {
      healthy = false;
      // Diagnostics carry codes and numeric coordinates only, never payload text.
      // 诊断仅包含错误码和数字定位，不包含请求文本。
      const detail = record(sanitizeError(error, "INTERNAL").diagnostic);
      // Pi catches hook errors and continues with the ORIGINAL payload.
      // Pi 会捕获钩子异常并继续使用原始请求体。
      // Always return an empty replacement; abort/notifications are best-effort.
      // 必须返回空替代请求体；终止请求和通知仅作尽力处理。
      try {
        // Returns void in every supported Pi; awaiting it would prove nothing.
        // 在所有受支持的 Pi 中返回 void，await 不说明任何问题。
        ctx.abort();
      } catch {
        /* Replacement below remains mandatory. / 仍须返回下方的替代请求体。 */
      }
      try {
        ctx.ui.notify(detail, "error");
      } catch {
        /* Never fail open. / 不因异常放行原文。 */
      }
      // May produce a provider validation error, but contains NO original data.
      // 可能触发提供商校验错误，但不包含任何原始数据。
      return {};
    }
  });

  pi.on("message_end", (event) => {
    if (event.message.role !== "assistant") return;
    // Preserve IDs, signatures, usage and provider metadata; only restore user-facing content.
    // 保留 ID、签名、用量与提供商元数据，仅还原面向用户的内容。
    const message = event.message;
    return {
      message: {
        ...message,
        content: message.content.map((block) => {
          if (block.type === "text")
            return { ...block, text: engine.restoreText(block.text) };
          if (block.type === "thinking")
            return { ...block, thinking: engine.restoreText(block.thinking) };
          if (block.type === "toolCall")
            return { ...block, arguments: engine.restore(block.arguments) };
          return block;
        }),
        ...(message.errorMessage
          ? { errorMessage: engine.restoreText(message.errorMessage) }
          : {}),
      },
    };
  });

  pi.registerMarkdownTransformer((text, context) =>
    context.messageType === "user" ? text : engine.restoreText(text),
  );

  pi.on("tool_call", (event, ctx) => {
    if (!healthy)
      return {
        block: true,
        reason:
          engine.lastDiagnosticText ??
          lastBlock?.text ??
          formatDiagnostic(failure("NOT_READY").diagnostic),
      };
    const restored = engine.restore(event.input);
    for (const key of Object.keys(event.input))
      delete (event.input as Record<string, unknown>)[key];
    Object.assign(event.input, restored);
    if (
      blocksConfigAccess(
        event.toolName,
        event.input,
        ctx.cwd,
        engine.configPath,
      )
    ) {
      return { block: true, reason: t("toolBlocked") };
    }
  });

  /**
   * Shared gate for both summarization paths; throws when this one must not run.
   * 两条摘要路径共用的关口，不应执行时抛出。
   */
  const allowSummarization = async (
    ctx: Pick<ExtensionContext, "ui">,
    signal: AbortSignal,
  ) => {
    if (!compatible()) throw failure("PI_CAPABILITY");
    if (!engine.ready)
      throw engine.lastDiagnostic
        ? failure(engine.lastDiagnostic.code, engine.lastDiagnostic)
        : failure("NOT_READY");
    const mode = engine.compactionMode;
    if (mode === "off") throw failure("COMPACT_DENIED");
    if (compactChoice === "deny") throw failure("COMPACT_DENIED");
    if (mode !== "ask" || compactChoice === "allow") return;
    const options = [
      t("compactAllowOnce"),
      t("compactAllowAlways"),
      t("compactDenyOnce"),
      t("compactDenyAlways"),
    ];
    const picked = await ctx.ui.select(
      `${t("compactAskTitle")}\n\n${t("compactAskBody")}`,
      options,
      { signal },
    );
    const index = picked === undefined ? -1 : options.indexOf(picked);
    // Dismissing the dialog denies this run. / 关闭对话框视为拒绝本次。
    if (index === 1) {
      compactChoice = "allow";
      ctx.ui.notify(t("compactAlwaysNotice"), "info");
    } else if (index === 3) {
      compactChoice = "deny";
      ctx.ui.notify(t("compactDenyNotice"), "warning");
    }
    if (index !== 0 && index !== 1) throw failure("COMPACT_DENIED");
  };

  /**
   * Pi hands this hook the same `preparation` object it then summarizes, so
   * redacting it in place is what makes Pi's own summarization request carry
   * redacted text only. Pi keeps the model, credentials, retries and token
   * budget, so one configured model is enough. Any failure cancels rather than
   * falling through to Pi summarizing the stored plaintext.
   * Pi 交给本钩子的 `preparation` 就是它随后用于摘要的同一对象，因此在此处原地脱敏，
   * 即可让 Pi 自己的摘要请求只携带脱敏文本。模型、凭证、重试与 token 预算仍由 Pi 负责，
   * 因此只配一个模型也足够。任何失败都取消，而不回退到 Pi 对已存明文生成摘要。
   */
  pi.on("session_before_compact", async (event, ctx) => {
    try {
      await allowSummarization(ctx, event.signal);
      await redactCompaction(event, engine, ctx.model?.provider ?? "unknown");
      ctx.ui.notify(t("compactRedacted"), "info");
      // Returning no compaction lets Pi summarize what is now redacted.
      // 不返回摘要，由 Pi 对已脱敏的内容生成摘要。
      return undefined;
    } catch (error) {
      ctx.ui.notify(
        record(sanitizeError(error, "COMPACT_FAILED").diagnostic),
        "warning",
      );
      return { cancel: true };
    }
  });

  // Branch summaries take the same internal path, so they are redacted the same
  // way; this event does read its instructions back, so they are returned.
  // 分支摘要走同一内部路径，因此以同样方式脱敏；该事件会读回指令，故一并返回。
  pi.on("session_before_tree", async (event, ctx) => {
    // Navigation without a summary sends nothing. / 不生成摘要的导航不发送内容。
    if (!event.preparation.userWantsSummary) return undefined;
    try {
      await allowSummarization(ctx, event.signal);
      const result = await redactTree(
        event,
        engine,
        ctx.model?.provider ?? "unknown",
      );
      ctx.ui.notify(t("compactRedacted"), "info");
      return result;
    } catch (error) {
      ctx.ui.notify(
        record(sanitizeError(error, "COMPACT_FAILED").diagnostic),
        "warning",
      );
      return { cancel: true };
    }
  });

  pi.registerCommand("protecter", {
    description: t("commandDescription"),
    handler: async (args, ctx) => {
      const raw = args.trim();
      const parts = raw.split(/\s+/).filter(Boolean);
      const action = parts[0] ?? "logs";
      if (action === "test") {
        // Offline check: redact local text or a local file and show the result.
        // Nothing is sent to a model, so the output is safe to display anywhere.
        // 离线自检：对本地文本或本地文件脱敏并展示结果。
        // 全程不向模型发送内容，因此输出可在任何界面显示。
        const argument = raw.slice(action.length).trim();
        if (!argument) {
          ctx.ui.notify(t("usage"), "info");
          return;
        }
        try {
          if (!engine.ready) throw failure("NOT_READY");
          const { text: input, fromFile } = await readTestInput(argument);
          const result = await engine.redact({ text: input }, "test");
          const value = (result as { text?: unknown }).text;
          if (typeof value !== "string") throw failure("INTERNAL");
          const header = [
            t(fromFile ? "testFileLabel" : "testTextLabel"),
            t(value === input ? "testUnchanged" : "testRedacted", {
              chars: count("chars", value.length),
            }),
          ].join("\n");
          if (ctx.mode === "tui")
            await ctx.ui.editor(t("testPreviewTitle"), `${header}\n\n${value}`);
          else ctx.ui.notify(`${header}\n\n${value}`, "info");
        } catch (error) {
          ctx.ui.notify(
            record(sanitizeError(error, "TEST_INPUT").diagnostic),
            "error",
          );
        }
        return;
      }
      if (
        !["status", "reload", "logs"].includes(action) ||
        (action !== "logs" && parts.length > 1) ||
        parts.length > 2 ||
        (parts[1] !== undefined &&
          parts[1] !== "clear" &&
          !/^(?:[1-9]\d?|100)$/.test(parts[1]))
      ) {
        ctx.ui.notify(t("usage"), "info");
        return;
      }
      if (action === "logs") {
        // TUI only: never send plaintext to RPC clients or model/session messages.
        // 仅限本地 TUI，不将明文发送给 RPC 客户端或模型及会话消息。
        if (ctx.mode !== "tui") {
          ctx.ui.notify(t("logsTuiOnly"), "warning");
          return;
        }
        if (parts[1] === "clear") {
          try {
            if (!engine.ready) throw failure("NOT_READY");
            if (!(await ctx.ui.confirm(t("clearTitle"), t("clearBody"))))
              return;
            await ctx.waitForIdle();
            const bytes = await engine.clearAuditRecords();
            healthy = engine.ready;
            ctx.ui.notify(
              t("cleared", { bytes: count("bytes", bytes) }),
              "info",
            );
          } catch (error) {
            ctx.ui.notify(
              record(sanitizeError(error, "AUDIT_IO").diagnostic),
              "error",
            );
          }
          return;
        }
        try {
          const { records, truncated } = engine.auditRecords(
            Number(parts[1] ?? 20),
          );
          if (!records.length) {
            ctx.ui.notify(t("logsNone"), "info");
            return;
          }
          const safe = (value: unknown) =>
            JSON.stringify(value).replace(
              /[\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,
              (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`,
            );
          const choices = records.map(
            (r, i) =>
              `${i + 1}. ${safe(r.time)} | ${safe(r.provider).slice(0, 120)}`,
          );
          const selected = await ctx.ui.select(
            t("logsSelectTitle") + (truncated ? t("logsTruncated") : ""),
            choices,
          );
          const index = selected === undefined ? -1 : choices.indexOf(selected);
          if (index < 0) return;
          if (
            !(await ctx.ui.confirm(t("logsRevealTitle"), t("logsRevealBody")))
          )
            return;
          const text = safe(records[index]);
          await ctx.ui.editor(
            t("logsPreviewTitle"),
            text.length > 20000
              ? `${text.slice(0, 20000)}\n${t("logsPreviewTruncated")}`
              : text,
          );
        } catch (error) {
          ctx.ui.notify(
            record(sanitizeError(error, "AUDIT_IO").diagnostic),
            "error",
          );
        }
        return;
      }
      if (action === "reload") {
        await ctx.waitForIdle();
        await ctx.reload();
        return;
      }
      // Status repeats the last sanitized block so notifications are recoverable.
      // 状态会重新展示最近一次安全诊断，避免通知消失后无法定位。
      const last = engine.lastDiagnosticText ?? lastBlock?.text;
      const summary = t("statusLine", {
        state: t(engine.ready ? "statusReady" : "statusNotReady"),
        rules: count("rules", engine.ruleCount),
        mappings: count("mappings", engine.mappingCount),
      });
      // Show the compaction mode and whether the runtime guard is installed:
      // without the guard, Pi's own summarizers would send plaintext.
      // 展示压缩模式与总闸门是否已安装：缺少闸门时，Pi 自身的摘要器会发送明文。
      const compactLine = `\n${t("statusCompaction", {
        mode: engine.compactionMode,
        guard: t(releaseGuard ? "guardInstalled" : "guardMissing"),
      })}`;
      const detail = last
        ? `\n${t("statusLastBlock", { at: lastBlock?.at ?? "" })}\n${last}`
        : `\n${t("statusNoBlock")}`;
      ctx.ui.notify(
        summary + compactLine + detail,
        engine.ready ? "info" : "error",
      );
    },
  });
  pi.on("session_shutdown", () => {
    // Restore the runtime: the instance outlives this extension runtime, so a
    // reload must not leave a wrapper bound to a closed engine.
    // 还原运行时：该实例比本扩展运行时存活更久，重载后不得留下绑定已关闭引擎的包装。
    releaseGuard?.();
    releaseGuard = undefined;
    engine.close();
  });
}
