import { describe, it, expect, vi } from "vitest";
import { Compactor, DEFAULT_COMPACTION, KEEP_RECENT_TOKENS, MIN_KEEP_RECENT_TOKENS, MIN_SUMMARY_TOKENS, SUMMARY_MAX_TOKENS, buildSummaryMessages, estimateTokens, keepRecentTokensFor, planCompactionToBudget, planManualCompaction, shouldCompact, serializeConversation, splitSummary, clampCompactionThresholdPercent, toCompactionThresholdPercent, estimateContextTokens, realWindowTokens, summarizerConfig, summaryBudgetTokens } from "./compactor";
import type { LLMProviderFactory } from "../llm/types";
import type { HarnyConfig } from "../config/types";
import type { ChatMessage } from "../history/types";
import { toolCallPairingViolations } from "../history/tool-call-pairing";

const CONFIG: HarnyConfig = {
  provider: "openai",
  apiKey: "sk",
  baseUrl: "https://api.openai.com",
  model: "gpt-4o",
  maxTokens: 100,
  temperature: 0,
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

  it("uses the config it is GIVEN, unchanged (the host decides the summary budget)", async () => {
    const seen: HarnyConfig[] = [];
    const factory = {
      create: (cfg: HarnyConfig) => {
        seen.push(cfg);
        return {
          protocol: "chat" as const,
          async *stream() {
            yield { type: "text", content: "ok" };
          },
        };
      },
    } as unknown as LLMProviderFactory;
    await new Compactor(factory, () => ({ ...CONFIG, maxTokens: 777 })).summarize([u("x")]);
    // No inheritance from the chat turn and no mutation of what it was handed.
    expect(seen[0].maxTokens).toBe(777);
  });
});

describe("summarizerConfig", () => {
  it("gives the summary its OWN bounded output budget, whatever the turn uses", () => {
    // A turn on a big model asks for 384k of output. Inheriting that budget makes
    // the summary request itself oversized (`input + max_tokens` > window), so the
    // compaction fails silently and the session keeps its full context — the
    // failure this decoupling removes.
    const turn: HarnyConfig = { ...CONFIG, model: "deepseek-v4.1-flash", maxTokens: 384_000 };
    const summary = summarizerConfig(turn);
    expect(summary.maxTokens).toBe(SUMMARY_MAX_TOKENS);
    expect(summary.maxTokens).toBeLessThan(turn.maxTokens);
    // Everything else is carried over untouched: the summary runs on the SAME
    // provider/model/key as the chat it summarizes.
    expect(summary.model).toBe("deepseek-v4.1-flash");
    expect(summary.baseUrl).toBe(turn.baseUrl);
    expect(summary.apiKey).toBe(turn.apiKey);
    // …and the turn's own config is not mutated.
    expect(turn.maxTokens).toBe(384_000);
  });
});

describe("summary budget (the summary must not eat what the compaction freed)", () => {
  it("gives the summary the room between the target and the kept part", () => {
    // 616k usable, 50% target = 308k. Keeping 100k leaves ~208k for the summary.
    expect(summaryBudgetTokens(616_000, 100_000)).toBe(208_000);
    // The SAME window with a fat kept part: less room, and it shrinks with it.
    expect(summaryBudgetTokens(616_000, 300_000)).toBe(8_000);
  });

  it("never goes below the usable floor, even when the kept part exceeds the target", () => {
    // The summary cannot fix a kept side that is already over target (shrinking the
    // tail is a different lever) — but it must not become useless either.
    expect(summaryBudgetTokens(100_000, 95_000)).toBe(MIN_SUMMARY_TOKENS);
    // A window so small that even 50% is under the floor: the floor wins.
    expect(summaryBudgetTokens(1_000, 0)).toBe(MIN_SUMMARY_TOKENS);
    expect(summaryBudgetTokens(0, 0)).toBe(MIN_SUMMARY_TOKENS);
  });

  it("scales with the model: the same session on a small window gets a small budget", () => {
    const kept = 20_000;
    expect(summaryBudgetTokens(32_000, kept)).toBe(MIN_SUMMARY_TOKENS); // nothing to spare
    expect(summaryBudgetTokens(1_000_000, kept)).toBe(480_000); // plenty
  });

  it("tells the summarizer the cap, in tokens and in words", () => {
    const withBudget = buildSummaryMessages([u("hi")], undefined, 2000)[0].content;
    expect(withBudget).toContain("under roughly 2000 tokens");
    expect(withBudget).toContain("1500 words");
    // No budget → no instruction (the plain one-shot summary is unchanged).
    expect(buildSummaryMessages([u("hi")])[0].content).not.toContain("Budget:");
    expect(buildSummaryMessages([u("hi")], undefined, 0)[0].content).not.toContain("Budget:");
  });
});

