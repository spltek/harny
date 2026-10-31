import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";

/**
 * THE DOM CONTRACT between the webview's modules and the markup.
 *
 * Splitting `view.ts` moved the code that WRITES classes away from the file that DEFINES them
 * (`view-html.ts`: the markup and the CSS). Nothing links the two at compile time, so a renamed class
 * is a silent failure — a row with no style, a hidden control that still works, a `.off` state nobody
 * paints. This test closes that gap by reading both sides.
 *
 * A class is legitimate in one of two ways:
 *   · STYLED — `view-html.ts` mentions it, in the markup or as a CSS selector;
 *   · a HOOK — something SELECTS it (a `querySelector` in a module, or a test). A hook is a real
 *     contract too: renaming it breaks the selector, and this test then fails from the other side.
 *
 * Anything else is a name nobody uses: dead weight that will one day be mistaken for a working style.
 */

const here = new URL(".", import.meta.url);
const src = (path: string): string => readFileSync(new URL(path, here), "utf8");
/** A webview module, by file name (they live in `./webview/` next door). */
const webview = (file: string): string => src(`./webview/${file}`);

/** The modules that build DOM. `view.ts` is one of them, just the biggest. */
const MODULES = [
  "view.ts",
  "pending-section.ts",
  "find.ts",
  "mcp-card.ts",
  "mcp-tools-popover.ts",
  "mcp-editor.ts",
  "fold.ts",
  "switch.ts",
];
const HTML = src("./view-html.ts");
/**
 * The stylesheet lives in its own file (media/view.css, generated into view-css.ts) instead of
 * inside view-html.ts: the contract this file guards is about MARKUP **and** CSS, so both are
 * read, and the rules are parsed from the sheet itself.
 */
const CSS_TEXT = src("../../media/view.css");

/**
 * Class names a module WRITES. The shapes used in this codebase:
 *   className = "a b"
 *   className = "a" + (cond ? " b" : "")
 *   classList.add/toggle/remove/contains("a")
 * Template literals and variables are skipped: they cannot be checked statically. A token ending in
 * `-` is a PREFIX being concatenated (`"status-" + kind`), not a class.
 */
function writtenClasses(source: string): Set<string> {
  const out = new Set<string>();
  for (const m of source.matchAll(/className\s*=\s*"([^"$]+)"/g)) {
    for (const cls of m[1].split(/\s+/)) if (cls && !cls.endsWith("-") && !cls.includes("+")) out.add(cls);
  }
  for (const m of source.matchAll(/classList\.(?:add|toggle|remove|contains)\("([^"]+)"\)/g)) {
    if (!m[1].endsWith("-")) out.add(m[1]);
  }
  return out;
}

/** Every string used as a selector anywhere in `src/chat` (modules AND tests): the HOOK side. */
function selectorClasses(): Set<string> {
  const out = new Set<string>();
  const walk = (dir: URL): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const child = new URL(entry.name + (entry.isDirectory() ? "/" : ""), dir);
      if (entry.isDirectory()) {
        walk(child);
        continue;
      }
      if (!entry.name.endsWith(".ts") || entry.name.endsWith(".d.ts")) continue;
      const text = readFileSync(child, "utf8");
      // The generic is allowed for: `querySelector<HTMLButtonElement>("button.folder-btn")`.
      for (const m of text.matchAll(/(?:querySelectorAll|querySelector|closest|matches)(?:<[^>]*>)?\(\s*"([^"]+)"/g)) {
        for (const cls of m[1].matchAll(/\.([A-Za-z][\w-]*)/g)) out.add(cls[1]);
      }
    }
  };
  walk(new URL("../", here));
  return out;
}

const HOOKS = selectorClasses();

