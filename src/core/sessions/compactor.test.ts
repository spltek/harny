import { describe, it, expect, vi } from "vitest";
import {
  Compactor,
  DEFAULT_COMPACTION,
  PERCENT_UNIT,
  SUMMARY_QUALITY_FLOOR,
  TRIM_LABEL,
  TRIM_NOTE,
  autoTargetPercent,
  buildSummaryMessages,
  carriedState,
  clampTargetPercent,
  compactHistory,
  compactionSpanTokens,
  estimateContextTokens,
  estimateTokens,
  isUsableSummary,
  maxSummaryInputTokens,
  minExplicitTargetPercent,
  planCompactionToBudget,
  planForTarget,
  newestWithin,
  realWindowTokens,
  recentStartFor,
  serializeConversation,
  snapCutToGroup,
  shouldCompact,
  splitSummary,
  clampCompactionThresholdPercent,
  toCompactionThresholdPercent,
  toTargetPercent,
  targetTokensFor,
  summarizerPromptReserve,
  summaryBudgetTokens,
  trimHistory,
  type CompactedHistory,
} from "./compactor";
import type { LLMProviderFactory } from "../llm/types";
import type { HarnyConfig } from "../config/types";
import type { ChatMessage } from "../history/types";
import { conversationFaults, turnStart } from "../history/conversation-validity";
import { DEFAULT_CONTEXT_WINDOW, DEFAULT_OUTPUT_TOKENS, usableContext } from "../../chat/context-window";

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

describe("window boundaries never split a tool-call pair", () => {
  /** A turn that calls TWO tools, both answered: the shape a boundary must respect. */
  function toolTurn(n: number): ChatMessage[] {
    return [
      u(`turn ${n}: read two files`),
      {
        role: "assistant",
        content: "",
        timestamp: 2,
        toolCalls: [
          { id: `c${n}a`, name: "Read", arguments: { path: "a.ts" } },
          { id: `c${n}b`, name: "Read", arguments: { path: "b.ts" } },
        ],
      },
      { role: "tool", content: "export const a = 1;", toolCallId: `c${n}a`, timestamp: 3 },
      { role: "tool", content: "export const b = 2;", toolCallId: `c${n}b`, timestamp: 4 },
      a(`done ${n}`),
    ];
  }
  const history = [1, 2, 3, 4, 5, 6].flatMap(toolTurn);

  it("TRIM: every budget lands on a whole turn, so the resumed window is sendable", () => {
    // The trim moves the window WITHOUT a summary (the fail-safe): the boundary it picks is the
    // very thing that gets re-sent. A cut inside a call/result pair would be a 400 that names the
    // wrong culprit (`Messages with role 'tool' must be a response to a preceding message with
    // 'tool_calls'`), so the sweep is exhaustive: every budget, from nothing to everything.
    let sawAResult = false;
    for (const budget of [1, 50, 120, 200, 300, 500, 800, 1200, 2000, 5000]) {
      const trimmed = trimHistory(history, { budgetTokens: budget, summary: "## State" });
      if (!trimmed) continue;
      const resumed = trimmed.history.slice(trimmed.windowStart);
      expect(conversationFaults(resumed)).toEqual([]);
      expect(resumed[0]?.role).not.toBe("tool");
      // The checkpoint pair is what the window opens with.
      expect(resumed[0]?.synthetic).toBe(true);
      expect(resumed[1]?.role).toBe("assistant");
      if (resumed.length > 2) sawAResult = true;
    }
    expect(sawAResult).toBe(true); // the sweep really did exercise the interesting cases
  });

  it("COMPACTION: every landing point keeps a sendable tail, pair included", () => {
    // Same sweep on the other boundary: the KEPT side is what survives verbatim, and the summary
    // pair is inserted right above it — so a tail starting on a `tool` message would be an orphan
    // on the very next request.
    const usable = 100_000;
    for (let pct = 0; pct <= 100; pct++) {
      const target = targetTokensFor(usable, pct);
      const { plan } = planForTarget(history, target, 8192);
      expect(conversationFaults(plan.kept)).toEqual([]);
      expect(plan.kept[0]?.role).not.toBe("tool");
      // The rebuilt window: the synthetic pair, then the verbatim tail.
      const pair: ChatMessage[] = [
        { role: "user", content: TRIM_LABEL, timestamp: 1, synthetic: true },
        { role: "assistant", content: "summary", timestamp: 2, synthetic: true },
      ];
      expect(conversationFaults([...pair, ...plan.kept])).toEqual([]);
      // Nothing is lost between the two sides: summarize + kept is the whole history.
      expect(plan.toSummarize.length + plan.kept.length).toBe(history.length);
    }
  });

  it("…and a session that came back from an OLDER build is caught, not sent", () => {
    // The invariant is enforced on the PAYLOAD too (agent.ts refuses to send and names the fault):
    // a stored sequence that starts with a tool result must not reach the provider as an opaque 400.
    const broken: ChatMessage[] = [{ role: "tool", content: "orphan", toolCallId: "c9", timestamp: 1 }, u("continue")];
    expect(conversationFaults(broken).map((f) => f.kind)).toContain("orphan_tool_result");
  });
});

describe("snapCutToGroup — the cut lands on a WHOLE turn, forward when nothing is behind it", () => {
  it("moves FORWARD to the next input when the boundary fell inside the FIRST group", () => {
    // Keeping everything would make the compaction a no-op, so the boundary walks ahead to
    // the next input: summarizing that whole group still frees real room.
    const msgs = [u("first"), a("calling a tool"), a("answer"), u("second"), a("done")];
    // turnStart finds no input BEHIND the index (message 0 is the head, never inspected),
    // so the only cut that keeps complete turns is the input at 3.
    expect(snapCutToGroup(msgs, 2)).toBe(3);
    expect(msgs[snapCutToGroup(msgs, 2)].role).toBe("user");
  });

  it("prefers the input that OPENS the group containing the boundary", () => {
    const msgs = [u("first"), a("answer"), u("second"), a("answer")];
    expect(snapCutToGroup(msgs, 3)).toBe(2);
  });

  it("returns 0 when the conversation is a single group: half a turn is never kept", () => {
    const msgs = [u("only"), a("calling a tool"), a("answer")];
    expect(snapCutToGroup(msgs, 2)).toBe(0);
  });
});

