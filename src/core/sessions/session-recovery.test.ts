import { describe, it, expect } from "vitest";
import { parseStoredRows, recoverSession, trimInvalidTail } from "./session-recovery";
import type { ChatMessage } from "../history/types";

const user = (content: string): ChatMessage => ({ role: "user", content, timestamp: 1 });
const assistant = (content: string, toolCalls?: { id: string; name: string; arguments: string }[]): ChatMessage => ({
  role: "assistant",
  content,
  timestamp: 2,
  ...(toolCalls ? { toolCalls } : {}),
});
const toolResult = (id: string, content = "ok"): ChatMessage =>
  ({
    role: "tool",
    content,
    timestamp: 3,
    toolCallId: id,
  }) as ChatMessage;

const rows = (messages: ChatMessage[]): string[] => messages.map((m) => JSON.stringify(m));
const call = (id: string) => [{ id, name: "read_file", arguments: "{}" }];

describe("parseStoredRows — one unreadable row must not cost the whole session", () => {
  it("returns every message when every row parses", () => {
    const stored = [user("hi"), assistant("hello")];
    expect(parseStoredRows(rows(stored))).toEqual({ messages: stored, dropped: 0 });
  });

  it("KEEPS the head and drops the bad row plus everything after it", () => {
    // A log is ordered: the rows past the damage cannot be trusted to belong to the
    // same conversation (and `seq` would have a hole the append path reads as a prefix).
    const head = [user("a"), assistant("b")];
    const result = parseStoredRows([...rows(head), "{not json", JSON.stringify(user("c"))]);
    expect(result.messages).toEqual(head);
    expect(result.dropped).toBe(2);
    expect(result.reason).toBe("unreadable");
  });

  it("a row that parses but is NOT a message counts as damage", () => {
    // A build that stored another shape, or a hand-edited row: `{}` would reach the
    // request builder as a message with no role.
    const result = parseStoredRows([JSON.stringify(user("a")), "{}", JSON.stringify(user("b"))]);
    expect(result.messages).toEqual([user("a")]);
    expect(result.reason).toBe("unreadable");
    expect(result.dropped).toBe(2);
  });

  it("rejects a row whose role is an empty string (the one thing every consumer assumes)", () => {
    const result = parseStoredRows([JSON.stringify({ role: "", content: "x" })]);
    expect(result).toMatchObject({ messages: [], dropped: 1, reason: "unreadable" });
  });

  it("rejects a role that is not a STRING (`{role: 5}` is not a message either)", () => {
    const result = parseStoredRows([JSON.stringify({ role: 5, content: "x" })]);
    expect(result).toMatchObject({ messages: [], dropped: 1, reason: "unreadable" });
  });

  it("a row holding `null` or a bare number is damage, not a crash", () => {
    // The shapes `JSON.parse` happily returns and no producer of ours writes. Reading
    // `.role` off `null` would throw out of `load()` — the very failure this module
    // exists to prevent — so they must be rejected the quiet way.
    expect(parseStoredRows(["null"])).toMatchObject({ messages: [], dropped: 1, reason: "unreadable" });
    expect(parseStoredRows(["42"])).toMatchObject({ messages: [], dropped: 1, reason: "unreadable" });
  });

  it("an EMPTY session is not damage", () => {
    expect(parseStoredRows([])).toEqual({ messages: [], dropped: 0 });
  });
});

