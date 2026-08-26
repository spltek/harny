import type { ExtensionContext, WebviewView, WebviewViewProvider, WebviewViewResolveContext } from "vscode";
import { Uri } from "vscode";
import * as fs from "fs";
import type { ConfigProvider, HarnyConfig, ProviderCatalog, ThinkingLevel } from "../core/config/types";
import { isThinkingLevel } from "../core/config/types";
import type { MemoryOverrideConfigProvider } from "../core/config/memory-override-config-provider";
import { requiresApiKey } from "../core/config/requires-api-key";
import type { ModelListProvider } from "../core/llm/model-list";
import type { SessionManager } from "../core/sessions/session-manager";
import type { SessionRegistry, SessionRuntime } from "./session-registry";
import { StreamTee } from "./stream-tee";
import type { AttachmentService } from "./attachment-service";
import type { AttachmentInfo } from "./attachment-types";
import { debugLog } from "../logger";
import { renderViewHtml } from "./view-html";
import { toTemperature, toTopP } from "./temperature";
import { DEFAULT_CONTEXT_WINDOW, DEFAULT_OUTPUT_TOKENS, toContextWindow, toOutputTokens } from "./context-window";
import { PanelModalQueue } from "./panel-modal-queue";
import { Compactor, DEFAULT_COMPACTION, CompactionSettings, planCompaction, planManualCompaction, shouldCompact, estimateTokens } from "../core/sessions/compactor";

/**
 * Single side-view (webview view) hosting: a hideable sessions list, a tab bar
 * of the open sessions, and the ACTIVE chat (overlapping tabs — one chat
 * visible at a time). Messages from the webview are routed to the active
 * session's runtime; agent events of the active runtime are forwarded here.
 */
