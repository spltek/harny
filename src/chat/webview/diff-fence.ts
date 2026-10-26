/**
 * Parsing side of the file-change diff feature (the rendering side lives in
 * view.ts). PURE functions — no DOM — so the fence contract (format emitted
 * by diff-text.ts) is unit-testable here.
 */

/** A diff found inside a tool output (```diff fence). */
export interface FoundDiff {
  body: string;
  stat: string | undefined;
  rest: string;
}

/**
 * Extracts the first ```diff … ``` fenced block from a tool output. NO
 * line-prefix heuristic: plain outputs (file listings, bullet lists…) are
 * never mistaken for diffs — only an explicit fence is one. The optional
 * "Diff (+N/-N):" label line right before the fence is removed (the diff
 * bubble re-shows the stat), keeping any real feedback text before it.
 */
export function splitDiffFence(text: string): FoundDiff | undefined {
  const match = text.match(/```diff\s*\n([\s\S]*?)```/);
  if (!match || match.index === undefined) return undefined;
  const before = text.slice(0, match.index);
  const after = text.slice(match.index + match[0].length);
  const statMatch = before.match(/Diff\s*\(([+-]\d+\/-\d+)\):\s*$/);
  const head = (statMatch ? before.slice(0, statMatch.index) : before).replace(/\s+$/, "");
  const tail = after.replace(/^\s+/u, "").replace(/\s+$/u, "");
  const rest = head ? (tail ? head + "\n" + tail : head) : tail;
  return { body: match[1].replace(/\s+$/, ""), stat: statMatch?.[1], rest };
}

/** Compact "+N/−M" counts computed from a diff body. */
export function countDiff(body: string): string {
  let add = 0;
  let del = 0;
  for (const l of body.split("\n")) {
    if (l.startsWith("+") && !l.startsWith("+++")) add++;
    else if (l.startsWith("-") && !l.startsWith("---")) del++;
  }
  return `+${add}/−${del}`;
}
