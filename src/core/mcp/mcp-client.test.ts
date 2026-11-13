import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
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
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "echo", description: "Echo text", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] }, annotations: { readOnlyHint: true } }] } }) + "\\n");
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
    expect(
      formatMcpContent([
        { type: "text", text: "a" },
        { type: "text", text: "b" },
      ]),
    ).toBe("a\nb");
    expect(formatMcpContent([{ type: "image", mimeType: "image/png" }])).toContain("image/png");
    expect(formatMcpContent([{ type: "resource", resource: { uri: "file://x" } }])).toContain("file://x");
    expect(formatMcpContent(undefined)).toBe("(no output)");
  });
});

describe("examples/mcp-hello — the shipped no-install server", () => {
  // This is the server a user is told to try when npm/npx is broken on their machine
  // (see the file's own header). Running it HERE is what keeps that promise honest: the
  // example cannot rot without a test going red.
  const script = fileURLToPath(new URL("../../../examples/mcp-hello/server.js", import.meta.url));

  it("answers initialize, lists its tools and runs one", async () => {
    const c = new McpStdioClient({ command: process.execPath, args: [script] });
    await c.start();
    const tools = await c.listTools();
    expect(tools.map((t) => t.name)).toEqual(["hello", "add", "now", "search"]);
    // Every tool declares readOnlyHint, so marking the server `analyze: "read-only"`
    // lets the MODEL run them in Analyze (the gate believes a declared server).
    expect(tools.every((t) => t.annotations?.readOnlyHint === true)).toBe(true);
    expect(await c.callTool("add", { a: 2, b: 3 })).toEqual({ text: "2 + 3 = 5", isError: false });
    expect((await c.callTool("hello", { name: "Silvio" })).text).toContain("Hello, Silvio!");
    // A bad argument is an ERROR RESULT, not a crash: the model must be able to read it.
    expect(await c.callTool("add", { a: "x", b: 1 })).toMatchObject({ isError: true });
    c.close();
  });

  it("carries a RICH parameter schema intact (enum, array, nested object, bounds, required)", async () => {
    // This is the whole point of the `search` tool: a remote server's simple string
    // parameters never exercise the schema path, so the example keeps one that does — and
    // this test fails if any of it is flattened on the way in.
    const c = new McpStdioClient({ command: process.execPath, args: [script] });
    await c.start();
    const search = (await c.listTools()).find((t) => t.name === "search")!;
    const schema = search.inputSchema as Record<string, any>;
    expect(schema.required).toEqual(["query"]);
    expect(schema.properties.sort.enum).toEqual(["relevance", "newest", "cheapest"]);
    expect(schema.properties.tags.items.type).toBe("string");
    expect(schema.properties.filter.properties.price.properties.max.type).toBe("number");
    expect(schema.properties.limit).toMatchObject({ type: "integer", minimum: 1, maximum: 50, default: 5 });

    // A full argument set: defaults applied, out-of-range clamped, unknown enum replaced —
    // the tool echoes what it RECEIVED, so this also documents how the arguments arrive.
    const res = await c.callTool("search", {
      query: "widget",
      limit: 999,
      sort: "nope",
      tags: ["a", 7, "b"],
      filter: { inStock: true, price: { max: 10 } },
      dryRun: true,
    });
    expect(res.isError).toBe(false);
    expect(JSON.parse(res.text.replace("Normalized request:\n", ""))).toEqual({
      query: "widget",
      limit: 50,
      sort: "relevance",
      tags: ["a", "b"],
      filter: { inStock: true, price: { max: 10 } },
      dryRun: true,
    });
    // A missing required argument is an error RESULT, not a protocol failure.
    expect(await c.callTool("search", {})).toMatchObject({ isError: true });
    c.close();
  });
});

