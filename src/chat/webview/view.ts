import { renderMarkdown } from "./markdown";
import { splitDiffFence, countDiff } from "./diff-fence";
import { clampContextWindow, clampOutputTokens, CONTEXT_STEP, DEFAULT_CONTEXT_WINDOW, DEFAULT_OUTPUT_TOKENS, OUTPUT_STEP } from "../context-window";
import { clampTemperature, clampTopP, TEMPERATURE_STEP } from "../temperature";

declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};

const vscode = acquireVsCodeApi();

interface ToolCallView {
  id?: string;
  name: string;
  arguments: unknown;
}
interface ChatMsg {
  role: string;
  content: string;
  thinking?: string;
  toolCalls?: ToolCallView[];
  toolCallId?: string;
}
interface SessionInfo {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}
interface ConfigState {
  provider: string;
  activeProvider?: string;
  model: string;
  hasKey: boolean;
  models?: string[];
  providerModels?: { provider: string; model: string }[];
  modelMissing?: boolean;
  hostModelsError?: boolean;
  noModels?: boolean;
  configHome?: string;
  workspaceReady?: boolean;
  thinkingMode?: string;
  thinkingLevel?: string;
  contextWindow?: number;
  outputTokens?: number;
  temperature?: number;
  presencePenalty?: number;
  frequencyPenalty?: number;
  topP?: number;
  sampler?: "temperature" | "topP";
  contextTokens?: number;
  cachedTokens?: number;
  cachedWrite?: number;
}
interface InitState {
  sessions: SessionInfo[];
  openIds: string[];
  activeId?: string;
  messages: ChatMsg[];
  config: ConfigState;
  /** Session ids whose agent is streaming (blocks their delete button). */
  workingIds?: string[];
  /** Active session mid-stream: restore the live bubble/thinking/answer. */
  streaming?: boolean;
  liveThinking?: string;
  liveAnswer?: string;
}

const sessionsEl = document.getElementById("sessions") as HTMLDivElement;
const sessionHead = document.getElementById("session-head") as HTMLDivElement;
const newSessionBtn = document.getElementById("new-session") as HTMLButtonElement;
const tabsEl = document.getElementById("tabs") as HTMLDivElement;
const messagesEl = document.getElementById("messages") as HTMLDivElement;
// The pulsing working indicator: a REAL footer glued below the transcript (NOT
// a bubble in the flow), shown/hidden instead of being appended/removed.
const workingBar = document.getElementById("working-bar") as HTMLDivElement;
const inputEl = document.getElementById("user-input") as HTMLTextAreaElement;
const ctlToggle = document.getElementById("ctl-toggle") as HTMLDivElement;
const sendBtn = document.getElementById("send-btn") as HTMLButtonElement;
const abortBtn = document.getElementById("abort-btn") as HTMLButtonElement;
const modelSelect = document.getElementById("model-select") as HTMLSelectElement;
const modelWarn = document.getElementById("model-warn") as HTMLDivElement;
const thinkingSelect = document.getElementById("thinking-select") as HTMLSelectElement;
const ctxInput = document.getElementById("ctx-input") as HTMLInputElement;
const ctxMinus = document.getElementById("ctx-minus") as HTMLButtonElement;
const ctxPlus = document.getElementById("ctx-plus") as HTMLButtonElement;
const outInput = document.getElementById("out-input") as HTMLInputElement;
const outMinus = document.getElementById("out-minus") as HTMLButtonElement;
const outPlus = document.getElementById("out-plus") as HTMLButtonElement;
const sampInput = document.getElementById("samp-input") as HTMLInputElement;
const sampMinus = document.getElementById("samp-minus") as HTMLButtonElement;
const sampPlus = document.getElementById("samp-plus") as HTMLButtonElement;
const sampAuto = document.getElementById("samp-auto") as HTMLButtonElement;
const samplerTemp = document.getElementById("sampler-temp") as HTMLInputElement;
const samplerTopp = document.getElementById("sampler-topp") as HTMLInputElement;
const presenceInput = document.getElementById("presence-input") as HTMLInputElement;
const presenceMinus = document.getElementById("presence-minus") as HTMLButtonElement;
const presencePlus = document.getElementById("presence-plus") as HTMLButtonElement;
const presenceAuto = document.getElementById("presence-auto") as HTMLButtonElement;
const freqInput = document.getElementById("freq-input") as HTMLInputElement;
const freqMinus = document.getElementById("freq-minus") as HTMLButtonElement;
const freqPlus = document.getElementById("freq-plus") as HTMLButtonElement;
const freqAuto = document.getElementById("freq-auto") as HTMLButtonElement;
const metTokens = document.getElementById("met-tokens") as HTMLSpanElement;
const metCtx = document.getElementById("met-ctx") as HTMLSpanElement;
const metPct = document.getElementById("met-pct") as HTMLSpanElement;
const metCache = document.getElementById("met-cache") as HTMLSpanElement;
const ctxBar = document.getElementById("ctx-bar") as HTMLDivElement;
const compactBtn = document.getElementById("compact-btn") as HTMLButtonElement;

const init = JSON.parse((document.getElementById("harny-view-init") as HTMLScriptElement).textContent ?? "{}") as InitState;

let activeId: string | undefined = init.activeId;
let openIds: string[] = init.openIds || [];
let currentSessions: SessionInfo[] = init.sessions || [];
let workingIds = new Set<string>(init.workingIds || []);

// ── Streaming session state (chronological, per active chat) ──
let currentResultEl: HTMLDivElement | null = null;
let currentThinkingBlock: HTMLDivElement | null = null;
let currentThinkingText = "";
let currentRawText = "";
let workingEl: HTMLDivElement | null = null;
let compactionEl: HTMLDivElement | null = null;
let aborted = false;
const pendingToolCalls = new Map<string, HTMLDivElement>();

// ── Throttled markdown rendering for LONG streaming text ──
// Re-rendering markdown on every delta janks the panel with long outputs
// (Qwen3.8-style thinking, verbose answers). Render at most once per window
// (leading edge) with a trailing flush, so a section always catches up.
function makeThrottledMd(windowMs = 120) {
  let last = 0;
  let timer: number | undefined;
  return {
    /** Schedule a render of getText() into el (leading edge + trailing flush). */
    push(el: Element, getText: () => string): void {
      const now = Date.now();
      if (now - last >= windowMs) {
        if (timer !== undefined) {
          window.clearTimeout(timer);
          timer = undefined;
        }
        last = now;
        el.innerHTML = renderMarkdown(getText());
        // The render grows the section BELOW the current scroll anchor: re-pin
        // to the bottom (auto-scroll guarded) or streaming appears below the fold.
        scrollDown();
        return;
      }
      // Trailing flush: even a slow final chunk eventually gets rendered.
      if (timer === undefined) {
        timer = window.setTimeout(() => {
          timer = undefined;
          last = Date.now();
          el.innerHTML = renderMarkdown(getText());
          scrollDown();
        }, windowMs);
      }
    },
    /** Render the final text immediately (done/error/interrupt/refresh). */
    flush(el: Element | null, getText: () => string): void {
      if (timer !== undefined) {
        window.clearTimeout(timer);
        timer = undefined;
      }
      if (el) {
        el.innerHTML = renderMarkdown(getText());
        scrollDown();
      }
    },
    reset(): void {
      if (timer !== undefined) {
        window.clearTimeout(timer);
        timer = undefined;
      }
      last = 0;
    },
  };
}

