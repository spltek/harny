import { describe, it, expect, vi } from "vitest";
import { StreamTee } from "./stream-tee";
import type { SessionRuntime } from "./session-registry";
import type { AgentEvent } from "../core/agent/types";

function fakeRuntime(id: string): { rt: SessionRuntime; emit: (e: AgentEvent) => void } {
  const handlers: ((e: AgentEvent) => void)[] = [];
  const agent = {
    onEvent: (fn: (e: AgentEvent) => void) => {
      handlers.push(fn);
      return () => {
        const i = handlers.indexOf(fn);
        if (i >= 0) handlers.splice(i, 1);
      };
    },
  };
  const rt = { sessionId: id, agent, history: {} } as unknown as SessionRuntime;
  return { rt, emit: (e: AgentEvent) => handlers.forEach((fn) => fn(e)) };
}

function makeTee() {
  const deps = {
    isActive: vi.fn(() => true),
    onPost: vi.fn(),
    onUsage: vi.fn(),
    onSteerApplied: vi.fn(),
  };
  const tee = new StreamTee(deps);
  return { tee, deps };
}

describe("StreamTee", () => {
  it("forwards only the active session but buffers every session", () => {
    const active: string[] = ["a"];
    const { tee, deps } = makeTee();
    deps.isActive.mockImplementation((id: string) => id === active[0]);
    const a = fakeRuntime("a");
    const b = fakeRuntime("b");
    tee.attachAll([a.rt, b.rt]);

    a.emit({ type: "thinking_delta", content: "A think" });
    b.emit({ type: "thinking_delta", content: "B think" });
    b.emit({ type: "text_delta", content: "B answer" });

    // Only the active session's events were posted…
    expect(deps.onPost).toHaveBeenCalledTimes(1);
    expect(deps.onPost).toHaveBeenCalledWith({ type: "thinkingDelta", content: "A think" });
    // …but both buffers accumulated independently.
    expect(tee.liveOf("a")?.thinking).toBe("A think");
    expect(tee.liveOf("b")?.thinking).toBe("B think");
    expect(tee.liveOf("b")?.answer).toBe("B answer");
    expect(tee.liveOf("a")?.answer).toBe("");
  });

  it("resets the buffer only when the turn commits (not on tool_call, which fires pre-commit)", () => {
    const { tee } = makeTee();
    const a = fakeRuntime("a");
    tee.attach(a.rt);

    a.emit({ type: "thinking_delta", content: "reasoning" });
    a.emit({ type: "tool_call", toolCall: { id: "c1", name: "Read", arguments: {} } });
    expect(tee.liveOf("a")?.thinking).toBe("reasoning"); // NOT reset yet

    a.emit({ type: "tool_result", toolResult: { toolCallId: "c1", output: "ok", isError: false } });
    expect(tee.liveOf("a")?.thinking).toBe("");
    expect(tee.liveOf("a")?.answer).toBe("");
  });

  it("routes steer_applied to the host and the view (active only for the view)", () => {
    const active: string[] = ["a"];
    const { tee, deps } = makeTee();
    deps.isActive.mockImplementation((id: string) => id === active[0]);
    const a = fakeRuntime("a");
    const b = fakeRuntime("b");
    tee.attachAll([a.rt, b.rt]);

    a.emit({ type: "steer_applied", ids: ["s1"], content: "use Rome" });
    b.emit({ type: "steer_applied", ids: ["s2"], content: "other" });

    // The host drops BOTH from their pending lists…
    expect(deps.onSteerApplied).toHaveBeenCalledWith("a", ["s1"]);
    expect(deps.onSteerApplied).toHaveBeenCalledWith("b", ["s2"]);
    // …but only the active session's bubble is posted to the view.
    expect(deps.onPost).toHaveBeenCalledWith({ type: "steerApplied", ids: ["s1"], content: "use Rome" });
    expect(deps.onPost).not.toHaveBeenCalledWith(expect.objectContaining({ ids: ["s2"] }));
  });

  it("forwards loop_intervention to the view and resets the live buffer", () => {
    const { tee, deps } = makeTee();
    const a = fakeRuntime("a");
    tee.attach(a.rt);

    a.emit({ type: "thinking_delta", content: "looping reasoning" });
    a.emit({ type: "loop_intervention", loopType: "reasoning", level: 1, message: "reasoning loop detected" });

    expect(deps.onPost).toHaveBeenCalledWith({
      type: "loopIntervention",
      loopType: "reasoning",
      level: 1,
      message: "reasoning loop detected",
    });
    expect(tee.liveOf("a")?.thinking).toBe("");
  });

  it("forwards harness_nudge to the view and resets the live buffer", () => {
    const { tee, deps } = makeTee();
    const a = fakeRuntime("a");
    tee.attach(a.rt);

    a.emit({ type: "thinking_delta", content: "thinking" });
    a.emit({ type: "text_delta", content: "answer" });
    a.emit({ type: "harness_nudge", content: "**Stop** repeating." });

    expect(deps.onPost).toHaveBeenCalledWith({ type: "harnessNudge", content: "**Stop** repeating." });
    expect(tee.liveOf("a")?.thinking).toBe("");
    expect(tee.liveOf("a")?.answer).toBe("");
  });

  it("forwards preview_ready to the view when the session is active", () => {
    const { tee, deps } = makeTee();
    const a = fakeRuntime("a");
    tee.attach(a.rt);
    a.emit({ type: "preview_ready" });
    expect(deps.onPost).toHaveBeenCalledWith({ type: "previewReady" });
  });

  it("forwards subagent_start to the view when the session is active", () => {
    const { tee, deps } = makeTee();
    const a = fakeRuntime("a");
    tee.attach(a.rt);
    a.emit({ type: "subagent_start", toolCallId: "d1" });
    expect(deps.onPost).toHaveBeenCalledWith({ type: "subagentStart", toolCallId: "d1" });
  });

  it("forwards subagent_event (nested streaming) to the view when active", () => {
    const { tee, deps } = makeTee();
    const a = fakeRuntime("a");
    tee.attach(a.rt);
    a.emit({ type: "subagent_event", toolCallId: "d1", event: { type: "text_delta", content: "x" } });
    expect(deps.onPost).toHaveBeenCalledWith({
      type: "subagentEvent",
      toolCallId: "d1",
      event: { type: "text_delta", content: "x" },
    });
  });

  it("clears on done and on error", () => {
    const { tee } = makeTee();
    const a = fakeRuntime("a");
    tee.attach(a.rt);
    a.emit({ type: "thinking_delta", content: "x" });
    a.emit({ type: "done" });
    expect(tee.liveOf("a")?.thinking).toBe("");

    a.emit({ type: "thinking_delta", content: "y" });
    a.emit({ type: "error", error: "boom" });
    expect(tee.liveOf("a")?.thinking).toBe("");
  });

  it("routes usage to the onUsage callback", () => {
    const { tee, deps } = makeTee();
    const a = fakeRuntime("a");
    tee.attach(a.rt);
    a.emit({ type: "usage", usage: { input: 10, output: 2, total: 12 } });
    expect(deps.onUsage).toHaveBeenCalledWith("a", { input: 10, output: 2, total: 12 });
  });

  it("detach stops forwarding and removes the buffer", () => {
    const { tee, deps } = makeTee();
    const a = fakeRuntime("a");
    tee.attach(a.rt);
    a.emit({ type: "thinking_delta", content: "x" });

    tee.detach("a");
    a.emit({ type: "thinking_delta", content: "y" });

    expect(tee.liveOf("a")).toBeUndefined();
    deps.onPost.mockClear();
    a.emit({ type: "done" });
    expect(deps.onPost).not.toHaveBeenCalled();
  });

  it("clear resets the buffered text (start of a new turn / abort)", () => {
    const { tee } = makeTee();
    const a = fakeRuntime("a");
    tee.attach(a.rt);
    a.emit({ type: "thinking_delta", content: "x" });

    tee.clear("a");
    expect(tee.liveOf("a")?.thinking).toBe("");
    expect(tee.liveOf("a")?.answer).toBe("");
  });
});
describe("StreamTee — turn_meta", () => {
  it("forwards turn_meta to the ACTIVE session only", () => {
    const active: string[] = ["a"];
    const { tee, deps } = makeTee();
    deps.isActive.mockImplementation((id: string) => id === active[0]);
    const a = fakeRuntime("a");
    const b = fakeRuntime("b");
    tee.attachAll([a.rt, b.rt]);

    a.emit({ type: "turn_meta", meta: { inputTokens: 123, durationMs: 5 } });
    b.emit({ type: "turn_meta", meta: { inputTokens: 456 } });

    expect(deps.onPost).toHaveBeenCalledTimes(1);
    expect(deps.onPost).toHaveBeenCalledWith({ type: "turnMeta", meta: { inputTokens: 123, durationMs: 5 } });
  });
});
