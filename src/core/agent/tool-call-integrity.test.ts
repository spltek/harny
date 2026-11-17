import { describe, it, expect } from "vitest";
import type { ToolCall } from "../tools/tool";
import { argumentIntegrityRefusal, markTruncatedCalls } from "./tool-call-integrity";

const call = (extra: Partial<ToolCall> = {}): ToolCall => ({
  id: "c1",
  name: "Write",
  arguments: { path: "a.txt", contents: "hi" },
  ...extra,
});

describe("markTruncatedCalls — the fact is stamped on the CALL, only when the turn was cut", () => {
  it("stamps every call of a turn cut by the output-token limit", () => {
    const calls = [call(), call({ id: "c2", name: "Read" })];

    const marked = markTruncatedCalls(calls, "length");

    expect(marked.map((c) => c.truncated)).toEqual([true, true]);
    // …without losing anything else the call carried
    expect(marked[1]).toMatchObject({ id: "c2", name: "Read", arguments: { path: "a.txt", contents: "hi" } });
  });

  it("returns the SAME array when the turn was not cut (no copy on the normal path)", () => {
    const calls = [call()];

    // "stop" (normal end), "tool_calls" (Anthropic's name for it), undefined (a mock that omits it)
    for (const reason of ["stop", "tool_calls", undefined, ""]) {
      const marked = markTruncatedCalls(calls, reason);
      expect(marked).toBe(calls);
      expect(marked[0]).toBe(calls[0]);
      expect(marked[0].truncated).toBeUndefined();
    }
  });

  it("does not touch a turn with no tool calls", () => {
    const empty: ToolCall[] = [];
    expect(markTruncatedCalls(empty, "length")).toBe(empty);
  });

  it("is pure: the input array is never mutated", () => {
    const calls = [call()];

    markTruncatedCalls(calls, "length");

    expect(calls[0].truncated).toBeUndefined();
  });

  it("keeps a pre-existing flag of its own (malformed/repaired survive the stamp)", () => {
    const calls = [call({ malformed: true, repaired: false })];

    const [marked] = markTruncatedCalls(calls, "length");

    expect(marked).toMatchObject({ truncated: true, malformed: true, repaired: false });
  });
});

describe("argumentIntegrityRefusal — a cut argument never runs", () => {
  it("refuses a REBUILT fragment on a cut turn (the dangerous case: half a Write)", () => {
    const refusal = argumentIntegrityRefusal(call({ truncated: true, repaired: true, malformed: false }));

    expect(refusal).toBeDefined();
    expect(refusal).toContain("Write"); // the model must know WHICH call it is
    expect(refusal).toContain("output-token limit");
    expect(refusal).toContain("rebuilt from an incomplete fragment"); // the actual diagnosis
    expect(refusal).toContain("Re-emit this call with the COMPLETE arguments"); // and what to do
  });

  it("refuses a call of a cut turn that is not even parseable", () => {
    const refusal = argumentIntegrityRefusal(call({ truncated: true, malformed: true }));

    expect(refusal).toContain("nothing parseable arrived");
  });

  it("ALLOWS a cut turn whose arguments closed before the cut (complete call)", () => {
    // The stream was stopped, but the JSON object was already complete: the call is whole, and
    // refusing it would cost a turn for nothing.
    expect(argumentIntegrityRefusal(call({ truncated: true, repaired: false, malformed: false }))).toBeUndefined();
    expect(argumentIntegrityRefusal(call({ truncated: true }))).toBeUndefined();
  });

  it("ALLOWS a repaired call when the turn was NOT cut (sloppy JSON is tolerated)", () => {
    // This is the regression guard for the whole feature: repairing fenced/sloppy JSON on healthy
    // turns is deliberate, and must keep working.
    expect(argumentIntegrityRefusal(call({ repaired: true }))).toBeUndefined();
    expect(argumentIntegrityRefusal(call({ malformed: true }))).toBeUndefined(); // the agent's own branch
    expect(argumentIntegrityRefusal(call())).toBeUndefined();
  });

  it("does not depend on WHICH tool it is (no allowlist to keep)", () => {
    for (const name of ["Write", "Edit", "StrReplace", "Delete", "Shell", "Delegate", "Read", "Grep"]) {
      expect(argumentIntegrityRefusal(call({ name, truncated: true, repaired: true }))).toContain(`Tool ${name}:`);
    }
  });

  it("is deterministic and self-contained (same input, same text — it is the model's only channel)", () => {
    const input = call({ truncated: true, malformed: true });
    expect(argumentIntegrityRefusal(input)).toBe(argumentIntegrityRefusal(input));
    expect(argumentIntegrityRefusal(input)?.endsWith("smaller steps.")).toBe(true);
  });

  it("names the cause once: malformed wins over repaired when both are true", () => {
    // A call cannot really be both (the ladder returns one or the other), but a hand-built object
    // can: the message must still be singular and honest.
    const refusal = argumentIntegrityRefusal(call({ truncated: true, malformed: true, repaired: true }));
    expect(refusal).toContain("nothing parseable arrived");
    expect(refusal).not.toContain("rebuilt from an incomplete fragment");
  });
});
