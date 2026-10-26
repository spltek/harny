import { describe, it, expect } from "vitest";
import { createDefaultTools } from "./create-default-tools";
import { SkillRegistry } from "../skills/skill-registry";
import { FakeHttpClient } from "../llm/http-client.test-utils";
import type { CommandRunner } from "./command-runner";
import type { DiagnosticsProvider } from "./diagnostics-provider";
import type { FileSystem } from "./file-system";

const fakeFs: FileSystem = {
  readText: () => "",
  readBytes: () => Buffer.alloc(0),
  writeText: () => {},
  exists: () => false,
  isDirectory: () => false,
  realpath: (p) => p,
  size: () => 0,
  mtimeMs: () => 0,
  mkdirRecursive: () => {},
  delete: () => {},
};
const fakeRunner: CommandRunner = {
  run: async () => ({ stdout: "", stderr: "", code: 0, timedOut: false }),
};
const fakeDiagnostics: DiagnosticsProvider = { getDiagnostics: () => [] };
const fakeSkills = new SkillRegistry(fakeFs, () => []);

describe("createDefaultTools", () => {
  it("every core tool DECLARES how it keeps Analyze's promise", () => {
    // The gate used to ask "is this name in a list of writers?" — which is blind to every
    // dynamic tool and, more importantly, deaf to a core tool that forgets to appear in
    // the list. Now each tool declares it, and production's default is `refuse`, so a tool
    // that declares nothing does not silently run in Analyze: THIS test is what keeps the
    // declarations honest, because a missing one is invisible there otherwise.
    const tools = createDefaultTools({
      fs: fakeFs,
      runner: fakeRunner,
      http: new FakeHttpClient(),
      diagnostics: fakeDiagnostics,
      cwd: () => "/workspace",
      skills: fakeSkills,
    });

    const table = Object.fromEntries(tools.map((t) => [t.name, t.analyzePolicy ?? "refuse"]));
    expect(table).toEqual({
      // Writes files and we own it: dry-run preview in Analyze, with the note that says so.
      Write: "preview",
      StrReplace: "preview",
      Edit: "preview",
      Delete: "preview",
      // A command may be `ls` or `rm -rf`: only the arguments say which.
      Shell: "guarded",
      // Inspect only: nothing outside the conversation is touched.
      Delegate: "read-only",
      Read: "read-only",
      Grep: "read-only",
      Glob: "read-only",
      ReadLints: "read-only",
      Skill: "read-only",
      TodoWrite: "read-only",
      WebSearch: "read-only",
      WebFetch: "read-only",
    });
    // The two facts are independent: read-only says nothing about being CACHEABLE.
    const cacheable = tools
      .filter((t) => t.cacheable)
      .map((t) => t.name)
      .sort();
    expect(cacheable).toEqual(["Glob", "Grep", "Read", "ReadLints", "Skill"]);
    // And the two tools whose behavior in Analyze needs explaining DO explain it.
    expect(tools.find((t) => t.name === "Write")!.analyzeNote).toContain("PREVIEW MODE (Analyze)");
    expect(tools.find((t) => t.name === "Shell")!.analyzeNote).toContain("READ-ONLY MODE");
    // A guarded tool carries its own per-call check, so the agent needs no name list.
    expect(typeof tools.find((t) => t.name === "Shell")!.guardAnalyze).toBe("function");
  });

  it("registers the standard tool set in a stable order", () => {
    const tools = createDefaultTools({
      fs: fakeFs,
      runner: fakeRunner,
      http: new FakeHttpClient(),
      diagnostics: fakeDiagnostics,
      cwd: () => "/workspace",
      skills: fakeSkills,
    });

    expect(tools.map((t) => t.name)).toEqual([
      "Delegate",
      "Read",
      "Write",
      "StrReplace",
      "Edit",
      "Delete",
      "Shell",
      "Grep",
      "Glob",
      "Skill",
      "TodoWrite",
      "WebSearch",
      "WebFetch",
      "ReadLints",
    ]);
  });

  it("exposes JSON-schema definitions for every tool", () => {
    const tools = createDefaultTools({
      fs: fakeFs,
      runner: fakeRunner,
      http: new FakeHttpClient(),
      diagnostics: fakeDiagnostics,
      cwd: () => "/workspace",
      skills: fakeSkills,
    });

    for (const t of tools) {
      expect(t.definition.name).toBe(t.name);
      expect(t.definition.description.length).toBeGreaterThan(0);
      expect(t.definition.parameters.type).toBe("object");
    }
  });
});
