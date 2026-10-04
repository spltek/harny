import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpManager } from "./mcp-manager";
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
  it("connects stdio servers, wraps their tools and reports status", async () => {
    let changed = 0;
    const manager = new McpManager({
      servers: () => ({ test: { command: process.execPath, args: ["-e", SERVER] } }),
      onToolsChanged: () => changed++,
    });
    await manager.connect();

    expect(manager.getStatuses()).toEqual([
      { name: "test", ok: true, enabled: true, toolCount: 2, tools: [{ name: "echo", description: "Echo" }, { name: "ping" }] },
    ]);
    expect(manager.getTools().map((t) => t.name).sort()).toEqual(["mcp__test__echo", "mcp__test__ping"]);
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
        const send = (result: unknown) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }));
        if (m.method === "initialize") send({ protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "h", version: "1" } });
        else if (m.method === "tools/list") send({ tools: [{ name: "ping" }] });
        else res.writeHead(202).end();
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as { port: number }).port;
    try {
      const manager = new McpManager({ servers: () => ({ remote: { url: `http://127.0.0.1:${port}/mcp` } }) });
      await manager.connect();
      expect(manager.getStatuses()).toEqual([{ name: "remote", ok: true, enabled: true, toolCount: 1, tools: [{ name: "ping" }] }]);
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
