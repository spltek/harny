import type { Tool, ToolDefinition, ToolResult } from "./tool";

interface TodoItem {
  id: string;
  content: string;
  status: string;
}

export class TodoTool implements Tool {
  readonly name = "TodoWrite";
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

  private state: TodoItem[] = [];

  execute(args: Record<string, unknown>): ToolResult {
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

    if (merge && this.state.length > 0) {
      const map = new Map(this.state.map((t) => [t.id, { ...t }]));
      for (const t of todos) {
        const existing = map.get(t.id);
        if (existing) {
          if (t.content !== undefined) existing.content = t.content;
          if (t.status !== undefined) existing.status = t.status;
        } else {
          map.set(t.id, { ...t });
        }
      }
      this.state = Array.from(map.values());
    } else {
      this.state = todos.map((t) => ({ id: t.id, content: t.content, status: t.status }));
    }

    const lines = this.state.map((t) => {
      const icon =
        t.status === "completed" ? "✅" : t.status === "in_progress" ? "🔄" : t.status === "cancelled" ? "❌" : "⏳";
      return `${icon} [${t.status}] ${t.content}`;
    });

    return { content: `## Task List\n\n${lines.join("\n")}`, isError: false };
  }
}
