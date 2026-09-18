# Release process / 发布流程

## Conventions / 发布约定

- Package: `pi-information-protecter`; public npm registry; initial version `0.1.0`.
  包名如上，发布至 npm 公共仓库，首版为 `0.1.0`。
- Git remote: `https://github.com/taills/pi-information-protecter`.
  Git 远端为上述仓库。
- Verify, commit and push source before publishing the matching npm version. Create and push a version tag after npm publication succeeds.
  先验证、提交和推送源码，再发布对应 npm 版本；npm 成功后创建并推送版本标签。
- Never overwrite a published version. Increment the version for subsequent fixes.
  不覆盖已发布版本，后续修复需递增版本号。
- Use standard npm authentication; never store credentials in source, command records or documentation.
  使用 npm 标准认证，不把凭证写入源码、命令记录或文档。
- All Markdown, code comments, commit messages and annotated tag messages must be English + Simplified Chinese.
  所有 Markdown、代码注释、提交信息和附注标签信息必须使用英文＋简体中文。

## Maintainer checklist / 维护者检查清单

1. Check `git status`, the branch and remote; preserve other contributors' changes.
   检查工作区、分支与远端，保留其他贡献者的修改。
2. Update package version, README compatibility and CHANGELOG. For the first release, include repository, homepage, bugs and license metadata. Review bilingual completeness.
   更新版本、兼容说明和日志，首版补齐仓库、主页、反馈和许可证元数据，并检查双语完整性。
3. Run `npm ci` and `npm run check`. Use fictional secrets. Explicitly disclose if real-gateway end-to-end testing was not performed.
   执行安装和检查，使用虚构敏感值；未执行真实网关端到端测试时须如实说明。
4. Run `npm pack --dry-run --json`. Verify all source files, especially `scan-worker.mjs`, examples, README, SECURITY, CHANGELOG and LICENSE are included. Exclude real configuration, sessions, logs and node_modules.
   预检打包清单，确认包含全部源码、worker、示例与必要文档，不包含真实配置、会话、日志和依赖目录。
5. Run `git diff --check`, review staged files, commit with a bilingual message and push `main`.
   检查差异，审查暂存文件，用双语提交信息提交并推送主分支。
6. Run `npm whoami --registry=https://registry.npmjs.org` and confirm that the target version is not already published.
   确认 npm 登录账号，并查询目标版本尚未发布。
7. Publish with the following command. `prepublishOnly` repeats typechecking and tests. The maintainer must complete OTP/browser/permission requirements; do not bypass authentication.
   使用以下命令发布，发布前钩子会再次运行类型检查和测试；OTP、浏览器验证或权限要求由维护者完成，不绕过认证。

   ```bash
   npm publish --access public --registry=https://registry.npmjs.org
   ```

8. Confirm success, then query the exact version, dist-tag and tarball integrity.
   确认成功后查询精确版本、分发标签及压缩包完整性。

   ```bash
   npm view pi-information-protecter@0.1.0 version dist.integrity dist.tarball --json --registry=https://registry.npmjs.org
   npm view pi-information-protecter dist-tags --json --registry=https://registry.npmjs.org
   ```

9. Create and push the tag on the published commit.
   在已发布的提交上创建并推送标签。

   ```bash
   git tag -a v0.1.0 -m "Release v0.1.0 / 发布 v0.1.0"
   git push origin v0.1.0
   ```

10. Verify a clean working tree and matching local/remote commits. Record commit, tag, npm URL and validation results in both languages.
    验证工作区干净、本地远端提交一致，以双语记录提交、标签、npm 地址和验证结果。

## Failure handling / 失败处理

- Git push failure: preserve the local commit, fix remote/permission issues and retry without force-pushing.
  推送失败时保留本地提交，解决远端或权限问题后重试，不强推。
- npm failure: preserve the pushed commit and report failure; never claim publication succeeded.
  npm 失败时保留已推送提交并明确报告，不宣称已发布。
- npm timeout: query the exact version before retrying, because publication may already have succeeded.
  npm 超时时先查精确版本，避免实际已成功而重复发布。
- Tag push failure after npm success: record that npm is published and retry the tag push later; do not republish the same version.
  npm 成功但标签推送失败时记录已发布状态，后续补推标签，不重发同一版本。
