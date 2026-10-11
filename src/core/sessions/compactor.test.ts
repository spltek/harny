import { describe, it, expect, vi } from "vitest";
import { Compactor, DEFAULT_COMPACTION, estimateTokens, planManualCompaction, shouldCompact, serializeConversation, splitSummary, clampCompactionThresholdPercent, toCompactionThresholdPercent, estimateContextTokens, realWindowTokens } from "./compactor";
import type { LLMProviderFactory } from "../llm/types";
import type { HarnyConfig } from "../config/types";
import type { ChatMessage } from "../history/types";

const CONFIG: HarnyConfig = {
  provider: "openai",
  apiKey: "sk",
  baseUrl: "https://api.openai.com",
  model: "gpt-4o",
  maxTokens: 100,
  temperature: 0,
  contextFiles: true,
  autoApprove: false,
  autoOpen: false,
};

function u(content: string): ChatMessage {
  return { role: "user", content, timestamp: 1 };
}
function a(content: string): ChatMessage {
  return { role: "assistant", content, timestamp: 2 };
}

describe("shouldCompact", () => {
  it("triggers at the threshold % of the declared context window", () => {
    const s = DEFAULT_COMPACTION; // 80% of 200000 = 160000
    expect(shouldCompact(120000, 200000, s)).toBe(false);
    expect(shouldCompact(160001, 200000, s)).toBe(true);
  });

  it("respects a per-call threshold override", () => {
    expect(shouldCompact(50001, 100000, { ...DEFAULT_COMPACTION, thresholdPercent: 50 })).toBe(true);
    expect(shouldCompact(49999, 100000, { ...DEFAULT_COMPACTION, thresholdPercent: 50 })).toBe(false);
  });
});

describe("clampCompactionThresholdPercent", () => {
  it("clamps to 1–100 and rounds", () => {
    expect(clampCompactionThresholdPercent(0)).toBe(1);
    expect(clampCompactionThresholdPercent(-5)).toBe(1);
    expect(clampCompactionThresholdPercent(101)).toBe(100);
    expect(clampCompactionThresholdPercent(250)).toBe(100);
    expect(clampCompactionThresholdPercent(80.6)).toBe(81);
    expect(clampCompactionThresholdPercent(50.4)).toBe(50);
  });

  it("falls back to the default 80 on invalid input", () => {
    expect(clampCompactionThresholdPercent(Number.NaN)).toBe(80);
    expect(clampCompactionThresholdPercent(Number.POSITIVE_INFINITY)).toBe(80);
  });

  it("toCompactionThresholdPercent coerces JSON message values", () => {
    expect(toCompactionThresholdPercent(50)).toBe(50);
    expect(toCompactionThresholdPercent("50")).toBe(50);
    expect(toCompactionThresholdPercent("abc")).toBe(80);
    expect(toCompactionThresholdPercent(undefined)).toBe(80);
    expect(toCompactionThresholdPercent(300)).toBe(100);
  });
});

describe("estimateTokens", () => {
  it("approximates ~4 chars per token", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("aaaa  ")).toBe(2);
  });
});

describe("serializeConversation", () => {
  it("labels roles and truncates tool results", () => {
    const out = serializeConversation([u("hello"), a("ok"), { role: "tool", content: "x".repeat(5000), toolCallId: "c", timestamp: 3 }], 2000);
    expect(out).toContain("[User]: hello");
    expect(out).toContain("[Assistant]: ok");
    expect(out).toContain("[Tool result]: " + "x".repeat(2000));
    expect(out).toContain("(+3000 chars)");
  });
});

describe("Compactor", () => {
  function factoryWith(text: string): LLMProviderFactory {
    return {
      create: vi.fn(() => ({
        protocol: "chat" as const,
        async *stream() {
          yield { type: "text", content: text };
        },
      })),
    } as LLMProviderFactory;
  }

  it("returns the model summary text", async () => {
    const c = new Compactor(factoryWith("## Goal\nFix the bug"), () => CONFIG);
    const summary = await c.summarize([u("fix the bug")]);
    expect(summary).toContain("## Goal");
    expect(summary).toContain("Fix the bug");
  });

  it("falls back to a short goal when the model stays silent", async () => {
    const c = new Compactor(factoryWith("   "), () => CONFIG);
    const summary = await c.summarize([u("Refactor auth")]);
    expect(summary).toContain("## Goal");
    expect(summary).toContain("Refactor auth");
  });

  it("forwards the abort signal to the provider (Stop cancels the summary)", async () => {
    const seen: (AbortSignal | undefined)[] = [];
    const factory = {
      create: () => ({
        protocol: "chat" as const,
        async *stream(_m: unknown, signal?: AbortSignal) {
          seen.push(signal);
          yield { type: "text", content: "ok" };
        },
      }),
    } as unknown as LLMProviderFactory;
    const controller = new AbortController();
    await new Compactor(factory, () => CONFIG).summarize([u("x")], undefined, controller.signal);
    expect(seen).toEqual([controller.signal]);
  });
});

