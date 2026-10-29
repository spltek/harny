import type { HarnyConfig, ThinkingMode } from "../config/types";
import type { ToolDefinition } from "../tools/tool";
import { endpointUrl } from "./endpoint";
import type { HttpClient, HttpResponse } from "./http-client";
import { sseLines } from "./sse";
import { toChatToolDefinitions, toOpenAIMessages } from "./message-converter";
import type { LLMMessage, LLMProvider, StreamChunk } from "./types";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Temp debug log path — cross-platform (never hardcode /tmp). */
const DEBUG_LOG_FILE = join(tmpdir(), "harny-debug.log");

/** Transient statuses worth retrying (rate limit / gateway / overload). */
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
/** Extra attempts AFTER the first (so up to 4 requests total). */
const MAX_POST_RETRIES = 3;

/**
 * Turn a raw provider error body into a clear message. A model that the host
 * serves over a DIFFERENT protocol (Anthropic Messages, OpenAI Responses, …) is
 * called out explicitly instead of dumping the JSON: harny speaks only OpenAI
 * Chat Completions.
 */
export function describeApiError(status: number, text: string): string {
  if (/ModelProtocolUnsupported|does not support this protocol/i.test(text)) {
    return (
      `This model is not served over OpenAI Chat Completions (HTTP ${status}): the provider exposes it through a ` +
      `different protocol (e.g. Anthropic Messages or OpenAI Responses). Pick a model that supports Chat ` +
      `Completions, or use a provider that exposes it that way (e.g. OpenRouter).`
    );
  }
  return `OpenAI API error ${status}: ${text}`;
}

function abortError(): Error {
  const e = new Error("Aborted");
  e.name = "AbortError";
  return e;
}

/**
 * Models that refused `max_tokens` and demand `max_completion_tokens`, keyed by
 * endpoint + model: the rule is learned from the provider's own answer ONCE, then
 * the field is right from the first request of every later turn (otherwise every
 * single turn would burn a rejected round trip first). A Set is enough — the rule
 * never goes back.
 */
const NEEDS_MAX_COMPLETION_TOKENS = new Set<string>();

/**
 * Dialects whose upstream REFUSES a follow-up request when a prior assistant message carries no
 * `reasoning_content` — `The reasoning_content in the thinking mode must be passed back to the
 * API`:
 *
 *  - `reasoning` — the DeepSeek-style echo, used by OpenRouter and by proxies of reasoning models;
 *  - `type` — the `thinking: {type}` toggle (DeepSeek v4, Qwen, Kimi, Anthropic behind an
 *    OpenAI-shaped gateway such as opencode zen/go). Turning thinking ON is enough to make the
 *    field MANDATORY from then on, for every assistant message of the session — including the
 *    ones that never reasoned (a turn from another model, Harny's synthetic state document, the
 *    forced final report) and an empty string is what satisfies it.
 *
 * `bool` (llama.cpp), `effort` (OpenAI) and `unspecified` are deliberately NOT included: an extra
 * field where the upstream does not expect it is the OPPOSITE 400.
 */
export function requiresReasoningPassBack(mode: ThinkingMode | undefined): boolean {
  return mode === "reasoning" || mode === "type";
}

/**
 * Whether `reasoning_content` has to be echoed on EVERY assistant message of this request.
 *
 * The requirement belongs to the UPSTREAM, not to our knob: the dialect tells us how thinking is
 * REQUESTED (`thinking: {type}`, `reasoning_effort`, `chat_template_kwargs`), while what the
 * upstream VALIDATES is the history. So there are two independent triggers:
 *
 *  - the dialect (`reasoning`, `type`) — see `requiresReasoningPassBack`;
 *  - the HISTORY — some assistant message carries PLAINTEXT reasoning (`thinking` without
 *    `reasoningDetails`), i.e. this very session has already received `reasoning_content` from
 *    this very upstream. From that moment the field is part of the contract, whatever the knob
 *    is set to: a `bool` provider that happens to talk to a DeepSeek-style model has the exact
 *    same rule.
 *
 * The history trigger deliberately IGNORES `reasoningDetails`: reasoning that came back encrypted
 * or summarized (OpenRouter, OpenAI o-series) is already passed back verbatim and unchanged, and
 * inventing a plaintext field there is the OPPOSITE 400. That is also why a provider that never
 * reasoned is left alone.
 */
