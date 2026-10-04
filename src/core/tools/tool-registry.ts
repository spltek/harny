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

  /** Register extra tools at runtime (e.g. MCP tools after connecting). */
  add(tools: readonly Tool[]): void {
    for (const t of tools) {
      if (this.byName.has(t.name)) continue; // idempotent
      this.tools.push(t);
      this.byName.set(t.name, t);
    }
  }

  /** Remove every tool whose name starts with `prefix` (reconnect cleanup). */
  removeByPrefix(prefix: string): void {
    this.tools = this.tools.filter((t) => !t.name.startsWith(prefix));
    this.byName = new Map(this.tools.map((t) => [t.name, t]));
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
