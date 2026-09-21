import {
  getAgentDir,
  VERSION,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Protecter } from "./engine.ts";
import { supportsPi } from "./compat.ts";
import { blocksConfigAccess } from "./guard.ts";
import {
  buildProtectedBranchSummary,
  buildProtectedSummary,
} from "./compaction.ts";
import {
  failure,
  formatDiagnostic,
  sanitizeError,
  type Diagnostic,
} from "./diagnostics.ts";
import { count, detectLocale, setLocale, t } from "./locale.ts";

/**
 * Explicitly install this after other extensions that rewrite outgoing payloads.
 * 请将本扩展放在其他改写出站请求体的扩展之后加载。
 */
export default function informationProtecter(pi: ExtensionAPI): void {
  // One language per environment; messages never show two languages at once.
  // 每个环境只用一种语言，不同时展示两种语言。
  setLocale(detectLocale());
  const engine = new Protecter(getAgentDir());
  const compatible = supportsPi(VERSION);
  let healthy = false;
  // Remember the last block so the user can inspect it after the notification.
  // 保留最近一次拦截原因，供通知消失后查看。
  let lastBlock: { at: string; text: string } | undefined;
  // Session-scoped compaction decision; the config holds the permanent one.
  // 会话级压缩决定，永久设置保存在配置中。
  let compactChoice: "allow" | "deny" | undefined;
  const record = (value: Diagnostic) => {
    const text = formatDiagnostic(value);
    lastBlock = { at: new Date().toISOString(), text };
    return text;
  };

  pi.on("session_start", async (_event, ctx) => {
    try {
      if (!compatible) throw failure("UNSUPPORTED_PI");
      await engine.initialize();
      healthy = true;
      const rules = engine.ruleCount;
      ctx.ui.setStatus(
        "protecter",
        t("statusBarRules", { rules: count("rules", rules) }),
      );
      if (rules === 0) ctx.ui.notify(t("emptyRules"), "warning");
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
    try {
      if (!compatible) throw failure("UNSUPPORTED_PI");
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
        await ctx.abort();
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
   * Pi summarizes internally without passing the payload through
   * `before_provider_request`, so letting it summarize would send the stored
   * conversation, which holds restored plaintext, to the provider. Summarize
   * redacted text here instead, and cancel on any failure.
   * Pi 在内部生成摘要且不经过 `before_provider_request`，直接交给它会把存有还原明文的
   * 会话内容发给提供商。此处改为对脱敏文本生成摘要，任何失败均取消。
   */
  /**
   * Shared gate for both summarization paths; throws when this one must not run.
   * 两条摘要路径共用的关口，不应执行时抛出。
   */
  const allowSummarization = async (
    ctx: Pick<ExtensionContext, "ui">,
    signal: AbortSignal,
  ) => {
    if (!compatible) throw failure("UNSUPPORTED_PI");
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

  pi.on("session_before_compact", async (event, ctx) => {
    try {
      await allowSummarization(ctx, event.signal);
      ctx.ui.notify(t("compactWorking"), "info");
      const summary = await buildProtectedSummary(
        event,
        ctx,
        engine,
        ctx.model?.provider ?? "unknown",
      );
      ctx.ui.notify(t("compactDone"), "info");
      return { compaction: summary };
    } catch (error) {
      // Cancel rather than fall through to Pi's unredacted summarization.
      // 取消而不回退到 Pi 未脱敏的摘要流程。
      ctx.ui.notify(
        record(sanitizeError(error, "COMPACT_FAILED").diagnostic),
        "warning",
      );
      return { cancel: true };
    }
  });

  // Branch summaries take the same internal path, so they are produced here too.
  // 分支摘要走同一内部路径，因此同样在此处生成。
  pi.on("session_before_tree", async (event, ctx) => {
    // Navigation without a summary sends nothing. / 不生成摘要的导航不发送内容。
    if (!event.preparation.userWantsSummary) return undefined;
    try {
      await allowSummarization(ctx, event.signal);
      ctx.ui.notify(t("compactWorking"), "info");
      const summary = await buildProtectedBranchSummary(
        event,
        ctx,
        engine,
        ctx.model?.provider ?? "unknown",
      );
      ctx.ui.notify(t("compactDone"), "info");
      return { summary };
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
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const action = parts[0] ?? "logs";
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
      const detail = last
        ? `\n${t("statusLastBlock", { at: lastBlock?.at ?? "" })}\n${last}`
        : `\n${t("statusNoBlock")}`;
      ctx.ui.notify(summary + detail, engine.ready ? "info" : "error");
    },
  });
  pi.on("session_shutdown", () => engine.close());
}