export function needsReasoningEcho(mode: ThinkingMode | undefined, messages: readonly LLMMessage[]): boolean {
  if (requiresReasoningPassBack(mode)) return true;
  return messages.some(
    (m) => m.role === "assistant" && Boolean(m.thinking) && !(m.reasoningDetails && m.reasoningDetails.length > 0),
  );
}

/** Key for the learned quirk above (endpoint included: two backends can serve the
 * same model name under different rules). */
function completionTokensKey(baseUrl: string, model: string): string {
  return `${baseUrl}|${model}`;
}

/** Test seam: the cache is process-wide, so a suite must be able to clear it. */
export function resetMaxCompletionTokensCache(): void {
  NEEDS_MAX_COMPLETION_TOKENS.clear();
}

/**
 * True when the provider rejected the request ONLY because of the output-length
 * field's NAME — the signal being its own hint. Pure, so the rule is testable
 * without a server (see openai-chat-provider.test.ts).
 */
export function needsMaxCompletionTokens(status: number, text: string): boolean {
  if (status !== 400 && status !== 422) return false;
  if (!/max_completion_tokens/i.test(text)) return false;
  return /Unsupported parameter|not supported|use .*max_completion_tokens|unknown (parameter|field)|unrecognized/i.test(
    text,
  );
}

/** Sleep that rejects with an AbortError when the signal fires (Stop during backoff). */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Backoff for a retryable response: honor `Retry-After`, else exponential+jitter. */
function retryDelayMs(attempt: number, retryAfter: string | null): number {
  const seconds = retryAfter !== null ? Number(retryAfter) : NaN;
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 30_000);
  return Math.min(1000 * 2 ** attempt, 8000) + Math.floor(Math.random() * 250);
}

/**
 * OpenAI Chat Completions provider (POST /v1/chat/completions, SSE streaming).
 */
export class OpenAIChatProvider implements LLMProvider {
  constructor(
    private config: HarnyConfig,
    private http: HttpClient,
    private toolDefinitions: ToolDefinition[],
  ) {}

