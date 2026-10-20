import { describe, it, expect } from "vitest";
import { CompactionTally } from "./compaction-tally";
import type { CompactionFacts } from "./compaction-tally";

const compaction = (over: Partial<CompactionFacts> = {}): CompactionFacts => ({
  spanTokens: 14_200,
  usableTokens: 100_000,
  ceilingTokens: 40_000,
  keepBudgetTokens: 5_000,
  keptTokens: 2_400,
  summaryBudgetTokens: 5_000,
  summaryTokens: 1_100,
  summarizedCount: 18,
  keptCount: 6,
  ...over,
});

describe("CompactionTally — the ratio a single log line cannot show", () => {
  it("returns the line to log: the event detail AND the running tally", () => {
    const t = new CompactionTally();
    const line = t.recordCompaction(compaction());

    // The event, in full — nothing the old hand-written line carried is lost.
    expect(line).toContain("compaction: span=14.2k of usable=100.0k");
    expect(line).toContain("summary 1.1k/5.0k");
    expect(line).toContain("from 18 msgs");
    expect(line).toContain("kept 6 (2.4k/5.0k)");
    // …and the tally, on the same line, so reading the LAST line answers the question.
    expect(line).toContain("| tally: compaction 1 (1 session/0 sub) · trim 0 (0/0)");
  });

  it("counts the session and a sub-agent APART (they can fail independently)", () => {
    const t = new CompactionTally();
    t.recordCompaction(compaction());
    t.recordCompaction(compaction({ subAgent: true }));
    t.recordCompaction(compaction({ subAgent: true }));

    const snap = t.snapshot();
    expect(snap.compaction).toEqual({ session: 1, subAgent: 2 });
  });

  it("says WHY a trim fired — the span against the ceiling it could not fit", () => {
    const t = new CompactionTally();
    const line = t.recordTrim({ spanTokens: 41_200, ceilingTokens: 8_900, moved: 86, budgetTokens: 2_400 });

    expect(line).toContain("context window trimmed WITHOUT a summary");
    expect(line).toContain("span 41.2k > ceiling 8.9k");
    expect(line).toContain("86 msg(s) left the window");
    expect(line).toContain("budget 2.4k");
  });

  it("warns about the fallback ONLY once the fallback has actually fired", () => {
    const t = new CompactionTally();
    const clean = t.recordCompaction(compaction());
    expect(clean).not.toContain("FALLBACK");

    const after = t.recordTrim({ spanTokens: 41_200, ceilingTokens: 8_900, moved: 86, budgetTokens: 2_400 });
    // The warning is the whole reason this class exists: it turns a number into a
    // decision, at the moment the reader is looking at it.
    expect(after).toContain("trim 1 (1/0)");
    expect(after).toContain("trim is the FALLBACK");
  });

  it("remembers the WIDEST span with the ceiling it had at that moment", () => {
    const t = new CompactionTally();
    t.recordCompaction(compaction({ spanTokens: 14_200, ceilingTokens: 40_000 }));
    t.recordCompaction(compaction({ spanTokens: 31_000, ceilingTokens: 8_900 }));
    t.recordCompaction(compaction({ spanTokens: 9_000, ceilingTokens: 8_900 }));

    const snap = t.snapshot();
    expect(snap.maxSpanTokens).toBe(31_000);
    // The ceiling AT the widest span, not the last one seen: the pair is what reads.
    expect(snap.ceilingAtMaxSpan).toBe(8_900);
    expect(t.recordCompaction(compaction()).includes("widest span 31.0k of 8.9k ceiling")).toBe(true);
  });

  it("counts the spans that came within 10% of the ceiling", () => {
    const t = new CompactionTally();
    t.recordCompaction(compaction({ spanTokens: 30_000, ceilingTokens: 40_000 })); // 75% — comfortable
    t.recordCompaction(compaction({ spanTokens: 36_000, ceilingTokens: 40_000 })); // exactly 90% — counted
    t.recordCompaction(compaction({ spanTokens: 39_000, ceilingTokens: 40_000 })); // 97.5% — counted

    expect(t.snapshot().nearCeiling).toBe(2);
  });

  it("accumulates the summary cost (what the carried state costs, cumulatively)", () => {
    const t = new CompactionTally();
    t.recordCompaction(compaction({ summaryTokens: 1_000 }));
    t.recordCompaction(compaction({ summaryTokens: 2_500 }));
    expect(t.snapshot().summaryTokens).toBe(3_500);
  });

  it("hands out a COPY of the counts — a snapshot cannot be mutated from outside", () => {
    const t = new CompactionTally();
    t.recordCompaction(compaction());
    const snap = t.snapshot();
    snap.compaction.session = 99;
    expect(t.snapshot().compaction.session).toBe(1);
  });

  it("omits the span clause entirely before anything has been summarized", () => {
    const t = new CompactionTally();
    expect(t.recordTrim({ spanTokens: 0, ceilingTokens: 0, moved: 3, budgetTokens: 1_000 })).toContain(
      "| tally: compaction 0 (0 session/0 sub) · trim 1 (1/0)",
    );
  });
});
