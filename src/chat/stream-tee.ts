import type { AgentEvent } from "../core/agent/types";
import type { Usage } from "../core/llm/types";
import type { SessionRuntime } from "./session-registry";

export interface StreamTeeDeps {
  /** Whether the session is the one whose events reach the view. */
  isActive: (sessionId: string) => boolean;
  /** Forward a message to the webview (called only for the active session). */
  onPost: (message: unknown) => void;
  /** Token usage reported by a session (handled provider-side: metrics, store). */
  onUsage: (sessionId: string, usage: Usage) => void;
  /** Soft-steer messages were applied (merged) at a turn boundary: the host
   * drops them all from the session's pending list. Called for EVERY session. */
  onSteerApplied: (sessionId: string, ids: string[]) => void;
}

/**
 * Per-session streaming router + live buffers.
 *
 * Owns one subscription per OPEN session (not just the active tab): events are
 * forwarded to the view only for the ACTIVE session, but the live (uncommitted)
 * thinking/answer of EVERY running session is accumulated, so switching back to
 * a session that is still working can replay its progress — the text lives here
 * in the host, not in the discarded page DOM.
 *
 * Extraction point: this used to live inside ChatViewProvider (SRP). It only
 * talks to the outside through the deps callbacks (DI-friendly, testable).
 */
export class StreamTee {
  private subs = new Map<string, () => void>();
  private live = new Map<string, { thinking: string; answer: string }>();

  constructor(private deps: StreamTeeDeps) {}

  /** Subscribe a session's agent; idempotent per session. */
  attach(rt: SessionRuntime): void {
    if (this.subs.has(rt.sessionId)) return;
    const live = { thinking: "", answer: "" };
    this.live.set(rt.sessionId, live);
    const unsub = rt.agent.onEvent((event: AgentEvent) => {
      const active = this.deps.isActive(rt.sessionId);
      const post = (m: unknown) => this.deps.onPost(m);
      switch (event.type) {
        case "text_delta":
          live.answer += event.content;
          if (active) post({ type: "textDelta", content: event.content });
          break;
        case "thinking_delta":
          live.thinking += event.content;
          if (active) post({ type: "thinkingDelta", content: event.content });
          break;
        case "tool_call":
          // NOTE: this event fires BEFORE the assistant turn is committed, so
          // the buffer is reset only later (on tool_result / done / error).
          if (active) post({ type: "toolCall", id: event.toolCall.id, name: event.toolCall.name, arguments: event.toolCall.arguments });
          break;
        case "subagent_start":
          // The delegate actually left the queue and started running.
          if (active) post({ type: "subagentStart", toolCallId: event.toolCallId });
          break;
        case "subagent_event":
          // Live nested activity of a running sub-agent.
          if (active) post({ type: "subagentEvent", toolCallId: event.toolCallId, event: event.event });
          break;
        case "tool_result":
          // The assistant message (thinking included) is now in history.
          live.thinking = "";
          live.answer = "";
          if (active) post({ type: "toolResult", toolCallId: event.toolResult.toolCallId, output: event.toolResult.output, isError: event.toolResult.isError });
          break;
        case "preview_ready":
          // Analyze prepared changes that are NOT applied: surface the CTA.
          if (active) post({ type: "previewReady" });
          break;
        case "loop_intervention":
          // A degenerate loop was broken and the run continues: drop the
          // interrupted live text so the next turn starts fresh.
          live.thinking = "";
          live.answer = "";
          if (active)
            post({ type: "loopIntervention", loopType: event.loopType, level: event.level, message: event.message });
          break;
        case "harness_nudge":
          // A corrective HARNESS prompt: surface it LIVE (light-blue bubble).
          live.thinking = "";
          live.answer = "";
          if (active) post({ type: "harnessNudge", content: event.content });
          break;
        case "steer_applied":
          // Soft-steer messages reached a boundary and were MERGED into one
          // user turn: the host removes every consumed draft; the UI shows a
          // single steer bubble.
          live.thinking = "";
          live.answer = "";
          this.deps.onSteerApplied(rt.sessionId, event.ids);
          if (active) post({ type: "steerApplied", ids: event.ids, content: event.content });
          break;
        case "done":
          live.thinking = "";
          live.answer = "";
          if (active) post({ type: "done" });
          break;
        case "error":
          live.thinking = "";
          live.answer = "";
          if (active) post({ type: "error", error: event.error });
          break;
        case "usage":
          this.deps.onUsage(rt.sessionId, event.usage);
          break;
        case "raw_chunk":
          break; // informational (stream log); not routed to the view
      }
    });
    this.subs.set(rt.sessionId, unsub);
  }

  attachAll(runtimes: SessionRuntime[]): void {
    for (const rt of runtimes) this.attach(rt);
  }

  /** Unsubscribe a session and drop its live buffer (close/delete). */
  detach(id: string): void {
    const unsub = this.subs.get(id);
    if (unsub) {
      unsub();
      this.subs.delete(id);
    }
    this.live.delete(id);
  }

  /** Live (uncommitted) text of a session's in-flight turn. */
  liveOf(id: string): { thinking: string; answer: string } | undefined {
    return this.live.get(id);
  }

  /** Reset a session's buffered text (a new turn starts / abort). */
  clear(id: string): void {
    const l = this.live.get(id);
    if (l) {
      l.thinking = "";
      l.answer = "";
    }
  }
}