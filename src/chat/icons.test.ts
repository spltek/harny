import { readdirSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { ICON_NAMES, fileBadgeIcon, icon, toolIcon, todoStatusIcon } from "./icons";

/** Every .ts file under src/ (the walk never enters node_modules). */
function tsSources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) tsSources(path, out);
    else if (entry.name.endsWith(".ts")) out.push(path);
  }
  return out;
}

/** src-relative, forward slashes: the same in the assertion message on every OS. */
function relative(file: string): string {
  return file
    .slice(process.cwd().length + 1)
    .split(sep)
    .join("/");
}

describe("icon registry", () => {
  it("renders the artwork at the size the caller asks for", () => {
    // The FILE owns the drawing (paths, viewBox); the call site owns the size.
    expect(icon("gear", 14)).toMatch(/^<svg width="14" height="14" /);
    expect(icon("gear", 14)).toContain('viewBox="0 0 24 24"');
    expect(icon("close", 11)).toMatch(/^<svg width="11" height="11" /);
    expect(icon("close", 11)).toContain("M18 6 6 18M6 6l12 12");
  });

  it("keeps the drawing but drops what is not markup", () => {
    // The files are written for humans: comments and newlines are stripped
    // before the markup lands inside a template literal or an innerHTML.
    const html = icon("subagent", 13, 'class="subagent-icon"');
    expect(html).not.toContain("<!--");
    expect(html).not.toContain("\n");
    expect(html).toContain('class="subagent-icon"');
    expect(html.endsWith("</svg>")).toBe(true);
  });

  it("gives extra root attributes to the caller", () => {
    // The same icon appears many times: the FILE must not carry an id, the
    // call site decides which copy this is.
    const withId = icon("search", 12, 'id="mode-btn-icon-analyze"');
    expect(withId).toMatch(/^<svg id="mode-btn-icon-analyze" width="12" height="12" /);
    expect(icon("search", 12).startsWith("<svg width=")).toBe(true);
  });

  it("substitutes the file-badge template", () => {
    const badge = fileBadgeIcon("MD", "#a98dff", 44);
    expect(badge).toMatch(/^<svg width="44" height="44" /);
    expect(badge).toContain('stroke="#a98dff"');
    expect(badge).toContain(">MD<");
    expect(badge).not.toContain("{{");
  });

  it("escapes the badge label (an extension is data, not markup)", () => {
    const badge = fileBadgeIcon("A<B", "#000000");
    expect(badge).not.toContain("<B");
    expect(badge).toContain("&#60;B");
  });

  it("renders EVERY registered name (no icon can ship as an empty slot)", () => {
    expect(ICON_NAMES.length).toBeGreaterThanOrEqual(20);
    for (const name of ICON_NAMES) {
      const html = icon(name, 16);
      expect(html.startsWith("<svg"), name).toBe(true);
      expect(html.endsWith("</svg>"), name).toBe(true);
      expect(html.length, name).toBeGreaterThan(60);
    }
  });

  it("keeps one drawn file per icon in media/icons/ — one flat folder, no sub-groups", () => {
    const dir = join(process.cwd(), "media", "icons");
    const files = readdirSync(dir).filter((name) => name.endsWith(".svg"));
    expect(files.length).toBeGreaterThan(0);
    // Flat on purpose: a sub-folder means a rule the register would have to
    // guess ("is a tool mark chrome or a glyph?"), and the answer changed twice
    // while this set was being drawn — the sub-agent mark ended up in the wrong
    // one. The registry is the only mapping that matters.
    // …and nothing hides in a sub-folder: the layout is flat, and a folder that
    // reappears would reintroduce the rule that kept misfiling the sub-agent.
    const subFolders = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    expect(subFolders).toEqual([]);
    for (const file of files) {
      const markup = readFileSync(join(dir, file), "utf8");
      // The shared canvas is what lets any icon be swapped for another…
      expect(markup, file).toContain('viewBox="0 0 24 24"');
      // …and currentColor is what makes it follow the palette. A template
      // (the file badge) colours the placeholder instead, at render time.
      expect(markup.includes("currentColor") || markup.includes("{{COLOR}}"), file).toBe(true);
    }
  });

  it("keeps ALL icon artwork in media/icons/ (nothing inlined under src/)", () => {
    // The regression this guards: an icon pasted back into a template literal,
    // where a restyle cannot find it and it silently drifts from the file it
    // imitates. package-manifest.test.ts holds the same line for the BRAND
    // mark; this one holds it for the whole UI.
    const offenders = tsSources(join(process.cwd(), "src"))
      .filter((file) => !file.endsWith(".test.ts") && relative(file) !== "src/chat/icons.ts")
      .filter((file) => readFileSync(file, "utf8").includes("<svg"))
      .map(relative);
    expect(offenders).toEqual([]);
  });

  it("gives a tool call its own mark, whatever the spelling", () => {
    // The registry spells tools in TitleCase; the mapping does not care.
    expect(toolIcon("Read")).toBe(icon("read", 13));
    expect(toolIcon("StrReplace")).toBe(icon("strreplace", 13));
    expect(toolIcon("TodoWrite")).toBe(icon("todowrite", 13));
    expect(toolIcon("ReadLints", 16)).toBe(icon("readlints", 16));
    expect(toolIcon("Shell")).not.toBe("🔧 ");
  });

  it("gives every MCP tool the same plug (there can be any number of them)", () => {
    expect(toolIcon("mcp__filesystem__read_file")).toBe(icon("mcp", 13));
    expect(toolIcon("mcp__git__commit")).toBe(icon("mcp", 13));
  });

  it("keeps Delete on the trash artwork — one file, so they cannot drift", () => {
    expect(toolIcon("Delete")).toBe(icon("trash", 13));
    // A delete.svg must NOT exist: a copy is exactly how two marks drift apart.
    expect(() => readFileSync(join(process.cwd(), "media", "icons", "delete.svg"), "utf8")).toThrow();
  });

  it("lets the caller override an artwork attribute (one drawing, two weights)", () => {
    // The trash is a tool mark (1.5, like every other mark) AND a row button,
    // where it sits next to a 13px pencil at 2. One file, two weights — a copy
    // of the file is how two marks drift apart.
    expect(icon("trash", 13)).toContain('stroke-width="1.5"');
    const heavy = icon("trash", 13, 'stroke-width="2"');
    expect(heavy).toContain('stroke-width="2"');
    expect(heavy).not.toContain('stroke-width="1.5"');
    expect(heavy.match(/stroke-width=/g)).toHaveLength(1);
  });

  it("gives each todo status its own mark, differing only in the baffo", () => {
    // One box, four baffi: the box is what makes them read as four states of the
    // SAME thing, so it must be identical in all four files.
    const marks = (["pending", "in_progress", "completed", "cancelled"] as const).map((status) =>
      todoStatusIcon(status, 12),
    );
    expect(new Set(marks).size).toBe(4);
    for (const mark of marks) {
      expect(mark).toContain('width="12"');
      expect(mark).toContain("M8.5 6h7A2.5");
    }
    // …and the baffo is what changes: the tick is the one the eye must catch.
    expect(todoStatusIcon("completed", 12)).toContain("M9.4 12.2 11.2 14 14.8 10");
    expect(todoStatusIcon("in_progress", 12)).toContain("M10.6 9.6 13.4 12 10.6 14.4");
    expect(todoStatusIcon("cancelled", 12)).toContain("M9.4 12h5.2");
    expect(todoStatusIcon("pending", 12)).not.toContain("M9.4 12h5.2");
  });

  it("falls back to the wrench for a tool nobody has drawn", () => {
    // Not a hole in the header: an unknown tool must still read as "some tool".
    // It is wrapped in a class so the stylesheet can size it like the SVG marks beside it — a bare
    // glyph cannot be targeted, and an unscaled emoji next to 1.5× icons looks like a bug.
    expect(toolIcon("read_file")).toBe('<span class="tool-emoji">🔧</span> ');
  });
});
