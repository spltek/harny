// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createMcpCard, type McpCard, type McpCardDeps } from "./mcp-card";
import { offToolNames } from "./mcp-tool-flags";

/**
 * The MCP card on its own: rows, the SESSION switch, the `(N/M tools)` count and the status line.
 *
 * The panel's tests still walk through the whole webview; these pin what THIS module owns, including
 * the two things that are easy to get subtly wrong: the count is the SESSION's view of the tools
 * (not the registry's), and the busy flag must be read at CLICK time — the rows survive a run
 * starting, so a handler capturing the flag of the moment it was built would keep a stale one.
 */

let card: HTMLElement;
let list: HTMLElement;
let post: ReturnType<typeof vi.fn<(message: unknown) => void>>;
let openTools: ReturnType<
  typeof vi.fn<(anchor: HTMLElement, server: string, tools: { name: string; off?: boolean }[]) => void>
>;
let ui: McpCard;

const SCOPE = { mcp: [] as string[], off: [] as string[] };

beforeEach(() => {
  document.body.innerHTML = `<div id="mcp-card" class="hidden"><div id="mcp-list"></div></div>`;
  card = document.getElementById("mcp-card") as HTMLElement;
  list = document.getElementById("mcp-list") as HTMLElement;
  post = vi.fn<(message: unknown) => void>();
  openTools = vi.fn();
  const deps: McpCardDeps = { card, list, post, openTools };
  ui = createMcpCard(deps);
});

const rows = (): HTMLElement[] => [...list.querySelectorAll<HTMLElement>(".mcp-status")];
const switches = (): HTMLButtonElement[] => [...list.querySelectorAll<HTMLButtonElement>(".mcp-switch")];

const CONFIG = {
  servers: { a: { command: "node" }, b: { command: "node", enabled: false } },
  statuses: [
    { name: "a", ok: true, enabled: true, toolCount: 2 },
    { name: "b", ok: true, enabled: false, toolCount: 0 },
  ],
};

describe("the rows", () => {
  it("is hidden with no server, and shows one row per installed server", () => {
    ui.render({ servers: {}, statuses: [] }, SCOPE, false);
    expect(card.classList.contains("hidden")).toBe(true);
    ui.render(CONFIG, SCOPE, false);
    expect(card.classList.contains("hidden")).toBe(false);
    expect(rows()).toHaveLength(2);
  });

  it("the switch carries the SESSION's state (aria-checked), not the config's", () => {
    ui.render(CONFIG, { mcp: ["a"], off: [] }, false);
    expect(switches().map((s) => s.getAttribute("aria-checked"))).toEqual(["true", "false"]);
    expect(switches().map((s) => s.getAttribute("role"))).toEqual(["switch", "switch"]);
    // A server the config disables is NOT installed here: it cannot be switched on in a session.
    expect(switches().map((s) => s.disabled)).toEqual([false, true]);
    expect(switches()[1].title).toContain("Not installed");
  });

  it("the status line says off / error / connected", () => {
    ui.render(
      {
        servers: { off1: {}, bad: {} },
        statuses: [
          { name: "off1", ok: true, enabled: false, toolCount: 0 },
          { name: "bad", ok: false, enabled: true, toolCount: 0, error: "spawn ENOENT" },
        ],
      },
      SCOPE,
      false,
    );
    const details = [...list.querySelectorAll<HTMLElement>(".mcp-detail")];
    expect(details.map((d) => d.textContent)).toEqual(["off", "spawn ENOENT"]);
    // The row is ONE line: the full error lives in the tooltip, not in the layout.
    expect(details[1].title).toBe("spawn ENOENT");
  });
});

describe("the (N/M tools) count", () => {
  it("counts what THIS session can use, and stays quiet when nothing is off", () => {
    ui.render(
      {
        servers: { a: {} },
        statuses: [{ name: "a", ok: true, enabled: true, toolCount: 2, tools: [{ name: "x" }, { name: "y" }] }],
      },
      SCOPE,
      false,
    );
    expect(list.querySelector(".mcp-tools-btn")!.textContent).toBe("(2 tools)");

    ui.render(
      {
        servers: { a: {} },
        statuses: [
          { name: "a", ok: true, enabled: true, toolCount: 2, tools: [{ name: "x", off: true }, { name: "y" }] },
        ],
      },
      SCOPE,
      false,
    );
    expect(list.querySelector(".mcp-tools-btn")!.textContent).toBe("(1/2 tools)");
    expect(list.querySelector(".mcp-tools-btn")!.getAttribute("title")).toContain("1 of 2 tool(s) switched off");
  });

  it("falls back to the registry's count when the host sent no tool list", () => {
    // An older host (or a server that advertises nothing yet): no list to subtract from.
    ui.render({ servers: { a: {} }, statuses: [{ name: "a", ok: true, enabled: true, toolCount: 7 }] }, SCOPE, false);
    expect(list.querySelector(".mcp-tools-btn")!.textContent).toBe("(7 tools)");
  });

  it("opens the tools panel on the button, passing the server and its tools", () => {
    const tools = [{ name: "x" }, { name: "y" }];
    ui.render(
      { servers: { a: {} }, statuses: [{ name: "a", ok: true, enabled: true, toolCount: 2, tools }] },
      SCOPE,
      false,
    );
    const btn = list.querySelector<HTMLButtonElement>(".mcp-tools-btn")!;
    btn.click();
    expect(openTools).toHaveBeenCalledWith(btn, "a", tools);
  });
});

