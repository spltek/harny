import { describe, expect, it } from "vitest";
import { DelegateTool } from "./delegate-tool";

describe("DelegateTool", () => {
  it("declares the schema that drives safe delegation", () => {
    const d = new DelegateTool().definition;
    expect(d.name).toBe("Delegate");
    // goal + access are mandatory; resources is required only for writers
    // (read-only non-file tasks may leave it empty), so it is not in `required`.
    expect(d.parameters.required).toEqual(["goal", "access"]);
    const props = d.parameters.properties as Record<string, { type?: string; enum?: string[]; minItems?: number }>;
    expect(props.access.enum).toEqual(["read", "write", "create"]);
    expect(props.parallel.enum).toEqual(["yes", "no"]);
    expect(props.resources.type).toBe("array");
    expect(props.resources.minItems).toBeUndefined(); // empty allowed for read-only
    expect(props.after?.type).toBe("array");
    expect(props.goal?.type).toBe("string");
    expect(props.role?.type).toBe("string");
    expect(props.context?.type).toBe("string");
    expect(props.id?.type).toBe("string");
    // The description steers the orchestrator on parallelism and edits.
    expect(d.description).toContain("WRITE/CREATE sub-agents on DIFFERENT files");
    expect(d.description).toContain("FIRST STEP");
    expect(d.description).toContain("resources");
    // With Parallel ON, orchestration is the job: every tool-needing request is
    // delegated (never work yourself), but a pure question is answered directly.
    expect(d.description).toContain("your job is orchestration");
    expect(d.description).toContain("Delegate every request that needs tools");
    expect(d.description).toContain("a PURE question/explanation you answer directly");
  });

  it("refuses direct execution (only the agent loop runs it)", () => {
    const res = new DelegateTool().execute();
    expect(res.isError).toBe(true);
    expect(res.content).toContain("orchestrator");
  });
});
