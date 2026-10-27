import type { ChatMessage } from "../history/types";
import { checkpointStart, turnEnd, turnStart } from "../history/conversation-validity";
import type { HarnyConfig } from "../config/types";
import type { LLMProviderFactory } from "../llm/types";
import { describeToolCall } from "../tools/tool-call-text";

export interface CompactionSettings {
  enabled: boolean;
  /** Context fill % of the declared context window that triggers auto-compaction. */
  thresholdPercent: number;
  /**
   * Where the rebuilt window should LAND, as a % of the USABLE context (window −
   * output reserve). Absent = AUTO (see {@link autoTargetPercent}), so the default
   * policy is expressed as a RULE, not as a number a later edit has to keep in sync.
   */
  targetPercent?: number;
}

export const DEFAULT_COMPACTION: CompactionSettings = {
  enabled: true,
  thresholdPercent: 80,
};

const MIN_COMPACTION_THRESHOLD_PERCENT = 1;
const MAX_COMPACTION_THRESHOLD_PERCENT = 100;

/**
 * The summary's OUTPUT budget is DERIVED, not configured.
 *
 * `summaryBudgetTokens` sizes it as a share ({@link SUMMARY_SPAN_SHARE}) of the span it
 * replaces, capped by the output the session DECLARES. There is deliberately no standing
 * constant here any more: the 8192 that used to live at this spot was inherited by every
 * summary request even when the session had declared something else, and the only number
 * that ever mattered was the one the user declared.
 *
 * The CAP handed to the provider travels with each call (`maxReplyTokens`, REQUIRED in
 * {@link Compactor.summarize}): that is also what keeps the chat turn's `max_tokens` out of
 * a summary, which must not be sized by a budget meant for hundreds of thousands of tokens.
 */

/** Clamp/round any value into the valid threshold range (1%–100%). */
export function clampCompactionThresholdPercent(v: number): number {
  if (!Number.isFinite(v)) return DEFAULT_COMPACTION.thresholdPercent;
  return Math.min(MAX_COMPACTION_THRESHOLD_PERCENT, Math.max(MIN_COMPACTION_THRESHOLD_PERCENT, Math.round(v)));
}

/** Coerce a JSON message value to a number (NaN/undefined -> default 80). */
export function toCompactionThresholdPercent(v: unknown): number {
  return clampCompactionThresholdPercent(typeof v === "number" ? v : Number(v));
}

interface CompactionPlan {
  /** Messages to summarize (the older span, inclusive cut). */
  toSummarize: ChatMessage[];
  /** Messages to keep intact (the recent tail). */
  kept: ChatMessage[];
  /** Estimated tokens of the context before compaction (input side). */
  tokensBefore: number;
}

/** Rough token estimate: ~4 chars per token. */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let ascii = 0;
  let wide = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) < 128) ascii++;
    else wide++;
  }
  // ASCII (code, English, Italian prose): ~4 chars per token — the usual rule for
  // byte-pair tokenizers, and it holds across providers because it is a property
  // of the TEXT, not of a model. Anything else (CJK, accented letters, emoji)
  // costs 1 token per unit or MORE, counted here at 1 on purpose: overestimating
  // compacts a little earlier, underestimating lets a request hit the provider's
  // hard ceiling. Never narrower than the old chars/4 for pure ASCII.
  return Math.ceil(ascii / 4 + wide);
}

/** True when the current context fill reaches the compaction threshold. */
export function shouldCompact(contextTokens: number, contextWindow: number, settings: CompactionSettings): boolean {
  const pct = Number.isFinite(settings.thresholdPercent)
    ? settings.thresholdPercent
    : DEFAULT_COMPACTION.thresholdPercent;
  return contextTokens > (contextWindow * pct) / 100;
}

/** Serialize messages to plain text for the summarizer (tool results truncated). */
export function serializeConversation(messages: ChatMessage[], toolResultLimit = 2000): string {
  return messages
    .filter((m) => m.role !== "system" && !m.uiOnly)
    .flatMap((m) => {
      if (m.role === "assistant") {
        const lines = [`[Assistant]: ${m.content}`];
        // The CALLS, not just the answers. Without them a `[Tool result]` below is
        // anonymous — the summarizer cannot tell a Write from a Grep, so the state
        // it writes cannot name the file that was changed or the command that was
        // run. That is the whole point of the state document, so it is worth a line
        // each. Arguments go through describeToolCall: a Write carries the entire
        // file, and echoing it would inflate the span past what the model can read.
        for (const tc of m.toolCalls ?? []) lines.push(`[Tool call]: ${describeToolCall(tc.name, tc.arguments)}`);
        return lines;
      }
      if (m.role === "tool") {
        const out =
          m.content.length > toolResultLimit
            ? `${m.content.slice(0, toolResultLimit)}… (+${m.content.length - toolResultLimit} chars)`
            : m.content;
        return [`[Tool result]: ${out}`];
      }
      return [`[User]: ${m.content}`];
    })
    .join("\n");
}

/** Index of the LAST assistant message carrying real usage within [from, to). */
function lastAssistantWithUsage(messages: ChatMessage[], from: number, to: number): number {
  for (let i = to - 1; i >= from; i--) {
    const m = messages[i];
    if (m.role === "assistant" && typeof m.meta?.inputTokens === "number" && m.meta.inputTokens > 0) return i;
  }
  return -1;
}

/**
 * REAL token size of the message window `[from, end)` derived from the
 * provider-reported cumulative `meta.inputTokens`: the delta between the last
 * assistant INSIDE the window and the last one BEFORE it (a window starting at
 * 0 has no baseline, so its cumulative input is already the right number), plus
 * an estimate of the trailing messages after that assistant. `undefined` when
 * the window has no real usage at all.
 */
