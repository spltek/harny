/**
 * esbuild --inject entry: exposes the bundled Prism instance under the export
 * name referenced by the `define: { Prism: "__webview_prism" }` in BOTH build
 * entry points — scripts/build-webview.mjs AND scripts/dev.mjs. The Prism
 * grammar component files reference the bare global `Prism`; the define +
 * inject pair rewires those references to THIS instance so the grammars
 * register on the same object the rest of the view uses.
 *
 * DO NOT remove this export as "unused": nothing under src/ or any test names it.
 * The only consumer is esbuild, through the define above — delete it and the
 * grammars quietly stop registering in the built bundle, with no failing test.
 */
import Prism from "prismjs";
export { Prism as __webview_prism }; // consumed by esbuild `define`, not by code
