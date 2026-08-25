import type { FileSystem } from "./file-system";
import { formatSize, isImagePath, resolvePath } from "./path-utils";
import type { Tool, ToolDefinition, ToolResult } from "./tool";

export class ReadTool implements Tool {
  readonly name = "Read";
  readonly definition: ToolDefinition = {
    name: "Read",
    description:
      "Reads a file from the local filesystem. This tool can also read image files when called with the appropriate path. Formats supported: jpeg/jpg, png, gif, webp.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path, absolute or relative to the working directory." },
        offset: {
          type: "integer",
          description:
            "The line number to start reading from. Positive values are 1-indexed from the start of the file. Negative values count backwards from the end (e.g. -1 is the last line). Only provide if the file is too large to read at once.",
        },
        limit: {
          type: "integer",
          description: "The number of lines to read. Only provide if the file is too large to read at once.",
        },
      },
      required: ["path"],
    },
  };

  constructor(
    private fs: FileSystem,
    private cwd: () => string,
  ) {}

  execute(args: Record<string, unknown>): ToolResult {
    const pathArg = args.path as string | undefined;
    if (!pathArg) {
      return {
        content: 'Tool Read requires the argument "path" (absolute file path, string). Call again with {"path": "/abs/path/file"}.',
        isError: true,
      };
    }
    const filePath = resolvePath(pathArg, this.cwd());
    if (!this.fs.exists(filePath)) {
      return { content: `File not found: ${filePath}`, isError: true };
    }
    if (isImagePath(filePath)) {
      return {
        content: `[Image file at: ${filePath}] (${formatSize(this.fs.size(filePath))})`,
        isError: false,
      };
    }

    try {
      const content = this.fs.readText(filePath);
      const lines = content.split("\n");
      const offset = args.offset as number | undefined;
      const limit = args.limit as number | undefined;

      let start: number;
      if (offset !== undefined && offset < 0) {
        start = Math.max(0, lines.length + offset);
      } else {
        start = (offset || 1) - 1;
      }
      const end = limit ? start + limit : lines.length;

      const result = lines.slice(start, end).join("\n");
      const truncated =
        end < lines.length ? `${result}\n\n[Truncated: lines ${start + 1}-${end} of ${lines.length}]` : result;
      return { content: truncated, isError: false };
    } catch (err: any) {
      return { content: `Error reading file: ${err.message}`, isError: true };
    }
  }
}
