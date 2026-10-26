/**
 * Bundle the webview client (sessions + tabs + chat logic)
 * into a single browser file: media/view.js
 */
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

await build({
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
  // identifier to the bundled instance so no window global is needed (see
  // src/chat/webview/prism.ts / prism-inject.ts).
  inject: [join(root, "src/chat/webview/prism-inject.ts")],
  define: { Prism: "__webview_prism" },
  // Icon artwork is authored as files under media/icons/ and inlined here as
  // text (see src/chat/icons.ts): no runtime fetch, no CSP entry to add.
  loader: { ".svg": "text" },
});
