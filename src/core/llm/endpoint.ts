/**
 * Build an API endpoint URL from a base URL that may or may not already
 * include the "/v1" prefix (OpenAI-style).
 *
 * - "https://api.openai.com"            -> "https://api.openai.com/v1/chat/completions"
 * - "http://localhost:8090/v1"          -> "http://localhost:8090/v1/chat/completions"
 * - "http://localhost:8090/v1/"         -> "http://localhost:8090/v1/chat/completions"
 */
export function endpointUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${base}/v1${suffix}`;
}
