/**
 * Harny view configuration — the ONE place with all design data.
 *
 * Plain data only (no functions). Every UI reads its values from here via the
 * CSS custom properties emitted in `:root` and on `body` (see view-html.ts):
 *   · --font-<name>  → a FONT family (see FONTS)
 *   · --fs-<name>    → a SIZE family (see FAMILIES)
 *   · --<role>       → a COLOUR role, in the TWO variants of the palette
 *                      (see PALETTE_DARK / PALETTE_LIGHT)
 *
 * If you change a size, a font or a colour you do it HERE, in a single spot.
 */

/** Named font families (type + stack). Stacks are cross-platform: they
 * resolve to the OS-native font on macOS, Windows and Linux via system-ui /
 * ui-monospace, with explicit per-OS fallbacks for older engines. */
export const FONTS = {
  /** Default UI font — all regular text. */
  ui: "system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
  /** Monospace — code, diffs, file paths. */
  mono: "ui-monospace, 'Cascadia Mono', Consolas, 'SF Mono', Menlo, Monaco, 'Liberation Mono', 'DejaVu Sans Mono', monospace",
} as const;

/**
 * Named size families. Each family bundles the FONT type it uses and its
 * SIZE (rem, resolved against the root/editor font set by ROOT_FONT_SIZE).
 */
export const FAMILIES = {
  /** Huge — the brand mark on the empty shell (the rem base is the editor font,
   * so this is ~78px at 13px: a splash mark, not a favicon). */
  logo: { font: "ui", size: "6rem" },
  /** Huge — welcome icon. */
  hero: { font: "ui", size: "2.3rem" },
  /** Titles — modal headings, + button. */
  xl: { font: "ui", size: "1.15rem" },
  /** Reading text + controls (matches the editor font size). */
  lg: { font: "ui", size: "1rem" },
  /** Secondary UI — tabs, status, tool, metrics. */
  md: { font: "ui", size: "0.9rem" },
  /** Small labels / meta. */
  sm: { font: "ui", size: "0.82rem" },
  /** Micro labels — card titles, captions. */
  xs: { font: "ui", size: "0.75rem" },
} as const;

/**
 * Which of Harny's two palettes the panel uses.
 *   · `auto`  — follow the EDITOR: VS Code puts the kind on the webview body as
 *               a class (vscode-dark / vscode-light / vscode-high-contrast…)
 *               and swaps it on a theme change WITHOUT reloading the page.
 *   · `dark`  — pin the dark palette, whatever the editor is doing.
 *   · `light` — pin the light one.
 * The class the setting pins (`theme-dark` / `theme-light`) is emitted on the
 * body by view-html.ts and wins over the editor's class by source order.
 */
export type ThemeMode = "auto" | "dark" | "light";

/**
 * THE DARK PALETTE — terracotta on anthracite, the look Harny was born with.
 *
 * The keys are ROLES, never shades: `muted-2` means "the second-dimmest text",
 * `overlay-3` means "a hairline drawn ON TOP of a surface". That is what makes
 * the two themes swappable, and it is why a colour should be added HERE rather
 * than inline in the stylesheet: PALETTE_LIGHT has to answer the same role.
 */
