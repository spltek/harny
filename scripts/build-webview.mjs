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
  minify: false,
  sourcemap: false,
  logLevel: "info",
});
