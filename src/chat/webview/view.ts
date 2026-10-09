import { renderMarkdown } from "./markdown";
import { splitDiffFence, countDiff } from "./diff-fence";
import Prism from "./prism";
import { langIdForPath } from "./lang-map";
import { clampContextWindow, clampOutputTokens, DEFAULT_CONTEXT_WINDOW, DEFAULT_OUTPUT_TOKENS } from "../context-window";
import { clampTemperature, clampTopP } from "../temperature";

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
  /** Files attached to a user message (shown as chips / large images). */
  attachments?: { name: string; size: number; isImage?: boolean; dataUri?: string }[];
  /** Inline data URIs of the attached images (persisted; re-rendered on load). */
  images?: string[];
  /** UI text when it differs from the LLM `content` (file contents inlined). */
  displayText?: string;
  /** Harness-injected prompt (loop guard / delegation): render with the robot. */
  harness?: boolean;
  /** A mid-run soft-steer user message: mark it so it is recognizable. */
  steer?: boolean;
  /** Synthetic compacted prompt/response pair: no ✂ cut / ⎇ branch key. */
  synthetic?: boolean;
}
interface SessionInfo {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  /** Absolute path of the folder (workspace) this session points to. */
  folder?: string;
  /** Whether that folder is not available (missing path -> red row). */
  folderMissing?: boolean;
}
interface ConfigState {
  provider: string;
  activeProvider?: string;
  model: string;
  hasKey: boolean;
  models?: string[];
  providerModels?: { provider: string; model: string; contextLength?: number }[];
  modelMissing?: boolean;
  hostModelErrors?: { provider: string; error: string }[];
  noModels?: boolean;
  configHome?: string;
  workspaceReady?: boolean;
  thinkingMode?: string;
  thinkingLevel?: string;
  /** Per-session chat mode (host truth): analyze (default) or agent. */
  mode?: "analyze" | "agent";
  /** Global "Parallel" switch: orchestration/sub-agents enabled. */
  parallel?: boolean;
  contextWindow?: number;
  compactionThresholdPercent?: number;
  outputTokens?: number;
  temperature?: number;
  presencePenalty?: number;
  frequencyPenalty?: number;
  topP?: number;
  sampler?: "temperature" | "topP";
  /** Effective concurrent sub-agent cap for the active session (0 = no cap). */
  maxParallelSubAgents?: number;
  /** Per-session Loop Guard sensitivity; undefined = the "normal" preset. */
  loopGuard?: "low" | "normal" | "high";
  /** Also guard the visible final answer (opt-in; undefined = off). */
  loopGuardResponse?: boolean;
  /** Preset VALUES per sensitivity level (single source: the core). */
  loopGuardPresets?: Record<string, Record<string, number | boolean>>;
  /** The SAVED per-session field values (absent keys fall back to the preset). */
  loopGuardParams?: Record<string, number>;
  /** Editable RANGES for the Loop Guard fields (single source: the core). */
  loopGuardRanges?: { key: string; min: number; max: number; step: number; integer: boolean }[];
  /** Installed Agent Skills (catalog for the Skills card). */
  skills?: { name: string; description: string }[];
  /** MCP servers + status (MCP card). */
  mcp?: {
    servers: Record<string, { command?: string; args?: string[]; env?: Record<string, string>; url?: string; headers?: Record<string, string> }>;
    statuses: { name: string; ok: boolean; enabled: boolean; error?: string; toolCount: number; tools?: { name: string; description?: string }[] }[];
  };
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
  /** Queue/steer messages typed while working (host re-pushes on reload). */
  pending?: PendingViewItem[];
  /** Extension version (shown in the empty hero). */
  version?: string;
}

const sessionsEl = document.getElementById("sessions") as HTMLDivElement;
const sessionHead = document.getElementById("session-head") as HTMLDivElement;
const sessionsGearBtn = document.getElementById("sessions-gear-btn") as HTMLButtonElement;
const newSessionBtn = document.getElementById("new-session") as HTMLButtonElement;
const tabsEl = document.getElementById("tabs") as HTMLDivElement;
const messagesEl = document.getElementById("messages") as HTMLDivElement;
// The pulsing working indicator: a REAL footer glued below the transcript (NOT
// a bubble in the flow), shown/hidden instead of being appended/removed.
const workingBar = document.getElementById("working-bar") as HTMLDivElement;
const pendingArea = document.getElementById("pending-area") as HTMLDivElement;
const steerTargetEl = document.getElementById("steer-target") as HTMLDivElement;
const inputEl = document.getElementById("user-input") as HTMLTextAreaElement;
const slashMenu = document.getElementById("slash-menu") as HTMLDivElement;
/** Installed skills (kept for the slash menu; set by renderSkills). */
let currentSkills: { name: string; description: string }[] = [];
let slashItems: { cmd: string; description: string }[] = [];
let slashIndex = 0;
const ctlToggle = document.getElementById("ctl-toggle") as HTMLDivElement;
const modeSelectEl = document.getElementById("mode-select") as HTMLDivElement;
const modeBtn = document.getElementById("mode-btn") as HTMLButtonElement;
const modeBtnLabel = document.getElementById("mode-btn-label") as HTMLSpanElement;
const modeBtnIconAnalyze = document.querySelector<SVGSVGElement>("#mode-btn-icon-analyze")!;
const modeBtnIconAgent = document.querySelector<SVGSVGElement>("#mode-btn-icon-agent")!;
const modeMenu = document.getElementById("mode-menu") as HTMLDivElement;
const modeItems = Array.from(modeMenu.querySelectorAll<HTMLButtonElement>(".mode-item"));
const parallelBtn = document.getElementById("parallel-btn") as HTMLButtonElement;
const sendBtn = document.getElementById("send-btn") as HTMLButtonElement;
const abortBtn = document.getElementById("abort-btn") as HTMLButtonElement;
const attachBtn = document.getElementById("attach-btn") as HTMLButtonElement;
const attachmentChips = document.getElementById("attachment-chips") as HTMLDivElement;
const modelSelect = document.getElementById("model-select") as HTMLSelectElement;
const thinkingRadios = Array.from(document.querySelectorAll<HTMLInputElement>('input[name="thinking-level"]'));
const ctxRange = document.getElementById("ctx-range") as HTMLInputElement;
const ctxValue = document.getElementById("ctx-value") as HTMLSpanElement;
const outRange = document.getElementById("out-range") as HTMLInputElement;
const outValue = document.getElementById("out-value") as HTMLSpanElement;
const sampRange = document.getElementById("samp-range") as HTMLInputElement;
const sampAuto = document.getElementById("samp-auto") as HTMLButtonElement;
const samplerTemp = document.getElementById("sampler-temp") as HTMLInputElement;
const samplerTopp = document.getElementById("sampler-topp") as HTMLInputElement;
const presenceRange = document.getElementById("presence-range") as HTMLInputElement;
const presenceAuto = document.getElementById("presence-auto") as HTMLButtonElement;
const freqRange = document.getElementById("freq-range") as HTMLInputElement;
const freqAuto = document.getElementById("freq-auto") as HTMLButtonElement;
const metTokens = document.getElementById("met-tokens") as HTMLSpanElement;
const metCtx = document.getElementById("met-ctx") as HTMLSpanElement;
const metPct = document.getElementById("met-pct") as HTMLSpanElement;
const metCache = document.getElementById("met-cache") as HTMLSpanElement;
const ctxBar = document.getElementById("ctx-bar") as HTMLDivElement;
const compactBtn = document.getElementById("compact-btn") as HTMLButtonElement;
const compactThresholdLabel = document.getElementById("compact-threshold-label") as HTMLSpanElement;
const compactSettingsBtn = document.getElementById("compact-settings-btn") as HTMLButtonElement;
const compactSettingsModal = document.getElementById("compact-settings-modal") as HTMLDivElement;
const compactThresholdInput = document.getElementById("compact-threshold-input") as HTMLInputElement;
const compactSettingsCancel = document.getElementById("compact-settings-cancel") as HTMLButtonElement;
const compactSettingsSave = document.getElementById("compact-settings-save") as HTMLButtonElement;

const init = JSON.parse((document.getElementById("harny-view-init") as HTMLScriptElement).textContent ?? "{}") as InitState;

let activeId: string | undefined = init.activeId;
let openIds: string[] = init.openIds || [];
let currentSessions: SessionInfo[] = init.sessions || [];
let workingIds = new Set<string>(init.workingIds || []);
/** Current auto-compaction threshold % of the context window (updated from config pushes). */
let compactionThresholdPct = 80;

// ── Streaming session state (chronological, per active chat) ──
let currentResultEl: HTMLDivElement | null = null;
let currentThinkingBlock: HTMLDivElement | null = null;
let currentThinkingText = "";
let currentRawText = "";
let workingEl: HTMLDivElement | null = null;
let compactionEl: HTMLDivElement | null = null;
let aborted = false;
/** A terminal bubble (error/interrupted) was already shown for this turn, so
 * `done` must NOT append a bogus "(empty response)" fallback. */
let terminalShown = false;
const pendingToolCalls = new Map<string, HTMLDivElement>();

// ── Pending attachments: files picked via the "+" button and queued for the
// next send. Transient (never persisted); cleared on send or session switch. ──
interface AttachedFile { name: string; path: string; size: number; isImage: boolean; dataUri?: string; content?: string; }
let attachedFiles: AttachedFile[] = [];

// ── Pending messages (queue/steer) typed while the session works. Rendered as
// a real footer; the host is the source of truth (it re-pushes on reload). ──
interface PendingViewItem {
  id: string;
  mode: "queue" | "steer";
  text: string;
  attachments?: { name: string; size: number; isImage?: boolean; dataUri?: string }[];
  targetToolCallId?: string;
}
let pendingItems: PendingViewItem[] = [];
/** Client id counter for the pending messages this panel sends. */
let pendingSeq = 0;
/** Parallel: a running sub-agent picked as the steer target (abort + re-plan). */
let steerTarget: { toolCallId: string; label: string } | null = null;
/** History length at the last full render; the LIVE user bubble's index for the
 * ✂ cut key is this value (the new message is appended at that position). */
let historyLength = 0;

/** Max size of a clipboard image pasted into the chat (matches the host cap). */
const MAX_PASTE_IMAGE_BYTES = 15 * 1024 * 1024;

// ── Throttled markdown rendering for LONG streaming text ──
// Re-rendering markdown on every delta janks the panel with long outputs
// (Qwen3.8-style thinking, verbose answers). Render at most once per window
// (leading edge) with a trailing flush, so a section always catches up.
/**
 * Coalesce streaming renders to the ANIMATION FRAME (≤ ~60/s) instead of a
 * fixed 120 ms window, so text appears smoothly. The FIRST chunk of a segment
 * (leading edge) still paints synchronously so a bubble never waits a frame;
 * the rest coalesce into one paint per frame ("render a chunk", not per char).
 */
function makeThrottledMd(minIntervalMs = 16) {
  let raf: number | undefined;
  let last = 0;
  let el: Element | null = null;
  let getText: (() => string) | null = null;
  const paint = (e: Element, g: () => string): void => {
    last = performance.now();
    e.innerHTML = renderMarkdown(g());
    // The render grows the section BELOW the current scroll anchor: re-pin to
    // the bottom (auto-scroll guarded) or streaming appears below the fold.
    scrollDown();
  };
  const tick = (): void => {
    raf = undefined;
    const e = el;
    const g = getText;
    el = null;
    getText = null;
    if (!e || !g) return;
    // Too soon after the last paint: keep coalescing into the next frame.
    if (performance.now() - last < minIntervalMs) {
      el = e;
      getText = g;
      raf = window.requestAnimationFrame(tick);
      return;
    }
    paint(e, g);
  };
  return {
    /** Schedule a render of getText() into el (leading edge + per-frame flush). */
    push(e: Element, g: () => string): void {
      el = e;
      getText = g;
      // Leading edge: the first chunk (or one after a quiet gap) paints NOW.
      if (raf === undefined && performance.now() - last >= minIntervalMs) {
        const ee = el;
        const gg = getText;
        el = null;
        getText = null;
        if (ee && gg) paint(ee, gg);
        return;
      }
      if (raf === undefined) raf = window.requestAnimationFrame(tick);
    },
    /** Render the final text immediately (done/error/interrupt/refresh). */
    flush(e: Element | null, g: () => string): void {
      if (raf !== undefined) {
        window.cancelAnimationFrame(raf);
        raf = undefined;
      }
      el = null;
      getText = null;
      if (e) paint(e, g);
    },
    reset(): void {
      if (raf !== undefined) {
        window.cancelAnimationFrame(raf);
        raf = undefined;
      }
      el = null;
      getText = null;
      last = 0;
    },
  };
}

const thinkingMd = makeThrottledMd();
const answerMd = makeThrottledMd();

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
      // A WORKING session's tab cannot be closed: stop it first.
      if (workingIds.has(id)) return;
      vscode.postMessage({ type: "closeTab", id });
    });
    tab.appendChild(label);
    tab.appendChild(close);
    tabsEl.appendChild(tab);
    tab.addEventListener("click", () => {
      if (id !== activeId) vscode.postMessage({ type: "switchTab", id });
    });
  }
  applyTabLocks();
}

/** Disable the × of every WORKING session's tab (switching stays allowed). */
function applyTabLocks(): void {
  for (const tab of tabsEl.querySelectorAll<HTMLElement>(".tab")) {
    const w = workingIds.has(tab.dataset.id ?? "");
    tab.classList.toggle("is-working", w);
    const close = tab.querySelector<HTMLElement>(".close");
    if (close) {
      close.classList.toggle("disabled", w);
      close.title = w ? "Session is working — stop it before closing the tab" : "Close tab";
    }
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

/** Label shown on HARNESS-injected prompts (loop guard / delegation / budget),
 * so they read as SYSTEM messages rather than something the user typed. */
const HARNESS_LABEL = "Nudge";

/** A HARNESS-injected prompt (loop guard / delegation / budget): a light-blue
 * bubble with a label and Markdown content (unlike normal user bubbles), so it
 * reads as a SYSTEM message and can't be confused with the user's own. */
function addHarnessMessage(content: string): HTMLDivElement {
  const div = document.createElement("div");
  div.className = "msg user harness";
  div.title = "Inserted by Harny (system) — not typed by you";
  div.innerHTML =
    '<div class="harness-label">' + HARNESS_LABEL + "</div>" +
    '<div class="harness-md">' + renderMarkdown(content || "") + "</div>";
  messagesEl.appendChild(div);
  scrollDown();
  return div;
}

function addMessage(
  role: string,
  content: string,
  attachments?: { name: string; size: number; isImage?: boolean; dataUri?: string }[],
  images?: string[],
): HTMLDivElement {
  const div = document.createElement("div");
  div.className = "msg " + role;
  if (role === "assistant" || role === "tool") {
    div.innerHTML = renderMarkdown(content || "");
  } else {
    div.textContent = content || "";
    if (role === "user" && attachments && attachments.length > 0) {
      div.appendChild(messageAttachmentRow(attachments, images));
    }
  }
  messagesEl.appendChild(div);
  scrollDown();
  return div;
}

/**
 * Highlighted, clickable call to action shown when Analyze prepared changes
 * that are NOT applied. Makes the mandatory "switch to Build" step obvious
 * instead of burying it in a line of text.
 */
function addSwitchToBuildBanner(): void {
  const el = document.createElement("div");
  el.className = "build-cta";
  const text = document.createElement("span");
  text.className = "build-cta-text";
  text.textContent = "Changes are ready as previews — nothing has been written to disk yet.";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "build-cta-btn";
  btn.textContent = "Switch to Build";
  btn.addEventListener("click", () => applyMode("agent", { notify: true }));
  el.append(text, btn);
  messagesEl.appendChild(el);
  scrollDown();
}

/** Large, per-type icon for a non-image attachment (document shape + the
 * extension, tinted by category). Pure SVG, no dependency. */
function attachmentIcon(name: string, size = 44): string {
  const ext = (name.split(".").pop() ?? "").toLowerCase();
  const code = ["js","jsx","ts","tsx","py","rb","go","rs","java","c","cc","cpp","h","hpp","cs","php","swift","kt","sh","bash","zsh","sql","html","css","scss","vue","svelte"];
  const sheet = ["csv","tsv","xls","xlsx","ods"];
  const archive = ["zip","tar","gz","tgz","rar","7z","bz2"];
  const data = ["json","jsonc","yaml","yml","toml","xml"];
  let color = "#9a9a9a";
  let label = ext ? ext.toUpperCase().slice(0, 3) : "FILE";
  if (ext === "pdf") color = "#e06c75";
  else if (ext === "md") { color = "#a98dff"; label = "MD"; }
  else if (code.includes(ext)) color = "#61afef";
  else if (sheet.includes(ext)) color = "#98c379";
  else if (archive.includes(ext)) color = "#e5c07b";
  else if (data.includes(ext)) color = "#e5c07b";
  else if (["png","jpg","jpeg","gif","webp","bmp","svg"].includes(ext)) color = "#56b6c2";
  return (
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true">` +
    `<path d="M6 2h8l5 5v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z" fill="none" stroke="${color}" stroke-width="1.5"/>` +
    `<path d="M14 2v5h5" fill="none" stroke="${color}" stroke-width="1.5"/>` +
    `<text x="11" y="17" text-anchor="middle" font-size="5" font-family="monospace" font-weight="700" fill="${color}">${label}</text>` +
    `</svg>`
  );
}

function messageAttachmentRow(
  attachments: { name: string; size: number; isImage?: boolean; dataUri?: string }[],
  images?: string[],
): HTMLDivElement {
  const row = document.createElement("div");
  row.className = "msg-attachments";

  const files = attachments.filter((f) => !f.isImage && typeof f.dataUri !== "string");
  if (files.length > 0) {
    const cards = document.createElement("div");
    cards.className = "msg-attach-files";
    for (const file of files) {
      const card = document.createElement("div");
      card.className = "msg-attach-file";
      card.title = file.size > 0 ? `${file.name} · ${formatBytes(file.size)}` : file.name;
      const icon = document.createElement("div");
      icon.className = "msg-attach-file-icon";
      icon.innerHTML = attachmentIcon(file.name);
      const name = document.createElement("div");
      name.className = "msg-attach-file-name";
      name.textContent = file.name;
      card.append(icon, name);
      if (file.size > 0) {
        const size = document.createElement("div");
        size.className = "msg-attach-file-size";
        size.textContent = formatBytes(file.size);
        card.appendChild(size);
      }
      cards.appendChild(card);
    }
    row.appendChild(cards);
  }

  let imgIndex = 0;
  for (const file of attachments) {
    const isImg = file.isImage === true || typeof file.dataUri === "string";
    if (!isImg) continue;
    // Live send: the attachment carries its data URI. Re-render: the message's
    // persisted `images` hold the data URIs, in order.
    const dataUri = file.dataUri ?? images?.[imgIndex];
    imgIndex++;
    if (!dataUri) continue;
    const box = document.createElement("div");
    box.className = "msg-attach-img";
    // A THIRD of the CHAT width (not the bubble); drag the handle to resize.
    const width = Math.max(120, Math.round(messagesEl.clientWidth / 3));
    box.style.width = width + "px";
    const img = document.createElement("img");
    img.src = dataUri;
    img.alt = file.name;
    img.title = "Click to enlarge";
    img.addEventListener("click", (e) => {
      e.stopPropagation();
      openImageLightbox(dataUri, file.name);
    });
    const cap = document.createElement("div");
    cap.className = "msg-attach-cap";
    cap.textContent = file.name;
    box.append(img, cap);
    row.appendChild(box);
  }
  return row;
}

// ── Full-size image lightbox: click a thumbnail to view it large. ──
let lightboxEl: HTMLDivElement | null = null;

function ensureLightbox(): HTMLDivElement {
  if (lightboxEl) return lightboxEl;
  const overlay = document.createElement("div");
  overlay.className = "img-lightbox hidden";
  const img = document.createElement("img");
  img.className = "img-lightbox-img";
  overlay.appendChild(img);
  overlay.addEventListener("click", () => closeImageLightbox());
  document.body.appendChild(overlay);
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && lightboxEl && !lightboxEl.classList.contains("hidden")) {
      e.preventDefault();
      closeImageLightbox();
    }
  });
  lightboxEl = overlay;
  return overlay;
}

