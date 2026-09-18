# SPI Protecter security boundaries / SPI Protecter 安全边界

## Goal / 目标

Prevent configured personal information from accidentally entering Pi LLM request bodies as plaintext. This assumes trusted Pi core, provider implementations, OS and installed extensions, successful extension loading and invocation of the final request hook.

防止已配置的个人信息意外以明文进入 Pi 的 LLM 请求体。前提是 Pi 核心、提供商实现、操作系统和已加载扩展可信，且插件成功加载、最终请求钩子确实执行。

## Non-goals / 非目标

- No OS sandbox or defense against same-UID programs, malicious extensions, arbitrary code execution, debuggers or memory inspection.
  不提供操作系统沙箱，不防御同 UID 程序、恶意扩展、任意代码执行、调试器或内存检查。
- No protection against arbitrary encoding, splitting, translation or screenshot/OCR reconstruction; no automatic privacy classification or formal anonymization.
  不防御任意编码、拆分、翻译和截图／OCR 重构，不提供自动隐私分类或形式化匿名化。
- No coverage for gateway authentication headers/endpoints, tool requests, independent SDK calls, telemetry, session exports or `/share`.
  不覆盖网关认证头与地址、工具请求、独立 SDK 调用、遥测、会话导出或分享。
- No local configuration/session/terminal encryption, nor automatic prevention of exfiltration after a model infers a secret.
  不加密本地配置、会话和终端，也不会在模型推断出秘密后自动阻止外传。

## Implementation / 实现策略

- Scan outgoing payload text; use random 192-bit placeholders and memory-only reverse mappings.
  扫描出站请求体文本，使用随机 192-bit 占位符及仅内存反向映射。
- Limit worker regex scans to 2 seconds, with resource and input limits. Errors exclude original configuration, rules and request text.
  worker 正则扫描限制为 2 秒，并限制资源和输入；错误不包含原始配置、规则或请求文本。
- Pi 0.85.1 catches `before_provider_request` errors and continues with the current payload. Error paths therefore return `{}` and attempt cancellation. This does not guarantee zero HTTP requests; it prevents this handler from falling back to the original payload.
  Pi 0.85.1 会捕获该钩子异常并继续使用当前请求体，因此错误路径返回空对象并尝试取消。这不保证没有 HTTP 请求，只保证本处理器不回退原始请求体。
- Create configuration separately with Unix mode 0600. Reject links, non-regular files, multiple links and files owned by others. Users remain responsible for directories and OS permissions; TOCTOU races are not prevented.
  独立创建配置，Unix 权限为 0600；拒绝链接、非普通文件、多链接及他人所有文件。用户仍需维护目录和系统权限，无法防止检查与使用之间的竞态。
- Direct-access blocking is supplementary. File tools inspect target paths rather than document bodies. Shell can bypass string checks, and command mentions or ancestor directory checks can still cause false positives.
  直接访问拦截只是补充；文件工具检查目标路径而非正文。shell 可绕过字符串检查，命令提及及祖先目录检查仍可能误拦截。
- Startup/reload validates and merges machine-hash configurations before caching. Requests use memory only; file deletion does not revoke cached secrets. Reload or process exit clears the instance. Migration uses commit-before-delete and a cooperating-process lock, not a multi-file transaction or protection against hostile local writers. Stale locks require local inspection; Windows does not provide POSIX directory fsync.
  启动或重载时校验并合并机器哈希配置后缓存，请求只使用内存；文件删除不撤销缓存秘密，重载或退出才清理实例。迁移采用先提交后删除及协作进程锁，并非多文件事务或恶意本地写入防护；残留锁需本地检查，Windows 无 POSIX 目录同步。
- Whole-configuration text detection does not guarantee that every reformatted rule definition is masked.
  整体配置文本检测不保证所有重新格式化的规则定义都被遮盖。
- Compaction and tree summaries are conservatively disabled. Do not widen Pi compatibility without verification.
  保守禁用压缩和树摘要，未经验证不扩大 Pi 兼容范围。

## Deployment guidance / 安全部署建议

1. Configure precise rules locally and check status/counts. Empty rules provide no SPI detection.
   在本地配置具体规则并检查状态和数量；空规则不具备个人信息检测能力。
2. Inspect requests using fictional data and a trusted test gateway; never test with real secrets.
   使用虚构数据及可信测试网关检查请求，绝不用真实秘密测试。
3. Avoid log-upload, session-export and telemetry extensions; verify payload handler ordering.
   避免日志上传、会话导出和遥测类扩展，确认请求处理器顺序。
4. Use containers, separate users/filesystems and network restrictions for high-risk environments. Keep configuration outside tool-accessible storage. This extension alone cannot enforce that isolation.
   高风险环境使用容器、独立用户或文件系统及网络限制，将配置放在工具不可访问的位置；本扩展无法单独提供此隔离。
5. Never post real configuration, mappings, sessions or personal-information packet captures in public issues.
   不在公共问题报告中提交真实配置、映射、会话或含个人信息的抓包。
