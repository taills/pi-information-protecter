# Changelog / 更新日志

## 0.15.1 — Exact-content path approval / 路径授权校验内容一致

### Changed / 变更

- Path-based attachment approval now requires both the same path and the same content. If the content at an approved path changes, the user is asked again; attachments whose content cannot be read are never remembered by path.
  按路径免询问现在要求路径和内容都相同。已允许路径的内容若有变化会重新询问；无法读取内容的附件不会按路径记住。

## 0.15.0 — Attachment paths and explicit rule conflicts / 附件路径与明确的规则冲突

### Added / 新增

- Show the attachment's local file path in the consent menu when it is known. Pi's image content carries no path, so images read by a tool (for example `read`) are mapped back to the path in that tool call; directly pasted or attached images are reported as having no path.
  在附件确认菜单中展示已知的本地文件路径。Pi 的图片内容不含路径，因此由工具（如 `read`）读取的图片会按该工具调用中的路径反查；直接粘贴或附加的图片会如实提示无路径。
- Once an attachment from a known path is allowed, later attachments from the same path are allowed for the rest of the session without asking. Edited images do not approve their path, so the unedited original is never sent silently later.
  已知路径的附件一经允许，本会话内同一路径的后续附件直接放行，不再询问。编辑过的图片不会记住其路径，避免之后静默发送未编辑的原图。
- Blocks that name rules (such as `FIXED_OVERLAP`) now list the exact configuration entries for `rule` and `otherRule` in the local notification and `/protecter status`. These entries are never included in tool-call block reasons visible to the model.
  指明规则的拦截（如 `FIXED_OVERLAP`）现在会在本地通知和 `/protecter status` 中列出 `rule` 与 `otherRule` 对应的完整配置条目；这些条目绝不会出现在模型可见的工具调用拦截原因中。

### Fixed / 修复

- Recognize inline images in Anthropic (`source.type: "base64"`) and OpenAI (`data:` URL in `image_url`) request formats, so they can be previewed and edited instead of only allowed or cancelled. Edited bytes are written back in the same provider format; remote image URLs remain opaque.
  识别 Anthropic（`source.type: "base64"`）和 OpenAI（`image_url` 中的 `data:` URL）请求格式的内嵌图片，使其可预览和编辑，而不再只能放行或取消。编辑后的数据按原提供商格式写回；远程图片 URL 仍按不透明附件处理。

## 0.14.3 — Use Pi-provided UI packages / 使用 Pi 宿主提供的界面包

### Fixed / 修复

- Declare `@earendil-works/pi-tui` as a host-provided peer dependency (`*`) instead of installing a duplicate runtime copy. This prevents extension-loader warnings and duplicate TUI modules.
  将 `@earendil-works/pi-tui` 声明为 Pi 宿主提供的 peer 依赖（`*`），不再安装重复的运行时副本，避免扩展加载器警告和重复 TUI 模块。

## 0.14.2 — Edit images before sending / 发送前编辑图片

### Added / 新增

- Add an option to edit supported inline images with the operating system's default image application. The editor receives a private temporary copy; after the user saves over that file and confirms, only the saved image bytes replace the attachment in the provider request. The source attachment is unchanged, temporary files are removed, and request text still follows normal redaction. Support PNG, JPEG, WebP and GIF images up to 25 MiB.
  新增使用系统默认图片软件编辑支持的内嵌图片。编辑器打开私有临时副本；用户覆盖保存并确认后，仅将保存后的图片数据替换到提供商请求中。原附件不变，临时文件会清理，请求文本仍正常脱敏。支持不超过 25 MiB 的 PNG、JPEG、WebP 与 GIF 图片。

## 0.14.1 — Review attachments individually / 逐项查看并确认附件

### Added / 新增

- Add an inline TUI preview for each new image in the attachment consent menu. Opening a preview returns to that image's own decision; each newly attached image requires a separate confirmation, and approval does not authorize other images. Exact image content already approved in this session is remembered when repeated in conversation history. Attachments remain uninspected and unredacted; request text still follows normal redaction.
  在附件确认菜单中为每张新图片增加 TUI 内预览。关闭预览后返回该图片自己的确认菜单；每张新添加的图片都需单独确认，放行不会授权其他图片。本会话中已确认过的相同图片内容在历史记录中重复出现时会记住确认状态。附件仍不检查、不脱敏；请求文本继续正常脱敏。

### Changed / 变更

- Clarify that allowing compaction continues this compaction only after redacting its content; it does not bypass redaction.
  明确允许压缩仅表示先脱敏再继续本次压缩，不会跳过脱敏。

## 0.14.0 — Ask before passing attachments / 附件放行前先询问

### Changed / 变更

- Ask before sending opaque image, audio, video or file content (default `attachments: "ask"`). An explicit per-request choice can allow the unchanged attachment or cancel it; `"allow"` and `"deny"` configure a permanent policy. Attachment-free requests continue through normal redaction.
  发送不透明的图片、音频、视频或文件内容前先询问（默认 `attachments: "ask"`）。用户可明确选择原样发送附件或取消请求；也可用 `"allow"` 和 `"deny"` 配置固定策略。没有附件的请求仍按原有流程脱敏。
- Merge attachment settings conservatively across configuration files: deny takes precedence over ask, which takes precedence over allow.
  多份配置合并附件策略时从严处理：拒绝优先于询问，询问优先于允许。

## 0.13.0 — Capabilities, not a version allowlist / 以能力为准，而非版本白名单

### Changed / 变更

- Replace the Pi version allowlist with a capability probe. At session start the extension checks what this Pi build actually exposes — `pi.on()`, `pi.registerCommand()`, `pi.registerMarkdownTransformer()`, `ctx.abort()`, `ctx.ui.notify()`, `ctx.ui.setStatus()` and `ctx.modelRegistry` — and only a missing capability stops it. The block names the missing capability and points at `https://github.com/taills/pi-information-protecter/issues/new`, because a user cannot fix Pi internals and a report is the only useful action. A Pi upgrade therefore keeps working instead of disabling protection on the day Pi releases a new minor.
  将 Pi 版本白名单改为能力探测。会话启动时检查当前 Pi 构建实际暴露的能力——`pi.on()`、`pi.registerCommand()`、`pi.registerMarkdownTransformer()`、`ctx.abort()`、`ctx.ui.notify()`、`ctx.ui.setStatus()` 与 `ctx.modelRegistry`——仅在能力缺失时停止运行。拦截时会列出缺失的能力并给出 `https://github.com/taills/pi-information-protecter/issues/new`，因为用户无法修改 Pi 内部实现，反馈是唯一有用的处理。因此 Pi 升级后扩展仍可用，不再一发新次版本就停止保护。
