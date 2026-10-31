import { mcpPrefix, sanitizeToolNamePart } from "../tools/tool-scope";
import type { McpClient, McpToolInfo, ServerAnalyzePolicy } from "./types";
import type { AnalyzePolicy, Tool, ToolContext, ToolDefinition, ToolResult } from "../tools/tool";
import { toolOutputCapChars, truncationNote } from "../tools/output-budget";

/** Harny tool-name for an MCP tool (Claude-compatible namespacing). */
/**
 * The MCP result's own ceiling, before the model-aware cap: the same order of magnitude as
 * Shell's, because an MCP server can return a whole table in one answer. The real limit is
 * `toolOutputCapChars`, which scales it to the session's usable window — a fixed ceiling is
 * wrong for a small local model (50KB is its ENTIRE context) and pointless for a big one.
 */
const MCP_OUTPUT_CAP_CHARS = 50_000;

export function mcpToolName(server: string, tool: string): string {
  // The prefix rule lives in `tool-scope`, next to the match that has to agree with it — one
  // definition, so a scope can never hold a spelling the registry does not use.
  return mcpPrefix(server) + sanitizeToolNamePart(tool);
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
    // The INSTALL's answer, and only that. A per-TOOL declaration is the SESSION's
    // (ToolScope.analyze): this object is shared by every conversation, so reading it here would
    // let one tab's click decide for the next — the bug that moved the declaration into the scope.
    // `Agent.analyzePolicyFor` overlays it where the session is known.
    const declared = this.declaredPolicy();
    if (declared === "read-only") return "read-only";
    if (declared === "trusted" && this.info.annotations?.readOnlyHint === true) return "read-only";
    return "refuse";
  }

  /** Named and actionable: the model must know WHICH server is blocking and what the two
   * ways out are (Build, or a per-server statement in the settings). */
  get analyzeRefusal(): string {
    const declared = this.declaredPolicy();
    const base =
      `"${this.name}" (MCP server "${this.server}") does not run in Analyze: it may modify ` +
      `resources, and an external call cannot be previewed the way a file write can.`;
    if (declared === "trusted") {
      return (
        `${base} The server is marked trusted, but this tool does not declare readOnlyHint: true ` +
        `(no hint, or destructiveHint, means "assume it modifies"). Mark this tool read-only with the ` +
        `Analyze switch in the tools panel, or switch to Build to run it.`
      );
    }
    return (
      `${base} Server "${this.server}" is not declared read-only: in the MCP settings you can mark it ` +
      `read-only (every tool of it) or trusted (believe its own readOnlyHint), or mark THIS tool ` +
      `read-only with the Analyze switch in the tools panel — the narrowest statement, the one that ` +
      `does not vouch for the rest of the server, and the one that lasts for THIS conversation only. ` +
      `Switch to Build to run this call now.`
    );
  }

  get definition(): ToolDefinition {
    // The server's `inputSchema` IS the contract — the MCP spec has clients pass it through.
    // Rebuilding it from `{type, properties, required}` dropped `additionalProperties`,
    // `oneOf`/`anyOf`, `$defs`/`$ref` and defaults, so a schema using a `$ref` came out
    // pointing at nothing (and the model lost every constraint but the property list).
    const schema = isSchema(this.info.inputSchema) ? this.info.inputSchema : {};
    const properties = isSchema(schema.properties) ? schema.properties : {};
    return {
      name: this.name,
      description: `[MCP:${this.server}] ${this.info.description ?? this.info.name}`,
      // `type: "object"` is OURS (every provider needs one, and a bare `{properties}`
      // schema omits it); everything else is the server's own words.
      parameters: { ...schema, type: "object", properties },
    };
  }

  execute(args: Record<string, unknown> = {}, ctx?: ToolContext): Promise<ToolResult> {
    return this.run(args, ctx);
  }

  private async run(args: Record<string, unknown>, ctx?: ToolContext): Promise<ToolResult> {
    try {
      // The run's abort signal goes all the way down: pressing Stop must not leave an MCP call
      // hanging until its timeout (it did, and the answer came back after the run was over).
      const { text, isError } = await this.client.callTool(this.info.name, args ?? {}, ctx?.signal);
      // The result enters the CONVERSATION here, so this is where the cap belongs: old results
      // get masked later, but THIS is the one the model is waiting for.
      const cap = toolOutputCapChars(MCP_OUTPUT_CAP_CHARS, ctx?.contextBudget);
      const content = text.length > cap ? text.slice(0, cap) + truncationNote(cap) : text;
      return { content, isError };
    } catch (e) {
      return {
        content: `MCP tool "${this.name}" failed: ${e instanceof Error ? e.message : String(e)}`,
        isError: true,
      };
    }
  }
}

/** A JSON object (not an array, not null): the shape of a JSON Schema fragment. */
function isSchema(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