describe("serializeConversation — the summarizer's view of the span", () => {
  it("names every tool call, so a result is never anonymous", () => {
    const msgs: ChatMessage[] = [
      { role: "user", content: "fix the bug", timestamp: 1 },
      {
        role: "assistant",
        content: "Looking at it",
        timestamp: 2,
        toolCalls: [
          { id: "c1", name: "Read", arguments: { path: "src/a.ts" } },
          { id: "c2", name: "Grep", arguments: { pattern: "TODO", path: "src" } },
        ],
      },
      { role: "tool", content: "contents of a.ts", toolCallId: "c1", timestamp: 3 },
      { role: "tool", content: "3 matches", toolCallId: "c2", timestamp: 4 },
    ];

    const text = serializeConversation(msgs);
    expect(text).toContain("[Tool call]: Read src/a.ts");
    expect(text).toContain("[Tool call]: Grep /TODO/ in src");
    expect(text).toContain("[Tool result]: 3 matches");
    // Each call precedes the results it produced, as in the real conversation.
    expect(text.indexOf("[Tool call]: Read src/a.ts")).toBeLessThan(text.indexOf("[Tool result]: contents of a.ts"));
  });

  it("describes a Write by SIZE, never by its contents", () => {
    const msgs: ChatMessage[] = [
      {
        role: "assistant",
        content: "Writing the file",
        timestamp: 1,
        toolCalls: [{ id: "c1", name: "Write", arguments: { path: "src/gen.ts", contents: "SECRET\n".repeat(80) } }],
      },
      { role: "tool", content: "ok", toolCallId: "c1", timestamp: 2 },
    ];

    const text = serializeConversation(msgs);
    expect(text).toContain("[Tool call]: Write src/gen.ts (80 lines)");
    // The payload would have been 560 chars of a file the span does not need.
    expect(text).not.toContain("SECRET");
  });

  it("leaves an assistant turn with no calls exactly as it was", () => {
    const msgs: ChatMessage[] = [
      { role: "user", content: "hi", timestamp: 1 },
      { role: "assistant", content: "hello", timestamp: 2 },
    ];
    expect(serializeConversation(msgs)).toBe("[User]: hi\n[Assistant]: hello");
  });

  it("never serializes a system or uiOnly message, wherever it sits in the span", () => {
    // The two filters are one rule: a summarizer sees the WORK of the span, never the frame
    // around it. The system prompt is rebuilt per request (prepending it to a summary would
    // duplicate it), and a uiOnly bubble is text the panel drew, not something the model said.
    const msgs: ChatMessage[] = [
      { role: "system", content: "SYSTEM PROMPT", timestamp: 1 },
      { role: "user", content: "hi", timestamp: 2 },
      { role: "assistant", content: "hello", timestamp: 3 },
      { role: "user", content: "UI NOISE", timestamp: 4, uiOnly: true },
    ];
    expect(serializeConversation(msgs)).toBe("[User]: hi\n[Assistant]: hello");
    // The PLANNER applies the same rule — it is a separate filter in a separate function, and
    // drifting apart there is how a system prompt ends up inside a summary.
    const plan = planCompactionToBudget(msgs, 0);
    expect(plan.kept.some((m) => m.role === "system" || m.uiOnly)).toBe(false);
    expect(plan.toSummarize.some((m) => m.role === "system" || m.uiOnly)).toBe(false);
    expect(plan.tokensBefore).toBe(estimateTokens("[User]: hi\n[Assistant]: hello"));
  });

  it("is WIRED: the named calls reach the message the model actually receives", () => {
    // The regression this pins: a fix INSIDE serializeConversation is inert if the
    // request is built some other way. It is exactly the class of bug that hid the
    // tool calls in the first place, so the pipe is asserted end to end, not just
    // the function at the bottom of it.
    const msgs: ChatMessage[] = [
      { role: "user", content: "go", timestamp: 1 },
      {
        role: "assistant",
        content: "on it",
        timestamp: 2,
        toolCalls: [{ id: "c1", name: "Write", arguments: { path: "src/a.ts", contents: "x\ny" } }],
      },
      { role: "tool", content: "ok", toolCallId: "c1", timestamp: 3 },
    ];

    const sent = buildSummaryMessages(msgs);
    // ONE message: data first, instructions last. Nothing depends on the system role, so a
    // summarizer that ignores it — a guard model, a small local one — still gets a task.
    expect(sent).toHaveLength(1);
    expect(sent[0].role).toBe("user");
    expect(sent[0].content).toContain("[Tool call]: Write src/a.ts (2 lines)");
    expect(sent[0].content).toContain("[Tool result]: ok");
    // The transcript comes FIRST and the task LAST — see the comment in buildSummaryMessages.
    expect(sent[0].content.indexOf("<transcript>")).toBeLessThan(sent[0].content.indexOf("BLOCK 1"));
    // …and the tag is CLOSED (it used to be opened in the system prompt and never closed).
    expect(sent[0].content).toContain("</transcript>");
    expect(sent[0].content.trimEnd().endsWith("Never invent details absent from the transcript.")).toBe(true);
  });
});

describe("splitSummary — the two blocks a model was asked for", () => {
  it("splits the label from the document, whatever the separator LOOKS like", () => {
    // The separator is written by a MODEL, not by us: extra dashes and padding spaces are
    // normal replies, and a split that only accepts a bare "---" throws the document away.
    const expected = { prompt: "Summary of past interactions", response: "## Goal\ndid it" };
    for (const text of [
      "Summary of past interactions\n---\n## Goal\ndid it",
      "Summary of past interactions\n-----\n## Goal\ndid it",
      "Summary of past interactions\n   ---   \n## Goal\ndid it",
      "Summary of past interactions\n\n---\n\n## Goal\ndid it",
      "\n\nSummary of past interactions\n---\n## Goal\ndid it\n\n",
    ]) {
      expect(splitSummary(text)).toEqual(expected);
    }
    // CRLF survives inside the body: the split is about the SEPARATOR lines only.
    expect(splitSummary("Summary of past interactions\r\n---\r\n## Goal\r\ndid it")).toEqual({
      prompt: "Summary of past interactions",
      response: "## Goal\r\ndid it",
    });
  });

  it("trims both blocks, and falls back to the generic prompt when the label is EMPTY", () => {
    expect(splitSummary("  Summary of past interactions  \n---\n\n  ## Goal\ndid it  \n\n")).toEqual({
      prompt: "Summary of past interactions",
      response: "## Goal\ndid it",
    });
    // A separator with NOTHING above it is not a label at all: the generic prompt is used and
    // the separator stays IN the body — dropping it would take the document with it.
    expect(splitSummary("   \n---\n## Goal\ndid it")).toEqual({
      prompt: "Continue the work from the summarized context below.",
      response: "---\n## Goal\ndid it",
    });
  });

  it("treats a reply with no separator, or no text at all, as one whole body", () => {
    expect(splitSummary("## Goal\ndid it")).toEqual({
      prompt: "Continue the work from the summarized context below.",
      response: "## Goal\ndid it",
    });
    // An empty reply must not become an empty bubble: the body says so instead.
    expect(splitSummary("   \n ")).toEqual({
      prompt: "Continue the work from the summarized context below.",
      response: "## Progress\nNo details available.",
    });
  });
});

describe("isUsableSummary — a reply that is not the document", () => {
  it("accepts the two-block document, and the fallback prompt around a real body", () => {
    expect(isUsableSummary("Summary of past interactions\n---\n## Goal\nx")).toBe(true);
    expect(isUsableSummary("Riepilogo delle interazioni\n---\n## Fatto\ny")).toBe(true);
    // No `---`: splitSummary supplies its own prompt, and the BODY is still a document.
    expect(isUsableSummary("## Goal\nx\n## Done\ny")).toBe(true);
  });

  it("REJECTS a safety classification — the reply that wrote two useless lines", () => {
    // Seen in the wild: 108 messages reduced to this, and nothing noticed.
    expect(isUsableSummary("User Safety: safe\nResponse Safety: safe")).toBe(false);
  });

  it("REJECTS a document that is only headings — the empty skeleton seen on a real run", () => {
    // "## Goal / ## Done / ## Facts" with nothing under them passes a "has headings"
    // check while carrying nothing, and it REPLACES the previous state.
    expect(isUsableSummary("Summary of past interactions\n---\n## Goal\n## Done\n## Facts")).toBe(false);
    // One heading with real content under it is enough.
    expect(isUsableSummary("Summary of past interactions\n---\n## Goal\n\n## Done\n- did it")).toBe(true);
  });

  it("rejects a refusal, an empty reply, and a label with no document under it", () => {
    expect(isUsableSummary("")).toBe(false);
    expect(isUsableSummary("   ")).toBe(false);
    expect(isUsableSummary("I can't help with that.")).toBe(false);
    expect(isUsableSummary("Summary of past interactions\n---\nok")).toBe(false);
  });
});

describe("maxSummaryInputTokens — what the summarizer could actually read", () => {
  it("is ZERO below the window where a summary request could fit at all", () => {
    // window − output − the MEASURED prompt reserve, then ×0.9 and floored. The ceiling
    // only leaves 0 once that room reaches 2 (room 1 still floors to 0).
    // The cap is the output the session DECLARES — there is no standing constant any more
    // (8192 here is just what a session that declares nothing ends up with).
    const cap = 8_192;
    const empty = cap + summarizerPromptReserve();
    expect(maxSummaryInputTokens(8_000, cap)).toBe(0);
    expect(maxSummaryInputTokens(empty, cap)).toBe(0);
    expect(maxSummaryInputTokens(empty + 1, cap)).toBe(0);
    expect(maxSummaryInputTokens(empty + 2, cap)).toBe(1);
    expect(maxSummaryInputTokens(empty + 3, cap)).toBe(2);
  });

  it("reserves the prompt it actually sends, not a flat guess", () => {
    // The instructions are ~1.9k chars: a FEW hundred tokens. The flat 2000 this
    // replaces was nearly four times the real thing — room the summarizer was told it
    // did not have — and at 1M it would have been rounding error pretending to be a
    // reserve. A constant we own has a size that is a fact.
    expect(summarizerPromptReserve()).toBeGreaterThan(400);
    expect(summarizerPromptReserve()).toBeLessThan(1_500);
  });

  it("counts the PREVIOUS state document in what it may read", () => {
    // It travels INSIDE the same request (buildSummaryMessages). Not counting it is how a
    // big document silently pushed the request past the window.
    const plain = maxSummaryInputTokens(32_000, 8_192);
    const withState = maxSummaryInputTokens(32_000, 8_192, 4_000);
    expect(withState).toBeLessThan(plain);
    expect(plain - withState).toBe(3_600); // the 4000, minus the 0.9 margin
  });
});

