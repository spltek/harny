import type { Tool, ToolDefinition, ToolResult } from "./tool";

/**
 * The Delegate tool: the orchestrator's way to launch a sub-agent for an
 * INDEPENDENT sub-task and get its report back.
 *
 * Only the DEFINITION lives here — the execution is intercepted by the Agent
 * (see agent.ts), which owns the session's sub-agent runner, the parallel
 * planning and the abort cascade. A direct execute() therefore refuses: a
 * sub-agent must never be able to re-delegate (depth is capped at 1).
 */
export class DelegateTool implements Tool {
  readonly name = "Delegate";
  readonly definition: ToolDefinition = {
    name: "Delegate",
    description:
      "Launch a sub-agent to work on ONE sub-task and return its report. " +
      "You are the ORCHESTRATOR: with Parallel ON your ONLY job is orchestration — you NEVER do the work yourself. " +
      "EVERY request MUST run as sub-agent(s), even a single, whole or trivial task (delegate it to ONE sub-agent). " +
      "The sub-agent runs its own agent loop with the full tool set on the SAME working directory.\n\n" +
      "DECLARE EXACTLY what the sub-agent will touch so the system can parallelize safely:\n" +
      "- resources: the files/dirs it will read or write (paths relative to the working directory).\n" +
      "- access: \"read\" (inspect only), \"write\" (modify existing files) or \"create\" (new files).\n" +
      "- parallel: IGNORED. Read-only sub-agents ALWAYS run in parallel with the others from the SAME turn; " +
      "WRITE/CREATE sub-agents on DIFFERENT files also run in parallel. Two writers that touch the SAME file " +
      "(or overlapping dirs) are serialized automatically (use `after` to order them).\n" +
      "- after: ids of sibling sub-tasks that must finish first (use it when a sub-agent needs another's output).\n\n" +
      "RULES:\n" +
      "- You are the ORCHESTRATOR: YOU organize the sub-tasks and decide what runs in parallel. MANDATORY FIRST STEP " +
      "(every request): decompose the task and analyze conflicts BEFORE acting.\n" +
      "- Reason about RESOURCES, not only exact file paths: a writer conflicts with another writer on the same " +
      "file/dir, with DELETING/MOVING a parent folder, and with a concurrent reader of the same file. Shared " +
      "config/manifests/lockfiles/generated code and the same module/feature are conflicts too. If unsure, ORDER " +
      "the tasks (use after) — do not parallelize uncertain conflicts.\n" +
      "- Declare resources (files AND/OR directories) and access honestly: the host serializes overlapping " +
      "writers and refuses undeclared delegates, but YOU own a correct conflict-free plan.\n" +
      "- Emit ALL independent Delegate calls in the SAME turn so they run in parallel (up to the configured max); " +
      "use after for dependencies. Do not flood: group tiny steps. WRITE/CREATE sub-agents on DIFFERENT files " +
      "run in parallel too.\n" +
      "- MANDATORY: delegate on EVERY request (never 0). Even if the task is monolithic, single or trivial, delegate " +
      "it WHOLE to ONE sub-agent — do NOT answer or work yourself.",
    parameters: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: 'Short unique id for this sub-task (e.g. "A"), used for after-dependencies and reporting.',
        },
        goal: {
          type: "string",
          description: "The precise objective the sub-agent must complete (not a vague topic).",
        },
        context: {
          type: "string",
          description: "Optional context/snippets from the conversation the sub-agent needs.",
        },
        role: {
          type: "string",
          description: 'Optional role/approach, e.g. "analyst", "implementer", "reviewer".',
        },
        access: {
          type: "string",
          enum: ["read", "write", "create"],
          description: "How the sub-agent may use the resources: read, write or create.",
        },
        resources: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          description: "Files/dirs the sub-agent will touch (relative paths). Required.",
        },
        parallel: {
          type: "string",
          enum: ["yes", "no"],
          description:
            'Advisory only — read-only sub-agents always run in parallel with the others from the same turn; use `after` to order them.',
        },
        after: {
          type: "array",
          items: { type: "string" },
          description: "Ids of sibling sub-tasks that must complete first.",
        },
        attachments: {
          type: "array",
          items: { type: "number" },
          description:
            'Numbers of the user attachments (the numbered [User attachments] list) this sub-task needs, ' +
            'e.g. [1] or [2]. Give each sub-task ONLY the attachments it needs. Omit to forward ALL of them.',
        },
      },
      required: ["goal", "access", "resources"],
    },
  };

  execute(): ToolResult {
    return {
      content:
        "The Delegate tool is executed by the orchestrator (agent loop), not directly. " +
        "Sub-agents cannot delegate further.",
      isError: true,
    };
  }
}
