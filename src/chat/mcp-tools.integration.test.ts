// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpManager } from "../core/mcp/mcp-manager";
import { toolDefinitionsForMode } from "../core/tools/mode-policy";
import { HarnyFileConfigProvider } from "../core/config/harny-file-config-provider";
import { nodeFileSystem } from "../core/tools/file-system";
import { bootClient, detachBridge, pageOf, resetBridge, wire } from "./webview-bridge.test-utils";

/**
 * The MCP **tools panel**, END TO END — and this one goes all the way down.
 *
 * `view.test.ts` proves the panel against a fixture; `chat-view.test.ts` proves the
 * route against a fake catalog; `mcp-manager.test.ts` proves the registration. None of
 * them can see what a click on a checkbox ACTUALLY does across the whole stack: the
 * payload the client posts, the config FILE it lands in, the reconnect it triggers, and
 * the tool list the model is finally offered.
 *
 * Here every layer is real — a config file in a temp dir, the real `McpManager` spawning
 * a real stdio MCP server, the page `renderViewHtml` produces, the real client module —
 * and the test only clicks. The MCP server advertises `echo` + `ping`.
 */

// ── VS Code, reduced to what the flow touches (mocks are per test FILE) ──────
const dialogs = vi.hoisted(() => ({
  showInputBox: vi.fn(async () => undefined as string | undefined),
  showWarningMessage: vi.fn(async () => undefined as string | undefined),
  showErrorMessage: vi.fn(async () => undefined),
  showInformationMessage: vi.fn(async () => undefined),
}));

vi.mock("vscode", () => ({
  window: {
    showInputBox: dialogs.showInputBox,
    showWarningMessage: dialogs.showWarningMessage,
    showErrorMessage: dialogs.showErrorMessage,
    showInformationMessage: dialogs.showInformationMessage,
  },
  commands: { executeCommand: vi.fn(async () => undefined) },
  workspace: {
    getConfiguration: () => ({ get: () => undefined, update: vi.fn(async () => undefined) }),
    onDidChangeConfiguration: () => ({ dispose: () => {} }),
    fs: { writeFile: vi.fn(async () => {}), readFile: vi.fn(async () => new Uint8Array()) },
  },
  Uri: {
    joinPath: (_base: unknown, ...parts: string[]) => ({ fsPath: "/ext/" + parts.join("/") }),
    file: (p: string) => ({ fsPath: p }),
  },
}));

/** A tiny MCP server (stdio, newline JSON-RPC): advertises `echo` and `ping`. */
const SERVER = `
let buf = "";
process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    if (m.method === "initialize") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "t", version: "1" } } }) + "\\n");
    } else if (m.method === "tools/list") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "echo", description: "Echo" }, { name: "ping" }] } }) + "\\n");
    }
  }
});
`;

let dir = "";
let config: HarnyFileConfigProvider;
let manager: McpManager;

/** Write the config file the extension would read, then point the manager at it. */
function setup(server: Record<string, unknown>): void {
  writeFileSync(join(dir, "config.json"), JSON.stringify({ mcpServers: { test: server } }, null, 2));
  config = new HarnyFileConfigProvider(() => dir, nodeFileSystem);
  manager = new McpManager({ servers: () => config.readMcpServers() });
}

/** The tools panel's Save button. */
const panelSave = () =>
  [...document.querySelectorAll<HTMLButtonElement>("#mcp-tools-popover button")].find((b) => b.textContent === "Save")!;

/** The card's `(N tools)` key — re-queried every time: a config push REPLACES it. */
const toolsKey = () => document.querySelector(".mcp-tools-btn") as HTMLButtonElement;

/** Is this tool row ON? A switch, not a checkbox: the state is the attribute, `aria-checked`. */
const switchState = (row: HTMLElement): string =>
  (row.querySelector(":scope > .harny-switch") as HTMLButtonElement).getAttribute("aria-checked")!;

/** Is this row's ANALYZE switch on? Same attribute, the second pill of the row. */
const analyzeState = (row: HTMLElement): string =>
  (row.querySelector(".mcp-pop-analyze .harny-switch") as HTMLButtonElement).getAttribute("aria-checked")!;

beforeEach(() => {
  resetBridge();
  dir = mkdtempSync(join(tmpdir(), "harny-mcp-"));
});

afterEach(() => {
  manager?.dispose();
  detachBridge();
  rmSync(dir, { recursive: true, force: true });
});