  async *stream(
    messages: LLMMessage[],
    signal?: AbortSignal,
    toolDefinitions?: ToolDefinition[],
  ): AsyncGenerator<StreamChunk> {
    const effectiveTools = toolDefinitions ?? this.toolDefinitions;
    const url = endpointUrl(this.config.baseUrl, "/chat/completions");
    // The thinking dialect in force for this session: config first, legacy boolean flag second.
    // Computed ONCE — the payload and the reasoning pass-back must agree about it.
    const thinkingMode =
      this.config.thinkingMode ?? (this.config.enableThinking !== undefined ? "bool" : "unspecified");

    const body: Record<string, unknown> = {
      model: this.config.model,
      messages: toOpenAIMessages(messages, {
        // Some upstreams refuse the NEXT request when a prior assistant message carries no
        // `reasoning_content` (see `needsReasoningEcho`: the dialect says so, or the history
        // proves this upstream already produced plaintext reasoning).
        alwaysPassBackReasoning: needsReasoningEcho(thinkingMode, messages),
      }),
      // The field name this model wants: learned from a rejection before, or
      // `max_tokens` (what every other backend expects) on the first try.
      ...(NEEDS_MAX_COMPLETION_TOKENS.has(completionTokensKey(this.config.baseUrl, this.config.model))
        ? { max_completion_tokens: this.config.maxTokens }
        : { max_tokens: this.config.maxTokens }),
      stream: true,
      stream_options: { include_usage: true },
    };
    // Only send temperature when explicitly configured (some opencode-go models
    // reject the parameter entirely, e.g. gpt-5.6-luna).
    if (typeof this.config.temperature === "number" && Number.isFinite(this.config.temperature)) {
      body.temperature = this.config.temperature;
    }
    // Same "only when set" rule for the two penalties — strict providers are
    // picky about extra sampling params.
    if (typeof this.config.presencePenalty === "number" && Number.isFinite(this.config.presencePenalty)) {
      body.presence_penalty = this.config.presencePenalty;
    }
    if (typeof this.config.frequencyPenalty === "number" && Number.isFinite(this.config.frequencyPenalty)) {
      body.frequency_penalty = this.config.frequencyPenalty;
    }
    // top_p follows the same "only when set" rule; the ACTIVE sampler is
    // enforced host-side (only the active one keeps a value in the config).
    if (typeof this.config.topP === "number" && Number.isFinite(this.config.topP)) {
      body.top_p = this.config.topP;
    }
    // Send tool definitions ONLY when there are any: an empty `tools` array with
    // `tool_choice` is rejected by strict providers (opencode-go/Console Go).
    if (effectiveTools.length > 0) {
      body.tools = toChatToolDefinitions(effectiveTools);
      body.tool_choice = "auto";
    }
    // Reasoning/thinking phase, generalized across providers.
    // "bool"   → llama.cpp-style chat_template_kwargs.enable_thinking (on/off)
    //            + the STANDARD OpenAI field reasoning_effort for the level,
    //            passed inside chat_template_kwargs for the model's Jinja template.
    // "effort" → OpenAI-style top-level reasoning_effort (low/medium/high)
    // "unspecified" → nothing is sent (provider default behavior)
    const mode = thinkingMode;
    if (mode === "bool") {
      if (this.config.thinkingLevel !== undefined) {
        // Level-based control (UI dropdown). `enable_thinking` is the llama.cpp
        // template toggle; the level uses the protocol name `reasoning_effort`
        // (low/medium/high) — templates that don't read it simply ignore it.
        const level = this.config.thinkingLevel;
        const kwargs: Record<string, unknown> = { enable_thinking: level !== "off" };
        if (level !== "off") kwargs.reasoning_effort = level;
        body.chat_template_kwargs = kwargs;
      } else if (this.config.enableThinking !== undefined) {
        // Legacy flag: pure boolean control (exactly as before).
        body.chat_template_kwargs = { enable_thinking: this.config.enableThinking };
      } else {
        body.chat_template_kwargs = { enable_thinking: true };
      }
    } else if (mode === "effort") {
      const level = this.config.thinkingLevel;
      // "off" OMITS the field: sending any effort (even "minimal") turns
      // reasoning ON for models whose default is off (DeepSeek v4 on
      // OpenRouter). Omitting leaves the model default: off for DeepSeek,
      // but NOT disable-able for reasoning-mandatory models (gpt-5 family,
      // which reject effort "none"/`enabled:false` with a 400).
      if (level && level !== "off") body.reasoning_effort = level;
    } else if (mode === "type") {
      // DeepSeek/Anthropic-style toggle, used by OpenCode Go for DeepSeek /
      // Qwen / Kimi. These models have no effort tiers, so the level collapses
      // to on/off (`enabled`/`disabled`); `adaptive` remains the model's own
      // choice and is only used when the level is left on Auto.
      const level = this.config.thinkingLevel;
      if (level) body.thinking = { type: level === "off" ? "disabled" : "enabled" };
    } else if (mode === "reasoning") {
      // OpenRouter-native reasoning object. `enabled:false` is the RELIABLE
      // off for models whose default is thinking-on (DeepSeek v4): omitting
      // or `reasoning_effort` are not deterministic there. Reasoning-mandatory
      // models (gpt-5 family) answer off with HTTP 400 — use "effort" for them.
      const level = this.config.thinkingLevel;
      if (level === "off") body.reasoning = { enabled: false };
      else if (level) body.reasoning = { effort: level };
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      // Identify ourselves (recommended by providers like OpenCode Go, which
      // reject generic SDK/library UAs as potential abuse).
      "User-Agent": "Harny/0.1 (VS Code AI Coding Harness)",
    };
    if (this.config.apiKey) {
      headers.Authorization = `Bearer ${this.config.apiKey}`;
    }
    // Static extra headers declared by the active named provider (a UA tag, an
    // origin marker, or a fixed session value). Non-empty strings only.
    for (const [k, v] of Object.entries(this.config.extraHeaders ?? {})) {
      if (v) headers[k] = v;
    }
    // Per-conversation routing header (OpenCode Go's `x-opencode-session` and
    // similar): a STABLE id per harny conversation lets the provider optimize
    // routing and prompt caching. Sent only when the active provider declares
    // the header name AND the session carries an id.
    if (this.config.sessionHeader && this.config.sessionId) {
      headers[this.config.sessionHeader] = this.config.sessionId;
    }

    const payload = JSON.stringify(body);
    let response: HttpResponse = await this.http.post(url, payload, headers, signal);
    // Retry transient failures (429 rate limits, 5xx) with backoff, so N
    // concurrent sub-agents do not all fail on a provider rate limit. Honors
    // `Retry-After`; Stop (abort) cancels the backoff immediately.
    for (
      let attempt = 0;
      !response.ok && RETRYABLE_STATUS.has(response.status) && attempt < MAX_POST_RETRIES;
      attempt++
    ) {
      if (signal?.aborted) break;
      const retryAfter = response.headers?.get?.("retry-after") ?? null;
      await response.text().catch(() => ""); // drain the socket before retrying
      await sleep(retryDelayMs(attempt, retryAfter), signal);
      response = await this.http.post(url, payload, headers, signal);
    }

    if (process.env.HARNY_DEBUG) {
      // DEBUG: show EXACTLY what reaches the server (model / reasoning_effort /
      // temperature / sampler / session header). Verifies whether the model or
      // the proxy actually receives the configured parameters. Written to the
      // same request log as logger.debugLog (`<os.tmpdir()>/harny-debug.log` — on macOS
      // that is NOT /tmp: it is the per-user T folder) (no vscode dependency, so
      // the provider also stays unit-testable).
      const line = `[${new Date().toISOString()}] [harny] request ${JSON.stringify({
        url,
        model: body.model,
        reasoning_effort: body.reasoning_effort,
        chat_template_kwargs: body.chat_template_kwargs,
        thinking: body.thinking,
        temperature: body.temperature,
        top_p: body.top_p,
        presence_penalty: body.presence_penalty,
        frequency_penalty: body.frequency_penalty,
        max_tokens: body.max_tokens,
        sessionHeader: this.config.sessionHeader
          ? { name: this.config.sessionHeader, value: this.config.sessionId }
          : undefined,
      })}\n`;
      try {
        fs.appendFileSync(DEBUG_LOG_FILE, line);
      } catch {
        /* best effort */
      }
    }

    if (!response.ok) {
      let text = await response.text();
      // CROSS-MODEL: some models reject `max_tokens` by NAME (OpenAI's reasoning
      // ones demand `max_completion_tokens`, and gateways mirror them). No model
      // list keeps up with that, so the SERVER's own instruction is followed: the
      // field is renamed and the request sent again, ONCE. Because the rule lives
      // in the response and not in a model table, any backend that behaves this way
      // works without being known in advance.
      if (needsMaxCompletionTokens(response.status, text) && "max_tokens" in body) {
        // Remember it for every later request to this model (endpoint included).
        NEEDS_MAX_COMPLETION_TOKENS.add(completionTokensKey(this.config.baseUrl, this.config.model));
        const patched: Record<string, unknown> = { ...body, max_completion_tokens: body.max_tokens };
        delete patched.max_tokens;
        const retry = await this.http.post(url, JSON.stringify(patched), headers, signal);
        if (!retry.ok) throw new Error(describeApiError(retry.status, await retry.text()));
        response = retry;
      } else {
        throw new Error(describeApiError(response.status, text));
      }
    }

    const seenToolCallIndices = new Set<number>();
    // Fallback ids for providers that omit tool-call ids: a counter keeps them
    // unique even when several calls share the same index.
    let toolCallSeq = 0;
    // Some hosts repeat finish_reason on several chunks: surface it once.
    let finishEmitted = false;
    // Accumulated OpenRouter `reasoning_details` blocks, keyed by block index
    // and kept in the exact order the model emitted them. They are passed back
    // UNMODIFIED on the next turn (required for encrypted/summarized models).
    const reasoningBlocks = new Map<number, Record<string, unknown>>();

    for await (const line of sseLines(response)) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith("data: ")) continue;
      const data = trimmed.slice(6);
      if (data === "[DONE]") break;

