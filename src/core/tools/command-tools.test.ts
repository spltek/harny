import { describe, it, expect } from "vitest";
import type { CommandResult, CommandRunner } from "./command-runner";
import { ShellTool } from "./shell-tool";
import { GrepTool } from "./grep-tool";
import { GlobTool, globstarToRegex } from "./glob-tool";
import type { FileSystem } from "./file-system";

function fakeRunner(results: CommandResult[]): CommandRunner {
  const calls: Array<{ command: string; options: { cwd: string; timeoutMs: number } }> = [];
  return {
    calls,
    run(command, options) {
      calls.push({ command, options });
      return results.shift() ?? { stdout: "", stderr: "", code: 0, timedOut: false };
    },
  } as CommandRunner & { calls: typeof calls };
}

const cwd = () => "/workspace";

describe("ShellTool", () => {
  it("returns stdout on success", () => {
    const runner = fakeRunner([{ stdout: "hello", stderr: "", code: 0, timedOut: false }]);
    const tool = new ShellTool(runner, cwd);

    const result = tool.execute({ command: "echo hello" });

    expect(result.isError).toBe(false);
    expect(result.content).toBe("hello");
  });

  it("returns an error with stdout+stderr on non-zero exit", () => {
    const runner = fakeRunner([{ stdout: "out", stderr: "err", code: 2, timedOut: false }]);
    const tool = new ShellTool(runner, cwd);

    const result = tool.execute({ command: "false" });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("exited with code 2");
    expect(result.content).toContain("err");
  });

  it("reports timeouts", () => {
    const runner = fakeRunner([{ stdout: "", stderr: "", code: -1, timedOut: true }]);
    const tool = new ShellTool(runner, cwd);

    const result = tool.execute({ command: "sleep 100" });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("timed out");
  });

  it("keeps stderr on SUCCESS (exit 0) — warnings must not vanish", () => {
    const runner = fakeRunner([{ stdout: "done", stderr: "npm warn deprecated x", code: 0, timedOut: false }]);
    const tool = new ShellTool(runner, cwd);

    const result = tool.execute({ command: "npm install" });

    expect(result.isError).toBe(false);
    expect(result.content).toContain("done");
    expect(result.content).toContain("npm warn deprecated x");
  });

  it("ignores legacy permission arguments (no sandbox or permission gate)", () => {
    const runner = fakeRunner([{ stdout: "ok", stderr: "", code: 0, timedOut: false }]);
    const tool = new ShellTool(runner, cwd);

    const result = tool.execute({ command: "echo ok", required_permissions: ["all"] });

    // harny has no sandbox: the command runs as-is and the permission request
    // is inert (it is not part of the schema the model sees).
    expect(result.isError).toBe(false);
    expect(runner.calls).toHaveLength(1);
  });

  it("passes working_directory and timeout to the runner", () => {
    const runner = fakeRunner([{ stdout: "", stderr: "", code: 0, timedOut: false }]);
    const tool = new ShellTool(runner, cwd);

    tool.execute({ command: "ls", working_directory: "/tmp", block_until_ms: 5000 });

    expect(runner.calls[0].options).toEqual({ cwd: "/tmp", timeoutMs: 5000 });
  });
});

describe("GrepTool", () => {
  // fs that reports the search path as existing (the tool pre-checks it now)
  const existingFs = { ...fakeFs(), exists: () => true };

  it("builds an rg command and returns matches", () => {
    const runner = fakeRunner([{ stdout: "/w/a.ts:3:foo\n/w/b.ts:1:foo", stderr: "", code: 0, timedOut: false }]);
    const tool = new GrepTool(runner, existingFs, cwd);

    const result = tool.execute({ pattern: "foo", path: "/w", output_mode: "content" });

    expect(result.isError).toBe(false);
    expect(result.content).toContain("/w/a.ts:3:foo");
    expect(runner.calls[0].command).toContain("rg -n \"foo\" \"/w\"");
  });

  it("treats exit code 1 as 'no matches'", () => {
    const runner = fakeRunner([{ stdout: "", stderr: "", code: 1, timedOut: false }]);
    const tool = new GrepTool(runner, fakeFs(), cwd);

    const result = tool.execute({ pattern: "zzz" });

    expect(result.isError).toBe(false);
    expect(result.content).toBe("No matches found");
  });

  it("errors explicitly when the target path does not exist", () => {
    const fs: FileSystem = { ...fakeFs(), exists: () => false };
    const tool = new GrepTool(fakeRunner([]), fs, cwd);

    const result = tool.execute({ pattern: "foo", path: "/nope/missing" });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Path not found");
  });

  it("surfaces real rg errors (exit code 2) instead of 'no matches'", () => {
    const runner = fakeRunner([{ stdout: "rg: error parsing regex: unexpected '('", stderr: "", code: 2, timedOut: false }]);
    const tool = new GrepTool(runner, existingFs, cwd);

    const result = tool.execute({ pattern: "(", path: "/w" });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("error parsing regex");
  });

  it("quotes the glob filter (no shell word-splitting/expansion)", () => {
    const runner = fakeRunner([{ stdout: "a.txt:1:riga", stderr: "", code: 0, timedOut: false }]);
    const tool = new GrepTool(runner, existingFs, cwd);

    tool.execute({ pattern: "riga", path: "/w", glob: "*.txt" });

    expect(runner.calls[0].command).toContain('--glob="*.txt"');
  });

  it("applies head_limit and offset", () => {
    const runner = fakeRunner([{ stdout: "1\n2\n3\n4", stderr: "", code: 0, timedOut: false }]);
    const tool = new GrepTool(runner, fakeFs(), cwd);

    const result = tool.execute({ pattern: "x", offset: 1, head_limit: 2 });

    expect(result.content).toBe("2\n3\n\n[Showing 2-3 of at least 4 matches]");
  });

  it("errors when the pattern is missing", () => {
    const tool = new GrepTool(fakeRunner([]), fakeFs(), cwd);
    expect(tool.execute({}).isError).toBe(true);
  });
});

