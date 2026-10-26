import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandResult, CommandRunner } from "./command-runner";
import { ShellTool } from "./shell-tool";
import { GrepTool } from "./grep-tool";
import { GlobTool, globstarToRegex } from "./glob-tool";
import { nodeFileSystem, type FileSystem } from "./file-system";

function fakeRunner(results: CommandResult[]): CommandRunner {
  const calls: Array<{ command: string; options: { cwd: string; timeoutMs: number } }> = [];
  return {
    calls,
    async run(command, options) {
      calls.push({ command, options });
      return results.shift() ?? { stdout: "", stderr: "", code: 0, timedOut: false };
    },
  } as CommandRunner & { calls: typeof calls };
}

const cwd = () => "/workspace";

/** In-memory FileSystem: `{ "/w/a.ts": "content" }`. Directories are derived
 * from the file paths, so Glob/Grep can be tested WITHOUT a real disk (and
 * therefore identically on every OS). */
function memFs(files: Record<string, string>, mtimes: Record<string, number> = {}): FileSystem {
  const norm = (p: string): string => p.replace(/^[A-Za-z]:/, "").replace(/\\/g, "/");
  const dirs = new Set<string>();
  for (const p of Object.keys(files)) {
    const parts = p.split("/");
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
  }
  return {
    readText: (p) => {
      const k = norm(p);
      if (!(k in files)) throw new Error(`ENOENT: ${k}`);
      return files[k];
    },
    readBytes: (p) => Buffer.from(files[norm(p)] ?? "", "utf-8"),
    writeText: () => {},
    exists: (p) => {
      const k = norm(p);
      return k in files || dirs.has(k);
    },
    isDirectory: (p) => dirs.has(norm(p)),
    realpath: (p) => p,
    list: (d) => {
      const k = norm(d);
      if (!dirs.has(k)) return [];
      const prefix = k.endsWith("/") ? k : k + "/";
      const out = new Set<string>();
      for (const p of [...Object.keys(files), ...dirs]) {
        if (!p.startsWith(prefix)) continue;
        const rest = p.slice(prefix.length);
        if (rest) out.add(rest.split("/")[0]);
      }
      return [...out];
    },
    size: (p) => (files[norm(p)] ?? "").length,
    mtimeMs: (p) => mtimes[norm(p)] ?? 0,
    mkdirRecursive: () => {},
    delete: () => {},
  };
}

