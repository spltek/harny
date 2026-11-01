/**
 * Bundle the webview client (sessions + tabs + chat logic)
 * into a single browser file: media/view.js
 */
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// `WEBVIEW_OUT` lets a TEST rebuild the same bundle next to the committed one and compare the
// two byte for byte (see src/bundle-fresh.test.ts): `media/view.js` is what the webview actually
// loads, so a fix that lands only in src/ ships as nothing at all.
const outfile = process.env.WEBVIEW_OUT ?? join(root, "media/view.js");

await build({
  entryPoints: [join(root, "src/chat/webview/view.ts")],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["chrome110"],
  outfile,
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
