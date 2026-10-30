import { describe, it, expect } from "vitest";
import { folderAction, folderActionLabel } from "./session-folder";

/**
 * The shared rule behind "go to this session's folder".
 *
 * It exists because the gesture RELOADS THE WINDOW: telling `open` from `pick` is not a
 * cosmetic label choice, and the two surfaces that use it (the All-sessions form and the
 * home list) must answer identically. Path equality itself is `folder-path.test.ts`.
 */

describe("folderAction", () => {
  it("opens a usable folder that is not the one already open", () => {
    expect(folderAction({ folder: "/p/other" }, "/p/current")).toBe("open");
  });

  it("offers the picker when there is nothing to open", () => {
    expect(folderAction({ folder: "/p/gone", folderMissing: true })).toBe("pick");
    expect(folderAction({})).toBe("pick");
    // Already the current workspace: reopening it would reload the window for nothing.
    expect(folderAction({ folder: "/p/current" }, "/p/current")).toBe("pick");
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
    expect(folderActionLabel("open")).toBe("Open folder");
    // The picker also RE-POINTS the session, so "Change" is the honest verb.
    expect(folderActionLabel("pick")).toBe("Change folder…");
  });
});
