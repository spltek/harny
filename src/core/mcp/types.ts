/** Model Context Protocol (MCP) support: types shared by the client/manager. */

/** One tool exposed by an MCP server (from `tools/list`). */
export interface McpToolInfo {
  name: string;
  description?: string;
  /** JSON Schema of the tool arguments (passed through to the model). */
  inputSchema?: unknown;
}

/** Common surface of an MCP transport (stdio process or HTTP endpoint). */
export interface McpClient {
  /** Connect + complete the `initialize` handshake. */
  start(): Promise<void>;
  listTools(): Promise<McpToolInfo[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }>;
  close(): void;
}

/** Runtime status of one configured MCP server (for the UI). */
export interface McpServerStatus {
  name: string;
  ok: boolean;
  /** false = disabled in the config (not connected, tools not exposed). */
  enabled: boolean;
  error?: string;
  toolCount: number;
  /** Tool names + descriptions (for the UI popover). */
  tools?: { name: string; description?: string }[];
}
