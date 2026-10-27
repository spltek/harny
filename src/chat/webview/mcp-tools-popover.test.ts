// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createMcpToolsPopover, type McpToolsPopover } from "./mcp-tools-popover";

/**
 * The tools popover on its own: the draft, the two controls per tool, the filter, the counts, the
 * Save as intent, and the busy rule.
 *
 * The rule worth re-reading: `busy` is a GETTER. The popover outlives the moment it was built (a run
 * can start underneath it), so a captured boolean would go stale exactly when it matters — and the
 * Save is the one button whose job is to refuse in that case.
 */

let popover: HTMLElement;
let post: ReturnType<typeof vi.fn<(message: unknown) => void>>;
let busy: boolean;
let ui: McpToolsPopover;
let anchor: HTMLButtonElement;

const TOOLS = [
  { name: "read_query", description: "Run a SELECT", readOnly: true, analyzeFlag: true },
  { name: "drop_table" },
];

beforeEach(() => {
  document.body.innerHTML = `
    <button id="anchor"></button>
    <div id="mcp-tools-popover" class="hidden"></div>
  `;
  popover = document.getElementById("mcp-tools-popover") as HTMLElement;
  anchor = document.getElementById("anchor") as HTMLButtonElement;
  post = vi.fn<(message: unknown) => void>();
  busy = false;
  ui = createMcpToolsPopover({ popover, post, busy: () => busy });
});

const rows = (): HTMLElement[] => [...popover.querySelectorAll<HTMLElement>(".mcp-pop-row")];
const boxes = (): HTMLInputElement[] => [...popover.querySelectorAll<HTMLInputElement>(".mcp-pop-row input")];
const shields = (): HTMLButtonElement[] => [...popover.querySelectorAll<HTMLButtonElement>(".mcp-pop-shield")];
const save = (): HTMLButtonElement =>
  popover.querySelector<HTMLButtonElement>(".mcp-pop-actions .mcp-pop-mini:not(.secondary)")!;
const count = (): HTMLElement => popover.querySelector<HTMLElement>(".mcp-pop-count")!;
const status = (): HTMLElement => popover.querySelector<HTMLElement>(".mcp-pop-status")!;
const byText = (label: string): HTMLButtonElement =>
  [...popover.querySelectorAll<HTMLButtonElement>(".mcp-pop-mini")].find((b) => b.textContent === label)!;

describe("opening", () => {
  it("renders one row per tool, with the title and the count", () => {
    ui.show(anchor, "test", TOOLS);
    expect(popover.classList.contains("hidden")).toBe(false);
    expect(popover.dataset.server).toBe("test");
    expect(popover.querySelector(".mcp-pop-title")!.textContent).toBe("🧩 test");
    expect(rows()).toHaveLength(2);
    // `read_query` is already declared read-only in Analyze, so the count says so.
    expect(count().textContent).toBe("2 of 2 enabled · 1 read-only in Analyze");
    expect(boxes().map((b) => b.checked)).toEqual([true, true]);
  });

  it("starts from the HOST's flags: a tool switched off for this session is unchecked", () => {
    ui.show(anchor, "test", [{ name: "a", off: true }, { name: "b" }]);
    expect(boxes().map((b) => b.checked)).toEqual([false, true]);
    expect(rows()[0].classList.contains("off")).toBe(true);
    expect(count().textContent).toBe("1 of 2 enabled");
  });

  it("offers a filter only when the list is long enough to need one", () => {
    ui.show(anchor, "test", TOOLS);
    expect(popover.querySelector(".mcp-pop-filter")).toBeNull();
    ui.show(
      anchor,
      "test",
      Array.from({ length: 9 }, (_, i) => ({ name: `t${i}` })),
    );
    expect(popover.querySelector(".mcp-pop-filter")).not.toBeNull();
  });

  it("says (no tools) instead of an empty box", () => {
    ui.show(anchor, "test", []);
    expect(popover.querySelector(".mcp-pop-empty")!.textContent).toBe("(no tools)");
  });

  it("anchors itself inside the viewport", () => {
    ui.show(anchor, "test", TOOLS);
    expect(popover.style.left.endsWith("px")).toBe(true);
    expect(popover.style.top.endsWith("px")).toBe(true);
    expect(Number.parseInt(popover.style.left, 10)).toBeGreaterThanOrEqual(0);
  });
});

