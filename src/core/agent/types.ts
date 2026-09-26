import type { ToolCall } from "../tools/tool";
import type { Usage } from "../llm/types";

/** Sub-agent events worth streaming live into the Delegate bubble. */
export type SubAgentEvent =
  | { type: "text_delta"; content: string }
  | { type: "thinking_delta"; content: string }
  | { type: "tool_call"; toolCall: ToolCall }
  | { type: "tool_result"; toolResult: { toolCallId: string; output: string; isError: boolean } }
  | { type: "done" }
  | { type: "error"; error: string };

export type AgentEvent =
  | { type: "text_delta"; content: string }
  | { type: "thinking_delta"; content: string }
  | { type: "tool_call"; toolCall: ToolCall }
  /** A Delegate sub-agent ACTUALLY started running (vs. merely being planned):
   * lets the UI show queued vs running and makes the concurrency cap visible. */
  | { type: "subagent_start"; toolCallId: string }
  /** A live event from inside a running sub-agent, tagged with the Delegate
   * tool-call id so the UI can nest it inside that sub-agent's bubble. */
  | { type: "subagent_event"; toolCallId: string; event: SubAgentEvent }
  | { type: "tool_result"; toolResult: { toolCallId: string; output: string; isError: boolean } }
  | { type: "usage"; usage: Usage }
  | { type: "done" }
  | { type: "error"; error: string }
  /** The loop guard detected a degenerate loop and REACTED (broke it and told
   * the model how to recover). Surfaced as an amber notice in the transcript. */
  | { type: "loop_intervention"; loopType: string; level: number; message: string }
  | { type: "raw_chunk"; chunk: string; kind: "text" | "thinking" | "tool_start" | "tool_args" | "tool_end" };