describe("Compactor — squeezing an oversized summary", () => {
  /** A factory whose replies are scripted per call, recording what it was asked. */
  function scriptedFactory(replies: string[]): LLMProviderFactory & { sent: string[] } {
    const sent: string[] = [];
    let call = 0;
    return {
      sent,
      create: () => ({
        protocol: "chat" as const,
        async *stream(messages: { role: string; content: string }[]) {
          sent.push(messages[messages.length - 1].content);
          yield { type: "text", content: replies[Math.min(call++, replies.length - 1)] };
        },
      }),
    } as unknown as LLMProviderFactory & { sent: string[] };
  }

  it("keeps a summary that fits in ONE call (no wasted request)", async () => {
    const factory = scriptedFactory(["Summary of past interactions\n---\n## Goal\nshort"]);
    const c = new Compactor(factory, () => CONFIG);
    const out = await c.summarize([u("work")], undefined, undefined, { maxSummaryTokens: 10_000 });
    expect(factory.sent).toHaveLength(1);
    expect(out).toContain("short");
  });

  it("squeezes ONCE when the summary overshoots the budget, and keeps the shorter one", async () => {
    const huge = `Summary of past interactions\n---\n${"blah ".repeat(4000)}`; // ~6k tokens
    const small = "Summary of past interactions\n---\n## Goal\ncompressed";
    const factory = scriptedFactory([huge, small]);
    const c = new Compactor(factory, () => CONFIG);

    const out = await c.summarize([u("work")], undefined, undefined, { maxSummaryTokens: 1000 });

    expect(factory.sent).toHaveLength(2); // the second call is the compression
    expect(factory.sent[1]).toBe(huge); // …fed with the FIRST summary
    expect(out).toBe(small); // the shorter result wins
  });

  it("keeps the original when the squeezed one is NOT shorter (never worse)", async () => {
    const first = `Summary of past interactions\n---\n${"blah ".repeat(4000)}`;
    const worse = `${first}${first}`;
    const factory = scriptedFactory([first, worse]);
    const c = new Compactor(factory, () => CONFIG);
    // (the returned summary is trimmed; the point is WHICH text won)
    expect(await c.summarize([u("work")], undefined, undefined, { maxSummaryTokens: 1000 })).toBe(first.trim());
  });

  it("does not squeeze at all when no budget is given (backward compatible)", async () => {
    const huge = `Summary of past interactions\n---\n${"blah ".repeat(4000)}`;
    const factory = scriptedFactory([huge]);
    const c = new Compactor(factory, () => CONFIG);
    expect(await c.summarize([u("work")])).toBe(huge.trim());
    expect(factory.sent).toHaveLength(1);
  });
});

describe("keep budget (an ABSOLUTE recent tail, not a fraction of the history)", () => {
  it("scales with the window but is bounded by the reference (pi keeps 20k)", () => {
    expect(keepRecentTokensFor(100_000)).toBe(MIN_KEEP_RECENT_TOKENS); // 5% < the floor
    expect(keepRecentTokensFor(200_000)).toBe(10_000);
    expect(keepRecentTokensFor(616_000)).toBe(KEEP_RECENT_TOKENS); // 30.8k → capped
    expect(keepRecentTokensFor(2_000_000)).toBe(KEEP_RECENT_TOKENS);
  });

  it("keeps about the budget of the NEWEST work, whatever the history length", () => {
    const big = (n: number): ChatMessage[] =>
      Array.from({ length: n }, (_, i) => [u(`q${i}`), a("x".repeat(4000))]).flat();
    const msgs = big(50); // ~50k tokens of history
    const plan = planCompactionToBudget(msgs, 10_000);
    // The tail is bounded by the BUDGET, not by a share of the whole: this is the
    // difference that makes a compaction free room on a large session.
    expect(estimateTokens(serializeConversation(plan.kept))).toBeLessThanOrEqual(20_000);
    expect(plan.toSummarize.length).toBeGreaterThan(0);
    // What is kept is the END of the conversation (the recent work), verbatim.
    expect(plan.kept[plan.kept.length - 1]).toBe(msgs[msgs.length - 1]);
  });

  it("keeps whole turn groups and at least one of them", () => {
    const msgs = [u("q1"), a("x".repeat(4000)), u("q2"), a("y".repeat(4000)), u("q3"), a("z".repeat(4000))];
    for (const budget of [1, 512, 2000, 100_000]) {
      const plan = planCompactionToBudget(msgs, budget);
      // Never half a turn, never an empty kept side (that would erase the session).
      expect(toolCallPairingViolations(plan.kept)).toEqual([]);
      expect(plan.kept[0]?.role).toBe("user");
      expect(plan.kept.length).toBeGreaterThan(0);
    }
  });

  it("the fraction entry point still behaves like the token one", () => {
    const msgs = [u("a"), a("b"), u("c"), a("d"), u("e"), a("f")];
    const byFraction = planManualCompaction(msgs, 0.5);
    const byBudget = planCompactionToBudget(msgs, byFraction.tokensBefore * 0.5);
    expect(byFraction.kept).toEqual(byBudget.kept);
    expect(byFraction.toSummarize).toEqual(byBudget.toSummarize);
  });

  it("a huge window no longer keeps the history alive (the bug: 60% of 1M)", () => {
    // 616k usable (the session that started this work) and a long history: the old
    // fraction policy kept ~60% of it and freed nearly nothing.
    const msgs = Array.from({ length: 200 }, (_, i) => [u(`prompt ${i}`), a("x".repeat(4000))]).flat();
    const keep = keepRecentTokensFor(616_000);
    const plan = planCompactionToBudget(msgs, keep);
    const keptTokens = estimateTokens(serializeConversation(plan.kept));
    const before = plan.tokensBefore;
    expect(keptTokens).toBeLessThanOrEqual(keep * 1.5); // a bounded tail…
    expect(keptTokens).toBeLessThan(before * 0.2); // …and a real reduction
  });
});

