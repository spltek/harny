/**
 * Context-overflow detection, as CROSS-PROVIDER as it can be made.
 *
 * Harny speaks one protocol (OpenAI Chat Completions) to many backends: OpenAI,
 * Azure, OpenRouter, DeepSeek, Groq, Together, Mistral, Fireworks, llama.cpp,
 * vLLM, LM Studio, Ollama, and gateways in front of Anthropic/Gemini models. They
 * all reject an oversized input with a 4xx whose TEXT differs; there is no
 * standard error code for it. So detection has two independent legs:
 *
 *  1. the signatures below, one per family (each commented with where it comes
 *     from) — the leg that works when the wording is known;
 *  2. a provider-INDEPENDENT one, evaluated by the caller: our own estimate of the
 *     request says it was at/over the usable budget. A rejection we cannot read is
 *     still almost certainly about size when the request we sent was already
 *     filling the window, and acting on it costs one compaction at worst.
 *
 * The predicate is deliberately conservative on leg 1: matching something that is
 * NOT an overflow would compact a healthy session for nothing. Output-limit
 * errors (max_tokens too large, finish_reason=length) are excluded on purpose —
 * shrinking the INPUT does not help those, and the request clamp handles them.
 */

/** Statuses whose body can carry an overflow: the request was rejected. */
const REJECTION_STATUSES = new Set([400, 413, 422]);

/** The error's text, whatever shape the error arrived in. */
function errorText(err: unknown): string {
  if (typeof err === "string") return err;
  if (err && typeof err === "object") {
    const e = err as { message?: unknown; body?: unknown; response?: unknown };
    const parts = [e.message, e.body, e.response].map((p) => (typeof p === "string" ? p : p ? JSON.stringify(p) : ""));
    return parts.filter(Boolean).join(" ");
  }
  return String(err ?? "");
}

/**
 * The provider's HTTP status, when the text carries one. The OpenAI-compatible
 * provider wraps every rejection as `OpenAI API error <status>: <body>`, and other
 * layers report `HTTP <status>` / `status: <n>`; when nothing is parseable the
 * answer is undefined and only the signatures decide.
 */
export function providerErrorStatus(err: unknown): number | undefined {
  const text = errorText(err);
  const m = /(?:OpenAI API error|HTTP|status[":\s]+)\s*(\d{3})/i.exec(text);
  if (!m) return undefined;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : undefined;
}

/** True when the error is a REJECTION (as opposed to a network/timeout failure). */
export function isRequestRejection(err: unknown): boolean {
  const status = providerErrorStatus(err);
  return status !== undefined && REJECTION_STATUSES.has(status);
}

/**
 * One signature per provider/gateway family. The `from` label is used in the dev
 * log, so a new backend that phrases it differently is easy to add.
 */
export const OVERFLOW_SIGNATURES: Array<{ re: RegExp; from: string }> = [
  // OpenAI / Azure OpenAI: {"code":"context_length_exceeded"}
  { re: /context_length_exceeded/i, from: "OpenAI error code" },
  // OpenAI, Azure, vLLM, Together, DeepSeek, Fireworks, OpenRouter passthrough:
  // "This model's maximum context length is 128000 tokens. However, your messages
  //  resulted in 130000 tokens."
  { re: /maximum context length/i, from: "OpenAI-compatible" },
  // Groq, OpenRouter, llama.cpp server: "Please reduce the length of the messages."
  { re: /reduce the length of the (messages|conversation|prompt)/i, from: "Groq/OpenRouter/llama.cpp" },
  // Anthropic (direct or behind a gateway): "prompt is too long: 250000 tokens > 200000 maximum"
  { re: /prompt is too long/i, from: "Anthropic-style" },
  // Google Gemini: "The input token count (30500) exceeds the maximum number of tokens allowed (20480)."
  { re: /input token count .*exceeds/i, from: "Gemini" },
  { re: /exceeds the maximum number of tokens/i, from: "Gemini" },
  // llama.cpp: "the request exceeds the available context size" / "n_ctx"
  { re: /exceeds the available context size/i, from: "llama.cpp" },
  // Ollama: "input length exceeds the context length"
  { re: /input length exceeds the context/i, from: "Ollama" },
  // LM Studio / llama.cpp / generic local servers
  { re: /context (length|size|window) (is )?(exceeded|too (small|large))/i, from: "local servers" },
  { re: /exceeds? the (model'?s )?(context|maximum (model|sequence) length)/i, from: "generic" },
  // Mistral, Cohere, others: "Too many tokens" / "context length exceeded"
  { re: /too many tokens/i, from: "Mistral/Cohere" },
  // Generic phrasing that several gateways use in front of other models.
  { re: /(request|input|prompt) (is )?(too (large|long) for)/i, from: "generic gateway" },
];

/**
 * True when the error is a KNOWN context-overflow rejection. Callers that can
 * estimate their own request size should also treat a bare rejection as a
 * possible overflow (leg 2 above): this function only covers the wording.
 */
export function isContextOverflowError(err: unknown): boolean {
  const text = errorText(err);
  if (!text) return false;
  // A network/timeout failure is never an overflow, even if it mentions "context".
  if (providerErrorStatus(err) !== undefined && !isRequestRejection(err)) return false;
  return OVERFLOW_SIGNATURES.some((s) => s.re.test(text));
}

/** Which family's wording matched (for the dev log), or undefined. */
export function matchedOverflowSignature(err: unknown): string | undefined {
  const text = errorText(err);
  return OVERFLOW_SIGNATURES.find((s) => s.re.test(text))?.from;
}
