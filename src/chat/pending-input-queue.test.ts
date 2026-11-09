import { describe, expect, it, vi } from "vitest";
import { PendingInputQueue } from "./pending-input-queue";
import type { SessionRuntime } from "./session-registry";

/** A fake runtime: the queue only touches `sessionId` + `agent`. */
function fakeRt(id = "s1"): {
  rt: SessionRuntime;
  agent: { streaming: boolean; steer: ReturnType<typeof vi.fn>; cancelSteer: ReturnType<typeof vi.fn> };
  setCompacting: (v: boolean) => void;
} {
  const agent = { streaming: true, steer: vi.fn(), cancelSteer: vi.fn() };
  let compacting = false;
  // The engine owns the ONE busy predicate (streaming OR sending OR compacting), and the queue
  // asks IT — not `agent.streaming` — whether a send may start.
  const engine = {
    get working() {
      return agent.streaming || compacting;
    },
  };
  const rt = { sessionId: id, agent, engine, history: {} } as unknown as SessionRuntime;
  return {
    rt,
    agent,
    setCompacting: (v: boolean) => {
      compacting = v;
    },
  };
}

function makeQueue(buildContext = vi.fn(async () => ({ text: "", images: [], parts: [] }))) {
  const posted: { sessionId: string; items: { id: string }[] }[] = [];
  const queue = new PendingInputQueue({
    buildContext,
    post: (sessionId, items) => posted.push({ sessionId, items: items.map((i) => ({ id: i.id })) }),
  });
  return { queue, posted, buildContext };
}

