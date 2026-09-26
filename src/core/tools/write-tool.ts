import { dirname } from "node:path";
import type { FileSystem } from "./file-system";
import { resolvePath } from "./path-utils";
import type { Tool, ToolContext, ToolDefinition, ToolResult } from "./tool";
import { buildDiff, fencedDiffBlock } from "./diff-text";

export class WriteTool implements Tool {
  readonly name = "Write";
  readonly definition: ToolDefinition = {
    name: "Write",
    description:
      "Writes a file to the local filesystem and reports the character and UTF-8 byte counts written " +
      "(verifiable UTF-8 integrity). Both arguments are REQUIRED and must never be omitted. " +
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

  execute(args: Record<string, unknown>, ctx?: ToolContext): ToolResult {
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
      // Change preview for the dedicated diff bubble: a NEW file diffs against
      // an empty base (every line is an addition), an overwrite diffs old → new.
      const oldContent = this.fs.exists(filePath) ? this.fs.readText(filePath) : "";
      // chars (UTF-16 code points) AND bytes (UTF-8): byte length is the
      // truthful size (contents.length is code units, not bytes).
      const chars = [...contents].length;
      const bytes = Buffer.byteLength(contents, "utf8");
      // Analyze (preview) mode: describe the change, write NOTHING.
      if (ctx?.dryRun) {
        const verb = this.fs.exists(filePath) ? "update" : "create";
        return {
          content: `PROPOSED (preview — NOT written): ${verb} ${filePath} (${chars} chars, ${bytes} bytes)${fencedDiffBlock(buildDiff(oldContent, contents))}`,
          isError: false,
        };
      }
      this.fs.mkdirRecursive(dirname(filePath));
      this.fs.writeText(filePath, contents);
      return {
        content: `Successfully wrote ${chars} chars (${bytes} bytes) to ${filePath}${fencedDiffBlock(buildDiff(oldContent, contents))}`,
        isError: false,
      };
    } catch (err: any) {
      return { content: `Error writing file: ${err.message}`, isError: true };
    }
  }
}
