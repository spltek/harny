import type { HarnyConfig } from "./types";

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0"]);

export function isLocalBaseUrl(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.replace(/^\[|\]$/g, "");
    return LOCAL_HOSTNAMES.has(host);
  } catch {
    return false;
  }
}

/**
 * Whether the request would fail without an API key.
 * Local endpoints (llama.cpp, Ollama, ...) do not need one.
 */
export function requiresApiKey(config: HarnyConfig): boolean {
  if (config.apiKey && config.apiKey.trim() !== "") return false;
  return !isLocalBaseUrl(config.baseUrl);
}
