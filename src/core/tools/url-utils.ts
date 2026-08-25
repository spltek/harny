/** Prepends https:// when the input has no protocol. */
export function normalizeUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return "";
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

const CODE_HINTS: Record<string, string> = {
  ECONNREFUSED: "connection refused — is the server running on the right port?",
  ENOTFOUND: "host not found — check the URL/hostname",
  EHOSTUNREACH: "host unreachable",
  ETIMEDOUT: "connection timed out",
  ECONNRESET: "connection reset by peer",
  ERR_INVALID_URL: "invalid URL",
};

/**
 * Produce a readable error message, unwrapping Node's generic
 * "fetch failed" into the underlying cause (DNS, ECONNREFUSED, TLS, ...).
 */
export function describeFetchError(err: unknown): string {
  if (err && typeof err === "object") {
    const e = err as { message?: unknown; cause?: unknown };
    if (e.message === "fetch failed" && e.cause) {
      const cause = e.cause as { message?: unknown; code?: unknown };
      const code = typeof cause.code === "string" ? cause.code : "";
      const rawDetail = typeof cause.message === "string" ? cause.message.trim() : "";
      const detail = rawDetail || (code ? CODE_HINTS[code] : "") || "unknown network error";
      return `fetch failed: ${detail}${code ? ` (${code})` : ""}`;
    }
    if (typeof e.message === "string") return e.message;
  }
  return String(err);
}
