import { describe, it, expect } from "vitest";
import {
  SessionLiveState,
  MAX_LIVE_SUBAGENT_EVENTS,
  MAX_LIVE_TOOL_CALLS,
  MAX_LIVE_TOOL_OUTPUT,
} from "./session-live-state";
import type { AgentEvent } from "../core/agent/types";

/**
 * The MEASURED answer to "does the per-session recorder cost anything per token?".
 *
 * The recorder runs on EVERY open session — that is the whole point of it (switching
 * away must not lose the turn) — so its per-event cost is multiplied by the number of
 * sessions streaming at once, on the same single host thread that owns the streaming.
 * A regression here is invisible in correctness tests and shows up as a host that
 * feels sluggish with ten sessions; this test is the guard, and it prints the number.
 *
 * It also pins the MEMORY contract, because "bounded" was a claim in the design and
 * only an assertion makes it true.
 */

/** A text delta of the size a real provider sends (a few characters). */
const delta = (i: number): AgentEvent => ({ type: "text_delta", content: `tok${i} ` });

/** The heaviest events the recorder sees: tool output chunks and sub-agent traffic. */
function mixedStream(session: number): AgentEvent[] {
  const events: AgentEvent[] = [];
  for (let i = 0; i < 5000; i++) {
    if (i % 50 === 0) {
      events.push({
        type: "tool_call",
        toolCall: { id: `s${session}-c${i}`, name: "Read", arguments: { path: "/a.ts" } },
      });
    } else if (i % 50 === 25) {
      events.push({
        type: "tool_result",
        toolResult: { toolCallId: `s${session}-c${i - 25}`, output: "y".repeat(3000), isError: false },
      });
    } else if (i % 50 === 40) {
      events.push({ type: "subagent_start", toolCallId: `s${session}-c${i - 40}` });
    } else if (i % 50 === 45) {
      events.push({
        type: "subagent_event",
        toolCallId: `s${session}-c${i - 45}`,
        event: { type: "text_delta", content: "sub " },
      });
    } else {
      events.push(delta(i));
    }
  }
  return events;
}

describe("SessionLiveState — the price of remembering every session's turn", () => {
  it("costs a few microseconds per event, even with 20 sessions streaming", () => {
    const sessions = Array.from({ length: 20 }, () => new SessionLiveState());
    const streams = sessions.map((_, i) => mixedStream(i));
    const total = streams.reduce((n, s) => n + s.length, 0);

    const t0 = performance.now();
    for (let s = 0; s < sessions.length; s++) {
      for (const event of streams[s]) sessions[s].apply(event);
    }
    const elapsed = performance.now() - t0;
    const perEvent = (elapsed * 1000) / total; // µs

    console.log(`[live] ${total} eventi su 20 sessioni in ${elapsed.toFixed(1)}ms = ${perEvent.toFixed(2)}µs/evento`);

    // A provider sends a few thousand deltas per run: at a fraction of a microsecond
    // that is a rounding error next to seconds of network. 15µs is the regression line.
    expect(perEvent).toBeLessThan(15);
  });

  it("stays BOUNDED: the caps hold after a runaway stream, in memory and in the projection", () => {
    const live = new SessionLiveState();
    // 300 tool calls each hammered with 10 KB of output (3 MB), then 3000 sub-agent events.
    for (let i = 0; i < 300; i++) {
      live.apply({ type: "tool_call", toolCall: { id: `c${i}`, name: "Shell", arguments: {} } });
      live.apply({
        type: "tool_result",
        toolResult: { toolCallId: `c${i}`, output: "z".repeat(10_000), isError: false },
      });
    }
    for (let i = 0; i < 3000; i++) {
      live.apply({ type: "subagent_event", toolCallId: "c0", event: { type: "text_delta", content: `line ${i}` } });
    }

    expect(live.toolCalls.length).toBeLessThanOrEqual(MAX_LIVE_TOOL_CALLS);
    // The cap applies to the CONTENT; `cap()` then appends a "… (truncated)" marker, so
    // the stored string is a few bytes longer than the cap by design.
    const MARKER_SLACK = 32;
    for (const out of live.toolCalls.map((t) => t.output ?? "")) {
      expect(out.length).toBeLessThanOrEqual(MAX_LIVE_TOOL_OUTPUT + MARKER_SLACK);
    }
    for (const sa of live.subAgents.values()) {
      expect(sa.events.length).toBeLessThanOrEqual(MAX_LIVE_SUBAGENT_EVENTS);
    }

    // The projection is what CROSSES to the webview: it must not carry the 3 MB.
    const bytes = JSON.stringify(live.projection() ?? {}).length;
    console.log(`[live] proiezione dopo 3MB di output: ${(bytes / 1024).toFixed(1)}KB`);
    expect(bytes).toBeLessThan(200 * 1024);
  });

  it("frees the live turn the moment the run ends, so an IDLE session holds nothing", () => {
    // 'Bounded' is not enough: with a hundred sessions open, anything retained after a
    // run is retained a hundred times over. `done` and `error` are the events that say
    // "the history is authoritative from here" — this pins that they really free it.
    const live = new SessionLiveState();
    live.apply({ type: "text_delta", content: "answering" });
    live.apply({ type: "tool_call", toolCall: { id: "c1", name: "Read", arguments: {} } });
    live.apply({ type: "tool_result", toolResult: { toolCallId: "c1", output: "x".repeat(5000), isError: false } });
    expect(live.toolCalls).toHaveLength(1);
    expect(live.projection()).toBeDefined();

    live.apply({ type: "done" });

    expect(live.toolCalls).toEqual([]);
    expect(live.subAgents.size).toBe(0);
    expect(live.thinking).toBe("");
    expect(live.answer).toBe("");
    expect(live.projection()).toBeUndefined(); // nothing left to replay
  });

  it("the caps do not slow down a NORMAL turn (the common case pays nothing)", () => {
    // A realistic turn: 2000 deltas, 3 tool calls, one sub-agent.
    const live = new SessionLiveState();
    const events: AgentEvent[] = [];
    for (let i = 0; i < 2000; i++) events.push(delta(i));
    for (let i = 0; i < 3; i++) {
      events.push({ type: "tool_call", toolCall: { id: `c${i}`, name: "Read", arguments: {} } });
      events.push({ type: "tool_result", toolResult: { toolCallId: `c${i}`, output: "ok", isError: false } });
    }
    events.push({ type: "subagent_start", toolCallId: "c0" });
    events.push({ type: "subagent_event", toolCallId: "c0", event: { type: "text_delta", content: "checking…" } });

    const t0 = performance.now();
    for (const event of events) live.apply(event);
    const elapsed = performance.now() - t0;

    console.log(`[live] turno normale (${events.length} eventi): ${elapsed.toFixed(2)}ms`);
    // The whole turn's bookkeeping must be a rounding error, not a frame drop.
    expect(elapsed).toBeLessThan(60);
    expect(live.toolCalls).toHaveLength(3);
  });
});
