import { describe, it, expect, vi } from "vitest";
import {
  MementoPendingOpenStore,
  PendingOpens,
  PENDING_OPEN_MAX_AGE_MS,
  type PendingOpen,
  type PendingOpenStore,
} from "./pending-open";

/**
 * The gesture that survives a window reload.
 *
 * Every case here is about NOT firing: another folder, a stale marker, a second
 * activation. A marker that fires when it should not opens the wrong session in the wrong
 * project, which is worse than making the user click again.
 */

/** An in-memory store (the production one is `globalState`). */
function fakeStore(initial?: PendingOpen): PendingOpenStore & { value: PendingOpen | undefined } {
  const store = {
    value: initial,
    get() {
      return store.value;
    },
    async set(next: PendingOpen | undefined) {
      store.value = next;
    },
  };
  return store;
}

describe("PendingOpens", () => {
  it("hands the action back when the SAME folder opens, and clears it", async () => {
    const store = fakeStore();
    const pending = new PendingOpens(store, () => 1_000);
    await pending.remember("/p/harny", { kind: "session", sessionId: "s1" });

    expect(await pending.take("/p/harny")).toEqual({ kind: "session", sessionId: "s1" });
    // Consume-once: the marker is gone, so a second activation does nothing.
    expect(store.value).toBeUndefined();
    expect(await pending.take("/p/harny")).toBeUndefined();
  });

  it("matches the folder the way the host spells it (trailing separator, Windows case)", async () => {
    const store = fakeStore();
    const pending = new PendingOpens(store, () => 1_000);
    await pending.remember("/p/harny/", { kind: "create" });
    expect(await pending.take("/p/harny")).toEqual({ kind: "create" });

    await pending.remember("C:\\Users\\Me\\Proj", { kind: "create" });
    expect(await pending.take("c:/users/me/proj")).toEqual({ kind: "create" });
  });

  it("DISCARDS the marker when another folder is the one that opened", async () => {
    // The user changed their mind (or opened another project): the intent must not wait
    // around to fire on the next activation.
    const store = fakeStore();
    const pending = new PendingOpens(store, () => 1_000);
    await pending.remember("/p/harny", { kind: "session", sessionId: "s1" });

    expect(await pending.take("/p/other")).toBeUndefined();
    expect(store.value).toBeUndefined();
  });

  it("discards the marker when NO folder is open", async () => {
    const store = fakeStore();
    const pending = new PendingOpens(store, () => 1_000);
    await pending.remember("/p/harny", { kind: "create" });

    expect(await pending.take(undefined)).toBeUndefined();
    expect(store.value).toBeUndefined();
  });

  it("drops a marker older than the reload it was written for", async () => {
    // A reload takes seconds: anything from hours ago is debris, not a request.
    let clock = 1_000;
    const store = fakeStore();
    const pending = new PendingOpens(store, () => clock);
    await pending.remember("/p/harny", { kind: "create" });

    clock += PENDING_OPEN_MAX_AGE_MS + 1;
    expect(await pending.take("/p/harny")).toBeUndefined();
    expect(store.value).toBeUndefined();
  });

  it("still honours a marker inside the window (a slow machine is not debris)", async () => {
    let clock = 1_000;
    const store = fakeStore();
    const pending = new PendingOpens(store, () => clock);
    await pending.remember("/p/harny", { kind: "create" });

    clock += PENDING_OPEN_MAX_AGE_MS - 1;
    expect(await pending.take("/p/harny")).toEqual({ kind: "create" });
  });

  it("has nothing to say when nothing was stored", async () => {
    const set = vi.fn(async () => {});
    const pending = new PendingOpens({ get: () => undefined, set }, () => 1_000);
    expect(await pending.take("/p/harny")).toBeUndefined();
    expect(set).not.toHaveBeenCalled();
  });
});

describe("MementoPendingOpenStore", () => {
  it("round-trips through the memento and clears with undefined", async () => {
    const memory = new Map<string, unknown>();
    const memento = {
      get<T>(key: string, fallback: T): T {
        return (memory.has(key) ? memory.get(key) : fallback) as T;
      },
      async update(key: string, value: unknown): Promise<void> {
        memory.set(key, value);
      },
    };
    const store = new MementoPendingOpenStore(memento);
    const pending = new PendingOpens(store, () => 5_000);

    await pending.remember("/p/a", { kind: "session", sessionId: "x" });
    expect(store.get()).toEqual({ folder: "/p/a", action: { kind: "session", sessionId: "x" }, at: 5_000 });
    await pending.take("/p/a");
    expect(store.get()).toBeUndefined();
  });

  it("ignores junk left by another version instead of crashing activation", async () => {
    // The marker is an optimisation of a gesture, never a requirement.
    for (const junk of [null, 42, {}, { folder: "/p/a" }, { folder: "/p/a", action: { kind: "nope" }, at: 1 }]) {
      const store = new MementoPendingOpenStore({
        get: <T>() => junk as T,
        update: async () => {},
      });
      expect(store.get()).toBeUndefined();
    }
  });
});
