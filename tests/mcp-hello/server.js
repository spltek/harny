#!/usr/bin/env node
/**
 * A minimal MCP server you can run with PLAIN NODE — no npm, no npx, no install.
 *
 * It exists to answer one question: "does Harny's MCP support work, or is npm's npx
 * cache the problem?". If this server connects, the panel, the tool list and the
 * Analyze gate are all fine and the fault was in the install path.
 *
 * Protocol: newline-delimited JSON-RPC 2.0 on stdio (the MCP `stdio` transport).
 * It implements exactly what Harny needs — `initialize`, `tools/list`, `tools/call`.
 * It is exercised by `src/core/mcp/mcp-client.test.ts`, so the example cannot rot.
 *
 * Use it as a Harny server (MCP card → gear → + New):
 *   Name      hello
 *   Command   node
 *   Args      <repo>/examples/mcp-hello/server.js
 *
 * Tools: `hello` (greets), `add` (sums two numbers), `now` (current time) and `search`
 * (a deliberately RICH schema: enum, array, nested object, numeric bounds — it echoes
 * the normalized arguments so you can see what the model sent). All declare
 * `readOnlyHint: true`, so they run in Analyze once you mark the server
 * `"analyze": "read-only"` in config.json — or immediately in Build.
 */

const TOOLS = [
  {
    name: "hello",
    description: "Greets a name. A read-only example with no side effects.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", description: "Who to greet" } },
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  {
    name: "add",
    description: "Adds two numbers and returns the sum.",
    inputSchema: {
      type: "object",
      properties: { a: { type: "number" }, b: { type: "number" } },
      required: ["a", "b"],
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  {
    name: "now",
    description: "Returns the current date and time, ISO 8601.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: "search",
    description:
      "Searches the example catalogue. This one exists to SHOW a rich parameter schema: required + optional, " +
      "an enum, an array, a nested object and numeric bounds. It returns the arguments it received, normalized, " +
      "so you can see what the model actually sent.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to look for (required)" },
        limit: { type: "integer", description: "Max results, 1-50 (default 5)", minimum: 1, maximum: 50, default: 5 },
        sort: {
          type: "string",
          description: "Sort order (default relevance)",
          enum: ["relevance", "newest", "cheapest"],
          default: "relevance",
        },
        tags: { type: "array", items: { type: "string" }, description: "Every tag must match" },
        filter: {
          type: "object",
          description: "Nested filter",
          properties: {
            inStock: { type: "boolean" },
            price: {
              type: "object",
              properties: { min: { type: "number" }, max: { type: "number" } },
            },
          },
        },
        dryRun: { type: "boolean", description: "Return the normalized request instead of results" },
      },
      required: ["query"],
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
];

/** One tool call. Errors are reported as `isError`, never thrown: the model reads them. */
function callTool(name, args) {
  switch (name) {
    case "hello": {
      const who = typeof args?.name === "string" && args.name.trim() ? args.name.trim() : "world";
      return {
        content: [{ type: "text", text: `Hello, ${who}! This came from a plain Node process — no npx involved.` }],
      };
    }
    case "add": {
      const a = Number(args?.a);
      const b = Number(args?.b);
      if (!Number.isFinite(a) || !Number.isFinite(b)) {
        return { content: [{ type: "text", text: "`a` and `b` must be numbers." }], isError: true };
      }
      return { content: [{ type: "text", text: `${a} + ${b} = ${a + b}` }] };
    }
    case "now":
      return { content: [{ type: "text", text: new Date().toISOString() }] };
    case "search": {
      // A RICH tool: it normalizes what it received (defaults, clamps, enum validation)
      // and echoes it, so the caller can see exactly how the arguments arrived.
      const query = typeof args?.query === "string" ? args.query.trim() : "";
      if (!query) {
        return { content: [{ type: "text", text: "`query` is required." }], isError: true };
      }
      const sort = ["relevance", "newest", "cheapest"].includes(args?.sort) ? args.sort : "relevance";
      const rawLimit = Number(args?.limit);
      const limit = Number.isFinite(rawLimit) ? Math.min(50, Math.max(1, Math.trunc(rawLimit))) : 5;
      const tags = Array.isArray(args?.tags) ? args.tags.filter((t) => typeof t === "string") : [];
      const parsed = {
        query,
        limit,
        sort,
        tags,
        filter: args?.filter && typeof args.filter === "object" ? args.filter : null,
        dryRun: args?.dryRun === true,
      };
      const shown = JSON.stringify(parsed, null, 2);
      return {
        content: [
          {
            type: "text",
            text: parsed.dryRun
              ? `Normalized request:\n${shown}`
              : `${limit} result(s) for "${query}" (sort: ${sort}${tags.length ? `, tags: ${tags.join("+")}` : ""}):\n${shown}`,
          },
        ],
      };
    }
    default:
      return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
  }
}

function handle(message) {
  const { id, method, params } = message ?? {};
  // Notifications (no id) get no answer.
  if (id === undefined || id === null) return null;
  switch (method) {
    case "initialize":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "harny-hello", version: "1.0.0" },
        },
      };
    case "tools/list":
      return { jsonrpc: "2.0", id, result: { tools: TOOLS } };
    case "tools/call":
      return { jsonrpc: "2.0", id, result: callTool(params?.name, params?.arguments) };
    case "ping":
      return { jsonrpc: "2.0", id, result: {} };
    default:
      return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } };
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    let reply;
    try {
      reply = handle(JSON.parse(line));
    } catch {
      reply = { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } };
    }
    if (reply) process.stdout.write(JSON.stringify(reply) + "\n");
  }
});
// The client closed the pipe: nothing left to serve.
process.stdin.on("end", () => process.exit(0));
