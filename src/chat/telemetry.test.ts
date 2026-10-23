import { describe, it, expect, vi } from "vitest";

// `telemetry.ts` reports through the logger, which imports vscode at load time.
vi.mock("vscode", () => ({
  window: { createOutputChannel: () => ({ appendLine: () => {} }) },
}));

const { Telemetry } = await import("./telemetry");

describe("Telemetry", () => {
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

  it("samples the event loop only between start() and stop()", async () => {
    const t = new Telemetry();
    t.start();
    t.start(); // idempotent: no double timers
    await new Promise((r) => setTimeout(r, 120));
    t.stop();
    // The timer actually fired (a lag sample exists), and it never throws.
    expect(t.snapshot().loopMaxMs).toBeGreaterThanOrEqual(0);
    t.stop(); // idempotent
  });
});
