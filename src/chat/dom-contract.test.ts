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
];
const HTML = src("./view-html.ts");

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
  return new RegExp(`\\.${escaped}(?![\\w-])`).test(HTML);
}

const written = MODULES.flatMap((m) => [...writtenClasses(webview(m))].map((cls) => ({ cls, module: m })));

describe("the DOM contract between the modules and view-html", () => {
  it("finds classes to check (the parser itself must bite)", () => {
    // A guard on the guard: if the regexes stopped matching, this test would pass for ever.
    expect(written.length).toBeGreaterThan(30);
    expect(written.map((w) => w.cls)).toContain("mcp-switch");
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
});
