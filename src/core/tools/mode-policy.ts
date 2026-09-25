import type { Tool, ToolDefinition } from "./tool";

/**
 * Chat mode:
 *   · "analyze" = READ-ONLY (inspects but never modifies files)
 *   · "agent"   = full tool access, single agent
 *   · "multi"   = full tool access + ORCHESTRATION (can spawn sub-agents)
 * The UI's default mode is Analyze, so the default here matches.
 */
export type ChatMode = "analyze" | "agent" | "multi";
export const DEFAULT_CHAT_MODE: ChatMode = "analyze";

/** True for the full-tool modes (everything except the read-only Analyze). */
export function isFullAccessMode(mode: ChatMode | undefined): boolean {
  return (mode ?? DEFAULT_CHAT_MODE) !== "analyze";
}

/** True when orchestration (sub-agents) is enabled by the mode. */
export function isMultiAgentMode(mode: ChatMode | undefined): boolean {
  return mode === "multi";
}

/** File-MUTATING tools: never advertised to nor callable by the model in
 * Analyze mode. Read-only tools (Read, Grep, Glob, TodoWrite, WebSearch,
 * WebFetch, ReadLints) are always available. Shell stays available but is
 * guarded read-only at execution time (see isWriteCommand). */
const BLOCKED_IN_ANALYZE = new Set(["Write", "StrReplace", "Edit", "Delete"]);

export function isToolBlockedInAnalyze(name: string): boolean {
  return BLOCKED_IN_ANALYZE.has(name);
}

export function isAnalyzeMode(mode: ChatMode | undefined): boolean {
  return (mode ?? DEFAULT_CHAT_MODE) === "analyze";
}

/** Extra filtering for a tool set (e.g. hide the Delegate tool from
 * sub-agents so orchestration cannot nest: depth is capped at 1). */
export interface ToolFilterOptions {
  exclude?: readonly string[];
}

/** The tools visible in a given mode (analyze drops the file-mutating ones). */
export function toolsForMode(tools: readonly Tool[], mode: ChatMode, opts?: ToolFilterOptions): Tool[] {
  const excluded = opts?.exclude && opts.exclude.length > 0 ? new Set(opts.exclude) : null;
  const base = isFullAccessMode(mode) ? [...tools] : tools.filter((t) => !isToolBlockedInAnalyze(t.name));
  return excluded ? base.filter((t) => !excluded.has(t.name)) : base;
}

/** Tool definitions sent to the LLM for a given mode. In Analyze mode the
 * file-mutating tools are omitted entirely and the Shell advertises itself
 * as read-only, so the model cannot even attempt a write. */
export function toolDefinitionsForMode(
  tools: readonly Tool[],
  mode: ChatMode,
  opts?: ToolFilterOptions,
): ToolDefinition[] {
  return toolsForMode(tools, mode, opts).map((t) =>
    mode === "analyze" && t.name === "Shell"
      ? { ...t.definition, description: t.definition.description + SHELL_READ_ONLY_NOTE }
      : t.definition,
  );
}

export const SHELL_READ_ONLY_NOTE =
  "\n\nREAD-ONLY MODE: commands run with NO ability to modify the filesystem. " +
  "Any command that writes, deletes, moves, renames, creates, or installs is refused before running. " +
  "Only read-only inspection is allowed (ls, cat, find, grep, git status/diff/log, ...). " +
  "Prefer the Read/Grep/Glob tools for file inspection.";

export const ANALYZE_BLOCKED_TOOL_MESSAGE = (name: string): string =>
  `⛔ Tool "${name}" is disabled in Analyze (read-only) mode: it can modify files. ` +
  "Switch the mode to Agent to use it, or answer from what you can already read.";

export const ANALYZE_BLOCKED_SHELL_MESSAGE = (command: string): string =>
  `⛔ Analyze mode is READ-ONLY: the command "${command}" could modify the filesystem and was refused without running. ` +
  "Only read-only commands are allowed (e.g. ls, cat, find, git status/diff/log). Prefer the Read/Grep/Glob tools for inspection.";

/**
 * Heuristic "does this shell command modify the filesystem?" check used to
 * keep the Shell tool read-only in Analyze mode. NOT a sandbox — it is
 * defense in depth on top of the filtered tool set + the read-only system
 * prompt: it catches the common write idioms (redirection, mutating verbs,
 * package-manager/git write subcommands, build drivers) and refuses them
 * before the command runs.
 */
export function isWriteCommand(command: string): boolean {
  const cmd = command.trim();
  if (!cmd) return false;

  // File redirection / truncation / append (write or capture-to-file), except
  // /dev/* sinks which are not real files.
  if (/>(?!\s*\/dev\/)/.test(cmd)) return true;

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