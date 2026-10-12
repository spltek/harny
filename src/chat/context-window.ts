/**
 * Context-window / output-token bounds shared by the host and the webview.
 *
 * Model: for an IDENTIFIED model the slider SCALE is the model's real maximum
 * (which may exceed the global fallback), and the VALUE defaults to that same
 * maximum. For an UNIDENTIFIED model the scale is the global fallback
 * (`MAX_CONTEXT_WINDOW` / `MAX_OUTPUT_TOKENS`) and the value is the default.
 */

// ── Context window ───────────────────────────────────────────────────────────
export const DEFAULT_CONTEXT_WINDOW = 128_000;
export const MIN_CONTEXT_WINDOW = 1_000;
/** FALLBACK ceiling when a model's context window is UNKNOWN. An identified
 * model uses its own (possibly higher) limit instead. */
export const MAX_CONTEXT_WINDOW = 2_048_000;
/** Amount the +/- spinner buttons adjust the value by (typing is unconstrained). */
export const CONTEXT_STEP = 16_000;

/**
 * Clamp/round a value into `[MIN, max]`; invalid -> default. `max` is the
 * EFFECTIVE ceiling (the model's own limit when known, else the global
 * fallback) and is NOT additionally capped by the global value.
 */
export function clampContextWindow(v: number, max: number = MAX_CONTEXT_WINDOW): number {
  const hi = Math.max(MIN_CONTEXT_WINDOW, Math.round(max));
  if (!Number.isFinite(v)) return Math.min(hi, DEFAULT_CONTEXT_WINDOW);
  return Math.min(hi, Math.max(MIN_CONTEXT_WINDOW, Math.round(v)));
}

/** Coerce a JSON message value to a number (NaN/undefined -> default). */
export function toContextWindow(v: unknown): number {
  return clampContextWindow(typeof v === "number" ? v : Number(v));
}

/**
 * Clamp an ADOPTED (model-reported) value. Neither the slider MINIMUM nor the
 * global ceiling applies: a small model keeps its real (small) context and a
 * large model keeps its real (large) context — the scale follows the model.
 */
export function clampAdoptedContextWindow(v: number): number {
  if (!Number.isFinite(v) || v <= 0) return DEFAULT_CONTEXT_WINDOW;
  return Math.round(v);
}

// ── Output tokens (max tokens per response) ──────────────────────────────────
/** Default max output tokens per response (the value for an unknown model). */
export const DEFAULT_OUTPUT_TOKENS = 16_384;
export const MIN_OUTPUT_TOKENS = 256;
/** FALLBACK ceiling when a model's max output is UNKNOWN. An identified model
 * uses its own (possibly higher) limit instead. */
export const MAX_OUTPUT_TOKENS = 512_000;

/**
 * Clamp/round a value into `[MIN, max]`; invalid -> default. `max` is the
 * EFFECTIVE ceiling (the model's own limit when known, else the global
 * fallback) and is NOT additionally capped by the global value.
 */
export function clampOutputTokens(v: number, max: number = MAX_OUTPUT_TOKENS): number {
  const hi = Math.max(MIN_OUTPUT_TOKENS, Math.round(max));
  if (!Number.isFinite(v)) return Math.min(hi, DEFAULT_OUTPUT_TOKENS);
  return Math.min(hi, Math.max(MIN_OUTPUT_TOKENS, Math.round(v)));
}

/** Coerce a JSON message value to a number (NaN/undefined -> default). */
export function toOutputTokens(v: unknown): number {
  return clampOutputTokens(typeof v === "number" ? v : Number(v));
}

/**
 * Clamp an ADOPTED (model-reported) max output. Neither the slider MINIMUM nor
 * the global ceiling applies: the scale follows the model's real limit.
 */
export function clampAdoptedOutputTokens(v: number): number {
  if (!Number.isFinite(v) || v <= 0) return DEFAULT_OUTPUT_TOKENS;
  return Math.round(v);
}
