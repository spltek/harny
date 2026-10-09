import { describe, expect, it } from "vitest";
import {
  buildSubAgentTask,
  formatSubAgentAborted,
  formatSubAgentError,
  formatSubAgentReport,
  haveWriteConflict,
  parseDelegateSpec,
  planToolExecution,
  resourcesOverlap,
  runWithConcurrency,
  type DelegateSpec,
  type PlannedCall,
} from "./orchestration";

function spec(partial: Partial<DelegateSpec>): DelegateSpec {
  return {
    id: "A",
    goal: "do it",
    access: "read",
    resources: ["src/a.ts"],
    parallel: false,
    after: [],
    ...partial,
  };
}

describe("parseDelegateSpec", () => {
  it("parses a valid spec and defaults the optional fields", () => {
    const { spec: s, error } = parseDelegateSpec({ goal: "analyze", access: "read", resources: ["src/a.ts"] });
    expect(error).toBeUndefined();
    expect(s).toMatchObject({ goal: "analyze", access: "read", resources: ["src/a.ts"], parallel: undefined, after: [] });
  });

  it("requires goal, a valid access and resources for writers", () => {
    expect(parseDelegateSpec({ access: "read", resources: ["a"] }).error).toContain("goal");
    expect(parseDelegateSpec({ goal: "x", access: "write", resources: [] }).error).toContain("resources");
    expect(parseDelegateSpec({ goal: "x", access: "create", resources: [] }).error).toContain("resources");
    expect(parseDelegateSpec({ goal: "x", access: "nope", resources: ["a"] }).error).toContain("access");
  });

  it("allows an EMPTY resources list for read-only tasks (e.g. web research)", () => {
    const { spec: s, error } = parseDelegateSpec({ goal: "search Milan", access: "read", resources: [] });
    expect(error).toBeUndefined();
    expect(s).toMatchObject({ goal: "search Milan", access: "read", resources: [] });
    // Missing resources entirely is also fine for a reader (defaults to []).
    expect(parseDelegateSpec({ goal: "x", access: "read" }).error).toBeUndefined();
  });

  it("accepts parallel:'yes' and after ids; ignores garbage", () => {
    const { spec: s } = parseDelegateSpec({
      goal: "x",
      access: "read",
      resources: ["a", 3, "  "],
      parallel: "yes",
      after: ["B", 7],
      role: " analyst ",
    });
    expect(s).toMatchObject({ resources: ["a"], parallel: true, after: ["B"], role: "analyst" });
  });
});

describe("parallelism policy", () => {
  it("detects resource overlap and write conflicts", () => {
    expect(resourcesOverlap(["src/a.ts"], ["src/a.ts"])).toBe(true);
    expect(resourcesOverlap(["src"], ["src/a.ts"])).toBe(true);
    expect(resourcesOverlap(["src/a.ts"], ["test/b.ts"])).toBe(false);
    // Two readers never conflict, even on the same file.
    expect(haveWriteConflict(spec({ access: "read" }), spec({ access: "read" }))).toBe(false);
    // A writer conflicts with any overlapping access.
    expect(haveWriteConflict(spec({ access: "write" }), spec({ access: "read" }))).toBe(true);
    expect(haveWriteConflict(spec({ access: "write" }), spec({ access: "read", resources: ["other.ts"] }))).toBe(false);
  });
});

