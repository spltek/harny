/**
 * The MCP payload's two flags, read in ONE place.
 *
 * The host decorates each tool with what THIS session has decided (`off`) and with the per-tool
 * Analyze declaration (`analyzeFlag`). Two modules read them — the card (the `(N/M tools)` count) and
 * the tools popover (the draft it starts from) — and they used to carry a copy each, which is how the
 * same rule ends up agreeing with itself until one copy is edited.
 */

interface ToolFlagsLike {
  name: string;
  /** The host's flag: this session has the tool switched OFF. */
  off?: boolean;
  /** YOU declared it read-only in Analyze. */
  analyzeFlag?: boolean;
}

/** The tools this session has OFF, by name. */
export function offToolNames(tools: readonly ToolFlagsLike[] | undefined): Set<string> {
  return new Set((tools ?? []).filter((t) => t.off).map((t) => t.name));
}

/** The tools declared read-only in Analyze, by name. */
export function analyzeToolNames(tools: readonly ToolFlagsLike[] | undefined): Set<string> {
  return new Set((tools ?? []).filter((t) => t.analyzeFlag).map((t) => t.name));
}
