import { describe, it, expect } from "vitest";
import { PANEL_REFERENCE_WIDTH, panelMinWidthCss } from "./panel-width";

describe("panelMinWidthCss", () => {
  it("builds the floor from the reference width, keeping the font-scaled part", () => {
    expect(panelMinWidthCss()).toBe("max(600px, 32rem)");
    expect(panelMinWidthCss(PANEL_REFERENCE_WIDTH)).toBe("max(600px, 32rem)");
  });

  it("rounds the width and never emits a negative floor", () => {
    expect(panelMinWidthCss(720.4)).toBe("max(720px, 32rem)");
    expect(panelMinWidthCss(-40)).toBe("max(0px, 32rem)");
  });

  it("the reference is the width Harny guarantees: a shrink TOLERANCE over the measured minimum", () => {
    // 450px is the measured minimum at which the controls still fit (see the
    // module doc); the reference keeps a deliberate margin on top of it, which is
    // exactly what you feel when dragging the panel narrower. Asserting the
    // relationship (not just the number) keeps a future edit from silently
    // removing the tolerance and making the scrollbar appear on the first drag.
    expect(PANEL_REFERENCE_WIDTH).toBeGreaterThan(450);
    expect(PANEL_REFERENCE_WIDTH - 450).toBeGreaterThanOrEqual(100);
  });
});
