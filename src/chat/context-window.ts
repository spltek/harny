/** Context-window bounds and clamp shared by the spinner UI and the host. */
export const DEFAULT_CONTEXT_WINDOW = 128_000;
export const MIN_CONTEXT_WINDOW = 32_000;
export const MAX_CONTEXT_WINDOW = 2_000_000;
/** Amount the +/- spinner buttons adjust the value by (typing is unconstrained). */
export const CONTEXT_STEP = 16_000;

/** Clamp/round any value into the valid integer range; invalid -> default. */
export function clampContextWindow(v: number): number {
  if (!Number.isFinite(v)) return DEFAULT_CONTEXT_WINDOW;
  return Math.min(MAX_CONTEXT_WINDOW, Math.max(MIN_CONTEXT_WINDOW, Math.round(v)));
}

/** Coerce a JSON message value to a number (NaN/undefined -> default). */
export function toContextWindow(v: unknown): number {
  return clampContextWindow(typeof v === "number" ? v : Number(v));
}

// ── Output tokens (max tokens per response) ──────────────────────────────────
/** Default max output tokens per response. */
export const DEFAULT_OUTPUT_TOKENS = 8192;
export const MIN_OUTPUT_TOKENS = 256;
export const MAX_OUTPUT_TOKENS = 65_536;
/** Amount the +/- spinner buttons adjust the value by (typing is unconstrained). */
export const OUTPUT_STEP = 512;

/** Clamp/round any value into the valid integer range; invalid -> default. */
export function clampOutputTokens(v: number): number {
  if (!Number.isFinite(v)) return DEFAULT_OUTPUT_TOKENS;
  return Math.min(MAX_OUTPUT_TOKENS, Math.max(MIN_OUTPUT_TOKENS, Math.round(v)));
}

/** Coerce a JSON message value to a number (NaN/undefined -> default). */
export function toOutputTokens(v: unknown): number {
  return clampOutputTokens(typeof v === "number" ? v : Number(v));
}
