import { FONTS, FAMILIES, PALETTE, ROOT_FONT_SIZE } from "./view-config";
import type { ChatMessage } from "../core/history/types";
import type { SessionSummary } from "../core/sessions/types";
import { DEFAULT_CONTEXT_WINDOW, DEFAULT_OUTPUT_TOKENS } from "./context-window";

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
  /** Session ids whose agent is streaming (disabled delete buttons in the list). */
  workingIds: string[];
  /** Whether the active session is mid-stream (initial lock + live restore). */
  streaming: boolean;
  /** Live (uncommitted) thinking/answer of the in-flight turn, for replay. */
  liveThinking: string;
  liveAnswer: string;
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
    body {
      font-size: 1rem;
      background: var(--bg);
      color: var(--fg);
      height: 100vh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
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
    /* Manage-all-sessions gear: default (muted) color like the other gear, so
       it does not compete with the accent-colored +; accent only on hover.
       Specificity: must beat the header's accent-colored button rule, hence
       the doubled ID. */
    #session-head #sessions-gear-btn { color: var(--muted); }
    /* Hover touches ONLY the icon: neutralise the header buttons' tinted
       background pill (it reads as a button border lighting up). */
    #session-head #sessions-gear-btn:hover:not(:disabled) { color: var(--accent); background: transparent; }
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
      border-bottom: 1px solid var(--border); overflow-x: auto; flex-shrink: 0;
      scrollbar-width: none;
    }
    #tabs::-webkit-scrollbar { display: none; }
    .tab {
      position: relative;
      display: inline-flex; align-items: center; gap: 5px;
      padding: 4px 10px; border-radius: 6px 6px 0 0; cursor: pointer;
      font-size: var(--fs-md); white-space: nowrap; color: #9a9a9a;
      border: 1px solid transparent; border-bottom: none;
      background: linear-gradient(to bottom, rgba(255, 255, 255, 0.05), rgba(255, 255, 255, 0));
      box-shadow: inset 0 -1px 0 rgba(0, 0, 0, 0.1);
      transition: color 0.12s, background-color 0.12s, box-shadow 0.12s;
      max-width: 12rem; min-width: 0; flex-shrink: 1;
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

    /* Chat */
    /* scrollbar-gutter: stable reserves the scrollbar slot even when no
       scrollbar is shown — the bubble column width stays IDENTICAL whether or
       not the scrollbar appears. padding-right:0 lets the 10px gutter play the
       role of the right margin, so the chat column matches the controls below
       (same width, symmetric 10px gaps: paddings left 10 / gutter 10 right). */
    #messages {
      flex: 1; overflow-y: auto; scrollbar-gutter: stable;
      padding: 10px 0 0 10px;
      display: flex; flex-direction: column; gap: 6px;
    }
    .msg { padding: 8px 10px; border-radius: 8px; max-width: 92%; word-wrap: break-word; word-break: break-word; overflow-wrap: break-word; line-height: 1.4; font-size: var(--fs-lg); }
    /* pre-wrap only for plain-text bubbles (user messages); markdown bubbles
       (assistant/tool) use breaks:true and white-space normal to avoid the
       ghost blank lines produced by markdown's structural newlines. */
    .msg.user { align-self: flex-end; background: var(--user-msg); color: #fff; white-space: pre-wrap; }
    /* "Sent with these files" chips inside a user bubble: the message keeps the
       typed prompt; the attached documents are shown as a compact indicator
       (their contents live in the LLM context, not in the transcript). */
    .msg-attachments { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
    .msg-attach {
      display: inline-flex; align-items: center; gap: 4px; max-width: 100%;
      padding: 1px 7px; border-radius: 999px; font-size: var(--fs-sm);
      /* Darker than the terracotta bubble so the white label pops (contrast). */
      background: rgba(0, 0, 0, 0.5); border: 1px solid rgba(0, 0, 0, 0.5);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .msg.assistant, .msg.tool { width: 100%; max-width: 100%; }
    .msg.assistant { align-self: flex-start; background: var(--assistant-msg); min-width: 0; position: relative; font-size: var(--fs-lg); }
    /* Branch-from-this-point: a small ⎇ key on assistant replies, revealed on
       hover (top-right), mirroring the sessions-list branch action. */
    .branch-at {
      position: absolute; top: 4px; right: 6px; z-index: 3;
      background: rgba(255, 255, 255, 0.06); border: 1px solid var(--border);
      border-radius: 5px; color: #9a9a9a; font-size: var(--fs-sm); line-height: 1;
      padding: 3px 6px; cursor: pointer;
      opacity: 0; pointer-events: none;
      transition: opacity 0.12s, color 0.12s, border-color 0.12s, background-color 0.12s;
    }
    .msg.assistant:hover .branch-at { opacity: 1; pointer-events: auto; }
    /* Disabled (session working): fully inert — no hover reaction, hidden. */
    .msg.assistant:hover .branch-at:disabled { opacity: 0; pointer-events: none; }
    .branch-at:hover:not(:disabled) { color: var(--accent); border-color: var(--accent); background: rgba(255, 255, 255, 0.1); }
    .msg.assistant.error { background: rgba(244, 71, 71, 0.15); border: 1px solid var(--error); }
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
    .subagent-header { gap: 6px; }
    .subagent-header .subagent-icon { color: #a98dff; vertical-align: -2px; }
    #working-bar .subagent-icon { vertical-align: -2px; }
    .subagent-role { color: #a98dff; font-weight: 500; }
    .subagent-status {
      margin-left: auto; flex-shrink: 0;
      font-size: var(--fs-xs); font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase;
      padding: 1px 7px; border-radius: 999px; border: 1px solid var(--border); color: #999;
    }
    .subagent-status.queued { color: #999; border-color: var(--border); }
    .subagent-status.running {
      color: #a98dff; border-color: rgba(124, 92, 255, 0.5);
      animation: harny-pulse 1.2s ease-in-out infinite;
    }
    .subagent-status.done { color: #98c379; border-color: rgba(152, 195, 121, 0.5); }
    .subagent-status.failed { color: var(--error); border-color: rgba(244, 71, 71, 0.5); }
    .subagent-status.interrupted { color: #e5c07b; border-color: rgba(229, 192, 123, 0.5); }
    .subagent-status.aborted { color: #999; border-color: var(--border); }
    .subagent-goal { padding: 0 8px 4px 22px; color: var(--fg); font-style: italic; font-size: var(--fs-md); }
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

    /* Chips row under the input: queued files only — the "+" picker lives at
       the head of the text box (first key in #input-main). An empty row must
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
    #status { display: flex; flex-direction: column; gap: 8px; padding: 8px 10px; font-size: var(--fs-md); }
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
      display: grid; grid-template-columns: repeat(auto-fit, minmax(9.5rem, 1fr));
      gap: 8px;
    }
    .ctl-card {
      display: flex; flex-direction: column; gap: 8px;
      border-radius: 8px; padding: 8px 10px;
      background: var(--input-bg);
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

    .card-title {
      font-size: var(--fs-xs); font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase;
      color: #8a8a8a; user-select: none;
    }
    .field { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
    .field-label { font-size: var(--fs-sm); color: #9a9a9a; }
    /* Working state: the PLAY (send) button blinks in sync with the chat's
       "Working..." bubble — same harny-pulse 1.2s animation, applied in the
       same tick (send/compactStart), so the two pulse together. */
    #send-btn.blinking { animation: harny-pulse 1.2s ease-in-out infinite; }
    #model-select {
      flex: 1; min-width: 0; background: transparent; color: inherit; border: none; outline: none;
      font-size: var(--fs-md); cursor: pointer; height: 1.85rem;
    }
    #model-select option, #model-select optgroup { color: #1e1e1e; }
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
    #ctx-window, #out-window, #samp-window, #presence-window, #freq-window { display: inline-flex; align-items: center; gap: 2px; width: 100%; }
    #ctx-input, #out-input, #samp-input, #presence-input, #freq-input {
      flex: 1; min-width: 2.5rem; width: auto; height: 1.85rem; background: var(--input-bg); color: var(--fg);
      border: 1px solid var(--border); border-radius: 6px; padding: 1px 6px;
      font-size: var(--fs-md); text-align: right;
    }
    #ctx-input:focus, #out-input:focus, #samp-input:focus, #presence-input:focus, #freq-input:focus { border-color: var(--accent); outline: none; }
    /* Empty float input = Auto (not sent): neutral italic hint. */
    #samp-input::placeholder, #presence-input::placeholder, #freq-input::placeholder { color: #777; font-style: italic; }
    /* Sampler selector: native radios on ONE slim row occupying the same
       slot/height as the other field labels (no pill, no box). */
    .sampler-toggle { display: inline-flex; align-items: center; gap: 12px; }
    .sampler-opt {
      display: inline-flex; align-items: center; gap: 4px;
      font-size: var(--fs-sm);
      color: #9a9a9a; cursor: pointer; user-select: none;
      transition: color 0.12s;
    }
    .sampler-opt input[type="radio"] {
      accent-color: var(--accent); margin: 0; width: 9px; height: 9px; cursor: pointer;
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
    /* Gear next to Compact (same visual family, narrower): opens the
       auto-compaction threshold form. Kept after the flex-auto margin so the
       pair hugs the right edge of the stats row. */
    #compact-settings-btn {
      flex: 0 0 auto; display: flex; align-items: center; justify-content: center;
      width: 26px; height: 26px; padding: 0;
      background: linear-gradient(to bottom, rgba(255, 255, 255, 0.14), rgba(255, 255, 255, 0.02)),
        var(--tool-bg, transparent);
      border: 1px solid var(--border); color: var(--fg);
      border-radius: 6px; cursor: pointer;
      box-shadow:
        inset 0 1px 0 rgba(255, 255, 255, 0.18),
        inset 0 -1px 0 rgba(0, 0, 0, 0.18),
        0 1px 2px rgba(0, 0, 0, 0.28);
      transition: color 0.12s, border-color 0.12s, box-shadow 0.12s, transform 0.08s;
    }
    #compact-settings-btn:hover:not(:disabled) { color: var(--accent); border-color: var(--accent); }
    #compact-settings-btn:active:not(:disabled) {
      transform: translateY(1px);
      box-shadow: inset 0 1px 3px rgba(0, 0, 0, 0.35);
    }
    #compact-settings-btn:disabled { opacity: 0.5; cursor: default; }
    /* Threshold label between Compact and its gear: muted, same row. */
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
    .empty-hero h2 { margin: 0; font-size: var(--fs-xl); color: var(--fg-strong); font-weight: 700; }
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
    /* Gear button next to the model dropdown. */
    .icon-btn {
      flex: none;
      width: 1.5rem; height: 1.5rem; padding: 0;
      background: transparent; border: 1px solid var(--border);
      border-radius: 4px; color: var(--muted, #999);
      display: inline-flex; align-items: center; justify-content: center;
      cursor: pointer;
    }
    .icon-btn:hover:not(:disabled) { color: var(--accent); }
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
    .provider-form-col input, .provider-form-col select {
      font-size: var(--fs-lg); padding: 5px 8px; border-radius: 5px;
      background: var(--input-bg, #252526); border: 1px solid var(--border); color: var(--fg);
    }
    .provider-actions { display: flex; flex-wrap: wrap; gap: 8px; }
    .provider-actions .danger { color: var(--error, #f05555); }
    .providers-actions { display: flex; justify-content: flex-end; gap: 10px; }
    .providers-actions button { font-size: var(--fs-lg); padding: 6px 14px; border-radius: 6px; }
    /* Bottom settings row: a flag + a numeric stepper (max parallel sub-agents). */
    .providers-settings {
      display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
      padding-top: 10px; border-top: 1px solid var(--border);
    }
    .ps-flag {
      display: inline-flex; align-items: center; gap: 7px; cursor: pointer;
      font-size: var(--fs-lg); color: var(--fg); user-select: none;
    }
    .ps-flag input { width: 15px; height: 15px; accent-color: var(--accent); cursor: pointer; }
    .ps-hint { font-size: var(--fs-sm); color: var(--muted, #999); }
    .ps-stepper { display: inline-flex; align-items: center; gap: 3px; margin-left: auto; }
    .ps-stepper input {
      width: 4.2rem; text-align: center; font-size: var(--fs-lg);
      padding: 4px 6px; border-radius: 6px; color: var(--fg);
      background: var(--input-bg, #252526); border: 1px solid var(--border);
    }
    .ps-stepper input:disabled { opacity: 0.4; }
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
    .sm-empty { padding: 18px; text-align: center; color: #888; font-size: var(--fs-lg); }
  </style>
</head>
<body class="controls-collapsed">
  <div id="sessions-card" class="sessions-card">
    <div id="session-head">
      <span class="toggle">▼</span><span>Sessions</span>
      <span class="spacer"></span>
      <button id="new-session" title="New session"><svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" fill="none"/></svg></button>
      <button id="sessions-gear-btn" title="Manage all sessions (every folder)"><svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><path d="M19.4 13a7.6 7.6 0 0 0 .1-1 7.6 7.6 0 0 0-.1-1l2.1-1.7a.5.5 0 0 0 .1-.7l-2-3.5a.5.5 0 0 0-.6-.2l-2.5 1a7.6 7.6 0 0 0-1.7-1L14.5 2.4a.5.5 0 0 0-.5-.4h-4a.5.5 0 0 0-.5.4l-.4 2.5a7.6 7.6 0 0 0-1.7 1l-2.5-1a.5.5 0 0 0-.6.2l-2 3.5a.5.5 0 0 0 .1.7L4.5 11a7.6 7.6 0 0 0-.1 1 7.6 7.6 0 0 0 .1 1l-2.1 1.7a.5.5 0 0 0-.1.7l2 3.5a.5.5 0 0 0 .6.2l2.5-1a7.6 7.6 0 0 0 1.7 1l.4 2.5a.5.5 0 0 0 .5.4h4a.5.5 0 0 0 .5-.4l.4-2.5a7.6 7.6 0 0 0 1.7-1l2.5 1a.5.5 0 0 0 .6-.2l2-3.5a.5.5 0 0 0-.1-.7zM12 15.5A3.5 3.5 0 1 1 12 8.5a3.5 3.5 0 0 1 0 7z" fill="currentColor"/></svg></button>
    </div>
    <div id="sessions"></div>
  </div>
  <div id="tabs"></div>
  <div id="messages"></div>
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
      <button id="attach-btn" class="secondary" title="Attach files" aria-label="Attach files">+</button>
      <textarea id="user-input" rows="1" placeholder="Ask Harny... (Enter to send, Esc to abort)"></textarea>
      <button id="send-btn" aria-label="Send"><svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z" fill="currentColor"/></svg></button>
      <button id="abort-btn" class="secondary" disabled aria-label="Abort"><svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/></svg></button>
    </div>
    <!-- AI Model row: the mode select (Analyze/Agent) sits on the SAME
         horizontal line as the label, model select and gear button. The
         dropdown anchors to the button and overlays the cards below. -->
    <div class="ctl-card ctl-card-model">
      <div id="mode-select"
           title="Analyze: read-only · Build/Edit: full tool use (create, modify, run)">
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
                  title="Build/Edit: full tool use — create, modify and run (files, shell, search)">
            <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="none"/><path d="M19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>
            <span>Build/Edit</span>
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
      <select id="model-select" title="Switch model"></select>
      <button id="gear-btn" class="icon-btn" title="Configure providers & models"><svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><path d="M19.4 13a7.6 7.6 0 0 0 .1-1 7.6 7.6 0 0 0-.1-1l2.1-1.7a.5.5 0 0 0 .1-.7l-2-3.5a.5.5 0 0 0-.6-.2l-2.5 1a7.6 7.6 0 0 0-1.7-1L14.5 2.4a.5.5 0 0 0-.5-.4h-4a.5.5 0 0 0-.5.4l-.4 2.5a7.6 7.6 0 0 0-1.7 1l-2.5-1a.5.5 0 0 0-.6.2l-2 3.5a.5.5 0 0 0 .1.7L4.5 11a7.6 7.6 0 0 0-.1 1 7.6 7.6 0 0 0 .1 1l-2.1 1.7a.5.5 0 0 0-.1.7l2 3.5a.5.5 0 0 0 .6.2l2.5-1a7.6 7.6 0 0 0 1.7 1l.4 2.5a.5.5 0 0 0 .5.4h4a.5.5 0 0 0 .5-.4l.4-2.5a7.6 7.6 0 0 0 1.7-1l2.5 1a.5.5 0 0 0 .6-.2l2-3.5a.5.5 0 0 0-.1-.7zM12 15.5A3.5 3.5 0 1 1 12 8.5a3.5 3.5 0 0 1 0 7z" fill="currentColor"/></svg></button>
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
          <label class="field-label" for="ctx-input">Context window</label>
          <div id="ctx-window">
            <button id="ctx-minus" class="ctx-btn" title="Decrease context"><svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" fill="none"/></svg></button>
            <input id="ctx-input" type="text" inputmode="numeric" autocomplete="off" value="${DEFAULT_CONTEXT_WINDOW}" title="Context window (tokens) — integers only">
            <button id="ctx-plus" class="ctx-btn" title="Increase context"><svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" fill="none"/></svg></button>
          </div>
        </div>
        <div class="field">
          <label class="field-label" for="out-input">Output tokens</label>
          <div id="out-window">
            <button id="out-minus" class="ctx-btn" title="Decrease output tokens"><svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" fill="none"/></svg></button>
            <input id="out-input" type="text" inputmode="numeric" autocomplete="off" value="${DEFAULT_OUTPUT_TOKENS}" title="Max output tokens per response — integers only">
            <button id="out-plus" class="ctx-btn" title="Increase output tokens"><svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" fill="none"/></svg></button>
          </div>
        </div>
        <div class="field">
          <label class="field-label" for="thinking-select">Thinking</label>
          <select id="thinking-select" title="Reasoning effort / thinking level (per session)">
            <option value="off">Off</option>
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
          </select>
        </div>
      </div>
      <div class="ctl-card">
        <span class="card-title">Sampling</span>
        <div class="field">
          <div class="sampler-toggle" id="sampler-toggle">
            <label class="sampler-opt"><input type="radio" name="sampler" id="sampler-temp" value="temperature" checked />Temperature</label>
            <label class="sampler-opt"><input type="radio" name="sampler" id="sampler-topp" value="topP" />Top-P</label>
          </div>
          <div id="samp-window">
            <button id="samp-minus" class="ctx-btn" title="Decrease sampler value"><svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" fill="none"/></svg></button>
            <input id="samp-input" type="text" inputmode="decimal" autocomplete="off" placeholder="Auto" title="Active sampler value — scale follows the toggle (0.0–2.0 temperature, 0.0–1.0 top-p); empty = Auto (not sent)">
            <button id="samp-plus" class="ctx-btn" title="Increase sampler value"><svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" fill="none"/></svg></button>
            <button id="samp-auto" class="ctx-btn" title="Reset to Auto (not sent)">Auto</button>
          </div>
        </div>
        <div class="field">
          <label class="field-label" for="presence-input">Presence penalty (0.0 → 2.0)</label>
          <div id="presence-window">
            <button id="presence-minus" class="ctx-btn" title="Decrease presence penalty"><svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" fill="none"/></svg></button>
            <input id="presence-input" type="text" inputmode="decimal" autocomplete="off" placeholder="Auto" title="Presence penalty 0.0–2.0; pushes toward new topics; empty = Auto (not sent)">
            <button id="presence-plus" class="ctx-btn" title="Increase presence penalty"><svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" fill="none"/></svg></button>
            <button id="presence-auto" class="ctx-btn" title="Reset to Auto (not sent)">Auto</button>
          </div>
        </div>
        <div class="field">
          <label class="field-label" for="freq-input">Frequency penalty (0.0 → 2.0)</label>
          <div id="freq-window">
            <button id="freq-minus" class="ctx-btn" title="Decrease frequency penalty"><svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" fill="none"/></svg></button>
            <input id="freq-input" type="text" inputmode="decimal" autocomplete="off" placeholder="Auto" title="Frequency penalty 0.0–2.0; reduces repetition; empty = Auto (not sent)">
            <button id="freq-plus" class="ctx-btn" title="Increase frequency penalty"><svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" fill="none"/></svg></button>
            <button id="freq-auto" class="ctx-btn" title="Reset to Auto (not sent)">Auto</button>
          </div>
        </div>
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
      <button id="compact-settings-btn" title="Set the context fill % that auto-compacts"><svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true"><path d="M19.4 13a7.6 7.6 0 0 0 .1-1 7.6 7.6 0 0 0-.1-1l2.1-1.7a.5.5 0 0 0 .1-.7l-2-3.5a.5.5 0 0 0-.6-.2l-2.5 1a7.6 7.6 0 0 0-1.7-1L14.5 2.4a.5.5 0 0 0-.5-.4h-4a.5.5 0 0 0-.5.4l-.4 2.5a7.6 7.6 0 0 0-1.7 1l-2.5-1a.5.5 0 0 0-.6.2l-2 3.5a.5.5 0 0 0 .1.7L4.5 11a7.6 7.6 0 0 0-.1 1 7.6 7.6 0 0 0 .1 1l-2.1 1.7a.5.5 0 0 0-.1.7l2 3.5a.5.5 0 0 0 .6.2l2.5-1a7.6 7.6 0 0 0 1.7 1l.4 2.5a.5.5 0 0 0 .5.4h4a.5.5 0 0 0 .5-.4l.4-2.5a7.6 7.6 0 0 0 1.7-1l2.5 1a.5.5 0 0 0 .6-.2l2-3.5a.5.5 0 0 0-.1-.7zM12 15.5A3.5 3.5 0 1 1 12 8.5a3.5 3.5 0 0 1 0 7z" fill="currentColor"/></svg></button>
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
      <div id="sessions-manager-list"></div>
      <div class="sm-footer">
        <button id="sessions-close" class="secondary">Close</button>
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
            <input id="pe-apikey" type="text" spellcheck="false" placeholder="sk-..." />
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
      <div class="providers-settings">
        <label class="ps-flag" for="pe-maxparallel-enabled">
          <input type="checkbox" id="pe-maxparallel-enabled" />
          <span>Set max parallel sub-agents</span>
        </label>
        <span class="ps-hint">Cap how many read-only sub-agents run at the same time (edits are never parallel). Off = no limit.</span>
        <div class="ps-stepper">
          <button id="pe-maxparallel-minus" class="ctx-btn" type="button" title="Decrease" aria-label="Decrease max parallel sub-agents"><svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" fill="none"/></svg></button>
          <input id="pe-maxparallel-input" type="text" inputmode="numeric" autocomplete="off" value="3" disabled aria-label="Max parallel sub-agents" />
          <button id="pe-maxparallel-plus" class="ctx-btn" type="button" title="Increase" aria-label="Increase max parallel sub-agents"><svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" fill="none"/></svg></button>
        </div>
      </div>
      <div class="providers-actions">
        <button id="providers-cancel" class="secondary">Cancel</button>
        <button id="providers-save">Save</button>
      </div>
    </div>
  </div>
  <script id="harny-view-init" type="application/json">${jsonInit(deps.state)}</script>
  <script src="${scriptUri}"></script>
</body>
</html>`;
}
