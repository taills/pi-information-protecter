# Build and package / 构建与打包

## Distribution / 发布产物

The repository keeps readable TypeScript in `src/`. npm packages contain compiled and minified Node.js ESM:

仓库在 `src/` 保留可读 TypeScript，npm 包包含编译压缩后的 Node.js ESM：

```text
dist/
  index.mjs
  scan-worker.mjs
  validate-worker.mjs
```

`scripts/build.mjs` uses pinned esbuild, targets Node.js 22, bundles local imports and leaves package imports external. The two workers must remain next to the entry because runtime URLs are relative to `import.meta.url`. No source maps are generated. The MIT banner and LICENSE remain; compression is not encryption or access control.

构建脚本使用固定版本 esbuild，目标为 Node.js 22，合并本地导入并保留包导入为外部引用。两个 worker 必须与入口同目录，因为运行时路径相对于 `import.meta.url`。不生成 source map，保留 MIT 标识和许可证；压缩不是加密或访问控制。

## Commands / 命令

```bash
npm ci
npm run build
npm run check
npm pack --dry-run
```

- `build` cleans and regenerates only `dist/`, which is ignored by Git.
  构建只清理并重新生成 `dist/`，该目录不提交 Git。
- `pretest` builds before the source and tarball integration tests.
  测试前先构建，再运行源码与压缩包集成测试。
- `prepack` builds before `npm pack` and `npm publish`; `prepublishOnly` runs all checks before publishing.
  打包钩子在打包和发布前构建，发布专用钩子还会先执行全部检查。
- Consumers install prebuilt npm artifacts without a compiler or postinstall build. Local source installs require `npm ci && npm run build`; direct `pi -e ./src/index.ts` remains available for development.
  用户安装 npm 成品无需编译器或安装后构建；源码本地安装需先安装依赖并构建，开发时仍可直接加载源码。
- Git URL installs that omit development dependencies cannot build this source checkout automatically. Prefer npm distribution or clone, install development dependencies and build locally.
  省略开发依赖的 Git URL 安装无法自动构建源码仓库，建议使用 npm 成品，或克隆后安装开发依赖并本地构建。

## Verification / 验证

The integration suite packs a real tarball after building, rejects source/test/build-script/map entries, extracts it into a temporary directory and loads its manifest entry using the real Pi loader. It exercises both worker paths through migration and scanning, response restoration, file guards, memory caching and failure handling. Peer resolution uses the test host; no remote model request is made.

集成测试在构建后生成真实压缩包，确认不包含源码、测试、构建脚本或映射文件，解压到临时目录并用真实 Pi 加载器加载清单入口，执行迁移与扫描两条 worker 路径、响应还原、路径防护、缓存和失败处理。peer 依赖由测试宿主提供，不调用远程模型。

Compare code bytes separately from the full tarball. Documentation is intentionally retained and may dominate the package; npm already applies gzip compression. Repeated builds with the same inputs should produce byte-identical `dist/` files.

代码字节数应与完整压缩包分别比较。文档有意保留，可能占据较大体积；npm 本身已有 gzip 压缩。同样输入的重复构建应产生逐字节相同的产物。
