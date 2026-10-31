import { describe, expect, it } from "vitest";
import { isToolName, unknownToolMessage } from "./unknown-tool";

describe("a name that could be a tool name", () => {
  it("accepts what the registry and the MCP sanitiser actually spell", () => {
    for (const name of ["Read", "StrReplace", "ReadLints", "Delegate", "mcp__files__read_file", "mcp__a__b__tool"]) {
      expect(isToolName(name), name).toBe(true);
    }
  });

  it("rejects what was never a name — the case this file exists for", () => {
    // The real one, from a transcript: a provider handed over a second call whose name
    // carried part of the arguments. Nothing about it is a tool name.
    expect(isToolName('Greplike" string="true')).toBe(false);
    for (const name of ["Grep like", "Grep=x", "Grep\nRead", "Grep/Read", "", "x".repeat(65)]) {
      expect(isToolName(name), JSON.stringify(name)).toBe(false);
    }
  });
});

describe("the unknown-tool reply", () => {
  it("names a leaked ARGUMENTS fragment as such, and says how to emit a call", () => {
    const message = unknownToolMessage('Greplike" string="true', ["Read", "Grep"]);
    // The old reply ended here: the model could not learn that the NAME was the problem.
    expect(message.startsWith('Unknown tool: Greplike" string="true')).toBe(true);
    expect(message).toContain("not a tool name");
    expect(message).toContain("ARGUMENTS");
    expect(message).toContain("ONE call per tool");
    expect(message).toContain("Available tools: Read, Grep.");
  });

  it("tells a plausible-but-absent name apart from garbage", () => {
    const message = unknownToolMessage("FakeTool", ["Read"]);
    expect(message).toContain("Unknown tool: FakeTool");
    expect(message).toContain("No tool by that name is offered in this run.");
    expect(message).not.toContain("not a tool name");
    expect(message).toContain("Available tools: Read.");
  });

  it("omits the list when the turn offered no tool at all (a forced report)", () => {
    // A tool-less turn is a real state: the model must not be pointed at a list that was
    // never sent to it, or the diagnosis becomes a second wrong turn.
    const message = unknownToolMessage("Read", []);
    expect(message).toContain("Unknown tool: Read");
    expect(message).not.toContain("Available tools");
  });
});
