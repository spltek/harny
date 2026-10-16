import { formatMcpContent } from "./mcp-client";
import type { McpClient, McpToolAnnotations, McpToolInfo } from "./types";

const PROTOCOL_VERSION = "2024-11-05";
const DEFAULT_TIMEOUT_MS = 20_000;

export interface McpHttpOptions {
  url: string;
  /** Extra request headers (auth, etc.) from the config. */
  headers?: Record<string, string>;
  timeoutMs?: number;
  log?: (message: string) => void;
}

/**
 * MCP client over the **Streamable HTTP** transport. Each JSON-RPC message is a
 * POST; the server answers with `application/json` OR `text/event-stream`
 * (SSE). It is **stateless** by default: if the server returns an
 * `Mcp-Session-Id` header it is echoed on subsequent requests (stateful), and
 * otherwise every request stands alone (serverless-friendly).
 *
 * Uses the global `fetch` (Node 18+), so no dependency.
 */
export class McpHttpClient implements McpClient {
  private nextId = 1;
  private sessionId?: string;
  private closed = false;

  constructor(private readonly opts: McpHttpOptions) {}

  async start(): Promise<void> {
    this.log(`initialize → ${this.opts.url}`);
    await this.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "harny", version: "0.1.0" },
    });
    this.log(`initialized${this.sessionId ? " (session)" : " (stateless)"}`);
    await this.notify("notifications/initialized", {});
  }

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

  async callTool(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
    const res = (await this.request("tools/call", { name, arguments: args })) as
      | { content?: unknown; isError?: boolean }
      | undefined;
    return { text: formatMcpContent(res?.content), isError: res?.isError === true };
  }

  close(): void {
    this.closed = true;
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    return this.post({ jsonrpc: "2.0", id, method, params }, id);
  }

  private async notify(method: string, params: unknown): Promise<void> {
    await this.post({ jsonrpc: "2.0", method, params });
  }

  private async post(message: unknown, expectId?: number): Promise<unknown> {
    if (this.closed) throw new Error("MCP HTTP client closed");
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      // Streamable HTTP requires accepting BOTH shapes.
      Accept: "application/json, text/event-stream",
      ...(this.opts.headers ?? {}),
    };
    if (this.sessionId) headers["Mcp-Session-Id"] = this.sessionId;

    const controller = new AbortController();
    const timeoutMs = this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await fetch(this.opts.url, {
        method: "POST",
        headers,
        body: JSON.stringify(message),
        signal: controller.signal,
      });
      // Stateful servers hand out a session id on initialize; echo it back.
      const sid = resp.headers.get("mcp-session-id");
      if (sid) this.sessionId = sid;
      const contentType = resp.headers.get("content-type") ?? "";
      this.log(
        `POST ${(message as { method?: string }).method ?? "?"} → ${resp.status} ${contentType || "?"}` +
          `${sid ? " (new session)" : this.sessionId ? " (session)" : " (stateless)"}`,
      );

      if (expectId === undefined) return undefined; // notification: no reply body

      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        throw new Error(`HTTP ${resp.status}${body ? `: ${body.slice(0, 300)}` : ""}`);
      }
      const payload = contentType.includes("text/event-stream")
        ? await this.readSse(resp, expectId)
        : await this.readJson(resp);
      if (payload && typeof payload === "object" && "error" in payload) {
        const err = (payload as { error: unknown }).error as Record<string, unknown>;
        const message = typeof err?.message === "string" ? err.message : JSON.stringify(err);
        this.log(`JSON-RPC error: ${message}`);
        throw new Error(message);
      }
      return (payload as { result?: unknown } | undefined)?.result;
    } catch (e) {
      this.log(`error: ${e instanceof Error ? e.message : String(e)}`);
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  private log(message: string): void {
    this.opts.log?.(`[mcp-http] ${message}`);
  }

  private async readJson(resp: Response): Promise<unknown> {
    const text = await resp.text();
    if (!text.trim()) return undefined;
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`Invalid JSON from MCP server: ${text.slice(0, 200)}`);
    }
  }

  /** Read an SSE stream until the response with `expectId` arrives. */
  private async readSse(resp: Response, expectId: number): Promise<unknown> {
    const reader = resp.body?.getReader();
    if (!reader) return undefined;
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let sep: number;
        while ((sep = buffer.indexOf("\n\n")) >= 0) {
          const event = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          const data = event
            .split("\n")
            .filter((l) => l.startsWith("data:"))
            .map((l) => l.slice(5).trim())
            .join("\n");
          if (!data) continue;
          let parsed: unknown;
          try {
            parsed = JSON.parse(data);
          } catch {
            continue;
          }
          if (parsed && typeof parsed === "object" && (parsed as { id?: unknown }).id === expectId) {
            this.log(`SSE response for id=${expectId}`);
            return parsed;
          }
        }
      }
    } finally {
      try {
        await reader.cancel();
      } catch {
        /* ignore */
      }
    }
    this.log(`SSE ended without a response for id=${expectId}`);
    return undefined;
  }
}

/** Minimal shape check for `ToolAnnotations`: booleans only, unknown fields ignored. */
function isAnnotations(value: unknown): value is McpToolAnnotations {
  if (!value || typeof value !== "object") return false;
  const rec = value as Record<string, unknown>;
  return ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"].some(
    (k) => typeof rec[k] === "boolean",
  );
}