function openImageLightbox(src: string, alt: string): void {
  const overlay = ensureLightbox();
  const img = overlay.querySelector("img") as HTMLImageElement;
  img.src = src;
  img.alt = alt;
  overlay.classList.remove("hidden");
}

function closeImageLightbox(): void {
  lightboxEl?.classList.add("hidden");
}

function addThinkingBlock(text: string, beforeEl?: HTMLElement | null, opts?: { pulse?: boolean }): HTMLDivElement {
  const block = makeThinkingBlock("🤔 Thinking...", text, undefined, beforeEl);
  // Live reasoning in progress: the block pulses (accent edges) until done.
  // Historical blocks re-rendered from the transcript pass pulse:false —
  // they are not animating and must stay quiet (otherwise they pulse forever).
  if (opts?.pulse !== false) {
    block.classList.add("streaming");
    phaseLockPulse(block);
  }
  return block;
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
  // Thinking areas start COLLAPSED (▶): expand on click. The streaming body
  // keeps accumulating text while hidden, so it is never lost.
  block.innerHTML =
    '<div class="thinking-header"><span class="toggle">▶</span>' + label + "</div>" +
    '<div class="thinking-body collapsed"></div>';
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

/**
 * Target of a tool call shown in the header after the tool name: the file
 * path (file tools), the glob pattern (Glob), the command (Shell), the
 * search term (WebSearch), the url (WebFetch), the paths (ReadLints) or the
 * list summary (TodoWrite).
 */
function toolTargetArg(args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const rec = args as Record<string, unknown>;
  if (typeof rec.glob_pattern === "string" && rec.glob_pattern) return rec.glob_pattern;
  if (typeof rec.path === "string" && rec.path) return rec.path;
  if (typeof rec.command === "string" && rec.command) return rec.command;
  if (typeof rec.search_term === "string" && rec.search_term) return rec.search_term;
  if (typeof rec.url === "string" && rec.url) return rec.url;
  if (Array.isArray(rec.paths)) {
    const list = rec.paths.filter((p): p is string => typeof p === "string");
    if (list.length > 0) return list.join(", ");
  }
  if (Array.isArray(rec.todos)) {
    const items = rec.todos
      .filter((t): t is Record<string, unknown> => !!t && typeof t === "object")
      .map((t) => `${String(t.id ?? "?")} - ${String(t.content ?? "")} - ${String(t.status ?? "?")}`);
    if (items.length > 0) return items.join(" · ");
  }
  return undefined;
}

function addToolCall(name: string, args: unknown, beforeEl?: HTMLElement | null): HTMLDivElement {
  const div = document.createElement("div");
  div.className = "msg tool tool-call-pending";
  const target = toolTargetArg(args);
  div.innerHTML =
    '<div class="tool-header">' +
    '<span class="tool-toggle">▶</span>' +
    '<span class="tool-name">🔧 ' + escapeHtml(name) + "</span>" +
    (target ? '<span class="tool-path" title="' + escapeHtml(target) + '">' + escapeHtml(target) + "</span>" : "") +
    "</div>" +
    '<div class="tool-details collapsed">' +
    '<div class="tool-input"><span class="tool-label">Input</span><pre class="tool-args">' + escapeHtml(formatArgs(args)) + "</pre></div>" +
    '<div class="tool-output"><span class="tool-label">Output</span><pre class="tool-result">⏳ running…</pre></div>' +
    "</div>";
  wireCollapsible(div);
  if (beforeEl && beforeEl.parentNode) beforeEl.parentNode.insertBefore(div, beforeEl);
  else messagesEl.appendChild(div);
  scrollDown();
  return div;
}

/** Wire the collapsible details header (shared by tool + sub-agent bubbles). */
function wireCollapsible(div: HTMLElement): void {
  div.querySelector(".tool-header")?.addEventListener("click", () => {
    const details = div.querySelector(".tool-details");
    const tog = div.querySelector(".tool-toggle");
    if (!details || !tog) return;
    const collapsed = details.classList.toggle("collapsed");
    tog.textContent = collapsed ? "▶" : "▼";
  });
}

/** Update a sub-agent bubble's status chip. */
function setSubAgentStatus(
  el: HTMLElement,
  status: "queued" | "running" | "done" | "failed" | "aborted",
): void {
  const chip = el.querySelector(".subagent-status");
  if (!chip) return;
  chip.className = "subagent-status " + status;
  chip.textContent =
    status === "running" ? "running…" : status === "queued" ? "queued…" : status;
  const terminal = status === "done" || status === "failed" || status === "aborted";
  // Pulse the BUBBLE (not the chip) while this sub-agent works, phase-locked to
  // the shared clock so it beats in sync with the thinking/answer bubbles; on a
  // terminal state, settle the border back to its resting violet edge.
  if (status === "running") {
    el.classList.remove("subagent-settling");
    el.classList.add("subagent-running");
    phaseLockPulse(el);
  } else if (terminal) {
    el.classList.remove("subagent-running");
    el.classList.add("subagent-settling");
    el.style.animationDelay = "";
    window.setTimeout(() => el.classList.remove("subagent-settling"), 700);
  }
  // The per-sub-agent abort button is only actionable while queued/running (a
  // queued one is aborted by skipping it when its turn comes). Hidden once the
  // sub-agent reaches a terminal state.
  const abort = el.querySelector(".subagent-abort") as HTMLButtonElement | null;
  if (abort) {
    abort.hidden = terminal;
    abort.disabled = terminal || el.dataset.aborting === "1";
  }
  // The steer (redirect) key follows the same lifecycle: only while live.
  const steer = el.querySelector(".subagent-steer") as HTMLButtonElement | null;
  if (steer) steer.hidden = terminal;
}

/**
 * A sub-agent (Delegate) call gets its OWN bubble so you can SEE when the
 * orchestrator launches one: header with id/role + live status, the goal in
 * clear text, and the declared resources/access (what it may touch) in the
 * collapsed details together with the final report.
 */
/** Recognizable "history/clock" icon shown before the synthetic
 * "Summary of past interactions" prompt that replaces a compacted span. */
const SYNTHETIC_SUMMARY_ICON =
  '<svg class="synthetic-icon" width="13" height="13" viewBox="0 0 24 24" aria-hidden="true">' +
  '<path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>' +
  '<path d="M3.5 4.5V9H8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' +
  '<path d="M12 8v4.2l2.8 1.7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>' +
  "</svg>";

/** A small robot glyph for sub-agent bubbles (SVG, currentColor). */
const SUBAGENT_ICON =
  '<svg class="subagent-icon" width="13" height="13" viewBox="0 0 24 24" aria-hidden="true">' +
  '<rect x="4" y="8" width="16" height="11" rx="3" stroke="currentColor" stroke-width="2" fill="none"/>' +
  '<circle cx="9.2" cy="13" r="1.5" fill="currentColor"/>' +
  '<circle cx="14.8" cy="13" r="1.5" fill="currentColor"/>' +
  '<path d="M12 4.2v3.8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>' +
  '<circle cx="12" cy="3" r="1.4" fill="currentColor"/>' +
  "</svg>";

/** A short, readable label for a sub-agent bubble: its id when that id is
 * descriptive, otherwise the first words of its goal — never a bare "A"/"1". */
function subAgentLabel(id: string, goal: string): string {
  const cleanId = (id || "").trim();
  // Placeholder-ish ids: "A", "1", "a1", "task1", "sub-task"…
  const placeholder = /^([a-z]?\d+|\d+[a-z]?|sub-?task|task\d*)$/i.test(cleanId);
  if (cleanId.length > 2 && /[a-z]/i.test(cleanId) && !placeholder) return cleanId;
  const g = (goal || "").trim().replace(/\s+/g, " ");
  if (!g) return cleanId || "sub-task";
  return g.length > 44 ? g.slice(0, 44).replace(/\s+\S*$/, "") + "…" : g;
}

function addSubAgentCall(args: unknown): HTMLDivElement {
  const a = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
  const id = typeof a.id === "string" ? a.id : "";
  const role = typeof a.role === "string" ? a.role : "";
  const access = typeof a.access === "string" ? a.access : "";
  const goal = typeof a.goal === "string" ? a.goal : "";
  const parallel = a.parallel === "yes" || a.parallel === true;
  const after = Array.isArray(a.after) ? a.after.filter((x): x is string => typeof x === "string" && !!x) : [];
  const resources = Array.isArray(a.resources)
    ? a.resources.filter((x): x is string => typeof x === "string" && !!x)
    : [];

  const div = document.createElement("div");
  div.className = "msg tool subagent tool-call-pending";
  // The bubble header must SAY WHAT the sub-agent does: use a descriptive id
  // when the model gave one, otherwise a short snippet of the goal, and always
  // keep the full goal one hover away.
  const label = subAgentLabel(id, goal);
  const shortGoal = goal.length > 60 ? goal.slice(0, 60).replace(/\s+\S*$/, "") + "…" : goal;
  // The bubble is COLLAPSED by default (like thinking blocks): only the header
  // with the live status is visible; expanding reveals goal, resources, the
  // nested live stream and the final report.
  div.innerHTML =
    '<div class="tool-header subagent-header">' +
    '<span class="tool-toggle">▶</span>' +
    '<span class="tool-name">' +
    SUBAGENT_ICON +
    " Sub-agent" +
    (label ? ' "' + escapeHtml(label) + '"' : "") +
    "</span>" +
    (goal ? '<span class="subagent-name" title="' + escapeHtml(goal) + '">' + escapeHtml(shortGoal) + "</span>" : "") +
    (role ? '<span class="subagent-role">' + escapeHtml(role) + "</span>" : "") +
    '<span class="subagent-status queued">queued…</span>' +
    '<button class="subagent-steer" type="button" title="Steer: abort this sub-agent and re-plan a correction" aria-label="Steer this sub-agent">' +
    '<svg width="10" height="10" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h11M11 6l6 6-6 6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>' +
    "</button>" +
    '<button class="subagent-abort" type="button" title="Abort this sub-agent" aria-label="Abort this sub-agent">' +
    '<svg width="10" height="10" viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/></svg>' +
    "</button>" +
    "</div>" +
    '<div class="subagent-body collapsed">' +
    (goal ? '<div class="subagent-goal">' + escapeHtml(goal) + "</div>" : "") +
    '<div class="subagent-meta">' +
    (access ? '<span class="subagent-chip access-' + escapeHtml(access) + '">' + escapeHtml(access) + "</span>" : "") +
    (parallel ? '<span class="subagent-chip parallel" title="may run in parallel with other read-only sub-agents">⫽ parallel</span>' : "") +
    (after.length > 0 ? '<span class="subagent-chip" title="waits for">after: ' + escapeHtml(after.join(", ")) + "</span>" : "") +
    resources.map((r) => '<span class="subagent-chip res" title="' + escapeHtml(r) + '">' + escapeHtml(r) + "</span>").join("") +
    "</div>" +
    '<div class="tool-input"><span class="tool-label">Task</span><pre class="tool-args">' + escapeHtml(formatArgs(args)) + "</pre></div>" +
    '<div class="tool-output"><span class="tool-label">Report</span><div class="tool-result subagent-report">⏳ working…</div></div>' +
    "</div>";
  // Header toggles the WHOLE body (goal + nested stream + report).
  div.querySelector(".subagent-header")?.addEventListener("click", () => {
    const body = div.querySelector(".subagent-body");
    const tog = div.querySelector(".tool-toggle");
    if (!body || !tog) return;
    const collapsed = body.classList.toggle("collapsed");
    tog.textContent = collapsed ? "▶" : "▼";
  });
  // Per-sub-agent abort: stop ONLY this sub-agent. The host forwards it to the
  // runner; the orchestrator still receives this Delegate's tool result
  // ("aborted") and keeps going with the remaining work.
  const abortBtn = div.querySelector(".subagent-abort") as HTMLButtonElement | null;
  abortBtn?.addEventListener("click", (e) => {
    e.stopPropagation(); // never toggle the body
    const tcId = div.dataset.toolCallId;
    if (!tcId || abortBtn.disabled) return;
    div.dataset.aborting = "1";
    abortBtn.disabled = true;
    abortBtn.classList.add("pending");
    vscode.postMessage({ type: "abortSubAgent", toolCallId: tcId });
  });
  // Steer this sub-agent: pick it as the target of the NEXT steer message, so
  // the orchestrator tears it down and re-plans the correction (Parallel).
  const steerBtn = div.querySelector(".subagent-steer") as HTMLButtonElement | null;
  steerBtn?.addEventListener("click", (e) => {
    e.stopPropagation(); // never toggle the body
    const tcId = div.dataset.toolCallId;
    if (!tcId) return;
    const name = div.querySelector(".subagent-name")?.textContent?.trim() || tcId;
    setSteerTarget(tcId, name);
  });
  messagesEl.appendChild(div);
  scrollDown();
  return div;
}

/** Live nested activity of a running sub-agent (forwarded by the host). */
interface SubAgentStreamEvent {
  type: "text_delta" | "thinking_delta" | "tool_call" | "tool_result" | "done" | "error";
  content?: string;
  toolCall?: { id?: string; name: string; arguments: unknown };
  toolResult?: { toolCallId: string; output: string; isError: boolean };
  error?: string;
}

/** Bounded live text kept per sub-agent bubble (the full report arrives at the end). */
/** Bounded live view height (CSS max-height); the FULL text is kept and
 * scrollable — nothing is trimmed from the top. */
const subAgentToolEls = new Map<string, HTMLElement>();

/** Ensure the nested live-log container exists inside a sub-agent bubble. */
function subAgentLog(el: HTMLElement): HTMLElement {
  let log = el.querySelector(".sa-log") as HTMLElement | null;
  if (!log) {
    log = document.createElement("div");
    log.className = "sa-log";
    // Always INSIDE the collapsible body (never leak outside when collapsed).
    const body = el.querySelector(".subagent-body");
    const goal = el.querySelector(".subagent-goal");
    if (goal) goal.insertAdjacentElement("afterend", log);
    else if (body) body.insertBefore(log, body.firstChild);
    else el.appendChild(log);
  }
  return log;
}

/** Stream one sub-agent event into its bubble (thinking, answer text, tools). */
function handleSubAgentEvent(parentId: string, event: SubAgentStreamEvent): void {
  const el = pendingToolCalls.get(parentId);
  if (!el) return;
  const log = subAgentLog(el);
  if (event.type === "thinking_delta" && typeof event.content === "string") {
    let t = log.querySelector(".sa-thinking") as (HTMLElement & { _raw?: string }) | null;
    if (!t) {
      t = document.createElement("div");
      t.className = "sa-thinking";
      log.appendChild(t);
    }
    // Markdown, like the thinking blocks: keep the FULL text (raw on the
    // element) and let the container scroll — never trim from the top.
    t._raw = (t._raw ?? "") + event.content;
    t.innerHTML = renderMarkdown(t._raw);
    scrollDown();
  } else if (event.type === "text_delta" && typeof event.content === "string") {
    let a = log.querySelector(".sa-answer") as (HTMLElement & { _raw?: string }) | null;
    if (!a) {
      a = document.createElement("div");
      a.className = "sa-answer";
      log.appendChild(a);
    }
    a._raw = (a._raw ?? "") + event.content;
    a.innerHTML = renderMarkdown(a._raw);
    scrollDown();
  } else if (event.type === "tool_call" && event.toolCall) {
    const line = document.createElement("div");
    line.className = "sa-tool pending";
    const id = event.toolCall.id ?? event.toolCall.name;
    line.dataset.id = id;
    const target = toolTargetArg(event.toolCall.arguments);
    line.textContent = "🔧 " + event.toolCall.name + (target ? " " + target : "");
    log.appendChild(line);
    subAgentToolEls.set(parentId + ":" + id, line);
    scrollDown();
  } else if (event.type === "tool_result" && event.toolResult) {
    const line = subAgentToolEls.get(parentId + ":" + event.toolResult.toolCallId);
    if (line) {
      line.classList.remove("pending");
      line.classList.add(event.toolResult.isError ? "err" : "ok");
    }
  } else if (event.type === "done") {
    // Only a queued/running sub-agent can become done — never override a
    // terminal status (done/failed/aborted).
    const chip = el.querySelector(".subagent-status");
    if (chip && (chip.classList.contains("queued") || chip.classList.contains("running"))) {
      setSubAgentStatus(el, "done");
    }
  } else if (event.type === "error") {
    // A fatal sub-agent error (e.g. loop/API): mark failed unless it already
    // reported done.
    if (!el.querySelector(".subagent-status.done")) setSubAgentStatus(el, "failed");
  }
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
  // bubble, appended in chronological order — nothing ever moves. The
  // "streaming" class pulses its border (same cadence as the play button).
  currentResultEl = document.createElement("div");
  currentResultEl.className = "msg assistant streaming";
  phaseLockPulse(currentResultEl);
  messagesEl.appendChild(currentResultEl);
  return currentResultEl;
}

/** Settle an area's pulse when it stops streaming: the animation ends with a
 * smooth ~0.7s fade to the resting state instead of dropping abruptly. */
function settlePulse(el: HTMLElement | null): void {
  if (!el) return;
  el.classList.remove("streaming");
  el.classList.add("settling");
  el.style.animationDelay = "";
  window.setTimeout(() => el.classList.remove("settling"), 700);
}

/** Close the live streaming bubble: stop its border pulse before it becomes
 * a permanent transcript entry (final flush / new segment / reset). */
function clearStreamingBubble(): void {
  settlePulse(currentResultEl);
  currentResultEl = null;
}

/** Stop the live thinking block's pulse when it stops being the active one. */
function clearThinkingBlock(): void {
  settlePulse(currentThinkingBlock);
  currentThinkingBlock = null;
}

function addWelcome(): HTMLDivElement {
  const div = document.createElement("div");
  div.className = "msg welcome";
  div.innerHTML = "<b>👋 Harny</b><br><small>Write a message and press Enter</small>";
  messagesEl.appendChild(div);
  return div;
}

/**
 * No single workspace folder: sessions are bucketed centrally per workspace,
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
    (init.version ? '<div class="empty-version">v' + escapeHtml(init.version) + "</div>" : "") +
    "<p>Harny needs a single open folder.</p>" +
    '<p class="empty-hint">Open one folder (File → Open Folder) to start sessions and chat.<br>' +
    "Multi-root workspaces are not supported yet.</p>";
  messagesEl.appendChild(hero);
}

/** Confirm a workspace folder is present before touching the transcript. */
function workspaceLocked(config: { workspaceReady?: boolean }): boolean {
  return config.workspaceReady === false;
}

/** Harny mark (same artwork as media/icon.svg), inlined so it inherits the
 * hero's color and needs no asset URI plumbing or CSP exception. */
const HARNY_LOGO_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" ' +
  'stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
  'stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>' +
  "</svg>";

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
    '<div class="empty-icon empty-logo">' + HARNY_LOGO_SVG + "</div>" +
    "<h2>Harny</h2>" +
    (init.version ? '<div class="empty-version">v' + escapeHtml(init.version) + "</div>" : "") +
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
  historyLength = msgs.length;
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
      // Historical thinking blocks are NOT live: no streaming pulse.
      if (m.thinking) addThinkingBlock(m.thinking, undefined, { pulse: false });
      // Chronology MUST match the live stream: the turn's answer bubble comes
      // BEFORE its tool/sub-agent bubbles (the model emits text, then calls;
      // the live path appends the result bubble on the first text delta and
      // the tool bubbles afterwards). Rendering tools first made a preamble
      // like "I'll split this into 4 sub-tasks" jump BELOW the sub-agent
      // bubbles after the completion `refresh` re-rendered the transcript.
      const content = m.content || "";
      if (content.trim() && !content.startsWith("🔧 ")) {
        const el = addMessage("assistant", content);
        if (content.startsWith("❌")) el.classList.add("error");
        else if (content.startsWith("🔁")) el.classList.add("loop");
        // Loop notices are system annotations, not branchable messages.
        if (!content.startsWith("🔁")) attachBranchAt(el, i);
        // Prepared-but-not-applied changes: re-render the highlighted CTA.
        if (content.includes("Nothing has been applied")) addSwitchToBuildBanner();
      }
      if (m.toolCalls && m.toolCalls.length > 0) {
        for (const tc of m.toolCalls) {
          const id = tc.id ?? tc.name;
          const el = tc.name === "Delegate" ? addSubAgentCall(tc.arguments) : addToolCall(tc.name, tc.arguments);
          el.classList.remove("tool-call-pending");
          el.dataset.toolCallId = id;
          const out = el.querySelector(".tool-result");
          if (out) {
            const text = outputs.get(id);
            if (tc.name === "Delegate") out.innerHTML = renderMarkdown((text ?? "").slice(0, 12000));
            else renderToolOutput(out as HTMLPreElement, text !== undefined ? text.slice(0, 12000) : "");
          }
          if (tc.name === "Delegate") {
            const report = outputs.get(id) ?? "";
            setSubAgentStatus(
              el,
              // Legacy transcripts may say "interrupted": sub-agents have ONE
              // terminal stop state, so both map to "aborted".
              /aborted/i.test(report) || /interrupted/i.test(report)
                ? "aborted"
                : report.includes(" failed:")
                  ? "failed"
                  : "done",
            );
          }
        }
      }
    } else if (m.role === "user" && m.harness) {
      // Harness-injected prompt: robot icon + markdown, no ✂ cut key.
      addHarnessMessage(m.displayText ?? (m.content || ""));
    } else {
      const el = addMessage(m.role, m.displayText ?? (m.content || ""), m.attachments, m.images);
      // A mid-run soft-steer user message: a thin accent bar marks it.
      if (m.role === "user" && m.steer) el.classList.add("steer-msg");
      // The synthetic compacted prompt gets a recognizable "history" icon.
      if (m.role === "user" && m.synthetic) {
        el.classList.add("synthetic-summary");
        el.insertAdjacentHTML("afterbegin", SYNTHETIC_SUMMARY_ICON);
      }
      // The ✂ cut-from-here lives on the USER prompt bubbles: cutting removes
      // the prompt and everything after it, so you can retype a cleaner one.
      if (m.role === "user") attachTruncateAt(el, i);
    }
  }
  return hasVisible;
}

