# 发布流程

## 发布约定

- 包名：`pi-information-protecter`；npm 公共 registry；首版 `0.1.0`。
- Git 远端：`https://github.com/taills/pi-information-protecter`。
- 先验证、提交并推送源码，再发布相同版本的 npm 包；npm 成功后创建并推送版本标签。
- 不覆盖已发布版本。若发现问题，修复后递增版本号再发布。
- 发布凭证仅通过 npm 标准登录／认证机制提供，不写入仓库、命令记录或文档。

## 维护者检查清单

1. 核对 `git status`、分支和远端；确认不存在其他人的未处理修改。
2. 更新 `package.json` 版本、README 兼容说明和 CHANGELOG。首次发布前补齐 repository、homepage、bugs、license。
3. 执行 `npm ci` 和 `npm run check`。测试只使用虚构信息；真实网关端到端验证若未执行，应如实说明。
4. 执行 `npm pack --dry-run --json`，确认包含所有 `src/` 文件（特别是 `scan-worker.mjs`）、示例、README、SECURITY、CHANGELOG 和 LICENSE，不包含真实配置、会话、日志或 node_modules。
5. 执行 `git diff --check`，审查所有暂存文件，提交并推送 `main`。
6. 执行 `npm whoami --registry=https://registry.npmjs.org`，确认账号；查询目标版本尚未发布。
7. 执行发布命令：

   ```bash
   npm publish --access public --registry=https://registry.npmjs.org
   ```

   `prepublishOnly` 会再次运行类型检查和测试。需要 OTP、浏览器验证或权限时由维护者完成认证，不绕过认证要求。

8. 确认返回成功，并查询 registry 中的精确版本、dist-tag 及 tarball integrity：

   ```bash
   npm view pi-information-protecter@0.1.0 version dist.integrity dist.tarball --json --registry=https://registry.npmjs.org
   npm view pi-information-protecter dist-tags --json --registry=https://registry.npmjs.org
   ```

9. 在相同提交上创建并推送标签：

   ```bash
   git tag -a v0.1.0 -m "Release v0.1.0"
   git push origin v0.1.0
   ```

10. 验证工作区干净、远端提交与本地一致；发布记录应提供 commit、tag、npm 链接及验证结果。

## 失败与中断

- Git 推送失败：保留本地提交，解决远端／权限问题后重试，不强推。
- npm 发布失败：保留已推送提交，明确报告失败，切勿宣称包已上线。
- npm 返回超时：先查询目标精确版本，防止其实已经发布而重复执行。
- npm 成功而 tag 推送失败：记录包已发布，后续补推标签；不要重发同一版本。
