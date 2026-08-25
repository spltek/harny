/** Temperature bounds and clamp shared by the spinner UI and the host. */
export const TEMPERATURE_MIN = 0;
export const TEMPERATURE_MAX = 2;
/** Amount/unit of the UI input (typing is unconstrained). */
export const TEMPERATURE_STEP = 0.1;

/**
 * Clamp/round any value into the valid range, one decimal.
 * Invalid (NaN/Infinity) -> undefined, meaning "Auto" = not sent, so strict
 * providers that reject the parameter keep working untouched.
 */
export function clampTemperature(v: number): number | undefined {
  if (!Number.isFinite(v)) return undefined;
  const clamped = Math.min(TEMPERATURE_MAX, Math.max(TEMPERATURE_MIN, v));
  return Math.round(clamped * 10) / 10;
}

/**
 * Coerce a JSON message value to a temperature.
 * null / undefined / NaN -> undefined ("Auto", not sent).
 */
export function toTemperature(v: unknown): number | undefined {
  if (v === null || v === undefined) return undefined;
  return clampTemperature(typeof v === "number" ? v : Number(v));
}