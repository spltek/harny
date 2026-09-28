import { describe, it, expect, vi } from "vitest";
import { extractContextLength, HttpModelListProvider } from "./model-list";
import type { HttpClient, HttpResponse } from "./http-client";

function fakeHttp(response: HttpResponse): HttpClient {
  return { post: vi.fn(), get: vi.fn(async () => response) };
}

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

describe("HttpModelListProvider", () => {
  it("hits the OpenAI-style /v1/models endpoint with the bearer token", async () => {
    const get = vi.fn(async () => jsonResponse(200, { data: [{ id: "a" }, { id: "b" }] }));
    const http: HttpClient = { post: vi.fn(), get };
    const provider = new HttpModelListProvider(http);

    const models = await provider.fetchModels({ baseUrl: "https://api.example.com", apiKey: "sk-1" });

    expect(get).toHaveBeenCalledWith(
      "https://api.example.com/v1/models",
      { Authorization: "Bearer sk-1" },
      expect.any(AbortSignal),
    );
    expect(models).toEqual(["a", "b"]);
  });

  it("keeps an existing /v1 suffix in the base URL", async () => {
    const get = vi.fn(async () => jsonResponse(200, { data: [{ id: "m" }] }));
    const provider = new HttpModelListProvider({ post: vi.fn(), get });

    await provider.fetchModels({ baseUrl: "http://localhost:8090/v1", apiKey: "k" });

    expect(get).toHaveBeenCalledWith(
      "http://localhost:8090/v1/models",
      { Authorization: "Bearer k" },
      expect.any(AbortSignal),
    );
  });

  it("accepts a bare models array", async () => {
    const provider = new HttpModelListProvider(fakeHttp(jsonResponse(200, { models: ["x", "y"] })));
    expect(await provider.fetchModels({ baseUrl: "http://h", apiKey: "k" })).toEqual(["x", "y"]);
  });

  it("fills from OpenRouter's /models shape (id + name + context_length)", async () => {
    const provider = new HttpModelListProvider(
      fakeHttp(
        jsonResponse(200, {
          data: [
            { id: "deepseek/deepseek-chat-v3", name: "DeepSeek V3", context_length: 131072 },
            { id: "qwen/qwen-3-32b", name: "Qwen3 32B", context_length: 32768 },
            { context_length: 99999 }, // missing id → skipped
          ],
        }),
      ),
    );
    const models = await provider.fetchModels({ baseUrl: "https://openrouter.ai/api/v1", apiKey: "sk-or-1" });
    expect(models).toEqual(["deepseek/deepseek-chat-v3", "qwen/qwen-3-32b"]);
  });

  it("returns model infos with the host-reported context window", async () => {
    const provider = new HttpModelListProvider(
      fakeHttp(
        jsonResponse(200, {
          data: [
            { id: "openrouter/x", context_length: 131072 },
            { id: "vllm/y", max_model_len: 32768 },
            { id: "llamacpp/z", meta: { n_ctx_train: 8192 } },
            { id: "nested", top_provider: { context_length: 200000 } },
            // models.dev schema — what OpenCode Go / Zen uses: `limit.context`.
            { id: "opencode-go/deepseek", limit: { context: 128000, output: 8192 } },
            { id: "modelsdev", limits: { context: 262144 } },
            { id: "camel", contextWindow: 64000 },
            { id: "plain" },
          ],
        }),
      ),
    );
    const infos = await provider.fetchModelInfos!({ baseUrl: "http://h", apiKey: "k" });
    expect(infos.find((m) => m.id === "openrouter/x")?.contextLength).toBe(131072);
    expect(infos.find((m) => m.id === "vllm/y")?.contextLength).toBe(32768);
    expect(infos.find((m) => m.id === "llamacpp/z")?.contextLength).toBe(8192);
    expect(infos.find((m) => m.id === "nested")?.contextLength).toBe(200000);
    expect(infos.find((m) => m.id === "opencode-go/deepseek")?.contextLength).toBe(128000);
    expect(infos.find((m) => m.id === "modelsdev")?.contextLength).toBe(262144);
    expect(infos.find((m) => m.id === "camel")?.contextLength).toBe(64000);
    expect(infos.find((m) => m.id === "plain")?.contextLength).toBeUndefined();
  });

  it("extractContextLength ignores non-numeric / non-positive values", () => {
    expect(extractContextLength({ context_length: "abc" })).toBeUndefined();
    expect(extractContextLength({ context_length: 0 })).toBeUndefined();
    expect(extractContextLength({ context_length: -5 })).toBeUndefined();
    expect(extractContextLength(null)).toBeUndefined();
    expect(extractContextLength({ limit: { context: 128000 } })).toBe(128000);
    expect(extractContextLength({ limits: { context: "200000" } })).toBe(200000);
  });

  it("accepts a bare array body", async () => {
    const provider = new HttpModelListProvider(fakeHttp(jsonResponse(200, [{ id: "ok" }, "direct"])));
    expect(await provider.fetchModels({ baseUrl: "http://h", apiKey: "k" })).toEqual(["ok", "direct"]);
  });

  it("dedupes ids and skips invalid entries", async () => {
    const provider = new HttpModelListProvider(
      fakeHttp(jsonResponse(200, { data: [{ id: "a" }, { id: "a" }, { foo: 1 }, { id: "" }, { id: "  " }] })),
    );
    expect(await provider.fetchModels({ baseUrl: "http://h", apiKey: "k" })).toEqual(["a"]);
  });

  it("throws on a non-2xx response", async () => {
    const provider = new HttpModelListProvider(fakeHttp(jsonResponse(401, { error: "nope" })));
    await expect(provider.fetchModels({ baseUrl: "http://h", apiKey: "k" })).rejects.toThrow("HTTP 401");
  });

  it("aborts a hanging host model fetch after HOST_MODEL_TIMEOUT_MS (panel never blocks forever)", async () => {
    vi.useFakeTimers();
    try {
      // get() never resolves on its own; it only rejects when the signal aborts.
      const get = vi.fn((_url: string, _h: Record<string, string>, signal?: AbortSignal) =>
        new Promise((_res, rej) => {
          signal?.addEventListener("abort", () => rej(new Error("aborted")));
        }),
      );
      const provider = new HttpModelListProvider({ post: vi.fn(), get });
      const p = provider.fetchModels({ baseUrl: "http://dead-host", apiKey: "k" });
      // attach the rejection handler synchronously so the abort rejects cleanly
      const assertion = expect(p).rejects.toThrow("aborted");
      await vi.advanceTimersByTimeAsync(5000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});