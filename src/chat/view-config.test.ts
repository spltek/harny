import { describe, expect, it } from "vitest";
import { PALETTES } from "./view-config";

/**
 * The palette's ROLES, as relationships instead of values.
 *
 * A colour test that asserted hex codes would fail on every taste change and
 * teach nothing. What must hold is how the roles relate: which surface sits above
 * which, in BOTH themes — with the direction of "above" flipping between them
 * (on near-black you rise by getting lighter, on paper by getting darker).
 *
 * The bug this was written after: `tool-bg` (code blocks, inline code) was
 * #f7f4f1 against an #f4f1ed answer bubble — i.e. code sat ABOVE the card in the
 * light theme and BELOW it in the dark one. Same role, opposite meaning, and
 * nothing in the suite noticed: the palette tests only checked that a role
 * EXISTS in both themes, never what it means.
 */

/** #rrggbb → relative luminance (the 0.2126/0.7152/0.0722 weighting). */
function lum(hex: string): number {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m)
    throw new Error(`not a plain #rrggbb colour: ${hex} — this test compares surfaces, so an rgba() has no place here`);
  const [r, g, b] = [m[1], m[2], m[3]].map((h) => parseInt(h, 16));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** How far a surface is from the page, unsigned: "how much it stands out". */
function separation(p: (typeof PALETTES)["dark"], role: "tool-bg" | "assistant-msg" | "surface-2"): number {
  return Math.abs(lum(p[role]) - lum(p.bg));
}

describe("palette surfaces", () => {
  it("keeps the code block RECESSED inside the answer card, in both themes", () => {
    for (const [name, p] of Object.entries(PALETTES)) {
      // Darker ink than the card in the dark theme, darker paper in the light one:
      // the SAME relationship, which is the point.
      expect(lum(p["tool-bg"]), `${name}: tool-bg must sit below assistant-msg`).toBeLessThan(lum(p["assistant-msg"]));
    }
    // …and not by a hair: at these sizes a 1–2 point gap is a rounding error, not a
    // surface. The fix that introduced this test moved the light gap from −3 (wrong
    // direction anyway) to 6.
    for (const [name, p] of Object.entries(PALETTES)) {
      const gap = lum(p["assistant-msg"]) - lum(p["tool-bg"]);
      expect(gap, `${name}: the code/card step must be visible`).toBeGreaterThanOrEqual(4);
    }
  });

  it("keeps the answer bubble readable as a CARD, not as the page", () => {
    for (const [name, p] of Object.entries(PALETTES)) {
      // A bubble that matches the page is not a bubble. This is the guard against
      // the tempting fix "make it subtler" taken one step too far — the direction
      // differs per theme, so only the DISTANCE is asserted.
      expect(
        separation(p, "assistant-msg"),
        `${name}: the answer bubble must stand out from bg`,
      ).toBeGreaterThanOrEqual(4);
    }
  });

  it("puts hover surfaces ABOVE the answer bubble, in both themes", () => {
    for (const [name, p] of Object.entries(PALETTES)) {
      // surface-2 is "raised surfaces / hover": hovering a card must lift it
      // further than the card itself already is, whichever way "lift" points.
      expect(separation(p, "surface-2"), `${name}: hover must stand out more than the card`).toBeGreaterThan(
        separation(p, "assistant-msg"),
      );
    }
  });

  it("keeps every surface a plain colour, so these relationships can be measured", () => {
    // The three compared roles must be #rrggbb: an rgba() overlay would make the
    // numbers above depend on what it is drawn over, and the test would be lying.
    for (const [name, p] of Object.entries(PALETTES)) {
      for (const role of ["bg", "tool-bg", "assistant-msg", "surface-2"] as const) {
        expect(p[role], `${name}.${role}`).toMatch(/^#[0-9a-f]{6}$/i);
      }
    }
  });
});
