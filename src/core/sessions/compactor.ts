import type { ChatMessage } from "../history/types";
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
 * Manual compaction: always summarize a fraction of the CURRENT context.
 * Keeps the most recent `keepRecentFraction` of the estimated tokens and
 * summarizes the rest, so the fill % visibly drops even on small sessions.
 */
export function planManualCompaction(messages: ChatMessage[], keepRecentFraction = 0.6): CompactionPlan {
  const visible = messages.filter((m) => m.role !== "system" && !m.uiOnly);
  const tokensBefore = estimateTokens(serializeConversation(visible));
  if (visible.length <= 2) return { toSummarize: [], kept: visible, tokensBefore };

  const keepTokens = Math.max(1, tokensBefore * keepRecentFraction);
  const kept: ChatMessage[] = [];
  let acc = 0;
  for (let i = visible.length - 1; i >= 0; i--) {
    if (acc + estimateTokens(visible[i].content) > keepTokens && kept.length > 0) break;
    kept.unshift(visible[i]);
    acc += estimateTokens(visible[i].content);
  }
  // Force a visible reduction by message count when the token spread is too shallow.
  if (kept.length === visible.length) {
    const half = Math.floor(visible.length / 2);
    return { toSummarize: visible.slice(0, half), kept: visible.slice(half), tokensBefore };
  }
  const keptSet = new Set(kept);
  return { toSummarize: visible.filter((m) => !keptSet.has(m)), kept, tokensBefore };
}

const SUMMARY_PROMPT = `You are summarizing an old part of a coding session. The summary will REPLACE the transcript, so it must stand alone. Reply with EXACTLY TWO blocks separated by a line containing only "---" (three dashes):

BLOCK 1 — ONLY the fixed phrase "Summary of past interactions", TRANSLATED into the SAME language as the transcript. Output that phrase alone, nothing else (no punctuation, no extra words).
BLOCK 2 — a Markdown summary covering: Goal, Progress (Done / In Progress / Blocked), Key Decisions, Next Steps, Critical Context. Write it in the SAME language as the transcript. Be concise.

Do not invent details absent from the transcript.

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
): { role: "system" | "user"; content: string }[] {
  const text = serializeConversation(toSummarize);
  return [{ role: "system", content: SUMMARY_PROMPT + (previousSummary ? `\nPrevious summary:\n${previousSummary}\n` : "") }, { role: "user", content: text }];
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

  async summarize(toSummarize: ChatMessage[], previousSummary?: string): Promise<string> {
    const provider = this.factory.create(this.buildConfig());
    let out = "";
    // No tools for a summary turn: pass [] so the provider never advertises
    // the (possibly orchestration) tool set during compaction.
    for await (const chunk of provider.stream(buildSummaryMessages(toSummarize, previousSummary), undefined, [])) {
      if (chunk.type === "text") out += chunk.content;
      if (out.length > 40000) break;
    }
    const trimmed = out.trim();
    if (!trimmed) {
      const first = toSummarize.find((m) => m.role === "user")?.content ?? "";
      return `Summary of past interactions\n---\n## Goal\n${fallbackTitle(first)}\n## Progress\nNo details available.\n`;
    }
    return trimmed;
  }
}