describe("planManualCompaction", () => {
  it("always summarizes a fraction, dropping the estimated tokens", () => {
    const msgs = [u("1"), a("1"), u("2"), a("2"), u("3"), a("3"), u("4"), a("4")];
    const plan = planManualCompaction(msgs, 0.5);
    expect(plan.toSummarize.length).toBeGreaterThan(0);
    expect(plan.kept.length).toBeGreaterThan(0);
  });

  it("falls back to summarizing half by count for shallow histories", () => {
    const msgs = [u("a"), a("b"), u("c"), a("d")];
    const plan = planManualCompaction(msgs, 0.6);
    expect(plan.toSummarize.length).toBe(2);
    expect(plan.kept.length).toBe(2);
  });
});

describe("splitSummary", () => {
  it("splits the summarizer output into a synthetic prompt + response", () => {
    expect(splitSummary("I asked for X.\n---\n## Goal\nDid Y.")).toEqual({
      prompt: "I asked for X.",
      response: "## Goal\nDid Y.",
    });
  });

  it("falls back to a generic prompt (still an orange bubble) without the separator", () => {
    const r = splitSummary("just a summary");
    expect(r.prompt).toMatch(/Continue/);
    expect(r.response).toBe("just a summary");
  });

  it("handles an empty summary", () => {
    const r = splitSummary("");
    expect(r.prompt.length).toBeGreaterThan(0);
    expect(r.response.length).toBeGreaterThan(0);
  });
});

describe("compactor: real-data context accounting", () => {
  const asst = (content: string, inputTokens?: number): ChatMessage => ({
    role: "assistant",
    content,
    timestamp: 2,
    ...(inputTokens !== undefined ? { meta: { inputTokens } } : {}),
  });

  it("estimateContextTokens prefers the last REAL input count + trailing estimate", () => {
    const msgs: ChatMessage[] = [u("hello"), asst("hi", 1000), u("x".repeat(40))];
    const trailing = estimateTokens(serializeConversation(msgs.slice(1)));
    expect(estimateContextTokens(msgs)).toBe(1000 + trailing);
  });

  it("estimateContextTokens falls back to a pure estimate with no real usage", () => {
    const msgs: ChatMessage[] = [u("hello"), asst("hi")];
    expect(estimateContextTokens(msgs)).toBe(estimateTokens(serializeConversation(msgs)));
  });

  it("estimateContextTokens falls back after a COMPACTION (prefix rewritten)", () => {
    const msgs: ChatMessage[] = [
      { role: "user", content: "summary", timestamp: 1, synthetic: true },
      { role: "assistant", content: "ok", timestamp: 2, synthetic: true },
      asst("old", 5000),
    ];
    expect(estimateContextTokens(msgs)).toBe(estimateTokens(serializeConversation(msgs)));
  });

  it("estimateContextTokens is 0 for an empty history", () => {
    expect(estimateContextTokens([])).toBe(0);
  });

  it("realWindowTokens subtracts the cumulative baseline BEFORE the window", () => {
    const msgs: ChatMessage[] = [u("a"), asst("b", 1000), u("c"), asst("d", 1600)];
    const expected = 1600 - 1000 + estimateTokens(serializeConversation(msgs.slice(3)));
    expect(realWindowTokens(msgs, 2)).toBe(expected);
  });

  it("realWindowTokens from 0 uses the cumulative count as-is", () => {
    const msgs: ChatMessage[] = [u("a"), asst("b", 1000)];
    expect(realWindowTokens(msgs, 0)).toBe(1000 + estimateTokens(serializeConversation(msgs.slice(1))));
  });

  it("realWindowTokens is undefined when the window has no real usage", () => {
    expect(realWindowTokens([u("a"), asst("b")], 0)).toBeUndefined();
  });
});
