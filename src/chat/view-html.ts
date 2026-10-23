import { FONTS, FAMILIES, PALETTES, ROOT_FONT_SIZE, type ThemeMode } from "./view-config";
import { panelMinWidthCss } from "./panel-width";
import type { ChatMessage } from "../core/history/types";
import type { SessionSummary } from "../core/sessions/types";
import { DEFAULT_CONTEXT_WINDOW, DEFAULT_OUTPUT_TOKENS, MAX_CONTEXT_WINDOW, MAX_OUTPUT_TOKENS, MIN_CONTEXT_WINDOW, MIN_OUTPUT_TOKENS } from "./context-window";
import type { SessionLiveProjection } from "./session-live-state";

export interface ViewConfigState {
  provider: string;
  activeProvider?: string;
  model: string;
  hasKey: boolean;
  models: string[];
  providerModels: { provider: string; model: string }[];
  modelMissing?: boolean;
  hostModelErrors?: { provider: string; error: string }[];
  noModels?: boolean;
  configHome?: string;
  workspaceReady?: boolean;
  contextWindow: number;
  outputTokens: number;
  temperature?: number;
  contextTokens?: number;
  cachedTokens?: number;
}

export interface ViewState {
  sessions: SessionSummary[];
  openIds: string[];
  activeId?: string;
  messages: ChatMessage[];
  config: ViewConfigState;
  /** Extension version, shown in the empty hero (main screen). */
  version?: string;
  /** Cache-busted `vscode-webview://` URI of media/icon.svg — the brand mark is
   * loaded from that file at runtime, so there is no inlined copy to sync. */
  logoUri?: string;
  /** Publisher credit shown in the empty hero, next to the version. `url` comes
   * from package.json `repository`; when absent the name renders as plain text. */
  brand?: { name: string; url?: string };
  /** Session ids whose agent is streaming (disabled delete buttons in the list). */
  workingIds: string[];
  /** Whether the active session is mid-stream (initial lock + live restore). */
  streaming: boolean;
  /** Live (uncommitted) thinking/answer of the in-flight turn, for replay. */
  liveThinking: string;
  liveAnswer: string;
  /** The WHOLE in-flight turn: tool calls, sub-agent bubbles and their nested
   * logs. The history does not have them until the tool batch commits, so a
   * rebuild (tab switch / panel reload) must restore them from here. */
  liveTurn?: SessionLiveProjection;
  /** A compaction is running on the active session: the provisional bubble must
   * come back after a rebuild instead of vanishing. */
  compacting?: boolean;
  /** Messages typed while working (queue/steer), rendered as pending bubbles. */
  pending?: {
    id: string;
    mode: "queue" | "steer";
    text: string;
    attachments?: { name: string; size: number; isImage?: boolean; dataUri?: string }[];
  }[];
}

export interface ViewHtmlDeps {
  cspSource: string;
  scriptUri: string;
  state: ViewState;
  /** The VS Code editor font size (editor.fontSize) in px, read on the host.
   * The size families are rem-based, so 1rem == the editor font and Harny's
   * reading text matches the code in the editor. Webviews expose only
   * --vscode-font-size (UI font, 13px), NOT --vscode-editor-font-size, so the
   * host must read the setting and hand it over as a px value.
   */
  editorFontSizePx?: number;
  /** Which of Harny's two palettes to use (harny.theme). `auto` (the default)
   * leaves the choice to the editor: the body keeps no pinned class, so the
   * `vscode-light` / `vscode-dark` class VS Code puts there decides — and VS
   * Code swaps that class on a theme change without reloading the page. */
  theme?: ThemeMode;
}

/** One palette as CSS custom properties, PREFIXED by its theme name
 * (`--dark-bg`, `--light-bg`, …). Both live side by side in `:root`, so a role
 * is defined exactly once per theme and the selection below is a plain
 * assignment — no colour value is ever written twice. */
function paletteValues(theme: keyof typeof PALETTES): string {
  const palette = PALETTES[theme] as Record<string, string>;
  return Object.entries(palette)
    .map(([role, value]) => `      --${theme}-${role}: ${value};`)
    .join("\n");
}

/** `--bg: var(--dark-bg);` for every role — i.e. "this theme is now LIVE". */
function paletteRoles(theme: keyof typeof PALETTES): string {
  const palette = PALETTES[theme] as Record<string, string>;
  return Object.keys(palette)
    .map((role) => `      --${role}: var(--${theme}-${role});`)
    .join("\n");
}

function renderViewConfig(deps: ViewHtmlDeps): string {
  const fonts = Object.entries(FONTS)
    .map(([name, stack]) => `      --font-${name}: ${stack};`)
    .join("\n");
  const sizes = Object.entries(FAMILIES)
    .map(([name, fam]) => `      --fs-${name}: ${fam.size};`)
    .join("\n");
  const rootSize =
    typeof deps.editorFontSizePx === "number" && deps.editorFontSizePx > 0
      ? `${deps.editorFontSizePx}px`
      : ROOT_FONT_SIZE;
  return `    :root {
      /* Palettes, fonts and size families — defined in src/chat/view-config.ts */
${paletteValues("dark")}
${paletteValues("light")}
${fonts}
      --font-size: ${rootSize};
      font-size: var(--font-size);
${sizes}
    }
    /* ── Theme selection ──
       Harny does not adopt the editor's colours: it keeps its OWN reading of
       the two themes (terracotta on anthracite, terracotta on warm paper) and
       only asks the editor WHICH of the two is live. VS Code answers with a
       class on the webview body (vscode-dark / vscode-light /
       vscode-high-contrast / vscode-high-contrast-light) and swaps that class
       — together with its own --vscode-* variables — on a theme change
       WITHOUT reloading the page: that is why the panel re-skins instantly,
       with no host round-trip and no lost prompt.
       DARK is the BASE, not a branch: a page with no class at all (the unit
       tests, or the very first paint before VS Code adds its own) gets the
       palette Harny has always had.
       "color-scheme" rides along because it is the part CSS cannot fake: it is
       what makes the browser draw NATIVE widgets — the provider <select>, the
       sliders, the search fields' clear button, the scrollbars — in the right
       scheme instead of always-dark. */
    body {
${paletteRoles("dark")}
      color-scheme: dark;
    }
    body.vscode-light, body.vscode-high-contrast-light {
${paletteRoles("light")}
      color-scheme: light;
    }
    /* harny.theme PINNED: same specificity as the editor's class, so what
       makes the setting win is coming LAST — keep these two at the end. */
    body.theme-dark {
${paletteRoles("dark")}
      color-scheme: dark;
    }
    body.theme-light {
${paletteRoles("light")}
      color-scheme: light;
    }`;
}

function jsonInit(state: ViewState): string {
  return JSON.stringify(state).replace(/</g, "\\u003c");
}

