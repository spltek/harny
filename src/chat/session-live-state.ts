import type { AgentEvent, SubAgentEvent } from "../core/agent/types";

/** Terminal/non-terminal state of one sub-agent bubble. */
type LiveSubAgentStatus = "queued" | "running" | "done" | "failed" | "aborted";

/** One tool call of the IN-FLIGHT turn (not yet in the history). */
interface LiveToolCall {
  id: string;
  name: string;
  /** Arguments as the model sent them (re-rendered by the view's own builders). */
  args: unknown;
  /** The tool already returned: `output` is its (capped) result. */
  done: boolean;
  isError: boolean;
  /** Capped copy of the result, so a finished call in a still-running batch can
   * be replayed. The FULL output arrives in the history when the batch commits. */
  output?: string;
  /** The user pressed ⏹ on this sub-agent. Kept HERE so a rebuild does not bring
   * the button back enabled as if nothing had been asked. */
  abortRequested?: boolean;
}

/** Live nested activity of one sub-agent (Delegate bubble). */
interface LiveSubAgent {
  status: LiveSubAgentStatus;
  /** Events in arrival order, capped (see MAX_LIVE_SUBAGENT_EVENTS). */
  events: SubAgentEvent[];
}

/**
 * What the view needs to REBUILD the in-flight turn after any DOM wipe
 * (tab switch, panel reload, webview recreated). It is a PROJECTION, not a
 * log: the view is a pure renderer of `history + projection`.
 */
export interface SessionLiveProjection {
  thinking: string;
  answer: string;
  /**
   * Whether the live text was written AFTER the last tool call. The view needs
   * it to place the text bubble correctly: a preamble ("I'll launch 3
   * sub-agents") belongs ABOVE the Delegate bubbles, an answer written after a
   * tool result belongs BELOW.
   */
  textAfterTools: boolean;
  toolCalls: LiveToolCall[];
  subAgents: Record<string, LiveSubAgent>;
}

/** One line saying what a session is doing RIGHT NOW. */

/** Hard caps: with many sessions open the live state must stay bounded. */
export const MAX_LIVE_TOOL_CALLS = 40;
export const MAX_LIVE_SUBAGENT_EVENTS = 200;
export const MAX_LIVE_TOOL_OUTPUT = 2000;

/**
 * The live (uncommitted) state of ONE session's current turn.
 *
 * WHY it exists: the assistant turn — tool calls included — is written to the
 * history only when the WHOLE tool batch completes (`history.addGroup`, one
 * atomic write). A Parallel run can therefore spend minutes in a turn that the
 * history does not know about yet. Anything the view renders from `getMessages()`
 * alone is blind for that whole window; this recorder is what makes the turn
 * visible again after a rebuild.
 *
 * It OWNS no view concern and never posts anything: it only accumulates, so it
 * is pure enough to unit-test without vscode.
 */
export class SessionLiveState {
  private _thinking = "";
  private _answer = "";
  private _textAfterTools = false;
  private toolCalls: LiveToolCall[] = [];
  private subAgents = new Map<string, LiveSubAgent>();

  get thinking(): string {
    return this._thinking;
  }

  get answer(): string {
    return this._answer;
  }

  /** The live TEXT only (the shape `liveThinking`/`liveAnswer` already use). */
  text(): { thinking: string; answer: string } {
    return { thinking: this._thinking, answer: this._answer };
  }

