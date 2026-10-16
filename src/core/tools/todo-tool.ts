import type { Tool, ToolContext, ToolDefinition, ToolResult } from "./tool";

interface TodoItem {
  id: string;
  content: string;
  status: string;
}

/** Cap on the per-owner lists kept (LRU): each session AND each sub-agent run
 * owns one, so without a bound the shared tool instance would leak state for
 * the whole extension lifetime. */
const MAX_OWNER_STATES = 200;

export class TodoTool implements Tool {
  readonly name = "TodoWrite";
  /** Read-only for Analyze (it changes nothing on disk) but NOT cacheable: it mutates
  // this conversation's todo list. */
  readonly analyzePolicy = "read-only" as const;
  readonly definition: ToolDefinition = {
    name: "TodoWrite",
    description: "Use this tool to create and manage a structured task list for your current coding session.",
    parameters: {
      type: "object",
      properties: {
        todos: {
          type: "array",
          minItems: 2,
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "Unique identifier for the TODO item" },
              content: { type: "string", description: "The description/content of the TODO item" },
              status: { type: "string", enum: ["pending", "in_progress", "completed", "cancelled"] },
            },
            required: ["id", "content", "status"],
          },
        },
        merge: {
          type: "boolean",
          description:
            "Whether to merge the todos with the existing todos based on the id field. If false, the new todos replace the existing todos.",
        },
      },
      required: ["todos", "merge"],
    },
  };

  /** Per-conversation todo list. Keyed by the caller's ownerId so the
   * orchestrator, each session and each concurrent sub-agent keep SEPARATE
   * lists (the tool instance is shared across all of them). */
  private readonly states = new Map<string, TodoItem[]>();

  private stateFor(ctx?: ToolContext): TodoItem[] {
    const key = ctx?.ownerId ?? "default";
    const existing = this.states.get(key);
    if (existing) {
      // LRU touch: re-insert so this owner becomes the most recently used.
      this.states.delete(key);
      this.states.set(key, existing);
      return existing;
    }
    const created: TodoItem[] = [];
    this.states.set(key, created);
    if (this.states.size > MAX_OWNER_STATES) {
      const oldest = this.states.keys().next().value;
      if (oldest !== undefined) this.states.delete(oldest);
    }
    return created;
  }

  execute(args: Record<string, unknown>, ctx?: ToolContext): ToolResult {
    let state = this.stateFor(ctx);
    const todos = args.todos as TodoItem[] | undefined;
    const merge = args.merge as boolean | undefined;
    if (!Array.isArray(todos)) {
      return {
        content:
          "Tool TodoWrite requires the argument \"todos\": an array of {id, content, status} objects\n" +
          'with status one of "pending" | "in_progress" | "completed" | "cancelled", and a "merge" boolean.\n' +
          'Call again with: {"todos": [{"id": "1", "content": "...", "status": "pending"}], "merge": false}',
        isError: true,
      };
    }

    if (merge && state.length > 0) {
      const map = new Map(state.map((t) => [t.id, { ...t }]));
      for (const t of todos) {
        const existing = map.get(t.id);
        if (existing) {
          if (t.content !== undefined) existing.content = t.content;
          if (t.status !== undefined) existing.status = t.status;
        } else {
          map.set(t.id, { ...t });
        }
      }
      state = Array.from(map.values());
    } else {
      state = todos.map((t) => ({ id: t.id, content: t.content, status: t.status }));
    }
    this.states.set(ctx?.ownerId ?? "default", state);
    // Keep the just-written owner at the MRU position after the reassignment.
    const key = ctx?.ownerId ?? "default";
    this.states.delete(key);
    this.states.set(key, state);

    const lines = state.map((t) => {
      const icon =
        t.status === "completed" ? "✅" : t.status === "in_progress" ? "🔄" : t.status === "cancelled" ? "❌" : "⏳";
      return `${icon} [${t.status}] ${t.content}`;
    });

    return { content: `## Task List\n\n${lines.join("\n")}`, isError: false };
  }
}
