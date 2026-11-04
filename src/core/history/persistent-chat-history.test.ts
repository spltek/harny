import { describe, it, expect, vi } from "vitest";
import { PersistentChatHistory } from "./persistent-chat-history";
import type { SessionStore, SessionSummary } from "../sessions/types";
import { SessionConflictError } from "../sessions/session-conflict";
import type { ChatMessage } from "./types";

function msg(partial: Partial<ChatMessage>): ChatMessage {
  return { role: "user", content: "", timestamp: 1, ...partial };
}

function makeStore(): SessionStore {
  return {
    list: vi.fn(() => []),
    create: vi.fn(),
    load: vi.fn(),
    saveMessages: vi.fn((id: string, messages: ChatMessage[]) => ({
      id,
      name: "S",
      createdAt: 1,
      updatedAt: 2,
      messageCount: messages.length,
    })),
    rename: vi.fn(),
    remove: vi.fn(),
  } as unknown as SessionStore;
}

const summary = (revision?: number): SessionSummary => ({
  id: "sess-1",
  name: "S",
  createdAt: 1,
  updatedAt: 2,
  messageCount: 1,
  ...(revision !== undefined ? { revision } : {}),
});

describe("PersistentChatHistory", () => {
  it("autosaves to its bound session id on add", () => {
    const store = makeStore();
    const history = new PersistentChatHistory(store, "sess-1");

    history.add(msg({ content: "a" }));

    expect(store.saveMessages).toHaveBeenCalledWith("sess-1", [expect.objectContaining({ content: "a" })], {
      revision: undefined,
    });
  });

  it("addGroup writes the whole turn in ONE store call (one transaction)", () => {
    const store = makeStore();
    const history = new PersistentChatHistory(store, "sess-1");
    history.replace([msg({ role: "user", content: "go" })]);

    history.addGroup([
      msg({ role: "assistant", content: "", toolCalls: [{ id: "c1", name: "Shell", arguments: {} }], timestamp: 2 }),
      msg({ role: "tool", content: "out", toolCallId: "c1", timestamp: 3 }),
    ]);

    // ONE write, carrying the accumulated history: the store inserts the new
    // suffix inside a single BEGIN/COMMIT, so the call and its results can never
    // be torn apart — by a crash, or by another writer slipping in between.
    expect(store.saveMessages).toHaveBeenCalledTimes(1);
    expect(store.saveMessages).toHaveBeenCalledWith(
      "sess-1",
      [
        expect.objectContaining({ role: "user", content: "go" }),
        expect.objectContaining({ role: "assistant", toolCalls: [{ id: "c1", name: "Shell", arguments: {} }] }),
        expect.objectContaining({ role: "tool", toolCallId: "c1" }),
      ],
      { revision: undefined },
    );
    expect(history.all()).toHaveLength(3);
  });

  it("addGroup with nothing to add does not touch the store", () => {
    const store = makeStore();
    const history = new PersistentChatHistory(store, "sess-1");
    history.addGroup([]);
    expect(store.saveMessages).not.toHaveBeenCalled();
  });

  it("reports every write's summary to onSaved (the row dates follow, no extra read)", () => {
    const store = makeStore();
    const onSaved = vi.fn();
    const history = new PersistentChatHistory(store, "sess-1", onSaved);

    history.add(msg({ content: "a" }));
    history.addGroup([msg({ role: "assistant", content: "ok", timestamp: 2 })]);

    // The summary the STORE returned, messageCount included: nobody re-reads the row.
    expect(onSaved).toHaveBeenCalledTimes(2);
    expect(onSaved).toHaveBeenLastCalledWith(expect.objectContaining({ id: "sess-1", updatedAt: 2, messageCount: 2 }));
  });

  it("still WRITES with no onSaved hook (the hook is optional, the save is not)", () => {
    const store = makeStore();
    const history = new PersistentChatHistory(store, "sess-1");

    history.add(msg({ content: "a" }));
    history.addGroup([msg({ role: "assistant", content: "ok", timestamp: 2 })]);

    // `onSaved?.(saveMessages(...))` would skip the SAVE entirely: an optional call
    // short-circuits its arguments. The hook must never gate the write.
    expect(store.saveMessages).toHaveBeenCalledTimes(2);
  });

  it("replace swaps messages without triggering a save", () => {
    const store = makeStore();
    const history = new PersistentChatHistory(store, "sess-1");

    history.replace([msg({ content: "loaded" })]);

    expect(history.all().map((m) => m.content)).toEqual(["loaded"]);
    expect(store.saveMessages).not.toHaveBeenCalled();
  });

  it("conversation() includes system (summary) and excludes uiOnly messages", () => {
    const history = new PersistentChatHistory(makeStore(), "sess-1");
    history.replace([
      msg({ role: "system", content: "sys" }),
      msg({ role: "user", content: "u" }),
      msg({ role: "assistant", content: "hidden", uiOnly: true }),
      msg({ role: "tool", content: "t", toolCallId: "c1" }),
    ]);

    expect(history.conversation().map((m) => m.role)).toEqual(["system", "user", "tool"]);
  });
});

