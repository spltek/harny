import type { McpClient, McpToolInfo, ServerAnalyzePolicy } from "./types";
import type { AnalyzePolicy, Tool, ToolDefinition, ToolResult } from "../tools/tool";

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
    /** THE USER's declaration for this server (see ServerAnalyzePolicy). Read on every
     * access, so a settings change applies to the next turn without reconnecting. */
    private readonly declaredPolicy: () => ServerAnalyzePolicy | undefined = () => undefined,
  ) {
    this.name = mcpToolName(server, info.name);
  }

  /**
   * Analyze: an external call cannot be PREVIEWED (there is no diff to validate), so the
   * only two options are run or refuse — and Harny refuses everything that does not
   * PROVE it cannot modify resources:
   *
   *   · the user declared the server `read-only` → runs (their statement);
   *   · the user declared it `trusted` AND the tool sends `readOnlyHint: true` → runs
   *     (the spec: annotations are untrusted "unless they come from trusted servers");
   *   · anything else — including a tool that sends NO annotations, whose protocol
   *     defaults are `readOnlyHint: false` / `destructiveHint: true` — is refused.
   *
   * This is the difference between "an unknown tool is assumed harmless" (how an MCP
   * `drop_table` used to run in Analyze) and the promise Analyze actually makes.
   */
  get analyzePolicy(): AnalyzePolicy {
    const declared = this.declaredPolicy();
    if (declared === "read-only") return "read-only";
    if (declared === "trusted" && this.info.annotations?.readOnlyHint === true) return "read-only";
    return "refuse";
  }

  /** Named and actionable: the model must know WHICH server is blocking and what the two
   * ways out are (Build, or a per-server statement in the settings). */
  get analyzeRefusal(): string {
    const declared = this.declaredPolicy();
    const base = `"${this.name}" (MCP server "${this.server}") does not run in Analyze: it may modify ` +
      `resources, and an external call cannot be previewed the way a file write can.`;
    if (declared === "trusted") {
      return (
        `${base} The server is marked trusted, but this tool does not declare readOnlyHint: true ` +
        `(no hint, or destructiveHint, means "assume it modifies"). Switch to Build to run it.`
      );
    }
    return (
      `${base} Server "${this.server}" is not declared read-only: in the MCP settings you can mark it ` +
      `read-only (every tool of it) or trusted (believe its own readOnlyHint), or switch to Build to run this call.`
    );
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
