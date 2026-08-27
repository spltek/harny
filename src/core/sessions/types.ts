import type { ChatMessage } from "../history/types";

/** Lightweight metadata shown in the session picker UI. */
export interface SessionSummary {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  /** Last model selected in this session (persisted; undefined = default). */
  model?: string;
  /** Named provider of the last selected model (for switching back). */
  modelProvider?: string;
  /** Thinking level chosen in this session (persisted; undefined = provider default). */
  thinkingLevel?: import("../config/types").ThinkingLevel;
  /** Context window (tokens) for this session; the compaction ceiling. */
  contextWindow?: number;
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
  | "contextTokens"
  | "outputTokens"
  | "temperature"
  | "presencePenalty"
  | "frequencyPenalty"
  | "topP"
  | "sampler"
>;

/**
 * Partial patch for session settings. A key present in the patch — even with
 * value `undefined` — SETS or CLEARS that stored field (the "Auto" semantics
 * for temperature/penalties/topP/sampler); an absent key is left untouched.
 */
export type SessionSettingsPatch = Partial<SessionSettings>;

/**
 * Persistence for chat sessions. Implementations own the serialization format
 * and storage location; the SessionManager owns the "current session" state.
 *
 * Production settings writes go through the single `saveSettings(id, patch)`
 * primitive (atomic single-write). The per-field save* methods below are thin
 * convenience wrappers over it, retained for the store's per-field unit tests
 * and callers that set exactly one field.
 */
export interface SessionStore {
  list(): SessionSummary[];
  create(name?: string): SessionSummary;
  load(id: string): LoadedSession;
  saveMessages(id: string, messages: ChatMessage[]): SessionSummary;
  rename(id: string, name: string): SessionSummary;
  remove(id: string): boolean;
  /** Atomically persist any subset of the per-session settings (single write). */
  saveSettings(id: string, patch: SessionSettingsPatch): SessionSummary;
  /** Persist the session's last selected model (and optional provider). */
  saveModel(id: string, model?: string, provider?: string): SessionSummary;
  /** Persist the session's thinking level (reasoning effort). */
  saveThinkingLevel(id: string, level?: import("../config/types").ThinkingLevel): SessionSummary;
  /** Persist the session's context window (tokens). */
  saveContextWindow(id: string, window?: number): SessionSummary;
  saveContextTokens(id: string, tokens?: number): SessionSummary;
  /** Persist the session's max output tokens per response. */
  saveOutputTokens(id: string, tokens?: number): SessionSummary;
  /** Persist the session's sampling temperature (undefined = Auto, not sent). */
  saveTemperature(id: string, temp?: number): SessionSummary;
  /** Persist the session's presence penalty (undefined = Auto, not sent). */
  savePresencePenalty(id: string, value?: number): SessionSummary;
  /** Persist the session's frequency penalty (undefined = Auto, not sent). */
  saveFrequencyPenalty(id: string, value?: number): SessionSummary;
  /** Persist the session's top_p threshold (undefined = Auto). */
  saveTopP(id: string, value?: number): SessionSummary;
  /** Persist the ACTIVE sampler (temperature | topP). */
  saveSampler(id: string, sampler?: "temperature" | "topP"): SessionSummary;
}
