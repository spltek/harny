import type { ExtensionContext, WebviewView, WebviewViewProvider, WebviewViewResolveContext } from "vscode";
import {
  mcpPrefix,
  normalizeToolScope,
  reconcileToolScope,
  sanitizeToolNamePart,
  type ToolScope,
} from "../core/tools/tool-scope";
import type { McpServerStatus } from "../core/mcp/types";
import { Uri, window, workspace } from "vscode";
import * as fs from "fs";
import type {
  ConfigProvider,
  HarnyConfig,
  ProviderCatalog,
  ProviderEditorData,
  ThinkingLevel,
} from "../core/config/types";
import { isThinkingLevel } from "../core/config/types";
import type { MemoryOverrideConfigProvider } from "../core/config/memory-override-config-provider";
import { requiresApiKey } from "../core/config/requires-api-key";
import type { ModelInfo, ModelListProvider } from "../core/llm/model-list";
import { modelsDevProviderCandidates } from "../core/llm/models-dev";
import type { SessionManager } from "../core/sessions/session-manager";
import type { DbVacuumStats, SessionSettingsPatch, SessionSummary } from "../core/sessions/types";
import type { SessionRegistry, SessionRuntime } from "./session-registry";
import { PendingInputQueue, type PendingInput } from "./pending-input-queue";
import {
  checkpointStart,
  conversationFaults,
  firstCheckpointEnd,
  turnEnd,
  turnStart,
} from "../core/history/conversation-validity";
import { StreamTee } from "./stream-tee";
import { Telemetry } from "./telemetry";
import type { PreparedPrompt, SendIntent, SessionAbortPort, SessionSendPort } from "./session-engine";
import type { AttachmentService } from "./attachment-service";
import type { AttachmentPart } from "./attachment-types";
import { debugLog, infoLog } from "../logger";
import { preprocessJsonc } from "../core/config/jsonc";
import { renderViewHtml } from "./view-html";
import { toTemperature, toTopP } from "./temperature";
import {
  CONTEXT_SLIDER_STEP,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_OUTPUT_TOKENS,
  MAX_CONTEXT_WINDOW,
  MAX_OUTPUT_TOKENS,
  MIN_CONTEXT_WINDOW,
  MIN_OUTPUT_TOKENS,
  OUTPUT_SLIDER_STEP,
  reachableStep,
  REQUEST_SAFETY_MARGIN,
  REQUEST_SAFETY_MARGIN_SHARE,
  clampAdoptedContextWindow,
  clampAdoptedOutputTokens,
  clampContextWindow,
  clampOutputTokens,
  toContextWindow,
  toOutputTokens,
  usableContext,
} from "./context-window";
import { PanelModalQueue } from "./panel-modal-queue";
import {
  Compactor,
  DEFAULT_COMPACTION,
  CompactionSettings,
  autoTargetPercent,
  carriedState,
  clampTargetPercent,
  compactHistory,
  compactionSpanTokens,
  estimateContextTokens,
  estimateTokens,
  maxSummaryInputTokens,
  minExplicitTargetPercent,
  newestWithin,
  planForTarget,
  realWindowTokens,
  serializeConversation,
  shouldCompact,
  targetTokensFor,
  toCompactionThresholdPercent,
  toTargetPercent,
  trimHistory,
  type CompactedHistory,
  type TrimResult,
} from "../core/sessions/compactor";
import { CompactionTally } from "../core/sessions/compaction-tally";
import type { SkillRegistry } from "../core/skills/skill-registry";
import type { McpManager } from "../core/mcp";
import { McpStdioClient, McpHttpClient, type McpClient } from "../core/mcp";
import type { McpServerConfig, McpStdioServerConfig, McpHttpServerConfig } from "../core/config/types";
import {
  LOOP_GUARD_FIELD_RANGES,
  clampLoopGuardOverrides,
  loopGuardPresets,
  normalizeLoopGuardSensitivity,
  resolveLoopGuardOptions,
} from "../core/agent/loop-guard";
import type { LoopGuardOptions } from "../core/agent/loop-guard";
import { DEFAULT_MAX_PARALLEL_SUB_AGENTS } from "../core/agent/agent";
import type { ContextOverflowEvidence } from "../core/agent/agent";
import type { ChatHistory } from "../core/history/chat-history";
import type { ChatMessage } from "../core/history/types";

/**
 * Coalescing window for BACKGROUND config pushes (see `pushConfigSoon`): a burst
 * of usage reports collapses into one build+post. Small enough to be invisible,
 * large enough to swallow a whole turn's worth of noise from several sessions.
 */
const CONFIG_COALESCE_MS = 120;

/**
 * Coalescing window for the context-token METRIC write (see `persistContextTokensSoon`).
 * Generous on purpose: the value is recomputed by the next turn, so a lost tail is
 * worth nothing, while one transaction per turn per session is a real cost on the
 * single host thread.
 */
const CONTEXT_TOKENS_FLUSH_MS = 400;

/**
 * Single side-view (webview view) hosting: a hideable sessions list, a tab bar
 * of the open sessions, and the ACTIVE chat (overlapping tabs — one chat
 * visible at a time). Messages from the webview are routed to the active
 * session's runtime; agent events of the active runtime are forwarded here.
 */
