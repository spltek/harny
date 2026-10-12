import { describe, expect, it } from "vitest";
import {
  isAnalyzeMode,
  isFileMutatingTool,
  isSafeReadCommand,
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

  it("isSafeReadCommand ALLOWS the read-only allowlist (POSIX + git read + Windows)", () => {
    const allowed = [
      // file inspection / search
      "ls -la",
      "cat src/index.ts",
      "head -50 file.ts",
      "tail -n 20 log.txt",
      "wc -l file.ts",
      "sort file.txt",
      "uniq file.txt",
      "diff a.txt b.txt",
      "file image.png",
      "stat src/index.ts",
      "find . -name '*.ts'",
      "grep -rn export src",
      "rg --hidden foo",
      "pwd && which node",
      "env",
      "printenv PATH",
      "echo hello",
      "node --version",
      "python3 --version",
      "curl -s https://example.com/api",
      // git READ commands
      "git status",
      "git log --oneline -5",
      "git diff HEAD~1",
      "git diff --stat",
      "git show HEAD",
      "git blame src/a.ts",
      "git branch",
      "git branch -a",
      "git tag -l",
      "git remote -v",
      "git stash list",
      "git config --get user.name",
      "git rev-parse HEAD",
      "git ls-files",
      "git ls-tree HEAD",
      "git show-ref",
      // package info (read-only subcommands)
      "npm list",
      "npm outdated",
      "yarn info react",
      // pipelines of safe commands
      "git log --oneline | head -20",
      "cat a.txt | grep foo",
      // sinks / fd-duplication / quoting
      "ls 2>/dev/null",
      "echo hello > /dev/null",
      "cat foo 2>/dev/null",
      "ls -la 2>&1",
      "ls 1>&2",
      "ls 3>&-",
      "grep -n 'a>b' src",
      'git log --pretty=format:"%h => %s"',
      // Windows cmd.exe / PowerShell read
      "dir /b",
      "type notes.md",
      "where node",
      "findstr /s foo *.ts",
      "dir nonexistent 2>nul",
      "type file.txt >NUL",
      "Get-Content file.txt",
      "Select-String -Pattern foo",
      "Get-ChildItem -Recurse",
    ];
    for (const cmd of allowed) {
      expect(isSafeReadCommand(cmd), `should allow: ${cmd}`).toBe(true);
    }
  });

  it("isSafeReadCommand REFUSES writes, installers, git writes and build drivers", () => {
    const refused = [
      "echo hello > out.txt",
      "ls >> log",
      "cat a b > merged",
      "rm -rf dist",
      "touch index.html",
      "mkdir -p src",
      "mv a.txt b.txt",
      "cp a b",
      "ln -s a b",
      "tee out.txt < in.txt",
      "chmod +x run.sh",
      "dd if=x of=y",
      "truncate -s 0 log",
      "npm install typescript",
      "npm run test",
      "bun add lodash",
      "pip install requests",
      "cargo build",
      "make",
      "cmake ..",
      "apt-get install vim",
      // git WRITES (the same command has read and write forms)
      "git add .",
      "git commit -m x",
      "git push origin main",
      "git reset --hard",
      "git clean -fd",
      "git stash",
      "git checkout main",
      "git branch -d feature",
      "git branch newbranch",
      "git tag v1",
      "git remote add origin url",
      "git config user.name x",
      // Windows writes
      "del file.txt",
      "copy a.txt b.txt",
      "move a.txt b.txt",
      "Remove-Item -Recurse dist",
      "Set-Content out.txt hello",
      "Out-File -FilePath out.txt",
      // devices / real-file redirection
      "cat model > /dev/sda",
      "command <>rwfile",
    ];
    for (const cmd of refused) {
      expect(isSafeReadCommand(cmd), `should refuse: ${cmd}`).toBe(false);
    }
  });

  it("isSafeReadCommand REFUSES unknown commands, interpreters and exec/write flags", () => {
    const refused = [
      "python -c \"open('x','w')\"",
      "node -e \"require('fs').writeFileSync('x','y')\"",
      "sh script.sh",
      "bash build.sh",
      "docker ps",
      "kubectl get pods",
      "sudo ls",
      "go test ./...",
      "xargs rm",
      "env rm -rf x",
      "find . -exec rm {} \\;",
      "find . -delete",
      "sort -o out.txt in.txt",
      "tree -o out.txt",
      "fd -x rm",
      "rg --pre 'cmd' foo",
      "curl -o out.json https://x",
      "cat a.txt | python -c \"open('x','w')\"",
      "echo \"$(rm -rf x)\"",
      "git diff --output=patch.diff",
    ];
    for (const cmd of refused) {
      expect(isSafeReadCommand(cmd), `should refuse: ${cmd}`).toBe(false);
    }
  });

  it("isSafeReadCommand is quoting-, fd- and sink-aware; empty is refused", () => {
    expect(isSafeReadCommand("")).toBe(false);
    expect(isSafeReadCommand("   ")).toBe(false);
    expect(isSafeReadCommand('grep "a>b" file')).toBe(true);
    expect(isSafeReadCommand('echo "x => y"')).toBe(true);
    expect(isSafeReadCommand("ls -la 2>&1")).toBe(true);
    expect(isSafeReadCommand("ls 1>&2")).toBe(true);
    expect(isSafeReadCommand("ls 3>&-")).toBe(true);
    expect(isSafeReadCommand("echo x > /dev/null")).toBe(true);
    expect(isSafeReadCommand("echo x > out.txt")).toBe(false);
    expect(isSafeReadCommand("echo x > /dev/sda")).toBe(false);
  });

  it("isAnalyzeMode: only analyze is read-only; agent is full access", () => {
    expect(isAnalyzeMode(undefined)).toBe(true);
    expect(isAnalyzeMode("analyze")).toBe(true);
    expect(isAnalyzeMode("agent")).toBe(false);
  });
});
