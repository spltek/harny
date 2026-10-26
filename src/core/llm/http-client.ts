export interface HttpHeaders {
  get(name: string): string | null;
}

export interface HttpResponse {
  ok: boolean;
  status: number;
  headers: HttpHeaders;
  text(): Promise<string>;
  json(): Promise<unknown>;
  body: ReadableStream<Uint8Array> | null;
  /** Final URL after redirects (fetch follows redirects; undefined on mocks). */
  url?: string;
}

export interface HttpClient {
  post(url: string, body: string, headers: Record<string, string>, signal?: AbortSignal): Promise<HttpResponse>;
  get(url: string, headers?: Record<string, string>, signal?: AbortSignal): Promise<HttpResponse>;
}

/**
 * HttpClient backed by the global fetch (Node 18+, VS Code extension host).
 *
 * Loopback addresses are rewritten from `localhost` to the literal `127.0.0.1`
 * before fetching: it removes the DNS lookup (getaddrinfo) from the request
 * path. DNS resolution runs on the shared libuv threadpool and on macOS can
 * stall for >10 s when the system resolver is slow — that surfaces as a
 * spurious undici `UND_ERR_CONNECT_TIMEOUT` on a server that curls fine.
 */
export const nodeHttpClient: HttpClient = {
  async post(url, body, headers, signal) {
    return fetch(toLiteralLoopback(url), {
      method: "POST",
      headers,
      body,
      signal,
    }) as Promise<HttpResponse>;
  },
  async get(url, headers = {}, signal) {
    return fetch(toLiteralLoopback(url), { method: "GET", headers, signal }) as Promise<HttpResponse>;
  },
};

/** Replace a `localhost[:port]` host with `127.0.0.1[:port]`. */
function toLiteralLoopback(url: string): string {
  return url.replace(/^(https?):\/\/localhost(?=[:/]|$)/i, (_m, proto: string) => `${proto}://127.0.0.1`);
}
