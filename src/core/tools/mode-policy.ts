import type { Tool, ToolDefinition } from "./tool";
import { scopeTools, type ToolScope } from "./tool-scope";

/**
 * Chat mode:
 *   · "analyze" = READ-ONLY (inspects but never modifies files)
 *   · "agent"   = full tool access
 * Orchestration (sub-agents) is NOT a mode: it is the separate "Parallel"
 * toggle, which can be combined with either mode.
 */
export type ChatMode = "analyze" | "agent";
export const DEFAULT_CHAT_MODE: ChatMode = "analyze";

/** True for the read-only mode (Analyze). */
export function isAnalyzeMode(mode: ChatMode | undefined): boolean {
  return (mode ?? DEFAULT_CHAT_MODE) === "analyze";
}

/** Extra filtering for a tool set (e.g. hide the Delegate tool from
 * sub-agents so orchestration cannot nest: depth is capped at 1). */
interface ToolFilterOptions {
  exclude?: readonly string[];
  /** What the SESSION decided it may use (MCP servers on, built-ins off). Read live, so a change
   *  takes effect on the next turn without reconnecting anything. */
  scope?: ToolScope;
}

/** The tools visible in a given mode. Both modes expose the SAME tool set:
 * in Analyze the file-mutating tools run as previews (see the note appended to
 * their definitions), so the model can PREPARE changes without applying them. */
export function toolsForMode(tools: readonly Tool[], _mode: ChatMode, opts?: ToolFilterOptions): Tool[] {
  const excluded = opts?.exclude && opts.exclude.length > 0 ? new Set(opts.exclude) : null;
  const visible = scopeTools(tools, opts?.scope);
  return excluded ? visible.filter((t) => !excluded.has(t.name)) : visible;
}

/** Tool definitions sent to the LLM for a given mode. In Analyze each tool adds its OWN
 * note (`Tool.analyzeNote`: the preview contract, Shell's allowlist, …) so this module
 * carries no tool-specific text and no name list — a tool that forgets to declare one is
 * visible in its own file rather than missing from a list here. */
export function toolDefinitionsForMode(
  tools: readonly Tool[],
  mode: ChatMode,
  opts?: ToolFilterOptions,
): ToolDefinition[] {
  return toolsForMode(tools, mode, opts).map((t) => {
    if (!isAnalyzeMode(mode) || !t.analyzeNote) return t.definition;
    return { ...t.definition, description: t.definition.description + t.analyzeNote };
  });
}

/** What the model is told when a tool is REFUSED in Analyze (see AnalyzePolicy). The
 * tool may bring its own, actionable message (an MCP server names itself and says how to
 * trust it); this is the fallback, and it always says what to do instead. */
export function analyzeRefusalMessage(tool: Tool): string {
  return (
    tool.analyzeRefusal ??
    `${tool.name} is not available in Analyze: it may change resources, and Analyze never modifies any ` +
      `(no file, no database, no external system). Switch to Build to run it.`
  );
}

/** The note the file-mutating tools append in Analyze: a write there is a PROPOSAL.
 * Declared per tool via `Tool.analyzeNote`, so a new preview tool cannot silently miss it. */
export const FILE_PREVIEW_NOTE =
  "\n\nPREVIEW MODE (Analyze): this tool does NOT write. It PREPARES and validates the change " +
  "and returns the resulting diff as a PROPOSAL for the user to review. To actually apply it the " +
  "user must switch to Build mode — never claim the change was applied.";

/** The note Shell appends in Analyze: only allowlisted read-only commands run. */
export const SHELL_READ_ONLY_NOTE =
  "\n\nREAD-ONLY MODE (allowlist, NOT a sandbox): only a curated set of read-only commands is allowed — " +
  "file inspection (ls, cat, head, tail, wc, diff, file, stat, tree), search (grep, rg, find), " +
  "git READ commands (status, log, diff, show, blame, branch -l, tag -l, remote -v, stash list, …), " +
  "package info (npm list/outdated/audit) and a few system commands (uname, whoami, ps, env). " +
  "EVERYTHING ELSE is refused, including scripts, interpreters (python -c, node -e, sh x.sh) and any " +
  "state-changing command. This is a best-effort filter, not a filesystem sandbox. Use Read/Grep/Glob " +
  "for inspection; switch to Build to run or change anything.";

