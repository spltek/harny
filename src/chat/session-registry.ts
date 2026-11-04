import type { ToolScope } from "../core/tools/tool-scope";
import type { ChatController } from "../core/agent/chat-controller";
import type { ChatHistory } from "../core/history/chat-history";
import { PersistentChatHistory } from "../core/history/persistent-chat-history";
import type { ThinkingLevel } from "../core/config/types";
import type { LoopGuardOptions, LoopGuardSensitivity } from "../core/agent/loop-guard";
import type { SessionStore, SessionSummary } from "../core/sessions/types";
import type { SessionConflictError } from "../core/sessions/session-conflict";
import type { SessionManager } from "../core/sessions/session-manager";
import type { ConfigProvider } from "../core/config/types";
import { SessionEngine } from "./session-engine";

/** A session that is currently open in the side view, with its own agent+history. */
export interface SessionRuntime {
  sessionId: string;
  agent: ChatController;
  /**
   * Its OWN persistent history. Typed as the concrete class, not `ChatHistory`, because the
   * transcript TOKEN (see `session-conflict.ts`) lives here: a rebuild from the panel must go
   * through `history.rebuild`, which is the only writer that can combine `replace` with the token.
   */
  history: PersistentChatHistory;
  /** The session's own engine: owns the LIVE state of the in-flight turn and the
   * projection the view is rebuilt from (see `session-engine.ts`). */
  engine: SessionEngine;
  /** Last model selected in this session (undefined = use the default). */
  model?: string;
  /** Named provider of the last selected model. */
  modelProvider?: string;
  /** Thinking level (reasoning effort) chosen in this session. */
  thinkingLevel?: ThinkingLevel;
  /** Context window (tokens) for compaction; undefined = default. */
  contextWindow?: number;
  /** Context fill % (of the window) that triggers auto-compaction; undefined = default 80. */
  compactionThresholdPercent?: number;
  /** Where the compaction LANDS, as % of the usable context; undefined = AUTO (a quarter
   * of the trigger). */
  compactionTargetPercent?: number;
  /** Max output tokens per response; undefined = default (8192). */
  outputTokens?: number;
  /** Sampling temperature; undefined = Auto (not sent). 0 is a valid value. */
  temperature?: number;
  /** Presence penalty; undefined = Auto (not sent). 0 is a valid value. */
  presencePenalty?: number;
  /** Frequency penalty; undefined = Auto (not sent). 0 is a valid value. */
  frequencyPenalty?: number;
  /** Nucleus threshold; undefined = Auto. */
  topP?: number;
  /** Active sampler: only its value is sent ("temperature" | "topP"). */
  sampler?: "temperature" | "topP";
  /** Per-session concurrent sub-agent cap (undefined = inherit; 0 = no cap). */
  maxParallelSubAgents?: number;
  /** Per-session Loop Guard sensitivity; undefined = "medium". */
  loopGuard?: LoopGuardSensitivity;
  /** Also guard the visible final answer (opt-in; undefined = off). */
  loopGuardResponse?: boolean;
  /** EPHEMERAL Loop Guard overrides from the UI's editable fields: applied to
   * the agent for this session but deliberately NOT persisted (neither on the
   * session nor in the config), so tuning is throw-away. Cleared whenever the
   * sensitivity level changes (the preset becomes the new baseline). */
  loopGuardOverrides?: Partial<LoopGuardOptions>;
  /** Chat mode chosen in this session (persisted; default "analyze"). */
  mode?: "analyze" | "agent";
  /** Per-session Parallel (sub-agents) switch (persisted; absent = OFF). */
  parallel?: boolean;
  /** Which MCP servers and built-in tools THIS session may use (persisted; absent = nothing
   *  restricted, i.e. a conversation from before per-session scopes existed). */
  toolScope?: ToolScope;
  /** Current context tokens in use (fill metric). */
  contextTokens?: number;
  /** Input tokens served from the provider's prompt cache (informational). */
  cachedTokens?: number;
  /** Tokens written into the provider's prompt cache (informational). */
  cachedWriteTokens?: number;
  /**
   * Set when the STORED session was damaged and had to be salvaged on load (see
   * `session-recovery.ts`): how many messages were left out and why. One-shot — the panel
   * reports it once and clears it, so reopening is quiet. Absent on a sound session.
   */
  recovered?: { dropped: number; reason: "unreadable" | "invalid_tail" };
}

