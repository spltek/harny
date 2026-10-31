import { describe, it, expect } from "vitest";
import { untrustedBuildNote, untrustedModeHint } from "./workspace-trust";

/**
 * The two voices that share one cause, pinned the way `workspace-gone.test.ts` pins its three:
 * not the prose, but the two things a message can get WRONG — promising a switch that cannot
 * happen, and hiding the one gesture that fixes it (trusting the folder).
 */

describe("workspace-trust messages", () => {
  it("names Restricted Mode in both voices (that is the word the banner uses)", () => {
    expect(untrustedModeHint()).toContain("Restricted Mode");
    expect(untrustedBuildNote()).toContain("Restricted Mode");
  });

  it("says what still WORKS, so a refusal does not read as a broken extension", () => {
    // The field report was "Harny does not appear", never "Harny refuses to build": a message
    // that only says no would confirm the worst reading.
    const note = untrustedBuildNote();
    expect(note).toContain("Analyze");
    expect(note).toContain("previews");
    expect(note).toContain("reads");
  });

  it("points at the ONE gesture that fixes it — and never at a Build switch", () => {
    // The dead end to avoid: telling the user (or the model) to switch modes, when what has to
    // change is the folder's trust.
    for (const text of [untrustedModeHint(), untrustedBuildNote()]) {
      expect(text).toContain("Trust");
    }
    expect(untrustedModeHint()).toContain("enable Build");
    expect(untrustedBuildNote()).not.toMatch(/switch to Build/i);
  });

  it("keeps the hint on ONE line (it is a tooltip, not a paragraph)", () => {
    expect(untrustedModeHint()).not.toContain("\n");
    expect(untrustedBuildNote()).toContain("\n\n"); // the note is a transcript bubble
  });
});
