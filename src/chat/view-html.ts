import { FONTS, FAMILIES, PALETTES, ROOT_FONT_SIZE, type ThemeMode } from "./view-config";
// The stylesheet lives in media/view.css (a real, formatted, lintable file) and reaches this
// module as a JSON-encoded string: see scripts/gen-view-css.mjs for why not an import.
import { VIEW_CSS } from "./view-css";
import { panelMinWidthCss } from "./panel-width";
import type { ChatMessage } from "../core/history/types";
import type { SessionSummary } from "../core/sessions/types";
import {
  CONTEXT_SLIDER_STEP,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_OUTPUT_TOKENS,
  MAX_CONTEXT_WINDOW,
  MAX_OUTPUT_TOKENS,
  MIN_CONTEXT_WINDOW,
  MIN_OUTPUT_TOKENS,
  OUTPUT_SLIDER_STEP,
} from "./context-window";
import type { SessionLiveProjection } from "./session-live-state";
// Icon artwork is FILES under media/icons/ (see media/icons/README.md and
// src/chat/icons.ts): the panel markup only names an icon and its size.
import { icon } from "./icons";

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
  /** Folders open in the window (0 = none, >1 = multi-root: both unusable). */
  workspaceFolderCount?: number;
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
      /* The floor the panel needs before its layout breaks (see panel-width.ts). It is a
         MEASURED value, so it is emitted here with the other numbers and the stylesheet reads
         it as a variable: media/view.css is a static file and cannot compute anything. */
      --panel-min-width: ${panelMinWidthCss()};
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
  const themeClass = deps.theme === "dark" ? " theme-dark" : deps.theme === "light" ? " theme-light" : "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource} data: https:; style-src ${cspSource} 'unsafe-inline'; script-src ${cspSource} 'unsafe-inline'; font-src ${cspSource};">
  <title>Harny</title>
  <style>
${renderViewConfig(deps)}
${VIEW_CSS}
  </style>
