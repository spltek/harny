import { renderMarkdown } from "./markdown";
import { createPendingSection } from "./pending-section";
import type { PendingViewItem } from "./pending-section";
import { splitDiffFence, countDiff } from "./diff-fence";
import Prism from "./prism";
import { langIdForPath } from "./lang-map";
import { clampContextWindow, clampOutputTokens, DEFAULT_CONTEXT_WINDOW, DEFAULT_OUTPUT_TOKENS, MAX_CONTEXT_WINDOW, MAX_OUTPUT_TOKENS, MIN_CONTEXT_WINDOW, MIN_OUTPUT_TOKENS } from "../context-window";
import { clampTemperature, clampTopP, TEMPERATURE_MAX, TEMPERATURE_MIN, TEMPERATURE_STEP } from "../temperature";
// The SAME boundary the core uses to decide what the model receives: importing it
// (it is pure and dependency-free) is what keeps the transcript's marker and the
// request from ever disagreeing about where the window starts.
import { checkpointStart } from "../../core/history/conversation-validity";
import { toolArgTarget } from "../../core/tools/tool-call-text";
import type { SessionLiveProjection } from "../session-live-state";

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
/** Per-turn metrics captured from the provider stream (real usage + timings). */
interface MsgMeta {
  /** Model + named provider that served the turn (a session can switch both). */
  model?: string;
  provider?: string;
  /** The mode the RUN ran under (see MessageMeta.mode): a session can hold Analyze
   * (previews) and Build (writes) runs side by side. */
  mode?: "analyze" | "agent";
  /** Window and output budget vigent in that turn. */
  contextWindow?: number;
  maxTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedTokens?: number;
  cachedWriteTokens?: number;
  startedAt?: number;
  firstTokenAt?: number;
  endedAt?: number;
  ttftMs?: number;
  durationMs?: number;
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
  /** Analyze prepared previews that are NOT applied: show the "Switch to Build"
   * CTA after this message. */
  previewPrepared?: boolean;
  /** REAL per-turn usage + timings (assistant messages): shown as a badge. */
  meta?: MsgMeta;
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
  /** Open, but belonging to ANOTHER folder: listed so the tab is never orphaned
   * (see ChatViewProvider.sessionsForView). The folder stays authoritative for name
   * uniqueness, so this is about NAVIGATION, not about where the session lives. */
  foreign?: boolean;
}
interface ConfigState {
  provider: string;
  activeProvider?: string;
  model: string;
  hasKey: boolean;
  models?: string[];
  providerModels?: { provider: string; model: string; contextLength?: number; maxOutputTokens?: number }[];
  modelMissing?: boolean;
  hostModelErrors?: { provider: string; error: string }[];
  noModels?: boolean;
  configHome?: string;
  workspaceReady?: boolean;
  thinkingMode?: string;
  thinkingLevel?: string;
  /** Per-session chat mode (host truth): analyze (default) or agent. */
  mode?: "analyze" | "agent";
  /** Per-session "Parallel" switch: orchestration/sub-agents enabled. */
  parallel?: boolean;
  /** True when the models.dev fallback is unreachable and a limit is missing. */
  modelsDevError?: boolean;
  contextWindow?: number;
  /** Slider MAXIMUM for the context window (the model's detected value). */
  maxContextWindow?: number;
  /** Part of the window the INPUT may use (`window − reserve`): the bar's base. */
  contextUsable?: number;
  compactionThresholdPercent?: number;
  /** Landing fill the compaction aims at (explicit session value, else AUTO). */
  compactionTargetPercent?: number;
  /** True when the landing fill is AUTO (a quarter of the trigger). */
  compactionTargetAuto?: boolean;
  outputTokens?: number;
  /** Slider MAXIMUM for the output tokens (the model's detected value). */
  maxOutputTokens?: number;
  temperature?: number;
  presencePenalty?: number;
  frequencyPenalty?: number;
  topP?: number;
  sampler?: "temperature" | "topP";
  /** Effective concurrent sub-agent cap for the active session (0 = no cap). */
  maxParallelSubAgents?: number;
  /** Per-session Loop Guard sensitivity; undefined = the "medium" preset. */
  loopGuard?: "off" | "low" | "medium" | "high";
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
  /** The WHOLE in-flight turn (tool calls + sub-agent bubbles), from the host's
   * per-session engine: the history does not have them until the tool batch
   * commits, so a rebuild must restore them from here. */
  liveTurn?: SessionLiveProjection;
  /** A compaction is running on the active session: the provisional bubble must
   * come back after a rebuild instead of vanishing. */
  compacting?: boolean;
  /** Queue/steer messages typed while working (host re-pushes on reload). */
  pending?: PendingViewItem[];
  /** Extension version (shown in the empty hero). */
  version?: string;
  /** Cache-busted vscode-webview:// URI of media/icon.svg (hero brand mark). */
  logoUri?: string;
  /** Publisher credit for the empty hero (name + optional repository URL). */
  brand?: { name: string; url?: string };
}

const sessionsEl = document.getElementById("sessions") as HTMLDivElement;
const sessionSearchInput = document.getElementById("session-search") as HTMLInputElement;
const sessionSearchRow = document.getElementById("session-search-row") as HTMLDivElement;

/** Show/hide the sessions list AND its search field together (the search must
 * not linger when the section is collapsed). */
function setSessionsVisible(visible: boolean): void {
  sessionsEl.classList.toggle("hidden", !visible);
  sessionSearchRow.classList.toggle("hidden", !visible);
}

/**
 * Expand/collapse the sessions section, keeping the header arrow in sync. EVERY
 * path that changes the visibility goes through here, so the arrow can never
 * contradict the list (the header click, the empty hero, and picking a session).
 */
function setSessionsExpanded(expanded: boolean): void {
  setSessionsVisible(expanded);
  const toggle = sessionHead.querySelector(".toggle");
  if (toggle) toggle.textContent = expanded ? "▼" : "▶";
}
/** Matching ids for the MAIN-list search (null = no filter). Scoped to the
 * sessions already shown (the current workspace folder). */
let sessionSearchIds: Set<string> | null = null;
const sessionHead = document.getElementById("session-head") as HTMLDivElement;
const sessionsGearBtn = document.getElementById("sessions-gear-btn") as HTMLButtonElement;
const newSessionBtn = document.getElementById("new-session") as HTMLButtonElement;
const tabsEl = document.getElementById("tabs") as HTMLDivElement;
/** Overlay shown while a session is being loaded/activated (see showSwitchVeil). */
const switchVeil = document.getElementById("switch-veil");
const messagesEl = document.getElementById("messages") as HTMLDivElement;
// The pulsing working indicator: a REAL footer glued below the transcript (NOT
// a bubble in the flow), shown/hidden instead of being appended/removed.
const workingBar = document.getElementById("working-bar") as HTMLDivElement;
const inputEl = document.getElementById("user-input") as HTMLTextAreaElement;
const slashMenu = document.getElementById("slash-menu") as HTMLDivElement;
/** Installed skills (kept for the slash menu; set by renderSkills). */
let currentSkills: { name: string; description: string }[] = [];
let slashItems: { cmd: string; description: string }[] = [];
let slashIndex = 0;
const ctlToggle = document.getElementById("ctl-toggle") as HTMLDivElement;
const collapseAllBtn = document.getElementById("collapse-all") as HTMLButtonElement;
const autoscrollBtn = document.getElementById("autoscroll") as HTMLButtonElement;
const modeSelectEl = document.getElementById("mode-select") as HTMLDivElement;
const modeBtn = document.getElementById("mode-btn") as HTMLButtonElement;
const modeBtnLabel = document.getElementById("mode-btn-label") as HTMLSpanElement;
const modeBtnIconAnalyze = document.querySelector<SVGSVGElement>("#mode-btn-icon-analyze")!;
const modeBtnIconAgent = document.querySelector<SVGSVGElement>("#mode-btn-icon-agent")!;
const modeMenu = document.getElementById("mode-menu") as HTMLDivElement;
const modeItems = Array.from(modeMenu.querySelectorAll<HTMLButtonElement>(".mode-item"));
const parallelBtn = document.getElementById("parallel-btn") as HTMLButtonElement;
const sendBtn = document.getElementById("send-btn") as HTMLButtonElement;
const insertHint = document.getElementById("insert-hint") as HTMLSpanElement;
const insertHintWord = document.getElementById("insert-hint-word") as HTMLSpanElement;
const abortBtn = document.getElementById("abort-btn") as HTMLButtonElement;
const attachBtn = document.getElementById("attach-btn") as HTMLButtonElement;
const attachmentChips = document.getElementById("attachment-chips") as HTMLDivElement;
const modelBtn = document.getElementById("model-btn") as HTMLButtonElement;
const modelBtnLabel = document.getElementById("model-btn-label") as HTMLSpanElement;
const modelWarn = document.getElementById("model-warn") as HTMLSpanElement;
const modelModal = document.getElementById("model-modal") as HTMLDivElement;
const modelListEl = document.getElementById("model-list") as HTMLDivElement;
const mmModelsDevWarn = document.getElementById("mm-modelsdev-warn") as HTMLDivElement;
const modelSearchInput = document.getElementById("model-search") as HTMLInputElement;
const thinkingRadios = Array.from(document.querySelectorAll<HTMLInputElement>('input[name="thinking-level"]'));
const ctxRange = document.getElementById("ctx-range") as HTMLInputElement;
const ctxValue = document.getElementById("ctx-value") as HTMLSpanElement;
const ctxRangeLabel = document.getElementById("ctx-range-label") as HTMLSpanElement;
const outRange = document.getElementById("out-range") as HTMLInputElement;
const outValue = document.getElementById("out-value") as HTMLSpanElement;
const outRangeLabel = document.getElementById("out-range-label") as HTMLSpanElement;
const sampRange = document.getElementById("samp-range") as HTMLInputElement;
const sampRangeLabel = document.getElementById("samp-range-label") as HTMLSpanElement;
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
const metWindow = document.getElementById("met-window") as HTMLSpanElement;
const metCache = document.getElementById("met-cache") as HTMLSpanElement;
const ctxBar = document.getElementById("ctx-bar") as HTMLDivElement;
const compactBtn = document.getElementById("compact-btn") as HTMLButtonElement;
const compactThresholdLabel = document.getElementById("compact-threshold-label") as HTMLSpanElement;
const compactSettingsBtn = document.getElementById("compact-settings-btn") as HTMLButtonElement;
const compactSettingsModal = document.getElementById("compact-settings-modal") as HTMLDivElement;
const compactThresholdInput = document.getElementById("compact-threshold-input") as HTMLInputElement;
const compactSettingsCancel = document.getElementById("compact-settings-cancel") as HTMLButtonElement;
const compactSettingsSave = document.getElementById("compact-settings-save") as HTMLButtonElement;
const compactTargetInput = document.getElementById("compact-target-input") as HTMLInputElement;
const compactTargetAuto = document.getElementById("compact-target-auto") as HTMLButtonElement;
const compactPreview = document.getElementById("compact-preview") as HTMLPreElement;
const compactThresholdValue = document.getElementById("compact-threshold-value") as HTMLSpanElement;
const compactTargetValue = document.getElementById("compact-target-value") as HTMLSpanElement;

const init = JSON.parse((document.getElementById("harny-view-init") as HTMLScriptElement).textContent ?? "{}") as InitState;

let activeId: string | undefined = init.activeId;
let openIds: string[] = init.openIds || [];
let currentSessions: SessionInfo[] = init.sessions || [];
let workingIds = new Set<string>(init.workingIds || []);
/** Current auto-compaction threshold % of the context window (updated from config pushes). */
let compactionThresholdPct = 80;
/** Landing % shown in the settings modal: the session's own, or the derived AUTO. */
let compactionTargetPct = autoTargetFor(80);
/** True while the landing % is AUTO (no session override). */
let compactionTargetIsAuto = true;
/** The DERIVED floor for an explicit landing % (from the host preview): below it there is
 * nothing left to free, so the smallest explicit value is the floor. */
let compactionTargetFloorPct = 1;
// The modal edits a DRAFT. The three variables above are what the HOST has confirmed, and they
// are what the footer label and the request read: nothing may change there before Save, or
// Cancel becomes a lie. Sliding used to mutate them straight away, so cancelling left the
// unsaved trigger behind (reopening showed it) and a config push could snap it back — the same
// click looked broken in one session and fine in the next.
let draftThresholdPct = compactionThresholdPct;
let draftTargetPct = compactionTargetPct;
let draftTargetIsAuto = compactionTargetIsAuto;

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
// next send. Per session (they belong to that session's draft) and PERSISTED across a
// webview reload since this change — see persistCompositions for the size budget. ──
interface AttachedFile { name: string; path: string; size: number; isImage: boolean; dataUri?: string; content?: string; needsReattach?: boolean; }
let attachedFiles: AttachedFile[] = [];

// ── Per-session COMPOSITION: the prompt AND its attachments ──
/**
 * What you have typed/picked belongs to the SESSION, not to the panel: switching
 * tab parks it and coming back brings it back, chips included. `""` is the slot
 * used while no session is open.
 */
interface Composition {
  text: string;
  files: AttachedFile[];
}
const compositions = new Map<string, Composition>();

function draftKey(id: string | undefined): string {
  return id ?? "";
}

/** Park the current box under `id` (called right before switching away). */
function stashComposition(id: string | undefined): void {
  const key = draftKey(id);
  const text = inputEl.value;
  if (!text && attachedFiles.length === 0) compositions.delete(key);
  else compositions.set(key, { text, files: attachedFiles.slice() });
  persistCompositions();
}

/** Put the composition of `id` back in the box (empty when there is none). */
function restoreComposition(id: string | undefined): void {
  const saved = compositions.get(draftKey(id));
  inputEl.value = saved?.text ?? "";
  attachedFiles = saved ? saved.files.slice() : [];
  renderAttachmentChips();
  resizeInput();
}

/**
 * How much of an attachment's PAYLOAD may live in the webview state.
 *
 * `setState` keeps the value for the whole life of the panel, so it is not the place
 * for a pasted screenshot: 256KB per file is already generous, and the alternative —
 * keeping 15MB "just in case" — is exactly the kind of cost nobody can see in a
 * profile. Past the budget the file is still remembered (name, size, path) but marked
 * `needsReattach`, so nothing is silently sent as an empty attachment.
 */
const MAX_PERSISTED_ATTACHMENT_BYTES = 256 * 1024;

/**
 * Persist every session's draft — TEXT and ATTACHMENTS — so a webview reload (a VS
 * Code window reload, a view moved to another side bar) does not silently drop the
 * files you picked.
 *
 * Two shapes, and the split is deliberate:
 *  · `drafts` is the historical `{ key: text }` map, kept as-is so a state written by
 *    an older version still loads;
 *  · `draftFiles` carries the attachments, pruned by `forPersist` (see the budget).
 */
function persistCompositions(): void {
  const prev = (vscode.getState() as Record<string, unknown> | undefined) ?? {};
  const drafts: Record<string, string> = {};
  const draftFiles: Record<string, AttachedFile[]> = {};
  for (const [key, c] of compositions) {
    if (c.text) drafts[key] = c.text;
    if (c.files.length > 0) draftFiles[key] = c.files.map(forPersist);
  }
  vscode.setState({ ...prev, drafts, draftFiles });
}

/** Metadata always; the payload only while it fits the budget. See above. */
function forPersist(file: AttachedFile): AttachedFile {
  const meta: AttachedFile = { name: file.name, path: file.path, size: file.size, isImage: file.isImage };
  const payload = file.dataUri ?? file.content;
  if (payload === undefined || payload.length <= MAX_PERSISTED_ATTACHMENT_BYTES) {
    return {
      ...meta,
      ...(file.dataUri ? { dataUri: file.dataUri } : {}),
      ...(file.content ? { content: file.content } : {}),
    };
  }
  return { ...meta, needsReattach: true };
}

/** Rebuild an attachment from the persisted state, ignoring anything malformed (the
 * state is a JSON blob that a FUTURE or an OLDER version may have written). */
function fromPersisted(raw: unknown): AttachedFile | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const f = raw as Partial<AttachedFile>;
  if (typeof f.name !== "string") return undefined;
  const file: AttachedFile = {
    name: f.name,
    path: typeof f.path === "string" ? f.path : "",
    size: typeof f.size === "number" ? f.size : 0,
    isImage: f.isImage === true,
  };
  if (typeof f.dataUri === "string") file.dataUri = f.dataUri;
  if (typeof f.content === "string") file.content = f.content;
  if (f.needsReattach === true) file.needsReattach = true;
  return file;
}

/** The message was sent: the session's draft is consumed. */
function clearComposition(id: string | undefined): void {
  compositions.delete(draftKey(id));
  persistCompositions();
}

// ── Per-session VIEW MEMORY: where you were, and what you had open ──
/**
 * A transcript is rebuilt from history on every switch (and on every refresh), so
 * without this a session you were reading comes back scrolled to the end with every
 * section folded. That is the last thing a tab switch must not throw away.
 */
interface ViewMemory {
  scrollTop: number;
  /** True when the transcript was FOLLOWING the stream (pinned to the bottom):
   * those sessions must keep following it, the others go back where they were. */
  pinned: boolean;
  /** Indexes (document order) of the EXPANDED sections. Appends only ADD sections
   * at the end, so the indexes of an existing transcript stay valid. */
  open: number[];
}
const viewMemory = new Map<string, ViewMemory>();

/** Every collapsible section of the transcript (thinking, tool, sub-agent). */
function transcriptSections(): HTMLElement[] {
  return Array.from(messagesEl.querySelectorAll<HTMLElement>(TRANSCRIPT_SECTIONS));
}