describe("the summary prompt (schematic, minimal, no duplication)", () => {
  it("asks for lists scaled to the complexity, not a filled template", () => {
    const system = buildSummaryMessages([u("work")])[0].content;
    expect(system).toContain("SCHEMATIC LISTS");
    expect(system).toContain("scale the LENGTH to the COMPLEXITY");
    expect(system).toContain("no code blocks");
    // …and keeps the two-block contract the orange synthetic bubble depends on.
    expect(system).toContain("EXACTLY TWO blocks");
    expect(system).toContain("## Facts");
  });

  it("tells it what the session still has in full, so it does not repeat it", () => {
    const withPreview = buildSummaryMessages([u("work")], undefined, undefined, "a".repeat(900))[0].content;
    expect(withPreview).toContain("do NOT summarize what it already shows");
    // The preview is CAPPED at 600 chars: it is context too, not a second copy of
    // the tail (900 in, 600 out, nothing beyond).
    expect(withPreview).toContain("a".repeat(600));
    expect(withPreview).not.toContain("a".repeat(601));
    expect(buildSummaryMessages([u("work")])[0].content).not.toContain("do NOT summarize");
  });
});

describe("planManualCompaction", () => {
  function call(content: string, ...ids: string[]): ChatMessage {
    return { role: "assistant", content, toolCalls: ids.map((id) => ({ id, name: "Shell", arguments: {} })), timestamp: 2 };
  }
  function res(toolCallId: string, content = "out"): ChatMessage {
    return { role: "tool", content, toolCallId, timestamp: 3 };
  }

  it("never leaves the kept tail starting with a tool result, whatever the fraction", () => {
    // Turns that mix text, tool calls and BIG results, so the token boundary lands
    // in many different places as the fraction changes (it is chosen by size).
    const msgs: ChatMessage[] = [
      u("start"),
      call("let me check", "c1"),
      res("c1", "x".repeat(4000)),
      a("done with that"),
      u("next"),
      call("checking again", "c2"),
      res("c2", "y".repeat(200)),
      a("all good"),
      u("continue"),
      call("one more", "c3"),
      res("c3", "z".repeat(2000)),
      a("finished"),
      // …and it ENDS on a just-completed tool turn (the shape right after the
      // results have landed): that is where a size-based boundary can fall
      // exactly on the result, orphaning it.
      call("last check", "c4"),
      res("c4", "w".repeat(300)),
    ];
    for (const f of [0.001, 0.005, 0.02, 0.05, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95]) {
      const plan = planManualCompaction(msgs, f);
      // The kept tail is what goes back to the model after the summary: it must
      // still be replayable on its own.
      expect(toolCallPairingViolations(plan.kept)).toEqual([]);
      // A tail that STARTS with a result would have no call above it in the
      // request — the provider rejects the whole conversation.
      expect(plan.kept[0]?.role).not.toBe("tool");
      // …and it must actually compact (the summarized side is never empty).
      expect(plan.toSummarize.length).toBeGreaterThan(0);
    }
  });

  it("keeps the turn that owns the results instead of orphaning them", () => {
    // Boundary chosen so the naive cut would fall right after the call, i.e. on
    // its result: the snap must pull the call back into the kept tail.
    const msgs: ChatMessage[] = [
      u("start"),
      call("", "c1"),
      res("c1", "x".repeat(4000)),
    ];
    const plan = planManualCompaction(msgs, 0.001);
    expect(toolCallPairingViolations(plan.kept)).toEqual([]);
    if (plan.kept.some((m) => m.role === "tool")) {
      // Whenever a result is kept, its call is kept too.
      expect(plan.kept.some((m) => m.role === "assistant" && !!m.toolCalls?.length)).toBe(true);
    }
  });

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
