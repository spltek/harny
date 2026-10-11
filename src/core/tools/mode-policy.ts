import type { Tool, ToolDefinition } from "./tool";

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

/** True for the full-tool mode (Agent). */
export function isFullAccessMode(mode: ChatMode | undefined): boolean {
  return !isAnalyzeMode(mode);
}

/** File-MUTATING tools. In Analyze (read-only PREVIEW) mode they are NOT
 * removed nor refused: they run as PREVIEWS (dry-run) — they validate the
 * change and return the exact diff, but write NOTHING to disk. Applying them
 * requires switching to Build mode (the model is told to instruct the user).
 * Shell stays available but is guarded read-only at execution time (see
 * isWriteCommand). */
const FILE_MUTATING_TOOLS = new Set(["Write", "StrReplace", "Edit", "Delete"]);

/** True for a tool that would modify the filesystem (Write/StrReplace/Edit/Delete). */
export function isFileMutatingTool(name: string): boolean {
  return FILE_MUTATING_TOOLS.has(name);
}

/** Pure read-only, side-effect-free tools whose result can be safely reused
 * for an identical call (loop guard cache). Deliberately excludes Shell
 * (arbitrary side effects), Delegate (nested run) and WebSearch/WebFetch
 * (external, time-varying) and TodoWrite (mutates todo state). */
const READ_ONLY_TOOLS = new Set(["Read", "Grep", "Glob", "ReadLints", "Skill"]);

export function isReadOnlyTool(name: string): boolean {
  return READ_ONLY_TOOLS.has(name);
}

/** Extra filtering for a tool set (e.g. hide the Delegate tool from
 * sub-agents so orchestration cannot nest: depth is capped at 1). */
export interface ToolFilterOptions {
  exclude?: readonly string[];
}

/** The tools visible in a given mode. Both modes expose the SAME tool set:
 * in Analyze the file-mutating tools run as previews (see the note appended to
 * their definitions), so the model can PREPARE changes without applying them. */
export function toolsForMode(tools: readonly Tool[], _mode: ChatMode, opts?: ToolFilterOptions): Tool[] {
  const excluded = opts?.exclude && opts.exclude.length > 0 ? new Set(opts.exclude) : null;
  return excluded ? tools.filter((t) => !excluded.has(t.name)) : [...tools];
}

/** Tool definitions sent to the LLM for a given mode. In Analyze mode the
 * Shell advertises itself as read-only and the file-mutating tools advertise
 * the PREVIEW contract (validated diff, never written to disk). */
export function toolDefinitionsForMode(
  tools: readonly Tool[],
  mode: ChatMode,
  opts?: ToolFilterOptions,
): ToolDefinition[] {
  return toolsForMode(tools, mode, opts).map((t) => {
    if (!isAnalyzeMode(mode)) return t.definition;
    if (t.name === "Shell") return { ...t.definition, description: t.definition.description + SHELL_READ_ONLY_NOTE };
    if (isFileMutatingTool(t.name)) return { ...t.definition, description: t.definition.description + FILE_PREVIEW_NOTE };
    return t.definition;
  });
}

export const FILE_PREVIEW_NOTE =
  "\n\nPREVIEW MODE (Analyze): this tool does NOT write. It PREPARES and validates the change " +
  "and returns the resulting diff as a PROPOSAL for the user to review. To actually apply it the " +
  "user must switch to Build mode — never claim the change was applied.";

export const SHELL_READ_ONLY_NOTE =
  "\n\nREAD-ONLY MODE (best effort, NOT a sandbox): Harny refuses the common commands that write, delete, " +
  "move, rename, create or install (file redirection, mutating verbs, package managers, git writes, build " +
  "drivers). This is a heuristic, not a filesystem sandbox — a script or a language interpreter (e.g. " +
  "`python -c …`, `sh script.sh`) is NOT covered. Do NOT attempt any write in this mode: use Read/Grep/Glob " +
  "for inspection, and switch to Build to apply changes.";

