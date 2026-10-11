import type { ChatMessage } from "./types";

export interface ChatHistory {
  all(): ChatMessage[];
  add(message: ChatMessage): void;
  /** Replace the whole history without side effects (used when loading a session). */
  replace(messages: ChatMessage[]): void;
  /** Messages that should be sent to the LLM (excludes system + uiOnly). */
  conversation(): ChatMessage[];
}
