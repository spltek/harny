/** Context-window bounds and clamp shared by the spinner UI and the host. */
export const DEFAULT_CONTEXT_WINDOW = 128_000;
export const MIN_CONTEXT_WINDOW = 1_000;
export const MAX_CONTEXT_WINDOW = 2_000_000;
/** Amount the +/- spinner buttons adjust the value by (typing is unconstrained). */
export const CONTEXT_STEP = 16_000;

/** Clamp/round any value into [MIN, max]; invalid -> default. `max` defaults to
 * the global ceiling but can be LOWERED to a model's detected context window. */
export function clampContextWindow(v: number, max: number = MAX_CONTEXT_WINDOW): number {
  const hi = Math.min(MAX_CONTEXT_WINDOW, Math.max(MIN_CONTEXT_WINDOW, Math.round(max)));
  if (!Number.isFinite(v)) return Math.min(hi, DEFAULT_CONTEXT_WINDOW);
  return Math.min(hi, Math.max(MIN_CONTEXT_WINDOW, Math.round(v)));
}

/** Coerce a JSON message value to a number (NaN/undefined -> default). */
export function toContextWindow(v: unknown): number {
  return clampContextWindow(typeof v === "number" ? v : Number(v));
}

/**
 * Clamp an ADOPTED (model-reported) value: only the global CEILING applies — a
 * small model's real context must NOT be raised to the slider minimum.
 */
export function clampAdoptedContextWindow(v: number): number {
  if (!Number.isFinite(v) || v <= 0) return DEFAULT_CONTEXT_WINDOW;
  return Math.min(MAX_CONTEXT_WINDOW, Math.round(v));
}

// ── Output tokens (max tokens per response) ──────────────────────────────────
/** Default max output tokens per response. */
export const DEFAULT_OUTPUT_TOKENS = 16_384;
export const MIN_OUTPUT_TOKENS = 256;
export const MAX_OUTPUT_TOKENS = 262_144;

/** Clamp/round any value into [MIN, max]; invalid -> default. `max` defaults to
 * the global ceiling but can be LOWERED to a model's detected max output. */
export function clampOutputTokens(v: number, max: number = MAX_OUTPUT_TOKENS): number {
  const hi = Math.min(MAX_OUTPUT_TOKENS, Math.max(MIN_OUTPUT_TOKENS, Math.round(max)));
  if (!Number.isFinite(v)) return Math.min(hi, DEFAULT_OUTPUT_TOKENS);
  return Math.min(hi, Math.max(MIN_OUTPUT_TOKENS, Math.round(v)));
}

/** Coerce a JSON message value to a number (NaN/undefined -> default). */
export function toOutputTokens(v: unknown): number {
  return clampOutputTokens(typeof v === "number" ? v : Number(v));
}

/** Clamp an ADOPTED (model-reported) max output: only the global CEILING applies. */
export function clampAdoptedOutputTokens(v: number): number {
  if (!Number.isFinite(v) || v <= 0) return DEFAULT_OUTPUT_TOKENS;
  return Math.min(MAX_OUTPUT_TOKENS, Math.round(v));
}