- Only capabilities whose absence would send plaintext can block. `waitForIdle`, `reload`, `ctx.ui.select`, `confirm` and `editor` belong to command interaction: missing ones degrade `/protecter`, so they no longer stop redaction.
  只有缺失会导致发送明文的能力才会拦截。`waitForIdle`、`reload`、`ctx.ui.select`、`confirm` 与 `editor` 属于命令交互，缺失只会削弱 `/protecter`，不再停止脱敏。
- Widen the declared peer range to `>=0.84.0` (excluding 0.85.0, 1.0.x and 1.1.0, which fail to load Pi itself). The diagnostic code `UNSUPPORTED_PI` becomes `PI_CAPABILITY`.
  将声明的 peer 范围扩宽为 `>=0.84.0`（排除自身无法加载的 0.85.0、1.0.x 与 1.1.0）。诊断码 `UNSUPPORTED_PI` 改为 `PI_CAPABILITY`。

### Added / 新增

- Verify the request hook per call. Payload-carrying calls are passed through because `before_provider_request` redacts them and `stream`/`streamSimple` must stay synchronous — an assumption no version check could confirm. The runtime guard now wraps Pi's awaited `onPayload` and counts this extension's own hook runs around it; if the hook did not run, the guard redacts that payload itself and reports it once. A renamed, reordered or removed hook can no longer become a silent plaintext leak, which is what makes dropping the allowlist safe.
  逐次校验请求钩子。带 payload 钩子的调用之前直通，是因为 `before_provider_request` 会对其脱敏且 `stream`/`streamSimple` 必须保持同步——这是任何版本检查都无法证实的假设。现在运行时闸门会包装 Pi 所 await 的 `onPayload`，并在其前后统计本扩展钩子的执行次数；钩子未执行时由闸门自行脱敏并提示一次。钩子被改名、调序或移除不再可能变成静默的明文泄露，这正是可以去掉白名单的前提。
- Verify Pi 1.4.0 with the full suite and announce, once per session, any release beyond the verified set (`0.84.0-0.84.x, 0.85.1-0.87.x, 0.99.x, 1.2.0-1.4.x`) instead of refusing it.
  对 Pi 1.4.0 运行完整测试验证；超出已验证集合（`0.84.0-0.84.x、0.85.1-0.87.x、0.99.x、1.2.0-1.4.x`）的版本不再被拒绝，每会话提示一次。

## 0.12.0 — Offline rule testing without a model / 无需模型的离线规则测试

### Added / 新增

- Add `/protecter test <text>` and `/protecter test @<path>`: redact local text or a local text file (up to 256 KiB) and show the result, without sending anything to a model. It runs the same rules, the same worker and the same mapping table as a real request, so a new rule can be verified offline; the run writes an audit record and the replacements it learns stay in the session mapping. The path is read with `lstat`, so a symbolic link cannot redirect the read, and unreadable or oversized input reports `TEST_INPUT`/`TEST_SIZE` instead of a raw path or message.
  新增 `/protecter test <文本>` 与 `/protecter test @<路径>`：对本地文本或本地文本文件（上限 256 KiB）脱敏并展示结果，全程不向模型发送内容。它与真实请求走同一套规则、同一个 worker 和同一张映射表，因此可离线验证新规则；本次运行会写入审计记录，学到的替换关系也保留在会话映射中。路径使用 `lstat` 读取，符号链接无法改变读取目标；不可读或超大输入返回 `TEST_INPUT`/`TEST_SIZE`，而不暴露路径或原始消息。

## 0.11.1 — Documented IP rules, and a README that leads with coverage / 文档内的 IP 规则，以覆盖范围开篇的 README

### Added / 新增

- Add IPv4 and IPv6 rules to the README configuration example. IPv6 needs two patterns, because the `::`-compressed form is a different shape from the full one. The patterns are the ones already shipped in `protecter.example.json`.
  在 README 的配置示例中加入 IPv4 与 IPv6 规则。IPv6 需要两条正则，因为 `::` 压缩形式与完整形式的形态不同。所用正则与 `protecter.example.json` 中随包发布的一致。
- Test the README examples the way the shipped example file is tested: every documented configuration must load through the extension's own parser, and the documented address rules must produce addresses that `net.isIPv4`/`net.isIPv6` still accept, keep the compressed IPv6 shape, and round-trip on restoration. A documented rule that does not work is now a test failure.
  像对待随包示例文件那样测试 README 示例：文档中的每份配置都必须能通过本扩展自己的解析器加载，文档中的地址规则必须产出 `net.isIPv4`/`net.isIPv6` 仍然接受的地址、保持 IPv6 压缩形态，并在还原时精确往返。文档里不能用的规则现在会导致测试失败。

### Changed / 变更

- Restructure the README around two questions: what is redacted and what is not, then how to develop and debug. The coverage answer comes first, before installation, as two tables — every model request and how it is covered, and every transfer that is not a model request, with `/bug`, `/share`, `/export`, tools, MCP servers, shell, request headers and session files named explicitly together with the reason no extension can intercept them.
  围绕两个问题重构 README：哪些会脖敏、哪些不会，以及如何开发与调试。覆盖范围的答案置于安装之前，以两张表格呈现——所有模型请求及其覆盖方式，以及所有不属于模型请求的传输，并明确点出 `/bug`、`/share`、`/export`、工具、MCP 服务器、shell、请求头与会话文件，连带任何扩展都无法拦截的原因。
- Add a development and debugging section: the commands, running from source against a throwaway `PI_CODING_AGENT_DIR`, a map of `src/`, how to reproduce a block as a test instead of against a live gateway, which tests cover the hookless paths and the packed tarball, and how to widen the Pi version gate.
  新增开发与调试章节：常用命令、使用一次性 `PI_CODING_AGENT_DIR` 从源码运行、`src/` 代码位置一览、把问题复现成测试而不是打到真实网关、哪些测试覆盖无钩子路径与打包产物，以及如何扩大 Pi 版本门禁。
- Pin the `@earendil-works/pi-coding-agent` development dependency to an exact version again. 0.11.0 recorded `^1.3.0`, so a fresh clone could install a Pi release the runtime gate refuses, which fails every test for a reason that has nothing to do with the change under test.
  将 `@earendil-works/pi-coding-agent` 开发依赖重新固定为精确版本。0.11.0 记录的是 `^1.3.0`，全新克隆可能装到运行时门禁拒绝的 Pi 版本，导致所有测试因与待测改动无关的原因失败。