/** Pure HTML for the single side-view: sessions list + tabs + active chat. */
export function renderViewHtml(deps: ViewHtmlDeps): string {
  const { cspSource, scriptUri } = deps;
  // `auto` (or no value at all) pins nothing: the editor's own class decides.
  const themeClass =
    deps.theme === "dark" ? " theme-dark" : deps.theme === "light" ? " theme-light" : "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource} data: https:; style-src ${cspSource} 'unsafe-inline'; script-src ${cspSource} 'unsafe-inline'; font-src ${cspSource};">
  <title>Harny</title>
  <style>
${renderViewConfig(deps)}
    * { box-sizing: border-box; margin: 0; padding: 0; }
    /* UI: one sans family everywhere (inherited); only real code/diff
       content switches to the single mono family. Grouped selectors so every
       element — including form controls, which do NOT inherit by default —
       takes its family from these two central rules. */
    body, button, input, select, textarea { font-family: var(--font-ui); }
    pre, code, .code-lang, .fd-stat, .fd-body, .sm-folder { font-family: var(--font-mono); }
    /* Never squeeze the LAYOUT below this: past it the panel gets a horizontal
       scrollbar instead of compressing the controls. (The PANEL's own minimum
       width is controlled by VS Code — the extension cannot force it: this floor
       is what Harny guarantees about its CONTENT, and it is also why the layout
       looks the same every time it opens.)
       450px is the MEASURED minimum, read off a live width readout in a real VS
       Code panel: the narrowest width at which the prompt placeholder still fits
       on one line and the control row (Analyze / Queue / Parallel / AI Model) is
       not squeezed. The floor shipped is PANEL_REFERENCE_WIDTH (panel-width.ts),
       keeping ~50px (about a ninth) of margin over that measurement — that margin
       is the TOLERANCE you feel when dragging the panel narrower before the
       scrollbar appears. The px value comes from that constant, NOT from a
       literal here: the intended tolerance and what the stylesheet enforces must
       never drift apart.
       (How wide the panel OPENS is VS Code's, not ours — it restores the width
       you last left it at, and offers no API to read or set it.)
       The 32rem part is INDEPENDENT of the reference: it covers LARGER editor
       fonts, where every control grows. Headless measurements put that side at
       roughly 22.75px per font px plus ~148px of chrome (~510px at a 16px font,
       ~600px at 20px), rounded up to 32 per font px to stay on the conservative
       side. With the floor at 500px the rem side takes over past a ~15.6px font
       (32rem === 500px exactly there).
       Beware: those headless numbers ran ~6% high against the real panel (they
       said 480px where the real answer is 450px), so treat the rem part as the
       conservative side of an estimate and the px part as the measured one.
       This also clears the two things measured earlier: the control row
       overflows under ~407px and the transcript action pills reach the centred
       ctl-toggle chevron under ~379px (at 14px) — both well below the floor. */
    html { min-width: ${panelMinWidthCss()}; overflow-x: auto; height: 100%; }
    body {
      font-size: 1rem;
      background: var(--bg);
      color: var(--fg);
      /* 100%, NOT 100vh. When the panel goes under the floor above, the window
         grows a HORIZONTAL scrollbar and that bar eats ~15px of height; 100vh is
         measured WITHOUT scrollbars, so the body ended up ~15px taller than the
         area actually drawn and the panel grew a SECOND, vertical bar — the
         "barra sulla finestra" that used to appear. A percentage always matches
         the viewport the panel is drawn in. */
      height: 100%;
      /* Relative so the modal overlays are laid out against the PANEL CONTENT
         (this box, which honours the min-width floor) instead of the viewport:
         that is what keeps a dialog from being squeezed by the visible slice
         when the horizontal bar is showing, and what makes it scroll together
         with the panel. No absolute child of body relied on the initial
         containing block: they all sit inside their own positioned parents. */
      position: relative;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      min-width: ${panelMinWidthCss()};
    }

    /* Sessions area: a card matching the control cards below. Borderless:
       separation comes from the tone-on-tone surface, not outline lines. */
    .sessions-card {
      border-radius: 8px;
      /* The bottom margin is the whole gap above the tab strip: #tabs only adds
         its own 5px of padding-top, so the session card and the tab head used
         to sit 5px apart (identical open or collapsed, since collapsing hides
         #sessions and leaves just the header). */
      margin: 8px 10px 10px;
      background: var(--input-bg);
      overflow: hidden; /* keep the scrolling list inside the rounded corners */
      flex-shrink: 0;
    }
    #session-head {
      display: flex; align-items: center; gap: 6px;
      padding: 5px 10px; font-weight: 700; font-size: var(--fs-md);
      color: var(--fg-strong);
      border-bottom: 1px solid var(--border);
      cursor: pointer; user-select: none;
    }
    #session-head .toggle { font-size: var(--fs-xs); width: 12px; color: var(--muted); }
    #session-head .spacer { flex: 1; }
    #session-head button {
      background: transparent; border: none; color: var(--accent);
      font-size: var(--fs-xl); cursor: pointer; padding: 0 4px;
      border-radius: 4px; transition: background-color 0.12s;
    }
    #session-head button:hover { background: var(--overlay-1); }
    /* The gear keys share ONE look and size across every card (sessions head,
       model row, compaction metrics): see the shared .gear-btn rule below. */
    #sessions { overflow-y: auto; max-height: 40vh; padding: 4px 0 6px; }
    #sessions.hidden { display: none; }
    .srow {
      display: flex; align-items: center; gap: 3px;
      padding: 4px 10px; font-size: var(--fs-lg); flex-wrap: wrap;
      border-radius: 6px; margin: 1px 4px;
      transition: background-color 0.1s;
    }
    .srow:hover { background: var(--tool-bg); }
    /* Creation + last-modified dates, on their own line BEFORE the name. */
    .srow .smeta {
      flex: 1 1 100%; color: var(--muted); font-size: var(--fs-xs);
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .srow .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: pointer; }
    .srow.open .name { color: var(--accent); }
    /* An open session that lives in ANOTHER folder: listed so its tab is never
       orphaned, dimmed so it never reads as one of this folder's. */
    .srow.foreign .name { opacity: 0.75; font-style: italic; }
    .srow-actions { display: inline-flex; align-items: center; gap: 8px; }
    .srow-actions button {
      background: transparent; border: none; color: var(--fg);
      font-size: var(--fs-lg); cursor: pointer; opacity: 0.65; padding: 2px 4px;
      border-radius: 4px; transition: opacity 0.12s, color 0.12s, background-color 0.12s;
    }
    .srow-actions button:hover:not(:disabled) { opacity: 1; color: var(--accent); background: var(--overlay-1); }
    /* A working session is fully hover-inert: the row stops highlighting and
       its action keys (branch/rename/delete) become dead — no cursor, no
       hover reaction, no tooltip (pointer-events none). Mirrors the ⎇ policy
       on assistant replies. */
    .srow.is-working:hover { background: transparent; }
    .srow-actions button:disabled {
      opacity: 0.28; cursor: default; pointer-events: none;
    }
    .empty { padding: 12px; text-align: center; color: var(--muted); font-size: var(--fs-lg); }

    /* Tabs: raised pill keys, consistent with the 3D button chrome. */
    #tabs {
      display: flex; gap: 3px; padding: 5px 8px 0;
      border-bottom: 1px solid var(--border); flex-shrink: 0;
      /* Horizontal scroll ONLY: no vertical scrollbar on a single-row strip. */
      overflow-x: auto; overflow-y: hidden;
      /* Tabs do NOT shrink (they stay readable); the strip SCROLLS instead. A
         thin, always-visible scrollbar + wheel-to-sideways make it reachable. */
      scrollbar-width: thin; scrollbar-color: var(--scroll-thumb) transparent;
    }
    #tabs::-webkit-scrollbar { height: 6px; }
    #tabs::-webkit-scrollbar-track { background: transparent; }
    #tabs::-webkit-scrollbar-thumb { background: var(--scroll-thumb); border-radius: 3px; }
    #tabs::-webkit-scrollbar-thumb:hover { background: var(--scroll-thumb-hover); }
    .tab {
      position: relative;
      display: inline-flex; align-items: center; gap: 5px;
      padding: 4px 10px; border-radius: 6px 6px 0 0; cursor: pointer;
      font-size: var(--fs-md); white-space: nowrap; color: var(--muted-2);
      border: 1px solid transparent; border-bottom: none;
      background: linear-gradient(to bottom, var(--overlay-1), rgba(255, 255, 255, 0));
      box-shadow: inset 0 -1px 0 var(--overlay-1);
      transition: color 0.12s, background-color 0.12s, box-shadow 0.12s;
      /* Readable floor: never squeeze a tab below this (the strip scrolls). */
      max-width: 12rem; min-width: 5.5rem; flex-shrink: 0;
      /* sits flush on the strip's border (active covers it with its face) */
      margin-bottom: -1px;
    }
    /* The label takes the FREE space, so the × sits on the tab's right edge instead of
       hugging the end of the name. min-width 0 is what makes the ellipsis work: a flex
       item refuses to shrink below its content without it. */
    .tab > span:first-child { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
    .tab:hover:not(.active) {
      color: var(--fg);
      background: linear-gradient(to bottom, var(--overlay-2), var(--overlay-1));
    }
    .tab.active {
      color: var(--fg);
      border-color: var(--border);
      background: linear-gradient(to bottom, var(--overlay-3), var(--overlay-1)),
        var(--assistant-msg);
      box-shadow:
        inset 0 1px 0 var(--overlay-3),
        0 -1px 3px var(--overlay-2);
    }
    .tab.active .close { color: var(--fg-dim); }
    .tab .close {
      font-size: var(--fs-sm); line-height: 1; padding: 1px 3px; margin-right: -2px;
      border-radius: 4px; color: var(--muted-2); flex-shrink: 0;
      transition: color 0.12s, background-color 0.12s;
    }
    .tab .close:hover { color: var(--error); background: rgba(244, 71, 71, 0.14); }
    /* A WORKING session's tab cannot be closed: its × is inert (switching the
       tab stays allowed). */
    .tab .close.disabled { opacity: 0.35; pointer-events: none; }

    /* Chat */
    /* scrollbar-gutter: stable reserves the scrollbar slot even when no
       scrollbar is shown — the bubble column width stays IDENTICAL whether or
       not the scrollbar appears. padding-right:0 lets the 10px gutter play the
       role of the right margin, so the chat column matches the controls below
       (same width, symmetric 10px gaps: paddings left 10 / gutter 10 right). */
    #messages {
      flex: 1; overflow-y: auto; scrollbar-gutter: stable;
      /* Top padding leaves room for the action tabs that slide UP out of the
         first bubble (see .branch-at/.truncate-at); too little clips them. */
      padding: 24px 0 0 10px;
      display: flex; flex-direction: column; gap: 6px;
    }
    .msg { padding: 8px 10px; border-radius: 8px; max-width: 92%; min-width: 0; word-wrap: break-word; word-break: break-word; overflow-wrap: break-word; line-height: 1.4; font-size: var(--fs-lg); }
    /* pre-wrap only for plain-text bubbles (user messages); markdown bubbles
       (assistant/tool) use breaks:true and white-space normal to avoid the
       ghost blank lines produced by markdown's structural newlines. */
    /* The ✂ tab is ~26px wide anchored 8px from the right, so a one-character
       message (bubble ≈ 28px) would be narrower than the tab and it would stick
       out to the left. This floor keeps the tab inside the bubble. */
    .msg.user { align-self: flex-end; background: var(--user-msg); color: #fff; white-space: pre-wrap; position: relative; min-width: 48px; text-align: center; }
    /* The user text is a shrink-to-fit, LEFT-aligned block CENTERED in the bubble:
       a single character sits in the middle of the min-width bubble; as the text
       grows it reaches the bubble edges and stays left-aligned. */
    .msg.user > .user-text { display: inline-block; max-width: 100%; text-align: left; white-space: pre-wrap; }
    /* …BUT when the bubble is wide for a reason of ITS OWN — an attachment, which is
       usually wider than the text — a shrink-to-fit block floats in the middle of it and
       the message reads as if it were centred. With the marker, the text takes the full
       width and starts where the previews do: the whole bubble reads left-aligned. */
    .msg.user.has-attachments > .user-text { display: block; }
    /* Harness-injected prompts (loop guard / delegation / budget): a LIGHT-BLUE
       bubble with a "Nudge" label, so they read as SYSTEM messages and can't be
       confused with the user's orange bubbles. Rendered as Markdown. */
    .msg.user.harness {
      align-self: stretch; max-width: 100%; white-space: normal; text-align: left;
      background: rgba(97, 175, 239, 0.12);
      border: 1px solid rgba(97, 175, 239, 0.45);
      color: var(--nudge-fg);
    }
    .msg.user.harness .harness-label {
      font-size: var(--fs-xs); font-weight: 700; letter-spacing: 0.08em;
      text-transform: uppercase; color: var(--info); margin-bottom: 4px;
    }
    .msg.user.harness .harness-md { min-width: 0; }
    .msg.user.harness .harness-md p { margin: 4px 0; }
    .msg.user.harness .harness-md > :first-child { margin-top: 0; }
    .msg.user.harness .harness-md > :last-child { margin-bottom: 0; }
    .msg.user.harness .harness-md ul, .msg.user.harness .harness-md ol { margin: 4px 0; padding-left: 1.4em; }
    .msg.user.harness .harness-md li { margin: 2px 0; }
    .msg.user.harness .harness-md code { background: var(--sink-2); border-radius: 3px; padding: 0 3px; }
    .msg.user.harness .harness-md pre { background: var(--sink-2); border-radius: 5px; padding: 6px 8px; overflow-x: auto; margin: 6px 0; }
    .msg.user.harness .harness-md a { color: #fff; text-decoration: underline; }
    .msg.user.harness .harness-md strong { font-weight: 600; }
    /* "Sent with these files" chips inside a user bubble: the message keeps the
       typed prompt; the attached documents are shown as a compact indicator
       (their contents live in the LLM context, not in the transcript). */
    /* Synthetic compacted prompt: a recognizable icon before the marker. */
    .msg.user.synthetic-summary .synthetic-icon { vertical-align: -2px; margin-right: 5px; }
    /* The CHECKPOINT — the summary that OPENS the context window. It is not a
       message the user typed, so it must not read like one: full width, framed, its
       own VIOLET (not the terracotta of a typed prompt), and its bottom corners
       square so the summary below it reads as the SAME card. */
    .msg.user.synthetic-summary {
      align-self: stretch; max-width: 100%; white-space: normal; text-align: left;
      border-bottom-left-radius: 0; border-bottom-right-radius: 0;
      background: var(--summary-msg);
      opacity: 0.9;
    }
    /* The summary BODY: attached under the label, with no bubble chrome of its own. It stays
       NEUTRAL — the violet marks the header, not the text you have to read. */
    .msg.assistant.synthetic-body {
      align-self: stretch; max-width: 100%;
      border-top-left-radius: 0; border-top-right-radius: 0;
      background: var(--overlay-1);
      border: 1px solid var(--overlay-2); border-top: none;
    }
    /* The pointer to the summary card, left where the reader actually is: after a
       compaction the card opens the window, i.e. several screens ABOVE the bottom. */
    .compacted-hint { align-self: stretch; text-align: center; margin: 6px 0; }
    .compacted-hint > button {
      height: 18px; min-height: 0; padding: 0 10px;
      display: inline-flex; align-items: center;
      background: var(--surface-2); color: var(--muted);
      border: 1px solid var(--overlay-3); border-radius: 999px;
      box-shadow: none; filter: none;
      font-size: var(--fs-xs); font-weight: 600; line-height: 1; white-space: nowrap;
      cursor: pointer;
    }
    .compacted-hint > button:hover {
      color: var(--accent); border-color: var(--accent); background: var(--accent-surface);
    }
    /* Older checkpoints, folded into ONE dim row: their content already lives in the
       newest summary above, so their bodies are noise in a long transcript. */
    .old-summaries {
      align-self: stretch; text-align: center;
      margin: 2px 0; color: var(--muted-3);
      font-size: var(--fs-xs); letter-spacing: 0.04em;
    }
    /* The rule that marks where the window starts. */
    .ctx-divider {
      align-self: stretch; display: flex; align-items: center; gap: 10px;
      margin: 12px 0 4px; color: var(--muted-3);
      font-size: var(--fs-xs); letter-spacing: 0.06em; text-transform: uppercase;
    }
    .ctx-divider::before, .ctx-divider::after {
      content: ""; flex: 1; height: 1px; background: currentColor; opacity: 0.4;
    }
    .msg-attachments { display: flex; flex-direction: column; align-items: flex-start; gap: 8px; margin-top: 6px; max-width: 100%; }
    .msg-attach-chips { display: flex; flex-wrap: wrap; gap: 4px; }
    /* Non-image attachments: a large per-type icon + name + size. */
    .msg-attach-files { display: flex; flex-wrap: wrap; gap: 8px; }
    .msg-attach-file {
      display: flex; flex-direction: column; align-items: center; gap: 2px;
      padding: 8px 12px; border-radius: 8px; min-width: 5.5rem; max-width: 12rem;
      background: rgba(0, 0, 0, 0.3); border: 1px solid rgba(255, 255, 255, 0.14);
    }
    .msg-attach-file-icon { line-height: 0; }
    .msg-attach-file-name { font-size: var(--fs-sm); color: #e8e8e8; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .msg-attach-file-size { font-size: var(--fs-xs); color: var(--muted-2); }
    .msg-attach {
      display: inline-flex; align-items: center; gap: 4px; max-width: 100%;
      padding: 1px 7px; border-radius: 999px; font-size: var(--fs-sm);
      /* Darker than the terracotta bubble so the white label pops (contrast). */
      background: rgba(0, 0, 0, 0.5); border: 1px solid rgba(0, 0, 0, 0.5);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .msg.assistant, .msg.tool { width: 100%; max-width: 100%; }
    .msg.assistant { align-self: flex-start; background: var(--assistant-msg); min-width: 0; position: relative; font-size: var(--fs-lg); }
    /* Per-turn metrics badge (REAL usage + timings) under an assistant bubble.
       flex-shrink: 0 is REQUIRED: #messages is a flex column and this item has
       overflow: hidden, so its automatic min-height is 0 and it would be
       squashed to 0px (invisible) as soon as the transcript overflows. */
    .msg-meta {
      flex-shrink: 0; align-self: flex-start; max-width: 92%; margin: -2px 0 2px 4px;
      font-size: var(--fs-sm); color: var(--muted); font-variant-numeric: tabular-nums;
      user-select: text; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    /* The mode chip leading the badge: the SAME quiet gray as the model and the
       counts that follow it for Analyze. In BUILD only the WORD takes the accent —
       the rest of the line stays gray, so the chip is a marker you can scan for and
       not a loud row repeated under half the transcript. */
    .msg-meta .meta-mode {
      padding: 0 4px; border-radius: 3px; background: var(--overlay-1);
      font-size: var(--fs-sm);
    }
    /* The one orange thing on the line: the word itself. Background and the text that
       follows keep their neutral tone. */
    .msg-meta .meta-mode.build { color: var(--accent); }
    /* Bubble action tabs: the ⎇ branch key on assistant replies and the ✂ cut
       key on user prompts become little "linguette" anchored to the bubble's
       TOP-RIGHT. On hover they SLIDE UP out of the bubble (same fade/reveal as
       before) so they stay clearly visible instead of blending into the text. */
    .branch-at, .truncate-at {
      position: absolute; top: 0; right: 8px; z-index: 4;
      display: inline-flex; align-items: center; justify-content: center;
      height: 20px; min-width: 24px; padding: 0 6px;
      background: var(--surface-2); border: 1px solid var(--overlay-3);
      border-bottom: none; border-radius: 6px 6px 0 0;
      color: var(--fg-dim); line-height: 1;
      cursor: pointer; opacity: 0; pointer-events: none;
      transform: translateY(6px);
      transition: opacity 0.14s ease, transform 0.14s ease,
                  color 0.12s, border-color 0.12s, background-color 0.12s;
    }
    /* The ✂ tab sits on an ORANGE user bubble: use the SAME orange as the
       bubble so it reads as a tab made of the same material. */
    .truncate-at { background: var(--user-msg); border-color: rgba(255, 255, 255, 0.28); color: #fff; }
    .msg.assistant:hover .branch-at,
    .msg.user:hover .truncate-at { opacity: 1; pointer-events: auto; transform: translateY(-100%); }
    /* Disabled (session working): fully inert — no hover reaction, hidden. */
    .msg.assistant:hover .branch-at:disabled,
    .msg.user:hover .truncate-at:disabled { opacity: 0; pointer-events: none; }
    /* Disabled (session working): hidden even WITHOUT hover. The global
       button:disabled opacity (0.3) outranks the base .truncate-at opacity 0,
       which left the tab faintly visible during a run. */
    .branch-at:disabled,
    .truncate-at:disabled { opacity: 0; pointer-events: none; }
    .branch-at:hover:not(:disabled) { color: var(--accent); border-color: var(--accent); background: var(--accent-surface); }
    .truncate-at:hover:not(:disabled) { color: #fff; border-color: #fff; background: var(--accent-strong); }
    /* …but on the CHECKPOINT header the ✂ tab is made of the violet the header is made of:
       a terracotta tab on a violet card would look like it belongs to another bubble. */
    .msg.user.synthetic-summary .truncate-at { background: var(--summary-msg); }
    .msg.user.synthetic-summary .truncate-at:hover:not(:disabled) { background: var(--summary-strong); }
    .msg.assistant.error { background: rgba(244, 71, 71, 0.15); border: 1px solid var(--error); }
    .msg.assistant.loop { background: rgba(245, 166, 35, 0.12); border: 1px solid var(--warn); }
    /* Prominent "Switch to Build" call to action (Analyze prepared previews). */
    .build-cta { display: flex; align-items: center; justify-content: space-between; gap: 10px; width: 100%; margin: 8px 0; padding: 10px 12px; border: 1px solid var(--warn); border-radius: 6px; background: rgba(245, 166, 35, 0.16); }
    .build-cta-static { background: rgba(245, 166, 35, 0.07); border-color: rgba(245, 166, 35, 0.4); }
    .build-cta-static .build-cta-text { color: var(--muted-2); }
    .build-cta-text { color: var(--fg-strong); font-size: 13px; }
    .build-cta-btn { flex: 0 0 auto; background: var(--warn); color: var(--on-warn); border: none; border-radius: 5px; padding: 6px 12px; font-weight: 600; font-size: 13px; cursor: pointer; white-space: nowrap; }
    .build-cta-btn:hover { background: var(--warn-bright); }
    .msg.assistant p { margin: 4px 0; }
    .msg.assistant h1, .msg.assistant h2, .msg.assistant h3, .msg.assistant h4, .msg.assistant h5, .msg.assistant h6 { margin: 8px 0 4px; font-weight: 700; color: var(--fg-strong); }
    .msg.assistant h1 { font-size: 1.15em; } .msg.assistant h2 { font-size: 1.05em; } .msg.assistant h3 { font-size: 1em; }
    .msg.assistant ul, .msg.assistant ol { margin: 4px 0; padding-left: 1.4em; }
    .msg.assistant ol { list-style: decimal; }
    .msg.assistant ul { list-style: disc; }
    .msg.assistant li { margin: 2px 0; }
    .msg.assistant code { background: var(--tool-bg); border-radius: 3px; padding: 0 3px; font-size: 1em; }
    .msg.assistant pre { background: var(--tool-bg); border: 1px solid var(--border); border-radius: 5px; padding: 6px 8px; overflow-x: auto; margin: 6px 0; }
    .msg.assistant pre code { background: transparent; padding: 0; }
    .msg.assistant a { color: var(--accent); }
    .msg.assistant strong { font-weight: 600; }
    .msg.assistant em { font-style: italic; }
    .msg.assistant blockquote { border-left: 2px solid var(--border); padding-left: 8px; margin: 6px 0; color: var(--muted-2); }
    .msg.assistant table { border-collapse: separate; border-spacing: 0; font-size: var(--fs-md); }
    .msg.assistant th, .msg.assistant td { border: 1px solid var(--border); padding: 3px 6px; text-align: left; }
    .msg.assistant th { background: var(--tool-bg); }
    .msg.assistant img { max-width: 100%; border-radius: 4px; }
    /* The wrapper OWNS the whole rounded frame and shrink-wraps the table
       (fit-content): no full-width line when the table is narrower, and the
       right corners follow the same radius. Cells only draw INTERIOR grid
       lines (outer edges suppressed — the frame belongs to the wrapper).
       An inline-block wrapper left this UNBOUNDED: a shrink-to-fit width resolves
       max-width:100% against the CONTENT itself, so a wide table made the wrapper as
       wide as the table and there was nothing left to scroll — the table was clipped
       by the panel edge instead (visible as a missing right corner). A block with
       width:fit-content does the same shrink-wrapping against a DEFINITE containing
       block, and the styled scrollbar below is what makes the scroll VISIBLE: on macOS
       overlay scrollbars are invisible until you scroll, so a working scrollable table
       looked broken. */
    .table-scroll {
      display: block;
      width: fit-content;
      max-width: 100%;
      border: 1px solid var(--border);
      border-radius: 8px;
      overflow-x: auto;
      overflow-y: hidden;
      margin: 6px 0;
    }
    .table-scroll::-webkit-scrollbar { height: 9px; }
    .table-scroll::-webkit-scrollbar-track { background: transparent; }
    .table-scroll::-webkit-scrollbar-thumb {
      background: var(--scroll-thumb);
      border-radius: 5px;
    }
    .table-scroll::-webkit-scrollbar-thumb:hover { background: var(--scroll-thumb-hover); }
    .table-scroll table { min-width: max-content; border-collapse: separate; border-spacing: 0; }
    .msg.assistant .table-scroll th, .msg.assistant .table-scroll td,
    .thinking-body .table-scroll th, .thinking-body .table-scroll td {
      border: none;
      border-right: 1px solid var(--border);
      border-bottom: 1px solid var(--border);
    }
    /* Right column & bottom row: the line comes from the wrapper's frame. */
    .msg.assistant .table-scroll th:last-child, .msg.assistant .table-scroll td:last-child,
    .thinking-body .table-scroll th:last-child, .thinking-body .table-scroll td:last-child {
      border-right: none;
    }
    .msg.assistant .table-scroll tr:last-child th, .msg.assistant .table-scroll tr:last-child td,
    .thinking-body .table-scroll tr:last-child th, .thinking-body .table-scroll tr:last-child td {
      border-bottom: none;
    }
    .code-block { overflow-x: auto; }
    .code-lang { font-size: var(--fs-xs); text-transform: uppercase; letter-spacing: 0.4px; color: var(--muted); background: var(--sink-1); padding: 1px 8px; border-bottom: 1px solid var(--border); }
    .msg.tool { align-self: flex-start; background: var(--tool-bg); border: 1px solid var(--border); font-size: var(--fs-md); }
    .msg.system { display: none; }
    .msg.welcome { align-self: center; background: transparent; border: 1px dashed var(--border); color: var(--muted); text-align: center; max-width: 100%; }
    /* Brand mark inline in the greeting. The artwork is WIDE (22x16 inside the
       square 24x24 viewBox), so the box is scaled up to ~1.4em to make the
       visible mark match the surrounding text height. */
    .msg.welcome .welcome-logo { width: 1.4em; height: 1.4em; vertical-align: -0.4em; display: inline-block; }
    .working { align-self: flex-start; color: var(--muted-2); font-size: var(--fs-md); font-style: italic; animation: harny-pulse 1.2s ease-in-out infinite; }
    /* The working bar is a REAL footer glued below the transcript (NOT a bubble
       in the flow): always visible in realtime while it exists. It lives
       outside #messages, so sections are never inserted below it. The text
       pulses with the same 1.2s cadence as the play button (harny-pulse). */
    #working-bar {
      flex-shrink: 0;
      padding: 4px 10px;
      background: var(--bg);
      color: var(--muted-2); font-size: var(--fs-md); font-style: italic;
      animation: harny-pulse 1.2s ease-in-out infinite;
    }
    #working-bar.hidden { display: none; }
    /* Messages typed WHILE the session works: a real footer (outside
       #messages) so they survive streaming re-renders. Queue = neutral, steer
       = accent. Each is cancellable until it is applied. */
    #pending-section { flex-shrink: 0; background: var(--bg); border-top: 1px dashed var(--border); }
    #pending-section.hidden { display: none; }
    /* Same shape as the sessions header (arrow + label, whole row clickable), so
       the two collapsible sections behave and read the same way. */
    #pending-head {
      display: flex; align-items: center; gap: 6px; padding: 5px 10px;
      font-weight: 700; font-size: var(--fs-md); color: var(--fg-strong);
      cursor: pointer; user-select: none;
    }
    #pending-head:hover { color: var(--accent); }
    #pending-head .toggle { font-size: var(--fs-xs); width: 12px; color: var(--muted); }
    /* Expanded, the WHOLE list is readable and the SECTION does the scrolling: one
       scrollbar for the group (bounded so the transcript keeps its space) instead
       of a cap per bubble. */
    #pending-area {
      display: flex; flex-direction: column; gap: 4px; padding: 0 10px 6px;
      max-height: 30vh; overflow-y: auto;
    }
    #pending-area.hidden { display: none; }
    .pending-msg {
      display: flex; align-items: flex-start; gap: 8px; min-width: 0;
      padding: 3px 6px 3px 8px; border-radius: 6px; font-size: var(--fs-md);
      border: 1px solid var(--border); background: var(--surface-2); color: var(--muted);
    }
    .pending-msg.pending-steer { border-color: var(--accent); color: var(--fg); }
    .pending-badge {
      flex: 0 0 auto; font-size: var(--fs-sm); text-transform: uppercase; letter-spacing: 0.04em;
      padding: 1px 5px; border-radius: 999px; background: var(--tool-bg); color: var(--muted);
    }
    .pending-msg.pending-steer .pending-badge { background: var(--accent); color: #fff; }
    /* The row is badge + content + actions: the text and its attachments share the
       middle column (so the previews land UNDER the text, as in a user bubble) while
       the commands stay pinned to the top-right corner. */
    .pending-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
    /* ONE LINE while folded: clipped, and faded at the right edge. NOT "nowrap" +
       ellipsis, which would make the "does it wrap?" measurement impossible (a
       nowrap box always reports a single line — see pending-fold.ts). Opened, the
       text is WHOLE: it wraps, keeps the user's own line breaks and the bubble grows
       as tall as it needs, while the SECTION owns the scroll (#pending-area). */
    .pending-text {
      flex: 1; min-width: 0; white-space: pre-wrap; overflow-wrap: anywhere;
      line-height: 1.4;
    }
    .pending-msg.text-collapsed .pending-text {
      max-height: 1.4em; overflow: hidden;
      -webkit-mask-image: linear-gradient(to right, #000 calc(100% - 1.4rem), transparent);
      mask-image: linear-gradient(to right, #000 calc(100% - 1.4rem), transparent);
    }
    /* The previews are folded away WITH the text: a closed row is exactly one line,
       thumbnails included. */
    .pending-msg.text-collapsed .pending-extras { display: none; }
    /* The SHARED attachment row (the one user bubbles render), inside a pending row:
       identical content, a hair tighter — the main column already spaces it. */
    .pending-extras .msg-attachments { margin-top: 0; gap: 6px; }
    /* The fold is the same bare chevron as every other toggle in Harny (.tool-toggle),
       and it is one of this bubble's ACTIONS, so it sits with the other two instead of
       in front of the text. Hidden, its SPACE stays reserved (visibility, not
       display): the commands then land in the same spot on every row. */
    .pending-toggle {
      flex: 0 0 auto; width: 12px; padding: 0; background: transparent; border: none;
      box-shadow: none; color: var(--muted); font-size: var(--fs-sm); line-height: 1.2;
      cursor: pointer;
    }
    .pending-toggle:hover { filter: none; color: var(--accent); }
    .pending-toggle.hidden { visibility: hidden; }
    /* The buttons sit TOP-RIGHT, before the badge/text in DOM terms they follow,
       pinned with margin-left: auto so multi-line text never moves them. */
    .pending-actions { flex: 0 0 auto; margin-left: auto; display: flex; gap: 4px; }
    .pending-actions button {
      flex: 0 0 auto; min-height: 1.2rem; padding: 0 0.4rem; background: transparent;
      border: 1px solid var(--border); color: var(--muted); box-shadow: none;
      font-size: var(--fs-sm); white-space: nowrap;
    }
    .pending-actions button:hover { filter: none; }
    .pending-cancel:hover { color: var(--error); border-color: var(--error); }
    .pending-convert:hover { color: var(--accent); border-color: var(--accent); }
    /* A steer that became a real user turn: a thin accent bar on the left. */
    .msg.user.steer-msg { border-left: 2px solid var(--accent); }
    @keyframes harny-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
    /* The ACTIVE areas pulse their border with the SAME 1.2s ease-in-out
       cadence as the play button (harny-pulse) and IN PHASE with it: the
       peak (full accent + glow) is at 0%/100% of the cycle, exactly when the
       play key is at full opacity; 50% is the dim beat, matching the play
       key's fade. Deliberately evident: 2px border breathing between a soft
       accent edge and the full accent with a visible glow. Applied to the
       answer bubble being filled AND the live thinking block while it works.
       box-sizing:border-box keeps the border inside (no layout jump). */
    @keyframes stream-border-pulse {
      0%, 100% { border-color: var(--accent); box-shadow: 0 0 14px 1px var(--accent-glow); }
      50% { border-color: var(--accent-line); box-shadow: 0 0 4px 0 var(--accent-glow-soft); }
    }
    /* Same cadence/phase as stream-border-pulse, but in the SUB-AGENT violet so
       a running sub-agent glows with a halo close to its own border color. */
    @keyframes stream-border-pulse-violet {
      0%, 100% { border-color: var(--violet); box-shadow: 0 0 14px 1px rgba(124, 92, 255, 0.5); }
      50% { border-color: rgba(124, 92, 255, 0.4); box-shadow: 0 0 4px 0 rgba(124, 92, 255, 0.15); }
    }
    .msg.assistant.streaming {
      border: 2px solid var(--accent-line);
      animation: stream-border-pulse 1.2s ease-in-out infinite;
    }
    /* Live thinking header (the block is collapsed by default, so this is the
       visible "working" indicator): same cadence, accent edges. */
    .thinking-block.streaming {
      animation: stream-border-pulse 1.2s ease-in-out infinite;
    }
    /* Graceful end: when a stream finishes the pulse settles out smoothly
       (~0.7s fade) instead of snapping off — the answer bubble fades back to
       borderless, the thinking block back to its quiet dashed edge. */
    .msg.assistant.settling {
      border: 2px solid var(--accent-line);
      animation: none;
      transition: border-color 0.7s ease, box-shadow 0.7s ease;
      border-color: transparent;
      box-shadow: none;
    }
    .thinking-block.settling {
      animation: none;
      transition: border-color 0.7s ease;
      border-color: var(--border);
    }

    .tool-header { display: flex; align-items: center; gap: 5px; cursor: pointer; user-select: none; font-weight: 600; color: var(--accent); min-width: 0; }
    .tool-header:hover { color: var(--fg); }
    .tool-toggle { font-size: var(--fs-sm); width: 12px; color: var(--muted); flex-shrink: 0; }
    .tool-name { white-space: nowrap; }
    /* Target file path shown after the tool name (light azure, ellipsized,
       truncated softly when the bubble is narrow — full path on hover). */
    .tool-path { color: var(--info); font-weight: 400; flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; opacity: 0.95; }
    .tool-details { margin-top: 2px; font-size: var(--fs-md); }
    .tool-details.collapsed { display: none; }
    .tool-label { display: block; color: var(--muted); font-size: var(--fs-xs); text-transform: uppercase; letter-spacing: 0.4px; margin: 6px 0 2px; }
    .tool-details pre { background: var(--sink-1); border: 1px solid var(--border); border-radius: 4px; padding: 5px 7px; white-space: pre-wrap; word-break: break-all; max-height: 160px; overflow-y: auto; font-size: var(--fs-md); line-height: 1.4; }
    /* The Task/Input arguments block is a <pre>: WRAP it at the bubble width
       (the sub-agent "Task" lives OUTSIDE .tool-details, so it needs its own
       rule) and GROW vertically with the wrapped content — no max-height /
       scrollbar (the bubble simply gets taller). */
    .tool-args {
      background: var(--sink-1); border: 1px solid var(--border); border-radius: 4px;
      padding: 5px 7px; margin: 0;
      white-space: pre-wrap; word-break: break-all;
      font-family: var(--font-mono); font-size: var(--fs-md); line-height: 1.4;
    }
    .tool-result-error { color: var(--error); }
    /* Diff section INSIDE the tool bubble (third section: Input / Output /
       Diff). Replaces the previous separate .msg.file-diff bubble: the diff
       lives in the collapsed .tool-details together with Input and Output, so
       it expands with the tool bubble — no flex-shrink hazard, no 2px strip. */
    .tool-diff { margin-top: 2px; }
    .tool-diff-head { display: flex; align-items: baseline; gap: 6px; }
    .tool-diff-head .tool-label { margin: 6px 0 2px; }
    .fd-stat { opacity: 0.7; font-weight: 500; font-size: var(--fs-xs); }
    .fd-body { padding: 0 0 4px; font-size: var(--fs-md); line-height: 1.5; }
    .fd-body div { padding: 0 10px; white-space: pre-wrap; word-break: break-all; }
    .fd-add { color: var(--ok); background: var(--ok-bg); }
    .fd-del { color: var(--del); background: var(--del-bg); }
    .fd-hunk { color: var(--accent); background: var(--overlay-1); }
    .fd-ctx { color: inherit; opacity: 0.8; }
    /* Editor-style syntax tokens inside the diff lines (Prism classes). One-dark
       and one-light are the two readings of the SAME roles, so a light theme gets
       readable code instead of a washed-out one: see the code-* roles in
       view-config.ts. */
    .fd-body .token { color: inherit; opacity: 1; }
    .fd-body .token.comment, .fd-body .token.prolog, .fd-body .token.cdata { color: var(--code-comment); font-style: italic; }
    .fd-body .token.keyword, .fd-body .token.selector, .fd-body .token.atrule, .fd-body .token.important { color: var(--code-keyword); }
    .fd-body .token.string, .fd-body .token.attr-value, .fd-body .token.char, .fd-body .token.regex { color: var(--code-string); }
    .fd-body .token.number, .fd-body .token.boolean, .fd-body .token.constant { color: var(--code-number); }
    .fd-body .token.function, .fd-body .token.function-variable { color: var(--code-function); }
    .fd-body .token.class-name, .fd-body .token.maybe-class-name { color: var(--code-class); }
    .fd-body .token.builtin { color: var(--code-builtin); }
    .fd-body .token.operator, .fd-body .token.punctuation { color: var(--code-operator); }
    .fd-body .token.property, .fd-body .token.attr-name, .fd-body .token.variable { color: var(--code-property); }
    .fd-body .token.doctype, .fd-body .token.entity { color: var(--code-property); }
    .tool-call-pending { opacity: 0.65; }

    /* Sub-agent (Delegate) bubble: clearly shows that the orchestrator LAUNCHED
       a sub-agent — id/role, live status, the goal in clear text and the
       declared resources/access it may touch. Tinted violet to stand out from
       ordinary tool calls. */
    .msg.tool.subagent { border-color: rgba(124, 92, 255, 0.45); background: rgba(124, 92, 255, 0.06); }
    /* While THIS sub-agent runs, its bubble pulses with the SAME cadence/phase
       as the thinking/answer bubbles but in its OWN violet (halo matching the
       border), phase-locked to the shared clock (phaseLockPulse) so every
       working area beats together. */
    .msg.tool.subagent.subagent-running { animation: stream-border-pulse-violet 1.2s ease-in-out infinite; }
    /* Graceful end: settle back to the resting violet edge (~0.7s fade). */
    .msg.tool.subagent.subagent-settling {
      animation: none;
      transition: border-color 0.7s ease, box-shadow 0.7s ease;
      border-color: rgba(124, 92, 255, 0.45);
      box-shadow: none;
    }
    .subagent-header { gap: 6px; --sa-chip-h: 1.3rem; }
    .subagent-header .subagent-icon { color: var(--violet-text); vertical-align: -2px; }
    #working-bar .subagent-icon { vertical-align: -2px; }
    /* In this header exactly ONE element gives way: the goal. Everything else —
       the name, the role, the status chip, abort and the arrow — is fixed, so a
       narrow panel cannot squeeze THEM and leave the goal at full length. */
    .subagent-header .tool-name { flex: 0 0 auto; }
    .subagent-role { color: var(--violet-text); font-weight: 500; flex: 0 0 auto; }
    /* The sub-agent's short goal in the header: what it actually does.
       NO lower bound (min-width: 0): it may shrink all the way to nothing, and
       the ellipsis travels left with it, because how much fits is a question
       about the PANEL, not about the text (no character cut is applied in JS). */
    .subagent-name {
      color: var(--muted-2); font-weight: 400; flex: 0 1 auto; min-width: 0;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    /* NOT margin-left: auto — the chip (running… / done / failed) sits right after
       the goal, so it slides left together with it instead of being pinned to the
       right edge while the goal is squeezed. */
    .subagent-status {
      flex-shrink: 0;
      display: inline-flex; align-items: center;
      height: var(--sa-chip-h); box-sizing: border-box;
      font-size: var(--fs-xs); font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase;
      padding: 0 7px; border-radius: 999px; border: 1px solid var(--border); color: var(--muted-2);
    }
    .subagent-status.queued { color: var(--muted-2); border-color: var(--border); }
    /* The "running…" chip is STATIC: the bubble itself carries the pulsing
       border while this sub-agent works (see .subagent-running above). */
    .subagent-status.running { color: var(--violet-text); border-color: rgba(124, 92, 255, 0.5); }
    .subagent-status.done { color: var(--ok); border-color: rgba(152, 195, 121, 0.5); }
    .subagent-status.failed { color: var(--error); border-color: rgba(244, 71, 71, 0.5); }
    .subagent-status.aborted { color: var(--muted-2); border-color: var(--border); }
    /* Per-sub-agent abort: stop ONLY this sub-agent, not the whole run. SQUARE
       and exactly as tall as the "running" chip's border box (shared
       --sa-chip-h); the global button min-height would otherwise stretch it
       into a rectangle. */
    .subagent-abort {
      flex: 0 0 auto; display: inline-flex; align-items: center; justify-content: center;
      width: var(--sa-chip-h); height: var(--sa-chip-h); min-width: var(--sa-chip-h); min-height: var(--sa-chip-h);
      padding: 0; cursor: pointer;
      color: var(--violet-text); background: transparent; border: 1px solid rgba(124, 92, 255, 0.45);
      border-radius: 4px; transition: background-color 0.12s, color 0.12s;
    }
    .subagent-abort:hover:not(:disabled) { background: rgba(124, 92, 255, 0.18); color: #fff; }
    .subagent-abort:disabled { opacity: 0.5; cursor: default; }
    .subagent-abort[hidden] { display: none; }
    .subagent-goal { padding: 0 8px 4px 22px; color: var(--fg); font-style: italic; font-size: var(--fs-md); overflow-wrap: anywhere; word-break: break-word; }
    /* The bubble body (goal + nested stream + report) is collapsed by default. */
    .subagent-body.collapsed { display: none; }
    /* Nested live stream inside a running sub-agent bubble. */
    .sa-log {
      display: flex; flex-direction: column; gap: 2px;
      padding: 2px 8px 6px 22px; border-left: 2px solid rgba(124, 92, 255, 0.25);
      margin: 0 0 2px 8px;
    }
    .sa-thinking { color: var(--muted); font-style: italic; font-size: var(--fs-sm); word-break: break-word; }
    .sa-answer { color: var(--fg); font-size: var(--fs-md); word-break: break-word; }
    /* Markdown inside the nested live stream (same shapes as the thinking body). */
    /* Markdown shapes shared by the nested stream AND the sub-agent report. */
    .subagent-report { color: var(--fg); font-size: var(--fs-md); word-break: break-word; }
    .sa-thinking p, .sa-answer p, .subagent-report p { margin: 2px 0; }
    .sa-thinking ul, .sa-thinking ol, .sa-answer ul, .sa-answer ol, .subagent-report ul, .subagent-report ol { margin: 2px 0; padding-left: 1.2em; }
    .sa-thinking ol, .sa-answer ol, .subagent-report ol { list-style: decimal; }
    .sa-thinking ul, .sa-answer ul, .subagent-report ul { list-style: disc; }
    .sa-thinking li, .sa-answer li, .subagent-report li { margin: 1px 0; }
    .sa-thinking strong, .sa-answer strong, .subagent-report strong { font-weight: 600; }
    .sa-thinking em, .sa-answer em, .subagent-report em { font-style: italic; }
    .sa-thinking code, .sa-answer code, .subagent-report code {
      background: var(--sink-1); border-radius: 3px; padding: 0 3px;
      font-family: var(--font-mono); font-size: var(--fs-sm);
    }
    .sa-thinking pre, .sa-answer pre, .subagent-report pre {
      background: var(--sink-1); border: 1px solid var(--border); border-radius: 4px;
      padding: 4px 6px; overflow-x: auto; margin: 3px 0; font-family: var(--font-mono); font-size: var(--fs-sm);
    }
    .sa-thinking pre code, .sa-answer pre code, .subagent-report pre code { background: transparent; padding: 0; }
    .sa-thinking a, .sa-answer a, .subagent-report a { color: var(--accent); }
    .subagent-report.tool-result-error { color: var(--error); }
    .sa-tool {
      color: var(--muted-2); font-size: var(--fs-sm); font-family: var(--font-mono);
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .sa-tool.pending { opacity: 0.6; }
    .sa-tool.ok { color: var(--ok); }
    .sa-tool.err { color: var(--error); }
    .subagent-meta { display: flex; flex-wrap: wrap; gap: 4px; margin: 4px 0 2px; }
    .subagent-chip {
      display: inline-flex; align-items: center; padding: 0 6px; border-radius: 999px;
      max-width: 100%; overflow-wrap: anywhere;
      background: var(--tool-bg); border: 1px solid var(--border); color: var(--muted-2); font-size: var(--fs-xs);
    }
    .subagent-chip.access-read { color: var(--info); border-color: rgba(97, 175, 239, 0.4); }
    .subagent-chip.access-write, .subagent-chip.access-create { color: var(--warn-soft); border-color: rgba(229, 192, 123, 0.4); }
    .subagent-chip.parallel { color: var(--violet-text); border-color: rgba(124, 92, 255, 0.4); }

    .thinking-block { width: 100%; border: 1px dashed var(--border); border-radius: 6px; margin: 4px 0; padding: 0; font-size: var(--fs-md); }
    .thinking-header { display: flex; align-items: center; gap: 5px; padding: 5px 8px; cursor: pointer; user-select: none; color: var(--muted-2); font-style: italic; }
    .thinking-header:hover { color: var(--accent); }
    .thinking-header .toggle { font-size: var(--fs-sm); width: 12px; }
    /* Thinking is now rendered as Markdown (md on the reasoning text), so the
       body uses normal whitespace + breaks:true like the assistant bubbles. */
    .thinking-body { padding: 0 8px 6px; color: var(--muted-2); line-height: 1.45; }
    .thinking-body p { margin: 4px 0; }
    .thinking-body h1, .thinking-body h2, .thinking-body h3, .thinking-body h4, .thinking-body h5, .thinking-body h6 { margin: 8px 0 4px; font-weight: 700; color: var(--fg-strong); }
    .thinking-body ul, .thinking-body ol { margin: 4px 0; padding-left: 1.4em; }
    .thinking-body ol { list-style: decimal; }
    .thinking-body ul { list-style: disc; }
    .thinking-body li { margin: 2px 0; }
    .thinking-body a { color: var(--accent); }
    .thinking-body strong { font-weight: 600; }
    .thinking-body em { font-style: italic; }
    .thinking-body code { background: var(--sink-1); border-radius: 3px; padding: 0 3px; font-size: var(--fs-md); }
    .thinking-body pre { background: var(--sink-1); border: 1px solid var(--border); border-radius: 4px; padding: 4px 6px; overflow-x: auto; margin: 4px 0; }
    .thinking-body pre code { background: transparent; padding: 0; }
    .thinking-body blockquote { border-left: 2px solid var(--border); padding-left: 8px; margin: 4px 0; }
    .thinking-body table { border-collapse: separate; border-spacing: 0; }
    .thinking-body th, .thinking-body td { border: 1px solid var(--border); padding: 3px 6px; text-align: left; }
    .thinking-body th { background: var(--sink-1); }
    .thinking-body img { max-width: 100%; border-radius: 4px; }
    .thinking-body hr { border: none; border-top: 1px solid var(--border); margin: 6px 0; }
    .thinking-body .task-list-item-checkbox { margin-right: 4px; vertical-align: middle; }
    .thinking-body.collapsed { display: none; }
    .thinking { align-self: flex-start; color: var(--muted-2); font-style: italic; font-size: var(--fs-md); white-space: pre-wrap; }

    /* Input area: a full-width card matching the sessions/control cards. */
    #input-area {
      display: flex; flex-direction: column; gap: 4px;
      margin: 8px 10px 0;
      border-radius: 8px; padding: 8px 10px 6px;
      background: var(--input-bg);
    }
    /* Input row: the "+" file picker is the head key (same size as the
       Play/Stop keys on the right), then the prompt, then ▶/⏹. */
    #input-main { display: flex; gap: 8px; align-items: flex-end; min-width: 0; }
    #user-input {
      flex: 1; background: var(--surface-2); color: var(--fg);
      border: 1px solid var(--border); border-radius: 6px; padding: 6px 8px;
      font-size: var(--fs-lg); line-height: 1.4; resize: none;
      min-height: 2.31rem; max-height: 18.5rem; outline: none;
    }
    #user-input:focus { border-color: var(--accent); }
    button {
      background: var(--accent); color: #fff; border: none; border-radius: 6px;
      cursor: pointer; font-size: var(--fs-lg); line-height: 1;
      /* All button glyphs (▶ ⏹ ✎ 🗑 − + ＋ Compact) stay centered at any font
         size: flex centering + a font-proportional minimum hit area. */
      display: inline-flex; align-items: center; justify-content: center;
      min-height: 1.54rem; padding: 0 0.46rem;
      /* Subtle 3D "key" chrome: beveled top highlight + bottom shade + small
         drop shadow; pressing dips the key down and flattens it. */
      box-shadow:
        inset 0 1px 0 rgba(255, 255, 255, 0.22),
        inset 0 -1px 0 rgba(0, 0, 0, 0.22),
        0 1px 2px var(--key-shadow);
      transition: transform 0.08s, box-shadow 0.12s, filter 0.12s, color 0.12s;
    }
    button:not(:disabled):hover { filter: brightness(1.12); }
    button:not(:disabled):active {
      transform: translateY(1px);
      box-shadow: inset 0 1px 3px var(--key-shadow);
    }
    button:disabled { opacity: 0.3; cursor: default; }
    /* Icon buttons: SVG glyphs are block-level inside the flex, so the
       baseline gap of inline svg never shifts the shape off-center. */
    button svg { display: block; }
    button.secondary { background: transparent; border: 1px solid var(--border); color: var(--fg); }
    /* Stop (abort) is ENABLED only while working: a red hover signals the
       danger action in exactly that state (disabled elsewhere). */
    #abort-btn:enabled:hover {
      color: var(--error);
      border-color: var(--error);
      background: rgba(244, 71, 71, 0.12);
    }
    /* Play/Stop keys: CSS-drawn shapes (::before) replace the ▶/⏹ font glyphs,
       whose metric box varies per font and drifts off-center at larger sizes.
       rem units = scale with the UI font; triangle and square have ≈ equal
       visual mass, so the two keys look identical and centered at ANY size.
       font-size:0 keeps the text glyph as an invisible DOM fallback. */
    #input-main button {
      height: 2.31rem;
      min-width: 2.77rem;
      padding: 0 0.77rem;
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }

    /* Chips row under the input: queued files only — the paperclip picker lives
       at the head of the text box (first key in #input-main). An empty row must
       not leave a phantom gap at the bottom of the ask box: hide it entirely. */
    #attach-row { display: flex; align-items: center; gap: 6px; min-width: 0; }
    #attach-row:has(#attachment-chips.hidden) { display: none; }
    #attach-btn { color: var(--muted); font-size: var(--fs-lg); }
    #attach-btn:not(:disabled):hover { color: var(--accent); border-color: var(--accent); filter: none; }
    #attachment-chips { display: flex; flex-wrap: wrap; gap: 6px; min-width: 0; }
    #attachment-chips.hidden { display: none; }
    .attach-chip {
      display: inline-flex; align-items: center; gap: 6px; max-width: 100%;
      padding: 1px 3px 1px 8px; border-radius: 999px;
      background: var(--tool-bg); border: 1px solid var(--border);
      font-size: var(--fs-sm); color: var(--fg);
    }
    .attach-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 12rem; }
    /* An attachment that came back from a reload WITHOUT its payload: the chip keeps its
       place (name, size) but says so, and send() refuses it instead of sending an empty
       file. Amber, not red: it is recoverable (re-attach the file). */
    .attach-chip.attach-stale { border-color: var(--warn, #d19a11); }
    .attach-warn { color: var(--warn, #d19a11); }
    .attach-icon { display: inline-flex; align-items: center; line-height: 0; flex: 0 0 auto; }
    /* Thumbnail preview of a pasted clipboard image in its attachment chip. */
    .attach-thumb { width: 22px; height: 22px; object-fit: cover; border-radius: 3px; border: 1px solid var(--border); cursor: zoom-in; }
    /* Attached IMAGE: half the chat width by default, NEVER deformed (height
       follows the image), resizable via the bottom-right handle. */
    .msg-attach-img {
      display: block; max-width: 100%; min-width: 4rem;
      resize: horizontal; overflow: hidden;
      border-radius: 6px; border: 1px solid var(--border); background: rgba(0, 0, 0, 0.25);
    }
    .msg-attach-img img { display: block; width: 100%; height: auto; cursor: zoom-in; }
    .msg-attach-img .msg-attach-cap {
      /* LEFT, like the image above it: the bubble centres its TEXT, and that must not
         leak into a caption sitting under a left-aligned preview. */
      text-align: left;
      font-size: var(--fs-sm); color: #d0d0d0; padding: 2px 6px; line-height: 1.3;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    /* Full-size image lightbox: click a thumbnail to view it large. */
    .img-lightbox { position: fixed; inset: 0; z-index: 1000; display: flex; align-items: center; justify-content: center; padding: 24px; background: rgba(0, 0, 0, 0.82); cursor: zoom-out; }
    .img-lightbox.hidden { display: none; }
    .img-lightbox-img { max-width: 92vw; max-height: 92vh; object-fit: contain; border-radius: 6px; box-shadow: 0 8px 40px rgba(0, 0, 0, 0.6); }
    /* Drag & drop affordance. */
    body.drag-over { outline: 2px dashed var(--accent); outline-offset: -6px; }
    .attach-size { color: var(--muted); }
    #input-area .attach-remove {
      height: 1.15rem; min-height: 0; min-width: 1.15rem; padding: 0;
      background: transparent; color: var(--muted); border: none; box-shadow: none;
      font-size: var(--fs-lg); line-height: 1;
    }
    #input-area .attach-remove:not(:disabled):hover { color: var(--error); filter: none; }

    /* Control-stack toggle (above the ask card): a centered chevron that is
       ALWAYS visible (orange accent) — clicking collapses/expands the Window
       + Sampling cards below (the rest of the controls stays visible). The
       stack is COLLAPSED by default.
       position:relative because this strip also HOSTS #collapse-all (right) and the
       insert-in hint (left): the strip
       sits outside #messages, which is the one scrolling element, so a tab
       anchored here stays put while the transcript scrolls. */
    #ctl-toggle {
      position: relative;
      display: flex; align-items: center; justify-content: center;
      height: 18px; margin: 8px 10px 0;
      cursor: pointer; user-select: none;
    }
    /* Transcript action pills ("Collapse all", "Follow"), right-aligned
       inside this strip. Flat pills, deliberately WITHOUT the 3D key chrome that
       the global button rule applies (accent fill, inset bevel, drop shadow), so
       they read as labels rather than actions.
       Right-aligned on purpose: the strip's center already belongs to the
       chevron and to #working-bar.
       They NEVER appear or disappear — only their disabled state changes — so
       the row can never reflow under the cursor. Disabled means "not applicable
       right now", not "broken": the pill stays put and the global
       button:disabled rule dims it to 0.3.
       Note: an unfilled pill would sink into the seam, which is --bg exactly like
       the transcript; --surface-2 is what makes them read. */
    #transcript-actions {
      position: absolute; right: 0; top: 0;
      display: flex; align-items: center; gap: 6px;
    }
    #transcript-actions > button {
      height: 18px; min-height: 0; padding: 0 10px;
      display: inline-flex; align-items: center;
      background: var(--surface-2); color: var(--muted);
      border: 1px solid var(--overlay-3);
      border-radius: 999px;
      box-shadow: none; filter: none;
      font-size: var(--fs-xs); font-weight: 600; line-height: 1; white-space: nowrap;
    }
    #transcript-actions > button:disabled { cursor: default; }
    #transcript-actions > button:not(:disabled):hover {
      color: var(--accent); border-color: var(--accent); background: var(--accent-surface);
      /* Kill the global button hover glow too: the pill must stay flat. */
      filter: none;
    }
    /* No dip, no bevel: the pill does not move when clicked. */
    #transcript-actions > button:not(:disabled):active { transform: none; box-shadow: none; }
    /* Insert-in hint: the LEFT slot of this same strip, mirroring #transcript-actions on
       the right. It replaces the old Queue/Steer pill that lived in the model row:
       "Insert prompt in Queue" / "Insert prompt in Steer". A pure INDICATOR — never clickable — so it
       is a plain span: no button chrome, no focus ring. Both states keep the word in a
       pill of the strip's own height, so the row cannot reflow when the word changes. */
    #insert-hint {
      position: absolute; left: 0; top: 0;
      display: inline-flex; align-items: center; gap: 5px;
      height: 18px; pointer-events: none;
      font-size: var(--fs-xs); color: var(--muted);
      white-space: nowrap; user-select: none;
    }
    /* The word itself, in a pill: neutral for Queue, muted red for Steer (the message is
       then injected into the running loop instead of waiting for it). */
    #insert-hint-word {
      display: inline-flex; align-items: center;
      height: 18px; padding: 0 8px; border-radius: 999px;
      background: var(--surface-2); border: 1px solid var(--overlay-3);
      color: var(--fg); font-weight: 600; line-height: 1;
      transition: background 0.18s, color 0.18s, border-color 0.18s, box-shadow 0.18s;
    }
    #insert-hint.is-steer #insert-hint-word {
      background: linear-gradient(135deg, var(--steer), var(--steer-strong));
      border-color: transparent; color: #ffffff;
      box-shadow: 0 1px 2px var(--key-shadow), 0 0 12px rgba(178, 59, 59, 0.45);
    }
    /* Idle (no run in flight): dimmed like the old disabled pill — the choice only means
       something while the agent is working. */
    #insert-hint.is-idle { opacity: 0.45; }
    #ctl-toggle-btn {
      background: transparent; border: none; color: var(--accent);
      padding: 3px 8px; cursor: pointer; display: inline-flex; align-items: center;
      transition: color 0.12s, transform 0.12s;
      box-shadow: none; filter: none; line-height: 0;
    }
    #ctl-toggle:hover #ctl-toggle-btn { color: var(--accent-strong); }
    #ctl-toggle-btn svg { transition: transform 0.15s; }
    body.controls-collapsed #ctl-toggle-btn svg { transform: rotate(180deg); }
    /* Collapsed: hide ONLY the Window + Sampling cards. The AI Model row, the
       ask card and the metrics row stay visible. #status wraps ONLY those
       cards now (the model row lives in the ask box), so an empty 16px padded
       box would double the gap to the metrics below — hide it and give the
       metrics a single normal 8px gap instead. */
    body.controls-collapsed #ctl-cards { display: none; }
    body.controls-collapsed #status { display: none; }
    body.controls-collapsed #metrics { margin-top: 8px; }
    /* No stack to toggle -> the strip disappears too. */
    body.no-session #ctl-toggle,
    body.no-workspace #ctl-toggle { display: none; }

    /* Symmetric padding (8px top/bottom) so the gap above and below the
       status block is identical — in the collapsed form the 3 visible cards
       (ask / AI Model / metrics) are then evenly spaced. */
    #status { display: flex; flex-direction: column; gap: 8px; padding: 8px 10px; font-size: var(--fs-md); min-height: 0; }
    #status .warn { color: var(--error); }
    .ctl-row { display: flex; align-items: center; gap: 6px; }
    /* Provider whose host model list failed to fetch: still VISIBLE in the
       dropdown (red) with the error, instead of silently disappearing. */
    #model-select optgroup.optgroup-failed {
      color: var(--error);
    }
    #model-select .option-error {
      color: var(--error);
    }
    /* Grouped cards: the grid collapses to a single column when the panel is
       narrow, so fields are never squeezed or split mid-pair. minmax is font-
       relative: on zoom-in the columns stack gracefully (responsive to both
       panel width and font size). */
    .ctl-cards {
      display: grid; grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px;
      /* Scrolls VERTICALLY only once it would take more than 75% of the panel
         height — and never more than what still leaves the prompt, model row
         and metrics their room, so the BOTTOM is the last thing to go. */
      max-height: clamp(6rem, calc(100vh - 20rem), 75vh);
      min-height: 0;
      overflow-y: auto;
      overflow-x: hidden;
      overscroll-behavior: contain;
      scrollbar-width: thin;
      scrollbar-color: var(--scroll-thumb) transparent;
    }
    .ctl-cards::-webkit-scrollbar { width: 8px; }
    .ctl-cards::-webkit-scrollbar-track { background: transparent; }
    .ctl-cards::-webkit-scrollbar-thumb { background: var(--scroll-thumb); border-radius: 4px; }
    .ctl-cards::-webkit-scrollbar-thumb:hover { background: var(--scroll-thumb-hover); }
    /* Narrow panel: stack the cards in ONE column, in DOM order (Window,
       Sampling, Parallel, Loop Guard), so nothing is squeezed or split
       mid-pair. The Loop Guard parameter fields collapse with it. */
    /* Static FALLBACK for the very first paint: the JS measures the nowrap
       sensitivity row and sets the exact column count right after. */
    @media (max-width: 30rem) {
      .ctl-cards { grid-template-columns: minmax(0, 1fr); }
      .lg-fields { grid-template-columns: minmax(0, 1fr); }
    }
    @media (min-width: 59rem) {
      .ctl-cards { grid-template-columns: repeat(4, minmax(0, 1fr)); }
      .lg-fields { grid-template-columns: minmax(0, 1fr); }
    }
    .ctl-card {
      display: flex; flex-direction: column; gap: 8px;
      border-radius: 8px; padding: 8px 10px;
      background: var(--input-bg);
    }
    /* The Guardrails card spans the full row (prompt width) instead of one grid
       column: it holds the per-session run controls (parallel cap + Loop Guard). */
    .ctl-card-wide { grid-column: 1 / -1; }
    /* Skills card: one clickable TEXT per installed skill (no button chrome);
       a click fills the prompt with "/skill <name> ". */
    #skills-list { display: flex; flex-wrap: wrap; gap: 4px 12px; }
    .skill-item {
      cursor: pointer; color: var(--accent); font-size: var(--fs-sm);
      max-width: 100%; overflow-wrap: anywhere;
    }
    .skill-item:hover { text-decoration: underline; }
    /* MCP card + editor modal (mirrors the providers editor). */
    #mcp-list { display: flex; flex-direction: column; gap: 3px; }
    .mcp-status { font-size: var(--fs-sm); }
    .mcp-status.ok { color: var(--ok); }
    .mcp-status.err { color: var(--error, #f05555); }
    .mcp-status .mcp-name { cursor: pointer; }
    .mcp-status .mcp-detail { color: var(--muted-2); }
    .mcp-tools-btn {
      background: transparent; border: none; padding: 0; cursor: pointer;
      color: var(--accent); font-size: var(--fs-sm); text-decoration: underline;
    }
    .mcp-tools-btn:hover { color: var(--accent-strong, var(--accent)); }
    /* Tool-list popover: a small floating card anchored to the (N tools) key. */
    #mcp-tools-popover {
      position: fixed; z-index: 60; max-width: min(30rem, 90vw); max-height: 60vh; overflow: auto;
      background: var(--bg, #1e1e1e); border: 1px solid var(--border); border-radius: 8px;
      padding: 8px 10px; box-shadow: 0 6px 24px var(--modal-shadow);
    }
    #mcp-tools-popover.hidden { display: none; }
    .mcp-pop-title { font-weight: 600; margin-bottom: 6px; }
    .mcp-pop-empty { color: var(--muted-2); font-size: var(--fs-sm); }
    .mcp-pop-item { padding: 4px 0; border-top: 1px solid var(--border); }
    .mcp-pop-item:first-of-type { border-top: none; }
    .mcp-pop-name { font-family: var(--font-mono); font-size: var(--fs-sm); color: var(--fg); }
    .mcp-pop-desc { font-size: var(--fs-sm); color: var(--muted-2); white-space: pre-wrap; overflow-wrap: anywhere; }
    /* Slash menu: skill autocomplete above the prompt. Only shown when the
       prompt STARTS with "/" and has no whitespace yet. */
    #slash-menu {
      position: fixed; z-index: 40; max-height: 40vh; overflow: auto;
      background: var(--bg, #1e1e1e); border: 1px solid var(--border); border-radius: 8px;
      padding: 4px; box-shadow: 0 6px 24px var(--modal-shadow);
    }
    #slash-menu.hidden { display: none; }
    .slash-item { display: flex; flex-direction: column; gap: 1px; padding: 5px 8px; border-radius: 6px; cursor: pointer; }
    .slash-item.active, .slash-item:hover { background: var(--overlay-1); }
    .slash-cmd { font-family: var(--font-mono); font-size: var(--fs-md); color: var(--fg); }
    .slash-desc { font-size: var(--fs-sm); color: var(--muted-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }
    /* Overlay geometry (viewport-locked fixed box, flex centring) comes from the
       shared modal block further down; only the stacking order lives here. */
    #mcp-modal { z-index: 50; }
    #mcp-modal.hidden { display: none; }
    .mcp-backdrop { background: var(--backdrop); }
    .mcp-card {
      position: relative; margin: auto;
      width: min(46rem, 100%); max-height: 100%; overflow: auto;
      background: var(--bg, #1e1e1e); border: 1px solid var(--border); border-radius: 10px; padding: 14px;
      display: flex; flex-direction: column; gap: 10px;
    }
    .mcp-head h3 { margin: 0 0 2px; }
    .mcp-hint { font-size: var(--fs-sm); color: var(--muted-2); }
    .mcp-body { display: flex; gap: 12px; align-items: flex-start; }
    .mcp-list-col { display: flex; flex-direction: column; gap: 6px; min-width: 11rem; }
    #mcp-select { min-height: 9rem; background: var(--input-bg); color: var(--fg); border: 1px solid var(--border); border-radius: 6px; padding: 4px; }
    .mcp-list-actions { display: flex; gap: 6px; }
    .mcp-form-col { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 8px; }
    .mcp-form-col input[type="text"], .mcp-form-col textarea { background: var(--input-bg); color: var(--fg); border: 1px solid var(--border); border-radius: 6px; padding: 4px 6px; font-size: var(--fs-md); }
    .mcp-form-col textarea { font-family: var(--font-mono); resize: vertical; }
    .mcp-form-actions { display: flex; align-items: center; gap: 8px; }
    .mcp-enabled-row { display: flex; align-items: center; gap: 6px; font-size: var(--fs-sm); color: var(--muted-2); cursor: pointer; }
    .mcp-enabled-row input { accent-color: var(--accent); }
    /* A disabled server is grayed out (name + detail). */
    .mcp-status.off, .mcp-status.off .mcp-name, .mcp-status.off .mcp-detail { color: var(--muted-3); }
    .mcp-io { font-size: var(--fs-sm); color: var(--muted-2); }
    .mcp-io.ok { color: var(--ok); }
    .mcp-io.err { color: var(--error, #f05555); }
    .mcp-actions { display: flex; justify-content: flex-end; gap: 8px; }
    body.no-session #mcp-card, body.no-workspace #mcp-card { display: none; }
    /* Numeric rows (Window + Sampling): a SLIDER plus a read-only value label.
       The label keeps the exact value; the slider is the control. */
    .num-row { display: flex; align-items: center; gap: 8px; min-width: 0; min-height: var(--ctl-row, 1.4rem); }
    .num-range { flex: 1 1 auto; min-width: 0; height: 14px; margin: 0; accent-color: var(--accent); cursor: pointer; }
    .num-value {
      flex: 0 0 auto; min-width: 3.6rem; text-align: right;
      font-size: var(--fs-xs); color: var(--fg); font-variant-numeric: tabular-nums;
    }
    .num-range:disabled { opacity: 0.5; cursor: default; }
    /* Loop Guard card: the sensitivity row wraps inside its half-width card. */
    /* The sensitivity row NEVER wraps: "Include response" always stays on the
       SAME line as the High/Normal/Low radios. */
    #lg-toggle { flex-wrap: nowrap; min-height: var(--ctl-row, 1.4rem); align-items: center; }
    #lg-toggle .sampler-opt { white-space: nowrap; }
    /* Loop Guard card: the parameters section collapses via the chevron, which
       sits on the SAME LINE as "Include response" (the last item of the
       sensitivity group). Collapsed by default, so the card — and its grid-row
       neighbour (Parallel) — stays at its minimum height. */
    #lg-params-field.hidden { display: none; }
    /* The head row = radios + chevron. The radios CANNOT wrap, so they may only
       shrink by clipping: min-width 0 + overflow hidden keep the chevron in
       place instead of letting the text push it out of the card. */
    .lg-head { display: flex; align-items: flex-end; gap: 8px; min-width: 0; }
    #lg-toggle { min-width: 0; overflow: hidden; }
    .lg-collapse {
      margin-left: auto; flex: 0 0 auto;
      background: transparent; border: none; padding: 1px; cursor: pointer;
      color: var(--muted); line-height: 0;
    }
    .lg-collapse:hover { color: var(--fg); }
    .lg-collapse svg { transition: transform 0.15s ease; }
    .lg-collapse[aria-expanded="true"] svg { transform: rotate(180deg); }
    /* Shared hover tooltip: a small floating card that explains a parameter.
       Positioned by the client; never intercepts the pointer. */
    .tip {
      position: fixed; z-index: 60; max-width: 21rem;
      background: var(--surface-2); color: var(--fg);
      border: 1px solid var(--overlay-2); border-radius: 6px;
      padding: 6px 8px; font-size: var(--fs-xs); line-height: 1.35;
      box-shadow: 0 6px 18px var(--key-shadow);
      pointer-events: none;
    }
    .tip.hidden { display: none; }
    /* The parameter name underlines on hover to advertise the tooltip. */
    .lg-name { cursor: help; }
    .lg-field:hover .lg-name { color: var(--fg); text-decoration: underline dotted; }
    /* Loop Guard FIELDS: the preset values exposed as editable sliders, SAVED
       per session (only the sensitivity level and these values are stored). */
    .lg-fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px 10px; }
    .lg-field {
      display: grid; grid-template-columns: 1fr auto; grid-template-areas: "name val" "range range";
      gap: 2px 6px; align-items: center; min-width: 0;
      font-size: var(--fs-xs); color: var(--muted-2);
    }
    .lg-name { grid-area: name; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    /* The value is a read-only LABEL (the slider is the only control). */
    .lg-value { grid-area: val; text-align: right; color: var(--fg); font-variant-numeric: tabular-nums; }
    .lg-range { grid-area: range; width: 100%; height: 14px; margin: 0; accent-color: var(--accent); cursor: pointer; }
    /* Loop Guard OFF: the parameter sliders are inert (they stay in place, with their
       values, so switching level never changes the card's height — the column-count
       measurement reads this row). Dim the whole block, labels included. */
    #lg-fields.is-off { opacity: 0.45; }
    .lg-field input:disabled { opacity: 0.5; cursor: default; }
    .ctl-inline { display: flex; align-items: center; gap: 8px; min-width: 0; }
    .ctl-inline input[type="checkbox"] {
      flex: 0 0 auto; width: 15px; height: 15px; accent-color: var(--accent); cursor: pointer;
    }
    /* The AI Model card keeps the ORIGINAL proportions: one full-width row
       with the label inline and the select stretching (card chrome only). */
    .ctl-card-model { flex-direction: row; align-items: center; gap: 8px; }
    /* Inside the prompt area the AI Model row drops the card chrome (the box
       is the input area itself) and becomes a plain head row above the prompt.
       The mode button lives HERE on the same line as the model select; the
       extra top margin opens breathing room below the prompt row above. */
    #input-area .ctl-card-model {
      background: transparent; border-radius: 0; padding: 0;
      gap: 8px;
      margin-top: 10px;
    }

    /* Mode select (Analyze / Agent): ONE compact pill button showing the
       current mode; clicking opens a small VERTICAL dropdown with the two
       choices. It sits on the AI Model row, next to the other controls, so it
       follows THEIR visual language — quiet dark pill, light-gray label, muted
       chevron — and carries the mode in the COLOUR OF ITS ICON (terracotta for
       Analyze, violet for Agent: the same pair the dropdown items use). A white
       icon + label on a saturated gradient made the row's quietest element
       shout loudest. The dropdown is anchored to the button (z-index keeps it
       above the cards). */
    #mode-select {
      position: relative;
      width: max-content;
      max-width: 100%;
      flex-shrink: 0;
      user-select: none;
    }
    #mode-btn {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      min-width: 0;
      height: 1.85rem;
      padding: 0 9px 0 8px;
      border: 1px solid var(--border);
      border-radius: 999px;
      background: var(--surface-2);
      color: var(--fg);
      font-size: var(--fs-sm);
      font-weight: 600;
      letter-spacing: 0.01em;
      cursor: pointer;
      white-space: nowrap;
      box-shadow: inset 0 1px 2px var(--sink-1);
      transition: background 0.18s, box-shadow 0.18s, color 0.18s, border-color 0.18s, transform 0.12s, opacity 0.18s;
    }
    #mode-btn:hover { border-color: var(--overlay-4); color: var(--fg-strong); }
    #mode-btn:active { transform: scale(0.96); }
    #mode-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    #mode-btn:disabled { opacity: 0.45; cursor: default; transform: none; box-shadow: none; }
    /* NO colour carries the mode in ANALYZE (the quiet default): both icons are the
       muted gray of the other pills on this row, and the LABEL is what says which mode
       you are in. BUILD is the loud one ON PURPOSE — see the .is-agent block below. */
    #mode-btn-icon-analyze, #mode-btn-icon-agent { flex-shrink: 0; color: var(--muted); transition: color 0.18s; }
    #mode-btn:hover #mode-btn-icon-analyze, #mode-btn:hover #mode-btn-icon-agent { color: var(--fg); }
    #mode-btn-icon-analyze.hidden, #mode-btn-icon-agent.hidden { display: none; }
    /* ONE width for BOTH modes: the longest label ("Analyze") is reserved by an in-flow,
       zero-height ghost, so switching mode can never move this pill — or the two that sit
       next to it. A flex item's base size IS the max-content of its content, so the ghost
       is all it takes; measuring at runtime would cost a layout on every switch and would
       still reflow on the way back. The string is the LONGEST of the two choices below. */
    #mode-btn-label::before {
      content: "Analyze";
      display: block; height: 0; visibility: hidden;
    }
    /* Chevron rotates when the dropdown is open. */
    #mode-btn .mode-btn-chevron { flex-shrink: 0; color: var(--muted); transition: color 0.18s, transform 0.18s; }
    #mode-btn:hover .mode-btn-chevron { color: var(--fg); }
    /* BUILD: one orange pill says "tools write for real" BEFORE you send anything.
       Analyze keeps the quiet gray above, so the contrast IS the signal — you never
       have to re-read the word to know which mode the next run uses. Same recipe as
       #parallel-btn.is-on (saturated gradient, white icon+label, soft glow). These
       rules must stay AFTER the neutral ones: #mode-btn:hover has the same
       specificity, so the ORDER is what makes the orange win on hover too. */
    #mode-btn.is-agent {
      background: linear-gradient(135deg, var(--accent), var(--accent-strong));
      border-color: transparent;
      color: #ffffff;
      box-shadow: 0 1px 2px var(--key-shadow), 0 0 12px var(--accent-glow);
    }
    #mode-btn.is-agent:hover {
      border-color: transparent; color: #ffffff;
      box-shadow: 0 1px 3px var(--key-shadow), 0 0 16px var(--accent-glow-strong);
    }
    #mode-btn.is-agent #mode-btn-icon-analyze,
    #mode-btn.is-agent #mode-btn-icon-agent,
    #mode-btn.is-agent .mode-btn-chevron { color: #ffffff; }
    /* The hover variants need their own rule: #mode-btn:hover #mode-btn-icon-agent
       counts TWO ids and would repaint the icon gray on top of the white. */
    #mode-btn.is-agent:hover #mode-btn-icon-analyze,
    #mode-btn.is-agent:hover #mode-btn-icon-agent,
    #mode-btn.is-agent:hover .mode-btn-chevron { color: #ffffff; }
    /* A policy changed under the panel keeps its dashed edge — a transparent border
       would swallow it (same fix as #parallel-btn.is-on.is-pending). */
    #mode-btn.is-agent.is-pending { border-style: dashed; border-color: rgba(255, 255, 255, 0.6); }
    #mode-select.open #mode-btn .mode-btn-chevron { transform: rotate(180deg); }
    /* The vertical dropdown: stacks the two choices under the button. */
    #mode-menu {
      position: absolute;
      top: calc(100% + 4px);
      left: 0;
      min-width: 100%;
      z-index: 40;
      display: flex;
      flex-direction: column;
      padding: 3px;
      border-radius: 10px;
      background: var(--surface-2);
      border: 1px solid var(--border);
      box-shadow: 0 8px 20px var(--modal-shadow);
    }
    #mode-menu.hidden { display: none; }
    .mode-item {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 5px 10px;
      border: none;
      border-radius: 7px;
      background: transparent;
      color: var(--fg);
      font-size: var(--fs-sm);
      font-weight: 600;
      cursor: pointer;
      text-align: left;
      white-space: nowrap;
      transition: background-color 0.1s, color 0.1s;
    }
    .mode-item:hover { background: var(--tool-bg); color: var(--fg-strong); }
    .mode-item:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
    .mode-item.is-active { color: var(--fg-strong); }
    /* The menu follows the button: NEUTRAL icons, and the accent marks only WHAT IS
       SELECTED (the checkmark) — never which mode it is. */
    .mode-item svg:not(.mode-check) { color: var(--muted); }
    .mode-item.is-active:not(:hover) { background: var(--overlay-1); }
    .mode-check { margin-left: 2px; flex-shrink: 0; visibility: hidden; }
    .mode-item.is-active .mode-check { visibility: visible; color: var(--accent); }

    /* Parallel toggle: press/release button right after the mode button.
       Released = quiet dark pill; PRESSED = blue with white icon + label. */
    #parallel-btn {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      height: 1.85rem;
      padding: 0 10px 0 8px;
      border: 1px solid var(--border);
      border-radius: 999px;
      background: var(--surface-2);
      color: var(--fg);
      font-size: var(--fs-sm);
      font-weight: 600;
      cursor: pointer;
      white-space: nowrap;
      flex-shrink: 0;
      box-shadow: inset 0 1px 2px var(--sink-1);
      transition: background 0.18s, box-shadow 0.18s, color 0.18s, border-color 0.18s, opacity 0.18s;
    }
    #parallel-btn svg { flex-shrink: 0; color: var(--muted); transition: color 0.18s; }
    #parallel-btn:hover { border-color: var(--overlay-4); color: var(--fg-strong); }
    #parallel-btn:hover svg { color: var(--fg); }
    #parallel-btn:focus-visible { outline: 2px solid #4c8dff; outline-offset: 2px; }
    #parallel-btn:disabled { opacity: 0.45; cursor: default; box-shadow: none; }
    /* A Mode/Parallel policy that changed UNDER the panel while a run works (a config push,
       another window): the pill is disabled — the run keeps the policy it was born with — so
       the choice is PENDING, and the dashed border with its tooltip says exactly that. */
    #mode-btn.is-pending, #parallel-btn.is-pending { border-style: dashed; }
    /* Parallel ON paints its border transparent, which would swallow the dashes. */
    #parallel-btn.is-on.is-pending { border-color: rgba(255, 255, 255, 0.55); }
    #parallel-btn.is-on {
      background: linear-gradient(135deg, #4c8dff, #2f6fed);
      border-color: transparent;
      color: #ffffff;
      box-shadow: 0 1px 2px var(--key-shadow), 0 0 12px rgba(76, 141, 255, 0.4);
    }
    #parallel-btn.is-on svg { color: #ffffff; }
    #parallel-btn.is-on:hover { box-shadow: 0 1px 3px var(--key-shadow), 0 0 16px rgba(76, 141, 255, 0.55); }

    .card-title {
      font-size: var(--fs-xs); font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase;
      color: var(--muted-3); user-select: none;
    }
    .field { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
    /* ONE control-row height for the whole control stack: label rows, slider
       rows and radio groups all share it, so the LEFT and RIGHT columns line up
       horizontally. Deliberately small, so nothing looks padded. */
    #ctl-cards { --ctl-row: 1.4rem; }
    #ctl-cards .field-label { display: flex; align-items: center; min-height: var(--ctl-row); }
    .field-label { font-size: var(--fs-sm); color: var(--muted-2); }
    /* "(min → max)" of the selected control, shown next to its label/radio. */
    .range-label { font-size: var(--fs-sm); color: var(--muted-2); font-weight: 400; }
    /* Working state: the PLAY (send) button blinks in sync with the chat's
       "Working..." bubble — same harny-pulse 1.2s animation, applied in the
       same tick (send/compactStart), so the two pulse together. */
    #send-btn.blinking { animation: harny-pulse 1.2s ease-in-out infinite; }
    /* Model selector: a BUTTON (not a native <select>) that opens the
       filterable "Select model" modal. */
    .model-btn {
      flex: 1; min-width: 0; display: inline-flex; align-items: center; gap: 6px;
      background: transparent; color: inherit; border: none; outline: none;
      font-size: var(--fs-md); cursor: pointer; height: 1.85rem; text-align: left;
    }
    .model-btn:disabled { opacity: 0.5; cursor: default; }
    .model-btn:hover:not(:disabled) #model-btn-label { color: var(--accent); }
    #model-btn-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .model-btn.placeholder #model-btn-label { color: var(--muted); font-style: italic; }
    .model-btn .model-btn-chevron { flex: none; color: var(--muted); }
    #thinking-select {
      width: 100%;
      background: var(--input-bg); color: var(--fg); border: 1px solid var(--border);
      border-radius: 6px; outline: none; font-size: var(--fs-md);
      cursor: pointer; padding: 0 6px; height: 1.85rem;
    }
    #thinking-select option { color: #1e1e1e; }
    #thinking-select:disabled { opacity: 0.45; cursor: default; }
    #status .model-label,
    #input-area .model-label { color: var(--muted-2); }
    /* The stepper fills its card field; the −/+ keys stay a tight unit inside. */
    #ctx-window, #out-window, #samp-window, #presence-window, #freq-window, #par-window { display: inline-flex; align-items: center; gap: 2px; width: 100%; }
    #ctx-input, #out-input, #samp-input, #presence-input, #freq-input, #par-input {
      flex: 1; min-width: 2.5rem; width: auto; height: 1.85rem; background: var(--input-bg); color: var(--fg);
      border: 1px solid var(--border); border-radius: 6px; padding: 1px 6px;
      font-size: var(--fs-md); text-align: right;
    }
    #ctx-input:focus, #out-input:focus, #samp-input:focus, #presence-input:focus, #freq-input:focus, #par-input:focus { border-color: var(--accent); outline: none; }
    /* Empty float input = Auto (not sent): neutral italic hint. */
    #samp-input::placeholder, #presence-input::placeholder, #freq-input::placeholder { color: var(--muted-3); font-style: italic; }
    /* Sampler selector: native radios on ONE slim row occupying the same
       slot/height as the other field labels (no pill, no box). */
    .sampler-toggle { display: inline-flex; align-items: center; gap: 8px; flex-wrap: wrap; row-gap: 4px; min-height: var(--ctl-row, 1.4rem); }
    .sampler-opt {
      display: inline-flex; align-items: center; gap: 4px;
      font-size: var(--fs-sm);
      color: var(--muted-2); cursor: pointer; user-select: none;
      transition: color 0.12s;
    }
    .sampler-opt input[type="radio"] {
      accent-color: var(--accent); margin: 0; width: 9px; height: 9px; cursor: pointer;
    }
    /* The Loop Guard "Include response" flag shares the sampler row styling. */
    .sampler-opt input[type="checkbox"] {
      accent-color: var(--accent); margin: 0; width: 11px; height: 11px; cursor: pointer;
    }
    .sampler-opt:hover { color: var(--fg); }
    .sampler-opt:has(input:checked) { color: var(--accent); font-weight: 600; }
    /* Metrics row: same font, label style and horizontal padding as the status
       row above, so "Tokens:" lines up with "AI Model:". */
    /* Usage footer: a full-width card matching the control cards above. */
    #metrics {
      display: flex; flex-direction: column; gap: 6px;
      border-radius: 8px; padding: 8px 10px;
      margin: 0 10px 8px; color: var(--muted-2);
      background: var(--input-bg);
    }
    .metrics-stats { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; font-size: var(--fs-sm); }
    .metrics-stats .model-label { color: var(--muted-2); }
    .metrics-stats .met { white-space: nowrap; }
    .met-sep { color: var(--muted-3); }
    #met-pct {
      padding: 0 6px; border: 1px solid var(--border); border-radius: 10px;
      background: var(--overlay-1);
    }
    #met-pct.warn { color: var(--error); border-color: var(--error); background: rgba(244, 71, 71, 0.1); }
    #met-cache { white-space: nowrap; color: var(--accent); }
    /* The declared window, HUGGING the usable value: "663.3k / 616k/1M (100%)".
       Both live inside ONE flex item (see the .met wrapper in the markup), so a
       narrow panel can never wrap them apart — "/1M" alone on a line would be
       meaningless. Dim and smaller than the value it qualifies: it explains the
       number, it must not compete with it. Hidden while empty, so a session with
       no reserve shows nothing at all. */
    .met-note { white-space: nowrap; color: var(--muted-3); font-size: var(--fs-sm); }
    #met-window:empty { display: none; }
    /* Placeholder state: provider does not report cached tokens. */
    #met-cache.idle { color: var(--muted); }
    /* The bar is the hero: a full-width row of its own. The Compact key lives
       in the stats row above, right after the cache indicator. */
    #ctx-bar-wrap {
      width: 100%; height: 8px; border-radius: 4px;
      background: var(--tool-bg); border: 1px solid var(--border); overflow: hidden;
      box-shadow: inset 0 1px 2px var(--sink-1);
    }
    #ctx-bar {
      height: 100%; width: 0%; border-radius: 4px; transition: width 0.3s;
      background-color: var(--accent);
      background-image: linear-gradient(to bottom, rgba(255, 255, 255, 0.28), rgba(255, 255, 255, 0) 55%);
    }
    #ctx-bar.warn { background-color: var(--error); }
    /* Compact: a compact action key, inline after the cache indicator but
       pushed to the right edge of the stats row. */
    #compact-btn {
      flex: 0 0 auto; width: auto; white-space: nowrap; margin-left: auto;
      background: linear-gradient(to bottom, var(--overlay-2), var(--overlay-1)),
        var(--tool-bg, transparent);
      border: 1px solid var(--border); color: var(--fg);
      border-radius: 6px; padding: 4px 8px; font-size: var(--fs-sm); cursor: pointer;
      box-shadow:
        inset 0 1px 0 var(--overlay-3),
        inset 0 -1px 0 var(--sink-1),
        0 1px 2px var(--key-shadow);
      transition: color 0.12s, border-color 0.12s, box-shadow 0.12s, transform 0.08s;
    }
    #compact-btn:hover:not(:disabled) { color: var(--accent); }
    #compact-btn:active:not(:disabled) {
      transform: translateY(1px);
      box-shadow: inset 0 1px 3px var(--key-shadow);
    }
    /* The gear keys are styled by the shared .gear-btn rule (same graphic and
       size everywhere) — see below. */
    #compact-threshold-label {
      flex: 0 0 auto; white-space: nowrap;
      font-size: var(--fs-sm); color: var(--muted-2);
    }
    #compact-btn:disabled { opacity: 0.4; }

    /* Empty shell (no open session): hide the whole control stack and show a
       hero that pushes the user to pick a session or create a new one. */
    body.no-session #input-area,
    body.no-session #status,
    body.no-session #pending-section,
    body.no-session #metrics { display: none; }
    /* No (single) workspace: sessions/tabs/controls are all hidden; the foldes
       hero asks the user to open one folder. Takes precedence over no-session. */
    body.no-workspace #sessions-card,
    body.no-workspace #tabs,
    body.no-workspace #input-area,
    body.no-workspace #status,
    body.no-workspace #pending-section,
    body.no-workspace #metrics { display: none; }
    /* Point the eye up at the sessions list: the second path to act. */
    body.no-session #session-head { color: var(--accent); }
    .empty-hero {
      flex: 1; display: flex; flex-direction: column; align-items: center;
      justify-content: center; gap: 8px; padding: 24px; text-align: center;
      color: var(--muted-2);
    }
    .empty-hero .empty-icon { font-size: var(--fs-hero); }
    /* Brand mark in place of the emoji, loaded from media/icon.svg (see
       state.logoUri): the artwork lives in ONE file, no inlined duplicate.
       An <img> can't inherit currentColor, so it shows the SVG's own colors. */
    .empty-hero .empty-logo img { width: var(--fs-logo); height: var(--fs-logo); display: block; }
    .empty-hero .empty-logo:hover img { opacity: 0.85; }
    .empty-hero h2 { margin: 0; font-size: var(--fs-xl); color: var(--fg-strong); font-weight: 700; }
    .empty-hero .empty-version { font-size: var(--fs-sm); color: var(--muted); margin-top: -2px; }
    /* Publisher credit. VS Code opens http(s) webview links in the system
       browser itself, so this needs no message plumbing (verified in
       workbench.desktop.main.js: onDidClickLink -> openerService.open). */
    .empty-hero .empty-version a.brand-link { color: inherit; text-decoration: none; }
    .empty-hero .empty-version a.brand-link:hover { color: var(--accent); text-decoration: underline; }
    .empty-hero p { margin: 0; font-size: var(--fs-md); line-height: 1.5; }
    .empty-hero .empty-hint { font-size: var(--fs-sm); }
    .empty-hero .empty-cta { margin-top: 12px; padding: 6px 20px; font-size: var(--fs-lg); border-radius: 6px; }
    @keyframes harny-empty-in {
      from { opacity: 0; transform: translateY(6px); }
      to { opacity: 1; transform: none; }
    }
    body.no-session .empty-hero { animation: harny-empty-in 0.25s ease-out; }
    .ctx-btn {
      width: 1.38rem; height: 1.38rem; padding: 0; font-size: var(--fs-lg); line-height: 1;
      background: linear-gradient(to bottom, var(--overlay-3), var(--overlay-1)),
        var(--tool-bg, transparent);
      border: 1px solid var(--border); color: var(--fg); border-radius: 4px;
      display: inline-flex; align-items: center; justify-content: center; cursor: pointer;
      box-shadow:
        inset 0 1px 0 var(--overlay-3),
        inset 0 -1px 0 var(--sink-1),
        0 1px 2px var(--key-shadow);
    }
    .ctx-btn:hover:not(:disabled) { color: var(--accent); }
    .ctx-btn:active:not(:disabled) {
      transform: translateY(1px);
      box-shadow: inset 0 1px 3px var(--key-shadow);
    }
    /* ONE gear action across the cards (sessions head, model row, compaction
       metrics): identical graphic and size everywhere — a bare, muted icon
       (14×14 SVG) that turns accent on hover. The #session-head .gear-btn
       selector beats the header's accent-colored button rule by specificity. */
    .gear-btn, #session-head .gear-btn {
      flex: 0 0 auto; display: inline-flex; align-items: center; justify-content: center;
      width: 1.6rem; height: 1.6rem; padding: 0;
      background: transparent; border: none; border-radius: 4px;
      color: var(--muted); font-size: inherit; line-height: 1; cursor: pointer;
      transition: color 0.12s, background-color 0.12s;
    }
    .gear-btn:hover:not(:disabled), #session-head .gear-btn:hover:not(:disabled) {
      color: var(--accent); background: var(--overlay-1);
    }
    .gear-btn:disabled, #session-head .gear-btn:disabled { opacity: 0.5; cursor: default; }
    /* Providers & Models modal (gear editor). */
    #providers-modal { z-index: 50; }
    #providers-modal.hidden { display: none; }
    #providers-modal .providers-backdrop { background: var(--backdrop); }
    #providers-modal .providers-card {
      position: relative; margin: auto;
      width: min(700px, 100%); max-height: 100%;
      background: var(--bg, #1e1e1e); border: 1px solid var(--border);
      border-radius: 12px; padding: 18px 20px; display: flex; flex-direction: column;
      gap: 12px; box-shadow: 0 8px 30px var(--modal-shadow);
      font-size: var(--fs-lg);
    }
    #providers-modal h3 { margin: 0; font-size: var(--fs-xl); font-weight: 700; color: var(--fg-strong); }
    .providers-head { display: flex; flex-direction: column; gap: 4px; }
    .providers-hint { font-size: var(--fs-sm); color: var(--muted); }
    .providers-body {
      display: grid; grid-template-columns: 190px 1fr; gap: 16px; min-height: 0;
      flex: 1;
    }
    .provider-list-col { display: flex; flex-direction: column; gap: 8px; min-height: 0; }
    .provider-list-head { display: flex; align-items: center; justify-content: space-between; font-size: var(--fs-sm); color: var(--muted-2); }
    #provider-select {
      width: 100%; flex: 1; min-height: 160px; background: var(--input-bg, #252526);
      border: 1px solid var(--border); border-radius: 6px; color: var(--fg); font-size: var(--fs-lg);
      padding: 2px;
    }
    #provider-select option { padding: 3px 6px; }
    #provider-select option:checked { background: var(--accent, #3794ff); color: #fff; }
    .provider-form-col { display: flex; flex-direction: column; gap: 10px; min-width: 0; overflow-y: auto; }
    .provider-form-col .field-label { font-size: var(--fs-md); }
    /* API key: masked by default; the eye reveals it ONLY while held down. */
    .pe-secret { position: relative; display: flex; align-items: center; }
    .pe-secret input { flex: 1; padding-right: 2.2rem; }
    .pe-secret .pe-eye {
      position: absolute; right: 4px; top: 50%; transform: translateY(-50%);
      display: inline-flex; align-items: center; justify-content: center;
      width: 1.6rem; height: 1.6rem; min-height: 0; padding: 0;
      background: transparent; border: none; box-shadow: none; color: var(--muted); cursor: pointer;
    }
    .pe-secret .pe-eye:hover { color: var(--accent); filter: none; }
    .pe-secret .pe-eye:active { transform: translateY(-50%); box-shadow: none; filter: none; }
    .provider-form-col input, .provider-form-col select {
      font-size: var(--fs-lg); padding: 5px 8px; border-radius: 5px;
      background: var(--input-bg, #252526); border: 1px solid var(--border); color: var(--fg);
    }
    .provider-actions { display: flex; flex-wrap: wrap; gap: 8px; }
    .provider-actions .danger { color: var(--error, #f05555); }
    .providers-actions { display: flex; justify-content: flex-end; gap: 10px; }
    .providers-actions button { font-size: var(--fs-lg); padding: 6px 14px; border-radius: 6px; }
    /* Import/export feedback: its OWN row UNDER the button strip. It used to be
       a span inside .providers-actions, where a long absolute path ("Imported
       from /Users/…/harny-providers.json") squeezed the buttons and shoved
       Cancel/Save sideways. Full width + wrapping, and no empty gap while it
       has nothing to say. */
    .providers-io { font-size: var(--fs-sm); color: var(--muted); overflow-wrap: anywhere; }
    .providers-io:empty { display: none; }
    .providers-io.ok { color: var(--ok); }
    .providers-io.err { color: var(--error, #f05555); }
    #provider-test-result {
      font-size: var(--fs-md); line-height: 1.5; border-radius: 6px; padding: 8px 10px;
      background: var(--overlay-1); word-break: break-all;
    }
    #provider-test-result.ok { color: var(--ok); }
    #provider-test-result.err { color: var(--error, #f05555); }

    /* The Auto reset is a SEPARATE key, clearly detached from the + spinner. */
    #samp-auto, #presence-auto, #freq-auto { margin-left: 6px; width: auto; padding: 0 0.5rem; }
    /* Hide the browser's native number spinners; we use our own − / + buttons. */
    #ctx-input::-webkit-outer-spin-button,
    #ctx-input::-webkit-inner-spin-button,
    #out-input::-webkit-outer-spin-button,
    #out-input::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
    #ctx-input, #out-input { -moz-appearance: textfield; }

    /* ── Modal forms: ONE geometry, shared by every dialog ──
       What these dialogs must do (Providers & Models, Select model, All
       sessions, MCP, Compact, name/confirm prompts): stay in the PANEL's
       coordinate space, not the viewport's. The panel has a width FLOOR (see
       the note at the top of this sheet): below it the window grows a
       horizontal bar instead of squeezing the controls. A dialog pinned to the
       viewport (position: fixed) does NOT know about that floor — it kept
       shrinking with the visible slice, so the Providers form got squeezed to
       a sliver while the panel below still laid out at its floor, and the card
       re-centred every time the bar appeared. The dialog is therefore laid out
       against the BODY (which IS the panel content, body being position:
       relative), with inset: 0: same width as the floor, same origin, and it
       scrolls away together with the rest of the panel when the horizontal bar
       is dragged — exactly like the content underneath it.
       Card centring: flex + margin: auto. The auto margins still centre, but
       they collapse to 0 when a card is taller than the screen, so its first
       field stays reachable instead of being clipped above the top edge;
       overflow: auto then scrolls the DIALOG, never the window. Backdrops stay
       FIXED: they must keep covering the visible slice while the dialog itself
       scrolls with the content. */
    #name-modal, #alert-modal, #compact-settings-modal, #providers-modal,
    #sessions-modal, #model-modal, #db-vacuum-modal, #mcp-modal {
      position: absolute; inset: 0;
      display: flex; align-items: center; justify-content: center;
      padding: 10px; overflow: auto; overscroll-behavior: contain;
    }
    #name-modal .name-modal-backdrop, #alert-modal .alert-backdrop,
    #compact-settings-modal .cs-backdrop, #providers-modal .providers-backdrop,
    #sessions-modal .sm-backdrop, #model-modal .mm-backdrop,
    #db-vacuum-modal .dv-backdrop, #mcp-modal .mcp-backdrop {
      position: fixed; inset: 0;
    }

    /* ── Session-name modal (in the Harny panel): full-area overlay, blurred ── */
    #name-modal { z-index: 100; }
    #name-modal.hidden { display: none; }
    #name-modal .name-modal-backdrop {
      background: var(--backdrop);
      backdrop-filter: blur(4px);
      -webkit-backdrop-filter: blur(4px);
    }
    #name-modal .name-modal-card {
      position: relative; margin: auto; max-height: 100%; overflow: auto;
      width: min(340px, 100%);
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 14px;
      box-shadow: 0 8px 30px var(--key-shadow);
      display: flex; flex-direction: column; gap: 10px;
    }
    #name-modal h3 { margin: 0; font-size: var(--fs-lg); font-weight: 700; color: var(--fg-strong); }
    #name-modal #name-input { width: 100%; margin-top: 8px; box-sizing: border-box; }
    #name-modal #name-error {
      margin-top: 6px; min-height: 1em; font-size: var(--fs-sm);
      color: var(--error); word-wrap: break-word;
    }
    #name-modal #name-error:empty { display: none; }
    #name-input {
      width: 100%; background: var(--input-bg); color: var(--fg);
      border: 1px solid var(--border); border-radius: 6px; padding: 6px 8px;
      font-size: var(--fs-lg); outline: none; box-sizing: border-box;
    }
    #name-input:focus { border-color: var(--accent); }
    #name-modal .name-modal-actions { display: flex; justify-content: flex-end; gap: 8px; }

    /* ── Compaction policy (gear after Compact): trigger % + landing point ── */
    #compact-settings-modal { z-index: 100; }
    #compact-settings-modal.hidden { display: none; }
    #compact-settings-modal .cs-backdrop {
      background: var(--backdrop);
      backdrop-filter: blur(4px);
      -webkit-backdrop-filter: blur(4px);
    }
    #compact-settings-modal .cs-card {
      position: relative; margin: auto; max-height: 100%; overflow: auto;
      width: min(420px, 100%);
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 14px;
      box-shadow: 0 8px 30px var(--key-shadow);
      display: flex; flex-direction: column; gap: 10px;
    }
    #compact-settings-modal h3 { margin: 0; font-size: var(--fs-lg); font-weight: 700; color: var(--fg-strong); }
    #compact-settings-modal .cs-hint {
      margin: 0; font-size: var(--fs-sm); color: var(--muted-2); line-height: 1.45;
    }
    #compact-settings-modal .cs-field { display: flex; flex-direction: column; gap: 6px; }
    #compact-settings-modal .cs-field label { font-size: var(--fs-sm); color: var(--muted-2); }
    /* Both knobs are SLIDERS. The landing one has 0 as its leftmost notch, which MEANS
       AUTO, so the derived default and the explicit values share one control. */
    #compact-settings-modal .cs-inline { display: flex; align-items: center; gap: 8px; }
    #compact-settings-modal .cs-inline input[type="range"] {
      flex: 1 1 auto; min-width: 0; width: 100%; accent-color: var(--accent);
    }
    #compact-settings-modal .cs-val {
      flex: 0 0 auto; min-width: 4.5em; text-align: right;
      font-size: var(--fs-sm); color: var(--fg); font-variant-numeric: tabular-nums;
    }
    #compact-settings-modal .cs-mini { flex: 0 0 auto; padding: 2px 8px; font-size: var(--fs-sm); }
    /* Auto is ON = the landing point is the derived default (highlighted, never hidden). */
    #compact-settings-modal .cs-mini.is-on { border-color: var(--accent); color: var(--accent); }
    #compact-settings-modal .cs-scope {
      margin-left: 6px; font-size: var(--fs-sm); font-weight: 400; color: var(--muted-2);
    }
    /* The plan, as the host computes it: multi-line, never a layout jump. */
    #compact-settings-modal .cs-preview {
      margin: 0; padding: 8px;
      background: var(--input-bg); border: 1px solid var(--border); border-radius: 6px;
      color: var(--muted-2); font-size: var(--fs-sm); line-height: 1.45;
      white-space: pre-line; min-height: 1em; overflow-wrap: anywhere;
    }
    #compact-settings-modal .cs-actions { display: flex; justify-content: flex-end; gap: 8px; }

    /* ── In-panel alert / confirm modal (same family as the name modal) ── */
    #alert-modal { z-index: 110; }
    #alert-modal.hidden { display: none; }
    #alert-modal .alert-backdrop {
      background: var(--backdrop);
      backdrop-filter: blur(4px);
      -webkit-backdrop-filter: blur(4px);
    }
    #alert-modal .alert-card {
      position: relative; margin: auto; max-height: 100%; overflow: auto;
      width: min(340px, 100%);
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 14px;
      box-shadow: 0 8px 30px var(--key-shadow);
      display: flex; flex-direction: column; gap: 10px;
    }
    #alert-modal h3 { margin: 0; font-size: var(--fs-lg); font-weight: 700; color: var(--fg-strong); }
    #alert-modal .alert-message {
      font-size: var(--fs-md); color: var(--fg-dim); line-height: 1.5;
      word-wrap: break-word; white-space: pre-wrap;
    }
    #alert-modal .alert-actions { display: flex; justify-content: flex-end; gap: 8px; }
    #alert-ok.danger { background: var(--error); }

    /* ── All-sessions manager (gear next to New session ──
       Lists sessions of EVERY folder, most recent first. Red rows = the
       session's folder is no longer available (open disabled until a valid
       folder is picked). */
    #sessions-modal { z-index: 60; }
    #sessions-modal.hidden { display: none; }
    #sessions-modal .sm-backdrop { background: var(--backdrop); }
    #sessions-modal .sm-card {
      position: relative; margin: auto;
      width: min(680px, 100%); max-height: 100%;
      background: var(--bg, #1e1e1e); border: 1px solid var(--border);
      border-radius: 12px; padding: 18px 20px; display: flex; flex-direction: column;
      gap: 12px; box-shadow: 0 8px 30px var(--modal-shadow); font-size: var(--fs-lg);
    }
    #sessions-modal h3 { margin: 0; font-size: var(--fs-xl); font-weight: 700; color: var(--fg-strong); }
    #sessions-modal .sm-hint { font-size: var(--fs-sm); color: var(--muted); }
    #sessions-manager-list {
      display: flex; flex-direction: column; gap: 6px;
      overflow-y: auto; min-height: 140px; flex: 1;
    }
    .sm-row {
      display: flex; align-items: center; gap: 10px;
      padding: 8px 10px; border-radius: 8px; background: var(--input-bg);
      border: 1px solid var(--border);
    }
    .sm-row .sm-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
    .sm-row .sm-name {
      display: flex; align-items: center; gap: 6px; font-weight: 600;
      font-size: var(--fs-lg); color: var(--fg-strong); min-width: 0;
    }
    .sm-row .sm-name > span:first-child {
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .sm-row .sm-tag {
      flex: none; font-size: var(--fs-xs); color: var(--accent);
      border: 1px solid var(--border); border-radius: 8px; padding: 1px 6px;
    }
    .sm-row .sm-meta { font-size: var(--fs-sm); color: var(--muted); }
    .sm-row .sm-folder {
      font-size: var(--fs-sm); color: var(--muted-3);
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0;
      cursor: default;
    }
    .sm-row .sm-folder.missing { color: var(--error); }
    /* Unknown (not set) folder is NEUTRAL, not red: only a KNOWN path that is
       no longer available is a problem (red). */
    .sm-row .sm-folder.unset { color: var(--muted-2); font-style: italic; }
    .sm-actions { display: inline-flex; gap: 6px; flex-shrink: 0; }
    .sm-actions button { min-height: 1.54rem; font-size: var(--fs-md); }
    .sm-actions button.secondary-ghost {
      background: transparent; border: 1px solid var(--border); color: var(--fg);
    }
    .sm-actions button:disabled { opacity: 0.3; cursor: default; }
    #sessions-modal .sm-footer { display: flex; justify-content: flex-end; }
    /* DB compaction controls in the All-sessions modal footer. */
    .sm-vacuum {
      display: flex; flex-direction: column; gap: 8px;
      border-top: 1px solid var(--border); padding-top: 10px;
    }
    .sm-vacuum-head { display: flex; align-items: center; gap: 6px; font-size: var(--fs-sm); color: var(--muted); }
    .sm-vacuum-head .spacer { flex: 1; }
    /* The one card in a modal whose settings are LIVE: say so, because every other card
       commits on Save (and its dialog says Close, not Cancel). */
    .sm-vacuum-live {
      font-size: var(--fs-xs); font-weight: 600; line-height: 1;
      padding: 2px 6px; border-radius: 999px;
      color: var(--accent); background: var(--accent-tint-soft);
      border: 1px solid var(--accent-line);
      white-space: nowrap;
    }
    .sm-vacuum-slider {
      display: grid; grid-template-columns: 8.5rem 1fr 4.5rem; align-items: center; gap: 8px;
      font-size: var(--fs-sm); color: var(--muted);
    }
    .sm-vacuum-slider input[type="range"] { width: 100%; accent-color: var(--accent); }
    .sm-vacuum-val { text-align: right; font-variant-numeric: tabular-nums; color: var(--fg); }
    .sm-vacuum-stats { font-size: var(--fs-sm); color: var(--muted); font-variant-numeric: tabular-nums; }
    .sm-vacuum-stats b { color: var(--fg); }
    .sm-vacuum-stats .warn { color: var(--accent); }
    /* Shared "compact database" modal (auto suggestion OR manual button). */
    #db-vacuum-modal { z-index: 70; }
    #db-vacuum-modal.hidden { display: none; }
    #db-vacuum-modal .dv-backdrop { background: var(--backdrop); }
    #db-vacuum-modal .dv-card {
      position: relative; margin: auto; max-height: 100%; overflow: auto;
      width: min(520px, 100%);
      background: var(--bg, #1e1e1e); border: 1px solid var(--border);
      border-radius: 12px; padding: 18px 20px; display: flex; flex-direction: column;
      gap: 12px; box-shadow: 0 8px 30px var(--modal-shadow); font-size: var(--fs-lg);
    }
    #db-vacuum-modal h3 { margin: 0; font-size: var(--fs-xl); font-weight: 700; color: var(--fg-strong); }
    #db-vacuum-modal .sm-hint { font-size: var(--fs-sm); color: var(--muted); }
    .db-vacuum-stats {
      display: flex; flex-direction: column; gap: 4px;
      background: var(--input-bg); border: 1px solid var(--border);
      border-radius: 8px; padding: 10px 12px;
      font-size: var(--fs-sm); color: var(--muted); font-variant-numeric: tabular-nums;
    }
    .db-vacuum-stats b { color: var(--fg); }
    .db-vacuum-stats .warn { color: var(--accent); }
    .dv-footer { display: flex; justify-content: flex-end; gap: 8px; }
    /* Full-text search field above the list: filters to sessions whose MESSAGES
       contain the term/phrase (FTS5 on the host). */
    #sessions-modal .sm-search { display: flex; }
    /* Both search fields (main sessions list + all-sessions modal) share a look. */
    #sessions-search, #session-search {
      width: 100%; background: var(--surface-2); color: var(--fg);
      border: 1px solid var(--border); border-radius: 6px; padding: 6px 8px;
      font-size: var(--fs-lg); outline: none;
    }
    #sessions-search:focus, #session-search:focus { border-color: var(--accent); }
    /* Main sessions list: the search sits between the header and the list. */
    #session-search-row { padding: 0 8px 6px; }
    #session-search-row.hidden { display: none; }
    /* Per-row match excerpt: the matched terms are wrapped in [...] by FTS5 and
       rendered in the accent color. */
    .sm-row .sm-snippet { font-size: var(--fs-sm); color: var(--muted-2); overflow-wrap: anywhere; }
    .sm-row .sm-snippet b { color: var(--accent); font-weight: 600; }
    .sm-empty { padding: 18px; text-align: center; color: var(--muted); font-size: var(--fs-lg); }
    /* Main sessions list: no-match hint. */
    #sessions .empty.no-match { font-style: italic; }

    /* ── "Select model" modal (filterable, provider tree preserved) ── */
    #model-modal { z-index: 70; }
    #model-modal.hidden { display: none; }
    #model-modal .mm-backdrop { background: var(--backdrop); }
    #model-modal .mm-card {
      position: relative; margin: auto;
      width: min(560px, 100%); max-height: 100%;
      background: var(--bg, #1e1e1e); border: 1px solid var(--border);
      border-radius: 12px; padding: 16px 18px; display: flex; flex-direction: column; gap: 10px;
      box-shadow: 0 8px 30px var(--modal-shadow); font-size: var(--fs-lg);
    }
    #model-modal .mm-head { display: flex; align-items: center; justify-content: space-between; }
    #model-modal .mm-footer { display: flex; justify-content: flex-end; }
    #model-modal h3 { margin: 0; font-size: var(--fs-xl); font-weight: 700; color: var(--fg-strong); }
    #model-modal .mm-search { display: flex; }
    /* Discreet warning: the models.dev fallback is unreachable and some model is
       missing a limit (the alert is NOT a modal — it is a soft fallback miss). */
    .mm-warn { font-size: var(--fs-sm); color: var(--warn-soft); line-height: 1.35; }
    .mm-warn.hidden { display: none; }
    .warn-badge { color: var(--warn-soft); font-size: var(--fs-sm); margin-left: 2px; }
    .warn-badge.hidden { display: none; }
    #model-search {
      width: 100%; background: var(--surface-2); color: var(--fg);
      border: 1px solid var(--border); border-radius: 6px; padding: 6px 8px;
      font-size: var(--fs-lg); outline: none;
    }
    #model-search:focus { border-color: var(--accent); }
    #model-list { display: grid; grid-template-columns: 1fr max-content max-content max-content 1.1rem; column-gap: 6px; row-gap: 5px; align-items: center; align-content: start; overflow-y: auto; min-height: 160px; flex: 1; }
    /* Full-width items: the provider header + any single-row message spans every
       column (only the model rows participate in the value columns). */
    #model-list .mm-provider, #model-list .mm-error, #model-list .mm-empty { grid-column: 1 / -1; }
    /* Provider header: the tree is PRESERVED when filtering (only matching
       models remain, empty providers drop out). */
    .mm-provider {
      display: flex; align-items: center; gap: 6px; margin-top: 6px; padding: 2px 4px;
      font-size: var(--fs-sm); font-weight: 700; letter-spacing: 0.03em; text-transform: uppercase;
      color: var(--muted); position: sticky; top: 0; background: var(--bg, #1e1e1e);
    }
    .mm-provider .mm-count { font-weight: 500; color: var(--muted-3); text-transform: none; }
    /* Plain list rows: cancel the global "key" chrome (bevel/shadow/press).
       Hover just lightens the background. Id-prefixed so it beats the
       button:not(:disabled):hover filter. */
    #model-list .mm-model {
      /* SUBGRID: the row spans the list's columns, so the context / "out" /
         value columns share ONE width across rows (the widest value) while the
         row keeps its own box (padding, hover, radius). */
      grid-column: 1 / -1;
      display: grid; grid-template-columns: subgrid; column-gap: 6px; align-items: center;
      width: 100%; text-align: left;
      padding: 9px 12px 9px 18px; border-radius: 8px; min-height: 0;
      box-shadow: none;
      background: transparent; border: 1px solid transparent; color: var(--fg);
      cursor: pointer; font-size: var(--fs-lg);
      transition: background-color 0.12s;
    }
    #model-list .mm-model:hover { background: var(--surface-2); filter: none; transform: none; }
    #model-list .mm-model:active { transform: none; box-shadow: none; filter: none; }
    #model-list .mm-model:focus { outline: none; border-color: var(--accent); background: var(--surface-2); }
    /* The current model: a light accent tint so it reads as "selected". */
    #model-list .mm-model.is-current { background: var(--accent-tint); }
    #model-list .mm-model.is-current:hover { background: var(--accent-tint-strong); }
    .mm-model .mm-model-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .mm-model .mm-ctx { font-size: var(--fs-sm); color: var(--muted); text-align: right; font-variant-numeric: tabular-nums; }
    .mm-model .mm-out-label { text-align: right; }
    .mm-model.is-current { color: var(--accent); font-weight: 600; }
    .mm-model .mm-check { color: var(--accent); text-align: center; }
    .mm-error { padding: 4px 8px 4px 20px; font-size: var(--fs-sm); color: var(--error); }
    .mm-empty { padding: 18px; text-align: center; color: var(--muted); font-size: var(--fs-lg); }
  </style>
