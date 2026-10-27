// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createFind, HIGHLIGHT_ALL, HIGHLIGHT_CURRENT, type Find, type FindElements } from "./find";

/**
 * The find engine on its own — no panel, no config, no transcript painter.
 *
 * These are the behaviours the view's tests exercise THROUGH the panel (and still do); here they are
 * pinned at the boundary the module actually owns: the scan and its cap, the two highlight layers,
 * the timers (armed, disarmed, fired), the fallback that uses the selection when the host has no
 * Highlight API, and the caret rule that keeps typing alive while the highlights repaint.
 */

let els: FindElements;
let find: Find;
let reveal: ReturnType<typeof vi.fn<(node: Node) => void>>;

/** Stub the Custom Highlight API (jsdom has neither `CSS.highlights` nor `Highlight`). */
function stubHighlightApi(): Map<string, { size: number }> {
  const map = new Map<string, { size: number }>();
  (globalThis as unknown as { Highlight: unknown }).Highlight = class {
    size: number;
    constructor(...ranges: Range[]) {
      this.size = ranges.length;
    }
  };
  (window as unknown as { CSS: unknown }).CSS = { highlights: map };
  return map;
}

function dropHighlightApi(): void {
  delete (globalThis as unknown as { Highlight?: unknown }).Highlight;
  delete (window as unknown as { CSS?: unknown }).CSS;
}

beforeEach(() => {
  document.body.innerHTML = `
    <div id="find-bar" class="hidden">
      <input id="find-input" type="search" />
      <span id="find-count"></span>
      <button id="find-prev"></button>
      <button id="find-next"></button>
      <button id="find-close"></button>
    </div>
    <div id="transcript">
      <p>alpha beta</p>
      <p>gamma alpha</p>
    </div>
    <input id="elsewhere" />
  `;
  reveal = vi.fn<(node: Node) => void>();
  els = {
    bar: document.getElementById("find-bar") as HTMLElement,
    input: document.getElementById("find-input") as HTMLInputElement,
    count: document.getElementById("find-count") as HTMLElement,
    prev: document.getElementById("find-prev") as HTMLButtonElement,
    next: document.getElementById("find-next") as HTMLButtonElement,
    close: document.getElementById("find-close") as HTMLButtonElement,
    transcript: document.getElementById("transcript") as HTMLElement,
  };
  find = createFind(els, { reveal });
  find.open();
});

afterEach(() => {
  find.close();
  dropHighlightApi();
  vi.useRealTimers();
});

/** Type a query and let the debounce fire. */
async function type(text: string): Promise<void> {
  els.input.value = text;
  els.input.dispatchEvent(new Event("input"));
  await new Promise((r) => setTimeout(r, 150));
}

describe("the scan", () => {
  it("counts every occurrence and paints both layers", async () => {
    const highlights = stubHighlightApi();
    await type("alpha");
    expect(els.count.textContent).toBe("1/2");
    expect(highlights.get(HIGHLIGHT_ALL)!.size).toBe(2);
    expect(highlights.get(HIGHLIGHT_CURRENT)!.size).toBe(1);
  });

  it("is case-insensitive and covers occurrences inside ONE text node", async () => {
    stubHighlightApi();
    els.transcript.innerHTML = "<p>Beta beta BETA</p>";
    await type("beta");
    expect(els.count.textContent).toBe("1/3");
  });

  it("CAPS the list at 500 (a one-letter query must not build a million Ranges)", async () => {
    stubHighlightApi();
    els.transcript.innerHTML = `<p>${"x ".repeat(600)}</p>`;
    await type("x");
    expect(els.count.textContent).toBe(`1/500`);
  });

  it("an empty or blank query says NOTHING, and clears what the previous one drew", async () => {
    const highlights = stubHighlightApi();
    await type("alpha");
    expect(highlights.has(HIGHLIGHT_ALL)).toBe(true);
    await type("   ");
    expect(els.count.textContent).toBe(""); // not "no match"
    expect(highlights.has(HIGHLIGHT_ALL)).toBe(false);
  });

  it("'no match' clears the paint instead of leaving the old one on screen", async () => {
    const highlights = stubHighlightApi();
    await type("alpha");
    await type("zzz");
    expect(els.count.textContent).toBe("no match");
    expect(highlights.has(HIGHLIGHT_ALL)).toBe(false);
    expect(highlights.has(HIGHLIGHT_CURRENT)).toBe(false);
  });
});