describe("carriedState — the state a previous compaction left behind", () => {
  const syntheticPair = (state: string): ChatMessage[] => [
    { role: "user", content: "Summary of past interactions", timestamp: 1, synthetic: true },
    { role: "assistant", content: state, timestamp: 2, synthetic: true },
  ];

  it("returns the state document of the synthetic pair", () => {
    const state = "## Goal\nship the parser\n## Facts\nsrc/parser.ts";
    const messages = [...syntheticPair(state), u("next"), a("working")];
    expect(carriedState(messages)).toBe(state);
  });

  it("ignores the synthetic LABEL and everything not synthetic", () => {
    // The user half of the pair is just the fixed phrase: useless as state, and it
    // must never be mistaken for it.
    expect(carriedState(syntheticPair(""))).toBeUndefined();
    expect(carriedState([u("hello"), a("## Goal\nnot synthetic")])).toBeUndefined();
    expect(carriedState([])).toBeUndefined();
  });

  it("prefers the NEWEST state (older pairs are already folded into it)", () => {
    const messages = [
      { role: "assistant", content: "old state", timestamp: 1, synthetic: true },
      u("work"),
      { role: "assistant", content: "new state", timestamp: 3, synthetic: true },
    ];
    expect(carriedState(messages)).toBe("new state");
  });
});

describe("buildSummaryMessages — UPDATE the state, do not re-derive it", () => {
  const span = [u("do the thing"), a("done")];

  it("tells the model to update, keep, drop and never duplicate", () => {
    const messages = buildSummaryMessages(span, "## Goal\nold goal\n## Facts\nsrc/a.ts");
    const system = messages[0].content;

    expect(system).toMatch(/UPDATING it, not writing a new one/);
    expect(system).toMatch(/keep every fact that is still true/);
    expect(system).toMatch(/DROP what the span shows as done/);
    expect(system).toMatch(/never re-derive from scratch/);
    // The state itself travels inside a marked block, so the model knows where it
    // starts and ends.
    expect(system).toContain("<state>");
    expect(system).toContain("## Facts\nsrc/a.ts");
  });

  it("says nothing about a state when there is none (first compaction)", () => {
    const system = buildSummaryMessages(span)[0].content;
    expect(system).not.toContain("<state>");
    expect(system).not.toMatch(/UPDATING it/);
  });

  it("treats a blank state as no state", () => {
    const system = buildSummaryMessages(span, "   ")[0].content;
    expect(system).not.toContain("<state>");
  });
});

describe("planCompactionToBudget — what is NOT worth summarizing again", () => {
  it("a single turn BIGGER than the keep budget can still be summarized (it used to be a NO-OP)", () => {
    // The real session: after a checkpoint, ONE turn with a dozen tool cycles, ~16k tokens.
    // The turn-group rule snapped the cut back to that turn's first message, which left ONLY
    // the synthetic pair above it — and the pair is filtered out. So the planner answered
    // "nothing to summarize" and the session could never write a state document again: every
    // Compact fell back to a trim, forever (observed: three attempts in a row).
    const messages: ChatMessage[] = [
      { role: "user", content: "Continue the work from the summarized context below.", timestamp: 1, synthetic: true },
      { role: "assistant", content: "## Goal\nold state", timestamp: 2, synthetic: true },
      { role: "user", content: "fammi una ulteriore ricerca", timestamp: 3 },
      ...Array.from({ length: 20 }, (_, i) => ({
        role: (i % 2 === 0 ? "assistant" : "tool") as ChatMessage["role"],
        content: "x".repeat(12_000),
        timestamp: 4 + i,
      })),
      { role: "assistant", content: "fatto", timestamp: 40 },
    ];

    const plan = planCompactionToBudget(messages, 10_000);

    expect(plan.toSummarize.length).toBeGreaterThan(0);
    expect(plan.kept.length).toBeGreaterThan(0);
    // …and the kept side must never OPEN on a `tool` message: its parent was summarized
    // away, so the request would be malformed.
    expect(plan.kept[0].role).not.toBe("tool");
  });

  const syntheticPair: ChatMessage[] = [
    { role: "user", content: "Summary of past interactions", timestamp: 1, synthetic: true },
    { role: "assistant", content: "## Goal\nold state", timestamp: 2, synthetic: true },
  ];
  const work: ChatMessage[] = [
    { role: "user", content: "a", timestamp: 3 },
    { role: "assistant", content: "b", timestamp: 4 },
    { role: "user", content: "c", timestamp: 5 },
    { role: "assistant", content: "d", timestamp: 6 },
    { role: "user", content: "e", timestamp: 7 },
    { role: "assistant", content: "f", timestamp: 8 },
  ];

  it("keeps the previous STATE out of the span (it is handed over separately)", () => {
    // Re-reading a former summary as content is how a summary of a summary loses a
    // fact per generation. The rule lives here, with the rest of the strategy, so
    // the manual and the automatic path cannot disagree.
    // A budget that fits everything makes the planner split by COUNT (half), so the
    // cut lands inside the real work and the excluded pair would otherwise be part of
    // the span.
    const plan = planCompactionToBudget([...syntheticPair, ...work], 1_000);

    expect(plan.toSummarize.length).toBeGreaterThan(0);
    expect(plan.toSummarize.some((m) => m.synthetic)).toBe(false);
    expect(plan.toSummarize.some((m) => m.content === "a")).toBe(true);
    // What is KEPT is untouched: the state stays in the transcript if it falls there.
    expect(plan.kept.some((m) => m.synthetic)).toBe(false);
  });

  it("reports nothing to do when the only thing to cut IS the state", () => {
    // Here the cut lands right AFTER the pair (the recent side fits the budget), so
    // what remains to summarize is only the state — already handed over separately.
    // An empty span is what tells the caller to skip the compaction entirely.
    const plan = planCompactionToBudget([...syntheticPair, u("go"), a("done")], 1);
    expect(plan.toSummarize).toEqual([]);
    expect(plan.kept.length).toBe(2);
  });
});

describe("estimateTokens — the same rule for every provider, widened for non-ASCII", () => {
  it("keeps the classic ~4 chars per token for ASCII", () => {
    expect(estimateTokens("a".repeat(400))).toBe(100);
    expect(estimateTokens("")).toBe(0);
  });

  it("counts CJK at about a token per character", () => {
    // chars/4 would say 25 for 100 ideograms: an estimate 4x too low is what makes
    // a request hit the provider's hard ceiling.
    expect(estimateTokens("我".repeat(100))).toBe(100);
  });

  it("costs more for accented text than for the same ASCII text", () => {
    expect(estimateTokens("città perché".repeat(10))).toBeGreaterThan(estimateTokens("citta perche".repeat(10)));
  });

  it("never UNDERestimates versus the ASCII-only rule", () => {
    const mixed = "hello 世界 àèìòù";
    expect(estimateTokens(mixed)).toBeGreaterThanOrEqual(Math.ceil(mixed.length / 4));
  });
});

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
    const out = serializeConversation(
      [u("hello"), a("ok"), { role: "tool", content: "x".repeat(5000), toolCallId: "c", timestamp: 3 }],
      2000,
    );
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
    const c = new Compactor(factoryWith("## Goal\nFix the bug"));
    const summary = await c.summarize([u("fix the bug")], undefined, undefined, {
      maxReplyTokens: 8_192,
      config: CONFIG,
    });
    expect(summary).toContain("## Goal");
    expect(summary).toContain("Fix the bug");
  });

  it("runs the summary on the CONFIG IT IS GIVEN — the session's model and routing identity", async () => {
    // A summary is a real request, made DURING a run (mid-run compaction). It used to be
    // built from a closure over the host chain, so on a host that routes by conversation
    // (OpenCode Go's `x-opencode-session`) the summarizer's request carried no session id
    // — 400 MissingSessionID in the middle of a run — and everywhere else the summary was
    // written by the config file's model instead of the session's.
    const configs: HarnyConfig[] = [];
    const factory = {
      create: (cfg: HarnyConfig) => {
        configs.push(cfg);
        return {
          protocol: "chat" as const,
          async *stream() {
            yield { type: "text", content: "## Goal\nok" };
          },
        };
      },
    } as unknown as LLMProviderFactory;
    const session: HarnyConfig = {
      ...CONFIG,
      model: "deepseek-v4-pro",
      sessionId: "s-42",
      sessionHeader: "x-opencode-session",
    };

    await new Compactor(factory).summarize([u("work")], undefined, undefined, {
      maxReplyTokens: 8_192,
      config: session,
    });

    expect(configs).toHaveLength(1);
    expect(configs[0]).toMatchObject({
      model: "deepseek-v4-pro",
      sessionId: "s-42",
      sessionHeader: "x-opencode-session",
    });
    // …and the cap still wins over the session's own maxTokens (see requestSummary).
    expect(configs[0].maxTokens).toBe(8_192);
  });

  it("an EMPTY reply is a FAILURE, not a fabricated document", async () => {
    // It used to invent "## Goal <title> / ## Progress No details available." — a document
    // that PASSES the structural check while carrying nothing, and that REPLACES the
    // previous state instead of preserving it. Empty means: let the caller trim.
    const c = new Compactor(factoryWith("   "));
    expect(
      await c.summarize([u("Refactor auth")], undefined, undefined, { maxReplyTokens: 8_192, config: CONFIG }),
    ).toBe("");
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
    await new Compactor(factory).summarize([u("x")], undefined, controller.signal, {
      maxReplyTokens: 8_192,
    });
    expect(seen).toEqual([controller.signal]);
  });

  it("uses the CAP it is GIVEN, unchanged (the host decides the summary budget)", async () => {
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
    await new Compactor(factory).summarize([u("x")], undefined, undefined, {
      maxReplyTokens: 777,
      config: CONFIG,
    });
    // No inheritance from the chat turn and no mutation of what it was handed: the cap is the
    // one the CALLER passed (`maxReplyTokens`), which is required for exactly that.
    expect(seen[0].maxTokens).toBe(777);
  });
});