      let parsed: any;
      try {
        parsed = JSON.parse(data);
      } catch {
        continue; // skip malformed lines
      }

      const choice = parsed.choices?.[0];

      // With stream_options.include_usage the last chunk carries usage.
      if (parsed.usage) {
        const u = parsed.usage;
        const prompt = Number(u.prompt_tokens ?? 0);
        // Anthropic-shaped usage keeps the reads OUT of the prompt count, so the
        // convention is `prompt_tokens + cache_read_input_tokens`. OpenAI-shaped usage
        // already includes them (there cache_read is absent, and the cached SUBSET comes
        // in prompt_tokens_details).
        const cacheRead = Number(u.cache_read_input_tokens ?? 0);
        const cached = Number(u.prompt_tokens_details?.cached_tokens ?? u.prompt_cache_hit_tokens ?? cacheRead ?? 0);
        const cachedWrite = Number(u.prompt_tokens_details?.cache_write_tokens ?? u.cache_creation_input_tokens ?? 0);
        // LAST MIXED CASE: a gateway that reports `prompt_tokens` WITHOUT the cache but
        // the cached count as a subset field. There the two numbers sit on different
        // bases, `cached` can exceed the prompt we counted, and every ratio built from
        // them is arithmetically impossible (cache at "100%" by construction, clamp
        // aside). The anomaly itself is the detector — a SUBSET cannot exceed its whole —
        // so the base is corrected without knowing which provider is talking. The number
        // fixed here is not cosmetic: it is what the context bar shows and what triggers
        // the automatic compaction, and an understated context compacts too late.
        const promptTotal =
          cached > prompt + cacheRead ? prompt + cacheRead + cached + cachedWrite : prompt + cacheRead;
        const output = Number(u.completion_tokens ?? 0);
        yield {
          type: "usage",
          usage: {
            input: promptTotal,
            output,
            // Kept consistent with `input`: a total smaller than its own prompt would be
            // a nonsense number for anything that adds the two up.
            total: Math.max(Number(u.total_tokens ?? 0), promptTotal + output),
            // cached is informational only and never affects input/output/total.
            cached,
            // The WRITE side (tokens stored into the cache) is a provider
            // extension of the OpenAI protocol: OpenRouter reports
            // cache_write_tokens, llama.cpp/vLLM cache_creation_input_tokens.
            cachedWrite,
          },
        };
      }
      if (!choice) continue;
      const delta = choice.delta;

