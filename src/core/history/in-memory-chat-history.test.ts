import { describe, it, expect } from "vitest";
import { InMemoryChatHistory } from "./in-memory-chat-history";
import type { ChatMessage } from "./types";

function msg(partial: Partial<ChatMessage>): ChatMessage {
  return { role: "user", content: "", timestamp: 1, ...partial };
}

describe("InMemoryChatHistory", () => {
  it("stores and returns all messages", () => {
    const history = new InMemoryChatHistory();
    history.add(msg({ role: "user", content: "hello" }));
    history.add(msg({ role: "assistant", content: "hi" }));

    expect(history.all()).toHaveLength(2);
    expect(history.all()[0].content).toBe("hello");
  });

  it("returns copies so callers cannot mutate internal state", () => {
    const history = new InMemoryChatHistory();
    history.add(msg({ content: "a" }));

    history.all().push(msg({ content: "b" }));

    expect(history.all()).toHaveLength(1);
  });

  it("includes system (summary) and excludes uiOnly messages from conversation()", () => {
    const history = new InMemoryChatHistory();
    history.add(msg({ role: "system", content: "sys" }));
    history.add(msg({ role: "user", content: "u" }));
    history.add(msg({ role: "assistant", content: "a", uiOnly: true }));

    const conversation = history.conversation();
    expect(conversation.map((m) => m.role)).toEqual(["system", "user"]);
  });
});

describe("InMemoryChatHistory — the summary checkpoint sets where the window starts", () => {
  it("conversation() starts AT the checkpoint; the past stays stored and readable", () => {
    const history = new InMemoryChatHistory();
    history.add(msg({ role: "user", content: "old" }));
    history.add(msg({ role: "assistant", content: "old answer" }));
    history.add(msg({ role: "user", content: "Summary", synthetic: true }));
    history.add(msg({ role: "assistant", content: "## Goal …", synthetic: true }));
    history.add(msg({ role: "user", content: "new" }));

    // The window BEGINS at the checkpoint — the past is not sent...
    expect(history.conversation().map((m) => m.content)).toEqual(["Summary", "## Goal …", "new"]);
    // ...but it is still there: not deleted, only out of the window.
    expect(history.all()).toHaveLength(5);
  });

  it("conversation() is the whole history while no checkpoint exists", () => {
    const history = new InMemoryChatHistory();
    history.add(msg({ role: "user", content: "u" }));
    history.add(msg({ role: "assistant", content: "a" }));

    expect(history.conversation().map((m) => m.content)).toEqual(["u", "a"]);
  });

  it("the NEWEST checkpoint wins (older ones are folded into it)", () => {
    const history = new InMemoryChatHistory();
    history.add(msg({ role: "user", content: "antichissimo" }));
    history.add(msg({ role: "user", content: "Old summary", synthetic: true }));
    history.add(msg({ role: "assistant", content: "old state", synthetic: true }));
    history.add(msg({ role: "user", content: "in mezzo" }));
    history.add(msg({ role: "user", content: "Summary", synthetic: true }));
    history.add(msg({ role: "assistant", content: "new state", synthetic: true }));
    history.add(msg({ role: "user", content: "last" }));

    expect(history.conversation().map((m) => m.content)).toEqual(["Summary", "new state", "last"]);
    expect(history.all()).toHaveLength(7);
  });

  it("a ✂ cut that removes the checkpoint leaves the surviving past as the window", () => {
    // The cut is physical: it deletes the checkpoint with the rest of the tail.
    // With no marker left, the window restarts from what survived — that is
    // "go back to before that compaction", not a leak.
    const history = new InMemoryChatHistory();
    history.add(msg({ role: "user", content: "before compaction" }));

    expect(history.conversation().map((m) => m.content)).toEqual(["before compaction"]);
  });
});
