/**
 * Running tally of what compaction actually DID — the numbers that decide whether
 * the tuning is right.
 *
 * Every path here already logged its own event, and a log answers "what happened
 * in this case" but never "how often does this happen". The question that matters
 * cannot be read off a single line: **is the trim a rare rescue, or is it the
 * normal path?** If it is the normal path the compaction budget is wrong, and on a
 * window small enough that the summary budget cannot fit at all it is ALWAYS the
 * path (see summaryBudgetTokens) — a fact only a ratio shows.
 *
 * Each event records and returns the line to LOG, so the two cannot drift: there
 * is no way to log an event without counting it. No persistence, no UI, no
 * command — deliberately. It is one line on an existing output channel.
 *
 * A caveat worth stating plainly: this counts the MECHANISM, not the QUALITY. It
 * cannot tell whether the state document carried the right facts; only reading a
 * summary can.
 */

/** The tally's per-kind counts. The session and a sub-agent share the strategy but
 * not the storage, and they can fail independently — so they are counted apart. */
interface TallyCounts {
  session: number;
  subAgent: number;
}

export interface CompactionFacts {
  /** A sub-agent's ephemeral history rather than the session's. */
  subAgent?: boolean;
  /** The span that was summarized, measured against {@link usableTokens}: what had
   *  to FIT in the summarizer's window, and how much window there was to begin with. */
  spanTokens: number;
  usableTokens: number;
  /** What the model could actually read (`maxSummaryInputTokens`). Span against
   *  this is the distance to the case only a trim can serve. */
  ceilingTokens: number;
  keepBudgetTokens: number;
  keptTokens: number;
  summaryBudgetTokens: number;
  summaryTokens: number;
  summarizedCount: number;
  keptCount: number;
}

interface TrimFacts {
  subAgent?: boolean;
  /** The span that could NOT be summarized (larger than the model's window). */
  spanTokens: number;
  ceilingTokens: number;
  /** How many messages left the window. */
  moved: number;
  budgetTokens: number;
}

interface TallySnapshot {
  compaction: TallyCounts;
  trim: TallyCounts;
  /** The widest span ever summarized, and the ceiling it had to fit under. */
  maxSpanTokens: number;
  ceilingAtMaxSpan: number;
  /** Events whose span was within 10% of the ceiling: one step from a trim. */
  nearCeiling: number;
  /** Summary tokens produced in total — what the carried state costs, cumulatively. */
  summaryTokens: number;
}

/** 14200 → `14.2k`, the shape the transcript's badge already uses. */
function fmtTok(n: number): string {
  if (n < 1000) return String(n);
  return `${(n / 1000).toFixed(1)}k`;
}

export class CompactionTally {
  private readonly compaction: TallyCounts = { session: 0, subAgent: 0 };
  private readonly trim: TallyCounts = { session: 0, subAgent: 0 };
  private maxSpanTokens = 0;
  private ceilingAtMaxSpan = 0;
  private nearCeiling = 0;
  private summaryTokens = 0;

  /** Records a compaction and returns the line to log (event detail + tally). */
  recordCompaction(f: CompactionFacts): string {
    const kind = f.subAgent ? "subAgent" : "session";
    this.compaction[kind]++;
    this.summaryTokens += f.summaryTokens;
    if (f.spanTokens > this.maxSpanTokens) {
      this.maxSpanTokens = f.spanTokens;
      this.ceilingAtMaxSpan = f.ceilingTokens;
    }
    if (f.ceilingTokens > 0 && f.spanTokens >= f.ceilingTokens * 0.9) this.nearCeiling++;
    const what = f.subAgent ? "sub-agent compaction" : "compaction";
    return (
      `${what}: span=${fmtTok(f.spanTokens)} of usable=${fmtTok(f.usableTokens)} -> summary ${fmtTok(f.summaryTokens)}/${fmtTok(f.summaryBudgetTokens)} ` +
      `from ${f.summarizedCount} msgs, kept ${f.keptCount} (${fmtTok(f.keptTokens)}/${fmtTok(f.keepBudgetTokens)}) | ${this.line()}`
    );
  }

  /** Records a window trim and returns the line to log — INCLUDING why it fired,
   *  which is the whole point: a trim without its reason is unreadable. */
  recordTrim(f: TrimFacts): string {
    const kind = f.subAgent ? "subAgent" : "session";
    this.trim[kind]++;
    const what = f.subAgent ? "sub-agent context window trimmed" : "context window trimmed";
    return (
      `${what} WITHOUT a summary: span ${fmtTok(f.spanTokens)} > ceiling ${fmtTok(f.ceilingTokens)} — ` +
      `${f.moved} msg(s) left the window (budget ${fmtTok(f.budgetTokens)}) | ${this.line()}`
    );
  }

  snapshot(): TallySnapshot {
    return {
      compaction: { ...this.compaction },
      trim: { ...this.trim },
      maxSpanTokens: this.maxSpanTokens,
      ceilingAtMaxSpan: this.ceilingAtMaxSpan,
      nearCeiling: this.nearCeiling,
      summaryTokens: this.summaryTokens,
    };
  }

  /** The ratio that decides the question this class exists for. */
  private line(): string {
    const c = this.compaction.session + this.compaction.subAgent;
    const t = this.trim.session + this.trim.subAgent;
    const parts = [
      `compaction ${c} (${this.compaction.session} session/${this.compaction.subAgent} sub)`,
      `trim ${t} (${this.trim.session}/${this.trim.subAgent})`,
    ];
    if (this.maxSpanTokens > 0)
      parts.push(`widest span ${fmtTok(this.maxSpanTokens)} of ${fmtTok(this.ceilingAtMaxSpan)} ceiling`);
    if (this.nearCeiling > 0) parts.push(`${this.nearCeiling} within 10% of the ceiling`);
    if (t > 0) parts.push("trim is the FALLBACK — a high ratio here means the summary budget is wrong");
    return `tally: ${parts.join(" · ")}`;
  }
}
