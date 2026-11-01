export const MAX_TITLE_LENGTH = 50;

/** Reduce a raw title to a single line, trimmed and length-bounded. */
export function sanitizeTitle(raw: string): string {
  return raw
    .replace(/[\r\n\t]+/g, " ")
    .trim()
    .slice(0, MAX_TITLE_LENGTH);
}
