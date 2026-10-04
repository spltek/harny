import { describe, it, expect } from "vitest";
import { McpTool, mcpToolName } from "./mcp-tool";
import type { McpStdioClient } from "./mcp-client";

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