/** Convert a pasted `file://` URI or plain path to a local filesystem path. */
function toLocalPath(input: string): string {
  const raw = input.trim();
  if (!raw) return "";
  if (raw.startsWith("file://")) {
    try {
      const url = new URL(raw);
      let p = decodeURIComponent(url.pathname);
      if (/^\/[A-Za-z]:\//.test(p)) p = p.slice(1); // Windows /C:/... -> C:/...
      return p;
    } catch {
      return raw.replace(/^file:\/\//, "");
    }
  }
  return raw;
}

export class ChatViewProvider implements WebviewViewProvider {
  private view: WebviewView | undefined;
  private context: ExtensionContext | undefined;
  private activeId: string | undefined;
  /** Monotonic id for config pushes: `buildConfig` awaits, so an older push can
   * resolve AFTER a newer one and would clobber the UI (e.g. revert the mode).
   * Every push gets a seq; stale results are dropped. */
  private configSeq = 0;
  /** Monotonic id for `switchView` posts. SEPARATE from `configSeq` on purpose:
   * a sibling `pushConfig` (a model-limits adoption, a metrics update) bumps that
   * counter, and sharing it would let an unrelated push invalidate a legitimate
   * tab switch. */
  private switchSeq = 0;
  private hostCache = new Map<string, { at: number; models: ModelInfo[] }>();
  /** models.dev context windows resolved for hosts that do NOT report one
   * (e.g. opencode-go), keyed by `provider|model`. Filled in the background so
   * the model LIST shows the same window that selecting the model adopts. */
  private readonly modelsDevContext = new Map<string, number>();
  /** models.dev MAX OUTPUT tokens, parallel to {@link modelsDevContext}. */
  private readonly modelsDevOutput = new Map<string, number>();
  /** `provider|model` keys already looked up this session (avoid re-hitting the
   * catalog on every config push). */
  private readonly modelsDevAttempted = new Set<string>();
  /** Limits the USER typed for a model whose host reported none (`provider|model`).
   * They settle the question for that model and seed the session on the next
   * selection, but they are NOT written back to the models.dev maps: those CAP
   * the sliders, and an underestimate the user just typed must stay correctable
   * without switching model first. */
  private readonly userLimits = new Map<string, { context: number; output: number }>();
  // Short host-model cache: the dropdown re-fetches on open (view sends
  // getConfig on mousedown/focus), so a host that comes up later (e.g. llama.cpp
  // started after the panel) shows up on the next open. Kept short because the
  // fetch itself is bounded by HOST_MODEL_TIMEOUT_MS anyway.
  private static readonly HOST_CACHE_TTL = 5_000;
  /** Counts what compaction DID, and says so on the line each event already logs.
   *  A log answers "what happened here"; only a ratio answers "is the trim a rare
   *  rescue or the normal path" — which is a question about the tuning. */
  private readonly tally = new CompactionTally();
  /** Per-session queue of messages typed while the agent works (queue/steer). */
  private readonly pendingQueue: PendingInputQueue;
  /** FIFO queue for in-panel modals (name dialog, alerts, confirms…). */
  private modals: PanelModalQueue;
  /** True while the shared "compact database" modal is open (avoid re-prompts). */
  private vacuumPromptOpen = false;

  /** Event-loop + webview-traffic probe (see telemetry.ts). It prints one line every
   * 30 s through the env-gated debug log, so it costs nothing with the flag off. */
  private readonly telemetry = new Telemetry();
  /** Coalesced config push in flight (see pushConfigSoon). */
  private configSoonTimer: ReturnType<typeof setTimeout> | undefined;
  /** Sessions whose context-token metric is waiting for its coalesced write. */
  private readonly pendingTokenFlush = new Set<string>();
  private tokenFlushTimer: ReturnType<typeof setTimeout> | undefined;
  /** The one-shot startup vacuum check (cleared on dispose). */
  private startupVacuumTimer: ReturnType<typeof setTimeout> | undefined;

  /** Is THIS session compacting? The flag lives on the ENGINE (`engine.compacting`):
   * per session, so one session's summary cannot swallow another's. */
  private isCompacting(sessionId: string): boolean {
    return this.registry.get(sessionId)?.engine.compacting === true;
  }
  /** A refresh was requested while a modal was open: run it once the queue
   * drains, instead of rebuilding the page (which would wipe the modal). */
  private refreshDeferred = false;

  constructor(
    private config: ConfigProvider,
    private modelSelector: MemoryOverrideConfigProvider,
    private attachments: AttachmentService,
    private providers: ProviderCatalog,
    private modelList: ModelListProvider,
    private sessions: SessionManager,
    private registry: SessionRegistry,
    private options: {
      compactor?: Compactor;
      compaction?: CompactionSettings;
      manualKeepFraction?: number;
      /** True when exactly one workspace folder is open (sessions are bucketed centrally per workspace). */
      workspaceReady?: () => boolean;
      /** Absolute path of the current workspace root (filters the main sessions list; undefined = none). */
      currentFolder?: () => string | undefined;
      /** Extension data folder (home), for error hints pointing at config.json. */
      configHome?: string;
      /** Optional models.dev catalog: fallback context window for hosts that
       * do not report it in `/models` (e.g. OpenCode Go). */
      modelsDev?: {
        getLimits(
          modelId: string,
          providerCandidates: readonly string[],
        ): Promise<{ context?: number; output?: number }>;
        /** False when the catalog is currently UNREACHABLE (for the UI warning). */
        isReachable?(): boolean;
      };
      /** How long `runVacuum` waits for the sessions to go idle before giving up
       * (default 5 min; overridable for tests). */
      vacuumWaitMs?: number;
      /** Agent Skills registry: catalog for the UI + manual `/skill` activation. */
      skills?: SkillRegistry;
      /** MCP manager: status for the MCP card + reconnect after a save. */
      mcp?: McpManager;
      /** Full-text search across sessions (SQLite FTS5). Absent = no search. */
      searchSessions?: (query: string) => { sessionId: string; snippet: string }[];
    } = {},
  ) {
    this.modals = new PanelModalQueue((msg) => this.view?.webview.postMessage(msg));
    this.pendingQueue = new PendingInputQueue({
      buildContext: (files) => this.attachments.buildContext(files),
      post: (sessionId, items) => this.postPending(sessionId, items),
    });
  }

  setContext(context: ExtensionContext): void {
    this.context = context;
    // The root font follows editor.fontSize, so a change while the panel is
    // open must rebuild the HTML for the new size to take effect.
    context.subscriptions.push(
      workspace.onDidChangeConfiguration((e) => {
        // editor.fontSize drives the root font and `harny.theme` the body's
        // palette class, so those two need a full rebuild (a body class cannot
        // be pushed through a message). Any other `harny.*` change
        // (model/limits/providers) is applied with a LIGHTWEIGHT refresh so the
        // typed prompt survives.
        if (e.affectsConfiguration("editor.fontSize") || e.affectsConfiguration("harny.theme")) this.refresh();
        else if (e.affectsConfiguration("harny")) this.refreshConfig();
      }),
    );
  }

  /**
   * Open a session as the active tab (creates a runtime if needed). Sessions
   * of OTHER folders are not opened here: the user opens the folder in VS
   * Code and harny re-derives its root from the workspace. Only blocked when
   * the session's folder is known but no longer available.
   */
  openSession(id: string): void {
    void this.openSessionId(id);
  }

  private async openSessionId(id: string): Promise<void> {
    const s = this.sessions.list().find((x) => x.id === id);
    if (s?.folderMissing) return;
    this.registry.openOrCreate(id);
    await this.setActive(id);
    // Opening can ADD a row to the main list (a session of another folder becomes
    // visible now that it is open), so this is one of the "the list changed" paths
    // that re-sends it.
    await this.postSwitchView(true);
    // Silent refresh of the manage form (if open) — no-op for the main list.
    this.pushSessionsManager();
  }

  /** The single workspace root the MAIN sessions list is anchored to. */
  private currentFolder(): string | undefined {
    return this.options.currentFolder ? this.options.currentFolder() : undefined;
  }

  /** Sessions OF the current workspace folder (the main list, not the form). */
  private currentFolderSessions(): SessionSummary[] {
    const folder = this.currentFolder();
    return this.sessions.list().filter((s) => !folder || s.folder === folder);
  }

  /**
   * What the MAIN LIST should show: this folder's sessions PLUS every OPEN session
   * that lives elsewhere.
   *
   * Why the union: the list is the only navigation surface, so hiding an OPEN session
   * from it leaves a tab you cannot get back to once you close it — and an empty list
   * that says "no sessions yet" while a tab sits there is a lie the user has to
   * decode. Switching the workspace folder keeps the open tabs (the registry is not
   * reset), and the cross-folder Manage form can open any session, so the mismatch is
   * reachable; the list simply follows what is open.
   *
   * The folder stays authoritative for the UNIQUENESS of names (`currentFolderSessions`
   * is what `sessionNameTaken` reads), so two folders may still share a name.
   */
  private sessionsForView(): (SessionSummary & { foreign?: boolean })[] {
    const scoped = this.currentFolderSessions();
    const shown = new Set(scoped.map((s) => s.id));
    const openElsewhere = this.registry
      .listOpenIds()
      .filter((id) => !shown.has(id))
      .map((id) => this.sessions.list().find((s) => s.id === id))
      .filter((s): s is SessionSummary => !!s)
      .map((s) => ({ ...s, foreign: true }));
    return [...scoped, ...openElsewhere];
  }

  /** Live data for the manage-sessions form (ALL folders, sorted by the manager). */
  private pushSessionsManager(): void {
    // show:false — a silent refresh: re-renders the rows IF the form is open,
    // never OPENS it (a session opened from the main list must not pop the
    // form).
    this.view?.webview.postMessage(this.sessionsManagerPayload(false));
  }

  /** Payload for the manage form; `show` controls whether the modal opens. */
  private sessionsManagerPayload(show: boolean): Record<string, unknown> {
    return {
      type: "sessionsManager",
      sessions: this.sessions.list(),
      currentFolder: this.currentFolder(),
      workingIds: this.workingIds(),
      show,
      // DB compaction controls (threshold + free-page stats) for the footer.
      vacuum: {
        stats: this.sessions.dbVacuumStats(),
        threshold: this.vacuumThresholdPercent(),
        minFreeMB: this.vacuumMinFreeMB(),
      },
    };
  }

  /**
   * Open the folder a session points to as the VS Code workspace, so harny's
   * working directory becomes that folder. Falls back to re-pointing the
   * session (warns when the folder is missing) when there is nothing to open.
   */
  private async openSessionFolder(id: string): Promise<void> {
    const session = this.sessions.list().find((s) => s.id === id);
    if (!session?.folder || session.folderMissing) {
      await this.changeSessionFolder(id);
      return;
    }
    const { commands, Uri } = await import("vscode");
    // forceNewWindow=false: reuse the current window (the extension reloads
    // and re-derives its root from the newly opened folder).
    await commands.executeCommand("vscode.openFolder", Uri.file(session.folder), false);
  }

  /** Change the folder a session points to (pointer-only; the file stays put). */
  private async changeSessionFolder(id: string): Promise<void> {
    const { window, Uri } = await import("vscode");
    // Default the picker to the session's folder when it is still available,
    // so re-pointing a session usually takes one click.
    const session = this.sessions.list().find((s) => s.id === id);
    // A folder that is known but gone cannot be the default: warn the user
    // first, then still open the picker so they can re-point the session.
    if (session?.folder && session.folderMissing) {
      await this.inPanelAlert({
        kind: "info",
        title: "Folder no longer available",
        message: `The folder this session points to (${session.folder}) no longer exists. Pick a new one.`,
      });
    }
    const defaultFolder = session?.folder && !session.folderMissing ? session.folder : undefined;
    const uris = await window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      title: "Choose the folder for this session",
      openLabel: "Select folder",
      ...(defaultFolder ? { defaultUri: Uri.file(defaultFolder) } : {}),
    });
    if (!uris || uris.length === 0) return;
    const folder = uris[0].fsPath;
    this.sessions.saveSettings(id, { folder });
    // Refresh both the form and the main list.
    this.pushSessionsManager();
    void this.postSwitchView();
  }

  /** True when exactly one workspace folder is open (sessions are bucketed centrally). */
  private workspaceReady(): boolean {
    return this.options.workspaceReady ? this.options.workspaceReady() : true;
  }

  async createNew(): Promise<void> {
    if (!this.workspaceReady()) {
      await this.warnWorkspaceRequired();
      return;
    }
    const name = await this.askName("create");
    if (name === undefined) return;
    if (this.sessionNameTaken(name)) {
      await this.warnNameTaken(name);
      return;
    }
    const rt = this.registry.create(name);
    // A NEW session always starts with Parallel OFF (orchestration is opt-in).
    rt.agent.setDelegation(false);
    // …and with every MCP server OFF, WRITTEN explicitly (see ensureToolScope, called on every
    // open: a session without a scope is a session from before the feature, and it gets one there).
    await this.setActive(rt.sessionId, true);
  }

  /**
   * Give the session a scope the first time it is opened.
   *
   * `undefined` means "nothing declared" — which is how a session written before per-session scopes
   * keeps behaving as it did, and NOT what a session created today should mean (all MCP servers
   * off). Doing it here covers every creation path (the panel, a branch, a session from an older
   * build) instead of one call site, and it happens ONCE: the row is written only when the value
   * was missing.
   *
   * The tools the CONFIG excludes are the seed: they used to be a global veto at connect time, so
   * dropping them would silently re-expose tools the user had switched off.
   */
  private ensureToolScope(rt: { sessionId: string; toolScope?: ToolScope }): void {
    if (rt.toolScope) return;
    rt.toolScope = { mcp: [], off: this.seededToolOffList() };
    this.sessions.saveSettings(rt.sessionId, { toolScope: rt.toolScope });
  }

  /** The `excludeTools` of every configured server, as the `mcp__server__tool` names a scope holds. */
  private seededToolOffList(): string[] {
    const servers = this.providers.readMcpServers?.() ?? {};
    const off: string[] = [];
    for (const [server, cfg] of Object.entries(servers)) {
      for (const tool of cfg.excludeTools ?? []) {
        const name = typeof tool === "string" ? tool.trim() : "";
        if (name) off.push(`mcp__${server}__${name}`);
      }
    }
    return off;
  }

  /**
   * True when another session of this workspace already uses the name
   * (excludes `excludeId` — the session being renamed keeps its own name).
   * Case-insensitive, trimmed. Names are unique PER workspace root because
   * the session store is per-workspace folder.
   */
  private sessionNameTaken(name: string, excludeId?: string): boolean {
    const n = name.trim().toLowerCase();
    // Uniqueness is scoped to the CURRENT workspace folder (the list the user
    // sees and renames in); sessions of other folders may share names.
    return this.currentFolderSessions().some((s) => s.id !== excludeId && (s.name || "").trim().toLowerCase() === n);
  }

  private async warnNameTaken(name: string): Promise<void> {
    await this.inPanelAlert({
      kind: "error",
      title: "Name already in use",
      message: `A session named "${name}" already exists in this workspace. Pick another name.`,
    });
  }

  /**
   * Branch (copy) a session at its current state into a new session: messages
   * + all per-session settings (model, provider, thinking, window, tokens,
   * temperature). The dialog defaults to the original name (unique required).
   */
  private async branchSession(id: string): Promise<void> {
    const existing = this.sessions.list().find((s) => s.id === id);
    if (!existing) return;
    // The ⎇ buttons are DISABLED while the session works: this is only a
    // silent safety guard (no alert — the UI already reflects the state).
    // `isWorking` and not just `streaming`: the SEND PREAMBLE (attachment build,
    // pre-request auto-compaction) is work too, and the runtime must not be
    // branched away while a run is being prepared.
    if (this.isWorking(id)) return;
    const name = await this.askName("branch", id);
    if (name === undefined) return;
    if (this.sessionNameTaken(name)) {
      await this.warnNameTaken(name);
      return;
    }
    const loaded = this.sessions.load(id);
    await this.createBranch(id, name, loaded.messages);
  }

  /**
   * Branch from a specific reply: copies the transcript UP TO AND INCLUDING
   * the message at `index` (the blue-bubble ⎇ action) into a new session.
   */
  private async branchAt(index: number): Promise<void> {
    const rt = this.activeRuntime();
    if (!rt) return;
    // The bubble ⎇ keys are DISABLED while the session works (silent guard).
    if (this.isWorking(rt.sessionId)) return;
    if (!Number.isInteger(index) || index < 0) return;
    const loaded = this.sessions.load(rt.sessionId);
    if (index >= loaded.messages.length) return; // stale bubble, treat as gone
    const name = await this.askName("branch", rt.sessionId);
    if (name === undefined) return;
    if (this.sessionNameTaken(name)) {
      await this.warnNameTaken(name);
      return;
    }
    // Copy the WHOLE turn the clicked reply belongs to (input → final answer,
    // everything in between): a reply can carry text AND tool calls and the turn
    // may continue with more tool rounds, so anything less would copy half a turn
    // — and could leave the copy with an unanswered call, i.e. a session that
    // cannot send anything at all.
    let end = turnEnd(loaded.messages, index);
    // Unless that turn is ITSELF damaged (a history broken before this rule
    // existed): the damage must not be copied over, so the copy stops at the last
    // valid boundary before it.
    if (conversationFaults(loaded.messages.slice(0, end)).length > 0) {
      end = turnStart(loaded.messages, index);
    }
    await this.createBranch(rt.sessionId, name, loaded.messages.slice(0, end));
  }

  /**
   * Cut the ACTIVE session's transcript from the message at `index` (a USER
   * prompt bubble) DOWNWARD: that message and everything after it are removed,
   * IN PLACE, after a confirmation. The destructive companion to
   * {@link branchAt}, used to "sanitize" a conversation that took a bad turn and
   * continue from a clean point. The removed tail is NOT kept — branch first to
   * preserve it.
   */
  private async truncateAt(index: number): Promise<void> {
    const rt = this.activeRuntime();
    if (!rt) return;
    // The ✂ keys are DISABLED while the session works (silent guard).
    if (this.isWorking(rt.sessionId)) return;
    if (!Number.isInteger(index) || index < 0) return;
    // Slice the SAME array the UI rendered (the agent's in-memory history), so
    // the bubble index matches exactly.
    const messages = rt.agent.getMessages();
    if (index >= messages.length) return; // stale bubble, treat as gone
    // Keeping [0, turnStart) drops that message and the whole tail, so a tool-call
    // is never left without its tool results. Snapping to the turn's INPUT keeps
    // the rule even when the clicked index is not the input itself: a cut always
    // lands between groups (input → final answer, everything in between).
    const kept = messages.slice(0, turnStart(messages, index));
    const removed = messages.length - kept.length;
    const ok = await this.inPanelAlert({
      kind: "confirm",
      title: "Cut the conversation here?",
      message:
        `This permanently removes ${removed} message${removed === 1 ? "" : "s"} from this session ` +
        `(this message and everything after it). The removed part is NOT kept — branch this session ` +
        `first if you want to preserve it.`,
      confirmText: "Cut",
      danger: true,
    });
    if (!ok) return;
    rt.history.replace(kept);
    this.sessions.saveMessages(rt.sessionId, kept, { replace: true });
    // Per-interaction accounting: providers report only the TOTAL input per
    // turn, never per message, so we ESTIMATE each interaction and, after a cut,
    // keep the tokens of the KEPT messages only — i.e. subtract the removed
    // ones. Cutting everything leaves 0 (as expected); a partial cut drops by
    // the removed share. PERSIST it: `saveMessages` carries the previous
    // `contextTokens` over, so without this write a reload (tab switch / panel
    // reload / restart) would restore the pre-cut count and the bar would jump
    // back up.
    rt.contextTokens = estimateContextTokens(rt.history.conversation());
    this.sessions.saveSettings(rt.sessionId, { contextTokens: rt.contextTokens });
    void this.maybeSuggestVacuum();
    // Any previously reported cache hit is meaningless for the new layout.
    rt.cachedTokens = 0;
    rt.cachedWriteTokens = 0;
    void this.pushConfig();
    this.refreshTranscript(rt, true);
  }

  /** Shared branch core: new session + slicing done by the caller. */
  private async createBranch(
    sourceId: string,
    name: string,
    messages: import("../core/history/types").ChatMessage[],
  ): Promise<void> {
    const existing = this.sessions.list().find((s) => s.id === sourceId);
    const created = this.sessions.create(name);
    if (messages.length > 0) this.sessions.saveMessages(created.id, messages);
    // Copy the per-session settings over to the branch in one atomic write.
    const settings: SessionSettingsPatch = {
      ...(existing?.model ? { model: existing.model } : {}),
      ...(existing?.modelProvider ? { modelProvider: existing.modelProvider } : {}),
      ...(existing?.thinkingLevel ? { thinkingLevel: existing.thinkingLevel } : {}),
      ...(existing?.contextWindow ? { contextWindow: existing.contextWindow } : {}),
      ...(existing?.outputTokens ? { outputTokens: existing.outputTokens } : {}),
      ...(existing?.temperature !== undefined ? { temperature: existing.temperature } : {}),
      ...(existing?.maxParallelSubAgents !== undefined ? { maxParallelSubAgents: existing.maxParallelSubAgents } : {}),
      ...(existing?.loopGuard ? { loopGuard: existing.loopGuard } : {}),
      ...(existing?.loopGuardResponse !== undefined ? { loopGuardResponse: existing.loopGuardResponse } : {}),
    };
    if (Object.keys(settings).length > 0) this.sessions.saveSettings(created.id, settings);
    await this.setActive(created.id, true);
  }

  /**
   * FIFO queue for in-panel modals (see PanelModalQueue). Request and drain
   * are thin delegates; the queue owns sequencing (one visible at a time).
   */
  private requestPanelModal(req: Record<string, unknown>): Promise<unknown> {
    return this.modals.request(req);
  }

  /** Drains the queue entry and shows the next queued modal, if any. */
  private onPanelModalResponse(id: number, value: unknown): void {
    this.modals.respond(id, value);
    // A refresh was deferred while this modal was open: apply it now that the
    // queue is empty (never rebuild the page over a live modal).
    if (this.refreshDeferred && !this.modals.hasPending()) {
      this.refreshDeferred = false;
      this.refresh();
    }
  }

  /**
   * In-panel alert / confirm (same design family as the name modal): shown in
   * the Harny area instead of the native VS Code dialog. Falls back to the
   * native message only when the webview is not resolved yet (e.g. command
   * fired before the panel).
   */
  private async inPanelAlert(opts: {
    kind: "info" | "error" | "confirm";
    title: string;
    message: string;
    confirmText?: string;
    danger?: boolean;
  }): Promise<boolean> {
    if (!this.view) {
      const { window } = await import("vscode");
      const okText = opts.confirmText ?? "OK";
      const r =
        opts.kind === "confirm"
          ? await window.showWarningMessage(opts.message, { modal: true }, okText)
          : await window.showWarningMessage(opts.message);
      return r === okText;
    }
    const v = await this.requestPanelModal({
      kind: "alert",
      alertKind: opts.kind,
      title: opts.title,
      message: opts.message,
      confirmText: opts.confirmText,
      danger: opts.danger ?? false,
    });
    return v === true;
  }

  private async warnWorkspaceRequired(): Promise<void> {
    await this.inPanelAlert({
      kind: "info",
      title: "No single folder open",
      message: "Harny needs exactly one open folder (File → Open Folder) to store sessions and use this command.",
    });
  }

  /**
   * Ask for a session name through the IN-PANEL modal (blurred overlay), so the
   * prompt stays in the Harny area. Falls back to the native input box only
   * when the webview is not resolved yet (e.g. command fired before the panel).
   */
  private async askName(mode: "create" | "rename" | "branch", id?: string): Promise<string | undefined> {
    const current = id ? this.sessions.list().find((s) => s.id === id)?.name : undefined;
    if (!this.view) {
      const { window } = await import("vscode");
      return window.showInputBox({
        prompt:
          mode === "rename" ? "Rename session" : mode === "branch" ? "Branch session" : "Name for the new session",
        value: current ?? "New Session",
        placeHolder: "Session name",
        validateInput: (v) => {
          const name = v.trim();
          if (!name) return "Name cannot be empty";
          // For rename the session itself is excluded (keeping its own name);
          // for create/branch the new name must differ from EVERY session.
          return this.sessionNameTaken(name, id)
            ? "A session with this name already exists in this workspace — pick another name."
            : undefined;
        },
      });
    }
    const v = await this.requestPanelModal({ kind: "name", mode, id, current });
    return typeof v === "string" ? v : undefined;
  }

  /**
   * Switch the ACTIVE tab. This is an INCREMENTAL update (switchView message),
   * NOT a full HTML reload: the webview keeps its streaming state, so a
   * session that is still working relocks and keeps streaming when you return
   * to it.
   */
  async setActive(id: string, sessionsChanged = false): Promise<void> {
    // Tell the view AT ONCE that a switch is in flight. The state itself cannot
    // follow before `buildConfig` answers (and a host busy with a running turn can
    // take a while), and until it does the OLD transcript sits there looking final —
    // the click reads as lost, which is how a user ends up clicking three more
    // times. The NAME is resolved by the view from the list it already has, so this
    // costs no extra query on the click path.
    this.view?.webview.postMessage({ type: "switching", id });
    this.activeId = id;
    const active = this.activeRuntime();
    if (active) this.ensureToolScope(active);
    this.resubscribe();
    this.applyActiveModel();
    // A session may predate the model-limits feature: adopt the model's
    // DETECTED context/output when it has no explicit override yet (silent —
    // no alert on open).
    const rt = this.registry.get(id);
    if (rt?.model && (rt.contextWindow === undefined || rt.outputTokens === undefined)) {
      void this.ensureModelLimits(rt, rt.model, rt.modelProvider, false);
    }
    await this.postSwitchView(sessionsChanged);
  }

  async closeTab(id: string): Promise<void> {
    // A WORKING session's tab must NOT be closed. The × is disabled in the UI
    // (view.ts applyTabLocks), but this host-side guard is defense-in-depth and
    // covers the start-of-run race, when the webview's workingIds is still
    // stale. Closing VS Code still kills everything, of course.
    if (this.isWorking(id)) return;
    // The tab is going away and its metric is not on disk yet: write it while the
    // runtime still exists (the flush reads `rt.contextTokens`).
    this.pendingTokenFlush.add(id);
    this.flushContextTokens();
    this.streamTee.detach(id);
    this.registry.close(id);
    this.pendingQueue.drop(id);
    if (this.activeId === id) {
      this.activeId = undefined;
      if (this.registry.listOpenIds().length > 0) {
        this.activeId = this.registry.listOpenIds()[this.registry.listOpenIds().length - 1];
      }
    }
    this.resubscribe();
    await this.postSwitchView();
    // A closed tab re-enables the row's Open in the manage form (if open).
    this.pushSessionsManager();
  }

  /** Session ids that are BUSY (streaming, or preparing a send, or draining the
   * queue) — the tab strip, the rows and the manager read this, so "busy" must
   * mean the same thing everywhere (it used to mean `streaming` only, which left
   * the destructive buttons enabled during a send preamble). */
  private workingIds(): string[] {
    return this.registry.listOpenIds().filter((id) => this.isWorking(id));
  }

  /**
   * Analyze just prepared previews (nothing written): ask ONCE whether to switch
   * to Build. This replaces the old persistent in-chat button, so the action can
   * never be clicked on a stale turn. Declining is fine — the mode button in the
   * header still switches later.
   */
  private async promptSwitchToBuild(sessionId: string): Promise<void> {
    const before = this.registry.get(sessionId);
    if (!before || before.mode === "agent") return; // already in Build (or gone)
    const ok = await this.inPanelAlert({
      kind: "confirm",
      title: "Switch to Build?",
      message:
        "Changes were prepared as previews — nothing has been written to disk yet.\n\n" +
        "Switch to Build to apply them.\n\n" +
        "Tip: restart the chat — start a NEW session and repeat your request. Applying the " +
        "changes from a clean Build context is more reliable than continuing this Analyze " +
        "transcript, where the previews can make the model think the work is already done.",
      confirmText: "Switch to Build",
    });
    if (!ok) return;
    // The session may have been closed or switched while the modal was open.
    const rt = this.registry.get(sessionId);
    if (!rt || rt.mode === "agent") return;
    // Same single path as the mode toggle: sets the agent AND persists it.
    this.setSessionMode(rt, "agent");
  }

  /** True when a session is mid-run (streaming, sending or draining its queue):
   * it must not be closed. Mirrors the condition used to guard send(). */
  private isWorking(id: string): boolean {
    return !!this.registry.get(id)?.engine.working || this.pendingQueue.isDraining(id);
  }

  /** True when a SYNCHRONOUS VACUUM would freeze something live. */
  private dbBusy(): boolean {
    return this.workingIds().length > 0 || this.registry.listOpenIds().some((id) => this.pendingQueue.isDraining(id));
  }

  /** Suggested-compaction threshold (free-page %), from the VS Code setting. */
  private vacuumThresholdPercent(): number {
    const v = workspace.getConfiguration("harny").get<number>("dbVacuumThresholdPercent");
    return typeof v === "number" && Number.isFinite(v) ? Math.min(100, Math.max(1, Math.round(v))) : 20;
  }

  /** Minimum RECLAIMABLE megabytes below which we never SUGGEST compaction. */
  private vacuumMinFreeMB(): number {
    const mb = workspace.getConfiguration("harny").get<number>("dbVacuumMinFreeMB");
    return typeof mb === "number" && Number.isFinite(mb) ? Math.max(0, Math.round(mb)) : 128;
  }

  /**
   * After a ✂ cut / session delete (and once at startup): SUGGEST compaction
   * when the DB has too many free pages. The check is O(1) (header only);
   * nothing is shown below the threshold. Skipped while a prompt is already up.
   */
  private async maybeSuggestVacuum(): Promise<void> {
    if (this.vacuumPromptOpen || !this.view) return;
    const stats = this.sessions.dbVacuumStats();
    if (stats.pageCount === 0) return;
    if (stats.ratio * 100 < this.vacuumThresholdPercent()) return;
    // Never nag for a few hundred KB: only suggest when it reclaims REAL space.
    if (stats.bytesFree < this.vacuumMinFreeMB() * 1024 * 1024) return;
    await this.openVacuumModal(stats);
  }

  /** Open the SHARED vacuum modal (auto suggestion OR the All-Sessions button). */
  private async openVacuumModal(stats: DbVacuumStats): Promise<void> {
    if (this.vacuumPromptOpen) return;
    this.vacuumPromptOpen = true;
    try {
      await this.modals.request({
        kind: "dbVacuum",
        stats,
        threshold: this.vacuumThresholdPercent(),
        minFreeMB: this.vacuumMinFreeMB(),
      });
    } finally {
      this.vacuumPromptOpen = false;
    }
  }

  /**
   * Run a compaction "a bocce ferme": a VACUUM is SYNCHRONOUS and freezes the
   * host event loop, so it waits until no session is streaming/draining a queue,
   * then reports the before/after result to the open modal.
   */
  private async runVacuum(): Promise<void> {
    if (this.dbBusy()) this.view?.webview.postMessage({ type: "dbVacuumRunning" });
    const deadline = Date.now() + (this.options.vacuumWaitMs ?? 5 * 60_000);
    while (this.dbBusy() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 1000));
    // Still busy after waiting: NEVER run a synchronous VACUUM over a live turn
    // (it would freeze the extension host mid-stream). Report that it was
    // skipped so the user can retry once the chat is idle.
    if (this.dbBusy()) {
      this.view?.webview.postMessage({ type: "dbVacuumSkipped" });
      return;
    }
    const result = this.sessions.maintain({ freeRatioThreshold: 0 });
    this.view?.webview.postMessage({ type: "dbVacuumResult", result });
  }

  /** Persist the suggested-compaction threshold (global VS Code setting). */
  private async setVacuumThreshold(percent: number): Promise<void> {
    const n = Number(percent);
    const v = Number.isFinite(n) ? Math.min(100, Math.max(1, Math.round(n))) : 20;
    await workspace.getConfiguration("harny").update("dbVacuumThresholdPercent", v, true);
    this.pushVacuumSettings();
  }

  /** Persist the minimum reclaimable MB (global VS Code setting). */
  private async setVacuumMinFreeMB(mb: number): Promise<void> {
    const n = Number(mb);
    const v = Number.isFinite(n) ? Math.min(10240, Math.max(0, Math.round(n))) : 0;
    await workspace.getConfiguration("harny").update("dbVacuumMinFreeMB", v, true);
    this.pushVacuumSettings();
  }

  /** Push both vacuum settings to the webview (footer + modal inputs). */
  private pushVacuumSettings(): void {
    this.view?.webview.postMessage({
      type: "dbVacuumSettings",
      threshold: this.vacuumThresholdPercent(),
      minFreeMB: this.vacuumMinFreeMB(),
    });
  }

  /** Push the full view state WITHOUT reloading the webview page. */
  private async postSwitchView(includeSessions = true): Promise<void> {
    if (!this.view) return;
    try {
      const active = this.activeRuntime();
      const seq = ++this.switchSeq;
      const configSeq = ++this.configSeq;
      const config = await this.buildConfig();
      // A STALER switchView must never be applied: `buildConfig` awaits, and a
      // second switch can start while this one is in flight. Posting the older
      // one LAST would pair the transcript of the current tab with the config of
      // the tab the user already left (model, mode, Parallel, window…).
      if (seq !== this.switchSeq) return;
      const live = active?.engine.projection();
      // A session can be busy BEFORE the agent streams (attachment build,
      // auto-compaction in the send preamble): switching away and back must not
      // make the working bar and the input lock disappear.
      const busy = !!active && active.engine.working;
      this.view.webview.postMessage({
        type: "switchView",
        activeId: this.activeId,
        openIds: this.registry.listOpenIds(),
        // A plain tab switch does NOT re-send the list: it is `SELECT *` on the
        // session table, and on every click it is pure waste (the list only changes
        // when a session is created, branched, renamed or closed — those paths ask
        // for it). `undefined` means "keep what you have".
        sessions: includeSessions ? this.sessionsForView() : undefined,
        messages: active ? active.agent.getMessages() : [],
        config,
        configSeq,
        switchSeq: seq,
        workingIds: this.workingIds(),
        streaming: busy,
        compacting: !!active && this.isCompacting(active.sessionId),
        pending: active ? this.pendingQueue.items(active.sessionId) : [],
        liveThinking: live?.thinking ?? "",
        liveAnswer: live?.answer ?? "",
        // The WHOLE in-flight turn (tool calls + sub-agents), so the view can
        // rebuild the bubbles the history does not contain yet.
        ...(live ? { liveTurn: live } : {}),
      });
    } catch (e) {
      debugLog("postSwitchView failed", e);
    }
  }

  resolveWebviewView(webviewView: WebviewView, _context: WebviewViewResolveContext, _token: unknown): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [Uri.joinPath(this.context!.extensionUri, "media")],
    };
    webviewView.webview.onDidReceiveMessage((msg) => this.onMessage(msg));
    this.resubscribe();
    this.refresh();
    // Measure the two walls that matter with several sessions running (event loop
    // + webview traffic). Prints nothing unless HARNY_DEBUG is set.
    this.telemetry.start();
    // Startup suggestion: cheap O(1) check once the page is up.
    this.startupVacuumTimer = setTimeout(() => void this.maybeSuggestVacuum(), 3000);
    this.startupVacuumTimer.unref?.();
  }

  /**
   * Release what outlives the panel: the telemetry probe, the coalescing timers and
   * the pending metric. VS Code disposes the provider on deactivation; without this
   * the 30 s probe kept sampling a host that was going away, and a debounced write
   * could fire against a closed store.
   */
  dispose(): void {
    this.telemetry.stop();
    if (this.configSoonTimer !== undefined) {
      clearTimeout(this.configSoonTimer);
      this.configSoonTimer = undefined;
    }
    if (this.startupVacuumTimer !== undefined) {
      clearTimeout(this.startupVacuumTimer);
      this.startupVacuumTimer = undefined;
    }
    // Last chance for the metric: the store is still open at this point.
    this.flushContextTokens();
  }

  /**
   * Open find in the transcript.
   *
   * The ⌘F/Ctrl+F keybinding is CONTRIBUTED by this extension while the view has the focus (see
   * package.json): inside a webview the key would otherwise reach VS Code's own find, which opens
   * its widget and takes the focus away from the panel. A keybinding is the only way to win: the
   * webview's `preventDefault` cannot stop the HOST from acting on the same chord.
   */
  openFind(): void {
    this.view?.webview.postMessage({ type: "openFind" });
  }

  /** Rebuild the whole view (host-side refresh after any change). */
  refresh(): void {
    if (!this.view) return;
    // A modal is OPEN: DEFER the rebuild. Replacing the page HTML wipes the
    // modal DOM, so it would flash and vanish (e.g. the "Model limits unknown"
    // alert right after a model switch — which writes config.json and triggers
    // this refresh via the config watcher). It runs when the queue drains.
    if (this.modals.hasPending()) {
      this.refreshDeferred = true;
      return;
    }
    this.refreshDeferred = false; // this run satisfies any deferred request
    // Re-apply the per-model overrides FIRST: a CONFIG edit (baseUrl / apiKey /
    // maxTokens / thinkingMode…) must take effect immediately — the composite
    // lets runtime overrides win, so a stale override would shadow the file.
    this.applyActiveModel();
    void this.buildHtml().then((html) => {
      if (this.view) this.view.webview.html = html;
    });
  }

  /**
   * Lightweight refresh for a CONFIG change (config-file watcher / `harny.*`
   * settings): re-apply the per-model overrides and push the config WITHOUT
   * rebuilding the page. A full `refresh()` here would wipe the typed prompt,
   * the scroll position and the streaming state — e.g. switching model persists
   * the choice to `config.json`, which triggers the watcher.
   */
  refreshConfig(): void {
    if (!this.view) return;
    this.applyActiveModel();
    // A server may have been REMOVED from the file (or added): the sessions that named it must
    // stop carrying a decision about something that no longer exists. This is the one place that
    // knows the config just changed, so the write happens here — and only for the rows that
    // actually differ (see reconcileToolScope).
    this.reconcileToolScopes();
    void this.pushConfig();
  }

  /**
   * Drop the MCP servers that are gone from every session's scope.
   *
   * The READ path already filters them (see the host's toolScopeFor), so behaviour is correct
   * without this; what this adds is not leaving a decision about a deleted server in the row for
   * ever. No write when nothing changes: a config edit would otherwise rewrite every session.
   */
  reconcileToolScopes(): number {
    const servers = Object.keys(this.providers.readMcpServers?.() ?? {});
    let changed = 0;
    for (const summary of this.sessions.list()) {
      const next = reconcileToolScope(summary.toolScope, { servers });
      if (!next) continue;
      this.sessions.saveSettings(summary.id, { toolScope: next });
      const rt = this.registry.get(summary.id);
      if (rt) rt.toolScope = next; // an OPEN session must not keep the stale value in memory
      changed += 1;
    }
    return changed;
  }

  /**
   * The MCP statuses as the panel needs them: each tool flagged with whether THIS session has it
   * off.
   *
   * The naming rule (sanitized `mcp__server__tool`) stays HERE, on the side that owns it. The panel
   * used to rebuild those prefixes to compare them, which is how a server named `files-extra` ended
   * up unswitchable: two spellings of the same truth, one of them wrong.
   */
  private mcpStatusesForView(): McpServerStatus[] {
    const statuses = this.options.mcp?.getStatuses() ?? [];
    const scope = this.activeRuntime()?.toolScope;
    if (!scope || scope.off.length === 0) return statuses;
    return statuses.map((status) => ({
      ...status,
      ...(status.tools
        ? {
            tools: status.tools.map((tool) => ({
              ...tool,
              ...(scope.off.includes(mcpPrefix(status.name) + sanitizeToolNamePart(tool.name)) ? { off: true } : {}),
            })),
          }
        : {}),
    }));
  }

  private async onMessage(msg: any): Promise<void> {
    debugLog("view message:", JSON.stringify(msg)?.slice(0, 120));
    const rt = this.activeRuntime();
    switch (msg.type) {
      case "switchTab":
        if (typeof msg.id === "string") await this.setActive(msg.id);
        break;
      case "closeTab":
        if (typeof msg.id === "string") await this.closeTab(msg.id);
        break;
      case "reorderTabs":
        // Drag & drop on the tab strip. The view has ALREADY moved the tab, so only
        // the host's order is updated: a postSwitchView here would rebuild the
        // transcript (and restore its scroll position) for a purely cosmetic change,
        // and every later switchView carries the new order anyway.
        if (Array.isArray(msg.ids)) {
          this.registry.reorder(msg.ids.filter((id: unknown): id is string => typeof id === "string"));
        }
        break;
      case "newSession":
        await this.createNew();
        break;
      case "openSession":
        if (typeof msg.id === "string") this.openSession(msg.id);
        break;
      case "renameSession":
        if (typeof msg.id === "string") await this.renameSession(msg.id);
        break;
      case "branchSession":
        if (typeof msg.id === "string") await this.branchSession(msg.id);
        break;
      case "branchAt":
        await this.branchAt(Number(msg.index));
        break;
      case "truncateAt":
        await this.truncateAt(Number(msg.index));
        break;
      case "deleteSession":
        if (typeof msg.id === "string") await this.deleteSession(msg.id);
        break;
      case "getAllSessions":
        // show:true — the user clicked the gear: the form opens with this data.
        this.view?.webview.postMessage(this.sessionsManagerPayload(true));
        break;
      case "searchSessions": {
        // Full-text search over session messages: reply with the matching ids.
        // `scope` (main list vs all-sessions modal) is echoed so the webview
        // routes the reply to the right filter.
        const query = typeof msg.query === "string" ? msg.query : "";
        this.view?.webview.postMessage({
          type: "sessionsSearchResult",
          query,
          scope: msg.scope === "main" ? "main" : "modal",
          matches: this.options.searchSessions?.(query) ?? [],
        });
        break;
      }
      case "sessionsManagerChangeFolder":
        if (typeof msg.id === "string") await this.changeSessionFolder(msg.id);
        break;
      case "sessionsManagerOpenFolder":
        if (typeof msg.id === "string") await this.openSessionFolder(msg.id);
        break;
      case "modalResponse": {
        if (typeof msg.id === "number") this.onPanelModalResponse(msg.id, msg.value);
        break;
      }
      case "runVacuum":
        await this.runVacuum();
        break;
      case "openVacuumModal":
        // NOT awaited: the modal stays open until the user closes it.
        void this.openVacuumModal(this.sessions.dbVacuumStats());
        break;
      case "setVacuumThreshold":
        await this.setVacuumThreshold(Number(msg.percent));
        break;
      case "setVacuumMinFreeMB":
        await this.setVacuumMinFreeMB(Number(msg.mb));
        break;
      case "getConfig":
        await this.pushConfig();
        break;
      case "getSkills":
        // Lightweight (no network): the webview re-reads the installed skills
        // when the control stack is expanded or the panel regains focus, so an
        // install/REMOVE shows up at once. Invalidate the cache to force a scan.
        this.options.skills?.invalidate();
        this.view?.webview.postMessage({ type: "skills", skills: this.skillCatalog() });
        break;
      case "getMcpServers":
        this.view?.webview.postMessage({ type: "mcpServers", data: this.mcpEditorData(), open: true });
        break;
      case "toggleMcpServer": {
        // Enable/disable ONE server from the card: persisted with the config,
        // then reconnect (a disabled server is not connected and exposes no tools).
        const name = typeof msg.name === "string" ? msg.name : "";
        const enabled = msg.enabled === true;
        const servers = this.providers.readMcpServers?.() ?? {};
        if (!name || !servers[name]) break;
        infoLog(`[mcp] toggle "${name}" enabled=${enabled}`);
        servers[name] = { ...servers[name], enabled };
        const ok = this.providers.saveMcpServers?.(servers) ?? false;
        if (ok) {
          // ONLY this server: a full pass would respawn every other npx process, and the
          // card would rewrite every row while the user is clicking in it.
          await this.options.mcp?.connect(name);
          this.view?.webview.postMessage({ type: "mcpServers", data: this.mcpEditorData() });
          void this.pushConfig();
        }
        break;
      }
      case "setMcpToolExclusions": {
        // The tools panel's Save: which tools of ONE server the model must not see.
        // Written on that server's own entry — every other key survives, because the
        // config file is the user's too (analyze, url, headers…) — then RECONNECT,
        // which is what actually rebuilds the tool list the model is offered.
        const name = typeof msg.server === "string" ? msg.server : "";
        const servers = this.providers.readMcpServers?.() ?? {};
        if (!name || !servers[name]) break;
        // `msg` is untyped JSON from the webview: read it as `unknown[]` FIRST, so the
        // type predicate below is what produces the string[] (filtering `any[]` does not
        // narrow, and would hand `unknown[]` to the config writer).
        const rawExclude: unknown = msg.exclude;
        const excludeList: unknown[] = Array.isArray(rawExclude) ? rawExclude : [];
        const exclude = excludeList.filter((t: unknown): t is string => typeof t === "string" && t.trim() !== "");
        // `exclude` is ACCEPTED and IGNORED: which tools a conversation may use is the SESSION's
        // scope now (see setToolScope), so writing it globally here would make one panel decide
        // for every session — the exact bug this change removes. The key stays in the file only as
        // the SEED a new session starts from (see seededToolOffList).
        // The per-TOOL Analyze list travels with it, and with the OPPOSITE polarity: an include
        // list of tools the user declares read-only (default-deny — a tool the server adds
        // tomorrow is not silently allowed in Analyze).
        const rawAnalyze: unknown = msg.analyze;
        const analyzeList: unknown[] = Array.isArray(rawAnalyze) ? rawAnalyze : [];
        // Trimmed: a name with a stray space would never match the tool it names.
        const analyze = analyzeList
          .filter((t: unknown): t is string => typeof t === "string" && t.trim() !== "")
          .map((t) => t.trim());
        const current = servers[name];
        void exclude;
        // An EMPTY list is deleted, not written as []: a server with nothing declared must look
        // untouched in the file (see McpServerCommon.analyzeTools).
        const analyzeTools = analyze.length > 0 ? [...new Set(analyze)] : undefined;
        if (analyzeTools) current.analyzeTools = analyzeTools;
        else delete current.analyzeTools;
        infoLog(
          `[mcp] "${name}": ${analyzeTools?.length ?? 0} tool(s) declared read-only in Analyze ` +
            "(the session's scope decides which ones the model sees)",
        );
        servers[name] = current;
        // The EXCLUDE list is a connect-time decision (it changes what is REGISTERED), so it needs
        // a reconnect; the per-tool Analyze list is read live and does not — but they are saved
        // together, and one reconnect for both is cheaper than two paths that can disagree.
        const ok = this.providers.saveMcpServers?.(servers) ?? false;
        if (ok) {
          // NO RECONNECT. What changed is the per-tool ANALYZE declaration, which is read live at
          // every call (see McpManager's `declaredTools`), and the tools themselves stay
          // registered because which of them a session may use is the session's scope. Saving the
          // shields used to respawn the server for nothing — and emptied the registry while it
          // did, which is how a save could make the tool count flicker to zero.
          this.view?.webview.postMessage({ type: "mcpServers", data: this.mcpEditorData() });
          void this.pushConfig();
        }
        this.view?.webview.postMessage({ type: "mcpToolExclusionsSaved", server: name, ok });
        break;
      }
      case "saveMcpServers": {
        const servers =
          msg.servers && typeof msg.servers === "object" ? (msg.servers as Record<string, McpServerConfig>) : {};
        // A REMOVAL breaks an in-flight turn that is using that server: its tools leave the
        // registry immediately, and the model may be about to call one (the call would come back as
        // "Unknown tool"). So a removal is refused WHILE a RUNNING session has that server on —
        // and only then: a server nobody is using can be removed in a second, and one used by a
        // session that is idle can too (it will simply not be there when that session next runs).
        // Editing the file by hand skips this, which is why the graceful path stays tested.
        const removed = Object.keys(this.providers.readMcpServers?.() ?? {}).filter((name) => !(name in servers));
        const busyUsing = removed.flatMap((name) =>
          this.registry
            .listOpenIds()
            .filter((id) => {
              if (!this.isWorking(id)) return false;
              const scope = this.registry.get(id)?.toolScope;
              // An UNDECLARED scope ALLOWS every server (the legacy meaning, see toolScopeAllows),
              // so a working session without one may well be using this very server — the brake
              // must hold for it too, or it would be missing exactly where it matters most.
              return !scope || scope.mcp.includes(name);
            })
            .map((id) => ({ id, name })),
        );
        if (busyUsing.length > 0) {
          const [first] = busyUsing;
          this.view?.webview.postMessage({
            type: "mcpSaved",
            ok: false,
            reason: `Stop the run first — a session is using "${first.name}" right now`,
          });
          break;
        }
        const ok = this.providers.saveMcpServers?.(servers) ?? false;
        if (ok) {
          // Reconnect + re-register the MCP tools, then refresh the card/modal.
          await this.options.mcp?.connect();
          this.view?.webview.postMessage({ type: "mcpServers", data: this.mcpEditorData() });
          void this.pushConfig();
        }
        this.view?.webview.postMessage({ type: "mcpSaved", ok });
        break;
      }
      case "testMcpServer": {
        const cfg = msg.server as McpServerConfig | undefined;
        const isStdio = !!cfg && typeof cfg === "object" && "command" in cfg && !!cfg.command;
        const isHttp = !!cfg && typeof cfg === "object" && "url" in cfg && !!cfg.url;
        if (!isStdio && !isHttp) {
          this.view?.webview.postMessage({
            type: "mcpTested",
            ok: false,
            error: "A server needs 'command' (stdio) or 'url' (http).",
          });
          break;
        }
        const client: McpClient = isStdio
          ? new McpStdioClient({
              command: (cfg as McpStdioServerConfig).command,
              args: (cfg as McpStdioServerConfig).args,
              env: (cfg as McpStdioServerConfig).env,
              timeoutMs: 15000,
            })
          : new McpHttpClient({
              url: (cfg as McpHttpServerConfig).url,
              headers: (cfg as McpHttpServerConfig).headers,
              timeoutMs: 15000,
            });
        try {
          await client.start();
          const infos = await client.listTools();
          this.view?.webview.postMessage({
            type: "mcpTested",
            ok: true,
            toolCount: infos.length,
            tools: infos.map((t) => t.name),
          });
        } catch (e) {
          this.view?.webview.postMessage({
            type: "mcpTested",
            ok: false,
            error: e instanceof Error ? e.message : String(e),
          });
        } finally {
          client.close();
        }
        break;
      }
      case "getProvidersEditor":
        this.view?.webview.postMessage({
          type: "providersEditor",
          data: this.providers.readProvidersEditor(),
        });
        break;
      case "saveProviders": {
        const data = msg.data;
        if (!data || typeof data !== "object") break;
        // A provider edit rewrites the endpoint/key that EVERY open run resolves on
        // its NEXT request: while anything streams, that would silently change a run
        // already in flight (the gears stay usable — the session manager does not
        // touch runs — but this save does).
        if (this.workingIds().length > 0) {
          await this.inPanelAlert({
            kind: "info",
            title: "Sessions still working",
            message:
              "A session is still working: changing providers now would change the endpoint or key of a run already in flight.\n" +
              "Stop the running sessions, then save.",
            confirmText: "OK",
          });
          this.view?.webview.postMessage({ type: "providersSaved", ok: false });
          break;
        }
        // The modal no longer edits the legacy global cap: carry the existing
        // config value through so a providers save never wipes it.
        const merged: ProviderEditorData = {
          ...(data as ProviderEditorData),
          maxParallelSubAgents:
            (data as ProviderEditorData).maxParallelSubAgents ?? this.config.get().maxParallelSubAgents,
        };
        const ok = this.providers.saveProvidersEditor(merged);
        if (ok) {
          // Refresh the dropdown/thinking state from the new config immediately.
          void this.pushConfig();
        }
        this.view?.webview.postMessage({ type: "providersSaved", ok });
        break;
      }
      case "exportProviders": {
        const data = this.providers.exportProviders();
        const payload = JSON.stringify({ harny: 1, ...data }, null, 2) + "\n";
        const target = await window.showSaveDialog({
          saveLabel: "Export",
          filters: { "Harny providers": ["json"] },
          defaultUri: Uri.file("harny-providers.json"),
        });
        if (!target) break;
        try {
          await workspace.fs.writeFile(target, Buffer.from(payload, "utf8"));
          this.view?.webview.postMessage({ type: "providersExported", ok: true, path: target.fsPath });
        } catch (e) {
          this.view?.webview.postMessage({ type: "providersExported", ok: false, error: (e as Error)?.message });
        }
        break;
      }
      case "importProviders": {
        const picked = await window.showOpenDialog({
          canSelectMany: false,
          openLabel: "Import",
          filters: { "Harny providers": ["json", "jsonc"] },
        });
        const uri = picked?.[0];
        if (!uri) break;
        try {
          const text = Buffer.from(await workspace.fs.readFile(uri)).toString("utf8");
          const parsed = JSON.parse(preprocessJsonc(text));
          const ok = this.providers.importProviders(parsed, "merge");
          this.view?.webview.postMessage({ type: "providersImported", ok, path: uri.fsPath });
          if (ok) {
            // Reload the editor with the merged providers + refresh the picker.
            this.view?.webview.postMessage({ type: "providersEditor", data: this.providers.readProvidersEditor() });
            void this.pushConfig();
          }
        } catch (e) {
          this.view?.webview.postMessage({ type: "providersImported", ok: false, error: (e as Error)?.message });
        }
        break;
      }
      case "testProvider": {
        const data = msg.data ?? {};
        const baseUrl = typeof data.baseUrl === "string" ? data.baseUrl.trim() : "";
        if (!baseUrl) break;
        const apiKey = typeof data.apiKey === "string" ? data.apiKey : undefined;
        try {
          const models = await this.modelList.fetchModels({ baseUrl, apiKey });
          this.view?.webview.postMessage({ type: "providersTested", ok: true, models });
        } catch (e) {
          this.view?.webview.postMessage({
            type: "providersTested",
            ok: false,
            error: e instanceof Error ? e.message : String(e),
          });
        }
        break;
      }
      case "setModel": {
        const rt = this.activeRuntime();
        if (!rt || typeof msg.model !== "string" || !msg.model.trim()) break;
        const model = msg.model.trim();
        const provider = typeof msg.provider === "string" && msg.provider.trim() ? msg.provider.trim() : undefined;
        rt.model = model;
        rt.modelProvider = provider;
        // Reasoning provider: default to Medium only when the session has no
        // explicit level. NON-reasoning provider: drop a stale level so it is
        // never sent as an unsupported param.
        if (provider) {
          const entry = this.providers.getProvider(provider);
          // The PROVIDER's declared thinking mode is authoritative here: the
          // composite config may still carry the PREVIOUS provider's override.
          const mode = entry?.thinkingMode;
          const reasoning = mode === "bool" || mode === "effort" || mode === "type" || mode === "reasoning";
          if (!reasoning) rt.thinkingLevel = undefined;
          else if (!rt.thinkingLevel) rt.thinkingLevel = "medium";
        }
        // If the host reports this model's limits, adopt them (the compaction
        // ceiling + the output cap follow the real model). When the host is
        // unreachable the limits stay UNKNOWN, so the DEFAULT fallback below
        // applies (never the previous model's values).
        let adoptedCtx: number | undefined;
        let adoptedOut: number | undefined;
        if (provider) {
          try {
            const infos = await this.fetchHostModels(provider);
            const info = infos.find((m) => m.id === model);
            if (info?.contextLength && info.contextLength > 0)
              adoptedCtx = clampAdoptedContextWindow(info.contextLength);
            if (info?.maxOutputTokens && info.maxOutputTokens > 0)
              adoptedOut = clampAdoptedOutputTokens(info.maxOutputTokens);
          } catch {
            /* host unreachable: leave the limits unknown (default below) */
          }
        }
        // KNOWN model: adopt its real limits. UNKNOWN model: fall back to the
        // DEFAULTS (context 128k / output = the provider's maxTokens or 8 192)
        // — never keep the PREVIOUS model's values.
        const entryMaxTokens = provider ? this.providers.getProvider(provider)?.maxTokens : undefined;
        // A model the USER already sized (answered in the "Model limits unknown"
        // form): that answer outranks the provider default — otherwise coming back
        // to a local model would re-ask and throw away what was typed. What the
        // HOST reports still wins: it is the model's own declaration.
        const answered = provider ? this.userLimits.get(`${provider}|${model}`) : undefined;
        rt.contextWindow = adoptedCtx ?? answered?.context ?? DEFAULT_CONTEXT_WINDOW;
        rt.outputTokens =
          adoptedOut ??
          answered?.output ??
          (typeof entryMaxTokens === "number"
            ? Math.min(MAX_OUTPUT_TOKENS, Math.max(1, Math.round(entryMaxTokens)))
            : DEFAULT_OUTPUT_TOKENS);
        if (adoptedCtx && provider) this.modelsDevContext.set(`${provider}|${model}`, adoptedCtx);
        if (adoptedOut && provider) this.modelsDevOutput.set(`${provider}|${model}`, adoptedOut);
        this.sessions.saveSettings(rt.sessionId, {
          model,
          ...(provider ? { modelProvider: provider } : {}),
          // Always sent so switching to a NON-reasoning provider CLEARS a stale
          // level instead of leaving it in the DB.
          thinkingLevel: rt.thinkingLevel,
          contextWindow: rt.contextWindow,
          outputTokens: rt.outputTokens,
        });
        // ALSO persist the choice as the config default (top-level `model`,
        // comment-preserving): the README's promise, and it is what new
        // consumers/other windows read. The session value above still wins at
        // runtime.
        this.providers.saveModelSelection?.(model, provider);
        this.modelSelector.set(this.computeOverrides(model, provider));
        // Lightweight config push (no full HTML rebuild: the typed prompt,
        // scroll and streaming state are preserved).
        void this.pushConfig();
        // The host did not report one/both limits (e.g. OpenCode Go): resolve
        // them from models.dev in the background and update the panel.
        if (!adoptedCtx || !adoptedOut) void this.ensureModelLimits(rt, model, provider, true, adoptedCtx, adoptedOut);
        break;
      }

      case "setThinkingLevel": {
        const rt = this.activeRuntime();
        if (!rt || !isThinkingLevel(msg.level)) break;
        rt.thinkingLevel = msg.level as ThinkingLevel;
        this.commitSetting(rt, () =>
          this.sessions.saveSettings(rt.sessionId, { thinkingLevel: msg.level as ThinkingLevel }),
        );
        break;
      }

      case "setMode": {
        const rt = this.activeRuntime();
        if (msg.mode !== "analyze" && msg.mode !== "agent") break;
        if (!rt) {
          // No active runtime (raced with a tab switch/close): re-push the host's
          // truth so the UI cannot stay optimistically on a mode the host will
          // not use on the next send.
          void this.pushConfig();
          break;
        }
        this.setSessionMode(rt, msg.mode);
        break;
      }

      case "setToolScope": {
        // PER-SESSION tool scope: which MCP servers this conversation uses and which built-in tools
        // it turned off. Written on the session (not the global config: installing a server is a
        // machine fact, USING it is this conversation's decision) and read live by the agent, so
        // the next turn already sees it — no reconnect, no restart.
        const rt = this.activeRuntime();
        if (!rt) break;
        // A MISSING or malformed payload must change NOTHING: `normalizeToolScope(undefined)` is
        // `undefined`, which means "nothing declared" — the ONE value that allows every server. So
        // accepting it here would turn a garbled message into "this session may use everything".
        if (!msg.scope || typeof msg.scope !== "object") {
          void this.pushConfig(); // re-state the host's truth, so an optimistic UI cannot stick
          break;
        }
        const scope = normalizeToolScope(msg.scope) ?? { mcp: [], off: [] };
        rt.toolScope = scope;
        this.commitSetting(rt, () => this.sessions.saveSettings(rt.sessionId, { toolScope: scope }), false);
        void this.pushConfig();
        break;
      }

      case "setMcpToolSelection": {
        // The tools panel's Save, as INTENT: which of one server's tools this session may use. The
        // host turns that into scope names (sanitized prefix, merge with the other decisions) —
        // the webview no longer knows how a tool is spelled on the wire.
        const server = typeof msg.server === "string" ? msg.server : "";
        const rt = this.activeRuntime();
        if (!server || !rt) break;
        const all =
          (this.options.mcp?.getStatuses() ?? []).find((s) => s.name === server)?.tools?.map((t) => t.name) ?? [];
        const wanted = new Set(
          (Array.isArray(msg.enabled) ? (msg.enabled as unknown[]) : []).filter(
            (n): n is string => typeof n === "string" && n.trim() !== "",
          ),
        );
        const prefix = mcpPrefix(server);
        const previous = rt.toolScope ?? { mcp: [], off: [] };
        const off = [
          ...previous.off.filter((name) => !name.startsWith(prefix)),
          ...all.filter((name) => !wanted.has(name)).map((name) => prefix + sanitizeToolNamePart(name)),
        ];
        const mcp = previous.mcp.filter((name) => name !== server);
        // A server counts as ON as soon as one of its tools is: an empty selection means the
        // session is not using it at all.
        if (all.some((name) => wanted.has(name))) mcp.push(server);
        rt.toolScope = { mcp, off };
        this.commitSetting(rt, () => this.sessions.saveSettings(rt.sessionId, { toolScope: rt.toolScope }), false);
        void this.pushConfig();
        break;
      }

      case "setParallel": {
        if (typeof msg.parallel !== "boolean") break;
        const rt = this.activeRuntime();
        if (!rt) break;
        // PER-SESSION Parallel switch (persisted): applies to this session's
        // agent now and is re-synced at send time.
        rt.parallel = msg.parallel === true ? true : undefined;
        rt.agent.setDelegation(rt.parallel === true);
        this.commitSetting(rt, () => this.sessions.saveSettings(rt.sessionId, { parallel: rt.parallel }), false);
        break;
      }

      case "setMaxParallelSubAgents": {
        const rt = this.activeRuntime();
        if (!rt) break;
        // Per-session cap: a number >= 0 (0 = explicitly no cap); anything else
        // clears the override so the config default (then 4) applies.
        const value =
          typeof msg.value === "number" && Number.isFinite(msg.value) && msg.value >= 0
            ? Math.trunc(msg.value)
            : undefined;
        rt.maxParallelSubAgents = value;
        rt.agent.setMaxParallelSubAgents(value);
        this.commitSetting(rt, () => this.sessions.saveSettings(rt.sessionId, { maxParallelSubAgents: value }), false);
        break;
      }

      case "setLoopGuard": {
        const rt = this.activeRuntime();
        if (!rt) break;
        // Per-session Loop Guard sensitivity; undefined clears the override (= medium).
        const level = normalizeLoopGuardSensitivity(msg.value);
        rt.loopGuard = level;
        // Picking a level RESETS the saved field overrides: the preset becomes
        // the new baseline (the UI repopulates its fields from it).
        rt.loopGuardOverrides = undefined;
        this.applyLoopGuard(rt);
        this.commitSetting(
          rt,
          () => this.sessions.saveSettings(rt.sessionId, { loopGuard: level, loopGuardParams: undefined }),
          false,
        );
        break;
      }

      case "setLoopGuardOverrides": {
        const rt = this.activeRuntime();
        if (!rt) break;
        // Tuning from the Loop Guard fields: clamped to the editable ranges,
        // applied to the agent AND SAVED on the session (persisted per session).
        rt.loopGuardOverrides = clampLoopGuardOverrides(msg.overrides);
        this.applyLoopGuard(rt);
        this.commitSetting(
          rt,
          () => this.sessions.saveSettings(rt.sessionId, { loopGuardParams: rt.loopGuardOverrides }),
          false,
        );
        break;
      }

      case "setLoopGuardResponse": {
        const rt = this.activeRuntime();
        if (!rt) break;
        // Opt-in final-answer guard: a boolean persisted on the session.
        const value = msg.value === true;
        rt.loopGuardResponse = value;
        this.applyLoopGuard(rt);
        this.commitSetting(rt, () => this.sessions.saveSettings(rt.sessionId, { loopGuardResponse: value }), false);
        break;
      }

      case "compact": {
        const r = this.activeRuntime();
        if (!r || this.isCompacting(r.sessionId)) break;
        const ok = await this.inPanelAlert({
          kind: "confirm",
          title: "Compact context",
          message:
            "Run context compaction now?\n" +
            "The older messages leave the context window and a summary takes their place.\n" +
            "The transcript keeps them, readable and searchable.",
          confirmText: "Compact",
        });
        if (!ok) break;
        await this.compactNow(r);
        break;
      }

      case "setContextWindow": {
        const rt = this.activeRuntime();
        if (!rt) break;
        const value = toContextWindow(msg.value);
        rt.contextWindow = value;
        // Context window does not affect the per-model overrides: skip recompute.
        this.commitSetting(rt, () => this.sessions.saveSettings(rt.sessionId, { contextWindow: value }), false);
        break;
      }
      case "setOutputTokens": {
        const rt = this.activeRuntime();
        if (!rt) break;
        const value = toOutputTokens(msg.value);
        rt.outputTokens = value;
        // Re-apply the active overrides so the runtime config carries maxTokens.
        this.commitSetting(rt, () => this.sessions.saveSettings(rt.sessionId, { outputTokens: value }));
        break;
      }
      case "setCompactionThreshold": {
        const rt = this.activeRuntime();
        if (!rt) break;
        const value = toCompactionThresholdPercent(msg.value);
        rt.compactionThresholdPercent = value;
        // The landing point has a DERIVED upper bound (threshold−1): an explicit value at or
        // above the new trigger would free nothing, so it follows the trigger down.
        const target =
          rt.compactionTargetPercent !== undefined
            ? clampTargetPercent(rt.compactionTargetPercent, value, this.targetFloorFor(rt))
            : undefined;
        if (target !== undefined) rt.compactionTargetPercent = target;
        // Threshold only affects auto-compaction, never the per-model overrides.
        this.commitSetting(
          rt,
          () =>
            this.sessions.saveSettings(rt.sessionId, {
              compactionThresholdPercent: value,
              ...(target !== undefined ? { compactionTargetPercent: target } : {}),
            }),
          false,
        );
        break;
      }
      case "setCompactionTarget": {
        const rt = this.activeRuntime();
        if (!rt) break;
        // MISSING (the Auto button) CLEARS the override, so the landing point follows the
        // trigger again. 0 is a REAL choice — "only the summary remains" — and so is any other
        // reachable value, clamped below the trigger and above the derived floor.
        const thresholdPercent = this.compactionSettings(rt).thresholdPercent;
        const value =
          msg.value === undefined || msg.value === null
            ? undefined
            : toTargetPercent(msg.value, thresholdPercent, this.targetFloorFor(rt));
        rt.compactionTargetPercent = value;
        this.commitSetting(
          rt,
          () => this.sessions.saveSettings(rt.sessionId, { compactionTargetPercent: value }),
          false,
        );
        break;
      }
      case "previewCompaction":
        this.postCompactionPreview(msg);
        break;
      case "setSamplerMode": {
        const rt = this.activeRuntime();
        if (!rt) break;
        const mode = msg.mode === "topP" ? "topP" : "temperature";
        rt.sampler = mode;
        // Switching sampler ALWAYS resets the shared value to Auto (never a
        // number interpreted on the wrong scale) — clear both stored values
        // and runtime fields, all in a single atomic write.
        const resetTemperature = rt.temperature !== undefined;
        const resetTopP = rt.topP !== undefined;
        if (resetTemperature) rt.temperature = undefined;
        if (resetTopP) rt.topP = undefined;
        this.commitSetting(rt, () =>
          this.sessions.saveSettings(rt.sessionId, {
            sampler: mode,
            ...(resetTemperature ? { temperature: undefined } : {}),
            ...(resetTopP ? { topP: undefined } : {}),
          }),
        );
        break;
      }
      case "setSamplerValue": {
        const rt = this.activeRuntime();
        if (!rt) break;
        // The shared stepper value lands on the ACTIVE sampler's field; the
        // clamp/scale follows the current radio selection.
        const active = rt.sampler === "topP" ? "topP" : "temperature";
        if (active === "topP") {
          const value = toTopP(msg.value);
          rt.topP = value;
          this.commitSetting(rt, () => this.sessions.saveSettings(rt.sessionId, { topP: value }));
        } else {
          const value = toTemperature(msg.value);
          rt.temperature = value;
          this.commitSetting(rt, () => this.sessions.saveSettings(rt.sessionId, { temperature: value }));
        }
        break;
      }
      case "setPresencePenalty": {
        const rt = this.activeRuntime();
        if (!rt) break;
        const value = toTemperature(msg.value); // same 0–2, one-decimal clamp
        rt.presencePenalty = value;
        this.commitSetting(rt, () => this.sessions.saveSettings(rt.sessionId, { presencePenalty: value }));
        break;
      }
      case "setFrequencyPenalty": {
        const rt = this.activeRuntime();
        if (!rt) break;
        const value = toTemperature(msg.value); // same 0–2, one-decimal clamp
        rt.frequencyPenalty = value;
        this.commitSetting(rt, () => this.sessions.saveSettings(rt.sessionId, { frequencyPenalty: value }));
        break;
      }
      case "send":
        // The run SEQUENCE (lock, queue, status, refresh) lives in the session's
        // engine; this route only hands it the port (services + view posts).
        if (rt) await rt.engine.send(msg as SendIntent, this.enginePort(rt));
        break;
      case "abort":
        if (rt) await rt.engine.abort(this.enginePort(rt));
        break;
      case "abortSubAgent":
        // Stop ONE sub-agent (its Delegate bubble), leaving the run alive. The
        // orchestrator still receives that Delegate's tool result (interrupted)
        // so it can continue with the remaining work.
        if (rt && typeof msg.toolCallId === "string") {
          // Record the request FIRST: a rebuild must keep the ⏹ state on that
          // bubble instead of resurrecting an enabled abort button.
          rt.engine.live.markAbortRequested(msg.toolCallId);
          rt.agent.abortSubAgent(msg.toolCallId);
        }
        break;
      case "cancelPending":
        // Drop a queued/steer message the user changed their mind about.
        if (rt && typeof msg.id === "string") this.pendingQueue.cancel(rt, msg.id);
        break;
      case "setPendingMode":
        // Convert a pending message between queue and steer. Not a cosmetic flip:
        // the two are delivered at different MOMENTS (see PendingInputQueue.setMode).
        if (rt && typeof msg.id === "string" && (msg.mode === "steer" || msg.mode === "queue")) {
          this.pendingQueue.setMode(rt, msg.id, msg.mode);
        }
        break;
      case "pickFiles":
        if (this.view) {
          const files = await this.attachments.pick();
          this.view.webview.postMessage({ type: "attachments", files });
        }
        break;
      case "attachPath": {
        // A pasted/dropped absolute path or file:// URI: attach it if it exists.
        const local = toLocalPath(String(msg.path ?? ""));
        const files = local ? this.attachments.fromPaths([local]) : [];
        this.view?.webview.postMessage({ type: "attachments", files });
        break;
      }
      case "dragDebug": {
        // Diagnostics: what a drag & drop actually delivered (Output > Harny).
        infoLog("webview drop:", JSON.stringify(msg.detail ?? {}));
        break;
      }
    }
  }

  private activeRuntime(): SessionRuntime | undefined {
    return this.activeId ? this.registry.get(this.activeId) : undefined;
  }

  /**
   * Shared compaction run — the SAME routine the manual Compact button has
   * always executed (bubble in chat, full UI block while the summary runs,
   * note at the end). Auto-compaction just triggers it. UI messages reach
   * only the ACTIVE tab; a background session's compaction stays silent.
   */
  private async compactNow(rt: SessionRuntime, signal?: AbortSignal): Promise<void> {
    rt.engine.beginCompaction();
    const isActive = this.activeId === rt.sessionId;
    if (isActive) {
      this.view?.webview.postMessage({ type: "compactStart" });
      this.view?.webview.postMessage({ type: "status", active: true, message: "Compacting…" });
    }
    let compacted = false;
    try {
      compacted = await this.performCompaction(rt, signal);
    } finally {
      rt.engine.endCompaction();
      if (isActive) {
        // Re-render the transcript so the SYNTHETIC user prompt (orange) +
        // assistant response that replaced the summarized span are visible.
        this.refreshTranscript(rt);
        // The card it just rendered is the HEAD of the window, i.e. above the view: the
        // same pointer the automatic path leaves (see addCompactedHint in the webview).
        this.view?.webview.postMessage({ type: "compactDone", ok: compacted });
        this.view?.webview.postMessage({ type: "status", active: false });
      }
    }
    // Update the metrics immediately via a lightweight config push (no full
    // HTML rebuild, so the user's input/scroll are preserved).
    if (isActive) this.pushConfigSoon();
  }

  /**
   * Mid-run auto-compaction, invoked by the agent at every TURN BOUNDARY. If
   * the context threshold is exceeded, compact the session in place and let the
   * agent resume with the compacted history (the run continues). The global
   * "working" status is deliberately NOT touched: the agent is still running.
   */
  async maybeCompactDuringRun(sessionId: string, signal?: AbortSignal): Promise<void> {
    const rt = this.registry.get(sessionId);
    if (!rt || this.isCompacting(rt.sessionId)) return;
    // Re-clamp the output budget at EVERY turn boundary: the context grows
    // during the run, so what fitted at the start may not fit now.
    this.applySessionBudget(rt);
    if (!this.needsAutoCompact(rt)) return;
    await this.compactDuringRun(rt, signal);
  }

  private async compactDuringRun(rt: SessionRuntime, signal?: AbortSignal): Promise<void> {
    rt.engine.beginCompaction();
    const isActive = this.activeId === rt.sessionId;
    if (isActive) this.view?.webview.postMessage({ type: "compactStart" });
    let compacted = false;
    try {
      compacted = await this.performCompaction(rt, signal);
    } catch (e: any) {
      infoLog("mid-run auto-compaction failed; continuing:", e?.message || String(e));
    } finally {
      rt.engine.endCompaction();
      if (isActive) {
        // ALIGNED with the manual path (`compactNow`): a compaction has a VISIBLE result —
        // the divider and the summary card — and this path used to leave it for the next
        // unrelated refresh, showing a stand-in bubble in the meantime. The webview is
        // built for exactly this ("A refresh can land MID-RUN (a compaction, …)") and
        // restores the in-flight stream, so rebuilding cannot disturb the running turn.
        if (compacted) this.refreshTranscript(rt);
        // Still NO `status` posts: the working indicator must keep showing, because the
        // run is still in flight. After a rebuild `compactDone` is a no-op for the bubble
        // (the refresh handler already dropped `compactionEl`) — what it still does is
        // leave the pointer to the card where the reader is (see addCompactedHint).
        this.view?.webview.postMessage({ type: "compactDone", ok: compacted });
      }
    }
    if (isActive) this.pushConfigSoon();
  }

  /**
   * Effective compaction settings for a runtime: the shared defaults overlaid
   * with the session's own threshold % (first run = DEFAULT_COMPACTION 80).
   */
  private compactionSettings(rt: SessionRuntime): CompactionSettings {
    const base = this.options.compaction ?? DEFAULT_COMPACTION;
    const thresholdPercent =
      rt.compactionThresholdPercent ?? base.thresholdPercent ?? DEFAULT_COMPACTION.thresholdPercent;
    // AUTO (no session value) lands at a QUARTER of the trigger — a share of the window,
    // derived from the other knob. An explicit value is clamped below the trigger and above
    // the derived floor (see targetFloorFor).
    const targetPercent = clampTargetPercent(
      rt.compactionTargetPercent ?? base.targetPercent ?? autoTargetPercent(thresholdPercent),
      thresholdPercent,
    );
    return { ...base, thresholdPercent, targetPercent };
  }

  /** The landing % this session actually uses (see {@link compactionSettings}). */
  private targetPercentFor(rt: SessionRuntime): number {
    const settings = this.compactionSettings(rt);
    return settings.targetPercent ?? autoTargetPercent(settings.thresholdPercent);
  }

  /**
   * The DERIVED floor for an EXPLICIT landing point: the fill the checkpoint and the last
   * complete turn already occupy. Below it an explicit number means less than the structure
   * allows anyway, so there is no constant to defend — the floor moves with the session.
   */
  private targetFloorFor(rt: SessionRuntime): number {
    const usable = usableContext(this.budgetWindow(rt), this.budgetReserve(rt));
    const all = rt.history.all();
    const messages = all.slice(checkpointStart(all));
    if (messages.length === 0) return 0;
    // Target 0 = the STRUCTURAL minimum (the last complete turn): its checkpoint + tail is
    // the smallest fill this session can land at.
    const { plan, summaryBudgetTokens } = planForTarget(messages, 0, this.configuredOutputTokens(rt));
    return minExplicitTargetPercent(usable, summaryBudgetTokens, estimateTokens(serializeConversation(plan.kept)));
  }

  /**
   * True when the runtime's context fill exceeds the auto-compaction threshold.
   * Provider-reported usage is authoritative when present; the current
   * transcript estimate is always taken into account (as a floor) so a
   * provider that does not report usage still triggers. New sessions have no
   * explicit window yet — the shared DEFAULT_CONTEXT_WINDOW applies (the same
   * one the metrics UI shows).
   */
  private needsAutoCompact(rt: SessionRuntime): boolean {
    return this.needsCompact(rt, rt.history.conversation(), rt.contextTokens ?? 0);
  }

  /**
   * Does this conversation have to be compacted before the next request?
   *
   * ONE threshold for every conversation that runs on this session: the agent's own and
   * a sub-agent's (which is heavier: unbounded, full of big reads). `knownTokens` is what
   * the provider last reported for that conversation, when it is the session's.
   *
   * The threshold applies to the USABLE budget, not to the raw window: the provider
   * counts `input + max_tokens` against the window, so an input that reaches the
   * threshold on the raw window is already past the limit. (1M window / 384k output: the
   * request died at 63.4% while the auto-compact waited for 80% — the compaction could
   * never fire when it was needed.)
   */
  private needsCompact(rt: SessionRuntime, messages: ChatMessage[], knownTokens = 0): boolean {
    if (!this.options.compactor) return false;
    const window = clampContextWindow(rt.contextWindow ?? DEFAULT_CONTEXT_WINDOW);
    const tokens = Math.max(knownTokens, estimateTokens(serializeConversation(messages)));
    return shouldCompact(tokens, usableContext(window, this.budgetReserve(rt)), this.compactionSettings(rt));
  }

  /**
   * The output budget the session ASKS for: the per-session override, else the
   * provider entry's declared max output, else the config default. This is the
   * number the context math must reserve — exactly the value
   * {@link computeOverrides} sends when nothing has to be clamped.
   */
  private configuredOutputTokens(rt?: SessionRuntime): number {
    if (typeof rt?.outputTokens === "number") return clampAdoptedOutputTokens(rt.outputTokens);
    const entry = rt?.modelProvider ? this.providers.getProvider(rt.modelProvider) : undefined;
    if (typeof entry?.maxTokens === "number") {
      return Math.min(MAX_OUTPUT_TOKENS, Math.max(1, Math.round(entry.maxTokens)));
    }
    const cfg = this.config.get().maxTokens;
    return typeof cfg === "number" && cfg > 0 ? Math.round(cfg) : DEFAULT_OUTPUT_TOKENS;
  }

  /**
   * The window that governs the CONTEXT MATH for this session. The bar's base,
   * the compaction threshold and the output clamp all read it from HERE, so they
   * cannot disagree — a bar saying "100%" while the trigger still waits for 80%
   * is exactly the class of bug this avoids.
   */
  private budgetWindow(rt?: SessionRuntime): number {
    return clampContextWindow(rt?.contextWindow ?? DEFAULT_CONTEXT_WINDOW);
  }

  /**
   * The reserve used by the CONTEXT MATH (soglia + barra): the configured
   * output budget, capped at half the window so a contradictory configuration
   * (max_tokens ≥ window) cannot leave a negative budget. The cap is only about
   * keeping the math sane — the real protection is the request clamp below.
   */
  private budgetReserve(rt?: SessionRuntime): number {
    return Math.max(
      MIN_OUTPUT_TOKENS,
      Math.min(this.configuredOutputTokens(rt), Math.floor(this.budgetWindow(rt) / 2)),
    );
  }

  /**
   * The output budget the NEXT request may actually use: the configured one,
   * capped by the room left after the input (`input + max_tokens ≤ window`).
   * Never raised above the configured value, and never below the floor — a
   * session with no room left is a compaction problem, not an output problem.
   */
  private outputBudgetFor(rt?: SessionRuntime, configured?: number): number {
    const window = this.budgetWindow(rt);
    // The margin absorbs the difference between our ESTIMATE and the provider's
    // real tokenizer (plus the tokens a request adds on its own), so it must not
    // be a bigger share of a small window than of a big one: a fixed 8192 is 8% of
    // a 100k model but 100% of an 8k one, where it would leave no room at all.
    // Scaled, and never more than the absolute value it was tuned at.
    const margin = Math.min(REQUEST_SAFETY_MARGIN, Math.floor(window * REQUEST_SAFETY_MARGIN_SHARE));
    const room = Math.max(MIN_OUTPUT_TOKENS, window - (rt?.contextTokens ?? 0) - margin);
    return Math.min(configured ?? this.configuredOutputTokens(rt), room);
  }

  /**
   * Apply the per-turn output clamp to the runtime config, so the request that
   * is about to be sent can never ask for more than the window has left.
   * Without this, a fixed `max_tokens` makes the provider reject the WHOLE
   * request once the input grows (666.820 in + 384.000 out = 1.050.820 on a
   * 1.048.576 window → 400 invalid_request_error, the run dies). The clamp is
   * silent and never touches the UI: the output slider keeps showing the value
   * the user chose.
   *
   * Two deliberate properties:
   *  · it is written on EVERY call (not only when it bites), so a session whose
   *    budget fits again — after a compaction, after a model switch — is not
   *    left stuck with a previously lowered value;
   *  · without a model there is NOTHING to clamp: the config chain (provider
   *    entry, file, settings) owns `maxTokens` and an override would shadow it
   *    (a provider declaring 123 would silently become the default).
   * The runtime override layer is shared by the open sessions, so concurrent
   * runs write each other's value: the clamp can only ever LOWER `max_tokens`,
   * which cannot turn a valid request into a rejected one.
   */
  private applySessionBudget(rt: SessionRuntime): void {
    if (!rt.model) return;
    this.modelSelector.set({
      maxTokens: this.outputBudgetFor(rt),
      contextWindow: clampContextWindow(rt.contextWindow ?? DEFAULT_CONTEXT_WINDOW),
    });
  }

  /**
   * Apply this session's Loop Guard options to the agent: the sensitivity
   * preset (+ the opt-in answer guard) overlaid with any EPHEMERAL field
   * overrides. Called on every send and on each UI change, so a run always
   * starts from the current settings.
   */
  private applyLoopGuard(rt: SessionRuntime): void {
    rt.agent.setLoopGuardOptions(this.resolvedLoopGuard(rt));
  }

  /**
   * THIS session's Loop Guard options: the sensitivity preset (+ the opt-in answer
   * guard) overlaid with any EPHEMERAL field overrides. ONE place defines them, so the
   * agent and the sub-agents cannot end up guarded differently.
   */
  private resolvedLoopGuard(rt: SessionRuntime): LoopGuardOptions {
    return {
      ...resolveLoopGuardOptions(rt.loopGuard, rt.loopGuardResponse),
      ...rt.loopGuardOverrides,
    };
  }

  /** The resolved guard of a session, for a caller that runs its own agents on the
   * same session (the sub-agent runner). Falls back to the preset defaults. */
  loopGuardOptionsFor(sessionId: string): LoopGuardOptions {
    const rt = this.registry.get(sessionId);
    return rt ? this.resolvedLoopGuard(rt) : resolveLoopGuardOptions(undefined, undefined);
  }

  /**
   * Persist settings, then refresh the view's config. `persist` may write
   * several fields at once (single saveSettings call). When `recomputeOverrides`
   * is true (the default) the per-model overrides are re-applied so the active
   * runtime config reflects the new settings; context-window changes skip it
   * because they do not affect the model overrides.
   */
  /**
   * Set a session's chat mode (Analyze/Build): applies it to the agent AND
   * persists it PER SESSION. Single source of truth for BOTH the mode toggle
   * and the "Switch to Build" modal, so they can never diverge.
   */
  private setSessionMode(rt: SessionRuntime, mode: "analyze" | "agent"): void {
    rt.mode = mode;
    // The agent enforces it: analyze = read-only; agent = full tools.
    rt.agent.setMode(mode);
    this.commitSetting(rt, () => this.sessions.saveSettings(rt.sessionId, { mode }), false);
  }

  private commitSetting(rt: SessionRuntime, persist: () => void, recomputeOverrides = true): void {
    persist();
    if (recomputeOverrides && rt.model) {
      this.modelSelector.set(this.computeOverrides(rt.model, rt.modelProvider));
    }
    void this.pushConfig();
  }

  /**
   * Entry point for a user message. While the session is working the message is
   * routed to the pending list (queue) or injected as a soft steer instead of
   * being dropped; otherwise it runs a full send and then drains the queue.
   */
  /**
   * The port a session's run talks to: services and view posts, nothing else.
   * Built per call over `rt` — a handful of closures — and kept HERE (not inside
   * the engine) so the run SEQUENCE can be tested with a fake port and no vscode.
   */
  private enginePort(rt: SessionRuntime): SessionSendPort & SessionAbortPort {
    return {
      prepareAgent: () => {
        // Re-assert the controls right before the run: a session created before a
        // UI toggle (or a reloaded panel) must not send with stale mode/Parallel.
        rt.agent.setMode(rt.mode ?? "analyze");
        rt.agent.setDelegation(rt.parallel === true);
        rt.agent.setMaxParallelSubAgents(rt.maxParallelSubAgents);
        this.applyLoopGuard(rt);
      },
      hasModel: () => !!rt.model,
      rejectMissingModel: (intent) => this.rejectMissingModel(rt, intent),
      preparePrompt: (intent) => this.preparePrompt(rt, intent),
      compactBeforeRun: async () => {
        // Auto-compaction before the request when already over the threshold: the
        // EXACT same routine as the manual Compact button. BEST-EFFORT — if the
        // summarizer errors (network), the user's request must still run.
        if (!this.needsAutoCompact(rt) || this.isCompacting(rt.sessionId)) return;
        try {
          await this.compactNow(rt);
        } catch (e: any) {
          infoLog("auto-compaction failed; continuing with the request:", e?.message || String(e));
        }
      },
      compactAfterRun: async () => {
        // Post-response: evaluate the CURRENT fill right after every final answer.
        if (!this.needsAutoCompact(rt) || this.isCompacting(rt.sessionId)) return;
        try {
          await this.compactNow(rt);
        } catch (e: any) {
          infoLog("post-response auto-compaction failed:", e?.message || String(e));
        }
      },
      applyBudget: () => this.applySessionBudget(rt),
      isDraining: () => this.pendingQueue.isDraining(rt.sessionId),
      enqueue: (intent) => this.pendingQueue.enqueue(rt, intent),
      drain: (dispatch) => this.pendingQueue.drain(rt, dispatch),
      isActive: () => this.activeId === rt.sessionId,
      showQueuedUser: (prompt) => {
        this.view?.webview.postMessage({
          type: "userMessage",
          content: prompt.displayText ?? prompt.text,
          ...(prompt.attachments ? { attachments: prompt.attachments } : {}),
          ...(prompt.images ? { images: prompt.images } : {}),
        });
      },
      onRunStarted: () => this.postStatus(rt, true),
      onRunFinished: (hadError) => {
        // The turn is over: flush the coalesced metric NOW, so the number on disk is
        // the run's last one even if the panel is never touched again.
        this.flushContextTokens();
        // Only touch the view when this session is still the active tab: the user
        // may have switched away while it streamed, and their refresh/status must
        // not clobber the session they are looking at.
        if (this.activeId !== rt.sessionId) return;
        this.postStatus(rt, false);
        if (!hadError) this.refreshTranscript(rt, true);
      },
      clearQueue: () => this.pendingQueue.clear(rt),
      onInterrupted: () => this.view?.webview.postMessage({ type: "interrupted" }),
    };
  }

  /**
   * Tell the user — IN the history, so a rebuild still shows it — that the session
   * has no model yet. Keeping BOTH the message and the error matters: otherwise the
   * follow-up "now do it" reaches the agent with an EMPTY history.
   */
  private rejectMissingModel(rt: SessionRuntime, intent: SendIntent): void {
    const rawText = typeof intent.text === "string" ? intent.text : "";
    const attached = intent.attachments ?? [];
    const userContent = rawText.trim() ? rawText : `📎 ${attached.map((a) => a.name).join(", ")}`;
    rt.history.add({ role: "user", content: userContent, timestamp: Date.now() });
    const errorMsg = "Select a model for this session first (dropdown in the header).";
    rt.history.add({ role: "assistant", content: `❌ ${errorMsg}`, timestamp: Date.now() });
    this.view?.webview.postMessage({ type: "error", error: errorMsg });
  }

  /**
   * Turn what the user typed into what the MODEL receives: attachments inlined,
   * `/skill` applied, modalities checked. `undefined` = already handled (an error
   * was posted, or a local command ran and nothing must be sent).
   */
  private async preparePrompt(rt: SessionRuntime, intent: SendIntent): Promise<PreparedPrompt | undefined> {
    const rawText = typeof intent.text === "string" ? intent.text : "";
    const attached = intent.attachments ?? [];
    let text = rawText;
    let images: string[] | undefined;
    let displayText: string | undefined;
    let attachmentMeta: { name: string; path: string; size: number; isImage: boolean }[] | undefined;
    let attachmentParts: AttachmentPart[] | undefined;
    if (attached.length > 0) {
      const ctx = await this.attachments.buildContext(attached);
      text = ctx.text ? `${ctx.text}\n\n${rawText}` : rawText;
      images = ctx.images.length > 0 ? ctx.images : undefined;
      // Keep the files as metadata for the bubble, and show ONLY the typed
      // prompt (possibly empty) — never the inlined file contents.
      attachmentMeta = attached.map((a) => ({ name: a.name, path: a.path, size: a.size, isImage: a.isImage }));
      attachmentParts = ctx.parts;
      displayText = rawText;
    }
    if (images && images.length > 0) {
      const cfg = this.config.get();
      const modalities = (cfg.modelModalities ?? {})[cfg.model];
      if (modalities && !modalities.includes("image")) {
        this.view?.webview.postMessage({
          type: "error",
          error: `Model \"${cfg.model}\" is text-only and does not support images.`,
        });
        return;
      }
    }
    // MANUAL SKILL ACTIVATION (bypasses the model's own activation decision):
    //   /skill <name> [task] → inject that skill's instructions into the request
    //   /skills              → list the installed skills
    const skillCmd = /^\/(skill|skills)\b([\s\S]*)$/i.exec(rawText.trim());
    if (skillCmd) {
      const registry = this.options.skills;
      const installed = registry?.list() ?? [];
      const isList = skillCmd[1].toLowerCase() === "skills" || !skillCmd[2].trim();
      const name = isList ? "" : skillCmd[2].trim().split(/\s+/)[0];
      const skill = isList ? undefined : registry?.get(name);
      if (isList || !skill) {
        const content = isList
          ? `🧩 **Skills**\n${
              installed.length
                ? installed.map((s) => `- \`${s.name}\`: ${s.description}`).join("\n")
                : "No skills installed. Install one with `npx skills add <repo> --skill <name> -a universal`."
            }`
          : `❌ Unknown skill \`${name}\`. Installed: ${installed.map((s) => s.name).join(", ") || "(none)"}.`;
        rt.history.add({ role: "user", content: rawText.trim(), timestamp: Date.now() });
        rt.history.add({ role: "assistant", content, timestamp: Date.now() });
        this.sessions.saveMessages(rt.sessionId, rt.agent.getMessages());
        this.refreshTranscript(rt, true);
        return;
      }
      const task = skillCmd[2].trim().slice(name.length).trim() || "Apply this skill to the current task.";
      const injected = `Use the following skill instructions.\n\n<skill name="${skill.name}" dir="${skill.dir}">\n${skill.body}\n</skill>\n\n${task}`;
      // Keep any inlined attachment context, but make the skill the leading task.
      text = text && text !== rawText ? `${injected}\n\n${text}` : injected;
      displayText = rawText.trim();
    }
    return { text, images, attachments: attachmentMeta, displayText, attachmentParts };
  }

  private postStatus(rt: SessionRuntime, active: boolean): void {
    // `active` drives the VIEW's streaming lock, so it is true only when THIS
    // session is the visible tab; `workingIds` still locks every row in the
    // list (background sessions must show as working too).
    this.view?.webview.postMessage({
      type: "status",
      active: active && this.activeId === rt.sessionId,
      workingIds: this.workingIds(),
    });
  }

  /** Push a session's pending list to the webview (only when it is active). */
  private postPending(sessionId: string, items: PendingInput[]): void {
    if (this.activeId !== sessionId) return;
    this.view?.webview.postMessage({ type: "pending", items });
  }

  /** Apply the active session's stored model to the runtime config (clears for new sessions). */
  private applyActiveModel(): void {
    const rt = this.activeRuntime();
    if (rt?.model) {
      this.modelSelector.set(this.computeOverrides(rt.model, rt.modelProvider));
    } else {
      this.modelSelector.clear();
    }
  }

  private computeOverrides(model: string, providerName?: string): Partial<HarnyConfig> {
    const overrides: Partial<HarnyConfig> = { model };
    const rt = this.activeRuntime();
    // Stable per-conversation id, used for routing/session headers (e.g.
    // OpenCode Go's x-opencode-session) and diagnostic logs.
    if (rt) overrides.sessionId = rt.sessionId;
    if (providerName) {
      const entry = this.providers.getProvider(providerName);
      if (entry) {
        overrides.activeProvider = providerName;
        overrides.provider = "openai-compatible";
        if (entry.baseUrl) overrides.baseUrl = entry.baseUrl;
        if (typeof entry.apiKey === "string") overrides.apiKey = entry.apiKey;
        if (typeof entry.enableThinking === "boolean") overrides.enableThinking = entry.enableThinking;
        // Explicit undefined clears a stale value from a previously active provider.
        overrides.thinkingMode = entry.thinkingMode;
        // Config-suggested max output: CAP at the scale maximum (never above the
        // slider ceiling) but keep smaller values as-is.
        if (typeof entry.maxTokens === "number")
          overrides.maxTokens = Math.min(MAX_OUTPUT_TOKENS, Math.max(1, Math.round(entry.maxTokens)));
        // Declared extra headers + the per-conversation session header name.
        if (entry.extraHeaders) overrides.extraHeaders = entry.extraHeaders;
        overrides.sessionHeader = entry.sessionHeader;
        const ids = entry.models.map((m) => m.id);
        if (ids.length > 0) overrides.availableModels = ids;
        const modalities: Record<string, string[]> = {};
        for (const m of entry.models) if (m.input && m.input.length > 0) modalities[m.id] = m.input;
        if (Object.keys(modalities).length > 0) overrides.modelModalities = modalities;
      }
      // The per-session thinking level wins over the provider's declared default.
      // A NON-reasoning provider must NOT receive a stale thinking level (it
      // would be sent as an unsupported param), so it is cleared here.
      const thinkMode = entry?.thinkingMode;
      const reasoningProvider =
        thinkMode === "bool" || thinkMode === "effort" || thinkMode === "type" || thinkMode === "reasoning";
      overrides.thinkingLevel = reasoningProvider ? (rt?.thinkingLevel ?? entry?.thinkingLevel) : undefined;
    } else if (rt?.thinkingLevel) {
      overrides.thinkingLevel = rt.thinkingLevel;
    }
    // The per-session output-token budget wins over the provider's default.
    // Capped at the scale MAXIMUM (never sent as-is) but NOT raised to the MIN:
    // a provider entry's small maxTokens (e.g. 123) must be honoured.
    if (typeof rt?.outputTokens === "number") overrides.maxTokens = clampAdoptedOutputTokens(rt.outputTokens);
    if (typeof rt?.presencePenalty === "number") overrides.presencePenalty = rt.presencePenalty;
    if (typeof rt?.frequencyPenalty === "number") overrides.frequencyPenalty = rt.frequencyPenalty;
    // Sampler pick: ONLY the ACTIVE sampler keeps a value; the other is
    // explicitly cleared (undefined) so the request never carries both.
    const sampler = rt?.sampler ?? "temperature";
    overrides.temperature =
      sampler === "temperature" && typeof rt?.temperature === "number" ? rt.temperature : undefined;
    overrides.topP = sampler === "topP" && typeof rt?.topP === "number" ? rt.topP : undefined;
    // The window travels WITH the turn's config: the agent records it in the
    // message meta (so every turn stays self-describing) and the request clamp
    // below needs it.
    if (rt) overrides.contextWindow = clampContextWindow(rt.contextWindow ?? DEFAULT_CONTEXT_WINDOW);
    // LAST: the request must fit `input + max_tokens ≤ window`. This is a
    // starting point — a multi-turn run re-clamps at every turn boundary
    // (`applySessionBudget`), where the context has grown.
    overrides.maxTokens = this.outputBudgetFor(rt, overrides.maxTokens);
    return overrides;
  }

  /**
   * Rename a session in place (lightweight DOM update posted to the view, NO
   * full HTML rebuild, so streaming UI is preserved). Also carries the new
   * timestamps so the sessions list can refresh its dates without a rebuild.
   */
  updateSessionName(id: string, name: string): void {
    const summary = this.sessions.rename(id, name);
    this.view?.webview.postMessage({
      type: "renameSession",
      id,
      name,
      createdAt: summary.createdAt,
      updatedAt: summary.updatedAt,
    });
  }

  private async renameSession(id: string): Promise<void> {
    // The ✎ buttons are DISABLED while the session works (silent guard).
    if (this.isWorking(id)) return;
    const name = await this.askName("rename", id);
    if (name === undefined) return;
    // Same-name renames are allowed (self excluded); any OTHER collision is not.
    if (this.sessionNameTaken(name, id)) {
      await this.warnNameTaken(name);
      return;
    }
    this.updateSessionName(id, name);
  }

  private async deleteSession(id: string): Promise<void> {
    const existing = this.sessions.list().find((s) => s.id === id);
    // The 🗑 buttons are DISABLED while the session works (silent guard).
    if (this.isWorking(id)) return;
    const messages = this.transcriptOf(id);
    // "Rewind" needs a checkpoint to rewind TO: a session that never compacted is
    // offered the other two answers and says why this one is unavailable.
    const rewindEnd = firstCheckpointEnd(messages);
    const answer = await this.askSessionCleanup(existing?.name ?? id, rewindEnd > 0);
    if (answer === "empty") {
      this.rewriteTranscript(id, []);
      return;
    }
    if (answer === "rewind") {
      // Leave the summary, drop what came after it: the transcript ends where the
      // FIRST summary ends, so the model's window opens on that state document.
      // A rewind that landed at 0 would be an EMPTY wearing another name, so it
      // is refused when there is no checkpoint (the answer is sent disabled).
      if (rewindEnd > 0) this.rewriteTranscript(id, messages.slice(0, rewindEnd));
      return;
    }
    if (answer !== "delete") return;
    this.registry.close(id);
    if (this.activeId === id) {
      this.activeId = undefined;
      if (this.registry.listOpenIds().length > 0) {
        this.activeId = this.registry.listOpenIds()[this.registry.listOpenIds().length - 1];
      }
    }
    this.sessions.remove(id);
    void this.maybeSuggestVacuum();
    this.streamTee.detach(id);
    this.pendingQueue.drop(id);
    this.resubscribe();
    await this.postSwitchView();
    // The manage-sessions form (if open) must drop the deleted row too.
    this.pushSessionsManager();
  }

  /**
   * The 🗑 question, with THREE answers instead of two: delete the session, rewind
   * it to its first compaction summary, or empty its transcript.
   *
   * They are asked together because they are one gesture — "this session has
   * become too big" — and because "start over without losing my settings or the
   * state of the work" is what people usually want, while a second dialog would
   * make it look like a follow-up to the deletion instead of an alternative to it.
   *
   * `rewindable` is FALSE when the transcript holds no summary yet: there is no
   * checkpoint to rewind to, so that answer is shown disabled rather than hidden
   * (the set of answers must not move around between two sessions).
   */
  private async askSessionCleanup(
    name: string,
    rewindable: boolean,
  ): Promise<"delete" | "rewind" | "empty" | undefined> {
    const message =
      `What do you want to do with "${name}"?\n\n` +
      "Rewind: keep the session up to its first compaction summary and drop everything after it.\n" +
      "Empty: keep the session and its settings, drop the whole transcript.\n" +
      "Delete: remove the session itself, transcript and settings included.";
    const DEL = "Delete";
    const REWIND = "Rewind to first summary";
    const EMPTY = "Empty transcript";
    if (!this.view) {
      const { window } = await import("vscode");
      const items = rewindable ? [DEL, REWIND, EMPTY] : [DEL, EMPTY];
      const r = await window.showWarningMessage(message, { modal: true }, ...items);
      return r === DEL ? "delete" : r === REWIND ? "rewind" : r === EMPTY ? "empty" : undefined;
    }
    const v = await this.requestPanelModal({
      kind: "alert",
      alertKind: "confirm",
      title: "Delete or empty session",
      message,
      confirmText: "Delete",
      danger: true,
      // All THREE answers are destructive and none can be undone, so each asks once more — in the
      // same dialog, with the consequences named. The words live here, next to the question: the
      // panel only knows how to show a second step.
      confirm: {
        title: "Delete the session permanently?",
        message:
          `"${name}" is removed with its transcript and its settings, and it disappears from every ` +
          "list. There is no undo.",
        confirmText: "Yes, delete it",
      },
      extraActions: [
        {
          value: "rewind",
          text: "Rewind",
          title: rewindable
            ? "Keep everything up to the first compaction summary and drop what came after it"
            : "This session has no summary to rewind to yet",
          disabled: !rewindable,
          confirm: {
            title: "Rewind to the first summary?",
            message:
              `Everything after the first compaction summary of "${name}" is dropped. The summary ` +
              "itself and what came before it stay. There is no undo.",
            confirmText: "Yes, rewind",
          },
        },
        {
          value: "empty",
          text: "Empty",
          title: "Keep the session and its settings, drop the whole transcript",
          confirm: {
            title: "Empty the transcript?",
            message:
              `"${name}" keeps its name, its settings and its place in the list, but every message ` +
              "is dropped. There is no undo.",
            confirmText: "Yes, empty it",
          },
        },
      ],
    });
    return v === true ? "delete" : v === "rewind" ? "rewind" : v === "empty" ? "empty" : undefined;
  }

  /**
   * The session's messages as the UI has them: the LIVE array when the session is
   * open, the stored one otherwise (the manager form can act on a closed session).
   */
  private transcriptOf(id: string): ChatMessage[] {
    const rt = this.registry.get(id);
    if (rt) return rt.agent.getMessages();
    try {
      return this.sessions.load(id).messages;
    } catch (e) {
      debugLog("cannot read the transcript", id, e);
      return [];
    }
  }

  /**
   * Replace a session's transcript with `kept`, keeping the SESSION (name,
   * settings, tab, position in the list): the shared body of "rewind" and "empty".
   *
   * Same bookkeeping as a ✂ cut down to zero messages — persist with `replace`,
   * re-estimate the context metric from what is left, drop the cache counters
   * (they described a prefix that no longer exists) — and it works for a CLOSED
   * session too: only the store is touched then.
   */
  private rewriteTranscript(id: string, kept: ChatMessage[]): void {
    const rt = this.registry.get(id);
    this.sessions.saveMessages(id, kept, { replace: true });
    // Measured on what the MODEL will see: the window opens at the newest
    // checkpoint, which after a rewind IS the summary that was kept.
    const tokens = estimateContextTokens(kept.slice(checkpointStart(kept)).filter((m) => !m.uiOnly));
    this.sessions.saveSettings(id, { contextTokens: tokens });
    if (rt) {
      rt.history.replace(kept);
      rt.contextTokens = tokens;
      rt.cachedTokens = 0;
      rt.cachedWriteTokens = 0;
    }
    void this.maybeSuggestVacuum();
    // Only the ACTIVE session is on screen; the others are re-rendered when the
    // user opens them (their transcript is read off disk).
    if (rt && this.activeId === id) {
      void this.pushConfig();
      this.refreshTranscript(rt, true);
    }
    // The manage form (if open) shows message counts and dates: refresh its rows.
    this.pushSessionsManager();
  }

  /**
   * Runs one compaction over this session's history.
   *
   * Returns TRUE when the session was actually rewritten (something was
   * summarized). The overflow recovery uses that answer: retrying a request the
   * provider just rejected only makes sense if the history really shrank.
   */
  private async performCompaction(rt: SessionRuntime, signal?: AbortSignal): Promise<boolean> {
    const compactor = this.options.compactor;
    if (!compactor) return false;
    // The context BEGINS at the newest checkpoint: what precedes it is the
    // session's readable past and stays STORED — it is simply no longer in the
    // window (see checkpointStart). A compaction therefore rewrites only the
    // ACTIVE span, and the result is spliced back after the preserved past.
    const all = rt.history.all();
    const activeStart = checkpointStart(all);
    const messages = all.slice(activeStart);
    const usable = usableContext(this.budgetWindow(rt), this.budgetReserve(rt));
    // Where the rebuilt window must LAND (session policy, see compactionSettings). This
    // replaces the old fixed recent budget: the verbatim tail is whatever the summary
    // does not take, so no 20k/8k constant decides how much of the task survives.
    const targetTokens = targetTokensFor(usable, this.targetPercentFor(rt));
    // The summarizer runs on the SESSION's model, so a span larger than that model's
    // window cannot be READ by it. That is no longer a reason to give up: the summary takes
    // the most RECENT part that fits and the rest stays in the transcript above the new
    // checkpoint (see compactHistory) — preserved, not summarized, not lost. Only a window
    // that can read NOTHING at all falls back to the trim, which calls no model and
    // therefore cannot fail.
    const span = this.summarySpan(messages, targetTokens, rt);
    if (span.ceilingTokens <= 0) return this.trimWindow(rt, targetTokens, span);
    // THE compaction strategy lives in core/sessions and is shared with the sub-agents
    // (which compact their own ephemeral history the same way). What stays HERE is what
    // only the session has: persistence, the context counter and the UI.
    //
    // The summary is the GOOD path; the trim is the one that CANNOT fail. So a summary
    // that could not be made has to LAND on the trim instead of surfacing as an error:
    // the window still has to move, and a session that dies because the summarizer's own
    // request was too long is exactly what the trim exists to prevent. The ceiling above
    // is our PREDICTION of that request's size — a prediction, so it can be wrong, and
    // when it is wrong the answer must still not be an exception.
    // The one exception is a Stop: the user cancelled, so degrading would be doing work
    // they asked to cancel.
    let result: CompactedHistory | null = null;
    try {
      result = await compactHistory(messages, {
        compactor,
        targetTokens,
        maxOutputTokens: this.configuredOutputTokens(rt),
        maxInputTokens: span.ceilingTokens,
        // Say WHY it failed: an empty stream and a reply that is not the document are
        // different problems (the second is what a guard or confused model does), and both
        // used to read as a single "no summary written".
        onUnusableReply: (reply) =>
          infoLog(
            reply.trim()
              ? `the summarizer replied with something that is not the document (${reply.length} chars): ${JSON.stringify(reply.slice(0, 200))}`
              : `the summarizer replied with NOTHING (empty stream, ${span.ceilingTokens} tokens of room)`,
          ),
        signal,
      });
    } catch (err) {
      if (signal?.aborted) throw err;
      infoLog(
        `compaction failed (${err instanceof Error ? err.message : String(err)}) — ` +
          `falling back to a trim, so the window still moves and nothing is lost`,
      );
    }
    if (!result) {
      // `compactHistory` returns null for two reasons: there was nothing worth summarizing,
      // or the model's reply was not the document (a safety classification, a refusal).
      // Either way the window still has to move, and the trim is the path that cannot fail.
      // The tally line the trim logs is the record that NO summary was written.
      infoLog("no summary written (nothing to summarize, or the reply was not a summary) — trimming instead");
      return this.trimWindow(rt, targetTokens, span);
    }
    // A deferral must never be silent: the caller has to be able to see that the state
    // document covers the RECENT work and that older messages are still waiting.
    if (result.deferred.length > 0) {
      infoLog(
        `summary read the most recent ${result.summarized.length} message(s); ` +
          `${result.deferred.length} older one(s) stay in the transcript, unsummarized — a later compaction can pick them up`,
      );
    }
    infoLog(
      this.tally.recordCompaction({
        spanTokens: estimateTokens(serializeConversation(result.summarized)),
        usableTokens: usable,
        ceilingTokens: maxSummaryInputTokens(this.budgetWindow(rt), this.configuredOutputTokens(rt)),
        keepBudgetTokens: result.keepBudgetTokens,
        keptTokens: estimateTokens(serializeConversation(result.kept)),
        summaryBudgetTokens: result.summaryBudgetTokens,
        summaryTokens: result.summaryTokens,
        summarizedCount: result.summarized.length,
        keptCount: result.kept.length,
      }),
    );
    // The past is KEPT, not dropped: [past][newly summarized][checkpoint][kept].
    // The previous checkpoint pair is absorbed into the new summary (carriedState
    // UPDATES it) and therefore does not appear twice.
    const newHistory = [...all.slice(0, activeStart), ...result.summarized, ...result.history];
    rt.history.replace(newHistory);
    this.sessions.saveMessages(rt.sessionId, newHistory, { replace: true });
    // Prefer REAL data for the KEPT window (the cumulative `meta.inputTokens`
    // delta across it): the summary rewrote the prefix, so re-estimating the
    // whole history would no longer match the provider's numbers.
    const keptFrom = result.kept.length > 0 ? messages.indexOf(result.kept[0]) : -1;
    const keptTokens =
      keptFrom >= 0 ? (realWindowTokens(messages, keptFrom) ?? estimateTokens(serializeConversation(result.kept))) : 0;
    // The checkpoint is the TAIL of the rebuilt history: the preserved past sits
    // before it, so the pair is no longer at index 0.
    const pairStart = newHistory.length - result.history.length;
    const next =
      estimateTokens(String(newHistory[pairStart]?.content ?? "")) +
      estimateTokens(String(newHistory[pairStart + 1]?.content ?? "")) +
      keptTokens;
    rt.contextTokens = next;
    this.sessions.saveSettings(rt.sessionId, { contextTokens: next });
    // The context was rebuilt: any previously reported cache hit is meaningless
    // for the new layout. Reset so the cache indicator hides until the next
    // real chat turn reports fresh usage (avoids stale ratios > 100%).
    rt.cachedTokens = 0;
    rt.cachedWriteTokens = 0;
    return true;
  }

  /**
   * Move the context window forward WITHOUT summarizing (see trimHistory).
   *
   * The fallback for the one case a compaction cannot serve: the span is larger
   * than the model that would have to read it. Deterministic and free — no model
   * call — so it works exactly where the compaction cannot, and the session keeps
   * working with a narrower window instead of dying. The state document is carried
   * verbatim, and everything that leaves the window stays in the session.
   */
  private trimWindow(
    rt: SessionRuntime,
    targetTokens: number,
    oversized: { spanTokens: number; ceilingTokens: number },
  ): boolean {
    const trim = this.trimInto(rt.history.all(), targetTokens);
    if (!trim) return false;
    rt.history.replace(trim.history);
    this.sessions.saveMessages(rt.sessionId, trim.history, { replace: true });
    infoLog(this.tally.recordTrim({ ...oversized, moved: trim.moved, budgetTokens: targetTokens }));
    rt.contextTokens = estimateContextTokens(trim.history.slice(trim.windowStart));
    this.sessions.saveSettings(rt.sessionId, { contextTokens: rt.contextTokens });
    // The prefix was rewritten: any reported cache hit is meaningless now.
    rt.cachedTokens = 0;
    rt.cachedWriteTokens = 0;
    return true;
  }

  /**
   * The trimmed history for this conversation, or null when there is nothing to
   * move (it already fits).
   *
   * Pure on purpose: what happens to the result belongs to the CALLER. The session
   * persists it; a sub-agent's history is ephemeral and is only swapped in memory.
   */
  private trimInto(all: ChatMessage[], targetTokens: number): TrimResult | null {
    const carried = carriedState(all);
    return trimHistory(all, {
      budgetTokens: targetTokens,
      ...(carried ? { summary: carried } : {}),
    });
  }

  /** What summarization would have to read, and the ceiling it must fit under.
   *
   * It returns the NUMBERS, always — the caller needs them to decide (`span > ceiling`)
   * AND to explain the trim it falls back to: `span 41.2k > ceiling 8.9k` is the only
   * reason a reader needs to know why a model call was skipped. */
  private summarySpan(
    messages: ChatMessage[],
    targetTokens: number,
    rt: SessionRuntime,
  ): { spanTokens: number; ceilingTokens: number } {
    const spanTokens = compactionSpanTokens(messages, targetTokens, this.configuredOutputTokens(rt));
    return {
      spanTokens,
      // The request spends the measured prompt, the previous state, and — as a SHARE of
      // what it reads — the summary it will write. No circularity: see
      // maxSummaryInputTokens.
      ceilingTokens: maxSummaryInputTokens(
        this.budgetWindow(rt),
        this.configuredOutputTokens(rt),
        estimateTokens(carriedState(messages) ?? ""),
      ),
    };
  }

  /**
   * The numbers the settings modal shows BEFORE anything is saved: the SAME planner a
   * compaction will run (`planForTarget`) against the live history, so the preview cannot
   * disagree with what actually happens. Model-free: no provider call answers this.
   */
  private postCompactionPreview(msg: { thresholdPercent?: unknown; targetPercent?: unknown }): void {
    const rt = this.activeRuntime();
    if (!rt) return;
    const thresholdPercent = toCompactionThresholdPercent(msg.thresholdPercent);
    // The floor is DERIVED from this session (summary + last complete turn), so the modal can
    // mark the smallest value that differs from the structural minimum — no constant.
    const minTargetPercent = this.targetFloorFor(rt);
    const targetPercent = toTargetPercent(msg.targetPercent, thresholdPercent, minTargetPercent);
    const usable = usableContext(this.budgetWindow(rt), this.budgetReserve(rt));
    const targetTokens = targetTokensFor(usable, targetPercent);
    const maxOutput = this.configuredOutputTokens(rt);
    const all = rt.history.all();
    const messages = all.slice(checkpointStart(all));
    const { plan, summaryBudgetTokens } = planForTarget(messages, targetTokens, maxOutput);
    // What the summarizer can READ in one request: the rest is DEFERRED (kept in the
    // transcript, unsummarized), and the preview has to say so instead of implying that a
    // single pass will land on the target.
    const ceiling = maxSummaryInputTokens(
      this.budgetWindow(rt),
      maxOutput,
      estimateTokens(carriedState(messages) ?? ""),
    );
    const readable = plan.toSummarize.length > 0 ? newestWithin(plan.toSummarize, ceiling) : [];
    const fillTokens = estimateContextTokens(messages);
    this.view?.webview.postMessage({
      type: "compactionPreview",
      thresholdPercent,
      targetPercent,
      minTargetPercent,
      autoTargetPercent: autoTargetPercent(thresholdPercent),
      usableTokens: usable,
      targetTokens,
      fillTokens,
      fillPercent: usable > 0 ? Math.round((fillTokens / usable) * 100) : 0,
      aboveThreshold: fillTokens > (usable * thresholdPercent) / 100,
      summarizeCount: readable.length,
      summarizeTokens: estimateTokens(serializeConversation(readable)),
      keepCount: plan.kept.length,
      keepTokens: estimateTokens(serializeConversation(plan.kept)),
      summaryBudgetTokens,
      deferredCount: plan.toSummarize.length - readable.length,
    });
  }

  /**
   * The agent's safety net: the provider REJECTED a request because the input was
   * too big. Compact NOW (the threshold is irrelevant — the provider just told us
   * the truth) and answer whether the history actually shrank, so the agent knows
   * if retrying the same turn can help.
   *
   * Silent: the run is still going, so the "working" status is untouched. A
   * failure here must not mask the original error — the agent falls back to it.
   */
  async compactForOverflow(
    sessionId: string,
    signal?: AbortSignal,
    evidence?: ContextOverflowEvidence,
  ): Promise<boolean> {
    const rt = this.registry.get(sessionId);
    if (!rt || this.isCompacting(rt.sessionId)) return false;
    // FIRST, before the budget math below reads the window: adopt the limit the
    // provider itself stated. An unknown local model otherwise keeps a guessed
    // (optimistic) 128k for the whole session, so the threshold never fires and
    // every request risks the same rejection.
    if (evidence?.limitTokens) this.adoptContextWindow(rt, evidence.limitTokens);
    rt.engine.beginCompaction();
    try {
      const compacted = await this.performCompaction(rt, signal);
      infoLog(`context overflow: compaction ${compacted ? "rewrote the session" : "had nothing to summarize"}`);
      if (compacted && this.activeId === rt.sessionId) {
        this.refreshTranscript(rt);
        void this.pushConfig();
      }
      return compacted;
    } catch (e: any) {
      infoLog("overflow compaction failed:", e?.message || String(e));
      return false;
    } finally {
      rt.engine.endCompaction();
    }
  }

  /**
   * Adopt a context window the PROVIDER stated (see ContextOverflowEvidence).
   * Persisted, because it is a property of the model, not of this run: the next
   * session with the same model starts from the truth instead of from the fallback.
   */
  private adoptContextWindow(rt: SessionRuntime, limitTokens: number): void {
    const adopted = clampAdoptedContextWindow(limitTokens);
    if (adopted === rt.contextWindow) return;
    infoLog(
      `context window adopted from the provider: ${rt.contextWindow} -> ${adopted} tokens (session ${rt.sessionId})`,
    );
    rt.contextWindow = adopted;
    this.sessions.saveSettings(rt.sessionId, { contextWindow: adopted });
    if (this.activeId === rt.sessionId) this.pushConfigSoon();
  }

  /**
   * Proactive compaction for a SUB-AGENT at a turn boundary: the same threshold and the
   * same routine, applied to ITS history. A sub-agent is unbounded and reads heavily, so
   * it has to free room before the next request like the session does — instead of
   * learning it the hard way when the provider refuses. Silent by design: the transcript
   * has no "compacting" indicator for work that belongs to one sub-task.
   */
  async maybeCompactSubAgentHistory(history: ChatHistory, sessionId: string, signal?: AbortSignal): Promise<boolean> {
    const rt = this.registry.get(sessionId);
    if (!rt) return false;
    if (!this.needsCompact(rt, history.conversation())) return false;
    return this.compactSubAgentHistory(history, sessionId, signal);
  }

  /**
   * The trim for a sub-agent's EPHEMERAL history: same rule as the session, different
   * storage — nothing is persisted, only the in-memory history is swapped.
   */
  private trimSubAgent(
    history: ChatHistory,
    targetTokens: number,
    span: { spanTokens: number; ceilingTokens: number },
  ): boolean {
    const trim = this.trimInto(history.conversation(), targetTokens);
    if (!trim) return false;
    history.replace(trim.history);
    infoLog(this.tally.recordTrim({ ...span, moved: trim.moved, budgetTokens: targetTokens, subAgent: true }));
    return true;
  }

  /**
   * Overflow recovery for a SUB-AGENT: a sub-agent's history is EPHEMERAL (its runner
   * owns it), so the session's compaction cannot act on it — but the STRATEGY must be
   * the same one, or the two would drift into two behaviours. Same `compactHistory`,
   * same model, therefore the same window: only what is stored differs (nothing here).
   */
  async compactSubAgentHistory(
    history: ChatHistory,
    sessionId: string,
    signal?: AbortSignal,
    evidence?: ContextOverflowEvidence,
  ): Promise<boolean> {
    const rt = this.registry.get(sessionId);
    const compactor = this.options.compactor;
    if (!rt || !compactor) return false;
    // Same model as the session: a limit the provider stated applies to it too.
    if (evidence?.limitTokens) this.adoptContextWindow(rt, evidence.limitTokens);
    const messages = history.conversation();
    const usable = usableContext(this.budgetWindow(rt), this.budgetReserve(rt));
    // Same landing point as the session it belongs to: a sub-agent inherits the policy.
    const targetTokens = targetTokensFor(usable, this.targetPercentFor(rt));
    // A sub-agent shares the SESSION's model, so an oversized span cannot be read here
    // either — but that is no longer a reason to give up: the summary takes the most
    // recent part that fits, and the rest stays in its history above the new checkpoint.
    const span = this.summarySpan(messages, targetTokens, rt);
    if (span.ceilingTokens <= 0) return this.trimSubAgent(history, targetTokens, span);
    let result: CompactedHistory | null = null;
    try {
      result = await compactHistory(messages, {
        compactor,
        targetTokens,
        maxOutputTokens: this.configuredOutputTokens(rt),
        maxInputTokens: span.ceilingTokens,
        onUnusableReply: (reply) =>
          infoLog(
            reply.trim()
              ? `sub-agent summarizer replied with something that is not the document (${reply.length} chars): ${JSON.stringify(reply.slice(0, 200))}`
              : "sub-agent summarizer replied with NOTHING (empty stream)",
          ),
        signal,
      });
    } catch (err) {
      if (signal?.aborted) throw err;
      infoLog(
        `sub-agent compaction failed (${err instanceof Error ? err.message : String(err)}) — ` +
          `falling back to a trim, so its window still moves`,
      );
    }
    // Same rule as the session: a summary that could not be made lands on the trim
    // (which calls no model), never on an exception that stops the sub-agent.
    if (!result) return this.trimSubAgent(history, targetTokens, span);
    history.replace(result.history);
    if (result.deferred.length > 0) {
      infoLog(
        `sub-agent summary read the most recent ${result.summarized.length} message(s); ` +
          `${result.deferred.length} older one(s) stay in its history, unsummarized`,
      );
    }
    infoLog(
      this.tally.recordCompaction({
        subAgent: true,
        spanTokens: estimateTokens(serializeConversation(result.summarized)),
        usableTokens: usable,
        ceilingTokens: maxSummaryInputTokens(this.budgetWindow(rt), this.configuredOutputTokens(rt)),
        keepBudgetTokens: result.keepBudgetTokens,
        keptTokens: estimateTokens(serializeConversation(result.kept)),
        summaryBudgetTokens: result.summaryBudgetTokens,
        summaryTokens: result.summaryTokens,
        summarizedCount: result.summarized.length,
        keptCount: result.kept.length,
      }),
    );
    return true;
  }

  /** The USABLE context of a session (window − output reserve): the number every
   * budget decision is measured against, exposed so the agent can size its own
   * (masking, overflow detection) without knowing about the session model. */
  usableBudgetFor(sessionId: string): number {
    const rt = this.registry.get(sessionId);
    if (!rt) return 0;
    return usableContext(this.budgetWindow(rt), this.budgetReserve(rt));
  }

  /**
   * Streaming router + live buffers, extracted from this class (SRP): it
   * forwards the ACTIVE session's events to the view and accumulates the
   * in-flight thinking/answer for EVERY open session (parallel work + replay).
   */
  private streamTee = new StreamTee({
    isActive: (id) => id === this.activeId,
    onPost: (m) => {
      this.telemetry.notePost(m);
      this.view?.webview.postMessage(m);
    },
    onUsage: (sessionId, usage) => {
      const rt = this.registry.get(sessionId);
      if (!rt) return;
      rt.contextTokens = usage.input;
      // The metric is already where every reader looks (memory); the DB write is
      // COALESCED — see persistContextTokensSoon.
      this.persistContextTokensSoon(rt);
      if (typeof usage.cached === "number") rt.cachedTokens = usage.cached;
      if (typeof usage.cachedWrite === "number") rt.cachedWriteTokens = usage.cachedWrite;
      // The numbers the config shows belong to the ACTIVE session: a hidden
      // session's usage must not trigger a rebuild+post (it used to, for every
      // session, every turn).
      if (this.activeId === sessionId) this.pushConfigSoon();
    },
    onSteerApplied: (sessionId, ids) => this.pendingQueue.onSteerApplied(sessionId, ids),
    onPreviewReady: (sessionId) => void this.promptSwitchToBuild(sessionId),
  });

  private resubscribe(): void {
    const runtimes = this.registry
      .listOpenIds()
      .map((id) => this.registry.get(id))
      .filter((rt): rt is SessionRuntime => !!rt);
    this.streamTee.attachAll(runtimes);
  }

  /** The installed-skills catalog for the UI (Skills card). */
  private skillCatalog(): { name: string; description: string }[] {
    return (this.options.skills?.list() ?? []).map((s) => ({ name: s.name, description: s.description }));
  }

  /** MCP servers (config) + their live status, for the MCP card/editor.
   * `toolCount` is what the MODEL sees; `tools[]` is everything the server
   * advertises, each flagged with the ones `excludeTools` hides.
   */
  private mcpEditorData(): {
    servers: Record<string, McpServerConfig>;
    statuses: {
      name: string;
      ok: boolean;
      enabled: boolean;
      error?: string;
      toolCount: number;
      tools?: { name: string; description?: string; excluded?: boolean }[];
    }[];
  } {
    return { servers: this.providers.readMcpServers?.() ?? {}, statuses: this.mcpStatusesForView() };
  }

  /** The concurrent sub-agent cap actually used for the active session: the
   * per-session override wins, then the config default, then 4. */
  private effectiveParallelCap(): number {
    const rt = this.activeRuntime();
    if (rt?.maxParallelSubAgents !== undefined) return rt.maxParallelSubAgents;
    const cfgCap = this.config.get().maxParallelSubAgents;
    return typeof cfgCap === "number" && cfgCap > 0 ? cfgCap : DEFAULT_MAX_PARALLEL_SUB_AGENTS;
  }

  private async buildConfig(): Promise<{
    provider: string;
    activeProvider?: string;
    model: string;
    hasKey: boolean;
    models: string[];
    providerModels: { provider: string; model: string; contextLength?: number }[];
    modelMissing: boolean;
    /** True when the models.dev fallback is unreachable and a limit is missing. */
    modelsDevError?: boolean;
    hostModelErrors: { provider: string; error: string }[];
    noModels: boolean;
    configHome: string;
    workspaceReady: boolean;
    thinkingMode?: "bool" | "effort" | "type" | "reasoning" | "unspecified";
    thinkingLevel?: "off" | "low" | "medium" | "high";
    mode?: "analyze" | "agent";
    parallel?: boolean;
    /** Which MCP servers and tools THIS session may use (see ToolScope). */
    toolScope?: ToolScope;
    maxParallelSubAgents: number;
    loopGuard?: "off" | "low" | "medium" | "high";
    loopGuardResponse?: boolean;
    /** The SAVED per-session Loop Guard field values (absent = the preset). */
    loopGuardParams?: Partial<LoopGuardOptions>;
    /** Preset VALUES + editable RANGES for the Loop Guard fields (from the core). */
    loopGuardPresets: Record<string, LoopGuardOptions>;
    loopGuardRanges: readonly { key: string; min: number; max: number; step: number; integer: boolean }[];
    /** Installed Agent Skills (catalog for the Skills card). */
    skills: { name: string; description: string }[];
    /** MCP servers + their connection status (MCP card). */
    mcp?: {
      servers: Record<string, McpServerConfig>;
      statuses: { name: string; ok: boolean; error?: string; toolCount: number }[];
    };
    contextWindow: number;
    /** Upper bound of the context slider: the model's DETECTED window, else the global max. */
    maxContextWindow: number;
    /**
     * The part of the window the INPUT may use: `window − reserve`, where the
     * reserve is the output budget of this session. This is what the footer bar
     * and its % must be measured against — the raw window would read 66% while
     * the provider is already refusing the request.
     */
    contextUsable?: number;
    compactionThresholdPercent?: number;
    /** Landing fill actually used for this session (explicit, else the DERIVED auto). */
    compactionTargetPercent?: number;
    /** True when that landing fill is AUTO (a quarter of the trigger). */
    compactionTargetAuto?: boolean;
    outputTokens: number;
    /** Upper bound of the output slider: the model's DETECTED max output, else the global max. */
    maxOutputTokens: number;
    temperature?: number;
    presencePenalty?: number;
    frequencyPenalty?: number;
    topP?: number;
    sampler?: "temperature" | "topP";
    contextTokens?: number;
    cachedTokens?: number;
    cachedWrite?: number;
  }> {
    const cfg = this.config.get();
    // EVERY provider gets a fetch (declared models or host-only alike): the
    // dropdown shows only the LIVE lists from each host. A provider whose
    // fetch fails shows up red with the error instead of its stale config list.
    const declared = cfg.providerModels ?? [];
    const hostProviders = cfg.hostModelProviders ?? [];
    const allNames = [...new Set([...hostProviders, ...declared.map((p) => p.provider)])];
    const fetched = new Map<string, ModelInfo[]>();
    const hostModelErrors: { provider: string; error: string }[] = [];
    if (allNames.length > 0) {
      const results = await Promise.allSettled(allNames.map((name) => this.fetchHostModels(name)));
      allNames.forEach((name, i) => {
        const r = results[i];
        if (r.status === "fulfilled") fetched.set(name, r.value);
        else {
          hostModelErrors.push({
            provider: name,
            error: r.reason instanceof Error ? r.reason.message : String(r.reason),
          });
        }
      });
    }

    // Dropdown lists come from the fetched hosts ONLY (no stale declared
    // model lists mixed in).
    const providerModels: { provider: string; model: string; contextLength?: number; maxOutputTokens?: number }[] = [];
    for (const [name, models] of fetched) {
      for (const m of models) {
        providerModels.push({
          provider: name,
          model: m.id,
          ...(m.contextLength ? { contextLength: m.contextLength } : {}),
          ...(m.maxOutputTokens ? { maxOutputTokens: m.maxOutputTokens } : {}),
        });
      }
    }
    // Fill in what the host did NOT report from models.dev (opencode-go &
    // friends), so the LIST matches what selecting adopts. Cached values are
    // applied now; the still-missing ones are resolved in the background.
    for (const m of providerModels) {
      const key = `${m.provider}|${m.model}`;
      if (!m.contextLength) {
        const known = this.modelsDevContext.get(key);
        if (known) m.contextLength = known;
      }
      if (!m.maxOutputTokens) {
        const known = this.modelsDevOutput.get(key);
        if (known) m.maxOutputTokens = known;
      }
      // Cache the RESOLVED limits so buildConfig derives the current model's
      // slider MAXIMA from the same maps. The host models are re-fetched on
      // every config build, so this also survives a reload.
      if (m.contextLength) this.modelsDevContext.set(key, m.contextLength);
      if (m.maxOutputTokens) this.modelsDevOutput.set(key, m.maxOutputTokens);
    }
    this.enrichLimitsFromModelsDev(providerModels);

    let modelMissing = false;
    const rt = this.activeRuntime();
    const sessionModel = rt?.model ?? "";
    const sessionProvider = rt?.modelProvider ?? cfg.activeProvider;
    const activeName = sessionProvider;
    const activeList = activeName ? (fetched.get(activeName) ?? []) : [];
    if (sessionModel && activeList.length > 0 && !activeList.some((m) => m.id === sessionModel)) modelMissing = true;

    // Explicit in-panel warning: NO model at all (no config file, empty config,
    // or every host unreachable) -> the dropdown would be silently empty.
    const noModels = providerModels.length === 0 && (cfg.availableModels ?? []).length === 0;

    // The model's DETECTED limits become the SLIDER MAXIMA (so you can only
    // DECREASE from them, never ask for more than the model supports); when the
    // limit is unknown the global ceiling applies.
    const curKey = sessionProvider && sessionModel ? `${sessionProvider}|${sessionModel}` : "";
    const ctxMax = (curKey ? this.modelsDevContext.get(curKey) : undefined) ?? MAX_CONTEXT_WINDOW;
    const outMax = (curKey ? this.modelsDevOutput.get(curKey) : undefined) ?? MAX_OUTPUT_TOKENS;
    // The value the request will actually send: the session override when set,
    // otherwise the config/provider default. The UI must show THIS (not a bare
    // 8 192) so the slider matches the real max_tokens.
    const cfgOutputDefault = typeof cfg.maxTokens === "number" ? cfg.maxTokens : DEFAULT_OUTPUT_TOKENS;

    // Warn ONLY when the models.dev fallback is unreachable AND some model is
    // still missing a limit (otherwise the warning would be pure noise).
    const modelsDevError =
      this.options.modelsDev?.isReachable?.() === false &&
      providerModels.some((m) => !m.contextLength || !m.maxOutputTokens);

    return {
      provider: cfg.provider,
      activeProvider: sessionProvider,
      model: sessionModel,
      hasKey: !requiresApiKey(cfg),
      workspaceReady: this.workspaceReady(),
      models: cfg.availableModels ?? [],
      providerModels,
      modelMissing,
      ...(modelsDevError ? { modelsDevError: true } : {}),
      hostModelErrors,
      noModels,
      configHome: this.options.configHome ?? "",
      thinkingMode: cfg.thinkingMode,
      thinkingLevel: cfg.thinkingLevel,
      // CONCRETE mode (never undefined): a fresh session is analyze, so the UI
      // always mirrors what the agent actually enforces (no stale read-only).
      mode: this.activeRuntime()?.mode ?? "analyze",
      parallel: this.activeRuntime()?.parallel === true,
      // The SESSION's tool scope travels with the config it already receives: a separate message
      // would have to race the switch view (the webview drops one for a session it is not showing).
      toolScope: this.activeRuntime()?.toolScope,
      // The EFFECTIVE cap the agent will use (session override > config > 4).
      maxParallelSubAgents: this.effectiveParallelCap(),
      loopGuard: this.activeRuntime()?.loopGuard,
      loopGuardResponse: this.activeRuntime()?.loopGuardResponse,
      // The SAVED per-session field values (absent = fall back to the preset).
      loopGuardParams: this.activeRuntime()?.loopGuardOverrides,
      // The preset VALUES + the editable RANGES behind the Loop Guard fields,
      // so the UI never duplicates them (one source of truth in the core).
      loopGuardPresets: loopGuardPresets(),
      loopGuardRanges: LOOP_GUARD_FIELD_RANGES,
      skills: this.skillCatalog(),
      mcp: { servers: this.providers.readMcpServers?.() ?? {}, statuses: this.mcpStatusesForView() },
      contextWindow: clampContextWindow(rt?.contextWindow ?? DEFAULT_CONTEXT_WINDOW, ctxMax),
      // Same window + reserve the auto-compaction threshold uses, so the bar and
      // the trigger are one number by construction.
      contextUsable: usableContext(this.budgetWindow(rt), this.budgetReserve(rt)),
      // The slider SCALE is the model's real max (no global cap): an identified
      // model can go up to its own limit, an unknown one uses the fallback.
      maxContextWindow: clampContextWindow(ctxMax, ctxMax),
      // Only the session override, so the UI can show "Auto" (undefined) vs
      // an explicit value. Config-file defaults stay effective but hidden.
      compactionThresholdPercent: this.activeRuntime()?.compactionThresholdPercent,
      // The EFFECTIVE landing point plus whether AUTO is in force: the modal shows the number
      // and whether it is a decision or the derived default (no duplicated rule per side).
      compactionTargetPercent: rt ? this.targetPercentFor(rt) : undefined,
      compactionTargetAuto: this.activeRuntime()?.compactionTargetPercent === undefined,
      // The displayed value may be SMALLER than the slider MIN (a provider's
      // declared maxTokens like 123 must be honoured) but never above the
      // model's real max (`outMax`).
      outputTokens: Math.min(clampAdoptedOutputTokens(rt?.outputTokens ?? cfgOutputDefault), outMax),
      // Same rule for the output scale: the model's real max, else the fallback.
      maxOutputTokens: clampOutputTokens(outMax, outMax),
      // Only the session override, so the UI can show "Auto" (undefined) vs
      // an explicit value. Config-file defaults stay effective but hidden.
      temperature: this.activeRuntime()?.temperature,
      presencePenalty: this.activeRuntime()?.presencePenalty,
      frequencyPenalty: this.activeRuntime()?.frequencyPenalty,
      topP: this.activeRuntime()?.topP,
      sampler: this.activeRuntime()?.sampler,
      contextTokens: this.activeRuntime()?.contextTokens,
      cachedTokens: this.activeRuntime()?.cachedTokens,
      cachedWrite: this.activeRuntime()?.cachedWriteTokens,
    };
  }

  /**
   * A selected model whose host did not report a context window: try the cached
   * models.dev value, then the catalog itself; when NEITHER source knows it, ASK
   * (in-panel form with the same two sliders as the Window / Output card).
   */
  private async ensureModelLimits(
    rt: SessionRuntime,
    model: string,
    provider?: string,
    alert = true,
    adoptedCtx?: number,
    adoptedOut?: number,
  ): Promise<void> {
    const key = provider ? `${provider}|${model}` : "";
    // "Identified" comes from BOTH sources: the values the HOST reported (passed
    // in) and the models.dev cache (list enrichment / a previous resolution).
    let ctx = adoptedCtx ?? (provider ? this.modelsDevContext.get(key) : undefined);
    let out = adoptedOut ?? (provider ? this.modelsDevOutput.get(key) : undefined);
    // 1) Already resolved (host and/or enrichment): apply it immediately.
    if (ctx || out) {
      this.applyLimits(rt, model, { context: ctx, output: out });
      if (ctx && out) return;
    }
    // 2) The USER already sized this model and one side is still missing (the
    //    other comes from a source added since): fill the gap silently — the
    //    question was answered, it must not be asked twice for the same model.
    const answered = key ? this.userLimits.get(key) : undefined;
    if (answered && this.activeRuntime() === rt && rt.model === model) {
      const patch: SessionSettingsPatch = {};
      if (!ctx) {
        ctx = answered.context;
        rt.contextWindow = ctx;
        patch.contextWindow = ctx;
      }
      if (!out) {
        out = answered.output;
        rt.outputTokens = out;
        patch.outputTokens = out;
      }
      if (patch.contextWindow !== undefined || patch.outputTokens !== undefined) {
        this.commitSetting(rt, () => this.sessions.saveSettings(rt.sessionId, patch));
      }
      if (ctx && out) return;
    }
    // 3) Ask models.dev (cached catalog) for whatever is still missing.
    const catalog = this.options.modelsDev;
    if (catalog && provider && (!ctx || !out)) {
      const entry = this.providers.getProvider(provider);
      const limits = await catalog
        .getLimits(model, modelsDevProviderCandidates(provider, entry?.baseUrl))
        .catch((): { context?: number; output?: number } => ({}));
      if (limits.context && !ctx) {
        ctx = limits.context;
        this.modelsDevContext.set(key, limits.context);
      }
      if (limits.output && !out) {
        out = limits.output;
        this.modelsDevOutput.set(key, limits.output);
      }
    }
    if (ctx || out) {
      this.applyLimits(rt, model, { context: ctx, output: out });
      if (ctx && out) return;
    }
    // 4) At least ONE side is unknown everywhere: ASK FOR IT — in the form of the
    //    same two sliders the Window / Output card has, pre-filled with the values
    //    in use (so OK without touching anything is exactly today's behaviour).
    //    A local model whose host reports nothing (llama.cpp & friends) is
    //    precisely this case, and pointing at another card was a dead end: the
    //    answer belongs in the question. Skipped for a SILENT (on-open) pass.
    if (!alert) return;
    if (this.activeRuntime() !== rt || rt.model !== model) return; // raced
    const missing = [ctx ? "" : "context window", out ? "" : "max output tokens"].filter(Boolean).join(" and ");
    const maxCtx = ctx ?? MAX_CONTEXT_WINDOW;
    const maxOut = out ?? MAX_OUTPUT_TOKENS;
    const answer = await this.requestPanelModal({
      kind: "alert",
      alertKind: "info",
      title: "Model limits unknown",
      message:
        `Harny could not determine the ${missing} for "${model}" (the host did not report it and it is not in ` +
        "models.dev), so it applied defaults. The sliders below start from the values in use — set the real " +
        "ones and auto-compaction and the output cap follow them.",
      confirmText: "Apply",
      fields: [
        {
          key: "contextWindow",
          label: "Context window",
          min: MIN_CONTEXT_WINDOW,
          max: maxCtx,
          step: reachableStep(MIN_CONTEXT_WINDOW, maxCtx, CONTEXT_SLIDER_STEP),
          value: Math.min(rt.contextWindow ?? DEFAULT_CONTEXT_WINDOW, maxCtx),
          hint: ctx
            ? `Detected for this model: ${ctx} tokens. The slider can only lower it.`
            : "Unknown: set the window the server really serves (the file name of a GGUF often says it).",
        },
        {
          key: "outputTokens",
          label: "Max output tokens",
          min: MIN_OUTPUT_TOKENS,
          max: maxOut,
          step: reachableStep(MIN_OUTPUT_TOKENS, maxOut, OUTPUT_SLIDER_STEP),
          value: Math.min(rt.outputTokens ?? DEFAULT_OUTPUT_TOKENS, maxOut),
          hint: out
            ? `Detected for this model: ${out} tokens. The slider can only lower it.`
            : "Unknown: the response budget the server accepts. Too high and the request is refused.",
        },
      ],
    });
    if (this.activeRuntime() !== rt || rt.model !== model) return; // raced
    if (!answer || typeof answer !== "object") return; // dismissed: defaults stay
    const values = answer as { contextWindow?: unknown; outputTokens?: unknown };
    // A side the answer does not carry (a host/webview skew, or a form that only
    // asked one question) keeps what is in use: a missing number must never
    // silently reset a limit to the default.
    const pick = (v: unknown, fallback: number, clamp: (n: number) => number): number => {
      const n = typeof v === "number" ? v : Number(v);
      return Number.isFinite(n) && n > 0 ? clamp(n) : fallback;
    };
    this.applyUserLimits(rt, model, provider, {
      context: pick(values.contextWindow, rt.contextWindow ?? DEFAULT_CONTEXT_WINDOW, toContextWindow),
      output: pick(values.outputTokens, rt.outputTokens ?? DEFAULT_OUTPUT_TOKENS, toOutputTokens),
    });
  }

  /**
   * Limits the USER typed in the "Model limits unknown" form. They ARE the truth
   * about the model — the session adopts them and the question is not asked again
   * for this `provider|model` — but they are deliberately NOT written to the
   * models.dev maps: those CAP the sliders, and an underestimate must stay
   * correctable from the Window card without switching model first.
   */
  private applyUserLimits(
    rt: SessionRuntime,
    model: string,
    provider: string | undefined,
    limits: { context: number; output: number },
  ): void {
    if (this.activeRuntime() !== rt || rt.model !== model) return;
    rt.contextWindow = limits.context;
    rt.outputTokens = limits.output;
    if (provider) this.userLimits.set(`${provider}|${model}`, limits);
    this.commitSetting(rt, () =>
      this.sessions.saveSettings(rt.sessionId, {
        contextWindow: limits.context,
        outputTokens: limits.output,
      }),
    );
  }

  /** Apply resolved limits to the session (only if the model is still current). */
  private applyLimits(rt: SessionRuntime, model: string, limits: { context?: number; output?: number }): void {
    if (this.activeRuntime() !== rt || rt.model !== model) return;
    const patch: SessionSettingsPatch = {};
    if (limits.context) {
      rt.contextWindow = clampAdoptedContextWindow(limits.context);
      patch.contextWindow = rt.contextWindow;
      if (rt.modelProvider) this.modelsDevContext.set(`${rt.modelProvider}|${model}`, rt.contextWindow);
    }
    if (limits.output) {
      rt.outputTokens = clampAdoptedOutputTokens(limits.output);
      patch.outputTokens = rt.outputTokens;
      if (rt.modelProvider) this.modelsDevOutput.set(`${rt.modelProvider}|${model}`, rt.outputTokens);
    }
    if (patch.contextWindow === undefined && patch.outputTokens === undefined) return;
    this.sessions.saveSettings(rt.sessionId, patch);
    void this.pushConfig();
  }

  /**
   * Resolve from models.dev (best-effort, BACKGROUND) the context windows that
   * a host did NOT report, so the model list shows them too. Each
   * `provider|model` is attempted at most once per session; when something
   * resolves, a config push refreshes the list.
   */
  private enrichLimitsFromModelsDev(
    providerModels: { provider: string; model: string; contextLength?: number; maxOutputTokens?: number }[],
  ): void {
    const catalog = this.options.modelsDev;
    if (!catalog) return;
    const missing = providerModels.filter((m) => {
      const key = `${m.provider}|${m.model}`;
      return (!m.contextLength || !m.maxOutputTokens) && !this.modelsDevAttempted.has(key);
    });
    if (missing.length === 0) return;
    for (const m of missing) this.modelsDevAttempted.add(`${m.provider}|${m.model}`);
    void (async () => {
      let resolved = 0;
      for (const m of missing) {
        const entry = this.providers.getProvider(m.provider);
        const limits = await catalog
          .getLimits(m.model, modelsDevProviderCandidates(m.provider, entry?.baseUrl))
          .catch((): { context?: number; output?: number } => ({}));
        if (limits.context) {
          this.modelsDevContext.set(`${m.provider}|${m.model}`, limits.context);
          resolved++;
        }
        if (limits.output) {
          this.modelsDevOutput.set(`${m.provider}|${m.model}`, limits.output);
          resolved++;
        }
      }
      if (resolved > 0) void this.pushConfig();
    })();
  }

  private async fetchHostModels(name: string): Promise<ModelInfo[]> {
    const entry = this.providers.getProvider(name);
    if (!entry?.baseUrl) throw new Error("no baseUrl configured");
    const key = `${name}|${entry.baseUrl}|${entry.apiKey ?? ""}`;
    const cached = this.hostCache.get(key);
    if (cached && Date.now() - cached.at < ChatViewProvider.HOST_CACHE_TTL) return cached.models;
    const models: ModelInfo[] = this.modelList.fetchModelInfos
      ? await this.modelList.fetchModelInfos({ baseUrl: entry.baseUrl, apiKey: entry.apiKey })
      : (await this.modelList.fetchModels({ baseUrl: entry.baseUrl, apiKey: entry.apiKey })).map((id) => ({ id }));
    this.hostCache.set(key, { at: Date.now(), models });
    // Diagnostics: how many models reported a context window (Output > Harny).
    const withCtx = models.filter((m) => m.contextLength);
    infoLog(
      `[models] ${name}: ${models.length} model(s), ${withCtx.length} with a context window` +
        (withCtx[0] ? ` (e.g. ${withCtx[0].id} = ${withCtx[0].contextLength})` : ""),
    );
    return models;
  }

  /**
   * Rebuild the transcript in the view, WITHOUT losing a turn that is still
   * streaming.
   *
   * The committed messages come from history, but the text of the in-flight turn
   * lives in the StreamTee (nothing has committed it yet): a refresh carrying only
   * `messages` would wipe the answer being written, and the deltas that follow would
   * start a NEW bubble mid-word. So every refresh goes through here and carries the
   * live text whenever this session is running — one place to get it right.
   */
  private refreshTranscript(rt: SessionRuntime, withSkills = false): void {
    const live = rt.engine.projection();
    this.view?.webview.postMessage({
      type: "refresh",
      messages: rt.agent.getMessages(),
      ...(withSkills ? { skills: this.skillCatalog() } : {}),
      ...(rt.agent.streaming && live
        ? { streaming: true, liveThinking: live.thinking, liveAnswer: live.answer, liveTurn: live }
        : {}),
    });
  }

  /**
   * Coalesced variant for BACKGROUND config pushes (a usage report from a session
   * you are not watching, a compaction that is not on screen): N calls in a burst
   * collapse into ONE build + ONE post. It carries no new information of its own —
   * the metrics it renders are the ACTIVE session's — so the noisy callers skip it
   * entirely when they are not the active one.
   */
  private pushConfigSoon(): void {
    if (this.configSoonTimer !== undefined) return;
    this.configSoonTimer = setTimeout(() => {
      this.configSoonTimer = undefined;
      void this.pushConfig();
    }, CONFIG_COALESCE_MS);
    this.configSoonTimer.unref?.();
  }

  /**
   * Persist the context-token METRIC, coalesced.
   *
   * It used to be one `saveSettings` — a synchronous, single-threaded SQLite
   * transaction (upsert + a count query) — on EVERY usage report, i.e. every turn of
   * every session. With ten sessions streaming that is ten transactions per turn for
   * a number that is (a) recomputed from scratch by the next turn and (b) read by the
   * UI from MEMORY (`rt.contextTokens`), never from the DB. So the writes bought
   * nothing and cost the host thread the thing it has least of.
   *
   * Coalesced, not dropped: the last value lands on the debounce, and IMMEDIATELY when
   * the run ends or the session is closed (a closed session would otherwise lose it).
   */
  private persistContextTokensSoon(rt: SessionRuntime): void {
    this.pendingTokenFlush.add(rt.sessionId);
    if (this.tokenFlushTimer !== undefined) return;
    this.tokenFlushTimer = setTimeout(() => this.flushContextTokens(), CONTEXT_TOKENS_FLUSH_MS);
    this.tokenFlushTimer.unref?.();
  }

  /** Write every pending metric NOW (run end, tab close, or the debounce firing). */
  private flushContextTokens(): void {
    if (this.tokenFlushTimer !== undefined) {
      clearTimeout(this.tokenFlushTimer);
      this.tokenFlushTimer = undefined;
    }
    if (this.pendingTokenFlush.size === 0) return;
    const ids = [...this.pendingTokenFlush];
    this.pendingTokenFlush.clear();
    for (const id of ids) {
      const rt = this.registry.get(id);
      if (!rt || typeof rt.contextTokens !== "number") continue;
      try {
        this.sessions.saveSettings(id, { contextTokens: rt.contextTokens });
      } catch (e: any) {
        // A metric must never take a run down with it.
        infoLog("could not persist the token metric:", e?.message || String(e));
      }
    }
  }

  private async pushConfig(): Promise<void> {
    try {
      const seq = ++this.configSeq;
      const config = await this.buildConfig();
      // Drop a STALE result: an older `buildConfig` can resolve after a newer one.
      if (seq !== this.configSeq) return;
      this.view?.webview.postMessage({ type: "config", config, configSeq: seq });
    } catch (e) {
      // `pushConfig` is fire-and-forget: never let a failure become an
      // unhandled rejection (the next push recovers the UI).
      debugLog("pushConfig failed", e);
    }
  }

  /** The editor font size in px (editor.fontSize). Harny's root font follows
   * it so the chat text lines up with the code in the editing windows. */
  private editorFontSizePx(): number {
    const size = workspace.getConfiguration("editor").get<number>("fontSize");
    return typeof size === "number" && size > 0 ? size : 14;
  }

  /** `harny.theme`: which of Harny's two palettes the panel uses. `auto` hands
   * the choice to the editor (its body class decides, and VS Code updates that
   * class live on a theme change); `dark`/`light` PIN one, so the panel keeps
   * its look even when the editor theme is the other kind. */
  private themeMode(): "auto" | "dark" | "light" {
    const mode = workspace.getConfiguration("harny").get<string>("theme");
    return mode === "dark" || mode === "light" ? mode : "auto";
  }

  private async buildHtml(): Promise<string> {
    const active = this.activeRuntime();
    const messages = active ? active.agent.getMessages() : [];
    const live = active?.engine.projection();
    const config = await this.buildConfig();
    // Cache-bust the webview bundle: VS Code caches webview resources strongly,
    // so a plain asWebviewUri may keep serving an OLD media/view.js after a
    // rebuild even across reloads. The mtime in the query forces a re-fetch.
    const viewPath = Uri.joinPath(this.context!.extensionUri, "media", "view.js");
    const viewUri = this.view!.webview.asWebviewUri(viewPath);
    let version = "0";
    try {
      version = String(fs.statSync(viewPath.fsPath).mtimeMs);
    } catch {
      /* file missing: fall back to no version */
    }
    // Brand mark: also loaded through asWebviewUri (media/ is already in
    // localResourceRoots) and cache-busted the same way, so replacing
    // media/icon.svg shows up on the next webview render — no rebuild, no
    // inlined copy in the source to keep in sync.
    const logoPath = Uri.joinPath(this.context!.extensionUri, "media", "icon.svg");
    const logoUri = this.view!.webview.asWebviewUri(logoPath);
    let logoVersion = "0";
    try {
      logoVersion = String(fs.statSync(logoPath.fsPath).mtimeMs);
    } catch {
      /* file missing: the hero simply renders without the mark */
    }
    // Publisher credit for the empty hero, read from the manifest rather than
    // hardcoded. It links ONLY when `homepage` is set explicitly: `repository`
    // is deliberately NOT a fallback, because the repo may be private and the
    // link would hand every user a 404. Without `homepage` the credit is plain
    // text. Set package.json `homepage` to a public URL to turn the link on.
    const pkg = (this.context?.extension as { packageJSON?: { homepage?: string } } | undefined)?.packageJSON;
    const homepage = pkg?.homepage?.trim();
    const brand = { name: "SPLTek", url: homepage ? homepage : undefined };
    return renderViewHtml({
      cspSource: this.view!.webview.cspSource,
      scriptUri: viewUri.with({ query: "v=" + version }).toString(),
      editorFontSizePx: this.editorFontSizePx(),
      theme: this.themeMode(),
      state: {
        sessions: this.sessionsForView(),
        openIds: this.registry.listOpenIds(),
        activeId: this.activeId,
        messages,
        config,
        version: (this.context?.extension as { packageJSON?: { version?: string } } | undefined)?.packageJSON?.version,
        logoUri: logoUri.with({ query: "v=" + logoVersion }).toString(),
        brand,
        workingIds: this.workingIds(),
        streaming: !!active && active.engine.working,
        compacting: !!active && this.isCompacting(active.sessionId),
        pending: active ? this.pendingQueue.items(active.sessionId) : [],
        liveThinking: live?.thinking ?? "",
        liveAnswer: live?.answer ?? "",
        ...(live ? { liveTurn: live } : {}),
      },
    });
  }
}
