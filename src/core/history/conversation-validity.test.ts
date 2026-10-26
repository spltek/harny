import { describe, it, expect } from "vitest";
import { checkpointStart, describeFaults, conversationFaults, turnEnd, turnStart } from "./conversation-validity";
import type { ChatMessage } from "./types";

const user = (content = "u"): ChatMessage => ({ role: "user", content, timestamp: 1 });
const answer = (content = "a"): ChatMessage => ({ role: "assistant", content, timestamp: 2 });
const call = (content: string, ...ids: string[]): ChatMessage => ({
  role: "assistant",
  content,
  toolCalls: ids.map((id) => ({ id, name: "Shell", arguments: {} })),
  timestamp: 2,
});
const result = (toolCallId: string, content = "out"): ChatMessage => ({
  role: "tool",
  content,
  toolCallId,
  timestamp: 3,
});

describe("conversationFaults", () => {
  it("accepts a call answered by the tool messages right after it", () => {
    expect(conversationFaults([user(), call("", "c1"), result("c1"), answer()])).toEqual([]);
  });

  it("accepts a batch answered by several results, in any order", () => {
    expect(conversationFaults([user(), call("", "c1", "c2"), result("c2"), result("c1"), answer()])).toEqual([]);
  });

  it("flags a call whose results never arrive", () => {
    // The wedged-session shape: the results are missing (or came later).
    const v = conversationFaults([user(), call("", "c1"), answer("interrupted")]);
    expect(v).toEqual([{ index: 1, kind: "missing_tool_results", ids: ["c1"] }]);
    expect(describeFaults(v)).toContain("#1");
    expect(describeFaults(v)).toContain("c1");
  });

  it("flags a result that arrives AFTER another message (the Stop interposition)", () => {
    // What the host used to write: the notice lands between the call and the
    // results, so the results are no longer the contiguous run that follows.
    const v = conversationFaults([user(), call("", "c1"), answer("❌ ⏹ Processing interrupted."), result("c1")]);
    expect(v.map((x) => x.kind)).toEqual(["missing_tool_results", "orphan_tool_result"]);
  });

  it("IGNORES a uiOnly message sitting in the middle (it is never sent)", () => {
    const notice: ChatMessage = {
      role: "assistant",
      content: "❌ ⏹ Processing interrupted.",
      timestamp: 3,
      uiOnly: true,
    };
    expect(conversationFaults([user(), call("", "c1"), notice, result("c1"), answer()])).toEqual([]);
  });

  it("flags an orphan result with no call above it", () => {
    expect(conversationFaults([user(), result("c1")])).toEqual([{ index: 1, kind: "orphan_tool_result", ids: ["c1"] }]);
  });

  it("flags a result that does not belong to the call above it", () => {
    const v = conversationFaults([user(), call("", "c1"), result("c2")]);
    expect(v.map((x) => x.kind)).toEqual(["missing_tool_results", "orphan_tool_result"]);
  });

  it("accepts a conversation with no tools at all", () => {
    expect(conversationFaults([user(), answer()])).toEqual([]);
  });

  // ── The rest of the rules: insurance against a producer that does not exist
  // yet (or a session stored by an older build). One case each. ──

  it("rule 3: a tool result without an id would reach the wire without tool_call_id", () => {
    const v = conversationFaults([user(), call("", "c1"), { role: "tool", content: "out", timestamp: 3 }]);
    expect(v.map((x) => x.kind)).toEqual(["missing_tool_results", "tool_result_without_id"]);
    expect(describeFaults(v)).toContain("without a tool_call_id");
  });

  it("rule 4: duplicate tool-call ids inside one turn (and answered twice)", () => {
    const twice = conversationFaults([user(), call("", "c1", "c1"), result("c1")]);
    expect(twice.some((x) => x.kind === "duplicate_tool_call_id")).toBe(true);
    // The same id answered twice is just as ambiguous.
    const answeredTwice = conversationFaults([user(), call("", "c1"), result("c1"), result("c1")]);
    expect(answeredTwice.some((x) => x.kind === "duplicate_tool_call_id")).toBe(true);
  });

  it("rule 5: a blank tool result (strict servers reject it, and it says nothing)", () => {
    expect(conversationFaults([user(), call("", "c1"), result("c1", "")])).toEqual([
      { index: 2, kind: "empty_tool_result", ids: ["c1"] },
    ]);
    // Whitespace only is just as blank.
    expect(conversationFaults([user(), call("", "c1"), result("c1", "  \n ")])).toHaveLength(1);
  });

  it("rule 6: an assistant message with neither text nor tool calls", () => {
    expect(conversationFaults([user(), answer("")])).toEqual([{ index: 1, kind: "empty_assistant", ids: [] }]);
    expect(describeFaults(conversationFaults([user(), answer(" ")]))).toContain("no text and no tool calls");
    // A turn with tool calls and NO text is perfectly normal.
    expect(conversationFaults([user(), call("", "c1"), result("c1")])).toEqual([]);
  });

  it("rule 7: the conversation must open with the user's input", () => {
    expect(conversationFaults([answer("I'll start"), user()])).toEqual([
      { index: 0, kind: "conversation_starts_with_role", ids: ["assistant"] },
    ]);
    // A system head (the prompt/summary) is fine: the rule looks at the first
    // message that is not a system one.
    expect(conversationFaults([{ role: "system", content: "s" }, user(), answer()])).toEqual([]);
  });

  it("rule 8: attachments only on user messages", () => {
    const withImage: ChatMessage = {
      role: "assistant",
      content: "look",
      images: ["data:image/png;base64,x"],
      timestamp: 2,
    };
    expect(conversationFaults([user(), withImage])).toEqual([
      { index: 1, kind: "attachment_outside_user", ids: ["assistant"] },
    ]);
    const userImage: ChatMessage = { role: "user", content: "see", images: ["data:image/png;base64,x"], timestamp: 1 };
    expect(conversationFaults([userImage, answer()])).toEqual([]);
  });

  it("reports EVERY fault, not just the first (a session can be broken twice)", () => {
    const v = conversationFaults([answer(""), call("", "c1"), result("", "")]);
    expect(v.length).toBeGreaterThanOrEqual(3);
    expect(describeFaults(v).split("; ").length).toBe(v.length);
  });
});