export function realWindowTokens(messages: ChatMessage[], from = 0): number | undefined {
  const lastIdx = lastAssistantWithUsage(messages, from, messages.length);
  if (lastIdx < 0) return undefined;
  const lastInput = messages[lastIdx].meta?.inputTokens ?? 0;
  const beforeIdx = lastAssistantWithUsage(messages, 0, from);
  const base = beforeIdx >= 0 ? (messages[beforeIdx].meta?.inputTokens ?? 0) : 0;
  const window = Math.max(0, lastInput - base);
  return window + estimateTokens(serializeConversation(messages.slice(lastIdx)));
}

/**
 * Best-effort context fill, preferring REAL provider data: the last assistant
 * turn recorded the cumulative `meta.inputTokens` (the size of the WHOLE prompt
 * for that turn), so the current fill = that + the estimate of everything since.
 * Falls back to a pure estimate when no real usage exists (a fresh session) or
 * after a COMPACTION (the synthetic summary rewrote the prefix, invalidating
 * the old cumulative counts).
 */
export function estimateContextTokens(messages: ChatMessage[]): number {
  if (messages.some((m) => m.synthetic)) return estimateTokens(serializeConversation(messages));
  return realWindowTokens(messages) ?? estimateTokens(serializeConversation(messages));
}

/**
 * Snap a cut point to the nearest WHOLE turn group, so what is kept is always a
 * sequence of complete turns (input → final answer, everything in between).
 *
 * Prefers the input that OPENS the group containing the boundary. When that would
 * keep the entire conversation (the boundary fell inside the FIRST group), it
 * moves FORWARD to the next input instead: summarizing that whole group still
 * frees context, while keeping everything would make the compaction a no-op.
 * Returns 0 when the conversation is a single group — nothing can be summarized
 * without cutting it in half, and half a turn is exactly what this avoids
 * (`performCompaction` treats an empty plan as "nothing to do").
 */
export function snapCutToGroup(messages: ChatMessage[], index: number): number {
  const back = turnStart(messages, index);
  if (back > 0) return back;
  const forward = turnEnd(messages, index);
  return forward < messages.length ? forward : 0;
}

/**
 * Where a compaction LANDS, expressed as a share of the USABLE window.
 *
 * This replaces the old absolute recent budget (20k tokens, floor 8k, or 5% of the
 * window — three constants that contradicted each other: on a 32k model the 8k floor was
 * a quarter of the window, on a 1M one it was invisible). A fixed number cannot be right
 * for two models whose windows differ by 30×, and a share of the window alone cannot know
 * whether it FREES enough to get back under the trigger.
 *
 * A landing point can: "leave the rebuilt window at X% of the usable context". Everything
 * else follows from it — the verbatim tail is whatever the summary does not take (see
 * {@link planForTarget}) — so there is nothing left to tune per model size.
 */

/** One percent: the GRANULARITY of the knob, not a policy cap (0 means AUTO). */
export const PERCENT_UNIT = 1;

/** How many times the landing point fits into the trigger: AUTO lands at an EIGHTH of it,
 *  i.e. 10% with the default 80%. A ratio, so it scales — it is not a percentage standing
 *  on its own. */
const AUTO_TARGET_SHARE = 8;

/**
 * AUTO = land at `AUTO_TARGET_SHARE` of the trigger: the window keeps the last EXCHANGES
 * verbatim and frees the rest.
 *
 * Derived on purpose. With the default 80% trigger it lands at 10% (and a 60% trigger at
 * 8%): the band where a session still sees what it was just doing — two or three exchanges,
 * not one — without dragging the work it already summarized. Moving the trigger moves it, so
 * the two knobs cannot go stale. It is a SHARE of the window, never a token count: 10% of
 * 200k and 10% of 1M both mean "the recent part", which a fixed 20k could not.
 *
 * Why not lower: the summary's own budget (a tenth of the span, capped by the declared
 * output) comes OUT of the landing point, so a target under ~5% leaves the tail with nothing
 * and collapses to the structural minimum — a few exchanges are what makes the summary
 * sharper as well (see `keptPreview`).
 */
export function autoTargetPercent(thresholdPercent: number): number {
  const t = Number.isFinite(thresholdPercent) ? Math.round(thresholdPercent) : DEFAULT_COMPACTION.thresholdPercent;
  return Math.max(PERCENT_UNIT, Math.round(t / AUTO_TARGET_SHARE));
}

/**
 * The smallest EXPLICIT landing point that has room of its own: the fill the checkpoint and
 * the last complete turn already occupy. Below it an explicit number frees nothing more, so
 * the floor is DERIVED from the session's own numbers instead of being a constant.
 *
 * It is NOT the bottom of the range: a landing point of 0 is always available and means "as
 * low as the structure allows" (only the last complete turn survives).
 */
export function minExplicitTargetPercent(
  usableTokens: number,
  summaryBudgetTokens: number,
  lastTurnTokens: number,
): number {
  const usable = Math.max(0, usableTokens);
  if (usable <= 0) return PERCENT_UNIT;
  const occupied = Math.max(0, summaryBudgetTokens) + Math.max(0, lastTurnTokens);
  return Math.max(PERCENT_UNIT, Math.ceil((100 * occupied) / usable));
}

/**
 * Clamp a landing % into the positions this session can actually use: `0`, or
 * `floor … trigger−1`.
 *
 * The UPPER bound is derived from the other knob (landing at or above the trigger would free
 * nothing and the next turn would cross it again, paying for a summary each time). The floor
 * is derived from the session, and a value between 1 and it frees nothing more than 0 does —
 * so those collapse to 0 instead of pretending to be a distinct choice.
 *
 * Invalid input resolves to the DERIVED default ({@link autoTargetPercent}), not to 0: a
 * missing value means "nobody chose", while 0 is a deliberate "free everything".
 */