describe("GlobTool", () => {
  it("auto-prepends **/ to non-glob patterns and matches full paths", () => {
    const runner = fakeRunner([{ stdout: "", stderr: "", code: 0, timedOut: false }]);
    const tool = new GlobTool(runner, fakeFs(), cwd);

    tool.execute({ glob_pattern: "*.ts" });

    expect(runner.calls[0].command).toContain('--glob --full-path "**/*.ts"');
    // find fallback must not rely on find -path (no globstar)
    expect(runner.calls[0].command).toContain("grep -E");
  });

  it("sorts results by modification time", () => {
    const fs: FileSystem = {
      ...fakeFs(),
      exists: () => true,
      mtimeMs: (p) => (p.includes("old") ? 100 : 200),
    };
    const runner = fakeRunner([{ stdout: "old.ts\nnew.ts", stderr: "", code: 0, timedOut: false }]);
    const tool = new GlobTool(runner, fs, cwd);

    const result = tool.execute({ glob_pattern: "**/*.ts" });

    expect(result.content).toBe("new.ts\nold.ts");
  });

  it("returns 'No files found' on empty output", () => {
    const runner = fakeRunner([{ stdout: "", stderr: "", code: 0, timedOut: false }]);
    const tool = new GlobTool(runner, fakeFs(), cwd);

    const result = tool.execute({ glob_pattern: "*.ts" });

    expect(result.isError).toBe(false);
    expect(result.content).toBe("No files found");
  });

  describe("globstarToRegex", () => {
    // mirrors the tool's usage: relative patterns get a leading .*, anchored at $
    const re = (g: string) => new RegExp(".*" + globstarToRegex(g) + "$");

    it("a/**/b matches a/b (zero dirs) and deeper paths", () => {
      expect(re("a/**/b").test("a/b")).toBe(true);
      expect(re("a/**/b").test("a/x/b")).toBe(true);
      expect(re("a/**/b").test("a/x/y/b")).toBe(true);
      expect(re("a/**/b").test("b")).toBe(false);
      expect(re("a/**/b").test("a/bx")).toBe(false);
    });

    it("a/**/*.ts matches files directly in a/ and in subdirs", () => {
      expect(re("a/**/*.ts").test("a/f.ts")).toBe(true);
      expect(re("a/**/*.ts").test("a/x/f.ts")).toBe(true);
      expect(re("a/**/*.ts").test("root.ts")).toBe(false);
    });

    it("single * stays inside one path component", () => {
      expect(re("a/*.ts").test("a/f.ts")).toBe(true);
      expect(re("a/*.ts").test("a/x/f.ts")).toBe(false);
    });

    it("trailing ** matches zero or more levels", () => {
      expect(re("src/**").test("src/a.ts")).toBe(true);
      expect(re("src/**").test("src/x/a.ts")).toBe(true);
      expect(re("src/**").test("other/a.ts")).toBe(false);
    });

    it("anchors to the end of the path (no substring false positives)", () => {
      expect(re("a/**/b").test("a/bx")).toBe(false);
      expect(re("a/**/b").test("x/a/b")).toBe(true);
      expect(re("*.ts").test("a/foo.ts.bak")).toBe(false);
    });

    it("escapes regex specials in literals (no char-class expansion)", () => {
      // [1] is literal: matches the file literally named "f[1].txt"
      expect(re("v1.0/**/f[1].txt").test("v1.0/f[1].txt")).toBe(true);
      expect(re("v1.0/**/f[1].txt").test("v1.0/f1.txt")).toBe(false);
    });

    it("expands brace alternation {a,b}", () => {
      expect(re("**/*.{js,txt}").test("a/f.js")).toBe(true);
      expect(re("**/*.{js,txt}").test("a/f.txt")).toBe(true);
      expect(re("**/*.{js,txt}").test("a/f.py")).toBe(false);
      expect(re("v1.{0,1}/x").test("v1.1/x")).toBe(true);
      expect(re("v1.{0,1}/x").test("v1.2/x")).toBe(false);
    });
  });
});

function fakeFs(): FileSystem {
  return {
    readText: () => "",
    writeText: () => {},
    exists: () => false,
    size: () => 0,
    mtimeMs: () => 0,
    mkdirRecursive: () => {},
    delete: () => {},
  };
}