interface SessionRegistryDeps {
  sessions: SessionManager;
  store: SessionStore;
  /** The config view of a session — DERIVED from its runtime on every read (see
   *  SessionConfigProvider). Asked at spawn time, read at every turn. */
  configFor: (sessionId: string) => ConfigProvider;
  createAgent: (history: ChatHistory, sessionId: string, config: ConfigProvider) => ChatController;
}

/**
 * Tracks open sessions, one runtime (dedicated Agent + history) per session.
 * Rendering is done by a single side-view that switches the active tab; the
 * registry only owns the per-session agents. Sessions that are not "open" are
 * still persisted on disk and can be reopened.
 */
export class SessionRegistry {
  private open = new Map<string, SessionRuntime>();
  /** The one listener for history writes (see `observeHistoryWrites`). */
  private onHistorySaved?: (summary: SessionSummary) => void;
  /** The one listener for REFUSED writes (see `observeWriteConflicts`). */
  private onHistoryConflict?: (sessionId: string, error: SessionConflictError) => void;

  constructor(private deps: SessionRegistryDeps) {}

  /**
   * Register the listener told about every HISTORY WRITE, with the summary the store just
   * produced — its `updatedAt` moved, so the session list on screen has to follow it (see
   * ChatViewProvider.noteSessionActivity).
   *
   * Why a setter and not a `deps` field: the panel is the only listener, it is built AFTER
   * the registry, and a dependency it must remember to wire is a line that can be deleted
   * in silence (an optional dep is still a valid object without it). The panel registers
   * itself in its own constructor instead, so the live dates cannot be switched off by
   * forgetting a line in the composition root.
   */
  observeHistoryWrites(fn: (summary: SessionSummary) => void): void {
    this.onHistorySaved = fn;
  }

  /**
   * The hook each history carries. It reads the listener LAZILY: a runtime can be spawned
   * before (or after) the panel registers, and every write must reach whoever is listening
   * at that moment.
   */
  private historyListener(): (summary: SessionSummary) => void {
    return (summary) => this.onHistorySaved?.(summary);
  }

  /**
   * Register the listener told when a save was REFUSED because another window changed the session
   * (see `session-conflict.ts`). Same reasoning as `observeHistoryWrites`: a setter, not a `deps`
   * field, so the panel cannot forget to wire it — an unwired listener would still be a valid
   * object and the refusal would become a silent "my messages stopped being saved".
   */
  observeWriteConflicts(fn: (sessionId: string, error: SessionConflictError) => void): void {
    this.onHistoryConflict = fn;
  }

  /** The hook each history carries, resolved lazily like `historyListener`. */
  private conflictListener(sessionId: string): (error: SessionConflictError) => void {
    return (error) => this.onHistoryConflict?.(sessionId, error);
  }

  listOpenIds(): string[] {
    return [...this.open.keys()];
  }

  /**
   * Re-apply the strip order coming from the view (a tab dragged left or right).
   *
   * The Map's INSERTION order IS the tab order (`listOpenIds` feeds the strip), so
   * reordering means rebuilding it. Defensive by design: ids that are not open are
   * ignored (a stale drag) and open sessions missing from the list are APPENDED in
   * their previous order — a partial list must never drop a runtime, which would
   * make a tab (and a possibly still working agent) vanish from the strip.
   */
  reorder(ids: string[]): void {
    const next = new Map<string, SessionRuntime>();
    for (const id of ids) {
      const rt = this.open.get(id);
      if (rt && !next.has(id)) next.set(id, rt);
    }
    for (const [id, rt] of this.open) if (!next.has(id)) next.set(id, rt);
    this.open = next;
  }

