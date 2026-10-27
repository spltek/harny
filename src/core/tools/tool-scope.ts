/**
 * What ONE session is allowed to use, out of everything Harny has available.
 *
 * The MCP servers themselves are INSTALLED once, globally (see the config file): installing is a
 * machine-level fact. Which of them a conversation uses is a per-conversation decision, and so is
 * turning a built-in tool off — a session that is doing a careful edit does not want `Shell`, and
 * the session next to it may live on it.
 *
 * This module is a VALUE plus PURE FUNCTIONS: no config, no store, no manager. That is what makes
 * the rule testable on its own, and what lets every caller (the per-turn tool list, the panel, the
 * loader that reconciles a stale scope) share ONE definition of "allowed" instead of inventing
 * three.
 */
export interface ToolScope {
  /** MCP server names this session has switched ON. Empty = none of them (the default). */
  mcp: string[];
  /** Built-in tool names this session switched OFF. Empty = all of them available. */
  off: string[];
}

/** A session that has decided nothing yet: every built-in on, every MCP server off. */
export const EMPTY_TOOL_SCOPE: ToolScope = { mcp: [], off: [] };

/** The prefix MCP tools are registered under: `mcp__<server>__<tool>`. */
const MCP_PREFIX = "mcp__";

function cleanList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const name = item.trim();
    // Deduplicated and order-preserving: the list is a SET with a stable on-disk shape, so a
    // config written twice is byte-identical (no churn in the session row, no diff noise).
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

/**
 * Read a scope from anything (a config value, a JSON column, a message from the webview).
 *
 * Junk is DROPPED rather than trusted, and `undefined` means "nothing declared" so a caller can
 * tell "no scope" from "empty scope" — the first is a session written before this feature existed,
 * the second is a session whose user turned everything off on purpose.
 */
export function normalizeToolScope(raw: unknown): ToolScope | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === "string") {
    try {
      return normalizeToolScope(JSON.parse(raw));
    } catch {
      return undefined;
    }
  }
  if (typeof raw !== "object") return undefined;
  const rec = raw as Record<string, unknown>;
  return { mcp: cleanList(rec.mcp), off: cleanList(rec.off) };
}

/** True when this session may use `name`. */
export function toolScopeAllows(name: string, scope: ToolScope | undefined): boolean {
  if (!scope) return true; // no scope declared = nothing restricted (pre-feature session)
  // A tool named in `off` is off, whichever kind it is: the list holds built-in names AND
  // `mcp__server__tool` names, because a session may want a server without ONE of its tools.
  if (scope.off.includes(name)) return false;
  if (name.startsWith(MCP_PREFIX)) {
    // Matched against the ON list with the FULL prefix `<server>__`: a server whose name contains
    // `__` keeps working, and a near-miss (`files` vs `filesystem`) never matches.
    return scope.mcp.some((server) => name.startsWith(`${MCP_PREFIX}${server}__`));
  }
  return true;
}

/** The subset of `tools` this session may use. */
export function scopeTools<T extends { name: string }>(tools: readonly T[], scope: ToolScope | undefined): T[] {
  if (!scope) return [...tools];
  return tools.filter((t) => toolScopeAllows(t.name, scope));
}

export interface KnownTools {
  /** Server names that exist in the config RIGHT NOW. */
  servers: readonly string[];
  /** Built-in tool names the registry has RIGHT NOW. OMIT to leave the built-in half untouched
   *  (a runtime sweep knows the config, not the registry, and shipped tools do not vanish). */
  builtins?: readonly string[];
}

/**
 * Drop the names that no longer exist, so a session never carries a decision about something that
 * is gone (an uninstalled server, a tool this build does not ship).
 *
 * Returns `undefined` when NOTHING would change: a loader calls this on every open, and writing
 * unconditionally would rewrite the row (and wake the config watcher) for nothing.
 */
export function reconcileToolScope(scope: ToolScope | undefined, known: KnownTools): ToolScope | undefined {
  if (!scope) return undefined;
  const mcp = scope.mcp.filter((server) => known.servers.includes(server));
  const off = known.builtins ? scope.off.filter((tool) => known.builtins!.includes(tool)) : [...scope.off];
  if (mcp.length === scope.mcp.length && off.length === scope.off.length) return undefined;
  return { mcp, off };
}