/** Styled: the markup or CSS mentions it as a whole token. */
function isStyled(cls: string): boolean {
  const escaped = cls.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\.${escaped}(?![\\w-])`).test(HTML + CSS_TEXT);
}

const written = MODULES.flatMap((m) => [...writtenClasses(webview(m))].map((cls) => ({ cls, module: m })));

/**
 * THE OTHER DIRECTION: the stylesheet → the code.
 *
 * The checks above catch a class with no style. Nothing caught the opposite — a RULE nobody dresses
 * any more — and that is the one that rots in silence: no compiler, no test, no error at runtime, just
 * dead weight that later reads like a working feature. Five rules were found this way the day this
 * test was written (`build-cta-btn`, `msg-attach-chips`, `optgroup-failed`, `option-error`, the old
 * `task-list-item-checkbox`).
 *
 * Both sides are read the way the code actually spells them, or the test would lie:
 *   · COMMENTS are prose, not selectors (`.logoUri` lived in a CSS comment);
 *   · only SELECTOR positions count (before a `{`), so `--ctl-row` and property values are out;
 *   · a class can be PRODUCED by a literal, by a template, or by CONCATENATION (`"status-" + status`,
 *     `'class="subagent-chip access-' + kind`): a literal ending in `-` is a prefix, not a class.
 */
const STYLE = (() => {
  const open = CSS_TEXT.indexOf("<style>");
  const close = CSS_TEXT.indexOf("</style>");
  // The sheet IS the stylesheet now; a page-embedded copy (an older layout) still works.
  return open === -1 || close === -1 ? CSS_TEXT : CSS_TEXT.slice(open, close);
})();

/** Class names the stylesheet SELECTS. */
function styledClasses(): Set<string> {
  const css = STYLE.replace(/\/\*[\s\S]*?\*\//g, ""); // comments are prose
  const out = new Set<string>();
  for (const block of css.matchAll(/([^{}]+)\{/g)) {
    const selector = block[1];
    if (selector.trim().startsWith("@")) continue; // at-rules, not selectors
    for (const m of selector.matchAll(/\.([A-Za-z][\w-]*)/g)) out.add(m[1]);
  }
  return out;
}

/**
 * Every name that can END UP as a class in the DOM, and every PREFIX one is built from.
 * Strings are tokenised on whitespace: `class="a b"` dresses two classes, `"access-" + kind` dresses
 * a family.
 */
function producedClasses(): { names: Set<string>; prefixes: Set<string> } {
  const names = new Set<string>();
  const prefixes = new Set<string>();
  const eat = (literal: string): void => {
    for (const raw of literal.split(/\s+/)) {
      const token = raw.trim();
      if (!token || token.includes("+") || token.includes("$")) continue; // an interpolation, not a name
      if (token.endsWith("-")) prefixes.add(token);
      else names.add(token);
    }
  };
  const walk = (dir: URL): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const child = new URL(entry.name + (entry.isDirectory() ? "/" : ""), dir);
      if (entry.isDirectory()) {
        walk(child);
        continue;
      }
      if (!entry.name.endsWith(".ts") || entry.name.endsWith(".d.ts")) continue;
      const text = readFileSync(child, "utf8");
      // TARGETED patterns, not a sweep of every string literal: one apostrophe in a comment ("does
      // not") shifts the pairing of every quote after it, and the whole check would quietly read
      // prose. These are the shapes this codebase actually uses to put a class on an element.
      // The WHOLE statement: `"srow" + (open ? " open" : "") + (busy ? " is-working" : "")` dresses
      // three names, and reading only the first literal loses two of them. Only the QUOTED parts are
      // names — the code around them is not.
      for (const stmt of text.matchAll(/className\s*=\s*([^;\n]*)/g)) {
        for (const lit of stmt[1].matchAll(/"([^"\n]*)"|`([^`\n]*)`|'([^'\n]*)'/g)) {
          eat(lit[1] ?? lit[2] ?? lit[3] ?? "");
        }
      }
      for (const stmt of text.matchAll(/classList\.(?:add|toggle|remove|contains)\(([^)\n]*)\)/g)) {
        for (const lit of stmt[1].matchAll(/"([^"\n]*)"/g)) eat(lit[1]);
      }
      // The markup's ATTRIBUTE (both quote styles: the bubbles build spans from single-quoted
      // fragments, and a concatenated tail like `access-'` is a PREFIX, not a class).
      for (const m of text.matchAll(/class=\\?"([^"$]*)\\?"/g)) eat(m[1]);
      for (const m of text.matchAll(/class=\\?'([^'$]*)\\?'/g)) eat(m[1]);
      // …and the tail that is still open: `class="subagent-chip access-'` continues elsewhere.
      for (const m of text.matchAll(/class=["']([^"']*)["']?\s*\+/g)) eat(m[1]);
      // A SELECTOR is a producer too: it names a class something must create, and the forward check
      // already treats it as a contract.
      for (const m of text.matchAll(/(?:querySelectorAll|querySelector|closest|matches)(?:<[^>]*>)?\(\s*"([^"]+)"/g)) {
        for (const cls of m[1].matchAll(/\.([A-Za-z][\w-]*)/g)) names.add(cls[1]);
      }
    }
  };
  walk(new URL("../", here));
  return { names, prefixes };
}