/**
 * Why a Shell command was refused in Analyze. Named rather than boolean because a refusal has
 * to say WHICH rule fired. "not in the read-only command allowlist" for `cat f >> out` teaches
 * nothing (cat IS allowlisted — the redirection is not), and a mode blamed for the wrong reason
 * is how an agent reads a refusal as a statement about the SESSION ("Analyze") instead of
 * about the COMMAND, then keeps planning writes it cannot run.
 */
type ReadOnlyRefusal =
  | { reason: "empty" }
  | { reason: "redirection" }
  | { reason: "substitution"; segment: string }
  | { reason: "unknown-command"; command: string }
  | { reason: "unsafe-invocation"; command: string };

/** One line saying what the model did wrong, in terms it can act on. */
function readOnlyRefusalDetail(refusal: ReadOnlyRefusal): string {
  switch (refusal.reason) {
    case "empty":
      return "the command is empty.";
    case "redirection":
      return (
        "it redirects output to a real FILE (`>` / `>>`), which is a write: here the MODE is the " +
        "reason, not the command."
      );
    case "substitution":
      return (
        `the segment \`${refusal.segment}\` uses command substitution (\`$(…)\` or backticks), ` +
        "which can run anything."
      );
    case "unknown-command":
      return (
        `\`${refusal.command}\` is not in the read-only allowlist: in Analyze only curated read-only ` +
        "commands run (ls, cat, grep, the git read commands, …)."
      );
    case "unsafe-invocation":
      return (
        `\`${refusal.command}\` is a read-only command, but THIS invocation can write or execute ` +
        "(a write/exec flag, or a positional argument that creates something)."
      );
  }
}

/**
 * What the model is told when the Shell tool refuses to run in Analyze. The first line states the mode
 * the ENFORCEMENT sees (`enforced mode: analyze`), because the alternative — letting the refusal imply
 * a mode — is what makes an agent conclude the session changed mode when only the command was refused.
 */
export const ANALYZE_BLOCKED_SHELL_MESSAGE = (command: string): string => {
  const refusal = readOnlyRefusal(command);
  return (
    `⛔ Refused without running — enforced mode: ANALYZE (read-only).\n` +
    `Command: ${command}\n` +
    (refusal ? `Reason: ${readOnlyRefusalDetail(refusal)}\n` : "") +
    "Use the Read/Grep/Glob tools for inspection, or switch to Build to run it."
  );
};

/**
 * Blank out the CONTENTS of quoted strings (and backslash-escaped characters)
 * so a redirection operator INSIDE an argument (e.g. `grep "a>b"`) is not read
 * as a file write. The quote characters themselves are kept as delimiters.
 */
