import { describe, it, expect } from "vitest";
import { SessionEngine } from "./session-engine";
import type { PreparedPrompt, SendIntent, SessionAbortPort, SessionSendPort } from "./session-engine";
import type { ChatController, SendOptions } from "../core/agent/chat-controller";
import type { AgentEvent } from "../core/agent/types";
import type { ChatHistory } from "../core/history/chat-history";
import type { ChatMessage } from "../core/history/types";

/**
 * The run SEQUENCE, tested without a panel: this is what the port bought us.
 *
 * The order of these calls is the contract (`dispatch`), and every step exists
 * because something broke without it — the status before the run leaves the row
 * unlocked, the prompt before the compaction sends `/skills` through a compaction
 * it never needed, the refresh after a background run clobbers the tab you are on.
 */
function makeHarness(
  options: { hasModel?: boolean; prompt?: PreparedPrompt | null; emitError?: boolean; active?: boolean } = {},
) {
  const calls: string[] = [];
  const sent: { text: string; options?: SendOptions }[] = [];
  const added: ChatMessage[] = [];
  const handlers: ((e: AgentEvent) => void)[] = [];

  const agent = {
    streaming: false,
    async send(text: string, sendOptions?: SendOptions): Promise<void> {
      calls.push("agent.send");
      sent.push({ text, options: sendOptions });
      agent.streaming = true;
      // The real agent emits its events LATER (as the stream arrives); a
      // synchronous emission would land before the engine's subscription.
      await Promise.resolve();
      if (options.emitError) for (const h of [...handlers]) h({ type: "error", error: "boom" });
      agent.streaming = false;
    },
    onEvent(handler: (e: AgentEvent) => void): () => void {
      handlers.push(handler);
      return () => {
        const i = handlers.indexOf(handler);
        if (i >= 0) handlers.splice(i, 1);
      };
    },
    abort(): void {
      calls.push("agent.abort");
      agent.streaming = false;
    },
  };

  const history = {
    all: () => [],
    add: (m: ChatMessage) => added.push(m),
  } as unknown as ChatHistory;

  const enqueued: SendIntent[] = [];
  const port: SessionSendPort = {
    prepareAgent: () => calls.push("prepareAgent"),
    hasModel: () => options.hasModel !== false,
    rejectMissingModel: () => calls.push("rejectMissingModel"),
    preparePrompt: async (intent) => {
      calls.push("preparePrompt");
      if (options.prompt === null) return undefined; // handled locally (e.g. /skills)
      return options.prompt ?? { text: intent.text ?? "" };
    },
    compactBeforeRun: async () => calls.push("compactBefore"),
    compactAfterRun: async () => calls.push("compactAfter"),
    applyBudget: () => calls.push("applyBudget"),
    isDraining: () => false,
    enqueue: (intent) => {
      enqueued.push(intent);
      calls.push("enqueue");
    },
    drain: async (dispatch) => {
      calls.push("drain");
      void dispatch;
    },
    isActive: () => options.active !== false,
    showQueuedUser: () => calls.push("showQueuedUser"),
    onRunStarted: () => calls.push("onRunStarted"),
    onRunFinished: (hadError) => calls.push(`onRunFinished:${hadError}`),
  };
  /** The abort side of the SAME host object: two methods, because that is all `abort`
   * touches. A two-method stand-in instead of a seventeen-method one — that is what the
   * split bought, and it is what the previous `{ ...port }` spread was hiding. */
  const abortPort: SessionAbortPort = {
    clearQueue: () => calls.push("clearQueue"),
    onInterrupted: () => calls.push("onInterrupted"),
  };

  const engine = new SessionEngine("s1", history, agent as unknown as ChatController);
  return { engine, port, abortPort, calls, sent, added, enqueued, agent };
}

