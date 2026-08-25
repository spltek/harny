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

export interface Tool {
  readonly name: string;
  readonly definition: ToolDefinition;
  execute(args: Record<string, unknown>): Promise<ToolResult> | ToolResult;
}
