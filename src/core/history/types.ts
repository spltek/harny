import type { ToolCall } from "../tools/tool";

/**
 * Per-turn metrics captured from the provider stream: the REAL token usage of
 * the turn plus its wall-clock timings. Persisted WITH the message (the JSON
 * `data` column), so the UI can show a badge and the host can reuse real
 * counts instead of only estimating.
 */
export interface MessageMeta {
  /** Input tokens of the WHOLE prompt for this turn (provider-reported). */
  inputTokens?: number;
  /** Tokens generated in this turn (provider-reported). */
  outputTokens?: number;
  /** Total tokens for this turn (provider-reported). */
  totalTokens?: number;
  /** Input tokens served from the provider's prompt cache. */
  cachedTokens?: number;
  /** Tokens written INTO the provider's prompt cache. */
  cachedWriteTokens?: number;
  /** Wall-clock epoch (ms) when the turn started. */
  startedAt?: number;
  /** Wall-clock epoch (ms) of the FIRST streamed token. */
  firstTokenAt?: number;
  /** Wall-clock epoch (ms) when the turn finished. */
  endedAt?: number;
  /** Time to first token (ms). */
  ttftMs?: number;
  /** Total turn duration (ms). */
  durationMs?: number;
}

/** Files attached to a user message (metadata only; shown in its bubble). */
export interface MessageAttachment {
  name: string;
  path: string;
  size: number;
  /** True for image attachments (rendered large in the bubble). The data URI
   * lives in the message's `images` field (persisted), so it is not duplicated. */
  isImage?: boolean;
}

export interface ChatMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  timestamp: number;
  /** Messages marked uiOnly are shown in the chat UI but excluded from LLM context. */
  uiOnly?: boolean;
  /** True for the SYNTHETIC prompt/response pair that replaces a compacted span:
   * rendered as an orange bubble + an assistant reply, but NOT a real user turn
   * (so it gets no ✂ cut / ⎇ branch key). */
  synthetic?: boolean;
  /** Analyze prepared changes (previews) that are NOT applied: the UI shows the
   * highlighted "Switch to Build" call to action. Driven by the real condition
   * (a preview was prepared), not by a marker in the text. */
  previewPrepared?: boolean;
  /** A HARNESS-injected prompt (loop guard / delegation / budget), NOT the user
   * typing: rendered with the Harny robot at the start. */
  harness?: boolean;
  /** A user message injected MID-RUN via soft steering (not a new run): the
   * UI marks it so a mid-flight correction is recognizable in the transcript. */
  steer?: boolean;
  /** Reasoning/thinking text for assistant messages (shown as a collapsible block). */
  thinking?: string;
  /**
   * Per-turn metrics (real token usage + timings) for assistant messages. Shown
   * as a compact badge under the bubble and reused for context accounting.
   */
  meta?: MessageMeta;
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