  /**
   * Record one agent event. Called for EVERY open session, active or not: the
   * whole point is that switching away must not lose the turn.
   */
  apply(event: AgentEvent): void {
    switch (event.type) {
      case "text_delta":
        this._answer += event.content;
        this.noteTextPosition();
        break;
      case "thinking_delta":
        this._thinking += event.content;
        this.noteTextPosition();
        break;
      case "tool_call":
        this.pushToolCall({
          id: event.toolCall.id,
          name: event.toolCall.name,
          args: event.toolCall.arguments,
          done: false,
          isError: false,
        });
        break;
      case "subagent_start":
        this.subAgent(event.toolCallId).status = "running";
        break;
      case "subagent_event":
        this.subAgent(event.toolCallId).events.push(event.event);
        this.trimEvents(event.toolCallId);
        break;
      case "tool_result": {
        // The segment's text is now in the history (the turn is committed as a
        // whole only later): drop it, keep the call so it can still be replayed.
        this._thinking = "";
        this._answer = "";
        const id = event.toolResult.toolCallId;
        const tc = this.toolCalls.find((t) => t.id === id);
        if (tc) {
          tc.done = true;
          tc.isError = event.toolResult.isError;
          tc.output = cap(event.toolResult.output, MAX_LIVE_TOOL_OUTPUT);
        }
        const sa = this.subAgents.get(id);
        if (sa) {
          sa.status = !event.toolResult.isError
            ? "done"
            : /aborted|interrupted/i.test(event.toolResult.output)
              ? "aborted"
              : "failed";
        }
        break;
      }
      case "loop_intervention":
      case "harness_nudge":
      case "steer_applied":
        // The interrupted live text is dropped; the run continues, so the tool
        // calls stay (they are still pending their batch commit).
        this._thinking = "";
        this._answer = "";
        break;
      case "done":
      case "error":
        // The run is over: the history is authoritative from here on.
        this.reset();
        break;
      default:
        // usage / turn_meta / preview_ready / raw_chunk carry no live turn state.
        break;
    }
  }

  /** Full reset (new turn, abort, run over). */
  reset(): void {
    this._thinking = "";
    this._answer = "";
    this._textAfterTools = false;
    this.toolCalls = [];
    this.subAgents.clear();
  }

  /** The user stopped ONE sub-agent (⏹ on its bubble). Recorded on the call so
   * the replay can keep the button disabled and pending, exactly as the live
   * click left it. */
  markAbortRequested(toolCallId: string): void {
    const tc = this.toolCalls.find((t) => t.id === toolCallId);
    if (tc) tc.abortRequested = true;
  }

  /**
   * The replay payload, or `undefined` when there is nothing to replay.
   *
   * `committed` are the tool-call ids ALREADY in the history: the batch is
   * committed asynchronously, so the recorder can still hold calls the
   * transcript has just rendered — replaying those would duplicate bubbles.
   */
  projection(committed?: ReadonlySet<string>): SessionLiveProjection | undefined {
    const toolCalls = committed ? this.toolCalls.filter((t) => !committed.has(t.id)) : [...this.toolCalls];
    const subAgents: Record<string, LiveSubAgent> = {};
    for (const [id, sa] of this.subAgents) {
      if (committed?.has(id)) continue;
      subAgents[id] = { status: sa.status, events: [...sa.events] };
    }
    const noBubbles = toolCalls.length === 0 && Object.keys(subAgents).length === 0;
    if (noBubbles && !this._thinking && !this._answer) return undefined;
    return {
      thinking: this._thinking,
      answer: this._answer,
      textAfterTools: this._textAfterTools,
      toolCalls,
      subAgents,
    };
  }

  /** Text written once at least one tool call is known belongs BELOW it. */
  private noteTextPosition(): void {
    if (this.toolCalls.length > 0) this._textAfterTools = true;
  }

  private pushToolCall(tc: LiveToolCall): void {
    if (this.toolCalls.some((t) => t.id === tc.id)) return; // never duplicate a call
    this.toolCalls.push(tc);
    // Keep the NEWEST: those are the ones still visible under the working bar.
    if (this.toolCalls.length > MAX_LIVE_TOOL_CALLS) {
      this.toolCalls.splice(0, this.toolCalls.length - MAX_LIVE_TOOL_CALLS);
    }
  }

  private subAgent(id: string): LiveSubAgent {
    let sa = this.subAgents.get(id);
    if (!sa) {
      sa = { status: "running", events: [] };
      this.subAgents.set(id, sa);
    }
    return sa;
  }

  private trimEvents(id: string): void {
    const sa = this.subAgents.get(id);
    if (!sa || sa.events.length <= MAX_LIVE_SUBAGENT_EVENTS) return;
    sa.events.splice(0, sa.events.length - MAX_LIVE_SUBAGENT_EVENTS);
  }
}

function cap(text: string, max: number): string {
  const s = String(text ?? "");
  return s.length <= max ? s : s.slice(0, max) + "\n… (truncated)";
}