const thinkingMd = makeThrottledMd(120);
const answerMd = makeThrottledMd(120);

function flushStreamingMd(): void {
  const tb = currentThinkingBlock?.querySelector(".thinking-body") ?? null;
  thinkingMd.flush(tb, () => currentThinkingText);
  answerMd.flush(currentResultEl, () => currentRawText);
}

function escapeHtml(s: string): string {
  return (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ── Sessions list ──
function renderSessions(sessions: SessionInfo[]): void {
  sessionsEl.innerHTML = "";
  if (!sessions || sessions.length === 0) {
    const p = document.createElement("div");
    p.className = "empty";
    p.textContent = "No sessions yet. Create a new session.";
    sessionsEl.appendChild(p);
    return;
  }
  const openSet = new Set(openIds);
  for (const s of sessions) {
    const row = document.createElement("div");
    row.className = "srow" + (openSet.has(s.id) ? " open" : "") + (workingIds.has(s.id) ? " is-working" : "");
    row.dataset.id = s.id;
    // Creation + last-modified dates, shown before the name.
    const meta = document.createElement("span");
    meta.className = "smeta";
    meta.textContent = "created " + fmtDate(s.createdAt) + " · updated " + fmtDate(s.updatedAt);
    meta.title =
      "Created: " + new Date(s.createdAt).toLocaleString() +
      " · Updated: " + new Date(s.updatedAt).toLocaleString();
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = s.name || "Session";
    name.addEventListener("click", () => vscode.postMessage({ type: "openSession", id: s.id }));
    const actions = document.createElement("span");
    actions.className = "srow-actions";
    actions.innerHTML =
      '<button class="branch" title="Branch (copy) this session">' + icon("i-branch", 13) + "</button>" +
      '<button class="rename" title="Rename">' + icon("i-pencil", 13) + "</button>" +
      '<button class="del" title="Delete">' + icon("i-trash", 13) + "</button>";
    const branchBtn = actions.querySelector(".branch") as HTMLButtonElement;
    (actions.querySelector(".rename") as HTMLButtonElement).addEventListener("click", (e) => {
      e.stopPropagation();
      vscode.postMessage({ type: "renameSession", id: s.id });
    });
    const del = actions.querySelector(".del") as HTMLButtonElement;
    const renameBtn = actions.querySelector(".rename") as HTMLButtonElement;
    // A working session cannot be branched/deleted/renamed: enrich the buttons.
    if (workingIds.has(s.id)) {
      del.disabled = true;
      del.title = "Session is working — stop it before deleting";
      renameBtn.disabled = true;
      renameBtn.title = "Session is working — stop it before renaming";
      branchBtn.disabled = true;
      branchBtn.title = "Session is working — stop it before branching";
    }
    branchBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      vscode.postMessage({ type: "branchSession", id: s.id });
    });
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      vscode.postMessage({ type: "deleteSession", id: s.id });
    });
    row.appendChild(meta);
    row.appendChild(name);
    row.appendChild(actions);
    sessionsEl.appendChild(row);
  }
}

/** Compact date+time: dd/mm hh:mm (local time). */
function fmtDate(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return pad(d.getDate()) + "/" + pad(d.getMonth() + 1) + " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
}

// ── Tabs ──
function renderTabs(sessions: SessionInfo[]): void {
  tabsEl.innerHTML = "";
  const byId = new Map(sessions.map((s) => [s.id, s]));
  for (const id of openIds) {
    const s = byId.get(id);
    const tab = document.createElement("div");
    tab.className = "tab" + (id === activeId ? " active" : "");
    tab.dataset.id = id;
    tab.title = s?.name || "Session";
    const label = document.createElement("span");
    label.textContent = s?.name || "Session";
    const close = document.createElement("span");
    close.className = "close";
    close.innerHTML = icon("i-x", 11);
    close.addEventListener("click", (e) => {
      e.stopPropagation();
      vscode.postMessage({ type: "closeTab", id });
    });
    tab.appendChild(label);
    tab.appendChild(close);
    tabsEl.appendChild(tab);
    tab.addEventListener("click", () => {
      if (id !== activeId) vscode.postMessage({ type: "switchTab", id });
    });
  }
}

// ── Chat rendering engine ──
const SCROLL_BOTTOM_TOLERANCE = 40;
let autoScroll = true;

/** Scrolls to the last emitted line, but only while the user is anchored at
 * the bottom: scrolling UP disables auto-scroll, reaching the bottom re-enables. */
