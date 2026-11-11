// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createMcpToolsPopover, type McpToolsPopover } from "./mcp-tools-popover";
import { tipTextOf } from "./tips";

/**
 * The tools popover on its own: the draft, the two switches per tool, the filter, the counts, the Save
 * as intent, and the busy rule.
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
/** The EXPOSURE control of each row: the SAME pill the server list wears, not a checkbox. It is the
 *  row's first child — which is also the structural promise the CSS and the row-delegation rely on. */
const switches = (): HTMLButtonElement[] => [
  ...popover.querySelectorAll<HTMLButtonElement>(".mcp-pop-row > .harny-switch"),
];
/** The ANALYZE control of each row: the same pill, inside its labelled cluster. */
const analyzeSwitches = (): HTMLButtonElement[] => [
  ...popover.querySelectorAll<HTMLButtonElement>(".mcp-pop-analyze .harny-switch"),
];
/** Is that pill ON? The state lives in `aria-checked` (a switch has no `checked` property). */
const onStates = (): boolean[] => switches().map((s) => s.getAttribute("aria-checked") === "true");
const analyzeStates = (): boolean[] => analyzeSwitches().map((s) => s.getAttribute("aria-checked") === "true");
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
    expect(onStates()).toEqual([true, true]);
    // Two switches, not a switch and a checkbox: the same class, role and attribute the server card
    // uses, so the controls cannot drift into two looks for two versions of one question.
    for (const sw of [...switches(), ...analyzeSwitches()]) {
      expect(sw.className).toBe("harny-switch");
      expect(sw.getAttribute("role")).toBe("switch");
    }
    expect(popover.querySelector(".mcp-pop-row input")).toBeNull();
  });

  it("labels the second switch in WORDS, and says what the two columns do", () => {
    // The user's report that started this: two identical pills with no words are a guessing game.
    ui.show(anchor, "test", TOOLS);
    expect(rows().map((r) => r.querySelector(".mcp-pop-analyze-label")!.textContent)).toEqual(["Analyze", "Analyze"]);
    expect(popover.querySelector(".mcp-pop-legend")!.textContent).toContain("the model sees the tool");
    expect(popover.querySelector(".mcp-pop-legend")!.textContent).toContain("read-only");
  });

  it("starts from the HOST's flags: a tool switched off for this session is off", () => {
    ui.show(anchor, "test", [{ name: "a", off: true }, { name: "b" }]);
    expect(onStates()).toEqual([false, true]);
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
  it("a switch toggles ONE tool, and Save stays disabled until something changes", () => {
    ui.show(anchor, "test", TOOLS);
    expect(save().disabled).toBe(true);

    switches()[1].click();
    expect(rows()[1].classList.contains("off")).toBe(true);
    expect(onStates()).toEqual([true, false]);
    expect(count().textContent).toBe("1 of 2 enabled · 1 read-only in Analyze");
    expect(save().disabled).toBe(false);
  });

  it("All / None flip the whole list, and come back to clean when the draft stops differing", () => {
    ui.show(anchor, "test", TOOLS);
    byText("None").click();
    expect(onStates()).toEqual([false, false]);
    // The Analyze count only speaks for tools the model can SEE: hiding everything leaves nothing
    // that could run in Analyze, so the suffix disappears instead of promising a run.
    expect(count().textContent).toBe("0 of 2 enabled");
    expect(save().disabled).toBe(false);

    byText("All").click();
    expect(onStates()).toEqual([true, true]);
    expect(count().textContent).toBe("2 of 2 enabled · 1 read-only in Analyze");
    expect(save().disabled).toBe(true); // nothing differs from what is saved
  });

  it("the whole row is a shortcut for its switch — one press, one flip", () => {
    // The row is a <div> now, so nothing forwards a click for us: the delegation is explicit, and it
    // must not run TWICE when the press lands on the switch itself.
    ui.show(anchor, "test", TOOLS);
    rows()[1].click();
    expect(onStates()).toEqual([true, false]);
    switches()[1].click();
    expect(onStates()).toEqual([true, true]);
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

describe("the Analyze switch", () => {
  it("follows the host's flags: ON for a declaration of THIS session, OFF otherwise", () => {
    ui.show(anchor, "test", TOOLS);
    expect(analyzeStates()).toEqual([true, false]);
    expect(tipTextOf(analyzeSwitches()[0])).toContain("this conversation declares it read-only");
    expect(tipTextOf(analyzeSwitches()[1])).toContain("Refused in Analyze");
    expect(analyzeSwitches()[1].disabled).toBe(false); // a tool the model can see is editable
  });

  it("is INHERITED (on, disabled) when the SERVER declares every tool of it read-only", () => {
    // `readOnly` without `analyzeFlag` is the server's own statement: a fact of the INSTALL, not a
    // decision of this conversation, so the switch must not pretend it could be taken back here.
    ui.show(anchor, "test", [{ name: "ro", readOnly: true }]);
    expect(analyzeStates()).toEqual([true]);
    expect(analyzeSwitches()[0].disabled).toBe(true);
    expect(popover.querySelector(".mcp-pop-analyze")!.classList.contains("inherited")).toBe(true);
    expect(tipTextOf(analyzeSwitches()[0])).toContain("declares every tool of it read-only");
  });

  it("is INERT for a tool the model cannot see, and says to switch it on first", () => {
    // Same rule as the exposure switch on a busy run: no state to change, so no press to accept.
    ui.show(anchor, "test", [{ name: "a", off: true, analyzeFlag: true }]);
    expect(analyzeSwitches()[0].disabled).toBe(true);
    expect(analyzeStates()).toEqual([false]); // a hidden tool does not run in Analyze, whatever it holds
    expect(tipTextOf(analyzeSwitches()[0])).toContain("switch the tool on first");
  });

  it("turning the exposure switch off re-derives it: the two controls are one row, one state each", () => {
    ui.show(anchor, "test", [{ name: "a", analyzeFlag: true }]);
    expect(analyzeStates()).toEqual([true]);
    switches()[0].click();
    expect(onStates()).toEqual([false]);
    expect(analyzeStates()).toEqual([false]);
    expect(analyzeSwitches()[0].disabled).toBe(true);
    // …and switching it back on restores the declaration: hiding a tool does not ERASE the decision.
    switches()[0].click();
    expect(analyzeStates()).toEqual([true]);
    expect(analyzeSwitches()[0].disabled).toBe(false);
  });

  it("declaring a tool read-only marks the draft dirty and counts it; clicking again takes it back", () => {
    ui.show(anchor, "test", TOOLS);
    analyzeSwitches()[1].click();
    expect(analyzeStates()[1]).toBe(true);
    expect(count().textContent).toBe("2 of 2 enabled · 2 read-only in Analyze");
    expect(save().disabled).toBe(false);
    analyzeSwitches()[1].click();
    expect(analyzeStates()[1]).toBe(false);
    expect(count().textContent).toBe("2 of 2 enabled · 1 read-only in Analyze");
  });

  it("is ONE press per click — the pill and the WORD both flip it exactly once", () => {
    ui.show(anchor, "test", TOOLS);
    // The label is part of the cluster's target, and the click on the pill bubbles to that same
    // handler: a second flip would leave the switch exactly where it started.
    rows()[1].querySelector<HTMLElement>(".mcp-pop-analyze-label")!.click();
    expect(analyzeStates()[1]).toBe(true);
    analyzeSwitches()[1].click();
    expect(analyzeStates()[1]).toBe(false);
  });

  it("never toggles the exposure switch of its row", () => {
    ui.show(anchor, "test", TOOLS);
    analyzeSwitches()[1].click();
    expect(onStates()[1]).toBe(true); // the cluster stops its own click: it answers another question
    rows()[1].querySelector<HTMLElement>(".mcp-pop-analyze-label")!.click();
    expect(onStates()[1]).toBe(true);
  });
});

describe("Save", () => {
  it("posts ONE message: the session's selection and its Analyze declarations, together", () => {
    // One write, because both answers live in the same `tool_scope` row: sending them apart is how
    // the two halves could disagree for a moment — and the config file is not touched at all.
    ui.show(anchor, "test", TOOLS);
    switches()[1].click(); // hide `drop_table`
    save().click();

    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith({
      type: "setMcpToolSelection",
      server: "test",
      enabled: ["read_query"],
      // The declaration of a tool that is now HIDDEN rides along untouched: hiding is not erasing.
      analyze: ["read_query"],
    });
    expect(status().textContent).toBe("Saving…");
  });

  it("sends an Analyze this session ADDED, and stops sending one it took back", () => {
    ui.show(anchor, "test", TOOLS);
    analyzeSwitches()[1].click(); // declare `drop_table` read-only
    analyzeSwitches()[0].click(); // …and take `read_query` back
    save().click();
    expect(post).toHaveBeenCalledWith({
      type: "setMcpToolSelection",
      server: "test",
      enabled: ["read_query", "drop_table"],
      analyze: ["drop_table"],
    });
  });

  it("refuses while a run is in flight — and the flag is read at CLICK time", () => {
    ui.show(anchor, "test", TOOLS);
    switches()[1].click();
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
    const staleSwitch = switches()[1];
    const staleAnalyze = analyzeSwitches()[1];
    const staleSave = save();
    ui.hide();
    post.mockClear();

    staleSwitch.click();
    staleAnalyze.click();
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
    switches()[0].click(); // a draft that was never saved
    ui.hide();
    ui.show(anchor, "test", [{ name: "a" }]);
    expect(onStates()).toEqual([true]); // the draft did not leak
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
