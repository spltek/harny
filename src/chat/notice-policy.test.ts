import { describe, it, expect } from "vitest";
import { routeNotice, type ViewState } from "./notice-policy";

/**
 * The table, not the prose: what is pinned here is that a fact never lands on two surfaces at
 * once, and that the surface chosen can actually exist (a dialog on a hidden panel cannot).
 */
describe("notice policy — one fact, one surface", () => {
  const cases: [string, ViewState, string][] = [
    ["panel on screen, session open", { panelVisible: true, sessionOpen: true }, "ask"],
    ["panel on screen, home (no session)", { panelVisible: true, sessionOpen: false }, "silent"],
    ["panel hidden", { panelVisible: false, sessionOpen: true }, "toast"],
    ["panel hidden, no session either", { panelVisible: false, sessionOpen: false }, "toast"],
  ];

  for (const [name, state, want] of cases) {
    it(`workspace-gone · ${name} → ${want}`, () => {
      expect(routeNotice("workspace-gone", state)).toBe(want);
    });
  }

  it("asks ONLY where a dialog can be seen and answered", () => {
    // The rule that prevents both bugs found in the field: a dialog that cannot be shown
    // (hidden panel) and a dialog that repeats the screen (home).
    expect(routeNotice("workspace-gone", { panelVisible: false, sessionOpen: true })).not.toBe("ask");
    expect(routeNotice("workspace-gone", { panelVisible: true, sessionOpen: false })).not.toBe("ask");
  });

  it("always has a surface: no state is left with nothing said", () => {
    // 'silent' is not 'nowhere': with the panel on screen and no session, the panel's own
    // home SAYS it (hero + a list that is the picker). What must never happen is a state where
    // the user is left with no indication at all.
    const states: ViewState[] = [
      { panelVisible: true, sessionOpen: true },
      { panelVisible: true, sessionOpen: false },
      { panelVisible: false, sessionOpen: true },
      { panelVisible: false, sessionOpen: false },
    ];
    for (const s of states) {
      const action = routeNotice("workspace-gone", s);
      const explained = action !== "silent" || s.panelVisible;
      expect(explained).toBe(true);
    }
  });
});
