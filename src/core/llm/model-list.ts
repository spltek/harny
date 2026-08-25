import { endpointUrl } from "./endpoint";
import type { HttpClient } from "./http-client";

export interface ModelListOptions {
  baseUrl: string;
  apiKey?: string;
}

/**
 * Fetches the list of models served by an OpenAI-compatible `/models`
 * endpoint (OpenAI, OpenRouter, llama.cpp, Ollama, opencode-go, ...).
 * Some hosts require no explicit list in the config — only apiKey + baseUrl.
 */
export interface ModelListProvider {
  fetchModels(opts: ModelListOptions): Promise<string[]>;
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
    const url = endpointUrl(opts.baseUrl, "/models");
    const headers: Record<string, string> = {};
    if (opts.apiKey) headers.Authorization = `Bearer ${opts.apiKey}`;
    const res = await this.http.get(url, headers);
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

    const ids = raw
      .map((m) => (typeof m === "string" ? m : (m as { id?: unknown } | null)?.id))
      .filter((id): id is string => typeof id === "string")
      .map((id) => id.trim())
      .filter((id) => id.length > 0);
    return [...new Set(ids)];
  }
}