describe("PersistentChatHistory — two windows, one session", () => {
  /** A store whose writer can be told to refuse, the way the real one does on a stale token. */
  function makeGuardedStore(): { store: SessionStore; calls: { revision?: number }[] } {
    const calls: { revision?: number }[] = [];
    let stored = 3;
    let refuseNext = false;
    const store = {
      saveMessages: vi.fn((id: string, messages: ChatMessage[], options?: { revision?: number }) => {
        calls.push({ revision: options?.revision });
        if (refuseNext) {
          refuseNext = false;
          stored += 1; // the other window's write landed
          throw new SessionConflictError(id, stored);
        }
        if (options?.revision !== undefined && options.revision !== stored) {
          throw new SessionConflictError(id, stored);
        }
        stored += 1;
        return { ...summary(stored), messageCount: messages.length };
      }),
      refuse: () => (refuseNext = true),
    } as unknown as SessionStore & { refuse: () => void };
    return { store, calls };
  }

  it("sends the token it adopted, and adopts the one the store computed", () => {
    const { store, calls } = makeGuardedStore();
    const history = new PersistentChatHistory(store, "sess-1");
    history.adopt(summary(3));

    history.add(msg({ content: "a" }));
    history.add(msg({ role: "assistant", content: "b", timestamp: 2 }));

    // 3 was the load's token; the store answered 4, and that is what the next save carries:
    // `revision + 1` would be a guess (only the transaction knows who else wrote).
    expect(calls).toEqual([{ revision: 3 }, { revision: 4 }]);
  });

  it("a REFUSED save is reported once and never retried — a retry would DELETE the other window", () => {
    const { store } = makeGuardedStore();
    const onConflict = vi.fn();
    const history = new PersistentChatHistory(store, "sess-1", undefined, onConflict);
    history.adopt(summary(3));
    (store as unknown as { refuse: () => void }).refuse();

    history.add(msg({ content: "mine" })); // refused
    history.add(msg({ role: "assistant", content: "still mine", timestamp: 2 }));
    history.addGroup([msg({ role: "user", content: "and this", timestamp: 3 })]);

    expect(onConflict).toHaveBeenCalledTimes(1);
    expect(onConflict.mock.calls[0][0]).toBeInstanceOf(SessionConflictError);
    // ONE write attempt total: the two later saves did not even reach the store. Retrying with
    // the new token would `replace` the transcript the refusal just protected.
    expect(store.saveMessages).toHaveBeenCalledTimes(1);
    expect(history.conflicted).toBe(true);
    // Nothing is lost from the screen: the refused messages are still there.
    expect(history.all().map((m) => m.content)).toEqual(["mine", "still mine", "and this"]);
  });

  it("reopening the session (adopt) releases the block, with the stored token", () => {
    const { store, calls } = makeGuardedStore();
    const history = new PersistentChatHistory(store, "sess-1");
    history.adopt(summary(3));
    (store as unknown as { refuse: () => void }).refuse();
    history.add(msg({ content: "refused" }));
    expect(history.conflicted).toBe(true);

    // What a re-open does: the transcript comes from disk, and so does the token — 4, because the
    // other window's write bumped it (the mock's refusal moved the stored revision from 3 to 4).
    history.replace([msg({ content: "stored" })]);
    history.adopt(summary(4));
    history.add(msg({ content: "after" }));

    expect(history.conflicted).toBe(false);
    expect(calls).toEqual([{ revision: 3 }, { revision: 4 }]);
  });

  it("a NON-conflict failure still travels (a busy database is not a lost session)", () => {
    const store = makeStore();
    (store.saveMessages as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error("database is locked");
    });
    const history = new PersistentChatHistory(store, "sess-1", undefined, vi.fn());

    // Swallowing it would hide a disk problem behind a concurrency story, and a retryable busy
    // would become a permanent block.
    expect(() => history.add(msg({ content: "a" }))).toThrow(/database is locked/);
    expect(history.conflicted).toBe(false);
  });
});
