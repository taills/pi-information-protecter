# Changelog / 更新日志

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
