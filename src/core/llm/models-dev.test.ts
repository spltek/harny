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

  it("returns undefined for unknown models/providers", async () => {
    const catalog = new ModelsDevCatalog(
      fakeHttp(jsonResponse(200, { p: { models: { m: { limit: { context: 5000 } } } } })),
    );
    expect(await catalog.getContext("nope", ["p"])).toBeUndefined();
    expect(await catalog.getContext("m", ["other"])).toBeUndefined();
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
