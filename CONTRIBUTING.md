# Contributing / 贡献指南

SPI Protecter reduces accidental disclosure of rule-identifiable personal information in Pi LLM request bodies. It does not claim to provide a sandbox or complete anonymization.

SPI Protecter 致力于减少可由规则识别的个人信息意外进入 Pi 的 LLM 请求体，不宣称提供沙箱或完整匿名化。

## Local development / 本地开发

Use Node.js 22+, npm and the committed lockfile. / 使用 Node.js 22+、npm 和已提交的锁文件。

```bash
npm ci
npm run check
pi -e ./src/index.ts
```

Automated tests use temporary directories and fictional data, without gateway credentials. Use an isolated Pi configuration directory for manual testing to avoid touching real configuration and sessions.

自动测试使用临时目录和虚构数据，不需要网关凭证。手工测试应使用独立 Pi 配置目录，避免影响真实配置与会话。

## Language policy / 双语规范

- Every Markdown document, including headings, instructions and example comments, must provide English and Simplified Chinese with equivalent meaning. Identifiers, commands and fictional sample data need not be translated.
  所有 Markdown 文档，包括标题、说明和示例注释，必须提供语义一致的英文和简体中文；标识符、命令及虚构示例数据无需翻译。
- Every source/test comment must be bilingual, including JSDoc, inline comments and block comments. Prefer English first, then Simplified Chinese.
  所有源码和测试注释必须双语，包括 JSDoc、行内及块注释，建议英文在前、简体中文在后。
- Every new Git commit subject and any body text must be bilingual. Do not rewrite already-pushed history without explicit authorization.
  所有新 Git 提交标题及正文必须双语，未经明确授权不改写已推送历史。

```text
docs: add bilingual documentation / 补充双语文档
```

## Change requirements / 修改要求

- Include regression tests for fixes, especially configuration reads, final requests, regex timeouts, restoration and tool chains.
  修复附带回归测试，重点覆盖配置读取、最终请求、正则超时、还原及工具链。
- Never commit real secrets, configuration, sessions, tokens or request captures, or post them in issues.
  不提交或公开真实敏感值、配置、会话、令牌或请求抓包。
- Never log original rules, sensitive values or request payloads in errors.
  错误日志不得打印原始规则、敏感值或请求体。
- Scanning failures must not fall back to plaintext. Do not rely on hook exceptions swallowed by Pi to stop requests.
  扫描失败不得回退明文，不依赖被 Pi 吞掉的钩子异常来停止请求。
- Describe path guards as best effort, never as a sandbox.
  路径防护应描述为尽力保护，不能称为沙箱。
- Verify real loader, runner and provider hooks before widening Pi compatibility.
  扩大 Pi 兼容范围前验证真实加载器、执行器和提供商钩子。
- Keep README, SECURITY and CHANGELOG accurate in both languages.
  同步维护这些文档的双语内容及功能边界。

## Before committing / 提交前检查

```bash
npm run check
npm pack --dry-run
git diff --check
```

Explain the reason, scope and test results in both languages. Consult SECURITY.md for security boundaries and never disclose real secrets publicly. See [docs/RELEASING.md](docs/RELEASING.md) for publishing.

以双语说明修改原因、范围和测试结果。安全边界见 SECURITY.md，不公开真实秘密；发布流程见上述链接。
