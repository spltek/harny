import type { CommandRunner } from "./command-runner";
import type { FileSystem } from "./file-system";
import { resolvePath } from "./path-utils";
import type { Tool, ToolDefinition, ToolResult } from "./tool";

export class GrepTool implements Tool {
  readonly name = "Grep";
  readonly definition: ToolDefinition = {
    name: "Grep",
    description:
      "A search tool built on ripgrep. Results are capped to several thousand output lines for responsiveness; when truncation occurs, the results report \"at least\" counts, but are otherwise accurate.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "The regular expression pattern to search for in file contents" },
        path: { type: "string", description: "File or directory to search in, absolute or relative to the working directory (defaults to workspace root)." },
        glob: { type: "string", description: 'Glob pattern to filter files (e.g. "*.js", "*.{ts,tsx}")' },
        output_mode: {
          type: "string",
          enum: ["content", "files_with_matches", "count"],
          description: 'Output mode: "content" (default), "files_with_matches", or "count".',
        },
        "-A": { type: "number", description: "Number of lines to show after each match (rg -A)." },
        "-B": { type: "number", description: "Number of lines to show before each match (rg -B)." },
        "-C": { type: "number", description: "Number of lines to show before and after each match (rg -C)." },
        "-i": { type: "boolean", description: "Case insensitive search (rg -i). Defaults to false." },
        type: { type: "string", description: "File type to search (rg --type)." },
        head_limit: { type: "number", minimum: 0, description: "Limit output size." },
        offset: { type: "number", minimum: 0, description: "Skip first N entries." },
        multiline: { type: "boolean", description: "Enable multiline mode (rg -U --multiline-dotall)." },
      },
      required: ["pattern"],
    },
  };

  constructor(
    private runner: CommandRunner,
    private fs: FileSystem,
    private cwd: () => string,
  ) {}

  execute(args: Record<string, unknown>): ToolResult {
    const pattern = args.pattern as string | undefined;
    if (!pattern) {
      return {
        content: 'Tool Grep requires the argument "pattern" (regex string). Call again with {"pattern": "searchTerm"}.',
        isError: true,
      };
    }

    const searchPath = args.path ? resolvePath(args.path as string, this.cwd()) : this.cwd();
    // Distinguish "no matches" from "the target does not exist": a silent
    // 'No matches found' on a wrong path makes the model conclude wrongly.
    if (args.path && !this.fs.exists(searchPath)) {
      return { content: `Path not found: ${searchPath}`, isError: true };
    }
    const outputMode = (args.output_mode as string) || "content";

    const flags: string[] = [];
    if (args["-i"]) flags.push("-i");
    if (args.multiline) flags.push("-U", "--multiline-dotall");
    if (args["-A"]) flags.push(`-A${args["-A"]}`);
    if (args["-B"]) flags.push(`-B${args["-B"]}`);
    if (args["-C"]) flags.push(`-C${args["-C"]}`);
    if (outputMode === "files_with_matches") flags.push("-l");
    else if (outputMode === "count") flags.push("-c");
    else flags.push("-n");
    if (args.glob) flags.push(`--glob=${args.glob}`);
    if (args.type) flags.push(`--type=${args.type}`);

    const cmd = `rg ${flags.join(" ")} "${pattern.replace(/"/g, '\\"')}" "${searchPath}" 2>&1`;
    const result = this.runner.run(cmd, { cwd: this.cwd(), timeoutMs: 15000, maxBuffer: 10 * 1024 * 1024 });

    // rg exit codes: 0 = matches, 1 = no matches, >=2 = real error (bad regex,
    // missing binary, ...). With `2>&1` error text lands in stdout, so never
    // report a real rg failure as a clean "No matches found".
    if (result.code === 1) {
      return { content: "No matches found", isError: false };
    }
    if (result.code !== 0) {
      return { content: result.stdout.trim() || `rg failed with exit code ${result.code}`, isError: true };
    }

    const lines = result.stdout.trim().split("\n").filter(Boolean);
    const offset = (args.offset as number | undefined) || 0;
    const headLimit = args.head_limit as number | undefined;
    const limit = headLimit ?? lines.length;
    const sliced = lines.slice(offset, offset + limit);
    const joined = sliced.join("\n") || "No matches found";
    const truncated =
      sliced.length < lines.length
        ? `${joined}\n\n[Showing ${offset + 1}-${offset + sliced.length} of at least ${lines.length} matches]`
        : joined;

    return { content: truncated.slice(0, 30000), isError: false };
  }
}
