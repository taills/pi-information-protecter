# Changelog

## 0.1.0 — 2026-09-18

首个公开版本：**个人敏感信息保护插件 — Sensitive Personal Information (SPI) Protecter**。

### 新增

- Pi 最终 provider 请求体的本地脱敏，覆盖系统提示、历史、工具结果及工具定义。
- `protecter.json` 敏感词数组、字面匹配及 JavaScript 正则表达式。
- 随机 192-bit 占位符、仅内存映射、最终回复及工具参数本地还原。
- TUI Markdown 流式展示还原；已学习敏感值在当前实例内继续按精确值保护。
- 配置文件 0600 权限及直接访问防护，配置异常与扫描超时的安全替代请求。
- Worker 正则扫描与资源限制；`/protecter status` 和 `/protecter reload`。
- 配置示例、安全边界说明及自动化测试，包括真实 Pi loader/runner 集成测试。

### 兼容性与已知限制

- Node.js 22+，Pi `@earendil-works/pi-coding-agent` 0.85.1–0.85.x；验证基线 0.85.1。
- 初始规则为空，需用户本地配置；不会自动识别所有 SPI。
- 暂不支持上下文压缩、带摘要的树导航及常见多模态附件。
- RPC/JSON 流式 delta 保留占位符，最终消息还原；映射不会跨进程保存。
- 不是沙箱；不防任意 shell 编码绕过，不覆盖独立网络调用、HTTP 认证 headers、本地会话及导出。详见 SECURITY.md。
