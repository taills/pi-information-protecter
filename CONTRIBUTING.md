# 贡献指南

本项目是个人敏感信息保护插件（Sensitive Personal Information，SPI Protecter）。核心目标是减少规则可识别的个人敏感信息意外进入 Pi 的 LLM 请求体，不宣称提供沙箱或完整匿名化。

## 本地开发

要求 Node.js 22+，推荐使用 npm 和已提交的 lockfile：

```bash
npm ci
npm run check
pi -e ./src/index.ts
```

自动测试只使用临时目录和虚构信息，不需要网关凭证。手工验证应使用独立的 Pi 配置目录，避免影响自己的真实配置和会话。

## 修改要求

- 修复应附带回归测试，特别关注配置读取、最终请求、正则超时、响应还原和工具调用链。
- 不把真实敏感词、配置、会话、token 或请求抓包提交到仓库及 issue。
- 不在错误日志中打印原始规则、敏感值或请求 payload。
- 出站扫描失败不得回退原文；不能依赖 Pi 会吞掉的 hook 异常来停止发送。
- 工具路径保护属于尽力防护；不要把字符串检查描述为安全沙箱。
- 更改支持的 Pi 版本前，需验证实际 loader、runner 和 provider 钩子的行为。
- 更新 README、SECURITY 和 CHANGELOG，准确记录功能边界。

## 提交前检查

```bash
npm run check
npm pack --dry-run
 git diff --check
```

提交时说明原因、影响范围和测试结果。安全问题请参考 SECURITY.md，不公开粘贴真实秘密。发布步骤见 [docs/RELEASING.md](docs/RELEASING.md)。
