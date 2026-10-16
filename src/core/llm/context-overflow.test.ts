import { describe, it, expect } from "vitest";
import { isContextOverflowError, isRequestRejection, matchedOverflowSignature, overflowLimitFromError, MIN_PLAUSIBLE_LIMIT_TOKENS, providerErrorStatus } from "./context-overflow";

/**
 * The REAL rejection texts of the backends Harny talks to, pasted as they arrive
 * through the OpenAI-compatible provider (which wraps them as
 * `OpenAI API error <status>: <body>`). This is the cross-provider contract: one
 * case per family, so a backend that changes its wording is caught here.
 */
const OVERFLOWS: Array<{ from: string; message: string }> = [
  {
    from: "OpenAI",
    message:
      'OpenAI API error 400: {"error":{"message":"This model\'s maximum context length is 128000 tokens. ' +
      'However, your messages resulted in 132184 tokens. Please reduce the length of the messages.","type":' +
      '"invalid_request_error","param":"messages","code":"context_length_exceeded"}}',
  },
  {
    from: "Azure OpenAI (same shape, deployment in the text)",
    message:
      'OpenAI API error 400: {"error":{"code":"context_length_exceeded","message":"This model\'s maximum context ' +
      'length is 16384 tokens. However, your messages resulted in 17001 tokens."}}',
  },
  {
    from: "OpenRouter passthrough (upstream phrasing)",
    message:
      'OpenAI API error 400: {"error":{"message":"This endpoint\'s maximum context length is 200000 tokens. ' +
      'However, your messages resulted in 260012 tokens.","code":400}}',
  },
  {
    from: "Groq",
    message:
      'OpenAI API error 400: {"error":{"message":"Please reduce the length of the messages. Requested 40,000 ' +
      'tokens but the model only supports 32,768.","type":"invalid_request_error"}}',
  },
  {
    from: "vLLM",
    message:
      'OpenAI API error 400: {"object":"error","message":"This model\'s maximum context length is 8192 tokens. ' +
      'However, you requested 9000 tokens (8999 in the messages, 1 in the completion).","type":"BadRequestError"}',
  },
  {
    from: "llama.cpp server",
    message: 'OpenAI API error 400: {"error":{"message":"the request exceeds the available context size. n_ctx=4096"}}',
  },
  {
    from: "Ollama",
    message: 'OpenAI API error 400: {"error":{"message":"input length exceeds the context length"}}',
  },
  {
    from: "Anthropic behind a gateway",
    message: 'OpenAI API error 400: {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 250123 tokens > 200000 maximum"}}',
  },
  {
    from: "Gemini behind a gateway",
    message:
      'OpenAI API error 400: {"error":{"code":400,"message":"The input token count (30500) exceeds the maximum ' +
      'number of tokens allowed (20480).","status":"INVALID_ARGUMENT"}}',
  },
  {
    from: "Mistral",
    message: 'OpenAI API error 400: {"message":"Too many tokens","type":"invalid_request_error"}',
  },
  {
    from: "LM Studio",
    message: 'OpenAI API error 400: {"error":"Context length exceeded. Try increasing the context length in the model settings."}',
  },
  {
    from: "payload size (413, some gateways)",
    message: 'OpenAI API error 413: {"error":{"message":"Request is too large for this model"}}',
  },
  {
    from: "Cohere-compatible gateway",
    message: 'OpenAI API error 400: {"message":"context length exceeded: 135000 > 128000"}',
  },
  {
    from: "DeepSeek",
    message: 'OpenAI API error 400: {"error":{"message":"This model\'s maximum context length is 65536 tokens. However, you requested 68000 tokens","type":"invalid_request_error","code":"context_length_exceeded"}}',
  },
];