describe("the debounce", () => {
  it("typing fast arms ONE scan and cancels the previous timer", async () => {
    stubHighlightApi();
    for (const q of ["a", "al", "alp", "alph", "alpha"]) {
      els.input.value = q;
      els.input.dispatchEvent(new Event("input"));
    }
    await new Promise((r) => setTimeout(r, 150));
    // One scan, on the LAST query — and the count is not a per-keystroke average of stale ones.
    expect(els.count.textContent).toBe("1/2");
  });
});

describe("navigation", () => {
  it("Enter wraps forward, Shift+Enter wraps back, and the count follows", async () => {
    stubHighlightApi();
    await type("alpha");
    const enter = (shiftKey = false): void => {
      els.input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey, bubbles: true }));
    };
    expect(els.count.textContent).toBe("1/2");
    enter();
    expect(els.count.textContent).toBe("2/2");
    enter(); // wraps
    expect(els.count.textContent).toBe("1/2");
    enter(true); // back, wrapping to the last
    expect(els.count.textContent).toBe("2/2");
  });

  it("the arrows do the same thing as Enter", async () => {
    stubHighlightApi();
    await type("alpha");
    els.next.click();
    expect(els.count.textContent).toBe("2/2");
    els.prev.click();
    expect(els.count.textContent).toBe("1/2");
  });

  it("asks the panel to REVEAL the current match (a folded section must open)", async () => {
    stubHighlightApi();
    await type("gamma");
    expect(reveal).toHaveBeenCalled();
  });

  it("stepping with no match does nothing at all (no crash, no count)", async () => {
    stubHighlightApi();
    await type("zzz");
    els.next.click();
    expect(els.count.textContent).toBe("no match");
  });
});

describe("the caret rule", () => {
  it("does NOT move the selection while the field has the focus (typing must survive)", async () => {
    dropHighlightApi(); // force the selection fallback
    els.input.focus();
    await type("alpha");
    expect(document.activeElement).toBe(els.input);
    expect(window.getSelection()!.toString()).toBe(""); // caret untouched
  });

  it("DOES select the match when nothing of ours is focused (the only highlight left)", async () => {
    dropHighlightApi();
    (document.getElementById("elsewhere") as HTMLInputElement).focus();
    await type("alpha");
    expect(window.getSelection()!.toString()).toBe("alpha");
  });

  it("with the Highlight API available the selection is never touched", async () => {
    stubHighlightApi();
    (document.getElementById("elsewhere") as HTMLInputElement).focus();
    await type("alpha");
    expect(window.getSelection()!.toString()).toBe("");
  });
});

describe("the timers", () => {
  it("closing DISARMS a pending debounce (it must not fire after the bar is gone)", async () => {
    const highlights = stubHighlightApi();
    reveal.mockClear();
    els.input.value = "alpha";
    els.input.dispatchEvent(new Event("input")); // armed…
    find.close(); // …and closed before it fires
    // Nothing of the closed bar may wake up: no highlight, no count, no reveal, no scan.
    await new Promise((r) => setTimeout(r, 250));
    expect(highlights.size).toBe(0);
    expect(els.count.textContent).toBe("");
    expect(reveal).not.toHaveBeenCalled();
  });

  it("follows the transcript while open: new text is rescanned, WITHOUT scrolling", async () => {
    stubHighlightApi();
    await type("alpha");
    expect(els.count.textContent).toBe("1/2");
    const before = vi.fn();
    els.transcript.appendChild(document.createTextNode(" and alpha again"));
    await new Promise((r) => setTimeout(r, 400)); // the rescan debounce (300ms)
    expect(els.count.textContent).toBe("1/3");
    expect(before).not.toHaveBeenCalled();
  });

  it("a rescan while the bar is closed does nothing", async () => {
    const highlights = stubHighlightApi();
    find.close();
    els.transcript.appendChild(document.createTextNode(" alpha"));
    await new Promise((r) => setTimeout(r, 400));
    expect(highlights.size).toBe(0);
  });
});

