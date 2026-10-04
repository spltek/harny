import { describe, it, expect } from "vitest";
import { McpStdioClient, formatMcpContent } from "./mcp-client";

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
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "test", version: "1" } } }) + "\\n");
    } else if (m.method === "tools/list") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "echo", description: "Echo text", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }] } }) + "\\n");
    } else if (m.method === "tools/call") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "echo:" + (m.params.arguments && m.params.arguments.text) }] } }) + "\\n");
    }
  }
});
`;

function client(): McpStdioClient {
  return new McpStdioClient({ command: process.execPath, args: ["-e", SERVER] });
}

describe("formatMcpContent", () => {
  it("flattens text/image/resource blocks", () => {
    expect(formatMcpContent([{ type: "text", text: "a" }, { type: "text", text: "b" }])).toBe("a\nb");
    expect(formatMcpContent([{ type: "image", mimeType: "image/png" }])).toContain("image/png");
    expect(formatMcpContent([{ type: "resource", resource: { uri: "file://x" } }])).toContain("file://x");
    expect(formatMcpContent(undefined)).toBe("(no output)");
  });
});

describe("McpStdioClient (real stdio)", () => {
  it("initializes, lists tools and calls one", async () => {
    const c = client();
    await c.start();
    const tools = await c.listTools();
    expect(tools.map((t) => t.name)).toEqual(["echo"]);
    expect(tools[0].description).toBe("Echo text");
    expect(tools[0].inputSchema).toEqual({ type: "object", properties: { text: { type: "string" } }, required: ["text"] });

    const res = await c.callTool("echo", { text: "hi" });
    expect(res.isError).toBe(false);
    expect(res.text).toBe("echo:hi");
    c.close();
  });

  it("rejects when the server cannot start", async () => {
    const c = new McpStdioClient({ command: process.execPath, args: ["-e", "process.exit(0)"], timeoutMs: 2000 });
    await expect(c.start()).rejects.toThrow();
    c.close();
  });

  it("times out a request the server never answers", async () => {
    const c = new McpStdioClient({ command: process.execPath, args: ["-e", "process.stdin.resume()"], timeoutMs: 300 });
    await expect(c.start()).rejects.toThrow(/timed out/);
    c.close();
  });
});