export function clampTargetPercent(value: number, thresholdPercent: number, floorPercent = PERCENT_UNIT): number {
  const t = Number.isFinite(thresholdPercent) ? Math.round(thresholdPercent) : DEFAULT_COMPACTION.thresholdPercent;
  const v = Number.isFinite(value) ? Math.round(value) : autoTargetPercent(t);
  const floor = Math.max(PERCENT_UNIT, Math.round(floorPercent));
  const max = Math.max(0, t - PERCENT_UNIT);
  // 0 is a REAL position — "as low as the structure allows" — and so is everything that
  // cannot free more than it (1 … floor−1, or any value when the floor has no room left).
  if (v <= 0 || v < floor || floor > max) return 0;
  return Math.min(max, v);
}

/** Coerce a JSON message value into a landing %: MISSING means AUTO, `0` means minimum. */
export function toTargetPercent(value: unknown, thresholdPercent: number, floorPercent = PERCENT_UNIT): number {
  const t = Number.isFinite(thresholdPercent) ? Math.round(thresholdPercent) : DEFAULT_COMPACTION.thresholdPercent;
  if (value === undefined || value === null) return autoTargetPercent(t);
  return clampTargetPercent(typeof value === "number" ? value : Number(value), thresholdPercent, floorPercent);
}

/** Tokens the rebuilt window may occupy: the checkpoint pair + the verbatim tail. */
export function targetTokensFor(usableTokens: number, targetPercent: number): number {
  const usable = Math.max(0, usableTokens);
  const pct = Number.isFinite(targetPercent) ? targetPercent : 0;
  return Math.max(0, Math.round((usable * pct) / 100));
}

/** A plan plus the two budgets behind it, for the caller AND for the UI preview. */
interface TargetPlan {
  plan: CompactionPlan;
  /** Tokens the verbatim tail may take. */
  keepBudgetTokens: number;
  /** Tokens the summary may take (a share of the span it replaces). */
  summaryBudgetTokens: number;
}

/**
 * Plan a compaction that LANDS at `targetTokens`.
 *
 * TWO passes, because the summary occupies the very budget it frees: planning with the
 * whole target would land the rebuilt window ABOVE it (summary + tail), and the next turn
 * would compact again. So the first pass measures the span, the summary budget follows from
 * its size, and the second pass gives the tail what is left.
 * Deterministic and model-free: the UI previews these exact numbers instead of
 * approximating them (a preview that lies is worse than none).
 */
export function planForTarget(messages: ChatMessage[], targetTokens: number, maxOutputTokens: number): TargetPlan {
  const target = Math.max(0, targetTokens);
  const first = planCompactionToBudget(messages, target);
  const spanTokens = estimateTokens(serializeConversation(first.toSummarize));
  const summaryBudget = summaryBudgetTokens(spanTokens, maxOutputTokens);
  const keepBudget = Math.max(0, target - summaryBudget);
  // ONE refinement pass. A smaller tail summarizes MORE, so the summary grows and the tail
  // shrinks again — but chasing that to a fixed point buys a rounding difference.
  const plan = keepBudget === target ? first : planCompactionToBudget(messages, keepBudget);
  return { plan, keepBudgetTokens: keepBudget, summaryBudgetTokens: summaryBudget };
}

/**
 * Plan a compaction that keeps about `keepTokens` of the MOST RECENT work.
 *
 * The budget is the INPUT (not a fraction of whatever happens to be there), so the
 * result is predictable: what stays verbatim is bounded by design and everything
 * older is summarized. The tail is snapped to a whole turn group, and at least one
 * group is always kept — a plan that kept nothing would erase the session.
 */
export function planCompactionToBudget(messages: ChatMessage[], keepTokens: number): CompactionPlan {
  const visible = messages.filter((m) => m.role !== "system" && !m.uiOnly);
  const tokensBefore = estimateTokens(serializeConversation(visible));
  if (visible.length <= 2) return { toSummarize: [], kept: visible, tokensBefore };
  const keepStart = recentStartFor(visible, keepTokens);
  // …but the snap must never make the compaction a NO-OP. One turn bigger than the keep
  // budget (a dozen tool cycles under a single request) starts at the first real message,
  // so snapping back leaves only the synthetic pair above the cut — which is filtered out
  // below, leaving `toSummarize` EMPTY. Observed on a real session: every Compact answered
  // "nothing to summarize" and fell back to a trim, forever.
  const summarize = (start: number): ChatMessage[] => visible.slice(0, start).filter((m) => !m.synthetic);
  let start = keepStart;
  if (summarize(start).length === 0) {
    // Honor the budget instead of the group — but WALK BACK over a leading tool message,
    // so the call that owns those results stays in the kept tail (a kept result without
    // its call is a malformed request).
    let safe = budgetedCut(visible, keepTokens);
    while (safe > 0 && visible[safe]?.role === "tool") safe--;
    const candidate = summarize(safe);
    // …and only when there is a span WORTH a model call: one tiny message above the cut is
    // not "something to summarize", and turning a no-op into a request would spend a
    // summary to produce nothing. Below the floor the plan stays empty (the caller skips).
    if (estimateTokens(serializeConversation(candidate)) >= SUMMARY_QUALITY_FLOOR) start = safe;
  }
  const toSummarize = summarize(start);
  return { toSummarize, kept: visible.slice(start), tokensBefore };
}

/**
 * Where the RECENT side begins in `visible`: walk BACKWARDS from the newest
 * message spending `budgetTokens`, then snap to a whole turn group so the result
 * always opens on an input.
 *
 * A compaction that kept everything would free nothing, so when the walk could not
 * spend the budget AT ALL — one huge message, or a view smaller than it — the cut
 * moves to the middle instead: summarizing half still frees room, while returning
 * 0 would make the compaction a no-op the caller retries forever.
 *
 * The TRIM never inherits that rule: it returns early when the whole view already
 * fits, so a boundary that needs no moving cannot drift (see trimHistory).
 */
