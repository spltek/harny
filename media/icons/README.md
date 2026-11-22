# media/icons — the graphic assets

Every icon and glyph the panel draws lives here as a standalone SVG file.
No icon artwork is written inside TypeScript: the code asks for a name
(`icon("gear", 14)`, `toolIcon(name)`) and `src/chat/icons.ts` renders the file.

```
media/icons/
  *.svg            one file per mark — flat, no sub-groups
  icon-sheet.html  the contact sheet (open it in a browser)
  README.md        this file
```

It used to be split into `ui/` (chrome and tool marks) and `glyphs/` (semantic
marks inside the transcript). That split did not survive contact with the work:
the line between "chrome" and "glyph" is a judgement, not a fact, and the
sub-agent mark — chrome in one hand (it heads a bubble), a glyph in the other —
kept landing in the wrong folder. One flat folder, and `src/chat/icons.ts` is the
only thing that maps names to files.

`icon-sheet.html` is the contact sheet: every mark the TRANSCRIPT draws at
14 · 16 · 24 · 48 px on a light and a dark surface. It is not the whole UI — the
chrome (buttons, chevrons, toggles) keeps its own heavier weights and is not in
the sheet.

The brand mark (`media/icon.svg`) stays one level up: it is served at runtime
through `asWebviewUri` (activity bar icon + empty-state logo), not inlined.

## The tool marks

One file per tool, named after the tool (`StrReplace` → `strreplace.svg`).
`toolIcon(name)` in `src/chat/icons.ts` owns the mapping, so a new tool needs a
file and one line there — nothing else.

| Tool                                     | Artwork                                                                             |
| ---------------------------------------- | ----------------------------------------------------------------------------------- |
| Read · Write · StrReplace · Edit         | `read` · `write` · `strreplace` · `edit`                                            |
| Shell · Grep · Glob · ReadLints          | `shell` · `grep` · `glob` · `readlints`                                             |
| Skill · WebSearch · WebFetch          | `skill` · `websearch` · `webfetch`                                                  |
| Delete                                   | **`trash`** — the same drawing as the session trash, one file, so they cannot drift |
| every MCP tool (`mcp__server__tool`)     | `mcp` — one plug for all of them                                                    |
| a name that matches NO tool              | `unknown` — a question badge                                                        |
| Delegate                                 | `subagent`                                                                          |
| Thinking                                 | `thinking`                                                                          |

A pending message (typed while the session works) wears the mark of its DELIVERY MODE,
not of a tool: `list-start` for **steer** (it cuts the line, so the arrow reaches the top)
and `list-end` for **queue** (it waits at the end). The two are twins on purpose — same
three rules of text, same corner, only the arrow differs — so a row reads as one of two
modes of the same control rather than as two unrelated bubbles.

A name nobody has drawn wears `unknown.svg` (the question badge). It used to be
the 🔧 emoji inside a `span.tool-emoji`: the only "mark" that was not artwork in
this folder, drawn differently on every OS, and it said "some tool" where the
truth is "no tool" — the call named something that does not exist here (see
`src/core/tools/unknown-tool.ts`). The mark stays because an empty header reads as
a broken icon; what it SAYS is now accurate.

## Drawing rules

1. **24x24 `viewBox`.** Every file is drawn on the same canvas; the call site
   picks the rendered size (`icon(name, 14)`). One exception, for the same reason as
   rule 3: `harny.svg` is a picture and keeps the artwork's own box, **24 × 17.6 = 15:11**
   — the whole logo is wider than it is tall, and a square canvas would letterbox it.
   Its height is still 24 "units of the grid", so a weight written here still compares.
2. **No `width`/`height`** on the root `<svg>`: the caller owns the size.
3. **`currentColor`** for every `stroke` and `fill`. That is what makes an icon
   follow the palette and the light/dark theme without a second copy. The ONE
   exception is the brand mark (`harny.svg`, `harny-app.svg`), and it is not a
   matter of taste: it is painted with a **literal `#d08856`**, the brand's own tan — the
   midpoint of the gradient the logo has always been drawn with (`#DB9462` → `#C67B49`),
   flattened to a single value. A glyph takes the colour of the text it sits in; a
   picture is a colour of its own. It is **not** the prompt bubble's fill: the bubble is
   the ACCENT (a burnt orange, `--user-msg`), the mark is the BRAND, and the panel shows
   both without pretending they are one paint — following the palette turned the logo
   into a smaller copy of the bubble, and the brand lost the colour it has always had.
   Literal, and not a `var()`, because these files are also rendered as documents of
   their own (an `<img>` in the contact sheet, the icon in the activity bar, the base of
   the marketplace PNG), where no panel variable exists and an unresolvable `var()`
   paints BLACK — the one failure worse than a wrong hue. Both hexes are pinned
   separately in `src/chat/icons.test.ts`, so neither can drift into the other.
