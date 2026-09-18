import type { LLMMessage } from "./types";
import type { ToolDefinition } from "../tools/tool";

/** Convert canonical chat messages to the OpenAI chat-completions wire format. */
export function toOpenAIMessages(messages: LLMMessage[]): Array<Record<string, unknown>> {
  return messages.map((m) => ({
    role: m.role,
    ...(m.images && m.images.length > 0
      ? {
          content: [
            { type: "text", text: m.content },
            ...m.images.map((url) => ({ type: "image_url", image_url: { url } })),
          ],
        }
      : { content: m.content }),
    // Reasoning pass-back (chat protocol):
    //  - llama.cpp / DeepSeek / opencode-go: plaintext `reasoning_content`
    //    is required on every later turn so the model keeps its reasoning.
    //  - OpenRouter: `reasoning_details` must be passed back UNMODIFIED for
    //    models that return encrypted/summarized reasoning (o-series/gpt-5,
    //    Anthropic, Gemini); `reasoning_content` (= alias of `reasoning`) only
    //    carries the plaintext summary).
    ...(m.role === "assistant" && m.reasoningDetails && m.reasoningDetails.length > 0
      ? { reasoning_details: m.reasoningDetails }
      : m.role === "assistant" && m.thinking
        ? { reasoning_content: m.thinking }
        : {}),
    // Include tool_calls ONLY when there is at least one: an empty array is
    // truthy in JS but rejected by strict servers ("Empty tool_calls is not
    // supported"), so guard with .length > 0.
    ...(m.toolCalls && m.toolCalls.length > 0
      ? {
          tool_calls: m.toolCalls.map((tc) => ({
            id: tc.id,
            type: "function",
            function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
          })),
        }
      : {}),
    ...(m.toolCallId ? { tool_call_id: m.toolCallId } : {}),
  }));
}

/** Tool definitions in the chat-completions format. */
export function toChatToolDefinitions(defs: ToolDefinition[]): unknown[] {
  return defs.map((d) => ({ type: "function", function: d }));
}