describe("the clicks", () => {
  it("the switch toggles ONE server in the scope, preserving every other decision", () => {
    ui.render(CONFIG, { mcp: ["a"], off: ["Shell"] }, false);
    switches()[0].click(); // turn `a` off
    expect(post).toHaveBeenCalledWith({ type: "setToolScope", scope: { mcp: [], off: ["Shell"] } });

    post.mockClear();
    ui.render(CONFIG, { mcp: [], off: ["Shell"] }, false);
    switches()[0].click(); // turn it on again
    expect(post).toHaveBeenCalledWith({ type: "setToolScope", scope: { mcp: ["a"], off: ["Shell"] } });
  });

  it("the NAME is the machine's switch: it posts toggleMcpServer", () => {
    ui.render(CONFIG, SCOPE, false);
    (list.querySelector(".mcp-name") as HTMLElement).click();
    expect(post).toHaveBeenCalledWith({ type: "toggleMcpServer", name: "a", enabled: false });
  });

  it("a click while busy does nothing — and the rows are OLDER than the run", () => {
    // The trap this covers: rows are rebuilt only when the payload changes, so they survive a run
    // starting. A handler that captured `busy` at build time would stay live for ever.
    //
    // The SWITCH is also `disabled` while busy (so the browser swallows the click anyway); the NAME
    // is a plain span and cannot be, which makes IT the real test of the flag: a stale closure there
    // posts `toggleMcpServer` in the middle of a run.
    ui.render(CONFIG, { mcp: ["a"], off: [] }, false);
    ui.refreshSwitches(true); // the run starts; the DOM is NOT rebuilt
    expect(switches()[0].disabled).toBe(true);
    expect(switches()[0].title).toContain("Stop the run first");
    post.mockClear();
    (list.querySelector(".mcp-name") as HTMLElement).click();
    expect(post).not.toHaveBeenCalled(); // the flag is read at CLICK time
    // …and it comes back the moment the run ends, on the same row.
    ui.refreshSwitches(false);
    (list.querySelector(".mcp-name") as HTMLElement).click();
    expect(post).toHaveBeenCalledWith({ type: "toggleMcpServer", name: "a", enabled: false });
  });

  it("the switch itself refuses to act while busy, even if a click is dispatched at it", () => {
    // `disabled` swallows a real click, so the guard inside the handler is invisible to the browser.
    // Dispatching the event directly proves it is not a dead line: a programmatic click (or a future
    // caller that forgets the attribute) still cannot flip a server mid-run.
    ui.render(CONFIG, { mcp: ["a"], off: [] }, false);
    ui.refreshSwitches(true);
    post.mockClear();
    switches()[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(post).not.toHaveBeenCalled();
  });

  it("the busy state comes back when the run ends, on the same rows", () => {
    ui.render(CONFIG, SCOPE, false);
    const first = switches()[0];
    ui.refreshSwitches(true);
    ui.refreshSwitches(false);
    expect(switches()[0]).toBe(first); // no rebuild
    expect(switches()[0].disabled).toBe(false);
    expect(switches()[0].title).toContain("Use a in this session");
  });
});

describe("the redraw signature", () => {
  it("does not rebuild the rows when nothing changed (they used to be replaced under the cursor)", () => {
    ui.render(CONFIG, SCOPE, false);
    const before = rows()[0];
    ui.render(CONFIG, SCOPE, false);
    expect(rows()[0]).toBe(before);
  });

  it("rebuilds when the SCOPE changes (a switch must redraw)", () => {
    ui.render(CONFIG, SCOPE, false);
    const before = rows()[0];
    ui.render(CONFIG, { mcp: ["a"], off: [] }, false);
    expect(rows()[0]).not.toBe(before);
  });

  it("an unchanged payload still refreshes the switches' availability", () => {
    // The payload is identical but the RUN changed: the dimming must land without a rebuild.
    ui.render(CONFIG, SCOPE, false);
    ui.render(CONFIG, SCOPE, true);
    expect(switches()[0].disabled).toBe(true);
  });

  it("exposes the last statuses it drew", () => {
    ui.render(CONFIG, SCOPE, false);
    expect(ui.statuses().map((s) => s.name)).toEqual(["a", "b"]);
  });
});

describe("offToolNames", () => {
  it("reads the host's flags, and tolerates a missing list", () => {
    expect([...offToolNames([{ name: "x", off: true }, { name: "y" }, { name: "z", off: true }])]).toEqual(["x", "z"]);
    expect(offToolNames(undefined).size).toBe(0);
  });
});
