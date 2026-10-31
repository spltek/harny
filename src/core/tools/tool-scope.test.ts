import { describe, it, expect } from "vitest";
import {
  EMPTY_TOOL_SCOPE,
  declaresReadOnlyInAnalyze,
  mcpPrefix,
  normalizeToolScope,
  reconcileToolScope,
  scopeTools,
  toolScopeAllows,
  type ToolScope,
} from "./tool-scope";

const scope = (mcp: string[], off: string[] = [], analyze: string[] = []): ToolScope => ({ mcp, off, analyze });

describe("a session's tool scope", () => {
  it("decides MCP tools by SERVER, so switching one server off never touches another", () => {
    const s = scope(["files"]);
    expect(toolScopeAllows("mcp__files__read", s)).toBe(true);
    expect(toolScopeAllows("mcp__files__write", s)).toBe(true);
    expect(toolScopeAllows("mcp__git__commit", s)).toBe(false);
  });

  it("does not confuse a server with one whose name starts the same way", () => {
    // `files` must not open `filesystem`: the separator is part of the match.
    expect(toolScopeAllows("mcp__filesystem__read", scope(["files"]))).toBe(false);
    expect(toolScopeAllows("mcp__filesystem__read", scope(["filesystem"]))).toBe(true);
  });

  it("handles a server name that CONTAINS the separator", () => {
    // Names come from the config file, so `a__b` is a legal key. Matching on
    // `<prefix><server>__` is what keeps it working (a naive split on `__` would not).
    expect(toolScopeAllows("mcp__a__b__tool", scope(["a__b"]))).toBe(true);
  });

  it("leaves built-in tools alone unless they are named", () => {
    const s = scope([], ["Shell"]);
    expect(toolScopeAllows("Shell", s)).toBe(false);
    expect(toolScopeAllows("Read", s)).toBe(true);
    // The prefix is not a magic word: a built-in whose name merely LOOKS like an MCP one would be
    // matched by prefix — so the prefix belongs to the MCP manager alone (see the test below).
    expect(toolScopeAllows("mcpLike", s)).toBe(true);
  });

  it("an EMPTY scope means exactly what the product promises: all MCP off, all built-ins on", () => {
    for (const name of ["mcp__anything__at__all", "Read", "Shell", "Delegate"]) {
      expect(toolScopeAllows(name, EMPTY_TOOL_SCOPE)).toBe(name.startsWith("mcp__") ? false : true);
    }
  });

  it("an UNDECLARED scope restricts nothing (a session written before this existed)", () => {
    // undefined is not the same as empty: the feature must never retroactively hide a tool from
    // history that already ran with it.
    expect(toolScopeAllows("mcp__x__y", undefined)).toBe(true);
    expect(toolScopeAllows("Shell", undefined)).toBe(true);
    expect(scopeTools([{ name: "Shell" }, { name: "mcp__x__y" }], undefined).length).toBe(2);
  });

  it("filters a tool list without mutating it", () => {
    const tools = [{ name: "Read" }, { name: "Shell" }, { name: "mcp__files__read" }];
    const kept = scopeTools(tools, scope(["files"], ["Shell"]));
    expect(kept.map((t) => t.name)).toEqual(["Read", "mcp__files__read"]);
    expect(tools.length).toBe(3); // the input is untouched
  });
});

describe("reading a scope from the outside world", () => {
  it("takes a JSON string, an object, or nothing", () => {
    expect(normalizeToolScope('{"mcp":["a"],"off":["Shell"]}')).toEqual({ mcp: ["a"], off: ["Shell"], analyze: [] });
    expect(normalizeToolScope({ mcp: ["a"], off: [] })).toEqual({ mcp: ["a"], off: [], analyze: [] });
    expect(normalizeToolScope(undefined)).toBeUndefined();
    expect(normalizeToolScope(null)).toBeUndefined();
  });

  it("never throws on junk, and keeps only what it can use", () => {
    expect(normalizeToolScope("{not json")).toBeUndefined();
    expect(normalizeToolScope(42)).toBeUndefined();
    expect(normalizeToolScope({ mcp: "nope", off: 7 })).toEqual({ mcp: [], off: [], analyze: [] });
    expect(normalizeToolScope({ mcp: [1, " a ", "", null, "a"], off: ["Shell", " Shell "] })).toEqual({
      mcp: ["a"], // trimmed, deduplicated, junk dropped
      off: ["Shell"],
      analyze: [],
    });
  });

  it("reads the Analyze declarations too, and drops the junk ones", () => {
    expect(normalizeToolScope({ analyze: ["mcp__files__read", 7, "  ", " mcp__files__read "] })).toEqual({
      mcp: [],
      off: [],
      analyze: ["mcp__files__read"], // trimmed, deduplicated
    });
  });

  it("a row written BEFORE the key existed declares nothing — never a silent loosening", () => {
    // The strict answer: nothing is allowed in Analyze, so an upgrade cannot widen a session.
    expect(normalizeToolScope({ mcp: ["files"], off: [] })?.analyze).toEqual([]);
  });

  it("is STABLE: normalizing twice gives the same list order (no diff churn in the row)", () => {
    const once = normalizeToolScope('{"mcp":["b","a"],"off":["Shell","Shell"]}');
    expect(normalizeToolScope(once)).toEqual(once);
  });
});