describe("ShellTool", () => {
  it("returns stdout on success", async () => {
    const runner = fakeRunner([{ stdout: "hello", stderr: "", code: 0, timedOut: false }]);
    const tool = new ShellTool(runner, cwd);

    const result = await tool.execute({ command: "echo hello" });

    expect(result.isError).toBe(false);
    expect(result.content).toBe("hello");
  });

  it("returns an error with stdout+stderr on non-zero exit", async () => {
    const runner = fakeRunner([{ stdout: "out", stderr: "err", code: 2, timedOut: false }]);
    const tool = new ShellTool(runner, cwd);

    const result = await tool.execute({ command: "false" });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("exited with code 2");
    expect(result.content).toContain("err");
  });

  it("reports timeouts", async () => {
    const runner = fakeRunner([{ stdout: "", stderr: "", code: -1, timedOut: true }]);
    const tool = new ShellTool(runner, cwd);

    const result = await tool.execute({ command: "sleep 100" });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("timed out");
  });

  it("reports a user abort (Stop) distinctly from a timeout", async () => {
    const runner = fakeRunner([{ stdout: "", stderr: "", code: -1, timedOut: false, aborted: true }]);
    const tool = new ShellTool(runner, cwd);

    const result = await tool.execute({ command: "sleep 100" });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("aborted");
  });

  it("clamps block_until_ms to the hard ceiling (a model cannot freeze the host)", async () => {
    const runner = fakeRunner([{ stdout: "", stderr: "", code: 0, timedOut: false }]);
    const tool = new ShellTool(runner, cwd);

    await tool.execute({ command: "ls", block_until_ms: 99_999_999 });

    expect(runner.calls[0].options.timeoutMs).toBe(300_000);
    await tool.execute({ command: "ls", block_until_ms: 10 });
    expect(runner.calls[1].options.timeoutMs).toBe(1000);
  });

  it("keeps stderr on SUCCESS (exit 0) — warnings must not vanish", async () => {
    const runner = fakeRunner([{ stdout: "done", stderr: "npm warn deprecated x", code: 0, timedOut: false }]);
    const tool = new ShellTool(runner, cwd);

    const result = await tool.execute({ command: "npm install" });

    expect(result.isError).toBe(false);
    expect(result.content).toContain("done");
    expect(result.content).toContain("npm warn deprecated x");
  });

  it("caps the output to the MODEL's window, not to a constant", async () => {
    // The same command, two models: on a small local model the result is cut much
    // earlier, because 50KB (~12k tokens) would be its WHOLE context — and this is
    // the newest result, so masking cannot touch it.
    const stdout = Array.from({ length: 4000 }, (_, i) => `line ${i} of a long listing`).join("\n");
    // The fake runner hands out its results in order (one per call), so the three
    // executions below need three entries.
    const once = { stdout, stderr: "", code: 0, timedOut: false };
    const runner = fakeRunner([{ ...once }, { ...once }, { ...once }]);
    const tool = new ShellTool(runner, cwd);

    const small = await tool.execute({ command: "ls" }, { contextBudget: 8_000 });
    const big = await tool.execute({ command: "ls" }, { contextBudget: 1_000_000 });

    expect(small.content.length).toBeLessThan(big.content.length);
    expect(small.content).toContain("truncated at 3KB"); // 10% of 8k tokens × 4 chars
    expect(small.content).toMatch(/narrower|head\/tail\/grep/); // and what to do about it
    expect(big.content).toContain("truncated at 50KB"); // the ceiling a big model keeps
    // No budget (a tool used outside a session): the old behaviour, exactly.
    const noBudget = await tool.execute({ command: "ls" });
    expect(noBudget.content).toContain("truncated at 50KB");
  });

  it("collapses runs of identical lines BEFORE the output cap", async () => {
    const runner = fakeRunner([{ stdout: "riga di output\n".repeat(100), stderr: "", code: 0, timedOut: false }]);
    const tool = new ShellTool(runner, cwd);

    const result = await tool.execute({ command: 'yes "riga di output" | head -c 200000' });

    expect(result.isError).toBe(false);
    expect(result.content).toContain("riga di output");
    expect(result.content).toContain("… [99 identical lines collapsed]");
    expect(result.content.length).toBeLessThan(200); // not 50KB of copies
  });

  it("ignores legacy permission arguments (no sandbox or permission gate)", async () => {
    const runner = fakeRunner([{ stdout: "ok", stderr: "", code: 0, timedOut: false }]);
    const tool = new ShellTool(runner, cwd);

    const result = await tool.execute({ command: "echo ok", required_permissions: ["all"] });

    // harny has no sandbox: the command runs as-is and the permission request
    // is inert (it is not part of the schema the model sees).
    expect(result.isError).toBe(false);
    expect(runner.calls).toHaveLength(1);
  });

  it("passes working_directory and timeout to the runner", async () => {
    const runner = fakeRunner([{ stdout: "", stderr: "", code: 0, timedOut: false }]);
    const tool = new ShellTool(runner, cwd);

    await tool.execute({ command: "ls", working_directory: "/tmp", block_until_ms: 5000 });

    expect(runner.calls[0].options).toEqual({ cwd: "/tmp", timeoutMs: 5000 });
  });
});

