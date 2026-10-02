import type { FileSystem } from "./file-system";
import { resolvePath } from "./path-utils";
import { isBinaryText } from "./binary";
import { globstarToRegex } from "./glob-tool";
import { walkFiles } from "./walk";
import { matchAll, RegexTimeoutError } from "./regex-worker";
import type { Tool, ToolDefinition, ToolResult } from "./tool";

/** Max file size read while grepping (perf guard). */
const MAX_FILE_BYTES = 10 * 1024 * 1024;
/** Total bytes read per call before stopping early (OOM/hang guard). */
const SCAN_BUDGET_BYTES = 64 * 1024 * 1024;
/** Hard cap on regex evaluation in the worker (anti-ReDoS). */
const MATCH_TIMEOUT_MS = 5000;

/** `rg --type` name → file extensions (or exact filenames). */
const TYPE_MAP: Record<string, string[]> = {
  js: [".js", ".jsx", ".mjs", ".cjs"],
  ts: [".ts", ".tsx", ".mts", ".cts"],
  py: [".py", ".pyi"],
  rust: [".rs"],
  go: [".go"],
  java: [".java"],
  c: [".c", ".h"],
  cpp: [".cpp", ".cc", ".cxx", ".hpp", ".hh", ".hxx"],
  csharp: [".cs"],
  ruby: [".rb"],
  php: [".php"],
  html: [".html", ".htm"],
  css: [".css", ".scss", ".sass", ".less"],
  json: [".json"],
  yaml: [".yaml", ".yml"],
  toml: [".toml"],
  md: [".md", ".markdown"],
  sh: [".sh", ".bash", ".zsh"],
  sql: [".sql"],
  xml: [".xml"],
  kotlin: [".kt", ".kts"],
  swift: [".swift"],
  scala: [".scala"],
  lua: [".lua"],
  vue: [".vue"],
  svelte: [".svelte"],
  dart: [".dart"],
  elixir: [".ex", ".exs"],
  clojure: [".clj", ".cljs", ".cljc"],
  haskell: [".hs"],
  r: [".r"],
  perl: [".pl", ".pm"],
  docker: ["Dockerfile"],
  make: ["Makefile"],
};

function matchesType(file: string, exts: readonly string[]): boolean {
  const base = file.replace(/\\/g, "/").split("/").pop() ?? "";
  const lower = base.toLowerCase();
  const dot = lower.lastIndexOf(".");
  const ext = dot >= 0 ? lower.slice(dot) : "";
  return exts.some((t) => (t.startsWith(".") ? ext === t.toLowerCase() : base === t));
}

/**
 * Content search tool. The filesystem walk is pure Node (identical on every
 * OS) and the REGEX runs in a worker thread with a hard timeout, so a
 * catastrophic pattern can never freeze the extension host.
 */
