import type { HttpClient, HttpResponse } from "./http-client";

/** Build an SSE response whose body is a single chunk containing `lines`. */
export function sseResponse(...lines: string[]): HttpResponse {
  const text = lines.join("\n") + "\n";
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
  return {
    ok: true,
    status: 200,
    headers: { get: (n: string) => (n.toLowerCase() === "content-type" ? "text/event-stream" : null) },
    text: async () => text,
    json: async () => ({}),
    body,
  };
}

interface RecordedRequest {
  url: string;
  body: string;
  headers: Record<string, string>;
  signal?: AbortSignal;
}

/** HttpClient mock that records requests and serves canned responses. */
export class FakeHttpClient implements HttpClient {
  requests: RecordedRequest[] = [];
  private queue: HttpResponse[] = [];

  constructor(private responder?: (req: RecordedRequest, index: number) => HttpResponse) {}

  respondWith(...responses: HttpResponse[]) {
    this.queue.push(...responses);
  }

  async post(url: string, body: string, headers: Record<string, string>, signal?: AbortSignal) {
    const req = { url, body, headers, signal };
    this.requests.push(req);
    if (this.responder) return this.responder(req, this.requests.length - 1);
    const next = this.queue.shift();
    if (!next) throw new Error(`Unexpected POST to ${url}`);
    return next;
  }

  async get(url: string, headers: Record<string, string> = {}, signal?: AbortSignal) {
    const req = { url, body: "", headers, signal };
    this.requests.push(req);
    if (this.responder) return this.responder(req, this.requests.length - 1);
    const next = this.queue.shift();
    if (!next) throw new Error(`Unexpected GET to ${url}`);
    return next;
  }
}