function icon(id: keyof typeof ICON_GLYPHS, size = 14): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true">${ICON_GLYPHS[id]}</svg>`;
}

const ICON_GLYPHS: Record<string, string> = {"i-play":"<path d=\"M8 5v14l11-7z\" fill=\"currentColor\"/>","i-stop":"<rect x=\"6\" y=\"6\" width=\"12\" height=\"12\" rx=\"2\" fill=\"currentColor\"/>","i-plus":"<path d=\"M12 5v14M5 12h14\" stroke=\"currentColor\" stroke-width=\"2.5\" stroke-linecap=\"round\" fill=\"none\"/>","i-minus":"<path d=\"M5 12h14\" stroke=\"currentColor\" stroke-width=\"2.5\" stroke-linecap=\"round\" fill=\"none\"/>","i-x":"<path d=\"M18 6 6 18M6 6l12 12\" stroke=\"currentColor\" stroke-width=\"2.5\" stroke-linecap=\"round\" fill=\"none\"/>","i-pencil":"<path d=\"M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linejoin=\"round\" fill=\"none\"/>","i-trash":"<path d=\"M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" fill=\"none\"/>","i-branch":"<path d=\"M6 3v12\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" fill=\"none\"/><circle cx=\"18\" cy=\"6\" r=\"3\" fill=\"currentColor\"/><circle cx=\"6\" cy=\"18\" r=\"3\" fill=\"currentColor\"/><path d=\"M18 9a9 9 0 0 1-9 9\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" fill=\"none\"/>","i-scissors":"<circle cx=\"6\" cy=\"6\" r=\"3\" stroke=\"currentColor\" stroke-width=\"2\" fill=\"none\"/><circle cx=\"6\" cy=\"18\" r=\"3\" stroke=\"currentColor\" stroke-width=\"2\" fill=\"none\"/><path d=\"M20 4 8.12 15.88M14.47 14.48 20 20M8.12 8.12 12 12\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" fill=\"none\"/>"};

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

/**
 * Small ✂ key on a USER prompt bubble: cuts THIS session from that prompt
 * DOWNWARD — the prompt and everything after it are removed, in place, after a
 * confirmation. The destructive companion to branch, used to "sanitize" a
 * conversation that took a bad turn and continue from a clean point. Revealed
 * on hover; disabled while working.
 */
function attachTruncateAt(el: HTMLElement, index: number): void {
  const b = document.createElement("button");
  b.className = "truncate-at";
  b.title = "Cut the conversation from here down (removes this message and everything after it)";
  b.innerHTML = icon("i-scissors", 12);
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    vscode.postMessage({ type: "truncateAt", index });
  });
  el.appendChild(b);
}

function finishStream(): void {
  hideWorking();
  // When interrupted or an error bubble was already shown, never append a
  // stray "(empty response)" fallback for that case.
  if (!currentResultEl && !aborted && !terminalShown) {
    const el = document.createElement("div");
    el.className = "msg assistant";
    el.innerHTML = "<em>(empty response)</em>";
    messagesEl.appendChild(el);
  }
  resetStreamState();
}

