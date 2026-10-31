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

  it("knows nothing about per-TOOL declarations: those belong to the SESSION", () => {
    // This object is shared by every conversation (one registry, one instance), so it can answer
    // only for the INSTALL — the server's declaration plus its own hints. Naming ONE tool is the
    // session's statement (`ToolScope.analyze`), applied by `Agent.analyzePolicyFor` where the
    // session is known: see agent.test.ts ("runs it in Analyze when THIS SESSION declares …") and
    // tool-scope.test.ts. Handing it the file's `analyzeTools` here is what made one conversation's
    // click speak for every tab, so that parameter is gone.
    const hinted = tool({ name: "read_query", annotations: { readOnlyHint: true } }, () => "trusted");
    expect(hinted.analyzePolicy).toBe("read-only"); // the server + its hint, and nothing else
    expect(tool({ name: "read_query" }, () => undefined).analyzePolicy).toBe("refuse");
  });

  it("reads the declaration LIVE, so a settings change lands on the next turn", () => {
    let declared: "trusted" | undefined;
    const t = tool({ name: "read_query", annotations: { readOnlyHint: true } }, () => declared);
    expect(t.analyzePolicy).toBe("refuse");
    declared = "trusted";
    expect(t.analyzePolicy).toBe("read-only");
  });

  it("a refusal names the server and the ways out, including the per-tool one", () => {
    const undeclared = tool({ name: "write_query" }).analyzeRefusal;
    expect(undeclared).toContain("db");
    expect(undeclared).toContain("read-only");
    expect(undeclared).toContain("Build");
    // The narrowest escape exists, so the message must name it: otherwise the model (and the
    // user reading the refusal) is told there are fewer options than there really are.
    expect(undeclared).toContain("Analyze switch in the tools panel");
    // …and that the escape is the SESSION's, so nobody goes looking for it in `config.json`.
    expect(undeclared).toContain("THIS conversation only");
    // A trusted server that did not declare read-only is told the DETAIL (not just "no").
    const trusted = tool({ name: "write_query" }, () => "trusted").analyzeRefusal;
    expect(trusted).toContain("readOnlyHint");
    expect(trusted).toContain("Analyze switch in the tools panel");
  });
});

function stubClient(
  callTool: (
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<{ text: string; isError: boolean }>,
): McpStdioClient {
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
      {
        name: "echo",
        description: "Echo",
        inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      },
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
    const tool = new McpTool(
      "test",
      { name: "x" },
      stubClient(async () => Promise.reject(new Error("boom"))),
    );
    const r = await tool.execute({});
    expect(r.isError).toBe(true);
    expect(r.content).toContain("boom");
  });

  it("cuts a result longer than the MODEL's budget, with a note saying what to do", async () => {
    // The newest result is the one the model is waiting for, and masking only touches OLD ones:
    // the cap belongs here, at the boundary, not inside each server.
    const huge = "x".repeat(60_000);
    const tool = new McpTool(
      "test",
      { name: "big" },
      stubClient(async () => ({ text: huge, isError: false })),
    );
    const r = await tool.execute({}, { contextBudget: 8000 });
    // 8000 tokens × 10% × 4 chars = 3200, far under the MCP ceiling.
    expect(r.content.length).toBeLessThan(4_000);
    expect(r.content).toContain("Output truncated at");
    expect(r.isError).toBe(false);
  });

  it("without a budget the MCP ceiling still applies (a 50KB server answer)", async () => {
    const tool = new McpTool(
      "test",
      { name: "big" },
      stubClient(async () => ({ text: "y".repeat(60_000), isError: false })),
    );
    const r = await tool.execute({});
    expect(r.content).toContain("Output truncated at 50KB");
    expect(r.content.length).toBeLessThan(51_000);
  });

  it("passes a short result through untouched (no note, no slicing)", async () => {
    const tool = new McpTool(
      "test",
      { name: "small" },
      stubClient(async () => ({ text: "ok", isError: false })),
    );
    expect(await tool.execute({}, { contextBudget: 8000 })).toEqual({ content: "ok", isError: false });
  });

  it("hands the run's abort signal to the transport (Stop is not a timeout)", async () => {
    let seen: AbortSignal | undefined;
    const tool = new McpTool(
      "test",
      { name: "slow" },
      stubClient(async (_name, _args, signal) => {
        seen = signal;
        return { text: "", isError: false };
      }),
    );
    const ac = new AbortController();
    await tool.execute({}, { signal: ac.signal });
    expect(seen).toBe(ac.signal);
  });

  it("works with no inputSchema (empty object parameters)", () => {
    const tool = new McpTool(
      "test",
      { name: "x" },
      stubClient(async () => ({ text: "", isError: false })),
    );
    expect(tool.definition.parameters).toEqual({ type: "object", properties: {} });
  });

  it("passes a RICH schema THROUGH instead of rebuilding it", () => {
    // The server's inputSchema IS the contract: rebuilding it from {type, properties,
    // required} dropped oneOf, additionalProperties, $defs/$ref and defaults — a schema
    // using a $ref arrived pointing at nothing, and the model lost every constraint.
    const rich = {
      type: "object",
      properties: { user: { $ref: "#/$defs/User" }, mode: { enum: ["a", "b"], default: "a" } },
      required: ["user"],
      additionalProperties: false,
      oneOf: [{ required: ["user"] }, { required: ["mode"] }],
      $defs: { User: { type: "object", properties: { name: { type: "string" } } } },
    };
    const tool = new McpTool(
      "test",
      { name: "complex", inputSchema: rich },
      stubClient(async () => ({ text: "", isError: false })),
    );
    expect(tool.definition.parameters).toEqual(rich);
  });

  it("still yields an object schema when the server sends type/properties badly", () => {
    const at = (inputSchema: unknown) =>
      new McpTool(
        "test",
        { name: "x", ...(inputSchema === undefined ? {} : { inputSchema }) },
        stubClient(async () => ({ text: "", isError: false })),
      ).definition.parameters;
    expect(at([1, 2])).toEqual({ type: "object", properties: {} });
    // A server that sends `properties` but forgets `type` gets one from us.
    expect(at({ properties: { q: { type: "string" } } })).toEqual({
      type: "object",
      properties: { q: { type: "string" } },
    });
  });
});
