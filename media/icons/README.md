# media/icons — the graphic assets

Every icon and glyph the chat panel draws lives here as a standalone SVG file.
No icon artwork is written inside TypeScript anymore: the code asks for a name
(`icon("gear", 14)`) and `src/chat/icons.ts` renders the file.

```
media/icons/
  ui/       chrome: buttons, chevrons, toggles (24x24, currentColor)
  glyphs/   semantic marks inside the transcript (sub-agent, history, file badge)
```

The brand mark (`media/icon.svg`) stays one level up: it is served at runtime
through `asWebviewUri` (activity bar icon + empty-state logo), not inlined.

## Drawing rules

1. **24x24 `viewBox`.** Every file is drawn on the same square canvas; the call
   site picks the rendered size (`icon(name, 14)`).
2. **No `width`/`height`** on the root `<svg>`: the caller owns the size.
3. **`currentColor`** for every `stroke` and `fill`. That is what makes an icon
   follow the palette and the light/dark theme without a second copy.
4. **No `id`s, no `<style>`, no gradients** in the icon files: they are inlined
   many times per page and would collide. (The brand mark is the exception — it
   is an image, not an icon.)
5. **Comments are allowed** (`<!-- … -->`): they are stripped at build time, so
   design notes can stay next to the path they explain.
6. **Round caps** (`stroke-linecap="round"`) for anything hand-drawn; stroke
   widths stay in the 1.8–2.5 range, with 2.5 reserved for the small 10–15 px
   chrome icons where a thinner line would disappear.

## How the files reach the bundle

Inlined at build time, so there is no runtime request and no CSP entry:

- `scripts/build-extension.mjs`, `scripts/build-webview.mjs`, `scripts/dev.mjs`
  → esbuild `loader: { ".svg": "text" }`
- `vitest.config.mts` → the `svg-as-text` plugin (same text, so jsdom tests
  assert on the real markup)

Because the artwork is inlined, this folder is excluded from the packaged VSIX
(`.vscodeignore`).

## Adding an icon

1. Drop the file in `ui/` or `glyphs/` (kebab-case name).
2. Import it in `src/chat/icons.ts` and add it to the `ARTWORK` map. The map is
   typed, so a typo in a call site fails `npm run typecheck`.
3. Use `icon("name", size)` where you need it.