export function recentStartFor(visible: ChatMessage[], budgetTokens: number): number {
  let start = budgetedCut(visible, budgetTokens);
  // Nothing worth keeping (one huge message fills the budget on its own):
  // summarize half by count rather than keep the whole conversation alive.
  if (start === 0) start = Math.floor(visible.length / 2);
  // A cut must never leave half a turn: what is KEPT is a sequence of complete
  // groups (input → final answer, everything in between).
  return snapCutToGroup(visible, start);
}

/**
 * The RAW budget walk: where the verbatim tail begins, before any turn-group snapping.
 *
 * Separate on purpose. Snapping BACK to the group that contains the cut is what keeps the
 * kept side a sequence of whole turns — but when ONE turn is bigger than the keep budget,
 * the group starts at the very first real message, so snapping back leaves nothing above
 * the cut but the synthetic checkpoint pair. That is the case `planCompactionToBudget`
 * falls back to this index for: being unable to compact is worse than a mid-turn cut.
 */
function budgetedCut(visible: ChatMessage[], budgetTokens: number): number {
  const budget = Math.max(1, budgetTokens);
  let start = visible.length;
  let acc = 0;
  for (let i = visible.length - 1; i >= 0; i--) {
    if (acc + estimateTokens(visible[i].content) > budget && start < visible.length) break;
    start = i;
    acc += estimateTokens(visible[i].content);
  }
  return start;
}

/**
 * Manual compaction: summarize a FRACTION of the current context. Kept as the
 * entry point of the fraction-based policy (and its tests); the HOST goes through
 * {@link planForTarget} instead, because a landing point is what makes a compaction
 * free the room it needs — not a fixed recent budget.
 */
export function planManualCompaction(messages: ChatMessage[], keepRecentFraction = 0.6): CompactionPlan {
  const visible = messages.filter((m) => m.role !== "system" && !m.uiOnly);
  const tokensBefore = estimateTokens(serializeConversation(visible));
  if (visible.length <= 2) return { toSummarize: [], kept: visible, tokensBefore };
  return planCompactionToBudget(messages, Math.max(1, tokensBefore * keepRecentFraction));
}

export interface CompactedHistory {
  /** The rebuilt conversation: the synthetic summary pair + the kept tail. */
  history: ChatMessage[];
  /** Older messages of the span that did NOT fit the request: they stay in the transcript
   *  ABOVE the new checkpoint instead of being summarized. Empty when the whole span
   *  fitted. */
  deferred: ChatMessage[];
  /** The span that was summarized (non-empty by contract). */
  summarized: ChatMessage[];
  /** What survived verbatim. */
  kept: ChatMessage[];
  /** Tokens of the produced summary. */
  summaryTokens: number;
  /** The budgets behind the decision, for the caller's diagnostics. */
  keepBudgetTokens: number;
  summaryBudgetTokens: number;
}

/**
 * The NEWEST messages of a span that fit a token budget, walking BACKWARDS.
 *
 * The work closest to now is the work that matters, and the budget is a hard limit of the
 * request: when the span is bigger than what the model can read in one call, something has
 * to be left out. Leaving out the OLDEST is the choice that keeps the transcript
 * continuous — and nothing is destroyed, because the caller keeps what was left out.
 *
 * Always returns at least the last message: a single huge one is the caller's problem (its
 * request simply fails, and the trim catches it), not a silent empty summary.
 */
export function newestWithin(messages: ChatMessage[], maxTokens: number): ChatMessage[] {
  const budget = Math.max(0, maxTokens);
  let start = messages.length;
  let acc = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const t = estimateTokens(messages[i].content);
    if (acc + t > budget && start < messages.length) break;
    start = i;
    acc += t;
  }
  return messages.slice(start);
}

/**
 * ONE compaction: from the plan to the rebuilt conversation.
 *
 * It owns the STRATEGY — what stays verbatim (an absolute recent budget, snapped to
 * turn boundaries), what gets summarized, how large the summary may be, and the state
 * carried forward — and NOTHING else. Persisting the result, updating the context
 * counter and refreshing the UI stay with the caller.
 *
 * That split is the point: the SAME rule serves a session and a sub-agent's ephemeral
 * history, so the two cannot drift into two behaviours to keep in step.
 *
 * Returns null when there is nothing worth summarizing (the caller then does nothing).
 */
