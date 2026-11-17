// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { highlightToHtml, HIGHLIGHT_MAX_CHARS } from "./highlight";

/**
 * The COLORING is not what these tests are about: they pin the two promises the rest of the panel
 * stands on — the language is never guessed, and the text comes back identical.
 */

/** The Input of a tool, exactly as `formatArgs` produces it (quotes, escapes and newlines). */
const ARGS_JSON = JSON.stringify(
  { path: "/workspace/src/a.ts", content: 'const s = "x\\y";\n// ünïcode & <tags>' },
  null,
  2,
);

describe("highlightToHtml", () => {
  it("tokenizes a known language", () => {
    const html = highlightToHtml("const a = 1;", "typescript");
    expect(html).toContain('class="token keyword"');
    expect(html).toContain("const");
  });

  it("tokenizes JSON properties (the tool Input case)", () => {
    expect(highlightToHtml(ARGS_JSON, "json")).toContain('class="token property"');
  });

  it("returns the SAME text it was given (the Diff parses the Input back)", () => {
    const html = highlightToHtml(ARGS_JSON, "json")!;
    const holder = document.createElement("pre");
    holder.innerHTML = html;
    // Byte-identical, escapes included: `extractPath` does JSON.parse on this textContent, and a
    // highlighter that dropped a quote would silently remove the Diff section from every bubble.
    expect(holder.textContent).toBe(ARGS_JSON);
    expect(JSON.parse(holder.textContent!)).toEqual(JSON.parse(ARGS_JSON));
  });

  it("escapes what it emits (never raw markup from a file)", () => {
    const html = highlightToHtml("<script>alert(1)</script>", "markup")!;
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;");
  });

  it("returns null when there is no language to trust", () => {
    expect(highlightToHtml("ls -la output", undefined)).toBeNull();
    expect(highlightToHtml("ls -la output", "")).toBeNull();
  });

  it("returns null for a language with no bundled grammar", () => {
    expect(highlightToHtml("graph TD; a-->b", "mermaid")).toBeNull();
    // a fence label is model-written, so the prototype chain must not answer for it
    expect(highlightToHtml("x", "__proto__")).toBeNull();
  });

  it("returns null for whitespace and for text over the budget", () => {
    expect(highlightToHtml("   \n ", "json")).toBeNull();
    const big = "a".repeat(HIGHLIGHT_MAX_CHARS + 1);
    expect(highlightToHtml(big, "typescript")).toBeNull();
    // one character under the cap still goes through: the budget is a limit, not a guess
    expect(highlightToHtml("a".repeat(HIGHLIGHT_MAX_CHARS), "typescript")).not.toBeNull();
  });
});
