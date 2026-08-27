import { buildDiff } from "./diff-text";

/** A single edit operation — predictable surgical contract (like pi). */
export interface EditOp {
  /** Text to replace (exact, must be unique). Trailing-space/unicode-tolerant. */
  oldText?: string;
  /** Replacement text (required with oldText; empty = deletion). */
  newText?: string;
  /** Anchor line to insert BEFORE / to disambiguate duplicates. */
  beforeText?: string;
  /** Anchor line to insert before when beforeText is absent. */
  afterText?: string;
}

export type EditMode = "exact" | "fuzzy" | "insert" | "invalid";

export interface EditFailure {
  index: number;
  reason: string;
  detail?: string;
  anchor?: string;
}

export interface EditResult {
  /** Content after applying all successful edits (never written unless `failed` is empty). */
  content: string;
  failed: EditFailure[];
  applied: number;
  /** Per-edit mode actually used (predictability/feedback). */
  modes: EditMode[];
  /** Unified diff (file-level) of the applied change, or undefined when nothing changed. */
  diff?: string;
}

/** Applies ALL edits atomically (write only when `failed` is empty). */
export function applyEdits(content: string, edits: EditOp[]): EditResult {
  let cur = content;
  const failed: EditFailure[] = [];
  const modes: EditMode[] = [];
  let applied = 0;
  edits.forEach((op, i) => {
    const r = applyOne(cur, op);
    if (r.ok) {
      cur = r.content as string;
      applied++;
      modes.push(r.mode);
    } else {
      failed.push({ index: i, reason: r.reason, detail: r.detail, anchor: op.oldText ?? op.beforeText ?? op.afterText });
    }
  });
  const diff = applied > 0 && failed.length === 0 ? buildDiff(content, cur) : undefined;
  return { content: cur, failed, applied, modes, diff };
}

interface OneResult {
  ok: boolean;
  content?: string;
  mode: EditMode;
  reason: string;
  detail?: string;
}

function applyOne(content: string, op: EditOp): OneResult {
  if (op.oldText !== undefined && op.newText !== undefined) {
    return replaceText(content, op.oldText, op.newText);
  }

  // Insertion anchored by beforeText/afterText.
  const anchor = op.beforeText ?? op.afterText;
  if (anchor !== undefined && anchor.length > 0) {
    const newText = op.newText ?? "";
    // A no-op insertion MUST NOT report success: the model would believe the
    // text was written when nothing changed (phantom edit). Reject explicitly
    // with a teach-recovery example.
    if (!newText) {
      return {
        ok: false,
        mode: "invalid",
        reason: "insertion needs newText",
        detail:
          'Edit has beforeText/afterText but no newText. Insertions use: {"beforeText": "<anchor line>", "newText": "<text to insert>"} ' +
          "(afterText is only a disambiguation hint, not the content). For replacements use oldText+newText.",
      };
    }
    const pos = content.indexOf(anchor);
    if (pos === -1) {
      return { ok: false, mode: "invalid", reason: `anchor not found: "${anchor}".`, detail: `Re-check the file; the anchor "${anchor}" is not present.` };
    }
    const before = content.slice(0, pos);
    const after = content.slice(pos);
    const lead = before && !before.endsWith("\n") ? "\n" : "";
    const trail = newText && !after.startsWith("\n") ? "\n" : "";
    return { ok: true, content: before + lead + newText + trail + after, mode: "insert", reason: "ok" };
  }

  return {
    ok: false,
    mode: "invalid",
    reason: "invalid edit: need oldText+newText or before/afterText.",
    detail:
      'Each edit needs either oldText+newText (replacement) or beforeText/afterText + newText (insertion). ' +
      'Example: {"edits": [{"oldText": "old line", "newText": "new line"}]}.',
  };
}

/**
 * Exact-or-fuzzy text replacement. Exact first; fuzzy = the same text up to
 * trailing whitespace, smart quotes/dashes and other Unicode noise (NFKC) —
 * NOT indentation/casing forgiveness and NO structural guessing: if it does
 * not match clearly, it fails with a precise error (predictability).
 */
function replaceText(content: string, oldText: string, newText: string): OneResult {
  if (!oldText) {
    return { ok: false, mode: "invalid", reason: "oldText is empty.", detail: "Quote the actual text to replace — empty oldText cannot match." };
  }
  if (oldText === newText) {
    return { ok: false, mode: "invalid", reason: "no change: oldText equals newText.", detail: "Pick the actual text to change." };
  }

  // 1) exact occurrence count
  const exactCount = countOccurrences(content, oldText);
  if (exactCount === 1) {
    const idx = content.indexOf(oldText);
    return { ok: true, content: content.slice(0, idx) + newText + content.slice(idx + oldText.length), mode: "exact", reason: "ok" };
  }
  if (exactCount > 1) {
    return {
      ok: false,
      mode: "invalid",
      reason: `${exactCount} occurrences of oldText.`,
      detail: "oldText must be unique — add beforeText/afterText context or extend oldText to cover more of the file.",
    };
  }

  // 2) fuzzy: line-run match in normalized space (trailing whitespace, unicode noise)
  const fuzzy = fuzzyUniqueReplace(content, oldText, newText);
  if (fuzzy !== undefined && fuzzy !== "duplicate") return { ok: true, content: fuzzy.content, mode: "fuzzy", reason: "ok" };
  if (fuzzy === "duplicate") {
    return {
      ok: false,
      mode: "invalid",
      reason: "multiple lines match oldText (after normalization).",
      detail: "oldText must be unique — add beforeText/afterText context to disambiguate.",
    };
  }

  return {
    ok: false,
    mode: "invalid",
    reason: "oldText not found.",
    detail: "The file does not contain this text (even tolerating trailing whitespace/Unicode). Re-Read the file and quote the ACTUAL content — it may have moved to another line or file.",
  };
}

