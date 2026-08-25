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
        case "tool_result":
          // The assistant message (thinking included) is now in history.
          live.thinking = "";
          live.answer = "";
          if (active) post({ type: "toolResult", toolCallId: event.toolResult.toolCallId, output: event.toolResult.output, isError: event.toolResult.isError });
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