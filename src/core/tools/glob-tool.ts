import type { FileSystem } from "./file-system";
import { resolvePath } from "./path-utils";
import { walkFiles } from "./walk";
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
  for (let i = 0; i < glob.length;) {
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
  readonly analyzePolicy = "read-only" as const;
  readonly cacheable = true;
  readonly definition: ToolDefinition = {
    name: "Glob",
    description:
      "Tool to search for files matching a glob pattern.\n\n- Returns matching file paths sorted by modification time, NEWEST FIRST.",
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
          description:
            "Directory to search in, absolute or relative to the working directory (defaults to workspace root).",
        },
      },
      required: ["glob_pattern"],
    },
  };

  constructor(
    private fs: FileSystem,
    private cwd: () => string,
  ) {}

  execute(args: Record<string, unknown>): ToolResult {
    const globPattern = args.glob_pattern as string | undefined;
    if (!globPattern) {
      return {
        content:
          'Tool Glob requires the argument "glob_pattern" (e.g. "*.ts", "**/test/**"). Call again with {"glob_pattern": "*.ts"}.',
        isError: true,
      };
    }

    const dir = args.target_directory ? resolvePath(args.target_directory as string, this.cwd()) : this.cwd();

    let pattern = globPattern;
    if (!pattern.startsWith("**/") && !pattern.startsWith("/")) {
      pattern = `**/${pattern}`;
    }

    // Pure-Node match: the same ERE the old find/grep fallback used, applied to
    // the path with `/` separators so it works on Windows too (where fs paths
    // use `\`). The `**` translator gives zero-or-more directory levels.
    const ere = (pattern.startsWith("/") ? "^" : ".*") + globstarToRegex(pattern) + "$";
    let re: RegExp;
    try {
      re = new RegExp(ere);
    } catch (e) {
      return { content: `Glob error: invalid pattern "${globPattern}": ${(e as Error).message}`, isError: true };
    }

    const files = walkFiles(this.fs, dir, { maxFiles: 5000 }).filter((f) => re.test(f.replace(/\\/g, "/")));
    if (files.length === 0) return { content: "No files found", isError: false };

    const sorted = files
      .map((f) => ({ path: f, mtime: this.fs.exists(f) ? this.fs.mtimeMs(f) : 0 }))
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, 100)
      // Output paths with `/` on every OS: same result on macOS/Linux/Windows.
      .map((f) => f.path.replace(/\\/g, "/"));

    return { content: sorted.join("\n"), isError: false };
  }
}
