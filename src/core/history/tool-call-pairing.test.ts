import { describe, it, expect } from "vitest";
import { describePairingViolations, toolCallPairingViolations, turnEnd, turnStart } from "./tool-call-pairing";
import type { ChatMessage } from "./types";

const user = (content = "u"): ChatMessage => ({ role: "user", content, timestamp: 1 });
const answer = (content = "a"): ChatMessage => ({ role: "assistant", content, timestamp: 2 });
const call = (content: string, ...ids: string[]): ChatMessage => ({
  role: "assistant",
  content,
  toolCalls: ids.map((id) => ({ id, name: "Shell", arguments: {} })),
  timestamp: 2,
});
const result = (toolCallId: string, content = "out"): ChatMessage => ({ role: "tool", content, toolCallId, timestamp: 3 });

describe("toolCallPairingViolations", () => {
  it("accepts a call answered by the tool messages right after it", () => {
    expect(toolCallPairingViolations([user(), call("", "c1"), result("c1"), answer()])).toEqual([]);
  });

  it("accepts a batch answered by several results, in any order", () => {
    expect(
      toolCallPairingViolations([user(), call("", "c1", "c2"), result("c2"), result("c1"), answer()]),
    ).toEqual([]);
  });

  it("flags a call whose results never arrive", () => {
    // The wedged-session shape: the results are missing (or came later).
    const v = toolCallPairingViolations([user(), call("", "c1"), answer("interrupted")]);
    expect(v).toEqual([{ index: 1, kind: "missing_results", ids: ["c1"] }]);
    expect(describePairingViolations(v)).toContain("#1");
    expect(describePairingViolations(v)).toContain("c1");
  });

  it("flags a result that arrives AFTER another message (the Stop interposition)", () => {
    // What the host used to write: the notice lands between the call and the
    // results, so the results are no longer the contiguous run that follows.
    const v = toolCallPairingViolations([user(), call("", "c1"), answer("❌ ⏹ Processing interrupted."), result("c1")]);
    expect(v.map((x) => x.kind)).toEqual(["missing_results", "orphan_tool_result"]);
  });

  it("IGNORES a uiOnly message sitting in the middle (it is never sent)", () => {
    const notice: ChatMessage = { role: "assistant", content: "❌ ⏹ Processing interrupted.", timestamp: 3, uiOnly: true };
    expect(toolCallPairingViolations([user(), call("", "c1"), notice, result("c1"), answer()])).toEqual([]);
  });

  it("flags an orphan result with no call above it", () => {
    expect(toolCallPairingViolations([user(), result("c1")])).toEqual([
      { index: 1, kind: "orphan_tool_result", ids: ["c1"] },
    ]);
  });

  it("flags a result that does not belong to the call above it", () => {
    const v = toolCallPairingViolations([user(), call("", "c1"), result("c2")]);
    expect(v.map((x) => x.kind)).toEqual(["missing_results", "orphan_tool_result"]);
  });

  it("accepts a conversation with no tools at all", () => {
    expect(toolCallPairingViolations([user(), answer()])).toEqual([]);
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
      expect(toolCallPairingViolations(copy)).toEqual([]);
      // …and it ends on a final answer, not mid-turn.
      const last = copy[copy.length - 1];
      expect(last.role).not.toBe("tool");
      expect(copy.length === transcript.length || last.role === "assistant").toBe(true);
    }
  });
});