describe("turnStart / turnEnd (every cut lands between whole turn groups)", () => {
  // u1 → a1(answer) | u2 → a2(preamble + call) → tool → a3(answer) | u3 → …
  const transcript = [
    user("q1"),
    answer("a1"),
    user("q2"),
    call("working", "c1"),
    result("c1"),
    answer("a3"),
    user("q3"),
  ];

  it("turnStart returns the INPUT that opens the group containing the index", () => {
    expect(turnStart(transcript, 0)).toBe(0); // the input itself
    expect(turnStart(transcript, 1)).toBe(0); // its final answer
    expect(turnStart(transcript, 4)).toBe(2); // a tool result → back to u2
    expect(turnStart(transcript, 5)).toBe(2); // the final answer of that turn
    expect(turnStart(transcript, 6)).toBe(6); // u3
  });

  it("turnStart falls back to 0 for a head with no input (synthetic summary)", () => {
    const head = [{ role: "system", content: "summary" } as ChatMessage, user("q"), answer()];
    expect(turnStart(head, 0)).toBe(0);
    expect(turnStart(head, 1)).toBe(1);
  });

  it("turnEnd returns the NEXT input: the group is copied whole, final answer included", () => {
    // Clicking ⎇ on the preamble (2) copies through a3 — the turn's final answer.
    expect(turnEnd(transcript, 2)).toBe(6);
    expect(turnEnd(transcript, 4)).toBe(6);
    expect(turnEnd(transcript, 5)).toBe(6);
    // The first turn is just u1 → a1.
    expect(turnEnd(transcript, 0)).toBe(2);
    expect(turnEnd(transcript, 1)).toBe(2);
  });

  it("turnEnd on the last group reaches the end of the conversation", () => {
    expect(turnEnd(transcript, 6)).toBe(transcript.length);
    expect(turnEnd([user(), answer()], 1)).toBe(2);
  });

  it("clamps out-of-range indexes instead of returning nonsense", () => {
    expect(turnStart(transcript, 99)).toBe(6);
    expect(turnStart(transcript, -5)).toBe(0);
    expect(turnEnd(transcript, 99)).toBe(transcript.length);
    expect(turnEnd([], 0)).toBe(0);
  });

  it("EVERY cut the branch can take yields a complete, replayable conversation", () => {
    for (let i = 0; i < transcript.length; i++) {
      const copy = transcript.slice(0, turnEnd(transcript, i));
      expect(conversationFaults(copy)).toEqual([]);
      // …and it ends on a final answer, not mid-turn.
      const last = copy[copy.length - 1];
      expect(last.role).not.toBe("tool");
      expect(copy.length === transcript.length || last.role === "assistant").toBe(true);
    }
  });
});

describe("checkpointStart — the ONE point the context window starts from", () => {
  // The pair a compaction leaves: a user LABEL and the assistant summary.
  const label = (content = "Summary of past interactions"): ChatMessage => ({
    role: "user",
    content,
    timestamp: 1,
    synthetic: true,
  });
  const state = (content = "## Goal\nx"): ChatMessage => ({
    role: "assistant",
    content,
    timestamp: 2,
    synthetic: true,
  });

  it("is 0 while no checkpoint exists (a session that never compacted)", () => {
    expect(checkpointStart([])).toBe(0);
    expect(checkpointStart([user("q"), answer("a")])).toBe(0);
  });

  it("returns the START of the pair, so the checkpoint itself stays IN the window", () => {
    expect(checkpointStart([label(), state(), user("q")])).toBe(0);
    expect(checkpointStart([user("old"), answer("old"), label(), state(), user("q")])).toBe(2);
  });

  it("prefers the NEWEST pair (the older ones are already folded into it)", () => {
    const msgs = [user("a"), label("L1"), state("S1"), user("b"), label("L2"), state("S2"), user("c")];
    expect(checkpointStart(msgs)).toBe(4);
  });

  it("accepts a LONE synthetic message as its own boundary", () => {
    // carriedState tolerates an assistant-only head; the boundary follows it
    // instead of looking for a label that is not there.
    expect(checkpointStart([{ role: "system", content: "s" }, state("head"), user("q")])).toBe(1);
    expect(checkpointStart([label(), user("q")])).toBe(0);
    expect(checkpointStart([user("old"), answer("old"), state("head"), user("q")])).toBe(2);
  });

  it("what it skips is REACHABLE in the full array — nothing is deleted", () => {
    const msgs = [user("past"), answer("past"), label(), state(), user("now")];
    const from = checkpointStart(msgs);
    expect(msgs.slice(from).map((m) => m.content)).toEqual(["Summary of past interactions", "## Goal\nx", "now"]);
    expect(msgs).toHaveLength(5); // the past is still there
  });

  it("walks past uiOnly and system messages without being confused by them", () => {
    const msgs: ChatMessage[] = [
      { role: "system", content: "sys", timestamp: 0, uiOnly: true },
      user("past"),
      label(),
      state(),
      user("now"),
    ];
    expect(checkpointStart(msgs)).toBe(2);
  });
});
