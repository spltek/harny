import { describe, it, expect } from "vitest";
import { OpenAIChatProvider, describeApiError } from "./openai-chat-provider";
import { FakeHttpClient, sseResponse } from "./http-client.test-utils";
import type { HttpResponse } from "./http-client";
import type { HarnyConfig } from "../config/types";
import type { ToolDefinition } from "../tools/tool";
import type { StreamChunk } from "./types";

const config: HarnyConfig = {
  provider: "openai",
  apiKey: "sk-test",
  baseUrl: "https://api.openai.com",
  model: "gpt-4o",
  maxTokens: 4096,
  temperature: 0.1,
  autoOpen: false,
};

const tools: ToolDefinition[] = [
  { name: "Read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
];

async function collect(gen: AsyncGenerator<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = [];
  for await (const c of gen) out.push(c);
  return out;
}

describe("OpenAIChatProvider", () => {
  it("posts to the chat completions endpoint with auth headers and tools", async () => {
    const http = new FakeHttpClient();
    http.respondWith(sseResponse('data: {"choices":[{"delta":{"content":"hi"}}]}', "data: [DONE]"));

    const provider = new OpenAIChatProvider(config, http, tools);
    await collect(provider.stream([{ role: "user", content: "hello" }]));

    expect(http.requests).toHaveLength(1);
    const req = http.requests[0];
    expect(req.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(req.headers.Authorization).toBe("Bearer sk-test");

    const body = JSON.parse(req.body);
    expect(body.model).toBe("gpt-4o");
    expect(body.stream).toBe(true);
    expect(body.tools).toHaveLength(1);
    expect(body.tools[0].function.name).toBe("Read");
    expect(body.tools[0].function.parameters.properties.path.type).toBe("string");
  });

  it("sends presence/frequency penalties only when explicitly set", async () => {
    // Explicit values -> sent.
    const http = new FakeHttpClient();
    http.respondWith(sseResponse("data: [DONE]"));
    const provider = new OpenAIChatProvider({ ...config, presencePenalty: 1.5, frequencyPenalty: 0.5 }, http, tools);
    await collect(provider.stream([{ role: "user", content: "hi" }]));
    const body = JSON.parse(http.requests[0].body);
    expect(body.presence_penalty).toBe(1.5);
    expect(body.frequency_penalty).toBe(0.5);

    // Auto (unset) -> the fields are omitted entirely.
    const http2 = new FakeHttpClient();
    http2.respondWith(sseResponse("data: [DONE]"));
    const provider2 = new OpenAIChatProvider(config, http2, tools);
    await collect(provider2.stream([{ role: "user", content: "hi" }]));
    const body2 = JSON.parse(http2.requests[0].body);
    expect(body2.presence_penalty).toBeUndefined();
    expect(body2.frequency_penalty).toBeUndefined();
  });

  it("sends top_p only when explicitly set (probability threshold 0-1)", async () => {
    const http = new FakeHttpClient();
    http.respondWith(sseResponse("data: [DONE]"));
    const provider = new OpenAIChatProvider({ ...config, topP: 0.9 }, http, tools);
    await collect(provider.stream([{ role: "user", content: "hi" }]));
    expect(JSON.parse(http.requests[0].body).top_p).toBe(0.9);

    const http2 = new FakeHttpClient();
    http2.respondWith(sseResponse("data: [DONE]"));
    const provider2 = new OpenAIChatProvider(config, http2, tools);
    await collect(provider2.stream([{ role: "user", content: "hi" }]));
    expect(JSON.parse(http2.requests[0].body).top_p).toBeUndefined();
  });

  it("sends temperature only when explicitly set, and 0 stays valid", async () => {
    // Explicit 0.7 -> sent.
    const http = new FakeHttpClient();
    http.respondWith(sseResponse("data: [DONE]"));
    const provider = new OpenAIChatProvider({ ...config, temperature: 0.7 }, http, tools);
    await collect(provider.stream([{ role: "user", content: "hi" }]));
    expect(JSON.parse(http.requests[0].body).temperature).toBe(0.7);

    // Explicit 0 (deterministic) -> sent as 0, NOT dropped as falsy.
    const http2 = new FakeHttpClient();
    http2.respondWith(sseResponse("data: [DONE]"));
    const provider2 = new OpenAIChatProvider({ ...config, temperature: 0 }, http2, tools);
    await collect(provider2.stream([{ role: "user", content: "hi" }]));
    expect(JSON.parse(http2.requests[0].body).temperature).toBe(0);

    // Unset / Auto -> the field is omitted entirely (strict providers ok).
    const http3 = new FakeHttpClient();
    http3.respondWith(sseResponse("data: [DONE]"));
    const base = { ...config };
    delete base.temperature;
    const provider3 = new OpenAIChatProvider(base, http3, tools);
    await collect(provider3.stream([{ role: "user", content: "hi" }]));
    expect(JSON.parse(http3.requests[0].body).temperature).toBeUndefined();
  });

  it("yields text deltas from SSE content", async () => {
    const http = new FakeHttpClient();
    http.respondWith(
      sseResponse(
        'data: {"choices":[{"delta":{"content":"Hel"}}]}',
        'data: {"choices":[{"delta":{"content":"lo"}}]}',
        "data: [DONE]",
      ),
    );

    const provider = new OpenAIChatProvider(config, http, tools);
    const chunks = await collect(provider.stream([{ role: "user", content: "x" }]));

    expect(chunks.filter((c) => c.type === "text")).toEqual([
      { type: "text", content: "Hel" },
      { type: "text", content: "lo" },
    ]);
  });

  it("accumulates tool call streams into start/delta/end chunks", async () => {
    const http = new FakeHttpClient();
    http.respondWith(
      sseResponse(
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"Read","arguments":""}}]}}]}',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"path\\":\\"/tmp"}}]}}]}',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"/a.txt\\"}"}}]}}]}',
        'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
        "data: [DONE]",
      ),
    );

    const provider = new OpenAIChatProvider(config, http, tools);
    const chunks = await collect(provider.stream([{ role: "user", content: "x" }]));

    expect(chunks).toEqual([
      { type: "tool_call_start", index: 0, id: "call_1", name: "Read" },
      { type: "tool_call_delta", index: 0, delta: '{"path":"/tmp' },
      { type: "tool_call_delta", index: 0, delta: '/a.txt"}' },
      { type: "tool_call_end", index: 0 },
      { type: "finish", reason: "tool_calls" },
    ]);
  });

  it("includes tool call arguments sent as a single delta", async () => {
    const http = new FakeHttpClient();
    http.respondWith(
      sseResponse(
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"Read","arguments":"{\\"path\\":\\"/x\\"}"}}]}}]}',
        'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
        "data: [DONE]",
      ),
    );

    const provider = new OpenAIChatProvider(config, http, tools);
    const chunks = await collect(provider.stream([{ role: "user", content: "x" }]));

    expect(chunks).toEqual([
      { type: "tool_call_start", index: 0, id: "c1", name: "Read" },
      { type: "tool_call_delta", index: 0, delta: '{"path":"/x"}' },
      { type: "tool_call_end", index: 0 },
      { type: "finish", reason: "tool_calls" },
    ]);
  });

  it("surfaces a length finish_reason (output-token limit)", async () => {
    const http = new FakeHttpClient();
    http.respondWith(
      sseResponse(
        'data: {"choices":[{"delta":{"content":"partial"}}]}',
        'data: {"choices":[{"delta":{},"finish_reason":"length"}]}',
        "data: [DONE]",
      ),
    );

    const provider = new OpenAIChatProvider(config, http, tools);
    const chunks = await collect(provider.stream([{ role: "user", content: "x" }]));

    expect(chunks).toContainEqual({ type: "finish", reason: "length" });
  });

  it("does not duplicate /v1 when the base URL already includes it", async () => {
    const http = new FakeHttpClient();
    http.respondWith(sseResponse("data: [DONE]"));

    const provider = new OpenAIChatProvider({ ...config, baseUrl: "http://localhost:8090/v1" }, http, tools);
    await collect(provider.stream([{ role: "user", content: "x" }]));

    expect(http.requests[0].url).toBe("http://localhost:8090/v1/chat/completions");
  });

  it("omits the Authorization header when no API key is set (local models)", async () => {
    const http = new FakeHttpClient();
    http.respondWith(sseResponse("data: [DONE]"));

    const provider = new OpenAIChatProvider({ ...config, apiKey: "" }, http, tools);
    await collect(provider.stream([{ role: "user", content: "x" }]));

    const req = http.requests[0];
    expect(req.headers.Authorization).toBeUndefined();
  });

  it("identifies itself, sends static extra headers and the per-conversation session header", async () => {
    const http = new FakeHttpClient();
    http.respondWith(sseResponse("data: [DONE]"));
    // OpenCode Go-style configuration: a stable per-conversation id routed
    // through x-opencode-session + a declared static header.
    const provider = new OpenAIChatProvider(
      {
        ...config,
        sessionId: "harny-session-42",
        sessionHeader: "x-opencode-session",
        extraHeaders: { "X-Origin": "harny" },
      },
      http,
      tools,
    );
    await collect(provider.stream([{ role: "user", content: "x" }]));
    const headers = http.requests[0].headers;
    expect(headers["User-Agent"]).toContain("Harny");
    expect(headers["x-opencode-session"]).toBe("harny-session-42");
    expect(headers["X-Origin"]).toBe("harny");
  });

  it("never sends the session header without a declared header name or session id", async () => {
    const http = new FakeHttpClient();
    http.respondWith(sseResponse("data: [DONE]"), sseResponse("data: [DONE]"));
    // sessionHeader declared but no id (session not wired up yet).
    const a = new OpenAIChatProvider({ ...config, sessionHeader: "x-opencode-session" }, http, tools);
    await collect(a.stream([{ role: "user", content: "x" }]));
    expect(http.requests[0].headers["x-opencode-session"]).toBeUndefined();
    // id present but no header declared.
    const b = new OpenAIChatProvider({ ...config, sessionId: "s1" }, http, tools);
    await collect(b.stream([{ role: "user", content: "x" }]));
    expect(Object.keys(http.requests[1].headers).some((k) => k.toLowerCase().includes("session"))).toBe(
      false,
    );
  });

  it("throws a descriptive error on non-OK responses", async () => {
    const http = new FakeHttpClient();
    http.respondWith({
      ok: false,
      status: 401,
      headers: { get: () => null },
      text: async () => '{"error":"bad key"}',
      json: async () => ({}),
      body: null,
    });

    const provider = new OpenAIChatProvider(config, http, tools);
    await expect(collect(provider.stream([{ role: "user", content: "x" }]))).rejects.toThrow(
      "OpenAI API error 401",
    );
  });
});

