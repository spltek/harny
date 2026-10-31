import { readdirSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { ICON_NAMES, fileBadgeIcon, icon, toolIcon } from "./icons";
import { SKILL_TOOL_NAME } from "../core/tools/skill-tool";

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
    expect(toolIcon("Shell")).toBe(icon("shell", 13));
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

  it("falls back to the QUESTION mark for a tool nobody has drawn", () => {
    // Not a hole in the header, and not the 🔧 any more: the emoji was the only "mark" in the
    // panel that was not artwork in media/icons/, it changed shape on every OS, and it said
    // "some tool" where the truth is "no tool" — `Greplike" string="true` never was one.
    expect(toolIcon("read_file")).toBe(icon("unknown", 13));
    expect(toolIcon("read_file")).toContain("<svg");
    expect(toolIcon("read_file")).not.toContain("tool-emoji");
  });

  it("gives EVERY tool the registry ships its own mark — none of them wears the default", () => {
    // The report that produced this test: a tool card wearing the DEFAULT mark although that tool
    // ALREADY had artwork. Nothing failed back then, because the map and the registry are two
    // places, and a tool added to one of them is invisible to the other: the panel simply drew
    // the generic one over a name a reader recognises, which looks like a bug and is one.
    //
    // So the names here are read from the TOOLS THEMSELVES (each one's `definition`), never typed
    // by hand, and the count is cross-checked against the list the registry actually wires up: add
    // a tool without a mark and this goes red instead of shipping a wrench.
    const dir = join(process.cwd(), "src", "core", "tools");
    const names = readdirSync(dir)
      .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
      .flatMap((file) => {
        const source = readFileSync(join(dir, file), "utf8");
        // `readonly definition: ToolDefinition = { name: "Read",` …
        // `get definition(): ToolDefinition { return { name: SKILL_TOOL_NAME,` (the one constant)
        const found = /definition(?:\(\))?\s*:[\s\S]{0,160}?\bname:\s*(?:"([^"]+)"|SKILL_TOOL_NAME)/.exec(source);
        return found ? [found[1] ?? SKILL_TOOL_NAME] : [];
      });

    const wired = (readFileSync(join(dir, "create-default-tools.ts"), "utf8").match(/new \w+Tool\(/g) ?? []).length;
    expect(wired).toBeGreaterThan(10); // the list is still the registry's
    expect(names.length).toBe(wired); // …and every wired tool declared its name where we look for it
    expect(names).toContain("Grep"); // a name we KNOW wears a mark: the walk really walks
    for (const name of names) {
      expect(toolIcon(name), `${name} wears the DEFAULT question mark`).not.toBe(icon("unknown", 13));
    }
  });
});

describe("the contact sheet", () => {
  it("never lists a file that is not there", () => {
    // The one place a DEAD row can survive: nothing imports the sheet, so when the
    // four `todo-*` marks went with the old Tasks block, their rows stayed behind
    // and the sheet kept drawing four broken images. It is opened by hand, which is
    // exactly why a test has to read it.
    const dir = join(process.cwd(), "media", "icons");
    const sheet = readFileSync(join(dir, "icon-sheet.html"), "utf8");
    const rows = sheet.match(/\["[a-z0-9-]+\.svg"/g) ?? [];
    const listed = rows.map((row) => row.slice(2, -1));
    const onDisk = readdirSync(dir).filter((name) => name.endsWith(".svg"));

    expect(listed.length).toBeGreaterThan(10); // the sheet still IS a sheet
    expect(listed.filter((file) => !onDisk.includes(file))).toEqual([]); // a row, no file
    // …and the other direction, now that the sheet is the FULL inventory: a file
    // with no row is a mark nobody ever looks at — drawn, imported, unphotographed.
    // (`minus` lived that way for months before it was deleted: registered in the
    // ARTWORK map, asked for by no call site, its six stepper buttons replaced by
    // sliders back in 63d895e.)
    expect(onDisk.filter((file) => !listed.includes(file))).toEqual([]); // a file, no row
    // The same mark twice is how a sheet starts disagreeing with itself: the sizes
    // are rendered per row, so a duplicate stays invisible until one copy is edited.
    expect([...new Set(listed)]).toEqual(listed);
  });
});