const produced = producedClasses();
const styled = styledClasses();

/**
 * Names the stylesheet dresses but no code of OURS writes, with the reason it is legitimate.
 * Kept short on purpose: an allowlist that swallows everything is a disabled test. Every entry is a
 * FAMILY or an external owner — never "I could not find it".
 */
const CSS_HOOKS = new Map<string, string>([
  // Prism owns these: the highlighter writes the token classes into the <code> blocks.
  ...[
    "token",
    "comment",
    "punctuation",
    "keyword",
    "string",
    "number",
    "boolean",
    "constant",
    "builtin",
    "function",
    "function-variable",
    "class-name",
    "maybe-class-name",
    "atrule",
    "attr-name",
    "attr-value",
    "selector",
    "regex",
    "prolog",
    "doctype",
    "cdata",
    "entity",
    "char",
    "important",
    "operator",
    "url",
    "symbol",
    "variable",
    "property",
    "tag",
    "namespace",
    "literal-property",
    "interpolation",
    "interpolation-punctuation",
    "template-string",
    "template-punctuation",
    "string-property",
  ].map((c) => [c, "written by Prism, the highlighter"] as const),
  // VS Code puts the editor's kind on <body>; the palette follows it (see view-config.ts).
  ...["vscode-dark", "vscode-light", "vscode-high-contrast"].map((c) => [c, "written by VS Code on <body>"] as const),
]);

describe("the DOM contract between the modules and view-html", () => {
  it("finds classes to check (the parser itself must bite)", () => {
    // A guard on the guard: if the regexes stopped matching, this test would pass for ever.
    expect(written.length).toBeGreaterThan(30);
    expect(written.map((w) => w.cls)).toContain("harny-switch");
    expect(written.map((w) => w.cls)).toContain("mcp-pop-row");
    expect(HOOKS.size).toBeGreaterThan(20);
  });

  it("every class a module writes is either STYLED or SELECTED by something", () => {
    const dead = written
      .filter((w) => !isStyled(w.cls) && !HOOKS.has(w.cls))
      .map((w) => `${w.cls} (written by ${w.module})`);
    expect([...new Set(dead)]).toEqual([]);
  });

  it("every module that writes DOM is in the list (a new module cannot slip past the check)", () => {
    // Any file here that assigns a className must be listed above: a sixth module would otherwise
    // write classes nobody checks.
    const files = readdirSync(new URL("./webview/", import.meta.url))
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.endsWith(".d.ts"))
      .filter((f) => /className\s*=|classList\.(?:add|toggle)/.test(webview(f)))
      .sort();
    expect(files).toEqual([...MODULES].filter((m) => files.includes(m)).sort());
  });

  it("the parsers bite (both directions must fail when the code stops matching)", () => {
    // A guard on the guard: if these regexes silently stopped matching, both checks would pass for
    // ever. They are pinned on real names the page ships.
    expect(styled.size).toBeGreaterThan(300);
    expect(styled.has("msg")).toBe(true);
    expect(styled.has("todo-check")).toBe(true);
    expect(produced.names.has("todo-check")).toBe(true);
    expect(produced.prefixes.has("status-")).toBe(true);
    // …and the allowlist stays a list of FAMILIES, not a dumping ground.
    expect(CSS_HOOKS.size).toBeLessThan(60);
  });

  it("every class the STYLESHEET selects is written by someone — or declared a hook", () => {
    // The opposite of the check above, and the one nobody had: a rule that dresses nothing. Five
    // were found this way on the first run (`.build-cta-btn`, `.msg-attach-chips`,
    // `#model-select optgroup.optgroup-failed`, `#model-select .option-error`, and the old
    // `.task-list-item-checkbox`).
    const orphans = [...styled]
      .filter((cls) => !produced.names.has(cls))
      .filter((cls) => ![...produced.prefixes].some((prefix) => cls.startsWith(prefix)))
      .filter((cls) => !CSS_HOOKS.has(cls))
      .sort();
    expect(orphans, "delete the rule, or declare it in CSS_HOOKS with the reason").toEqual([]);
  });
});