function scrollDown(): void {
  if (!autoScroll) return;
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

messagesEl.addEventListener("scroll", () => {
  const nearBottom =
    messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < SCROLL_BOTTOM_TOLERANCE;
  autoScroll = nearBottom;
});

function addMessage(role: string, content: string): HTMLDivElement {
  const div = document.createElement("div");
  div.className = "msg " + role;
  if (role === "assistant" || role === "tool") {
    div.innerHTML = renderMarkdown(content || "");
  } else {
    div.textContent = content || "";
  }
  messagesEl.appendChild(div);
  scrollDown();
  return div;
}

function addThinkingBlock(text: string, beforeEl?: HTMLElement | null): HTMLDivElement {
  return makeThinkingBlock("🤔 Thinking...", text, undefined, beforeEl);
}

/** Builds a collapsible "thinking-style" block (shared by thinking + compaction notes). */
function makeThinkingBlock(
  label: string,
  bodyText: string,
  host?: HTMLElement | null,
  beforeEl?: HTMLElement | null,
): HTMLDivElement {
  const block = (host ?? document.createElement("div")) as HTMLDivElement;
  block.className = "thinking-block";
  block.innerHTML =
    '<div class="thinking-header"><span class="toggle">▼</span>' + label + "</div>" +
    '<div class="thinking-body"></div>';
  const body = block.querySelector(".thinking-body");
  if (body) body.innerHTML = renderMarkdown(bodyText);
  const header = block.querySelector(".thinking-header");
  header?.addEventListener("click", () => {
    const b = block.querySelector(".thinking-body");
    const tog = block.querySelector(".toggle");
    if (!b || !tog) return;
    const collapsed = b.classList.toggle("collapsed");
    tog.textContent = collapsed ? "▶" : "▼";
  });
  if (!host) {
    if (beforeEl && beforeEl.parentNode) beforeEl.parentNode.insertBefore(block, beforeEl);
    else messagesEl.appendChild(block);
  }
  return block;
}

function addToolCall(name: string, args: unknown, beforeEl?: HTMLElement | null): HTMLDivElement {
  const div = document.createElement("div");
  div.className = "msg tool tool-call-pending";
  div.innerHTML =
    '<div class="tool-header">' +
    '<span class="tool-toggle">▶</span>' +
    '<span class="tool-name">🔧 ' + escapeHtml(name) + "</span>" +
    "</div>" +
    '<div class="tool-details collapsed">' +
    '<div class="tool-input"><span class="tool-label">Input</span><pre class="tool-args">' + escapeHtml(formatArgs(args)) + "</pre></div>" +
    '<div class="tool-output"><span class="tool-label">Output</span><pre class="tool-result">⏳ running…</pre></div>' +
    "</div>";
  const header = div.querySelector(".tool-header");
  header?.addEventListener("click", () => {
    const details = div.querySelector(".tool-details");
    const tog = div.querySelector(".tool-toggle");
    if (!details || !tog) return;
    const collapsed = details.classList.toggle("collapsed");
    tog.textContent = collapsed ? "▶" : "▼";
  });
  if (beforeEl && beforeEl.parentNode) beforeEl.parentNode.insertBefore(div, beforeEl);
  else messagesEl.appendChild(div);
  scrollDown();
  return div;
}

function addWorking(): HTMLDivElement {
  workingEl = workingBar;
  workingBar.classList.remove("hidden");
  workingBar.textContent = "● Working...";
  scrollDown();
  return workingBar;
}

function hideWorking(): void {
  workingEl = null;
  workingBar.classList.add("hidden");
}

function ensureResult(): HTMLDivElement | null {
  if (currentResultEl) return currentResultEl;
  if (!workingEl) return null;
  // Each emission segment (after a thinking/tool phase) gets its OWN blue
  // bubble, appended in chronological order — nothing ever moves.
  currentResultEl = document.createElement("div");
  currentResultEl.className = "msg assistant";
  messagesEl.appendChild(currentResultEl);
  return currentResultEl;
}

function addWelcome(): HTMLDivElement {
  const div = document.createElement("div");
  div.className = "msg welcome";
  div.innerHTML = "<b>👋 Harny</b><br><small>Write a message and press Enter</small>";
  messagesEl.appendChild(div);
  return div;
}

/**
 * No single workspace folder: sessions live per-folder (`<root>/.harny-sessions`)
 * so Harny requires exactly one open folder. The whole control stack and the
 * sessions card are hidden; a folder hero takes over the chat area.
 */
function renderWorkspaceShell(): void {
  document.body.classList.add("no-workspace");
  document.body.classList.remove("no-session");
  messagesEl.innerHTML = "";
  const hero = document.createElement("div");
  hero.className = "empty-hero";
  hero.innerHTML =
    '<div class="empty-icon">📁</div>' +
    "<h2>Harny</h2>" +
    "<p>Harny needs a single open folder.</p>" +
    '<p class="empty-hint">Open one folder (File → Open Folder) to start sessions and chat.<br>' +
    "Multi-root workspaces are not supported yet.</p>";
  messagesEl.appendChild(hero);
}

/** Confirm a workspace folder is present before touching the transcript. */
function workspaceLocked(config: { workspaceReady?: boolean }): boolean {
  return config.workspaceReady === false;
}

/**
 * Empty shell: NO open session. The control stack (input, status, metrics)
 * is hidden via the `no-session` body class and a hero takes over the chat
 * area, pushing the user to pick a session from the list or create a new one.
 */
function renderEmptyShell(): void {
  document.body.classList.add("no-session");
  messagesEl.innerHTML = "";
  const hero = document.createElement("div");
  hero.className = "empty-hero";
  hero.innerHTML =
    '<div class="empty-icon">✨</div>' +
    "<h2>Harny</h2>" +
    "<p>No session is open right now.</p>" +
    '<p class="empty-hint">Pick one from the list above,<br>start a new conversation,<br>or branch an existing session.</p>' +
    '<button id="empty-new-session" class="empty-cta" title="Create a new session">New session</button>';
  messagesEl.appendChild(hero);
  hero.querySelector("#empty-new-session")?.addEventListener("click", () => {
    vscode.postMessage({ type: "newSession" });
  });
  // The sessions list is the second path to act: make sure it stays visible.
  sessionsEl.classList.remove("hidden");
  const toggle = sessionHead.querySelector(".toggle");
  if (toggle) toggle.textContent = "▼";
}

function renderMessages(msgs: ChatMsg[]): boolean {
  const outputs = new Map<string, string>();
  for (const m of msgs) {
    if (m.role === "tool" && m.toolCallId && m.content) outputs.set(m.toolCallId, m.content);
  }
  let hasVisible = false;
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (m.role === "system" || m.role === "tool") continue;
    hasVisible = true;
    if (m.role === "assistant") {
      if (m.thinking) addThinkingBlock(m.thinking);
      if (m.toolCalls && m.toolCalls.length > 0) {
        for (const tc of m.toolCalls) {
          const id = tc.id ?? tc.name;
          const el = addToolCall(tc.name, tc.arguments);
          el.classList.remove("tool-call-pending");
          const out = el.querySelector(".tool-result");
          if (out) {
            const text = outputs.get(id);
            renderToolOutput(out as HTMLPreElement, text !== undefined ? text.slice(0, 12000) : "");
          }
        }
      }
      const content = m.content || "";
      if (content === "" || content.startsWith("🔧 ")) continue;
      const el = addMessage("assistant", content);
      if (content.startsWith("❌")) el.classList.add("error");
      attachBranchAt(el, i);
    } else {
      addMessage(m.role, m.content || "");
    }
  }
  return hasVisible;
}

function icon(id: keyof typeof ICON_GLYPHS, size = 14): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true">${ICON_GLYPHS[id]}</svg>`;
}

const ICON_GLYPHS: Record<string, string> = {"i-play":"<path d=\"M8 5v14l11-7z\" fill=\"currentColor\"/>","i-stop":"<rect x=\"6\" y=\"6\" width=\"12\" height=\"12\" rx=\"2\" fill=\"currentColor\"/>","i-plus":"<path d=\"M12 5v14M5 12h14\" stroke=\"currentColor\" stroke-width=\"2.5\" stroke-linecap=\"round\" fill=\"none\"/>","i-minus":"<path d=\"M5 12h14\" stroke=\"currentColor\" stroke-width=\"2.5\" stroke-linecap=\"round\" fill=\"none\"/>","i-x":"<path d=\"M18 6 6 18M6 6l12 12\" stroke=\"currentColor\" stroke-width=\"2.5\" stroke-linecap=\"round\" fill=\"none\"/>","i-pencil":"<path d=\"M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linejoin=\"round\" fill=\"none\"/>","i-trash":"<path d=\"M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" fill=\"none\"/>","i-branch":"<path d=\"M6 3v12\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" fill=\"none\"/><circle cx=\"18\" cy=\"6\" r=\"3\" fill=\"currentColor\"/><circle cx=\"6\" cy=\"18\" r=\"3\" fill=\"currentColor\"/><path d=\"M18 9a9 9 0 0 1-9 9\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" fill=\"none\"/>"};

/**
 * Small ⎇ key on an assistant reply: branches the session UP TO AND
 * INCLUDING this message (popup-modal naming, uniqueness enforced, mirror of
 * the sessions-list branch). Revealed on hover; disabled while working.
 */
function attachBranchAt(el: HTMLElement, index: number): void {
  const b = document.createElement("button");
  b.className = "branch-at";
  b.title = "Branch session from this point (up to and including this reply)";
  b.innerHTML = icon("i-branch", 12);
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    vscode.postMessage({ type: "branchAt", index });
  });
  el.appendChild(b);
}

function finishStream(): void {
  hideWorking();
  // When interrupted, the red bubble was already added by the host; never
  // append a stray "(empty response)" fallback for that case.
  if (!currentResultEl && !aborted) {
    const el = document.createElement("div");
    el.className = "msg assistant";
    el.innerHTML = "<em>(empty response)</em>";
    messagesEl.appendChild(el);
  }
  resetStreamState();
}

