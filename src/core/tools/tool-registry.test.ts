import { describe, it, expect } from "vitest";
import { ToolRegistry } from "./tool-registry";
import type { Tool, ToolResult } from "./tool";

function makeTool(name: string, isError = false): Tool {
  return {
    name,
    definition: { name, description: `${name} desc`, parameters: { type: "object", properties: {} } },
    execute: (): ToolResult => ({ content: `${name} ran`, isError }),
  };
}

describe("ToolRegistry", () => {
  it("returns tools by name", () => {
    const registry = new ToolRegistry([makeTool("Read"), makeTool("Write")]);

    expect(registry.get("Read")?.name).toBe("Read");
    expect(registry.get("Write")?.name).toBe("Write");
    expect(registry.get("Missing")).toBeUndefined();
  });

  it("returns all tools and definitions", () => {
    const registry = new ToolRegistry([makeTool("Read"), makeTool("Write")]);

    expect(registry.getAll()).toHaveLength(2);
    expect(registry.definitions().map((d) => d.name)).toEqual(["Read", "Write"]);
  });

  it("rejects duplicate tool names", () => {
    expect(() => new ToolRegistry([makeTool("Read"), makeTool("Read")])).toThrow();
  });
});