describe("trimInvalidTail — only a broken PAIRING is worth a cut", () => {
  it("leaves a sound conversation untouched, tool pairs included", () => {
    const sound = [user("read it"), assistant("", call("t1")), toolResult("t1"), assistant("done")];
    expect(trimInvalidTail(sound)).toEqual({ messages: sound, dropped: 0 });
  });

  it("cuts the tail whose tool CALL has no results — the truncated-turn shape", () => {
    // What a half-written turn would look like if a group could ever be split (the
    // store's transaction is what prevents it): the provider refuses the sequence, so
    // the session would be wedged forever instead of merely short. The PROMPT of that
    // turn survives: it is the only part of it the user wrote, and a conversation
    // ending with a user message is one waiting for its answer.
    const stored = [user("a"), assistant("", call("t1")), toolResult("t1"), user("b"), assistant("", call("t2"))];
    const result = trimInvalidTail(stored);
    expect(result.messages).toEqual([user("a"), assistant("", call("t1")), toolResult("t1"), user("b")]);
    expect(result.dropped).toBe(1);
    expect(result.reason).toBe("invalid_tail");
  });

  it("cuts an ORPHAN tool result (its call is gone) and nothing else", () => {
    const stored = [user("a"), assistant("b"), user("c"), toolResult("ghost")];
    const result = trimInvalidTail(stored);
    expect(result.messages).toEqual([user("a"), assistant("b"), user("c")]);
    expect(result.dropped).toBe(1);
  });

  it("cuts a tool result with NO id (the wire cannot pair it)", () => {
    const stored = [user("a"), assistant("b"), { role: "tool", content: "x", timestamp: 3 } as ChatMessage];
    expect(trimInvalidTail(stored).messages).toEqual([user("a"), assistant("b")]);
  });

  it("drops the UI-ONLY rows that sat AFTER the damage, and keeps the ones before", () => {
    // `uiOnly` messages (interrupt notes, compaction cards) are never sent, so the rules
    // do not see them — but they are on screen. A note that came after the damaged
    // message describes something the log no longer has.
    const stored: ChatMessage[] = [
      user("a"),
      { role: "assistant", content: "⏹ interrupted", timestamp: 2, uiOnly: true },
      assistant("b"),
      user("c"),
      { role: "assistant", content: "⏹ interrupted", timestamp: 4, uiOnly: true },
      assistant("", call("t9")),
    ];
    const result = trimInvalidTail(stored);
    expect(result.messages).toEqual([
      user("a"),
      { role: "assistant", content: "⏹ interrupted", timestamp: 2, uiOnly: true },
      assistant("b"),
      user("c"),
      { role: "assistant", content: "⏹ interrupted", timestamp: 4, uiOnly: true },
    ]);
    expect(result.dropped).toBe(1);
  });

  it("does NOT cut for a CONTENT fault: an empty tool result is a refusal, not a truncation", () => {
    // The request guard names it ("empty_tool_result") and the user can see what to fix.
    // Cutting here would delete a whole turn of real work over a cosmetic rule.
    const stored = [user("a"), assistant("", call("t1")), toolResult("t1", ""), assistant("b")];
    expect(trimInvalidTail(stored)).toEqual({ messages: stored, dropped: 0 });
  });

  it("does NOT cut a session that starts with an assistant (a different, reported fault)", () => {
    const stored = [assistant("no user before me"), user("a")];
    expect(trimInvalidTail(stored)).toEqual({ messages: stored, dropped: 0 });
  });

  it("a UI-ONLY row is invisible even when IT is the broken one", () => {
    // Interrupt notes are never sent, so a dangling call inside one is not a fault the
    // wire can see — and cutting for it would cost real turns that came after it.
    const stored: ChatMessage[] = [
      user("a"),
      { role: "assistant", content: "⏹ interrupted", timestamp: 2, uiOnly: true, toolCalls: call("t1") } as ChatMessage,
      user("b"),
      assistant("c"),
    ];
    expect(trimInvalidTail(stored)).toEqual({ messages: stored, dropped: 0 });
  });

  it("can empty a session when the FIRST turn is the broken one (no valid head to keep)", () => {
    const stored = [assistant("", call("t1"))];
    const result = trimInvalidTail(stored);
    expect(result.messages).toEqual([]);
    expect(result.dropped).toBe(1);
    expect(result.reason).toBe("invalid_tail");
  });

  it("is DETERMINISTIC: the already-trimmed result is not trimmed again", () => {
    // The panel loads the trimmed array and saves it back: an idempotent salvage means
    // the second load costs nothing and reports nothing.
    const stored = [user("a"), assistant("b"), user("c"), assistant("", call("t2"))];
    const once = trimInvalidTail(stored);
    expect(trimInvalidTail(once.messages)).toEqual({ messages: once.messages, dropped: 0 });
  });
});

describe("recoverSession — parse first, then the rules", () => {
  it("reports `unreadable` before it looks at the rules (a missing middle changes what dangles)", () => {
    const result = recoverSession([JSON.stringify(user("a")), "garbage"]);
    expect(result).toMatchObject({ dropped: 1, reason: "unreadable" });
  });

  it("`unreadable` WINS over the rules, even when the salvaged head is also broken", () => {
    // Both are true here. The row that would not parse is the news: the head's dangling
    // call is a CONSEQUENCE of it (the result lived in the rows that went), so blaming
    // the tail would send whoever reads the notice looking for damage that is elsewhere.
    const result = recoverSession([JSON.stringify(assistant("", call("t1"))), "garbage"]);
    expect(result).toMatchObject({ messages: [], dropped: 2, reason: "unreadable" });
  });

  it("reports `invalid_tail` when every row parsed but the pairs are broken", () => {
    const result = recoverSession(rows([user("a"), assistant("", call("t1"))]));
    expect(result).toMatchObject({ dropped: 1, reason: "invalid_tail" });
  });

  it("a sound session comes back with dropped: 0 and NO reason (the common case costs nothing)", () => {
    const stored = [user("a"), assistant("", call("t1")), toolResult("t1"), assistant("b")];
    expect(recoverSession(rows(stored))).toEqual({ messages: stored, dropped: 0 });
  });
});