function resetStreamState(): void {
  thinkingMd.reset();
  answerMd.reset();
  currentResultEl = null;
  currentThinkingBlock = null;
  currentThinkingText = "";
  currentRawText = "";
  hideWorking();
  aborted = false;
  pendingToolCalls.clear();
}

function formatArgs(args: unknown): string {
  if (!args) return "";
  try {
    return JSON.stringify(args, null, 2);
  } catch {
    return String(args);
  }
}

/** Basename of the file the tool touched, read from the tool-call args JSON. */
function extractPath(pre: HTMLElement): string | undefined {
  const argsEl = pre.closest(".msg.tool")?.querySelector(".tool-args");
  if (!argsEl?.textContent) return undefined;
  try {
    const args = JSON.parse(argsEl.textContent) as Record<string, unknown>;
    if (typeof args.path !== "string" || !args.path) return undefined;
    return args.path.split("/").pop() || args.path;
  } catch {
    return undefined;
  }
}

/**
 * Creates the DEDICATED diff bubble for a file-touching tool (Edit/Write/
 * Delete) and inserts it into the message flow right after the tool bubble.
 * Diff graphics: + lines green, − lines red, @@ hunks accent, context gray.
 * The bubble is collapsible; its header shows the file basename and +N/−M.
 */
function addFileDiffBubble(pre: HTMLElement, body: string, stat: string | undefined): void {
  const toolEl = pre.closest(".msg.tool");
  if (!toolEl) return;
  const bubble = document.createElement("div");
  bubble.className = "msg file-diff";

  const header = document.createElement("div");
  header.className = "fd-header";
  const title = extractPath(pre);
  header.innerHTML =
    '<span class="fd-toggle">▼</span>' +
    '<span class="fd-title">' +
    (title ? "📄 " + escapeHtml(title) : "Diff") +
    "</span>" +
    '<span class="fd-stat">' +
    escapeHtml(stat ?? countDiff(body)) +
    "</span>";

  const list = document.createElement("div");
  list.className = "fd-body";
  // Critical layout is INLINE (not in the stylesheet): the body can never
  // collapse to a single row even if the injected CSS is stale/missing.
  list.style.display = "block";
  for (const raw of body.split("\n")) {
    const line = document.createElement("div");
    line.style.display = "block";
    if (raw.startsWith("@@")) line.className = "fd-hunk";
    else if (raw.startsWith("+") && !raw.startsWith("+++")) line.className = "fd-add";
    else if (raw.startsWith("-") && !raw.startsWith("---")) line.className = "fd-del";
    else line.className = "fd-ctx";
    line.textContent = raw;
    list.appendChild(line);
  }
  bubble.appendChild(header);
  bubble.appendChild(list);
  header.addEventListener("click", () => {
    const collapsed = list.style.display === "none";
    list.style.display = collapsed ? "block" : "none";
    const tog = header.querySelector(".fd-toggle");
    if (tog) tog.textContent = collapsed ? "▼" : "▶";
  });

  toolEl.after(bubble);
  scrollDown();
}

/**
 * Fills a tool-result <pre> — PLAIN TEXT, exactly like before: the tool bubble
 * keeps its Input/Output structure and no line-prefix heuristics are applied
 * (a `ls -la` listing is never colored as a diff). The only exception: an
 * explicit ```diff fence is the signal for a file change — it is REMOVED from
 * the output and rendered instead as a dedicated diff bubble right after the
 * tool bubble (green + / red −).
 */
function renderToolOutput(el: HTMLElement, text: string): void {
  el.textContent = "";
  const found = splitDiffFence(text);
  if (found) {
    // Defensive: a degenerate fence with no body must NOT create a phantom
    // one-row bubble — show the raw text instead.
    if (!found.body.trim()) {
      el.textContent = text;
      return;
    }
    el.textContent = found.rest;
    addFileDiffBubble(el, found.body, found.stat);
  } else {
    el.textContent = text;
  }
}

// ── Actions ──
const MAX_INPUT_HEIGHT = 240; // must match #user-input max-height in view-html.ts
function resizeInput(): void {
  inputEl.style.height = "auto";
  const next = Math.min(inputEl.scrollHeight, MAX_INPUT_HEIGHT);
  inputEl.style.height = next + "px";
  inputEl.style.overflowY = next >= MAX_INPUT_HEIGHT ? "auto" : "hidden";
}

function send(): void {
  if (sendBtn.disabled || !activeId) return;
  const text = inputEl.value.trim();
  if (!text) return;
  inputEl.value = "";
  inputEl.style.height = "auto"; // back to a single line for the next message
  currentResultEl = null;
  currentThinkingBlock = null;
  currentThinkingText = "";
  currentRawText = "";
  aborted = false;
  pendingToolCalls.clear();
  // Show the user's message immediately (don't wait for the turn to finish).
  addMessage("user", text);
  workingEl = addWorking();
  scrollDown();
  vscode.postMessage({ type: "send", text });
  setStreaming(true);
}

// ── Custom hover tooltip removed: native title attributes are used instead ──

sendBtn.addEventListener("click", send);
inputEl.addEventListener("input", resizeInput);
// Recompute the height when the input's width changes (panel/window resize),
// because line wrapping depends on width. Guarded ResizeObserver avoids loops.
if (typeof ResizeObserver !== "undefined") {
  new ResizeObserver(resizeInput).observe(inputEl);
}
window.addEventListener("resize", resizeInput);
inputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
  if (e.key === "Escape") vscode.postMessage({ type: "abort" });
});
abortBtn.addEventListener("click", () => vscode.postMessage({ type: "abort" }));
// Collapse/expand the control stack (model, window, sampling, metrics).
ctlToggle.addEventListener("click", () => {
  const collapsed = document.body.classList.toggle("controls-collapsed");
  ctlToggle.setAttribute("aria-expanded", String(!collapsed));
});
newSessionBtn.addEventListener("click", () => vscode.postMessage({ type: "newSession" }));
sessionHead.addEventListener("click", () => {
  sessionsEl.classList.toggle("hidden");
  const t = sessionHead.querySelector(".toggle");
  if (t) t.textContent = sessionsEl.classList.contains("hidden") ? "▶" : "▼";
});

// The PLAY button blinks while the LLM works (streaming OR compaction): the same
// harny-pulse animation as the chat "Working..." bubble, added in the same tick
// the bubble is created (send/compactStart), so they pulse in sync. No LED
// indicator anymore — the tone is the color/label of the bubble + this blink.
// ── Session-name modal (in-panel, blurred overlay) ──
const nameModal = document.getElementById("name-modal") as HTMLDivElement;
const nameTitle = document.getElementById("name-modal-title") as HTMLElement;
const nameInput = document.getElementById("name-input") as HTMLInputElement;
const nameOk = document.getElementById("name-ok") as HTMLButtonElement;
const nameCancel = document.getElementById("name-cancel") as HTMLButtonElement;
const nameError = document.getElementById("name-error") as HTMLDivElement;
let namePrompt: { mode: string; id?: string } | undefined;
let nameModalId = -1;

/**
 * Name conflict for the dialog: empty or a name already used by ANOTHER
 * session of this workspace (the renamed session itself is excluded).
 * Case-insensitive, trimmed.
 */