export async function compactHistory(
  messages: ChatMessage[],
  opts: {
    compactor: Compactor;
    /** Where the rebuilt window must LAND, in tokens of the usable context (see
     *  {@link targetTokensFor}). Replaces the old fixed recent budget: the verbatim
     *  tail is whatever the summary does not take. */
    targetTokens: number;
    maxOutputTokens: number;
    /** The largest span the summary request may READ (see maxSummaryInputTokens). When the
     *  span is bigger, the most RECENT part that fits is summarized. */
    maxInputTokens?: number;
    /** Called with the raw reply when it is NOT the document we asked for, so the caller
     *  can say WHY: an empty stream and a classification are different failures, and both
     *  used to read as a single "no summary written". */
    onUnusableReply?: (reply: string) => void;
    signal?: AbortSignal;
  },
): Promise<CompactedHistory | null> {
  // A TARGET, not a fixed recent budget: what stays verbatim is whatever is left once
  // the summary has taken its share of the landing point (see planForTarget).
  const { plan, keepBudgetTokens } = planForTarget(messages, opts.targetTokens, opts.maxOutputTokens);
  if (plan.toSummarize.length === 0) return null;
  // A span bigger than the request can read is NOT a reason to give up: the summarizer
  // takes the most RECENT part that fits, and `deferred` stays in the transcript above the
  // new checkpoint — preserved, out of the window, eligible for a later summary.
  const toSummarize =
    typeof opts.maxInputTokens === "number" ? newestWithin(plan.toSummarize, opts.maxInputTokens) : plan.toSummarize;
  const deferred = plan.toSummarize.slice(0, plan.toSummarize.length - toSummarize.length);
  // HOW MUCH the summary may take: a share of the span it REPLACES (a compression
  // ratio), capped by what the model is declared able to write.
  const spanTokensEstimate = estimateTokens(serializeConversation(toSummarize));
  const summaryBudget = summaryBudgetTokens(spanTokensEstimate, opts.maxOutputTokens);
  // Tell the summarizer what the conversation still has in FULL, so it does not
  // re-state work the next turns can already see (paid twice otherwise)…
  const keptPreview = plan.kept.find((m) => (m.content ?? "").trim())?.content;
  // …and the state a previous compaction left: the summary UPDATES it instead of
  // summarizing a summary (the planner already keeps it out of the span).
  const carried = carriedState(messages);
  const summary0 = await opts.compactor.summarize(toSummarize, carried, opts.signal, {
    maxSummaryTokens: summaryBudget,
    keptPreview,
    // What the model MAY spend to write it: the session's declared output, never the
    // budget itself (see summarize).
    maxReplyTokens: opts.maxOutputTokens,
  });
  // ONE retry before giving up. A reply that is not the document is usually a bad roll of
  // an auto-router (a guard model, a lost thread, an empty stream), not a systematic
  // failure — and refusing to try again throws the summary away for a transient reason.
  // Exactly one extra call, and only when the first one failed; a loop would spend more
  // context than it frees.
  const summary = isUsableSummary(summary0)
    ? summary0
    : await opts.compactor.summarize(toSummarize, carried, opts.signal, {
        maxSummaryTokens: summaryBudget,
        keptPreview,
        maxReplyTokens: opts.maxOutputTokens,
      });
  // A reply that is not the document we asked for must NOT become the state document —
  // see isUsableSummary. An unusable summary is a FAILED compaction (null), which sends
  // the caller down the path that cannot fail: the trim.
  if (!isUsableSummary(summary)) {
    opts.onUnusableReply?.(summary);
    return null;
  }
  // The span becomes a synthetic USER prompt + ASSISTANT response, so a transcript
  // always starts with an orange user bubble (and the state is recognizable later).
  const { prompt, response } = splitSummary(summary);
  const now = Date.now();
  return {
    history: [
      // What did not fit stays ABOVE the new checkpoint: still in the transcript, outside
      // the window — visible, not summarized, not lost.
      ...deferred,
      { role: "user" as const, content: prompt, timestamp: now, synthetic: true },
      { role: "assistant" as const, content: response, timestamp: now + 1, synthetic: true },
      ...plan.kept,
    ],
    summarized: toSummarize,
    deferred,
    kept: plan.kept,
    summaryTokens: estimateTokens(summary),
    keepBudgetTokens,
    summaryBudgetTokens: summaryBudget,
  };
}

/** The message that produces the summary is not the only thing in its request: the
 *  system prompt carries the instructions, the state and the budget. This is the room for
 *  the blocks glued to it — the prompt ITSELF is measured (summarizerPromptReserve),
 *  because a constant string we own has a size that is a FACT, not an estimate. */
const SUMMARY_PROMPT_BLOCKS = 600;

/** Keep a margin under the ceiling: the estimate is approximate, and a rejected
 * request is what this whole guard exists to avoid. */
const SUMMARY_INPUT_MARGIN = 0.9;

/** The fixed label a TRIM leaves where a summary would have been. Deliberately
 * NOT the compaction phrase, so a window moved without a summary is recognizable
 * in the transcript (and in the logs) as exactly that. */
export const TRIM_LABEL = "Earlier interactions moved out of the context window";

/** What a trim leaves as the state document when there was no summary to carry.
 * Short and factual: it is not a state document, and the next compaction must not
 * mistake it for one to "update". */
export const TRIM_NOTE =
  "The earlier part of this session is no longer in the model's context window: it did not fit the current model. " +
  "It is still stored — the transcript shows it — and it can be searched.";

/** What {@link trimHistory} produced. */
export interface TrimResult {
  /** The rebuilt history: the trimmed span stays, the boundary moves after it. */
  history: ChatMessage[];
  /** Index in `history` of the checkpoint pair that OPENS the new window. */
  windowStart: number;
  /** How many messages left the window (the re-created pair is not counted). */
  moved: number;
}

const SUMMARY_PROMPT = `The transcript above is an OLD part of a coding session. Summarize it. The summary REPLACES that span, so it must stand alone — but it is also CONTEXT: every token you write is a token the session cannot spend on real work. Its only job is to let the next turns reconstruct what was decided and what comes next.

Write the MINIMUM that does that, as SCHEMATIC LISTS — never prose:
- fragments, not sentences; one bullet per fact, one line each, most important first;
- no restating the transcript, no examples, no code blocks (name the file and the symbol instead), no pleasantries, no "the user asked…" narration;
- scale the LENGTH to the COMPLEXITY of the work: a simple task gets a handful of bullets, a long one more — never padding, never a template filled for its own sake;
- OMIT anything the transcript AFTER this span already shows, and anything re-derivable by reading the code;
- KEEP exact names, paths, numbers, commands and constraints: those are the facts nothing else carries;
- "[Tool call]" lines name each tool with its target and size, and the "[Tool result]" lines are that call's OUTPUT: a file WRITTEN or DELETED is a fact about the work, so ## Done names it ("Wrote src/x.ts") — never just "changed a file".

Reply with EXACTLY TWO blocks separated by a line containing only "---" (three dashes):

BLOCK 1 — ONLY the fixed phrase "Summary of past interactions", TRANSLATED into the SAME language as the transcript. Output that phrase alone, nothing else (no punctuation, no extra words).

BLOCK 2 — a Markdown summary with these headings, IN THIS ORDER, including ONLY the ones that have something under them (an empty heading is just padding — drop it):
## Goal    — what was asked, one line
## Done    — bullets: what is finished, and the decisions taken with the reason when it is not obvious
## Open    — bullets: what is in progress or blocked, and on what
## Next    — bullets: the exact next steps
## Facts   — bullets: what the next turns cannot guess (paths, commands, values, constraints, gotchas)

Write it in the SAME language as the transcript. Never invent details absent from the transcript.`;

