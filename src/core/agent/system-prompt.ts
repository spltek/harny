import type { ToolDefinition } from "../tools/tool";
import type { ChatMode } from "../tools/mode-policy";
import { isAnalyzeMode } from "../tools/mode-policy";
import { DELEGATE_TOOL_NAME } from "./orchestration";

export interface SystemPromptBuilder {
  /**
   * @param mode current chat mode
   * @param toolDefinitions the EFFECTIVE tool set for this turn (mode-filtered
   *   and, for sub-agents / multi-off, Delegate-excluded). When omitted the
   *   builder falls back to its own definitions thunk.
   */
  build(mode?: ChatMode, toolDefinitions?: readonly ToolDefinition[]): string;
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

  build(mode: ChatMode = "analyze", effective?: readonly ToolDefinition[]): string {
    const cwd = this.cwd();
    const definitions = effective ? [...effective] : this.toolDefinitions(mode);
    const toolList = definitions.map((d) => `- ${d.name}: ${this.summarize(d.description)}`).join("\n");
    const analyzeRules =
      isAnalyzeMode(mode)
        ? `

READ-ONLY MODE (Analyze) — STRICT RULES:
- You are in READ-ONLY mode: you inspect and answer, you NEVER modify anything.
- The file-modifying tools (Write, StrReplace, Edit, Delete) are NOT available to you.
- If you delegate sub-agents, they MUST be read-only too (access: "read") — a write/create delegate is refused in this mode.
- The Shell tool runs read-only: any command that would write, delete, move, rename, create, install or build files is refused before it runs. Do not try to work around it (no redirection, no scripts that write). Prefer the Read/Grep/Glob tools for inspection.
- Do NOT run commands that modify the project (git add/commit/push, npm install, mkdir, touch, ...). Use Shell only for read-only inspection (ls, cat, find, git status/diff/log, tests that run without writing would still be refused if they write — so prefer Read/Grep/Glob).
- Analyse the code, explain it, point out problems and propose what the change would be — but make no changes.`
        : "";

    // Orchestration guidance appears only when the Delegate tool is available
    // (i.e. when the "Parallel" toggle is ON). It is deliberately DIRECTIVE:
    // the agent must act as an orchestrator and actually use sub-agents.
    const hasDelegate = definitions.some((d) => d.name === DELEGATE_TOOL_NAME);
    const orchestratorIntro = hasDelegate
      ? `\nORCHESTRATION MODE: the "Parallel" toggle is ON. You are the ORCHESTRATOR: coordinate SUB-AGENTS through the Delegate tool, and prefer delegating independent work over doing everything yourself.`
      : "";
    const delegateRules = hasDelegate
      ? `

ORCHESTRATION — you coordinate SUB-AGENTS via the Delegate tool:
- You are the ORCHESTRATOR. Your default strategy is to DECOMPOSE the request and DELEGATE independent sub-tasks to SUB-AGENTS. Delegating is the NORM here, not the exception.
- MANDATORY FIRST STEP, for EVERY request (never skip): assess whether the task can be parallelized with SUB-AGENTS. List the candidate sub-tasks and, for each, what it touches and how (read vs write):
  · read-only parts on disjoint (or shared-read) resources → PARALLELIZABLE: run the SUB-AGENTS in parallel;
  · any part that WRITES, or shares a file with another part → NOT parallel: serialize (after) or keep it for yourself.
- Then ACT on it: launch a SUB-AGENT (a Delegate call) for EACH independent sub-task you identified. CRITICAL: emit ALL the read-only Delegate calls in ONE SINGLE turn (same assistant message) — several Delegate calls together. If you emit them one per turn they run SERIALLY, defeating the parallelism. Do work yourself ONLY for the core reasoning, a single trivial step, or a write/shared resource you must own — do NOT silently fall back to doing everything serially.
- ALWAYS declare resources (exact files/dirs) and access (read/write/create) on every Delegate call — an undeclared delegate is rejected.
- WRITES TO DISJOINT FILES RUN IN PARALLEL: several write/create SUB-AGENTS on DIFFERENT files (or non-overlapping dirs) run together, up to the cap. Two writers that touch the SAME file (or overlapping paths) are serialized automatically — never give the same file to two writers; use after, or assign a single owner. A reader of a file being written is serialized too. Sibling results arrive together.
- Ordering: use after: ["id"] when a sub-task needs another sub-task's output.
- Keep sub-tasks bounded (each SUB-AGENT has a turn budget) and genuinely independent.`
      : "";

    return `You are Harny, an expert AI coding agent embedded in VS Code.
Working directory: ${cwd}${orchestratorIntro}

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
- When broadly exploring the codebase, prefer Grep and Glob over Shell find/grep.
- Never repeat the same tool call with identical arguments: if it failed or returned nothing, change approach (Glob/Grep/Read or different arguments) instead of retrying it.${delegateRules}${analyzeRules}`;
  }