/** Park scroll position and expanded sections of the session we are leaving. */
function stashViewMemory(id: string | undefined): void {
  const open: number[] = [];
  transcriptSections().forEach((body, i) => {
    if (!body.classList.contains("collapsed")) open.push(i);
  });
  viewMemory.set(draftKey(id), { scrollTop: messagesEl.scrollTop, pinned: autoScroll, open });
}

/**
 * How many messages each session had at its last rebuild.
 *
 * The open sections are keyed by DOCUMENT ORDER, which is only stable while the
 * transcript grows at the end. A COMPACTION (and a ✂ cut, and a branch) rewrites the
 * head: the kept messages slide down, so index 3 stops being the section you opened —
 * the panel would open a section nobody asked for, or silently close the one you were
 * reading. A shrinking transcript is the honest, cheap signal that this happened
 * (compaction always folds the head into a summary), so the saved set is dropped and
 * the sections come back CLOSED: the default of a session opened from scratch, which
 * is predictable. Guessing is the one thing worth avoiding here.
 */
const transcriptSize = new Map<string, number>();

function noteTranscriptSize(id: string | undefined, size: number): void {
  const key = draftKey(id);
  const previous = transcriptSize.get(key);
  transcriptSize.set(key, size);
  if (previous === undefined || size >= previous) return; // first visit, or it grew
  const mem = viewMemory.get(key);
  if (mem) mem.open = [];
}

/** Put scroll position and expanded sections back (no-op on a first visit).
 * `withScroll: false` restores only the sections — the `refresh` path already owns
 * the scroll through its anchor (which survives content growth better than an
 * absolute offset). */
function restoreViewMemory(id: string | undefined, withScroll = true): void {
  const mem = viewMemory.get(draftKey(id));
  if (!mem) return;
  // What was open. The live streaming block is skipped: it follows the stream, not
  // the saved state. Sections replayed LIVE after this point start collapsed (they
  // are recreated, not restored) — clicking one is the only cost, and it is the
  // honest one: a live bubble can differ on every rebuild.
  const open = new Set(mem.open);
  transcriptSections().forEach((body, i) => {
    if (body === currentThinkingBlock) return;
    const wantOpen = open.has(i);
    if (!body.classList.contains("collapsed") === wantOpen) return;
    body.classList.toggle("collapsed", !wantOpen);
    const tog = sectionToggle(body);
    if (tog) tog.textContent = wantOpen ? "▼" : "▶";
  });
  if (withScroll && !mem.pinned) {
    messagesEl.scrollTop = mem.scrollTop;
    autoScroll = false; // still parked above the bottom: do not chase the stream
    updateTranscriptActions();
  }
}

// ── Pending messages (queue/steer) typed while the session works: rendered by
// pending-section.ts; the host is the source of truth (it re-pushes on reload). ──
/** Client id counter for the pending messages this panel sends. */
let pendingSeq = 0;
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
 * Coalesce streaming renders instead of one markdown render per delta, so text
 * appears smoothly AND the panel stays responsive.
 *
 * Three rules, in this order:
 *
 * 1. SHORT text paints immediately: under `FAST_PAINT_CHARS` a render costs a
 *    few hundred microseconds, so the leading chunks of every segment stay
 *    perfectly live (this is also what keeps the stream feeling instant).
 * 2. ADAPTIVE PACING: the next paint waits at least as long as the previous
 *    render took. One markdown render of a long log can cost as much as a whole
 *    frame — repeated 60×/s it pins the webview's main thread, and every layout
 *    (resize, scroll, the next paint) has to wait behind it. That is what froze
 *    the panel on Windows while a run with parallel sub-agents was streaming:
 *    the message backlog never drained.
 * 3. TIMER FALLBACK: `requestAnimationFrame` is STARVED while the window is
 *    being resized (and while the webview is occluded/hidden), so a buffered
 *    chunk could wait for a frame that never comes. A `setTimeout` on the same
 *    coalescer guarantees the text still lands within a couple of frames.
 */
function makeThrottledMd(minIntervalMs = 16) {
  let raf: number | undefined;
  let timer: number | undefined;
  let last = 0;
  /** Duration of the last render: the pacing follows the REAL cost. */
  let lastCost = 0;
  let el: Element | null = null;
  let getText: (() => string) | null = null;

  function paint(e: Element, g: () => string): void {
    const started = performance.now();
    e.innerHTML = renderMarkdown(g());
    lastCost = performance.now() - started;
    last = performance.now();
    // The render grows the section BELOW the current scroll anchor: re-pin to
    // the bottom (auto-scroll guarded) or streaming appears below the fold.
    scrollDown();
  }

  /** Minimum gap between two paints: the nominal frame time, or what the last
   * render actually cost (never paint faster than we can afford). */
  function minGap(): number {
    return Math.max(minIntervalMs, lastCost);
  }

  function unschedule(): void {
    if (raf !== undefined) {
      window.cancelAnimationFrame(raf);
      raf = undefined;
    }
    if (timer !== undefined) {
      window.clearTimeout(timer);
      timer = undefined;
    }
  }

  /** Arm BOTH channels: the animation frame (normal path) and the timer. */
  function schedule(): void {
    if (raf === undefined) raf = window.requestAnimationFrame(tick);
    if (timer === undefined) {
      timer = window.setTimeout(() => {
        timer = undefined;
        tick();
      }, Math.max(32, Math.round(minGap())));
    }
  }

  function tick(): void {
    // Either channel may fire first: drop the other one.
    unschedule();
    const e = el;
    const g = getText;
    el = null;
    getText = null;
    if (!e || !g) return;
    // Too soon after the last paint: keep coalescing into the next frame.
    if (performance.now() - last < minGap()) {
      el = e;
      getText = g;
      schedule();
      return;
    }
    paint(e, g);
  }

  return {
    /** Schedule a render of getText() into el (leading edge + per-frame flush). */
    push(e: Element, g: () => string): void {
      // Cheap render: paint it straight away (the common case for the first
      // chunks of a segment, and for short answers/tool reports).
      if (g().length <= FAST_PAINT_CHARS) {
        unschedule();
        el = null;
        getText = null;
        paint(e, g);
        return;
      }
      el = e;
      getText = g;
      // Leading edge: the first chunk (or one after a quiet gap) paints NOW.
      if (raf === undefined && timer === undefined && performance.now() - last >= minGap()) {
        const ee = el;
        const gg = getText;
        el = null;
        getText = null;
        if (ee && gg) paint(ee, gg);
        return;
      }
      schedule();
    },
    /** Render the final text immediately (done/error/interrupt/refresh). */
    flush(e: Element | null, g: () => string): void {
      unschedule();
      el = null;
      getText = null;
      if (e) paint(e, g);
    },
    reset(): void {
      unschedule();
      el = null;
      getText = null;
      last = 0;
      lastCost = 0;
    },
  };
}

/** Above this many characters a markdown render stops being "cheap": the
 * coalescer takes over and the pacing follows the measured render cost. */
const FAST_PAINT_CHARS = 4096;

const thinkingMd = makeThrottledMd();
const answerMd = makeThrottledMd();

/** A live text node carrying its own RAW markdown (never re-read from the DOM). */
type RawEl = HTMLElement & { _raw?: string };

/**
 * Per-NODE coalescer for a SUB-AGENT's live text. Each bubble gets its own
 * (several sub-agents stream in parallel — a shared coalescer would let one
 * overwrite another's pending paint), and the cadence is slower than the main
 * stream: this log is secondary detail that grows into the tens of KB, where a
 * single markdown render already costs a good part of a frame.
 */
const SUBAGENT_MD_INTERVAL_MS = 100;
const subAgentMd = new WeakMap<Element, ReturnType<typeof makeThrottledMd>>();

function subAgentMdFor(node: Element): ReturnType<typeof makeThrottledMd> {
  let md = subAgentMd.get(node);
  if (!md) {
    md = makeThrottledMd(SUBAGENT_MD_INTERVAL_MS);
    subAgentMd.set(node, md);
  }
  return md;
}

/** Paint a sub-agent's buffered text right now: a TERMINAL event (done, error,
 * the final report) must never leave the last chunk invisible. */
function flushSubAgentMd(scope: Element): void {
  for (const node of Array.from(scope.querySelectorAll<RawEl>(".sa-thinking, .sa-answer"))) {
    const md = subAgentMd.get(node);
    const raw = node._raw;
    if (md && typeof raw === "string") md.flush(node, () => raw);
  }
}

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
  // The main list only ever holds the CURRENT folder's sessions, so the search
  // filter acts on that subset (a match in another folder never shows here).
  const visible = sessionSearchIds ? sessions.filter((s) => sessionSearchIds!.has(s.id)) : sessions;
  sessionsEl.innerHTML = "";
  if (visible.length === 0) {
    const p = document.createElement("div");
    p.className = "empty" + (sessionSearchIds ? " no-match" : "");
    p.textContent = sessionSearchIds ? "No session matches the search." : "No sessions in this folder. Create a new session.";
    sessionsEl.appendChild(p);
    return;
  }
  const openSet = new Set(openIds);
  for (const s of visible) {
    const row = document.createElement("div");
    row.className = "srow" + (openSet.has(s.id) ? " open" : "") + (workingIds.has(s.id) ? " is-working" : "");
    row.dataset.id = s.id;
    // An OPEN session of another folder is listed here on purpose (navigation must not
    // hide what is open): say where it lives instead of pretending it is local.
    if (s.foreign) {
      row.classList.add("foreign");
      row.title = s.folder ? `Open, from another folder: ${s.folder}` : "Open, created outside a workspace folder";
    }
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
    name.addEventListener("click", () => {
      // Same veil as a tab click — opening can take longer still (the messages come
      // off disk) and the list collapses right after, so the transcript is what
      // stays on screen: it must say that something is happening.
      showSwitchVeil(s.name);
      vscode.postMessage({ type: "openSession", id: s.id });
      // Picking a session ENDS the gesture: the list collapses so the transcript
      // gets the space back. The header is one click away to reopen it, and an
      // EMPTY session expands it again on its own (the hero points at the list).
      // Deliberately here and NOT on the row: branch/rename/delete act ON a row
      // without choosing it, so they must leave the list open.
      setSessionsExpanded(false);
    });
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
      // A drag that just ended still fires a CLICK on the tab it started on: the
      // tab was being moved, so it must not also switch session.
      if (Date.now() - dragEndedAt < DRAG_CLICK_GRACE_MS) return;
      if (id === activeId) return;
      // Veil AT ONCE: the host cannot post the new state until it has rebuilt the
      // config, and a switch that looks like a lost click is worse than a spinner.
      showSwitchVeil(s?.name);
      vscode.postMessage({ type: "switchTab", id });
    });
  }
  applyTabLocks();
  // Keep the ACTIVE tab visible when it CHANGES (the strip may be scrolled).
  if (activeId !== lastActiveTabId) {
    lastActiveTabId = activeId;
    tabsEl.querySelector<HTMLElement>(".tab.active")?.scrollIntoView?.({ inline: "nearest", block: "nearest" });
  }
}

/** Last active tab scrolled into view (avoid yanking the strip on every render). */
let lastActiveTabId: string | undefined;

// The tab strip has no vertical content: a vertical wheel scrolls it SIDEWAYS,
// so many (non-shrinking) tabs stay reachable. Horizontal trackpad deltas are
// left to the native overflow scroll.
tabsEl.addEventListener(
  "wheel",
  (e) => {
    if (e.deltaY === 0 || e.deltaX !== 0) return;
    const before = tabsEl.scrollLeft;
    tabsEl.scrollLeft += e.deltaY;
    if (tabsEl.scrollLeft !== before) e.preventDefault();
  },
  { passive: false },
);

// ── Dragging a tab to reorder the strip ──
// POINTER EVENTS, not HTML5 drag & drop: installDragAndDrop() claims dragenter /
// dragover / drop on the WINDOW to attach dropped FILES, so a native tab drag would
// be read as a file drop (empty dataTransfer, the "drag-over" glow, a pointless
// attach attempt). Pointer events stay inside the strip and give the visuals for free.
//
// TWO visuals, because "what am I dragging?" and "where will it land?" are two
// different questions:
//  · the GHOST — the dragged tab ITSELF is lifted out of the flow (position: fixed;
//    the same node, so its name and listeners travel with it) and follows the
//    pointer, tilted and shadowed, so it reads as held in the hand;
//  · the SLOT — a dashed placeholder of exactly the tab's width stays IN the strip
//    and hops between the other tabs as the pointer crosses their midpoints, so the
//    landing position is visible BEFORE releasing, and the tab lands exactly there.
// Nothing is re-rendered mid-drag (a re-render would destroy the nodes the gesture
// lives on): only the slot moves.
const DRAG_THRESHOLD_PX = 4;
/** Window after a drag in which the trailing click must NOT switch tab. */
const DRAG_CLICK_GRACE_MS = 300;
/** How close to the strip's edge the pointer must be for the strip to scroll itself. */
const DRAG_EDGE_PX = 24;
/** Pixels scrolled per move event while the pointer sits in the edge zone. */
const DRAG_EDGE_STEP_PX = 10;
/** The tab being dragged, floating out of the flow (undefined = no drag). */
let dragTab: HTMLElement | undefined;
/** The slot showing where the dragged tab will land. */
let dragPlaceholder: HTMLElement | undefined;
/** Where the pointer went down: the threshold is what separates a click from a drag. */
let dragStartX = 0;
/** Pointer position inside the tab at grab time, so the ghost does not jump on lift. */
let dragOffsetX = 0;
let dragOffsetY = 0;
/** True once the pointer travelled past the threshold. */
let dragMoved = false;
/** When the last drag ended (see DRAG_CLICK_GRACE_MS). */
let dragEndedAt = 0;

tabsEl.addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  const target = e.target as HTMLElement | null;
  if (target?.closest(".close")) return; // the × is not a drag handle
  const tab = target?.closest<HTMLElement>(".tab");
  if (!tab) return;
  dragTab = tab;
  dragStartX = e.clientX;
  dragMoved = false;
  // Keep receiving move/up even if the pointer leaves the panel: without the capture
  // a drag that ends outside the bar would leave the strip mid-reorder, with no
  // pointerup to commit it. jsdom has no capture — hence the optional call.
  tab.setPointerCapture?.(e.pointerId);
});

/** Lift the dragged tab into a floating ghost and open the slot it leaves behind. */
function startTabGhost(tab: HTMLElement, pointerX: number, pointerY: number): void {
  const r = tab.getBoundingClientRect();
  // The EXACT grab point: the ghost must not jump under the cursor when it lifts.
  dragOffsetX = pointerX - r.left;
  dragOffsetY = pointerY - r.top;
  const slot = document.createElement("div");
  slot.className = "tab-placeholder";
  // The SAME box as the tab it replaces: the strip's layout must not jump either.
  slot.style.width = r.width + "px";
  slot.style.height = r.height + "px";
  tabsEl.insertBefore(slot, tab);
  dragPlaceholder = slot;
  tab.classList.add("dragging");
  tab.style.width = r.width + "px";
  tab.style.height = r.height + "px";
  tab.style.left = r.left + "px";
  tab.style.top = r.top + "px";
  tabsEl.classList.add("reordering");
}

/** Move the slot to the index the pointer is over: before the first tab whose
 * midpoint lies to its right, else at the end. The ghost and the slot are skipped —
 * they are the gesture, not targets. */
function moveTabSlot(ghost: HTMLElement, pointerX: number): void {
  const slot = dragPlaceholder;
  if (!slot?.isConnected) return;
  const tabs = [...tabsEl.querySelectorAll<HTMLElement>(".tab")].filter((t) => t !== ghost);
  const before = tabs.find((t) => {
    const r = t.getBoundingClientRect();
    return pointerX < r.left + r.width / 2;
  });
  if (before) {
    if (slot.nextElementSibling !== before) tabsEl.insertBefore(slot, before);
  } else if (tabsEl.lastElementChild !== slot) {
    tabsEl.appendChild(slot);
  }
}

/** Scroll the strip while the pointer is held near one of its edges: a long row of
 * tabs must stay reachable WITHOUT dropping the tab first. */
function autoScrollStrip(pointerX: number): void {
  const r = tabsEl.getBoundingClientRect();
  if (!r.width) return; // no layout yet (or nothing to scroll)
  if (pointerX < r.left + DRAG_EDGE_PX) tabsEl.scrollLeft -= DRAG_EDGE_STEP_PX;
  else if (pointerX > r.right - DRAG_EDGE_PX) tabsEl.scrollLeft += DRAG_EDGE_STEP_PX;
}

window.addEventListener("pointermove", (e) => {
  const tab = dragTab;
  // A rebuild (switchView / refresh) replaced the nodes: that drag is over. Bailing
  // out here is what keeps a stale reference from moving a node nobody can see.
  if (!tab?.isConnected) {
    dragTab = undefined;
    dragPlaceholder = undefined; // it went with the rebuild
    tabsEl.classList.remove("reordering");
    return;
  }
  if (!dragMoved) {
    if (Math.abs(e.clientX - dragStartX) < DRAG_THRESHOLD_PX) return;
    dragMoved = true;
    startTabGhost(tab, e.clientX, e.clientY);
  }
  e.preventDefault();
  // The GHOST follows the pointer…
  tab.style.left = e.clientX - dragOffsetX + "px";
  tab.style.top = e.clientY - dragOffsetY + "px";
  // …and the SLOT says where it will land.
  moveTabSlot(tab, e.clientX);
  autoScrollStrip(e.clientX);
});

