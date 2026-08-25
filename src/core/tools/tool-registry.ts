import type { Tool, ToolDefinition } from "./tool";

/**
 * Registry of tools available to the agent. Adding a tool means registering it
 * here — the agent and the LLM providers never change (Open/Closed principle).
 */
export class ToolRegistry {
  private byName: Map<string, Tool>;

  constructor(private tools: Tool[]) {
    const names = new Set<string>();
    for (const t of tools) {
      if (names.has(t.name)) {
        throw new Error(`Duplicate tool name: ${t.name}`);
      }
      names.add(t.name);
    }
    this.byName = new Map(tools.map((t) => [t.name, t]));
  }

  getAll(): Tool[] {
    return [...this.tools];
  }

  get(name: string): Tool | undefined {
    return this.byName.get(name);
  }

  definitions(): ToolDefinition[] {
    return this.tools.map((t) => t.definition);
  }
}
