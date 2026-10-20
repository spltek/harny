import type { ChatMessage } from "../history/types";
import type { LoopGuardOptions, LoopGuardSensitivity } from "../agent/loop-guard";

/** Lightweight metadata shown in the session picker UI. */
export interface SessionSummary {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  /**
   * Absolute path of the folder (workspace) this session points to, persisted
   * in the session file. Absent in legacy sessions; the listing layer falls
   * back to the bucket's folder when it can be inferred.
   */
  folder?: string;
  /**
   * Whether the session's folder is not available (missing path). Computed at
   * list time, NOT persisted: drives the red rows + disabled open.
   */
  folderMissing?: boolean;
  /** Last model selected in this session (persisted; undefined = default). */
  model?: string;
  /** Named provider of the last selected model (for switching back). */
  modelProvider?: string;
  /** Thinking level chosen in this session (persisted; undefined = provider default). */
  thinkingLevel?: import("../config/types").ThinkingLevel;
  /** Context window (tokens) for this session; the compaction ceiling. */
  contextWindow?: number;
  /** Context fill % (of the window) that triggers auto-compaction; undefined = default 80. */
  compactionThresholdPercent?: number;
  /** Current context tokens in use (latest input_tokens), for the fill %. */
  contextTokens?: number;
  /** Max output tokens per response for this session (persisted; undefined = default). */
  outputTokens?: number;
  /** Sampling temperature for this session (persisted; undefined = Auto, not sent). */
  temperature?: number;
  /** Presence penalty for this session (persisted; undefined = Auto, not sent). */
  presencePenalty?: number;
  /** Frequency penalty for this session (persisted; undefined = Auto, not sent). */
  frequencyPenalty?: number;
  /** Nucleus threshold for this session (persisted; undefined = Auto). */
  topP?: number;
  /** Active sampler ("temperature" | "topP"); only its value is sent. */
  sampler?: "temperature" | "topP";
  /** Per-session cap on concurrently-running sub-agents. Positive = cap; 0 =
   * explicitly NO cap; undefined = inherit the config default (then 4). */
  maxParallelSubAgents?: number;
  /** Per-session Loop Guard sensitivity; undefined = "medium". */
  loopGuard?: LoopGuardSensitivity;
  /** Also guard the visible final answer for repetition (opt-in; undefined = off). */
  loopGuardResponse?: boolean;
  /** Per-session Loop Guard PARAMETER overrides (the editable fields), saved
   * on the session. Absent keys fall back to the sensitivity preset. */
  loopGuardParams?: Partial<LoopGuardOptions>;
  /** Per-session chat mode (Analyze/Build). Persisted; absent = "analyze". */
  mode?: "analyze" | "agent";
  /** Per-session Parallel (sub-agents) switch. Persisted; absent = OFF. */
  parallel?: boolean;
}

/** A session file plus its loaded messages. */
export interface LoadedSession {
  summary: SessionSummary;
  messages: ChatMessage[];
}

/** The persistable per-session settings (patched via saveSettings). */
export type SessionSettings = Pick<
  SessionSummary,
  | "model"
  | "modelProvider"
  | "thinkingLevel"
  | "contextWindow"
  | "compactionThresholdPercent"
  | "contextTokens"
  | "outputTokens"
  | "temperature"
  | "presencePenalty"
  | "frequencyPenalty"
  | "topP"
  | "sampler"
  | "maxParallelSubAgents"
  | "loopGuard"
  | "loopGuardResponse"
  | "loopGuardParams"
  | "mode"
  | "parallel"
  | "folder"
>;

/**
 * Partial patch for session settings. A key present in the patch — even with
 * value `undefined` — SETS or CLEARS that stored field (the "Auto" semantics
 * for temperature/penalties/topP/sampler); an absent key is left untouched.
 */
export type SessionSettingsPatch = Partial<SessionSettings>;

/** Cheap DB-size stats (free vs total pages) for the vacuum UI. */
export interface DbVacuumStats {
  pageCount: number;
  freePages: number;
  pageSize: number;
  /** Reclaimable bytes (freePages × pageSize). */
  bytesFree: number;
  /** Total DB bytes (pageCount × pageSize). */
  bytesTotal: number;
  /** freePages / pageCount (0..1). */
  ratio: number;
}

/** Result of a compaction attempt (before/after for the result message). */
export interface DbVacuumResult {
  vacuumed: boolean;
  before: DbVacuumStats;
  after: DbVacuumStats;
  durationMs: number;
}

/** Empty stats (store without the optional maintenance support). */
export const EMPTY_DB_VACUUM_STATS: DbVacuumStats = {
  pageCount: 0,
  freePages: 0,
  pageSize: 0,
  bytesFree: 0,
  bytesTotal: 0,
  ratio: 0,
};

/**
 * Persistence for chat sessions. Implementations own the serialization format
 * and storage location; the SessionManager owns the "current session" state.
 *
 * Production settings writes go through the single `saveSettings(id, patch)`
 * primitive (atomic single-write).
 */
export interface SessionStore {
  list(): SessionSummary[];
  create(name?: string): SessionSummary;
  load(id: string): LoadedSession;
  /**
   * Persist the session's messages. By default this APPENDS the new tail when
   * the stored rows are still a prefix of `messages` (the common per-turn
   * case); pass `{ replace: true }` when the history was REBUILT (a ✂ cut or a
   * compaction) so the whole table is rewritten even if the length did not
   * shrink.
   */
  saveMessages(id: string, messages: ChatMessage[], options?: { replace?: boolean }): SessionSummary;
  rename(id: string, name: string): SessionSummary;
  remove(id: string): boolean;
  /** Atomically persist any subset of the per-session settings (single write). */
  saveSettings(id: string, patch: SessionSettingsPatch): SessionSummary;
  /**
   * OPTIONAL: cheap (O(1), header-only) DB-size stats for the vacuum UI.
   */
  dbVacuumStats?(): DbVacuumStats;
  /**
   * OPTIONAL best-effort maintenance: VACUUM when free pages dominate (a
   * `freeRatioThreshold` of 0 FORCES it), then truncate the WAL. Never throws.
   */
  maintain?(options?: { freeRatioThreshold?: number }): DbVacuumResult;
}