function resetStreamState(): void {
  terminalShown = false;
  thinkingMd.reset();
  answerMd.reset();
  clearStreamingBubble();
  clearThinkingBlock();
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

/** Path of the file the tool touched, read from the tool-call args JSON. */
function extractPath(pre: HTMLElement): string | undefined {
  const argsEl = pre.closest(".msg.tool")?.querySelector(".tool-args");
  if (!argsEl?.textContent) return undefined;
  try {
    const args = JSON.parse(argsEl.textContent) as Record<string, unknown>;
    return typeof args.path === "string" && args.path ? args.path : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Renders the diff as the THIRD section of the tool bubble (Input / Output /
 * Diff) for file-touching tools. Diff graphics: + lines green, − lines red,
 * @@ hunks accent, context gray. Code lines get editor-style syntax tokens
 * when the file has a known language; unknown languages fall back to plain
 * diff coloring. The section lives inside the collapsed `.tool-details` like
 * Input and Output, so it expands with the tool bubble.
 */
function populateToolDiff(pre: HTMLElement, body: string, stat: string | undefined): void {
  const details = pre.closest(".tool-details");
  if (!details) return;
  // Defensive: a re-render into the same bubble must not stack diff sections.
  details.querySelector(".tool-diff")?.remove();
  const langId = extractPath(pre) ? langIdForPath(extractPath(pre)!) : undefined;
  const grammar = langId ? Prism.languages[langId] : undefined;

  const wrap = document.createElement("div");
  wrap.className = "tool-diff";
  const head = document.createElement("div");
  head.className = "tool-diff-head";
  const label = document.createElement("span");
  label.className = "tool-label";
  label.textContent = "Diff";
  head.appendChild(label);
  const counts = document.createElement("span");
  counts.className = "fd-stat";
  counts.textContent = stat ?? countDiff(body);
  head.appendChild(counts);

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
    if (grammar && !raw.startsWith("@@")) {
      // Keep the diff prefix out of the tokenizer (Prism would mangle +/-),
      // escape it, and let Prism.highlight produce escaped token HTML.
      const prefix = raw.charAt(0);
      const code = raw.slice(1);
      if (code.trim()) {
        line.innerHTML = escapeHtml(prefix) + Prism.highlight(code, grammar, langId!);
      } else {
        line.textContent = raw;
      }
    } else {
      line.textContent = raw;
    }
    list.appendChild(line);
  }
  wrap.appendChild(head);
  wrap.appendChild(list);

  const output = pre.closest(".tool-output");
  if (output && output.nextSibling) output.after(wrap);
  else details.appendChild(wrap);
}

/**
 * Fills a tool-result <pre> — PLAIN TEXT, exactly like before: the tool bubble
 * keeps its Input/Output structure and no line-prefix heuristics are applied
 * (a `ls -la` listing is never colored as a diff). The only exception: an
 * explicit ```diff fence is the signal for a file change — it is REMOVED from
 * the output and rendered instead as the Diff section of the tool bubble
 * (green + / red −).
 */
function renderToolOutput(el: HTMLElement, text: string): void {
  el.textContent = "";
  const found = splitDiffFence(text);
  if (found) {
    // Defensive: a degenerate fence with no body must NOT create an empty
    // Diff section — show the raw text instead.
    if (!found.body.trim()) {
      el.textContent = text;
      return;
    }
    el.textContent = found.rest;
    populateToolDiff(el, found.body, found.stat);
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

// ── Attachments: chips below the textarea, sent with the next message ──
function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

function renderAttachmentChips(): void {
  attachmentChips.innerHTML = "";
  attachmentChips.classList.toggle("hidden", attachedFiles.length === 0);
  attachedFiles.forEach((file, index) => {
    const chip = document.createElement("span");
    chip.className = "attach-chip";
    chip.title = file.path || file.name;

    // Pasted/picked images carry their data URI: show a clickable thumbnail.
    if (file.dataUri) {
      const thumb = document.createElement("img");
      thumb.className = "attach-thumb";
      thumb.src = file.dataUri;
      thumb.alt = file.name;
      thumb.title = "Click to enlarge";
      thumb.addEventListener("click", (e) => {
        e.stopPropagation();
        openImageLightbox(file.dataUri as string, file.name);
      });
      chip.appendChild(thumb);
    }

    const name = document.createElement("span");
    name.className = "attach-name";
    name.textContent = file.name;
    // Non-image files get the SAME per-type icon as the message cards, small.
    if (!file.dataUri) {
      const icon = document.createElement("span");
      icon.className = "attach-icon";
      icon.innerHTML = attachmentIcon(file.name, 16);
      chip.appendChild(icon);
    }

    const size = document.createElement("span");
    size.className = "attach-size";
    size.textContent = formatBytes(file.size);

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "attach-remove";
    remove.textContent = "\u00d7";
    remove.title = "Remove attachment";
    remove.addEventListener("click", () => {
      attachedFiles.splice(index, 1);
      renderAttachmentChips();
      focusPrompt();
    });

    chip.append(name, size, remove);
    attachmentChips.appendChild(chip);
  });
}

function clearAttachments(): void {
  if (attachedFiles.length === 0) return;
  attachedFiles = [];
  renderAttachmentChips();
}

/** Render the queue/steer messages typed while working (host-driven). */
function renderPending(items: PendingViewItem[]): void {
  pendingItems = items || [];
  pendingArea.innerHTML = "";
  pendingArea.classList.toggle("hidden", pendingItems.length === 0);
  for (const it of pendingItems) {
    const el = document.createElement("div");
    el.className = "pending-msg " + (it.mode === "steer" ? "pending-steer" : "pending-queue");
    const badge = document.createElement("span");
    badge.className = "pending-badge";
    badge.textContent = it.mode === "steer" ? "Steer" : "Queued";
    const body = document.createElement("span");
    body.className = "pending-text";
    body.textContent =
      it.text || (it.attachments?.length ? "📎 " + it.attachments.map((a) => a.name).join(", ") : "(empty)");
    body.title = body.textContent;
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "pending-cancel";
    cancel.textContent = "×";
    cancel.title = it.mode === "steer" ? "Cancel this steer" : "Cancel this queued message";
    cancel.addEventListener("click", () => vscode.postMessage({ type: "cancelPending", id: it.id }));
    el.append(badge, body, cancel);
    pendingArea.appendChild(el);
  }
}

/** The Parallel steer target chip above the prompt (empty = none picked). */
function renderSteerTarget(): void {
  steerTargetEl.innerHTML = "";
  steerTargetEl.classList.toggle("hidden", !steerTarget);
  if (!steerTarget) return;
  const label = document.createElement("span");
  label.textContent = "↪ Steering sub-agent: " + steerTarget.label;
  const clear = document.createElement("button");
  clear.type = "button";
  clear.className = "pending-cancel";
  clear.textContent = "×";
  clear.title = "Clear the steer target";
  clear.addEventListener("click", () => {
    steerTarget = null;
    renderSteerTarget();
    focusPrompt();
  });
  steerTargetEl.append(label, clear);
}

/** Pick a running sub-agent to redirect: the next steer aborts it. */
function setSteerTarget(toolCallId: string, label: string): void {
  steerTarget = { toolCallId, label };
  renderSteerTarget();
  inputEl.focus();
}

function send(mode: "queue" | "steer" = "queue"): void {
  if (!activeId) return;
  const text = inputEl.value.trim();
  const attachments = attachedFiles.slice();
  if (!text && attachments.length === 0) return;
  // A picked sub-agent forces a steer: only a steer can abort + re-plan.
  const effectiveMode: "queue" | "steer" = steerTarget ? "steer" : mode;
  inputEl.value = "";
  inputEl.style.height = "auto"; // back to a single line for the next message
  clearAttachments();
  if (streamingActive) {
    // The session works: the message is pending. The HOST owns the bubble (it
    // re-pushes the list on reload), so do NOT append a user bubble here.
    vscode.postMessage({
      type: "send",
      mode: effectiveMode,
      id: "c" + ++pendingSeq,
      text,
      ...(attachments.length > 0 ? { attachments } : {}),
      ...(steerTarget ? { targetToolCallId: steerTarget.toolCallId } : {}),
    });
    steerTarget = null;
    renderSteerTarget();
    return;
  }
  clearStreamingBubble();
  clearThinkingBlock();
  currentThinkingText = "";
  currentRawText = "";
  aborted = false;
  terminalShown = false;
  pendingToolCalls.clear();
  // Show the user's message immediately (don't wait for the turn to finish).
  // Attachments render as chips; the bubble text is just the typed prompt.
  const userEl = addMessage("user", text, attachments);
  // The ✂ cut key also on the LIVE bubble (disabled while working, like the
  // others); its index is the position the host is about to append it at.
  attachTruncateAt(userEl, historyLength);
  historyLength += 1;
  workingEl = addWorking();
  scrollDown();
  vscode.postMessage({ type: "send", text, ...(attachments.length > 0 ? { attachments } : {}) });
  setStreaming(true);
}

// ── Custom hover tooltip removed: native title attributes are used instead ──

sendBtn.addEventListener("click", () => send("queue"));
attachBtn.addEventListener("click", () => vscode.postMessage({ type: "pickFiles" }));

/** Read a dragged/pasted File as a base64 data URL. */
function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function extFromMime(mime: string): string {
  const map: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/bmp": "bmp",
  };
  return map[mime] ?? "png";
}

function readAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

/** Text-like mime types / extensions we can inline as a text attachment. */
function isTextLikeFile(mime: string, name: string): boolean {
  if (mime.startsWith("text/")) return true;
  if (/^application\/(json|xml|javascript|x-yaml|yaml)\b/.test(mime)) return true;
  return /\.(txt|md|markdown|json|jsonc|ya?ml|xml|html?|css|scss|less|js|jsx|ts|tsx|py|rb|go|rs|java|c|cc|cpp|h|hpp|cs|sh|bash|zsh|sql|csv|log|ini|toml|env)$/i.test(
    name,
  );
}

/** True for a single-line absolute path or file:// URI (a pasted path). */
function looksLikePath(text: string): boolean {
  if (!text || text.includes("\n")) return false;
  return /^(file:\/\/|\/|[A-Za-z]:[\\/]|\\\\)/.test(text.trim());
}

/** A unique "Image from clipboard" label (numbering extra ones). */
function uniqueClipboardImageName(): string {
  const base = "Image from clipboard";
  const used = new Set(attachedFiles.map((f) => f.name));
  if (!used.has(base)) return base;
  let n = 2;
  while (used.has(`${base} ${n}`)) n++;
  return `${base} ${n}`;
}

/** Attach one pasted/dropped File: images inline as a data URI, text files
 * inline as text; binary files (e.g. PDF) are attached with a clear note. */
async function attachPastedFile(file: File, source: "clipboard" | "drop" = "clipboard"): Promise<void> {
  if (file.size > MAX_PASTE_IMAGE_BYTES) {
    addMessage("assistant", `⚠️ File is too large (${formatBytes(file.size)}); max 15 MB.`).classList.add("loop");
    return;
  }
  if (file.type.startsWith("image/")) {
    // Clipboard images have no meaningful file name: call them
    // "Image from clipboard". Dropped images keep their real name.
    const name =
      source === "clipboard" ? uniqueClipboardImageName() : file.name || `image.${extFromMime(file.type)}`;
    try {
      attachedFiles.push({ name, path: "", size: file.size, isImage: true, dataUri: await readAsDataUrl(file) });
    } catch {
      /* unreadable image */
    }
    return;
  }
  let content: string | undefined;
  if (isTextLikeFile(file.type, file.name)) {
    try {
      content = await readAsText(file);
    } catch {
      /* ignore */
    }
  }
  attachedFiles.push({ name: file.name || "file", path: "", size: file.size, isImage: false, content });
}

/** Drag & drop: VS Code explorer drags arrive as text/uri-list; OS drags as
 * File objects (which may expose a non-standard `path`). Both are handled. */
async function handleDrop(e: DragEvent): Promise<void> {
  const dt = e.dataTransfer;
  // Diagnostic (logged to Output > Harny) so a non-working drop is diagnosable.
  vscode.postMessage({
    type: "dragDebug",
    detail: {
      types: dt && dt.types ? Array.from(dt.types) : [],
      files: dt ? dt.files.length : 0,
      uris: dt?.getData("text/uri-list")?.slice(0, 300) ?? "",
      text: dt?.getData("text/plain")?.slice(0, 300) ?? "",
    },
  });

  // 1) Paths from a VS Code drag (text/uri-list), e.g. the Explorer.
  const uriList = (dt?.getData("text/uri-list") || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));
  let attached = false;
  for (const uri of uriList) {
    vscode.postMessage({ type: "attachPath", path: uri });
    attached = true;
  }

  // 2) File objects (OS drag): prefer an Electron `path`, else the content.
  const files = dt ? Array.from(dt.files) : [];
  const fromItems =
    files.length === 0 && dt && dt.items
      ? Array.from(dt.items)
          .filter((i) => i.kind === "file")
          .map((i) => i.getAsFile())
          .filter((f): f is File => !!f)
      : files;
  for (const f of fromItems) {
    const p = (f as unknown as { path?: string }).path;
    if (p && looksLikePath(p)) vscode.postMessage({ type: "attachPath", path: p });
    else await attachPastedFile(f, "drop");
    attached = true;
  }

  // 3) A plain-text path.
  const plain = (dt?.getData("text/plain") || "").split(/\r?\n/).map((l) => l.trim())[0] ?? "";
  if (!attached && plain && looksLikePath(plain)) {
    vscode.postMessage({ type: "attachPath", path: plain });
    attached = true;
  }

  if (fromItems.length > 0) renderAttachmentChips();
  if (!attached) {
    addMessage("assistant", "⚠️ Drop received, but VS Code provided no file path or content.").classList.add("loop");
  }
}

/** Install window-capture drag & drop handlers (works over the whole panel). */
function installDragAndDrop(): void {
  let depth = 0;
  window.addEventListener(
    "dragover",
    (e) => {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    },
    true,
  );
  window.addEventListener(
    "dragenter",
    (e) => {
      e.preventDefault();
      depth++;
      document.body.classList.add("drag-over");
    },
    true,
  );
  window.addEventListener(
    "dragleave",
    () => {
      depth = Math.max(0, depth - 1);
      if (depth === 0) document.body.classList.remove("drag-over");
    },
    true,
  );
  window.addEventListener(
    "drop",
    (e) => {
      e.preventDefault();
      depth = 0;
      document.body.classList.remove("drag-over");
      void handleDrop(e);
    },
    true,
  );
}

/**
 * Paste into the chat:
 *  · images -> attached inline as a data URI;
 *  · text files -> attached inline as text;
 *  · a pasted absolute path / file:// URI -> the host attaches that file;
 *  · plain text -> default behaviour.
 * A file copied in Finder/Explorer often reaches the webview only as its NAME
 * (text), not as a file — then nothing can be attached; use the "+" button.
 */
async function handlePaste(e: ClipboardEvent): Promise<void> {
  const data = e.clipboardData;
  const items = data ? Array.from(data.items) : [];
  const fileItems = items.filter((i) => i.kind === "file");
  if (fileItems.length > 0) {
    e.preventDefault();
    for (const item of fileItems) {
      const file = item.getAsFile();
      if (file) await attachPastedFile(file, "clipboard");
    }
    renderAttachmentChips();
    return;
  }
  const rawText = data && typeof data.getData === "function" ? data.getData("text/plain") : "";
  const text = (rawText ?? "").trim();
  if (looksLikePath(text)) {
    e.preventDefault();
    vscode.postMessage({ type: "attachPath", path: text });
  }
  // Otherwise: normal text paste.
}

inputEl.addEventListener("paste", (e) => {
  void handlePaste(e);
});

installDragAndDrop();
inputEl.addEventListener("input", resizeInput);
inputEl.addEventListener("input", updateSlashMenu);
// Recompute the height when the input's width changes (panel/window resize),
// because line wrapping depends on width. Guarded ResizeObserver avoids loops.
if (typeof ResizeObserver !== "undefined") {
  new ResizeObserver(resizeInput).observe(inputEl);
}
window.addEventListener("resize", resizeInput);
inputEl.addEventListener("keydown", (e) => {
  // The slash menu captures navigation/selection keys while it is open.
  if (!slashMenu.classList.contains("hidden")) {
    if (e.key === "ArrowDown") { e.preventDefault(); slashMove(1); return; }
    if (e.key === "ArrowUp") { e.preventDefault(); slashMove(-1); return; }
    if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); selectSlashItem(); return; }
    if (e.key === "Escape") { e.preventDefault(); hideSlashMenu(); return; }
  }
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    // While working: Enter queues, Ctrl/Cmd+Enter steers (the aggressive move).
    send(e.ctrlKey || e.metaKey ? "steer" : "queue");
  }
  if (e.key === "Escape") vscode.postMessage({ type: "abort" });
});
// GLOBAL Esc = Stop. The textarea is no longer disabled while working, but Esc
// in a modal/overlay must still take precedence. Modals/overlays take
// precedence: if one is open, Esc closes it (its own handler) and must NOT
// abort the run.
window.addEventListener("keydown", (e) => {
  // Ignore stale handlers (a re-imported module in tests leaves its listener on
  // the shared window) and any detached button: only the live view acts.
  // The slash menu owns Esc while it is open (it closes the menu).
  if (e.key !== "Escape" || !abortBtn.isConnected || abortBtn.disabled || !slashMenu.classList.contains("hidden")) return;
  // Do NOT hijack an Escape that is closing a native control (an open <select>,
  // a focused input/button): that is the user dismissing something, not Stop.
  const target = e.target as HTMLElement | null;
  if (target?.closest?.("input, textarea, select, button, [contenteditable='true']")) return;
  const overlay =
    !nameModal.classList.contains("hidden") ||
    !alertModal.classList.contains("hidden") ||
    !providersModal.classList.contains("hidden") ||
    !sessionsModal.classList.contains("hidden") ||
    !compactSettingsModal.classList.contains("hidden") ||
    !modeMenu.classList.contains("hidden") ||
    (lightboxEl !== null && !lightboxEl.classList.contains("hidden"));
  if (overlay) return;
  e.preventDefault();
  vscode.postMessage({ type: "abort" });
});
abortBtn.addEventListener("click", () => vscode.postMessage({ type: "abort" }));
// Collapse/expand the control stack (model, window, sampling, metrics).
ctlToggle.addEventListener("click", () => {
  const collapsed = document.body.classList.toggle("controls-collapsed");
  ctlToggle.setAttribute("aria-expanded", String(!collapsed));
  const prev = vscode.getState() as object | undefined;
  vscode.setState({ ...(prev ?? {}), controlsCollapsed: collapsed });
  // Re-read the installed skills when the stack is shown (fresh after an install).
  if (!collapsed) vscode.postMessage({ type: "getSkills" });
});
// The skills list can change at any time (npx skills add/remove): re-read it
// whenever the panel regains focus, so a removal/install shows up without a
// manual reload.
window.addEventListener("focus", () => vscode.postMessage({ type: "getSkills" }));
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

// ── All-sessions manager (gear next to New session) ──
const sessionsModal = document.getElementById("sessions-modal") as HTMLDivElement;
const sessionsManagerList = document.getElementById("sessions-manager-list") as HTMLDivElement;
const sessionsCloseBtn = document.getElementById("sessions-close") as HTMLButtonElement;

/** Renders the manage-form rows (keeps the modal's current shown/hidden state). */
function renderSessionsManagerData(data: { sessions: SessionInfo[]; currentFolder?: string }): void {
  renderSessionsManager(data.sessions || [], data.currentFolder);
}

function closeSessionsManager(): void {
  sessionsModal.classList.add("hidden");
  sessionsManagerList.innerHTML = "";
}

/**
 * True when two absolute folder paths refer to the same location. VS Code
 * `fsPath` values use `\` on Windows and `/` on POSIX, so separators and a
 * trailing separator are normalized away. Windows drive paths are also
 * compared case-insensitively (that filesystem is); POSIX paths stay
 * case-sensitive, so two genuinely distinct Linux folders never collapse.
 */
function sameFolder(a?: string, b?: string): boolean {
  if (!a || !b) return false;
  const norm = (p: string) => p.replace(/[\\/]+/g, "/").replace(/\/+$/, "");
  const na = norm(a);
  const nb = norm(b);
  if (na === nb) return true;
  const windowsPath = /^[a-zA-Z]:\//;
  return windowsPath.test(na) && windowsPath.test(nb) && na.toLowerCase() === nb.toLowerCase();
}

/**
 * Rows for the manage form: every session of every folder, most recent first
 * (the host sorts). Red rows = folder unavailable; per-row actions: open the
 * session's folder in VS Code (changes the working directory) or change the
 * folder pointer / delete. A missing or unset folder offers the picker instead
 * of Open, so the session can be re-pointed.
 */
function renderSessionsManager(sessions: SessionInfo[], currentFolder?: string): void {
  sessionsManagerList.innerHTML = "";
  if (!sessions || sessions.length === 0) {
    const p = document.createElement("div");
    p.className = "sm-empty";
    p.textContent = "No sessions yet.";
    sessionsManagerList.appendChild(p);
    return;
  }
  for (const s of sessions) {
    const row = document.createElement("div");
    row.className = "sm-row";
    row.dataset.id = s.id;

    const main = document.createElement("div");
    main.className = "sm-main";
    const nameLine = document.createElement("div");
    nameLine.className = "sm-name";
    const nameSpan = document.createElement("span");
    nameSpan.textContent = s.name || "Session";
    nameLine.appendChild(nameSpan);
    if (sameFolder(s.folder, currentFolder)) {
      const tag = document.createElement("span");
      tag.className = "sm-tag";
      tag.textContent = "this folder";
      nameLine.appendChild(tag);
    }
    const meta = document.createElement("div");
    meta.className = "sm-meta";
    meta.textContent =
      "created " + fmtDate(s.createdAt) + " · updated " + fmtDate(s.updatedAt) + " · " + s.messageCount + " msg";
    const folder = document.createElement("div");
    const folderKnown = !!s.folder;
    folder.className =
      "sm-folder" + (folderKnown && s.folderMissing ? " missing" : folderKnown ? "" : " unset");
    folder.textContent = folderKnown
      ? s.folder + (s.folderMissing ? " — missing" : "")
      : "(folder not set)";
    folder.title = s.folderMissing && s.folder ? s.folder + " is no longer available" : s.folder || "";
    main.appendChild(nameLine);
    main.appendChild(meta);
    main.appendChild(folder);

    const actions = document.createElement("span");
    actions.className = "sm-actions";
    const folderBtn = document.createElement("button");
    folderBtn.className = "secondary-ghost folder-btn";
    // A usable folder (exists, and not the one already open) is OPENED in VS
    // Code — this changes the working directory. Otherwise the picker is the
    // only useful action: re-point a missing/unset session's folder.
    const canOpen = !!s.folder && !s.folderMissing && !sameFolder(s.folder, currentFolder);
    if (canOpen) {
      folderBtn.textContent = "Open folder";
      folderBtn.title = "Open this folder in VS Code (changes the working directory)";
      folderBtn.addEventListener("click", () =>
        vscode.postMessage({ type: "sessionsManagerOpenFolder", id: s.id }),
      );
    } else {
      folderBtn.textContent = "Change folder…";
      folderBtn.title = "Pick the workspace folder this session points to";
      folderBtn.addEventListener("click", () =>
        vscode.postMessage({ type: "sessionsManagerChangeFolder", id: s.id }),
      );
    }
    const del = document.createElement("button");
    del.className = "secondary-ghost del-btn";
    del.title = "Delete this session";
    del.innerHTML = icon("i-trash", 13);
    del.addEventListener("click", () => vscode.postMessage({ type: "deleteSession", id: s.id }));
    actions.appendChild(folderBtn);
    actions.appendChild(del);

    row.appendChild(main);
    row.appendChild(actions);
    sessionsManagerList.appendChild(row);
  }
}

