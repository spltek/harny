import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { isAbsolute } from "node:path";
import { createInterface } from "node:readline";
import { isWindows } from "../platform";
import { killTree } from "../process/kill-tree";
import type { McpClient, McpToolInfo } from "./types";

/** MCP protocol version Harny speaks (tools only). */
const PROTOCOL_VERSION = "2024-11-05";
const DEFAULT_TIMEOUT_MS = 20_000;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export interface McpStdioOptions {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  timeoutMs?: number;
  log?: (message: string) => void;
}

/**
 * Minimal MCP client over the **stdio** transport: newline-delimited JSON-RPC
 * 2.0. It implements just what Harny needs — `initialize`, `tools/list`,
 * `tools/call` — with NO SDK dependency, so it works identically on
 * Windows/macOS/Linux.
 */
export class McpStdioClient implements McpClient {
  private child?: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private stderrTail = "";
  private closed = false;
  private onExitCb?: (error?: string) => void;

  constructor(private readonly opts: McpStdioOptions) {}

  /** Spawn the server and complete the `initialize` handshake. */
  async start(): Promise<void> {
    if (this.child) return;
    const child = spawn(this.opts.command, this.opts.args ?? [], {
      cwd: this.opts.cwd,
      env: { ...process.env, ...(this.opts.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
      // POSIX: process-GROUP leader so close() can signal the whole tree.
      detached: !isWindows,
      // Windows ships `npx`/`node` as `.cmd` shims that plain spawn cannot run,
      // so bare commands need a shell there. An ABSOLUTE path (e.g. node.exe)
      // does NOT: a shell would mangle quoted/`-e` args. The command comes from
      // the user's OWN MCP config, so it is trusted.
      shell: process.platform === "win32" && !isAbsolute(this.opts.command),
    });
    this.child = child;

    const rl = createInterface({ input: child.stdout });
    rl.on("line", (line) => this.handleLine(line));
    child.stderr.on("data", (d) => {
      this.stderrTail = (this.stderrTail + String(d)).slice(-2000);
      const text = String(d).trim();
      if (text) this.opts.log?.(`[mcp:${this.opts.command}] ${text.slice(0, 500)}`);
    });
    child.on("error", (err) => this.failAll(err instanceof Error ? err : new Error(String(err))));
    child.on("exit", (code, signal) => {
      this.closed = true;
      const detail = this.stderrTail.trim() ? `: ${this.stderrTail.trim().slice(-300)}` : "";
      const err = new Error(`MCP server exited (code=${code ?? "-"} signal=${signal ?? "-"})${detail}`);
      this.failAll(err);
      this.onExitCb?.(err.message);
    });

    await this.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "harny", version: "0.1.0" },
    });
    this.notify("notifications/initialized", {});
  }

  /** The server's tool catalog. */
  async listTools(): Promise<McpToolInfo[]> {
    const res = (await this.request("tools/list", {})) as { tools?: unknown[] } | undefined;
    const tools = Array.isArray(res?.tools) ? res.tools : [];
    return tools.map((t) => {
      const rec = (t ?? {}) as Record<string, unknown>;
      return {
        name: String(rec.name ?? ""),
        ...(typeof rec.description === "string" ? { description: rec.description } : {}),
        ...(rec.inputSchema !== undefined ? { inputSchema: rec.inputSchema } : {}),
      };
    });
  }

  /** Invoke a tool and flatten its content blocks into text. */
  async callTool(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
    const res = (await this.request("tools/call", { name, arguments: args })) as
      | { content?: unknown; isError?: boolean }
      | undefined;
    return { text: formatMcpContent(res?.content), isError: res?.isError === true };
  }

  onExit(cb: (error?: string) => void): void {
    this.onExitCb = cb;
  }

  get running(): boolean {
    return !!this.child && !this.closed;
  }

  close(): void {
    this.closed = true;
    this.failAll(new Error("MCP client closed"));
    // Kill the server AND any children it spawned (a bare kill() would leave the
    // descendants alive).
    if (this.child) killTree(this.child);
    this.child = undefined;
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      this.opts.log?.(`[mcp] non-JSON line: ${trimmed.slice(0, 200)}`);
      return;
    }
    const id = msg.id;
    if (typeof id === "number" && this.pending.has(id)) {
      const p = this.pending.get(id)!;
      this.pending.delete(id);
      clearTimeout(p.timer);
      if (msg.error) {
        const e = msg.error as Record<string, unknown>;
        p.reject(new Error(typeof e.message === "string" ? e.message : JSON.stringify(e)));
      } else {
        p.resolve(msg.result);
      }
    }
    // Server-initiated requests/notifications are ignored (tools-only client).
  }

  private request(method: string, params: unknown): Promise<unknown> {
    if (this.closed || !this.child) return Promise.reject(new Error("MCP server is not running"));
    const id = this.nextId++;
    const timeoutMs = this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  private notify(method: string, params: unknown): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  private send(msg: unknown): void {
    try {
      this.child?.stdin.write(JSON.stringify(msg) + "\n");
    } catch (e) {
      this.opts.log?.(`[mcp] write failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private failAll(err: Error): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }
}

/** Flatten MCP content blocks (text/image/resource) into a single string. */
export function formatMcpContent(content: unknown): string {
  if (!Array.isArray(content)) {
    if (typeof content === "string") return content || "(no output)";
    if (content === undefined || content === null) return "(no output)";
    return JSON.stringify(content) || "(no output)";
  }
  const parts: string[] = [];
  for (const c of content) {
    if (!c || typeof c !== "object") continue;
    const rec = c as Record<string, unknown>;
    if (rec.type === "text" && typeof rec.text === "string") parts.push(rec.text);
    else if (rec.type === "image") parts.push(`[image ${typeof rec.mimeType === "string" ? rec.mimeType : ""}]`.trim());
    else if (rec.type === "resource" && rec.resource && typeof rec.resource === "object") {
      const r = rec.resource as Record<string, unknown>;
      parts.push(typeof r.text === "string" ? r.text : `[resource ${typeof r.uri === "string" ? r.uri : ""}]`.trim());
    } else parts.push(JSON.stringify(c));
  }
  return parts.join("\n") || "(no output)";
}
