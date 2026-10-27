import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { isAbsolute } from "node:path";
import { createInterface } from "node:readline";
import { isWindows } from "../platform";
import { killTree } from "../process/kill-tree";
import type { McpClient, McpToolAnnotations, McpToolInfo } from "./types";

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
  /** The FIRST stderr text: npm puts the real cause there (`code ENOTEMPTY`, the path,
   * the package). Kept apart from the tail because a `slice(-N)` of the tail alone is
   * what turned a clear npm failure into "y not empty, rename …". */
  private stderrHead = "";
  private stderrTail = "";
  private closed = false;
  /** `close()` was called by US: the exit that follows is ours, not the server's, and must
   * not be reported as a crash (a reconnect would otherwise look like one). */
  private disposed = false;
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
      const text = String(d);
      // Keep BOTH ends: the cause is at the top, the echo at the bottom. Bounded so a
      // chatty server cannot grow the buffer without limit.
      if (this.stderrHead.length < 4000) this.stderrHead = (this.stderrHead + text).slice(0, 4000);
      this.stderrTail = (this.stderrTail + text).slice(-2000);
      const logged = text.trim();
      if (logged) this.opts.log?.(`[mcp:${this.opts.command}] ${logged.slice(0, 500)}`);
    });
    child.on("error", (err) => this.failAll(err instanceof Error ? err : new Error(String(err))));
    // Reported ONCE, from 'close' when it comes first: at 'exit' the last stderr chunk
    // may still be in flight, and those are exactly the lines that name the problem. The
    // setImmediate is the floor — a server that keeps its pipes open still gets a report.
    let reported = false;
    const report = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (reported) return;
      reported = true;
      this.closed = true;
      const err = new Error(`MCP server exited (code=${code ?? "-"} signal=${signal ?? "-"})${this.exitDetail()}`);
      this.failAll(err);
      // A deliberate close() (reconnect, failed start) is not a crash: the caller already
      // knows, and reporting it would mark a freshly reconnected server as dead.
      if (!this.disposed) this.onExitCb?.(err.message);
    };
    child.on("exit", (code, signal) => {
      setImmediate(() => report(code, signal));
    });
    child.on("close", (code, signal) => report(code, signal));

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
        // The server's behavior hints decide nothing on their own (untrusted unless the
        // user marked the server trusted) but they must not be DROPPED here either: they
        // are what a trusted server is believed on, and they are shown to the user.
        ...(isAnnotations(rec.annotations) ? { annotations: rec.annotations } : {}),
      };
    });
  }

  /** Invoke a tool and flatten its content blocks into text. */
  async callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<{ text: string; isError: boolean }> {
    const res = (await this.request("tools/call", { name, arguments: args }, signal)) as
      { content?: unknown; isError?: boolean } | undefined;
    return { text: formatMcpContent(res?.content), isError: res?.isError === true };
  }

  onExit(cb: (error?: string) => void): void {
    this.onExitCb = cb;
  }

  /**
   * What the server said before dying, as a SHORT message a human can act on: the first
   * lines (the cause) and the last (where it gave up), never a mid-word slice.
   *
   * This used to be `stderr.slice(-300)`, which on a failing `npx` install produced
   * `(code=190 signal=-): y not empty, rename '…/content-disposition' -> …` — the tail of
   * "directory not empty", with the line that NAMES the problem cut off.
   */
  private exitDetail(): string {
    const all = `${this.stderrHead}${this.stderrTail}`.trim();
    if (!all) return "";
    const lines = all
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l !== "");
    const head = lines.slice(0, 3).join(" ").slice(0, 300);
    const last = lines.length > 3 ? lines[lines.length - 1].slice(0, 160) : "";
    const body = last && !head.endsWith(last) ? `${head} … ${last}` : head;
    const hint = mcpFailureHint(all);
    return `: ${body}${hint ? ` — ${hint}` : ""}`;
  }

  get running(): boolean {
    return !!this.child && !this.closed;
  }

  close(): void {
    this.disposed = true;
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

  private request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    if (this.closed || !this.child) return Promise.reject(new Error("MCP server is not running"));
    // Already cancelled before we even asked: do not send anything.
    if (signal?.aborted) return Promise.reject(new Error("cancelled by Stop"));
    const id = this.nextId++;
    const timeoutMs = this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      // Stop must reach an IN-FLIGHT call: without this the request sat here until its
      // timeout, and the answer arrived after the run was already over. The server is told
      // (the protocol's own cancellation notification), the pending entry is dropped and the
      // late reply is ignored — the process stays alive for the next turn.
      const onAbort = (): void => {
        if (!this.pending.delete(id)) return;
        clearTimeout(timer);
        this.notify("notifications/cancelled", { requestId: id, reason: "the user pressed Stop" });
        reject(new Error("cancelled by Stop"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, {
        resolve: (v) => {
          signal?.removeEventListener("abort", onAbort);
          resolve(v);
        },
        reject: (e) => {
          signal?.removeEventListener("abort", onAbort);
          reject(e);
        },
        timer,
      });
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

/**
 * A one-line REMEDY for the failures we can name, appended to the error itself.
 *
 * `code=190` and a wall of npm output tell nobody what to do; "clear the npx cache"
 * does. Kept narrow on purpose: a wrong hint is worse than none.
 */
function mcpFailureHint(stderr: string): string {
  if (/ENOTEMPTY|_npx/i.test(stderr)) {
    return "npm's npx cache looks incomplete — run `rm -rf ~/.npm/_npx` and Test again (the first run re-downloads the package)";
  }
  if (/EACCES|permission denied/i.test(stderr)) {
    return "the command is not executable here — check its path and permissions";
  }
  if (/ENOENT|command not found|not recognized/i.test(stderr)) {
    return "the command was not found on PATH";
  }
  return "";
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

/** Minimal shape check for `ToolAnnotations`: booleans only, unknown fields ignored. */
function isAnnotations(value: unknown): value is McpToolAnnotations {
  if (!value || typeof value !== "object") return false;
  const rec = value as Record<string, unknown>;
  return ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"].some(
    (k) => typeof rec[k] === "boolean",
  );
}