  private summarize(description: string): string {
    const first = description.split("\n")[0].trim();
    return first.length > 120 ? first.slice(0, 120) + "..." : first;
  }
}

/** Options describing a delegated sub-agent, provided by the orchestrator. */
export interface SubAgentPromptOptions {
  role?: string;
  access: "read" | "write" | "create";
  resources: readonly string[];
  /** Turn budget hint: the model is told to wrap up within it. */
  turnBudget?: number;
}

/**
 * System prompt for a DELEGATED sub-agent: a focused worker that completes one
 * task and reports back. The FRAME (role, boundaries, report contract, tool
 * rules) is owned by the host; the orchestrator only supplies the goal/context
 * (the user seed message). Read-only sub-agents get the Analyze rules; writers
 * are told the exact resources they own.
 */
export class SubAgentSystemPromptBuilder implements SystemPromptBuilder {
  constructor(
    private toolDefinitions: (mode: ChatMode) => ToolDefinition[],
    private cwd: () => string,
    private options: SubAgentPromptOptions,
  ) {}

  build(mode: ChatMode = "analyze", effective?: readonly ToolDefinition[]): string {
    const cwd = this.cwd();
    const definitions = effective ? [...effective] : this.toolDefinitions(mode);
    const toolList = definitions
      .map((d) => `- ${d.name}: ${this.summarize(d.description)}`)
      .join("\n");
    const role = this.options.role ? `Your role: ${this.options.role}.` : "Your role: a focused generalist worker.";
    const readOnly = this.options.access === "read";
    const resourceRule = readOnly
      ? `You are READ-ONLY: you must NOT modify any file. Your read scope: ${this.options.resources.join(", ")}.`
      : `You may ${this.options.access} ONLY these resources (own them): ${this.options.resources.join(", ")}. ` +
        "Do not touch anything else; another agent may own it.";
    const readOnlyRules = readOnly
      ? `\n- The file-modifying tools are disabled and Shell is read-only: no writes, redirects, installs or builds.`
      : "";
    const budgetRule = this.options.turnBudget
      ? `\n- BUDGET: you have about ${this.options.turnBudget} tool turns. Work efficiently, do not over-explore, and STOP calling tools to write your report well within the budget.`
      : "";

    return `You are a sub-agent of Harny, launched by the main Harny agent to complete ONE focused task and report back.
Working directory: ${cwd}
${role}
${resourceRule}

Rules:
- Complete ONLY the task in the user message. Do not ask questions or make conversation.
- Be concise and get to the point.${readOnlyRules}${budgetRule}
- NEVER repeat the same tool call with identical arguments. If it errors or returns nothing, change approach (Glob/Grep/Read, or different arguments) — retrying verbatim wastes turns and gets you stopped.
- Prefer Glob/Grep/Read to explore and read files; use Shell only when no dedicated tool fits (and never the same command twice).
- A turn with NO tool call counts as your final answer: when the task is done, reply with your REPORT.
- REPORT FORMAT (your last message): what you did, key findings/results, files touched (if any), blockers. No filler.
- Use tools for real; never just announce an action. Prefer Read/Grep/Glob to inspect before editing.

You have access to these tools:
${toolList}`;
  }

  private summarize(description: string): string {
    const first = description.split("\n")[0].trim();
    return first.length > 120 ? first.slice(0, 120) + "..." : first;
  }
}