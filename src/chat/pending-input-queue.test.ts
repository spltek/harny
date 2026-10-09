import { describe, expect, it, vi } from "vitest";
import { PendingInputQueue } from "./pending-input-queue";
import type { SessionRuntime } from "./session-registry";

/** A fake runtime: the queue only touches `sessionId` + `agent`. */
function fakeRt(id = "s1"): { rt: SessionRuntime; agent: { streaming: boolean; steer: ReturnType<typeof vi.fn>; cancelSteer: ReturnType<typeof vi.fn> } } {
  const agent = { streaming: true, steer: vi.fn(), cancelSteer: vi.fn() };
  const rt = { sessionId: id, agent, history: {} } as unknown as SessionRuntime;
  return { rt, agent };
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
