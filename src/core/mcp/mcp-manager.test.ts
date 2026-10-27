import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpManager } from "./mcp-manager";
import type { McpServerConfig } from "../config/types";
import { HarnyFileConfigProvider } from "../config/harny-file-config-provider";
import { nodeFileSystem } from "../tools/file-system";
import { ToolRegistry } from "../tools/tool-registry";

/** A tiny MCP server (stdio, newline JSON-RPC) spawned via `node -e`. */
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

describe("McpManager", () => {
  it("hands each tool the server's declared Analyze policy (and none by default)", async () => {
    // The gate reads the USER's declaration for the server, live: without it every tool
    // of that server is refused in Analyze (the strictest default), with it they follow
    // the declaration (see ServerAnalyzePolicy).
    const undeclared = new McpManager({
      servers: () => ({ test: { command: process.execPath, args: ["-e", SERVER] } }),
    });
    await undeclared.connect();
    expect(undeclared.getTools()[0].analyzePolicy).toBe("refuse");

    const readOnly = new McpManager({
      servers: () => ({ test: { command: process.execPath, args: ["-e", SERVER], analyze: "read-only" } }),
    });
    await readOnly.connect();
    expect(readOnly.getTools()[0].analyzePolicy).toBe("read-only");
  });

  it("registers EVERY tool: which of them a conversation may use is the SESSION's call", async () => {
    // `excludeTools` used to be a connect-time veto, which made the panel's checkboxes global and
    // forced a reconnect on every save. It is now a SEED for new sessions (see createNew): the
    // registry holds them all, and the per-turn tool list is filtered by the session's scope.
    const manager = new McpManager({
      servers: () => ({
        test: { command: process.execPath, args: ["-e", SERVER], excludeTools: ["ping"] },
      }),
    });
    await manager.connect();
    expect(manager.getTools().map((t) => t.name)).toEqual(["mcp__test__echo", "mcp__test__ping"]);
    const [status] = manager.getStatuses();
    expect(status.toolCount).toBe(2);
    // The advertised list is complete and unflagged: the panel builds its checkboxes from this,
    // and the `excluded` flag no longer exists (the session's scope says it).
    expect(status.tools).toEqual([{ name: "echo", description: "Echo" }, { name: "ping" }]);
  });

  it("an exclusion naming a tool the server does not have is harmless", async () => {
    const manager = new McpManager({
      servers: () => ({
        test: { command: process.execPath, args: ["-e", SERVER], excludeTools: ["gone-tomorrow"] },
      }),
    });
    await manager.connect();
    expect(manager.getTools().map((t) => t.name)).toEqual(["mcp__test__echo", "mcp__test__ping"]);
    expect(manager.getStatuses()[0].toolCount).toBe(2);
  });

  it("a re-connect does NOT change the tool list when the config stops excluding: the session does", async () => {
    // The counterpart of the test above: saving a config that adds an exclusion no longer hides
    // anything by itself. What hides a tool is the SESSION's scope, which is why this is a
    // registry-level assertion and the scope has its own tests.
    let servers: Record<string, McpServerConfig> = {
      test: { command: process.execPath, args: ["-e", SERVER] },
    };
    const manager = new McpManager({ servers: () => servers });
    await manager.connect();
    servers = { test: { ...servers.test, excludeTools: ["echo"] } };
    await manager.connect();
    expect(manager.getTools().map((t) => t.name)).toEqual(["mcp__test__echo", "mcp__test__ping"]);
    expect(manager.getStatuses()[0].toolCount).toBe(2);
  });

  it("overlapping connects are SERIALIZED (no two installs in the same npx cache entry)", async () => {
    // Activation fires `void mcp.connect()`; a save or a toggle fires another one. Overlapped,
    // each pass calls dispose() and kills the previous handshake mid-flight — and two
    // concurrent spawns of the same npx package race on the same cache directory.
    const manager = new McpManager({
      servers: () => ({ test: { command: process.execPath, args: ["-e", SERVER] } }),
    });
    await Promise.all([manager.connect(), manager.connect(), manager.connect()]);
    // Serialized, the last pass wins and the state is coherent: ONE status, both tools.
    expect(manager.getStatuses()).toHaveLength(1);
    expect(manager.getStatuses()[0].ok).toBe(true);
    expect(manager.getTools().map((t) => t.name)).toEqual(["mcp__test__echo", "mcp__test__ping"]);
  });

  it("a targeted reconnect touches ONLY that server (the others keep their processes)", async () => {
    // Toggling one server used to dispose() everything: every other npx process was killed
    // and respawned — slow, and the card's whole state churned. The `pid` tool proves it: a
    // respawned process answers with a different pid.
    const PID = `
let buf = "";
process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    if (m.method === "initialize") process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "p", version: "1" } } }) + "\\n");
    else if (m.method === "tools/list") process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "pid" }] } }) + "\\n");
    else if (m.method === "tools/call") process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: String(process.pid) }] } }) + "\\n");
  }
});
`;
    const manager = new McpManager({
      servers: () => ({
        a: { command: process.execPath, args: ["-e", PID] },
        b: { command: process.execPath, args: ["-e", PID] },
      }),
    });
    const pidOf = async (name: string) =>
      (
        await manager
          .getTools()
          .find((t) => t.name === `mcp__${name}__pid`)!
          .execute({})
      ).content;

    await manager.connect();
    const before = await pidOf("b");
    await manager.connect("a"); // what the enable/disable toggle does
    expect(await pidOf("b")).toBe(before); // same process: b was never touched
    expect(manager.getStatuses().map((s) => s.name)).toEqual(["a", "b"]); // order preserved

    // …and a FULL pass (a save from the editor) does respawn it: that is the difference.
    await manager.connect();
    expect(await pidOf("b")).not.toBe(before);
    manager.dispose();
  });

  it("a server that dies AFTER connecting is marked down and its tools withdrawn", async () => {
    // onExit existed but nobody subscribed: a crashed server stayed GREEN and its tools
    // stayed registered, so every call failed with "MCP server is not running" and the model
    // kept retrying them until someone reconnected by hand.
    const DYING = `
let buf = "";
process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    if (m.method === "initialize") process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "d", version: "1" } } }) + "\\n");
    if (m.method === "tools/list") process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "echo" }] } }) + "\\n");
  }
});
setTimeout(() => process.exit(1), 80);
`;
    let changed = 0;
    const logs: string[] = [];
    const manager = new McpManager({
      servers: () => ({ test: { command: process.execPath, args: ["-e", DYING] } }),
      onToolsChanged: () => changed++,
      log: (m) => logs.push(m),
    });
    await manager.connect();
    expect(manager.getStatuses()[0].ok).toBe(true);
    expect(manager.getTools()).toHaveLength(1);

    await vi.waitFor(() => expect(manager.getStatuses()[0].ok).toBe(false), { timeout: 5000 });
    expect(manager.getStatuses()[0].error).toContain("code=1");
    expect(manager.getTools()).toEqual([]);
    // The registry follows the withdrawal (that is what onToolsChanged is for).
    expect(logs.join("\n")).toContain("withdrawing 1 tool");
    expect(changed).toBeGreaterThanOrEqual(2);
    manager.dispose();
  });

  it("a deliberate reconnect leaves the server UP and its tools registered", async () => {
    // The end state a save/toggle must leave behind. (The precise guard — a deliberate
    // close() must not report an exit — is pinned at the client level, in
    // mcp-client.test.ts: killTree sends SIGKILL, so the child dies at once and the race
    // window cannot be reproduced deterministically from here.)
    const manager = new McpManager({
      servers: () => ({ test: { command: process.execPath, args: ["-e", SERVER] } }),
    });
    await manager.connect();
    await manager.connect(); // what a save or a toggle does
    await new Promise((r) => setTimeout(r, 200));
    expect(manager.getStatuses()).toHaveLength(1);
    expect(manager.getStatuses()[0].ok).toBe(true);
    expect(manager.getTools()).toHaveLength(2);
    manager.dispose();
  });

  it("reports a tool-name collision instead of silently dropping a tool", async () => {
    // `a-b` and `a_b` sanitize to the SAME Harny name: the registry keeps the first, so the
    // second vanished without a word and nobody knew a tool was missing.
    const COLLIDING = SERVER.replace(
      '[{ name: "echo", description: "Echo" }, { name: "ping" }]',
      '[{ name: "a-b" }, { name: "a_b" }]',
    );
    const logs: string[] = [];
    const manager = new McpManager({
      servers: () => ({ test: { command: process.execPath, args: ["-e", COLLIDING] } }),
      log: (m) => logs.push(m),
    });
    await manager.connect();
    expect(manager.getTools().map((t) => t.name)).toEqual(["mcp__test__a_b"]);
    expect(logs.join("\n")).toContain("tool-name collision");
    // The status still counts what the MODEL gets, so the card cannot over-promise.
    expect(manager.getStatuses()[0].toolCount).toBe(1);
    manager.dispose();
  });

  it("connects stdio servers, wraps their tools and reports status", async () => {
    let changed = 0;
    const manager = new McpManager({
      servers: () => ({ test: { command: process.execPath, args: ["-e", SERVER] } }),
      onToolsChanged: () => changed++,
    });
    await manager.connect();

    expect(manager.getStatuses()).toEqual([
      {
        name: "test",
        ok: true,
        enabled: true,
        toolCount: 2,
        tools: [{ name: "echo", description: "Echo" }, { name: "ping" }],
      },
    ]);
    expect(
      manager
        .getTools()
        .map((t) => t.name)
        .sort(),
    ).toEqual(["mcp__test__echo", "mcp__test__ping"]);
    expect(changed).toBe(1);
    manager.dispose();
    expect(manager.getTools()).toEqual([]);
  });

  it("reports a failing server without throwing (and skips its tools)", async () => {
    const manager = new McpManager({
      servers: () => ({ bad: { command: process.execPath, args: ["-e", "process.exit(3)"] } }),
    });
    await manager.connect();
    expect(manager.getStatuses()).toHaveLength(1);
    expect(manager.getStatuses()[0].ok).toBe(false);
    expect(manager.getStatuses()[0].error).toBeTruthy();
    expect(manager.getTools()).toEqual([]);
  });

  it("connects an HTTP server (url) and wraps its tools", async () => {
    const { createServer } = await import("node:http");
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        const m = JSON.parse(body);
        const send = (result: unknown) =>
          res
            .writeHead(200, { "content-type": "application/json" })
            .end(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }));
        if (m.method === "initialize")
          send({ protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "h", version: "1" } });
        else if (m.method === "tools/list") send({ tools: [{ name: "ping" }] });
        else res.writeHead(202).end();
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as { port: number }).port;
    try {
      const manager = new McpManager({ servers: () => ({ remote: { url: `http://127.0.0.1:${port}/mcp` } }) });
      await manager.connect();
      expect(manager.getStatuses()).toEqual([
        { name: "remote", ok: true, enabled: true, toolCount: 1, tools: [{ name: "ping" }] },
      ]);
      expect(manager.getTools().map((t) => t.name)).toEqual(["mcp__remote__ping"]);
      manager.dispose();
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("a DISABLED server is listed but not connected (no tools exposed)", async () => {
    const manager = new McpManager({
      servers: () => ({ off: { command: process.execPath, args: ["-e", SERVER], enabled: false } }),
    });
    await manager.connect();
    expect(manager.getStatuses()).toEqual([{ name: "off", ok: true, enabled: false, toolCount: 0 }]);
    expect(manager.getTools()).toEqual([]);
    manager.dispose();
  });

  it("reports a server with neither command nor url", async () => {
    const manager = new McpManager({ servers: () => ({ broken: {} as never }) });
    await manager.connect();
    expect(manager.getStatuses()[0].ok).toBe(false);
    expect(manager.getStatuses()[0].error).toContain("command");
  });

  it("reconnect disposes the previous connections", async () => {
    const manager = new McpManager({ servers: () => ({ test: { command: process.execPath, args: ["-e", SERVER] } }) });
    await manager.connect();
    const first = manager.getTools().length;
    await manager.connect(); // idempotent reconnect
    expect(manager.getTools().length).toBe(first);
    manager.dispose();
  });

  it("INTEGRATION: disabling a server removes its tools from the registry", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harny-mcp-int-"));
    try {
      const provider = new HarnyFileConfigProvider(() => dir, nodeFileSystem);
      expect(provider.saveMcpServers({ srv: { command: process.execPath, args: ["-e", SERVER] } })).toBe(true);

      const tools = new ToolRegistry([]);
      const manager = new McpManager({
        servers: () => provider.readMcpServers(),
        onToolsChanged: () => {
          tools.removeByPrefix("mcp__");
          tools.add(manager.getTools());
        },
      });
      await manager.connect();
      expect(tools.get("mcp__srv__echo")).toBeDefined();

      // Toggle OFF exactly like the host handler: read → set enabled:false → save → reconnect.
      const servers = provider.readMcpServers();
      servers.srv = { ...servers.srv, enabled: false };
      expect(provider.saveMcpServers(servers)).toBe(true);
      await manager.connect();

      expect(tools.get("mcp__srv__echo")).toBeUndefined();
      expect(tools.getAll().some((t) => t.name.startsWith("mcp__"))).toBe(false);
      expect(provider.readMcpServers().srv.enabled).toBe(false);
      manager.dispose();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