describe("planToolExecution", () => {
  const nonDelegate: PlannedCall = { isDelegate: false };
  const par = (id: string, res = "a.ts"): PlannedCall => ({
    isDelegate: true,
    spec: spec({ id, parallel: true, resources: [res] }),
  });

  it("groups consecutive parallel read-delegates into one batch", () => {
    expect(planToolExecution([par("A"), par("B"), par("C")])).toEqual([{ kind: "parallel", indices: [0, 1, 2] }]);
  });

  it("runs WRITERS on DISJOINT files in parallel", () => {
    const w1: PlannedCall = { isDelegate: true, spec: spec({ id: "A", access: "write", resources: ["a.ts"] }) };
    const w2: PlannedCall = { isDelegate: true, spec: spec({ id: "B", access: "create", resources: ["b.ts"] }) };
    expect(planToolExecution([w1, w2])).toEqual([{ kind: "parallel", indices: [0, 1] }]);
  });

  it("serializes writers that SHARE a resource (never two writers on the same file)", () => {
    const w1: PlannedCall = { isDelegate: true, spec: spec({ id: "A", access: "write", resources: ["a.ts"] }) };
    const w2: PlannedCall = { isDelegate: true, spec: spec({ id: "B", access: "write", resources: ["a.ts"] }) };
    expect(planToolExecution([w1, w2])).toEqual([
      { kind: "single", index: 0 },
      { kind: "single", index: 1 },
    ]);
  });

  it("keeps a READER out of a batch that writes its file", () => {
    const w: PlannedCall = { isDelegate: true, spec: spec({ id: "A", access: "write", resources: ["a.ts"] }) };
    const r: PlannedCall = { isDelegate: true, spec: spec({ id: "B", access: "read", resources: ["a.ts"] }) };
    expect(planToolExecution([w, r])).toEqual([
      { kind: "single", index: 0 },
      { kind: "single", index: 1 },
    ]);
  });

  it("treats non-delegate tools as barriers between parallel batches", () => {
    expect(planToolExecution([par("A"), nonDelegate, par("B")])).toEqual([
      { kind: "single", index: 0 },
      { kind: "single", index: 1 },
      { kind: "single", index: 2 },
    ]);
  });

  it("serializes a delegate with a dependency (after) even if read+parallel", () => {
    const dependent: PlannedCall = { isDelegate: true, spec: spec({ parallel: true, after: ["A"] }) };
    expect(planToolExecution([par("A"), dependent])).toEqual([
      { kind: "single", index: 0 },
      { kind: "single", index: 1 },
    ]);
  });

  it("serializes an invalid delegate spec (no spec parsed)", () => {
    expect(planToolExecution([{ isDelegate: true }, par("B")])).toEqual([
      { kind: "single", index: 0 },
      { kind: "single", index: 1 },
    ]);
  });

  it("batches read-only delegates parsed with EMPTY resources (not barriers)", () => {
    // Regression: an empty-resources reader used to parse as INVALID, so every
    // one became a `single` barrier and the whole batch ran ONE at a time
    // (fewer agents in flight than the configured max).
    const calls: PlannedCall[] = ["milan", "bologna", "firenze"].map((id) => ({
      isDelegate: true,
      spec: parseDelegateSpec({ id, goal: `search ${id}`, access: "read", resources: [] }).spec,
    }));
    expect(planToolExecution(calls)).toEqual([{ kind: "parallel", indices: [0, 1, 2] }]);
  });
});

describe("runWithConcurrency", () => {
  it("never exceeds the limit and reuses a slot as soon as an item finishes", async () => {
    let running = 0;
    let max = 0;
    const order: string[] = [];
    await runWithConcurrency(["A", "B", "C"], 2, async (id) => {
      running++;
      max = Math.max(max, running);
      order.push("start:" + id);
      await new Promise((r) => setTimeout(r, id === "B" ? 30 : 3));
      running--;
      order.push("end:" + id);
    });
    expect(max).toBe(2);
    // A (fast) ends → C starts BEFORE B (slow) ends: sliding window.
    expect(order.indexOf("start:C")).toBeGreaterThan(order.indexOf("end:A"));
    expect(order.indexOf("start:C")).toBeLessThan(order.indexOf("end:B"));
  });

  it("limit 1 runs strictly sequentially; limit >= length runs all at once", async () => {
    let running = 0;
    let max = 0;
    const track = async () => {
      running++;
      max = Math.max(max, running);
      await new Promise((r) => setTimeout(r, 2));
      running--;
    };
    await runWithConcurrency([1, 2, 3], 1, track);
    expect(max).toBe(1);
    max = 0;
    await runWithConcurrency([1, 2, 3], 99, track);
    expect(max).toBe(3);
    await runWithConcurrency([], 5, track); // no-op, no throw
  });
});

