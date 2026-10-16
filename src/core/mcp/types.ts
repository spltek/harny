/** Model Context Protocol (MCP) support: types shared by the client/manager. */

/** The behavior hints a server MAY send with a tool (MCP `ToolAnnotations`).
 *
 * The protocol's own defaults are conservative — `readOnlyHint: false`,
 * `destructiveHint: true` — so a tool that says nothing is treated as one that
 * MODIFIES, which is exactly what Analyze needs.
 *
 * The spec is explicit about trust: clients "MUST consider tool annotations to be
 * untrusted unless they come from trusted servers". That is why Harny never lets a
 * server's hint open the gate by itself: the user marks a server trusted (see
 * `ServerAnalyzePolicy`), and only then is `readOnlyHint: true` believed. */
export interface McpToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

/** Per-server Analyze policy, DECLARED BY THE USER (see the tool annotations above).
 *
 *   · unset        — the strictest: no tool of this server runs in Analyze.
 *   · `trusted`    — the server's own `readOnlyHint: true` is believed (and nothing else).
 *   · `read-only`  — a blanket statement of yours: every tool of this server is
 *                    read-only, even if it declares nothing (old servers).
 */
export type ServerAnalyzePolicy = "trusted" | "read-only";

export interface McpToolInfo {
  /** One tool exposed by an MCP server (from `tools/list`). */
  name: string;
  description?: string;
  /** JSON Schema of the tool arguments (passed through to the model). */
  inputSchema?: unknown;
  /** Behavior hints, when the server sends them (see {@link McpToolAnnotations}). */
  annotations?: McpToolAnnotations;
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
