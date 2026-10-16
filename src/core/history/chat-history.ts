import type { ChatMessage } from "./types";

export interface ChatHistory {
  all(): ChatMessage[];
  add(message: ChatMessage): void;
  /**
   * Append SEVERAL messages as ONE unit (one store write, one transaction).
   *
   * The reason it exists: a tool turn is `assistant(toolCalls)` + one `tool` per
   * call, and the providers require the results to follow the call IMMEDIATELY.
   * Written one `add` at a time, another writer (the host persisting an
   * interruption, an error path) can slip a message BETWEEN them, which makes the
   * whole history unreplayable: every later request is rejected with a 400 and
   * the session is wedged for good. Written as a group, the two are inseparable by
   * construction — nothing can be interleaved where a single call is in progress.
   */
  addGroup(messages: ChatMessage[]): void;
  /** Replace the whole history without side effects (used when loading a session). */
  replace(messages: ChatMessage[]): void;
  /** Messages that should be sent to the LLM (excludes system + uiOnly). */
  conversation(): ChatMessage[];
}
