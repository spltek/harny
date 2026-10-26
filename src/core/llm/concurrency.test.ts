import { describe, it, expect } from "vitest";
import { DEFAULT_MAX_CONCURRENT_LLM_REQUESTS, Semaphore, limitLlmFactory } from "./concurrency";
import type { LLMProvider, LLMProviderFactory, StreamChunk } from "./types";

const tick = (ms = 1) => new Promise<void>((r) => setTimeout(r, ms));

describe("Semaphore", () => {
  it("hands out up to the limit immediately, then queues", async () => {
    const sem = new Semaphore(2);
    const a = await sem.acquire();
    const b = await sem.acquire();
    expect(sem.inFlight).toBe(2);
    expect(sem.queued).toBe(0);

    let third: (() => void) | undefined;
    void sem.acquire().then((release) => (third = release));
    expect(sem.queued).toBe(1); // waiting, not granted
    expect(third).toBeUndefined();

    a(); // the slot is TRANSFERRED, not freed and re-taken
    await tick();
    expect(third).toBeDefined();
    expect(sem.inFlight).toBe(2);
    expect(sem.queued).toBe(0);

    a(); // idempotent: releasing twice does not free a second slot
    expect(sem.inFlight).toBe(2);
    b();
    third!();
    expect(sem.inFlight).toBe(0);
  });

  it("is FIFO: a chatty caller cannot starve the others", async () => {
    const sem = new Semaphore(1);
    const order: number[] = [];
    const held = await sem.acquire();

    const pending = [1, 2, 3].map((n) =>
      sem.acquire().then((release) => {
        order.push(n);
        release();
      }),
    );
    held();
    await Promise.all(pending);
    expect(order).toEqual([1, 2, 3]);
  });

  it("rejects a waiter whose signal aborts, and leaves the queue clean", async () => {
    const sem = new Semaphore(1);
    const held = await sem.acquire();
    const controller = new AbortController();
    const waiting = sem.acquire(controller.signal);
    expect(sem.queued).toBe(1);

    controller.abort();
    await expect(waiting).rejects.toThrow(/aborted/);
    expect(sem.queued).toBe(0);

    // The slot is still usable: the aborted waiter did not take it with it.
    held();
    expect(sem.inFlight).toBe(0);
    const again = await sem.acquire();
    expect(sem.inFlight).toBe(1);
    again();
  });

  it("refuses an already-aborted signal without touching the counters", async () => {
    const sem = new Semaphore(1);
    const controller = new AbortController();
    controller.abort();
    await expect(sem.acquire(controller.signal)).rejects.toThrow(/aborted/);
    expect(sem.inFlight).toBe(0);
    expect(sem.queued).toBe(0);
  });

  it("treats a nonsensical limit as 1 instead of deadlocking", async () => {
    const sem = new Semaphore(0);
    const a = await sem.acquire();
    expect(sem.inFlight).toBe(1);
    let second: (() => void) | undefined;
    void sem.acquire().then((r) => (second = r));
    expect(second).toBeUndefined();
    a();
    await tick();
    expect(second).toBeDefined();
  });
});

/** A provider whose `stream()` holds a slot visibly: it reports the concurrency it
 * sees, so the test can assert on the PEAK rather than on timing. */
function harnessProvider() {
  const state = { concurrent: 0, peak: 0, started: 0, finished: 0 };
  const factory: LLMProviderFactory = {
    create(): LLMProvider {
      return {
        async *stream(): AsyncGenerator<StreamChunk> {
          state.concurrent += 1;
          state.started += 1;
          state.peak = Math.max(state.peak, state.concurrent);
          try {
            await tick(2); // the request is IN FLIGHT (this is the window a slot covers)
            yield { type: "text", content: "ok" };
            await tick(2);
          } finally {
            state.concurrent -= 1;
            state.finished += 1;
          }
        },
      };
    },
  };
  return { state, factory };
}

async function drain(provider: LLMProvider): Promise<string> {
  let text = "";
  for await (const chunk of provider.stream([])) {
    if (chunk.type === "text") text += chunk.content;
  }
  return text;
}

describe("limitLlmFactory", () => {
  it("never puts more than the limit in flight, and finishes them all", async () => {
    const { state, factory } = harnessProvider();
    const sem = new Semaphore(2);
    const limited = limitLlmFactory(factory, sem);

    const results = await Promise.all(Array.from({ length: 5 }, () => drain(limited.create({} as never))));

    expect(results).toEqual(["ok", "ok", "ok", "ok", "ok"]);
    expect(state.started).toBe(5);
    expect(state.finished).toBe(5);
    expect(state.peak).toBeLessThanOrEqual(2); // THE cap
    expect(state.peak).toBeGreaterThan(1); // …and it really did run in parallel
    expect(sem.inFlight).toBe(0); // every slot came back
  });

  it("freezes the slot for the WHOLE stream, not just the first chunk", async () => {
    const sem = new Semaphore(1);
    const { factory } = harnessProvider();
    const limited = limitLlmFactory(factory, sem).create({} as never);

    const first = limited.stream([]);
    await first.next(); // the first chunk is out: the request is still open
    expect(sem.inFlight).toBe(1);

    await first.next(); // done: the slot goes back
    expect(sem.inFlight).toBe(0);
  });

  it("releases the slot when the consumer breaks early (a `break` must not leak)", async () => {
    const sem = new Semaphore(1);
    const limited = limitLlmFactory(harnessProvider().factory, sem).create({} as never);

    for await (const chunk of limited.stream([])) {
      void chunk;
      break; // the agent's loop can stop for any reason
    }
    expect(sem.inFlight).toBe(0);
  });

  it("releases the slot when the stream throws", async () => {
    const sem = new Semaphore(1);
    const failing: LLMProviderFactory = {
      create: () => ({
        // eslint-disable-next-line require-yield
        async *stream(): AsyncGenerator<StreamChunk> {
          await tick(1);
          throw new Error("provider exploded");
        },
      }),
    };
    const provider = limitLlmFactory(failing, sem).create({} as never);

    await expect(drain(provider)).rejects.toThrow("provider exploded");
    expect(sem.inFlight).toBe(0); // the next request is not blocked forever
  });

  it("does not run a request whose signal aborted while it was QUEUED", async () => {
    const sem = new Semaphore(1);
    const { state, factory } = harnessProvider();
    const provider = limitLlmFactory(factory, sem).create({} as never);
    const busy = await sem.acquire(); // the only slot is taken

    const controller = new AbortController();
    const consumed = (async () => {
      for await (const chunk of provider.stream([], controller.signal)) void chunk;
    })();
    controller.abort();

    await expect(consumed).rejects.toThrow(/aborted/);
    expect(state.started).toBe(0); // it never reached the provider
    busy();
    expect(sem.inFlight).toBe(0);
  });

  it("exposes a sane default: wide enough for one Parallel run, far below 10 sessions", () => {
    expect(DEFAULT_MAX_CONCURRENT_LLM_REQUESTS).toBeGreaterThanOrEqual(4);
    expect(DEFAULT_MAX_CONCURRENT_LLM_REQUESTS).toBeLessThan(10 * 4);
  });
});