sessionsGearBtn.addEventListener("click", () => {
  vscode.postMessage({ type: "getAllSessions" });
});
sessionsCloseBtn.addEventListener("click", closeSessionsManager);
sessionsModal.querySelector(".sm-backdrop")?.addEventListener("click", closeSessionsManager);
window.addEventListener("keydown", (e) => {
  if (!sessionsModal.classList.contains("hidden") && e.key === "Escape") {
    e.preventDefault();
    closeSessionsManager();
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

// ── Providers & Models editor (gear button) ──
const providersModal = document.getElementById("providers-modal") as HTMLDivElement;
const providerSelect = document.getElementById("provider-select") as HTMLSelectElement;
const peName = document.getElementById("pe-name") as HTMLInputElement;
const peBaseUrl = document.getElementById("pe-baseurl") as HTMLInputElement;
const peApiKey = document.getElementById("pe-apikey") as HTMLInputElement;
const peThinking = document.getElementById("pe-thinking") as HTMLSelectElement;
const peSessionHeader = document.getElementById("pe-session-header") as HTMLInputElement;
const providerTestBtn = document.getElementById("provider-test") as HTMLButtonElement;
const providerDeleteBtn = document.getElementById("provider-delete") as HTMLButtonElement;
const providerAddBtn = document.getElementById("provider-add") as HTMLButtonElement;
const providerTestResult = document.getElementById("provider-test-result") as HTMLDivElement;
const providersSaveBtn = document.getElementById("providers-save") as HTMLButtonElement;
const providersCancelBtn = document.getElementById("providers-cancel") as HTMLButtonElement;
const providersExportBtn = document.getElementById("providers-export") as HTMLButtonElement;
const providersImportBtn = document.getElementById("providers-import") as HTMLButtonElement;
const providersIoResult = document.getElementById("providers-io-result") as HTMLSpanElement;
const gearBtn = document.getElementById("gear-btn") as HTMLButtonElement;

let providerEditorData: { providers: Record<string, { baseUrl?: string; apiKey?: string; thinking?: string; thinkingLevel?: string; sessionHeader?: string; headers?: Record<string, string>; maxTokens?: number; extra?: Record<string, unknown> }> } = {
  providers: {},
};
let providerEditorSelected = "";
let providerDeleteArmed = false;
let providerDeleteTimer: number | undefined;

/** Normalize a user-typed base URL: protocol + trailing /v1 defaults. */
function normalizeBaseUrl(raw: string): string {
  let u = raw.trim();
  if (!u) return u;
  if (!/^https?:\/\//i.test(u)) u = "http://" + u;
  if (!/\/v1\/?$/i.test(u)) u = u.replace(/\/?$/, "/v1");
  return u;
}

function refreshProviderList(): void {
  providerSelect.innerHTML = "";
  const names = Object.keys(providerEditorData.providers).sort((a, b) => a.localeCompare(b));
  if (names.length === 0) {
    const ph = document.createElement("option");
    ph.value = "";
    ph.textContent = "— No providers yet —";
    ph.disabled = true;
    providerSelect.appendChild(ph);
  }
  for (const name of names) {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    if (name === providerEditorSelected) opt.selected = true;
    providerSelect.appendChild(opt);
  }
}

function loadProviderIntoForm(name: string): void {
  const entry = providerEditorData.providers[name];
  providerEditorSelected = name;
  peName.value = name;
  peBaseUrl.value = entry?.baseUrl ?? "";
  peApiKey.value = entry?.apiKey ?? "";
  peThinking.value = entry?.thinking ?? "unspecified";
  peSessionHeader.value = entry?.sessionHeader ?? "";
  providerTestResult.classList.add("hidden");
  providerTestBtn.disabled = false;
  providerDeleteBtn.disabled = false;
  providersSaveBtn.disabled = false;
  refreshProviderList();
}

function openProvidersEditor(data: {
  providers: Record<string, { baseUrl?: string; apiKey?: string; thinking?: string; thinkingLevel?: string; extra?: Record<string, unknown> }>;
}): void {
  providerEditorData = { providers: JSON.parse(JSON.stringify(data.providers ?? {})) };
  const names = Object.keys(providerEditorData.providers);
  providerEditorSelected = names.length > 0 ? names[0] : "";
  refreshProviderList();
  if (providerEditorSelected) {
    loadProviderIntoForm(providerEditorSelected);
  } else {
    peName.value = "";
    peBaseUrl.value = "";
    peApiKey.value = "";
    peThinking.value = "effort";
    peSessionHeader.value = "";
    providerTestBtn.disabled = true;
    providerDeleteBtn.disabled = true;
    providersSaveBtn.disabled = true;
    // Fresh install hint: the form is unusable until + New creates one.
    peName.placeholder = "Add one with + New";
  }
  providerDeleteArmed = false;
  providerDeleteBtn.textContent = "Delete";
  providersModal.classList.remove("hidden");
}

function closeProvidersEditor(): void {
  providerEditorData = { providers: {} };
  providerEditorSelected = "";
  providersModal.classList.add("hidden");
}

gearBtn.addEventListener("click", () => {
  providersIoResult.textContent = "";
  providersIoResult.className = "providers-io";
  vscode.postMessage({ type: "getProvidersEditor" });
});

// Export / import the providers config as a portable JSON file.
function showProvidersIo(text: string, ok: boolean): void {
  providersIoResult.textContent = text;
  providersIoResult.className = "providers-io " + (ok ? "ok" : "err");
}
providersExportBtn.addEventListener("click", () => vscode.postMessage({ type: "exportProviders" }));
providersImportBtn.addEventListener("click", () => vscode.postMessage({ type: "importProviders" }));

providerSelect.addEventListener("change", () => {
  const name = providerSelect.value;
  if (name && providerEditorData.providers[name]) loadProviderIntoForm(name);
});

providerAddBtn.addEventListener("click", () => {
  const base = "new-provider";
  let name = base;
  let i = 1;
  while (providerEditorData.providers[name]) name = `${base}-${++i}`;
  providerEditorData.providers[name] = {};
  loadProviderIntoForm(name);
  peName.focus();
  peName.select();
});

providerTestBtn.addEventListener("click", () => {
  const name = peName.value.trim();
  if (!name) return;
  const baseUrl = normalizeBaseUrl(peBaseUrl.value);
  if (!baseUrl) {
    providerTestResult.textContent = "Enter a base URL first (e.g. http://localhost:8090/v1)";
    providerTestResult.className = "err";
    return;
  }
  providerTestResult.textContent = "Testing…";
  providerTestResult.className = "";
  providerTestResult.classList.remove("hidden");
  vscode.postMessage({ type: "testProvider", data: { baseUrl, apiKey: peApiKey.value.trim() || undefined } });
});

providerDeleteBtn.addEventListener("click", () => {
  if (!providerDeleteArmed) {
    providerDeleteArmed = true;
    providerDeleteBtn.textContent = "Really delete?";
    providerDeleteBtn.classList.add("danger");
    window.clearTimeout(providerDeleteTimer);
    providerDeleteTimer = window.setTimeout(() => {
      providerDeleteArmed = false;
      providerDeleteBtn.textContent = "Delete";
    }, 3000);
    return;
  }
  providerDeleteArmed = false;
  providerDeleteBtn.textContent = "Delete";
  const name = providerEditorSelected;
  if (!name || !providerEditorData.providers[name]) return;
  delete providerEditorData.providers[name];
  const names = Object.keys(providerEditorData.providers);
  if (names.length === 0) {
    providerEditorSelected = "";
    refreshProviderList();
    peName.value = "";
    peBaseUrl.value = "";
    peApiKey.value = "";
    peThinking.value = "effort";
    peSessionHeader.value = "";
    providerTestBtn.disabled = true;
    providerDeleteBtn.disabled = true;
  } else {
    loadProviderIntoForm(names[0]);
  }
});

providersSaveBtn.addEventListener("click", () => {
  // Commit the currently edited provider (auto-rename if the name changed).
  const oldName = providerEditorSelected;
  const newName = peName.value.trim();
  if (!oldName) return;
  const entry = providerEditorData.providers[oldName];
  if (!entry) return;
  const given = newName || oldName;
  if (given !== oldName) {
    delete providerEditorData.providers[oldName];
  }
  providerEditorData.providers[given] = {
    // Keys the form does not manage are CARRIED OVER untouched so a save is
    // LOSSLESS: `extra` (models, unknown fields), headers, maxTokens and the
    // provider's default thinkingLevel.
    ...(entry.extra ? { extra: entry.extra } : {}),
    ...(entry.headers ? { headers: entry.headers } : {}),
    ...(typeof entry.maxTokens === "number" ? { maxTokens: entry.maxTokens } : {}),
    ...(entry.thinkingLevel ? { thinkingLevel: entry.thinkingLevel } : {}),
    baseUrl: normalizeBaseUrl(peBaseUrl.value) || undefined,
    apiKey: peApiKey.value.trim() || undefined,
    thinking: peThinking.value === "unspecified" ? undefined : peThinking.value,
    ...(peSessionHeader.value.trim() ? { sessionHeader: peSessionHeader.value.trim() } : {}),
  };
  vscode.postMessage({ type: "saveProviders", data: { ...providerEditorData } });
  providersSaveBtn.disabled = true;
});

// ── Guardrails card: per-session parallel cap + Loop Guard sensitivity ──
// Both are persisted ON THE SESSION (not the config file): they tune how THIS
// conversation runs. Undefined loopGuard = the "normal" preset.
const parRange = document.getElementById("par-range") as HTMLInputElement;
const parValue = document.getElementById("par-value") as HTMLSpanElement;
const lgRadios = Array.from(document.querySelectorAll<HTMLInputElement>('input[name="lg-level"]'));
const lgResponse = document.getElementById("lg-response") as HTMLInputElement;
const lgCollapse = document.getElementById("lg-collapse") as HTMLButtonElement;
const lgParamsField = document.getElementById("lg-params-field") as HTMLDivElement;
const ctlCardsEl = document.getElementById("ctl-cards") as HTMLDivElement;
const lgToggleEl = document.getElementById("lg-toggle") as HTMLDivElement;
const lgFieldsEl = document.getElementById("lg-fields") as HTMLDivElement;
const skillsCard = document.getElementById("skills-card") as HTMLDivElement;
const skillsList = document.getElementById("skills-list") as HTMLDivElement;
const mcpCard = document.getElementById("mcp-card") as HTMLDivElement;
const mcpList = document.getElementById("mcp-list") as HTMLDivElement;
const mcpToolsPopover = document.getElementById("mcp-tools-popover") as HTMLDivElement;
const mcpConfigure = document.getElementById("mcp-configure") as HTMLButtonElement;
const mcpModal = document.getElementById("mcp-modal") as HTMLDivElement;
const mcpSelect = document.getElementById("mcp-select") as HTMLSelectElement;
const mcpName = document.getElementById("mcp-name") as HTMLInputElement;
const mcpCommand = document.getElementById("mcp-command") as HTMLInputElement;
const mcpArgs = document.getElementById("mcp-args") as HTMLTextAreaElement;
const mcpEnv = document.getElementById("mcp-env") as HTMLTextAreaElement;
const mcpEnabled = document.getElementById("mcp-enabled") as HTMLInputElement;
const mcpTest = document.getElementById("mcp-test") as HTMLButtonElement;
const mcpTestResult = document.getElementById("mcp-test-result") as HTMLSpanElement;
const mcpAdd = document.getElementById("mcp-add") as HTMLButtonElement;
const mcpDelete = document.getElementById("mcp-delete") as HTMLButtonElement;
const mcpSave = document.getElementById("mcp-save") as HTMLButtonElement;
const mcpCancel = document.getElementById("mcp-cancel") as HTMLButtonElement;
const tipEl = document.getElementById("tip") as HTMLDivElement;

type McpEditorServer = { command?: string; args?: string[]; env?: Record<string, string>; url?: string; headers?: Record<string, string>; enabled?: boolean };
let mcpEditorServers: Record<string, McpEditorServer> = {};
let mcpEditorSelected = "";
let mcpStatuses: { name: string; ok: boolean; enabled: boolean; error?: string; toolCount: number; tools?: { name: string; description?: string }[] }[] = [];

const DEFAULT_PARALLEL = 4;

type LoopGuardLevel = "low" | "normal" | "high";

/** 0 = no cap; 1–100 = the cap. */
function clampParallel(v: number): number {
  if (!Number.isFinite(v)) return DEFAULT_PARALLEL;
  return Math.min(100, Math.max(0, Math.trunc(v)));
}

/** "Off" for 0 (no cap), the number otherwise. */
function parLabel(v: number): string {
  return v <= 0 ? "Off" : String(v);
}

function sendParallel(): void {
  const v = clampParallel(Number(parRange.value));
  parRange.value = String(v);
  parValue.textContent = parLabel(v);
  // 0 = explicitly NO cap; 1–100 = the cap.
  vscode.postMessage({ type: "setMaxParallelSubAgents", value: v });
}

function sendLoopGuard(): void {
  const level = (lgRadios.find((r) => r.checked)?.value ?? "normal") as LoopGuardLevel;
  vscode.postMessage({ type: "setLoopGuard", value: level });
}

function sendLoopGuardResponse(): void {
  vscode.postMessage({ type: "setLoopGuardResponse", value: lgResponse.checked });
}

// The Loop Guard FIELDS (below the sensitivity row): the preset values exposed
// as editable numbers. The host sends the ranges + preset values, so this panel
// never duplicates them. Editing a field tunes the LIVE guard only: the values
// are deliberately NOT saved (neither on the session nor in the config file),
// so experimenting with the thresholds is throw-away. Picking a sensitivity
// level resets the fields to that preset (the new baseline).
type LgRange = { key: string; min: number; max: number; step: number; integer: boolean };
const LG_LABELS: Record<string, string> = {
  maxNudges: "Nudges",
  reasoningThreshold: "Reasoning θ",
  reasoningMinTokens: "Reasoning tok",
  crossTurnSimilarity: "Turn sim",
  crossTurnMinLength: "Turn len",
  toolFailureRepeats: "Tool fail",
  errorStreakTurns: "Err streak",
  toolRepeatConsecutive: "Repeat run",
  toolRepeatWindow: "Rep window",
  toolRepeatWindowThreshold: "Rep win thr",
  answerThreshold: "Answer θ",
  answerMinTokens: "Answer tok",
};
let lgRanges: LgRange[] = [];
let lgPresets: Record<string, Record<string, number | boolean>> = {};
/** The SAVED per-session field values (overlaid on the preset). */
let lgParams: Record<string, number> = {};
let lgFieldsBuilt = false;
let lgLastLevel: string | null = null;
let lgLastSession: string | undefined;

/** Show the shared hover tooltip anchored to `el` (below it; flipped above
 * when there is no room at the bottom). */
function showTip(el: HTMLElement, text: string): void {
  if (!text) return;
  tipEl.textContent = text;
  tipEl.classList.remove("hidden");
  const r = el.getBoundingClientRect();
  const t = tipEl.getBoundingClientRect();
  let top = r.bottom + 6;
  if (top + t.height > window.innerHeight - 4) top = Math.max(4, r.top - t.height - 6);
  const left = Math.min(Math.max(4, r.left), Math.max(4, window.innerWidth - t.width - 4));
  tipEl.style.top = `${top}px`;
  tipEl.style.left = `${left}px`;
}
function hideTip(): void {
  tipEl.classList.add("hidden");
}
/** Attach the shared tooltip to an element (replaces the native title). */
function attachTip(el: HTMLElement, text: string): void {
  el.addEventListener("mouseenter", () => showTip(el, text));
  el.addEventListener("mouseleave", hideTip);
  el.addEventListener("focus", () => showTip(el, text));
  el.addEventListener("blur", hideTip);
}
// A stale tooltip must not float over unrelated content.
window.addEventListener("scroll", hideTip, true);

/** One-line explanation for each Loop Guard parameter (the labels stay short). */
const LG_TIPS: Record<string, string> = {
  maxNudges: "How many corrective nudges a loop type gets before the guard stops the run. Higher = more patient.",
  reasoningThreshold: "Within a turn: how repetitive the reasoning must be to be cut (trigram duplication). Lower = flags sooner.",
  reasoningMinTokens: "Minimum reasoning tokens before the within-turn repetition check runs.",
  crossTurnSimilarity: "Across turns: how similar two turns' reasoning must be to inject a corrective nudge. Lower = flags sooner.",
  crossTurnMinLength: "Minimum reasoning characters before the across-turn similarity check runs.",
  toolFailureRepeats: "How many identical FAILING tool calls are re-run before the recorded failure is returned instead.",
  errorStreakTurns: "Consecutive turns with tool errors before the host injects a 'change strategy' summary.",
  toolRepeatConsecutive: "Consecutive identical successful calls that count as a loop (the call is then served from cache).",
  toolRepeatWindow: "Sliding window (in calls) used to count repeated call signatures.",
  toolRepeatWindowThreshold: "Repeats of the SAME call inside the window that count as a loop.",
  answerThreshold: "How repetitive the final answer must be to be flagged (needs 'Include response'). Lower = flags sooner.",
  answerMinTokens: "Minimum answer tokens before the final-answer repetition check runs.",
};

/** Build the editable fields once, from the host-provided ranges: each is a
 * slider (the ONLY control) with the value shown as a read-only label. */
function buildLgFields(): void {
  const wrap = document.getElementById("lg-fields") as HTMLDivElement | null;
  if (!wrap || lgRanges.length === 0) return;
  wrap.innerHTML = "";
  for (const r of lgRanges) {
    const label = LG_LABELS[r.key] ?? r.key;
    const cell = document.createElement("label");
    cell.className = "lg-field";
    const name = document.createElement("span");
    name.className = "lg-name";
    name.textContent = label;
    // Short label + a hover tooltip that explains the parameter (and its range).
    const tipText = LG_TIPS[r.key] ?? label;
    attachTip(name, `${label} — ${tipText} (range ${r.min}–${r.max})`);
    const value = document.createElement("span");
    value.className = "lg-value";
    value.id = `lgv-${r.key}`;
    const range = document.createElement("input");
    range.type = "range";
    range.className = "lg-range";
    range.id = `lgr-${r.key}`;
    range.min = String(r.min);
    range.max = String(r.max);
    range.step = String(r.step);
    range.setAttribute("aria-label", label);
    // Live drag: mirror the value into its label and push (rAF-throttled).
    range.addEventListener("input", () => {
      value.textContent = range.value;
      sendLoopGuardOverridesThrottled();
    });
    range.addEventListener("change", sendLoopGuardOverrides);
    cell.append(name, value, range);
    wrap.appendChild(cell);
  }
  lgFieldsBuilt = true;
}

/** Set one field (slider position + its read-only value label). */
function setLgField(key: string, v: number): void {
  const range = lgRangeInput(key);
  if (range) range.value = String(v);
  const value = document.getElementById(`lgv-${key}`);
  if (value) value.textContent = String(v);
}

/** Repopulate every field from the preset of the given level, overlaid with
 * the SAVED per-session values. `useParams = false` ignores the saved values
 * (used when the level changes: the preset becomes the new baseline). */
function fillLgFields(level: string, useParams = true): void {
  const preset = lgPresets[level] ?? {};
  const saved = useParams ? lgParams : {};
  for (const r of lgRanges) {
    const v = typeof saved[r.key] === "number" ? saved[r.key] : preset[r.key];
    if (typeof v === "number") setLgField(r.key, v);
  }
}

function lgRangeInput(key: string): HTMLInputElement | null {
  return document.getElementById(`lgr-${key}`) as HTMLInputElement | null;
}

function currentLgLevel(): string {
  return lgRadios.find((r) => r.checked)?.value ?? "normal";
}

function clampLgValue(r: LgRange, v: number): number {
  const c = Math.min(r.max, Math.max(r.min, v));
  return r.integer ? Math.round(c) : Math.round(c * 100) / 100;
}

// A slider drag fires `input` continuously: coalesce the posts to one per frame.
let lgRafPending = false;
function sendLoopGuardOverridesThrottled(): void {
  if (lgRafPending) return;
  lgRafPending = true;
  requestAnimationFrame(() => {
    lgRafPending = false;
    sendLoopGuardOverrides();
  });
}

/** Send the FULL override map, read from the sliders (the host clamps it too). */
function sendLoopGuardOverrides(): void {
  const overrides: Record<string, number> = {};
  for (const r of lgRanges) {
    const range = lgRangeInput(r.key);
    if (!range) continue;
    const v = Number(range.value);
    if (!Number.isFinite(v)) continue;
    const c = clampLgValue(r, v);
    overrides[r.key] = c;
    setLgField(r.key, c);
  }
  vscode.postMessage({ type: "setLoopGuardOverrides", overrides });
}

/** Level change: the preset becomes the new baseline, so the fields reset
 * (the host clears + saves its overrides on the same change). */
function onLoopGuardLevelChange(): void {
  sendLoopGuard();
  fillLgFields(currentLgLevel(), false);
}

// The Loop Guard parameters section starts COLLAPSED, so the card — and its
// grid-row neighbour (Parallel) — stays at its minimum height. The chevron in
// the bottom-right corner toggles it.
function setLgParamsCollapsed(collapsed: boolean): void {
  lgParamsField.classList.toggle("hidden", collapsed);
  lgCollapse.setAttribute("aria-expanded", String(!collapsed));
  lgCollapse.title = collapsed ? "Show the Loop Guard parameters" : "Hide the Loop Guard parameters";
}
setLgParamsCollapsed(true);
lgCollapse.addEventListener("click", () => {
  setLgParamsCollapsed(!lgParamsField.classList.contains("hidden"));
});

// ── Responsive column count for the control stack ──
// The Loop Guard sensitivity row is `nowrap`, so it IS the minimum card width:
// instead of guessing a breakpoint in rem (which drifts with the font), MEASURE
// the row and pick 1 / 2 / 4 columns so the text never overflows its card.
// CSS media queries stay as the fallback for the very first paint.
function layoutControlColumns(): void {
  if (!ctlCardsEl || !lgFieldsEl || !lgToggleEl) return;
  const avail = ctlCardsEl.clientWidth;
  // MEASURE the INTRINSIC row: the radios' content width (scrollWidth keeps
  // reporting the real content width even when the toggle is clipped by
  // overflow:hidden) PLUS the chevron and the head gap. Measuring the head row
  // itself would report its USED — already shrunk — width, which collapses
  // everything to a single column.
  const row = lgToggleEl.scrollWidth + (lgCollapse ? lgCollapse.offsetWidth : 0) + 8;
  if (!avail || !row) return; // not laid out yet: keep the CSS fallback
  const GAP = 8;
  const CARD_PAD = 24; // 2x10px card padding + slack
  const need = row + CARD_PAD;
  let cols = 1;
  if (need * 4 + GAP * 3 <= avail) cols = 4;
  else if (need * 2 + GAP <= avail) cols = 2;
  ctlCardsEl.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
  // The parameter fields follow: 2 columns only when the card is half-width.
  lgFieldsEl.style.gridTemplateColumns = cols === 2 ? "repeat(2, minmax(0, 1fr))" : "minmax(0, 1fr)";
}
if (typeof ResizeObserver !== "undefined") new ResizeObserver(layoutControlColumns).observe(ctlCardsEl);
window.addEventListener("resize", layoutControlColumns);

function renderControl(config: ConfigState): void {
  const cap = config.maxParallelSubAgents;
  const capV = typeof cap === "number" && cap > 0 ? clampParallel(cap) : 0;
  parRange.value = String(capV);
  parValue.textContent = parLabel(capV);
  const level: LoopGuardLevel = config.loopGuard === "high" || config.loopGuard === "low" ? config.loopGuard : "normal";
  for (const r of lgRadios) r.checked = r.value === level;
  lgResponse.checked = config.loopGuardResponse === true;
  // Loop Guard fields: ranges + preset values come from the host (one source).
  if (config.loopGuardPresets) lgPresets = config.loopGuardPresets;
  lgParams = config.loopGuardParams ?? {};
  // Reset the fields when the LEVEL or the SESSION changes; a plain config push
  // must never clobber the user's live edits. Brand-new fields (built on a
  // later push than the first render) are populated too.
  let needFill = lgLastLevel !== level || lgLastSession !== activeId;
  if (Array.isArray(config.loopGuardRanges) && config.loopGuardRanges.length > 0) {
    if (JSON.stringify(config.loopGuardRanges) !== JSON.stringify(lgRanges)) lgRanges = config.loopGuardRanges;
    if (!lgFieldsBuilt) {
      buildLgFields();
      needFill = true;
    }
  }
  if (needFill) {
    lgLastLevel = level;
    lgLastSession = activeId;
    fillLgFields(level);
  }
  renderSkills(config.skills ?? []);
  renderMcp(config.mcp);
}

/** One chip per installed skill; clicking fills the prompt with `/skill <name> `
 * so the host can activate it deterministically (bypassing the model's choice). */
function renderSkills(skills: { name: string; description: string }[]): void {
  currentSkills = skills;
  skillsCard.classList.toggle("hidden", skills.length === 0);
  skillsList.innerHTML = "";
  for (const s of skills) {
    const item = document.createElement("span");
    item.className = "skill-item";
    item.textContent = "🧩 " + s.name;
    item.title = s.description || s.name;
    item.addEventListener("click", () => {
      inputEl.value = `/skill ${s.name} `;
      inputEl.style.height = "auto";
      inputEl.dispatchEvent(new Event("input"));
      focusPrompt();
    });
    skillsList.appendChild(item);
  }
}

function renderMcp(mcp: ConfigState["mcp"]): void {
  mcpStatuses = mcp?.statuses ?? [];
  const names = Object.keys(mcp?.servers ?? {});
  mcpCard.classList.toggle("hidden", names.length === 0);
  mcpList.innerHTML = "";
  for (const name of names) {
    const st = mcpStatuses.find((s) => s.name === name);
    const enabled = st?.enabled !== false;
    const row = document.createElement("div");
    row.className = "mcp-status " + (!enabled ? "off" : st?.ok ? "ok" : "err");

    // The name IS the toggle: click to enable/disable (colored ↔ gray).
    const nameEl = document.createElement("span");
    nameEl.className = "mcp-name";
    nameEl.textContent = `● ${name}`;
    nameEl.title = enabled ? "Click to disable this server" : "Click to enable this server";
    nameEl.addEventListener("click", () => {
      // Not while the session is working: the current run's tool list is already
      // fixed, so a mid-run disable would only take effect on the NEXT turn.
      if (streamingActive) return;
      vscode.postMessage({ type: "toggleMcpServer", name, enabled: !enabled });
    });
    row.appendChild(nameEl);
    row.appendChild(document.createTextNode(" "));

    if (!enabled) {
      const detail = document.createElement("span");
      detail.className = "mcp-detail";
      detail.textContent = "off";
      row.appendChild(detail);
    } else if (st?.ok) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "mcp-tools-btn";
      btn.textContent = `(${st.toolCount} tools)`;
      btn.title = "Show the tools this server exposes";
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        showMcpToolsPopover(btn, name, st.tools ?? []);
      });
      row.appendChild(btn);
    } else {
      const detail = document.createElement("span");
      detail.className = "mcp-detail";
      detail.textContent = st?.error ?? "not connected";
      row.appendChild(detail);
    }
    mcpList.appendChild(row);
  }
}

function hideMcpToolsPopover(): void {
  mcpToolsPopover.classList.add("hidden");
  mcpToolsPopover.dataset.server = "";
}

function showMcpToolsPopover(anchor: HTMLElement, server: string, tools: { name: string; description?: string }[]): void {
  mcpToolsPopover.innerHTML = "";
  const title = document.createElement("div");
  title.className = "mcp-pop-title";
  title.textContent = `🧩 ${server}`;
  mcpToolsPopover.appendChild(title);
  if (tools.length === 0) {
    const empty = document.createElement("div");
    empty.className = "mcp-pop-empty";
    empty.textContent = "(no tools)";
    mcpToolsPopover.appendChild(empty);
  }
  for (const t of tools) {
    const item = document.createElement("div");
    item.className = "mcp-pop-item";
    const name = document.createElement("div");
    name.className = "mcp-pop-name";
    name.textContent = t.name;
    item.appendChild(name);
    if (t.description) {
      const desc = document.createElement("div");
      desc.className = "mcp-pop-desc";
      desc.textContent = t.description;
      item.appendChild(desc);
    }
    mcpToolsPopover.appendChild(item);
  }
  mcpToolsPopover.dataset.server = server;
  mcpToolsPopover.classList.remove("hidden");
  // Anchor below-left of the key, clamped to the viewport.
  const rect = anchor.getBoundingClientRect();
  const w = mcpToolsPopover.offsetWidth;
  const h = mcpToolsPopover.offsetHeight;
  let left = rect.left;
  let top = rect.bottom + 4;
  if (left + w > window.innerWidth - 8) left = window.innerWidth - w - 8;
  if (top + h > window.innerHeight - 8) top = rect.top - h - 4;
  mcpToolsPopover.style.left = Math.max(8, left) + "px";
  mcpToolsPopover.style.top = Math.max(8, top) + "px";
}

document.addEventListener("click", (e) => {
  if (mcpToolsPopover.classList.contains("hidden")) return;
  if (e.target instanceof Node && mcpToolsPopover.contains(e.target)) return;
  hideMcpToolsPopover();
});
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") hideMcpToolsPopover();
});

