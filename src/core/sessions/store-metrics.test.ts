import { describe, it, expect } from "vitest";
import { noteDbOp, dbMetrics, resetDbMetrics } from "./store-metrics";

/**
 * The store is SYNCHRONOUS on the single extension-host thread: these numbers are
 * what tells whether it is the wall when several sessions run at once.
 */
describe("store metrics", () => {
  it("aggregates count, avg, p95 and max per operation", () => {
    resetDbMetrics();
    for (let i = 1; i <= 100; i++) noteDbOp("saveMessages", i);

    const m = dbMetrics().find((x) => x.op === "saveMessages")!;
    expect(m.count).toBe(100);
    expect(m.maxMs).toBe(100);
    expect(m.avgMs).toBeCloseTo(50.5, 1);
    // idx = floor(0.95 * 100) = 95 → the 96th smallest sample.
    expect(m.p95Ms).toBe(96);
  });

  it("keeps count/max cumulative but the tail on the RECENT window", () => {
    resetDbMetrics();
    noteDbOp("x", 500); // one old slow write…
    for (let i = 0; i < 200; i++) noteDbOp("x", 1); // …then a fast run

    const m = dbMetrics().find((x) => x.op === "x")!;
    expect(m.count).toBe(201);
    expect(m.maxMs).toBe(500); // the worst write of the window is still visible
    expect(m.p95Ms).toBe(1); // but the tail only looks at the ring
  });

  it("tracks operations independently and resets on demand", () => {
    resetDbMetrics();
    noteDbOp("saveMessages", 4);
    noteDbOp("saveSettings", 1);

    const byOp = Object.fromEntries(dbMetrics().map((m) => [m.op, m.count]));
    expect(byOp).toEqual({ saveMessages: 1, saveSettings: 1 });

    resetDbMetrics();
    expect(dbMetrics()).toEqual([]);
  });
});