function nameConflict(excludedId?: string): string | undefined {
  const raw = nameInput.value.trim();
  if (!raw) return "Name cannot be empty";
  const lower = raw.toLowerCase();
  const taken = currentSessions.some(
    (s) => s.id !== excludedId && (s.name || "").trim().toLowerCase() === lower,
  );
  return taken
    ? "A session with this name already exists in this workspace — pick another name."
    : undefined;
}

function validateNameInput(): void {
  const excluded = namePrompt?.mode === "rename" ? namePrompt.id : undefined;
  const conflict = nameConflict(excluded);
  nameError.textContent = conflict ?? "";
  nameOk.disabled = !!conflict;
}

function openNameModal(p: { mode: string; id?: string; current?: string; modalId?: number }): void {
  namePrompt = { mode: p.mode, id: p.id };
  nameModalId = typeof p.modalId === "number" ? p.modalId : -1;
  const branch = p.mode === "branch";
  nameTitle.textContent = branch
    ? "Branch session"
    : p.mode === "rename"
      ? "Rename session"
      : "Name the new session";
  nameOk.textContent = branch ? "Branch" : p.mode === "rename" ? "Rename" : "Create";
  nameInput.value = p.current ?? "New Session";
  nameModal.classList.remove("hidden");
  nameInput.focus();
  nameInput.select();
  validateNameInput();
}

function closeNameModal(): void {
  namePrompt = undefined;
  nameModal.classList.add("hidden");
}

// ── In-panel alert / confirm modal (host replaces native VS Code dialogs) ──
const alertModal = document.getElementById("alert-modal") as HTMLDivElement;
const alertTitle = document.getElementById("alert-title") as HTMLElement;
const alertMessage = document.getElementById("alert-message") as HTMLDivElement;
const alertOk = document.getElementById("alert-ok") as HTMLButtonElement;
const alertCancel = document.getElementById("alert-cancel") as HTMLButtonElement;
let alertId = -1;

function openAlert(a: { modalId?: number; id?: number; kind: string; alertKind?: string; title: string; message: string; confirmText?: string; danger?: boolean }): void {
  alertId = typeof a.modalId === "number" ? a.modalId : typeof a.id === "number" ? a.id : -1;
  alertTitle.textContent = a.title;
  alertMessage.textContent = a.message;
  const confirm = (a.alertKind ?? a.kind) === "confirm";
  alertCancel.style.display = confirm ? "" : "none";
  alertOk.textContent = a.confirmText ?? "OK";
  alertOk.classList.toggle("danger", !!a.danger);
  alertModal.classList.remove("hidden");
  alertOk.focus();
}

function closeAlert(ok: boolean): void {
  if (alertId < 0) return;
  const id = alertId;
  alertId = -1;
  alertModal.classList.add("hidden");
  vscode.postMessage({ type: "modalResponse", id, value: ok });
}

alertOk.addEventListener("click", () => closeAlert(true));
alertCancel.addEventListener("click", () => closeAlert(false));
alertModal.querySelector(".alert-backdrop")?.addEventListener("click", () => closeAlert(false));
window.addEventListener("keydown", (e) => {
  if (alertId >= 0 && e.key === "Escape") {
    e.preventDefault();
    closeAlert(false);
  }
});

function submitName(): void {
  if (!namePrompt) return;
  // The OK key is disabled while invalid; Enter must not bypass the check.
  if (nameOk.disabled) {
    nameInput.focus();
    return;
  }
  const name = nameInput.value.trim();
  if (!name) {
    nameInput.focus();
    return;
  }
  const modalId = nameModalId;
  closeNameModal();
  vscode.postMessage({ type: "modalResponse", id: modalId, value: name });
}

// ── View lock (per active session) ──
// While the active session's LLM works (streaming OR compaction) everything
// below the transcript is disabled except Stop; the sessions list / tabs stay
// usable so you can open or switch to another session and work in parallel.
let streamingActive = false;
let thinkingCapable = false; // provider declares thinking control (bool/effort)

function setStreaming(active: boolean): void {
  const rising = active && !streamingActive;
  streamingActive = active;
  if (rising) {
    // Entering working always pins the transcript at the bottom with
    // auto-scroll ON: the reply is arriving below, even if the user had
    // scrolled up to re-read older content.
    autoScroll = true;
    scrollDown();
  }
  sendBtn.classList.toggle("blinking", active);
  sendBtn.disabled = !activeId || active;
  abortBtn.disabled = !active;
  compactBtn.disabled = active;
  modelSelect.disabled = active;
  thinkingSelect.disabled = active || !thinkingCapable;
  ctxMinus.disabled = active;
  ctxPlus.disabled = active;
  ctxInput.disabled = active;
  outMinus.disabled = active;
  outPlus.disabled = active;
  outInput.disabled = active;
  sampInput.disabled = active;
  sampMinus.disabled = active;
  sampPlus.disabled = active;
  sampAuto.disabled = active;
  samplerTemp.disabled = active;
  samplerTopp.disabled = active;
  presenceInput.disabled = active;
  presenceMinus.disabled = active;
  presencePlus.disabled = active;
  presenceAuto.disabled = active;
  freqInput.disabled = active;
  freqMinus.disabled = active;
  freqPlus.disabled = active;
  freqAuto.disabled = active;
  inputEl.disabled = active;
  // Branch keys on assistant bubbles follow the same lock.
  for (const b of document.querySelectorAll<HTMLButtonElement>(".branch-at")) {
    b.disabled = active;
  }
}

// ── Model dropdown (all providers, declared or detected from the host) ──
/* Explicit in-panel warning instead of a silently empty model dropdown: shows
   when NO model is configured at all (missing/empty config.json or every host
   unreachable), or when some host model lists failed to fetch. */
function renderModelWarnings(c: ConfigState): void {
  if (c.noModels) {
    const home = c.configHome ? `${c.configHome}/config.json` : "your extension data folder";
    modelWarn.hidden = false;
    modelWarn.innerHTML =
      '⚠️ <strong>No models configured.</strong> Create <span class="warn-path">' +
      home +
      '</span> from <code>config.example.jsonc</code>, or set <code>harny.model</code>/<code>harny.apiKey</code> ' +
      "in settings — then reload.";
    modelWarn.title =
      "The model dropdown is empty: the panel needs at least one model (declared in config.json or fetched from a host).";
  } else if (c.hostModelsError) {
    modelWarn.hidden = false;
    modelWarn.textContent =
      "⚠️ Some host model lists are unavailable (GET /v1/models failed) — the dropdown may be incomplete. Check the hosts.";
  } else {
    modelWarn.hidden = true;
  }
}