describe("SessionEngine.send — the run sequence", () => {
  it("runs a message through every step, in order, with the status AFTER the start", async () => {
    const { engine, port, calls } = makeHarness();

    await engine.send({ text: "ciao" }, port);

    expect(calls).toEqual([
      "prepareAgent",
      "preparePrompt",
      "compactBefore",
      "applyBudget",
      "agent.send", // strictly before the status: see below
      "onRunStarted",
      // The report comes with the lock released, BEFORE the post-response fill: the
      // compaction then posts its own bubble → status → refresh sequence whole.
      "onRunFinished:false",
      "compactAfter",
      "drain",
    ]);
    // The row can only lock from the first instant if `streaming` is already true
    // when the host's working set is computed.
    expect(calls.indexOf("agent.send")).toBeLessThan(calls.indexOf("onRunStarted"));
  });

  it("reports the run's end with the send lock ALREADY released", async () => {
    // THE bug behind a session that read "working…" forever (and a tab × that stayed
    // locked): the report used to fire from INSIDE the send lock, so `working` was still
    // true when the host computed `workingIds` for it. Nothing came after to correct that
    // picture — the run's last event had already been consumed.
    const { engine, port } = makeHarness();
    let workingAtReport: boolean | undefined;
    const spy: SessionSendPort = {
      ...port,
      onRunFinished: () => {
        workingAtReport = engine.working;
      },
    };

    await engine.send({ text: "ciao" }, spy);

    expect(workingAtReport).toBe(false);
  });

  it("does not report a run end for a message that never started (no gratuitous refresh)", async () => {
    const { engine, port, calls } = makeHarness();

    await engine.send({ text: "   " }, port); // nothing to send
    await engine.send({ text: "ciao" }, { ...port, hasModel: () => false }); // no model

    expect(calls.filter((c) => c.startsWith("onRunFinished"))).toEqual([]);
  });

  it("drops an empty message BEFORE asking for a model (an empty Enter must not nag)", async () => {
    const { engine, port, calls } = makeHarness({ hasModel: false });

    await engine.send({ text: "   " }, port);

    // `drain` still runs: a message parked while this one was being typed must not
    // be stranded (the queue delivers itself when it finds the session idle).
    expect(calls).toEqual(["prepareAgent", "drain"]);
  });

  it("refuses to run without a model, and runs nothing else", async () => {
    const { engine, port, calls } = makeHarness({ hasModel: false });

    await engine.send({ text: "ciao" }, port);

    expect(calls).toEqual(["prepareAgent", "rejectMissingModel", "drain"]);
  });

  it("stops when the prompt was already handled locally (no compaction, no run)", async () => {
    const { engine, port, calls } = makeHarness({ prompt: null });

    await engine.send({ text: "/skills" }, port);

    expect(calls).toEqual(["prepareAgent", "preparePrompt", "drain"]);
  });

  it("forwards exactly what preparePrompt built (images, attachments, displayText)", async () => {
    const prompt: PreparedPrompt = {
      text: "FILE CONTENTS\n\nciao",
      images: ["data:image/png;base64,x"],
      attachments: [{ name: "a.pdf", path: "/a.pdf", size: 3, isImage: false }],
      displayText: "ciao",
      attachmentParts: [],
    };
    const { engine, port, sent } = makeHarness({ prompt });

    await engine.send({ text: "ciao" }, port);

    expect(sent[0]).toEqual({
      text: "FILE CONTENTS\n\nciao",
      options: {
        images: ["data:image/png;base64,x"],
        attachments: [{ name: "a.pdf", path: "/a.pdf", size: 3, isImage: false }],
        displayText: "ciao",
        attachmentParts: [],
      },
    });
  });

  it("shows the queued user's bubble only for a QUEUED message on the ACTIVE tab", async () => {
    const active = makeHarness();
    await active.engine.send({ text: "q", mode: "queue" }, active.port);
    expect(active.calls).toContain("showQueuedUser");

    const background = makeHarness({ active: false });
    await background.engine.send({ text: "q", mode: "queue" }, background.port);
    expect(background.calls).not.toContain("showQueuedUser");
    expect(background.calls).toContain("agent.send"); // …but it still runs

    const direct = makeHarness();
    await direct.engine.send({ text: "hi" }, direct.port);
    expect(direct.calls).not.toContain("showQueuedUser"); // the view already drew it
  });

  it("reports an error to the host and still refreshes (the transcript is authoritative)", async () => {
    const { engine, port, calls } = makeHarness({ emitError: true });

    await engine.send({ text: "ciao" }, port);

    expect(calls).toContain("onRunFinished:true");
    expect(calls).toContain("compactAfter"); // the run ended: the fill is evaluated
  });

  it("queues instead of starting a second run while one is streaming", async () => {
    const { engine, port, calls, enqueued, agent } = makeHarness();
    agent.streaming = true;

    await engine.send({ text: "secondo" }, port);

    expect(calls).toEqual(["enqueue"]);
    expect(enqueued).toEqual([{ text: "secondo" }]);
    expect(calls).not.toContain("agent.send");
  });

  it("queues while a SEND PREAMBLE is still running (the lock is the engine's)", async () => {
    const { engine, port, calls } = makeHarness();
    engine.beginSend(); // another message is being prepared

    try {
      await engine.send({ text: "secondo" }, port);
      expect(calls).toEqual(["enqueue"]);
    } finally {
      engine.endSend();
    }
  });

  it("queues while the pending list is draining (no overlapping runs)", async () => {
    const { engine, port, calls } = makeHarness();
    const draining: SessionSendPort = { ...port, isDraining: () => true };

    await engine.send({ text: "secondo" }, draining);

    expect(calls).toEqual(["enqueue"]);
  });

  it("never leaves the send lock held, even when the prompt blows up", async () => {
    const { engine, port } = makeHarness();
    const boom: SessionSendPort = {
      ...port,
      preparePrompt: async () => {
        throw new Error("attachments unavailable");
      },
    };

    await expect(engine.send({ text: "ciao" }, boom)).rejects.toThrow("attachments unavailable");
    expect(engine.sending).toBe(false); // another message can be accepted again
  });
});

describe("SessionEngine.abort", () => {
  it("is a no-op when nothing is streaming", async () => {
    const { engine, abortPort, calls, added } = makeHarness();

    expect(await engine.abort(abortPort)).toBe(false);
    expect(calls).toEqual([]);
    expect(added).toEqual([]);
  });

  it("stops the run, drops the queue and writes the notice as uiOnly", async () => {
    const { engine, abortPort, calls, added, agent } = makeHarness();
    agent.streaming = true;
    // Something in the live turn, so the reset is observable.
    engine.live.apply({ type: "text_delta", content: "parziale" });

    expect(await engine.abort(abortPort)).toBe(true);

    expect(calls).toEqual(["clearQueue", "agent.abort", "onInterrupted"]);
    expect(engine.live.projection()).toBeUndefined(); // nothing to replay any more
    expect(added).toEqual([
      {
        role: "assistant",
        content: "❌ ⏹ Processing interrupted.",
        timestamp: expect.any(Number),
        uiOnly: true, // NEVER sent to the model: it would split tool_calls/results
      },
    ]);
  });
});
