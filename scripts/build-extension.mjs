/**
 * Bundle the extension HOST into a single CJS file: dist/extension.js
 *
 * tsc alone cannot ship runtime npm dependencies (e.g. the `diff` package
 * used by the edit tool): the installed VSIX excludes node_modules, so the
 * compiled `require("diff")` would fail at activation. esbuild inlines every
 * dependency into the bundle, keeping only `vscode` (provided by the host)
 * and Node builtins external.
 */
import { build } from "esbuild";
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// Fresh dist/: the bundle must be the ONLY file in it (no stale tsc output).
await rm(join(root, "dist"), { recursive: true, force: true });

await build({
  entryPoints: [join(root, "src/extension.ts")],
  bundle: true,
  format: "cjs",
  platform: "node",
  target: ["node18"],
  // `vscode` is provided by the VS Code extension host at runtime; Node
  // builtins stay external automatically on platform=node.
  external: ["vscode"],
  outfile: join(root, "dist/extension.js"),
  minify: false,
  sourcemap: false,
  logLevel: "info",
});