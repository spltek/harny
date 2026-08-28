import type { FileSystem } from "./file-system";
import { resolvePath } from "./path-utils";
import type { Tool, ToolDefinition, ToolResult } from "./tool";
import { buildDiff, fencedDiffBlock } from "./diff-text";

export class DeleteTool implements Tool {
  readonly name = "Delete";
  readonly definition: ToolDefinition = {
    name: "Delete",
    description:
      "Deletes a file at the specified path. The operation will fail gracefully if:\n- The file doesn't exist\n- The operation is rejected for security reasons\n- The file cannot be deleted",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path, absolute or relative to the working directory" },
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
        content: 'Tool Delete requires the argument "path" (absolute file path, string). Call again with {"path": "/abs/path/file"}.',
        isError: true,
      };
    }

    const filePath = resolvePath(pathArg, this.cwd());
    if (!this.fs.exists(filePath)) {
      return { content: `File not found: ${filePath}`, isError: true };
    }
    try {
      // Deletion preview for the dedicated diff bubble: the whole file becomes
      // a removal (every line a "−"). Capped like every other preview.
      const content = this.fs.readText(filePath);
      this.fs.delete(filePath);
      return {
        content: `Successfully deleted ${filePath}${fencedDiffBlock(buildDiff(content, ""))}`,
        isError: false,
      };
    } catch (err: any) {
      return { content: `Error deleting file: ${err.message}`, isError: true };
    }
  }
}
