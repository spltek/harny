import { describe, it, expect, vi } from "vitest";
import { PersistentChatHistory } from "./persistent-chat-history";
import type { SessionStore } from "../sessions/types";
import type { ChatMessage } from "./types";

function msg(partial: Partial<ChatMessage>): ChatMessage {
  return { role: "user", content: "", timestamp: 1, ...partial };
}

function makeStore(): SessionStore {
  return {
    list: vi.fn(() => []),
    create: vi.fn(),
    load: vi.fn(),
    saveMessages: vi.fn((id: string, messages: ChatMessage[]) => ({ id, name: "S", createdAt: 1, updatedAt: 2, messageCount: messages.length })),
    rename: vi.fn(),
    remove: vi.fn(),
  } as unknown as SessionStore;
}

describe("PersistentChatHistory", () => {
  it("autosaves to its bound session id on add", () => {
    const store = makeStore();
    const history = new PersistentChatHistory(store, "sess-1");

    history.add(msg({ content: "a" }));

    expect(store.saveMessages).toHaveBeenCalledWith("sess-1", [expect.objectContaining({ content: "a" })]);
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
    expect(store.saveMessages).toHaveBeenCalledWith("sess-1", [
      expect.objectContaining({ role: "user", content: "go" }),
      expect.objectContaining({ role: "assistant", toolCalls: [{ id: "c1", name: "Shell", arguments: {} }] }),
      expect.objectContaining({ role: "tool", toolCallId: "c1" }),
    ]);
    expect(history.all()).toHaveLength(3);
  });

  it("addGroup with nothing to add does not touch the store", () => {
    const store = makeStore();
    const history = new PersistentChatHistory(store, "sess-1");
    history.addGroup([]);
    expect(store.saveMessages).not.toHaveBeenCalled();
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
