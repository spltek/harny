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
}

export interface ModelListProvider {
  fetchModels(opts: ModelListOptions): Promise<string[]>;
  /** Richer variant (optional, so simple mocks keep working): model ids plus
   * the context window when the host reports it. */
  fetchModelInfos?(opts: ModelListOptions): Promise<ModelInfo[]>;
}

/** Best-effort context length from the common `/models` response shapes. */
export function extractContextLength(model: unknown): number | undefined {
  if (!model || typeof model !== "object") return undefined;
  const o = model as Record<string, unknown>;
  const meta = o.meta as Record<string, unknown> | undefined;
  const top = o.top_provider as Record<string, unknown> | undefined;
  const candidates = [
    o.context_length,
    o.context_window,
    o.max_context_length,
    o.max_model_len,
    o.n_ctx,
    o.context_size,
    top?.context_length,
    meta?.n_ctx_train,
    meta?.n_ctx,
  ];
  for (const c of candidates) {
    const n = typeof c === "string" ? Number(c) : c;
    if (typeof n === "number" && Number.isFinite(n) && n > 0) return Math.floor(n);
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
      infos.push({ id: trimmed, ...(contextLength ? { contextLength } : {}) });
    }
    return infos;
  }
}