describe("OpenAIChatProvider reasoning support", () => {
  it("sends chat_template_kwargs.enable_thinking when configured", async () => {
    const http = new FakeHttpClient();
    http.respondWith(sseResponse("data: [DONE]"));

    const provider = new OpenAIChatProvider({ ...config, enableThinking: false }, http, tools);
    await collect(provider.stream([{ role: "user", content: "x" }]));

    const body = JSON.parse(http.requests[0].body);
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
  });

  it("omits chat_template_kwargs when enableThinking is undefined", async () => {
    const http = new FakeHttpClient();
    http.respondWith(sseResponse("data: [DONE]"));

    const provider = new OpenAIChatProvider(config, http, tools);
    await collect(provider.stream([{ role: "user", content: "x" }]));

    const body = JSON.parse(http.requests[0].body);
    expect(body.chat_template_kwargs).toBeUndefined();
    expect(body.reasoning_effort).toBeUndefined();
  });

  it("maps thinkingLevel to enable_thinking + reasoning_effort in bool mode", async () => {
    const http = new FakeHttpClient();
    http.respondWith(sseResponse("data: [DONE]"));

    const provider = new OpenAIChatProvider(
      { ...config, thinkingMode: "bool", thinkingLevel: "high" },
      http,
      tools,
    );
    await collect(provider.stream([{ role: "user", content: "x" }]));

    const body = JSON.parse(http.requests[0].body);
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: true, reasoning_effort: "high" });
  });

  it("turns thinking off in bool mode", async () => {
    const http = new FakeHttpClient();
    http.respondWith(sseResponse("data: [DONE]"));

    const provider = new OpenAIChatProvider(
      { ...config, thinkingMode: "bool", thinkingLevel: "off" },
      http,
      tools,
    );
    await collect(provider.stream([{ role: "user", content: "x" }]));

    const body = JSON.parse(http.requests[0].body);
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(body.chat_template_kwargs.reasoning_effort).toBeUndefined();
  });

  it("sends reasoning_effort in effort mode; off omits the field", async () => {
    const http = new FakeHttpClient();
    http.respondWith(sseResponse("data: [DONE]"));
    http.respondWith(sseResponse("data: [DONE]"));

    const on = new OpenAIChatProvider(
      { ...config, thinkingMode: "effort", thinkingLevel: "medium" },
      http,
      tools,
    );
    await collect(on.stream([{ role: "user", content: "x" }]));
    let body = JSON.parse(http.requests[0].body);
    expect(body.reasoning_effort).toBe("medium");
    expect(body.chat_template_kwargs).toBeUndefined();

    // "off" OMITS the field: any effort (even "minimal") turns reasoning ON
    // for models whose default is off (DeepSeek v4 on OpenRouter).
    const off = new OpenAIChatProvider(
      { ...config, thinkingMode: "effort", thinkingLevel: "off" },
      http,
      tools,
    );
    await collect(off.stream([{ role: "user", content: "x" }]));
    body = JSON.parse(http.requests[1].body);
    expect(body.reasoning_effort).toBeUndefined();
  });

  it("sends thinking.type in type mode (OpenCode Go / DeepSeek toggle)", async () => {
    const http = new FakeHttpClient();
    http.respondWith(sseResponse("data: [DONE]"));
    http.respondWith(sseResponse("data: [DONE]"));
    http.respondWith(sseResponse("data: [DONE]"));

    const high = new OpenAIChatProvider(
      { ...config, thinkingMode: "type", thinkingLevel: "high" },
      http,
      tools,
    );
    await collect(high.stream([{ role: "user", content: "x" }]));
    let body = JSON.parse(http.requests[0].body);
    expect(body.thinking).toEqual({ type: "enabled" });
    expect(body.reasoning_effort).toBeUndefined();

    const off = new OpenAIChatProvider(
      { ...config, thinkingMode: "type", thinkingLevel: "off" },
      http,
      tools,
    );
    await collect(off.stream([{ role: "user", content: "x" }]));
    body = JSON.parse(http.requests[1].body);
    expect(body.thinking).toEqual({ type: "disabled" });

    // Auto (no explicit level) -> nothing sent, model default only.
    const auto = new OpenAIChatProvider({ ...config, thinkingMode: "type" }, http, tools);
    await collect(auto.stream([{ role: "user", content: "x" }]));
    body = JSON.parse(http.requests[2].body);
    expect(body.thinking).toBeUndefined();
  });

  it("sends the OpenRouter reasoning object in reasoning mode", async () => {
    const http = new FakeHttpClient();
    http.respondWith(sseResponse("data: [DONE]"));
    http.respondWith(sseResponse("data: [DONE]"));
    http.respondWith(sseResponse("data: [DONE]"));

    const high = new OpenAIChatProvider(
      { ...config, thinkingMode: "reasoning", thinkingLevel: "high" },
      http,
      tools,
    );
    await collect(high.stream([{ role: "user", content: "x" }]));
    let body = JSON.parse(http.requests[0].body);
    expect(body.reasoning).toEqual({ effort: "high" });
    expect(body.reasoning_effort).toBeUndefined();

    // off -> enabled:false (the reliable disable for DeepSeek-on-OpenRouter).
    const off = new OpenAIChatProvider(
      { ...config, thinkingMode: "reasoning", thinkingLevel: "off" },
      http,
      tools,
    );
    await collect(off.stream([{ role: "user", content: "x" }]));
    body = JSON.parse(http.requests[1].body);
    expect(body.reasoning).toEqual({ enabled: false });

    const auto = new OpenAIChatProvider({ ...config, thinkingMode: "reasoning" }, http, tools);
    await collect(auto.stream([{ role: "user", content: "x" }]));
    body = JSON.parse(http.requests[2].body);
    expect(body.reasoning).toBeUndefined();
  });

  it("sends nothing when thinkingMode is unspecified", async () => {
    const http = new FakeHttpClient();
    http.respondWith(sseResponse("data: [DONE]"));

    const provider = new OpenAIChatProvider(
      { ...config, thinkingMode: "unspecified", thinkingLevel: "low" },
      http,
      tools,
    );
    await collect(provider.stream([{ role: "user", content: "x" }]));

    const body = JSON.parse(http.requests[0].body);
    expect(body.chat_template_kwargs).toBeUndefined();
    expect(body.reasoning_effort).toBeUndefined();
  });

  it("surfaces reasoning_content as thinking type", async () => {
    const http = new FakeHttpClient();
    http.respondWith(
      sseResponse(
        'data: {"choices":[{"delta":{"reasoning_content":"let me think"}}]}',
        'data: {"choices":[{"delta":{"content":"42"}}]}',
        "data: [DONE]",
      ),
    );

    const provider = new OpenAIChatProvider(config, http, tools);
    const chunks = await collect(provider.stream([{ role: "user", content: "x" }]));

    expect(chunks).toEqual([
      { type: "thinking", content: "let me think" },
      { type: "text", content: "42" },
    ]);
  });

  it("reads OpenRouter's `reasoning` field as thinking", async () => {
    const http = new FakeHttpClient();
    http.respondWith(
      sseResponse(
        'data: {"choices":[{"delta":{"reasoning":"thinking via openrouter"}}]}',
        'data: {"choices":[{"delta":{"content":"ok"}}]}',
        "data: [DONE]",
      ),
    );

    const provider = new OpenAIChatProvider(config, http, tools);
    const chunks = await collect(provider.stream([{ role: "user", content: "x" }]));

    expect(chunks).toEqual([
      { type: "thinking", content: "thinking via openrouter" },
      { type: "text", content: "ok" },
    ]);
  });

  it("keeps thinking when a single delta carries both content and reasoning", async () => {
    const http = new FakeHttpClient();
    http.respondWith(
      sseResponse(
        'data: {"choices":[{"delta":{"content":"answer","reasoning":"why"}}]}',
        "data: [DONE]",
      ),
    );

    const provider = new OpenAIChatProvider(config, http, tools);
    const chunks = await collect(provider.stream([{ role: "user", content: "x" }]));

    expect(chunks).toEqual([
      { type: "text", content: "answer" },
      { type: "thinking", content: "why" },
    ]);
  });

  it("accumulates streamed reasoning_details and emits them pass-back-ready", async () => {
    const http = new FakeHttpClient();
    http.respondWith(
      sseResponse(
        'data: {"choices":[{"delta":{"reasoning_details":[{"type":"reasoning.summary","summary":"step ","format":"openai-responses-v1","index":0}]}}]}',
        'data: {"choices":[{"delta":{"reasoning_details":[{"type":"reasoning.summary","summary":"one","format":"openai-responses-v1","index":0}]}}]}',
        'data: {"choices":[{"delta":{"content":"ok"}}]}',
        "data: [DONE]",
      ),
    );

    const provider = new OpenAIChatProvider(config, http, tools);
    const chunks = await collect(provider.stream([{ role: "user", content: "x" }]));

    // The summary text is surfaced as thinking (no plaintext `reasoning` here).
    expect(chunks.filter((c) => c.type === "thinking")).toEqual([
      { type: "thinking", content: "step " },
      { type: "thinking", content: "one" },
    ]);
    // ...and the merged block is emitted for verbatim pass-back.
    expect(chunks.at(-1)).toEqual({
      type: "thinking_details",
      details: [
        { type: "reasoning.summary", summary: "step one", format: "openai-responses-v1", index: 0 },
      ],
    });
  });
});

