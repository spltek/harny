import * as Diff from "diff";

/**
 * Unified-diff preview helpers shared by every file-mutating tool (Edit,
 * Write, StrReplace, Delete) and rendered by the webview as a dedicated
 * diff bubble. Kept in ONE module so the fence format used by the tools and
 * the format the view parses cannot drift apart.
 */

/** Unified file-level diff of the whole change (feedback for the model + view). */
export function buildDiff(oldContent: string, newContent: string): string {
  return Diff.createTwoFilesPatch("file", "file", oldContent, newContent, "", "", {
    context: 3,
  })
    .split("\n")
    .slice(4) // drop "--- file" / "+++ file" (paths are meaningless here)
    .join("\n")
    .trim();
}

/**
 * Truncate a diff body at a line boundary, keeping the fenced preview lean
 * (the stat label is computed from the FULL diff before truncation).
 */
export function capDiff(diff: string, maxChars = 4000): string {
  if (diff.length <= maxChars) return diff;
  const lines = diff.split("\n");
  let out = "";
  let len = 0;
  for (const l of lines) {
    if (len + l.length + 1 > maxChars) break;
    out += l + "\n";
    len += l.length + 1;
  }
  return (out.endsWith("\n") ? out.slice(0, -1) : out) + "\n… (diff truncated)";
}

/** Sum of changed lines (+/-) in a diff, for a compact preview label. */
export function diffStat(diff: string): string {
  const lines = diff.split("\n");
  const add = lines.filter((l) => l.startsWith("+") && !l.startsWith("+++")).length;
  const del = lines.filter((l) => l.startsWith("-") && !l.startsWith("---")).length;
  return `+${add}/-${del}`;
}

/**
 * The ```diff fenced block appended to a tool result payload. Empty input
 * (nothing changed) yields an empty string, so tools never emit a phantom
 * fence. The view detects this exact format and renders it as the diff bubble.
 */
export function fencedDiffBlock(diff: string | undefined): string {
  if (!diff) return "";
  return `\n\nDiff (${diffStat(diff)}):\n\`\`\`diff\n${capDiff(diff)}\n\`\`\``;
}