      // Visible answer text.
      if (delta?.content) {
        yield { type: "text", content: delta.content };
      }

      // Reasoning models stream the thinking phase separately. Field name
      // varies by host: opencode-go/llama.cpp use `reasoning_content`,
      // OpenRouter streams `reasoning`. Read it INDEPENDENTLY of `content` so
      // a chunk carrying both never drops the thinking.
      const thinking = delta?.reasoning_content ?? delta?.reasoning;
      if (thinking) yield { type: "thinking", content: thinking };

      // OpenRouter also streams structured `reasoning_details`. Accumulate them
      // for pass-back (encrypted/summarized reasoning) and, when no plaintext
      // field is present, surface their text so nothing is lost.
      if (Array.isArray(delta?.reasoning_details) && delta.reasoning_details.length > 0) {
        accumulateReasoningDetails(reasoningBlocks, delta.reasoning_details);
        if (!thinking) {
          for (const detail of delta.reasoning_details) {
            const text = reasoningDetailText(detail);
            if (text) yield { type: "thinking", content: text };
          }
        }
      }

      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          if (tc.function?.name) {
            seenToolCallIndices.add(idx);
            yield {
              type: "tool_call_start",
              index: idx,
              id: tc.id || `call_${toolCallSeq++}`,
              name: tc.function.name,
            };
          }
          if (tc.function?.arguments) {
            yield { type: "tool_call_delta", index: idx, delta: tc.function.arguments };
          }
        }
      }

      if (choice.finish_reason && (delta?.tool_calls || seenToolCallIndices.size > 0)) {
        if (choice.finish_reason === "tool_calls" || choice.finish_reason === "stop") {
          for (const idx of seenToolCallIndices) {
            yield { type: "tool_call_end", index: idx };
            seenToolCallIndices.delete(idx);
          }
        }
      }
      // Surface the finish reason LAST (after any closing tool-call events), so
      // consumers see a clean end-of-turn marker.
      if (choice.finish_reason && !finishEmitted) {
        finishEmitted = true;
        yield { type: "finish", reason: String(choice.finish_reason) };
      }
    }

    // Emit the accumulated reasoning blocks (if any) so the caller can pass
    // them back verbatim on the next turn, then close pending tool calls.
    if (reasoningBlocks.size > 0) {
      yield { type: "thinking_details", details: orderedReasoningDetails(reasoningBlocks) };
    }

    // Emit tool_call_end for any remaining calls that were never closed.
    for (const idx of seenToolCallIndices) {
      yield { type: "tool_call_end", index: idx };
    }
  }
}

