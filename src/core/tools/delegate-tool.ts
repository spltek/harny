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
  /** Read-only for Analyze (its sub-agents are read-only there, and each of THEIR calls is
  // gated again) but NOT cacheable: a nested run is expensive and non-deterministic. */
  readonly analyzePolicy = "read-only" as const;
  readonly definition: ToolDefinition = {
    name: "Delegate",
    description:
      "Launch a sub-agent to work on ONE sub-task and return its report. " +
      "PARALLELISM MEANS SUB-TASKS: work runs in parallel ONLY as multiple Delegate calls — your own tool calls " +
      "in one turn run one after another, that is NOT parallelism. So to go parallel you MUST call Delegate. " +
      "Split the request into parts: a part that needs another part's result (DEPENDENCY) is not parallel — order it " +
      "with after. Two parts conflict ONLY if they share a file/dir AND at least one WRITES it; two readers, or two " +
      "different files, never conflict (and in Analyze nothing is written, so there is no resource conflict). " +
      "When 2+ parts have no dependency and no conflict, you MUST emit ONE Delegate per part, all in the SAME turn. " +
      "The sub-agent runs its own agent loop with the full tool set on the SAME working directory.\n\n" +
      "DECLARE EXACTLY what the sub-agent will touch so the system can parallelize safely:\n" +
      "- resources: the files/dirs it will read or write (paths relative to the working directory).\n" +
      "- access: \"read\" (inspect only), \"write\" (modify existing files) or \"create\" (new files).\n" +
      "- parallel: IGNORED. Read-only sub-agents ALWAYS run in parallel with the others from the SAME turn; " +
      "WRITE/CREATE sub-agents on DIFFERENT files also run in parallel. Two writers that touch the SAME file " +
      "(or overlapping dirs) are serialized automatically (use `after` to order them).\n" +
      "- after: ids of sibling sub-tasks that must finish first (use it when a sub-agent needs another's output).\n\n" +
      "RULES:\n" +
      "- FIRST, CLASSIFY the work: PARALLELIZABLE (N ≥ 2 independent items — the SAME operation over different " +
      "targets) → ONE Delegate per item in the SAME turn; NOT parallelizable (a single small or sequential task) " +
      "→ do it with your own tools.\n" +
      "- Reason about RESOURCES, not only exact file paths: a writer conflicts with another writer on the same " +
      "file/dir, with DELETING/MOVING a parent folder, and with a concurrent reader of the same file. Shared " +
      "config/manifests/lockfiles/generated code and the same module/feature are conflicts too. If unsure, ORDER " +
      "the tasks (use after) — do not parallelize uncertain conflicts.\n" +
      "- Declare resources (files AND/OR directories) and access honestly: resources are a COORDINATION " +
      "contract, NOT a sandbox — they let the host serialize overlapping writers, but they do NOT restrict what " +
      "a sub-agent may touch. YOU own a correct conflict-free plan.\n" +
      "- Emit ALL independent Delegate calls in the SAME turn so they run in parallel (up to the configured max); " +
      "use after for dependencies. WRITE/CREATE sub-agents on DIFFERENT files run in parallel too.\n" +
      "- You may also do a single, small or sequential task yourself; but when the work IS parallelizable, " +
      "delegating the independent parts is expected.",
    parameters: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description:
            'SHORT but MEANINGFUL id naming this sub-task, e.g. "login-ui", "api-tests", "docs" ' +
            '(NEVER "A", "1", "task1"): it labels the sub-agent bubble and is used for after-dependencies.',
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
          description:
            "Files/dirs the sub-agent will touch (relative paths). REQUIRED for access \"write\"/\"create\"; " +
            "may be empty for read-only tasks that do not touch the filesystem (e.g. web research).",
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
      required: ["goal", "access"],
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
