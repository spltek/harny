import { describe, it, expect } from "vitest";
import { matchAll, RegexTimeoutError } from "./regex-worker";

describe("regex worker (anti-ReDoS)", () => {
  it("returns per-item hits for a normal pattern", async () => {
    const res = await matchAll(
      "foo",
      "i",
      false,
      [
        { path: "a", text: "x\nFOO\n" },
        { path: "b", text: "nothing\n" },
      ],
      1000,
    );
    expect(res.error).toBeUndefined();
    expect(res.results?.[0]?.hit).toEqual([1]);
    expect(res.results?.[1]?.hit).toEqual([]);
  });

  it("supports multiline mode (returns the match index)", async () => {
    const res = await matchAll("foo\\nbar", "s", true, [{ path: "a", text: "x\nfoo\nbar\n" }], 1000);
    expect(res.results?.[0]?.at).toBe(2);
  });

  it("surfaces an invalid regex as an error (never throws)", async () => {
    const res = await matchAll("(", "", false, [{ path: "a", text: "x" }], 1000);
    expect(res.error).toBeTruthy();
  });

  it("does NOT hang on a catastrophic pattern (times out or errors)", async () => {
    const evil = "a".repeat(120) + "!";
    let outcome: "timeout" | "error" | "resolved";
    try {
      const res = await matchAll("(a+)+$", "", false, [{ path: "x", text: evil }], 400);
      outcome = res.error ? "error" : "resolved";
    } catch (e) {
      outcome = e instanceof RegexTimeoutError ? "timeout" : "resolved";
    }
    // Either the worker is killed (timeout) or the engine itself bails (error); NEVER a bogus
    // "resolved" result. No wall-clock bound on top: if the worker stopped answering, the 400 ms
    // timer rejects; if even that failed to fire, Vitest's own `testTimeout` fails the test. An
    // `elapsed < N` assertion adds no coverage, only flakiness under a loaded machine.
    expect(outcome === "timeout" || outcome === "error").toBe(true);
  });

  it("recovers after a timeout (worker is recreated)", async () => {
    // Previous test killed the worker; a normal call must still work.
    const res = await matchAll("bar", "", false, [{ path: "a", text: "foo\nbar\n" }], 1000);
    expect(res.results?.[0]?.hit).toEqual([1]);
  });
});
