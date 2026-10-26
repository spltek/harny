import { describe, it, expect } from "vitest";
import {
  CHARS_PER_TOKEN,
  MIN_TOOL_OUTPUT_CHARS,
  TOOL_OUTPUT_BUDGET_SHARE,
  toolOutputCapChars,
  truncationNote,
} from "./output-budget";

const SHELL_CAP = 50_000;
const GREP_CAP = 30_000;

describe("toolOutputCapChars — the cap follows the model, not a constant", () => {
  it("keeps the tool's own ceiling for a big model (no behaviour change there)", () => {
    expect(toolOutputCapChars(SHELL_CAP, 200_000)).toBe(SHELL_CAP);
    expect(toolOutputCapChars(SHELL_CAP, 1_000_000)).toBe(SHELL_CAP);
    expect(toolOutputCapChars(GREP_CAP, 500_000)).toBe(GREP_CAP);
  });

  it("follows a SMALL window, where the old constant was the whole context", () => {
    // 8k usable: 50KB (~12k tokens) would be the entire window in ONE command.
    expect(toolOutputCapChars(SHELL_CAP, 8_000)).toBe(8_000 * TOOL_OUTPUT_BUDGET_SHARE * CHARS_PER_TOKEN);
    // 32k usable: 40% before, ~10% now.
    expect(toolOutputCapChars(SHELL_CAP, 32_000)).toBe(3_200 * CHARS_PER_TOKEN);
    // The same rule for Grep, which caps at 30KB.
    expect(toolOutputCapChars(GREP_CAP, 8_000)).toBe(3_200);
  });

  it("never returns more than the tool's ceiling, whatever the window", () => {
    for (const budget of [1_000, 8_000, 32_000, 128_000, 1_000_000]) {
      expect(toolOutputCapChars(GREP_CAP, budget)).toBeLessThanOrEqual(GREP_CAP);
      expect(toolOutputCapChars(SHELL_CAP, budget)).toBeLessThanOrEqual(SHELL_CAP);
    }
  });

  it("keeps a USEFUL floor even on a tiny window", () => {
    // A 2000-token window: 10% would be 800 characters, too little to act on.
    expect(toolOutputCapChars(SHELL_CAP, 2_000)).toBe(MIN_TOOL_OUTPUT_CHARS);
    expect(toolOutputCapChars(SHELL_CAP, 100)).toBe(MIN_TOOL_OUTPUT_CHARS);
    // …but a tool whose own ceiling is LOWER than the floor keeps its ceiling.
    expect(toolOutputCapChars(500, 2_000)).toBe(500);
  });

  it("falls back to the plain ceiling when no budget is known", () => {
    // Tools used outside a session (CLI, tests) must behave exactly as before.
    expect(toolOutputCapChars(SHELL_CAP)).toBe(SHELL_CAP);
    expect(toolOutputCapChars(SHELL_CAP, 0)).toBe(SHELL_CAP);
    expect(toolOutputCapChars(SHELL_CAP, NaN)).toBe(SHELL_CAP);
  });
});

describe("truncationNote — a dead end becomes a next step", () => {
  it("says how much was cut AND what to do about it", () => {
    const note = truncationNote(50_000);
    expect(note).toContain("50KB");
    expect(note).toMatch(/narrower|head\/tail\/grep/);
  });

  it("states the cap that was actually used, not a constant", () => {
    expect(truncationNote(8_000)).toContain("8KB");
    expect(truncationNote(8_000)).not.toContain("50KB");
  });

  it("never says 0KB (a sub-kilobyte cap still reads as a real limit)", () => {
    expect(truncationNote(200)).toContain("1KB");
  });
});
