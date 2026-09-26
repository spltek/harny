export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  /** True when no valid JSON arguments could be parsed from the stream (malformed/empty). */
  malformed?: boolean;
}

export interface ToolResult {
  content: string;
  isError: boolean;
}

export interface ToolParameter {
  type?: string;
  description?: string;
  items?: unknown;
  enum?: string[];
  properties?: Record<string, unknown>;
  required?: string[];
  minItems?: number;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

/**
 * Execution context passed by the orchestrator to a tool.
 *
 * `dryRun` is set in Analyze (read-only preview) mode: the tool must VALIDATE
 * and describe the change (compute the diff) but NEVER touch the filesystem.
 * The result is shown to the user as a proposal, to be applied after switching
 * to Build mode.
 */
export interface ToolContext {
  dryRun?: boolean;
}

export interface Tool {
  readonly name: string;
  readonly definition: ToolDefinition;
  execute(args: Record<string, unknown>, ctx?: ToolContext): Promise<ToolResult> | ToolResult;
}
