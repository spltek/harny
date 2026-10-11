import { describe, expect, it } from "vitest";
import {
  isAnalyzeMode,
  isFileMutatingTool,
  isWriteCommand,
  toolDefinitionsForMode,
  toolsForMode,
} from "./mode-policy";
import type { Tool } from "./tool";

function stubTool(name: string): Tool {
  return {
    name,
    definition: {
      name,
      description: `desc of ${name}`,
      parameters: { type: "object", properties: {} },
    },
    execute: async () => ({ content: "ok", isError: false }),
  };
}

describe("mode policy", () => {
  it("flags exactly the file-mutating tools", () => {
    for (const name of ["Write", "StrReplace", "Edit", "Delete"]) {
      expect(isFileMutatingTool(name)).toBe(true);
    }
    // Read-only / inspection tools are NOT file-mutating.
    for (const name of ["Read", "Grep", "Glob", "ReadLints", "TodoWrite", "WebSearch", "WebFetch", "Shell"]) {
      expect(isFileMutatingTool(name)).toBe(false);
    }
  });

  it("toolsForMode keeps the SAME tool set in both modes (previews, not blocking)", () => {
    const all = ["Read", "Write", "Edit", "Delete", "StrReplace", "Shell", "Grep"].map(stubTool);
    const names = all.map((t) => t.name);
    expect(toolsForMode(all, "analyze").map((t) => t.name)).toEqual(names);
    expect(toolsForMode(all, "agent").map((t) => t.name)).toEqual(names);
    // Explicit filtering (exclude) still applies in both modes.
    expect(toolsForMode(all, "analyze", { exclude: ["Write"] }).map((t) => t.name)).toEqual(
      names.filter((n) => n !== "Write"),
    );
  });

  it("toolDefinitionsForMode tags the shell read-only and writers as PREVIEW in analyze", () => {
    const all = [stubTool("Read"), stubTool("Shell"), stubTool("Write"), stubTool("Edit")];
    const defs = toolDefinitionsForMode(all, "analyze");
    // Every tool is advertised (writers run as validated previews, not hidden).
    expect(defs.map((d) => d.name)).toEqual(["Read", "Shell", "Write", "Edit"]);
    expect(defs.find((d) => d.name === "Shell")!.description).toContain("READ-ONLY");
    expect(defs.find((d) => d.name === "Write")!.description).toContain("PREVIEW MODE");
    expect(defs.find((d) => d.name === "Edit")!.description).toContain("PREVIEW MODE");
    expect(defs.find((d) => d.name === "Read")!.description).not.toContain("PREVIEW MODE");
    // Agent mode appends no read-only / preview notes.
    for (const d of toolDefinitionsForMode(all, "agent")) {
      expect(d.description).not.toContain("READ-ONLY");
      expect(d.description).not.toContain("PREVIEW MODE");
    }
  });

  it("isWriteCommand refuses redirection, mutating verbs, installers, git writes and build drivers", () => {
    const writeCommands = [
      "echo hello > out.txt",
      "ls >> log",
      "cat a b > merged && rm b",
      "rm -rf dist",
      "touch index.html",
      "mkdir -p src",
      "mv a.txt b.txt",
      "cp a b",
      "ln -s a b",
      "sed -i s/x/y/ file",
      "perl -i -pe 's/a/b/g' file",
      "awk -i inplace '{print}' file",
      "tee out.txt < in.txt",
      "chmod +x run.sh",
      "dd if=x of=y",
      "truncate -s 0 log",
      "npm install typescript",
      "npm ci",
      "bun add lodash",
      "pip install requests",
      "cargo build",
      "git add .",
      "git commit -m x",
      "git push origin main",
      "git reset --hard",
      "git clean -fd",
      "apt-get install vim",
      "brew install node",
      "make",
      "cmake ..",
      // A device is a REAL sink: only /dev/null, /dev/stdout, /dev/stderr,
      // /dev/fd/N and /dev/tty are exempt, not the whole /dev tree.
      "cat model > /dev/sda",
      "command <>rwfile",
    ];
    for (const cmd of writeCommands) {
      expect(isWriteCommand(cmd), `should refuse: ${cmd}`).toBe(true);
    }
  });

  it("isWriteCommand refuses Windows cmd / PowerShell mutating verbs", () => {
    const writeCommands = [
      "del file.txt",
      "erase file.txt",
      "copy a.txt b.txt",
      "xcopy /E src dst",
      "robocopy src dst /MIR",
      "move a.txt b.txt",
      "ren a.txt b.txt",
      "rmdir /s /q dist",
      "mklink link target",
      "icacls file /grant user:F",
      "Remove-Item -Recurse dist",
      "New-Item -ItemType Directory src",
      "Set-Content out.txt hello",
      "Add-Content log.txt hello",
      "Out-File -FilePath out.txt",
      "Move-Item a b",
      "Copy-Item a b",
      "Rename-Item a b",
      "Invoke-WebRequest https://x -OutFile out.bin",
      "reg add HKLM\\Software\\X /v y",
    ];
    for (const cmd of writeCommands) {
      expect(isWriteCommand(cmd), `should refuse: ${cmd}`).toBe(true);
    }
  });

  it("isWriteCommand allows Windows read-only inspection (no false positive on .md/.rd paths)", () => {
    const readCommands = ["dir", "dir /b", "type notes.md", "where node", "findstr /s foo *.ts", "git diff", "notes.rd"];
    for (const cmd of readCommands) {
      expect(isWriteCommand(cmd), `should allow: ${cmd}`).toBe(false);
    }
  });

  it("isWriteCommand allows read-only inspection commands", () => {
    const readCommands = [
      "ls -la",
      "cat src/index.ts",
      "find . -name '*.ts'",
      "grep -rn export src",
      "pwd && which node",
      "git status",
      "git log --oneline -5",
      "git diff HEAD~1",
      "curl -s https://example.com/api",
      "env",
      "echo hello",
      "head -50 file.ts",
      "ls 2>/dev/null",
      // /dev/* sinks are not real files: allowed even with redirection.
      "echo hello > /dev/null",
      "cat foo 2>/dev/null",
      // Redirection operators INSIDE a quoted argument are not writes.
      "grep -n 'a>b' src",
      'git log --pretty=format:"%h => %s"',
      "echo 'a > b'",
      // file-descriptor duplication is not a write.
      "ls -la 2>&1",
      "tool --serve 1>&2",
      "run 3>&-",
      // Windows null device (`>nul`) is also not a real file.
      "dir nonexistent 2>nul",
      "tool --check >NUL",
      // package-manager RUN (not install): allowed (e.g. node server, bun run test)
      "npm run test",
      "bun run index.ts",
      "node --version",
    ];
    for (const cmd of readCommands) {
      expect(isWriteCommand(cmd), `should allow: ${cmd}`).toBe(false);
    }
  });

  it("handles empty and package-manager-run edge cases", () => {
    expect(isWriteCommand("")).toBe(false);
    expect(isWriteCommand("   ")).toBe(false);
    // `git diff` (a word starting with the muted verb `diff`) must not be
    // caught by the write-verb list.
    expect(isWriteCommand("git diff --stat")).toBe(false);
  });

  it("redirection detection is quoting-, fd- and sink-aware", () => {
    // A `>` inside a quoted argument is not a redirection.
    expect(isWriteCommand('grep "a>b" file')).toBe(false);
    expect(isWriteCommand('echo "x => y"')).toBe(false);
    // File-descriptor duplication is not a write.
    expect(isWriteCommand("ls -la 2>&1")).toBe(false);
    expect(isWriteCommand("cmd 1>&2")).toBe(false);
    expect(isWriteCommand("cmd 3>&-")).toBe(false);
    // Only the harmless sinks are exempt; a real device is still a write.
    expect(isWriteCommand("echo x > /dev/null")).toBe(false);
    expect(isWriteCommand("echo x > out.txt")).toBe(true);
    expect(isWriteCommand("echo x > /dev/sda")).toBe(true);
  });

  it("isAnalyzeMode: only analyze is read-only; agent is full access", () => {
    expect(isAnalyzeMode(undefined)).toBe(true);
    expect(isAnalyzeMode("analyze")).toBe(true);
    expect(isAnalyzeMode("agent")).toBe(false);
  });
});