export class GrepTool implements Tool {
  readonly name = "Grep";
  readonly definition: ToolDefinition = {
    name: "Grep",
    description:
      "A fast content search tool. Results are capped for responsiveness; when truncated, the results report \"at least\" counts, but are otherwise accurate.\n\n" +
      "DIRECTORY searches skip hidden (dot-)files by default — pass hidden: true to include them, or target " +
      "the file path directly. Binary files are not displayed (a single binary target is flagged explicitly).",
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
        "-A": { type: "number", description: "Number of lines to show after each match." },
        "-B": { type: "number", description: "Number of lines to show before each match." },
        "-C": { type: "number", description: "Number of lines to show before and after each match." },
        "-i": { type: "boolean", description: "Case insensitive search. Defaults to false." },
        type: { type: "string", description: "File type to search (e.g. ts, py, go)." },
        head_limit: { type: "number", minimum: 0, description: "Limit output size." },
        offset: { type: "number", minimum: 0, description: "Skip first N entries." },
        hidden: { type: "boolean", description: "Include hidden (dot-)files when searching a directory. Default false." },
        multiline: { type: "boolean", description: "Enable multiline mode ('.' also matches newlines)." },
      },
      required: ["pattern"],
    },
  };

  constructor(
    private fs: FileSystem,
    private cwd: () => string,
  ) {}

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const pattern = args.pattern as string | undefined;
    if (!pattern) {
      return {
        content: 'Tool Grep requires the argument "pattern" (regex string). Call again with {"pattern": "searchTerm"}.',
        isError: true,
      };
    }

    const searchPath = args.path ? resolvePath(args.path as string, this.cwd()) : this.cwd();
    if (args.path && !this.fs.exists(searchPath)) {
      return { content: `Path not found: ${searchPath}`, isError: true };
    }

    const outputMode = (args.output_mode as string) || "content";
    const multiline = !!args.multiline;
    const ignoreCase = !!args["-i"];

    const globRe = args.glob ? new RegExp(".*" + globstarToRegex(args.glob as string) + "$") : undefined;
    const typeExts = args.type ? TYPE_MAP[(args.type as string).toLowerCase()] : undefined;
    if (args.type && !typeExts) {
      return { content: `Grep: unrecognized file type "${args.type}".`, isError: true };
    }

    const targetIsDir = this.fs.isDirectory(searchPath);

    // A single BINARY file target is flagged explicitly.
    if (args.path && !targetIsDir) {
      try {
        if (isBinaryText(this.fs.readText(searchPath))) {
          return { content: `skipped binary file: ${searchPath}`, isError: false };
        }
      } catch {
        /* unreadable: fall through */
      }
    }

    const allFiles = targetIsDir
      ? walkFiles(this.fs, searchPath, { skipHidden: !args.hidden, maxFiles: 20000 })
      : [searchPath];
    const files = allFiles.filter((f) => {
      const norm = f.replace(/\\/g, "/");
      if (globRe && !globRe.test(norm)) return false;
      if (typeExts && !matchesType(norm, typeExts)) return false;
      return true;
    });

    // Read + binary-filter in the MAIN thread (bounded); the worker only does
    // the regex. `items` order is preserved by the worker's results.
    const items: { path: string; text: string }[] = [];
    let scannedBytes = 0;
    let budgetHit = false;
    for (const file of files) {
      if (scannedBytes >= SCAN_BUDGET_BYTES) {
        budgetHit = true;
        break;
      }
      let text: string;
      try {
        const sz = this.fs.exists(file) ? this.fs.size(file) : 0;
        if (sz > MAX_FILE_BYTES) continue;
        scannedBytes += sz;
        text = this.fs.readText(file);
      } catch {
        continue;
      }
      if (isBinaryText(text)) continue;
      items.push({ path: file, text });
    }

    const flags = (ignoreCase ? "i" : "") + (multiline ? "s" : "");
    let results: Array<{ path: string; hit?: number[]; at?: number }>;
    try {
      const res = await matchAll(pattern, flags, multiline, items, MATCH_TIMEOUT_MS);
      if (res.error) return { content: `Grep error parsing regex: ${res.error}`, isError: true };
      results = res.results ?? [];
    } catch (e) {
      if (e instanceof RegexTimeoutError) {
        return {
          content:
            "Grep: the pattern took too long to evaluate (possible catastrophic backtracking). " +
            "Simplify it — avoid nested quantifiers like (a+)+ and prefer anchors/literals.",
          isError: true,
        };
      }
      throw e;
    }

    const ctxC = args["-C"] as number | undefined;
    const nBefore = ctxC ?? (args["-B"] as number | undefined) ?? 0;
    const nAfter = ctxC ?? (args["-A"] as number | undefined) ?? 0;

    const contentLines: string[] = [];
    const matchedFiles: string[] = [];
    const counts: string[] = [];

    for (let idx = 0; idx < items.length; idx++) {
      const item = items[idx];
      const r = results[idx];
      if (!r) continue;

      if (multiline) {
        if (r.at === undefined || r.at < 0) continue;
        if (outputMode === "files_with_matches") {
          matchedFiles.push(item.path);
        } else if (outputMode === "count") {
          counts.push(`${item.path}:1`);
        } else {
          const lineNo = item.text.slice(0, r.at).split(/\r?\n/).length;
          const line = item.text.split(/\r?\n/)[lineNo - 1] ?? "";
          contentLines.push(`${item.path}:${lineNo}:${line}`);
        }
        continue;
      }

      const hit = r.hit ?? [];
      if (hit.length === 0) continue;

      if (outputMode === "files_with_matches") {
        matchedFiles.push(item.path);
        continue;
      }
      if (outputMode === "count") {
        counts.push(`${item.path}:${hit.length}`);
        continue;
      }

      const lines = item.text.split(/\r?\n/);
      const hitSet = new Set(hit);
      const emitted = new Set<number>();
      let lastPrinted = -2;
      for (const i of hit) {
        const start = Math.max(0, i - nBefore);
        const end = Math.min(lines.length - 1, i + nAfter);
        for (let j = start; j <= end; j++) {
          if (emitted.has(j)) continue;
          if (emitted.size > 0 && j > lastPrinted + 1) contentLines.push("--");
          emitted.add(j);
          lastPrinted = j;
          const sep = hitSet.has(j) ? ":" : "-";
          contentLines.push(`${item.path}${sep}${j + 1}${sep}${lines[j]}`);
        }
      }
    }

    const incomplete = budgetHit
      ? "\n\n[Scan stopped early: size budget reached — results may be incomplete.]"
      : "";
    const raw =
      outputMode === "files_with_matches" ? matchedFiles : outputMode === "count" ? counts : contentLines;

    if (raw.length === 0) {
      let hint = "";
      if (!args.hidden && args.path && targetIsDir) {
        try {
          const entries = this.fs.list(searchPath);
          const hiddenCount = entries.filter((e) => e.startsWith(".") && e !== "." && e !== "..").length;
          if (hiddenCount > 0) {
            hint =
              `\n${hiddenCount} hidden entr${hiddenCount === 1 ? "y" : "ies"} in the searched folder were skipped by default. ` +
              'Re-run with "hidden": true, or target the file path directly, to include dot-files.';
          }
        } catch {
          /* not a directory or list unsupported: no hint */
        }
      }
      return { content: "No matches found" + hint + incomplete, isError: false };
    }

    const offset = (args.offset as number | undefined) || 0;
    const headLimit = args.head_limit as number | undefined;
    const limit = headLimit ?? raw.length;
    const sliced = raw.slice(offset, offset + limit);
    if (sliced.length === 0) {
      return {
        content: `[Showing 0 of at least ${raw.length} matches — adjust offset/head_limit]`,
        isError: false,
      };
    }
    const joined = sliced.join("\n");
    const truncated =
      sliced.length < raw.length
        ? `${joined}\n\n[Showing ${offset + 1}-${offset + sliced.length} of at least ${raw.length} matches]`
        : joined;

    return { content: (truncated + incomplete).slice(0, 30000), isError: false };
  }
}
