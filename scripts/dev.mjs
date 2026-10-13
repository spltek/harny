/**
 * Dev build: build the extension host AND the webview ONCE, then watch BOTH for
 * changes (esbuild watch). This keeps `dist/extension.js` and `media/view.js`
 * from going stale while developing.
 *
 * NOTE: a rebuild does NOT reload the running VS Code window — after a change,
 * run "Developer: Reload Window" (or restart the Extension Development Host).
 */
import { context } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const extension = await context({
  entryPoints: [join(root, "src/extension.ts")],
  bundle: true,
  format: "cjs",
  platform: "node",
  target: ["node18"],
  // `vscode` is provided by the extension host; Node builtins stay external.
  external: ["vscode"],
  outfile: join(root, "dist/extension.js"),
  minify: false,
  sourcemap: false,
  logLevel: "info",
});

const webview = await context({
  entryPoints: [join(root, "src/chat/webview/view.ts")],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["chrome110"],
  outfile: join(root, "media/view.js"),
  minify: true,
  sourcemap: false,
  logLevel: "info",
  // Prism grammar components reference the bare global `Prism`; rewire that
  // identifier to the bundled instance (see src/chat/webview/prism-inject.ts).
  inject: [join(root, "src/chat/webview/prism-inject.ts")],
  define: { Prism: "__webview_prism" },
});

await Promise.all([extension.watch(), webview.watch()]);
console.log(
  "[harny] watching src/ → dist/extension.js + media/view.js — reload the VS Code window after a rebuild",
);