- Cut implementation detail that belongs in `SECURITY.md` and this changelog (hook names, worker internals, long code lists), and drop the pinned-version install example, which drifted behind every release. The README is 53.6 KB to 31.5 KB with both languages mirrored section for section.
  删去应留在 `SECURITY.md` 与本更新日志的实现细节（钩子名称、worker 内部、冗长的错误码清单），并移除每次发布都会落后的固定版本安装示例。README 从 53.6 KB 精简至 31.5 KB，两种语言逐节对应。

## 0.11.0 — Pi summarizes again, and every hookless path is covered / 摘要交回 Pi，并覆盖所有无钩子路径

### Changed / 变更

- Stop summarizing in this extension. Pi hands `session_before_compact` the same `preparation` object it then summarizes, so what Pi is about to summarize is now redacted in place and Pi summarizes it with the session's own model. A single configured model is therefore enough, and routing, credentials, retries and the token budget stay with Pi. Deleted with it: the second model's credential resolution, the stream-function compatibility shim, the local degraded summary and the early-compaction threshold — the most failure-prone code in the extension.
  本扩展不再生成摘要。Pi 交给 `session_before_compact` 的 `preparation` 正是它随后用于摘要的同一对象，因此现在对 Pi 即将摘要的内容原地脖敏，再由 Pi 用会话自身的模型生成摘要。因此只配一个模型即可，且路由、凭证、重试与 token 预算仍由 Pi 负责。同时删除：第二个模型的凭证解析、流函数兼容层、本地降级摘要与提前压缩阈值——这些是本扩展最易出错的代码。
- Keep the stored compaction summary redacted instead of restoring it. The session file now holds no plaintext summary, which also keeps it out of `/bug`, `/share` and `/export`. The summary is displayed with its replacements.
  保存的压缩摘要不再还原。会话文件中不再存在明文摘要，也因此不会进入 `/bug`、`/share` 与 `/export`。摘要以替换值展示。
- Accept but ignore `compaction.provider`, `compaction.model`, `compaction.contextWindow` and `compaction.reserveTokens`, and report them at startup. Rejecting them would fail the whole configuration closed and block every request of a setup that worked before the upgrade.
  `compaction.provider`、`compaction.model`、`compaction.contextWindow` 与 `compaction.reserveTokens` 仍被接收但不生效，并在启动时提示。直接拒绍会使整份配置失败，并拦住升级前原本可用环境的所有请求。

### Added / 新增

- Cover every provider call that has no extension hook. Only the agent loop's requests carry Pi's `onPayload` callback; the `/bug` report summary has no event at all and its command cannot be shadowed, because the interactive editor handles `/bug` before extension dispatch, and nested calls from `codemode` scripts (`models.classify()`, `models.generateImages()`) or other extensions are equally invisible. `session_start` now wraps the call methods of the one model runtime the session shares: requests carrying the payload hook pass through untouched, keeping the synchronous lazy stream the prompt-cache warmer needs, and every other call is redacted first.
  覆盖所有没有扩展钩子的提供商调用。只有智能体循环的请求携带 Pi 的 `onPayload` 回调；`/bug` 报告摘要没有任何事件，其命令也无法被遮蔽（交互式编辑器在扩展分发之前就处理了 `/bug`），`codemode` 脚本（`models.classify()`、`models.generateImages()`）与其他扩展的嵌套调用同样不可见。`session_start` 现在包装会话共享的那一个模型运行时的调用方法：携带请求钩子的请求原样直通，以保留提示缓存预热所需的同步惰性流，其余调用一律先脖敏。
- Wrap the classifier and image-model calls only where Pi has them: they joined the model runtime in 0.99, and earlier supported releases have no such provider path, so coverage stays complete there without them. `complete` and `completeSimple` delegate through `stream` and `streamSimple` in every supported release, so wrapping those two covers them too. A regression asserts this surface against Pi's own classes, so a rename fails the suite instead of quietly dropping coverage. Verified by running the full suite against 0.84.4, 0.85.1, 0.86.1, 0.87.1, 0.99.2, 1.2.0 and 1.3.0.
  分类与图像模型调用仅在 Pi 具备时包装：它们在 0.99 加入模型运行时，更早的受支持版本没有该提供商路径，因此没有它们也仍然覆盖完整。在所有受支持版本中，`complete` 与 `completeSimple` 都经 `stream`、`streamSimple` 转发，因此包装这两个即可连带覆盖。新增回归直接对 Pi 自身的类做断言，重命会导致测试失败而不是静默丢掉覆盖。已在 0.84.4、0.85.1、0.86.1、0.87.1、0.99.2、1.2.0 与 1.3.0 上运行完整测试验证。
- Add `GUARD_UNAVAILABLE`: the guard wraps methods internal to Pi, so its target is verified at startup and a runtime that cannot be wrapped blocks every request instead of running unprotected. `/protecter status` reports whether the hookless paths are covered.
  新增 `GUARD_UNAVAILABLE`：该闸门包装的是 Pi 内部方法，因此在启动时校验其目标；无法包装时拦住所有请求，而不在无保护状态下运行。`/protecter status` 会显示无钩子路径是否已覆盖。
- Add `COMPACT_INSTRUCTIONS`: `/compact <instruction>` is cancelled when the instruction holds a protected value, because Pi reads those instructions from its own state rather than from the event, so a redacted copy would be ignored. `/tree` does read its instructions back, so there they are returned redacted. Automatic compaction has no instructions and is unaffected.
  新增 `COMPACT_INSTRUCTIONS`：当 `/compact <指令>` 的指令含受保护值时取消，因为 Pi 从自身状态而非事件读取指令，脖敏副本不会被采用。`/tree` 会读回指令，因此在那里返回脖敏后的指令。自动压缩没有指令，不受影响。
- Document what still cannot be intercepted: `/bug`'s uploaded bundle, `/share` and `/export` send the stored transcript over their own HTTP paths, which no extension API can reach. Only the `/bug` summarization request is covered.
  记录仍无法拦截的部分：`/bug` 上传的报告包、`/share` 与 `/export` 通过各自的 HTTP 路径发送已保存的会话记录，任何扩展 API 都无法触及。仅 `/bug` 的摘要请求在覆盖范围内。

### Removed / 删除

- Remove `COMPACT_UNAVAILABLE`, `COMPACT_EMPTY` and `CONFIG_COMPACT_MODEL`: no credential resolution, empty-summary check or model lookup happens in this extension any more.
  删除 `COMPACT_UNAVAILABLE`、`COMPACT_EMPTY` 与 `CONFIG_COMPACT_MODEL`：本扩展不再做凭证解析、空摘要判定或模型查找。

