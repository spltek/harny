/**
 * Extension → Prism language id map for the syntax coloring of diffs, tool
 * outputs and code fences. PURE module (no DOM): keeps the mapping
 * unit-testable. Only languages whose grammar is imported in prism.ts appear
 * here; anything else falls back to plain text (no tokens at all, which is the
 * honest answer — see highlight.ts).
 */
const EXT_LANGS: Record<string, string> = {
  // TypeScript / JavaScript
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  // python
  py: "python",
  pyi: "python",
  // rust
  rs: "rust",
  // C#
  cs: "csharp",
  // web
  html: "markup",
  htm: "markup",
  css: "css",
  // data / docs
  json: "json",
  jsonc: "json",
  md: "markdown",
  markdown: "markdown",
  // shell / sql / go
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  sql: "sql",
  go: "go",
};

/**
 * The LONG names of the same languages: a fence label is whatever the model typed after the
 * backticks (`ts`, `typescript`, `js`, `sh`, `c#`…), not an extension. Only the names that are NOT
 * already extensions belong here — `jsx` and `markdown` are both, and a second copy would be an
 * entry no test could ever see (the extension map answers first). Languages whose grammar is not in
 * the bundle are left out on purpose (`mermaid`, `diff`, `yaml`): they stay plain.
 */
const FENCE_ALIASES: Record<string, string> = {
  typescript: "typescript",
  javascript: "javascript",
  python: "python",
  rust: "rust",
  csharp: "csharp",
  "c#": "csharp",
  shell: "bash",
  shellscript: "bash",
  console: "bash",
  xml: "markup",
  golang: "go",
};

/**
 * Lookup that cannot be fooled by the prototype chain: these keys come from a PATH and from a
 * model-written fence name, so `__proto__` must resolve to nothing instead of to an object that
 * would then be handed to Prism as if it were a grammar id.
 */
function lookup(map: Record<string, string>, key: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;
}

/**
 * Prism language id for a file path, or undefined when unknown (.txt,
 * Makefile, .mdx, binary extensions…) — the caller then skips highlighting.
 *
 * The extension is the LAST dot's remainder: `a.min.js` is JavaScript, not `min.js`. A trailing dot
 * leaves an empty extension and `lookup` knows no such language, so there is no second guard for it
 * — one rule that also cannot be tested apart from the lookup it stands on.
 */
export function langIdForPath(path: string): string | undefined {
  const base = path.split(/[\\/]/).pop() ?? path;
  const dot = base.lastIndexOf(".");
  // no dot, or a hidden dotfile (`.env`, `.ts` — a file NAME, never an extension)
  if (dot <= 0) return undefined;
  return lookup(EXT_LANGS, base.slice(dot + 1).toLowerCase());
}

/**
 * Prism language id for a ```lang fence label, or undefined when the bundle has no grammar for it.
 * An unknown fence is NOT an error: markdown-it escapes the body itself and the block keeps its
 * plain look (the label still says what the model claimed it was).
 */
export function langIdForFence(name: string | undefined): string | undefined {
  // `undefined` is the "no label at all" case and would throw in `trim`; a BLANK label needs no
  // guard of its own — it looks itself up as the empty string, which no map knows.
  if (!name) return undefined;
  const key = name.trim().toLowerCase();
  return lookup(EXT_LANGS, key) ?? lookup(FENCE_ALIASES, key);
}
