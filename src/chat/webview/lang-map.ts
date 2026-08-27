/**
 * Extension → Prism language id map for the diff bubble's syntax coloring.
 * PURE module (no DOM): keeps the mapping unit-testable. Only languages whose
 * grammar is imported in prism.ts appear here; anything else falls back to
 * plain diff coloring (green/red without tokens).
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
 * Prism language id for a file path, or undefined when unknown (.txt,
 * Makefile, .mdx, binary extensions…) — the caller then skips highlighting.
 */
export function langIdForPath(path: string): string | undefined {
  const base = path.split("/").pop() ?? path;
  const dot = base.lastIndexOf(".");
  // no extension, hidden dotfile (.env), or trailing dot
  if (dot <= 0 || dot === base.length - 1) return undefined;
  return EXT_LANGS[base.slice(dot + 1).toLowerCase()];
}