describe("reconciling a stored scope with what exists now", () => {
  const known = { servers: ["files"], builtins: ["Read", "Shell"] };

  it("drops a server that is not installed any more, and a tool this build does not ship", () => {
    expect(reconcileToolScope(scope(["files", "gone"], ["Shell", "Removed"]), known)).toEqual({
      mcp: ["files"],
      off: ["Shell"],
      analyze: [],
    });
  });

  it("drops an Analyze declaration about a server that is gone — it must not revive on reinstall", () => {
    expect(reconcileToolScope(scope(["files"], [], ["mcp__files__read", "mcp__gone__x"]), known)).toEqual({
      mcp: ["files"],
      off: [],
      analyze: ["mcp__files__read"],
    });
  });

  it("says NOTHING when nothing would change — a loader must not rewrite the row for nothing", () => {
    expect(reconcileToolScope(scope(["files"], ["Shell"], ["mcp__files__read"]), known)).toBeUndefined();
    expect(reconcileToolScope(scope(["files"], ["Shell"]), known)).toBeUndefined();
    expect(reconcileToolScope(EMPTY_TOOL_SCOPE, known)).toBeUndefined();
    expect(reconcileToolScope(undefined, known)).toBeUndefined();
  });

  it("keeps an EMPTY scope empty instead of turning it into 'no scope'", () => {
    // Losing the empty array would silently re-enable every built-in tool.
    const reconciled = reconcileToolScope(scope(["gone"]), known);
    expect(reconciled).toEqual({ mcp: [], off: [], analyze: [] });
  });
});

describe("the Analyze declaration is the SESSION's", () => {
  it("answers for the exact registered name, and only for it", () => {
    const s = scope(["files"], [], ["mcp__files__read"]);
    expect(declaresReadOnlyInAnalyze("mcp__files__read", s)).toBe(true);
    expect(declaresReadOnlyInAnalyze("mcp__files__write", s)).toBe(false);
    expect(declaresReadOnlyInAnalyze("mcp__git__status", s)).toBe(false);
  });

  it("says NO for a session that declared nothing — Analyze is denied by default", () => {
    expect(declaresReadOnlyInAnalyze("mcp__files__read", EMPTY_TOOL_SCOPE)).toBe(false);
    expect(declaresReadOnlyInAnalyze("mcp__files__read", undefined)).toBe(false);
  });

  it("is an INCLUDE list: allowing one tool of a server does not allow its neighbours", () => {
    const s = scope(["files"], [], ["mcp__files__read"]);
    expect(declaresReadOnlyInAnalyze("mcp__files__read", s)).toBe(true);
    expect(declaresReadOnlyInAnalyze("mcp__files__delete", s)).toBe(false);
  });
});

describe("names are SANITIZED, and the scope must speak the same language", () => {
  it("a server whose name carries a dash can still be switched ON", () => {
    // The registry registers `mcp-server-git` as `mcp__mcp_server_git__…`: a scope holding the raw
    // name would never match, and the server would be permanently off — silently.
    expect(mcpPrefix("mcp-server-git")).toBe("mcp__mcp_server_git__");
    expect(toolScopeAllows("mcp__mcp_server_git__status", scope(["mcp-server-git"]))).toBe(true);
  });

  it("a TOOL whose name carries a dash is matched by its sanitized name, as the registry spells it", () => {
    expect(toolScopeAllows("mcp__files__read_file", scope(["files"], ["mcp__files__read_file"]))).toBe(false);
    expect(toolScopeAllows("mcp__files__read_file", scope(["files"]))).toBe(true);
  });
});