## 0.10.0 — Pi 1.x compatibility / 兼容 Pi 1.x

### Added / 新增

- Accept Pi 0.99.x and 1.2.0–1.3.x, established by running the full suite, including the real loader and worker integration tests, against 0.87.1, 0.99.2, 1.2.0 and 1.3.0. The runtime gate refused every 0.88+ version, so on current Pi releases the extension failed every request closed with `UNSUPPORTED_PI` while the status bar still showed it as loaded.
  接收 Pi 0.99.x 与 1.2.0–1.3.x，依据是在 0.87.1、0.99.2、1.2.0 和 1.3.0 上运行完整测试（含真实加载器与 worker 集成测试）。之前运行时门禁拒绍所有 0.88+ 版本，因此在当前 Pi 上每个请求都以 `UNSUPPORTED_PI` 被拦，状态栏却仍显示已加载。
- Document that nested model calls outside the agent loop are not redacted: a `codemode` script's `models.classify()` or `models.generateImages()`, and any `modelRegistry` call another extension makes, carry no `onPayload` callback. Pi 0.99.0 added `codemode`, MCP and tool search as built-in extensions, so this boundary is new.
  记录智能体循环之外的嵌套模型调用不会脖敏：`codemode` 脚本的 `models.classify()`、`models.generateImages()` 以及其他扩展的 `modelRegistry` 调用都不携带 `onPayload` 回调。Pi 0.99.0 新增了内置的 `codemode`、MCP 与工具检索扩展，因此这是新的边界。

### Changed / 变更

- Refuse Pi 1.0.x and 1.1.0: both depend on `@earendil-works/pi-codemode: ^1.0.4`, which now resolves to 1.3.0, whose missing `MCP_TYPESCRIPT_PREAMBLE` export makes Pi itself throw while loading. This mirrors the existing 0.85.0 exclusion — Pi's own unresolvable import, not an extension defect.
  拒绝 Pi 1.0.x 与 1.1.0：二者依赖 `@earendil-works/pi-codemode: ^1.0.4`，它如今解析到 1.3.0，而该版本已不导出 `MCP_TYPESCRIPT_PREAMBLE`，导致 Pi 自身在加载时抛错。这与现有的 0.85.0 排除同理：问题出在 Pi 自身无法解析的引用，而非扩展缺陷。
- Build and verify against Pi 1.3.0 and widen the declared peer range to match the runtime gate exactly.
  构建与验证基线改为 Pi 1.3.0，并将声明的 peer 范围与运行时门禁保持完全一致。

## 0.9.0 — A dedicated summarization model / 专用摘要模型

### Added / 新增

- Support a dedicated summarization model through `compaction.provider` and `compaction.model`. `contextWindow` is inherited from Pi's model catalogue and `reserveTokens` from Pi's own compaction settings, so both are overrides rather than required fields. Summarizing sends the whole conversation, redacted, to a second destination, so it can now be a local or otherwise trusted endpoint.
  通过 `compaction.provider` 与 `compaction.model` 支持专用摘要模型。`contextWindow` 继承自 Pi 的模型目录，`reserveTokens` 继承自 Pi 自身的压缩设置，二者均为覆盖项而非必填。生成摘要会把脱敏后的整段对话发往第二个目的地，现在它可以是本地或其他可信端点。
- Drive the compaction threshold from the summarization model's window instead of the main model's. Pi compacts near the main window, about 983k tokens for a 1M model, which a 256k summarizer cannot read; compaction now happens at the summarization model's window minus the reserve.
  压缩阈值改为依据摘要模型的窗口而非主模型。Pi 在主窗口附近压缩（1M 模型约 98.3 万 token），而 256k 的摘要模型读不下；现在按摘要模型窗口减去预留触发。
- Resolve and report a configured summarization model at startup, and never fall back to the main model when it cannot be resolved, which would send the conversation to a destination the user did not choose.
  在启动时解析并反馈配置的摘要模型；无法解析时不回退到主模型，以免把对话发往用户未选择的目的地。
- Show the compaction target and effective threshold in `/protecter status`.
  在 `/protecter status` 中显示压缩目标与生效阈值。

### Fixed / 修复

- Record the summarization provider in the audit log instead of the conversation's provider. The audit answers where plaintext went, so filing a summary sent to a dedicated model under the main model's provider made that record wrong.
  审计日志记录摘要使用的 provider，而非对话模型的 provider。审计的作用是回答明文去了哪里，把发往专用模型的摘要记在主模型名下会使该记录失真。

### Changed / 变更

- Degrade to a local, deterministic summary when the summarization call fails or returns nothing, instead of cancelling compaction. The local summary is built from the same redacted messages and sends nothing. Compaction still cancels if redaction itself fails.
  摘要调用失败或返回空时降级为本地确定性摘要，而不再取消压缩。本地摘要基于同一批已脱敏消息生成且不发送任何内容；若脱敏本身失败，压缩仍然取消。

## 0.8.4 — Summarization failures report their kind / 摘要失败上报失败类型

### Added / 新增

- Report the error class name and HTTP status when summarization fails. A single opaque `COMPACT_FAILED` could not separate authentication, transport and argument errors, so a failing `/compact` gave nothing to act on. The provider message is still never surfaced, and a class name that is not a plain identifier is dropped.
  摘要失败时上报错误类名与 HTTP 状态码。单一不透明的 `COMPACT_FAILED` 无法区分认证、传输与参数错误，压缩失败时无从下手。仍然不输出提供商消息；非普通标识符的类名会被丢弃。
- Add a regression asserting the kind is reported while the provider message and any protected value are not.
  新增回归，断言上报失败类型而不输出提供商消息与受保护值。

## 0.8.3 — Summarize through the model registry / 经由模型注册表生成摘要

### Fixed / 修复

- Route summarization through `modelRegistry.streamSimple`, falling back to `complete` before Pi 0.86. Passing no stream function made the summarizer issue a bare provider call with only the resolved key, bypassing Pi's request preparation, which is what refreshes OAuth tokens and applies provider base URLs. Compaction therefore failed with `COMPACT_FAILED` on providers that need either.
  摘要改为经由 `modelRegistry.streamSimple` 发起，Pi 0.86 之前回退到 `complete`。此前不传流函数会导致摘要仅用已解析的密钥发起裸请求，绕过 Pi 的请求准备（OAuth 令牌刷新与 provider 地址由其处理），因此在需要二者的提供商上压缩以 `COMPACT_FAILED` 失败。
