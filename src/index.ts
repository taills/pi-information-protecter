import {
  getAgentDir,
  VERSION,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import { Protecter, REQUEST_ERROR } from "./engine.ts";
import { blocksConfigAccess } from "./guard.ts";

/**
 * Explicitly install this after other extensions that rewrite outgoing payloads.
 * 请将本扩展放在其他改写出站请求体的扩展之后加载。
 */
export default function informationProtecter(pi: ExtensionAPI): void {
  const engine = new Protecter(join(getAgentDir(), "protecter.json"));
  const compatible =
    /^0\.85\./.test(VERSION) && Number(VERSION.split(".")[2]) >= 1;
  let healthy = false;

  pi.on("session_start", (_event, ctx) => {
    try {
      if (!compatible) throw new Error();
      engine.initialize();
      healthy = true;
      const count = loadConfig(engine.configPath).config.sensitiveWords.length;
      ctx.ui.setStatus("protecter", `SPI Protecter · ${count} rules`);
      if (count === 0)
        ctx.ui.notify(
          "SPI Protecter：敏感词数组为空，请在本地编辑 protecter.json 后使用。",
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
      const payload = await engine.redact(event.payload);
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
    description: "SPI Protecter 状态与本地配置校验（不显示敏感值）",
    handler: async (args, ctx) => {
      if (args.trim() && !["status", "reload"].includes(args.trim())) {
        ctx.ui.notify(
          "用法：/protecter [status|reload]。不要在命令参数中填写敏感值。",
          "info",
        );
        return;
      }
      try {
        if (!compatible) throw new Error();
        const { config } = loadConfig(engine.configPath);
        healthy = true;
        ctx.ui.notify(
          `SPI Protecter：${config.sensitiveWords.length} 条规则；${engine.mappingCount} 个内存映射。配置每次请求重新读取。`,
          "info",
        );
      } catch {
        healthy = false;
        ctx.ui.notify(REQUEST_ERROR, "error");
      }
    },
  });
  pi.on("session_shutdown", () => engine.close());
}
