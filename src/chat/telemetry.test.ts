import { describe, it, expect, vi, beforeEach } from "vitest";

// The probe contract the fake has to satisfy (type only: nothing is loaded at runtime).
import type { LagProbe } from "./telemetry";

// `telemetry.ts` reports through the logger, which imports vscode at load time.
vi.mock("vscode", () => ({
  window: { createOutputChannel: () => ({ appendLine: () => {} }) },
}));
// The report is the only observable effect of a window: nothing to spy on otherwise.
vi.mock("../logger", () => ({ debugLog: vi.fn() }));

const { Telemetry, NativeLagProbe, RESOLUTION_MS } = await import("./telemetry");
const { debugLog } = await import("../logger");

/** A probe the test OWNS: a native histogram cannot be advanced by a fake clock, so the seam is
 *  the probe itself. What is asserted here is the class's contract (when it samples, what it
 *  prints, what it resets) — the real histogram has its own test below. */
class FakeProbe implements LagProbe {
  started = 0;
  stopped = 0;
  resets = 0;
  value = { avgMs: 0, p95Ms: 0, maxMs: 0 };
  start(): void {
    this.started++;
  }
  stop(): void {
    this.stopped++;
  }
  read(): { avgMs: number; p95Ms: number; maxMs: number } {
    return this.value;
  }
  reset(): void {
    this.resets++;
    this.value = { avgMs: 0, p95Ms: 0, maxMs: 0 };
  }
}

describe("Telemetry", () => {
  beforeEach(() => {
    vi.mocked(debugLog).mockClear();
  });

  it("starts empty (nothing measured, nothing posted)", () => {
    expect(new Telemetry().snapshot()).toEqual({
      loopAvgMs: 0,
      loopP95Ms: 0,
      loopMaxMs: 0,
      posts: 0,
      postBytes: 0,
    });
  });

  it("counts the messages posted to the webview and their approximate size", () => {
    const t = new Telemetry();
    t.notePost({ type: "textDelta", content: "x".repeat(100) });
    t.notePost({ type: "done" }); // no content: a flat overhead

    const s = t.snapshot();
    expect(s.posts).toBe(2);
    expect(s.postBytes).toBeGreaterThan(100);
    expect(s.postBytes).toBeLessThan(1000);
  });

  it("samples the event loop only between start() and stop(), never twice", () => {
    const probe = new FakeProbe();
    const t = new Telemetry({ probe });
    t.start();
    t.start(); // idempotent: no double timers, no double probe
    expect(probe.started).toBe(1);
    expect(probe.stopped).toBe(0);

    t.stop();
    expect(probe.stopped).toBe(1);
    t.stop(); // idempotent
    // A stopped probe reads nothing: the numbers are gone with it, not frozen at the last value.
    expect(t.snapshot().loopMaxMs).toBe(0);
  });

  it("reports the probe's numbers, rounded, without resetting them", () => {
    const probe = new FakeProbe();
    probe.value = { avgMs: 12.34, p95Ms: 40.05, maxMs: 88.88 };
    const t = new Telemetry({ probe });

    expect(t.snapshot()).toMatchObject({ loopAvgMs: 12.3, loopP95Ms: 40.1, loopMaxMs: 88.9 });
    // Reading is not the end of a window: the same numbers come back, and the probe was not reset.
    expect(t.snapshot().loopAvgMs).toBe(12.3);
    expect(probe.resets).toBe(0);
  });

  it("prints ONE line when the host was busy, and starts the next window from zero", () => {
    const probe = new FakeProbe();
    probe.value = { avgMs: 3, p95Ms: 30, maxMs: 90 };
    const t = new Telemetry({ probe });
    t.notePost({ type: "textDelta", content: "hello" });

    t.report();

    expect(debugLog).toHaveBeenCalledTimes(1);
    const [tag, line] = vi.mocked(debugLog).mock.calls[0];
    expect(tag).toBe("[telemetry]");
    expect(JSON.parse(String(line))).toMatchObject({ loopAvgMs: 3, loopP95Ms: 30, loopMaxMs: 90, posts: 1 });
    // The window closed: counters zeroed, histogram restarted.
    expect(t.snapshot()).toMatchObject({ posts: 0, postBytes: 0, loopMaxMs: 0 });
    expect(probe.resets).toBe(1);
  });

  it("prints nothing on an idle host — the line exists to catch saturation", () => {
    const probe = new FakeProbe();
    probe.value = { avgMs: 0.4, p95Ms: 1, maxMs: 2 };
    const t = new Telemetry({ probe });

    t.report();
    t.report();

    expect(debugLog).not.toHaveBeenCalled();
    expect(probe.resets).toBe(2); // …but the window still turns over
  });

  it("a single long stall is enough to report, even with no traffic at all", () => {
    const probe = new FakeProbe();
    probe.value = { avgMs: 8, p95Ms: 40, maxMs: 40 }; // >= BUSY_LAG_MS, no posts
    new Telemetry({ probe }).report();

    expect(debugLog).toHaveBeenCalledTimes(1);
  });

  it("the real probe sees a BLOCKED loop, and reset() takes it back to zero", async () => {
    const probe = new NativeLagProbe();
    probe.start();
    // Block the thread the way SQLite and a big tool result do. The histogram is native and needs
    // a turn of the loop to record the late timer, hence the wait after the stall.
    const until = Date.now() + 4 * RESOLUTION_MS;
    while (Date.now() < until) {
      // busy: no timers, no promises, nothing that could yield
    }
    await new Promise((r) => setTimeout(r, RESOLUTION_MS * 2));
    const seen = probe.read();
    probe.stop();

    // 200 ms of block, 50 ms of resolution: the delay recorded is at least one resolution step.
    expect(seen.maxMs).toBeGreaterThanOrEqual(RESOLUTION_MS);
    expect(seen.maxMs).toBeLessThan(2_000); // …and it is a delay, not the wall clock

    // A reset starts a clean window: the stall is not carried into the next report.
    probe.start();
    probe.reset();
    expect(probe.read().maxMs).toBeLessThan(RESOLUTION_MS);
    probe.stop();
  });
});
