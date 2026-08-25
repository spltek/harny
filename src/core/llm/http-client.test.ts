import { describe, it, expect } from "vitest";
import { createServer } from "node:http";
import { nodeHttpClient } from "./http-client";

describe("nodeHttpClient", () => {
  it("posts JSON with headers to a real HTTP server", async () => {
    let received: { body: string; auth?: string } = { body: "" };
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        received = { body, auth: req.headers.authorization };
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    await new Promise<void>((r) => server.listen(0, r));
    try {
      const port = (server.address() as { port: number }).port;
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
    } finally {
      server.close();
    }
  });

  it("GETs a URL and reads the body", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("hello world");
    });
    await new Promise<void>((r) => server.listen(0, r));
    try {
      const port = (server.address() as { port: number }).port;
      const resp = await nodeHttpClient.get(`http://127.0.0.1:${port}/`);
      expect(await resp.text()).toBe("hello world");
    } finally {
      server.close();
    }
  });

  it("surfaces non-OK status codes", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(401);
      res.end("nope");
    });
    await new Promise<void>((r) => server.listen(0, r));
    try {
      const port = (server.address() as { port: number }).port;
      const resp = await nodeHttpClient.get(`http://127.0.0.1:${port}/`);
      expect(resp.ok).toBe(false);
      expect(resp.status).toBe(401);
    } finally {
      server.close();
    }
  });

  it("rewrites localhost to 127.0.0.1 so connects skip DNS", async () => {
    let host = "";
    const server = createServer((req, res) => {
      host = req.headers.host ?? "";
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const port = (server.address() as { port: number }).port;
      const resp = await nodeHttpClient.get(`http://localhost:${port}/v1/models`);
      expect(resp.ok).toBe(true);
      expect(host).toBe(`127.0.0.1:${port}`);
    } finally {
      server.close();
    }
  });
});
