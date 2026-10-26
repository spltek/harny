// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpManager } from "../core/mcp/mcp-manager";
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
  it("unchecking a tool writes excludeTools, reconnects, and hides it from the model", async () => {
    setup({ command: process.execPath, args: ["-e", SERVER] });
    await manager.connect();

    const { html } = wire({
      providers: {
        readMcpServers: () => config.readMcpServers(),
        saveMcpServers: (servers) => config.saveMcpServers(servers),
      },
      mcp: manager,
    });
    await bootClient(await pageOf(html));

    // Nothing is excluded yet: the card says so, and the panel opens fully checked.
    await vi.waitFor(() => expect(toolsKey().textContent).toBe("(2 tools)"), { timeout: 5000 });
    toolsKey().click();
    const rows = [...document.querySelectorAll<HTMLElement>("#mcp-tools-popover .mcp-pop-row")];
    expect(rows.map((r) => r.querySelector(".mcp-pop-name")!.textContent)).toEqual(["echo", "ping"]);
    expect(rows.map((r) => (r.querySelector("input") as HTMLInputElement).checked)).toEqual([true, true]);
    expect(document.querySelector(".mcp-pop-count")!.textContent).toBe("2 of 2 enabled");
    expect(panelSave().disabled).toBe(true);

    // Hide `ping` and save.
    (rows[1].querySelector("input") as HTMLInputElement).click();
    panelSave().click();

    // 1. the CONFIG FILE really carries the exclusion (that is the whole point)…
    await vi.waitFor(() => expect(config.readMcpServers().test.excludeTools).toEqual(["ping"]), { timeout: 5000 });
    const raw = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
    expect(raw.mcpServers.test.excludeTools).toEqual(["ping"]);
    expect(raw.mcpServers.test.command).toBe(process.execPath); // …and the server survived the write
    // 2 …the RECONNECT dropped it from the tools the model is offered…
    await vi.waitFor(() => expect(manager.getTools().map((t) => t.name)).toEqual(["mcp__test__echo"]), {
      timeout: 5000,
    });
    // 3 …the card re-rendered with the new count, and the panel closed itself.
    await vi.waitFor(() => expect(toolsKey().textContent).toBe("(1/2 tools)"), { timeout: 5000 });
    expect((document.getElementById("mcp-tools-popover") as HTMLElement).classList.contains("hidden")).toBe(true);

    // Reopening shows the SAVED state, not the draft that was sent.
    toolsKey().click();
    const reopened = [...document.querySelectorAll<HTMLElement>("#mcp-tools-popover .mcp-pop-row")];
    expect(reopened.map((r) => (r.querySelector("input") as HTMLInputElement).checked)).toEqual([true, false]);
    expect(document.querySelector(".mcp-pop-count")!.textContent).toBe("1 of 2 enabled");
    expect(panelSave().disabled).toBe(true); // nothing to save
  });

  it("a tool excluded in the file is hidden from the model at activation and shown unchecked", async () => {
    setup({ command: process.execPath, args: ["-e", SERVER], excludeTools: ["ping"] });
    await manager.connect();

    // The model never sees it: exclusion happens at registration, not at call time.
    expect(manager.getTools().map((t) => t.name)).toEqual(["mcp__test__echo"]);

    const { html } = wire({
      providers: {
        readMcpServers: () => config.readMcpServers(),
        saveMcpServers: (servers) => config.saveMcpServers(servers),
      },
      mcp: manager,
    });
    await bootClient(await pageOf(html));

    await vi.waitFor(() => expect(toolsKey().textContent).toBe("(1/2 tools)"), { timeout: 5000 });
    toolsKey().click();
    const rows = [...document.querySelectorAll<HTMLElement>("#mcp-tools-popover .mcp-pop-row")];
    expect(rows.map((r) => (r.querySelector("input") as HTMLInputElement).checked)).toEqual([true, false]);
    expect(rows[1].classList.contains("off")).toBe(true);
    // The advertised list is COMPLETE: the hidden tool must still be editable.
    expect(rows).toHaveLength(2);
  });

  it("hiding every tool leaves the server connected with none exposed (no crash, no broken card)", async () => {
    setup({ command: process.execPath, args: ["-e", SERVER] });
    await manager.connect();

    const { html } = wire({
      providers: {
        readMcpServers: () => config.readMcpServers(),
        saveMcpServers: (servers) => config.saveMcpServers(servers),
      },
      mcp: manager,
    });
    await bootClient(await pageOf(html));

    await vi.waitFor(() => expect(toolsKey().textContent).toBe("(2 tools)"), { timeout: 5000 });
    toolsKey().click();
    [...document.querySelectorAll<HTMLButtonElement>("#mcp-tools-popover button")]
      .find((b) => b.textContent === "None")!
      .click();
    expect(document.querySelector(".mcp-pop-count")!.textContent).toBe("0 of 2 enabled");
    panelSave().click();

    await vi.waitFor(() => expect(config.readMcpServers().test.excludeTools).toEqual(["echo", "ping"]), {
      timeout: 5000,
    });
    await vi.waitFor(() => expect(manager.getTools()).toEqual([]), { timeout: 5000 });
    // The card still renders (and still opens the panel): zero exposed is a state, not
    // a broken server.
    await vi.waitFor(() => expect(toolsKey().textContent).toBe("(0/2 tools)"), { timeout: 5000 });
    expect(manager.getStatuses()[0].ok).toBe(true);
  });
});
