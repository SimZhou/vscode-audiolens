import { context } from "esbuild";

const watch = process.argv.includes("--watch");

const shared = {
  bundle: true,
  sourcemap: watch,
  // 发布构建压缩；watch 模式保留可读性便于调试
  minify: !watch,
  logLevel: "info"
};

const extension = await context({
  ...shared,
  entryPoints: ["src/extension.ts"],
  outfile: "dist/extension.js",
  platform: "node",
  format: "cjs",
  external: ["vscode"],
  target: "node20"
});

const webview = await context({
  ...shared,
  entryPoints: ["src/webview/main.ts"],
  outfile: "dist/webview.js",
  platform: "browser",
  format: "iife",
  target: "es2022"
});

const audioCacheWorker = await context({
  ...shared,
  entryPoints: ["src/extension/audioCacheWorker.ts"],
  outfile: "dist/audioCacheWorker.js",
  platform: "node",
  format: "cjs",
  target: "node20"
});

if (watch) {
  await Promise.all([extension.watch(), webview.watch(), audioCacheWorker.watch()]);
} else {
  await Promise.all([extension.rebuild(), webview.rebuild(), audioCacheWorker.rebuild()]);
  await Promise.all([extension.dispose(), webview.dispose(), audioCacheWorker.dispose()]);
}