describe("summary budget (the summary must not eat what the compaction freed)", () => {
  it("is a COMPRESSION of the span it replaces, not a share of the window", () => {
    // 10:1. The window is irrelevant here on purpose: as a share of the window the same
    // rule asked for HALF of it, i.e. an impossible ~450k on a 1M model.
    expect(summaryBudgetTokens(20_000, 16_384)).toBe(2_000);
  });

  it("its only HARD limit is the max output declared for the session", () => {
    // A summary is a response: it can never be larger than what the model is declared
    // able to write, whatever the compression suggests.
    expect(summaryBudgetTokens(200_000, 8_192)).toBe(8_192);
    expect(summaryBudgetTokens(1_000_000, 8_192)).toBe(8_192);
    // …and the cap WINS over the floor: a 256-token session gets 256, not a rejected 512.
    expect(summaryBudgetTokens(100_000, 256)).toBe(256);
  });

  it("never goes below the floor when the cap allows it", () => {
    expect(summaryBudgetTokens(1_000, 16_384)).toBe(SUMMARY_QUALITY_FLOOR); // 100 → floor
    expect(summaryBudgetTokens(0, 16_384)).toBe(SUMMARY_QUALITY_FLOOR);
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
    const c = new Compactor(factory);
    const out = await c.summarize([u("work")], undefined, undefined, {
      maxSummaryTokens: 10_000,
      maxReplyTokens: 8_192,
    });
    expect(factory.sent).toHaveLength(1);
    expect(out).toContain("short");
  });

  it("squeezes ONCE when the summary overshoots the budget, and keeps the shorter one", async () => {
    const huge = `Summary of past interactions\n---\n${"blah ".repeat(4000)}`; // ~6k tokens
    const small = "Summary of past interactions\n---\n## Goal\ncompressed";
    const factory = scriptedFactory([huge, small]);
    const c = new Compactor(factory);

    const out = await c.summarize([u("work")], undefined, undefined, {
      maxSummaryTokens: 1000,
      maxReplyTokens: 8_192,
      config: CONFIG,
    });

    expect(factory.sent).toHaveLength(2); // the second call is the compression
    // …fed with the FIRST summary, inside the data block (the request is ONE message:
    // data first, instruction last, so the last message is the whole thing).
    expect(factory.sent[1]).toContain(huge);
    expect(factory.sent[1]).toContain("You are COMPRESSING a summary");
    expect(out).toBe(small); // the shorter result wins
  });

  it("keeps the original when the squeezed one is NOT shorter (never worse)", async () => {
    const first = `Summary of past interactions\n---\n${"blah ".repeat(4000)}`;
    const worse = `${first}${first}`;
    const factory = scriptedFactory([first, worse]);
    const c = new Compactor(factory);
    // (the returned summary is trimmed; the point is WHICH text won)
    expect(
      await c.summarize([u("work")], undefined, undefined, {
        maxSummaryTokens: 1000,
        maxReplyTokens: 8_192,
        config: CONFIG,
      }),
    ).toBe(first.trim());
  });

  it("does NOT squeeze when the budget is not a real budget (0 or negative)", async () => {
    // A negative budget is TRUTHY: without the `> 0` guard it would trigger a second call
    // whose ceiling is a negative token count, i.e. one that is always exceeded.
    const huge = `Summary of past interactions\n---\n${"blah ".repeat(4000)}`;
    for (const maxSummaryTokens of [0, -5]) {
      const factory = scriptedFactory([huge]);
      await new Compactor(factory).summarize([u("work")], undefined, undefined, {
        maxSummaryTokens,
        maxReplyTokens: 8_192,
        config: CONFIG,
      });
      expect(factory.sent).toHaveLength(1);
    }
  });

  it("keeps a summary that overshoots the budget but stays inside the ALLOWED overshoot", async () => {
    // The budget is a REQUEST, not a limit: between `budget` and `budget × 1.15` the summary
    // is kept as it is — a second call there would spend tokens to fix nothing.
    const text = `Summary of past interactions\n---\n${"word ".repeat(873)}`;
    const size = estimateTokens(text);
    expect(size).toBeGreaterThan(1000); // over the budget…
    expect(size).toBeLessThanOrEqual(1150); // …but inside the overshoot we tolerate
    const factory = scriptedFactory([text, "Summary of past interactions\n---\n## Goal\nsqueezed"]);
    const out = await new Compactor(factory).summarize([u("work")], undefined, undefined, {
      maxSummaryTokens: 1000,
      maxReplyTokens: 8_192,
      config: CONFIG,
    });
    expect(factory.sent).toHaveLength(1);
    expect(out).toBe(text.trim());
  });

  it("does not squeeze at all when no budget is given (backward compatible)", async () => {
    const huge = `Summary of past interactions\n---\n${"blah ".repeat(4000)}`;
    const factory = scriptedFactory([huge]);
    const c = new Compactor(factory);
    expect(await c.summarize([u("work")], undefined, undefined, { maxReplyTokens: 8_192, config: CONFIG })).toBe(
      huge.trim(),
    );
    expect(factory.sent).toHaveLength(1);
  });
});

/**
 * The band is DERIVED from whatever a session declares — no policy baked in.
 *
 * There is deliberately no "recommended window" here. A session may legitimately run an 8k
 * model or a 2M one, and the rules have to be the same at both ends: the trigger is a share
 * of the USABLE context (window − reply reserve), the landing point is a share of that same
 * usable number, and the cut always frees real room.
 *
 * What must never come back is the bug those rules exist for: a trigger measured on the RAW
 * window. On 1M with a 16 384 reserve, a fill of 830 000 is under 80% of the declared window
 * (838 861) and past 80% of what can actually be sent (825 754) — which is exactly how a
 * real 1M/384k session answered 400 with 63% of its window in use.
 */
