import { build } from "esbuild";
import { rm, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outdir = join(root, "dist");
await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

// Keep worker URLs relative to the bundled entry and host packages external.
// 保持 worker 与入口的相对路径，并将宿主依赖保留为外部引用。
await build({
  absWorkingDir: root,
  entryPoints: [
    "src/index.ts",
    "src/scan-worker.mjs",
    "src/validate-worker.mjs",
  ],
  outdir,
  outExtension: { ".js": ".mjs" },
  bundle: true,
  packages: "external",
  platform: "node",
  format: "esm",
  target: "node22",
  minify: true,
  sourcemap: false,
  charset: "utf8",
  legalComments: "none",
  banner: {
    js: "/*! SPI Protecter | MIT | see LICENSE / SPI 隐私保护插件 | MIT 许可 */",
  },
  logLevel: "info",
});
