import { describe, it, expect } from "vitest";
import { sanitizeTitle, fallbackTitle, MAX_TITLE_LENGTH } from "./title-generator";

describe("sanitizeTitle", () => {
  it("collapses newlines and trims", () => {
    expect(sanitizeTitle("  line one\nline two  ")).toBe("line one line two");
  });

  it("bounds to MAX_TITLE_LENGTH", () => {
    expect(sanitizeTitle("x".repeat(200)).length).toBe(MAX_TITLE_LENGTH);
  });
});

describe("fallbackTitle", () => {
  it("uses the first line of the message", () => {
    expect(fallbackTitle("Refactor auth\nand test")).toBe("Refactor auth");
  });

  it("defaults when empty", () => {
    expect(fallbackTitle("   ")).toBe("New Session");
  });

  it("keeps the raw text when no AI is available (no heuristics)", () => {
    // The descriptive title is the model's job; the fallback never classifies.
    expect(fallbackTitle("how is it going?")).toBe("how is it going?");
  });
});