describe("OpenAIChatProvider usage", () => {
  it("yields a usage chunk from the final include_usage line", async () => {
    const http = new FakeHttpClient();
    http.respondWith(
      sseResponse(
        'data: {"choices":[{"delta":{"content":"hi"}}]}',
        'data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":20,"total_tokens":120}}',
        "data: [DONE]",
      ),
    );
    const provider = new OpenAIChatProvider(config, http, tools);
    const chunks: StreamChunk[] = [];
    for await (const c of provider.stream([{ role: "user", content: "x" }])) chunks.push(c);

    const usage = chunks.find((c) => c.type === "usage");
    expect(usage).toEqual({ type: "usage", usage: { input: 100, output: 20, total: 120, cached: 0, cachedWrite: 0 } });
  });

  it("reports cached tokens without changing input", async () => {
    const http = new FakeHttpClient();
    http.respondWith(
      sseResponse(
        'data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":20,"total_tokens":120,"prompt_tokens_details":{"cached_tokens":70}}}',
      ),
    );
    const provider = new OpenAIChatProvider(config, http, tools);
    const chunks: StreamChunk[] = [];
    for await (const c of provider.stream([{ role: "user", content: "x" }])) chunks.push(c);
    const usage = chunks.find((c) => c.type === "usage");
    expect(usage).toEqual({ type: "usage", usage: { input: 100, output: 20, total: 120, cached: 70, cachedWrite: 0 } });
  });

  it("reports the cache WRITE side (OpenRouter / llama.cpp extension)", async () => {
    const http = new FakeHttpClient();
    http.respondWith(
      sseResponse(
        'data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":20,"total_tokens":120,"prompt_tokens_details":{"cached_tokens":10,"cache_write_tokens":55}}}',
      ),
    );
    const provider = new OpenAIChatProvider(config, http, tools);
    const chunks: StreamChunk[] = [];
    for await (const c of provider.stream([{ role: "user", content: "x" }])) chunks.push(c);
    const usage = chunks.find((c) => c.type === "usage");
    expect(usage).toEqual({ type: "usage", usage: { input: 100, output: 20, total: 120, cached: 10, cachedWrite: 55 } });
  });
});