const PALETTE_DARK = {
  // ── Surfaces ──
  bg: "#111111", // main background: anthracite, near-black
  fg: "#e0e0e0", // primary text: bright light gray
  "fg-strong": "#ffffff", // titles / emphasis: pure white
  "fg-dim": "#bbbbbb", // text that must stay readable but quiet on an accent-tinted card
  border: "rgba(255, 255, 255, 0.08)", // hairline only; separation is tone-on-tone
  "input-bg": "#1e1e1e", // containers, fields, cards
  "surface-2": "#222222", // raised surfaces / hover
  "tool-bg": "#1a1a1a", // tool bubbles, code blocks, inline code
  "assistant-msg": "#1e1e1e", // the answer bubble
  // ── Accent family (the terracotta identity) ──
  "user-msg": "#d95f27", // burnt-orange / terracotta accent
  accent: "#d95f27",
  "accent-strong": "#c8501c",
  "accent-surface": "#2c241f", // a pill hovering INTO the accent family (bg of a hovered accent button)
  // The accent as a TINT (a wash on a surface) and as a GLOW (the halo of a running
  // area). Both are drawn OVER something else, so in the light theme they are the
  // light theme's OWN terracotta, not this one: an orange wash keeps its hue, but
  // #d95f27 at 16% on paper reads pinker/weaker than the accent it belongs to.
  "accent-tint-soft": "rgba(217, 95, 39, 0.12)",
  "accent-tint": "rgba(217, 95, 39, 0.16)", // the selected model row
  "accent-tint-strong": "rgba(217, 95, 39, 0.24)", // its hover
  "accent-line": "rgba(217, 95, 39, 0.4)", // the edge of an area that is working (stream border, pulse trough)
  "accent-glow-soft": "rgba(217, 95, 39, 0.15)", // pulse trough halo
  "accent-glow": "rgba(217, 95, 39, 0.45)", // pulse peak halo / pill glow
  "accent-glow-strong": "rgba(217, 95, 39, 0.6)", // its hover
  // ── Checkpoint (compaction summary) ──
  // The CHECKPOINT is neither a typed message nor an answer: its HEADER gets its own
  // violet, so the card that opens the context window is recognizable at a glance
  // instead of reading like something the user wrote. The summary BODY stays neutral
  // (see `.msg.assistant.synthetic-body`): only the label is tinted.
  "summary-msg": "#6f4fa8",
  "summary-strong": "#5b3e96", // its hover
  // ── Secondary text, dimmest → strongest ──
  muted: "#888888", // secondary text, placeholders, disabled
  "muted-2": "#999999", // labels, metadata, captions
  "muted-3": "#6f6f6f", // the faintest rung: separators, folded rows
  // ── Translucent overlays: drawn ON TOP of whatever is underneath ──
  // They are WHITE alpha in the dark theme and BLACK alpha in the light one
  // ("a slightly lighter patch" simply does not exist on white paper).
  "overlay-1": "rgba(255, 255, 255, 0.06)", // hover wash
  "overlay-2": "rgba(255, 255, 255, 0.10)", // stronger hover / pressed
  "overlay-3": "rgba(255, 255, 255, 0.16)", // hairline on a raised chip
  "overlay-4": "rgba(255, 255, 255, 0.28)", // an edge that must stay visible on an accent fill
  "scroll-thumb": "rgba(255, 255, 255, 0.22)",
  "scroll-thumb-hover": "rgba(255, 255, 255, 0.36)",
  // ── Sinks (recessed backgrounds) and shadows ──
  "sink-1": "rgba(0, 0, 0, 0.25)", // input/output blocks INSIDE a card
  "sink-2": "rgba(0, 0, 0, 0.28)", // one step deeper (markdown code in a bubble)
  backdrop: "rgba(0, 0, 0, 0.5)", // modal scrim
  "key-shadow": "rgba(0, 0, 0, 0.35)", // the 3D drop shadow under a button "key"
  "modal-shadow": "rgba(0, 0, 0, 0.5)", // the lift under a FLOATING card (modal, popover, menu)
  // ── Semantic hues (state, never decoration) ──
  ok: "#98c379", // success / added lines
  "ok-bg": "rgba(152, 195, 121, 0.10)",
  info: "#61afef", // paths, hints, read-only access
  warn: "#f5a623", // loop guard, the Analyze→Build call to action
  "warn-soft": "#e5c07b", // a warning that must not shout (missing model limits)
  "warn-bright": "#ffb84d", // its hover
  "on-warn": "#1a1a1a", // text ON the warn hue
  violet: "#7c5cff", // sub-agents / parallel
  "violet-text": "#a98dff", // their labels
  steer: "#b23b3b", // the Steer pill gradient
  "steer-strong": "#8f2d2d",
  "nudge-fg": "#dbeafe", // text of a harness "Nudge" bubble (light blue on its tint)
  error: "#f44747",
  // The ERROR bubble's surface: that red as a wash, already COMPOSITED over `--bg` (15% over
  // #111111), not an alpha tint. It has to be opaque because the ⎇ tab on an error bubble
  // INHERITS this background (see `.branch-at` in the sheet), and an inherited alpha would let
  // the bubble ABOVE show through the risen linguetta. Same pixels as the old inline rgba.
  "error-bg": "#331919",
  // ── Diffs ──
  del: "#e06c75", // removed lines
  "del-bg": "rgba(224, 108, 117, 0.10)",
  // ── Syntax tokens (Prism, editor-style) ──
  "code-comment": "#7f848e",
  "code-keyword": "#c678dd",
  "code-string": "#98c379",
  "code-number": "#d19a66",
  "code-function": "#61afef",
  "code-class": "#e5c07b",
  "code-builtin": "#56b6c2",
  "code-operator": "#abb2bf",
  "code-property": "#e06c75",
} as const;

/** Both palettes answer to the SAME roles — a missing light value is a type
 * error, not a silently unstyled element. */
export type Palette = Record<keyof typeof PALETTE_DARK, string>;

/**
 * THE LIGHT PALETTE — the same terracotta identity, on paper instead of
 * anthracite. Two rules drive every value:
 *   · the accent is DARKENED, not lightened: on white, #d95f27 sits at ~3.2:1,
 *     while #b8531d keeps WHITE text on a user bubble at ~4.9:1 and the accent
 *     as a link/label colour above 4.5:1 on the page background;
 *   · every overlay flips white-alpha → black-alpha, and every "sink" (a block
 *     recessed inside a card) becomes a light grey wash instead of a dark one.
 * The semantic hues move to their darker 700-ish step for the same reason:
 * #98c379 on white is 2:1, #2f7d32 is 4.9:1.
 */