function stripQuoted(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === "\\") {
      // An escaped character is a literal, never an operator.
      out += "  ";
      i += 2;
      continue;
    }
    if (c === "'" || c === '"') {
      const quote = c;
      out += quote;
      i++;
      while (i < text.length && text[i] !== quote) {
        // Inside double quotes a backslash escapes the next char.
        if (quote === '"' && text[i] === "\\") {
          out += "  ";
          i += 2;
          continue;
        }
        out += " ";
        i++;
      }
      if (i < text.length) {
        out += quote;
        i++;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/**
 * True when a command contains a redirection that could write a REAL file.
 *  · quoted text is ignored (`grep "a>b"` is not a write);
 *  · file-descriptor duplications are not writes (`2>&1`, `1>&-`);
 *  · only the harmless sinks are exempt (`/dev/null|stdout|stderr|fd/N|tty`,
 *    Windows `nul`). Note `> /dev/sda` is NOT exempt (it is a real device).
 */
function hasFileRedirection(command: string): boolean {
  const bare = stripQuoted(command);
  const redirect = /(?<![=\-])>+(?!\s*(?:&\s*(?:\d+|-)|=\s*|\/dev\/(?:null|stdout|stderr|fd\/\d+|tty)\b|nul\b))/i;
  return redirect.test(bare);
}

/**
 * Split a command line into TOP-LEVEL segments on the unquoted separators
 * `|`, `||`, `&&`, `;`, a newline and a background `&`. The `&` of a
 * file-descriptor duplication (`2>&1`, `>&2`, `3>&-`) is NOT a separator.
 * Quoting is respected, so `grep "a|b"` stays one segment.
 */
function splitSegments(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote) {
      current += c;
      if (c === "\\" && quote === '"') {
        current += command[i + 1] ?? "";
        i++;
      } else if (c === quote) {
        quote = null;
      }
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      current += c;
      continue;
    }
    if (c === "\\") {
      current += c + (command[i + 1] ?? "");
      i++;
      continue;
    }
    const background = c === "&" && !current.endsWith(">");
    if (c === "|" || c === ";" || c === "\n" || background) {
      segments.push(current);
      current = "";
      continue;
    }
    current += c;
  }
  segments.push(current);
  return segments.map((s) => s.trim()).filter((s) => s.length > 0);
}

/** Tokenize one shell segment into words, respecting quotes and escapes. */
function tokenize(segment: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i];
    if (quote) {
      if (c === "\\" && quote === '"') {
        current += segment[i + 1] ?? "";
        i++;
        continue;
      }
      if (c === quote) {
        quote = null;
        continue;
      }
      current += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      continue;
    }
    if (c === "\\") {
      current += segment[i + 1] ?? "";
      i++;
      continue;
    }
    if (/\s/.test(c)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += c;
  }
  if (current) tokens.push(current);
  return tokens;
}

/** Plain read-only commands whose default invocation cannot write a real file
 * or execute another command. Commands with write/exec FLAGS are handled
 * separately in {@link isSafeReadSegment}. Matched case-insensitively so the
 * Windows/PowerShell names (`DIR`, `Get-Content`) work too. */
const SAFE_COMMANDS = new Set([
  // POSIX
  "cat",
  "head",
  "tail",
  "less",
  "more",
  "grep",
  "ls",
  "pwd",
  "echo",
  "printf",
  "wc",
  "uniq",
  "diff",
  "file",
  "stat",
  "du",
  "df",
  "which",
  "whereis",
  "type",
  "printenv",
  "uname",
  "whoami",
  "id",
  "date",
  "cal",
  "uptime",
  "ps",
  "top",
  "htop",
  "free",
  "jq",
  "bat",
  "eza",
  // Windows cmd.exe
  "dir",
  "where",
  "findstr",
  "systeminfo",
  "tasklist",
  "ipconfig",
  "netstat",
  "ver",
  "hostname",
  // PowerShell read cmdlets
  "get-childitem",
  "get-content",
  "get-item",
  "get-command",
  "select-string",
  "test-path",
  "get-location",
  "get-process",
  "get-help",
  "get-date",
  "get-member",
  "get-itemproperty",
  "get-service",
  "measure-object",
  "select-object",
  "sort-object",
  "convertto-json",
  "convertfrom-json",
  "out-string",
]);

/** Every command the allowlist KNOWS about, whether or not this invocation is safe. Only used to
 * word the refusal: "unknown command" and "known command, unsafe invocation" need different fixes. */
const KNOWN_COMMANDS: ReadonlySet<string> = new Set([
  ...SAFE_COMMANDS,
  "git",
  "find",
  "fd",
  "sort",
  "tree",
  "rg",
  "env",
  "node",
  "python",
  "python3",
  "curl",
  "npm",
  "yarn",
  "pnpm",
]);

