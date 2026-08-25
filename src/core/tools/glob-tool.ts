import type { CommandRunner } from "./command-runner";
import type { FileSystem } from "./file-system";
import { resolvePath } from "./path-utils";
import type { Tool, ToolDefinition, ToolResult } from "./tool";

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

    const cmd = `fd --type f --max-results=100 --glob "${pattern}" . "${dir}" 2>/dev/null || find "${dir}" -path "*/${pattern}" -type f -maxdepth 8 2>/dev/null | head -100 || echo "No files found"`;
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
