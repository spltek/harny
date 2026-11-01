import { describe, it, expect } from "vitest";
import { sanitizeTitle, MAX_TITLE_LENGTH } from "./title-generator";

describe("sanitizeTitle", () => {
  it("collapses newlines and trims", () => {
    expect(sanitizeTitle("  line one\nline two  ")).toBe("line one line two");
  });

  it("bounds to MAX_TITLE_LENGTH", () => {
    expect(sanitizeTitle("x".repeat(200)).length).toBe(MAX_TITLE_LENGTH);
  });
});
