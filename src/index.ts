import {
  getAgentDir,
  VERSION,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Protecter, REQUEST_ERROR } from "./engine.ts";
import { blocksConfigAccess } from "./guard.ts";

/**
 * Explicitly install this after other extensions that rewrite outgoing payloads.
 * 请将本扩展放在其他改写出站请求体的扩展之后加载。
 */
export default function informationProtecter(pi: ExtensionAPI): void {
  const engine = new Protecter(getAgentDir());
  const compatible =
    /^0\.85\./.test(VERSION) && Number(VERSION.split(".")[2]) >= 1;
  let healthy = false;

  pi.on("session_start", async (_event, ctx) => {
    try {
      if (!compatible) throw new Error();
      await engine.initialize();
      healthy = true;
      const count = engine.ruleCount;
      ctx.ui.setStatus("protecter", `SPI Protecter · ${count} rules`);
      if (count === 0)
        ctx.ui.notify(
          "SPI Protecter: empty rules; edit local machine config and /reload / 规则为空，请编辑本地机器配置后重载。",
          "warning",
        );
    } catch {
      healthy = false;
      ctx.ui.notify(REQUEST_ERROR, "error");
    }
  });

  pi.on("before_provider_request", async (event, ctx) => {
    try {
      if (!compatible) throw new Error();
      const payload = await engine.redact(
        event.payload,
        ctx.model?.provider ?? "unknown",
      );
      healthy = true;
      return payload;
    } catch {
      healthy = false;
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
        ctx.ui.notify(REQUEST_ERROR, "error");
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
    if (!healthy) return { block: true, reason: "SPI Protecter 尚未就绪。" };
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
      return {
        block: true,
        reason: "SPI Protecter：禁止工具访问保护配置，请由用户在本地编辑。",
      };
    }
  });

  // These auxiliary requests have different lifecycle/response restoration semantics.
  // 这些辅助请求具有不同的生命周期与响应还原语义。
  // Until separately verified, cancel instead of silently sending plaintext summaries.
  // 在单独验证前取消这些请求，避免静默发送明文摘要。
  pi.on("session_before_compact", (_event, ctx) => {
    ctx.ui.notify(
      "SPI Protecter：暂不支持远程上下文压缩，请使用 /new 开始新会话。",
      "warning",
    );
    return { cancel: true };
  });
  pi.on("session_before_tree", (event) =>
    event.preparation.userWantsSummary ? { cancel: true } : undefined,
  );

  pi.registerCommand("protecter", {
    description: "View local protection records / 查看本地保护记录",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const action = parts[0] ?? "logs";
      if (
        !["status", "reload", "logs"].includes(action) ||
        (action !== "logs" && parts.length > 1) ||
        parts.length > 2 ||
        (parts[1] !== undefined && !/^(?:[1-9]\d?|100)$/.test(parts[1]))
      ) {
        ctx.ui.notify(
          "Usage / 用法: /protecter [logs [1-100]|status|reload]. No secrets in arguments / 不要在参数中输入秘密。",
          "info",
        );
        return;
      }
      if (action === "logs") {
        // TUI only: never send plaintext to RPC clients or model/session messages.
        // 仅限本地 TUI，不将明文发送给 RPC 客户端或模型及会话消息。
        if (ctx.mode !== "tui") {
          ctx.ui.notify(
            "Local TUI required / 请在本地 TUI 查看记录。",
            "warning",
          );
          return;
        }
        try {
          const { records, truncated } = engine.auditRecords(
            Number(parts[1] ?? 20),
          );
          if (!records.length) {
            ctx.ui.notify("No readable records / 暂无可读记录。", "info");
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
            `Protection records / 保护记录${truncated ? " (limited tail / 有限尾部)" : ""}`,
            choices,
          );
          const index = selected === undefined ? -1 : choices.indexOf(selected);
          if (index < 0) return;
          if (
            !(await ctx.ui.confirm(
              "Sensitive plaintext / 敏感明文",
              "Reveal locally? Never share this view / 确认本地显示？请勿分享此界面。",
            ))
          )
            return;
          const text = safe(records[index]);
          await ctx.ui.editor(
            "Local preview; edits discarded / 本地预览，编辑不保存",
            text.length > 20000
              ? text.slice(0, 20000) + "\n[Preview truncated / 预览截断]"
              : text,
          );
        } catch {
          ctx.ui.notify(
            "Cannot read audit records / 无法读取审计记录。",
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
      ctx.ui.notify(
        `SPI Protecter: ${engine.ready ? "ready / 就绪" : "not ready / 未就绪"}; ${engine.ruleCount} rules / 规则; ${engine.mappingCount} mappings / 映射. Memory snapshot; /reload to refresh / 内存快照，重载后更新。`,
        engine.ready ? "info" : "error",
      );
    },
  });
  pi.on("session_shutdown", () => engine.close());
}