describe("sub-agent messaging", () => {
  it("builds the task seed and wraps the report", () => {
    const s = spec({ id: "A", goal: "Fix the parser", context: "the parser is at p.ts", role: "implementer" });
    expect(buildSubAgentTask(s)).toContain('Task "A":');
    expect(buildSubAgentTask(s)).toContain("Fix the parser");
    expect(buildSubAgentTask(s)).toContain("Context provided by the calling agent:");
    expect(formatSubAgentReport(s, "done")).toBe('🔁 Sub-agent "A" [implementer] report:\ndone');
    expect(formatSubAgentError(s, "boom")).toBe('🔁 Sub-agent "A" failed: boom');
    // The aborted result must INFORM the orchestrator: the sub-task did NOT
    // finish, so it is not a report to trust/summarize as done. Sub-agents have
    // ONE terminal stop state ("aborted", whatever the stop came from).
    const aborted = formatSubAgentAborted(s);
    expect(aborted).toContain('⏹ Sub-agent "A" aborted');
    expect(aborted).not.toMatch(/interrupted/i);
    expect(aborted).toMatch(/did NOT finish/i);
    expect(aborted).toMatch(/remaining work/i);
  });
});

describe("resourcesOverlap — roots + cwd (parallel safety)", () => {
  it("treats `.`/`/`/empty (the working directory) as matching EVERYTHING", () => {
    expect(resourcesOverlap(["."], ["src/a.ts"])).toBe(true);
    expect(resourcesOverlap(["/"], ["src/a.ts"])).toBe(true);
    expect(resourcesOverlap(["src/a.ts"], [""])).toBe(true);
    expect(resourcesOverlap(["./"], ["deep/nested/file.ts"])).toBe(true);
  });

  it("resolves relative paths against the cwd so relative and absolute MATCH", () => {
    expect(resourcesOverlap(["src/a.ts"], ["/proj/src/a.ts"], "/proj")).toBe(true);
    expect(resourcesOverlap(["/proj/src"], ["/proj/src/a.ts"], "/proj")).toBe(true);
    // A different project is NOT a conflict.
    expect(resourcesOverlap(["src/a.ts"], ["/other/src/a.ts"], "/proj")).toBe(false);
    // Absolute vs absolute on the same file.
    expect(resourcesOverlap(["/proj/a.ts"], ["/proj/a.ts"], "/proj")).toBe(true);
  });

  it("a WRITER on the root conflicts with ANY other writer (never parallel)", () => {
    const root = spec({ id: "root", access: "write", resources: ["."] });
    const file = spec({ id: "file", access: "write", resources: ["src/a.ts"] });
    expect(haveWriteConflict(root, file)).toBe(true);
    // Two root writers too.
    const root2 = spec({ id: "root2", access: "create", resources: ["/"] });
    expect(haveWriteConflict(root, root2)).toBe(true);
  });
});

describe("planToolExecution — `after` is a real dependency", () => {
  const d = (id: string, after: string[] = []): PlannedCall => ({
    isDelegate: true,
    spec: spec({ id, after }),
  });

  it("runs a dependent AFTER its prerequisite even when emitted out of order", () => {
    // C depends on A, but the model emitted C FIRST. A must still run first.
    const steps = planToolExecution([d("C", ["A"]), d("A")]);
    const pos = (index: number): number =>
      steps.findIndex((s) => (s.kind === "single" ? s.index === index : s.indices.includes(index)));
    expect(pos(1)).toBeLessThan(pos(0)); // A (index 1) before C (index 0)
  });

  it("keeps in-order dependencies correct (A then B after A)", () => {
    const steps = planToolExecution([d("A"), d("B", ["A"])]);
    expect(steps).toEqual([
      { kind: "single", index: 0 },
      { kind: "single", index: 1 },
    ]);
  });

  it("does not hang on a cyclic dependency (both run, best-effort)", () => {
    const steps = planToolExecution([d("A", ["B"]), d("B", ["A"])]);
    // Both calls are placed (no infinite loop), whatever the grouping.
    const indices = steps.flatMap((s) => (s.kind === "single" ? [s.index] : s.indices)).sort();
    expect(indices).toEqual([0, 1]);
  });
});
