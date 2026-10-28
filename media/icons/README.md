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

| Tool | Artwork |
|---|---|
| Read · Write · StrReplace · Edit | `read` · `write` · `strreplace` · `edit` |
| Shell · Grep · Glob · ReadLints | `shell` · `grep` · `glob` · `readlints` |
| Skill · TodoWrite · WebSearch · WebFetch | `skill` · `todowrite` · `websearch` · `webfetch` |
| Delete | **`trash`** — the same drawing as the session trash, one file, so they cannot drift |
| every MCP tool (`mcp__server__tool`) | `mcp` — one plug for all of them |
| Delegate | `subagent` |
| Thinking | `thinking` |

A name nobody has drawn yet keeps the old wrench (🔧): a tool must still read as
"some tool" rather than leaving a hole in the header.

## Drawing rules

1. **24x24 `viewBox`.** Every file is drawn on the same canvas; the call site
   picks the rendered size (`icon(name, 14)`).
2. **No `width`/`height`** on the root `<svg>`: the caller owns the size.
3. **`currentColor`** for every `stroke` and `fill`. That is what makes an icon
   follow the palette and the light/dark theme without a second copy.
4. **No `id`s, no `<style>`, no gradients** in the icon files: they are inlined
   many times per page and would collide. (The brand mark is the exception — it
   is an image, not an icon.)
5. **Comments are allowed** (`<!-- … -->`): they are stripped at build time, so
   design notes can stay next to the path they explain.
6. **Paint lives on the root** when it is uniform (`fill`, `stroke`,
   `stroke-width`, caps, joins). It stays per-element only where the drawing is
   not uniform — the file badge template, and nothing else today.

Weight is deliberately not uniform, and this is the real table (counted from the
folder, not remembered):

| `stroke-width` | how many | which |
|---|---|---|
| **1.5** | 16 | every mark the transcript draws, plus `readlints` |
| **2** | 10 | `branch` `eye` `history` `paperclip` `pencil` `scissors` `search`, and the small three `plus` `check` `close` |
| **2.5** | 2 | `chevron-down` `minus` |
| **1.8** | 1 | `sparkles` — the single in-between value |
| *none* (solid) | 5 | `gear` `play` `skill` `stop` `parallel` |

What matters is the OPTICAL weight — `stroke-width × rendered px / 24` — not the
number in the file: 1.5 at 13 px is **0.8 px**, chrome at 2–2.5 drawn at 10–15 px is
**1.0–1.25 px**. That is the rule: the transcript marks are drawn small and light,
the chrome is drawn small and heavy, because a 0.8 px line next to a 10 px button
disappears. Something that has no stroke at all (`skill`, `gear`, `play`, `stop`,
`parallel`) is a filled silhouette and reads heavier still at the same size — that is
a design choice to settle, not a measurement.

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