4. **No `id`s, no `<style>`, no gradients** in the icon files: they are inlined
   many times per page and would collide. There is no exception, not even for the
   brand. It used to be one — a `linearGradient` of its own, `#DB9462 → #C67B49` — and the
   paint server went when the two stops collapsed into their midpoint, one flat tan (rule
   3): the drawing did not change, the paint stopped being a document. It is
   the cleaner rule anyway: a file that nothing outside it can resolve — a previewer,
   the contact sheet's `<img>`, the base of the marketplace PNG — must not depend on
   anything defined inside itself. The brand still carries the WHOLE logo — the bubble and the answering
   caret beside it, both of them the brand's own geometry mapped once onto the canvas
   (`media/icon.svg`, one level up, is the same artwork on the app's 24 grid). An earlier
   version cropped the answering caret away to fit a square slot: it read as a broken logo,
   and the crop is what forced the bubble to three quarters of the bubble it signs. A change
   to the logo is therefore a change to two files.
5. **Comments are allowed** (`<!-- … -->`): they are stripped at build time, so
   design notes can stay next to the path they explain — but the body of a comment may
   **not contain a double dash**, ever: XML forbids it, so naming a custom property inside
   a note (`--user-msg`, written without thinking) makes the whole file invalid. Nothing
   catches that at build time, because the artwork ships as TEXT: the panel renders one
   empty box and every test still passes, since it asserts on the string, not on a parsed
   document. `src/chat/icons.test.ts` now parses every file here with a real XML parser and
   fails on a `--` inside a comment, so the note can stay long without risking the drawing.
6. **Paint lives on the root** when it is uniform (`fill`, `stroke`,
   `stroke-width`, caps, joins). It stays per-element only where the drawing is
   not uniform — the file badge template (a placeholder colour), and the brand mark
   (one filled silhouette + one stroked caret, as the logo itself is drawn).

Weight is deliberately not uniform, and this is the real table (counted from the
folder, not remembered):

| `stroke-width` | how many | which                                                                                                         |
| -------------- | -------- | ------------------------------------------------------------------------------------------------------------- |
| **1.5**        | 19       | every mark the transcript draws (`file-badge` template included), plus `readlints`                            |
| **2**          | 10       | `branch` `eye` `history` `paperclip` `pencil` `scissors` `search`, and the small three `plus` `check` `close` |
| **2.5**        | 1        | `chevron-down`                                                                                                |
| **1.8**        | 1        | `sparkles` — the single in-between value                                                                      |
| _none_ (solid) | 5        | `gear` `play` `skill` `stop` `parallel`                                                                        |
| **1.42**       | 1        | the brand mark's answering caret — `harny` is FILLED plus this one stroke, both the logo's own |

What matters is the OPTICAL weight — `stroke-width × rendered px / 24` — not the
number in the file: 1.5 at 13 px is **0.8 px**, chrome at 2–2.5 drawn at 10–15 px is
**1.0–1.25 px**. That is the rule: the transcript marks are drawn small and light,
the chrome is drawn small and heavy, because a 0.8 px line next to a 10 px button
disappears. Something that has no stroke at all (`skill`, `gear`, `play`, `stop`,
`parallel`, and the brand mark's silhouette) is a filled silhouette and reads heavier still at the
same size — that is a design choice to settle, not a measurement. For the brand mark the
choice was settled by the defect it fixed: as a 1.5 outline it sat beside a solid orange
bubble and read as a smaller thing than the bubble. Its caret is the logo's OWN stroke — 52 in
the brand's thousandths, i.e. 1.42 on this canvas — so it is not a family weight: it is the
drawing, and `harny.svg` is a picture.

## The marketplace PNG

`harny.png` is not an asset of its own: it is `harny-app.svg` — the square frame —
rendered at **256 x 256 with an alpha channel**, and it is what `package.json` hands to
the marketplace as the extension icon. Two files, one drawing: change the SVG and the
PNG must be re-rendered, or the listing shows yesterday's logo.

There is no renderer in the toolchain (no `sharp`, no `resvg`), so it is drawn from the
SVG's own numbers — the path flattened and filled with the **even-odd** rule (that is what
punches the prompt caret out of the bubble) and the caret stroked with round caps —
supersampled 8x and box-filtered down. On this box Quick Look renders the SVG with the
wrong colours and headless Chrome will not load a local file, which is why it is done
from the geometry rather than from a screenshot of it.

## How the files reach the bundle

Inlined at build time, so there is no runtime request and no CSP entry:

- `scripts/build-extension.mjs`, `scripts/build-webview.mjs`, `scripts/dev.mjs`
  → esbuild `loader: { ".svg": "text" }`
- `vitest.config.mts` → the `svg-as-text` plugin (same text, so jsdom tests
  assert on the real markup)

Because the artwork is inlined, this folder is excluded from the packaged VSIX
(`.vscodeignore`).

## Adding an icon

1. Drop the file in `media/icons/` (kebab-case name).
2. Import it in `src/chat/icons.ts` and add it to the `ARTWORK` map (plus, for a
   tool, the `TOOL_ARTWORK` line). The maps are typed, so a typo in a call site
   fails `npm run typecheck`.
3. Use `icon("name", size)` — or nothing at all, if it is a tool: `toolIcon`
   picks it up from the tool name.
