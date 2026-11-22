import { readdirSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { ICON_NAMES, fileBadgeIcon, icon, toolIcon } from "./icons";
import { PALETTES } from "./view-config";
import { JSDOM } from "jsdom";
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

/** The brand's two files, each with its canvas: ONE drawing, two frames. They are the
 * only artwork here that is neither a glyph nor palette-driven, so both rules below
 * name them explicitly rather than by a loose "is it the brand" guess. */
const BRAND_CANVAS: Record<string, string> = {
  // The panel: the sign-off must be exactly one bubble tall, so the ink IS the box.
  "harny.svg": 'viewBox="0 0 24 17.6"',
  // VS Code: a views-container icon is painted into a 24x24 slot, so it must be square.
  "harny-app.svg": 'viewBox="0 0 24 24"',
};

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

  it("is WELL-FORMED XML, all of it — an icon that does not parse paints NOTHING", () => {
    // The artwork is inlined into the panel, the contact sheet and the VSIX as TEXT, so no
    // compiler ever looked at it: a `<svg>` with one broken token renders as an empty box and
    // every test that asserts on markup still passes, because it is asserting on a STRING.
    // (Found the hard way: a long comment explaining the brand colour ended up containing the
    // custom property's name, i.e. a double dash, which is ILLEGAL inside an XML comment —
    // the file was invalid and the only symptom would have been a blank logo in the activity
    // bar and on the marketplace listing.)
    //
    // jsdom's XML mode is the parsers VS Code and every previewer use: it THROWS on the error
    // instead of silently recovering the way HTML does.
    const dir = join(process.cwd(), "media", "icons");
    const files = readdirSync(dir).filter((name) => name.endsWith(".svg"));
    expect(files.length).toBeGreaterThan(0);
    for (const name of files) {
      const markup = readFileSync(join(dir, name), "utf8");
      expect(() => new JSDOM(markup, { contentType: "image/svg+xml" }), name).not.toThrow();
      // Belt and braces, and a message that names the fix: what fails above is a COMMENT, and
      // the reason is never obvious ("invalid token" points at a line in the middle of the
      // prose). A comment body may not contain a double dash — not even inside backticks.
      for (let at = markup.indexOf("<!--"); at >= 0; at = markup.indexOf("<!--", at)) {
        const end = markup.indexOf("-->", at + 4);
        expect(end, `${name}: unterminated comment`).toBeGreaterThan(at);
        expect(markup.slice(at + 4, end), `${name}: "--" inside a comment is illegal XML`).not.toContain("--");
        at = end + 3;
      }
    }
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
      // The shared canvas is what lets any icon be swapped for another — 24x24 for every GLYPH…
      // …except the brand, which is a PICTURE and needs two frames for two jobs: the panel's
      // sign-off has to fill exactly one bubble (24 x 17.6 = 15:11, the artwork's own box), while
      // VS Code paints the activity-bar icon into a square slot and came out blank/tiny when
      // handed a wide viewBox. Same drawing in both — compared command by command just below —
      // so the frames are the only difference, which is the point of naming them here.
      expect(markup, file).toContain(BRAND_CANVAS[file] ?? 'viewBox="0 0 24 24"');
      // …and currentColor is what makes it follow the palette. A template
      // (the file badge) colours the placeholder instead, at render time. The brand
      // is NEITHER, and that is the exception: it is a picture, not a glyph — the palette has
      // no orange-into-orange pair to give it, and the mark beside a prompt must be the same
      // mark as the icon in the activity bar.
      const followsPalette = markup.includes("currentColor") || markup.includes("{{COLOR}}");
      expect(followsPalette || file in BRAND_CANVAS, file).toBe(true);
    }
  });

  it("paints the brand with its OWN tan — in both frames, and not the bubble's orange", () => {
    // The brand has always been drawn with a warm tan: a gradient from #DB9462 to #C67B49, lit from
    // the top left. It is now ONE flat literal, #d08856 — the gradient's midpoint — because the
    // paint has to be a colour (see Rule 4 below) and because two very close tans read as two
    // mistakes.
    //
    // This is deliberately NOT the prompt bubble's fill. The bubble is the ACCENT (a burnt orange,
    // `--user-msg`), the mark is the BRAND: the brand keeps the colour it has always had, and the
    // panel shows both without pretending they are the same paint. The two hexes are pinned
    // separately, so this test fails if either one drifts into the other — following the palette
    // was tried, and it turned the logo into a smaller copy of the bubble.
    //
    // A LITERAL, not a `var()`: this file is also rendered as a document of its own (an <img> in
    // the contact sheet, the icon in the activity bar, the base of the marketplace PNG), where no
    // panel variable exists — and an unresolvable var() paints BLACK, worse than any wrong hue.
    //
    // No ids, no paint server, no `url(#…)`: the exception that Rule 4 of media/icons/README.md
    // used to allow is gone, because the paint is a colour.
    const brand = "#d08856"; // the old logo gradient, flattened to its midpoint
    expect(PALETTES.dark["user-msg"]).toBe("#d95f27"); // the bubble stays the burnt orange
    expect(brand).not.toBe(PALETTES.dark["user-msg"]);
    const dir = join(process.cwd(), "media", "icons");
    for (const file of Object.keys(BRAND_CANVAS)) {
      const markup = readFileSync(join(dir, file), "utf8");
      // BOTH elements name the paint: the silhouette is filled, the caret is fill="none", so a
      // fill inherited from the root would never reach its stroke.
      const fills = markup.match(/fill="(#[0-9a-f]{6})"/g) ?? [];
      expect(fills.length, file).toBeGreaterThan(0);
      for (const fill of fills) expect(fill, file).toBe(`fill="${brand}"`);
      expect(markup, file).toContain(`stroke="${brand}"`);
      expect(markup, file).not.toMatch(/url\(#|<linearGradient/);
    }
    // …and no OTHER file may carry a paint server or an id either: a third would be the
    // collision the rule is actually about.
    const others = readdirSync(dir)
      .filter((name) => name.endsWith(".svg") && !(name in BRAND_CANVAS))
      .filter((name) => {
        const markup = readFileSync(join(dir, name), "utf8");
        return /<linearGradient|url\(#/.test(markup) || /\sid="/.test(markup);
      });
    expect(others).toEqual([]);
  });

  it("keeps the brand mark the SAME drawing in both frames, only remapped", () => {
    // The brand is ONE artwork delivered twice: media/icons/harny-app.svg is the square frame
    // (activity bar, view header, marketplace PNG) and media/icons/harny.svg is the tight one,
    // whose canvas IS the artwork's box so the panel's sign-off fills exactly one bubble. The
    // frames differ on purpose; the DRAWING must not. Nothing enforced that before — editing one
    // file alone shipped two different logos with the suite green, because only the paint was
    // pinned. Pinned here the way a copy is verifiable: command for command, and point by point
    // as a fraction of the drawing's own bounding box, so a pure scale + translate (the mapping
    // that produced the second frame) collapses to the same numbers on both sides.
    const brand = readFileSync(join(process.cwd(), "media", "icons", "harny.svg"), "utf8");
    const activityBar = readFileSync(join(process.cwd(), "media", "icons", "harny-app.svg"), "utf8");

    /** The outline of one brand file, normalised to its own bounding box. */
    const outline = (markup: string) => {
      // `<path` is bare in one file and carries fill attributes in the other: match the tag,
      // then the first `d` in it, whatever sits between.
      const path = /<path\b[^>]*?\bd="([^"]+)"/.exec(markup)?.[1] ?? "";
      const polyline = /<polyline\b[^>]*?\bpoints="([^"]+)"/.exec(markup)?.[1] ?? "";
      // One entry per command: its letter, then its numbers. H carries x only and V y
      // only, which is why coordinates are kept per axis instead of paired up.
      const commands = (path.match(/[A-Za-z][^A-Za-z]*/g) ?? []).map((command) => ({
        letter: command[0],
        numbers: command
          .slice(1)
          .trim()
          .split(/[\s,]+/)
          .filter(Boolean)
          .map(Number),
      }));
      // The caret is a polyline, not a path: three points, treated as M + two lineto's so
      // it lines up with the other side however each file happens to spell it.
      const caret = polyline
        .trim()
        .split(/[\s,]+/)
        .filter(Boolean)
        .map(Number);
      const xs: number[] = [];
      const ys: number[] = [];
      for (const { letter, numbers } of commands) {
        if (letter === "H") xs.push(...numbers);
        else if (letter === "V") ys.push(...numbers);
        else if (letter !== "Z") {
          for (let i = 0; i < numbers.length; i += 2) {
            xs.push(numbers[i]);
            ys.push(numbers[i + 1]);
          }
        }
      }
      for (let i = 0; i < caret.length; i += 2) {
        xs.push(caret[i]);
        ys.push(caret[i + 1]);
      }
      const minX = Math.min(...xs);
      const minY = Math.min(...ys);
      const width = Math.max(...xs) - minX;
      const height = Math.max(...ys) - minY;
      const fit = (value: number, min: number, span: number) => (value - min) / span;
      return {
        letters: commands.map((command) => command.letter).join(""),
        // Same aspect means the copy was scaled ISOTROPICALLY, which is the only mapping
        // that keeps a bubble round; per-axis normalisation below would hide a stretch.
        aspect: height / width,
        // x and y normalised separately, so the two files' different scales cancel out.
        xs: xs.map((x) => Number(fit(x, minX, width).toFixed(4))),
        ys: ys.map((y) => Number(fit(y, minY, height).toFixed(4))),
        caret: caret.length / 2,
      };
    };

    const copy = outline(brand);
    const original = outline(activityBar);
    expect(copy.letters).toBe(original.letters);
    expect(copy.letters.length).toBeGreaterThan(50);
    expect(copy.caret).toBe(original.caret);
    // Same aspect = the copy was scaled ISOTROPICALLY (a stretch would pass the per-axis
    // normalisation below), then the absolute proportion, so both files cannot drift together.
    expect(copy.aspect).toBeCloseTo(original.aspect, 3);
    // 0.7681 is the drawing's own proportion, measured on the COORDINATES: 656 / 854 in
    // brand units (x 170..1024, y 118..774). Note it is not 11/15 = 0.7333, the canvas ratio:
    // that box includes the caret's round caps (+0.71 a side) and stops above the tail's
    // curve, whose pull lands past the ink (a control point at y 17.89 inside a 17.6 canvas is
    // legal — the curve itself never gets there). Pinned so the mark cannot be re-proportioned
    // in BOTH files and still pass.
    expect(original.aspect).toBeCloseTo(0.768, 3);
    /** Same points, to within the copy's own precision: it rounds every coordinate to two
     * decimals, so on a 23-unit canvas a normalised value lands ~2e-4 away. Two decimals of
     * toBeCloseTo (±0.005) is the loose end of that, and still far tighter than any
     * redrawing would be. */
    const sameShape = (actual: number[], expected: number[]) => {
      expect(actual.length).toBe(expected.length);
      actual.forEach((value, index) => expect(value).toBeCloseTo(expected[index], 2));
    };
    sameShape(copy.xs, original.xs);
    sameShape(copy.ys, original.ys);
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

  it("gives each delivery mode its own arrow, on the same three rules", () => {
    // Steer cuts the line (the arrow reaches the TOP), queue waits at its end (the arrow leaves the
    // BOTTOM). The two files are twins, so what has to differ is exactly the arrow — and what must
    // NOT differ is the weight, or one mode would read as chrome and the other as a mark.
    expect(icon("listStart", 13)).toContain("m16 8-3-3 3-3");
    expect(icon("listEnd", 13)).toContain("m16 16-3 3 3 3");
    expect(icon("listStart", 13)).toContain('stroke-width="1.5"');
    expect(icon("listEnd", 13)).toContain('stroke-width="1.5"');
    expect(icon("listStart", 13)).not.toContain('width="24"');
  });

  it("gives a tool call its own mark, whatever the spelling", () => {
    // The registry spells tools in TitleCase; the mapping does not care.
    expect(toolIcon("Read")).toBe(icon("read", 13));
    expect(toolIcon("StrReplace")).toBe(icon("strreplace", 13));
    expect(toolIcon("ReadLints", 16)).toBe(icon("readlints", 16));
    expect(toolIcon("Shell")).toBe(icon("shell", 13));
  });

  it("gives every MCP tool the same plug (there can be any number of them)", () => {
    expect(toolIcon("mcp__filesystem__read_file")).toBe(icon("mcp", 13));
    expect(toolIcon("mcp__git__commit")).toBe(icon("mcp", 13));
  });

  it("hangs the BRAND mark beside a typed prompt — filled, and no second user glyph", () => {
    // The sign-off used to be a person in a round frame (a `person-round.svg` of its own). The
    // brand says the same thing — "a human typed this" — and says WHOSE, so the person went with
    // its file: one user glyph in the set, not two marks for one meaning.
    //
    // It is FILLED, and that is deliberate: drawn as a 1.5 outline it read as a smaller thing
    // than the bubble it signs (a stroke drawing is mostly empty space). One filled silhouette,
    // the brand's own, with the prompt caret punched out of it — the hole belongs to the drawing,
    // so no stroke weight is asked for the bubble at the call site.
    const mark = icon("harny", 38);
    expect(mark).toContain('fill-rule="evenodd"');
    // TWO elements, as the brand draws them: the silhouette (painted once, by the root) and the
    // answering caret beside it, which is a STROKE — the brand's own polyline, so it keeps its
    // round caps at any size. Cropping the caret out was tried and reported as a broken logo: it
    // is half the mark (the bubble asks, the caret answers), and the crop is what forced the
    // bubble to three quarters of the bubble it signs.
    // Both elements are painted with the BUBBLE's orange (see the palette test above): the mark
    // beside a prompt is the same paint as the prompt.
    expect(mark.match(/fill="#d08856"/g)).toHaveLength(1);
    expect(mark).toContain('stroke="#d08856"');
    expect(mark).toContain('stroke-width="1.42"'); // the brand's 52 on its own scale
    expect(mark).toContain('stroke-linecap="round"');
    // The ink touches all four edges of the canvas: that is what makes the CSS box (15:11, one
    // bubble tall) put the mark's top on the bubble's top instead of a few pixels below it.
    expect(mark).toContain("M 1.91 0"); // the bubble's top-left corner, ON the top edge
    expect(mark).toContain("Q 0 0 1.91 0"); // …curved from the left edge
    expect(mark).toContain("Q 3.44 17.89 3.41 17.02"); // the tail, down to the bottom edge
    expect(mark).toContain("23.29,6.87"); // the answering caret's apex, on the right edge
    expect(() => readFileSync(join(process.cwd(), "media", "icons", "person-round.svg"), "utf8")).toThrow();
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
    // The one place a DEAD row can survive: nothing imports the sheet, so when a family of marks was
    // retired, its rows stayed behind and the sheet kept drawing broken images. It is opened by hand,
    // which is exactly why a test has to read it.
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
