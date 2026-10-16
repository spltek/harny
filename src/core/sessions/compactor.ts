import type { ChatMessage } from "../history/types";
import { turnEnd, turnStart } from "../history/conversation-validity";
import type { HarnyConfig } from "../config/types";
import type { LLMProviderFactory } from "../llm/types";
import { fallbackTitle } from "./title-generator";

export interface CompactionSettings {
  enabled: boolean;
  /** Context fill % of the declared context window that triggers auto-compaction. */
  thresholdPercent: number;
}

export const DEFAULT_COMPACTION: CompactionSettings = {
  enabled: true,
  thresholdPercent: 80,
};

export const MIN_COMPACTION_THRESHOLD_PERCENT = 1;
export const MAX_COMPACTION_THRESHOLD_PERCENT = 100;

/**
 * Output budget for the one-shot SUMMARY request. Deliberately INDEPENDENT of
 * the chat turn's `max_tokens`: the summary is a bounded, single-purpose call,
 * while a turn can be configured for hundreds of thousands of output tokens.
 * Since the provider counts `input + max_tokens` against the window, inheriting
 * the turn budget means the summary request itself gets rejected as too long —
 * the compaction fails silently (`auto-compaction failed; continuing`) and the
 * session keeps its full context. Decoupling it costs nothing and removes a
 * whole failure mode.
 */
export const SUMMARY_MAX_TOKENS = 8_192;

/**
 * The config a SUMMARY request runs with: the caller's config with the bounded
 * summary output budget substituted. Lives here (not in the composition root)
 * so the rule is testable and cannot be "simplified" back into inheriting the
 * chat turn's `max_tokens` — which is what made big-session compactions fail.
 */
export function summarizerConfig(cfg: HarnyConfig): HarnyConfig {
  return { ...cfg, maxTokens: SUMMARY_MAX_TOKENS };
}

/** Clamp/round any value into the valid threshold range (1%–100%). */
export function clampCompactionThresholdPercent(v: number): number {
  if (!Number.isFinite(v)) return DEFAULT_COMPACTION.thresholdPercent;
  return Math.min(MAX_COMPACTION_THRESHOLD_PERCENT, Math.max(MIN_COMPACTION_THRESHOLD_PERCENT, Math.round(v)));
}

/** Coerce a JSON message value to a number (NaN/undefined -> default 80). */
export function toCompactionThresholdPercent(v: unknown): number {
  return clampCompactionThresholdPercent(typeof v === "number" ? v : Number(v));
}

export interface CompactionPlan {
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
  return Math.ceil(text.length / 4);
}

/** True when the current context fill reaches the compaction threshold. */
export function shouldCompact(contextTokens: number, contextWindow: number, settings: CompactionSettings): boolean {
  const pct = Number.isFinite(settings.thresholdPercent) ? settings.thresholdPercent : DEFAULT_COMPACTION.thresholdPercent;
  return contextTokens > (contextWindow * pct) / 100;
}

