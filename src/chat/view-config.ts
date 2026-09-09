/**
 * Harny view configuration — the ONE place with all design data.
 *
 * Plain data only (no functions). Every UI reads its values from here via the
 * CSS custom properties emitted in `:root`:
 *   · --font-<name>  → a FONT family (see FONTS)
 *   · --fs-<name>    → a SIZE family (see FAMILIES)
 *   · --<color>      → palette (see PALETTE)
 *
 * If you change a size or a font you do it HERE, in a single spot.
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

/** Dark-terracotta palette (independent of the active VS Code theme). */
export const PALETTE = {
  bg: "#111111", // main background: anthracite, near-black
  fg: "#e0e0e0", // primary text: bright light gray
  "fg-strong": "#ffffff", // titles / emphasis: pure white
  border: "rgba(255, 255, 255, 0.08)", // hairline only; separation is tone-on-tone
  "input-bg": "#1e1e1e", // containers, fields, cards
  "surface-2": "#222222", // raised surfaces / hover
  "user-msg": "#d95f27", // burnt-orange / terracotta accent
  accent: "#d95f27",
  "accent-strong": "#c8501c",
  "assistant-msg": "#1e1e1e",
  "tool-bg": "#1a1a1a",
  muted: "#888888", // secondary text, placeholders, disabled
  error: "#f44747",
} as const;

/**
 * Root font size: follows the VS Code EDITOR size (not the UI size), so
 * Harny's output text lines up with the code in the editing windows. Must
 * live on the ROOT (html): rem units resolve against it.
 */
export const ROOT_FONT_SIZE = "var(--vscode-editor-font-size, var(--vscode-font-size, 13px))";