describe("the draft", () => {
  it("a checkbox toggles ONE tool, and Save stays disabled until something changes", () => {
    ui.show(anchor, "test", TOOLS);
    expect(save().disabled).toBe(true);

    boxes()[1].checked = false;
    boxes()[1].dispatchEvent(new Event("change"));
    expect(rows()[1].classList.contains("off")).toBe(true);
    expect(count().textContent).toBe("1 of 2 enabled · 1 read-only in Analyze");
    expect(save().disabled).toBe(false);
  });

  it("All / None flip the whole list, and come back to clean when the draft stops differing", () => {
    ui.show(anchor, "test", TOOLS);
    byText("None").click();
    expect(boxes().map((b) => b.checked)).toEqual([false, false]);
    expect(count().textContent).toBe("0 of 2 enabled · 1 read-only in Analyze");
    expect(save().disabled).toBe(false);

    byText("All").click();
    expect(boxes().map((b) => b.checked)).toEqual([true, true]);
    expect(save().disabled).toBe(true); // nothing differs from what is saved
  });

  it("the filter narrows the rows WITHOUT rebuilding the input in use", () => {
    ui.show(
      anchor,
      "test",
      Array.from({ length: 9 }, (_, i) => ({ name: i < 2 ? `read_${i}` : `write_${i}` })),
    );
    const filter = popover.querySelector<HTMLInputElement>(".mcp-pop-filter")!;
    filter.value = "read_";
    filter.dispatchEvent(new Event("input"));
    expect(popover.querySelector(".mcp-pop-filter")).toBe(filter); // same node: the caret survives
    expect(rows()).toHaveLength(2);
    filter.value = "zzz";
    filter.dispatchEvent(new Event("input"));
    expect(popover.querySelector(".mcp-pop-empty")!.textContent).toContain("No tool matches");
  });
});

describe("the Analyze shield", () => {
  it("is lit for a declaration of YOURS, dim for a refused tool, and says who decided", () => {
    ui.show(anchor, "test", TOOLS);
    expect(shields().map((s) => s.getAttribute("aria-pressed"))).toEqual(["true", "false"]);
    expect(shields()[0].title).toContain("because YOU said so");
    expect(shields()[1].title).toContain("Does NOT run in Analyze");
  });

  it("is INHERITED (and disabled) when the server itself declares the tool read-only", () => {
    ui.show(anchor, "test", [{ name: "ro", readOnly: true }]); // no analyzeFlag: the server's hint
    expect(shields()[0].className).toContain("inherited");
    expect(shields()[0].disabled).toBe(true);
    expect(shields()[0].title).toContain("server's own Analyze declaration");
  });

  it("is INERT for a tool the model cannot see, and says to include it first", () => {
    ui.show(anchor, "test", [{ name: "a", off: true, analyzeFlag: true }]);
    expect(shields()[0].className).toContain("inert");
    expect(shields()[0].disabled).toBe(true);
    expect(shields()[0].title).toContain("include it first");
  });

  it("adding a tool to Analyze marks the draft dirty and counts it", () => {
    ui.show(anchor, "test", TOOLS);
    shields()[1].click();
    expect(shields()[1].getAttribute("aria-pressed")).toBe("true");
    expect(count().textContent).toBe("2 of 2 enabled · 2 read-only in Analyze");
    expect(save().disabled).toBe(false);
    // Clicking again takes it back, and the count follows.
    shields()[1].click();
    expect(count().textContent).toBe("2 of 2 enabled · 1 read-only in Analyze");
  });

  it("clicking the shield does NOT toggle the checkbox of its row", () => {
    ui.show(anchor, "test", TOOLS);
    shields()[1].click();
    expect(boxes()[1].checked).toBe(true); // the row is a <label>: the click must not fall through
  });
});

