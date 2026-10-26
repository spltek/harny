import type { McpServerConfig } from "../config/types";
import type { Tool } from "../tools/tool";
import { McpStdioClient } from "./mcp-client";
import { McpHttpClient } from "./mcp-http-client";
import type { ServerAnalyzePolicy } from "./types";
import { McpTool, mcpToolName } from "./mcp-tool";
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
  /** Serializes connect(): see {@link connect}. */
  private connecting: Promise<void> = Promise.resolve();

  constructor(private readonly deps: McpManagerDeps) {}

  /**
   * Connect every configured server (stdio) and register their tools. NEVER throws: a
   * failing server is reported in its status and skipped.
   *
   * Calls are SERIALIZED. The activation connect (`void mcp.connect()`) and one from the
   * UI (a save, a server toggle, the tools panel) can overlap — and two concurrent
   * spawns of the same `npx -y <package>` extract into the SAME `_npx` cache entry,
   * which is how npm ends up dying with `ENOTEMPTY: rename …/.content-disposition-XXXX`
   * and every MCP server built on npx fails until someone clears the cache by hand.
   * The second call now waits for the first to finish instead.
   */
  connect(): Promise<void> {
    const run = this.connecting.then(
      () => this.connectNow(),
      () => this.connectNow(),
    );
    // The chain must never stay rejected: a failed pass cannot block the next one.
    this.connecting = run.catch(() => {});
    return run;
  }

  /** One pass over the configured servers (never runs concurrently with itself). */
  private async connectNow(): Promise<void> {
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
        this.statuses.push({
          name,
          ok: false,
          enabled: true,
          error: "a server needs 'command' (stdio) or 'url' (http)",
          toolCount: 0,
        });
        continue;
      }
      try {
        await client.start();
        const infos = await client.listTools();
        this.clients.set(name, client);
        // A server can die AFTER connecting (a crash, an OOM kill, a package that exits
        // when idle). Without this, its tools stayed registered for ever and every call
        // failed with "MCP server is not running" while the card still showed it green.
        client.onExit?.((message) => this.markDead(name, message));
        // The Analyze gate needs the USER's declaration for this server, read live so a
        // settings change lands on the next turn (see ServerAnalyzePolicy).
        const declared = (): ServerAnalyzePolicy | undefined => this.deps.servers()?.[name]?.analyze;
        // `excludeTools` is a CONNECT-time decision on purpose, unlike `analyze`: it
        // decides whether the tool is REGISTERED at all, and the model's tool list is
        // built from the registry. Saving the panel's checkboxes reconnects (see the
        // host's setMcpToolExclusions), so the list the model sees is rebuilt there.
        const excluded = new Set(
          (this.deps.servers()?.[name]?.excludeTools ?? []).filter((t): t is string => typeof t === "string"),
        );
        let exposed = 0;
        const taken = new Set<string>();
        for (const info of infos) {
          if (excluded.has(info.name)) continue;
          const tool = new McpTool(name, info, client, declared);
          if (taken.has(tool.name)) {
            // Two raw names can sanitize to the SAME Harny name (`a-b` and `a_b`): the
            // registry keeps the first and the second would vanish without a word.
            this.deps.log?.(
              `[mcp] ${name}: tool-name collision — "${info.name}" maps to ${tool.name}, already taken; exposing the first only`,
            );
            continue;
          }
          taken.add(tool.name);
          exposed++;
          this.tools.push(tool);
        }
        this.statuses.push({
          name,
          ok: true,
          enabled: true,
          toolCount: exposed,
          tools: infos.map((t) => ({
            name: t.name,
            ...(t.description ? { description: t.description } : {}),
            ...(excluded.has(t.name) ? { excluded: true } : {}),
          })),
        });
        this.deps.log?.(
          `[mcp] ${name}: connected, ${exposed}/${infos.length} tool(s) exposed` +
            (excluded.size > 0 ? ` (${infos.length - exposed} excluded by config)` : "") +
            (declared() ? ` (analyze: ${declared()})` : " (analyze: not declared — none of them runs in Analyze)"),
        );
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

  /**
   * The server died on its own: say so, withdraw its tools and let the caller re-register.
   *
   * The tools are removed by PREFIX (`mcp__<server>__`), the same namespacing the registry
   * is cleaned with on a reconnect, so the two paths cannot disagree about what belongs to
   * this server. A deliberate `dispose()` never reaches here (see McpStdioClient.close).
   */
  private markDead(name: string, message?: string): void {
    // Already gone (a reconnect won the race): nothing to withdraw.
    if (!this.clients.delete(name)) return;
    this.statuses = this.statuses.map((s) =>
      s.name === name
        ? {
            name,
            ok: false,
            enabled: s.enabled,
            error: message ? `server exited: ${message}` : "server exited",
            toolCount: 0,
            // Keep what it HAD advertised: the panel shows the server as down, and the
            // list is still useful for understanding what was lost.
            ...(s.tools ? { tools: s.tools } : {}),
          }
        : s,
    );
    const prefix = mcpToolName(name, "");
    const before = this.tools.length;
    this.tools = this.tools.filter((t) => !t.name.startsWith(prefix));
    this.deps.log?.(`[mcp] ${name}: died — withdrawing ${before - this.tools.length} tool(s)`);
    this.deps.onToolsChanged?.();
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
