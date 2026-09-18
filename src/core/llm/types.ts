import type { ToolCall } from "../tools/tool";

export interface LLMMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  /** Data-URI images for multimodal user messages. */
  images?: string[];
  /** Reasoning/thinking text (must be passed back for reasoning models). */
  thinking?: string;
  /**
   * OpenRouter-style structured reasoning blocks (reasoning_details). Captured
   * verbatim from the stream and passed back UNMODIFIED on the next turn: for
   * encrypted/summarized reasoning models (OpenAI o-series/gpt-5, Anthropic,
   * Gemini) the plaintext `thinking` is not enough to continue the reasoning
   * across tool calls, while the full details block is.
   */
  reasoningDetails?: unknown[];
}

/** Token usage reported by a model call (provider-specific). */
export interface Usage {
  input: number;
  output: number;
  total: number;
  /** Input tokens served from the provider's prompt cache (0 = cache cold/unreported). */
  cached?: number;
  /** Tokens written INTO the prompt cache (OpenRouter cache_write_tokens, llama.cpp/vLLM cache_creation_input_tokens). */
  cachedWrite?: number;
}

export type StreamChunk =
  | { type: "text"; content: string }
  | { type: "thinking"; content: string }
  /** Accumulated, pass-back-ready reasoning_details blocks (OpenRouter). */
  | { type: "thinking_details"; details: unknown[] }
  | { type: "tool_call_start"; index: number; id?: string; name?: string }
  | { type: "tool_call_delta"; index: number; delta: string }
  | { type: "tool_call_end"; index: number; id?: string; name?: string }
  | { type: "usage"; usage: Usage };

export interface LLMProvider {
  stream(messages: LLMMessage[], signal?: AbortSignal): AsyncGenerator<StreamChunk>;
}

export interface LLMProviderFactory {
  create(config: import("../config/types").HarnyConfig): LLMProvider;
}
