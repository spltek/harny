import { describe, it, expect } from "vitest";
import type { CommandResult, CommandRunner } from "./command-runner";
import { ShellTool } from "./shell-tool";
import { GrepTool } from "./grep-tool";
import { GlobTool } from "./glob-tool";
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

  it("rejects the 'all' permission", () => {
    const runner = fakeRunner([]);
    const tool = new ShellTool(runner, cwd);

    const result = tool.execute({ command: "rm -rf /", required_permissions: ["all"] });

    expect(result.isError).toBe(true);
    expect(runner.calls).toHaveLength(0);
  });

  it("passes working_directory and timeout to the runner", () => {
    const runner = fakeRunner([{ stdout: "", stderr: "", code: 0, timedOut: false }]);
    const tool = new ShellTool(runner, cwd);

    tool.execute({ command: "ls", working_directory: "/tmp", block_until_ms: 5000 });

    expect(runner.calls[0].options).toEqual({ cwd: "/tmp", timeoutMs: 5000 });
  });
});

describe("GrepTool", () => {
  it("builds an rg command and returns matches", () => {
    const runner = fakeRunner([{ stdout: "/w/a.ts:3:foo\n/w/b.ts:1:foo", stderr: "", code: 0, timedOut: false }]);
    const tool = new GrepTool(runner, cwd);

    const result = tool.execute({ pattern: "foo", path: "/w", output_mode: "content" });

    expect(result.isError).toBe(false);
    expect(result.content).toContain("/w/a.ts:3:foo");
    expect(runner.calls[0].command).toContain("rg -n \"foo\" \"/w\"");
  });

  it("treats exit code 1 with no stderr as 'no matches'", () => {
    const runner = fakeRunner([{ stdout: "", stderr: "", code: 1, timedOut: false }]);
    const tool = new GrepTool(runner, cwd);

    const result = tool.execute({ pattern: "zzz" });

    expect(result.isError).toBe(false);
    expect(result.content).toBe("No matches found");
  });

  it("applies head_limit and offset", () => {
    const runner = fakeRunner([{ stdout: "1\n2\n3\n4", stderr: "", code: 0, timedOut: false }]);
    const tool = new GrepTool(runner, cwd);

    const result = tool.execute({ pattern: "x", offset: 1, head_limit: 2 });

    expect(result.content).toBe("2\n3\n\n[Showing 2-3 of at least 4 matches]");
  });

  it("errors when the pattern is missing", () => {
    const tool = new GrepTool(fakeRunner([]), cwd);
    expect(tool.execute({}).isError).toBe(true);
  });
});

describe("GlobTool", () => {
  it("auto-prepends **/ to non-glob patterns", () => {
    const runner = fakeRunner([{ stdout: "", stderr: "", code: 0, timedOut: false }]);
    const tool = new GlobTool(runner, fakeFs(), cwd);

    tool.execute({ glob_pattern: "*.ts" });

    expect(runner.calls[0].command).toContain('--glob "**/*.ts"');
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
