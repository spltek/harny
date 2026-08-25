import { relative } from "node:path";
import type { DiagnosticsProvider } from "./diagnostics-provider";
import { resolvePath } from "./path-utils";
import type { Tool, ToolDefinition, ToolResult } from "./tool";

export class ReadLintsTool implements Tool {
  readonly name = "ReadLints";
  readonly definition: ToolDefinition = {
    name: "ReadLints",
    description:
      "Read and display linter errors from the current workspace. You can provide paths to specific files or directories, or omit the argument to get diagnostics for all files.\n\n" +
      "- If a file path is provided, returns diagnostics for that file only\n" +
      "- If a directory path is provided, returns diagnostics for all files within that directory\n" +
      "- If no path is provided, returns diagnostics for all files in the workspace\n" +
      "- NEVER call this tool on a file unless you've edited it or are about to edit it",
    parameters: {
      type: "object",
      properties: {
        paths: {
          type: "array",
          items: { type: "string" },
          description: "Optional. An array of paths to files or directories to read linter errors for.",
        },
      },
    },
  };

  constructor(
    private diagnostics: DiagnosticsProvider,
    private cwd: () => string,
  ) {}

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const paths = args.paths as string[] | undefined;
    const cwd = this.cwd();
    const all = this.diagnostics.getDiagnostics();

    let entries = all;
    if (paths && paths.length > 0) {
      const resolved = paths.map((p) => resolvePath(p, cwd));
      entries = all.filter(({ uri }) => {
        const uriPath = uri;
        return resolved.some((rp) => uriPath === rp || uriPath.startsWith(rp + "/") || uriPath.startsWith(rp + "\\"));
      });
    }

    const withIssues = entries.filter(({ diagnostics: ds }) => ds.length > 0);
    if (entries.length === 0 || withIssues.length === 0) {
      return { content: "No linter errors found.", isError: false };
    }

    const lines: string[] = [];
    let totalErrors = 0;
    let totalWarnings = 0;

    for (const { uri, diagnostics: ds } of withIssues) {
      const relPath = relative(cwd, uri) || uri;
      lines.push(`\n### ${relPath}`);
      for (const d of ds) {
        const icon = d.severity === 0 ? "❌" : d.severity === 1 ? "⚠️" : "ℹ️";
        const sev = d.severity === 0 ? "ERROR" : d.severity === 1 ? "WARN" : "INFO";
        lines.push(`${icon} [${sev}] L${d.line + 1}:${d.character + 1} - ${d.message}`);
        if (d.severity === 0) totalErrors++;
        else if (d.severity === 1) totalWarnings++;
      }
    }

    const summary = `\n\n---\n**Total:** ${totalErrors} error(s), ${totalWarnings} warning(s)`;
    return { content: lines.join("\n") + summary, isError: false };
  }
}
