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
