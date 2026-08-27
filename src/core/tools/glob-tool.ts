import type { CommandRunner } from "./command-runner";
import type { FileSystem } from "./file-system";
import { resolvePath } from "./path-utils";
import type { Tool, ToolDefinition, ToolResult } from "./tool";

/**
 * Translate a glob (with globstar) into an ERE for the find/grep fallback.
 * `find -path` has NO globstar: it treats `**` as two adjacent `*` (which
 * cross slashes), so a pattern like "a / star-star / b" wrongly requires at
 * least one directory between `a` and `b` and skips `a/b`. This translator
 * gives `**` its standard meaning: zero or more directory levels.
 *
 * Handles `**` followed by a slash (zero or more levels), a trailing `**`,
 * single `*` (no slash crossing), `?` and brace alternation `{a,b}`; char
 * classes like `[ab]` are NOT expanded — kept literal.
 */
const REGEX_SPECIALS = ".*+?^${}()|[]\\";

export function globstarToRegex(glob: string): string {
  let out = "";
  for (let i = 0; i < glob.length; ) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      if (glob[i + 2] === "/") {
        out += "(?:[^/]+/)*"; // zero or more directory levels
        i += 3;
      } else {
        out += ".*"; // trailing ** : zero or more levels (files directly in the dir)
        i += 2;
      }
    } else if (c === "*") {
      out += "[^/]*";
      i++;
    } else if (c === "?") {
      out += "[^/]";
      i++;
    } else if (c === "{") {
      // Brace alternation {a,b} (the tool doc's example): expand to (?:a|b).
      const end = glob.indexOf("}", i + 1);
      if (end !== -1) {
        const alts = glob.slice(i + 1, end).split(",");
        out += "(?:" + alts.map((a) => globstarToRegex(a)).join("|") + ")";
        i = end + 1;
      } else {
        out += "\\{";
        i++;
      }
    } else if (REGEX_SPECIALS.includes(c)) {
      out += "\\" + c;
      i++;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

export class GlobTool implements Tool {
  readonly name = "Glob";
  readonly definition: ToolDefinition = {
    name: "Glob",
    description:
      "Tool to search for files matching a glob pattern.\n\n- Returns matching file paths sorted by modification time",
    parameters: {
      type: "object",
      properties: {
        glob_pattern: {
          type: "string",
          description:
            'The glob pattern to match files against. Patterns not starting with "**/" are automatically prepended with "**/". Examples: "*.js", "**/test/**/test_*.ts"',
        },
        target_directory: {
          type: "string",
          description: "Directory to search in, absolute or relative to the working directory (defaults to workspace root).",
        },
      },
      required: ["glob_pattern"],
    },
  };

  constructor(
    private runner: CommandRunner,
    private fs: FileSystem,
    private cwd: () => string,
  ) {}

  execute(args: Record<string, unknown>): ToolResult {
    const globPattern = args.glob_pattern as string | undefined;
    if (!globPattern) {
      return {
        content: 'Tool Glob requires the argument "glob_pattern" (e.g. "*.ts", "**/test/**"). Call again with {"glob_pattern": "*.ts"}.',
        isError: true,
      };
    }

    const dir = args.target_directory ? resolvePath(args.target_directory as string, this.cwd()) : this.cwd();

    let pattern = globPattern;
    if (!pattern.startsWith("**/") && !pattern.startsWith("/")) {
      pattern = `**/${pattern}`;
    }

    // fd is the primary engine: --full-path makes it match the RELATIVE path
    // (not the basename), which is what makes directory globs + globstar `**`
    // work — `a/**/b` matches `a/b`, `a/x/b`, ... (verified with fd 10.x).
    const fdCmd = `fd --type f --max-results=100 --glob --full-path "${pattern}" "${dir}" 2>/dev/null`;
    // find/grep fallback when fd is absent. find -path cannot express
    // globstar, so translate the glob to an ERE with the correct zero-or-more
    // directory semantics and filter the find listing with grep. The `$`
    // anchor keeps it a FULL-path match (no substring false positives).
    const ere = (pattern.startsWith("/") ? "^" : ".*") + globstarToRegex(pattern) + "$";
    const fallback = `find "${dir}" -type f -maxdepth 8 2>/dev/null | grep -E "${ere}" | head -100`;
    const cmd = `${fdCmd} || ${fallback} || echo "No files found"`;
    const result = this.runner.run(cmd, { cwd: dir, timeoutMs: 10000, maxBuffer: 5 * 1024 * 1024 });

    const files = result.stdout.trim().split("\n").filter(Boolean);
    if (files.length === 0) return { content: "No files found", isError: false };

    const sorted = files
      .map((f) => ({ path: f, mtime: this.fs.exists(f) ? this.fs.mtimeMs(f) : 0 }))
      .sort((a, b) => b.mtime - a.mtime)
      .map((f) => f.path);

    return { content: sorted.join("\n"), isError: false };
  }
}
