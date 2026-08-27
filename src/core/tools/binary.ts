/**
 * Binary-content detection for tools that present file TEXT (Read, Grep).
 * Reads are decoded as UTF-8 strings, so binary bytes surface as NUL (\u0000)
 * and U+FFFD replacement characters; a sample with either in non-trivial
 * ratio is treated as binary and must not be shown/summarized as text.
 */
const SAMPLE_CHARS = 8000;

export function isBinaryText(text: string): boolean {
  const sample = text.slice(0, SAMPLE_CHARS);
  if (sample.includes("\u0000")) return true;
  const bad = sample.match(/\uFFFD/g)?.length ?? 0;
  if (sample.length > 0 && bad / sample.length > 0.02) return true;
  return false;
}