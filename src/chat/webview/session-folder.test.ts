import { describe, it, expect } from "vitest";
import { folderAction, folderActionLabel, folderMoveLabel, showsMove } from "./session-folder";

/**
 * The shared rule behind "open this session".
 *
 * It exists because the gesture OPENS THE SESSION (and RELOADS THE WINDOW when the session
 * lives in another folder): telling the three cases apart is not a cosmetic label choice, and
 * the two surfaces that use it (the All-sessions form and the home list) must answer
 * identically. Path equality itself is `folder-path.test.ts`.
 */

describe("folderAction", () => {
  it("opens a usable folder that is not the one already open", () => {
    expect(folderAction({ folder: "/p/other" }, "/p/current")).toBe("open");
  });

  it("says `here` when the session already lives in this folder", () => {
    // NOT `pick`: the row used to offer the picker as its only action, so opening a session of
    // the current folder began by choosing that same folder.
    expect(folderAction({ folder: "/p/current" }, "/p/current")).toBe("here");
    // Same folder written differently is still this folder (Windows separators/case).
    expect(folderAction({ folder: "C:\\Proj\\App" }, "c:/proj/app")).toBe("here");
  });

  it("offers the picker when there is nothing to open", () => {
    expect(folderAction({ folder: "/p/gone", folderMissing: true })).toBe("pick");
    expect(folderAction({})).toBe("pick");
    // A pointer to a folder that is gone without a current folder is still nothing to open.
    expect(folderAction({ folder: "", folderMissing: false })).toBe("pick");
  });

  it("with NO current folder (the home list) every stored folder is usable", () => {
    expect(folderAction({ folder: "/p/a" })).toBe("open");
    expect(folderAction({ folder: "/p/a" }, undefined)).toBe("open");
  });

  it("a folder that is gone stays 'pick' even without a current folder", () => {
    expect(folderAction({ folder: "/p/a", folderMissing: true })).toBe("pick");
  });
});

describe("folderActionLabel", () => {
  it("says what the gesture does, in the same words on both surfaces", () => {
    // The user asks for SESSION: the workspace switch is how the host gets there, and `here`
    // differs only in the cost of the click — not in what the click is for.
    expect(folderActionLabel("open")).toBe("Open session");
    expect(folderActionLabel("here")).toBe("Open session");
    // The picker re-points the session and the host opens it right after: one gesture, one
    // outcome, so the label names both halves.
    expect(folderActionLabel("pick")).toBe("Change folder & open…");
  });
});

describe("the second gesture (`here` only)", () => {
  it("is offered exactly where the picker used to be the ONLY action", () => {
    expect(showsMove("here")).toBe(true);
    // Nothing to move elsewhere while the session is one click away…
    expect(showsMove("open")).toBe(false);
    // …and `pick` already IS the picker: a second button would be the same button twice.
    expect(showsMove("pick")).toBe(false);
  });

  it("is worded as an OPENING, because nothing moves on disk", () => {
    // The transcript stays where it is; only the `folder` field changes, and the session then
    // opens there. "Move…" would promise a relocation the store does not perform.
    expect(folderMoveLabel()).toBe("Open elsewhere…");
    expect(folderMoveLabel()).not.toMatch(/move/i);
  });
});