function countOccurrences(content: string, needle: string): number {
  if (!needle) return 0;
  let n = 0;
  let from = 0;
  for (;;) {
    const i = content.indexOf(needle, from);
    if (i === -1) break;
    n++;
    from = i + needle.length;
  }
  return n;
}

function normalizeLine(line: string): string {
  return line
    .normalize("NFKC")
    .trimEnd()
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/[\u00A0\u2000-\u200A\u202F]/g, " ");
}

/**
 * Unicode/whitespace-tolerant line-run matcher, shared between Edit and
 * StrReplace: exact match first; this is the "trailing whitespace / smart
 * quotes-dashes / NFKC" fallback. Returns the replacement result, `"duplicate"`
 * when more than one line group matches, or `undefined` when nothing matches.
 */
export function fuzzyUniqueReplace(
  content: string,
  oldText: string,
  newText: string,
): { content: string } | "duplicate" | undefined {
  const lines = content.split("\n");
  const needle = oldText.split("\n").map(normalizeLine);
  if (needle.length === 0 || needle.some((l) => l === "")) return undefined;
  const matches: number[] = [];
  for (let i = 0; i + needle.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < needle.length; j++) {
      if (normalizeLine(lines[i + j]) !== needle[j]) { ok = false; break; }
    }
    if (ok) matches.push(i);
  }
  if (matches.length === 0) return undefined;
  if (matches.length > 1) return "duplicate";
  const i = matches[0];
  const repl = newText.split("\n");
  // The tolerant match IGNORES the line's trailing whitespace — the
  // replacement must not silently drop it: pad the last replacement line with
  // the original line's trailing whitespace (unless it already ends with some).
  if (repl.length > 0) {
    const ws = lines[i + needle.length - 1].match(/\s+$/)?.[0] ?? "";
    if (ws && !/\s$/.test(repl[repl.length - 1])) {
      repl[repl.length - 1] = repl[repl.length - 1] + ws;
    }
  }
  return { content: [...lines.slice(0, i), ...repl, ...lines.slice(i + needle.length)].join("\n") };
}

/** Structural sanity check: '([{' tracked OUTSIDE strings/comments. A file is
 * balanced when the stack ends empty and never mismatches. Safety net: never
 * write an edit that would unbalance a previously balanced file.
 */
export function checkStructuralBalance(content: string): { balanced: boolean; message?: string } {
  const stack: string[] = [];
  const pairs: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
  const opens = new Set(["(", "[", "{"]);
  let inStr: string | null = null;
  let esc = false;
  let lineComment = false;
  let blockComment = false;
  for (let i = 0; i < content.length; i++) {
    const c = content[i];
    if (lineComment) { if (c === "\n") lineComment = false; continue; }
    if (blockComment) { if (c === "*" && content[i + 1] === "/") { blockComment = false; i++; } continue; }
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === inStr) inStr = null;
      continue;
    }
    if (c === "/" && content[i + 1] === "/") { lineComment = true; i++; continue; }
    if (c === "/" && content[i + 1] === "*") { blockComment = true; i++; continue; }
    if (c === '"' || c === "'" || c === "`") { inStr = c; continue; }
    if (opens.has(c)) { stack.push(c); continue; }
    const expected = pairs[c];
    if (expected) {
      if (stack.length === 0 || stack[stack.length - 1] !== expected) {
        return { balanced: false, message: `unmatched "${c}"` };
      }
      stack.pop();
    }
  }
  if (inStr) return { balanced: false, message: "unterminated string / template literal" };
  if (stack.length > 0) return { balanced: false, message: `unclosed "${stack[stack.length - 1]}"` };
  return { balanced: true };
}

/**
 * Rough "where did the model mean?" context: finds the line that best matches
 * the first needle line and returns surrounding real lines, so failures show
 * the model what is ACTUALLY in the file.
 */
export function closestContext(content: string, oldText: string, around = 3): string[] {
  const lines = content.split("\n");
  const needle = oldText.split("\n").map((s) => s.trim()).filter((s) => s.length > 0);
  if (needle.length === 0) return [];
  const first = needle[0];
  const firstWords = first.split(/\s+/);
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t === first || t.startsWith(first) || first.startsWith(t)) {
      const start = Math.max(0, i - 1);
      return lines.slice(start, Math.min(lines.length, i + around)).map((l, k) => `  ${start + k + 1}| ${l}`);
    }
    const tw = t.split(/\s+/);
    let same = 0;
    while (same < Math.min(firstWords.length, tw.length) && firstWords[same] === tw[same]) same++;
    if (same >= (firstWords.length === 1 ? 1 : 2)) {
      const start = Math.max(0, i - 1);
      return lines.slice(start, Math.min(lines.length, i + around)).map((l, k) => `  ${start + k + 1}| ${l}`);
    }
  }
  return [];
}