/** Drop the ghost: put the tab where the slot is, or snap back when cancelled. */
function endTabDrag(commit: boolean): void {
  const tab = dragTab;
  const slot = dragPlaceholder;
  const moved = dragMoved;
  dragTab = undefined;
  dragPlaceholder = undefined;
  dragMoved = false;
  tabsEl.classList.remove("reordering");
  if (!tab) return;
  tab.classList.remove("dragging");
  // Back into the flow BEFORE it is re-inserted, or it would keep its floating box.
  tab.style.left = "";
  tab.style.top = "";
  tab.style.width = "";
  tab.style.height = "";
  // The tab LANDS exactly where the slot was drawn: the preview cannot lie.
  if (slot?.isConnected) {
    if (tab.isConnected) slot.parentNode?.replaceChild(tab, slot);
    else slot.remove();
  }
  if (!moved) return; // a plain click: nothing to reorder
  dragEndedAt = Date.now();
  if (!commit || !tab.isConnected) {
    // Cancelled: the strip goes back to the order the host still believes in.
    if (tab.isConnected) renderTabs(currentSessions);
    return;
  }
  const ids = [...tabsEl.querySelectorAll<HTMLElement>(".tab")].map((t) => t.dataset.id ?? "").filter(Boolean);
  // Only a REAL change travels: dropping a tab where it already was must not
  // cost the host a message.
  if (ids.length !== openIds.length || ids.some((id, i) => id !== openIds[i])) {
    openIds = ids; // the strip IS the order until the host sends the next state
    vscode.postMessage({ type: "reorderTabs", ids });
  }
}

window.addEventListener("pointerup", () => endTabDrag(true));
window.addEventListener("pointercancel", () => endTabDrag(false));

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

// ── Switching a session ──
/** Safety net: a switch that never completes must not leave the veil up forever. */
const SWITCH_VEIL_TIMEOUT_MS = 8000;
let switchVeilTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Announce that a session is being opened/activated, on the transcript.
 *
 * A switch is NOT instant: the host rebuilds the config (`buildConfig`) and can be
 * busy finishing a turn before it posts the new state, and until it does the OLD
 * transcript sits there looking final — the click seems to have been ignored, which
 * is exactly how a user ends up clicking three more times. Naming the session is
 * the other half: a wrong click is noticed at once instead of after the fact.
 *
 * `name` is optional on purpose: a switch started by the host (a row, the manager,
 * a branch) may name a session the strip has not listed yet.
 */
function showSwitchVeil(name?: string): void {
  const label = switchVeil?.querySelector<HTMLElement>(".switch-label");
  if (label) label.textContent = name ? `Opening “${name}”…` : "Opening session…";
  switchVeil?.classList.add("visible");
  if (switchVeilTimer !== undefined) clearTimeout(switchVeilTimer);
  switchVeilTimer = setTimeout(hideSwitchVeil, SWITCH_VEIL_TIMEOUT_MS);
}

/** Take the veil down: the state it was waiting for has arrived (or never will). */
function hideSwitchVeil(): void {
  switchVeil?.classList.remove("visible");
  if (switchVeilTimer !== undefined) {
    clearTimeout(switchVeilTimer);
    switchVeilTimer = undefined;
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
  // Scrolling is what makes the "Autoscroll" pill applicable or not.
  updateTranscriptActions();
});

/**
 * The READING POSITION, captured before a rebuild destroys the nodes.
 *
 * Anchored on the ELEMENT under the top edge, not on a pixel offset. A refresh can
 * change the transcript's height — a compaction adds the divider and the summary card
 * and re-slices the history — and the same `scrollTop` then lands somewhere else in
 * it, which is how the view used to jump halfway through the chat. Saving and
 * restoring `scrollTop` itself would fix nothing: the browser already keeps it across
 * a wipe-and-re-render in the same task, and THAT is the defect.
 *
 * Measured with getBoundingClientRect, never offsetTop: #messages is not positioned,
 * so a child's offsetTop is measured against some ancestor instead.
 */
interface ScrollAnchor {
  /** Which child sat under the top edge, by position among #messages' children. */
  index: number;
  /** How far ABOVE the edge it started (negative when it started below, i.e. a gap). */
  above: number;
}

function captureScrollAnchor(): ScrollAnchor | null {
  // Following the bottom needs no anchor: the rebuild scrolls there anyway.
  if (autoScroll) return null;
  const kids = Array.from(messagesEl.children) as HTMLElement[];
  if (kids.length === 0) return null;
  const edge = messagesEl.getBoundingClientRect().top;
  for (let i = 0; i < kids.length; i++) {
    const r = kids[i].getBoundingClientRect();
    if (r.bottom > edge) return { index: i, above: edge - r.top };
  }
  return null; // nothing spans the edge (scrolled into the bottom padding)
}

function restoreScrollAnchor(anchor: ScrollAnchor | null): void {
  if (!anchor) return;
  const el = messagesEl.children[anchor.index] as HTMLElement | undefined;
  // The list changed under us (a compaction rewrites the head of the transcript): do
  // NOTHING. A wrong scroll is worse than no scroll, and falling back to the top or
  // the bottom would be exactly the jump this exists to prevent.
  if (!el) return;
  const edge = messagesEl.getBoundingClientRect().top;
  messagesEl.scrollTop += el.getBoundingClientRect().top - edge + anchor.above;
}

/**
 * A pointer to the summary card, left where the reader ACTUALLY is.
 *
 * After a compaction the transcript reads [past][divider][CARD][kept]: the card opens the
 * context window, which puts it at the HEAD — several screens above the bottom. That is
 * structurally right and practically invisible: you are following the stream at the end,
 * so the compaction would have no visible effect where you are looking. The card cannot
 * move (it IS the boundary), so the EVENT gets a line — and the line takes you there.
 */
function addCompactedHint(): void {
  const wrap = document.createElement("div");
  wrap.className = "compacted-hint";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.textContent = "🧹 Context compacted · the summary is above ↑";
  btn.title = "Scroll to the summary that now opens the context window";
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    // Exactly ONE card is rendered (older checkpoints are folded into a single row).
    messagesEl.querySelector(".msg.user.synthetic-summary")?.scrollIntoView?.({ block: "start" });
  });
  wrap.appendChild(btn);
  messagesEl.appendChild(wrap);
  // Only when the reader is following: appending while they are mid-transcript must not
  // move their view (they will see the line when they get there).
  scrollDown();
  updateTranscriptActions();
}

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
    if (role === "user") {
      // Left-aligned, shrink-to-fit text INSIDE a centered bubble: a single
      // character sits in the middle of the min-width bubble, and longer text
      // grows to the bubble edges but stays left-aligned.
      const text = document.createElement("span");
      text.className = "user-text";
      text.textContent = content || "";
      div.appendChild(text);
    } else {
      div.textContent = content || "";
    }
    if (role === "user" && attachments && attachments.length > 0) {
      // The bubble is now wide for a reason of its OWN: an attachment is usually wider
      // than the text, and a shrink-to-fit text block would float in the middle of it,
      // reading as if the message were centred. The marker is what lets the CSS give the
      // text the full width (see `.msg.user.has-attachments > .user-text`), so it starts
      // where the previews do.
      div.classList.add("has-attachments");
      div.appendChild(messageAttachmentRow(attachments, images));
    }
  }
  messagesEl.appendChild(div);
  scrollDown();
  return div;
}

