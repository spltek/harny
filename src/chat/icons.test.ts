import { readdirSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { ICON_NAMES, fileBadgeIcon, icon } from "./icons";

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
  return file.slice(process.cwd().length + 1).split(sep).join("/");
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

  it("keeps one drawn file per icon in media/icons/", () => {
    const dir = join(process.cwd(), "media", "icons");
    for (const group of ["ui", "glyphs"]) {
      const files = readdirSync(join(dir, group)).filter((name) => name.endsWith(".svg"));
      expect(files.length, group).toBeGreaterThan(0);
      for (const file of files) {
        const markup = readFileSync(join(dir, group, file), "utf8");
        // The shared canvas is what lets any icon be swapped for another…
        expect(markup, file).toContain('viewBox="0 0 24 24"');
        // …and currentColor is what makes it follow the palette. A template
        // (the file badge) colours the placeholder instead, at render time.
        expect(markup.includes("currentColor") || markup.includes("{{COLOR}}"), file).toBe(true);
      }
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
});
