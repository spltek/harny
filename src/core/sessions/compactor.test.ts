import { describe, it, expect, vi } from "vitest";
import { Compactor, DEFAULT_COMPACTION, estimateTokens, planCompaction, planManualCompaction, shouldCompact, serializeConversation } from "./compactor";
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
  it("triggers only near the reserved ceiling", () => {
    const s = DEFAULT_COMPACTION; // reserve 16384
    expect(shouldCompact(120000, 200000, s)).toBe(false);
    expect(shouldCompact(184001, 200000, s)).toBe(true);
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

describe("planCompaction", () => {
  const big = { content: "W", timestamp: 1 } as ChatMessage; // 1 token
  it("summarizes the old span and keeps the recent tail", () => {
    const msgs = [u("one"), a("one"), u("two"), a("two"), u("three"), a("three")];
    const plan = planCompaction(msgs, { ...DEFAULT_COMPACTION, reserveTokens: 0, keepRecentTokens: 4 });
    expect(plan.toSummarize.length).toBeGreaterThan(0);
    expect(plan.kept.length).toBeGreaterThan(0);
    // kept + summarized preserves all visible messages
    expect(plan.toSummarize.length + plan.kept.length).toBe(msgs.length);
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
