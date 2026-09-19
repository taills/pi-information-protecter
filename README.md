# pi-information-protecter

[English](#english) · [简体中文](#简体中文)

## English

**Sensitive Personal Information (SPI) Protecter.**

A Pi extension that inspects outgoing LLM request bodies locally, replaces configured sensitive values with random placeholders, and restores echoed placeholders locally. Suitable for URLs, phone numbers, identity numbers, names, credentials and passwords. **This is rule-based accidental-disclosure protection, not a sandbox, automatic PII detector or encryption proxy.**

## Installation

Requires Node.js 22+ and `@earendil-works/pi-coding-agent` **0.85.1–0.85.x**, tested against 0.85.1. Legacy `@mariozechner/*` releases are not supported.

```bash
# Install the pinned npm release.
pi install npm:pi-information-protecter@0.2.1

# Alternatively, build and install from this repository without copying it.
npm ci
npm run build
pi install "$PWD"

# Load for one invocation.
pi -e ./src/index.ts
```

Run `/reload` in an existing Pi session. Starting with `0.2.1`, npm releases ship compiled, minified ESM in `dist/`, not TypeScript source. Keep all three files together: `index.mjs`, `scan-worker.mjs` and `validate-worker.mjs`. Version `0.2.0` uses the previous source layout.

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

More examples are in [`protecter.example.json`](protecter.example.json); they are not automatically enabled. Number patterns do not validate authenticity or check digits. Prefer exact values for names and passwords.

- **Literals:** strings and `literal` rules match all case-sensitive occurrences, without regex interpretation.
- **Regex:** JavaScript regex replaces the entire match. Use lookbehind to match only a credential value. Flags `g i m s u` are supported; `g` is added automatically. `/pattern/flags` shorthand is not supported.
- Escape backslashes as `\\` in JSON. Empty-string matches are invalid; runtime zero-width matches reject the request.
- Overlapping matches are merged to avoid exposing a longer secret's suffix. Equal values reuse a token within the extension instance.
- Learned originals remain exact-match protected within the instance even if regex context disappears or a rule is removed. Exit/reload clears these records.
- `/protecter` and `/protecter status` report cached counts only, without disk access or sensitive values. `/protecter reload` waits for idle and invokes Pi's full reload; it is no longer a status-only command. Adding secrets through command arguments is not supported.
- Limits: 1000 rules, 8192 characters per literal/pattern, 2-second scan timeout and 8 MiB request JSON. Exceeding limits rejects the request rather than sending plaintext.

## How it works

```text
Input / history / tools / system prompt / tool definitions
                         ↓
before_provider_request: final JSON text scan
                         ↓
__PIP_<192-bit random hex>__ → LLM gateway
                         ↓
Local response and tool-argument restoration
```

1. Scan JSON strings, keys and numbers, including decoded JSON-string tool arguments. Local user input and original history are unchanged.
2. Generate tokens with `crypto.randomBytes(24)`. Mappings stay **in memory only**, never in configuration, session custom entries, logs or model prompts. Local users can still see original values.
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

API references: [Pi Extensions](https://pi.dev/docs/latest/extensions), local 0.85.1 documentation and runner implementation. Licensed under MIT.

---

## 简体中文

**个人敏感信息保护插件。**

这是一个 Pi 扩展：在本地审查 LLM 出站请求体，用随机占位符替换配置中的敏感值，并在本地还原模型返回的占位符。适用于 URL、电话号码、身份证／ID、姓名、凭证和密码。**这是基于规则的意外泄漏防护，不是沙箱、自动 PII 检测器或加密代理。**

## 安装

要求 Node.js 22+ 和 `@earendil-works/pi-coding-agent` **0.85.1–0.85.x**，验证基线为 0.85.1。不支持旧 `@mariozechner/*` 版本。

```bash
# 安装固定 npm 版本。
pi install npm:pi-information-protecter@0.2.1

# 或在本仓库构建后本地安装，不复制仓库。
npm ci
npm run build
pi install "$PWD"

# 单次加载。
pi -e ./src/index.ts
```

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

更多示例见 [`protecter.example.json`](protecter.example.json)，不会自动启用。号码规则不验证真实性或校验位，姓名和密码建议使用精确值。

- **字面规则：**字符串和 `literal` 按大小写敏感方式匹配全部出现位置，不作正则解释。
- **正则：**JavaScript 正则替换整个匹配，可用后行断言仅匹配凭证值。支持 `g i m s u`，自动补 `g`，不支持 `/pattern/flags` 简写。
- JSON 中的反斜杠写作 `\\`。不允许匹配空字符串；运行时零宽匹配会拒绝请求。
- 合并重叠匹配，避免暴露长敏感值的后缀；同一实例内相同原文复用占位符。
- 已识别原文在当前实例内持续受到精确匹配保护，即使正则上下文消失或规则被删除；退出或重载清除记录。
- 状态命令只报告缓存数量，不访问磁盘或显示敏感值。重载命令等待空闲并调用 Pi 完整重载，不再只是查询状态；不支持通过命令参数添加秘密。
- 限制为 1000 条规则、每个词或模式 8192 字符、扫描 2 秒、请求 JSON 8 MiB；超限拒绝，不降级发送明文。

## 工作方式

```text
输入／历史／工具结果／系统提示／工具定义
                         ↓
before_provider_request：最终 JSON 文本扫描
                         ↓
__PIP_<192-bit 随机十六进制>__ → LLM 网关
                         ↓
本地回复和工具参数还原
```

1. 扫描 JSON 字符串、键和数字，包括解码后的 JSON 字符串工具参数；不修改本地用户输入和历史原文。
2. 使用 `crypto.randomBytes(24)` 生成占位符。映射**仅存于内存**，不写入配置、会话自定义条目、日志或模型提示；本地用户仍可看到原文。
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

接口依据为 [Pi 官方扩展文档](https://pi.dev/docs/latest/extensions)、本机 0.85.1 文档及执行器实现；采用 MIT 许可证。
