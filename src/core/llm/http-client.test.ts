import { describe, it, expect } from "vitest";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { nodeHttpClient } from "./http-client";

/**
 * Start a throwaway HTTP server on a 127.0.0.1 ephemeral port, run `fn` with the
 * bound port, then close it deterministically. Binding to 127.0.0.1 (not the
 * default all-interfaces) matches the URLs the tests fetch, avoiding any
 * IPv4/IPv6 ambiguity, and `closeAllConnections` drops the keep-alive sockets so
 * teardown never hangs.
 */
async function withServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  fn: (port: number) => Promise<void>,
): Promise<void> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(port);
  } finally {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("nodeHttpClient", () => {
  it("posts JSON with headers to a real HTTP server", async () => {
    let received: { body: string; auth?: string } = { body: "" };

    await withServer(
      (req, res) => {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          received = { body, auth: req.headers.authorization };
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        });
      },
      async (port) => {
        const resp = await nodeHttpClient.post(
          `http://127.0.0.1:${port}/v1/chat/completions`,
          JSON.stringify({ a: 1 }),
          { Authorization: "Bearer key", "Content-Type": "application/json" },
        );

        expect(resp.ok).toBe(true);
        expect(resp.status).toBe(200);
        expect(await resp.json()).toEqual({ ok: true });
        expect(received.auth).toBe("Bearer key");
        expect(JSON.parse(received.body)).toEqual({ a: 1 });
      },
    );
  });

  it("GETs a URL and reads the body", async () => {
    await withServer(
      (_req, res) => {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("hello world");
      },
      async (port) => {
        const resp = await nodeHttpClient.get(`http://127.0.0.1:${port}/`);
        expect(await resp.text()).toBe("hello world");
      },
    );
  });

  it("surfaces non-OK status codes", async () => {
    await withServer(
      (_req, res) => {
        res.writeHead(401);
        res.end("nope");
      },
      async (port) => {
        const resp = await nodeHttpClient.get(`http://127.0.0.1:${port}/`);
        expect(resp.ok).toBe(false);
        expect(resp.status).toBe(401);
      },
    );
  });

  it("rewrites localhost to 127.0.0.1 so connects skip DNS", async () => {
    let host = "";

    await withServer(
      (req, res) => {
        host = req.headers.host ?? "";
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      },
      async (port) => {
        const resp = await nodeHttpClient.get(`http://localhost:${port}/v1/models`);
        expect(resp.ok).toBe(true);
        expect(host).toBe(`127.0.0.1:${port}`);
      },
    );
  });
});
