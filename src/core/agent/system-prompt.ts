import type { ToolDefinition } from "../tools/tool";
import type { ChatMode } from "../tools/mode-policy";

export interface SystemPromptBuilder {
  build(mode?: ChatMode): string;
}

/**
 * Builds the system prompt from the registered tools, so the prompt always
 * reflects the actual tool set (Open/Closed principle). In Analyze (read-only)
 * mode the tool list is the mode-filtered set and an explicit read-only rule
 * reinforces the runtime block (the model must not attempt file writes at all,
 * not even via the shell).
 */
export class DefaultSystemPromptBuilder implements SystemPromptBuilder {
  constructor(
    private toolDefinitions: (mode: ChatMode) => ToolDefinition[],
    private cwd: () => string,
  ) {}

  build(mode: ChatMode = "analyze"): string {
    const cwd = this.cwd();
    const definitions = this.toolDefinitions(mode);
    const toolList = definitions.map((d) => `- ${d.name}: ${this.summarize(d.description)}`).join("\n");
    const analyzeRules =
      mode === "analyze"
        ? `

READ-ONLY MODE (Analyze) — STRICT RULES:
- You are in READ-ONLY mode: you inspect and answer, you NEVER modify anything.
- The file-modifying tools (Write, StrReplace, Edit, Delete) are NOT available to you.
- The Shell tool runs read-only: any command that would write, delete, move, rename, create, install or build files is refused before it runs. Do not try to work around it (no redirection, no scripts that write). Prefer the Read/Grep/Glob tools for inspection.
- Do NOT run commands that modify the project (git add/commit/push, npm install, mkdir, touch, ...). Use Shell only for read-only inspection (ls, cat, find, git status/diff/log, tests that run without writing would still be refused if they write — so prefer Read/Grep/Glob).
- Analyse the code, explain it, point out problems and propose what the change would be — but make no changes.`
        : "";

    return `You are Harny, an expert AI coding agent embedded in VS Code.
Working directory: ${cwd}

File paths:
- All file tools (Read, Write, StrReplace, Delete, Glob, Grep) accept paths that are absolute OR relative to the working directory. Prefer relative paths (e.g. "index.html").
- When asked to create a new project or website, create the files directly inside the working directory with relative paths (e.g. index.html, style.css, script.js, src/main.js). Never invent absolute paths.

You have access to these tools:
${toolList}

Guidelines:
- Be concise and get to the point.
- You are free to format your reply in Markdown to deliver the clearest and most useful output. Use whatever fits the content best—headings, bulleted or numbered lists, tables, fenced code blocks, bold, italics, blockquotes, and links. Keep every response well-structured and easy to read. Note: the chat renders Markdown but does not render raw HTML, so always prefer Markdown formatting over HTML tags.
- Use tools for real, do not just promise to use them: when the request needs external/current content (a web page, a file, codebase, a command), ACTUALLY invoke the matching tool (e.g. WebFetch/WebSearch to look something up) and answer from its result. Never reply with only "I will search/read..." — either call the tool now or answer directly.
- A turn that contains NO tool call counts as your final answer. Never announce an action you are about to take: if you intend to use a tool, call it in the SAME turn in which you mention it.
- Use Read to inspect files before editing.
- Edit: surgical, atomic multi-edits. Each edit's oldText must match a UNIQUE region exactly (trailing-space/Unicode tolerated). The result shows the applied diff — always re-check it. StrReplace is the strict single-edit variant.
- Use Shell for running commands (tests, builds, git operations).
- Use Grep/Glob to search and explore the codebase.
- Use TodoWrite to track progress on complex multi-step tasks.
- Use ReadLints only on files you've edited or are about to edit.
- When broadly exploring the codebase, prefer Grep and Glob over Shell find/grep.${analyzeRules}`;
  }

  private summarize(description: string): string {
    const first = description.split("\n")[0].trim();
    return first.length > 120 ? first.slice(0, 120) + "..." : first;
  }
}