import { describe, it, expect, vi } from "vitest";
import { StreamTee } from "./stream-tee";
import { SessionEngine } from "./session-engine";
import type { SessionRuntime } from "./session-registry";
import type { ChatController } from "../core/agent/chat-controller";
import type { AgentEvent } from "../core/agent/types";
import type { ChatHistory } from "../core/history/chat-history";

/** A runtime carrying its OWN engine: the recorder is what the tests assert on,
 * exactly what the view is rebuilt from. */
function fakeRuntime(id: string): { rt: SessionRuntime; emit: (e: AgentEvent) => void; engine: SessionEngine } {
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
  const history = { all: () => [] } as unknown as ChatHistory;
  const engine = new SessionEngine(id, history, agent as unknown as ChatController);
  const rt = { sessionId: id, agent, history, engine } as unknown as SessionRuntime;
  return { rt, emit: (e: AgentEvent) => handlers.forEach((fn) => fn(e)), engine };
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
    expect(deps.onPost).toHaveBeenCalledWith({ type: "thinkingDelta", content: "A think", sessionId: "a" });
    // …but both buffers accumulated independently.
    expect(a.engine.live.text()).toEqual({ thinking: "A think", answer: "" });
    expect(b.engine.live.text()).toEqual({ thinking: "B think", answer: "B answer" });
  });

  it("records the WHOLE in-flight turn of an INACTIVE session (tool calls + sub-agents)", () => {
    // THE BUG THIS FIXES: the assistant turn reaches the history only when the
    // whole tool batch commits, so a session that is not the active tab used to
    // lose its sub-agent bubbles entirely until you pressed Stop.
    const { tee, deps } = makeTee();
    deps.isActive.mockImplementation((id: string) => id === "b");
    const a = fakeRuntime("a");
    const b = fakeRuntime("b");
    tee.attachAll([a.rt, b.rt]);

    a.emit({ type: "text_delta", content: "Lancio i sub-agent." });
    a.emit({
      type: "tool_call",
      toolCall: { id: "d1", name: "Delegate", arguments: { id: "api", goal: "leggi le API" } },
    });
    a.emit({ type: "subagent_start", toolCallId: "d1" });
    a.emit({ type: "subagent_event", toolCallId: "d1", event: { type: "text_delta", content: "sto leggendo" } });

    expect(deps.onPost).not.toHaveBeenCalled(); // nothing reaches the view…
    const live = a.engine.live.projection()!; // …but everything is replayable
    expect(live.answer).toBe("Lancio i sub-agent.");
    expect(live.textAfterTools).toBe(false); // the preamble stays ABOVE the bubbles
    expect(live.toolCalls).toEqual([
      { id: "d1", name: "Delegate", args: { id: "api", goal: "leggi le API" }, done: false, isError: false },
    ]);
    expect(live.subAgents.d1.status).toBe("running");
    expect(live.subAgents.d1.events).toHaveLength(1);
  });

  it("resets the buffer only when the turn commits (not on tool_call, which fires pre-commit)", () => {
    const { tee } = makeTee();
    const a = fakeRuntime("a");
    tee.attach(a.rt);

    a.emit({ type: "thinking_delta", content: "reasoning" });
    a.emit({ type: "tool_call", toolCall: { id: "c1", name: "Read", arguments: {} } });
    expect(a.engine.live.thinking).toBe("reasoning"); // NOT reset yet

    a.emit({ type: "tool_result", toolResult: { toolCallId: "c1", output: "ok", isError: false } });
    expect(a.engine.live.thinking).toBe("");
    expect(a.engine.live.answer).toBe("");
    // The call itself stays until the batch commits (dedupe happens there).
    expect(a.engine.live.projection()?.toolCalls).toHaveLength(1);
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
    expect(deps.onPost).toHaveBeenCalledWith({
      type: "steerApplied",
      ids: ["s1"],
      content: "use Rome",
      sessionId: "a",
    });
    expect(deps.onPost).not.toHaveBeenCalledWith(expect.objectContaining({ ids: ["s2"] }));
  });

  it("forwards a steer's attachments to the view so the live bubble can render them", () => {
    const { tee, deps } = makeTee();
    deps.isActive.mockImplementation(() => true);
    const a = fakeRuntime("a");
    tee.attachAll([a.rt]);
    const attachments = [{ name: "relazione.pdf", path: "/tmp/relazione.pdf", size: 42, isImage: false }];

    a.emit({
      type: "steer_applied",
      ids: ["s1"],
      content: "guarda qui",
      images: ["data:image/png;base64,iVBORw0KGgo="],
      attachments,
    });

    expect(deps.onPost).toHaveBeenCalledWith({
      type: "steerApplied",
      ids: ["s1"],
      content: "guarda qui",
      images: ["data:image/png;base64,iVBORw0KGgo="],
      attachments,
      sessionId: "a",
    });
  });

  it("forwards loop_intervention to the view and resets the live text", () => {
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
      sessionId: "a",
    });
    expect(a.engine.live.thinking).toBe("");
  });

  it("forwards harness_nudge to the view and resets the live text", () => {
    const { tee, deps } = makeTee();
    const a = fakeRuntime("a");
    tee.attach(a.rt);

    a.emit({ type: "thinking_delta", content: "thinking" });
    a.emit({ type: "text_delta", content: "answer" });
    a.emit({ type: "harness_nudge", content: "**Stop** repeating." });

    expect(deps.onPost).toHaveBeenCalledWith({ type: "harnessNudge", content: "**Stop** repeating.", sessionId: "a" });
    expect(a.engine.live.thinking).toBe("");
    expect(a.engine.live.answer).toBe("");
  });

  it("forwards preview_ready to the view when the session is active", () => {
    const { tee, deps } = makeTee();
    const a = fakeRuntime("a");
    tee.attach(a.rt);
    a.emit({ type: "preview_ready" });
    expect(deps.onPost).toHaveBeenCalledWith({ type: "previewReady", sessionId: "a" });
  });

  it("forwards subagent_start to the view when the session is active", () => {
    const { tee, deps } = makeTee();
    const a = fakeRuntime("a");
    tee.attach(a.rt);
    a.emit({ type: "subagent_start", toolCallId: "d1" });
    expect(deps.onPost).toHaveBeenCalledWith({ type: "subagentStart", toolCallId: "d1", sessionId: "a" });
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
      sessionId: "a",
    });
  });

  it("clears on done and on error", () => {
    const { tee } = makeTee();
    const a = fakeRuntime("a");
    tee.attach(a.rt);
    a.emit({ type: "thinking_delta", content: "x" });
    a.emit({ type: "tool_call", toolCall: { id: "c1", name: "Read", arguments: {} } });
    a.emit({ type: "done" });
    expect(a.engine.live.projection()).toBeUndefined();

    a.emit({ type: "thinking_delta", content: "y" });
    a.emit({ type: "error", error: "boom" });
    expect(a.engine.live.projection()).toBeUndefined();
  });

  it("routes usage to the onUsage callback", () => {
    const { tee, deps } = makeTee();
    const a = fakeRuntime("a");
    tee.attach(a.rt);
    a.emit({ type: "usage", usage: { input: 10, output: 2, total: 12 } });
    expect(deps.onUsage).toHaveBeenCalledWith("a", { input: 10, output: 2, total: 12 });
  });

  it("detach stops both forwarding AND recording (the engine dies with the runtime)", () => {
    const { tee, deps } = makeTee();
    const a = fakeRuntime("a");
    tee.attach(a.rt);
    a.emit({ type: "thinking_delta", content: "x" });

    tee.detach("a");
    a.emit({ type: "thinking_delta", content: "y" });

    // No longer recorded: the engine is going away with the runtime.
    expect(a.engine.live.thinking).toBe("x");
    deps.onPost.mockClear();
    a.emit({ type: "done" });
    expect(deps.onPost).not.toHaveBeenCalled();
  });

  it("reset clears the buffered turn (start of a new turn / abort)", () => {
    const { tee } = makeTee();
    const a = fakeRuntime("a");
    tee.attach(a.rt);
    a.emit({ type: "thinking_delta", content: "x" });
    a.emit({ type: "tool_call", toolCall: { id: "c1", name: "Read", arguments: {} } });

    a.engine.live.reset();
    expect(a.engine.live.thinking).toBe("");
    expect(a.engine.live.answer).toBe("");
    expect(a.engine.live.projection()).toBeUndefined();
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
    expect(deps.onPost).toHaveBeenCalledWith({
      type: "turnMeta",
      meta: { inputTokens: 123, durationMs: 5 },
      sessionId: "a",
    });
  });
});

describe("StreamTee — raw_chunk", () => {
  it("ignores raw_chunk (informational, never routed to the view)", () => {
    const { tee, deps } = makeTee();
    const a = fakeRuntime("a");
    tee.attach(a.rt);
    a.emit({ type: "raw_chunk", chunk: "x", kind: "text" });
    expect(deps.onPost).not.toHaveBeenCalled();
  });
});
