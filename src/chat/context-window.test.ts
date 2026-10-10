import { describe, it, expect } from "vitest";
import {
  DEFAULT_CONTEXT_WINDOW,
  MAX_CONTEXT_WINDOW,
  MIN_CONTEXT_WINDOW,
  DEFAULT_OUTPUT_TOKENS,
  MAX_OUTPUT_TOKENS,
  MIN_OUTPUT_TOKENS,
  clampContextWindow,
  clampOutputTokens,
  toContextWindow,
  toOutputTokens,
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