describe("GrepTool (pure Node, cross-platform)", () => {
  it("returns matches as path:line:text", async () => {
    const fs = memFs({ "/w/a.ts": "a\nb\nfoo\n", "/w/b.ts": "foo\n", "/w/c.txt": "bar\n" });
    const tool = new GrepTool(fs, cwd);

    const result = await tool.execute({ pattern: "foo", path: "/w", output_mode: "content" });

    expect(result.isError).toBe(false);
    expect(result.content).toContain("/w/a.ts:3:foo");
    expect(result.content).toContain("/w/b.ts:1:foo");
    expect(result.content).not.toContain("/w/c.txt");
  });

  it("treats a missing match as 'No matches found'", async () => {
    const fs = memFs({ "/w/a.ts": "hello\n" });
    const tool = new GrepTool(fs, cwd);

    const result = await tool.execute({ pattern: "zzz", path: "/w" });

    expect(result.isError).toBe(false);
    expect(result.content).toBe("No matches found");
  });

  it("hints when hidden entries were skipped by a zero-match DIRECTORY search", async () => {
    const fs = memFs({ "/w/file.txt": "nothing\n", "/w/.hidden": "x\n", "/w/.config": "y\n" });
    const tool = new GrepTool(fs, cwd);

    const result = await tool.execute({ pattern: "hidden", path: "/w" });

    expect(result.content).toContain("No matches found");
    expect(result.content).toContain("2 hidden entries");
    expect(result.content).toContain('"hidden": true');
  });

  it("stays clean ('No matches found') when a directory has NO hidden entries", async () => {
    const fs = memFs({ "/w/file.txt": "nothing\n", "/w/src/main.ts": "nothing\n" });
    const tool = new GrepTool(fs, cwd);

    const result = await tool.execute({ pattern: "hidden", path: "/w" });

    expect(result.content).toBe("No matches found");
  });

  it("searches hidden files when hidden: true", async () => {
    const fs = memFs({ "/w/.hidden": "x\n" });
    const tool = new GrepTool(fs, cwd);

    const result = await tool.execute({ pattern: "x", path: "/w", hidden: true });

    expect(result.content).toContain("/w/.hidden:1:x");
  });

  it("errors explicitly when the target path does not exist", async () => {
    const fs = memFs({ "/w/a.ts": "x\n" });
    const tool = new GrepTool(fs, cwd);

    const result = await tool.execute({ pattern: "foo", path: "/nope/missing" });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Path not found");
  });

  it("skips a single binary file explicitly (no fake 'No matches')", async () => {
    const fs = memFs({ "/w/bin": "abc\u0000\u0001\u0002def" });
    const tool = new GrepTool(fs, cwd);

    const result = await tool.execute({ pattern: "x", path: "/w/bin" });

    expect(result.isError).toBe(false);
    expect(result.content).toContain("skipped binary file");
  });

  it("surfaces a bad regex as an error instead of 'no matches'", async () => {
    const fs = memFs({ "/w/a.ts": "x\n" });
    const tool = new GrepTool(fs, cwd);

    const result = await tool.execute({ pattern: "(", path: "/w" });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("error parsing regex");
  });

  it("filters files by glob", async () => {
    const fs = memFs({ "/w/a.txt": "riga\n", "/w/b.ts": "riga\n" });
    const tool = new GrepTool(fs, cwd);

    const result = await tool.execute({ pattern: "riga", path: "/w", glob: "*.txt" });

    expect(result.content).toContain("/w/a.txt:1:riga");
    expect(result.content).not.toContain("b.ts");
  });

  it("filters files by type", async () => {
    const fs = memFs({ "/w/a.ts": "TODO\n", "/w/b.py": "TODO\n" });
    const tool = new GrepTool(fs, cwd);

    const result = await tool.execute({ pattern: "TODO", path: "/w", type: "ts" });

    expect(result.content).toContain("a.ts");
    expect(result.content).not.toContain("b.py");
  });

  it("is case-insensitive with -i", async () => {
    const fs = memFs({ "/w/a.ts": "Foo\n" });
    const tool = new GrepTool(fs, cwd);

    expect((await tool.execute({ pattern: "foo", path: "/w", "-i": true })).content).toContain("Foo");
    expect((await tool.execute({ pattern: "foo", path: "/w" })).content).toBe("No matches found");
  });

  it("lists matching files in files_with_matches mode", async () => {
    const fs = memFs({ "/w/a.ts": "foo\nfoo\n", "/w/b.ts": "bar\n" });
    const tool = new GrepTool(fs, cwd);

    const result = await tool.execute({ pattern: "foo", path: "/w", output_mode: "files_with_matches" });

    expect(result.content).toBe("/w/a.ts");
  });

  it("counts per file in count mode", async () => {
    const fs = memFs({ "/w/a.ts": "foo\nfoo\nbar\nfoo\n", "/w/b.ts": "foo\n" });
    const tool = new GrepTool(fs, cwd);

    const result = await tool.execute({ pattern: "foo", path: "/w", output_mode: "count" });

    expect(result.content).toContain("/w/a.ts:3");
    expect(result.content).toContain("/w/b.ts:1");
  });

  it("shows context lines with -C", async () => {
    const fs = memFs({ "/w/a.ts": "l1\nl2\nfoo\nl4\nl5\n" });
    const tool = new GrepTool(fs, cwd);

    const result = await tool.execute({ pattern: "foo", path: "/w", "-C": 1 });

    expect(result.content).toContain("/w/a.ts:3:foo");
    expect(result.content).toContain("/w/a.ts-2-l2"); // before, '-' separator
    expect(result.content).toContain("/w/a.ts-4-l4"); // after
  });

  it("applies head_limit and offset", async () => {
    const fs = memFs({ "/w/a.ts": "m1\nm2\nm3\nm4\n" });
    const tool = new GrepTool(fs, cwd);

    const result = await tool.execute({ pattern: "m", path: "/w", offset: 1, head_limit: 2 });

    expect(result.content).toContain("[Showing 2-3 of at least 4 matches]");
    expect(result.content).toContain("/w/a.ts:2:m2");
    expect(result.content).not.toContain("m1");
    expect(result.content).not.toContain("m4");
  });

  it("uses ':' for a match line even when reached as another match's context, and '-' for context", async () => {
    const fs = memFs({ "/w/a.ts": "x\nm2\nm3\n" });
    const tool = new GrepTool(fs, cwd);

    const result = await tool.execute({ pattern: "m", path: "/w", "-C": 1 });

    expect(result.content).toContain("/w/a.ts:2:m2");
    expect(result.content).toContain("/w/a.ts:3:m3"); // match → ':' (not '-')
    expect(result.content).toContain("/w/a.ts-1-x"); // context → '-'
    expect(result.content).not.toContain("/w/a.ts-3-m3");
  });

  it("inserts a '--' separator between non-adjacent context groups", async () => {
    const fs = memFs({ "/w/a.ts": "m1\nx\nx\nx\nm5\n" });
    const tool = new GrepTool(fs, cwd);

    const result = await tool.execute({ pattern: "m", path: "/w", "-C": 1 });

    expect(result.content).toContain("--");
    expect(result.content).toContain("/w/a.ts:5:m5");
  });

  it("supports -A and -B independently", async () => {
    const fs = memFs({ "/w/a.ts": "a\nfoo\nb\n" });
    const tool = new GrepTool(fs, cwd);

    expect((await tool.execute({ pattern: "foo", path: "/w", "-A": 1 })).content).toContain("/w/a.ts-3-b");
    expect((await tool.execute({ pattern: "foo", path: "/w", "-B": 1 })).content).toContain("/w/a.ts-1-a");
  });

  it("matches across lines ONLY in multiline mode", async () => {
    const fs = memFs({ "/w/a.ts": "foo\nbar\n" });
    const tool = new GrepTool(fs, cwd);

    expect((await tool.execute({ pattern: "foo\\nbar", path: "/w" })).content).toBe("No matches found");
    expect((await tool.execute({ pattern: "foo\\nbar", path: "/w", multiline: true })).content).toContain("a.ts:1");
  });

  it("handles CRLF files (line numbers and matches)", async () => {
    const fs = memFs({ "/w/a.ts": "l1\r\nfoo\r\nl3\r\n" });
    const tool = new GrepTool(fs, cwd);

    expect((await tool.execute({ pattern: "foo", path: "/w" })).content).toContain("/w/a.ts:2:foo");
  });

  it("supports regex alternation and anchors on empty lines", async () => {
    const fs = memFs({ "/w/a.ts": "foo\nbar\n\nbaz\n" });
    const tool = new GrepTool(fs, cwd);

    expect((await tool.execute({ pattern: "foo|baz", path: "/w" })).content).toContain("a.ts:1:foo");
    expect((await tool.execute({ pattern: "foo|baz", path: "/w" })).content).toContain("a.ts:4:baz");
    expect((await tool.execute({ pattern: "^$", path: "/w" })).content).toContain("/w/a.ts:3:");
  });

  it("skips node_modules and other heavy dirs while walking", async () => {
    const fs = memFs({ "/w/node_modules/x.ts": "foo\n", "/w/src/y.ts": "foo\n" });
    const tool = new GrepTool(fs, cwd);

    const result = await tool.execute({ pattern: "foo", path: "/w" });

    expect(result.content).toContain("src/y.ts");
    expect(result.content).not.toContain("node_modules");
  });

  it("expands brace globs {ts,tsx}", async () => {
    const fs = memFs({ "/w/a.ts": "foo\n", "/w/b.tsx": "foo\n", "/w/c.md": "foo\n" });
    const tool = new GrepTool(fs, cwd);

    const result = await tool.execute({ pattern: "foo", path: "/w", glob: "*.{ts,tsx}" });

    expect(result.content).toContain("a.ts");
    expect(result.content).toContain("b.tsx");
    expect(result.content).not.toContain("c.md");
  });

  it("errors on an unknown --type", async () => {
    const tool = new GrepTool(memFs({ "/w/a.ts": "x\n" }), cwd);
    expect((await tool.execute({ pattern: "x", path: "/w", type: "nope" })).isError).toBe(true);
  });

  it("reports 'No matches found' for files_with_matches / count with zero hits", async () => {
    const fs = memFs({ "/w/a.ts": "bar\n" });
    const tool = new GrepTool(fs, cwd);

    expect((await tool.execute({ pattern: "zzz", path: "/w", output_mode: "files_with_matches" })).content).toBe(
      "No matches found",
    );
    expect((await tool.execute({ pattern: "zzz", path: "/w", output_mode: "count" })).content).toBe("No matches found");
  });

  it("head_limit 0 says nothing was shown instead of '[Showing 1-0 …]'", async () => {
    const fs = memFs({ "/w/a.ts": "m\n" });
    const tool = new GrepTool(fs, cwd);

    const result = await tool.execute({ pattern: "m", path: "/w", head_limit: 0 });

    expect(result.content).toContain("Showing 0 of at least 1");
  });

  it("searches a single FILE target and reports its path", async () => {
    const fs = memFs({ "/w/a.ts": "one\ntwo\n" });
    const tool = new GrepTool(fs, cwd);

    const result = await tool.execute({ pattern: "two", path: "/w/a.ts" });

    expect(result.content).toContain("/w/a.ts:2:two");
  });

  it("skips binary files encountered during a directory walk", async () => {
    const fs = memFs({ "/w/a.ts": "foo\n", "/w/bin.dat": "a\u0000foo" });
    const tool = new GrepTool(fs, cwd);

    const result = await tool.execute({ pattern: "foo", path: "/w" });

    expect(result.content).toContain("a.ts");
    expect(result.content).not.toContain("bin.dat");
  });

  it("errors when the pattern is missing", async () => {
    const tool = new GrepTool(memFs({}), cwd);
    expect((await tool.execute({})).isError).toBe(true);
  });

  it("works against the REAL filesystem (validates isDirectory + walk)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harny-globgrep-"));
    try {
      mkdirSync(join(dir, "src"), { recursive: true });
      writeFileSync(join(dir, "src", "a.ts"), "hello\nfoo\n");
      writeFileSync(join(dir, "b.md"), "foo\n");
      const glob = new GlobTool(nodeFileSystem, () => dir);
      const grep = new GrepTool(nodeFileSystem, () => dir);

      const globbed = await glob.execute({ glob_pattern: "*.ts" });
      expect(globbed.content).toContain("src/a.ts");
      expect(globbed.content).not.toContain("b.md");

      const grepped = await grep.execute({ pattern: "foo", glob: "*.ts" });
      expect(grepped.content).toContain("foo");
      expect(grepped.content).toContain("src/a.ts");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("GlobTool (pure Node, cross-platform)", () => {
  it("auto-prepends **/ and matches relative-to-root paths", () => {
    const fs = memFs({ "/workspace/src/main.ts": "", "/workspace/readme.md": "" });
    const tool = new GlobTool(fs, cwd);

    const result = tool.execute({ glob_pattern: "*.ts" });

    expect(result.content).toContain("main.ts");
    expect(result.content).not.toContain("readme.md");
  });

  it("sorts results by modification time (newest first)", () => {
    const fs = memFs(
      { "/workspace/old.ts": "", "/workspace/new.ts": "" },
      { "/workspace/old.ts": 100, "/workspace/new.ts": 200 },
    );
    const tool = new GlobTool(fs, cwd);

    const result = tool.execute({ glob_pattern: "**/*.ts" });

    expect(result.content).toBe("/workspace/new.ts\n/workspace/old.ts");
  });

  it("returns 'No files found' on no match", () => {
    const fs = memFs({ "/workspace/a.md": "" });
    const tool = new GlobTool(fs, cwd);

    const result = tool.execute({ glob_pattern: "*.ts" });

    expect(result.isError).toBe(false);
    expect(result.content).toBe("No files found");
  });

  it("skips hidden files by default (fd/rg default)", () => {
    const fs = memFs({ "/workspace/.hidden.ts": "", "/workspace/a.ts": "" });
    const tool = new GlobTool(fs, cwd);

    const result = tool.execute({ glob_pattern: "*.ts" });

    expect(result.content).toContain("a.ts");
    expect(result.content).not.toContain(".hidden.ts");
  });

  it("skips node_modules and other heavy dirs", () => {
    const fs = memFs({ "/workspace/node_modules/x.ts": "", "/workspace/src/y.ts": "" });
    const tool = new GlobTool(fs, cwd);

    const result = tool.execute({ glob_pattern: "**/*.ts" });

    expect(result.content).toContain("src/y.ts");
    expect(result.content).not.toContain("node_modules");
  });

  it("honours target_directory (relative to the working directory)", () => {
    const fs = memFs({ "/workspace/src/a.ts": "", "/workspace/b.ts": "" });
    const tool = new GlobTool(fs, cwd);

    const result = tool.execute({ glob_pattern: "*.ts", target_directory: "src" });

    expect(result.content).toContain("src/a.ts");
    expect(result.content).not.toContain("/workspace/b.ts");
  });

  it("expands brace alternation in the pattern", () => {
    const fs = memFs({ "/workspace/a.ts": "", "/workspace/b.tsx": "", "/workspace/c.md": "" });
    const tool = new GlobTool(fs, cwd);

    const result = tool.execute({ glob_pattern: "*.{ts,tsx}" });

    expect(result.content).toContain("a.ts");
    expect(result.content).toContain("b.tsx");
    expect(result.content).not.toContain("c.md");
  });

  it("anchors a leading '/' pattern to the FULL path (no substring match)", () => {
    const fs = memFs({ "/workspace/a.ts": "", "/workspace/src/a.ts": "" });
    const tool = new GlobTool(fs, cwd);

    const result = tool.execute({ glob_pattern: "/workspace/a.ts" });

    expect(result.content).toContain("/workspace/a.ts");
    expect(result.content).not.toContain("/workspace/src/a.ts");
  });

  it("does not loop forever on a symlink cycle (realpath guard)", () => {
    // /r/loop resolves (realpath) back to /r — a classic infinite loop.
    const dirs = new Set(["/r", "/r/loop"]);
    const fs: FileSystem = {
      readText: (p) =>
        p === "/r/a.ts"
          ? ""
          : (() => {
              throw new Error("ENOENT");
            })(),
      readBytes: () => Buffer.alloc(0),
      writeText: () => {},
      exists: (p) => p === "/r/a.ts" || dirs.has(p),
      isDirectory: (p) => dirs.has(p),
      realpath: (p) => (p.startsWith("/r/loop") ? "/r" : p),
      list: (d) => (d === "/r" || d === "/r/loop" ? ["a.ts", "loop"] : []),
      size: () => 0,
      mtimeMs: () => 0,
      mkdirRecursive: () => {},
      delete: () => {},
    };
    const tool = new GlobTool(fs, () => "/r");

    const result = tool.execute({ glob_pattern: "**/*.ts" });

    expect(result.content).toContain("/r/a.ts");
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