- Add a regression asserting a stream function is always passed, that `streamSimple` is preferred and that `complete` is used when it is absent.
  新增回归，断言始终传入流函数、优先使用 `streamSimple`、缺失时使用 `complete`。

## 0.8.2 — Compaction diagnostics say what happened / 压缩诊断如实说明原因

### Fixed / 修复

- Add catalog text for `COMPACT_DENIED`, `COMPACT_UNAVAILABLE`, `COMPACT_FAILED` and `CONFIG_COMPACTION`. They were registered in 0.8.0 with a stage but no text, so every one rendered the `INTERNAL` fallback, in English regardless of locale, and told users to check the installed package instead of describing the real failure.
  为四个压缩相关错误码补充文案。0.8.0 中它们只注册了阶段而没有文案，导致全部回退为 `INTERNAL` 文案，且不分语言都显示英文，提示用户去检查安装包而非说明真实原因。
- Keep the sanitized cause when summarization fails, so the reported code reflects the actual failure instead of always being `COMPACT_FAILED`. The provider message is still never surfaced.
  摘要失败时保留净化后的原因，使上报的错误码反映真实失败，而不总是 `COMPACT_FAILED`；仍然不输出提供商消息。

### Added / 新增

- Add a regression asserting that every registered diagnostic code has text in both languages, so a code can no longer ship with the fallback text.
  新增回归，断言每个已注册的诊断码在两种语言中都有文案，避免再次带着回退文案发布。

## 0.8.1 — Example Bearer rule no longer matches short strings / 示例 Bearer 规则不再匹配短字符串

### Fixed / 修复

- Require at least 16 characters in the shipped Bearer rule. `(?<=Bearer )[A-Za-z0-9._~+/-]+=*` matched a single character and ordinary words such as `token`. A short match has few shape-preserving candidates, and on a compaction payload, which holds the whole conversation, every candidate already occurs, so `/compact` failed with `SCAN_UNIQUE_FAILED`.
  示例 Bearer 规则要求至少 16 个字符。原规则会匹配单个字符和 `token` 这类普通单词；短匹配的同形候选值很少，而压缩载荷包含整个会话，每个候选值都已出现，导致 `/compact` 以 `SCAN_UNIQUE_FAILED` 失败。
- Add a regression asserting that no shipped rule matches a string of four characters or fewer.
  新增回归，断言示例中任何规则都不会匹配四个及以下字符的字符串。

### Documentation / 文档

- Warn against rules that can match a very short string, and show a minimum-length pattern instead.
  提示避免可能匹配极短字符串的规则，并给出带最小长度的写法。

## 0.8.0 — Protected summarization / 受保护的摘要生成

### Added / 新增

- Support context compaction by generating the summary from redacted text. Pi builds the summarization request internally and passes no `onPayload` callback, so `before_provider_request` never fires for it; compaction was therefore cancelled outright. The extension now redacts the messages, previous summary and custom instructions, summarizes the redacted text, and restores the summary locally before it is stored.
  通过基于脱敏文本生成摘要来支持上下文压缩。Pi 在内部构造摘要请求且不传递 `onPayload` 回调，`before_provider_request` 对其不会触发，因此之前直接取消压缩。现在扩展会先脱敏消息、历史摘要和自定义指令，对脱敏文本生成摘要，并在保存前于本地还原。
- Add the `compaction` configuration field: `ask` (default) confirms each compaction, `protected` summarizes without asking, and `off` always refuses. The prompt offers allow once, allow for this session, deny once and deny for this session; dismissing it denies that compaction.
  新增 `compaction` 配置字段：`ask`（默认）每次确认，`protected` 不询问直接生成，`off` 始终拒绝。弹窗提供允许一次、本会话全部允许、拒绝一次、本会话全部拒绝；关闭对话框视为拒绝。
- Add `COMPACT_DENIED`, `COMPACT_UNAVAILABLE`, `COMPACT_FAILED` and `CONFIG_COMPACTION` diagnostics. Any compaction failure cancels instead of falling back to Pi's unredacted summarization.
  新增四个诊断码。压缩任何失败均取消，而不回退到 Pi 未脱敏的摘要流程。
- Add regressions asserting that no protected value reaches the model, that the previous summary and custom instructions are redacted too, that provider errors never carry the original, and that the mode is validated and survives configuration merging.
  新增回归：断言受保护值不会到达模型、历史摘要与自定义指令同样脱敏、提供商错误不携带原文，以及模式经校验且能在配置合并中保留。

- Protect summarized `/tree` navigation the same way, from redacted session entries, sharing the `compaction` setting and the same prompt. Navigation without a summary sends nothing and is never gated.
  以同样方式保护带摘要的 `/tree` 导航：基于脱敏后的会话条目生成，并共用 `compaction` 设置与同一弹窗。不生成摘要的导航不发送任何内容，也不会被拦截。

## 0.7.1 — Install the latest release by default / 默认安装最新版本

### Documentation / 文档

- Install with an unpinned spec by default. The example pinned `@0.5.0`, so anyone copying it installed a release missing every later fix. Document the pinned form as the deliberate choice and add the upgrade command.
  默认使用不带版本号的安装命令。此前示例固定在 `@0.5.0`，照抄的用户会装到缺少后续全部修复的版本。固定版本改为需显式选择，并补充升级命令。

## 0.7.0 — Verified Pi compatibility range / 经验证的 Pi 兼容范围

### Changed / 变更

- Accept Pi 0.84.0-0.84.x and 0.85.1-0.87.x, established by running the full suite, including the real loader and worker integration tests, against every candidate release. The previous range was wrong in both directions: the whole 0.84 line and 0.87.0 pass but were refused, which fails every request closed while the status bar still shows the extension as loaded.
  接受 Pi 0.84.0-0.84.x 与 0.85.1-0.87.x，依据是在每个候选版本上运行完整测试（含真实加载器与 worker 集成测试）。之前的范围两个方向都错：整个 0.84 系列和 0.87.0 均可通过却被拒绝，而被拒绝时每个请求都拒绝放行，状态栏却仍显示扩展已加载。
- Keep 0.83.0 and earlier refused: they lack `registerMarkdownTransformer`, which this extension always registers, so loading fails outright.
  继续拒绝 0.83.0 及更早版本：它们缺少本扩展必定注册的 `registerMarkdownTransformer`，加载直接失败。
