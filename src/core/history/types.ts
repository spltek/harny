import type { ToolCall } from "../tools/tool";

export interface ChatMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  timestamp: number;
  /** Messages marked uiOnly are shown in the chat UI but excluded from LLM context. */
  uiOnly?: boolean;
  /** Reasoning/thinking text for assistant messages (shown as a collapsible block). */
  thinking?: string;
  /**
   * Structured OpenRouter reasoning blocks captured from the stream, persisted
   * and passed back verbatim on later turns (encrypted/summarized reasoning).
   */
  reasoningDetails?: unknown[];

  /** Data-URI images attached to a user message (multimodal). */
  images?: string[];
}

export type UserMessage = Omit<ChatMessage, "role" | "toolCalls" | "toolCallId" | "uiOnly"> & {
  role: "user";
};
