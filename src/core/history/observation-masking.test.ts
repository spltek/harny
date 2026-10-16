import { describe, it, expect } from "vitest";
import { MASK_KEEP_MAX_TOKENS, MASK_MIN_TOKENS, maskKeepTokens, maskOldToolResults, maskedResultStub } from "./observation-masking";
import type { PairingMessage } from "./conversation-validity";
import { conversationFaults } from "./conversation-validity";

/** The real estimator (chars/4 on ASCII): the module takes it as a parameter so
 * it stays independent of where the number comes from. */
const estimate = (t: string): number => Math.ceil(t.length / 4);

const user = (content: string): PairingMessage => ({ role: "user", content });
const call = (id: string, name: string): PairingMessage => ({ role: "assistant", content: "", toolCalls: [{ id, name }] });
const result = (id: string, content: string): PairingMessage => ({ role: "tool", content, toolCallId: id });

/** A tool result of about `tokens` tokens. */
const output = (tokens: number): string => "x".repeat(tokens * 4);

describe("maskKeepTokens — a share of the window, bounded (cross-model)", () => {
  it("scales with the window, so a small model masks earlier than a large one", () => {
    // 20% of the usable window, with bounds that scale too.
    expect(maskKeepTokens(1_000_000)).toBe(MASK_KEEP_MAX_TOKENS);
    expect(maskKeepTokens(600_000)).toBe(120_000);
    expect(maskKeepTokens(100_000)).toBe(20_000);
    expect(maskKeepTokens(32_000)).toBe(8_000);
    // A tiny window must not reserve more than it has.
    expect(maskKeepTokens(8_000)).toBe(2_000);
    expect(maskKeepTokens(0)).toBe(0);
  });
});

describe("maskOldToolResults — the newest output stays, the rest becomes a stub", () => {
  it("keeps the newest results verbatim and masks the older ones", () => {
    const messages = [
      user("go"),
      call("c1", "Read"),
      result("c1", output(2000)), // old: ~2000 tokens
      call("c2", "Shell"),
      result("c2", output(2000)),
      call("c3", "Grep"),
      result("c3", output(2000)), // newest
    ];
    const { messages: out, masked, savedTokens } = maskOldToolResults(messages, 2500, estimate);

    // Only the newest fits the budget: the two older ones are stubbed.
    expect(masked).toBe(2);
    expect(String(out[2].content)).toContain("masked to save context");
    expect(String(out[4].content)).toContain("masked to save context");
    expect(String(out[6].content)).toBe(output(2000));
    // The stub NAMES the tool, so the model can decide whether to re-run it.
    expect(String(out[2].content)).toContain("Read output");
    expect(String(out[4].content)).toContain("Shell output");
    expect(savedTokens).toBeGreaterThan(3000);
  });

  it("leaves a conversation that fits the budget completely untouched", () => {
    const messages = [user("go"), call("c1", "Read"), result("c1", output(1000))];
    const { messages: out, masked } = maskOldToolResults(messages, 20_000, estimate);
    expect(masked).toBe(0);
    expect(out).toEqual(messages);
    // …and it does not even copy the array elements (nothing to do).
    expect(out[2]).toBe(messages[2]);
  });

  it("does not bother masking small results (the stub would cost as much)", () => {
    const messages = [
      user("go"),
      call("c1", "Shell"),
      result("c1", output(100)), // ~100 tokens: below MASK_MIN_TOKENS
      call("c2", "Read"),
      result("c2", output(5000)),
    ];
    const { messages: out, masked } = maskOldToolResults(messages, 1000, estimate);
    expect(masked).toBe(0);
    expect(String(out[2].content)).toBe(output(100));
  });

  it("never touches the STORED history (returns a new view)", () => {
    const messages = [
      user("go"),
      call("c1", "Read"),
      result("c1", output(4000)),
      call("c2", "Shell"),
      result("c2", output(4000)),
    ];
    const before = JSON.stringify(messages);
    const { messages: out } = maskOldToolResults(messages, 10, estimate);

    expect(String(out[2].content)).toContain("masked"); // the OLD one, in the view
    expect(String(messages[2].content)).toBe(output(4000)); // the store is intact
    expect(JSON.stringify(messages)).toBe(before);
  });

  it("only rewrites tool content: the wire rules cannot be affected", () => {
    const messages = [
      user("go"),
      call("c1", "Read"),
      result("c1", output(4000)),
      { role: "assistant" as const, content: "done" },
    ];
    const { messages: out } = maskOldToolResults(messages, 10, estimate);
    // Same roles, same ids, same order: only the text changed.
    expect(out.map((m) => m.role)).toEqual(messages.map((m) => m.role));
    expect(out.map((m) => m.toolCallId)).toEqual(messages.map((m) => m.toolCallId));
    expect(conversationFaults(out as never)).toEqual([]);
  });

  it("a stub is never empty and never looks like an error to the model", () => {
    const stub = maskedResultStub("Shell", 12_400);
    expect(stub).toContain("Shell");
    expect(stub).toContain("12");
    expect(stub.trim().length).toBeGreaterThan(20);
    // Unknown tool name (e.g. an id we never saw): still a valid stub.
    expect(maskedResultStub(undefined, 500)).toContain("Tool output");
  });

  it("respects the budget when the newest result alone exceeds it", () => {
    // One huge result: it cannot fit, but it IS the newest, so it stays (masking
    // the thing the model just asked for would defeat the point).
    const messages = [user("go"), call("c1", "Read"), result("c1", output(9000))];
    const { masked } = maskOldToolResults(messages, 100, estimate);
    expect(masked).toBe(0);
  });

  it("is model-NEUTRAL: the same history masks earlier on a small window", () => {
    const messages = [
      user("go"),
      call("c1", "Read"),
      result("c1", output(9000)),
      call("c2", "Shell"),
      result("c2", output(9000)),
    ];
    // A 32k model: budget 8k → the FIRST result no longer fits.
    expect(maskOldToolResults(messages, maskKeepTokens(32_000), estimate).masked).toBe(1);
    // A 1M model: budget 120k → both fit, nothing is masked.
    expect(maskOldToolResults(messages, maskKeepTokens(1_000_000), estimate).masked).toBe(0);
  });
});

describe("MASK_MIN_TOKENS", () => {
  it("is a floor on the size worth stubbing", () => {
    expect(MASK_MIN_TOKENS).toBeGreaterThan(0);
    expect(MASK_MIN_TOKENS).toBeLessThan(1000);
  });
});
