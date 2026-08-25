import { describe, it, expect } from "vitest";
import { OpenAIChatProvider } from "./openai-chat-provider";
import { FakeHttpClient, sseResponse } from "./http-client.test-utils";
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
  contextFiles: true,
  autoApprove: false,
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
    ]);
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

  it("sends reasoning_effort in effort mode and omits it when off", async () => {
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

    const off = new OpenAIChatProvider(
      { ...config, thinkingMode: "effort", thinkingLevel: "off" },
      http,
      tools,
    );
    await collect(off.stream([{ role: "user", content: "x" }]));
    body = JSON.parse(http.requests[1].body);
    expect(body.reasoning_effort).toBeUndefined();
  });

  it("sends nothing when thinkingMode is none", async () => {
    const http = new FakeHttpClient();
    http.respondWith(sseResponse("data: [DONE]"));

    const provider = new OpenAIChatProvider(
      { ...config, thinkingMode: "none", thinkingLevel: "low" },
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
    expect(usage).toEqual({ type: "usage", usage: { input: 100, output: 20, total: 120, cached: 0 } });
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
    expect(usage).toEqual({ type: "usage", usage: { input: 100, output: 20, total: 120, cached: 70 } });
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
