import type { HarnyConfig } from "../config/types";
import type { ToolDefinition } from "../tools/tool";
import { endpointUrl } from "./endpoint";
import type { HttpClient } from "./http-client";
import { sseLines } from "./sse";
import { toChatToolDefinitions, toOpenAIMessages } from "./message-converter";
import type { LLMMessage, LLMProvider, StreamChunk } from "./types";

/**
 * OpenAI Chat Completions provider (POST /v1/chat/completions, SSE streaming).
 */
export class OpenAIChatProvider implements LLMProvider {
  constructor(
    private config: HarnyConfig,
    private http: HttpClient,
    private toolDefinitions: ToolDefinition[],
  ) {}

  async *stream(messages: LLMMessage[], signal?: AbortSignal): AsyncGenerator<StreamChunk> {
    const url = endpointUrl(this.config.baseUrl, "/chat/completions");

    const body: Record<string, unknown> = {
      model: this.config.model,
      messages: toOpenAIMessages(messages),
      max_tokens: this.config.maxTokens,
      stream: true,
      stream_options: { include_usage: true },
    };
    // Only send temperature when explicitly configured (some opencode-go models
    // reject the parameter entirely, e.g. gpt-5.6-luna).
    if (typeof this.config.temperature === "number" && Number.isFinite(this.config.temperature)) {
      body.temperature = this.config.temperature;
    }
    // Same "only when set" rule for the two penalties — strict providers are
    // picky about extra sampling params.
    if (typeof this.config.presencePenalty === "number" && Number.isFinite(this.config.presencePenalty)) {
      body.presence_penalty = this.config.presencePenalty;
    }
    if (typeof this.config.frequencyPenalty === "number" && Number.isFinite(this.config.frequencyPenalty)) {
      body.frequency_penalty = this.config.frequencyPenalty;
    }
    // Send tool definitions ONLY when there are any: an empty `tools` array with
    // `tool_choice` is rejected by strict providers (opencode-go/Console Go).
    if (this.toolDefinitions.length > 0) {
      body.tools = toChatToolDefinitions(this.toolDefinitions);
      body.tool_choice = "auto";
    }
    // Reasoning/thinking phase, generalized across providers.
    // "bool"   → llama.cpp-style chat_template_kwargs.enable_thinking (on/off)
    //            + the STANDARD OpenAI field reasoning_effort for the level,
    //            passed inside chat_template_kwargs for the model's Jinja template.
    // "effort" → OpenAI-style top-level reasoning_effort (low/medium/high)
    // "none"   → nothing is sent (provider default behavior)
    const mode = this.config.thinkingMode ?? (this.config.enableThinking !== undefined ? "bool" : "none");
    if (mode === "bool") {
      if (this.config.thinkingLevel !== undefined) {
        // Level-based control (UI dropdown). `enable_thinking` is the llama.cpp
        // template toggle; the level uses the protocol name `reasoning_effort`
        // (low/medium/high) — templates that don't read it simply ignore it.
        const level = this.config.thinkingLevel;
        const kwargs: Record<string, unknown> = { enable_thinking: level !== "off" };
        if (level !== "off") kwargs.reasoning_effort = level;
        body.chat_template_kwargs = kwargs;
      } else if (this.config.enableThinking !== undefined) {
        // Legacy flag: pure boolean control (exactly as before).
        body.chat_template_kwargs = { enable_thinking: this.config.enableThinking };
      } else {
        body.chat_template_kwargs = { enable_thinking: true };
      }
    } else if (mode === "effort") {
      const level = this.config.thinkingLevel;
      // "off" omits the field: the model falls back to its provider default.
      if (level && level !== "off") body.reasoning_effort = level;
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.config.apiKey) {
      headers.Authorization = `Bearer ${this.config.apiKey}`;
    }

    const response = await this.http.post(url, JSON.stringify(body), headers, signal);

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`OpenAI API error ${response.status}: ${text}`);
    }

    const seenToolCallIndices = new Set<number>();

    for await (const line of sseLines(response)) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith("data: ")) continue;
      const data = trimmed.slice(6);
      if (data === "[DONE]") break;

      let parsed: any;
      try {
        parsed = JSON.parse(data);
      } catch {
        continue; // skip malformed lines
      }

      const choice = parsed.choices?.[0];

      // With stream_options.include_usage the last chunk carries usage.
      if (parsed.usage) {
        const u = parsed.usage;
        yield {
          type: "usage",
          usage: {
            // input is left EXACTLY as before (no regression): some providers
            // report cache_read_input_tokens separately, so total input is the sum.
            input: Number(u.prompt_tokens ?? 0) + Number(u.cache_read_input_tokens ?? 0),
            output: Number(u.completion_tokens ?? 0),
            total: Number(u.total_tokens ?? 0),
            // cached is informational only and never affects input/output/total.
            cached: Number(
              u.prompt_tokens_details?.cached_tokens ??
                u.prompt_cache_hit_tokens ??
                u.cache_read_input_tokens ??
                0,
            ),
          },
        };
      }
      if (!choice) continue;
      const delta = choice.delta;

      if (delta?.content) {
        yield { type: "text", content: delta.content };
      } else {
        // Reasoning models stream the thinking phase separately. Field name
        // varies by host: opencode-go/llama.cpp use `reasoning_content`,
        // OpenRouter streams `reasoning`. Read both (never both present).
        const thinking = delta?.reasoning_content ?? delta?.reasoning;
        if (thinking) yield { type: "thinking", content: thinking };
      }

      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          if (tc.function?.name) {
            seenToolCallIndices.add(idx);
            yield {
              type: "tool_call_start",
              index: idx,
              id: tc.id || `call_${idx}`,
              name: tc.function.name,
            };
          }
          if (tc.function?.arguments) {
            yield { type: "tool_call_delta", index: idx, delta: tc.function.arguments };
          }
        }
      }

      if (choice.finish_reason && (delta?.tool_calls || seenToolCallIndices.size > 0)) {
        if (choice.finish_reason === "tool_calls" || choice.finish_reason === "stop") {
          for (const idx of seenToolCallIndices) {
            yield { type: "tool_call_end", index: idx };
            seenToolCallIndices.delete(idx);
          }
        }
      }
    }

    // Emit tool_call_end for any remaining calls that were never closed.
    for (const idx of seenToolCallIndices) {
      yield { type: "tool_call_end", index: idx };
    }
  }
}