describe("overflowLimitFromError — learn the real window from the rejection", () => {
  it("reads the limit from each family's wording", () => {
    const cases: Array<[string, number]> = [
      ["This model's maximum context length is 128000 tokens. However, your messages resulted in 132184 tokens.", 128000],
      ["this model's maximum context length is 16384 tokens", 16384],
      ["This endpoint's maximum context length is 200000 tokens.", 200000],
      ["the request exceeds the available context size. n_ctx=4096", 4096],
      ["The input token count (30500) exceeds the maximum number of tokens allowed (20480).", 20480],
      ["The engine's maximum model length is 8192", 8192],
      ["Requested 40,000 tokens but the model only supports 32,768.", 32768],
      ["context length exceeded: 135000 > 128000", 128000],
      ["prompt is too long: 250123 tokens > 200000 maximum", 200000],
      ["the maximum context is 128k tokens", 128000],
    ];
    for (const [text, expected] of cases) {
      expect(overflowLimitFromError(new Error(text)), text).toBe(expected);
    }
  });

  it("never mistakes the REQUESTED size for the limit", () => {
    // The dangerous mistake would be adopting 250123 (what we sent) as the window:
    // that would raise the budget and cause the very rejection we are recovering from.
    expect(overflowLimitFromError(new Error("prompt is too long: 250123 tokens > 200000 maximum"))).toBe(200000);
    expect(overflowLimitFromError(new Error("context length exceeded: 135000 > 128000"))).toBe(128000);
    expect(overflowLimitFromError(new Error("Requested 40,000 tokens but the model only supports 32,768"))).toBe(32768);
  });

  it("says nothing when the message states no limit", () => {
    expect(overflowLimitFromError(new Error("Please reduce the length of the messages."))).toBeUndefined();
    expect(overflowLimitFromError(new Error('OpenAI API error 400: {"error":{"message":"Invalid schema for function Shell"}}'))).toBeUndefined();
    expect(overflowLimitFromError(new Error("fetch failed"))).toBeUndefined();
    expect(overflowLimitFromError(undefined)).toBeUndefined();
  });

  it("rejects a value too small to be a window (a stray number in the text)", () => {
    expect(overflowLimitFromError(new Error("maximum context length is 42 tokens"))).toBeUndefined();
    expect(MIN_PLAUSIBLE_LIMIT_TOKENS).toBeGreaterThanOrEqual(256);
  });
});

/** Rejections that are NOT about size: compacting would be wasted work. */
const NOT_OVERFLOWS: Array<{ why: string; message: string }> = [
  {
    why: "output limit (shrinking the input does not help; the clamp handles it)",
    message: 'OpenAI API error 400: {"error":{"message":"max_tokens is too large: 400000. This model supports at most 16384 completion tokens."}}',
  },
  {
    why: "invalid tool schema",
    message: 'OpenAI API error 400: {"error":{"message":"Invalid schema for function \'Shell\': required is not of type array"}}',
  },
  {
    why: "rate limit with the word tokens in it",
    message: 'OpenAI API error 429: {"error":{"message":"Rate limit reached for tokens per minute"}}',
  },
  {
    why: "auth",
    message: 'OpenAI API error 401: {"error":{"message":"Incorrect API key provided"}}',
  },
  {
    why: "server error",
    message: 'OpenAI API error 503: {"error":{"message":"The engine is overloaded"}}',
  },
  {
    why: "a network failure that happens to mention context",
    message: "fetch failed: context deadline exceeded",
  },
];

describe("isContextOverflowError — cross-provider signatures", () => {
  for (const c of OVERFLOWS) {
    it(`recognises the ${c.from} rejection`, () => {
      expect(isContextOverflowError(new Error(c.message))).toBe(true);
      expect(matchedOverflowSignature(new Error(c.message))).toBeTruthy();
    });
  }

  for (const c of NOT_OVERFLOWS) {
    it(`does NOT treat ${c.why} as an overflow`, () => {
      expect(isContextOverflowError(new Error(c.message))).toBe(false);
    });
  }
});

describe("isRequestRejection / providerErrorStatus — the status leg", () => {
  it("reads the status the provider wrapper embeds", () => {
    expect(providerErrorStatus(new Error("OpenAI API error 413: {…}"))).toBe(413);
    expect(providerErrorStatus(new Error("HTTP 400 Bad Request"))).toBe(400);
    expect(providerErrorStatus(new Error('{"status": 422, "message":"…"}'))).toBe(422);
    expect(providerErrorStatus(new Error("fetch failed"))).toBeUndefined();
  });

  it("separates a REJECTION from a network/limit failure", () => {
    expect(isRequestRejection(new Error("OpenAI API error 400: {}"))).toBe(true);
    expect(isRequestRejection(new Error("OpenAI API error 413: {}"))).toBe(true);
    expect(isRequestRejection(new Error("OpenAI API error 429: {}"))).toBe(false); // retried as transient
    expect(isRequestRejection(new Error("OpenAI API error 503: {}"))).toBe(false);
    expect(isRequestRejection(new Error("fetch failed"))).toBe(false);
  });

  it("works on plain strings and on wrapped error objects, not just Error", () => {
    expect(isContextOverflowError("OpenAI API error 400: maximum context length is 128000")).toBe(true);
    expect(isContextOverflowError({ message: "prompt is too long: 250000 > 200000" })).toBe(true);
    expect(isContextOverflowError({ response: { error: { message: "Too many tokens" } } })).toBe(true);
    expect(isContextOverflowError(undefined)).toBe(false);
    expect(isContextOverflowError(new Error(""))).toBe(false);
  });
});
