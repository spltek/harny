// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  ALWAYS_ATTR,
  CURSOR_ATTR,
  HELP_CLASS,
  setHelpEnabled,
  installTips,
  setTip,
  clearTip,
  tipTextOf,
  ARGS_ATTR,
  KEY_ATTR,
  TIP_DELAY_MS,
  TIP_GAP,
  TIP_EDGE,
  type Cleanup,
} from "./tips";

/**
 * The shared hover card, exercised the way the browser drives it: real events on a real DOM, with
 * a stubbed layout (jsdom has no geometry) and fake timers (the delay is part of the contract).
 */

let cleanup: Cleanup;

const markup = (): string => `
  <div id="wrap">
    <button id="tip-close" data-tip="find.close">✕</button>
    <button id="plain">no explanation</button>
    <button id="locked" disabled data-tip="compact.run">locked</button>
    <button id="nested" data-tip="find.next"><span id="inner">↓</span></button>
    <span id="unknown" data-tip="no.such.key">?</span>
    <input id="number" type="text" data-tip="param.temperature" />
    <input id="slider" type="range" data-tip="param.temperature" />
  </div>
  <div id="tip" class="tip hidden" role="tooltip"></div>`;

const card = (): HTMLElement => document.getElementById("tip") as HTMLElement;
const el = (id: string): HTMLElement => document.getElementById(id) as HTMLElement;
const isOpen = (): boolean => !card().classList.contains("hidden");

/** jsdom has no layout: every rect is a zero, so positions mean nothing until they are stubbed. */
function stubRect(target: Element, top: number, left: number, width: number, height: number): void {
  vi.spyOn(target, "getBoundingClientRect").mockReturnValue({
    top,
    left,
    width,
    height,
    bottom: top + height,
    right: left + width,
    x: left,
    y: top,
    toJSON: () => ({}),
  } as DOMRect);
}

