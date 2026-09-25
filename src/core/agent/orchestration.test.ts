import { describe, expect, it } from "vitest";
import {
  buildSubAgentTask,
  formatSubAgentError,
  formatSubAgentInterrupted,
  formatSubAgentReport,
  haveWriteConflict,
  isParallelizable,
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

  it("requires goal, a valid access and a non-empty resources list", () => {
    expect(parseDelegateSpec({ access: "read", resources: ["a"] }).error).toContain("goal");
    expect(parseDelegateSpec({ goal: "x", access: "write", resources: [] }).error).toContain("resources");
    expect(parseDelegateSpec({ goal: "x", access: "nope", resources: ["a"] }).error).toContain("access");
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
  it("only read sub-tasks with no dependency are parallelizable (flag ignored)", () => {
    expect(isParallelizable(spec({ access: "read", parallel: true }))).toBe(true);
    // The `parallel` flag is advisory and IGNORED: a stray "no" cannot serialize reads.
    expect(isParallelizable({ ...spec({ access: "read" }), parallel: undefined })).toBe(true);
    expect(isParallelizable(spec({ access: "read", parallel: false }))).toBe(true);
    expect(isParallelizable(spec({ access: "write", parallel: true }))).toBe(false);
    expect(isParallelizable(spec({ access: "create", parallel: true }))).toBe(false);
    expect(isParallelizable(spec({ access: "read", parallel: true, after: ["B"] }))).toBe(false);
  });

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
  const seq = (id: string, access: DelegateSpec["access"] = "read"): PlannedCall => ({
    isDelegate: true,
    spec: spec({ id, access, parallel: access === "read" }),
  });

  it("groups consecutive parallel read-delegates into one batch", () => {
    expect(planToolExecution([par("A"), par("B"), par("C")])).toEqual([{ kind: "parallel", indices: [0, 1, 2] }]);
  });

  it("keeps writers serial (never parallel)", () => {
    expect(planToolExecution([seq("A", "write"), seq("B", "write")])).toEqual([
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
    expect(formatSubAgentInterrupted(s)).toBe('⏹ Sub-agent "A" interrupted.');
  });
});
