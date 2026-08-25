import type { FileSystem } from "./file-system";
import { resolvePath } from "./path-utils";
import type { Tool, ToolDefinition, ToolResult } from "./tool";

export class StrReplaceTool implements Tool {
  readonly name = "StrReplace";
  readonly definition: ToolDefinition = {
    name: "StrReplace",
    description: "Performs exact string replacements in files.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path, absolute or relative to the working directory" },
        old_string: { type: "string", description: "The text to replace" },
        new_string: { type: "string", description: "The text to replace it with (must be different from old_string)" },
        replace_all: { type: "boolean", description: "Replace all occurrences of old_string (default false)" },
      },
      required: ["path", "old_string", "new_string"],
    },
  };

  constructor(
    private fs: FileSystem,
    private cwd: () => string,
  ) {}

  execute(args: Record<string, unknown>): ToolResult {
    const pathArg = args.path as string | undefined;
    const oldStr = args.old_string as string | undefined;
    const newStr = args.new_string as string | undefined;
    const replaceAll = args.replace_all as boolean | undefined;

    if (!pathArg || oldStr === undefined || newStr === undefined) {
      return {
        content:
          "Tool StrReplace requires three arguments:\n" +
          '- "path": absolute file path (string)\n' +
          '- "old_string": exact text to find (string)\n' +
          '- "new_string": replacement text (string, different from old_string)\n' +
          'Call StrReplace again with valid JSON: {"path": "/abs/path/file.txt", "old_string": "...", "new_string": "..."}',
        isError: true,
      };
    }
    const filePath = resolvePath(pathArg, this.cwd());
    if (!this.fs.exists(filePath)) {
      return { content: `File not found: ${filePath}`, isError: true };
    }

    try {
      let content = this.fs.readText(filePath);

      if (replaceAll) {
        if (!content.includes(oldStr)) {
          return this.notFoundError(oldStr);
        }
        const count = content.split(oldStr).length - 1;
        content = content.split(oldStr).join(newStr);
        this.fs.writeText(filePath, content);
        return {
          content: `Successfully replaced ${count} occurrence(s) of old_string in ${filePath}`,
          isError: false,
        };
      }

      const idx = content.indexOf(oldStr);
      if (idx === -1) {
        return this.notFoundError(oldStr);
      }
      content = content.slice(0, idx) + newStr + content.slice(idx + oldStr.length);
      this.fs.writeText(filePath, content);
      return { content: `Successfully replaced old_string in ${filePath}`, isError: false };
    } catch (err: any) {
      return { content: `Error replacing in file: ${err.message}`, isError: true };
    }
  }

  private notFoundError(oldStr: string): ToolResult {
    return {
      content: `StrReplace failed: old_string not found in file.\nLooking for:\n\`\`\`\n${oldStr.slice(0, 200)}${oldStr.length > 200 ? "..." : ""}\n\`\`\``,
      isError: true,
    };
  }
}
