import type { HttpResponse } from "./http-client";

/**
 * Yields each line of a server-sent-events stream (raw lines, still prefixed
 * with "data: " where applicable).
 */
export async function* sseLines(response: HttpResponse): AsyncGenerator<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("No response body");

  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) yield line;
  }
  if (buffer) yield buffer;
}