describe("MCP tools panel, host ⇄ webview ⇄ server", () => {
  it("unchecking a tool writes the SESSION's scope — the config is not touched, nothing reconnects", async () => {
    setup({ command: process.execPath, args: ["-e", SERVER] });
    await manager.connect();

    const { provider, store, html } = wire({
      providers: {
        readMcpServers: () => config.readMcpServers(),
        saveMcpServers: (servers) => config.saveMcpServers(servers),
      },
      mcp: manager,
    });
    await bootClient(await pageOf(html));
    const sess = store.create("scope-1");
    provider.openSession(sess.id); // a session to hold the decision
    await vi.waitFor(() => expect(store.summary(sess.id)?.toolScope).toEqual({ mcp: [], off: [], analyze: [] }));

    // Nothing is switched off yet: the panel opens fully checked.
    await vi.waitFor(() => expect(toolsKey().textContent).toBe("(2 tools)"), { timeout: 5000 });
    toolsKey().click();
    const rows = [...document.querySelectorAll<HTMLElement>("#mcp-tools-popover .mcp-pop-row")];
    expect(rows.map((r) => r.querySelector(".mcp-pop-name")!.textContent)).toEqual(["echo", "ping"]);
    expect(rows.map((r) => switchState(r))).toEqual(["true", "true"]);

    // Hide `ping` and save.
    (rows[1].querySelector(":scope > .harny-switch") as HTMLButtonElement).click();
    panelSave().click();

    // 1. THE SESSION carries the decision, as the name a scope holds.
    const scope = await vi.waitFor(() => {
      const value = store.summary(sess.id)?.toolScope;
      // The server stays ON for this session (its `echo` is enabled): only `ping` is off, by name —
      // and the Analyze list is the session's own (empty here).
      expect(value).toEqual({ mcp: ["test"], off: ["mcp__test__ping"], analyze: [] });
      return value;
    });
    void scope;
    // 2. …and the CONFIG FILE is untouched: no `excludeTools` appeared.
    expect(config.readMcpServers().test.excludeTools).toBeUndefined();
    const raw = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
    expect(raw.mcpServers.test.excludeTools).toBeUndefined();
    expect(raw.mcpServers.test.command).toBe(process.execPath);

    // 3. Nothing reconnected: the registry still holds BOTH tools (the scope is what filters the
    //    per-turn list, so a save no longer respawns an npx process).
    expect(manager.getTools().map((t) => t.name)).toEqual(["mcp__test__echo", "mcp__test__ping"]);
    // 4. The model's per-turn list is filtered by that scope.
    const defs = toolDefinitionsForMode(manager.getTools(), "agent", {
      scope: { mcp: ["test"], off: ["mcp__test__ping"], analyze: [] },
    });
    expect(defs.map((d) => d.name)).toEqual(["mcp__test__echo"]);

    // The CARD reflects the session (it comes from the same payload the panel reads): waiting for it
    // is what makes the reopen below deterministic instead of a race with the config push.
    await vi.waitFor(() => expect(toolsKey().textContent).toBe("(1/2 tools)"), { timeout: 5000 });
    // Reopening shows the SAVED state.
    toolsKey().click();
    const reopened = [...document.querySelectorAll<HTMLElement>("#mcp-tools-popover .mcp-pop-row")];
    expect(reopened.map((r) => switchState(r))).toEqual(["true", "false"]);
  });

  it("a tool excluded in the FILE seeds a new session, which then owns the decision", async () => {
    setup({ command: process.execPath, args: ["-e", SERVER], excludeTools: ["ping"] });
    await manager.connect();

    // The registry holds everything: the config is a seed, not a veto.
    expect(manager.getTools().map((t) => t.name)).toEqual(["mcp__test__echo", "mcp__test__ping"]);

    const { provider, store, html } = wire({
      providers: {
        readMcpServers: () => config.readMcpServers(),
        saveMcpServers: (servers) => config.saveMcpServers(servers),
      },
      mcp: manager,
    });
    await bootClient(await pageOf(html));
    const sess = store.create("seed-1");
    provider.openSession(sess.id);

    // The new session starts with every server OFF and the file's exclusions carried over as
    // `off` names — so unchecking a tool in the file still means "the model must not see it".
    await vi.waitFor(() =>
      expect(store.summary(sess.id)?.toolScope).toEqual({ mcp: [], off: ["mcp__test__ping"], analyze: [] }),
    );

    // The panel shows exactly that: `ping` unchecked, the card counting what the SESSION can use,
    // and the list COMPLETE so it stays editable.
    await vi.waitFor(() => expect(toolsKey().textContent).toBe("(1/2 tools)"), { timeout: 5000 });
    toolsKey().click();
    const rows = [...document.querySelectorAll<HTMLElement>("#mcp-tools-popover .mcp-pop-row")];
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => switchState(r))).toEqual(["true", "false"]);
  });

  it("switching every tool off keeps the server connected (zero exposed is a state, not a crash)", async () => {
    setup({ command: process.execPath, args: ["-e", SERVER] });
    await manager.connect();

    const { provider, store, html } = wire({
      providers: {
        readMcpServers: () => config.readMcpServers(),
        saveMcpServers: (servers) => config.saveMcpServers(servers),
      },
      mcp: manager,
    });
    await bootClient(await pageOf(html));
    const sess = store.create("scope-2");
    provider.openSession(sess.id);
    await vi.waitFor(() => expect(store.summary(sess.id)?.toolScope).toEqual({ mcp: [], off: [], analyze: [] }));

    await vi.waitFor(() => expect(toolsKey().textContent).toBe("(2 tools)"), { timeout: 5000 });
    toolsKey().click();
    [...document.querySelectorAll<HTMLButtonElement>("#mcp-tools-popover button")]
      .find((b) => b.textContent === "None")!
      .click();
    panelSave().click();

    await vi.waitFor(() =>
      expect(store.summary(sess.id)?.toolScope).toEqual({
        mcp: [],
        off: ["mcp__test__echo", "mcp__test__ping"],
        analyze: [],
      }),
    );
    // The server is still connected and still offers both tools; only the per-turn list is empty.
    expect(manager.getStatuses()[0].ok).toBe(true);
    expect(manager.getTools()).toHaveLength(2);
    expect(
      toolDefinitionsForMode(manager.getTools(), "agent", {
        scope: { mcp: [], off: ["mcp__test__echo", "mcp__test__ping"], analyze: [] },
      }),
    ).toEqual([]);
  });

  it("the Analyze switch declares ONE tool read-only for THIS session (scope, not the file)", async () => {
    // Nothing about the server is declared in the file: in Analyze none of its tools runs.
    setup({ command: process.execPath, args: ["-e", SERVER] });
    await manager.connect();

    const { provider, store, html } = wire({
      providers: {
        readMcpServers: () => config.readMcpServers(),
        saveMcpServers: (servers) => config.saveMcpServers(servers),
      },
      mcp: manager,
    });
    await bootClient(await pageOf(html));
    const sess = store.create("analyze-1");
    provider.openSession(sess.id);

    await vi.waitFor(() => expect(toolsKey().textContent).toBe("(2 tools)"), { timeout: 5000 });
    // Before: both tools refuse — the server declares nothing.
    expect(manager.getTools().map((t) => t.analyzePolicy)).toEqual(["refuse", "refuse"]);

    toolsKey().click();
    const rows = [...document.querySelectorAll<HTMLElement>("#mcp-tools-popover .mcp-pop-row")];
    expect(rows.map(analyzeState)).toEqual(["false", "false"]);
    (rows[0].querySelector(".mcp-pop-analyze .harny-switch") as HTMLButtonElement).click();
    panelSave().click();

    // 1. the SESSION carries it, as the registered name the Analyze gate reads…
    await vi.waitFor(() => expect(store.summary(sess.id)?.toolScope?.analyze).toEqual(["mcp__test__echo"]));
    // 2. …and the FILE is untouched: the server's install-level keys are the user's, not this panel's.
    expect(config.readMcpServers().test.analyzeTools).toBeUndefined();
    const raw = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
    expect("analyzeTools" in raw.mcpServers.test).toBe(false);
    // 3. the tool's own policy is the INSTALL's and does NOT move: the session's half is applied by
    //    the agent (see agent.test.ts), the only side that knows which conversation is running.
    expect(manager.getTools().map((t) => t.analyzePolicy)).toEqual(["refuse", "refuse"]);

    // 4. the panel reopens on the SAVED state, with the count saying it.
    toolsKey().click();
    const reopened = [...document.querySelectorAll<HTMLElement>("#mcp-tools-popover .mcp-pop-row")];
    expect(reopened.map(analyzeState)).toEqual(["true", "false"]);
    expect(document.querySelector(".mcp-pop-count")!.textContent).toBe("2 of 2 enabled · 1 read-only in Analyze");
    expect(panelSave().disabled).toBe(true); // nothing left to save
  });
});
