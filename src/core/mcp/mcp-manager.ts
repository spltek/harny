import type { McpServerConfig } from "../config/types";
import type { Tool } from "../tools/tool";
import { McpStdioClient } from "./mcp-client";
import { McpHttpClient } from "./mcp-http-client";
import { McpTool } from "./mcp-tool";
import type { McpClient, McpServerStatus } from "./types";

export interface McpManagerDeps {
  /** Current MCP servers from the config file (name → server). */
  servers: () => Record<string, McpServerConfig> | undefined;
  log?: (message: string) => void;
  /** Called after (re)connecting so the caller can register the tools. */
  onToolsChanged?: () => void;
}

/**
 * Owns the MCP servers for the extension: connects them (stdio), lists their
 * tools, wraps each as a Harny Tool (`mcp__<server>__<tool>`) and reports a
 * per-server status for the UI. `connect()` is idempotent: it disposes the
 * previous connections first, so it doubles as "reconnect after config save".
 */
export class McpManager {
  private readonly clients = new Map<string, McpClient>();
  private tools: Tool[] = [];
  private statuses: McpServerStatus[] = [];

  constructor(private readonly deps: McpManagerDeps) {}

  /** Connect every configured server (stdio). Never throws: a failing server
   * is reported in its status and skipped. */
  async connect(): Promise<void> {
    this.dispose();
    const servers = this.deps.servers() ?? {};
    for (const [name, cfg] of Object.entries(servers)) {
      // Disabled in the config: keep it listed but do NOT connect or expose tools.
      if (cfg && typeof cfg === "object" && cfg.enabled === false) {
        this.statuses.push({ name, ok: true, enabled: false, toolCount: 0 });
        this.deps.log?.(`[mcp] ${name}: disabled`);
        continue;
      }
      let client: McpClient;
      if (cfg && typeof cfg === "object" && "command" in cfg && cfg.command) {
        client = new McpStdioClient({ command: cfg.command, args: cfg.args, env: cfg.env, log: this.deps.log });
      } else if (cfg && typeof cfg === "object" && "url" in cfg && cfg.url) {
        client = new McpHttpClient({ url: cfg.url, headers: cfg.headers, log: this.deps.log });
      } else {
        this.statuses.push({ name, ok: false, enabled: true, error: "a server needs 'command' (stdio) or 'url' (http)", toolCount: 0 });
        continue;
      }
      try {
        await client.start();
        const infos = await client.listTools();
        this.clients.set(name, client);
        for (const info of infos) this.tools.push(new McpTool(name, info, client));
        this.statuses.push({
          name,
          ok: true,
          enabled: true,
          toolCount: infos.length,
          tools: infos.map((t) => ({ name: t.name, ...(t.description ? { description: t.description } : {}) })),
        });
        this.deps.log?.(`[mcp] ${name}: connected, ${infos.length} tool(s)`);
      } catch (e) {
        client.close();
        const error = e instanceof Error ? e.message : String(e);
        this.statuses.push({ name, ok: false, enabled: true, error, toolCount: 0 });
        this.deps.log?.(`[mcp] ${name}: ${error}`);
      }
    }
    this.deps.onToolsChanged?.();
  }

  /** The wrapped MCP tools (empty until `connect()` succeeds). */
  getTools(): Tool[] {
    return [...this.tools];
  }

  /** Per-server status for the UI. */
  getStatuses(): McpServerStatus[] {
    return [...this.statuses];
  }

  dispose(): void {
    for (const c of this.clients.values()) c.close();
    this.clients.clear();
    this.tools = [];
    this.statuses = [];
  }
}