export const ANALYZE_BLOCKED_SHELL_MESSAGE = (command: string): string =>
  `⛔ Analyze mode is READ-ONLY: the command "${command}" looks like it could modify the filesystem and was refused without running. ` +
  "This is a best-effort filter, not a sandbox. Only read-only inspection is allowed (POSIX: ls, cat, find; " +
  "Windows: dir, type, where, findstr; either: git status/diff/log). Prefer the Read/Grep/Glob tools.";

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
 * Heuristic "does this shell command modify the filesystem?" check used to
 * keep the Shell tool read-only in Analyze mode. NOT a sandbox — it is
 * defense in depth on top of the filtered tool set + the read-only system
 * prompt: it catches the common write idioms (redirection, mutating verbs,
 * package-manager/git write subcommands, build drivers) and refuses them
 * before the command runs.
 *
 * Known limits (deliberate): a script or an interpreter (`python -c`, `node -e`,
 * `sh x.sh`, `npm run <script>`, …) is opaque and is NOT detected. The goal is
 * to stop ACCIDENTAL writes, not to sandbox the shell.
 */
export function isWriteCommand(command: string): boolean {
  const cmd = command.trim();
  if (!cmd) return false;

  if (hasFileRedirection(cmd)) return true;

  // Mutating file verbs.
  if (
    /\b(?:rm|rmdir|mv|cp|ln|touch|mkdir|truncate|shred|unlink|chmod|chown|chgrp|chattr|mknod|mkfs|mkswap|dd)\b/.test(
      cmd,
    ) ||
    /\b(?:sed|perl)\s+-i\b/.test(cmd) ||
    /\bawk\s+-i\s+(?:inplace|in-place)\b/.test(cmd) ||
    /\btee\b/.test(cmd)
  ) {
    return true;
  }

  // Windows (cmd.exe) and PowerShell mutating verbs. Bare 2-letter commands
  // (`md`, `rd`) are deliberately NOT matched: they false-positive on paths
  // like `notes.md`. Quoted PowerShell cmdlets (Remove-Item) and their `-OutFile`
  // variants are covered too.
  if (
    /\b(?:del|erase|copy|xcopy|robocopy|move|ren|rename|rmdir|mklink|attrib|icacls|takeown|cacls)\b/i.test(cmd) ||
    /\b(?:remove-item|new-item|set-content|add-content|clear-content|out-file|move-item|copy-item|rename-item|set-itemproperty|new-itemproperty|remove-itemproperty|invoke-expression|clear-item)\b/i.test(
      cmd,
    ) ||
    /\breg\s+(?:add|delete|import|copy|save|restore)\b/i.test(cmd) ||
    /-outfile\b/i.test(cmd)
  ) {
    return true;
  }

  // Archive/compress writers (reading archives is fine; creation/extraction
  // modifies the filesystem, and detecting flags reliably is fragile, so the
  // whole family is refused in read-only mode).
  if (/\b(?:tar|zip|unzip|gzip|bzip2|xz|7z|rar|zstd)\b(?:[ \t]|$)/.test(cmd)) return true;

  // Package managers / installers (they write to disk and can run hooks).
  if (
    /\b(?:npm|pnpm|yarn|bun)\s+(?:install|add|init|ci|uninstall|remove|update|link|set-script|patch)\b/.test(
      cmd,
    ) ||
    /\b(?:pip|pip3|pipx|uv|poetry|conda|gem|composer|go|gradle)\s+(?:install|add|init|remove|uninstall|update|build)\b/.test(
      cmd,
    ) ||
    /\b(?:cargo)\s+(?:add|install|new|init|remove|build|run)\b/.test(cmd) ||
    /\b(?:apt|apt-get|dnf|yum|pacman|apk|brew|port)\b/.test(cmd)
  ) {
    return true;
  }

  // Git write subcommands (push/pull/fetch touch network+state; the read-only
  // status/log/diff remain usable).
  if (
    /\bgit\s+(?:add|commit|push|pull|fetch|merge|rebase|reset|clean|restore|rm|mv|stash|checkout|switch|tag|clone|init|gc|prune|remote\s+(?:add|set-url|remove|rename))\b/.test(
      cmd,
    )
  ) {
    return true;
  }

  // Build/test drivers that run arbitrary file-producing commands.
  if (/\b(?:make|cmake|ninja|meson|configure|gradlew?|mvn)\b/.test(cmd)) return true;

  return false;
}