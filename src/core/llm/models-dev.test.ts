import { describe, it, expect, vi } from "vitest";
import { ModelsDevCatalog, modelsDevProviderCandidates } from "./models-dev";
import type { HttpClient, HttpResponse } from "./http-client";

function jsonResponse(status: number, body: unknown): HttpResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => JSON.stringify(body),
    json: async () => body,
    body: null,
  };
}

function fakeHttp(response: HttpResponse): HttpClient {
  return { post: vi.fn(), get: vi.fn(async () => response) };
}

describe("modelsDevProviderCandidates", () => {
  it("tries the config provider name first, then the OpenCode host guess", () => {
    expect(modelsDevProviderCandidates("MyName", "https://opencode.ai/zen/go/v1")).toEqual([
      "myname",
      "opencode-go",
      "opencode",
    ]);
    expect(modelsDevProviderCandidates("openrouter")).toEqual(["openrouter"]);
  });
});

describe("ModelsDevCatalog", () => {
  it("looks up the context window and caches the catalog (single fetch)", async () => {
    const get = vi.fn(async () =>
      jsonResponse(200, { "opencode-go": { models: { "kimi-k3": { limit: { context: 1048576 } } } } }),
    );
    const catalog = new ModelsDevCatalog({ post: vi.fn(), get } as unknown as HttpClient);

    expect(await catalog.getContext("kimi-k3", ["opencode-go"])).toBe(1048576);
    expect(await catalog.getContext("kimi-k3", ["opencode-go"])).toBe(1048576);
    expect(get).toHaveBeenCalledTimes(1); // cached after the first load
  });

  it("returns undefined only for a truly unknown model id", async () => {
    const catalog = new ModelsDevCatalog(
      fakeHttp(jsonResponse(200, { p: { models: { m: { limit: { context: 5000 } } } } })),
    );
    expect(await catalog.getContext("nope", ["p"])).toBeUndefined();
  });

  it("is best-effort when the host is offline (no throw, undefined)", async () => {
    const offline = new ModelsDevCatalog({
      post: vi.fn(),
      get: vi.fn(async () => {
        throw new Error("offline");
      }),
    } as unknown as HttpClient);
    expect(await offline.getContext("m", ["p"])).toBeUndefined();
  });
});

describe("ModelsDevCatalog.getLimits", () => {
  it("returns BOTH the context window and the max output", async () => {
    const get = vi.fn(async () =>
      jsonResponse(200, { p: { models: { m: { limit: { context: 200000, output: 8192 } } } } }),
    );
    const catalog = new ModelsDevCatalog({ post: vi.fn(), get } as unknown as HttpClient);
    expect(await catalog.getLimits("m", ["p"])).toEqual({ context: 200000, output: 8192 });
    expect(await catalog.getLimits("nope", ["p"])).toEqual({});
  });
});

describe("ModelsDevCatalog.getLimits — partial data", () => {
  it("returns only the side that is present (context-only / output-only)", async () => {
    const get = vi.fn(async () =>
      jsonResponse(200, {
        p: { models: { c: { limit: { context: 1000 } }, o: { limit: { output: 500 } } } },
      }),
    );
    const catalog = new ModelsDevCatalog({ post: vi.fn(), get } as unknown as HttpClient);
    expect(await catalog.getLimits("c", ["p"])).toEqual({ context: 1000 });
    expect(await catalog.getLimits("o", ["p"])).toEqual({ output: 500 });
  });
});

describe("ModelsDevCatalog.getLimits — generic cross-provider fallback", () => {
  // The host (OpenCode Go) exposes `deepseek-flash`, but models.dev lists it
  // under the `deepseek` provider (and `302ai`), while `opencode-go` uses the
  // id `deepseek-v4.1-flash`. No family list: the fallback matches the ID.
  const CATALOG = {
    "opencode-go": { models: { "deepseek-v4.1-flash": { limit: { context: 1000000, output: 393216 } } } },
    deepseek: { models: { "deepseek-flash": { limit: { context: 1000000, output: 393216 } } } },
    "302ai": { models: { "deepseek-flash": { limit: { context: 64000, output: 4096 } } } },
  };

  it("finds a model whose (provider, id) naming differs from the host", async () => {
    const catalog = new ModelsDevCatalog(fakeHttp(jsonResponse(200, CATALOG)));
    expect(await catalog.getLimits("deepseek-flash", ["opencode-go", "opencode"])).toEqual({
      context: 1000000,
      output: 393216,
    });
  });

  it("prefers the provider whose NAME appears in the id (deepseek over 302ai)", async () => {
    const catalog = new ModelsDevCatalog(fakeHttp(jsonResponse(200, CATALOG)));
    // 302ai also declares `deepseek-flash` (64000/4096) but is NOT chosen.
    expect(await catalog.getLimits("deepseek-flash", ["opencode-go"])).toEqual({ context: 1000000, output: 393216 });
  });

  it("is case-tolerant on the model id", async () => {
    const catalog = new ModelsDevCatalog(fakeHttp(jsonResponse(200, CATALOG)));
    expect(await catalog.getContext("DeepSeek-Flash", ["opencode-go"])).toBe(1000000);
  });

  it("the provider candidate stays AUTHORITATIVE over the fallback", async () => {
    const catalog = new ModelsDevCatalog(
      fakeHttp(
        jsonResponse(200, {
          deepseek: { models: { "deepseek-flash": { limit: { context: 111 } } } },
          other: { models: { "deepseek-flash": { limit: { context: 222 } } } },
        }),
      ),
    );
    expect(await catalog.getLimits("deepseek-flash", ["deepseek"])).toEqual({ context: 111 });
  });

  it("still returns {} when the id is nowhere in the catalog", async () => {
    const catalog = new ModelsDevCatalog(fakeHttp(jsonResponse(200, CATALOG)));
    expect(await catalog.getLimits("totally-unknown", ["opencode-go"])).toEqual({});
  });
});

describe("ModelsDevCatalog.isReachable", () => {
  it("is true after a successful load and false after a failure", async () => {
    const ok = new ModelsDevCatalog({
      post: vi.fn(),
      get: vi.fn(async () => jsonResponse(200, { p: { models: {} } })),
    } as unknown as HttpClient);
    expect(ok.isReachable()).toBe(true);
    await ok.getLimits("m", ["p"]);
    expect(ok.isReachable()).toBe(true);

    const bad = new ModelsDevCatalog({
      post: vi.fn(),
      get: vi.fn(async () => {
        throw new Error("offline");
      }),
    } as unknown as HttpClient);
    await bad.getLimits("m", ["p"]);
    expect(bad.isReachable()).toBe(false);
  });
});