</head>
<body class="controls-collapsed${themeClass}">
  <div id="sessions-card" class="sessions-card">
    <div id="session-head">
      <span class="toggle">▼</span><span>Sessions</span>
      <span class="spacer"></span>
      <button id="new-session" title="New session"><svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" fill="none"/></svg></button>
      <button id="sessions-gear-btn" class="gear-btn" title="Manage all sessions (every folder)"><svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><path d="M19.4 13a7.6 7.6 0 0 0 .1-1 7.6 7.6 0 0 0-.1-1l2.1-1.7a.5.5 0 0 0 .1-.7l-2-3.5a.5.5 0 0 0-.6-.2l-2.5 1a7.6 7.6 0 0 0-1.7-1L14.5 2.4a.5.5 0 0 0-.5-.4h-4a.5.5 0 0 0-.5.4l-.4 2.5a7.6 7.6 0 0 0-1.7 1l-2.5-1a.5.5 0 0 0-.6.2l-2 3.5a.5.5 0 0 0 .1.7L4.5 11a7.6 7.6 0 0 0-.1 1 7.6 7.6 0 0 0 .1 1l-2.1 1.7a.5.5 0 0 0-.1.7l2 3.5a.5.5 0 0 0 .6.2l2.5-1a7.6 7.6 0 0 0 1.7 1l.4 2.5a.5.5 0 0 0 .5.4h4a.5.5 0 0 0 .5-.4l.4-2.5a7.6 7.6 0 0 0 1.7-1l2.5 1a.5.5 0 0 0 .6-.2l2-3.5a.5.5 0 0 0-.1-.7zM12 15.5A3.5 3.5 0 1 1 12 8.5a3.5 3.5 0 0 1 0 7z" fill="currentColor"/></svg></button>
    </div>
    <div id="session-search-row">
      <input id="session-search" type="search" placeholder="Search sessions" spellcheck="false" autocomplete="off" aria-label="Search sessions" />
    </div>
    <div id="sessions"></div>
  </div>
  <div id="tabs"></div>
  <div id="messages"></div>
  <!-- Messages typed while the session works (queue/steer): a real footer,
       outside #messages, so they survive streaming re-renders. A COLLAPSIBLE
       section like the sessions list: the header carries the counts, so a
       collapsed section still says what is waiting. -->
  <div id="pending-section" class="hidden">
    <div id="pending-head" role="button" tabindex="0" aria-expanded="true" title="Messages typed while the session works">
      <span class="toggle">▼</span><span id="pending-head-text"></span>
    </div>
    <div id="pending-area" class="hidden"></div>
  </div>
  <!-- Working indicator: the BOTTOM-most footer, always BELOW the transcript
       and the pending bubbles. -->
  <div id="working-bar" class="hidden">● Working...</div>
  <!-- Control stack toggle: a slim hover-hot strip just above the ask card.
       On hover a chevron appears; clicking collapses/expands the Window +
       Sampling cards (#ctl-cards) while the ask card (with the AI Model row
       at its head) and the metrics stay visible. -->
  <div id="ctl-toggle" title="Toggle the controls below" aria-expanded="false">
    <!-- Insert-in hint: replaces the old Queue/Steer pill. Same height and same
         side of the strip as "Collapse all"/"Follow", but on the LEFT. It is a
         pure INDICATOR (never clickable): "Queue" by default, "Steer" (red pill)
         ONLY while a run is active AND Ctrl/Cmd is held — exactly the rule the
         old pill followed, so the keyboard gesture is unchanged. -->
    <span id="insert-hint" title="Queue: the next message runs after the current run ends">Insert prompt in <span id="insert-hint-word">Queue</span></span>
    <button id="ctl-toggle-btn" aria-label="Toggle controls">
      <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>
    </button>
    <div id="transcript-actions">
      <button id="collapse-all" type="button" disabled title="Collapse every expanded section (thinking, tool calls, sub-agents)">Collapse all</button>
      <button id="autoscroll" type="button" disabled title="Jump to the latest message and follow the stream">Follow</button>
    </div>
  </div>
  <div id="input-area">
    <div id="input-main">
      <button id="attach-btn" class="secondary" title="Attach files" aria-label="Attach files"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg></button>
      <textarea id="user-input" rows="1" placeholder="Ask Harny... (Enter to send, Esc to abort)"></textarea>
      <button id="send-btn" aria-label="Send"><svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z" fill="currentColor"/></svg></button>
      <button id="abort-btn" class="secondary" disabled aria-label="Abort"><svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/></svg></button>
    </div>
    <!-- AI Model row: the mode select (Analyze/Agent) sits on the SAME
         horizontal line as the label, model select and gear button. The
         dropdown anchors to the button and overlays the cards below. -->
    <div class="ctl-card ctl-card-model">
      <div id="mode-select"
           title="Analyze: read-only · Build: full tool use (create, modify, run)">
        <button type="button" id="mode-btn" aria-haspopup="listbox" aria-expanded="false"
                aria-label="Mode">
          <svg id="mode-btn-icon-analyze" width="12" height="12" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/><path d="M20 20l-4.3-4.3" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/></svg>
          <svg id="mode-btn-icon-agent" class="hidden" width="12" height="12" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="none"/><path d="M19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>
          <span id="mode-btn-label">Analyze</span>
          <svg class="mode-btn-chevron" width="10" height="10" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>
        </button>
        <div id="mode-menu" class="hidden" role="listbox" aria-label="Mode">
          <button type="button" class="mode-item is-active" data-mode="analyze" role="option" aria-selected="true"
                  title="Analyze: read-only — inspects but never modifies files">
            <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/><path d="M20 20l-4.3-4.3" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/></svg>
            <span>Analyze</span>
            <svg class="mode-check" width="12" height="12" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12l4.5 4.5L19 7.5" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>
          </button>
          <button type="button" class="mode-item" data-mode="agent" role="option" aria-selected="false"
                  title="Build: full tool use — create, modify and run (files, shell, search)">
            <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="none"/><path d="M19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>
            <span>Build</span>
            <svg class="mode-check" width="12" height="12" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12l4.5 4.5L19 7.5" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>
          </button>
        </div>
      </div>
      <!-- Parallel: press/release toggle enabling orchestration (sub-agents)
           for the current mode. Blue when pressed. -->
      <button type="button" id="parallel-btn" aria-pressed="false"
              title="Parallel: let the agent launch sub-agents (read-only in Analyze)">
        <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true"><circle cx="7.5" cy="9" r="2.4" fill="currentColor"/><circle cx="16.5" cy="9" r="2.4" fill="currentColor"/><circle cx="10" cy="15.5" r="2.2" fill="currentColor"/><circle cx="14" cy="15.5" r="2.2" fill="currentColor"/></svg>
        <span>Parallel</span>
      </button>
      <span class="model-label">AI Model:</span>
      <button type="button" id="model-btn" class="model-btn" title="Select a model" aria-haspopup="dialog">
        <span id="model-btn-label">Select a model</span>
        <span id="model-warn" class="warn-badge hidden" title="models.dev unreachable — some model limits may be unknown">⚠</span>
        <svg class="model-btn-chevron" width="10" height="10" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>
      </button>
      <button id="gear-btn" class="gear-btn" title="Configure providers & models"><svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><path d="M19.4 13a7.6 7.6 0 0 0 .1-1 7.6 7.6 0 0 0-.1-1l2.1-1.7a.5.5 0 0 0 .1-.7l-2-3.5a.5.5 0 0 0-.6-.2l-2.5 1a7.6 7.6 0 0 0-1.7-1L14.5 2.4a.5.5 0 0 0-.5-.4h-4a.5.5 0 0 0-.5.4l-.4 2.5a7.6 7.6 0 0 0-1.7 1l-2.5-1a.5.5 0 0 0-.6.2l-2 3.5a.5.5 0 0 0 .1.7L4.5 11a7.6 7.6 0 0 0-.1 1 7.6 7.6 0 0 0 .1 1l-2.1 1.7a.5.5 0 0 0-.1.7l2 3.5a.5.5 0 0 0 .6.2l2.5-1a7.6 7.6 0 0 0 1.7 1l.4 2.5a.5.5 0 0 0 .5.4h4a.5.5 0 0 0 .5-.4l.4-2.5a7.6 7.6 0 0 0 1.7-1l2.5 1a.5.5 0 0 0 .6-.2l2-3.5a.5.5 0 0 0-.1-.7zM12 15.5A3.5 3.5 0 1 1 12 8.5a3.5 3.5 0 0 1 0 7z" fill="currentColor"/></svg></button>
    </div>
    <div id="attach-row">
      <div id="attachment-chips" class="hidden"></div>
    </div>
  </div>
  <div id="status">
    <div id="ctl-cards" class="ctl-cards">
      <div class="ctl-card">
        <span class="card-title">Window</span>
        <div class="field">
          <label class="field-label" for="ctx-range">Context window <span class="range-label" id="ctx-range-label"></span></label>
          <div class="num-row">
            <input type="range" id="ctx-range" class="num-range" min="${MIN_CONTEXT_WINDOW}" max="${MAX_CONTEXT_WINDOW}" step="1000" aria-label="Context window" />
            <span class="num-value" id="ctx-value">${DEFAULT_CONTEXT_WINDOW}</span>
          </div>
        </div>
        <div class="field">
          <label class="field-label" for="out-range">Output tokens <span class="range-label" id="out-range-label"></span></label>
          <div class="num-row">
            <input type="range" id="out-range" class="num-range" min="${MIN_OUTPUT_TOKENS}" max="${MAX_OUTPUT_TOKENS}" step="256" aria-label="Output tokens" />
            <span class="num-value" id="out-value">${DEFAULT_OUTPUT_TOKENS}</span>
          </div>
        </div>
        <div class="field">
          <span class="field-label">Thinking</span>
          <div class="sampler-toggle" id="thinking-toggle" role="radiogroup" aria-label="Thinking level">
            <label class="sampler-opt" title="No reasoning effort"><input type="radio" name="thinking-level" id="thinking-off" value="off" />Off</label>
            <label class="sampler-opt" title="Low reasoning effort"><input type="radio" name="thinking-level" id="thinking-low" value="low" />Low</label>
            <label class="sampler-opt" title="Medium reasoning effort"><input type="radio" name="thinking-level" id="thinking-medium" value="medium" />Medium</label>
            <label class="sampler-opt" title="High reasoning effort"><input type="radio" name="thinking-level" id="thinking-high" value="high" />High</label>
          </div>
        </div>
      </div>
      <div class="ctl-card">
        <span class="card-title">Sampling</span>
        <div class="field">
          <div class="sampler-toggle" id="sampler-toggle">
            <label class="sampler-opt"><input type="radio" name="sampler" id="sampler-temp" value="temperature" checked />Temperature</label>
            <label class="sampler-opt"><input type="radio" name="sampler" id="sampler-topp" value="topP" />Top-P</label>
            <span class="range-label" id="samp-range-label"></span>
          </div>
          <div class="num-row">
            <input type="range" id="samp-range" class="num-range" min="0" max="2" step="0.1" aria-label="Sampler value" />
            <span class="num-value" id="samp-value">Auto</span>
            <button id="samp-auto" class="ctx-btn" title="Reset to Auto (not sent)">Auto</button>
          </div>
        </div>
        <div class="field">
          <label class="field-label" for="presence-range">Presence penalty (0.0 → 2.0)</label>
          <div class="num-row">
            <input type="range" id="presence-range" class="num-range" min="0" max="2" step="0.1" aria-label="Presence penalty" />
            <span class="num-value" id="presence-value">Auto</span>
            <button id="presence-auto" class="ctx-btn" title="Reset to Auto (not sent)">Auto</button>
          </div>
        </div>
        <div class="field">
          <label class="field-label" for="freq-range">Frequency penalty (0.0 → 2.0)</label>
          <div class="num-row">
            <input type="range" id="freq-range" class="num-range" min="0" max="2" step="0.1" aria-label="Frequency penalty" />
            <span class="num-value" id="freq-value">Auto</span>
            <button id="freq-auto" class="ctx-btn" title="Reset to Auto (not sent)">Auto</button>
          </div>
        </div>
      </div>
      <div class="ctl-card">
        <span class="card-title">Parallel</span>
        <div class="field">
          <label class="field-label" for="par-range">Max parallel sub-agents</label>
          <div class="num-row">
            <input type="range" id="par-range" class="num-range" min="0" max="100" step="1" aria-label="Max parallel sub-agents" />
            <span class="num-value" id="par-value">4</span>
          </div>
        </div>
      </div>
      <div class="ctl-card" id="lg-card">
        <span class="card-title">Loop Guard</span>
        <div class="field">
          <span class="field-label">Sensitivity</span>
          <div class="lg-head" id="lg-head">
            <div class="sampler-toggle" id="lg-toggle" role="radiogroup" aria-label="Loop Guard sensitivity">
              <label class="sampler-opt" title="Off: the Loop Guard does nothing at all — no detection, no nudges, no stop, and no tool-call deduplication (identical calls are re-run)"><input type="radio" name="lg-level" id="lg-off" value="off" />Off</label>
              <label class="sampler-opt" title="Permissive: only clear, sustained loops are flagged"><input type="radio" name="lg-level" id="lg-low" value="low" />Low</label>
              <label class="sampler-opt" title="Balanced: the default preset"><input type="radio" name="lg-level" id="lg-medium" value="medium" checked />Medium</label>
              <label class="sampler-opt" title="Aggressive: flags loops sooner (more nudges, lower thresholds)"><input type="radio" name="lg-level" id="lg-high" value="high" />High</label>
              <label class="sampler-opt" title="Also apply the Loop Guard to the final answer text (detects the model repeating the same response). Default off."><input type="checkbox" id="lg-response" />Include response</label>
            </div>
            <button id="lg-collapse" class="lg-collapse" aria-expanded="false" aria-controls="lg-params-field" title="Show the Loop Guard parameters">
              <svg width="13" height="13" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
            </button>
          </div>
        </div>
        <div class="field" id="lg-params-field">
          <div id="lg-fields" class="lg-fields"></div>
        </div>
      </div>
      <div class="ctl-card ctl-card-wide hidden" id="skills-card">
        <span class="card-title">Skills</span>
        <div id="skills-list"></div>
      </div>
      <div class="ctl-card ctl-card-wide hidden" id="mcp-card">
        <div class="ctl-inline" style="justify-content: space-between;">
          <span class="card-title">MCP</span>
          <button id="mcp-configure" class="gear-btn" title="Configure MCP servers" aria-label="Configure MCP servers"><svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><path d="M19.4 13a7.6 7.6 0 0 0 .1-1 7.6 7.6 0 0 0-.1-1l2.1-1.7a.5.5 0 0 0 .1-.7l-2-3.5a.5.5 0 0 0-.6-.2l-2.5 1a7.6 7.6 0 0 0-1.7-1L14.5 2.4a.5.5 0 0 0-.5-.4h-4a.5.5 0 0 0-.5.4l-.4 2.5a7.6 7.6 0 0 0-1.7 1l-2.5-1a.5.5 0 0 0-.6.2l-2 3.5a.5.5 0 0 0 .1.7L4.5 11a7.6 7.6 0 0 0-.1 1 7.6 7.6 0 0 0 .1 1l-2.1 1.7a.5.5 0 0 0-.1.7l2 3.5a.5.5 0 0 0 .6.2l2.5-1a7.6 7.6 0 0 0 1.7 1l.4 2.5a.5.5 0 0 0 .5.4h4a.5.5 0 0 0 .5-.4l.4-2.5a7.6 7.6 0 0 0 1.7-1l2.5 1a.5.5 0 0 0 .6-.2l2-3.5a.5.5 0 0 0-.1-.7zM12 15.5A3.5 3.5 0 1 1 12 8.5a3.5 3.5 0 0 1 0 7z" fill="currentColor"/></svg></button>
        </div>
        <div id="mcp-list"></div>
      </div>
    </div>
  </div>
  <div id="metrics">
    <div class="metrics-stats">
      <span class="model-label">Tokens</span>
      <span class="met" id="met-tokens" title="Input tokens used">0</span>
      <span class="met-sep">/</span>
      <span class="met"><span id="met-ctx" title="Usable context: window − response reserve">${DEFAULT_CONTEXT_WINDOW}</span><span class="met-note" id="met-window" title="Window the model declares, BEFORE the reserve is taken out"></span></span>
      <span class="met pct" id="met-pct">(0%)</span>
      <span class="met" id="met-cache" title="Input tokens served from prompt cache"></span>
      <button id="compact-btn" title="Summarize the older turns and move them out of the context window. The transcript keeps them, readable and searchable.">Compact</button>
      <span id="compact-threshold-label" title="Auto-compaction: starts when the usable context is this full · how much of it is kept verbatim after the cut">Auto 80% ctx · keep 10%</span>
      <button id="compact-settings-btn" class="gear-btn" title="Compaction policy for THIS session: when it starts and where it lands"><svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><path d="M19.4 13a7.6 7.6 0 0 0 .1-1 7.6 7.6 0 0 0-.1-1l2.1-1.7a.5.5 0 0 0 .1-.7l-2-3.5a.5.5 0 0 0-.6-.2l-2.5 1a7.6 7.6 0 0 0-1.7-1L14.5 2.4a.5.5 0 0 0-.5-.4h-4a.5.5 0 0 0-.5.4l-.4 2.5a7.6 7.6 0 0 0-1.7 1l-2.5-1a.5.5 0 0 0-.6.2l-2 3.5a.5.5 0 0 0 .1.7L4.5 11a7.6 7.6 0 0 0-.1 1 7.6 7.6 0 0 0 .1 1l-2.1 1.7a.5.5 0 0 0-.1.7l2 3.5a.5.5 0 0 0 .6.2l2.5-1a7.6 7.6 0 0 0 1.7 1l.4 2.5a.5.5 0 0 0 .5.4h4a.5.5 0 0 0 .5-.4l.4-2.5a7.6 7.6 0 0 0 1.7-1l2.5 1a.5.5 0 0 0 .6-.2l2-3.5a.5.5 0 0 0-.1-.7zM12 15.5A3.5 3.5 0 1 1 12 8.5a3.5 3.5 0 0 1 0 7z" fill="currentColor"/></svg></button>
    </div>
    <div id="ctx-bar-wrap"><div id="ctx-bar"></div></div>
  </div>
  <div id="name-modal" class="hidden">
    <div class="name-modal-backdrop"></div>
    <div class="name-modal-card">
      <h3 id="name-modal-title">Name the new session</h3>
      <input id="name-input" type="text" spellcheck="false" />
      <div id="name-error"></div>
      <div class="name-modal-actions">
        <button id="name-cancel" class="secondary">Cancel</button>
        <button id="name-ok">Create</button>
      </div>
    </div>
  </div>
  <div id="compact-settings-modal" class="hidden">
    <div class="cs-backdrop"></div>
    <div class="cs-card">
      <h3>Compaction <span class="cs-scope">for this session</span></h3>
      <p class="cs-hint">Older turns leave the context window and a summary takes their place in the window. The transcript keeps them, readable and searchable. <b>Nothing here applies until you press Save</b> — Cancel throws the draft away.</p>
      <div class="cs-field">
        <label for="compact-threshold-input">Auto-compaction trigger: starts when the usable context is this full</label>
        <div class="cs-inline">
          <input id="compact-threshold-input" type="range" min="1" max="100" step="1" />
          <span id="compact-threshold-value" class="cs-val"></span>
        </div>
      </div>
      <div class="cs-field">
        <label for="compact-target-input">Land at: usable context left after a compaction</label>
        <div class="cs-inline">
          <input id="compact-target-input" type="range" min="0" step="1" />
          <span id="compact-target-value" class="cs-val"></span>
          <button id="compact-target-auto" class="secondary cs-mini" type="button" title="Back to the derived default: an eighth of the trigger">Default</button>
        </div>
        <p class="cs-hint">0 frees as much as the structure allows: only the last complete turn survives. The <b>Default</b> is an eighth of the trigger (10% with the trigger at 80), so two or three exchanges stay verbatim and follow it while it is untouched. The bounds are derived: the ceiling is the trigger minus one, and a value below what the summary plus the last turn already occupy just means <b>0</b>.</p>
      </div>
      <pre id="compact-preview" class="cs-preview"></pre>
      <div class="cs-actions">
        <button id="compact-settings-cancel" class="secondary">Cancel</button>
        <button id="compact-settings-save">Save</button>
      </div>
    </div>
  </div>
  <div id="alert-modal" class="hidden">
    <div class="alert-backdrop"></div>
    <div class="alert-card">
      <h3 id="alert-title"></h3>
      <div id="alert-message" class="alert-message"></div>
      <div class="alert-actions">
        <button id="alert-cancel" class="secondary">Cancel</button>
        <button id="alert-ok">OK</button>
      </div>
    </div>
  </div>
  <div id="sessions-modal" class="hidden">
    <div class="sm-backdrop"></div>
    <div class="sm-card">
      <div class="sm-head">
        <h3>All sessions</h3>
        <span class="sm-hint">Every folder, most recent first. Red = folder no longer available — set a new folder first. To use a session of another folder, open that folder in VS Code.</span>
      </div>
      <div class="sm-search">
        <input id="sessions-search" type="search" placeholder="Search sessions" spellcheck="false" autocomplete="off" aria-label="Search sessions" />
      </div>
      <div id="sessions-manager-list"></div>
      <div id="sm-vacuum" class="sm-vacuum">
        <div class="sm-vacuum-head">
          <span>Database compaction (VACUUM)</span>
          <span class="sm-vacuum-live" title="These two sliders are global settings: they are stored as soon as you move them, so this card needs no Save">applies immediately</span>
          <span class="spacer"></span>
          <button id="sm-vacuum-btn" class="secondary">VACUUM &amp; optimize indexes…</button>
        </div>
        <div class="sm-vacuum-slider">
          <label for="sm-vacuum-threshold">Suggest above</label>
          <input id="sm-vacuum-threshold" type="range" min="1" max="100" step="1" />
          <span id="sm-vacuum-threshold-val" class="sm-vacuum-val"></span>
        </div>
        <div class="sm-vacuum-slider">
          <label for="sm-vacuum-min">Min reclaimable</label>
          <input id="sm-vacuum-min" type="range" min="0" max="10240" step="1" />
          <span id="sm-vacuum-min-val" class="sm-vacuum-val"></span>
        </div>
        <div id="sm-vacuum-stats" class="sm-vacuum-stats"></div>
      </div>
      <div class="sm-footer">
        <button id="sessions-close" class="secondary">Close</button>
      </div>
    </div>
  </div>
  <div id="db-vacuum-modal" class="hidden">
    <div class="dv-backdrop"></div>
    <div class="dv-card">
      <h3>VACUUM &amp; optimize database</h3>
      <p id="db-vacuum-msg" class="sm-hint"></p>
      <div id="db-vacuum-stats" class="db-vacuum-stats"></div>
      <div id="db-vacuum-info" class="sm-vacuum-info"></div>
      <div class="dv-footer">
        <button id="db-vacuum-close" class="secondary">Close</button>
        <button id="db-vacuum-run">VACUUM &amp; optimize indexes</button>
      </div>
    </div>
  </div>
  <div id="model-modal" class="hidden">
    <div class="mm-backdrop"></div>
    <div class="mm-card">
      <div class="mm-head">
        <h3>Select model</h3>
      </div>
      <div class="mm-search">
        <input id="model-search" type="search" placeholder="Search models" spellcheck="false" autocomplete="off" aria-label="Search models" />
      </div>
      <div id="mm-modelsdev-warn" class="mm-warn hidden">⚠ models.dev unreachable — context/output may show “-” for hosts that don’t report them.</div>
      <div id="model-list"></div>
      <div class="mm-footer">
        <button id="model-close" class="secondary">Close</button>
      </div>
    </div>
  </div>
  <div id="providers-modal" class="hidden">
    <div class="providers-backdrop"></div>
    <div class="providers-card">
      <div class="providers-head">
        <h3>Providers &amp; Models</h3>
        <span class="providers-hint">Every provider is active: pick a model from the chat's model dropdown. Lists are fetched live from each host.</span>
      </div>
      <div class="providers-body">
        <div class="provider-list-col">
          <div class="provider-list-head">
            <span>Providers</span>
            <button id="provider-add" class="secondary">+ New</button>
          </div>
          <select id="provider-select" size="8"></select>
        </div>
        <div class="provider-form-col">
          <div class="field">
            <label class="field-label" for="pe-name">Name</label>
            <input id="pe-name" type="text" spellcheck="false" placeholder="e.g. llamacpp" />
          </div>
          <div class="field">
            <label class="field-label" for="pe-baseurl">Base URL</label>
            <input id="pe-baseurl" type="text" spellcheck="false" placeholder="http://localhost:8090/v1" />
          </div>
          <div class="field">
            <label class="field-label" for="pe-apikey">API Key (optional — leave empty for local hosts)</label>
            <div class="pe-secret">
              <input id="pe-apikey" type="password" spellcheck="false" placeholder="sk-..." autocomplete="off" />
              <button type="button" id="pe-apikey-reveal" class="pe-eye" title="Hold to show the key" aria-label="Hold to show the API key">
                <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="12" cy="12" r="3" fill="currentColor"/></svg>
              </button>
            </div>
          </div>
          <div class="field">
            <label class="field-label" for="pe-thinking">Reasoning</label>
            <select id="pe-thinking">
              <option value="effort">Effort (OpenAI)</option>
              <option value="reasoning">Reasoning (OpenRouter)</option>
              <option value="type">Type (DeepSeek / Anthropic toggle)</option>
              <option value="bool">Bool (llama.cpp)</option>
              <option value="unspecified">Unspecified (provider default)</option>
            </select>
          </div>
          <div class="field">
            <label class="field-label" for="pe-session-header">Session header (optional)</label>
            <input id="pe-session-header" type="text" spellcheck="false" placeholder="e.g. x-opencode-session" title="Header carrying this conversation's stable session id (routing + prompt cache, e.g. OpenCode Go)" />
          </div>
          <div class="provider-actions">
            <button id="provider-test" class="secondary">Test connection</button>
            <button id="provider-delete" class="secondary danger" title="Remove this provider">Delete</button>
          </div>
          <div id="provider-test-result" class="hidden"></div>
        </div>
      </div>
      <div class="providers-actions">
        <button id="providers-export" class="secondary" title="Export the providers config to a JSON file">Export models configuration</button>
        <button id="providers-import" class="secondary" title="Import providers from a JSON file (merged into the current config)">Import models configuration</button>
        <button id="providers-cancel" class="secondary">Cancel</button>
        <button id="providers-save">Save</button>
      </div>
      <!-- Import/export feedback on its OWN line, UNDER the buttons: the full
           "Imported from /Users/…/harny-providers.json" path used to sit inside
           the button row and pushed the buttons around. -->
      <div id="providers-io-result" class="providers-io" role="status" aria-live="polite"></div>
    </div>
  </div>
  <div id="mcp-modal" class="hidden">
    <div class="mcp-backdrop"></div>
    <div class="mcp-card">
      <div class="mcp-head">
        <h3>MCP servers</h3>
        <span class="mcp-hint">Model Context Protocol (stdio or HTTP). Their tools appear as mcp__&lt;server&gt;__&lt;tool&gt;.</span>
      </div>
      <div class="mcp-body">
        <div class="mcp-list-col">
          <select id="mcp-select" size="7" aria-label="MCP servers"></select>
          <div class="mcp-list-actions">
            <button id="mcp-add" class="secondary" type="button">+ New</button>
            <button id="mcp-delete" class="secondary danger" type="button">Delete</button>
          </div>
        </div>
        <div class="mcp-form-col">
          <div class="field"><label class="field-label" for="mcp-name">Name</label><input id="mcp-name" type="text" spellcheck="false" /></div>
          <div class="field"><label class="field-label" for="mcp-command">Command</label><input id="mcp-command" type="text" spellcheck="false" placeholder="e.g. npx" /></div>
          <div class="field"><label class="field-label" for="mcp-args">Args (one per line)</label><textarea id="mcp-args" rows="3" spellcheck="false"></textarea></div>
          <div class="field"><label class="field-label" for="mcp-env">Env (KEY=VALUE, one per line)</label><textarea id="mcp-env" rows="3" spellcheck="false"></textarea></div>
          <label class="mcp-enabled-row"><input type="checkbox" id="mcp-enabled" /> Enabled (disabled servers are kept but not connected)</label>
          <div class="mcp-form-actions">
            <button id="mcp-test" class="secondary" type="button">Test</button>
            <span id="mcp-test-result" class="mcp-io"></span>
          </div>
        </div>
      </div>
      <div class="mcp-actions">
        <button id="mcp-cancel" class="secondary">Cancel</button>
        <button id="mcp-save">Save</button>
      </div>
    </div>
  </div>
  <div id="mcp-tools-popover" class="hidden"></div>
  <!-- Shared hover tooltip: explains a control's parameter on mouse-over. -->
  <div id="tip" class="tip hidden" role="tooltip"></div>
  <div id="slash-menu" class="hidden" role="listbox" aria-label="Commands"></div>
  <script id="harny-view-init" type="application/json">${jsonInit(deps.state)}</script>
  <script src="${scriptUri}"></script>
</body>
</html>`;
}
