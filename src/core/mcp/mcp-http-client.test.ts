import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { describe, it, expect, afterEach } from "vitest";
import { McpHttpClient } from "./mcp-http-client";

type Handler = (msg: any, req: IncomingMessage, res: ServerResponse) => void;

async function serve(handler: Handler): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      let msg: any;
      try {
        msg = JSON.parse(body);
      } catch {
        msg = {};
      }
      handler(msg, req, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${addr.port}/mcp`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

function json(res: ServerResponse, id: number, result: unknown): void {
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id, result }));
}

describe("McpHttpClient (streamable HTTP)", () => {
  const closers: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const c of closers.splice(0)) await c();
  });

  it("initializes, lists and calls over JSON (stateless)", async () => {
    const s = await serve((m, _req, res) => {
      if (m.method === "initialize") json(res, m.id, { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "h", version: "1" } });
      else if (m.method === "tools/list") json(res, m.id, { tools: [{ name: "echo", description: "Echo", inputSchema: { type: "object", properties: {} } }] });
      else if (m.method === "tools/call") json(res, m.id, { content: [{ type: "text", text: "ok:" + m.params.arguments.x }] });
      else res.writeHead(202).end();
    });
    closers.push(s.close);

    const c = new McpHttpClient({ url: s.url });
    await c.start();
    expect((await c.listTools()).map((t) => t.name)).toEqual(["echo"]);
    expect((await c.callTool("echo", { x: 1 })).text).toBe("ok:1");
    c.close();
  });

  it("reads a text/event-stream (SSE) response", async () => {
    const s = await serve((m, _req, res) => {
      if (m.method === "initialize") json(res, m.id, { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "h", version: "1" } });
      else if (m.method === "tools/list") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "sse" }] } })}\n\n`);
        res.end();
      } else res.writeHead(202).end();
    });
    closers.push(s.close);

    const c = new McpHttpClient({ url: s.url });
    await c.start();
    expect((await c.listTools()).map((t) => t.name)).toEqual(["sse"]);
    c.close();
  });

  it("echoes the Mcp-Session-Id on later requests (stateful)", async () => {
    const seen: (string | undefined)[] = [];
    const s = await serve((m, req, res) => {
      seen.push(req.headers["mcp-session-id"] as string | undefined);
      if (m.method === "initialize") {
        res
          .writeHead(200, { "content-type": "application/json", "mcp-session-id": "abc123" })
          .end(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: {} }));
      } else if (m.method === "tools/list") json(res, m.id, { tools: [] });
      else res.writeHead(202).end();
    });
    closers.push(s.close);

    const c = new McpHttpClient({ url: s.url });
    await c.start();
    await c.listTools();
    c.close();
    expect(seen[0]).toBeUndefined(); // initialize: no session yet
    expect(seen[1]).toBe("abc123"); // tools/list: session echoed
  });

  it("throws on an HTTP error status", async () => {
    const s = await serve((_m, _req, res) => res.writeHead(500).end("boom"));
    closers.push(s.close);
    const c = new McpHttpClient({ url: s.url, timeoutMs: 3000 });
    await expect(c.start()).rejects.toThrow(/HTTP 500/);
    c.close();
  });

  it("throws on a JSON-RPC error", async () => {
    const s = await serve((m, _req, res) => {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: m.id, error: { code: -1, message: "nope" } }));
    });
    closers.push(s.close);
    const c = new McpHttpClient({ url: s.url });
    await expect(c.start()).rejects.toThrow(/nope/);
    c.close();
  });

  it("logs the critical points (request, status, session, errors)", async () => {
    const logs: string[] = [];
    const s = await serve((m, _req, res) => {
      if (m.method === "initialize") json(res, m.id, {});
      else res.writeHead(202).end();
    });
    closers.push(s.close);

    const c = new McpHttpClient({ url: s.url, log: (l) => logs.push(l) });
    await c.start();
    c.close();
    expect(logs.some((l) => l.includes("[mcp-http]") && l.includes("POST initialize"))).toBe(true);
    expect(logs.some((l) => l.includes("stateless"))).toBe(true);
  });
});