</head>
<body class="controls-collapsed${themeClass}">
  <div id="sessions-card" class="sessions-card">
    <div id="session-head">
      <span class="toggle is-open">${icon("chevronDown", 11, 'class="toggle-chevron"')}</span><span>Sessions</span>
      <span class="spacer"></span>
      <button id="new-session" title="New session">${icon("plus", 15)}</button>
      <button id="sessions-gear-btn" class="gear-btn" title="Manage all sessions (every folder)">${icon("gear", 14)}</button>
    </div>
    <div id="session-search-row">
      <input id="session-search" type="search" placeholder="Search sessions" spellcheck="false" autocomplete="off" aria-label="Search sessions" />
    </div>
    <div id="sessions"></div>
  </div>
  <div id="tabs"></div>
  <div id="messages-wrap">
    <div id="messages"></div>
    <!-- Switching a session: the host cannot post the new state until it has rebuilt
         the config (and it may be busy finishing a turn), and until then the OLD
         transcript sits there looking final — the click seems lost. The veil makes
         the wait visible and names what is opening. It covers ONLY the transcript:
         the strip and the list stay live, so a wrong click is corrected at once. -->
    <div id="switch-veil" role="status" aria-live="polite">
      <div class="switch-card">
        <span class="switch-spinner" aria-hidden="true"></span>
        <span class="switch-label">Opening session…</span>
      </div>
    </div>
  </div>
  <!-- Messages typed while the session works (queue/steer): a real footer,
       outside #messages, so they survive streaming re-renders. A COLLAPSIBLE
       section like the sessions list: the header carries the counts, so a
       collapsed section still says what is waiting. -->
  <div id="pending-section" class="hidden">
    <div id="pending-head" role="button" tabindex="0" aria-expanded="true" title="Messages typed while the session works">
      <span class="toggle is-open">${icon("chevronDown", 11, 'class="toggle-chevron"')}</span><span id="pending-head-text"></span>
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
      ${icon("chevronDown", 15)}
    </button>
    <div id="transcript-actions">
      <button id="collapse-all" type="button" disabled title="Collapse every expanded section (thinking, tool calls, sub-agents)">Collapse all</button>
      <button id="autoscroll" type="button" disabled title="Jump to the latest message and follow the stream">Follow</button>
    </div>
  </div>
  <div id="input-area">
    <div id="input-main">
      <button id="attach-btn" class="secondary" title="Attach files" aria-label="Attach files">${icon("paperclip", 15)}</button>
      <textarea id="user-input" rows="1" placeholder="Ask Harny... (Enter to send, Esc to abort)"></textarea>
      <button id="send-btn" aria-label="Send">${icon("play", 15)}</button>
      <button id="abort-btn" class="secondary" disabled aria-label="Abort">${icon("stop", 15)}</button>
    </div>
    <!-- AI Model row: the mode select (Analyze/Agent) sits on the SAME
         horizontal line as the label, model select and gear button. The
         dropdown anchors to the button and overlays the cards below. -->
    <div class="ctl-card ctl-card-model">
      <div id="mode-select"
           title="Analyze: read-only · Build: full tool use (create, modify, run)">
        <button type="button" id="mode-btn" aria-haspopup="listbox" aria-expanded="false"
                aria-label="Mode">
          ${icon("search", 12, 'id="mode-btn-icon-analyze"')}
          ${icon("sparkles", 12, 'id="mode-btn-icon-agent" class="hidden"')}
          <span id="mode-btn-label">Analyze</span>
          ${icon("chevronDown", 10, 'class="mode-btn-chevron"')}
        </button>
        <div id="mode-menu" class="hidden" role="listbox" aria-label="Mode">
          <button type="button" class="mode-item is-active" data-mode="analyze" role="option" aria-selected="true"
                  title="Analyze: read-only — inspects but never modifies files">
            ${icon("search", 12)}
            <span>Analyze</span>
            ${icon("check", 12, 'class="mode-check"')}
          </button>
          <button type="button" class="mode-item" data-mode="agent" role="option" aria-selected="false"
                  title="Build: full tool use — create, modify and run (files, shell, search)">
            ${icon("sparkles", 12)}
            <span>Build</span>
            ${icon("check", 12, 'class="mode-check"')}
          </button>
        </div>
      </div>
      <!-- Parallel: press/release toggle enabling orchestration (sub-agents)
           for the current mode. Blue when pressed. -->
      <button type="button" id="parallel-btn" aria-pressed="false"
              title="Parallel: let the agent launch sub-agents (read-only in Analyze)">
        ${icon("parallel", 14)}
        <span>Parallel</span>
      </button>
      <span class="model-label">AI Model:</span>
      <button type="button" id="model-btn" class="model-btn" title="Select a model" aria-haspopup="dialog">
        <span id="model-btn-label">Select a model</span>
        <span id="model-warn" class="warn-badge hidden" title="models.dev unreachable — some model limits may be unknown">⚠</span>
        ${icon("chevronDown", 10, 'class="model-btn-chevron"')}
      </button>
      <button id="gear-btn" class="gear-btn" title="Configure providers & models">${icon("gear", 14)}</button>
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
            <input type="range" id="ctx-range" class="num-range" min="${MIN_CONTEXT_WINDOW}" max="${MAX_CONTEXT_WINDOW}" step="${CONTEXT_SLIDER_STEP}" aria-label="Context window" />
            <span class="num-value" id="ctx-value">${DEFAULT_CONTEXT_WINDOW}</span>
          </div>
        </div>
        <div class="field">
          <label class="field-label" for="out-range">Output tokens <span class="range-label" id="out-range-label"></span></label>
          <div class="num-row">
            <input type="range" id="out-range" class="num-range" min="${MIN_OUTPUT_TOKENS}" max="${MAX_OUTPUT_TOKENS}" step="${OUTPUT_SLIDER_STEP}" aria-label="Output tokens" />
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
              <label class="sampler-opt" title="Also apply the Loop Guard to the final answer text (detects the model repeating the same response). Default off."><input type="checkbox" class="harny-switch" id="lg-response" role="switch" />Include response</label>
            </div>
            <button id="lg-collapse" class="lg-collapse" aria-expanded="false" aria-controls="lg-params-field" title="Show the Loop Guard parameters">
              ${icon("chevronDown", 13)}
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
          <button id="mcp-configure" class="gear-btn" title="Configure MCP servers" aria-label="Configure MCP servers">${icon("gear", 14)}</button>
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
      <button id="compact-settings-btn" class="gear-btn" title="Compaction policy for THIS session: when it starts and where it lands">${icon("gear", 14)}</button>
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
          <input id="compact-target-input" type="range" min="0" max="100" step="1" />
          <span id="compact-target-value" class="cs-val"></span>
          <button id="compact-target-auto" class="secondary cs-mini" type="button" title="Back to the derived default: an eighth of the trigger">Default</button>
        </div>
        <p class="cs-hint">The two knobs are <b>independent</b> — moving one never moves the other. <b>0</b> frees as much as the structure allows: only the last complete turn survives. <b>Default</b> sets an eighth of the trigger (10% with the trigger at 80), so two or three exchanges stay verbatim while it is untouched. The two knobs are free, and the line below says what the pair you picked actually DOES — nothing moves under your finger, and nothing is silently rewritten when you save.</p>
        <p id="compact-note" class="cs-hint cs-note"></p>
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
      <div id="alert-fields" class="alert-fields hidden"></div>
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
                ${icon("eye", 15)}
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
        <span class="mcp-hint">Model Context Protocol: a server is EITHER a command (stdio) OR a URL (HTTP) — fill one. Their tools appear as mcp__&lt;server&gt;__&lt;tool&gt;.</span>
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
          <div class="field"><label class="field-label" for="mcp-url">URL (HTTP) — leave empty for a local command</label><input id="mcp-url" type="text" spellcheck="false" placeholder="https://mcp.deepwiki.com/mcp" /></div>
          <div class="field"><label class="field-label" for="mcp-command">Command (stdio)</label><input id="mcp-command" type="text" spellcheck="false" placeholder="e.g. npx" /></div>
          <div class="field"><label class="field-label" for="mcp-args">Args (one per line)</label><textarea id="mcp-args" rows="3" spellcheck="false"></textarea></div>
          <div class="field"><label class="field-label" for="mcp-env">Env (KEY=VALUE, one per line)</label><textarea id="mcp-env" rows="3" spellcheck="false"></textarea></div>
          <div class="field"><label class="field-label" for="mcp-headers">Headers (KEY=VALUE, one per line — HTTP only)</label><textarea id="mcp-headers" rows="2" spellcheck="false"></textarea></div>
          <label class="mcp-enabled-row" title="A disabled server keeps its config and its tools stay out of reach: nothing is connected"><input type="checkbox" class="harny-switch" id="mcp-enabled" role="switch" /> Enabled (disabled servers are kept but not connected)</label>
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
  <!-- Find in the transcript. A webview has no native find, so ⌘F/Ctrl+F would otherwise do
       nothing at all. Floating over the top-right of the transcript, closed by Esc. -->
  <div id="find-bar" class="hidden" role="search">
    <input id="find-input" type="search" placeholder="Find in chat" spellcheck="false" aria-label="Find in chat" />
    <span id="find-count" class="find-count" aria-live="polite"></span>
    <button id="find-prev" type="button" class="secondary" title="Previous match (Shift+Enter)" aria-label="Previous match">↑</button>
    <button id="find-next" type="button" class="secondary" title="Next match (Enter)" aria-label="Next match">↓</button>
    <button id="find-close" type="button" class="secondary" title="Close (Esc)" aria-label="Close find">✕</button>
  </div>
  <!-- The transcript's own context menu: deterministic Copy on every OS, and it never depends
       on the host webview injecting one. Right-click on prose only (not on the chrome). -->
  <div id="ctx-menu" class="hidden" role="menu"></div>
  <!-- Shared hover tooltip: explains a control's parameter on mouse-over. -->
  <div id="tip" class="tip hidden" role="tooltip"></div>
  <div id="slash-menu" class="hidden" role="listbox" aria-label="Commands"></div>
  <script id="harny-view-init" type="application/json">${jsonInit(deps.state)}</script>
  <script src="${scriptUri}"></script>
</body>
</html>`;
}