/**
 * Merge a streamed OpenRouter `reasoning_details` delta into `blocks`.
 * Blocks are keyed by their `index`. Only the CONTENT-bearing fields (`summary`,
 * `text`, `data`) arrive incrementally and must be CONCATENATED; metadata
 * (`type`, `format`, `index`) is repeated verbatim on every delta, so it is
 * last-write-wins (concatenating it would duplicate "reasoning.summary" etc.).
 */
const REASONING_TEXT_FIELDS = new Set(["summary", "text", "data"]);

function accumulateReasoningDetails(blocks: Map<number, Record<string, unknown>>, deltas: unknown[]): void {
  for (const raw of deltas) {
    if (!raw || typeof raw !== "object") continue;
    const delta = raw as Record<string, unknown>;
    const index = typeof delta.index === "number" ? delta.index : 0;
    const existing = blocks.get(index);
    if (!existing) {
      blocks.set(index, { ...delta });
      continue;
    }
    for (const [key, value] of Object.entries(delta)) {
      const prev = existing[key];
      const append = REASONING_TEXT_FIELDS.has(key) && typeof value === "string" && typeof prev === "string";
      existing[key] = append ? prev + value : value;
    }
  }
}

/** Reasoning blocks in the original emission order (ascending index). */
function orderedReasoningDetails(blocks: Map<number, Record<string, unknown>>): unknown[] {
  return [...blocks.entries()].sort((a, b) => a[0] - b[0]).map(([, block]) => block);
}

/** Plaintext carried by a reasoning_details block, if any. */
function reasoningDetailText(detail: unknown): string | undefined {
  if (!detail || typeof detail !== "object") return undefined;
  const rec = detail as Record<string, unknown>;
  const text = rec.summary ?? rec.text ?? rec.content;
  return typeof text === "string" && text.length > 0 ? text : undefined;
}
