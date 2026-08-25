import { describe, it, expect } from "vitest";
import { createDefaultTools } from "./create-default-tools";
import { FakeHttpClient } from "../llm/http-client.test-utils";
import type { CommandRunner } from "./command-runner";
import type { DiagnosticsProvider } from "./diagnostics-provider";
import type { FileSystem } from "./file-system";

const fakeFs: FileSystem = {
  readText: () => "",
  writeText: () => {},
  exists: () => false,
  size: () => 0,
  mtimeMs: () => 0,
  mkdirRecursive: () => {},
  delete: () => {},
};
const fakeRunner: CommandRunner = {
  run: () => ({ stdout: "", stderr: "", code: 0, timedOut: false }),
};
const fakeDiagnostics: DiagnosticsProvider = { getDiagnostics: () => [] };

describe("createDefaultTools", () => {
  it("registers the standard tool set in a stable order", () => {
    const tools = createDefaultTools({
      fs: fakeFs,
      runner: fakeRunner,
      http: new FakeHttpClient(),
      diagnostics: fakeDiagnostics,
      cwd: () => "/workspace",
    });

    expect(tools.map((t) => t.name)).toEqual([
      "Read",
      "Write",
      "StrReplace",
      "Edit",
      "Delete",
      "Shell",
      "Grep",
      "Glob",
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
    });

    for (const t of tools) {
      expect(t.definition.name).toBe(t.name);
      expect(t.definition.description.length).toBeGreaterThan(0);
      expect(t.definition.parameters.type).toBe("object");
    }
  });
});
