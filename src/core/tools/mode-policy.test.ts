import { describe, expect, it } from "vitest";
import {
  ANALYZE_BLOCKED_SHELL_MESSAGE,
  FILE_PREVIEW_NOTE,
  SHELL_READ_ONLY_NOTE,
  analyzeRefusalMessage,
  isAnalyzeMode,
  isSafeReadCommand,
  toolDefinitionsForMode,
  toolsForMode,
} from "./mode-policy";
import type { AnalyzePolicy, Tool } from "./tool";

function stubTool(
  name: string,
  opts: { analyzePolicy?: AnalyzePolicy; analyzeNote?: string; analyzeRefusal?: string } = {},
): Tool {
  return {
    name,
    definition: {
      name,
      description: `desc of ${name}`,
      parameters: { type: "object", properties: {} },
    },
    ...(opts.analyzePolicy ? { analyzePolicy: opts.analyzePolicy } : {}),
    ...(opts.analyzeNote ? { analyzeNote: opts.analyzeNote } : {}),
    ...(opts.analyzeRefusal ? { analyzeRefusal: opts.analyzeRefusal } : {}),
    execute: async () => ({ content: "ok", isError: false }),
  };
}

describe("mode policy", () => {
  it("the note of a tool is the one IT declares, not a name kept in a list here", () => {
    // The tagging used to be keyed on tool NAMES held in this module; now each tool
    // carries its own note, so a tool that forgets to declare one is visible in its own
    // file. (The REAL declarations are pinned in create-default-tools.test.ts.)
    const all = [
      stubTool("Anything", { analyzePolicy: "read-only" }),
      stubTool("Guarded", { analyzePolicy: "guarded", analyzeNote: SHELL_READ_ONLY_NOTE }),
      stubTool("Writer", { analyzePolicy: "preview", analyzeNote: FILE_PREVIEW_NOTE }),
    ];
    const defs = toolDefinitionsForMode(all, "analyze");
    expect(defs.map((d) => d.name)).toEqual(["Anything", "Guarded", "Writer"]);
    expect(defs.find((d) => d.name === "Guarded")!.description).toContain("READ-ONLY");
    expect(defs.find((d) => d.name === "Writer")!.description).toContain("PREVIEW MODE");
    expect(defs.find((d) => d.name === "Anything")!.description).not.toContain("PREVIEW MODE");
    // Agent mode appends no read-only / preview notes.
    for (const d of toolDefinitionsForMode(all, "agent")) {
      expect(d.description).not.toContain("READ-ONLY");
      expect(d.description).not.toContain("PREVIEW MODE");
    }
  });

  it("a REFUSED tool gets an actionable message — its own, when it brings one", () => {
    const generic = analyzeRefusalMessage(stubTool("Something"));
    expect(generic).toContain("Something");
    expect(generic).toContain("Analyze never modifies");
    expect(generic).toContain("Switch to Build");
    // A tool that knows how to unblock itself (an MCP server) says it instead.
    const own = analyzeRefusalMessage(stubTool("mcp__x__y", { analyzeRefusal: "mark the server trusted" }));
    expect(own).toBe("mark the server trusted");
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
    const all = [
      stubTool("Read", { analyzePolicy: "read-only" }),
      stubTool("Shell", { analyzePolicy: "guarded", analyzeNote: SHELL_READ_ONLY_NOTE }),
      stubTool("Write", { analyzePolicy: "preview", analyzeNote: FILE_PREVIEW_NOTE }),
      stubTool("Edit", { analyzePolicy: "preview", analyzeNote: FILE_PREVIEW_NOTE }),
    ];
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
      // the rest of the POSIX/Windows set: one READ invocation each, because the allowlist
      // is the contract and an entry nobody ever runs is an entry nobody has ever checked
      "less README.md",
      "more README.md",
      "jq .name package.json",
      "du -sh src",
      "df -h",
      "free -m",
      "top -l 1",
      "htop",
      "ps aux",
      "uptime",
      "cal",
      "date",
      "uname -a",
      "whoami",
      "id",
      "hostname",
      "netstat -an",
      "ipconfig",
      "systeminfo",
      "tasklist",
      "ver",
      "whereis node",
      "bat src/index.ts",
      "eza -la",
      "printf 'x\\n'",
      // the rest of the PowerShell read cmdlets
      "Get-Command node",
      "Get-Date",
      "Get-Help Get-Item",
      "Get-Item file.txt",
      "Get-ItemProperty HKLM:",
      "Get-Location",
      "Get-Member",
      "Get-Process",
      "Get-Service",
      "Measure-Object -Line",
      "Select-Object -First 1",
      "Sort-Object name",
      "ConvertTo-Json",
      "ConvertFrom-Json",
      "Out-String",
      "Test-Path file.txt",
      // the rest of the git READ subcommands and read flags
      "git cat-file -p HEAD",
      "git check-attr -a file",
      "git check-ignore -v file",
      "git count-objects -v",
      "git describe --tags",
      "git diff-index HEAD",
      "git diff-tree HEAD",
      "git for-each-ref",
      "git help status",
      "git merge-base main dev",
      "git name-rev HEAD",
      "git reflog",
      "git rev-list --count HEAD",
      "git shortlog -sn",
      "git version",
      "git whatchanged",
      "git branch --all",
      "git branch --remotes",
      "git branch --show-current",
      "git branch -v",
      "git branch -vv",
      "git branch --merged main",
      "git branch --no-merged main",
      "git branch --points-at HEAD",
      "git tag -n",
      "git remote --verbose",
    ];
    for (const cmd of allowed) {
      expect(isSafeReadCommand(cmd), `should allow: ${cmd}`).toBe(true);
    }
  });

  // FINDING, not an endorsement: `--list` takes an OPTIONAL pattern and is not in the
  // value-flag set, so the pattern is read as a positional — and a positional on `git branch`
  // creates one. The filter fails CLOSED (it refuses a harmless read), which is the right side
  // to err on, but it is too strict. Changing a security filter's surface deserves its own
  // change, so this test pins today's behaviour and will fail the day we decide otherwise.
  it("isSafeReadCommand currently refuses `git branch --list <pattern>` (fail-closed, too strict)", () => {
    expect(isSafeReadCommand("git branch --list 'feat*'")).toBe(false);
    expect(isSafeReadCommand("git branch --list")).toBe(true); // the flag alone is fine
  });

  it("isSafeReadCommand REFUSES every find/fd action that writes or executes", () => {
    // find and fd are allowlisted for SEARCHING, and each of these turns a search into an
    // arbitrary command or a file write. One case per action, because they are separate entries.
    const refused = [
      "find . -name '*.ts' -execdir rm {} ;",
      "find . -name '*.ts' -okdir rm {} ;",
      "find . -name '*.ts' -fls /tmp/log",
      "find . -name '*.ts' -fprint /tmp/out",
      "find . -name '*.ts' -fprint0 /tmp/out",
      "find . -name '*.ts' -fprintf /tmp/out %p",
      "fd . --exec rm",
      "fd . --exec-batch rm",
      "fd . -x rm",
      "fd . -X rm",
    ];
    for (const cmd of refused) expect(isSafeReadCommand(cmd), `should refuse: ${cmd}`).toBe(false);
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
      'echo "$(rm -rf x)"',
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

  it("isSafeReadCommand handles the BACKSLASH escape inside double quotes", () => {
    // In `"a\"b"` the quote is escaped, so the string does not end there: what follows is still
    // an ARGUMENT, not a separator and not a redirection. Getting this wrong is a two-way bug —
    // it can refuse harmless reads, and it can split a command where the shell would not.
    expect(isSafeReadCommand('grep "a\\"b" file.txt')).toBe(true);
    expect(isSafeReadCommand('echo "a\\"; rm -rf /"')).toBe(true); // the `;` is INSIDE the quotes
    expect(isSafeReadCommand('echo "a\\">/tmp/x"')).toBe(true); // …and so is the `>`
    // The same escape OUTSIDE quotes is a literal too.
    expect(isSafeReadCommand("grep a\\;b file.txt")).toBe(true);
  });

  it("isSafeReadCommand reads every git subcommand in its READ form", () => {
    const allowed = [
      "git worktree list",
      "git submodule status",
      "git submodule summary",
      "git stash list",
      "git stash show",
      "git remote -v",
      "git remote get-url origin",
      "git config --get user.email",
      "git config -l",
      "git symbolic-ref HEAD",
      "git branch --contains abc1234",
      "git branch --sort name", // the value is skipped, not read as a positional
      "git branch --sort=-committerdate",
      "git tag --merged main",
    ];
    for (const cmd of allowed) expect(isSafeReadCommand(cmd), cmd).toBe(true);
  });

  it("…and REFUSES the writing form of the same subcommands", () => {
    const refused = [
      "git", // no subcommand at all
      "git worktree prune",
      "git submodule update",
      "git stash push",
      "git remote add origin https://x",
      "git config user.email a@b.c",
      "git symbolic-ref HEAD refs/heads/main", // two args = a write
      "git branch new-branch", // positional = create/rename
      "git branch -D old",
      "git tag v1.0.0",
    ];
    for (const cmd of refused) expect(isSafeReadCommand(cmd), cmd).toBe(false);
  });

  it("a DANGLING escape at the end of the line does not invent a character", () => {
    // An unbalanced quote or a trailing backslash is a command the shell itself would reject,
    // but the PARSER still runs on it first, and what it must not do is read past the end and
    // paste something onto the command name (`ls\` becoming a different binary).
    expect(isSafeReadCommand("ls\\")).toBe(true);
    expect(isSafeReadCommand('echo "a\\')).toBe(true);
    expect(isSafeReadCommand('grep "a\\"b" file.txt')).toBe(true);
    // …and an escaped SPACE joins the name: `git\ status` is not `git`, so it is refused —
    // fail-closed, and correct, because that is what the shell would run.
    expect(isSafeReadCommand("git\\ status")).toBe(false);
  });

  it("the refusal tells an UNKNOWN command from an ALLOWLISTED one used wrongly", () => {
    // Two of the four causes, by their wording: one says the command is not curated, the other
    // says the command IS curated and this invocation is what writes. `curl https://x` would be
    // the wrong witness for the first — it is ALLOWED (it only reads).
    const unknown = ANALYZE_BLOCKED_SHELL_MESSAGE("docker ps");
    const unsafe = ANALYZE_BLOCKED_SHELL_MESSAGE("git branch new-branch");
    expect(unknown).toContain("`docker` is not in the read-only allowlist");
    expect(unsafe).toContain("`git` is a read-only command, but THIS invocation");
  });

  it("the refusal names the CAUSE when there is one to name", () => {
    // An ALLOWLISTED command refused for its invocation is the case that used to lie: the agent
    // saw "not in the allowlist" and concluded the session was read-only. It must say WHY.
    expect(ANALYZE_BLOCKED_SHELL_MESSAGE("cat a > b")).toContain("Reason:");
    expect(ANALYZE_BLOCKED_SHELL_MESSAGE("cat a > b")).toContain("here the MODE is the reason");
    expect(ANALYZE_BLOCKED_SHELL_MESSAGE("docker ps")).toContain("read-only allowlist");
  });

  describe("the Analyze refusal message", () => {
    // A refusal used to say "Analyze is READ-ONLY: X is not in the allowlist" for EVERY cause —
    // including a redirection in a command that IS allowlisted. An agent reading it concluded the
    // SESSION was in Analyze when only the command was refused, and kept planning writes. So: the
    // mode the enforcement sees is stated explicitly, and the reason is the one that fired.
    it("states the enforced mode, so a refusal cannot be misread as a statement about the session", () => {
      const msg = ANALYZE_BLOCKED_SHELL_MESSAGE("rm -rf build");
      expect(msg.split("\n")[0]).toContain("enforced mode: ANALYZE");
      expect(msg).toContain("Command: rm -rf build");
      expect(msg).toContain("switch to Build");
    });

    it("names the cause that actually fired, one per class", () => {
      const reason = (cmd: string) => ANALYZE_BLOCKED_SHELL_MESSAGE(cmd).split("Reason: ")[1].split("\n")[0];
      // A WRITE: the mode is the reason, and saying "cat is not allowlisted" would be a lie.
      expect(reason("cat file.txt > out.txt")).toContain("MODE is the reason");
      // A KNOWN read command with a write/exec flag: the command is fine, this invocation is not.
      expect(reason("find . -delete")).toContain("THIS invocation can write or execute");
      expect(reason("git diff --output=patch.diff")).toContain("THIS invocation");
      // An UNKNOWN command: nothing to fix but the choice of command.
      expect(reason("docker ps")).toContain("`docker` is not in the read-only allowlist");
      // Command substitution can run anything, whatever the outer command looks like.
      expect(reason('echo "$(rm -rf x)"')).toContain("command substitution");
      expect(reason("   ")).toBe("the command is empty.");
    });
  });

  it("isAnalyzeMode: only analyze is read-only; agent is full access", () => {
    expect(isAnalyzeMode(undefined)).toBe(true);
    expect(isAnalyzeMode("analyze")).toBe(true);
    expect(isAnalyzeMode("agent")).toBe(false);
  });
});

describe("a session's scope composes with the mode's own exclusion", () => {
  const tool = (name: string): Tool =>
    ({
      name,
      definition: { name, description: name, parameters: { type: "object", properties: {} } },
      run: async () => ({ content: "" }),
    }) as unknown as Tool;

  const all = [tool("Read"), tool("Shell"), tool("Delegate"), tool("mcp__files__read"), tool("mcp__git__log")];

  it("shows exactly what the session allows, and nothing else", () => {
    const names = toolsForMode(all, "agent", { scope: { mcp: ["files"], off: ["Shell"] } }).map((t) => t.name);
    expect(names).toEqual(["Read", "Delegate", "mcp__files__read"]);
  });

  it("an EMPTY scope keeps every built-in and hides every MCP tool", () => {
    const names = toolsForMode(all, "agent", { scope: { mcp: [], off: [] } }).map((t) => t.name);
    expect(names).toEqual(["Read", "Shell", "Delegate"]);
  });

  it("applies the scope BEFORE the mode's own exclude (the two rules do not fight)", () => {
    // Sub-agents exclude Delegate; a session may also have Shell off. Both must hold.
    const names = toolsForMode(all, "agent", { exclude: ["Delegate"], scope: { mcp: ["git"], off: ["Shell"] } }).map(
      (t) => t.name,
    );
    expect(names).toEqual(["Read", "mcp__git__log"]);
  });

  it("no scope at all changes nothing (backwards compatible)", () => {
    expect(toolsForMode(all, "agent").map((t) => t.name)).toEqual(all.map((t) => t.name));
  });
});