/** Compact duration: 820ms / 3.4s / 1m05s. */
function fmtDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m${String(Math.round(s % 60)).padStart(2, "0")}s`;
}

/** Compact per-turn metrics badge (REAL usage + timings) shown under a bubble. */
function metaBadge(meta: MsgMeta): HTMLElement | undefined {
  const parts: string[] = [];
  // The model comes FIRST: with a session switching between llama-local,
  // OpenRouter and opencode, the identity of the turn is what makes the token
  // counts that follow readable. The tooltip carries the rest of the budget
  // (provider, window, output budget) — the row itself is nowrap + ellipsized,
  // so only what identifies the turn belongs on it.
  if (meta.model) parts.push(meta.provider ? `${meta.provider}/${meta.model}` : meta.model);
  if (typeof meta.inputTokens === "number") parts.push(`${fmtTokens(meta.inputTokens)} in`);
  if (typeof meta.outputTokens === "number") parts.push(`${fmtTokens(meta.outputTokens)} out`);
  if (typeof meta.cachedTokens === "number" && meta.cachedTokens > 0) parts.push(`⚡ ${fmtTokens(meta.cachedTokens)}`);
  if (typeof meta.durationMs === "number") parts.push(`elapsed ${fmtDuration(meta.durationMs)}`);
  if (typeof meta.ttftMs === "number") parts.push(`first token ${fmtDuration(meta.ttftMs)}`);
  if (parts.length === 0 && !meta.mode) return undefined;
  const el = document.createElement("div");
  // Only the WORD "Build" takes the accent (.msg-meta .meta-mode.build): the rest of
  // the line stays the quiet gray of the model and the counts, so the chip reads as a
  // marker and not as a loud row repeated under half the transcript.
  el.className = "msg-meta";
  if (meta.mode) {
    // The mode leads, as a chip: it is what you SCAN a long transcript for (which turns
    // wrote and which only prepared previews). Older turns have no mode recorded — the
    // chip simply is not there, no placeholder and no "unknown".
    const build = meta.mode === "agent";
    const chip = document.createElement("span");
    chip.className = `meta-mode ${build ? "build" : "analyze"}`;
    chip.textContent = build ? "Build" : "Analyze";
    chip.title = build
      ? "This turn ran in Build: tools wrote for real"
      : "This turn ran in Analyze: read-only, changes were prepared as previews";
    el.appendChild(chip);
    if (parts.length > 0) el.appendChild(document.createTextNode(" · " + parts.join(" · ")));
  } else {
    el.textContent = parts.join(" · ");
  }
  el.title = [
    meta.mode ? `mode: ${meta.mode === "agent" ? "Build" : "Analyze"}` : "",
    meta.model ? `model: ${meta.model}` : "",
    meta.provider ? `provider: ${meta.provider}` : "",
    meta.contextWindow !== undefined ? `context window: ${meta.contextWindow} tokens` : "",
    meta.maxTokens !== undefined ? `output budget: ${meta.maxTokens} tokens` : "",
    meta.inputTokens !== undefined ? `input: ${meta.inputTokens} tokens` : "",
    meta.outputTokens !== undefined ? `output: ${meta.outputTokens} tokens` : "",
    meta.totalTokens !== undefined ? `total: ${meta.totalTokens} tokens` : "",
    meta.cachedTokens !== undefined ? `cached input: ${meta.cachedTokens} tokens` : "",
    meta.cachedWriteTokens !== undefined ? `cache write: ${meta.cachedWriteTokens} tokens` : "",
    meta.ttftMs !== undefined ? `time to first token: ${meta.ttftMs} ms` : "",
    meta.durationMs !== undefined ? `duration: ${meta.durationMs} ms` : "",
  ]
    .filter(Boolean)
    .join("\n");
  return el;
}

/**
 * Append a per-turn metrics badge at the END of the transcript. Used by the
 * live `turnMeta` event: the turn just ended, so the badge is known and can be
 * shown immediately with NO full re-render (no flicker).
 */
function appendTurnBadge(meta: MsgMeta | undefined): void {
  if (!meta) return;
  const badge = metaBadge(meta);
  if (!badge) return;
  messagesEl.appendChild(badge);
  scrollDown();
}

/**
 * Highlighted, clickable call to action shown when Analyze prepared changes
 * that are NOT applied. Makes the mandatory "switch to Build" step obvious
 * instead of burying it in a line of text.
 */
/**
 * Static note shown when Analyze prepared changes that are NOT applied. It is
 * purely informational: the ACTION (switch to Build) is asked ONCE through the
 * in-panel modal when the previews are created (host side), so no stale button
 * lingers in the transcript or can be clicked on an old turn.
 */
function addSwitchToBuildBanner(): void {
  // The user may have switched to Build WHILE this run worked: the switch is PENDING (it
  // lands on the next run), so the previews are still not on disk — but "switch to Build"
  // would name a step they have already taken, and the pill already says Build.
  if (currentMode === "agent") return;
  const el = document.createElement("div");
  el.className = "build-cta build-cta-static";
  const text = document.createElement("span");
  text.className = "build-cta-text";
  text.textContent = "Prepared as previews in Analyze — switch to Build to apply.";
  el.appendChild(text);
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

function addThinkingBlock(text: string, beforeEl?: HTMLElement | null, opts?: { pulse?: boolean; label?: string }): HTMLDivElement {
  const block = makeThinkingBlock(opts?.label ?? "🤔 Thinking...", text, undefined, beforeEl);
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
 * Target of a tool call shown in the header after the tool name. The IMPLEMENTATION
 * is shared with the compactor (see core/tools/tool-call-text.ts): the transcript and
 * the summarizer must describe a call the same way, and a second copy is exactly how
 * the summarizer ended up blind to tool calls in the first place.
 */
function toolTargetArg(args: unknown): string | undefined {
  return toolArgTarget(args);
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

// ── Collapse all ───────────────────────────────────────────────────────────
/** Every collapsible section of the transcript: thinking blocks, tool bubbles
 * (Input / Output / Diff) and sub-agent bubbles. All three follow the same
 * pattern — a body carrying `collapsed` plus an arrow in the header — which is
 * what makes ONE action able to close all of them. */
const TRANSCRIPT_SECTIONS = ".thinking-body, .tool-details, .subagent-body";

/** The header arrow that owns a section body. Thinking blocks name it
 * `.toggle`, tool and sub-agent headers `.tool-toggle`. */
function sectionToggle(body: Element): HTMLElement | null {
  return body.parentElement?.querySelector<HTMLElement>(".tool-toggle, .toggle") ?? null;
}

/** Keeps the two transcript action pills in sync. They are NEVER hidden — only
 * `disabled` changes — so the row can never reflow under the cursor. */
function updateTranscriptActions(): void {
  // "Collapse all": only meaningful while at least one section — a transcript section
  // OR an open pending bubble — is expanded.
  const anyOpen =
    Array.from(document.querySelectorAll<HTMLElement>(TRANSCRIPT_SECTIONS)).some(
      (el) => !el.classList.contains("collapsed"),
    ) || pending.openCount() > 0;
  collapseAllBtn.disabled = !anyOpen;
  // "Autoscroll": only while the user is parked above the bottom. autoScroll is
  // DERIVED from the scroll position (see the scroll listener), so reaching the
  // bottom re-arms it by itself — this pill only has to carry you there.
  autoscrollBtn.disabled = autoScroll;
}

/** Collapse every expanded section and reset its arrow. Returns how many were
 * open, so tests can assert on the effect instead of on the DOM. */
function collapseAllSections(): number {
  let collapsed = 0;
  document.querySelectorAll<HTMLElement>(TRANSCRIPT_SECTIONS).forEach((body) => {
    if (body.classList.contains("collapsed")) return;
    body.classList.add("collapsed");
    const tog = sectionToggle(body);
    if (tog) tog.textContent = "▶";
    collapsed += 1;
  });
  // The pending bubbles fold with them: they are the same gesture ("close what is
  // open"), and their own module keeps them in sync from there.
  collapsed += pending.collapseAll();
  return collapsed;
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
  // The goal preview is NOT pre-truncated here: how much of it fits depends on
  // the panel width, so the CSS does it (ellipsis on `.subagent-name`), which
  // also means the "…" travels left as the header narrows instead of sitting at a
  // fixed cut. The full text stays in the tooltip.
  const goalPreview = goal;
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
    (goal ? '<span class="subagent-name" title="' + escapeHtml(goal) + '">' + escapeHtml(goalPreview) + "</span>" : "") +
    (role ? '<span class="subagent-role">' + escapeHtml(role) + "</span>" : "") +
    '<span class="subagent-status queued">queued…</span>' +
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
    let t = log.querySelector(".sa-thinking") as RawEl | null;
    if (!t) {
      t = document.createElement("div");
      t.className = "sa-thinking";
      log.appendChild(t);
    }
    // Markdown, like the thinking blocks: keep the FULL text (raw on the
    // element) and let the container scroll — never trim from the top.
    // The RENDER is coalesced (a sub-agent can emit hundreds of deltas per
    // second, each re-parsing its whole log): accumulate on the node, paint on
    // the frame. `paint` scrolls, so nothing is lost visually.
    t._raw = (t._raw ?? "") + event.content;
    const node = t;
    subAgentMdFor(node).push(node, () => node._raw ?? "");
  } else if (event.type === "text_delta" && typeof event.content === "string") {
    let a = log.querySelector(".sa-answer") as RawEl | null;
    if (!a) {
      a = document.createElement("div");
      a.className = "sa-answer";
      log.appendChild(a);
    }
    a._raw = (a._raw ?? "") + event.content;
    const node = a;
    subAgentMdFor(node).push(node, () => node._raw ?? "");
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
    // The log is complete: paint whatever the coalescer still holds.
    flushSubAgentMd(el);
    // Only a queued/running sub-agent can become done — never override a
    // terminal status (done/failed/aborted).
    const chip = el.querySelector(".subagent-status");
    if (chip && (chip.classList.contains("queued") || chip.classList.contains("running"))) {
      setSubAgentStatus(el, "done");
    }
  } else if (event.type === "error") {
    // Nothing may stay buffered behind a terminal event.
    flushSubAgentMd(el);
    // A fatal sub-agent error (e.g. loop/API): mark failed unless it already
    // reported done.
    if (!el.querySelector(".subagent-status.done")) setSubAgentStatus(el, "failed");
  }
}

/** The provisional "Compacting…" bubble (idempotent: one per transcript). */
function ensureCompactionBubble(): void {
  if (compactionEl) return;
  compactionEl = document.createElement("div");
  compactionEl.className = "working";
  compactionEl.textContent = "● Compacting…";
  // Same beat as the Working bar and the play key. This bubble is created mid-run,
  // so a plain CSS animation would start its cycle at zero and pulse OUT OF PHASE
  // with everything already on screen — the reported defect.
  phaseLockPulse(compactionEl);
  messagesEl.appendChild(compactionEl);
  scrollDown();
}

function addWorking(): HTMLDivElement {
  workingEl = workingBar;
  workingBar.classList.remove("hidden");
  workingBar.textContent = "● Working...";
  // The bar can appear MID-turn (a sub-agent, a resumed run): join the cycle where the
  // play button already is instead of restarting it from zero.
  phaseLockPulse(workingBar);
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

/** Empty-session greeting. The brand mark is the REAL media/icon.svg (served
 * through state.logoUri), not an emoji or an inlined copy. */
function addWelcome(): HTMLDivElement {
  const div = document.createElement("div");
  div.className = "msg welcome";
  const mark = init.logoUri
    ? '<img class="welcome-logo" src="' + escapeHtml(init.logoUri) + '" alt="" draggable="false"> '
    : "";
  div.innerHTML = "<b>" + mark + "Harny</b><br><small>Write a message and press Enter</small>";
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
  updateTranscriptActions();
}

/** Confirm a workspace folder is present before touching the transcript. */
function workspaceLocked(config: { workspaceReady?: boolean }): boolean {
  return config.workspaceReady === false;
}

/** "v0.2.1 · by SPLTek" — version and publisher credit share one muted line.
 * The credit is a plain <a href>: VS Code opens http(s) webview links in the
 * system browser on its own, so no host round-trip is needed. */
function heroMetaLine(): string {
  const version = init.version ? "v" + escapeHtml(init.version) : "";
  const name = init.brand?.name ? escapeHtml(init.brand.name) : "";
  const credit = !name
    ? ""
    : init.brand!.url
      ? '<a class="brand-link" href="' + escapeHtml(init.brand!.url) + '">by ' + name + "</a>"
      : "by " + name;
  const parts = [version, credit].filter(Boolean);
  return parts.length ? '<div class="empty-version">' + parts.join(" · ") + "</div>" : "";
}

/**
 * Empty shell: NO open session. The control stack (input, status, metrics)
 * is hidden via the `no-session` body class and a hero takes over the chat
 * area, pushing the user to pick a session from the list or create a new one.
 */
function renderEmptyShell(): void {
  document.body.classList.add("no-session");
  messagesEl.innerHTML = "";
  updateTranscriptActions();
  const hero = document.createElement("div");
  hero.className = "empty-hero";
  hero.innerHTML =
    '<div class="empty-icon empty-logo">' +
    (init.logoUri
      ? '<img src="' + escapeHtml(init.logoUri) + '" alt="Harny" draggable="false">'
      : "") +
    "</div>" +
    "<h2>Harny</h2>" +
    heroMetaLine() +
    "<p>No session is open right now.</p>" +
    '<p class="empty-hint">Pick one from the list above,<br>start a new conversation,<br>or branch an existing session.</p>' +
    '<button id="empty-new-session" class="empty-cta" title="Create a new session">New session</button>';
  messagesEl.appendChild(hero);
  hero.querySelector("#empty-new-session")?.addEventListener("click", () => {
    vscode.postMessage({ type: "newSession" });
  });
  // The sessions list is the second path to act: make sure it stays visible.
  setSessionsExpanded(true);
}

/**
 * The rule that marks where the CONTEXT WINDOW starts.
 *
 * Everything ABOVE it is still in the session — in the transcript, readable,
 * searchable — but is no longer sent to the model; everything from the summary
 * below it is. It exists because a long session otherwise looks like it is
 * growing without bound while the context bar stays put, with nothing on screen
 * explaining why.
 */
function addWindowDivider(outOfWindow: number): HTMLDivElement {
  const div = document.createElement("div");
  div.className = "ctx-divider";
  div.textContent =
    outOfWindow > 0
      ? `${outOfWindow} message${outOfWindow === 1 ? "" : "s"} above · kept in the session, out of the context window`
      : "out of the context window";
  messagesEl.appendChild(div);
  return div;
}

/**
 * One row for the checkpoints that are NO LONGER the boundary.
 *
 * Their content is already inside the newest summary — a compaction folds the previous
 * one in, a trim carries it verbatim — so re-rendering their bodies says nothing new and
 * is pure noise in a long transcript. Their existence is still worth a line, because it
 * is how you know the window has moved more than once.
 */
function addOldSummariesLine(count: number): HTMLDivElement {
  const div = document.createElement("div");
  div.className = "old-summaries";
  div.textContent = `${count} earlier summar${count === 1 ? "y" : "ies"}, folded into the one below`;
  messagesEl.appendChild(div);
  return div;
}

function renderMessages(msgs: ChatMsg[]): boolean {
  // A transcript that SHRANK was rewritten in the middle (a compaction, a ✂ cut, a
  // branch): the positionally-keyed open sections no longer point at what they did.
  noteTranscriptSize(activeId, msgs.length);
  historyLength = msgs.length;
  const outputs = new Map<string, string>();
  for (const m of msgs) {
    if (m.role === "tool" && m.toolCallId && m.content) outputs.set(m.toolCallId, m.content);
  }
  // Where the window begins (see checkpointStart). The summary BODY is the pair's
  // second half, so it can be styled as the card the label opens instead of as a
  // normal answer — one implementation, shared with the request itself.
  const boundary = checkpointStart(msgs);
  const summaryBody = msgs[boundary]?.synthetic ? boundary + 1 : -1;
  const outOfWindow = msgs.slice(0, boundary).filter((m) => !m.synthetic).length;
  // The checkpoints ABOVE the boundary are history (see addOldSummariesLine).
  const oldPairs = new Set<number>();
  for (let i = 0; i < boundary; i++) if (msgs[i].synthetic) oldPairs.add(i);
  const firstOldPair = oldPairs.size > 0 ? Math.min(...oldPairs) : -1;
  let hasVisible = false;
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (m.role === "system" || m.role === "tool") continue;
    if (oldPairs.has(i)) {
      if (i === firstOldPair) {
        addOldSummariesLine(oldPairs.size / 2);
        hasVisible = true;
      }
      continue;
    }
    hasVisible = true;
    // The marker sits just above the checkpoint, where the window opens.
    if (i === boundary && boundary > 0) addWindowDivider(outOfWindow);
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
        const bubble = addMessage("assistant", content);
        // The summary that OPENS the window: the body of the checkpoint card, not
        // an answer — it must not read as something the model just said.
        if (i === summaryBody) bubble.classList.add("synthetic-body");
        if (content.startsWith("❌")) bubble.classList.add("error");
        else if (content.startsWith("🔁")) bubble.classList.add("loop");
        // Loop notices are system annotations, not branchable messages.
        if (!content.startsWith("🔁")) attachBranchAt(bubble, i);
        // Prepared-but-not-applied changes: re-render the static note from the
        // message FLAG (reliable on reload). The ACTION is the one-shot host
        // modal; the transcript keeps only the informational note.
        if (m.previewPrepared) addSwitchToBuildBanner();
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
      // Badge at the END of the turn (after the text bubble AND its tool
      // bubbles), matching the live `turnMeta` injection.
      if (m.meta) {
        const badge = metaBadge(m.meta);
        if (badge) messagesEl.appendChild(badge);
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
  // The per-message `addMessage` already scrolled, but the metrics badge is
  // appended AFTER the last bubble: scroll once more so auto-scroll includes
  // its height (otherwise the badge is left just below the fold).
  if (hasVisible) scrollDown();
  // A rebuild always starts from collapsed sections, so nothing is left to
  // collapse (or nothing is there at all after a switch/clear).
  updateTranscriptActions();
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
  // The compaction bubble is DOM-only state pointing at a node that is about to be
  // thrown away: keeping it would make `compactStart` skip re-creating it, so the
  // bubble never came back after a tab switch.
  compactionEl = null;
  // The nested tool lines of the sub-agent logs go with the bubbles they lived
  // in: keeping the entries would only grow a map of detached nodes across every
  // rebuild (a replay re-registers the ones that still matter).
  subAgentToolEls.clear();
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
    // A file that came back from a reload without its payload says so, on the chip:
    // the ⚠ is the only warning before send() refuses it.
    if (file.needsReattach) {
      chip.classList.add("attach-stale");
      chip.title = `${file.path || file.name} — too large to keep across a reload: re-attach it`;
      const warn = document.createElement("span");
      warn.className = "attach-warn";
      warn.textContent = "⚠";
      chip.appendChild(warn);
    }
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
// The queue/steer footer lives in its own module (pending-section.ts): the section
// with its counts, the per-bubble fold and the two commands. It is built once at
// load, with the DOM it owns and the ONE way it may talk to the host.
const pendingArea = document.getElementById("pending-area") as HTMLElement;
const pending = createPendingSection({
  section: document.getElementById("pending-section") as HTMLElement,
  head: document.getElementById("pending-head") as HTMLElement,
  headText: document.getElementById("pending-head-text") as HTMLElement,
  area: pendingArea,
  post: (message) => vscode.postMessage(message),
  // The SAME renderer a user bubble uses for its attachments, so the previews inside
  // a pending message are identical to the ones it will show once delivered.
  renderAttachments: (host, item) => {
    if (item.attachments && item.attachments.length > 0) {
      host.appendChild(messageAttachmentRow(item.attachments));
    }
  },
});

/** The footer as last rendered (`id:mode` per item), so a CHANGE — added, cancelled,
 *  converted — can be told from the initial push the host sends on reload. */
let pendingSnapshot: string | null = null;

/**
 * The insert-in hint ("Insert prompt in Queue" / "Insert prompt in Steer") is a pure INDICATOR
 * (never clicked): it shows Steer ONLY while a run is active AND Ctrl/Cmd is held,
 * and Queue otherwise. Releasing the key (or the run ending) returns it to Queue; a
 * sent message leaves it as-is (still Steer while the key is down, Queue once
 * released). It replaced the Queue/Steer pill that used to sit in the model row.
 */
let steerModifierHeld = false;
/** The mode last PAINTED, so a real Queue<->Steer switch can be told from a repaint. */
let lastSteerMode = false;

/** The mode a new message will use right now. */
function effectiveSendMode(): "queue" | "steer" {
  return streamingActive && steerModifierHeld ? "steer" : "queue";
}

/** Paint the hint: word + red "Steer" pill + dim when idle. */
function renderSteerMode(): void {
  const isSteer = effectiveSendMode() === "steer";
  const switched = isSteer !== lastSteerMode;
  lastSteerMode = isSteer;
  insertHint.classList.toggle("is-steer", isSteer);
  // Idle has no meaningful choice: dim the line exactly like the old disabled pill.
  insertHint.classList.toggle("is-idle", !streamingActive);
  insertHintWord.textContent = isSteer ? "Steer" : "Queue";
  insertHint.title = isSteer
    ? "Steer: the next message is injected into the running loop"
    : streamingActive
      ? "Queue: the next message runs after the current run ends (hold Ctrl/Cmd to Steer)"
      : "Queue: the next message runs after the current run ends";
  // Switching Queue <-> Steer is a decision about the run in progress — ONCE per real
  // switch, not on every repaint of the indicator (it repaints on each key press while
  // the modifier is held).
  if (switched) followAndFocus();
}

function send(): void {
  if (!activeId) return;
  const text = inputEl.value.trim();
  const attachments = attachedFiles.slice();
  // A file whose payload could not survive a reload must NOT be sent as an empty
  // attachment: the model would receive a name and nothing else, and the mistake would
  // look like a successful send. Ask for it again instead.
  const stuck = attachments.find((f) => f.needsReattach);
  if (stuck) {
    // A LOCAL refusal, not a host round-trip: the run never starts, and the note goes
    // away on the next refresh because it is not part of the conversation.
    addMessage("assistant", `❌ Re-attach "${stuck.name}": it was too large to keep across a reload.`);
    scrollDown();
    return;
  }
  if (!text && attachments.length === 0) return;
  const effectiveMode: "queue" | "steer" = effectiveSendMode();
  inputEl.value = "";
  inputEl.style.height = "auto"; // back to a single line for the next message
  clearAttachments();
  clearComposition(activeId);
  if (streamingActive) {
    // The session works: the message is pending. The HOST owns the bubble (it
    // re-pushes the list on reload), so do NOT append a user bubble here.
    vscode.postMessage({
      type: "send",
      mode: effectiveMode,
      id: "c" + ++pendingSeq,
      text,
      ...(attachments.length > 0 ? { attachments } : {}),
    });
    renderSteerMode();
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

// The play key uses the SAME mode as Enter (toggle state, Ctrl/Cmd override).
sendBtn.addEventListener("click", (e) => {
  steerModifierHeld = steerModifierHeld || e.ctrlKey || e.metaKey;
  send();
});
attachBtn.addEventListener("click", () => vscode.postMessage({ type: "pickFiles" }));
// The insert-in hint is an INDICATOR only (no click handler); its state is
// driven purely by Ctrl/Cmd below. Ctrl/Cmd forces Steer while held; keyup may
// be missed when the
// window loses focus with the key down, so blur releases it too.
window.addEventListener("keydown", (e) => {
  if (e.key === "Control" || e.key === "Meta") {
    steerModifierHeld = true;
    renderSteerMode();
  }
});
window.addEventListener("keyup", (e) => {
  if (e.key === "Control" || e.key === "Meta") {
    steerModifierHeld = false;
    renderSteerMode();
  }
});
window.addEventListener("blur", () => {
  steerModifierHeld = false;
  renderSteerMode();
});
// On macOS Ctrl+click is a SECONDARY click: over a control it would pop the
// native cut/copy/paste menu and swallow the Ctrl+click. Suppress it on the UI
// chrome (buttons, cards, selects); keep it inside inputs/textarea for paste.
document.addEventListener("contextmenu", (e) => {
  const target = e.target as HTMLElement | null;
  if (!target?.closest("input, textarea")) e.preventDefault();
});

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
// Both paths are COALESCED to one measure per frame: `resizeInput` reads
// `scrollHeight` (a forced layout of the whole transcript), and a resize gesture
// fires these handlers dozens of times per second — one gesture could force
// hundreds of layouts back to back.
const resizeInputSoon = rafThrottle(resizeInput);
if (typeof ResizeObserver !== "undefined") {
  new ResizeObserver(resizeInputSoon).observe(inputEl);
}
window.addEventListener("resize", resizeInputSoon);
// Frames AND timers are throttled while the webview is hidden or occluded: when
// it comes back (or the resize ends) the buffered stream must show at once
// instead of waiting for a frame that may not come.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  flushStreamingMd();
  for (const bubble of Array.from(messagesEl.querySelectorAll(".msg.tool.subagent"))) {
    flushSubAgentMd(bubble);
  }
});
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
    // Ctrl/Cmd is a momentary override to Steer; otherwise the toggle decides.
    steerModifierHeld = steerModifierHeld || e.ctrlKey || e.metaKey;
    send();
  }
  if (e.key === "Escape") {
    // An open modal/overlay owns Esc (the LIFO dispatcher closes the top-most
    // one); it must NOT also stop the run. When no overlay is open, Esc in the
    // prompt is the Stop shortcut.
    if (anyOverlayVisible()) return;
    if (!abortBtn.disabled) vscode.postMessage({ type: "abort" });
  }
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
  if (anyOverlayVisible()) return;
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
// "Collapse all": closes every expanded section at once. The WHOLE strip
// toggles the control stack, so this click must never bubble up to it.
collapseAllBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  collapseAllSections();
  updateTranscriptActions();
  // Collapsed sections are display:none, so the transcript shrinks in one go
  // and the reading position would jump. Re-anchor only when the user was
  // already following the bottom — the same rule as the streaming auto-scroll.
  if (autoScroll) messagesEl.scrollTop = messagesEl.scrollHeight;
});
// "Autoscroll": jump back to the latest message. There is NO separate
// autoscroll state to switch on — the scroll listener above re-derives it from
// the position, so landing at the bottom resuming following is automatic.
// autoScroll is set here too so the pill disables itself immediately, without
// waiting for the scroll event to land.
autoscrollBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  autoScroll = true;
  messagesEl.scrollTop = messagesEl.scrollHeight;
  updateTranscriptActions();
});
// Any click inside the transcript can change what is expanded: the section
// headers toggle themselves and their event bubbles here AFTER their own
// handler ran, so one delegated listener keeps the tab in sync instead of
// patching all three toggle handlers.
messagesEl.addEventListener("click", updateTranscriptActions);
// Same deal for the pending list: a fold there changes what "Collapse all" would close.
pendingArea.addEventListener("click", updateTranscriptActions);
// The skills list can change at any time (npx skills add/remove): re-read it
// whenever the panel regains focus, so a removal/install shows up without a
// manual reload.
window.addEventListener("focus", () => vscode.postMessage({ type: "getSkills" }));
newSessionBtn.addEventListener("click", () => vscode.postMessage({ type: "newSession" }));
sessionHead.addEventListener("click", () => {
  setSessionsExpanded(sessionsEl.classList.contains("hidden")); // collapsed -> expand
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

// ── All-sessions manager (gear next to New session) ──
const sessionsModal = document.getElementById("sessions-modal") as HTMLDivElement;
const sessionsManagerList = document.getElementById("sessions-manager-list") as HTMLDivElement;
const sessionsCloseBtn = document.getElementById("sessions-close") as HTMLButtonElement;
const sessionsSearchInput = document.getElementById("sessions-search") as HTMLInputElement;
// DB compaction (VACUUM): the All-sessions footer controls + the shared modal.
const smVacuumThreshold = document.getElementById("sm-vacuum-threshold") as HTMLInputElement;
const smVacuumMin = document.getElementById("sm-vacuum-min") as HTMLInputElement;
const smVacuumThresholdVal = document.getElementById("sm-vacuum-threshold-val") as HTMLSpanElement;
const smVacuumMinVal = document.getElementById("sm-vacuum-min-val") as HTMLSpanElement;
const smVacuumBtn = document.getElementById("sm-vacuum-btn") as HTMLButtonElement;
const smVacuumStats = document.getElementById("sm-vacuum-stats") as HTMLDivElement;
const dbVacuumModal = document.getElementById("db-vacuum-modal") as HTMLDivElement;
const dbVacuumMsg = document.getElementById("db-vacuum-msg") as HTMLParagraphElement;
const dbVacuumStatsEl = document.getElementById("db-vacuum-stats") as HTMLDivElement;
const dbVacuumInfo = document.getElementById("db-vacuum-info") as HTMLDivElement;
const dbVacuumClose = document.getElementById("db-vacuum-close") as HTMLButtonElement;
const dbVacuumRun = document.getElementById("db-vacuum-run") as HTMLButtonElement;

/** The last full list pushed by the host (unfiltered), plus the search filter. */
let smSessions: SessionInfo[] = [];
let smCurrentFolder: string | undefined;
/** Matching session ids for the active search (null = no filter). */
let smSearchIds: Set<string> | null = null;
/** Best matching snippet per session (FTS5, `[...]` around the terms). */
let smSnippets = new Map<string, string>();

/** Renders the manage-form rows (keeps the modal's current shown/hidden state). */
function renderSessionsManagerData(data: { sessions: SessionInfo[]; currentFolder?: string; vacuum?: { stats: VacuumStats; threshold: number; minFreeMB: number } }): void {
  smSessions = data.sessions || [];
  smCurrentFolder = data.currentFolder;
  if (data.vacuum) renderSmVacuum(data.vacuum.stats, data.vacuum.threshold, data.vacuum.minFreeMB);
  renderSessionsManager();
}

// ── DB compaction (VACUUM) ──
interface VacuumStats {
  pageCount: number;
  freePages: number;
  pageSize: number;
  bytesFree: number;
  bytesTotal: number;
  ratio: number;
}

/** Human bytes: 1234567 -> "1.2 MB". */
function fmtBytes(n: number): string {
  if (n >= 1_073_741_824) return (n / 1_073_741_824).toFixed(1) + " GB";
  if (n >= 1_048_576) return (n / 1_048_576).toFixed(1) + " MB";
  if (n >= 1024) return Math.round(n / 1024) + " KB";
  return n + " B";
}

/** The free/total numbers shown in BOTH the footer and the modal. */
function vacuumStatsHtml(stats: VacuumStats | undefined): string {
  if (!stats || !stats.pageCount) return "<div>Database not available.</div>";
  const pct = Math.round(stats.ratio * 100);
  const cls = pct > 0 ? ' class="warn"' : "";
  return (
    `<div><b${cls}>${fmtBytes(stats.bytesFree)}</b> reclaimable of <b>${fmtBytes(stats.bytesTotal)}</b> (${pct}%)</div>` +
    `<div>${stats.freePages} free pages of ${stats.pageCount} total</div>`
  );
}

function renderSmVacuum(stats: VacuumStats | undefined, threshold: number, minFreeMB: number): void {
  if (threshold > 0) {
    smVacuumThreshold.value = String(threshold);
    smVacuumThresholdVal.textContent = threshold + "%";
  }
  if (minFreeMB >= 0) {
    smVacuumMin.value = String(minFreeMB);
    smVacuumMinVal.textContent = minFreeMB + " MB";
  }
  smVacuumStats.innerHTML = vacuumStatsHtml(stats);
}

let dbVacuumModalId = -1;
function openDbVacuumModal(msg: { modalId?: number; stats?: VacuumStats; threshold?: number; minFreeMB?: number }): void {
  dbVacuumModalId = typeof msg.modalId === "number" ? msg.modalId : -1;
  dbVacuumMsg.textContent =
    "The VACUUM rewrites the database to reclaim the free pages left by deleted sessions and cut conversations, and OPTIMIZES the indexes (query-planner stats + full-text segments). It runs when the chat is idle.";
  dbVacuumStatsEl.innerHTML = vacuumStatsHtml(msg.stats);
  dbVacuumInfo.innerHTML =
    `Suggests a VACUUM above <b>${msg.threshold ?? 20}%</b> when at least <b>${msg.minFreeMB ?? 128} MB</b> are reclaimable ` +
    "(change them in All sessions).";
  dbVacuumRun.disabled = false;
  dbVacuumRun.textContent = "VACUUM & optimize indexes";
  dbVacuumModal.classList.remove("hidden");
  dbVacuumRun.focus();
}

function closeDbVacuumModal(): void {
  dbVacuumModal.classList.add("hidden");
  if (dbVacuumModalId < 0) return;
  const id = dbVacuumModalId;
  dbVacuumModalId = -1;
  vscode.postMessage({ type: "modalResponse", id, value: true });
}

dbVacuumRun.addEventListener("click", () => {
  dbVacuumRun.disabled = true;
  dbVacuumRun.textContent = "Compacting & optimizing…";
  dbVacuumMsg.textContent = "Compacting & optimizing…";
  vscode.postMessage({ type: "runVacuum" });
});
dbVacuumClose.addEventListener("click", () => closeDbVacuumModal());
dbVacuumModal.querySelector(".dv-backdrop")?.addEventListener("click", () => closeDbVacuumModal());
smVacuumBtn.addEventListener("click", () => vscode.postMessage({ type: "openVacuumModal" }));
smVacuumThreshold.addEventListener("input", () => {
  smVacuumThresholdVal.textContent = smVacuumThreshold.value + "%";
});
smVacuumThreshold.addEventListener("change", () =>
  vscode.postMessage({ type: "setVacuumThreshold", percent: Number(smVacuumThreshold.value) }),
);
smVacuumMin.addEventListener("input", () => {
  smVacuumMinVal.textContent = smVacuumMin.value + " MB";
});
smVacuumMin.addEventListener("change", () => vscode.postMessage({ type: "setVacuumMinFreeMB", mb: Number(smVacuumMin.value) }));

function closeSessionsManager(): void {
  sessionsModal.classList.add("hidden");
  sessionsManagerList.innerHTML = "";
  // Reset the search so reopening the form starts from the full list.
  sessionsSearchInput.value = "";
  smSearchIds = null;
  smSnippets = new Map();
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
function renderSessionsManager(): void {
  const visible = smSearchIds ? smSessions.filter((s) => smSearchIds!.has(s.id)) : smSessions;
  sessionsManagerList.innerHTML = "";
  if (visible.length === 0) {
    const p = document.createElement("div");
    p.className = "sm-empty";
    p.textContent = smSearchIds ? "No session matches the search." : "No sessions yet.";
    sessionsManagerList.appendChild(p);
    return;
  }
  for (const s of visible) {
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
    if (sameFolder(s.folder, smCurrentFolder)) {
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
    // Why this session matched: the FTS5 snippet, matched terms in bold.
    const snippet = smSnippets.get(s.id);
    if (snippet) {
      const sn = document.createElement("div");
      sn.className = "sm-snippet";
      for (const part of snippet.split(/(\[[^\]]*\])/g)) {
        if (part.startsWith("[") && part.endsWith("]")) {
          const b = document.createElement("b");
          b.textContent = part.slice(1, -1);
          sn.appendChild(b);
        } else if (part) {
          sn.appendChild(document.createTextNode(part));
        }
      }
      main.appendChild(sn);
    }

    const actions = document.createElement("span");
    actions.className = "sm-actions";
    const folderBtn = document.createElement("button");
    folderBtn.className = "secondary-ghost folder-btn";
    // A usable folder (exists, and not the one already open) is OPENED in VS
    // Code — this changes the working directory. Otherwise the picker is the
    // only useful action: re-point a missing/unset session's folder.
    const canOpen = !!s.folder && !s.folderMissing && !sameFolder(s.folder, smCurrentFolder);
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
// Full-text search (SQLite FTS5 over messages), debounced. TWO independent
// fields: the MAIN sessions list (filtered to the current folder's sessions)
// and the all-sessions modal. `scope` routes the reply to the right one.
let smSearchTimer: number | undefined;
sessionsSearchInput.addEventListener("input", () => {
  const q = sessionsSearchInput.value.trim();
  window.clearTimeout(smSearchTimer);
  if (!q) {
    smSearchIds = null;
    smSnippets = new Map();
    renderSessionsManager();
    return;
  }
  smSearchTimer = window.setTimeout(() => vscode.postMessage({ type: "searchSessions", query: q, scope: "modal" }), 180);
});

let sessionSearchTimer: number | undefined;
sessionSearchInput.addEventListener("input", () => {
  const q = sessionSearchInput.value.trim();
  window.clearTimeout(sessionSearchTimer);
  if (!q) {
    sessionSearchIds = null;
    renderSessions(currentSessions);
    return;
  }
  sessionSearchTimer = window.setTimeout(
    () => vscode.postMessage({ type: "searchSessions", query: q, scope: "main" }),
    180,
  );
});

sessionsCloseBtn.addEventListener("click", closeSessionsManager);
sessionsModal.querySelector(".sm-backdrop")?.addEventListener("click", closeSessionsManager);

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
const peApiKeyReveal = document.getElementById("pe-apikey-reveal") as HTMLButtonElement;

/** Mask/unmask the API key field. `on` = show the plain key. */
function setApiKeyVisible(on: boolean): void {
  peApiKey.type = on ? "text" : "password";
}
// The eye reveals the key ONLY while held down (mouse, touch or pen), then
// re-masks. `preventDefault` keeps the caret in the field and avoids selecting
// the button's text.
peApiKeyReveal.addEventListener("mousedown", (e) => {
  e.preventDefault();
  setApiKeyVisible(true);
});
peApiKeyReveal.addEventListener("mouseup", () => setApiKeyVisible(false));
peApiKeyReveal.addEventListener("mouseleave", () => setApiKeyVisible(false));
peApiKeyReveal.addEventListener(
  "touchstart",
  (e) => {
    e.preventDefault();
    setApiKeyVisible(true);
  },
  { passive: false },
);
peApiKeyReveal.addEventListener("touchend", () => setApiKeyVisible(false));
window.addEventListener("blur", () => setApiKeyVisible(false));
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
// Import/export feedback: a full-width row UNDER the buttons (was a span in the
// button strip, where a long path squeezed Cancel/Save).
const providersIoResult = document.getElementById("providers-io-result") as HTMLDivElement;
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
  setApiKeyVisible(false); // always reopen masked
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
  if (!name || !providerEditorData.providers[name]) return;
  // Commit what is on screen FIRST: moving the selection must never throw away an edit that was
  // typed but not saved (it stays a draft — Cancel still discards the whole thing).
  commitProviderForm();
  loadProviderIntoForm(name);
});

providerAddBtn.addEventListener("click", () => {
  // Same rule as a selection change: the form in front of you is kept before a new entry opens.
  commitProviderForm();
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
  // The form may have RENAMED this provider: commit it so Delete hits the entry you see, not the
  // name it had before the edit.
  const name = commitProviderForm() || providerEditorSelected;
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

/**
 * Commit the FORM into the local DRAFT: no disk write, no message. Called before the selection
 * moves (another provider, + New, Delete) so a switch never throws away what was just typed — the
 * draft is what Save sends, and Cancel still discards the whole draft. Returns the name the entry
 * has after the commit, because the form can RENAME it.
 */
function commitProviderForm(): string {
  const oldName = providerEditorSelected;
  if (!oldName) return "";
  const entry = providerEditorData.providers[oldName];
  if (!entry) return oldName;
  const given = peName.value.trim() || oldName;
  if (given !== oldName) {
    delete providerEditorData.providers[oldName];
  }
  providerEditorData.providers[given] = {
    // Keys the form does not manage are CARRIED OVER untouched so a commit is
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
  providerEditorSelected = given;
  return given;
}

/** Save is the ONLY thing that writes: it commits the form, then sends the whole draft.
 * The button must not depend on the host answering (a lost reply used to leave it dead), so a
 * watchdog brings it back by itself. */
let providersSaveWatchdog = 0;
providersSaveBtn.addEventListener("click", () => {
  const name = commitProviderForm();
  if (!name) return;
  refreshProviderList(); // the form can rename the provider
  vscode.postMessage({ type: "saveProviders", data: { ...providerEditorData } });
  providersSaveBtn.disabled = true;
  window.clearTimeout(providersSaveWatchdog);
  providersSaveWatchdog = window.setTimeout(() => {
    providersSaveBtn.disabled = false;
  }, 8000);
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

type LoopGuardLevel = "off" | "low" | "medium" | "high";

/** Legacy name persisted by older sessions: read-only migration, same behaviour
 * as "medium". The host migrates it too (normalizeLoopGuardSensitivity); this
 * keeps a webview that receives a stale push on the right radio. */
function normalizeLgLevel(value: unknown): LoopGuardLevel {
  if (value === "off" || value === "low" || value === "high") return value;
  return "medium";
}

/** With the guard OFF the parameters do nothing, so they are dimmed and inert
 * (NOT hidden: hiding them would change the card's height on every level switch,
 * and the column-count measurement reads this very row). `locked` is the
 * working-run lock, which wins over everything else. */
function applyLgEnabledState(level: LoopGuardLevel, locked: boolean): void {
  const inert = locked || level === "off";
  lgResponse.disabled = inert;
  for (const el of document.querySelectorAll<HTMLInputElement>("#lg-fields input")) el.disabled = inert;
  lgFieldsEl.classList.toggle("is-off", level === "off");
}

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
  const level = (lgRadios.find((r) => r.checked)?.value ?? "medium") as LoopGuardLevel;
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
  return lgRadios.find((r) => r.checked)?.value ?? "medium";
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
  applyLgEnabledState(normalizeLgLevel(currentLgLevel()), streamingActive);
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
// Coalesced to one layout pass per frame: `layoutControlColumns` reads
// clientWidth/scrollWidth on the control cards (forced layout) on every resize
// event of the gesture.
const layoutControlColumnsSoon = rafThrottle(layoutControlColumns);
if (typeof ResizeObserver !== "undefined") new ResizeObserver(layoutControlColumnsSoon).observe(ctlCardsEl);
window.addEventListener("resize", layoutControlColumnsSoon);

function renderControl(config: ConfigState): void {
  const cap = config.maxParallelSubAgents;
  const capV = typeof cap === "number" && cap > 0 ? clampParallel(cap) : 0;
  parRange.value = String(capV);
  parValue.textContent = parLabel(capV);
  const level: LoopGuardLevel = normalizeLgLevel(config.loopGuard);
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
  // AFTER the fields exist: the OFF/lock state disables `#lg-fields input`, so it has to
  // run once they have been built (and again on every push, since a lock can be released).
  applyLgEnabledState(level, streamingActive);
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
  const target = mcpSelect.value;
  if (!mcpEditorServers[target]) return;
  // Commit what is on screen FIRST: switching server must not throw away an edit that was typed
  // but not saved (it stays a draft — Cancel still discards the whole thing). The refresh REBUILDS
  // the options, so the target has to be selected again before it is loaded.
  commitMcpForm();
  refreshMcpSelect();
  mcpSelect.value = target;
  loadMcpIntoForm(target);
});
mcpAdd.addEventListener("click", () => {
  // Same rule as a selection change: the form in front of you is kept before a new entry opens.
  commitMcpForm();
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
  // The form may have RENAMED this server: commit it so Delete hits the entry you see.
  const name = commitMcpForm() || mcpEditorSelected;
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
/**
 * Commit the FORM into the local DRAFT (no message): the same rule as the providers editor — a
 * selection change, + New or Delete must not silently drop what was just typed. Returns the name
 * the entry has after the commit, because the form can RENAME it.
 */
function commitMcpForm(): string {
  const old = mcpEditorSelected;
  const name = mcpName.value.trim() || old;
  if (!name) return "";
  if (old && name !== old) delete mcpEditorServers[old];
  mcpEditorServers[name] = mcpFormServer();
  mcpEditorSelected = name;
  return name;
}

mcpSave.addEventListener("click", () => {
  const old = mcpEditorSelected;
  const name = mcpName.value.trim() || old;
  if (old && name !== old) delete mcpEditorServers[old];
  if (name) mcpEditorServers[name] = mcpFormServer();
  mcpEditorSelected = name;
  vscode.postMessage({ type: "saveMcpServers", servers: mcpEditorServers });
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

/** Back to the live edge and back into the prompt.
 *
 * Typing while the agent works (a queue, a steer), converting one into the other,
 * cancelling one: every one of those is the user talking ABOUT the run in progress. Each
 * moves the pending footer or the transcript — a place the reader is not looking at if
 * they scrolled away — so the view returns to following, and the caret returns where the
 * next keystroke belongs. */
function followAndFocus(): void {
  autoScroll = true;
  scrollDown();
  updateTranscriptActions();
  focusPrompt();
}

function setStreaming(active: boolean): void {
  const rising = active && !streamingActive;
  streamingActive = active;
  if (rising) {
    // The policies of THIS run are the ones on screen at this instant (see Agent.runMode).
    // This snapshot is the safety net: the two pills are disabled below, so a change can only
    // arrive from OUTSIDE the panel (a config push, another window) — and when it does, the
    // run keeps these and the pill marks the new choice as pending (see refreshPolicyHints).
    runModeAtStart = currentMode;
    runParallelAtStart = parallelOn;
    // The play button + Working bar start harny-pulse now: this becomes the
    // shared clock the area border pulses lock onto.
    pulseClockStart = performance.now();
    // …and everything ALREADY pulsing must re-join this cycle. The Working bar is created a
    // line before this call (addWorking) and was locked against the PREVIOUS clock, so
    // without this the bar and a bubble born later beat on different phases — exactly what
    // "compacting and working pulse out of sync" looked like.
    for (const el of document.querySelectorAll<HTMLElement>(
      ".working, #working-bar, .msg.assistant.streaming, .thinking-block.streaming, .subagent-running",
    )) {
      phaseLockPulse(el);
    }
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
    ? "Enter to send · Ctrl/Cmd = Steer · Esc to stop"
    : "Ask Harny... (Enter to send, Esc to abort)";
  renderSteerMode();
  // A run that starts WITHOUT the optimistic send path (e.g. a queued message
  // the host dispatched, or switching to a session that is working) must still
  // show the working bar — it is the only progress indicator for those runs.
  if (active && !workingEl) addWorking();
  compactBtn.disabled = active;
  compactSettingsBtn.disabled = active;
  modelBtn.disabled = active;
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
  // OFF or a live run: the parameters and "Include response" are inert (dimmed by the
  // global input:disabled rule) — the GLOBAL lock has to re-apply them on release.
  applyLgEnabledState(normalizeLgLevel(currentLgLevel()), active);
  inputEl.disabled = false;
  // Mode and Parallel are LOCKED while the session works, exactly like the request
  // parameters: they are decided once per run (see Agent.runMode) — a run is born with its
  // mode and its Parallel setting and keeps them to its last tool result — so a switch cannot
  // reach it, and offering one would promise something that does not happen. They are never
  // locked SILENTLY, though: their tooltip names the policy the run is using and says when a
  // change would land (see refreshPolicyHints). The silent lock is what made this row lie
  // before, and the answer to that is to say it, not to hide it. A dropdown left open is
  // closed too, so the label on screen is never the one that was already sent.
  modeBtn.disabled = active;
  parallelBtn.disabled = active;
  if (active && !modeMenu.classList.contains("hidden")) closeModeMenu();
  if (!active) {
    // The run is over: what the panel holds is this session's policy again.
    runModeAtStart = null;
    runParallelAtStart = null;
  }
  refreshPolicyHints();
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
/** The policies the RUN IN FLIGHT was born with (null = no run running).
 *
 * Mode and Parallel are decided ONCE per run (see `Agent.runMode`): they are safety
 * promises, not preferences — "Analyze" means nothing is written — so a click while a run
 * works cannot reach it. The click is still ACCEPTED (swallowing it is how the panel used
 * to lie: it showed one thing and the run did another) and becomes the NEXT run's policy,
 * which is what the dashed pill and its tooltip say. */
let runModeAtStart: ChatMode | null = null;
let runParallelAtStart: boolean | null = null;
/** Highest config sequence applied: older async config pushes are IGNORED, so a
 * slow response can never clobber the current mode/controls with a stale one. */
let lastConfigSeq = -1;
/** Last `switchView` applied (see the stale-switch guard). */
let lastSwitchSeq = 0;

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
  refreshPolicyHints();
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
  refreshPolicyHints();
}

/** The panel is now following a DIFFERENT run (a session switch): a snapshot taken for the
 * previous one cannot describe this one, so it is re-read from what is on screen — the mode
 * and Parallel the host has just pushed for the session switched TO. */
function resetPolicySnapshot(): void {
  runModeAtStart = streamingActive ? currentMode : null;
  runParallelAtStart = streamingActive ? parallelOn : null;
  refreshPolicyHints();
}

/** What the two behaviour pills say while a run works — the ONLY feedback they can give,
 * since they are disabled (see setStreaming). A disabled control is not a SILENT one only if
 * it explains itself, so the tooltip names the policy the run is locked to and the one way to
 * stop now (Stop). The pending branch is the safety net for a policy changed UNDER the panel
 * while it works (a config push, another window): the choice is then real and pending, the
 * run keeps what it was born with, and the pill says both. Colours carry none of this. */
function refreshPolicyHints(): void {
  const runMode = runModeAtStart;
  const modePending = runMode !== null && currentMode !== runMode;
  modeBtn.classList.toggle("is-pending", modePending);
  if (modePending) {
    const wanted = currentMode === "agent" ? "Build" : "Analyze";
    const running = runMode === "agent" ? "Build" : "Analyze";
    modeBtn.title = `${wanted} — applies to the NEXT run: this one is still ${running}. Stop to stop now.`;
  } else if (runMode !== null) {
    const running = runMode === "agent" ? "Build" : "Analyze";
    modeBtn.title = `${running} — locked to this run: a switch now applies to the NEXT one. Stop to stop now.`;
  } else {
    modeBtn.removeAttribute("title");
  }
  const runParallel = runParallelAtStart;
  const parallelPending = runParallel !== null && parallelOn !== runParallel;
  parallelBtn.classList.toggle("is-pending", parallelPending);
  if (parallelPending) {
    const wanted = parallelOn ? "ON" : "OFF";
    const running = runParallel ? "ON" : "OFF";
    parallelBtn.title = `Parallel ${wanted} — applies to the NEXT run: this one is still ${running}. Stop to stop now.`;
  } else if (runParallel !== null) {
    const running = runParallel ? "ON" : "OFF";
    parallelBtn.title = `Parallel ${running} — locked to this run: a switch now applies to the NEXT one. Stop to stop now.`;
  } else {
    parallelBtn.removeAttribute("title");
  }
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

/** The current model config, kept so the modal can re-render on filter. */
let modelConfig: ConfigState | null = null;
let modelFilter = "";

interface ModelEntry { model: string; contextLength?: number; maxOutputTokens?: number; }
interface ModelGroup { provider: string; models: ModelEntry[]; error?: string; }

/** " · 128k · out 16k" — a limit the host/catalog did not report shows as "-". */
function modelLimitsLabel(m?: { contextLength?: number; maxOutputTokens?: number }): string {
  const ctx = m?.contextLength ? formatContext(m.contextLength) : "-";
  const out = m?.maxOutputTokens ? formatContext(m.maxOutputTokens) : "-";
  return ` · ${ctx} · out ${out}`;
}

/**
 * Group the provider/model pairs (or the flat model list) into the TREE the
 * modal shows: a provider header + its models, plus host-unreachable errors.
 */
function buildModelGroups(c: ConfigState): ModelGroup[] {
  const providerModels = c.providerModels && c.providerModels.length > 0 ? c.providerModels : null;
  if (providerModels) {
    const map = new Map<string, ModelEntry[]>();
    for (const pm of providerModels) {
      if (!map.has(pm.provider)) map.set(pm.provider, []);
      map.get(pm.provider)!.push({ model: pm.model, contextLength: pm.contextLength, maxOutputTokens: pm.maxOutputTokens });
    }
    const groups: ModelGroup[] = [...map.entries()].map(([provider, models]) => ({
      provider,
      models: [...models].sort((a, b) => a.model.localeCompare(b.model)),
    }));
    // Failed host fetches: the provider still APPEARS with the error.
    for (const err of c.hostModelErrors ?? []) {
      const message = err.error || "GET /v1/models failed";
      const g = groups.find((x) => x.provider === err.provider);
      if (g) g.error = message;
      else groups.push({ provider: err.provider, models: [], error: message });
    }
    return groups.sort((a, b) => a.provider.localeCompare(b.provider));
  }
  const models = (c.models && c.models.length > 0 ? [...c.models] : c.model ? [c.model] : []).sort();
  return models.length > 0 ? [{ provider: "", models: models.map((m) => ({ model: m })) }] : [];
}

/** Update the selector BUTTON label (current model + its context window).
 * A saved model that is NO LONGER served falls back to the placeholder. */
function updateModelButton(c: ConfigState): void {
  const providerModels = c.providerModels && c.providerModels.length > 0 ? c.providerModels : null;
  const known = providerModels
    ? providerModels.some((p) => p.model === c.model)
    : new Set(c.models || []).has(c.model);
  const usable = !!c.model && known;
  const current =
    providerModels?.find((p) => p.model === c.model && (p.provider === c.activeProvider || !c.activeProvider)) ??
    providerModels?.find((p) => p.model === c.model);
  modelBtnLabel.textContent = usable ? c.model + modelLimitsLabel(current) : "Select a model";
  modelBtn.classList.toggle("placeholder", !usable);
  modelBtn.title = usable ? `Switch model — current: ${c.model}` : "Select a model";
  // A soft ⚠ badge when the models.dev fallback is down (limits may be unknown).
  modelWarn.classList.toggle("hidden", !c.modelsDevError);
}

/** Re-render the modal's grouped list, applying the current filter. The TREE
 * is preserved: only matching models remain, empty providers drop out. */
function renderModelList(): void {
  modelListEl.innerHTML = "";
  if (!modelConfig) return;
  // Soft warning row: the models.dev fallback is unreachable (shown only when a
  // limit is actually missing — the host decides).
  mmModelsDevWarn.classList.toggle("hidden", !modelConfig.modelsDevError);
  const filter = modelFilter.trim().toLowerCase();
  let shown = 0;
  for (const g of buildModelGroups(modelConfig)) {
    const providerMatch = !!filter && g.provider.toLowerCase().includes(filter);
    const models = filter && !providerMatch ? g.models.filter((m) => m.model.toLowerCase().includes(filter)) : g.models;
    const showError = !!g.error && (!filter || providerMatch);
    if (models.length === 0 && !showError) continue;
    shown++;
    const head = document.createElement("div");
    head.className = "mm-provider";
    head.textContent = g.provider || "Models";
    if (models.length > 0) {
      const count = document.createElement("span");
      count.className = "mm-count";
      count.textContent = String(models.length);
      head.appendChild(count);
    }
    modelListEl.appendChild(head);
    for (const m of models) {
      const isCurrent =
        m.model === modelConfig.model && (g.provider === modelConfig.activeProvider || !modelConfig.activeProvider);
      const row = document.createElement("button");
      row.type = "button";
      row.className = "mm-model" + (isCurrent ? " is-current" : "");
      const name = document.createElement("span");
      name.className = "mm-model-name";
      name.textContent = m.model;
      row.appendChild(name);
      // Two value cells (context | output), each right-aligned in its own SHARED
      // subgrid column (so they line up across rows), plus a fixed "out" label;
      // an unknown limit shows "-".
      const ctxValue = document.createElement("span");
      ctxValue.className = "mm-ctx mm-ctx-value";
      ctxValue.textContent = m.contextLength ? formatContext(m.contextLength) : "-";
      row.appendChild(ctxValue);
      const outLabel = document.createElement("span");
      outLabel.className = "mm-ctx mm-out-label";
      outLabel.textContent = "out";
      row.appendChild(outLabel);
      const outValue = document.createElement("span");
      outValue.className = "mm-ctx mm-out-value";
      outValue.textContent = m.maxOutputTokens ? formatContext(m.maxOutputTokens) : "-";
      row.appendChild(outValue);
      // ALWAYS render the check cell (empty when not current) so the context and
      // output columns stay aligned across every row.
      const check = document.createElement("span");
      check.className = "mm-check";
      check.textContent = isCurrent ? "✓" : "";
      row.appendChild(check);
      row.addEventListener("click", () => selectModel(m.model, g.provider || undefined));
      modelListEl.appendChild(row);
    }
    if (showError) {
      const err = document.createElement("div");
      err.className = "mm-error";
      err.textContent = "⚠️ " + g.error + " — host unreachable";
      modelListEl.appendChild(err);
    }
  }
  if (shown === 0) {
    const p = document.createElement("div");
    p.className = "mm-empty";
    p.textContent = modelFilter ? "No model matches the search." : "No models available.";
    modelListEl.appendChild(p);
  }
}

/** Selecting a model posts `setModel` and closes the modal. */
function selectModel(model: string, provider?: string): void {
  const message: Record<string, unknown> = { type: "setModel", model };
  if (provider) message.provider = provider;
  vscode.postMessage(message);
  closeModelModal();
  focusPrompt();
}

function openModelModal(): void {
  if (modelBtn.disabled) return;
  modelFilter = "";
  modelSearchInput.value = "";
  renderModelList();
  modelModal.classList.remove("hidden");
  modelSearchInput.focus();
  // Refresh the provider list on open (a host started later shows up).
  vscode.postMessage({ type: "getConfig" });
}

function closeModelModal(): void {
  modelModal.classList.add("hidden");
  modelFilter = "";
  modelSearchInput.value = "";
}

/** Config push: update the button label and, if the modal is open, its list. */
function renderModelSelect(c: ConfigState): void {
  modelConfig = c;
  updateModelButton(c);
  if (!modelModal.classList.contains("hidden")) renderModelList();
}
// The model selector BUTTON opens the filterable modal (no native dropdown).
modelBtn.addEventListener("click", openModelModal);
document.getElementById("model-close")?.addEventListener("click", closeModelModal);
modelModal.querySelector(".mm-backdrop")?.addEventListener("click", closeModelModal);
modelSearchInput.addEventListener("input", () => {
  modelFilter = modelSearchInput.value;
  renderModelList();
});
// Keyboard: from the filter, ArrowDown jumps into the list; Esc closes.
modelSearchInput.addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown") {
    e.preventDefault();
    modelListEl.querySelector<HTMLButtonElement>(".mm-model")?.focus();
  }
});
// In the list: ArrowUp/Down move the focus, Enter selects (native button), Esc closes.
modelListEl.addEventListener("keydown", (e) => {
  const row = (e.target as HTMLElement)?.closest<HTMLButtonElement>(".mm-model");
  if (!row) return;
  const rows = [...modelListEl.querySelectorAll<HTMLButtonElement>(".mm-model")];
  const i = rows.indexOf(row);
  if (e.key === "ArrowDown") {
    e.preventDefault();
    rows[Math.min(rows.length - 1, i + 1)]?.focus();
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    if (i <= 0) modelSearchInput.focus();
    else rows[i - 1]?.focus();
  } else if (e.key === "Escape") {
    e.preventDefault();
    closeModelModal();
    focusPrompt();
  }
});

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
// The slider MAXIMUM follows the model: its DETECTED window when known, else the
// global ceiling — so you can only DECREASE the value, never exceed the model.
let currentCtxMax = MAX_CONTEXT_WINDOW;
let currentOutMax = MAX_OUTPUT_TOKENS;

/**
 * A step that makes `max` REACHABLE: the nominal step when it divides the range
 * (nice snapping), otherwise 1. A step that does not divide made the thumb stop
 * just short of a model's detected maximum (e.g. max 7 963 with step 256).
 */
function reachableStep(min: number, max: number, nominal: number): number {
  const span = max - min;
  return span > 0 && span % nominal === 0 ? nominal : 1;
}

function sendContextWindow(value: number): void {
  const v = clampContextWindow(value, currentCtxMax);
  ctxRange.value = String(v);
  ctxValue.textContent = String(v);
  vscode.postMessage({ type: "setContextWindow", value: v });
}

/** Show a host-pushed window value: the LABEL keeps the exact value while the
 * slider sits on the nearest step (dragging afterwards moves by steps). */
function renderContextWindow(c: ConfigState): void {
  currentCtxMax = c.maxContextWindow ?? MAX_CONTEXT_WINDOW;
  ctxRange.max = String(currentCtxMax);
  ctxRange.step = String(reachableStep(MIN_CONTEXT_WINDOW, currentCtxMax, 1000));
  ctxRangeLabel.textContent = `(${formatContext(MIN_CONTEXT_WINDOW)} → ${formatContext(currentCtxMax)})`;
  const v = clampContextWindow(c.contextWindow || DEFAULT_CONTEXT_WINDOW, currentCtxMax);
  ctxRange.value = String(v);
  ctxValue.textContent = String(v);
}

// ── Output-tokens slider (max tokens per response) ──
function sendOutputTokens(value: number): void {
  const v = clampOutputTokens(value, currentOutMax);
  outRange.value = String(v);
  outValue.textContent = String(v);
  vscode.postMessage({ type: "setOutputTokens", value: v });
}

function renderOutputTokens(c: ConfigState): void {
  currentOutMax = c.maxOutputTokens ?? MAX_OUTPUT_TOKENS;
  outRange.max = String(currentOutMax);
  outRange.step = String(reachableStep(MIN_OUTPUT_TOKENS, currentOutMax, 256));
  outRangeLabel.textContent = `(${formatContext(MIN_OUTPUT_TOKENS)} → ${formatContext(currentOutMax)})`;
  const v = clampOutputTokens(c.outputTokens ?? DEFAULT_OUTPUT_TOKENS, currentOutMax);
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

/**
 * The sampler slider's SCALE follows the selected radio: Temperature spans
 * 0.0–2.0, Top-P spans 0.0–1.0. Re-adapting on every switch keeps the WHOLE
 * track usable (a fixed 0–2 max made Top-P use only half of it).
 */
function applySamplerScale(active: "temperature" | "topP"): void {
  const max = active === "topP" ? 1 : TEMPERATURE_MAX;
  sampRange.min = String(TEMPERATURE_MIN);
  sampRange.max = String(max);
  sampRange.step = String(TEMPERATURE_STEP);
  sampRangeLabel.textContent = `(${TEMPERATURE_MIN.toFixed(1)} → ${max.toFixed(1)})`;
}

/** Sampler radios: brand the active option; show its value in the shared stepper. */
function renderSamplerControl(c: ConfigState): void {
  const active = c.sampler === "topP" ? "topP" : "temperature"; // default = temperature
  samplerTemp.checked = active === "temperature";
  samplerTopp.checked = active === "topP";
  applySamplerScale(active);
  samplerControl.render(active === "topP" ? c.topP : c.temperature);
}

samplerTemp.addEventListener("change", () => {
  applySamplerScale("temperature");
  vscode.postMessage({ type: "setSamplerMode", mode: "temperature" });
});
samplerTopp.addEventListener("change", () => {
  applySamplerScale("topP");
  vscode.postMessage({ type: "setSamplerMode", mode: "topP" });
});

const presenceControl = createFloatControl({ range: "presence-range", value: "presence-value", auto: "presence-auto" }, "setPresencePenalty", clampTemperature, 0);
const freqControl = createFloatControl({ range: "freq-range", value: "freq-value", auto: "freq-auto" }, "setFrequencyPenalty", clampTemperature, 0);

/** Compact token counts: 12345 -> "12.3k", 2000000 -> "2M". */
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, "") + "k";
  return String(n);
}

function renderMetrics(c: ConfigState): void {
  const window = clampContextWindow(c.contextWindow || DEFAULT_CONTEXT_WINDOW);
  // The base of the bar is the USABLE budget, not the raw window: the provider
  // counts `input + max_tokens` against the window, so only `window − reserve`
  // is reachable by the input. Measured against the window the bar showed 66%
  // while the request was already being rejected; against the usable budget the
  // same state reads 100% — which is the truth that matters.
  const ctx = c.contextUsable && c.contextUsable > 0 ? c.contextUsable : window;
  const reserve = Math.max(0, window - ctx);
  const used = c.contextTokens ?? 0;
  metCtx.textContent = fmtTokens(ctx);
  metTokens.textContent = fmtTokens(used);
  // Exact counts stay reachable via the tooltip.
  metTokens.title = String(used);
  metCtx.title = reserve
    ? `${fmtTokens(window)} context window − ${fmtTokens(reserve)} reserved for the response = ${fmtTokens(ctx)} usable tokens`
    : `${window} context window (no response reserve)`;
  // The declared window, attached to the usable value with no connector words:
  // "663.3k / 616k/1M (100%)". Most contracted form that still says where the
  // usable number comes from — without it the footer shows "616k" with no trace
  // of the 1M the model card promises. The full breakdown (and the 384k reserve
  // that explains the gap) stays in the tooltip.
  metWindow.textContent = reserve > 0 ? `/${fmtTokens(window)}` : "";
  metWindow.title = reserve > 0
    ? `${window} context window − ${reserve} reserved for the response = ${ctx} usable tokens`
    : "";
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

/** Keep the label between Compact and the gear in sync. "Auto" is the TRIGGER (the automatic
 * compaction), never the landing point: that one is just how much survives the cut. */
function renderCompactionThreshold(): void {
  compactThresholdLabel.textContent =
    "Auto " + compactionThresholdPct + "% ctx · keep " + compactionTargetPct + "%";
}

// ── Compaction policy (gear next to Compact): trigger % + landing point ──
/** Clamp/round a typed threshold % into 1–100 (invalid -> default 80). */
function clampCompactionThreshold(raw: string): number {
  const v = Number.parseInt(raw, 10);
  if (!Number.isFinite(v)) return 80;
  return Math.min(100, Math.max(1, Math.round(v)));
}
/** AUTO: an EIGHTH of the trigger — the same rule the host applies (a share of the window,
 * not a token count). With the default 80% trigger that is 10%. */
function autoTargetFor(threshold: number): number {
  return Math.max(1, Math.round(Math.max(1, threshold) / 8));
}
/** AUTO clamped under the trigger. The derived FLOOR does not apply to it: Auto is a default,
 * not a choice, and the planner keeps at least one complete turn whatever the number says. */
function clampAutoTarget(threshold: number): number {
  return Math.min(autoTargetFor(threshold), Math.max(0, threshold - 1));
}
/** Put a slider position into the positions the session can actually use: `0`, or
 * `floor … trigger−1`. 0 is a REAL choice — "only the summary remains" — and 1 … floor−1
 * free nothing more than it, so they collapse to 0. */
function clampCompactionTarget(raw: number, threshold: number, floor: number): number {
  const v = Math.round(raw);
  if (!Number.isFinite(v)) return clampAutoTarget(threshold);
  const max = Math.max(0, threshold - 1);
  if (v <= 0 || v < floor || floor > max) return 0;
  return Math.min(max, v);
}

/** Ask the host for the plan its OWN functions produce (the preview must not guess). */
const sendCompactionPreview = rafThrottle(() => {
  const threshold = clampCompactionThreshold(compactThresholdInput.value);
  vscode.postMessage({
    type: "previewCompaction",
    thresholdPercent: threshold,
    targetPercent: clampCompactionTarget(
      Number(compactTargetInput.value),
      threshold,
      compactionTargetFloorPct,
    ),
  });
});

/** Render the plan the host computed: counts and tokens, never a promise it cannot keep. */
function renderCompactionPreview(p: {
  thresholdPercent?: number;
  targetPercent?: number;
  minTargetPercent?: number;
  autoTargetPercent?: number;
  usableTokens?: number;
  targetTokens?: number;
  fillTokens?: number;
  fillPercent?: number;
  aboveThreshold?: boolean;
  summarizeCount?: number;
  summarizeTokens?: number;
  keepCount?: number;
  keepTokens?: number;
  summaryBudgetTokens?: number;
  deferredCount?: number;
}): void {
  // The DERIVED floor travels with every answer: it is what the form must mark as the
  // smallest explicit value, and it moves with the session's own work.
  if (typeof p?.minTargetPercent === "number") {
    compactionTargetFloorPct = Math.max(1, p.minTargetPercent);
    syncTargetBounds();
  }
  const fmt = (n?: number): string => {
    const v = typeof n === "number" ? n : 0;
    return v >= 1000 ? Math.round(v / 1000) + "k" : String(v);
  };
  if (!p?.aboveThreshold) {
    compactPreview.textContent =
      "Nothing to compact yet: " +
      (p?.fillPercent ?? 0) +
      "% of " +
      fmt(p?.usableTokens) +
      " usable (trigger " +
      (p?.thresholdPercent ?? 0) +
      "%).";
    return;
  }
  const lines = [
    "Next compaction · now " + (p.fillPercent ?? 0) + "% (" + fmt(p.fillTokens) + " of " + fmt(p.usableTokens) + ")",
    (p.summarizeCount ?? 0) +
      " message(s) → summary (reads " +
      fmt(p.summarizeTokens) +
      ", writes ≤" +
      fmt(p.summaryBudgetTokens) +
      ")",
    (p.keepCount ?? 0) + " kept verbatim (~" + fmt(p.keepTokens) + ")",
    "Lands at ~" + fmt(p.targetTokens) + " (" + (p.targetPercent ?? 0) + "% of the usable context)",
  ];
  if ((p.deferredCount ?? 0) > 0) {
    lines.push(
      (p.deferredCount ?? 0) +
        " older message(s) cannot be read in one request: they stay in the transcript, unsummarized",
    );
  }
  lines.push(
    "Auto = " +
      (p.autoTargetPercent ?? autoTargetFor(p.thresholdPercent ?? compactionThresholdPct)) +
      "% · smallest explicit = " +
      (p.minTargetPercent ?? compactionTargetFloorPct) +
      "%",
  );
  compactPreview.textContent = lines.join("\n");
}

function syncTargetBounds(): void {
  const threshold = clampCompactionThreshold(compactThresholdInput.value);
  // 0 is a real position; the ceiling is the trigger minus one (derived from the other knob).
  compactTargetInput.min = "0";
  compactTargetInput.max = String(Math.max(0, threshold - 1));
  // The knob shows the EFFECTIVE landing point: Auto is a MODE (the button), not a position.
  compactTargetInput.value = String(
    draftTargetIsAuto ? clampAutoTarget(threshold) : draftTargetPct,
  );
}

/** Keep both value labels in sync (a slider carries no text of its own). */
function renderCompactionValues(): void {
  compactThresholdValue.textContent = draftThresholdPct + "%";
  compactTargetValue.textContent = draftTargetIsAuto
    ? "" + clampAutoTarget(draftThresholdPct) + "% (default)"
    : draftTargetPct + "%" + (draftTargetPct === 0 ? " (min)" : "");
}

function openCompactionSettings(): void {
  // A FRESH draft from what the host confirmed: the modal always opens on the STORED policy,
  // never on the leftovers of a Cancel.
  draftThresholdPct = compactionThresholdPct;
  draftTargetPct = compactionTargetPct;
  draftTargetIsAuto = compactionTargetIsAuto;
  compactThresholdInput.value = String(draftThresholdPct);
  syncTargetBounds();
  renderCompactionValues();
  compactTargetAuto.classList.toggle("is-on", draftTargetIsAuto);
  compactPreview.textContent = "";
  compactSettingsModal.classList.remove("hidden");
  // The preview is the HOST's plan — and it carries the derived floor with it.
  sendCompactionPreview();
  compactThresholdInput.focus();
}

/** Hide the modal. This is ALL Cancel does: nothing was written, so nothing has to be undone —
 * the draft is simply dropped and the next open takes a fresh copy of the stored policy. */
function closeCompactionSettings(): void {
  compactSettingsModal.classList.add("hidden");
}

compactSettingsBtn.addEventListener("click", openCompactionSettings);
compactSettingsCancel.addEventListener("click", closeCompactionSettings);
compactSettingsModal.querySelector(".cs-backdrop")?.addEventListener("click", closeCompactionSettings);
// Moving the trigger moves the AUTO value with it AND the ceiling of an explicit one.
// Everything below mutates the DRAFT: the stored policy does not move until Save.
compactThresholdInput.addEventListener("input", () => {
  draftThresholdPct = clampCompactionThreshold(compactThresholdInput.value);
  if (!draftTargetIsAuto) {
    draftTargetPct = Math.min(draftTargetPct, Math.max(1, draftThresholdPct - 1));
  }
  syncTargetBounds();
  renderCompactionValues();
  sendCompactionPreview();
});
// The landing slider: every position is a decision, and 0 IS a position (the minimum).
compactTargetInput.addEventListener("input", () => {
  const threshold = clampCompactionThreshold(compactThresholdInput.value);
  draftTargetIsAuto = false;
  draftTargetPct = clampCompactionTarget(
    Number(compactTargetInput.value),
    threshold,
    compactionTargetFloorPct,
  );
  compactTargetAuto.classList.remove("is-on");
  syncTargetBounds();
  renderCompactionValues();
  sendCompactionPreview();
});
compactTargetAuto.addEventListener("click", () => {
  draftTargetIsAuto = true;
  draftTargetPct = clampAutoTarget(clampCompactionThreshold(compactThresholdInput.value));
  compactTargetAuto.classList.add("is-on");
  syncTargetBounds();
  renderCompactionValues();
  sendCompactionPreview();
});
compactSettingsSave.addEventListener("click", () => {
  const threshold = clampCompactionThreshold(compactThresholdInput.value);
  // AUTO FOLLOWS the trigger: when it is in force the landing point is derived from the value
  // being saved, not from whatever the slider happened to show before.
  const target = draftTargetIsAuto
    ? clampAutoTarget(threshold)
    : clampCompactionTarget(Number(compactTargetInput.value), threshold, compactionTargetFloorPct);
  // THE COMMIT: the draft becomes the live policy — the footer label, the next open and the
  // payload the host stores all read these three from here on.
  compactionThresholdPct = threshold;
  compactionTargetPct = target;
  compactionTargetIsAuto = draftTargetIsAuto;
  renderCompactionThreshold();
  vscode.postMessage({ type: "setCompactionThreshold", value: threshold });
  // A MISSING value is what CLEARS the override (Auto); 0 is an explicit "only the summary".
  vscode.postMessage({ type: "setCompactionTarget", value: compactionTargetIsAuto ? undefined : target });
  closeCompactionSettings();
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
  // STREAMED messages say WHICH session they belong to. A delta of the session you
  // just switched TO can arrive before its `switchView` (the switch awaits a config
  // build), and it must never be drawn into the tab you are leaving. Dropping it
  // loses nothing: the switchView replays that session's whole live turn.
  if (typeof msg?.sessionId === "string" && msg.sessionId !== activeId) return;
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
        // `push`/`paint` scrolls: scrolling HERE would force one extra layout
        // per delta, even when the coalescer did not paint at all.
        answerMd.push(resultEl, () => currentRawText);
      }
      break;
    }
    case "thinkingDelta": {
      // Empty thinking chunks must not create an empty thinking block.
      if (!msg.content) break;
      if (!currentThinkingBlock) {
        // A reasoning phase BEFORE the answer opens its own block (the common case:
        // reason, then answer) and the answer that follows gets its own bubble.
        // One that arrives DURING the answer is a different thing: closing the bubble
        // there cuts the sentence in two, and the continuation reads like a response
        // that lost its beginning (the model reasoned mid-sentence). So the answer
        // keeps ONE bubble and the reasoning becomes a collapsible line just ABOVE
        // it — where the model actually paused — with the text continuing below.
        const duringAnswer = Boolean(currentResultEl && currentRawText.trim());
        flushStreamingMd();
        if (duringAnswer) {
          currentThinkingBlock = addThinkingBlock("", currentResultEl, { label: "💭 Thought during this answer" });
          currentThinkingText = "";
          // NOTE: the bubble is NOT closed and `currentRawText` is NOT reset: the
          // next deltas repaint the SAME bubble with the whole answer.
        } else {
          currentThinkingBlock = addThinkingBlock("");
          currentThinkingText = "";
          clearStreamingBubble();
          currentRawText = "";
        }
      }
      if (currentThinkingBlock) {
        currentThinkingText += msg.content;
        const body = currentThinkingBlock.querySelector(".thinking-body");
        // `push`/`paint` scrolls (see the answer path).
        if (body) thinkingMd.push(body, () => currentThinkingText);
      }
      break;
    }
    case "turnMeta":
      // A turn just ended: append its REAL metrics badge at the end of the
      // transcript (no re-render).
      appendTurnBadge(msg.meta as MsgMeta);
      break;
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
        // The nested live log ends here: paint its buffered chunk BEFORE the
        // final report lands below it.
        if (isSubAgent) flushSubAgentMd(el);
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
      ensureCompactionBubble();
      break;
    }
    case "compactDone": {
      if (compactionEl) {
        if (msg.ok) {
          // Should not normally happen (a real compaction wiped this bubble with the
          // rebuild), but if it does, keep it truthful.
          makeThinkingBlock("🧹 Conversation compacted.", "The summary now opens the context window.", compactionEl);
        } else {
          // Nothing was moved: the provisional bubble must not claim it was.
          compactionEl.remove();
        }
        compactionEl = null;
      }
      // A real compaction leaves its card at the HEAD of the window (see addCompactedHint).
      if (msg.ok) addCompactedHint();
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
    case "pending": {
      const items = (msg.items as PendingViewItem[]) || [];
      pending.render(items);
      // A CHANGE in the footer — one added, one cancelled, one converted — is the user
      // acting on the run in progress: go back to the live edge and into the prompt. The
      // FIRST render only primes the baseline: on reload the host re-pushes the list, and
      // following the footer there would fight the restored reading position.
      const ids = items.map((i) => `${i.id}:${i.mode}`).join("|");
      if (pendingSnapshot !== null && ids !== pendingSnapshot) followAndFocus();
      pendingSnapshot = ids;
      break;
    }
    case "userMessage": {
      // A QUEUED message just started running. The view never appended its bubble
      // when it was typed (it waited in the pending footer) and the host owns
      // that list, so the host tells the view to show it now. No cut key here:
      // the end-of-run refresh rebuilds the transcript and attaches it.
      addMessage("user", String(msg.content || ""), msg.attachments, msg.images);
      scrollDown();
      break;
    }
    case "steerApplied": {
      // The soft-steer message reached a turn boundary: show it as a real user
      // bubble now (the end-of-run refresh rebuilds the transcript anyway).
      // The attachments ride along: without them the files reached the model but
      // the bubble showed the text only.
      const el = addMessage("user", String(msg.content || ""), msg.attachments, msg.images);
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
      // Capture the reading position BEFORE the wipe: without it the rebuild lands at
      // the same pixel offset in a DIFFERENT transcript (see captureScrollAnchor).
      const anchor = captureScrollAnchor();
      // Sections survive the rebuild too (the ANCHOR below owns the scroll): folding
      // everything back on every run-end refresh is the same loss as on a switch.
      stashViewMemory(activeId);
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
      // A refresh can land MID-RUN (a compaction, a ✂ cut, a new model): the turn
      // still streaming is not in the committed messages, so rebuilding from them
      // alone would drop the answer being written — and the deltas that follow
      // would start a NEW bubble mid-word. The host sends its live text along; put
      // it back before anything else touches the transcript.
      restoreLiveStream(msg);
      // A refresh (e.g. after a ✂ cut) rebuilds the transcript: return the caret
      // to the prompt so the user can keep typing from the clean point.
      if (Array.isArray(msg.skills)) renderSkills(msg.skills);
      // Open sections back, scroll NOT (the anchor below is authoritative there).
      restoreViewMemory(activeId, false);
      // The content is settled: put the reader back where they were.
      restoreScrollAnchor(anchor);
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
      } else if (msg.kind === "dbVacuum") {
        openDbVacuumModal(msg);
      }
      break;
    }
    case "dbVacuumRunning":
      dbVacuumMsg.textContent = "Waiting for the chat to be idle…";
      break;
    case "dbVacuumSkipped":
      // The host refused to run the synchronous VACUUM over a live session.
      dbVacuumMsg.textContent =
        "Still working: the VACUUM was not run. Stop the run (or close other sessions) and try again.";
      dbVacuumRun.disabled = false;
      dbVacuumRun.textContent = "VACUUM & optimize indexes";
      break;
    case "dbVacuumSettings":
      smVacuumThreshold.value = String(msg.threshold);
      smVacuumThresholdVal.textContent = msg.threshold + "%";
      smVacuumMin.value = String(msg.minFreeMB);
      smVacuumMinVal.textContent = msg.minFreeMB + " MB";
      break;
    case "dbVacuumResult": {
      const r = msg.result as { vacuumed: boolean; before: VacuumStats; after: VacuumStats; durationMs: number } | undefined;
      if (r) {
        dbVacuumStatsEl.innerHTML = vacuumStatsHtml(r.before) + "<div>↓ after the VACUUM</div>" + vacuumStatsHtml(r.after);
        dbVacuumMsg.textContent = r.vacuumed
          ? `Vacuumed & optimized in ${(r.durationMs / 1000).toFixed(1)}s.`
          : "Nothing to reclaim: the database was already compact and the indexes optimal.";
        smVacuumStats.innerHTML = vacuumStatsHtml(r.after);
      }
      dbVacuumRun.disabled = false;
      dbVacuumRun.textContent = "VACUUM & optimize again";
      break;
    }
    case "sessionsManager":
      // Re-render the rows. The modal only OPENS when the host says so (gear
      // click); silent refreshes after open/close/delete never pop the form.
      renderSessionsManagerData({ sessions: msg.sessions || [], currentFolder: msg.currentFolder, vacuum: msg.vacuum });
      if (msg.show) sessionsModal.classList.remove("hidden");
      break;
    case "compactionPreview":
      // The host's OWN plan for the values currently in the form (same functions the
      // compaction runs): the strip is a fact, not an estimate made up here.
      renderCompactionPreview(msg as Parameters<typeof renderCompactionPreview>[0]);
      break;
    case "sessionsSearchResult": {
      // Full-text matches from the host (SQLite FTS5). Ignore a STALE reply: the
      // user may have kept typing, so only apply it if it matches the field.
      const matches = (msg.matches as { sessionId: string; snippet: string }[] | undefined) ?? [];
      if (msg.scope === "main") {
        if (String(msg.query ?? "") !== sessionSearchInput.value.trim()) break;
        sessionSearchIds = new Set(matches.map((m) => m.sessionId));
        renderSessions(currentSessions);
        break;
      }
      if (String(msg.query ?? "") !== sessionsSearchInput.value.trim()) break;
      smSearchIds = new Set(matches.map((m) => m.sessionId));
      smSnippets = new Map(matches.map((m) => [m.sessionId, m.snippet]));
      renderSessionsManager();
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
      // Same lock for the tab × (a working session cannot be closed).
      applyTabLocks();
      // While ANY session works, the two setup gears go inert (manage
      // sessions / configure providers): no modal mid-stream.
      applyWorkingLock();
      setStreaming(!!msg.active);
      break;
    case "switching":
      // The host is loading/activating a session right now. The name is resolved from
      // the list we ALREADY have (the tab's own title): asking the host for it would
      // add a `SELECT *` to the very click we are trying to make feel fast.
      showSwitchVeil(typeof msg.id === "string" ? currentSessions.find((s) => s.id === msg.id)?.name : undefined);
      break;
    case "switchView": {
      // Incremental tab switch WITHOUT reloading the page: the streaming state
      // (working bubble, buffers) survives, so returning to a session that is
      // still working relocks and keeps streaming.
      //
      // A STALER switch must not be applied: the host posts one per click and each
      // awaits a config build, so two clicks can resolve out of order. Applying the
      // older one last would show the tab you already left — with the config of the
      // current one.
      if (typeof msg.switchSeq === "number") {
        if (msg.switchSeq < lastSwitchSeq) break;
        lastSwitchSeq = msg.switchSeq;
      }
      if (typeof msg.configSeq === "number") lastConfigSeq = Math.max(lastConfigSeq, msg.configSeq);
      // The state is here: whatever was being opened is on screen now.
      hideSwitchVeil();
      renderViewState({
        // Passed through UNTOUCHED: an omitted list means "keep the one you have" (a
        // plain tab switch does not re-send it). Coercing it to `[]` — as this line
        // did — turned "unchanged" into "empty", and `[]` is TRUTHY: every tab click
        // wiped the list, and every tab then fell back to the generic "Session" name
        // because no id could be found. One coercion, two very visible symptoms.
        sessions: msg.sessions,
        openIds: msg.openIds || [],
        activeId: msg.activeId,
        messages: msg.messages || [],
        config: msg.config || {},
        workingIds: msg.workingIds || [],
      });
      restoreLiveStream(msg); // replay the in-flight thinking/answer
      // A compaction that was running when you left must come back too: the bubble
      // is DOM-only, so without this the session looks idle until it finishes.
      if (msg.compacting) ensureCompactionBubble();
      setStreaming(!!msg.streaming);
      // …and the run we are now following has ITS OWN policies: a marker taken for the
      // previous session would be a lie about this one (see resetPolicySnapshot).
      resetPolicySnapshot();
      pending.render((msg.pending as PendingViewItem[]) || []);
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
      // Ignore a STALE config push: an older async response can resolve after a
      // newer one and would otherwise revert the mode/controls it carries.
      if (typeof msg.configSeq === "number") {
        if (msg.configSeq < lastConfigSeq) break;
        lastConfigSeq = msg.configSeq;
      }
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
      compactionTargetIsAuto = (msg.config && msg.config.compactionTargetAuto) !== false;
      compactionTargetPct =
        (msg.config && msg.config.compactionTargetPercent) ?? autoTargetFor(compactionThresholdPct);
      renderCompactionThreshold();
      renderCompactionValues();
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
      // The reply landed: the watchdog is no longer needed.
      window.clearTimeout(providersSaveWatchdog);
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
  // The gears stay USABLE while a session works: with several concurrent runs a
  // blanket lock would mean you can never open the managers again. What is
  // destructive is already locked where it lives — the rows of a working session
  // (branch/rename/delete) and the providers SAVE, which the host refuses while a
  // run is in flight.
  sessionsGearBtn.disabled = false;
  gearBtn.disabled = false;
  sessionsGearBtn.title = busy
    ? "Manage all sessions (the working ones are locked)"
    : "Manage all sessions (every folder)";
  gearBtn.title = busy
    ? "Configure providers & models (saving is blocked while a session works)"
    : "Configure providers & models";
}

function renderViewState(state: {
  /** Absent = "keep the list you already have": a plain tab switch does not re-send
   * it (it is a `SELECT *` on the session table, and the list only changes when a
   * session is created, branched, renamed or closed). */
  sessions?: SessionInfo[];
  openIds: string[];
  activeId?: string;
  messages: ChatMsg[];
  config: ConfigState;
  workingIds?: string[];
}): void {
  openIds = state.openIds || [];
  const prevActiveId = activeId;
  activeId = state.activeId;
  // The prompt AND its attachments belong to the SESSION: park the one you are
  // leaving, bring back the one you are entering. Nothing is thrown away, so a
  // half-written prompt (and the files picked for it) survives a tab switch.
  if (prevActiveId !== activeId) {
    stashComposition(prevActiveId);
    restoreComposition(activeId);
    stashViewMemory(prevActiveId);
  }
  // A session that no longer exists (closed tab, deleted): free its draft.
  for (const key of [...compositions.keys()]) {
    if (key && !openIds.includes(key)) compositions.delete(key);
  }
  for (const key of [...viewMemory.keys()]) {
    if (key && !openIds.includes(key)) viewMemory.delete(key);
  }
  for (const key of [...transcriptSize.keys()]) {
    if (key && !openIds.includes(key)) transcriptSize.delete(key);
  }
  // An omitted list means "unchanged": keep the one already rendered (see the
  // `sessions?` note on the parameter type).
  if (state.sessions) currentSessions = state.sessions;
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
  compactionTargetIsAuto = (state.config && state.config.compactionTargetAuto) !== false;
  compactionTargetPct = (state.config && state.config.compactionTargetPercent) ?? autoTargetFor(compactionThresholdPct);
  renderCompactionThreshold();
  renderCompactionValues();
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
  // …unless you had left THIS session mid-read: then its scroll offset and its
  // open sections come back instead of being thrown away (see stashViewMemory).
  restoreViewMemory(activeId);
  applyWorkingLock();
}

/**
 * Replay the live (uncommitted) part of a session's in-flight turn.
 *
 * Two sources, because the turn has two halves the history cannot provide yet:
 *  · the BUBBLES (tool calls, sub-agent bubbles + their nested logs) — the
 *    assistant turn reaches the history only when the WHOLE tool batch commits
 *    (`history.addGroup`), which in Parallel can be minutes;
 *  · the TEXT of the current segment (thinking / answer).
 *
 * Needed on switchView, on `refresh` and on the first load: returning to a
 * session that is still working must show its progress, not a blank bar. The
 * replayed bubbles stay registered in `pendingToolCalls`, so the live events
 * that keep arriving land in them instead of being dropped.
 */
function restoreLiveStream(state: {
  streaming?: boolean;
  liveThinking?: string;
  liveAnswer?: string;
  liveTurn?: SessionLiveProjection;
}): void {
  if (!state.streaming) return;
  if (!workingEl) addWorking();
  const thinking = String(state.liveThinking || "");
  const answer = String(state.liveAnswer || "");
  const lt = state.liveTurn;
  const hasBubbles =
    (lt?.toolCalls?.length ?? 0) > 0 || Object.keys(lt?.subAgents ?? {}).length > 0;
  // Text written BEFORE the tool calls belongs ABOVE their bubbles (the live DOM
  // never removes it: clearStreamingBubble only drops the reference). Text
  // written after a tool result belongs below.
  const textFirst = !lt?.textAfterTools;
  if (textFirst) appendLiveText(thinking, answer);
  replayLiveTurn(lt);
  // With bubbles replayed BELOW it, the restored text is no longer the bubble the
  // next delta must extend (the live path drops the reference on `toolCall` for
  // the same reason). Without this, post-rebuild text would keep growing above
  // the sub-agent bubbles.
  if (textFirst && hasBubbles) {
    clearStreamingBubble();
    clearThinkingBlock();
  }
  if (!textFirst) appendLiveText(thinking, answer);
  // Re-pin to the TRUE bottom: renderViewState anchored the scroll BEFORE this
  // function added the working bar and the replayed content below it. Without
  // this, the viewport sits above "Working…" and the stream seems to continue
  // below the fold.
  scrollDown();
}

/** Append the current segment's thinking + answer text as live bubbles. */
function appendLiveText(thinking: string, answer: string): void {
  if (thinking) {
    currentThinkingText = thinking;
    currentThinkingBlock = addThinkingBlock(thinking);
  }
  if (answer) {
    currentRawText = answer;
    currentResultEl = document.createElement("div");
    currentResultEl.className = "msg assistant streaming";
    phaseLockPulse(currentResultEl);
    currentResultEl.innerHTML = renderMarkdown(answer);
    messagesEl.appendChild(currentResultEl);
  }
}

/**
 * Rebuild the in-flight turn's TOOL bubbles from the host's projection, with
 * the SAME builders the live events use — so a replayed bubble is
 * indistinguishable from one that never left the page, and the events still to
 * come keep updating it.
 */
function replayLiveTurn(lt: SessionLiveProjection | undefined): void {
  if (!lt) return;
  for (const tc of lt.toolCalls ?? []) {
    const el = tc.name === "Delegate" ? addSubAgentCall(tc.args) : addToolCall(tc.name, tc.args);
    el.dataset.toolCallId = tc.id;
    // Kept registered: the run continues, so the next live event for this call
    // must land HERE (otherwise it would be dropped — no bubble to paint).
    pendingToolCalls.set(tc.id, el);
    if (tc.abortRequested && !tc.done) {
      // The user already pressed ⏹ on this sub-agent before the rebuild: keep the
      // button pending instead of resurrecting it as clickable.
      el.dataset.aborting = "1";
      const abortBtn = el.querySelector(".subagent-abort") as HTMLButtonElement | null;
      if (abortBtn) {
        abortBtn.disabled = true;
        abortBtn.classList.add("pending");
      }
    }
    if (tc.done) {
      el.classList.remove("tool-call-pending");
      const out = el.querySelector(".tool-result") as HTMLElement | null;
      const text = String(tc.output ?? "");
      if (out) {
        if (tc.name === "Delegate") {
          out.innerHTML = renderMarkdown(text.slice(0, 12000));
          setSubAgentStatus(
            el,
            /aborted|interrupted/i.test(text) ? "aborted" : tc.isError || / failed:/.test(text) ? "failed" : "done",
          );
        } else {
          renderToolOutput(out as HTMLPreElement, text.slice(0, 12000));
          out.classList.toggle("tool-result-error", tc.isError);
        }
      }
    } else if (workingEl) {
      // The in-flight call is the run's current phase: say so on the bar.
      workingEl.innerHTML =
        tc.name === "Delegate"
          ? "● Working... " + SUBAGENT_ICON + " sub-agent"
          : "● Working... 🔧 " + escapeHtml(tc.name);
    }
  }
  // Then the nested logs, through the SAME handler the live events use
  // (markdown coalescing, tool lines, terminal states included).
  for (const [parentId, sa] of Object.entries(lt.subAgents ?? {})) {
    const el = pendingToolCalls.get(parentId);
    if (!el) continue;
    for (const event of sa.events) handleSubAgentEvent(parentId, event);
    // Paint the replayed log NOW: the markdown coalescer would otherwise wait a
    // frame, and a rebuild must show what the bubble already contained.
    flushSubAgentMd(el);
    setSubAgentStatus(el, sa.status);
  }
}

// ── Session-name modal (in-panel name prompt) ──
nameOk.addEventListener("click", submitName);
nameCancel.addEventListener("click", cancelNameModal);
nameInput.addEventListener("input", validateNameInput);
nameInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    submitName();
  } else if (e.key === "Escape") {
    e.preventDefault();
    cancelNameModal();
  }
});

