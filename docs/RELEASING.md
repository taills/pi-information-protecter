# Release process / 发布流程

## Trusted publishing / 可信发布

Releases use GitHub Actions OIDC, not a long-lived npm token. Workflow: [`.github/workflows/publish.yml`](../.github/workflows/publish.yml). npm `0.1.0` already exists; do not publish that version again.

发布采用 GitHub Actions OIDC，不使用长期 npm 令牌。工作流见上述文件。npm 已存在 `0.1.0`，不要重复发布该版本。

Configure the following trusted publisher at [npm package access settings](https://www.npmjs.com/package/pi-information-protecter/access). Saving requires the maintainer's npm security-key/2FA verification.

在上述 npm 包访问设置页配置以下可信发布者，保存需要维护者完成 npm 安全密钥／双因素认证。

| Field / 字段 | Value / 值 |
| --- | --- |
| Publisher / 发布者 | GitHub Actions |
| Organization or user / 组织或用户 | `taills` |
| Repository / 仓库 | `pi-information-protecter` |
| Workflow filename / 工作流文件名 | `publish.yml` |
| Environment name / 环境名 | `npm` |
| Allowed action / 允许操作 | Allow npm publish / 允许直接发布 |

Values are case-sensitive. The filename excludes `.github/workflows/`. Merely filling the form does not save trust: finish authentication and verify the connection is listed. No `NPM_TOKEN` or `NODE_AUTH_TOKEN` repository secret is required. Existing npm account security settings do not need to be weakened.

各字段区分大小写，文件名不包含目录。仅填写表单并不代表已保存信任关系，需完成认证并确认连接出现在列表中。不需要仓库令牌密钥，也不需要降低 npm 账号安全设置。

The GitHub `npm` environment allows only `v*` tags. Validation runs without OIDC permissions; only the publishing job receives `id-token: write`. Actions are pinned to commit hashes, checkout does not persist credentials, and release builds disable dependency caching. GitHub-hosted Ubuntu uses Node.js 24 and npm 11.16.0 (OIDC requires npm ≥11.5.1 and Node ≥22.14).

GitHub 的 `npm` 环境仅允许 `v*` 标签部署。验证任务没有 OIDC 权限，仅发布任务获得令牌写权限。Actions 固定到提交哈希，检出不持久化凭证，发布构建关闭依赖缓存。使用 GitHub 托管 Ubuntu、Node.js 24 和 npm 11.16.0，满足 OIDC 最低版本要求。

## Validate without publishing / 不发布的验证

From the repository's Actions tab, choose **Publish to npm / 发布到 npm**, select `main`, and run with `dry_run=true` (the default). It installs locked dependencies, typechecks, tests and inspects the package. The publish job is skipped; this does not prove npm OIDC authentication works.

在仓库 Actions 页面选择发布工作流，选取 `main`，使用默认的 `dry_run=true` 执行。流程安装锁定依赖、类型检查、测试并检查包内容；跳过发布任务，因此不能证明 npm OIDC 认证可用。

```bash
gh workflow run publish.yml --ref main -f dry_run=true
```

## Publish a new version / 发布新版本

1. Confirm a clean worktree and review changes. Update README, SECURITY and CHANGELOG as needed. All Markdown, comments, commit and tag messages must be English + Simplified Chinese.
   确认工作区干净并审查修改，按需更新上述文档；所有 Markdown、注释、提交和标签信息使用英文＋简体中文。
2. Increment `package.json` and the lockfile without automatically creating a tag. For the next patch after 0.1.0:
   更新版本和锁文件，不自动创建标签。0.1.0 之后的补丁版示例：

   ```bash
   npm version patch --no-git-tag-version
   npm ci
   npm run check
   npm pack --dry-run
   git diff --check
   ```

3. Review and stage only intended changes; commit and push `main` with a bilingual message. The following assumes the next version is 0.1.1:
   审查并暂存预期修改，用双语提交并推送主分支。以下假设下个版本是 0.1.1：

   ```bash
   git add package.json package-lock.json CHANGELOG.md
   git commit -m "chore: prepare v0.1.1 / 准备 v0.1.1"
   git push origin main
   git tag -a v0.1.1 -m "Release v0.1.1 / 发布 v0.1.1"
   git push origin v0.1.1
   ```

4. **The tag push triggers npm publication automatically.** The workflow rejects tags that do not exactly match `package.json`. Only stable `X.Y.Z` releases are supported; prereleases need a separate dist-tag policy before enabling them. It runs `npm publish --access public --provenance`; `prepublishOnly` repeats validation. Publishing jobs are serialized and never cancelled by a newer release.
   **推送标签会自动触发 npm 发布。** 标签必须精确匹配包版本，目前仅支持稳定版 `X.Y.Z`；预发布版本需先增加分发标签策略。流程公开发布并附来源证明，发布前再次验证；发布任务串行执行，不被后续发布取消。
5. Verify the Actions run, exact registry version, `latest` and provenance. Record commit, tag, npm URL and results in both languages. Do not claim success based only on a tag push.
   验证 Actions 结果、registry 精确版本、最新标签和来源证明，以双语记录提交、标签、npm 地址和结果，不能仅凭标签已推送就宣称成功。

   ```bash
   npm view pi-information-protecter@0.1.1 version dist.integrity dist.tarball --json
   npm view pi-information-protecter dist-tags --json
   ```

## Recovery / 失败恢复

- If authentication fails, verify npm trust, exact workflow filename, environment, repository URL and completion of 2FA. Do not add a write token as an automatic fallback.
  认证失败时检查信任配置、文件名、环境、仓库地址及双因素认证完成情况，不自动回退写入令牌。
- A failed release can be rerun from Actions, or manually dispatched with the matching tag and `dry_run=false`, after fixing external configuration. Branch-based real publishing is rejected.
  修复外部配置后可重跑失败任务，或针对匹配标签以 `dry_run=false` 手动执行；拒绝从分支执行真实发布。
- On timeout, query the exact npm version before retrying. Published versions are immutable. Never move a release tag or force-push to conceal a failure; use a new version for source fixes.
  超时先查询精确 npm 版本再重试；已发布版本不可覆盖。不要移动标签或强推掩盖失败，源码修复使用新版本。

References: [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) and [npm provenance](https://docs.npmjs.com/generating-provenance-statements).

参考资料：上述 npm 官方可信发布和来源证明文档。
