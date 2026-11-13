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
import {
  attachmentItems,
  attachmentPaths,
  hasAttachment,
  replaceImageAttachments,
  redactAroundAttachments,
} from "./attachment-gate.ts";
import {
  editImageAttachment,
  openImageWithDefaultApp,
  viewImageAttachment,
  supportsImageEditing,
} from "./attachment-editor.ts";
import * as tui from "@earendil-works/pi-tui";
import {
  failure,
  formatDiagnostic,
  sanitizeError,
  type Diagnostic,
} from "./diagnostics.ts";
import { count, detectLocale, setLocale, t } from "./locale.ts";
import { Detector, type DetectionReport, type ScanInput } from "./detector/detector.ts";
import { detectionSettings, isLoopbackEndpoint } from "./detector/settings.ts";
import { contentUnits, payloadUnits, type DetectUnit } from "./detector/units.ts";
import { appendDetection, detectionLogPath, readDetections } from "./detector/log.ts";
import { probeService } from "./detector/client.ts";
import { lstat, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

const IMAGE_FILE = /\.(png|jpe?g|gif|webp|bmp|tiff?|heic|heif|avif|svg)$/i;

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
  // Approved (path, exact content) pairs: the same path with changed content
  // asks again. Attachments whose bytes cannot be read are never remembered.
  // 已允许的（路径，内容）组合：同路径但内容变化会重新询问；无法读取内容的附件不记忆。
  const approvedAttachmentPaths = new Set<string>();
  // Pi's image content carries no file path; images returned by tools are
  // mapped back to the producing tool and, when its input names an image file,
  // that path, so the user can locate the original.
  // Pi 的图片内容不含文件路径；工具返回的图片会反查到产生它的工具，若调用参数指向图片文件
  // 则同时记录该路径，便于定位原文件。
  const imageSources = new Map<string, { tool: string; path?: string }>();
  const imageDataKey = (data: string) => createHash("sha256").update(data).digest("hex");
  let healthy = false;
  // Remember the last block so the user can inspect it after the notification.
  // 保留最近一次拦截原因，供通知消失后查看。
  let lastBlock: { at: string; text: string; local?: string } | undefined;
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
  /**
   * Configuration entries named by rule/otherRule, for local display only.
   * Never put this into text the model can see (tool block reasons).
   * 诊断中 rule/otherRule 对应的配置条目，仅供本地展示，不得进入模型可见的文本。
   */
  const ruleEntries = (value: Diagnostic): string | undefined => {
    const lines = [...new Set([value.rule, value.otherRule])]
      .filter((index): index is number => index !== undefined)
      .flatMap((index) => {
        const rule = engine.ruleAt(index);
        return rule === undefined ? [] : [`#${index} ${JSON.stringify(rule)}`];
      });
    return lines.length ? `${t("diagnosticRuleEntries")}\n${lines.join("\n")}` : undefined;
  };
  const record = (value: Diagnostic) => {
    const text = formatDiagnostic(value);
    const local = ruleEntries(value);
    lastBlock = { at: new Date().toISOString(), text, local };
    return local ? `${text}\n${local}` : text;
  };
  /**
   * True when this terminal can draw images inline (Kitty or iTerm2). Apple
   * Terminal, tmux and others cannot, and would show only a text placeholder.
   * 终端能否内联显示图片（Kitty 或 iTerm2）。Apple Terminal、tmux 等不能，只会显示文字占位。
   */
  const canPreviewInline = () => {
    try {
      return typeof tui.getCapabilities === "function" && !!tui.getCapabilities().images;
    } catch {
      return false;
    }
  };
  const previewAttachment = async (
    ctx: Pick<ExtensionContext, "ui">,
    data: string,
    mimeType: string,
    sourcePath?: string,
  ): Promise<void> => {
    if (!canPreviewInline()) {
      // Show the exact bytes to be sent in the system viewer. The full path is
      // always printed: a launched viewer may still show nothing (SSH, no GUI),
      // and the copy stays until the user returns, then is deleted.
      // 用系统看图软件展示即将发送的原始字节。始终打印完整路径：看图软件即便启动也可能未显示
      // （SSH、无图形界面）；副本保留到用户返回后再删除。
      try {
        await viewImageAttachment({ data, mimeType }, async (path) => {
          let opened = true;
          try {
            await openImageWithDefaultApp(path);
          } catch {
            opened = false;
          }
          const lines = [t(opened ? "attachmentViewWait" : "attachmentViewManual"), "", `${t("attachmentViewPath")}: ${path}`];
          if (sourcePath) lines.push(`${t("attachmentPathLabel")}: ${sourcePath}`);
          await ctx.ui.select(lines.join("\n"), [t("attachmentViewDone")]);
        });
      } catch {
        ctx.ui.notify(
          sourcePath
            ? `${t("attachmentViewFailed")}\n${t("attachmentPathLabel")}: ${sourcePath}`
            : t("attachmentViewFailed"),
          "warning",
        );
      }
      return;
    }
    await inlinePreview(ctx, data, mimeType);
  };
  const inlinePreview = async (
    ctx: Pick<ExtensionContext, "ui">,
    data: string,
    mimeType: string,
  ): Promise<void> => {
    await ctx.ui.custom((_tui, theme, _keybindings, done) => {
      const image = new tui.Image(data, mimeType, {
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

  // ---- System One content detection / System One 内容检测 ----
  let detector = new Detector(detectionSettings(undefined));
  /** Terminal notice that also works without a UI (print/JSON mode). / 无 UI（print/JSON 模式）时也能输出的终端提示。 */
  const say = (ctx: Pick<ExtensionContext, "ui" | "hasUI">, text: string, level: "info" | "warning" | "error") => {
    try {
      if (ctx.hasUI === false) process.stderr.write(`${text}\n`);
      else ctx.ui.notify(text, level);
    } catch {
      /* A notice must never break the hook. / 提示失败不得影响钩子。 */
    }
  };
  const detectMode = () => {
    if (!detector.enabled) return t("detectModeOff");
    const actions = new Set(detector.settings.rules.map((rule) => detector.actionOf(rule)));
    return t(actions.size > 1 ? "detectModeMixed" : actions.has("block") ? "detectModeBlock" : "detectModeLog");
  };
  const showDetectStatus = (ctx: Pick<ExtensionContext, "ui">) => {
    try {
      if (!detector.enabled && !detector.settings.enabled) {
        ctx.ui.setStatus("protecter-detect", undefined);
        return;
      }
      ctx.ui.setStatus(
        "protecter-detect",
        detector.enabled && !detector.available
          ? t("detectStatusBarUnavailable")
          : t("detectStatusBar", { mode: detectMode() }),
      );
    } catch {
      /* Status is cosmetic. / 状态栏仅为展示。 */
    }
  };
  /** Highest probability per rule, e.g. "credential 97%, pii 85%". / 每条规则的最高概率。 */
  const ruleSummary = (report: DetectionReport) => {
    const best = new Map<string, number>();
    for (const hit of report.hits) best.set(hit.rule, Math.max(best.get(hit.rule) ?? 0, hit.probability));
    return [...best].map(([rule, p]) => `${rule} ${Math.round(p * 100)}%`).join(", ");
  };
  /** Exact texts this extension put into tool results; never re-checked. / 本扩展写入工具结果的原文，不再重复检测。 */
  const withheldNotices = new Set<string>();
  const excludeNotices = (input: ScanInput): ScanInput => ({
    texts: input.texts.filter((text) => !withheldNotices.has(text)),
    images: input.images,
  });
  const contentHash = (input: ScanInput) => {
    const hash = createHash("sha256");
    for (const text of input.texts) hash.update("t\0").update(text).update("\0");
    for (const image of input.images) if (image.kind === "image") hash.update("i\0").update(image.data).update("\0");
    return hash.digest("hex");
  };
  // A service that is down fails every check; when nothing is blocked, say so
  // once a minute instead of after every message and tool call.
  // 服务宕机时每次检测都会失败；未阻断时每分钟提示一次，而不是每条消息、每次工具调用都提示。
  let lastErrorNotice = { codes: "", at: 0 };
  const repeatedErrorNotice = (codes: string) => {
    const now = Date.now();
    if (lastErrorNotice.codes === codes && now - lastErrorNotice.at < 60_000) return true;
    lastErrorNotice = { codes, at: now };
    return false;
  };
  /** Notify and log one finished scan. / 对一次已完成的扫描进行提示并记录。 */
  const reportScan = (
    ctx: Pick<ExtensionContext, "ui" | "hasUI">,
    source: { key: string; label: string },
    input: ScanInput,
    report: DetectionReport,
  ) => {
    if (report.cancelled && !report.block) return;
    if (report.hits.length || report.errors.length)
      appendDetection(detectionLogPath(engine.configPath), source.key, contentHash(input), report);
    const codes = report.errors.map((error) => error.code).join(", ");
    if (report.hits.length)
      say(
        ctx,
        t(report.block ? "detectHitBlock" : "detectHitLog", { source: source.label, rules: ruleSummary(report) }),
        report.block ? "error" : "warning",
      );
    else if (report.errors.length && (report.block || !repeatedErrorNotice(codes)))
      say(
        ctx,
        t(report.block ? "detectErrorBlock" : detector.enforcing ? "detectErrorAllow" : "detectErrorLog", {
          source: source.label,
          codes,
        }),
        report.block ? "error" : "warning",
      );
    if (report.truncated)
      say(
        ctx,
        t("detectTruncated", {
          source: source.label,
          chars: count("chars", detector.settings.maxChars * detector.settings.maxChunks),
        }),
        "warning",
      );
    showDetectStatus(ctx as Pick<ExtensionContext, "ui">);
  };
  /**
   * Scan content. When no rule can block, detection never delays Pi: it runs
   * in the background and only notifies. Otherwise the caller waits.
   * 检测内容。若没有规则可阻断，检测绝不拖慢 Pi：在后台运行，只做提示；否则调用方等待结果。
   */
  const runDetection = async (
    ctx: Pick<ExtensionContext, "ui" | "hasUI">,
    source: { key: string; label: string },
    input: ScanInput,
    signal?: AbortSignal,
  ): Promise<DetectionReport | undefined> => {
    if (!detector.enabled || (!input.texts.length && !input.images.length)) return undefined;
    const current = detector;
    if (!current.enforcing) {
      void current
        .scan(input)
        .then((report) => {
          if (current === detector) reportScan(ctx, source, input, report);
        })
        .catch(() => undefined);
      return undefined;
    }
    const report = await current.scan(input, signal);
    reportScan(ctx, source, input, report);
    return report;
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
      approvedAttachmentPaths.clear();
      imageSources.clear();
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
      // Overrides from /protecter detect last for one session only.
      // /protecter detect 的覆盖仅对单个会话生效。
      detector = new Detector(detectionSettings(engine.detectionConfig));
      if (detector.enabled && !isLoopbackEndpoint(detector.settings.endpoint))
        say(ctx, t("detectRemote", { endpoint: endpointLabel(detector.settings.endpoint) }), "warning");
      // Like an empty sensitiveWords list: configured, but nothing to check.
      // 与空的 sensitiveWords 一样：已配置，但没有可检测的内容。
      if (detector.enabled && !detector.settings.rules.length) say(ctx, t("detectNoRules"), "warning");
      showDetectStatus(ctx);
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

  /**
   * Last line for content that reached the request without passing the input
   * or tool-result checks (context files, injected messages, resumed history).
   * Units already checked are served from the cache, so only new text costs a call.
   * 未经输入或工具结果检测、直接进入请求的内容（上下文文件、注入消息、恢复的历史）的最后一道检查。
   * 已检测过的单元直接命中缓存，只有新文本才会调用模型。
   */
  const detectRequest = async (payload: unknown, ctx: ExtensionContext) => {
    if (!detector.enabled || !detector.settings.targets.request) return;
    const report = await runDetection(
      ctx,
      { key: "request", label: t("detectSourceRequest") },
      excludeNotices(payloadUnits(payload)),
      ctx.signal,
    );
    if (!report?.block) return;
    const first = report.errors[0];
    throw report.hits.length || !first ? failure("DETECT_HIT") : failure(first.code, first);
  };

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
        let outgoingPayload = event.payload;
        if (mode === "ask") {
          const items = attachmentItems(event.payload);
          const paths = attachmentPaths(event.payload);
          const editedImages: Array<{ data: string; mimeType?: string } | undefined> = [];
          const knownImages = new Set(approvedImageFingerprints);
          const occurrences = new Map<string, number>();
          let imageIndex = 0;
          for (let index = 0; index < items.length; index++) {
            let image = items[index];
            const currentImageIndex = image ? imageIndex++ : -1;
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
            const source = image ? imageSources.get(imageDataKey(image.data)) : undefined;
            const attachmentPath = paths[index] ?? source?.path;
            const origin = attachmentPath
              ? `${t("attachmentPathLabel")}: ${attachmentPath}`
              : source
                ? t("attachmentSourceTool", { tool: source.tool })
                : `${t("attachmentPathLabel")}: ${t("attachmentPathUnavailable")}`;
            const pathKey = attachmentPath && fingerprint ? `${attachmentPath}\0${fingerprint}` : undefined;
            if ((pathKey && approvedAttachmentPaths.has(pathKey)) || (approvalKey && knownImages.has(approvalKey))) {
              editedImages[currentImageIndex] = undefined;
              continue;
            }
            const canEditImage = image !== undefined && supportsImageEditing(image);
            let options: string[];
            if (image) {
              options = [t("attachmentOpenImage")];
              if (canEditImage) options.push(t("attachmentEditImage"));
              options.push(t("attachmentAllow"), t("attachmentDeny"));
            } else options = [t("attachmentAllow"), t("attachmentDeny")];
            let allowed = false;
            let wasEdited = false;
            while (!allowed) {
              const picked = await ctx.ui.select(
                `${t("attachmentAskTitle", { index: index + 1, total: items.length })}\n\n${t("attachmentAskBody")}\n\n${origin}`,
                options,
              );
              if (image && picked === options[0]) {
                // After an edit the original file no longer matches; do not point at it.
                // 编辑后内容已与原文件不同，不再指向原文件。
                await previewAttachment(ctx, image.data, image.mimeType ?? "image/png", wasEdited ? undefined : attachmentPath);
                continue;
              }
              if (image && canEditImage && picked === t("attachmentEditImage")) {
                const edited = await editImageAttachment(image, async (path) => {
                  await openImageWithDefaultApp(path);
                  const finished = await ctx.ui.select(
                    t("attachmentEditWait"),
                    [t("attachmentEditDone"), t("attachmentDeny")],
                  );
                  if (finished !== t("attachmentEditDone")) throw failure("SCAN_ATTACHMENT");
                });
                image = { type: "image", ...edited };
                editedImages[currentImageIndex] = edited;
                wasEdited = true;
                await previewAttachment(ctx, image.data, image.mimeType ?? "image/png");
                continue;
              }
              if (picked === t("attachmentAllow")) {
                allowed = true;
                // An edited image is substituted only in this request; approving its
                // path would let the unedited original through on later turns.
                // 编辑后的图片仅替换本次请求；若记住路径，后续轮次会放行未编辑的原图。
                if (pathKey && !wasEdited) approvedAttachmentPaths.add(pathKey);
                if (approvalKey && !wasEdited) approvedImageFingerprints.add(approvalKey);
              } else throw failure("SCAN_ATTACHMENT");
            }
          }
          outgoingPayload = replaceImageAttachments(event.payload, editedImages);
        }
        // Detect what is actually sent, including edited images, before redaction.
        // 在脱敏前检测实际发送的内容（包括编辑后的图片）。
        await detectRequest(outgoingPayload, ctx);
        ctx.ui.notify(t("attachmentAllowed"), "warning");
        // Pass configured text through the ordinary redaction path before
        // allowing opaque attachment bytes to accompany it.
        const provider = ctx.model?.provider ?? "unknown";
        const redacted = await redactAroundAttachments(
          outgoingPayload,
          async (text) => {
            const result = await engine.redact(text, provider);
            return typeof result === "string" ? result : text;
          },
        );
        healthy = true;
        return redacted;
      }
      await detectRequest(event.payload, ctx);
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

  pi.on("input", async (event, ctx) => {
    if (!detector.enabled || !detector.settings.targets.input) return;
    const input: ScanInput = {
      texts: [event.text],
      images: event.images ? contentUnits(event.images).images : [],
    };
    const report = await runDetection(ctx, { key: "input", label: t("detectSourceInput") }, input, ctx.signal);
    if (!report?.block) return;
    // Handled input never reaches the session, so it cannot poison later requests.
    // 被处理的输入不会进入会话，因此不会污染后续请求。
    if (event.source === "interactive")
      try {
        ctx.ui.setEditorText(event.text);
      } catch {
        /* Best-effort restore. / 尽力恢复。 */
      }
    say(ctx, t("detectInputBlocked"), "warning");
    return { action: "handled" as const };
  });

  pi.on("tool_result", async (event, ctx) => {
    // Image-source lookup only observes. / 图片来源反查仅做观察。
    const input = (event.input ?? {}) as Record<string, unknown>;
    // MCP gateway calls name the real tool in `tool`. / MCP 网关调用在 `tool` 中给出实际工具名。
    const inner = typeof input.tool === "string" ? input.tool : undefined;
    const tool = inner ? `${event.toolName} → ${inner}` : event.toolName;
    const images = event.content.filter((block) => block.type === "image");
    if (images.length) try {
      // Only an image-file argument is the image's source; a `.pen` or
      // directory path would point the user at the wrong file.
      // 只有指向图片文件的参数才是图片来源；`.pen` 或目录路径会指错文件。
      const nested = input.args && typeof input.args === "object" ? (input.args as Record<string, unknown>) : {};
      const candidate = [input.path, input.file_path, input.filePath, input.filename, nested.path, nested.filename, nested.filePath]
        .find((value): value is string => typeof value === "string" && IMAGE_FILE.test(value.trim()));
      const path = candidate ? resolve(ctx.cwd, candidate.trim().replace(/^@/, "")) : undefined;
      for (const block of images) imageSources.set(imageDataKey(block.data), { tool, path });
    } catch {
      /* Path lookup is best-effort. / 路径反查仅尽力而为。 */
    }
    // Detection is the one reason to change a result: withheld output never
    // enters the conversation, so it never reaches any model.
    // 检测是唯一会修改结果的情况：被拦截的输出不会进入会话，也就不会到达任何模型。
    if (!detector.enabled || !detector.settings.targets.toolResults) return;
    const report = await runDetection(
      ctx,
      { key: `tool:${tool}`, label: t("detectSourceTool", { tool }) },
      contentUnits(event.content),
      ctx.signal,
    );
    if (!report?.block) return;
    const text = report.hits.length
      ? t("detectToolWithheld", { rules: [...new Set(report.hits.map((hit) => hit.rule))].join(", ") })
      : t("detectToolWithheldError");
    withheldNotices.add(text);
    return { content: [{ type: "text" as const, text }], isError: true };
  });

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

  const endpointLabel = (endpoint: string) => {
    try {
      const url = new URL(endpoint);
      return `${url.origin}${url.pathname}`;
    } catch {
      return "?";
    }
  };
  const IMAGE_MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp" };
  /** `/protecter detect …`: status, session overrides, logs and a local test. / 状态、会话覆盖、日志与本地测试。 */
  const detectCommand = async (raw: string, ctx: ExtensionContext) => {
    const sub = raw.split(/\s+/).filter(Boolean)[0] ?? "status";
    if (["on", "off", "log", "block"].includes(sub)) {
      // Session overrides only adjust what the configuration defines; the
      // service and rules always come from the local configuration file.
      // 会话覆盖只调整配置中已定义的内容；服务与规则始终来自本地配置文件。
      if (sub !== "off" && !detector.settings.configured) {
        ctx.ui.notify(t("detectNotConfigured"), "warning");
        return;
      }
      detector.resetBreaker();
      lastErrorNotice = { codes: "", at: 0 };
    }
    if (sub === "on" || sub === "off") {
      detector.override.enabled = sub === "on";
      ctx.ui.notify(t("detectSessionChanged", { mode: detectMode() }), "info");
      if (sub === "on" && !isLoopbackEndpoint(detector.settings.endpoint))
        ctx.ui.notify(t("detectRemote", { endpoint: endpointLabel(detector.settings.endpoint) }), "warning");
      showDetectStatus(ctx);
      return;
    }
    if (sub === "log" || sub === "block") {
      detector.override.enabled = true;
      detector.override.action = sub;
      ctx.ui.notify(t("detectSessionChanged", { mode: detectMode() }), "info");
      showDetectStatus(ctx);
      return;
    }
    if (sub === "status") {
      const settings = detector.settings;
      const info = await probeService({
        endpoint: settings.endpoint,
        apiKey: detector.apiKey,
        timeoutMs: settings.timeoutMs,
      });
      if (info.healthy) detector.resetBreaker();
      const service = info.healthy
        ? t("detectServiceUp", {
            model: info.model ?? "?",
            vision: info.vision === undefined ? "?" : String(info.vision),
            context: info.contextTokens ?? "?",
            slots: info.slots ?? "?",
          })
        : t("detectServiceDown");
      ctx.ui.notify(
        t("detectStatus", {
          state: detectMode(),
          endpoint: endpointLabel(settings.endpoint),
          service,
          rules: settings.rules.map((rule) => `${rule.id}≥${rule.threshold}→${detector.actionOf(rule)}`).join(", "),
          concurrency: settings.concurrency,
          onError: settings.onError,
          ...detector.stats,
        }),
        info.healthy ? "info" : "warning",
      );
      showDetectStatus(ctx);
      return;
    }
    if (sub === "logs") {
      // Records carry no content, so any mode may show them. / 记录不含原文，任何模式均可展示。
      const records = readDetections(detectionLogPath(engine.configPath), 50);
      if (!records.length) {
        ctx.ui.notify(t("detectLogsNone"), "info");
        return;
      }
      const lines = records.map((record) => {
        const hits = record.hits.map((hit) => `${hit.rule} ${Math.round(hit.probability * 100)}% ${hit.action}`).join(", ");
        const errors = record.errors.length ? ` [${record.errors.join(", ")}]` : "";
        return `${record.time} ${record.block ? "BLOCK" : "LOG  "} ${record.source}: ${hits}${errors}`;
      });
      const text = `${t("detectLogsTitle")}\n\n${lines.join("\n")}`;
      if (ctx.mode === "tui") await ctx.ui.editor(t("logsPreviewTitle"), text);
      else ctx.ui.notify(text, "info");
      return;
    }
    if (sub === "test") {
      const argument = raw.slice(sub.length).trim();
      if (!argument) {
        ctx.ui.notify(t("detectUsage"), "info");
        return;
      }
      try {
        let units: DetectUnit[];
        const path = /^@/.test(argument) ? resolve(argument.slice(1).trim().replace(/^(['"])(.*)\1$/, "$2")) : undefined;
        const mime = path ? IMAGE_MIME[path.split(".").pop()?.toLowerCase() ?? ""] : undefined;
        if (path && mime) {
          const stats = await lstat(path).catch((error) => {
            throw sanitizeError(error, "TEST_INPUT");
          });
          if (!stats.isFile()) throw failure("TEST_INPUT");
          if (stats.size > detector.settings.maxImageBytes)
            throw failure("DETECT_IMAGE", { bytes: stats.size, limit: detector.settings.maxImageBytes });
          units = [{ kind: "image", mimeType: mime, data: (await readFile(path)).toString("base64") }];
        } else {
          const { text } = await readTestInput(argument);
          const step = detector.settings.maxChars;
          units = [];
          for (let i = 0; i < text.length && units.length < detector.settings.maxChunks; i += step)
            units.push({ kind: "text", text: text.slice(i, i + step) });
        }
        const started = Date.now();
        const results = await detector.inspect(units);
        const lines = results.map(({ rule, action, probability, error }) =>
          error
            ? `✗ ${rule.id}: ${error.code}`
            : t("detectTestRule", {
                mark: probability !== undefined && probability >= rule.threshold ? "●" : "○",
                rule: rule.id,
                probability: probability === undefined ? "-" : probability.toFixed(3),
                threshold: rule.threshold,
                action,
              }),
        );
        ctx.ui.notify(
          [t("detectTestResult", { kind: units[0]?.kind ?? "text", elapsed: Date.now() - started }), ...lines].join("\n"),
          results.some((r) => r.error) ? "warning" : "info",
        );
      } catch (error) {
        ctx.ui.notify(record(sanitizeError(error, "TEST_INPUT").diagnostic), "error");
      }
      return;
    }
    ctx.ui.notify(t("detectUsage"), "info");
  };

  pi.registerCommand("protecter", {
    description: t("commandDescription"),
    handler: async (args, ctx) => {
      const raw = args.trim();
      const parts = raw.split(/\s+/).filter(Boolean);
      const action = parts[0] ?? "logs";
      if (action === "detect") {
        await detectCommand(raw.slice(action.length).trim(), ctx);
        return;
      }
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
      const engineDiagnostic = engine.lastDiagnostic;
      const last = engineDiagnostic
        ? [formatDiagnostic(engineDiagnostic), ruleEntries(engineDiagnostic)].filter(Boolean).join("\n")
        : lastBlock
          ? [lastBlock.text, lastBlock.local].filter(Boolean).join("\n")
          : undefined;
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
      })}\n${t("statusDetection", {
        mode: detectMode(),
        rules: detector.settings.rules.length,
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
