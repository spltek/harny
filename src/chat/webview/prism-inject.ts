/**
 * esbuild --inject entry: exposes the bundled Prism instance under the export
 * name referenced by build-webview.mjs's `define: { Prism: "…" }`. The Prism
 * grammar component files reference the bare global `Prism`; the define +
 * inject pair rewires those references to THIS instance so the grammars
 * register on the same object the rest of the view uses.
 */
import Prism from "prismjs";
export { Prism as __webview_prism };