- Keep 0.85.0 refused: it ships `dist/experimental/server.js` importing `@earendil-works/pi-server`, which no Pi release declares as a dependency, so the module cannot resolve. This is a Pi packaging defect, not an extension limit.
  继续拒绝 0.85.0：其 `dist/experimental/server.js` 引用了任何 Pi 版本都未声明的 `@earendil-works/pi-server`，模块无法解析。这是 Pi 的打包缺陷，不是扩展限制。

### Fixed / 修复

- Correct the `UNSUPPORTED_PI` message, which still named 0.85.x only after 0.86 support was added in 0.6.4. The advice now quotes the same constant the gate uses, so the two cannot drift again.
  修正 `UNSUPPORTED_PI` 文案：0.6.4 已支持 0.86，但提示仍只写 0.85.x。现在建议文案引用与门禁相同的常量，两者不会再次脱节。

### Added / 新增

- Move the version gate into `supportsPi()` and cover the accepted and refused boundaries, prerelease suffixes, and agreement between the gate and the advice text in both languages.
  将版本门禁抽取为 `supportsPi()`，并覆盖接受与拒绝边界、预发布后缀，以及门禁与两种语言建议文案的一致性。

## 0.6.4 — Pi 0.86 support / 支持 Pi 0.86

### Added / 新增

- Support Pi 0.86.x. The runtime gate accepted only 0.85.x, so on 0.86 every request failed closed with `UNSUPPORTED_PI`. Verified against 0.85.1, 0.86.0 and 0.86.1, including the real loader and worker integration tests.
  支持 Pi 0.86.x。运行时门禁只接受 0.85.x，因此在 0.86 上每个请求都以 `UNSUPPORTED_PI` 拒绝放行。已在 0.85.1、0.86.0 和 0.86.1 上验证，包含真实加载器与 worker 集成测试。

### Changed / 变更

- Wait up to six minutes for the registry to serve a published version, because npm accepts a publish before the read path serves it; a three-minute wait reported a false failure for an accepted 0.6.2 publish.
  发布后最多等待六分钟直到 registry 可读，因为 npm 接受发布早于读取端可见；三分钟的等待曾对已被接受的 0.6.2 发布报出虚假失败。

## 0.6.3 — Conversations no longer block after a rule learns a value / 规则学习到值后不再拦截会话

### Fixed / 修复

- Stop blocking a conversation once a regex rule has learned a value. Since 0.6.0 a replacement keeps the shape of what the rule matches, so the rule matches its own replacement in later turns; the alias-crossing guard treated that as a crossing and blocked every following request with `FIXED_ALIAS_CROSSING`. Only a match that straddles a replacement boundary is a crossing now; a match that is, or sits inside, a replacement is expected and skipped.
  正则规则学习到值之后不再拦截整个会话。0.6.0 起替换值与规则所匹配的内容同形，因此后续轮次中规则会匹配到自身的替换值；别名跨越防护把这种情况当作跨越，使之后每个请求都以 `FIXED_ALIAS_CROSSING` 被拦。现在只有横跨替换值边界的匹配才算跨越，匹配到替换值本身或其内部属于预期并跳过。
- Add a regression covering later turns that carry a learned replacement in history, while keeping the existing straddling-match rejection.
  新增回归，覆盖历史中带有已学习替换值的后续轮次，同时保留对横跨匹配的拒绝。

### Documentation / 文档

- Document that the model reasons about the replacement, so answers derived from a protected value, such as a digit position or a checksum, are wrong even though the value itself is restored in the reply.
  文档说明模型推理的是替换值，因此从受保护值推导出的答案（如第几位、校验位）是错的，尽管值本身在回复中会被还原。

## 0.6.2 — Numeric replacement retry and restoration / 数值替换重试与还原

### Fixed / 修复

- Retry numeric replacements instead of blocking the request. Validity was checked only after a candidate had been committed, so an unlucky draw aborted the request; roughly one request in ten failed with `SCAN_NUMBER_UNSAFE` when a rule matched a decimal, and about two in three when it matched an exponent.
  数值替换改为重试而不拦截请求。之前校验发生在候选值落定之后，随机抽到不合法的值就会终止请求：规则匹配小数时约十分之一的请求以 `SCAN_NUMBER_UNSAFE` 失败，匹配指数时约三分之二。
- Judge each numeric candidate inside the whole number rather than on its own, and keep exponent digits, a multi-digit integer part's leading digit and a fractional part's trailing digit structurally valid.
  在整个数值上下文中判断候选值，并保持指数位、多位整数部分的首位和小数部分的末位在结构上有效。
- Restore redacted numbers as numbers. Since 0.6.0 a numeric field keeps its JSON type, but restoration only walked strings, so a numeric tool argument was executed with the replacement value instead of the original.
  脱敏后的数字以数字还原。0.6.0 起数值字段保持 JSON 类型，但还原只遍历字符串，导致数值类工具参数会以替换值而非原值执行。
- Give a digit run an integer-safe shape even in text, so a value that appears both as a string and as a JSON number can share one mapping. A text shape could start with a leading zero, which the number form then rejected. Long digit strings beyond the safe-integer range keep working, because the range cap applies only to numeric fields.
  纯数字串即使在文本中也使用整数安全的形状，使同时以字符串和 JSON 数字出现的值共用一份映射。文本形状可能以前导零开头，而数字形式会拒绝。超出安全整数范围的长数字串仍可使用，因为范围限制仅适用于数值字段。
- Add a regression that repeatedly redacts decimals and exponents and asserts every field stays a finite JSON number.
  新增回归：反复脱敏小数与指数，断言每个字段仍为有限的 JSON 数字。
- Add a regression asserting that one value maps to one replacement across strings, object keys, numbers, nested structures and JSON-encoded tool arguments in the same request.
  新增回归：同一请求中的字符串、对象键、数字、嵌套结构和 JSON 编码的工具参数，同一值始终替换为同一个值。

### Notes / 说明

- A rule without digit boundaries can match inside an unrelated long number. Replacing digits in a value close to `Number.MAX_SAFE_INTEGER`, such as a tool schema upper bound, then pushed the result past the safe-integer range and blocked almost every request; add `(?<!\d)` and `(?!\d)` guards to numeric rules.
  没有数字边界的规则会在无关的长数字内部匹配。当数值接近 `Number.MAX_SAFE_INTEGER`（例如工具结构的上限）时，替换其中的数字会使结果超出安全整数范围，几乎拦截每个请求；请为数字规则加上 `(?<!\d)` 和 `(?!\d)` 边界。

## 0.6.1 — Valid address replacements / 合法的地址替换

### Fixed / 修复

- Keep replaced IPv4 addresses valid by bounding every octet to 0-255; per-character replacement produced octets such as `574.676.2.86`.
  替换后的 IPv4 保持每段在 0-255 内；逐字符替换会产生如 `574.676.2.86` 的非法地址。
