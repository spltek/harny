import { describe, it, expect } from "vitest";
import { SessionLiveState, MAX_LIVE_TOOL_CALLS, MAX_LIVE_SUBAGENT_EVENTS } from "./session-live-state";

/**
 * The per-session recorder: the memory that makes an in-flight turn replayable
 * after a DOM wipe. These tests are pure (no vscode, no view): that is the
 * point of extracting it from ChatViewProvider.
 */
describe("SessionLiveState", () => {
  it("keeps text per INSTANCE (two sessions never share state)", () => {
    const a = new SessionLiveState();
    const b = new SessionLiveState();
    a.apply({ type: "thinking_delta", content: "A thinks" });
    b.apply({ type: "text_delta", content: "B answers" });

    expect(a.text()).toEqual({ thinking: "A thinks", answer: "" });
    expect(b.text()).toEqual({ thinking: "", answer: "B answers" });
  });

  it("resets the segment's TEXT on tool_result but keeps the call", () => {
    const s = new SessionLiveState();
    s.apply({ type: "thinking_delta", content: "reasoning" });
    s.apply({ type: "tool_call", toolCall: { id: "c1", name: "Read", arguments: { path: "a.ts" } } });
    // tool_call fires BEFORE the turn is committed: nothing is reset yet.
    expect(s.thinking).toBe("reasoning");

    s.apply({ type: "tool_result", toolResult: { toolCallId: "c1", output: "file body", isError: false } });
    expect(s.thinking).toBe("");
    expect(s.answer).toBe("");
    // The call survives: the history gets it only when the WHOLE batch commits.
    expect(s.projection()?.toolCalls).toEqual([
      { id: "c1", name: "Read", args: { path: "a.ts" }, done: true, isError: false, output: "file body" },
    ]);
  });

  it("tracks a sub-agent from queued/running to done, failed and aborted", () => {
    const s = new SessionLiveState();
    s.apply({ type: "tool_call", toolCall: { id: "d1", name: "Delegate", arguments: { id: "api" } } });
    // Planned but not started: no subagent_start yet.
    expect(s.projection()?.subAgents.d1).toBeUndefined();

    s.apply({ type: "subagent_start", toolCallId: "d1" });
    expect(s.projection()?.subAgents.d1.status).toBe("running");

    s.apply({ type: "subagent_event", toolCallId: "d1", event: { type: "text_delta", content: "leggo" } });
    expect(s.projection()?.subAgents.d1.events).toHaveLength(1);

    s.apply({ type: "tool_result", toolResult: { toolCallId: "d1", output: "report", isError: false } });
    expect(s.projection()?.subAgents.d1.status).toBe("done");

    // Stop-all: a queued sub-agent gets an "aborted" result.
    const s2 = new SessionLiveState();
    s2.apply({ type: "tool_call", toolCall: { id: "d2", name: "Delegate", arguments: {} } });
    s2.apply({ type: "subagent_start", toolCallId: "d2" });
    s2.apply({
      type: "tool_result",
      toolResult: { toolCallId: "d2", output: "⏹ aborted before running", isError: true },
    });
    expect(s2.projection()?.subAgents.d2.status).toBe("aborted");

    const s3 = new SessionLiveState();
    s3.apply({ type: "tool_call", toolCall: { id: "d3", name: "Delegate", arguments: {} } });
    s3.apply({ type: "tool_result", toolResult: { toolCallId: "d3", output: "boom", isError: true } });
    // A Delegate that FAILED before leaving the queue never emits
    // `subagent_start`, so it has no `subAgents` entry (that map starts at the
    // start event). Its failure lives on the tool call, which is what the view
    // replays as a "failed" sub-agent bubble.
    expect(s3.projection()!.subAgents.d3).toBeUndefined();
    expect(s3.projection()!.toolCalls[0]).toMatchObject({ done: true, isError: true, output: "boom" });
  });

  it("places the text correctly: a preamble ABOVE the Delegate bubbles, an answer BELOW", () => {
    // The exact Parallel shape: the orchestrator writes a preamble, THEN calls
    // Delegate three times, and the batch takes minutes.
    const preamble = new SessionLiveState();
    preamble.apply({ type: "text_delta", content: "Lancio tre sub-agent." });
    preamble.apply({ type: "tool_call", toolCall: { id: "d1", name: "Delegate", arguments: {} } });
    expect(preamble.projection()?.textAfterTools).toBe(false); // text came first

    const after = new SessionLiveState();
    after.apply({ type: "tool_call", toolCall: { id: "c1", name: "Read", arguments: {} } });
    after.apply({ type: "tool_result", toolResult: { toolCallId: "c1", output: "ok", isError: false } });
    after.apply({ type: "text_delta", content: "Ecco cosa ho letto." });
    expect(after.projection()?.textAfterTools).toBe(true); // text came after
  });

  it("caps the tool calls, keeping the NEWEST (the ones still on screen)", () => {
    const s = new SessionLiveState();
    for (let i = 1; i <= MAX_LIVE_TOOL_CALLS + 5; i++) {
      s.apply({ type: "tool_call", toolCall: { id: `c${i}`, name: "Read", arguments: {} } });
    }
    const calls = s.projection()!.toolCalls;
    expect(calls).toHaveLength(MAX_LIVE_TOOL_CALLS);
    expect(calls[0].id).toBe("c6");
    expect(calls[calls.length - 1].id).toBe(`c${MAX_LIVE_TOOL_CALLS + 5}`);
  });

  it("caps a sub-agent's nested log", () => {
    const s = new SessionLiveState();
    s.apply({ type: "tool_call", toolCall: { id: "d1", name: "Delegate", arguments: {} } });
    for (let i = 0; i < MAX_LIVE_SUBAGENT_EVENTS + 5; i++) {
      s.apply({ type: "subagent_event", toolCallId: "d1", event: { type: "text_delta", content: `t${i}` } });
    }
    expect(s.projection()!.subAgents.d1.events).toHaveLength(MAX_LIVE_SUBAGENT_EVENTS);
  });

  it("caps a tool output (the FULL result arrives with the history commit)", () => {
    const s = new SessionLiveState();
    s.apply({ type: "tool_call", toolCall: { id: "c1", name: "Grep", arguments: {} } });
    s.apply({ type: "tool_result", toolResult: { toolCallId: "c1", output: "x".repeat(5000), isError: false } });
    const out = s.projection()!.toolCalls[0].output ?? "";
    expect(out.length).toBeLessThan(5000);
    expect(out).toContain("(truncated)");
  });

  it("never records the same tool call twice (replayed agent events)", () => {
    const s = new SessionLiveState();
    s.apply({ type: "tool_call", toolCall: { id: "c1", name: "Read", arguments: { path: "a" } } });
    s.apply({ type: "tool_call", toolCall: { id: "c1", name: "Read", arguments: { path: "a" } } });
    expect(s.projection()!.toolCalls).toHaveLength(1);
  });

  it("wipes the whole turn on done and on error", () => {
    for (const terminal of [{ type: "done" as const }, { type: "error" as const, error: "boom" }]) {
      const s = new SessionLiveState();
      s.apply({ type: "text_delta", content: "answer" });
      s.apply({ type: "tool_call", toolCall: { id: "c1", name: "Read", arguments: {} } });
      s.apply({ type: "subagent_start", toolCallId: "c1" });
      s.apply(terminal);
      expect(s.projection()).toBeUndefined();
    }
  });

  it("keeps the tool calls across a loop nudge / steer (the run continues)", () => {
    const s = new SessionLiveState();
    s.apply({ type: "tool_call", toolCall: { id: "c1", name: "Read", arguments: {} } });
    s.apply({ type: "text_delta", content: "looping" });
    s.apply({ type: "loop_intervention", loopType: "reasoning", level: 1, message: "loop" });
    const p = s.projection()!;
    expect(p.answer).toBe(""); // the interrupted text is dropped
    expect(p.toolCalls).toHaveLength(1); // the call is still pending its commit
  });

  it("keeps an abort request on the call, so the ⏹ state survives a rebuild", () => {
    const s = new SessionLiveState();
    s.apply({ type: "tool_call", toolCall: { id: "d1", name: "Delegate", arguments: {} } });
    s.apply({ type: "subagent_start", toolCallId: "d1" });
    expect(s.projection()!.toolCalls[0].abortRequested).toBeUndefined();

    s.markAbortRequested("d1");
    expect(s.projection()!.toolCalls[0].abortRequested).toBe(true);
    // A request for a call it does not hold (already committed/cleared) is a no-op.
    s.markAbortRequested("nope");
    expect(s.projection()!.toolCalls).toHaveLength(1);
  });

  it("projection() is undefined when there is nothing to replay", () => {
    expect(new SessionLiveState().projection()).toBeUndefined();
    expect(new SessionLiveState().projection(new Set(["c1"]))).toBeUndefined();
  });

  it("projection(committed) drops what the history ALREADY has (no duplicate bubbles)", () => {
    const s = new SessionLiveState();
    s.apply({ type: "tool_call", toolCall: { id: "d1", name: "Delegate", arguments: {} } });
    s.apply({ type: "tool_call", toolCall: { id: "d2", name: "Delegate", arguments: {} } });
    s.apply({ type: "subagent_start", toolCallId: "d1" });
    s.apply({ type: "subagent_start", toolCallId: "d2" });

    const p = s.projection(new Set(["d1"]))!;
    expect(p.toolCalls.map((t) => t.id)).toEqual(["d2"]);
    expect(Object.keys(p.subAgents)).toEqual(["d2"]);
  });
});