function over(target: EventTarget, init: MouseEventInit = {}): void {
  target.dispatchEvent(new MouseEvent("pointerover", { bubbles: true, ...init }));
}
function out(target: EventTarget, relatedTarget: EventTarget | null = null): void {
  target.dispatchEvent(new MouseEvent("pointerout", { bubbles: true, relatedTarget: relatedTarget as EventTarget }));
}

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = markup();
  // `elementFromPoint` is not implemented by jsdom: start every test from "absent", and let the
  // test that needs it install its own.
  Object.defineProperty(document, "elementFromPoint", { value: undefined, configurable: true, writable: true });
  cleanup = installTips(document);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("the shared tooltip card", () => {
  it("waits for the pointer to rest before it says anything", () => {
    over(el("tip-close"));
    vi.advanceTimersByTime(TIP_DELAY_MS - 1);
    expect(isOpen()).toBe(false);
    vi.advanceTimersByTime(1);
    expect(isOpen()).toBe(true);
    expect(card().textContent).toBe("Close (Esc).");
  });

  it("does not restart the delay when the pointer moves within the same control", () => {
    over(el("tip-close"));
    vi.advanceTimersByTime(200);
    over(el("tip-close")); // the same anchor: not a new question
    vi.advanceTimersByTime(TIP_DELAY_MS - 200); // the FIRST deadline, not a fresh one
    expect(isOpen()).toBe(true);
  });

  it("closes when the pointer leaves the control", () => {
    over(el("tip-close"));
    vi.advanceTimersByTime(TIP_DELAY_MS);
    expect(isOpen()).toBe(true);
    out(el("tip-close"));
    expect(isOpen()).toBe(false);
  });

  it("abandons the delay when the pointer leaves before it fires", () => {
    over(el("tip-close"));
    vi.advanceTimersByTime(TIP_DELAY_MS - 100);
    out(el("tip-close"));
    vi.advanceTimersByTime(TIP_DELAY_MS);
    expect(isOpen()).toBe(false);
  });

  it("stays open while the pointer moves onto a child of the same control", () => {
    over(el("inner"));
    vi.advanceTimersByTime(TIP_DELAY_MS);
    expect(isOpen()).toBe(true);
    out(el("inner"), el("nested"));
    expect(isOpen()).toBe(true);
    out(el("nested"), el("plain"));
    expect(isOpen()).toBe(false);
  });

  it("opens on keyboard focus with no delay, and closes when focus moves on", () => {
    el("tip-close").dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    expect(isOpen()).toBe(true);
    expect(card().textContent).toBe("Close (Esc).");
    el("tip-close").dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: el("plain") }));
    expect(isOpen()).toBe(false);
  });

  it("does not open on focus in a text field: the focus there means typing", () => {
    el("number").dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    expect(isOpen()).toBe(false);
    // Hovering it still explains — the card is how you learn what the field is, before you commit.
    over(el("number"));
    vi.advanceTimersByTime(TIP_DELAY_MS);
    expect(isOpen()).toBe(true);
    // A slider is not a box you type into: focusing it is still a question.
    el("slider").dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    expect(isOpen()).toBe(true);
  });

  it("gets out of the way on a click or Escape", () => {
    for (const dismiss of ["pointerdown", "keydown"] as const) {
      over(el("tip-close"));
      vi.advanceTimersByTime(TIP_DELAY_MS);
      expect(isOpen(), `${dismiss}: the card must be open before the dismissal`).toBe(true);
      if (dismiss === "keydown") document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      else el("tip-close").dispatchEvent(new Event(dismiss, { bubbles: true }));
      expect(isOpen(), `${dismiss} must close the card`).toBe(false);
    }
  });

  it("survives a scroll that does not move its anchor, and closes when the anchor is gone", () => {
    stubRect(el("tip-close"), 40, 100, 24, 24);
    over(el("tip-close"));
    vi.advanceTimersByTime(TIP_DELAY_MS);
    expect(isOpen()).toBe(true);

    // The transcript scrolls itself while it streams: the anchor (a toolbar button) has not moved,
    // so nothing moved under the pointer and the card has no reason to go anywhere.
    el("tip-close").dispatchEvent(new Event("scroll", { bubbles: true }));
    expect(isOpen()).toBe(true);

    // The anchor DOES move — a scroll of its own container: the card follows it instead of dying.
    stubRect(el("tip-close"), 240, 100, 24, 24);
    el("tip-close").dispatchEvent(new Event("scroll", { bubbles: true }));
    expect(isOpen()).toBe(true);
    expect(card().style.top).toBe(`${240 + 24 + TIP_GAP}px`);

    // …and once it is scrolled out of the viewport there is nothing left to describe.
    stubRect(el("tip-close"), -400, 100, 24, 24);
    el("tip-close").dispatchEvent(new Event("scroll", { bubbles: true }));
    expect(isOpen()).toBe(false);
  });

  it("keeps Escape and other keys apart", () => {
    over(el("tip-close"));
    vi.advanceTimersByTime(TIP_DELAY_MS);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
    expect(isOpen()).toBe(true);
  });

  it("explains a DISABLED control, which reports no pointer events of its own", () => {
    // The event lands on the parent (a disabled <button> dispatches no mouse events), so the module
    // hit-tests the pointer to find the control that is really under it — exactly the case where
    // "why is this greyed out?" needs an answer.
    Object.defineProperty(document, "elementFromPoint", {
      value: (x: number, y: number) => (x === 40 && y === 40 ? el("locked") : null),
      configurable: true,
      writable: true,
    });
    over(el("wrap"), { clientX: 40, clientY: 40 });
    vi.advanceTimersByTime(TIP_DELAY_MS);
    expect(isOpen()).toBe(true);
    expect(card().textContent).toContain("older turns");
  });

  it("opens nothing for a key that resolves to nothing (an empty card reads as a broken control)", () => {
    over(el("unknown"));
    vi.advanceTimersByTime(TIP_DELAY_MS);
    expect(isOpen()).toBe(false);
    expect(card().textContent).toBe("");
  });

  it("opens nothing for a control with no explanation at all", () => {
    over(el("plain"));
    vi.advanceTimersByTime(TIP_DELAY_MS);
    expect(isOpen()).toBe(false);
  });

  it("flips above the control when there is no room below", () => {
    Object.defineProperty(document.defaultView, "innerHeight", { value: 600, configurable: true });
    stubRect(el("tip-close"), 550, 100, 20, 30);
    stubRect(card(), 0, 0, 200, 40);
    over(el("tip-close"));
    vi.advanceTimersByTime(TIP_DELAY_MS);
    // 550 - 40 - 6: above the control, clear of the top edge.
    expect(card().style.top).toBe(`${550 - 40 - TIP_GAP}px`);
    expect(card().style.left).toBe("100px");
  });

  it("sits below the control when there is room", () => {
    Object.defineProperty(document.defaultView, "innerHeight", { value: 600, configurable: true });
    stubRect(el("tip-close"), 100, 100, 20, 30);
    stubRect(card(), 0, 0, 200, 40);
    over(el("tip-close"));
    vi.advanceTimersByTime(TIP_DELAY_MS);
    expect(card().style.top).toBe(`${100 + 30 + TIP_GAP}px`);
  });

  it("never runs off the left edge", () => {
    Object.defineProperty(document.defaultView, "innerWidth", { value: 800, configurable: true });
    stubRect(el("tip-close"), 100, -50, 20, 30);
    stubRect(card(), 0, 0, 200, 40);
    over(el("tip-close"));
    vi.advanceTimersByTime(TIP_DELAY_MS);
    expect(card().style.left).toBe(`${TIP_EDGE}px`);
  });

  it("never runs off the right edge", () => {
    Object.defineProperty(document.defaultView, "innerWidth", { value: 800, configurable: true });
    stubRect(el("tip-close"), 100, 780, 20, 30);
    stubRect(card(), 0, 0, 200, 40);
    over(el("tip-close"));
    vi.advanceTimersByTime(TIP_DELAY_MS);
    expect(card().style.left).toBe(`${800 - 200 - TIP_EDGE}px`);
  });

  it("borrows aria-describedby while it speaks, and gives it back as it found it", () => {
    stubRect(el("tip-close"), 100, 100, 20, 30);
    stubRect(card(), 0, 0, 200, 40);
    stubRect(el("plain"), 100, 200, 20, 30);

    over(el("tip-close"));
    vi.advanceTimersByTime(TIP_DELAY_MS);
    expect(el("tip-close").getAttribute("aria-describedby")).toBe("tip");
    out(el("tip-close"));
    expect(el("tip-close").hasAttribute("aria-describedby")).toBe(false);

    // A control that already described itself keeps its own description.
    el("plain").setAttribute("aria-describedby", "help-text");
    el("plain").setAttribute(KEY_ATTR, "find.next");
    over(el("plain"));
    vi.advanceTimersByTime(TIP_DELAY_MS);
    expect(el("plain").getAttribute("aria-describedby")).toBe("help-text tip");
    out(el("plain"));
    expect(el("plain").getAttribute("aria-describedby")).toBe("help-text");
  });

  it("survives markup that has no #tip element, instead of taking the panel down", () => {
    cleanup();
    document.body.innerHTML = `<button id="tip-close" data-tip="find.close">✕</button>`;
    expect(() => {
      cleanup = installTips(document);
      over(el("tip-close"));
      vi.advanceTimersByTime(TIP_DELAY_MS);
    }).not.toThrow();
  });

  it("installs one set of listeners however many times it is called", () => {
    expect(installTips(document)).toBe(cleanup);
  });

  it("re-installs when the shell around it is re-rendered, instead of talking to a detached card", () => {
    const first = installTips(document);
    document.body.innerHTML = markup(); // the card the module knew is gone
    const second = installTips(document);
    expect(second).not.toBe(first);
    cleanup = second;
    over(el("tip-close"));
    vi.advanceTimersByTime(TIP_DELAY_MS);
    expect(isOpen()).toBe(true);
    expect(card().textContent).toBe("Close (Esc).");
  });

  it("removes every listener when torn down", () => {
    cleanup();
    over(el("tip-close"));
    vi.advanceTimersByTime(TIP_DELAY_MS);
    expect(isOpen()).toBe(false);
    cleanup = installTips(document); // the afterEach teardown needs a live one
  });
});

