import { describe, it, expect } from "vitest";
import {
  CONTEXT_SLIDER_STEP,
  DEFAULT_CONTEXT_WINDOW,
  MAX_CONTEXT_WINDOW,
  MIN_CONTEXT_WINDOW,
  DEFAULT_OUTPUT_TOKENS,
  MAX_OUTPUT_TOKENS,
  MIN_OUTPUT_TOKENS,
  OUTPUT_SLIDER_STEP,
  REQUEST_SAFETY_MARGIN,
  clampAdoptedContextWindow,
  clampAdoptedOutputTokens,
  clampContextWindow,
  clampOutputTokens,
  reachableStep,
  toContextWindow,
  toOutputTokens,
  usableContext,
} from "./context-window";

describe("context-window bounds", () => {
  it("clamps into the global range, rounds, and defaults on invalid input", () => {
    expect(clampContextWindow(0)).toBe(MIN_CONTEXT_WINDOW);
    expect(clampContextWindow(9_999_999)).toBe(MAX_CONTEXT_WINDOW);
    expect(clampContextWindow(123_456.7)).toBe(123_457);
    expect(clampContextWindow(Number.NaN)).toBe(DEFAULT_CONTEXT_WINDOW);
  });

  it("honors a LOWER per-model max (never above it)", () => {
    expect(clampContextWindow(200_000, 128_000)).toBe(128_000);
    expect(clampContextWindow(64_000, 128_000)).toBe(64_000);
    // A max below MIN is raised to MIN (the slider never goes under it).
    expect(clampContextWindow(50_000, 1_000)).toBe(MIN_CONTEXT_WINDOW);
    // Invalid input with a low max caps at that max (not the global default).
    expect(clampContextWindow(Number.NaN, 64_000)).toBe(64_000);
  });

  it("toContextWindow coerces JSON values", () => {
    expect(toContextWindow("128000")).toBe(128_000);
    expect(toContextWindow(undefined)).toBe(DEFAULT_CONTEXT_WINDOW);
  });
});

describe("usableContext (the input's real budget)", () => {
  it("subtracts the response reserve from the window", () => {
    // The session that died: 1M window with a 384k output budget leaves only
    // 664k for the input — which is where the 400 came from.
    expect(usableContext(1_048_576, 384_000)).toBe(664_576);
    expect(usableContext(128_000, 16_384)).toBe(111_616);
    expect(usableContext(32_768, 0)).toBe(32_768);
  });

  it("never returns a non-positive budget (a contradictory config must not invert the math)", () => {
    expect(usableContext(128_000, 128_000)).toBe(1);
    expect(usableContext(128_000, 999_999)).toBe(1);
    expect(usableContext(0, 0)).toBe(1);
  });

  it("rounds both sides, so a fractional config cannot leak into the bar", () => {
    expect(usableContext(100_000.4, 8_000.6)).toBe(100_000 - 8_001);
  });

  it("exposes the margin used by the request clamp", () => {
    // The clamp is conservative on purpose: it covers the messages appended
    // after the last measured usage (the counter lags by exactly those).
    expect(REQUEST_SAFETY_MARGIN).toBeGreaterThan(0);
  });
});

describe("output-token bounds", () => {
  it("clamps into the global range and defaults on invalid input", () => {
    expect(clampOutputTokens(0)).toBe(MIN_OUTPUT_TOKENS);
    expect(clampOutputTokens(9_999_999)).toBe(MAX_OUTPUT_TOKENS);
    expect(clampOutputTokens(Number.NaN)).toBe(DEFAULT_OUTPUT_TOKENS);
  });

  it("honors a LOWER per-model max", () => {
    expect(clampOutputTokens(50_000, 16_384)).toBe(16_384);
    expect(clampOutputTokens(8_000, 16_384)).toBe(8_000);
    expect(clampOutputTokens(Number.NaN, 8_192)).toBe(8_192);
  });

  it("toOutputTokens coerces JSON values", () => {
    expect(toOutputTokens("16384")).toBe(16_384);
    expect(toOutputTokens(undefined)).toBe(DEFAULT_OUTPUT_TOKENS);
  });
});

describe("reachableStep — a slider must be able to REACH its own maximum", () => {
  it("keeps the nominal step when it divides the range", () => {
    expect(reachableStep(MIN_CONTEXT_WINDOW, MAX_CONTEXT_WINDOW, CONTEXT_SLIDER_STEP)).toBe(CONTEXT_SLIDER_STEP);
    expect(reachableStep(MIN_OUTPUT_TOKENS, MAX_OUTPUT_TOKENS, OUTPUT_SLIDER_STEP)).toBe(OUTPUT_SLIDER_STEP);
  });

  it("falls back to 1 when it does not (the thumb stopped short of a real limit)", () => {
    // A detected 7 963-token window with a 256 step: 7 963 was unreachable.
    expect(reachableStep(MIN_CONTEXT_WINDOW, 7_963, 1_000)).toBe(1);
    // Degenerate ranges never divide by surprise either.
    expect(reachableStep(1_000, 1_000, 1_000)).toBe(1);
  });
});

describe("adopted (model-reported) values follow the model (no MIN, no global cap)", () => {
  it("keeps a model's REAL context", () => {
    expect(clampAdoptedContextWindow(8000)).toBe(8000);
    expect(clampAdoptedContextWindow(4000)).toBe(4000);
    // The scale follows the model: a large real context is NOT capped.
    expect(clampAdoptedContextWindow(9_999_999)).toBe(9_999_999);
    expect(clampAdoptedContextWindow(Number.NaN)).toBe(DEFAULT_CONTEXT_WINDOW);
  });

  it("keeps a model's REAL max output", () => {
    expect(clampAdoptedOutputTokens(128)).toBe(128);
    expect(clampAdoptedOutputTokens(9_999_999)).toBe(9_999_999);
    expect(clampAdoptedOutputTokens(Number.NaN)).toBe(DEFAULT_OUTPUT_TOKENS);
  });
});