/** `find` actions that execute or write. */
const FIND_WRITE_ACTIONS = new Set([
  "-exec",
  "-execdir",
  "-ok",
  "-okdir",
  "-delete",
  "-fprint",
  "-fprint0",
  "-fprintf",
  "-fls",
]);
/** `fd` actions that execute. */
const FD_EXEC_FLAGS = new Set(["-x", "-X", "--exec", "--exec-batch"]);
/** Package-manager subcommands that only READ. */
const PACKAGE_READ_SUBCOMMANDS = new Set([
  "list",
  "ls",
  "view",
  "info",
  "search",
  "outdated",
  "audit",
  "why",
  "explain",
]);
/** Git subcommands that only READ (no write variant). */
const GIT_READ_SUBCOMMANDS = new Set([
  "status",
  "log",
  "diff",
  "show",
  "blame",
  "reflog",
  "shortlog",
  "describe",
  "rev-parse",
  "rev-list",
  "show-ref",
  "for-each-ref",
  "cat-file",
  "ls-files",
  "ls-tree",
  "merge-base",
  "diff-tree",
  "diff-index",
  "name-rev",
  "check-ignore",
  "check-attr",
  "count-objects",
  "version",
  "help",
  "grep",
  "whatchanged",
]);
/** Git flags that can WRITE a file or EXECUTE a helper (blocked everywhere). */
const GIT_DANGEROUS_FLAGS =
  /^(--output(=|$)|--ext-diff$|--textconv$|--open-files-in-pager(=|$)|-O$|--filters$|--filter=)/;
const GIT_BRANCH_READ_FLAGS = new Set([
  "-l",
  "--list",
  "-a",
  "--all",
  "-r",
  "--remotes",
  "-v",
  "-vv",
  "--verbose",
  "--show-current",
]);
const GIT_BRANCH_VALUE_FLAGS = new Set(["--contains", "--merged", "--no-merged", "--points-at", "--sort"]);
const GIT_TAG_READ_FLAGS = new Set([
  "-l",
  "--list",
  "-n",
  "-v",
  "--verify",
  "--contains",
  "--merged",
  "--no-merged",
  "--points-at",
  "--sort",
]);
const GIT_REMOTE_READ = new Set(["-v", "--verbose", "show", "get-url"]);
const GIT_FLAG_WITH_VALUE = /^--(sort|contains|merged|no-merged|points-at)=/;

/** True when every argument is a READ flag (or the value of a value-flag).
 * A positional argument (e.g. `git branch foo`) creates/renames → rejected. */
function gitReadFlags(args: string[], readFlags: Set<string>, valueFlags: Set<string>): boolean {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("-")) return false;
    if (valueFlags.has(a)) {
      i++; // skip its value
      continue;
    }
    if (readFlags.has(a) || GIT_FLAG_WITH_VALUE.test(a)) continue;
    return false;
  }
  return true;
}

/** True when a `git …` invocation is a read-only operation. */
function isSafeGit(args: string[]): boolean {
  if (args.length === 0) return false;
  if (args.some((a) => GIT_DANGEROUS_FLAGS.test(a))) return false;
  const [sub, ...rest] = args;
  if (GIT_READ_SUBCOMMANDS.has(sub)) return true;
  switch (sub) {
    case "stash":
      return rest[0] === "list" || rest[0] === "show";
    case "worktree":
      return rest[0] === "list";
    case "submodule":
      return rest[0] === "status" || rest[0] === "summary";
    case "config":
      return rest.some(
        (a) => a === "--get" || a === "--get-all" || a === "--get-regexp" || a === "--list" || a === "-l",
      );
    case "branch":
      return rest.length === 0 || gitReadFlags(rest, GIT_BRANCH_READ_FLAGS, GIT_BRANCH_VALUE_FLAGS);
    case "tag":
      return rest.length === 0 || gitReadFlags(rest, GIT_TAG_READ_FLAGS, GIT_BRANCH_VALUE_FLAGS);
    case "remote":
      return rest.length === 0 || GIT_REMOTE_READ.has(rest[0]);
    case "symbolic-ref":
      // Reads with 0–1 args; WRITES when given a new value.
      return rest.length <= 1;
    default:
      return false;
  }
}

