import type { McpClient, McpToolInfo } from "./types";
import type { Tool, ToolDefinition, ToolResult } from "../tools/tool";

/** Harny tool-name for an MCP tool (Claude-compatible namespacing). */
export function mcpToolName(server: string, tool: string): string {
  const clean = (s: string) => s.replace(/[^A-Za-z0-9_]/g, "_");
  return `mcp__${clean(server)}__${clean(tool)}`;
}

/**
 * Wraps ONE MCP tool as a Harny `Tool`: the model sees it in the normal tool
 * list and calls it like any other tool; the call is forwarded to the MCP
 * server. The REAL (unsanitised) tool name is kept for the wire call.
 */
export class McpTool implements Tool {
  readonly name: string;

  constructor(
    private readonly server: string,
    private readonly info: McpToolInfo,
    private readonly client: McpClient,
  ) {
    this.name = mcpToolName(server, info.name);
  }

  get definition(): ToolDefinition {
    const schema =
      this.info.inputSchema && typeof this.info.inputSchema === "object"
        ? (this.info.inputSchema as Record<string, unknown>)
        : undefined;
    const properties =
      schema && schema.properties && typeof schema.properties === "object"
        ? (schema.properties as Record<string, unknown>)
        : {};
    const required = schema && Array.isArray(schema.required) ? (schema.required as string[]) : undefined;
    return {
      name: this.name,
      description: `[MCP:${this.server}] ${this.info.description ?? this.info.name}`,
      parameters: { type: "object", properties, ...(required ? { required } : {}) },
    };
  }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    try {
      const { text, isError } = await this.client.callTool(this.info.name, args ?? {});
      return { content: text, isError };
    } catch (e) {
      return {
        content: `MCP tool "${this.name}" failed: ${e instanceof Error ? e.message : String(e)}`,
        isError: true,
      };
    }
  }
}
