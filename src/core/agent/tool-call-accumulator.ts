import type { StreamChunk } from "../llm/types";
import type { ToolCall } from "../tools/tool";

/**
 * Accumulates streamed tool-call fragments into complete ToolCall objects.
 * Emits at most one ToolCall per index (duplicate ends are ignored).
 */
export class ToolCallAccumulator {
  private calls = new Map<number, { id: string; name: string; args: string }>();

  handle(chunk: StreamChunk): ToolCall | undefined {
    switch (chunk.type) {
      case "tool_call_start": {
        this.calls.set(chunk.index, {
          id: chunk.id ?? `call_${chunk.index}`,
          name: chunk.name ?? "unknown",
          args: "",
        });
        return undefined;
      }
      case "tool_call_delta": {
        const entry = this.calls.get(chunk.index);
        if (entry) entry.args += chunk.delta;
        return undefined;
      }
      case "tool_call_end": {
        const entry = this.calls.get(chunk.index);
        if (!entry) return undefined;
        this.calls.delete(chunk.index);
        const res = parseToolArgs(entry.args);
        return {
          id: entry.id,
          name: entry.name,
          arguments: res.args,
          malformed: res.malformed,
        };
      }
      default:
        return undefined;
    }
  }
}

export interface ParsedToolArgs {
  args: Record<string, unknown>;
  /** True when no valid JSON could be produced (malformed/truncated/empty). */
  malformed: boolean;
}

/**
 * Parse streamed tool-call arguments into an object.
 *
 * Ladder, from least to most tolerant:
 *  1. direct JSON.parse of the whole text,
 *  2. extract the first {...} block (models often wrap args in prose/fences),
 *  3. repair truncated/incomplete JSON (unterminated strings / unbalanced
 *     braces/brackets) so a call cut off by a low reasoning budget still runs
 *     with its partial valid arguments instead of silently becoming {}.
 * Only when nothing parseable/repairable exists do we mark the call malformed
 * (arguments = {} + malformed = true), so the agent can give an explicit error
 * or a corrective hint instead of executing a tool with bogus empty args.
 */
export function parseToolArgs(raw: string): ParsedToolArgs {
  // A truly empty emission is a VALID call with no arguments (tools with no
  // required params), not a malformed one. Only non-empty, unparseable and
  // unrepairable content is flagged malformed.
  if (!raw || !raw.trim()) return { args: {}, malformed: false };

  const tryParse = (s: string): Record<string, unknown> | undefined => {
    const t = s.trim();
    if (!t) return undefined;
    try {
      const parsed = JSON.parse(t);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      /* ignore */
    }
    return undefined;
  };

  const block = raw.match(/\{[\s\S]*\}/)?.[0];

  // Direct + first-{...} parse.
  for (const cand of [raw, block].filter((s): s is string => !!s)) {
    const direct = tryParse(cand);
    if (direct) return { args: direct, malformed: false };
  }

  // Truncated/repairable JSON.
  for (const cand of [raw, block].filter((s): s is string => !!s)) {
    const repaired = repairJsonObject(cand);
    const p = repaired ? tryParse(repaired) : undefined;
    if (p) return { args: p, malformed: false };
  }

  return { args: {}, malformed: true };
}

/**
 * Repair incomplete JSON by balancing quotes and braces/brackets. Closes an
 * unterminated string, then closes unclosed arrays and objects in order.
 * Returns the repaired string, or undefined if even that cannot parse.
 */
function repairJsonObject(raw: string): string | undefined {
  const start = raw.indexOf("{");
  if (start === -1) return undefined;

  let depthBraces = 0;
  let depthBrackets = 0;
  let inString = false;
  let escaped = false;
  let rebuilt = "";

  for (const ch of raw.slice(start)) {
    if (inString) {
      rebuilt += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      rebuilt += ch;
      continue;
    }
    if (ch === "{") depthBraces++;
    else if (ch === "}") depthBraces = Math.max(0, depthBraces - 1);
    else if (ch === "[") depthBrackets++;
    else if (ch === "]") depthBrackets = Math.max(0, depthBrackets - 1);
    rebuilt += ch;
  }

  if (inString) rebuilt += '"'; // close an unterminated string value
  rebuilt += "]".repeat(depthBrackets);
  rebuilt += "}".repeat(depthBraces);

  try {
    const parsed = JSON.parse(rebuilt);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return rebuilt;
  } catch {
    return undefined;
  }
  return undefined;
}
