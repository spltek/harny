import type { ExtensionContext, WebviewView, WebviewViewProvider, WebviewViewResolveContext } from "vscode";
import { Uri, window, workspace } from "vscode";
import * as fs from "fs";
import type { ConfigProvider, HarnyConfig, ProviderCatalog, ProviderEditorData, ThinkingLevel } from "../core/config/types";
import { isThinkingLevel } from "../core/config/types";
import type { MemoryOverrideConfigProvider } from "../core/config/memory-override-config-provider";
import { requiresApiKey } from "../core/config/requires-api-key";
import type { ModelInfo, ModelListProvider } from "../core/llm/model-list";
import { modelsDevProviderCandidates } from "../core/llm/models-dev";
import type { SessionManager } from "../core/sessions/session-manager";
import type { DbVacuumStats, SessionSettingsPatch, SessionSummary } from "../core/sessions/types";
import type { SessionRegistry, SessionRuntime } from "./session-registry";
import { PendingInputQueue, type PendingInput } from "./pending-input-queue";
import { StreamTee } from "./stream-tee";
import type { AttachmentService } from "./attachment-service";
import type { AttachmentInfo, AttachmentPart } from "./attachment-types";
import { debugLog, infoLog } from "../logger";
import { preprocessJsonc } from "../core/config/jsonc";
import { renderViewHtml } from "./view-html";
import { toTemperature, toTopP } from "./temperature";
import { DEFAULT_CONTEXT_WINDOW, DEFAULT_OUTPUT_TOKENS, MAX_CONTEXT_WINDOW, MAX_OUTPUT_TOKENS, clampAdoptedContextWindow, clampAdoptedOutputTokens, clampContextWindow, clampOutputTokens, toContextWindow, toOutputTokens } from "./context-window";
import { PanelModalQueue } from "./panel-modal-queue";
import { Compactor, DEFAULT_COMPACTION, CompactionSettings, planManualCompaction, shouldCompact, estimateTokens, serializeConversation, estimateContextTokens, realWindowTokens, splitSummary, toCompactionThresholdPercent } from "../core/sessions/compactor";
import type { SkillRegistry } from "../core/skills/skill-registry";
import type { McpManager } from "../core/mcp";
import { McpStdioClient, McpHttpClient, type McpClient } from "../core/mcp";
import type { McpServerConfig, McpStdioServerConfig, McpHttpServerConfig } from "../core/config/types";
import { LOOP_GUARD_FIELD_RANGES, clampLoopGuardOverrides, loopGuardPresets, normalizeLoopGuardSensitivity, resolveLoopGuardOptions } from "../core/agent/loop-guard";
import type { LoopGuardOptions } from "../core/agent/loop-guard";
import { DEFAULT_MAX_PARALLEL_SUB_AGENTS } from "../core/agent/agent";

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
  // Short host-model cache: the dropdown re-fetches on open (view sends
  // getConfig on mousedown/focus), so a host that comes up later (e.g. llama.cpp
  // started after the panel) shows up on the next open. Kept short because the
  // fetch itself is bounded by HOST_MODEL_TIMEOUT_MS anyway.
  private static readonly HOST_CACHE_TTL = 5_000;
  private compacting = false;
  /**
   * Orchestration (sub-agents) master switch — the UI "Parallel" toggle.
   * GLOBAL on purpose: it is a UI-level switch, so it must never diverge from
   * the agent. The webview re-asserts it on load.
   */
  private parallelEnabled = false;
  /** Per-session queue of messages typed while the agent works (queue/steer). */
  private readonly pendingQueue: PendingInputQueue;
  /** True while an async SEND PREAMBLE is in flight for a session (attachment
   * build / auto-compaction), before `agent.send` flips `streaming` to true.
   * Without it a second message arriving in that window would start a second
   * overlapping run on the same agent. */
  private readonly sending = new Set<string>();
  /** FIFO queue for in-panel modals (name dialog, alerts, confirms…). */
  private modals: PanelModalQueue;
  /** True while the shared "compact database" modal is open (avoid re-prompts). */
  private vacuumPromptOpen = false;

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
        getLimits(modelId: string, providerCandidates: readonly string[]): Promise<{ context?: number; output?: number }>;
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
        // editor.fontSize drives the root font; any `harny.*` setting may change
        // the provider/model limits, so both trigger a refresh (which also
        // re-applies the runtime overrides).
        if (e.affectsConfiguration("editor.fontSize") || e.affectsConfiguration("harny")) this.refresh();
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
      vacuum: { stats: this.sessions.dbVacuumStats(), threshold: this.vacuumThresholdPercent(), minFreeMB: this.vacuumMinFreeMB() },
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
    this.parallelEnabled = false;
    rt.agent.setDelegation(false);
    await this.setActive(rt.sessionId);
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
    return this.currentFolderSessions()
      .some((s) => s.id !== excludeId && (s.name || "").trim().toLowerCase() === n);
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
    const rt = this.registry.get(id);
    // The ⎇ buttons are DISABLED while the session works: this is only a
    // silent safety guard (no alert — the UI already reflects the state).
    if (rt?.agent.streaming) return;
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
    if (rt.agent.streaming) return;
    if (!Number.isInteger(index) || index < 0) return;
    const loaded = this.sessions.load(rt.sessionId);
    if (index >= loaded.messages.length) return; // stale bubble, treat as gone
    const name = await this.askName("branch", rt.sessionId);
    if (name === undefined) return;
    if (this.sessionNameTaken(name)) {
      await this.warnNameTaken(name);
      return;
    }
    await this.createBranch(rt.sessionId, name, loaded.messages.slice(0, index + 1));
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
    if (rt.agent.streaming) return;
    if (!Number.isInteger(index) || index < 0) return;
    // Slice the SAME array the UI rendered (the agent's in-memory history), so
    // the bubble index matches exactly.
    const messages = rt.agent.getMessages();
    if (index >= messages.length) return; // stale bubble, treat as gone
    // Keeping [0, index) drops that message and the whole tail, so a tool-call
    // is never left without its tool results.
    const kept = messages.slice(0, index);
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
    this.view?.webview.postMessage({ type: "refresh", messages: rt.agent.getMessages(), skills: this.skillCatalog() });
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
    await this.setActive(created.id);
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
        prompt: mode === "rename" ? "Rename session" : mode === "branch" ? "Branch session" : "Name for the new session",
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
  async setActive(id: string): Promise<void> {
    this.activeId = id;
    this.resubscribe();
    this.applyActiveModel();
    // A session may predate the model-limits feature: adopt the model's
    // DETECTED context/output when it has no explicit override yet (silent —
    // no alert on open).
    const rt = this.registry.get(id);
    if (rt?.model && (rt.contextWindow === undefined || rt.outputTokens === undefined)) {
      void this.ensureModelLimits(rt, rt.model, rt.modelProvider, false);
    }
    await this.postSwitchView();
  }

  async closeTab(id: string): Promise<void> {
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

  /** Session ids whose agent is currently streaming (blocks delete, drives the lock). */
  private workingIds(): string[] {
    return this.registry.listOpenIds().filter((id) => this.registry.get(id)?.agent.streaming);
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
  private async postSwitchView(): Promise<void> {
    if (!this.view) return;
    const active = this.activeRuntime();
    const config = await this.buildConfig();
    const live = this.streamTee.liveOf(this.activeId ?? "");
    this.view.webview.postMessage({
      type: "switchView",
      activeId: this.activeId,
      openIds: this.registry.listOpenIds(),
      sessions: this.currentFolderSessions(),
      messages: active ? active.agent.getMessages() : [],
      config,
      workingIds: this.workingIds(),
      streaming: !!active?.agent.streaming,
      pending: active ? this.pendingQueue.items(active.sessionId) : [],
      liveThinking: live?.thinking ?? "",
      liveAnswer: live?.answer ?? "",
    });
  }

  resolveWebviewView(
    webviewView: WebviewView,
    _context: WebviewViewResolveContext,
    _token: unknown,
  ): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [Uri.joinPath(this.context!.extensionUri, "media")],
    };
    webviewView.webview.onDidReceiveMessage((msg) => this.onMessage(msg));
    this.resubscribe();
    this.refresh();
    // Startup suggestion: cheap O(1) check once the page is up.
    setTimeout(() => void this.maybeSuggestVacuum(), 3000);
  }

  /** Rebuild the whole view (host-side refresh after any change). */
  refresh(): void {
    if (!this.view) return;
    // Rebuilding the page wipes any open modal, so cancel its host-side promise
    // (otherwise the create/rename/delete flow that awaited it hangs forever).
    this.modals.cancelAll();
    // Re-apply the per-model overrides FIRST: a CONFIG edit (baseUrl / apiKey /
    // maxTokens / thinkingMode…) must take effect immediately — the composite
    // lets runtime overrides win, so a stale override would shadow the file.
    this.applyActiveModel();
    void this.buildHtml().then((html) => {
      if (this.view) this.view.webview.html = html;
    });
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
          await this.options.mcp?.connect();
          this.view?.webview.postMessage({ type: "mcpServers", data: this.mcpEditorData() });
          void this.pushConfig();
        }
        break;
      }
      case "saveMcpServers": {
        const servers =
          msg.servers && typeof msg.servers === "object" ? (msg.servers as Record<string, McpServerConfig>) : {};
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
          this.view?.webview.postMessage({ type: "mcpTested", ok: false, error: e instanceof Error ? e.message : String(e) });
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
        const provider =
          typeof msg.provider === "string" && msg.provider.trim() ? msg.provider.trim() : undefined;
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
            if (info?.contextLength && info.contextLength > 0) adoptedCtx = clampAdoptedContextWindow(info.contextLength);
            if (info?.maxOutputTokens && info.maxOutputTokens > 0) adoptedOut = clampAdoptedOutputTokens(info.maxOutputTokens);
          } catch {
            /* host unreachable: leave the limits unknown (default below) */
          }
        }
        // KNOWN model: adopt its real limits. UNKNOWN model: fall back to the
        // DEFAULTS (context 128k / output = the provider's maxTokens or 16 384)
        // — never keep the PREVIOUS model's values.
        const entryMaxTokens = provider ? this.providers.getProvider(provider)?.maxTokens : undefined;
        rt.contextWindow = adoptedCtx ?? DEFAULT_CONTEXT_WINDOW;
        rt.outputTokens =
          adoptedOut ??
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
        if (!adoptedCtx || !adoptedOut) void this.ensureModelLimits(rt, model, provider);
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
        if (!rt || (msg.mode !== "analyze" && msg.mode !== "agent")) break;
        rt.mode = msg.mode as "analyze" | "agent";
        // The agent enforces it: analyze = read-only; agent = full tools.
        rt.agent.setMode(rt.mode);
        void this.pushConfig();
        break;
      }

      case "setParallel": {
        if (typeof msg.parallel !== "boolean") break;
        // Global master switch: applies to the active agent now, and to every
        // session from here on (also re-synced at send time).
        this.parallelEnabled = msg.parallel;
        this.activeRuntime()?.agent.setDelegation(this.parallelEnabled);
        void this.pushConfig();
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
        // Per-session Loop Guard sensitivity; undefined clears the override (= normal).
        const level = normalizeLoopGuardSensitivity(msg.value);
        rt.loopGuard = level;
        // Picking a level RESETS the saved field overrides: the preset becomes
        // the new baseline (the UI repopulates its fields from it).
        rt.loopGuardOverrides = undefined;
        this.applyLoopGuard(rt);
        this.commitSetting(rt, () => this.sessions.saveSettings(rt.sessionId, { loopGuard: level, loopGuardParams: undefined }), false);
        break;
      }

      case "setLoopGuardOverrides": {
        const rt = this.activeRuntime();
        if (!rt) break;
        // Tuning from the Loop Guard fields: clamped to the editable ranges,
        // applied to the agent AND SAVED on the session (persisted per session).
        rt.loopGuardOverrides = clampLoopGuardOverrides(msg.overrides);
        this.applyLoopGuard(rt);
        this.commitSetting(rt, () => this.sessions.saveSettings(rt.sessionId, { loopGuardParams: rt.loopGuardOverrides }), false);
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
        if (!r || this.compacting) break;
        const ok = await this.inPanelAlert({
          kind: "confirm",
          title: "Compact context",
          message: "Run context compaction now? The older messages are summarized into the session context.",
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
        // Threshold only affects auto-compaction, never the per-model overrides.
        this.commitSetting(rt, () => this.sessions.saveSettings(rt.sessionId, { compactionThresholdPercent: value }), false);
        break;
      }
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
        if (rt) await this.send(rt, msg);
        break;
      case "abort":
        if (rt?.agent.streaming) {
          // Stop = the user regains control: drop anything still queued/steered
          // so the run does not silently restart from the pending list.
          this.pendingQueue.clear(rt);
          rt.agent.abort();
          this.streamTee.clear(rt.sessionId);
          // Red bubble "Processing interrupted" in the transcript.
          this.view?.webview.postMessage({ type: "interrupted" });
          // Persist the notice too, so it survives refresh / session reload and
          // keeps the LLM-aware story coherent (not just UI-only). The ❌ prefix
          // makes it render as a red bubble like the other errors.
          rt.history.add({
            role: "assistant",
            content: "❌ ⏹ Processing interrupted.",
            timestamp: Date.now(),
          });
        }
        break;
      case "abortSubAgent":
        // Stop ONE sub-agent (its Delegate bubble), leaving the run alive. The
        // orchestrator still receives that Delegate's tool result (interrupted)
        // so it can continue with the remaining work.
        if (rt && typeof msg.toolCallId === "string") rt.agent.abortSubAgent(msg.toolCallId);
        break;
      case "cancelPending":
        // Drop a queued/steer message the user changed their mind about.
        if (rt && typeof msg.id === "string") this.pendingQueue.cancel(rt, msg.id);
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
    this.compacting = true;
    const isActive = this.activeId === rt.sessionId;
    if (isActive) {
      this.view?.webview.postMessage({ type: "compactStart" });
      this.view?.webview.postMessage({ type: "status", active: true, message: "Compacting…" });
    }
    try {
      await this.performCompaction(rt, signal);
    } finally {
      this.compacting = false;
      if (isActive) {
        // Re-render the transcript so the SYNTHETIC user prompt (orange) +
        // assistant response that replaced the summarized span are visible.
        this.view?.webview.postMessage({ type: "refresh", messages: rt.agent.getMessages() });
        this.view?.webview.postMessage({ type: "status", active: false });
      }
    }
    // Update the metrics immediately via a lightweight config push (no full
    // HTML rebuild, so the user's input/scroll are preserved).
    void this.pushConfig();
  }

  /**
   * Mid-run auto-compaction, invoked by the agent at every TURN BOUNDARY. If
   * the context threshold is exceeded, compact the session in place and let the
   * agent resume with the compacted history (the run continues). The global
   * "working" status is deliberately NOT touched: the agent is still running.
   */
  async maybeCompactDuringRun(sessionId: string, signal?: AbortSignal): Promise<void> {
    const rt = this.registry.get(sessionId);
    if (!rt || this.compacting) return;
    if (!this.needsAutoCompact(rt)) return;
    await this.compactDuringRun(rt, signal);
  }

  private async compactDuringRun(rt: SessionRuntime, signal?: AbortSignal): Promise<void> {
    this.compacting = true;
    const isActive = this.activeId === rt.sessionId;
    if (isActive) this.view?.webview.postMessage({ type: "compactStart" });
    try {
      await this.performCompaction(rt, signal);
    } catch (e: any) {
      infoLog("mid-run auto-compaction failed; continuing:", e?.message || String(e));
    } finally {
      this.compacting = false;
      // Only the in-chat bubble changes: no `status` posts, so the working
      // indicator keeps showing (the run is still in flight).
      if (isActive) this.view?.webview.postMessage({ type: "compactDone" });
    }
    void this.pushConfig();
  }

  /**
   * Effective compaction settings for a runtime: the shared defaults overlaid
   * with the session's own threshold % (first run = DEFAULT_COMPACTION 80).
   */
  private compactionSettings(rt: SessionRuntime): CompactionSettings {
    const base = this.options.compaction ?? DEFAULT_COMPACTION;
    return {
      ...base,
      thresholdPercent: rt.compactionThresholdPercent ?? base.thresholdPercent ?? DEFAULT_COMPACTION.thresholdPercent,
    };
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
    if (!this.options.compactor) return false;
    const window = clampContextWindow(rt.contextWindow ?? DEFAULT_CONTEXT_WINDOW);
    const estimated = estimateTokens(serializeConversation(rt.history.conversation()));
    const tokens = Math.max(rt.contextTokens ?? 0, estimated);
    return shouldCompact(tokens, window, this.compactionSettings(rt));
  }

  /**
   * Apply this session's Loop Guard options to the agent: the sensitivity
   * preset (+ the opt-in answer guard) overlaid with any EPHEMERAL field
   * overrides. Called on every send and on each UI change, so a run always
   * starts from the current settings.
   */
  private applyLoopGuard(rt: SessionRuntime): void {
    rt.agent.setLoopGuardOptions({
      ...resolveLoopGuardOptions(rt.loopGuard, rt.loopGuardResponse),
      ...rt.loopGuardOverrides,
    });
  }

  /**
   * Persist settings, then refresh the view's config. `persist` may write
   * several fields at once (single saveSettings call). When `recomputeOverrides`
   * is true (the default) the per-model overrides are re-applied so the active
   * runtime config reflects the new settings; context-window changes skip it
   * because they do not affect the model overrides.
   */
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
  private async send(rt: SessionRuntime, msg: any): Promise<void> {
    if (rt.agent.streaming || this.sending.has(rt.sessionId) || this.pendingQueue.isDraining(rt.sessionId)) {
      this.pendingQueue.enqueue(rt, msg);
      return;
    }
    await this.dispatchSendTracked(rt, msg);
    await this.pendingQueue.drain(rt, (item) => this.dispatchSendTracked(rt, item));
  }

  /** `dispatchSend` with the per-session SEND lock held for its whole async
   * preamble, so a second send arriving before `agent.send` starts is queued
   * instead of launching an overlapping run. */
  private async dispatchSendTracked(rt: SessionRuntime, msg: any): Promise<void> {
    this.sending.add(rt.sessionId);
    try {
      await this.dispatchSend(rt, msg);
    } finally {
      this.sending.delete(rt.sessionId);
    }
  }

  /** Run ONE message to completion (the original send body). */
  private async dispatchSend(rt: SessionRuntime, msg: any): Promise<void> {
    // Re-assert the controls on the agent right before it runs: a session
    // created before a UI toggle (or a reloaded panel) must not send with
    // stale mode/parallel state.
    rt.agent.setMode(rt.mode ?? "analyze");
    rt.agent.setDelegation(this.parallelEnabled);
    rt.agent.setMaxParallelSubAgents(rt.maxParallelSubAgents);
    this.applyLoopGuard(rt);
    const rawText = typeof msg.text === "string" ? msg.text : "";
    const attached = (msg.attachments as AttachmentInfo[] | undefined) ?? [];
    // A message may carry text, attachments, or both — an attachment-only send
    // is valid ("look at this file").
    if (!rawText.trim() && attached.length === 0) return;
    // New sessions start with no model: the user must pick one first. Keep BOTH
    // the user message and an explanatory error IN the history — otherwise the
    // transcript rebuild (refresh/switch) drops them and the follow-up "now do
    // it" reaches the agent with an EMPTY history.
    if (!rt.model) {
      const userContent = rawText.trim() ? rawText : `📎 ${attached.map((a) => a.name).join(", ")}`;
      rt.history.add({ role: "user", content: userContent, timestamp: Date.now() });
      const errorMsg = "Select a model for this session first (dropdown in the header).";
      rt.history.add({ role: "assistant", content: `❌ ${errorMsg}`, timestamp: Date.now() });
      this.view?.webview.postMessage({ type: "error", error: errorMsg });
      return;
    }
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
        this.view?.webview.postMessage({ type: "error", error: `Model \"${cfg.model}\" is text-only and does not support images.` });
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
        this.view?.webview.postMessage({ type: "refresh", messages: rt.agent.getMessages(), skills: this.skillCatalog() });
        return;
      }
      const task = skillCmd[2].trim().slice(name.length).trim() || "Apply this skill to the current task.";
      const injected =
        `Use the following skill instructions.\n\n<skill name="${skill.name}" dir="${skill.dir}">\n${skill.body}\n</skill>\n\n${task}`;
      // Keep any inlined attachment context, but make the skill the leading task.
      text = text && text !== rawText ? `${injected}\n\n${text}` : injected;
      displayText = rawText.trim();
    }
    // Auto-compaction before the request when already over the threshold:
    // runs the EXACT same routine as the manual Compact button. BEST-EFFORT:
    // if the summarizer errors (network), the user's request must still run —
    // otherwise the send never starts and the working indicator hangs.
    if (this.needsAutoCompact(rt) && !this.compacting) {
      try {
        await this.compactNow(rt);
      } catch (e: any) {
        infoLog("auto-compaction failed; continuing with the request:", e?.message || String(e));
      }
    }
    this.streamTee.clear(rt.sessionId);
    // send() sets _streaming synchronously on invocation: start it first, THEN
    // push the status — otherwise workingIds() is still empty and the session
    // row never locks (branch/rename/delete stay hoverable during the work).
    const sending = rt.agent.send(text, {
      images,
      attachments: attachmentMeta,
      displayText,
      attachmentParts: attachmentParts,
    });
    this.postStatus(rt, true);
    let hadError = false;
    const unsub = rt.agent.onEvent((e) => {
      if (e.type === "error") hadError = true;
    });
    try {
      await sending;
    } finally {
      unsub();
      // Only touch the view when this session is still the active tab: the
      // user may have switched to another session while this one streamed
      // (parallel work), and their refresh/status must not clobber it.
      if (this.activeId === rt.sessionId) {
        this.postStatus(rt, false);
        if (!hadError) this.view?.webview.postMessage({ type: "refresh", messages: rt.agent.getMessages(), skills: this.skillCatalog() });
      }
    }
    // Post-response auto-compaction: evaluate the CURRENT fill right after
    // every final response; if the threshold was crossed, run the EXACT same
    // routine as pressing Compact -> OK.
    if (this.needsAutoCompact(rt) && !this.compacting) {
      try {
        await this.compactNow(rt);
      } catch (e: any) {
        infoLog("post-response auto-compaction failed:", e?.message || String(e));
      }
    }
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
      overrides.thinkingLevel = reasoningProvider ? rt?.thinkingLevel ?? entry?.thinkingLevel : undefined;
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
    overrides.temperature = sampler === "temperature" && typeof rt?.temperature === "number" ? rt.temperature : undefined;
    overrides.topP = sampler === "topP" && typeof rt?.topP === "number" ? rt.topP : undefined;
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
    const rt = this.registry.get(id);
    // The ✎ buttons are DISABLED while the session works (silent guard).
    if (rt?.agent.streaming) return;
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
    const rt = this.registry.get(id);
    // The 🗑 buttons are DISABLED while the session works (silent guard).
    if (rt?.agent.streaming) return;
    const ok = await this.inPanelAlert({
      kind: "confirm",
      title: "Delete session",
      message: `Delete session "${existing?.name ?? id}"? This removes its transcript and settings.`,
      confirmText: "Delete",
      danger: true,
    });
    if (!ok) return;
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

  private async performCompaction(rt: SessionRuntime, signal?: AbortSignal): Promise<void> {
    const compactor = this.options.compactor;
    if (!compactor) return;
    const messages = rt.history.conversation();
    // The SAME plan the Compact button uses: always summarizes a fraction of
    // the current context (never a silent no-op).
    const plan = planManualCompaction(messages, this.options.manualKeepFraction ?? 0.6);
    if (plan.toSummarize.length === 0) return;
    const summary = await compactor.summarize(plan.toSummarize, undefined, signal);
    // Represent the summarized span as a synthetic USER prompt + ASSISTANT
    // response, so the transcript ALWAYS starts with an orange user bubble.
    const { prompt: synthPrompt, response: synthResponse } = splitSummary(summary);
    const now = Date.now();
    const newHistory = [
      { role: "user" as const, content: synthPrompt, timestamp: now, synthetic: true },
      { role: "assistant" as const, content: synthResponse, timestamp: now + 1, synthetic: true },
      ...plan.kept,
    ];
    rt.history.replace(newHistory);
    this.sessions.saveMessages(rt.sessionId, newHistory, { replace: true });
    // Prefer REAL data for the KEPT window (the cumulative `meta.inputTokens`
    // delta across it): the summary rewrote the prefix, so re-estimating the
    // whole history would no longer match the provider's numbers.
    const keptFrom = plan.kept.length > 0 ? messages.indexOf(plan.kept[0]) : -1;
    const keptTokens =
      keptFrom >= 0
        ? realWindowTokens(messages, keptFrom) ?? estimateTokens(serializeConversation(plan.kept))
        : 0;
    const next = estimateTokens(synthPrompt) + estimateTokens(synthResponse) + keptTokens;
    rt.contextTokens = next;
    this.sessions.saveSettings(rt.sessionId, { contextTokens: next });
    // The context was rebuilt: any previously reported cache hit is meaningless
    // for the new layout. Reset so the cache indicator hides until the next
    // real chat turn reports fresh usage (avoids stale ratios > 100%).
    rt.cachedTokens = 0;
    rt.cachedWriteTokens = 0;
  }

  /**
   * Streaming router + live buffers, extracted from this class (SRP): it
   * forwards the ACTIVE session's events to the view and accumulates the
   * in-flight thinking/answer for EVERY open session (parallel work + replay).
   */
  private streamTee = new StreamTee({
    isActive: (id) => id === this.activeId,
    onPost: (m) => this.view?.webview.postMessage(m),
    onUsage: (sessionId, usage) => {
      const rt = this.registry.get(sessionId);
      if (!rt) return;
      rt.contextTokens = usage.input;
      this.sessions.saveSettings(sessionId, { contextTokens: usage.input });
      if (typeof usage.cached === "number") rt.cachedTokens = usage.cached;
      if (typeof usage.cachedWrite === "number") rt.cachedWriteTokens = usage.cachedWrite;
      void this.pushConfig();
    },
    onSteerApplied: (sessionId, ids) => this.pendingQueue.onSteerApplied(sessionId, ids),
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

  /** MCP servers (config) + their live status, for the MCP card/editor. */
  private mcpEditorData(): { servers: Record<string, McpServerConfig>; statuses: { name: string; ok: boolean; error?: string; toolCount: number }[] } {
    return { servers: this.providers.readMcpServers?.() ?? {}, statuses: this.options.mcp?.getStatuses() ?? [] };
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
    maxParallelSubAgents: number;
    loopGuard?: "low" | "normal" | "high";
    loopGuardResponse?: boolean;
    /** The SAVED per-session Loop Guard field values (absent = the preset). */
    loopGuardParams?: Partial<LoopGuardOptions>;
    /** Preset VALUES + editable RANGES for the Loop Guard fields (from the core). */
    loopGuardPresets: Record<string, LoopGuardOptions>;
    loopGuardRanges: readonly { key: string; min: number; max: number; step: number; integer: boolean }[];
    /** Installed Agent Skills (catalog for the Skills card). */
    skills: { name: string; description: string }[];
    /** MCP servers + their connection status (MCP card). */
    mcp?: { servers: Record<string, McpServerConfig>; statuses: { name: string; ok: boolean; error?: string; toolCount: number }[] };
    contextWindow: number;
    /** Upper bound of the context slider: the model's DETECTED window, else the global max. */
    maxContextWindow: number;
    compactionThresholdPercent?: number;
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
    // 16 384) so the slider matches the real max_tokens.
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
      parallel: this.parallelEnabled,
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
      mcp: { servers: this.providers.readMcpServers?.() ?? {}, statuses: this.options.mcp?.getStatuses() ?? [] },
      contextWindow: clampContextWindow(this.activeRuntime()?.contextWindow ?? DEFAULT_CONTEXT_WINDOW, ctxMax),
      // The slider SCALE is the model's real max (no global cap): an identified
      // model can go up to its own limit, an unknown one uses the fallback.
      maxContextWindow: clampContextWindow(ctxMax, ctxMax),
      // Only the session override, so the UI can show "Auto" (undefined) vs
      // an explicit value. Config-file defaults stay effective but hidden.
      compactionThresholdPercent: this.activeRuntime()?.compactionThresholdPercent,
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
   * models.dev value, then the catalog itself; when NEITHER source knows it,
   * alert the user (in-panel modal) to set the correct window manually.
   */
  private async ensureModelLimits(rt: SessionRuntime, model: string, provider?: string, alert = true): Promise<void> {
    const key = provider ? `${provider}|${model}` : "";
    let ctx = provider ? this.modelsDevContext.get(key) : undefined;
    let out = provider ? this.modelsDevOutput.get(key) : undefined;
    // 1) Already resolved (e.g. by the list enrichment): apply it immediately.
    if (ctx || out) {
      this.applyLimits(rt, model, { context: ctx, output: out });
      if (ctx && out) return;
    }
    // 2) Ask models.dev (cached catalog) for whatever is still missing.
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
    // 3) Unknown everywhere: prompt the user. Shown on EVERY selection of such a
    //    model (returning to it must remind you again). Skipped for a SILENT
    //    (on-open) pass.
    if (!alert) return;
    if (this.activeRuntime() !== rt || rt.model !== model) return; // raced
    const missing = [ctx ? "" : "context window", out ? "" : "max output tokens"].filter(Boolean).join(" and ");
    await this.inPanelAlert({
      kind: "info",
      title: "Model limits unknown",
      message:
        `Harny could not determine the ${missing} for "${model}" (the host did not report it and it is not in ` +
        `models.dev). Set it from the Window / Output controls to keep auto-compaction and the output cap accurate.`,
    });
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

  private async pushConfig(): Promise<void> {
    const config = await this.buildConfig();
    this.view?.webview.postMessage({ type: "config", config });
  }

  /** The editor font size in px (editor.fontSize). Harny's root font follows
   * it so the chat text lines up with the code in the editing windows. */
  private editorFontSizePx(): number {
    const size = workspace.getConfiguration("editor").get<number>("fontSize");
    return typeof size === "number" && size > 0 ? size : 14;
  }

  private async buildHtml(): Promise<string> {
    const active = this.activeRuntime();
    const messages = active ? active.agent.getMessages() : [];
    const live = this.streamTee.liveOf(this.activeId ?? "");
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
    return renderViewHtml({
      cspSource: this.view!.webview.cspSource,
      scriptUri: viewUri.with({ query: "v=" + version }).toString(),
      editorFontSizePx: this.editorFontSizePx(),
      state: {
        sessions: this.currentFolderSessions(),
        openIds: this.registry.listOpenIds(),
        activeId: this.activeId,
        messages,
        config,
        version: (this.context?.extension as { packageJSON?: { version?: string } } | undefined)?.packageJSON?.version,
        workingIds: this.workingIds(),
        streaming: !!active?.agent.streaming,
        pending: active ? this.pendingQueue.items(active.sessionId) : [],
        liveThinking: live?.thinking ?? "",
        liveAnswer: live?.answer ?? "",
      },
    });
  }
}