function renderModelSelect(c: ConfigState): void {
  modelSelect.innerHTML = "";
  // New sessions start with no model: show a placeholder so the browser does
  // not auto-select the first entry, forcing an explicit choice.
  if (!c.model) {
    const ph = document.createElement("option");
    ph.value = "";
    ph.textContent = "— Select a model —";
    ph.disabled = true;
    ph.selected = true;
    modelSelect.appendChild(ph);
  }
  const providerModels = c.providerModels && c.providerModels.length > 0 ? c.providerModels : null;
  const activeProvider = c.activeProvider;
  // If the saved model is no longer served, show a disabled placeholder.
  const list = providerModels
    ? new Set(providerModels.map((p) => p.model))
    : new Set(c.models || []);
  if (c.modelMissing && c.model && !list.has(c.model)) {
    const opt = document.createElement("option");
    opt.value = c.model;
    opt.textContent = "⚠️ " + c.model + " (removed from host)";
    opt.disabled = true;
    opt.selected = true;
    modelSelect.appendChild(opt);
  }

  if (providerModels) {
    const groups = new Map<string, string[]>();
    const order: string[] = [];
    for (const pm of providerModels) {
      if (!groups.has(pm.provider)) {
        groups.set(pm.provider, []);
        order.push(pm.provider);
      }
      groups.get(pm.provider)!.push(pm.model);
    }
    for (const provider of order) {
      const g = document.createElement("optgroup");
      g.label = provider;
      // Alphabetical within each provider group.
      const sorted = [...(groups.get(provider) || [])].sort();
      for (const m of sorted) {
        const opt = document.createElement("option");
        opt.value = m;
        opt.textContent = m;
        opt.dataset.provider = provider;
        if (m === c.model && (provider === activeProvider || !activeProvider)) opt.selected = true;
        g.appendChild(opt);
      }
      modelSelect.appendChild(g);
    }
  } else {
    const models = (c.models && c.models.length > 0 ? [...c.models] : c.model ? [c.model] : []).sort();
    for (const m of models) {
      const opt = document.createElement("option");
      opt.value = m;
      opt.textContent = m;
      if (m === c.model) opt.selected = true;
      modelSelect.appendChild(opt);
    }
  }
}
modelSelect.addEventListener("change", () => {
  const opt = modelSelect.selectedOptions[0];
  if (!opt) return;
  if (!opt.value) return; // placeholder
  const message: Record<string, unknown> = { type: "setModel", model: opt.value };
  if (opt.dataset.provider) message.provider = opt.dataset.provider;
  vscode.postMessage(message);
});

// ── Thinking level (reasoning effort, generalized across providers) ──
function renderThinkingSelect(c: ConfigState): void {
  const mode = c.thinkingMode;
  const enabled = mode === "bool" || mode === "effort";
  thinkingCapable = enabled;
  thinkingSelect.disabled = streamingActive || !enabled;
  const level =
    c.thinkingLevel && ["off", "low", "medium", "high"].includes(c.thinkingLevel)
      ? c.thinkingLevel
      : "off";
  thinkingSelect.value = level;
  thinkingSelect.title = enabled
    ? "Thinking level / reasoning effort (per session)"
    : "This provider/model does not declare thinking control (add \"thinking\": \"bool\" or \"effort\" to its config entry)";
}
thinkingSelect.addEventListener("change", () => {
  if (thinkingSelect.disabled) return;
  const level = thinkingSelect.value;
  if (!["off", "low", "medium", "high"].includes(level)) return;
  vscode.postMessage({ type: "setThinkingLevel", level });
});

// ── Input sanitizers: numbers are typed freely, but only VALID characters ──
/** Context window / output tokens: digits only (integers). */
function sanitizeIntegerInput(raw: string): string {
  return raw.replace(/\D/g, "");
}
/** Temperature: digits + ONE decimal separator (" . ", comma converted). */
function sanitizeFloatInput(raw: string): string {
  const cleaned = raw.replace(",", ".").replace(/[^\d.]/g, "");
  const firstDot = cleaned.indexOf(".");
  if (firstDot < 0) return cleaned;
  return cleaned.slice(0, firstDot + 1) + cleaned.slice(firstDot + 1).replace(/\./g, "");
}

function bindIntegerInput(el: HTMLInputElement): void {
  el.addEventListener("input", () => {
    const v = sanitizeIntegerInput(el.value);
    if (v !== el.value) el.value = v;
  });
}

// Context-window spinner ──
function sendContextWindow(value: number): void {
  const v = clampContextWindow(value);
  ctxInput.value = String(v);
  vscode.postMessage({ type: "setContextWindow", value: v });
}

// ── Output-tokens spinner (max tokens per response) ──
function sendOutputTokens(value: number): void {
  const v = clampOutputTokens(value);
  outInput.value = String(v);
  vscode.postMessage({ type: "setOutputTokens", value: v });
}

function renderOutputTokens(c: ConfigState): void {
  const v = clampOutputTokens(c.outputTokens ?? DEFAULT_OUTPUT_TOKENS);
  outInput.value = String(v);
}

// ── Sampling controls (Temperature, Presence/Frequency penalty) ──
// Each is a 0.0→2.0 float stepper with an "Auto" reset: digits + ONE
// decimal point, empty = Auto (not sent). One factory keeps them identical.
interface FloatControl {
  input: HTMLInputElement;
  render(value: unknown): void;
}

function createFloatControl(
  refs: { input: string; minus: string; plus: string; auto: string },
  sendType: "setSamplerValue" | "setPresencePenalty" | "setFrequencyPenalty",
  clamp: (v: number) => number | undefined = clampTemperature,
): FloatControl {
  const input = document.getElementById(refs.input) as HTMLInputElement;
  const minus = document.getElementById(refs.minus) as HTMLButtonElement;
  const plus = document.getElementById(refs.plus) as HTMLButtonElement;
  const auto = document.getElementById(refs.auto) as HTMLButtonElement;

  const send = (value: number | null): void => {
    if (value === null) {
      input.value = "";
      vscode.postMessage({ type: sendType, value: null });
      return;
    }
    const v = clamp(value);
    if (v === undefined) {
      input.value = "";
      vscode.postMessage({ type: sendType, value: null });
      return;
    }
    input.value = String(v);
    vscode.postMessage({ type: sendType, value: v });
  };
  const current = (): number => {
    const raw = input.value.trim();
    if (raw === "") return 0;
    const n = Number(raw);
    return Number.isFinite(n) ? n : 0;
  };
  const read = (): void => {
    const raw = input.value.trim();
    if (raw === "") {
      send(null); // Auto
      return;
    }
    const n = Number(raw);
    send(Number.isNaN(n) ? null : n);
  };

  input.addEventListener("input", () => {
    const v = sanitizeFloatInput(input.value);
    if (v !== input.value) input.value = v;
  });
  input.addEventListener("change", read);
  minus.addEventListener("click", () => send(current() - TEMPERATURE_STEP));
  plus.addEventListener("click", () => send(current() + TEMPERATURE_STEP));
  auto.addEventListener("click", () => send(null));
  return { input, render: (value: unknown) => { input.value = typeof value === "number" && Number.isFinite(value) ? String(Math.round(value * 10) / 10) : ""; } };
}

// Shared sampler stepper: the scale follows the selected radio (0.0–2.0 when
// Temperature, 0.0–1.0 when Top-P); switching mode resets the value to Auto.
const samplerClamp = (v: number): number | undefined => (samplerTopp.checked ? clampTopP(v) : clampTemperature(v));
const samplerControl = createFloatControl(
  { input: "samp-input", minus: "samp-minus", plus: "samp-plus", auto: "samp-auto" },
  "setSamplerValue",
  samplerClamp,
);

/** Sampler radios: brand the active option; show its value in the shared stepper. */
function renderSamplerControl(c: ConfigState): void {
  const active = c.sampler === "topP" ? "topP" : "temperature"; // default = temperature
  samplerTemp.checked = active === "temperature";
  samplerTopp.checked = active === "topP";
  samplerControl.render(active === "topP" ? c.topP : c.temperature);
}

