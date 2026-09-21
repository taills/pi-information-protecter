# pi-information-protecter

[English](#english) · [简体中文](#简体中文)

## English

**Sensitive Personal Information (SPI) Protecter.**

A Pi extension that inspects outgoing LLM request bodies locally, replaces configured sensitive values with random placeholders, and restores echoed placeholders locally. Suitable for URLs, phone numbers, identity numbers, names, credentials and passwords. **This is rule-based accidental-disclosure protection, not a sandbox, automatic PII detector or encryption proxy.**

## Installation

Requires Node.js 22+ and `@earendil-works/pi-coding-agent` **0.84.0–0.84.x or 0.85.1–0.87.x**. Every accepted release was verified by running the full suite, including the real loader and worker integration tests. 0.83.0 and earlier lack `registerMarkdownTransformer`, and 0.85.0 imports `@earendil-works/pi-server`, which no Pi release declares, so both fail to load. Legacy `@mariozechner/*` releases are not supported.

```bash
# Install the latest npm release.
pi install npm:pi-information-protecter

# Pin a version only when you have a reason to; older releases miss fixes.
pi install npm:pi-information-protecter@0.7.0

# Alternatively, build and install from this repository without copying it.
npm ci
npm run build
pi install "$PWD"

# Load for one invocation.
pi -e ./src/index.ts

# Upgrade an existing installation.
pi update npm:pi-information-protecter
```

An unpinned spec installs the latest release; a pinned one stays on that version until you update it. Run `/reload` in an existing Pi session. Starting with `0.2.1`, npm releases ship compiled, minified ESM in `dist/`, not TypeScript source. Keep all three files together: `index.mjs`, `scan-worker.mjs` and `validate-worker.mjs`. Version `0.2.0` uses the previous source layout.

See [CHANGELOG.md](CHANGELOG.md) for version changes. Contribution and release instructions are in the repository's `CONTRIBUTING.md` and `docs/RELEASING.md`.

Maintainers publish new versions by pushing matching `v*` tags. GitHub Actions validates and publishes through npm OIDC trusted publishing without a long-lived token. Manual dry runs do not publish.

Initialization uses `~/.pi/agent/protecter.<machineHash>.json`, respecting `PI_CODING_AGENT_DIR`. The hash is the first 32 hex characters of SHA-256 over a product prefix and normalized OS ID: macOS `IOPlatformUUID`, Linux `/etc/machine-id`, Windows `MachineGuid`. Missing/invalid IDs fail initialization, without random fallback. The hash is a stable identifier, not a secret. Project-local configuration is not loaded.

At startup and `/reload`, recognized old configs (including legacy `protecter.json`) are validated, union-merged and deduplicated into the current target. The target is durably written and verified before unchanged old files are deleted. Invalid sources abort migration without deleting originals. Unix permissions are `0600`; unsafe links, foreign ownership and oversized files are rejected. Windows users must configure ACLs separately. See [migration details](docs/MIGRATION.md).

Validated configuration is cached per extension instance. Outgoing scans and status commands never reread or stat configuration files. Editing, corrupting or deleting files after loading does not alter the active snapshot. Changes take effect on `/reload` (or `/protecter reload`, which invokes Pi reload). A new instance after session replacement also initializes once. If all configs are deleted, the next initialization creates an empty config and warns; the old memory does not survive teardown.

## Configuration

**Edit the configuration in a local editor. Do not ask the model to enter real passwords or commit real configuration to Git.** The initial rule array is empty and provides no personal-information detection; the UI warns about this. The extension does not automatically identify all SPI.

```json
{
  "version": 1,
  "sensitiveWords": [
    "Alex Morgan",
    { "type": "literal", "value": "your-private-password" },
    { "type": "regex", "pattern": "https?://[^\\s\\\"<>]+", "flags": "i" },
    { "type": "regex", "pattern": "(?<!\\d)1[3-9]\\d{9}(?!\\d)" }
  ]
}
```

More examples are in [`protecter.example.json`](protecter.example.json), covering internal domains, email addresses, IPv4 and IPv6; they are not automatically enabled. Review the address and domain patterns before use: they match public values too, so a rule that is too broad can redact documentation examples, loopback addresses or dependency hosts. Number patterns do not validate authenticity or check digits. Prefer exact values for names and passwords.

- **Literals:** strings and `literal` rules match all case-sensitive occurrences, without regex interpretation.
- **Regex:** JavaScript regex replaces the entire match. Use lookbehind to match only a credential value. Flags `g i m s u` are supported; `g` is added automatically. `/pattern/flags` shorthand is not supported.
- Escape backslashes as `\\` in JSON. Empty-string matches are invalid; runtime zero-width matches reject the request.
- Overlapping matches are merged to avoid exposing a longer secret's suffix. Equal values reuse a token within the extension instance.
- Learned originals remain exact-match protected within the instance even if regex context disappears or a rule is removed. Exit/reload clears these records.
- `/protecter` opens the local audit viewer; `/protecter logs 50` shows up to 50 recent records. `/protecter status` reports memory counts without reading configuration. `/protecter reload` invokes Pi's full reload after idle. Do not enter secrets as command arguments.
- Limits: 1000 rules, 8192 characters per literal/pattern, 2-second scan timeout and 8 MiB request JSON. Exceeding limits rejects the request rather than sending plaintext.

### Fixed replacement values

Object rules accept an optional `replacement`. Omit it for the existing random behavior; strings still always use random placeholders. Empty, whitespace-only, non-string or over-8192-character targets are invalid (not a random fallback).

```json
{
  "version": 1,
  "sensitiveWords": [
    { "type": "literal", "value": "Apple Inc.", "replacement": "Alphabet Inc." },
    { "type": "literal", "value": "example-private-key-123", "replacement": "MyPrivateKey" },
    { "type": "literal", "value": "randomly-protected-value" }
  ]
}
```

Targets are literal text, not replacement templates: `$1` and `$&` are not expanded. Both literal and regex object rules support this field. Fixed aliases appear in audit records and are restored locally in replies and tool arguments after a successful scan. They are **reserved aliases**: naturally occurring identical response text will also be restored; choose distinctive targets and avoid ordinary words when that ambiguity matters. Fixed aliases expose more semantic information than random tokens.

For reversible protection, duplicate targets across different rules, substring-overlapping targets, targets containing configured sensitive values, reserved `__PIP_` names and conflicting definitions are rejected. A fixed regex can represent only one distinct matched original per instance; a second distinct original rejects the request. Partially overlapping matches involving fixed rules also reject rather than silently choose a rule or expose a suffix. Pure random-rule overlaps still merge. Migration preserves targets and refuses conflicting merges without deleting originals. Reload after editing; older plugin versions do not support this field.

### Shape-preserving replacements

Since 0.6.0 a matched value is replaced by a random value of the **same shape** instead of an opaque token, so requests stay schema-valid:

| Original | Replacement | Preserved |
| --- | --- | --- |
| `9007199254740991` (number) | `2844008842109708` (number) | JSON type, digit count, safe-integer range |
| `13800138000` | `06864831332` | length, digits only |
| `Alex.Morgan@Example.COM` | `Ufqz.Vwtudb@Rjdnpxe.HGZ` | length, case pattern, punctuation positions |
| `张三` | `丅欕` | CJK script, character count |
| `Nguyễn Văn Tèo` | `Ufefṉg Zżt Sàb` | Latin with diacritics, word boundaries |
| `ひらがな` | `ゅせはっ` | Hiragana |
| `192.168.1.10` | `101.203.3.77` | valid IPv4, octets ≤ 255 |
| `fe80::1ff:fe23:4567` | `af44::6ea:bf19:2700` | valid IPv6, `::` and group widths |

This fixes provider errors such as `'9007199254740991' is not of type 'number'`, which happened when a numeric field was replaced by a token string. Numeric JSON values stay numbers, keep their digit count and remain safe integers. Each candidate is judged inside the whole number and redrawn when it would not round-trip, so matching a decimal or an exponent no longer blocks the request; `SCAN_NUMBER_UNSAFE` remains only as a last resort, mainly when a value already mapped in text context reappears as a number.

Addresses are format-aware: an IPv4 match keeps every octet within 0-255, and an IPv6 match keeps hex digits hexadecimal along with `::` compression, group widths and any embedded IPv4 tail, so `net.isIPv4`/`net.isIPv6` and provider validators still accept them. A plain per-character replacement would otherwise yield octets above 255 or non-hex characters. Addresses embedded inside a longer match, such as a URL matched as a whole, still use per-character replacement.

Letters and digits are replaced inside their own writing system: ASCII, Latin-1, Latin Extended-A, Latin Extended Additional (including Vietnamese), Greek, Cyrillic, Hebrew, Arabic, Thai, Hiragana, Katakana, Hangul and CJK. Punctuation, whitespace, emoji, symbols and code points outside these ranges are kept unchanged, which is what keeps URLs, emails and embedded JSON parseable.

**This is a deliberate trade-off.** An opaque token revealed only that a redaction happened; a shape-preserving value also reveals length, character classes and punctuation structure, and it looks like plausible real data to the model. Text in unsupported scripts is preserved as-is, so a rule matching such text may leave part of it visible.

**The model reasons about the replacement, so answers derived from a protected value are wrong.** Asking for the third digit of a protected ID returns the third digit of the replacement, and only the value itself is restored in the reply, never the conclusion drawn from it. The answer therefore looks confident and consistent but does not match the restored value. An opaque token made this obvious, because the model could only report that it could not read the value. Do not ask the model about digits, checksums, ordering, arithmetic or comparisons involving protected values; compute those locally.

Worked example, asking for the third digit of a protected phone number:

| Step | Value |
| --- | --- |
| What you typed | `13800138000` — third digit is `8` |
| What the provider received | `27431905882` — third digit is `4` |
| What the model answered | "the third digit is `4`" |
| What you see after restoration | `13800138000` … "the third digit is `4`" |

The number is restored, the reasoning is not, so the reply quietly contradicts itself. Nothing flags this: a derived answer is ordinary text, indistinguishable from any other sentence. The reply is also consistent across retries, because the same value keeps the same replacement, so re-asking does not reveal the error.

If a field must be reasoned about correctly, either leave it unprotected, or give it a fixed `replacement` and accept that the alias is semantically recognisable. There is no option that both hides a value and lets the model compute over it.

Replacements are checked so restoration stays exact: a candidate is rejected if it equals the original, is already mapped, or already appears anywhere in the same request. When no unique candidate can be produced, typically for very short matches, the request is blocked with `SCAN_UNIQUE_FAILED`. Because a shaped value is indistinguishable from ordinary content, a model that independently emits the same short string will have it restored to the original, so prefer rules that match longer, distinctive values.

### Message language

All notifications, prompts and diagnostics render in a single language, chosen from the environment: `PI_PROTECTER_LANG`, then `LC_ALL`, `LC_MESSAGES`, `LANG`, `LANGUAGE`, then the runtime locale. `zh*` selects Simplified Chinese; anything else falls back to English. Set `PI_PROTECTER_LANG=en` or `PI_PROTECTER_LANG=zh` to override. Error codes, stages and numeric details stay language-neutral so they can be searched and reported.

### Multi-turn consistency and prompt caching

Random placeholders are generated once per exact original and reused within the same extension instance, including after local response restoration. Starting another scan worker does not reset the mapping. This supports stable prompt prefixes but does not guarantee provider KV-cache hits; model, tools, message ordering, cache lifetime and routing also matter. `/reload`, process restart and session-instance replacement clear mappings. Different processes do not share mappings, and audit timestamps/request IDs are never included in the model payload.

## Private audit log

Successful request-body redactions append to `protecter.<machineHash>.jsonl` beside the configuration. Each JSON line includes `time` (`yyyy-mm-dd HH:mm:ss`, local time), `timezoneOffset` (minutes east of UTC), `provider`, `original`, `replacement`, `requestId` and `version`. Provider is Pi's selected provider ID, not an inferred upstream gateway vendor; unavailable metadata is recorded as `unknown`.

One record is written per distinct original/token pair per successful scan; repeated occurrences in that request are deduplicated. Replacing the same original on a later request creates a new record, even when its token is reused. Existing tokens and requests without matches add no records. These are **local redaction events, not proof of network delivery**: cancellation, another hook or a provider failure can occur afterward.

`/protecter` or `/protecter logs [1-100]` reads the most recent records (20 by default). Local TUI only: choose a time/provider entry, then confirm before revealing plaintext. The editor is a preview and discards edits. Controls are escaped; long previews are truncated. RPC/print modes do not display secrets, and the command never calls `sendMessage` or writes session entries.

Use `/protecter logs clear` to empty only the current machine's audit log. Local TUI confirmation is mandatory; cancelling, RPC/print mode or extra arguments do nothing. After confirmation, Pi waits for idle, queues the clear with scans and acquires the same cross-process log lock as appends. The validated file is truncated and synced, not unlinked; missing logs are a successful no-op. Configuration, other machine logs and in-memory mappings remain unchanged. New requests may immediately append new records. Full or partial-tail logs can be cleared, but unsafe links and occupied/stale locks are never bypassed. This is irreversible logical deletion, **not secure erasure** of filesystem snapshots/backups.

**Logs contain real secrets and reversible mappings.** Unix permissions are 0600; symlinks, hard links and other-user files are rejected. Tool guards cover current/old hash log names and aliases but are not a sandbox. Logs are not encrypted, automatically rotated, migrated with configuration or used to rebuild mappings. Stop all Pi processes before locally archiving/deleting logs or inspecting a stale `.jsonl.lock`. Reading is bounded to the last 1 MiB, display to 100 records and 20,000 characters per preview. A log is capped at 32 MiB and a request batch at 8 MiB; full, unwritable, partial-tail or locked logs block matched requests rather than silently losing audits. Failed scans add no records; a hard crash can leave a partial batch that requires local repair.

## Diagnosing a blocked request

When a request is blocked, the notification names the failing stage, a stable code and a suggested action instead of one generic message:

```text
SPI Protecter blocked this request
code=CONFIG_EMPTY_MATCH stage=configuration rule=1
Reason: Regex matches an empty string
Action: Require a non-empty match in the numbered rule
Details: /protecter status
```

Stages are `initialization`, `configuration`, `migration`, `request`, `scan`, `worker`, `audit` and `internal`. Coordinates appear only when known: `rule` and `otherRule` are 1-based indexes into `sensitiveWords`, `node` counts scanned payload nodes, `bytes`/`limit`/`timeoutMs` report the exceeded limit, and `errno` is the OS error code.

Common codes include `CONFIG_JSON`, `CONFIG_SCHEMA`, `CONFIG_REGEX`, `CONFIG_TARGET`, `CONFIG_CONFLICT`, `CONFIG_EMPTY_MATCH`, `CONFIG_SENSITIVE_TARGET`, `CONFIG_ALIAS_CONFLICT`, `CONFIG_UNSAFE`, `MIGRATION_LOCKED`, `MIGRATION_CHANGED`, `PAYLOAD_JSON`, `PAYLOAD_SIZE`, `SCAN_TIMEOUT`, `SCAN_MATCH_LIMIT`, `SCAN_COMPLEXITY`, `SCAN_ATTACHMENT`, `SCAN_JSON_REWRITE`, `SCAN_NUMBER_UNSAFE`, `SCAN_UNIQUE_FAILED`, `FIXED_OVERLAP`, `FIXED_ALIAS_REUSED`, `AUDIT_FULL`, `AUDIT_PARTIAL`, `AUDIT_LOCKED`, `AUDIT_UNSAFE` and `WORKER_FAILED`.

Notifications can scroll away, so `/protecter status` repeats the last recorded block for the session, and a tool blocked while protection is unavailable reports the same cause. Requests still fail closed: the outgoing payload is replaced with `{}`.

**Diagnostics never include request text, matched originals, replacement values, configuration content, file paths or raw OS messages.** Only catalog codes, non-negative integer coordinates and an allow-listed `errno` are emitted, so they are safe to paste into an issue. Because matched content is excluded, locating an offending rule may still require local inspection using the reported rule index.

## How it works

```text
Input / history / tools / system prompt / tool definitions
                         ↓
before_provider_request: final JSON text scan
                         ↓
shape-preserving random value → LLM gateway
                         ↓
Local response and tool-argument restoration
```

1. Scan JSON strings, keys and numbers, including decoded JSON-string tool arguments. Local user input and original history are unchanged.
2. Generate a shape-preserving replacement with `crypto.randomBytes`. Runtime mappings stay in memory and are not restored across restarts. **Since 0.3.0, successful original/replacement pairs are also persisted in the private audit log.** They are never injected into configuration, session custom entries or model prompts.
3. Restore finalized assistant text, thinking and tool arguments. The TUI Markdown transformer restores complete streamed tokens; partial tokens may briefly appear. RPC/JSON deltas remain masked until final `message_end`. Altered or truncated tokens cannot be restored.
4. Restore tool arguments before execution so legitimate local operations use original values; redact them again on subsequent requests. **Restoring credentials is not tool authorization or exfiltration prevention.**
5. Execute regex scans in a terminable worker. On failure, return `{}` and request cancellation rather than relying on hook exceptions swallowed by Pi. An empty request or provider validation error may still occur, but the handler does not return the original payload.

### Configuration access guard

**Outgoing redaction is the main defense; direct-access blocking is supplementary.** Shell is not disabled wholesale.

- File tools check actual path arguments, not document bodies; writing documentation that mentions config filenames is allowed. In the active config directory, legacy/current hash filenames and migration artifacts are protected. Shell command fields retain best-effort filename checks, so shell mentions can still produce false positives.
- Resolve `@`, `~`, relative paths and `file://`; check symlink/inode aliases. Block `grep/find/ls` over ancestor directories containing the configuration.
- Attempt whole-text masking if the complete original configuration accidentally appears in a request.
- **Best effort only:** dynamic shell, base64, split output, nested symlinks, arbitrary third-party tools and network sends can bypass these checks. This cannot guarantee that a malicious model never obtains configuration.

## Limitations — read first

- Only rule-matching text is protected, not paraphrases, split characters or arbitrary encodings. Common image/audio/video/file blocks reject the entire request because SPI cannot be reliably inspected; no OCR is provided.
- `/compact`, automatic compaction and summarized `/tree` navigation are cancelled pending separate lifecycle/restoration verification. Tree navigation without summaries works; use `/new` for long sessions.
- Exit, reload and session switching discard mappings. Final restored local messages remain readable; crash leftovers, old summaries and raw deltas cannot recover tokens across restarts.
- Broad rules such as `.` or all digits may alter protocol fields, model names, tool schemas or IDs and break requests. Matching numbers become token strings. Prefer precise rules.
- Reused tokens reveal equality relationships; context may imply identity. This is not formal anonymization.
- Hooks do not cover HTTP headers, authentication keys, gateway endpoints, Pi telemetry, `/share`, independent extension SDK/fetch calls or tool networking. The gateway still receives its authentication credentials.
- **Load after other payload rewriters and trust every installed extension.** Later handlers can reintroduce originals. Extensions have local permissions, and Pi may continue if this extension fails to load. Check status before entering secrets.
- Local sessions, terminals, exports and files written by tools may contain plaintext. They are not encrypted or cleaned by this project.

See [SECURITY.md](SECURITY.md) for the threat model.

## Development and verification

```bash
npm ci
npm run check
```

Tests use temporary directories and fictional secrets, never real user configuration, API keys or LLM gateways. Coverage includes masking/restoration, regex timeout, permissions, path guards and real Pi loader/runner integration. All Markdown, comments and new commit messages must be English + Simplified Chinese.

`npm run build` bundles local modules with esbuild, removes TypeScript types and minifies output. Node built-ins and Pi peer packages remain external. No source maps or source files are published; source remains available on GitHub. Minification reduces size, not visibility or security. `npm pack` rebuilds via `prepack`; `npm publish` first runs checks. Tests also extract the actual npm tarball and run Pi's loader and both workers from it. See the repository's `docs/BUILDING.md` for details.

API references: [Pi Extensions](https://pi.dev/docs/latest/extensions), local 0.86.1 documentation and runner implementation. Licensed under MIT.

---

## 简体中文

**个人敏感信息保护插件。**

这是一个 Pi 扩展：在本地审查 LLM 出站请求体，用随机占位符替换配置中的敏感值，并在本地还原模型返回的占位符。适用于 URL、电话号码、身份证／ID、姓名、凭证和密码。**这是基于规则的意外泄漏防护，不是沙箱、自动 PII 检测器或加密代理。**

## 安装

要求 Node.js 22+ 和 `@earendil-works/pi-coding-agent` **0.84.0–0.84.x 或 0.85.1–0.87.x**。每个受支持版本都经过完整测试验证（含真实加载器与 worker 集成测试）。0.83.0 及更早缺少 `registerMarkdownTransformer`，0.85.0 引用了任何 Pi 版本都未声明的 `@earendil-works/pi-server`，两者均无法加载。不支持旧 `@mariozechner/*` 版本。

```bash
# 安装最新 npm 版本。
pi install npm:pi-information-protecter

# 确有需要时才固定版本；旧版本缺少后续修复。
pi install npm:pi-information-protecter@0.7.0

# 或在本仓库构建后本地安装，不复制仓库。
npm ci
npm run build
pi install "$PWD"

# 单次加载。
pi -e ./src/index.ts

# 升级已安装的版本。
pi update npm:pi-information-protecter
```

不带版本号安装最新版；固定版本后将停留在该版本，直到手动更新。

已运行的 Pi 请执行 `/reload`。从 `0.2.1` 起，npm 发布 `dist/` 中编译压缩后的 ESM，而非 TypeScript 源码。必须同时保留 `index.mjs`、`scan-worker.mjs` 和 `validate-worker.mjs` 三个文件。`0.2.0` 采用旧源码布局。

版本变更见 [CHANGELOG.md](CHANGELOG.md)。贡献与发布流程见仓库内的 `CONTRIBUTING.md` 和 `docs/RELEASING.md`。

维护者通过推送匹配版本的 `v*` 标签发布新版本。GitHub Actions 验证后使用 npm OIDC 可信发布，不需要长期令牌；手动试运行不会发布。

初始化使用 `~/.pi/agent/protecter.<machineHash>.json`，遵循 `PI_CODING_AGENT_DIR`。哈希由产品前缀与规范化系统标识计算 SHA-256，取前 32 位十六进制；macOS 使用 `IOPlatformUUID`、Linux 使用 `/etc/machine-id`、Windows 使用 `MachineGuid`。标识缺失或无效时拒绝初始化，不随机回退。哈希是稳定标识而非秘密，不加载项目级配置。

启动和重载时，识别到的旧配置（包括原固定文件名）会先验证，再合并去重到当前目标；目标持久化写入并验证后才删除未变化的旧文件。无效来源会中止迁移而不删除原文件。Unix 权限为 `0600`，拒绝不安全链接、他人所有文件和超限文件；Windows 需自行设置 ACL。详见[迁移文档](docs/MIGRATION.md)。

验证后的配置按扩展实例缓存。出站扫描及状态命令不重新读取或检查配置文件；加载后修改、损坏或删除文件不改变当前快照。修改在重载后生效；`/protecter reload` 会调用 Pi 重载，会话切换产生的新实例也初始化一次。若全部配置已删除，下次初始化会创建空配置并警告，旧内存不跨实例销毁保留。

## 配置

**请用本地编辑器修改配置，不要让模型填写真实密码，也不要把真实配置提交到 Git。** 初始规则数组为空，不具备个人信息检测能力，界面会给出警告。插件不会自动识别所有 SPI。

```json
{
  "version": 1,
  "sensitiveWords": [
    "张三",
    { "type": "literal", "value": "your-private-password" },
    { "type": "regex", "pattern": "https?://[^\\s\\\"<>]+", "flags": "i" },
    { "type": "regex", "pattern": "(?<!\\d)1[3-9]\\d{9}(?!\\d)" }
  ]
}
```

更多示例见 [`protecter.example.json`](protecter.example.json)，涵盖内网域名、邮箱地址、IPv4 和 IPv6，不会自动启用。地址与域名规则请先核对：它们同样会匹配公开值，过于宽泛的规则可能脱敏文档示例、回环地址或依赖仓库域名。号码规则不验证真实性或校验位，姓名和密码建议使用精确值。

- **字面规则：**字符串和 `literal` 按大小写敏感方式匹配全部出现位置，不作正则解释。
- **正则：**JavaScript 正则替换整个匹配，可用后行断言仅匹配凭证值。支持 `g i m s u`，自动补 `g`，不支持 `/pattern/flags` 简写。
- JSON 中的反斜杠写作 `\\`。不允许匹配空字符串；运行时零宽匹配会拒绝请求。
- 合并重叠匹配，避免暴露长敏感值的后缀；同一实例内相同原文复用占位符。
- 已识别原文在当前实例内持续受到精确匹配保护，即使正则上下文消失或规则被删除；退出或重载清除记录。
- `/protecter` 打开本地审计查看器，`/protecter logs 50` 查看最近最多 50 条；`/protecter status` 只报告内存数量，不读取配置。`/protecter reload` 等待空闲后完整重载。不要在命令参数中填写秘密。
- 限制为 1000 条规则、每个词或模式 8192 字符、扫描 2 秒、请求 JSON 8 MiB；超限拒绝，不降级发送明文。

### 固定替换值

对象规则支持可选 `replacement` 字段。省略时保持随机替换，纯字符串规则始终使用随机占位符。空字符串、全空白、非字符串或超过 8192 字符的目标属于无效配置，不回退为随机。

```json
{
  "version": 1,
  "sensitiveWords": [
    { "type": "literal", "value": "Apple Inc.", "replacement": "Alphabet Inc." },
    { "type": "literal", "value": "example-private-key-123", "replacement": "MyPrivateKey" },
    { "type": "literal", "value": "randomly-protected-value" }
  ]
}
```

目标按字面文本处理，不是替换模板，`$1`、`$&` 不展开。字面和正则对象均支持该字段。成功扫描后，固定别名同样写入审计，并在本地回复和工具参数中还原。它属于**保留别名**：回复中自然出现的相同文本也会被还原；如果介意此歧义，请选择独特目标而非普通词。固定别名比随机占位符暴露更多语义信息。

为保持可逆保护，不同规则复用相同目标、目标互为子串、目标包含配置敏感值、使用保留 `__PIP_` 名称或定义冲突时拒绝加载。固定正则在同一实例中只能表示一种不同的匹配原文，第二种原文会导致请求被拒绝。涉及固定规则的部分重叠匹配也拒绝，不静默选择规则或泄漏后缀；纯随机规则重叠仍合并。迁移保留固定目标，遇到冲突停止且不删除原文件。修改后请重载；旧插件版本不支持此字段。

### 同形替换

从 0.6.0 起，命中内容不再替换为不透明占位符，而是替换为**同形**随机值，使请求保持结构有效：

| 原文 | 替换值 | 保留特征 |
| --- | --- | --- |
| `9007199254740991`（数字） | `2844008842109708`（数字） | JSON 类型、位数、安全整数范围 |
| `13800138000` | `06864831332` | 长度、纯数字 |
| `Alex.Morgan@Example.COM` | `Ufqz.Vwtudb@Rjdnpxe.HGZ` | 长度、大小写形态、标点位置 |
| `张三` | `丅欕` | 汉字体系、字数 |
| `Nguyễn Văn Tèo` | `Ufefṉg Zżt Sàb` | 带重音拉丁字母、词边界 |
| `ひらがな` | `ゅせはっ` | 平假名 |
| `192.168.1.10` | `101.203.3.77` | 合法 IPv4，每段不超过 255 |
| `fe80::1ff:fe23:4567` | `af44::6ea:bf19:2700` | 合法 IPv6，保留 `::` 与分组宽度 |

这修复了类似 `'9007199254740991' is not of type 'number'` 的提供商错误：过去数值字段会被替换成字符串占位符。现在数值仍为数字，位数不变并保持安全整数；候选值在整个数值上下文中校验，不合法则重新抽取，因此匹配小数或指数不再拦截请求；`SCAN_NUMBER_UNSAFE` 仅作为最后手段保留，主要出现在文本上下文已建立映射的值再次以数值形式出现时。

地址采用格式感知替换：IPv4 匹配保证每段在 0-255 内，IPv6 匹配保证十六进制字符仍为十六进制，并保留 `::` 压缩写法、分组宽度及末尾嵌入的 IPv4，因此 `net.isIPv4`/`net.isIPv6` 和提供商校验仍然通过。若仅逐字符替换，会产生超过 255 的段或非十六进制字符。嵌在更长匹配（如整条 URL）中的地址仍按字符替换。

字母和数字在各自文字体系内替换：ASCII、Latin-1、Latin Extended-A、Latin Extended Additional（含越南语）、希腊语、西里尔语、希伯来语、阿拉伯语、泰语、平假名、片假名、谚文及汉字。标点、空白、表情、符号以及上述范围之外的码位保持不变，这正是 URL、邮箱和内嵌 JSON 仍可解析的原因。

**这是有意为之的权衡。** 不透明占位符仅暴露“发生了脱敏”；同形值还会暴露长度、字符类别和标点结构，并且在模型看来像真实数据。不支持的文字体系会原样保留，因此匹配这类文本的规则可能残留部分可见内容。

**模型推理的是替换值，因此从受保护值推导出的答案是错的。** 询问受保护身份证号的第 3 位，得到的是替换值的第 3 位；回复中只有值本身会被还原，由它推导出的结论不会。因此答案看似笃定且自洽，却与还原后的值对不上。不透明占位符不会有这个问题，因为模型只能表示自己读不到该值。请勿让模型回答涉及受保护值的位数、校验位、排序、算术或比较，这类计算应在本地完成。

实例：询问受保护手机号的第 3 位。

| 环节 | 值 |
| --- | --- |
| 你输入的内容 | `13800138000`——第 3 位是 `8` |
| 提供商实际收到的 | `27431905882`——第 3 位是 `4` |
| 模型的回答 | “第 3 位是 `4`” |
| 还原后你看到的 | `13800138000` … “第 3 位是 `4`” |

号码被还原了，推理没有，因此回复会静默地自相矛盾。没有任何机制能发现它：推导出的答案就是普通文本，与其他句子无法区分。重试也不会暴露错误，因为同一值始终对应同一替换值，结果前后一致。

如果某个字段必须被正确推理，要么不保护它，要么为它设置固定 `replacement` 并接受别名在语义上可识别。不存在既隐藏值、又能让模型对它运算的方案。

为保证还原精确，候选值会被校验：与原文相同、已被占用、或已出现在同一请求中的候选值会被拒绝。无法生成唯一值时（通常是极短匹配），以 `SCAN_UNIQUE_FAILED` 拦截请求。由于同形值与普通内容难以区分，若模型自行输出了相同的短字符串，它会被还原为原文，因此应优先匹配更长、更有辨识度的值。

### 消息语言

所有通知、提示和诊断仅以**单一语言**呈现，语言按环境变量依次选取：`PI_PROTECTER_LANG`、`LC_ALL`、`LC_MESSAGES`、`LANG`、`LANGUAGE`，最后是运行时区域。`zh*` 选择简体中文，其余回退英文。可设置 `PI_PROTECTER_LANG=en` 或 `PI_PROTECTER_LANG=zh` 覆盖。错误码、阶段和数值细节保持语言无关，便于搜索和反馈。

### 多轮一致性与提示词缓存

随机占位符按精确原文首次生成，在同一扩展实例内持续复用，包括本地回复还原后的再次脱敏；新建扫描 worker 不会重置映射。这有助于前缀稳定，但不保证提供商 KV Cache 命中，模型、工具、消息顺序、缓存有效期和路由也有影响。重载、进程重启和会话实例替换会清除映射；不同进程不共享映射，审计时间和请求 ID 不进入模型请求体。

## 私有审计日志

成功脱敏的请求会追加记录到配置旁的 `protecter.<machineHash>.jsonl`。每行包含 `time`（本地时间 `yyyy-mm-dd HH:mm:ss`）、`timezoneOffset`（相对 UTC 向东的分钟数）、`provider`、`original`、`replacement`、`requestId` 和 `version`。供应商为 Pi 当前选择的 provider ID，不猜测网关背后的上游厂商；无法获取时记录 `unknown`。

每次成功扫描，对不同的原文与占位符组合分别记录一行，同一请求内重复出现会去重。后续请求再次替换同一原文时仍新增记录，即使复用占位符。已有占位符和无命中请求不新增记录。日志表示**本地脱敏事件，而非网络已成功发送**，之后仍可能取消、被其他钩子修改或发生提供商错误。

`/protecter` 或 `/protecter logs [1-100]` 查看最近记录，默认 20 条。仅在本地 TUI 可用：先选择时间及供应商条目，确认后才显示明文。编辑器只作预览，修改不保存；控制字符转义，过长预览截断。RPC、打印模式不展示秘密，命令不调用消息发送接口，也不写入会话条目。

使用 `/protecter logs clear` 只清空当前机器的审计日志。必须在本地 TUI 确认；取消、RPC／打印模式或多余参数均不执行。确认后等待 Pi 空闲，与扫描排队并获取和追加日志相同的跨进程锁；安全验证后截断文件并同步，不删除文件，日志不存在则成功无操作。不改变配置、其他机器日志或内存映射；新请求可能立即新增记录。可清理已满或尾部残缺日志，但不绕过危险链接、占用锁或残留锁。这是不可撤销的逻辑删除，**不等于安全擦除**文件系统快照或备份。

**日志包含真实秘密及可逆映射。** Unix 权限为 0600，拒绝符号链接、硬链接及他人文件。工具防护覆盖当前和旧机器哈希日志及别名，但不是沙箱。日志不加密、不自动轮转、不随配置迁移，也不用于恢复映射。请停止全部 Pi 进程后再本地归档、删除日志或检查残留 `.jsonl.lock`。读取限最后 1 MiB、最多 100 条，每条预览最多 20,000 字符；单日志上限 32 MiB、请求批次 8 MiB。日志满、不可写、尾部残缺或锁占用时，命中请求会被阻止，不静默漏记。扫描失败不新增记录，硬崩溃可能遗留部分批次，需本地修复。

## 拦截原因定位

请求被拦截时，提示不再是单一笼统信息，而是给出失败阶段、稳定错误码和处理建议：

```text
SPI Protecter 已阻止该请求
code=CONFIG_EMPTY_MATCH stage=configuration rule=1
原因：正则匹配空字符串
处理：修改指定规则，要求非空匹配
详情：/protecter status
```

阶段包括初始化、配置、迁移、请求、扇描、worker、审计和内部错误。定位信息仅在已知时输出：`rule` 和 `otherRule` 是敏感词数组中从 1 开始的序号，`node` 为已扫描节点数，`bytes`、`limit`、`timeoutMs` 说明超限情况，`errno` 为系统错误码。

常见错误码包括 `CONFIG_JSON`、`CONFIG_SCHEMA`、`CONFIG_REGEX`、`CONFIG_TARGET`、`CONFIG_CONFLICT`、`CONFIG_EMPTY_MATCH`、`CONFIG_SENSITIVE_TARGET`、`CONFIG_ALIAS_CONFLICT`、`CONFIG_UNSAFE`、`MIGRATION_LOCKED`、`MIGRATION_CHANGED`、`PAYLOAD_JSON`、`PAYLOAD_SIZE`、`SCAN_TIMEOUT`、`SCAN_MATCH_LIMIT`、`SCAN_COMPLEXITY`、`SCAN_ATTACHMENT`、`SCAN_JSON_REWRITE`、`SCAN_NUMBER_UNSAFE`、`SCAN_UNIQUE_FAILED`、`FIXED_OVERLAP`、`FIXED_ALIAS_REUSED`、`AUDIT_FULL`、`AUDIT_PARTIAL`、`AUDIT_LOCKED`、`AUDIT_UNSAFE` 和 `WORKER_FAILED`。

通知可能消失，因此 `/protecter status` 会重新展示本会话最近一次拦截；防护不可用时被拦截的工具也会报告同一原因。请求仍然失败不放行：出站请求体会被替换为 `{}`。

**诊断信息不包含请求文本、命中原文、替换值、配置内容、文件路径或原始系统消息。** 仅输出目录内错误码、非负整数定位和白名单 `errno`，因此可安全粘贴到问题报告。也因为不包含命中内容，最终定位问题规则时，仍需根据规则序号在本地查看。

## 工作方式

```text
输入／历史／工具结果／系统提示／工具定义
                         ↓
before_provider_request：最终 JSON 文本扫描
                         ↓
同形随机值 → LLM 网关
                         ↓
本地回复和工具参数还原
```

1. 扫描 JSON 字符串、键和数字，包括解码后的 JSON 字符串工具参数；不修改本地用户输入和历史原文。
2. 使用 `crypto.randomBytes` 生成同形替换值。运行时映射保存在内存，不跨重启恢复。**从 0.3.0 起，成功替换的原文和占位符也会持久化到私有审计日志。** 不注入配置、会话自定义条目或模型提示。
3. 还原最终 assistant 文本、思考内容和工具参数。TUI 在完整占位符到达后还原，片段可能短暂显示；RPC/JSON 增量仍脱敏，直到最终消息还原。被改写或截断的占位符无法还原。
4. 工具执行前还原参数，让合法本地操作使用原值；后续请求再次脱敏。**凭证还原不等于工具授权或防外传。**
5. 正则扫描运行于可终止 worker。失败时返回 `{}` 并请求取消，不依赖被 Pi 吞掉的钩子异常；仍可能产生空请求或提供商校验错误，但处理器不返回原始请求体。

### 配置访问防护

**以出站脱敏为主，直接访问拦截为辅。** 不全面禁用 shell。

- 文件工具检查实际路径参数而非正文，允许文档提及配置名称。当前配置目录内的旧名称、哈希名称及迁移文件受保护；shell 命令字段保留尽力文件名检查，因此 shell 提及名称仍可能误拦截。
- 解析 `@`、`~`、相对路径和 `file://`，检查符号链接和 inode 别名；阻止 `grep/find/ls` 扫描包含配置的祖先目录。
- 完整原始配置意外出现在请求文本时，尝试整体替换。
- **仅为尽力防护：**动态 shell、编码、拆分输出、目录内链接、任意第三方工具和网络发送可绕过检查，无法保证恶意模型永远无法取得配置。

## 当前限制——请先阅读

- 仅保护命中规则的文本，不覆盖改写、拆字和任意编码。常见多模态附件因无法可靠审查而拒绝整个请求，不提供 OCR。
- 暂时取消压缩和带摘要的树导航，等待单独验证生命周期及还原；不带摘要的导航可用，长会话请使用 `/new`。
- 退出、重载和切换会话会丢弃映射。最终已还原消息仍可读，但崩溃残留、旧摘要和原始增量无法跨重启恢复占位符。
- 过宽规则可能改写协议字段、模型名、工具结构和 ID，导致请求失败；命中数字变为占位符字符串，应优先使用精确规则。
- 复用占位符会暴露值相等的关系，上下文也可能揭示身份，这不是形式化匿名化。
- 钩子不覆盖认证头、API key、网关地址、遥测、分享、扩展独立网络调用和工具联网；网关仍收到其认证凭证。
- **在其他请求改写扩展之后加载，并只使用可信扩展。** 后续处理器可重新加入原文；扩展有本机权限，插件加载失败时 Pi 可能继续运行，请先检查状态再输入秘密。
- 本地会话、终端、导出和工具写出的文件可能包含明文，本项目不加密或清理它们。

详细威胁模型见 [SECURITY.md](SECURITY.md)。

## 开发与验证

```bash
npm ci
npm run check
```

测试仅使用临时目录和虚构敏感值，不读取真实配置、不使用真实密钥或访问 LLM 网关，覆盖脱敏还原、正则超时、权限、路径防护和真实 Pi 加载器／执行器集成。所有 Markdown、注释和新提交信息必须使用英文＋简体中文。

`npm run build` 使用 esbuild 合并本地模块、移除类型并压缩产物，Node 内置模块和 Pi peer 依赖保持外部引用。不发布源码或 source map，源码仍可在 GitHub 查阅。压缩是体积优化，不是加密或安全隔离。`npm pack` 通过 `prepack` 自动构建，`npm publish` 先执行检查。测试还会解压实际 npm 压缩包，用 Pi 加载器和两个 worker 验证产物。详见仓库内的 `docs/BUILDING.md`。

接口依据为 [Pi 官方扩展文档](https://pi.dev/docs/latest/extensions)、本机 0.86.1 文档及执行器实现；采用 MIT 许可证。