describe("the compaction band is DERIVED from the declared window (no policy baked in)", () => {
  const settings = DEFAULT_COMPACTION;

  it("scales across three orders of magnitude: 8k → 2M", () => {
    const cases: Array<[window: number, reserve: number, usable: number]> = [
      [8_000, 2_000, 6_000],
      [32_768, 8_192, 24_576],
      [128_000, 16_384, 111_616],
      [1_048_576, 16_384, 1_032_192],
      [2_000_000, 32_000, 1_968_000],
    ];
    for (const [window, reserve, expected] of cases) {
      const usable = usableContext(window, reserve);
      expect(usable).toBe(expected);
      // Trigger: the session's share of the USABLE context, exclusive (`shouldCompact` uses `>`).
      const trigger = (usable * settings.thresholdPercent) / 100;
      expect(shouldCompact(trigger, usable, settings)).toBe(false);
      expect(shouldCompact(Math.floor(trigger) + 1, usable, settings)).toBe(true);
      // Landing point: the same share of the same number, always under the trigger and never 0.
      // AUTO is a tenth with the default 80% trigger (a ratio, so it travels with the number).
      const land = targetTokensFor(usable, toTargetPercent(undefined, settings.thresholdPercent));
      expect(land).toBe(Math.round(usable / 10));
      expect(land).toBeGreaterThan(0);
      expect(land).toBeLessThan(trigger);
    }
  });

  it("measures the fill on the USABLE context at every scale, never on the raw window", () => {
    // 128k with a 16 384 reserve: 89 293 is under 70% of the declared window.
    expect(shouldCompact(89_293, 128_000, settings)).toBe(false);
    expect(shouldCompact(89_293, usableContext(128_000, 16_384), settings)).toBe(true);
    // 1M with the same reserve: 830 000 is under 80% of the window and past the usable trigger.
    expect(830_000).toBeLessThan((1_048_576 * settings.thresholdPercent) / 100);
    expect(shouldCompact(830_000, 1_048_576, settings)).toBe(false);
    expect(shouldCompact(830_000, usableContext(1_048_576, 16_384), settings)).toBe(true);
  });

  it("lets a session BUY a bigger context: a large reserve is a choice, not a contradiction", () => {
    // The configuration that killed a real session — 1M with 384k declared for the reply — is a
    // legitimate one: 664 576 of usable input, the trigger at 531 660.8, the landing point at
    // 66 458. Nothing refuses it; the rules simply follow the numbers.
    const usable = usableContext(1_048_576, 384_000);
    expect(usable).toBe(664_576);
    const trigger = (usable * settings.thresholdPercent) / 100;
    expect(shouldCompact(trigger, usable, settings)).toBe(false);
    expect(shouldCompact(Math.ceil(trigger), usable, settings)).toBe(true);
    const land = targetTokensFor(usable, toTargetPercent(undefined, settings.thresholdPercent));
    expect(land).toBe(66_458);
    expect(land).toBeLessThan(trigger);
  });

  it("whatever the shipped defaults are, they must leave a REACHABLE trigger", () => {
    // The defaults are an OBSERVATION, not a policy: this test stays green if they change, and
    // only fails if they stop making sense together (a reserve as big as the window).
    expect(DEFAULT_OUTPUT_TOKENS).toBeLessThan(DEFAULT_CONTEXT_WINDOW);
    const usable = usableContext(DEFAULT_CONTEXT_WINDOW, DEFAULT_OUTPUT_TOKENS);
    expect(usable).toBeGreaterThan(DEFAULT_OUTPUT_TOKENS);
    // A full usable context always crosses the threshold: the trigger is reachable at all.
    expect(shouldCompact(usable, usable, settings)).toBe(true);
    const land = targetTokensFor(usable, toTargetPercent(undefined, settings.thresholdPercent));
    expect(land).toBeGreaterThan(0);
    expect(land).toBeLessThan(usable);
  });
});