describe("PendingInputQueue", () => {
  it("queues a message and posts the list", () => {
    const { queue, posted } = makeQueue();
    const { rt } = fakeRt();

    queue.enqueue(rt, { mode: "queue", id: "q1", text: "later" });

    expect(queue.items("s1").map((p) => p.id)).toEqual(["q1"]);
    expect(posted.at(-1)).toEqual({ sessionId: "s1", items: [{ id: "q1" }] });
  });

  it("keeps each steer as its OWN item and hands it to the agent", async () => {
    const { queue } = makeQueue();
    const { rt, agent } = fakeRt();

    queue.enqueue(rt, { mode: "steer", id: "sA", text: "one" });
    queue.enqueue(rt, { mode: "steer", id: "sB", text: "two" });

    await vi.waitFor(() => expect(agent.steer).toHaveBeenCalledTimes(2));
    expect(queue.items("s1").map((p) => p.id)).toEqual(["sA", "sB"]);
    expect(agent.steer).toHaveBeenNthCalledWith(1, "sA", "one", expect.objectContaining({}));
    expect(agent.steer).toHaveBeenNthCalledWith(2, "sB", "two", expect.objectContaining({}));
  });

  it("ignores an empty message (no text, no attachments)", () => {
    const { queue } = makeQueue();
    const { rt } = fakeRt();
    queue.enqueue(rt, { mode: "queue", text: "   " });
    expect(queue.items("s1")).toEqual([]);
  });

  it("cancel drops a queued item without touching the agent", () => {
    const { queue } = makeQueue();
    const { rt, agent } = fakeRt();
    queue.enqueue(rt, { mode: "queue", id: "q1", text: "later" });

    queue.cancel(rt, "q1");

    expect(queue.items("s1")).toEqual([]);
    expect(agent.cancelSteer).not.toHaveBeenCalled();
  });

  it("cancel drops a steer and cancels it on the agent", async () => {
    const { queue } = makeQueue();
    const { rt, agent } = fakeRt();
    queue.enqueue(rt, { mode: "steer", id: "sA", text: "x" });
    await vi.waitFor(() => expect(agent.steer).toHaveBeenCalled());

    queue.cancel(rt, "sA");

    expect(queue.items("s1")).toEqual([]);
    expect(agent.cancelSteer).toHaveBeenCalledWith("sA");
  });

  it("clear cancels every steer and empties the list", async () => {
    const { queue } = makeQueue();
    const { rt, agent } = fakeRt();
    queue.enqueue(rt, { mode: "steer", id: "sA", text: "x" });
    queue.enqueue(rt, { mode: "queue", id: "q1", text: "y" });
    await vi.waitFor(() => expect(agent.steer).toHaveBeenCalled());

    queue.clear(rt);

    expect(queue.items("s1")).toEqual([]);
    expect(agent.cancelSteer).toHaveBeenCalledWith("sA");
  });

  it("onSteerApplied removes the consumed ids", () => {
    const { queue } = makeQueue();
    const { rt } = fakeRt();
    queue.enqueue(rt, { mode: "steer", id: "sA", text: "x" });
    queue.enqueue(rt, { mode: "steer", id: "sB", text: "y" });

    queue.onSteerApplied("s1", ["sA"]);

    expect(queue.items("s1").map((p) => p.id)).toEqual(["sB"]);
  });

  it("drain runs queued messages FIFO via the dispatch callback", async () => {
    const { queue } = makeQueue();
    const { rt, agent } = fakeRt();
    const calls: string[] = [];
    queue.enqueue(rt, { mode: "queue", id: "q1", text: "one" });
    queue.enqueue(rt, { mode: "queue", id: "q2", text: "two" });
    agent.streaming = false;

    await queue.drain(rt, async (item) => {
      calls.push(item.text);
    });

    expect(calls).toEqual(["one", "two"]);
    expect(queue.items("s1")).toEqual([]);
  });

  it("drain runs orphan steers BEFORE queued messages (grouped order)", async () => {
    const { queue } = makeQueue();
    const { rt, agent } = fakeRt();
    const calls: string[] = [];
    queue.enqueue(rt, { mode: "queue", id: "q1", text: "queue-one" });
    queue.enqueue(rt, { mode: "steer", id: "s1", text: "steer-one" });
    queue.enqueue(rt, { mode: "queue", id: "q2", text: "queue-two" });
    agent.streaming = false;

    await queue.drain(rt, async (item) => {
      calls.push(item.text);
    });

    expect(calls).toEqual(["steer-one", "queue-one", "queue-two"]);
  });

  it("does not dispatch into a compaction (the history is being rewritten)", async () => {
    const { queue } = makeQueue();
    const { rt, agent, setCompacting } = fakeRt();
    const calls: string[] = [];
    queue.enqueue(rt, { mode: "queue", id: "q1", text: "one" });
    agent.streaming = false; // the run is over…
    setCompacting(true); // …but the post-run summary is still rebuilding the history

    await queue.drain(rt, async (item) => {
      calls.push(item.text);
    });
    expect(calls).toEqual([]); // nothing ran under a rewrite in progress
    expect(queue.items("s1")).toHaveLength(1); // and the message is still there

    setCompacting(false);
    await queue.drain(rt, async (item) => {
      calls.push(item.text);
    });
    expect(calls).toEqual(["one"]);
  });

  it("isDraining is true during a drain and false after", async () => {
    const { queue } = makeQueue();
    const { rt, agent } = fakeRt();
    queue.enqueue(rt, { mode: "queue", id: "q1", text: "one" });
    agent.streaming = false;

    let during = false;
    await queue.drain(rt, async () => {
      during = queue.isDraining("s1");
    });

    expect(during).toBe(true);
    expect(queue.isDraining("s1")).toBe(false);
  });

  describe("setMode — converting a pending message between queue and steer", () => {
    it("queue -> steer hands it to the RUNNING loop, exactly like typing a steer", async () => {
      const { queue } = makeQueue();
      const { rt, agent } = fakeRt(); // streaming: a run is in flight
      queue.enqueue(rt, { mode: "queue", id: "q1", text: "wait" });
      expect(agent.steer).not.toHaveBeenCalled();

      queue.setMode(rt, "q1", "steer");

      await vi.waitFor(() => expect(agent.steer).toHaveBeenCalledTimes(1));
      expect(agent.steer).toHaveBeenCalledWith("q1", "wait", expect.objectContaining({}));
      // The badge in the UI follows the mode.
      expect(queue.items("s1").map((p) => p.mode)).toEqual(["steer"]);
    });

    it("steer -> queue WITHDRAWS the draft from the agent (the delicate direction)", async () => {
      // Without this the message the user just "put back in the queue" would still
      // be injected into the running loop as a steer: the button would lie.
      const { queue } = makeQueue();
      const { rt, agent } = fakeRt();
      queue.enqueue(rt, { mode: "steer", id: "s1", text: "steer me" });
      await vi.waitFor(() => expect(agent.steer).toHaveBeenCalledTimes(1));

      queue.setMode(rt, "s1", "queue");

      expect(agent.cancelSteer).toHaveBeenCalledWith("s1");
      expect(queue.items("s1").map((p) => p.mode)).toEqual(["queue"]);
    });

    it("steer -> queue survives an IN-FLIGHT apply (attachment context still building)", async () => {
      // The conversion must also supersede an apply that is mid-await, otherwise
      // the draft is delivered after the user converted it.
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const buildContext = vi.fn(async () => {
        await gate;
        return { text: "attachment text", images: [], parts: [] };
      });
      const { queue } = makeQueue(buildContext);
      const { rt, agent } = fakeRt();
      queue.enqueue(rt, {
        mode: "steer",
        id: "s1",
        text: "see file",
        attachments: [{ name: "a.txt", path: "/tmp/a.txt", size: 2, isImage: false }],
      });

      queue.setMode(rt, "s1", "queue");
      release(); // the context finishes building AFTER the conversion
      await vi.waitFor(() => expect(buildContext).toHaveBeenCalled());
      await Promise.resolve();

      expect(agent.steer).not.toHaveBeenCalled(); // never delivered as a steer
      expect(agent.cancelSteer).toHaveBeenCalledWith("s1");
    });

    it("changes the DRAIN order: a converted steer no longer goes first", async () => {
      const { queue } = makeQueue();
      const { rt, agent } = fakeRt();
      const calls: string[] = [];
      queue.enqueue(rt, { mode: "queue", id: "q1", text: "queued-first" });
      queue.enqueue(rt, { mode: "steer", id: "s1", text: "was-a-steer" });
      queue.setMode(rt, "s1", "queue");
      agent.streaming = false;

      await queue.drain(rt, async (item) => {
        calls.push(item.text);
      });

      // Arrival order, no jump: the conversion really changed the destination.
      expect(calls).toEqual(["queued-first", "was-a-steer"]);
    });

    it("queue -> steer while IDLE still moves it ahead of the queued ones", async () => {
      // No run in flight: nothing to inject, but the grouped drain order (steers
      // first) still honours the choice.
      const { queue } = makeQueue();
      const { rt, agent } = fakeRt();
      const calls: string[] = [];
      agent.streaming = false;
      queue.enqueue(rt, { mode: "queue", id: "q1", text: "queued" });
      queue.enqueue(rt, { mode: "queue", id: "q2", text: "promoted" });

      queue.setMode(rt, "q2", "steer");
      await queue.drain(rt, async (item) => {
        calls.push(item.text);
      });

      expect(calls).toEqual(["promoted", "queued"]);
    });

    it("does nothing for an unknown id or for the mode it already has", () => {
      const { queue, posted } = makeQueue();
      const { rt, agent } = fakeRt();
      queue.enqueue(rt, { mode: "queue", id: "q1", text: "one" });
      const postsBefore = posted.length;

      queue.setMode(rt, "nope", "steer");
      queue.setMode(rt, "q1", "queue");

      expect(posted.length).toBe(postsBefore); // no pointless re-render
      expect(queue.items("s1").map((p) => p.mode)).toEqual(["queue"]);
      expect(agent.steer).not.toHaveBeenCalled();
      expect(agent.cancelSteer).not.toHaveBeenCalled();
    });

    it("posts the list on a real conversion, so the badge updates", () => {
      const { queue, posted } = makeQueue();
      const { rt } = fakeRt();
      queue.enqueue(rt, { mode: "queue", id: "q1", text: "one" });

      queue.setMode(rt, "q1", "steer");

      expect(posted.at(-1)).toEqual({ sessionId: "s1", items: [{ id: "q1" }] });
    });

    it("cancel still works on a converted item (and never steers it)", () => {
      const { queue } = makeQueue();
      const { rt, agent } = fakeRt();
      queue.enqueue(rt, { mode: "steer", id: "s1", text: "one" });
      queue.setMode(rt, "s1", "queue");

      queue.cancel(rt, "s1");

      expect(queue.items("s1")).toEqual([]);
      // Called once by the conversion, not twice by the cancel.
      expect(agent.cancelSteer).toHaveBeenCalledTimes(1);
    });
  });

  it("a steer with attachments builds the context and forwards it", async () => {
    const buildContext = vi.fn(async () => ({
      text: 'Attached file "a.txt":\n```\nhi\n```',
      images: [],
      parts: [],
    }));
    const { queue } = makeQueue(buildContext);
    const { rt, agent } = fakeRt();

    queue.enqueue(rt, {
      mode: "steer",
      id: "sA",
      text: "use this",
      attachments: [{ name: "a.txt", path: "/tmp/a.txt", size: 2, isImage: false }],
    });

    await vi.waitFor(() =>
      expect(agent.steer).toHaveBeenCalledWith(
        "sA",
        expect.stringContaining("Attached file"),
        expect.objectContaining({ displayText: "use this" }),
      ),
    );
    expect(buildContext).toHaveBeenCalled();
  });

  it("does NOT deliver a steer whose run ended while the context was building", async () => {
    const { rt, agent } = fakeRt();
    const buildContext = vi.fn(async () => {
      agent.streaming = false; // the run ended mid-build
      return { text: "ctx", images: [], parts: [] };
    });
    const { queue } = makeQueue(buildContext);

    queue.enqueue(rt, {
      mode: "steer",
      id: "sA",
      text: "too late",
      attachments: [{ name: "a.txt", path: "/tmp/a.txt", size: 2, isImage: false }],
    });
    await vi.waitFor(() => expect(buildContext).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));

    expect(agent.steer).not.toHaveBeenCalled();
    expect(queue.items("s1").map((p) => p.id)).toEqual(["sA"]);
  });

  it("items() is empty for an unknown session", () => {
    const { queue } = makeQueue();
    expect(queue.items("nope")).toEqual([]);
  });

  it("drop forgets a session's pending state (reopen shows nothing stale)", () => {
    const { queue } = makeQueue();
    const { rt } = fakeRt();
    queue.enqueue(rt, { mode: "queue", id: "q1", text: "later" });
    expect(queue.items("s1")).toHaveLength(1);

    queue.drop("s1");

    expect(queue.items("s1")).toEqual([]);
  });
});