const PALETTE_LIGHT: Palette = {
  // ── Surfaces ──
  bg: "#fbfaf9", // warm paper, not pure white: the accent is warm, so is the page
  fg: "#221f1d", // primary text: warm near-black
  "fg-strong": "#000000",
  "fg-dim": "#4a4542",
  border: "rgba(0, 0, 0, 0.10)",
  "input-bg": "#ffffff", // cards are the BRIGHTEST surface here (inverse of dark)
  "surface-2": "#f1eeea",
  // tool bubbles, code blocks, inline code. DEEPER than the answer bubble, as it is
  // in the dark theme (#1a1a1a under #1e1e1e): a code block is RECESSED inside the
  // card. It used to be #f7f4f1 — LIGHTER than the card, i.e. raised — which was the
  // one place where the two themes disagreed about what a surface means.
  "tool-bg": "#eeebe7",
  "assistant-msg": "#f4f1ed", // the answer bubble must still read as a card on paper
  // ── Accent family ──
  "user-msg": "#b8531d",
  accent: "#b8531d",
  "accent-strong": "#9c4415",
  "accent-surface": "#f7e4d8", // the accent family, as a TINT of paper
  // Tints and glows follow THIS theme's terracotta (see the dark palette): on paper
  // the same alpha of #d95f27 reads weaker than the accent, so the values carry the
  // light hue and a slightly lower alpha.
  "accent-tint-soft": "rgba(184, 83, 29, 0.10)",
  "accent-tint": "rgba(184, 83, 29, 0.14)",
  "accent-tint-strong": "rgba(184, 83, 29, 0.20)",
  "accent-line": "rgba(184, 83, 29, 0.32)",
  "accent-glow-soft": "rgba(184, 83, 29, 0.10)",
  "accent-glow": "rgba(184, 83, 29, 0.30)",
  "accent-glow-strong": "rgba(184, 83, 29, 0.42)",
  // ── Checkpoint ──
  "summary-msg": "#6b4ba6",
  "summary-strong": "#5a3d90",
  // ── Secondary text, dimmest → strongest ──
  muted: "#6b6663",
  "muted-2": "#5c5754",
  "muted-3": "#837d79",
  // ── Translucent overlays ──
  "overlay-1": "rgba(0, 0, 0, 0.05)",
  "overlay-2": "rgba(0, 0, 0, 0.08)",
  "overlay-3": "rgba(0, 0, 0, 0.14)",
  "overlay-4": "rgba(0, 0, 0, 0.24)",
  "scroll-thumb": "rgba(0, 0, 0, 0.22)",
  "scroll-thumb-hover": "rgba(0, 0, 0, 0.36)",
  // ── Sinks and shadows ──
  "sink-1": "rgba(0, 0, 0, 0.045)",
  "sink-2": "rgba(0, 0, 0, 0.06)",
  backdrop: "rgba(0, 0, 0, 0.45)", // still a scrim: it dims the PANEL, not the theme
  "key-shadow": "rgba(0, 0, 0, 0.14)", // paper needs a shallower key shadow
  "modal-shadow": "rgba(0, 0, 0, 0.22)", // a floating card still needs to lift, not to darken the room
  // ── Semantic hues ──
  ok: "#2f7d32",
  "ok-bg": "rgba(47, 125, 50, 0.10)",
  info: "#1f6fb2",
  warn: "#b26a00",
  "warn-soft": "#8a6100",
  "warn-bright": "#c67c00",
  "on-warn": "#1a1a1a",
  violet: "#6847d4",
  "violet-text": "#5a3fc0",
  steer: "#a03434",
  "steer-strong": "#862929",
  "nudge-fg": "#123a63",
  error: "#c62828",
  // The SAME dark-error wash over paper: `rgba(244, 71, 71, 0.15)` composited on `--bg`, i.e.
  // exactly what the bubble painted before this role existed. The light theme never took its
  // own error hue here, and this pass is about the tab, not about re-tinting the bubble.
  "error-bg": "#fadfde",
  // ── Diffs ──
  del: "#b3261e",
  "del-bg": "rgba(179, 38, 30, 0.09)",
  // ── Syntax tokens (Prism: one-light, darkened where it must read on paper) ──
  "code-comment": "#a0a1a7",
  "code-keyword": "#a626a4",
  "code-string": "#3f8f3f",
  "code-number": "#986801",
  "code-function": "#4078f2",
  "code-class": "#c18401",
  "code-builtin": "#0184bc",
  "code-operator": "#383a42",
  "code-property": "#e45649",
};

/** The two palettes, indexable — the emitter (view-html.ts) loops over them,
 * so `dark` and `light` are handled by ONE code path and can never drift. */
export const PALETTES = { dark: PALETTE_DARK, light: PALETTE_LIGHT } as const;

/**
 * Root font size fallback. The extension host reads editor.fontSize and passes
 * it to the webview as a px value (see view-html.ts: editorFontSizePx), which
 * becomes the rem base so Harny's text matches the editor. Webviews expose
 * ONLY --vscode-font-size (the UI font, 13px default) — they do NOT receive
 * --vscode-editor-font-size — so this var chain is just the fallback when the
 * host value is missing. Must live on the ROOT (html): rem units resolve it.
 */
export const ROOT_FONT_SIZE = "var(--vscode-font-size, 13px)";