- Keep replaced IPv6 addresses valid by replacing hex digits within the hexadecimal alphabet and preserving `::` compression, group widths and any embedded IPv4 tail; per-character replacement produced non-hex characters.
  替换后的 IPv6 保持合法：十六进制字符仍在十六进制范围内，并保留 `::` 压缩写法、分组宽度和末尾嵌入的 IPv4；逐字符替换会产生非十六进制字符。

### Added / 新增

- Add internal-domain, email, IPv4 and IPv6 rule examples to `protecter.example.json`, including a fixed-alias domain.
  在示例配置中新增内网域名、邮箱、IPv4 和 IPv6 规则示例，包含一个固定别名域名。
- Add regressions asserting `net.isIPv4`/`net.isIPv6` acceptance, `::` preservation, no false match on version-like numbers, and that the shipped example file loads and protects its targets.
  新增回归：验证替换结果通过 `net.isIPv4`/`net.isIPv6`、保留 `::`、不误匹配类版本号数字，以及发布的示例配置可加载并生效。

## 0.6.0 — Shape-preserving replacements and single-language messages / 同形替换与单语言消息

### Changed / 变更

- **Breaking:** replace matches with random values of the same shape instead of `__PIP_<hex>__` tokens, preserving length, case pattern, digits and punctuation positions so tool schemas, URLs, emails and embedded JSON stay valid.
  **破坏性变更：**命中内容改为同形随机值而非占位符，保留长度、大小写形态、数字和标点位置，使工具结构、URL、邮箱和内嵌 JSON 仍然有效。
- Keep numeric JSON values as numbers with the same digit count and safe-integer range, fixing provider errors such as `'9007199254740991' is not of type 'number'`.
  数值型 JSON 字段保持数字类型、位数和安全整数范围，修复类似 `'9007199254740991' is not of type 'number'` 的提供商错误。
- Replace characters within their own writing system, covering Latin with diacritics, Vietnamese, Greek, Cyrillic, Hebrew, Arabic, Thai, Hiragana, Katakana, Hangul and CJK; punctuation, whitespace, emoji and unknown code points stay unchanged.
  在各自文字体系内替换字符，覆盖带重音拉丁字母、越南语、希腊语、西里尔语、希伯来语、阿拉伯语、泰语、平假名、片假名、谚文及汉字；标点、空白、表情和未知码位保持不变。
- **Breaking:** render every notification, prompt and diagnostic in one language selected from `PI_PROTECTER_LANG`, `LC_ALL`, `LC_MESSAGES`, `LANG`, `LANGUAGE` or the runtime locale, instead of pairing English and Chinese in the same string; codes, stages and numeric details stay language-neutral.
  **破坏性变更：**通知、提示和诊断改为单一语言，按上述环境变量或运行时区域选择，不再在同一字符串中并列中英文；错误码、阶段和数值细节保持语言无关。
- Format counts with `Intl.PluralRules` and `Intl.NumberFormat` so quantities read naturally in each language.
  使用 `Intl.PluralRules` 和 `Intl.NumberFormat` 格式化数量，使各语言表达自然。

### Added / 新增

- Add `SCAN_NUMBER_UNSAFE` and `SCAN_UNIQUE_FAILED` diagnostics so numbers that cannot round-trip and matches with no unique replacement fail closed instead of corrupting a request.
  新增两个诊断码，使无法精确往返的数值和无唯一替换值的匹配拒绝放行，而不破坏请求。
- Add `RESTORE_COMPLEXITY` and `RESTORE_KEY_COLLISION` diagnostics for oversized or ambiguous restoration input.
  为过深或歧义的还原输入新增两个诊断码。
- Add regressions for numeric type preservation, per-script shapes, punctuation and emoji layout, collision avoidance, fail-closed paths and locale selection.
  新增回归，覆盖数值类型保持、各文字体系同形、标点与表情布局、冲突避免、失败拒绝路径及语言选择。

### Security / 安全

- Document that shape-preserving values leak length, character class and punctuation structure, look like plausible data, and may be restored when a model independently emits the same short string; prefer long, distinctive targets.
  文档说明同形值会泄露长度、字符类别和标点结构，看似真实数据，且模型自行输出相同短字符串时可能被还原，应优先使用较长且有辨识度的目标。

## 0.5.0 — Actionable block diagnostics / 可定位的拦截诊断

- Replace the single generic block message with a stable code, failing stage, reason and suggested action across initialization, configuration, migration, request, scan, worker and audit paths.
  将单一笼统拦截提示替换为稳定错误码、失败阶段、原因和处理建议，覆盖初始化、配置、迁移、请求、扫描、worker 和审计路径。
- Report rule and node coordinates, exceeded limits and OS `errno` where known, including codes propagated from both bounded workers.
  在已知时输出规则及节点定位、超限阈值和系统错误码，包括两个限时 worker 传递的错误码。
- Reuse the initialization cause for later blocked requests and tool calls, and repeat the last recorded block through `/protecter status`.
  后续被拦截的请求和工具调用复用初始化原因，并通过状态命令重新展示最近一次拦截。
- Keep diagnostics free of request text, matched originals, replacement values, configuration content, file paths and raw OS messages; requests still fail closed.
  诊断不包含请求文本、命中原文、替换值、配置内容、文件路径和原始系统消息；请求仍保持失败不放行。
- Add diagnostics regressions for sanitization, hostile worker payloads, per-stage codes and rule coordinates.
  新增诊断回归，覆盖净化、恶意 worker 数据、各阶段错误码和规则定位。

## 0.4.1 — Safe audit clearing / 安全审计清理

- Add `/protecter logs clear`, restricted to local TUI with explicit confirmation and idle waiting; cancellation and non-TUI modes never clear records.
  新增本地 TUI 确认及空闲等待的日志清理命令，取消或非 TUI 模式不清理。
- Serialize clearing with scans and the existing cross-process append lock; truncate and fsync the validated current log without deleting configuration, other logs or in-memory mappings.
  清理与扫描及现有跨进程写锁协调，对验证后的当前日志截断并同步，不删除配置、其他日志或内存映射。
- Cover missing/full/partial logs, unsafe links, occupied locks, resumed writes and source/packed command execution in regression tests.
  回归覆盖缺失、满容量、残缺日志、不安全链接、占用锁、恢复写入及源码和实际发布包命令执行。

## 0.4.0 — Fixed replacement aliases / 固定替换别名

