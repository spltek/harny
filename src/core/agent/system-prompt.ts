import type { ToolDefinition } from "../tools/tool";
import type { ChatMode } from "../tools/mode-policy";
import { isAnalyzeMode } from "../tools/mode-policy";
import type { SkillMeta } from "../skills/types";
import { SKILL_TOOL_NAME } from "../tools/skill-tool";
import { defaultShell, isWindows } from "../platform";
import { DELEGATE_TOOL_NAME } from "./orchestration";

/** The sentence the model must end with after preparing changes in Analyze
 * (read-only preview) mode, so the user knows to switch to Build to apply. */
export const BUILD_SWITCH_HINT = "➡️ Switch to **Build** to apply the changes.";

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
    /** Installed Agent Skills (catalog only; bodies load on activation). */
    private skills: () => readonly SkillMeta[] = () => [],
  ) {}

  build(mode: ChatMode = "analyze", effective?: readonly ToolDefinition[]): string {
    const cwd = this.cwd();
    const definitions = effective ? [...effective] : this.toolDefinitions(mode);
    const toolList = definitions.map((d) => `- ${d.name}: ${this.summarize(d.description)}`).join("\n");
    // Skills catalog (progressive disclosure): only name + description here; the
    // Skill tool loads the full instructions on demand. Skills marked
    // `disable-model-invocation` are EXCLUDED (manual activation only).
    const installedSkills = this.skills().filter((s) => !s.disableModelInvocation);
    const skillsSection =
      installedSkills.length > 0
        ? `\n\n## Skills\nWhen the task matches one of these skills, ACTIVATE it first by calling the ${SKILL_TOOL_NAME} tool with its exact name, then follow the returned instructions:\n` +
          installedSkills.map((s) => `- ${s.name}: ${s.description}`).join("\n")
        : "";
    const hasDelegate = definitions.some((d) => d.name === DELEGATE_TOOL_NAME);
    // The sub-agent read-only note is only meaningful when Delegate is actually
    // available (Parallel ON); with Parallel OFF the model must not even know
    // that sub-tasks exist.
    const delegateReadOnlyRule = hasDelegate
      ? `\n- If you delegate sub-agents, they MUST be read-only too (access: "read") — a write/create delegate is refused in this mode.`
      : "";
    const analyzeRules =
      isAnalyzeMode(mode)
        ? `

READ-ONLY MODE (Analyze) — PREVIEW RULES:
- You are in Analyze (read-only PREVIEW): you inspect, explain and PREPARE changes — you NEVER apply them.
- The file-modifying tools (Write, StrReplace, Edit, Delete) run as PREVIEWS: they validate the change and return the exact diff, but write NOTHING to disk.
- When the user asks for a modification, PREPARE it for real: Read the target files first, then call the file tools with the exact edits. The result is a validated PROPOSAL shown in the chat — not a written change.
- NEVER claim a change was applied: it was only prepared. ONLY if you actually PREPARED changes (you ran Write/Edit/StrReplace/Delete and got a preview), END your reply with this exact line on its own:
  "${BUILD_SWITCH_HINT}"
- If the request needs no code change (a pure question, research or explanation), just answer: do NOT prepare edits and do NOT mention Build or applying changes — there is nothing to apply.${delegateReadOnlyRule}
- The Shell tool runs read-only: any command that would write, delete, move, rename, create, install or build files is refused before it runs. Do not try to work around it (no redirection, no scripts that write). Prefer the Read/Grep/Glob tools for inspection.`
        : "";

    const orchestratorIntro = hasDelegate
      ? `\nPARALLEL IS ON. PARALLELISM MEANS SUB-TASKS: to run work in parallel you MUST call Delegate — one ` +
        `Delegate per part, ALL in the SAME turn. Your own tool calls run one after another and are NOT parallel. ` +
        `Split the request into parts that do not depend on each other${
          isAnalyzeMode(mode) ? "" : " and do not write the same file/dir"
        }; then emit the Delegate calls now. See the PARALLELISM section at the end.`
      : "";
    // Mode-aware conflict rule, written for BOTH strong and small models: short
    // sentences, ordered questions, concrete examples.
    const parallelConflict = isAnalyzeMode(mode)
      ? `2. RESOURCE CONFLICT — in Analyze NOTHING is written (every file change is only a preview), so two parts can NEVER conflict, not even on the same file. IMPORTANT: in Analyze every sub-agent is READ-ONLY — delegate with access "read" (a "write"/"create" delegate is REFUSED); the parallel parts still PREPARE the changes as previews.`
      : `2. RESOURCE CONFLICT — do two parts touch the SAME file/dir AND at least one of them WRITES it (write+write, or write+read)? YES → not splittable: run them one at a time, or order them with after. Two parts that only READ never conflict. Two different files never conflict.`;
    const parallelExamples = isAnalyzeMode(mode)
      ? `- "check the weather" AND "read config.ts" → no dependency, nothing is written → 2 Delegate calls.\n` +
        `- "write file A" AND "write file B" → 2 Delegate calls, BOTH with access "read" (they PREPARE the previews; nothing is written).\n` +
        `- two parts that both READ the same file → no conflict → 2 Delegate calls.\n` +
        `- "find X" then "summarize X" → the second needs the first's result (DEPENDENCY) → order with after.`
      : `- "check the weather" AND "write a poem to a file" → different resources → 2 Delegate calls.\n` +
        `- "edit a.ts" AND "edit b.ts" → different files → 2 Delegate calls.\n` +
        `- "edit a.ts" AND "read a.ts" → same file, one writes → CONFLICT → one at a time.\n` +
        `- two parts that both only READ the same file → no conflict → 2 Delegate calls.`;
    const delegateRules = hasDelegate
      ? `

PARALLELISM — Parallel is ON.

A sub-agent is called Delegate. PARALLEL work runs ONLY as multiple Delegate calls: your own tool calls in one turn run one after another and are NOT parallel. So to go parallel, you MUST call Delegate.

SPLIT DECISION — answer these questions in order; if there is no problem, the work IS splittable and you MUST delegate:
1. DEPENDENCY — does one part need another part's result? YES → not splittable: do it yourself, or order the sub-tasks with after.
${parallelConflict}

If there is no dependency and no conflict → the work IS splittable → emit ONE Delegate call per part, ALL in this SAME turn. Do NOT do the parts with your own tools. It does not matter whether the parts are the SAME operation on different targets or COMPLETELY DIFFERENT tasks.

EXAMPLES
${parallelExamples}

HARD RULE — from decision to action: if the work is splittable, the Delegate calls MUST be in the SAME turn in which you decide it. A turn that says or thinks "I will parallelize" but contains NO Delegate call is WRONG — never send it. Before you end ANY turn, check: was the work splittable? If yes, does this turn contain one Delegate call per part? If not, emit them NOW.

PLANNING A DELEGATE:
- Emit ALL independent Delegate calls in the SAME assistant turn (up to the configured cap); use after: ["id"] for dependencies. A short plan before the calls is welcome.
- id: SHORT and MEANINGFUL (e.g. "api", "ui-tests" — never "A"/"1").
- resources: the files AND/OR dirs the sub-task reads or writes (relative to the working directory; EMPTY only for read-only tasks that touch no files, e.g. web research — writers MUST list what they touch). Declaring resources is a coordination contract, NOT a sandbox: it lets the host avoid write conflicts, but it does not restrict what a sub-agent may touch.
- attachments: a sub-agent does NOT see the user's files/images unless you forward them. When the user's message carries attachments (the numbered [User attachments] list), give each sub-task ONLY the ones it needs ("attachments: [1]", or "[2, 3]"); OMIT the field to forward ALL of them (the default — nothing is lost).
- access: "read" (inspect only), "write" (modify existing files) or "create" (new files).
- goal/context: STEER the sub-agent. It has the SAME tools and the SAME skills catalog as you, but it does NOT see this conversation or your plan: name the tool or skill it must use when that matters (e.g. "use the pptx skill", "Grep for X then Read the matches") and hand it, in context, the facts it needs.
- Conflict rule the host applies: it serializes two sub-tasks ONLY when they share a resource AND at least one WRITES it; two readers, or two different files, always run together.

AFTER DELEGATING:
- Wait for the reports (they arrive as tool results). Do NOT re-run a sub-task that is already running.
- Synthesize ONE final answer from the reports: what was done, key results, files touched, blockers. Never claim what no sub-agent reported.
- Every report ends with a machine-readable line starting with [harny-subagent-report] (JSON: status, filesTouched, previews). TRUST these facts over the prose: needs-write → re-delegate with write access; error/aborted → the sub-task did NOT complete.
- If a report says a sub-agent ran READ-ONLY and prepared previews (or otherwise needs write access), RE-DELEGATE that sub-task with access "write" and the same resources.`
      : "";

    return `You are Harny, an expert AI coding agent embedded in VS Code.
Working directory: ${cwd}
Platform: ${isWindows ? "Windows" : process.platform === "darwin" ? "macOS" : "Linux"}. The Shell tool runs commands with the native shell (${isWindows ? "cmd.exe/PowerShell" : defaultShell()}); use THIS OS's commands and syntax (e.g. ${isWindows ? "dir/type/where instead of ls/cat/which; \" and drive letters in paths" : "ls/cat/which; / in paths"}).${orchestratorIntro}

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
- If the conversation contains changes marked PROPOSED / preview (prepared in Analyze mode), they were NOT applied to disk: re-issue those exact edits with the file tools now to actually apply them.
- Edit: surgical, atomic multi-edits. Each edit's oldText must match a UNIQUE region exactly (trailing-space/Unicode tolerated). The result shows the applied diff — always re-check it. StrReplace is the strict single-edit variant.
- Use Shell for running commands (tests, builds, git operations).
- Use Grep/Glob to search and explore the codebase.
- Use TodoWrite to track progress on complex multi-step tasks.
- Use ReadLints only on files you've edited or are about to edit.
- When broadly exploring the codebase, prefer Grep and Glob over Shell find/grep.
- Never repeat the same tool call with identical arguments: if it failed or returned nothing, change approach (Glob/Grep/Read or different arguments) instead of retrying it.${delegateRules}${analyzeRules}${skillsSection}`;
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
    /** Installed Agent Skills (catalog only): a sub-agent gets the SAME catalog as the
     * orchestrator, so it can activate a skill on its own (progressive disclosure).
     * Absent/empty = no `## Skills` section, exactly like the orchestrator without skills. */
    private skills: () => readonly SkillMeta[] = () => [],
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
      ? `\n- You are READ-ONLY: the file-modifying tools run as PREVIEWS (they validate the change and return a diff but NEVER write), and Shell is read-only: no writes, redirects, installs or builds.`
      : "";
    const budgetRule = this.options.turnBudget
      ? `\n- BUDGET: you have about ${this.options.turnBudget} tool turns. Work efficiently, do not over-explore, and STOP calling tools to write your report well within the budget.`
      : "";
    // SAME progressive disclosure as the orchestrator (see DefaultSystemPromptBuilder):
    // only names + descriptions here; the Skill tool loads the full SKILL.md on demand.
    // `disable-model-invocation` skills are EXCLUDED (the orchestrator can still force
    // one with `/skill`, which inlines the body into the message it forwards).
    const installedSkills = this.skills().filter((s) => !s.disableModelInvocation);
    const skillsSection =
      installedSkills.length > 0
        ? `\n\n## Skills\nWhen the task matches one of these skills, ACTIVATE it first by calling the ${SKILL_TOOL_NAME} tool with its exact name, then follow the returned instructions:\n` +
          installedSkills.map((s) => `- ${s.name}: ${s.description}`).join("\n")
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
${toolList}${skillsSection}`;
  }

  private summarize(description: string): string {
    const first = description.split("\n")[0].trim();
    return first.length > 120 ? first.slice(0, 120) + "..." : first;
  }
}