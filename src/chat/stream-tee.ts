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
  /** Analyze prepared previews that are NOT applied (ACTIVE session only): the
   * host asks ONCE whether to switch to Build. */
  onPreviewReady?: (sessionId: string) => void;
}

/**
 * Per-session event ROUTER.
 *
 * Owns one subscription per OPEN session (not just the active tab). Two
 * distinct jobs, and the split matters:
 *
 *  · RECORD — `rt.engine.live.apply(event)` runs for EVERY session, active or
 *    not. That state belongs to the session's engine (see `session-engine.ts`),
 *    not to this router: it is the per-session memory the view is rebuilt from.
 *  · FORWARD — the view only ever sees the ACTIVE session's events.
 *
 * Why the record must not be gated on "active": the assistant turn (tool calls
 * included) reaches the history only when the WHOLE tool batch completes, in one
 * atomic `addGroup` write. A Parallel run can spend minutes in a turn the
 * history does not know yet, so a rebuild driven by `getMessages()` alone would
 * silently drop the sub-agent bubbles — which is exactly the bug the recorder
 * fixes.
 *
 * It talks to the outside only through the deps callbacks (DI-friendly,
 * testable without vscode).
 */
export class StreamTee {
  private subs = new Map<string, () => void>();

  constructor(private deps: StreamTeeDeps) {}

  /** Subscribe a session's agent; idempotent per session. */
  attach(rt: SessionRuntime): void {
    if (this.subs.has(rt.sessionId)) return;
    const unsub = rt.agent.onEvent((event: AgentEvent) => {
      // RECORD FIRST, always: this is the per-session memory of the turn.
      rt.engine.live.apply(event);

      // …then forward the event to the view, but only for the session on screen.
      const active = this.deps.isActive(rt.sessionId);
      // Every message carries its session: the view drops the ones addressed to a
      // tab it has already left (the switch is async, so a delta of the NEW
      // session can arrive while the OLD one is still on screen).
      const post = (m: object) => this.deps.onPost({ ...m, sessionId: rt.sessionId });
      switch (event.type) {
        case "text_delta":
          if (active) post({ type: "textDelta", content: event.content });
          break;
        case "thinking_delta":
          if (active) post({ type: "thinkingDelta", content: event.content });
          break;
        case "tool_call":
          // NOTE: this event fires BEFORE the assistant turn is committed; the
          // recorder keeps the call until the batch commits (dedupe by id).
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
          if (active) post({ type: "toolResult", toolCallId: event.toolResult.toolCallId, output: event.toolResult.output, isError: event.toolResult.isError });
          break;
        case "preview_ready":
          // Analyze prepared changes that are NOT applied: a static note in the
          // transcript, plus a ONE-SHOT host prompt to switch to Build.
          if (active) {
            post({ type: "previewReady" });
            this.deps.onPreviewReady?.(rt.sessionId);
          }
          break;
        case "loop_intervention":
          // A degenerate loop was broken and the run continues.
          if (active)
            post({ type: "loopIntervention", loopType: event.loopType, level: event.level, message: event.message });
          break;
        case "harness_nudge":
          // A corrective HARNESS prompt: surface it LIVE (light-blue bubble).
          if (active) post({ type: "harnessNudge", content: event.content });
          break;
        case "steer_applied":
          // Soft-steer messages reached a boundary and were MERGED into one
          // user turn: the host removes every consumed draft (EVERY session),
          // the view shows a single steer bubble (active only).
          this.deps.onSteerApplied(rt.sessionId, event.ids);
          if (active)
            post({
              type: "steerApplied",
              ids: event.ids,
              content: event.content,
              ...(event.images?.length ? { images: event.images } : {}),
              ...(event.attachments?.length ? { attachments: event.attachments } : {}),
            });
          break;
        case "done":
          if (active) post({ type: "done" });
          break;
        case "error":
          if (active) post({ type: "error", error: event.error });
          break;
        case "usage":
          this.deps.onUsage(rt.sessionId, event.usage);
          break;
        case "turn_meta":
          // The turn is committed: show its REAL metrics badge right away.
          if (active) post({ type: "turnMeta", meta: event.meta });
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

  /** Unsubscribe a session (close/delete). Its live state belongs to the engine,
   * which dies with the runtime. */
  detach(id: string): void {
    const unsub = this.subs.get(id);
    if (unsub) {
      unsub();
      this.subs.delete(id);
    }
  }
}
