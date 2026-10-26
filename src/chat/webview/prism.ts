/**
 * Prism grammar bundle glue (webview). The component files are plain IIFEs
 * that attach to the GLOBAL `Prism`; build-webview.mjs rewires that global to
 * this bundle's own instance via `--inject` + `--define:Prism=…`, so no window
 * global is needed at runtime and the grammars register on the very instance
 * imported here (ESM `import Prism` below gets the same CSJ instance).
 *
 * ORDER MATTERS: static imports are evaluated in source order, and Prism
 * grammars may extend others (typescript←javascript←clike, markdown←markup).
 * Keep dependencies before their dependents.
 *
 * To add a language: add its dependency-order import here and an entry in
 * lang-map.ts. That's the whole cost.
 */
import "prismjs/components/prism-clike";
import "prismjs/components/prism-markup";
import "prismjs/components/prism-css";
import "prismjs/components/prism-javascript";
import "prismjs/components/prism-typescript";
import "prismjs/components/prism-json";
import "prismjs/components/prism-python";
import "prismjs/components/prism-rust";
import "prismjs/components/prism-csharp";
import "prismjs/components/prism-bash";
import "prismjs/components/prism-sql";
import "prismjs/components/prism-go";
import "prismjs/components/prism-markdown";
import Prism from "prismjs";

export default Prism;
