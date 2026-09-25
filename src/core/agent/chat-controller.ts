import type { ChatMessage, MessageAttachment } from "../history/types";
import type { AgentEvent } from "./types";
import type { ChatMode } from "../tools/mode-policy";

/** Optional payload for {@link ChatController.send}. */
export interface SendOptions {
  /** Data-URI images (multimodal content). */
  images?: string[];
  /** Attached-file metadata, echoed in the user bubble. */
  attachments?: MessageAttachment[];
  /** Text to show in the UI when the LLM `content` differs (file contents inlined). */
  displayText?: string;
}

/**
 * The contract the chat UI needs from the agent. Keeps the webview layer
 * decoupled from the concrete Agent implementation (Dependency Inversion).
 */
export interface ChatController {
  readonly streaming: boolean;
  getMessages(): ChatMessage[];
  reset(): void;
  /** Replace the whole conversation with a loaded session (no autosave). */
  load(messages: ChatMessage[]): void;
  send(text: string, options?: SendOptions): Promise<void>;
  abort(): void;
  onEvent(handler: (event: AgentEvent) => void): () => void;
  /** Queue a user message without starting the agent loop (used by context-menu commands). */
  addUserMessage(content: string): void;
  /**
   * Set the chat mode: "analyze" (read-only — no file modification, Shell
   * guarded) or "agent" (full tool access). Defaults to analyze.
   */
  setMode(mode: ChatMode): void;
  /**
   * Enable/disable orchestration (sub-agents) for this session — the UI
   * "multi" toggle. When off, the Delegate tool is hidden and refused.
   */
  setDelegation(enabled: boolean): void;
}
