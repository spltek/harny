import type { ChatMessage } from "../history/types";
import type { AgentEvent } from "./types";

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
  send(text: string, images?: string[]): Promise<void>;
  abort(): void;
  onEvent(handler: (event: AgentEvent) => void): () => void;
  /** Queue a user message without starting the agent loop (used by context-menu commands). */
  addUserMessage(content: string): void;
}