describe("setTip", () => {
  it("writes the key, not the prose", () => {
    const button = el("plain");
    setTip(button, "compact.run");
    expect(button.getAttribute(KEY_ATTR)).toBe("compact.run");
    expect(button.getAttribute(ARGS_ATTR)).toBeNull();
    expect(button.textContent).toBe("no explanation"); // the control's own label is untouched
    expect(tipTextOf(button)).toContain("older turns");
  });

  it("carries interpolation values, encoded so any value survives", () => {
    const button = el("plain");
    setTip(button, "lg.p.maxNudges", { min: 1, max: 10 });
    expect(button.getAttribute(ARGS_ATTR)).toBe("min=1&max=10");
    expect(tipTextOf(button)).toContain("Range 1–10.");

    setTip(button, "lg.p.maxNudges", { note: "/a b/c&d=e" });
    expect(tipTextOf(button)).toContain("{min}"); // resolved as far as it honestly can be
    expect(new URLSearchParams(button.getAttribute(ARGS_ATTR) ?? "").get("note")).toBe("/a b/c&d=e");
  });

  it("clears the key and the values together, so no stale text can come back", () => {
    const button = el("plain");
    setTip(button, "compact.run", { min: 1 });
    clearTip(button);
    expect(button.hasAttribute(KEY_ATTR)).toBe(false);
    expect(button.hasAttribute(ARGS_ATTR)).toBe(false);
    expect(tipTextOf(button)).toBe("");
  });

  it("replaces the explanation when the state changes, keeping one key per state", () => {
    const button = el("plain");
    setTip(button, "lg.collapse.expanded");
    const opened = tipTextOf(button);
    setTip(button, "lg.collapse.collapsed");
    const closed = tipTextOf(button);
    expect(opened).not.toBe(closed);
    expect(button.getAttribute(KEY_ATTR)).toBe("lg.collapse.collapsed");
  });
});

