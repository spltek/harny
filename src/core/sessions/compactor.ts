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

const SUMMARY_PROMPT = `You are summarizing an old part of a coding session. Reply ONLY with a structured Markdown summary covering:
## Goal
## Constraints & Preferences
## Progress (Done / In Progress / Blocked)
## Key Decisions
## Next Steps
## Critical Context
Keep it concise. Do not invent details absent from the transcript.

<transcript>
`;

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
      return `## Goal\n${fallbackTitle(first)}\n## Progress\nNo details available.\n`;
    }
    return trimmed;
  }
}
