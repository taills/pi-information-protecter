# pi-information-protecter

[English](#english) · [简体中文](#简体中文)

## English

**Sensitive Personal Information (SPI) Protecter for Pi.**

You list the values you never want to send to a model. Before a model request leaves, this extension replaces them with realistic fake values, and restores them locally in replies and tool arguments. The model sees fake data; you see your own.

It protects **values you configured, in model requests** — nothing more. The next section is the important one.

## What is redacted and what is not

### Redacted: every request to a model

| Model request | How |
| --- | --- |
| Your prompts, conversation history, system prompt, tool definitions, tool results | Pi's outgoing-request hook |
| Prompt-cache warming | Same hook |
| Context compaction and `/tree` branch summaries | The conversation is redacted before Pi summarizes it |
| The summary `/bug` writes | Model-runtime guard |
| `codemode` classifier and image calls | Model-runtime guard |
| Model calls made by other extensions | Model-runtime guard |

Pi offers no hook for the last three, so this extension wraps the model runtime the session shares and redacts anything sent through it. If that is not possible, startup fails with `GUARD_UNAVAILABLE` and **all** requests are blocked instead of running unprotected. `/protecter status` shows whether it is in place.

If redaction itself fails for any reason, the request is **blocked**, never sent as plaintext.

### Not redacted: anything that is not a model request

| Action | What it sends | Why it cannot be intercepted |
| --- | --- | --- |
| `/bug` | The uploaded bundle: the whole transcript — your messages, model output, tool calls and their results, including file contents and command output — plus Pi version, OS, model and provider configuration, extensions and settings | Pi handles `/bug` itself and uploads over its own HTTP connection. It is also handled before extension commands, so an extension cannot even replace it. Only the summary inside it is redacted |
| `/share` | The transcript, uploaded as a gist | Pi's own upload path, not a model request |
| `/export` | The transcript, written to a file | Same, to local disk |
| Session files | Everything you and the model wrote, with real values restored | Pi stores sessions; this extension does not encrypt them |
| Tools, shell, MCP servers | Tool arguments are deliberately restored to real values so tools work | What a tool, shell command or MCP server then does with them is outside this extension. Shell can also encode or split a value past any text matching |
| Request headers, API keys, endpoints, Pi telemetry | Credentials and routing metadata | Not part of the request body this extension rewrites |
| Another extension's own `fetch` | Whatever it chooses | Extensions run with your permissions |

**Treat `/bug`, `/share` and `/export` as publishing plaintext.** To report a bug from a session that touched real secrets, use the local zip/export option, open it, and check the contents before sending it anywhere.

Two more limits worth knowing: only text matching your rules is protected — not paraphrases, split characters or values the model infers — and requests containing images, audio, video or file blocks are rejected rather than sent, because they cannot be inspected.

## Installation

Requires Node.js 22+ and Pi (`@earendil-works/pi-coding-agent`) **0.84.0–0.84.x, 0.85.1–0.87.x, 0.99.x or 1.2.0–1.3.x**. Every version in that list was verified by running the full test suite against it; others are refused on purpose, because a wrong guess here means sending plaintext.

```bash
# Install the latest release.
pi install npm:pi-information-protecter

# Upgrade later.
pi update npm:pi-information-protecter
```

Then run `/reload` in an open session. Load this extension **after** any other extension that rewrites outgoing requests, and check `/protecter status` before typing secrets: if it failed to load, Pi keeps working without it.

## Configuration

The configuration lives at `~/.pi/agent/protecter.<machineHash>.json` (it follows `PI_CODING_AGENT_DIR`). It starts empty, so **nothing is protected until you add rules**.

**Edit it in a local editor. Never ask the model to write your real secrets into it, and never commit it.**

```json
{
  "version": 1,
  "sensitiveWords": [
    "Alex Morgan",
    { "type": "literal", "value": "your-private-password" },
    { "type": "literal", "value": "Apple Inc.", "replacement": "Alphabet Inc." },
    { "type": "regex", "pattern": "(?<!\\d)1[3-9]\\d{9}(?!\\d)" }
  ]
}
```

| Rule | Meaning |
| --- | --- |
| `"text"` | Match this exact text (case-sensitive) |
| `{ "type": "literal", "value": "..." }` | Same, with options |
| `{ "type": "regex", "pattern": "..." }` | JavaScript regex; the whole match is replaced |
| `"replacement": "..."` | Always use this fixed fake value instead of a random one |

Tips that matter in practice:

- **Be precise.** A rule like `.` or "all digits" rewrites model names, IDs and tool schemas, and breaks requests.
- **Avoid very short matches.** They cannot be replaced uniquely, and the request is blocked with `SCAN_UNIQUE_FAILED`. Prefer something like `[A-Za-z0-9._~+/-]{16,}`.
- **Review patterns copied from examples.** [`protecter.example.json`](protecter.example.json) has ready-made rules for internal domains, emails, IPv4/IPv6, phone numbers and bearer tokens. None are enabled automatically, and broad address rules also match documentation examples and dependency hosts.
- In JSON, write backslashes as `\\`. Flags `g i m s u` are supported (`g` is automatic); `/pattern/flags` shorthand is not.
- A fixed `replacement` is a **reserved alias**: if the model writes that same text by itself, it is restored too. Choose distinctive values; fixed aliases also reveal more meaning than random ones.
- Limits: 1000 rules, 8192 characters per rule, 2-second scan, 8 MiB request. Exceeding a limit blocks the request instead of sending plaintext.

After editing, run `/protecter reload`.

### Fake values keep the shape of the original

A match is replaced by a random value of the **same shape**, so requests stay valid:

| Original | Sent to the model |
| --- | --- |
| `13800138000` | `06864831332` |
| `9007199254740991` (number) | `2844008842109708` (number) |
| `Alex.Morgan@Example.COM` | `Ufqz.Vwtudb@Rjdnpxe.HGZ` |
| `192.168.1.10` | `101.203.3.77` |
| `张三` | `丅欕` |

Numbers stay numbers, IP addresses stay valid, and letters are replaced within their own script, so emails, URLs and embedded JSON still parse. Punctuation, emoji and unsupported scripts are left as they are, so part of a matched value can stay visible. The trade-off: a fake value reveals length and structure, and looks like real data to the model.

### The model reasons about the fake value

Only the **value** is restored in a reply — never a conclusion drawn from it:

| Step | Value |
| --- | --- |
| You typed | `13800138000` — third digit is `8` |
| Model received | `27431905882` — third digit is `4` |
| Model answered | "the third digit is `4`" |
| You see | `13800138000` … "the third digit is `4`" |

The reply quietly contradicts itself, looks confident, and does not change if you retry. **Do not ask the model about digits, checksums, ordering, arithmetic or comparisons of protected values.** Compute those locally, or leave that field unprotected.

### Commands

| Command | What it does |
| --- | --- |
| `/protecter status` | Ready state, rule and mapping counts, compaction mode, guard state, last blocked request |
| `/protecter logs [1-100]` | Open the local audit log viewer (default 20 records) |
| `/protecter logs clear` | Empty this machine's audit log |
| `/protecter reload` | Reload Pi once it is idle |

Never type a secret as a command argument.

### Context compaction

When the context fills up, Pi summarizes the conversation. That request is built inside Pi and does **not** pass through the normal hook, so this extension redacts the conversation Pi is about to summarize and lets Pi summarize it with your current model. No second model is needed, and the saved summary keeps the fake values, so no plaintext summary is written into the session file.

| `compaction` | Behaviour |
| --- | --- |
| `ask` (default) | Ask before each compaction, then redact |
| `protected` | Redact without asking |
| `off` | Never compact; use `/new` instead |

```json
{ "version": 1, "compaction": "protected", "sensitiveWords": [] }
```

"Allow for this session" lasts until reload or exit; the configuration value is the permanent setting. If redaction fails, compaction is cancelled rather than letting Pi send the original text.

One exception: `/compact <instruction>` reads the instruction from Pi's own state, which this extension cannot reach. If your instruction contains a protected value, that compaction is cancelled (`COMPACT_INSTRUCTIONS`) — run `/compact` without it. Automatic compaction and `/tree` summaries are unaffected.

`compaction.provider`, `compaction.model`, `compaction.contextWindow` and `compaction.reserveTokens` configured a separate summarization model before 0.11.0. They are still accepted so an upgrade cannot break a working setup, but they do nothing; remove them.

## Private audit log

Every successful redaction is appended to `protecter.<machineHash>.jsonl` next to the configuration: time, provider, the original value, the fake value and a request ID.

**This file contains your real secrets and the mapping back to them.** It is created with `0600` permissions, is never uploaded and is not encrypted. Do not share it. `/protecter logs` is local-TUI only and confirms before showing plaintext; RPC and print modes never display it.

A record means "replaced locally", not "delivered to the provider". `/protecter logs clear` empties this machine's log after confirmation — logical deletion, not secure erasure. If the log is full, locked or unwritable, matched requests are blocked rather than silently losing the audit trail.

## When a request is blocked

Blocked requests fail closed: the outgoing payload is replaced with `{}`, and you get a code and a suggested action.

```text
SPI Protecter blocked this request
code=CONFIG_EMPTY_MATCH stage=configuration rule=1
Reason: Regex matches an empty string
Action: Require a non-empty match in the numbered rule
Details: /protecter status
```

`rule=1` is the 1-based index in `sensitiveWords`. Stages are `initialization`, `configuration`, `migration`, `request`, `scan`, `worker`, `audit` and `internal`. Notifications scroll away, so `/protecter status` repeats the last one.

**Diagnostics never contain request text, matched values, fake values, configuration content, file paths or raw OS messages** — only a code, numbers and an allow-listed `errno`. They are safe to paste into an issue, which also means locating the offending rule may need a local look.

## How it works

```text
your input / history / tool definitions / tool results
                        ↓
        scan the final request JSON, replace matches
                        ↓
            fake values → model provider
                        ↓
     restore values in replies and tool arguments
```

1. Scan the final request JSON — strings, keys, numbers and JSON-encoded tool arguments. Your local input and history are never modified.
2. Generate fake values with `crypto.randomBytes`. Mappings stay in memory, and one value always maps to the same fake value within a session, which also keeps prompt prefixes stable.
3. Restore values in the finished reply, in thinking blocks, and in tool arguments before a tool runs, so local tools work on real data.
4. Run your regexes in a worker with a 2-second limit. On any failure, send `{}` and cancel instead of falling back to the original request.

`/reload`, restart or switching sessions clears the mappings; fake values in older summaries can no longer be turned back after that.

The extension also stops tools from reading its own configuration and audit log, resolving `~`, `@`, relative paths, `file://` and symlinks. This is a convenience guard, not a sandbox: shell and third-party tools can work around it.

## Development and debugging

```bash
npm ci
npm run check        # build + typecheck + all tests
npm run typecheck    # types only
npm test             # tests only (also rebuilds dist/)
npm run build        # bundle and minify into dist/
```

Run the extension from source against a **throwaway** Pi configuration directory, never your real one:

```bash
export PI_CODING_AGENT_DIR="$(mktemp -d)"
export PI_PROTECTER_LANG=en          # pin message language
pi -e ./src/index.ts
```

Write fictional rules into `$PI_CODING_AGENT_DIR/protecter.json`, start Pi, and the machine-hash configuration is created from it on first run.

### Where things live

| Path | Role |
| --- | --- |
| `src/index.ts` | Hook and command wiring: outgoing requests, restoration, tool calls, compaction, startup checks |
| `src/engine.ts` | Scan/restore orchestration, mapping table, worker lifecycle, audit writes |
| `src/scan-worker.mjs` | Runs your regexes in a terminable worker |
| `src/shape.mjs` | Generates shape-preserving fake values |
| `src/compaction.ts` | Redacts what Pi is about to summarize (compaction and `/tree`) |
| `src/guard-runtime.ts` | Model-runtime choke point for calls that have no hook |
| `src/config.ts`, `src/migration.ts` | Parsing, validation, machine-hash configuration migration |
| `src/guard.ts` | Blocks tool access to the configuration and audit log |
| `src/diagnostics.ts`, `src/locale.ts` | Error codes, stages and bilingual messages |
| `src/compat.ts` | The verified Pi version gate |

### Debugging workflow

- **Run one test file:** `npx tsx --test test/guard-runtime.test.ts`.
- **Reproduce a block as a test, not against a live gateway.** `test/integration.test.ts` drives Pi's real loader and runner and asserts on the actual outgoing payload; copy one of its cases and substitute a fictional value. Never test with real secrets or a real provider.
- **Check what actually left the process.** The audit log records each original/fake pair, and `/protecter status` repeats the last block with its code and stage. Diagnostics deliberately exclude content, so the rule index is the pointer back to your configuration.
- **Hookless paths** are covered by `test/hookless-paths.test.ts` (compaction and `/tree` through the real runner) and `test/guard-runtime.test.ts` (the model-runtime guard, including assertions against Pi's own classes so a Pi rename fails the suite instead of silently dropping coverage).
- **The packed artifact is tested too.** `npm test` builds the real npm tarball, extracts it, and loads `dist/index.mjs` with Pi's loader and both workers, so minification and worker paths are verified, not assumed.

### Widening Pi compatibility

`src/compat.ts` refuses any Pi release that has not been verified, because a wrong guess means sending plaintext rather than breaking a feature. To add a release, install it and run the full suite against it:

```bash
npm i -D @earendil-works/pi-coding-agent@<version>
npm run check
```

Only then update `supportsPi`, `SUPPORTED_PI` and `peerDependencies`, keeping the runtime gate and the declared range identical.

More detail: [`CONTRIBUTING.md`](CONTRIBUTING.md) for the bilingual and review rules, [`docs/BUILDING.md`](docs/BUILDING.md) for packaging, [`docs/RELEASING.md`](docs/RELEASING.md) for publishing, [`SECURITY.md`](SECURITY.md) for the threat model, [`CHANGELOG.md`](CHANGELOG.md) for version history.

## Messages and language

Messages appear in one language, chosen from `PI_PROTECTER_LANG`, then `LC_ALL`, `LC_MESSAGES`, `LANG`, `LANGUAGE`, then the runtime locale. `zh*` selects Simplified Chinese, anything else English. Codes and numbers stay language-neutral.

Licensed under MIT.

---

## 简体中文

**Pi 的个人敏感信息（SPI）保护插件。**

你列出不希望发给模型的值，本扩展在模型请求发出之前把它们替换成形态逼真的假值，并在回复和工具参数中于本地还原。模型看到的是假数据，你看到的仍是自己的数据。

它保护的是**你配置过的值，且仅限模型请求**——仅此而已。下一节是最重要的内容。

## 哪些会脱敏，哪些不会

### 会脱敏：所有发往模型的请求

| 模型请求 | 覆盖方式 |
| --- | --- |
| 你的提示、对话历史、系统提示、工具定义、工具结果 | Pi 的出站请求钩子 |
| 提示缓存预热 | 同一钩子 |
| 上下文压缩与 `/tree` 分支摘要 | 在 Pi 生成摘要之前先脱敏对话 |
| `/bug` 生成的那段摘要 | 模型运行时闸门 |
| `codemode` 的分类与图像调用 | 模型运行时闸门 |
| 其他扩展发起的模型调用 | 模型运行时闸门 |

Pi 没有为后三者提供任何钩子，因此本扩展包装会话共享的模型运行时，对经由它发出的内容一律脱敏。若无法完成包装，启动会以 `GUARD_UNAVAILABLE` 失败并拦截**所有**请求，而不是在无保护状态下运行。`/protecter status` 会显示它是否已就位。

若脱敏本身因任何原因失败，请求会被**拦截**，绝不以明文发出。

### 不会脱敏：一切不属于模型请求的传输

| 操作 | 发送的内容 | 为什么无法拦截 |
| --- | --- | --- |
| `/bug` | 上传的报告包：完整会话记录——你的消息、模型输出、工具调用及其结果（含读取到的文件内容与命令输出）——以及 Pi 版本、操作系统、模型与提供商配置、已加载扩展和设置 | `/bug` 由 Pi 自己处理，并通过它自身的 HTTP 连接上传。它还在扩展命令之前被处理，扩展连替换它都做不到。只有其中那段摘要会被脱敏 |
| `/share` | 会话记录，以 gist 形式上传 | 走 Pi 自己的上传路径，不是模型请求 |
| `/export` | 会话记录，写入文件 | 同理，写到本地磁盘 |
| 会话文件 | 你与模型写下的全部内容，且其中的值已还原为真实值 | 会话由 Pi 保存，本扩展不对其加密 |
| 工具、shell、MCP 服务器 | 工具参数会被刻意还原为真实值，工具才能正常工作 | 此后工具、shell 命令或 MCP 服务器拿这些值做什么都不在本扩展范围内；shell 还可通过编码或拆分绕过任何文本匹配 |
| 请求头、API key、网关地址、Pi 遥测 | 凭证与路由元数据 | 不属于本扩展改写的请求体 |
| 其他扩展自己的 `fetch` | 由它自行决定 | 扩展以你的权限运行 |

**请把 `/bug`、`/share`、`/export` 视为公开明文。** 若需要为接触过真实秘密的会话提交错误报告，请使用本地 zip／导出选项，打开它，确认内容之后再决定发给谁。

另外两点同样要紧：只有命中你的规则的文本会被保护——改写、片段值以及模型推断出的内容都不会；包含图片、音频、视频或文件块的请求会被拒绝而不是发送，因为它们无法被检查。

## 安装

要求 Node.js 22+ 与 Pi（`@earendil-works/pi-coding-agent`）**0.84.0–0.84.x、0.85.1–0.87.x、0.99.x 或 1.2.0–1.3.x**。清单中的每个版本都经过完整测试验证；其余版本会被有意拒绝——此处判断失误意味着发送明文。

```bash
# 安装最新版本。
pi install npm:pi-information-protecter

# 后续升级。
pi update npm:pi-information-protecter
```

随后在已打开的会话中执行 `/reload`。请把本扩展加载在任何其他改写出站请求的扩展**之后**；输入秘密前先看 `/protecter status`：若它加载失败，Pi 会在没有它的情况下继续工作。

## 配置

配置文件位于 `~/.pi/agent/protecter.<machineHash>.json`（遵循 `PI_CODING_AGENT_DIR`）。它初始为空，因此**在你添加规则之前，什么都不会被保护**。

**请在本地编辑器中修改。不要让模型把你的真实秘密写进去，也不要提交到 Git。**

```json
{
  "version": 1,
  "sensitiveWords": [
    "Alex Morgan",
    { "type": "literal", "value": "your-private-password" },
    { "type": "literal", "value": "Apple Inc.", "replacement": "Alphabet Inc." },
    { "type": "regex", "pattern": "(?<!\\d)1[3-9]\\d{9}(?!\\d)" }
  ]
}
```

| 规则 | 含义 |
| --- | --- |
| `"text"` | 匹配该精确文本（区分大小写） |
| `{ "type": "literal", "value": "..." }` | 同上，可带选项 |
| `{ "type": "regex", "pattern": "..." }` | JavaScript 正则，整个匹配被替换 |
| `"replacement": "..."` | 固定使用该假值，而非随机值 |

实践中要紧的几点：

- **要精确。** 像 `.` 或"所有数字"这样的规则会改写模型名、ID 与工具结构，导致请求失败。
- **避免过短的匹配。** 它们无法生成唯一替换值，请求会以 `SCAN_UNIQUE_FAILED` 被拦截。建议写成 `[A-Za-z0-9._~+/-]{16,}` 之类。
- **核对从示例复制的正则。** [`protecter.example.json`](protecter.example.json) 提供了内部域名、邮箱、IPv4/IPv6、手机号与 Bearer 令牌的现成规则，它们都不会自动启用；过宽的地址规则也会命中文档示例和依赖主机名。
- JSON 中反斜杠要写成 `\\`。支持 `g i m s u` 标志（`g` 自动添加）；不支持 `/pattern/flags` 简写。
- 固定 `replacement` 是**保留别名**：若模型自己写出同样的文本，也会被还原。请选择独特的值；固定别名也比随机值暴露更多语义。
- 限制：1000 条规则、每条 8192 字符、扫描 2 秒、请求 8 MiB。超限会拦截请求，而不是发送明文。

修改后执行 `/protecter reload`。

### 假值保持原值的形态

命中的值会被替换为**同形态**的随机值，使请求依然合法：

| 原值 | 发给模型的值 |
| --- | --- |
| `13800138000` | `06864831332` |
| `9007199254740991`（数字） | `2844008842109708`（数字） |
| `Alex.Morgan@Example.COM` | `Ufqz.Vwtudb@Rjdnpxe.HGZ` |
| `192.168.1.10` | `101.203.3.77` |
| `张三` | `丅欕` |

数字仍是数字，IP 仍是合法地址，字母在各自文字体系内替换，因此邮箱、URL 与内嵌 JSON 仍可解析。标点、表情与不支持的文字体系原样保留，因此命中值可能部分可见。代价是：假值会暴露长度与结构，并且在模型看来像真实数据。

### 模型推理的是假值

回复中只有**值**会被还原，由它推导出的结论不会：

| 步骤 | 值 |
| --- | --- |
| 你输入 | `13800138000`——第三位是 `8` |
| 模型收到 | `27431905882`——第三位是 `4` |
| 模型回答 | "第三位是 `4`" |
| 你看到 | `13800138000` … "第三位是 `4`" |

回复因此自相矛盾，却看起来笃定，重试也不会变。**不要让模型回答受保护值的位数、校验位、排序、算术或比较问题。** 这些请在本地计算，或让该字段不受保护。

### 命令

| 命令 | 作用 |
| --- | --- |
| `/protecter status` | 就绪状态、规则与映射数量、压缩模式、闸门状态、最近一次拦截 |
| `/protecter logs [1-100]` | 打开本地审计日志查看器（默认 20 条） |
| `/protecter logs clear` | 清空本机审计日志 |
| `/protecter reload` | 等待空闲后重载 Pi |

不要把秘密作为命令参数输入。

### 上下文压缩

上下文写满时，Pi 会对对话生成摘要。该请求由 Pi 内部构造，**不经过**常规钩子，因此本扩展会先对 Pi 即将摘要的对话脱敏，再由 Pi 用你当前的模型生成摘要。不需要第二个模型；保存下来的摘要保留假值，因此会话文件中不会写入明文摘要。

| `compaction` | 行为 |
| --- | --- |
| `ask`（默认） | 每次压缩前询问，然后脱敏 |
| `protected` | 不询问，直接脱敏 |
| `off` | 从不压缩；请改用 `/new` |

```json
{ "version": 1, "compaction": "protected", "sensitiveWords": [] }
```

"本会话内全部允许"在重载或退出前有效；配置中的取值才是永久设置。若脱敏失败，压缩会被取消，而不是让 Pi 发送原文。

一个例外：`/compact <指令>` 的指令由 Pi 从自身状态读取，本扩展无法触及。若指令中含受保护值，该次压缩会被取消（`COMPACT_INSTRUCTIONS`）——请不带该值执行 `/compact`。自动压缩与 `/tree` 摘要不受影响。

`compaction.provider`、`compaction.model`、`compaction.contextWindow` 与 `compaction.reserveTokens` 在 0.11.0 之前用于配置独立的摘要模型。它们仍被接收，以免升级后破坏可用环境，但已不起作用，请删除。

## 私有审计日志

每次成功脱敏都会追加到配置旁的 `protecter.<machineHash>.jsonl`：时间、provider、原值、假值与请求 ID。

**该文件包含你的真实秘密以及还原映射。** 它以 `0600` 权限创建，不会被上传，也未加密。请勿分享。`/protecter logs` 仅限本地 TUI，展示明文前需确认；RPC 与 print 模式从不显示。

一条记录代表"已在本地替换"，不代表"已送达提供商"。`/protecter logs clear` 在确认后清空本机日志——这是逻辑删除，而非安全擦除。日志写满、被锁定或不可写时，命中请求会被拦截，而不是静默丢失审计记录。

## 请求被拦截时

被拦截的请求一律拒绝放行：出站内容被替换为 `{}`，并给出错误码与处理建议。

```text
SPI Protecter blocked this request
code=CONFIG_EMPTY_MATCH stage=configuration rule=1
Reason: Regex matches an empty string
Action: Require a non-empty match in the numbered rule
Details: /protecter status
```

`rule=1` 是 `sensitiveWords` 中从 1 开始的序号。阶段包括 `initialization`、`configuration`、`migration`、`request`、`scan`、`worker`、`audit` 与 `internal`。通知会滚动消失，可用 `/protecter status` 重新查看最近一次。

**诊断信息从不包含请求文本、命中原值、假值、配置内容、文件路径或原始系统消息**——只有错误码、数字和白名单内的 `errno`，因此可以安全粘贴到 issue；相应地，定位具体规则可能仍需在本地查看。

## 工作方式

```text
你的输入／历史／工具定义／工具结果
              ↓
   扫描最终请求 JSON，替换命中内容
              ↓
         假值 → 模型提供商
              ↓
     在回复与工具参数中还原真实值
```

1. 扫描最终请求 JSON——字符串、键、数字以及 JSON 编码的工具参数。你的本地输入与历史不会被修改。
2. 用 `crypto.randomBytes` 生成假值。映射保存在内存中；同一会话内同一个值始终对应同一个假值，这也使提示前缀保持稳定。
3. 在完成的回复、思考块以及工具执行前的参数中还原真实值，使本地工具基于真实数据工作。
4. 你的正则在 worker 中执行，限时 2 秒。任何失败都发送 `{}` 并取消请求，而不是回退到原始请求。

`/reload`、重启或切换会话会清空映射；此后旧摘要中的假值将无法再被还原。

本扩展还会阻止工具读取它自己的配置与审计日志，并会解析 `~`、`@`、相对路径、`file://` 与符号链接。这是便利性防护，不是沙箱：shell 与第三方工具可以绕过。

## 开发与调试

```bash
npm ci
npm run check        # 构建 + 类型检查 + 全部测试
npm run typecheck    # 仅类型检查
npm test             # 仅测试（同时会重新构建 dist/）
npm run build        # 打包并压缩到 dist/
```

请使用**一次性**的 Pi 配置目录从源码运行，绝不要用你的真实目录：

```bash
export PI_CODING_AGENT_DIR="$(mktemp -d)"
export PI_PROTECTER_LANG=en          # 固定消息语言
pi -e ./src/index.ts
```

把虚构规则写入 `$PI_CODING_AGENT_DIR/protecter.json` 后启动 Pi，首次运行会据此创建机器哈希配置。

### 代码位置

| 路径 | 作用 |
| --- | --- |
| `src/index.ts` | 钩子与命令接线：出站请求、还原、工具调用、压缩、启动检查 |
| `src/engine.ts` | 脱敏／还原编排、映射表、worker 生命周期、审计写入 |
| `src/scan-worker.mjs` | 在可终止的 worker 中执行你的正则 |
| `src/shape.mjs` | 生成同形态的假值 |
| `src/compaction.ts` | 对 Pi 即将摘要的内容脱敏（压缩与 `/tree`） |
| `src/guard-runtime.ts` | 针对无钩子调用的模型运行时总闸门 |
| `src/config.ts`、`src/migration.ts` | 解析、校验、机器哈希配置迁移 |
| `src/guard.ts` | 阻止工具访问配置与审计日志 |
| `src/diagnostics.ts`、`src/locale.ts` | 错误码、阶段与双语文案 |
| `src/compat.ts` | 已验证的 Pi 版本门禁 |

### 调试流程

- **只跑一个测试文件：** `npx tsx --test test/guard-runtime.test.ts`。
- **把问题复现成测试，而不是打到真实网关。** `test/integration.test.ts` 驱动 Pi 真实的加载器与执行器，并对实际出站内容做断言；复制其中一个用例并换成虚构值即可。绝不要用真实秘密或真实提供商测试。
- **确认到底发出了什么。** 审计日志记录每一对原值／假值，`/protecter status` 会重新展示最近一次拦截及其错误码与阶段。诊断有意不含内容，因此规则序号就是指回你配置的线索。
- **无钩子路径**由 `test/hookless-paths.test.ts`（经真实执行器验证压缩与 `/tree`）和 `test/guard-runtime.test.ts`（模型运行时闸门，并直接对 Pi 自身的类做断言，使 Pi 重命名会导致测试失败而非静默丢掉覆盖）覆盖。
- **打包产物同样在测试内。** `npm test` 会构建真实的 npm tarball、解压，并用 Pi 的加载器加载 `dist/index.mjs` 及两个 worker，因此压缩与 worker 路径是被验证过的，而非假设。

### 扩大 Pi 兼容范围

`src/compat.ts` 会拒绝任何未经验证的 Pi 版本，因为此处判断失误意味着发送明文，而不仅是功能失效。要新增一个版本，请安装它并在其上运行完整测试：

```bash
npm i -D @earendil-works/pi-coding-agent@<版本>
npm run check
```

通过之后再更新 `supportsPi`、`SUPPORTED_PI` 与 `peerDependencies`，并保持运行时门禁与声明范围完全一致。

更多资料：双语与评审规范见 [`CONTRIBUTING.md`](CONTRIBUTING.md)，打包见 [`docs/BUILDING.md`](docs/BUILDING.md)，发布见 [`docs/RELEASING.md`](docs/RELEASING.md)，威胁模型见 [`SECURITY.md`](SECURITY.md)，版本变更见 [`CHANGELOG.md`](CHANGELOG.md)。

## 消息与语言

消息只使用一种语言，依次取自 `PI_PROTECTER_LANG`、`LC_ALL`、`LC_MESSAGES`、`LANG`、`LANGUAGE`，最后是运行时语言。`zh*` 选择简体中文，其余为英文。错误码与数字与语言无关。

本项目基于 MIT 许可。
