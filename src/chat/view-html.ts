import { FONTS, FAMILIES, PALETTE, ROOT_FONT_SIZE } from "./view-config";
import type { ChatMessage } from "../core/history/types";
import type { SessionSummary } from "../core/sessions/types";
import { DEFAULT_CONTEXT_WINDOW, DEFAULT_OUTPUT_TOKENS, MAX_CONTEXT_WINDOW, MAX_OUTPUT_TOKENS, MIN_CONTEXT_WINDOW, MIN_OUTPUT_TOKENS } from "./context-window";

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
  /** Session ids whose agent is streaming (disabled delete buttons in the list). */
  workingIds: string[];
  /** Whether the active session is mid-stream (initial lock + live restore). */
  streaming: boolean;
  /** Live (uncommitted) thinking/answer of the in-flight turn, for replay. */
  liveThinking: string;
  liveAnswer: string;
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
}

function renderViewConfig(deps: ViewHtmlDeps): string {
  const palette = Object.entries(PALETTE)
    .map(([name, value]) => `      --${name}: ${value};`)
    .join("\n");
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
      /* Palette, fonts and size families — defined in src/chat/view-config.ts */
${palette}
${fonts}
      --font-size: ${rootSize};
      font-size: var(--font-size);
${sizes}
    }`;
}

function jsonInit(state: ViewState): string {
  return JSON.stringify(state).replace(/</g, "\\u003c");
}

/** Pure HTML for the single side-view: sessions list + tabs + active chat. */
export function renderViewHtml(deps: ViewHtmlDeps): string {
  const { cspSource, scriptUri } = deps;
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
       width is controlled by VS Code — the extension cannot force it.) */
    html { min-width: 25rem; overflow-x: auto; }
    body {
      font-size: 1rem;
      background: var(--bg);
      color: var(--fg);
      height: 100vh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      min-width: 25rem;
    }

    /* Sessions area: a card matching the control cards below. Borderless:
       separation comes from the tone-on-tone surface, not outline lines. */
    .sessions-card {
      border-radius: 8px;
      margin: 8px 10px 0;
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
    #session-head .toggle { font-size: var(--fs-xs); width: 12px; color: #888; }
    #session-head .spacer { flex: 1; }
    #session-head button {
      background: transparent; border: none; color: var(--accent);
      font-size: var(--fs-xl); cursor: pointer; padding: 0 4px;
      border-radius: 4px; transition: background-color 0.12s;
    }
    #session-head button:hover { background: rgba(255, 255, 255, 0.08); }
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
      flex: 1 1 100%; color: #888; font-size: var(--fs-xs);
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .srow .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: pointer; }
    .srow.open .name { color: var(--accent); }
    .srow-actions { display: inline-flex; align-items: center; gap: 8px; }
    .srow-actions button {
      background: transparent; border: none; color: var(--fg);
      font-size: var(--fs-lg); cursor: pointer; opacity: 0.65; padding: 2px 4px;
      border-radius: 4px; transition: opacity 0.12s, color 0.12s, background-color 0.12s;
    }
    .srow-actions button:hover:not(:disabled) { opacity: 1; color: var(--accent); background: rgba(255, 255, 255, 0.06); }
    /* A working session is fully hover-inert: the row stops highlighting and
       its action keys (branch/rename/delete) become dead — no cursor, no
       hover reaction, no tooltip (pointer-events none). Mirrors the ⎇ policy
       on assistant replies. */
    .srow.is-working:hover { background: transparent; }
    .srow-actions button:disabled {
      opacity: 0.28; cursor: default; pointer-events: none;
    }
    .empty { padding: 12px; text-align: center; color: #888; font-size: var(--fs-lg); }

    /* Tabs: raised pill keys, consistent with the 3D button chrome. */
    #tabs {
      display: flex; gap: 3px; padding: 5px 8px 0;
      border-bottom: 1px solid var(--border); flex-shrink: 0;
      /* Horizontal scroll ONLY: no vertical scrollbar on a single-row strip. */
      overflow-x: auto; overflow-y: hidden;
      /* Tabs do NOT shrink (they stay readable); the strip SCROLLS instead. A
         thin, always-visible scrollbar + wheel-to-sideways make it reachable. */
      scrollbar-width: thin; scrollbar-color: rgba(255, 255, 255, 0.25) transparent;
    }
    #tabs::-webkit-scrollbar { height: 6px; }
    #tabs::-webkit-scrollbar-track { background: transparent; }
    #tabs::-webkit-scrollbar-thumb { background: rgba(255, 255, 255, 0.22); border-radius: 3px; }
    #tabs::-webkit-scrollbar-thumb:hover { background: rgba(255, 255, 255, 0.4); }
    .tab {
      position: relative;
      display: inline-flex; align-items: center; gap: 5px;
      padding: 4px 10px; border-radius: 6px 6px 0 0; cursor: pointer;
      font-size: var(--fs-md); white-space: nowrap; color: #9a9a9a;
      border: 1px solid transparent; border-bottom: none;
      background: linear-gradient(to bottom, rgba(255, 255, 255, 0.05), rgba(255, 255, 255, 0));
      box-shadow: inset 0 -1px 0 rgba(0, 0, 0, 0.1);
      transition: color 0.12s, background-color 0.12s, box-shadow 0.12s;
      /* Readable floor: never squeeze a tab below this (the strip scrolls). */
      max-width: 12rem; min-width: 5.5rem; flex-shrink: 0;
      /* sits flush on the strip's border (active covers it with its face) */
      margin-bottom: -1px;
    }
    .tab > span:first-child { overflow: hidden; text-overflow: ellipsis; }
    .tab:hover:not(.active) {
      color: var(--fg);
      background: linear-gradient(to bottom, rgba(255, 255, 255, 0.1), rgba(255, 255, 255, 0.02));
    }
    .tab.active {
      color: var(--fg);
      border-color: var(--border);
      background: linear-gradient(to bottom, rgba(255, 255, 255, 0.16), rgba(255, 255, 255, 0.03)),
        var(--assistant-msg);
      box-shadow:
        inset 0 1px 0 rgba(255, 255, 255, 0.18),
        0 -1px 3px rgba(0, 0, 0, 0.12);
    }
    .tab.active .close { color: #bbb; }
    .tab .close {
      font-size: var(--fs-sm); line-height: 1; padding: 1px 3px; margin-right: -2px;
      border-radius: 4px; color: #999; flex-shrink: 0;
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
    .msg.user { align-self: flex-end; background: var(--user-msg); color: #fff; white-space: pre-wrap; position: relative; }
    /* Harness-injected prompts (loop guard / delegation / budget): a LIGHT-BLUE
       bubble with a "Nudge" label, so they read as SYSTEM messages and can't be
       confused with the user's orange bubbles. Rendered as Markdown. */
    .msg.user.harness {
      align-self: stretch; max-width: 100%; white-space: normal;
      background: rgba(97, 175, 239, 0.12);
      border: 1px solid rgba(97, 175, 239, 0.45);
      color: #dbeafe;
    }
    .msg.user.harness .harness-label {
      font-size: var(--fs-xs); font-weight: 700; letter-spacing: 0.08em;
      text-transform: uppercase; color: #61afef; margin-bottom: 4px;
    }
    .msg.user.harness .harness-md { min-width: 0; }
    .msg.user.harness .harness-md p { margin: 4px 0; }
    .msg.user.harness .harness-md > :first-child { margin-top: 0; }
    .msg.user.harness .harness-md > :last-child { margin-bottom: 0; }
    .msg.user.harness .harness-md ul, .msg.user.harness .harness-md ol { margin: 4px 0; padding-left: 1.4em; }
    .msg.user.harness .harness-md li { margin: 2px 0; }
    .msg.user.harness .harness-md code { background: rgba(0, 0, 0, 0.28); border-radius: 3px; padding: 0 3px; }
    .msg.user.harness .harness-md pre { background: rgba(0, 0, 0, 0.28); border-radius: 5px; padding: 6px 8px; overflow-x: auto; margin: 6px 0; }
    .msg.user.harness .harness-md a { color: #fff; text-decoration: underline; }
    .msg.user.harness .harness-md strong { font-weight: 600; }
    /* "Sent with these files" chips inside a user bubble: the message keeps the
       typed prompt; the attached documents are shown as a compact indicator
       (their contents live in the LLM context, not in the transcript). */
    /* Synthetic compacted prompt: a recognizable icon before the marker. */
    .msg.user.synthetic-summary .synthetic-icon { vertical-align: -2px; margin-right: 5px; }
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
    .msg-attach-file-size { font-size: var(--fs-xs); color: #9a9a9a; }
    .msg-attach {
      display: inline-flex; align-items: center; gap: 4px; max-width: 100%;
      padding: 1px 7px; border-radius: 999px; font-size: var(--fs-sm);
      /* Darker than the terracotta bubble so the white label pops (contrast). */
      background: rgba(0, 0, 0, 0.5); border: 1px solid rgba(0, 0, 0, 0.5);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .msg.assistant, .msg.tool { width: 100%; max-width: 100%; }
    .msg.assistant { align-self: flex-start; background: var(--assistant-msg); min-width: 0; position: relative; font-size: var(--fs-lg); }
    /* Bubble action tabs: the ⎇ branch key on assistant replies and the ✂ cut
       key on user prompts become little "linguette" anchored to the bubble's
       TOP-RIGHT. On hover they SLIDE UP out of the bubble (same fade/reveal as
       before) so they stay clearly visible instead of blending into the text. */
    .branch-at, .truncate-at {
      position: absolute; top: 0; right: 8px; z-index: 4;
      display: inline-flex; align-items: center; justify-content: center;
      height: 20px; min-width: 24px; padding: 0 6px;
      background: var(--surface-2); border: 1px solid rgba(255, 255, 255, 0.16);
      border-bottom: none; border-radius: 6px 6px 0 0;
      color: #cfcfcf; line-height: 1;
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
    .branch-at:hover:not(:disabled) { color: var(--accent); border-color: var(--accent); background: #2c241f; }
    .truncate-at:hover:not(:disabled) { color: #fff; border-color: #fff; background: var(--accent-strong); }
    .msg.assistant.error { background: rgba(244, 71, 71, 0.15); border: 1px solid var(--error); }
    .msg.assistant.loop { background: rgba(245, 166, 35, 0.12); border: 1px solid #f5a623; }
    /* Prominent "Switch to Build" call to action (Analyze prepared previews). */
    .build-cta { display: flex; align-items: center; justify-content: space-between; gap: 10px; width: 100%; margin: 8px 0; padding: 10px 12px; border: 1px solid #f5a623; border-radius: 6px; background: rgba(245, 166, 35, 0.16); }
    .build-cta-text { color: var(--fg-strong); font-size: 13px; }
    .build-cta-btn { flex: 0 0 auto; background: #f5a623; color: #1a1a1a; border: none; border-radius: 5px; padding: 6px 12px; font-weight: 600; font-size: 13px; cursor: pointer; white-space: nowrap; }
    .build-cta-btn:hover { background: #ffb84d; }
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
    .msg.assistant blockquote { border-left: 2px solid var(--border); padding-left: 8px; margin: 6px 0; color: #999; }
    .msg.assistant table { border-collapse: separate; border-spacing: 0; font-size: var(--fs-md); }
    .msg.assistant th, .msg.assistant td { border: 1px solid var(--border); padding: 3px 6px; text-align: left; }
    .msg.assistant th { background: var(--tool-bg); }
    .msg.assistant img { max-width: 100%; border-radius: 4px; }
    /* The wrapper OWNS the whole rounded frame and shrink-wraps the table
       (inline-block): no full-width line when the table is narrower, and the
       right corners follow the same radius. Cells only draw INTERIOR grid
       lines (outer edges suppressed — the frame belongs to the wrapper). */
    .table-scroll {
      display: inline-block;
      max-width: 100%;
      border: 1px solid var(--border);
      border-radius: 8px;
      overflow: auto;
      margin: 6px 0;
    }
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
    .code-lang { font-size: var(--fs-xs); text-transform: uppercase; letter-spacing: 0.4px; color: #888; background: rgba(0,0,0,0.2); padding: 1px 8px; border-bottom: 1px solid var(--border); }
    .msg.tool { align-self: flex-start; background: var(--tool-bg); border: 1px solid var(--border); font-size: var(--fs-md); }
    .msg.system { display: none; }
    .msg.welcome { align-self: center; background: transparent; border: 1px dashed var(--border); color: #888; text-align: center; max-width: 100%; }
    .working { align-self: flex-start; color: #999; font-size: var(--fs-md); font-style: italic; animation: harny-pulse 1.2s ease-in-out infinite; }
    /* The working bar is a REAL footer glued below the transcript (NOT a bubble
       in the flow): always visible in realtime while it exists. It lives
       outside #messages, so sections are never inserted below it. The text
       pulses with the same 1.2s cadence as the play button (harny-pulse). */
    #working-bar {
      flex-shrink: 0;
      padding: 4px 10px;
      background: var(--bg);
      color: #999; font-size: var(--fs-md); font-style: italic;
      animation: harny-pulse 1.2s ease-in-out infinite;
    }
    #working-bar.hidden { display: none; }
    /* Messages typed WHILE the session works: a real footer (outside
       #messages) so they survive streaming re-renders. Queue = neutral, steer
       = accent. Each is cancellable until it is applied. */
    #pending-area {
      flex-shrink: 0; display: flex; flex-direction: column; gap: 4px;
      padding: 6px 10px; background: var(--bg); border-top: 1px dashed var(--border);
    }
    #pending-area.hidden { display: none; }
    .pending-msg {
      display: flex; align-items: center; gap: 8px; min-width: 0;
      padding: 3px 6px 3px 8px; border-radius: 6px; font-size: var(--fs-md);
      border: 1px solid var(--border); background: var(--surface-2); color: var(--muted);
    }
    .pending-msg.pending-steer { border-color: var(--accent); color: var(--fg); }
    .pending-badge {
      flex: 0 0 auto; font-size: var(--fs-sm); text-transform: uppercase; letter-spacing: 0.04em;
      padding: 1px 5px; border-radius: 999px; background: var(--tool-bg); color: var(--muted);
    }
    .pending-msg.pending-steer .pending-badge { background: var(--accent); color: #fff; }
    .pending-text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .pending-cancel {
      flex: 0 0 auto; min-height: 1.2rem; padding: 0 0.4rem; background: transparent;
      border: 1px solid var(--border); color: var(--muted); box-shadow: none;
    }
    .pending-cancel:hover { color: var(--error); border-color: var(--error); filter: none; }
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
      0%, 100% { border-color: #d95f27; box-shadow: 0 0 14px 1px rgba(217, 95, 39, 0.45); }
      50% { border-color: rgba(217, 95, 39, 0.4); box-shadow: 0 0 4px 0 rgba(217, 95, 39, 0.15); }
    }
    /* Same cadence/phase as stream-border-pulse, but in the SUB-AGENT violet so
       a running sub-agent glows with a halo close to its own border color. */
    @keyframes stream-border-pulse-violet {
      0%, 100% { border-color: #7c5cff; box-shadow: 0 0 14px 1px rgba(124, 92, 255, 0.5); }
      50% { border-color: rgba(124, 92, 255, 0.4); box-shadow: 0 0 4px 0 rgba(124, 92, 255, 0.15); }
    }
    .msg.assistant.streaming {
      border: 2px solid rgba(217, 95, 39, 0.4);
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
      border: 2px solid rgba(217, 95, 39, 0.4);
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
    .tool-toggle { font-size: var(--fs-sm); width: 12px; color: #888; flex-shrink: 0; }
    .tool-name { white-space: nowrap; }
    /* Target file path shown after the tool name (light azure, ellipsized,
       truncated softly when the bubble is narrow — full path on hover). */
    .tool-path { color: #61afef; font-weight: 400; flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; opacity: 0.95; }
    .tool-details { margin-top: 2px; font-size: var(--fs-md); }
    .tool-details.collapsed { display: none; }
    .tool-label { display: block; color: #888; font-size: var(--fs-xs); text-transform: uppercase; letter-spacing: 0.4px; margin: 6px 0 2px; }
    .tool-details pre { background: rgba(0,0,0,0.25); border: 1px solid var(--border); border-radius: 4px; padding: 5px 7px; white-space: pre-wrap; word-break: break-all; max-height: 160px; overflow-y: auto; font-size: var(--fs-md); line-height: 1.4; }
    /* The Task/Input arguments block is a <pre>: WRAP it at the bubble width
       (the sub-agent "Task" lives OUTSIDE .tool-details, so it needs its own
       rule) and GROW vertically with the wrapped content — no max-height /
       scrollbar (the bubble simply gets taller). */
    .tool-args {
      background: rgba(0,0,0,0.25); border: 1px solid var(--border); border-radius: 4px;
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
    .fd-add { color: #98c379; background: rgba(152, 195, 121, 0.10); }
    .fd-del { color: #e06c75; background: rgba(224, 108, 117, 0.10); }
    .fd-hunk { color: var(--accent); background: rgba(255, 255, 255, 0.03); }
    .fd-ctx { color: inherit; opacity: 0.8; }
    /* Editor-style syntax tokens inside the diff lines (Prism classes, one-dark palette). */
    .fd-body .token { color: inherit; opacity: 1; }
    .fd-body .token.comment, .fd-body .token.prolog, .fd-body .token.cdata { color: #7f848e; font-style: italic; }
    .fd-body .token.keyword, .fd-body .token.selector, .fd-body .token.atrule, .fd-body .token.important { color: #c678dd; }
    .fd-body .token.string, .fd-body .token.attr-value, .fd-body .token.char, .fd-body .token.regex { color: #98c379; }
    .fd-body .token.number, .fd-body .token.boolean, .fd-body .token.constant { color: #d19a66; }
    .fd-body .token.function, .fd-body .token.function-variable { color: #61afef; }
    .fd-body .token.class-name, .fd-body .token.maybe-class-name { color: #e5c07b; }
    .fd-body .token.builtin { color: #56b6c2; }
    .fd-body .token.operator, .fd-body .token.punctuation { color: #abb2bf; }
    .fd-body .token.property, .fd-body .token.attr-name, .fd-body .token.variable { color: #e06c75; }
    .fd-body .token.doctype, .fd-body .token.entity { color: #e06c75; }
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
    .subagent-header .subagent-icon { color: #a98dff; vertical-align: -2px; }
    #working-bar .subagent-icon { vertical-align: -2px; }
    .subagent-role { color: #a98dff; font-weight: 500; }
    /* The sub-agent's short goal in the header: what it actually does. */
    .subagent-name {
      color: #9a9a9a; font-weight: 400; min-width: 0;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .subagent-status {
      margin-left: auto; flex-shrink: 0;
      display: inline-flex; align-items: center;
      height: var(--sa-chip-h); box-sizing: border-box;
      font-size: var(--fs-xs); font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase;
      padding: 0 7px; border-radius: 999px; border: 1px solid var(--border); color: #999;
    }
    .subagent-status.queued { color: #999; border-color: var(--border); }
    /* The "running…" chip is STATIC: the bubble itself carries the pulsing
       border while this sub-agent works (see .subagent-running above). */
    .subagent-status.running { color: #a98dff; border-color: rgba(124, 92, 255, 0.5); }
    .subagent-status.done { color: #98c379; border-color: rgba(152, 195, 121, 0.5); }
    .subagent-status.failed { color: var(--error); border-color: rgba(244, 71, 71, 0.5); }
    .subagent-status.aborted { color: #999; border-color: var(--border); }
    /* Per-sub-agent abort: stop ONLY this sub-agent, not the whole run. SQUARE
       and exactly as tall as the "running" chip's border box (shared
       --sa-chip-h); the global button min-height would otherwise stretch it
       into a rectangle. */
    .subagent-abort {
      flex: 0 0 auto; display: inline-flex; align-items: center; justify-content: center;
      width: var(--sa-chip-h); height: var(--sa-chip-h); min-width: var(--sa-chip-h); min-height: var(--sa-chip-h);
      padding: 0; cursor: pointer;
      color: #a98dff; background: transparent; border: 1px solid rgba(124, 92, 255, 0.45);
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
    .sa-thinking { color: #888; font-style: italic; font-size: var(--fs-sm); word-break: break-word; }
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
      background: rgba(0, 0, 0, 0.25); border-radius: 3px; padding: 0 3px;
      font-family: var(--font-mono); font-size: var(--fs-sm);
    }
    .sa-thinking pre, .sa-answer pre, .subagent-report pre {
      background: rgba(0, 0, 0, 0.25); border: 1px solid var(--border); border-radius: 4px;
      padding: 4px 6px; overflow-x: auto; margin: 3px 0; font-family: var(--font-mono); font-size: var(--fs-sm);
    }
    .sa-thinking pre code, .sa-answer pre code, .subagent-report pre code { background: transparent; padding: 0; }
    .sa-thinking a, .sa-answer a, .subagent-report a { color: var(--accent); }
    .subagent-report.tool-result-error { color: var(--error); }
    .sa-tool {
      color: #9a9a9a; font-size: var(--fs-sm); font-family: var(--font-mono);
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .sa-tool.pending { opacity: 0.6; }
    .sa-tool.ok { color: #98c379; }
    .sa-tool.err { color: var(--error); }
    .subagent-meta { display: flex; flex-wrap: wrap; gap: 4px; margin: 4px 0 2px; }
    .subagent-chip {
      display: inline-flex; align-items: center; padding: 0 6px; border-radius: 999px;
      max-width: 100%; overflow-wrap: anywhere;
      background: var(--tool-bg); border: 1px solid var(--border); color: #9a9a9a; font-size: var(--fs-xs);
    }
    .subagent-chip.access-read { color: #61afef; border-color: rgba(97, 175, 239, 0.4); }
    .subagent-chip.access-write, .subagent-chip.access-create { color: #e5c07b; border-color: rgba(229, 192, 123, 0.4); }
    .subagent-chip.parallel { color: #a98dff; border-color: rgba(124, 92, 255, 0.4); }

    .thinking-block { width: 100%; border: 1px dashed var(--border); border-radius: 6px; margin: 4px 0; padding: 0; font-size: var(--fs-md); }
    .thinking-header { display: flex; align-items: center; gap: 5px; padding: 5px 8px; cursor: pointer; user-select: none; color: #999; font-style: italic; }
    .thinking-header:hover { color: var(--accent); }
    .thinking-header .toggle { font-size: var(--fs-sm); width: 12px; }
    /* Thinking is now rendered as Markdown (md on the reasoning text), so the
       body uses normal whitespace + breaks:true like the assistant bubbles. */
    .thinking-body { padding: 0 8px 6px; color: #999; line-height: 1.45; }
    .thinking-body p { margin: 4px 0; }
    .thinking-body h1, .thinking-body h2, .thinking-body h3, .thinking-body h4, .thinking-body h5, .thinking-body h6 { margin: 8px 0 4px; font-weight: 700; color: var(--fg-strong); }
    .thinking-body ul, .thinking-body ol { margin: 4px 0; padding-left: 1.4em; }
    .thinking-body ol { list-style: decimal; }
    .thinking-body ul { list-style: disc; }
    .thinking-body li { margin: 2px 0; }
    .thinking-body a { color: var(--accent); }
    .thinking-body strong { font-weight: 600; }
    .thinking-body em { font-style: italic; }
    .thinking-body code { background: rgba(0,0,0,0.25); border-radius: 3px; padding: 0 3px; font-size: var(--fs-md); }
    .thinking-body pre { background: rgba(0,0,0,0.25); border: 1px solid var(--border); border-radius: 4px; padding: 4px 6px; overflow-x: auto; margin: 4px 0; }
    .thinking-body pre code { background: transparent; padding: 0; }
    .thinking-body blockquote { border-left: 2px solid var(--border); padding-left: 8px; margin: 4px 0; }
    .thinking-body table { border-collapse: separate; border-spacing: 0; }
    .thinking-body th, .thinking-body td { border: 1px solid var(--border); padding: 3px 6px; text-align: left; }
    .thinking-body th { background: rgba(0,0,0,0.25); }
    .thinking-body img { max-width: 100%; border-radius: 4px; }
    .thinking-body hr { border: none; border-top: 1px solid var(--border); margin: 6px 0; }
    .thinking-body .task-list-item-checkbox { margin-right: 4px; vertical-align: middle; }
    .thinking-body.collapsed { display: none; }
    .thinking { align-self: flex-start; color: #999; font-style: italic; font-size: var(--fs-md); white-space: pre-wrap; }

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
        0 1px 2px rgba(0, 0, 0, 0.35);
      transition: transform 0.08s, box-shadow 0.12s, filter 0.12s, color 0.12s;
    }
    button:not(:disabled):hover { filter: brightness(1.12); }
    button:not(:disabled):active {
      transform: translateY(1px);
      box-shadow: inset 0 1px 3px rgba(0, 0, 0, 0.4);
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
      font-size: var(--fs-sm); color: #d0d0d0; padding: 2px 6px; line-height: 1.3;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    /* Full-size image lightbox: click a thumbnail to view it large. */
    .img-lightbox { position: fixed; inset: 0; z-index: 1000; display: flex; align-items: center; justify-content: center; padding: 24px; background: rgba(0, 0, 0, 0.82); cursor: zoom-out; }
    .img-lightbox.hidden { display: none; }
    .img-lightbox-img { max-width: 92vw; max-height: 92vh; object-fit: contain; border-radius: 6px; box-shadow: 0 8px 40px rgba(0, 0, 0, 0.6); }
    /* Drag & drop affordance. */
    body.drag-over { outline: 2px dashed var(--accent); outline-offset: -6px; }
    .attach-size { color: #888; }
    #input-area .attach-remove {
      height: 1.15rem; min-height: 0; min-width: 1.15rem; padding: 0;
      background: transparent; color: var(--muted); border: none; box-shadow: none;
      font-size: var(--fs-lg); line-height: 1;
    }
    #input-area .attach-remove:not(:disabled):hover { color: var(--error); filter: none; }

    /* Control-stack toggle (above the ask card): a centered chevron that is
       ALWAYS visible (orange accent) — clicking collapses/expands the Window
       + Sampling cards below (the rest of the controls stays visible). The
       stack is COLLAPSED by default. */
    #ctl-toggle {
      display: flex; align-items: center; justify-content: center;
      height: 14px; margin: 8px 10px 0;
      cursor: pointer; user-select: none;
    }
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
      scrollbar-color: rgba(255, 255, 255, 0.22) transparent;
    }
    .ctl-cards::-webkit-scrollbar { width: 8px; }
    .ctl-cards::-webkit-scrollbar-track { background: transparent; }
    .ctl-cards::-webkit-scrollbar-thumb { background: rgba(255, 255, 255, 0.22); border-radius: 4px; }
    .ctl-cards::-webkit-scrollbar-thumb:hover { background: rgba(255, 255, 255, 0.36); }
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
    .mcp-status.ok { color: #98c379; }
    .mcp-status.err { color: var(--error, #f05555); }
    .mcp-status .mcp-name { cursor: pointer; }
    .mcp-status .mcp-detail { color: #9a9a9a; }
    .mcp-tools-btn {
      background: transparent; border: none; padding: 0; cursor: pointer;
      color: var(--accent); font-size: var(--fs-sm); text-decoration: underline;
    }
    .mcp-tools-btn:hover { color: var(--accent-strong, var(--accent)); }
    /* Tool-list popover: a small floating card anchored to the (N tools) key. */
    #mcp-tools-popover {
      position: fixed; z-index: 60; max-width: min(30rem, 90vw); max-height: 60vh; overflow: auto;
      background: var(--bg, #1e1e1e); border: 1px solid var(--border); border-radius: 8px;
      padding: 8px 10px; box-shadow: 0 6px 24px rgba(0, 0, 0, 0.5);
    }
    #mcp-tools-popover.hidden { display: none; }
    .mcp-pop-title { font-weight: 600; margin-bottom: 6px; }
    .mcp-pop-empty { color: #9a9a9a; font-size: var(--fs-sm); }
    .mcp-pop-item { padding: 4px 0; border-top: 1px solid var(--border); }
    .mcp-pop-item:first-of-type { border-top: none; }
    .mcp-pop-name { font-family: var(--font-mono); font-size: var(--fs-sm); color: var(--fg); }
    .mcp-pop-desc { font-size: var(--fs-sm); color: #9a9a9a; white-space: pre-wrap; overflow-wrap: anywhere; }
    /* Slash menu: skill autocomplete above the prompt. Only shown when the
       prompt STARTS with "/" and has no whitespace yet. */
    #slash-menu {
      position: fixed; z-index: 40; max-height: 40vh; overflow: auto;
      background: var(--bg, #1e1e1e); border: 1px solid var(--border); border-radius: 8px;
      padding: 4px; box-shadow: 0 6px 24px rgba(0, 0, 0, 0.5);
    }
    #slash-menu.hidden { display: none; }
    .slash-item { display: flex; flex-direction: column; gap: 1px; padding: 5px 8px; border-radius: 6px; cursor: pointer; }
    .slash-item.active, .slash-item:hover { background: rgba(255, 255, 255, 0.08); }
    .slash-cmd { font-family: var(--font-mono); font-size: var(--fs-md); color: var(--fg); }
    .slash-desc { font-size: var(--fs-sm); color: #9a9a9a; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }
    #mcp-modal { position: fixed; inset: 0; z-index: 50; }
    #mcp-modal.hidden { display: none; }
    .mcp-backdrop { position: absolute; inset: 0; background: rgba(0, 0, 0, 0.5); }
    .mcp-card {
      position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%);
      width: min(46rem, 94vw); max-height: 88vh; overflow: auto;
      background: var(--bg, #1e1e1e); border: 1px solid var(--border); border-radius: 10px; padding: 14px;
      display: flex; flex-direction: column; gap: 10px;
    }
    .mcp-head h3 { margin: 0 0 2px; }
    .mcp-hint { font-size: var(--fs-sm); color: #9a9a9a; }
    .mcp-body { display: flex; gap: 12px; align-items: flex-start; }
    .mcp-list-col { display: flex; flex-direction: column; gap: 6px; min-width: 11rem; }
    #mcp-select { min-height: 9rem; background: var(--input-bg); color: var(--fg); border: 1px solid var(--border); border-radius: 6px; padding: 4px; }
    .mcp-list-actions { display: flex; gap: 6px; }
    .mcp-form-col { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 8px; }
    .mcp-form-col input[type="text"], .mcp-form-col textarea { background: var(--input-bg); color: var(--fg); border: 1px solid var(--border); border-radius: 6px; padding: 4px 6px; font-size: var(--fs-md); }
    .mcp-form-col textarea { font-family: var(--font-mono); resize: vertical; }
    .mcp-form-actions { display: flex; align-items: center; gap: 8px; }
    .mcp-enabled-row { display: flex; align-items: center; gap: 6px; font-size: var(--fs-sm); color: #9a9a9a; cursor: pointer; }
    .mcp-enabled-row input { accent-color: var(--accent); }
    /* A disabled server is grayed out (name + detail). */
    .mcp-status.off, .mcp-status.off .mcp-name, .mcp-status.off .mcp-detail { color: #777; }
    .mcp-io { font-size: var(--fs-sm); color: #9a9a9a; }
    .mcp-io.ok { color: #98c379; }
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
      border: 1px solid rgba(255, 255, 255, 0.14); border-radius: 6px;
      padding: 6px 8px; font-size: var(--fs-xs); line-height: 1.35;
      box-shadow: 0 6px 18px rgba(0, 0, 0, 0.45);
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
      font-size: var(--fs-xs); color: #9a9a9a;
    }
    .lg-name { grid-area: name; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    /* The value is a read-only LABEL (the slider is the only control). */
    .lg-value { grid-area: val; text-align: right; color: var(--fg); font-variant-numeric: tabular-nums; }
    .lg-range { grid-area: range; width: 100%; height: 14px; margin: 0; accent-color: var(--accent); cursor: pointer; }
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
       choices. The button is painted in the mode accent (terracotta for
       Analyze, violet for Agent) with WHITE icon + label on top — maximum
       contrast on the colored surface. It sits on the AI Model row, so the
       dropdown is anchored to the button (z-index keeps it above the cards). */
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
      border: none;
      border-radius: 999px;
      background: linear-gradient(135deg, var(--accent), var(--accent-strong));
      color: #ffffff;
      font-size: var(--fs-sm);
      font-weight: 600;
      letter-spacing: 0.01em;
      cursor: pointer;
      white-space: nowrap;
      box-shadow: 0 1px 2px rgba(0, 0, 0, 0.35), 0 0 10px rgba(217, 95, 39, 0.28);
      transition: box-shadow 0.18s, transform 0.12s, opacity 0.18s;
    }
    #mode-btn:hover { box-shadow: 0 1px 3px rgba(0, 0, 0, 0.45), 0 0 14px rgba(217, 95, 39, 0.42); }
    #mode-btn:active { transform: scale(0.96); }
    #mode-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    /* Agent mode: violet (white icon stays). */
    #mode-btn.is-agent { background: linear-gradient(135deg, #8b6cff, #5a3df0); box-shadow: 0 1px 2px rgba(0, 0, 0, 0.35), 0 0 12px rgba(124, 92, 255, 0.4); }
    #mode-btn.is-agent:hover { box-shadow: 0 1px 3px rgba(0, 0, 0, 0.45), 0 0 16px rgba(124, 92, 255, 0.52); }
    #mode-btn:disabled { opacity: 0.55; cursor: default; transform: none; box-shadow: none; }
    #mode-btn-icon-analyze, #mode-btn-icon-agent { flex-shrink: 0; }
    #mode-btn-icon-analyze.hidden, #mode-btn-icon-agent.hidden { display: none; }
    /* Chevron rotates when the dropdown is open. */
    #mode-btn .mode-btn-chevron { flex-shrink: 0; color: rgba(255, 255, 255, 0.85); transition: transform 0.18s; }
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
      box-shadow: 0 8px 20px rgba(0, 0, 0, 0.55);
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
    /* Icon + check tinted by mode accent (safe here: dark menu background). */
    .mode-item[data-mode="analyze"] svg { color: var(--accent); }
    .mode-item[data-mode="agent"] svg { color: #a98dff; }
    .mode-item.is-active:not(:hover) { background: rgba(255, 255, 255, 0.06); }
    .mode-check { margin-left: 2px; flex-shrink: 0; visibility: hidden; }
    .mode-item.is-active .mode-check { visibility: visible; color: var(--accent); }
    .mode-item[data-mode="agent"].is-active .mode-check { color: #a98dff; }

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
      box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.3);
      transition: background 0.18s, box-shadow 0.18s, color 0.18s, border-color 0.18s, opacity 0.18s;
    }
    #parallel-btn svg { flex-shrink: 0; color: var(--muted); transition: color 0.18s; }
    #parallel-btn:hover { border-color: rgba(255, 255, 255, 0.25); color: var(--fg-strong); }
    #parallel-btn:hover svg { color: var(--fg); }
    #parallel-btn:focus-visible { outline: 2px solid #4c8dff; outline-offset: 2px; }
    #parallel-btn:disabled { opacity: 0.45; cursor: default; box-shadow: none; }
    #parallel-btn.is-on {
      background: linear-gradient(135deg, #4c8dff, #2f6fed);
      border-color: transparent;
      color: #ffffff;
      box-shadow: 0 1px 2px rgba(0, 0, 0, 0.35), 0 0 12px rgba(76, 141, 255, 0.4);
    }
    #parallel-btn.is-on svg { color: #ffffff; }
    #parallel-btn.is-on:hover { box-shadow: 0 1px 3px rgba(0, 0, 0, 0.45), 0 0 16px rgba(76, 141, 255, 0.55); }

    /* Queue/Steer pill: same family as Parallel, sitting between the mode
       select and Parallel. It is a pure INDICATOR (never clickable): Queue by
       default, Steer (muted red) only while working with Ctrl/Cmd held. */
    #steer-btn {
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
      cursor: default;
      pointer-events: none;
      white-space: nowrap;
      flex-shrink: 0;
      box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.3);
      transition: background 0.18s, box-shadow 0.18s, color 0.18s, border-color 0.18s, opacity 0.18s;
    }
    #steer-btn svg { flex-shrink: 0; color: var(--muted); transition: color 0.18s; }
    #steer-btn:disabled { opacity: 0.45; box-shadow: none; }
    #steer-btn.is-steer {
      background: linear-gradient(135deg, #b23b3b, #8f2d2d);
      border-color: transparent;
      color: #ffffff;
      box-shadow: 0 1px 2px rgba(0, 0, 0, 0.35), 0 0 12px rgba(178, 59, 59, 0.4);
    }
    #steer-btn.is-steer svg { color: #ffffff; }
    #steer-btn.is-steer:hover:not(:disabled) { box-shadow: 0 1px 3px rgba(0, 0, 0, 0.45), 0 0 16px rgba(178, 59, 59, 0.55); }

    .card-title {
      font-size: var(--fs-xs); font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase;
      color: #8a8a8a; user-select: none;
    }
    .field { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
    /* ONE control-row height for the whole control stack: label rows, slider
       rows and radio groups all share it, so the LEFT and RIGHT columns line up
       horizontally. Deliberately small, so nothing looks padded. */
    #ctl-cards { --ctl-row: 1.4rem; }
    #ctl-cards .field-label { display: flex; align-items: center; min-height: var(--ctl-row); }
    .field-label { font-size: var(--fs-sm); color: #9a9a9a; }
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
    #input-area .model-label { color: #999; }
    /* The stepper fills its card field; the −/+ keys stay a tight unit inside. */
    #ctx-window, #out-window, #samp-window, #presence-window, #freq-window, #par-window { display: inline-flex; align-items: center; gap: 2px; width: 100%; }
    #ctx-input, #out-input, #samp-input, #presence-input, #freq-input, #par-input {
      flex: 1; min-width: 2.5rem; width: auto; height: 1.85rem; background: var(--input-bg); color: var(--fg);
      border: 1px solid var(--border); border-radius: 6px; padding: 1px 6px;
      font-size: var(--fs-md); text-align: right;
    }
    #ctx-input:focus, #out-input:focus, #samp-input:focus, #presence-input:focus, #freq-input:focus, #par-input:focus { border-color: var(--accent); outline: none; }
    /* Empty float input = Auto (not sent): neutral italic hint. */
    #samp-input::placeholder, #presence-input::placeholder, #freq-input::placeholder { color: #777; font-style: italic; }
    /* Sampler selector: native radios on ONE slim row occupying the same
       slot/height as the other field labels (no pill, no box). */
    .sampler-toggle { display: inline-flex; align-items: center; gap: 8px; flex-wrap: wrap; row-gap: 4px; min-height: var(--ctl-row, 1.4rem); }
    .sampler-opt {
      display: inline-flex; align-items: center; gap: 4px;
      font-size: var(--fs-sm);
      color: #9a9a9a; cursor: pointer; user-select: none;
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
      margin: 0 10px 8px; color: #9a9a9a;
      background: var(--input-bg);
    }
    .metrics-stats { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; font-size: var(--fs-sm); }
    .metrics-stats .model-label { color: #999; }
    .metrics-stats .met { white-space: nowrap; }
    .met-sep { color: #666; }
    #met-pct {
      padding: 0 6px; border: 1px solid var(--border); border-radius: 10px;
      background: rgba(255, 255, 255, 0.05);
    }
    #met-pct.warn { color: var(--error); border-color: var(--error); background: rgba(244, 71, 71, 0.1); }
    #met-cache { white-space: nowrap; color: var(--accent); }
    /* Placeholder state: provider does not report cached tokens. */
    #met-cache.idle { color: #888; }
    /* The bar is the hero: a full-width row of its own. The Compact key lives
       in the stats row above, right after the cache indicator. */
    #ctx-bar-wrap {
      width: 100%; height: 8px; border-radius: 4px;
      background: var(--tool-bg); border: 1px solid var(--border); overflow: hidden;
      box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.25);
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
      background: linear-gradient(to bottom, rgba(255, 255, 255, 0.14), rgba(255, 255, 255, 0.02)),
        var(--tool-bg, transparent);
      border: 1px solid var(--border); color: var(--fg);
      border-radius: 6px; padding: 4px 8px; font-size: var(--fs-sm); cursor: pointer;
      box-shadow:
        inset 0 1px 0 rgba(255, 255, 255, 0.18),
        inset 0 -1px 0 rgba(0, 0, 0, 0.18),
        0 1px 2px rgba(0, 0, 0, 0.28);
      transition: color 0.12s, border-color 0.12s, box-shadow 0.12s, transform 0.08s;
    }
    #compact-btn:hover:not(:disabled) { color: var(--accent); }
    #compact-btn:active:not(:disabled) {
      transform: translateY(1px);
      box-shadow: inset 0 1px 3px rgba(0, 0, 0, 0.35);
    }
    /* The gear keys are styled by the shared .gear-btn rule (same graphic and
       size everywhere) — see below. */
    #compact-threshold-label {
      flex: 0 0 auto; white-space: nowrap;
      font-size: var(--fs-sm); color: #9a9a9a;
    }
    #compact-btn:disabled { opacity: 0.4; }

    /* Empty shell (no open session): hide the whole control stack and show a
       hero that pushes the user to pick a session or create a new one. */
    body.no-session #input-area,
    body.no-session #status,
    body.no-session #metrics { display: none; }
    /* No (single) workspace: sessions/tabs/controls are all hidden; the foldes
       hero asks the user to open one folder. Takes precedence over no-session. */
    body.no-workspace #sessions-card,
    body.no-workspace #tabs,
    body.no-workspace #input-area,
    body.no-workspace #status,
    body.no-workspace #metrics { display: none; }
    /* Point the eye up at the sessions list: the second path to act. */
    body.no-session #session-head { color: var(--accent); }
    .empty-hero {
      flex: 1; display: flex; flex-direction: column; align-items: center;
      justify-content: center; gap: 8px; padding: 24px; text-align: center;
      color: #9a9a9a;
    }
    .empty-hero .empty-icon { font-size: var(--fs-hero); }
    /* Brand mark in place of the emoji: sized to match the old glyph, muted
       like the rest of the hero, accent on hover for a touch of life. */
    .empty-hero .empty-logo svg { width: 2.4rem; height: 2.4rem; display: block; }
    .empty-hero .empty-logo { color: var(--muted); }
    .empty-hero .empty-logo:hover { color: var(--accent); }
    .empty-hero h2 { margin: 0; font-size: var(--fs-xl); color: var(--fg-strong); font-weight: 700; }
    .empty-hero .empty-version { font-size: var(--fs-sm); color: #888; margin-top: -2px; }
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
      background: linear-gradient(to bottom, rgba(255, 255, 255, 0.16), rgba(255, 255, 255, 0.03)),
        var(--tool-bg, transparent);
      border: 1px solid var(--border); color: var(--fg); border-radius: 4px;
      display: inline-flex; align-items: center; justify-content: center; cursor: pointer;
      box-shadow:
        inset 0 1px 0 rgba(255, 255, 255, 0.2),
        inset 0 -1px 0 rgba(0, 0, 0, 0.2),
        0 1px 2px rgba(0, 0, 0, 0.3);
    }
    .ctx-btn:hover:not(:disabled) { color: var(--accent); }
    .ctx-btn:active:not(:disabled) {
      transform: translateY(1px);
      box-shadow: inset 0 1px 3px rgba(0, 0, 0, 0.35);
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
      color: var(--accent); background: rgba(255, 255, 255, 0.08);
    }
    .gear-btn:disabled, #session-head .gear-btn:disabled { opacity: 0.5; cursor: default; }
    /* Providers & Models modal (gear editor). */
    #providers-modal { position: fixed; inset: 0; z-index: 50; }
    #providers-modal.hidden { display: none; }
    #providers-modal .providers-backdrop {
      position: absolute; inset: 0; background: rgba(0, 0, 0, 0.5);
    }
    #providers-modal .providers-card {
      position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%);
      width: min(700px, calc(100% - 20px)); max-height: 92%;
      background: var(--bg, #1e1e1e); border: 1px solid var(--border);
      border-radius: 12px; padding: 18px 20px; display: flex; flex-direction: column;
      gap: 12px; box-shadow: 0 8px 30px rgba(0, 0, 0, 0.5);
      font-size: var(--fs-lg);
    }
    #providers-modal h3 { margin: 0; font-size: var(--fs-xl); font-weight: 700; color: var(--fg-strong); }
    .providers-head { display: flex; flex-direction: column; gap: 4px; }
    .providers-hint { font-size: var(--fs-sm); color: var(--muted, #999); }
    .providers-body {
      display: grid; grid-template-columns: 190px 1fr; gap: 16px; min-height: 0;
      flex: 1;
    }
    .provider-list-col { display: flex; flex-direction: column; gap: 8px; min-height: 0; }
    .provider-list-head { display: flex; align-items: center; justify-content: space-between; font-size: var(--fs-sm); color: #9a9a9a; }
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
    .providers-io { margin-right: auto; align-self: center; font-size: var(--fs-sm); color: var(--muted, #999); }
    .providers-io.ok { color: #4ec9b0; }
    .providers-io.err { color: var(--error, #f05555); }
    #provider-test-result {
      font-size: var(--fs-md); line-height: 1.5; border-radius: 6px; padding: 8px 10px;
      background: rgba(255, 255, 255, 0.05); word-break: break-all;
    }
    #provider-test-result.ok { color: #4ec9b0; }
    #provider-test-result.err { color: var(--error, #f05555); }

    /* The Auto reset is a SEPARATE key, clearly detached from the + spinner. */
    #samp-auto, #presence-auto, #freq-auto { margin-left: 6px; width: auto; padding: 0 0.5rem; }
    /* Hide the browser's native number spinners; we use our own − / + buttons. */
    #ctx-input::-webkit-outer-spin-button,
    #ctx-input::-webkit-inner-spin-button,
    #out-input::-webkit-outer-spin-button,
    #out-input::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
    #ctx-input, #out-input { -moz-appearance: textfield; }

    /* ── Session-name modal (in the Harny panel): full-area overlay, blurred ── */
    #name-modal {
      position: fixed; inset: 0; z-index: 100;
      display: flex; align-items: center; justify-content: center;
    }
    #name-modal.hidden { display: none; }
    #name-modal .name-modal-backdrop {
      position: absolute; inset: 0;
      background: rgba(0,0,0,0.45);
      backdrop-filter: blur(4px);
      -webkit-backdrop-filter: blur(4px);
    }
    #name-modal .name-modal-card {
      position: relative;
      width: min(85%, 340px);
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 14px;
      box-shadow: 0 8px 30px rgba(0,0,0,0.35);
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

    /* ── Compaction settings (gear after Compact): threshold % form ── */
    #compact-settings-modal {
      position: fixed; inset: 0; z-index: 100;
      display: flex; align-items: center; justify-content: center;
    }
    #compact-settings-modal.hidden { display: none; }
    #compact-settings-modal .cs-backdrop {
      position: absolute; inset: 0;
      background: rgba(0, 0, 0, 0.45);
      backdrop-filter: blur(4px);
      -webkit-backdrop-filter: blur(4px);
    }
    #compact-settings-modal .cs-card {
      position: relative;
      width: min(85%, 360px);
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 14px;
      box-shadow: 0 8px 30px rgba(0, 0, 0, 0.35);
      display: flex; flex-direction: column; gap: 10px;
    }
    #compact-settings-modal h3 { margin: 0; font-size: var(--fs-lg); font-weight: 700; color: var(--fg-strong); }
    #compact-settings-modal .cs-hint {
      margin: 0; font-size: var(--fs-sm); color: #9a9a9a; line-height: 1.45;
    }
    #compact-settings-modal .cs-field { display: flex; flex-direction: column; gap: 6px; }
    #compact-settings-modal .cs-field label { font-size: var(--fs-sm); color: #9a9a9a; }
    #compact-settings-modal #compact-threshold-input {
      width: 100%; box-sizing: border-box;
      background: var(--input-bg); color: var(--fg);
      border: 1px solid var(--border); border-radius: 6px; padding: 6px 8px;
      font-size: var(--fs-lg); outline: none;
    }
    #compact-settings-modal #compact-threshold-input:focus { border-color: var(--accent); }
    #compact-settings-modal #compact-threshold-input::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
    #compact-settings-modal #compact-threshold-input { -moz-appearance: textfield; }
    #compact-settings-modal .cs-actions { display: flex; justify-content: flex-end; gap: 8px; }

    /* ── In-panel alert / confirm modal (same family as the name modal) ── */
    #alert-modal {
      position: fixed; inset: 0; z-index: 110;
      display: flex; align-items: center; justify-content: center;
    }
    #alert-modal.hidden { display: none; }
    #alert-modal .alert-backdrop {
      position: absolute; inset: 0;
      background: rgba(0, 0, 0, 0.45);
      backdrop-filter: blur(4px);
      -webkit-backdrop-filter: blur(4px);
    }
    #alert-modal .alert-card {
      position: relative;
      width: min(85%, 340px);
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 14px;
      box-shadow: 0 8px 30px rgba(0, 0, 0, 0.35);
      display: flex; flex-direction: column; gap: 10px;
    }
    #alert-modal h3 { margin: 0; font-size: var(--fs-lg); font-weight: 700; color: var(--fg-strong); }
    #alert-modal .alert-message {
      font-size: var(--fs-md); color: #bbb; line-height: 1.5;
      word-wrap: break-word; white-space: pre-wrap;
    }
    #alert-modal .alert-actions { display: flex; justify-content: flex-end; gap: 8px; }
    #alert-ok.danger { background: var(--error); }

    /* ── All-sessions manager (gear next to New session ──
       Lists sessions of EVERY folder, most recent first. Red rows = the
       session's folder is no longer available (open disabled until a valid
       folder is picked). */
    #sessions-modal { position: fixed; inset: 0; z-index: 60; }
    #sessions-modal.hidden { display: none; }
    #sessions-modal .sm-backdrop {
      position: absolute; inset: 0; background: rgba(0, 0, 0, 0.5);
    }
    #sessions-modal .sm-card {
      position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%);
      width: min(680px, calc(100% - 20px)); max-height: 92%;
      background: var(--bg, #1e1e1e); border: 1px solid var(--border);
      border-radius: 12px; padding: 18px 20px; display: flex; flex-direction: column;
      gap: 12px; box-shadow: 0 8px 30px rgba(0, 0, 0, 0.5); font-size: var(--fs-lg);
    }
    #sessions-modal h3 { margin: 0; font-size: var(--fs-xl); font-weight: 700; color: var(--fg-strong); }
    #sessions-modal .sm-hint { font-size: var(--fs-sm); color: var(--muted, #999); }
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
    .sm-row .sm-meta { font-size: var(--fs-sm); color: #888; }
    .sm-row .sm-folder {
      font-size: var(--fs-sm); color: #777;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0;
      cursor: default;
    }
    .sm-row .sm-folder.missing { color: var(--error); }
    /* Unknown (not set) folder is NEUTRAL, not red: only a KNOWN path that is
       no longer available is a problem (red). */
    .sm-row .sm-folder.unset { color: #999; font-style: italic; }
    .sm-actions { display: inline-flex; gap: 6px; flex-shrink: 0; }
    .sm-actions button { min-height: 1.54rem; font-size: var(--fs-md); }
    .sm-actions button.secondary-ghost {
      background: transparent; border: 1px solid var(--border); color: var(--fg);
    }
    .sm-actions button:disabled { opacity: 0.3; cursor: default; }
    #sessions-modal .sm-footer { display: flex; justify-content: flex-end; }
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
    .sm-row .sm-snippet { font-size: var(--fs-sm); color: #999; overflow-wrap: anywhere; }
    .sm-row .sm-snippet b { color: var(--accent); font-weight: 600; }
    .sm-empty { padding: 18px; text-align: center; color: #888; font-size: var(--fs-lg); }
    /* Main sessions list: no-match hint. */
    #sessions .empty.no-match { font-style: italic; }

    /* ── "Select model" modal (filterable, provider tree preserved) ── */
    #model-modal { position: fixed; inset: 0; z-index: 70; }
    #model-modal.hidden { display: none; }
    #model-modal .mm-backdrop { position: absolute; inset: 0; background: rgba(0, 0, 0, 0.5); }
    #model-modal .mm-card {
      position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%);
      width: min(560px, calc(100% - 20px)); max-height: 88%;
      background: var(--bg, #1e1e1e); border: 1px solid var(--border);
      border-radius: 12px; padding: 16px 18px; display: flex; flex-direction: column; gap: 10px;
      box-shadow: 0 8px 30px rgba(0, 0, 0, 0.5); font-size: var(--fs-lg);
    }
    #model-modal .mm-head { display: flex; align-items: center; justify-content: space-between; }
    #model-modal h3 { margin: 0; font-size: var(--fs-xl); font-weight: 700; color: var(--fg-strong); }
    #model-modal .mm-search { display: flex; }
    #model-search {
      width: 100%; background: var(--surface-2); color: var(--fg);
      border: 1px solid var(--border); border-radius: 6px; padding: 6px 8px;
      font-size: var(--fs-lg); outline: none;
    }
    #model-search:focus { border-color: var(--accent); }
    #model-list { display: flex; flex-direction: column; gap: 5px; overflow-y: auto; min-height: 160px; flex: 1; }
    /* Provider header: the tree is PRESERVED when filtering (only matching
       models remain, empty providers drop out). */
    .mm-provider {
      display: flex; align-items: center; gap: 6px; margin-top: 6px; padding: 2px 4px;
      font-size: var(--fs-sm); font-weight: 700; letter-spacing: 0.03em; text-transform: uppercase;
      color: var(--muted); position: sticky; top: 0; background: var(--bg, #1e1e1e);
    }
    .mm-provider .mm-count { font-weight: 500; color: #777; text-transform: none; }
    /* Plain list rows: cancel the global "key" chrome (bevel/shadow/press).
       Hover just lightens the background. Id-prefixed so it beats the
       button:not(:disabled):hover filter. */
    #model-list .mm-model {
      display: flex; align-items: center; gap: 8px; width: 100%; text-align: left;
      padding: 9px 12px 9px 18px; border-radius: 8px; min-height: 0;
      justify-content: flex-start; box-shadow: none;
      background: transparent; border: 1px solid transparent; color: var(--fg);
      cursor: pointer; font-size: var(--fs-lg);
      transition: background-color 0.12s;
    }
    #model-list .mm-model:hover { background: var(--surface-2); filter: none; transform: none; }
    #model-list .mm-model:active { transform: none; box-shadow: none; filter: none; }
    #model-list .mm-model:focus { outline: none; border-color: var(--accent); background: var(--surface-2); }
    /* The current model: a light accent tint so it reads as "selected". */
    #model-list .mm-model.is-current { background: rgba(217, 95, 39, 0.16); }
    #model-list .mm-model.is-current:hover { background: rgba(217, 95, 39, 0.24); }
    .mm-model .mm-model-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .mm-model .mm-ctx { flex: none; font-size: var(--fs-sm); color: #888; }
    .mm-model.is-current { color: var(--accent); font-weight: 600; }
    .mm-model .mm-check { flex: none; color: var(--accent); }
    .mm-error { padding: 4px 8px 4px 20px; font-size: var(--fs-sm); color: var(--error); }
    .mm-empty { padding: 18px; text-align: center; color: #888; font-size: var(--fs-lg); }
  </style>
</head>
<body class="controls-collapsed">
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
       outside #messages, so they survive streaming re-renders. -->
  <div id="pending-area" class="hidden"></div>
  <!-- Working indicator: the BOTTOM-most footer, always BELOW the transcript
       and the pending bubbles. -->
  <div id="working-bar" class="hidden">● Working...</div>
  <!-- Control stack toggle: a slim hover-hot strip just above the ask card.
       On hover a chevron appears; clicking collapses/expands the Window +
       Sampling cards (#ctl-cards) while the ask card (with the AI Model row
       at its head) and the metrics stay visible. -->
  <div id="ctl-toggle" title="Toggle the controls below" aria-expanded="false">
    <button id="ctl-toggle-btn" aria-label="Toggle controls">
      <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>
    </button>
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
      <!-- Queue/Steer: an INDICATOR (not a control) for how a message typed
           while the agent works is applied. Queue by default; it shows Steer
           only while working with Ctrl/Cmd held (the message is then injected
           into the running loop at the next turn boundary). -->
      <button type="button" id="steer-btn" tabindex="-1" aria-pressed="false"
              title="Queue: the next message runs after the current run ends">
        <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h10" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" fill="none"/></svg>
        <span id="steer-btn-label">Queue</span>
      </button>
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
          <label class="field-label" for="ctx-range">Context window</label>
          <div class="num-row">
            <input type="range" id="ctx-range" class="num-range" min="${MIN_CONTEXT_WINDOW}" max="${MAX_CONTEXT_WINDOW}" step="1000" aria-label="Context window" />
            <span class="num-value" id="ctx-value">${DEFAULT_CONTEXT_WINDOW}</span>
          </div>
        </div>
        <div class="field">
          <label class="field-label" for="out-range">Output tokens</label>
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
              <label class="sampler-opt" title="Aggressive: flags loops sooner (more nudges, lower thresholds)"><input type="radio" name="lg-level" id="lg-high" value="high" />High</label>
              <label class="sampler-opt" title="Balanced: the default preset"><input type="radio" name="lg-level" id="lg-normal" value="normal" checked />Normal</label>
              <label class="sampler-opt" title="Permissive: only clear, sustained loops are flagged"><input type="radio" name="lg-level" id="lg-low" value="low" />Low</label>
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
      <span class="met" id="met-ctx" title="Context window (tokens)">${DEFAULT_CONTEXT_WINDOW}</span>
      <span class="met pct" id="met-pct">(0%)</span>
      <span class="met" id="met-cache" title="Input tokens served from prompt cache"></span>
      <button id="compact-btn" title="Compact the conversation context">Compact</button>
      <span id="compact-threshold-label" title="Context fill % that triggers auto-compaction (set via the gear)">Auto Compact threshold: 80%</span>
      <button id="compact-settings-btn" class="gear-btn" title="Set the context fill % that auto-compacts"><svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><path d="M19.4 13a7.6 7.6 0 0 0 .1-1 7.6 7.6 0 0 0-.1-1l2.1-1.7a.5.5 0 0 0 .1-.7l-2-3.5a.5.5 0 0 0-.6-.2l-2.5 1a7.6 7.6 0 0 0-1.7-1L14.5 2.4a.5.5 0 0 0-.5-.4h-4a.5.5 0 0 0-.5.4l-.4 2.5a7.6 7.6 0 0 0-1.7 1l-2.5-1a.5.5 0 0 0-.6.2l-2 3.5a.5.5 0 0 0 .1.7L4.5 11a7.6 7.6 0 0 0-.1 1 7.6 7.6 0 0 0 .1 1l-2.1 1.7a.5.5 0 0 0-.1.7l2 3.5a.5.5 0 0 0 .6.2l2.5-1a7.6 7.6 0 0 0 1.7 1l.4 2.5a.5.5 0 0 0 .5.4h4a.5.5 0 0 0 .5-.4l.4-2.5a7.6 7.6 0 0 0 1.7-1l2.5 1a.5.5 0 0 0 .6-.2l2-3.5a.5.5 0 0 0-.1-.7zM12 15.5A3.5 3.5 0 1 1 12 8.5a3.5 3.5 0 0 1 0 7z" fill="currentColor"/></svg></button>
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
      <h3>Compaction settings</h3>
      <p class="cs-hint">Auto-compaction runs when the conversation reaches this percentage of the declared context window.</p>
      <div class="cs-field">
        <label for="compact-threshold-input">Compaction threshold (%)</label>
        <input id="compact-threshold-input" type="number" inputmode="numeric" min="1" max="100" step="1" autocomplete="off" spellcheck="false" />
      </div>
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
      <div class="sm-footer">
        <button id="sessions-close" class="secondary">Close</button>
      </div>
    </div>
  </div>
  <div id="model-modal" class="hidden">
    <div class="mm-backdrop"></div>
    <div class="mm-card">
      <div class="mm-head">
        <h3>Select model</h3>
        <button id="model-close" class="secondary-ghost" title="Close" aria-label="Close">✕</button>
      </div>
      <div class="mm-search">
        <input id="model-search" type="search" placeholder="Search models" spellcheck="false" autocomplete="off" aria-label="Search models" />
      </div>
      <div id="model-list"></div>
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
        <span id="providers-io-result" class="providers-io"></span>
        <button id="providers-cancel" class="secondary">Cancel</button>
        <button id="providers-save">Save</button>
      </div>
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
