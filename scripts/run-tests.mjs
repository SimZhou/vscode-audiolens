import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";

import { build } from "esbuild";

const testEntrypoints = ["src/webview/playbackAlgorithms.test.ts"];
const outdir = await mkdtemp(join(tmpdir(), "audiolens-tests-"));

try {
  await build({
    entryPoints: testEntrypoints,
    outdir,
    entryNames: "[name]",
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node20",
    sourcemap: "inline",
    logLevel: "silent",
    outExtension: { ".js": ".mjs" }
  });

  const bundledTests = testEntrypoints.map((entrypoint) => join(outdir, basename(entrypoint).replace(/\.ts$/, ".mjs")));
  const result = spawnSync(process.execPath, ["--test", ...bundledTests], { stdio: "inherit" });
  process.exitCode = result.status ?? 1;
} finally {
  await rm(outdir, { recursive: true, force: true });
}