describe("OpenAIChatProvider tools guard", () => {
  it("omits empty tools / tool_choice when no tool definitions", async () => {
    const http = new FakeHttpClient();
    http.respondWith(sseResponse("data: [DONE]"));
    const provider = new OpenAIChatProvider(config, http, []);
    await collect(provider.stream([{ role: "user", content: "x" }]));
    const body = JSON.parse(http.requests[0].body);
    expect(body.tools).toBeUndefined();
    expect(body.tool_choice).toBeUndefined();
  });

  it("includes tools and tool_choice when definitions exist", async () => {
    const http = new FakeHttpClient();
    http.respondWith(sseResponse("data: [DONE]"));
    const provider = new OpenAIChatProvider(config, http, tools);
    await collect(provider.stream([{ role: "user", content: "x" }]));
    const body = JSON.parse(http.requests[0].body);
    expect(Array.isArray(body.tools)).toBe(true);
    expect(body.tool_choice).toBe("auto");
  });
});


describe("OpenAIChatProvider temperature guard", () => {
  it("omits temperature when not configured", async () => {
    const http = new FakeHttpClient();
    http.respondWith(sseResponse("data: [DONE]"));
    const provider = new OpenAIChatProvider({ ...config, temperature: undefined }, http, tools);
    await collect(provider.stream([{ role: "user", content: "x" }]));
    const body = JSON.parse(http.requests[0].body);
    expect(body.temperature).toBeUndefined();
  });

  it("sends temperature when explicitly configured", async () => {
    const http = new FakeHttpClient();
    http.respondWith(sseResponse("data: [DONE]"));
    const provider = new OpenAIChatProvider({ ...config, temperature: 0.7 }, http, tools);
    await collect(provider.stream([{ role: "user", content: "x" }]));
    const body = JSON.parse(http.requests[0].body);
    expect(body.temperature).toBe(0.7);
  });
});