// ── Initial render ──
// Control stack: COLLAPSED by default; a previously chosen state wins.
const savedCollapsed = (vscode.getState() as { controlsCollapsed?: boolean } | undefined)?.controlsCollapsed;
// Drafts that survived a webview reload: their TEXT and their ATTACHMENTS (see
// persistCompositions — the payload is bounded per file).
const savedDrafts = (vscode.getState() as { drafts?: Record<string, string> } | undefined)?.drafts;
if (savedDrafts) {
  for (const [key, text] of Object.entries(savedDrafts)) compositions.set(key, { text, files: [] });
}
const savedDraftFiles = (vscode.getState() as { draftFiles?: Record<string, unknown> } | undefined)?.draftFiles;
if (savedDraftFiles) {
  for (const [key, rawList] of Object.entries(savedDraftFiles)) {
    const files = (Array.isArray(rawList) ? rawList : [])
      .map(fromPersisted)
      .filter((f): f is AttachedFile => !!f);
    if (files.length === 0) continue;
    const existing = compositions.get(key) ?? { text: "", files: [] };
    compositions.set(key, { text: existing.text, files });
  }
}
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
if (init.compacting) ensureCompactionBubble();
// The initial render did not switch session (prev === active), so the parked draft
// of the session we are opening is restored HERE.
restoreComposition(activeId);
setStreaming(!!init.streaming);
pending.render(init.pending || []);
if (activeId) vscode.postMessage({ type: "getConfig" });
// Opening the panel on a session lands the caret in the prompt.
if (activeId) focusPrompt();

