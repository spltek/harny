import { describe, expect, it } from "vitest";
import { TODO_TOOL_NAME, TodoTool } from "./todo-tool";

const tool = new TodoTool();

/** The `todos` array schema, as a loose JSON Schema (see ToolDefinition). */
function todosSchema(): { minItems?: number; items?: { required?: string[] } } {
  const properties = tool.definition.parameters.properties as Record<string, unknown>;
  return properties.todos as { minItems?: number; items?: { required?: string[] } };
}

describe("TodoTool", () => {
  it("keeps the tool name in sync with the constant the system prompt gates on", () => {
    expect(tool.name).toBe(TODO_TOOL_NAME);
    expect(tool.definition.name).toBe(TODO_TOOL_NAME);
  });

  it("accepts a ONE-item merge — the canonical status update", () => {
    // Regression: minItems was 2, so the call the model actually makes ("this
    // task is done now" with merge:true) was schema-invalid and the update was
    // lost, leaving the list stale for the rest of the session.
    expect(todosSchema().minItems).toBe(1);
  });

  it("keeps the tool list summary short enough not to be truncated", () => {
    // Only the first line reaches the model (DefaultSystemPromptBuilder.summarize,
    // 120 chars), so the trigger must fit there or it never gets read.
    const firstLine = tool.definition.description.split("\n")[0];
    expect(firstLine.length).toBeLessThanOrEqual(120);
    expect(firstLine).toMatch(/distinct goals/);
  });

  it("updates a single status with merge:true and keeps the other items", () => {
    tool.execute(
      {
        todos: [
          { id: "explore", content: "Explore the repo", status: "pending" },
          { id: "api", content: "Write the API", status: "in_progress" },
        ],
        merge: false,
      },
      { ownerId: "merge-test" },
    );

    const result = tool.execute(
      { todos: [{ id: "api", content: "Write the API", status: "completed" }], merge: true },
      { ownerId: "merge-test" },
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("✅ [completed] Write the API");
    expect(result.content).toContain("⏳ [pending] Explore the repo");
  });

  it("keeps a separate list per owner", () => {
    tool.execute(
      { todos: [{ id: "a", content: "Owner A task", status: "pending" }], merge: false },
      { ownerId: "owner-a" },
    );
    const other = tool.execute(
      { todos: [{ id: "b", content: "Owner B task", status: "pending" }], merge: false },
      { ownerId: "owner-b" },
    );

    expect(other.content).toContain("Owner B task");
    expect(other.content).not.toContain("Owner A task");
  });

  it("fails with a usable example when `todos` is missing", () => {
    const result = tool.execute({}, { ownerId: "bad-call" });

    expect(result.isError).toBe(true);
    expect(result.content).toContain('"merge": false');
  });
});
