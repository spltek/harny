/**
 * How a tool call is described in ONE line, without its payload.
 *
 * TWO callers need this and must agree: the transcript (next to the tool bubble)
 * and the COMPACTOR (which shows it to the summarizer). The second is why this
 * file exists — the summarizer used to receive a bare `[Tool result]` with no idea
 * which tool produced it or on what, so the state document it wrote could not name
 * a file that had been changed or a command that had been run. The webview already
 * knew how to describe a call; the compactor did not. Keeping ONE implementation
 * is the point: that drift is precisely what a second copy would reintroduce.
 *
 * The payload is NEVER included. A `Write` carries the ENTIRE file as an argument
 * and a `Read` carries the entire file as a result, so echoing arguments would
 * inflate the summarizer's input until the request could not be sent. The SIZE is
 * what matters there — that a file was written and how big, not the bytes.
 */

/** Lines in `text` (0 for an empty string). A single trailing newline does not
 * start a new line: a 80-line file ends with `\n` and is still 80 lines. */
function countLines(text: string): number {
  if (!text) return 0;
  const body = text.endsWith("\n") ? text.slice(0, -1) : text;
  let lines = 1;
  for (let i = 0; i < body.length; i++) if (body[i] === "\n") lines++;
  return lines;
}

/**
 * The SUBJECT of a tool call: the file path (file tools), the glob pattern
 * (Glob), the command (Shell), the search term (WebSearch), the url (WebFetch)
 * or the paths (ReadLints).
 */
export function toolArgTarget(args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const rec = args as Record<string, unknown>;
  if (typeof rec.glob_pattern === "string" && rec.glob_pattern) return rec.glob_pattern;
  if (typeof rec.path === "string" && rec.path) return rec.path;
  if (typeof rec.command === "string" && rec.command) return rec.command;
  if (typeof rec.search_term === "string" && rec.search_term) return rec.search_term;
  if (typeof rec.url === "string" && rec.url) return rec.url;
  if (Array.isArray(rec.paths)) {
    const list = rec.paths.filter((p): p is string => typeof p === "string");
    if (list.length > 0) return list.join(", ");
  }
  return undefined;
}

/**
 * The SIZE of the payload, where the payload IS the point of the call: how many
 * lines a `Write` put down, how many an `Edit` moved, what a `Delete` removed.
 * `undefined` when the call's meaning is already in its subject (a Read, a Grep).
 */
export function toolCallDetail(name: string, args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const rec = args as Record<string, unknown>;
  if (name === "Write" && typeof rec.contents === "string") {
    const lines = countLines(rec.contents);
    return `(${lines} line${lines === 1 ? "" : "s"})`;
  }
  // Edit uses oldText/newText, StrReplace uses old_string/new_string: same idea.
  const oldText =
    typeof rec.oldText === "string" ? rec.oldText : typeof rec.old_string === "string" ? rec.old_string : undefined;
  const newText =
    typeof rec.newText === "string" ? rec.newText : typeof rec.new_string === "string" ? rec.new_string : undefined;
  if (oldText !== undefined && newText !== undefined) {
    return `(+${countLines(newText)}/-${countLines(oldText)})`;
  }
  if (name === "Delegate") {
    const id = typeof rec.id === "string" && rec.id ? `"${rec.id}" ` : "";
    return `${id}→ ${String(rec.goal ?? "")
      .replace(/\s+/g, " ")
      .trim()}`.trim();
  }
  return undefined;
}

/** The subject is capped so a 40-path ReadLints cannot fill the span. */
const TARGET_MAX_CHARS = 120;

/**
 * The subject for the tools whose GENERIC target is the wrong one.
 *
 * The generic rule prefers `path`, which is right for the transcript: the header
 * shows the scope and the pattern sits in the argument block directly below. The
 * summarizer has no argument block, so `Grep src` would hide the ONE thing the
 * call was about — what was being searched for.
 */
function toolSubject(name: string, rec: Record<string, unknown>): string | undefined {
  if (name === "Grep") {
    const pattern = typeof rec.pattern === "string" && rec.pattern ? rec.pattern : undefined;
    if (!pattern) return undefined;
    const scope = typeof rec.path === "string" && rec.path ? rec.path : undefined;
    return scope ? `/${pattern}/ in ${scope}` : `/${pattern}/`;
  }
  if (name === "Skill" && typeof rec.name === "string" && rec.name) return rec.name;
  return undefined;
}

/** `Write src/foo.ts (240 lines)` — tool name, subject, size. Never the payload. */
export function describeToolCall(name: string, args: unknown): string {
  const rec = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
  const target = toolSubject(name, rec) ?? toolArgTarget(args);
  const shown = target && target.length > TARGET_MAX_CHARS ? `${target.slice(0, TARGET_MAX_CHARS)}…` : target;
  const detail = toolCallDetail(name, args);
  return [name, shown, detail].filter((p): p is string => !!p).join(" ");
}
