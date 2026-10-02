import type { ToolCall } from "../tools/tool";

/** Files attached to a user message (metadata only; shown in its bubble). */
export interface MessageAttachment {
  name: string;
  path: string;
  size: number;
}

export interface ChatMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  timestamp: number;
  /** Messages marked uiOnly are shown in the chat UI but excluded from LLM context. */
  uiOnly?: boolean;
  /** A HARNESS-injected prompt (loop guard / delegation / budget), NOT the user
   * typing: rendered with the Harny robot at the start. */
  harness?: boolean;
  /** Reasoning/thinking text for assistant messages (shown as a collapsible block). */
  thinking?: string;
  /**
   * Structured OpenRouter reasoning blocks captured from the stream, persisted
   * and passed back verbatim on later turns (encrypted/summarized reasoning).
   */
  reasoningDetails?: unknown[];

  /** Data-URI images attached to a user message (multimodal). */
  images?: string[];
  /**
   * Files attached to a user message. Their contents are INLINED into `content`
   * for the LLM, while these stay as metadata so the bubble can show "sent with
   * these documents" without dumping the whole file into the transcript.
   */
  attachments?: MessageAttachment[];
  /**
   * Text to SHOW in the UI when it differs from the LLM `content` (e.g. an
   * attachment-only send stores the file contents in `content`, but the bubble
   * should display the typed prompt). Falls back to `content` when absent.
   */
  displayText?: string;
}

export type UserMessage = Omit<ChatMessage, "role" | "toolCalls" | "toolCallId" | "uiOnly"> & {
  role: "user";
};
