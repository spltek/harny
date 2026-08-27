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
 * Produce a readable, ACTIONABLE error message, unwrapping Node's generic
 * "fetch failed" into the underlying cause (DNS, TCP, TLS). A categorized
 * prefix tells the agent whether to retry, change the URL or give up; the
 * original raw detail is kept at the end for debugging.
 */
export function describeFetchError(err: unknown, url?: string): string {
  if (err && typeof err === "object") {
    const e = err as { message?: unknown; cause?: unknown };
    if (e.message === "fetch failed" && e.cause) {
      const cause = e.cause as { message?: unknown; code?: unknown; hostname?: unknown };
      const code = typeof cause.code === "string" ? cause.code : "";
      const rawDetail = typeof cause.message === "string" ? cause.message.trim() : "";
      const detail = rawDetail || (code ? CODE_HINTS[code] : "") || "unknown network error";
      const rawSummary = `fetch failed: ${detail}${code ? ` (${code})` : ""}`;
      const prefix = classifyNetworkFailure(code, rawDetail.toLowerCase(), url || hostnameOf(cause));
      return prefix ? `${prefix} [${rawSummary}]` : rawSummary;
    }
    if (typeof e.message === "string") return e.message;
  }
  return String(err);
}

function hostnameOf(cause: { hostname?: unknown }): string | undefined {
  return typeof cause.hostname === "string" && cause.hostname ? cause.hostname : undefined;
}

function hostParts(url: string | undefined): { host: string; hostPort: string } {
  if (url) {
    try {
      const u = new URL(url);
      // URL omits DEFAULT ports (https:443) — include them so the message
      // always shows host:port as P5 asks.
      const port = u.port || (u.protocol === "https:" ? "443" : u.protocol === "http:" ? "80" : "");
      return { host: u.hostname, hostPort: port ? `${u.hostname}:${port}` : u.hostname };
    } catch {
      /* not a URL: fall through */
    }
  }
  return { host: "the host", hostPort: "the host" };
}

function classifyNetworkFailure(code: string, raw: string, url: string | undefined): string | undefined {
  const { host, hostPort } = hostParts(url);
  if (code === "ENOTFOUND" || code === "EAI_AGAIN" || raw.includes("getaddrinfo")) {
    return `DNS resolution failed for ${host} — check the domain name.`;
  }
  if (code === "ETIMEDOUT" || raw.includes("timed out")) {
    return `Connection to ${hostPort} timed out — the site may be down; retry later or use a different source.`;
  }
  if (code === "ECONNREFUSED" || raw.includes("connection refused")) {
    return `Connection to ${hostPort} refused — the site may be down or the port is wrong.`;
  }
  if (code.startsWith("ERR_TLS") || /certificate|tls|ssl|handshake/i.test(raw)) {
    return "TLS handshake failed — certificate or protocol issue.";
  }
  return undefined;
}
