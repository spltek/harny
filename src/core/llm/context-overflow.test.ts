import { describe, it, expect } from "vitest";
import {
  isContextOverflowError,
  isRequestRejection,
  matchedOverflowSignature,
  overflowLimitFromError,
  MIN_PLAUSIBLE_LIMIT_TOKENS,
  providerErrorStatus,
} from "./context-overflow";

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
    message:
      'OpenAI API error 400: {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 250123 tokens > 200000 maximum"}}',
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
    message:
      'OpenAI API error 400: {"error":"Context length exceeded. Try increasing the context length in the model settings."}',
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
    message:
      'OpenAI API error 400: {"error":{"message":"This model\'s maximum context length is 65536 tokens. However, you requested 68000 tokens","type":"invalid_request_error","code":"context_length_exceeded"}}',
  },
];

describe("overflowLimitFromError — learn the real window from the rejection", () => {
  it("reads the limit from each family's wording", () => {
    const cases: Array<[string, number]> = [
      [
        "This model's maximum context length is 128000 tokens. However, your messages resulted in 132184 tokens.",
        128000,
      ],
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
    expect(
      overflowLimitFromError(
        new Error('OpenAI API error 400: {"error":{"message":"Invalid schema for function Shell"}}'),
      ),
    ).toBeUndefined();
    expect(overflowLimitFromError(new Error("fetch failed"))).toBeUndefined();
    expect(overflowLimitFromError(undefined)).toBeUndefined();
  });

  it("rejects a value too small to be a window (a stray number in the text)", () => {
    expect(overflowLimitFromError(new Error("maximum context length is 42 tokens"))).toBeUndefined();
    expect(MIN_PLAUSIBLE_LIMIT_TOKENS).toBeGreaterThanOrEqual(256);
  });

  it("survives a body that is not an object at all", () => {
    // `null` is what a provider SDK hands over when a rejection carries no body. It is NOT a
    // record: reading `.message` off it throws, and a guard that only asks "is it an object"
    // would turn a rejection into an exception in the recovery path.
    expect(overflowLimitFromError(null)).toBeUndefined();
    expect(isContextOverflowError(null)).toBe(false);
  });

  it("keeps the plausibility floor INCLUSIVE", () => {
    // 256 is the smallest value trusted as a window; 255 is still a stray number.
    const floor = MIN_PLAUSIBLE_LIMIT_TOKENS;
    expect(overflowLimitFromError(new Error(`maximum context length is ${floor} tokens`))).toBe(floor);
    expect(overflowLimitFromError(new Error(`maximum context length is ${floor - 1} tokens`))).toBeUndefined();
  });

  it("reuses the learned window instead of inventing one when the limit is absent", () => {
    // "Requested 40,000 tokens but the model only supports 32,768" — two numbers, and the
    // second one is the window. A regex that grabs the first would DOUBLE the budget.
    expect(overflowLimitFromError(new Error("Requested 40,000 tokens but the model only supports 32,768."))).toBe(
      32768,
    );
  });
});

/** Rejections that are NOT about size: compacting would be wasted work. */
const NOT_OVERFLOWS: Array<{ why: string; message: string }> = [
  {
    why: "output limit (shrinking the input does not help; the clamp handles it)",
    message:
      'OpenAI API error 400: {"error":{"message":"max_tokens is too large: 400000. This model supports at most 16384 completion tokens."}}',
  },
  {
    why: "invalid tool schema",
    message:
      'OpenAI API error 400: {"error":{"message":"Invalid schema for function \'Shell\': required is not of type array"}}',
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

  it("accepts a missing apostrophe in `model's`", () => {
    // Non-native gateways write "the models context length". The optional `'` is what keeps
    // the family recognised; without it the signature only matches the perfect spelling.
    expect(isContextOverflowError("This exceeds the models context length")).toBe(true);
  });

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

  it("a server failure that MENTIONS the context is still not an overflow", () => {
    // The status must win over the text. A 5xx is transient: it gets retried. Compacting
    // on it would shrink a healthy session AND hide the real failure behind a "recovered"
    // run. This is the one precedence rule the whole recovery rests on.
    const err = new Error("OpenAI API error 500: maximum context length is 128000 tokens");
    expect(providerErrorStatus(err)).toBe(500);
    expect(isRequestRejection(err)).toBe(false);
    expect(isContextOverflowError(err)).toBe(false);
  });

  it("names the family it matched (the label is what the dev log shows)", () => {
    const label = (m: string) => matchedOverflowSignature(new Error(m));
    expect(label("The input token count (30500) exceeds the maximum number of tokens allowed (20480).")).toBe("Gemini");
    // The SECOND Gemini phrasing, with no "input token count" in front of it.
    expect(label("The request exceeds the maximum number of tokens.")).toBe("Gemini");
    expect(label("Please reduce the length of the messages.")).toBe("Groq/OpenRouter/llama.cpp");
  });
});

/**
 * The dev log names the family that matched, so the label is part of the contract —
 * and asserting it is also what keeps the families apart. Several texts match more
 * than one pattern (OpenAI's own message matches two), the FIRST one wins by order,
 * and without a label assertion a whole signature could be deleted unnoticed.
 */
const LABELS: Array<[text: string, label: string]> = [
  ['{"error":{"code":"context_length_exceeded"}}', "OpenAI error code"],
  ["This endpoint's maximum context length is 200000 tokens", "OpenAI-compatible"],
  ["Please reduce the length of the conversation.", "Groq/OpenRouter/llama.cpp"],
  ["prompt is too long: 250123 tokens > 200000 maximum", "Anthropic-style"],
  // Gemini's first phrasing, WITHOUT the "exceeds the maximum number of tokens"
  // that the second signature would catch: this is the one that names the family.
  ["The input token count (9000) exceeds the limit.", "Gemini"],
  ["The request exceeds the maximum number of tokens.", "Gemini"],
  ["the request exceeds the available context size", "llama.cpp"],
  ["input length exceeds the context length", "Ollama"],
  ["Context window exceeded", "local servers"],
  // "exceed", not "exceeds": the singular is written by the older gateways.
  ["This would exceed the model's context length.", "generic"],
  // ... and with no possessive at all.
  ["This would exceed the context length.", "generic"],
  ["Too many tokens", "Mistral/Cohere"],
  ["input too long for this model", "generic gateway"],
];

describe("matchedOverflowSignature — one label per family", () => {
  for (const [text, label] of LABELS) {
    it(`calls it ${label}: ${text.slice(0, 48)}`, () => {
      expect(matchedOverflowSignature(new Error(text))).toBe(label);
      expect(isContextOverflowError(new Error(text))).toBe(true);
    });
  }
});

/**
 * The bodies are JSON produced by somebody else's serializer: pretty-printed ones
 * put a space before the colon, some wrap long strings, and a JSON string carries
 * its own newlines. None of that changes what the provider means.
 */
describe("providerErrorStatus — the status sits in differently formatted JSON", () => {
  it("reads it with and without the spaces a pretty-printer leaves", () => {
    expect(providerErrorStatus(new Error('{"status" : 400}'))).toBe(400);
    expect(providerErrorStatus(new Error('{"status":400}'))).toBe(400);
    expect(providerErrorStatus(new Error("OpenAI API error\n413: {…}"))).toBe(413);
  });
});

/**
 * Same story for the limit: the number arrives with a newline in front of it, with
 * the suffixed form the short messages use ("128k"), or with a space before the k.
 * Each of those is a different branch of the same expression, so each gets a case.
 */
describe("overflowLimitFromError — formatting, thousands and the 'k' suffix", () => {
  const cases: Array<[text: string, expected: number]> = [
    ["This model's maximum context length is 128k tokens", 128000],
    ["This model's maximum context length is 128 k tokens", 128000],
    ["the model only supports 32k", 32000],
    ["The engine's maximum model length is 8k", 8000],
    ["the limit is 4096 token", 4096],
    // Hand-written messages drop a space here and there, or put one where nobody
    // expects it ("128 k"). Each of these is a different quantifier in the pattern.
    ["The engine's maximum model length is 8 k", 8000],
    ["the model only supports 32 k", 32000],
    ["context length exceeded:135000>128000", 128000],
    ["context length exceeded: 135000 > 128 k", 128000],
    ["prompt is too long: 250123 tokens>200000 maximum", 200000],
    ["prompt is too long: 250123 tokens > 200 k maximum", 200000],
    ["context length exceeded:  135000 >\n  128000", 128000],
    ["prompt is too long: 250123 tokens  >  200000 maximum", 200000],
  ];
  for (const [text, expected] of cases) {
    it(`reads ${JSON.stringify(text).slice(0, 60)}`, () => {
      expect(overflowLimitFromError(new Error(text))).toBe(expected);
    });
  }

  it("joins the parts of a wrapped error WITH a separator", () => {
    // A provider that puts the sentence in `message` and the number in `body` is a
    // real shape (the SDK builds them separately). Joined without a space, "is" and
    // "200000" become one word and the limit is lost.
    expect(
      overflowLimitFromError({ message: "This endpoint's maximum context length is", body: "200000 tokens" }),
    ).toBe(200000);
  });

  it("reads a body that was serialised without spaces", () => {
    // Providers re-emit the rejection as compact JSON: `250000tokens>200000maximum`. Every `\s*`
    // in the Anthropic pattern exists for exactly this shape — the spaces are optional, not dropped.
    expect(overflowLimitFromError(new Error("prompt is too long: 250000tokens>200000maximum"))).toBe(200000);
    // The same compacting drops the space before `tokens` in the catch-all family.
    expect(overflowLimitFromError(new Error("the limit is 4096tokens"))).toBe(4096);
  });

  it("reads the singular `token` in the Anthropic comparison", () => {
    // The `s?` is there because gateways rewrite the sentence: `250000 token > 200000 maximum`.
    // Without it the whole family falls through and the limit is lost.
    expect(overflowLimitFromError(new Error("prompt is too long: 250000 token > 200000 maximum"))).toBe(200000);
  });

  it("keeps the space before 'k' in the generic 'limit is N tokens' family", () => {
    // The last pattern is the catch-all: `limit is 32 k tokens`. Its capture must tolerate the
    // detached suffix the way every other family does.
    expect(overflowLimitFromError(new Error("the limit is 32 k tokens"))).toBe(32000);
  });

  it("keeps the SPACE before the 'k' in a Gemini-style limit", () => {
    // Every other pattern tolerates `32 k`; this one used to accept only non-space characters
    // between the number and the suffix, so `32 k` was read as "no limit".
    expect(overflowLimitFromError(new Error("maximum number of tokens allowed (32 k)"))).toBe(32000);
  });

  it("does NOT mistake a 413 body for a window", () => {
    // Nothing here is a number the provider calls a maximum: the guess would come
    // from "431" (a status) or "200000" (our own message length).
    expect(overflowLimitFromError(new Error("OpenAI API error 413: payload 200000 bytes"))).toBeUndefined();
  });

  it("refuses a number too large to be a count", () => {
    // `Number("9".repeat(400))` is Infinity: finite-ness is what keeps it out, and
    // the plausibility floor alone would wave it through.
    const absurd = `maximum context length is ${"9".repeat(400)} tokens`;
    expect(overflowLimitFromError(new Error(absurd))).toBeUndefined();
  });
});