/** True when one top-level segment is a known read-only command. */
function isSafeReadSegment(segment: string): boolean {
  // Command/process substitution can smuggle an arbitrary command
  // (`echo "$(rm -rf x)"`, `cat >(...)`): refused outright.
  if (segment.includes("$(") || segment.includes("`") || segment.includes(">(")) return false;
  const tokens = tokenize(segment);
  const cmd = tokens[0]?.toLowerCase();
  const args = tokens.slice(1);
  if (!cmd) return false;
  switch (cmd) {
    case "git":
      return isSafeGit(args);
    case "find":
      return !args.some((a) => FIND_WRITE_ACTIONS.has(a));
    case "fd":
      return !args.some((a) => FD_EXEC_FLAGS.has(a));
    case "sort":
    case "tree":
      // `-o/--output` writes the result to a FILE.
      return !args.some((a) => /^(-o|--output)/.test(a));
    case "rg":
      // `--pre <cmd>` runs a preprocessor command.
      return !args.some((a) => a === "--pre" || a.startsWith("--pre="));
    case "env":
      // `env` alone (or with VAR=… assignments) lists; `env <cmd>` EXECUTES it.
      return args.every((a) => a.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(a));
    case "node":
    case "python":
    case "python3":
      return args.length > 0 && args.every((a) => a === "--version" || a === "-V" || a === "-v");
    case "curl":
      // Flags that write a local file / upload.
      return !args.some(
        (a) => /^(-o|--output|-O|--remote-name|-T|--upload-file)$/.test(a) || /^--(output|upload-file)=/.test(a),
      );
    case "npm":
    case "yarn":
    case "pnpm":
      return args.length > 0 && PACKAGE_READ_SUBCOMMANDS.has(args[0]);
    default:
      return SAFE_COMMANDS.has(cmd);
  }
}

/**
 * Allowlist-first read-only check for the Shell tool in Analyze mode.
 *
 * A command is allowed ONLY when it is split into top-level segments and
 * EVERY segment is a known read-only command, AND the whole line has no
 * redirection to a real file. This is the OPPOSITE of a denylist: an unknown
 * command (`python -c …`, `docker ps`, `sh x.sh`) is REFUSED, not "allowed
 * because it was not recognized as a write".
 *
 * It is a best-effort filter, NOT a filesystem sandbox: a read-only command
 * can still have an obscure write/exec flag, and a language interpreter is
 * opaque. Its purpose is to keep Analyze read-only for the common cases, not
 * to contain a hostile command.
 */
export function isSafeReadCommand(command: string): boolean {
  return readOnlyRefusal(command) === undefined;
}

/** The single implementation behind {@link isSafeReadCommand}: the first segment that breaks the
 * allowlist, with the reason. Kept in one place so the check and the refusal message cannot drift
 * (a message that explains a rule the check does not apply is worse than no message). */
function readOnlyRefusal(command: string): ReadOnlyRefusal | undefined {
  const cmd = command.trim();
  if (!cmd) return { reason: "empty" };
  if (hasFileRedirection(cmd)) return { reason: "redirection" };
  const segments = splitSegments(cmd);
  if (segments.length === 0) return { reason: "empty" };
  for (const segment of segments) {
    if (isSafeReadSegment(segment)) continue;
    if (segment.includes("$(") || segment.includes("`") || segment.includes(">(")) {
      return { reason: "substitution", segment };
    }
    const name = tokenize(segment)[0]?.toLowerCase() ?? "";
    return KNOWN_COMMANDS.has(name)
      ? { reason: "unsafe-invocation", command: name }
      : { reason: "unknown-command", command: name || segment };
  }
  return undefined;
}
