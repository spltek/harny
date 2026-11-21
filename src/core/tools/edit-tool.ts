import type { FileSystem } from "./file-system";
import { resolvePath } from "./path-utils";
import { FILE_PREVIEW_NOTE } from "./mode-policy";
import type { Tool, ToolContext, ToolDefinition, ToolResult } from "./tool";
import { applyEdits, checkStructuralBalance, closestContext, type EditOp } from "./edit-engine";
import { diffStat, fencedDiffBlock } from "./diff-text";

/**
 * Surgical multi-edit file tool with a predictable contract (like pi): each
 * edit is oldText→newText (exact, unique) or a before/after insertion. Exact
 * matches first; a light normalization (trailing whitespace, Unicode quotes/
 * dashes) is tolerated, NOT structural guessing. All edits apply atomically;
 * on success the RESULT reports the applied unified diff (feedback + preview).
 */
export class EditTool implements Tool {
  readonly name = "Edit";
  readonly analyzePolicy = "preview" as const;
  /** What the model is told about this tool IN ANALYZE ONLY. */
  readonly analyzeNote = FILE_PREVIEW_NOTE;
  readonly definition: ToolDefinition = {
    name: "Edit",
    description:
      "Applies one or more surgical edits to a file atomically. " +
      "Each edit is { oldText, newText } (oldText must exactly match a UNIQUE region; " +
      "if it appears more than once, extend oldText until it is unique) or " +
      "{ beforeText, newText } to insert a line before an anchor. " +
      "If two edits touch the same block, merge them into ONE edit. " +
      "The result shows the applied diff.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path, absolute or relative to the working directory" },
        edits: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            properties: {
              oldText: { type: "string", description: "Exact text to replace (must be unique in the file)" },
              newText: { type: "string", description: "Replacement text (empty deletes oldText)" },
              beforeText: {
                type: "string",
                description: "Anchor line: the new text is inserted BEFORE this line",
              },
              // NOT "insert after": the engine inserts BEFORE whatever anchor it
              // finds (beforeText ?? afterText), so the name only means "the line
              // that follows the insertion". It is also NOT a way to disambiguate a
              // replacement — beforeText/afterText are never read on the
              // oldText+newText branch; extend oldText instead.
              afterText: {
                type: "string",
                description: "Fallback anchor when beforeText is absent — the text still lands BEFORE this line",
              },
            },
          },
        },
      },
      required: ["path", "edits"],
    },
  };

  constructor(
    private fs: FileSystem,
    private cwd: () => string,
  ) {}

  execute(args: Record<string, unknown>, ctx?: ToolContext): ToolResult {
    const pathArg = args.path as string | undefined;
    const edits = args.edits as EditOp[] | undefined;
    if (!pathArg || !Array.isArray(edits) || edits.length === 0) {
      return {
        content:
          'Tool Edit requires:\n- "path": file path (string)\n- "edits": non-empty array of {oldText,newText} or {beforeText,newText}',
        isError: true,
      };
    }
    const filePath = resolvePath(pathArg, this.cwd());
    if (!this.fs.exists(filePath)) {
      return { content: `File not found: ${filePath}`, isError: true };
    }

    try {
      const original = this.fs.readText(filePath);
      const result = applyEdits(original, edits);

      if (result.failed.length > 0) {
        const anyNotFound = result.failed.some((f) => f.reason.includes("not found"));
        const head = anyNotFound
          ? "\nFile starts with:\n```\n" +
            original
              .split("\n")
              .slice(0, 6)
              .map((l, i) => `  ${i + 1}| ${l}`)
              .join("\n") +
            (original.split("\n").length > 6 ? "\n  …" : "") +
            "\n```"
          : "";
        const details = result.failed
          .map((f) => {
            const ctx =
              f.anchor && /not found|occurrences/.test(f.reason)
                ? "\nNearby lines in the file:\n```\n" + closestContext(original, f.anchor).join("\n") + "\n```"
                : "";
            const headLine = `- edit #${f.index}: ${f.reason}`;
            const anchor = f.anchor
              ? `\n  \`\`\`\n${f.anchor.slice(0, 200)}${f.anchor.length > 200 ? "..." : ""}\n  \`\`\``
              : "";
            const detail = f.detail ? `\n  ${f.detail}` : "";
            return headLine + anchor + detail + ctx;
          })
          .join("\n");
        return {
          content:
            `Edit partially applied (${result.applied}/${edits.length}) on ${filePath}; NOT written to disk. ` +
            `Re-Read the file first — the quoted oldText may be stale or belong to another file.\nFailed edits:\n${details}${head}`,
          isError: true,
        };
      }

      // Structural safety net: a valid file must stay balanced. If the applied
      // edit would break the structure, refuse to write (never corrupt on disk).
      const before = checkStructuralBalance(original);
      const after = checkStructuralBalance(result.content);
      if (before.balanced && !after.balanced) {
        return {
          content:
            `Edit rejected: the change would break the file's structure (${after.message ?? "unbalanced"}). ` +
            "NOT written to disk. Re-emit a correct edit.",
          isError: true,
        };
      }

      const stat = result.diff ? diffStat(result.diff) : "+0/-0";
      // Analyze (preview) mode: validate + diff, but do NOT write to disk.
      if (ctx?.dryRun) {
        return {
          content:
            `PROPOSED (preview — NOT applied): ${result.applied} edit(s) (${result.modes.join(", ")}) to ${filePath} — ${stat}.` +
            fencedDiffBlock(result.diff),
          isError: false,
        };
      }
      this.fs.writeText(filePath, result.content);
      return {
        content:
          `Applied ${result.applied} edit(s) (${result.modes.join(", ")}) to ${filePath} — ${stat}.` +
          fencedDiffBlock(result.diff),
        isError: false,
      };
    } catch (err: any) {
      return { content: `Error editing file: ${err.message}`, isError: true };
    }
  }
}
