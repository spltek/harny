/**
 * How much raw output ONE tool result may carry.
 *
 * A FIXED cap is wrong for half the models Harny serves: Shell's 50KB is ~12k
 * tokens — the ENTIRE window of an 8k local model, 40% of a 32k one — so a single
 * command can fill the context by itself. And observation masking cannot rescue it:
 * that is the NEWEST result, the one the model is waiting for.
 *
 * So the cap follows the MODEL: a share of the USABLE budget, bounded above by the
 * ceiling each tool was already tuned with (big models keep the old behaviour) and
 * below by a floor that still leaves the output useful. Pure and provider-neutral:
 * it only needs the number the caller already tracks.
 */

/** The estimator's ratio, kept here so the cap and the footer can never disagree. */
export const CHARS_PER_TOKEN = 4;

/** The share of the usable window a single tool result may take. */
export const TOOL_OUTPUT_BUDGET_SHARE = 0.1;

/** Below this an output is useless (the model would re-run the same command). */
export const MIN_TOOL_OUTPUT_CHARS = 2_000;

/**
 * The character cap for one tool result. `absoluteCap` is the tool's own ceiling
 * (the value it was tuned with) and `contextBudget` the session's usable tokens;
 * an absent/zero budget means "not known" and yields the plain absolute cap, so a
 * tool used outside a session (tests, CLI) behaves exactly as before.
 */
export function toolOutputCapChars(absoluteCap: number, contextBudget?: number): number {
  const cap = Math.max(0, Math.round(absoluteCap));
  const budget = contextBudget ?? 0;
  if (!Number.isFinite(budget) || budget <= 0) return cap;
  const share = Math.floor(budget * TOOL_OUTPUT_BUDGET_SHARE) * CHARS_PER_TOKEN;
  const floor = Math.min(cap, MIN_TOOL_OUTPUT_CHARS);
  return Math.max(floor, Math.min(cap, share));
}

/**
 * What the model is told when output was cut — and what to DO about it. A bare
 * "truncated at 50KB" leaves it guessing; naming the move turns a dead end into a
 * next step.
 */
export function truncationNote(capChars: number): string {
  // Decimal KB, the convention the labels already used (a 50,000-character cap
  // reads as "50KB", not "49KB"): this is a message for a human, not a byte count.
  const kb = Math.max(1, Math.round(capChars / 1000));
  return `\n\n[Output truncated at ${kb}KB — re-run with a narrower scope (head/tail/grep) or ask for a specific part]`;
}
