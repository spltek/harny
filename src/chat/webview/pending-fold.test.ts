import { describe, it, expect } from "vitest";
import { ONE_LINE_TOLERANCE_PX, needsCollapseControl } from "./pending-fold";

describe("needsCollapseControl — the per-bubble fold appears only on real overflow", () => {
  it("fits exactly one line: no fold (nothing to open)", () => {
    expect(needsCollapseControl(18, 18)).toBe(false);
    expect(needsCollapseControl(18, 18.4)).toBe(false); // sub-pixel, still one line
    expect(needsCollapseControl(18, 19)).toBe(false); // exactly the tolerance
  });

  it("wraps to two lines or more: the fold is warranted", () => {
    expect(needsCollapseControl(18, 19.1)).toBe(true);
    expect(needsCollapseControl(18, 36)).toBe(true);
    expect(needsCollapseControl(18, 540)).toBe(true); // a pasted 30-line block
  });

  it("without a measurable line height, NO fold (never offer what we cannot justify)", () => {
    // A hidden container reports 0: the answer stays false and the next render or
    // resize re-measures, instead of showing a control on a guess.
    expect(needsCollapseControl(0, 0)).toBe(false);
    expect(needsCollapseControl(0, 500)).toBe(false);
    expect(needsCollapseControl(NaN, 500)).toBe(false);
  });

  it("depends on the WIDTH, not on the text: the same height answers the same way", () => {
    // Two messages, one long and one short, land on the same number of lines once
    // laid out — the rule cannot tell them apart, and must not try to.
    expect(needsCollapseControl(18, 36)).toBe(needsCollapseControl(18, 36));
    // A one-line message on a narrow panel reaches 2 lines: same call, different
    // measurement, which is exactly why the caller measures.
    expect(needsCollapseControl(18, 18)).toBe(false);
    expect(needsCollapseControl(18, 36)).toBe(true);
  });

  it("states its tolerance explicitly, so the CSS clip can match it", () => {
    expect(ONE_LINE_TOLERANCE_PX).toBeGreaterThan(0);
    expect(ONE_LINE_TOLERANCE_PX).toBeLessThan(4);
  });
});