export class ChatViewProvider implements WebviewViewProvider {
  private view: WebviewView | undefined;
  private context: ExtensionContext | undefined;
  private activeId: string | undefined;
  private hostCache = new Map<string, { at: number; models: string[] }>();
  private static readonly HOST_CACHE_TTL = 30_000;
  private compacting = false;
  /** FIFO queue for in-panel modals (name dialog, alerts, confirms…). */
  private modals: PanelModalQueue;

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
      /** True when exactly one workspace folder is open (sessions are stored per-folder). */
      workspaceReady?: () => boolean;
      /** Extension data folder (home), for error hints pointing at config.json. */
      configHome?: string;
    } = {},
  ) {
    this.modals = new PanelModalQueue((msg) => this.view?.webview.postMessage(msg));
  }

  setContext(context: ExtensionContext): void {
    this.context = context;
  }

  /** Open a session as the active tab (creates a runtime if needed). */
  openSession(id: string): void {
    this.registry.openOrCreate(id);
    void this.setActive(id);
  }

  /** Create a new session asking for its name (undefined = user cancelled). */
  /** True when exactly one workspace folder is open (sessions are per-folder). */
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
    return this.sessions
      .list()
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

  /** Shared branch core: new session + slicing done by the caller. */
  private async createBranch(
    sourceId: string,
    name: string,
    messages: import("../core/history/types").ChatMessage[],
  ): Promise<void> {
    const existing = this.sessions.list().find((s) => s.id === sourceId);
    const created = this.sessions.create(name);
    if (messages.length > 0) this.sessions.saveMessages(created.id, messages);
    // Copy the per-session settings over to the branch.
    if (existing?.model) this.sessions.saveModel(created.id, existing.model, existing.modelProvider);
    if (existing?.thinkingLevel) this.sessions.saveThinkingLevel(created.id, existing.thinkingLevel);
    if (existing?.contextWindow) this.sessions.saveContextWindow(created.id, existing.contextWindow);
    if (existing?.outputTokens) this.sessions.saveOutputTokens(created.id, existing.outputTokens);
    if (existing?.temperature !== undefined) this.sessions.saveTemperature(created.id, existing.temperature);
    await this.setActive(created.id);
  }

  /**
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
    await this.postSwitchView();
  }

  async closeTab(id: string): Promise<void> {
    this.streamTee.detach(id);
    this.registry.close(id);
    if (this.activeId === id) {
      this.activeId = undefined;
      if (this.registry.listOpenIds().length > 0) {
        this.activeId = this.registry.listOpenIds()[this.registry.listOpenIds().length - 1];
      }
    }
    this.resubscribe();
    await this.postSwitchView();
  }

  /** Session ids whose agent is currently streaming (blocks delete, drives the lock). */
  private workingIds(): string[] {
    return this.registry.listOpenIds().filter((id) => this.registry.get(id)?.agent.streaming);
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
      sessions: this.sessions.list(),
      messages: active ? active.agent.getMessages() : [],
      config,
      workingIds: this.workingIds(),
      streaming: !!active?.agent.streaming,
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
  }

  /** Rebuild the whole view (host-side refresh after any change). */
  refresh(): void {
    if (!this.view) return;
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
      case "deleteSession":
        if (typeof msg.id === "string") await this.deleteSession(msg.id);
        break;
      case "modalResponse": {
        if (typeof msg.id === "number") this.onPanelModalResponse(msg.id, msg.value);
        break;
      }
      case "modalResponse": {
        if (typeof msg.id === "number") this.onPanelModalResponse(msg.id, msg.value);
        break;
      }
      case "getConfig":
        await this.pushConfig();
        break;
      case "setModel": {
        const rt = this.activeRuntime();
        if (!rt || typeof msg.model !== "string" || !msg.model.trim()) break;
        const model = msg.model.trim();
        const provider =
          typeof msg.provider === "string" && msg.provider.trim() ? msg.provider.trim() : undefined;
        rt.model = model;
        rt.modelProvider = provider;
        this.sessions.saveModel(rt.sessionId, model, provider);
        this.modelSelector.set(this.computeOverrides(model, provider));
        // Lightweight config push (no full HTML rebuild: the typed prompt,
        // scroll and streaming state are preserved).
        void this.pushConfig();
        break;
      }

      case "setThinkingLevel": {
        const rt = this.activeRuntime();
        if (!rt || !isThinkingLevel(msg.level)) break;
        rt.thinkingLevel = msg.level as ThinkingLevel;
        this.sessions.saveThinkingLevel(rt.sessionId, msg.level as ThinkingLevel);
        // Re-apply the active overrides so the runtime config carries the level.
        if (rt.model) this.modelSelector.set(this.computeOverrides(rt.model, rt.modelProvider));
        void this.pushConfig();
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
        this.compacting = true;
        // Animated in-chat bubble + working header while it runs.
        this.view?.webview.postMessage({ type: "compactStart" });
        this.view?.webview.postMessage({ type: "status", active: true, message: "Compacting…" });
        try {
          await this.performCompaction(r, "manual");
        } finally {
          this.compacting = false;
          // Finalize the bubble into a persistent "compacted" message.
          this.view?.webview.postMessage({ type: "compactDone" });
          this.view?.webview.postMessage({ type: "status", active: false });
        }
        // Update the metrics immediately via a lightweight config push (no full
        // HTML rebuild, so the user's input/scroll are preserved).
        void this.pushConfig();
        break;
      }

      case "setContextWindow": {
        const rt = this.activeRuntime();
        if (!rt) break;
        const value = toContextWindow(msg.value);
        rt.contextWindow = value;
        this.sessions.saveContextWindow(rt.sessionId, value);
        void this.pushConfig();
        break;
      }
      case "setOutputTokens": {
        const rt = this.activeRuntime();
        if (!rt) break;
        const value = toOutputTokens(msg.value);
        rt.outputTokens = value;
        this.sessions.saveOutputTokens(rt.sessionId, value);
        // Re-apply the active overrides so the runtime config carries maxTokens.
        if (rt.model) this.modelSelector.set(this.computeOverrides(rt.model, rt.modelProvider));
        void this.pushConfig();
        break;
      }
      case "setSamplerMode": {
        const rt = this.activeRuntime();
        if (!rt) break;
        const mode = msg.mode === "topP" ? "topP" : "temperature";
        rt.sampler = mode;
        this.sessions.saveSampler(rt.sessionId, mode);
        // Switching sampler ALWAYS resets the shared value to Auto (never a
        // number interpreted on the wrong scale) — clear both stored values.
        if (rt.temperature !== undefined) {
          rt.temperature = undefined;
          this.sessions.saveTemperature(rt.sessionId, undefined);
        }
        if (rt.topP !== undefined) {
          rt.topP = undefined;
          this.sessions.saveTopP(rt.sessionId, undefined);
        }
        if (rt.model) this.modelSelector.set(this.computeOverrides(rt.model, rt.modelProvider));
        void this.pushConfig();
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
          this.sessions.saveTopP(rt.sessionId, value);
        } else {
          const value = toTemperature(msg.value);
          rt.temperature = value;
          this.sessions.saveTemperature(rt.sessionId, value);
        }
        if (rt.model) this.modelSelector.set(this.computeOverrides(rt.model, rt.modelProvider));
        void this.pushConfig();
        break;
      }
      case "setPresencePenalty": {
        const rt = this.activeRuntime();
        if (!rt) break;
        const value = toTemperature(msg.value); // same 0–2, one-decimal clamp
        rt.presencePenalty = value;
        this.sessions.savePresencePenalty(rt.sessionId, value);
        if (rt.model) this.modelSelector.set(this.computeOverrides(rt.model, rt.modelProvider));
        void this.pushConfig();
        break;
      }
      case "setFrequencyPenalty": {
        const rt = this.activeRuntime();
        if (!rt) break;
        const value = toTemperature(msg.value); // same 0–2, one-decimal clamp
        rt.frequencyPenalty = value;
        this.sessions.saveFrequencyPenalty(rt.sessionId, value);
        if (rt.model) this.modelSelector.set(this.computeOverrides(rt.model, rt.modelProvider));
        void this.pushConfig();
        break;
      }
      case "send":
        if (rt) await this.send(rt, msg);
        break;
      case "abort":
        if (rt?.agent.streaming) {
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
      case "pickFiles":
        if (this.view) {
          const files = await this.attachments.pick();
          this.view.webview.postMessage({ type: "attachments", files });
        }
        break;
    }
  }

  private activeRuntime(): SessionRuntime | undefined {
    return this.activeId ? this.registry.get(this.activeId) : undefined;
  }

  private async send(rt: SessionRuntime, msg: any): Promise<void> {
    if (rt.agent.streaming) return;
    // New sessions start with no model: the user must pick one first.
    if (!rt.model) {
      this.view?.webview.postMessage({
        type: "error",
        error: "Select a model for this session first (dropdown in the header).",
      });
      return;
    }
    const rawText = msg.text as string;
    if (!rawText?.trim()) return;
    const attached = (msg.attachments as AttachmentInfo[] | undefined) ?? [];
    let text = rawText;
    let images: string[] | undefined;
    if (attached.length > 0) {
      const ctx = await this.attachments.buildContext(attached);
      text = ctx.text ? `${ctx.text}\n\n${rawText}` : rawText;
      images = ctx.images.length > 0 ? ctx.images : undefined;
    }
    if (images && images.length > 0) {
      const cfg = this.config.get();
      const modalities = (cfg.modelModalities ?? {})[cfg.model];
      if (modalities && !modalities.includes("image")) {
        this.view?.webview.postMessage({ type: "error", error: `Model \"${cfg.model}\" is text-only and does not support images.` });
        return;
      }
    }
    // Auto-compaction: free context before the request when near the limit.
    if (this.options.compactor && rt.contextWindow && rt.contextTokens !== undefined &&
        shouldCompact(rt.contextTokens, rt.contextWindow, this.options.compaction ?? DEFAULT_COMPACTION)) {
      await this.performCompaction(rt);
      if (this.activeId === rt.sessionId) {
        this.view?.webview.postMessage({ type: "refresh", messages: rt.agent.getMessages() });
      }
    }
    this.streamTee.clear(rt.sessionId);
    // send() sets _streaming synchronously on invocation: start it first, THEN
    // push the status — otherwise workingIds() is still empty and the session
    // row never locks (branch/rename/delete stay hoverable during the work).
    const sending = rt.agent.send(text, images);
    this.postStatus(true);
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
        this.postStatus(false);
        if (!hadError) this.view?.webview.postMessage({ type: "refresh", messages: rt.agent.getMessages() });
      }
    }
  }

  private postStatus(active: boolean): void {
    this.view?.webview.postMessage({ type: "status", active, workingIds: this.workingIds() });
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
        if (typeof entry.maxTokens === "number") overrides.maxTokens = entry.maxTokens;
        const ids = entry.models.map((m) => m.id);
        if (ids.length > 0) overrides.availableModels = ids;
        const modalities: Record<string, string[]> = {};
        for (const m of entry.models) if (m.input && m.input.length > 0) modalities[m.id] = m.input;
        if (Object.keys(modalities).length > 0) overrides.modelModalities = modalities;
      }
      // The per-session thinking level wins over the provider's declared default.
      overrides.thinkingLevel = rt?.thinkingLevel ?? entry?.thinkingLevel;
    } else if (rt?.thinkingLevel) {
      overrides.thinkingLevel = rt.thinkingLevel;
    }
    // The per-session output-token budget wins over the provider's default.
    if (typeof rt?.outputTokens === "number") overrides.maxTokens = rt.outputTokens;
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
    this.streamTee.detach(id);
    this.resubscribe();
    await this.postSwitchView();
  }

  private async performCompaction(rt: SessionRuntime, mode: "auto" | "manual" = "auto"): Promise<void> {
    const compactor = this.options.compactor;
    if (!compactor) return;
    const settings = this.options.compaction ?? DEFAULT_COMPACTION;
    const messages = rt.history.conversation();
    // Manual compaction always summarizes a fraction of the current context.
    const plan =
      mode === "manual"
        ? planManualCompaction(messages, this.options.manualKeepFraction ?? 0.6)
        : planCompaction(messages, settings);
    if (plan.toSummarize.length === 0) return;
    const summary = await compactor.summarize(plan.toSummarize);
    const newHistory = [
      { role: "system" as const, content: summary, timestamp: Date.now() },
      ...plan.kept,
    ];
    rt.history.replace(newHistory);
    this.sessions.saveMessages(rt.sessionId, newHistory);
    const next =
      estimateTokens(summary) +
      plan.kept.reduce((acc, m) => acc + estimateTokens(m.content), 0);
    rt.contextTokens = next;
    this.sessions.saveContextTokens(rt.sessionId, next);
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
      this.sessions.saveContextTokens(sessionId, usage.input);
      if (typeof usage.cached === "number") rt.cachedTokens = usage.cached;
      if (typeof usage.cachedWrite === "number") rt.cachedWriteTokens = usage.cachedWrite;
      void this.pushConfig();
    },
  });

  private resubscribe(): void {
    const runtimes = this.registry
      .listOpenIds()
      .map((id) => this.registry.get(id))
      .filter((rt): rt is SessionRuntime => !!rt);
    this.streamTee.attachAll(runtimes);
  }

  private async buildConfig(): Promise<{
    provider: string;
    activeProvider?: string;
    model: string;
    hasKey: boolean;
    models: string[];
    providerModels: { provider: string; model: string }[];
    modelMissing: boolean;
    hostModelsError: boolean;
    noModels: boolean;
    configHome: string;
    workspaceReady: boolean;
    thinkingMode?: "bool" | "effort" | "none";
    thinkingLevel?: "off" | "low" | "medium" | "high";
    contextWindow: number;
    outputTokens: number;
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
    const hostProviders = cfg.hostModelProviders ?? [];
    const fetched = new Map<string, string[]>();
    let hostModelsError = false;
    if (hostProviders.length > 0) {
      const results = await Promise.allSettled(hostProviders.map((name) => this.fetchHostModels(name)));
      hostProviders.forEach((name, i) => {
        const r = results[i];
        if (r.status === "fulfilled") fetched.set(name, r.value);
        else hostModelsError = true;
      });
    }

    const providerModels = [...(cfg.providerModels ?? [])];
    for (const [name, models] of fetched) {
      for (const m of models) providerModels.push({ provider: name, model: m });
    }

    let modelMissing = false;
    const rt = this.activeRuntime();
    const sessionModel = rt?.model ?? "";
    const sessionProvider = rt?.modelProvider ?? cfg.activeProvider;
    const activeName = sessionProvider;
    const activeList = [
      ...(cfg.providerModels ?? []).filter((p) => p.provider === activeName).map((p) => p.model),
      ...(activeName ? (fetched.get(activeName) ?? []) : []),
    ];
    if (sessionModel && activeList.length > 0 && !activeList.includes(sessionModel)) modelMissing = true;

    // Explicit in-panel warning: NO model at all (no config file, empty config,
    // or every host unreachable) -> the dropdown would be silently empty.
    const noModels = providerModels.length === 0 && (cfg.availableModels ?? []).length === 0;

    return {
      provider: cfg.provider,
      activeProvider: sessionProvider,
      model: sessionModel,
      hasKey: !requiresApiKey(cfg),
      workspaceReady: this.workspaceReady(),
      models: cfg.availableModels ?? [],
      providerModels,
      modelMissing,
      hostModelsError,
      noModels,
      configHome: this.options.configHome ?? "",
      thinkingMode: cfg.thinkingMode,
      thinkingLevel: cfg.thinkingLevel,
      contextWindow: this.activeRuntime()?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
      outputTokens: this.activeRuntime()?.outputTokens ?? DEFAULT_OUTPUT_TOKENS,
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

  private async fetchHostModels(name: string): Promise<string[]> {
    const entry = this.providers.getProvider(name);
    if (!entry?.baseUrl) return [];
    const key = `${name}|${entry.baseUrl}|${entry.apiKey ?? ""}`;
    const cached = this.hostCache.get(key);
    if (cached && Date.now() - cached.at < ChatViewProvider.HOST_CACHE_TTL) return cached.models;
    const models = await this.modelList.fetchModels({ baseUrl: entry.baseUrl, apiKey: entry.apiKey });
    this.hostCache.set(key, { at: Date.now(), models });
    return models;
  }

  private async pushConfig(): Promise<void> {
    const config = await this.buildConfig();
    this.view?.webview.postMessage({ type: "config", config });
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
      state: {
        sessions: this.sessions.list(),
        openIds: this.registry.listOpenIds(),
        activeId: this.activeId,
        messages,
        config,
        workingIds: this.workingIds(),
        streaming: !!active?.agent.streaming,
        liveThinking: live?.thinking ?? "",
        liveAnswer: live?.answer ?? "",
      },
    });
  }
}