/** Split the summarizer output into the synthetic USER prompt and the synthetic
 * ASSISTANT response (the two messages that replace the summarized span). When
 * the model omits the `---` separator, the whole text becomes the response and
 * a short generic prompt is used, so the transcript still starts with an orange
 * user bubble. */
export function splitSummary(text: string): { prompt: string; response: string } {
  const trimmed = text.trim();
  const m = /^([\s\S]*?)\r?\n\s*-{3,}\s*\r?\n([\s\S]*)$/.exec(trimmed);
  if (m && m[1].trim() && m[2].trim()) return { prompt: m[1].trim(), response: m[2].trim() };
  return {
    prompt: "Continue the work from the summarized context below.",
    response: trimmed || "## Progress\nNo details available.",
  };
}

/**
 * Is this reply the DOCUMENT we asked for, or something else entirely?
 *
 * Free and auto-routed models sometimes answer with a safety classification, a refusal or
 * an empty stream — `User Safety: safe` and nothing more. Accepting that would write
 * GARBAGE into the state document, which is the one thing the next turns depend on: 108
 * messages would be reduced to two useless lines, silently, and nothing would ever
 * recover them.
 *
 * The prompt asks for Markdown headings, so a body with none is not the document. Being
 * strict is safe here because the CALLER has a fallback that cannot fail (the trim).
 */
export function isUsableSummary(text: string): boolean {
  if (!text.trim()) return false;
  const { response } = splitSummary(text);
  // Headings ALONE are not a document. "## Goal / ## Done / ## Facts" with nothing under
  // them passes a "has headings" check while carrying nothing — and it would REPLACE a
  // previous state that had everything. Observed on a real run. So: a heading must have
  // real content below it.
  let opened = false;
  for (const line of response.split("\n")) {
    if (/^#{2,3}\s+\S/.test(line)) {
      opened = true;
      continue;
    }
    if (opened && line.trim()) return true;
  }
  return false;
}

/**
 * The STATE DOCUMENT a previous compaction left in the transcript, if any.
 *
 * Each compaction replaces the summarized prefix with a synthetic pair
 * (`synthetic: true`): a user message carrying the fixed label and an assistant
 * message carrying the summary itself. That assistant message IS the state of the
 * work so far — the one thing whose loss nothing can recover, because it is the
 * only place the older context still exists.
 *
 * Returning it lets the next compaction UPDATE it instead of summarizing a summary
 * of a summary: that repetition is where facts quietly decay ("the phone game"),
 * and it happens precisely on the long sessions that need them.
 */
export function carriedState(messages: ChatMessage[]): string | undefined {
  // The NEWEST one wins: older pairs are already folded into it.
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.synthetic && m.role === "assistant" && (m.content ?? "").trim()) return m.content.trim();
  }
  return undefined;
}

/**
 * Move the context window FORWARD without summarizing anything.
 *
 * This is the fallback for the ONE case a compaction cannot serve: the span is
 * larger than the window of the model that would have to READ it (the summarizer
 * runs on the SESSION's model, see summarizerConfig). Asking a small model to read
 * a span built for a big one gets the summary request REJECTED — and on a window
 * that just shrank under a full session, that left the session unable to send
 * anything at all: the compaction failed, the request was refused for length, and
 * the retries failed the same way.
 *
 * A trim instead:
 *  · is DETERMINISTIC and free — no model call, so it cannot fail;
 *  · CARRIES the summary verbatim, so the state document stays inside the window
 *    (moving the boundary past it would drop continuity entirely);
 *  · keeps the trimmed messages IN the history, before the new boundary, where
 *    they stay readable and searchable — nothing is lost;
 *  · snaps to a whole turn group, so the window still opens on an input.
 *
 * It trades QUALITY for survival: the trimmed span is neither in the window nor
 * in the summary. That is why it is a fallback — the caller compacts whenever the
 * span fits — and never the ordinary path.
 *
 * Returns null when there is nothing to move: the window already fits, the
 * boundary would land on the checkpoint pair, or a single message is bigger than
 * the whole window — which no trim can fix.
 */
export function trimHistory(all: ChatMessage[], opts: { budgetTokens: number; summary?: string }): TrimResult | null {
  const activeStart = checkpointStart(all);
  const visible = all.slice(activeStart).filter((m) => m.role !== "system" && !m.uiOnly);
  if (visible.length <= 1) return null;

  // Nothing to move when the whole view already FITS the budget. Checked here,
  // explicitly, because `recentStartFor` forces progress when everything fits (it
  // jumps to the middle — right for a compaction, wrong for a trim: `snapCutToGroup`
  // would move the boundary forward on a session that needs nothing, drifting the
  // prefix and invalidating the prompt cache for no gain).
  if (estimateTokens(serializeConversation(visible)) <= Math.max(1, opts.budgetTokens)) return null;

  const firstKept = visible[recentStartFor(visible, opts.budgetTokens)];
  if (!firstKept) return null;
  // Index in the FULL array: `visible` holds the very same message objects.
  const at = all.indexOf(firstKept);
  if (at < 0) return null;

  // The boundary must fall PAST the existing checkpoint pair, and far enough to
  // free something: landing inside it would HALVE it, and landing right after it
  // would re-create the same pair and free nothing at all.
  const hasPair = all[activeStart]?.synthetic === true;
  if (hasPair ? at <= activeStart + 2 : at <= activeStart) return null;

  const now = Date.now();
  const pair: ChatMessage[] = [
    { role: "user", content: TRIM_LABEL, timestamp: now, synthetic: true },
    { role: "assistant", content: opts.summary?.trim() || TRIM_NOTE, timestamp: now + 1, synthetic: true },
  ];
  return {
    history: [...all.slice(0, at), ...pair, ...all.slice(at)],
    windowStart: at,
    moved: at - activeStart - (hasPair ? 2 : 0),
  };
}

