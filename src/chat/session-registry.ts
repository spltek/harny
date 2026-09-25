import type { ChatController } from "../core/agent/chat-controller";
import type { ChatHistory } from "../core/history/chat-history";
import { PersistentChatHistory } from "../core/history/persistent-chat-history";
import type { ThinkingLevel } from "../core/config/types";
import type { SessionStore } from "../core/sessions/types";
import type { SessionManager } from "../core/sessions/session-manager";

/** A session that is currently open in the side view, with its own agent+history. */
export interface SessionRuntime {
  sessionId: string;
  agent: ChatController;
  history: ChatHistory;
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
  /** Chat mode chosen in this session (in-memory; default "analyze"). */
  mode?: "analyze" | "agent";
  /** Current context tokens in use (fill metric). */
  contextTokens?: number;
  /** Input tokens served from the provider's prompt cache (informational). */
  cachedTokens?: number;
  /** Tokens written into the provider's prompt cache (informational). */
  cachedWriteTokens?: number;
}

export interface SessionRegistryDeps {
  sessions: SessionManager;
  store: SessionStore;
  createAgent: (history: ChatHistory) => ChatController;
}

/**
 * Tracks open sessions, one runtime (dedicated Agent + history) per session.
 * Rendering is done by a single side-view that switches the active tab; the
 * registry only owns the per-session agents. Sessions that are not "open" are
 * still persisted on disk and can be reopened.
 */
export class SessionRegistry {
  private open = new Map<string, SessionRuntime>();

  constructor(private deps: SessionRegistryDeps) {}

  listOpenIds(): string[] {
    return [...this.open.keys()];
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
    const history = new PersistentChatHistory(this.deps.store, id);
    history.replace(loaded.messages);
    const rt = this.spawn(id, history);
    rt.model = loaded.summary.model;
    rt.modelProvider = loaded.summary.modelProvider;
    rt.thinkingLevel = loaded.summary.thinkingLevel;
    rt.contextWindow = loaded.summary.contextWindow;
    rt.compactionThresholdPercent = loaded.summary.compactionThresholdPercent;
    rt.outputTokens = loaded.summary.outputTokens;
    rt.temperature = loaded.summary.temperature;
    rt.presencePenalty = loaded.summary.presencePenalty;
    rt.frequencyPenalty = loaded.summary.frequencyPenalty;
    rt.topP = loaded.summary.topP;
    rt.sampler = loaded.summary.sampler;
    rt.contextTokens = loaded.summary.contextTokens;
    return rt;
  }

  /** Create a brand-new session and open its runtime. */
  create(name?: string): SessionRuntime {
    const summary = this.deps.sessions.create(name);
    const history = new PersistentChatHistory(this.deps.store, summary.id);
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

  private spawn(id: string, history: ChatHistory): SessionRuntime {
    const agent = this.deps.createAgent(history);
    const rt: SessionRuntime = { sessionId: id, agent, history };
    this.open.set(id, rt);
    return rt;
  }
}
