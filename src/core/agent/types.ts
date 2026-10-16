import type { ToolCall } from "../tools/tool";
import type { Usage } from "../llm/types";
import type { MessageAttachment, MessageMeta } from "../history/types";

/** A change the model prepared as a preview in Analyze mode: it was validated
 * (the diff computed) but NOT written to disk. Carries enough to tell the user
 * and the orchestrator exactly WHAT still needs Build. */
export interface PreparedChange {
  /** Path the change targets (as the model supplied it). */
  path: string;
  /** Tool that prepared it (Write / Edit / StrReplace / Delete). */
  tool: string;
}

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
  /** REAL per-turn metrics (usage + timings) emitted RIGHT AFTER an assistant
   * turn is committed, so the UI can show its badge as soon as the turn ends
   * (no need to wait for the end-of-run transcript refresh). */
  | { type: "turn_meta"; meta: MessageMeta }
  | { type: "done" }
  | { type: "error"; error: string }
  /** The loop guard detected a degenerate loop and REACTED (broke it and told
   * the model how to recover). Surfaced as an amber notice in the transcript. */
  | { type: "loop_intervention"; loopType: string; level: number; message: string }
  /** A HARNESS-injected corrective prompt (loop guard / delegation / budget) was
   * added to the conversation: surfaced LIVE as a light-blue "Nudge" bubble so
   * it appears immediately, not only on the end-of-run refresh. */
  | { type: "harness_nudge"; content: string }
  /** Soft-steer messages reached a turn boundary and were MERGED into a single
   * user message: `ids` are all the drafts consumed (the UI clears them), and
   * `content` is the merged text shown as one bubble.
   * `images` and `attachments` are the SAME two fields the history entry above
   * got, so the LIVE bubble is built from the same data as the one rebuilt from
   * the transcript on refresh - they can no longer diverge. */
  | {
      type: "steer_applied";
      ids: string[];
      content: string;
      images?: string[];
      attachments?: MessageAttachment[];
    }
  /** Analyze finished with prepared changes that are NOT applied: the UI
   * shows a highlighted "Switch to Build" call to action. */
  | { type: "preview_ready" }
  | { type: "raw_chunk"; chunk: string; kind: "text" | "thinking" | "tool_start" | "tool_args" | "tool_end" };