describe("the pointer says WHAT the element is", () => {
  const cursor = (node: HTMLElement): boolean => node.getAttribute(CURSOR_ATTR) === "help";

  it("inert text asks a question: a value, a parameter name, a metric", () => {
    const value = document.createElement("span");
    document.getElementById("wrap")!.append(value);
    setTip(value, "param.ctxWindow");
    expect(cursor(value)).toBe(true);
    // …and the SAME is decided for the markup that never went through setTip.
    expect(cursor(el("unknown"))).toBe(true);
  });

  it("a control keeps its own cursor: its pointer is the click affordance", () => {
    setTip(el("plain"), "param.ctxWindow");
    expect(cursor(el("plain"))).toBe(false);
    const label = document.createElement("label");
    label.innerHTML = '<input type="radio" />Temperature';
    document.getElementById("wrap")!.append(label);
    setTip(label, "param.temperature");
    expect(cursor(label)).toBe(false);
  });

  it("trusts what the stylesheet already says: a span drawn as clickable is not a question", () => {
    const name = document.createElement("span");
    name.style.cursor = "pointer"; // the session name, the tab: spans the view makes clickable
    document.getElementById("wrap")!.append(name);
    setTip(name, "sessions.dates");
    expect(cursor(name)).toBe(false);
  });

  it("decides once: an explicit choice is never overwritten later", () => {
    const span = document.createElement("span");
    document.getElementById("wrap")!.append(span);
    span.setAttribute(CURSOR_ATTR, "none");
    setTip(span, "param.thinking");
    expect(span.getAttribute(CURSOR_ATTR)).toBe("none");
  });
});

describe("interactive help: ONE switch for every explanation", () => {
  // The module remembers the switch across documents on purpose, so every test starts ON.
  beforeEach(() => setHelpEnabled(true));

  it("off, a tipped control says nothing and shows nothing: no card, no question mark", () => {
    const span = document.createElement("span");
    document.getElementById("wrap")!.append(span);
    setTip(span, "param.ctxWindow");
    setHelpEnabled(false);
    expect(document.body.classList.contains(HELP_CLASS)).toBe(false);
    over(el("tip-close"));
    vi.advanceTimersByTime(TIP_DELAY_MS * 3);
    expect(isOpen()).toBe(false);
    // The attribute stays: what the switch governs is the POINTER and the CARD, not the element.
    expect(span.getAttribute(CURSOR_ATTR)).toBe("help");
  });

  it("off, the switch itself still answers — a switch that went mute would be a trap", () => {
    const switchOn = el("tip-close");
    switchOn.setAttribute(ALWAYS_ATTR, "");
    setHelpEnabled(false);
    stubRect(switchOn, 10, 10, 90, 20);
    stubRect(card(), 10, 10, 120, 40);
    over(switchOn);
    vi.advanceTimersByTime(TIP_DELAY_MS);
    expect(isOpen()).toBe(true);
    // …and from the keyboard too: the exception is about the ELEMENT, not about the pointer.
    out(switchOn);
    const locked = el("locked");
    locked.setAttribute(ALWAYS_ATTR, "");
    locked.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    expect(isOpen()).toBe(true);
  });

  it("turning help off closes the card that is already speaking, and hands back aria-describedby", () => {
    stubRect(el("tip-close"), 10, 10, 90, 20);
    stubRect(card(), 10, 10, 120, 40);
    over(el("tip-close"));
    vi.advanceTimersByTime(TIP_DELAY_MS);
    expect(isOpen()).toBe(true);
    setHelpEnabled(false);
    expect(isOpen()).toBe(false);
    expect(el("tip-close").hasAttribute("aria-describedby")).toBe(false);
  });

  it("on again, everything explains itself exactly as before", () => {
    setHelpEnabled(false);
    setHelpEnabled(true);
    expect(document.body.classList.contains(HELP_CLASS)).toBe(true);
    stubRect(el("tip-close"), 10, 10, 90, 20);
    stubRect(card(), 10, 10, 120, 40);
    over(el("tip-close"));
    vi.advanceTimersByTime(TIP_DELAY_MS);
    expect(isOpen()).toBe(true);
  });
});
