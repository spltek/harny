import type { FileSystem } from "./file-system";
import { resolvePath } from "./path-utils";
import type { Tool, ToolDefinition, ToolResult } from "./tool";
import { buildDiff, fencedDiffBlock } from "./diff-text";
import { fuzzyUniqueReplace } from "./edit-engine";

export class StrReplaceTool implements Tool {
  readonly name = "StrReplace";
  readonly definition: ToolDefinition = {
    name: "StrReplace",
    description:
      "Performs string replacements in files (exact match; a Unicode/whitespace-tolerant " +
      "fallback — trailing whitespace, smart quotes/dashes, NFKC — applies when the text " +
      "aligns with whole lines). Without replace_all the old_string must be UNIQUE and " +
      "found, otherwise the tool fails explicitly.",
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
      const original = this.fs.readText(filePath);
      let nextContent: string;
      let headline: string;

      if (replaceAll) {
        if (!original.includes(oldStr)) {
          return this.notFoundError(oldStr);
        }
        const count = original.split(oldStr).length - 1;
        nextContent = original.split(oldStr).join(newStr);
        headline = `Successfully replaced ${count} occurrence(s) of old_string in ${filePath}`;
      } else {
        const idx = original.indexOf(oldStr);
        if (idx === -1) {
          // Exact miss: same Unicode/whitespace tolerance as Edit (trailing
          // whitespace, smart quotes/dashes, NFKC) before giving up.
          const fuzzy = fuzzyUniqueReplace(original, oldStr, newStr);
          if (fuzzy === undefined) return this.notFoundError(oldStr);
          if (fuzzy === "duplicate") {
            return {
              content: `StrReplace failed: multiple lines match old_string (after normalization) in ${filePath}. Add more context to make it unique (or set "replace_all": true).`,
              isError: true,
            };
          }
          nextContent = fuzzy.content;
          headline = `Successfully replaced old_string (Unicode/whitespace-tolerant match) in ${filePath}`;
        } else {
          // Never replace the FIRST occurrence silently when more exist:
          // reject like Edit does, unless replace_all is explicit.
          if (original.indexOf(oldStr, idx + oldStr.length) !== -1) {
            return {
              content: `StrReplace failed: old_string occurs more than once in ${filePath}. Add more context or set "replace_all": true.`,
              isError: true,
            };
          }
          nextContent = original.slice(0, idx) + newStr + original.slice(idx + oldStr.length);
          headline = `Successfully replaced old_string in ${filePath}`;
        }
      }

      // Change preview for the dedicated diff bubble (mixed +/−), like the
      // other file tools — one shared fenced format.
      this.fs.writeText(filePath, nextContent);
      return { content: headline + fencedDiffBlock(buildDiff(original, nextContent)), isError: false };
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
