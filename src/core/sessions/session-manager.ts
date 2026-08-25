import type { ChatMessage } from "../history/types";
import type { LoadedSession, SessionStore, SessionSummary } from "./types";

/**
 * Per-workspace session coordinator. This is a thin facade over a SessionStore
 * (CRUD + newest-first ordering). It deliberately has NO "current session":
 * each open chat panel binds its own history to a fixed session id, so the
 * SessionPanelRegistry tracks which sessions are open, not this manager.
 */
export class SessionManager {
  constructor(private store: SessionStore) {}

  /** Sessions ordered by most recently updated first. */
  list(): SessionSummary[] {
    return [...this.store.list()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  create(name?: string): SessionSummary {
    return this.store.create(name);
  }

  load(id: string): LoadedSession {
    return this.store.load(id);
  }

  rename(id: string, name: string): SessionSummary {
    return this.store.rename(id, name);
  }

  remove(id: string): boolean {
    return this.store.remove(id);
  }

  saveMessages(id: string, messages: ChatMessage[]): SessionSummary {
    return this.store.saveMessages(id, messages);
  }

  saveModel(id: string, model?: string, provider?: string): SessionSummary {
    return this.store.saveModel(id, model, provider);
  }

  saveThinkingLevel(id: string, level?: import("../config/types").ThinkingLevel): SessionSummary {
    return this.store.saveThinkingLevel(id, level);
  }

  saveContextWindow(id: string, window?: number): SessionSummary {
    return this.store.saveContextWindow(id, window);
  }

  saveOutputTokens(id: string, tokens?: number): SessionSummary {
    return this.store.saveOutputTokens(id, tokens);
  }

  saveTemperature(id: string, temp?: number): SessionSummary {
    return this.store.saveTemperature(id, temp);
  }

  saveContextTokens(id: string, tokens?: number): SessionSummary {
    return this.store.saveContextTokens(id, tokens);
  }
}
