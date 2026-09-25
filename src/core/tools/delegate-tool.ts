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
      "Launch a sub-agent to work on ONE independent sub-task and return its report. " +
      "You are the ORCHESTRATOR: prefer delegating independent sub-tasks to SUB-AGENTS over doing everything yourself. " +
      "The sub-agent runs its own agent loop with the full tool set on the SAME working directory.\n\n" +
      "DECLARE EXACTLY what the sub-agent will touch so the system can parallelize safely:\n" +
      "- resources: the files/dirs it will read or write (paths relative to the working directory).\n" +
      "- access: \"read\" (inspect only), \"write\" (modify existing files) or \"create\" (new files).\n" +
      "- parallel: read-only sub-agents launched in the SAME turn run TOGETHER BY DEFAULT. " +
      "Set \"no\" to force one to run alone (serial). WRITERS ARE NEVER PARALLEL: any write/create " +
      "sub-agent runs alone, one at a time (edits are never concurrent).\n" +
      "- after: ids of sibling sub-tasks that must finish first (use it when a sub-agent needs another's output).\n\n" +
      "RULES:\n" +
      "- MANDATORY FIRST STEP (every request): assess parallelizability before acting. Split the task and decide " +
      "which parts are INDEPENDENT. Read-only + disjoint resources → parallel; anything that writes or shares a " +
      "file → serial (one owner). If nothing is parallelizable, do it yourself — do not force parallelism.\n" +
      "- Parallelize ONLY independent read-only analysis on disjoint or shared-read files.\n" +
      "- Never launch two writers that touch the same file; serialize them (after) or give the file to ONE owner.\n" +
      "- Do NOT parallelize trivial tasks or tasks that would do the same work — parallelism costs tokens.\n" +
      "- Emit several Delegate calls in the SAME turn: read-only sub-agents then run in parallel (up to " +
      "the configured max); results arrive together.",
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
            'Read-only sub-agents run in parallel with the others from the same turn BY DEFAULT; set "no" to force this one serial.',
        },
        after: {
          type: "array",
          items: { type: "string" },
          description: "Ids of sibling sub-tasks that must complete first.",
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