describe("McpStdioClient (real stdio)", () => {
  it("initializes, lists tools and calls one", async () => {
    const c = client();
    await c.start();
    const tools = await c.listTools();
    expect(tools.map((t) => t.name)).toEqual(["echo"]);
    expect(tools[0].description).toBe("Echo text");
    expect(tools[0].inputSchema).toEqual({
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    });
    // The server's behavior hints must SURVIVE ingestion: they are what a trusted server
    // is believed on (and what the user is shown when deciding).
    expect(tools[0].annotations).toEqual({ readOnlyHint: true });

    const res = await c.callTool("echo", { text: "hi" });
    expect(res.isError).toBe(false);
    expect(res.text).toBe("echo:hi");
    c.close();
  });

  it("an exiting server's message keeps the CAUSE (head push) and the remedy, not just the tail", async () => {
    // The shape npm produces when its npx cache is half-written: the cause in the FIRST
    // lines, then a wall of noise. The message used to be stderr.slice(-300), which showed
    // only "y not empty, rename …" — the tail of "directory not empty" — and hid the line
    // that names the problem.
    const noisy = `
const lines = [
  "npm error code ENOTEMPTY",
  "npm error syscall rename",
  "npm error path /Users/x/.npm/_npx/abc/node_modules/content-disposition",
  ...Array.from({ length: 40 }, (_, i) => "npm error noise " + i + " ".repeat(60)),
  "npm error A complete log of this run can be found in: /Users/x/.npm/_logs/debug-0.log",
];
for (const l of lines) console.error(l);
process.exit(190);
`;
    const c = new McpStdioClient({ command: process.execPath, args: ["-e", noisy], timeoutMs: 5000 });
    const err = await c.start().catch((e) => e as Error);
    // The FIRST line survives: it is the only one that names the problem.
    expect(err.message).toContain("ENOTEMPTY");
    expect(err.message).toContain("code=190");
    expect(err.message).not.toContain(": y not empty"); // never a mid-word slice
    // …the end is still there (where it gave up), and the message stays SHORT.
    expect(err.message).toContain("debug-0.log");
    expect(err.message.length).toBeLessThan(800);
    // …and it says what to DO about it, because "code=190" alone helps nobody.
    expect(err.message).toContain("rm -rf ~/.npm/_npx");
    c.close();
  });

  it("names the OTHER two failures we can diagnose, and stays quiet when it cannot", async () => {
    // A wrong hint is worse than none — so each cell of the table is worth a test: the user sees
    // this line and acts on it.
    const runWith = async (lines: string[]): Promise<string> => {
      const script = `
for (const l of ${JSON.stringify(lines)}) console.error(l);
process.exit(1);
`;
      const c = new McpStdioClient({ command: process.execPath, args: ["-e", script], timeoutMs: 5000 });
      const err = await c.start().catch((e) => e as Error);
      c.close();
      return err.message;
    };

    expect(await runWith(["Error: EACCES: permission denied, spawn /usr/local/bin/tool"])).toContain(
      "check its path and permissions",
    );
    expect(await runWith(["Error: spawn npx ENOENT"])).toContain("not found on PATH");
    // A failure we cannot name gets NO invented advice.
    const unknown = await runWith(["Segmentation fault"]);
    expect(unknown).toContain("Segmentation fault");
    expect(unknown).not.toContain("PATH");
    expect(unknown).not.toContain("permissions");
  });

  it("a clean exit keeps the message clean (no empty detail, no stray hint)", async () => {
    const c = new McpStdioClient({ command: process.execPath, args: ["-e", "process.exit(0)"], timeoutMs: 2000 });
    const err = await c.start().catch((e) => e as Error);
    expect(err.message).toBe("MCP server exited (code=0 signal=-)");
    c.close();
  });

  it("reports a crash through onExit, but NOT a close() we asked for", async () => {
    // (1) The server dies on its own → reported. This is what lets the manager mark it down.
    const crashed = new McpStdioClient({ command: process.execPath, args: ["-e", "process.exit(3)"], timeoutMs: 3000 });
    const message = await new Promise<string | undefined>((resolve) => {
      crashed.onExit((m) => resolve(m));
      crashed.start().catch(() => {});
      setTimeout(() => resolve(undefined), 2500);
    });
    expect(message).toContain("code=3");
    crashed.close();

    // (2) WE close it (a reconnect kills the child on purpose) → silence, or the fresh
    // connection would be marked dead by the exit of the one it replaced.
    const closed = new McpStdioClient({ command: process.execPath, args: ["-e", SERVER] });
    let reported: string | undefined;
    closed.onExit((m) => (reported = m));
    await closed.start();
    closed.close();
    await new Promise((r) => setTimeout(r, 250));
    expect(reported).toBeUndefined();
  });

  it("Stop cancels an IN-FLIGHT call instead of waiting for its timeout", async () => {
    // Before this, a tools/call sat until timeoutMs even after the user pressed Stop: the answer
    // arrived when the run was already over. The server is told (notifications/cancelled) and the
    // pending entry is dropped, so the late reply is ignored — and the transport stays usable.
    const SLOW = `
let buf = "";
process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    if (m.method === "initialize") process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "slow", version: "1" } } }) + "\\n");
    else if (m.method === "tools/list") process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "slow" }] } }) + "\\n");
    else if (m.method === "tools/call") { const id = m.id; setTimeout(() => { try { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "too late" }] } }) + "\\n"); } catch {} }, 3000); }
  }
});
`;
    const c = new McpStdioClient({ command: process.execPath, args: ["-e", SLOW], timeoutMs: 10_000 });
    await c.start();
    const ac = new AbortController();
    const call = c.callTool("slow", {}, ac.signal);
    setTimeout(() => ac.abort(), 50);
    // No wall-clock bound: the server never answers `tools/call`, so without the abort this
    // promise would settle with the 10 s `timeoutMs` error instead of "cancelled by Stop".
    // The message alone proves the abort won the race; a millisecond bound only proves the CI
    // machine was idle.
    await expect(call).rejects.toThrow("cancelled by Stop");
    // The transport survived: the same client still answers.
    expect((await c.listTools()).map((t) => t.name)).toEqual(["slow"]);
    c.close();
  });

  it("an already-aborted signal never sends the request at all", async () => {
    const c = new McpStdioClient({ command: process.execPath, args: ["-e", SERVER], timeoutMs: 3000 });
    await c.start();
    const ac = new AbortController();
    ac.abort();
    await expect(c.callTool("echo", {}, ac.signal)).rejects.toThrow("cancelled by Stop");
    // …and the client is fine.
    expect((await c.callTool("echo", {})).text).toContain("echo");
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
