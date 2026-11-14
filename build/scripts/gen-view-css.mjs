/**
 * Regenerates `src/chat/view-css.ts` from `media/view.css`.
 *
 * Why a generated module instead of importing the stylesheet:
 *  · `media/view.css` is a REAL css file — formatted, lintable, diffable — which is the whole
 *    point (the sheet used to live inside a template literal, where a stray backtick was a
 *    syntax error nobody could catch);
 *  · the panel needs it as a STRING, and importing it as a module requires both bundlers
 *    (esbuild for the extension, Vite for the tests) to agree on how CSS is loaded — they do
 *    not: Vitest stubs every CSS import, `?raw` included;
 *  · so the string is JSON-encoded into a generated TS module: no template literal, no `${`,
 *    no loader, identical bytes for the host, the tests and the packaged bundle.
 *
 * The generated file is COMMITTED (like `media/view.js`) so nothing has to run before a test,
 * and `view-css.test.ts` fails if the two ever drift apart.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
// NORMALISE the line endings: the generated module is committed, so it must be byte-identical
// whichever OS generated it. Without this, a CRLF checkout (Git for Windows) produced a module
// that differed from the committed one and `view-css.test.ts` failed on Windows only.
const css = readFileSync(join(root, "media/view.css"), "utf8").replace(/\r\n/g, "\n");

const out = `// GENERATED from media/view.css by build/scripts/gen-view-css.mjs — do not edit by hand.
// Rebuild with \`npm run gen:css\` (the build does it too). The stylesheet is a real .css file
// on purpose: a formatter and a linter can read it, and a backtick in it can no longer break
// the template literal that builds the panel.
export const VIEW_CSS = ${JSON.stringify(css)};
`;

writeFileSync(join(root, "src/chat/view-css.ts"), out);
console.log(`view-css.ts: ${css.split("\n").length} lines of css, ${out.length} bytes of TS`);
