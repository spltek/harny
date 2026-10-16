import { describe, it, expect } from "vitest";
import { McpTool, mcpToolName } from "./mcp-tool";
import type { McpStdioClient } from "./mcp-client";
import type { McpToolInfo, ServerAnalyzePolicy } from "./types";

describe("McpTool — the Analyze policy (the trust rule)", () => {
  const noop = () => stubClient(async () => ({ text: "", isError: false }));
  const tool = (info: McpToolInfo, declared?: () => ServerAnalyzePolicy | undefined) =>
    new McpTool("db", info, noop(), declared);

  it("REFUSES a tool nobody declared — including one whose server sends NOTHING", () => {
    // The protocol's own defaults (readOnlyHint: false, destructiveHint: true) mean
    // "assume it modifies": silence is not innocence.
    expect(tool({ name: "drop_table" }).analyzePolicy).toBe("refuse");
    expect(tool({ name: "read_query" }).analyzePolicy).toBe("refuse");
  });

  it("does NOT believe the server's own readOnlyHint until YOU mark it trusted", () => {
    // The spec: annotations are untrusted "unless they come from trusted servers".
    const declared = { name: "read_query", annotations: { readOnlyHint: true } };
    expect(tool(declared).analyzePolicy).toBe("refuse");
    expect(tool(declared, () => "trusted").analyzePolicy).toBe("read-only");
  });

  it("a trusted server is still refused for a tool that declares nothing (or destructive)", () => {
    expect(tool({ name: "write_query" }, () => "trusted").analyzePolicy).toBe("refuse");
    expect(tool({ name: "drop_table", annotations: { destructiveHint: true } }, () => "trusted").analyzePolicy).toBe(
      "refuse",
    );
  });

  it("YOUR blanket 'read-only' allows even a server that declares nothing (old servers)", () => {
    expect(tool({ name: "anything" }, () => "read-only").analyzePolicy).toBe("read-only");
  });

  it("reads the declaration LIVE, so a settings change lands on the next turn", () => {
    let declared: "trusted" | undefined;
    const t = tool({ name: "read_query", annotations: { readOnlyHint: true } }, () => declared);
    expect(t.analyzePolicy).toBe("refuse");
    declared = "trusted";
    expect(t.analyzePolicy).toBe("read-only");
  });

  it("a refusal names the server and the two ways out", () => {
    const undeclared = tool({ name: "write_query" }).analyzeRefusal;
    expect(undeclared).toContain("db");
    expect(undeclared).toContain("read-only");
    expect(undeclared).toContain("Build");
    // A trusted server that did not declare read-only is told the DETAIL (not just "no").
    const trusted = tool({ name: "write_query" }, () => "trusted").analyzeRefusal;
    expect(trusted).toContain("readOnlyHint");
  });
});

function stubClient(callTool: (name: string, args: Record<string, unknown>) => Promise<{ text: string; isError: boolean }>): McpStdioClient {
  return { callTool } as unknown as McpStdioClient;
}

describe("mcpToolName", () => {
  it("namespaces as mcp__server__tool and sanitises separators", () => {
    expect(mcpToolName("github", "create_issue")).toBe("mcp__github__create_issue");
    expect(mcpToolName("my.server", "do-it")).toBe("mcp__my_server__do_it");
  });
});

describe("McpTool", () => {
  it("exposes the server's input schema as the tool parameters", () => {
    const tool = new McpTool(
      "test",
      { name: "echo", description: "Echo", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
      stubClient(async () => ({ text: "", isError: false })),
    );
    expect(tool.name).toBe("mcp__test__echo");
    expect(tool.definition.name).toBe("mcp__test__echo");
    expect(tool.definition.description).toContain("[MCP:test]");
    expect(tool.definition.description).toContain("Echo");
    expect(tool.definition.parameters.properties).toEqual({ text: { type: "string" } });
    expect(tool.definition.parameters.required).toEqual(["text"]);
  });

  it("forwards the call (using the REAL tool name) and returns the text", async () => {
    let seen: { name: string; args: Record<string, unknown> } | undefined;
    const tool = new McpTool(
      "test",
      { name: "do-it" },
      stubClient(async (name, args) => {
        seen = { name, args };
        return { text: "result!", isError: false };
      }),
    );
    const r = await tool.execute({ a: 1 });
    expect(r.isError).toBe(false);
    expect(r.content).toBe("result!");
    expect(seen).toEqual({ name: "do-it", args: { a: 1 } });
  });

  it("turns a client failure into an error result", async () => {
    const tool = new McpTool("test", { name: "x" }, stubClient(async () => Promise.reject(new Error("boom"))));
    const r = await tool.execute({});
    expect(r.isError).toBe(true);
    expect(r.content).toContain("boom");
  });

  it("works with no inputSchema (empty object parameters)", () => {
    const tool = new McpTool("test", { name: "x" }, stubClient(async () => ({ text: "", isError: false })));
    expect(tool.definition.parameters).toEqual({ type: "object", properties: {} });
  });
});