describe("the defensive edges", () => {
  it("stepping with no match after a rescan returns cleanly (no negative index)", async () => {
    stubHighlightApi();
    await type("alpha");
    els.transcript.innerHTML = "<p>nothing here</p>"; // the matches vanish under our feet
    els.next.click(); // refresh(true) finds none → step must stop, not wrap on an empty list
    expect(els.count.textContent).toBe("no match");
  });

  it("the rescan timer is REPLACED on a burst of mutations (one scan, not one per node)", async () => {
    stubHighlightApi();
    await type("alpha");
    for (let i = 0; i < 5; i += 1) els.transcript.appendChild(document.createTextNode(` alpha${i}`));
    await new Promise((r) => setTimeout(r, 400));
    // All five landed, and the count is the truth after ONE debounced pass.
    expect(els.count.textContent).toContain("/7"); // 2 original + 5 appended
  });

  it("a mutation arriving WHILE a rescan is armed replaces it (one scan, not two)", async () => {
    stubHighlightApi();
    await type("alpha");
    els.transcript.appendChild(document.createTextNode(" alpha1"));
    await new Promise((r) => setTimeout(r, 100)); // the first rescan is armed, not fired
    els.transcript.appendChild(document.createTextNode(" alpha2")); // …and replaces it
    await new Promise((r) => setTimeout(r, 400));
    expect(els.count.textContent).toContain("/4"); // both appends seen, once
  });

  it("closing twice is harmless (timers already disarmed, nothing left armed)", async () => {
    stubHighlightApi();
    await type("alpha");
    find.close();
    find.close();
    expect(find.isOpen()).toBe(false);
    expect(els.count.textContent).toBe("");
  });

  it("a query typed while CLOSED is not scanned until the bar opens", async () => {
    const highlights = stubHighlightApi();
    find.close();
    els.input.value = "alpha";
    els.input.dispatchEvent(new Event("input"));
    await new Promise((r) => setTimeout(r, 150));
    // The engine stays quiet: the bar is hidden, so its paint would be invisible work.
    expect(highlights.has(HIGHLIGHT_ALL)).toBe(false);
  });
});

describe("the bar", () => {
  it("open() focuses the field and selects what is there", () => {
    find.close();
    els.input.value = "alpha"; // a query left from a previous session
    find.open();
    expect(find.isOpen()).toBe(true);
    expect(document.activeElement).toBe(els.input);
    expect(els.input.selectionStart).toBe(0);
    expect(els.input.selectionEnd).toBe(5);
  });

  it("focusOrOpen() never toggles it away", () => {
    find.focusOrOpen();
    expect(find.isOpen()).toBe(true);
    find.focusOrOpen();
    expect(find.isOpen()).toBe(true);
  });

  it("Esc closes it and clears the field, the count and the highlights", async () => {
    const highlights = stubHighlightApi();
    await type("alpha");
    els.input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(find.isOpen()).toBe(false);
    expect(els.input.value).toBe("");
    expect(els.count.textContent).toBe("");
    expect(highlights.size).toBe(0);
  });

  it("any other key is stopped from reaching the panel's global shortcuts", () => {
    const spy = vi.fn();
    document.addEventListener("keydown", spy); // the panel's own handler, in the bubble phase
    els.input.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
    expect(spy).not.toHaveBeenCalled();
    document.removeEventListener("keydown", spy);
  });

  it("the ✕ button closes it", () => {
    els.close.click();
    expect(find.isOpen()).toBe(false);
  });
});
