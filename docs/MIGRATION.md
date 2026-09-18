# Configuration migration and cache / 配置迁移与缓存

## Identity and discovery / 标识与发现

The target is `protecter.<32-lowercase-hex-machine-hash>.json` in Pi's active agent directory. Normalize the OS identifier by trimming, lowercasing and removing UUID hyphens, then hash `pi-information-protecter:v1:` plus that identifier with SHA-256. Use the first 32 hex characters. IDs are never logged. OS reinstalls, cloned images and containers may change or duplicate IDs; this is not a uniqueness or access-control guarantee.

目标位于 Pi 当前配置目录，名称包含 32 位小写十六进制机器哈希。系统标识去除首尾空白、转小写并移除 UUID 连字符，再加产品前缀计算 SHA-256，取前 32 位。不记录原始标识；重装、克隆和容器可能改变或重复标识，因此不保证唯一性，也不是访问控制。

Only `protecter.json` and `protecter.[a-f0-9]{32}.json` in that directory are candidates. No recursion or arbitrary wildcard deletion. At most 64 candidates are accepted. Example files are ignored. UUID filenames were never shipped and are not silently imported.

仅识别该目录中的旧固定名称和严格匹配的哈希名称，不递归、不任意通配删除，最多接受 64 个候选。示例文件被忽略；从未发布过 UUID 名称版本，因此不静默导入这种文件。

## Validate and merge / 校验与合并

Every candidate must be a current-user regular file without symlinks or hard links, at most 1 MiB, with schema version 1 and valid rules. Regex empty-match checks run in a bounded worker before any target write. Unknown fields, malformed rules and unsupported versions stop initialization. Existing files may have permissions tightened to 0600, but invalid input never causes deletion.

每个候选必须为当前用户所有的普通文件，无符号或硬链接，不超过 1 MiB，版本为 1 且规则合法。正则空匹配在限时 worker 中验证后才写目标。未知字段、错误规则和不支持版本会停止初始化。已有文件权限可能收紧为 0600，但无效输入不导致删除。

Current-target rules come first, then old files in filename order. Strings and equivalent explicit literals deduplicate by exact value. Regexes deduplicate by exact pattern and normalized flags, with implicit `g` included. Case, whitespace, Unicode and differing regex semantics are preserved. The merged, pretty-printed target must remain within 1000 rules and 1 MiB; no truncation is allowed.

当前目标规则优先，旧文件按名称顺序合并。字符串和等价字面对象按精确值去重；正则按模式和含隐式 `g` 的规范化标志去重。大小写、空白、Unicode 和不同正则语义保留。合并并格式化后仍须满足 1000 条及 1 MiB 限制，不允许截断。

## Commit and cleanup / 提交与清理

1. Acquire the directory-wide `.protecter-migration.lock` using exclusive directory creation; wait up to 5 seconds for cooperating processes.
   通过排他目录创建获取目录级迁移锁，最多等待其他协作进程 5 秒。
2. Read and validate all candidates, retain file identity/content digests, merge and validate the result.
   读取校验全部候选，记录身份及内容摘要，合并并校验结果。
3. Write a same-directory, uniquely named `.protecter-migration.<uuid>.tmp` with 0600 permissions; fsync and close it.
   在同目录排他创建唯一临时文件，设为 0600，写入、同步并关闭。
4. Recheck candidate names, identities and content. Rename the temporary file onto the target; fsync the directory on POSIX. Reopen and verify the exact committed contents.
   再检查候选集合、身份及内容，将临时文件重命名到目标，POSIX 上同步目录，重新打开验证精确内容。
5. Before each old-file deletion, recheck both the committed target and the old source. Delete only unchanged sources, then sync the directory and verify the final target.
   每次删除前同时检查目标与旧来源，仅删除未变化来源，再同步目录并验证最终目标。
6. Activate the in-memory snapshot only after success; release the lock. Migration failure leaves the instance unready and outgoing requests safely empty.
   成功后才启用内存快照并释放锁；失败时实例不就绪，出站请求安全清空。

This is recoverable, not a multi-file atomic transaction. A failure after target commit can leave both target and old files; the next run unions them again safely. Failure during deletion leaves the committed union intact. External editors do not obey the lock and TOCTOU cannot be eliminated; avoid editing during initialization. Windows lacks POSIX directory fsync, so power-loss durability is weaker.

这是一套可恢复流程，不是跨文件原子事务。目标提交后失败可能留下新旧文件，下次可安全重复合并；删除途中失败时目标已包含规则并集。外部编辑器不遵守锁，无法彻底消除竞态，请避免初始化期间编辑。Windows 缺少 POSIX 目录同步，断电持久性较弱。

A hard crash may leave the lock or a private temporary file. The plugin never steals a lock or automatically deletes unknown temporary files. Stop all Pi processes and inspect the agent directory locally before manually removing a stale lock or orphaned temporary file. Never upload those files: they may contain secrets.

硬崩溃可能遗留锁或私有临时文件。插件不抢占锁、不自动删除未知临时文件。先停止全部 Pi 进程，在本地检查目录后再手动移除残留锁或孤立临时文件；文件可能含秘密，绝不要上传。

## Memory lifecycle / 内存生命周期

Startup, `/reload` and extension-instance replacement initialize once. Outbound scans read only the cached snapshot; deleting or changing files does not affect the active instance. `/protecter status` reads only counts. `/protecter reload` requests Pi's full reload after idle. Successful reload uses disk rules; failed initialization does not fall back to plaintext. Cache and token mappings are cleared at shutdown.

启动、重载及扩展实例替换时初始化一次。出站扫描仅使用缓存，删除或修改文件不影响当前实例；状态命令只读取数量，重载命令等待空闲后请求 Pi 完整重载。成功重载使用磁盘规则，失败不回退明文；关闭时清除缓存和映射。

Deleting every config does not preserve rules across restart: a fresh instance creates an empty configuration and warns. Keep a secure user-managed backup if persistent recovery is required. Independent processes keep independent snapshots even if another process migrates their former file.

删除全部配置不能跨重启保留规则，新实例将创建空配置并警告；需要持久恢复时由用户自行安全备份。独立进程拥有独立快照，即使其他进程迁移原文件也不受影响。