/** Serialize messages to plain text for the summarizer (tool results truncated). */
export function serializeConversation(messages: ChatMessage[], toolResultLimit = 2000): string {
  return messages
    .filter((m) => m.role !== "system" && !m.uiOnly)
    .map((m) => {
      if (m.role === "assistant") return `[Assistant]: ${m.content}`;
      if (m.role === "tool") {
        const out = m.content.length > toolResultLimit ? `${m.content.slice(0, toolResultLimit)}… (+${m.content.length - toolResultLimit} chars)` : m.content;
        return `[Tool result]: ${out}`;
      }
      return `[User]: ${m.content}`;
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
  const base = beforeIdx >= 0 ? messages[beforeIdx].meta?.inputTokens ?? 0 : 0;
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
 * How much RECENT work is kept verbatim after a compaction, in tokens.
 *
 * An ABSOLUTE budget, not a fraction: a fraction of the history keeps ~600k on a
 * 1M window and frees almost nothing (the bug this replaces), while the recent
 * work that actually matters — the task at hand, its files, its last results — is
 * bounded whatever the window. Same choice as the reference agents (pi keeps 20k
 * recent tokens, OpenCode ~15k) and the reason their compactions buy room for a
 * long stretch of turns.
 */
export const KEEP_RECENT_TOKENS = 20_000;

/** Never keep fewer than this, or the model loses the task it was doing. */
export const MIN_KEEP_RECENT_TOKENS = 8_000;

/**
 * The verbatim tail a compaction should keep for a given usable budget: a small
 * share of the window, bounded by {@link KEEP_RECENT_TOKENS}. It scales DOWN on
 * small models (where 20k would be most of the window), never up on big ones.
 */
export function keepRecentTokensFor(usableTokens: number): number {
  const share = Math.round(Math.max(0, usableTokens) * 0.05);
  return Math.min(KEEP_RECENT_TOKENS, Math.max(MIN_KEEP_RECENT_TOKENS, share));
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

  const budget = Math.max(1, keepTokens);
  // Walk BACKWARDS from the newest message, accumulating the recent side.
  let start = visible.length;
  let acc = 0;
  for (let i = visible.length - 1; i >= 0; i--) {
    if (acc + estimateTokens(visible[i].content) > budget && start < visible.length) break;
    start = i;
    acc += estimateTokens(visible[i].content);
  }
  // Nothing worth keeping (one huge message fills the budget on its own):
  // summarize half by count rather than keep the whole conversation alive.
  if (start === 0) start = Math.floor(visible.length / 2);
  // A cut must never leave half a turn: what is KEPT is a sequence of complete
  // groups (input → final answer, everything in between).
  start = snapCutToGroup(visible, start);
  return { toSummarize: visible.slice(0, start), kept: visible.slice(start), tokensBefore };
}

/**
 * Manual compaction: summarize a FRACTION of the current context. Kept as the
 * entry point of the fraction-based policy (and its tests); the HOST uses
 * {@link planCompactionToBudget} with {@link keepRecentTokensFor} instead, because
 * an absolute recent budget is what makes a compaction actually free room.
 */
export function planManualCompaction(messages: ChatMessage[], keepRecentFraction = 0.6): CompactionPlan {
  const visible = messages.filter((m) => m.role !== "system" && !m.uiOnly);
  const tokensBefore = estimateTokens(serializeConversation(visible));
  if (visible.length <= 2) return { toSummarize: [], kept: visible, tokensBefore };
  return planCompactionToBudget(messages, Math.max(1, tokensBefore * keepRecentFraction));
}

const SUMMARY_PROMPT = `You are summarizing an OLD part of a coding session. The summary REPLACES that span, so it must stand alone — but it is also CONTEXT: every token you write is a token the session cannot spend on real work. Its only job is to let the next turns reconstruct what was decided and what comes next.

Write the MINIMUM that does that, as SCHEMATIC LISTS — never prose:
- fragments, not sentences; one bullet per fact, one line each, most important first;
- no restating the transcript, no examples, no code blocks (name the file and the symbol instead), no pleasantries, no "the user asked…" narration;
- scale the LENGTH to the COMPLEXITY of the work: a simple task gets a handful of bullets, a long one more — never padding, never a template filled for its own sake;
- OMIT anything the transcript AFTER this span already shows, and anything re-derivable by reading the code;
- KEEP exact names, paths, numbers, commands and constraints: those are the facts nothing else carries.

Reply with EXACTLY TWO blocks separated by a line containing only "---" (three dashes):

BLOCK 1 — ONLY the fixed phrase "Summary of past interactions", TRANSLATED into the SAME language as the transcript. Output that phrase alone, nothing else (no punctuation, no extra words).

BLOCK 2 — a Markdown summary with these headings, IN THIS ORDER, including ONLY the ones that have something under them (an empty heading is just padding — drop it):
## Goal    — what was asked, one line
## Done    — bullets: what is finished, and the decisions taken with the reason when it is not obvious
## Open    — bullets: what is in progress or blocked, and on what
## Next    — bullets: the exact next steps
## Facts   — bullets: what the next turns cannot guess (paths, commands, values, constraints, gotchas)

Write it in the SAME language as the transcript. Never invent details absent from the transcript.

<transcript>
`;

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
  return [{ role: "system", content: SUMMARY_PROMPT + budget + kept + (previousSummary ? `\nPrevious summary:\n${previousSummary}\n` : "") }, { role: "user", content: text }];
}

/**
 * How full the context should be RIGHT AFTER a compaction, as a fraction of the
 * usable budget. Compaction exists to buy room, so it aims at a comfortable level
 * instead of merely dipping under the trigger.
 */
export const POST_COMPACT_TARGET_FRACTION = 0.5;

/** A summary smaller than this is not worth having: too little to continue from. */
export const MIN_SUMMARY_TOKENS = 512;

/** Overshoot tolerated before the summary is squeezed a second time (+15%). */
const SUMMARY_OVERSHOOT = 1.15;

/**
 * The token budget the summary itself gets: the room left between the KEPT part
 * and the post-compaction target.
 *
 * This is what keeps a compaction from "not freeing enough": a verbose summary
 * eats the very context it just freed, and the effect worsens as the window
 * shrinks (on a small model the same summary is a much larger share). The floor
 * exists because a summary must stay usable — when the KEPT part alone already
 * exceeds the target, the summary cannot fix it, and shrinking the tail is a
 * different lever.
 */
export function summaryBudgetTokens(usableTokens: number, keptTokens: number): number {
  const target = Math.floor(Math.max(0, usableTokens) * POST_COMPACT_TARGET_FRACTION);
  return Math.max(MIN_SUMMARY_TOKENS, target - Math.max(0, keptTokens));
}

const COMPRESS_PROMPT = `You are COMPRESSING a summary that is too long for the context budget. Reply with EXACTLY the same two-block structure as the input (block 1: the fixed phrase, in the SAME language as the input; then a line with only "---"; block 2: the compressed Markdown summary).

Keep every fact needed to continue the work: Goal, Progress (Done / In Progress / Blocked), Key Decisions, Next Steps, Critical Context. DROP prose, repetitions, examples, and anything already visible in the kept transcript. Prefer short bullets over sentences.

Budget: the result must stay under roughly `;

/** The second pass: rewrite an oversized summary under an explicit token cap. */
function compressSummaryMessages(summary: string, maxSummaryTokens: number): { role: "system" | "user"; content: string }[] {
  return [
    { role: "system", content: `${COMPRESS_PROMPT}${maxSummaryTokens} tokens.\n\n<summary>\n` },
    { role: "user", content: summary },
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

  async summarize(
    toSummarize: ChatMessage[],
    previousSummary?: string,
    signal?: AbortSignal,
    options: { maxSummaryTokens?: number; keptPreview?: string } = {},
  ): Promise<string> {
    const budget = options.maxSummaryTokens;
    let out = await this.requestSummary(
      buildSummaryMessages(toSummarize, previousSummary, budget, options.keptPreview),
      signal,
    );
    // Still oversized when measured (the instruction is a request, not a limit):
    // ONE compression pass, and only the SHORTER of the two is kept. Bounded to a
    // single extra call on purpose — a loop over a summary would spend more
    // context than it frees.
    if (budget && budget > 0 && out && estimateTokens(out) > Math.ceil(budget * SUMMARY_OVERSHOOT)) {
      const squeezed = await this.requestSummary(compressSummaryMessages(out, budget), signal);
      if (squeezed && estimateTokens(squeezed) < estimateTokens(out)) out = squeezed;
    }
    const trimmed = out.trim();
    if (!trimmed) {
      const first = toSummarize.find((m) => m.role === "user")?.content ?? "";
      return `Summary of past interactions\n---\n## Goal\n${fallbackTitle(first)}\n## Progress\nNo details available.\n`;
    }
    return trimmed;
  }

  /** One one-shot summary request (no tools; `signal` lets Stop cancel it too). */
  private async requestSummary(
    messages: { role: "system" | "user"; content: string }[],
    signal?: AbortSignal,
  ): Promise<string> {
    const provider = this.factory.create(this.buildConfig());
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
