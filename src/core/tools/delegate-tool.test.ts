import { describe, expect, it } from "vitest";
import { DelegateTool } from "./delegate-tool";

describe("DelegateTool", () => {
  it("declares the schema that drives safe delegation", () => {
    const d = new DelegateTool().definition;
    expect(d.name).toBe("Delegate");
    // goal + access + resources are mandatory (the host validates them).
    expect(d.parameters.required).toEqual(["goal", "access", "resources"]);
    const props = d.parameters.properties as Record<string, { type?: string; enum?: string[]; minItems?: number }>;
    expect(props.access.enum).toEqual(["read", "write", "create"]);
    expect(props.parallel.enum).toEqual(["yes", "no"]);
    expect(props.resources.type).toBe("array");
    expect(props.resources.minItems).toBe(1);
    expect(props.after?.type).toBe("array");
    expect(props.goal?.type).toBe("string");
    expect(props.role?.type).toBe("string");
    expect(props.context?.type).toBe("string");
    expect(props.id?.type).toBe("string");
    // The description steers the orchestrator on parallelism and edits.
    expect(d.description).toContain("WRITERS ARE NEVER PARALLEL");
    expect(d.description).toContain("MANDATORY FIRST STEP");
    expect(d.description).toContain("resources");
  });

  it("refuses direct execution (only the agent loop runs it)", () => {
    const res = new DelegateTool().execute();
    expect(res.isError).toBe(true);
    expect(res.content).toContain("orchestrator");
  });
});