describe("landing point + keep budget (a TARGET whose bounds are DERIVED, never fixed)", () => {
  it("covers the whole usable window: no 20k cap and no 8k floor", () => {
    expect(targetTokensFor(100_000, 20)).toBe(20_000);
    expect(targetTokensFor(616_000, 20)).toBe(123_200);
    expect(targetTokensFor(2_000_000, 20)).toBe(400_000);
    // 0 is a REAL value: the STRUCTURAL minimum (only the last complete turn).
    expect(targetTokensFor(100_000, 0)).toBe(0);
  });

  it("AUTO is an EIGHTH of the trigger: a share of the window, derived from the other knob", () => {
    expect(autoTargetPercent(80)).toBe(10);
    expect(autoTargetPercent(100)).toBe(13);
    expect(autoTargetPercent(60)).toBe(8);
    // Small triggers stay at the unit of the knob instead of collapsing to 0.
    expect(autoTargetPercent(4)).toBe(1);
    expect(autoTargetPercent(1)).toBe(1);
  });

  it("the explicit range is DERIVED from the trigger: `0` or `floor … trigger−1`", () => {
    expect(clampTargetPercent(25, 80)).toBe(25);
    expect(clampTargetPercent(95, 80)).toBe(79);
    // A lower trigger NARROWS the range instead of sharing a global cap.
    expect(clampTargetPercent(50, 20)).toBe(19);
  });

  it("0, a missing value or garbage: MISSING is AUTO, 0 is the minimum", () => {
    // 0 is a REAL position — as low as the structure allows — not a stand-in for Auto.
    expect(clampTargetPercent(0, 80)).toBe(0);
    expect(toTargetPercent(0, 80)).toBe(0);
    // 1 … floor−1 free nothing more than 0 does, so they collapse to it.
    expect(clampTargetPercent(3, 80, 4)).toBe(0);
    expect(clampTargetPercent(4, 80, 4)).toBe(4);
    // A MISSING or unparsable value is AUTO: the derived default.
    expect(toTargetPercent(undefined, 80)).toBe(10);
    expect(toTargetPercent("abc", 80)).toBe(10);
    // …while a value STORED as a string (older sessions) is a real choice, not garbage.
    expect(toTargetPercent("25", 80)).toBe(25);
    expect(toTargetPercent(25, 80)).toBe(25);
    // null is a MISSING value as well — not `0`, which is the deliberate minimum.
    expect(toTargetPercent(null, 80)).toBe(10);
  });

  it("the FLOOR is derived from the session, not a constant", () => {
    // 2k of summary + a 5k last turn on 100k usable = 7%: below it, an explicit value has
    // nothing left to free.
    expect(minExplicitTargetPercent(100_000, 2_000, 5_000)).toBe(7);
    expect(minExplicitTargetPercent(10_000, 2_000, 5_000)).toBe(70);
    // Nothing occupies anything: one percent is the UNIT of the knob, not a policy cap.
    expect(minExplicitTargetPercent(100_000, 0, 0)).toBe(PERCENT_UNIT);
    expect(minExplicitTargetPercent(0, 2_000, 5_000)).toBe(PERCENT_UNIT);
    // A floor ABOVE the derived ceiling leaves the MINIMUM (0) as the only answer.
    expect(clampTargetPercent(40, 20, 70)).toBe(0);
    // …even when the VALUE itself sits above both: the floor outranks the ceiling.
    expect(clampTargetPercent(75, 20, 70)).toBe(0);
    // A floor EQUAL to the ceiling is not above it, so it still lands on the ceiling.
    expect(clampTargetPercent(19, 20, 19)).toBe(19);
    // …and so does an explicit 0, always: it is the bottom of the range, not a sentinel.
    expect(clampTargetPercent(0, 20, 70)).toBe(0);
  });

  it("lands ON the target: the summary is paid out of the SAME budget", () => {
    const msgs = Array.from({ length: 60 }, (_, i) => [u(`prompt ${i}`), a("x".repeat(4000))]).flat();
    const target = targetTokensFor(100_000, 10); // 10k of window left after the cut
    const { plan, keepBudgetTokens, summaryBudgetTokens: budget } = planForTarget(msgs, target, 8_192);
    // The tail gets what the summary does NOT take…
    expect(keepBudgetTokens).toBe(Math.max(0, target - budget));
    // …so the rebuilt window (checkpoint + tail) cannot exceed the target.
    expect(estimateTokens(serializeConversation(plan.kept))).toBeLessThanOrEqual(target);
    expect(plan.toSummarize.length).toBeGreaterThan(0);
    // Whole turns only, and the NEWEST work is what survives.
    expect(conversationFaults(plan.kept)).toEqual([]);
    expect(plan.kept[plan.kept.length - 1]).toBe(msgs[msgs.length - 1]);
  });

  it("AUTO keeps the LAST EXCHANGES verbatim and summarizes the rest", () => {
    // 60 turns ≈ 60k tokens on a 100k usable window. AUTO (10%) is 10k, and the summary's own
    // budget comes out of it: what is left for the tail is a real, positive budget — that is
    // the point of landing at an eighth rather than at the structural minimum.
    const msgs = Array.from({ length: 60 }, (_, i) => [u(`prompt ${i}`), a("x".repeat(4000))]).flat();
    const target = targetTokensFor(100_000, autoTargetPercent(80));
    const { plan, keepBudgetTokens, summaryBudgetTokens: budget } = planForTarget(msgs, target, 8_192);
    expect(budget).toBeLessThan(target);
    expect(keepBudgetTokens).toBeGreaterThan(0);
    expect(plan.toSummarize.length).toBeGreaterThan(0);
    // The tail is a sequence of complete turns that ENDS at the newest message…
    expect(conversationFaults(plan.kept)).toEqual([]);
    expect(plan.kept[plan.kept.length - 1]).toBe(msgs[msgs.length - 1]);
    // …and it is the RECENT part: nothing early survives verbatim.
    expect(plan.kept).not.toContainEqual(msgs[0]);
  });

  it("target 0 is the STRUCTURAL minimum: only the last turn group survives", () => {
    const msgs = Array.from({ length: 20 }, (_, i) => [u(`p${i}`), a("y".repeat(4000))]).flat();
    const { plan, keepBudgetTokens } = planForTarget(msgs, 0, 8_192);
    expect(keepBudgetTokens).toBe(0);
    expect(plan.toSummarize.length).toBeGreaterThan(0);
    // Still a COMPLETE turn, because half a turn is a malformed request.
    expect(plan.kept[0]?.role).toBe("user");
    expect(plan.kept.length).toBeLessThan(msgs.length);
  });

  it("is deterministic: the UI previews these exact numbers", () => {
    const msgs = Array.from({ length: 20 }, (_, i) => [u(`p${i}`), a("y".repeat(2000))]).flat();
    expect(planForTarget(msgs, 30_000, 8_192)).toEqual(planForTarget(msgs, 30_000, 8_192));
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
      expect(conversationFaults(plan.kept)).toEqual([]);
      expect(plan.kept[0]?.role).toBe("user");
      expect(plan.kept.length).toBeGreaterThan(0);
    }
  });

  it("a 10% landing point frees real room on a huge window (no fixed cap in the way)", () => {
    // 616k usable (the session that started this work) and a long history: the old
    // fraction policy kept ~60% of it and freed nearly nothing.
    const msgs = Array.from({ length: 200 }, (_, i) => [u(`prompt ${i}`), a("x".repeat(4000))]).flat();
    const keep = targetTokensFor(616_000, 10);
    const plan = planCompactionToBudget(msgs, keep);
    const keptTokens = estimateTokens(serializeConversation(plan.kept));
    const before = plan.tokensBefore;
    expect(keptTokens).toBeLessThanOrEqual(keep * 1.5); // the tail respects the target…
    expect(keptTokens).toBeLessThan(before * 0.5); // …and the window really shrinks
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

  it("tells the summarizer what a `[Tool call]` line is, so `## Done` names the files", () => {
    // The serialization names every tool call (see serializeConversation); the
    // prompt must not stay silent about it, or the model reads those lines as noise
    // and keeps writing "changed a file" — which is the whole defect it fixes.
    const system = buildSummaryMessages([u("work")])[0].content;
    expect(system).toContain("[Tool call]");
    expect(system).toContain("Wrote src/x.ts");
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

/** A history of `turns` exchanges, each message padded to `size` characters, so
 * the token arithmetic is predictable from the test itself. */
function bigHistory(turns: number, size = 4000): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (let i = 0; i < turns; i++) {
    out.push({ role: "user", content: `domanda ${i}`.padEnd(size, "x"), timestamp: i * 2 + 1 });
    out.push({ role: "assistant", content: `risposta ${i}`.padEnd(size, "y"), timestamp: i * 2 + 2 });
  }
  return out;
}

const PAIR = (content = "## Goal\nstate"): ChatMessage[] => [
  { role: "user", content: "Summary of past interactions", timestamp: 1, synthetic: true },
  { role: "assistant", content, timestamp: 2, synthetic: true },
];

describe("recentStartFor — how much 'the recent part' is", () => {
  it("keeps a suffix that fits the budget, opening on a whole turn", () => {
    const visible = bigHistory(6);
    const start = recentStartFor(visible, 9_000);
    expect(start).toBeGreaterThan(0);
    expect(visible[start].role).toBe("user"); // always an INPUT
    expect(estimateTokens(serializeConversation(visible.slice(start)))).toBeLessThanOrEqual(12_000);
  });

  it("forces progress when one message fills the budget alone (the compaction rule)", () => {
    const visible: ChatMessage[] = [u("a"), { role: "assistant", content: "b", timestamp: 2 }, u("x".repeat(400_000))];
    // Keeping it alone would keep everything, so the walk moves on instead of
    // returning 0 (which would make the compaction a no-op forever).
    expect(recentStartFor(visible, 1_000)).toBeGreaterThan(0);
  });
});

describe("maxSummaryInputTokens — the span the summarizer can actually READ", () => {
  it("scales with the window, reserving the summary's OWN output budget", () => {
    expect(maxSummaryInputTokens(1_000_000, 8_192)).toBeGreaterThan(800_000);
    // The request carries the session's DECLARED output (not the chat turn's reserve), so
    // the ceiling must sit below window − that output minus a margin.
    expect(maxSummaryInputTokens(32_000, 8_192)).toBeLessThan(32_000 - 8_192);
    expect(maxSummaryInputTokens(32_000, 8_192)).toBeGreaterThan(10_000);
  });

  it("is 0 on a window that cannot host the request at all", () => {
    // No room to ask => the caller must move the boundary without a summary
    // rather than send a request that is guaranteed to be rejected.
    expect(maxSummaryInputTokens(8_192, 8_192)).toBe(0);
    expect(maxSummaryInputTokens(4_000, 8_192)).toBe(0);
  });
});

describe("compactionSpanTokens — what a compaction would ask the summarizer to read", () => {
  it("is 0 when there is nothing worth summarizing", () => {
    expect(compactionSpanTokens([u("a"), { role: "assistant", content: "b", timestamp: 2 }], 100_000, 8_192)).toBe(0);
  });

  it("shrinks as the budget grows (more kept verbatim => less to read)", () => {
    const all = bigHistory(20);
    const tight = compactionSpanTokens(all, 10_000, 8_192);
    const loose = compactionSpanTokens(all, 100_000, 8_192);
    expect(tight).toBeGreaterThan(0);
    expect(tight).toBeGreaterThan(loose);
  });

  it("on a BIG history the span dwarfs a small model's ceiling — the downgrade case", () => {
    const all = bigHistory(60);
    // Filled on a 1M model, moved to a 32k one: the span is an order of magnitude
    // past what that model could read, which is exactly when the trim must fire.
    expect(compactionSpanTokens(all, 950_000, 8_192)).toBeGreaterThan(maxSummaryInputTokens(32_000, 8_192));
  });
});

describe("compactHistory — the LANDING POINT is what decides", () => {
  const summaryText = "Summary of past interactions\n---\n## Goal\nwork";
  const turns = (n: number): ChatMessage[] =>
    Array.from({ length: n }, (_, i) => [u(`prompt ${i}`), a("x".repeat(4000))]).flat();
  /** A compactor whose summarizer always answers with a USABLE document. */
  const compactorFor = (): Compactor =>
    new Compactor({
      create: () => ({
        protocol: "chat" as const,
        async *stream() {
          yield { type: "text", content: summaryText };
        },
      }),
    } as unknown as LLMProviderFactory);
  const compactWith = (msgs: ChatMessage[], targetTokens: number): Promise<CompactedHistory | null> =>
    compactHistory(msgs, {
      compactor: compactorFor(),
      config: CONFIG,
      targetTokens,
      maxOutputTokens: 8_192,
      maxInputTokens: 1_000_000,
    });

  it("is the SECOND pass that is planned: the tail gets what the summary does not take", () => {
    const msgs = turns(60);
    const target = 20_000;
    const { plan, keepBudgetTokens, summaryBudgetTokens } = planForTarget(msgs, target, 8_192);
    expect(summaryBudgetTokens).toBeGreaterThan(0);
    // The refined budget is the target MINUS what the summary writes…
    expect(keepBudgetTokens).toBe(target - summaryBudgetTokens);
    expect(keepBudgetTokens).toBeLessThan(target);
    // …so the tail is never BIGGER than the first (naive) pass would have kept.
    expect(plan.kept.length).toBeLessThanOrEqual(planCompactionToBudget(msgs, target).kept.length);
  });

  it("a BIGGER landing point keeps more messages verbatim (and destroys nothing)", async () => {
    const msgs = turns(60); // ~60k tokens of history
    const lean = await compactWith(msgs, 10_000);
    const deep = await compactWith(msgs, 40_000);

    expect(lean).not.toBeNull();
    expect(deep).not.toBeNull();
    // Each run aims where it was told to: the tail plus its own summary stays under the
    // landing point (the exact split is a rounding of the span estimate).
    expect(lean!.keepBudgetTokens).toBeLessThan(10_000);
    expect(deep!.keepBudgetTokens).toBeLessThan(40_000);
    expect(deep!.keepBudgetTokens).toBeGreaterThan(lean!.keepBudgetTokens);
    // A wider landing point keeps strictly more of the recent work…
    expect(lean!.kept.length).toBeLessThan(deep!.kept.length);
    // …and neither run loses a message: the past stays in the rebuilt history.
    expect(lean!.history.length).toBeGreaterThan(lean!.kept.length);
    expect(deep!.history.length).toBeGreaterThan(deep!.kept.length);
  });
});

describe("trimHistory — move the window WITHOUT a summary (the fail-safe)", () => {
  it("moves the boundary and loses NOTHING: the whole past stays, in order", () => {
    const all = bigHistory(10);
    const trim = trimHistory(all, { budgetTokens: 12_000 });
    expect(trim).not.toBeNull();
    const { history, windowStart, moved } = trim!;

    expect(moved).toBeGreaterThan(0);
    // The window opens on a checkpoint pair carrying the trim label…
    expect(history[windowStart].synthetic).toBe(true);
    expect(history[windowStart].content).toBe(TRIM_LABEL);
    // …the untouched prefix is IDENTICAL to the original…
    expect(history.slice(0, windowStart)).toEqual(all.slice(0, windowStart));
    // …and every original message is still in the session (two added: the pair).
    expect(history.length).toBe(all.length + 2);
    for (const m of all) expect(history).toContain(m);
  });

  it("CARRIES the state document verbatim (continuity survives the trim)", () => {
    const state = "## Goal\nship the parser\n## Facts\nsrc/parser.ts is the entry point";
    const all: ChatMessage[] = [...PAIR(state), ...bigHistory(10)];
    const trim = trimHistory(all, { budgetTokens: 12_000, summary: state })!;

    expect(trim).not.toBeNull();
    expect(trim.history[trim.windowStart].content).toBe(TRIM_LABEL);
    expect(trim.history[trim.windowStart + 1].content).toBe(state); // handed over, unchanged
    // The OLD pair left the window but is still in the session.
    expect(trim.windowStart).toBeGreaterThan(2);
    expect(trim.history[0].content).toBe("Summary of past interactions");
    expect(trim.moved).toBe(trim.windowStart - 2);
  });

  it("with no summary to carry, it leaves a factual note (not a fake state document)", () => {
    const all = bigHistory(10);
    const trim = trimHistory(all, { budgetTokens: 12_000 })!;
    expect(trim.history[trim.windowStart + 1].content).toBe(TRIM_NOTE);
  });

  it("never lands INSIDE the existing pair (which would halve it)", () => {
    // A budget big enough to keep everything after the pair would move the
    // boundary right past it — freeing nothing and re-creating the same pair.
    const all: ChatMessage[] = [...PAIR(), ...bigHistory(1)];
    expect(trimHistory(all, { budgetTokens: 1_000_000 })).toBeNull();
  });

  it("is a no-op when the window would have to start at the very beginning", () => {
    expect(trimHistory(bigHistory(1), { budgetTokens: 1_000_000 })).toBeNull();
    expect(trimHistory([u("only")], { budgetTokens: 1 })).toBeNull();
    expect(trimHistory([], { budgetTokens: 1_000 })).toBeNull();
  });

  it("is a no-op when the whole view already FITS the budget (the boundary must not drift)", () => {
    // `recentStartFor` forces progress when everything fits — right for a
    // compaction, WRONG here: `snapCutToGroup` would move the boundary forward on
    // a session that needs nothing, and the prefix would change for no gain.
    const all = bigHistory(2); // ~16k tokens, far under this budget
    expect(trimHistory(all, { budgetTokens: 1_000_000 })).toBeNull();
  });

  it("cannot fix a SINGLE message bigger than the whole window (an honest limit)", () => {
    // Nothing can be moved out: the one message that does not fit is the newest,
    // and it is the content the model is working on.
    const all: ChatMessage[] = [...PAIR(), u("x".repeat(400_000))];
    expect(trimHistory(all, { budgetTokens: 1_000 })).toBeNull();
  });

  it("is STICKY in effect: the trimmed window no longer needs anything moved", () => {
    const all = bigHistory(20);
    const first = trimHistory(all, { budgetTokens: 12_000 })!;
    // What the model would now receive is well under the budget…
    const window = first.history.slice(first.windowStart);
    expect(estimateTokens(serializeConversation(window))).toBeLessThan(20_000);
    // …so a second pass has nothing to move (the boundary does not drift).
    expect(trimHistory(first.history, { budgetTokens: 60_000 })).toBeNull();
  });

  it("is NOT a dead end: the next compaction carries what the trim left", () => {
    // `carriedState` reads the newest synthetic assistant, and a trim leaves one
    // — so the NEXT summary UPDATES that text instead of starting from nothing.
    // Without this the trim would silently reset the session's state document.
    const all = bigHistory(10);
    const trim = trimHistory(all, { budgetTokens: 12_000 })!;
    expect(carriedState(trim.history)).toBe(TRIM_NOTE);
  });

  it("…and when a summary was carried, the next compaction updates THAT", () => {
    const state = "## Goal\nship the parser\n## Facts\nsrc/parser.ts";
    const all: ChatMessage[] = [...PAIR(state), ...bigHistory(10)];
    const trim = trimHistory(all, { budgetTokens: 12_000, summary: state })!;
    expect(carriedState(trim.history)).toBe(state);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Complete turns after a compaction. A compaction is itself a turn (a synthetic
// question + the state document that answers it), so BOTH things it touches must
// consist of whole turns: the span the summarizer reads (what is left above the
// pair becomes `deferred`, a permanent part of the transcript) and the tail kept
// below it. Half a turn on either side is a card that answers a call nobody can
// see, or a model resuming mid-thought after the summary.
// ─────────────────────────────────────────────────────────────────────────────
describe("newestWithin — the span the summarizer READS is whole turns", () => {
  /** One complete turn: input → a step calling two tools → both results → the reply. */
  function toolTurn(n: number, pad = 40): ChatMessage[] {
    return [
      u(`turn ${n} ` + "q".repeat(pad)),
      {
        role: "assistant",
        content: "",
        timestamp: 2,
        toolCalls: [
          { id: `c${n}a`, name: "Read", arguments: { path: "a.ts" } },
          { id: `c${n}b`, name: "Read", arguments: { path: "b.ts" } },
        ],
      },
      { role: "tool", content: "a".repeat(pad), toolCallId: `c${n}a`, timestamp: 3 },
      { role: "tool", content: "b".repeat(pad), toolCallId: `c${n}b`, timestamp: 4 },
      a(`done ${n} ` + "r".repeat(pad)),
    ];
  }
  const history = [1, 2, 3, 4, 5, 6].flatMap((n) => toolTurn(n));

  it("returns the WHOLE span when it fits (no cut, no copy)", () => {
    expect(newestWithin(history, 10_000_000)).toEqual(history);
  });

  it("a cut lands on an INPUT, and leaves both sides readable on their own", () => {
    // Exhaustive over the interesting budgets: a span that opens mid-turn would hand the
    // summarizer a `tool` payload answering a call it cannot see, and leave a call with no
    // result in `deferred`.
    let cuts = 0;
    for (const budget of [1, 20, 60, 100, 160, 240, 400, 700, 1_000, 1_600, 3_000]) {
      const span = newestWithin(history, budget);
      const cut = history.length - span.length;
      expect(span, `budget ${budget}`).toEqual(history.slice(cut)); // a contiguous suffix
      expect(history[cut].role, `budget ${budget}: the span must OPEN a turn`).toBe("user");
      expect(conversationFaults(span), `budget ${budget}: the span reads as a whole`).toEqual([]);
      // `deferred` = everything above the cut: it stays in the transcript, so it must hold no
      // call whose result went into the summary.
      expect(conversationFaults(history.slice(0, cut)), `budget ${budget}: deferred is whole`).toEqual([]);
      cuts++;
    }
    expect(cuts).toBeGreaterThan(0);
  });

  it("keeps at least the NEWEST turn even over budget — never half of it", () => {
    // A budget that fits nothing still returns a readable unit: the last turn, entire. A
    // single oversized turn then fails as one request (the caller falls back to the trim),
    // which is the caller's problem — splitting it is not an option, it is the artifact.
    const last = newestWithin(history, 0);
    expect(last).toEqual(history.slice(history.length - 5));
    expect(last[0].role).toBe("user");
    expect(last.at(-1)?.role).toBe("assistant");
  });

  it("does not drift when a turn is a single message", () => {
    // Nothing to align: with one input per exchange the old per-message walk is the answer.
    const flat = [u("1"), a("2"), u("3"), a("4"), u("5"), a("6")];
    expect(newestWithin(flat, 10_000_000)).toEqual(flat);
    const lastTurn = newestWithin(flat, 1);
    expect(lastTurn).toEqual([u("5"), a("6")]);
    expect(conversationFaults(lastTurn)).toEqual([]);
  });

  it("handles the degenerate sizes", () => {
    expect(newestWithin([], 1_000)).toEqual([]);
    expect(newestWithin([u("only")], 1)).toEqual([u("only")]);
    expect(newestWithin([a("orphan reply")], 1)).toEqual([a("orphan reply")]);
  });

  it("respects a budget that lands exactly on a boundary (no off-by-one)", () => {
    // Greedy from the newest: whole turns are added while they fit, so a budget equal to the
    // last k turns must return exactly those k.
    const turns = [1, 2, 3, 4, 5, 6].map((n) => toolTurn(n));
    const cost = (n: number): number => turns[n - 1].reduce((sum, m) => sum + estimateTokens(m.content), 0);
    for (const k of [1, 2, 3, 6]) {
      let budget = 0;
      for (let n = 7 - k; n <= 6; n++) budget += cost(n);
      const span = newestWithin(history, budget);
      expect(span.length, `k=${k}`).toBe(k * 5);
      expect(span[0].role).toBe("user");
    }
  });
});

describe("planCompactionToBudget — the KEPT tail opens a turn (the pair is a turn too)", () => {
  function toolTurn(n: number, pad = 40): ChatMessage[] {
    return [
      u(`turn ${n} ` + "q".repeat(pad)),
      {
        role: "assistant",
        content: "",
        timestamp: 2,
        toolCalls: [
          { id: `c${n}a`, name: "Read", arguments: { path: "a.ts" } },
          { id: `c${n}b`, name: "Read", arguments: { path: "b.ts" } },
        ],
      },
      { role: "tool", content: "a".repeat(pad), toolCallId: `c${n}a`, timestamp: 3 },
      { role: "tool", content: "b".repeat(pad), toolCallId: `c${n}b`, timestamp: 4 },
      a(`done ${n} ` + "r".repeat(pad)),
    ];
  }
  const history = [1, 2, 3, 4, 5, 6].flatMap((n) => toolTurn(n));

  /** The cut is confined to the FIRST turn: there is no boundary above it to use. */
  function insideFirstTurn(messages: ChatMessage[], kept: ChatMessage[]): boolean {
    const at = messages.indexOf(kept[0]);
    return at < 0 || turnStart(messages, at) === 0;
  }

  it("every keep budget: the pair is followed by a WHOLE turn", () => {
    let aligned = 0;
    for (const budget of [1, 40, 100, 200, 400, 800, 1_600, 4_000, 10_000]) {
      const plan = planCompactionToBudget(history, budget);
      expect(plan.kept.length).toBeGreaterThan(0);
      if (insideFirstTurn(history, plan.kept)) {
        // The documented exception: with the budget cutting inside the FIRST turn there is no
        // whole turn above the cut, and a summary of nothing is the bug this path exists for.
        expect(plan.kept[0].role, `budget ${budget}`).not.toBe("tool");
        continue;
      }
      expect(plan.kept[0].role, `budget ${budget}: kept must OPEN a turn`).toBe("user");
      expect(plan.splitTurn, `budget ${budget}: no exception to report`).toBe(false);
      expect(conversationFaults(plan.kept), `budget ${budget}: kept is sendable`).toEqual([]);
      expect(conversationFaults(plan.toSummarize), `budget ${budget}: the span read is whole`).toEqual([]);
      aligned++;
    }
    // The sweep must actually reach the aligned branch on most budgets, or it proves nothing.
    expect(aligned).toBeGreaterThan(5);
  });

  it("property: over random histories, a half turn is only ever the FIRST one", () => {
    // Deterministic generator: a failure is reproducible.
    let seed = 7;
    const next = (): number => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let trial = 0; trial < 200; trial++) {
      const turns = 1 + Math.floor(next() * 6);
      const messages = Array.from({ length: turns }, (_, i) => toolTurn(i + 1, 10 + Math.floor(next() * 200))).flat();
      for (const budget of [1, 50, 150, 500, 1_500, 5_000]) {
        const plan = planCompactionToBudget(messages, budget);
        if (plan.kept.length === 0) continue;
        // The flag is a CLAIM about the cut, so it is checked in both directions: a future
        // refactor that moves the assignment would otherwise leave a log that lies.
        expect(plan.splitTurn, `trial ${trial} budget ${budget}`).toBe(plan.kept[0].role !== "user");
        if (insideFirstTurn(messages, plan.kept)) continue;
        expect(plan.splitTurn, `trial ${trial} budget ${budget}`).toBe(false);
        expect(plan.kept[0].role, `trial ${trial} budget ${budget}`).toBe("user");
        expect(conversationFaults(plan.kept), `trial ${trial} budget ${budget}`).toEqual([]);
        expect(conversationFaults(plan.toSummarize), `trial ${trial} budget ${budget}`).toEqual([]);
      }
    }
  });

  it("property: at EVERY read ceiling, the span and what is deferred are whole turns", () => {
    // The two boundaries are chosen by two different numbers (the keep TARGET and the read
    // CEILING); only their combination is what a real run meets. Same generator, both swept.
    let seed = 11;
    const next = (): number => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    let checks = 0;
    for (let trial = 0; trial < 120; trial++) {
      const turns = 2 + Math.floor(next() * 6);
      const messages = Array.from({ length: turns }, (_, i) => toolTurn(i + 1, 10 + Math.floor(next() * 300))).flat();
      for (const budget of [1, 200, 800, 3_000, 12_000]) {
        const plan = planCompactionToBudget(messages, budget);
        for (const ceiling of [1, 40, 200, 1_000, 4_000, 20_000]) {
          const span = newestWithin(plan.toSummarize, ceiling);
          if (span.length === 0) continue;
          const cut = plan.toSummarize.length - span.length;
          const where = `trial ${trial} budget ${budget} ceiling ${ceiling}`;
          expect(span[0].role, `${where}: the span opens a turn`).toBe("user");
          expect(conversationFaults(span), `${where}: the span reads as a whole`).toEqual([]);
          expect(conversationFaults(plan.toSummarize.slice(0, cut)), `${where}: deferred is whole`).toEqual([]);
          expect(span, `${where}: a contiguous suffix`).toEqual(plan.toSummarize.slice(cut));
          checks++;
        }
      }
    }
    expect(checks).toBeGreaterThan(1_000); // the sweep is not vacuous
  });

  it("a window that IS one turn compacts anyway, and keeps no orphan result", () => {
    // The exception, spelled out: the real session where every Compact answered "nothing to
    // summarize, forever". There is no whole turn to keep above the cut, so the pair lands
    // inside the turn — the ONLY place where that is allowed, because the alternative is not
    // compacting at all.
    const oneTurn: ChatMessage[] = [
      u("Continue the work from the summarized context below."),
      {
        role: "assistant",
        content: "x".repeat(8_000),
        timestamp: 2,
        toolCalls: [{ id: "k1", name: "Read", arguments: { path: "a.ts" } }],
      },
      { role: "tool", content: "y".repeat(8_000), toolCallId: "k1", timestamp: 3 },
      {
        role: "assistant",
        content: "z".repeat(8_000),
        timestamp: 4,
        toolCalls: [{ id: "k2", name: "Read", arguments: { path: "b.ts" } }],
      },
      { role: "tool", content: "w".repeat(8_000), toolCallId: "k2", timestamp: 5 },
      a("done"),
    ];
    const plan = planCompactionToBudget(oneTurn, 100);
    expect(plan.toSummarize.length).toBeGreaterThan(0); // not a no-op
    expect(plan.kept.length).toBeGreaterThan(0); // the session is never erased
    expect(plan.kept[0].role).not.toBe("tool"); // never an orphaned result
    expect(plan.splitTurn).toBe(true); // …and the caller gets to SAY it
    // The card lands at a STEP boundary: what is summarized never ends with a call whose
    // results were left below (`toSummarize` would be unreadable, `kept` would open on an
    // orphan). It is the strongest guarantee available inside a single turn.
    const last = plan.toSummarize.at(-1);
    expect(last?.role === "assistant" && (last.toolCalls?.length ?? 0) > 0).toBe(false);
    // Whatever it keeps must still be sendable on the next request. `conversation_starts_with_role`
    // is expected HERE and only here: on its own the tail opens on an assistant, and what
    // supplies the leading input is the pair above it (the state document answering the
    // synthetic question) — a complete turn, which is the whole point.
    const faults = conversationFaults(plan.kept).filter((f) => f.kind !== "conversation_starts_with_role");
    expect(faults).toEqual([]);
  });
});
