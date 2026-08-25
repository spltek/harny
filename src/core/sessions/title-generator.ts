export const MAX_TITLE_LENGTH = 50;

/** Reduce a raw title to a single line, trimmed and length-bounded. */
export function sanitizeTitle(raw: string): string {
  return raw.replace(/[\r\n\t]+/g, " ").trim().slice(0, MAX_TITLE_LENGTH);
}

/**
 * Title for the context compactor's summary goal: the first line of the first
 * user message, reduced to a single line (fallback when no message is present).
 */
export function fallbackTitle(firstMessage: string): string {
  const line = firstMessage.split(/\r?\n/)[0]?.trim() ?? "";
  return sanitizeTitle(line) || "New Session";
}
