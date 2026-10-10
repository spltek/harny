import type { ChatMessage } from "../history/types";
import type { DbVacuumResult, DbVacuumStats, LoadedSession, SessionSettingsPatch, SessionStore, SessionSummary } from "./types";
import { EMPTY_DB_VACUUM_STATS } from "./types";

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

  /**
   * Atomically persist any subset of the per-session settings in a SINGLE
   * store write. The webview uses this for every setting change (model,
   * thinking level, sampling, limits…) — adding a future setting only needs
   * a field in the patch type, never a new method here or in the store.
   */
  saveSettings(id: string, patch: SessionSettingsPatch): SessionSummary {
    return this.store.saveSettings(id, patch);
  }

  /**
   * Best-effort DB compaction. A `freeRatioThreshold` of 0 FORCES it. The
   * store may not support it (optional method) — then it is a no-op.
   */
  maintain(options?: { freeRatioThreshold?: number }): DbVacuumResult {
    return (
      this.store.maintain?.(options) ?? {
        vacuumed: false,
        before: EMPTY_DB_VACUUM_STATS,
        after: EMPTY_DB_VACUUM_STATS,
        durationMs: 0,
      }
    );
  }

  /** Cheap DB-size stats for the vacuum UI (empty when unsupported). */
  dbVacuumStats(): DbVacuumStats {
    return this.store.dbVacuumStats?.() ?? EMPTY_DB_VACUUM_STATS;
  }
}
