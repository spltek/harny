/**
 * Incremental parser for <think>…</think> / <reason>…</reason> blocks inside
 * streamed model text (Qwen and many local models embed reasoning this way).
 *
 * The parser is STATEFUL: a thinking block may open in one chunk and close in
 * a later one, so `feed()` must be called once per streamed text chunk, in
 * order. It returns per-chunk events so the caller can stream the two channels
 * (visible text vs. reasoning) to different sinks as they arrive.
 */
type ThinkingParseEvent = { kind: "text"; content: string } | { kind: "thinking"; content: string };

export class ThinkingTagParser {
  /** Text inside an open thinking block, waiting for its closing tag. */
  private buffer = "";
  /** Whether we are currently inside a thinking block. */
  private inThinking = false;

  feed(text: string): ThinkingParseEvent[] {
    const events: ThinkingParseEvent[] = [];
    let remaining = text;

    while (remaining.length > 0) {
      if (this.inThinking) {
        const closeIdx = remaining.indexOf("</think>");
        const closeReasonIdx = remaining.indexOf("</reason>");
        let closeTag = -1;
        let closeUseReason = false;
        if (closeIdx >= 0 && (closeReasonIdx < 0 || closeIdx < closeReasonIdx)) {
          closeTag = closeIdx;
        } else if (closeReasonIdx >= 0) {
          closeTag = closeReasonIdx;
          closeUseReason = true;
        }

        if (closeTag >= 0) {
          this.buffer += remaining.slice(0, closeTag);
          if (this.buffer.trim()) {
            events.push({ kind: "thinking", content: this.buffer });
          }
          this.buffer = "";
          this.inThinking = false;
          // Slice PAST the closing tag: "</think>" is 8 chars, "</reason>" 9.
          // Track WHICH tag was found (not just that a think tag exists), so
          // mixed output like "a</reason>b</think>" doesn't leak a stray ">".
          remaining = remaining.slice(closeTag + (closeUseReason ? 9 : 8));
        } else {
          this.buffer += remaining;
          remaining = "";
        }
      } else {
        const openIdx = remaining.indexOf("<think>");
        const openReasonIdx = remaining.indexOf("<reason>");
        let openTag = -1;
        let useReason = false;
        if (openIdx >= 0 && (openReasonIdx < 0 || openIdx < openReasonIdx)) {
          openTag = openIdx;
        } else if (openReasonIdx >= 0) {
          openTag = openReasonIdx;
          useReason = true;
        }

        if (openTag >= 0) {
          const before = remaining.slice(0, openTag);
          if (before) events.push({ kind: "text", content: before });
          this.inThinking = true;
          this.buffer = "";
          // Slice past "<think>" (7 chars) or "<reason>" (8 chars).
          remaining = remaining.slice(openTag + (useReason ? 8 : 7));
        } else {
          events.push({ kind: "text", content: remaining });
          remaining = "";
        }
      }
    }
    return events;
  }
}
