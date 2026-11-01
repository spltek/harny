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
export const MAX_CONTEXT_WINDOW = 2_000_000;
/** Nominal slider step for the context window (see `reachableStep`). */
export const CONTEXT_SLIDER_STEP = 1_000;

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

/**
 * Tokens the INPUT may occupy for a request to still be accepted.
 *
 * The provider counts `input + max_tokens` against the context window, so the
 * input alone can never use the whole window: the room reserved for the
 * response (the `max_tokens` actually sent) is subtracted here. Measuring the
 * fill against the RAW window is what made Harny's bar read 66% while the
 * provider was already refusing the request at 63% (1M window, 384k output).
 */
export function usableContext(window: number, reserve: number): number {
  const w = Math.max(0, Math.round(window));
  const r = Math.max(0, Math.round(reserve));
  return Math.max(1, w - r);
}

/**
 * Safety margin subtracted when clamping the output budget to the room left.
 * It absorbs what the measured input does not yet include: the messages
 * appended after the last reported usage (the footer counter lags by exactly
 * those) plus provider/estimator drift. Never subtracted from the declared
 * budget (that one is exact); it only makes the CLAMP more conservative.
 */
export const REQUEST_SAFETY_MARGIN = 8_192;

/**
 * The margin as a SHARE of the window, so it scales down on small models instead
 * of swallowing them: a fixed 8192 is 8% of a 100k model but 100% of an 8k one.
 * The clamp uses `min(REQUEST_SAFETY_MARGIN, window × this)`.
 */
export const REQUEST_SAFETY_MARGIN_SHARE = 0.05;

/**
 * A step that makes `max` REACHABLE: the nominal step when it divides the range
 * (nice snapping), otherwise 1. A step that does not divide made the thumb stop
 * just short of a model's detected maximum (e.g. max 7 963 with step 256).
 * Shared with the host, which sends the same steps for the alert's sliders.
 */
export function reachableStep(min: number, max: number, nominal: number): number {
  const span = max - min;
  return span > 0 && span % nominal === 0 ? nominal : 1;
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
export const DEFAULT_OUTPUT_TOKENS = 8_192;
export const MIN_OUTPUT_TOKENS = 8;
/** FALLBACK ceiling when a model's max output is UNKNOWN. An identified model
 * uses its own (possibly higher) limit instead. */
export const MAX_OUTPUT_TOKENS = 524_288;
/** Nominal slider step for the output budget: 8 (not 256) because MIN is 8, so
 * the RANGE must stay a multiple of the step or the thumb could never REACH the
 * ceiling. 8 divides 524 288 − 8 exactly, and still snaps every real model
 * maximum (16 384, 32 768, 131 072…) to itself. */
export const OUTPUT_SLIDER_STEP = 8;

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