describe("Save", () => {
  it("posts the two axes: the config's exclusions and the SESSION's intent", () => {
    ui.show(anchor, "test", TOOLS);
    boxes()[1].checked = false;
    boxes()[1].dispatchEvent(new Event("change"));
    // `drop_table` is now EXCLUDED, so its shield is INERT: a tool the model cannot see has no
    // Analyze flag to declare ("include it first"). Only the pre-existing declaration rides along.
    shields()[1].click();
    expect(shields()[1].disabled).toBe(true);
    save().click();

    expect(post).toHaveBeenCalledWith({
      type: "setMcpToolExclusions",
      server: "test",
      exclude: ["drop_table"],
      analyze: ["read_query"],
    });
    // …and the session's selection, as INTENT: the names it wants ENABLED (the host spells them).
    expect(post).toHaveBeenCalledWith({ type: "setMcpToolSelection", server: "test", enabled: ["read_query"] });
    expect(status().textContent).toBe("Saving…");
  });

  it("refuses while a run is in flight — and the flag is read at CLICK time", () => {
    ui.show(anchor, "test", TOOLS);
    boxes()[1].checked = false;
    boxes()[1].dispatchEvent(new Event("change"));
    busy = true; // the run started AFTER the popover was built
    save().click();
    expect(post).not.toHaveBeenCalled();
    expect(status().textContent).toBe("Stop the run first");
    expect(status().className).toContain("err");

    busy = false; // the run ended, the popover is still open
    save().click();
    expect(post).toHaveBeenCalled();
  });

  it("the host's answer: success closes, failure keeps the draft and says so", () => {
    ui.show(anchor, "test", TOOLS);
    ui.saved(false);
    expect(popover.classList.contains("hidden")).toBe(false);
    expect(status().textContent).toContain("Save failed");
    ui.saved(true);
    expect(popover.classList.contains("hidden")).toBe(true);
    expect(popover.dataset.server).toBe("");
  });
});

describe("the edges", () => {
  it("a row left over from a CLOSED popover does nothing (no draft, no post)", () => {
    // `hide()` hides and drops the state but leaves the DOM in place (invisible): a stray event on a
    // stale row must be inert, or a closed panel would still write.
    ui.show(anchor, "test", TOOLS);
    const staleBox = boxes()[1];
    const staleShield = shields()[1];
    const staleSave = save();
    ui.hide();
    post.mockClear();

    staleBox.checked = false;
    staleBox.dispatchEvent(new Event("change"));
    staleShield.click();
    staleSave.click();
    expect(post).not.toHaveBeenCalled();
  });

  it("clamps itself inside the viewport when the anchor is near the edge", () => {
    // jsdom reports 0 for offsetWidth/Height, so the clamp needs a size to bite: give the popover
    // one and put the anchor at the bottom-right corner.
    Object.defineProperty(popover, "offsetWidth", { value: 300, configurable: true });
    Object.defineProperty(popover, "offsetHeight", { value: 400, configurable: true });
    Object.defineProperty(anchor, "getBoundingClientRect", {
      value: () => ({
        left: window.innerWidth - 50,
        bottom: window.innerHeight - 10,
        top: 10,
        right: 0,
        width: 40,
        height: 20,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }),
      configurable: true,
    });
    ui.show(anchor, "test", TOOLS);
    // Left: pulled back inside; top: flipped ABOVE the anchor because it would not fit below.
    expect(Number.parseInt(popover.style.left, 10)).toBe(window.innerWidth - 300 - 8);
    expect(Number.parseInt(popover.style.top, 10)).toBe(Math.max(8, 10 - 400 - 4));
  });
});

describe("hiding", () => {
  it("empties its state, so the next open starts from the host's flags again", () => {
    ui.show(anchor, "test", [{ name: "a" }]);
    boxes()[0].checked = false;
    boxes()[0].dispatchEvent(new Event("change")); // a draft that was never saved
    ui.hide();
    ui.show(anchor, "test", [{ name: "a" }]);
    expect(boxes()[0].checked).toBe(true); // the draft did not leak
    expect(save().disabled).toBe(true);
  });

  it("Cancel discards everything", () => {
    ui.show(anchor, "test", TOOLS);
    byText("None").click();
    byText("Cancel").click();
    expect(popover.classList.contains("hidden")).toBe(true);
    expect(post).not.toHaveBeenCalled();
  });
});
