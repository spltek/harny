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
