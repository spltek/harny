// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { createSwitch, setSwitch, switchIsOn } from "./switch";

/**
 * THE SWITCH, as a control: one class, two DOM shapes, one way to write and read the state.
 *
 * What these tests protect is the reason the module exists. Harny used to answer "is this on?" with
 * a pill in the MCP tools popover, a 15px checkbox in the MCP form and an 11px tick next to the Loop
 * Guard's "Include response" — four looks and two state channels (`aria-checked` for the buttons,
 * `.checked` for the inputs), which is how a control drifts one call site at a time.
 */

describe("the panel's ONE switch", () => {
  it("builds a button that IS a switch, off unless told otherwise", () => {
    const off = createSwitch("Use server X in this session");
    expect(off.tagName).toBe("BUTTON");
    expect(off.type).toBe("button"); // never submits a form it happens to sit in
    expect(off.className).toBe("harny-switch");
    expect(off.getAttribute("role")).toBe("switch");
    expect(off.getAttribute("aria-checked")).toBe("false");
    // The label is the ACCESSIBLE name: the pill carries no text of its own.
    expect(off.getAttribute("aria-label")).toBe("Use server X in this session");
    expect(createSwitch("x", true).getAttribute("aria-checked")).toBe("true");
  });

  it("writes the state of a BUTTON through the attribute — the channel a button has", () => {
    const el = createSwitch("x");
    setSwitch(el, true);
    expect(el.getAttribute("aria-checked")).toBe("true");
    expect(switchIsOn(el)).toBe(true);
    setSwitch(el, false);
    expect(el.getAttribute("aria-checked")).toBe("false");
    expect(switchIsOn(el)).toBe(false);
  });

  it("writes the state of a NATIVE input through `checked` — the channel the forms already read", () => {
    // The MCP form and the Loop Guard flag are native checkboxes: their module reads `.checked`, so
    // a shared helper that only knew `aria-checked` would silently do nothing there.
    const el = document.createElement("input");
    el.type = "checkbox";
    el.className = "harny-switch";
    setSwitch(el, true);
    expect(el.checked).toBe(true);
    expect(el.getAttribute("aria-checked")).toBe(null); // it must NOT grow a second source of truth
    expect(switchIsOn(el)).toBe(true);
    setSwitch(el, false);
    expect(el.checked).toBe(false);
  });

  it("reads a switch nobody set as OFF, whatever the shape", () => {
    const btn = document.createElement("button");
    btn.className = "harny-switch";
    expect(switchIsOn(btn)).toBe(false);
    expect(switchIsOn(document.createElement("input"))).toBe(false);
  });
});