describe("OpenAIChatProvider — transient retry (rate limits)", () => {
  function errorResponse(status: number, retryAfter?: string): HttpResponse {
    const text = `{"error":"transient"}`;
    return {
      ok: false,
      status,
      headers: {
        get: (n: string) => (retryAfter !== undefined && n.toLowerCase() === "retry-after" ? retryAfter : null),
      },
      text: async () => text,
      json: async () => ({ error: "transient" }),
      body: null,
    };
  }

  it("retries a 429 (honoring Retry-After) and then succeeds", async () => {
    const http = new FakeHttpClient();
    http.respondWith(
      errorResponse(429, "0"),
      sseResponse('data: {"choices":[{"delta":{"content":"hi"}}]}', "data: [DONE]"),
    );
    const provider = new OpenAIChatProvider(config, http, tools);
    const chunks = await collect(provider.stream([{ role: "user", content: "hi" }]));
    expect(http.requests).toHaveLength(2); // first 429 + retry
    expect(chunks.some((c) => c.type === "text" && c.content === "hi")).toBe(true);
  });

  it("does NOT retry a non-transient error (400)", async () => {
    const http = new FakeHttpClient();
    http.respondWith(errorResponse(400));
    const provider = new OpenAIChatProvider(config, http, tools);
    await expect(collect(provider.stream([{ role: "user", content: "hi" }]))).rejects.toThrow(/400/);
    expect(http.requests).toHaveLength(1);
  });

  it("gives up after the max retries and throws the last status", async () => {
    const http = new FakeHttpClient();
    for (let i = 0; i < 5; i++) http.respondWith(errorResponse(503, "0"));
    const provider = new OpenAIChatProvider(config, http, tools);
    await expect(collect(provider.stream([{ role: "user", content: "hi" }]))).rejects.toThrow(/503/);
    expect(http.requests).toHaveLength(4); // 1 attempt + 3 retries
  });
});

describe("describeApiError", () => {
  it("explains a protocol mismatch instead of dumping the JSON body", () => {
    const body = JSON.stringify({
      type: "error",
      error: { type: "ModelProtocolUnsupported", message: "Model does not support this protocol." },
    });
    const msg = describeApiError(400, body);
    expect(msg).toContain("not served over OpenAI Chat Completions");
    expect(msg).toContain("Anthropic Messages");
    expect(msg).toContain("OpenRouter");
    expect(msg).not.toContain("ModelProtocolUnsupported");
  });

  it("keeps the plain message for any other error", () => {
    expect(describeApiError(401, "unauthorized")).toBe("OpenAI API error 401: unauthorized");
  });
});
