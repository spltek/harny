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
  hostModelsError?: boolean;
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
    :root {
      --bg: var(--vscode-sideBar-background, #252526);
      --fg: var(--vscode-sideBar-foreground, #cccccc);
      --border: var(--vscode-panel-border, #3c3c3c);
      --input-bg: var(--vscode-input-background, #3c3c3c);
      --user-msg: var(--vscode-button-background, #0e639c);
      --assistant-msg: var(--vscode-editor-inactiveSelectionBackground, #3a3d41);
      --tool-bg: var(--vscode-textCodeBlock-background, #1e1e1e);
      --error: #f44747;
      --accent: var(--vscode-focusBorder, #007fd4);
      --font: var(--vscode-font-family, 'SF Mono', Monaco, monospace);
    }
    :root {
      /* Base font = the VS Code EDITOR font size, so Harny matches the editor
         and scales together with it (all sizes below are rem = proportional). */
      --font-size: var(--vscode-editor-font-size, var(--vscode-font-size, 13px));
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: var(--font);
      font-size: var(--font-size);
      background: var(--bg);
      color: var(--fg);
      height: 100vh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    /* Sessions area */
    #session-head {
      display: flex; align-items: center; gap: 6px;
      padding: 6px 10px; font-weight: 600; font-size: 0.85rem;
      border-bottom: 1px solid var(--border);
      cursor: pointer; user-select: none;
    }
    #session-head .toggle { font-size: 0.69rem; width: 12px; color: #888; }
    #session-head .spacer { flex: 1; }
    #session-head button {
      background: transparent; border: none; color: var(--accent);
      font-size: 1.08rem; cursor: pointer; padding: 0 4px;
    }
    #sessions { overflow-y: auto; max-height: 40vh; border-bottom: 1px solid var(--border); }
    #sessions.hidden { display: none; }
    .srow {
      display: flex; align-items: center; gap: 3px;
      padding: 4px 10px; font-size: 0.92rem; flex-wrap: wrap;
    }
    .srow:hover { background: var(--tool-bg); }
    /* Creation + last-modified dates, on their own line BEFORE the name. */
    .srow .smeta {
      flex: 1 1 100%; color: #888; font-size: 0.69rem;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .srow .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: pointer; }
    .srow.open .name { color: var(--accent); }
    .srow-actions button {
      background: transparent; border: none; color: var(--fg);
      font-size: 0.92rem; cursor: pointer; opacity: 0.6; padding: 0 2px;
    }
    .srow-actions button:hover:not(:disabled) { opacity: 1; color: var(--accent); }
    .empty { padding: 12px; text-align: center; color: #888; font-size: 0.92rem; }

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
      font-size: 0.85rem; white-space: nowrap; color: #9a9a9a;
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
      font-size: 0.8rem; line-height: 1; padding: 1px 3px; margin-right: -2px;
      border-radius: 4px; color: #999; flex-shrink: 0;
      transition: color 0.12s, background-color 0.12s;
    }
    .tab .close:hover { color: var(--error); background: rgba(244, 71, 71, 0.14); }

    /* Chat */
    #messages { flex: 1; overflow-y: auto; padding: 10px; display: flex; flex-direction: column; gap: 6px; }
    .msg { padding: 8px 10px; border-radius: 10px; max-width: 92%; word-wrap: break-word; word-break: break-word; overflow-wrap: break-word; line-height: 1.4; font-size: 0.92rem; }
    /* pre-wrap only for plain-text bubbles (user messages); markdown bubbles
       (assistant/tool) use breaks:true and white-space normal to avoid the
       ghost blank lines produced by markdown's structural newlines. */
    .msg.user { align-self: flex-end; background: var(--user-msg); color: #fff; white-space: pre-wrap; }
    .msg.assistant, .msg.tool { width: 100%; max-width: 100%; }
    .msg.assistant { align-self: flex-start; background: var(--assistant-msg); min-width: 0; }
    .msg.assistant.error { background: rgba(244, 71, 71, 0.15); border: 1px solid var(--error); }
    .msg.assistant p { margin: 4px 0; }
    .msg.assistant h1, .msg.assistant h2, .msg.assistant h3, .msg.assistant h4, .msg.assistant h5, .msg.assistant h6 { margin: 8px 0 4px; font-weight: 600; }
    .msg.assistant h1 { font-size: 1.08rem; } .msg.assistant h2 { font-size: 1rem; } .msg.assistant h3 { font-size: 0.92rem; }
    .msg.assistant ul, .msg.assistant ol { margin: 4px 0; padding-left: 1.4em; }
    .msg.assistant ol { list-style: decimal; }
    .msg.assistant ul { list-style: disc; }
    .msg.assistant li { margin: 2px 0; }
    .msg.assistant code { background: var(--tool-bg); border-radius: 3px; padding: 0 3px; font-size: 0.85rem; }
    .msg.assistant pre { background: var(--tool-bg); border: 1px solid var(--border); border-radius: 5px; padding: 6px 8px; overflow-x: auto; margin: 6px 0; }
    .msg.assistant pre code { background: transparent; padding: 0; }
    .msg.assistant a { color: var(--accent); }
    .msg.assistant strong { font-weight: 600; }
    .msg.assistant em { font-style: italic; }
    .msg.assistant blockquote { border-left: 2px solid var(--border); padding-left: 8px; margin: 6px 0; color: #999; }
    .msg.assistant table { border-collapse: collapse; margin: 6px 0; font-size: 0.85rem; }
    .msg.assistant th, .msg.assistant td { border: 1px solid var(--border); padding: 3px 6px; text-align: left; }
    .msg.assistant th { background: var(--tool-bg); }
    .msg.assistant img { max-width: 100%; border-radius: 4px; }
    .table-scroll { overflow-x: auto; max-width: 100%; }
    .table-scroll table { min-width: max-content; }
    .code-block { overflow-x: auto; }
    .code-lang { font-size: 0.69rem; text-transform: uppercase; letter-spacing: 0.4px; color: #888; background: rgba(0,0,0,0.2); padding: 1px 8px; border-bottom: 1px solid var(--border); }
    .msg.tool { align-self: flex-start; background: var(--tool-bg); border: 1px solid var(--border); font-size: 0.85rem; }
    .msg.system { display: none; }
    .msg.welcome { align-self: center; background: transparent; border: 1px dashed var(--border); color: #888; text-align: center; max-width: 100%; }
    .working { align-self: flex-start; color: #999; font-size: 0.85rem; font-style: italic; animation: harny-pulse 1.2s ease-in-out infinite; }
    /* The working bar is a REAL footer glued below the transcript (NOT a bubble
       in the flow): always visible in realtime while it exists. It lives
       outside #messages, so sections are never inserted below it. */
    #working-bar {
      flex-shrink: 0;
      padding: 4px 10px;
      border-top: 1px solid var(--border);
      background: var(--bg);
      color: #999; font-size: 0.85rem; font-style: italic;
      animation: harny-pulse 1.2s ease-in-out infinite;
    }
    #working-bar.hidden { display: none; }
    @keyframes harny-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }

    .tool-header { display: flex; align-items: center; gap: 5px; cursor: pointer; user-select: none; font-weight: 600; color: var(--accent); }
    .tool-header:hover { color: var(--fg); }
    .tool-toggle { font-size: 0.77rem; width: 12px; color: #888; flex-shrink: 0; }
    .tool-name { white-space: nowrap; }
    .tool-details { margin-top: 2px; font-size: 0.85rem; }
    .tool-details.collapsed { display: none; }
    .tool-label { display: block; color: #888; font-size: 0.69rem; text-transform: uppercase; letter-spacing: 0.4px; margin: 6px 0 2px; }
    .tool-details pre { background: rgba(0,0,0,0.25); border: 1px solid var(--border); border-radius: 4px; padding: 5px 7px; white-space: pre-wrap; word-break: break-all; max-height: 160px; overflow-y: auto; font-size: 0.77rem; line-height: 1.4; }
    .tool-result-error { color: var(--error); }
    .tool-result .diff-hunk { color: var(--accent); }
    .tool-result .diff-add { color: #e5c07b; background: rgba(229, 192, 123, 0.14); }
    .tool-result .diff-del { color: #f44747; background: rgba(244, 71, 71, 0.14); }
    .tool-result .diff-ctx { color: inherit; }
    .tool-call-pending { opacity: 0.65; }

    .thinking-block { width: 100%; border: 1px dashed var(--border); border-radius: 6px; margin: 4px 0; padding: 0; font-size: 0.85rem; }
    .thinking-header { display: flex; align-items: center; gap: 5px; padding: 5px 8px; cursor: pointer; user-select: none; color: #999; font-style: italic; }
    .thinking-header:hover { color: var(--accent); }
    .thinking-header .toggle { font-size: 0.77rem; width: 12px; }
    /* Thinking is now rendered as Markdown (md on the reasoning text), so the
       body uses normal whitespace + breaks:true like the assistant bubbles. */
    .thinking-body { padding: 0 8px 6px; color: #999; line-height: 1.45; }
    .thinking-body p { margin: 4px 0; }
    .thinking-body h1, .thinking-body h2, .thinking-body h3, .thinking-body h4, .thinking-body h5, .thinking-body h6 { margin: 8px 0 4px; font-weight: 600; }
    .thinking-body ul, .thinking-body ol { margin: 4px 0; padding-left: 1.4em; }
    .thinking-body ol { list-style: decimal; }
    .thinking-body ul { list-style: disc; }
    .thinking-body li { margin: 2px 0; }
    .thinking-body a { color: var(--accent); }
    .thinking-body strong { font-weight: 600; }
    .thinking-body em { font-style: italic; }
    .thinking-body code { background: rgba(0,0,0,0.25); border-radius: 3px; padding: 0 3px; font-size: 0.77rem; }
    .thinking-body pre { background: rgba(0,0,0,0.25); border: 1px solid var(--border); border-radius: 4px; padding: 4px 6px; overflow-x: auto; margin: 4px 0; }
    .thinking-body pre code { background: transparent; padding: 0; }
    .thinking-body blockquote { border-left: 2px solid var(--border); padding-left: 8px; margin: 4px 0; }
    .thinking-body table { border-collapse: collapse; margin: 6px 0; }
    .thinking-body th, .thinking-body td { border: 1px solid var(--border); padding: 3px 6px; text-align: left; }
    .thinking-body th { background: rgba(0,0,0,0.25); }
    .thinking-body img { max-width: 100%; border-radius: 4px; }
    .thinking-body hr { border: none; border-top: 1px solid var(--border); margin: 6px 0; }
    .thinking-body .task-list-item-checkbox { margin-right: 4px; vertical-align: middle; }
    .thinking-body.collapsed { display: none; }
    .thinking { align-self: flex-start; color: #999; font-style: italic; font-size: 0.85rem; white-space: pre-wrap; }

    #input-area { display: flex; gap: 6px; align-items: flex-end; padding: 6px; border-top: 1px solid var(--border); }
    #user-input {
      flex: 1; background: var(--input-bg); color: var(--fg);
      border: 1px solid var(--border); border-radius: 6px; padding: 6px 8px;
      font-family: var(--font); font-size: 0.92rem; line-height: 1.4; resize: none;
      min-height: 2.31rem; max-height: 18.5rem; outline: none;
    }
    #user-input:focus { border-color: var(--accent); }
    button {
      background: var(--accent); color: #fff; border: none; border-radius: 5px;
      cursor: pointer; font-size: 0.92rem; line-height: 1;
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
    button.secondary { background: transparent; border: 1px solid var(--border); color: var(--fg); }
    /* Stop (abort) is ENABLED only while working: a red hover signals the
       danger action in exactly that state (disabled elsewhere). */
    #abort-btn:enabled:hover {
      color: var(--error);
      border-color: var(--error);
      background: rgba(244, 71, 71, 0.12);
    }
    /* Align the send/stop buttons with the single-line textarea (30px tall). */
    #input-area button {
      height: 2.31rem;
      min-width: 2.77rem;
      padding: 0 0.77rem;
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }

    #status { display: flex; flex-direction: column; gap: 4px; padding: 4px 10px; font-size: 0.85rem; border-top: 1px solid var(--border); }
    #status .warn { color: var(--error); }
    /* Each control group is its own row; narrow panels wrap to a second line. */
    .ctl-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
    /* Working state: the PLAY (send) button blinks in sync with the chat's
       "Working..." bubble — same harny-pulse 1.2s animation, applied in the
       same tick (send/compactStart), so the two pulse together. */
    #send-btn.blinking { animation: harny-pulse 1.2s ease-in-out infinite; }
    #model-select {
      flex: 1; min-width: 0; background: transparent; color: inherit; border: none; outline: none;
      font-family: var(--font); font-size: 0.85rem; cursor: pointer; height: 1.85rem;
    }
    #model-select option, #model-select optgroup { color: #1e1e1e; }
    #thinking-select {
      background: transparent; color: inherit; border: 1px solid var(--border);
      border-radius: 4px; outline: none; font-family: var(--font); font-size: 0.85rem;
      cursor: pointer; padding: 0 2px; height: 1.85rem;
    }
    #thinking-select option { color: #1e1e1e; }
    #thinking-select:disabled { opacity: 0.45; cursor: default; }
    #status .model-label { color: #999; }
    #ctx-window, #out-window, #temp-window { display: inline-flex; align-items: center; gap: 2px; }
    #ctx-input, #out-input, #temp-input {
      width: 5.7rem; height: 1.85rem; background: var(--input-bg); color: var(--fg);
      border: 1px solid var(--border); border-radius: 4px; padding: 1px 4px;
      font-family: var(--font); font-size: 0.85rem; text-align: right;
    }
    #ctx-input:focus, #out-input:focus, #temp-input:focus { border-color: var(--accent); outline: none; }
    /* Empty temperature input = Auto (not sent): neutral italic hint. */
    #temp-input::placeholder { color: #777; font-style: italic; }
    /* Metrics row: same font, label style and horizontal padding as the status
       row above, so "Tokens:" lines up with "AI Model:". */
    #metrics {
      display: flex; align-items: center; gap: 8px; padding: 4px 10px; font-size: 0.85rem;
      border-top: 1px solid var(--border); color: #9a9a9a; flex-wrap: wrap;
    }
    #metrics .model-label { color: #999; }
    #metrics .met { white-space: nowrap; }
    #met-cache.hidden { display: none; }
    #ctx-bar-wrap { flex: 1; min-width: 60px; height: 6px; background: var(--tool-bg); border: 1px solid var(--border); border-radius: 3px; overflow: hidden; }
    #ctx-bar { height: 100%; background: var(--accent); width: 0%; transition: width 0.3s; }
    #ctx-bar.warn { background: var(--error); }
    #compact-btn {
      background: linear-gradient(to bottom, rgba(255, 255, 255, 0.14), rgba(255, 255, 255, 0.02)), transparent;
      border: 1px solid var(--border); color: var(--fg);
      border-radius: 4px; padding: 1px 6px; font-size: 0.77rem; cursor: pointer;
      box-shadow:
        inset 0 1px 0 rgba(255, 255, 255, 0.18),
        inset 0 -1px 0 rgba(0, 0, 0, 0.18),
        0 1px 2px rgba(0, 0, 0, 0.28);
    }
    #compact-btn:hover:not(:disabled) { color: var(--accent); }
    #compact-btn:active:not(:disabled) {
      transform: translateY(1px);
      box-shadow: inset 0 1px 3px rgba(0, 0, 0, 0.35);
    }
    .ctx-btn {
      width: 1.38rem; height: 1.38rem; padding: 0; font-size: 0.92rem; line-height: 1;
      background: linear-gradient(to bottom, rgba(255, 255, 255, 0.16), rgba(255, 255, 255, 0.03)),
        var(--tool-bg, transparent);
      border: 1px solid var(--border); color: var(--fg); border-radius: 3px;
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
    /* The Auto reset is a SEPARATE key, clearly detached from the + spinner. */
    #temp-auto { margin-left: 6px; width: auto; padding: 0 0.5rem; }
    /* Hide the browser's native number spinners; we use our own − / + buttons. */
    #ctx-input::-webkit-outer-spin-button,
    #ctx-input::-webkit-inner-spin-button,
    #out-input::-webkit-outer-spin-button,
    #out-input::-webkit-inner-spin-button,
    #temp-input::-webkit-outer-spin-button,
    #temp-input::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
    #ctx-input, #out-input, #temp-input { -moz-appearance: textfield; }

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
    #name-modal h3 { margin: 0; font-size: 0.92rem; font-weight: 600; }
    #name-input {
      width: 100%; background: var(--input-bg); color: var(--fg);
      border: 1px solid var(--border); border-radius: 5px; padding: 6px 8px;
      font-family: var(--font); font-size: 0.92rem; outline: none; box-sizing: border-box;
    }
    #name-input:focus { border-color: var(--accent); }
    #name-modal .name-modal-actions { display: flex; justify-content: flex-end; gap: 8px; }
  </style>
</head>
<body>
  <div id="session-head">
    <span class="toggle">▼</span><span>Sessions</span>
    <span class="spacer"></span>
    <button id="new-session" title="New session">＋</button>
  </div>
  <div id="sessions"></div>
  <div id="tabs"></div>
  <div id="messages"></div>
  <div id="working-bar" class="hidden">● Working...</div>
  <div id="input-area">
    <textarea id="user-input" rows="1" placeholder="Ask Harny... (Enter to send, Esc to abort)"></textarea>
    <button id="send-btn">▶</button>
    <button id="abort-btn" class="secondary" disabled>⏹</button>
  </div>
  <div id="status">
    <div class="ctl-row">
      <span class="model-label">AI Model:</span>
      <select id="model-select" title="Switch model"></select>
    </div>
    <div class="ctl-row">
      <span class="model-label">Context window:</span>
      <div id="ctx-window">
        <button id="ctx-minus" class="ctx-btn" title="Decrease context">−</button>
        <input id="ctx-input" type="number" min="32000" max="2000000" step="1" value="${DEFAULT_CONTEXT_WINDOW}" title="Context window (tokens)">
        <button id="ctx-plus" class="ctx-btn" title="Increase context">+</button>
      </div>
      <span class="model-label">Thinking:</span>
      <select id="thinking-select" title="Reasoning effort / thinking level (per session)">
        <option value="off">Off</option>
        <option value="low">Low</option>
        <option value="medium">Medium</option>
        <option value="high">High</option>
      </select>
    </div>
    <div class="ctl-row">
      <span class="model-label">Output tokens:</span>
      <div id="out-window">
        <button id="out-minus" class="ctx-btn" title="Decrease output tokens">−</button>
        <input id="out-input" type="number" min="256" max="65536" step="512" value="${DEFAULT_OUTPUT_TOKENS}" title="Max output tokens per response">
        <button id="out-plus" class="ctx-btn" title="Increase output tokens">+</button>
      </div>
      <span class="model-label">Temp:</span>
      <div id="temp-window">
        <button id="temp-minus" class="ctx-btn" title="Decrease temperature">−</button>
        <input id="temp-input" type="number" min="0" max="2" step="0.1" placeholder="Auto" title="Sampling temperature 0–2; empty = Auto (not sent, provider default)">
        <button id="temp-plus" class="ctx-btn" title="Increase temperature">+</button>
        <button id="temp-auto" class="ctx-btn" title="Reset to Auto (not sent)">Auto</button>
      </div>
    </div>
  </div>
  <div id="metrics">
    <span class="model-label">Tokens:</span><span class="met" id="met-tokens">0</span>
    <span class="met">/</span><span class="met" id="met-ctx">${DEFAULT_CONTEXT_WINDOW}</span>
    <span class="met" id="met-pct">(0%)</span>
    <span class="met" id="met-cache" title="Input tokens served from prompt cache"></span>
    <div id="ctx-bar-wrap"><div id="ctx-bar"></div></div>
    <button id="compact-btn" title="Compact context">Compact</button>
  </div>
  <div id="name-modal" class="hidden">
    <div class="name-modal-backdrop"></div>
    <div class="name-modal-card">
      <h3 id="name-modal-title">Name the new session</h3>
      <input id="name-input" type="text" spellcheck="false" />
      <div class="name-modal-actions">
        <button id="name-cancel" class="secondary">Cancel</button>
        <button id="name-ok">Create</button>
      </div>
    </div>
  </div>
  <script id="harny-view-init" type="application/json">${jsonInit(deps.state)}</script>
  <script src="${scriptUri}"></script>
</body>
</html>`;
}
