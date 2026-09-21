# Changelog / 更新日志

## 0.6.2 — Numeric replacement retry and restoration / 数值替换重试与还原

### Fixed / 修复

- Retry numeric replacements instead of blocking the request. Validity was checked only after a candidate had been committed, so an unlucky draw aborted the request; roughly one request in ten failed with `SCAN_NUMBER_UNSAFE` when a rule matched a decimal, and about two in three when it matched an exponent.
  数值替换改为重试而不拦截请求。之前校验发生在候选值落定之后，随机抽到不合法的值就会终止请求：规则匹配小数时约十分之一的请求以 `SCAN_NUMBER_UNSAFE` 失败，匹配指数时约三分之二。
- Judge each numeric candidate inside the whole number rather than on its own, and keep exponent digits, a multi-digit integer part's leading digit and a fractional part's trailing digit structurally valid.
  在整个数值上下文中判断候选值，并保持指数位、多位整数部分的首位和小数部分的末位在结构上有效。
- Restore redacted numbers as numbers. Since 0.6.0 a numeric field keeps its JSON type, but restoration only walked strings, so a numeric tool argument was executed with the replacement value instead of the original.
  脱敏后的数字以数字还原。0.6.0 起数值字段保持 JSON 类型，但还原只遍历字符串，导致数值类工具参数会以替换值而非原值执行。
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
