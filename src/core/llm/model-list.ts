import { endpointUrl } from "./endpoint";
import type { HttpClient } from "./http-client";

export interface ModelListOptions {
  baseUrl: string;
  apiKey?: string;
}

/**
 * Ceiling for the host-model fetch. The panel is painted via buildConfig()
 * which AWAITS every host provider's `GET /models`; without a timeout an
 * unreachable host (dropped packets, slow DNS, dead proxy) stalls the first
 * view for the OS-level connect timeout. A live local host answers in ms, so
 * this only bounds the pathological cases.
 */
export const HOST_MODEL_TIMEOUT_MS = 5000;

/**
 * Fetches the list of models served by an OpenAI-compatible `/models`
 * endpoint (OpenAI, OpenRouter, llama.cpp, Ollama, opencode-go, ...).
 * Some hosts require no explicit list in the config — only apiKey + baseUrl.
 */
export interface ModelInfo {
  id: string;
  /** Context window in tokens, when the host reports it (OpenRouter's
   * `context_length`, vLLM's `max_model_len`, llama.cpp's `meta.n_ctx_train`, …). */
  contextLength?: number;
  /** Max OUTPUT tokens, when the host reports it (OpenRouter's
   * `top_provider.max_completion_tokens`, `max_output_tokens`, …). */
  maxOutputTokens?: number;
}

export interface ModelListProvider {
  fetchModels(opts: ModelListOptions): Promise<string[]>;
  /** Richer variant (optional, so simple mocks keep working): model ids plus
   * the context window when the host reports it. */
  fetchModelInfos?(opts: ModelListOptions): Promise<ModelInfo[]>;
}

/** Keys that carry a model's context window across the known `/models` shapes
 * (OpenRouter, vLLM, llama.cpp, OpenAI-compatible hosts, models.dev — the
 * schema OpenCode Go / Zen uses, where it is `limit.context`). */
const CONTEXT_KEYS = [
  "context_length",
  "context_window",
  "contextWindow",
  "context",
  "context_size",
  "context_tokens",
  "max_context_length",
  "max_model_len",
  "max_input_tokens",
  "input_tokens",
  "n_ctx",
  "n_ctx_train",
] as const;

/** Nested objects that may hold the context window. */
const CONTEXT_CONTAINERS = ["limit", "limits", "metadata", "meta", "top_provider", "architecture"] as const;

function toPositiveInt(value: unknown): number | undefined {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

function pickContext(o: Record<string, unknown>): number | undefined {
  for (const key of CONTEXT_KEYS) {
    const n = toPositiveInt(o[key]);
    if (n) return n;
  }
  return undefined;
}

/** Keys that carry a model's MAX OUTPUT tokens across the known `/models`
 * shapes (OpenRouter's `top_provider.max_completion_tokens`, `max_output_tokens`,
 * `max_completion_tokens`, …). */
const OUTPUT_KEYS = [
  "max_output_tokens",
  "max_completion_tokens",
  "maxOutputTokens",
  "max_tokens",
  "output_tokens",
  "output",
] as const;

function pickOutput(o: Record<string, unknown>): number | undefined {
  for (const key of OUTPUT_KEYS) {
    const n = toPositiveInt(o[key]);
    if (n) return n;
  }
  return undefined;
}

/** Best-effort MAX OUTPUT tokens from the common `/models` response shapes
 * (top-level fields, or nested under `limit`/`limits`/`metadata`/`meta`/
 * `top_provider`/`architecture` — e.g. OpenRouter's `top_provider`). */
export function extractMaxOutput(model: unknown): number | undefined {
  if (!model || typeof model !== "object") return undefined;
  const o = model as Record<string, unknown>;
  const direct = pickOutput(o);
  if (direct) return direct;
  for (const container of CONTEXT_CONTAINERS) {
    const child = o[container];
    if (child && typeof child === "object") {
      const n = pickOutput(child as Record<string, unknown>);
      if (n) return n;
    }
  }
  return undefined;
}

/** Best-effort context length from the common `/models` response shapes
 * (top-level fields, or nested under `limit`/`limits`/`metadata`/`meta`/
 * `top_provider`/`architecture` — e.g. models.dev's `limit.context`). */
export function extractContextLength(model: unknown): number | undefined {
  if (!model || typeof model !== "object") return undefined;
  const o = model as Record<string, unknown>;
  const direct = pickContext(o);
  if (direct) return direct;
  for (const container of CONTEXT_CONTAINERS) {
    const child = o[container];
    if (child && typeof child === "object") {
      const n = pickContext(child as Record<string, unknown>);
      if (n) return n;
    }
  }
  return undefined;
}

/**
 * Real implementation backed by an HttpClient.
 *
 * Handles the common response shapes:
 *   { "data": [{ "id": "gpt-4o", ... }] }   (OpenAI style)
 *   { "models": ["id", ...] }               (some compatible servers)
 *   [ { "id": "..." }, ... ]                (bare array)
 */
export class HttpModelListProvider implements ModelListProvider {
  constructor(private http: HttpClient) {}

  async fetchModels(opts: ModelListOptions): Promise<string[]> {
    return (await this.fetchModelInfos(opts)).map((m) => m.id);
  }

  async fetchModelInfos(opts: ModelListOptions): Promise<ModelInfo[]> {
    const url = endpointUrl(opts.baseUrl, "/models");
    const headers: Record<string, string> = {};
    if (opts.apiKey) headers.Authorization = `Bearer ${opts.apiKey}`;
    // Bounded fetch: the panel waits on this before first paint.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HOST_MODEL_TIMEOUT_MS);
    let res: import("./http-client").HttpResponse;
    try {
      res = await this.http.get(url, headers, controller.signal);
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) throw new Error(`GET /models → HTTP ${res.status}`);
    const body = await res.json();

    let raw: unknown[];
    if (Array.isArray(body)) raw = body;
    else if (body && typeof body === "object") {
      const rec = body as { data?: unknown; models?: unknown };
      raw = Array.isArray(rec.data)
        ? rec.data
        : Array.isArray(rec.models)
          ? rec.models
          : [];
    } else {
      raw = [];
    }

    const infos: ModelInfo[] = [];
    const seen = new Set<string>();
    for (const m of raw) {
      const id = typeof m === "string" ? m : (m as { id?: unknown } | null)?.id;
      if (typeof id !== "string") continue;
      const trimmed = id.trim();
      if (!trimmed || seen.has(trimmed)) continue;
      seen.add(trimmed);
      const contextLength = typeof m === "string" ? undefined : extractContextLength(m);
      const maxOutputTokens = typeof m === "string" ? undefined : extractMaxOutput(m);
      infos.push({
        id: trimmed,
        ...(contextLength ? { contextLength } : {}),
        ...(maxOutputTokens ? { maxOutputTokens } : {}),
      });
    }
    return infos;
  }
}