/**
 * Everything a summary request spends BEFORE it reads a line of transcript: the prompt
 * itself plus the blocks glued to it.
 *
 * MEASURED, not guessed. The prompt is a constant string we own, so its size is a FACT —
 * and the flat 2000 it replaces was wrong in both directions at once: ~6% of a 33k window
 * and ~0.2% of a 1M one. At small windows it burned room the summarizer could have used;
 * at large ones it was rounding error pretending to be a reserve.
 */
export function summarizerPromptReserve(): number {
  return estimateTokens(SUMMARY_PROMPT) + SUMMARY_PROMPT_BLOCKS;
}

/**
 * The largest span the summarizer can be asked to READ, in tokens.
 *
 * Measured on the MODEL's window, not on the session's usable budget: the summary
 * request carries its OWN output budget (see `summaryBudgetTokens`) instead of the chat
 * turn's reserve, so subtracting the turn's reserve here would refuse a summary
 * that would have fitted. The margin exists because the estimate is approximate
 * and a rejection costs the session.
 *
 * `stateTokens` is the PREVIOUS state document, which travels INSIDE the same request
 * (see buildSummaryMessages). Not counting it is how a big document silently pushed the
 * request past the window.
 *
 * `outputCap` is the session's DECLARED max output — a ceiling on the reply, not the reply
 * itself: the summary is sized by the compression ratio (see summaryBudgetTokens), so the
 * reserve is that ratio, and the cap only matters when it is SMALLER than the ratio asks.
 */
export function maxSummaryInputTokens(windowTokens: number, outputCap: number, stateTokens = 0): number {
  const room = Math.max(0, windowTokens) - summarizerPromptReserve() - Math.max(0, stateTokens);
  // The provider counts `input + output` against the window, and the summary asks for a
  // SHARE of what it reads — so a bigger input asks for a bigger output, which leaves LESS
  // room for the input. Solving it directly breaks that circle instead of guessing:
  //   input × (1 + share) ≤ room      (the summary is a share of the span)
  //   input ≤ room − cap              (the cap is the session's declared max output)
  const byRatio = room / (1 + SUMMARY_SPAN_SHARE);
  const byCap = room - Math.max(0, outputCap);
  return Math.max(0, Math.floor(Math.min(byRatio, byCap) * SUMMARY_INPUT_MARGIN));
}

/**
 * Token size of the span a compaction would summarize right now (0 = none).
 *
 * Pure and LLM-free on purpose: it is the number to compare against
 * {@link maxSummaryInputTokens} BEFORE calling {@link compactHistory}, because
 * that one already runs the summarizer — checking afterwards would mean asking a
 * model to read a request it cannot accept.
 */
export function compactionSpanTokens(messages: ChatMessage[], targetTokens: number, maxOutputTokens: number): number {
  const plan = planForTarget(messages, targetTokens, maxOutputTokens).plan;
  return plan.toSummarize.length === 0 ? 0 : estimateTokens(serializeConversation(plan.toSummarize));
}

/** Builds the one-shot summary request (optionally passing the previous summary). */
export function buildSummaryMessages(
  toSummarize: ChatMessage[],
  previousSummary?: string,
  maxSummaryTokens?: number,
  keptPreview?: string,
): { role: "system" | "user"; content: string }[] {
  const text = serializeConversation(toSummarize);
  const budget =
    typeof maxSummaryTokens === "number" && maxSummaryTokens > 0
      ? `\nBudget: the WHOLE summary must stay under roughly ${maxSummaryTokens} tokens (about ${Math.max(
          60,
          Math.round(maxSummaryTokens * 0.75),
        )} words). Be terse: short lines, no prose, never restate the transcript.\n`
      : "";
  // What the session still has in FULL. Without it the summary re-states work the
  // next turns can already see, which is the cheapest waste there is: those tokens
  // are paid twice (in the summary and in the kept tail).
  const kept =
    keptPreview && keptPreview.trim()
      ? `\nThe transcript CONTINUES after this span; do NOT summarize what it already shows (first message that follows):\n${keptPreview.trim().slice(0, 600)}\n`
      : "";
  // UPDATE, do not re-derive. Without this instruction the model treats the old
  // summary as one more document to summarize, and each generation quietly loses
  // facts — the failure mode that shows up only on the long sessions that need them.
  const state =
    previousSummary && previousSummary.trim()
      ? `\nA STATE DOCUMENT from the previous compaction follows. You are UPDATING it, not writing a new one:
- keep every fact that is still true, in the SAME words (it is already paid for);
- add what the span below changed, in the same style;
- DROP what the span shows as done or abandoned: a finished thread is noise;
- never re-derive from scratch and never keep two copies of one fact.
\n<state>\n${previousSummary.trim()}\n</state>\n`
      : "";
  // DATA FIRST, INSTRUCTIONS LAST — ONE message, and no reliance on the system role.
  //
  // Anthropic's long-context guidance, which holds across models: put longform data at
  // the TOP, above the instructions ("queries at the end can improve response quality by
  // up to 30%" on 20k+ token inputs — exactly our case). It is also the most compatible
  // shape there is: a summarizer that ignores or downweights the system role — a guard
  // model, a small local one — still sees a task it can follow, and it never has to hold
  // "what am I supposed to do" across 40k characters of transcript.
  return [
    {
      role: "user",
      content: `<transcript>\n${text}\n</transcript>\n\n${SUMMARY_PROMPT}${budget}${kept}${state}`,
    },
  ];
}