// ── Slash menu: skill autocomplete (only when the prompt STARTS with "/") ──
function hideSlashMenu(): void {
  slashMenu.classList.add("hidden");
  slashItems = [];
  slashIndex = 0;
}

function renderSlashMenu(): void {
  slashMenu.innerHTML = "";
  slashItems.forEach((it, i) => {
    const el = document.createElement("div");
    el.className = "slash-item" + (i === slashIndex ? " active" : "");
    el.setAttribute("role", "option");
    const cmd = document.createElement("div");
    cmd.className = "slash-cmd";
    cmd.textContent = it.cmd;
    el.appendChild(cmd);
    if (it.description) {
      const desc = document.createElement("div");
      desc.className = "slash-desc";
      desc.textContent = it.description;
      el.appendChild(desc);
    }
    // mousedown (not click) + preventDefault keeps the textarea focused.
    el.addEventListener("mousedown", (e) => {
      e.preventDefault();
      slashIndex = i;
      selectSlashItem();
    });
    slashMenu.appendChild(el);
  });
  slashMenu.classList.remove("hidden");
  const rect = inputEl.getBoundingClientRect();
  const h = slashMenu.offsetHeight;
  slashMenu.style.left = rect.left + "px";
  slashMenu.style.width = Math.max(200, rect.width) + "px";
  slashMenu.style.top = Math.max(8, rect.top - h - 6) + "px";
}

/** Show/refresh the menu: only for the FIRST token of a "/"-led prompt. */
function updateSlashMenu(): void {
  const value = inputEl.value;
  if (!value.startsWith("/") || /\s/.test(value)) {
    hideSlashMenu();
    return;
  }
  const q = value.slice(1).toLowerCase();
  const all = [
    { cmd: "/skills", description: "List installed skills" },
    ...currentSkills.map((s) => ({ cmd: `/skill ${s.name}`, description: s.description })),
  ];
  slashItems = all.filter((it) => {
    const c = it.cmd.slice(1).toLowerCase();
    return c.startsWith(q) || c.includes(q);
  });
  if (slashItems.length === 0) {
    hideSlashMenu();
    return;
  }
  slashIndex = Math.min(slashIndex, slashItems.length - 1);
  renderSlashMenu();
}

function slashMove(delta: number): void {
  if (slashItems.length === 0) return;
  slashIndex = (slashIndex + delta + slashItems.length) % slashItems.length;
  renderSlashMenu();
}

function selectSlashItem(): void {
  const it = slashItems[slashIndex];
  if (!it) return;
  inputEl.value = it.cmd + " ";
  hideSlashMenu();
  resizeInput();
  inputEl.focus();
}

function refreshMcpSelect(): void {
  mcpSelect.innerHTML = "";
  for (const name of Object.keys(mcpEditorServers)) {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    mcpSelect.appendChild(opt);
  }
  mcpSelect.value = mcpEditorSelected;
}

function loadMcpIntoForm(name: string): void {
  mcpEditorSelected = name;
  const s = mcpEditorServers[name] ?? {};
  mcpName.value = name;
  mcpCommand.value = s.command ?? "";
  mcpArgs.value = (s.args ?? []).join("\n");
  mcpEnv.value = Object.entries(s.env ?? {}).map(([k, v]) => `${k}=${v}`).join("\n");
  mcpEnabled.checked = s.enabled !== false;
  mcpTestResult.textContent = "";
  mcpTestResult.className = "mcp-io";
}

function clearMcpForm(): void {
  mcpEditorSelected = "";
  mcpName.value = "";
  mcpCommand.value = "";
  mcpArgs.value = "";
  mcpEnv.value = "";
  mcpEnabled.checked = true;
}

