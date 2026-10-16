/**
 * Observation masking: old tool results are replaced, IN THE REQUEST ONLY, by a
 * one-line stub.
 *
 * Why it exists. In an agent loop the tool outputs ARE the context: read files,
 * grep dumps, command logs. They are also the part with the worst value-per-token
 * ratio, because the model has already extracted what it needed from most of them
 * long ago — while the conversation itself (what was asked, what was decided) stays
 * valuable for a long time. Measured on SWE-bench, masking old observations beat
 * summarizing them outright (JetBrains: −52% cost, +2.6% solve rate).
 *
 * So: keep the NEWEST tool output verbatim, stub the rest. The mask is a view, not
 * a rewrite — nothing is lost on disk, the transcript still shows every result, and
 * a branch or a re-open keeps the full data. The model can always re-run the tool.
 *
 * Provider-neutral by construction: only the `content` of `tool` messages changes.
 * Roles and `toolCallId`s are untouched, so the wire rules (conversation-validity)
 * cannot be affected, and the stub is plain text on purpose: no provider-specific
 * formatting, no images, no structures some backend might reject.
 *
 * Model-neutral by construction: the budget is a SHARE of the usable window, so a
 * small local model masks earlier and a big one keeps much more.
 */

/** A tool result smaller than this is not worth masking: the stub costs nearly as
 * much as the content and the information would be lost for nothing. */
export const MASK_MIN_TOKENS = 256;

/** Bounds of the verbatim tool-output budget: scaled by the window, capped. */
export const MASK_KEEP_MIN_TOKENS = 8_000;
export const MASK_KEEP_MAX_TOKENS = 120_000;

/**
 * How much recent tool OUTPUT stays verbatim: a share of the usable window,
 * bounded. Independent of any tokenizer (it is a fraction of a budget we already
 * track) and of any provider.
 */
export function maskKeepTokens(usableTokens: number): number {
  const usable = Math.max(0, usableTokens);
  const floor = Math.min(MASK_KEEP_MIN_TOKENS, Math.round(usable * 0.25));
  return Math.min(MASK_KEEP_MAX_TOKENS, Math.max(floor, Math.round(usable * 0.2)));
}

/** What the model sees instead of an old result. Names the tool when known, so it
 * can decide whether re-running is worth it. */
export function maskedResultStub(toolName: string | undefined, tokens: number): string {
  const who = toolName ? `${toolName} output` : "Tool output";
  return `[${who} masked to save context: ~${tokens} tokens. Re-run the tool if you need this data again.]`;
}

/** The subset of a message this module needs (structural: ChatMessage and
 * LLMMessage both satisfy it). */
export interface MaskableMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string;
  toolCalls?: { id?: string; name?: string }[];
  toolCallId?: string;
  uiOnly?: boolean;
}

export interface MaskingResult<T> {
  messages: T[];
  /** How many results were masked. */
  masked: number;
  /** Tokens the request no longer carries. */
  savedTokens: number;
}

/**
 * Mask the OLD tool results, walking backwards from the newest: the latest result
 * (the one the model is working on) and everything whose output fits in
 * `keepTokens` stay untouched; every older result big enough to be worth it becomes
 * a stub. Returns a NEW array (immutable) — the caller's history is never modified.
 */
export function maskOldToolResults<T extends MaskableMessage>(
  messages: T[],
  keepTokens: number,
  estimate: (text: string) => number,
): MaskingResult<T> {
  // Tool name per call id, so the stub can say WHICH tool produced the output.
  const nameById = new Map<string, string>();
  for (const m of messages) {
    for (const tc of m.toolCalls ?? []) {
      if (tc.id && tc.name) nameById.set(tc.id, tc.name);
    }
  }

  const out = messages.slice();
  let budget = Math.max(0, keepTokens);
  let masked = 0;
  let savedTokens = 0;
  // The NEWEST result is never masked, even when it alone exceeds the budget:
  // it is the answer to what the model just asked, and a stub where the data
  // should be would break the very next step of the loop.
  let seenNewest = false;

  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "tool") continue;
    const tokens = estimate(m.content ?? "");
    if (!seenNewest) {
      seenNewest = true;
      budget -= tokens;
      continue;
    }
    if (tokens <= budget) {
      // Still inside the verbatim window: keep it (and spend the budget).
      budget -= tokens;
      continue;
    }
    if (tokens < MASK_MIN_TOKENS) continue; // too small to be worth a stub
    out[i] = { ...m, content: maskedResultStub(m.toolCallId ? nameById.get(m.toolCallId) : undefined, tokens) };
    masked++;
    savedTokens += tokens - estimate(out[i].content ?? "");
  }

  return { messages: out, masked, savedTokens };
}
