import { describe, it, expect } from "vitest";
import { cutAfterTurn, describePairingViolations, snapTailStart, toolCallPairingViolations } from "./tool-call-pairing";
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

describe("cutAfterTurn (⎇ branch: 'up to and including this reply')", () => {
  it("includes the results of the tools the reply called", () => {
    const messages = [user(), call("preamble", "c1"), result("c1"), answer("final")];
    // The reply at #1 carries text AND a tool call: copying up to #1 alone would
    // leave the call unanswered, so the copy must reach past its result.
    expect(cutAfterTurn(messages, 1)).toBe(3);
  });

  it("includes a whole batch", () => {
    const messages = [user(), call("", "c1", "c2"), result("c1"), result("c2"), answer()];
    expect(cutAfterTurn(messages, 1)).toBe(4);
  });

  it("keeps the plain behaviour for a reply with no tool calls", () => {
    expect(cutAfterTurn([user(), answer()], 1)).toBe(2);
  });

  it("drops the turn entirely when its results are NOT there (never propagates damage)", () => {
    // A branch of an already-damaged history must not carry the damage over: the
    // call is left out, so the copy still starts from a valid point.
    const messages = [user(), call("", "c1"), answer("interrupted")];
    expect(cutAfterTurn(messages, 1)).toBe(1);
  });

  it("falls back to index+1 for a cut that is not an assistant message", () => {
    expect(cutAfterTurn([user(), result("c1")], 0)).toBe(1);
    expect(cutAfterTurn([], 0)).toBe(1);
  });

  it("a branch cut with it always yields a valid conversation", () => {
    const messages = [user(), answer("hi"), user(), call("working", "c1"), result("c1"), answer("done")];
    for (let i = 0; i < messages.length; i++) {
      expect(toolCallPairingViolations(messages.slice(0, cutAfterTurn(messages, i)))).toEqual([]);
    }
  });
});

describe("snapTailStart (compaction: the kept tail must start at a turn boundary)", () => {
  it("moves the boundary back to the call that owns the results", () => {
    const messages = [user(), call("", "c1"), result("c1"), answer("final")];
    // The naive boundary (#2) would leave a tool result with no call above it.
    expect(snapTailStart(messages, 2)).toBe(1);
  });

  it("moves back past a whole batch", () => {
    const messages = [user(), call("", "c1", "c2"), result("c1"), result("c2"), answer()];
    expect(snapTailStart(messages, 3)).toBe(1);
    expect(snapTailStart(messages, 2)).toBe(1);
  });

  it("leaves a boundary that is already safe untouched", () => {
    const messages = [user(), call("", "c1"), result("c1"), answer()];
    expect(snapTailStart(messages, 3)).toBe(3);
    expect(snapTailStart(messages, 0)).toBe(0);
    expect(snapTailStart(messages, messages.length)).toBe(messages.length);
  });

  it("clamps an out-of-range index instead of returning nonsense", () => {
    const messages = [user(), answer()];
    expect(snapTailStart(messages, 99)).toBe(2);
    expect(snapTailStart(messages, -3)).toBe(0);
  });
});