  isOpen(id: string): boolean {
    return this.open.has(id);
  }

  /** The runtime for an open session, or undefined if it is not open. */
  get(id: string): SessionRuntime | undefined {
    return this.open.get(id);
  }

  /** Load an existing session into a runtime, reusing it when already open. */
  openOrCreate(id: string): SessionRuntime {
    const existing = this.open.get(id);
    if (existing) return existing;
    const loaded = this.deps.sessions.load(id);
    // A load that had to drop a damaged tail keeps the count here: the panel shows it
    // ONCE when the session opens (`ChatViewProvider.reportRecovery`).
    const recovered = loaded.repaired;
    const history = new PersistentChatHistory(this.deps.store, id, this.historyListener(), this.conflictListener(id));
    // The token of the transcript we just read: without it the first save would run unguarded and
    // a window that loaded a stale copy would `replace` the other one's turns on its FIRST write.
    history.adopt(loaded.summary);
    history.replace(loaded.messages);
    const rt = this.spawn(id, history);
    rt.model = loaded.summary.model;
    rt.modelProvider = loaded.summary.modelProvider;
    rt.thinkingLevel = loaded.summary.thinkingLevel;
    rt.contextWindow = loaded.summary.contextWindow;
    rt.compactionThresholdPercent = loaded.summary.compactionThresholdPercent;
    rt.compactionTargetPercent = loaded.summary.compactionTargetPercent;
    rt.outputTokens = loaded.summary.outputTokens;
    rt.temperature = loaded.summary.temperature;
    rt.presencePenalty = loaded.summary.presencePenalty;
    rt.frequencyPenalty = loaded.summary.frequencyPenalty;
    rt.topP = loaded.summary.topP;
    rt.sampler = loaded.summary.sampler;
    rt.maxParallelSubAgents = loaded.summary.maxParallelSubAgents;
    rt.loopGuard = loaded.summary.loopGuard;
    rt.loopGuardResponse = loaded.summary.loopGuardResponse;
    // The editable field values are SAVED on the session; restore them so the
    // guard starts from the tuned parameters, not the bare preset.
    rt.loopGuardOverrides = loaded.summary.loopGuardParams;
    rt.contextTokens = loaded.summary.contextTokens;
    rt.mode = loaded.summary.mode;
    rt.parallel = loaded.summary.parallel;
    rt.toolScope = loaded.summary.toolScope;
    if (recovered) rt.recovered = recovered;
    // Names that no longer exist are filtered on READ too (see the host's toolScopeFor), so a
    // stale decision can never hide a new tool or resurrect a dead one.
    // Sync the fresh agent immediately (it defaults to analyze / no delegation),
    // so its state matches the restored session even before the first send.
    rt.agent.setMode(rt.mode ?? "analyze");
    rt.agent.setDelegation(rt.parallel === true);
    return rt;
  }

  /** Create a brand-new session and open its runtime. */
  create(name?: string): SessionRuntime {
    const summary = this.deps.sessions.create(name);
    const history = new PersistentChatHistory(this.deps.store, summary.id, this.historyListener());
    return this.spawn(summary.id, history);
  }

  /** Create a new session pre-seeded with a user message (context-menu commands). */
  createWithMessage(content: string, name?: string): SessionRuntime {
    const rt = this.create(name);
    rt.agent.addUserMessage(content);
    return rt;
  }

  /** Close a session's runtime (the session stays persisted on disk). */
  close(id: string): void {
    this.open.delete(id);
  }

  private spawn(id: string, history: PersistentChatHistory): SessionRuntime {
    const agent = this.deps.createAgent(history, id, this.deps.configFor(id));
    const rt: SessionRuntime = { sessionId: id, agent, history, engine: new SessionEngine(id, history, agent) };
    this.open.set(id, rt);
    return rt;
  }
}
