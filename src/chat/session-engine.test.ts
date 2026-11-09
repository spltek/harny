import { describe, it, expect } from "vitest";
import { SessionEngine } from "./session-engine";
import type { SendIntent } from "./session-engine";
import type { ChatController } from "../core/agent/chat-controller";
import type { ChatHistory } from "../core/history/chat-history";
import type { ChatMessage } from "../core/history/types";

/** The engine only reads `all()`: a fake keeps the test free of the store. */
function fakeHistory(messages: ChatMessage[] = []): ChatHistory {
  return { all: () => messages } as unknown as ChatHistory;
}

/** The only agent field the engine reads is `streaming` (see `working`). */
function fakeAgent(streaming = false): ChatController {
  return { streaming } as unknown as ChatController;
}

function engineWith(messages: ChatMessage[] = [], streaming = false): SessionEngine {
  return new SessionEngine("s1", fakeHistory(messages), fakeAgent(streaming));
}

describe("SessionEngine", () => {
  it("owns the run facts: sending, compacting and the ONE `working` predicate", () => {
    const agent = fakeAgent();
    const engine = new SessionEngine("s1", fakeHistory(), agent);
    expect(engine.working).toBe(false);
    expect(engine.sending).toBe(false);
    expect(engine.compacting).toBe(false);

    // The SEND PREAMBLE (attachment build, auto-compaction): no run yet, still busy.
    engine.beginSend();
    expect(engine.sending).toBe(true);
    expect(engine.working).toBe(true);

    // The run starts: the lock is released but the session stays busy.
    (agent as { streaming: boolean }).streaming = true;
    engine.endSend();
    expect(engine.sending).toBe(false);
    expect(engine.working).toBe(true);

    (agent as { streaming: boolean }).streaming = false;
    expect(engine.working).toBe(false);

    // A compaction is a HISTORY REWRITE, not a spectator fact: `performCompaction` rebuilds the
    // transcript from the snapshot it read BEFORE calling the summarizer, so a send that went
    // through during that window was appended to the history and then rebuilt away — the
    // user's turn gone from disk and from the model's window, silently. It therefore holds the
    // session like a send does (the message is parked and delivered right after: `resume`).
    engine.beginCompaction();
    expect(engine.compacting).toBe(true);
    expect(engine.working).toBe(true);
    engine.endCompaction();
    expect(engine.compacting).toBe(false);
    expect(engine.working).toBe(false);
  });

  it("parks a message typed during a compaction and delivers it right after (`resume`)", async () => {
    const agent = { streaming: false, send: () => Promise.resolve() } as unknown as ChatController;
    const engine = new SessionEngine("s1", fakeHistory(), agent);
    const parked: SendIntent[] = [];
    let dispatched = 0;
    const port = {
      prepareAgent: () => {},
      hasModel: () => true,
      rejectMissingModel: () => {},
      preparePrompt: async () => undefined,
      compactBeforeRun: async () => {},
      compactAfterRun: async () => {},
      isDraining: () => false,
      enqueue: (intent: SendIntent) => parked.push(intent),
      drain: async (dispatch: (i: SendIntent) => Promise<void>) => {
        const next = parked.shift();
        if (next) {
          dispatched++;
          await dispatch(next);
        }
      },
      isActive: () => true,
      showQueuedUser: () => {},
      onRunStarted: () => {},
      onError: () => {},
      onRunFinished: () => {},
    } as never;

    // The post-run compaction is summarizing: the session is busy, so the message waits.
    engine.beginCompaction();
    await engine.send({ text: "and one more thing", mode: "send" } as SendIntent, port);
    expect(parked.map((i) => i.text)).toEqual(["and one more thing"]);
    expect(dispatched).toBe(0); // nothing ran: no history rewrite under a live turn

    // The summary is done: the parked message goes through, in order, exactly once.
    engine.endCompaction();
    await engine.resume(port);
    expect(dispatched).toBe(1);
    expect(parked).toHaveLength(0);
  });

  it("Stop during a compaction cancels the summary and drops what was parked behind it", async () => {
    const engine = new SessionEngine("s1", fakeHistory(), fakeAgent(false));
    let cancelled = 0;
    let cleared = 0;
    const port = {
      clearQueue: () => {
        cleared++;
      },
      onInterrupted: () => {
        throw new Error("a cancelled COMPACTION is not an interrupted RUN: no red bubble");
      },
      cancelCompaction: () => {
        cancelled++;
        return true;
      },
    } as never;

    // Nothing in flight: Stop is honestly refused (no lying button).
    expect(await engine.abort(port)).toBe(false);
    expect(cancelled).toBe(0);

    engine.beginCompaction();
    expect(await engine.abort(port)).toBe(true);
    expect(cancelled).toBe(1);
    expect(cleared).toBe(1); // a message parked behind the compaction must not fire afterwards
    engine.endCompaction();
  });

  it("a HOST stop carries its reason, a user stop keeps today's words", async () => {
    const added: ChatMessage[] = [];
    const history = {
      all: () => [],
      add: (m: ChatMessage) => {
        added.push(m);
      },
    } as unknown as ChatHistory;
    const agent = { streaming: true, abort: () => {} } as unknown as ChatController;
    const engine = new SessionEngine("s1", history, agent);
    const port = { clearQueue: () => {}, onInterrupted: () => {} } as never;

    // A stop nobody pressed must explain itself (the workspace folder disappeared).
    await engine.abort(port, "Stopped: the workspace folder /p/gone no longer exists.");
    expect(added.at(-1)?.content).toBe("❌ ⏹ Stopped: the workspace folder /p/gone no longer exists.");

    // The Stop button: same call, no reason — byte for byte what it always said.
    await engine.abort(port);
    expect(added.at(-1)?.content).toBe("❌ ⏹ Processing interrupted.");
  });

  it("has no projection when nothing is in flight", () => {
    expect(engineWith().projection()).toBeUndefined();
  });

  it("projects the in-flight turn: text, tool calls and sub-agents", () => {
    const engine = engineWith();
    engine.live.apply({ type: "text_delta", content: "Lancio i sub-agent." });
    engine.live.apply({ type: "tool_call", toolCall: { id: "d1", name: "Delegate", arguments: { id: "api" } } });
    engine.live.apply({ type: "subagent_start", toolCallId: "d1" });
    engine.live.apply({ type: "subagent_event", toolCallId: "d1", event: { type: "text_delta", content: "leggo" } });

    const p = engine.projection()!;
    expect(p.answer).toBe("Lancio i sub-agent.");
    expect(p.textAfterTools).toBe(false);
    expect(p.toolCalls.map((t) => t.id)).toEqual(["d1"]);
    expect(p.subAgents.d1.status).toBe("running");
    expect(p.subAgents.d1.events).toHaveLength(1);
  });

  it("drops the calls the history ALREADY contains (the batch commit is async)", () => {
    // The tool batch is committed with ONE addGroup write, AFTER the results are
    // emitted: for a moment the recorder holds calls that are already rendered
    // in the transcript. Replaying those would duplicate the bubbles.
    const engine = engineWith([
      { role: "user", content: "go", timestamp: 1 },
      {
        role: "assistant",
        content: "🔧 Tools: Delegate",
        timestamp: 2,
        toolCalls: [{ id: "d1", name: "Delegate", arguments: {} }],
      },
      { role: "tool", toolCallId: "d1", content: "report", timestamp: 3 },
    ]);
    engine.live.apply({ type: "tool_call", toolCall: { id: "d1", name: "Delegate", arguments: {} } });
    engine.live.apply({ type: "tool_call", toolCall: { id: "d2", name: "Delegate", arguments: {} } });

    expect(engine.projection()!.toolCalls.map((t) => t.id)).toEqual(["d2"]);
  });

  it("is undefined when EVERYTHING in flight is already committed", () => {
    const engine = engineWith([
      {
        role: "assistant",
        content: "🔧 Tools: Read",
        timestamp: 1,
        toolCalls: [{ id: "c1", name: "Read", arguments: {} }],
      },
      { role: "tool", toolCallId: "c1", content: "ok", timestamp: 2 },
    ]);
    engine.live.apply({ type: "tool_call", toolCall: { id: "c1", name: "Read", arguments: {} } });
    expect(engine.projection()).toBeUndefined();
  });

  it("dedupes a call committed FAR BACK in a long run (the scan is structural, not a window)", () => {
    // A single run can commit MANY tool batches; the recorder holds the calls of
    // all of them (it is reset only when the run starts/ends). With a fixed
    // 100-message window the oldest batch would fall out of reach and be
    // replayed as a DUPLICATE bubble. The scan stops at the run's user prompt.
    const messages: ChatMessage[] = [
      { role: "user", content: "go", timestamp: 1 },
      {
        role: "assistant",
        content: "🔧 Tools: Delegate",
        timestamp: 2,
        toolCalls: [{ id: "d-old", name: "Delegate", arguments: {} }],
      },
      { role: "tool", toolCallId: "d-old", content: "report", timestamp: 3 },
    ];
    // …then 150 more messages of the SAME run (no user prompt: it is still running).
    for (let i = 0; i < 150; i++) {
      messages.push({ role: "assistant", content: `turn ${i}`, timestamp: 10 + i });
    }
    const engine = engineWith(messages);
    engine.live.apply({ type: "tool_call", toolCall: { id: "d-old", name: "Delegate", arguments: {} } });

    expect(engine.projection()).toBeUndefined(); // still deduped, 150 messages later
  });

  it("keeps the text even when the bubbles are all committed", () => {
    // A turn can stream new text after its tools are committed: the text must
    // still travel (otherwise the bubble is rebuilt blank).
    const engine = engineWith([
      {
        role: "assistant",
        content: "🔧 Tools: Read",
        timestamp: 1,
        toolCalls: [{ id: "c1", name: "Read", arguments: {} }],
      },
      { role: "tool", toolCallId: "c1", content: "ok", timestamp: 2 },
    ]);
    engine.live.apply({ type: "tool_call", toolCall: { id: "c1", name: "Read", arguments: {} } });
    engine.live.apply({ type: "text_delta", content: "Ecco il risultato" });

    const p = engine.projection()!;
    expect(p.answer).toBe("Ecco il risultato");
    expect(p.toolCalls).toEqual([]);
    expect(p.textAfterTools).toBe(true);
  });
});
