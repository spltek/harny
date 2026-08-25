import { dirname } from "node:path";
import type { FileSystem } from "./file-system";
import { resolvePath } from "./path-utils";
import type { Tool, ToolDefinition, ToolResult } from "./tool";

export class WriteTool implements Tool {
  readonly name = "Write";
  readonly definition: ToolDefinition = {
    name: "Write",
    description:
      "Writes a file to the local filesystem. Both arguments are REQUIRED and must never be omitted. " +
      "Path may be absolute or relative to the working directory (e.g. \"style.css\"). " +
      "Put the full file content in \"contents\". Example call: " +
      JSON.stringify({ path: "style.css", contents: "<full file content>" }),
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "REQUIRED. File path, absolute or relative to the working directory (e.g. \"style.css\")",
        },
        contents: {
          type: "string",
          description: "REQUIRED. The full contents to write to the file",
        },
      },
      required: ["path", "contents"],
    },
  };

  constructor(
    private fs: FileSystem,
    private cwd: () => string,
  ) {}

  execute(args: Record<string, unknown>): ToolResult {
    const pathArg = args.path as string | undefined;
    const contents = args.contents as string | undefined;
    const cwd = this.cwd();

    if (!pathArg && contents === undefined) {
      return {
        content:
          "Tool Write is missing BOTH required arguments:" +
          "\n- \"path\": absolute path or path relative to the working directory \"" +
          cwd +
          "\" (e.g. \"style.css\")" +
          "\n- \"contents\": full file content (string)" +
          "\nCall Write again with valid JSON, e.g. " +
          JSON.stringify({ path: cwd + "/style.css", contents: "<full file content>" }),
        isError: true,
      };
    }
    if (!pathArg) {
      return {
        content:
          "Tool Write: you provided \"contents\" but forgot the REQUIRED \"path\". " +
          "Send both fields. Use a path relative to the working directory \"" +
          cwd +
          "\", e.g. \"style.css\" or \"src/main.js\". " +
          "Correct call: " +
          JSON.stringify({ path: "style.css", contents: contents || "<full file content>" }),
        isError: true,
      };
    }
    if (contents === undefined) {
      return {
        content:
          "Tool Write: you provided \"path\" but forgot the REQUIRED \"contents\" " +
          "(the full file content as a string). Send both fields. Correct call: " +
          JSON.stringify({ path: pathArg, contents: "<full file content>" }),
        isError: true,
      };
    }
    const filePath = resolvePath(pathArg, this.cwd());
    try {
      this.fs.mkdirRecursive(dirname(filePath));
      this.fs.writeText(filePath, contents);
      return { content: `Successfully wrote ${contents.length} bytes to ${filePath}`, isError: false };
    } catch (err: any) {
      return { content: `Error writing file: ${err.message}`, isError: true };
    }
  }
}