/** Read the form into a stdio server config (args one per line, env KEY=VALUE). */
function mcpFormServer(): McpEditorServer {
  const env: Record<string, string> = {};
  for (const line of mcpEnv.value.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    const i = t.indexOf("=");
    if (i <= 0) continue;
    env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return {
    command: mcpCommand.value.trim(),
    args: mcpArgs.value.split("\n").map((l) => l.trim()).filter(Boolean),
    enabled: mcpEnabled.checked,
    ...(Object.keys(env).length > 0 ? { env } : {}),
  };
}

function openMcpEditor(): void {
  mcpTestResult.textContent = "";
  mcpTestResult.className = "mcp-io";
  vscode.postMessage({ type: "getMcpServers" });
}

function renderMcpEditor(data: ConfigState["mcp"], open: boolean): void {
  mcpEditorServers = data?.servers ?? {};
  mcpStatuses = data?.statuses ?? [];
  if (open) {
    const names = Object.keys(mcpEditorServers);
    mcpEditorSelected = names[0] ?? "";
    refreshMcpSelect();
    if (mcpEditorSelected) loadMcpIntoForm(mcpEditorSelected);
    else clearMcpForm();
    mcpModal.classList.remove("hidden");
  } else if (!mcpModal.classList.contains("hidden")) {
    // A background change (e.g. the card toggle): refresh the open editor list.
    refreshMcpSelect();
  }
}

function closeMcpEditor(): void {
  mcpModal.classList.add("hidden");
}

mcpConfigure.addEventListener("click", openMcpEditor);
mcpCancel.addEventListener("click", closeMcpEditor);
mcpModal.querySelector(".mcp-backdrop")?.addEventListener("click", closeMcpEditor);
mcpSelect.addEventListener("change", () => {
  if (mcpEditorServers[mcpSelect.value]) loadMcpIntoForm(mcpSelect.value);
});
mcpAdd.addEventListener("click", () => {
  let name = "server";
  let i = 1;
  while (mcpEditorServers[name]) name = `server-${++i}`;
  mcpEditorServers[name] = { command: "npx", args: [] };
  mcpEditorSelected = name;
  refreshMcpSelect();
  loadMcpIntoForm(name);
  mcpName.focus();
  mcpName.select();
});
mcpDelete.addEventListener("click", () => {
  const name = mcpEditorSelected;
  if (!name) return;
  delete mcpEditorServers[name];
  mcpEditorSelected = Object.keys(mcpEditorServers)[0] ?? "";
  refreshMcpSelect();
  if (mcpEditorSelected) loadMcpIntoForm(mcpEditorSelected);
  else clearMcpForm();
});
mcpTest.addEventListener("click", () => {
  const s = mcpFormServer();
  if (!s.command) {
    mcpTestResult.textContent = "Enter a command first";
    mcpTestResult.className = "mcp-io err";
    return;
  }
  mcpTestResult.textContent = "Testing…";
  mcpTestResult.className = "mcp-io";
  vscode.postMessage({ type: "testMcpServer", server: s });
});
mcpSave.addEventListener("click", () => {
  const old = mcpEditorSelected;
  const name = mcpName.value.trim() || old;
  if (old && name !== old) delete mcpEditorServers[old];
  if (name) mcpEditorServers[name] = mcpFormServer();
  mcpEditorSelected = name;
  vscode.postMessage({ type: "saveMcpServers", servers: mcpEditorServers });
});
window.addEventListener("keydown", (e) => {
  if (!mcpModal.classList.contains("hidden") && e.key === "Escape") {
    e.preventDefault();
    closeMcpEditor();
  }
});

const sendParallelThrottled = rafThrottle(sendParallel);
parRange.addEventListener("input", () => {
  parValue.textContent = parLabel(Number(parRange.value));
  sendParallelThrottled();
});
parRange.addEventListener("change", sendParallel);
for (const r of lgRadios) r.addEventListener("change", onLoopGuardLevelChange);
lgResponse.addEventListener("change", sendLoopGuardResponse);

providersCancelBtn.addEventListener("click", closeProvidersEditor);
providersModal.querySelector(".providers-backdrop")?.addEventListener("click", closeProvidersEditor);
window.addEventListener("keydown", (e) => {
  if (!providersModal.classList.contains("hidden") && e.key === "Escape") {
    e.preventDefault();
    closeProvidersEditor();
  }
});


// ── View lock (per active session) ──
// While the active session's LLM works (streaming OR compaction) everything
// below the transcript is disabled except Stop; the sessions list / tabs stay
// usable so you can open or switch to another session and work in parallel.
let streamingActive = false;
let thinkingCapable = false; // provider declares thinking control (bool/effort)

// Pulse clock: the play button + Working bar beat on harny-pulse from the
// moment the turn starts. The active areas (answer bubble / thinking block)
// start their border pulse LATER (when the first chunk arrives) — a plain
// CSS animation would then begin mid-cycle and stay permanently out of sync
// with the play key. phaseLockPulse() aligns each area to the SAME clock with
// a negative animation-delay, so every border beats together with the button.
const PULSE_MS = 1200; // must match harny-pulse / stream-border-pulse (1.2s)
let pulseClockStart = performance.now();

function phaseLockPulse(el: HTMLElement): void {
  const elapsed = (performance.now() - pulseClockStart) % PULSE_MS;
  el.style.animationDelay = "-" + elapsed + "ms";
}

/** Return keyboard focus to the prompt after the agent finishes working. */
function focusPrompt(): void {
  inputEl.focus();
}

function setStreaming(active: boolean): void {
  const rising = active && !streamingActive;
  streamingActive = active;
  if (rising) {
    // The play button + Working bar start harny-pulse now: this becomes the
    // shared clock the area border pulses lock onto.
    pulseClockStart = performance.now();
    // Entering working always pins the transcript at the bottom with
    // auto-scroll ON: the reply is arriving below, even if the user had
    // scrolled up to re-read older content.
    autoScroll = true;
    scrollDown();
  }
  sendBtn.classList.toggle("blinking", active);
  // The prompt STAYS usable while working: Enter queues, Ctrl/Cmd+Enter steers.
  sendBtn.disabled = !activeId;
  abortBtn.disabled = !active;
  attachBtn.disabled = !activeId;
  inputEl.placeholder = active
    ? "Enter to queue · Ctrl/Cmd+Enter to steer · Esc to stop"
    : "Ask Harny... (Enter to send, Esc to abort)";
  compactBtn.disabled = active;
  compactSettingsBtn.disabled = active;
  modelSelect.disabled = active;
  for (const r of thinkingRadios) r.disabled = active || !thinkingCapable;
  ctxRange.disabled = active;
  outRange.disabled = active;
  sampRange.disabled = active;
  sampAuto.disabled = active;
  samplerTemp.disabled = active;
  samplerTopp.disabled = active;
  presenceRange.disabled = active;
  presenceAuto.disabled = active;
  freqRange.disabled = active;
  freqAuto.disabled = active;
  // Guardrails card (parallel cap + Loop Guard) follows the same lock.
  parRange.disabled = active;
  for (const r of lgRadios) r.disabled = active;
  lgResponse.disabled = active;
  for (const el of document.querySelectorAll<HTMLInputElement>("#lg-fields input")) el.disabled = active;
  inputEl.disabled = false;
  // Mode button follows the same lock (no switching mid-stream); a dropdown
  // left open gets closed so the disabled state is obvious.
  if (active && !modeMenu.classList.contains("hidden")) closeModeMenu();
  modeBtn.disabled = active;
  parallelBtn.disabled = active;
  // Branch/cut keys on assistant bubbles follow the same lock.
  for (const b of document.querySelectorAll<HTMLButtonElement>(".branch-at, .truncate-at")) {
    b.disabled = active;
  }
}

// ── Mode button + dropdown (Analyze / Agent) ──
// Default Analyze. The host holds the per-session truth (rt.mode via the
// config push); before a session provides one, this panel remembers the last
// picked mode in its persistent webview state (still Analyze by default, so a
// first run always lands on "Analyze"). The button is painted in the mode
// accent with a WHITE icon/label; clicking it opens the vertical dropdown.
type ChatMode = "analyze" | "agent";
const DEFAULT_MODE: ChatMode = "analyze";
let currentMode: ChatMode = DEFAULT_MODE;

function isChatMode(v: unknown): v is ChatMode {
  return v === "analyze" || v === "agent";
}

/** Render the active state: button accent + label/icon, dropdown selection.
 * `notify` tells the host to store it on the session runtime. The mode is NOT
 * persisted in the panel: every load starts from Analyze. */
function applyMode(mode: ChatMode, opts?: { notify?: boolean }): void {
  if (!isChatMode(mode)) mode = DEFAULT_MODE;
  currentMode = mode;
  modeBtn.classList.toggle("is-agent", mode === "agent");
  modeBtnLabel.textContent = mode === "agent" ? "Build" : "Analyze";
  modeBtnIconAnalyze.classList.toggle("hidden", mode !== "analyze");
  modeBtnIconAgent.classList.toggle("hidden", mode !== "agent");
  for (const item of modeItems) {
    const on = item.dataset.mode === mode;
    item.classList.toggle("is-active", on);
    item.setAttribute("aria-selected", String(on));
  }
  if (opts?.notify) vscode.postMessage({ type: "setMode", mode });
}

function closeModeMenu(): void {
  modeSelectEl.classList.remove("open");
  modeMenu.classList.add("hidden");
  modeBtn.setAttribute("aria-expanded", "false");
}

function toggleModeMenu(): void {
  const opening = modeMenu.classList.contains("hidden");
  modeSelectEl.classList.toggle("open", opening);
  modeMenu.classList.toggle("hidden", !opening);
  modeBtn.setAttribute("aria-expanded", String(opening));
}

modeBtn.addEventListener("click", () => {
  if (modeBtn.disabled) return;
  toggleModeMenu();
});

for (const item of modeItems) {
  item.addEventListener("click", () => {
    closeModeMenu();
    const m = item.dataset.mode as ChatMode | undefined;
    if (!isChatMode(m)) return;
    if (m === currentMode) return;
    applyMode(m, { notify: true });
    focusPrompt();
  });
}

// A click anywhere outside the dropdown closes it (the button itself is
// inside #mode-select, so its own clicks keep it open / toggle it).
document.addEventListener("click", (e) => {
  if (!modeMenu.classList.contains("hidden") && !modeSelectEl.contains(e.target as Node)) {
    closeModeMenu();
    focusPrompt();
  }
});
// Esc closes the dropdown and returns focus to the prompt.
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !modeMenu.classList.contains("hidden")) {
    e.preventDefault();
    closeModeMenu();
    focusPrompt();
  }
});

// ── Parallel toggle (orchestration / sub-agents) ──
// Press/release switch right after the mode button: blue when pressed. The
// host keeps it as a global master switch; the panel re-asserts it on load.
let parallelOn = false;

/** Render the pressed state. `notify` tells the host (global switch). */
function applyParallel(on: boolean, opts?: { notify?: boolean }): void {
  parallelOn = on;
  parallelBtn.classList.toggle("is-on", on);
  parallelBtn.setAttribute("aria-pressed", String(on));
  if (opts?.notify) vscode.postMessage({ type: "setParallel", parallel: on });
}

parallelBtn.addEventListener("click", () => {
  if (parallelBtn.disabled) return;
  applyParallel(!parallelOn, { notify: true });
  focusPrompt();
});

// ── Model dropdown (all providers, declared or detected from the host) ──
/** Compact token count for a model's context window (e.g. 128k, 1M). */
function formatContext(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

function renderModelSelect(c: ConfigState): void {
  modelSelect.innerHTML = "";
  const providerModels = c.providerModels && c.providerModels.length > 0 ? c.providerModels : null;
  const activeProvider = c.activeProvider;
  // The saved model that is no longer served (fetch failed, removed from
  // host) falls back to the same "pick one" placeholder as a brand-new
  // session, so the combo never auto-selects an unrelated model.
  const list = providerModels
    ? new Set(providerModels.map((p) => p.model))
    : new Set(c.models || []);
  if (!c.model || (c.model && !list.has(c.model))) {
    const ph = document.createElement("option");
    ph.value = "";
    ph.textContent = "— Select a model —";
    ph.disabled = true;
    ph.selected = true;
    modelSelect.appendChild(ph);
  }

  if (providerModels) {
    const groups = new Map<string, { model: string; contextLength?: number }[]>();
    const order: string[] = [];
    for (const pm of providerModels) {
      if (!groups.has(pm.provider)) {
        groups.set(pm.provider, []);
        order.push(pm.provider);
      }
      groups.get(pm.provider)!.push({ model: pm.model, contextLength: pm.contextLength });
    }
    // One combined list of groups (normal + failed), appended together in
    // alphabetical order so a red provider stays in its proper position.
    const allGroups: HTMLOptGroupElement[] = [];
    for (const provider of [...groups.keys()].sort((a, b) => a.localeCompare(b))) {
      const g = document.createElement("optgroup");
      g.label = provider;
      // Alphabetical within each provider group.
      const sorted = [...(groups.get(provider) || [])].sort((a, b) => a.model.localeCompare(b.model));
      for (const mi of sorted) {
        const opt = document.createElement("option");
        opt.value = mi.model;
        // Show the host-reported context window next to the model (OpenRouter,
        // vLLM, llama.cpp, …).
        opt.textContent = mi.contextLength ? `${mi.model} · ${formatContext(mi.contextLength)}` : mi.model;
        opt.dataset.provider = provider;
        if (mi.model === c.model && (provider === activeProvider || !activeProvider)) opt.selected = true;
        g.appendChild(opt);
      }
      allGroups.push(g);
    }
    // Failed host fetches: the provider name still APPEARS (red, own group)
    // with the error, instead of silently disappearing from the combo.
    const errors = c.hostModelErrors ?? [];
    const pendingErrors: { label: string; g: HTMLOptGroupElement }[] = [];
    for (const err of errors) {
      // A group that also served models gets the error marker instead of a dup.
      const existingGroup = allGroups.find((gr) => gr.label === err.provider);
      if (existingGroup) {
        const opt = document.createElement("option");
        opt.value = "";
        opt.className = "option-error";
        opt.textContent =
          "⚠️ " + (err.error ? err.error : "GET /v1/models failed") + " — host unreachable";
        opt.disabled = true;
        existingGroup.appendChild(opt);
        existingGroup.className = "optgroup-failed";
        continue;
      }
      const g = document.createElement("optgroup");
      g.label = err.provider;
      g.className = "optgroup-failed";
      g.title = "GET /v1/models failed — is the host reachable?";
      const opt = document.createElement("option");
      opt.value = "";
      opt.className = "option-error";
      opt.textContent = "⚠️ " + (err.error ? err.error : "GET /v1/models failed") + " — host unreachable";
      opt.disabled = true;
      g.appendChild(opt);
      pendingErrors.push({ label: err.provider, g });
    }
    // Merge the failed-only groups into the alphabetical position.
    for (const { label, g } of pendingErrors.sort((a, b) => a.label.localeCompare(b.label))) {
      const insertAt = allGroups.findIndex((gr) => gr.label.localeCompare(label) > 0);
      if (insertAt === -1) allGroups.push(g);
      else allGroups.splice(insertAt, 0, g);
    }
    for (const g of allGroups) modelSelect.appendChild(g);
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
  focusPrompt();
});
// Leaving the dropdown (blur) also returns the caret to the prompt.
modelSelect.addEventListener("blur", () => focusPrompt());
// A native <select> fires NO `change` when the SAME option is picked again, and
// it keeps focus after the popup closes. Return the caret when the dropdown
// interaction ends: a mouseup well after the popup opened (so the opening click
// is ignored) with the select still focused.
let modelPopupOpenedAt = 0;
modelSelect.addEventListener("mousedown", () => {
  modelPopupOpenedAt = Date.now();
});
document.addEventListener("mouseup", () => {
  if (modelPopupOpenedAt && Date.now() - modelPopupOpenedAt > 250) {
    modelPopupOpenedAt = 0;
    if (document.activeElement === modelSelect) focusPrompt();
  }
});
// Esc closes the popup keeping the same value: return the caret too.
modelSelect.addEventListener("keydown", (e) => {
  if (e.key === "Escape") focusPrompt();
});
// Refresh the provider list every time the dropdown is opened, so a host that
// came up after the panel loaded (e.g. llama.cpp started later) shows up.
// The host-side cache (HOST_CACHE_TTL) keeps this from hammering the servers.
function requestModelRefresh(): void {
  if (modelSelect.disabled) return;
  vscode.postMessage({ type: "getConfig" });
}
modelSelect.addEventListener("mousedown", requestModelRefresh);
modelSelect.addEventListener("focus", requestModelRefresh);

// ── Thinking level (reasoning effort, generalized across providers) ──
function renderThinkingSelect(c: ConfigState): void {
  const mode = c.thinkingMode;
  const enabled = mode === "bool" || mode === "effort" || mode === "type" || mode === "reasoning";
  thinkingCapable = enabled;
  const title = enabled
    ? "Thinking level / reasoning effort (per session)"
    : 'This provider/model does not declare thinking control (add "thinking": "bool", "effort" or "type" to its config entry)';
  const level =
    c.thinkingLevel && ["off", "low", "medium", "high"].includes(c.thinkingLevel)
      ? c.thinkingLevel
      : "off";
  for (const r of thinkingRadios) {
    r.disabled = streamingActive || !enabled;
    r.checked = r.value === level;
    if (r.parentElement) r.parentElement.title = title;
  }
}
for (const r of thinkingRadios) {
  r.addEventListener("change", () => {
    if (!r.checked || r.disabled) return;
    const level = r.value;
    if (!["off", "low", "medium", "high"].includes(level)) return;
    vscode.postMessage({ type: "setThinkingLevel", level });
  });
}

// ── Slider helpers ──
/** Coalesce a burst of `input` events (a slider drag) into one call per frame. */
function rafThrottle(fn: () => void): () => void {
  let pending = false;
  return () => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      fn();
    });
  };
}

// Context-window slider ──
function sendContextWindow(value: number): void {
  const v = clampContextWindow(value);
  ctxRange.value = String(v);
  ctxValue.textContent = String(v);
  vscode.postMessage({ type: "setContextWindow", value: v });
}

/** Show a host-pushed window value: the LABEL keeps the exact value while the
 * slider sits on the nearest step (dragging afterwards moves by steps). */
function renderContextWindow(c: ConfigState): void {
  const v = clampContextWindow(c.contextWindow || DEFAULT_CONTEXT_WINDOW);
  ctxRange.value = String(v);
  ctxValue.textContent = String(v);
}

// ── Output-tokens slider (max tokens per response) ──
function sendOutputTokens(value: number): void {
  const v = clampOutputTokens(value);
  outRange.value = String(v);
  outValue.textContent = String(v);
  vscode.postMessage({ type: "setOutputTokens", value: v });
}

function renderOutputTokens(c: ConfigState): void {
  const v = clampOutputTokens(c.outputTokens ?? DEFAULT_OUTPUT_TOKENS);
  outRange.value = String(v);
  outValue.textContent = String(v);
}

// ── Sampling controls (Temperature, Presence/Frequency penalty) ──
// Each is a 0.0→2.0 float stepper with an "Auto" reset: digits + ONE
// decimal point, empty = Auto (not sent). One factory keeps them identical.
interface FloatControl {
  render(value: unknown): void;
}

function createFloatControl(
  refs: { range: string; value: string; auto: string },
  sendType: "setSamplerValue" | "setPresencePenalty" | "setFrequencyPenalty",
  clamp: (v: number) => number | undefined = clampTemperature,
  /** The provider's default for this knob: where the slider snaps on Auto. */
  defaultValue = 1,
): FloatControl {
  const range = document.getElementById(refs.range) as HTMLInputElement;
  const label = document.getElementById(refs.value) as HTMLSpanElement;
  const auto = document.getElementById(refs.auto) as HTMLButtonElement;

  // Auto = the value is NOT sent; the slider still snaps to the default so the
  // control visibly shows what the provider will use.
  const showAuto = (): void => {
    label.textContent = "Auto";
    range.value = String(defaultValue);
  };

  const send = (value: number | null): void => {
    if (value === null) {
      showAuto();
      vscode.postMessage({ type: sendType, value: null });
      return;
    }
    const v = clamp(value);
    if (v === undefined) {
      showAuto();
      vscode.postMessage({ type: sendType, value: null });
      return;
    }
    range.value = String(v);
    label.textContent = String(v);
    vscode.postMessage({ type: sendType, value: v });
  };
  const sendThrottled = rafThrottle(() => send(Number(range.value)));
  range.addEventListener("input", () => {
    label.textContent = range.value;
    sendThrottled();
  });
  range.addEventListener("change", () => send(Number(range.value)));
  auto.addEventListener("click", () => send(null));
  return {
    render: (value: unknown) => {
      const v = typeof value === "number" && Number.isFinite(value) ? Math.round(value * 10) / 10 : undefined;
      if (v === undefined) {
        showAuto();
        return;
      }
      range.value = String(v);
      label.textContent = String(v);
    },
  };
}

