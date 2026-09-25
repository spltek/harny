import type { ToolCall } from "../tools/tool";
import type { Usage } from "../llm/types";

export type AgentEvent =
  | { type: "text_delta"; content: string }
  | { type: "thinking_delta"; content: string }
  | { type: "tool_call"; toolCall: ToolCall }
  /** A Delegate sub-agent ACTUALLY started running (vs. merely being planned):
   * lets the UI show queued vs running and makes the concurrency cap visible. */
  | { type: "subagent_start"; toolCallId: string }
  | { type: "tool_result"; toolResult: { toolCallId: string; output: string; isError: boolean } }
  | { type: "usage"; usage: Usage }
  | { type: "done" }
  | { type: "error"; error: string }
  | { type: "raw_chunk"; chunk: string; kind: "text" | "thinking" | "tool_start" | "tool_args" | "tool_end" };
