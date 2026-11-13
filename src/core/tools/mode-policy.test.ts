import { describe, expect, it } from "vitest";
import {
  ANALYZE_BLOCKED_SHELL_MESSAGE,
  DEFAULT_CHAT_MODE,
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

  it("allows `git branch/tag --list <pattern>`, and does NOT open the positional hatch", () => {
    // `--list`/`-l` take an OPTIONAL pattern, and it used to be read as a positional — which on
    // `git branch` CREATES one. Fail-closed was the right side to err on, but it refused a
    // harmless read. The pattern is now the flag's value, so what must still be refused is a
    // positional that is NOT attached to `--list`.
    const allowed = [
      "git branch --list 'feat*'",
      "git branch -l 'feat*'",
      "git branch --list",
      "git branch --list=feat*",
      "git branch --list 'feat*' --merged",
      "git tag --list 'v1*'",
      "git tag -l 'v1*' -n",
    ];
    for (const cmd of allowed) expect(isSafeReadCommand(cmd), `should allow: ${cmd}`).toBe(true);
    const refused = [
      "git branch new-branch",
      "git branch --list 'feat*' new-branch", // the pattern is consumed, the second is a create
      "git branch --list --force", // the skip must not swallow a FLAG
      "git tag -l 'v1*' v1.0.0",
    ];
    for (const cmd of refused) expect(isSafeReadCommand(cmd), `should refuse: ${cmd}`).toBe(false);
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

describe("the shell parser: quoting, redirection, segments, tokens", () => {
  // The allowlist decision is only as good as the SPLIT that feeds it: every rule below is a case
  // where the shell and a naive `split()` disagree, so each one is a way to smuggle a command past
  // the filter or to refuse a harmless read.
  const allowed = [
    // A redirection inside quotes is TEXT, whichever quote: `grep 'a>b'` writes nothing.
    ["grep 'a>b' file", "single-quoted redirection is an argument"],
    ['grep "a>b" file', "double-quoted redirection is an argument"],
    ["grep 'a|b' file", "single-quoted pipe is an argument"],
    ['grep "a;b" file', "double-quoted semicolon is an argument"],
    ['grep "a&b" file', "double-quoted ampersand is an argument"],
    // An escaped operator is a literal: `\>` never redirects, `\|` never pipes.
    ["echo a\\>b", "escaped > is not a redirection"],
    ["cat a\\|b", "escaped | is not a separator"],
    ["cat a\\;b", "escaped ; is not a separator"],
    // `=>` and `->` are arrows in source code being grepped, not redirects.
    ["echo a=>b", "=> is an arrow"],
    ["echo a->b", "-> is an arrow"],
    // fd duplications and sinks: a write to a device nobody reads is still not a FILE.
    ["ls > /dev/fd/9", "fd/N sink"],
    ["ls > /dev/stdout", "stdout sink"],
    ["ls > /dev/stderr", "stderr sink"],
    ["ls > NUL", "Windows NUL sink, case-insensitively"],
    // separators that stay inside one safe pipeline
    ["cat a && ls", "&& of two reads"],
    ["cat a || ls", "|| of two reads"],
    ["cat a & ls", "background & of two reads"],
    ["ls 2>&1 & cat file", "the & of 2>&1 is not a separator, the trailing one is"],
    ["git\tstatus", "a TAB separates words too"],
    ['git "status"', "a quoted COMMAND NAME still parses to git"],
    ["git 'status'", "so does a hard-quoted one"],
    ["git  status", "runs of spaces do not produce empty tokens"],
  ];
  for (const [cmd, why] of allowed) {
    it(`allows \`${cmd}\` — ${why}`, () => {
      expect(isSafeReadCommand(cmd)).toBe(true);
    });
  }

  const refused = [
    // append / device / bare redirects
    ["echo x >> out", "append to a file"],
    ["echo x >/tmp/f", "no space needed"],
    ["ls > /dev/nullx", "`null` needs its word boundary: /dev/nullx is a file"],
    ["ls > null", "`nul` needs its word boundary, and this is not the Windows sink"],
    ["ls >| out", "clobber redirect"],
    ["cat a <> rw", "read-write redirect"],
    // single quotes make a backslash a LITERAL, so it cannot escape the closing quote
    ["grep 'a\\' f > out", "the > after the closed quote is a real write"],
    // In HARD quotes a backslash is literal, so it cannot escape the closing `'`: the `;` after it
    // still starts a new command. Reading it as an escape swallows the rest of the line.
    ["cat 'a\\'; rm -rf x", "hard quotes do not escape their own delimiter"],
    ['cat "a b" ; rm -rf x', "every character of a quoted word is not an escape"],
    // separators at top level: one unsafe segment refuses the line
    ["cat a; rm b", "; starts a second command"],
    ["cat a\nrm b", "a newline is a separator"],
    ["cat a | tee out", "the second segment writes"],
    ["cat a | python -c x", "the second segment is an interpreter"],
  ];
  for (const [cmd, why] of refused) {
    it(`refuses \`${cmd}\` — ${why}`, () => {
      expect(isSafeReadCommand(cmd)).toBe(false);
    });
  }

  it("names the segment that used substitution, and only for that reason", () => {
    // `$(` and backticks survive `stripQuoted` only OUTSIDE quotes: inside them they are text.
    const reason = (cmd: string): string => ANALYZE_BLOCKED_SHELL_MESSAGE(cmd).split("Reason: ")[1].split("\n")[0];
    expect(reason('echo "$(rm -rf x)"')).toContain("command substitution");
    expect(reason("echo `rm -rf x`")).toContain("command substitution");
    expect(reason('grep "$(x)" file')).toContain("command substitution");
    // `<(` feeds a command the output of another: a READ in this direction, but the shell still
    // RUNS `rm -rf x`, so the allowlist cannot let it through on the strength of `cat`.
    expect(isSafeReadCommand("cat <(rm -rf x)")).toBe(false);
    expect(reason("cat <(rm -rf x)")).toContain("command substitution");
    expect(isSafeReadCommand("cat >(rm -rf x)")).toBe(false);
    expect(isSafeReadCommand("cat /dev/fd/9")).toBe(true); // the harmless sibling: no command
    // …and quoted substitution is just text as far as the SPLIT is concerned — refused because
    // `$(…)` inside double quotes still RUNS in a real shell, so it must not be allowed.
    expect(isSafeReadCommand("echo '$(rm -rf x)'")).toBe(false);
  });
});

describe("git: the dangerous flags, the value flags and the optional pattern", () => {
  // GIT_DANGEROUS_FLAGS: each of these turns a READ subcommand into a write or an exec. They are
  // one test per flag because they are one regex ALTERNATIVE per flag.
  const dangerous = [
    "git log --output=patch.diff",
    "git diff --output patch.diff",
    "git log --ext-diff",
    "git diff --textconv",
    "git log --open-files-in-pager=less",
    "git log --open-files-in-pager",
    "git log -O orderfile",
    "git log --filters",
    "git diff --filter=blob:none",
  ];
  for (const cmd of dangerous) {
    it(`refuses \`${cmd}\``, () => {
      expect(isSafeReadCommand(cmd)).toBe(false);
    });
  }

  it("lets the same flags through when they are NOT the dangerous form", () => {
    // The regexes anchor: `--output` without `=` or end is a different (harmless) token, and a
    // file called `ext-diff` as an argument is not the flag.
    for (const cmd of ["git log --output-format=x", "git log --ext-diffx", "git log --filterx"]) {
      expect(isSafeReadCommand(cmd), cmd).toBe(true);
    }
    // The same for the flags whose dangerous form ends the token: an argument that merely STARTS
    // with the name is a different flag, and the `^` that makes that true is worth pinning.
    for (const cmd of ["git log --textconvx", "git log -Order", "git log --filtersx"]) {
      expect(isSafeReadCommand(cmd), cmd).toBe(true);
    }
  });

  it("skips the VALUE of a value-flag, so the value is not read as a positional", () => {
    // `--sort name` and `--sort=name` both read. The `=` form is matched by GIT_FLAG_WITH_VALUE,
    // the separate form by the value set — two different mechanisms, one behaviour.
    for (const cmd of [
      "git branch --sort name",
      "git branch --sort=-committerdate",
      "git branch --contains abc123",
      "git branch --contains=abc123",
      "git tag --sort name",
      "git tag --points-at HEAD",
      "git tag --points-at=HEAD",
      "git branch --merged=main",
      "git branch --list=feat*",
    ]) {
      expect(isSafeReadCommand(cmd), cmd).toBe(true);
    }
  });

  it("reads `git config` only when it is asked for something", () => {
    for (const cmd of [
      "git config --get user.name",
      "git config --get-all remote.origin.url",
      "git config --get-regexp user",
      "git config --list",
      "git config -l",
      "git config --global --get user.name",
    ]) {
      expect(isSafeReadCommand(cmd), cmd).toBe(true);
    }
    // A bare `git config` LISTS in modern git, but the form that WRITES is one token away, so the
    // allowlist asks for the flag explicitly.
    for (const cmd of ["git config", "git config user.name x", "git config --unset user.name"]) {
      expect(isSafeReadCommand(cmd), cmd).toBe(false);
    }
  });

  it("`git remote` reads with no argument, with -v, or with a read verb", () => {
    for (const cmd of ["git remote", "git remote -v", "git remote --verbose", "git remote show origin"]) {
      expect(isSafeReadCommand(cmd), cmd).toBe(true);
    }
    for (const cmd of ["git remote add origin url", "git remote prune origin"]) {
      expect(isSafeReadCommand(cmd), cmd).toBe(false);
    }
  });

  it("`git symbolic-ref` is a READ until it is handed a new value", () => {
    expect(isSafeReadCommand("git symbolic-ref")).toBe(true);
    expect(isSafeReadCommand("git symbolic-ref HEAD")).toBe(true);
    expect(isSafeReadCommand("git symbolic-ref HEAD refs/heads/main")).toBe(false);
  });

  it("`git stash`, `worktree` and `submodule` read only in their listing form", () => {
    for (const cmd of ["git stash list", "git stash show", "git worktree list", "git submodule status"]) {
      expect(isSafeReadCommand(cmd), cmd).toBe(true);
    }
    for (const cmd of ["git stash pop", "git worktree add ../x", "git submodule add url"]) {
      expect(isSafeReadCommand(cmd), cmd).toBe(false);
    }
  });

  it("`find`/`fd` refuse their write and exec actions, one entry each", () => {
    for (const action of ["-ok", "-fprintf /tmp/x %p", "-fls /tmp/x"]) {
      expect(isSafeReadCommand(`find . -name '*.ts' ${action}`), action).toBe(false);
    }
    for (const action of ["-exec rm {} ;", "-execdir rm {} ;"]) {
      expect(isSafeReadCommand(`find . ${action}`), action).toBe(false);
    }
    // The read-only actions of the same commands stay allowed.
    expect(isSafeReadCommand("find . -name '*.ts' -print")).toBe(true);
    expect(isSafeReadCommand("fd -e ts")).toBe(true);
  });
});

describe("the allowlist: one entry, one read", () => {
  it("every package-manager READ subcommand reads, and the others do not", () => {
    for (const sub of ["list", "ls", "view", "info", "search", "outdated", "audit", "why", "explain"]) {
      for (const pm of ["npm", "yarn", "pnpm"]) {
        expect(isSafeReadCommand(`${pm} ${sub} react`), `${pm} ${sub}`).toBe(true);
      }
    }
    for (const cmd of ["npm install react", "npm", "yarn add react", "pnpm dlx x"]) {
      expect(isSafeReadCommand(cmd), cmd).toBe(false);
    }
  });

  it("`sort`/`tree` refuse the output flag in both spellings", () => {
    expect(isSafeReadCommand("sort -o out.txt in.txt")).toBe(false);
    expect(isSafeReadCommand("sort --output=out.txt in.txt")).toBe(false);
    expect(isSafeReadCommand("tree --output=out.txt")).toBe(false);
    expect(isSafeReadCommand("sort in.txt")).toBe(true);
    expect(isSafeReadCommand("tree src")).toBe(true);
  });

  it("`rg --pre` refuses the preprocessor in both spellings", () => {
    expect(isSafeReadCommand("rg --pre 'sh -c x' foo")).toBe(false);
    expect(isSafeReadCommand("rg --pre='sh -c x' foo")).toBe(false);
    expect(isSafeReadCommand("rg --pretty foo")).toBe(true);
  });

  it("`curl` refuses every flag that writes locally or uploads", () => {
    for (const flag of [
      "-o out.json",
      "--output out.json",
      "--output=out.json",
      "-O",
      "--remote-name",
      "-T f",
      "--upload-file f",
    ]) {
      expect(isSafeReadCommand(`curl ${flag} https://x`), flag).toBe(false);
    }
    expect(isSafeReadCommand("curl -s https://x")).toBe(true);
  });

  it("`env` LISTS with assignments and EXECUTES with a command", () => {
    expect(isSafeReadCommand("env")).toBe(true);
    expect(isSafeReadCommand("env -i")).toBe(true);
    expect(isSafeReadCommand("env FOO=1 BAR=2")).toBe(true);
    expect(isSafeReadCommand("env rm -rf x")).toBe(false);
    expect(isSafeReadCommand("env FOO=1 rm -rf x")).toBe(false);
  });

  it("an interpreter is allowed only for its VERSION", () => {
    for (const flag of ["--version", "-V", "-v"]) {
      for (const bin of ["node", "python", "python3"]) {
        expect(isSafeReadCommand(`${bin} ${flag}`), `${bin} ${flag}`).toBe(true);
      }
    }
    for (const cmd of ["node", "node -e 'x'", "python", "python3 script.py"]) {
      expect(isSafeReadCommand(cmd), cmd).toBe(false);
    }
  });

  it("the default chat mode is the read-only one", () => {
    expect(DEFAULT_CHAT_MODE).toBe("analyze");
  });
});

describe("the text the MODEL reads", () => {
  // These notes are the contract the agent works from: if a clause goes, the agent plans writes in
  // Analyze and calls them refusals. Each sentence is pinned separately because each one is a rule.
  it("the Shell note keeps every clause it promises", () => {
    for (const clause of [
      "READ-ONLY MODE (allowlist, NOT a sandbox)",
      "file inspection (ls, cat, head, tail, wc, diff, file, stat, tree)",
      "git READ commands (status, log, diff, show, blame, branch -l, tag -l, remote -v, stash list, …)",
      "package info (npm list/outdated/audit)",
      "EVERYTHING ELSE is refused, including scripts, interpreters (python -c, node -e, sh x.sh) and any",
      "state-changing command. This is a best-effort filter, not a filesystem sandbox.",
      "for inspection; switch to Build to run or change anything.",
    ]) {
      expect(SHELL_READ_ONLY_NOTE, clause).toContain(clause);
    }
  });

  it("the preview note says PREPARE, not write — in that order", () => {
    expect(FILE_PREVIEW_NOTE).toContain("PREVIEW MODE (Analyze): this tool does NOT write.");
    expect(FILE_PREVIEW_NOTE).toContain("and returns the resulting diff as a PROPOSAL for the user to review");
    expect(FILE_PREVIEW_NOTE).toContain("user must switch to Build mode — never claim the change was applied.");
  });

  it("each refusal reason ends its sentence, so a truncation is visible", () => {
    const reason = (cmd: string): string => ANALYZE_BLOCKED_SHELL_MESSAGE(cmd).split("Reason: ")[1];
    expect(reason("cat a > b")).toContain(
      "it redirects output to a real FILE (`>` / `>>`), which is a write: here the MODE is the reason, not the command.",
    );
    expect(reason('echo "$(x)"')).toContain("which can run anything.");
    expect(reason("docker ps")).toContain("commands run (ls, cat, grep, the git read commands, …).");
    expect(reason("find . -delete")).toContain("(a write/exec flag, or a positional argument that creates something).");
    expect(reason("   ").split("\n")[0]).toBe("the command is empty.");
  });
});

describe("the separator, the token and the flag: the cases that only LOOK equivalent", () => {
  it("splits on a separator that follows a CLOSED quote", () => {
    // The quote state is per-segment bookkeeping: if it fails to RESET, everything after the first
    // quoted word is swallowed into the same segment and its second command rides along.
    for (const cmd of ['cat "a"; rm -rf x', "cat 'a'; rm -rf x", 'cat "a" && rm -rf x', 'cat "a" | rm -rf x']) {
      expect(isSafeReadCommand(cmd), cmd).toBe(false);
    }
    expect(isSafeReadCommand("rm -rf x; cat a")).toBe(false); // the UNSAFE one is first
    expect(isSafeReadCommand("rm -rf x & cat a")).toBe(false);
  });

  it("a trailing separator or a trailing space adds no segment, and does not smuggle one", () => {
    expect(isSafeReadCommand("cat a;")).toBe(true); // nothing after the `;`
    expect(isSafeReadCommand("env FOO=1 ")).toBe(true); // a trailing space is not an argument
    expect(isSafeReadCommand(" ; ")).toBe(false); // …but a line of only separators is empty
    expect(isSafeReadCommand('""')).toBe(false); // quotes with no word: no command to check
    expect(isSafeReadCommand("''")).toBe(false);
  });

  it("a quoted flag is ONE argument, so quoting it disarms it", () => {
    // `rg "--pre sh"` passes a single argv of `--pre sh`, which is not the `--pre` option: the
    // tokenizer must therefore not split a quoted word, or it invents a flag nobody typed.
    expect(isSafeReadCommand('rg "--pre sh" foo')).toBe(true);
    expect(isSafeReadCommand('rg "--pre\\ sh" foo')).toBe(true); // the escaped space is the same word
    expect(isSafeReadCommand("rg --pre sh foo")).toBe(false); // unquoted, it IS the option
    expect(isSafeReadCommand("rg --pre\\ sh foo")).toBe(true);
  });

  it("a redirect BEFORE a later quote is still a redirect", () => {
    // Blanking the quoted text must not reset what came before it: the `>` is already there.
    expect(isSafeReadCommand('cat > /tmp/x "name"')).toBe(false);
    expect(isSafeReadCommand("cat > /tmp/x 'unterminated")).toBe(false);
    expect(isSafeReadCommand('grep "a>b" > /tmp/x')).toBe(false);
  });

  it("the flag regexes are ANCHORED to the token boundary they mean", () => {
    // Unanchored, a filename would read as a flag and the flag check would lie about the command.
    expect(isSafeReadCommand("sort a-o.txt")).toBe(true); // `-o` inside a NAME is not the flag
    expect(isSafeReadCommand("sort -o out.txt in.txt")).toBe(false);
    expect(isSafeReadCommand("env 1FOO=1")).toBe(false); // an assignment starts with a LETTER
    expect(isSafeReadCommand("env FOO=1")).toBe(true);
    expect(isSafeReadCommand("node --version x")).toBe(false); // EVERY argument must be the flag
    expect(isSafeReadCommand("git branch --foo=--sort=x")).toBe(false); // the flag starts the token
  });
});

describe("the shapes a mutation run showed nobody had typed yet", () => {
  it("the sink exemption is read from the END of the redirect, not the first `>`", () => {
    // `>>/dev/null` appends to the void. The regex must swallow the WHOLE run of `>` before it
    // looks for the sink, or it reads `/dev/null` as the target of a second redirect.
    expect(isSafeReadCommand("echo x >>/dev/null")).toBe(true);
    expect(isSafeReadCommand("echo x >> out")).toBe(false);
    // fd duplications allow spaces around the number: `2>& 1` is still a duplication.
    expect(isSafeReadCommand("ls 2>& 1")).toBe(true);
    // …and a two-digit descriptor is a descriptor, not a 1 followed by junk.
    expect(isSafeReadCommand("ls > /dev/fd/10")).toBe(true);
  });

  it("a narrow flag stays narrow: `--grep=--ext-diff` SEARCHES for the flag's name", () => {
    // Every dangerous git flag is anchored, and `--grep` takes arbitrary text as its value. When
    // the anchor is dropped the value reads as the flag and a plain search is refused.
    for (const cmd of [
      "git log --grep=--ext-diff",
      "git log --grep=--textconv",
      "git log --grep=--filters",
      "git log --grep=-O",
      "git log --grep=--output=x",
    ]) {
      // …`--output` too: it is the TOKEN that decides, and this token is `--grep=…`.
      expect(isSafeReadCommand(cmd), cmd).toBe(true);
    }
    expect(isSafeReadCommand("git log --ext-diff")).toBe(false);
    expect(isSafeReadCommand("git log --output=x")).toBe(false);
  });

  it("curl's write flags are WHOLE arguments", () => {
    // `-o` / `--output` are matched with both anchors: a header VALUE that happens to end in
    // `-o` is not the flag, and `--output-format` (a read) is not `--output`.
    expect(isSafeReadCommand("curl -H 'X-Tag: a-o' https://x")).toBe(true);
    expect(isSafeReadCommand("curl --output=out.json https://x")).toBe(false);
    expect(isSafeReadCommand("curl -o out.json https://x")).toBe(false);
  });

  it("the refusal keeps its last line, and the empty cases keep their reason", () => {
    // The closing line is what tells the agent what to do instead; a message that has it glued to
    // the reason is still readable, but the newline is part of the format the tests pin.
    expect(ANALYZE_BLOCKED_SHELL_MESSAGE("cat a > b")).toContain(
      "not the command.\nUse the Read/Grep/Glob tools for inspection, or switch to Build to run it.",
    );
    // A line of only separators is EMPTY: it must say so rather than return a reason-less refusal.
    expect(ANALYZE_BLOCKED_SHELL_MESSAGE(" ; ")).toContain("Reason: the command is empty.");
    // A segment with no command at all names the segment, not a blank or an invented name.
    expect(ANALYZE_BLOCKED_SHELL_MESSAGE('""')).toContain('`""` is not in the read-only allowlist');
  });

  it("an escaped quote does not swallow the separator that follows the quoted word", () => {
    // `"a\"b"` is ONE word: the `\"` continues it, so the `;` after the closing quote still splits
    // the line. Treating every character inside quotes as escaped loses that boundary.
    expect(isSafeReadCommand('cat "a\\"b" ; rm -rf x')).toBe(false);
    expect(isSafeReadCommand('cat "a\\"b"')).toBe(true);
  });

  it("a separator with a trailing space leaves no empty segment behind", () => {
    expect(isSafeReadCommand("cat a; ")).toBe(true);
    expect(isSafeReadCommand("cat a; rm -rf x ")).toBe(false);
  });
});