// Shared sampler stepper: the scale follows the selected radio (0.0–2.0 when
// Temperature, 0.0–1.0 when Top-P); switching mode resets the value to Auto.
const samplerClamp = (v: number): number | undefined => (samplerTopp.checked ? clampTopP(v) : clampTemperature(v));
const samplerControl = createFloatControl(
  { range: "samp-range", value: "samp-value", auto: "samp-auto" },
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

const presenceControl = createFloatControl({ range: "presence-range", value: "presence-value", auto: "presence-auto" }, "setPresencePenalty", clampTemperature, 0);
const freqControl = createFloatControl({ range: "freq-range", value: "freq-value", auto: "freq-auto" }, "setFrequencyPenalty", clampTemperature, 0);

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

/** Keep the "Auto Compact threshold: X%" label in sync with the saved %. */
function renderCompactionThreshold(): void {
  compactThresholdLabel.textContent = "Auto Compact threshold: " + compactionThresholdPct + "%";
}

// ── Auto-compaction threshold % (gear next to Compact) ──
/** Clamp/round a typed threshold % into 1–100 (invalid -> default 80). */
function clampCompactionThreshold(raw: string): number {
  const v = Number.parseInt(raw, 10);
  if (!Number.isFinite(v)) return 80;
  return Math.min(100, Math.max(1, Math.round(v)));
}

function openCompactionSettings(): void {
  compactThresholdInput.value = String(compactionThresholdPct);
  compactSettingsModal.classList.remove("hidden");
  compactThresholdInput.focus();
  compactThresholdInput.select();
}

function closeCompactionSettings(): void {
  compactSettingsModal.classList.add("hidden");
}

compactSettingsBtn.addEventListener("click", openCompactionSettings);
compactSettingsCancel.addEventListener("click", closeCompactionSettings);
compactSettingsModal.querySelector(".cs-backdrop")?.addEventListener("click", closeCompactionSettings);
compactThresholdInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    compactSettingsSave.click();
  }
});
compactSettingsSave.addEventListener("click", () => {
  const value = clampCompactionThreshold(compactThresholdInput.value);
  compactionThresholdPct = value;
  renderCompactionThreshold();
  vscode.postMessage({ type: "setCompactionThreshold", value });
  closeCompactionSettings();
});
window.addEventListener("keydown", (e) => {
  if (!compactSettingsModal.classList.contains("hidden") && e.key === "Escape") {
    e.preventDefault();
    closeCompactionSettings();
  }
});
const sendContextThrottled = rafThrottle(() => sendContextWindow(Number(ctxRange.value)));
const sendOutputThrottled = rafThrottle(() => sendOutputTokens(Number(outRange.value)));
ctxRange.addEventListener("input", () => {
  ctxValue.textContent = ctxRange.value;
  sendContextThrottled();
});
ctxRange.addEventListener("change", () => sendContextWindow(Number(ctxRange.value)));
outRange.addEventListener("input", () => {
  outValue.textContent = outRange.value;
  sendOutputThrottled();
});
outRange.addEventListener("change", () => sendOutputTokens(Number(outRange.value)));
// The 3 sampling steppers (temp / presence / freq) are wired by
// createFloatControl above (sanitize, change, ±, Auto).

// ── Host messages ──
window.addEventListener("message", (e) => {
  const msg = e.data;
  switch (msg.type) {
    case "attachments": {
      // Host response to "pickFiles": APPEND the picked files (several picks
      // accumulate), de-duplicated by path, shown as chips and sent together.
      const files = Array.isArray(msg.files) ? (msg.files as AttachedFile[]) : [];
      if (files.length > 0) {
        const seen = new Set(attachedFiles.map((f) => f.path || f.name));
        for (const file of files) {
          if (seen.has(file.path)) continue;
          attachedFiles.push(file);
          seen.add(file.path);
        }
        renderAttachmentChips();
      }
      // The picker closed (files chosen OR cancelled): caret back to the prompt.
      focusPrompt();
      break;
    }
    case "textDelta": {
      // Ignore empty chunks (some providers emit a trailing/leading empty
      // content delta).
      if (!msg.content) break;
      // Thinking phase is over (the answer is streaming now): the thinking
      // block stops pulsing and settles, instead of animating until done.
      if (currentThinkingBlock) clearThinkingBlock();
      // Accumulate ALWAYS, but only CREATE the bubble once the segment has
      // MEANINGFUL text: a whitespace-only chunk (e.g. a lone newline after a
      // thinking/tool phase) must not create an empty bubble.
      currentRawText += msg.content;
      if (!currentRawText.trim()) break;
      const resultEl = ensureResult();
      if (resultEl) {
        answerMd.push(resultEl, () => currentRawText);
        scrollDown();
      }
      break;
    }
    case "thinkingDelta": {
      // Empty thinking chunks must not create an empty thinking block.
      if (!msg.content) break;
      if (!currentThinkingBlock) {
        // A thinking phase starts a NEW segment: commit any pending renders and
        // close the previous answer bubble — the next text emission will get a
        // fresh blue bubble (chronology, nothing moves).
        flushStreamingMd();
        currentThinkingBlock = addThinkingBlock("");
        currentThinkingText = "";
        clearStreamingBubble();
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
      // Sub-agents get their own visible bubble (goal + status + resources).
      // A Delegate call is always a SUB-AGENT bubble. The host hides the tool
      // when Parallel is OFF, so gating the UI on the (async) Parallel state
      // only caused a race that rendered it as a plain tool.
      const toolEl = msg.name === "Delegate" ? addSubAgentCall(msg.arguments) : addToolCall(msg.name, msg.arguments);
      pendingToolCalls.set(msg.id, toolEl);
      toolEl.dataset.toolCallId = msg.id;
      if (workingEl) {
        workingEl.innerHTML =
          msg.name === "Delegate"
            ? "● Working... " + SUBAGENT_ICON + " sub-agent"
            : "● Working... 🔧 " + escapeHtml(msg.name);
      }
      clearThinkingBlock();
      currentThinkingText = "";
      clearStreamingBubble();
      currentRawText = "";
      break;
    }
    case "subagentStart": {
      // The delegate left the queue and is running now (concurrency cap made
      // visible: queued bubbles flip to running only when they actually start).
      const el = pendingToolCalls.get(msg.toolCallId);
      if (el) setSubAgentStatus(el, "running");
      break;
    }
    case "subagentEvent": {
      // Nested live streaming from inside the running sub-agent.
      handleSubAgentEvent(msg.toolCallId, msg.event as SubAgentStreamEvent);
      break;
    }
    case "toolResult": {
      const el = pendingToolCalls.get(msg.toolCallId);
      if (el) {
        el.classList.remove("tool-call-pending");
        const isSubAgent = el.classList.contains("subagent");
        if (isSubAgent) {
          const out = String(msg.output);
          setSubAgentStatus(
            el,
            !msg.isError ? "done" : /aborted/i.test(out) || /interrupted/i.test(out) ? "aborted" : "failed",
          );
        }
        const resultEl = el.querySelector(".tool-result");
        if (resultEl) {
          // A sub-agent report is Markdown (its own answer); ordinary tool
          // output stays the plain/diff-aware renderer.
          if (isSubAgent) resultEl.innerHTML = renderMarkdown(String(msg.output).slice(0, 12000));
          else renderToolOutput(resultEl as HTMLPreElement, String(msg.output).slice(0, 12000));
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
      terminalShown = true;
      setStreaming(false);
      hideWorking();
      const stopEl = addMessage("assistant", "❌ ⏹ Processing interrupted.");
      stopEl.classList.add("error");
      scrollDown();
      focusPrompt();
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
    case "previewReady": {
      // Analyze prepared changes that are not applied: prominent CTA.
      addSwitchToBuildBanner();
      break;
    }
    case "loopIntervention": {
      // The loop guard broke a degenerate loop and the run CONTINUES: settle
      // the interrupted segment and show an amber notice (not a red error).
      flushStreamingMd();
      clearStreamingBubble();
      const el = addMessage("assistant", `🔁 **Loop guard** [${msg.loopType}] — ${msg.message}`);
      el.classList.add("loop");
      scrollDown();
      break;
    }
    case "harnessNudge": {
      // A corrective HARNESS prompt: show the light-blue "Nudge" bubble LIVE
      // (not only on the end-of-run refresh, which an error stop skips).
      flushStreamingMd();
      clearStreamingBubble();
      addHarnessMessage(String(msg.content || ""));
      scrollDown();
      break;
    }
    case "pending":
      renderPending((msg.items as PendingViewItem[]) || []);
      break;
    case "steerApplied": {
      // The soft-steer message reached a turn boundary: show it as a real user
      // bubble now (the end-of-run refresh rebuilds the transcript anyway).
      const el = addMessage("user", String(msg.content || ""));
      el.classList.add("steer-msg");
      scrollDown();
      break;
    }
    case "done":
      flushStreamingMd();
      finishStream();
      setStreaming(false);
      focusPrompt();
      break;
    case "error": {
      flushStreamingMd();
      setStreaming(false);
      hideWorking();
      if (currentResultEl) {
        currentResultEl.classList.add("error");
        currentResultEl.innerHTML = "<strong>" + escapeHtml(msg.error) + "</strong>";
      } else {
        // Always surface an error: dropping it when no bubble was open made
        // the run look like it silently stopped.
        const errEl = addMessage("assistant", "❌ " + (msg.error || "error"));
        errEl.classList.add("error");
      }
      resetStreamState();
      // An error already produced a visible terminal bubble: suppress the
      // "(empty response)" fallback when `done` follows (it always does).
      terminalShown = true;
      focusPrompt();
      break;
    }
    case "refresh": {
      messagesEl.innerHTML = "";
      resetStreamState();
      // A refresh rebuilds the transcript from host messages; drop the stale
      // reference to any previously appended compaction bubble (already wiped
      // with the container) so a later auto-compaction shows a fresh one.
      compactionEl = null;
      if (workspaceLocked({ workspaceReady: msg.workspaceReady })) {
        renderWorkspaceShell();
      } else if (!activeId) {
        renderEmptyShell();
      } else if (!renderMessages(msg.messages || [])) {
        addWelcome();
      }
      // A refresh (e.g. after a ✂ cut) rebuilds the transcript: return the caret
      // to the prompt so the user can keep typing from the clean point.
      if (Array.isArray(msg.skills)) renderSkills(msg.skills);
      focusPrompt();
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
    case "sessionsManager":
      // Re-render the rows. The modal only OPENS when the host says so (gear
      // click); silent refreshes after open/close/delete never pop the form.
      renderSessionsManagerData({ sessions: msg.sessions || [], currentFolder: msg.currentFolder });
      if (msg.show) sessionsModal.classList.remove("hidden");
      break;
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
      // Same lock for the tab × (a working session cannot be closed).
      applyTabLocks();
      // While ANY session works, the two setup gears go inert (manage
      // sessions / configure providers): no modal mid-stream.
      applyWorkingLock();
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
      renderPending((msg.pending as PendingViewItem[]) || []);
      // Opening/switching a session always lands the caret in the prompt, so
      // the user can type immediately.
      focusPrompt();
      break;
    }
    case "skills":
      renderSkills((msg.skills as { name: string; description: string }[]) || []);
      break;
    case "mcpServers":
      renderMcpEditor((msg.data || {}) as ConfigState["mcp"], msg.open === true);
      break;
    case "mcpSaved":
      if (msg.ok) closeMcpEditor();
      break;
    case "mcpTested":
      mcpTestResult.className = "mcp-io " + (msg.ok ? "ok" : "err");
      mcpTestResult.textContent = msg.ok
        ? `✅ Connected — ${msg.toolCount} tool(s)${Array.isArray(msg.tools) && msg.tools.length > 0 ? ": " + (msg.tools as string[]).slice(0, 6).join(", ") : ""}`
        : `❌ ${msg.error ?? "failed"}`;
      break;
    case "config":
      renderModelSelect(msg.config || {});
      renderThinkingSelect(msg.config || {});
      if (msg.config && isChatMode(msg.config.mode)) {
        applyMode(msg.config.mode);
      }
      if (msg.config && typeof msg.config.parallel === "boolean") {
        applyParallel(msg.config.parallel);
      }
      renderContextWindow(msg.config || {});
      renderOutputTokens(msg.config || {});
      renderSamplerControl(msg.config || {});
      renderControl((msg.config || {}) as ConfigState);
      presenceControl.render(msg.config && msg.config.presencePenalty);
      freqControl.render(msg.config && msg.config.frequencyPenalty);
      compactionThresholdPct = (msg.config && msg.config.compactionThresholdPercent) ?? 80;
      renderCompactionThreshold();
      renderMetrics(msg.config || {});
      break;
    case "providersEditor":
      openProvidersEditor((msg.data || {}) as never);
      break;
    case "providersTested":
      providerTestResult.classList.remove("hidden");
      if (msg.ok) {
        const models = Array.isArray(msg.models) ? (msg.models as string[]) : [];
        providerTestResult.textContent = models.length > 0
          ? `✅ Connection OK — ${models.length} model${models.length === 1 ? "" : "s"} found: ${models.slice(0, 6).join(", ")}${models.length > 6 ? "…" : ""}`
          : "✅ Connection OK — the host returned no models (is the model loaded?)";
        providerTestResult.className = "ok";
      } else {
        providerTestResult.textContent = "❌ Connection failed: " + (typeof msg.error === "string" ? msg.error : "GET /v1/models failed");
        providerTestResult.className = "err";
      }
      break;
    case "providersSaved":
      providersSaveBtn.disabled = false;
      if (msg.ok) {
        closeProvidersEditor();
      } else {
        providerTestResult.classList.remove("hidden");
        providerTestResult.textContent = "❌ Could not write the config file.";
        providerTestResult.className = "err";
      }
      break;
    case "providersExported":
      showProvidersIo(
        msg.ok ? "Exported to " + (msg.path || "file") : "Export failed" + (msg.error ? ": " + msg.error : ""),
        !!msg.ok,
      );
      break;
    case "providersImported":
      showProvidersIo(
        msg.ok ? "Imported from " + (msg.path || "file") : "Import failed" + (msg.error ? ": " + msg.error : ""),
        !!msg.ok,
      );
      break;
  }
});

/** Full in-place view state (init + switchView: no page reload) ──
 * Lock the two setup gears while ANY session works: opening the manage form
 * or the providers editor mid-stream is disabled (they get re-enabled the
 * moment the last working session finishes). Mirrors the per-row locks. */
function applyWorkingLock(): void {
  const busy = workingIds.size > 0;
  sessionsGearBtn.disabled = busy;
  gearBtn.disabled = busy;
  sessionsGearBtn.title = busy
    ? "Stop the current work before managing sessions"
    : "Manage all sessions (every folder)";
  gearBtn.title = busy
    ? "Stop the current work before configuring providers & models"
    : "Configure providers & models";
}

function renderViewState(state: {
  sessions: SessionInfo[];
  openIds: string[];
  activeId?: string;
  messages: ChatMsg[];
  config: ConfigState;
  workingIds?: string[];
}): void {
  openIds = state.openIds || [];
  const prevActiveId = activeId;
  activeId = state.activeId;
  // Attachments are per-composition: drop them when the active session changes.
  if (prevActiveId !== activeId) clearAttachments();
  currentSessions = state.sessions || [];
  workingIds = new Set(state.workingIds || []);
  renderSessions(currentSessions);
  renderTabs(currentSessions);
  renderModelSelect(state.config || {});
  renderThinkingSelect(state.config || {});
  if (state.config && isChatMode(state.config.mode)) {
    applyMode(state.config.mode);
  }
  if (state.config && typeof state.config.parallel === "boolean") {
    applyParallel(state.config.parallel);
  }
  renderContextWindow(state.config || {});
  renderOutputTokens(state.config || {});
  renderSamplerControl(state.config || {});
  renderControl(state.config || {});
  presenceControl.render(state.config && state.config.presencePenalty);
  freqControl.render(state.config && state.config.frequencyPenalty);
  compactionThresholdPct = (state.config && state.config.compactionThresholdPercent) ?? 80;
  renderCompactionThreshold();
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
  applyWorkingLock();
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
    currentResultEl.className = "msg assistant streaming";
    phaseLockPulse(currentResultEl);
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
// Control stack: COLLAPSED by default; a previously chosen state wins.
const savedCollapsed = (vscode.getState() as { controlsCollapsed?: boolean } | undefined)?.controlsCollapsed;
const collapsedDefault = savedCollapsed ?? true;
document.body.classList.toggle("controls-collapsed", collapsedDefault);
ctlToggle.setAttribute("aria-expanded", String(!collapsedDefault));
// The HOST is authoritative for mode + Parallel: the panel reflects
// `init.config` and must NOT reset them to defaults on load. The webview is
// recreated whenever the view is hidden/shown (no retainContextWhenHidden), so
// force-posting setParallel(false)/setMode("analyze") here would silently turn
// Parallel off on the host while the toggle still shows ON.
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
renderPending(init.pending || []);
if (activeId) vscode.postMessage({ type: "getConfig" });
// Opening the panel on a session lands the caret in the prompt.
if (activeId) focusPrompt();

export {};
