import type { StreamChunk } from "../../src/core/llm/types";

/**
 * Stream fixtures, TYPED.
 *
 * Every test file used to build its own tool-call chunk literal. That is how a wrong shape gets
 * written (and it did: `{type: "tool_call", toolCall: {...}}` typechecked through a loose
 * fixture and failed only at runtime, in a test that was supposed to prove something else).
 * One builder, the production type, and the compiler says no before the test does.
 */

/** A complete tool call: start + a single JSON delta + end (`index` 0 by default). */
export function toolCallChunks(id: string, name: string, args: Record<string, unknown> = {}, index = 0): StreamChunk[] {
  return [
    { type: "tool_call_start", index, id, name },
    { type: "tool_call_delta", index, delta: JSON.stringify(args) },
    { type: "tool_call_end", index },
  ];
}

/** The same, when the ARGUMENTS are already JSON (testing a malformed payload, say). */
export function toolCallChunksFromJson(id: string, name: string, argsJson: string, index = 0): StreamChunk[] {
  return [
    { type: "tool_call_start", index, id, name },
    { type: "tool_call_delta", index, delta: argsJson },
    { type: "tool_call_end", index },
  ];
}

/** Visible answer text, in one chunk. */
export function textChunks(content: string): StreamChunk[] {
  return [{ type: "text", content }];
}