// ── Esc closes the TOP-MOST overlay only (LIFO) ──
// ONE dispatcher instead of a listener per modal: with nested modals open (e.g.
// All sessions → Compact) Esc must close the LAST one opened, not whichever
// listener happens to fire first (which also left the inner modal open).

/** Cancel the name dialog (Esc / Cancel): resolves the host's modal promise
 * with `undefined` (= cancelled). */
function cancelNameModal(): void {
  const modalId = nameModalId;
  closeNameModal();
  vscode.postMessage({ type: "modalResponse", id: modalId, value: undefined });
}

/** True when ANY modal/overlay is open: Esc must close the top-most one and must
 * NOT be interpreted as "stop the run". Single source of truth shared by the
 * prompt/global Esc handlers and the LIFO dispatcher. */
function anyOverlayVisible(): boolean {
  return (
    !nameModal.classList.contains("hidden") ||
    !alertModal.classList.contains("hidden") ||
    !dbVacuumModal.classList.contains("hidden") ||
    !compactSettingsModal.classList.contains("hidden") ||
    !providersModal.classList.contains("hidden") ||
    !mcpModal.classList.contains("hidden") ||
    !modelModal.classList.contains("hidden") ||
    !sessionsModal.classList.contains("hidden") ||
    !modeMenu.classList.contains("hidden") ||
    (lightboxEl !== null && !lightboxEl.classList.contains("hidden"))
  );
}

const ESC_OVERLAYS: { visible: () => boolean; close: () => void }[] = [
  { visible: () => !!lightboxEl && !lightboxEl.classList.contains("hidden"), close: () => closeImageLightbox() },
  { visible: () => alertId >= 0, close: () => closeAlert(false) },
  { visible: () => !nameModal.classList.contains("hidden"), close: () => cancelNameModal() },
  { visible: () => !dbVacuumModal.classList.contains("hidden"), close: () => closeDbVacuumModal() },
  { visible: () => !compactSettingsModal.classList.contains("hidden"), close: () => closeCompactionSettings() },
  { visible: () => !providersModal.classList.contains("hidden"), close: () => closeProvidersEditor() },
  { visible: () => !mcpModal.classList.contains("hidden"), close: () => closeMcpEditor() },
  {
    visible: () => !modelModal.classList.contains("hidden"),
    close: () => {
      closeModelModal();
      focusPrompt();
    },
  },
  { visible: () => !sessionsModal.classList.contains("hidden"), close: () => closeSessionsManager() },
];
window.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  for (const o of ESC_OVERLAYS) {
    if (o.visible()) {
      e.preventDefault();
      o.close();
      return;
    }
  }
});

export {};