/** A summary smaller than this is not worth having: too little to continue from. It is a
 * QUALITY floor, not a cap on the context — nothing above depends on it. */
export const SUMMARY_QUALITY_FLOOR = 512;

/** Overshoot tolerated before the summary is squeezed a second time (+15%). */
const SUMMARY_OVERSHOOT = 1.15;

/** A summary is a COMPRESSION of what it replaces: this is the ratio. */
const SUMMARY_SPAN_SHARE = 0.1;

/**
 * How big the summary itself is allowed to be, in tokens.
 *
 * Two questions with two answers, and only ONE of them is about space — which is why this
 * used to be wrong. It is first a COMPRESSION of the span it replaces (the ratio above):
 * as a share of the window the same rule asked for half of it, i.e. 12k on a 33k model
 * and an impossible ~450k on a 1M one.
 *
 * The only HARD limit is `maxOutputTokens`: a summary is a response, so it can never be
 * larger than what the model is declared able to write. That cap wins even over the floor
 * — a session configured to write 256 tokens gets a 256-token summary, not a rejected one.
 */
export function summaryBudgetTokens(spanTokens: number, maxOutputTokens: number): number {
  const compression = Math.round(Math.max(0, spanTokens) * SUMMARY_SPAN_SHARE);
  return Math.min(Math.max(0, maxOutputTokens), Math.max(SUMMARY_QUALITY_FLOOR, compression));
}

const COMPRESS_PROMPT = `You are COMPRESSING a summary that is too long for the context budget. Reply with EXACTLY the same two-block structure as the input (block 1: the fixed phrase, in the SAME language as the input; then a line with only "---"; block 2: the compressed Markdown summary).

Keep every fact needed to continue the work: Goal, Progress (Done / In Progress / Blocked), Key Decisions, Next Steps, Critical Context. DROP prose, repetitions, examples, and anything already visible in the kept transcript. Prefer short bullets over sentences.

Budget: the result must stay under roughly `;

/** The second pass: rewrite an oversized summary under an explicit token cap. */
function compressSummaryMessages(
  summary: string,
  maxSummaryTokens: number,
): { role: "system" | "user"; content: string }[] {
  // Same shape as the summary request itself: data first, instruction last.
  return [
    {
      role: "user",
      content: `<summary>\n${summary}\n</summary>\n\n${COMPRESS_PROMPT}${maxSummaryTokens} tokens.\n`,
    },
  ];
}

/**
 * Generates a structured summary of a span of messages using the configured
 * LLM (a lightweight one-shot call, no tools). Falls back to a short label.
 */
export class Compactor {
  constructor(
    private factory: LLMProviderFactory,
    private buildConfig: () => HarnyConfig,
  ) {}

  /**
   * One compaction summary.
   *
   * `maxReplyTokens` is the CAP the provider is given, and it belongs to the CALLER: there is
   * no standing default here (see the note at the top of this file), because the only right
   * value is the output the session declares. `compactHistory` always passes it.
   */
  async summarize(
    toSummarize: ChatMessage[],
    previousSummary?: string,
    signal?: AbortSignal,
    options: { maxSummaryTokens?: number; keptPreview?: string; maxReplyTokens?: number } = {},
  ): Promise<string> {
    const budget = options.maxSummaryTokens;
    let out = await this.requestSummary(
      buildSummaryMessages(toSummarize, previousSummary, budget, options.keptPreview),
      signal,
      // The CAP is deliberately NOT the budget. The budget is the size we ASK for; the cap
      // is what the model may spend to produce it — and a model that reasons spends that
      // budget BEFORE writing a single character. Measured: cap = budget (964) gave an
      // EMPTY reply 3 times out of 3; cap = the session's declared output gave a real
      // document 3 times out of 3.
      options.maxReplyTokens,
    );
    // Still oversized when measured (the instruction is a request, not a limit):
    // ONE compression pass, and only the SHORTER of the two is kept. Bounded to a
    // single extra call on purpose — a loop over a summary would spend more
    // context than it frees.
    if (budget && budget > 0 && out && estimateTokens(out) > Math.ceil(budget * SUMMARY_OVERSHOOT)) {
      const squeezed = await this.requestSummary(compressSummaryMessages(out, budget), signal, options.maxReplyTokens);
      if (squeezed && estimateTokens(squeezed) < estimateTokens(out)) out = squeezed;
    }
    const trimmed = out.trim();
    // An EMPTY reply is a FAILURE, not a document. Fabricating "## Progress / No details
    // available." here was worse than useless: it PASSES the structural check while
    // carrying nothing, and it replaces the previous state instead of preserving it. The
    // caller turns this into the trim, which carries that state verbatim.
    return trimmed;
  }

  /** One one-shot summary request (no tools; `signal` lets Stop cancel it too). */
  private async requestSummary(
    messages: { role: "system" | "user"; content: string }[],
    signal?: AbortSignal,
    maxTokens?: number,
  ): Promise<string> {
    // The cap is the session's DECLARED max output when the caller knows it (see the note
    // in `summarize`): room for the model to reason and still answer.
    const cfg = this.buildConfig();
    const provider = this.factory.create(maxTokens ? { ...cfg, maxTokens } : cfg);
    let out = "";
    // No tools for a summary turn: pass [] so the provider never advertises
    // the (possibly orchestration) tool set during compaction.
    for await (const chunk of provider.stream(messages, signal, [])) {
      if (chunk.type === "text") out += chunk.content;
      if (out.length > 40000) break;
    }
    return out;
  }
}