samplerTemp.addEventListener("change", () => vscode.postMessage({ type: "setSamplerMode", mode: "temperature" }));
samplerTopp.addEventListener("change", () => vscode.postMessage({ type: "setSamplerMode", mode: "topP" }));

const presenceControl = createFloatControl({ input: "presence-input", minus: "presence-minus", plus: "presence-plus", auto: "presence-auto" }, "setPresencePenalty");
const freqControl = createFloatControl({ input: "freq-input", minus: "freq-minus", plus: "freq-plus", auto: "freq-auto" }, "setFrequencyPenalty");

/** Compact token counts: 12345 -> "12.3k", 2000000 -> "2M". */
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, "") + "k";
  return String(n);
}

function renderMetrics(c: ConfigState): void {
  const ctx = clampContextWindow(c.contextWindow || DEFAULT_CONTEXT_WINDOW);
  const used = c.contextTokens ?? 0;
  metCtx.textContent = fmtTokens(ctx);
  metTokens.textContent = fmtTokens(used);
  // Exact counts stay reachable via the tooltip.
  metTokens.title = String(used);
  metCtx.title = String(ctx);
  const pct = ctx > 0 ? Math.max(0, Math.min(100, Math.round((used / ctx) * 100))) : 0;
  metPct.textContent = "(" + pct + "%)";
  metPct.classList.toggle("warn", pct >= 90);
  ctxBar.style.width = pct + "%";
  ctxBar.classList.toggle("warn", pct >= 90);
  // Prompt-cache badge: always occupies its slot so the layout is stable and
  // the feature is discoverable even when the provider doesn't report hits.
  const cached = c.cachedTokens;
  const write = c.cachedWrite;
  if (cached !== undefined && cached > 0 && used > 0) {
    // Clamp to 100%: cached can momentarily exceed the rough context estimate
    // (e.g. right after compaction the estimate differs from real usage).
    const saved = Math.min(100, Math.round((cached / used) * 100));
    const writeTxt = write && write > 0 ? " · write " + fmtTokens(write) : "";
    metCache.textContent = "⚡ cache " + fmtTokens(cached) + " (" + saved + "%)" + writeTxt;
    metCache.title =
      "Input tokens served from prompt cache: " + cached + " / " + saved + "%" +
      (write && write > 0 ? " · written to cache: " + write : "");
    metCache.classList.remove("idle");
  } else if (write && write > 0) {
    // Cache cold but this turn wrote into it: tell that truth instead of "–".
    metCache.textContent = "⚡ write " + fmtTokens(write);
    metCache.title = "Tokens written into the prompt cache: " + write;
    metCache.classList.remove("idle");
  } else {
    metCache.textContent = "⚡ cache –";
    metCache.title = "Cached input tokens not reported by this provider";
    metCache.classList.add("idle");
  }
}

compactBtn.addEventListener("click", () => vscode.postMessage({ type: "compact" }));
ctxMinus.addEventListener("click", () => sendContextWindow(clampContextWindow(Number(ctxInput.value)) - CONTEXT_STEP));
ctxPlus.addEventListener("click", () => sendContextWindow(clampContextWindow(Number(ctxInput.value)) + CONTEXT_STEP));
// Fire on change (blur/Enter), not on every keystroke, so values can be typed freely.
ctxInput.addEventListener("change", () => sendContextWindow(clampContextWindow(Number(ctxInput.value))));
bindIntegerInput(ctxInput);
outMinus.addEventListener("click", () => sendOutputTokens(clampOutputTokens(Number(outInput.value)) - OUTPUT_STEP));
outPlus.addEventListener("click", () => sendOutputTokens(clampOutputTokens(Number(outInput.value)) + OUTPUT_STEP));
outInput.addEventListener("change", () => sendOutputTokens(clampOutputTokens(Number(outInput.value))));
bindIntegerInput(outInput);
// The 3 sampling steppers (temp / presence / freq) are wired by
// createFloatControl above (sanitize, change, ±, Auto).