- Add optional literal `replacement` strings to literal and regex rules; omitted targets retain stable per-instance random placeholders.
  字面与正则规则支持可选固定 `replacement` 字符串，省略时保持实例内稳定随机占位符。
- Restore fixed aliases locally in responses and tool arguments, and record the actual target in private audit logs, including JSON-escaped values.
  在本地响应和工具参数中还原固定别名，审计记录实际替换目标，支持 JSON 转义值。
- Reject invalid or sensitive targets, conflicting definitions, ambiguous inverse mappings and partial overlaps involving fixed rules; preserve targets during safe migration.
  拒绝非法或含敏感值的目标、冲突定义、歧义反向映射及固定规则部分重叠，安全迁移保留目标。
- Add fixed/random coexistence, multi-turn consistency and packed-distribution regressions; document reserved-alias and prompt-cache boundaries.
  增加固定与随机共存、多轮一致性和实际发布包回归，说明保留别名及提示词缓存边界。

## 0.3.0 — Private redaction audit / 私有脱敏审计

- Persist successful distinct original/token pairs per request in `protecter.<machineHash>.jsonl`, with local timestamp, UTC offset, provider ID and request ID. This intentionally adds plaintext sensitive data on disk; records represent local redaction, not confirmed network delivery.
  按请求持久化唯一原文与占位符到私有 JSONL，含本地时间、时区偏移、供应商及请求 ID；明确新增磁盘敏感明文，记录表示本地脱敏而非网络已送达。
- `/protecter` and `logs [1-100]` open a bounded local TUI viewer with confirmation; keep status/reload subcommands, never inject audit records into model/session context.
  命令提供有限本地查看及确认，保留状态和重载，不将审计注入模型或会话。
- Add private permissions, unsafe-link rejection, cooperative write locks, fsync, log limits and fail-closed audit errors; protect log paths and aliases from direct tools.
  增加私有权限、链接拒绝、协作写锁、落盘同步、日志限制及失败拒绝请求，保护日志路径和别名。
- Add source and packed-distribution regression coverage for audit writing and command UI.
  增加源码及实际发布包的日志写入和命令界面回归验证。

## 0.2.1 — Compiled distribution / 编译产物发布

- Publish compiled, bundled and minified ESM in `dist/`, including both workers; exclude source and source maps from npm packages.
  发布 `dist/` 中编译合并压缩后的 ESM 及两个 worker，npm 包不再包含源码或 source map。
- Build automatically before tests and packing; validate the actual tarball through Pi's loader and worker execution.
  测试及打包前自动构建，使用 Pi 加载器和 worker 执行验证真实压缩包。
- Separate README into full English and Simplified Chinese sections with top language links.
  README 改为完整英文在前、简体中文在后，顶部提供语言跳转链接。

## 0.2.0 — Machine configuration and memory cache / 机器配置与内存缓存

- Derive deterministic filenames from OS machine identifiers using a product-specific hash; never fall back to random IDs.
  使用产品专用哈希派生确定性机器配置名称，不回退随机标识。
- Validate and union-merge legacy/previous-machine configs before durable target writes and verified old-file deletion, with locking and retry-safe cleanup.
  校验并合并旧名称及旧机器配置，持久化验证目标后删除旧文件，支持锁与可重试清理。
- Cache rules at startup/reload; outgoing requests and status no longer read configuration files. Loaded protection survives file edits or deletion.
  启动和重载时缓存规则，出站请求和状态不再读配置；加载后的防护不受文件修改或删除影响。
- Make `/protecter reload` invoke Pi reload; check file-tool target paths instead of documentation content.
  重载命令调用 Pi 重载，文件工具改为检查目标路径而非文档正文。
- Add migration, failure-injection, concurrency and cache regression tests, plus bilingual migration documentation.
  增加迁移、故障注入、并发及缓存回归测试和双语迁移文档。

- Add tag-triggered GitHub Actions npm OIDC publishing, scoped environment permissions and manual dry-run validation.
  增加标签触发的 GitHub Actions npm OIDC 发布、限定环境权限及手动试运行验证。
- Document trusted publisher setup and the automated release procedure in both languages.
  以双语记录可信发布配置和自动发布流程。

## 0.1.0 — Initial release / 首个版本

**Sensitive Personal Information (SPI) Protecter — 个人敏感信息保护插件。**

### Added / 新增

- Local masking of final Pi provider request bodies, including system prompts, history, tool results and definitions.
  本地脱敏 Pi 最终请求体，覆盖系统提示、历史、工具结果和工具定义。
- `protecter.json` sensitive-word arrays, literal matching and JavaScript regular expressions.
  配置文件敏感词数组、字面匹配及 JavaScript 正则表达式。
- Random 192-bit placeholders, memory-only mappings and local final-response/tool-argument restoration.
  随机 192-bit 占位符、仅内存映射及最终回复和工具参数本地还原。
- TUI Markdown streaming restoration and continued exact-value protection for learned secrets.
  TUI Markdown 流式展示还原，以及已识别敏感值的持续精确匹配保护。
- Unix 0600 configuration permissions, direct-access guards and safe replacement payloads on configuration errors/timeouts.
  配置文件 Unix 0600 权限、直接访问拦截，以及配置异常和超时时的安全替代请求体。
- Worker regex execution limits; `/protecter status` and `/protecter reload`.
  worker 正则执行限制，以及状态和重载命令。
- Configuration examples, security guidance, bilingual documentation/comments and automated tests including real Pi loader/runner integration.
  配置示例、安全说明、双语文档和注释，以及包含真实 Pi 加载器／执行器集成的自动化测试。

### Compatibility and limitations / 兼容性与限制

- Node.js 22+ and Pi `@earendil-works/pi-coding-agent` 0.85.1–0.85.x; tested with 0.85.1.
  要求 Node.js 22+ 和该范围的 Pi，验证基线为 0.85.1。
- Empty initial rules require local configuration; not an automatic SPI detector.
  初始规则为空，需本地配置，不自动识别全部个人敏感信息。
- Compaction, summarized tree navigation and common multimodal attachments are not supported.
  暂不支持压缩、带摘要的树导航和常见多模态附件。
- RPC/JSON deltas keep placeholders until final restoration; mappings are not persisted across processes.
  RPC/JSON 增量保留占位符直到最终还原，映射不跨进程保存。
- Not a sandbox: arbitrary shell encoding can bypass protection. Independent networking, authentication headers, local sessions and exports are outside coverage. See SECURITY.md.
  不是沙箱，任意 shell 编码可绕过防护；独立联网、认证头、本地会话和导出不在保护范围，详见安全文档。