// ── Host messages ──
window.addEventListener("message", (e) => {
  const msg = e.data;
  switch (msg.type) {
    case "textDelta": {
      const resultEl = ensureResult();
      if (resultEl) {
        currentRawText += msg.content;
        answerMd.push(resultEl, () => currentRawText);
        scrollDown();
      }
      break;
    }
    case "thinkingDelta": {
      if (!currentThinkingBlock) {
        // A thinking phase starts a NEW segment: commit any pending renders and
        // close the previous answer bubble — the next text emission will get a
        // fresh blue bubble (chronology, nothing moves).
        flushStreamingMd();
        currentThinkingBlock = addThinkingBlock("");
        currentThinkingText = "";
        currentResultEl = null;
        currentRawText = "";
      }
      if (currentThinkingBlock) {
        currentThinkingText += msg.content;
        const body = currentThinkingBlock.querySelector(".thinking-body");
        if (body) thinkingMd.push(body, () => currentThinkingText);
        scrollDown();
      }
      break;
    }
    case "toolCall": {
      // A tool phase ends the current answer segment: commit pending renders
      // and close the bubble — later text becomes a NEW blue bubble.
      flushStreamingMd();
      const toolEl = addToolCall(msg.name, msg.arguments);
      pendingToolCalls.set(msg.id, toolEl);
      if (workingEl) workingEl.textContent = "● Working... 🔧 " + msg.name;
      currentThinkingBlock = null;
      currentThinkingText = "";
      currentResultEl = null;
      currentRawText = "";
      break;
    }
    case "toolResult": {
      const el = pendingToolCalls.get(msg.toolCallId);
      if (el) {
        el.classList.remove("tool-call-pending");
        const resultEl = el.querySelector(".tool-result");
        if (resultEl) {
          renderToolOutput(resultEl as HTMLPreElement, String(msg.output).slice(0, 12000));
          resultEl.classList.toggle("tool-result-error", !!msg.isError);
        }
        pendingToolCalls.delete(msg.toolCallId);
      }
      if (workingEl) workingEl.textContent = "● Working...";
      break;
    }
    case "interrupted": {
      // User cancelled the run: keep any partial output, stop the working
      // state and append a red bubble. State resets when `done` arrives.
      flushStreamingMd();
      aborted = true;
      setStreaming(false);
      hideWorking();
      const stopEl = addMessage("assistant", "❌ ⏹ Processing interrupted.");
      stopEl.classList.add("error");
      scrollDown();
      break;
    }
    case "compactStart": {
      // Animated in-chat bubble while the LLM-backed compaction is running.
      if (!compactionEl) {
        compactionEl = document.createElement("div");
        compactionEl.className = "working";
        compactionEl.textContent = "● Compacting…";
        messagesEl.appendChild(compactionEl);
        scrollDown();
      }
      break;
    }
    case "compactDone": {
      // Finalize into a quiet "thinking-style" block (gray/dashed/collapsible):
      // blue/result styling stays reserved for actual emitted model output.
      if (compactionEl) {
        makeThinkingBlock(
          "🧹 Conversation compacted.",
          "The older messages were summarized into the session context.",
          compactionEl,
        );
        compactionEl = null;
      }
      break;
    }
    case "done":
      flushStreamingMd();
      finishStream();
      setStreaming(false);
      break;
    case "error": {
      flushStreamingMd();
      const wasWorking = !!workingEl;
      setStreaming(false);
      hideWorking();
      if (currentResultEl) {
        currentResultEl.classList.add("error");
        currentResultEl.innerHTML = "<strong>" + escapeHtml(msg.error) + "</strong>";
      } else if (wasWorking) {
        const errEl = addMessage("assistant", "❌ " + (msg.error || "error"));
        errEl.classList.add("error");
      }
      resetStreamState();
      break;
    }
    case "refresh": {
      messagesEl.innerHTML = "";
      resetStreamState();
      if (workspaceLocked({ workspaceReady: msg.workspaceReady })) {
        renderWorkspaceShell();
      } else if (!activeId) {
        renderEmptyShell();
      } else if (!renderMessages(msg.messages || [])) {
        addWelcome();
      }
      break;
    }
    case "renameSession": {
      // In-place label update (manual rename). NO rebuild, so the streaming UI
      // (working bubble, partial output) is preserved.
      const rid = msg.id as string;
      if (typeof rid !== "string") break;
      const name = (msg.name as string) || "Session";
      for (const el of document.querySelectorAll(`.srow[data-id="${rid}"] .name`)) el.textContent = name;
      const tabLabel = document.querySelector(`.tab[data-id="${rid}"] span:first-child`);
      if (tabLabel) tabLabel.textContent = name;
      const tab = document.querySelector<HTMLElement>(`.tab[data-id="${rid}"]`);
      if (tab) tab.title = name;
      // The rename bumped updatedAt: refresh the meta dates too (when provided).
      if (typeof msg.createdAt === "number" && typeof msg.updatedAt === "number") {
        for (const el of document.querySelectorAll(`.srow[data-id="${rid}"] .smeta`)) {
          el.textContent = "created " + fmtDate(msg.createdAt) + " · updated " + fmtDate(msg.updatedAt);
        }
      }
      break;
    }
    case "modal": {
      if (msg.kind === "alert") {
        openAlert(msg);
      } else if (msg.kind === "name") {
        openNameModal({ mode: msg.mode, id: msg.id, current: msg.current, modalId: msg.modalId });
      }
      break;
    }
    case "status":
      if (Array.isArray(msg.workingIds)) workingIds = new Set(msg.workingIds as string[]);
      // Patch the row locks IN PLACE (no full list rebuild): rebuilding the
      // rows re-creates the action buttons and they visibly flash on every
      // status message while a session works.
      for (const row of document.querySelectorAll<HTMLElement>(".srow")) {
        const w = workingIds.has(row.dataset.id ?? "");
        row.classList.toggle("is-working", w);
        for (const b of row.querySelectorAll("button")) b.disabled = w;
      }
      setStreaming(!!msg.active);
      break;
    case "switchView": {
      // Incremental tab switch WITHOUT reloading the page: the streaming state
      // (working bubble, buffers) survives, so returning to a session that is
      // still working relocks and keeps streaming.
      renderViewState({
        sessions: msg.sessions || [],
        openIds: msg.openIds || [],
        activeId: msg.activeId,
        messages: msg.messages || [],
        config: msg.config || {},
        workingIds: msg.workingIds || [],
      });
      restoreLiveStream(msg); // replay the in-flight thinking/answer
      setStreaming(!!msg.streaming);
      break;
    }
    case "config":
      renderModelSelect(msg.config || {});
      renderThinkingSelect(msg.config || {});
      renderModelWarnings(msg.config || {});
      ctxInput.value = String(clampContextWindow((msg.config && msg.config.contextWindow) || DEFAULT_CONTEXT_WINDOW));
      renderOutputTokens(msg.config || {});
      renderSamplerControl(msg.config || {});
      presenceControl.render(msg.config && msg.config.presencePenalty);
      freqControl.render(msg.config && msg.config.frequencyPenalty);
      renderMetrics(msg.config || {});
      break;
  }
});

// ── Full in-place view state (init + switchView: no page reload) ──
function renderViewState(state: {
  sessions: SessionInfo[];
  openIds: string[];
  activeId?: string;
  messages: ChatMsg[];
  config: ConfigState;
  workingIds?: string[];
}): void {
  openIds = state.openIds || [];
  activeId = state.activeId;
  currentSessions = state.sessions || [];
  workingIds = new Set(state.workingIds || []);
  renderSessions(currentSessions);
  renderTabs(currentSessions);
  renderModelSelect(state.config || {});
  renderThinkingSelect(state.config || {});
  renderModelWarnings(state.config || {});
  ctxInput.value = String(clampContextWindow((state.config && state.config.contextWindow) || DEFAULT_CONTEXT_WINDOW));
  renderOutputTokens(state.config || {});
  renderSamplerControl(state.config || {});
  presenceControl.render(state.config && state.config.presencePenalty);
  freqControl.render(state.config && state.config.frequencyPenalty);
  renderMetrics(state.config || {});
  messagesEl.innerHTML = "";
  resetStreamState();
  if (workspaceLocked(state.config || {})) {
    renderWorkspaceShell();
  } else if (activeId) {
    document.body.classList.remove("no-session");
    if (!renderMessages(state.messages || [])) addWelcome();
  } else {
    renderEmptyShell();
  }
  // Selecting/opening a session always pins the transcript to the bottom with
  // auto-scroll ON: the freshly shown (possibly still working) session starts
  // from its END, so the live streaming is visible without manual scrolling.
  autoScroll = true;
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

/**
 * Replay the live (uncommitted) part of a session's in-flight turn: the
 * thinking/answer text the host accumulated while this session streamed.
 * Needed on switchView (and on the first load) so returning to a session that
 * is mid-thinking shows its progress instead of a blank new working bubble.
 */
function restoreLiveStream(state: { streaming?: boolean; liveThinking?: string; liveAnswer?: string }): void {
  if (!state.streaming) return;
  if (!workingEl) addWorking();
  const thinking = String(state.liveThinking || "");
  if (thinking) {
    currentThinkingText = thinking;
    currentThinkingBlock = addThinkingBlock(thinking);
  }
  const answer = String(state.liveAnswer || "");
  if (answer) {
    currentRawText = answer;
    currentResultEl = document.createElement("div");
    currentResultEl.className = "msg assistant";
    currentResultEl.innerHTML = renderMarkdown(answer);
    messagesEl.appendChild(currentResultEl);
  }
  // Re-pin to the TRUE bottom: renderViewState anchored the scroll BEFORE this
  // function added the working bar and the replayed content below it. Without
  // this, the viewport sits above "Working…" and the stream seems to continue
  // below the fold.
  scrollDown();
}

// ── Session-name modal (in-panel name prompt) ──
nameOk.addEventListener("click", submitName);
nameCancel.addEventListener("click", () => {
  const modalId = nameModalId;
  closeNameModal();
  vscode.postMessage({ type: "modalResponse", id: modalId, value: undefined });
});
nameInput.addEventListener("input", validateNameInput);
nameInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    submitName();
  } else if (e.key === "Escape") {
    e.preventDefault();
    const modalId = nameModalId;
    closeNameModal();
    vscode.postMessage({ type: "modalResponse", id: modalId, value: undefined });
  }
});

// ── Initial render ──
renderViewState({
  sessions: init.sessions || [],
  openIds: init.openIds || [],
  activeId: init.activeId,
  messages: init.messages || [],
  config: init.config || {},
  workingIds: init.workingIds || [],
});
restoreLiveStream(init);
setStreaming(!!init.streaming);
if (activeId) vscode.postMessage({ type: "getConfig" });

export {};
